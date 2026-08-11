import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptModelExtension from "../index.ts";
import {
	PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
} from "../subagent-runtime.ts";

const MODEL = { provider: "anthropic", id: "claude-sonnet-4-20250514" };

interface FakeCommand {
	description: string;
	handler: (args: string, ctx: any) => Promise<void>;
}

interface FakeTool {
	name: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<any>;
}

class FakePi {
	commands = new Map<string, FakeCommand>();
	tools = new Map<string, FakeTool>();
	hooks = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();
	bus = new Map<string, Array<(data: unknown) => void>>();
	events = {
		emit: (channel: string, data: unknown) => {
			for (const handler of this.bus.get(channel) ?? []) handler(data);
		},
		on: (channel: string, handler: (data: unknown) => void) => {
			const handlers = this.bus.get(channel) ?? [];
			handlers.push(handler);
			this.bus.set(channel, handlers);
			return () => {
				const current = this.bus.get(channel) ?? [];
				this.bus.set(channel, current.filter((entry) => entry !== handler));
			};
		},
	};
	currentModel = MODEL;
	setModelCalls: string[] = [];
	userMessages: string[] = [];
	customMessages: any[] = [];
	notifications: Array<{ message: string; type: string }> = [];

	registerMessageRenderer() {}
	registerCommand(name: string, command: FakeCommand) { this.commands.set(name, command); }
	registerTool(tool: FakeTool) { this.tools.set(tool.name, tool); }
	getCommands() { return []; }
	on(event: string, handler: (event: any, ctx: any) => Promise<any> | any) {
		const handlers = this.hooks.get(event) ?? [];
		handlers.push(handler);
		this.hooks.set(event, handlers);
	}
	async emit(event: string, payload: any, ctx: any) {
		for (const handler of this.hooks.get(event) ?? []) await handler(payload, ctx);
	}
	async setModel(model: { provider: string; id: string }) {
		this.setModelCalls.push(`${model.provider}/${model.id}`);
		this.currentModel = model;
		return true;
	}
	getThinkingLevel() { return "medium" as const; }
	setThinkingLevel() {}
	sendUserMessage(content: string) { this.userMessages.push(content); }
	sendMessage(message: any) { this.customMessages.push(message); }
}

function withTempHome(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-subagent-index-"));
	const prevHome = process.env.HOME;
	process.env.HOME = root;
	return run(root).finally(() => {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		rmSync(root, { recursive: true, force: true });
	});
}

function createContext(cwd: string, pi: FakePi) {
	const branch: any[] = [{ id: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } }];
	let entryCount = 0;
	const nextId = (prefix: string) => `${prefix}-${++entryCount}`;
	pi.sendUserMessage = (content: string) => {
		pi.userMessages.push(content);
		branch.push({
			id: nextId("user"),
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: content }],
			},
		});
	};
	pi.sendMessage = (message: any) => {
		pi.customMessages.push(message);
		branch.push({
			id: nextId("custom"),
			type: "custom_message",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
		});
	};

	return {
		ctx: {
			cwd,
			hasUI: false,
			model: MODEL,
			modelRegistry: {
				find(provider: string, id: string) {
					return provider === MODEL.provider && id === MODEL.id ? MODEL : undefined;
				},
				getAll() { return [MODEL]; },
				getAvailable() { return [MODEL]; },
					async getApiKeyAndHeaders() { return { ok: true, apiKey: "token" }; },
				isUsingOAuth() { return false; },
			},
			ui: {
				notify(message: string, type: string) { pi.notifications.push({ message, type }); },
				onTerminalInput() { return () => {}; },
				setStatus() {},
				setWorkingMessage() {},
				theme: { fg(_token: string, text: string) { return text; } },
			},
			isIdle() { return false; },
			async waitForIdle() {},
			sessionManager: {
				getLeafId() { return branch[branch.length - 1]?.id ?? "root"; },
				getBranch() { return branch; },
			},
			async navigateTree() { return { cancelled: false }; },
		},
		branch,
	};
}

function respondWithDelegatedResult(pi: FakePi, setup?: (request: any) => void) {
	pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
		const request = payload as any;
		setup?.(request);
		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, {
			requestId: request.requestId,
			ownerRunId: request.ownerRunId,
			nodeId: request.nodeId,
		});
		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
			requestId: request.requestId,
			ownerRunId: request.ownerRunId,
			nodeId: request.nodeId,
			status: "completed",
			agent: request.agent,
			model: request.model,
			result: { kind: "text", text: "Done" },
			usage: { input: 120, output: 34, cacheRead: 5, cacheWrite: 6, cost: 0.1234, turns: 3, toolCalls: 1, durationMs: 1500 },
		});
	});
}

