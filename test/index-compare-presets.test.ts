import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptModelExtension from "../index.js";

const SONNET = { provider: "anthropic", id: "claude-sonnet-4-20250514" };

interface FakeCommand {
	description?: string;
	handler?: (args: string, ctx: any) => Promise<void>;
	name?: string;
}

class FakePi {
	commands = new Map<string, FakeCommand>();
	renderers = new Map<string, unknown>();
	hooks = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();
	notifications: Array<{ message: string; type: string }> = [];
	messages: any[] = [];
	userMessages: string[] = [];
	confirmCalls = 0;

	registerMessageRenderer(type: string, renderer: unknown) { this.renderers.set(type, renderer); }
	registerCommand(name: string, command: FakeCommand) { this.commands.set(name, { ...command, name }); }
	registerTool() {}
	getCommands() { return Array.from(this.commands.values()); }
	on(event: string, handler: (event: any, ctx: any) => Promise<any> | any) {
		const handlers = this.hooks.get(event) ?? [];
		handlers.push(handler);
		this.hooks.set(event, handlers);
	}
	async emit(event: string, payload: any, ctx: any) {
		for (const handler of this.hooks.get(event) ?? []) await handler(payload, ctx);
	}
	async setModel() { return true; }
	getThinkingLevel() { return "medium" as const; }
	setThinkingLevel() {}
	sendUserMessage(content: string) { this.userMessages.push(content); }
	sendMessage(message: any) { this.messages.push(message); }
}

async function withTempHome(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-index-compare-presets-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		await run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

function createContext(cwd: string, pi: FakePi, mode: "tui" | "rpc" | "print" | "json" = "tui") {
	return {
		cwd,
		mode,
		model: SONNET,
		modelRegistry: {
			find(provider: string, id: string) { return provider === SONNET.provider && id === SONNET.id ? SONNET : undefined; },
			getAll() { return [SONNET]; },
			getAvailable() { return [SONNET]; },
			async getApiKeyAndHeaders() { return { ok: true, apiKey: "test" }; },
			isUsingOAuth() { return false; },
		},
		hasUI: mode === "tui" || mode === "rpc",
		ui: {
			notify(message: string, type: string) { pi.notifications.push({ message, type }); },
			async confirm() {
				pi.confirmCalls++;
				throw new Error("compare-presets must not ask for preset approval");
			},
			writeStderr() {},
			setStatus() {},
			setWorkingMessage() {},
			onTerminalInput() { return () => {}; },
			theme: { fg(_token: string, text: string) { return text; } },
		},
		isIdle() { return false; },
		async waitForIdle() {},
		sessionManager: { getLeafId() { return "root"; }, getBranch() { return []; } },
		async navigateTree() { return { cancelled: false }; },
	};
}

async function setup(run: (cwd: string, pi: FakePi, ctx: any) => Promise<void>) {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		const pi = new FakePi();
		const ctx = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);
		await run(cwd, pi, ctx);
	});
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let output = "";
	(process.stdout.write as unknown as (chunk: unknown, encoding?: unknown, cb?: unknown) => boolean) = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
		output += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
		if (typeof encoding === "function") encoding();
		if (typeof cb === "function") cb();
		return true;
	}) as never;
	try {
		await run();
		return output;
	} finally {
		process.stdout.write = originalWrite as never;
	}
}

