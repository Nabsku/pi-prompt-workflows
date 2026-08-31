import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { executeSubagentPromptStep, DelegatedPromptCancellationDrainTimeoutError, DelegatedPromptCancelledError, validateDelegatedCwd, type DelegatedPromptOutcome } from "./subagent-step.js";
import { MAX_BEST_OF_N_REQUESTS, type BestOfNConfig, type DelegationLineupSlot, type PromptWithModel } from "./prompt-loader.js";
import type { SubagentOverride } from "./args.js";
import { type LineupOverrideAction } from "./args.js";
import { notify } from "./notifications.js";
import { PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE, type DelegatedSubagentUsage } from "./subagent-runtime.js";
import { assertBestOfNSourceCwdNotIgnored, captureBestOfNWorktreeChanges, createBestOfNWorktreeManager, type BestOfNWorktreeChanges, type BestOfNWorktreeManager, type IsolatedBestOfNWorktree } from "./best-of-n-worktree.js";

export { MAX_BEST_OF_N_REQUESTS } from "./prompt-loader.js";

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
	workspace?: IsolatedBestOfNWorktree;
	candidateChanges?: BestOfNWorktreeChanges | { error: string };
	preserveWorkspace?: boolean;
}

interface PhaseRunResult {
	results: PhaseResult[];
	cancellationError?: DelegatedPromptCancelledError;
	drainTimeoutError?: DelegatedPromptCancellationDrainTimeoutError;
}

const SUBAGENT_TASK_BYTE_LIMIT = 1024 * 1024;
const BEST_OF_N_EVIDENCE_BYTE_RESERVE = 128 * 1024;
const BEST_OF_N_EVIDENCE_BYTE_LIMIT = SUBAGENT_TASK_BYTE_LIMIT - BEST_OF_N_EVIDENCE_BYTE_RESERVE;
const BEST_OF_N_EVIDENCE_TRUNCATION_MARKER = "\n\n[bestOfN evidence truncated to stay below the pi-subagents 1 MiB task limit.]\n";

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

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let low = 0;
	let high = value.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (utf8Bytes(value.slice(0, mid)) <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return value.slice(0, low);
}

function capEvidence(value: string): string {
	if (utf8Bytes(value) <= BEST_OF_N_EVIDENCE_BYTE_LIMIT) return value;
	const markerBytes = utf8Bytes(BEST_OF_N_EVIDENCE_TRUNCATION_MARKER);
	const availableBytes = Math.max(0, BEST_OF_N_EVIDENCE_BYTE_LIMIT - markerBytes);
	return `${truncateUtf8(value, availableBytes).trimEnd()}${BEST_OF_N_EVIDENCE_TRUNCATION_MARKER}`;
}

function formatCandidateChanges(result: PhaseResult): string {
	if (!result.candidateChanges) return "";
	if ("error" in result.candidateChanges) {
		return `\n\nPreserved ${result.phase} worktree changes could not be captured before cleanup:\n${result.candidateChanges.error}`;
	}
	const stat = result.candidateChanges.stat.trim() || "(no stat)";
	const diff = result.candidateChanges.diff.trim() || "(no unified diff)";
	const truncated = result.candidateChanges.truncated ? "\n\n[bestOfN candidate change evidence was truncated.]" : "";
	return `\n\nPreserved ${result.phase} worktree change stat:\n${stat}\n\nPreserved ${result.phase} worktree unified diff:\n${diff}${truncated}`;
}

function hasCandidateChangeEvidence(results: readonly PhaseResult[]): boolean {
	return results.some((result) => result.candidateChanges !== undefined);
}

function appendEvidence(preamble: string, label: string, results: PhaseResult[]): string {
	const evidence = results
		.map((result) => {
			const agent = result.outcome?.agent ?? result.slot.agent;
			const workspace = result.workspace ? `\nWorktree: ${result.workspace.root}` : "";
			const candidateChanges = formatCandidateChanges(result);
			if (result.outcome && !result.error && result.outcome.text.trim()) {
				return `\n\n--- ${label} ${result.index + 1} (${agent})${workspace} ---\n${result.outcome.text.trim()}${candidateChanges}`;
			}
			if (result.error) {
				return `\n\n--- ${label} ${result.index + 1} (${agent})${workspace} failed ---\n${result.error}${candidateChanges}`;
			}
			return "";
		})
		.join("");
	return capEvidence(`${preamble}${evidence}`);
}

