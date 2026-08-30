import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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

test("validatePromptTemplates reports prompt-library source summary", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompt-library", "a"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompt-library", "b"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "prompt-library"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nReview $@");
		writeFileSync(join(cwd, ".pi", "prompt-library", "library-review.md"), "---\nthinking: high\n---\nLibrary review $@");
		writeFileSync(join(cwd, ".pi", "prompt-library", "hidden-review.md"), "---\nmodel: claude-sonnet-4-20250514\nhidden: true\n---\nHidden review $@");
		writeFileSync(join(cwd, ".pi", "prompt-library", "a", "rules.md"), "Plain shared rules A");
		writeFileSync(join(cwd, ".pi", "prompt-library", "b", "rules.md"), "Plain shared rules B");
		writeFileSync(join(root, ".pi", "agent", "prompt-library", "user-review.md"), "---\nmodel: claude-sonnet-4-20250514\nhidden: true\n---\nUser hidden review $@");
		writeFileSync(join(root, ".pi", "agent", "prompt-library", "user-rules.md"), "User shared rules");
		writeFileSync(join(cwd, ".pi", "prompt-library", "ignored.md"), "---\n[]\n---\nIgnored invalid frontmatter fragment");

		const result = validatePromptTemplates(cwd);
		const report = formatPromptValidationReport(result);

		assert.equal(result.sourceSummary.projectPrompts, 1);
		assert.equal(result.sourceSummary.projectLibraryCommands, 2);
		assert.equal(result.sourceSummary.projectHiddenLibraryCommands, 1);
		assert.equal(result.sourceSummary.projectLibraryFragments, 2);
		assert.equal(result.sourceSummary.userLibraryCommands, 1);
		assert.equal(result.sourceSummary.userHiddenLibraryCommands, 1);
		assert.equal(result.sourceSummary.userLibraryFragments, 1);
		assert.match(report, /Sources: 1 project prompt 2 project library commands 0 user prompts 1 user library command 3 include-only library fragments 2 hidden library commands/);
	});
});

test("validatePromptTemplates source summary counts skipped prompt-library commands with diagnostics", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompt-library"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-library", "review.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: missing.md\n---\nReview $@");

		const result = validatePromptTemplates(cwd);
		const report = formatPromptValidationReport(result);

		assert.equal(result.ok, false);
		assert.equal(result.sourceSummary.projectLibraryCommands, 1);
		assert.equal(result.sourceSummary.projectLibraryFragments, 0);
		assert.match(report, /Sources: 0 project prompts 1 project library command 0 user prompts 0 user library commands 0 include-only library fragments/);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found"), true);
	});
});

test("validatePromptTemplates source summary counts skipped prompt-library commands with nested include diagnostics", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompt-library", "partials"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-library", "review.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: partials/rules.md\n---\nReview $@");
		writeFileSync(join(cwd, ".pi", "prompt-library", "partials", "rules.md"), '<include file="missing.md" />');

		const result = validatePromptTemplates(cwd);
		const report = formatPromptValidationReport(result);

		assert.equal(result.ok, false);
		assert.equal(result.sourceSummary.projectLibraryCommands, 1);
		assert.equal(result.sourceSummary.projectLibraryFragments, 1);
		assert.match(report, /Sources: 0 project prompts 1 project library command 0 user prompts 0 user library commands 1 include-only library fragment/);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found" && diagnostic.filePath.endsWith("partials/rules.md")), true);
	});
});

test("validatePromptTemplates source summary counts invalid command configs as commands", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, ".pi", "agent", "prompt-library"), { recursive: true });
		writeFileSync(join(root, ".pi", "agent", "prompt-library", "same.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nUser shadowed $@");
		mkdirSync(join(cwd, ".pi", "prompt-library", "nested"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-library", "same.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nProject shadow $@");
		writeFileSync(join(cwd, ".pi", "prompt-library", "dup.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nFirst dup $@");
		writeFileSync(join(cwd, ".pi", "prompt-library", "nested", "dup.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nSecond dup $@");
		writeFileSync(join(cwd, ".pi", "prompt-library", "empty-chain-command.md"), "---\nchain: \"\"\n---\nEmpty chain $@");
		writeFileSync(join(cwd, ".pi", "prompt-library", "empty-model-command.md"), "---\nmodel: \"\"\n---\nEmpty model $@");
		writeFileSync(join(cwd, ".pi", "prompt-library", "loop-command.md"), "---\nloop: 0\n---\nLoop $@");
		writeFileSync(join(cwd, ".pi", "prompt-library", "settings.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nReserved $@");
		writeFileSync(join(cwd, ".pi", "prompt-library", "subagent-command.md"), "---\nsubagent: []\n---\nDelegate $@");
		writeFileSync(join(cwd, ".pi", "prompt-library", "thinking-fragment.md"), "---\nthinking: banana\n---\nPlain fragment");

		const result = validatePromptTemplates(cwd);
		const report = formatPromptValidationReport(result);

		assert.equal(result.ok, false);
		assert.equal(result.sourceSummary.projectLibraryCommands, 8);
		assert.equal(result.sourceSummary.userLibraryCommands, 1);
		assert.equal(result.sourceSummary.projectLibraryFragments, 1);
		assert.match(report, /Sources: 0 project prompts 8 project library commands 0 user prompts 1 user library command 1 include-only library fragment/);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "duplicate-command-name"), true);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "empty-chain"), true);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "empty-model"), true);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "invalid-loop"), true);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "invalid-subagent"), true);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "reserved-command-name"), true);
	});
});

