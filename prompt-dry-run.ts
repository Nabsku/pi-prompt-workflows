import { existsSync, readFileSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	extractLoopCount,
	extractLoopFlags,
	extractLineupOverrides,
	extractSubagentOverride,
	findRemovedLegacyRuntimeFlag,
	parseCommandArgs,
	splitRawArgsAtBoundary,
	type SubagentOverride,
	type LineupOverrideExtraction,
} from "./args.js";
import type { ModelSelectionOptions, RegistryLike } from "./model-selection.js";
import { evaluatePromptBudget, estimatePromptTokens, type PromptBudgetResult, type PromptBudgetSourceEstimate } from "./prompt-budget.js";
import { preparePromptExecution } from "./prompt-execution.js";
import { applyLineupOverrides, MAX_BEST_OF_N_REQUESTS } from "./best-of-n.js";
import { expandCwdPath, type PromptWithModel } from "./prompt-loader.js";
import { stripPromptPartialFrontmatter, type PromptIncludeGraph } from "./prompt-includes.js";
import { buildSkillLoadedMessage, canResolveProjectSkills, getDelegatedCwdTrustError, getRequestedSkills, resolvePromptSkills, type RuntimeSkillCommand } from "./prompt-skills.js";
import { DEFAULT_SUBAGENT_NAME } from "./subagent-runtime.js";
import { prepareAdaptivePreflight, type AdaptivePreflight } from "./adaptive-preflight.js";
import { inputModeEligibilityError, resolvePromptInputs } from "./prompt-inputs.js";

export const DRY_RUN_CHAIN_UNSUPPORTED =
	"Dry-run for chain templates is not supported in v1. Use /validate-prompts for structural checks.";
export const DRY_RUN_DETERMINISTIC_UNSUPPORTED =
	"Dry-run for deterministic prompts is not supported in v1 because it would require running configured commands/scripts.";

export interface PromptDryRunSkillPreview {
	skillName: string;
	skillPath: string;
	skillContent?: string;
}

export interface PromptDryRunLoopMetadata {
	count: number | null;
	fresh: boolean;
	converge: boolean;
}

export interface PromptDryRunDelegationMetadata {
	enabled: true;
	agent?: string;
	fork?: boolean;
	inheritContext?: boolean;
}

export interface PromptDryRunBestOfNMetadata {
	workers: number;
	reviewers: number;
	finalApplier: boolean;
	totalRequests: number;
	maxRequests: number;
}

export interface PromptDryRunRuntimeMetadata {
	model?: string;
	cwd?: string;
	loop?: PromptDryRunLoopMetadata;
	restore: boolean;
	thinking?: ThinkingLevel;
	boomerang: boolean;
	bestOfN?: PromptDryRunBestOfNMetadata;
	delegation?: PromptDryRunDelegationMetadata;
	inheritContext?: boolean;
}

export interface PromptDryRunDetails {
	skills: PromptDryRunSkillPreview[];
	includeGraph?: PromptIncludeGraph;
}

export interface PromptDryRunSuccess {
	status: "ok";
	promptName: string;
	content: string;
	args: string[];
	model?: Model<any>;
	modelAlreadyActive: boolean;
	warnings: string[];
	budget: PromptBudgetResult;
	skills: PromptDryRunSkillPreview[];
	details: PromptDryRunDetails;
	includeGraph?: PromptIncludeGraph;
	runtime: PromptDryRunRuntimeMetadata;
	adaptivePreflight?: AdaptivePreflight;
}

export interface PromptDryRunError {
	status: "error";
	promptName: string;
	error: string;
	warnings: string[];
	runtime?: Partial<PromptDryRunRuntimeMetadata>;
	adaptivePreflight?: AdaptivePreflight;
	budget?: PromptBudgetResult;
}

export type PromptDryRunResult = PromptDryRunSuccess | PromptDryRunError;

