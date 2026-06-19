import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptModelExtension from "../index.js";

const SONNET = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
const MODELS = [SONNET];

interface FakeCommand {
	description?: string;
	handler?: (args: string, ctx: any) => Promise<void>;
	source?: string;
	name?: string;
	sourceInfo?: { path?: string };
}

class FakePi {
	commands = new Map<string, FakeCommand>();
	renderers = new Map<string, unknown>();
	hooks = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();
	notifications: Array<{ message: string; type: string }> = [];
	messages: any[] = [];
	userMessages: string[] = [];
	setModelCalls: any[] = [];
	setThinkingLevelCalls: any[] = [];
	waitForIdleCalls = 0;
	customCalls: Array<{ options?: unknown }> = [];
	customResults: unknown[] = [];
	customComponents: unknown[] = [];
	currentModel = SONNET;

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
	async setModel(model: any) { this.setModelCalls.push(model); this.currentModel = model; return true; }
	getThinkingLevel() { return "medium" as const; }
	setThinkingLevel(level: any) { this.setThinkingLevelCalls.push(level); }
	sendUserMessage(content: string) { this.userMessages.push(content); }
	sendMessage(message: any) { this.messages.push(message); }
}

async function withTempHome(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-index-dry-run-tui-"));
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
		get model() { return pi.currentModel; },
		modelRegistry: {
			find(provider: string, id: string) { return MODELS.find((model) => model.provider === provider && model.id === id); },
			getAll() { return MODELS; },
			getAvailable() { return MODELS; },
			async getApiKeyAndHeaders() { return { ok: true, apiKey: "token" }; },
			isUsingOAuth() { return false; },
		},
		hasUI: mode === "tui" || mode === "rpc",
		ui: {
			notify(message: string, type: string) { pi.notifications.push({ message, type }); },
			writeStderr() {},
			setStatus() {},
			setWorkingMessage() {},
			onTerminalInput() { return () => {}; },
			theme: { fg(_token: string, text: string) { return text; } },
			async custom(factory: (...args: any[]) => unknown, options?: unknown) {
				pi.customCalls.push({ options });
				const component = factory({}, this.theme, {}, (value: unknown) => value);
				pi.customComponents.push(component);
				return pi.customResults.length ? pi.customResults.shift() : component;
			},
		},
		isIdle() { return false; },
		async waitForIdle() { pi.waitForIdleCalls++; },
		sessionManager: { getLeafId() { return "root"; }, getBranch() { return []; } },
		async navigateTree() { return { cancelled: false }; },
	};
}

function writePrompt(cwd: string, name: string, body: string) {
	mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "prompts", `${name}.md`), body);
}

function assertNoExecutionSideEffects(pi: FakePi) {
	assert.equal(pi.messages.length, 0);
	assert.equal(pi.userMessages.length, 0);
	assert.equal(pi.setModelCalls.length, 0);
	assert.equal(pi.setThinkingLevelCalls.length, 0);
	assert.equal(pi.waitForIdleCalls, 0);
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

async function setup(mode: "tui" | "rpc" | "print" | "json", run: (cwd: string, pi: FakePi, ctx: any) => Promise<void>) {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		const pi = new FakePi();
		const ctx = createContext(cwd, pi, mode);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);
		await run(cwd, pi, ctx);
	});
}

test("TUI mode /dry-run-prompt with no template opens searchable picker instead of usage error", async () => {
	await setup("tui", async (cwd, pi, ctx) => {
		writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nReview $@");
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("dry-run-prompt")!.handler!("", ctx);

		assert.equal(pi.customCalls.length, 1);
		assert.equal(pi.notifications.length, 0);
		assertNoExecutionSideEffects(pi);
	});
});

test("TUI mode /print-prompt with no template opens picker instead of usage error", async () => {
	await setup("tui", async (cwd, pi, ctx) => {
		writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nReview $@");
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("print-prompt")!.handler!("", ctx);

		assert.equal(pi.customCalls.length, 1);
		assert.equal(pi.notifications.length, 0);
		assertNoExecutionSideEffects(pi);
	});
});

test("TUI mode command with template opens inspector automatically and does not write stdout unless --plain is present", async () => {
	await setup("tui", async (cwd, pi, ctx) => {
		writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nReview $@");
		await pi.emit("session_start", {}, ctx);

		const output = await captureStdout(() => pi.commands.get("print-prompt")!.handler!("review src/server.ts", ctx));

		assert.equal(output, "");
		assert.equal(pi.customCalls.length, 1);
		assertNoExecutionSideEffects(pi);
	});
});