test("validation result includes graph for valid include prompt", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts", "shared"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "shared", "rules.md"), "Shared rules");
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "---\nmodel: claude-sonnet-4-20250514\nincludes: [shared/rules.md]\n---\nReview $@");

		const result = validatePromptTemplates(cwd);
		const graph = result.includeGraphs.find((entry) => entry.root.promptName === "review");

		assert.ok(graph);
		assert.equal(graph.skipped, false);
		assert.equal(graph.edges.length, 1);
		assert.equal(graph.edges[0]?.status, "ok");
		assert.match(graph.edges[0]?.includePath ?? "", /shared\/rules\.md/);
	});
});

test("validation result includes skipped graph for root prompt with direct missing include", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: shared/missing.md\n---\nReview");

		const result = validatePromptTemplates(cwd);
		const graph = result.includeGraphs.find((entry) => entry.root.promptName === "review");

		assert.equal(result.ok, false);
		assert.ok(graph);
		assert.equal(graph.skipped, true);
		assert.equal(graph.edges.length, 1);
		assert.equal(graph.edges[0]?.status, "failed");
		assert.equal(graph.edges[0]?.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found"), true);
		assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ["include-not-found"]);
	});
});

test("validation result includes skipped user graph under same-name project override", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, ".pi", "agent", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		const userPromptPath = join(root, ".pi", "agent", "prompts", "same.md");
		const projectPromptPath = join(cwd, ".pi", "prompts", "same.md");
		writeFileSync(userPromptPath, "---\nmodel: claude-sonnet-4-20250514\ninclude: missing.md\n---\nuser");
		writeFileSync(projectPromptPath, "---\nmodel: claude-sonnet-4-20250514\n---\nproject");

		const result = validatePromptTemplates(cwd);
		const sameGraphs = result.includeGraphs.filter((entry) => entry.root.promptName === "same");
		const userGraph = sameGraphs.find((entry) => entry.root.source === "user");
		const projectGraph = sameGraphs.find((entry) => entry.root.source === "project");

		assert.equal(result.ok, false);
		assert.equal(result.promptCount, 1);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found" && diagnostic.filePath === userPromptPath), true);
		assert.equal(sameGraphs.length, 2);
		assert.ok(userGraph);
		assert.equal(userGraph.effective, false);
		assert.equal(userGraph.skipped, true);
		assert.equal(userGraph.root.filePath, userPromptPath);
		assert.equal(userGraph.edges.length, 1);
		assert.equal(userGraph.edges[0]?.status, "failed");
		assert.equal(userGraph.edges[0]?.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found"), true);
		assert.ok(projectGraph);
		assert.equal(projectGraph.effective, true);
		assert.equal(projectGraph.skipped, false);
		assert.equal(projectGraph.root.filePath, projectPromptPath);

		const report = formatPromptValidationReport(result);
		assert.match(report, /Include graph:/);
		assert.match(report, /- same \[skipped\] .*\.pi\/agent\/prompts\/same\.md/);
		assert.match(report, /same -> unresolved:missing\.md \(frontmatter missing\.md\) \[failed\]/);
		assert.match(report, /! include-not-found: Prompt include/);
	});
});

test("validation report omits non-effective successful user graph under same-name project override", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, ".pi", "agent", "prompts"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "prompt-partials"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		const userPromptPath = join(root, ".pi", "agent", "prompts", "same.md");
		const projectPromptPath = join(cwd, ".pi", "prompts", "same.md");
		writeFileSync(join(root, ".pi", "agent", "prompt-partials", "ok.md"), "ok include");
		writeFileSync(userPromptPath, "---\nmodel: claude-sonnet-4-20250514\ninclude: ok.md\n---\nuser");
		writeFileSync(projectPromptPath, "---\nmodel: claude-sonnet-4-20250514\n---\nproject");

		const result = validatePromptTemplates(cwd);
		const sameGraphs = result.includeGraphs.filter((entry) => entry.root.promptName === "same");
		const userGraph = sameGraphs.find((entry) => entry.root.source === "user");
		const projectGraph = sameGraphs.find((entry) => entry.root.source === "project");

		assert.equal(result.ok, true);
		assert.equal(result.promptCount, 1);
		assert.deepEqual(result.diagnostics, []);
		assert.ok(userGraph);
		assert.equal(userGraph.effective, false);
		assert.equal(userGraph.skipped, false);
		assert.equal(userGraph.root.filePath, userPromptPath);
		assert.equal(userGraph.edges.length, 1);
		assert.equal(userGraph.edges[0]?.status, "ok");
		assert.ok(projectGraph);
		assert.equal(projectGraph.effective, true);
		assert.equal(projectGraph.skipped, false);
		assert.equal(projectGraph.root.filePath, projectPromptPath);

		const report = formatPromptValidationReport(result);
		assert.doesNotMatch(report, /Include graph:/);
		assert.doesNotMatch(report, /\.pi\/agent\/prompts\/same\.md/);
	});
});

