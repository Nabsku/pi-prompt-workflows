import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPromptCommandDescription, collectPromptSourceRecords, loadPromptsWithModel, RESERVED_COMMAND_NAMES, resolveSkillPath } from "../prompt-loader.js";
import { loadBestOfNPresetCatalog } from "../best-of-n-presets.js";

function withTempHome(run: (root: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-workflows-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

test("loadPromptsWithModel keeps the first same-layer duplicate after lexical sorting", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts", "alpha"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompts", "zeta"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "alpha", "dup.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nalpha');
		writeFileSync(join(cwd, ".pi", "prompts", "zeta", "dup.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nzeta');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("dup")?.content, "alpha");
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /conflicts with/);
	});
});

test("loadPromptsWithModel lets project prompts override user prompts", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, ".pi", "agent", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(root, ".pi", "agent", "prompts", "same.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nuser');
		writeFileSync(join(cwd, ".pi", "prompts", "same.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nproject');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("same")?.source, "project");
		assert.equal(result.prompts.get("same")?.content, "project");
	});
});

test("loadPromptsWithModel skips reserved command names and surfaces diagnostics", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "model.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nhello');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("model"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /reserved/);
	});
});

test("loadPromptsWithModel uses canonical frontmatter parsing for booleans and warns on invalid thinking", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "debug.md"),
			'---\nmodel: claude-sonnet-4-20250514\nrestore: false\nthinking: turbo\ndescription: "Debug prompt"\n---\nbody',
		);

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("debug")?.restore, false);
		assert.equal(result.prompts.get("debug")?.description, "Debug prompt");
		assert.equal(result.prompts.get("debug")?.thinking, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid thinking level/i);
	});
});

test("loadPromptsWithModel trims optional string frontmatter fields", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "trimmed.md"),
			'---\nmodel: claude-sonnet-4-20250514\ndescription: "  Trim me  "\nskill: "  tmux  "\nthinking: " high "\n---\nbody',
		);

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("trimmed")?.description, "Trim me");
		assert.equal(result.prompts.get("trimmed")?.skill, "tmux");
		assert.equal(result.prompts.get("trimmed")?.thinking, "high");
	});
});

test("loadPromptsWithModel normalizes plural skills frontmatter", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "multi.md"), "---\nmodel: claude-sonnet-4-20250514\nskills: [tmux, repo-review]\n---\nbody");
		writeFileSync(join(cwd, ".pi", "prompts", "single.md"), "---\nmodel: claude-sonnet-4-20250514\nskill: tmux\n---\nbody");
		writeFileSync(join(cwd, ".pi", "prompts", "combined.md"), "---\nmodel: claude-sonnet-4-20250514\nskill: skill:tmux\nskills: [golang-style]\n---\nbody");

		const result = loadPromptsWithModel(cwd);

		assert.deepEqual(result.prompts.get("multi")?.skills, ["tmux", "repo-review"]);
		assert.equal(result.prompts.get("multi")?.skill, undefined);
		assert.deepEqual(result.prompts.get("single")?.skills, ["tmux"]);
		assert.equal(result.prompts.get("single")?.skill, "tmux");
		assert.equal(buildPromptCommandDescription(result.prompts.get("single")!), "[claude-sonnet-4-20250514 +tmux] (project)");
		assert.deepEqual(result.prompts.get("combined")?.skills, ["tmux", "golang-style"]);
		assert.equal(result.prompts.get("combined")?.skill, "tmux");
	});
});

test("loadPromptsWithModel rejects invalid plural skills frontmatter", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "scalar.md"), "---\nmodel: claude-sonnet-4-20250514\nskills: tmux\n---\nbody");
		writeFileSync(join(cwd, ".pi", "prompts", "empty.md"), '---\nmodel: claude-sonnet-4-20250514\nskills: ["", "tmux"]\n---\nbody');
		writeFileSync(join(cwd, ".pi", "prompts", "bad-space.md"), '---\nmodel: claude-sonnet-4-20250514\nskills: ["bad name"]\n---\nbody');
		writeFileSync(join(cwd, ".pi", "prompts", "bad-xml.md"), '---\nmodel: claude-sonnet-4-20250514\nskills: ["bad<xml"]\n---\nbody');
		writeFileSync(join(cwd, ".pi", "prompts", "bad-path.md"), '---\nmodel: claude-sonnet-4-20250514\nskills: ["../tmux"]\n---\nbody');
		const invalidWildcards = ["*", "skill:*", "go**", "go*lang", "go?*", "../go-*", "foo/bar-*"];
		for (const [index, selector] of invalidWildcards.entries()) {
			writeFileSync(join(cwd, ".pi", "prompts", `bad-wildcard-${index}.md`), `---\nmodel: claude-sonnet-4-20250514\nskill: ${JSON.stringify(selector)}\n---\nbody`);
		}

		const result = loadPromptsWithModel(cwd);

		assert.equal(result.prompts.has("scalar"), false);
		assert.equal(result.prompts.has("empty"), false);
		assert.equal(result.prompts.has("bad-space"), false);
		assert.equal(result.prompts.has("bad-xml"), false);
		assert.equal(result.prompts.has("bad-path"), false);
		for (let index = 0; index < invalidWildcards.length; index++) {
			assert.equal(result.prompts.has(`bad-wildcard-${index}`), false);
		}
		assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.code === "invalid-skills").length, 5 + invalidWildcards.length);
	});
});

test("loadPromptsWithModel treats skills as model-less extension config", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "skill-only.md"), "---\nskills: [tmux]\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("skill-only");
		assert.ok(prompt);
		assert.deepEqual(prompt.models, []);
		assert.deepEqual(prompt.skills, ["tmux"]);
	});
});

test("buildPromptCommandDescription displays every normalized skill label", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "multi-desc.md"),
			"---\nmodel: claude-sonnet-4-20250514\nskills: [tmux, golang-style, golang-tests]\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		assert.equal(buildPromptCommandDescription(result.prompts.get("multi-desc")!), "[claude-sonnet-4-20250514 +tmux,+golang-style,+golang-tests] (project)");
	});
});

test("chain wrapper templates ignore skill and skills without diagnostics", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "chain-skills.md"), '---\nchain: "analyze -> fix"\nskill: 42\nskills: tmux\n---\nignored');

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-skills");
		assert.ok(prompt);
		assert.equal(prompt.chain, "analyze -> fix");
		assert.equal(prompt.skill, undefined);
		assert.equal(prompt.skills, undefined);
		assert.doesNotMatch(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /invalid skill|invalid skills/i);
	});
});

test("loadPromptsWithModel allows subagent prompts combined with skill frontmatter", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "subagent-skill.md"), "---\nmodel: claude-sonnet-4-20250514\nsubagent: delegate\nskill: tmux\n---\nbody");
		writeFileSync(join(cwd, ".pi", "prompts", "subagent-skills.md"), "---\nmodel: claude-sonnet-4-20250514\nsubagent: delegate\nskills: [tmux]\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("subagent-skill")?.subagent, "delegate");
		assert.deepEqual(result.prompts.get("subagent-skill")?.skills, ["tmux"]);
		assert.equal(result.prompts.get("subagent-skills")?.subagent, "delegate");
		assert.deepEqual(result.prompts.get("subagent-skills")?.skills, ["tmux"]);
		assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.code === "invalid-subagent-skills").length, 0);
	});
});

test("loadPromptsWithModel allows non-chain prompts without model and defaults description to current", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "inherit.md"), '---\ndescription: "inherit"\nskill: tmux\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("inherit");
		assert.ok(prompt);
		assert.deepEqual(prompt.models, []);
		assert.equal(buildPromptCommandDescription(prompt), "inherit [current +tmux] (project)");
	});
});

test("loadPromptsWithModel ignores generic prompts without model or extension features", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), '---\ndescription: "plain prompt"\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("review"), false);
	});
});

test("loadPromptsWithModel does not treat visibility metadata alone as command-capable", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompt-library"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "plain-hidden.md"), "---\nhidden: true\ndescription: helper\n---\nPlain helper");
		writeFileSync(join(cwd, ".pi", "prompt-library", "library-hidden.md"), "---\nhidden: true\ndescription: helper\n---\nLibrary helper");
		writeFileSync(join(cwd, ".pi", "prompt-library", "invalid-hidden-fragment.md"), "---\nhidden: maybe\ndescription: helper\n---\nInvalid hidden helper");
		writeFileSync(join(cwd, ".pi", "prompt-library", "hidden-command.md"), "---\nmodel: claude-sonnet-4-20250514\nhidden: true\n---\nHidden command");

		const runtime = loadPromptsWithModel(cwd);
		const chainRuntime = loadPromptsWithModel(cwd, true);
		assert.equal(runtime.prompts.has("plain-hidden"), false);
		assert.equal(runtime.prompts.has("library-hidden"), false);
		assert.equal(runtime.prompts.get("hidden-command")?.hidden, true);
		assert.equal(chainRuntime.prompts.get("plain-hidden")?.content, "Plain helper");
		assert.equal(chainRuntime.prompts.has("library-hidden"), false);

		const records = collectPromptSourceRecords(cwd, true);
		const libraryHidden = records.records.find((record) => record.promptName === "library-hidden");
		assert.ok(libraryHidden);
		assert.equal(libraryHidden.rootKind, "prompt-library");
		assert.equal(libraryHidden.promptCapable, false);
		assert.equal(libraryHidden.hidden, true);
		assert.equal(libraryHidden.rawBody, "Library helper");
		const invalidHiddenFragment = records.records.find((record) => record.promptName === "invalid-hidden-fragment");
		assert.ok(invalidHiddenFragment);
		assert.equal(invalidHiddenFragment.promptCapable, false);
		assert.equal(invalidHiddenFragment.hidden, undefined);
		const hiddenCommand = records.records.find((record) => record.promptName === "hidden-command");
		assert.ok(hiddenCommand);
		assert.equal(hiddenCommand.promptCapable, true);
		assert.equal(hiddenCommand.hidden, true);
		assert.equal(records.diagnostics.length, 0);
	});
});

test("invalid hidden warns on command-capable prompt-library commands but stays quiet on fragments", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompt-library"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-library", "bad-command.md"), "---\nmodel: claude-sonnet-4-20250514\nhidden: maybe\n---\nCommand $@");
		writeFileSync(join(cwd, ".pi", "prompt-library", "bad-fragment.md"), "---\nhidden: maybe\ndescription: helper\n---\nFragment helper");

		const result = loadPromptsWithModel(cwd);
		const command = result.prompts.get("bad-command");
		assert.ok(command);
		assert.equal(command.hidden, undefined);
		const invalidHiddenDiagnostics = result.diagnostics.filter((diagnostic) => diagnostic.code === "invalid-hidden");
		assert.equal(invalidHiddenDiagnostics.length, 1);
		assert.match(invalidHiddenDiagnostics[0]!.message, /bad-command\.md/);
		assert.doesNotMatch(invalidHiddenDiagnostics[0]!.message, /bad-fragment\.md/);

		const records = collectPromptSourceRecords(cwd, true);
		const fragment = records.records.find((record) => record.promptName === "bad-fragment");
		assert.ok(fragment);
		assert.equal(fragment.promptCapable, false);
		assert.equal(fragment.hidden, undefined);
		assert.equal(records.diagnostics.some((diagnostic) => diagnostic.code === "invalid-hidden" && /bad-fragment\.md/.test(diagnostic.message)), false);
	});
});

test("loadPromptsWithModel can include plain prompts for chain resolution without changing default loading", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), '---\ndescription: "plain prompt"\n---\nbody');

		const defaultResult = loadPromptsWithModel(cwd);
		const chainResult = loadPromptsWithModel(cwd, true);

		assert.equal(defaultResult.prompts.has("review"), false);
		assert.equal(chainResult.prompts.get("review")?.content, "body");
		assert.deepEqual(chainResult.prompts.get("review")?.models, []);
	});
});

