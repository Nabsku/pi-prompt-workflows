import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	extractChainContextFlag,
	extractLoopCount,
	extractLoopFlags,
	extractSubagentOverride,
	findRemovedLegacyRuntimeFlag,
	parseCommandArgs,
	splitRawArgsAtBoundary,
	substituteArgs,
	type SubagentOverride,
} from "./args.js";
import { parseChainSteps, parseChainDeclaration, type ChainStep } from "./chain-parser.js";
import { AdaptiveChainCancelledError, executeAdaptiveChain } from "./adaptive-runtime.js";
import { formatAdaptiveDecision, formatAdaptiveError, formatAdaptiveRuntimeReport } from "./adaptive-renderer.js";
import { captureGitWorktreeSnapshot, compareGitWorktreeSnapshots } from "./git-worktree-snapshot.js";
import { generateBoomerangSummary, generateChainStepSummary, generateIterationSummary, didIterationMakeChanges, getIterationEntries, getLastAssistantText, wasIterationAborted } from "./loop-utils.js";
import { selectModelCandidate } from "./model-selection.js";
import { notify, summarizePromptDiagnostics, diagnosticsFingerprint } from "./notifications.js";
import { checkPromptExecutionBudget, normalizePromptCompletionOutcome, preparePromptExecution, PromptBudgetExceededError, renderPromptForResolvedModel } from "./prompt-execution.js";
import {
	buildPromptCommandDescription,
	expandCwdPath,
	formatPromptSourceLabel,
	loadPromptsWithModel,
	collectPromptSourceRecords,
	selectEffectivePromptSourceRecords,
	type PromptWithModel,
} from "./prompt-loader.js";
import { createInvalidAdaptivePreflight, isAdaptivePromptTarget, isAdaptiveRunTarget } from "./adaptive-preflight.js";
import { PromptInputForm } from "./prompt-input-tui.js";
import { inputModeEligibilityError, resolvePromptInputs } from "./prompt-inputs.js";
import {
	buildSkillLoadedMessage,
	getRequestedSkills,
	resolvePromptSkills,
	type PendingSkillMessage,
	type RuntimeSkillCommand,
} from "./prompt-skills.js";
import { renderSkillLoaded, type SkillLoadedDetails } from "./skill-loaded-renderer.js";
import { createToolManager } from "./tool-manager.js";
import { DelegatedPromptCancelledError, executeSubagentPromptStep } from "./subagent-step.js";
import {
	DEFAULT_SUBAGENT_NAME,
	PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT,
	PROMPT_TEMPLATE_PROMPT_INVOKE_ACK_EVENT,
	PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
	PROMPT_TEMPLATE_PROMPT_INVOKE_REQUEST_EVENT,
	PROMPT_TEMPLATE_PROMPT_PROTOCOL_VERSION,
	PROMPT_TEMPLATE_PROMPT_STARTED_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE,
	type PromptTemplatePromptFinished,
	type PromptTemplatePromptInvokeAcknowledgement,
	type PromptTemplatePromptInvokeRequest,
	type PromptTemplatePromptStarted,
	type PromptTemplatePromptStatus,
} from "./subagent-runtime.js";
import { renderDelegatedSubagentResult } from "./subagent-renderer.js";
import {
	PROMPT_TEMPLATE_DETERMINISTIC_COMPLETION_MESSAGE_TYPE,
	PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE,
	buildDeterministicPreamble,
	normalizeDeterministicExecutionOutcome,
	runDeterministicStep,
	shouldHandoffToLlm,
} from "./deterministic-step.js";
import { renderDeterministicCompletion, renderDeterministicResult } from "./deterministic-renderer.js";
import { collectChangedGatePredecessors, formatPromptValidationReport, validatePromptTemplates, type RegisteredPromptSkill } from "./prompt-validation.js";
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
	terminalAssistantMessage?: AssistantMessage;
	aborted?: boolean;
	status?: PromptTemplatePromptStatus;
}

interface PromptTurnRestore {
	originalModel: Model<any> | undefined;
	originalThinking: ThinkingLevel | undefined;
}

interface CommandExecutionScope {
	generation: number;
	signal: AbortSignal;
	skipAgentEndDrain?: boolean;
}

interface PendingPromptTurn {
	content: string;
	generation: number;
	started: boolean;
	settled: boolean;
	startedSignal: Promise<void>;
	resolveStarted: () => void;
	settledSignal: Promise<void>;
	resolveSettled: () => void;
}

// Graph invocations run from a base ExtensionContext, which has no waitForIdle.
// Pi's extension send is fire-and-forget and cannot be cancelled by this
// extension. These are warning tripwires, not cancellation deadlines: the
// extension retains ownership until the matching turn settles or the session
// is reset.
const INVOKE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const COMPACTION_WAIT_FALLBACK_MS = 5 * 60 * 1000;

function getExtensionEvents(pi: ExtensionAPI): ExtensionAPI["events"] | undefined {
	return (pi as ExtensionAPI & { events?: ExtensionAPI["events"] }).events;
}

