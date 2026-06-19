import { parseChainDeclaration, type ChainStep, type ChainStepOrParallel } from "./chain-parser.js";
import { discoverFilesystemSkills, loadPromptsWithModel, readSkillContent, resolveSkillPath, type PromptLoaderDiagnostic, type PromptSource } from "./prompt-loader.js";

export interface RegisteredPromptSkill {
	skillName: string;
	skillPath?: string;
}

export interface PromptValidationOptions {
	registeredSkills?: RegisteredPromptSkill[];
}

export interface PromptValidationResult {
	ok: boolean;
	promptCount: number;
	diagnostics: PromptLoaderDiagnostic[];
}

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
	for (const prompt of prompts.values()) {
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

export function validatePromptTemplates(cwd: string, options: PromptValidationOptions = {}): PromptValidationResult {
	const loaded = loadPromptsWithModel(cwd, true);
	const result: PromptValidationResult = {
		ok: loaded.diagnostics.length === 0,
		promptCount: loaded.prompts.size,
		diagnostics: [...loaded.diagnostics],
	};

	validatePromptChains(cwd, result, loaded.prompts);
	validateComparePrompts(cwd, result, loaded.prompts);
	validatePromptSkills(cwd, result, loaded.prompts, options);
	result.ok = result.diagnostics.length === 0;
	return result;
}

export function formatPromptValidationReport(result: PromptValidationResult): string {
	if (result.ok) {
		return `[pi-prompt-template-model-enhanced] Prompt validation passed: ${result.promptCount} prompt template(s) loaded.`;
	}

	const diagnostics = [...result.diagnostics].sort((a, b) => lexicalCompare(a.filePath, b.filePath) || lexicalCompare(a.code, b.code) || lexicalCompare(a.message, b.message));
	const lines = diagnostics.map((diagnostic) => `- ${sanitizeReportValue(diagnostic.code)} (${sanitizeReportValue(diagnostic.source)}) ${sanitizeReportValue(diagnostic.filePath)}: ${sanitizeReportValue(diagnostic.message)}`);
	return [
		`[pi-prompt-template-model-enhanced] Prompt validation failed: ${diagnostics.length} issue(s) found across ${result.promptCount} loaded prompt template(s).`,
		...lines,
	].join("\n");
}
