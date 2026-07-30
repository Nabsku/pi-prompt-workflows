import test from "node:test";
import assert from "node:assert/strict";
import { createAdaptivePreflight, formatAdaptivePreflight, MAX_ADAPTIVE_PREFLIGHT_STATES, prepareAdaptivePreflight } from "../adaptive-preflight.ts";
import { formatAdaptiveDecision, formatAdaptiveRuntimeReport } from "../adaptive-renderer.ts";
import type { PromptWithModel } from "../prompt-loader.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { estimatePromptTokens } from "../prompt-budget.ts";

function prompt(name: string, extra: Partial<PromptWithModel> = {}): PromptWithModel {
	return { name, description: `${name} description`, content: "body", models: ["test/model"], restore: false, source: "user", rootKind: "prompt", filePath: `/tmp/${name}.md`, ...extra } as PromptWithModel;
}

test("adaptive preflight renders deterministic graph and bounded prompt calls", () => {
	const wrapper = prompt("flow", { adaptiveChain: { limits: { maxSteps: 3, maxModelCalls: 2 }, steps: [
		{ id: "inspect", kind: "run", target: "run", when: "always", onFailure: "fix" },
		{ id: "fix", kind: "prompt", target: "fix", when: "changed" },
		{ id: "verify", kind: "prompt", target: "verify", when: "always" },
	] } });
	const catalog = new Map([["run", prompt("run", { deterministic: { execution: { kind: "run", command: "npm test" }, handoff: "never", nonInteractive: true } })], ["fix", prompt("fix")], ["verify", prompt("verify")]]);
	const result = createAdaptivePreflight(wrapper, catalog, "/repo");
	assert.equal(result.status, "ready");
	assert.deepEqual(result.callBounds, { minimum: 1, maximum: 2, exact: false, explanation: result.callBounds.explanation });
	const rendered = formatAdaptivePreflight(result);
	assert.match(rendered, /1\. inspect \[run\]/);
	assert.match(rendered, /onFailure=fix/);
	assert.match(rendered, /gate=changed/);
	assert.match(rendered, /maxSteps=3, maxModelCalls=2/);
});

test("adaptive preflight sanitizes natural fallthrough IDs and distinguishes a real end step", () => {
	const wrapper = prompt("flow", { adaptiveChain: { limits: { maxSteps: 3, maxModelCalls: 3 }, steps: [
		{ id: "first", kind: "prompt", target: "first", when: "always", onSuccess: "end" },
		{ id: "next\n- forged diagnostic", kind: "prompt", target: "second", when: "always" },
		{ id: "end", kind: "prompt", target: "third", when: "always" },
	] } });
	const result = createAdaptivePreflight(wrapper, new Map([["first", prompt("first")], ["second", prompt("second")], ["third", prompt("third")]]), "/repo");
	const rendered = formatAdaptivePreflight(result);
	assert.match(rendered, /fallthrough=next\\n- forged diagnostic/);
	assert.match(rendered, /onSuccess=end;/);
	assert.doesNotMatch(rendered, /onSuccess=terminal/);
	assert.equal(rendered.split("\n").filter((line) => line.startsWith("- forged diagnostic")).length, 0);
});

test("adaptive preflight accumulates post-render prompt-token estimates across dynamic branches", async () => {
	const wrapper = prompt("flow", { adaptiveChain: { limits: { maxSteps: 2, maxModelCalls: 2 }, steps: [
		{ id: "first", kind: "prompt", target: "first", when: "always", onFailure: "end" },
		{ id: "second", kind: "prompt", target: "second", when: "always" },
	] } });
	const catalog = new Map([["first", prompt("first", { content: "Hello $1" })], ["second", prompt("second", { content: "12345678" })]]);
	const model = { provider: "test", id: "model" } as any;
	const result = await prepareAdaptivePreflight(wrapper, catalog, { cwd: "/repo", args: ["world"], currentModel: model, modelRegistry: { find: () => model, getAll: () => [model], getAvailable: () => [model] } as any });
	assert.deepEqual(result.targets.map((target) => target.promptCost?.estimatedTokens), [3, 2]);
	assert.deepEqual({ min: result.promptCostBounds.minimumCompleting, max: result.promptCostBounds.maximumCompleting, reachable: result.promptCostBounds.maximumReachable, initial: result.promptCostBounds.initialFallthrough }, { min: 3, max: 5, reachable: 5, initial: 5 });
	assert.match(formatAdaptivePreflight(result), /Prompt-token bounds: completing min=3, completing max=5, reachable max=5/);
});