test("validation result marks root skipped for nested missing include via graph subtree", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts", "shared"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "shared", "a.md"), 'A\n<include file="missing.md" />');
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: shared/a.md\n---\nReview");

		const result = validatePromptTemplates(cwd);
		const graph = result.includeGraphs.find((entry) => entry.root.promptName === "review");

		assert.equal(result.ok, false);
		assert.ok(graph);
		assert.equal(graph.skipped, true);
		assert.equal(graph.edges.some((edge) => edge.status === "failed" && edge.includePath === "missing.md"), true);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found" && /shared\/a\.md$/.test(diagnostic.filePath)), true);
	});
});

test("validation result marks chain wrapper invalid include metadata graph skipped without body edges", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts", "shared"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "shared", "ignored.md"), "ignored");
		writeFileSync(join(cwd, ".pi", "prompts", "leaf.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nleaf");
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: leaf\ninclude: shared/ignored.md\n---\n<include file="shared/ignored.md" />');

		const result = validatePromptTemplates(cwd);
		const graph = result.includeGraphs.find((entry) => entry.root.promptName === "pipeline");

		assert.equal(result.ok, false);
		assert.ok(graph);
		assert.equal(graph.skipped, true);
		assert.deepEqual(graph.edges, []);
		assert.equal(graph.diagnostics.some((diagnostic) => diagnostic.code === "invalid-includes-chain"), true);
		assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.code === "invalid-includes-chain").length, 1);
		const report = formatPromptValidationReport(result);
		assert.match(report, /Include graph:/);
		assert.match(report, /- pipeline \[skipped\] /);
		assert.match(report, /! invalid-includes-chain:/);
	});
});

test("validation report includes valid include graph section with edge", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts", "shared"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "shared", "rules.md"), "Shared rules");
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "---\nmodel: claude-sonnet-4-20250514\nincludes: [shared/rules.md]\n---\nReview $@");

		const report = formatPromptValidationReport(validatePromptTemplates(cwd));

		assert.match(report, /Prompt validation passed: 2 prompt template/);
		assert.match(report, /Include graph:/);
		assert.match(report, /- review \[ok\] /);
		assert.match(report, /review -> .*shared\/rules\.md \(frontmatter shared\/rules\.md\) \[ok\]/);
	});
});

test("validation report includes skipped direct missing include and diagnostic", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: shared/missing.md\n---\nReview");

		const report = formatPromptValidationReport(validatePromptTemplates(cwd));

		assert.match(report, /Include graph:/);
		assert.match(report, /- review \[skipped\] /);
		assert.match(report, /review -> unresolved:shared\/missing\.md \(frontmatter shared\/missing\.md\) \[failed\]/);
		assert.match(report, /! include-not-found: Prompt include/);
		assert.equal([...report.matchAll(/include-not-found/g)].length, 2);
	});
});

test("validation report includes nested missing include chain edge", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts", "shared"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "shared", "a.md"), 'A\n<include file="missing.md" />');
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: shared/a.md\n---\nReview");

		const report = formatPromptValidationReport(validatePromptTemplates(cwd));

		assert.match(report, /- review \[skipped\] /);
		assert.match(report, /review -> .*shared\/a\.md \(frontmatter shared\/a\.md\) \[ok\]/);
		assert.match(report, /shared\/a\.md -> unresolved:missing\.md \(inline missing\.md\) \[failed\]/);
		assert.match(report, /include-not-found/);
	});
});

test("validation report includes failed root include graph diagnostics without edges", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "placeholder.md"), "---\nmodel: claude-sonnet-4-20250514\n---\n<includes />");

		const report = formatPromptValidationReport(validatePromptTemplates(cwd));

		assert.match(report, /Include graph:/);
		assert.match(report, /- placeholder \[skipped\] /);
		assert.match(report, /! include-placeholder-without-includes:/);
	});
});

test("validation report omits include graph section for irrelevant graphs", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "plain.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nPlain");

		const report = formatPromptValidationReport(validatePromptTemplates(cwd));

		assert.doesNotMatch(report, /Include graph:/);
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

