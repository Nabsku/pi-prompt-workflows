import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeDeterministicExecutionOutcome, runDeterministicStep } from "../deterministic-step.ts";
import promptModelExtension from "../index.ts";
import {
	PROMPT_TEMPLATE_DETERMINISTIC_COMPLETION_MESSAGE_TYPE,
	PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE,
} from "../deterministic-step.ts";

const MODEL = { provider: "anthropic", id: "claude-sonnet-4-20250514" };

interface FakeCommand {
	description: string;
	handler: (args: string, ctx: any) => Promise<void>;
}

class FakePi {
	commands = new Map<string, FakeCommand>();
	tools = new Map<string, any>();
	hooks = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();
	currentModel = MODEL;
	userMessages: string[] = [];
	customMessages: any[] = [];
	setModelCalls: string[] = [];

	registerMessageRenderer() {}
	registerCommand(name: string, command: FakeCommand) { this.commands.set(name, command); }
	registerTool(tool: any) { this.tools.set(tool.name, tool); }
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

async function withTempHome(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-deterministic-"));
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
		hasUI: false,
		ui: {
			notify() {},
			setStatus() {},
			setWorkingMessage() {},
			onTerminalInput() { return () => {}; },
			theme: { fg(_token: string, text: string) { return text; } },
		},
		isIdle() { return false; },
		async waitForIdle() {},
		sessionManager: {
			getLeafId() { return "root"; },
			getBranch() { return []; },
		},
		async navigateTree() { return { cancelled: false }; },
	};
}

test("deterministic prompt with handoff never emits the result card and a synthetic completion message", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "push.md"),
			"---\nrun: printf 'pushed'\nhandoff: never\n---\nignored",
		);

		const pi = new FakePi();
		const ctx = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("push")!.handler("", ctx);

		assert.equal(pi.userMessages.length, 0);
		assert.equal(pi.customMessages.length, 2);
		assert.equal(pi.customMessages[0].customType, PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE);
		assert.equal(pi.customMessages[0].details.exitCode, 0);
		assert.match(pi.customMessages[0].details.stdout, /pushed/);
		assert.equal(pi.customMessages[1].customType, PROMPT_TEMPLATE_DETERMINISTIC_COMPLETION_MESSAGE_TYPE);
		assert.equal(pi.customMessages[1].details.status, "succeeded");
	});
});

test("deterministic prompt with handoff always prepends deterministic preamble before the prompt body", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "ship.md"),
			"---\nrun: printf 'ok'\nhandoff: always\nmodel: anthropic/claude-sonnet-4-20250514\n---\nSummarize the deterministic result.",
		);

		const pi = new FakePi();
		const ctx = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("ship")!.handler("", ctx);

		assert.equal(pi.customMessages.length, 1);
		assert.equal(pi.userMessages.length, 1);
		assert.match(pi.userMessages[0]!, /^\[Deterministic step\]/);
		assert.match(pi.userMessages[0]!, /nonInteractive: true/);
		assert.match(pi.userMessages[0]!, /exitCode: 0/);
		assert.match(pi.userMessages[0]!, /ok/);
		assert.match(pi.userMessages[0]!, /Summarize the deterministic result\./);
	});
});

test("deterministic prompt with handoff on-failure continues into the LLM on non-zero exit", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "recover.md"),
			"---\nrun: printf 'broken' >&2; exit 3\nhandoff: on-failure\nmodel: anthropic/claude-sonnet-4-20250514\n---\nExplain the failure.",
		);

		const pi = new FakePi();
		const ctx = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("recover")!.handler("", ctx);

		assert.equal(pi.customMessages.length, 1);
		assert.equal(pi.customMessages[0].details.exitCode, 3);
		assert.match(pi.customMessages[0].details.stderr, /broken/);
		assert.equal(pi.userMessages.length, 1);
		assert.match(pi.userMessages[0]!, /status: failed/);
		assert.match(pi.userMessages[0]!, /exitCode: 3/);
		assert.match(pi.userMessages[0]!, /Explain the failure\./);
	});
});

