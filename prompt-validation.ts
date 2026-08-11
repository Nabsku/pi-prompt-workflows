import { resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { substituteArgs } from "./args.js";
import { parseChainDeclaration, type ChainStep } from "./chain-parser.js";
import { evaluatePromptBudget, type PromptBudgetResult } from "./prompt-budget.js";
import { collectPromptIncludeGraphs, type PromptIncludeGraph, type PromptIncludeGraphEdge, type PromptIncludeGraphNode } from "./prompt-includes.js";
import { collectPromptSourceRecords, discoverFilesystemSkills, loadPromptsWithModel, readSkillContent, resolveSkillPath, type PromptLoaderDiagnostic, type PromptSource, type PromptSourceRecord, type PromptWithModel } from "./prompt-loader.js";
import { buildSkillLoadedMessage, canResolveProjectSkills, getDelegatedCwdTrustError, getRequestedSkills, resolvePromptSkills } from "./prompt-skills.js";
import { renderPromptInputValues, validatePromptInputReferences, type ResolvedPromptInput } from "./prompt-inputs.js";
import { minimumTemplateConditionalContent, renderTemplateConditionals, renderTemplateConditionalsWithInputs } from "./template-conditionals.js";
import { createAdaptivePreflight, type AdaptivePreflight } from "./adaptive-preflight.js";
import { createAdaptiveChainState, routeAdaptiveChain, type AdaptiveChainState, type ChainObservation } from "./adaptive-chain.js";
import { capSanitizedText, capSanitizedUtf8Bytes, sanitizeForTerminal, utf8ByteLength } from "./render-safe.js";
import { sanitizedGitEnvironment } from "./git-environment.js";

export interface RegisteredPromptSkill {
	skillName: string;
	skillPath?: string;
}

export interface PromptValidationOptions {
	registeredSkills?: RegisteredPromptSkill[];
	/** Load project-local prompt roots only when the current Pi session trusts the project. Defaults to true. */
	projectTrusted?: boolean;
}

/** Read-only structured-chain preflight attached to the validation report. */
export interface PromptValidationAdaptiveSummary {
	/** Effective command name after normal prompt-catalog precedence. */
	promptName: string;
	/** Source-attributed wrapper path. */
	filePath: string;
	/** Bounded graph/target analysis; runtime inputs are revalidated on execution. */
	preflight: AdaptivePreflight;
}

export interface PromptValidationIncludeGraph extends PromptIncludeGraph {
	effective: boolean;
	skipped: boolean;
}

export interface PromptValidationSourceSummary {
	projectPrompts: number;
	userPrompts: number;
	projectLibraryCommands: number;
	userLibraryCommands: number;
	projectHiddenLibraryCommands: number;
	userHiddenLibraryCommands: number;
	projectLibraryFragments: number;
	userLibraryFragments: number;
}

export interface PromptValidationBudgetSummary extends PromptBudgetResult {
	promptName: string;
	filePath: string;
}

export interface PromptValidationResult {
	ok: boolean;
	promptCount: number;
	sourceSummary: PromptValidationSourceSummary;
	diagnostics: PromptLoaderDiagnostic[];
	includeGraphs: PromptValidationIncludeGraph[];
	budgets?: PromptValidationBudgetSummary[];
	adaptiveChains?: PromptValidationAdaptiveSummary[];
}

const INCLUDE_RELATED_DIAGNOSTIC_CODES = new Set([
	"include-absolute-disallowed",
	"include-cycle",
	"include-depth-exceeded",
	"include-dotfile-disallowed",
	"include-glob-disallowed",
	"include-invalid-path",
	"include-non-markdown",
	"include-not-file",
	"include-not-found",
	"include-path-escaped",
	"include-placeholder-without-includes",
	"include-read-error",
	"include-url-disallowed",
	"invalid-include",
	"invalid-include-metadata",
	"invalid-includes",
	"invalid-includes-chain",
	"invalid-includes-conflict",
]);

function createValidationDiagnostic(code: string, filePath: string, source: PromptSource, message: string): PromptLoaderDiagnostic {
	return {
		code,
		message,
		filePath,
		source,
		key: `${code}:${filePath}:${message}`,
	};
}

function lexicalCompare(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function normalizeRegisteredSkillName(skillName: string): string {
	return skillName.startsWith("skill:") ? skillName.slice("skill:".length) : skillName;
}

function isSafeXmlSkillName(skillName: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(skillName);
}

function isWildcardSelector(skillName: string): boolean {
	return skillName.endsWith("*");
}

function uniqueSkillNames(skills: string[] | undefined): string[] {
	return Array.from(new Set(skills ?? [])).sort(lexicalCompare);
}

function sanitizeReportValue(value: string): string {
	return capSanitizedText(sanitizeForTerminal(JSON.stringify(value).slice(1, -1)), 2000, { marker: "… [field omitted]" });
}

interface RegisteredSkillCandidate {
	skillName: string;
	skillPath: string;
}

function skillReadErrorMessage(skillName: string, skillPath: string, error: unknown): string {
	return `Failed to read skill ${JSON.stringify(skillName)} at ${skillPath}: ${error instanceof Error ? error.message : String(error)}`;
}

function validateSkillPath(skillName: string, skillPath: string, result: PromptValidationResult): boolean {
	try {
		readSkillContent(skillPath);
		return true;
	} catch (error) {
		result.diagnostics.push(
			createValidationDiagnostic(
				"skill-unreadable",
				skillPath,
				"project",
				skillReadErrorMessage(skillName, skillPath, error),
			),
		);
		return false;
	}
}

function collectRegisteredSkillCandidates(registeredSkills: RegisteredPromptSkill[] | undefined): RegisteredSkillCandidate[] {
	const candidates: RegisteredSkillCandidate[] = [];
	for (const skill of registeredSkills ?? []) {
		if (!skill.skillPath) continue;
		const skillName = normalizeRegisteredSkillName(skill.skillName);
		if (!skillName) continue;
		candidates.push({ skillName, skillPath: skill.skillPath });
	}
	return candidates;
}

function validateRegisteredExactReference(registeredSkills: RegisteredSkillCandidate[], skillName: string, result: PromptValidationResult): boolean {
	for (const skill of registeredSkills) {
		if (skill.skillName !== skillName) continue;
		validateSkillPath(skill.skillName, skill.skillPath, result);
		return true;
	}
	return false;
}

function validateRegisteredWildcardReference(registeredSkills: RegisteredSkillCandidate[], prefix: string, result: PromptValidationResult): boolean {
	const matches = new Map<string, string>();
	for (const skill of registeredSkills) {
		if (!isSafeXmlSkillName(skill.skillName)) continue;
		if (!skill.skillName.startsWith(prefix)) continue;
		if (!matches.has(skill.skillName)) matches.set(skill.skillName, skill.skillPath);
	}

	for (const [skillName, skillPath] of matches) {
		validateSkillPath(skillName, skillPath, result);
	}
	return matches.size > 0;
}

function collectFilesystemSkillNames(cwd: string, includeProjectSkills: boolean): Set<string> {
	return new Set(discoverFilesystemSkills(cwd, { includeProjectSkills }).map((skill) => skill.skillName));
}

function validateFilesystemSkillReference(cwd: string, promptSource: PromptSource, skillName: string, result: PromptValidationResult, includeProjectSkills: boolean): boolean {
	const skillPath = resolveSkillPath(skillName, cwd, { includeProjectSkills });
	if (!skillPath) return false;
	try {
		readSkillContent(skillPath);
		return true;
	} catch (error) {
		result.diagnostics.push(
			createValidationDiagnostic(
				"skill-unreadable",
				skillPath,
				promptSource,
				skillReadErrorMessage(skillName, skillPath, error),
			),
		);
		return true;
	}
}

function validateChainStepTarget(
	result: PromptValidationResult,
	prompt: PromptWithModel,
	step: ChainStep,
	target: PromptWithModel,
): void {
	if (!target.chain) return;
	result.diagnostics.push(createValidationDiagnostic(
		"invalid-chain-step-target",
		prompt.filePath,
		prompt.source,
		`Prompt template ${prompt.filePath} references chain step template ${JSON.stringify(step.name)}, but chain steps cannot target another chain template (${target.filePath}).`,
	));
}

function validatePromptChains(cwd: string, result: PromptValidationResult, prompts: ReturnType<typeof loadPromptsWithModel>["prompts"]) {
	for (const prompt of prompts.values()) {
		if (!prompt.chain) continue;
		const parsedChain = parseChainDeclaration(prompt.chain);
		if (parsedChain.invalidSegments.length > 0 || parsedChain.steps.length === 0) {
			result.diagnostics.push(
				createValidationDiagnostic(
					"invalid-chain-declaration",
					prompt.filePath,
					prompt.source,
					`Prompt template ${prompt.filePath} has invalid chain declaration segment ${JSON.stringify(parsedChain.invalidSegments[0] ?? prompt.chain)}.`,
				),
			);
			continue;
		}

		const missingTemplates = parsedChain.steps.filter((step) => !prompts.has(step.name));
		if (missingTemplates.length > 0) {
			result.diagnostics.push(
				createValidationDiagnostic(
					"chain-step-not-found",
					prompt.filePath,
					prompt.source,
					`Prompt template ${prompt.filePath} references missing chain step template(s): ${missingTemplates.map((step) => step.name).join(", ")}.`,
				),
			);
		}

		for (const step of parsedChain.steps) {
			const target = prompts.get(step.name);
			if (target) validateChainStepTarget(result, prompt, step, target);
		}
	}
}

export const VALIDATION_GIT_PROBE_DEADLINE_MS = 10_000;
export const VALIDATION_GIT_PROBE_MAX_UNIQUE_CWDS = 64;
const VALIDATION_GIT_PROBE_MAX_CALL_MS = 2_000;
type GitProbeResult = "git" | "not-git" | "inconclusive";
interface GitProbeContext { readonly expiresAt: number; readonly cache: Map<string, GitProbeResult>; probes: number; limitFailure?: "deadline" | "cap"; }

function canonicalProbeCwd(cwd: string): string {
	const normalized = resolvePath(cwd);
	try { return realpathSync(normalized); } catch { return normalized; }
}

function isGitRepository(cwd: string, context: GitProbeContext): GitProbeResult {
	const canonical = canonicalProbeCwd(cwd);
	const cached = context.cache.get(canonical); if (cached) return cached;
	if (context.probes >= VALIDATION_GIT_PROBE_MAX_UNIQUE_CWDS) { context.limitFailure = "cap"; return "inconclusive"; }
	const remaining = Math.floor(context.expiresAt - performance.now());
	if (remaining <= 0) { context.limitFailure = "deadline"; return "inconclusive"; }
	context.probes++;
	try {
		const output = execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "rev-parse", "--is-inside-work-tree"], { cwd: canonical, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: Math.min(VALIDATION_GIT_PROBE_MAX_CALL_MS, remaining), maxBuffer: 4096, env: sanitizedGitEnvironment() }).trim() === "true" ? "git" : "not-git";
		context.cache.set(canonical, output); return output;
	} catch (cause: any) {
		const timedOut = cause?.code === "ETIMEDOUT" || cause?.signal === "SIGTERM" && cause?.status === null;
		const result = timedOut || performance.now() >= context.expiresAt ? "inconclusive" : "not-git";
		if (result === "inconclusive") context.limitFailure = "deadline";
		context.cache.set(canonical, result); return result;
	}
}