test("validatePromptTemplates skips prompt-library symlinks that escape the prompt root", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const libraryRoot = join(cwd, ".pi", "prompt-library");
		const externalRoot = join(root, "external-prompts");
		mkdirSync(libraryRoot, { recursive: true });
		mkdirSync(externalRoot, { recursive: true });
		writeFileSync(join(externalRoot, "escape.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nExternal command");
		symlinkSync(externalRoot, join(libraryRoot, "linked-dir"), "dir");
		symlinkSync(join(externalRoot, "escape.md"), join(libraryRoot, "linked-file.md"), "file");

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, false);
		assert.equal(result.promptCount, 0);
		assert.ok(result.diagnostics.filter((diagnostic) => diagnostic.code === "symlink-outside-prompt-root").length >= 2);
	});
});

test("validatePromptTemplates skips dot-prefixed files and directories in prompt-library", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const libraryRoot = join(cwd, ".pi", "prompt-library");
		mkdirSync(join(libraryRoot, ".hidden-dir"), { recursive: true });
		writeFileSync(join(libraryRoot, ".hidden.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nHidden file command");
		writeFileSync(join(libraryRoot, ".hidden-dir", "nested.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nHidden directory command");
		writeFileSync(join(libraryRoot, "visible.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nVisible command");

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, true);
		assert.equal(result.promptCount, 1);
		assert.equal(result.includeGraphs.some((entry) => entry.root.promptName === ".hidden"), false);
		assert.equal(result.includeGraphs.some((entry) => entry.root.promptName === "nested"), false);
		assert.equal(result.includeGraphs.some((entry) => entry.root.promptName === "visible"), true);
	});
});

test("validatePromptTemplates counts and validates command-capable prompt-library prompts", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompt-library"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-library", "review.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nReview $@");

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, true);
		assert.equal(result.promptCount, 1);
		assert.deepEqual(result.diagnostics, []);
		assert.equal(result.includeGraphs.find((entry) => entry.root.promptName === "review")?.root.rootKind, "prompt-library");
	});
});

test("validatePromptTemplates counts scalar skill-only prompt-library prompts and resolves skills", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompt-library"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "skills", "tmux"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "skills", "tmux", "SKILL.md"), "# tmux\n");
		writeFileSync(join(cwd, ".pi", "prompt-library", "uses-tmux.md"), "---\nskill: tmux\n---\nUse tmux");

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, true);
		assert.equal(result.promptCount, 1);
		assert.deepEqual(result.diagnostics, []);
	});
});

test("validatePromptTemplates counts plural skills-only prompt-library prompts and resolves skills", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompt-library"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "skills", "tmux"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "skills", "review-typescript"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "skills", "tmux", "SKILL.md"), "# tmux\n");
		writeFileSync(join(cwd, ".pi", "skills", "review-typescript", "SKILL.md"), "# review\n");
		writeFileSync(join(cwd, ".pi", "prompt-library", "skilled.md"), "---\nskills: [tmux, review-*]\n---\nUse skills");

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, true);
		assert.equal(result.promptCount, 1);
		assert.deepEqual(result.diagnostics, []);
	});
});

test("unreferenced plain prompt-library include fragments do not count or validate prompt-like metadata", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompt-library"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-library", "fragment.md"), "---\ndescription: shared fragment\nthinking: turbo\n---\nShared rules only");

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, true);
		assert.equal(result.promptCount, 0);
		assert.deepEqual(result.diagnostics, []);
		assert.equal(result.includeGraphs.find((entry) => entry.root.promptName === "fragment")?.effective, false);
	});
});

test("unreferenced prompt-library inline-only fragments do not validate missing includes", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompt-library"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-library", "fragment.md"), '<include file="missing.md" />');

		const result = validatePromptTemplates(cwd);
		const report = formatPromptValidationReport(result);

		assert.equal(result.ok, true);
		assert.equal(result.promptCount, 0);
		assert.deepEqual(result.diagnostics, []);
		assert.equal(result.includeGraphs.find((entry) => entry.root.promptName === "fragment")?.edges.length, 0);
		assert.doesNotMatch(report, /include-not-found/);
	});
});

test("plain prompt-library fragment appears in include graph when included", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompt-library", "partials"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-library", "partials", "rules.md"), "Shared rules");
		writeFileSync(join(cwd, ".pi", "prompt-library", "review.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: partials/rules.md\n---\nReview");

		const result = validatePromptTemplates(cwd);
		const graph = result.includeGraphs.find((entry) => entry.root.promptName === "review");

		assert.equal(result.ok, true);
		assert.equal(result.promptCount, 1);
		assert.ok(graph);
		assert.equal(graph.root.rootKind, "prompt-library");
		assert.equal(graph.edges.length, 1);
		assert.equal(graph.edges[0]?.status, "ok");
		assert.match(graph.edges[0]?.includePath ?? "", /partials\/rules\.md/);
	});
});

test("prompt-library prompt with missing include fails validation and keeps prompt-library graph root", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompt-library"), { recursive: true });
		const promptPath = join(cwd, ".pi", "prompt-library", "review.md");
		writeFileSync(promptPath, "---\nmodel: claude-sonnet-4-20250514\ninclude: missing.md\n---\nReview");

		const result = validatePromptTemplates(cwd);
		const graph = result.includeGraphs.find((entry) => entry.root.promptName === "review");

		assert.equal(result.ok, false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found"), true);
		assert.ok(graph);
		assert.equal(graph.skipped, true);
		assert.equal(graph.root.filePath, promptPath);
		assert.equal(graph.root.rootKind, "prompt-library");
		assert.equal(graph.edges[0]?.status, "failed");
	});
});