test("TUI picker selection uses catalog template names directly instead of reparsing them as CLI args", async () => {
	await setup("tui", async (cwd, pi, ctx) => {
		writePrompt(cwd, "other", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nWRONG BODY");
		writePrompt(cwd, "other --show-skills", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nRIGHT BODY");
		await pi.emit("session_start", {}, ctx);
		pi.customResults.push({ action: "selected", templateName: "other --show-skills" });

		await pi.commands.get("dry-run-prompt")!.handler!("", ctx);

		assert.equal(pi.customCalls.length, 2);
		const inspector = pi.customComponents.at(-1) as { render(width: number): string[] };
		const rendered = inspector.render(100).join("\n");
		assert.match(rendered, /Prompt dry-run: other --show-skills/);
		assert.match(rendered, /RIGHT BODY/);
		assert.doesNotMatch(rendered, /WRONG BODY/);
		assertNoExecutionSideEffects(pi);
	});
});

test("inspector back opens picker and selected template opens the next inspector", async () => {
	await setup("tui", async (cwd, pi, ctx) => {
		writePrompt(cwd, "first", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nFirst body");
		writePrompt(cwd, "second", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nSecond body");
		await pi.emit("session_start", {}, ctx);
		pi.customResults.push({ action: "back" }, { action: "selected", templateName: "second" });

		await pi.commands.get("print-prompt")!.handler!("first", ctx);

		assert.equal(pi.customCalls.length, 3);
		const inspector = pi.customComponents.at(-1) as { render(width: number): string[] };
		const rendered = inspector.render(100).join("\n");
		assert.match(rendered, /Prompt dry-run: second/);
		assert.match(rendered, /Second body/);
		assertNoExecutionSideEffects(pi);
	});
});

test("--plain forces stdout/plain path in TUI mode and does not call ctx.ui.custom", async () => {
	await setup("tui", async (cwd, pi, ctx) => {
		writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nReview $@");
		await pi.emit("session_start", {}, ctx);

		const output = await captureStdout(() => pi.commands.get("print-prompt")!.handler!("review --plain src/server.ts", ctx));

		assert.equal(pi.customCalls.length, 0);
		assert.match(output, /# Prompt dry-run: review/);
		assert.match(output, /Review src\/server\.ts/);
		assertNoExecutionSideEffects(pi);
	});
});

test("non-TUI modes keep missing-template error with guidance to use Pi TUI or pass a template", async () => {
	for (const mode of ["rpc", "print", "json"] as const) {
		await setup(mode, async (_cwd, pi, ctx) => {
			await pi.commands.get("dry-run-prompt")!.handler!("", ctx);
			assert.equal(pi.customCalls.length, 0);
			assert.equal(pi.notifications.at(-1)?.type, "error");
			assert.match(pi.notifications.at(-1)?.message ?? "", /Run in Pi TUI mode.*pick from templates.*pass a template name/i);
			assertNoExecutionSideEffects(pi);
		});
	}
});

test("non-TUI --tui with custom UI available falls back to stdout instead of opening custom TUI", async () => {
	await setup("rpc", async (cwd, pi, ctx) => {
		writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nReview $@");
		await pi.emit("session_start", {}, ctx);

		const output = await captureStdout(() => pi.commands.get("print-prompt")!.handler!("review --tui file.ts", ctx));

		assert.equal(pi.customCalls.length, 0);
		assert.match(output, /# Prompt dry-run: review/);
		assert.equal(pi.notifications.at(-1)?.type, "warning");
		assert.match(pi.notifications.at(-1)?.message ?? "", /without Pi TUI custom UI.*stdout/i);
		assertNoExecutionSideEffects(pi);
	});
});

test("unsupported dry-run results in TUI mode show a diagnostic and do not open an inspector", async () => {
	await setup("tui", async (cwd, pi, ctx) => {
		writePrompt(cwd, "det", "---\nrun: printf ok\n---\nignored");
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("print-prompt")!.handler!("det", ctx);

		assert.equal(pi.customCalls.length, 0);
		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.match(pi.notifications.at(-1)?.message ?? "", /deterministic prompts is not supported/i);
		assertNoExecutionSideEffects(pi);
	});
});
