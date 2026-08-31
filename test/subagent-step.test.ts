import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSubagentDelegationRequest } from "../node_modules/pi-subagents/src/slash/delegation-request.ts";
import { DelegatedPromptCancellationDrainTimeoutError, DelegatedPromptCancelledError, executeSubagentPromptStep, executeSubagentPromptStepOutcome } from "../subagent-step.ts";
import {
	PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT,
	getDelegatedLiveState,
} from "../subagent-runtime.ts";
import { DELEGATED_WIDGET_KEY } from "../subagent-widget.ts";

function withDelegationBridge(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-subagent-step-"));
	return run(root).finally(() => {
		rmSync(root, { recursive: true, force: true });
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPi() {
	const bus = new Map<string, Array<(data: unknown) => void>>();
	const customMessages: unknown[] = [];
	return {
		customMessages,
		events: {
			emit(channel: string, data: unknown) {
				for (const handler of bus.get(channel) ?? []) handler(data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				const handlers = bus.get(channel) ?? [];
				handlers.push(handler);
				bus.set(channel, handlers);
				return () => {
					const current = bus.get(channel) ?? [];
					bus.set(channel, current.filter((entry) => entry !== handler));
				};
			},
		},
		sendMessage(message: unknown) {
			customMessages.push(message);
		},
	} as any;
}

function emitStarted(pi: any, request: any): void {
	pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, {
		requestId: request.requestId,
		ownerRunId: request.ownerRunId,
		nodeId: request.nodeId,
	});
}

function emitCompleted(pi: any, request: any, text?: string, toolCalls = 0): void {
	pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
		requestId: request.requestId,
		ownerRunId: request.ownerRunId,
		nodeId: request.nodeId,
		status: "completed",
		agent: request.agent,
		...(request.model ? { model: request.model } : {}),
		...(text ? { result: { kind: "text", text } } : {}),
		usage: {
			input: 120,
			output: 34,
			cacheRead: 5,
			cacheWrite: 6,
			cost: 0.1234,
			turns: 3,
			toolCalls,
			durationMs: 1500,
		},
	});
}

function emitFailed(pi: any, request: any, error: string): void {
	pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
		requestId: request.requestId,
		ownerRunId: request.ownerRunId,
		nodeId: request.nodeId,
		status: "failed",
		error,
	});
}

function emitCancelled(pi: any, request: any): void {
	pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
		requestId: request.requestId,
		ownerRunId: request.ownerRunId,
		nodeId: request.nodeId,
		status: "cancelled",
		agent: request.agent,
	});
}

function withIdentity(request: any, payload: Record<string, unknown>): Record<string, unknown> {
	return {
		requestId: request.requestId,
		ownerRunId: request.ownerRunId,
		nodeId: request.nodeId,
		...payload,
	};
}

function createCtx(cwd: string) {
	const model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
	return {
		cwd,
		mode: "print",
		scopedModels: [],
		isProjectTrusted() {
			return true;
		},
		hasUI: false,
		model,
		modelRegistry: {
			find(provider: string, id: string) {
				if (provider === model.provider && id === model.id) return model;
				return undefined;
			},
			getAll() {
				return [model];
			},
			getAvailable() {
				return [model];
			},
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "token" };
				},
			isUsingOAuth() {
				return false;
			},
		},
		ui: {
			notify() {},
			onTerminalInput() {
				return () => {};
			},
			setStatus() {},
			setWorkingMessage() {},
			setWidget() {},
			theme: { fg(_t: string, text: string) { return text; }, bold(text: string) { return text; } },
		},
		sessionManager: {
			getLeafId() {
				return "leaf";
			},
			getBranch() {
				return [];
			},
		},
		isIdle() {
			return false;
		},
		async waitForIdle() {},
	} as any;
}

