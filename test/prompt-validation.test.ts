import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPromptValidationReport, validatePromptTemplates } from "../prompt-validation.js";

function withTempHome(run: (root: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-validation-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

test("validatePromptTemplates passes a valid prompt library", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts", "shared"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "skills", "tmux"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "skills", "tmux", "SKILL.md"), "# tmux\n");
		writeFileSync(join(cwd, ".pi", "prompts", "shared", "rules.md"), "Shared rules");
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "---\nmodel: claude-sonnet-4-20250514\nincludes: [shared/rules.md]\nskills: [tmux]\n---\nReview $@");

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, true);
		assert.equal(result.promptCount, 2);
		assert.deepEqual(result.diagnostics, []);
		assert.match(formatPromptValidationReport(result), /Prompt validation passed: 2 prompt template/);
	});
});

test("validatePromptTemplates reports loader diagnostics and unresolved skills", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "missing-include.md"), "---\nmodel: claude-sonnet-4-20250514\nincludes: [shared/missing.md]\n---\nbody");
		writeFileSync(join(cwd, ".pi", "prompts", "missing-skill.md"), "---\nmodel: claude-sonnet-4-20250514\nskills: [does-not-exist, golang-*]\n---\nbody");

		const result = validatePromptTemplates(cwd);
		const codes = result.diagnostics.map((diagnostic) => diagnostic.code).sort();

		assert.equal(result.ok, false);
		assert.equal(result.promptCount, 1);
		assert.deepEqual(codes, ["include-not-found", "skill-not-found", "skill-wildcard-not-found"]);
		const report = formatPromptValidationReport(result);
		assert.match(report, /Prompt validation failed: 3 issue/);
		assert.match(report, /include-not-found/);
		assert.match(report, /skill-not-found/);
		assert.match(report, /skill-wildcard-not-found/);
	});
});

test("validatePromptTemplates accepts registered skills and wildcard matches", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const registeredSkillPath = join(root, "registered-skill", "SKILL.md");
		const wildcardSkillPath = join(root, "review-typescript", "SKILL.md");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, "registered-skill"), { recursive: true });
		mkdirSync(join(root, "review-typescript"), { recursive: true });
		writeFileSync(registeredSkillPath, "# registered\n");
		writeFileSync(wildcardSkillPath, "# review\n");
		writeFileSync(join(cwd, ".pi", "prompts", "registered.md"), "---\nmodel: claude-sonnet-4-20250514\nskills: [registered-skill, review-*]\n---\nbody");

		const result = validatePromptTemplates(cwd, {
			registeredSkills: [
				{ skillName: "skill:registered-skill", skillPath: registeredSkillPath },
				{ skillName: "review-typescript", skillPath: wildcardSkillPath },
			],
		});

		assert.equal(result.ok, true);
		assert.deepEqual(result.diagnostics, []);
	});
});

test("validatePromptTemplates ignores registered skills without loadable paths", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "registered.md"), "---\nmodel: claude-sonnet-4-20250514\nskills: [registered-skill, review-*]\n---\nbody");

		const result = validatePromptTemplates(cwd, {
			registeredSkills: [
				{ skillName: "skill:registered-skill" },
				{ skillName: "review-typescript" },
			],
		});

		assert.equal(result.ok, false);
		assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code).sort(), ["skill-not-found", "skill-wildcard-not-found"]);
	});
});

test("validatePromptTemplates reports malformed plain chain declarations", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nfirst");
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nsecond");
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "first -> -> second"\n---\nignored');

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "invalid-chain-declaration"), true);
		assert.match(result.diagnostics.find((diagnostic) => diagnostic.code === "invalid-chain-declaration")?.message ?? "", /invalid chain declaration segment/);
	});
});

test("validatePromptTemplates reports missing chain step templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nfirst");
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "first -> missing"\n---\nignored');

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "chain-step-not-found"), true);
		assert.match(result.diagnostics.find((diagnostic) => diagnostic.code === "chain-step-not-found")?.message ?? "", /missing/);
	});
});