test("adaptive initial token path follows the runtime router with succeeded unchanged observations", async () => {
	const wrapper = prompt("flow", { adaptiveChain: { limits: { maxSteps: 2, maxModelCalls: 2 }, steps: [
		{ id: "jump", kind: "prompt", target: "jump", when: "always", onSuccess: "gate-1" },
		{ id: "sequential", kind: "prompt", target: "sequential", when: "always" },
		{ id: "gate-1", kind: "run", target: "run", when: "changed" },
		{ id: "gate-2", kind: "run", target: "run", when: "failed" },
		{ id: "selected", kind: "prompt", target: "selected", when: "always" },
	] } });
	const run = prompt("run", { deterministic: { execution: { kind: "run", command: "true" }, handoff: "never", nonInteractive: true } });
	const catalog = new Map([["jump", prompt("jump", { content: "1111" })], ["sequential", prompt("sequential", { content: "22222222" })], ["run", run], ["selected", prompt("selected", { content: "333333333333" })]]);
	const model = { provider: "test", id: "model" } as any;
	const result = await prepareAdaptivePreflight(wrapper, catalog, { cwd: "/repo", args: [], currentModel: model, modelRegistry: { find: () => model, getAll: () => [model], getAvailable: () => [model] } as any });
	assert.equal(result.promptCostBounds.initialFallthrough, 4);
	assert.equal(result.promptCostBounds.initialPathStatus, "completed");
	assert.match(result.promptCostBounds.explanation, /succeeded \+ changed=false/);
});

test("adaptive initial token path labels baseline limit exhaustion", async () => {
	const wrapper = prompt("flow", { adaptiveChain: { limits: { maxSteps: 1, maxModelCalls: 1 }, steps: [
		{ id: "first", kind: "prompt", target: "first", when: "always" },
		{ id: "second", kind: "prompt", target: "second", when: "always" },
	] } });
	const catalog = new Map([["first", prompt("first", { content: "1111" })], ["second", prompt("second", { content: "2222" })]]);
	const model = { provider: "test", id: "model" } as any;
	const result = await prepareAdaptivePreflight(wrapper, catalog, { cwd: "/repo", args: [], currentModel: model, modelRegistry: { find: () => model, getAll: () => [model], getAvailable: () => [model] } as any });
	assert.equal(result.promptCostBounds.initialFallthrough, 1);
	assert.equal(result.promptCostBounds.initialPathStatus, "exhausted");
	assert.match(formatAdaptivePreflight(result), /initial baseline=1 .*exhausted/);
});

test("adaptive preflight fails closed for missing, kind mismatch and multi-call target", () => {
	const wrapper = prompt("flow", { adaptiveChain: { limits: { maxSteps: 3, maxModelCalls: 3 }, steps: [
		{ id: "a", kind: "prompt", target: "missing", when: "always" },
		{ id: "b", kind: "run", target: "plain", when: "always" },
		{ id: "c", kind: "prompt", target: "multi", when: "always" },
	] } });
	const result = createAdaptivePreflight(wrapper, new Map([["plain", prompt("plain")], ["multi", prompt("multi", { parallel: 2 })]]), "/repo");
	assert.equal(result.status, "blocked");
	assert.match(result.diagnostics.join("\n"), /Missing prompt target/);
	assert.match(result.diagnostics.join("\n"), /Kind mismatch/);
	assert.match(result.diagnostics.join("\n"), /multiple top-level model calls/);
});

test("adaptive preflight bounds adversarial branching by deterministic state count", () => {
	const steps = Array.from({ length: 128 }, (_, index) => ({ id: `step-${index}`, kind: "prompt" as const, target: "target", when: "always" as const, onFailure: index + 2 < 128 ? `step-${index + 2}` : undefined }));
	const wrapper = prompt("branching", { adaptiveChain: { limits: { maxSteps: 128, maxModelCalls: 128 }, steps } });
	const started = performance.now();
	const result = createAdaptivePreflight(wrapper, new Map([["target", prompt("target")]]), "/repo");
	assert.equal(result.status, "blocked");
	assert.equal(result.analysis.complete, false);
	assert.ok(result.analysis.analyzedStates <= MAX_ADAPTIVE_PREFLIGHT_STATES);
	assert.equal(result.analysis.enqueuedStates, MAX_ADAPTIVE_PREFLIGHT_STATES);
	assert.equal(result.callBounds.exact, false);
	assert.equal(result.promptCostBounds.exact, false);
	assert.match(result.callBounds.explanation, /Unavailable.*conservative/);
	assert.deepEqual(result.diagnostics, [`analysis inconclusive: state limit ${MAX_ADAPTIVE_PREFLIGHT_STATES} exceeded`]);
	assert.ok(performance.now() - started < 2_000);
	const rendered = formatAdaptivePreflight(result);
	assert.match(rendered, /inconclusive/);
	assert.match(rendered, /runtime revalidates them before execution/);
	assert.doesNotMatch(rendered, /\u001b|\r/);
});