function createInteractiveCtx(cwd: string) {
	const ctx = createCtx(cwd);
	ctx.mode = "tui";
	ctx.hasUI = true;
	let terminalHandler: ((input: string) => { consume?: boolean; data?: string } | undefined) | undefined;
	ctx.ui.onTerminalInput = (handler: (input: string) => { consume?: boolean; data?: string } | undefined) => {
		terminalHandler = handler;
		return () => {
			if (terminalHandler === handler) terminalHandler = undefined;
		};
	};
	return {
		ctx,
		sendInput: (input: string) => terminalHandler?.(input),
	};
}

const prompt = {
	name: "simplify",
	description: "",
	content: "do work",
	models: ["anthropic/claude-sonnet-4-20250514"],
	restore: true,
	source: "project",
	filePath: "prompt.md",
	subagent: true,
} as any;

test("executeSubagentPromptStep returns delegated change info", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let delegatedRequest: any;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			delegatedRequest = request;
			emitStarted(pi, request);
			emitCompleted(pi, request, "Done.", 1);
		});

		const result = await executeSubagentPromptStep({
			pi,
			prompt,
			args: [],
			ctx,
			currentModel: ctx.model,
		});
		assert.equal(result?.changed, true);
		assert.equal(delegatedRequest.model, "anthropic/claude-sonnet-4-20250514");
		assert.equal(pi.customMessages.length, 1);
		assert.deepEqual((pi.customMessages[0] as any).details.usage, {
			input: 120,
			output: 34,
			cacheRead: 5,
			cacheWrite: 6,
			cost: 0.1234,
			turns: 3,
			toolCalls: 1,
			durationMs: 1500,
		});
	});
});

test("executeSubagentPromptStep omits the session model for model-less delegated prompts", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let request: any;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			request = data;
			const parsed = parseSubagentDelegationRequest(request);
			assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.error);
			emitStarted(pi, request);
			emitCompleted(pi, request, "Resolved by agent.");
		});

		const result = await executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, models: [] },
			args: [],
			ctx,
			currentModel: ctx.model,
		});

		assert.equal(Object.hasOwn(request, "model"), false);
		assert.equal(result?.text, "Resolved by agent.");
	});
});

test("rejects model conditionals for model-less delegated prompts", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		const task = '<if-model is="openai/*">openai<else>other</if-model>';
		let request: any;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			request = data;
		});

		await assert.rejects(
			executeSubagentPromptStep({
				pi,
				prompt: { ...prompt, content: task, models: [] },
				args: [],
				ctx,
				currentModel: ctx.model,
			}),
			/uses <if-model> conditionals/,
		);

		assert.equal(request, undefined);
	});
});

test("executeSubagentPromptStep reaches the bridge without a session model", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let request: any;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			request = data;
			emitStarted(pi, request);
			emitCompleted(pi, request, "Resolved by configured agent model.");
		});

		const result = await executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, models: [] },
			args: [],
			ctx,
			currentModel: undefined,
		});

		assert.equal(result?.text, "Resolved by configured agent model.");
		assert.equal(Object.hasOwn(request, "model"), false);
	});
});

test("executeSubagentPromptStep preserves an explicit inherited model for model-less delegated prompts", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let request: any;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			request = data;
			emitStarted(pi, request);
			emitCompleted(pi, request, "Resolved by inherited model.");
		});

		await executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, models: [] },
			args: [],
			ctx,
			currentModel: ctx.model,
			inheritedModel: { provider: "openai", id: "gpt-inherited" } as any,
		});

		assert.equal(request.model, "openai/gpt-inherited");
	});
});

test("executeSubagentPromptStep uses the structured pi-subagents contract", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			assert.equal(request.ownerRunId, request.requestId);
			assert.equal(request.nodeId, "single");
			assert.deepEqual(request.result, { kind: "text" });
			emitStarted(pi, request);
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				requestId: request.requestId,
				status: "invalid_request",
				error: "spoofed response without structured identity",
			});
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				requestId: request.requestId,
				ownerRunId: request.ownerRunId,
				nodeId: request.nodeId,
				status: "completed",
				agent: request.agent,
				model: request.model,
				result: { kind: "text", text: "Done from structured delegation." },
			});
		});

		const result = await executeSubagentPromptStep({
			pi,
			prompt,
			args: [],
			ctx,
			currentModel: ctx.model,
		});

		assert.equal(result?.text, "Done from structured delegation.");
		assert.equal(result?.changed, false);
	});
});

