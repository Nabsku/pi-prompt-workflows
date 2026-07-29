import test from "node:test";
import assert from "node:assert/strict";
import { createAdaptiveChainState, routeAdaptiveChain } from "../adaptive-chain.ts";
import type { ChainLimits, StructuredChainStep } from "../chain-parser.ts";

const limits: ChainLimits = { maxSteps: 10, maxModelCalls: 5 };
const prompt = (id: string, extra: Partial<StructuredChainStep> = {}): StructuredChainStep => ({ id, kind: "prompt", target: id, when: "always", ...extra });
const run = (id: string, extra: Partial<StructuredChainStep> = {}): StructuredChainStep => ({ id, kind: "run", target: id, when: "always", ...extra });

function start(steps: StructuredChainStep[], customLimits = limits) {
	return routeAdaptiveChain(steps, customLimits, createAdaptiveChainState());
}

test("selects the first action and routes success through onSuccess", () => {
	const steps = [prompt("build", { onSuccess: "review" }), prompt("fallback"), prompt("review")];
	const first = start(steps);
	assert.equal(first.action?.step.id, "build");
	assert.deepEqual(first.decisions, [{ sourceStep: null, observedOutcome: null, matchedRule: "start", matchedGate: "always", selectedTarget: "build", reason: "selected" }]);
	const next = routeAdaptiveChain(steps, limits, first.state, { outcome: "succeeded", changed: true });
	assert.equal(next.action?.step.id, "review");
	assert.equal(next.decisions[0].matchedRule, "onSuccess");
	assert.equal(next.decisions[0].observedOutcome, "succeeded");
	assert.equal(next.decisions[0].selectedTarget, "review");
});

test("routes failure and blocked outcomes through their explicit transitions", () => {
	const steps = [run("test", { onFailure: "fix", onBlocked: "stop" }), prompt("done"), prompt("fix"), prompt("stop")];
	for (const [outcome, target, rule] of [["failed", "fix", "onFailure"], ["blocked", "stop", "onBlocked"]] as const) {
		const first = start(steps);
		const next = routeAdaptiveChain(steps, limits, first.state, { outcome, changed: false });
		assert.equal(next.action?.step.id, target);
		assert.equal(next.decisions[0].matchedRule, rule);
	}
});

test("unspecified and skipped outcome transitions naturally fall through", () => {
	const steps = [run("check"), prompt("next")];
	for (const outcome of ["failed", "blocked", "skipped"] as const) {
		const first = start(steps);
		const next = routeAdaptiveChain(steps, limits, first.state, { outcome, changed: false });
		assert.equal(next.action?.step.id, "next");
		assert.equal(next.decisions[0].matchedRule, "fallthrough");
	}
});

test("changed/no-change and outcome gates skip without model calls and fall through", () => {
	const steps = [prompt("build"), prompt("changed-only", { when: "changed" }), prompt("success-only", { when: "succeeded" }), prompt("failure-only", { when: "failed" }), run("finish")];
	const first = start(steps);
	const unchanged = routeAdaptiveChain(steps, limits, first.state, { outcome: "succeeded", changed: false });
	assert.equal(unchanged.action?.step.id, "success-only");
	assert.equal(unchanged.state.modelCalls, 2);
	assert.deepEqual(unchanged.decisions.map((decision) => [decision.selectedTarget, decision.reason]), [["changed-only", "gate-not-matched"], ["success-only", "selected"]]);
	const afterSuccess = routeAdaptiveChain(steps, limits, unchanged.state, { outcome: "succeeded", changed: true });
	assert.equal(afterSuccess.action?.step.id, "finish");
	assert.deepEqual(afterSuccess.decisions.map((decision) => decision.reason), ["gate-not-matched", "selected"]);

	const failureSteps = [run("check"), prompt("success", { when: "succeeded" }), prompt("failure", { when: "failed" })];
	const check = start(failureSteps);
	const failed = routeAdaptiveChain(failureSteps, limits, check.state, { outcome: "failed", changed: false });
	assert.equal(failed.action?.step.id, "failure");
	assert.deepEqual(failed.decisions.map((decision) => decision.reason), ["gate-not-matched", "selected"]);
});

test("run steps do not consume model calls while selected prompt steps do", () => {
	const steps = [run("one"), prompt("two")];
	const first = start(steps);
	assert.equal(first.state.modelCalls, 0);
	const second = routeAdaptiveChain(steps, limits, first.state, { outcome: "succeeded", changed: false });
	assert.equal(second.state.modelCalls, 1);
	assert.deepEqual(second.state.executed, ["one", "two"]);
});

