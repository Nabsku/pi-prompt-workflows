import { existsSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	extractLoopCount,
	extractLoopFlags,
	extractSubagentOverride,
	parseCommandArgs,
	type SubagentOverride,
} from "./args.js";
import type { RegistryLike } from "./model-selection.js";
import { preparePromptExecution } from "./prompt-execution.js";
import { expandCwdPath, type PromptWithModel } from "./prompt-loader.js";
import { getRequestedSkills, resolvePromptSkills, type RuntimeSkillCommand } from "./prompt-skills.js";
import { DEFAULT_SUBAGENT_NAME } from "./subagent-runtime.js";

export const DRY_RUN_CHAIN_UNSUPPORTED =
	"Dry-run for chain templates is not supported in v1. Use /validate-prompts for structural checks.";
export const DRY_RUN_COMPARE_UNSUPPORTED = "Dry-run for compare prompts is not supported in v1.";
export const DRY_RUN_DETERMINISTIC_UNSUPPORTED =
	"Dry-run for deterministic prompts is not supported in v1 because it would require running configured commands/scripts.";
export const DRY_RUN_DELEGATED_SKILLS_UNSUPPORTED =
	"Prompts with skill or skills frontmatter cannot run as subagents in v1.";

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
}

export interface PromptDryRunSuccess {
	status: "ok";
	promptName: string;
	content: string;
	args: string[];
	model: Model<any>;
	modelAlreadyActive: boolean;
	warnings: string[];
	skills: PromptDryRunSkillPreview[];
	details: PromptDryRunDetails;
	runtime: PromptDryRunRuntimeMetadata;
}

export interface PromptDryRunError {
	status: "error";
	promptName: string;
	error: string;
	warnings: string[];
	runtime?: Partial<PromptDryRunRuntimeMetadata>;
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
): PromptDryRunError {
	return { status: "error", promptName: prompt.name, error, warnings, ...(runtime ? { runtime } : {}) };
}

function hasCompareLineup(prompt: PromptWithModel): boolean {
	return prompt.workers !== undefined || prompt.reviewers !== undefined || prompt.finalApplier !== undefined;
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
	if (hasCompareLineup(prompt)) return errorResult(prompt, DRY_RUN_COMPARE_UNSUPPORTED, warnings, runtime);
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

	if (requestedSkills.length > 0 && delegated) {
		return errorResult(prompt, DRY_RUN_DELEGATED_SKILLS_UNSUPPORTED, warnings, runtime);
	}

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

	const skillPreviews = skillResolution.kind === "ready" ? previewSkills(skillResolution.skills, options.showSkills === true) : [];
	let content = prepared.content;
	if (delegated && effectivePrompt.parallel && effectivePrompt.parallel > 1) {
		content = Array.from({ length: effectivePrompt.parallel }, (_, index) => `[Parallel subagent ${index + 1}/${effectivePrompt.parallel}]\n\n${prepared.content}`).join("\n\n");
	} else if (runtime.loop && !delegated) {
		content = `[${representativeLoopContext(runtime.loop, loopRotation.rotationLabel)}]\n\n${prepared.content}`;
	}

	return {
		status: "ok",
		promptName: prompt.name,
		content,
		args: parsed.args,
		model: prepared.selectedModel.model,
		modelAlreadyActive: prepared.selectedModel.alreadyActive,
		warnings,
		skills: skillPreviews,
		details: { skills: skillPreviews },
		runtime,
	};
}