test("pi-subagents 0.44 production parser accepts the emitted request", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const parsed = parseSubagentDelegationRequest(data);
			assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.error);
			if (!parsed.ok) return;
			const request = parsed.request;
			assert.equal(request.ownerRunId, request.requestId);
			assert.equal(request.nodeId, "single");
			assert.deepEqual(request.result, { kind: "text" });
			assert.equal("tasks" in request, false);
			assert.equal("worktree" in request, false);
			emitStarted(pi, request);
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				requestId: request.requestId,
				ownerRunId: request.ownerRunId,
				nodeId: request.nodeId,
				status: "completed",
				result: { kind: "text", text: "strict parser accepted" },
			});
		});

		const result = await executeSubagentPromptStep({ pi, prompt, args: [], ctx, currentModel: ctx.model });
		assert.equal(result?.text, "strict parser accepted");
	});
});

test("executeSubagentPromptStepOutcome preserves delegated success payload", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			emitStarted(pi, request);
			emitCompleted(pi, request, "Done.");
		});

		const outcome = await executeSubagentPromptStepOutcome({ pi, prompt, args: [], ctx, currentModel: ctx.model });
		assert.equal(outcome.status, "succeeded");
		assert.equal("result" in outcome ? outcome.result?.text : undefined, "Done.");
	});
});

test("executeSubagentPromptStepOutcome classifies delegated failures and budget preflight blocking", async () => {
	await withDelegationBridge(async (root) => {
		const ctx = createCtx(root);
		const failurePi = createPi();
		failurePi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			emitStarted(failurePi, request);
			emitFailed(failurePi, request, "boom");
		});
		assert.equal((await executeSubagentPromptStepOutcome({ pi: failurePi, prompt, args: [], ctx, currentModel: ctx.model })).status, "failed");

		const cancelledPi = createPi();
		const controller = new AbortController();
		controller.abort();
		assert.equal((await executeSubagentPromptStepOutcome({
			pi: cancelledPi, prompt, args: [], ctx, currentModel: ctx.model, signal: controller.signal,
		})).status, "failed");

		const blockedPi = createPi();
		let requests = 0;
		blockedPi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, () => { requests += 1; });
		const blocked = await executeSubagentPromptStepOutcome({
			pi: blockedPi,
			prompt: { ...prompt, content: "12345678", budget: { maxTokens: 1 } },
			args: [], ctx, currentModel: ctx.model,
		});
		assert.equal(blocked.status, "blocked");
		assert.equal(requests, 0);
	});
});

test("executeSubagentPromptStep enforces budgets after assembling delegated preambles", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let requests = 0;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, () => { requests += 1; });

		await assert.rejects(
			executeSubagentPromptStep({
				pi,
				prompt: { ...prompt, content: "x", budget: { maxTokens: 2 } },
				args: [],
				ctx,
				currentModel: ctx.model,
				taskPreamble: "this chain context makes the outbound task exceed its configured budget",
			}),
			/exceeds configured maximum of 2/i,
		);
		assert.equal(requests, 0);
	});
});

test("structured delegated skill content still counts toward the prompt budget", async () => {
	await withDelegationBridge(async (root) => {
		const skillDir = join(root, ".pi", "skills", "large-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "this delegated skill payload is intentionally larger than the configured prompt budget");
		const pi = createPi();
		const ctx = createCtx(root);
		let requests = 0;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, () => { requests += 1; });

		await assert.rejects(
			executeSubagentPromptStep({
				pi,
				prompt: { ...prompt, content: "x", skills: ["large-skill"], budget: { maxTokens: 2 } },
				args: [],
				ctx,
				currentModel: ctx.model,
			}),
			/exceeds configured maximum of 2/i,
		);
		assert.equal(requests, 0);
	});
});

