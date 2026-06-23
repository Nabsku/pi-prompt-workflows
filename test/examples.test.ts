import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadPromptsWithModel } from "../prompt-loader.js";

const repoRoot = resolve(import.meta.dirname, "..");

function withExamplePrompts(run: (cwd: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-workflows-examples-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		const cwd = join(root, "project");
		const promptDir = join(cwd, ".pi", "prompts");
		mkdirSync(promptDir, { recursive: true });
		cpSync(join(repoRoot, "examples"), promptDir, { recursive: true });
		run(cwd);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

test("packaged examples load as prompt commands", () => {
	withExamplePrompts((cwd) => {
		const result = loadPromptsWithModel(cwd);
		const diagnostics = result.diagnostics.map((item) => item.message).join("\n");

		assert.equal(diagnostics, "");
		assert.deepEqual([...result.prompts.keys()].sort(), ["best-of-n", "best-of-n-smoke", "hello", "review"]);
		assert.deepEqual(result.prompts.get("hello")?.models, []);
		assert.deepEqual(result.prompts.get("review")?.models, []);
		assert.equal(result.prompts.get("best-of-n-smoke")?.workers?.length, 1);
		assert.equal(result.prompts.get("best-of-n-smoke")?.reviewers?.length, 1);
		assert.equal(result.prompts.get("best-of-n-smoke")?.finalApplier, undefined);
	});
});