const ADAPTIVE_GATE_ANALYSIS_CAP = 4096;

export function collectChangedGatePredecessors(steps: readonly import("./chain-parser.js").StructuredChainStep[], limits: import("./chain-parser.js").ChainLimits): { complete: boolean; predecessors: Map<string, Set<string>> } {
	const predecessors = new Map<string, Set<string>>();
	const queue: Array<{ state: AdaptiveChainState; selected: string }> = [];
	const seen = new Set<string>();
	try {
		const initial = routeAdaptiveChain(steps, limits, createAdaptiveChainState());
		if (initial.action) queue.push({ state: initial.state, selected: initial.action.step.id });
		while (queue.length > 0) {
			if (seen.size >= ADAPTIVE_GATE_ANALYSIS_CAP) return { complete: false, predecessors };
			const current = queue.shift()!;
			// Earlier observation values are irrelevant once this action is selected;
			// the router's future is determined by selected/visited IDs plus its next observation.
			const key = `${current.selected}\0${current.state.visited.join("\0")}`;
			if (seen.has(key)) continue;
			seen.add(key);
			for (const outcome of ["succeeded", "failed", "blocked"] as const) for (const changed of [false, true]) {
				let next;
				try { next = routeAdaptiveChain(steps, limits, current.state, { outcome, changed } satisfies ChainObservation); } catch { continue; }
				for (const decision of next.decisions) {
					if (decision.matchedGate !== "changed" || decision.selectedTarget === null) continue;
					let suppliers = predecessors.get(decision.selectedTarget);
					if (!suppliers) predecessors.set(decision.selectedTarget, suppliers = new Set());
					suppliers.add(current.selected);
				}
				if (next.action) queue.push({ state: next.state, selected: next.action.step.id });
			}
		}
		return { complete: true, predecessors };
	} catch {
		return { complete: false, predecessors };
	}
}