function phasePreamble(
	phase: "worker" | "reviewer" | "final-applier",
	slot: DelegationLineupSlot,
	evidence: string,
	workspace?: IsolatedBestOfNWorktree,
): string {
	const defaultInstruction = phase === "worker"
		? "Produce one independent candidate answer for the prompt. Do not discuss other candidates. You are working in an isolated Git worktree. Make candidate changes only there, do not modify the original workspace or commit changes. Leave useful changes in that worktree for reviewers or the final applier, and report all changed files."
		: phase === "reviewer"
			? "Review the candidate answers below. Identify the strongest answer and concrete corrections. Do not modify any worktree or claim to apply changes."
			: "Select or synthesize the best final answer from the candidate answers and reviews below. If a candidate contains code changes, inspect its Worktree path and apply only the selected changes to the current target cwd. Return only the answer for the user.";
	const instruction = phase === "worker" ? defaultInstruction : (slot.task?.trim() || defaultInstruction);
	const suffix = slot.taskSuffix ? `\n\nAdditional slot instruction:\n${slot.taskSuffix.trim()}` : "";
	const workspaceNote = workspace ? `\n\nThis ${phase} runs in isolated Git worktree \`${workspace.root}\`.\n` : "";
	return `${instruction}${suffix}${workspaceNote}${evidence}`;
}