test("structured delegation embeds the host-resolved skill instead of letting the child re-resolve its name", async () => {
	await withDelegationBridge(async (root) => {
		const project = join(root, "project");
		const projectSkillDir = join(project, ".pi", "skills", "shared");
		const globalSkillPath = join(root, "global-shared.md");
		mkdirSync(projectSkillDir, { recursive: true });
		writeFileSync(join(projectSkillDir, "SKILL.md"), "untrusted project skill content");
		writeFileSync(globalSkillPath, "approved global skill content");

		const pi = createPi();
		pi.getCommands = () => [{ name: "shared", source: "skill", sourceInfo: { path: globalSkillPath } }];
		const ctx = createCtx(project);
		let outbound: any;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			outbound = data;
			emitStarted(pi, outbound);
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				requestId: outbound.requestId,
				ownerRunId: outbound.ownerRunId,
				nodeId: outbound.nodeId,
				status: "completed",
				result: { kind: "text", text: "Done." },
			});
		});

		await executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, skills: ["shared"] },
			args: [],
			ctx,
			currentModel: ctx.model,
		});

		assert.equal(outbound.skill, undefined);
		assert.match(outbound.task, /approved global skill content/);
		assert.doesNotMatch(outbound.task, /untrusted project skill content/);
	});
});

test("structured delegation rejects an untrusted session cwd before a child request", async () => {
	await withDelegationBridge(async (root) => {
		const project = join(root, "project");
		mkdirSync(project, { recursive: true });
		const pi = createPi();
		const ctx = createCtx(project);
		ctx.isProjectTrusted = () => false;
		let requests = 0;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, () => { requests += 1; });

		await assert.rejects(
			() => executeSubagentPromptStep({
				pi,
				prompt,
				args: [],
				ctx,
				currentModel: ctx.model,
			}),
			/project trust.*not active/i,
		);
		assert.equal(requests, 0);
	});
});

test("structured delegation does not trust project skills outside the trusted session root", async () => {
	await withDelegationBridge(async (root) => {
		const hostProject = join(root, "host-project");
		const externalProject = join(root, "external-project");
		const skillName = "external-only-skill-41d389";
		mkdirSync(join(hostProject, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(externalProject, ".pi", "skills", skillName), { recursive: true });
		writeFileSync(join(externalProject, ".pi", "skills", skillName, "SKILL.md"), "external project skill content");

		const pi = createPi();
		const ctx = createCtx(hostProject);
		let requests = 0;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, () => { requests += 1; });

		await assert.rejects(
			() => executeSubagentPromptStep({
				pi,
				prompt: { ...prompt, cwd: externalProject, skills: [skillName] },
				args: [],
				ctx,
				currentModel: ctx.model,
			}),
			/outside the trusted session root/i,
		);
		assert.equal(requests, 0);
	});
});

test("executeSubagentPromptStep forwards prompt cwd to delegated request", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		const delegatedCwd = join(root, "delegated-cwd");
		mkdirSync(delegatedCwd, { recursive: true });
		let requestCwd: string | undefined;

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			requestCwd = request.cwd;
			emitStarted(pi, request);
			emitCompleted(pi, request, "Done.");
		});

		await executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, cwd: delegatedCwd },
			args: [],
			ctx,
			currentModel: ctx.model,
		});
		assert.equal(requestCwd, realpathSync(delegatedCwd));
	});
});

test("executeSubagentPromptStep rejects nested project configuration without separate interactive approval", async () => {
	await withDelegationBridge(async (root) => {
		const sessionRoot = join(root, "project");
		const nestedProject = join(sessionRoot, "nested");
		mkdirSync(join(nestedProject, ".pi"), { recursive: true });
		const pi = createPi();
		const ctx = createCtx(sessionRoot);
		let requests = 0;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, () => { requests++; });

		await assert.rejects(
			() => executeSubagentPromptStep({
				pi,
				prompt: { ...prompt, cwd: nestedProject },
				args: [],
				ctx,
				currentModel: ctx.model,
			}),
			/separate approval.*nested project/i,
		);
		assert.equal(requests, 0);
	});
});