test("prompt-library prompt with invalid skill frontmatter reports diagnostics", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompt-library"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-library", "bad-skill.md"), "---\nmodel: claude-sonnet-4-20250514\nskill: []\n---\nBad");

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, false);
		assert.equal(result.promptCount, 0);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "invalid-skills"), true);
	});
});

test("chain wrappers can target command-capable prompt-library steps but not include-only fragments", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompt-library"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-library", "analyze.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nAnalyze");
		writeFileSync(join(cwd, ".pi", "prompt-library", "rules.md"), "Shared rules");
		writeFileSync(join(cwd, ".pi", "prompts", "ok-pipeline.md"), "---\nchain: analyze\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "bad-pipeline.md"), "---\nchain: rules\n---\nignored");

		const result = validatePromptTemplates(cwd);
		const missingStep = result.diagnostics.find((diagnostic) => diagnostic.code === "chain-step-not-found");

		assert.equal(result.ok, false);
		assert.ok(missingStep);
		assert.match(missingStep.message, /rules/);
		assert.doesNotMatch(missingStep.message, /analyze/);
	});
});

test("duplicate prompt-library names and reserved command names surface diagnostics", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompt-library", "nested"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-library", "dup.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nfirst");
		writeFileSync(join(cwd, ".pi", "prompt-library", "nested", "dup.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nsecond");
		writeFileSync(join(cwd, ".pi", "prompt-library", "settings.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nreserved");

		const result = validatePromptTemplates(cwd);
		const codes = result.diagnostics.map((diagnostic) => diagnostic.code);

		assert.equal(result.ok, false);
		assert.equal(codes.includes("duplicate-command-name"), true);
		assert.equal(codes.includes("reserved-command-name"), true);
	});
});

test("formatPromptValidationReport escapes control characters in diagnostics", () => {
	const report = formatPromptValidationReport({
		ok: false,
		promptCount: 0,
		sourceSummary: {
			projectPrompts: 0,
			userPrompts: 0,
			projectLibraryCommands: 0,
			userLibraryCommands: 0,
			projectHiddenLibraryCommands: 0,
			userHiddenLibraryCommands: 0,
			projectLibraryFragments: 0,
			userLibraryFragments: 0,
		},
		diagnostics: [{
			code: "bad\ncode",
			source: "project",
			filePath: "/tmp/prompts/bad\n- forged.md",
			message: "message\u001b[31m",
			key: "bad",
		}],
		includeGraphs: [{
			root: {
				promptName: "bad\nroot",
				filePath: "/tmp/prompts/bad-root.md",
				promptRoot: "/tmp/prompts",
				cwd: "/tmp",
				source: "project",
				rootKind: "prompts",
				promptCapable: true,
				rawBody: "",
				hasInlineIncludes: true,
				hasIncludesPlaceholder: false,
				isChainWrapper: false,
			},
			nodes: [{
				id: "file:/tmp/prompts/bad-root.md",
				kind: "prompt",
				status: "ok",
				filePath: "/tmp/prompts/bad-root.md",
				diagnostics: [],
			}, {
				id: "unresolved:0",
				kind: "unresolved",
				status: "failed",
				includePath: "evil\n- forged.md",
				diagnostics: [],
			}],
			edges: [{
				fromNodeId: "file:/tmp/prompts/bad-root.md",
				toNodeId: "unresolved:0",
				kind: "inline",
				includePath: "evil\n- forged.md",
				order: 0,
				status: "failed",
				diagnostics: [{
					code: "include\ncode",
					message: "include message\u001b[31m",
					filePath: "/tmp/prompts/bad-root.md",
					source: "project",
					key: "include-bad",
				}],
			}],
			diagnostics: [],
			effective: false,
			skipped: true,
		}],
	});

	assert.doesNotMatch(report, /forged\.md: message\x1b/);
	assert.match(report, /bad\\ncode/);
	assert.match(report, /bad\\n- forged\.md/);
	assert.match(report, /message\\u001b\[31m/);
	assert.match(report, /bad\\nroot/);
	assert.match(report, /evil\\n- forged\.md/);
	assert.match(report, /include\\ncode/);
	assert.match(report, /include message\\u001b\[31m/);
});

test("validatePromptTemplates reports configured budgets and fails static maximum overages", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "within.md"), "---\nmodel: claude-sonnet-4-20250514\nbudget:\n  warnTokens: 10\n  maxTokens: 20\n---\nshort");
		writeFileSync(join(cwd, ".pi", "prompts", "over.md"), "---\nmodel: claude-sonnet-4-20250514\nbudget:\n  maxTokens: 1\n---\n12345678");

		const result = validatePromptTemplates(cwd);
		const report = formatPromptValidationReport(result);

		assert.equal(result.ok, false);
		assert.equal(result.budgets?.length, 2);
		assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "prompt-budget-exceeded"));
		assert.match(report, /Prompt budgets \(static rendered content; runtime arguments may increase totals\):/);
		assert.match(report, /within: ~2 tokens \[within\] warn=10 max=20/);
		assert.match(report, /over: ~2 tokens \[exceeded\] max=1/);
	});
});

