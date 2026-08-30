import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { executeSubagentPromptStep, DelegatedPromptCancelledError, type DelegatedPromptOutcome } from "./subagent-step.js";
import type { BestOfNConfig, DelegationLineupSlot, PromptWithModel } from "./prompt-loader.js";
import { type LineupOverrideAction } from "./args.js";
import { notify } from "./notifications.js";

/**
 * Protects the host and the bridge from unbounded fan-out. The limit applies
 * to all worker, reviewer, and final-applier requests in one invocation.
 */
export const MAX_BEST_OF_N_REQUESTS = 32;

export function applyLineupOverrides(config: BestOfNConfig, actions: LineupOverrideAction[]): BestOfNConfig {
	const result: BestOfNConfig = {
		workers: [...(config.workers ?? [])],
		reviewers: config.reviewers ? [...config.reviewers] : undefined,
		finalApplier: config.finalApplier ? { ...config.finalApplier } : undefined,
	};
	for (const action of actions) {
		if (action.target === "finalApplier") {
			result.finalApplier = { ...action.slots[0] };
			continue;
		}
		const current = action.target === "workers" ? (result.workers ?? []) : (result.reviewers ?? []);
		const next = action.mode === "append" ? [...current, ...action.slots] : [...action.slots];
		if (action.target === "workers") result.workers = next;
		else result.reviewers = next;
	}
	return result;
}

export interface BestOfNRunOptions {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	prompt: PromptWithModel;
	config: BestOfNConfig;
	args: string[];
	currentModel: Model<any> | undefined;
	runtimeModel?: string;
	runtimeCwd?: string;
	signal?: AbortSignal;
}

interface PhaseResult {
	phase: "worker" | "reviewer" | "final-applier";
	slot: DelegationLineupSlot;
	index: number;
	outcome?: DelegatedPromptOutcome;
	error?: string;
}

function requestedSlotCount(slots: readonly DelegationLineupSlot[]): number {
	let total = 0;
	for (const slot of slots) {
		const count = slot.count ?? 1;
		if (!Number.isSafeInteger(count) || count < 1 || total > MAX_BEST_OF_N_REQUESTS - count) return MAX_BEST_OF_N_REQUESTS + 1;
		total += count;
	}
	return total;
}

function expandSlots(slots: DelegationLineupSlot[], label: string): DelegationLineupSlot[] {
	const requested = requestedSlotCount(slots);
	if (requested > MAX_BEST_OF_N_REQUESTS) {
		throw new Error(`bestOfN.${label} requests exceed the configured limit of ${MAX_BEST_OF_N_REQUESTS}.`);
	}
	const expanded: DelegationLineupSlot[] = [];
	for (const slot of slots) {
		const count = slot.count ?? 1;
		for (let i = 0; i < count; i++) expanded.push({ ...slot, count: undefined });
	}
	if (expanded.length === 0) throw new Error(`bestOfN.${label} must contain at least one slot.`);
	return expanded;
}

function appendEvidence(preamble: string, label: string, results: PhaseResult[]): string {
	const successful = results.filter((result) => result.outcome && !result.error && result.outcome.text.trim());
	if (successful.length === 0) return preamble;
	const evidence = successful
		.map((result, index) => {
			const outcome = result.outcome!;
			return `\n\n--- ${label} ${index + 1} (${result.slot.agent}) ---\n${outcome.text.trim()}`;
		})
		.join("");
	return `${preamble}${evidence}`;
}

function phasePreamble(
	phase: "worker" | "reviewer" | "final-applier",
	slot: DelegationLineupSlot,
	evidence: string,
): string {
	const instruction = phase === "worker"
		? "Produce one independent candidate answer for the prompt. Do not discuss other candidates."
		: phase === "reviewer"
			? "Review the candidate answers below. Identify the strongest answer and concrete corrections. Do not claim to apply changes."
			: "Select or synthesize the best final answer from the candidate answers and reviews below. Return only the answer for the user.";
	const suffix = slot.taskSuffix ? `\n\nAdditional slot instruction:\n${slot.taskSuffix.trim()}` : "";
	return `${instruction}${suffix}${evidence}`;
}

function slotPrompt(
	base: PromptWithModel,
	slot: DelegationLineupSlot,
	runtimeModel: string | undefined,
): PromptWithModel {
	const models = slot.model ? [slot.model] : runtimeModel ? [runtimeModel] : base.models;
	return {
		...base,
		name: `${base.name}:${slot.agent}`,
		content: slot.task ?? base.content,
		models,
		subagent: slot.agent,
		cwd: slot.cwd ?? base.cwd,
		bestOfN: undefined,
	};
}

