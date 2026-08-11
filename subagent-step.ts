import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { captureStepExecutionOutcome, checkPromptExecutionBudget, preparePromptExecution, PromptBudgetExceededError, type StepExecutionOutcome } from "./prompt-execution.js";
import type { PromptWithModel } from "./prompt-loader.js";
import { notify } from "./notifications.js";
import { buildSkillLoadedMessage, getRequestedSkills, inspectDelegatedCwd, resolvePromptSkills, type RuntimeSkillCommand } from "./prompt-skills.js";
import {
	DEFAULT_SUBAGENT_NAME,
	appendDelegatedLiveOutput,
	clearDelegatedLiveState,
	PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE,
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT,
	updateDelegatedLiveState,
	type DelegatedSubagentRequest,
	type DelegatedSubagentResponse,
	type DelegatedSubagentStatus,
	type DelegatedSubagentUpdate,
	type DelegatedSubagentUsage,
} from "./subagent-runtime.js";
import type { SubagentOverride } from "./args.js";
import { createDelegatedProgressWidget, DELEGATED_WIDGET_KEY } from "./subagent-widget.js";
import {
	captureGitWorktreeSnapshot,
	compareGitWorktreeSnapshots,
	type GitWorktreeSnapshot,
} from "./git-worktree-snapshot.js";

interface DelegatedPromptOptions {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	currentModel: Model<any> | undefined;
	prompt: PromptWithModel;
	args: string[];
	override?: SubagentOverride;
	signal?: AbortSignal;
	inheritedModel?: Model<any>;
	taskPreamble?: string;
}

export interface DelegatedPromptOutcome {
	changed: boolean;
	text: string;
	agent: string;
	messages?: Message[];
}

export class DelegatedPromptCancelledError extends Error {
	constructor(message = "Delegated prompt cancelled.") {
		super(message);
		this.name = "DelegatedPromptCancelledError";
	}
}

function extractTextFromBlocks(content: AssistantMessage["content"]): string {
	for (let i = content.length - 1; i >= 0; i--) {
		const block = content[i];
		if (block.type === "text") {
			const trimmed = block.text.trim();
			if (trimmed) return trimmed;
		}
	}
	return "";
}

function extractDelegatedText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = extractTextFromBlocks((message as AssistantMessage).content);
		if (text) return text;
	}
	return "";
}

function coerceMessages(messages: unknown[] | undefined): Message[] {
	if (!Array.isArray(messages)) return [];
	return messages as Message[];
}

function buildAssistantTextMessage(text: string): Message[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	return [{ role: "assistant", content: [{ type: "text", text: trimmed }] }] as Message[];
}

interface NormalizedDelegatedResponse {
	requestId: string;
	agent: string;
	context: "fresh" | "fork";
	model: string;
	cwd: string;
	messages: Message[];
	status: DelegatedSubagentStatus;
	failed: boolean;
	usage?: DelegatedSubagentUsage;
	error?: string;
}

const DELEGATED_SUBAGENT_STATUSES = new Set<DelegatedSubagentStatus>([
	"completed",
	"failed",
	"timed_out",
	"cancelled",
	"interrupted",
	"turn_budget_exhausted",
	"tool_budget_exhausted",
	"structured_output_failed",
	"acceptance_failed",
	"invalid_request",
	"unavailable_context",
	"duplicate_node",
]);

function normalizeDelegatedUsage(value: unknown): DelegatedSubagentUsage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const usage = value as Record<string, unknown>;
	const fields = ["input", "output", "cacheRead", "cacheWrite", "cost", "turns", "toolCalls", "durationMs"] as const;
	if (!fields.every((field) => typeof usage[field] === "number" && Number.isFinite(usage[field]))) return undefined;
	return {
		input: usage.input as number,
		output: usage.output as number,
		cacheRead: usage.cacheRead as number,
		cacheWrite: usage.cacheWrite as number,
		cost: usage.cost as number,
		turns: usage.turns as number,
		toolCalls: usage.toolCalls as number,
		durationMs: usage.durationMs as number,
	};
}

