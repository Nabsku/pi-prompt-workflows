import { normalizeChainOutcome } from "./chain-parser.ts";
import type { ChainGate, ChainLimits, ChainOutcome, StructuredChainStep } from "./chain-parser.ts";

export interface ChainObservation {
	readonly outcome: ChainOutcome;
	readonly changed: boolean;
}

export interface AdaptiveChainTraceEntry {
	readonly stepId: string;
	readonly disposition: "selected" | "skipped";
	/** Present only after a selected action has completed. */
	readonly observation?: ChainObservation;
}

export interface AdaptiveChainState {
	readonly status: "ready" | "awaiting-outcome" | "completed";
	readonly currentStep: string | null;
	readonly stepsTaken: number;
	readonly modelCalls: number;
	readonly visited: readonly string[];
	readonly executed: readonly string[];
	/** Serializable source of truth; all other state fields are replay-derived. */
	readonly trace: readonly AdaptiveChainTraceEntry[];
}

export type ChainMatchedRule = "start" | "fallthrough" | "onSuccess" | "onFailure" | "onBlocked";

export interface AdaptiveChainDecision {
	readonly sourceStep: string | null;
	readonly observedOutcome: ChainOutcome | null;
	readonly matchedRule: ChainMatchedRule;
	readonly matchedGate: ChainGate | null;
	readonly selectedTarget: string | null;
	readonly reason: "selected" | "gate-not-matched" | "chain-complete";
}

export interface AdaptiveChainAction { readonly step: StructuredChainStep }
export interface AdaptiveChainResult {
	readonly state: AdaptiveChainState;
	readonly action: AdaptiveChainAction | null;
	readonly decisions: readonly AdaptiveChainDecision[];
}

export function createAdaptiveChainState(): AdaptiveChainState {
	return { status: "ready", currentStep: null, stepsTaken: 0, modelCalls: 0, visited: [], executed: [], trace: [] };
}

function assertLimits(limits: ChainLimits): void {
	if (!Number.isSafeInteger(limits.maxSteps) || limits.maxSteps < 1) throw new Error("Invalid chain limit maxSteps");
	if (!Number.isSafeInteger(limits.maxModelCalls) || limits.maxModelCalls < 1) throw new Error("Invalid chain limit maxModelCalls");
}
function impossibleState(message: string): never { throw new Error(`Impossible progress: ${message}`); }

function transitionFor(step: StructuredChainStep, outcome: ChainOutcome): { rule: ChainMatchedRule; target?: string } {
	if (outcome === "succeeded" && step.onSuccess !== undefined) return { rule: "onSuccess", target: step.onSuccess };
	if (outcome === "failed" && step.onFailure !== undefined) return { rule: "onFailure", target: step.onFailure };
	if (outcome === "blocked" && step.onBlocked !== undefined) return { rule: "onBlocked", target: step.onBlocked };
	return { rule: "fallthrough" };
}
function gateMatches(gate: ChainGate, observation: ChainObservation | undefined): boolean {
	if (gate === "always") return true;
	if (!observation) return false;
	if (gate === "changed") return observation.changed;
	if (gate === "succeeded") return observation.outcome === "succeeded";
	return observation.outcome === "failed";
}
function normalizeObservation(value: unknown, context: string): ChainObservation {
	if (value === null || typeof value !== "object" || Array.isArray(value)) impossibleState(`${context} observation must be an object`);
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => key !== "outcome" && key !== "changed")) impossibleState(`${context} observation has unknown fields`);
	const outcome = normalizeChainOutcome(record.outcome);
	if (!outcome) impossibleState(`${context} has unknown outcome ${JSON.stringify(record.outcome)}`);
	if (typeof record.changed !== "boolean") impossibleState(`${context} changed observation must be boolean`);
	return { outcome, changed: record.changed };
}

interface Replay {
	state: AdaptiveChainState;
	target?: string;
	observation?: ChainObservation;
	sourceStep?: StructuredChainStep;
	rule: ChainMatchedRule;
}

