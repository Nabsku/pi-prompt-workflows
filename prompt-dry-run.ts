import { existsSync, readFileSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	extractLoopCount,
	extractLoopFlags,
	extractSubagentOverride,
	parseCommandArgs,
	type SubagentOverride,
} from "./args.js";
import { createBestOfNPreflight, type BestOfNPreflight } from "./best-of-n-preflight.js";
import type { RegistryLike } from "./model-selection.js";
import { evaluatePromptBudget, estimatePromptTokens, type PromptBudgetResult, type PromptBudgetSourceEstimate } from "./prompt-budget.js";
import { preparePromptExecution } from "./prompt-execution.js";
import { expandCwdPath, type PromptWithModel } from "./prompt-loader.js";
import { stripPromptPartialFrontmatter, type PromptIncludeGraph } from "./prompt-includes.js";
import { buildSkillLoadedMessage, getRequestedSkills, resolvePromptSkills, type RuntimeSkillCommand } from "./prompt-skills.js";
import { DEFAULT_SUBAGENT_NAME } from "./subagent-runtime.js";

export const DRY_RUN_CHAIN_UNSUPPORTED =
	"Dry-run for chain templates is not supported in v1. Use /validate-prompts for structural checks.";
export const DRY_RUN_COMPARE_UNSUPPORTED = "Dry-run for compare prompts is not supported in v1.";
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
	parallel?: number;
}

export interface PromptDryRunRuntimeMetadata {
	model?: string;
	cwd?: string;
	loop?: PromptDryRunLoopMetadata;
	restore: boolean;
	thinking?: ThinkingLevel;
	boomerang: boolean;
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
	comparePreflight?: BestOfNPreflight;
}

export interface PromptDryRunError {
	status: "error";
	promptName: string;
	error: string;
	warnings: string[];
	runtime?: Partial<PromptDryRunRuntimeMetadata>;
	comparePreflight?: BestOfNPreflight;
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
	commands?: RuntimeSkillCommand[];
	/** Runtime command context cwd. Skill resolution intentionally uses this, not runtime --cwd. */
	cwd: string;
	showSkills?: boolean;
	currentModelLabel?: string;
	/** Prompt name whose first positional arg is compare cwd for path-driven compare templates. */
	pathArgumentPromptName?: string;
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
	comparePreflight?: BestOfNPreflight,
	budget?: PromptBudgetResult,
): PromptDryRunError {
	return { status: "error", promptName: prompt.name, error, warnings, ...(runtime ? { runtime } : {}), ...(comparePreflight ? { comparePreflight } : {}), ...(budget ? { budget } : {}) };
}

function hasCompareLineup(prompt: PromptWithModel): boolean {
	return prompt.workers !== undefined || prompt.reviewers !== undefined || prompt.finalApplier !== undefined || prompt.preset !== undefined;
}

function shouldDelegatePrompt(prompt: Pick<PromptWithModel, "subagent">, override?: SubagentOverride): boolean {
	return prompt.subagent !== undefined || override?.enabled === true;
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
	const largest = results.reduce((current, candidate) => candidate.estimatedTokens > current.estimatedTokens ? candidate : current);
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
		} as const;
	}

	const subagent = extractSubagentOverride(rawArgs);
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

	return {
		args: parseCommandArgs(cleanedArgs),
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
	} as const;
}

