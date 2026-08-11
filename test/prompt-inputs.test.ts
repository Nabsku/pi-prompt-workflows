import test from "node:test";
import assert from "node:assert/strict";
import { renderPromptInputValues, resolvePromptInputs, validatePromptInputSchema } from "../prompt-inputs.ts";

const schema = {
	target: { type: "string" as const, required: true },
	depth: { type: "choice" as const, options: ["quick", "deep"], default: "quick" },
	"run-tests": { type: "boolean" as const, default: true },
};

test("validates the minimal input schema and applies defaults", () => {
	const result = resolvePromptInputs(schema, ["--target=src/a.ts", "--no-run-tests", "--", "--model", "literal"]);
	assert.deepEqual(result.errors, []);
	assert.equal(result.values.target.value, "src/a.ts");
	assert.equal(result.values.depth.value, "quick");
	assert.equal(result.values["run-tests"].value, false);
	assert.deepEqual(result.positional, ["--model", "literal"]);
});

test("supports separate values and preserves spaces in already-tokenized arguments", () => {
	const result = resolvePromptInputs({ note: { type: "string", required: true } }, ["--note", "two words"]);
	assert.deepEqual(result.errors, []);
	assert.equal(result.values.note.value, "two words");
});

test("bare booleans do not consume positional text and missing values fail", () => {
	const booleanResult = resolvePromptInputs({ ok: { type: "boolean", default: false } }, ["--ok", "review", "this"]);
	assert.deepEqual(booleanResult.errors, []);
	assert.equal(booleanResult.values.ok.value, true);
	assert.deepEqual(booleanResult.positional, ["review", "this"]);
	const missingResult = resolvePromptInputs({ target: { type: "string", required: true } }, ["--target", "--", "text"]);
	assert.match(missingResult.errors.join("\n"), /missing value/);
	assert.deepEqual(missingResult.positional, ["text"]);
});

test("rejects unknown, duplicate, invalid, and missing inputs", () => {
	const result = resolvePromptInputs({
		mode: { type: "choice", options: ["a", "b"], required: true },
		ok: { type: "boolean", default: false },
	}, ["--mode=a", "--mode=b", "--ok=maybe", "--wat"]);
	assert.match(result.errors.join("\n"), /duplicate input/);
	assert.match(result.errors.join("\n"), /must be true or false/);
	assert.match(result.errors.join("\n"), /unknown option/);
});

test("rejects runtime flag and boolean negative-alias collisions", () => {
	assert.match(validatePromptInputSchema({ model: { type: "string", required: true } }).join("\n"), /runtime flag/);
	assert.match(validatePromptInputSchema({ "no-run-tests": { type: "boolean", default: false }, "run-tests": { type: "boolean", default: true } }).join("\n"), /collides/);
	assert.match(validatePromptInputSchema({ foo: { type: "string", required: true }, "no-foo": { type: "string", required: true } }).join("\n"), /collides/);
	assert.match(validatePromptInputSchema({ "no-model": { type: "string", required: true } }).join("\n"), /runtime flag/);
});

test("rejects input names reserved by removed runtime flags", () => {
	for (const name of [
		"worktree",
		"preset",
		"workers",
		"workers-append",
		"reviewers",
		"reviewers-append",
		"final-applier",
		"keep-artifacts",
	]) {
		assert.match(
			validatePromptInputSchema({ [name]: { type: "string", required: true } }).join("\n"),
			/runtime flag/,
			name,
		);
	}
});

test("requires a resolution path for strings and choices", () => {
	const errors = validatePromptInputSchema({ note: { type: "string" }, mode: { type: "choice", options: ["a"] } });
	assert.equal(errors.length, 2);
});

test("renders input conditionals and substitutions", () => {
	const resolved = resolvePromptInputs({ "run-tests": { type: "boolean", default: true }, target: { type: "string", required: true } }, ["--target", "src/app.ts"]);
	assert.equal(resolved.errors.length, 0);
	assert.equal(renderPromptInputValues("Review ${input.target}.<if-input name=\"run-tests\" is=\"true\"> Test it.<else> Skip it.</if-input>", resolved.values), "Review src/app.ts.<if-input name=\"run-tests\" is=\"true\"> Test it.<else> Skip it.</if-input>");
});

test("rejects invalid defaults, malformed names, and unsupported types", () => {
	const errors = validatePromptInputSchema({
		"Bad Name": { type: "string", required: true },
		mode: { type: "choice", options: ["a"], default: "b" },
		count: { type: "integer" as never, default: 1 as never },
	});
	assert.match(errors.join("\n"), /kebab-case/);
	assert.match(errors.join("\n"), /one of its options/);
	assert.match(errors.join("\n"), /unsupported type/);
});
