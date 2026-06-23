import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	extractChainContextFlag,
	extractLineupOverrides,
	extractLoopCount,
	extractLoopFlags,
	extractSubagentOverride,
	extractWorktreeFlag,
	parseCommandArgs,
	substituteArgs,
	type LineupOverrideAction,
	type SubagentOverride,
} from "./args.js";
import { loadBestOfNPresetCatalog, applyPresetDefaultModel, type ResolvedBestOfNPreset } from "./best-of-n-presets.js";
import { parseChainSteps, parseChainDeclaration, type ChainStep, type ChainStepOrParallel, type ParallelChainStep } from "./chain-parser.js";
import { generateBoomerangSummary, generateChainStepSummary, generateIterationSummary, didIterationMakeChanges, getIterationEntries, wasIterationAborted } from "./loop-utils.js";
import { selectModelCandidate } from "./model-selection.js";
import { notify, summarizePromptDiagnostics, diagnosticsFingerprint } from "./notifications.js";
import { preparePromptExecution, renderPromptForResolvedModel } from "./prompt-execution.js";
import {
	buildPromptCommandDescription,
	expandCwdPath,
	formatPromptSourceLabel,
	loadPromptsWithModel,
	type DelegationLineupSlot,
	type PromptWithModel,
} from "./prompt-loader.js";
import {
	buildSkillLoadedMessage,
	getRequestedSkills,
	resolvePromptSkills,
	type PendingSkillMessage,
	type RuntimeSkillCommand,
} from "./prompt-skills.js";
import { renderSkillLoaded } from "./skill-loaded-renderer.js";
import { createToolManager } from "./tool-manager.js";
import { executeSubagentPromptStep, type DelegatedPromptParallelResult, type PreparedDelegatedTask } from "./subagent-step.js";
import { DEFAULT_SUBAGENT_NAME, PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE } from "./subagent-runtime.js";
import { renderDelegatedSubagentResult } from "./subagent-renderer.js";
import {
	PROMPT_TEMPLATE_DETERMINISTIC_COMPLETION_MESSAGE_TYPE,
	PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE,
	buildDeterministicPreamble,
	runDeterministicStep,
	shouldHandoffToLlm,
} from "./deterministic-step.js";
import { renderDeterministicCompletion, renderDeterministicResult } from "./deterministic-renderer.js";
import { PROMPT_TEMPLATE_COMMIT_ASK_MESSAGE_TYPE, renderCommitAskMessage } from "./commit-ask-renderer.js";
import { formatBestOfNPresetCatalog } from "./best-of-n-preset-renderer.js";
import { collectBestOfNRunHistory, parseBestOfNRunHistoryArgs, type BestOfNRunHistoryResult } from "./best-of-n-run-history.js";
import { formatBestOfNRunDetail, formatBestOfNRunHistory } from "./best-of-n-run-history-renderer.js";
import {
	CompareRunDetailInspector,
	CompareRunPicker,
	buildCompareRunCatalog,
	createCompareRunDetailViewModel,
	type CompareRunHistoryTuiResult,
} from "./best-of-n-run-history-tui.js";
import { formatPromptValidationReport, validatePromptTemplates, type RegisteredPromptSkill } from "./prompt-validation.js";
import {
	DRY_RUN_CHAIN_UNSUPPORTED,
	DRY_RUN_DETERMINISTIC_UNSUPPORTED,
	createPromptDryRun,
	parseDryRunCommand,
	type PromptDryRunResult,
} from "./prompt-dry-run.js";
import { formatPromptDryRun } from "./prompt-dry-run-renderer.js";
import {
	PromptDryRunInspector,
	PromptDryRunPicker,
	createPromptDryRunTuiViewModel,
	type PromptDryRunTuiResult,
	type PromptTemplateCatalogItem,
} from "./prompt-dry-run-tui.js";

interface LoopState {
	currentIteration: number;
	totalIterations: number | null;
	rotationLabel?: string;
}

type ReportLineupSlot = DelegationLineupSlot & { effectiveModel: string; effectiveTask: string };

interface GitSnapshot {
	head?: string;
	status?: string;
	diffStat?: string;
	shortStat?: string;
	diffRaw?: string;
	stagedRaw?: string;
	diffFingerprint?: string;
	stagedNameStatus?: string;
}

interface FreshCollapse {
	targetId: string;
	task: string;
	iteration: number;
	totalIterations: number | null;
}

interface BoomerangCollapse {
	targetId: string;
	task: string;
	previousSummaries: string[];
}

interface ExecutionErrorState {
	hasError: boolean;
	error: unknown;
}

interface PromptStepResult {
	changed: boolean;
	text?: string;
}

const DEFAULT_COMPARE_REVIEWER_TASK = [
	"Review the worker variants and produce findings only.",
	"Required output:",
	"1. Summarize concrete strengths with patch/diff evidence, including worktree change summaries when present.",
	"2. Call out concrete correctness risks and regression risks.",
	"3. Extract cherry-pick ideas from non-winning variants.",
	"4. Do not rank variants or select a winner.",
	"5. Do not include manual apply commands.",
].join("\n");

const DEFAULT_COMPARE_FINAL_APPLIER_TASK = [
	"Apply the final implementation directly in the current repo.",
	"Required output:",
	"1. Pick the best single variant or synthesize/cherry-pick across variants.",
	"2. Apply changes directly on the current branch.",
	"3. Keep edits minimal and focused on the implementation task.",
	"4. Run obvious relevant verification when practical.",
	"5. Report changed files and verification commands run.",
].join("\n");

