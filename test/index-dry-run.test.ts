import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptModelExtension from "../index.js";

const SONNET = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
const HAIKU = { provider: "anthropic", id: "claude-haiku-4-5" };
const GPT = { provider: "openai", id: "gpt-5.2" };
const MODELS = [SONNET, HAIKU, GPT];

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
	stderr: string[] = [];
	messages: any[] = [];
	userMessages: string[] = [];
	setModelCalls: any[] = [];
	setThinkingLevelCalls: any[] = [];
	waitForIdleCalls = 0;
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
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-index-dry-run-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		await run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

function createContext(cwd: string, pi: FakePi) {
	return {
		cwd,
		get model() { return pi.currentModel; },
		modelRegistry: {
			find(provider: string, id: string) { return MODELS.find((model) => model.provider === provider && model.id === id); },
			getAll() { return MODELS; },
			getAvailable() { return MODELS; },
			async getApiKeyAndHeaders() { return { ok: true, apiKey: "token" }; },
			isUsingOAuth() { return false; },
		},
		hasUI: true,
		ui: {
			notify(message: string, type: string) { pi.notifications.push({ message, type }); },
			writeStderr(message: string) { pi.stderr.push(message); },
			setStatus() {},
			setWorkingMessage() {},
			onTerminalInput() { return () => {}; },
			theme: { fg(_token: string, text: string) { return text; } },
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

function writeSkill(cwd: string, name: string, content: string) {
	const dir = join(cwd, ".pi", "skills", name);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "SKILL.md");
	writeFileSync(path, content);
	return path;
}

function assertNoExecutionSideEffects(pi: FakePi) {
	assert.equal(pi.userMessages.length, 0);
	assert.equal(pi.setModelCalls.length, 0);
	assert.equal(pi.setThinkingLevelCalls.length, 0);
	assert.equal(pi.waitForIdleCalls, 0);
}

async function setup(run: (root: string, cwd: string, pi: FakePi, ctx: any) => Promise<void>) {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		const pi = new FakePi();
		const ctx = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);
		await run(root, cwd, pi, ctx);
	});
}

test("registers print-prompt and dry-run-prompt commands", async () => {
	await setup(async (_root, _cwd, pi) => {
		assert.equal(pi.commands.get("print-prompt")?.description, "Print the rendered prompt template without running it");
		assert.equal(pi.commands.get("dry-run-prompt")?.description, "Dry-run a prompt template and show what would be sent");
	});
});

test("missing template name reports usage error in plain command path", async () => {
	await setup(async (_root, _cwd, pi, ctx) => {
		await pi.commands.get("print-prompt")!.handler!("", ctx);
		assert.equal(pi.messages.length, 0);
		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.match(pi.notifications.at(-1)!.message, /Usage: \/print-prompt <template>/);
		assertNoExecutionSideEffects(pi);
	});
});

test("unknown template reports not found error", async () => {
	await setup(async (_root, _cwd, pi, ctx) => {
		await pi.commands.get("print-prompt")!.handler!("missing", ctx);
		assert.equal(pi.messages.length, 0);
		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.match(pi.notifications.at(-1)!.message, /Prompt "missing" not found/);
		assertNoExecutionSideEffects(pi);
	});
});

test("print-prompt sends one dry-run message with rendered content and no execution side effects", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		mkdirSync(join(cwd, ".pi", "prompt-partials"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-partials", "review-prefix.md"), "Include arg: $1");
		writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\ninclude: review-prefix.md\n---\nReview $@ now");
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("print-prompt")!.handler!("review src/server.ts", ctx);

		assert.equal(pi.messages.length, 1);
		assert.equal(pi.messages[0].display, true);
		assert.equal(pi.messages[0].details.status, "ok");
		assert.equal(pi.messages[0].details.content, "Include arg: src/server.ts\n\nReview src/server.ts now");
		assert.match(pi.messages[0].content, /Include arg: src\/server\.ts/);
		assert.match(pi.messages[0].content, /Review src\/server\.ts now/);
		assertNoExecutionSideEffects(pi);
	});
});

test("dry-run-prompt alias produces the same content as print-prompt", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nReview $@");
		await pi.emit("session_start", {}, ctx);
		await pi.commands.get("print-prompt")!.handler!("review src/server.ts", ctx);
		const printed = pi.messages[0].content;
		pi.messages = [];
		await pi.commands.get("dry-run-prompt")!.handler!("review src/server.ts", ctx);
		assert.equal(pi.messages.length, 1);
		assert.equal(pi.messages[0].content, printed);
		assertNoExecutionSideEffects(pi);
	});
});

test("--model affects conditional output", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writePrompt(cwd, "conditional", "---\nmodel: anthropic/claude-sonnet-4-20250514, openai/gpt-5.2\n---\n<if-model is=\"openai/*\">openai<else>other</if-model>");
		await pi.emit("session_start", {}, ctx);
		await pi.commands.get("print-prompt")!.handler!("conditional --model=gpt-5.2", ctx);
		assert.equal(pi.messages[0].details.content, "openai");
		assert.equal(pi.messages[0].details.runtime.model, "gpt-5.2");
		assertNoExecutionSideEffects(pi);
	});
});

test("--show-skills includes skill content and default omits it", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writeSkill(cwd, "tmux", "tmux skill content");
		writePrompt(cwd, "skilled", "---\nmodel: anthropic/claude-sonnet-4-20250514\nskill: tmux\n---\nUse skill");
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("print-prompt")!.handler!("skilled", ctx);
		assert.equal("skillContent" in pi.messages[0].details.skills[0], false);
		assert.doesNotMatch(pi.messages[0].content, /tmux skill content/);

		pi.messages = [];
		await pi.commands.get("print-prompt")!.handler!("skilled --show-skills", ctx);
		assert.equal(pi.messages[0].details.skills[0].skillContent, "tmux skill content");
		assert.match(pi.messages[0].content, /tmux skill content/);
		assertNoExecutionSideEffects(pi);
	});
});

test("unsupported chain, deterministic, and compare prompts report clear errors without dry-run message", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writePrompt(cwd, "chainy", "---\nchain: one -> two\n---\nignored");
		writePrompt(cwd, "det", "---\nrun: printf ok\n---\nignored");
		writePrompt(cwd, "compare", "---\nmodel: anthropic/claude-sonnet-4-20250514\nbestOfN:\n  workers:\n    - agent: worker\n---\nTask");
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("print-prompt")!.handler!("chainy", ctx);
		assert.match(pi.notifications.at(-1)!.message, /Dry-run for chain templates is not supported/);
		await pi.commands.get("print-prompt")!.handler!("det", ctx);
		assert.match(pi.notifications.at(-1)!.message, /Dry-run for deterministic prompts is not supported/);
		await pi.commands.get("print-prompt")!.handler!("compare", ctx);
		assert.match(pi.notifications.at(-1)!.message, /Dry-run for compare prompts is not supported/);
		assert.equal(pi.messages.length, 0);
		assertNoExecutionSideEffects(pi);
	});
});
