import test from "node:test";
import assert from "node:assert/strict";
import { normalizeChainOutcome, parseChainDeclaration, parseChainSteps } from "../chain-parser.ts";

test("parseChainDeclaration keeps the first valid per-step --loop and strips repeated loop tokens", () => {
	const parsed = parseChainDeclaration("worker --loop 2 --loop 3");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: [], loopCount: 2 }]);
});

test("parseChainDeclaration strips invalid loop tokens when a later valid loop exists", () => {
	const parsed = parseChainDeclaration("worker --loop 1000 --loop 2");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: [], loopCount: 2 }]);
});

test("parseChainDeclaration keeps quoted --loop tokens as step args", () => {
	const parsed = parseChainDeclaration('worker "--loop" "2"');
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: ["--loop", "2"], loopCount: undefined }]);
});

test("parseChainDeclaration parses parallel() groups into parallel steps", () => {
	const parsed = parseChainDeclaration("parallel(scan-fe, scan-be) -> review");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [
		{
			parallel: [
				{ name: "scan-fe", args: [], loopCount: undefined },
				{ name: "scan-be", args: [], loopCount: undefined },
			],
		},
		{ name: "review", args: [], loopCount: undefined },
	]);
});

test("parseChainDeclaration rejects empty parallel() groups", () => {
	const parsed = parseChainDeclaration("parallel() -> review");
	assert.deepEqual(parsed.steps, [{ name: "review", args: [], loopCount: undefined }]);
	assert.deepEqual(parsed.invalidSegments, ["parallel()"]);
});

test("parseChainDeclaration rejects nested parallel() groups", () => {
	const parsed = parseChainDeclaration("parallel(scan-fe, parallel(scan-be, scan-infra)) -> review");
	assert.deepEqual(parsed.steps, [{ name: "review", args: [], loopCount: undefined }]);
	assert.deepEqual(parsed.invalidSegments, ["parallel(scan-fe, parallel(scan-be, scan-infra))"]);
});

test("parseChainSteps splits chain separators outside parallel() groups", () => {
	const parsed = parseChainSteps("parallel(scan-fe --loop 2, scan-be) -> review -- --global --flag");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [
		{
			parallel: [
				{ name: "scan-fe", args: [], loopCount: 2 },
				{ name: "scan-be", args: [], loopCount: undefined },
			],
		},
		{ name: "review", args: [], loopCount: undefined },
	]);
	assert.deepEqual(parsed.sharedArgs, ["--global", "--flag"]);
});

test("parseChainDeclaration parses and strips per-step --with-context", () => {
	const parsed = parseChainDeclaration("worker --with-context");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: [], loopCount: undefined, withContext: true }]);
});

test("parseChainDeclaration strips repeated --with-context tokens", () => {
	const parsed = parseChainDeclaration("worker --with-context --with-context");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: [], loopCount: undefined, withContext: true }]);
});

test("parseChainDeclaration keeps quoted --with-context as a step arg", () => {
	const parsed = parseChainDeclaration('worker "--with-context"');
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: ["--with-context"], loopCount: undefined }]);
});

test("parseChainDeclaration supports --with-context with per-step --loop", () => {
	const parsed = parseChainDeclaration("worker --with-context --loop 2");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: [], loopCount: 2, withContext: true }]);
});

test("parseChainDeclaration treats bare --loop as unlimited per-step loop", () => {
	const parsed = parseChainDeclaration("double-check --loop -> deslop");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [
		{ name: "double-check", args: [], loopCount: null },
		{ name: "deslop", args: [], loopCount: undefined },
	]);
});

test("parseChainDeclaration treats bare --loop with non-numeric next token as unlimited", () => {
	const parsed = parseChainDeclaration("worker --loop --with-context");
	assert.deepEqual(parsed.invalidSegments, []);
	assert.deepEqual(parsed.steps, [{ name: "worker", args: [], loopCount: null, withContext: true }]);
});

test("parseChainDeclaration normalizes structured prompt and run steps with finite limits", () => {
	assert.deepEqual(parseChainDeclaration([{ prompt: "only" }]), {
		steps: [{ id: "only", kind: "prompt", target: "only", when: "always" }],
		limits: { maxSteps: 10, maxModelCalls: 5 }, invalidSegments: [],
	});
	assert.deepEqual(parseChainDeclaration([{ prompt: "implement" }, { run: "npm test", onFailure: "fix-tests" }, { prompt: "fix-tests", when: "failed" }, { prompt: "review", when: "changed" }], { maxSteps: 5, maxModelCalls: 3 }), {
		steps: [{ id: "implement", kind: "prompt", target: "implement", when: "always" }, { id: "npm test", kind: "run", target: "npm test", when: "always", onFailure: "fix-tests" }, { id: "fix-tests", kind: "prompt", target: "fix-tests", when: "failed" }, { id: "review", kind: "prompt", target: "review", when: "changed" }],
		limits: { maxSteps: 5, maxModelCalls: 3 }, invalidSegments: [],
	});
});

