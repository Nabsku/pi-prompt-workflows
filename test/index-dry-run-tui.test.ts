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

function writeLibraryPrompt(cwd: string, name: string, body: string) {
	mkdirSync(join(cwd, ".pi", "prompt-library"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "prompt-library", `${name}.md`), body);
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

async function captureStderr(run: () => Promise<void>): Promise<string> {
	const originalWrite = process.stderr.write.bind(process.stderr);
	let output = "";
	(process.stderr.write as unknown as (chunk: unknown, encoding?: unknown, cb?: unknown) => boolean) = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
		output += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
		if (typeof encoding === "function") encoding();
		if (typeof cb === "function") cb();
		return true;
	}) as never;
	try {
		await run();
		return output;
	} finally {
		process.stderr.write = originalWrite as never;
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

test("TUI picker ignores malformed or non-catalog UI return values without routing to dry-run", async () => {
	const inheritedSelection = Object.create({ action: "selected", templateName: "review" });
	for (const maliciousReturn of [
		"/tmp/owned.md",
		{ action: "selected", templateName: "/tmp/owned.md" },
		{ action: "selected", templateName: "run-2026-06-23-stale" },
		{ action: "selected", templateName: "hidden" },
		{ action: "selected", templateName: "removed" },
		{ action: "selected", templateName: "x".repeat(200_000) },
		{ action: "selected", templateName: "review", get path() { throw new Error("unexpected field should not be read"); } },
		inheritedSelection,
	]) {
		await setup("tui", async (cwd, pi, ctx) => {
			writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nReview $@");
			writePrompt(cwd, "hidden", "---\nmodel: anthropic/claude-sonnet-4-20250514\nhidden: true\n---\nHidden $@");
			await pi.emit("session_start", {}, ctx);
			pi.customResults.push(maliciousReturn);

			await pi.commands.get("dry-run-prompt")!.handler!("", ctx);

			const shouldInspectReview = maliciousReturn && typeof maliciousReturn === "object" && Object.getOwnPropertyDescriptor(maliciousReturn, "templateName")?.value === "review";
			assert.equal(pi.customCalls.length, shouldInspectReview ? 2 : 1);
			if (!shouldInspectReview) assert.equal(pi.customComponents.length, 1);
			assertNoExecutionSideEffects(pi);
		});
	}
});

test("TUI back navigation ignores stale raw CLI args and non-catalog picker selections", async () => {
	await setup("tui", async (cwd, pi, ctx) => {
		writePrompt(cwd, "first", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nFirst body $@");
		writePrompt(cwd, "second", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nSecond body $@");
		await pi.emit("session_start", {}, ctx);
		pi.customResults.push({ action: "back" }, { action: "selected", templateName: "/tmp/replayed-from-cli" });

		await pi.commands.get("print-prompt")!.handler!("first /tmp/replayed-from-cli --show-skills", ctx);

		assert.equal(pi.customCalls.length, 2);
		assert.equal(pi.notifications.length, 0);
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
	for (const commandName of ["print-prompt", "dry-run-prompt"] as const) {
		await setup("tui", async (cwd, pi, ctx) => {
			writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nReview $@");
			await pi.emit("session_start", {}, ctx);

			const output = await captureStdout(() => pi.commands.get(commandName)!.handler!("review --plain src/server.ts", ctx));

			assert.equal(pi.customCalls.length, 0);
			assert.match(output, /# Prompt dry-run: review/);
			assert.match(output, /Review src\/server\.ts/);
			assertNoExecutionSideEffects(pi);
		});
	}
});

test("TUI /dry-run-prompt carries the real include graph into the inspector Includes pane", async () => {
	await setup("tui", async (cwd, pi, ctx) => {
		mkdirSync(join(cwd, ".pi", "prompts", "shared"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "shared", "rules.md"), "Shared rules for $1");
		writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\nincludes: [shared/rules.md]\n---\nReview $@");
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("dry-run-prompt")!.handler!("review src/server.ts", ctx);

		assert.equal(pi.customCalls.length, 1);
		const inspector = pi.customComponents.at(-1) as { handleInput(data: string): void; render(width: number): string[] };
		inspector.handleInput("5");
		const rendered = inspector.render(1000).join("\n");
		assert.match(rendered, /\[Includes\]/);
		assert.match(rendered, /- review \[ok\] .*\.pi\/prompts\/review\.md/);
		assert.match(rendered, /review\.md -> .*shared\/rules\.md \(frontmatter shared\/rules\.md\) \[ok\]/);
		assert.doesNotMatch(rendered, /No includes\./);
		assertNoExecutionSideEffects(pi);
	});
});

test("TUI /dry-run-prompt keeps a permanent Includes pane with No includes for prompts without includes", async () => {
	await setup("tui", async (cwd, pi, ctx) => {
		writePrompt(cwd, "review", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nReview $@");
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("dry-run-prompt")!.handler!("review src/server.ts", ctx);

		assert.equal(pi.customCalls.length, 1);
		const inspector = pi.customComponents.at(-1) as { handleInput(data: string): void; render(width: number): string[] };
		inspector.handleInput("5");
		const rendered = inspector.render(100).join("\n");
		assert.match(rendered, /\[Includes\]/);
		assert.match(rendered, /No includes\./);
		assert.match(rendered, /pane 5\/7/);
		assertNoExecutionSideEffects(pi);
	});
});

test("non-TUI modes keep missing-template error with guidance to use Pi TUI or pass a template", async () => {
	await setup("rpc", async (_cwd, pi, ctx) => {
		await pi.commands.get("dry-run-prompt")!.handler!("", ctx);
		assert.equal(pi.customCalls.length, 0);
		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.match(pi.notifications.at(-1)?.message ?? "", /Run in Pi TUI mode.*pick from templates.*pass a template name/i);
		assertNoExecutionSideEffects(pi);
	});

	for (const mode of ["print", "json"] as const) {
		await setup(mode, async (_cwd, pi, ctx) => {
			const stderr = await captureStderr(() => pi.commands.get("dry-run-prompt")!.handler!("", ctx));
			assert.equal(pi.customCalls.length, 0);
			assert.equal(pi.notifications.length, 0);
			assert.match(stderr, /Run in Pi TUI mode.*pick from templates.*pass a template name/i);
			assertNoExecutionSideEffects(pi);
		});
	}
});

test("non-TUI missing-template usage goes to stderr and does not call no-op or throwing ui.notify", async () => {
	for (const commandName of ["print-prompt", "dry-run-prompt"] as const) {
		await setup("print", async (_cwd, pi, ctx) => {
			let notifyCalls = 0;
			ctx.ui.notify = () => {
				notifyCalls++;
				throw new Error("ui.notify should not be called when hasUI is false");
			};

			const stderr = await captureStderr(() => pi.commands.get(commandName)!.handler!("", ctx));

			assert.equal(notifyCalls, 0);
			assert.equal(pi.notifications.length, 0);
			assert.match(stderr, /Usage: \/print-prompt <template>/);
			assert.match(stderr, /Run in Pi TUI mode.*pick from templates.*pass a template name/i);
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
		assert.equal(output, "");
		assert.equal(pi.notifications.at(-2)?.type, "warning");
		assert.match(pi.notifications.at(-2)?.message ?? "", /without Pi TUI custom UI.*notification report/i);
		assert.equal(pi.notifications.at(-1)?.type, "info");
		assert.match(pi.notifications.at(-1)?.message ?? "", /# Prompt dry-run: review/);
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

test("TUI picker unsupported selection surfaces dry-run diagnostic without execution side effects", async () => {
	await setup("tui", async (cwd, pi, ctx) => {
		writePrompt(cwd, "det", "---\nrun: printf ok\n---\nignored");
		await pi.emit("session_start", {}, ctx);
		pi.customResults.push({ action: "selected", templateName: "det" });

		await pi.commands.get("dry-run-prompt")!.handler!("", ctx);

		assert.equal(pi.customCalls.length, 1);
		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.match(pi.notifications.at(-1)?.message ?? "", /deterministic prompts is not supported/i);
		assertNoExecutionSideEffects(pi);
	});
});

test("TUI picker and inspector support preset-only compare prompts", async () => {
	await setup("tui", async (cwd, pi, ctx) => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "best-of-n-presets.json"), `${JSON.stringify({ presets: { quick: { workers: [{ agent: "worker" }], reviewers: [{ agent: "reviewer" }] } } })}\n`);
		writePrompt(cwd, "compare-preset", "---\nmodel: anthropic/claude-sonnet-4-20250514\nbestOfN:\n  preset: quick\n---\nReview $@");
		await pi.emit("session_start", {}, ctx);
		pi.customResults.push({ action: "selected", templateName: "compare-preset" });

		await pi.commands.get("dry-run-prompt")!.handler!("", ctx);

		assert.equal(pi.customCalls.length, 2, JSON.stringify(pi.notifications));
		const picker = pi.customComponents.at(-2) as { render(width: number): string[] };
		const rendered = picker.render(1000).join("\n");
		assert.match(rendered, /compare-preset\s+project/);
		assert.doesNotMatch(rendered, /compare-preset[\s\S]*unsupported|unsupported[\s\S]*compare-preset/);
		const inspector = pi.customComponents.at(-1) as { handleInput(data: string): void; render(width: number): string[] };
		inspector.handleInput("3");
		const inspected = inspector.render(1000).join("\n");
		assert.match(inspected, /\[Compare\]/);
		assert.match(inspected, /Preset: quick \(project-approval-required\)/);
		assert.match(inspected, /worker 1: agent=worker/);
		assertNoExecutionSideEffects(pi);
	});
});

test("TUI picker includes command-capable prompt-library prompts and excludes plain fragments", async () => {
	await setup("tui", async (cwd, pi, ctx) => {
		writeLibraryPrompt(cwd, "review-lib", "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nLibrary review");
		writeLibraryPrompt(cwd, "hidden-lib", "---\nmodel: anthropic/claude-sonnet-4-20250514\nhidden: true\n---\nHidden review");
		writeLibraryPrompt(cwd, "rules", "Plain shared rules fragment");
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("dry-run-prompt")!.handler!("", ctx);

		assert.equal(pi.customCalls.length, 1);
		const picker = pi.customComponents.at(-1) as { render(width: number): string[] };
		const rendered = picker.render(1000).join("\n");
		assert.match(rendered, /review-lib\s+project/);
		assert.doesNotMatch(rendered, /hidden-lib\s+project/);
		assert.doesNotMatch(rendered, /rules\s+project/);
		assertNoExecutionSideEffects(pi);
	});
});

test("exact dry-run names can open prompt-library commands while fragments stay unavailable", async () => {
	await setup("tui", async (cwd, pi, ctx) => {
		writeLibraryPrompt(cwd, "review-lib", "---\nmodel: anthropic/claude-sonnet-4-20250514\nhidden: true\n---\nLibrary review $@");
		writeLibraryPrompt(cwd, "rules", "Plain shared rules fragment");
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("print-prompt")!.handler!("review-lib src/server.ts", ctx);

		assert.equal(pi.customCalls.length, 1);
		const inspector = pi.customComponents.at(-1) as { render(width: number): string[] };
		const rendered = inspector.render(1000).join("\n");
		assert.match(rendered, /Prompt dry-run: review-lib/);
		assert.match(rendered, /Library review src\/server\.ts/);

		await pi.commands.get("print-prompt")!.handler!("rules", ctx);
		assert.equal(pi.customCalls.length, 1);
		assert.equal(pi.notifications.at(-1)?.type, "error");
		assert.match(pi.notifications.at(-1)?.message ?? "", /Prompt "rules" not found/);
		assertNoExecutionSideEffects(pi);
	});
});

test("user prompt-library hidden commands are excluded from picker and slash registration but exact dry-run works", async () => {
	await setup("tui", async (cwd, pi, ctx) => {
		const userLibrary = join(cwd, "..", ".pi", "agent", "prompt-library");
		mkdirSync(userLibrary, { recursive: true });
		writeFileSync(join(userLibrary, "visible-user.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nVisible user library");
		writeFileSync(join(userLibrary, "hidden-user.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nhidden: true\n---\nHidden user library $@");
		await pi.emit("session_start", {}, ctx);

		assert.ok(pi.commands.has("visible-user"));
		assert.equal(pi.commands.has("hidden-user"), false);
		await pi.commands.get("dry-run-prompt")!.handler!("", ctx);

		assert.equal(pi.customCalls.length, 1);
		const picker = pi.customComponents.at(-1) as { render(width: number): string[] };
		const renderedPicker = picker.render(1000).join("\n");
		assert.match(renderedPicker, /visible-user\s+user library/);
		assert.doesNotMatch(renderedPicker, /hidden-user\s+user library/);

		await pi.commands.get("dry-run-prompt")!.handler!("hidden-user src/app.ts", ctx);

		assert.equal(pi.customCalls.length, 2);
		const inspector = pi.customComponents.at(-1) as { render(width: number): string[] };
		const renderedInspector = inspector.render(1000).join("\n");
		assert.match(renderedInspector, /Prompt dry-run: hidden-user/);
		assert.match(renderedInspector, /Hidden user library src\/app\.ts/);
		assertNoExecutionSideEffects(pi);
	});
});
