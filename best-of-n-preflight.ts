import { lstatSync, realpathSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { extractLineupOverrides, extractSubagentOverride, parseCommandArgs, substituteArgs, type LineupOverrideAction } from "./args.js";
import { applyPresetDefaultModel, loadBestOfNPresetCatalog } from "./best-of-n-presets.js";
import type { DelegationLineupSlot, PromptLoaderDiagnostic, PromptRootKind, PromptSource, PromptWithModel } from "./prompt-loader.js";
import { expandCwdPath } from "./prompt-loader.js";
import { DEFAULT_SUBAGENT_NAME } from "./subagent-runtime.js";

export const BEST_OF_N_PREFLIGHT_SCHEMA_VERSION = 1;

const DEFAULT_COMPARE_REVIEWER_TASK = "Review the worker variants and produce findings only.\nRequired output:\n1. Summarize concrete strengths with patch/diff evidence, including worktree change summaries when present.\n2. Call out concrete correctness risks and regression risks.\n3. Recommend whether to apply one variant, synthesize several variants, or decline to apply.";
const DEFAULT_COMPARE_FINAL_APPLIER_TASK = "Apply the best implementation from the worker variants and reviewer findings.";

export type BestOfNPreflightSchemaVersion = typeof BEST_OF_N_PREFLIGHT_SCHEMA_VERSION;
export type BestOfNPreflightDiagnosticSeverity = "warning" | "error";
export type BestOfNPreflightSlotKind = "worker" | "reviewer" | "final-applier";
export type BestOfNPreflightSlotSource = "prompt" | "preset" | "default" | "runtime-override";
export type BestOfNPreflightCwdSource = "runtime-cwd" | "prompt-cwd" | "context-cwd" | "path-argument";
export type BestOfNPreflightPresetTrust = "none" | "user" | "project-approval-required" | "project-approved" | "not-found" | "invalid";
export type BestOfNPreflightCommitMode = "none" | "ask";
export type BestOfNPreflightCallCapStatus = "within-cap" | "exceeded" | "uncapped";

export interface BestOfNPreflightPromptIdentity {
	name: string;
	description: string;
	source: PromptSource;
	rootKind: PromptRootKind;
	filePath: string;
}

export interface BestOfNPreflightCompareCwd {
	resolved: string;
	source: BestOfNPreflightCwdSource;
	requested?: string;
	approvalCwd?: string;
}

export interface BestOfNPreflightPresetIdentity {
	name: string;
	trust: BestOfNPreflightPresetTrust;
	source?: PromptSource;
	filePath?: string;
	description?: string;
	defaultModel?: string;
	maxModelCalls?: number;
	runtimeOverride: boolean;
}

export interface BestOfNPreflightSlot extends DelegationLineupSlot {
	kind: BestOfNPreflightSlotKind;
	index: number;
	source: BestOfNPreflightSlotSource;
	effectiveModelLabel: string;
	effectiveTask?: string;
	expandedFromIndex?: number;
}

export interface BestOfNPreflightSlots {
	workers: BestOfNPreflightSlot[];
	reviewers: BestOfNPreflightSlot[];
	finalApplier?: BestOfNPreflightSlot;
}

export interface BestOfNPreflightModelLabels {
	base: string;
	workers: string[];
	reviewers: string[];
	finalApplier?: string;
}

export interface BestOfNPreflightTaskArgs {
	raw?: string;
	parsed: string[];
	renderedTask?: string;
}

export interface BestOfNPreflightWorktreePolicy {
	enabled: boolean;
	requiredByFinalApplier: boolean;
	workerCwdPolicy: "shared" | "independent";
}

export interface BestOfNPreflightFinalApplierPolicy {
	enabled: boolean;
	requiresWorktree: boolean;
}

export interface BestOfNPreflightCommitPolicy {
	mode: BestOfNPreflightCommitMode;
	approvalCwd?: string;
}

export interface BestOfNPreflightArtifactExpectations {
	report: {
		willWrite: boolean;
		root?: string;
	};
	rawArtifacts: {
		keepArtifacts: boolean;
		expectedFiles: string[];
	};
}

export interface BestOfNPreflightCallCount {
	workers: number;
	reviewers: number;
	finalApplier: number;
	total: number;
	cap?: number;
	capStatus: BestOfNPreflightCallCapStatus;
}

export interface BestOfNPreflightDiagnostic {
	severity: BestOfNPreflightDiagnosticSeverity;
	code: string;
	message: string;
	source?: PromptSource | "runtime" | "preset";
	filePath?: string;
}

export interface BestOfNPreflightPolicies {
	worktree: BestOfNPreflightWorktreePolicy;
	finalApplier: BestOfNPreflightFinalApplierPolicy;
	commit: BestOfNPreflightCommitPolicy;
}

export interface BestOfNPreflight {
	schemaVersion: BestOfNPreflightSchemaVersion;
	prompt: BestOfNPreflightPromptIdentity;
	compareCwd: BestOfNPreflightCompareCwd;
	preset?: BestOfNPreflightPresetIdentity;
	slots: BestOfNPreflightSlots;
	models: BestOfNPreflightModelLabels;
	task: BestOfNPreflightTaskArgs;
	policies: BestOfNPreflightPolicies;
	artifacts: BestOfNPreflightArtifactExpectations;
	callCount: BestOfNPreflightCallCount;
	diagnostics: BestOfNPreflightDiagnostic[];
}

export interface CreateBestOfNPreflightOptions {
	prompt: PromptWithModel;
	args: string;
	contextCwd: string;
	currentModelLabel?: string;
	projectPresetApproved?: boolean;
	pathArgumentPromptName?: string;
}

function diagnostic(severity: BestOfNPreflightDiagnosticSeverity, code: string, message: string, source?: PromptSource | "runtime" | "preset", filePath?: string): BestOfNPreflightDiagnostic {
	return { severity, code, message, ...(source ? { source } : {}), ...(filePath ? { filePath } : {}) };
}

function fromPresetDiagnostic(source: PromptLoaderDiagnostic): BestOfNPreflightDiagnostic {
	return {
		severity: "warning",
		code: source.code,
		message: source.message,
		source: source.source,
		filePath: source.filePath,
	};
}

function resolveCompareCwd(raw: string, contextCwd: string): string {
	return expandCwdPath(raw) ?? resolvePath(contextCwd, raw);
}

function canonicalizeDir(raw: string, diagnostics: BestOfNPreflightDiagnostic[], code: string, message: string): string {
	const resolved = resolvePath(raw);
	try {
		const stat = lstatSync(resolved);
		if (!stat.isDirectory()) {
			diagnostics.push(diagnostic("error", code, `${message}: ${resolved} is not a directory.`, "runtime", resolved));
			return resolved;
		}
		return realpathSync(resolved);
	} catch {
		diagnostics.push(diagnostic("error", code, `${message}: ${resolved}.`, "runtime", resolved));
		return resolved;
	}
}

function extractKeepArtifactsFlag(argsString: string): { args: string; keepArtifacts: boolean } {
	let keepArtifacts = false;
	const tokensToRemove: Array<{ start: number; end: number }> = [];
	let i = 0;
	while (i < argsString.length) {
		if (/\s/.test(argsString[i] ?? "")) {
			i += 1;
			continue;
		}
		const start = i;
		const quote = argsString[i];
		if (quote === "'" || quote === '"') {
			i += 1;
			while (i < argsString.length && argsString[i] !== quote) i += argsString[i] === "\\" ? 2 : 1;
			i += 1;
			continue;
		}
		while (i < argsString.length && !/\s/.test(argsString[i]!)) i += 1;
		if (argsString.slice(start, i) === "--keep-artifacts") {
			keepArtifacts = true;
			tokensToRemove.push({ start, end: i });
		}
	}
	let args = argsString;
	for (const range of tokensToRemove.sort((a, b) => b.start - a.start)) args = args.slice(0, range.start) + args.slice(range.end);
	return { args: args.trim(), keepArtifacts };
}

function cloneSlots(slots: DelegationLineupSlot[] | undefined): DelegationLineupSlot[] | undefined {
	return slots?.map((slot) => ({ ...slot }));
}

function applyLineupActions(defaultSlots: DelegationLineupSlot[] | undefined, defaultSource: BestOfNPreflightSlotSource, actions: LineupOverrideAction[], target: "workers" | "reviewers"): { slots?: DelegationLineupSlot[]; sources?: BestOfNPreflightSlotSource[] } {
	let slots = cloneSlots(defaultSlots);
	let sources = slots?.map((): BestOfNPreflightSlotSource => defaultSource);
	for (const action of actions) {
		if (action.target !== target) continue;
		const incoming = action.slots.map((slot) => ({ ...slot }));
		const incomingSources = incoming.map((): BestOfNPreflightSlotSource => "runtime-override");
		if (action.mode === "replace") {
			slots = incoming;
			sources = incomingSources;
		} else {
			slots = [...(slots ?? []), ...incoming];
			sources = [...(sources ?? []), ...incomingSources];
		}
	}
	return { slots, sources };
}


function applyFinalApplierAction(defaultSlot: DelegationLineupSlot | undefined, actions: LineupOverrideAction[]): { slot?: DelegationLineupSlot; source?: BestOfNPreflightSlotSource } {
	let slot = defaultSlot ? { ...defaultSlot } : undefined;
	let source: BestOfNPreflightSlotSource | undefined = slot ? "prompt" : undefined;
	for (const action of actions) {
		if (action.target !== "finalApplier") continue;
		slot = action.slots[0] ? { ...action.slots[0] } : undefined;
		source = slot ? "runtime-override" : undefined;
	}
	return { slot, source };
}

function expandSlots(slots: DelegationLineupSlot[], sources: BestOfNPreflightSlotSource[]): Array<{ slot: DelegationLineupSlot; source: BestOfNPreflightSlotSource; expandedFromIndex: number }> {
	const expanded: Array<{ slot: DelegationLineupSlot; source: BestOfNPreflightSlotSource; expandedFromIndex: number }> = [];
	for (let index = 0; index < slots.length; index += 1) {
		const { count, ...slot } = slots[index]!;
		for (let repeat = 0; repeat < (count ?? 1); repeat += 1) expanded.push({ slot: { ...slot }, source: sources[index] ?? "prompt", expandedFromIndex: index + 1 });
	}
	return expanded;
}

function slotModelLabel(slot: DelegationLineupSlot, baseModelLabel: string): string {
	return slot.model ?? baseModelLabel;
}

function buildLineupSlotTask(baseTask: string, slot: DelegationLineupSlot, taskArgs: string[]): string {
	const effectiveBaseTask = slot.task ? substituteArgs(slot.task, taskArgs) : baseTask;
	return slot.taskSuffix ? `${effectiveBaseTask}\n\n${substituteArgs(slot.taskSuffix, taskArgs)}` : effectiveBaseTask;
}

function toPreflightSlot(entry: { slot: DelegationLineupSlot; source: BestOfNPreflightSlotSource; expandedFromIndex: number }, kind: "worker" | "reviewer", index: number, baseTask: string, taskArgs: string[], baseModelLabel: string, defaultCwd: string, contextCwd: string, diagnostics: BestOfNPreflightDiagnostic[]): BestOfNPreflightSlot {
	const requestedCwd = entry.slot.cwd ? resolveCompareCwd(entry.slot.cwd, contextCwd) : defaultCwd;
	const cwd = canonicalizeDir(requestedCwd, diagnostics, "lineup-cwd-not-found", "cwd directory does not exist");
	return {
		...entry.slot,
		cwd,
		kind,
		index,
		source: entry.source,
		effectiveModelLabel: slotModelLabel(entry.slot, baseModelLabel),
		effectiveTask: buildLineupSlotTask(baseTask, entry.slot, taskArgs),
		expandedFromIndex: entry.expandedFromIndex,
	};
}

function expectedArtifacts(workers: number, reviewers: number, finalApplier: boolean): string[] {
	return [
		...Array.from({ length: workers }, (_, index) => `worker-${index + 1}.md`),
		...Array.from({ length: reviewers }, (_, index) => `reviewer-${index + 1}.md`),
		...(finalApplier ? ["final-applier.md"] : []),
	];
}

export function createBestOfNPreflight(options: CreateBestOfNPreflightOptions): BestOfNPreflight {
	const diagnostics: BestOfNPreflightDiagnostic[] = [];
	const runtime = extractSubagentOverride(options.args);
	const lineupExtraction = extractLineupOverrides(runtime.args);
	for (const error of lineupExtraction.errors) diagnostics.push(diagnostic("error", "invalid-lineup-override", error, "runtime"));
	const keepArtifactsExtraction = extractKeepArtifactsFlag(lineupExtraction.args);
	let taskArgs = parseCommandArgs(keepArtifactsExtraction.args);
	let compareCwdSource: BestOfNPreflightCwdSource = runtime.cwd ? "runtime-cwd" : options.prompt.cwd ? "prompt-cwd" : "context-cwd";
	let requestedCwd = runtime.cwd ?? options.prompt.cwd ?? options.contextCwd;
	if (options.pathArgumentPromptName && options.prompt.name === options.pathArgumentPromptName && taskArgs.length > 0) {
		requestedCwd = taskArgs[0]!;
		compareCwdSource = "path-argument";
		taskArgs = taskArgs.slice(1);
	}
	const compareCwd = canonicalizeDir(resolveCompareCwd(requestedCwd, options.contextCwd), diagnostics, "compare-cwd-not-found", "cwd directory does not exist");
	const baseModelLabel = runtime.model ?? options.prompt.models[0] ?? options.currentModelLabel ?? "session model";
	if (runtime.preset && !(options.prompt.workers !== undefined || options.prompt.reviewers !== undefined || options.prompt.finalApplier !== undefined || options.prompt.preset !== undefined)) {
		diagnostics.push(diagnostic("warning", "preset-ignored-for-non-compare-prompt", "--preset is only supported on compare prompts.", "runtime"));
	}
	const sharedTask = substituteArgs(options.prompt.content, taskArgs);
	if (!sharedTask.trim()) diagnostics.push(diagnostic("error", "empty-rendered-task", `Prompt \`${options.prompt.name}\` rendered to an empty message.`, options.prompt.source, options.prompt.filePath));

	const presetName = runtime.preset ?? options.prompt.preset;
	let presetIdentity: BestOfNPreflightPresetIdentity | undefined;
	let presetWorkers: DelegationLineupSlot[] | undefined;
	let presetReviewers: DelegationLineupSlot[] | undefined;
	let presetMaxModelCalls: number | undefined;
	if (presetName) {
		const catalog = loadBestOfNPresetCatalog(compareCwd);
		diagnostics.push(...catalog.diagnostics.map(fromPresetDiagnostic));
		const preset = catalog.presets.get(presetName);
		if (preset) {
			const trust: BestOfNPreflightPresetTrust = preset.source === "user" ? "user" : options.projectPresetApproved ? "project-approved" : "project-approval-required";
			presetIdentity = {
				name: preset.name,
				trust,
				source: preset.source,
				filePath: preset.filePath,
				description: preset.description,
				defaultModel: preset.defaultModel,
				maxModelCalls: preset.maxModelCalls,
				runtimeOverride: runtime.preset !== undefined,
			};
			if (trust === "project-approval-required") diagnostics.push(diagnostic("warning", "project-preset-approval-required", "Project preset requires session approval before execution.", "preset", preset.filePath));
			presetWorkers = applyPresetDefaultModel(preset.workers, preset.defaultModel);
			presetReviewers = applyPresetDefaultModel(preset.reviewers, preset.defaultModel);
			presetMaxModelCalls = preset.maxModelCalls;
		} else {
			presetIdentity = { name: presetName, trust: catalog.projectFileInvalid || catalog.invalidPresetNames.has(presetName) ? "invalid" : "not-found", runtimeOverride: runtime.preset !== undefined };
			diagnostics.push(diagnostic("error", catalog.projectFileInvalid || catalog.invalidPresetNames.has(presetName) ? "invalid-best-of-n-preset-selected" : "best-of-n-preset-not-found", `Best-of-N preset \`${presetName}\` was not found in the effective preset catalog.`, "preset"));
		}
	}

	const workerDefaults = presetWorkers ?? options.prompt.workers;
	const reviewerDefaults = presetReviewers ?? options.prompt.reviewers;
	const presetSlotSource: BestOfNPreflightSlotSource = presetWorkers || presetReviewers ? "preset" : "prompt";
	const workerResolution = applyLineupActions(workerDefaults, presetWorkers ? "preset" : "prompt", lineupExtraction.actions, "workers");
	const reviewerResolution = applyLineupActions(reviewerDefaults, presetReviewers ? "preset" : "prompt", lineupExtraction.actions, "reviewers");
	const requestedWorkers = workerResolution.slots && workerResolution.slots.length > 0 ? workerResolution.slots : [{ agent: DEFAULT_SUBAGENT_NAME }];
	const requestedWorkerSources = workerResolution.slots && workerResolution.slots.length > 0 ? (workerResolution.sources ?? requestedWorkers.map(() => presetSlotSource)) : requestedWorkers.map((): BestOfNPreflightSlotSource => "default");
	const requestedReviewers = reviewerResolution.slots && reviewerResolution.slots.length > 0 ? reviewerResolution.slots : [{ agent: "reviewer" }];
	const requestedReviewerSources = reviewerResolution.slots && reviewerResolution.slots.length > 0 ? (reviewerResolution.sources ?? requestedReviewers.map(() => presetSlotSource)) : requestedReviewers.map((): BestOfNPreflightSlotSource => "default");
	const finalResolution = applyFinalApplierAction(options.prompt.finalApplier, lineupExtraction.actions);
	if (finalResolution.slot && options.prompt.worktree !== true) diagnostics.push(diagnostic("error", "compare-final-applier-requires-worktree", "Compare prompts with finalApplier require worktree: true.", options.prompt.source, options.prompt.filePath));

	const workerEntries = expandSlots(requestedWorkers, requestedWorkerSources);
	const reviewerEntries = expandSlots(requestedReviewers, requestedReviewerSources);
	const workers = workerEntries.map((entry, index) => toPreflightSlot(entry, "worker", index + 1, sharedTask, taskArgs, baseModelLabel, compareCwd, options.contextCwd, diagnostics));
	const reviewers = reviewerEntries.map((entry, index) => toPreflightSlot(entry, "reviewer", index + 1, DEFAULT_COMPARE_REVIEWER_TASK, taskArgs, baseModelLabel, compareCwd, options.contextCwd, diagnostics));
	if (options.prompt.worktree === true && new Set(workers.map((slot) => slot.cwd)).size > 1) {
		diagnostics.push(diagnostic("error", "compare-worktree-mixed-worker-cwd", "worktree compare runs require all worker slots to use the same cwd.", options.prompt.source, options.prompt.filePath));
	}
	const finalApplier: BestOfNPreflightSlot | undefined = finalResolution.slot ? {
		...finalResolution.slot,
		cwd: compareCwd,
		kind: "final-applier",
		index: 1,
		source: finalResolution.source ?? "prompt",
		effectiveModelLabel: slotModelLabel(finalResolution.slot, baseModelLabel),
		effectiveTask: buildLineupSlotTask(DEFAULT_COMPARE_FINAL_APPLIER_TASK, finalResolution.slot, taskArgs),
	} : undefined;
	const callCount: BestOfNPreflightCallCount = {
		workers: workers.length,
		reviewers: reviewers.length,
		finalApplier: finalApplier ? 1 : 0,
		total: workers.length + reviewers.length + (finalApplier ? 1 : 0),
		...(presetMaxModelCalls !== undefined ? { cap: presetMaxModelCalls } : {}),
		capStatus: presetMaxModelCalls === undefined ? "uncapped" : workers.length + reviewers.length + (finalApplier ? 1 : 0) > presetMaxModelCalls ? "exceeded" : "within-cap",
	};
	if (callCount.cap !== undefined && callCount.capStatus === "exceeded") {
		diagnostics.push(diagnostic("error", "best-of-n-preset-cap-exceeded", `Best-of-N preset model-call cap exceeded: requested ${callCount.total} call(s), but preset allows ${callCount.cap}.`, "preset", presetIdentity?.filePath));
	}
	return {
		schemaVersion: BEST_OF_N_PREFLIGHT_SCHEMA_VERSION,
		prompt: {
			name: options.prompt.name,
			description: options.prompt.description,
			source: options.prompt.source,
			rootKind: options.prompt.rootKind,
			filePath: options.prompt.filePath,
		},
		compareCwd: {
			resolved: compareCwd,
			source: compareCwdSource,
			requested: requestedCwd,
			approvalCwd: options.prompt.commit === "ask" ? compareCwd : undefined,
		},
		...(presetIdentity ? { preset: presetIdentity } : {}),
		slots: { workers, reviewers, ...(finalApplier ? { finalApplier } : {}) },
		models: {
			base: baseModelLabel,
			workers: workers.map((slot) => slot.effectiveModelLabel),
			reviewers: reviewers.map((slot) => slot.effectiveModelLabel),
			...(finalApplier ? { finalApplier: finalApplier.effectiveModelLabel } : {}),
		},
		task: {
			raw: keepArtifactsExtraction.args,
			parsed: taskArgs,
			renderedTask: sharedTask,
		},
		policies: {
			worktree: {
				enabled: options.prompt.worktree === true,
				requiredByFinalApplier: finalApplier !== undefined,
				workerCwdPolicy: options.prompt.worktree === true ? "shared" : "independent",
			},
			finalApplier: {
				enabled: finalApplier !== undefined,
				requiresWorktree: finalApplier !== undefined,
			},
			commit: {
				mode: options.prompt.commit ?? "none",
				approvalCwd: options.prompt.commit === "ask" ? compareCwd : undefined,
			},
		},
		artifacts: {
			report: {
				willWrite: true,
				root: join(compareCwd, ".pi", "runs", "best-of-n"),
			},
			rawArtifacts: {
				keepArtifacts: keepArtifactsExtraction.keepArtifacts,
				expectedFiles: expectedArtifacts(workers.length, reviewers.length, finalApplier !== undefined),
			},
		},
		callCount,
		diagnostics,
	};
}
