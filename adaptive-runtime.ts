import { createAdaptiveChainState, routeAdaptiveChain, type AdaptiveChainDecision, type AdaptiveChainState, type ChainObservation } from "./adaptive-chain.js";
import type { ChainLimits, ChainOutcome, StructuredChainStep } from "./chain-parser.js";
import type { GitWorktreeSnapshot } from "./git-worktree-snapshot.js";
import type { StepExecutionOutcome } from "./prompt-execution.js";

export interface AdaptiveChainDefinition {
	readonly steps: readonly StructuredChainStep[];
	readonly limits: ChainLimits;
}

export interface AdaptiveRuntimeDependencies<TPrompt = unknown, TRun = unknown> {
	readonly signal?: AbortSignal;
	resolvePrompt(target: string): TPrompt | undefined;
	resolveRun(target: string): TRun | undefined;
	executePrompt(prompt: TPrompt, step: StructuredChainStep): Promise<StepExecutionOutcome<unknown>>;
	executeRun(run: TRun, step: StructuredChainStep): Promise<StepExecutionOutcome<unknown>>;
	resolveSnapshotCwd(step: StructuredChainStep, target: TPrompt | TRun): string;
	shouldCaptureSnapshot?(step: StructuredChainStep): boolean;
	captureSnapshot(step: StructuredChainStep, cwd: string): Promise<GitWorktreeSnapshot> | GitWorktreeSnapshot;
	compareSnapshots(before: GitWorktreeSnapshot, after: GitWorktreeSnapshot): { changed: boolean };
	onDecision?(decision: AdaptiveChainDecision): void;
}

export interface AdaptiveRuntimeTraceEntry {
	readonly stepId: string;
	readonly kind: "prompt" | "run";
	readonly target: string;
	readonly outcome: ChainOutcome;
	/** Present only when before/after snapshots observed the action's change state. */
	readonly changed?: boolean;
	readonly errorReason?: string;
}

export interface AdaptiveRuntimeReport {
	readonly state: AdaptiveChainState;
	readonly decisions: readonly AdaptiveChainDecision[];
	readonly actions: readonly AdaptiveRuntimeTraceEntry[];
}

export class AdaptiveChainCancelledError extends Error {
	readonly report: AdaptiveRuntimeReport;
	constructor(report: AdaptiveRuntimeReport) {
		super("Adaptive chain cancelled");
		this.name = "AdaptiveChainCancelledError";
		this.report = report;
	}
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

function immutableReport(state: AdaptiveChainState, decisions: readonly AdaptiveChainDecision[], actions: readonly AdaptiveRuntimeTraceEntry[]): AdaptiveRuntimeReport {
	return deepFreeze(structuredClone({ state, decisions, actions }) as AdaptiveRuntimeReport);
}

function outcomeStatus(outcome: StepExecutionOutcome<unknown>): Exclude<ChainOutcome, "skipped"> {
	return outcome.status === "succeeded" ? "succeeded" : outcome.status === "blocked" ? "blocked" : "failed";
}

/** Executes a validated adaptive chain. Snapshot errors and malformed/missing targets fail closed by throwing. */
export async function executeAdaptiveChain<TPrompt, TRun>(
	definition: AdaptiveChainDefinition,
	dependencies: AdaptiveRuntimeDependencies<TPrompt, TRun>,
): Promise<AdaptiveRuntimeReport> {
	let state = createAdaptiveChainState();
	let observation: ChainObservation | undefined;
	const decisions: AdaptiveChainDecision[] = [];
	const actions: AdaptiveRuntimeTraceEntry[] = [];
	const report = (): AdaptiveRuntimeReport => immutableReport(state, decisions, actions);
	const throwIfCancelled = () => {
		if (dependencies.signal?.aborted) throw new AdaptiveChainCancelledError(report());
	};

	for (;;) {
		throwIfCancelled();
		const routed = routeAdaptiveChain(definition.steps, definition.limits, state, observation);
		state = routed.state;
		observation = undefined;
		for (const decision of routed.decisions) {
			decisions.push(decision);
			dependencies.onDecision?.(decision);
		}
		if (!routed.action) return report();
		throwIfCancelled();

		const step = routed.action.step;
		const target = step.kind === "prompt"
			? dependencies.resolvePrompt(step.target)
			: dependencies.resolveRun(step.target);
		if (target === undefined) throw new Error(`Adaptive chain ${step.kind} target ${JSON.stringify(step.target)} is missing or mismatched`);

		const snapshotCwd = dependencies.resolveSnapshotCwd(step, target as TPrompt | TRun);
		const shouldSnapshot = dependencies.shouldCaptureSnapshot?.(step) ?? true;
		const before = shouldSnapshot ? await dependencies.captureSnapshot(step, snapshotCwd) : undefined;
		throwIfCancelled();
		let outcome: StepExecutionOutcome<unknown>;
		try {
			outcome = step.kind === "prompt"
				? await dependencies.executePrompt(target as TPrompt, step)
				: await dependencies.executeRun(target as TRun, step);
		} catch (error) {
			outcome = { status: "failed", error };
		}
		const after = shouldSnapshot ? await dependencies.captureSnapshot(step, snapshotCwd) : undefined;
		const changed = before && after ? dependencies.compareSnapshots(before, after).changed : undefined;
		const status = dependencies.signal?.aborted ? "failed" : outcomeStatus(outcome);
		// Routing consumes a boolean for replay-safe chain state. Preflight ensures
		// snapshots are retained for every action whose change state can affect a gate.
		observation = { outcome: status, changed: changed ?? false };
		const errorReason = "error" in outcome ? String(outcome.error instanceof Error ? outcome.error.message : outcome.error) : undefined;
		actions.push({ stepId: step.id, kind: step.kind, target: step.target, outcome: status, ...(changed === undefined ? {} : { changed }), ...(errorReason ? { errorReason } : {}) });
		throwIfCancelled();
	}
}
