import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLineupOverrides, executeBestOfNPrompt, MAX_BEST_OF_N_REQUESTS } from "../best-of-n.ts";
import { PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE, PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT } from "../subagent-runtime.ts";
import { getLastAssistantText } from "../loop-utils.ts";

function createPi(
	responses: string[],
	requests: any[] = [],
	changedResponses: boolean[] = [],
	failedAgents: string[] = [],
	onRequest?: (data: any) => void,
) {
	const bus = new Map<string, Array<(data: unknown) => void>>();
	const customMessages: unknown[] = [];
	let responseIndex = 0;
	const pi = {
		customMessages,
		events: {
			emit(channel: string, data: unknown) {
				for (const handler of bus.get(channel) ?? []) handler(data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				const handlers = bus.get(channel) ?? [];
				handlers.push(handler);
				bus.set(channel, handlers);
				return () => bus.set(channel, (bus.get(channel) ?? []).filter((entry) => entry !== handler));
			},
		},
		sendMessage(message: unknown) {
			customMessages.push(message);
		},
	} as any;
	pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data: any) => {
		requests.push(data);
		onRequest?.(data);
		const currentResponseIndex = responseIndex++;
		const failed = failedAgents.includes(data.agent);
		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, {
			requestId: data.requestId,
			ownerRunId: data.ownerRunId,
			nodeId: data.nodeId,
		});
		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
			requestId: data.requestId,
			ownerRunId: data.ownerRunId,
			nodeId: data.nodeId,
			status: failed ? "failed" : "completed",
			agent: data.agent,
			model: data.model,
			...(failed ? { error: `${data.agent} unavailable` } : { result: { kind: "text", text: responses[currentResponseIndex] ?? "fallback" } }),
			changed: changedResponses[currentResponseIndex] === true,
			usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01, turns: 1, toolCalls: 1, durationMs: 100 },
		});
	});
	return pi;
}

function createCtx(cwd: string) {
	if (!existsSync(join(cwd, ".git"))) {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd });
		writeFileSync(join(cwd, "tracked.txt"), "base\n");
		execFileSync("git", ["add", "tracked.txt"], { cwd });
		execFileSync("git", ["commit", "-qm", "initial"], { cwd });
	}
	const model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
	const configured = { provider: "openai", id: "configured" };
	return {
		cwd,
		mode: "print",
		scopedModels: [],
		hasUI: false,
		model,
		isProjectTrusted: () => true,
		modelRegistry: {
			find: (provider: string, id: string) => [model, configured].find((candidate) => candidate.provider === provider && candidate.id === id),
			getAll: () => [model, configured],
			getAvailable: () => [model, configured],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "token" }),
			isUsingOAuth: () => false,
		},
		ui: { notify() {}, onTerminalInput: () => () => {}, setStatus() {}, setWorkingMessage() {}, setWidget() {}, theme: { fg: (_: string, text: string) => text, bold: (text: string) => text } },
		sessionManager: { getLeafId: () => "leaf", getBranch: () => [] },
		isIdle: () => false,
		waitForIdle: async () => {},
	} as any;
}

function createGitRepo(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
	writeFileSync(join(root, "tracked.txt"), "base\n");
	execFileSync("git", ["add", "tracked.txt"], { cwd: root });
	execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
	return root;
}

const basePrompt = {
	name: "compare",
	description: "",
	content: "Solve the task.",
	models: ["anthropic/claude-sonnet-4-20250514"],
	restore: false,
	source: "project",
	filePath: "compare.md",
} as any;

test("applies lineup replacements and appends in command order", () => {
	const config = { workers: [{ agent: "one" }], reviewers: [{ agent: "review" }], finalApplier: { agent: "final" } };
	const result = applyLineupOverrides(config, [
		{ target: "workers", mode: "append", slots: [{ agent: "two" }] },
		{ target: "reviewers", mode: "replace", slots: [{ agent: "new-review" }] },
		{ target: "finalApplier", mode: "replace", slots: [{ agent: "new-final" }] },
	]);
	assert.deepEqual(result, { workers: [{ agent: "one" }, { agent: "two" }], reviewers: [{ agent: "new-review" }], finalApplier: { agent: "new-final" } });
});