test("prompt-library roots are inventoried with root metadata without promoting plain library files", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectPrompts = join(cwd, ".pi", "prompts");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		const userLibrary = join(root, ".pi", "agent", "prompt-library");
		mkdirSync(projectPrompts, { recursive: true });
		mkdirSync(join(projectLibrary, "partials"), { recursive: true });
		mkdirSync(userLibrary, { recursive: true });
		writeFileSync(join(projectPrompts, "core.md"), "---\nmodel: claude-sonnet-4-20250514\n---\ncore");
		writeFileSync(join(projectLibrary, "review.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nreview");
		writeFileSync(join(projectLibrary, "partials", "rules.md"), "Follow repo standards.");
		writeFileSync(join(userLibrary, "global-rules.md"), "User library fragment.");

		const runtime = loadPromptsWithModel(cwd, true);
		assert.equal(runtime.prompts.get("core")?.rootKind, "prompts");
		assert.equal(runtime.prompts.get("review")?.source, "project");
		assert.equal(runtime.prompts.get("review")?.rootKind, "prompt-library");
		assert.equal(runtime.prompts.get("review")?.filePath, join(projectLibrary, "review.md"));
		assert.equal(runtime.prompts.has("rules"), false);
		assert.equal(runtime.prompts.has("global-rules"), false);

		const records = collectPromptSourceRecords(cwd, true);
		const core = records.records.find((record) => record.promptName === "core");
		assert.ok(core);
		assert.equal(core.rootKind, "prompts");
		assert.equal(core.promptCapable, true);

		const review = records.records.find((record) => record.promptName === "review");
		assert.ok(review);
		assert.equal(review.source, "project");
		assert.equal(review.rootKind, "prompt-library");
		assert.equal(review.filePath, join(projectLibrary, "review.md"));
		assert.equal(review.promptRoot, projectLibrary);
		assert.equal(review.promptCapable, true);

		const rules = records.records.find((record) => record.promptName === "rules");
		assert.ok(rules);
		assert.equal(rules.source, "project");
		assert.equal(rules.rootKind, "prompt-library");
		assert.equal(rules.promptRoot, projectLibrary);
		assert.equal(rules.promptCapable, false);
		assert.equal(rules.rawBody, "Follow repo standards.");

		const globalRules = records.records.find((record) => record.promptName === "global-rules");
		assert.ok(globalRules);
		assert.equal(globalRules.source, "user");
		assert.equal(globalRules.rootKind, "prompt-library");
		assert.equal(globalRules.promptRoot, userLibrary);
		assert.equal(globalRules.promptCapable, false);
	});
});

test("skipped prompt-library source records retain root kind and prompt capability", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(projectLibrary, { recursive: true });
		writeFileSync(join(projectLibrary, "settings.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nreserved");
		writeFileSync(join(projectLibrary, "bad-includes.md"), '---\nmodel: claude-sonnet-4-20250514\ninclude: one.md\nincludes: ["two.md"]\n---\nbody');

		const runtime = loadPromptsWithModel(cwd, true);
		assert.equal(runtime.prompts.has("settings"), false);
		assert.equal(runtime.prompts.has("bad-includes"), false);

		const records = collectPromptSourceRecords(cwd, true);
		const reserved = records.records.find((record) => record.promptName === "settings");
		assert.ok(reserved);
		assert.equal(reserved.rootKind, "prompt-library");
		assert.equal(reserved.promptCapable, true);
		assert.equal(reserved.skippedReason, "reserved-command-name");

		const badIncludes = records.records.find((record) => record.promptName === "bad-includes");
		assert.ok(badIncludes);
		assert.equal(badIncludes.rootKind, "prompt-library");
		assert.equal(badIncludes.promptCapable, true);
		assert.equal(badIncludes.includeMetadataInvalid, true);
		assert.equal(badIncludes.skippedReason, "invalid-includes-conflict");
	});
});

test("prompt-library invalid include metadata without model remains prompt-capable source inventory", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(projectLibrary, { recursive: true });
		writeFileSync(join(projectLibrary, "bad-includes.md"), '---\ninclude: one.md\nincludes: ["two.md"]\n---\nbody');

		const records = collectPromptSourceRecords(cwd, false);
		const badIncludes = records.records.find((record) => record.promptName === "bad-includes");
		assert.ok(badIncludes);
		assert.equal(badIncludes.rootKind, "prompt-library");
		assert.equal(badIncludes.promptCapable, true);
		assert.equal(badIncludes.includeMetadataInvalid, true);
		assert.equal(badIncludes.skippedReason, "invalid-includes-conflict");
	});
});

test("reserved prompt-library body-only inline records stay include-only", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(projectLibrary, { recursive: true });
		writeFileSync(join(projectLibrary, "settings.md"), '---\ndescription: "reserved"\n---\n<include file="partials/rules.md" />');
		writeFileSync(join(projectLibrary, "model.md"), '---\ninclude: partials/rules.md\n---\n<includes />');

		const records = collectPromptSourceRecords(cwd, false);
		const inlineReserved = records.records.find((record) => record.promptName === "settings");
		assert.ok(inlineReserved);
		assert.equal(inlineReserved.rootKind, "prompt-library");
		assert.equal(inlineReserved.promptCapable, false);
		assert.equal(inlineReserved.hasInlineIncludes, true);
		assert.equal(inlineReserved.skippedReason, "reserved-command-name");

		const placeholderReserved = records.records.find((record) => record.promptName === "model");
		assert.ok(placeholderReserved);
		assert.equal(placeholderReserved.rootKind, "prompt-library");
		assert.equal(placeholderReserved.promptCapable, true);
		assert.equal(placeholderReserved.hasIncludesPlaceholder, true);
		assert.equal(placeholderReserved.skippedReason, "reserved-command-name");
	});
});

test("prompt-library body-only inline includes stay include-only while include metadata remains command-capable", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(join(projectLibrary, "partials"), { recursive: true });
		writeFileSync(join(projectLibrary, "inline-only.md"), '<include file="partials/rules.md" />');
		writeFileSync(join(projectLibrary, "metadata-include.md"), '---\ninclude: partials/rules.md\n---\n<includes />');
		writeFileSync(join(projectLibrary, "model-inline.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nBefore <include file="partials/rules.md" /> After');
		writeFileSync(join(projectLibrary, "partials", "rules.md"), "rules");

		const defaultResult = loadPromptsWithModel(cwd);
		assert.equal(defaultResult.prompts.has("inline-only"), false);
		assert.equal(defaultResult.prompts.has("metadata-include"), true);
		assert.equal(defaultResult.prompts.has("model-inline"), true);
		assert.equal(defaultResult.prompts.get("model-inline")?.content, "Before rules After");
		assert.ok(defaultResult.prompts.get("model-inline")?.includeGraph);

		const records = collectPromptSourceRecords(cwd, true);
		assert.equal(records.records.find((record) => record.promptName === "inline-only")?.promptCapable, false);
		assert.equal(records.records.find((record) => record.promptName === "metadata-include")?.promptCapable, true);
		assert.equal(records.records.find((record) => record.promptName === "model-inline")?.promptCapable, true);
	});
});

test("include-only prompt-library fragments do not render missing inline includes before being skipped", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(projectLibrary, { recursive: true });
		writeFileSync(join(projectLibrary, "fragment.md"), '<include file="missing.md" />');

		for (const result of [loadPromptsWithModel(cwd), loadPromptsWithModel(cwd, true)]) {
			assert.equal(result.prompts.has("fragment"), false);
			assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found"), false);
		}

		const records = collectPromptSourceRecords(cwd, true);
		const record = records.records.find((item) => item.promptName === "fragment");
		assert.ok(record);
		assert.equal(record.rootKind, "prompt-library");
		assert.equal(record.promptCapable, false);
		assert.equal(record.hasInlineIncludes, true);
	});
});

test("project prompt-library root is rejected when a .pi ancestor is symlinked outside the project", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const outsidePi = join(root, "outside-pi");
		mkdirSync(join(outsidePi, "prompt-library"), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(outsidePi, "prompt-library", "escape.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nescape");
		symlinkSync(outsidePi, join(cwd, ".pi"), "dir");

		const result = loadPromptsWithModel(cwd, true);
		assert.equal(result.prompts.has("escape"), false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "symlink-outside-prompt-root"), true);
		assert.match(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /symlinked through ancestors/);
	});
});

test("source records exclude plain prompt-library fragments unless requested", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(join(projectLibrary, "partials"), { recursive: true });
		writeFileSync(join(projectLibrary, "command.md"), "---\nmodel: claude-sonnet-4-20250514\n---\ncommand");
		writeFileSync(join(projectLibrary, "partials", "rules.md"), "plain fragment");

		const defaultRecords = collectPromptSourceRecords(cwd, false);
		assert.ok(defaultRecords.records.find((record) => record.promptName === "command"));
		assert.equal(defaultRecords.records.some((record) => record.promptName === "rules"), false);

		const plainRecords = collectPromptSourceRecords(cwd, true);
		assert.ok(plainRecords.records.find((record) => record.promptName === "rules"));
	});
});

test("prompt-library model prompts load in default and plain-including runtime catalogs", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(projectLibrary, { recursive: true });
		writeFileSync(join(projectLibrary, "review.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nReview $@");

		const defaultResult = loadPromptsWithModel(cwd);
		const plainResult = loadPromptsWithModel(cwd, true);

		assert.equal(defaultResult.prompts.get("review")?.content, "Review $@");
		assert.equal(defaultResult.prompts.get("review")?.rootKind, "prompt-library");
		assert.equal(plainResult.prompts.get("review")?.content, "Review $@");
		assert.equal(plainResult.prompts.get("review")?.rootKind, "prompt-library");
	});
});

test("prompt-library scalar skill alone is prompt-capable in both runtime catalogs", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(projectLibrary, { recursive: true });
		writeFileSync(join(projectLibrary, "skill-only.md"), "---\nskill: tmux\n---\nUse tmux.");

		for (const result of [loadPromptsWithModel(cwd), loadPromptsWithModel(cwd, true)]) {
			const prompt = result.prompts.get("skill-only");
			assert.ok(prompt);
			assert.equal(prompt.rootKind, "prompt-library");
			assert.deepEqual(prompt.models, []);
			assert.equal(prompt.skill, "tmux");
			assert.deepEqual(prompt.skills, ["tmux"]);
			assert.equal(prompt.content, "Use tmux.");
		}

		const records = collectPromptSourceRecords(cwd, true);
		assert.equal(records.records.find((record) => record.promptName === "skill-only")?.promptCapable, true);
	});
});

test("prompt-library plural skills alone are prompt-capable in both runtime catalogs", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(projectLibrary, { recursive: true });
		writeFileSync(join(projectLibrary, "skills-only.md"), "---\nskills:\n  - tmux\n---\nUse tmux.");

		for (const result of [loadPromptsWithModel(cwd), loadPromptsWithModel(cwd, true)]) {
			const prompt = result.prompts.get("skills-only");
			assert.ok(prompt);
			assert.equal(prompt.rootKind, "prompt-library");
			assert.deepEqual(prompt.models, []);
			assert.equal(prompt.skill, undefined);
			assert.deepEqual(prompt.skills, ["tmux"]);
			assert.equal(prompt.content, "Use tmux.");
		}
	});
});

test("plain prompt-library files stay include-only even when plain prompts are requested", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(projectLibrary, { recursive: true });
		writeFileSync(join(projectLibrary, "plain.md"), "Follow repo standards.");

		assert.equal(loadPromptsWithModel(cwd).prompts.has("plain"), false);
		assert.equal(loadPromptsWithModel(cwd, true).prompts.has("plain"), false);

		const defaultRecords = collectPromptSourceRecords(cwd, false);
		assert.equal(defaultRecords.records.some((record) => record.promptName === "plain"), false);
		const plainRecords = collectPromptSourceRecords(cwd, true);
		const record = plainRecords.records.find((item) => item.promptName === "plain");
		assert.ok(record);
		assert.equal(record.rootKind, "prompt-library");
		assert.equal(record.promptCapable, false);
		assert.equal(record.rawBody, "Follow repo standards.");
	});
});

test("prompt-library invalid-only thinking metadata does not promote plain files", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(projectLibrary, { recursive: true });
		writeFileSync(join(projectLibrary, "invalid-thinking.md"), "---\nthinking: turbo\n---\nPlain library fragment.");

		assert.equal(loadPromptsWithModel(cwd).prompts.has("invalid-thinking"), false);
		const plainRuntime = loadPromptsWithModel(cwd, true);
		assert.equal(plainRuntime.prompts.has("invalid-thinking"), false);
		assert.equal(plainRuntime.diagnostics.some((diagnostic) => diagnostic.code === "invalid-thinking"), false);

		const records = collectPromptSourceRecords(cwd, true);
		const record = records.records.find((item) => item.promptName === "invalid-thinking");
		assert.ok(record);
		assert.equal(record.rootKind, "prompt-library");
		assert.equal(record.promptCapable, false);
		assert.equal(record.rawBody, "Plain library fragment.");
		assert.equal(records.diagnostics.some((diagnostic) => diagnostic.code === "invalid-thinking"), false);
	});
});

