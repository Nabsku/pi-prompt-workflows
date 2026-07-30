import test from "node:test";
import assert from "node:assert/strict";
import { AdaptiveChainCancelledError, executeAdaptiveChain, type AdaptiveRuntimeTraceEntry } from "../adaptive-runtime.ts";
import type { StructuredChainStep } from "../chain-parser.ts";
import type { GitWorktreeSnapshot } from "../git-worktree-snapshot.ts";
import { isAdaptivePromptTarget, isAdaptiveRunTarget } from "../adaptive-preflight.ts";
import type { PromptWithModel } from "../prompt-loader.ts";

const prompt = (target: string, extra: Partial<StructuredChainStep> = {}): StructuredChainStep => ({ id: target, kind: "prompt", target, when: "always", ...extra });
const run = (target: string, extra: Partial<StructuredChainStep> = {}): StructuredChainStep => ({ id: target, kind: "run", target, when: "always", ...extra });
const snapshot = (value: number) => ({ value }) as unknown as GitWorktreeSnapshot;

function harness(steps: StructuredChainStep[], outcomes: Record<string, "succeeded" | "failed" | "blocked">, changes: Record<string, boolean> = {}) {
	const calls: string[] = [];
	let snapshotValue = 0;
	return {
		calls,
		run: () => executeAdaptiveChain({ steps, limits: { maxSteps: 10, maxModelCalls: 5 } }, {
			resolvePrompt: (target) => target.startsWith("missing") ? undefined : target,
			resolveRun: (target) => target.startsWith("missing") ? undefined : target,
			resolveSnapshotCwd: () => "/repo",
			async executePrompt(target) { calls.push(`prompt:${target}`); snapshotValue += changes[target] ? 1 : 0; const status = outcomes[target] ?? "succeeded"; return status === "succeeded" ? { status, result: target } : { status, error: target }; },
			async executeRun(target) { calls.push(`run:${target}`); snapshotValue += changes[target] ? 1 : 0; const status = outcomes[target] ?? "succeeded"; return status === "succeeded" ? { status, result: target } : { status, error: target }; },
			captureSnapshot: () => snapshot(snapshotValue),
			compareSnapshots: (before, after) => ({ changed: (before as any).value !== (after as any).value }),
		}),
	};
}

test("executes mixed prompt/run chains and reports structured outcomes", async () => {
	const h = harness([prompt("build"), run("test")], { build: "succeeded", test: "failed" }, { build: true });
	const report = await h.run();
	assert.deepEqual(h.calls, ["prompt:build", "run:test"]);
	assert.deepEqual(report.actions.map(({ stepId, outcome, changed }) => ({ stepId, outcome, changed })), [
		{ stepId: "build", outcome: "succeeded", changed: true },
		{ stepId: "test", outcome: "failed", changed: false },
	]);
	assert.equal(report.state.status, "completed");
});

test("routes failure and blocked outcomes without inferring from output", async () => {
	for (const [status, transition, expected] of [["failed", "onFailure", "fix"], ["blocked", "onBlocked", "explain"]] as const) {
		const first = run("check", { [transition]: expected });
		const h = harness([first, prompt("unused"), prompt("fix"), prompt("explain")], { check: status });
		await h.run();
		assert.deepEqual(h.calls.slice(0, 2), ["run:check", `prompt:${expected}`]);
	}
});

test("changed gates skip with zero execution and snapshots", async () => {
	const h = harness([run("check"), prompt("changed", { when: "changed" }), run("finish")], {}, {});
	const report = await h.run();
	assert.deepEqual(h.calls, ["run:check", "run:finish"]);
	assert.equal(report.state.modelCalls, 0);
	assert.ok(report.decisions.some((decision) => decision.selectedTarget === "changed" && decision.reason === "gate-not-matched"));
});

test("fails closed before side effects for missing targets and snapshot failures", async () => {
	const missing = harness([prompt("missing-target")], {});
	await assert.rejects(missing.run(), /missing or mismatched/);
	assert.deepEqual(missing.calls, []);

	let executed = false;
	await assert.rejects(executeAdaptiveChain({ steps: [run("x")], limits: { maxSteps: 1, maxModelCalls: 1 } }, {
		resolvePrompt: () => undefined,
		resolveRun: () => "x",
		resolveSnapshotCwd: () => "/repo",
		executePrompt: async () => ({ status: "succeeded", result: undefined }),
		executeRun: async () => { executed = true; return { status: "succeeded", result: undefined }; },
		captureSnapshot: () => { throw new Error("snapshot unavailable"); },
		compareSnapshots: () => ({ changed: false }),
	}), /snapshot unavailable/);
	assert.equal(executed, false);
});

test("fresh adaptive resolution rejects targets mutated after preflight before side effects", async () => {
	for (const kind of ["prompt", "run"] as const) {
		let current = (kind === "prompt"
			? { name: "target", content: "safe" }
			: { name: "target", content: "", deterministic: { handoff: "never" } }) as PromptWithModel;
		assert.equal(kind === "prompt" ? isAdaptivePromptTarget(current) : isAdaptiveRunTarget(current), true);
		current = (kind === "prompt"
			? { ...current, subagent: "worker" }
			: { ...current, deterministic: { ...current.deterministic!, handoff: "always" } }) as PromptWithModel;
		let dispatched = false;
		await assert.rejects(executeAdaptiveChain({ steps: [kind === "prompt" ? prompt("target") : run("target")], limits: { maxSteps: 1, maxModelCalls: 1 } }, {
			resolvePrompt: () => isAdaptivePromptTarget(current) ? current : undefined,
			resolveRun: () => isAdaptiveRunTarget(current) ? current : undefined,
			resolveSnapshotCwd: () => "/repo",
			executePrompt: async () => { dispatched = true; return { status: "succeeded", result: undefined }; },
			executeRun: async () => { dispatched = true; return { status: "succeeded", result: undefined }; },
			captureSnapshot: () => snapshot(0), compareSnapshots: () => ({ changed: false }),
		}), /missing or mismatched/);
		assert.equal(dispatched, false);
	}
});

