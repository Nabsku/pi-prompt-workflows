export const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = "prompt-template:subagent:request";
export const PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT = "prompt-template:subagent:started";
export const PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT = "prompt-template:subagent:response";
export const PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT = "prompt-template:subagent:update";
export const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = "prompt-template:subagent:cancel";
export const PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE = "prompt-template-subagent";
export const PROMPT_TEMPLATE_PROMPT_STARTED_EVENT = "prompt-template:prompt:started";
export const PROMPT_TEMPLATE_PROMPT_FINISHED_EVENT = "prompt-template:prompt:finished";
export const PROMPT_TEMPLATE_PROMPT_PROTOCOL_VERSION = 1 as const;
export const PROMPT_TEMPLATE_PROMPT_INVOKE_REQUEST_EVENT = "prompt-template:prompt:invoke";
export const PROMPT_TEMPLATE_PROMPT_INVOKE_ACK_EVENT = "prompt-template:prompt:invoke:ack";
export const PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_SUBAGENT_NAME = "delegate";

export type PromptTemplatePromptStatus = "completed" | "failed" | "cancelled";

export interface PromptTemplatePromptStarted {
	protocolVersion: typeof PROMPT_TEMPLATE_PROMPT_PROTOCOL_VERSION;
	runId: string;
	name: string;
}

export interface PromptTemplatePromptFinished {
	protocolVersion: typeof PROMPT_TEMPLATE_PROMPT_PROTOCOL_VERSION;
	runId: string;
	name: string;
	status: PromptTemplatePromptStatus;
	changed: boolean;
	lastText?: string;
}

export type PromptTemplatePromptInvokeRefusalReason =
	| "busy"
	| "chain-template"
	| "invalid-request"
	| "not-ready"
	| "unknown-template"
	| "unsupported-context";

export interface PromptTemplatePromptInvokeRequest {
	protocolVersion: typeof PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION;
	requestId: string;
	name: string;
	args?: string;
}

export interface PromptTemplatePromptInvokeAccepted {
	protocolVersion: typeof PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION;
	requestId: string;
	name: string;
	accepted: true;
	runId: string;
}

export interface PromptTemplatePromptInvokeRefused {
	protocolVersion: typeof PROMPT_TEMPLATE_PROMPT_INVOKE_PROTOCOL_VERSION;
	requestId: string;
	name: string;
	accepted: false;
	reason: PromptTemplatePromptInvokeRefusalReason;
}

export type PromptTemplatePromptInvokeAcknowledgement =
	| PromptTemplatePromptInvokeAccepted
	| PromptTemplatePromptInvokeRefused;

export interface DelegatedSubagentTextResult {
	kind: "text";
	text: string;
}

export interface DelegatedSubagentResultSpec {
	kind: "text";
}

export interface DelegatedSubagentStarted {
	requestId: string;
	ownerRunId?: string;
	nodeId?: string;
	backend?: string;
	ownsProgress?: boolean;
}

export interface DelegatedSubagentRequest {
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	agent: string;
	task: string;
	context: "fresh" | "fork";
	model: string;
	cwd: string;
	result: DelegatedSubagentResultSpec;
}

export type DelegatedSubagentStatus =
	| "completed"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "interrupted"
	| "turn_budget_exhausted"
	| "tool_budget_exhausted"
	| "structured_output_failed"
	| "acceptance_failed"
	| "invalid_request"
	| "unavailable_context"
	| "duplicate_node";

export interface DelegatedSubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	toolCalls: number;
	durationMs: number;
}

export interface DelegatedSubagentResponse {
	requestId: string;
	ownerRunId?: string;
	nodeId?: string;
	status: DelegatedSubagentStatus;
	agent?: string;
	model?: string;
	result?: DelegatedSubagentTextResult;
	usage?: DelegatedSubagentUsage;
	error?: string;
}

export interface DelegatedSubagentUpdate {
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: string;
	recentOutputLines?: string[];
	recentTools?: Array<{ tool: string; args: string }>;
	model?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
}

export interface DelegatedSubagentLiveState {
	status?: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput: string[];
	recentTools: Array<{ tool: string; args: string }>;
	model?: string;
	toolCount: number;
	durationMs: number;
	tokens: number;
	startedAt: number;
	updatedAt: number;
}

const delegatedLiveState = new Map<string, DelegatedSubagentLiveState>();

function cloneDelegatedLiveState(state: DelegatedSubagentLiveState): DelegatedSubagentLiveState {
	return structuredClone(state);
}

export function updateDelegatedLiveState(requestId: string, update: Partial<DelegatedSubagentLiveState>): void {
	const now = Date.now();
	const existing = delegatedLiveState.get(requestId) ?? {
		recentOutput: [],
		recentTools: [],
		toolCount: 0,
		durationMs: 0,
		tokens: 0,
		startedAt: now,
		updatedAt: now,
	};
	const next: DelegatedSubagentLiveState = {
		...existing,
		...update,
		recentOutput: update.recentOutput ?? existing.recentOutput,
		recentTools: update.recentTools ?? existing.recentTools,
		model: update.model ?? existing.model,
		toolCount: update.toolCount ?? existing.toolCount,
		durationMs: update.durationMs ?? (now - existing.startedAt),
		tokens: update.tokens ?? existing.tokens,
		startedAt: existing.startedAt,
		updatedAt: now,
	};
	delegatedLiveState.set(requestId, cloneDelegatedLiveState(next));
}

export function appendDelegatedLiveOutput(requestId: string, line?: string): void {
	if (!line || !line.trim() || line.trim() === "(running...)") return;
	const fallbackNow = Date.now();
	const existing = delegatedLiveState.get(requestId) ?? {
		recentOutput: [],
		recentTools: [],
		toolCount: 0,
		durationMs: 0,
		tokens: 0,
		startedAt: fallbackNow,
		updatedAt: fallbackNow,
	};
	const recentOutput = [...existing.recentOutput, line];
	delegatedLiveState.set(requestId, {
		...existing,
		recentOutput,
		updatedAt: Date.now(),
	});
}

export function getDelegatedLiveState(requestId: string): DelegatedSubagentLiveState | undefined {
	const state = delegatedLiveState.get(requestId);
	return state ? cloneDelegatedLiveState(state) : undefined;
}

export function clearDelegatedLiveState(requestId: string): void {
	delegatedLiveState.delete(requestId);
}
