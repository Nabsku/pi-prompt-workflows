import test from "node:test";
import assert from "node:assert/strict";
import { formatPromptDryRun } from "../prompt-dry-run-renderer.js";
import type { BestOfNPreflight } from "../best-of-n-preflight.js";
import type { PromptDryRunResult } from "../prompt-dry-run.js";

const model = { provider: "anthropic", id: "claude-sonnet-4-20250514" } as never;

function ok(overrides: Partial<Extract<PromptDryRunResult, { status: "ok" }>> = {}): Extract<PromptDryRunResult, { status: "ok" }> {
	return {
		status: "ok",
		promptName: "demo",
		content: "Hello **world**",
		args: ["one", "two"],
		model,
		modelAlreadyActive: false,
		warnings: [],
		skills: [],
		details: { skills: [] },
		runtime: { restore: false, boomerang: false },
		...overrides,
	};
}

function error(overrides: Partial<Extract<PromptDryRunResult, { status: "error" }>> = {}): Extract<PromptDryRunResult, { status: "error" }> {
	return {
		status: "error",
		promptName: "demo",
		error: "Something failed",
		warnings: [],
		...overrides,
	};
}

function positions(text: string, needles: string[]): number[] {
	return needles.map((needle) => {
		const index = text.indexOf(needle);
		assert.notEqual(index, -1, `missing ${needle} in:\n${text}`);
		return index;
	});
}

function comparePreflight(overrides: Partial<BestOfNPreflight> = {}): BestOfNPreflight {
	const base: BestOfNPreflight = {
		schemaVersion: 1,
		prompt: { name: "best-of-n", description: "", source: "project", rootKind: "prompts", filePath: "/repo/.pi/prompts/best-of-n.md" },
		compareCwd: { resolved: "/repo", source: "context-cwd", requested: "/repo" },
		slots: {
			workers: [{ kind: "worker", index: 1, source: "prompt", agent: "worker", cwd: "/repo", effectiveModelLabel: "anthropic/claude-sonnet-4" }],
			reviewers: [{ kind: "reviewer", index: 1, source: "default", agent: "reviewer", cwd: "/repo", effectiveModelLabel: "anthropic/claude-sonnet-4" }],
		},
		models: { base: "anthropic/claude-sonnet-4", workers: ["anthropic/claude-sonnet-4"], reviewers: ["anthropic/claude-sonnet-4"] },
		task: { raw: "fix bug", parsed: ["fix", "bug"], renderedTask: "fix bug" },
		policies: {
			worktree: { enabled: false, requiredByFinalApplier: false, workerCwdPolicy: "independent" },
			finalApplier: { enabled: false, requiresWorktree: false },
			commit: { mode: "none" },
		},
		artifacts: { report: { willWrite: true, root: "/repo/.pi/runs/best-of-n" }, rawArtifacts: { keepArtifacts: false, expectedFiles: ["worker-1.md", "reviewer-1.md"] } },
		callCount: { workers: 1, reviewers: 1, finalApplier: 0, total: 2, capStatus: "uncapped" },
		diagnostics: [],
	};
	return { ...base, ...overrides };
}

