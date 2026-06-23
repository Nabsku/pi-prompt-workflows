import test from "node:test";
import assert from "node:assert/strict";
import { BEST_OF_N_PREFLIGHT_SCHEMA_VERSION, type BestOfNPreflight } from "../best-of-n-preflight.js";

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
