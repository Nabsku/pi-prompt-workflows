import { resolve as resolvePath } from "node:path";
import { loadBestOfNPresetCatalog } from "./best-of-n-presets.js";
import { parseChainDeclaration, type ChainStep, type ChainStepOrParallel } from "./chain-parser.js";
import { collectPromptIncludeGraphs, type PromptIncludeGraph, type PromptIncludeGraphEdge, type PromptIncludeGraphNode } from "./prompt-includes.js";
import { collectPromptSourceRecords, discoverFilesystemSkills, loadPromptsWithModel, readSkillContent, resolveSkillPath, type PromptLoaderDiagnostic, type PromptSource, type PromptSourceRecord } from "./prompt-loader.js";

export interface RegisteredPromptSkill {
	skillName: string;
	skillPath?: string;
}

export interface PromptValidationOptions {
	registeredSkills?: RegisteredPromptSkill[];
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

export interface PromptValidationResult {
	ok: boolean;
	promptCount: number;
	sourceSummary: PromptValidationSourceSummary;
	diagnostics: PromptLoaderDiagnostic[];
	includeGraphs: PromptValidationIncludeGraph[];
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
	return JSON.stringify(value).slice(1, -1);
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

function collectFilesystemSkillNames(cwd: string): Set<string> {
	return new Set(discoverFilesystemSkills(cwd).map((skill) => skill.skillName));
}

function validateFilesystemSkillReference(cwd: string, promptSource: PromptSource, skillName: string, result: PromptValidationResult): boolean {
	const skillPath = resolveSkillPath(skillName, cwd);
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

function flattenChainSteps(steps: ChainStepOrParallel[]): ChainStep[] {
	const flattened: ChainStep[] = [];
	for (const step of steps) {
		if ("parallel" in step) {
			flattened.push(...step.parallel);
		} else {
			flattened.push(step);
		}
	}
	return flattened;
}

type LoadedPrompt = ReturnType<typeof loadPromptsWithModel>["prompts"] extends Map<string, infer P> ? P : never;

function validateChainStepTarget(result: PromptValidationResult, prompt: LoadedPrompt, step: ChainStep, target: LoadedPrompt) {
	if (target.chain) {
		result.diagnostics.push(
			createValidationDiagnostic(
				"invalid-chain-step-target",
				prompt.filePath,
				prompt.source,
				`Prompt template ${prompt.filePath} references chain step template ${JSON.stringify(step.name)}, but chain steps cannot target another chain template (${target.filePath}).`,
			),
		);
	}
}

function validateParallelChainStepFlags(result: PromptValidationResult, prompt: LoadedPrompt, step: ChainStep) {
	if (step.loopCount !== undefined) {
		result.diagnostics.push(
			createValidationDiagnostic(
				"invalid-parallel-chain-step-flag",
				prompt.filePath,
				prompt.source,
				`Prompt template ${prompt.filePath} references parallel chain step template ${JSON.stringify(step.name)}, but parallel() steps do not support per-task --loop.`,
			),
		);
	}

	if (step.withContext === true) {
		result.diagnostics.push(
			createValidationDiagnostic(
				"invalid-parallel-chain-step-flag",
				prompt.filePath,
				prompt.source,
				`Prompt template ${prompt.filePath} references parallel chain step template ${JSON.stringify(step.name)}, but parallel() steps do not support per-task --with-context.`,
			),
		);
	}
}

function validateParallelRuntimeSettings(cwd: string, result: PromptValidationResult, prompts: ReturnType<typeof loadPromptsWithModel>["prompts"], prompt: LoadedPrompt, steps: ChainStep[]) {
	const targets = steps
		.map((step) => ({ step, target: prompts.get(step.name) }))
		.filter((entry): entry is { step: ChainStep; target: LoadedPrompt } => entry.target !== undefined && !entry.target.chain);

	const runtimeDelegatableTargets = targets;
	if (targets.length < 2) return;

	if (runtimeDelegatableTargets.length >= 2) {
		const inheritModes = new Set(runtimeDelegatableTargets.map((entry) => entry.target.inheritContext === true ? "fork" : "fresh"));
		if (inheritModes.size > 1) {
			result.diagnostics.push(
				createValidationDiagnostic(
					"parallel-inherit-context-mismatch",
					prompt.filePath,
					prompt.source,
					`Prompt template ${prompt.filePath} references parallel delegated chain steps with mixed inheritContext modes: ${runtimeDelegatableTargets.map((entry) => `${entry.step.name}=${entry.target.inheritContext === true ? "fork" : "fresh"}`).join(", ")}.`,
				),
			);
		}
	}

	if (prompt.worktree === true) {
		const effectiveCwds = new Set(targets.map((entry) => prompt.cwd ?? entry.target.cwd ?? cwd));
		if (effectiveCwds.size > 1) {
			result.diagnostics.push(
				createValidationDiagnostic(
					"parallel-worktree-mixed-cwd",
					prompt.filePath,
					prompt.source,
					`Prompt template ${prompt.filePath} uses worktree: true, but parallel() step cwd values differ: ${Array.from(effectiveCwds).join(", ")}.`,
				),
			);
		}
	}
}

function validateParsedChainStepTargets(cwd: string, result: PromptValidationResult, prompts: ReturnType<typeof loadPromptsWithModel>["prompts"], prompt: LoadedPrompt, steps: ChainStepOrParallel[]) {
	for (const step of steps) {
		if ("parallel" in step) {
			for (const parallelStep of step.parallel) {
				validateParallelChainStepFlags(result, prompt, parallelStep);
				const target = prompts.get(parallelStep.name);
				if (!target) continue;
				validateChainStepTarget(result, prompt, parallelStep, target);
			}
			validateParallelRuntimeSettings(cwd, result, prompts, prompt, step.parallel);
			continue;
		}

		const target = prompts.get(step.name);
		if (!target) continue;
		validateChainStepTarget(result, prompt, step, target);
	}
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

		const missingTemplates = flattenChainSteps(parsedChain.steps).filter((step) => !prompts.has(step.name));
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

		validateParsedChainStepTargets(cwd, result, prompts, prompt, parsedChain.steps);
	}
}

function validateComparePrompts(cwd: string, result: PromptValidationResult, prompts: ReturnType<typeof loadPromptsWithModel>["prompts"]) {
	const catalogByCwd = new Map<string, ReturnType<typeof loadBestOfNPresetCatalog>>();
	function catalogFor(catalogCwd: string) {
		const key = resolvePath(catalogCwd);
		let catalog = catalogByCwd.get(key);
		if (!catalog) {
			catalog = loadBestOfNPresetCatalog(catalogCwd);
			catalogByCwd.set(key, catalog);
			result.diagnostics.push(...catalog.diagnostics);
		}
		return catalog;
	}
	for (const prompt of prompts.values()) {
		if (prompt.preset) {
			const presetCatalog = catalogFor(prompt.cwd ?? cwd);
			if (!presetCatalog.presets.has(prompt.preset)) {
				result.diagnostics.push(
					createValidationDiagnostic(
						"best-of-n-preset-not-found",
						prompt.filePath,
						prompt.source,
						`Prompt template ${prompt.filePath} references missing best-of-N preset ${JSON.stringify(prompt.preset)}.`,
					),
				);
			}
		}

		if (prompt.finalApplier && prompt.worktree !== true) {
			result.diagnostics.push(
				createValidationDiagnostic(
					"compare-final-applier-requires-worktree",
					prompt.filePath,
					prompt.source,
					`Prompt template ${prompt.filePath} uses bestOfN.finalApplier, but finalApplier requires bestOfN.worktree: true.`,
				),
			);
		}

		if (prompt.worktree !== true || !prompt.workers || prompt.workers.length < 2) continue;
		const workerCwds = new Set(prompt.workers.map((worker) => worker.cwd ?? prompt.cwd ?? cwd));
		if (workerCwds.size <= 1) continue;
		result.diagnostics.push(
			createValidationDiagnostic(
				"compare-worktree-mixed-worker-cwd",
				prompt.filePath,
				prompt.source,
				`Prompt template ${prompt.filePath} uses bestOfN.worktree: true, but worker cwd values differ: ${Array.from(workerCwds).join(", ")}.`,
			),
		);
	}
}

function validatePromptSkills(cwd: string, result: PromptValidationResult, prompts: ReturnType<typeof loadPromptsWithModel>["prompts"], options: PromptValidationOptions) {
	const registeredSkills = collectRegisteredSkillCandidates(options.registeredSkills);
	const filesystemSkillNames = collectFilesystemSkillNames(cwd);

	for (const prompt of prompts.values()) {
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
			if (validateFilesystemSkillReference(cwd, prompt.source, skillName, result)) continue;

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
	"invalid-best-of-n",
	"invalid-boomerang",
	"invalid-boomerang-chain",
	"invalid-chain",
	"invalid-chain-context",
	"invalid-chain-declaration",
	"invalid-compare-frontmatter",
	"invalid-compare-skills",
	"invalid-converge",
	"invalid-cwd",
	"invalid-deterministic",
	"invalid-deterministic-chain",
	"invalid-deterministic-env",
	"invalid-deterministic-handoff",
	"invalid-deterministic-loop",
	"invalid-deterministic-mixed-shorthand",
	"invalid-deterministic-non-interactive",
	"invalid-deterministic-parallel",
	"invalid-deterministic-run",
	"invalid-deterministic-script",
	"invalid-deterministic-subagent",
	"invalid-deterministic-timeout",
	"invalid-final-applier",
	"invalid-fresh",
	"invalid-inherit-context",
	"invalid-lineup-chain",
	"invalid-lineup-parallel",
	"invalid-lineup-subagent",
	"invalid-loop",
	"duplicate-command-name",
	"empty-chain",
	"empty-model",
	"invalid-model",
	"invalid-model-spec",
	"invalid-parallel",
	"invalid-restore",
	"invalid-rotate",
	"invalid-skills",
	"invalid-subagent",
	"invalid-subagent-chain",
	"invalid-worktree",
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
	const loaded = loadPromptsWithModel(cwd, true);
	const sourceRecordResult = collectPromptSourceRecords(cwd, true);
	const includeGraphs = collectValidationIncludeGraphs(sourceRecordResult.records, loaded);
	const result: PromptValidationResult = {
		ok: loaded.diagnostics.length === 0,
		promptCount: loaded.prompts.size,
		sourceSummary: collectValidationSourceSummary(sourceRecordResult.records, sourceRecordResult.inventoryRecords, loaded, includeGraphs),
		diagnostics: [...loaded.diagnostics],
		includeGraphs,
	};

	validatePromptChains(cwd, result, loaded.prompts);
	validateComparePrompts(cwd, result, loaded.prompts);
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

export function formatPromptValidationReport(result: PromptValidationResult): string {
	const includeGraphLines = formatIncludeGraphSection(result.includeGraphs);
	const sourceSummaryLine = formatSourceSummary(result.sourceSummary);
	if (result.ok) {
		return [
			`[pi-prompt-template-model-enhanced] Prompt validation passed: ${result.promptCount} prompt template(s) loaded.`,
			sourceSummaryLine,
			...includeGraphLines,
		].join("\n");
	}

	const diagnostics = sortDiagnostics(result.diagnostics);
	const lines = diagnostics.map((diagnostic) => `- ${sanitizeReportValue(diagnostic.code)} (${sanitizeReportValue(diagnostic.source)}) ${sanitizeReportValue(diagnostic.filePath)}: ${sanitizeReportValue(diagnostic.message)}`);
	return [
		`[pi-prompt-template-model-enhanced] Prompt validation failed: ${diagnostics.length} issue(s) found across ${result.promptCount} loaded prompt template(s).`,
		sourceSummaryLine,
		...lines,
		...includeGraphLines,
	].join("\n");
}