export async function createPromptDryRun(
	prompt: PromptWithModel,
	options: CreatePromptDryRunOptions,
): Promise<PromptDryRunResult> {
	const parsed = parseDryRunArgs(prompt, options.rawArgs, options.args);
	const runtime: PromptDryRunRuntimeMetadata = { ...parsed.runtime };
	const warnings: string[] = [];

	if (prompt.chain) return errorResult(prompt, DRY_RUN_CHAIN_UNSUPPORTED, warnings, runtime);
	if (hasCompareLineup(prompt)) {
		if (parsed.runtimeCwd) {
			const runtimeCwd = expandCwdPath(parsed.runtimeCwd);
			if (!runtimeCwd) return errorResult(prompt, "Invalid --cwd path: must be absolute", warnings, runtime);
			runtime.cwd = runtimeCwd;
		}
		const initialPreflight = createBestOfNPreflight({
			prompt,
			args: options.rawArgs ?? (options.args ?? []).join(" "),
			contextCwd: options.cwd,
			currentModelLabel: options.currentModelLabel,
			pathArgumentPromptName: options.pathArgumentPromptName,
		});
		const effectivePrompt: PromptWithModel = {
			...prompt,
			...(parsed.model ? { models: [parsed.model] } : {}),
		};
		const prepared = await preparePromptExecution(
			effectivePrompt,
			initialPreflight.task.parsed,
			options.currentModel,
			options.modelRegistry,
		);
		if (!prepared) {
			return errorResult(prompt, `No available model from: ${effectivePrompt.models.join(", ")}`, warnings, runtime);
		}
		if ("message" in prepared) {
			if (prepared.warning) warnings.push(prepared.warning);
			return errorResult(prompt, prepared.message, warnings, runtime);
		}
		if (prepared.warning) warnings.push(prepared.warning);
		const modelLabel = `${prepared.selectedModel.model.provider}/${prepared.selectedModel.model.id}`;
		const preflight = createBestOfNPreflight({
			prompt,
			args: options.rawArgs ?? (options.args ?? []).join(" "),
			contextCwd: options.cwd,
			currentModelLabel: modelLabel,
			pathArgumentPromptName: options.pathArgumentPromptName,
			renderedTask: prepared.content,
		});
		const sharedTask = preflight.task.renderedTask ?? "";
		const workerTasks = preflight.slots.workers.map((slot) => slot.effectiveTask).filter((task): task is string => task !== undefined);
		const reviewerTasks = preflight.slots.reviewers.map((slot) => [
			"[Original implementation task]",
			sharedTask,
			"",
			"[Worker outputs and worktree summaries]",
			"",
			slot.effectiveTask ?? "",
		].join("\n"));
		const finalApplierTasks = preflight.slots.finalApplier ? [[
			"[Original implementation task]",
			sharedTask,
			"",
			"[Worker outputs and worktree summaries]",
			"",
			"[Reviewer findings]",
			"",
			"[Final apply instructions]",
			"Pick one winner or synthesize/cherry-pick from multiple variants, apply the final patch directly in the current repo, keep edits minimal, run obvious relevant verification when practical, and report changed files plus verification run.",
			"",
			preflight.slots.finalApplier.effectiveTask ?? "",
			...(preflight.policies.commit.mode === "ask" ? [
				"",
				"Commit approval mode:",
				"- Do not run `git add`, `git commit`, or any command that stages or commits changes.",
				"- Leave all changes unstaged in the worktree for the user to review and approve after you finish.",
				"- If you need git for verification or reporting, use read-only commands such as `git status` or `git diff`.",
			] : []),
		].join("\n")] : [];
		const lineupTasks = [...workerTasks, ...reviewerTasks, ...finalApplierTasks];
		const budget = evaluateDryRunBudget(lineupTasks.length > 0 ? lineupTasks : (preflight.task.renderedTask ?? ""), prompt);
		if (budget.verdict === "exceeded") {
			preflight.diagnostics.push({ severity: "error", code: "prompt-budget-exceeded", message: `Compare lineup task estimated ${budget.estimatedTokens} tokens exceeds configured maximum of ${budget.config?.maxTokens}.`, source: prompt.source, filePath: prompt.filePath });
		} else if (budget.verdict === "warning") {
			preflight.diagnostics.push({ severity: "warning", code: "prompt-budget-warning", message: `Compare lineup task estimated ${budget.estimatedTokens} tokens reached warning threshold of ${budget.config?.warnTokens}.`, source: prompt.source, filePath: prompt.filePath });
		}
		warnings.push(...preflight.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").map((diagnostic) => diagnostic.message));
		const errors = preflight.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => diagnostic.message);
		if (errors.length > 0) return errorResult(prompt, errors.join("\n"), warnings, runtime, preflight, budget);
		return {
			status: "ok",
			promptName: prompt.name,
			content: preflight.task.renderedTask ?? "",
			args: preflight.task.parsed,
			model: prepared.selectedModel.model,
			modelAlreadyActive: prepared.selectedModel.alreadyActive,
			warnings,
			budget,
			skills: [],
			details: { skills: [] },
			runtime,
			comparePreflight: preflight,
		};
	}
	if (prompt.deterministic) return errorResult(prompt, DRY_RUN_DETERMINISTIC_UNSUPPORTED, warnings, runtime);

	if (parsed.runtimeCwd) {
		const runtimeCwd = expandCwdPath(parsed.runtimeCwd);
		if (!runtimeCwd) return errorResult(prompt, "Invalid --cwd path: must be absolute", warnings, runtime);
		runtime.cwd = runtimeCwd;
	}

	const requestedSkills = getRequestedSkills(prompt);
	const skillResolution = resolvePromptSkills(requestedSkills, options.cwd, options.commands ?? []);
	if (skillResolution.kind === "error") return errorResult(prompt, skillResolution.error, warnings, runtime);

	let effectivePrompt: PromptWithModel = {
		...prompt,
		...(parsed.model ? { models: [parsed.model] } : {}),
		...(parsed.fork ? { inheritContext: true } : {}),
		...(runtime.cwd ? { cwd: runtime.cwd } : {}),
	};

	const delegated = shouldDelegatePrompt(effectivePrompt, parsed.override);
	if (delegated && !runtime.cwd && prompt.cwd) runtime.cwd = prompt.cwd;
	if (delegated) {
		const effectiveCwd = effectivePrompt.cwd ?? options.cwd;
		if (effectiveCwd !== options.cwd && !existsSync(effectiveCwd)) {
			return errorResult(prompt, `cwd directory does not exist: ${effectiveCwd}`, warnings, runtime);
		}
		runtime.delegation = {
			enabled: true,
			agent: parsed.override?.agent ?? (typeof effectivePrompt.subagent === "string" ? effectivePrompt.subagent : DEFAULT_SUBAGENT_NAME),
			...(parsed.fork ? { fork: true, inheritContext: true } : {}),
			...(effectivePrompt.parallel && effectivePrompt.parallel > 1 ? { parallel: effectivePrompt.parallel } : {}),
		};
	}
	if (effectivePrompt.inheritContext) runtime.inheritContext = true;

	const loopRotation = applyRepresentativeLoopRotation(effectivePrompt, runtime);
	effectivePrompt = loopRotation.prompt;

	const prepared = await preparePromptExecution(
		effectivePrompt,
		parsed.args,
		options.currentModel,
		options.modelRegistry,
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
	let budgetContent: string | string[] = content;
	const skillPreamble = resolvedSkills.length > 0 ? buildSkillLoadedMessage(resolvedSkills).content : undefined;
	if (delegated && effectivePrompt.parallel && effectivePrompt.parallel > 1) {
		const tasks = Array.from({ length: effectivePrompt.parallel }, (_, index) => `[Parallel subagent ${index + 1}/${effectivePrompt.parallel}]\n\n${prepared.content}`);
		budgetContent = tasks.map((task) => skillPreamble ? `${skillPreamble}\n\n---\n\n${task}` : task);
		content = tasks.join("\n\n");
	} else if (delegated && skillPreamble) {
		budgetContent = `${skillPreamble}\n\n---\n\n${content}`;
	} else if (runtime.loop && !delegated) {
		content = `[${representativeLoopContext(runtime.loop, loopRotation.rotationLabel)}]\n\n${prepared.content}`;
		budgetContent = content;
	}

	return {
		status: "ok",
		promptName: prompt.name,
		content,
		args: parsed.args,
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
