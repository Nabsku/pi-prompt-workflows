import type { ChainGate, ChainOutcome, StructuredChainStep } from "./chain-parser.js";
import type { PromptWithModel } from "./prompt-loader.js";
import { getRequestedSkills } from "./prompt-skills.js";
import { resolvePromptSkills, type RuntimeSkillCommand } from "./prompt-skills.js";
import { checkPromptExecutionBudget, preparePromptExecution } from "./prompt-execution.js";
import type { Model } from "@earendil-works/pi-ai";
import type { RegistryLike } from "./model-selection.js";
import { capSanitizedText } from "./render-safe.js";
import { estimatePromptTokens, PROMPT_TOKEN_ESTIMATE_METHOD } from "./prompt-budget.js";
import { createAdaptiveChainState, routeAdaptiveChain, type ChainObservation } from "./adaptive-chain.js";

export interface AdaptivePreflightTarget {
	readonly status: "ready" | "blocked";
	readonly name: string;
	readonly kind: "prompt" | "run";
	readonly description?: string;
	readonly cwd: string;
	readonly models: readonly string[];
	readonly thinking?: string;
	readonly budget?: PromptWithModel["budget"];
	readonly skills: readonly string[];
	readonly includes: readonly string[];
	readonly execution?: string;
	readonly issues: readonly string[];
	readonly effectiveModel?: string;
	readonly budgetVerdict?: string;
	readonly promptCost?: { readonly bytes: number; readonly estimatedTokens: number; readonly method: typeof PROMPT_TOKEN_ESTIMATE_METHOD };
}
export interface AdaptiveCallBounds { readonly minimum: number; readonly maximum: number; readonly exact: boolean; readonly explanation: string }
export interface AdaptivePromptCostBounds { readonly minimumCompleting: number; readonly maximumCompleting: number; readonly maximumReachable: number; readonly initialFallthrough: number; readonly initialPathStatus: "completed" | "exhausted"; readonly exact: boolean; readonly method: typeof PROMPT_TOKEN_ESTIMATE_METHOD; readonly explanation: string }
/** Deterministic defense-in-depth cap for adaptive preflight graph exploration. Execution is not affected. */
export const MAX_ADAPTIVE_PREFLIGHT_STATES = 4096;
export interface AdaptivePreflight {
	readonly status: "ready" | "blocked";
	readonly name: string;
	readonly limits: { readonly maxSteps: number; readonly maxModelCalls: number };
	readonly steps: readonly StructuredChainStep[];
	readonly targets: readonly AdaptivePreflightTarget[];
	readonly callBounds: AdaptiveCallBounds;
	readonly promptCostBounds: AdaptivePromptCostBounds;
	readonly diagnostics: readonly string[];
	readonly pathAnalysis: { readonly hasCompletingPath: boolean; readonly hasExhaustedPath: boolean; readonly exhaustedReasons: readonly string[]; readonly exhaustedPathCount: number };
	readonly analysis: { readonly complete: boolean; readonly analyzedStates: number; readonly enqueuedStates: number; readonly stateLimit: number };
	readonly graphAvailable?: boolean;
}

export function createInvalidAdaptivePreflight(name: string, diagnostics: readonly string[]): AdaptivePreflight {
	return { status: "blocked", name, limits: { maxSteps: 0, maxModelCalls: 0 }, steps: [], targets: [], callBounds: { minimum: 0, maximum: 0, exact: true, explanation: "Graph unavailable/invalid; no executable paths were analyzed." }, promptCostBounds: { minimumCompleting: 0, maximumCompleting: 0, maximumReachable: 0, initialFallthrough: 0, initialPathStatus: "exhausted", exact: true, method: PROMPT_TOKEN_ESTIMATE_METHOD, explanation: "Graph unavailable/invalid; prompt costs were not evaluated." }, diagnostics: diagnostics.map((item) => capSanitizedText(item, 500)), pathAnalysis: { hasCompletingPath: false, hasExhaustedPath: false, exhaustedReasons: [], exhaustedPathCount: 0 }, analysis: { complete: false, analyzedStates: 0, enqueuedStates: 0, stateLimit: MAX_ADAPTIVE_PREFLIGHT_STATES }, graphAvailable: false };
}