function replayTrace(steps: readonly StructuredChainStep[], limits: ChainLimits, traceValue: unknown): Replay {
	if (!Array.isArray(traceValue)) impossibleState("trace must be an array");
	const byId = new Map<string, StructuredChainStep>();
	const indexes = new Map<string, number>();
	for (let index = 0; index < steps.length; index++) {
		const step = steps[index];
		if (!step || typeof step.id !== "string" || step.id.length === 0) impossibleState("steps must have non-empty IDs");
		if (byId.has(step.id)) impossibleState(`duplicate step ${JSON.stringify(step.id)}`);
		byId.set(step.id, step); indexes.set(step.id, index);
	}
	if (steps.length === 0) impossibleState("adaptive chain has no steps");

	let target: string | undefined = steps[0].id;
	let priorObservation: ChainObservation | undefined;
	let sourceStep: StructuredChainStep | undefined;
	let rule: ChainMatchedRule = "start";
	const visited: string[] = [];
	const executed: string[] = [];
	const canonicalTrace: AdaptiveChainTraceEntry[] = [];
	const seen = new Set<string>();
	let modelCalls = 0;
	let pending = false;

	for (let index = 0; index < traceValue.length; index++) {
		const raw = traceValue[index];
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) impossibleState(`trace entry ${index} must be an object`);
		const entry = raw as Record<string, unknown>;
		if (Object.keys(entry).some((key) => key !== "stepId" && key !== "disposition" && key !== "observation")) impossibleState(`trace entry ${index} has unknown fields`);
		if (typeof entry.stepId !== "string" || entry.stepId.length === 0) impossibleState(`trace entry ${index} has invalid stepId`);
		if (entry.disposition !== "selected" && entry.disposition !== "skipped") impossibleState(`trace entry ${index} has invalid disposition`);
		if (!target) impossibleState(`trace continues after chain completion at ${JSON.stringify(entry.stepId)}`);
		if (entry.stepId !== target) impossibleState(`trace expected step ${JSON.stringify(target)}, got ${JSON.stringify(entry.stepId)}`);
		const step = byId.get(target);
		if (!step) impossibleState(`unknown target ${JSON.stringify(target)} from step ${JSON.stringify(sourceStep?.id ?? null)}`);
		if (seen.has(target)) impossibleState(`repeated transition detected for ${JSON.stringify(target)} (cycle)`);
		seen.add(target); visited.push(target);
		const expectedDisposition = gateMatches(step.when, priorObservation) ? "selected" : "skipped";
		if (entry.disposition !== expectedDisposition) impossibleState(`trace disposition for ${JSON.stringify(target)} must be ${expectedDisposition}`);

		if (entry.disposition === "skipped") {
			if (Object.hasOwn(entry, "observation")) impossibleState(`skipped trace entry ${JSON.stringify(target)} cannot have an observation`);
			canonicalTrace.push({ stepId: target, disposition: "skipped" });
			sourceStep = step; rule = "fallthrough";
			target = steps[(indexes.get(step.id) ?? -1) + 1]?.id;
			continue;
		}

		if (executed.length >= limits.maxSteps) impossibleState("trace exceeds maxSteps");
		if (step.kind === "prompt" && modelCalls >= limits.maxModelCalls) impossibleState("trace exceeds maxModelCalls");
		executed.push(target); if (step.kind === "prompt") modelCalls++;
		if (!Object.hasOwn(entry, "observation")) {
			if (index !== traceValue.length - 1) impossibleState(`only the final selected trace entry may await an observation`);
			canonicalTrace.push({ stepId: target, disposition: "selected" });
			pending = true; sourceStep = step; target = undefined;
			break;
		}
		const observation = normalizeObservation(entry.observation, `trace entry ${index}`);
		canonicalTrace.push({ stepId: target, disposition: "selected", observation });
		priorObservation = observation; sourceStep = step;
		const transition = transitionFor(step, observation.outcome); rule = transition.rule;
		target = transition.target ?? steps[(indexes.get(step.id) ?? -1) + 1]?.id;
	}

	let status: AdaptiveChainState["status"];
	let currentStep: string | null;
	if (pending) { status = "awaiting-outcome"; currentStep = sourceStep?.id ?? null; }
	else if (traceValue.length === 0) { status = "ready"; currentStep = null; }
	else if (target === undefined) { status = "completed"; currentStep = null; }
	else impossibleState(`trace omits required progress before ${JSON.stringify(target)}`);
	return { state: { status, currentStep, stepsTaken: executed.length, modelCalls, visited, executed, trace: canonicalTrace }, target, observation: priorObservation, sourceStep, rule };
}