test("prompt-library valid thinking-only metadata promotes command-capable files", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(projectLibrary, { recursive: true });
		writeFileSync(join(projectLibrary, "thinking-only.md"), "---\nthinking: high\n---\nThink hard about $@");

		const prompt = loadPromptsWithModel(cwd).prompts.get("thinking-only");
		assert.ok(prompt);
		assert.equal(prompt.rootKind, "prompt-library");
		assert.equal(prompt.thinking, "high");
		assert.equal(prompt.content, "Think hard about $@");
		assert.match(buildPromptCommandDescription(prompt), /\(project library\)$/);
	});
});

test("prompt-library model-conditional body promotes command-capable files", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(projectLibrary, { recursive: true });
		writeFileSync(join(projectLibrary, "conditional.md"), '<if-model is="anthropic/*">Use Claude</if-model>');

		const prompt = loadPromptsWithModel(cwd).prompts.get("conditional");
		assert.ok(prompt);
		assert.equal(prompt.rootKind, "prompt-library");
		assert.equal(prompt.content, '<if-model is="anthropic/*">Use Claude</if-model>');

		const records = collectPromptSourceRecords(cwd, true);
		assert.equal(records.records.find((record) => record.promptName === "conditional")?.promptCapable, true);
	});
});

test("prompt-library command marker matrix matches runtime and source inventory", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(projectLibrary, { recursive: true });
		const fixtures: Array<{ name: string; frontmatter: string; assertPrompt?: (prompt: any) => void }> = [
			{ name: "model-marker", frontmatter: `model: claude-sonnet-4-20250514` },
			{ name: "skill-marker", frontmatter: `skill: tmux` },
			{ name: "skills-marker", frontmatter: `skills:\n  - tmux` },
			{ name: "thinking-marker", frontmatter: `thinking: high`, assertPrompt: (prompt) => assert.equal(prompt.thinking, "high") },
			{ name: "chain-marker", frontmatter: `chain: worker`, assertPrompt: (prompt) => assert.equal(prompt.chain, "worker") },
			{ name: "fresh-marker", frontmatter: `fresh: true`, assertPrompt: (prompt) => assert.equal(prompt.fresh, true) },
			{ name: "loop-marker", frontmatter: `loop: 2`, assertPrompt: (prompt) => assert.equal(prompt.loop, 2) },
			{ name: "converge-marker", frontmatter: `converge: false`, assertPrompt: (prompt) => assert.equal(prompt.converge, false) },
			{ name: "boomerang-marker", frontmatter: `boomerang: true`, assertPrompt: (prompt) => assert.equal(prompt.boomerang, true) },
			{ name: "subagent-marker", frontmatter: `subagent: true`, assertPrompt: (prompt) => assert.equal(prompt.subagent, true) },
			{ name: "parallel-marker", frontmatter: `subagent: true\nparallel: 2`, assertPrompt: (prompt) => assert.equal(prompt.parallel, 2) },
			{ name: "deterministic-marker", frontmatter: `deterministic:\n  run: echo hi`, assertPrompt: (prompt) => assert.equal(prompt.deterministic?.execution.command, "echo hi") },
			{ name: "run-marker", frontmatter: `run: echo hi`, assertPrompt: (prompt) => assert.equal(prompt.deterministic?.execution.command, "echo hi") },
			{ name: "script-marker", frontmatter: `script: ./script.sh`, assertPrompt: (prompt) => assert.equal(prompt.deterministic?.execution.path, "./script.sh") },
			{ name: "best-of-n-marker", frontmatter: `bestOfN:\n  workers:\n    - model: claude-sonnet-4-20250514`, assertPrompt: (prompt) => assert.equal(prompt.workers?.length, 1) },
			{ name: "worktree-marker", frontmatter: `subagent: true\nparallel: 2\nworktree: true`, assertPrompt: (prompt) => assert.equal(prompt.worktree, true) },
		];

		for (const fixture of fixtures) {
			writeFileSync(join(projectLibrary, `${fixture.name}.md`), `---\n${fixture.frontmatter}\n---\nBody for ${fixture.name}`);
		}
		writeFileSync(join(projectLibrary, "hidden-control.md"), "---\nhidden: true\ndescription: helper\n---\nHidden only");
		writeFileSync(join(projectLibrary, "false-flags-control.md"), "---\nfresh: false\nconverge: true\nboomerang: false\n---\nInactive flags only");

		const runtime = loadPromptsWithModel(cwd);
		const chainRuntime = loadPromptsWithModel(cwd, true);
		const sourceRecords = collectPromptSourceRecords(cwd, true);
		for (const fixture of fixtures) {
			const prompt = runtime.prompts.get(fixture.name);
			assert.ok(prompt, `${fixture.name} should load in the runtime catalog`);
			assert.equal(prompt.rootKind, "prompt-library");
			assert.equal(chainRuntime.prompts.has(fixture.name), true, `${fixture.name} should also load for chain resolution`);
			assert.equal(sourceRecords.records.find((record) => record.promptName === fixture.name)?.promptCapable, true, `${fixture.name} should be command-capable in source inventory`);
			fixture.assertPrompt?.(prompt);
		}

		for (const inert of ["hidden-control", "false-flags-control"]) {
			assert.equal(runtime.prompts.has(inert), false, `${inert} must not load as a command`);
			assert.equal(chainRuntime.prompts.has(inert), false, `${inert} must not load for chain resolution`);
			assert.equal(sourceRecords.records.find((record) => record.promptName === inert)?.promptCapable, false, `${inert} must stay include-only in source inventory`);
		}
	});
});

test("prompt-library fragments with non-object frontmatter stay ignored and quiet", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(projectLibrary, { recursive: true });
		writeFileSync(join(projectLibrary, "bad-frontmatter.md"), "---\n- shared\n---\nPlain library fragment.");

		const defaultRuntime = loadPromptsWithModel(cwd);
		assert.equal(defaultRuntime.prompts.has("bad-frontmatter"), false);
		assert.equal(defaultRuntime.diagnostics.some((diagnostic) => diagnostic.code === "invalid-frontmatter"), false);

		const plainRuntime = loadPromptsWithModel(cwd, true);
		assert.equal(plainRuntime.prompts.has("bad-frontmatter"), false);
		assert.equal(plainRuntime.diagnostics.some((diagnostic) => diagnostic.code === "invalid-frontmatter"), false);

		const records = collectPromptSourceRecords(cwd, true);
		const record = records.records.find((item) => item.promptName === "bad-frontmatter");
		assert.ok(record);
		assert.equal(record.rootKind, "prompt-library");
		assert.equal(record.promptCapable, false);
		assert.equal(record.rawBody, "Plain library fragment.");
		assert.equal(records.diagnostics.some((diagnostic) => diagnostic.code === "invalid-frontmatter"), false);
	});
});

test("plain .pi/prompts files still load only when plain prompts are requested", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "plain.md"), "Plain project prompt.");

		assert.equal(loadPromptsWithModel(cwd).prompts.has("plain"), false);
		const prompt = loadPromptsWithModel(cwd, true).prompts.get("plain");
		assert.ok(prompt);
		assert.equal(prompt.rootKind, "prompts");
		assert.equal(prompt.content, "Plain project prompt.");
	});
});

test("project prompt-library overrides user prompt-library for command-capable files", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const userLibrary = join(root, ".pi", "agent", "prompt-library");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(userLibrary, { recursive: true });
		mkdirSync(projectLibrary, { recursive: true });
		writeFileSync(join(userLibrary, "same.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nuser library");
		writeFileSync(join(projectLibrary, "same.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nproject library");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("same")?.source, "project");
		assert.equal(result.prompts.get("same")?.rootKind, "prompt-library");
		assert.equal(result.prompts.get("same")?.content, "project library");
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "duplicate-command-name"), false);
	});
});

test("same-source duplicate inside prompt-library keeps first lexical winner and reports diagnostic", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(join(projectLibrary, "a"), { recursive: true });
		mkdirSync(join(projectLibrary, "z"), { recursive: true });
		writeFileSync(join(projectLibrary, "a", "dup.md"), "---\nmodel: claude-sonnet-4-20250514\n---\na");
		writeFileSync(join(projectLibrary, "z", "dup.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nz");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("dup")?.content, "a");
		assert.equal(result.prompts.get("dup")?.rootKind, "prompt-library");
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "duplicate-command-name"), true);
	});
});

test("same-source basename across project prompts and prompt-library prefers prompts and reports duplicate", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompt-library"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "same.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nproject prompts");
		writeFileSync(join(cwd, ".pi", "prompt-library", "same.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nproject library");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("same")?.rootKind, "prompts");
		assert.equal(result.prompts.get("same")?.content, "project prompts");
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "duplicate-command-name"), true);
	});
});

test("prompt root precedence matrix across prompts and prompt-library is deterministic", () => {
	withTempHome((root) => {
		const cases = [
			{
				name: "user-prompts-vs-user-library",
				left: ["user", "prompts", "user prompts"] as const,
				right: ["user", "prompt-library", "user library"] as const,
				expectedSource: "user",
				expectedRootKind: "prompts",
				expectedContent: "user prompts",
				expectDuplicate: true,
			},
			{
				name: "project-prompts-vs-project-library",
				left: ["project", "prompts", "project prompts"] as const,
				right: ["project", "prompt-library", "project library"] as const,
				expectedSource: "project",
				expectedRootKind: "prompts",
				expectedContent: "project prompts",
				expectDuplicate: true,
			},
			{
				name: "user-prompts-vs-project-library",
				left: ["user", "prompts", "user prompts"] as const,
				right: ["project", "prompt-library", "project library"] as const,
				expectedSource: "project",
				expectedRootKind: "prompt-library",
				expectedContent: "project library",
				expectDuplicate: false,
			},
			{
				name: "user-library-vs-project-prompts",
				left: ["user", "prompt-library", "user library"] as const,
				right: ["project", "prompts", "project prompts"] as const,
				expectedSource: "project",
				expectedRootKind: "prompts",
				expectedContent: "project prompts",
				expectDuplicate: false,
			},
		] as const;

		function dirFor(cwd: string, source: "user" | "project", kind: "prompts" | "prompt-library") {
			return source === "user" ? join(root, ".pi", "agent", kind) : join(cwd, ".pi", kind);
		}

		for (const testCase of cases) {
			rmSync(join(root, ".pi"), { recursive: true, force: true });
			const cwd = join(root, testCase.name);
			for (const [source, kind, content] of [testCase.left, testCase.right]) {
				const dir = dirFor(cwd, source, kind);
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "same.md"), `---\nmodel: claude-sonnet-4-20250514\n---\n${content}`);
			}

			const result = loadPromptsWithModel(cwd);
			const prompt = result.prompts.get("same");
			assert.ok(prompt, testCase.name);
			assert.equal(prompt.source, testCase.expectedSource, testCase.name);
			assert.equal(prompt.rootKind, testCase.expectedRootKind, testCase.name);
			assert.equal(prompt.content, testCase.expectedContent, testCase.name);
			assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "duplicate-command-name"), testCase.expectDuplicate, testCase.name);
		}
	});
});

test("reserved names in prompt-library are skipped and reported", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(projectLibrary, { recursive: true });
		writeFileSync(join(projectLibrary, "settings.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nsettings");
		writeFileSync(join(projectLibrary, "print-prompt.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nprint");

		const result = loadPromptsWithModel(cwd, true);
		assert.equal(result.prompts.has("settings"), false);
		assert.equal(result.prompts.has("print-prompt"), false);
		assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.code === "reserved-command-name").length, 2);

		const records = collectPromptSourceRecords(cwd, true);
		for (const name of ["settings", "print-prompt"]) {
			const record = records.records.find((item) => item.promptName === name);
			assert.ok(record);
			assert.equal(record.rootKind, "prompt-library");
			assert.equal(record.promptCapable, true);
			assert.equal(record.skippedReason, "reserved-command-name");
		}
	});
});

test("prompt-library prompt includes resolve from prompt-library roots", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(join(projectLibrary, "partials"), { recursive: true });
		writeFileSync(join(projectLibrary, "review.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: partials/rules.md\n---\nreview body");
		writeFileSync(join(projectLibrary, "partials", "rules.md"), "library rules");

		const runtime = loadPromptsWithModel(cwd, true);
		const prompt = runtime.prompts.get("review");
		assert.ok(prompt);
		assert.equal(prompt.content, "library rules\n\nreview body");
		assert.equal(prompt.rootKind, "prompt-library");
		assert.equal(prompt.includeGraph?.root.rootKind, "prompt-library");
		assert.equal(runtime.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found"), false);
	});
});