function analyzeInitialPath(steps: readonly StructuredChainStep[], limits: { maxSteps: number; maxModelCalls: number }, promptCosts: readonly number[]): { cost: number; status: "completed" | "exhausted" } {
	let state = createAdaptiveChainState();
	let observation: ChainObservation | undefined;
	let cost = 0;
	try {
		for (;;) {
			const routed = routeAdaptiveChain(steps, limits, state, observation);
			state = routed.state;
			observation = undefined;
			if (!routed.action) return { cost, status: "completed" };
			const index = steps.findIndex((step) => step.id === routed.action!.step.id);
			if (routed.action.step.kind === "prompt") cost += promptCosts[index] ?? 0;
			// Documented deterministic baseline: every selected action succeeds without changing the worktree.
			observation = { outcome: "succeeded", changed: false };
		}
	} catch (error) {
		if (error instanceof Error && /^Chain max(?:Steps|ModelCalls) exhausted/.test(error.message)) return { cost, status: "exhausted" };
		throw error;
	}
}

const OUTCOMES: readonly { outcome: Exclude<ChainOutcome, "skipped">; changed: boolean }[] = [
	{ outcome: "succeeded", changed: false }, { outcome: "succeeded", changed: true },
	{ outcome: "failed", changed: false }, { outcome: "failed", changed: true },
	{ outcome: "blocked", changed: false }, { outcome: "blocked", changed: true },
];
function gateMatches(gate: ChainGate, prior?: { outcome: string; changed: boolean }): boolean {
	return gate === "always" || !!prior && (gate === "changed" ? prior.changed : gate === prior.outcome);
}
function next(step: StructuredChainStep, outcome: string, steps: readonly StructuredChainStep[], indexes: Map<string, number>): string | undefined {
	const explicit = outcome === "succeeded" ? step.onSuccess : outcome === "failed" ? step.onFailure : step.onBlocked;
	return explicit ?? steps[(indexes.get(step.id) ?? -1) + 1]?.id;
}
function analyzeCalls(steps: readonly StructuredChainStep[], maxSteps: number, maxCalls: number, promptCosts: readonly number[] = []): { bounds: AdaptiveCallBounds; costs: AdaptivePromptCostBounds; pathAnalysis: AdaptivePreflight["pathAnalysis"]; analysis: AdaptivePreflight["analysis"]; diagnostic?: string } {
	const byId = new Map(steps.map((step) => [step.id, step]));
	const indexes = new Map(steps.map((step, index) => [step.id, index]));
	type State = { target?: string; prior?: { outcome: Exclude<ChainOutcome, "skipped">; changed: boolean }; taken: number; calls: number; cost: number };
	let queue: State[] = [{ target: steps[0]?.id, taken: 0, calls: 0, cost: 0 }];
	let cursor = 0; let analyzedStates = 0; let enqueuedStates = 1;
	const seen = new Set<string>(); const terminal: number[] = []; const terminalCosts: number[] = []; const reachableCosts: number[] = [0]; const exhausted: string[] = [];
	const inconclusive = () => {
		const initial = analyzeInitialPath(steps, { maxSteps, maxModelCalls: maxCalls }, promptCosts);
		const conservativeCost = maxCalls * Math.max(0, ...promptCosts);
		return { bounds: { minimum: 0, maximum: maxCalls, exact: false, explanation: `Unavailable: graph analysis exceeded the deterministic ${MAX_ADAPTIVE_PREFLIGHT_STATES}-state limit; 0..maxModelCalls is conservative, not an exact completing-path bound.` }, costs: { minimumCompleting: 0, maximumCompleting: conservativeCost, maximumReachable: conservativeCost, initialFallthrough: initial.cost, initialPathStatus: initial.status, exact: false, method: PROMPT_TOKEN_ESTIMATE_METHOD, explanation: `Unavailable: graph analysis exceeded the deterministic ${MAX_ADAPTIVE_PREFLIGHT_STATES}-state limit; cost bounds are conservative and must not be treated as exact.` }, pathAnalysis: { hasCompletingPath: false, hasExhaustedPath: false, exhaustedReasons: [], exhaustedPathCount: 0 }, analysis: { complete: false, analyzedStates, enqueuedStates, stateLimit: MAX_ADAPTIVE_PREFLIGHT_STATES }, diagnostic: `analysis inconclusive: state limit ${MAX_ADAPTIVE_PREFLIGHT_STATES} exceeded` };
	};
	const enqueue = (createState: () => State): boolean => {
		if (enqueuedStates >= MAX_ADAPTIVE_PREFLIGHT_STATES) return false;
		queue.push(createState()); enqueuedStates += 1; return true;
	};
	while (cursor < queue.length) {
		const state = queue[cursor++]!; analyzedStates += 1;
		const key = `${state.target ?? "$"}|${state.prior?.outcome ?? ""}|${state.prior?.changed ?? ""}|${state.taken}|${state.calls}|${state.cost}`;
		if (seen.has(key)) continue; seen.add(key);
		if (!state.target) { terminal.push(state.calls); terminalCosts.push(state.cost); reachableCosts.push(state.cost); continue; }
		const step = byId.get(state.target);
		if (!step) { terminal.push(state.calls); terminalCosts.push(state.cost); reachableCosts.push(state.cost); continue; }
		if (!gateMatches(step.when, state.prior)) {
			if (!enqueue(() => ({ ...state, target: steps[(indexes.get(step.id) ?? -1) + 1]?.id }))) return inconclusive(); continue;
		}
		if (state.taken >= maxSteps) { exhausted.push(`maxSteps=${maxSteps} before ${step.id}`); continue; }
		if (step.kind === "prompt" && state.calls >= maxCalls) { exhausted.push(`maxModelCalls=${maxCalls} before ${step.id}`); continue; }
		const addedCost = step.kind === "prompt" ? (promptCosts[indexes.get(step.id) ?? -1] ?? 0) : 0;
		reachableCosts.push(state.cost + addedCost);
		for (const observation of OUTCOMES) if (!enqueue(() => ({ target: next(step, observation.outcome, steps, indexes), prior: observation, taken: state.taken + 1, calls: state.calls + (step.kind === "prompt" ? 1 : 0), cost: state.cost + addedCost }))) return inconclusive();
	}
	const minimum = terminal.length ? Math.min(...terminal) : 0;
	const maximum = terminal.length ? Math.max(...terminal) : 0;
	const initial = analyzeInitialPath(steps, { maxSteps, maxModelCalls: maxCalls }, promptCosts);
	const minimumCompleting = terminalCosts.length ? Math.min(...terminalCosts) : 0;
	const maximumCompleting = terminalCosts.length ? Math.max(...terminalCosts) : 0;
	return { bounds: { minimum, maximum, exact: minimum === maximum, explanation: "Bounds cover successfully completing paths only; every succeeded/failed/blocked and changed/unchanged observation is considered. Run and gate-skipped steps consume no model calls or executed steps." }, costs: { minimumCompleting, maximumCompleting, maximumReachable: Math.max(...reachableCosts), initialFallthrough: initial.cost, initialPathStatus: initial.status, exact: minimumCompleting === maximumCompleting, method: PROMPT_TOKEN_ESTIMATE_METHOD, explanation: "Deterministic estimates use the same budget estimator after args, model conditionals, includes, and skills. The initial baseline runs the pure runtime router from pristine state assuming each selected action is succeeded + changed=false; run and gate-skipped steps cost zero." }, pathAnalysis: { hasCompletingPath: terminal.length > 0, hasExhaustedPath: exhausted.length > 0, exhaustedReasons: [...new Set(exhausted)], exhaustedPathCount: exhausted.length }, analysis: { complete: true, analyzedStates, enqueuedStates, stateLimit: MAX_ADAPTIVE_PREFLIGHT_STATES } };
}
export function isAdaptivePromptTarget(target: PromptWithModel | undefined): boolean {
	return !!target && !target.chain && !target.adaptiveChain && !target.deterministic
		&& !target.subagent && !target.inheritContext && !target.parallel
		&& target.loop === undefined && !target.boomerang && !target.workers
		&& !target.reviewers && !target.finalApplier && !target.preset;
}

