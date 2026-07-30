import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { loadPromptsWithModel } from "../prompt-loader.js";
import { validatePromptTemplates } from "../prompt-validation.js";

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
		execFileSync("git", ["init", "-q"], { cwd });
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
		assert.deepEqual([...result.prompts.keys()].sort(), ["adaptive-review", "adaptive-status", "adaptive-test", "adaptive-validate", "best-of-n", "best-of-n-smoke", "hello", "review"]);
		assert.deepEqual(result.prompts.get("hello")?.models, []);
		assert.deepEqual(result.prompts.get("review")?.models, []);
		assert.equal(result.prompts.get("best-of-n-smoke")?.workers?.length, 1);
		assert.equal(result.prompts.get("best-of-n-smoke")?.reviewers?.length, 1);
		assert.equal(result.prompts.get("best-of-n-smoke")?.finalApplier, undefined);
	});
});

test("packaged adaptive examples load and validate with their companion targets", () => {
	withExamplePrompts((cwd) => {
		const loaded = loadPromptsWithModel(cwd, true, { includeAdaptiveChains: true });
		assert.ok(loaded.prompts.has("adaptive-fix-review"));
		assert.ok(loaded.prompts.has("adaptive-validation-review"));
		const validation = validatePromptTemplates(cwd);
		assert.equal(validation.ok, true, validation.diagnostics.map((item) => item.message).join("\n"));
		assert.equal(validation.adaptiveChains?.length, 2);
	});
});

test("packaged Git checks use exact hardened argv and bypass configured helpers", () => {
	withExamplePrompts((cwd) => {
		const loaded = loadPromptsWithModel(cwd);
		const expectedStatusArgs = ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1"];
		const expectedDiffCommand = "git --no-optional-locks -c core.fsmonitor=false --no-pager diff --cached --no-ext-diff --no-textconv --check";
		for (const name of ["adaptive-status", "adaptive-validate"]) {
			const execution = loaded.prompts.get(name)?.deterministic?.execution;
			assert.equal(execution?.kind, "command");
			assert.equal(execution?.command, "git");
			assert.deepEqual(execution?.args, expectedStatusArgs);
		}
		const diffExecution = loaded.prompts.get("adaptive-test")?.deterministic?.execution;
		assert.equal(diffExecution?.kind, "run");
		assert.equal(diffExecution?.command, expectedDiffCommand);

		const markerDir = join(cwd, "helper-markers");
		mkdirSync(markerDir);
		const helper = (name: string) => {
			const script = join(markerDir, `${name}.sh`);
			writeFileSync(script, `#!/bin/sh\nprintf invoked >${JSON.stringify(join(markerDir, name))}\nexit 97\n`);
			chmodSync(script, 0o755);
			return script;
		};
		const markers = {
			fsmonitor: join(markerDir, "fsmonitor"),
			externalDiff: join(markerDir, "external-diff"),
			textconv: join(markerDir, "textconv"),
			pager: join(markerDir, "pager"),
			editor: join(markerDir, "editor"),
			clean: join(markerDir, "clean"),
			process: join(markerDir, "process"),
		};
		const fsmonitor = helper("fsmonitor");
		const externalDiff = helper("external-diff");
		const textconv = helper("textconv");
		const pager = helper("pager");
		const editor = helper("editor");
		const clean = helper("clean");
		const processFilter = helper("process");

		writeFileSync(join(cwd, ".gitattributes"), "sample.txt diff=hostile filter=hostile\n");
		writeFileSync(join(cwd, "sample.txt"), "clean\n");
		execFileSync("git", ["add", ".gitattributes", "sample.txt"], { cwd });
		execFileSync("git", ["-c", "user.name=Example Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd });
		execFileSync("git", ["config", "core.fsmonitor", fsmonitor], { cwd });
		execFileSync("git", ["config", "diff.external", externalDiff], { cwd });
		execFileSync("git", ["config", "diff.hostile.textconv", textconv], { cwd });
		execFileSync("git", ["config", "filter.hostile.clean", clean], { cwd });
		execFileSync("git", ["config", "filter.hostile.process", processFilter], { cwd });
		writeFileSync(join(cwd, "sample.txt"), "changed\n");

		const hostileEnv = { ...process.env, GIT_PAGER: pager, PAGER: pager, GIT_EDITOR: editor, EDITOR: editor };
		const indexPath = join(cwd, ".git", "index");
		const indexBefore = readFileSync(indexPath);
		for (const name of ["adaptive-status", "adaptive-validate"]) {
			const execution = loaded.prompts.get(name)!.deterministic!.execution;
			assert.equal(execution.kind, "command");
			if (execution.kind !== "command") continue;
			execFileSync(execution.command, execution.args, { cwd, env: hostileEnv, timeout: 5000 });
			assert.deepEqual(readFileSync(indexPath), indexBefore, `${name} must not refresh the index`);
		}
		assert.equal(existsSync(markers.fsmonitor), false, "status must disable configured fsmonitor");

		assert.equal(diffExecution!.kind, "run");
		if (diffExecution!.kind !== "run") return;
		execFileSync("/bin/sh", ["-c", diffExecution!.command], { cwd, env: hostileEnv, timeout: 5000 });
		assert.equal(existsSync(markers.clean), false, "staged-only check must not invoke configured clean filters");
		assert.equal(existsSync(markers.process), false, "staged-only check must not invoke configured process filters");
		execFileSync("git", ["config", "--unset", "filter.hostile.clean"], { cwd });
		execFileSync("git", ["config", "--unset", "filter.hostile.process"], { cwd });
		writeFileSync(join(cwd, "sample.txt"), "staged trailing whitespace   \n");
		execFileSync("git", ["add", "sample.txt"], { cwd });
		rmSync(markers.fsmonitor, { force: true });
		assert.throws(
			() => execFileSync("/bin/sh", ["-c", diffExecution!.command], { cwd, env: hostileEnv, timeout: 5000 }),
			"staged whitespace errors must fail the combined check",
		);
		for (const marker of [markers.fsmonitor, markers.externalDiff, markers.textconv, markers.pager, markers.editor]) {
			assert.equal(existsSync(marker), false, `helper must not run: ${marker}`);
		}
	});
});