function effectiveAdaptiveActionCwd(wrapper: PromptWithModel, step: import("./chain-parser.js").StructuredChainStep, prompts: ReturnType<typeof loadPromptsWithModel>["prompts"], cwd: string): string {
	const target = prompts.get(step.target);
	return step.kind === "run" ? target?.deterministic?.cwd ?? wrapper.cwd ?? cwd : cwd;
}

function validateAdaptiveChains(cwd: string, result: PromptValidationResult, prompts: ReturnType<typeof loadPromptsWithModel>["prompts"]): void {
	const gitProbes: GitProbeContext = { expiresAt: performance.now() + VALIDATION_GIT_PROBE_DEADLINE_MS, cache: new Map(), probes: 0 };
	let probeLimitReported = false;
	for (const prompt of prompts.values()) {
		if (!prompt.adaptiveChain) continue;
		const preflight = createAdaptivePreflight(prompt, prompts, cwd);
		(result.adaptiveChains ??= []).push({ promptName: prompt.name, filePath: prompt.filePath, preflight });
		for (const issue of preflight.diagnostics.slice(0, 100)) {
			result.diagnostics.push(createValidationDiagnostic("invalid-adaptive-chain", prompt.filePath, prompt.source, `Adaptive chain ${JSON.stringify(prompt.name)}: ${issue}`));
		}
		const analysis = collectChangedGatePredecessors(prompt.adaptiveChain.steps, prompt.adaptiveChain.limits);
		if (!analysis.complete) result.diagnostics.push(createValidationDiagnostic("adaptive-changed-gate-analysis-inconclusive", prompt.filePath, prompt.source, `Adaptive chain ${JSON.stringify(prompt.name)} changed-gate predecessor analysis exceeded its bounded reachability cap or could not be completed; validation fails closed.`));
		for (const [gateId, predecessorIds] of analysis.predecessors) for (const predecessorId of predecessorIds) {
			const predecessor = prompt.adaptiveChain.steps.find((step) => step.id === predecessorId)!;
			const effectiveCwd = effectiveAdaptiveActionCwd(prompt, predecessor, prompts, cwd);
			const probe = isGitRepository(effectiveCwd, gitProbes);
			if (probe === "not-git") result.diagnostics.push(createValidationDiagnostic("adaptive-changed-requires-git", prompt.filePath, prompt.source, `Adaptive chain ${JSON.stringify(prompt.name)} changed gate ${JSON.stringify(gateId)} can observe selected predecessor ${JSON.stringify(predecessorId)} (${predecessor.kind}:${predecessor.target}), but its runtime-effective cwd ${JSON.stringify(effectiveCwd)} is not a readable Git worktree. Runtime snapshotting would fail closed.`));
			else if (probe === "inconclusive" && !probeLimitReported) { probeLimitReported = true; result.diagnostics.push(createValidationDiagnostic("adaptive-git-probe-inconclusive", prompt.filePath, prompt.source, `Adaptive changed-gate Git validation failed closed because its aggregate ${VALIDATION_GIT_PROBE_DEADLINE_MS}ms deadline or ${VALIDATION_GIT_PROBE_MAX_UNIQUE_CWDS}-cwd probe cap was reached.`)); }
		}
	}
}