test("validatePromptTemplates rejects chain step targets that are chain templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "leaf.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nleaf");
		writeFileSync(join(cwd, ".pi", "prompts", "inner.md"), "---\nchain: leaf\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "outer.md"), "---\nchain: inner\n---\nignored");

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "invalid-chain-step-target"), true);
		assert.match(result.diagnostics.find((diagnostic) => diagnostic.code === "invalid-chain-step-target")?.message ?? "", /inner/);
	});
});

test("validatePromptTemplates rejects parallel chain step targets that are chain templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "leaf.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nleaf");
		writeFileSync(join(cwd, ".pi", "prompts", "inner.md"), "---\nchain: leaf\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), "---\nmodel: claude-sonnet-4-20250514\nsubagent: true\n---\nworker");
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(inner, worker)"\n---\nignored');

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "invalid-chain-step-target"), true);
		assert.match(result.diagnostics.find((diagnostic) => diagnostic.code === "invalid-chain-step-target")?.message ?? "", /inner/);
	});
});

test("validatePromptTemplates accepts parallel chain step targets that can be runtime delegated", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "plain.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nplain");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), "---\nmodel: claude-sonnet-4-20250514\nsubagent: true\n---\nworker");
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(plain, worker)"\n---\nignored');

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, true);
		assert.deepEqual(result.diagnostics, []);
	});
});

test("validatePromptTemplates rejects mixed inheritContext between plain and inherited parallel targets", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "plain.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nplain");
		writeFileSync(join(cwd, ".pi", "prompts", "inherited.md"), "---\nmodel: claude-sonnet-4-20250514\nsubagent: true\ninheritContext: true\n---\ninherited");
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(plain, inherited)"\n---\nignored');

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "parallel-inherit-context-mismatch"), true);
		assert.match(result.diagnostics.find((diagnostic) => diagnostic.code === "parallel-inherit-context-mismatch")?.message ?? "", /plain=fresh, inherited=fork/);
	});
});

test("validatePromptTemplates rejects skill-bearing parallel targets because skills cannot run as subagents", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "skills", "some-skill"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "skills", "some-skill", "SKILL.md"), "# some skill\n");
		writeFileSync(join(cwd, ".pi", "prompts", "plain-skill.md"), "---\nmodel: claude-sonnet-4-20250514\nskills: [some-skill]\n---\nplain with skill");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), "---\nmodel: claude-sonnet-4-20250514\nsubagent: true\n---\nworker");
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(plain-skill, worker)"\n---\nignored');

		const result = validatePromptTemplates(cwd);
		const diagnostic = result.diagnostics.find((entry) => entry.code === "parallel-skill-subagent-incompatible");

		assert.equal(result.ok, false);
		assert.ok(diagnostic);
		assert.match(diagnostic.message, /parallel\(\) steps require delegated execution/);
		assert.match(diagnostic.message, /skill frontmatter \(some-skill\) cannot run as a subagent in v1/);
	});
});

test("validatePromptTemplates rejects unsupported per-task flags in parallel chain steps", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "looper.md"), "---\nmodel: claude-sonnet-4-20250514\nsubagent: true\n---\nlooper");
		writeFileSync(join(cwd, ".pi", "prompts", "context.md"), "---\nmodel: claude-sonnet-4-20250514\nsubagent: true\n---\ncontext");
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(looper --loop 2, context --with-context)"\n---\nignored');

		const result = validatePromptTemplates(cwd);
		const flagDiagnostics = result.diagnostics.filter((diagnostic) => diagnostic.code === "invalid-parallel-chain-step-flag");

		assert.equal(result.ok, false);
		assert.equal(flagDiagnostics.length, 2);
		assert.match(flagDiagnostics.map((diagnostic) => diagnostic.message).join("\n"), /--loop/);
		assert.match(flagDiagnostics.map((diagnostic) => diagnostic.message).join("\n"), /--with-context/);
	});
});