test("adaptive preflight tracks the then-active model across prompt steps", async () => {
	const wrapper = prompt("flow", { adaptiveChain: { limits: { maxSteps: 2, maxModelCalls: 2 }, steps: [
		{ id: "switch", kind: "prompt", target: "switch", when: "always" },
		{ id: "preserve", kind: "prompt", target: "preserve", when: "always" },
	] } });
	const catalog = new Map([
		["switch", prompt("switch", { models: ["test/b"], content: "BBBB" })],
		["preserve", prompt("preserve", { models: ["test/a", "test/b"], content: "<if-model is=\"test/a\">A</if-model><if-model is=\"test/b\">BBBBBBBB</if-model>" })],
	]);
	const a = { provider: "test", id: "a" } as any, b = { provider: "test", id: "b" } as any;
	const registry = { find: (provider: string, id: string) => [a, b].find((model) => model.provider === provider && model.id === id), getAll: () => [a, b], getAvailable: () => [a, b] } as any;
	const result = await prepareAdaptivePreflight(wrapper, catalog, { cwd: "/repo", args: [], currentModel: a, modelRegistry: registry });
	assert.equal(result.promptCostBounds.initialFallthrough, 3, "switch cost 1 + B-rendered preserve cost 2");
});

test("adaptive preflight blocks only reachable target/model render pairs", async () => {
	const wrapper = prompt("flow", { adaptiveChain: { limits: { maxSteps: 2, maxModelCalls: 2 }, steps: [
		{ id: "switch", kind: "prompt", target: "switch", when: "always" },
		{ id: "later", kind: "prompt", target: "later", when: "always" },
	] } });
	const catalog = new Map([
		["switch", prompt("switch", { models: ["test/b"], content: "BBBB" })],
		["later", prompt("later", { models: ["test/a", "test/b"], budget: { minTokens: 1, maxTokens: 2 }, content: "<if-model is=\"test/a\"></if-model><if-model is=\"test/b\">BBBB</if-model>" })],
	]);
	const a = { provider: "test", id: "a" } as any, b = { provider: "test", id: "b" } as any;
	const registry = { find: (provider: string, id: string) => [a, b].find((model) => model.provider === provider && model.id === id), getAll: () => [a, b], getAvailable: () => [a, b] } as any;
	const result = await prepareAdaptivePreflight(wrapper, catalog, { cwd: "/repo", args: [], currentModel: a, modelRegistry: registry });
	assert.equal(result.status, "ready", result.diagnostics.join("\n"));
	assert.equal(result.promptCostBounds.initialFallthrough, 2);
});

test("adaptive preflight reports sanitized deduplicated warnings from reachable prepared routes", async () => {
	const wrapper = prompt("flow", { adaptiveChain: { limits: { maxSteps: 2, maxModelCalls: 2 }, steps: [
		{ id: "switch", kind: "prompt", target: "switch", when: "always" },
		{ id: "later", kind: "prompt", target: "later", when: "always" },
	] } });
	const catalog = new Map([
		["switch", prompt("switch", { models: ["test/b"], content: "switch" })],
		["later", prompt("later", { models: ["test/a", "test/b"], content: "body <else extra=\"bad\">" })],
	]);
	const a = { provider: "test", id: "a" } as any, b = { provider: "test", id: "b" } as any;
	const registry = { find: (provider: string, id: string) => [a, b].find((model) => model.provider === provider && model.id === id), getAll: () => [a, b], getAvailable: () => [a, b] } as any;
	const result = await prepareAdaptivePreflight(wrapper, catalog, { cwd: "/repo", args: [], currentModel: a, modelRegistry: registry });
	assert.equal(result.status, "ready", result.diagnostics.join("\n"));
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0]!, /<else>/i);
	assert.match(formatAdaptivePreflight(result), /Preflight warnings/);
});