test("source record exists for a prompt with missing include that runtime loader skips", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "missing-include.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: shared/missing.md\n---\nbody");

		const runtime = loadPromptsWithModel(cwd);
		assert.equal(runtime.prompts.has("missing-include"), false);
		assert.equal(runtime.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found"), true);

		const records = collectPromptSourceRecords(cwd, true);
		const missing = records.records.find((record) => record.promptName === "missing-include");
		assert.ok(missing);
		assert.deepEqual(missing.includes, ["shared/missing.md"]);
		assert.equal(missing.rawBody, "body");
		assert.equal(missing.isChainWrapper, false);
		assert.equal(records.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found"), true);
	});
});

test("source record keeps raw body and normalized includes", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "with-source.md"),
			'---\nmodel: claude-sonnet-4-20250514\nincludes: [" shared/common.md ", "shared/evidence.md"]\n---\nintro\n<includes />\n<include file="shared/inline.md" />',
		);

		const records = collectPromptSourceRecords(cwd, true);
		const record = records.records.find((item) => item.promptName === "with-source");
		assert.ok(record);
		assert.deepEqual(record.includes, ["shared/common.md", "shared/evidence.md"]);
		assert.equal(record.rawBody, 'intro\n<includes />\n<include file="shared/inline.md" />');
		assert.equal(record.hasInlineIncludes, true);
		assert.equal(record.hasIncludesPlaceholder, true);
	});
});

test("source records let project prompt override user prompt of same name", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, ".pi", "agent", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(root, ".pi", "agent", "prompts", "same.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nuser");
		writeFileSync(join(cwd, ".pi", "prompts", "same.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nproject");

		const records = collectPromptSourceRecords(cwd, true);
		assert.equal(records.records.filter((record) => record.promptName === "same").length, 1);
		const record = records.records.find((item) => item.promptName === "same");
		assert.ok(record);
		assert.equal(record.source, "project");
		assert.equal(record.rawBody, "project");
	});
});

test("source records preserve user include-skipped prompt under same-name project override", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, ".pi", "agent", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(root, ".pi", "agent", "prompts", "same.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: missing.md\n---\nuser");
		writeFileSync(join(cwd, ".pi", "prompts", "same.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nproject");

		const records = collectPromptSourceRecords(cwd, true);
		const sameRecords = records.records.filter((record) => record.promptName === "same").sort((a, b) => a.source.localeCompare(b.source));
		assert.equal(sameRecords.length, 2);
		assert.equal(sameRecords[0]?.source, "project");
		assert.equal(sameRecords[0]?.rawBody, "project");
		assert.equal(sameRecords[1]?.source, "user");
		assert.deepEqual(sameRecords[1]?.includes, ["missing.md"]);
		assert.equal(records.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found" && diagnostic.source === "user"), true);
	});
});

test("source records same-source duplicate prompt does not create ambiguous duplicate graph roots", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts", "alpha"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompts", "zeta"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "alpha", "dup.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nalpha");
		writeFileSync(join(cwd, ".pi", "prompts", "zeta", "dup.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nzeta");

		const records = collectPromptSourceRecords(cwd, true);
		const duplicates = records.records.filter((record) => record.promptName === "dup");
		assert.equal(duplicates.length, 1);
		assert.equal(duplicates[0]?.rawBody, "alpha");
		assert.equal(records.diagnostics.some((diagnostic) => diagnostic.code === "duplicate-command-name"), true);
	});
});

test("source records same-source duplicate with include failure keeps loader diagnostic without ambiguous duplicate roots", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts", "alpha"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompts", "zeta"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "alpha", "dup.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nalpha");
		writeFileSync(join(cwd, ".pi", "prompts", "zeta", "dup.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: shared/missing.md\n---\nzeta");

		const records = collectPromptSourceRecords(cwd, true);
		assert.equal(records.records.filter((record) => record.promptName === "dup").length, 1);
		assert.equal(records.records.find((record) => record.promptName === "dup")?.rawBody, "alpha");
		assert.equal(records.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found"), true);
	});
});

test("source records same-source duplicate uses later valid prompt when first duplicate is include-skipped", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts", "alpha"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompts", "zeta"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "alpha", "dup.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: shared/missing.md\n---\nalpha");
		writeFileSync(join(cwd, ".pi", "prompts", "zeta", "dup.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nzeta");

		const runtime = loadPromptsWithModel(cwd);
		assert.equal(runtime.prompts.get("dup")?.content, "zeta");
		assert.equal(runtime.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found"), true);

		const records = collectPromptSourceRecords(cwd, true);
		const duplicates = records.records.filter((record) => record.promptName === "dup");
		assert.equal(duplicates.length, 1);
		assert.equal(duplicates[0]?.rawBody, "zeta");
		assert.equal(records.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found"), true);
		assert.equal(records.diagnostics.some((diagnostic) => diagnostic.code === "duplicate-command-name"), false);
	});
});

test("source record chain wrapper body directives are marked and ignored for graph scanning", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "review"\n---\n<include file="missing.md" />\n<includes />');

		const records = collectPromptSourceRecords(cwd, true);
		const record = records.records.find((item) => item.promptName === "pipeline");
		assert.ok(record);
		assert.equal(record.isChainWrapper, true);
		assert.equal(record.rawBody, '<include file="missing.md" />\n<includes />');
		assert.equal(record.hasInlineIncludes, false);
		assert.equal(record.hasIncludesPlaceholder, false);
		assert.equal(record.includes, undefined);
	});
});

test("loadPromptsWithModel renders frontmatter includes into prompt content and skips missing includes", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompt-partials", "shared"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-partials", "shared", "common.md"), "common");
		writeFileSync(join(cwd, ".pi", "prompt-partials", "shared", "evidence.md"), "evidence");
		writeFileSync(
			join(cwd, ".pi", "prompts", "with-includes.md"),
			[
				"---",
				"model: claude-sonnet-4-20250514",
				'includes: ["shared/common.md", "shared/evidence.md"]',
				"---",
				"body",
			].join("\n"),
		);
		writeFileSync(
			join(cwd, ".pi", "prompts", "missing-include.md"),
			"---\nmodel: claude-sonnet-4-20250514\ninclude: shared/missing.md\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("with-includes");
		assert.ok(prompt);
		assert.deepEqual(prompt.includes, ["shared/common.md", "shared/evidence.md"]);
		assert.equal(prompt.content, "common\n\nevidence\n\nbody");
		assert.equal(result.prompts.has("missing-include"), false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found"), true);
	});
});

test("loadPromptsWithModel resolves nested partial includes relative to the current partial", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompt-partials", "shared"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-partials", "shared", "outer.md"), "outer-start\n<include file=\"inner.md\" />\nouter-end");
		writeFileSync(join(cwd, ".pi", "prompt-partials", "shared", "inner.md"), "inner");
		writeFileSync(
			join(cwd, ".pi", "prompts", "nested-partial.md"),
			"---\nmodel: claude-sonnet-4-20250514\ninclude: shared/outer.md\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("nested-partial")?.content, "outer-start\ninner\nouter-end\n\nbody");
		assert.equal(result.diagnostics.length, 0);
	});
});

test("loadPromptsWithModel honors <includes /> placement after include rendering", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompt-partials", "shared"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-partials", "shared", "common.md"), "common");
		writeFileSync(
			join(cwd, ".pi", "prompts", "placed.md"),
			"---\nmodel: claude-sonnet-4-20250514\ninclude: shared/common.md\n---\nbefore\n<includes />\nafter",
		);

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("placed")?.content, "before\ncommon\nafter");
		assert.equal(result.diagnostics.length, 0);
	});
});

test("loadPromptsWithModel attaches render-traversal include graph in rendered output order", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompt-partials", "shared"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-partials", "shared", "a.md"), "A");
		writeFileSync(join(cwd, ".pi", "prompt-partials", "shared", "front.md"), "F");
		writeFileSync(join(cwd, ".pi", "prompt-partials", "shared", "b.md"), "B");
		writeFileSync(
			join(cwd, ".pi", "prompts", "ordered.md"),
			[
				"---",
				"model: claude-sonnet-4-20250514",
				"include: shared/front.md",
				"---",
				'<include file="shared/a.md" />',
				"<includes />",
				'<include file="shared/b.md" />',
			].join("\n"),
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("ordered");
		assert.ok(prompt);
		assert.equal(prompt.content, "A\nF\nB");
		assert.equal(prompt.includeGraph?.root.promptName, "ordered");
		assert.equal(prompt.includeGraph?.root.source, "project");
		assert.deepEqual(prompt.includeGraph?.edges.map((edge) => edge.includePath), ["shared/a.md", "shared/front.md", "shared/b.md"]);
		assert.deepEqual(prompt.includeGraph?.edges.map((edge) => edge.kind), ["inline", "frontmatter", "inline"]);
	});
});

test("loadPromptsWithModel rejects model-less <includes /> without include metadata", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "model-less-placeholder.md"), '---\ndescription: "placeholder"\n---\nbefore <includes /> after');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("model-less-placeholder"), false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-placeholder-without-includes"), true);
		assert.match(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /frontmatter.*include/i);
	});
});

test("loadPromptsWithModel rejects model prompts with <includes /> without include metadata", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "model-placeholder.md"),
			"---\nmodel: claude-sonnet-4-20250514\n---\nbefore <includes /> after",
		);

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("model-placeholder"), false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-placeholder-without-includes"), true);
	});
});

test("loadPromptsWithModel ignores <includes /> placeholders in chain wrapper bodies", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "review"\n---\nbefore <includes /> after');

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("pipeline");
		assert.ok(prompt);
		assert.equal(prompt.chain, "review");
		assert.equal(prompt.content, "before <includes /> after");
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-placeholder-without-includes"), false);
	});
});

test("loadPromptsWithModel renders inline include tags without frontmatter includes", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "one-off.md"), "inserted");
		writeFileSync(
			join(cwd, ".pi", "prompts", "inline.md"),
			'---\nmodel: claude-sonnet-4-20250514\n---\nalpha <include file="one-off.md" /> omega',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("inline");
		assert.ok(prompt);
		assert.equal(prompt.includes, undefined);
		assert.equal(prompt.content, "alpha inserted omega");
		assert.equal(result.diagnostics.length, 0);
	});
});

test("loadPromptsWithModel treats inline-only includes as extension-specific model-less config", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "partial.md"), "from partial");
		writeFileSync(join(cwd, ".pi", "prompts", "model-less-inline.md"), '---\ndescription: "inline"\n---\n<include file="partial.md" />');

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("model-less-inline");
		assert.ok(prompt);
		assert.deepEqual(prompt.models, []);
		assert.equal(prompt.content, "from partial");
		assert.equal(result.diagnostics.length, 0);
	});
});

test("loadPromptsWithModel resolves nested prompt includes against the stable prompt root", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts", "nested"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompts", "shared"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "shared", "root.md"), "root partial");
		writeFileSync(
			join(cwd, ".pi", "prompts", "nested", "deep.md"),
			'---\nmodel: claude-sonnet-4-20250514\n---\n<include file="shared/root.md" />\nbody',
		);

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("deep")?.content, "root partial\nbody");
		assert.equal(result.prompts.get("deep")?.subdir, "nested");
		assert.equal(result.diagnostics.length, 0);
	});
});

test("loadPromptsWithModel rejects invalid prompt include frontmatter", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "both.md"),
			'---\nmodel: claude-sonnet-4-20250514\ninclude: shared/common.md\nincludes: ["shared/evidence.md"]\n---\nbody',
		);
		writeFileSync(
			join(cwd, ".pi", "prompts", "bad-includes-entry.md"),
			'---\nmodel: claude-sonnet-4-20250514\nincludes: ["shared/common.md", ""]\n---\nbody',
		);
		writeFileSync(
			join(cwd, ".pi", "prompts", "bad-includes-type.md"),
			"---\nmodel: claude-sonnet-4-20250514\nincludes: shared/common.md\n---\nbody",
		);
		writeFileSync(
			join(cwd, ".pi", "prompts", "bad-include.md"),
			'---\nmodel: claude-sonnet-4-20250514\ninclude: "   "\n---\nbody',
		);

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("both"), false);
		assert.equal(result.prompts.has("bad-includes-entry"), false);
		assert.equal(result.prompts.has("bad-includes-type"), false);
		assert.equal(result.prompts.has("bad-include"), false);
		const diagnostics = result.diagnostics.map((item) => item.message).join("\n");
		assert.match(diagnostics, /frontmatter fields "include" and "includes" cannot be combined/i);
		assert.match(diagnostics, /frontmatter field "includes" must be an array of non-empty strings/i);
		assert.match(diagnostics, /frontmatter field "include" must be a non-empty string/i);
	});
});