test("formats success sections in deterministic order", () => {
	const rendered = formatPromptDryRun(
		ok({
			warnings: ["careful"],
			skills: [{ skillName: "tmux", skillPath: "/tmp/SKILL.md" }],
			details: { skills: [{ skillName: "tmux", skillPath: "/tmp/SKILL.md" }] },
		}),
	);
	const order = positions(rendered, ["# Prompt dry-run: demo", "## Metadata", "## Warnings", "## Skills", "## Args", "## Prompt body"]);
	assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("fences prompt body as markdown", () => {
	const rendered = formatPromptDryRun(ok({ content: "# Title\n\nBody" }));
	assert.match(rendered, /## Prompt body\n+```markdown\n# Title\n\nBody\n```/);
});

test("expands code fence beyond the longest embedded backtick run", () => {
	const rendered = formatPromptDryRun(ok({ content: "before\n````\ncode\n````\nafter" }));
	assert.match(rendered, /`````markdown\nbefore\n````\ncode\n````\nafter\n`````/);
});

test("escapes paths and control characters enough to prevent forged metadata lines", () => {
	const rendered = formatPromptDryRun(
		ok({
			promptName: "demo\n## Forged",
			args: ["arg\n## Forged arg"],
			model: { provider: "anthropic\n## Forged provider", id: "claude\n## Forged model" } as never,
			warnings: ["warn\n## Forged warning"],
			skills: [{ skillName: "bad\nname", skillPath: "/tmp/x\n## Forged path\u0001" }],
			details: { skills: [{ skillName: "bad\nname", skillPath: "/tmp/x\n## Forged path\u0001" }] },
			runtime: {
				model: "gpt\n## Forged override",
				restore: false,
				boomerang: false,
				cwd: "/tmp/run\n## Forged cwd",
				delegation: { enabled: true, agent: "reviewer\n## Forged agent" },
			},
		}),
	);
	assert.equal(rendered.includes("\n## Forged"), false);
	assert.match(rendered, /demo\\n## Forged/);
	assert.match(rendered, /anthropic\\n## Forged provider\/claude\\n## Forged model/);
	assert.match(rendered, /gpt\\n## Forged override/);
	assert.match(rendered, /reviewer\\n## Forged agent/);
	assert.match(rendered, /arg\\n## Forged arg/);
	assert.match(rendered, /\/tmp\/run\\n## Forged cwd/);
	assert.match(rendered, /\/tmp\/x\\n## Forged path\\u0001/);
});

test("omits skill content by default when it is absent from result", () => {
	const rendered = formatPromptDryRun(
		ok({
			skills: [{ skillName: "tmux", skillPath: "/tmp/SKILL.md" }],
			details: { skills: [{ skillName: "tmux", skillPath: "/tmp/SKILL.md" }] },
		}),
	);
	assert.match(rendered, /## Skills/);
	assert.match(rendered, /tmux/);
	assert.match(rendered, /\/tmp\/SKILL\.md/);
	assert.doesNotMatch(rendered, /Skill content/);
});

test("includes skill content only when present in result", () => {
	const rendered = formatPromptDryRun(
		ok({
			skills: [{ skillName: "tmux", skillPath: "/tmp/SKILL.md", skillContent: "Use tmux\n```\ncarefully" }],
			details: { skills: [{ skillName: "tmux", skillPath: "/tmp/SKILL.md", skillContent: "Use tmux\n```\ncarefully" }] },
		}),
	);
	assert.match(rendered, /### Skill: tmux/);
	assert.match(rendered, /Skill content/);
	assert.match(rendered, /````markdown\nUse tmux\n```\ncarefully\n````/);
});

test("shows delegation metadata clearly", () => {
	const rendered = formatPromptDryRun(ok({ runtime: { restore: false, boomerang: false, delegation: { enabled: true, agent: "reviewer", fork: true, inheritContext: true, parallel: 3 } } }));
	assert.match(rendered, /Delegation: enabled/);
	assert.match(rendered, /Agent: reviewer/);
	assert.match(rendered, /Fork: true/);
	assert.match(rendered, /Inherit context: true/);
	assert.match(rendered, /Parallel: 3/);
});

test("shows model, active, thinking, restore, cwd, boomerang, and loop metadata clearly", () => {
	const rendered = formatPromptDryRun(
		ok({
			modelAlreadyActive: true,
			runtime: { model: "gpt-5.2", cwd: "/tmp/project", restore: true, thinking: "high", boomerang: true, loop: { count: 3, fresh: true, converge: false } },
		}),
	);
	assert.match(rendered, /Model: anthropic\/claude-sonnet-4-20250514/);
	assert.match(rendered, /Requested model override: gpt-5\.2/);
	assert.match(rendered, /Model already active: true/);
	assert.match(rendered, /Thinking: high/);
	assert.match(rendered, /Restore: true/);
	assert.match(rendered, /Runtime cwd: \/tmp\/project/);
	assert.match(rendered, /Boomerang: true/);
	assert.match(rendered, /Loop: count=3, fresh=true, converge=false/);
});

test("formats errors clearly and does not include prompt body", () => {
	const rendered = formatPromptDryRun(error({ error: "No model", warnings: ["check config"], runtime: { restore: true, boomerang: false } }));
	assert.match(rendered, /# Prompt dry-run: demo/);
	assert.match(rendered, /Status: error/);
	assert.match(rendered, /Error: No model/);
	assert.match(rendered, /## Warnings/);
	assert.doesNotMatch(rendered, /## Prompt body/);
	assert.doesNotMatch(rendered, /```markdown/);
});

test("shows warnings clearly", () => {
	const rendered = formatPromptDryRun(ok({ warnings: ["first", "second"] }));
	assert.match(rendered, /## Warnings\n+- first\n- second/);
});

test("compare preflight starts with ready verdict, execute command, and report-only retention guidance", () => {
	const rendered = formatPromptDryRun(ok({ comparePreflight: comparePreflight() }));
	assert.match(rendered, /## Compare preflight\nVerdict: ready to run\nExecute: \/best-of-n fix bug\nEvidence retention: summary report only\. Add --keep-artifacts/);
	assert.doesNotMatch(rendered, /Fix before running/);
});

test("compare preflight renders warning verdict and project preset approval expectation", () => {
	const preflight = comparePreflight({
		preset: { name: "quick", trust: "project-approval-required", source: "project", filePath: "/repo/.pi/best-of-n-presets.json", runtimeOverride: true },
		diagnostics: [{ severity: "warning", code: "project-preset-approval-required", message: "Project preset requires session approval before execution.", source: "preset" }],
	});
	const rendered = formatPromptDryRun(ok({ comparePreflight: preflight, warnings: ["Project preset requires session approval before execution."] }));
	assert.match(rendered, /Verdict: warnings/);
	assert.match(rendered, /Execute: \/best-of-n --preset quick fix bug/);
	assert.match(rendered, /Project preset approval: project preset requires session approval before execution for this compare cwd\./);
});

test("compare preflight execute command preserves runtime cwd and lineup overrides", () => {
	const preflight = comparePreflight({
		compareCwd: { resolved: "/tmp/other", source: "runtime-cwd", requested: "/tmp/other" },
		slots: {
			workers: [{ kind: "worker", index: 1, source: "runtime-override", agent: "coder", model: "m1", cwd: "/tmp/other", effectiveModelLabel: "m1" }],
			reviewers: [{ kind: "reviewer", index: 1, source: "runtime-override", agent: "critic", model: "m2", cwd: "/tmp/other", effectiveModelLabel: "m2" }],
			finalApplier: { kind: "final-applier", index: 1, source: "runtime-override", agent: "apply", model: "m3", cwd: "/tmp/other", effectiveModelLabel: "m3" },
		},
	});
	const rendered = formatPromptDryRun(ok({ comparePreflight: preflight, runtime: { restore: false, boomerang: false, cwd: "/tmp/other" } }));
	assert.match(rendered, /Execute: \/best-of-n --cwd=\/tmp\/other/);
	assert.equal(rendered.includes('--workers=[{"agent":"coder","model":"m1","cwd":"/tmp/other"}]'), true);
	assert.equal(rendered.includes('--reviewers=[{"agent":"critic","model":"m2","cwd":"/tmp/other"}]'), true);
	assert.equal(rendered.includes('--final-applier={"agent":"apply","model":"m3"}'), true);
});

test("blocked compare preflight summarizes error diagnostics under Fix before running", () => {
	const preflight = comparePreflight({
		diagnostics: [{ severity: "error", code: "compare-final-applier-requires-worktree", message: "Compare prompts with finalApplier require worktree: true.", source: "project" }],
	});
	const rendered = formatPromptDryRun(error({ error: "Compare prompts with finalApplier require worktree: true.", comparePreflight: preflight, runtime: { restore: false, boomerang: false } }));
	assert.match(rendered, /Verdict: blocked/);
	assert.match(rendered, /### Fix before running\n- Compare prompts with finalApplier require worktree: true\./);
	assert.doesNotMatch(rendered, /Execute: \/best-of-n/);
});

test("compare preflight reports raw artifact retention when --keep-artifacts is present", () => {
	const preflight = comparePreflight({ artifacts: { report: { willWrite: true, root: "/repo/.pi/runs/best-of-n" }, rawArtifacts: { keepArtifacts: true, expectedFiles: ["worker-1.md", "reviewer-1.md"] } } });
	const rendered = formatPromptDryRun(ok({ comparePreflight: preflight }));
	assert.match(rendered, /Evidence retention: raw worker\/reviewer outputs retained \(worker-1\.md, reviewer-1\.md\)\./);
});