export default function promptModelExtension(pi: ExtensionAPI) {
	let prompts = new Map<string, PromptWithModel>();
	let chainPrompts = new Map<string, PromptWithModel>();
	let previousModel: Model<any> | undefined;
	let previousThinking: ThinkingLevel | undefined;
	let pendingSkillMessage: PendingSkillMessage | undefined;
	let runtimeModel: Model<any> | undefined;
	let chainActive = false;
	let loopState: LoopState | null = null;
	let freshCollapse: FreshCollapse | null = null;
	let boomerangCollapse: BoomerangCollapse | null = null;
	let accumulatedSummaries: string[] = [];
	let lastDiagnostics = "";
	let storedCommandCtx: ExtensionCommandContext | null = null;
	const approvedProjectPromptLibraryCwds = new Set<string>();
	const approvedProjectPresetCwds = new Set<string>();
	const UNLIMITED_LOOP_CAP = 999;

	const toolManager = createToolManager(pi, {
		isActive: () => !!(loopState || chainActive),
		getStoredCtx: () => storedCommandCtx,
		setStoredCtx: (ctx) => {
			storedCommandCtx = ctx;
		},
		executeCommand: executeToolCommand,
	});

	function sameModel(a: Model<any> | undefined, b: Model<any> | undefined): boolean {
		if (!a || !b) return a === b;
		return a.provider === b.provider && a.id === b.id;
	}

	function getCurrentModel(ctx: Pick<ExtensionContext, "model">): Model<any> | undefined {
		return runtimeModel ?? ctx.model;
	}

	function getCurrentModelLabel(ctx: Pick<ExtensionContext, "model">): string | undefined {
		const model = getCurrentModel(ctx);
		if (!model) return undefined;
		return model.provider && model.id ? `${model.provider}/${model.id}` : model.id;
	}

	function isProjectPromptLibraryPrompt(prompt: PromptWithModel): boolean {
		return prompt.source === "project" && prompt.rootKind === "prompt-library";
	}

	async function ensureProjectPromptLibraryApproved(prompt: PromptWithModel, ctx: ExtensionCommandContext): Promise<boolean> {
		if (!isProjectPromptLibraryPrompt(prompt)) return true;
		// Pi core trust has historically covered only core-known project resources
		// (for example .pi/prompts), not extension-defined .pi/prompt-library
		// commands. Keep a prompt-library-specific session approval instead of
		// relying on ctx.isProjectTrusted(), which can be true for unrelated roots.

		const cwdKey = resolvePath(ctx.cwd);
		if (approvedProjectPromptLibraryCwds.has(cwdKey)) return true;

		const message =
			`Project prompt-library command \`${prompt.name}\` is loaded from ${prompt.filePath}. ` +
			"Pi core project trust may not cover .pi/prompt-library in this version. Approve running project prompt-library commands for this session?";

		if (!ctx.hasUI || typeof (ctx.ui as { confirm?: unknown }).confirm !== "function") {
			notify(ctx, `${message} Run in an interactive UI session and approve it, or move trusted commands to .pi/prompts.`, "error");
			return false;
		}

		const approved = await ctx.ui.confirm("Approve project prompt-library command", message, { timeout: 30_000 });
		if (!approved) {
			notify(ctx, `Project prompt-library command \`${prompt.name}\` was not approved.`, "warning");
			return false;
		}

		approvedProjectPromptLibraryCwds.add(cwdKey);
		return true;
	}

	async function ensureProjectPromptLibraryStepsApproved(promptsToCheck: PromptWithModel[], ctx: ExtensionCommandContext): Promise<boolean> {
		const seen = new Set<string>();
		for (const prompt of promptsToCheck) {
			const key = prompt.filePath;
			if (seen.has(key)) continue;
			seen.add(key);
			if (!(await ensureProjectPromptLibraryApproved(prompt, ctx))) return false;
		}
		return true;
	}

	async function ensureProjectPresetApproved(preset: ResolvedBestOfNPreset, ctx: ExtensionCommandContext, catalogCwd: string): Promise<boolean> {
		if (preset.source !== "project") return true;
		const cwdKey = resolvePath(catalogCwd);
		if (approvedProjectPresetCwds.has(cwdKey)) return true;
		const message = `Best-of-N preset \`${preset.name}\` is loaded from ${preset.filePath}. Approve project best-of-N presets for this session?`;
		if (!ctx.hasUI || typeof (ctx.ui as { confirm?: unknown }).confirm !== "function") {
			notify(ctx, `${message} Run in an interactive UI session and approve it, or move trusted presets to ~/.pi/agent/best-of-n-presets.json.`, "error");
			return false;
		}
		const approved = await ctx.ui.confirm("Approve project best-of-N preset", message, { timeout: 30_000 });
		if (!approved) {
			notify(ctx, `Project best-of-N preset \`${preset.name}\` was not approved.`, "warning");
			return false;
		}
		approvedProjectPresetCwds.add(cwdKey);
		return true;
	}

	async function resolveBestOfNPresetLineup(
		prompt: PromptWithModel,
		runtimePreset: string | undefined,
		ctx: ExtensionCommandContext,
		catalogCwd: string,
	): Promise<{ workers?: DelegationLineupSlot[]; reviewers?: DelegationLineupSlot[]; maxModelCalls?: number } | undefined> {
		const presetName = runtimePreset ?? prompt.preset;
		if (!presetName) return {};
		const catalog = loadBestOfNPresetCatalog(catalogCwd);
		for (const diagnostic of catalog.diagnostics) {
			notify(ctx, diagnostic.message, "warning");
		}
		const preset = catalog.presets.get(presetName);
		if (!preset) {
			notify(ctx, `Best-of-N preset \`${presetName}\` was not found. Define it in ~/.pi/agent/best-of-n-presets.json or .pi/best-of-n-presets.json.`, "error");
			return undefined;
		}
		if (!(await ensureProjectPresetApproved(preset, ctx, catalogCwd))) return undefined;
		return {
			workers: applyPresetDefaultModel(preset.workers, preset.defaultModel),
			reviewers: applyPresetDefaultModel(preset.reviewers, preset.defaultModel),
			maxModelCalls: preset.maxModelCalls,
		};
	}

	pi.registerMessageRenderer<SkillLoadedDetails>("skill-loaded", renderSkillLoaded);
	pi.registerMessageRenderer(PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE, renderDelegatedSubagentResult);
	pi.registerMessageRenderer(PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE, renderDeterministicResult);
	pi.registerMessageRenderer(PROMPT_TEMPLATE_DETERMINISTIC_COMPLETION_MESSAGE_TYPE, renderDeterministicCompletion);
	pi.registerMessageRenderer(PROMPT_TEMPLATE_COMMIT_ASK_MESSAGE_TYPE, renderCommitAskMessage);

	function registerPromptCommand(name: string) {
		pi.registerCommand(name, {
			description: buildPromptCommandDescription(prompts.get(name)!),
			handler: async (args, ctx) => {
				await runPromptCommand(name, args, ctx);
			},
		});
	}

	function refreshPrompts(cwd: string, ctx?: ExtensionContext) {
		const result = loadPromptsWithModel(cwd);
		const chainResult = loadPromptsWithModel(cwd, true);
		prompts = result.prompts;
		chainPrompts = chainResult.prompts;

		for (const [name, prompt] of prompts) {
			if (prompt.hidden) continue;
			registerPromptCommand(name);
		}

		const summary = summarizePromptDiagnostics(result.diagnostics);
		const fingerprint = diagnosticsFingerprint(result.diagnostics);
		if (summary && fingerprint !== lastDiagnostics) {
			notify(ctx, summary, "warning");
		}
		lastDiagnostics = fingerprint;
	}

	function consumePendingSkillMessage() {
		if (!pendingSkillMessage) return undefined;
		const message = pendingSkillMessage;
		pendingSkillMessage = undefined;
		return message;
	}

	function collectRegisteredPromptSkills(): RegisteredPromptSkill[] {
		const skills: RegisteredPromptSkill[] = [];
		for (const command of pi.getCommands()) {
			if (command.source !== "skill") continue;
			const normalizedSkillName = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
			if (!normalizedSkillName) continue;
			const sourceInfo = "sourceInfo" in command
				? (command as { sourceInfo?: { path?: string } }).sourceInfo
				: undefined;
			const skillPath = sourceInfo?.path;
			if (!skillPath) continue;
			skills.push({ skillName: normalizedSkillName, skillPath });
		}
		return skills;
	}

	async function waitForTurnStart(ctx: ExtensionContext) {
		while (ctx.isIdle()) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	function shouldDelegatePrompt(prompt: PromptWithModel, override?: SubagentOverride): boolean {
		return prompt.subagent !== undefined || override?.enabled === true;
	}

	function isParallelChainStep(step: ChainStepOrParallel): step is ParallelChainStep {
		return "parallel" in step;
	}

	async function executePromptStep(
		prompt: PromptWithModel,
		args: string[],
		ctx: ExtensionCommandContext,
		currentModel: Model<any> | undefined,
		override?: SubagentOverride,
		inheritedModel?: Model<any>,
		taskPreamble?: string,
		loopContext?: string,
	): Promise<PromptStepResult | "aborted"> {
		if (!(await ensureProjectPromptLibraryApproved(prompt, ctx))) return "aborted";

		const requestedSkills = getRequestedSkills(prompt);
		const skillResolution = resolvePromptSkills(requestedSkills, ctx.cwd, pi.getCommands() as RuntimeSkillCommand[]);
		if (skillResolution.kind === "error") {
			notify(ctx, skillResolution.error, "error");
			return "aborted";
		}
		let deterministicPreamble: string | undefined;
		if (prompt.deterministic) {
			try {
				const deterministicResult = await runDeterministicStep(prompt, prompt.deterministic, ctx.cwd);
				const deterministicPreambleText = buildDeterministicPreamble(deterministicResult);
				pi.sendMessage({
					customType: PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE,
					content: deterministicPreambleText,
					display: true,
					details: deterministicResult,
				});
				if (!shouldHandoffToLlm(prompt.deterministic, deterministicResult)) {
					pi.sendMessage({
						customType: PROMPT_TEMPLATE_DETERMINISTIC_COMPLETION_MESSAGE_TYPE,
						content: `[Deterministic complete: ${prompt.name}]`,
						display: true,
						details: {
							promptName: prompt.name,
							exitCode: deterministicResult.exitCode,
							timedOut: deterministicResult.timedOut,
							status: deterministicResult.exitCode === 0 ? "succeeded" : "failed",
						},
					});
					return { changed: false };
				}
				deterministicPreamble = deterministicPreambleText;
			} catch (error) {
				notify(ctx, `Deterministic step failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return "aborted";
			}
		}

		const combinedTaskPreamble = [taskPreamble, deterministicPreamble].filter(Boolean).join("\n\n");

		if (shouldDelegatePrompt(prompt, override)) {
			try {
				const delegated =
					prompt.parallel && prompt.parallel > 1
						? await executeSubagentPromptStep({
							pi,
							ctx,
							currentModel,
							override,
							signal: ctx.signal,
							inheritedModel,
							taskPreamble: combinedTaskPreamble || undefined,
							parallel: Array.from({ length: prompt.parallel }, (_, index) => ({
								prompt,
								args,
								taskPrefix: `[Parallel subagent ${index + 1}/${prompt.parallel}]`,
							})),
							worktree: prompt.worktree === true,
						})
						: await executeSubagentPromptStep({
							pi,
							prompt,
							args,
							ctx,
							currentModel,
							override,
							signal: ctx.signal,
							inheritedModel,
							taskPreamble: combinedTaskPreamble || undefined,
						});
				if (!delegated) {
					notify(ctx, `Prompt \`${prompt.name}\` is not configured for delegated execution.`, "error");
					return "aborted";
				}
				return { changed: delegated.changed, text: delegated.text };
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
				return { changed: false };
			}
		}

		const prepared =
			inheritedModel === undefined
				? await preparePromptExecution(prompt, args, currentModel, ctx.modelRegistry)
				: await preparePromptExecution(prompt, args, currentModel, ctx.modelRegistry, { inheritedModel });
		if (!prepared) {
			notify(ctx, `No available model from: ${prompt.models.join(", ")}`, "error");
			return "aborted";
		}
		if ("message" in prepared) {
			if (prepared.warning) notify(ctx, prepared.warning, "warning");
			notify(ctx, prepared.message, "error");
			return "aborted";
		}
		if (prepared.warning) {
			notify(ctx, prepared.warning, "warning");
		}

		if (!prepared.selectedModel.alreadyActive) {
			const switched = await pi.setModel(prepared.selectedModel.model);
			if (!switched) {
				notify(ctx, `Failed to switch to model ${prepared.selectedModel.model.provider}/${prepared.selectedModel.model.id}`, "error");
				return "aborted";
			}
			runtimeModel = prepared.selectedModel.model;
		}

		if (prompt.thinking) {
			pi.setThinkingLevel(prompt.thinking);
		}
		pendingSkillMessage = skillResolution.kind === "ready" ? buildSkillLoadedMessage(skillResolution.skills) : undefined;

		const startId = ctx.sessionManager.getLeafId();
		const effectiveContent = combinedTaskPreamble
			? `${combinedTaskPreamble}\n\n${prepared.content}`
			: prepared.content;
		const content = loopContext ? `[${loopContext}]\n\n${effectiveContent}` : effectiveContent;
		pi.sendUserMessage(content);
		await waitForTurnStart(ctx);
		await ctx.waitForIdle();

		const entries = getIterationEntries(ctx, startId);
		if (wasIterationAborted(entries)) return "aborted";
		return { changed: didIterationMakeChanges(entries) };
	}

	async function restoreSessionState(
		ctx: ExtensionContext,
		originalModel: Model<any> | undefined,
		originalThinking: ThinkingLevel | undefined,
		currentModel?: Model<any>,
		currentThinking?: ThinkingLevel,
	) {
		const restoredParts: string[] = [];
		const shouldRestoreThinking =
			originalThinking !== undefined && (currentThinking === undefined || currentThinking !== originalThinking);

		if (originalModel && !sameModel(originalModel, currentModel)) {
			const restoredModel = await pi.setModel(originalModel);
			if (restoredModel) {
				runtimeModel = originalModel;
				restoredParts.push(originalModel.id);
			} else {
				notify(ctx, `Failed to restore model ${originalModel.provider}/${originalModel.id}`, "error");
			}
		}
		if (shouldRestoreThinking) {
			restoredParts.push(`thinking:${originalThinking}`);
			pi.setThinkingLevel(originalThinking);
		}
		if (restoredParts.length > 0) {
			notify(ctx, `Restored to ${restoredParts.join(", ")}`, "info");
		}
	}

	async function restoreAfterExecution(
		ctx: ExtensionContext,
		shouldRestore: boolean,
		originalModel: Model<any> | undefined,
		originalThinking: ThinkingLevel | undefined,
		currentModel: Model<any> | undefined,
		currentThinking: ThinkingLevel | undefined,
		errorState: ExecutionErrorState,
		phase: "loop" | "chain",
	): Promise<ExecutionErrorState> {
		if (!shouldRestore) return errorState;

		try {
			await restoreSessionState(ctx, originalModel, originalThinking, currentModel, currentThinking);
		} catch (error) {
			if (errorState.hasError) {
				notify(
					ctx,
					`Failed to restore session state after ${phase} error: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return errorState;
			}
			return { hasError: true, error };
		}

		return errorState;
	}

	function notifyLoopCompletion(
		ctx: ExtensionContext,
		completedIterations: number,
		totalIterations: number | null,
		effectiveMax: number,
		converged: boolean,
		requireMultipleIterations: boolean,
	) {
		if (converged) {
			const convergedLabel = totalIterations !== null ? `${completedIterations}/${totalIterations}` : `${completedIterations}`;
			notify(ctx, `Loop converged at ${convergedLabel} (no changes)`, "info");
			return;
		}

		if (completedIterations === 0) return;
		if (requireMultipleIterations && effectiveMax <= 1) return;

		if (totalIterations !== null) {
			notify(ctx, `Loop finished: ${completedIterations}/${totalIterations} iterations`, "info");
			return;
		}
		if (completedIterations === effectiveMax) {
			notify(ctx, `Loop finished: ${completedIterations} iterations (cap reached)`, "info");
			return;
		}
		notify(ctx, `Loop finished: ${completedIterations} iterations`, "info");
	}

	function updateLoopStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (loopState) {
			const suffix = loopState.rotationLabel ? ` · ${loopState.rotationLabel}` : "";
			const label =
				loopState.totalIterations !== null
					? `loop ${loopState.currentIteration}/${loopState.totalIterations}${suffix}`
					: `loop ${loopState.currentIteration}${suffix}`;
			ctx.ui.setStatus("prompt-loop", ctx.ui.theme.fg("warning", label));
		} else {
			ctx.ui.setStatus("prompt-loop", undefined);
		}
	}

	async function executeToolCommand(command: string, ctx: ExtensionCommandContext) {
		const stripped = command.startsWith("/") ? command.slice(1) : command;
		const spaceIdx = stripped.indexOf(" ");
		const name = spaceIdx >= 0 ? stripped.slice(0, spaceIdx) : stripped;
		const args = spaceIdx >= 0 ? stripped.slice(spaceIdx + 1) : "";

		if (name === "chain-prompts") {
			await runChainCommand(args, ctx);
		} else {
			await runPromptCommand(name, args, ctx);
		}
	}

	function cloneLineup(slots: DelegationLineupSlot[] | undefined): DelegationLineupSlot[] | undefined {
		return slots?.map((slot) => ({ ...slot }));
	}

	function expandedLineupCallCount(slots: DelegationLineupSlot[]): number {
		let total = 0;
		for (const slot of slots) total += slot.count ?? 1;
		return total;
	}

	function expandLineupCounts(slots: DelegationLineupSlot[]): DelegationLineupSlot[] {
		const expanded: DelegationLineupSlot[] = [];
		for (const slot of slots) {
			const { count, ...concreteSlot } = slot;
			for (let index = 0; index < (count ?? 1); index++) {
				expanded.push({ ...concreteSlot });
			}
		}
		return expanded;
	}

	function applyLineupActions(
		defaultSlots: DelegationLineupSlot[] | undefined,
		actions: LineupOverrideAction[],
		target: "workers" | "reviewers",
	): DelegationLineupSlot[] | undefined {
		let lineup = cloneLineup(defaultSlots);
		for (const action of actions) {
			if (action.target !== target) continue;
			const incoming = action.slots.map((slot) => ({ ...slot }));
			lineup = action.mode === "replace" ? incoming : [...(lineup ?? []), ...incoming];
		}
		return lineup;
	}

	function applyFinalApplierAction(
		defaultSlot: DelegationLineupSlot | undefined,
		actions: LineupOverrideAction[],
	): DelegationLineupSlot | undefined {
		let slot = defaultSlot ? { ...defaultSlot } : undefined;
		for (const action of actions) {
			if (action.target !== "finalApplier") continue;
			slot = action.slots[0] ? { ...action.slots[0] } : undefined;
		}
		return slot;
	}

	async function resolveCompareBaseModel(
		prompt: PromptWithModel,
		currentModel: Model<any> | undefined,
		ctx: ExtensionCommandContext,
		modelOverride?: string,
	): Promise<Model<any> | undefined> {
		const requestedModels = modelOverride ? [modelOverride] : prompt.models;
		if (requestedModels.length > 0) {
			const selected = await selectModelCandidate(requestedModels, currentModel, ctx.modelRegistry);
			if (!selected) {
				notify(ctx, `No available model from: ${requestedModels.join(", ")}`, "error");
				return undefined;
			}
			return selected.model;
		}
		if (currentModel) return currentModel;
		notify(ctx, `Prompt \`${prompt.name}\` requires an active model or a runtime --model override.`, "error");
		return undefined;
	}

	function resolveCompareCwd(raw: string, ctx: ExtensionCommandContext): string {
		return expandCwdPath(raw) ?? resolvePath(ctx.cwd, raw);
	}

	function normalizeLineupCwds(
		slots: DelegationLineupSlot[],
		defaultCwd: string,
		ctx: ExtensionCommandContext,
	): DelegationLineupSlot[] | undefined {
		const normalized: DelegationLineupSlot[] = [];
		for (const slot of slots) {
			const slotCwd = slot.cwd ? resolveCompareCwd(slot.cwd, ctx) : defaultCwd;
			if (!existsSync(slotCwd)) {
				notify(ctx, `cwd directory does not exist: ${slotCwd}`, "error");
				return undefined;
			}
			normalized.push({
				...slot,
				cwd: slotCwd,
			});
		}
		return normalized;
	}

	function formatCompareSlotLabel(slot: DelegationLineupSlot, fallbackAgent: string): string {
		return slot.model ? `${fallbackAgent}, ${slot.model}` : fallbackAgent;
	}

	function renderComparePhaseResults(
		label: string,
		entries: Array<{ index: number; slot: DelegationLineupSlot; result: DelegatedPromptParallelResult }>,
	): string {
		return entries
			.map(({ index, slot, result }) => {
				const body = result.text || "(no assistant text)";
				return `=== ${label} ${index + 1} (${formatCompareSlotLabel(slot, result.agent)}) ===\n${body}`;
			})
			.join("\n\n");
	}

	function formatPhaseFailureSummary(
		label: string,
		entries: Array<{ index: number; slot: DelegationLineupSlot; result: DelegatedPromptParallelResult }>,
	): string | undefined {
		if (entries.length === 0) return undefined;
		return [
			`[${label} failures]`,
			...entries.map(({ index, slot, result }) =>
				`- ${label} ${index + 1} (${formatCompareSlotLabel(slot, result.agent)}): ${result.errorText || "unknown delegated error"}`,
			),
		].join("\n");
	}

	function extractSuccessfulWorktreeChanges(aggregateText: string | undefined, successfulIndexes: number[]): string | undefined {
		if (!aggregateText) return undefined;
		const marker = "=== Worktree Changes ===";
		const markerIndex = aggregateText.indexOf(marker);
		if (markerIndex < 0) return undefined;
		const worktreeText = aggregateText.slice(markerIndex + marker.length).trim();
		if (!worktreeText) return undefined;
		const successfulTaskNumbers = new Set(successfulIndexes.map((index) => index + 1));
		const sections = worktreeText
			.split(/\n(?=--- Task \d+ \()/)
			.map((section) => section.trim())
			.filter(Boolean)
			.filter((section) => {
				const match = section.match(/^--- Task (\d+) \(/);
				return match ? successfulTaskNumbers.has(parseInt(match[1]!, 10)) : false;
			});
		if (sections.length === 0) return undefined;
		return `${marker}\n\n${sections.join("\n\n")}`;
	}

	function slugifyRunSegment(value: string): string {
		const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
		return (slug || "compare").slice(0, 48);
	}

	function formatRunTimestamp(date = new Date()): string {
		return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	}

	function extractKeepArtifactsFlag(argsString: string): { args: string; keepArtifacts: boolean } {
		let keepArtifacts = false;
		const ranges: Array<{ start: number; end: number }> = [];
		let i = 0;
		while (i < argsString.length) {
			const char = argsString[i];
			if (char === '"' || char === "'") {
				const quote = char;
				i++;
				while (i < argsString.length) {
					if (argsString[i] === "\\") {
						i += 2;
						continue;
					}
					if (argsString[i] === quote) {
						i++;
						break;
					}
					i++;
				}
				continue;
			}
			if (/\s/.test(char)) {
				i++;
				continue;
			}
			const start = i;
			while (i < argsString.length && !/\s/.test(argsString[i])) i++;
			if (argsString.slice(start, i) === "--keep-artifacts") {
				keepArtifacts = true;
				ranges.push({ start, end: i });
			}
		}
		let cleaned = argsString;
		for (const range of ranges.sort((a, b) => b.start - a.start)) {
			cleaned = cleaned.slice(0, range.start) + cleaned.slice(range.end);
		}
		return { args: cleaned.trim(), keepArtifacts };
	}

	function buildReportLineupSlots(slots: DelegationLineupSlot[], preparedTasks: PreparedDelegatedTask[]): ReportLineupSlot[] {
		return slots.map((slot, index) => {
			const prepared = preparedTasks[index];
			return {
				...slot,
				effectiveModel: prepared?.model ?? slot.model ?? "unknown",
				effectiveTask: prepared?.task ?? "",
			};
		});
	}

	function serializeLineupSlot(slot: ReportLineupSlot): Record<string, unknown> {
		return {
			agent: slot.agent,
			...(slot.model ? { model: slot.model } : {}),
			effectiveModel: slot.effectiveModel,
			effectiveTask: slot.effectiveTask,
			...(slot.cwd ? { cwd: slot.cwd } : {}),
			...(slot.task ? { task: slot.task } : {}),
			...(slot.taskSuffix ? { taskSuffix: slot.taskSuffix } : {}),
		};
	}

	function formatRunArtifactResult(result: DelegatedPromptParallelResult): string {
		const text = result.text?.trim();
		if (!result.isError) return text || "(no assistant text)";
		const parts = [`Error: ${result.errorText || "(error)"}`];
		if (text) parts.push("", "Assistant output:", text);
		return parts.join("\n");
	}

	function renderRunReportSection(title: string, body?: string): string[] {
		return [`## ${title}`, "", body?.trim() || "(none)", ""];
	}

	function writeBestOfNRunReport(options: {
		compareCwd: string;
		promptName: string;
		status: "review-complete" | "apply-complete";
		sharedTask: string;
		taskArgs: string[];
		presetName?: string;
		commitMode?: "ask";
		keepArtifacts: boolean;
		workers: ReportLineupSlot[];
		reviewers: ReportLineupSlot[];
		finalApplier?: ReportLineupSlot;
		workerPairs: Array<{ index: number; slot: DelegationLineupSlot; result: DelegatedPromptParallelResult }>;
		reviewerPairs: Array<{ index: number; slot: DelegationLineupSlot; result: DelegatedPromptParallelResult }>;
		workerSummary: string;
		workerFailures?: string;
		reviewerSummary?: string;
		reviewerFailures?: string;
		finalText?: string;
	}): string {
		const runDir = join(options.compareCwd, ".pi", "runs", "best-of-n", `${formatRunTimestamp()}-${slugifyRunSegment(options.promptName)}-${randomUUID().slice(0, 8)}`);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "lineup.json"), `${JSON.stringify({
			prompt: options.promptName,
			status: options.status,
			preset: options.presetName,
			commit: options.commitMode,
			keepArtifacts: options.keepArtifacts,
			args: options.taskArgs,
			workers: options.workers.map(serializeLineupSlot),
			reviewers: options.reviewers.map(serializeLineupSlot),
			finalApplier: options.finalApplier ? serializeLineupSlot(options.finalApplier) : undefined,
		}, null, 2)}\n`);
		if (options.keepArtifacts) {
			for (const { index, result } of options.workerPairs) writeFileSync(join(runDir, `worker-${index + 1}.md`), `${formatRunArtifactResult(result)}\n`);
			for (const { index, result } of options.reviewerPairs) writeFileSync(join(runDir, `reviewer-${index + 1}.md`), `${formatRunArtifactResult(result)}\n`);
			if (options.finalText) writeFileSync(join(runDir, "final-applier.md"), `${options.finalText}\n`);
		}
		const report = [
			`# Best-of-N run: ${options.promptName}`,
			"",
			`- Status: ${options.status}`,
			`- Compare cwd: ${options.compareCwd}`,
			...(options.presetName ? [`- Preset: ${options.presetName}`] : []),
			...(options.commitMode ? [`- Commit policy: ${options.commitMode}`] : []),
			`- Worker calls: ${options.workers.length}`,
			`- Reviewer calls: ${options.reviewers.length}`,
			`- Final applier: ${options.finalApplier ? "yes" : "no"}`,
			`- Raw artifacts retained: ${options.keepArtifacts ? "yes" : "no"}`,
			"",
			...renderRunReportSection("Task", options.sharedTask),
			...renderRunReportSection("Workers", options.workerSummary),
			...renderRunReportSection("Worker failures", options.workerFailures),
			...renderRunReportSection("Reviewers", options.reviewerSummary),
			...renderRunReportSection("Reviewer failures", options.reviewerFailures),
			...renderRunReportSection("Final applier", options.finalText),
		].join("\n");
		writeFileSync(join(runDir, "report.md"), report);
		return join(runDir, "report.md");
	}

	function tryWriteBestOfNRunReport(options: Parameters<typeof writeBestOfNRunReport>[0], ctx: ExtensionCommandContext): string | undefined {
		try {
			return writeBestOfNRunReport(options);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `Best-of-N report could not be written: ${message}`, "warning");
			return undefined;
		}
	}

	function formatRunReportCompletionLine(reportPath: string | undefined): string {
		return reportPath ? `Report: ${reportPath}` : "Report: unavailable (failed to write run artifacts)";
	}

	function runGitCapture(cwd: string, args: string[]): string | undefined {
		try {
			const output = execFileSync("git", args, {
				cwd,
				encoding: "utf8",
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			return output.trimEnd();
		} catch {
			return undefined;
		}
	}

	function resolveGitRoot(cwd: string): string | undefined {
		return runGitCapture(cwd, ["rev-parse", "--show-toplevel"]);
	}

	function captureDiffFingerprint(cwd: string): string | undefined {
		const names = runGitCapture(cwd, ["diff", "--no-ext-diff", "--name-only", "-z", "HEAD"]);
		if (names === undefined) return undefined;
		const fingerprints: string[] = [];
		for (const path of names.split("\0").filter(Boolean).sort()) {
			const hash = existsSync(join(cwd, path)) ? runGitCapture(cwd, ["hash-object", "--", path]) : "(deleted)";
			fingerprints.push(`${path}\0${hash ?? "(unavailable)"}`);
		}
		return fingerprints.join("\0");
	}

	function captureGitSnapshot(cwd: string): GitSnapshot {
		return {
			head: runGitCapture(cwd, ["rev-parse", "HEAD"]),
			status: runGitCapture(cwd, ["status", "--short"]),
			diffStat: runGitCapture(cwd, ["diff", "--no-ext-diff", "--stat", "HEAD"]),
			shortStat: runGitCapture(cwd, ["diff", "--no-ext-diff", "--shortstat", "HEAD"]),
			diffRaw: runGitCapture(cwd, ["diff", "--no-ext-diff", "--raw", "-z", "HEAD"]),
			stagedRaw: runGitCapture(cwd, ["diff", "--no-ext-diff", "--cached", "--raw", "-z", "HEAD"]),
			diffFingerprint: captureDiffFingerprint(cwd),
			stagedNameStatus: runGitCapture(cwd, ["diff", "--no-ext-diff", "--cached", "--name-status", "HEAD"]),
		};
	}

	function splitGitDiffByPath(diff: string | undefined): Map<string, string> {
		const blocks = new Map<string, string>();
		if (!diff) return blocks;
		if (diff.includes("\0")) {
			const tokens = diff.split("\0").filter(Boolean);
			if (!tokens[0]?.startsWith(":")) {
				for (let i = 0; i < tokens.length; i += 2) {
					const path = tokens[i];
					if (!path) continue;
					blocks.set(path, `${path}\0${tokens[i + 1] ?? ""}`);
				}
				return blocks;
			}
			for (let i = 0; i < tokens.length;) {
				const header = tokens[i++];
				if (!header?.startsWith(":")) continue;
				const status = header.trim().split(/\s+/)[4] ?? "";
				const firstPath = tokens[i++];
				if (!firstPath) continue;
				const secondPath = /^[RC]/.test(status) ? tokens[i++] : undefined;
				const path = secondPath || firstPath;
				blocks.set(path, [header, firstPath, secondPath].filter((value): value is string => Boolean(value)).join("\0"));
			}
			return blocks;
		}
		const lines = diff.split("\n");
		let currentPath: string | undefined;
		let currentBlock: string[] = [];
		const flush = () => {
			if (currentPath) blocks.set(currentPath, currentBlock.join("\n"));
		};
		for (const line of lines) {
			const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
			if (match) {
				flush();
				currentPath = match[2];
				currentBlock = [line];
				continue;
			}
			if (currentPath) currentBlock.push(line);
		}
		flush();
		return blocks;
	}

	function diffPatchChangedPaths(beforePatch: string | undefined, afterPatch: string | undefined): Set<string> {
		const beforeBlocks = splitGitDiffByPath(beforePatch);
		const afterBlocks = splitGitDiffByPath(afterPatch);
		const changed = new Set<string>();
		const paths = new Set([...beforeBlocks.keys(), ...afterBlocks.keys()]);
		for (const path of paths) {
			if (beforeBlocks.get(path) !== afterBlocks.get(path)) changed.add(path);
		}
		return changed;
	}

	function diffChangedPaths(before: GitSnapshot, after: GitSnapshot): Set<string> {
		return new Set([
			...diffPatchChangedPaths(before.diffFingerprint, after.diffFingerprint),
			...diffPatchChangedPaths(before.diffRaw, after.diffRaw),
			...diffPatchChangedPaths(before.stagedRaw, after.stagedRaw),
		]);
	}

	function unquoteGitPath(path: string): string {
		if (!path.startsWith('"') || !path.endsWith('"')) return path;
		let result = "";
		let octalBytes: number[] = [];
		const flushOctalBytes = () => {
			if (octalBytes.length === 0) return;
			result += Buffer.from(octalBytes).toString("utf8");
			octalBytes = [];
		};
		for (let i = 1; i < path.length - 1; i++) {
			const char = path[i]!;
			if (char !== "\\") {
				flushOctalBytes();
				result += char;
				continue;
			}
			const next = path[++i];
			if (next === undefined) break;
			if (next >= "0" && next <= "7") {
				let octal = next;
				for (let count = 0; count < 2 && i + 1 < path.length - 1 && path[i + 1]! >= "0" && path[i + 1]! <= "7"; count++) {
					octal += path[++i]!;
				}
				octalBytes.push(Number.parseInt(octal, 8));
				continue;
			}
			flushOctalBytes();
			const escapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "	", v: "\v", "\\": "\\", '"': '"' };
			result += escapes[next] ?? next;
		}
		flushOctalBytes();
		return result;
	}

	function findUnquotedRenameSeparator(value: string): number {
		let inQuote = false;
		let escaped = false;
		for (let i = 0; i <= value.length - 4; i++) {
			const char = value[i]!;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\" && inQuote) {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inQuote = !inQuote;
				continue;
			}
			if (!inQuote && value.slice(i, i + 4) === " -> ") return i;
		}
		return -1;
	}

	function statusLinePath(line: string): string | undefined {
		if (line.length < 4) return undefined;
		const raw = line.slice(3);
		const renameIndex = findUnquotedRenameSeparator(raw);
		return unquoteGitPath(renameIndex >= 0 ? raw.slice(renameIndex + 4) : raw);
	}

	function statusLinesChangedAfter(before: GitSnapshot, after: GitSnapshot): string {
		if (after.status === undefined) return "(git status unavailable or no changes detected)";
		const beforeLines = (before.status || "").split("\n").filter(Boolean);
		const afterLines = after.status.split("\n").filter(Boolean);
		const beforeLineSet = new Set(beforeLines);
		const afterLineSet = new Set(afterLines);
		const dirtyPathsWithDiffChanges = diffChangedPaths(before, after);
		const changed = afterLines.filter((line) => {
			if (!beforeLineSet.has(line)) return true;
			const path = statusLinePath(line);
			return path ? dirtyPathsWithDiffChanges.has(path) : false;
		});
		for (const line of beforeLines) {
			if (afterLineSet.has(line)) continue;
			const path = statusLinePath(line);
			if (line.startsWith("?? ") || (path && dirtyPathsWithDiffChanges.has(path))) changed.push(`${line} (pre-existing status entry removed or cleaned by final applier)`);
		}
		return changed.length > 0 ? changed.join("\n") : "(no new status entries since final applier started; inspect full diff if pre-existing files were modified)";
	}

	function preExistingUntrackedLines(snapshot: GitSnapshot): string[] {
		return (snapshot.status || "").split("\n").filter((line) => line.startsWith("?? "));
	}

	function formatApprovalGuardWarnings(before: GitSnapshot, after: GitSnapshot): string | undefined {
		const warnings: string[] = [];
		if (before.head && after.head && before.head !== after.head) {
			warnings.push(`HEAD changed during the final applier run (${before.head.slice(0, 12)} -> ${after.head.slice(0, 12)}). Inspect history before committing; the final applier may have committed already.`);
		}
		if ((before.stagedNameStatus || "") || (before.stagedRaw || "")) {
			warnings.push("Pre-existing staged changes were present before the final applier ran. Review `git diff --cached` and unstage unrelated hunks before using the suggested commit command.");
		}
		if ((after.stagedNameStatus || "") !== (before.stagedNameStatus || "") || (after.stagedRaw || "") !== (before.stagedRaw || "")) {
			warnings.push("Staged changes changed during the final applier run. Review `git diff --cached` and unstage anything that should remain under manual approval.");
		}
		const preExistingUntracked = preExistingUntrackedLines(before);
		if (preExistingUntracked.length > 0) {
			warnings.push(`Pre-existing untracked entries were present before the final applier ran. Git cannot diff their prior contents, so review them manually: ${preExistingUntracked.join(", ")}`);
		}
		return warnings.length > 0 ? warnings.join("\n") : undefined;
	}

	function buildSuggestedBestOfNCommitMessage(promptName: string, taskArgs: string[]): string {
		const target = taskArgs.join(" ").replace(/\s+/g, " ").trim();
		const suffix = target ? `: ${target.slice(0, 72)}` : "";
		return `feat: apply ${promptName} best-of-n result${suffix}`;
	}

	function shellQuote(value: string): string {
		return `'${value.replace(/'/g, `'"'"'`)}'`;
	}

	function renderBestOfNCommitAsk(options: {
		compareCwd: string;
		promptName: string;
		taskArgs: string[];
		reportPath?: string;
		beforeFinalApplier: GitSnapshot;
		afterFinalApplier: GitSnapshot;
	}): string {
		const suggestedMessage = buildSuggestedBestOfNCommitMessage(options.promptName, options.taskArgs);
		const gitBase = `git -C ${shellQuote(options.compareCwd)}`;
		const addPatchCommand = `${gitBase} add --patch`;
		const addIntentCommand = `${gitBase} add -N -- ${shellQuote("<path>")}`;
		const command = `${gitBase} commit -m ${shellQuote(suggestedMessage)}`;
		const changedStatus = statusLinesChangedAfter(options.beforeFinalApplier, options.afterFinalApplier);
		const guardWarnings = formatApprovalGuardWarnings(options.beforeFinalApplier, options.afterFinalApplier);
		return [
			"## Commit approval",
			"",
			"`bestOfN.commit: ask` is enabled. Review and stage only the intended final-applier changes before committing.",
			"",
			`- Compare cwd: ${options.compareCwd}`,
			`- ${formatRunReportCompletionLine(options.reportPath)}`,
			`- Suggested commit: \`${suggestedMessage}\``,
			"",
			...(guardWarnings ? [
				"Approval guard warnings:",
				"```",
				guardWarnings,
				"```",
			] : []),
			"New status entries since final applier started:",
			"```",
			changedStatus,
			"```",
			...(options.beforeFinalApplier.status ? [
				"Pre-existing status before final applier:",
				"```",
				options.beforeFinalApplier.status,
				"```",
			] : []),
			"Full diff summary after final applier:",
			"```",
			[options.afterFinalApplier.diffStat, options.afterFinalApplier.shortStat].filter((value): value is string => Boolean(value)).join("\n") || "(git diff unavailable or empty)",
			"```",
			"Diff summary before final applier:",
			"```",
			[options.beforeFinalApplier.diffStat, options.beforeFinalApplier.shortStat].filter((value): value is string => Boolean(value)).join("\n") || "(empty)",
			"```",
			"For intended new files shown as `??`, first mark the path for patch selection (or explicitly stage the file):",
			"```bash",
			addIntentCommand,
			"```",
			"Stage only the intended tracked-file and intent-to-add hunks, for example:",
			"```bash",
			addPatchCommand,
			"```",
			"Then commit the staged changes:",
			"```bash",
			command,
			"```",
		].join("\n");
	}

	function buildReviewerPreamble(sharedTask: string, workerAggregation: string, workerFailureSummary?: string): string {
		return [
			"[Original implementation task]",
			sharedTask,
			"",
			"[Worker outputs and worktree summaries]",
			workerAggregation,
			...(workerFailureSummary ? ["", workerFailureSummary] : []),
		].join("\n");
	}

	function buildFinalApplierPreamble(
		sharedTask: string,
		workerAggregation: string,
		workerFailureSummary?: string,
		reviewerAggregation?: string,
		reviewerFailureSummary?: string,
	): string {
		return [
			"[Original implementation task]",
			sharedTask,
			"",
			"[Worker outputs and worktree summaries]",
			workerAggregation,
			...(workerFailureSummary ? ["", workerFailureSummary] : []),
			"",
			"[Reviewer findings]",
			reviewerAggregation ?? "All reviewer runs failed. Synthesize directly from the worker variants.",
			...(reviewerFailureSummary ? ["", reviewerFailureSummary] : []),
			"",
			"[Final apply instructions]",
			"Pick one winner or synthesize/cherry-pick from multiple variants, apply the final patch directly in the current repo, keep edits minimal, run obvious relevant verification when practical, and report changed files plus verification run.",
		].join("\n");
	}

	function buildCommitAskFinalApplierTask(task: string): string {
		return [
			task,
			"",
			"Commit approval mode:",
			"- Do not run `git add`, `git commit`, or any command that stages or commits changes.",
			"- Leave all changes unstaged in the worktree for the user to review and approve after you finish.",
			"- If you need git for verification or reporting, use read-only commands such as `git status` or `git diff`.",
		].join("\n");
	}

	function buildLineupSlotTask(
		baseTask: string,
		slot: DelegationLineupSlot,
		taskArgs: string[],
	): string {
		const effectiveBaseTask = slot.task ? substituteArgs(slot.task, taskArgs) : baseTask;
		if (!slot.taskSuffix) return effectiveBaseTask;
		return `${effectiveBaseTask}\n\n${substituteArgs(slot.taskSuffix, taskArgs)}`;
	}

	function buildComparePrompt(
		base: PromptWithModel,
		options: {
			name: string;
			agent: string;
			task: string;
			model?: string;
			cwd: string;
			inheritContext?: boolean;
		},
	): PromptWithModel {
		return {
			...base,
			name: options.name,
			content: options.task,
			models: options.model ? [options.model] : [],
			chain: undefined,
			chainContext: undefined,
			parallel: undefined,
			worktree: undefined,
			subagent: options.agent,
			inheritContext: options.inheritContext ? true : undefined,
			cwd: options.cwd,
			workers: undefined,
			reviewers: undefined,
			finalApplier: undefined,
		};
	}

	async function runComparePrompt(
		name: string,
		prompt: PromptWithModel,
		args: string,
		ctx: ExtensionCommandContext,
		currentModel: Model<any> | undefined,
		runtime: { cwd?: string; model?: string; preset?: string; subagentOverride?: SubagentOverride; fork?: boolean },
	) {
		if (!(await ensureProjectPromptLibraryApproved(prompt, ctx))) return;

		if (runtime.subagentOverride) {
			notify(ctx, `--subagent is not supported for compare prompts (ignored)`, "warning");
		}
		if (runtime.fork) {
			notify(ctx, `--fork is not supported for compare prompts (ignored)`, "warning");
		}

		const lineupExtraction = extractLineupOverrides(args);
		if (lineupExtraction.errors.length > 0) {
			for (const error of lineupExtraction.errors) {
				notify(ctx, error, "error");
			}
			return;
		}

		const keepArtifactsExtraction = extractKeepArtifactsFlag(lineupExtraction.args);
		const keepArtifacts = keepArtifactsExtraction.keepArtifacts;
		let taskArgs = parseCommandArgs(keepArtifactsExtraction.args);
		let compareCwd = runtime.cwd ?? prompt.cwd ?? ctx.cwd;
		if (name === "parallel-patch-compare-at-path") {
			if (taskArgs.length === 0) {
				notify(ctx, "parallel-patch-compare-at-path requires a repo path as the first argument.", "error");
				return;
			}
			if (runtime.cwd) {
				notify(ctx, "--cwd is ignored for parallel-patch-compare-at-path (using first positional path).", "warning");
			}
			compareCwd = resolveCompareCwd(taskArgs[0]!, ctx);
			taskArgs = taskArgs.slice(1);
			if (taskArgs.length === 0) {
				notify(ctx, "parallel-patch-compare-at-path requires an implementation task after the repo path.", "error");
				return;
			}
		}

		if (!existsSync(compareCwd)) {
			notify(ctx, `cwd directory does not exist: ${compareCwd}`, "error");
			return;
		}
		const approvalCwd = prompt.commit === "ask" ? (resolveGitRoot(compareCwd) ?? compareCwd) : compareCwd;

		const baseModel = await resolveCompareBaseModel(prompt, currentModel, ctx, runtime.model);
		if (!baseModel) return;

		const rendered = renderPromptForResolvedModel(prompt, taskArgs, baseModel);
		if (rendered.warning) notify(ctx, rendered.warning, "warning");
		if (rendered.empty || !rendered.content) {
			notify(ctx, rendered.empty ?? `Prompt \`${prompt.name}\` rendered to an empty message.`, "error");
			return;
		}
		const sharedTask = rendered.content;

		const presetLineup = await resolveBestOfNPresetLineup(prompt, runtime.preset, ctx, compareCwd);
		if (!presetLineup) return;
		const requestedWorkers = applyLineupActions(presetLineup.workers ?? prompt.workers, lineupExtraction.actions, "workers") ?? [];
		const requestedReviewers = applyLineupActions(presetLineup.reviewers ?? prompt.reviewers, lineupExtraction.actions, "reviewers") ?? [];
		const requestedFinalApplier = applyFinalApplierAction(prompt.finalApplier, lineupExtraction.actions);
		if (requestedFinalApplier && prompt.worktree !== true) {
			notify(ctx, "Compare prompts with finalApplier require worktree: true.", "error");
			return;
		}

		const effectiveWorkerSlots = requestedWorkers.length > 0
			? requestedWorkers
			: [{ agent: DEFAULT_SUBAGENT_NAME }];
		const effectiveReviewerSlots = requestedReviewers.length > 0
			? requestedReviewers
			: [{ agent: "reviewer" }];
		const presetModelCalls = expandedLineupCallCount(effectiveWorkerSlots) + expandedLineupCallCount(effectiveReviewerSlots);
		if (presetLineup.maxModelCalls !== undefined && presetModelCalls > presetLineup.maxModelCalls) {
			notify(ctx, `Best-of-N preset model-call cap exceeded: requested ${presetModelCalls} worker/reviewer call(s), but preset allows ${presetLineup.maxModelCalls}.`, "error");
			return;
		}

		const workerSlots = expandLineupCounts(effectiveWorkerSlots);
		const reviewerSlots = expandLineupCounts(effectiveReviewerSlots);

		const normalizedWorkers = normalizeLineupCwds(workerSlots, compareCwd, ctx);
		if (!normalizedWorkers) return;
		const normalizedReviewers = normalizeLineupCwds(reviewerSlots, compareCwd, ctx);
		if (!normalizedReviewers) return;
		const normalizedFinalApplier = requestedFinalApplier
			? {
				...requestedFinalApplier,
				cwd: compareCwd,
			}
			: undefined;

		if (prompt.worktree === true) {
			const uniqueWorkerCwds = new Set(normalizedWorkers.map((slot) => slot.cwd));
			if (uniqueWorkerCwds.size > 1) {
				notify(ctx, "worktree compare runs require all worker slots to use the same cwd.", "error");
				return;
			}
		}

		try {
			const workerResult = await executeSubagentPromptStep({
				pi,
				ctx,
				currentModel: baseModel,
				signal: ctx.signal,
				worktree: prompt.worktree === true,
				allowPartialFailures: true,
				parallel: normalizedWorkers.map((slot, index) => ({
					prompt: buildComparePrompt(prompt, {
						name: `${prompt.name}-worker-${index + 1}`,
						agent: slot.agent,
						task: buildLineupSlotTask(sharedTask, slot, taskArgs),
						model: slot.model,
						cwd: slot.cwd!,
						inheritContext: true,
					}),
					args: [],
				})),
			});
			const workerPairs = (workerResult?.parallelResults ?? []).map((result, index) => ({
				index,
				slot: normalizedWorkers[index]!,
				result,
			}));
			if (workerPairs.length === 0) return;
			const successfulWorkers = workerPairs.filter((entry) => !entry.result.isError);
			const failedWorkers = workerPairs.filter((entry) => entry.result.isError);
			if (successfulWorkers.length === 0) {
				notify(ctx, `Compare worker phase failed: all worker slots failed.`, "error");
				return;
			}
			const successfulWorkerText = [
				renderComparePhaseResults("Worker", successfulWorkers),
				extractSuccessfulWorktreeChanges(workerResult.text, successfulWorkers.map((entry) => entry.index)),
			]
				.filter((value): value is string => Boolean(value))
				.join("\n\n");
			const workerFailureSummary = formatPhaseFailureSummary("Worker", failedWorkers);

			const reviewerPreamble = buildReviewerPreamble(sharedTask, successfulWorkerText, workerFailureSummary);
			const reviewerResult = await executeSubagentPromptStep({
				pi,
				ctx,
				currentModel: baseModel,
				signal: ctx.signal,
				taskPreamble: reviewerPreamble,
				allowPartialFailures: true,
				parallel: normalizedReviewers.map((slot, index) => ({
					prompt: buildComparePrompt(prompt, {
						name: `${prompt.name}-reviewer-${index + 1}`,
						agent: slot.agent,
						task: buildLineupSlotTask(DEFAULT_COMPARE_REVIEWER_TASK, slot, taskArgs),
						model: slot.model,
						cwd: slot.cwd!,
						inheritContext: false,
					}),
					args: [],
				})),
			});
			const reviewerPairs = (reviewerResult?.parallelResults ?? []).map((result, index) => ({
				index,
				slot: normalizedReviewers[index]!,
				result,
			}));
			if (reviewerPairs.length === 0) return;
			const successfulReviewers = reviewerPairs.filter((entry) => !entry.result.isError);
			const failedReviewers = reviewerPairs.filter((entry) => entry.result.isError);
			const successfulReviewerText = successfulReviewers.length > 0
				? renderComparePhaseResults("Reviewer", successfulReviewers)
				: undefined;
			const reviewerFailureSummary = formatPhaseFailureSummary("Reviewer", failedReviewers);
			const reportWorkers = buildReportLineupSlots(normalizedWorkers, workerResult.preparedTasks);
			const reportReviewers = buildReportLineupSlots(normalizedReviewers, reviewerResult.preparedTasks);

			if (!normalizedFinalApplier) {
				if (!successfulReviewerText) {
					notify(ctx, `Compare reviewer phase failed: all reviewer slots failed.`, "error");
					return;
				}
				const finalText = reviewerFailureSummary
					? `${successfulReviewerText}\n\n${reviewerFailureSummary}`
					: successfulReviewerText;
				const reportPath = tryWriteBestOfNRunReport({
					compareCwd,
					promptName: name,
					status: "review-complete",
					sharedTask,
					taskArgs,
					presetName: runtime.preset ?? prompt.preset,
					commitMode: undefined,
					keepArtifacts,
					workers: reportWorkers,
					reviewers: reportReviewers,
					finalApplier: undefined,
					workerPairs,
					reviewerPairs,
					workerSummary: successfulWorkerText,
					workerFailures: workerFailureSummary,
					reviewerSummary: successfulReviewerText,
					reviewerFailures: reviewerFailureSummary,
				}, ctx);
				pi.sendUserMessage(`[Compare review complete: ${name}]\n\n${formatRunReportCompletionLine(reportPath)}\n\n${finalText}`);
				await waitForTurnStart(ctx);
				await ctx.waitForIdle();
				return;
			}

			const beforeFinalApplierSnapshot = prompt.commit === "ask" ? captureGitSnapshot(approvalCwd) : undefined;
			const finalApplierTask = buildLineupSlotTask(DEFAULT_COMPARE_FINAL_APPLIER_TASK, normalizedFinalApplier, taskArgs);
			const finalResult = await executeSubagentPromptStep({
				pi,
				ctx,
				currentModel: baseModel,
				signal: ctx.signal,
				taskPreamble: buildFinalApplierPreamble(
					sharedTask,
					successfulWorkerText,
					workerFailureSummary,
					successfulReviewerText,
					reviewerFailureSummary,
				),
				prompt: buildComparePrompt(prompt, {
					name: `${prompt.name}-final-applier`,
					agent: normalizedFinalApplier.agent,
					task: prompt.commit === "ask" ? buildCommitAskFinalApplierTask(finalApplierTask) : finalApplierTask,
					model: normalizedFinalApplier.model,
					cwd: compareCwd,
					inheritContext: false,
				}),
				args: [],
			});
			if (!finalResult?.text) return;
			const afterFinalApplierSnapshot = prompt.commit === "ask" ? captureGitSnapshot(approvalCwd) : undefined;
			const reportFinalApplier = buildReportLineupSlots([normalizedFinalApplier], finalResult.preparedTasks)[0];
			const reportPath = tryWriteBestOfNRunReport({
				compareCwd,
				promptName: name,
				status: "apply-complete",
				sharedTask,
				taskArgs,
				presetName: runtime.preset ?? prompt.preset,
				commitMode: prompt.commit,
				keepArtifacts,
				workers: reportWorkers,
				reviewers: reportReviewers,
				finalApplier: reportFinalApplier,
				workerPairs,
				reviewerPairs,
				workerSummary: successfulWorkerText,
				workerFailures: workerFailureSummary,
				reviewerSummary: successfulReviewerText,
				reviewerFailures: reviewerFailureSummary,
				finalText: finalResult.text,
			}, ctx);
			const commitAsk = prompt.commit === "ask" && beforeFinalApplierSnapshot && afterFinalApplierSnapshot
				? renderBestOfNCommitAsk({ compareCwd: approvalCwd, promptName: name, taskArgs, reportPath, beforeFinalApplier: beforeFinalApplierSnapshot, afterFinalApplier: afterFinalApplierSnapshot })
				: "";
			pi.sendUserMessage(`[Compare apply complete: ${name}]\n\n${formatRunReportCompletionLine(reportPath)}\n\n${finalResult.text}`);
			if (commitAsk) {
				pi.sendMessage({
					customType: PROMPT_TEMPLATE_COMMIT_ASK_MESSAGE_TYPE,
					content: `[Commit approval: ${name}]`,
					display: true,
					details: {
						approvalText: commitAsk,
						promptName: name,
						compareCwd: approvalCwd,
						reportPath,
						commit: "ask",
					},
				});
			}
			await waitForTurnStart(ctx);
			await ctx.waitForIdle();
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
		}
	}

	async function collapseBoomerangPrompt(
		ctx: ExtensionContext,
		name: string,
		targetId: string | null,
		previousSummaries: string[] = [],
	) {
		if (!targetId) {
			notify(ctx, `Cannot boomerang prompt \`${name}\`: no session entry to return to.`, "warning");
			return;
		}

		boomerangCollapse = { targetId, task: name, previousSummaries };
		try {
			(globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress = true;
			const result = await ctx.navigateTree(targetId, { summarize: true });
			if (result.cancelled) notify(ctx, `Boomerang cancelled for prompt \`${name}\``, "warning");
		} finally {
			(globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress = false;
			boomerangCollapse = null;
		}
	}

	async function runPromptLoop(
		name: string,
		cleanedArgs: string,
		totalIterations: number | null,
		freshFlag: boolean,
		converge: boolean,
		ctx: ExtensionCommandContext,
		subagentOverride?: SubagentOverride,
		cwdOverride?: string,
		promptOverrides?: Partial<Pick<PromptWithModel, "models" | "inheritContext">>,
	) {
		refreshPrompts(ctx.cwd, ctx);
		const initialPrompt = prompts.get(name);
		if (!initialPrompt) {
			notify(ctx, `Prompt "${name}" no longer exists`, "error");
			return;
		}

		const savedModel = getCurrentModel(ctx);
		const savedThinking = pi.getThinkingLevel();
		let currentModel = savedModel;
		let currentThinking = savedThinking;
		const shouldRestore = initialPrompt.restore;
		const useFresh = freshFlag || initialPrompt.fresh === true;
		const shouldBoomerang = initialPrompt.boomerang === true;
		const effectiveMax = totalIterations ?? UNLIMITED_LOOP_CAP;
		const isUnlimited = totalIterations === null;
		const useConverge = converge && initialPrompt.converge !== false;
		const anchorId = useFresh || shouldBoomerang ? ctx.sessionManager.getLeafId() : null;

		loopState = { currentIteration: 1, totalIterations };
		accumulatedSummaries = [];
		updateLoopStatus(ctx);
		let completedIterations = 0;
		let converged = false;
		let loopErrorState: ExecutionErrorState = { hasError: false, error: undefined };
		let lastDelegatedText: string | undefined;
		let loopAborted = false;
		let boomerangPreviousSummaries: string[] = [];

		try {
			for (let i = 0; i < effectiveMax; i++) {
				loopState.currentIteration = i + 1;
				const iterationLabel = totalIterations !== null ? `${i + 1}/${totalIterations}` : `${i + 1}`;

				refreshPrompts(ctx.cwd, ctx);
				const prompt = prompts.get(name);
				if (!prompt) {
					notify(ctx, `Prompt "${name}" no longer exists`, "error");
					loopAborted = true;
					break;
				}
				const effectivePrompt = { ...prompt, ...(cwdOverride ? { cwd: cwdOverride } : {}), ...promptOverrides };
				let iterationPrompt = effectivePrompt;
				loopState!.rotationLabel = undefined;
				if (effectivePrompt.rotate && effectivePrompt.models.length > 1) {
					const rotationIndex = i % effectivePrompt.models.length;
					const rotatedThinking = effectivePrompt.thinkingLevels
						? effectivePrompt.thinkingLevels[rotationIndex]
						: effectivePrompt.thinking;
					iterationPrompt = {
						...effectivePrompt,
						models: [effectivePrompt.models[rotationIndex]],
						thinking: rotatedThinking,
					};
					const shortModel = effectivePrompt.models[rotationIndex].split("/").pop() || effectivePrompt.models[rotationIndex];
					const thinkingLabel = rotatedThinking ? ` ${rotatedThinking}` : "";
					loopState!.rotationLabel = `${shortModel}${thinkingLabel}`;
				}
				updateLoopStatus(ctx);
				const rotationSuffix = loopState!.rotationLabel ? ` [${loopState!.rotationLabel}]` : "";
				notify(ctx, `Loop ${iterationLabel}: ${name}${rotationSuffix}`, "info");

				const loopContext = loopState!.rotationLabel
					? `Loop ${iterationLabel} · ${loopState!.rotationLabel}`
					: `Loop ${iterationLabel}`;
				const iterationStartId = ctx.sessionManager.getLeafId();
				const stepResult = await executePromptStep(
					iterationPrompt,
					parseCommandArgs(cleanedArgs),
					ctx,
					currentModel,
					subagentOverride,
					undefined,
					undefined,
					loopContext,
				);
				if (stepResult === "aborted") {
					loopAborted = true;
					break;
				}
				const delegatedStep = shouldDelegatePrompt(iterationPrompt, subagentOverride);
				if (delegatedStep) {
					lastDelegatedText = stepResult.text;
				}

				currentModel = getCurrentModel(ctx);
				currentThinking = pi.getThinkingLevel();
				completedIterations++;

				const iterationChanged = delegatedStep
					? stepResult.changed
					: didIterationMakeChanges(getIterationEntries(ctx, iterationStartId));
				if (useConverge && (isUnlimited || effectiveMax > 1) && !iterationChanged) {
					converged = true;
					break;
				}

				if (useFresh && anchorId && i < effectiveMax - 1) {
					freshCollapse = { targetId: anchorId, task: name, iteration: i + 1, totalIterations };
					const result = await ctx.navigateTree(anchorId, { summarize: true });
					freshCollapse = null;
					if (result.cancelled) {
						loopAborted = true;
						notify(ctx, "Loop cancelled", "warning");
						break;
					}
				}
			}
		} catch (error) {
			loopErrorState = { hasError: true, error };
		} finally {
			loopErrorState = await restoreAfterExecution(
				ctx,
				shouldRestore,
				savedModel,
				savedThinking,
				getCurrentModel(ctx),
				pi.getThinkingLevel(),
				loopErrorState,
				"loop",
			);

			boomerangPreviousSummaries = accumulatedSummaries;
			loopState = null;
			pendingSkillMessage = undefined;
			freshCollapse = null;
			boomerangCollapse = null;
			accumulatedSummaries = [];
			updateLoopStatus(ctx);

			if (!loopErrorState.hasError) {
				notifyLoopCompletion(ctx, completedIterations, totalIterations, effectiveMax, converged, false);
			}
		}

		if (lastDelegatedText && !loopErrorState.hasError && !loopAborted) {
			const label = converged
				? `Delegated loop converged after ${completedIterations} iteration(s): ${name}`
				: `Delegated loop completed ${completedIterations} iteration(s): ${name}`;
			pi.sendUserMessage(`[${label}]\n\n${lastDelegatedText}`);
			await waitForTurnStart(ctx);
			await ctx.waitForIdle();
		}

		if (!loopErrorState.hasError && !loopAborted && shouldBoomerang) {
			await collapseBoomerangPrompt(ctx, name, anchorId, boomerangPreviousSummaries);
		}

		if (loopErrorState.hasError) {
			throw loopErrorState.error;
		}
	}

	async function runSharedChainExecution(
		steps: ChainStepOrParallel[],
		sharedArgs: string[],
		totalIterations: number | null,
		fresh: boolean,
		converge: boolean,
		shouldRestore: boolean,
		ctx: ExtensionCommandContext,
		subagentOverride?: SubagentOverride,
		cwdOverride?: string,
		chainContextEnabled = false,
		chainTemplateWorktree = false,
		cliWorktree = false,
	) {
		let worktreeEnabled = chainTemplateWorktree || cliWorktree;
		if (worktreeEnabled && !steps.some(isParallelChainStep)) {
			notify(ctx, `--worktree ignored: chain has no parallel() steps`, "warning");
			worktreeEnabled = false;
		}
		const flattenChainSteps = (): ChainStep[] => {
			const flattened: ChainStep[] = [];
			for (const step of steps) {
				if (isParallelChainStep(step)) {
					flattened.push(...step.parallel);
				} else {
					flattened.push(step);
				}
			}
			return flattened;
		};

		const validateChainSteps = (): boolean => {
			const flattened = flattenChainSteps();
			const missingTemplates = flattened.filter((step) => !chainPrompts.has(step.name));
			if (missingTemplates.length > 0) {
				notify(ctx, `Templates not found: ${missingTemplates.map((step) => step.name).join(", ")}`, "error");
				return false;
			}

			for (const step of steps) {
				if (isParallelChainStep(step)) {
					for (const parallelStep of step.parallel) {
						if (parallelStep.loopCount !== undefined) {
							notify(ctx, `Step "${parallelStep.name}" in parallel() does not support per-task --loop.`, "error");
							return false;
						}
						if (parallelStep.withContext === true) {
							notify(ctx, `Step "${parallelStep.name}" in parallel() does not support per-task --with-context.`, "error");
							return false;
						}
						const stepPrompt = chainPrompts.get(parallelStep.name);
						if (!stepPrompt) continue;
						if (stepPrompt.chain) {
							notify(ctx, `Step "${parallelStep.name}" is a chain template. Chain nesting is not supported.`, "error");
							return false;
						}
						if (!shouldDelegatePrompt(stepPrompt, subagentOverride)) {
							notify(ctx, `Step "${parallelStep.name}" in parallel() must use delegated execution (subagent).`, "error");
							return false;
						}
					}
					continue;
				}

				const stepPrompt = chainPrompts.get(step.name);
				if (!stepPrompt) continue;
				if (stepPrompt.chain) {
					notify(ctx, `Step "${step.name}" is a chain template. Chain nesting is not supported.`, "error");
					return false;
				}
			}

			return true;
		};

		const resolveChainStepPrompts = (): PromptWithModel[] => flattenChainSteps()
			.map((step) => chainPrompts.get(step.name))
			.filter((prompt): prompt is PromptWithModel => prompt !== undefined);

		if (!validateChainSteps()) return;
		if (!(await ensureProjectPromptLibraryStepsApproved(resolveChainStepPrompts(), ctx))) return;

		const originalModel = getCurrentModel(ctx);
		const chainInheritedModel = originalModel;
		const originalThinking = pi.getThinkingLevel();
		let currentModel = originalModel;
		let currentThinking = originalThinking;
		chainActive = true;
		pendingSkillMessage = undefined;
		const effectiveMax = totalIterations ?? UNLIMITED_LOOP_CAP;
		const isUnlimited = totalIterations === null;
		const useConverge = converge;

		const anchorId = fresh ? ctx.sessionManager.getLeafId() : null;
		const chainStepNames = steps
			.map((step) => (isParallelChainStep(step) ? `parallel(${step.parallel.map((item) => item.name).join(", ")})` : step.name))
			.join(" -> ");
		let completedIterations = 0;
		let converged = false;
		let chainErrorState: ExecutionErrorState = { hasError: false, error: undefined };
		let lastDelegatedText: string | undefined;
		let chainAborted = false;
		if (effectiveMax > 1) {
			loopState = { currentIteration: 1, totalIterations };
			accumulatedSummaries = [];
			updateLoopStatus(ctx);
		}

		try {
			for (let iteration = 0; iteration < effectiveMax; iteration++) {
				if (effectiveMax > 1) {
					loopState!.currentIteration = iteration + 1;
					updateLoopStatus(ctx);
					refreshPrompts(ctx.cwd, ctx);
					if (!validateChainSteps()) {
						chainAborted = true;
						break;
					}
					if (!(await ensureProjectPromptLibraryStepsApproved(resolveChainStepPrompts(), ctx))) {
						chainAborted = true;
						break;
					}
				}

				const templates = steps.map((step) =>
					isParallelChainStep(step)
						? {
							kind: "parallel" as const,
							tasks: step.parallel.map((item) => ({
								name: item.name,
								args: item.args,
								prompt: {
									...chainPrompts.get(item.name)!,
									...(cwdOverride ? { cwd: cwdOverride } : {}),
								},
							})),
						}
						: {
							kind: "single" as const,
							singleStep: {
								prompt: {
									...chainPrompts.get(step.name)!,
									...(cwdOverride ? { cwd: cwdOverride } : {}),
								},
								stepArgs: step.args,
								stepLoop: step.loopCount !== undefined ? step.loopCount : 1,
								stepWithContext: step.withContext === true,
							},
						},
				);
				const chainStepSummaries: string[] = [];
				let aborted = false;
				let iterationChanged = false;
				let loopPrefix = "";
				if (effectiveMax > 1) {
					const label = totalIterations !== null ? `${iteration + 1}/${totalIterations}` : `${iteration + 1}`;
					loopPrefix = `Loop ${label}, `;
				}

				for (const [index, stepTemplate] of templates.entries()) {
					const stepNumber = index + 1;
					if (stepTemplate.kind === "parallel") {
						const stepNames = stepTemplate.tasks.map((task) => task.name).join(", ");
						const stepLabel = `parallel(${stepNames})`;
						notify(ctx, `${loopPrefix}Step ${stepNumber}/${templates.length}: parallel(${stepNames})`, "info");
						if (ctx.hasUI) {
							ctx.ui.setStatus("prompt-chain", ctx.ui.theme.fg("warning", `step ${stepNumber}/${templates.length}: parallel(${stepNames})`));
						}
						const stepStartId = ctx.sessionManager.getLeafId();
						let taskPreamble: string | undefined;
						const isForkedParallelContext = stepTemplate.tasks.some((task) => task.prompt.inheritContext === true);
						if (chainContextEnabled && !isForkedParallelContext && chainStepSummaries.length > 0) {
							taskPreamble = `[Previous chain steps]\n\n${chainStepSummaries.join("\n\n")}`;
						}

						if (!(await ensureProjectPromptLibraryStepsApproved(stepTemplate.tasks.map((task) => task.prompt), ctx))) {
							aborted = true;
							break;
						}

						let delegated;
						try {
							delegated = await executeSubagentPromptStep({
								pi,
								ctx,
								currentModel,
								override: subagentOverride,
								signal: ctx.signal,
								inheritedModel: chainInheritedModel,
								parallel: stepTemplate.tasks.map((task) => ({
									prompt: task.prompt,
									args: task.args.length > 0 ? task.args : sharedArgs,
								})),
								taskPreamble,
								worktree: worktreeEnabled,
							});
						} catch (error) {
							notify(ctx, error instanceof Error ? error.message : String(error), "error");
							aborted = true;
							break;
						}
						if (!delegated) {
							notify(ctx, "Parallel chain step was not delegated.", "error");
							aborted = true;
							break;
						}
						lastDelegatedText = delegated.text;

						currentModel = getCurrentModel(ctx);
						currentThinking = pi.getThinkingLevel();
						const stepEntries = getIterationEntries(ctx, stepStartId);
						if (delegated.changed) iterationChanged = true;
						chainStepSummaries.push(generateChainStepSummary(stepEntries, stepLabel, stepNumber));
						continue;
					}

					const singleStep = stepTemplate.singleStep;
					const stepLoopTotal = singleStep.stepLoop;
					const stepLoopMax = stepLoopTotal ?? UNLIMITED_LOOP_CAP;
					const isStepLooping = stepLoopMax > 1;
					const effectiveArgs = singleStep.stepArgs.length > 0 ? singleStep.stepArgs : sharedArgs;
					const shouldInjectSummary =
						shouldDelegatePrompt(singleStep.prompt, subagentOverride) &&
						singleStep.prompt.inheritContext !== true &&
						(chainContextEnabled || singleStep.stepWithContext === true);
					const outerLoopState = loopState ? { ...loopState } : null;
					const stepStartId = ctx.sessionManager.getLeafId();
					if (isStepLooping) {
						loopState = { currentIteration: 1, totalIterations: stepLoopTotal };
						updateLoopStatus(ctx);
					}

					try {
						for (let stepIteration = 0; stepIteration < stepLoopMax; stepIteration++) {
							if (isStepLooping) {
								loopState = { currentIteration: stepIteration + 1, totalIterations: stepLoopTotal };
								updateLoopStatus(ctx);
							}

							const iterSuffix = isStepLooping
								? stepLoopTotal !== null
									? ` (iter ${stepIteration + 1}/${stepLoopTotal})`
									: ` (iter ${stepIteration + 1})`
								: "";
							notify(
								ctx,
								`${loopPrefix}Step ${stepNumber}/${templates.length}: ${singleStep.prompt.name}${iterSuffix} ${buildPromptCommandDescription(singleStep.prompt)}`,
								"info",
							);
							if (ctx.hasUI) {
								ctx.ui.setStatus("prompt-chain", ctx.ui.theme.fg("warning", `step ${stepNumber}/${templates.length}: ${singleStep.prompt.name}`));
							}
							const taskPreamble = shouldInjectSummary && chainStepSummaries.length > 0
								? `[Previous chain steps]\n\n${chainStepSummaries.join("\n\n")}`
								: undefined;

							const stepLoopContext = isStepLooping
								? `Step ${stepNumber}/${templates.length}: ${singleStep.prompt.name}${iterSuffix}`
								: undefined;
							const stepIterationStartId = ctx.sessionManager.getLeafId();
							const stepResult = await executePromptStep(
								singleStep.prompt,
								effectiveArgs,
								ctx,
								currentModel,
								subagentOverride,
								chainInheritedModel,
								taskPreamble,
								stepLoopContext,
							);
							if (stepResult === "aborted") {
								chainAborted = true;
								aborted = true;
								break;
							}
							if (shouldDelegatePrompt(singleStep.prompt, subagentOverride)) {
								lastDelegatedText = stepResult.text;
							}

							currentModel = getCurrentModel(ctx);
							currentThinking = pi.getThinkingLevel();

							const stepIterationEntries = getIterationEntries(ctx, stepIterationStartId);
							const stepIterationChanged = didIterationMakeChanges(stepIterationEntries);
							if (isStepLooping && singleStep.prompt.converge !== false && !stepIterationChanged) {
								break;
							}
						}
					} finally {
						if (isStepLooping) {
							loopState = outerLoopState ? { ...outerLoopState } : null;
							updateLoopStatus(ctx);
						}
					}

					if (aborted) break;
					const stepEntries = getIterationEntries(ctx, stepStartId);
					if (didIterationMakeChanges(stepEntries)) iterationChanged = true;
					chainStepSummaries.push(generateChainStepSummary(stepEntries, singleStep.prompt.name, stepNumber));
				}

				if (aborted) {
					chainAborted = true;
					break;
				}
				completedIterations++;

				if (useConverge && (isUnlimited || effectiveMax > 1) && !iterationChanged) {
					converged = true;
					break;
				}

				if (anchorId && iteration < effectiveMax - 1) {
					freshCollapse = { targetId: anchorId, task: chainStepNames, iteration: iteration + 1, totalIterations };
					const result = await ctx.navigateTree(anchorId, { summarize: true });
					freshCollapse = null;
					if (result.cancelled) {
						chainAborted = true;
						notify(ctx, "Loop cancelled", "warning");
						break;
					}
				}
			}

		} catch (error) {
			chainErrorState = { hasError: true, error };
		} finally {
			chainErrorState = await restoreAfterExecution(
				ctx,
				shouldRestore,
				originalModel,
				originalThinking,
				getCurrentModel(ctx),
				pi.getThinkingLevel(),
				chainErrorState,
				"chain",
			);

			pendingSkillMessage = undefined;
			chainActive = false;
			loopState = null;
			freshCollapse = null;
			boomerangCollapse = null;
			accumulatedSummaries = [];
			updateLoopStatus(ctx);
			if (ctx.hasUI) {
				ctx.ui.setStatus("prompt-chain", undefined);
			}

			if (!chainErrorState.hasError) {
				notifyLoopCompletion(ctx, completedIterations, totalIterations, effectiveMax, converged, true);
			}
		}

		if (lastDelegatedText && !chainErrorState.hasError && !chainAborted) {
			pi.sendUserMessage(`[Delegated chain complete: ${chainStepNames}]\n\n${lastDelegatedText}`);
			await waitForTurnStart(ctx);
			await ctx.waitForIdle();
		}

		if (chainErrorState.hasError) {
			throw chainErrorState.error;
		}
	}

	function isTuiMode(ctx: ExtensionCommandContext): boolean {
		return (ctx as ExtensionCommandContext & { mode?: string }).mode === "tui";
	}

	function hasCustomUi(ctx: ExtensionCommandContext): boolean {
		return typeof (ctx as ExtensionCommandContext & { ui?: { custom?: unknown } }).ui?.custom === "function";
	}

	function getDryRunUnsupportedReason(prompt: PromptWithModel): string | undefined {
		if (prompt.chain) return DRY_RUN_CHAIN_UNSUPPORTED;
		if (prompt.deterministic) return DRY_RUN_DETERMINISTIC_UNSUPPORTED;
		return undefined;
	}

	function buildPromptDryRunCatalog(): PromptTemplateCatalogItem[] {
		const merged = new Map<string, PromptWithModel>();
		for (const [name, prompt] of chainPrompts) merged.set(name, prompt);
		for (const [name, prompt] of prompts) merged.set(name, prompt);
		return Array.from(merged.values())
			.filter((prompt) => !prompt.hidden)
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((prompt) => ({
				name: prompt.name,
				source: prompt.source,
				displaySource: formatPromptSourceLabel(prompt),
				file: prompt.filePath,
				description: prompt.description,
				model: prompt.models[0],
				skillCount: getRequestedSkills(prompt).length,
				skills: getRequestedSkills(prompt),
				unsupportedReason: getDryRunUnsupportedReason(prompt),
			}));
	}

	async function openPromptDryRunInspector(ctx: ExtensionCommandContext, result: PromptDryRunResult, plainReport: string) {
		const ui = (ctx as ExtensionCommandContext & {
			ui: { custom: (factory: (...args: any[]) => unknown, options?: unknown) => Promise<PromptDryRunTuiResult | unknown> | PromptDryRunTuiResult | unknown };
		}).ui;
		return await ui.custom((tui, theme, _layout, done) => new PromptDryRunInspector(createPromptDryRunTuiViewModel(result, plainReport), tui, theme, done));
	}

	async function openPromptDryRunPicker(ctx: ExtensionCommandContext, initialTemplateName?: string): Promise<PromptDryRunTuiResult | undefined> {
		const ui = (ctx as ExtensionCommandContext & {
			ui: { custom: (factory: (...args: any[]) => unknown, options?: unknown) => Promise<PromptDryRunTuiResult | unknown> | PromptDryRunTuiResult | unknown };
		}).ui;
		const catalog = buildPromptDryRunCatalog();
		const result = await ui.custom((tui, theme, _layout, done) => new PromptDryRunPicker(catalog, initialTemplateName, tui, theme, done));
		return parsePromptDryRunPickerAction(result, catalog);
	}

	function notifyDryRunError(ctx: ExtensionCommandContext, message: string) {
		notify(ctx, message, "error");
	}

	function getOwnStringProperty(value: unknown, key: string): string | undefined {
		if (!value || typeof value !== "object") return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return undefined;
		return descriptor.value;
	}

	type PromptDryRunInspectorAction = { action: "back" } | { action: "closed" };

	function parsePromptDryRunInspectorAction(value: unknown): PromptDryRunInspectorAction | undefined {
		const action = getOwnStringProperty(value, "action");
		if (action === "back") return { action: "back" };
		if (action === "closed") return { action: "closed" };
		return undefined;
	}

	function parsePromptDryRunPickerAction(value: unknown, catalog: PromptTemplateCatalogItem[]): PromptDryRunTuiResult | undefined {
		const action = getOwnStringProperty(value, "action");
		if (action === "closed") return { action: "closed" };
		if (action === "back") return { action: "back" };
		if (action !== "selected") return undefined;

		const templateName = getOwnStringProperty(value, "templateName");
		if (!templateName) return undefined;
		if (!catalog.some((item) => item.name === templateName)) return undefined;
		return { action: "selected", templateName };
	}

	async function inspectPromptDryRunInTui(ctx: ExtensionCommandContext, promptName: string, rawArgs: string, showSkills: boolean): Promise<void> {
		const prompt = prompts.get(promptName) ?? chainPrompts.get(promptName);
		if (!prompt) {
			notify(ctx, `Prompt "${promptName}" not found`, "error");
			return;
		}

		const result = await createPromptDryRun(prompt, {
			cwd: ctx.cwd,
			rawArgs,
			currentModel: getCurrentModel(ctx),
			currentModelLabel: getCurrentModelLabel(ctx),
			modelRegistry: ctx.modelRegistry,
			commands: pi.getCommands() as RuntimeSkillCommand[],
			showSkills,
		});
		const plainReport = formatPromptDryRun(result);

		if (result.status === "error") {
			for (const warning of result.warnings) notify(ctx, warning, "warning");
			notify(ctx, result.error, "error");
			return;
		}

		for (const warning of result.warnings) notify(ctx, warning, "warning");
		const action = parsePromptDryRunInspectorAction(await openPromptDryRunInspector(ctx, result, plainReport));
		if (action?.action === "back") {
			const selection = await openPromptDryRunPicker(ctx, result.promptName);
			if (selection?.action === "selected") {
				await inspectPromptDryRunInTui(ctx, selection.templateName, rawArgs, showSkills);
			}
		}
	}

	async function runDryRunCommand(args: string, ctx: ExtensionCommandContext) {
		storedCommandCtx = ctx;
		refreshPrompts(ctx.cwd, ctx);
		const parsed = parseDryRunCommand(args);
		const useTui = isTuiMode(ctx) && !parsed.plain && hasCustomUi(ctx);
		if (!parsed.promptName) {
			if (useTui) {
				const selection = await openPromptDryRunPicker(ctx);
				if (selection?.action === "selected") {
					await inspectPromptDryRunInTui(ctx, selection.templateName, parsed.remainingArgs, parsed.showSkills);
				}
				return;
			}
			notifyDryRunError(ctx, "Usage: /print-prompt <template> [args] [--show-skills]. Run in Pi TUI mode to pick from templates, or pass a template name.");
			return;
		}

		const prompt = prompts.get(parsed.promptName) ?? chainPrompts.get(parsed.promptName);
		if (!prompt) {
			notify(ctx, `Prompt "${parsed.promptName}" not found`, "error");
			return;
		}

		const result = await createPromptDryRun(prompt, {
			cwd: ctx.cwd,
			rawArgs: parsed.remainingArgs,
			currentModel: getCurrentModel(ctx),
			currentModelLabel: getCurrentModelLabel(ctx),
			modelRegistry: ctx.modelRegistry,
			commands: pi.getCommands() as RuntimeSkillCommand[],
			showSkills: parsed.showSkills,
		});
		const plainReport = formatPromptDryRun(result);

		if (result.status === "error") {
			for (const warning of result.warnings) notify(ctx, warning, "warning");
			notify(ctx, result.error, "error");
			return;
		}

		for (const warning of result.warnings) notify(ctx, warning, "warning");
		if (useTui) {
			const action = parsePromptDryRunInspectorAction(await openPromptDryRunInspector(ctx, result, plainReport));
			if (action?.action === "back") {
				const selection = await openPromptDryRunPicker(ctx, result.promptName);
				if (selection?.action === "selected") {
					await inspectPromptDryRunInTui(ctx, selection.templateName, parsed.remainingArgs, parsed.showSkills);
				}
			}
			return;
		}
		if (parsed.plain || !ctx.hasUI) {
			if (parsed.tui && !parsed.plain) {
				notify(ctx, "--tui dry-run output is not available without Pi TUI custom UI; falling back to stdout.", "warning");
			}
			process.stdout.write(plainReport);
			return;
		}
		if (parsed.tui) {
			notify(ctx, "--tui dry-run output is not available without Pi TUI custom UI; showing a notification report instead.", "warning");
		}
		notify(ctx, plainReport, "info");
	}

	async function runPromptCommand(name: string, args: string, ctx: ExtensionCommandContext) {
		storedCommandCtx = ctx;
		refreshPrompts(ctx.cwd, ctx);
		const prompt = prompts.get(name);
		if (!prompt || prompt.hidden) {
			notify(ctx, `Prompt "${name}" is no longer available as a slash command`, "error");
			return;
		}
		if (!(await ensureProjectPromptLibraryApproved(prompt, ctx))) return;

		const subagent = extractSubagentOverride(args);
		const runtimeCwd = subagent.cwd ? expandCwdPath(subagent.cwd) : undefined;
		if (subagent.cwd && !runtimeCwd) {
			notify(ctx, `Invalid --cwd path: must be absolute`, "error");
			return;
		}
		const argsWithoutSubagent = subagent.args;
		if (prompt.deterministic) {
			if (subagent.override || subagent.fork) {
				notify(ctx, `Deterministic prompts do not support runtime --subagent/--fork in v1`, "error");
				return;
			}
			if (extractLoopCount(argsWithoutSubagent)) {
				notify(ctx, `Deterministic prompts do not support runtime --loop in v1`, "error");
				return;
			}
		}

		const hasCompareLineup = prompt.workers !== undefined || prompt.reviewers !== undefined || prompt.finalApplier !== undefined || prompt.preset !== undefined;
		if (hasCompareLineup) {
			await runComparePrompt(
				name,
				prompt,
				argsWithoutSubagent,
				ctx,
				getCurrentModel(ctx),
				{
					cwd: runtimeCwd,
					model: subagent.model,
					preset: subagent.preset,
					subagentOverride: subagent.override,
					fork: subagent.fork,
				},
			);
			return;
		}

		if (subagent.preset) {
			notify(ctx, `--preset is only supported on compare prompts (ignored)`, "warning");
		}

		if (prompt.chain) {
			if (subagent.model) notify(ctx, `--model is not supported on chain prompts (ignored)`, "warning");
			if (subagent.fork) notify(ctx, `--fork is not supported on chain prompts (ignored)`, "warning");
			const worktreeExtraction = extractWorktreeFlag(argsWithoutSubagent);
			const extracted = extractChainContextFlag(worktreeExtraction.args);
			const chainContextEnabled = extracted.chainContext || prompt.chainContext === "summary";
			const cliWorktree = worktreeExtraction.worktree;
			const loop = extractLoopCount(extracted.args);
			let totalIterations: number | null = prompt.loop !== undefined ? prompt.loop : 1;
			let fresh = false;
			let converge = true;
			let cleanedArgs = extracted.args;

			if (loop) {
				totalIterations = loop.loopCount;
				fresh = loop.fresh;
				converge = loop.converge;
				cleanedArgs = loop.args;
			} else if (prompt.loop !== undefined) {
				const flags = extractLoopFlags(extracted.args);
				fresh = flags.fresh;
				converge = flags.converge;
				cleanedArgs = flags.args;
			}

			const { steps, invalidSegments } = parseChainDeclaration(prompt.chain);
			if (invalidSegments.length > 0) {
				notify(ctx, `Invalid chain step: ${invalidSegments[0]}`, "error");
				return;
			}
			if (steps.length === 0) {
				notify(ctx, "No templates specified", "error");
				return;
			}

			const cwdOverride = runtimeCwd ?? prompt.cwd;
			await runSharedChainExecution(
				steps,
				parseCommandArgs(cleanedArgs),
				totalIterations,
				fresh || prompt.fresh === true,
				converge && prompt.converge !== false,
				prompt.restore,
				ctx,
				subagent.override,
				cwdOverride,
				chainContextEnabled,
				prompt.worktree === true,
				cliWorktree,
			);
			return;
		}

		const promptOverrides: Partial<Pick<PromptWithModel, "models" | "inheritContext">> = {
			...(subagent.model ? { models: [subagent.model] } : {}),
			...(subagent.fork ? { inheritContext: true } : {}),
		};

		const loop = extractLoopCount(argsWithoutSubagent);
		if (loop) {
			await runPromptLoop(name, loop.args, loop.loopCount, loop.fresh, loop.converge, ctx, subagent.override, runtimeCwd, promptOverrides);
			return;
		}

		if (prompt.loop !== undefined) {
			const flags = extractLoopFlags(argsWithoutSubagent);
			await runPromptLoop(name, flags.args, prompt.loop, flags.fresh, flags.converge, ctx, subagent.override, runtimeCwd, promptOverrides);
			return;
		}

		const effectivePrompt = {
			...prompt,
			...(runtimeCwd ? {
				cwd: runtimeCwd,
				...(prompt.deterministic ? { deterministic: { ...prompt.deterministic, cwd: runtimeCwd } } : {}),
			} : {}),
			...promptOverrides,
		};
		const savedModel = getCurrentModel(ctx);
		const savedThinking = pi.getThinkingLevel();
		const boomerangTargetId = effectivePrompt.boomerang ? ctx.sessionManager.getLeafId() : null;
		const stepResult = await executePromptStep(
			effectivePrompt,
			parseCommandArgs(argsWithoutSubagent),
			ctx,
			savedModel,
			subagent.override,
		);
		if (stepResult === "aborted") return;
		if (shouldDelegatePrompt(effectivePrompt, subagent.override) && stepResult.text) {
			pi.sendUserMessage(`[Delegated result: ${name}]\n\n${stepResult.text}`);
			await waitForTurnStart(ctx);
			await ctx.waitForIdle();
		}

		if (!shouldDelegatePrompt(effectivePrompt, subagent.override) && prompt.restore) {
			const currentModel = getCurrentModel(ctx);
			if (savedModel && currentModel && !sameModel(savedModel, currentModel)) {
				previousModel = savedModel;
				previousThinking = savedThinking;
			}
			if (effectivePrompt.thinking && previousThinking === undefined && effectivePrompt.thinking !== savedThinking) {
				previousThinking = savedThinking;
			}
		}

		if (effectivePrompt.boomerang) {
			await collapseBoomerangPrompt(ctx, name, boomerangTargetId);
		}
	}

	function resetSessionScopedState(ctx: ExtensionContext) {
		storedCommandCtx = null;
		approvedProjectPromptLibraryCwds.clear();
		approvedProjectPresetCwds.clear();
		pendingSkillMessage = undefined;
		previousModel = undefined;
		previousThinking = undefined;
		runtimeModel = ctx.model;
		boomerangCollapse = null;
		toolManager.clearQueue();
		refreshPrompts(ctx.cwd, ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		resetSessionScopedState(ctx);
	});

	pi.on("model_select", async (event) => {
		runtimeModel = event.model;
	});

	pi.on("before_agent_start", async (event) => {
		let systemPrompt = event.systemPrompt;

		if (toolManager.isEnabled() && !loopState && !chainActive) {
			const toolGuidance = toolManager.getGuidance();
			const guidance = toolGuidance
				? `The run-prompt tool is available for running prompt template commands. ${toolGuidance}`
				: "The run-prompt tool is available for running prompt template commands.";
			systemPrompt += `\n\n${guidance}`;
		}

		if (loopState) {
			const iterText =
				loopState.totalIterations !== null
					? `iteration ${loopState.currentIteration} of ${loopState.totalIterations}`
					: `iteration ${loopState.currentIteration}`;
			systemPrompt += `\n\nYou are on ${iterText} of the same prompt. Previous iterations and their results are visible in the conversation above. Build on that work — focus on what remains to improve.`;
		}

		const skillMessage = consumePendingSkillMessage();
		const hasSystemPromptOverride = systemPrompt !== event.systemPrompt;
		if (!hasSystemPromptOverride && !skillMessage) return;

		return {
			...(hasSystemPromptOverride ? { systemPrompt } : {}),
			...(skillMessage ? { message: skillMessage } : {}),
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (chainActive) return;
		if (loopState) return;

		runtimeModel = ctx.model;

		const restoreModel = previousModel;
		const restoreThinking = previousThinking;
		previousModel = undefined;
		previousThinking = undefined;

		const restoreFn = async () => {
			if (restoreModel || restoreThinking !== undefined) {
				await restoreSessionState(ctx, restoreModel, restoreThinking, getCurrentModel(ctx), pi.getThinkingLevel());
			}
		};
		const processed = await toolManager.processQueue(ctx, restoreFn);
		if (processed) return;
		await restoreFn();
	});

	pi.on("session_before_tree", async (event) => {
		if (boomerangCollapse && event.preparation.targetId === boomerangCollapse.targetId) {
			const summary = generateBoomerangSummary(event.preparation.entriesToSummarize, boomerangCollapse.task);
			return {
				summary: {
					summary: [...boomerangCollapse.previousSummaries, summary].join("\n\n---\n\n"),
				},
			};
		}

		if (!freshCollapse) return;
		if (event.preparation.targetId !== freshCollapse.targetId) return;

		const summary = generateIterationSummary(
			event.preparation.entriesToSummarize,
			freshCollapse.task,
			freshCollapse.iteration,
			freshCollapse.totalIterations,
		);
		accumulatedSummaries.push(summary);

		return {
			summary: {
				summary: accumulatedSummaries.join("\n\n---\n\n"),
			},
		};
	});

	async function runChainCommand(args: string, ctx: ExtensionCommandContext) {
		storedCommandCtx = ctx;
		refreshPrompts(ctx.cwd, ctx);

		const subagent = extractSubagentOverride(args);
		const runtimeCwd = subagent.cwd ? expandCwdPath(subagent.cwd) : undefined;
		if (subagent.cwd && !runtimeCwd) {
			notify(ctx, `Invalid --cwd path: must be absolute`, "error");
			return;
		}
		const worktreeExtraction = extractWorktreeFlag(subagent.args);
		const extracted = extractChainContextFlag(worktreeExtraction.args);
		const loop = extractLoopCount(extracted.args);
		const cleanedArgs = loop ? loop.args : extracted.args;

		const { steps, sharedArgs, invalidSegments } = parseChainSteps(cleanedArgs);
		if (invalidSegments.length > 0) {
			notify(ctx, `Invalid chain step: ${invalidSegments[0]}`, "error");
			return;
		}
		if (steps.length === 0) {
			notify(ctx, "No templates specified", "error");
			return;
		}

		await runSharedChainExecution(
			steps,
			sharedArgs,
			loop ? loop.loopCount : 1,
			loop?.fresh === true,
			loop?.converge ?? true,
			true,
			ctx,
			subagent.override,
			runtimeCwd,
			extracted.chainContext,
			false,
			worktreeExtraction.worktree,
		);
	}

	function parseCompareRunPickerAction(value: unknown, history: BestOfNRunHistoryResult): CompareRunHistoryTuiResult | undefined {
		const action = getOwnStringProperty(value, "action");
		if (action === "closed") return { action: "closed" };
		if (action === "back") return { action: "back" };
		if (action !== "selected") return undefined;
		const runId = getOwnStringProperty(value, "runId");
		if (!runId) return undefined;
		if (!history.entries.some((entry) => entry.name === runId)) return undefined;
		return { action: "selected", runId };
	}

	async function openCompareRunPicker(ctx: ExtensionCommandContext, history: BestOfNRunHistoryResult, initialRunId?: string): Promise<CompareRunHistoryTuiResult | undefined> {
		const ui = (ctx as ExtensionCommandContext & {
			ui: { custom: (factory: (...args: any[]) => unknown, options?: unknown) => Promise<CompareRunHistoryTuiResult | unknown> | CompareRunHistoryTuiResult | unknown };
		}).ui;
		const result = await ui.custom((tui, theme, _layout, done) => new CompareRunPicker(buildCompareRunCatalog(history), initialRunId, tui, theme, done));
		return parseCompareRunPickerAction(result, history);
	}

	async function openCompareRunInspector(ctx: ExtensionCommandContext, history: BestOfNRunHistoryResult, runId: string): Promise<CompareRunHistoryTuiResult | undefined> {
		const run = history.entries.find((entry) => entry.name === runId);
		if (!run) return undefined;
		const ui = (ctx as ExtensionCommandContext & {
			ui: { custom: (factory: (...args: any[]) => unknown, options?: unknown) => Promise<CompareRunHistoryTuiResult | unknown> | CompareRunHistoryTuiResult | unknown };
		}).ui;
		const result = await ui.custom((tui, theme, _layout, done) => new CompareRunDetailInspector(createCompareRunDetailViewModel(history, run), tui, theme, done));
		return parseCompareRunPickerAction(result, history);
	}

	async function inspectCompareRunInTui(ctx: ExtensionCommandContext, history: BestOfNRunHistoryResult, runId: string): Promise<void> {
		const action = await openCompareRunInspector(ctx, history, runId);
		if (action?.action === "back") {
			const selection = await openCompareRunPicker(ctx, history, runId);
			if (selection?.action === "selected") await inspectCompareRunInTui(ctx, history, selection.runId);
		}
	}

	async function runCompareRunsCommand(args: string, ctx: ExtensionCommandContext) {
		storedCommandCtx = ctx;
		const options = parseBestOfNRunHistoryArgs(args);
		const history = collectBestOfNRunHistory(ctx.cwd, options);
		const selectedRun = options.runId ? history.entries.find((entry) => entry.name === options.runId) : undefined;
		if (options.plain) {
			process.stdout.write(selectedRun ? formatBestOfNRunDetail(history, selectedRun) : formatBestOfNRunHistory(history));
			return;
		}
		if (isTuiMode(ctx) && hasCustomUi(ctx)) {
			if (options.runId) {
				if (selectedRun) await inspectCompareRunInTui(ctx, history, selectedRun.name);
				else notify(ctx, `Compare run "${options.runId}" was not found in the current run history.`, "error");
				return;
			}
			const selection = await openCompareRunPicker(ctx, history);
			if (selection?.action === "selected") await inspectCompareRunInTui(ctx, history, selection.runId);
			return;
		}
		notify(ctx, selectedRun ? formatBestOfNRunDetail(history, selectedRun) : formatBestOfNRunHistory(history), selectedRun || !options.runId ? "info" : "error");
	}

	function parseComparePresetsArgs(args: string): { plain: boolean } {
		return { plain: args.split(/\s+/).some((arg) => arg === "--plain") };
	}

	async function runComparePresetsCommand(args: string, ctx: ExtensionCommandContext) {
		storedCommandCtx = ctx;
		const options = parseComparePresetsArgs(args);
		const catalog = loadBestOfNPresetCatalog(ctx.cwd);
		const output = formatBestOfNPresetCatalog(catalog, ctx.cwd);
		if (options.plain) {
			process.stdout.write(output);
			return;
		}
		notify(ctx, output, catalog.diagnostics.length > 0 ? "warning" : "info");
	}

	refreshPrompts(process.cwd());
	if (toolManager.isEnabled()) toolManager.ensureRegistered();

	pi.registerCommand("chain-prompts", {
		description: "Chain prompt templates sequentially [template -> template -> ...]",
		handler: async (args, ctx) => {
			await runChainCommand(args, ctx);
		},
	});
	pi.registerCommand("validate-prompts", {
		description: "Validate prompt templates, includes, frontmatter, and skill references",
		handler: async (_args, ctx) => {
			const validation = validatePromptTemplates(ctx.cwd, { registeredSkills: collectRegisteredPromptSkills() });
			notify(ctx, formatPromptValidationReport(validation), validation.ok ? "info" : "error");
		},
	});
	pi.registerCommand("compare-runs", {
		description: "List recent best-of-N compare run reports and retained artifacts",
		handler: async (args, ctx) => {
			await runCompareRunsCommand(args, ctx);
		},
	});
	pi.registerCommand("compare-presets", {
		description: "List available best-of-N compare presets without approving or running them",
		handler: async (args, ctx) => {
			await runComparePresetsCommand(args, ctx);
		},
	});
	pi.registerCommand("best-of-n-runs", {
		description: "Alias for /compare-runs",
		handler: async (args, ctx) => {
			await runCompareRunsCommand(args, ctx);
		},
	});
	pi.registerCommand("best-of-n-presets", {
		description: "Alias for /compare-presets",
		handler: async (args, ctx) => {
			await runComparePresetsCommand(args, ctx);
		},
	});
	pi.registerCommand("print-prompt", {
		description: "Print the rendered prompt template without running it",
		handler: async (args, ctx) => {
			await runDryRunCommand(args, ctx);
		},
	});
	pi.registerCommand("dry-run-prompt", {
		description: "Dry-run a prompt template and show what would be sent",
		handler: async (args, ctx) => {
			await runDryRunCommand(args, ctx);
		},
	});
	toolManager.registerCommand();
}