export function isAdaptiveRunTarget(target: PromptWithModel | undefined): target is PromptWithModel & { deterministic: NonNullable<PromptWithModel["deterministic"]> } {
	return !!target && !target.chain && !target.adaptiveChain
		&& !!target.deterministic && target.deterministic.handoff === "never"
		&& getRequestedSkills(target).length === 0
		&& !target.workers && !target.reviewers && !target.finalApplier && !target.preset;
}

function targetIssues(step: StructuredChainStep, target: PromptWithModel | undefined): string[] {
	if (!target) return [`Missing ${step.kind} target.`];
	if (target.chain || target.adaptiveChain) return ["Nested/adaptive/parallel chain targets are unsupported."];
	if (step.kind === "run") {
		if (!target.deterministic) return ["Kind mismatch: run target is not deterministic."];
		if (getRequestedSkills(target).length) return ["Adaptive run targets cannot declare skills because deterministic execution does not consume skill context."];
		if (target.workers || target.reviewers || target.finalApplier || target.preset) return ["Adaptive run targets cannot declare compare/best-of-N fields."];
		return isAdaptiveRunTarget(target) ? [] : ["Deterministic handoff can add a model call and is unsupported."];
	}
	if (isAdaptivePromptTarget(target)) return [];
	return target.deterministic
		? ["Kind mismatch: prompt target is deterministic."]
		: ["Delegated, loop, boomerang, compare/final-applier, deterministic, or parallel target mode can expand one router action into multiple top-level model calls and is runtime-rejected."];
}
export function createAdaptivePreflight(wrapper: PromptWithModel, catalog: ReadonlyMap<string, PromptWithModel>, cwd: string, runtimeCwd?: string): AdaptivePreflight {
	if (!wrapper.adaptiveChain) throw new Error("Adaptive preflight requires a structured chain");
	const { steps, limits } = wrapper.adaptiveChain;
	const targets = steps.map((step): AdaptivePreflightTarget => {
		const target = catalog.get(step.target); const issues = targetIssues(step, target);
		const execution = target?.deterministic?.execution;
		const effectiveCwd = step.kind === "run"
			? runtimeCwd ?? target?.deterministic?.cwd ?? wrapper.cwd ?? cwd
			: cwd;
		return { status: issues.length ? "blocked" : "ready", name: step.target, kind: step.kind, description: target?.description, cwd: effectiveCwd, models: target?.models ?? [], thinking: target?.thinking, budget: target?.budget, skills: target ? getRequestedSkills(target) : [], includes: target?.includes ?? [], execution: execution ? (execution.kind === "script" ? execution.path : execution.command) : undefined, issues };
	});
	const analysis = analyzeCalls(steps, limits.maxSteps, limits.maxModelCalls);
	const diagnostics = targets.flatMap((target, index) => target.issues.map((issue) => `Step ${steps[index]!.id} (${target.name}): ${issue}`));
	if (analysis.diagnostic) diagnostics.push(analysis.diagnostic);
	if (analysis.pathAnalysis.hasExhaustedPath) diagnostics.push(`Reachable limit exhaustion (${analysis.pathAnalysis.exhaustedPathCount} path(s)): ${analysis.pathAnalysis.exhaustedReasons.join(", ")}`);
	return { status: diagnostics.length ? "blocked" : "ready", name: wrapper.name, limits, steps, targets, callBounds: analysis.bounds, promptCostBounds: analysis.costs, pathAnalysis: analysis.pathAnalysis, analysis: analysis.analysis, diagnostics };
}

