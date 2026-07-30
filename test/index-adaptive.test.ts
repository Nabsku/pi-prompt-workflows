import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import promptModelExtension from "../index.ts";
import { PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE } from "../deterministic-step.ts";

const MODEL = { provider: "test", id: "model" };

test("adaptive command fails closed before execution when changed-gate analysis exceeds 4096 states", async () => {
	const root = mkdtempSync(join(tmpdir(), "adaptive-cap-")); const oldHome = process.env.HOME; process.env.HOME = join(root, "home");
	try {
		const cwd = join(root, "repo"); const dir = join(cwd, ".pi", "prompts"); mkdirSync(dir, { recursive: true }); mkdirSync(process.env.HOME, { recursive: true }); execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(dir, "step.md"), "---\nmodel: test/model\n---\nMUST NOT EXECUTE");
		const chain: string[] = [];
		for (let i = 0; i < 11; i++) {
			chain.push(`  - id: a${i}`, "    prompt: step", `    onSuccess: a${i + 1}`, `    onFailure: b${i}`, `  - id: b${i}`, "    prompt: step", `    onSuccess: a${i + 1}`, `    onFailure: a${i + 1}`);
		}
		chain.push("  - id: a11", "    prompt: step", "    when: changed");
		writeFileSync(join(dir, "flow.md"), ["---", "chain:", ...chain, "limits:", "  maxSteps: 23", "  maxModelCalls: 23", "---", "ignored"].join("\n"));
		const commands = new Map<string, any>(); const messages: string[] = []; const notifications: string[] = [];
		const pi: any = { registerCommand(name: string, command: any) { commands.set(name, command); }, registerMessageRenderer() {}, registerTool() {}, getCommands() { return []; }, on(event: string, handler: any) { if (event === "session_start") this.start = handler; }, async setModel() { return true; }, getThinkingLevel() { return "medium"; }, setThinkingLevel() {}, sendUserMessage(value: string) { messages.push(value); }, sendMessage() {} };
		const ctx: any = { cwd, model: MODEL, signal: new AbortController().signal, hasUI: false, modelRegistry: { find: () => MODEL, getAll: () => [MODEL], getAvailable: () => [MODEL] }, ui: { notify(value: string) { notifications.push(value); }, setStatus() {}, setWorkingMessage() {}, onTerminalInput() { return () => {}; }, theme: { fg(_x: string, value: string) { return value; } } }, isIdle: () => false, waitForIdle: async () => { throw new Error("must not wait"); }, sessionManager: { getLeafId: () => "root", getBranch: () => [] }, navigateTree: async () => ({ cancelled: false }) };
		promptModelExtension(pi); await pi.start({}, ctx); await commands.get("flow").handler("", ctx);
		assert.deepEqual(messages, []);
	} finally { process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); }
});

test("structured wrapper registers through adaptive path and executes an ordinary prompt target", async () => {
	const root = mkdtempSync(join(tmpdir(), "adaptive-command-"));
	const oldHome = process.env.HOME;
	process.env.HOME = join(root, "home");
	try {
		const cwd = join(root, "repo");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(process.env.HOME, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(cwd, ".pi", "prompts", "step.md"), "---\nmodel: test/model\n---\nHello $1");
		writeFileSync(join(cwd, ".pi", "prompts", "flow.md"), "---\nchain:\n  - prompt: step\nlimits:\n  maxSteps: 1\n  maxModelCalls: 1\n---\nignored");

		const commands = new Map<string, any>();
		const messages: string[] = [];
		const pi: any = {
			registerCommand(name: string, command: any) { commands.set(name, command); }, registerMessageRenderer() {}, registerTool() {}, getCommands() { return []; }, on(event: string, handler: any) { if (event === "session_start") this.start = handler; },
			async setModel() { return true; }, getThinkingLevel() { return "medium"; }, setThinkingLevel() {}, sendUserMessage(value: string) { messages.push(value); }, sendMessage() {},
		};
		const ctx: any = {
			cwd, model: MODEL, signal: new AbortController().signal, hasUI: false,
			modelRegistry: { find: () => MODEL, getAll: () => [MODEL], getAvailable: () => [MODEL], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }), isUsingOAuth: () => false },
			ui: { notify() {}, setStatus() {}, setWorkingMessage() {}, onTerminalInput() { return () => {}; }, theme: { fg(_x: string, value: string) { return value; } } },
			isIdle: () => false, waitForIdle: async () => {}, sessionManager: { getLeafId: () => "root", getBranch: () => [] }, navigateTree: async () => ({ cancelled: false }),
		};
		promptModelExtension(pi);
		await pi.start({}, ctx);
		assert.ok(commands.has("flow"));
		await commands.get("flow").handler("world", ctx);
		assert.deepEqual(messages, ["Hello world"]);
	} finally {
		process.env.HOME = oldHome;
		rmSync(root, { recursive: true, force: true });
	}
});