test("validatePromptTemplates summarizes the configured model conditional branch", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const promptsDir = join(cwd, ".pi", "prompts");
		mkdirSync(promptsDir, { recursive: true });
		writeFileSync(
			join(promptsDir, "conditional.md"),
			"---\nmodel: openai/gpt-test\nbudget:\n  maxTokens: 1\n---\n<if-model is=\"openai/*\">x<else>this alternate branch is much longer</if-model>",
		);

		const result = validatePromptTemplates(cwd);
		assert.equal(result.ok, true);
		assert.equal(result.budgets?.[0]?.verdict, "within");
		assert.equal(result.diagnostics.some((item) => item.code === "prompt-budget-exceeded"), false);
	});
});

test("validatePromptTemplates estimates argument placeholders after representative empty substitution", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const promptsDir = join(cwd, ".pi", "prompts");
		mkdirSync(promptsDir, { recursive: true });
		writeFileSync(join(promptsDir, "args.md"), "---\nmodel: openai/gpt-test\nbudget:\n  maxTokens: 1\n---\n$@ $@ $@ $@");

		const result = validatePromptTemplates(cwd);
		assert.equal(result.diagnostics.some((item) => item.code === "prompt-budget-exceeded"), false);
		assert.equal(result.budgets?.[0]?.estimatedTokens, 1);
	});
});

test("validatePromptTemplates does not defer malformed model-like text", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const promptsDir = join(cwd, ".pi", "prompts");
		mkdirSync(promptsDir, { recursive: true });
		writeFileSync(join(promptsDir, "literal.md"), "---\nmodel: openai/gpt-test\nbudget:\n  maxTokens: 1\n---\n<if-modelish>always oversized text");

		const result = validatePromptTemplates(cwd);
		assert.equal(result.diagnostics.some((item) => item.code === "prompt-budget-exceeded"), true);
	});
});

test("validatePromptTemplates reports nested delegated cwd approval requirements", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const delegatedCwd = join(cwd, "delegated-project");
		const promptsDir = join(cwd, ".pi", "prompts");
		const skillDir = join(delegatedCwd, ".pi", "skills", "delegated-only");
		mkdirSync(promptsDir, { recursive: true });
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "delegated skill content");
		writeFileSync(join(promptsDir, "delegated.md"), `---\nmodel: openai/gpt-test\nsubagent: true\ncwd: ${delegatedCwd}\nskill: delegated-only\n---\nx`);

		const result = validatePromptTemplates(cwd);
		const diagnostic = result.diagnostics.find((item) => item.code === "delegated-cwd-trust");
		assert.match(diagnostic?.message ?? "", /separate approval.*nested project/i);
	});
});

test("validatePromptTemplates includes delegated skill payloads in static budgets", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const promptsDir = join(cwd, ".pi", "prompts");
		const skillDir = join(cwd, ".pi", "skills", "large");
		mkdirSync(promptsDir, { recursive: true });
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "this delegated skill payload is deliberately large");
		writeFileSync(join(promptsDir, "delegated.md"), "---\nmodel: openai/gpt-test\nsubagent: true\nskill: large\nbudget:\n  maxTokens: 3\n---\nx");

		const result = validatePromptTemplates(cwd);
		assert.equal(result.diagnostics.some((item) => item.code === "prompt-budget-exceeded"), true);
	});
});

test("validatePromptTemplates includes best-of-N delegated skills in static budgets", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const promptsDir = join(cwd, ".pi", "prompts");
		const skillDir = join(cwd, ".pi", "skills", "large");
		mkdirSync(promptsDir, { recursive: true });
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "this best-of-N skill payload is deliberately large");
		writeFileSync(join(promptsDir, "compare.md"), "---\nmodel: openai/gpt-test\nbestOfN:\n  workers:\n    - agent: delegate\nskill: large\nbudget:\n  maxTokens: 3\n---\nx");

		const result = validatePromptTemplates(cwd);
		assert.equal(result.diagnostics.some((item) => item.code === "prompt-budget-exceeded"), true);
	});
});

test("validatePromptTemplates rejects guaranteed conditional overages", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const promptsDir = join(cwd, ".pi", "prompts");
		mkdirSync(promptsDir, { recursive: true });
		writeFileSync(join(promptsDir, "conditional-over.md"), "---\nmodel: openai/gpt-test\nbudget:\n  maxTokens: 2\n---\nunconditional oversized prefix <if-model is=\"openai/*\">x<else>y</if-model>");

		const result = validatePromptTemplates(cwd);
		assert.equal(result.diagnostics.some((item) => item.code === "prompt-budget-exceeded"), true);
	});
});