test("adaptive preflight reports route-specific budget warnings only for reachable prepared routes", async () => {
	const wrapper = prompt("flow", { adaptiveChain: { limits: { maxSteps: 2, maxModelCalls: 2 }, steps: [
		{ id: "switch", kind: "prompt", target: "switch", when: "always" },
		{ id: "later", kind: "prompt", target: "later", when: "always" },
	] } });
	const catalog = new Map([
		["switch", prompt("switch", { models: ["test/b"], content: "switch" })],
		["later", prompt("later", { models: ["test/a", "test/b"], budget: { warnTokens: 2 }, content: "<if-model is=\"test/a\">ok</if-model><if-model is=\"test/b\">BBBBBBBBBBBB</if-model>" })],
	]);
	const a = { provider: "test", id: "a" } as any, b = { provider: "test", id: "b" } as any;
	const registry = { find: (provider: string, id: string) => [a, b].find((model) => model.provider === provider && model.id === id), getAll: () => [a, b], getAvailable: () => [a, b] } as any;
	const result = await prepareAdaptivePreflight(wrapper, catalog, { cwd: "/repo", args: [], currentModel: a, modelRegistry: registry });
	assert.equal(result.targets[1]!.budgetVerdict, "ok", "chain-start A summary remains below warning threshold");
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0]!, /warning threshold/i);
});

test("adaptive preflight includes selectable models beyond the first 64 registry entries", async () => {
	const models = Array.from({ length: 70 }, (_, id) => ({ provider: "test", id: `m${id}` })) as any[];
	const wrapper = prompt("flow", { adaptiveChain: { limits: { maxSteps: 1, maxModelCalls: 1 }, steps: [{ id: "late", kind: "prompt", target: "late", when: "always" }] } });
	const catalog = new Map([["late", prompt("late", { models: ["test/m69"], content: "<if-model is=\"test/m69\">LATE</if-model>" })]]);
	const registry = { find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id), getAll: () => models, getAvailable: () => models } as any;
	const result = await prepareAdaptivePreflight(wrapper, catalog, { cwd: "/repo", args: [], currentModel: models[0], modelRegistry: registry });
	assert.equal(result.status, "ready", result.diagnostics.join("\n"));
	assert.equal(result.targets[0]!.effectiveModel, "test/m69");
	assert.equal(result.promptCostBounds.initialFallthrough, 1);
});

test("adaptive preflight restores the chain-start model for model-less targets", async () => {
	const wrapper = prompt("flow", { adaptiveChain: { limits: { maxSteps: 2, maxModelCalls: 2 }, steps: [
		{ id: "switch", kind: "prompt", target: "switch", when: "always" },
		{ id: "inherit-start", kind: "prompt", target: "inherit-start", when: "always" },
	] } });
	const catalog = new Map([
		["switch", prompt("switch", { models: ["test/b"], content: "BBBB" })],
		["inherit-start", prompt("inherit-start", { models: [], content: "<if-model is=\"test/a\">AAAA</if-model><if-model is=\"test/b\">BBBBBBBBBBBB</if-model>" })],
	]);
	const a = { provider: "test", id: "a" } as any, b = { provider: "test", id: "b" } as any;
	const registry = { find: (provider: string, id: string) => [a, b].find((model) => model.provider === provider && model.id === id), getAll: () => [a, b], getAvailable: () => [a, b] } as any;
	const result = await prepareAdaptivePreflight(wrapper, catalog, { cwd: "/repo", args: [], currentModel: a, modelRegistry: registry });
	assert.equal(result.targets[1]!.effectiveModel, "test/a", "summary uses the saved chain-start model");
	assert.equal(result.targets[1]!.promptCost!.estimatedTokens, 1, "summary renders the A conditional");
	assert.equal(result.promptCostBounds.initialFallthrough, 2, "exact route uses switch cost 1 + model-less A cost 1");
	assert.equal(result.promptCostBounds.minimumCompleting, 2);
	assert.equal(result.promptCostBounds.maximumCompleting, 2);
});

