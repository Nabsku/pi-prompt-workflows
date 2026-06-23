import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPromptDryRun, parseDryRunCommand, type PromptDryRunResult } from "../prompt-dry-run.js";
import { loadPromptsWithModel, type PromptWithModel } from "../prompt-loader.js";
import type { RuntimeSkillCommand } from "../prompt-skills.js";

const sonnet = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
const gpt = { provider: "openai", id: "gpt-5.2" };

const registry = {
	find(provider: string, modelId: string) {
		return [sonnet, haiku, gpt].find((model) => model.provider === provider && model.id === modelId);
	},
	getAll() {
		return [sonnet, haiku, gpt];
	},
	getAvailable() {
		return [sonnet, haiku, gpt];
	},
	async getApiKeyAndHeaders() {
		return { ok: true, apiKey: "token" };
	},
	isUsingOAuth() {
		return false;
	},
};

function prompt(overrides: Partial<PromptWithModel> = {}): PromptWithModel {
	return {
		name: "demo",
		description: "",
		content: "Body $@",
		models: [sonnet.id],
		restore: false,
		source: "project",
		rootKind: "prompts",
		filePath: "/tmp/demo.md",
		...overrides,
	};
}

function options(root: string, overrides: Partial<Parameters<typeof createPromptDryRun>[1]> = {}): Parameters<typeof createPromptDryRun>[1] {
	return {
		cwd: root,
		modelRegistry: registry as never,
		commands: [],
		...overrides,
	};
}

async function withTempHome<T>(run: (root: string) => Promise<T> | T): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-dry-run-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		return await run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

function assertOk(result: PromptDryRunResult) {
	assert.equal(result.status, "ok", result.status === "error" ? result.error : undefined);
	return result.status === "ok" ? result : assert.fail("expected ok dry-run");
}

function assertError(result: PromptDryRunResult) {
	assert.equal(result.status, "error");
	return result.status === "error" ? result : assert.fail("expected error dry-run");
}

function writeProjectSkill(cwd: string, name: string, content: string): string {
	const skillDir = join(cwd, ".pi", "skills", name);
	mkdirSync(skillDir, { recursive: true });
	const skillPath = join(skillDir, "SKILL.md");
	writeFileSync(skillPath, content);
	return skillPath;
}

function skillCommand(name: string, skillPath: string): RuntimeSkillCommand {
	return { name, source: "skill", sourceInfo: { path: skillPath } };
}

test("parseDryRunCommand preserves quoted arg tail and excludes prompt name from remaining args", () => {
	const parsed = parseDryRunCommand('review "src/my file.ts"');
	assert.equal(parsed.promptName, "review");
	assert.equal(parsed.remainingArgs, '"src/my file.ts"');
	assert.equal(parsed.showSkills, false);
});

test("parseDryRunCommand removes unquoted --show-skills wherever it appears", () => {
	for (const input of ["--show-skills review file.ts", "review --show-skills file.ts", "review file.ts --show-skills"]) {
		const parsed = parseDryRunCommand(input);
		assert.equal(parsed.promptName, "review");
		assert.equal(parsed.showSkills, true);
		assert.equal(parsed.remainingArgs, "file.ts");
	}
});

test("parseDryRunCommand removes unquoted --plain wherever it appears", () => {
	for (const input of ["--plain review file.ts", "review --plain file.ts", "review file.ts --plain"]) {
		const parsed = parseDryRunCommand(input);
		assert.equal(parsed.promptName, "review");
		assert.equal(parsed.plain, true);
		assert.equal(parsed.remainingArgs, "file.ts");
	}
});

test("parseDryRunCommand removes unquoted --tui wherever it appears", () => {
	for (const input of ["--tui review file.ts", "review --tui file.ts"]) {
		const parsed = parseDryRunCommand(input);
		assert.equal(parsed.promptName, "review");
		assert.equal(parsed.tui, true);
		assert.equal(parsed.remainingArgs, "file.ts");
	}
});

