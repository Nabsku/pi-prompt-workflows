import test from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	capturePromptExecutionOutcome,
	captureStepExecutionOutcome,
	normalizePromptCompletionOutcome,
	PromptBudgetExceededError,
} from "../prompt-execution.ts";
import { normalizeDeterministicExecutionOutcome, type DeterministicExecutionResult } from "../deterministic-step.ts";

function assistant(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "model output" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: 1,
	};
}

const deterministicBase = {
	execution: { kind: "run" as const, command: "true" }, cwd: "/tmp", nonInteractive: true,
	stdout: "", stdoutTotalChars: 0, stdoutTotalLines: 0, stdoutTruncated: false,
	stderr: "", stderrTotalChars: 0, stderrTotalLines: 0, stderrTruncated: false, durationMs: 1,
};

function deterministic(overrides: Partial<DeterministicExecutionResult>): DeterministicExecutionResult {
	return { ...deterministicBase, exitCode: 0, timedOut: false, ...overrides };
}

test("generic execution capture preserves thrown error classification", async () => {
	const payload = { content: "non-model callback result" };
	assert.deepEqual(await captureStepExecutionOutcome(async () => payload), { status: "succeeded", result: payload });
	const modelError = new Error("model unavailable");
	assert.deepEqual(await captureStepExecutionOutcome(async () => { throw modelError; }), { status: "failed", error: modelError });
});

test("prompt completion normalization uses real AssistantMessage stop state and preserves the message", () => {
	for (const stopReason of ["stop", "length", "toolUse"] as const) {
		const message = assistant(stopReason);
		assert.deepEqual(normalizePromptCompletionOutcome(message), { status: "succeeded", result: message });
	}
	for (const stopReason of ["error", "aborted"] as const) {
		const message = { ...assistant(stopReason), errorMessage: `${stopReason} detail` };
		assert.deepEqual(normalizePromptCompletionOutcome(message), { status: "failed", result: message });
	}
	assert.throws(() => normalizePromptCompletionOutcome({ ...assistant("stop"), stopReason: undefined } as never), /stopReason/i);
	assert.throws(() => normalizePromptCompletionOutcome({ ...assistant("stop"), stopReason: "future-state" } as never), /stopReason/i);
});

test("adaptive prompt adapter normalizes resolved failures and rejected calls", async () => {
	const failed = assistant("error");
	assert.deepEqual(await capturePromptExecutionOutcome({ name: "demo" }, "short", async () => failed), { status: "failed", result: failed });
	const thrown = new Error("transport unavailable");
	assert.deepEqual(await capturePromptExecutionOutcome({ name: "demo" }, "short", async () => { throw thrown; }), { status: "failed", error: thrown });
});

test("adaptive prompt adapter blocks maximum budget before model-send side effects", async () => {
	let sends = 0;
	const outcome = await capturePromptExecutionOutcome(
		{ name: "demo", budget: { maxTokens: 1 } },
		"one two three four five six seven eight nine ten",
		async () => { sends++; return assistant("stop"); },
	);
	assert.equal(outcome.status, "blocked");
	assert.ok("error" in outcome && outcome.error instanceof PromptBudgetExceededError);
	assert.equal(sends, 0);
});

test("deterministic normalization accepts only clean exit zero as success", () => {
	const result = deterministic({ exitCode: 0 });
	assert.deepEqual(normalizeDeterministicExecutionOutcome(result), { status: "succeeded", result });
});

test("deterministic normalization classifies nonzero exit as failed", () => {
	const result = deterministic({ exitCode: 2 });
	assert.deepEqual(normalizeDeterministicExecutionOutcome(result), { status: "failed", result });
});

test("deterministic normalization classifies standalone signal as failed", () => {
	const result = deterministic({ exitCode: null, signal: "SIGTERM" });
	assert.deepEqual(normalizeDeterministicExecutionOutcome(result), { status: "failed", result });
});

test("deterministic normalization classifies timeout as failed", () => {
	const result = deterministic({ exitCode: null, timedOut: true, signal: "SIGKILL" });
	assert.deepEqual(normalizeDeterministicExecutionOutcome(result), { status: "failed", result });
});

test("deterministic normalization classifies explicit cancellation and abort as failed", () => {
	for (const termination of ["cancelled", "aborted"] as const) {
		const result = deterministic({ exitCode: null, termination });
		assert.deepEqual(normalizeDeterministicExecutionOutcome(result), { status: "failed", result });
	}
});

test("deterministic normalization rejects missing, contradictory, and unknown termination shapes", () => {
	assert.throws(() => normalizeDeterministicExecutionOutcome(deterministic({ exitCode: undefined as never })), /exitCode/i);
	assert.throws(() => normalizeDeterministicExecutionOutcome(deterministic({ exitCode: 0, signal: "SIGTERM" })), /contradictory/i);
	assert.throws(() => normalizeDeterministicExecutionOutcome(deterministic({ exitCode: 0, timedOut: true })), /contradictory/i);
	assert.throws(() => normalizeDeterministicExecutionOutcome(deterministic({ exitCode: 0, termination: "cancelled" })), /contradictory/i);
	assert.throws(() => normalizeDeterministicExecutionOutcome(deterministic({ exitCode: null })), /unknown termination/i);
	assert.throws(() => normalizeDeterministicExecutionOutcome(deterministic({ exitCode: null, termination: "future" as never })), /unknown termination/i);
});