function normalizeDelegatedResponse(
	data: unknown,
	request: DelegatedSubagentRequest,
): NormalizedDelegatedResponse | undefined {
	if (!data || typeof data !== "object") return undefined;
	const payload = data as Partial<DelegatedSubagentResponse>;
	if (payload.requestId !== request.requestId) return undefined;
	if (typeof payload.status !== "string" || !DELEGATED_SUBAGENT_STATUSES.has(payload.status as DelegatedSubagentStatus)) return undefined;
	if (payload.ownerRunId !== request.ownerRunId || payload.nodeId !== request.nodeId) return undefined;
	const status = payload.status as DelegatedSubagentStatus;
	const output = payload.result?.kind === "text" && typeof payload.result.text === "string"
		? payload.result.text
		: "";
	const failed = status !== "completed";
	return {
		requestId: payload.requestId,
		agent: payload.agent ?? request.agent,
		context: request.context,
		model: payload.model ?? request.model,
		cwd: request.cwd,
		messages: buildAssistantTextMessage(output),
		status,
		failed,
		usage: normalizeDelegatedUsage(payload.usage),
		error: payload.error ?? (failed ? status : undefined),
	};
}

function captureDelegatedGitSnapshot(cwd: string): GitWorktreeSnapshot | undefined {
	try {
		return captureGitWorktreeSnapshot(cwd);
	} catch {
		return undefined;
	}
}

function delegatedRunChanged(
	before: GitWorktreeSnapshot | undefined,
	cwd: string,
	toolCalls: number,
): boolean {
	if (!before) {
		// The structured bridge does not expose tool names. Outside an observable
		// Git worktree, any tool call is conservatively treated as a change so a
		// convergence loop does not stop before delegated work is complete.
		return toolCalls > 0;
	}
	const after = captureDelegatedGitSnapshot(cwd);
	if (!after) return true;
	try {
		return compareGitWorktreeSnapshots(before, after).changed;
	} catch {
		return true;
	}
}

function delegatedCancelPayload(
	request: DelegatedSubagentRequest,
): Record<string, string> {
	return {
		requestId: request.requestId,
		ownerRunId: request.ownerRunId,
		nodeId: request.nodeId,
	};
}

function resolveDelegationName(prompt: PromptWithModel, override?: SubagentOverride): string | undefined {
	if (override) {
		return override.agent || (typeof prompt.subagent === "string" ? prompt.subagent : DEFAULT_SUBAGENT_NAME);
	}
	if (prompt.subagent === true) return DEFAULT_SUBAGENT_NAME;
	if (typeof prompt.subagent === "string") return prompt.subagent;
	return undefined;
}

interface PreparedDelegatedTask {
	promptName: string;
	agent: string;
	task: string;
	context: "fresh" | "fork";
	model: string;
	cwd: string;
}

const approvedNestedProjectsBySession = new WeakMap<object, Set<string>>();

async function approveNestedDelegatedProject(ctx: ExtensionContext, projectRoot: string): Promise<void> {
	const sessionKey = ctx.sessionManager as object;
	const approvedProjects = approvedNestedProjectsBySession.get(sessionKey);
	if (approvedProjects?.has(projectRoot)) return;

	const message =
		`Separate approval is required for nested project configuration at \`${projectRoot}\`. ` +
		"pi-subagents can load project-local agents, settings, skills, and extensions from this directory.";
	if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") {
		throw new Error(`${message} Run this delegation in an interactive Pi session to approve it.`);
	}
	const approved = await ctx.ui.confirm("Approve nested delegated project", message, { timeout: 30_000 });
	if (!approved) throw new Error(`${message} Approval was not granted.`);

	const nextApprovedProjects = approvedProjects ?? new Set<string>();
	nextApprovedProjects.add(projectRoot);
	if (!approvedProjects) approvedNestedProjectsBySession.set(sessionKey, nextApprovedProjects);
}

