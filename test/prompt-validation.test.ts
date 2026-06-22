import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("validatePromptTemplates allows skill-bearing parallel targets", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "skills", "some-skill"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "skills", "some-skill", "SKILL.md"), "# some skill\n");
		writeFileSync(join(cwd, ".pi", "prompts", "plain-skill.md"), "---\nmodel: claude-sonnet-4-20250514\nskills: [some-skill]\n---\nplain with skill");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), "---\nmodel: claude-sonnet-4-20250514\nsubagent: true\n---\nworker");
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(plain-skill, worker)"\n---\nignored');

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, true);
		assert.equal(result.diagnostics.some((entry) => entry.code === "parallel-skill-subagent-incompatible"), false);
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

test("validatePromptTemplates validates best-of-N preset references and preset files", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "missing.md"), "---\nbestOfN:\n  preset: missing\n---\n$@");
		writeFileSync(join(cwd, ".pi", "prompts", "invalid-preset-file.md"), "---\nbestOfN:\n  preset: bad\n---\n$@");
		writeFileSync(join(cwd, ".pi", "best-of-n-presets.json"), JSON.stringify({ presets: { bad: { workers: [] } } }));

		const result = validatePromptTemplates(cwd);
		const codes = result.diagnostics.map((diagnostic) => diagnostic.code);

		assert.equal(result.ok, false);
		assert.equal(codes.filter((code) => code === "invalid-best-of-n-preset").length, 1);
		assert.equal(codes.filter((code) => code === "best-of-n-preset-not-found").length, 2);
		assert.match(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /references missing best-of-N preset "missing"/);
		assert.match(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /references missing best-of-N preset "bad"/);
	});
});

test("validatePromptTemplates ignores invalid preset files when no prompt references a preset", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "plain.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nbody");
		writeFileSync(join(cwd, ".pi", "best-of-n-presets.json"), "{ not json");

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, true);
		assert.deepEqual(result.diagnostics, []);
	});
});

test("validatePromptTemplates resolves best-of-N presets from prompt cwd", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const target = join(root, "target");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(target, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "compare.md"), `---\ncwd: ${target}\nbestOfN:\n  preset: targetQuick\n---\n$@`);
		writeFileSync(join(target, ".pi", "best-of-n-presets.json"), JSON.stringify({ presets: { targetQuick: { workers: [{ agent: "delegate" }] } } }));

		const result = validatePromptTemplates(cwd);

		assert.equal(result.ok, true);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "best-of-n-preset-not-found"), false);
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