test("validatePromptTemplates classifies budget-only library files as commands", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const libraryDir = join(cwd, ".pi", "prompt-library");
		mkdirSync(libraryDir, { recursive: true });
		writeFileSync(join(libraryDir, "budget-only.md"), "---\nbudget:\n  maxTokens: 20\n---\nsmall body");

		const result = validatePromptTemplates(cwd);
		assert.equal(result.sourceSummary.projectLibraryCommands, 1);
		assert.equal(result.sourceSummary.projectLibraryFragments, 0);
	});
});

test("validatePromptTemplates preserves correlated conditional predicates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const promptsDir = join(cwd, ".pi", "prompts");
		mkdirSync(promptsDir, { recursive: true });
		const long = "x".repeat(40);
		writeFileSync(join(promptsDir, "correlated.md"), `---\nmodel: openai/gpt-test\nbudget:\n  maxTokens: 5\n---\n<if-model is="openai/*">${long}<else>x</if-model><if-model is="openai/*">x<else>${long}</if-model>`);

		const result = validatePromptTemplates(cwd);
		assert.equal(result.diagnostics.some((item) => item.code === "prompt-budget-exceeded"), true);
	});
});

test("validatePromptTemplates includes registered delegated skills in static budgets", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const promptsDir = join(cwd, ".pi", "prompts");
		const registeredDir = join(root, "registered-skill");
		mkdirSync(promptsDir, { recursive: true });
		mkdirSync(registeredDir, { recursive: true });
		const skillPath = join(registeredDir, "SKILL.md");
		writeFileSync(skillPath, "this registered compare skill payload is deliberately large");
		writeFileSync(join(promptsDir, "delegated.md"), "---\nmodel: openai/gpt-test\nsubagent: true\nskill: external\nbudget:\n  maxTokens: 3\n---\nx");

		const result = validatePromptTemplates(cwd, { registeredSkills: [{ skillName: "external", skillPath }] });
		assert.equal(result.diagnostics.some((item) => item.code === "prompt-budget-exceeded"), true);
	});
});

test("validatePromptTemplates evaluates conditionals against pinned models", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const promptsDir = join(cwd, ".pi", "prompts");
		mkdirSync(promptsDir, { recursive: true });
		writeFileSync(join(promptsDir, "pinned.md"), `---\nmodel: openai/gpt-fixed\nbudget:\n  maxTokens: 3\n---\n<if-model is="openai/gpt-fixed">${"x".repeat(40)}<else>x</if-model>`);
		writeFileSync(join(promptsDir, "pinned-within.md"), `---\nmodel: openai/gpt-fixed\nbudget:\n  maxTokens: 3\n---\n<if-model is="openai/gpt-fixed">x<else>${"x".repeat(40)}</if-model>`);

		const result = validatePromptTemplates(cwd);
		assert.equal(result.diagnostics.some((item) => item.code === "prompt-budget-exceeded"), true);
		assert.equal(result.budgets?.find((budget) => budget.promptName === "pinned-within")?.verdict, "within");
	});
});

test("validatePromptTemplates preflights structured adaptive targets and reports bounded summary", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "leaf.md"), "---\nbudget:\n  maxTokens: 100\n---\nleaf");
		writeFileSync(join(cwd, ".pi", "prompts", "flow.md"), "---\nchain:\n  - id: first\n    prompt: leaf\nlimits:\n  maxSteps: 1\n  maxModelCalls: 1\n---\nignored");
		const result = validatePromptTemplates(cwd);
		assert.equal(result.ok, true);
		assert.equal(result.adaptiveChains?.[0]?.preflight.callBounds.maximum, 1);
		assert.match(formatPromptValidationReport(result), /Adaptive chains .*runtime revalidates/);
	});
});

test("validatePromptTemplates does not Git-check an unselected initial changed-gated target", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "leaf.md"), "---\nmodel: test/model\n---\nleaf");
		writeFileSync(join(cwd, ".pi", "prompts", "flow.md"), "---\nchain:\n  - prompt: leaf\n    when: changed\n---\nignored");
		const result = validatePromptTemplates(cwd);
		assert.equal(result.ok, true);
		assert.equal(result.diagnostics.some((item) => item.code === "adaptive-changed-requires-git"), false);
	});
});

test("adaptive validation report sanitizes and caps malicious target diagnostics", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		const bad = `missing-${"x".repeat(5000)}\\nforged`;
		writeFileSync(join(cwd, ".pi", "prompts", "flow.md"), `---\nchain:\n  - prompt: ${bad}\n---\nignored`);
		const report = formatPromptValidationReport(validatePromptTemplates(cwd));
		assert.doesNotMatch(report, /\u001b|\r/);
		assert.ok(report.length < 10000);
		assert.doesNotMatch(report, /\nforged\n/);
	});
});

