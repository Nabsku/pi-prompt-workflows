import test from "node:test";
import assert from "node:assert/strict";
import { PromptInputForm } from "../prompt-input-tui.ts";

test("PromptInputForm edits string values and submits", () => {
	let result: unknown;
	const form = new PromptInputForm({ target: { type: "string", required: true } }, {}, (value) => { result = value; });
	form.handleInput("a");
	form.handleInput("b");
	form.handleInput("\n");
	assert.deepEqual(result, { action: "submitted", values: { target: "ab" } });
});

test("PromptInputForm toggles booleans and cycles choices", () => {
	let result: any;
	const form = new PromptInputForm({ mode: { type: "choice", options: ["quick", "deep"], default: "quick" }, run: { type: "boolean", default: false } }, {}, (value) => { result = value; });
	form.handleInput(" ");
	form.handleInput("\n");
	form.handleInput(" ");
	form.handleInput("\n");
	assert.deepEqual(result, { action: "submitted", values: { mode: "deep", run: true } });
});

test("PromptInputForm supports q cancellation for non-text fields", () => {
	let result: unknown;
	const form = new PromptInputForm({ mode: { type: "choice", options: ["deep", "fast"], required: true } }, {}, (value) => { result = value; });
	form.handleInput("q");
	assert.deepEqual(result, { action: "cancelled" });
});

test("PromptInputForm keeps q in string values", () => {
	let result: unknown;
	const form = new PromptInputForm({ target: { type: "string", required: true } }, {}, (value) => { result = value; });
	form.handleInput("q");
	assert.equal(result, undefined);
});
