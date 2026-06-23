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
	commandRegistrations: string[] = [];
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
	registerCommand(name: string, command: FakeCommand) { this.commandRegistrations.push(name); this.commands.set(name, { ...command, name }); }
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

function createContext(cwd: string, pi: FakePi, options: { trusted?: boolean; hasUI?: boolean; confirm?: () => boolean | Promise<boolean> } = {}) {
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
		hasUI: options.hasUI ?? true,
		ui: {
			notify(message: string, type: string) { pi.notifications.push({ message, type }); },
			writeStderr(message: string) { pi.stderr.push(message); },
			setStatus() {},
			setWorkingMessage() {},
			onTerminalInput() { return () => {}; },
			async confirm() { return options.confirm ? await options.confirm() : true; },
			theme: { fg(_token: string, text: string) { return text; } },
		},
		isProjectTrusted() { return options.trusted ?? true; },
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

function writeLibraryPrompt(cwd: string, name: string, body: string) {
	mkdirSync(join(cwd, ".pi", "prompt-library"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "prompt-library", `${name}.md`), body);
}

function writeSkill(cwd: string, name: string, content: string) {
	const dir = join(cwd, ".pi", "skills", name);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "SKILL.md");
	writeFileSync(path, content);
	return path;
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

test("print-prompt writes dry-run report to stdout instead of LLM history and has no execution side effects", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		mkdirSync(join(cwd, ".pi", "prompt-partials"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-partials", "review-prefix.md"), "Include arg: $1");
		writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\ninclude: review-prefix.md\n---\nReview $@ now");
		await pi.emit("session_start", {}, ctx);

		const output = await captureStdout(() => pi.commands.get("print-prompt")!.handler!("review --plain src/server.ts", ctx));

		assert.equal(pi.messages.length, 0);
		assert.match(output, /# Prompt dry-run: review/);
		assert.match(output, /Status: ok/);
		assert.match(output, /Include arg: src\/server\.ts/);
		assert.match(output, /Review src\/server\.ts now/);
		assertNoExecutionSideEffects(pi);
	});
});

test("dry-run-prompt alias produces the same stdout content as print-prompt", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nReview $@");
		await pi.emit("session_start", {}, ctx);
		const printed = await captureStdout(() => pi.commands.get("print-prompt")!.handler!("review --plain src/server.ts", ctx));
		const dryRun = await captureStdout(() => pi.commands.get("dry-run-prompt")!.handler!("review --plain src/server.ts", ctx));
		assert.equal(dryRun, printed);
		assertNoExecutionSideEffects(pi);
	});
});

test("--plain explicitly keeps stdout dry-run output without warning", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nReview $@");
		await pi.emit("session_start", {}, ctx);
		const output = await captureStdout(() => pi.commands.get("print-prompt")!.handler!("review --plain file.ts", ctx));
		assert.match(output, /Review file\.ts/);
		assert.equal(pi.notifications.length, 0);
		assertNoExecutionSideEffects(pi);
	});
});

test("--tui warns and falls back to stdout outside Pi TUI custom UI unless --plain is also present", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nReview $@");
		await pi.emit("session_start", {}, ctx);
		const tuiOutput = await captureStdout(() => pi.commands.get("print-prompt")!.handler!("review --tui file.ts", ctx));
		assert.equal(tuiOutput, "");
		assert.equal(pi.notifications.at(-2)?.type, "warning");
		assert.match(pi.notifications.at(-2)?.message ?? "", /--tui.*not available.*notification report/i);
		assert.match(pi.notifications.at(-1)?.message ?? "", /Review file\.ts/);

		pi.notifications = [];
		const plainOutput = await captureStdout(() => pi.commands.get("print-prompt")!.handler!("review --tui --plain file.ts", ctx));
		assert.match(plainOutput, /Review file\.ts/);
		assert.equal(pi.notifications.length, 0);
		assertNoExecutionSideEffects(pi);
	});
});

test("--model affects conditional stdout output", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writePrompt(cwd, "conditional", "---\nmodel: anthropic/claude-sonnet-4-20250514, openai/gpt-5.2\n---\n<if-model is=\"openai/*\">openai<else>other</if-model>");
		await pi.emit("session_start", {}, ctx);
		const output = await captureStdout(() => pi.commands.get("print-prompt")!.handler!("conditional --plain --model=gpt-5.2", ctx));
		assert.match(output, /openai/);
		assert.match(output, /Requested model override: gpt-5\.2/);
		assertNoExecutionSideEffects(pi);
	});
});