test("loadPromptsWithModel rejects include metadata on chain wrapper templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompt-partials", "shared"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-partials", "shared", "common.md"), "common");
		writeFileSync(join(cwd, ".pi", "prompts", "chain-include.md"), '---\nchain: "step-with-include"\ninclude: shared/common.md\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "chain-includes.md"), '---\nchain: "step-with-include"\nincludes: ["shared/common.md"]\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "step-with-include"\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "step-with-include.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: shared/common.md\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("chain-include"), false);
		assert.equal(result.prompts.has("chain-includes"), false);
		assert.equal(result.prompts.get("pipeline")?.chain, "step-with-include");
		assert.deepEqual(result.prompts.get("step-with-include")?.includes, ["shared/common.md"]);
		assert.equal(result.prompts.get("step-with-include")?.content, "common\n\nbody");
		const diagnostics = result.diagnostics.map((item) => item.message).join("\n");
		assert.match(diagnostics, /frontmatter field "include" cannot be used on chain wrapper templates/i);
		assert.match(diagnostics, /frontmatter field "includes" cannot be used on chain wrapper templates/i);
	});
});

test("loadPromptsWithModel ignores missing inline include directives in chain wrapper bodies", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "review"\n---\n<include file="missing.md" />');

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("pipeline");
		assert.ok(prompt);
		assert.equal(prompt.chain, "review");
		assert.equal(prompt.content, '<include file="missing.md" />');
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "include-not-found"), false);
	});
});

test("loadPromptsWithModel leaves existing inline include tags raw in chain wrapper bodies", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompt-partials"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-partials", "existing.md"), "rendered partial");
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "review"\n---\nbefore <include file="existing.md" /> after');

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("pipeline");
		assert.ok(prompt);
		assert.equal(prompt.chain, "review");
		assert.equal(prompt.content, 'before <include file="existing.md" /> after');
		assert.doesNotMatch(prompt.content, /rendered partial/);
		assert.equal(result.diagnostics.length, 0);
	});
});

test("loadPromptsWithModel keeps model-less prompts that use inline model conditionals", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "conditional.md"), '---\ndescription: "conditional"\n---\n<if-model is="anthropic/*">yes</if-model>');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("conditional"), true);
	});
});

test("loadPromptsWithModel keeps model-less prompts containing invalid conditional closers", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad-conditional.md"), '---\ndescription: "bad conditional"\n---\n</else>');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("bad-conditional"), true);
	});
});

test("loadPromptsWithModel ignores model-less prompts with restore-only config", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "restore-only.md"), '---\ndescription: "restore only"\nrestore: false\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("restore-only"), false);
	});
});

test("loadPromptsWithModel ignores model-less prompts with only invalid extension flags", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "invalid-loop-only.md"), '---\ndescription: "invalid loop only"\nloop: 0\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("invalid-loop-only"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid loop value/i);

		const records = collectPromptSourceRecords(cwd, false);
		assert.equal(records.records.some((record) => record.promptName === "invalid-loop-only"), false);
		assert.equal(records.diagnostics.some((diagnostic) => diagnostic.code === "invalid-loop"), true);
	});
});

test("loadPromptsWithModel treats model-less thinking as extension config and source records keep it", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "thinking-only.md"), '---\ndescription: "thinking only"\nthinking: high\n---\nbody');

		const result = loadPromptsWithModel(cwd, false);
		const prompt = result.prompts.get("thinking-only");
		assert.ok(prompt);
		assert.deepEqual(prompt.models, []);
		assert.equal(prompt.thinking, "high");

		const records = collectPromptSourceRecords(cwd, false);
		const record = records.records.find((item) => item.promptName === "thinking-only");
		assert.ok(record);
		assert.equal(record.rawBody, "body");
	});
});

test("loadPromptsWithModel skips model-less invalid skill only and source records exclude it", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "invalid-skill-only.md"), '---\ndescription: "invalid skill only"\nskill: 42\n---\nbody');

		const result = loadPromptsWithModel(cwd, false);
		assert.equal(result.prompts.has("invalid-skill-only"), false);
		assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "invalid-skills"), true);

		const records = collectPromptSourceRecords(cwd, false);
		assert.equal(records.records.some((record) => record.promptName === "invalid-skill-only"), false);
		assert.equal(records.diagnostics.some((diagnostic) => diagnostic.code === "invalid-skills"), true);
	});
});

test("source records exclude model-less invalid skill only when including plain prompts", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "invalid-skill-only.md"), '---\ndescription: "invalid skill only"\nskill: 42\n---\nbody');

		const runtime = loadPromptsWithModel(cwd, true);
		assert.equal(runtime.prompts.has("invalid-skill-only"), false);
		assert.equal(runtime.diagnostics.some((diagnostic) => diagnostic.code === "invalid-skills"), true);

		const records = collectPromptSourceRecords(cwd, true);
		assert.equal(records.records.some((record) => record.promptName === "invalid-skill-only"), false);
		assert.equal(records.diagnostics.some((diagnostic) => diagnostic.code === "invalid-skills"), true);
	});
});

test("loadPromptsWithModel still rejects explicitly empty model declarations", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad-empty.md"), '---\nmodel: "   "\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("bad-empty"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /frontmatter field "model" is empty/i);
	});
});

test("loadPromptsWithModel rejects invalid model declarations up front", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad.md"), '---\nmodel: anthropic/*\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("bad"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid model spec/i);
	});
});

test("loadPromptsWithModel accepts provider-qualified model specs with additional slashes in model ids", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "nested-model.md"), '---\nmodel: openrouter/openai/gpt-5.4\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("nested-model"), true);
		assert.deepEqual(result.prompts.get("nested-model")?.models, ["openrouter/openai/gpt-5.4"]);
		assert.equal(result.diagnostics.length, 0);
	});
});

test("loadPromptsWithModel accepts nested provider-qualified model specs in bestOfN lineups", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "compare-nested-model.md"),
			[
				"---",
				"bestOfN:",
				"  workers:",
				"    - model: openrouter/openai/gpt-5.4",
				"  reviewers:",
				"    - model: openrouter/openai/gpt-5.4",
				"  finalApplier:",
				"    model: openrouter/openai/gpt-5.4",
				"---",
				"$@",
			].join("\n"),
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("compare-nested-model");
		assert.ok(prompt);
		assert.equal(prompt.workers?.[0]?.model, "openrouter/openai/gpt-5.4");
		assert.equal(prompt.reviewers?.[0]?.model, "openrouter/openai/gpt-5.4");
		assert.equal(prompt.finalApplier?.model, "openrouter/openai/gpt-5.4");
		assert.equal(result.diagnostics.length, 0);
	});
});

test("loadPromptsWithModel rejects model declarations with internal whitespace", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad-space.md"), '---\nmodel: anthropic /claude-sonnet-4-20250514\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("bad-space"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid model spec/i);
	});
});

test("loadPromptsWithModel rejects provider-qualified model specs with empty path segments", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad-leading-slash.md"), '---\nmodel: /model\n---\nbody');
		writeFileSync(join(cwd, ".pi", "prompts", "bad-empty-model-id.md"), '---\nmodel: provider/\n---\nbody');
		writeFileSync(join(cwd, ".pi", "prompts", "bad-double-slash.md"), '---\nmodel: openrouter//gpt\n---\nbody');
		writeFileSync(join(cwd, ".pi", "prompts", "bad-trailing-slash.md"), '---\nmodel: openrouter/gpt/\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("bad-leading-slash"), false);
		assert.equal(result.prompts.has("bad-empty-model-id"), false);
		assert.equal(result.prompts.has("bad-double-slash"), false);
		assert.equal(result.prompts.has("bad-trailing-slash"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid model spec/i);
	});
});

test("loadPromptsWithModel avoids recursive symlink loops", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const promptsDir = join(cwd, ".pi", "prompts");
		mkdirSync(join(promptsDir, "nested"), { recursive: true });
		writeFileSync(join(promptsDir, "nested", "ok.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nbody');
		symlinkSync(promptsDir, join(promptsDir, "nested", "loop"));

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("ok")?.content, "body");
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /already visited prompt directory/i);
	});
});

test("loadPromptsWithModel follows legacy prompts symlinks outside the prompt root", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const promptsDir = join(cwd, ".pi", "prompts");
		const outsideDir = join(root, "outside-prompts");
		mkdirSync(promptsDir, { recursive: true });
		mkdirSync(outsideDir, { recursive: true });
		writeFileSync(join(root, "external-file.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nexternal file");
		writeFileSync(join(outsideDir, "external-dir.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nexternal dir");
		writeFileSync(join(outsideDir, "with-include.md"), '---\nmodel: claude-sonnet-4-20250514\n---\n<include file="sibling.md" />');
		writeFileSync(join(outsideDir, "sibling.md"), "external sibling");
		symlinkSync(join(root, "external-file.md"), join(promptsDir, "external-file.md"));
		symlinkSync(outsideDir, join(promptsDir, "external-dir"), "dir");

		const runtime = loadPromptsWithModel(cwd);
		assert.equal(runtime.prompts.get("external-file")?.content, "external file");
		assert.equal(runtime.prompts.get("external-dir")?.content, "external dir");
		assert.equal(runtime.prompts.get("with-include")?.content, "external sibling");
		assert.equal(runtime.diagnostics.some((diagnostic) => diagnostic.code === "symlink-outside-prompt-root"), false);

		const records = collectPromptSourceRecords(cwd, true);
		assert.equal(records.records.find((record) => record.promptName === "external-file")?.rawBody, "external file");
		assert.equal(records.records.find((record) => record.promptName === "external-dir")?.rawBody, "external dir");
		assert.equal(records.records.find((record) => record.promptName === "with-include")?.rawBody, '<include file="sibling.md" />');
		assert.equal(records.diagnostics.some((diagnostic) => diagnostic.code === "symlink-outside-prompt-root"), false);
	});
});

test("loadPromptsWithModel rejects symlinked prompt-library roots", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const outsideLibrary = join(root, "outside-library");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(outsideLibrary, { recursive: true });
		writeFileSync(join(outsideLibrary, "external.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nexternal command");
		symlinkSync(outsideLibrary, join(cwd, ".pi", "prompt-library"), "dir");

		const runtime = loadPromptsWithModel(cwd);
		assert.equal(runtime.prompts.has("external"), false);
		assert.equal(runtime.diagnostics.some((diagnostic) => diagnostic.code === "symlink-outside-prompt-root"), true);

		const records = collectPromptSourceRecords(cwd, true);
		assert.equal(records.records.some((record) => record.promptName === "external"), false);
		assert.equal(records.diagnostics.some((diagnostic) => diagnostic.code === "symlink-outside-prompt-root"), true);
	});
});

test("loadPromptsWithModel rejects visible symlinks to dot-prefixed prompt-library targets", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(join(projectLibrary, ".hidden-dir"), { recursive: true });
		writeFileSync(join(projectLibrary, ".hidden.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nhidden file command");
		writeFileSync(join(projectLibrary, ".hidden-dir", "nested.md"), "---\nmodel: claude-sonnet-4-20250514\n---\nhidden dir command");
		symlinkSync(join(projectLibrary, ".hidden.md"), join(projectLibrary, "visible-file.md"), "file");
		symlinkSync(join(projectLibrary, ".hidden-dir"), join(projectLibrary, "visible-dir"), "dir");

		const runtime = loadPromptsWithModel(cwd, true);
		assert.equal(runtime.prompts.has("visible-file"), false);
		assert.equal(runtime.prompts.has("nested"), false);
		assert.equal(runtime.diagnostics.filter((diagnostic) => diagnostic.code === "dot-prefixed-prompt-library-entry").length, 2);

		const records = collectPromptSourceRecords(cwd, true);
		assert.equal(records.records.some((record) => record.promptName === "visible-file"), false);
		assert.equal(records.records.some((record) => record.promptName === "nested"), false);
		assert.equal(records.diagnostics.filter((diagnostic) => diagnostic.code === "dot-prefixed-prompt-library-entry").length, 2);
	});
});