function assertDerivedState(actual: AdaptiveChainState, expected: AdaptiveChainState): void {
	if (actual === null || typeof actual !== "object") impossibleState("adaptive chain state must be an object");
	for (const key of ["status", "currentStep", "stepsTaken", "modelCalls"] as const) if (actual[key] !== expected[key]) impossibleState(`${key} does not match replayed trace`);
	for (const key of ["visited", "executed"] as const) {
		if (!Array.isArray(actual[key]) || actual[key].length !== expected[key].length || actual[key].some((value, index) => value !== expected[key][index])) impossibleState(`${key} does not match replayed trace`);
	}
}

/** Advances a bounded chain after independently replaying its serializable history. */
export function routeAdaptiveChain(steps: readonly StructuredChainStep[], limits: ChainLimits, state: AdaptiveChainState, observation?: ChainObservation): AdaptiveChainResult {
	assertLimits(limits);
	if (state === null || typeof state !== "object") impossibleState("adaptive chain state must be an object");
	const replayed = replayTrace(steps, limits, (state as AdaptiveChainState).trace);
	assertDerivedState(state, replayed.state);
	if (replayed.state.status === "completed") impossibleState("adaptive chain is already completed");
	if (replayed.state.status === "ready" && observation !== undefined) impossibleState("an initial chain cannot accept an outcome");
	if (replayed.state.status === "awaiting-outcome" && observation === undefined) impossibleState("awaiting-outcome state requires an outcome");

	let trace = [...replayed.state.trace];
	let sourceStep: StructuredChainStep | undefined;
	let priorObservation: ChainObservation | undefined;
	let rule: ChainMatchedRule = "start";
	let target: string | undefined;
	if (replayed.state.status === "awaiting-outcome") {
		priorObservation = normalizeObservation(observation, "current");
		const last = trace.at(-1)!;
		trace[trace.length - 1] = { ...last, observation: priorObservation };
		sourceStep = steps.find((step) => step.id === last.stepId)!;
		const transition = transitionFor(sourceStep, priorObservation.outcome); rule = transition.rule;
		const index = steps.findIndex((step) => step.id === sourceStep!.id);
		target = transition.target ?? steps[index + 1]?.id;
	} else target = steps[0].id;

	const byId = new Map(steps.map((step) => [step.id, step]));
	const visited = new Set(replayed.state.visited);
	const decisions: AdaptiveChainDecision[] = [];
	while (target !== undefined) {
		const selected = byId.get(target);
		if (!selected) throw new Error(`Unknown target ${JSON.stringify(target)} from step ${JSON.stringify(sourceStep?.id ?? null)}`);
		if (visited.has(target)) throw new Error(`Repeated transition detected for ${JSON.stringify(target)} (cycle)`);
		visited.add(target);
		if (!gateMatches(selected.when, priorObservation)) {
			decisions.push({ sourceStep: sourceStep?.id ?? null, observedOutcome: priorObservation?.outcome ?? null, matchedRule: rule, matchedGate: selected.when, selectedTarget: target, reason: "gate-not-matched" });
			trace.push({ stepId: target, disposition: "skipped" }); sourceStep = selected; rule = "fallthrough";
			target = steps[steps.findIndex((step) => step.id === selected.id) + 1]?.id; continue;
		}
		if (replayed.state.stepsTaken >= limits.maxSteps) throw new Error(`Chain maxSteps exhausted before selecting ${JSON.stringify(target)}`);
		if (selected.kind === "prompt" && replayed.state.modelCalls >= limits.maxModelCalls) throw new Error(`Chain maxModelCalls exhausted before selecting ${JSON.stringify(target)}`);
		decisions.push({ sourceStep: sourceStep?.id ?? null, observedOutcome: priorObservation?.outcome ?? null, matchedRule: rule, matchedGate: selected.when, selectedTarget: target, reason: "selected" });
		trace.push({ stepId: target, disposition: "selected" });
		const derived = replayTrace(steps, limits, trace).state;
		return { action: { step: selected }, decisions, state: derived };
	}
	decisions.push({ sourceStep: sourceStep?.id ?? null, observedOutcome: priorObservation?.outcome ?? null, matchedRule: rule, matchedGate: null, selectedTarget: null, reason: "chain-complete" });
	return { action: null, decisions, state: replayTrace(steps, limits, trace).state };
}