test("--show-skills includes skill content in stdout and default omits it", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writeSkill(cwd, "tmux", "tmux skill content");
		writePrompt(cwd, "skilled", "---\nmodel: anthropic/claude-sonnet-4-20250514\nskill: tmux\n---\nUse skill");
		await pi.emit("session_start", {}, ctx);

		const hidden = await captureStdout(() => pi.commands.get("print-prompt")!.handler!("skilled --plain", ctx));
		assert.doesNotMatch(hidden, /tmux skill content/);

		const shown = await captureStdout(() => pi.commands.get("print-prompt")!.handler!("skilled --plain --show-skills", ctx));
		assert.match(shown, /tmux skill content/);
		assertNoExecutionSideEffects(pi);
	});
});

test("unsupported chain and deterministic prompts report clear errors without dry-run message", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writePrompt(cwd, "chainy", "---\nchain: one -> two\n---\nignored");
		writePrompt(cwd, "det", "---\nrun: printf ok\n---\nignored");
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("print-prompt")!.handler!("chainy", ctx);
		assert.match(pi.notifications.at(-1)!.message, /Dry-run for chain templates is not supported/);
		await pi.commands.get("print-prompt")!.handler!("det", ctx);
		assert.match(pi.notifications.at(-1)!.message, /Dry-run for deterministic prompts is not supported/);
		assert.equal(pi.messages.length, 0);
		assertNoExecutionSideEffects(pi);
	});
});

test("compare prompts render a read-only preflight report with --plain", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writePrompt(cwd, "compare", "---\nmodel: anthropic/claude-sonnet-4-20250514\ncommit: ask\nbestOfN:\n  workers:\n    - agent: worker\n      model: openai/gpt-5.2\n  reviewers:\n    - agent: reviewer\n  worktree: true\n---\nTask $@");
		await pi.emit("session_start", {}, ctx);

		const output = await captureStdout(() => pi.commands.get("print-prompt")!.handler!("compare --plain src/app.ts", ctx));

		assert.match(output, /# Prompt dry-run: compare/);
		assert.match(output, /## Compare preflight/);
		assert.match(output, /worker 1: agent=worker, model=openai\/gpt-5\.2/);
		assert.match(output, /Worktree: true \(shared\)/);
		assert.match(output, /Task src\/app\.ts/);
		assertNoExecutionSideEffects(pi);
	});
});

test("default UI dry-run routes compare preflight through notification unless --plain is explicit", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writePrompt(cwd, "compare", "---\nmodel: anthropic/claude-sonnet-4-20250514\nbestOfN:\n  workers:\n    - agent: worker\n---\nTask $@");
		await pi.emit("session_start", {}, ctx);

		const output = await captureStdout(() => pi.commands.get("dry-run-prompt")!.handler!("compare src/app.ts", ctx));

		assert.equal(output, "");
		assert.equal(pi.notifications.at(-1)?.type, "info");
		assert.match(pi.notifications.at(-1)?.message ?? "", /## Compare preflight/);
		assertNoExecutionSideEffects(pi);
	});
});


test("exact plain dry-run of hidden project prompt-library commands previews without approval", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writeLibraryPrompt(cwd, "hidden-lib", "---\nmodel: anthropic/claude-sonnet-4-20250514\nhidden: true\n---\nHIDDEN $@");
		let confirmCalls = 0;
		ctx.ui.confirm = async () => {
			confirmCalls++;
			throw new Error("dry-run must not ask for project-library approval");
		};
		await pi.emit("session_start", {}, ctx);

		assert.equal(pi.commands.has("hidden-lib"), false);
		const printOutput = await captureStdout(() => pi.commands.get("print-prompt")!.handler!("hidden-lib --plain src/app.ts", ctx));
		const dryRunOutput = await captureStdout(() => pi.commands.get("dry-run-prompt")!.handler!("hidden-lib --plain src/app.ts", ctx));

		for (const output of [printOutput, dryRunOutput]) {
			assert.match(output, /# Prompt dry-run: hidden-lib/);
			assert.match(output, /HIDDEN src\/app\.ts/);
		}
		assert.equal(confirmCalls, 0);
		assertNoExecutionSideEffects(pi);
	});
});

test("command-capable prompt-library prompt registers as slash command and print-prompt renders it without execution", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writeLibraryPrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nLibrary review $@");
		await pi.emit("session_start", {}, ctx);

		assert.ok(pi.commands.has("review"));
		const output = await captureStdout(() => pi.commands.get("print-prompt")!.handler!("review --plain src/lib.ts", ctx));

		assert.match(output, /# Prompt dry-run: review/);
		assert.match(output, /Library review src\/lib\.ts/);
		assertNoExecutionSideEffects(pi);
	});
});