function promptSkillResolutionCwd(prompt: PromptWithModel, cwd: string): string {
	return prompt.subagent !== undefined ? (prompt.cwd ?? cwd) : cwd;
}

function validatePromptSkills(cwd: string, result: PromptValidationResult, prompts: ReturnType<typeof loadPromptsWithModel>["prompts"], options: PromptValidationOptions) {
	const registeredSkills = collectRegisteredSkillCandidates(options.registeredSkills);

	for (const prompt of prompts.values()) {
		const skillCwd = promptSkillResolutionCwd(prompt, cwd);
		const delegatedCwdTrustError = prompt.subagent !== undefined
			? getDelegatedCwdTrustError(cwd, skillCwd, options.projectTrusted !== false)
			: undefined;
		if (delegatedCwdTrustError) {
			result.diagnostics.push(createValidationDiagnostic(
				"delegated-cwd-trust",
				prompt.filePath,
				prompt.source,
				`Prompt template ${prompt.filePath} cannot preflight its delegated cwd: ${delegatedCwdTrustError}`,
			));
			continue;
		}
		const includeProjectSkills = canResolveProjectSkills(cwd, skillCwd, options.projectTrusted !== false);
		const filesystemSkillNames = collectFilesystemSkillNames(skillCwd, includeProjectSkills);
		for (const skillName of uniqueSkillNames(prompt.skills)) {
			if (isWildcardSelector(skillName)) {
				const prefix = skillName.slice(0, -1);
				const matchedRegistered = validateRegisteredWildcardReference(registeredSkills, prefix, result);
				const matchedFilesystem = Array.from(filesystemSkillNames).some((candidate) => candidate.startsWith(prefix));
				if (!matchedRegistered && !matchedFilesystem) {
					result.diagnostics.push(
						createValidationDiagnostic(
							"skill-wildcard-not-found",
							prompt.filePath,
							prompt.source,
							`Prompt template ${prompt.filePath} references skill wildcard ${JSON.stringify(skillName)}, but no registered or filesystem skills matched it.`,
						),
					);
				}
				continue;
			}

			if (validateRegisteredExactReference(registeredSkills, skillName, result)) continue;
			if (validateFilesystemSkillReference(skillCwd, prompt.source, skillName, result, includeProjectSkills)) continue;

			result.diagnostics.push(
				createValidationDiagnostic(
					"skill-not-found",
					prompt.filePath,
					prompt.source,
					`Prompt template ${prompt.filePath} references skill ${JSON.stringify(skillName)}, but it was not found in registered or filesystem skills.`,
				),
			);
		}
	}
}

