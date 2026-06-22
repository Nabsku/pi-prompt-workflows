import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptModelExtension from "../index.js";
import { collectBestOfNRunHistory } from "../best-of-n-run-history.js";
import { formatBestOfNRunHistory } from "../best-of-n-run-history-renderer.js";

class FakePi {
	commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
	setModelCalls: string[] = [];
	userMessages: string[] = [];
	customMessages: any[] = [];
	registerMessageRenderer() {}
	registerCommand(name: string, command: { description: string; handler: (args: string, ctx: any) => Promise<void> }) { this.commands.set(name, command); }
	registerTool() {}
	getCommands() { return []; }
	on() {}
	async setModel(model: { provider: string; id: string }) { this.setModelCalls.push(`${model.provider}/${model.id}`); return true; }
	getThinkingLevel() { return "medium" as const; }
	setThinkingLevel() {}
	sendUserMessage(content: string) { this.userMessages.push(content); }
	sendMessage(message: any) { this.customMessages.push(message); }
}

function withTempDir(run: (root: string) => void | Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-run-history-"));
	return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function captureStdout(run: () => Promise<void>) {
	let output = "";
	const original = process.stdout.write;
	(process.stdout.write as unknown as (chunk: unknown) => boolean) = (chunk: unknown) => {
		output += String(chunk);
		return true;
	};
	return run().then(() => output).finally(() => {
		process.stdout.write = original;
	});
}

function writeRun(root: string, name: string, options: { keepArtifacts?: boolean; malformedLineup?: boolean; omitReport?: boolean } = {}) {
	const runDir = join(root, ".pi", "runs", "best-of-n", name);
	mkdirSync(runDir, { recursive: true });
	if (!options.omitReport) {
		writeFileSync(join(runDir, "report.md"), "# Best-of-N run: compare\n\n- Status: review-complete\n\n## Task\n\nship it\n");
	}
	writeFileSync(
		join(runDir, "lineup.json"),
		options.malformedLineup
			? "{ nope"
			: `${JSON.stringify({
				prompt: "compare",
				status: "review-complete",
				preset: "strict-oracle",
				commit: "ask",
				keepArtifacts: options.keepArtifacts ?? false,
				workers: [{ agent: "worker", effectiveModel: "anthropic/claude", effectiveTask: "work" }],
				reviewers: [{ agent: "reviewer", effectiveModel: "anthropic/claude", effectiveTask: "review" }],
				finalApplier: { agent: "applier", effectiveModel: "anthropic/claude", effectiveTask: "apply" },
			}, null, 2)}\n`,
	);
	if (options.keepArtifacts) {
		writeFileSync(join(runDir, "worker-1.md"), "worker output\n");
		writeFileSync(join(runDir, "reviewer-1.md"), "reviewer output\n");
		writeFileSync(join(runDir, "final-applier.md"), "final output\n");
	}
	return runDir;
}

test("collectBestOfNRunHistory renders useful empty state for missing run root", async () => {
	await withTempDir((root) => {
		const result = collectBestOfNRunHistory(root);
		assert.equal(result.entries.length, 0);
		const output = formatBestOfNRunHistory(result);
		assert.match(output, /No best-of-N compare runs found/);
		assert.match(output, /\.pi\/runs\/best-of-n/);
	});
});

test("collectBestOfNRunHistory summarizes lineup, report path, and not-retained artifacts", async () => {
	await withTempDir((root) => {
		const runDir = writeRun(root, "2026-06-22-compare-abcdef12");
		const result = collectBestOfNRunHistory(root);
		assert.equal(result.entries.length, 1);
		const [entry] = result.entries;
		assert.equal(entry.prompt, "compare");
		assert.equal(entry.status, "review-complete");
		assert.equal(entry.workerCalls, 1);
		assert.equal(entry.reviewerCalls, 1);
		assert.equal(entry.finalApplier, true);
		assert.equal(entry.keepArtifacts, false);
		assert.equal(entry.reportPath, join(runDir, "report.md"));
		assert.deepEqual(entry.artifacts.map((artifact) => [artifact.name, artifact.status]), [
			["final-applier.md", "not-retained"],
			["reviewer-1.md", "not-retained"],
			["worker-1.md", "not-retained"],
		]);
		const output = formatBestOfNRunHistory(result);
		assert.match(output, /Prompt: compare/);
		assert.match(output, /Preset: strict-oracle/);
		assert.match(output, /worker-1\.md: not retained/);
	});
});

test("collectBestOfNRunHistory tolerates malformed lineup and missing report", async () => {
	await withTempDir((root) => {
		writeRun(root, "2026-06-22-bad-abcdef12", { malformedLineup: true, omitReport: true });
		const result = collectBestOfNRunHistory(root);
		assert.equal(result.entries.length, 1);
		const output = formatBestOfNRunHistory(result);
		assert.match(output, /lineup\.json ignored/);
		assert.match(output, /Could not read report\.md/);
		assert.match(output, /Status: unknown/);
	});
});

test("collectBestOfNRunHistory rejects symlinked run dirs and symlinked artifact files", async () => {
	await withTempDir((root) => {
		const realRun = writeRun(root, "2026-06-22-real-abcdef12", { keepArtifacts: true });
		const escaped = join(root, "escaped.md");
		writeFileSync(escaped, "secret\n");
		rmSync(join(realRun, "worker-1.md"));
		symlinkSync(escaped, join(realRun, "worker-1.md"));
		const runRoot = join(root, ".pi", "runs", "best-of-n");
		symlinkSync(root, join(runRoot, "2026-06-22-linked-abcdef12"));

		const result = collectBestOfNRunHistory(root);
		assert.equal(result.entries.length, 1);
		assert.match(result.diagnostics.join("\n"), /symlink run directories are not read/);
		const worker = result.entries[0]!.artifacts.find((artifact) => artifact.name === "worker-1.md");
		assert.equal(worker?.status, "rejected");
		assert.match(worker?.diagnostic ?? "", /symlink artifacts are not read/);
	});
});

test("collectBestOfNRunHistory rejects symlinked run-root ancestors", async () => {
	await withTempDir((root) => {
		const external = mkdtempSync(join(tmpdir(), "pi-prompt-run-history-external-"));
		try {
			mkdirSync(join(external, "runs"), { recursive: true });
			symlinkSync(external, join(root, ".pi"));
			writeRun(external, "2026-06-22-escaped-abcdef12");
			const result = collectBestOfNRunHistory(root);
			assert.equal(result.entries.length, 0);
			assert.match(result.diagnostics.join("\n"), /Run root component .*\.pi.* is a symlink/);
		} finally {
			rmSync(external, { recursive: true, force: true });
		}
	});
});

test("collectBestOfNRunHistory caps huge artifact reads", async () => {
	await withTempDir((root) => {
		const runDir = writeRun(root, "2026-06-22-huge-abcdef12", { keepArtifacts: true });
		writeFileSync(join(runDir, "reviewer-1.md"), "x".repeat(128));
		const result = collectBestOfNRunHistory(root, { maxBytes: 16 });
		const reviewer = result.entries[0]!.artifacts.find((artifact) => artifact.name === "reviewer-1.md");
		assert.equal(reviewer?.status, "truncated");
		assert.match(reviewer?.diagnostic ?? "", /truncated to 16 bytes/);
	});
});

test("collectBestOfNRunHistory parses large lineup metadata without artifact preview cap", async () => {
	await withTempDir((root) => {
		const runDir = writeRun(root, "2026-06-22-large-lineup-abcdef12");
		writeFileSync(
			join(runDir, "lineup.json"),
			`${JSON.stringify({
				prompt: "compare",
				status: "review-complete",
				keepArtifacts: false,
				args: ["x".repeat(700 * 1024)],
				workers: [{ agent: "worker", effectiveModel: "anthropic/claude", effectiveTask: "w".repeat(700 * 1024) }],
				reviewers: [{ agent: "reviewer", effectiveModel: "anthropic/claude", effectiveTask: "r".repeat(700 * 1024) }],
			}, null, 2)}\n`,
		);
		const result = collectBestOfNRunHistory(root, { maxBytes: 64 });
		const [entry] = result.entries;
		assert.equal(entry.status, "review-complete");
		assert.equal(entry.workerCalls, 1);
		assert.equal(entry.reviewerCalls, 1);
		assert.deepEqual(entry.artifacts.map((artifact) => [artifact.name, artifact.status]), [
			["reviewer-1.md", "not-retained"],
			["worker-1.md", "not-retained"],
		]);
	});
});

test("collectBestOfNRunHistory reports missing files when retained artifacts are expected", async () => {
	await withTempDir((root) => {
		const runDir = writeRun(root, "2026-06-22-missing-retained-abcdef12", { keepArtifacts: true });
		rmSync(join(runDir, "worker-1.md"));
		const result = collectBestOfNRunHistory(root);
		const worker = result.entries[0]!.artifacts.find((artifact) => artifact.name === "worker-1.md");
		assert.equal(worker?.status, "missing");
	});
});

test("collectBestOfNRunHistory caps lineup slot artifact probing", async () => {
	await withTempDir((root) => {
		const runDir = writeRun(root, "2026-06-22-many-slots-abcdef12");
		writeFileSync(join(runDir, "lineup.json"), `${JSON.stringify({
			prompt: "compare",
			status: "review-complete",
			keepArtifacts: false,
			workers: Array.from({ length: 150 }, () => ({ agent: "worker", effectiveModel: "anthropic/claude", effectiveTask: "work" })),
			reviewers: Array.from({ length: 125 }, () => ({ agent: "reviewer", effectiveModel: "anthropic/claude", effectiveTask: "review" })),
		}, null, 2)}\n`);
		const result = collectBestOfNRunHistory(root);
		assert.equal(result.entries[0]!.artifacts.filter((artifact) => artifact.name.startsWith("worker-")).length, 100);
		assert.equal(result.entries[0]!.artifacts.filter((artifact) => artifact.name.startsWith("reviewer-")).length, 100);
		assert.match(result.entries[0]!.diagnostics.join("\n"), /150 worker slots/);
		assert.match(result.entries[0]!.diagnostics.join("\n"), /125 reviewer slots/);
	});
});

test("collectBestOfNRunHistory caps discovered artifact probing", async () => {
	await withTempDir((root) => {
		const runDir = writeRun(root, "2026-06-22-many-files-abcdef12");
		writeFileSync(join(runDir, "lineup.json"), `${JSON.stringify({
			prompt: "compare",
			status: "review-complete",
			keepArtifacts: false,
			workers: [],
			reviewers: [],
		}, null, 2)}\n`);
		for (let index = 1; index <= 150; index += 1) writeFileSync(join(runDir, `worker-${index}.md`), `worker ${index}\n`);
		for (let index = 1; index <= 125; index += 1) writeFileSync(join(runDir, `reviewer-${index}.md`), `reviewer ${index}\n`);
		const result = collectBestOfNRunHistory(root);
		assert.equal(result.entries[0]!.artifacts.filter((artifact) => artifact.name.startsWith("worker-")).length, 100);
		assert.equal(result.entries[0]!.artifacts.filter((artifact) => artifact.name.startsWith("reviewer-")).length, 100);
		assert.match(result.entries[0]!.diagnostics.join("\n"), /Discovered worker artifact inventory capped at 100/);
		assert.match(result.entries[0]!.diagnostics.join("\n"), /Discovered reviewer artifact inventory capped at 100/);
	});
});

test("collectBestOfNRunHistory reports run-root listing failures without throwing", async () => {
	if (process.getuid?.() === 0) return;
	await withTempDir((root) => {
		const runRoot = join(root, ".pi", "runs", "best-of-n");
		mkdirSync(runRoot, { recursive: true });
		chmodSync(runRoot, 0o000);
		try {
			const result = collectBestOfNRunHistory(root);
			assert.equal(result.entries.length, 0);
			assert.match(result.diagnostics.join("\n"), /Could not list run root/);
		} finally {
			chmodSync(runRoot, 0o700);
		}
	});
});

test("formatBestOfNRunHistory escapes control characters from persisted run data", async () => {
	await withTempDir((root) => {
		const runDir = writeRun(root, "2026-06-22-bad\u001b[2J-name\u0007-c1\u009b31m", { keepArtifacts: true });
		writeFileSync(join(runDir, "report.md"), "# Best-of-N run: compare\u001b[31m\u009b31m\n\n- Status: review-complete\u0007\n");
		writeFileSync(join(runDir, "lineup.json"), `${JSON.stringify({
			prompt: "compare\u001b[H",
			status: "review-complete\u001b[31m\u009b31m",
			preset: "oracle\u0007",
			keepArtifacts: true,
			workers: [{ agent: "worker", effectiveModel: "anthropic/claude", effectiveTask: "work" }],
			reviewers: [],
		}, null, 2)}\n`);
		const output = formatBestOfNRunHistory(collectBestOfNRunHistory(root));
		assert.doesNotMatch(output, /[\u001b\u0007\u009b]/);
		assert.match(output, /bad\\u001b\[2J-name\\u0007/);
		assert.match(output, /c1\\u009b31m/);
		assert.match(output, /compare\\u001b\[H/);
		assert.match(output, /review-complete\\u001b\[31m\\u009b31m/);
		assert.match(output, /oracle\\u0007/);
	});
});

test("compare-runs command is read-only and routes output through UI notifications by default", async () => {
	await withTempDir(async (root) => {
		writeRun(root, "2026-06-22-compare-abcdef12", { keepArtifacts: true });
		const pi = new FakePi();
		promptModelExtension(pi as never);
		assert.ok(pi.commands.has("compare-runs"));
		assert.ok(pi.commands.has("best-of-n-runs"));
		const ctx = {
			cwd: root,
			hasUI: true,
			model: { provider: "anthropic", id: "claude" },
			ui: { notify(message: string, type: string) { pi.customMessages.push({ message, type }); } },
			isIdle() { return false; },
			async waitForIdle() {},
			modelRegistry: { getAll() { return []; }, getAvailable() { return []; } },
		};
		const before = JSON.stringify(resultSnapshot(root));
		const output = await captureStdout(() => pi.commands.get("compare-runs")!.handler("--limit 1", ctx));
		const after = JSON.stringify(resultSnapshot(root));
		assert.equal(after, before);
		assert.equal(pi.setModelCalls.length, 0);
		assert.equal(pi.userMessages.length, 0);
		assert.equal(output, "");
		assert.equal(pi.customMessages.length, 1);
		assert.match(pi.customMessages[0].message, /# Compare run history/);
		assert.match(pi.customMessages[0].message, /worker-1\.md: retained/);
	});
});

test("compare-runs --plain writes to stdout", async () => {
	await withTempDir(async (root) => {
		writeRun(root, "2026-06-22-compare-plain-abcdef12", { keepArtifacts: true });
		const pi = new FakePi();
		promptModelExtension(pi as never);
		const ctx = {
			cwd: root,
			hasUI: true,
			model: { provider: "anthropic", id: "claude" },
			ui: { notify(message: string, type: string) { pi.customMessages.push({ message, type }); } },
			isIdle() { return false; },
			async waitForIdle() {},
			modelRegistry: { getAll() { return []; }, getAvailable() { return []; } },
		};
		const output = await captureStdout(() => pi.commands.get("compare-runs")!.handler("--limit 1 --plain", ctx));
		assert.match(output, /# Compare run history/);
		assert.match(output, /worker-1\.md: retained/);
		assert.equal(pi.customMessages.length, 0);
	});
});

function resultSnapshot(root: string) {
	return collectBestOfNRunHistory(root).entries.map((entry) => ({
		name: entry.name,
		artifacts: entry.artifacts.map((artifact) => [artifact.name, artifact.status, artifact.size]),
	}));
}