function writePresetFiles(root: string, cwd: string) {
	mkdirSync(join(root, ".pi", "agent"), { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(root, ".pi", "agent", "best-of-n-presets.json"), JSON.stringify({
		presets: {
			quick: {
				defaultModel: "openai/gpt-5.4",
				maxModelCalls: 2,
				workers: [{ agent: "delegate", count: 2 }],
			},
		},
	}));
	writeFileSync(join(cwd, ".pi", "best-of-n-presets.json"), JSON.stringify({
		presets: {
			strict: {
				description: "strict project preset\rspoof",
				defaultModel: "anthropic/claude-sonnet-4-20250514",
				maxModelCalls: 4,
				workers: [{ agent: "delegate", count: 2 }],
				reviewers: [{ agent: "reviewer" }],
			},
		},
	}));
}

function assertNoExecutionOrApproval(pi: FakePi) {
	assert.equal(pi.messages.length, 0);
	assert.equal(pi.userMessages.length, 0);
	assert.equal(pi.confirmCalls, 0);
}

test("/compare-presets --plain prints deterministic preset catalog details without approval", async () => {
	await setup(async (cwd, pi, ctx) => {
		const root = join(cwd, "..");
		writePresetFiles(root, cwd);

		const output = await captureStdout(() => pi.commands.get("compare-presets")!.handler!("--plain", ctx));

		assert.match(output, /^# Compare presets\n/);
		assert.match(output, /## quick/);
		assert.match(output, /- Source: user/);
		assert.match(output, /- Trust: user config; no project preset approval required\. This does not mean the preset is audited safe\./);
		assert.match(output, /- Default model: openai\/gpt-5\.4/);
		assert.match(output, /- Max model calls: 2/);
		assert.match(output, /- Workers: 2/);
		assert.match(output, /- Worker lineup: 1:2x delegate/);
		assert.match(output, /- Reviewers: 0/);
		assert.match(output, /- Reviewer lineup: none/);
		assert.match(output, /- Final applier: no/);
		assert.match(output, /- Use:\n  - Dry run \(read-only\): \/dry-run-prompt best-of-n --preset quick --plain <task>\n  - Execute \(retains evidence artifacts\): \/best-of-n --preset quick --keep-artifacts <task>\n  - Execute \(summary-only, fewer local artifacts\): \/best-of-n --preset quick <task>/);
		assert.match(output, /## strict/);
		assert.match(output, /- Source: project/);
		assert.match(output, /- Trust: project preset; approval is required for this compare cwd\/session\. Project presets can choose worker\/reviewer agents, models, counts, cost, and concurrency\./);
		assert.match(output, /- Prompt policy: prompt still owns task, cwd\/worktree, final-applier, and commit policy\./);
		assert.match(output, /- Workers: 2/);
		assert.match(output, /- Worker lineup: 1:2x delegate/);
		assert.match(output, /- Reviewers: 1/);
		assert.match(output, /- Reviewer lineup: 1:reviewer/);
		assert.match(output, /Dry run \(read-only\): \/dry-run-prompt best-of-n --preset strict --plain <task>/);
		assert.match(output, /Execute \(retains evidence artifacts\): \/best-of-n --preset strict --keep-artifacts <task>/);
		assert.match(output, /Execute \(summary-only, fewer local artifacts\): \/best-of-n --preset strict <task>/);
		assert.doesNotMatch(output, /\r/);
		assert.equal(pi.notifications.length, 0);
		assertNoExecutionOrApproval(pi);
	});
});

test("/compare-presets default path uses UI notification instead of stdout", async () => {
	await setup(async (cwd, pi, ctx) => {
		const root = join(cwd, "..");
		writePresetFiles(root, cwd);

		const output = await captureStdout(() => pi.commands.get("compare-presets")!.handler!("", ctx));

		assert.equal(output, "");
		assert.equal(pi.notifications.length, 1);
		assert.equal(pi.notifications[0]?.type, "info");
		assert.match(pi.notifications[0]?.message ?? "", /# Compare presets/);
		assert.match(pi.notifications[0]?.message ?? "", /## strict/);
		assertNoExecutionOrApproval(pi);
	});
});

test("/compare-presets surfaces malformed preset diagnostics without falling back or approving", async () => {
	await setup(async (cwd, pi, ctx) => {
		const root = join(cwd, "..");
		mkdirSync(join(root, ".pi", "agent"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "agent", "best-of-n-presets.json"), JSON.stringify({ presets: { userOnly: { workers: [{ agent: "delegate" }] } } }));
		writeFileSync(join(cwd, ".pi", "best-of-n-presets.json"), "{ not json");

		const output = await captureStdout(() => pi.commands.get("best-of-n-presets")!.handler!("--plain", ctx));

		assert.match(output, /Warning: Skipping best-of-N presets file/);
		assert.match(output, /No best-of-N compare presets found/);
		assert.doesNotMatch(output, /userOnly/);
		assertNoExecutionOrApproval(pi);
	});
});