test("deterministic prompts can inject env and disable nonInteractive defaults", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "deploy.md"),
			[
				"---",
				"deterministic:",
				"  run: |",
				"    python3 - <<'PY'",
				"    import os",
				"    print(os.environ.get('CI', 'missing'))",
				"    print(os.environ.get('SPECIAL', 'missing'))",
				"    PY",
				"  handoff: always",
				"  nonInteractive: false",
				"  env:",
				"    SPECIAL: deploy-token",
				"model: anthropic/claude-sonnet-4-20250514",
				"---",
				"Summarize the environment used.",
			].join("\n"),
		);

		const pi = new FakePi();
		const ctx = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		const previousCi = process.env.CI;
		delete process.env.CI;
		try {
			await pi.commands.get("deploy")!.handler("", ctx);
		} finally {
			if (previousCi === undefined) {
				delete process.env.CI;
			} else {
				process.env.CI = previousCi;
			}
		}

		assert.equal(pi.customMessages.length, 1);
		assert.match(pi.customMessages[0].details.stdout, /missing\ndeploy-token/);
		assert.equal(pi.customMessages[0].details.nonInteractive, false);
		assert.match(pi.userMessages[0]!, /nonInteractive: false/);
	});
});

test("deterministic prompts reject runtime loop overrides in v1", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "push.md"),
			"---\nrun: printf 'pushed'\nhandoff: never\n---\nignored",
		);

		const notifications: string[] = [];
		const pi = new FakePi();
		const ctx = {
			...createContext(cwd, pi),
			ui: {
				notify(message: string) { notifications.push(message); },
				setStatus() {},
				setWorkingMessage() {},
				onTerminalInput() { return () => {}; },
				theme: { fg(_token: string, text: string) { return text; } },
			},
			hasUI: true,
		};
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		await pi.commands.get("push")!.handler("--loop 2", ctx);

		assert.equal(pi.customMessages.length, 0);
		assert.equal(pi.userMessages.length, 0);
		assert.match(notifications.join("\n"), /do not support runtime --loop/i);
	});
});

test("deterministic runner reports cancellation as a structured failed outcome", async () => {
	await withTempHome(async (root) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const result = await runDeterministicStep(
			{ filePath: join(root, "step.md") },
			{ execution: { kind: "command", command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], shell: false }, handoff: "never", nonInteractive: true },
			root,
			controller.signal,
		);
		assert.equal(result.termination, "cancelled");
		assert.equal(normalizeDeterministicExecutionOutcome(result).status, "failed");
	});
});

test("deterministic cancellation kills a SIGTERM-resistant descendant before resolving", { skip: process.platform === "win32" }, async () => {
	await withTempHome(async (root) => {
		const pidFile = join(root, "pids.json");
		const delayedWrite = join(root, "descendant-wrote");
		const controller = new AbortController();
		const script = [
			"const { spawn } = require('node:child_process');",
			"const fs = require('node:fs');",
			"process.on('SIGTERM', () => {});",
			`const descendant = spawn(process.execPath, ['-e', ${JSON.stringify("const fs = require('node:fs'); process.on('SIGTERM', () => {}); setTimeout(() => fs.writeFileSync(" + JSON.stringify(delayedWrite) + ", 'bad'), 250); setInterval(() => {}, 1000);")}], { stdio: 'ignore' });`,
			`fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, descendant: descendant.pid }));`,
			"setInterval(() => {}, 1000);",
		].join("\n");
		const execution = runDeterministicStep(
			{ filePath: join(root, "step.md") },
			{ execution: { kind: "command", command: process.execPath, args: ["-e", script], shell: false }, handoff: "never", nonInteractive: true },
			root,
			controller.signal,
		);
		const deadline = Date.now() + 2_000;
		while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(existsSync(pidFile), "child did not publish process identities");
		const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { parent: number; descendant: number };
		controller.abort();
		const result = await execution;
		assert.equal(result.termination, "cancelled");
		assert.equal(result.cleanupScope, "process-group");
		assert.equal(result.processGroupExtinct, true);
		assert.equal(existsSync(delayedWrite), false, "descendant wrote after cancellation");
		for (const pid of [pids.parent, pids.descendant]) {
			const goneDeadline = Date.now() + 2_000;
			let alive = true;
			while (alive && Date.now() < goneDeadline) {
				try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
				if (alive) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(alive, false, `process ${pid} survived cancellation`);
		}
	});
});