test("normalizes only the four bounded chain outcomes", () => {
	for (const outcome of ["succeeded", "failed", "blocked", "skipped"] as const) assert.equal(normalizeChainOutcome(outcome), outcome);
	for (const invalid of ["success", "failure", "changed", "", undefined]) assert.equal(normalizeChainOutcome(invalid), undefined);
});

test("parseChainDeclaration rejects invalid structured declarations visibly", () => {
	const cases: Array<[unknown, unknown, RegExp]> = [
		[[{ prompt: "a", when: "maybe" }], undefined, /unknown gate/i],
		[[{ prompt: "a", when: null }], undefined, /unknown gate/i],
		[[{ prompt: "a", onSkipped: "b" }, { prompt: "b" }], undefined, /unknown outcome/i],
		[[{ when: "always" }], undefined, /exactly one of prompt or run/i],
		[[{ prompt: "a", run: "echo a" }], undefined, /exactly one of prompt or run/i],
		[[{ prompt: "a", onSuccess: "missing" }], undefined, /unknown target/i],
		[[{ prompt: "a", onSuccess: "a" }], undefined, /self-transition/i],
		[[{ prompt: "a", onSuccess: "b" }, { prompt: "b", onSuccess: "a" }], undefined, /cycle/i],
		[[{ prompt: "a" }], { maxSteps: 0 }, /maxSteps/i],
		[[{ prompt: "a" }], { maxSteps: null }, /maxSteps/i],
		[[{ prompt: "a" }], { maxModelCalls: Infinity }, /maxModelCalls/i],
		[[{ prompt: "a" }], { maxModelCalls: null }, /maxModelCalls/i],
		[[{ prompt: "a" }], { maxSteps: 101 }, /maxSteps/i],
		[[{ prompt: "a", onSuccess: "c", onFailure: "c", onBlocked: "c" }, { prompt: "b" }, { prompt: "c" }], undefined, /unreachable.*b/i],
	];
	for (const [chain, limits, expected] of cases) {
		const parsed = parseChainDeclaration(chain as never, limits as never);
		assert.equal(parsed.steps.length, 0);
		assert.match(parsed.invalidSegments.join("\n"), expected);
	}
});

test("gated structured steps retain their skip fallthrough with explicit outcome transitions", () => {
	const parsed = parseChainDeclaration([
		{ prompt: "gate", when: "changed", onSuccess: "done", onFailure: "done", onBlocked: "done" },
		{ prompt: "skipped-path" },
		{ prompt: "done" },
	]);
	assert.deepEqual(parsed.invalidSegments, []);
	assert.equal(parsed.steps.length, 3);
});

test("gated skip fallthrough participates in structured-chain cycle detection", () => {
	const parsed = parseChainDeclaration([
		{ prompt: "gate", when: "changed", onSuccess: "done", onFailure: "done", onBlocked: "done" },
		{ prompt: "skipped-path", onSuccess: "gate" },
		{ prompt: "done" },
	]);
	assert.equal(parsed.steps.length, 0);
	assert.match(parsed.invalidSegments.join("\n"), /cycle/i);
});

test("structured chain declaration size is rejected before step traversal", () => {
	const parsed = parseChainDeclaration(Array.from({ length: 101 }, () => null));
	assert.equal(parsed.steps.length, 0);
	assert.match(parsed.invalidSegments.join("\n"), /no more than 100 declared steps/i);
});

test("structured chain defaults and failures do not expose shared mutable limit aliases", () => {
	const first = parseChainDeclaration([{ prompt: "first" }]);
	(first.limits as { maxSteps: number }).maxSteps = 1;
	assert.deepEqual(parseChainDeclaration([{ prompt: "second" }]).limits, { maxSteps: 10, maxModelCalls: 5 });
	const failure = parseChainDeclaration([]);
	(failure.limits as { maxSteps: number }).maxSteps = 2;
	assert.deepEqual(parseChainDeclaration([]).limits, { maxSteps: 10, maxModelCalls: 5 });
});