test("adaptive prompt bounds include the separately injected resolved skill payload without changing body budget", async () => {
	const root = mkdtempSync(join(tmpdir(), "adaptive-skill-")); const skillPath = join(root, "SKILL.md");
	writeFileSync(skillPath, "x".repeat(400));
	const wrapper = prompt("flow", { adaptiveChain: { limits: { maxSteps: 1, maxModelCalls: 1 }, steps: [{ id: "skilled", kind: "prompt", target: "skilled", when: "always" }] } });
	const catalog = new Map([["skilled", prompt("skilled", { content: "body", skills: ["large"], budget: { maxTokens: 2 } })]]);
	const model = { provider: "test", id: "model" } as any;
	const result = await prepareAdaptivePreflight(wrapper, catalog, { cwd: root, args: [], currentModel: model, modelRegistry: { find: () => model, getAll: () => [model], getAvailable: () => [model] } as any, commands: [{ name: "large", source: "skill", sourceInfo: { path: skillPath } }] });
	assert.equal(result.status, "ready");
	assert.equal(result.targets[0]!.promptCost!.estimatedTokens, 1);
	assert.ok(result.targets[0]!.skillPromptCost!.estimatedTokens > 100);
	assert.equal(result.promptCostBounds.initialFallthrough, result.targets[0]!.promptCost!.estimatedTokens + result.targets[0]!.skillPromptCost!.estimatedTokens);
});

test("adaptive bounds retain skill cost when the chain-start rendering is empty but a switched-model route is valid", async () => {
	const root = mkdtempSync(join(tmpdir(), "adaptive-empty-skill-")); const skillPath = join(root, "SKILL.md");
	writeFileSync(skillPath, "x".repeat(400));
	const wrapper = prompt("flow", { adaptiveChain: { limits: { maxSteps: 2, maxModelCalls: 2 }, steps: [
		{ id: "switch", kind: "prompt", target: "switch", when: "always" },
		{ id: "skilled", kind: "prompt", target: "skilled", when: "always" },
	] } });
	const catalog = new Map([
		["switch", prompt("switch", { models: ["test/b"], content: "switch" })],
		["skilled", prompt("skilled", { models: ["test/a", "test/b"], content: "<if-model is=\"test/a\"></if-model><if-model is=\"test/b\">body</if-model>", skills: ["large"], budget: { maxTokens: 2 } })],
	]);
	const a = { provider: "test", id: "a" } as any, b = { provider: "test", id: "b" } as any;
	const registry = { find: (provider: string, id: string) => [a, b].find((model) => model.provider === provider && model.id === id), getAll: () => [a, b], getAvailable: () => [a, b] } as any;
	const result = await prepareAdaptivePreflight(wrapper, catalog, { cwd: root, args: [], currentModel: a, modelRegistry: registry, commands: [{ name: "large", source: "skill", sourceInfo: { path: skillPath } }] });
	assert.equal(result.status, "ready", result.diagnostics.join("\n"));
	const skillCost = result.targets[1]!.skillPromptCost!.estimatedTokens;
	assert.ok(skillCost > 100);
	const exactCost = estimatePromptTokens("switch").estimatedTokens + estimatePromptTokens("body").estimatedTokens + skillCost;
	assert.equal(result.promptCostBounds.minimumCompleting, exactCost);
	assert.equal(result.promptCostBounds.maximumCompleting, exactCost);
	assert.equal(result.promptCostBounds.initialFallthrough, exactCost);
});

test("adaptive renderers sanitize and cap untrusted fields and show outcomes", () => {
	const bad = `evil\u001b[31m\n${"x".repeat(1000)}`;
	const text = formatAdaptiveDecision({ sourceStep: bad, observedOutcome: "failed", matchedRule: "onFailure", matchedGate: "always", selectedTarget: bad, reason: "selected" });
	assert.doesNotMatch(text, /\u001b/);
	assert.ok(text.length < 700);
	const report = formatAdaptiveRuntimeReport(bad, { state: { status: "completed", currentStep: null, stepsTaken: 1, modelCalls: 1, visited: ["a"], executed: ["a"], trace: [] }, decisions: [], actions: [{ stepId: bad, kind: "prompt", target: bad, outcome: "blocked", changed: false }] });
	assert.match(report, /blocked; changed=false/);
	const unobserved = formatAdaptiveRuntimeReport("safe", { state: { status: "completed", currentStep: null, stepsTaken: 1, modelCalls: 1, visited: ["a"], executed: ["a"], trace: [] }, decisions: [], actions: [{ stepId: "a", kind: "prompt", target: "a", outcome: "succeeded" }] });
	assert.match(unobserved, /succeeded; changed=unobserved/);
	assert.doesNotMatch(report, /\u001b/);
});