function isIncludeRelatedDiagnostic(diagnostic: PromptLoaderDiagnostic): boolean {
	return INCLUDE_RELATED_DIAGNOSTIC_CODES.has(diagnostic.code);
}

function graphHasFailedIncludeSubtree(graph: PromptIncludeGraph): boolean {
	return graph.edges.some((edge) => edge.status === "failed") || graph.diagnostics.some(isIncludeRelatedDiagnostic);
}

function graphRootHasIncludeRelatedLoaderDiagnostic(graph: PromptIncludeGraph, diagnostics: PromptLoaderDiagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.filePath === graph.root.filePath && isIncludeRelatedDiagnostic(diagnostic));
}

function collectValidationIncludeGraphs(sourceRecords: PromptSourceRecord[], loaded: ReturnType<typeof loadPromptsWithModel>): PromptValidationIncludeGraph[] {
	const loadedPromptPaths = new Set([...loaded.prompts.values()].map((prompt) => prompt.filePath));
	const includeGraphs = collectPromptIncludeGraphs({ records: sourceRecords }).graphs;
	return includeGraphs.map((graph) => {
		const effective = loadedPromptPaths.has(graph.root.filePath);
		const skipped =
			!effective &&
			(graphRootHasIncludeRelatedLoaderDiagnostic(graph, loaded.diagnostics) || graphHasFailedIncludeSubtree(graph));
		return { ...graph, effective, skipped };
	});
}

function createEmptySourceSummary(): PromptValidationSourceSummary {
	return {
		projectPrompts: 0,
		userPrompts: 0,
		projectLibraryCommands: 0,
		userLibraryCommands: 0,
		projectHiddenLibraryCommands: 0,
		userHiddenLibraryCommands: 0,
		projectLibraryFragments: 0,
		userLibraryFragments: 0,
	};
}

const SOURCE_SUMMARY_COMMAND_INTENT_DIAGNOSTIC_CODES = new Set([
	"invalid-boomerang",
	"invalid-boomerang-chain",
	"invalid-chain",
	"invalid-chain-context",
	"invalid-chain-declaration",
	"invalid-converge",
	"invalid-cwd",
	"invalid-deterministic",
	"invalid-deterministic-chain",
	"invalid-deterministic-env",
	"invalid-deterministic-handoff",
	"invalid-deterministic-loop",
	"invalid-deterministic-mixed-shorthand",
	"invalid-deterministic-non-interactive",
	"invalid-deterministic-run",
	"invalid-deterministic-script",
	"invalid-deterministic-subagent",
	"invalid-deterministic-timeout",
	"invalid-fresh",
	"invalid-inherit-context",
	"invalid-loop",
	"duplicate-command-name",
	"empty-chain",
	"empty-model",
	"invalid-model",
	"invalid-model-spec",
	"invalid-restore",
	"invalid-rotate",
	"invalid-skills",
	"invalid-subagent",
	"invalid-subagent-chain",
	"unsupported-legacy-delegation",
]);

function hasSourceSummaryCommandIntentDiagnostic(record: PromptSourceRecord, diagnostics: PromptLoaderDiagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.filePath === record.filePath && SOURCE_SUMMARY_COMMAND_INTENT_DIAGNOSTIC_CODES.has(diagnostic.code));
}

function collectValidationSourceSummary(sourceRecords: PromptSourceRecord[], inventoryRecords: PromptSourceRecord[], loaded: ReturnType<typeof loadPromptsWithModel>, _includeGraphs: PromptValidationIncludeGraph[]): PromptValidationSourceSummary {
	const summary = createEmptySourceSummary();
	const loadedPromptPaths = new Set([...loaded.prompts.values()].map((prompt) => prompt.filePath));
	for (const record of sourceRecords) {
		if (record.rootKind !== "prompts") continue;
		if (!loadedPromptPaths.has(record.filePath)) continue;
		if (record.source === "project") summary.projectPrompts += 1;
		else summary.userPrompts += 1;
	}
	for (const record of inventoryRecords) {
		if (record.rootKind !== "prompt-library" || record.skippedReason === "invalid-frontmatter") continue;
		const isLibraryCommand = record.promptCapable || hasSourceSummaryCommandIntentDiagnostic(record, loaded.diagnostics);
		if (isLibraryCommand) {
			if (record.source === "project") {
				summary.projectLibraryCommands += 1;
				if (record.hidden) summary.projectHiddenLibraryCommands += 1;
			} else {
				summary.userLibraryCommands += 1;
				if (record.hidden) summary.userHiddenLibraryCommands += 1;
			}
			continue;
		}
		if (record.source === "project") summary.projectLibraryFragments += 1;
		else summary.userLibraryFragments += 1;
	}
	return summary;
}