test("parseDryRunCommand keeps quoted control flags as template args", () => {
	const parsed = parseDryRunCommand('review "--show-skills" "--plain" "--tui"');
	assert.equal(parsed.promptName, "review");
	assert.equal(parsed.showSkills, false);
	assert.equal(parsed.plain, false);
	assert.equal(parsed.tui, false);
	assert.equal(parsed.remainingArgs, '"--show-skills" "--plain" "--tui"');
});

test("parseDryRunCommand keeps runtime flags in remaining args", () => {
	const parsed = parseDryRunCommand("--show-skills review --model=gpt-5.2 --loop 3 --fresh --subagent=reviewer file.ts");
	assert.equal(parsed.promptName, "review");
	assert.equal(parsed.showSkills, true);
	assert.equal(parsed.remainingArgs, "--model=gpt-5.2 --loop 3 --fresh --subagent=reviewer file.ts");
});

test("parseDryRunCommand can set both --plain and --tui; plain wins later", () => {
	const parsed = parseDryRunCommand("--tui review --plain file.ts");
	assert.equal(parsed.promptName, "review");
	assert.equal(parsed.tui, true);
	assert.equal(parsed.plain, true);
	assert.equal(parsed.remainingArgs, "file.ts");
});

test("renders includes + $@ args through existing loader/preparation path", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompt-partials"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-partials", "args.md"), "Args: $@");
		writeFileSync(join(cwd, ".pi", "prompts", "args-demo.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: args.md\n---\nTail");
		const loaded = loadPromptsWithModel(cwd);
		const result = assertOk(await createPromptDryRun(loaded.prompts.get("args-demo")!, options(cwd, { rawArgs: "one two" })));
		assert.equal(result.content, "Args: one two\n\nTail");
		assert.deepEqual(result.args, ["one", "two"]);
		assert.deepEqual(result.includeGraph?.edges.map((edge) => edge.includePath), ["args.md"]);
		assert.equal(result.details.includeGraph, result.includeGraph);
	});
});

test("renders <if-model> against resolved model", async () => {
	const result = assertOk(await createPromptDryRun(prompt({ content: '<if-model is="anthropic/*">anthropic<else>other</if-model>' }), options("/tmp")));
	assert.equal(result.content, "anthropic");
	assert.equal(result.model!.id, sonnet.id);
});

test("honors runtime --model override for model selection and conditionals", async () => {
	const result = assertOk(await createPromptDryRun(prompt({ content: '<if-model is="openai/*">openai<else>other</if-model>' }), options("/tmp", { rawArgs: "--model=gpt-5.2" })));
	assert.equal(result.content, "openai");
	assert.equal(result.model!.id, gpt.id);
	assert.equal(result.runtime.model, "gpt-5.2");
});

test("inherits current model when prompt has no model", async () => {
	const result = assertOk(await createPromptDryRun(prompt({ models: [], content: '<if-model is="anthropic/*">ok</if-model>' }), options("/tmp", { currentModel: sonnet as never })));
	assert.equal(result.content, "ok");
	assert.equal(result.model!.id, sonnet.id);
});

test("returns error when no model exists and no current model exists", async () => {
	const result = assertError(await createPromptDryRun(prompt({ models: [], content: "body" }), options("/tmp")));
	assert.match(result.error, /has no `model` configured and there is no active session model/i);
});

test("returns warning but prints content for malformed conditional warning", async () => {
	const result = assertOk(await createPromptDryRun(prompt({ content: 'before <if-model>broken</if-model> after' }), options("/tmp")));
	assert.equal(result.content, 'before <if-model>broken</if-model> after');
	assert.match(result.warnings.join("\n"), /requires an `is` attribute/);
});

test("returns error for empty rendered prompt", async () => {
	const result = assertError(await createPromptDryRun(prompt({ content: '<if-model is="openai/gpt-5.2">hidden</if-model>' }), options("/tmp")));
	assert.equal(result.error, "Prompt `demo` rendered to an empty message.");
});

test("resolves skills but defaults to metadata-only skill entries", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		const skillPath = writeProjectSkill(cwd, "tmux", "tmux content");
		const result = assertOk(await createPromptDryRun(prompt({ skill: "tmux" }), options(cwd)));
		assert.deepEqual(result.skills, [{ skillName: "tmux", skillPath }]);
	});
});