test("executeSubagentPromptStep uses the approved nested project's canonical cwd for skills, snapshots, and requests", async () => {
	await withDelegationBridge(async (root) => {
		const sessionRoot = join(root, "project");
		const nestedProject = join(sessionRoot, "nested-target");
		const nestedAlias = join(sessionRoot, "nested-alias");
		const skillName = "canonical-target-skill";
		const skillContent = "skill content from canonical nested target";
		mkdirSync(join(nestedProject, ".pi", "skills", skillName), { recursive: true });
		writeFileSync(join(nestedProject, ".pi", "skills", skillName, "SKILL.md"), skillContent);
		writeFileSync(join(nestedProject, "tracked.txt"), "before");
		execFileSync("git", ["init", "--quiet"], { cwd: nestedProject });
		execFileSync("git", ["add", "--", "tracked.txt"], { cwd: nestedProject });
		symlinkSync(nestedProject, nestedAlias);
		const pi = createPi();
		const { ctx } = createInteractiveCtx(sessionRoot);
		let approvals = 0;
		ctx.ui.confirm = async () => {
			approvals++;
			return true;
		};
		let outbound: any;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			outbound = data;
			writeFileSync(join(nestedProject, "tracked.txt"), "after");
			emitStarted(pi, outbound);
			emitCompleted(pi, outbound, "done");
		});

		const result = await executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, cwd: nestedAlias, skills: [skillName] },
			args: [],
			ctx,
			currentModel: ctx.model,
		});

		assert.equal(approvals, 1);
		assert.equal(outbound.cwd, realpathSync(nestedProject));
		assert.match(outbound.task, new RegExp(skillContent));
		assert.equal(result.changed, true);
		assert.equal((pi.customMessages.at(-1) as any).details.changed, true);
	});
});

test("shares one in-flight approval across concurrent requests for a nested project", async () => {
	await withDelegationBridge(async (root) => {
		const sessionRoot = join(root, "project");
		const nestedProject = join(sessionRoot, "nested-concurrent");
		mkdirSync(join(nestedProject, ".pi"), { recursive: true });
		const pi = createPi();
		const { ctx } = createInteractiveCtx(sessionRoot);
		let approvals = 0;
		let releaseApproval!: () => void;
		const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
		ctx.ui.confirm = async () => {
			approvals++;
			await approvalGate;
			return true;
		};
		let requests = 0;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data: unknown) => {
			const request = data as any;
			requests++;
			emitStarted(pi, request);
			emitCompleted(pi, request, "done");
		});

		const runs = Array.from({ length: 3 }, () => executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, cwd: nestedProject },
			args: [],
			ctx,
			currentModel: ctx.model,
		}));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(approvals, 1);
		releaseApproval();
		await Promise.all(runs);
		assert.equal(requests, 3);
	});
});

test("keeps approvals for distinct nested projects during concurrent requests", async () => {
	await withDelegationBridge(async (root) => {
		const sessionRoot = join(root, "project");
		const nestedProjectA = join(sessionRoot, "nested-a");
		const nestedProjectB = join(sessionRoot, "nested-b");
		mkdirSync(join(nestedProjectA, ".pi"), { recursive: true });
		mkdirSync(join(nestedProjectB, ".pi"), { recursive: true });
		const pi = createPi();
		const { ctx } = createInteractiveCtx(sessionRoot);
		let approvals = 0;
		let releaseApproval!: () => void;
		const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
		ctx.ui.confirm = async () => {
			approvals++;
			await approvalGate;
			return true;
		};
		let requests = 0;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data: unknown) => {
			const request = data as any;
			requests++;
			emitStarted(pi, request);
			emitCompleted(pi, request, "done");
		});

		const runs = [nestedProjectA, nestedProjectB].map((cwd) => executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, cwd },
			args: [],
			ctx,
			currentModel: ctx.model,
		}));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(approvals, 2);
		releaseApproval();
		await Promise.all(runs);
		await executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, cwd: nestedProjectA },
			args: [],
			ctx,
			currentModel: ctx.model,
		});
		assert.equal(approvals, 2);
		assert.equal(requests, 3);
	});
});