export function validatePromptTemplates(cwd: string, options: PromptValidationOptions = {}): PromptValidationResult {
	const loaded = loadPromptsWithModel(cwd, true, { includeAdaptiveChains: true, projectTrusted: options.projectTrusted });
	const sourceRecordResult = collectPromptSourceRecords(cwd, true, { projectTrusted: options.projectTrusted });
	const includeGraphs = collectValidationIncludeGraphs(sourceRecordResult.records, loaded);
	const budgets: PromptValidationBudgetSummary[] = [];
	const result: PromptValidationResult = {
		ok: loaded.diagnostics.length === 0,
		promptCount: loaded.prompts.size,
		sourceSummary: collectValidationSourceSummary(sourceRecordResult.records, sourceRecordResult.inventoryRecords, loaded, includeGraphs),
		diagnostics: [...loaded.diagnostics],
		includeGraphs,
		budgets,
		adaptiveChains: [],
	};

	for (const prompt of loaded.prompts.values()) {
		if (!prompt.budget) continue;
		const substitutedBody = substituteArgs(prompt.content, []);
		let skillPreamble: string | undefined;
		if (prompt.subagent) {
			const commands = (options.registeredSkills ?? []).map((skill) => ({ name: skill.skillName, source: "skill", sourceInfo: { path: skill.skillPath } }));
			const skillCwd = promptSkillResolutionCwd(prompt, cwd);
			const resolved = resolvePromptSkills(getRequestedSkills(prompt), skillCwd, commands, { includeProjectSkills: canResolveProjectSkills(cwd, skillCwd, options.projectTrusted !== false) });
			if (resolved.kind === "ready" && resolved.skills.length > 0) {
				skillPreamble = buildSkillLoadedMessage(resolved.skills).content;
			}
		}
		const minimumConditionalBody = minimumTemplateConditionalContent(substitutedBody);
		const configuredModels = prompt.models.map((spec) => {
			const slash = spec.indexOf("/");
			return slash > 0 ? { provider: spec.slice(0, slash), id: spec.slice(slash + 1) } : undefined;
		});
		const inputBodies = prompt.inputs ? (() => {
			let variants: Array<Record<string, string | boolean>> = [{}];
			for (const [name, definition] of Object.entries(prompt.inputs)) {
				const choices = definition.type === "boolean" ? [false, true] : definition.type === "choice" ? (definition.options ?? []) : [definition.default ?? ""];
				variants = variants.flatMap((variant) => choices.slice(0, 8).map((value) => ({ ...variant, [name]: value }))).slice(0, 64);
			}
			return variants.map((values) => {
				const resolved: Record<string, ResolvedPromptInput> = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { name, type: typeof value === "boolean" ? "boolean" : "string", value, source: "default" }]));
				return renderTemplateConditionalsWithInputs(renderPromptInputValues(substitutedBody, resolved), { provider: "", id: "" }, values, prompt.name).content;
			});
		})() : undefined;
		const candidateBodies = inputBodies?.length ? inputBodies : configuredModels.length > 0 && configuredModels.every((model) => model !== undefined)
			? configuredModels.map((model) => renderTemplateConditionals(substitutedBody, model!).content)
			: minimumConditionalBody !== undefined ? [minimumConditionalBody] : [substitutedBody];
		const candidateBudgets = candidateBodies.map((body) => evaluatePromptBudget(
			skillPreamble ? `${skillPreamble}\n\n---\n\n${body}` : body,
			prompt.budget,
		));
		const budget = candidateBudgets.reduce((minimum, candidate) =>
			candidate.estimatedTokens < minimum.estimatedTokens || (candidate.estimatedTokens === minimum.estimatedTokens && candidate.bytes < minimum.bytes)
				? candidate
				: minimum,
		);
		budgets.push({ promptName: prompt.name, filePath: prompt.filePath, ...budget });
		const conditionalCanFit = minimumConditionalBody !== undefined && budget.verdict !== "exceeded";
		if (budget.verdict === "exceeded" && !conditionalCanFit) {
			result.diagnostics.push(createValidationDiagnostic(
				"prompt-budget-exceeded",
				prompt.filePath,
				prompt.source,
				`Prompt ${JSON.stringify(prompt.name)} statically estimates ${budget.estimatedTokens} tokens, exceeding configured maximum of ${budget.config?.maxTokens}. Runtime arguments may increase it further.`,
			));
		}
	}

	validatePromptChains(cwd, result, loaded.prompts);
	validateAdaptiveChains(cwd, result, loaded.prompts);
	validatePromptSkills(cwd, result, loaded.prompts, options);
	result.ok = result.diagnostics.length === 0;
	return result;
}

