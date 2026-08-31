import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyLineupOverrides, executeBestOfNPrompt, MAX_BEST_OF_N_REQUESTS } from "../best-of-n.ts";
import { captureBestOfNWorktreeChanges, createBestOfNWorktreeManager } from "../best-of-n-worktree.ts";
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

function createEventPi() {
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
				return () => bus.set(channel, (bus.get(channel) ?? []).filter((entry) => entry !== handler));
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

function emitResponse(pi: any, request: any, status: "completed" | "failed" | "cancelled", text?: string, error?: string): void {
	pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
		requestId: request.requestId,
		ownerRunId: request.ownerRunId,
		nodeId: request.nodeId,
		status,
		agent: request.agent,
		model: request.model,
		...(status === "completed" ? { result: { kind: "text", text: text ?? "done" } } : {}),
		...(error ? { error } : {}),
		usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01, turns: 1, toolCalls: 1, durationMs: 100 },
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

function gitHead(cwd: string): string {
	return execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd, encoding: "utf8" }).trim();
}

function commitTrackedFile(cwd: string, content: string, message: string): string {
	writeFileSync(join(cwd, "tracked.txt"), content);
	execFileSync("git", ["add", "tracked.txt"], { cwd });
	execFileSync("git", ["commit", "-qm", message], { cwd });
	return gitHead(cwd);
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

test("pins a source baseline before the first worktree and reuses it for later worktrees", () => {
	const root = createGitRepo("pi-prompt-best-of-n-pinned-base-");
	const manager = createBestOfNWorktreeManager();
	try {
		const pinnedHead = gitHead(root);
		const first = manager.create(root, "first");
		const advancedHead = commitTrackedFile(root, "advanced\n", "advance source");
		const second = manager.create(root, "second");

		assert.notEqual(advancedHead, pinnedHead);
		assert.equal(first.baseCommit, pinnedHead);
		assert.equal(second.baseCommit, pinnedHead);
		assert.equal(gitHead(first.root), pinnedHead);
		assert.equal(gitHead(second.root), pinnedHead);
	} finally {
		manager.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
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

test("rejects a Git-ignored worker source cwd before launching workers or linking a worktree", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-ignored-cwd-");
	try {
		writeFileSync(join(root, ".gitignore"), "ignored-deps/\n");
		execFileSync("git", ["add", ".gitignore"], { cwd: root });
		execFileSync("git", ["commit", "-qm", "ignore dependencies"], { cwd: root });
		const ignoredCwd = join(root, "ignored-deps", "package");
		mkdirSync(ignoredCwd, { recursive: true });
		const requests: any[] = [];
		const notifications: Array<{ message: string; type: string }> = [];
		const pi = createPi(["candidate"], requests);
		const context = createCtx(root);
		context.hasUI = true;
		context.ui.notify = (message: string, type: string) => notifications.push({ message, type });
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker", cwd: ignoredCwd }] },
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "failed");
		assert.equal(requests.length, 0);
		assert.equal(existsSync(join(root, ".git", "worktrees")), false);
		assert.equal(notifications.at(-1)?.type, "error");
		assert.match(notifications.at(-1)?.message ?? "", /ignored Git path/i);
		assert.match(notifications.at(-1)?.message ?? "", /tracked files only/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects a Git-ignored reviewer source cwd before launching workers", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-ignored-reviewer-cwd-");
	try {
		writeFileSync(join(root, ".gitignore"), "ignored-deps/\n");
		execFileSync("git", ["add", ".gitignore"], { cwd: root });
		execFileSync("git", ["commit", "-qm", "ignore dependencies"], { cwd: root });
		const ignoredCwd = join(root, "ignored-deps", "package");
		mkdirSync(ignoredCwd, { recursive: true });
		const requests: any[] = [];
		const notifications: Array<{ message: string; type: string }> = [];
		const pi = createPi(["candidate"], requests);
		const context = createCtx(root);
		context.hasUI = true;
		context.ui.notify = (message: string, type: string) => notifications.push({ message, type });
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker" }], reviewers: [{ agent: "reviewer", cwd: ignoredCwd }] },
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "failed");
		assert.equal(requests.length, 0);
		assert.equal(existsSync(join(root, ".git", "worktrees")), false);
		assert.equal(notifications.at(-1)?.type, "error");
		assert.match(notifications.at(-1)?.message ?? "", /ignored Git path/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects an assume-unchanged tracked source edit before launching workers", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-assume-unchanged-");
	try {
		execFileSync("git", ["update-index", "--assume-unchanged", "tracked.txt"], { cwd: root });
		writeFileSync(join(root, "tracked.txt"), "hidden dirty\n");
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
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects a skip-worktree tracked source edit before launching workers", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-skip-worktree-");
	try {
		execFileSync("git", ["update-index", "--skip-worktree", "tracked.txt"], { cwd: root });
		writeFileSync(join(root, "tracked.txt"), "hidden dirty\n");
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
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("allows untracked bridge runtime state under .pi/subagents", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-runtime-state-");
	try {
		mkdirSync(join(root, ".pi", "subagents"), { recursive: true });
		writeFileSync(join(root, ".pi", "subagents", "run-state.json"), "{}\n");
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
		assert.equal(result, "completed");
		assert.equal(requests.length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects untracked source files outside bridge runtime state before launching workers", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-untracked-");
	try {
		writeFileSync(join(root, "scratch.txt"), "untracked\n");
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
					writeFileSync(join(data.cwd, "final-marker.txt"), "applied\n");
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
		assert.equal(existsSync(join(root, "final-marker.txt")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("aborts before final applier when a source baseline advances after workers finish", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-final-drift-");
	try {
		const requests: any[] = [];
		const notifications: Array<{ message: string; type: string }> = [];
		let advanced = false;
		const pi = createPi(["candidate", "final"], requests, [], [], (data) => {
			if (data.agent === "worker" && !advanced) {
				advanced = true;
				commitTrackedFile(root, "advanced\n", "advance source");
			}
		});
		const context = createCtx(root);
		context.hasUI = true;
		context.ui.notify = (message: string, type: string) => notifications.push({ message, type });
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker" }], finalApplier: { agent: "applier" } },
			args: [],
			currentModel: context.model,
		});

		assert.equal(result, "failed");
		assert.deepEqual(requests.map((request) => request.agent), ["worker"]);
		assert.equal(pi.customMessages.length, 0);
		assert.equal(notifications.at(-1)?.type, "error");
		assert.match(notifications.at(-1)?.message ?? "", /source baseline.*changed|HEAD.*changed|drift/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("aborts before final applier when the separate final target advances after workers finish", async () => {
	const workerRoot = createGitRepo("pi-prompt-best-of-n-final-target-worker-");
	const finalRoot = createGitRepo("pi-prompt-best-of-n-final-target-drift-");
	try {
		const requests: any[] = [];
		const notifications: Array<{ message: string; type: string }> = [];
		let advanced = false;
		const pi = createPi(["candidate", "final"], requests, [], [], (data) => {
			if (data.agent === "worker" && !advanced) {
				advanced = true;
				commitTrackedFile(finalRoot, "advanced final target\n", "advance final target");
			}
		});
		const context = createCtx(workerRoot);
		context.cwd = realpathSync(tmpdir());
		context.hasUI = true;
		context.ui.confirm = async () => true;
		context.ui.notify = (message: string, type: string) => notifications.push({ message, type });
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: { ...basePrompt, cwd: finalRoot },
			config: { workers: [{ agent: "worker", cwd: workerRoot }], finalApplier: { agent: "applier", cwd: workerRoot } },
			args: [],
			currentModel: context.model,
		});

		assert.equal(result, "failed");
		assert.deepEqual(requests.map((request) => request.agent), ["worker"]);
		assert.equal(pi.customMessages.length, 0);
		assert.equal(notifications.at(-1)?.type, "error");
		assert.match(notifications.at(-1)?.message ?? "", /source baseline.*changed|HEAD.*changed|drift/i);
	} finally {
		rmSync(finalRoot, { recursive: true, force: true });
		rmSync(workerRoot, { recursive: true, force: true });
	}
});

test("runs final applier in the context cwd when source is unchanged and final slot has a cwd", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-final-target-");
	try {
		writeFileSync(join(root, ".gitignore"), "applier-slot/\n");
		execFileSync("git", ["add", ".gitignore"], { cwd: root });
		execFileSync("git", ["commit", "-qm", "ignore applier slot"], { cwd: root });
		const finalSlotCwd = join(root, "applier-slot");
		mkdirSync(finalSlotCwd);

		const requests: any[] = [];
		const pi = createPi(["candidate", "final answer"], requests);
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker" }], finalApplier: { agent: "applier", cwd: finalSlotCwd } },
			args: [],
			currentModel: context.model,
		});

		assert.equal(result, "completed");
		assert.deepEqual(requests.map((request) => request.agent), ["worker", "applier"]);
		assert.equal(requests[1].cwd, realpathSync(root));
		assert.notEqual(requests[1].cwd, realpathSync(finalSlotCwd));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("binds final applier to the canonical target across a symlink retarget", async () => {
	const workerRoot = createGitRepo("pi-prompt-best-of-n-final-target-link-worker-");
	const finalRootA = createGitRepo("pi-prompt-best-of-n-final-target-link-a-");
	const finalRootB = createGitRepo("pi-prompt-best-of-n-final-target-link-b-");
	const linkRoot = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-final-target-link-"));
	const finalLink = join(linkRoot, "target");
	symlinkSync(finalRootA, finalLink);
	try {
		const requests: any[] = [];
		const pi = createPi(["candidate", "final answer"], requests, [], [], (data) => {
			if (data.agent === "worker") {
				rmSync(finalLink, { force: true });
				symlinkSync(finalRootB, finalLink);
			}
			if (data.agent === "applier") writeFileSync(join(data.cwd, "final-applier-marker.txt"), "applied\n");
		});
		const context = createCtx(workerRoot);
		context.cwd = realpathSync(tmpdir());
		context.hasUI = true;
		context.ui.confirm = async () => true;
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: { ...basePrompt, cwd: finalLink },
			config: { workers: [{ agent: "worker", cwd: workerRoot }], finalApplier: { agent: "applier", cwd: finalRootB } },
			args: [],
			currentModel: context.model,
		});

		assert.equal(result, "completed");
		assert.deepEqual(requests.map((request) => request.agent), ["worker", "applier"]);
		assert.equal(requests[1].cwd, realpathSync(finalRootA));
		assert.equal(existsSync(join(finalRootA, "final-applier-marker.txt")), true);
		assert.equal(existsSync(join(finalRootB, "final-applier-marker.txt")), false);
	} finally {
		rmSync(linkRoot, { recursive: true, force: true });
		rmSync(finalRootB, { recursive: true, force: true });
		rmSync(finalRootA, { recursive: true, force: true });
		rmSync(workerRoot, { recursive: true, force: true });
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

test("preserves worker diff when final applier fails and removes the finished worktree", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-final-fail-diff-");
	try {
		const requests: any[] = [];
		const pi = createPi(["candidate"], requests, [], ["applier"], (data) => {
			if (data.agent === "worker") writeFileSync(join(data.cwd, "candidate-marker.txt"), "candidate change\n");
		});
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
		const workerRequest = requests.find((request) => request.agent === "worker");
		assert.ok(workerRequest);
		assert.equal(existsSync(workerRequest.cwd), false);
		assert.equal(pi.customMessages.length, 1);
		const message = pi.customMessages[0] as any;
		assert.equal(message.customType, PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE);
		assert.equal(message.details.changed, false);
		assert.doesNotMatch(message.content, /run-state/);
		assert.match(message.content, /candidate-marker\.txt/);
		assert.match(message.content, /diff --git/);
		assert.match(message.content, /new file mode/);
		assert.match(message.content, /\+candidate change/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("preserves worker diff without a final applier and reports target changed false", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-no-final-diff-");
	try {
		const requests: any[] = [];
		const pi = createPi(["candidate"], requests, [], [], (data) => {
			if (data.agent !== "worker") return;
			writeFileSync(join(data.cwd, "candidate-marker.txt"), "candidate change\n");
			mkdirSync(join(data.cwd, ".pi", "subagents"), { recursive: true });
			writeFileSync(join(data.cwd, ".pi", "subagents", "run-state.json"), "bridge runtime\n");
		});
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker" }] },
			args: [],
			currentModel: context.model,
		});

		assert.equal(result, "completed");
		assert.equal(requests.length, 1);
		assert.equal(existsSync(requests[0].cwd), false);
		assert.equal(pi.customMessages.length, 1);
		const message = pi.customMessages[0] as any;
		assert.equal(message.details.changed, false);
		assert.doesNotMatch(message.content, /run-state/);
		assert.match(message.content, /candidate-marker\.txt/);
		assert.match(message.content, /diff --git/);
		assert.match(message.content, /\+candidate change/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("preserves committed worker diff using the base-to-head fallback", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-committed-worker-");
	try {
		const requests: any[] = [];
		const pi = createPi(["candidate"], requests, [], [], (data) => {
			if (data.agent !== "worker") return;
			const base = gitHead(data.cwd);
			writeFileSync(join(data.cwd, "tracked.txt"), "committed candidate\n");
			execFileSync("git", ["add", "tracked.txt"], { cwd: data.cwd });
			execFileSync("git", ["commit", "-qm", "worker candidate"], { cwd: data.cwd });
			execFileSync("git", ["checkout", base, "--", "tracked.txt"], { cwd: data.cwd });
		});
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker" }] },
			args: [],
			currentModel: context.model,
		});

		assert.equal(result, "completed");
		assert.equal(pi.customMessages.length, 1);
		const message = pi.customMessages[0] as any;
		assert.equal(message.details.changed, false);
		assert.doesNotMatch(message.content, /run-state/);
		assert.match(message.content, /tracked\.txt/);
		assert.match(message.content, /committed candidate/);
		assert.match(message.content, /diff --git/);
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

test("preserves candidate diff when a worker edits then fails", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-failed-candidate-");
	try {
		const requests: any[] = [];
		const pi = createPi(["unused"], requests, [], ["worker"], (data) => {
			if (data.agent === "worker") writeFileSync(join(data.cwd, "failed-marker.txt"), "failed candidate\n");
		});
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
		assert.equal(requests.length, 1);
		assert.equal(existsSync(requests[0].cwd), false);
		assert.equal(pi.customMessages.length, 1);
		const message = pi.customMessages[0] as any;
		assert.equal(message.details.changed, false);
		assert.doesNotMatch(message.content, /run-state/);
		assert.match(message.content, /failed-marker/);
		assert.match(message.content, /failed candidate/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("redacts secret-like candidate values at the worktree capture boundary", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-secret-capture-");
	const oldAssignment = "synthetic-old-assignment-7f31";
	const newAssignment = "synthetic-new-assignment-8a42";
	const oldJsonToken = "synthetic-old-json-token-9b53";
	const newJsonToken = "synthetic-new-json-token-ac64";
	const oldStripeSecretKey = "synthetic-old-stripe-secret-key-11aa";
	const newStripeSecretKey = "synthetic-new-stripe-secret-key-22bb";
	const oldAwsSecretAccessKey = "synthetic-old-aws-secret-access-key-33cc";
	const newAwsSecretAccessKey = "synthetic-new-aws-secret-access-key-44dd";
	const oldGoogleApiKey = "synthetic-old-google-api-key-55ee";
	const newGoogleApiKey = "synthetic-new-google-api-key-66ff";
	const oldDatabasePassword = "synthetic-old-database-password-77aa";
	const newDatabasePassword = "synthetic-new-database-password-88bb";
	const oldJwtSecret = "synthetic-old-jwt-secret-99cc";
	const newJwtSecret = "synthetic-new-jwt-secret-aadd";
	const oldYamlPassword = "synthetic-old-yaml-password-bd75";
	const newYamlPassword = "synthetic-new-yaml-password-ce86";
	const oldBearer = "synthetic-old-bearer-df97";
	const newBearer = "synthetic-new-bearer-ea08";
	const oldUrlCredential = "synthetic-old-url-credential-fb19";
	const newUrlCredential = "synthetic-new-url-credential-0c2a";
	const oldContextToken = "synthetic-context-token-1d3b";
	const newContextToken = "synthetic-context-token-2e4c";
	const oldPem = "synthetic-old-pem-material-3f5d";
	const newPem = "synthetic-new-pem-material-4a6e";
	const envSecret = "synthetic-env-payload-5b7f";
	const deletedEnvSecret = "synthetic-deleted-env-payload-9fb3";
	const credentialsSecret = "synthetic-credentials-payload-6c80";
	const secretsSecret = "synthetic-secrets-payload-7d91";
	const pemFileSecret = "synthetic-pem-file-payload-8ea2";
	const candidateFile = join(root, "candidate-config.txt");
	writeFileSync(candidateFile, [
		`api_key: ${oldAssignment}`,
		`json: {"token":"${oldJsonToken}"}`,
		`STRIPE_SECRET_KEY: ${oldStripeSecretKey}`,
		`AWS_SECRET_ACCESS_KEY=${oldAwsSecretAccessKey}`,
		`GOOGLE_API_KEY: ${oldGoogleApiKey}`,
		`DATABASE_PASSWORD: ${oldDatabasePassword}`,
		`JWT_SECRET=${oldJwtSecret}`,
		`yaml_password: ${oldYamlPassword}`,
		`authorization: Bearer ${oldBearer}`,
		`connection_url: https://synthetic-user:${oldUrlCredential}@example.invalid/service`,
		`unchanged_token: ${oldContextToken}`,
		"-----BEGIN PRIVATE KEY-----",
		oldPem,
		"-----END PRIVATE KEY-----",
		"stable context",
	].join("\n") + "\n");
	writeFileSync(join(root, ".env"), `context payload ${envSecret}\ndeleted payload ${deletedEnvSecret}\nold line\n`);
	execFileSync("git", ["add", "candidate-config.txt", ".env"], { cwd: root });
	execFileSync("git", ["commit", "-qm", "add candidate config"], { cwd: root });
	const manager = createBestOfNWorktreeManager();
	try {
		const workspace = manager.create(root, "secret-capture");
		writeFileSync(join(workspace.root, "candidate-config.txt"), [
			`api_key: ${newAssignment}`,
			`json: {"token":"${newJsonToken}"}`,
			`STRIPE_SECRET_KEY: ${newStripeSecretKey}`,
			`AWS_SECRET_ACCESS_KEY=${newAwsSecretAccessKey}`,
			`GOOGLE_API_KEY: ${newGoogleApiKey}`,
			`DATABASE_PASSWORD: ${newDatabasePassword}`,
			`JWT_SECRET=${newJwtSecret}`,
			`yaml_password: ${newYamlPassword}`,
			`authorization: Bearer ${newBearer}`,
			`connection_url: https://synthetic-user:${newUrlCredential}@example.invalid/service`,
			`unchanged_token: ${newContextToken}`,
			"-----BEGIN PRIVATE KEY-----",
			newPem,
			"-----END PRIVATE KEY-----",
			"stable context",
		].join("\n") + "\n");
		execFileSync("git", ["mv", ".env", "config.txt"], { cwd: workspace.root });
		writeFileSync(join(workspace.root, "config.txt"), [
			`context payload ${envSecret}`,
			`deleted payload ${deletedEnvSecret}`,
			"old line",
			"new line",
		].join("\n") + "\n");
		writeFileSync(join(workspace.root, "credentials.json"), `unlabelled credentials payload ${credentialsSecret}\n`);
		writeFileSync(join(workspace.root, "secrets.yaml"), `unlabelled secrets payload: ${secretsSecret}\n`);
		writeFileSync(join(workspace.root, "private.pem"), `-----BEGIN PRIVATE KEY-----\n${pemFileSecret}\n-----END PRIVATE KEY-----\n`);

		const changes = await captureBestOfNWorktreeChanges(workspace);
		assert.ok(changes);
		const rawValues = [
			oldAssignment, newAssignment, oldJsonToken, newJsonToken, oldYamlPassword, newYamlPassword,
			oldStripeSecretKey, newStripeSecretKey, oldAwsSecretAccessKey, newAwsSecretAccessKey,
			oldGoogleApiKey, newGoogleApiKey, oldDatabasePassword, newDatabasePassword, oldJwtSecret, newJwtSecret,
			oldBearer, newBearer, oldUrlCredential, newUrlCredential, oldContextToken, newContextToken,
			oldPem, newPem, envSecret, deletedEnvSecret, credentialsSecret, secretsSecret, pemFileSecret,
		];
		for (const rawValue of rawValues) {
			assert.equal(changes.stat.includes(rawValue), false, `raw secret leaked in stat: ${rawValue}`);
			assert.equal(changes.diff.includes(rawValue), false, `raw secret leaked in diff: ${rawValue}`);
		}
		assert.match(changes.diff, /\[REDACTED\]/);
	} finally {
		manager.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("does not forward secret-like candidate values to final-applier task evidence", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-secret-forwarding-");
	const rawValues = [
		"synthetic-forward-api-key-1a2b",
		"synthetic-forward-token-2b3c",
		"synthetic-forward-password-3c4d",
		"synthetic-forward-bearer-4d5e",
		"synthetic-forward-url-credential-5e6f",
		"synthetic-forward-pem-6f70",
		"synthetic-forward-env-7081",
		"synthetic-forward-stripe-secret-key-8192",
		"synthetic-forward-aws-secret-access-key-92a3",
		"synthetic-forward-google-api-key-a3b4",
		"synthetic-forward-jwt-secret-b4c5",
	];
	try {
		const requests: any[] = [];
		const pi = createPi(["candidate", "final"], requests, [], [], (data) => {
			if (data.agent !== "worker") return;
			writeFileSync(join(data.cwd, "candidate-secrets.txt"), [
				`api_key: ${rawValues[0]}`,
				`token: ${rawValues[1]}`,
				`password: ${rawValues[2]}`,
				`authorization: Bearer ${rawValues[3]}`,
				`url: https://synthetic-user:${rawValues[4]}@example.invalid/forward`,
				`STRIPE_SECRET_KEY: ${rawValues[7]}`,
				`AWS_SECRET_ACCESS_KEY=${rawValues[8]}`,
				`GOOGLE_API_KEY: ${rawValues[9]}`,
				`JWT_SECRET=${rawValues[10]}`,
				"-----BEGIN PRIVATE KEY-----",
				rawValues[5],
				"-----END PRIVATE KEY-----",
			].join("\n") + "\n");
			writeFileSync(join(data.cwd, ".env"), `UNLABELLED_ENV_PAYLOAD=${rawValues[6]}\n`);
		});
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker" }], finalApplier: { agent: "applier" } },
			args: [],
			currentModel: context.model,
		});

		assert.equal(result, "completed");
		const applierRequest = requests.find((request) => request.agent === "applier");
		assert.ok(applierRequest);
		for (const rawValue of rawValues) assert.equal(applierRequest.task.includes(rawValue), false, `raw secret leaked to final task: ${rawValue}`);
		assert.match(applierRequest.task, /\[REDACTED\]/);
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
			const request = requests.find((candidate) => candidate.requestId === data.requestId);
			if (request) setTimeout(() => emitResponse(pi, request, "cancelled"), 0);
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
			const request = requests.find((candidate) => candidate.requestId === data.requestId);
			if (request) setTimeout(() => emitResponse(pi, request, "cancelled"), 0);
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

test("waits for delayed terminal cancellation before cleaning best-of-N worktrees", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-cancel-drain-");
	try {
		const requests: any[] = [];
		const controller = new AbortController();
		const pi = createEventPi();
		let abortScheduled = false;
		let existedBeforeTerminal = false;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data: any) => {
			requests.push(data);
			emitStarted(pi, data);
			if (requests.length === 1) {
				writeFileSync(join(data.cwd, "candidate-marker.txt"), "completed candidate\n");
				emitResponse(pi, data, "completed", "candidate one");
				return;
			}
			if (!abortScheduled) {
				abortScheduled = true;
				setTimeout(() => controller.abort(), 0);
			}
		});
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data: any) => {
			const request = requests.find((candidate) => candidate.requestId === data.requestId);
			assert.ok(request);
			setTimeout(() => {
				existedBeforeTerminal = existsSync(request.cwd);
				emitResponse(pi, request, "cancelled");
			}, 30);
		});
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker", count: 2 }], finalApplier: { agent: "applier" } },
			args: [],
			currentModel: context.model,
			signal: controller.signal,
		});

		assert.equal(result, "cancelled");
		assert.equal(requests.length, 2);
		assert.equal(existedBeforeTerminal, true);
		assert.equal(requests.every((request) => !existsSync(request.cwd)), true);
		assert.equal(pi.customMessages.length, 1);
		const message = pi.customMessages[0] as any;
		assert.equal(message.details.changed, false);
		assert.doesNotMatch(message.content, /run-state/);
		assert.match(message.content, /candidate-marker\.txt/);
		assert.match(message.content, /\+completed candidate/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("keeps a drain-timed-out active worktree and reports its exact path", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-drain-timeout-");
	const previousTimeout = process.env.PI_PROMPT_SUBAGENT_CANCEL_DRAIN_TIMEOUT_MS;
	let preservedTempRoot: string | undefined;
	try {
		process.env.PI_PROMPT_SUBAGENT_CANCEL_DRAIN_TIMEOUT_MS = "25";
		const requests: any[] = [];
		const notifications: Array<{ message: string; type: string }> = [];
		const controller = new AbortController();
		const pi = createEventPi();
		let abortScheduled = false;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data: any) => {
			requests.push(data);
			emitStarted(pi, data);
			if (requests.length === 1) {
				writeFileSync(join(data.cwd, "candidate-marker.txt"), "completed candidate\n");
				emitResponse(pi, data, "completed", "candidate one");
				return;
			}
			if (!abortScheduled) {
				abortScheduled = true;
				setTimeout(() => controller.abort(), 0);
			}
		});
		const context = createCtx(root);
		context.hasUI = true;
		context.ui.notify = (message: string, type: string) => notifications.push({ message, type });

		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker", count: 2 }], finalApplier: { agent: "applier" } },
			args: [],
			currentModel: context.model,
			signal: controller.signal,
		});

		assert.equal(result, "cancelled");
		assert.equal(requests.length, 2);
		const finishedWorktree = requests[0].cwd;
		const activeWorktree = requests[1].cwd;
		preservedTempRoot = dirname(activeWorktree);
		assert.equal(existsSync(finishedWorktree), false);
		assert.equal(existsSync(activeWorktree), true);
		assert.equal(existsSync(preservedTempRoot), true);
		assert.equal(pi.customMessages.length, 1);
		assert.match((pi.customMessages[0] as any).content, /candidate-marker\.txt/);
		const warning = notifications.find((entry) => entry.type === "warning" && entry.message.includes(activeWorktree));
		assert.ok(warning);
		assert.match(warning.message, /timed out/i);
	} finally {
		if (previousTimeout === undefined) delete process.env.PI_PROMPT_SUBAGENT_CANCEL_DRAIN_TIMEOUT_MS;
		else process.env.PI_PROMPT_SUBAGENT_CANCEL_DRAIN_TIMEOUT_MS = previousTimeout;
		if (preservedTempRoot) rmSync(preservedTempRoot, { recursive: true, force: true });
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

test("uses the first available model from a comma-separated slot model list", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-slot-model-list-"));
	try {
		const requests: any[] = [];
		const pi = createPi(["candidate"], requests);
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: { ...basePrompt, content: "Base candidate task." },
			config: { workers: [{ agent: "worker", model: "anthropic/missing, openai/configured" }] },
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "completed");
		assert.equal(requests.length, 1);
		assert.equal(requests[0].model, "openai/configured");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("caps accumulated worker evidence before reviewer requests exceed one MiB", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-evidence-cap-"));
	try {
		const requests: any[] = [];
		const largeOutput = "x".repeat(600 * 1024);
		const pi = createPi([largeOutput, largeOutput, "review"], requests);
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker", count: 2 }], reviewers: [{ agent: "reviewer" }] },
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "completed");
		const reviewerRequest = requests.find((request) => request.agent === "reviewer");
		assert.ok(reviewerRequest);
		assert.ok(Buffer.byteLength(reviewerRequest.task, "utf8") < 1024 * 1024);
		assert.match(reviewerRequest.task, /bestOfN evidence truncated/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("caps accumulated worker evidence before a final-applier request exceeds one MiB", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-final-evidence-cap-"));
	try {
		const requests: any[] = [];
		const largeOutput = "x".repeat(600 * 1024);
		const pi = createPi([largeOutput, largeOutput, "final"], requests);
		const context = createCtx(root);
		const result = await executeBestOfNPrompt({
			pi,
			ctx: context,
			prompt: basePrompt,
			config: { workers: [{ agent: "worker", count: 2 }], finalApplier: { agent: "applier" } },
			args: [],
			currentModel: context.model,
		});
		assert.equal(result, "completed");
		const applierRequest = requests.find((request) => request.agent === "applier");
		assert.ok(applierRequest);
		assert.ok(Buffer.byteLength(applierRequest.task, "utf8") < 1024 * 1024);
		assert.match(applierRequest.task, /bestOfN evidence truncated/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bounds oversized candidate Git output without converting it into a capture error", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-large-capture-");
	const manager = createBestOfNWorktreeManager();
	try {
		const workspace = manager.create(root, "large-capture");
		writeFileSync(join(workspace.root, "tracked.txt"), `candidate\n${"x".repeat(2 * 1024 * 1024)}\n`);

		const changes = await captureBestOfNWorktreeChanges(workspace);
		assert.ok(changes);
		assert.equal(changes.truncated, true);
		assert.ok(Buffer.byteLength(changes.stat, "utf8") <= 64 * 1024);
		assert.ok(Buffer.byteLength(changes.diff, "utf8") <= 512 * 1024);
		assert.match(`${changes.stat}\n${changes.diff}`, /bestOfN candidate change evidence truncated/i);
	} finally {
		manager.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("bounds oversized untracked listings and aggregate candidate evidence", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-untracked-capture-");
	const manager = createBestOfNWorktreeManager();
	try {
		const workspace = manager.create(root, "untracked-capture");
		const longDirectory = join(
			workspace.root,
			"untracked",
			"a".repeat(200),
			"b".repeat(200),
			"c".repeat(200),
		);
		mkdirSync(longDirectory, { recursive: true });
		const fileCount = 1_800;
		const content = `candidate\n${"x".repeat(8 * 1024)}\n`;
		let listingBytes = 0;
		for (let index = 0; index < fileCount; index += 1) {
			const relativePath = join("untracked", "a".repeat(200), "b".repeat(200), "c".repeat(200), `candidate-${String(index).padStart(4, "0")}.txt`);
			listingBytes += Buffer.byteLength(`${relativePath}\0`, "utf8");
			writeFileSync(join(longDirectory, `candidate-${String(index).padStart(4, "0")}.txt`), content);
		}
		assert.ok(listingBytes > 1024 * 1024);

		const changes = await captureBestOfNWorktreeChanges(workspace);
		assert.ok(changes);
		assert.equal(changes.truncated, true);
		assert.ok(Buffer.byteLength(changes.stat, "utf8") <= 64 * 1024);
		assert.ok(Buffer.byteLength(changes.diff, "utf8") <= 512 * 1024);
		assert.match(`${changes.stat}\n${changes.diff}`, /bestOfN candidate change evidence truncated/i);
	} finally {
		manager.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});

test("does not run configured textconv while capturing an untracked candidate", async () => {
	const root = createGitRepo("pi-prompt-best-of-n-no-textconv-");
	const scriptRoot = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-textconv-script-"));
	try {
		const marker = join(scriptRoot, "textconv-ran");
		const script = join(scriptRoot, "textconv.sh");
		writeFileSync(script, `#!/bin/sh\nprintf ran > ${marker}\ncat\n`);
		chmodSync(script, 0o755);
		execFileSync("git", ["config", "diff.candidate.textconv", script], { cwd: root });
		writeFileSync(join(root, ".gitattributes"), "untracked-candidate.txt diff=candidate\n");
		execFileSync("git", ["add", ".gitattributes"], { cwd: root });
		execFileSync("git", ["commit", "-qm", "configure candidate diff driver"], { cwd: root });

		const manager = createBestOfNWorktreeManager();
		try {
			const workspace = manager.create(root, "no-textconv");
			writeFileSync(join(workspace.root, "untracked-candidate.txt"), "candidate text\n");
			const changes = await captureBestOfNWorktreeChanges(workspace);
			assert.ok(changes);
			assert.equal(existsSync(marker), false);
		} finally {
			manager.cleanup();
		}
	} finally {
		rmSync(scriptRoot, { recursive: true, force: true });
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