function emitPromptLifecycleEvent(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined,
	event: typeof PROMPT_TEMPLATE_PROMPT_STARTED_EVENT | typeof PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT,
	payload: PromptTemplatePromptStarted | PromptTemplatePromptFinished,
): void {
	const events = getExtensionEvents(pi);
	if (!events) return;
	try {
		events.emit(event, payload);
	} catch (error) {
		notify(ctx, `Prompt lifecycle observer failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}
}

function emitPromptInvocationAcknowledgement(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined,
	payload: PromptTemplatePromptInvokeAcknowledgement,
): void {
	const events = getExtensionEvents(pi);
	if (!events) return;
	try {
		events.emit(PROMPT_TEMPLATE_PROMPT_INVOKE_ACK_EVENT, payload);
	} catch (error) {
		notify(ctx, `Prompt invocation observer failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}
}

export default function promptModelExtension(pi: ExtensionAPI) {
	let prompts = new Map<string, PromptWithModel>();
	let chainPrompts = new Map<string, PromptWithModel>();
	let adaptivePrompts = new Map<string, PromptWithModel>();
	let blockedAdaptivePrompts = new Map<string, { name: string; source: "user" | "project"; rootKind: "prompts" | "prompt-library"; filePath: string; hidden: boolean; diagnostics: string[] }>();
	let previousModel: Model<any> | undefined;
	let previousThinking: ThinkingLevel | undefined;
	let pendingSkillMessage: PendingSkillMessage | undefined;
	let runtimeModel: Model<any> | undefined;
	let promptActivityCount = 0;
	let workflowOwner: symbol | null = null;
	const isWorkflowActive = () => workflowOwner !== null;
	const isPromptActive = () => promptActivityCount > 0;
	function claimWorkflowOwner(label: string, allowPromptActive = false): symbol | undefined {
		if (workflowOwner !== null || (isPromptActive() && !allowPromptActive)) return undefined;
		const owner = Symbol(label);
		workflowOwner = owner;
		return owner;
	}
	function releaseWorkflowOwner(owner: symbol): boolean {
		if (workflowOwner !== owner) return false;
		workflowOwner = null;
		return true;
	}

	function ownsWorkflowSession(generation: number, owner?: symbol): boolean {
		return sessionGeneration === generation && (owner === undefined || workflowOwner === owner);
	}
	let loopState: LoopState | null = null;
	let freshCollapse: FreshCollapse | null = null;
	let boomerangCollapse: BoomerangCollapse | null = null;
	let accumulatedSummaries: string[] = [];
	let lastDiagnostics = "";
	let storedCommandCtx: ExtensionCommandContext | null = null;
	let invocationCtx: ExtensionContext | null = null;
	let sessionGeneration = 0;
	let sessionActive = false;
	let sessionAbortController = new AbortController();
	const activeSessionRestorations = new Set<Promise<unknown>>();
	const commandExecutionScope = new AsyncLocalStorage<CommandExecutionScope>();
	let pendingCompaction: Promise<void> | null = null;
	let resolvePendingCompaction: (() => void) | null = null;
	let pendingCompactionFallbackTimer: ReturnType<typeof setTimeout> | null = null;
	let nextCompactionGeneration = 0;
	let activeCompactionGeneration: number | null = null;
	type CompactionReleaseReason = "terminal" | "turn_start" | "abort" | "fallback" | "reset";
	const compactionReleaseReasons = new Map<number, CompactionReleaseReason>();
	let compactionTerminalCorrelationLost = false;
	let removeActiveCompactionAbortListener: (() => void) | null = null;
	let agentEndDrain: Promise<void> | null = null;
	let resolveAgentEndDrain: (() => void) | null = null;
	let agentEndDrainDepth = 0;
	let queuedAgentSettledDrainPending = false;
	let queuedAgentSettledDrainGenerationBaseline: number | null = null;
	let pendingPromptTurn: PendingPromptTurn | null = null;
	const approvedProjectPromptLibraryCwds = new Set<string>();
	const UNLIMITED_LOOP_CAP = 999;

	function captureCommandExecutionScope(ctx: ExtensionContext): CommandExecutionScope {
		const parent = commandExecutionScope.getStore();
		if (parent) return parent;
		const signals = [sessionAbortController.signal, ...(ctx.signal ? [ctx.signal] : [])];
		return {
			generation: sessionGeneration,
			signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals),
		};
	}

	function getCommandSignal(ctx: ExtensionContext): AbortSignal | undefined {
		return commandExecutionScope.getStore()?.signal ?? ctx.signal;
	}

	function isCommandAborted(ctx: ExtensionContext): boolean {
		return getCommandSignal(ctx)?.aborted === true;
	}

	function isCommandExecutionCurrent(ctx: ExtensionContext): boolean {
		const scope = commandExecutionScope.getStore();
		return sessionActive
			&& (scope === undefined || (scope.generation === sessionGeneration && !scope.signal.aborted))
			&& ctx.signal?.aborted !== true;
	}

	function beginCompactionBarrier(
		signal?: AbortSignal,
		ctx?: Pick<ExtensionContext, "hasUI" | "ui">,
	): boolean {
		if (activeCompactionGeneration !== null) {
			notify(ctx, "Compaction request refused because another compaction generation is still active.", "warning");
			return false;
		}
		if (signal?.aborted) return false;
		const generation = ++nextCompactionGeneration;
		activeCompactionGeneration = generation;
		const startedAt = Date.now();
		const barrier = new Promise<void>((resolve) => {
			resolvePendingCompaction = resolve;
		});
		pendingCompaction = barrier;
		pendingCompactionFallbackTimer = setTimeout(() => {
			if (pendingCompaction !== barrier) return;
			const observedMs = Math.max(0, Date.now() - startedAt);
			if (pendingPromptTurn && pendingPromptTurn.generation === sessionGeneration && !pendingPromptTurn.started) {
				pendingCompactionFallbackTimer = null;
				notify(
					ctx,
					`The host send remains owned after the compaction wait tripwire: budget ${COMPACTION_WAIT_FALLBACK_MS}ms, configured ${COMPACTION_WAIT_FALLBACK_MS}ms, observed ${observedMs}ms. Pi 0.84.1 does not expose cancellation for this fire-and-forget send, so the barrier remains active until session_compact, before_agent_start, session reset, or shutdown. Do not retry; inspect the host compaction logs.`,
					"warning",
				);
				return;
			}
			notify(
				ctx,
				`Compaction barrier fallback released blocked work: budget ${COMPACTION_WAIT_FALLBACK_MS}ms, configured ${COMPACTION_WAIT_FALLBACK_MS}ms, observed ${observedMs}ms. A session_compact, before_agent_start, or abort signal did not arrive; pending commands were cancelled. Untagged compaction terminals remain fail-closed until the host accepts another prompt or this extension reloads. Inspect the compaction hooks before increasing the fallback.`,
				"warning",
			);
			compactionTerminalCorrelationLost = true;
			finishCompactionGeneration(generation, "fallback");
		}, COMPACTION_WAIT_FALLBACK_MS);
		if (signal) {
			const onAbort = () => finishCompactionGeneration(generation, "abort");
			signal.addEventListener("abort", onAbort, { once: true });
			removeActiveCompactionAbortListener = () => signal.removeEventListener("abort", onAbort);
		}
		return true;
	}

	function completeCompactionBarrier(expected = pendingCompaction) {
		if (!expected || pendingCompaction !== expected) return;
		const resolve = resolvePendingCompaction;
		const fallbackTimer = pendingCompactionFallbackTimer;
		resolvePendingCompaction = null;
		pendingCompactionFallbackTimer = null;
		pendingCompaction = null;
		if (fallbackTimer) clearTimeout(fallbackTimer);
		resolve?.();
	}

	function finishCompactionGeneration(
		expected = activeCompactionGeneration,
		reason: CompactionReleaseReason = "terminal",
	): void {
		if (expected === null || activeCompactionGeneration !== expected) return;
		compactionReleaseReasons.set(expected, reason);
		while (compactionReleaseReasons.size > 32) {
			const oldest = compactionReleaseReasons.keys().next().value;
			if (oldest === undefined) break;
			compactionReleaseReasons.delete(oldest);
		}
		const removeAbortListener = removeActiveCompactionAbortListener;
		activeCompactionGeneration = null;
		removeActiveCompactionAbortListener = null;
		removeAbortListener?.();
		completeCompactionBarrier();
	}

	function handleCompactionTerminal(): void {
		if (compactionTerminalCorrelationLost) {
			if (activeCompactionGeneration !== null && invocationCtx) {
				notify(
					invocationCtx,
					`Ignored an uncorrelated session_compact event while a compaction barrier is active: fallback budget ${COMPACTION_WAIT_FALLBACK_MS}ms, configured ${COMPACTION_WAIT_FALLBACK_MS}ms. Wait for the host to accept another prompt or reload this extension to restore terminal correlation.`,
					"warning",
				);
			}
			return;
		}
		finishCompactionGeneration(activeCompactionGeneration, "terminal");
	}

	async function waitForPendingCompaction() {
		while (pendingCompaction) await pendingCompaction;
	}

	async function waitForPendingCompactionBoundary(): Promise<boolean> {
		const generation = activeCompactionGeneration;
		await waitForPendingCompaction();
		return generation === null || compactionReleaseReasons.get(generation) !== "fallback";
	}

	function enterAgentEndDrain(): void {
		if (agentEndDrainDepth === 0) {
			agentEndDrain = new Promise<void>((resolve) => {
				resolveAgentEndDrain = resolve;
			});
		}
		agentEndDrainDepth++;
	}

	function leaveAgentEndDrain(): void {
		if (agentEndDrainDepth === 0) return;
		agentEndDrainDepth--;
		if (agentEndDrainDepth > 0) return;
		const resolve = resolveAgentEndDrain;
		agentEndDrain = null;
		resolveAgentEndDrain = null;
		resolve?.();
	}

	function clearAgentEndDrain(): void {
		agentEndDrainDepth = 0;
		const resolve = resolveAgentEndDrain;
		agentEndDrain = null;
		resolveAgentEndDrain = null;
		resolve?.();
	}

	async function waitForAgentEndDrain(): Promise<void> {
		while (agentEndDrain) await agentEndDrain;
	}

	function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
		const candidate = ctx as Partial<ExtensionCommandContext>;
		return typeof candidate.waitForIdle === "function" && typeof candidate.navigateTree === "function";
	}

	async function pollUntil(
		ctx: ExtensionContext,
		done: () => boolean,
		warningMs: number,
		what: string,
	): Promise<void> {
		const startedAt = Date.now();
		let warned = false;
		while (!done()) {
			if (isCommandAborted(ctx)) throw new Error(`Prompt invocation aborted while ${what}`);
			const observedMs = Math.max(0, Date.now() - startedAt);
			if (!warned && observedMs >= warningMs) {
				warned = true;
				notify(
					ctx,
					`Prompt invocation is still ${what}: warning budget ${warningMs}ms, configured ${warningMs}ms, observed ${observedMs}ms. Pi 0.84.1 does not expose cancellation for the owned host turn, so this workflow will keep waiting. Do not retry; reset or shut down the session to cancel ownership.`,
					"warning",
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	async function waitForPromptIdle(ctx: ExtensionContext): Promise<void> {
		if (isCommandContext(ctx)) {
			const signal = getCommandSignal(ctx);
			if (!signal) {
				await ctx.waitForIdle();
				return;
			}
			if (signal.aborted) throw new Error("Prompt invocation aborted while waiting for the run to finish");
			let onAbort!: () => void;
			const aborted = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(new Error("Prompt invocation aborted while waiting for the run to finish"));
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				await Promise.race([ctx.waitForIdle(), aborted]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
			return;
		}
		await pollUntil(ctx, () => ctx.isIdle(), INVOKE_IDLE_TIMEOUT_MS, "waiting for the run to finish");
	}

	async function waitForCommandLifecycleBoundary(
		ctx: ExtensionContext,
		options: { skipAgentEndDrain?: boolean } = {},
	): Promise<boolean> {
		const scope = commandExecutionScope.getStore();
		const skipAgentEndDrain = options.skipAgentEndDrain ?? scope?.skipAgentEndDrain ?? false;
		const expectedGeneration = scope?.generation ?? sessionGeneration;
		const isCurrentSession = () => isCommandExecutionCurrent(ctx) && sessionGeneration === expectedGeneration;
		if (!isCurrentSession()) return false;
		while (true) {
			if (!(await waitForPendingCompactionBoundary())) return false;
			if (!isCurrentSession()) return false;
			if (!skipAgentEndDrain) await waitForAgentEndDrain();
			if (!isCurrentSession()) return false;
			if (!ctx.isIdle()) await waitForPromptIdle(ctx);
			if (!isCurrentSession()) return false;
			if (!(await waitForPendingCompactionBoundary())) return false;
			if (!isCurrentSession()) return false;
			if (!skipAgentEndDrain && agentEndDrain) {
				await waitForAgentEndDrain();
				if (!isCurrentSession()) return false;
				continue;
			}
			return true;
		}
	}

	async function sendUserMessageAndWait(content: string, ctx: ExtensionContext): Promise<boolean> {
		if (!(await waitForCommandLifecycleBoundary(ctx))) return false;
		if (pendingPromptTurn) {
			throw new Error("Cannot start a second host prompt while another fire-and-forget send is still owned by this extension.");
		}

		let resolveStarted!: () => void;
		let resolveSettled!: () => void;
		const pending: PendingPromptTurn = {
			content,
			generation: sessionGeneration,
			started: false,
			settled: false,
			startedSignal: new Promise<void>((resolve) => { resolveStarted = resolve; }),
			resolveStarted: () => resolveStarted(),
			settledSignal: new Promise<void>((resolve) => { resolveSettled = resolve; }),
			resolveSettled: () => resolveSettled(),
		};
		pendingPromptTurn = pending;
		const startedAt = Date.now();
		let warned = false;
		const pollDelay = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
		const warnIfNeeded = () => {
			const observedMs = Math.max(0, Date.now() - startedAt);
			if (warned || observedMs < INVOKE_IDLE_TIMEOUT_MS) return;
			warned = true;
			notify(
				ctx,
				`The owned host turn has not settled: warning budget ${INVOKE_IDLE_TIMEOUT_MS}ms, configured ${INVOKE_IDLE_TIMEOUT_MS}ms, observed ${observedMs}ms. Pi 0.84.1 exposes this send as fire-and-forget, so the workflow will keep waiting rather than report a false cancellation. Do not retry; inspect host send and compaction logs, or reset the session.`,
				"warning",
			);
		};
		try {
			pi.sendUserMessage(content);
			while (ctx.isIdle() && !pending.started && !pending.settled) {
				if (!isCommandExecutionCurrent(ctx)) return false;
				warnIfNeeded();
				await Promise.race([pending.startedSignal, pending.settledSignal, pollDelay()]);
			}
			while (ctx.isIdle() && pending.started && !pending.settled) {
				if (!isCommandExecutionCurrent(ctx)) return false;
				warnIfNeeded();
				await Promise.race([pending.settledSignal, pollDelay()]);
			}

			if (!isCommandExecutionCurrent(ctx)) return false;
			if (!pending.settled) await waitForPromptIdle(ctx);
			return isCommandExecutionCurrent(ctx);
		} finally {
			if (pendingPromptTurn === pending) pendingPromptTurn = null;
		}
	}

	const toolManager = createToolManager(pi, {
		isActive: () => !!(loopState || isWorkflowActive()),
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

	async function ensureProjectPromptLibraryApproved(prompt: PromptWithModel, ctx: ExtensionContext): Promise<boolean> {
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

	pi.registerMessageRenderer<SkillLoadedDetails>("skill-loaded", renderSkillLoaded);
	pi.registerMessageRenderer(PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE, renderDelegatedSubagentResult);
	pi.registerMessageRenderer(PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE, renderDeterministicResult);
	pi.registerMessageRenderer(PROMPT_TEMPLATE_DETERMINISTIC_COMPLETION_MESSAGE_TYPE, renderDeterministicCompletion);

	function registerPromptCommand(name: string) {
		pi.registerCommand(name, {
			description: buildPromptCommandDescription(prompts.get(name)!),
			handler: async (args, ctx) => {
				await runPromptCommand(name, args, ctx);
			},
		});
	}

	function registerAdaptivePromptCommand(name: string, prompt: PromptWithModel) {
		pi.registerCommand(name, {
			description: buildPromptCommandDescription(prompt),
			handler: async (args, ctx) => { await runAdaptivePromptCommand(name, args, ctx); },
		});
	}

	function projectIsTrusted(ctx?: Partial<ExtensionContext>): boolean {
		return typeof ctx?.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
	}

	function refreshPrompts(cwd: string, ctx?: ExtensionContext) {
		const loaderOptions = { projectTrusted: projectIsTrusted(ctx) };
		const result = loadPromptsWithModel(cwd, false, loaderOptions);
		const chainResult = loadPromptsWithModel(cwd, true, { ...loaderOptions, includeAdaptiveChains: true });
		prompts = result.prompts;
		chainPrompts = chainResult.prompts;
		adaptivePrompts = new Map([...chainResult.prompts].filter(([, prompt]) => prompt.adaptiveChain !== undefined));
		const inventory = collectPromptSourceRecords(cwd, true, loaderOptions).inventoryRecords;
		blockedAdaptivePrompts = new Map();
		for (const record of selectEffectivePromptSourceRecords(inventory).values()) {
			if (chainResult.prompts.has(record.promptName)) continue;
			if (!record.isStructuredChainDeclaration) continue;
			const related = chainResult.diagnostics.filter((diagnostic) => diagnostic.filePath === record.filePath && diagnostic.code.includes("chain"));
			if (!related.length) continue;
			blockedAdaptivePrompts.set(record.promptName, { name: record.promptName, source: record.source, rootKind: record.rootKind, filePath: record.filePath, hidden: record.hidden === true, diagnostics: related.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`) });
		}

		for (const [name, prompt] of prompts) {
			if (prompt.hidden) continue;
			registerPromptCommand(name);
		}
		for (const [name, prompt] of adaptivePrompts) {
			if (prompt.hidden) continue;
			registerAdaptivePromptCommand(name, prompt);
		}

		const summary = summarizePromptDiagnostics(result.diagnostics);
		const fingerprint = diagnosticsFingerprint(result.diagnostics);
		if (summary && fingerprint !== lastDiagnostics) {
			notify(ctx, summary, "warning");
		}
		lastDiagnostics = fingerprint;
	}

	function handlePromptInvocation(payload: unknown): void {
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
		const candidate = payload as Record<string, unknown>;
		const requestId = candidate.requestId;
		const name = candidate.name;
		if (typeof requestId !== "string" || typeof name !== "string") return;
		const ctx = invocationCtx;

		if (
			candidate.protocolVersion !== PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION
			|| (candidate.args !== undefined && typeof candidate.args !== "string")
		) {
			emitPromptInvocationAcknowledgement(pi, ctx ?? undefined, {
				protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
				requestId,
				name,
				accepted: false,
				reason: "invalid-request",
			});
			return;
		}

		const request = candidate as unknown as PromptTemplatePromptInvokeRequest;
		if (!ctx) {
			emitPromptInvocationAcknowledgement(pi, ctx ?? undefined, {
				protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
				requestId: request.requestId,
				name: request.name,
				accepted: false,
				reason: "not-ready",
			});
			return;
		}
		if (isPromptActive() || isWorkflowActive() || loopState !== null || pendingCompaction !== null || agentEndDrainDepth > 0 || !ctx.isIdle()) {
			emitPromptInvocationAcknowledgement(pi, ctx ?? undefined, {
				protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
				requestId: request.requestId,
				name: request.name,
				accepted: false,
				reason: "busy",
			});
			return;
		}

		refreshPrompts(ctx.cwd, ctx);
		const prompt = prompts.get(request.name) ?? adaptivePrompts.get(request.name);
		if (!prompt || prompt.hidden) {
			emitPromptInvocationAcknowledgement(pi, ctx ?? undefined, {
				protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
				requestId: request.requestId,
				name: request.name,
				accepted: false,
				reason: "unknown-template",
			});
			return;
		}
		if (prompt.chain || prompt.adaptiveChain) {
			emitPromptInvocationAcknowledgement(pi, ctx ?? undefined, {
				protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
				requestId: request.requestId,
				name: request.name,
				accepted: false,
				reason: "chain-template",
			});
			return;
		}
		if (prompt.boomerang || prompt.loop !== undefined || prompt.inputs || extractLoopCount(request.args ?? "")) {
			emitPromptInvocationAcknowledgement(pi, ctx ?? undefined, {
				protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
				requestId: request.requestId,
				name: request.name,
				accepted: false,
				reason: "unsupported-context",
			});
			return;
		}

		const scope = captureCommandExecutionScope(ctx);
		const runId = randomUUID();
		promptActivityCount++;
		emitPromptInvocationAcknowledgement(pi, ctx, {
			protocolVersion: PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION,
			requestId: request.requestId,
			name: request.name,
			accepted: true,
			runId,
		});
		void runPromptCommand(request.name, request.args ?? "", ctx, {
			runId,
			activeAlready: true,
			resolvedPrompt: prompt,
			scope,
		}).catch(() => {
			// Invocation failures are reported through the lifecycle event.
		});
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

	function shouldDelegatePrompt(prompt: PromptWithModel, override?: SubagentOverride): boolean {
		return prompt.subagent !== undefined || override?.enabled === true;
	}

	function terminalAssistantMessage(messages: readonly Message[]): AssistantMessage | undefined {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message?.role === "assistant") return message as AssistantMessage;
		}
		return undefined;
	}

	function ordinaryTerminalStatus(message: AssistantMessage | undefined): PromptTemplatePromptStatus | undefined {
		switch (message?.stopReason) {
			case undefined:
			case "stop":
			case "length":
			case "toolUse":
				return undefined;
			case "aborted":
				return "cancelled";
			default:
				return "failed";
		}
	}

	function isAbortedStepResult(
		result: PromptStepResult | "aborted",
	): result is "aborted" | (PromptStepResult & { aborted: true }) {
		return result === "aborted" || result.aborted === true;
	}

	function abortedStepStatus(
		result: "aborted" | (PromptStepResult & { aborted: true }),
		ctx: ExtensionContext,
	): PromptTemplatePromptStatus {
		return result === "aborted"
			? (isCommandAborted(ctx) ? "cancelled" : "failed")
			: (result.status ?? (isCommandAborted(ctx) ? "cancelled" : "failed"));
	}

	async function executePromptStep(
		prompt: PromptWithModel,
		args: string[],
		ctx: ExtensionContext,
		currentModel: Model<any> | undefined,
		override?: SubagentOverride,
		inheritedModel?: Model<any>,
		taskPreamble?: string,
		loopContext?: string,
		promptTurnRestore?: PromptTurnRestore,
		adaptiveAbortStatus?: (status: "failed" | "blocked") => void,
		inputsResolved = false,
		): Promise<PromptStepResult | "aborted"> {
		if (prompt.inputs && !inputsResolved) {
			notify(ctx, "Input-enabled prompts cannot run through workflows; invoke them directly", "error");
			adaptiveAbortStatus?.("blocked");
			return "aborted";
		}
		if (!(await ensureProjectPromptLibraryApproved(prompt, ctx))) {
			adaptiveAbortStatus?.("blocked");
			return "aborted";
		}

		const delegatedPrompt = shouldDelegatePrompt(prompt, override);
		const requestedSkills = getRequestedSkills(prompt);
		// Delegated execution resolves and binds skills only after its effective cwd
		// has passed the nested-project approval boundary.
		const skillResolution = delegatedPrompt
			? { kind: "none" as const }
			: resolvePromptSkills(
				requestedSkills,
				ctx.cwd,
				pi.getCommands() as RuntimeSkillCommand[],
				{ includeProjectSkills: projectIsTrusted(ctx) },
			);
		if (skillResolution.kind === "error") {
			notify(ctx, skillResolution.error, "error");
			adaptiveAbortStatus?.("blocked");
			return "aborted";
		}
		let deterministicPreamble: string | undefined;
		if (prompt.deterministic) {
			try {
				const deterministicResult = await runDeterministicStep(prompt, prompt.deterministic, ctx.cwd, getCommandSignal(ctx));
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
					return { changed: false, status: deterministicResult.exitCode === 0 ? "completed" : "failed" };
				}
				deterministicPreamble = deterministicPreambleText;
			} catch (error) {
				notify(ctx, `Deterministic step failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return "aborted";
			}
		}

		const combinedTaskPreamble = [taskPreamble, deterministicPreamble].filter(Boolean).join("\n\n");

		if (delegatedPrompt) {
			try {
				const delegated = await executeSubagentPromptStep({
					pi,
					prompt,
					args,
					ctx,
					currentModel,
					override,
					signal: getCommandSignal(ctx),
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
				if (error instanceof PromptBudgetExceededError) {
					adaptiveAbortStatus?.("blocked");
					return "aborted";
				}
				adaptiveAbortStatus?.("failed");
				return { changed: false, status: isCommandAborted(ctx) || error instanceof DelegatedPromptCancelledError ? "cancelled" : "failed" };
			}
		}

		const prepared =
			inheritedModel === undefined
				? await preparePromptExecution(prompt, args, currentModel, ctx.modelRegistry, { scopedModels: ctx.scopedModels })
				: await preparePromptExecution(prompt, args, currentModel, ctx.modelRegistry, { inheritedModel, scopedModels: ctx.scopedModels });
		if (!prepared) {
			notify(ctx, `No available model from: ${prompt.models.join(", ")}`, "error");
			adaptiveAbortStatus?.("blocked");
			return "aborted";
		}
		if ("message" in prepared) {
			if (prepared.warning) notify(ctx, prepared.warning, "warning");
			notify(ctx, prepared.message, "error");
			adaptiveAbortStatus?.("blocked");
			return "aborted";
		}
		if (prepared.warning) {
			notify(ctx, prepared.warning, "warning");
		}

		const effectiveContent = combinedTaskPreamble
			? `${combinedTaskPreamble}\n\n${prepared.content}`
			: prepared.content;
		const content = loopContext ? `[${loopContext}]\n\n${effectiveContent}` : effectiveContent;
		const budgetCheck = checkPromptExecutionBudget(prompt, content);
		if (budgetCheck.warning) notify(ctx, budgetCheck.warning, "warning");
		if (budgetCheck.message) {
			notify(ctx, budgetCheck.message, "error");
			adaptiveAbortStatus?.("blocked");
			return "aborted";
		}

		if (!prepared.selectedModel.alreadyActive) {
			const switched = await pi.setModel(prepared.selectedModel.model);
			if (!switched) {
				notify(ctx, `Failed to switch to model ${prepared.selectedModel.model.provider}/${prepared.selectedModel.model.id}`, "error");
				adaptiveAbortStatus?.("blocked");
				return "aborted";
			}
			runtimeModel = prepared.selectedModel.model;
		}

		if (prompt.thinking) {
			pi.setThinkingLevel(prompt.thinking);
		}
		const ownedPendingSkillMessage = skillResolution.kind === "ready" ? buildSkillLoadedMessage(skillResolution.skills) : undefined;
		pendingSkillMessage = ownedPendingSkillMessage;
		if (promptTurnRestore) {
			const currentModel = getCurrentModel(ctx);
			if (promptTurnRestore.originalModel && currentModel && !sameModel(promptTurnRestore.originalModel, currentModel)) {
				previousModel = promptTurnRestore.originalModel;
				previousThinking = promptTurnRestore.originalThinking;
			}
			if (prompt.thinking && previousThinking === undefined && prompt.thinking !== promptTurnRestore.originalThinking) {
				previousThinking = promptTurnRestore.originalThinking;
			}
		}

		const startId = ctx.sessionManager.getLeafId();
		if (!(await sendUserMessageAndWait(content, ctx))) {
			return { changed: false, aborted: true, status: "cancelled" };
		}

		const entries = getIterationEntries(ctx, startId);
		const terminal = terminalAssistantMessage(entries.flatMap((entry) => entry.type === "message" && entry.message.role === "assistant" ? [entry.message as AssistantMessage] : []));
		const terminalStatus = ordinaryTerminalStatus(terminal);
		return {
			changed: didIterationMakeChanges(entries),
			terminalAssistantMessage: terminal,
			aborted: wasIterationAborted(entries) || terminalStatus === "cancelled",
			...(terminalStatus ? { status: terminalStatus } : {}),
		};
	}

	async function executeOrdinaryPrompt(
		name: string,
		prompt: PromptWithModel,
		args: string[],
		ctx: ExtensionContext,
		currentModel: Model<any> | undefined,
		override?: SubagentOverride,
		adaptiveAbortStatus?: (status: "failed" | "blocked") => void,
		inheritedModel?: Model<any>,
		inputsResolved = false,
	): Promise<PromptStepResult | "aborted"> {
		const savedThinking = pi.getThinkingLevel();
		const isDelegatedPrompt = shouldDelegatePrompt(prompt, override);
		const promptTurnRestore = !isDelegatedPrompt && prompt.restore
			? { originalModel: currentModel, originalThinking: savedThinking }
			: undefined;
		const boomerangTargetId = prompt.boomerang ? ctx.sessionManager.getLeafId() : null;
		const result = await executePromptStep(prompt, args, ctx, currentModel, override, inheritedModel, undefined, undefined, promptTurnRestore, adaptiveAbortStatus, inputsResolved);
		if (isAbortedStepResult(result)) return result;
		if (isDelegatedPrompt && result.text) {
			const parentStartId = ctx.sessionManager.getLeafId();
			if (!(await sendUserMessageAndWait(`[Delegated result: ${name}]\n\n${result.text}`, ctx))) {
				return { ...result, aborted: true, status: "cancelled" };
			}
			const parentEntries = getIterationEntries(ctx, parentStartId);
			result.terminalAssistantMessage = terminalAssistantMessage(parentEntries.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant" ? [entry.message as AssistantMessage] : []));
			const parentStatus = ordinaryTerminalStatus(result.terminalAssistantMessage);
			result.aborted = wasIterationAborted(parentEntries) || parentStatus === "cancelled";
			if (parentStatus) result.status = parentStatus;
		}
		if (prompt.boomerang) {
			if (!isCommandContext(ctx)) return "aborted";
			await collapseBoomerangPrompt(ctx, name, boomerangTargetId);
		}
		return result;
	}

	async function trackSessionRestoration<T>(operation: () => Promise<T>): Promise<T> {
		const pending = operation();
		activeSessionRestorations.add(pending);
		try {
			return await pending;
		} finally {
			activeSessionRestorations.delete(pending);
		}
	}

	async function restoreSessionState(
		ctx: ExtensionContext,
		originalModel: Model<any> | undefined,
		originalThinking: ThinkingLevel | undefined,
		currentModel?: Model<any>,
		currentThinking?: ThinkingLevel,
		isCurrent: () => boolean = () => true,
	): Promise<boolean> {
		return trackSessionRestoration(async () => {
			if (!isCurrent()) return false;
			const restoredParts: string[] = [];
			const shouldRestoreThinking =
				originalThinking !== undefined && (currentThinking === undefined || currentThinking !== originalThinking);

			if (originalModel && !sameModel(originalModel, currentModel)) {
				const restoredModel = await pi.setModel(originalModel);
				if (!isCurrent()) return false;
				if (restoredModel) {
					runtimeModel = originalModel;
					restoredParts.push(originalModel.id);
				} else {
					notify(ctx, `Failed to restore model ${originalModel.provider}/${originalModel.id}`, "error");
				}
			}
			if (!isCurrent()) return false;
			if (shouldRestoreThinking) {
				restoredParts.push(`thinking:${originalThinking}`);
				pi.setThinkingLevel(originalThinking);
			}
			if (restoredParts.length > 0) {
				notify(ctx, `Restored to ${restoredParts.join(", ")}`, "info");
			}
			return true;
		});
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
		isCurrent: () => boolean,
	): Promise<ExecutionErrorState> {
		if (!shouldRestore) return errorState;

		try {
			await restoreSessionState(ctx, originalModel, originalThinking, currentModel, currentThinking, isCurrent);
		} catch (error) {
			if (!isCurrent()) return errorState;
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

	function clearWorkflowPresentationState(ctx: ExtensionContext): void {
		pendingSkillMessage = undefined;
		loopState = null;
		freshCollapse = null;
		boomerangCollapse = null;
		(globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress = false;
		accumulatedSummaries = [];
		updateLoopStatus(ctx);
		if (ctx.hasUI) ctx.ui.setStatus("prompt-chain", undefined);
	}

	async function executeToolCommand(command: string, ctx: ExtensionCommandContext, source?: "queue") {
		const stripped = command.startsWith("/") ? command.slice(1) : command;
		const spaceIdx = stripped.indexOf(" ");
		const name = spaceIdx >= 0 ? stripped.slice(0, spaceIdx) : stripped;
		const args = spaceIdx >= 0 ? stripped.slice(spaceIdx + 1) : "";
		const queued = source === "queue";

		const execute = async () => {
			if (name === "chain-prompts") {
				await runChainCommand(args, ctx, { skipAgentEndDrain: queued, allowPromptActive: queued });
			} else {
				await runPromptCommand(name, args, ctx, { skipAgentEndDrain: queued, allowPromptActive: queued });
			}
		};

		if (!queued) {
			await execute();
			return;
		}
		const currentScope = commandExecutionScope.getStore() ?? captureCommandExecutionScope(ctx);
		const queuedScope = currentScope.skipAgentEndDrain
			? currentScope
			: { ...currentScope, skipAgentEndDrain: true };
		await commandExecutionScope.run(queuedScope, execute);
	}

	async function collapseBoomerangPrompt(
		ctx: ExtensionCommandContext,
		name: string,
		targetId: string | null,
		previousSummaries: string[] = [],
	) {
		if (!targetId) {
			notify(ctx, `Cannot boomerang prompt \`${name}\`: no session entry to return to.`, "warning");
			return;
		}

		const workflowGeneration = sessionGeneration;
		const collapse = { targetId, task: name, previousSummaries };
		boomerangCollapse = collapse;
		try {
			(globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress = true;
			const result = await ctx.navigateTree(targetId, { summarize: true });
			if (ownsWorkflowSession(workflowGeneration) && boomerangCollapse === collapse && result.cancelled) {
				notify(ctx, `Boomerang cancelled for prompt \`${name}\``, "warning");
			}
		} finally {
			if (boomerangCollapse === collapse) {
				(globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress = false;
				boomerangCollapse = null;
			}
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
	): Promise<PromptTemplatePromptStatus> {
		const workflowGeneration = sessionGeneration;
		refreshPrompts(ctx.cwd, ctx);
		const initialPrompt = prompts.get(name);
		if (!initialPrompt) {
			notify(ctx, `Prompt "${name}" no longer exists`, "error");
			return "failed";
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
		let runStatus: PromptTemplatePromptStatus = "completed";

		try {
			for (let i = 0; i < effectiveMax; i++) {
				loopState.currentIteration = i + 1;
				const iterationLabel = totalIterations !== null ? `${i + 1}/${totalIterations}` : `${i + 1}`;

				refreshPrompts(ctx.cwd, ctx);
				const prompt = prompts.get(name);
				if (!prompt) {
					notify(ctx, `Prompt "${name}" no longer exists`, "error");
					runStatus = "failed";
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
				if (isAbortedStepResult(stepResult)) {
					runStatus = abortedStepStatus(stepResult, ctx);
					loopAborted = true;
					break;
				}
				if (stepResult.status && stepResult.status !== "completed") {
					runStatus = stepResult.status;
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
					const collapse = { targetId: anchorId, task: name, iteration: i + 1, totalIterations };
					freshCollapse = collapse;
					const result = await ctx.navigateTree(anchorId, { summarize: true });
					if (freshCollapse === collapse) freshCollapse = null;
					if (!ownsWorkflowSession(workflowGeneration)) {
						runStatus = "cancelled";
						loopAborted = true;
						break;
					}
					if (result.cancelled) {
						runStatus = "cancelled";
						loopAborted = true;
						notify(ctx, "Loop cancelled", "warning");
						break;
					}
				}
			}
		} catch (error) {
			runStatus = isCommandAborted(ctx) ? "cancelled" : "failed";
			loopErrorState = { hasError: true, error };
		} finally {
			if (ownsWorkflowSession(workflowGeneration)) {
				const isCurrent = () => ownsWorkflowSession(workflowGeneration);
				loopErrorState = await restoreAfterExecution(
					ctx,
					shouldRestore,
					savedModel,
					savedThinking,
					getCurrentModel(ctx),
					pi.getThinkingLevel(),
					loopErrorState,
					"loop",
					isCurrent,
				);

				if (isCurrent()) {
					boomerangPreviousSummaries = accumulatedSummaries;
					clearWorkflowPresentationState(ctx);

					if (!loopErrorState.hasError) {
						notifyLoopCompletion(ctx, completedIterations, totalIterations, effectiveMax, converged, false);
					}
				}
			}
		}
		if (loopErrorState.hasError) throw loopErrorState.error;
		if (!ownsWorkflowSession(workflowGeneration)) return "cancelled";

		if (lastDelegatedText && !loopErrorState.hasError && !loopAborted) {
			const label = converged
				? `Delegated loop converged after ${completedIterations} iteration(s): ${name}`
				: `Delegated loop completed ${completedIterations} iteration(s): ${name}`;
			if (!(await sendUserMessageAndWait(`[${label}]\n\n${lastDelegatedText}`, ctx))) return "cancelled";
		}

		if (!loopErrorState.hasError && !loopAborted && shouldBoomerang) {
			await collapseBoomerangPrompt(ctx, name, anchorId, boomerangPreviousSummaries);
		}

		return runStatus;
	}

	async function runSharedChainExecution(
		steps: ChainStep[],
		sharedArgs: string[],
		totalIterations: number | null,
		fresh: boolean,
		converge: boolean,
		shouldRestore: boolean,
		ctx: ExtensionCommandContext,
		subagentOverride?: SubagentOverride,
		cwdOverride?: string,
		chainContextEnabled = false,
		owner?: symbol,
	): Promise<PromptTemplatePromptStatus> {
		const workflowGeneration = sessionGeneration;
		if (owner !== undefined && workflowOwner !== owner) throw new Error("Prompt workflow ownership was lost before chain execution");
		const validateChainSteps = (): boolean => {
			const missingTemplates = steps.filter((step) => !chainPrompts.has(step.name));
			if (missingTemplates.length > 0) {
				notify(ctx, `Templates not found: ${missingTemplates.map((step) => step.name).join(", ")}`, "error");
				return false;
			}
			for (const step of steps) {
				if (chainPrompts.get(step.name)?.inputs) {
					notify(ctx, `Step "${step.name}" declares inputs and cannot run through a legacy chain.`, "error");
					return false;
				}
			}

			for (const step of steps) {
				const stepPrompt = chainPrompts.get(step.name);
				if (!stepPrompt) continue;
				if (stepPrompt.chain) {
					notify(ctx, `Step "${step.name}" is a chain template. Chain nesting is not supported.`, "error");
					return false;
				}
			}

			return true;
		};

		const resolveChainStepPrompts = (): PromptWithModel[] => steps
			.map((step) => chainPrompts.get(step.name))
			.filter((prompt): prompt is PromptWithModel => prompt !== undefined);

		if (!validateChainSteps()) return "failed";
		if (!(await ensureProjectPromptLibraryStepsApproved(resolveChainStepPrompts(), ctx))) return "failed";

		const originalModel = getCurrentModel(ctx);
		const chainInheritedModel = originalModel;
		const originalThinking = pi.getThinkingLevel();
		let currentModel = originalModel;
		let currentThinking = originalThinking;
		pendingSkillMessage = undefined;
		const effectiveMax = totalIterations ?? UNLIMITED_LOOP_CAP;
		const isUnlimited = totalIterations === null;
		const useConverge = converge;

		const anchorId = fresh ? ctx.sessionManager.getLeafId() : null;
		const chainStepNames = steps.map((step) => step.name).join(" -> ");
		let completedIterations = 0;
		let converged = false;
		let chainErrorState: ExecutionErrorState = { hasError: false, error: undefined };
		let lastDelegatedText: string | undefined;
		let chainAborted = false;
		let chainStatus: PromptTemplatePromptStatus = "completed";
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

				const templates = steps.map((step) => ({
					singleStep: {
						prompt: {
							...chainPrompts.get(step.name)!,
							...(cwdOverride ? { cwd: cwdOverride } : {}),
						},
						stepArgs: step.args,
						stepLoop: step.loopCount !== undefined ? step.loopCount : 1,
						stepWithContext: step.withContext === true,
					},
				}));

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
							if (isAbortedStepResult(stepResult)) {
								chainStatus = abortedStepStatus(stepResult, ctx);
								chainAborted = true;
								aborted = true;
								break;
							}
							if (stepResult.status && stepResult.status !== "completed") {
								chainStatus = stepResult.status;
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
						if (isStepLooping && ownsWorkflowSession(workflowGeneration, owner)) {
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
					const collapse = { targetId: anchorId, task: chainStepNames, iteration: iteration + 1, totalIterations };
					freshCollapse = collapse;
					const result = await ctx.navigateTree(anchorId, { summarize: true });
					if (freshCollapse === collapse) freshCollapse = null;
					if (!ownsWorkflowSession(workflowGeneration, owner)) {
						chainStatus = "cancelled";
						chainAborted = true;
						break;
					}
					if (result.cancelled) {
						chainStatus = "cancelled";
						chainAborted = true;
						notify(ctx, "Loop cancelled", "warning");
						break;
					}
				}
			}

		} catch (error) {
			chainErrorState = { hasError: true, error };
		} finally {
			if (ownsWorkflowSession(workflowGeneration, owner)) {
				const isCurrent = () => ownsWorkflowSession(workflowGeneration, owner);
				chainErrorState = await restoreAfterExecution(
					ctx,
					shouldRestore,
					originalModel,
					originalThinking,
					getCurrentModel(ctx),
					pi.getThinkingLevel(),
					chainErrorState,
					"chain",
					isCurrent,
				);

				if (isCurrent()) {
					clearWorkflowPresentationState(ctx);

					if (!chainErrorState.hasError) {
						notifyLoopCompletion(ctx, completedIterations, totalIterations, effectiveMax, converged, true);
					}
				}
			}
		}
		if (chainErrorState.hasError) throw chainErrorState.error;
		if (!ownsWorkflowSession(workflowGeneration, owner)) return "cancelled";

		if (lastDelegatedText && !chainErrorState.hasError && !chainAborted) {
			if (!(await sendUserMessageAndWait(`[Delegated chain complete: ${chainStepNames}]\n\n${lastDelegatedText}`, ctx))) return "cancelled";
		}

		return chainAborted ? (chainStatus === "completed" ? (isCommandAborted(ctx) ? "cancelled" : "failed") : chainStatus) : "completed";
	}

	function isTuiMode(ctx: ExtensionCommandContext): boolean {
		return (ctx as ExtensionCommandContext & { mode?: string }).mode === "tui";
	}

	function hasCustomUi(ctx: ExtensionCommandContext): boolean {
		return typeof (ctx as ExtensionCommandContext & { ui?: { custom?: unknown } }).ui?.custom === "function";
	}

	function getDryRunUnsupportedReason(prompt: PromptWithModel): string | undefined {
		if (prompt.chain && !prompt.adaptiveChain) return DRY_RUN_CHAIN_UNSUPPORTED;
		if (prompt.deterministic) return DRY_RUN_DETERMINISTIC_UNSUPPORTED;
		return undefined;
	}

	function buildPromptDryRunCatalog(): PromptTemplateCatalogItem[] {
		const merged = new Map<string, PromptWithModel>();
		for (const [name, prompt] of chainPrompts) merged.set(name, prompt);
		for (const [name, prompt] of prompts) merged.set(name, prompt);
		const catalog: PromptTemplateCatalogItem[] = Array.from(merged.values())
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
		for (const blocked of blockedAdaptivePrompts.values()) if (!blocked.hidden) catalog.push({ name: blocked.name, source: blocked.source, displaySource: blocked.rootKind === "prompt-library" ? `${blocked.source} library` : blocked.source, file: blocked.filePath, description: "Blocked adaptive chain (parser-invalid)", unsupportedReason: "graph unavailable/invalid" });
		return catalog.sort((a, b) => a.name.localeCompare(b.name));
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
		const blocked = blockedAdaptivePrompts.get(promptName);
		if (!prompt) {
			if (blocked) {
				const result: PromptDryRunResult = { status: "error", promptName, error: "Graph unavailable/invalid; adaptive chain is blocked.", warnings: [], adaptivePreflight: createInvalidAdaptivePreflight(promptName, blocked.diagnostics) };
				await openPromptDryRunInspector(ctx, result, formatPromptDryRun(result));
				return;
			}
			notify(ctx, `Prompt "${promptName}" not found`, "error");
			return;
		}

		const result = await createPromptDryRun(prompt, {
			cwd: ctx.cwd,
			rawArgs,
			currentModel: getCurrentModel(ctx),
			currentModelLabel: getCurrentModelLabel(ctx),
			modelRegistry: ctx.modelRegistry,
			scopedModels: ctx.scopedModels,
			projectTrusted: projectIsTrusted(ctx),
			commands: pi.getCommands() as RuntimeSkillCommand[],
			showSkills,
			promptCatalog: chainPrompts,
		});
		const plainReport = formatPromptDryRun(result);

		if (result.status === "error" && !result.adaptivePreflight) {
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
			const blocked = blockedAdaptivePrompts.get(parsed.promptName);
			if (blocked) {
				const result: PromptDryRunResult = { status: "error", promptName: parsed.promptName, error: "Graph unavailable/invalid; adaptive chain is blocked.", warnings: [], adaptivePreflight: createInvalidAdaptivePreflight(parsed.promptName, blocked.diagnostics) };
				const report = formatPromptDryRun(result);
				if (useTui) await openPromptDryRunInspector(ctx, result, report); else if (parsed.plain || !ctx.hasUI) process.stdout.write(report); else notify(ctx, report, "error");
				return;
			}
			notify(ctx, `Prompt "${parsed.promptName}" not found`, "error");
			return;
		}

		const result = await createPromptDryRun(prompt, {
			cwd: ctx.cwd,
			rawArgs: parsed.remainingArgs,
			currentModel: getCurrentModel(ctx),
			currentModelLabel: getCurrentModelLabel(ctx),
			modelRegistry: ctx.modelRegistry,
			scopedModels: ctx.scopedModels,
			projectTrusted: projectIsTrusted(ctx),
			commands: pi.getCommands() as RuntimeSkillCommand[],
			showSkills: parsed.showSkills,
			promptCatalog: chainPrompts,
		});
		const plainReport = formatPromptDryRun(result);

		if (result.status === "error") {
			for (const warning of result.warnings) notify(ctx, warning, "warning");
			if (parsed.plain || !ctx.hasUI) {
				process.stdout.write(plainReport);
				return;
			}
			if (result.adaptivePreflight && useTui) {
				const action = parsePromptDryRunInspectorAction(await openPromptDryRunInspector(ctx, result, plainReport));
				if (action?.action === "back") {
					const selection = await openPromptDryRunPicker(ctx, result.promptName);
					if (selection?.action === "selected") await inspectPromptDryRunInTui(ctx, selection.templateName, parsed.remainingArgs, parsed.showSkills);
				}
				return;
			}
			notify(ctx, plainReport, "error");
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

	async function runAdaptivePromptCommand(name: string, args: string, ctx: ExtensionCommandContext) {
		const scope = commandExecutionScope.getStore() ?? captureCommandExecutionScope(ctx);
		return commandExecutionScope.run(scope, async () => {
		if (!(await waitForCommandLifecycleBoundary(ctx))) return;
		const owner = claimWorkflowOwner(`adaptive:${name}`);
		if (!owner) {
			notify(ctx, `Adaptive chain ${name} cannot start while another prompt workflow is active.`, "error");
			return;
		}
		let wrapper: PromptWithModel | undefined;
		let savedModel: Model<any> | undefined;
		let savedThinking: ThinkingLevel | undefined;
		let executionStarted = false;
		const pendingSkillMessageAtStart = pendingSkillMessage;
		const runId = randomUUID();
		const startId = ctx.sessionManager.getLeafId();
		let status: PromptTemplatePromptStatus = "failed";
		emitPromptLifecycleEvent(pi, ctx, PROMPT_TEMPLATE_PROMPT_STARTED_EVENT, {
			protocolVersion: PROMPT_TEMPLATE_PROMPT_PROTOCOL_VERSION,
			runId,
			name,
		});
		try {
			if (!(await waitForCommandLifecycleBoundary(ctx))) {
				status = "cancelled";
				return;
			}
			refreshPrompts(ctx.cwd, ctx);
			wrapper = adaptivePrompts.get(name);
			if (!wrapper?.adaptiveChain || wrapper.hidden) {
				notify(ctx, `Adaptive chain "${name}" is no longer available`, "error");
				return;
			}

			const runtime = extractSubagentOverride(args);
			const runtimeCwd = runtime.cwd ? expandCwdPath(runtime.cwd) : undefined;
			if (runtime.cwd && !runtimeCwd) {
				notify(ctx, "Invalid --cwd path: must be absolute", "error");
				return;
			}

			const runtimeLoop = extractLoopCount(runtime.args);
			const unsupportedRuntime = runtime.override || runtime.fork || runtimeLoop;
			if (unsupportedRuntime) {
				notify(ctx, "Adaptive chains do not support --subagent, --fork, or --loop: these modes can expand one router action into multiple top-level model calls, and exact call reservation is not implemented.", "error");
				return;
			}

			const preflightResult = await createPromptDryRun(wrapper, {
				cwd: ctx.cwd,
				rawArgs: args,
				currentModel: getCurrentModel(ctx),
				currentModelLabel: getCurrentModelLabel(ctx),
				modelRegistry: ctx.modelRegistry,
				scopedModels: ctx.scopedModels,
				projectTrusted: projectIsTrusted(ctx),
				commands: pi.getCommands() as RuntimeSkillCommand[],
				promptCatalog: chainPrompts,
			});
			if (preflightResult.status === "error") {
				const report = formatPromptDryRun(preflightResult);
				if (isTuiMode(ctx) && hasCustomUi(ctx) && preflightResult.adaptivePreflight) await openPromptDryRunInspector(ctx, preflightResult, report);
				else notify(ctx, report, "error");
				return;
			}

			for (const step of wrapper.adaptiveChain.steps) {
				const target = chainPrompts.get(step.target);
				if (!target || target.chain || target.adaptiveChain) {
					notify(ctx, `Adaptive chain target ${JSON.stringify(step.target)} is missing or uses an unsupported nested/parallel chain.`, "error");
					return;
				}
				if (step.kind === "prompt") {
					if (!isAdaptivePromptTarget(target)) {
						notify(ctx, `Adaptive prompt target ${JSON.stringify(step.target)} uses a delegated, loop, boomerang, or deterministic mode. Multi-call modes are unsupported until the router can reserve their exact top-level model calls.`, "error");
						return;
					}
				} else if (!target.deterministic) {
					notify(ctx, `Adaptive run target ${JSON.stringify(step.target)} is not deterministic.`, "error");
					return;
				} else if (!isAdaptiveRunTarget(target)) {
					notify(ctx, `Adaptive run target ${JSON.stringify(step.target)} requests a delegated handoff. Multi-call modes are unsupported until the router can reserve exact top-level model calls.`, "error");
					return;
				}
			}

			const adaptiveSteps = wrapper.adaptiveChain.steps;
			const changedGateAnalysis = collectChangedGatePredecessors(adaptiveSteps, wrapper.adaptiveChain.limits);
			if (!changedGateAnalysis.complete) {
				notify(ctx, `Adaptive chain ${name} cannot start: changed-gate predecessor analysis exceeded its bounded 4096-state cap or was inconclusive.`, "error");
				return;
			}

			if (!(await ensureProjectPromptLibraryApproved(wrapper, ctx))) return;
			storedCommandCtx = ctx;
			const stepArgs = parseCommandArgs(runtime.args);
			savedModel = getCurrentModel(ctx);
			savedThinking = pi.getThinkingLevel();
			executionStarted = true;
			const fallbackCwd = wrapper.cwd ?? ctx.cwd;
			const changedEvidenceSuppliers = new Set([...changedGateAnalysis.predecessors.values()].flatMap((ids) => [...ids]));
			const freshAdaptiveTarget = (target: string) => loadPromptsWithModel(ctx.cwd, true, { includeAdaptiveChains: true, projectTrusted: projectIsTrusted(ctx) }).prompts.get(target);
			const report = await executeAdaptiveChain(wrapper.adaptiveChain, {
				signal: getCommandSignal(ctx),
				resolvePrompt(target) {
					const prompt = freshAdaptiveTarget(target);
					return prompt && isAdaptivePromptTarget(prompt) ? prompt : undefined;
				},
				resolveRun(target) {
					const prompt = freshAdaptiveTarget(target);
					return isAdaptiveRunTarget(prompt) ? prompt : undefined;
				},
				resolveSnapshotCwd(step, prompt) {
					// Ordinary in-session prompts execute in the session cwd; prompt cwd is
					// execution-shaping only for delegated paths (which adaptive rejects).
					return resolvePath(step.kind === "run" ? runtimeCwd ?? prompt.deterministic?.cwd ?? fallbackCwd : ctx.cwd);
				},
				shouldCaptureSnapshot(step) {
					return changedEvidenceSuppliers.has(step.id);
				},
				async executePrompt(prompt) {
					const effective = { ...prompt, ...(runtimeCwd ? { cwd: runtimeCwd } : {}), ...(runtime.model ? { models: [runtime.model] } : {}) };
					let abortStatus: "failed" | "blocked" = "failed";
					const result = await executeOrdinaryPrompt(prompt.name, effective, stepArgs, ctx, getCurrentModel(ctx), undefined, (status) => { abortStatus = status; }, savedModel);
					if (isAbortedStepResult(result)) return { status: abortStatus, error: new Error(`Adaptive prompt step ${prompt.name} did not complete`) };
					if (!result.terminalAssistantMessage) {
						const error = new Error(`Adaptive prompt step ${prompt.name} produced no terminal assistant message`);
						notify(ctx, error.message, "error");
						return { status: "failed", error };
					}
					try { return normalizePromptCompletionOutcome(result.terminalAssistantMessage); }
					catch (error) { notify(ctx, error instanceof Error ? error.message : String(error), "error"); return { status: "failed", error }; }
				},
				async executeRun(prompt) {
					if (!(await ensureProjectPromptLibraryApproved(prompt, ctx))) return { status: "blocked", error: new Error(`Adaptive run step ${prompt.name} was not approved`) };
					const deterministic = { ...prompt.deterministic!, cwd: runtimeCwd ?? prompt.deterministic!.cwd ?? fallbackCwd };
					const result = await runDeterministicStep(prompt, deterministic, ctx.cwd, getCommandSignal(ctx));
					// Publish the same bounded result card as ordinary deterministic execution
					// before the router can dispatch an onSuccess/onFailure prompt.
					pi.sendMessage({
						customType: PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE,
						content: buildDeterministicPreamble(result),
						display: true,
						details: result,
					});
					return normalizeDeterministicExecutionOutcome(result);
				},
				captureSnapshot(_step, cwd) { return captureGitWorktreeSnapshot(cwd); },
				compareSnapshots: compareGitWorktreeSnapshots,
				onDecision(decision) {
					notify(ctx, `Adaptive chain ${name}: ${formatAdaptiveDecision(decision)}`, "info");
				},
			});
			notify(ctx, formatAdaptiveRuntimeReport(name, report), "info");
			status = "completed";
		} catch (error) {
			if (error instanceof AdaptiveChainCancelledError) {
				status = "cancelled";
				notify(ctx, formatAdaptiveRuntimeReport(name, error.report, "cancelled"), "warning");
			} else {
				status = isCommandAborted(ctx) ? "cancelled" : "failed";
				notify(ctx, formatAdaptiveError(name, error), "error");
			}
		} finally {
			if (workflowOwner === owner) {
				try {
					// agent_end is suppressed while adaptive owns the workflow, so per-target
					// restore markers must not leak into the next unrelated turn.
					previousModel = undefined;
					previousThinking = undefined;
					if (pendingSkillMessage !== pendingSkillMessageAtStart) pendingSkillMessage = pendingSkillMessageAtStart;
					if (executionStarted && wrapper?.restore) await restoreSessionState(ctx, savedModel, savedThinking, getCurrentModel(ctx), pi.getThinkingLevel());
				} finally {
					releaseWorkflowOwner(owner);
				}
			}
			const entries = getIterationEntries(ctx, startId);
			const lastText = getLastAssistantText(entries);
			emitPromptLifecycleEvent(pi, ctx, PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT, {
				protocolVersion: PROMPT_TEMPLATE_PROMPT_PROTOCOL_VERSION,
				runId,
				name,
				status: isCommandAborted(ctx) && status === "completed" ? "cancelled" : status,
				changed: didIterationMakeChanges(entries),
				...(lastText ? { lastText } : {}),
			});
		}
		});
	}

	async function executePromptCommand(
		name: string,
		args: string,
		ctx: ExtensionContext,
		resolvedPrompt?: PromptWithModel,
	): Promise<PromptTemplatePromptStatus> {
		if (isCommandContext(ctx)) storedCommandCtx = ctx;
		const prompt = resolvedPrompt ?? prompts.get(name);
		if (!prompt || prompt.hidden) {
			notify(ctx, `Prompt "${name}" is no longer available as a slash command`, "error");
			return "failed";
		}
		const boundary = prompt.inputs ? splitRawArgsAtBoundary(args) : { before: args, after: [] };
		const removedFlag = findRemovedLegacyRuntimeFlag(args);
		if (removedFlag) {
			notify(ctx, `Removed legacy runtime flag \`${removedFlag}\` is not supported. Use structured single/fork delegation or a sequential/adaptive workflow. Quote the flag when it is prompt content.`, "error");
			return "failed";
		}
		const subagent = extractSubagentOverride(boundary.before);
		const runtimeCwd = subagent.cwd ? expandCwdPath(subagent.cwd) : undefined;
		if (subagent.cwd && !runtimeCwd) {
			notify(ctx, `Invalid --cwd path: must be absolute`, "error");
			return "failed";
		}
		const inputModeError = inputModeEligibilityError({ ...prompt, subagent: subagent.override || subagent.fork || prompt.subagent });
		if (inputModeError) {
			notify(ctx, inputModeError, "error");
			return "failed";
		}
		const argsWithoutSubagent = subagent.args;
		if (prompt.inputs && extractLoopCount(argsWithoutSubagent)) {
			notify(ctx, "Prompt inputs are only supported on ordinary prompts without loops, chains, delegation, compare, or deterministic execution", "error");
			return "failed";
		}
		if (prompt.deterministic) {
			if (subagent.override || subagent.fork) {
				notify(ctx, `Deterministic prompts do not support runtime --subagent/--fork in v1`, "error");
				return "failed";
			}
			if (extractLoopCount(argsWithoutSubagent)) {
				notify(ctx, `Deterministic prompts do not support runtime --loop in v1`, "error");
				return "failed";
			}
		}

		if (prompt.chain) {
			if (!isCommandContext(ctx)) return "failed";
			const owner = claimWorkflowOwner(`legacy:${name}`, true);
			if (!owner) {
				notify(ctx, `Legacy chain ${name} cannot start while another prompt workflow is active.`, "error");
				return "failed";
			}
			try {
				if (!(await ensureProjectPromptLibraryApproved(prompt, ctx))) return "failed";
				if (subagent.model) notify(ctx, `--model is not supported on chain prompts (ignored)`, "warning");
				if (subagent.fork) notify(ctx, `--fork is not supported on chain prompts (ignored)`, "warning");
				const extracted = extractChainContextFlag(argsWithoutSubagent);
				const chainContextEnabled = extracted.chainContext || prompt.chainContext === "summary";
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
					return "failed";
				}
				if (steps.length === 0) {
					notify(ctx, "No templates specified", "error");
					return "failed";
				}

				const cwdOverride = runtimeCwd ?? prompt.cwd;
				return await runSharedChainExecution(
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
					owner,
				);
			} finally {
				releaseWorkflowOwner(owner);
			}
		}

		if (!isCommandContext(ctx) && (prompt.inputs || prompt.loop !== undefined || extractLoopCount(argsWithoutSubagent))) {
			return "failed";
		}
		const parsedPromptArgs = [...parseCommandArgs(argsWithoutSubagent), ...(boundary.after.length ? ["--", ...boundary.after] : [])];
		let resolvedInputs = prompt.inputs ? resolvePromptInputs(prompt.inputs, parsedPromptArgs) : undefined;
		const repairableInputErrors = resolvedInputs?.errors.every((error) => error.startsWith("missing required input") || error.startsWith("missing value for input") || error.startsWith("invalid value for input") || error.includes("must be true or false"));
		if (resolvedInputs?.errors.length && repairableInputErrors && prompt.inputs && ctx.mode === "tui" && ctx.hasUI && typeof (ctx.ui as { custom?: unknown }).custom === "function") {
			const repairNames = new Set(resolvedInputs.errors.map((error) => error.match(/input ["']?([a-z][a-z0-9-]*)/)?.[1]).filter((inputName): inputName is string => Boolean(inputName)));
			const repairSchema = Object.fromEntries(Object.entries(prompt.inputs).filter(([inputName]) => repairNames.has(inputName)));
			const initialValues = Object.fromEntries(Object.entries(resolvedInputs.values).filter(([inputName]) => repairNames.has(inputName)).map(([inputName, input]) => [inputName, input.value]));
			const formResult = await ctx.ui.custom((tui, theme, _layout, done) => new PromptInputForm(repairSchema, initialValues, done));
			if (formResult && typeof formResult === "object" && (formResult as { action?: string }).action === "submitted") {
				const values = (formResult as { values: Record<string, string | boolean> }).values;
				const flags = Object.entries(values).map(([inputName, value]) => typeof value === "boolean" ? (value ? `--${inputName}` : `--no-${inputName}`) : `--${inputName}=${value}`);
				const repaired = resolvePromptInputs(repairSchema, flags);
				if (repaired.errors.length) resolvedInputs = { ...resolvedInputs, errors: repaired.errors };
				else resolvedInputs = { values: { ...resolvedInputs.values, ...repaired.values }, positional: resolvedInputs.positional, errors: [] };
			} else if (formResult && typeof formResult === "object" && (formResult as { action?: string }).action === "cancelled") {
				return "cancelled";
			} else return "failed";
		}
		if (resolvedInputs?.errors.length) {
			notify(ctx, `Invalid prompt inputs: ${resolvedInputs.errors[0]}`, "error");
			return "failed";
		}
		if (!(await ensureProjectPromptLibraryApproved(prompt, ctx))) return "failed";
		const promptOverrides: Partial<Pick<PromptWithModel, "models" | "inheritContext">> = {
			...(subagent.model ? { models: [subagent.model] } : {}),
			...(subagent.fork ? { inheritContext: true } : {}),
		};

		const loop = extractLoopCount(argsWithoutSubagent);
		if (loop) {
			return await runPromptLoop(name, loop.args, loop.loopCount, loop.fresh, loop.converge, ctx as ExtensionCommandContext, subagent.override, runtimeCwd, promptOverrides);
		}

		if (prompt.loop !== undefined) {
			const flags = extractLoopFlags(argsWithoutSubagent);
			return await runPromptLoop(name, flags.args, prompt.loop, flags.fresh, flags.converge, ctx as ExtensionCommandContext, subagent.override, runtimeCwd, promptOverrides);
		}

		const effectivePrompt = {
			...prompt,
			...(resolvedInputs ? { resolvedInputValues: Object.fromEntries(Object.entries(resolvedInputs.values).map(([key, input]) => [key, input.value])) } : {}),
			...(runtimeCwd ? {
				cwd: runtimeCwd,
				...(prompt.deterministic ? { deterministic: { ...prompt.deterministic, cwd: runtimeCwd } } : {}),
			} : {}),
			...promptOverrides,
		};
		const savedModel = getCurrentModel(ctx);
		const result = await executeOrdinaryPrompt(
			name,
			effectivePrompt,
			resolvedInputs?.positional ?? parsedPromptArgs,
			ctx,
			savedModel,
			subagent.override,
			undefined,
			undefined,
			true,
		);
		if (isAbortedStepResult(result)) return abortedStepStatus(result, ctx);
		return result.status ?? (result.aborted || isCommandAborted(ctx) ? "cancelled" : "completed");
	}

	async function runPromptCommand(
		name: string,
		args: string,
		ctx: ExtensionContext,
		options: {
			runId?: string;
			activeAlready?: boolean;
			resolvedPrompt?: PromptWithModel;
			skipAgentEndDrain?: boolean;
			allowPromptActive?: boolean;
			scope?: CommandExecutionScope;
		} = {},
	): Promise<void> {
		const scope = options.scope ?? commandExecutionScope.getStore() ?? captureCommandExecutionScope(ctx);
		return commandExecutionScope.run(scope, async () => {
		let activityOwned = options.activeAlready === true;
		let activityGeneration = activityOwned ? scope.generation : undefined;
		let prompt = options.resolvedPrompt;
		const runId = options.runId ?? randomUUID();
		let lifecycleStarted = false;
		let startId: string | null = null;
		let status: PromptTemplatePromptStatus = "completed";
		try {
			if (options.activeAlready && prompt) {
				startId = ctx.sessionManager.getLeafId();
				emitPromptLifecycleEvent(pi, ctx, PROMPT_TEMPLATE_PROMPT_STARTED_EVENT, {
					protocolVersion: PROMPT_TEMPLATE_PROMPT_PROTOCOL_VERSION,
					runId,
					name,
				});
				lifecycleStarted = true;
			}

			if (!(await waitForCommandLifecycleBoundary(ctx, { skipAgentEndDrain: options.skipAgentEndDrain }))) {
				status = "cancelled";
				return;
			}

			if (!options.activeAlready) {
				if (isWorkflowActive() || (isPromptActive() && !options.allowPromptActive)) {
					notify(ctx, `Prompt ${name} cannot start while another prompt workflow is active.`, "error");
					return;
				}
				refreshPrompts(ctx.cwd, ctx);
				prompt = options.resolvedPrompt ?? prompts.get(name);
				if (!prompt || prompt.hidden) {
					notify(ctx, `Prompt "${name}" is no longer available as a slash command`, "error");
					return;
				}
				promptActivityCount++;
				activityOwned = true;
				activityGeneration = sessionGeneration;
				startId = ctx.sessionManager.getLeafId();
				emitPromptLifecycleEvent(pi, ctx, PROMPT_TEMPLATE_PROMPT_STARTED_EVENT, {
					protocolVersion: PROMPT_TEMPLATE_PROMPT_PROTOCOL_VERSION,
					runId,
					name,
				});
				lifecycleStarted = true;
			}

			if (!(await waitForCommandLifecycleBoundary(ctx, { skipAgentEndDrain: options.skipAgentEndDrain }))) {
				status = "cancelled";
				return;
			}

			if (!prompt) return;
			status = await executePromptCommand(name, args, ctx, prompt);
		} catch (error) {
			status = isCommandAborted(ctx) ? "cancelled" : "failed";
			throw error;
		} finally {
			if (activityOwned && activityGeneration === sessionGeneration) {
				promptActivityCount = Math.max(0, promptActivityCount - 1);
			}
			activityOwned = false;
			if (lifecycleStarted) {
				const entries = getIterationEntries(ctx, startId);
				const lastText = getLastAssistantText(entries);
				emitPromptLifecycleEvent(pi, ctx, PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT, {
					protocolVersion: PROMPT_TEMPLATE_PROMPT_PROTOCOL_VERSION,
					runId,
					name,
					status: isCommandAborted(ctx) && status === "completed" ? "cancelled" : status,
					changed: didIterationMakeChanges(entries),
					...(lastText ? { lastText } : {}),
				});
			}
		}
		});
	}

	async function resetSessionScopedState(ctx: ExtensionContext) {
		const replacementModel = ctx.model;
		const replacementThinking = pi.getThinkingLevel();
		sessionAbortController.abort(new Error("Prompt workflow session was replaced"));
		sessionAbortController = new AbortController();
		const replacementGeneration = ++sessionGeneration;
		sessionActive = true;
		invocationCtx = ctx;
		finishCompactionGeneration(activeCompactionGeneration, "reset");
		completeCompactionBarrier();
		queuedAgentSettledDrainPending = false;
		queuedAgentSettledDrainGenerationBaseline = null;
		pendingPromptTurn?.resolveStarted();
		pendingPromptTurn?.resolveSettled();
		pendingPromptTurn = null;
		clearAgentEndDrain();
		storedCommandCtx = null;
		promptActivityCount = 0;
		workflowOwner = null;
		approvedProjectPromptLibraryCwds.clear();
		clearWorkflowPresentationState(ctx);
		previousModel = undefined;
		previousThinking = undefined;
		runtimeModel = replacementModel;
		toolManager.clearQueue();
		refreshPrompts(ctx.cwd, ctx);

		const staleRestorations = [...activeSessionRestorations];
		if (staleRestorations.length === 0) return;
		await Promise.allSettled(staleRestorations);
		if (!ownsWorkflowSession(replacementGeneration)) return;

		if (replacementModel && !sameModel(replacementModel, ctx.model)) {
			const repaired = await trackSessionRestoration(() => pi.setModel(replacementModel));
			if (!ownsWorkflowSession(replacementGeneration)) return;
			if (!repaired) {
				notify(ctx, `Failed to preserve replacement session model ${replacementModel.provider}/${replacementModel.id}`, "error");
				return;
			}
			runtimeModel = replacementModel;
		}
		if (!ownsWorkflowSession(replacementGeneration)) return;
		if (pi.getThinkingLevel() !== replacementThinking) pi.setThinkingLevel(replacementThinking);
	}

	getExtensionEvents(pi)?.on(PROMPT_TEMPLATE_PROMPT_INVOKE_REQUEST_EVENT, (payload) => {
		handlePromptInvocation(payload);
	});

	pi.on("session_start", async (_event, ctx) => {
		await resetSessionScopedState(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!beginCompactionBarrier(event.signal, ctx)) return { cancel: true };
	});

	pi.on("session_compact", async () => {
		handleCompactionTerminal();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const shutdownModel = ctx.model;
		const shutdownThinking = pi.getThinkingLevel();
		sessionAbortController.abort(new Error("Prompt workflow session shut down"));
		const shutdownGeneration = ++sessionGeneration;
		sessionActive = false;
		invocationCtx = null;
		finishCompactionGeneration(activeCompactionGeneration, "reset");
		completeCompactionBarrier();
		queuedAgentSettledDrainPending = false;
		queuedAgentSettledDrainGenerationBaseline = null;
		pendingPromptTurn?.resolveStarted();
		pendingPromptTurn?.resolveSettled();
		pendingPromptTurn = null;
		clearAgentEndDrain();
		storedCommandCtx = null;
		toolManager.clearQueue();
		promptActivityCount = 0;
		workflowOwner = null;
		clearWorkflowPresentationState(ctx);
		const staleRestorations = [...activeSessionRestorations];
		if (staleRestorations.length === 0) return;
		await Promise.allSettled(staleRestorations);
		if (sessionGeneration !== shutdownGeneration || sessionActive) return;
		if (shutdownModel && !sameModel(shutdownModel, ctx.model)) {
			const repaired = await trackSessionRestoration(() => pi.setModel(shutdownModel));
			if (sessionGeneration !== shutdownGeneration || sessionActive) return;
			if (!repaired) return;
		}
		if (sessionGeneration !== shutdownGeneration || sessionActive) return;
		if (pi.getThinkingLevel() !== shutdownThinking) pi.setThinkingLevel(shutdownThinking);
	});

	pi.on("model_select", async (event) => {
		runtimeModel = event.model;
	});

	pi.on("before_agent_start", async (event) => {
		const pending = pendingPromptTurn;
		if (pending && pending.generation === sessionGeneration && event.prompt === pending.content) {
			pending.started = true;
			pending.resolveStarted();
		}
		finishCompactionGeneration(activeCompactionGeneration, "turn_start");
		// Pi cannot start a turn until any prior compaction attempt has returned,
		// so an accepted prompt is a safe resynchronization point after a fallback.
		compactionTerminalCorrelationLost = false;
		let systemPrompt = event.systemPrompt;

		if (toolManager.isEnabled() && !loopState && !isWorkflowActive()) {
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
		enterAgentEndDrain();
		let retainedForSettledQueue = false;
		try {
			await waitForPendingCompaction();
			if (isWorkflowActive() || loopState) return;
			await waitForPendingCompaction();
			if (isWorkflowActive() || loopState) return;

			if (toolManager.hasQueuedCommand()) {
				if (!queuedAgentSettledDrainPending) {
					queuedAgentSettledDrainPending = true;
					queuedAgentSettledDrainGenerationBaseline = nextCompactionGeneration;
					retainedForSettledQueue = true;
				}
				return;
			}

			const restoreModel = previousModel;
			const restoreThinking = previousThinking;
			if (!restoreModel && restoreThinking === undefined) return;

			runtimeModel = ctx.model;
			previousModel = undefined;
			previousThinking = undefined;
			await restoreSessionState(ctx, restoreModel, restoreThinking, getCurrentModel(ctx), pi.getThinkingLevel());
		} finally {
			if (!retainedForSettledQueue) leaveAgentEndDrain();
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const pendingTurn = pendingPromptTurn;
		if (pendingTurn?.started && pendingTurn.generation === sessionGeneration) {
			pendingTurn.settled = true;
			pendingTurn.resolveSettled();
		}
		if (!queuedAgentSettledDrainPending) return;
		const compactionGenerationBaseline = queuedAgentSettledDrainGenerationBaseline ?? nextCompactionGeneration;
		queuedAgentSettledDrainPending = false;
		queuedAgentSettledDrainGenerationBaseline = null;
		try {
			await waitForPendingCompaction();
			const postTurnCompactionFellBack = [...compactionReleaseReasons.entries()].some(
				([generation, reason]) => generation > compactionGenerationBaseline && reason === "fallback",
			);

			const restoreModel = previousModel;
			const restoreThinking = previousThinking;
			runtimeModel = ctx.model;
			previousModel = undefined;
			previousThinking = undefined;

			const restoreFn = async () => {
				if (restoreModel || restoreThinking !== undefined) {
					await restoreSessionState(ctx, restoreModel, restoreThinking, getCurrentModel(ctx), pi.getThinkingLevel());
				}
			};
			if (postTurnCompactionFellBack) {
				const command = toolManager.clearQueue();
				await restoreFn();
				if (command) {
					notify(
						ctx,
						`Queued prompt command \`${command}\` was cancelled because the post-turn compaction barrier reached its fallback without a terminal event. Run the command again after compaction is healthy.`,
						"error",
					);
				}
				return;
			}
			const processed = await toolManager.processQueue(ctx, restoreFn);
			if (!processed) await restoreFn();
		} finally {
			queuedAgentSettledDrainGenerationBaseline = null;
			leaveAgentEndDrain();
		}
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

	async function runChainCommand(
		args: string,
		ctx: ExtensionCommandContext,
		options: { skipAgentEndDrain?: boolean; allowPromptActive?: boolean } = {},
	) {
		if (!(await waitForCommandLifecycleBoundary(ctx, { skipAgentEndDrain: options.skipAgentEndDrain }))) return;
		const owner = claimWorkflowOwner("legacy:chain-prompts", options.allowPromptActive);
		if (!owner) {
			notify(ctx, "A legacy chain cannot start while another prompt workflow is active.", "error");
			return;
		}
		try {
			storedCommandCtx = ctx;
			refreshPrompts(ctx.cwd, ctx);

			const removedFlag = findRemovedLegacyRuntimeFlag(args);
			if (removedFlag) {
				notify(ctx, `Removed legacy runtime flag \`${removedFlag}\` is not supported. Use structured single/fork delegation or a sequential/adaptive workflow. Quote the flag when it is prompt content.`, "error");
				return;
			}
			const subagent = extractSubagentOverride(args);
			const runtimeCwd = subagent.cwd ? expandCwdPath(subagent.cwd) : undefined;
			if (subagent.cwd && !runtimeCwd) {
				notify(ctx, `Invalid --cwd path: must be absolute`, "error");
				return;
			}
			const extracted = extractChainContextFlag(subagent.args);
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
				owner,
			);
		} finally {
			releaseWorkflowOwner(owner);
		}
	}

	if (toolManager.isEnabled()) toolManager.ensureRegistered();

	pi.registerCommand("chain-prompts", {
		description: "Chain prompt templates sequentially [template -> template -> ...]",
		handler: async (args, ctx) => {
			await runChainCommand(args, ctx);
		},
	});
	pi.registerCommand("validate-prompts", {
		description: "Validate prompt templates, includes, frontmatter, and skill references",
		handler: async (args, ctx) => {
			const validation = validatePromptTemplates(ctx.cwd, { registeredSkills: collectRegisteredPromptSkills(), projectTrusted: projectIsTrusted(ctx) });
			const output = formatPromptValidationReport(validation);
			const plain = args.split(/\s+/).some((arg) => arg === "--plain");
			if (plain) {
				process.stdout.write(output);
				return;
			}
			notify(ctx, output, validation.ok ? "info" : "error");
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