async function prepareDelegatedTask(
	prompt: PromptWithModel,
	args: string[],
	ctx: ExtensionContext,
	commands: RuntimeSkillCommand[],
	currentModel: Model<any> | undefined,
	override: SubagentOverride | undefined,
	inheritedModel: Model<any> | undefined,
	taskPreamble: string | undefined,
): Promise<PreparedDelegatedTask> {
	const requestedAgent = resolveDelegationName(prompt, override);
	if (!requestedAgent) {
		throw new Error(`Prompt \`${prompt.name}\` is not configured for delegated execution.`);
	}
	const requestedCwd = prompt.cwd ?? ctx.cwd;
	if (!existsSync(requestedCwd)) {
		throw new Error(`cwd directory does not exist: ${requestedCwd}`);
	}
	const inspectedCwd = inspectDelegatedCwd(ctx.cwd, requestedCwd, ctx.isProjectTrusted?.() !== false);
	if (inspectedCwd.kind === "error") throw new Error(inspectedCwd.error);
	if (inspectedCwd.value.nestedProjectRoot) {
		await approveNestedDelegatedProject(ctx, inspectedCwd.value.nestedProjectRoot);
	}
	const verifiedCwd = inspectDelegatedCwd(ctx.cwd, requestedCwd, ctx.isProjectTrusted?.() !== false);
	if (verifiedCwd.kind === "error") throw new Error(verifiedCwd.error);
	if (
		verifiedCwd.value.effectiveCwd !== inspectedCwd.value.effectiveCwd
		|| verifiedCwd.value.nestedProjectRoot !== inspectedCwd.value.nestedProjectRoot
	) {
		throw new Error("Delegated cwd changed while project trust was being verified; refusing execution.");
	}
	const effectiveCwd = verifiedCwd.value.effectiveCwd;
	const agent = requestedAgent;
	const preparationOptions = inheritedModel === undefined
		? { scopedModels: ctx.scopedModels }
		: { inheritedModel, scopedModels: ctx.scopedModels };
	const prepared = await preparePromptExecution(
		prompt,
		args,
		currentModel,
		ctx.modelRegistry,
		preparationOptions,
	);
	if (!prepared) {
		throw new Error(`No available model from: ${prompt.models.join(", ")}`);
	}
	if ("message" in prepared) {
		if (prepared.warning) notify(ctx, prepared.warning, "warning");
		throw new Error(prepared.message);
	}
	if (prepared.warning) notify(ctx, prepared.warning, "warning");
	const requestedSkills = getRequestedSkills(prompt);
	const skillResolution = resolvePromptSkills(
		requestedSkills,
		effectiveCwd,
		commands,
		{ includeProjectSkills: true },
	);
	if (skillResolution.kind === "error") {
		throw new Error(skillResolution.error);
	}
	const resolvedSkills = skillResolution.kind === "ready" ? skillResolution.skills : [];
	const resolvedSkillPreamble = resolvedSkills.length > 0
		? buildSkillLoadedMessage(resolvedSkills).content
		: undefined;
	let taskText = prepared.content;
	if (!prompt.inheritContext && taskPreamble) {
		taskText = `${taskPreamble}\n\n---\n\n${prepared.content}`;
	}
	if (resolvedSkillPreamble) {
		// Bind the exact content that the host validated, trust-filtered, and budgeted.
		// Sending names would let the child resolve a same-name project skill instead.
		taskText = `${resolvedSkillPreamble}\n\n---\n\n${taskText}`;
	}
	const budgetCheck = checkPromptExecutionBudget(prompt, taskText);
	if (budgetCheck.warning) notify(ctx, budgetCheck.warning, "warning");
	if (budgetCheck.message) throw new PromptBudgetExceededError(budgetCheck.message);

	return {
		promptName: prompt.name,
		agent,
		task: taskText,
		context: prompt.inheritContext ? "fork" : "fresh",
		model: `${prepared.selectedModel.model.provider}/${prepared.selectedModel.model.id}`,
		cwd: effectiveCwd,
	};
}

function formatProgressStatus(update: DelegatedSubagentUpdate): string | undefined {
	if (update.currentTool) {
		return `running ${update.currentTool}${update.currentToolArgs ? ` ${update.currentToolArgs}` : ""}`;
	}
	if (update.toolCount && update.toolCount > 0) {
		return `completed ${update.toolCount} tool${update.toolCount === 1 ? "" : "s"}`;
	}
	return undefined;
}

function sanitizeOutputLines(lines: string[] | undefined): string[] {
	if (!lines || lines.length === 0) return [];
	return lines.filter((line): line is string => typeof line === "string" && line.trim().length > 0 && line.trim() !== "(running...)");
}