function slotPrompt(
	base: PromptWithModel,
	slot: DelegationLineupSlot,
	phase: PhaseResult["phase"],
	runtimeModel: string | undefined,
	runtimeCwd: string | undefined,
	runtimeFork: boolean,
	isolatedCwd: string | undefined,
	finalTargetCwd: string | undefined,
): PromptWithModel {
	const slotModels = slot.model
		? slot.model.split(",").map((model) => model.trim()).filter(Boolean)
		: undefined;
	const models = runtimeModel
		? [runtimeModel]
		: slotModels && slotModels.length > 0
			? slotModels
			: slot.model
				? [slot.model]
				: base.models;
	return {
		...base,
		name: `${base.name}:${slot.agent}`,
		content: phase === "worker" ? (slot.task ?? base.content) : base.content,
		models,
		subagent: slot.agent,
		cwd: phase === "final-applier" ? finalTargetCwd ?? base.cwd : isolatedCwd ?? runtimeCwd ?? slot.cwd ?? base.cwd,
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

function sourceCwdForSlot(options: BestOfNRunOptions, slot: DelegationLineupSlot): string {
	return options.runtimeCwd ?? slot.cwd ?? options.prompt.cwd ?? options.ctx.cwd;
}

function finalTargetCwd(options: BestOfNRunOptions): string {
	return options.runtimeCwd ?? options.prompt.cwd ?? options.ctx.cwd;
}

async function assertNonFinalSlotCwdsNotIgnored(
	options: BestOfNRunOptions,
	workerSlots: readonly DelegationLineupSlot[],
	reviewerSlots: readonly DelegationLineupSlot[],
): Promise<void> {
	for (const sourceCwd of new Set([...workerSlots, ...reviewerSlots].map((slot) => sourceCwdForSlot(options, slot)))) {
		const effectiveSourceCwd = await validateDelegatedCwd(options.ctx, sourceCwd);
		assertBestOfNSourceCwdNotIgnored(effectiveSourceCwd);
	}
}

async function runPhase(
	options: BestOfNRunOptions,
	phase: PhaseResult["phase"],
	slots: DelegationLineupSlot[],
	runtimeModel: string | undefined,
	evidence: string,
	cancellation: AbortController,
	worktreeManager: BestOfNWorktreeManager,
	finalTargetCwd: string | undefined = undefined,
): Promise<PhaseRunResult> {
	let cancellationError: DelegatedPromptCancelledError | undefined;
	let drainTimeoutError: DelegatedPromptCancellationDrainTimeoutError | undefined;
	if (phase !== "final-applier") {
		for (const sourceCwd of new Set(slots.map((slot) => sourceCwdForSlot(options, slot)))) {
			await validateDelegatedCwd(options.ctx, sourceCwd);
		}
	}
	const workspaces = phase === "final-applier"
		? slots.map(() => undefined)
		: slots.map((slot, index) => worktreeManager.create(sourceCwdForSlot(options, slot), `${phase}-${index + 1}`));
	const results = await Promise.all(slots.map(async (slot, index): Promise<PhaseResult> => {
		const workspace = workspaces[index];
		try {
			const effectivePrompt = workspace
				? { ...options.prompt, cwd: workspace.cwd }
				: phase === "final-applier" && finalTargetCwd
					? { ...options.prompt, cwd: finalTargetCwd }
				: options.runtimeCwd
					? { ...options.prompt, cwd: options.runtimeCwd }
					: options.prompt;
			const outcome = await executeSubagentPromptStep({
				pi: options.pi,
				ctx: options.ctx,
				currentModel: options.currentModel,
				prompt: slotPrompt(effectivePrompt, slot, phase, runtimeModel, options.runtimeCwd, options.runtimeFork === true, workspace?.cwd, finalTargetCwd),
				args: options.args,
				signal: cancellation.signal,
				override: options.runtimeOverride,
				taskPreamble: phasePreamble(phase, slot, evidence, workspace),
				includeTaskPreambleWithFork: options.runtimeFork === true,
				emitResult: false,
				trustedWorktreeRoot: workspace?.root,
			});
			return { phase, slot, index, outcome, workspace };
		} catch (error) {
			if (error instanceof DelegatedPromptCancellationDrainTimeoutError) {
				drainTimeoutError ??= error;
				cancellation.abort();
			} else if (error instanceof DelegatedPromptCancelledError) {
				cancellationError ??= error;
				cancellation.abort();
			}
			return {
				phase,
				slot,
				index,
				error: error instanceof Error ? error.message : String(error),
				workspace,
				preserveWorkspace: error instanceof DelegatedPromptCancellationDrainTimeoutError,
			};
		}
	}));
	return { results, cancellationError, drainTimeoutError };
}

function resultText(results: PhaseResult[], title: string): string {
	const successful = results.filter((result) => result.outcome && !result.error);
	if (successful.length === 0) return "";
	return successful
		.map((result) => {
			const outcome = result.outcome!;
			return `### ${title} ${result.index + 1} — ${result.slot.agent}\n\n${outcome.text.trim()}${formatCandidateChanges(result)}`;
		})
		.join("\n\n");
}

function summarizeFailures(results: PhaseResult[]): string[] {
	return results
		.filter((result) => result.error)
		.map((result) => `${result.phase} ${result.index + 1} (${result.slot.agent}): ${result.error}`);
}

async function captureCandidateChangeEvidence(results: PhaseResult[]): Promise<void> {
	await Promise.all(results.map(async (result) => {
		if (!result.workspace || result.preserveWorkspace || result.candidateChanges) return;
		try {
			const changes = await captureBestOfNWorktreeChanges(result.workspace);
			if (changes) result.candidateChanges = changes;
		} catch (error) {
			result.candidateChanges = { error: error instanceof Error ? error.message : String(error) };
		}
	}));
}

function addPreservedWorkspaceRoots(results: readonly PhaseResult[], roots: Set<string>): void {
	for (const result of results) {
		if (result.preserveWorkspace && result.workspace) roots.add(result.workspace.root);
	}
}

function nonFinalResultBody(workers: PhaseResult[], reviewers: PhaseResult[]): string {
	const reviewText = resultText(reviewers, "Review");
	const workerText = resultText(workers, "Candidate");
	if (reviewText && workerText && hasCandidateChangeEvidence([...workers, ...reviewers])) return `${reviewText}\n\n${workerText}`;
	return reviewText || workerText;
}

function notifyPreservedCandidateResult(
	options: BestOfNRunOptions,
	workers: PhaseResult[],
	reviewers: PhaseResult[],
	finalResults: PhaseResult[] = [],
): void {
	const nonFinalResults = [...workers, ...reviewers];
	if (!hasCandidateChangeEvidence(nonFinalResults)) return;
	const completedBody = nonFinalResultBody(workers, reviewers);
	const failedCandidateEvidence = nonFinalResults
		.filter((result) => (!result.outcome || result.error) && result.candidateChanges)
		.map(formatCandidateChanges)
		.join("");
	const body = `${completedBody}${failedCandidateEvidence}` || "bestOfN candidate change evidence preserved.";
	const failures = [...summarizeFailures(workers), ...summarizeFailures(reviewers), ...summarizeFailures(finalResults)];
	const suffix = failures.length > 0 ? `\n\n> Partial result. Failed slots:\n> ${failures.join("\n> ")}` : "";
	const allResults = [...nonFinalResults, ...finalResults];
	const usage = aggregateUsage(allResults);
	const model = aggregateModel(allResults);
	notifyResult(options, `${body}${suffix}`, {
		text: body,
		changed: false,
		...(model ? { model } : {}),
		...(usage ? { usage } : {}),
	});
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

function notifyResult(options: BestOfNRunOptions, body: string, details?: { model?: string; usage?: DelegatedSubagentUsage; text?: string; changed?: boolean }): void {
	options.pi.sendMessage({
		customType: PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE,
		content: body,
		display: true,
		...(details && Object.keys(details).length > 0 ? { details } : {}),
	});
}

export async function executeBestOfNPrompt(options: BestOfNRunOptions): Promise<"completed" | "failed" | "cancelled"> {
	const cancellation = createCancellationScope(options.signal);
	let worktreeManager: BestOfNWorktreeManager | undefined;
	const workers: PhaseResult[] = [];
	const reviewers: PhaseResult[] = [];
	const finalResults: PhaseResult[] = [];
	const preservedWorkspaceRoots = new Set<string>();
	let registeredFinalTargetCwd: string | undefined;
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
		worktreeManager = createBestOfNWorktreeManager();
		if (options.config.finalApplier) {
			const targetCwd = await validateDelegatedCwd(options.ctx, finalTargetCwd(options));
			assertBestOfNSourceCwdNotIgnored(targetCwd);
			registeredFinalTargetCwd = worktreeManager.registerFinalTarget(targetCwd);
		}
		await assertNonFinalSlotCwdsNotIgnored(options, workerSlots, reviewerSlots);

		const workerRun = await runPhase(options, "worker", workerSlots, options.runtimeModel, "", cancellation.controller, worktreeManager);
		workers.push(...workerRun.results);
		addPreservedWorkspaceRoots(workerRun.results, preservedWorkspaceRoots);
		await captureCandidateChangeEvidence(workers);
		if (workerRun.cancellationError || workerRun.drainTimeoutError || cancellation.controller.signal.aborted) {
			notifyPreservedCandidateResult(options, workers, reviewers, finalResults);
			notify(options.ctx, "bestOfN delegation cancelled.", "warning");
			return "cancelled";
		}
		const workerEvidence = appendEvidence("\n\nCandidate answers:", "Candidate", workers);
		const workerSuccesses = workers.filter((result) => result.outcome && !result.error);
		if (workerSuccesses.length === 0) {
			notifyPreservedCandidateResult(options, workers, reviewers, finalResults);
			notify(options.ctx, `bestOfN produced no successful worker result.\n${summarizeFailures(workers).join("\n")}`, "error");
			return "failed";
		}

		if (reviewerSlots.length > 0) {
			const reviewerRun = await runPhase(options, "reviewer", reviewerSlots, options.runtimeModel, workerEvidence, cancellation.controller, worktreeManager);
			reviewers.push(...reviewerRun.results);
			addPreservedWorkspaceRoots(reviewerRun.results, preservedWorkspaceRoots);
			await captureCandidateChangeEvidence(reviewers);
			if (reviewerRun.cancellationError || reviewerRun.drainTimeoutError || cancellation.controller.signal.aborted) {
				notifyPreservedCandidateResult(options, workers, reviewers, finalResults);
				notify(options.ctx, "bestOfN delegation cancelled.", "warning");
				return "cancelled";
			}
		}
		const reviewEvidence = appendEvidence("\n\nReviewer findings:", "Review", reviewers);
		const finalEvidence = capEvidence(`${workerEvidence}${reviewEvidence}`);
		if (options.config.finalApplier) {
			try {
				worktreeManager.assertSourceBaselinesUnchanged();
			} catch (error) {
				notifyPreservedCandidateResult(options, workers, reviewers, finalResults);
				notify(options.ctx, `bestOfN failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return "failed";
			}
			const finalRun = await runPhase(options, "final-applier", [options.config.finalApplier], options.runtimeModel, finalEvidence, cancellation.controller, worktreeManager, registeredFinalTargetCwd);
			finalResults.push(...finalRun.results);
			addPreservedWorkspaceRoots(finalRun.results, preservedWorkspaceRoots);
			if (finalRun.cancellationError || finalRun.drainTimeoutError || cancellation.controller.signal.aborted) {
				notifyPreservedCandidateResult(options, workers, reviewers, finalResults);
				notify(options.ctx, "bestOfN delegation cancelled.", "warning");
				return "cancelled";
			}
		}
		const finalText = resultText(finalResults, "Final answer");
		if (options.config.finalApplier && finalText.length === 0) {
			const failures = summarizeFailures(finalResults);
			notifyPreservedCandidateResult(options, workers, reviewers, finalResults);
			notify(options.ctx, `bestOfN final applier produced no successful result.${failures.length > 0 ? `\n${failures.join("\n")}` : ""}`, "error");
			return "failed";
		}
		const reviewText = resultText(reviewers, "Review");
		const workerText = resultText(workers, "Candidate");
		const body = finalText || (hasCandidateChangeEvidence([...workers, ...reviewers]) ? nonFinalResultBody(workers, reviewers) : reviewText || workerText);
		const failures = [...summarizeFailures(workers), ...summarizeFailures(reviewers), ...summarizeFailures(finalResults)];
		const suffix = failures.length > 0 ? `\n\n> Partial result. Failed slots:\n> ${failures.join("\n> ")}` : "";
		const allResults = [...workers, ...reviewers, ...finalResults];
		const usage = aggregateUsage(allResults);
		const model = aggregateModel(allResults);
		notifyResult(options, `${body}${suffix}`, {
			text: body,
			changed: finalResults.some((result) => !result.error && result.outcome?.changed === true),
			...(model ? { model } : {}),
			...(usage ? { usage } : {}),
		});
		return "completed";
	} catch (error) {
		await captureCandidateChangeEvidence([...workers, ...reviewers]);
		if (error instanceof DelegatedPromptCancelledError || error instanceof DelegatedPromptCancellationDrainTimeoutError || options.signal?.aborted) {
			notifyPreservedCandidateResult(options, workers, reviewers, finalResults);
			notify(options.ctx, "bestOfN delegation cancelled.", "warning");
			return "cancelled";
		}
		notifyPreservedCandidateResult(options, workers, reviewers, finalResults);
		notify(options.ctx, `bestOfN failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return "failed";
	} finally {
		if (worktreeManager) {
			try {
				await captureCandidateChangeEvidence([...workers, ...reviewers]);
				const cleanupResult = worktreeManager.cleanup({ preserveRoots: [...preservedWorkspaceRoots] });
				for (const preservedWorktree of cleanupResult.preservedWorktrees) {
					notify(
						options.ctx,
						`bestOfN cancellation drain timed out; preserved active worker worktree at \`${preservedWorktree}\`${cleanupResult.preservedRunRoot ? ` and left temporary root \`${cleanupResult.preservedRunRoot}\`` : ""}.`,
						"warning",
					);
				}
			} catch (error) {
				notify(options.ctx, `bestOfN worker worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
		cancellation.cleanup();
	}
}