test("executeSubagentPromptStep forwards custom agents to the loaded bridge", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const hostProject = join(root, "host-project");
		const ctx = createCtx(hostProject);
		const delegatedCwd = join(hostProject, "delegated-project");
		mkdirSync(delegatedCwd, { recursive: true });
		let requestAgent: string | undefined;

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			requestAgent = request.agent;
			emitStarted(pi, request);
			emitCompleted(pi, request, "Done.");
		});

		const result = await executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, subagent: "special", cwd: delegatedCwd },
			args: [],
			ctx,
			currentModel: ctx.model,
		});
		assert.equal(requestAgent, "special");
		assert.equal(result?.agent, "special");
	});
});

test("executeSubagentPromptStep fails on delegated error response", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			emitStarted(pi, request);
			emitFailed(pi, request, "boom");
		});

		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			/boom/,
		);
	});
});

test("executeSubagentPromptStep fails when delegated response has no assistant text", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			emitStarted(pi, request);
			emitCompleted(pi, request, undefined, 1);
		});

		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			/no assistant text/i,
		);
	});
});

test("executeSubagentPromptStep fails immediately when no bridge is listening", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		// No listener registered for REQUEST_EVENT — simulates subagent extension
		// not loaded or shadowed by another extension with the same name.
		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			/no loaded pi-subagents bridge responded/i,
		);
	});
});

test("executeSubagentPromptStep fast-fail error mentions the agent name", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			(error: Error) => {
				assert.match(error.message, /no loaded pi-subagents bridge responded/i);
				assert.match(error.message, /delegate/);
				assert.ok(!error.message.includes("do work"), "should not include prompt content in error");
				return true;
			},
		);
	});
});

test("executeSubagentPromptStep preserves missing-agent errors from the loaded bridge", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			emitStarted(pi, request);
			emitFailed(pi, request, "Delegated subagent `missing` not found. Available agents: delegate, reviewer.");
		});

		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt: { ...prompt, subagent: "missing" },
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			/not found/i,
		);
	});
});

test("executeSubagentPromptStep emits cancel on escape in UI mode", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const { ctx, sendInput } = createInteractiveCtx(root);
		let cancelPayload: Record<string, unknown> | undefined;
		let activeRequest: any;

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data) => {
			cancelPayload = data as Record<string, unknown>;
			if (activeRequest) setTimeout(() => emitCancelled(pi, activeRequest), 0);
		});

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			activeRequest = request;
			emitStarted(pi, request);
			setTimeout(() => sendInput("\x1b"), 0);
		});

		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			(error: Error) => error instanceof DelegatedPromptCancelledError,
		);
		assert.ok(cancelPayload?.requestId);
		assert.equal(cancelPayload?.ownerRunId, cancelPayload?.requestId);
		assert.equal(cancelPayload?.nodeId, "single");
	});
});

test("executeSubagentPromptStep emits cancel on abort signal", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		const controller = new AbortController();
		let cancelPayload: Record<string, unknown> | undefined;
		let activeRequest: any;

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data) => {
			cancelPayload = data as Record<string, unknown>;
			if (activeRequest) setTimeout(() => emitCancelled(pi, activeRequest), 0);
		});

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			activeRequest = request;
			emitStarted(pi, request);
			setTimeout(() => controller.abort(), 0);
		});

		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
					signal: controller.signal,
				}),
			(error: Error) => error instanceof DelegatedPromptCancelledError,
		);
		assert.ok(cancelPayload?.requestId);
		assert.equal(cancelPayload?.ownerRunId, cancelPayload?.requestId);
		assert.equal(cancelPayload?.nodeId, "single");
	});
});