test("prompt-library includes reject dot-prefixed files and directories", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(join(projectLibrary, ".hidden-dir"), { recursive: true });
		writeFileSync(join(projectLibrary, "hidden-file.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: .hidden.md\n---\nbody");
		writeFileSync(join(projectLibrary, "hidden-dir.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: .hidden-dir/rules.md\n---\nbody");
		writeFileSync(join(projectLibrary, ".hidden.md"), "hidden file rules");
		writeFileSync(join(projectLibrary, ".hidden-dir", "rules.md"), "hidden dir rules");

		const result = loadPromptsWithModel(cwd, true);
		assert.equal(result.prompts.has("hidden-file"), false);
		assert.equal(result.prompts.has("hidden-dir"), false);
		assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.code === "include-dotfile-disallowed").length, 2);
	});
});

test("loadPromptsWithModel rejects non-object frontmatter roots", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad-frontmatter.md"), '---\n- model\n- claude-sonnet-4-20250514\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("bad-frontmatter"), false);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /frontmatter must be a key-value object/i);
	});
});

test("loadPromptsWithModel parses fresh frontmatter field", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), '---\nmodel: claude-sonnet-4-20250514\nfresh: true\n---\nbody');
		writeFileSync(join(cwd, ".pi", "prompts", "normal.md"), '---\nmodel: claude-sonnet-4-20250514\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("deslop")?.fresh, true);
		assert.equal(result.prompts.get("normal")?.fresh, undefined);
	});
});

test("loadPromptsWithModel parses boomerang frontmatter field", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), '---\ndescription: "review"\nboomerang: true\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("double-check");
		assert.equal(prompt?.boomerang, true);
		assert.equal(buildPromptCommandDescription(prompt!), "review [current boomerang] (project)");
	});
});

test("loadPromptsWithModel rejects boomerang on chain templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "chain-boomerang.md"), '---\nchain: "analyze -> fix"\nboomerang: true\n---\nignored');

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-boomerang");
		assert.ok(prompt);
		assert.equal(prompt.boomerang, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /chain" and "boomerang" cannot be combined/i);
	});
});

test("loadPromptsWithModel parses rotate frontmatter field on non-chain templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "rotate.md"), "---\nmodel: claude-sonnet-4-20250514\nrotate: true\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("rotate")?.rotate, true);
	});
});

test("loadPromptsWithModel ignores rotate on chain templates without diagnostics", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "chain-rotate.md"), '---\nchain: "analyze -> fix"\nrotate: true\n---\nignored');

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-rotate");
		assert.ok(prompt);
		assert.equal(prompt.rotate, undefined);
		assert.doesNotMatch(result.diagnostics.map((item) => item.message).join("\n"), /invalid rotate/i);
	});
});

test("loadPromptsWithModel stores comma-separated thinking levels when rotate model count matches", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-thinking.md"),
			"---\nmodel: claude-sonnet-4-20250514, claude-opus-4-5, claude-haiku-4-5\nrotate: true\nthinking: high, xhigh, off\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("rotate-thinking");
		assert.ok(prompt);
		assert.deepEqual(prompt.thinkingLevels, ["high", "xhigh", "off"]);
		assert.equal(prompt.thinking, undefined);
	});
});

test("loadPromptsWithModel diagnoses mismatched comma-separated thinking levels for rotate prompts", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-thinking-mismatch.md"),
			"---\nmodel: claude-sonnet-4-20250514, claude-opus-4-5\nrotate: true\nthinking: high, xhigh, off\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("rotate-thinking-mismatch");
		assert.ok(prompt);
		assert.equal(prompt.thinkingLevels, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /expected 2 entries to match frontmatter field "model"/i);
	});
});

test("loadPromptsWithModel diagnoses invalid comma-separated thinking levels for rotate prompts", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-thinking-invalid.md"),
			"---\nmodel: claude-sonnet-4-20250514, claude-opus-4-5\nrotate: true\nthinking: high, turbo\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("rotate-thinking-invalid");
		assert.ok(prompt);
		assert.equal(prompt.thinkingLevels, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid thinking level/i);
	});
});

test("loadPromptsWithModel parses numeric loop frontmatter field", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), "---\nmodel: claude-sonnet-4-20250514\nloop: 5\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("deslop")?.loop, 5);
	});
});

test("loadPromptsWithModel parses string loop frontmatter field", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), '---\nmodel: claude-sonnet-4-20250514\nloop: "7"\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("deslop")?.loop, 7);
	});
});

test("loadPromptsWithModel diagnoses and ignores invalid loop frontmatter values", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "bad-loop.md"), "---\nmodel: claude-sonnet-4-20250514\nloop: 0\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("bad-loop")?.loop, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /invalid loop value/i);
	});
});

test("loadPromptsWithModel parses loop: unlimited as null", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "unlimited.md"), "---\nmodel: claude-sonnet-4-20250514\nloop: unlimited\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("unlimited")?.loop, null);
	});
});

test("loadPromptsWithModel parses loop: true as null (unlimited)", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "unlimited.md"), "---\nmodel: claude-sonnet-4-20250514\nloop: true\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("unlimited")?.loop, null);
	});
});

test("buildPromptCommandDescription shows loop:unlimited for unlimited loop", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "unlimited.md"), '---\nmodel: claude-sonnet-4-20250514\nloop: unlimited\ndescription: "test"\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("unlimited");
		assert.ok(prompt);
		assert.match(buildPromptCommandDescription(prompt), /loop:unlimited/);
	});
});

test("loadPromptsWithModel normalizes converge frontmatter values", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "converge-true.md"), "---\nmodel: claude-sonnet-4-20250514\nconverge: true\n---\nbody");
		writeFileSync(join(cwd, ".pi", "prompts", "converge-false.md"), "---\nmodel: claude-sonnet-4-20250514\nconverge: false\n---\nbody");
		writeFileSync(join(cwd, ".pi", "prompts", "converge-invalid.md"), "---\nmodel: claude-sonnet-4-20250514\nconverge: maybe\n---\nbody");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("converge-true")?.converge, undefined);
		assert.equal(result.prompts.get("converge-false")?.converge, false);
		assert.equal(result.prompts.get("converge-invalid")?.converge, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /default converge=true/i);
	});
});

test("loadPromptsWithModel loads chain templates without model and description shows chain metadata", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "review-and-clean.md"),
			'---\nchain: "double-check --loop 2 -> deslop --loop 2"\ndescription: "Review then clean up slop"\n---\nignored',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("review-and-clean");
		assert.ok(prompt);
		assert.equal(prompt.models.length, 0);
		assert.equal(prompt.chain, "double-check --loop 2 -> deslop --loop 2");
		assert.equal(buildPromptCommandDescription(prompt), "Review then clean up slop [chain: double-check --loop 2 -> deslop --loop 2] (project)");
	});
});

test("loadPromptsWithModel ignores model/thinking/skill fields on chain templates without diagnostics", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "chain-ignore.md"),
			'---\nchain: "analyze -> fix"\nmodel: 123\nthinking: turbo\nskill: 42\n---\nignored',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-ignore");
		assert.ok(prompt);
		assert.equal(prompt.chain, "analyze -> fix");
		assert.equal(prompt.models.length, 0);
		assert.equal(prompt.thinking, undefined);
		assert.equal(prompt.skill, undefined);

		const diagnosticText = result.diagnostics.map((item) => item.message).join("\n");
		assert.doesNotMatch(diagnosticText, /invalid model|empty model|invalid thinking|invalid skill/i);
	});
});

test("loadPromptsWithModel stores loop/fresh/converge frontmatter on chain templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "chain-flags.md"),
			'---\nchain: "analyze -> fix"\nloop: 3\nfresh: true\nconverge: false\n---\nignored',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-flags");
		assert.ok(prompt);
		assert.equal(prompt.chain, "analyze -> fix");
		assert.equal(prompt.loop, 3);
		assert.equal(prompt.fresh, true);
		assert.equal(prompt.converge, false);
	});
});

test("loadPromptsWithModel stores chainContext summary on chain templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "chain-context.md"),
			'---\nchain: "analyze -> fix"\nchainContext: summary\n---\nignored',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-context");
		assert.ok(prompt);
		assert.equal(prompt.chainContext, "summary");
	});
});

test("loadPromptsWithModel diagnoses invalid chainContext on chain templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "chain-context-invalid.md"),
			'---\nchain: "analyze -> fix"\nchainContext: full\n---\nignored',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-context-invalid");
		assert.ok(prompt);
		assert.equal(prompt.chainContext, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /frontmatter field "chainContext" must be "summary"/i);
	});
});

test("buildPromptCommandDescription includes chain summary context label", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "chain-context-description.md"),
			'---\nchain: "analyze -> fix"\nchainContext: summary\n---\nignored',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-context-description");
		assert.ok(prompt);
		assert.equal(buildPromptCommandDescription(prompt), "[chain: analyze -> fix summary] (project)");
	});
});

test("loadPromptsWithModel diagnoses invalid chain frontmatter values", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "chain-number.md"), "---\nmodel: claude-sonnet-4-20250514\nchain: 123\n---\nbody");
		writeFileSync(join(cwd, ".pi", "prompts", "chain-empty.md"), '---\nmodel: claude-sonnet-4-20250514\nchain: "   "\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		const diagnosticText = result.diagnostics.map((item) => item.message).join("\n");
		assert.match(diagnosticText, /frontmatter field "chain" must be a string/i);
		assert.match(diagnosticText, /frontmatter field "chain" must be a non-empty string/i);
	});
});

test("loadPromptsWithModel rejects invalid parallel() chain declarations in frontmatter", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "parallel-empty.md"), '---\nchain: "parallel() -> review"\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "parallel-nested.md"), '---\nchain: "parallel(scan, parallel(review))"\n---\nignored');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("parallel-empty"), false);
		assert.equal(result.prompts.has("parallel-nested"), false);
		const diagnostics = result.diagnostics.map((item) => item.message).join("\n");
		assert.match(diagnostics, /invalid chain declaration segment/i);
	});
});

test("loadPromptsWithModel accepts single-item parallel() declarations", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "parallel-single.md"), '---\nchain: "parallel(scan-fe)"\n---\nignored');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("parallel-single")?.chain, "parallel(scan-fe)");
	});
});

test("buildPromptCommandDescription includes loop metadata", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "deslop.md"),
			'---\nmodel: claude-sonnet-4-20250514\ndescription: "Deslop"\nskill: tmux\nloop: 5\n---\nbody',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("deslop");
		assert.ok(prompt);
		assert.equal(buildPromptCommandDescription(prompt), "Deslop [claude-sonnet-4-20250514 +tmux loop:5] (project)");
	});
});

test("buildPromptCommandDescription includes rotate and comma-separated thinking levels", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-description.md"),
			"---\nmodel: claude-sonnet-4-20250514, claude-opus-4-5\nrotate: true\nthinking: high, xhigh\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("rotate-description");
		assert.ok(prompt);
		assert.equal(buildPromptCommandDescription(prompt), "[claude-sonnet-4-20250514|claude-opus-4-5 rotate high,xhigh] (project)");
	});
});

test("loadPromptsWithModel parses subagent and inheritContext frontmatter", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "delegated.md"),
			'---\nmodel: claude-sonnet-4-20250514\nsubagent: worker\ninheritContext: true\n---\nbody',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("delegated");
		assert.ok(prompt);
		assert.equal(prompt.subagent, "worker");
		assert.equal(prompt.inheritContext, true);
		assert.match(buildPromptCommandDescription(prompt), /subagent:worker/);
		assert.match(buildPromptCommandDescription(prompt), /fork/);
	});
});

test("loadPromptsWithModel rejects invalid inheritContext combinations", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "chain-delegated.md"), '---\nchain: worker\nsubagent: true\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "inherit-only.md"), '---\nmodel: claude-sonnet-4-20250514\ninheritContext: true\n---\nbody');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.get("chain-delegated")?.subagent, undefined);
		assert.equal(result.prompts.get("inherit-only")?.inheritContext, undefined);
		const diagnostics = result.diagnostics.map((item) => item.message).join("\n");
		assert.match(diagnostics, /cannot be combined/i);
		assert.match(diagnostics, /requires "subagent"/i);
	});
});

test("loadPromptsWithModel stores cwd for delegated prompts", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "delegated-cwd.md"),
			"---\nmodel: claude-sonnet-4-20250514\nsubagent: true\ncwd: /tmp/nfd\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("delegated-cwd");
		assert.ok(prompt);
		assert.equal(prompt.cwd, "/tmp/nfd");
	});
});