export async function prepareAdaptivePreflight(wrapper: PromptWithModel, catalog: ReadonlyMap<string, PromptWithModel>, options: { cwd: string; runtimeCwd?: string; args: string[]; modelOverride?: string; currentModel?: Model<any>; modelRegistry: RegistryLike; commands?: RuntimeSkillCommand[] }): Promise<AdaptivePreflight> {
	const base = createAdaptivePreflight(wrapper, catalog, options.cwd, options.runtimeCwd);
	const diagnostics = [...base.diagnostics];
	const targets = await Promise.all(base.targets.map(async (summary, index) => {
		const step = base.steps[index]!; const target = catalog.get(step.target);
		if (!target || step.kind !== "prompt" || summary.issues.length) return summary;
		const skills = resolvePromptSkills(getRequestedSkills(target), options.cwd, options.commands ?? []);
		if (skills.kind === "error") {
			const issue = capSanitizedText(skills.error, 500);
			diagnostics.push(`Step ${step.id} (${summary.name}): ${issue}`);
			return { ...summary, status: "blocked" as const, issues: [...summary.issues, issue] };
		}
		const effective = { ...target, ...(options.modelOverride ? { models: [options.modelOverride] } : {}) };
		const prepared = await preparePromptExecution(effective, options.args, options.currentModel, options.modelRegistry);
		if (!prepared || "message" in prepared) {
			const issue = capSanitizedText(prepared && "message" in prepared ? prepared.message : `No available model from: ${effective.models.join(", ")}`, 500);
			diagnostics.push(`Step ${step.id} (${summary.name}): ${issue}`);
			return { ...summary, status: "blocked" as const, issues: [...summary.issues, issue] };
		}
		const loaded = skills.kind === "ready" ? skills.skills : [];
		// Nondelegated runtime sends resolved skills through before_agent_start; only
		// the user prompt body is subject to the prompt's configured budget.
		const content = prepared.content;
		const budget = checkPromptExecutionBudget(target, content);
		if (budget.message) diagnostics.push(`Step ${step.id} (${summary.name}): ${capSanitizedText(budget.message, 500)}`);
		return { ...summary, status: budget.message ? "blocked" as const : "ready" as const, effectiveModel: `${prepared.selectedModel.model.provider}/${prepared.selectedModel.model.id}`, budgetVerdict: budget.message ? "exceeded" : budget.warning ? "warning" : "ok", promptCost: estimatePromptTokens(content), skills: loaded.map((skill) => skill.skillName), issues: budget.message ? [...summary.issues, budget.message] : summary.issues };
	}));
	const analysis = analyzeCalls(base.steps, base.limits.maxSteps, base.limits.maxModelCalls, targets.map((target) => target.promptCost?.estimatedTokens ?? 0));
	if (analysis.diagnostic && !diagnostics.includes(analysis.diagnostic)) diagnostics.push(analysis.diagnostic);
	return { ...base, targets, callBounds: analysis.bounds, promptCostBounds: analysis.costs, pathAnalysis: analysis.pathAnalysis, analysis: analysis.analysis, diagnostics, status: diagnostics.length ? "blocked" : "ready" };
}
function safe(value: unknown, max = 240): string { return capSanitizedText(value, max); }
function edge(value: string | undefined, stepIds: ReadonlySet<string>): string { return value === undefined ? "fallthrough" : value === "end" && !stepIds.has("end") ? "terminal" : safe(value); }
export function formatAdaptivePreflight(value: AdaptivePreflight, maxChars = 32_000): string {
	const stepIds = new Set(value.steps.map((step) => step.id));
	const lines = ["## Adaptive Chain", `- Status: ${value.status}`, `- Limits: maxSteps=${value.limits.maxSteps}, maxModelCalls=${value.limits.maxModelCalls}`, `- Prompt-call bounds: min=${value.callBounds.minimum}, max=${value.callBounds.maximum}${value.callBounds.exact ? " (exact)" : " (path-dependent)"}`, `- Uncertainty: ${value.callBounds.explanation}`, "", "### Bounded graph"];
	lines.splice(3, 0, `- Analysis states: ${value.analysis.analyzedStates} analyzed, ${value.analysis.enqueuedStates} enqueued (limit ${value.analysis.stateLimit}; ${value.analysis.complete ? "complete" : "inconclusive"})`);
	lines.splice(4, 0, "- Snapshot note: skills, files, model availability, and prompt costs are a read-only preflight snapshot; runtime revalidates them before execution.");
	if (value.graphAvailable === false) lines.push("Graph unavailable/invalid. This declaration is blocked and is not executable.");
	lines.splice(4, 0, `- Prompt-token bounds: completing min=${value.promptCostBounds.minimumCompleting}, completing max=${value.promptCostBounds.maximumCompleting}, reachable max=${value.promptCostBounds.maximumReachable}; initial baseline=${value.promptCostBounds.initialFallthrough} (${value.promptCostBounds.initialPathStatus}; ${value.promptCostBounds.method})`, `- Cost uncertainty: ${value.promptCostBounds.explanation}`);
	lines.splice(4, 0, `- Paths: completing=${value.pathAnalysis.hasCompletingPath}; exhausted=${value.pathAnalysis.hasExhaustedPath} (${value.pathAnalysis.exhaustedPathCount})`);
	value.steps.forEach((step, index) => {
		const target = value.targets[index]!;
		const natural = value.steps[index + 1] ? safe(value.steps[index + 1]!.id) : "terminal";
		lines.push(`${index + 1}. ${safe(step.id)} [${step.kind}] target=${safe(step.target)} gate=${step.when}`);
		lines.push(`   fallthrough=${natural}; onSuccess=${edge(step.onSuccess, stepIds)}; onFailure=${edge(step.onFailure, stepIds)}; onBlocked=${edge(step.onBlocked, stepIds)}`);
		lines.push(`   preflight=${target.status}; cwd=${safe(target.cwd)}; model=${safe(target.effectiveModel ?? (target.models.length ? target.models.join(", ") : "runtime/default"))}${target.thinking ? `; thinking=${safe(target.thinking)}` : ""}`);
		if (target.budgetVerdict) lines.push(`   effective-budget=${safe(target.budgetVerdict)}`);
		if (target.promptCost) lines.push(`   prompt-cost=~${target.promptCost.estimatedTokens} tokens; ${target.promptCost.bytes} UTF-8 bytes; method=${target.promptCost.method}`);
		if (target.budget) lines.push(`   budget=${safe(JSON.stringify(target.budget))}`);
		if (target.skills.length) lines.push(`   skills=${target.skills.map((x) => safe(x)).join(", ")}`);
		if (target.includes.length) lines.push(`   includes=${target.includes.map((x) => safe(x)).join(", ")}`);
		if (target.execution) lines.push(`   ${step.kind === "run" ? "command/script" : "execution"}=${safe(target.execution)}`);
		for (const issue of target.issues) lines.push(`   BLOCKED: ${safe(issue)}`);
	});
	if (value.diagnostics.length) lines.push("", "### Blocked preflight issues", ...value.diagnostics.map((x) => `- ${safe(x, 500)}`));
	return capSanitizedText(lines.join("\n"), maxChars, { preserveLineBreaks: true });
}