export interface CreatePromptDryRunOptions {
	/** Raw command-line-ish args. Runtime-only flags are stripped before prompt rendering. */
	rawArgs?: string;
	/** Already parsed prompt args. Used when rawArgs is not provided. */
	args?: string[];
	currentModel?: Model<any>;
	modelRegistry: RegistryLike;
	scopedModels?: ModelSelectionOptions["scopedModels"];
	projectTrusted?: boolean;
	commands?: RuntimeSkillCommand[];
	/** Runtime command context cwd. Skill resolution intentionally uses this, not runtime --cwd. */
	cwd: string;
	showSkills?: boolean;
	currentModelLabel?: string;
	/** Effective catalog used for pure adaptive target inspection. */
	promptCatalog?: ReadonlyMap<string, PromptWithModel>;
}

export interface ParsedDryRunCommand {
	promptName?: string;
	remainingArgs: string;
	showSkills: boolean;
	plain: boolean;
	tui: boolean;
}

interface DryRunToken {
	value: string;
	start: number;
	end: number;
	quoted: boolean;
}

const DRY_RUN_CONTROL_FLAGS = new Set(["--show-skills", "--plain", "--tui"]);

function scanDryRunTokens(input: string): DryRunToken[] {
	const tokens: DryRunToken[] = [];
	let i = 0;
	while (i < input.length) {
		while (i < input.length && /\s/.test(input[i]!)) i++;
		if (i >= input.length) break;
		const start = i;
		let value = "";
		let quoted = false;
		let quote: string | undefined;
		while (i < input.length) {
			const ch = input[i]!;
			if (quote) {
				if (ch === quote) {
					quoted = true;
					quote = undefined;
					i++;
					continue;
				}
				if (ch === "\\" && i + 1 < input.length) {
					value += input[i + 1]!;
					i += 2;
					continue;
				}
				value += ch;
				i++;
				continue;
			}

			if (/\s/.test(ch)) break;
			if (ch === "'" || ch === '"') {
				quoted = true;
				quote = ch;
				i++;
				continue;
			}
			if (ch === "\\" && i + 1 < input.length) {
				value += input[i + 1]!;
				i += 2;
				continue;
			}
			value += ch;
			i++;
		}
		tokens.push({ value, start, end: i, quoted });
	}
	return tokens;
}

function removeDryRunControlFlags(input: string, tokens: DryRunToken[]) {
	const remove = new Set<DryRunToken>();
	let showSkills = false;
	let plain = false;
	let tui = false;
	for (const token of tokens) {
		if (token.quoted || !DRY_RUN_CONTROL_FLAGS.has(token.value)) continue;
		remove.add(token);
		if (token.value === "--show-skills") showSkills = true;
		if (token.value === "--plain") plain = true;
		if (token.value === "--tui") tui = true;
	}

	let cleaned = "";
	let cursor = 0;
	for (const token of tokens) {
		if (!remove.has(token)) continue;
		cleaned += input.slice(cursor, token.start);
		cursor = token.end;
	}
	cleaned += input.slice(cursor);
	return { cleaned: cleaned.trim(), showSkills, plain, tui };
}

export function parseDryRunCommand(input: string): ParsedDryRunCommand {
	const initialTokens = scanDryRunTokens(input);
	const { cleaned, showSkills, plain, tui } = removeDryRunControlFlags(input, initialTokens);
	const tokens = scanDryRunTokens(cleaned);
	const promptToken = tokens[0];
	if (!promptToken) return { remainingArgs: "", showSkills, plain, tui };
	return {
		promptName: promptToken.value,
		remainingArgs: cleaned.slice(promptToken.end).trim(),
		showSkills,
		plain,
		tui,
	};
}

function errorResult(
	prompt: Pick<PromptWithModel, "name">,
	error: string,
	warnings: string[] = [],
	runtime?: Partial<PromptDryRunRuntimeMetadata>,
	budget?: PromptBudgetResult,
): PromptDryRunError {
	return { status: "error", promptName: prompt.name, error, warnings, ...(runtime ? { runtime } : {}), ...(budget ? { budget } : {}) };
}