for (const [stopReason, expectedTarget] of [["stop", "success"], ["error", "failure"], ["aborted", "failure"]] as const) {
	test(`adaptive command routes real ${stopReason} AssistantMessage outcome`, async () => {
		const root = mkdtempSync(join(tmpdir(), `adaptive-${stopReason}-`));
		const oldHome = process.env.HOME;
		process.env.HOME = join(root, "home");
		try {
			const cwd = join(root, "repo");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			mkdirSync(process.env.HOME, { recursive: true });
			execFileSync("git", ["init", "-q"], { cwd });
			writeFileSync(join(cwd, ".pi", "prompts", "first.md"), "---\nmodel: test/model\n---\nFIRST");
			writeFileSync(join(cwd, ".pi", "prompts", "success.md"), "---\nmodel: test/model\n---\nSUCCESS");
			writeFileSync(join(cwd, ".pi", "prompts", "failure.md"), "---\nmodel: test/model\n---\nFAILURE");
			writeFileSync(join(cwd, ".pi", "prompts", "flow.md"), ["---", "chain:", "  - prompt: first", "  - prompt: success", "    when: succeeded", "  - prompt: failure", "    when: failed", "limits:", "  maxSteps: 3", "  maxModelCalls: 3", "---", "ignored"].join("\n"));
			const commands = new Map<string, any>();
			const messages: string[] = [];
			const branch: any[] = [{ id: "root", type: "message", message: { role: "user", content: "root", timestamp: Date.now() } }];
			const completions = [stopReason, "stop"];
			const pi: any = {
				registerCommand(name: string, command: any) { commands.set(name, command); }, registerMessageRenderer() {}, registerTool() {}, getCommands() { return []; }, on(event: string, handler: any) { if (event === "session_start") this.start = handler; },
				async setModel() { return true; }, getThinkingLevel() { return "medium"; }, setThinkingLevel() {}, sendUserMessage(value: string) { messages.push(value); }, sendMessage() {},
			};
			const ctx: any = {
				cwd, model: MODEL, signal: new AbortController().signal, hasUI: false,
				modelRegistry: { find: () => MODEL, getAll: () => [MODEL], getAvailable: () => [MODEL], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }), isUsingOAuth: () => false },
				ui: { notify() {}, setStatus() {}, setWorkingMessage() {}, onTerminalInput() { return () => {}; }, theme: { fg(_x: string, value: string) { return value; } } },
				isIdle: () => false,
				async waitForIdle() { const reason = completions.shift()!; branch.push({ id: `a${branch.length}`, type: "message", message: { role: "assistant", content: [{ type: "text", text: reason }], stopReason: reason, timestamp: Date.now(), usage: {} } }); },
				sessionManager: { getLeafId: () => branch.at(-1)?.id ?? "root", getBranch: () => branch }, navigateTree: async () => ({ cancelled: false }),
			};
			promptModelExtension(pi);
			await pi.start({}, ctx);
			await commands.get("flow").handler("", ctx);
			assert.deepEqual(messages, ["FIRST", expectedTarget === "success" ? "SUCCESS" : "FAILURE"]);
		} finally {
			process.env.HOME = oldHome;
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("adaptive model-less targets switch back to the chain-start model after a prior step switches models", async () => {
	const root = mkdtempSync(join(tmpdir(), "adaptive-model-inherit-"));
	const oldHome = process.env.HOME; process.env.HOME = join(root, "home");
	try {
		const cwd = join(root, "repo"); mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true }); mkdirSync(process.env.HOME, { recursive: true }); execFileSync("git", ["init", "-q"], { cwd });
		const start = { provider: "test", id: "start" }; const other = { provider: "test", id: "other" };
		writeFileSync(join(cwd, ".pi", "prompts", "switch.md"), "---\nmodel: test/other\n---\nSWITCH");
		writeFileSync(join(cwd, ".pi", "prompts", "inherit.md"), "---\n---\nINHERIT");
		writeFileSync(join(cwd, ".pi", "prompts", "flow.md"), "---\nchain:\n  - prompt: switch\n  - prompt: inherit\nlimits:\n  maxSteps: 2\n  maxModelCalls: 2\n---\nignored");
		const commands = new Map<string, any>(); const setModels: string[] = []; const branch: any[] = [{ id: "root", type: "message", message: { role: "user", content: "root" } }];
		const pi: any = { registerCommand(name: string, command: any) { commands.set(name, command); }, registerMessageRenderer() {}, registerTool() {}, getCommands() { return []; }, on(event: string, handler: any) { if (event === "session_start") this.start = handler; }, async setModel(model: any) { setModels.push(`${model.provider}/${model.id}`); return true; }, getThinkingLevel() { return "medium"; }, setThinkingLevel() {}, sendUserMessage() {}, sendMessage() {} };
		const ctx: any = { cwd, model: start, signal: new AbortController().signal, hasUI: false, modelRegistry: { find: (p: string, id: string) => [start, other].find((m) => m.provider === p && m.id === id), getAll: () => [start, other], getAvailable: () => [start, other] }, ui: { notify() {}, setStatus() {}, setWorkingMessage() {}, onTerminalInput() { return () => {}; }, theme: { fg(_x: string, value: string) { return value; } } }, isIdle: () => false, async waitForIdle() { branch.push({ id: `a${branch.length}`, type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } }); }, sessionManager: { getLeafId: () => branch.at(-1)?.id ?? "root", getBranch: () => branch }, navigateTree: async () => ({ cancelled: false }) };
		promptModelExtension(pi); await pi.start({}, ctx); await commands.get("flow").handler("", ctx);
		assert.deepEqual(setModels, ["test/other", "test/start"]);
	} finally { process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); }
});