test("changed-gate validation checks ordinary prompt predecessors in the session cwd, not wrapper cwd", () => {
	withTempHome((root) => {
		const cwd = join(root, "project"); const gitCwd = join(cwd, "repo");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true }); mkdirSync(gitCwd, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: gitCwd });
		writeFileSync(join(cwd, ".pi", "prompts", "mutate.md"), "mutate");
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "review");
		writeFileSync(join(cwd, ".pi", "prompts", "flow.md"), `---\ncwd: ${gitCwd}\nchain:\n  - id: mutate\n    prompt: mutate\n    onSuccess: skipped\n  - id: skipped\n    prompt: review\n    when: failed\n  - id: changed-review\n    prompt: review\n    when: changed\n---\nignored`);
		const invalid = validatePromptTemplates(cwd);
		const diagnostic = invalid.diagnostics.find((item) => item.code === "adaptive-changed-requires-git");
		assert.match(diagnostic?.message ?? "", /selected predecessor "mutate" \(prompt:mutate\)/);
		assert.match(diagnostic?.message ?? "", /runtime-effective cwd/);
	});
});

test("changed-gate Git probes ignore inherited repository redirection", () => {
	withTempHome((root) => {
		const cwd = join(root, "project"); const decoy = join(root, "decoy");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true }); mkdirSync(decoy);
		execFileSync("git", ["init", "-q"], { cwd: decoy });
		writeFileSync(join(cwd, ".pi", "prompts", "mutate.md"), "mutate");
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "review");
		writeFileSync(join(cwd, ".pi", "prompts", "flow.md"), "---\nchain:\n  - id: mutate\n    prompt: mutate\n  - id: review\n    prompt: review\n    when: changed\n---\nignored");
		const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] as const;
		const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
		try {
			process.env.GIT_DIR = join(decoy, ".git"); process.env.GIT_WORK_TREE = decoy; process.env.GIT_INDEX_FILE = join(decoy, ".git", "index");
			const result = validatePromptTemplates(cwd);
			assert.equal(result.diagnostics.some((item) => item.code === "adaptive-changed-requires-git"), true);
		} finally {
			for (const name of names) { const value = saved[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
		}
	});
});

test("changed-gate validation handles run predecessors reached by explicit transitions", () => {
	withTempHome((root) => {
		const cwd = join(root, "project"); const gitCwd = join(cwd, "repo");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true }); mkdirSync(gitCwd, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["init", "-q"], { cwd: gitCwd });
		writeFileSync(join(cwd, ".pi", "prompts", "run.md"), `---\ndeterministic:\n  run:\n    command: git\n    args: [status, --porcelain=v1]\n  cwd: ${gitCwd}\n  handoff: never\n---\n`);
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "review");
		writeFileSync(join(cwd, ".pi", "prompts", "flow.md"), `---\ncwd: ${gitCwd}\nchain:\n  - id: check\n    run: run\n    onFailure: changed-review\n  - id: unused\n    prompt: review\n  - id: changed-review\n    prompt: review\n    when: changed\n---\nignored`);
		const result = validatePromptTemplates(cwd);
		assert.equal(result.diagnostics.some((item) => item.code === "adaptive-changed-requires-git"), false, result.diagnostics.map((item) => item.message).join("\n"));
	});
});

test("validation report has aggregate line and UTF-8 byte caps with a safe omission marker", () => {
	const malicious = "\u001b[31m" + "😀".repeat(40000) + "\ud800";
	const diagnostics = Array.from({ length: 1000 }, (_, index) => ({ code: `bad-${index}`, source: "project" as const, filePath: malicious, message: malicious, key: String(index) }));
	const report = formatPromptValidationReport({ ok: false, promptCount: 0, sourceSummary: { projectPrompts: 0, userPrompts: 0, projectLibraryCommands: 0, userLibraryCommands: 0, projectHiddenLibraryCommands: 0, userHiddenLibraryCommands: 0, projectLibraryFragments: 0, userLibraryFragments: 0 }, diagnostics, includeGraphs: [] });
	assert.ok(Buffer.byteLength(report, "utf8") <= 65536);
	assert.ok(report.split("\n").length <= 400);
	assert.match(report, /omitted/);
	assert.doesNotMatch(report, /\x1b|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/);
});


test("validatePromptTemplates rejects project skills from a delegated cwd outside the trusted session root", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const delegatedCwd = join(root, "outside-project");
		const promptsDir = join(cwd, ".pi", "prompts");
		const skillDir = join(delegatedCwd, ".pi", "skills", "outside-only");
		mkdirSync(promptsDir, { recursive: true });
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "untrusted skill content");
		writeFileSync(join(promptsDir, "delegated.md"), `---\nmodel: openai/gpt-test\nsubagent: true\ncwd: ${delegatedCwd}\nskill: outside-only\n---\nx`);

		const outcome = validatePromptTemplates(cwd);
		const diagnostic = outcome.diagnostics.find((item) => item.code === "delegated-cwd-trust");
		assert.match(diagnostic?.message ?? "", /outside the trusted session root/i);
	});
});
