import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePromptExecution } from "../prompt-execution.js";
import { loadPromptsWithModel } from "../prompt-loader.js";

const model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
const registry = {
	find(provider: string, modelId: string) {
		return provider === model.provider && modelId === model.id ? model : undefined;
	},
	getAll() {
		return [model];
	},
	getAvailable() {
		return [model];
	},
	async getApiKeyAndHeaders() {
		return { ok: true, apiKey: "token" };
	},
	isUsingOAuth() {
		return false;
	},
};

async function withTempHome<T>(run: (root: string) => Promise<T> | T): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-execution-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		return await run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

test("included $@ survives loader rendering and is substituted during execution prep", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompt-partials"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-partials", "args.md"), "Args: $@");
		writeFileSync(join(cwd, ".pi", "prompts", "args-demo.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: args.md\n---\nTail");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.diagnostics.length, 0);
		const prompt = result.prompts.get("args-demo");
		assert.ok(prompt);
		assert.equal(prompt.content, "Args: $@\n\nTail");

		const prepared = await preparePromptExecution(prompt, ["one", "two"], undefined, registry as never);
		assert.ok(prepared && !("message" in prepared));
		assert.equal(prepared.content, "Args: one two\n\nTail");
	});
});

test("included <if-model> survives loader rendering and is rendered during execution prep", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "prompt-partials"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompt-partials", "conditional.md"), '<if-model is="anthropic/*">anthropic<else>other</if-model>');
		writeFileSync(join(cwd, ".pi", "prompts", "conditional-demo.md"), "---\nmodel: claude-sonnet-4-20250514\ninclude: conditional.md\n---\nTail");

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.diagnostics.length, 0);
		const prompt = result.prompts.get("conditional-demo");
		assert.ok(prompt);
		assert.equal(prompt.content, '<if-model is="anthropic/*">anthropic<else>other</if-model>\n\nTail');

		const prepared = await preparePromptExecution(prompt, [], undefined, registry as never);
		assert.ok(prepared && !("message" in prepared));
		assert.equal(prepared.content, "anthropic\n\nTail");
	});
});

test("preparePromptExecution renders conditionals before substituting user args", async () => {
	const prepared = await preparePromptExecution(
		{
			name: "demo",
			models: ["claude-sonnet-4-20250514"],
			content: "$1\n<if-model is=\"anthropic/*\">kept</if-model>",
		},
		['<if-model is="openai/gpt-5.2">bad</if-model>'],
		undefined,
		registry as never,
	);

	assert.ok(prepared && !("message" in prepared));
	assert.equal(prepared?.content, '<if-model is="openai/gpt-5.2">bad</if-model>\nkept');
});

test("preparePromptExecution aborts whitespace-only output after rendering", async () => {
	const prepared = await preparePromptExecution(
		{
			name: "demo",
			models: ["claude-sonnet-4-20250514"],
			content: '<if-model is="openai/gpt-5.2">gone</if-model>',
		},
		[],
		undefined,
		registry as never,
	);

	assert.ok(prepared && "message" in prepared);
	assert.equal(prepared?.message, "Prompt `demo` rendered to an empty message.");
});

test("preparePromptExecution renders else branch when model does not match", async () => {
	const prepared = await preparePromptExecution(
		{
			name: "demo",
			models: ["claude-sonnet-4-20250514"],
			// Correct syntax: <else> is a separator, no </else> closing tag
			content: '<if-model is="openai/*">openai<else>not-openai</if-model>',
		},
		[],
		undefined,
		registry as never,
	);

	assert.ok(prepared && !("message" in prepared));
	assert.equal(prepared?.content, "not-openai");
});

test("preparePromptExecution renders conditionals against resolved fallback model", async () => {
	const sonnet = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
	const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };

	// Registry where haiku is NOT available, but sonnet IS
	const fallbackRegistry = {
		find(provider: string, modelId: string) {
			if (provider === "anthropic" && modelId === "claude-sonnet-4-20250514") return sonnet;
			if (provider === "anthropic" && modelId === "claude-haiku-4-5") return haiku;
			return undefined;
		},
		getAll() {
			return [haiku, sonnet];
		},
		getAvailable() {
			return [sonnet]; // Only sonnet is available
		},
			async getApiKeyAndHeaders() {
				return { ok: false, error: "missing auth" };
			},
		isUsingOAuth() {
			return false;
		},
	};

	// Prompt lists haiku first, but haiku isn't available, so we fall back to sonnet
	// The conditional should match sonnet, not haiku
	const prepared = await preparePromptExecution(
		{
			name: "demo",
			models: ["claude-haiku-4-5", "claude-sonnet-4-20250514"],
			// Correct syntax: <else> is a separator, no </else> closing tag
			content: '<if-model is="claude-haiku-4-5">haiku<else>not-haiku</if-model>',
		},
		[],
		undefined,
		fallbackRegistry as never,
	);

	assert.ok(prepared && !("message" in prepared));
	// Should be "not-haiku" because we fell back to sonnet
	assert.equal(prepared?.content, "not-haiku");
	assert.equal(prepared?.selectedModel.model.id, "claude-sonnet-4-20250514");
});

test("preparePromptExecution inherits current model when prompt has no model frontmatter", async () => {
	const prepared = await preparePromptExecution(
		{
			name: "demo",
			models: [],
			content: '<if-model is="anthropic/*">ok</if-model>',
		},
		[],
		model as never,
		registry as never,
	);

	assert.ok(prepared && !("message" in prepared));
	assert.equal(prepared?.content, "ok");
	assert.equal(prepared?.selectedModel.model.id, model.id);
	assert.equal(prepared?.selectedModel.alreadyActive, true);
});

test("preparePromptExecution fails with clear error when prompt has no model and no current model", async () => {
	const prepared = await preparePromptExecution(
		{
			name: "demo",
			models: [],
			content: "body",
		},
		[],
		undefined,
		registry as never,
	);

	assert.ok(prepared && "message" in prepared);
	assert.match(prepared?.message ?? "", /has no `model` configured and there is no active session model/i);
});

test("preparePromptExecution can inherit a fixed model distinct from the current model", async () => {
	const current = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
	const inherited = { provider: "anthropic", id: "claude-haiku-4-5" };
	const prepared = await preparePromptExecution(
		{
			name: "demo",
			models: [],
			content: '<if-model is="claude-haiku-4-5">haiku<else>other</if-model>',
		},
		[],
		current as never,
		registry as never,
		{ inheritedModel: inherited as never },
	);

	assert.ok(prepared && !("message" in prepared));
	assert.equal(prepared?.content, "haiku");
	assert.equal(prepared?.selectedModel.model.id, "claude-haiku-4-5");
	assert.equal(prepared?.selectedModel.alreadyActive, false);
});

test("preparePromptExecution treats explicitly undefined inherited model as missing", async () => {
	const prepared = await preparePromptExecution(
		{
			name: "demo",
			models: [],
			content: "body",
		},
		[],
		model as never,
		registry as never,
		{ inheritedModel: undefined },
	);

	assert.ok(prepared && "message" in prepared);
	assert.match(prepared?.message ?? "", /has no `model` configured and there is no active session model/i);
});
