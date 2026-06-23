import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BEST_OF_N_PREFLIGHT_SCHEMA_VERSION, createBestOfNPreflight, type BestOfNPreflight } from "../best-of-n-preflight.js";
import type { PromptWithModel } from "../prompt-loader.js";

const samplePreflight = {
	schemaVersion: BEST_OF_N_PREFLIGHT_SCHEMA_VERSION,
	prompt: {
		name: "compare",
		description: "Compare implementations",
		source: "project",
		rootKind: "prompt-library",
		filePath: "/repo/.pi/prompt-library/compare.md",
	},
	compareCwd: {
		resolved: "/repo",
		source: "runtime-cwd",
		requested: "--cwd=/repo",
		approvalCwd: "/repo",
	},
	preset: {
		name: "strict-oracle",
		trust: "project-approval-required",
		source: "project",
		filePath: "/repo/.pi/best-of-n-presets.json",
		description: "Strict review lineup",
		defaultModel: "anthropic/claude-sonnet-4",
		maxModelCalls: 4,
		runtimeOverride: true,
	},
	slots: {
		workers: [
			{
				kind: "worker",
				index: 1,
				source: "preset",
				agent: "delegate",
				model: "anthropic/claude-sonnet-4",
				effectiveModelLabel: "anthropic/claude-sonnet-4",
				effectiveTask: "Implement the feature",
				cwd: "/repo",
				expandedFromIndex: 1,
			},
		],
		reviewers: [
			{
				kind: "reviewer",
				index: 1,
				source: "default",
				agent: "reviewer",
				effectiveModelLabel: "session model",
				effectiveTask: "Review the worker variants",
				cwd: "/repo",
			},
		],
		finalApplier: {
			kind: "final-applier",
			index: 1,
			source: "prompt",
			agent: "applier",
			effectiveModelLabel: "anthropic/claude-opus-4",
			effectiveTask: "Apply the final implementation",
			cwd: "/repo",
		},
	},
	models: {
		base: "anthropic/claude-sonnet-4",
		workers: ["anthropic/claude-sonnet-4"],
		reviewers: ["session model"],
		finalApplier: "anthropic/claude-opus-4",
	},
	task: {
		raw: "ship it",
		parsed: ["ship", "it"],
		renderedTask: "Implement the feature",
	},
	policies: {
		worktree: {
			enabled: true,
			requiredByFinalApplier: true,
			workerCwdPolicy: "shared",
		},
		finalApplier: {
			enabled: true,
			requiresWorktree: true,
		},
		commit: {
			mode: "ask",
			approvalCwd: "/repo",
		},
	},
	artifacts: {
		report: {
			willWrite: true,
			root: "/repo/.pi/runs/best-of-n",
		},
		rawArtifacts: {
			keepArtifacts: false,
			expectedFiles: ["worker-1.md", "reviewer-1.md", "final-applier.md"],
		},
	},
	callCount: {
		workers: 1,
		reviewers: 1,
		finalApplier: 1,
		total: 3,
		cap: 4,
		capStatus: "within-cap",
	},
	diagnostics: [
		{
			severity: "warning",
			code: "project-preset-approval-required",
			message: "Project preset requires session approval before execution.",
			source: "preset",
			filePath: "/repo/.pi/best-of-n-presets.json",
		},
	],
} satisfies BestOfNPreflight;

test("BestOfNPreflight pins the shared compare preflight shape", () => {
	assert.equal(samplePreflight.schemaVersion, 1);
	assert.deepEqual(Object.keys(samplePreflight).sort(), [
		"artifacts",
		"callCount",
		"compareCwd",
		"diagnostics",
		"models",
		"policies",
		"preset",
		"prompt",
		"schemaVersion",
		"slots",
		"task",
	]);
	assert.deepEqual(Object.keys(samplePreflight.slots).sort(), ["finalApplier", "reviewers", "workers"]);
	assert.deepEqual(Object.keys(samplePreflight.policies).sort(), ["commit", "finalApplier", "worktree"]);
	assert.deepEqual(Object.keys(samplePreflight.artifacts).sort(), ["rawArtifacts", "report"]);
	assert.equal(samplePreflight.callCount.capStatus, "within-cap");
	assert.equal(samplePreflight.diagnostics[0]?.severity, "warning");
});

function withTempProject(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-preflight-"));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function comparePrompt(projectRoot: string, overrides: Partial<PromptWithModel> = {}): PromptWithModel {
	return {
		name: "best-of-n",
		description: "Compare prompt",
		content: "Ship $ARGUMENTS",
		models: ["openai/gpt-5"],
		restore: true,
		worktree: true,
		workers: [{ agent: "delegate", count: 2 }],
		reviewers: [{ agent: "reviewer" }],
		finalApplier: { agent: "applier", model: "anthropic/claude-opus-4" },
		commit: "ask",
		source: "project",
		rootKind: "prompt-library",
		filePath: join(projectRoot, ".pi", "prompt-library", "best-of-n.md"),
		...overrides,
	};
}