test("validatePromptTemplates rejects delegated parallel steps with mixed inheritContext modes", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "fresh.md"), "---\nmodel: claude-sonnet-4-20250514\nsubagent: worker\n---\nfresh");
		writeFileSync(join(cwd, ".pi", "prompts", "inherited.md"), "---\nmodel: claude-sonnet-4-20250514\nsubagent: reviewer\ninheritContext: true\n---\ninherited");
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(fresh, inherited)"\n---\nignored');

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "parallel-inherit-context-mismatch"), true);
		assert.match(result.diagnostics.find((diagnostic) => diagnostic.code === "parallel-inherit-context-mismatch")?.message ?? "", /fresh=fresh, inherited=fork/);
	});
});

test("validatePromptTemplates rejects worktree parallel steps with mixed effective cwd values", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const otherCwd = join(root, "other-project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(otherCwd, { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "worker-a.md"), `---\nmodel: claude-sonnet-4-20250514\nsubagent: true\ncwd: ${cwd}\n---\nworker a`);
		writeFileSync(join(cwd, ".pi", "prompts", "worker-b.md"), `---\nmodel: claude-sonnet-4-20250514\nsubagent: true\ncwd: ${otherCwd}\n---\nworker b`);
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nworktree: true\nchain: "parallel(worker-a, worker-b)"\n---\nignored');

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "parallel-worktree-mixed-cwd"), true);
		assert.match(result.diagnostics.find((diagnostic) => diagnostic.code === "parallel-worktree-mixed-cwd")?.message ?? "", /parallel\(\) step cwd values differ/);
	});
});

test("validatePromptTemplates honors chain cwd override for worktree parallel cwd validation", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const otherCwd = join(root, "other-project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(otherCwd, { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "worker-a.md"), `---\nmodel: claude-sonnet-4-20250514\nsubagent: true\ncwd: ${cwd}\n---\nworker a`);
		writeFileSync(join(cwd, ".pi", "prompts", "worker-b.md"), `---\nmodel: claude-sonnet-4-20250514\nsubagent: true\ncwd: ${otherCwd}\n---\nworker b`);
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), `---\nworktree: true\ncwd: ${cwd}\nchain: "parallel(worker-a, worker-b)"\n---\nignored`);

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, true);
		assert.deepEqual(result.diagnostics, []);
	});
});

test("validatePromptTemplates rejects bestOfN.finalApplier without worktree true", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "compare.md"), [
			"---",
			"model: claude-sonnet-4-20250514",
			"bestOfN:",
			"  workers:",
			"    - agent: delegate",
			"  finalApplier:",
			"    agent: delegate",
			"---",
			"compare",
		].join("\n"));

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "compare-final-applier-requires-worktree"), true);
	});
});

test("validatePromptTemplates rejects bestOfN.worktree true with mixed worker cwd values", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const workerCwd = join(root, "worker-project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(workerCwd, { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "compare.md"), [
			"---",
			"model: claude-sonnet-4-20250514",
			"bestOfN:",
			"  worktree: true",
			"  workers:",
			"    - agent: delegate",
			`      cwd: ${cwd}`,
			"    - agent: reviewer",
			`      cwd: ${workerCwd}`,
			"---",
			"compare",
		].join("\n"));

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "compare-worktree-mixed-worker-cwd"), true);
		assert.match(result.diagnostics.find((diagnostic) => diagnostic.code === "compare-worktree-mixed-worker-cwd")?.message ?? "", /worker cwd values differ/);
	});
});

test("validatePromptTemplates reads the highest-priority filesystem skill for exact skill references", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "skills", "tmux.md"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "skills", "tmux"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "uses-tmux.md"), "---\nmodel: claude-sonnet-4-20250514\nskill: tmux\n---\nbody");
		writeFileSync(join(root, ".pi", "agent", "skills", "tmux", "SKILL.md"), "# global tmux\n");

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "skill-unreadable"), true);
		assert.match(result.diagnostics.find((diagnostic) => diagnostic.code === "skill-unreadable")?.filePath ?? "", /\.pi\/skills\/tmux\.md$/);
	});
});

