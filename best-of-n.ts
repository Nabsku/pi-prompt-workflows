import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { executeSubagentPromptStep, DelegatedPromptCancelledError, type DelegatedPromptOutcome } from "./subagent-step.js";
import type { BestOfNConfig, DelegationLineupSlot, PromptWithModel } from "./prompt-loader.js";
import type { SubagentOverride } from "./args.js";
import { type LineupOverrideAction } from "./args.js";
import { notify } from "./notifications.js";
import { PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE, type DelegatedSubagentUsage } from "./subagent-runtime.js";

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
	runtimeOverride?: SubagentOverride;
	runtimeFork?: boolean;
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
	const evidence = results
		.map((result) => {
			if (result.outcome && !result.error && result.outcome.text.trim()) {
				return `\n\n--- ${label} ${result.index + 1} (${result.slot.agent}) ---\n${result.outcome.text.trim()}`;
			}
			if (result.error) {
				return `\n\n--- ${label} ${result.index + 1} (${result.slot.agent}) failed ---\n${result.error}`;
			}
			return "";
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
	runtimeCwd: string | undefined,
	runtimeFork: boolean,
): PromptWithModel {
	const models = runtimeModel ? [runtimeModel] : slot.model ? [slot.model] : base.models;
	return {
		...base,
		name: `${base.name}:${slot.agent}`,
		content: slot.task ?? base.content,
		models,
		subagent: slot.agent,
		cwd: runtimeCwd ?? slot.cwd ?? base.cwd,
		...(runtimeFork ? { inheritContext: true } : {}),
		bestOfN: undefined,
	};
}

function createCancellationScope(parentSignal: AbortSignal | undefined): { controller: AbortController; cleanup: () => void } {
	const controller = new AbortController();
	if (!parentSignal) return { controller, cleanup: () => {} };
	const abort = () => controller.abort();
	if (parentSignal.aborted) controller.abort();
	else parentSignal.addEventListener("abort", abort, { once: true });
	return {
		controller,
		cleanup: () => parentSignal.removeEventListener("abort", abort),
	};
}

async function runPhase(
	options: BestOfNRunOptions,
	phase: PhaseResult["phase"],
	slots: DelegationLineupSlot[],
	runtimeModel: string | undefined,
	evidence: string,
	cancellation: AbortController,
): Promise<PhaseResult[]> {
	let cancellationError: DelegatedPromptCancelledError | undefined;
	const results = await Promise.all(slots.map(async (slot, index): Promise<PhaseResult> => {
		try {
			const effectivePrompt = options.runtimeCwd ? { ...options.prompt, cwd: options.runtimeCwd } : options.prompt;
			const outcome = await executeSubagentPromptStep({
				pi: options.pi,
				ctx: options.ctx,
				currentModel: options.currentModel,
				prompt: slotPrompt(effectivePrompt, slot, runtimeModel, options.runtimeCwd, options.runtimeFork === true),
				args: options.args,
				signal: cancellation.signal,
				override: options.runtimeOverride,
				taskPreamble: phasePreamble(phase, slot, evidence),
				includeTaskPreambleWithFork: options.runtimeFork === true,
				emitResult: false,
			});
			return { phase, slot, index, outcome };
		} catch (error) {
			if (error instanceof DelegatedPromptCancelledError) {
				cancellationError ??= error;
				cancellation.abort();
			}
			return {
				phase,
				slot,
				index,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}));
	if (cancellationError) throw cancellationError;
	return results;
}

function resultText(results: PhaseResult[], title: string): string {
	const successful = results.filter((result) => result.outcome && !result.error);
	if (successful.length === 0) return "";
	return successful
		.map((result) => {
			const outcome = result.outcome!;
			return `### ${title} ${result.index + 1} — ${result.slot.agent}\n\n${outcome.text.trim()}`;
		})
		.join("\n\n");
}

function summarizeFailures(results: PhaseResult[]): string[] {
	return results
		.filter((result) => result.error)
		.map((result) => `${result.phase} ${result.index + 1} (${result.slot.agent}): ${result.error}`);
}

function aggregateUsage(results: PhaseResult[]): DelegatedSubagentUsage | undefined {
	const usages = results.flatMap((result) => result.outcome?.usage ? [result.outcome.usage] : []);
	if (usages.length === 0) return undefined;
	return usages.reduce((total, usage) => ({
		input: total.input + usage.input,
		output: total.output + usage.output,
		cacheRead: total.cacheRead + usage.cacheRead,
		cacheWrite: total.cacheWrite + usage.cacheWrite,
		cost: total.cost + usage.cost,
		turns: total.turns + usage.turns,
		toolCalls: total.toolCalls + usage.toolCalls,
		durationMs: total.durationMs + usage.durationMs,
	}), {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
		toolCalls: 0,
		durationMs: 0,
	});
}

function aggregateModel(results: PhaseResult[]): string | undefined {
	const models = new Set(results.flatMap((result) => result.outcome?.model ? [result.outcome.model] : []));
	return models.size === 1 ? [...models][0] : undefined;
}

function notifyResult(options: BestOfNRunOptions, body: string, details?: { model?: string; usage?: DelegatedSubagentUsage; changed?: boolean }): void {
	options.pi.sendMessage({
		customType: PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE,
		content: body,
		display: true,
		...(details && Object.keys(details).length > 0 ? { details } : {}),
	});
}

export async function executeBestOfNPrompt(options: BestOfNRunOptions): Promise<"completed" | "failed" | "cancelled"> {
	const cancellation = createCancellationScope(options.signal);
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

		const workers = await runPhase(options, "worker", workerSlots, options.runtimeModel, "", cancellation.controller);
		const workerEvidence = appendEvidence("\n\nCandidate answers:", "Candidate", workers);
		const workerSuccesses = workers.filter((result) => result.outcome && !result.error);
		if (workerSuccesses.length === 0) {
			notify(options.ctx, `bestOfN produced no successful worker result.\n${summarizeFailures(workers).join("\n")}`, "error");
			return "failed";
		}

		const reviewers = reviewerSlots.length > 0
			? await runPhase(options, "reviewer", reviewerSlots, options.runtimeModel, workerEvidence, cancellation.controller)
			: [];
		const reviewEvidence = appendEvidence("\n\nReviewer findings:", "Review", reviewers);
		const finalResults = options.config.finalApplier
			? await runPhase(options, "final-applier", [options.config.finalApplier], options.runtimeModel, `${workerEvidence}${reviewEvidence}`, cancellation.controller)
			: [];
		const finalText = resultText(finalResults, "Final answer");
		const reviewText = resultText(reviewers, "Review");
		const workerText = resultText(workers, "Candidate");
		const body = finalText || reviewText || workerText;
		const failures = [...summarizeFailures(workers), ...summarizeFailures(reviewers), ...summarizeFailures(finalResults)];
		const suffix = failures.length > 0 ? `\n\n> Partial result. Failed slots:\n> ${failures.join("\n> ")}` : "";
		const allResults = [...workers, ...reviewers, ...finalResults];
		const usage = aggregateUsage(allResults);
		const model = aggregateModel(allResults);
		notifyResult(options, `${body}${suffix}`, {
			changed: allResults.some((result) => result.outcome?.changed === true),
			...(model ? { model } : {}),
			...(usage ? { usage } : {}),
		});
		return "completed";
	} catch (error) {
		if (error instanceof DelegatedPromptCancelledError || options.signal?.aborted) {
			notify(options.ctx, "bestOfN delegation cancelled.", "warning");
			return "cancelled";
		}
		notify(options.ctx, `bestOfN failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return "failed";
	} finally {
		cancellation.cleanup();
	}
}