test("tracks only selected actions as executed across skipped targets", () => {
	const steps = [run("check"), prompt("changed", { when: "changed" }), run("finish"), prompt("after")];
	const first = start(steps);
	const second = routeAdaptiveChain(steps, limits, first.state, { outcome: "succeeded", changed: false });
	assert.equal(second.action?.step.id, "finish");
	assert.deepEqual(second.state.visited, ["check", "changed", "finish"]);
	assert.deepEqual(second.state.executed, ["check", "finish"]);
	assert.equal(second.state.stepsTaken, 2);
	assert.equal(second.state.modelCalls, 0);
	const third = routeAdaptiveChain(steps, limits, second.state, { outcome: "succeeded", changed: true });
	assert.deepEqual(third.state.executed, ["check", "finish", "after"]);
	assert.equal(third.state.modelCalls, 1);
	assert.throws(
		() => routeAdaptiveChain(steps, limits, { ...third.state, modelCalls: 2 }, { outcome: "succeeded", changed: false }),
		/modelCalls.*replayed trace/i,
	);
});

test("fails visibly on unknown outcomes, current steps, and targets", () => {
	const steps = [prompt("one", { onSuccess: "missing" })];
	const first = start(steps);
	assert.throws(() => routeAdaptiveChain(steps, limits, first.state, { outcome: "mystery" as never, changed: false }), /unknown outcome/i);
	assert.throws(() => routeAdaptiveChain(steps, limits, { ...first.state, currentStep: "missing" }, { outcome: "succeeded", changed: false }), /currentStep.*replayed trace/i);
	assert.throws(() => routeAdaptiveChain(steps, limits, first.state, { outcome: "succeeded", changed: false }), /unknown target/i);
});

test("rejects repeated transitions even when malformed cyclic state reaches runtime", () => {
	const steps = [prompt("a", { onSuccess: "b" }), prompt("b", { onSuccess: "a" })];
	const first = start(steps);
	const second = routeAdaptiveChain(steps, limits, first.state, { outcome: "succeeded", changed: false });
	assert.throws(() => routeAdaptiveChain(steps, limits, second.state, { outcome: "succeeded", changed: false }), /repeated transition|cycle/i);
});

test("fails closed on unsupported statuses and malformed counters", () => {
	const steps = [prompt("a")];
	const base = createAdaptiveChainState();
	const malformed = [
		{ ...base, status: "bogus" },
		{ ...base, stepsTaken: -1 },
		{ ...base, stepsTaken: 0.5 },
		{ ...base, modelCalls: -1 },
		{ ...base, modelCalls: 0.5 },
		{ ...base, stepsTaken: 11 },
		{ ...base, stepsTaken: 1, modelCalls: 6 },
		{ ...base, stepsTaken: 1, modelCalls: 2 },
	] as never[];
	for (const state of malformed) {
		assert.throws(() => routeAdaptiveChain(steps, limits, state), /impossible progress/i);
	}
});

test("fails closed on malformed, duplicate, and unknown visited entries", () => {
	const steps = [prompt("a"), prompt("b")];
	const base = createAdaptiveChainState();
	for (const visited of [null, [""], [3], ["a", "a"], ["missing"]]) {
		assert.throws(
			() => routeAdaptiveChain(steps, limits, { ...base, visited } as never),
			/impossible progress/i,
		);
	}
});

test("fails closed on counter tampering and malformed executed history", () => {
	const steps = [prompt("a"), run("skip", { when: "changed" }), prompt("b")];
	const first = start(steps);
	const valid = routeAdaptiveChain(steps, limits, first.state, { outcome: "succeeded", changed: false }).state;
	assert.deepEqual(valid.visited, ["a", "skip", "b"]);
	assert.deepEqual(valid.executed, ["a", "b"]);
	for (const state of [
		{ ...valid, modelCalls: 1 },
		{ ...valid, modelCalls: 3 },
		{ ...valid, stepsTaken: 1 },
		{ ...valid, executed: null },
		{ ...valid, executed: ["a", "missing"] },
		{ ...valid, executed: ["a", "a"] },
		{ ...valid, executed: ["a", "skip", "b"] },
		{ ...valid, executed: ["b", "a"] },
		{ ...valid, visited: ["a", "skip"] },
	]) {
		assert.throws(() => routeAdaptiveChain(steps, limits, state as never, { outcome: "succeeded", changed: false }), /impossible progress/i);
	}
});

test("fails closed on status, current-step, and observation inconsistencies", () => {
	const steps = [prompt("a"), prompt("b")];
	const ready = createAdaptiveChainState();
	const awaiting = start(steps).state;
	const observation = { outcome: "succeeded", changed: false } as const;
	for (const state of [
		{ ...ready, currentStep: "a" },
		{ ...ready, stepsTaken: 1 },
		{ ...ready, visited: ["a"] },
		{ ...ready, executed: ["a"] },
		{ ...awaiting, currentStep: null },
		{ ...awaiting, currentStep: "missing" },
		{ ...awaiting, currentStep: "b" },
		{ ...awaiting, visited: [] },
		{ ...awaiting, executed: [] },
	]) {
		assert.throws(() => routeAdaptiveChain(steps, limits, state as never, observation), /impossible progress|unknown current step/i);
	}
	assert.throws(() => routeAdaptiveChain(steps, limits, ready, observation), /impossible progress/i);
	assert.throws(() => routeAdaptiveChain(steps, limits, awaiting), /impossible progress/i);
	assert.throws(() => routeAdaptiveChain(steps, limits, { ...awaiting, status: "completed", currentStep: null }, observation), /impossible progress/i);
});