test("validatePromptTemplates does not validate stale registered skills that no prompt references", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const missingSkillPath = join(root, "registered", "missing.md");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "plain.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nbody");

		const result = validatePromptTemplates(cwd, {
			registeredSkills: [{ skillName: "unrelated-stale", skillPath: missingSkillPath }],
		});

		assert.equal(result.ok, true);
		assert.deepEqual(result.diagnostics, []);
	});
});

test("validatePromptTemplates uses first registered path for duplicate exact skill names", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const validSkillPath = join(root, "registered", "valid", "SKILL.md");
		const staleDuplicatePath = join(root, "registered", "stale", "SKILL.md");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, "registered", "valid"), { recursive: true });
		writeFileSync(validSkillPath, "# duplicate\n");
		writeFileSync(join(cwd, ".pi", "prompts", "uses-duplicate.md"), "---\nmodel: claude-sonnet-4-20250514\nskill: duplicate-skill\n---\nbody");

		const result = validatePromptTemplates(cwd, {
			registeredSkills: [
				{ skillName: "duplicate-skill", skillPath: validSkillPath },
				{ skillName: "skill:duplicate-skill", skillPath: staleDuplicatePath },
			],
		});

		assert.equal(result.ok, true);
		assert.deepEqual(result.diagnostics, []);
	});
});

test("validatePromptTemplates uses first registered path per wildcard skill name", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const validSkillPath = join(root, "registered", "valid", "SKILL.md");
		const staleDuplicatePath = join(root, "registered", "stale", "SKILL.md");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, "registered", "valid"), { recursive: true });
		writeFileSync(validSkillPath, "# review\n");
		writeFileSync(join(cwd, ".pi", "prompts", "uses-wildcard.md"), "---\nmodel: claude-sonnet-4-20250514\nskill: review-*\n---\nbody");

		const result = validatePromptTemplates(cwd, {
			registeredSkills: [
				{ skillName: "review-typescript", skillPath: validSkillPath },
				{ skillName: "skill:review-typescript", skillPath: staleDuplicatePath },
			],
		});

		assert.equal(result.ok, true);
		assert.deepEqual(result.diagnostics, []);
	});
});

test("validatePromptTemplates validates registered skill paths before passing", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const missingSkillPath = join(root, "registered", "missing.md");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "registered.md"), "---\nmodel: claude-sonnet-4-20250514\nskill: external-skill\n---\nbody");

		const result = validatePromptTemplates(cwd, {
			registeredSkills: [{ skillName: "external-skill", skillPath: missingSkillPath }],
		});

		assert.equal(result.ok, false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "skill-unreadable"), true);
		assert.match(result.diagnostics.find((diagnostic) => diagnostic.code === "skill-unreadable")?.message ?? "", /external-skill/);
	});
});

test("validatePromptTemplates ignores unsafe registered wildcard matches", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const unsafeSkillPath = join(root, "external-bad", "SKILL.md");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, "external-bad"), { recursive: true });
		writeFileSync(unsafeSkillPath, "# unsafe\n");
		writeFileSync(join(cwd, ".pi", "prompts", "wildcard.md"), "---\nmodel: claude-sonnet-4-20250514\nskill: external-*\n---\nbody");

		const result = validatePromptTemplates(cwd, {
			registeredSkills: [{ skillName: "skill:external-bad<xml", skillPath: unsafeSkillPath }],
		});

		assert.equal(result.ok, false);
		assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["skill-wildcard-not-found"]);
	});
});

test("formatPromptValidationReport escapes control characters in diagnostics", () => {
	const report = formatPromptValidationReport({
		ok: false,
		promptCount: 0,
		diagnostics: [{
			code: "bad\ncode",
			source: "project",
			filePath: "/tmp/prompts/bad\n- forged.md",
			message: "message\u001b[31m",
			key: "bad",
		}],
	});

	assert.doesNotMatch(report, /forged\.md: message\x1b/);
	assert.match(report, /bad\\ncode/);
	assert.match(report, /bad\\n- forged\.md/);
	assert.match(report, /message\\u001b\[31m/);
});
