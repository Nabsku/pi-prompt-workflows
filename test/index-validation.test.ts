import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptModelExtension from "../index.js";

interface FakeCommand {
	description: string;
	handler: (args: string, ctx: any) => Promise<void>;
	source?: string;
	name?: string;
	sourceInfo?: { path?: string };
}

class FakePi {
	commands = new Map<string, FakeCommand>();
	renderers = new Map<string, unknown>();
	notifications: Array<{ message: string; type: string }> = [];

	registerMessageRenderer(type: string, renderer: unknown) { this.renderers.set(type, renderer); }
	registerCommand(name: string, command: FakeCommand) { this.commands.set(name, { ...command, name }); }
	registerTool() {}
	getCommands() { return Array.from(this.commands.values()); }
	on() {}
	async setModel() { return true; }
	getThinkingLevel() { return "medium" as const; }
	setThinkingLevel() {}
	sendUserMessage() {}
	sendMessage() {}
}

async function withTempHome(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-validation-command-"));
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
		hasUI: true,
		ui: {
			notify(message: string, type: string) { pi.notifications.push({ message, type }); },
			setStatus() {},
			setWorkingMessage() {},
			onTerminalInput() { return () => {}; },
			theme: { fg(_token: string, text: string) { return text; } },
		},
		model: undefined,
		modelRegistry: { getAll() { return []; }, getAvailable() { return []; } },
		isIdle() { return false; },
		async waitForIdle() {},
		sessionManager: { getLeafId() { return "root"; }, getBranch() { return []; } },
		async navigateTree() { return { cancelled: false }; },
	};
}

test("validate-prompts command reports success", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "hello.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nHello");

		const pi = new FakePi();
		const ctx = createContext(cwd, pi);
		promptModelExtension(pi as never);

		assert.ok(pi.commands.has("validate-prompts"));
		await pi.commands.get("validate-prompts")!.handler("", ctx);

		assert.equal(pi.notifications.length, 1);
		assert.equal(pi.notifications[0]!.type, "info");
		assert.match(pi.notifications[0]!.message, /Prompt validation passed/);
	});
});

test("validate-prompts command reports errors", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad.md"), "---\nmodel: claude-sonnet-4-20250514\nskills: [missing-skill]\n---\nHello");

		const pi = new FakePi();
		const ctx = createContext(cwd, pi);
		promptModelExtension(pi as never);

		await pi.commands.get("validate-prompts")!.handler("", ctx);

		assert.equal(pi.notifications.length, 1);
		assert.equal(pi.notifications[0]!.type, "error");
		assert.match(pi.notifications[0]!.message, /Prompt validation failed/);
		assert.match(pi.notifications[0]!.message, /skill-not-found/);
	});
});