test("loadPromptsWithModel ignores cwd without subagent or chain", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "cwd-no-subagent.md"),
			"---\nmodel: claude-sonnet-4-20250514\ncwd: /tmp/nfd\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("cwd-no-subagent");
		assert.ok(prompt);
		assert.equal(prompt.cwd, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /frontmatter field "cwd" requires "subagent"/i);
	});
});

test("loadPromptsWithModel rejects non-absolute cwd values", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "cwd-relative.md"),
			"---\nmodel: claude-sonnet-4-20250514\nsubagent: true\ncwd: relative/path\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("cwd-relative");
		assert.ok(prompt);
		assert.equal(prompt.cwd, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /must be an absolute path/i);
	});
});

test("loadPromptsWithModel rejects non-string cwd values", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "cwd-number.md"),
			"---\nmodel: claude-sonnet-4-20250514\nsubagent: true\ncwd: 123\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("cwd-number");
		assert.ok(prompt);
		assert.equal(prompt.cwd, undefined);
		assert.match(result.diagnostics.map((item) => item.message).join("\n"), /expected a string/i);
	});
});

test("loadPromptsWithModel expands tilde-prefixed cwd values", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "cwd-tilde.md"),
			"---\nmodel: claude-sonnet-4-20250514\nsubagent: true\ncwd: ~/project\n---\nbody",
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("cwd-tilde");
		assert.ok(prompt);
		assert.equal(prompt.cwd, join(root, "project"));
	});
});

test("loadPromptsWithModel stores cwd on chain templates", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "chain-cwd.md"),
			'---\nchain: "analyze -> fix"\ncwd: /tmp/nfd\n---\nignored',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("chain-cwd");
		assert.ok(prompt);
		assert.equal(prompt.cwd, "/tmp/nfd");
		assert.equal(buildPromptCommandDescription(prompt), "[chain: analyze -> fix cwd:/tmp/nfd] (project)");
	});
});

test("resolveSkillPath searches project .pi, ancestor .agents, then global skills", () => {
	withTempHome((root) => {
		const repoRoot = join(root, "repo");
		const cwd = join(repoRoot, "apps", "web");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		mkdirSync(join(repoRoot, ".agents", "skills", "from-agents"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "skills", "from-global"), { recursive: true });
		writeFileSync(join(repoRoot, ".agents", "skills", "from-agents", "SKILL.md"), "agents skill");
		writeFileSync(join(cwd, ".pi", "skills", "from-project.md"), "project skill");
		writeFileSync(join(root, ".pi", "agent", "skills", "from-global", "SKILL.md"), "global skill");

		assert.equal(resolveSkillPath("from-project", cwd), join(cwd, ".pi", "skills", "from-project.md"));
		assert.equal(resolveSkillPath("from-agents", cwd), join(repoRoot, ".agents", "skills", "from-agents", "SKILL.md"));
		assert.equal(resolveSkillPath("from-global", cwd), join(root, ".pi", "agent", "skills", "from-global", "SKILL.md"));
	});
});

test("resolveSkillPath falls back to ~/.agents/skills", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(join(root, ".agents", "skills"), { recursive: true });
		writeFileSync(join(root, ".agents", "skills", "from-legacy.md"), "legacy skill");

		assert.equal(resolveSkillPath("from-legacy", cwd), join(root, ".agents", "skills", "from-legacy.md"));
	});
});

test("loadPromptsWithModel validates parallel/worktree frontmatter combinations", () => {
	withTempHome((root) => {
		const cases = [
			{
				name: "parallel-review",
				content: '---\nmodel: claude-sonnet-4-20250514\nsubagent: simplifier\ninheritContext: true\nparallel: 3\n---\nbody',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("parallel-review");
					assert.ok(prompt);
					assert.equal(prompt.parallel, 3);
					assert.equal(prompt.subagent, "simplifier");
					assert.equal(prompt.inheritContext, true);
					assert.equal(result.diagnostics.filter((d) => d.message.includes("parallel")).length, 0);
				},
			},
			{
				name: "bad-parallel",
				content: '---\nmodel: claude-sonnet-4-20250514\nsubagent: simplifier\nparallel: 1\n---\nbody',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("bad-parallel");
					assert.ok(prompt);
					assert.equal(prompt.parallel, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("parallel") && d.message.includes("greater than or equal to 2")));
				},
			},
			{
				name: "plain-parallel",
				content: '---\nmodel: claude-sonnet-4-20250514\nparallel: 3\n---\nbody',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("plain-parallel");
					assert.ok(prompt);
					assert.equal(prompt.parallel, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("parallel") && d.message.includes('requires "subagent"')));
				},
			},
			{
				name: "chain-parallel-field",
				content: '---\nchain: "review -> fix"\nparallel: 3\n---\nignored',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("chain-parallel-field");
					assert.ok(prompt);
					assert.equal(prompt.parallel, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("parallel") && d.message.includes('cannot be combined with "chain"')));
				},
			},
			{
				name: "parallel-worktree",
				content: '---\nmodel: claude-sonnet-4-20250514\nsubagent: simplifier\nparallel: 3\nworktree: true\n---\nbody',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("parallel-worktree");
					assert.ok(prompt);
					assert.equal(prompt.parallel, 3);
					assert.equal(prompt.worktree, true);
					assert.equal(result.diagnostics.filter((d) => d.message.includes("worktree")).length, 0);
				},
			},
			{
				name: "parallel-desc",
				content: '---\ndescription: "Parallel simplify"\nmodel: claude-sonnet-4-20250514\nsubagent: simplifier\nparallel: 3\nworktree: true\n---\nbody',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("parallel-desc");
					assert.ok(prompt);
					const desc = buildPromptCommandDescription(prompt);
					assert.match(desc, /parallel:3/);
					assert.match(desc, /subagent:simplifier/);
					assert.match(desc, /worktree/);
				},
			},
			{
				name: "wt-pipeline",
				content: '---\nchain: "parallel(scan-fe, scan-be) -> review"\nworktree: true\n---\nignored',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("wt-pipeline");
					assert.ok(prompt);
					assert.equal(prompt.worktree, true);
					assert.equal(result.diagnostics.filter((d) => d.message.includes("worktree")).length, 0);
				},
			},
			{
				name: "plain",
				content: '---\nmodel: claude-sonnet-4-20250514\nworktree: true\n---\nbody',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("plain");
					assert.ok(prompt);
					assert.equal(prompt.worktree, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("worktree") && d.message.includes("requires")));
				},
			},
			{
				name: "seq-chain",
				content: '---\nchain: "analyze -> fix"\nworktree: true\n---\nignored',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("seq-chain");
					assert.ok(prompt);
					assert.equal(prompt.worktree, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("worktree") && d.message.includes("parallel")));
				},
			},
			{
				name: "bad-wt",
				content: '---\nchain: "parallel(a, b) -> c"\nworktree: 42\n---\nignored',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("bad-wt");
					assert.ok(prompt);
					assert.equal(prompt.worktree, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("worktree") && d.message.includes("must be true or false")));
				},
			},
			{
				name: "wt-only",
				content: '---\nchain: "parallel(a, b)"\nworktree: true\n---\nignored',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					assert.ok(result.prompts.has("wt-only"));
				},
			},
			{
				name: "wt-desc",
				content: '---\nchain: "parallel(scan-fe, scan-be) -> review"\nworktree: true\ndescription: "Parallel scan"\n---\nignored',
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("wt-desc");
					assert.ok(prompt);
					const desc = buildPromptCommandDescription(prompt);
					assert.match(desc, /worktree/);
					assert.match(desc, /\[chain:.*worktree\]/);
				},
			},
		] as const;

		for (const testCase of cases) {
			const cwd = join(root, testCase.name);
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", `${testCase.name}.md`), testCase.content);
			testCase.check(loadPromptsWithModel(cwd));
		}
	});
});

test("loadPromptsWithModel parses the shipped best-of-n example", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "best-of-n.md"), readFileSync(new URL("../examples/best-of-n.md", import.meta.url), "utf8"));

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("best-of-n");
		assert.ok(prompt);
		assert.equal(prompt.description, "Best-of-N code task with parallel workers using different models in separate worktrees, parallel reviewers, and a final apply step that picks or synthesizes the final patch.");
		assert.equal(prompt.worktree, true);
		assert.equal(prompt.workers?.length, 2);
		assert.deepEqual(
			prompt.workers?.map((slot) => ({ agent: slot.agent, model: slot.model, count: slot.count, taskSuffix: slot.taskSuffix })),
			[
				{ agent: "delegate", model: "openai-codex/gpt-5.3-codex-spark:low", count: 3, taskSuffix: undefined },
				{ agent: "delegate", model: "openai-codex/gpt-5.4-mini:high", count: 2, taskSuffix: undefined },
			],
		);
		assert.equal(prompt.reviewers?.length, 2);
		assert.deepEqual(
			prompt.reviewers?.map((slot) => ({ agent: slot.agent, model: slot.model, count: slot.count, taskSuffix: slot.taskSuffix })),
			[
				{ agent: "reviewer", model: "openai-codex/gpt-5.3-codex-spark:medium", count: 2, taskSuffix: undefined },
				{ agent: "reviewer", model: "openai-codex/gpt-5.4-mini:high", count: undefined, taskSuffix: "Focus extra attention on regression risk and missing edge cases." },
			],
		);
		assert.deepEqual(prompt.finalApplier, {
			agent: "delegate",
			model: "openai-codex/gpt-5.4-mini:xhigh",
			taskSuffix: "Apply the final patch directly on the current branch, run best-effort relevant verification, and report changed files plus verification run.",
		});
		assert.equal(prompt.content, "$@");
		assert.match(buildPromptCommandDescription(prompt), /workers:5/);
		assert.match(buildPromptCommandDescription(prompt), /reviewers:3/);
		assert.match(buildPromptCommandDescription(prompt), /final-applier/);
		assert.equal(result.diagnostics.length, 0);
	});
});

test("loadPromptsWithModel accepts bestOfN preset-only commands and preset catalog precedence", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, ".pi", "agent"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(root, ".pi", "agent", "best-of-n-presets.json"),
			JSON.stringify({
				presets: {
					quick: {
						defaultModel: "openai/gpt-5.4-mini",
						workers: [{ agent: "delegate", count: 2 }],
						reviewers: [{ subagent: true }],
					},
				},
			}),
		);
		writeFileSync(
			join(cwd, ".pi", "best-of-n-presets.json"),
			JSON.stringify({
				presets: {
					quick: {
						description: "project override",
						defaultModel: "anthropic/claude-sonnet-4-20250514",
						workers: [{ agent: "delegate" }],
					},
					deep: {
						workers: [{ agent: "delegate", model: "openai/gpt-5.4", count: 3 }],
						reviewers: [{ agent: "reviewer", count: 2 }],
						maxModelCalls: 6,
					},
				},
			}),
		);
		writeFileSync(join(cwd, ".pi", "prompts", "compare.md"), "---\nbestOfN:\n  preset: quick\n---\n$@");

		const promptResult = loadPromptsWithModel(cwd);
		const prompt = promptResult.prompts.get("compare");
		assert.ok(prompt);
		assert.equal(prompt.preset, "quick");
		assert.equal(prompt.workers, undefined);
		assert.equal(prompt.reviewers, undefined);
		assert.equal(promptResult.diagnostics.length, 0);

		const catalog = loadBestOfNPresetCatalog(cwd);
		assert.equal(catalog.diagnostics.length, 0);
		assert.equal(catalog.presets.get("quick")?.source, "project");
		assert.equal(catalog.presets.get("quick")?.description, "project override");
		assert.equal(catalog.presets.get("quick")?.workers?.[0]?.model, undefined);
		assert.equal(catalog.presets.get("deep")?.workers?.[0]?.count, 3);
		assert.equal(catalog.presets.get("deep")?.reviewers?.[0]?.count, 2);
		assert.equal(catalog.presets.get("deep")?.maxModelCalls, 6);
	});
});