test("includes skill content only when showSkills: true", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		const skillPath = writeProjectSkill(cwd, "tmux", "tmux content");
		const hidden = assertOk(await createPromptDryRun(prompt({ skill: "tmux" }), options(cwd)));
		assert.deepEqual(hidden.skills, [{ skillName: "tmux", skillPath }]);
		const shown = assertOk(await createPromptDryRun(prompt({ skill: "tmux" }), options(cwd, { showSkills: true })));
		assert.deepEqual(shown.skills, [{ skillName: "tmux", skillPath, skillContent: "tmux content" }]);
	});
});

test("dry-run previews skill-bearing delegated prompts", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		const skillPath = writeProjectSkill(cwd, "tmux", "tmux content");
		const result = assertOk(await createPromptDryRun(prompt({ skill: "tmux", subagent: true }), options(cwd)));
		assert.deepEqual(result.runtime.delegation, { enabled: true, agent: "delegate" });
		assert.equal(result.content, "Body ");
		assert.doesNotMatch(result.content, /tmux content/);
		assert.deepEqual(result.skills, [{ skillName: "tmux", skillPath }]);
		const shown = assertOk(await createPromptDryRun(prompt({ skill: "tmux", subagent: true }), options(cwd, { showSkills: true })));
		assert.deepEqual(shown.skills, [{ skillName: "tmux", skillPath, skillContent: "tmux content" }]);
	});
});

test("returns unsupported error for chain prompts", async () => {
	const result = assertError(await createPromptDryRun(prompt({ chain: "one -> two" }), options("/tmp")));
	assert.equal(result.error, "Dry-run for chain templates is not supported in v1. Use /validate-prompts for structural checks.");
});

test("returns compare preflight for compare prompts", async () => {
	const result = assertOk(await createPromptDryRun(prompt({ workers: [{ agent: "worker" }] }), options("/tmp")));
	assert.equal(result.comparePreflight?.callCount.workers, 1);
	assert.equal(result.comparePreflight?.slots.workers[0]?.agent, "worker");
	assert.equal(result.content, "Body ");
});

test("returns compare preflight for path-driven compare prompts", async () => {
	await withTempHome(async (root) => {
		const target = join(root, "target-repo");
		mkdirSync(target, { recursive: true });
		const result = assertOk(await createPromptDryRun(
			prompt({ name: "parallel-patch-compare-at-path", workers: [{ agent: "worker" }], content: "Fix $@" }),
			options(root, { rawArgs: `${target} bug now`, pathArgumentPromptName: "parallel-patch-compare-at-path" }),
		));
		assert.equal(result.comparePreflight?.compareCwd.resolved, realpathSync(target));
		assert.deepEqual(result.args, ["bug", "now"]);
		assert.equal(result.content, "Fix bug now");
	});
});

test("returns unsupported error for deterministic prompts", async () => {
	const result = assertError(await createPromptDryRun(prompt({ deterministic: { execution: { kind: "run", command: "date" }, handoff: "always", nonInteractive: true } }), options("/tmp")));
	assert.equal(result.error, "Dry-run for deterministic prompts is not supported in v1 because it would require running configured commands/scripts.");
});

test("records loop/restore/thinking/boomerang metadata without executing anything", async () => {
	const result = assertOk(await createPromptDryRun(prompt({ restore: true, thinking: "high", loop: 2, fresh: true, converge: false, boomerang: true }), options("/tmp", { rawArgs: "--fresh --no-converge" })));
	assert.deepEqual(result.runtime.loop, { count: 2, fresh: true, converge: false });
	assert.equal(result.runtime.restore, true);
	assert.equal(result.runtime.thinking, "high");
	assert.equal(result.runtime.boomerang, true);
});

test("records delegation metadata for --subagent, --subagent=reviewer, and --fork", async () => {
	const base = prompt();
	assert.deepEqual(assertOk(await createPromptDryRun(base, options("/tmp", { rawArgs: "--subagent task" }))).runtime.delegation, { enabled: true, agent: "delegate" });
	assert.deepEqual(assertOk(await createPromptDryRun(base, options("/tmp", { rawArgs: "--subagent=reviewer task" }))).runtime.delegation, { enabled: true, agent: "reviewer" });
	const forked = assertOk(await createPromptDryRun(base, options("/tmp", { rawArgs: "--fork task" })));
	assert.deepEqual(forked.runtime.delegation, { enabled: true, agent: "delegate", fork: true, inheritContext: true });
});