async function runPhase(
	options: BestOfNRunOptions,
	phase: PhaseResult["phase"],
	slots: DelegationLineupSlot[],
	runtimeModel: string | undefined,
	evidence: string,
): Promise<PhaseResult[]> {
	return Promise.all(slots.map(async (slot, index): Promise<PhaseResult> => {
		try {
			const effectivePrompt = options.runtimeCwd ? { ...options.prompt, cwd: options.runtimeCwd } : options.prompt;
			const outcome = await executeSubagentPromptStep({
				pi: options.pi,
				ctx: options.ctx,
				currentModel: options.currentModel,
				prompt: slotPrompt(effectivePrompt, slot, runtimeModel),
				args: options.args,
				signal: options.signal,
				taskPreamble: phasePreamble(phase, slot, evidence),
				emitResult: false,
			});
			return { phase, slot, index, outcome };
		} catch (error) {
			if (error instanceof DelegatedPromptCancelledError) throw error;
			return {
				phase,
				slot,
				index,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}));
}

function resultText(results: PhaseResult[], title: string): string {
	const successful = results.filter((result) => result.outcome && !result.error);
	if (successful.length === 0) return "";
	return successful
		.map((result, index) => {
			const outcome = result.outcome!;
			return `### ${title} ${index + 1} — ${result.slot.agent}\n\n${outcome.text.trim()}`;
		})
		.join("\n\n");
}

function summarizeFailures(results: PhaseResult[]): string[] {
	return results
		.filter((result) => result.error)
		.map((result) => `${result.phase} ${result.index + 1} (${result.slot.agent}): ${result.error}`);
}

function notifyResult(options: BestOfNRunOptions, body: string): void {
	options.pi.sendMessage({
		customType: "pi-prompt-template-subagent",
		content: body,
		display: true,
	});
}

export async function executeBestOfNPrompt(options: BestOfNRunOptions): Promise<"completed" | "failed" | "cancelled"> {
	try {
		const workerCount = requestedSlotCount(options.config.workers ?? []);
		const reviewerCount = options.config.reviewers ? requestedSlotCount(options.config.reviewers) : 0;
		const requestCount = workerCount + reviewerCount + (options.config.finalApplier ? 1 : 0);
		if (requestCount > MAX_BEST_OF_N_REQUESTS) {
			const message = `bestOfN requested ${requestCount} delegation requests, above the configured limit of ${MAX_BEST_OF_N_REQUESTS}. Reduce slot counts before retrying.`;
			notify(options.ctx, message, "error");
			return "failed";
		}
		const workerSlots = expandSlots(options.config.workers ?? [], "workers");
		const reviewerSlots = options.config.reviewers ? expandSlots(options.config.reviewers, "reviewers") : [];

		const workers = await runPhase(options, "worker", workerSlots, options.runtimeModel, "");
		const workerEvidence = appendEvidence("\n\nCandidate answers:", "Candidate", workers);
		const workerSuccesses = workers.filter((result) => result.outcome && !result.error);
		if (workerSuccesses.length === 0) {
			notify(options.ctx, `bestOfN produced no successful worker result.\n${summarizeFailures(workers).join("\n")}`, "error");
			return "failed";
		}

		const reviewers = reviewerSlots.length > 0
			? await runPhase(options, "reviewer", reviewerSlots, options.runtimeModel, workerEvidence)
			: [];
		const reviewEvidence = appendEvidence("\n\nReviewer findings:", "Review", reviewers);
		const finalResults = options.config.finalApplier
			? await runPhase(options, "final-applier", [options.config.finalApplier], options.runtimeModel, `${workerEvidence}${reviewEvidence}`)
			: [];
		const finalText = resultText(finalResults, "Final answer");
		const reviewText = resultText(reviewers, "Review");
		const workerText = resultText(workers, "Candidate");
		const body = finalText || reviewText || workerText;
		const failures = [...summarizeFailures(workers), ...summarizeFailures(reviewers), ...summarizeFailures(finalResults)];
		const suffix = failures.length > 0 ? `\n\n> Partial result. Failed slots:\n> ${failures.join("\n> ")}` : "";
		notifyResult(options, `${body}${suffix}`);
		return "completed";
	} catch (error) {
		if (error instanceof DelegatedPromptCancelledError || options.signal?.aborted) {
			notify(options.ctx, "bestOfN delegation cancelled.", "warning");
			return "cancelled";
		}
		notify(options.ctx, `bestOfN failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return "failed";
	}
}