function shouldDelegatePrompt(prompt: Pick<PromptWithModel, "subagent" | "bestOfN">, override?: SubagentOverride): boolean {
	return prompt.subagent !== undefined || prompt.bestOfN !== undefined || override?.enabled === true;
}

function countLineupSlots(slots: Array<{ count?: number }> | undefined): number {
	return (slots ?? []).reduce((total, slot) => total + (slot.count ?? 1), 0);
}

function applyRepresentativeLoopRotation(prompt: PromptWithModel, runtime: PromptDryRunRuntimeMetadata) {
	if (!runtime.loop || !prompt.rotate || prompt.models.length <= 1) {
		return { prompt, rotationLabel: undefined } as const;
	}

	const rotationIndex = 0;
	const rotatedThinking = prompt.thinkingLevels ? prompt.thinkingLevels[rotationIndex] : prompt.thinking;
	const rotatedPrompt: PromptWithModel = {
		...prompt,
		models: [prompt.models[rotationIndex]!],
		thinking: rotatedThinking,
	};
	const shortModel = prompt.models[rotationIndex]!.split("/").pop() || prompt.models[rotationIndex]!;
	const thinkingLabel = rotatedThinking ? ` ${rotatedThinking}` : "";
	if (rotatedThinking) runtime.thinking = rotatedThinking;
	return { prompt: rotatedPrompt, rotationLabel: `${shortModel}${thinkingLabel}` } as const;
}

function representativeLoopContext(loop: PromptDryRunLoopMetadata, rotationLabel?: string): string {
	const iterationLabel = loop.count !== null ? `1/${loop.count}` : "1";
	return rotationLabel ? `Loop ${iterationLabel} · ${rotationLabel}` : `Loop ${iterationLabel}`;
}

function previewSkills(
	skills: Array<{ skillName: string; skillPath: string; skillContent: string }>,
	showSkills: boolean,
): PromptDryRunSkillPreview[] {
	return skills.map((skill) => ({
		skillName: skill.skillName,
		skillPath: skill.skillPath,
		...(showSkills ? { skillContent: skill.skillContent } : {}),
	}));
}

function promptBudgetSources(
	prompt: PromptWithModel,
	skills: Array<{ skillName: string; skillPath: string; skillContent: string }>,
): PromptBudgetSourceEstimate[] {
	const sources: PromptBudgetSourceEstimate[] = [];
	const rootContent = prompt.includeGraph?.root.rawBody ?? prompt.content;
	sources.push({ kind: "prompt", label: prompt.name, filePath: prompt.filePath, ...estimatePromptTokens(rootContent) });
	const seen = new Set<string>();
	for (const node of prompt.includeGraph?.nodes ?? []) {
		if (node.kind !== "partial" || node.status !== "ok" || !node.filePath || seen.has(node.filePath)) continue;
		seen.add(node.filePath);
		try {
			const content = stripPromptPartialFrontmatter(readFileSync(node.filePath, "utf8"));
			sources.push({ kind: "include", label: node.filePath, filePath: node.filePath, ...estimatePromptTokens(content) });
		} catch {
			// Include diagnostics already report source read failures; attribution is best-effort metadata.
		}
	}
	for (const skill of skills) {
		sources.push({ kind: "skill", label: skill.skillName, filePath: skill.skillPath, ...estimatePromptTokens(skill.skillContent) });
	}
	return sources;
}

function evaluateDryRunBudget(
	content: string | string[],
	prompt: PromptWithModel,
	skills: Array<{ skillName: string; skillPath: string; skillContent: string }> = [],
): PromptBudgetResult {
	const candidates = Array.isArray(content) ? content : [content];
	const results = candidates.map((candidate) => evaluatePromptBudget(candidate, prompt.budget));
	const largest = results.reduce((current, candidate) =>
		candidate.estimatedTokens > current.estimatedTokens || (candidate.estimatedTokens === current.estimatedTokens && candidate.bytes > current.bytes)
			? candidate
			: current,
	);
	return { ...largest, sources: promptBudgetSources(prompt, skills) };
}