test("records default delegate agent for subagent frontmatter", async () => {
	const result = assertOk(await createPromptDryRun(prompt({ subagent: true }), options("/tmp")));
	assert.deepEqual(result.runtime.delegation, { enabled: true, agent: "delegate" });
});

test("validates/records --cwd without changing process cwd", async () => {
	await withTempHome(async (root) => {
		const startCwd = process.cwd();
		const runtimeCwd = join(root, "runtime-file");
		writeFileSync(runtimeCwd, "file path accepted like runtime");
		const result = assertOk(await createPromptDryRun(prompt(), options(root, { rawArgs: `--cwd=${runtimeCwd} arg` })));
		assert.equal(result.runtime.cwd, runtimeCwd);
		assert.equal(process.cwd(), startCwd);
		const invalid = assertError(await createPromptDryRun(prompt(), options(root, { rawArgs: "--cwd=relative arg" })));
		assert.equal(invalid.error, "Invalid --cwd path: must be absolute");
		assert.equal(process.cwd(), startCwd);
	});
});

test("quoted runtime-looking flags stay prompt args", async () => {
	const result = assertOk(await createPromptDryRun(prompt({ content: "Args: $@" }), options("/tmp", { rawArgs: '"--model=gpt-5.2" "--cwd=/tmp" "--loop" keep' })));
	assert.equal(result.content, "Args: --model=gpt-5.2 --cwd=/tmp --loop keep");
	assert.deepEqual(result.args, ["--model=gpt-5.2", "--cwd=/tmp", "--loop", "keep"]);
	assert.equal(result.runtime.model, undefined);
	assert.equal(result.runtime.cwd, undefined);
	assert.equal(result.runtime.loop, undefined);
});

test("loop flags are stripped from rendered args and shown as metadata", async () => {
	const result = assertOk(await createPromptDryRun(prompt({ content: "Args: $@" }), options("/tmp", { rawArgs: "--loop 3 keep --fresh --no-converge" })));
	assert.equal(result.content, "[Loop 1/3]\n\nArgs: keep");
	assert.deepEqual(result.args, ["keep"]);
	assert.deepEqual(result.runtime.loop, { count: 3, fresh: true, converge: false });
});

test("unlimited loop dry-run shows representative first iteration loop context", async () => {
	const result = assertOk(await createPromptDryRun(prompt({ content: "Args: $@" }), options("/tmp", { rawArgs: "--loop keep" })));
	assert.equal(result.content, "[Loop 1]\n\nArgs: keep");
	assert.deepEqual(result.runtime.loop, { count: null, fresh: false, converge: true });
});

test("rotating loop dry-run uses first rotated model for label and conditionals", async () => {
	const result = assertOk(await createPromptDryRun(
		prompt({
			content: '<if-model is="openai/*">openai<else>other</if-model>',
			models: [gpt.id, sonnet.id],
			rotate: true,
			loop: 3,
			thinkingLevels: ["high", "low"],
		}),
		options("/tmp"),
	));
	assert.equal(result.content, "[Loop 1/3 · gpt-5.2 high]\n\nopenai");
	assert.equal(result.model!.id, gpt.id);
	assert.equal(result.runtime.thinking, "high");
});

test("delegated prompt frontmatter cwd is shown as effective runtime cwd metadata", async () => {
	await withTempHome(async (root) => {
		const ctxCwd = join(root, "ctx");
		const delegatedCwd = join(root, "delegated");
		const cliCwd = join(root, "cli");
		mkdirSync(ctxCwd, { recursive: true });
		mkdirSync(delegatedCwd, { recursive: true });
		mkdirSync(cliCwd, { recursive: true });
		const fromPrompt = assertOk(await createPromptDryRun(prompt({ subagent: true, cwd: delegatedCwd }), options(ctxCwd)));
		assert.equal(fromPrompt.runtime.cwd, delegatedCwd);
		const fromCli = assertOk(await createPromptDryRun(prompt({ subagent: true, cwd: delegatedCwd }), options(ctxCwd, { rawArgs: `--cwd=${cliCwd}` })));
		assert.equal(fromCli.runtime.cwd, cliCwd);
	});
});

