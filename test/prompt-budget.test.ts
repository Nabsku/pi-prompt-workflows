import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePromptBudget, estimatePromptTokens } from "../prompt-budget.js";

test("estimatePromptTokens uses deterministic UTF-8 byte approximation", () => {
	assert.deepEqual(estimatePromptTokens(""), { bytes: 0, estimatedTokens: 0, method: "utf8-bytes-divided-by-4" });
	assert.deepEqual(estimatePromptTokens("abcd"), { bytes: 4, estimatedTokens: 1, method: "utf8-bytes-divided-by-4" });
	assert.deepEqual(estimatePromptTokens("abcde"), { bytes: 5, estimatedTokens: 2, method: "utf8-bytes-divided-by-4" });
	assert.deepEqual(estimatePromptTokens("🙂"), { bytes: 4, estimatedTokens: 1, method: "utf8-bytes-divided-by-4" });
});

test("evaluatePromptBudget reports unconfigured, within, warning, and exceeded verdicts", () => {
	assert.equal(evaluatePromptBudget("abcdefgh", undefined).verdict, "unconfigured");
	assert.equal(evaluatePromptBudget("abcdefgh", { warnTokens: 3 }).verdict, "within");
	assert.equal(evaluatePromptBudget("abcdefgh", { warnTokens: 2 }).verdict, "warning");
	assert.equal(evaluatePromptBudget("abcdefgh", { maxTokens: 2 }).verdict, "within");
	assert.equal(evaluatePromptBudget("abcdefgh", { maxTokens: 1 }).verdict, "exceeded");
});

test("maximum overage takes precedence over warning", () => {
	const result = evaluatePromptBudget("abcdefghijkl", { warnTokens: 1, maxTokens: 2 });
	assert.equal(result.estimatedTokens, 3);
	assert.equal(result.verdict, "exceeded");
});