function parseDryRunArgs(prompt: PromptWithModel, rawArgs: string | undefined, args: string[] | undefined) {
	if (rawArgs === undefined) {
		return {
			args: args ?? [],
			runtime: {
				...(prompt.loop !== undefined
					? { loop: { count: prompt.loop, fresh: prompt.fresh === true, converge: prompt.converge !== false } }
					: {}),
				restore: prompt.restore,
				...(prompt.thinking ? { thinking: prompt.thinking } : {}),
				boomerang: prompt.boomerang === true,
			},
			override: undefined,
			model: undefined,
			fork: false,
			runtimeCwd: undefined,
			lineup: undefined,
		} as const;
	}

	const boundary = prompt.inputs ? splitRawArgsAtBoundary(rawArgs) : { before: rawArgs, after: [] };
	const subagent = extractSubagentOverride(boundary.before);
	let cleanedArgs = subagent.args;
	let loop: PromptDryRunLoopMetadata | undefined;
	const extractedLoop = extractLoopCount(cleanedArgs);
	if (extractedLoop) {
		loop = { count: extractedLoop.loopCount, fresh: extractedLoop.fresh, converge: extractedLoop.converge };
		cleanedArgs = extractedLoop.args;
	} else if (prompt.loop !== undefined) {
		const flags = extractLoopFlags(cleanedArgs);
		loop = {
			count: prompt.loop,
			fresh: flags.fresh || prompt.fresh === true,
			converge: flags.converge && prompt.converge !== false,
		};
		cleanedArgs = flags.args;
	}
	const lineup = extractLineupOverrides(cleanedArgs);
	cleanedArgs = lineup.args;

	return {
		args: [...parseCommandArgs(cleanedArgs), ...(boundary.after.length ? ["--", ...boundary.after] : [])],
		runtime: {
			...(subagent.model ? { model: subagent.model } : {}),
			...(loop ? { loop } : {}),
			restore: prompt.restore,
			...(prompt.thinking ? { thinking: prompt.thinking } : {}),
			boomerang: prompt.boomerang === true,
		},
		override: subagent.override,
		model: subagent.model,
		fork: subagent.fork === true,
		runtimeCwd: subagent.cwd,
		lineup,
	} as const;
}