test("createBestOfNPreflight mirrors runtime preset, overrides, cap, and policy resolution without execution", () => {
	withTempProject((projectRoot) => {
		mkdirSync(join(projectRoot, ".pi"), { recursive: true });
		writeFileSync(join(projectRoot, ".pi", "best-of-n-presets.json"), `${JSON.stringify({
			presets: {
				fast: {
					description: "Fast project preset",
					defaultModel: "openai/gpt-5-mini",
					maxModelCalls: 3,
					workers: [{ agent: "delegate", count: 2 }],
					reviewers: [{ agent: "reviewer" }],
				},
			},
		}, null, 2)}\n`);

		const preflight = createBestOfNPreflight({
			prompt: comparePrompt(projectRoot, { preset: "slow" }),
			args: `--preset fast --workers-append='[{"agent":"oracle","model":"anthropic/claude-sonnet-4"}]' implement auth`,
			contextCwd: projectRoot,
			currentModelLabel: "session model",
		});

		assert.equal(preflight.preset?.name, "fast");
		assert.equal(preflight.preset?.runtimeOverride, true);
		assert.equal(preflight.preset?.trust, "project-approval-required");
		assert.equal(preflight.preset?.defaultModel, "openai/gpt-5-mini");
		assert.equal(preflight.slots.workers.length, 3);
		assert.deepEqual(preflight.models.workers, ["openai/gpt-5-mini", "openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.deepEqual(preflight.task.parsed, ["implement", "auth"]);
		assert.equal(preflight.task.renderedTask, "Ship implement auth");
		assert.equal(preflight.policies.finalApplier.enabled, true);
		assert.equal(preflight.policies.commit.mode, "ask");
		assert.equal(preflight.artifacts.report.willWrite, true);
		assert.equal(preflight.callCount.total, 5);
		assert.equal(preflight.callCount.cap, 3);
		assert.equal(preflight.callCount.capStatus, "exceeded");
		assert(preflight.diagnostics.some((diagnostic) => diagnostic.code === "project-preset-approval-required"));
		assert(preflight.diagnostics.some((diagnostic) => diagnostic.code === "best-of-n-preset-cap-exceeded"));
	});
});

test("createBestOfNPreflight reports malformed and oversized project presets as diagnostics", () => {
	withTempProject((projectRoot) => {
		mkdirSync(join(projectRoot, ".pi"), { recursive: true });
		writeFileSync(join(projectRoot, ".pi", "best-of-n-presets.json"), `{ not json`);
		const malformed = createBestOfNPreflight({
			prompt: comparePrompt(projectRoot, { preset: "broken", workers: undefined, reviewers: undefined, finalApplier: undefined, worktree: false, commit: undefined }),
			args: "ship",
			contextCwd: projectRoot,
			currentModelLabel: "session model",
		});
		assert.equal(malformed.preset?.trust, "invalid");
		assert(malformed.diagnostics.some((diagnostic) => diagnostic.code === "invalid-best-of-n-presets-file"));

		writeFileSync(join(projectRoot, ".pi", "best-of-n-presets.json"), `${"{"}${"x".repeat(1_100_000)}`);
		const huge = createBestOfNPreflight({
			prompt: comparePrompt(projectRoot, { preset: "huge", workers: undefined, reviewers: undefined, finalApplier: undefined, worktree: false, commit: undefined }),
			args: "ship",
			contextCwd: projectRoot,
			currentModelLabel: "session model",
		});
		assert.equal(huge.preset?.trust, "invalid");
		assert(huge.diagnostics.some((diagnostic) => diagnostic.code === "invalid-best-of-n-presets-file" && diagnostic.message.includes("max is")));
	});
});

test("createBestOfNPreflight validates compare cwd and worktree/final applier constraints", () => {
	withTempProject((projectRoot) => {
		const preflight = createBestOfNPreflight({
			prompt: comparePrompt(projectRoot, { worktree: false }),
			args: `--cwd=${join(projectRoot, "missing")} ship`,
			contextCwd: projectRoot,
			currentModelLabel: "session model",
		});

		assert.equal(preflight.compareCwd.source, "runtime-cwd");
		assert(preflight.diagnostics.some((diagnostic) => diagnostic.code === "compare-cwd-not-found"));
		assert(preflight.diagnostics.some((diagnostic) => diagnostic.code === "compare-final-applier-requires-worktree"));
	});
});
