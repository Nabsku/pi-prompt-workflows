import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLineupOverrides, executeBestOfNPrompt, MAX_BEST_OF_N_REQUESTS } from "../best-of-n.ts";
import { PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE, PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT } from "../subagent-runtime.ts";
import { getLastAssistantText } from "../loop-utils.ts";

function createPi(responses: string[], requests: any[] = [], changedResponses: boolean[] = []) {
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
		const currentResponseIndex = responseIndex++;
		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, {
			requestId: data.requestId,
			ownerRunId: data.ownerRunId,
			nodeId: data.nodeId,
		});
		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
			requestId: data.requestId,
			ownerRunId: data.ownerRunId,
			nodeId: data.nodeId,
			status: "completed",
			agent: data.agent,
			model: data.model,
			result: { kind: "text", text: responses[currentResponseIndex] ?? "fallback" },
			changed: changedResponses[currentResponseIndex] === true,
			usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01, turns: 1, toolCalls: 1, durationMs: 100 },
		});
	});
	return pi;
}

function createCtx(cwd: string) {
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

test("runs worker, reviewer, and final-applier phases through individual structured requests", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-"));
	try {
		const pi = createPi(["candidate one", "candidate two", "review findings", "final answer"], [], [true]);
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
		assert.equal(requests[0].cwd, realpathSync(root));
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
		assert.match(reviewerRequest.task, /Candidate 1 \(first\) failed/);
		assert.match(reviewerRequest.task, /Candidate 2 \(second\)/);
		const applierRequest = requests.find((request) => request.agent === "applier");
		assert.ok(applierRequest);
		assert.match(applierRequest.task, /Candidate 1 \(first\) failed/);
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