test("enforces maxSteps and maxModelCalls before selecting another action", () => {
	const twoPrompts = [prompt("a"), prompt("b")];
	const stepLimited = start(twoPrompts, { maxSteps: 1, maxModelCalls: 5 });
	assert.throws(() => routeAdaptiveChain(twoPrompts, { maxSteps: 1, maxModelCalls: 5 }, stepLimited.state, { outcome: "succeeded", changed: false }), /maxSteps.*exhausted/i);
	const modelLimited = start(twoPrompts, { maxSteps: 5, maxModelCalls: 1 });
	assert.throws(() => routeAdaptiveChain(twoPrompts, { maxSteps: 5, maxModelCalls: 1 }, modelLimited.state, { outcome: "succeeded", changed: false }), /maxModelCalls.*exhausted/i);
});

test("replay rejects the exact forged prompt omission that would bypass maxModelCalls", () => {
	const steps = [prompt("a"), run("b"), prompt("c")];
	const capped: ChainLimits = { maxSteps: 5, maxModelCalls: 1 };
	const a = start(steps, capped);
	const b = routeAdaptiveChain(steps, capped, a.state, { outcome: "succeeded", changed: false });
	assert.equal(b.action?.step.id, "b");
	const forged = { ...b.state, visited: ["a", "b"], executed: ["b"], stepsTaken: 1, modelCalls: 0, trace: [{ stepId: "b", disposition: "selected" }] };
	assert.throws(() => routeAdaptiveChain(steps, capped, forged as never, { outcome: "succeeded", changed: false }), /trace expected step "a"/i);
	assert.throws(() => routeAdaptiveChain(steps, capped, b.state, { outcome: "succeeded", changed: false }), /maxModelCalls.*exhausted/i);
});

test("replay rejects altered trace step IDs, dispositions, outcomes, and change facts", () => {
	const steps = [prompt("a", { onFailure: "done" }), prompt("changed", { when: "changed" }), run("done")];
	const a = start(steps);
	const changed = routeAdaptiveChain(steps, limits, a.state, { outcome: "succeeded", changed: true });
	const trace = changed.state.trace;
	const mutations = [
		[{ ...trace[0], stepId: "done" }, trace[1]],
		[{ ...trace[0], disposition: "skipped" }, trace[1]],
		[{ ...trace[0], observation: { outcome: "failed", changed: true } }, trace[1]],
		[{ ...trace[0], observation: { outcome: "succeeded", changed: false } }, trace[1]],
		[{ ...trace[0], observation: { outcome: "bogus", changed: true } }, trace[1]],
	];
	for (const altered of mutations) assert.throws(() => routeAdaptiveChain(steps, limits, { ...changed.state, trace: altered } as never, { outcome: "succeeded", changed: false }), /impossible progress/i);
});

test("trace is JSON-serializable and replays success, failure, and gated skips", () => {
	const successSteps = [run("check"), prompt("changed", { when: "changed" }), prompt("success", { when: "succeeded" })];
	const first = start(successSteps);
	const success = routeAdaptiveChain(successSteps, limits, JSON.parse(JSON.stringify(first.state)), { outcome: "succeeded", changed: false });
	assert.deepEqual(success.state.trace, [
		{ stepId: "check", disposition: "selected", observation: { outcome: "succeeded", changed: false } },
		{ stepId: "changed", disposition: "skipped" },
		{ stepId: "success", disposition: "selected" },
	]);
	assert.equal(routeAdaptiveChain(successSteps, limits, JSON.parse(JSON.stringify(success.state)), { outcome: "succeeded", changed: false }).state.status, "completed");
	const failureSteps = [run("check", { onFailure: "fix" }), prompt("unused"), prompt("fix")];
	const check = start(failureSteps);
	assert.equal(routeAdaptiveChain(failureSteps, limits, JSON.parse(JSON.stringify(check.state)), { outcome: "failed", changed: true }).action?.step.id, "fix");
});

test("terminates cleanly at natural chain completion and rejects impossible progress", () => {
	const steps = [run("only")];
	const first = start(steps);
	const done = routeAdaptiveChain(steps, limits, first.state, { outcome: "succeeded", changed: false });
	assert.equal(done.action, null);
	assert.equal(done.state.status, "completed");
	assert.equal(done.decisions[0].reason, "chain-complete");
	assert.throws(() => routeAdaptiveChain(steps, limits, done.state, { outcome: "succeeded", changed: false }), /impossible progress/i);
});