test("adaptive preflight expands bare model specs into concrete later-route states", async () => {
	const wrapper = prompt("flow", { adaptiveChain: { limits: { maxSteps: 2, maxModelCalls: 2 }, steps: [
		{ id: "switch", kind: "prompt", target: "switch", when: "always" },
		{ id: "later", kind: "prompt", target: "later", when: "always" },
	] } });
	const catalog = new Map([
		["switch", prompt("switch", { models: ["b"], content: "BBBB" })],
		["later", prompt("later", { models: ["test/a", "test/b"], budget: { maxTokens: 2 }, content: "<if-model is=\"test/a\"></if-model><if-model is=\"test/b\">BBBBBBBBBBBB</if-model>" })],
	]);
	const a = { provider: "test", id: "a" } as any, b = { provider: "test", id: "b" } as any;
	const registry = { find: (provider: string, id: string) => [a, b].find((model) => model.provider === provider && model.id === id), getAll: () => [a, b], getAvailable: () => [a, b] } as any;
	const result = await prepareAdaptivePreflight(wrapper, catalog, { cwd: "/repo", args: [], currentModel: a, modelRegistry: registry });
	assert.equal(result.status, "blocked");
	assert.deepEqual(result.diagnostics, ["Step later (later) for active model test/b: Prompt `later` estimated 3 tokens exceeds configured maximum of 2."]);
});

test("adaptive preflight bounds route preparation before the step-model product", async () => {
	const models = Array.from({ length: 4096 }, (_, id) => ({ provider: "test", id: `m${id}` })) as any[];
	const steps = Array.from({ length: 100 }, (_, index) => ({ id: `s${index}`, kind: "prompt" as const, target: "target", when: "always" as const }));
	const wrapper = prompt("wide", { adaptiveChain: { limits: { maxSteps: 100, maxModelCalls: 100 }, steps } });
	const catalog = new Map([["target", prompt("target", { models: models.map((model) => `test/${model.id}`) })]]);
	let probes = 0;
	const registry = { find: (provider: string, id: string) => { probes++; return models.find((model) => model.provider === provider && model.id === id); }, getAll: () => models, getAvailable: () => models } as any;
	const started = performance.now();
	const result = await prepareAdaptivePreflight(wrapper, catalog, { cwd: "/repo", args: [], currentModel: models[0], modelRegistry: registry });
	assert.equal(result.status, "blocked");
	assert.match(result.diagnostics.join("\n"), /route preparation product 100×4096=409600 exceeds configured cap 4096/);
	assert.equal(result.analysis.complete, false);
	assert.ok(probes <= MAX_ADAPTIVE_PREFLIGHT_STATES);
	assert.ok(performance.now() - started < 2_000);
});

test("inconclusive adaptive cost bound includes every prepared switched-model route", async () => {
	const steps = Array.from({ length: 128 }, (_, index) => ({ id: `step-${index}`, kind: "prompt" as const, target: index === 0 ? "switch" : "costly", when: "always" as const, onFailure: index + 2 < 128 ? `step-${index + 2}` : undefined }));
	const wrapper = prompt("branching-cost", { adaptiveChain: { limits: { maxSteps: 128, maxModelCalls: 128 }, steps } });
	const catalog = new Map([
		["switch", prompt("switch", { models: ["test/b"], content: "x" })],
		["costly", prompt("costly", { models: ["test/a", "test/b"], content: `<if-model is="test/a">x</if-model><if-model is="test/b">${"z".repeat(4000)}</if-model>` })],
	]);
	const a = { provider: "test", id: "a" } as any, b = { provider: "test", id: "b" } as any;
	const registry = { find: (provider: string, id: string) => [a, b].find((model) => model.provider === provider && model.id === id), getAll: () => [a, b], getAvailable: () => [a, b] } as any;
	const result = await prepareAdaptivePreflight(wrapper, catalog, { cwd: "/repo", args: [], currentModel: a, modelRegistry: registry });
	assert.equal(result.analysis.complete, false);
	assert.ok(result.promptCostBounds.maximumReachable >= result.promptCostBounds.initialFallthrough);
	assert.ok(result.promptCostBounds.maximumReachable >= 128 * 1000);
});