function includeGraphIsRelevant(graph: PromptValidationIncludeGraph): boolean {
	if (graph.skipped) return true;
	if (graphHasFailedIncludeSubtree(graph)) return true;
	return graph.effective && (graph.edges.length > 0 || graph.diagnostics.length > 0);
}

function includeGraphRootStatus(graph: PromptValidationIncludeGraph): "ok" | "skipped" | "failed" {
	if (graph.skipped) return "skipped";
	if (graph.edges.some((edge) => edge.status === "failed") || graph.diagnostics.length > 0) return "failed";
	return "ok";
}

function nodeById(graph: PromptValidationIncludeGraph): Map<string, PromptIncludeGraphNode> {
	return new Map(graph.nodes.map((node) => [node.id, node]));
}

function includeGraphNodeLabel(graph: PromptValidationIncludeGraph, nodes: Map<string, PromptIncludeGraphNode>, nodeId: string): string {
	const node = nodes.get(nodeId);
	if (!node) return nodeId;
	if (node.filePath === graph.root.filePath) return graph.root.promptName;
	if (node.filePath) return node.filePath;
	if (node.includePath) return `unresolved:${node.includePath}`;
	return node.id;
}

function sortIncludeGraphEdges(edges: PromptIncludeGraphEdge[]): PromptIncludeGraphEdge[] {
	return [...edges].sort((a, b) => a.order - b.order || lexicalCompare(a.fromNodeId, b.fromNodeId) || lexicalCompare(a.toNodeId, b.toNodeId) || lexicalCompare(a.includePath, b.includePath));
}

function sortDiagnostics(diagnostics: PromptLoaderDiagnostic[]): PromptLoaderDiagnostic[] {
	return [...diagnostics].sort((a, b) => lexicalCompare(a.filePath, b.filePath) || lexicalCompare(a.code, b.code) || lexicalCompare(a.message, b.message));
}

function formatIncludeGraphDiagnostic(prefix: string, diagnostic: PromptLoaderDiagnostic): string {
	return `${prefix}${sanitizeReportValue(diagnostic.code)}: ${sanitizeReportValue(diagnostic.message)}`;
}

function diagnosticKey(diagnostic: PromptLoaderDiagnostic): string {
	return diagnostic.key || `${diagnostic.code}:${diagnostic.source}:${diagnostic.filePath}:${diagnostic.message}`;
}

function rootOnlyGraphDiagnostics(graph: PromptValidationIncludeGraph): PromptLoaderDiagnostic[] {
	const edgeDiagnosticKeys = new Set(graph.edges.flatMap((edge) => edge.diagnostics.map(diagnosticKey)));
	return graph.diagnostics.filter((diagnostic) => !edgeDiagnosticKeys.has(diagnosticKey(diagnostic)));
}

function formatIncludeGraphSection(graphs: PromptValidationIncludeGraph[]): string[] {
	const relevantGraphs = graphs
		.filter(includeGraphIsRelevant)
		.sort((a, b) => lexicalCompare(a.root.promptName, b.root.promptName) || lexicalCompare(a.root.filePath, b.root.filePath));
	if (relevantGraphs.length === 0) return [];

	const lines = ["Include graph:"];
	for (const graph of relevantGraphs) {
		const nodes = nodeById(graph);
		lines.push(`- ${sanitizeReportValue(graph.root.promptName)} [${includeGraphRootStatus(graph)}] ${sanitizeReportValue(graph.root.filePath)}`);
		for (const diagnostic of sortDiagnostics(rootOnlyGraphDiagnostics(graph))) {
			lines.push(formatIncludeGraphDiagnostic("  ! ", diagnostic));
		}
		for (const edge of sortIncludeGraphEdges(graph.edges)) {
			const from = includeGraphNodeLabel(graph, nodes, edge.fromNodeId);
			const to = includeGraphNodeLabel(graph, nodes, edge.toNodeId);
			lines.push(`  - ${sanitizeReportValue(from)} -> ${sanitizeReportValue(to)} (${sanitizeReportValue(edge.kind)} ${sanitizeReportValue(edge.includePath)}) [${sanitizeReportValue(edge.status)}]`);
			for (const diagnostic of sortDiagnostics(edge.diagnostics)) {
				lines.push(formatIncludeGraphDiagnostic("    ! ", diagnostic));
			}
		}
	}
	return lines;
}