async function requestDelegatedRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: DelegatedSubagentRequest,
	signal?: AbortSignal,
): Promise<NormalizedDelegatedResponse> {
	if (signal?.aborted) throw new DelegatedPromptCancelledError();
	return await new Promise((resolve, reject) => {
		const requestLabel = request.agent;
		let done = false;
		let started = false;
		let lastProgressStatus = "";
		let widgetSet = false;
		let refreshTimer: ReturnType<typeof setInterval> | null = null;
		let startTimeout: ReturnType<typeof setTimeout>;
		let onAbort: (() => void) | undefined;
		let onTerminalInput: (() => void) | undefined;
		let unsubscribeStarted = () => {};
		let unsubscribeResponse = () => {};
		let unsubscribeUpdate = () => {};

		const clearWidget = () => {
			if (refreshTimer) {
				clearInterval(refreshTimer);
				refreshTimer = null;
			}
			if (ctx.hasUI && widgetSet) {
				ctx.ui.setWidget(DELEGATED_WIDGET_KEY, undefined);
				widgetSet = false;
			}
		};

		const finish = (next: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(startTimeout);
			unsubscribeStarted();
			unsubscribeResponse();
			unsubscribeUpdate();
			onTerminalInput?.();
			clearWidget();
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			next();
		};

		const startTimeoutMs = Number(process.env.PI_PROMPT_SUBAGENT_START_TIMEOUT_MS ?? "15000");
		const effectiveTimeout = Number.isFinite(startTimeoutMs) && startTimeoutMs > 0 ? startTimeoutMs : 15_000;
		startTimeout = setTimeout(() => {
			finish(() => reject(new Error(`Delegated subagent \`${requestLabel}\` did not start within ${Math.round(effectiveTimeout / 1000)}s. Check that the subagent extension is loaded.`)));
		}, effectiveTimeout);

		const showWidget = () => {
			if (!ctx.hasUI || widgetSet) return;
			widgetSet = true;
			ctx.ui.setWidget(
				DELEGATED_WIDGET_KEY,
				(_tui, theme) => createDelegatedProgressWidget(request.requestId, request.agent, request.context, request.task, theme, request.model),
				{ placement: "aboveEditor" },
			);
			refreshTimer = setInterval(() => {
				if (done) return;
				const statusLine = lastProgressStatus || "running...";
				ctx.ui.setStatus("prompt-subagent", `delegating to ${requestLabel} · ${statusLine}`);
			}, 1000);
		};

		const matchesIdentity = (data: unknown): data is { requestId: string; ownerRunId: string; nodeId: string } => {
			if (!data || typeof data !== "object" || Array.isArray(data)) return false;
			const value = data as Record<string, unknown>;
			return value.requestId === request.requestId
				&& value.ownerRunId === request.ownerRunId
				&& value.nodeId === request.nodeId;
		};

		const onStarted = (data: unknown) => {
			if (done || !matchesIdentity(data)) return;
			started = true;
			clearTimeout(startTimeout);
			updateDelegatedLiveState(request.requestId, {
				status: "running...",
				toolCount: 0,
				recentOutput: [],
			});
			showWidget();
		};

		const onResponse = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const payload = normalizeDelegatedResponse(data, request);
			if (!payload) return;
			clearTimeout(startTimeout);
			updateDelegatedLiveState(request.requestId, {
				status: payload.failed ? "failed" : "completed",
			});
			clearWidget();
			finish(() => resolve(payload));
		};

		const onUpdate = (data: unknown) => {
			if (done || !matchesIdentity(data)) return;
			const update = data as DelegatedSubagentUpdate;
			const progressStatus = formatProgressStatus(update);
			if (progressStatus) lastProgressStatus = progressStatus;

			updateDelegatedLiveState(request.requestId, {
				status: progressStatus ?? (lastProgressStatus || "running..."),
				currentTool: update.currentTool,
				currentToolArgs: update.currentToolArgs,
				recentTools: update.recentTools,
				model: update.model,
				toolCount: update.toolCount,
				durationMs: update.durationMs,
				tokens: update.tokens,
			});
			if (update.recentOutputLines && update.recentOutputLines.length > 0) {
				updateDelegatedLiveState(request.requestId, {
					recentOutput: sanitizeOutputLines(update.recentOutputLines),
				});
			} else {
				appendDelegatedLiveOutput(request.requestId, update.recentOutput);
			}

			if (!ctx.hasUI) return;
			const statusLine = progressStatus ?? (lastProgressStatus || "running...");
			ctx.ui.setStatus("prompt-subagent", `delegating to ${requestLabel} · ${statusLine}`);
		};

		onTerminalInput = ctx.mode === "tui"
			? ctx.ui.onTerminalInput((input) => {
				if (!matchesKey(input, Key.escape)) return undefined;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, delegatedCancelPayload(request));
				finish(() => reject(new DelegatedPromptCancelledError()));
				return { consume: true };
			})
			: undefined;

		unsubscribeStarted = pi.events.on(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, onStarted);
		unsubscribeResponse = pi.events.on(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, onResponse);
		unsubscribeUpdate = pi.events.on(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, onUpdate);

		onAbort = () => {
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, delegatedCancelPayload(request));
			finish(() => reject(new DelegatedPromptCancelledError()));
		};
		if (signal) {
			if (signal.aborted) {
				finish(() => reject(new DelegatedPromptCancelledError()));
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, request);

		// The bridge emits STARTED_EVENT synchronously during REQUEST_EVENT.
		if (!started && done) return;
		if (!started) {
			finish(() => reject(new Error(
				`No loaded pi-subagents bridge responded for \`${requestLabel}\`. ` +
				`Ensure the subagent extension is loaded and has no name conflicts with other extensions.`,
			)));
		}
	});
}