test("enforces model and step limits before the next action", async () => {
	const modelLimited = harness([prompt("one"), prompt("two")], {});
	await assert.rejects(executeAdaptiveChain({ steps: [prompt("one"), prompt("two")], limits: { maxSteps: 2, maxModelCalls: 1 } }, {
		resolvePrompt: (x) => x, resolveRun: (x) => x,
		resolveSnapshotCwd: () => "/repo",
		executePrompt: async (x) => { modelLimited.calls.push(String(x)); return { status: "succeeded", result: x }; },
		executeRun: async (x) => ({ status: "succeeded", result: x }),
		captureSnapshot: () => snapshot(0), compareSnapshots: () => ({ changed: false }),
	}), /maxModelCalls exhausted/);
	assert.deepEqual(modelLimited.calls, ["one"]);
});

for (const [name, abortAt, executorStatus] of [
	["during execution after a successful result", "execution", "succeeded"],
	["during the cleanup snapshot after a successful result", "snapshot", "succeeded"],
	["during comparison after a successful result", "comparison", "succeeded"],
	["during execution after a failed result", "execution", "failed"],
] as const) {
	test(`cancellation ${name} records the current action failed and never routes`, async () => {
		const controller = new AbortController();
		const calls: string[] = [];
		let snapshots = 0;
		const first = run("cancelled", { onFailure: "must-not-run" });
		await assert.rejects(executeAdaptiveChain({ steps: [first, prompt("must-not-run")], limits: { maxSteps: 2, maxModelCalls: 1 } }, {
			signal: controller.signal,
			resolvePrompt: (target) => target,
			resolveRun: (target) => target,
			resolveSnapshotCwd: () => "/repo",
			executePrompt: async (target) => { calls.push(`prompt:${target}`); return { status: "succeeded", result: target }; },
			executeRun: async (target) => {
				calls.push(`run:${target}`);
				if (abortAt === "execution") controller.abort();
				return executorStatus === "succeeded"
					? { status: "succeeded", result: target }
					: { status: "failed", error: new Error("cancelled") };
			},
			captureSnapshot: () => {
				snapshots += 1;
				if (abortAt === "snapshot" && snapshots === 2) controller.abort();
				return snapshot(snapshots);
			},
			compareSnapshots: () => {
				if (abortAt === "comparison") controller.abort();
				return { changed: true };
			},
		}), (error: unknown) => {
			assert.ok(error instanceof AdaptiveChainCancelledError);
			assert.deepEqual(error.report.actions.map(({ target, outcome, changed }) => ({ target, outcome, changed })), [
				{ target: "cancelled", outcome: "failed", changed: true },
			]);
			return true;
		});
		assert.deepEqual(calls, ["run:cancelled"]);
		assert.equal(snapshots, 2);
	});
}

test("completed and cancelled reports are detached and deeply frozen", async () => {
	const completed = await harness([prompt("one")], {}).run();
	assert.ok(Object.isFrozen(completed));
	assert.ok(Object.isFrozen(completed.state));
	assert.ok(Object.isFrozen(completed.state.trace));
	assert.ok(Object.isFrozen(completed.decisions));
	assert.ok(Object.isFrozen(completed.actions));
	assert.throws(() => (completed.actions as AdaptiveRuntimeTraceEntry[]).push({} as AdaptiveRuntimeTraceEntry), TypeError);
	assert.equal(completed.actions.length, 1);

	const controller = new AbortController();
	await assert.rejects(executeAdaptiveChain({ steps: [run("cancel")], limits: { maxSteps: 1, maxModelCalls: 1 } }, {
		signal: controller.signal,
		resolvePrompt: (target) => target,
		resolveRun: (target) => target,
		resolveSnapshotCwd: () => "/repo",
		executePrompt: async () => ({ status: "succeeded", result: undefined }),
		executeRun: async () => { controller.abort(); return { status: "succeeded", result: undefined }; },
		captureSnapshot: () => snapshot(0),
		compareSnapshots: () => ({ changed: false }),
	}), (error: unknown) => {
		assert.ok(error instanceof AdaptiveChainCancelledError);
		assert.ok(Object.isFrozen(error.report.state.trace));
		assert.throws(() => (error.report.state.trace as any[]).push({}), TypeError);
		assert.equal(error.report.actions[0]?.outcome, "failed");
		return true;
	});
});

test("resolves one action cwd once and snapshots before/after at that exact cwd", async () => {
	const seen: string[] = [];
	let resolves = 0;
	await executeAdaptiveChain({ steps: [run("check")], limits: { maxSteps: 1, maxModelCalls: 1 } }, {
		resolvePrompt: () => undefined,
		resolveRun: () => ({ cwd: "/target" }),
		resolveSnapshotCwd: (_step, target) => { resolves++; return (target as { cwd: string }).cwd; },
		executePrompt: async () => ({ status: "succeeded", result: undefined }),
		executeRun: async () => ({ status: "succeeded", result: undefined }),
		captureSnapshot: (_step, cwd) => { seen.push(cwd); return snapshot(seen.length); },
		compareSnapshots: () => ({ changed: true }),
	});
	assert.equal(resolves, 1);
	assert.deepEqual(seen, ["/target", "/target"]);
});