test("loadBestOfNPresetCatalog rejects invalid preset files and presets", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, ".pi", "agent"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(root, ".pi", "agent", "best-of-n-presets.json"),
			JSON.stringify({ presets: { badEmpty: { workers: [{ agent: "delegate" }] }, badPartial: { workers: [{ agent: "delegate" }] } } }),
		);
		writeFileSync(
			join(cwd, ".pi", "best-of-n-presets.json"),
			JSON.stringify({
				presets: {
					badEmpty: { workers: [] },
					badPartial: { workers: [], reviewers: [{ agent: "reviewer" }] },
					badPolicy: { workers: [{ agent: "delegate", taskSuffix: "do more", cwd: "/tmp/repo" }] },
					badTopLevel: { workers: [{ agent: "delegate" }], commit: "auto" },
					badModel: { workers: [{ model: "bad model" }] },
					badCap: { workers: [{ agent: "delegate" }], maxModelCalls: 0 },
					good: { workers: [{ subagent: true, count: "2" }] },
				},
			}),
		);

		const catalog = loadBestOfNPresetCatalog(cwd);
		assert.deepEqual([...catalog.presets.keys()], ["good"]);
		assert.deepEqual([...catalog.invalidPresetNames].sort(), ["badCap", "badEmpty", "badModel", "badPartial", "badPolicy", "badTopLevel"]);
		assert.equal(catalog.presets.get("good")?.workers?.[0]?.agent, "delegate");
		assert.equal(catalog.presets.get("good")?.workers?.[0]?.count, 2);
		assert.equal(catalog.diagnostics.filter((diagnostic) => diagnostic.code === "invalid-best-of-n-preset").length, 6);
		assert.match(catalog.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /unsupported field\(s\): taskSuffix, cwd/);
		assert.match(catalog.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /unsupported field\(s\): commit/);
	});
});

test("loadBestOfNPresetCatalog fails closed when project preset file is invalid", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		mkdirSync(join(root, ".pi", "agent"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "agent", "best-of-n-presets.json"), JSON.stringify({ presets: { quick: { workers: [{ agent: "delegate" }] } } }));
		writeFileSync(join(cwd, ".pi", "best-of-n-presets.json"), "{ not json");

		const catalog = loadBestOfNPresetCatalog(cwd);

		assert.equal(catalog.projectFileInvalid, true);
		assert.equal(catalog.presets.has("quick"), false);
		assert.equal(catalog.diagnostics.some((diagnostic) => diagnostic.code === "invalid-best-of-n-presets-file"), true);
	});
});

test("loadPromptsWithModel validates bestOfN compare lineups and cutover diagnostics", () => {
	withTempHome((root) => {
		const cases = [
			{
				name: "compare",
				content: [
					"---",
					"description: Compare",
					"bestOfN:",
					"  workers:",
					"    - model: openai/gpt-5.4",
					"      taskSuffix: Save findings to notes/a.md",
					"      count: 3",
					"    - subagent: delegate",
					"  reviewers:",
					"    - taskSuffix: Prefer findings files over prose summaries.",
					"      cwd: /tmp/repo",
					"      count: 2",
					"  finalApplier:",
					"    model: openai-codex/gpt-5.4:low",
					"    taskSuffix: Prefer merge plans over narrow wins when the diffs justify it.",
					"  commit: ask",
					"  worktree: true",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("compare");
					assert.ok(prompt);
					assert.equal(prompt.workers?.length, 2);
					assert.equal(prompt.workers?.[0]?.agent, "delegate");
					assert.equal(prompt.workers?.[0]?.model, "openai/gpt-5.4");
					assert.equal(prompt.workers?.[0]?.taskSuffix, "Save findings to notes/a.md");
					assert.equal(prompt.workers?.[0]?.count, 3);
					assert.equal(prompt.workers?.[1]?.agent, "delegate");
					assert.equal(prompt.reviewers?.length, 1);
					assert.equal(prompt.reviewers?.[0]?.agent, "reviewer");
					assert.equal(prompt.reviewers?.[0]?.taskSuffix, "Prefer findings files over prose summaries.");
					assert.equal(prompt.reviewers?.[0]?.cwd, "/tmp/repo");
					assert.equal(prompt.reviewers?.[0]?.count, 2);
					assert.equal(prompt.finalApplier?.agent, "delegate");
					assert.equal(prompt.finalApplier?.model, "openai-codex/gpt-5.4:low");
					assert.equal(prompt.finalApplier?.taskSuffix, "Prefer merge plans over narrow wins when the diffs justify it.");
					assert.equal(prompt.commit, "ask");
					assert.equal(prompt.worktree, true);
					assert.match(buildPromptCommandDescription(prompt), /workers:4/);
					assert.match(buildPromptCommandDescription(prompt), /reviewers:2/);
					assert.match(buildPromptCommandDescription(prompt), /final-applier/);
					assert.match(buildPromptCommandDescription(prompt), /commit:ask/);
				},
			},
			{
				name: "compare-with-skills",
				content: [
					"---",
					"skills: [tmux]",
					"bestOfN:",
					"  workers:",
					"    - model: openai/gpt-5.4",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					assert.equal(result.prompts.has("compare-with-skills"), false);
					assert.ok(result.diagnostics.some((d) => d.code === "invalid-compare-skills" && d.message.includes('cannot be combined with "skill" or "skills"')));
				},
			},
			{
				name: "legacy-workers",
				content: [
					"---",
					"model: claude-sonnet-4-20250514",
					"workers:",
					"  - agent: delegate",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					assert.equal(result.prompts.has("legacy-workers"), false);
					assert.ok(result.diagnostics.some((d) => d.message.includes("bestOfN.workers")));
					assert.ok(result.diagnostics.some((d) => d.message.includes('compare template authoring moved under "bestOfN:"')));
				},
			},
			{
				name: "legacy-reviewers",
				content: [
					"---",
					"model: claude-sonnet-4-20250514",
					"reviewers:",
					"  - agent: reviewer",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					assert.equal(result.prompts.has("legacy-reviewers"), false);
					assert.ok(result.diagnostics.some((d) => d.message.includes("bestOfN.reviewers")));
					assert.ok(result.diagnostics.some((d) => d.message.includes('compare template authoring moved under "bestOfN:"')));
				},
			},
			{
				name: "legacy-final-applier",
				content: [
					"---",
					"model: claude-sonnet-4-20250514",
					"finalApplier:",
					"  agent: reviewer",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					assert.equal(result.prompts.has("legacy-final-applier"), false);
					assert.ok(result.diagnostics.some((d) => d.message.includes("bestOfN.finalApplier")));
					assert.ok(result.diagnostics.some((d) => d.message.includes('compare template authoring moved under "bestOfN:"')));
				},
			},
			{
				name: "mixed-top-level-and-bestofn",
				content: [
					"---",
					"workers:",
					"  - agent: reviewer",
					"bestOfN:",
					"  workers:",
					"    - model: openai/gpt-5.4",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("mixed-top-level-and-bestofn");
					assert.ok(prompt);
					assert.equal(prompt.workers?.length, 1);
					assert.equal(prompt.workers?.[0]?.agent, "delegate");
					assert.equal(prompt.workers?.[0]?.model, "openai/gpt-5.4");
					assert.ok(result.diagnostics.some((d) => d.message.includes("bestOfN.workers")));
				},
			},
			{
				name: "top-level-worktree-with-bestofn",
				content: [
					"---",
					"worktree: false",
					"bestOfN:",
					"  workers:",
					"    - model: openai/gpt-5.4",
					"  worktree: true",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("top-level-worktree-with-bestofn");
					assert.ok(prompt);
					assert.equal(prompt.worktree, true);
					assert.ok(result.diagnostics.some((d) => d.message.includes("bestOfN.worktree")));
				},
			},
			{
				name: "bad-final-cwd",
				content: [
					"---",
					"bestOfN:",
					"  workers:",
					"    - model: openai/gpt-5.4",
					"  finalApplier:",
					"    cwd: /tmp/other-repo",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("bad-final-cwd");
					assert.ok(prompt);
					assert.equal(prompt.finalApplier, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("finalApplier") && d.message.includes("cwd") && d.message.includes("not supported")));
				},
			},
			{
				name: "bad-final-count",
				content: [
					"---",
					"bestOfN:",
					"  workers:",
					"    - model: openai/gpt-5.4",
					"  finalApplier:",
					"    count: 2",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("bad-final-count");
					assert.ok(prompt);
					assert.equal(prompt.finalApplier, undefined);
					assert.ok(result.diagnostics.some((d) => d.message.includes("finalApplier") && d.message.includes("count") && d.message.includes("not supported")));
				},
			},
			{
				name: "bad-commit-without-final-applier",
				content: [
					"---",
					"bestOfN:",
					"  workers:",
					"    - model: openai/gpt-5.4",
					"  commit: ask",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("bad-commit-without-final-applier");
					assert.ok(prompt);
					assert.equal(prompt.commit, undefined);
					assert.ok(result.diagnostics.some((d) => d.code === "invalid-best-of-n-commit" && d.message.includes("requires bestOfN.finalApplier")));
				},
			},
			{
				name: "bad-commit-value",
				content: [
					"---",
					"bestOfN:",
					"  workers:",
					"    - model: openai/gpt-5.4",
					"  finalApplier:",
					"    model: openai/gpt-5.4",
					"  commit: auto",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					const prompt = result.prompts.get("bad-commit-value");
					assert.ok(prompt);
					assert.equal(prompt.commit, undefined);
					assert.ok(result.diagnostics.some((d) => d.code === "invalid-best-of-n-commit" && d.message.includes('expected "ask"')));
				},
			},
			{
				name: "bad-bestofn-root",
				content: [
					"---",
					"model: claude-sonnet-4-20250514",
					"bestOfN: true",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					assert.equal(result.prompts.has("bad-bestofn-root"), false);
					assert.ok(result.diagnostics.some((d) => d.message.includes('"bestOfN" must be an object')));
					assert.ok(result.diagnostics.some((d) => d.message.includes('"bestOfN" did not produce a valid compare configuration')));
				},
			},
			{
				name: "compare-subagent",
				content: [
					"---",
					"model: claude-sonnet-4-20250514",
					"subagent: true",
					"bestOfN:",
					"  workers:",
					"    - model: openai/gpt-5.4",
					"  finalApplier:",
					"    model: openai/gpt-5.4:low",
					"---",
					"$@",
				].join("\n"),
				check(result: ReturnType<typeof loadPromptsWithModel>) {
					assert.equal(result.prompts.has("compare-subagent"), false);
					assert.ok(result.diagnostics.some((d) => d.message.includes("finalApplier") && d.message.includes("subagent")));
					assert.ok(result.diagnostics.some((d) => d.message.includes('"bestOfN" did not produce a valid compare configuration')));
				},
			},
		] as const;

		for (const testCase of cases) {
			const cwd = join(root, testCase.name);
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", `${testCase.name}.md`), testCase.content);
			testCase.check(loadPromptsWithModel(cwd));
		}
	});
});

test("reserved built-in command mirror is explicit", () => {
	assert.deepEqual([...RESERVED_COMMAND_NAMES].sort(), [
		"chain-prompts",
		"changelog",
		"compact",
		"copy",
		"dry-run-prompt",
		"export",
		"fork",
		"hotkeys",
		"login",
		"logout",
		"model",
		"name",
		"new",
		"print-prompt",
		"prompt-tool",
		"quit",
		"reload",
		"resume",
		"scoped-models",
		"session",
		"settings",
		"share",
		"tree",
		"validate-prompts",
	].sort());
});

test("prompt-library includes render plain fragments and preserve prompt-library graph root kind", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(join(projectLibrary, "partials"), { recursive: true });
		writeFileSync(join(projectLibrary, "review.md"), "---\nmodel: claude-sonnet-4-20250514\nincludes:\n  - partials/rules.md\n---\nReview\n<includes />");
		writeFileSync(join(projectLibrary, "partials", "rules.md"), "Plain library rules");

		const result = loadPromptsWithModel(cwd, true);
		const prompt = result.prompts.get("review");

		assert.ok(prompt);
		assert.equal(prompt.content, "Review\nPlain library rules");
		assert.equal(prompt.rootKind, "prompt-library");
		assert.equal(prompt.includeGraph?.root.rootKind, "prompt-library");
		assert.equal(result.prompts.has("rules"), false);
	});
});

test("project prompt includes plain prompt-library fragment absent from runtime catalog", () => {
	withTempHome((root) => {
		const cwd = join(root, "project");
		const prompts = join(cwd, ".pi", "prompts");
		const projectLibrary = join(cwd, ".pi", "prompt-library");
		mkdirSync(prompts, { recursive: true });
		mkdirSync(join(projectLibrary, "partials"), { recursive: true });
		writeFileSync(join(prompts, "review.md"), "---\nmodel: claude-sonnet-4-20250514\nincludes:\n  - partials/rules.md\n---\nReview\n<includes />");
		writeFileSync(join(projectLibrary, "partials", "rules.md"), "Plain library rules");

		const result = loadPromptsWithModel(cwd, true);

		assert.equal(result.prompts.get("review")?.content, "Review\nPlain library rules");
		assert.equal(result.prompts.has("rules"), false);
	});
});