test("delegated dry-run rejects missing effective cwd like runtime", async () => {
	await withTempHome(async (root) => {
		const ctxCwd = join(root, "ctx");
		mkdirSync(ctxCwd, { recursive: true });
		const missingFrontmatter = join(root, "missing-frontmatter");
		const fromPrompt = assertError(await createPromptDryRun(prompt({ subagent: true, cwd: missingFrontmatter }), options(ctxCwd)));
		assert.equal(fromPrompt.error, `cwd directory does not exist: ${missingFrontmatter}`);

		const missingCli = join(root, "missing-cli");
		const fromCli = assertError(await createPromptDryRun(prompt({ subagent: true, cwd: join(root, "also-missing") }), options(ctxCwd, { rawArgs: `--cwd=${missingCli}` })));
		assert.equal(fromCli.error, `cwd directory does not exist: ${missingCli}`);
	});
});

test("non-delegated dry-run keeps cwd metadata without existence check", async () => {
	await withTempHome(async (root) => {
		const missing = join(root, "missing-nondelegated");
		const result = assertOk(await createPromptDryRun(prompt(), options(root, { rawArgs: `--cwd=${missing}` })));
		assert.equal(result.runtime.cwd, missing);
	});
});

test("parallel delegated dry-run shows each runtime subagent task prefix", async () => {
	const result = assertOk(await createPromptDryRun(prompt({ subagent: true, parallel: 3, content: "Body $1" }), options("/tmp", { rawArgs: "file.ts" })));
	assert.deepEqual(result.runtime.delegation, { enabled: true, agent: "delegate", parallel: 3 });
	assert.equal(result.content, [
		"[Parallel subagent 1/3]",
		"",
		"Body file.ts",
		"",
		"[Parallel subagent 2/3]",
		"",
		"Body file.ts",
		"",
		"[Parallel subagent 3/3]",
		"",
		"Body file.ts",
	].join("\n"));
});

test("--cwd is displayed as runtime metadata but skills still resolve from ctx.cwd, matching runtime", async () => {
	await withTempHome(async (root) => {
		const ctxCwd = join(root, "ctx");
		const runtimeCwd = join(root, "runtime");
		const ctxSkill = writeProjectSkill(ctxCwd, "shared", "ctx skill");
		writeProjectSkill(runtimeCwd, "shared", "runtime skill");
		const result = assertOk(await createPromptDryRun(prompt({ skill: "shared" }), options(ctxCwd, { rawArgs: `--cwd=${runtimeCwd}`, showSkills: true })));
		assert.equal(result.runtime.cwd, runtimeCwd);
		assert.deepEqual(result.skills, [{ skillName: "shared", skillPath: ctxSkill, skillContent: "ctx skill" }]);
	});
});

test("default details omit skillContent; --show-skills includes it", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		const registeredPath = join(root, "registered.md");
		writeFileSync(registeredPath, "registered content");
		const commands = [skillCommand("skill:external", registeredPath)];
		const hidden = assertOk(await createPromptDryRun(prompt({ skills: ["external"] }), options(cwd, { commands })));
		assert.equal("skillContent" in hidden.details.skills[0]!, false);
		const shown = assertOk(await createPromptDryRun(prompt({ skills: ["external"] }), options(cwd, { commands, showSkills: true })));
		assert.equal(shown.details.skills[0]?.skillContent, "registered content");
	});
});

test("running dry-run for a skill prompt exposes no side-effect hooks or pending messages", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		writeProjectSkill(cwd, "tmux", "tmux content");
		const result = assertOk(await createPromptDryRun(prompt({ skill: "tmux" }), options(cwd)));
		assert.equal("pendingSkillMessage" in result, false);
		assert.equal("hooks" in result, false);
	});
});
