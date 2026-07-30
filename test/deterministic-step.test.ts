import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeterministicPreamble, formatDeterministicExecution, runDeterministicStep, shouldHandoffToLlm } from "../deterministic-step.ts";
import type { DeterministicStep } from "../prompt-loader.ts";
import { assertProcessExtinct } from "./process-extinction.ts";

async function withTempDir(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-deterministic-step-"));
	try {
		await run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("runDeterministicStep resolves relative script paths from the prompt file first", async () => {
	await withTempDir(async (root) => {
		const promptDir = join(root, "prompts");
		const repoDir = join(root, "repo");
		mkdirSync(promptDir, { recursive: true });
		mkdirSync(repoDir, { recursive: true });
		const scriptPath = join(promptDir, "echo.sh");
		writeFileSync(scriptPath, "#!/bin/bash\nprintf 'from-script'\n");
		await import("node:fs/promises").then(({ chmod }) => chmod(scriptPath, 0o755));

		const result = await runDeterministicStep(
			{ filePath: join(promptDir, "demo.md") } as never,
			{ execution: { kind: "script", path: "./echo.sh", args: [] }, handoff: "always", nonInteractive: true },
			repoDir,
		);

		assert.equal(result.exitCode, 0);
		assert.equal(result.nonInteractive, true);
		assert.equal(result.resolvedScriptPath, scriptPath);
		assert.equal(result.stdout, "from-script");
	});
});

test("runDeterministicStep applies env overrides and caps stored output", async () => {
	await withTempDir(async (root) => {
		const promptDir = join(root, "prompts");
		const repoDir = join(root, "repo");
		mkdirSync(promptDir, { recursive: true });
		mkdirSync(repoDir, { recursive: true });

		const result = await runDeterministicStep(
			{ filePath: join(promptDir, "env.md") } as never,
			{
				execution: {
					kind: "run",
					command: "python3 - <<'PY'\nimport os\nprint(os.environ.get('CI', 'missing'))\nprint(os.environ.get('SPECIAL', 'missing'))\nprint('x' * 20050, end='')\nPY",
				},
				handoff: "always",
				nonInteractive: true,
				env: { SPECIAL: "present" },
			},
			repoDir,
		);

		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /^1\npresent\n/);
		assert.equal(result.stdoutTruncated, true);
		assert.ok(result.stdout.length < result.stdoutTotalChars);
		assert.ok(result.stdoutTotalChars > 20_000);
	});
});

test("buildDeterministicPreamble uses structured metadata and truncation markers", () => {
	const preamble = buildDeterministicPreamble({
		execution: { kind: "run", command: "printf 'hi'" },
		cwd: "/tmp/demo",
		nonInteractive: true,
		exitCode: 0,
		stdout: "a".repeat(20),
		stdoutTotalChars: 20,
		stdoutTotalLines: 1,
		stdoutTruncated: false,
		stderr: "b".repeat(20),
		stderrTotalChars: 20,
		stderrTotalLines: 1,
		stderrTruncated: false,
		durationMs: 5,
		timedOut: false,
	}, { maxStdoutChars: 5, maxStderrChars: 5 });

	assert.match(preamble, /^\[Deterministic step\]/);
	assert.match(preamble, /status: succeeded/);
	assert.match(preamble, /executionKind: run/);
	assert.match(preamble, /nonInteractive: true/);
	assert.match(preamble, /timedOut: false/);
	assert.match(preamble, /\[stdout\]\nlineCount: 1\ncharCount: 20\ntruncated: true\nomittedChars: 15\npreview:/);
	assert.match(preamble, /stdout truncated/);
	assert.match(preamble, /\[stderr\]\nlineCount: 1\ncharCount: 20\ntruncated: true\nomittedChars: 15\npreview:/);
	assert.match(preamble, /stderr truncated/);
});

test("buildDeterministicPreamble escapes multiline commands so field structure stays intact", () => {
	const preamble = buildDeterministicPreamble({
		execution: { kind: "run", command: "python3 - <<'PY'\nprint('x')\nPY" },
		cwd: "/tmp/demo",
		nonInteractive: true,
		exitCode: 0,
		stdout: "ok",
		stdoutTotalChars: 2,
		stdoutTotalLines: 1,
		stdoutTruncated: false,
		stderr: "",
		stderrTotalChars: 0,
		stderrTotalLines: 0,
		stderrTruncated: false,
		durationMs: 1,
		timedOut: false,
	});

	assert.match(preamble, /command: "python3 - <<'PY'\\nprint\('x'\)\\nPY"/);
	assert.doesNotMatch(preamble, /^print\('x'\)$/m);
});

test("shouldHandoffToLlm follows the configured exit-code policy", () => {
	const step = (handoff: DeterministicStep["handoff"]) => ({ execution: { kind: "run", command: "true" }, handoff, nonInteractive: true });
	assert.equal(shouldHandoffToLlm(step("always"), { exitCode: 1 }), true);
	assert.equal(shouldHandoffToLlm(step("never"), { exitCode: 0 }), false);
	assert.equal(shouldHandoffToLlm(step("on-success"), { exitCode: 0 }), true);
	assert.equal(shouldHandoffToLlm(step("on-success"), { exitCode: 2 }), false);
	assert.equal(shouldHandoffToLlm(step("on-failure"), { exitCode: 2 }), true);
	assert.equal(shouldHandoffToLlm(step("on-failure"), { exitCode: 0 }), false);
});

test("buildDeterministicPreamble includes failure metadata and empty sections clearly", () => {
	const preamble = buildDeterministicPreamble({
		execution: { kind: "script", path: "./demo.sh", args: ["--x"] },
		resolvedScriptPath: "/tmp/demo.sh",
		cwd: "/tmp/repo",
		nonInteractive: false,
		exitCode: 9,
		signal: "SIGTERM",
		stdout: "",
		stdoutTotalChars: 0,
		stdoutTotalLines: 0,
		stdoutTruncated: false,
		stderr: "boom\nmore",
		stderrTotalChars: 9,
		stderrTotalLines: 2,
		stderrTruncated: false,
		durationMs: 42,
		timedOut: true,
	});

	assert.match(preamble, /status: failed/);
	assert.match(preamble, /executionKind: script/);
	assert.match(preamble, /resolvedScript: \/tmp\/demo\.sh/);
	assert.match(preamble, /signal: SIGTERM/);
	assert.match(preamble, /nonInteractive: false/);
	assert.match(preamble, /timedOut: true/);
	assert.match(preamble, /\[stdout\]\nlineCount: 0\ncharCount: 0\ntruncated: false\npreview:\n\(empty\)/);
	assert.match(preamble, /\[stderr\]\nlineCount: 2\ncharCount: 9\ntruncated: false\npreview:\nboom/);
});

test("formatDeterministicExecution formats command and script executions for display", () => {
	assert.match(formatDeterministicExecution({ kind: "run", command: "git push" }), /git push/);
	assert.match(formatDeterministicExecution({ kind: "command", command: "git", args: ["status"], shell: false }), /'git' 'status'/);
	assert.match(formatDeterministicExecution({ kind: "script", path: "./demo.sh", args: ["--x"] }, "/tmp/demo.sh"), /\/tmp\/demo\.sh/);
});

test("abort escalates a TERM-resistant same-group descendant after the leader exits", { skip: process.platform === "win32" }, async () => {
	await withTempDir(async (root) => {
		const pidFile = join(root, "descendant.pid");
		const leader = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)\"],{stdio:['ignore','ignore','ignore']}); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);`;
		const command = `node -e ${JSON.stringify(leader)}`;
		const controller = new AbortController();
		const running = runDeterministicStep({ filePath: join(root, "prompt.md") } as never, { execution: { kind: "run", command }, handoff: "never", nonInteractive: true, timeoutMs: 8_000 }, root, controller.signal);
		const readyDeadline = performance.now() + 2_000;
		while (!existsSync(pidFile) && performance.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(existsSync(pidFile), true, "descendant PID must be published within the bounded readiness wait");
		const started = performance.now();
		controller.abort();
		const result = await running;
		assert.equal(result.timedOut, false);
		assert.equal(result.termination, "cancelled");
		assert.equal(result.processGroupExtinct, true);
		assert.ok(performance.now() - started < 2_000, "cleanup must not leak to the 8s deadline");
		const pid = Number((await import("node:fs")).readFileSync(pidFile, "utf8"));
		await assertProcessExtinct(pid);
	});
});