test("executeSubagentPromptStep waits for terminal response after abort signal", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		const controller = new AbortController();
		let activeRequest: any;
		let settled = false;
		let settledBeforeTerminal: boolean | undefined;

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			activeRequest = data;
			emitStarted(pi, activeRequest);
			setTimeout(() => controller.abort(), 0);
		});
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, () => {
			setTimeout(() => {
				settledBeforeTerminal = settled;
				emitCancelled(pi, activeRequest);
			}, 30);
		});

		const run = executeSubagentPromptStep({
			pi,
			prompt,
			args: [],
			ctx,
			currentModel: ctx.model,
			signal: controller.signal,
		});
		run.finally(() => { settled = true; }).catch(() => {});

		await assert.rejects(
			() => run,
			(error: Error) => error instanceof DelegatedPromptCancelledError,
		);
		await delay(40);
		assert.equal(settledBeforeTerminal, false);
	});
});

test("executeSubagentPromptStep reports a distinct cancellation drain timeout", async () => {
	const previousTimeout = process.env.PI_PROMPT_SUBAGENT_CANCEL_DRAIN_TIMEOUT_MS;
	try {
		process.env.PI_PROMPT_SUBAGENT_CANCEL_DRAIN_TIMEOUT_MS = "25";
		await withDelegationBridge(async (root) => {
			const pi = createPi();
			const ctx = createCtx(root);
			const controller = new AbortController();
			let cancels = 0;

			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, () => {
				cancels += 1;
			});
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
				const request = data as any;
				emitStarted(pi, request);
				setTimeout(() => controller.abort(), 0);
			});

			await assert.rejects(
				() => executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
					signal: controller.signal,
				}),
				(error: Error) => {
					assert.ok(error instanceof DelegatedPromptCancellationDrainTimeoutError);
					assert.match(error.message, /acknowledge cancellation/i);
					return true;
				},
			);
			assert.equal(cancels, 1);
		});
	} finally {
		if (previousTimeout === undefined) delete process.env.PI_PROMPT_SUBAGENT_CANCEL_DRAIN_TIMEOUT_MS;
		else process.env.PI_PROMPT_SUBAGENT_CANCEL_DRAIN_TIMEOUT_MS = previousTimeout;
	}
});

test("executeSubagentPromptStep emits no bridge events when its signal is already aborted", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		const controller = new AbortController();
		controller.abort();
		let requests = 0;
		let cancels = 0;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, () => { requests += 1; });
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, () => { cancels += 1; });

		await assert.rejects(
			() => executeSubagentPromptStep({
				pi,
				prompt,
				args: [],
				ctx,
				currentModel: ctx.model,
				signal: controller.signal,
			}),
			(error: Error) => error instanceof DelegatedPromptCancelledError,
		);
		assert.equal(requests, 0);
		assert.equal(cancels, 0);
	});
});

test("executeSubagentPromptStep ignores terminal input outside TUI mode", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		ctx.mode = "rpc";
		ctx.hasUI = true;
		let terminalSubscriptions = 0;
		ctx.ui.onTerminalInput = () => {
			terminalSubscriptions += 1;
			return () => {};
		};

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			emitStarted(pi, request);
			emitCompleted(pi, request, "done");
		});

		await executeSubagentPromptStep({
			pi,
			prompt,
			args: [],
			ctx,
			currentModel: ctx.model,
		});

		assert.equal(terminalSubscriptions, 0);
	});
});