test("adaptive approval refusal routes through onBlocked", async () => {
	const root = mkdtempSync(join(tmpdir(), "adaptive-approval-")); const oldHome = process.env.HOME; process.env.HOME = join(root, "home");
	try {
		const cwd = join(root, "repo"); mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true }); mkdirSync(join(cwd, ".pi", "prompt-library"), { recursive: true }); mkdirSync(process.env.HOME, { recursive: true }); execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(cwd, ".pi", "prompt-library", "guarded.md"), "---\nmodel: test/model\nhidden: true\n---\nGUARDED");
		writeFileSync(join(cwd, ".pi", "prompts", "blocked.md"), "---\nmodel: test/model\n---\nBLOCKED ROUTE");
		writeFileSync(join(cwd, ".pi", "prompts", "flow.md"), "---\nchain:\n  - id: guarded\n    prompt: guarded\n    onBlocked: blocked\n  - id: blocked\n    prompt: blocked\nlimits:\n  maxSteps: 2\n  maxModelCalls: 2\n---\nignored");
		const commands = new Map<string, any>(); const messages: string[] = []; const branch: any[] = [{ id: "root", type: "message", message: { role: "user", content: "root" } }];
		const pi: any = { registerCommand(name: string, command: any) { commands.set(name, command); }, registerMessageRenderer() {}, registerTool() {}, getCommands() { return []; }, on(event: string, handler: any) { if (event === "session_start") this.start = handler; }, async setModel() { return true; }, getThinkingLevel() { return "medium"; }, setThinkingLevel() {}, sendUserMessage(value: string) { messages.push(value); }, sendMessage() {} };
		const ctx: any = { cwd, model: MODEL, signal: new AbortController().signal, hasUI: true, modelRegistry: { find: () => MODEL, getAll: () => [MODEL], getAvailable: () => [MODEL] }, ui: { async confirm() { return false; }, notify() {}, setStatus() {}, setWorkingMessage() {}, onTerminalInput() { return () => {}; }, theme: { fg(_x: string, value: string) { return value; } } }, isIdle: () => false, async waitForIdle() { branch.push({ id: `a${branch.length}`, type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } }); }, sessionManager: { getLeafId: () => branch.at(-1)?.id ?? "root", getBranch: () => branch }, navigateTree: async () => ({ cancelled: false }) };
		promptModelExtension(pi); await pi.start({}, ctx); await commands.get("flow").handler("", ctx);
		assert.deepEqual(messages, ["BLOCKED ROUTE"]);
	} finally { process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); }
});