test("delegated prompts honor default agent, runtime override, and inheritContext", async () => {
	await withTempHome(async (root) => {
		const cases = [
			{
				name: "default",
				frontmatter: "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nwork",
				args: "",
				checkRequest(request: any) {
					assert.equal(request.agent, "delegate");
					assert.equal(request.context, "fresh");
				},
				after(pi: FakePi) {
					assert.deepEqual(pi.setModelCalls, []);
					assert.equal(pi.customMessages.length, 1);
				},
			},
			{
				name: "override",
				frontmatter: "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: worker\n---\nwork",
				args: "--subagent:reviewer",
				checkRequest(request: any) {
					assert.equal(request.agent, "reviewer");
				},
			},
			{
				name: "fork",
				frontmatter: "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\ninheritContext: true\n---\nwork",
				args: "",
				checkRequest(request: any) {
					assert.equal(request.context, "fork");
				},
			},
		] as const;

		for (const testCase of cases) {
			const cwd = join(root, testCase.name);
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), testCase.frontmatter);

			const pi = new FakePi();
			const { ctx } = createContext(cwd, pi);
			promptModelExtension(pi as never);
			await pi.emit("session_start", {}, ctx);
			respondWithDelegatedResult(pi, (request) => {
				testCase.checkRequest(request);
			});

			await pi.commands.get("simplify")!.handler(testCase.args, ctx);
			testCase.after?.(pi);
		}
	});
});

test("delegated loops converge from delegated write/no-write changes", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nwork");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		let call = 0;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			call++;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, {
				requestId: request.requestId,
				ownerRunId: request.ownerRunId,
				nodeId: request.nodeId,
			});
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				requestId: request.requestId,
				ownerRunId: request.ownerRunId,
				nodeId: request.nodeId,
				status: "completed",
				agent: request.agent,
				model: request.model,
				result: { kind: "text", text: call === 1 ? "changed" : "no changes" },
				usage: { input: 120, output: 34, cacheRead: 5, cacheWrite: 6, cost: 0.1234, turns: 3, toolCalls: call === 1 ? 1 : 0, durationMs: 1500 },
			});
		});

		await pi.commands.get("simplify")!.handler("--loop 5", ctx);
		assert.equal(call, 2);
	});
});

test("queued run-prompt executes delegated commands", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nwork");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);
		respondWithDelegatedResult(pi);

		await pi.commands.get("prompt-tool")!.handler("on", ctx);
		await pi.tools.get("run-prompt")!.execute("tool-1", { command: "simplify" });
		await pi.emit("agent_end", {}, ctx);
		await pi.emit("agent_settled", {}, ctx);

		assert.equal(pi.customMessages.length, 1);
	});
});

test("delegated Escape cancellation emits a cancelled prompt lifecycle", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nwork");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		let terminalHandler: ((input: string) => unknown) | undefined;
		(ctx as any).mode = "tui";
		(ctx as any).hasUI = true;
		(ctx as any).ui.onTerminalInput = (handler: (input: string) => unknown) => {
			terminalHandler = handler;
			return () => { if (terminalHandler === handler) terminalHandler = undefined; };
		};
		(ctx as any).ui.setWidget = () => {};
		let cancelPayload: any;
		let finishedPayload: any;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (payload) => { cancelPayload = payload; });
		pi.events.on(PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT, (payload) => { finishedPayload = payload; });
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, {
				requestId: request.requestId,
				ownerRunId: request.ownerRunId,
				nodeId: request.nodeId,
			});
			setTimeout(() => terminalHandler?.("\x1b"), 0);
		});
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("simplify")!.handler("", ctx);

		assert.equal(cancelPayload.requestId, cancelPayload.ownerRunId);
		assert.equal(cancelPayload.nodeId, "single");
		assert.equal(finishedPayload.status, "cancelled");
		assert.deepEqual(pi.userMessages, []);
	});
});

test("session shutdown settles a delegated request when the bridge emits no terminal response", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nwork");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		let requestStarted!: () => void;
		const started = new Promise<void>((resolve) => { requestStarted = resolve; });
		let finishedPayload: any;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, {
				requestId: request.requestId,
				ownerRunId: request.ownerRunId,
				nodeId: request.nodeId,
			});
			requestStarted();
		});
		pi.events.on(PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT, (payload) => { finishedPayload = payload; });
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		const command = pi.commands.get("simplify")!.handler("", ctx);
		await started;
		await pi.emit("session_shutdown", {}, ctx);
		const settled = await Promise.race([
			command.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
		]);

		assert.equal(settled, true);
		assert.equal(finishedPayload?.status, "cancelled");
		assert.deepEqual(pi.userMessages, []);
	});
});

test("removed legacy runtime flags fail before delegated execution", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nwork $@");
		writeFileSync(join(cwd, ".pi", "prompts", "input-legacy.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\ninputs:\n  target:\n    type: string\n    required: true\n---\nwork ${input.target}");

		const pi = new FakePi();
		let requests = 0;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, () => { requests += 1; });
		const { ctx } = createContext(cwd, pi);
		ctx.hasUI = true;
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("simplify")!.handler("--worktree target", ctx);
		assert.match(pi.notifications.map((entry) => entry.message).join("\n"), /removed legacy runtime flag.*--worktree/i);
		pi.notifications.length = 0;

		await pi.commands.get("input-legacy")!.handler("-- --worktree", ctx);

		assert.equal(requests, 0);
		assert.deepEqual(pi.userMessages, []);
		assert.match(pi.notifications.map((entry) => entry.message).join("\n"), /removed legacy runtime flag.*--worktree/i);
	});
});