test("isolates concurrent workers in separate worktrees", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-isolation-");
	try {
		const requests: any[] = [];
		const pi = createPi(["candidate one", "candidate two"], requests, [], [], (data) => {
			if (data.agent === "worker") writeFileSync(join(data.cwd, "worker-marker.txt"), data.agent);
		});
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker", count: 2 }] },
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "completed");
		assert.equal(requests.length, 2);
		const workerCwds = requests.map((request) => request.cwd);
		assert.equal(new Set(workerCwds).size, 2);
		assert.equal(workerCwds.every((cwd) => !existsSync(cwd)), true);
		assert.equal(existsSync(join(root, "worker-marker.txt")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects a dirty source worktree before launching workers", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-dirty-");
	try {
		writeFileSync(join(root, "tracked.txt"), "dirty\n");
		const requests: any[] = [];
		const pi = createPi(["candidate"], requests);
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker" }] },
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "failed");
		assert.equal(requests.length, 0);
		assert.equal(existsSync(join(root, "tracked.txt")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects an untrusted worker source cwd before creating a worktree", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-trusted-root-");
	const outside = createGitRepo("pi-prompt-best-of-n-untrusted-root-");
	try {
		const requests: any[] = [];
		const pi = createPi(["candidate"], requests);
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker", cwd: outside }] },
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "failed");
		assert.equal(requests.length, 0);
	} finally {
		rmSync(outside, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("runs worker, reviewer, and final-applier phases through individual structured requests", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-"));
	try {
		const requests: any[] = [];
		const pi = createPi(
			["candidate one", "candidate two", "review findings", "final answer"],
			requests,
			[true],
			[],
			(data) => {
				if (data.agent === "worker") writeFileSync(join(data.cwd, "candidate-marker.txt"), data.agent);
				if (data.agent === "applier") {
					const workerCwds = requests.filter((request) => request.agent === "worker").map((request) => request.cwd);
					assert.equal(workerCwds.length, 2);
					assert.equal(workerCwds.every((cwd) => existsSync(cwd)), true);
					assert.match(data.task, /Worktree:/);
				}
			},
		);
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker", count: 2 }], reviewers: [{ agent: "reviewer" }], finalApplier: { agent: "applier" } },
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "completed");
		assert.equal(pi.customMessages.length, 1);
		assert.equal((pi.customMessages[0] as any).customType, PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE);
		assert.match((pi.customMessages[0] as any).content, /final answer/);
		assert.equal((pi.customMessages[0] as any).details.text, (pi.customMessages[0] as any).content);
		assert.equal(getLastAssistantText([{ type: "custom_message", ...(pi.customMessages[0] as any) } as any]), (pi.customMessages[0] as any).details.text);
		assert.equal((pi.customMessages[0] as any).details.changed, true);
		assert.deepEqual((pi.customMessages[0] as any).details.usage, {
			input: 40,
			output: 20,
			cacheRead: 4,
			cacheWrite: 8,
			cost: 0.04,
			turns: 4,
			toolCalls: 4,
			durationMs: 400,
		});
		assert.equal(requests.length, 4);
		assert.equal(new Set(requests.slice(0, 3).map((request) => request.cwd)).size, 3);
		assert.equal(requests[3].cwd, realpathSync(root));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("preserves the original task when reviewer and final-applier tasks override phase instructions", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-task-context-"));
	try {
		const requests: any[] = [];
		const pi = createPi(["candidate", "review", "final"], requests);
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: { ...basePrompt, content: "Original requirements must remain visible." },
			config: {
				workers: [{ agent: "worker" }],
				reviewers: [{ agent: "reviewer", task: "Check compliance only." }],
				finalApplier: { agent: "applier", task: "Return the final response only." },
			},
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "completed");
		const reviewerRequest = requests.find((request) => request.agent === "reviewer");
		assert.ok(reviewerRequest);
		assert.match(reviewerRequest.task, /Check compliance only\./);
		assert.match(reviewerRequest.task, /Original requirements must remain visible\./);
		const applierRequest = requests.find((request) => request.agent === "applier");
		assert.ok(applierRequest);
		assert.match(applierRequest.task, /Return the final response only\./);
		assert.match(applierRequest.task, /Original requirements must remain visible\./);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("forwards runtime subagent and fork overrides to every best-of-N request", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-runtime-"));
	try {
		const requests: any[] = [];
		const pi = createPi(["candidate"], requests);
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: { ...basePrompt, content: "Base candidate task." },
			config: { workers: [{ agent: "configured-worker", model: "openai/configured" }] },
			args: [],
			currentModel: context.model,
			runtimeOverride: { enabled: true, agent: "runtime-worker" },
			runtimeModel: "anthropic/claude-sonnet-4-20250514",
			runtimeCwd: root,
			runtimeFork: true,
		});
		assert.equal(result, "completed");
		assert.equal(requests.length, 1);
		assert.equal(requests[0].agent, "runtime-worker");
		assert.equal(requests[0].context, "fork");
		assert.equal(requests[0].model, "anthropic/claude-sonnet-4-20250514");
		assert.notEqual(requests[0].cwd, realpathSync(root));
		assert.match(requests[0].cwd, /pi-prompt-best-of-n-worktrees-/);
		assert.match(requests[0].task, /independent candidate answer/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("passes reviewer failures to the final applier", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-failure-"));
	try {
		const requests: any[] = [];
		const bus = new Map<string, Array<(data: unknown) => void>>();
		const pi = {
			events: {
				emit(channel: string, data: unknown) {
					for (const handler of bus.get(channel) ?? []) handler(data);
				},
				on(channel: string, handler: (data: unknown) => void) {
					const handlers = bus.get(channel) ?? [];
					handlers.push(handler);
					bus.set(channel, handlers);
					return () => bus.set(channel, (bus.get(channel) ?? []).filter((entry) => entry !== handler));
				},
			},
			sendMessage() {},
		} as any;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data: any) => {
			requests.push(data);
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, {
				requestId: data.requestId,
				ownerRunId: data.ownerRunId,
				nodeId: data.nodeId,
			});
			const failed = data.agent === "reviewer";
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				requestId: data.requestId,
				ownerRunId: data.ownerRunId,
				nodeId: data.nodeId,
				status: failed ? "failed" : "completed",
				agent: data.agent,
				model: data.model,
				...(failed ? { error: "review backend unavailable" } : { result: { kind: "text", text: data.agent === "applier" ? "final answer" : "candidate" } }),
			});
		});
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker" }], reviewers: [{ agent: "reviewer" }], finalApplier: { agent: "applier" } },
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "completed");
		const applierRequest = requests.find((request) => request.agent === "applier");
		assert.ok(applierRequest);
		assert.match(applierRequest.task, /review backend unavailable/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails when a configured final applier produces no successful result", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-final-failure-"));
	try {
		const requests: any[] = [];
		const pi = createPi(["candidate"], requests, [], ["applier"]);
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker" }], finalApplier: { agent: "applier" } },
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "failed");
		assert.equal(pi.customMessages.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("preserves original slot labels when an earlier worker fails", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-slot-labels-"));
	try {
		const requests: any[] = [];
		const bus = new Map<string, Array<(data: unknown) => void>>();
		const pi = {
			events: {
				emit(channel: string, data: unknown) {
					for (const handler of bus.get(channel) ?? []) handler(data);
				},
				on(channel: string, handler: (data: unknown) => void) {
					const handlers = bus.get(channel) ?? [];
					handlers.push(handler);
					bus.set(channel, handlers);
					return () => bus.set(channel, (bus.get(channel) ?? []).filter((entry) => entry !== handler));
				},
			},
			sendMessage() {},
		} as any;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data: any) => {
			requests.push(data);
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, {
				requestId: data.requestId,
				ownerRunId: data.ownerRunId,
				nodeId: data.nodeId,
			});
			const failed = data.agent === "first";
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				requestId: data.requestId,
				ownerRunId: data.ownerRunId,
				nodeId: data.nodeId,
				status: failed ? "failed" : "completed",
				agent: data.agent,
				...(failed ? { error: "first worker unavailable" } : { result: { kind: "text", text: `${data.agent} result` } }),
			});
		});
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "first" }, { agent: "second" }], reviewers: [{ agent: "reviewer" }], finalApplier: { agent: "applier" } },
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "completed");
		const reviewerRequest = requests.find((request) => request.agent === "reviewer");
		assert.ok(reviewerRequest);
		assert.match(reviewerRequest.task, /Candidate 1 \(first\)[\s\S]*failed/);
		assert.match(reviewerRequest.task, /Candidate 2 \(second\)/);
		const applierRequest = requests.find((request) => request.agent === "applier");
		assert.ok(applierRequest);
		assert.match(applierRequest.task, /Candidate 1 \(first\)[\s\S]*failed/);
		assert.match(applierRequest.task, /Candidate 2 \(second\)/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("cancels sibling best-of-N requests when a child response is cancelled", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-child-cancel-"));
	try {
		const requests: any[] = [];
		const cancelEvents: string[] = [];
		const timers = new Map<string, ReturnType<typeof setTimeout>>();
		const bus = new Map<string, Array<(data: unknown) => void>>();
		const pi = {
			events: {
				emit(channel: string, data: unknown) {
					for (const handler of bus.get(channel) ?? []) handler(data);
				},
				on(channel: string, handler: (data: unknown) => void) {
					const handlers = bus.get(channel) ?? [];
					handlers.push(handler);
					bus.set(channel, handlers);
					return () => bus.set(channel, (bus.get(channel) ?? []).filter((entry) => entry !== handler));
				},
			},
			sendMessage() {},
		} as any;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data: any) => {
			requests.push(data);
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, {
				requestId: data.requestId,
				ownerRunId: data.ownerRunId,
				nodeId: data.nodeId,
			});
			const status = requests.length === 1 ? "cancelled" : "completed";
			timers.set(data.requestId, setTimeout(() => {
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					requestId: data.requestId,
					ownerRunId: data.ownerRunId,
					nodeId: data.nodeId,
					status,
					agent: data.agent,
					...(status === "completed" ? { result: { kind: "text", text: "late result" } } : {}),
				});
			}, status === "cancelled" ? 0 : 1000));
		});
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data: any) => {
			cancelEvents.push(data.requestId);
			const timer = timers.get(data.requestId);
			if (timer) clearTimeout(timer);
		});
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker", count: 3 }] },
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "cancelled");
		assert.equal(requests.length, 3);
		assert.equal(cancelEvents.length, 2);
		assert.equal(new Set(cancelEvents).size, 2);
		assert.equal(cancelEvents.includes(requests[0]!.requestId), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("cancels sibling best-of-N requests when the parent is cancelled", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-cancel-"));
	try {
		const requests: any[] = [];
		const cancelled = new Set<string>();
		const cancelEvents: string[] = [];
		const timers = new Map<string, ReturnType<typeof setTimeout>>();
		const controller = new AbortController();
		const bus = new Map<string, Array<(data: unknown) => void>>();
		const pi = {
			events: {
				emit(channel: string, data: unknown) {
					for (const handler of bus.get(channel) ?? []) handler(data);
				},
				on(channel: string, handler: (data: unknown) => void) {
					const handlers = bus.get(channel) ?? [];
					handlers.push(handler);
					bus.set(channel, handlers);
					return () => bus.set(channel, (bus.get(channel) ?? []).filter((entry) => entry !== handler));
				},
			},
			sendMessage() {},
		} as any;
		let abortScheduled = false;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data: any) => {
			requests.push(data);
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, {
				requestId: data.requestId,
				ownerRunId: data.ownerRunId,
				nodeId: data.nodeId,
			});
			if (!abortScheduled) {
				abortScheduled = true;
				setTimeout(() => controller.abort(), 0);
			}
			timers.set(data.requestId, setTimeout(() => {
				if (!cancelled.has(data.requestId)) {
					pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
						requestId: data.requestId,
						ownerRunId: data.ownerRunId,
						nodeId: data.nodeId,
						status: "completed",
						agent: data.agent,
						result: { kind: "text", text: "late result" },
					});
				}
			}, 100));
		});
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data: any) => {
			cancelled.add(data.requestId);
			cancelEvents.push(data.requestId);
			const timer = timers.get(data.requestId);
			if (timer) clearTimeout(timer);
		});
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker", count: 3 }] },
			args: [],
			currentModel: context.model,
			signal: controller.signal,
		});
		assert.equal(result, "cancelled");
		assert.equal(requests.length, 3);
		assert.equal(cancelEvents.length, 3);
		assert.equal(new Set(cancelEvents).size, 3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("uses a runtime model override and includes each slot suffix once", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-model-"));
	try {
		const requests: any[] = [];
		const pi = createPi(["candidate"], requests);
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: { ...basePrompt, content: "Base candidate task.", models: ["openai/configured"] },
			config: { workers: [{ agent: "worker", taskSuffix: "Use the required format." }] },
			args: [],
			currentModel: context.model,
			runtimeModel: "anthropic/claude-sonnet-4-20250514",
		});
		assert.equal(result, "completed");
		assert.equal(requests.length, 1);
		assert.equal(requests[0].model, "anthropic/claude-sonnet-4-20250514");
		assert.equal((requests[0].task.match(/Use the required format\./g) ?? []).length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects best-of-N fan-out above the configured request budget", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-limit-"));
	try {
		const pi = createPi([]);
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker", count: MAX_BEST_OF_N_REQUESTS + 1 }] },
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "failed");
		assert.equal(pi.customMessages.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects an unsafe lineup count before expanding requests", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-unsafe-count-"));
	try {
		const pi = createPi([]);
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker", count: Number.MAX_SAFE_INTEGER }] },
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "failed");
		assert.equal(pi.customMessages.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