export async function executeSubagentPromptStep(options: DelegatedPromptOptions): Promise<DelegatedPromptOutcome> {
	const { pi, ctx, currentModel, prompt, args, override, signal, inheritedModel, taskPreamble } = options;
	if (signal?.aborted) throw new DelegatedPromptCancelledError();
	const commands = typeof (pi as { getCommands?: () => RuntimeSkillCommand[] }).getCommands === "function"
		? (pi as { getCommands: () => RuntimeSkillCommand[] }).getCommands()
		: [];
	const preparedTask = await prepareDelegatedTask(
		prompt,
		args,
		ctx,
		commands,
		currentModel,
		override,
		inheritedModel,
		taskPreamble,
	);
	if (signal?.aborted) throw new DelegatedPromptCancelledError();

	const requestId = randomUUID();
	const request: DelegatedSubagentRequest = {
		requestId,
		ownerRunId: requestId,
		nodeId: "single",
		agent: preparedTask.agent,
		task: preparedTask.task,
		context: preparedTask.context,
		model: preparedTask.model,
		cwd: preparedTask.cwd,
		result: { kind: "text" },
	};
	const beforeSnapshot = captureDelegatedGitSnapshot(preparedTask.cwd);

	if (ctx.hasUI) {
		ctx.ui.setStatus("prompt-subagent", `delegating to ${preparedTask.agent}`);
		ctx.ui.setWorkingMessage(`Running delegated prompt with ${preparedTask.agent}...`);
	}
	notify(ctx, `Delegating prompt \`${preparedTask.promptName}\` to subagent \`${preparedTask.agent}\``, "info");

	try {
		const response = await requestDelegatedRun(pi, ctx, request, signal);
		if (response.status === "cancelled" || response.status === "interrupted") {
			throw new DelegatedPromptCancelledError(`Delegated prompt ${response.status}.`);
		}
		if (response.failed) {
			throw new Error(`Delegated prompt execution failed: ${response.error || response.status}`);
		}

		const messages = coerceMessages(response.messages);
		const text = extractDelegatedText(messages);
		if (!text) throw new Error("Delegated subagent returned no assistant text.");

		const changed = delegatedRunChanged(beforeSnapshot, preparedTask.cwd, response.usage?.toolCalls ?? 0);
		pi.sendMessage({
			customType: PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE,
			content: text,
			display: true,
			details: {
				requestId: response.requestId,
				agent: preparedTask.agent,
				task: request.task,
				context: response.context,
				model: response.model,
				messages,
				usage: response.usage,
				text,
				changed,
			},
		});

		return {
			changed,
			text,
			agent: preparedTask.agent,
			messages,
		};
	} catch (error) {
		if (error instanceof DelegatedPromptCancelledError) throw error;
		const cause = error instanceof Error ? error : new Error(String(error));
		throw new Error(`Prompt \`${preparedTask.promptName}\` delegated subagent \`${preparedTask.agent}\` failed: ${cause.message}`, { cause });
	} finally {
		clearDelegatedLiveState(request.requestId);
		if (ctx.hasUI) {
			ctx.ui.setStatus("prompt-subagent", undefined);
			ctx.ui.setWorkingMessage();
		}
	}
}

/** Adaptive-runtime adapter; executeSubagentPromptStep keeps its existing throw semantics. */
export async function executeSubagentPromptStepOutcome(
	options: DelegatedPromptOptions,
): Promise<StepExecutionOutcome<DelegatedPromptOutcome | undefined>> {
	return captureStepExecutionOutcome(() => executeSubagentPromptStep(options));
}