test("scalar-skill prompt-library prompt registers and dry-run resolves requested skill", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writeSkill(cwd, "tmux", "tmux skill content from project");
		writeLibraryPrompt(cwd, "skilled-lib", "---\nskill: tmux\n---\nUse tmux skill");
		await pi.emit("session_start", {}, ctx);

		assert.ok(pi.commands.has("skilled-lib"));
		const output = await captureStdout(() => pi.commands.get("dry-run-prompt")!.handler!("skilled-lib --plain --show-skills", ctx));

		assert.match(output, /Status: ok/);
		assert.match(output, /Use tmux skill/);
		assert.match(output, /tmux skill content from project/);
		assertNoExecutionSideEffects(pi);
	});
});

test("plain include-only prompt-library fragment does not register and cannot be printed", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writeLibraryPrompt(cwd, "rules", "Shared rules fragment only");
		await pi.emit("session_start", {}, ctx);

		assert.equal(pi.commands.has("rules"), false);
		await pi.commands.get("print-prompt")!.handler!("rules", ctx);
		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.match(pi.notifications.at(-1)?.message ?? "", /Prompt "rules" not found/);
		pi.notifications = [];
		await pi.commands.get("dry-run-prompt")!.handler!("rules", ctx);
		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.match(pi.notifications.at(-1)?.message ?? "", /Prompt "rules" not found/);
		assertNoExecutionSideEffects(pi);
	});
});

test("same-name .pi/prompts and prompt-library registers exactly one effective slash command", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nProject winner");
		writeLibraryPrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nLibrary loser");
		const before = pi.commandRegistrations.length;
		await pi.emit("session_start", {}, ctx);

		assert.equal(pi.commandRegistrations.slice(before).filter((name) => name === "review").length, 1);
		const output = await captureStdout(() => pi.commands.get("print-prompt")!.handler!("review --plain", ctx));
		assert.match(output, /Project winner/);
		assert.doesNotMatch(output, /Library loser/);
		assertNoExecutionSideEffects(pi);
	});
});

test("prompt-library reserved names do not overwrite extension slash commands", async () => {
	await setup(async (_root, cwd, pi, ctx) => {
		writeLibraryPrompt(cwd, "print-prompt", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nShould not register");
		await pi.emit("session_start", {}, ctx);

		assert.equal(pi.commands.get("print-prompt")?.description, "Print the rendered prompt template without running it");
		await pi.commands.get("print-prompt")!.handler!("print-prompt", ctx);
		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.match(pi.notifications.at(-1)?.message ?? "", /Prompt "print-prompt" not found/);
		assertNoExecutionSideEffects(pi);
	});
});

test("project prompt-library execution blocks in untrusted non-UI contexts", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		writeLibraryPrompt(cwd, "review-lib", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nLibrary review $@");
		const pi = new FakePi();
		const ctx = createContext(cwd, pi, { trusted: false, hasUI: false });
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("review-lib")!.handler!("src/server.ts", ctx);

		assert.equal(pi.userMessages.length, 0);
	});
});

test("project prompt-library execution asks once for session approval in untrusted UI contexts", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		writeLibraryPrompt(cwd, "review-lib", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nLibrary review $@");
		const pi = new FakePi();
		let confirmCalls = 0;
		const ctx = createContext(cwd, pi, {
			trusted: false,
			confirm: () => {
				confirmCalls++;
				return true;
			},
		});
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("review-lib")!.handler!("one", ctx);
		await pi.commands.get("review-lib")!.handler!("two", ctx);
		await pi.emit("session_start", {}, ctx);
		await pi.commands.get("review-lib")!.handler!("three", ctx);

		assert.equal(confirmCalls, 2);
		assert.equal(pi.userMessages.length, 3);
		assert.match(pi.userMessages[0] ?? "", /Library review one/);
		assert.match(pi.userMessages[1] ?? "", /Library review two/);
		assert.match(pi.userMessages[2] ?? "", /Library review three/);
	});
});

test("project prompt-library execution asks when Pi trust is true only because core saw no resources", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		writeLibraryPrompt(cwd, "review-lib", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nLibrary review $@");
		const pi = new FakePi();
		let confirmCalls = 0;
		const ctx = createContext(cwd, pi, {
			trusted: true,
			confirm: () => {
				confirmCalls++;
				return true;
			},
		});
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("review-lib")!.handler!("one", ctx);
		await pi.commands.get("review-lib")!.handler!("two", ctx);

		assert.equal(confirmCalls, 1);
		assert.equal(pi.userMessages.length, 2);
	});
});

test("project prompt-library execution asks even when core project prompts make Pi trust true", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "core.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nCore prompt");
		writeLibraryPrompt(cwd, "review-lib", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nLibrary review $@");
		const pi = new FakePi();
		let confirmCalls = 0;
		const ctx = createContext(cwd, pi, {
			trusted: true,
			confirm: () => {
				confirmCalls++;
				return true;
			},
		});
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("review-lib")!.handler!("one", ctx);

		assert.equal(confirmCalls, 1);
		assert.equal(pi.userMessages.length, 1);
	});
});