export async function createPromptDryRun(
	prompt: PromptWithModel,
	options: CreatePromptDryRunOptions,
): Promise<PromptDryRunResult> {
	if (options.rawArgs !== undefined) {
		const removedFlag = findRemovedLegacyRuntimeFlag(options.rawArgs);
		if (removedFlag) {
			return errorResult(
				prompt,
				`Removed legacy runtime flag \`${removedFlag}\` is not supported. Use structured single/fork delegation or a sequential/adaptive workflow. Quote the flag when it is prompt content.`,
				[],
				{},
			);
		}
	}
	const parsed = parseDryRunArgs(prompt, options.rawArgs, options.args);
	const inputModeError = inputModeEligibilityError({ ...prompt, subagent: prompt.subagent || parsed.override || parsed.fork });
	if (inputModeError) return errorResult(prompt, inputModeError, []);
	const runtime: PromptDryRunRuntimeMetadata = { ...parsed.runtime };
	const warnings: string[] = [];
	if (prompt.inputs && parsed.runtime.loop) return errorResult(prompt, inputModeEligibilityError({ inputs: prompt.inputs }) ?? "Prompt inputs do not support runtime loops", warnings, runtime);
	let resolvedPositional = parsed.args;
	if (prompt.inputs) {
		const resolved = resolvePromptInputs(prompt.inputs, parsed.args);
		if (resolved.errors.length > 0) return errorResult(prompt, `Invalid prompt inputs: ${resolved.errors[0]}`, warnings, runtime);
		resolvedPositional = resolved.positional;
		prompt = { ...prompt, resolvedInputValues: Object.fromEntries(Object.entries(resolved.values).map(([key, input]) => [key, input.value])) };
	}

	if (prompt.adaptiveChain) {
		const runtimeCwd = parsed.runtimeCwd ? expandCwdPath(parsed.runtimeCwd) : undefined;
		if (parsed.runtimeCwd && !runtimeCwd) return errorResult(prompt, "Invalid --cwd path: must be absolute", warnings, runtime);
		if (runtimeCwd) runtime.cwd = runtimeCwd;
		const adaptivePreflight = await prepareAdaptivePreflight(prompt, options.promptCatalog ?? new Map(), { cwd: options.cwd, runtimeCwd, args: parsed.args, modelOverride: parsed.model, currentModel: options.currentModel, modelRegistry: options.modelRegistry, scopedModels: options.scopedModels, projectTrusted: options.projectTrusted, commands: options.commands });
		warnings.push(...adaptivePreflight.warnings);
		const unsupportedRuntime = parsed.override || parsed.fork || parsed.runtime.loop;
		if (unsupportedRuntime) return { ...errorResult(prompt, "Adaptive chains reject runtime --subagent, --fork, and --loop modes because they can expand one router action into multiple top-level model calls; exact call reservation is not implemented.", warnings, runtime), adaptivePreflight };
		if (adaptivePreflight.status === "blocked") return { ...errorResult(prompt, adaptivePreflight.diagnostics.join("\n"), warnings, runtime), adaptivePreflight };
		return { status: "ok", promptName: prompt.name, content: "", args: parsed.args, modelAlreadyActive: true, warnings, budget: evaluateDryRunBudget("", prompt, []), skills: [], details: { skills: [] }, runtime, adaptivePreflight };
	}
	if (prompt.chain) return errorResult(prompt, DRY_RUN_CHAIN_UNSUPPORTED, warnings, runtime);
	if (prompt.deterministic) return errorResult(prompt, DRY_RUN_DETERMINISTIC_UNSUPPORTED, warnings, runtime);

	if (parsed.runtimeCwd) {
		const runtimeCwd = expandCwdPath(parsed.runtimeCwd);
		if (!runtimeCwd) return errorResult(prompt, "Invalid --cwd path: must be absolute", warnings, runtime);
		runtime.cwd = runtimeCwd;
	}

	let effectivePrompt: PromptWithModel = {
		...prompt,
		...(parsed.model ? { models: [parsed.model] } : {}),
		...(parsed.fork ? { inheritContext: true } : {}),
		...(runtime.cwd ? { cwd: runtime.cwd } : {}),
	};
	if (parsed.lineup?.errors.length) return errorResult(prompt, parsed.lineup.errors.join(" "), warnings, runtime);
	if (parsed.lineup && parsed.lineup.actions.length > 0 && !effectivePrompt.bestOfN) {
		return errorResult(prompt, "Best-of-N runtime overrides require a prompt with a bestOfN configuration.", warnings, runtime);
	}
	if (effectivePrompt.bestOfN) {
		const bestOfN = parsed.lineup ? applyLineupOverrides(effectivePrompt.bestOfN, parsed.lineup.actions) : effectivePrompt.bestOfN;
		const workers = countLineupSlots(bestOfN.workers);
		const reviewers = countLineupSlots(bestOfN.reviewers);
		const totalRequests = workers + reviewers + (bestOfN.finalApplier ? 1 : 0);
		if (totalRequests > MAX_BEST_OF_N_REQUESTS) return errorResult(prompt, `bestOfN requested ${totalRequests} delegation requests, above the configured limit of ${MAX_BEST_OF_N_REQUESTS}.`, warnings, runtime);
		effectivePrompt = { ...effectivePrompt, bestOfN };
		runtime.bestOfN = { workers, reviewers, finalApplier: bestOfN.finalApplier !== undefined, totalRequests, maxRequests: MAX_BEST_OF_N_REQUESTS };
	}

	const delegated = shouldDelegatePrompt(effectivePrompt, parsed.override);
	const skillResolutionCwd = delegated ? (effectivePrompt.cwd ?? options.cwd) : options.cwd;
	if (delegated) {
		if (skillResolutionCwd !== options.cwd && !existsSync(skillResolutionCwd)) {
			return errorResult(prompt, `cwd directory does not exist: ${skillResolutionCwd}`, warnings, runtime);
		}
		const cwdTrustError = getDelegatedCwdTrustError(options.cwd, skillResolutionCwd, options.projectTrusted !== false);
		if (cwdTrustError) return errorResult(prompt, cwdTrustError, warnings, runtime);
	}
	const requestedSkills = getRequestedSkills(effectivePrompt);
	const skillResolution = resolvePromptSkills(requestedSkills, skillResolutionCwd, options.commands ?? [], { includeProjectSkills: canResolveProjectSkills(options.cwd, skillResolutionCwd, options.projectTrusted !== false) });
	if (skillResolution.kind === "error") return errorResult(prompt, skillResolution.error, warnings, runtime);
	if (delegated && !runtime.cwd && prompt.cwd) runtime.cwd = prompt.cwd;
	if (delegated) {
		runtime.delegation = {
			enabled: true,
			agent: effectivePrompt.bestOfN ? "best-of-n" : parsed.override?.agent ?? (typeof effectivePrompt.subagent === "string" ? effectivePrompt.subagent : DEFAULT_SUBAGENT_NAME),
			...(parsed.fork ? { fork: true, inheritContext: true } : {}),
		};
	}
	if (effectivePrompt.inheritContext) runtime.inheritContext = true;

	const loopRotation = applyRepresentativeLoopRotation(effectivePrompt, runtime);
	effectivePrompt = loopRotation.prompt;

	const prepared = await preparePromptExecution(
		effectivePrompt,
		resolvedPositional,
		options.currentModel,
		options.modelRegistry,
		{ scopedModels: options.scopedModels },
	);
	if (!prepared) {
		return errorResult(prompt, `No available model from: ${effectivePrompt.models.join(", ")}`, warnings, runtime);
	}
	if ("message" in prepared) {
		if (prepared.warning) warnings.push(prepared.warning);
		return errorResult(prompt, prepared.message, warnings, runtime);
	}
	if (prepared.warning) warnings.push(prepared.warning);

	const resolvedSkills = skillResolution.kind === "ready" ? skillResolution.skills : [];
	const skillPreviews = previewSkills(resolvedSkills, options.showSkills === true);
	let content = prepared.content;
	let budgetContent = content;
	const skillPreamble = resolvedSkills.length > 0 ? buildSkillLoadedMessage(resolvedSkills).content : undefined;
	if (delegated && skillPreamble) {
		budgetContent = `${skillPreamble}\n\n---\n\n${content}`;
	} else if (runtime.loop && !delegated) {
		content = `[${representativeLoopContext(runtime.loop, loopRotation.rotationLabel)}]\n\n${prepared.content}`;
		budgetContent = content;
	}

	return {
		status: "ok",
		promptName: prompt.name,
		content,
		args: resolvedPositional,
		model: prepared.selectedModel.model,
		modelAlreadyActive: prepared.selectedModel.alreadyActive,
		warnings,
		budget: evaluateDryRunBudget(budgetContent, prompt, resolvedSkills),
		skills: skillPreviews,
		includeGraph: effectivePrompt.includeGraph,
		details: { skills: skillPreviews, includeGraph: effectivePrompt.includeGraph },
		runtime,
	};
}
