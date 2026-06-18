import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = "prompt-template:subagent:request";
export const PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT = "prompt-template:subagent:started";
export const PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT = "prompt-template:subagent:response";
export const PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT = "prompt-template:subagent:update";
export const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = "prompt-template:subagent:cancel";
export const PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE = "prompt-template-subagent";
export const DEFAULT_SUBAGENT_NAME = "delegate";

export interface DelegatedSubagentTask {
	agent: string;
	task: string;
	model?: string;
	cwd?: string;
}

export interface DelegatedSubagentParallelResult {
	agent: string;
	messages: unknown[];
	isError: boolean;
	errorText?: string;
}

export interface DelegatedSubagentRequest {
	requestId: string;
	agent: string;
	task: string;
	tasks?: DelegatedSubagentTask[];
	context: "fresh" | "fork";
	model: string;
	cwd: string;
	worktree?: boolean;
}

export interface DelegatedSubagentResponse {
	requestId: string;
	agent: string;
	task: string;
	context: "fresh" | "fork";
	model: string;
	cwd: string;
	messages: unknown[];
	parallelResults?: DelegatedSubagentParallelResult[];
	contentText?: string;
	isError: boolean;
	errorText?: string;
}

export interface DelegatedSubagentUpdate {
	requestId: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: string;
	recentOutputLines?: string[];
	recentTools?: Array<{ tool: string; args: string }>;
	model?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
	taskProgress?: DelegatedSubagentTaskProgress[];
}

export interface DelegatedSubagentTaskProgress {
	index?: number;
	agent: string;
	status?: string;
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
	taskProgress: DelegatedSubagentTaskProgress[];
	startedAt: number;
	updatedAt: number;
}

interface RuntimeAgent {
	name: string;
}

interface DiscoverAgentsResult {
	agents: RuntimeAgent[];
}

type DiscoverAgentsFn = (cwd: string, scope: "user" | "project" | "both") => DiscoverAgentsResult;

export interface SubagentRuntime {
	root: string;
	discoverAgents: DiscoverAgentsFn;
}

let runtimeCache: SubagentRuntime | null = null;
const delegatedLiveState = new Map<string, DelegatedSubagentLiveState>();

const RUNTIME_MODULE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"] as const;

function hasRuntimeModule(root: string, baseName = "agents"): boolean {
	return RUNTIME_MODULE_EXTENSIONS.some((ext) => existsSync(join(root, `${baseName}${ext}`)));
}

function resolveHomeRelative(pathValue: string): string {
	if (pathValue === "~") return homedir();
	if (pathValue.startsWith("~/")) return resolve(homedir(), pathValue.slice(2));
	return resolve(pathValue);
}

function resolvePiAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	return configured ? resolveHomeRelative(configured) : resolve(homedir(), ".pi", "agent");
}

function projectPiPackageCandidates(cwd: string): string[] {
	const candidates: string[] = [];
	let current = resolve(cwd);
	while (true) {
		candidates.push(join(current, ".pi", "npm", "node_modules", "pi-subagents"));
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return candidates;
}

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths)];
}

function runtimeCandidates(cwd: string): string[] {
	const fromEnv = process.env.PI_SUBAGENT_RUNTIME_ROOT?.trim();
	if (fromEnv) return [resolveHomeRelative(fromEnv)];
	const packageDir = dirname(fileURLToPath(import.meta.url));
	const localSibling = resolve(packageDir, "..", "pi-subagents");
	const includeLocalSibling = basename(dirname(packageDir)) === "node_modules";
	const piAgentDir = resolvePiAgentDir();
	return uniquePaths([
		...projectPiPackageCandidates(cwd),
		resolve(piAgentDir, "npm", "node_modules", "pi-subagents"),
		resolve(piAgentDir, "node_modules", "pi-subagents"),
		...(includeLocalSibling ? [localSibling] : []),
	]);
}

function runtimeEntryCandidates(candidate: string): string[] {
	return [candidate, join(candidate, "src", "agents"), join(candidate, "dist", "agents")];
}

interface FindSubagentRootResult {
	root?: string;
	checked: string[];
	envOnly: boolean;
}

function findSubagentRoot(cwd: string): FindSubagentRootResult {
	const checked: string[] = [];
	const envOnly = Boolean(process.env.PI_SUBAGENT_RUNTIME_ROOT?.trim());
	for (const candidate of runtimeCandidates(cwd)) {
		for (const runtimeRoot of runtimeEntryCandidates(candidate)) {
			checked.push(runtimeRoot);
			if (hasRuntimeModule(runtimeRoot)) {
				return { root: runtimeRoot, checked, envOnly };
			}
		}
	}
	return { checked, envOnly };
}

async function importRuntimeModule(root: string, baseName: string): Promise<unknown> {
	const candidates = RUNTIME_MODULE_EXTENSIONS.map((ext) => join(root, `${baseName}${ext}`));

	let lastError: unknown;
	for (const filePath of candidates) {
		if (!existsSync(filePath)) continue;
		try {
			return await import(pathToFileURL(filePath).href);
		} catch (error) {
			lastError = error;
		}
	}

	if (lastError !== undefined) {
		throw lastError;
	}
	throw new Error(`Missing runtime module: ${baseName}`);
}

export function updateDelegatedLiveState(requestId: string, update: Partial<DelegatedSubagentLiveState>): void {
	const now = Date.now();
	const existing = delegatedLiveState.get(requestId) ?? {
		recentOutput: [],
		recentTools: [],
		toolCount: 0,
		durationMs: 0,
		tokens: 0,
		taskProgress: [],
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
		taskProgress: update.taskProgress ?? existing.taskProgress,
		startedAt: existing.startedAt,
		updatedAt: now,
	};
	delegatedLiveState.set(requestId, next);
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
		taskProgress: [],
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
	return delegatedLiveState.get(requestId);
}

export function clearDelegatedLiveState(requestId: string): void {
	delegatedLiveState.delete(requestId);
}

export async function ensureSubagentRuntime(cwd: string): Promise<SubagentRuntime> {
	const result = findSubagentRoot(cwd);
	const root = result.root;
	if (!root) {
		throw new Error(
			[
				"Delegated prompt execution requires pi-subagents, but no runtime module was found.",
				"Install it with `pi install npm:pi-subagents` or set PI_SUBAGENT_RUNTIME_ROOT.",
				result.envOnly
					? "Discovery mode: PI_SUBAGENT_RUNTIME_ROOT environment override only."
					: "Discovery mode: automatic project/user/sibling search.",
				"Checked runtime directories:",
				...result.checked.map((path) => `- ${path}`),
			].join("\n"),
		);
	}

	if (runtimeCache && runtimeCache.root === root) {
		return runtimeCache;
	}

	const module = await importRuntimeModule(root, "agents");
	const discoverAgents = (module as { discoverAgents?: unknown }).discoverAgents;
	if (typeof discoverAgents !== "function") {
		throw new Error(`Invalid subagent runtime at ${root}: expected discoverAgents(cwd, scope).`);
	}

	runtimeCache = {
		root,
		discoverAgents: discoverAgents as DiscoverAgentsFn,
	};
	return runtimeCache;
}

export function resolveDelegatedAgent(runtime: SubagentRuntime, cwd: string, requested: string): string {
	const discovered = runtime.discoverAgents(cwd, "both");
	if (!discovered.agents.some((agent) => agent.name === requested)) {
		throw new Error(
			`Delegated subagent \`${requested}\` not found. Available agents: ${discovered.agents.map((a) => a.name).join(", ") || "none"}.`,
		);
	}
	return requested;
}