function formatSourceSummary(summary: PromptValidationSourceSummary): string {
	const hiddenLibraryCommands = summary.projectHiddenLibraryCommands + summary.userHiddenLibraryCommands;
	const parts = [
		"Sources:",
		`${summary.projectPrompts} project prompt${summary.projectPrompts === 1 ? "" : "s"}`,
		`${summary.projectLibraryCommands} project library command${summary.projectLibraryCommands === 1 ? "" : "s"}`,
		`${summary.userPrompts} user prompt${summary.userPrompts === 1 ? "" : "s"}`,
		`${summary.userLibraryCommands} user library command${summary.userLibraryCommands === 1 ? "" : "s"}`,
		`${summary.projectLibraryFragments + summary.userLibraryFragments} include-only library fragment${summary.projectLibraryFragments + summary.userLibraryFragments === 1 ? "" : "s"}`,
	];
	if (hiddenLibraryCommands > 0) {
		parts.push(`${hiddenLibraryCommands} hidden library command${hiddenLibraryCommands === 1 ? "" : "s"}`);
	}
	return parts.join(" ");
}

function formatBudgetSection(budgets: PromptValidationBudgetSummary[]): string[] {
	if (budgets.length === 0) return [];
	const lines = ["Prompt budgets (static rendered content; runtime arguments may increase totals):"];
	for (const budget of [...budgets].sort((a, b) => lexicalCompare(a.promptName, b.promptName) || lexicalCompare(a.filePath, b.filePath))) {
		const thresholds = [
			budget.config?.warnTokens !== undefined ? `warn=${budget.config.warnTokens}` : undefined,
			budget.config?.maxTokens !== undefined ? `max=${budget.config.maxTokens}` : undefined,
		].filter(Boolean).join(" ");
		lines.push(`- ${sanitizeReportValue(budget.promptName)}: ~${budget.estimatedTokens} tokens [${budget.verdict}] ${thresholds}`.trimEnd());
	}
	return lines;
}

function formatAdaptiveSection(chains: PromptValidationAdaptiveSummary[]): string[] {
	if (chains.length === 0) return [];
	const lines = ["Adaptive chains (read-only preflight snapshot; runtime revalidates):"];
	for (const chain of [...chains].sort((a, b) => lexicalCompare(a.promptName, b.promptName))) {
		const preflight = chain.preflight;
		lines.push(`- ${sanitizeReportValue(chain.promptName)} [${preflight.status}] steps=${preflight.steps.length} calls=${preflight.callBounds.minimum}..${preflight.callBounds.maximum} analysis=${preflight.analysis.complete ? "complete" : "inconclusive"}`);
	}
	return lines;
}

export function formatPromptValidationReport(result: PromptValidationResult): string {
	const includeGraphLines = formatIncludeGraphSection(result.includeGraphs);
	const sourceSummaryLine = formatSourceSummary(result.sourceSummary);
	const budgetLines = formatBudgetSection(result.budgets ?? []);
	const adaptiveLines = formatAdaptiveSection(result.adaptiveChains ?? []);
	let reportLines: string[];
	if (result.ok) {
		reportLines = [
			`[pi-prompt-workflows] Prompt validation passed: ${result.promptCount} prompt template(s) loaded.`,
			sourceSummaryLine,
			...budgetLines,
			...adaptiveLines,
			...includeGraphLines,
		];
	} else {
		const diagnostics = sortDiagnostics(result.diagnostics);
		const lines = diagnostics.map((diagnostic) => `- ${sanitizeReportValue(diagnostic.code)} (${sanitizeReportValue(diagnostic.source)}) ${sanitizeReportValue(diagnostic.filePath)}: ${sanitizeReportValue(diagnostic.message)}`);
		reportLines = [
			`[pi-prompt-workflows] Prompt validation failed: ${diagnostics.length} issue(s) found across ${result.promptCount} loaded prompt template(s).`,
			sourceSummaryLine,
			...budgetLines,
			...adaptiveLines,
			...lines,
			...includeGraphLines,
		];
	}
	const maxLines = 400;
	if (reportLines.length > maxLines) reportLines = [...reportLines.slice(0, maxLines - 1), `… [omitted ${reportLines.length - maxLines + 1} report lines]`];
	const joined = reportLines.join("\n");
	return capSanitizedUtf8Bytes(joined, 65536, { preserveLineBreaks: true, originalBytes: utf8ByteLength(joined), marker: "… [validation report omitted]" });
}