test("adaptive send failure does not leak its pending skill payload into a later turn", async () => {
	const root = mkdtempSync(join(tmpdir(), "adaptive-skill-cleanup-")); const oldHome = process.env.HOME; process.env.HOME = join(root, "home");
	try {
		const cwd = join(root, "repo"); const promptDir = join(cwd, ".pi", "prompts"); const skillPath = join(root, "SKILL.md");
		mkdirSync(promptDir, { recursive: true }); mkdirSync(process.env.HOME, { recursive: true }); execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(skillPath, "DO NOT LEAK");
		writeFileSync(join(promptDir, "skilled.md"), "---\nmodel: test/model\nskill: cleanup\n---\nTASK");
		writeFileSync(join(promptDir, "flow.md"), "---\nchain:\n  - prompt: skilled\nlimits:\n  maxSteps: 1\n  maxModelCalls: 1\n---\nignored");
		const commands = new Map<string, any>(); const handlers = new Map<string, any>();
		const pi: any = { registerCommand(name: string, command: any) { commands.set(name, command); }, registerMessageRenderer() {}, registerTool() {}, getCommands() { return [{ name: "cleanup", source: "skill", sourceInfo: { path: skillPath } }]; }, on(event: string, handler: any) { handlers.set(event, handler); }, async setModel() { return true; }, getThinkingLevel() { return "medium"; }, setThinkingLevel() {}, sendUserMessage() { throw new Error("send-crash"); }, sendMessage() {} };
		const ctx: any = { cwd, model: MODEL, signal: new AbortController().signal, hasUI: false, modelRegistry: { find: () => MODEL, getAll: () => [MODEL], getAvailable: () => [MODEL] }, ui: { notify() {}, setStatus() {}, setWorkingMessage() {}, onTerminalInput() { return () => {}; }, theme: { fg(_x: string, value: string) { return value; } } }, isIdle: () => false, waitForIdle: async () => {}, sessionManager: { getLeafId: () => "root", getBranch: () => [] }, navigateTree: async () => ({ cancelled: false }) };
		promptModelExtension(pi); await handlers.get("session_start")({}, ctx); await commands.get("flow").handler("", ctx);
		assert.equal(await handlers.get("before_agent_start")({ systemPrompt: "BASE" }, ctx), undefined);
	} finally { process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); }
});

test("adaptive run publishes bounded output before routing to its success prompt", async () => {
	const root = mkdtempSync(join(tmpdir(), "adaptive-run-output-")); const oldHome = process.env.HOME; process.env.HOME = join(root, "home");
	try {
		const cwd = join(root, "repo"); const dir = join(cwd, ".pi", "prompts"); mkdirSync(dir, { recursive: true }); mkdirSync(process.env.HOME, { recursive: true }); execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(dir, "check.md"), "---\nrun: printf 'visible output'\nhandoff: never\n---\nignored");
		writeFileSync(join(dir, "after.md"), "---\nmodel: test/model\n---\nAFTER");
		writeFileSync(join(dir, "flow.md"), "---\nchain:\n  - id: check\n    run: check\n    onSuccess: after\n  - id: after\n    prompt: after\nlimits:\n  maxSteps: 2\n  maxModelCalls: 1\n---\nignored");
		const commands = new Map<string, any>(); const events: any[] = []; const branch: any[] = [{ id: "root", type: "message", message: { role: "user", content: "root" } }];
		const pi: any = { registerCommand(name: string, command: any) { commands.set(name, command); }, registerMessageRenderer() {}, registerTool() {}, getCommands() { return []; }, on(event: string, handler: any) { if (event === "session_start") this.start = handler; }, async setModel() { return true; }, getThinkingLevel() { return "medium"; }, setThinkingLevel() {}, sendUserMessage(value: string) { events.push({ kind: "prompt", value }); }, sendMessage(value: any) { events.push({ kind: "result", value }); } };
		const ctx: any = { cwd, model: MODEL, signal: new AbortController().signal, hasUI: false, modelRegistry: { find: () => MODEL, getAll: () => [MODEL], getAvailable: () => [MODEL] }, ui: { notify() {}, setStatus() {}, setWorkingMessage() {}, onTerminalInput() { return () => {}; }, theme: { fg(_x: string, value: string) { return value; } } }, isIdle: () => false, async waitForIdle() { branch.push({ id: "answer", type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } }); }, sessionManager: { getLeafId: () => branch.at(-1)?.id ?? "root", getBranch: () => branch }, navigateTree: async () => ({ cancelled: false }) };
		promptModelExtension(pi); await pi.start({}, ctx); await commands.get("flow").handler("", ctx);
		assert.equal(events[0].kind, "result");
		assert.equal(events[0].value.customType, PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE);
		assert.match(events[0].value.details.stdout, /visible output/);
		assert.deepEqual(events.slice(1).map((event) => event.value), ["AFTER"]);
	} finally { process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); }
});