test("executeSubagentPromptStep respects producer-owned progress widgets", async () => {
	for (const scenario of [
		{ label: "true", ownsProgress: true, suppress: true },
		{ label: "false", ownsProgress: false, suppress: false },
		{ label: "missing", suppress: false },
		{ label: "non-boolean", ownsProgress: "true", suppress: false },
	]) {
		await withDelegationBridge(async (root) => {
			const pi = createPi();
			const ctx = createCtx(root);
			ctx.hasUI = true;
			const widgetCalls: unknown[][] = [];
			ctx.ui.setWidget = (...args: unknown[]) => {
				widgetCalls.push(args);
			};
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
				const request = data as any;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, {
					requestId: request.requestId,
					ownerRunId: request.ownerRunId,
					nodeId: request.nodeId,
					...(scenario.ownsProgress === undefined ? {} : { ownsProgress: scenario.ownsProgress }),
				});
				emitCompleted(pi, request, "Done.");
			});

			await executeSubagentPromptStep({
				pi,
				prompt,
				args: [],
				ctx,
				currentModel: ctx.model,
			});

			assert.equal(widgetCalls.length, scenario.suppress ? 0 : 2, scenario.label);
		});
	}
});

test("executeSubagentPromptStep keeps single-task status running between tool calls", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		ctx.hasUI = true;
		const statusLines: string[] = [];
		ctx.ui.setStatus = (key: string, value?: string) => {
			if (key.startsWith(`${DELEGATED_WIDGET_KEY}:`) && value) statusLines.push(value);
		};

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			emitStarted(pi, request);
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, withIdentity(request, {
				toolCount: 1,
				currentTool: "read",
				currentToolArgs: "README.md",
			}));
			emitCompleted(pi, request, "Done.", 1);
		});

		await executeSubagentPromptStep({
			pi,
			prompt,
			args: [],
			ctx,
			currentModel: ctx.model,
		});

		assert.ok(statusLines.some((line) => line.includes("delegating to delegate · running read")));
		assert.equal(statusLines.some((line) => line.includes("completed 1 tool")), false);
	});
});

test("executeSubagentPromptStep avoids duplicating single-task output lines from mirrored progress payloads", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let capturedOutput: string[] = [];

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			emitStarted(pi, request);
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, withIdentity(request, {
				recentOutputLines: ["single-a", "single-b"],
			}));
			capturedOutput = getDelegatedLiveState(request.requestId)?.recentOutput ?? [];
			emitCompleted(pi, request, "Done.");
		});

		await executeSubagentPromptStep({
			pi,
			prompt,
			args: [],
			ctx,
			currentModel: ctx.model,
		});

		assert.deepEqual(capturedOutput, ["single-a", "single-b"]);
	});
});

test("executeSubagentPromptStep prepends taskPreamble for delegated single tasks", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let delegatedTask = "";
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			delegatedTask = request.task;
			emitStarted(pi, request);
			emitCompleted(pi, request, "Done.");
		});

		await executeSubagentPromptStep({
			pi,
			prompt,
			args: [],
			ctx,
			currentModel: ctx.model,
			taskPreamble: "[Previous chain steps]\n\nStep 1 — analyze:\nOutcome: done",
		});

		assert.equal(delegatedTask, "[Previous chain steps]\n\nStep 1 — analyze:\nOutcome: done\n\n---\n\ndo work");
	});
});

test("executeSubagentPromptStep ignores taskPreamble when inheritContext is true", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let delegatedTask = "";
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			delegatedTask = request.task;
			emitStarted(pi, request);
			emitCompleted(pi, request, "Done.");
		});

		await executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, inheritContext: true },
			args: [],
			ctx,
			currentModel: ctx.model,
			taskPreamble: "[Previous chain steps]\n\nStep 1 — analyze:\nOutcome: done",
		});

		assert.equal(delegatedTask, "do work");
	});
});

test("executeSubagentPromptStep keeps task unchanged when taskPreamble is omitted", async () => {
	await withDelegationBridge(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		let delegatedTask = "";
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			delegatedTask = request.task;
			emitStarted(pi, request);
			emitCompleted(pi, request, "Done.");
		});

		await executeSubagentPromptStep({
			pi,
			prompt,
			args: [],
			ctx,
			currentModel: ctx.model,
		});

		assert.equal(delegatedTask, "do work");
	});
});
