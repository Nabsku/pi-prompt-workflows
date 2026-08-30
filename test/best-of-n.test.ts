import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLineupOverrides, executeBestOfNPrompt, MAX_BEST_OF_N_REQUESTS } from "../best-of-n.ts";
import { PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT } from "../subagent-runtime.ts";

function createPi(responses: string[], requests: any[] = []) {
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
			result: { kind: "text", text: responses[responseIndex++] ?? "fallback" },
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
		const pi = createPi(["candidate one", "candidate two", "review findings", "final answer"]);
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
		assert.match((pi.customMessages[0] as any).content, /final answer/);
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
