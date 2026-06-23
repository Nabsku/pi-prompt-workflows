import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptModelExtension from "../index.js";
import { collectBestOfNRunHistory } from "../best-of-n-run-history.js";
import { formatBestOfNRunDetail, formatBestOfNRunHistory } from "../best-of-n-run-history-renderer.js";
import { CompareRunDetailInspector, CompareRunPicker, buildCompareRunCatalog, createCompareRunDetailViewModel } from "../best-of-n-run-history-tui.js";
import {
	compareRunRoot,
	createSymlinkedArtifact,
	createSymlinkedRunDir,
	createSymlinkedRunRoot,
	makeUnreadable,
	supportsPermissionDenialFixtures,
	terminalControlPayload,
	withAdversarialFixtureDir,
	writeCompareRun,
} from "./fixtures/compare-adversarial-fixtures.js";

class FakePi {
	commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
	setModelCalls: string[] = [];
	userMessages: string[] = [];
	customMessages: any[] = [];
	customResults: unknown[] = [];
	customComponents: unknown[] = [];
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

test("collectBestOfNRunHistory renders useful empty state for missing run root", async () => {
	await withAdversarialFixtureDir((root) => {
		const result = collectBestOfNRunHistory(root);
		assert.equal(result.entries.length, 0);
		const output = formatBestOfNRunHistory(result);
		assert.match(output, /No best-of-N compare runs found/);
		assert.match(output, /\.pi\/runs\/best-of-n/);
	});
});

test("adversarial fixture cleanup does not follow symlink escapes", async () => {
	const external = mkdtempSync(join(tmpdir(), "pi-prompt-fixture-escape-"));
	const marker = join(external, "marker.txt");
	try {
		writeFileSync(marker, "keep\n");
		await withAdversarialFixtureDir((root) => {
			createSymlinkedRunDir(root, "2026-06-22-linked-abcdef12", external);
		});
		assert.equal(existsSync(marker), true);
	} finally {
		rmSync(external, { recursive: true, force: true });
	}
});

test("collectBestOfNRunHistory summarizes lineup, report path, and not-retained artifacts", async () => {
	await withAdversarialFixtureDir((root) => {
		const runDir = writeCompareRun(root, "2026-06-22-compare-abcdef12");
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
	await withAdversarialFixtureDir((root) => {
		writeCompareRun(root, "2026-06-22-bad-abcdef12", { malformedLineup: true, omitReport: true });
		const result = collectBestOfNRunHistory(root);
		assert.equal(result.entries.length, 1);
		const output = formatBestOfNRunHistory(result);
		assert.match(output, /lineup\.json ignored/);
		assert.match(output, /Could not read report\.md/);
		assert.match(output, /Status: unknown/);
	});
});

test("collectBestOfNRunHistory rejects symlinked run dirs and symlinked artifact files", async () => {
	await withAdversarialFixtureDir((root) => {
		const realRun = writeCompareRun(root, "2026-06-22-real-abcdef12", { keepArtifacts: true });
		const escaped = join(root, "escaped.md");
		writeFileSync(escaped, "secret\n");
		createSymlinkedArtifact(realRun, "worker-1.md", escaped);
		createSymlinkedRunDir(root, "2026-06-22-linked-abcdef12", root);

		const result = collectBestOfNRunHistory(root);
		assert.equal(result.entries.length, 1);
		assert.match(result.diagnostics.join("\n"), /symlink run directories are not read/);
		const worker = result.entries[0]!.artifacts.find((artifact) => artifact.name === "worker-1.md");
		assert.equal(worker?.status, "rejected");
		assert.match(worker?.diagnostic ?? "", /symlink artifacts are not read/);
	});
});

test("collectBestOfNRunHistory rejects symlinked run-root ancestors", async () => {
	await withAdversarialFixtureDir((root) => {
		const external = mkdtempSync(join(tmpdir(), "pi-prompt-run-history-external-"));
		try {
			writeCompareRun(external, "2026-06-22-escaped-abcdef12");
			createSymlinkedRunRoot(root, compareRunRoot(external));
			const result = collectBestOfNRunHistory(root);
			assert.equal(result.entries.length, 0);
			assert.match(result.diagnostics.join("\n"), /Run root component .*best-of-n.* is a symlink/);
		} finally {
			rmSync(external, { recursive: true, force: true });
		}
	});
});

test("collectBestOfNRunHistory caps huge artifact reads", async () => {
	await withAdversarialFixtureDir((root) => {
		writeCompareRun(root, "2026-06-22-huge-abcdef12", { keepArtifacts: true, hugeArtifactBytes: 128 });
		const result = collectBestOfNRunHistory(root, { maxBytes: 16 });
		const reviewer = result.entries[0]!.artifacts.find((artifact) => artifact.name === "reviewer-1.md");
		assert.equal(reviewer?.status, "truncated");
		assert.match(reviewer?.diagnostic ?? "", /truncated to 16 bytes/);
	});
});

test("collectBestOfNRunHistory parses large lineup metadata without artifact preview cap", async () => {
	await withAdversarialFixtureDir((root) => {
		const runDir = writeCompareRun(root, "2026-06-22-large-lineup-abcdef12");
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
	await withAdversarialFixtureDir((root) => {
		const runDir = writeCompareRun(root, "2026-06-22-missing-retained-abcdef12", { keepArtifacts: true });
		rmSync(join(runDir, "worker-1.md"));
		const result = collectBestOfNRunHistory(root);
		const worker = result.entries[0]!.artifacts.find((artifact) => artifact.name === "worker-1.md");
		assert.equal(worker?.status, "missing");
	});
});

test("collectBestOfNRunHistory caps lineup slot artifact probing", async () => {
	await withAdversarialFixtureDir((root) => {
		writeCompareRun(root, "2026-06-22-many-slots-abcdef12", { manyWorkerSlots: 150, manyReviewerSlots: 125 });
		const result = collectBestOfNRunHistory(root);
		assert.equal(result.entries[0]!.artifacts.filter((artifact) => artifact.name.startsWith("worker-")).length, 100);
		assert.equal(result.entries[0]!.artifacts.filter((artifact) => artifact.name.startsWith("reviewer-")).length, 100);
		assert.match(result.entries[0]!.diagnostics.join("\n"), /150 worker slots/);
		assert.match(result.entries[0]!.diagnostics.join("\n"), /125 reviewer slots/);
	});
});

test("collectBestOfNRunHistory caps discovered artifact probing", async () => {
	await withAdversarialFixtureDir((root) => {
		writeCompareRun(root, "2026-06-22-many-files-abcdef12", {
			lineup: { prompt: "compare", status: "review-complete", keepArtifacts: false, workers: [], reviewers: [] },
			manyWorkerArtifacts: 150,
			manyReviewerArtifacts: 125,
		});
		const result = collectBestOfNRunHistory(root);
		assert.equal(result.entries[0]!.artifacts.filter((artifact) => artifact.name.startsWith("worker-")).length, 100);
		assert.equal(result.entries[0]!.artifacts.filter((artifact) => artifact.name.startsWith("reviewer-")).length, 100);
		assert.match(result.entries[0]!.diagnostics.join("\n"), /Discovered worker artifact inventory capped at 100/);
		assert.match(result.entries[0]!.diagnostics.join("\n"), /Discovered reviewer artifact inventory capped at 100/);
	});
});

test("collectBestOfNRunHistory reports run-root listing failures without throwing", async () => {
	if (!supportsPermissionDenialFixtures()) return;
	await withAdversarialFixtureDir((root) => {
		writeCompareRun(root, "2026-06-22-unreadable-root-abcdef12");
		const restorePermissions = makeUnreadable(compareRunRoot(root));
		try {
			const result = collectBestOfNRunHistory(root);
			assert.equal(result.entries.length, 0);
			assert.match(result.diagnostics.join("\n"), /Could not list run root/);
		} finally {
			restorePermissions();
		}
	});
});

test("formatBestOfNRunHistory escapes control characters from persisted run data", async () => {
	await withAdversarialFixtureDir((root) => {
		const runDir = writeCompareRun(root, `2026-06-22-${terminalControlPayload}`, { keepArtifacts: true });
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
		assert.match(output, /bad-name\\u0007-c1/);
		assert.match(output, /Prompt: compare/);
		assert.match(output, /Status: review-complete/);
		assert.match(output, /oracle\\u0007/);
	});
});

test("compare-runs command is read-only and routes output through UI notifications by default", async () => {
	await withAdversarialFixtureDir(async (root) => {
		writeCompareRun(root, "2026-06-22-compare-abcdef12", { keepArtifacts: true });
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
	await withAdversarialFixtureDir(async (root) => {
		writeCompareRun(root, "2026-06-22-compare-plain-abcdef12", { keepArtifacts: true });
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

function createCompareRunTuiContext(root: string, pi: FakePi) {
	return {
		cwd: root,
		mode: "tui",
		hasUI: true,
		model: { provider: "anthropic", id: "claude" },
		ui: {
			notify(message: string, type: string) { pi.customMessages.push({ message, type }); },
			async custom(factory: (...args: any[]) => unknown) {
				const component = factory({}, {}, {}, (value: unknown) => value);
				pi.customComponents.push(component);
				return pi.customResults.length ? pi.customResults.shift() : component;
			},
		},
		isIdle() { return false; },
		async waitForIdle() {},
		modelRegistry: { getAll() { return []; }, getAvailable() { return []; } },
	};
}

test("formatBestOfNRunDetail exposes read-only summary, lineup, report, artifacts, and diagnostics", async () => {
	await withAdversarialFixtureDir((root) => {
		writeCompareRun(root, "2026-06-22-detail-abcdef12", {
			keepArtifacts: true,
			workerArtifactText: `worker output ${terminalControlPayload}\n`,
			reportText: `# Detail report\n\n- Status: review-complete\n\n${terminalControlPayload}\n`,
		});
		const result = collectBestOfNRunHistory(root);
		const output = formatBestOfNRunDetail(result, result.entries[0]!);

		assert.match(output, /# Compare run detail/);
		assert.match(output, /## Summary/);
		assert.match(output, /## Lineup/);
		assert.match(output, /## Report/);
		assert.match(output, /## Artifacts/);
		assert.match(output, /## Diagnostics/);
		assert.match(output, /worker output bad-name\\u0007-c1/);
		assert.doesNotMatch(output, /[\u001b\u0007\u009b]/);
	});
});

test("compare-runs TUI mode opens searchable picker and selected run detail inspector without execution side effects", async () => {
	await withAdversarialFixtureDir(async (root) => {
		writeCompareRun(root, "2026-06-22-first-abcdef12", { keepArtifacts: true });
		writeCompareRun(root, "2026-06-23-second-abcdef12", { keepArtifacts: true, reportText: "# Second report\n\n- Status: complete\n" });
		const pi = new FakePi();
		promptModelExtension(pi as never);
		pi.customResults.push({ action: "selected", runId: "2026-06-23-second-abcdef12" });

		const output = await captureStdout(() => pi.commands.get("compare-runs")!.handler("", createCompareRunTuiContext(root, pi)));

		assert.equal(output, "");
		assert.equal(pi.customComponents.length, 2);
		assert.ok(pi.customComponents[0] instanceof CompareRunPicker);
		assert.ok(pi.customComponents[1] instanceof CompareRunDetailInspector);
		const rendered = (pi.customComponents[1] as CompareRunDetailInspector).render(120).join("\n");
		assert.match(rendered, /Compare run: 2026-06-23-second-abcdef12/);
		assert.match(rendered, /Summary\s+Lineup\s+Report\s+Artifacts\s+Diagnostics|\[Summary\]/);
		assert.doesNotMatch(rendered, /execute button|apply button|commit button/i);
		assert.equal(pi.setModelCalls.length, 0);
		assert.equal(pi.userMessages.length, 0);
		assert.equal(pi.customMessages.length, 0);
	});
});

test("compare-runs TUI picker ignores malformed and non-catalog UI return values", async () => {
	const inheritedSelection = Object.create({ action: "selected", runId: "2026-06-22-real-abcdef12" });
	for (const maliciousReturn of [
		"/tmp/owned.md",
		{ action: "selected", runId: "/tmp/owned.md" },
		{ action: "selected", runId: "2026-06-22-stale-abcdef12" },
		{ action: "selected", runId: "x".repeat(200_000) },
		{ action: "selected", runId: "2026-06-22-real-abcdef12", get path() { throw new Error("unexpected path getter should not be read"); } },
		inheritedSelection,
	]) {
		await withAdversarialFixtureDir(async (root) => {
			writeCompareRun(root, "2026-06-22-real-abcdef12", { keepArtifacts: true });
			const pi = new FakePi();
			promptModelExtension(pi as never);
			pi.customResults.push(maliciousReturn);

			await pi.commands.get("compare-runs")!.handler("", createCompareRunTuiContext(root, pi));

			const shouldInspect = maliciousReturn && typeof maliciousReturn === "object" && Object.getOwnPropertyDescriptor(maliciousReturn, "runId")?.value === "2026-06-22-real-abcdef12";
			assert.equal(pi.customComponents.length, shouldInspect ? 2 : 1);
			assert.equal(pi.setModelCalls.length, 0);
			assert.equal(pi.userMessages.length, 0);
		});
	}
});

test("compare run TUI components filter runs and expose read-only detail panes", async () => {
	await withAdversarialFixtureDir((root) => {
		writeCompareRun(root, "2026-06-22-alpha-abcdef12", { keepArtifacts: true });
		writeCompareRun(root, "2026-06-23-beta-abcdef12", { keepArtifacts: true, reportText: "# Beta\n\n- Status: complete\n" });
		const result = collectBestOfNRunHistory(root);
		const doneValues: unknown[] = [];
		const picker = new CompareRunPicker(buildCompareRunCatalog(result), undefined, undefined, undefined, (value) => doneValues.push(value));

		for (const ch of "beta") picker.handleInput(ch);
		assert.match(picker.render(90).join("\n"), /2026-06-23-beta-abcdef12/);
		picker.handleInput("\n");
		assert.deepEqual(doneValues.at(-1), { action: "selected", runId: "2026-06-23-beta-abcdef12" });

		const inspector = new CompareRunDetailInspector(createCompareRunDetailViewModel(result, result.entries.find((entry) => entry.name.includes("beta"))!));
		let rendered = inspector.render(120).join("\n");
		assert.match(rendered, /\[Summary\]/);
		inspector.handleInput("2");
		rendered = inspector.render(120).join("\n");
		assert.match(rendered, /\[Lineup\]/);
		assert.match(rendered, /"workers"/);
		inspector.handleInput("3");
		rendered = inspector.render(120).join("\n");
		assert.match(rendered, /\[Report\]/);
		assert.match(rendered, /# Beta/);
		inspector.handleInput("4");
		rendered = inspector.render(120).join("\n");
		assert.match(rendered, /\[Artifacts\]/);
		inspector.handleInput("5");
		rendered = inspector.render(120).join("\n");
		assert.match(rendered, /\[Diagnostics\]/);
	});
});

function resultSnapshot(root: string) {
	return collectBestOfNRunHistory(root).entries.map((entry) => ({
		name: entry.name,
		artifacts: entry.artifacts.map((artifact) => [artifact.name, artifact.status, artifact.size]),
	}));
}
