import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import promptModelExtension from "../index.ts";

const MODEL = { provider: "test", id: "model" };

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
