import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { PromptBudgetConfig } from "./prompt-budget.js";
import { validatePromptInputReferences, validatePromptInputSchema, type PromptInputSchema } from "./prompt-inputs.js";
import { parseChainDeclaration, type ChainLimits, type StructuredChainStep } from "./chain-parser.js";
import {
	extractPromptInlineIncludes,
	hasPromptIncludeDirectives,
	hasPromptIncludesPlaceholder,
	renderPromptIncludes,
	type PromptIncludeGraph,
} from "./prompt-includes.js";

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const RESERVED_COMMAND_NAMES = new Set([
	"chain-prompts",
	"print-prompt",
	"dry-run-prompt",
	"prompt-tool",
	"validate-prompts",
	"settings",
	"model",
	"scoped-models",
	"export",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"tree",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
]);

const REMOVED_LEGACY_DELEGATION_FIELDS = [
	"parallel",
	"worktree",
	"commit",
	"preset",
] as const;

export type PromptSource = "user" | "project";
export type PromptRootKind = "prompts" | "prompt-library";

export interface DelegationLineupSlot {
	agent: string;
	model?: string;
	task?: string;
	taskSuffix?: string;
	cwd?: string;
	count?: number;
}

export interface BestOfNConfig {
	workers?: DelegationLineupSlot[];
	reviewers?: DelegationLineupSlot[];
	finalApplier?: DelegationLineupSlot;
}

interface PromptRoot {
	source: PromptSource;
	kind: PromptRootKind;
	dir: string;
	onlyFileName?: string;
	patterns?: string[];
	patternsBaseDir?: string;
	applyResourceIgnores?: boolean;
}

export type DeterministicHandoff = "always" | "never" | "on-success" | "on-failure";

export type DeterministicExecution =
	| { kind: "run"; command: string }
	| { kind: "command"; command: string; args: string[]; shell: boolean }
	| { kind: "script"; path: string; args: string[] };

export type DeterministicEnv = Record<string, string>;

export interface DeterministicStep {
	execution: DeterministicExecution;
	handoff: DeterministicHandoff;
	nonInteractive: boolean;
	timeoutMs?: number;
	cwd?: string;
	env?: DeterministicEnv;
}

export interface PromptWithModel {
	name: string;
	description: string;
	content: string;
	models: string[];
	budget?: PromptBudgetConfig;
	inputs?: PromptInputSchema;
	resolvedInputValues?: Record<string, string | boolean>;
	includes?: string[];
	chain?: string;
	adaptiveChain?: { steps: StructuredChainStep[]; limits: ChainLimits };
	chainContext?: "summary";
	restore: boolean;
	hidden?: boolean;
	skill?: string;
	skills?: string[];
	thinking?: ThinkingLevel;
	thinkingLevels?: ThinkingLevel[];
	rotate?: boolean;
	fresh?: boolean;
	loop?: number | null;
	converge?: boolean;
	boomerang?: boolean;
	bestOfN?: BestOfNConfig;
	deterministic?: DeterministicStep;
	subagent?: true | string;
	inheritContext?: boolean;
	cwd?: string;
	source: PromptSource;
	rootKind: PromptRootKind;
	subdir?: string;
	filePath: string;
	includeGraph?: PromptIncludeGraph;
}

export interface PromptLoaderDiagnostic {
	code: string;
	message: string;
	filePath: string;
	source: PromptSource;
	key: string;
}

export interface LoadPromptsWithModelResult {
	prompts: Map<string, PromptWithModel>;
	diagnostics: PromptLoaderDiagnostic[];
}

export interface LoadPromptsWithModelOptions {
	/** Include parsed adaptive-chain wrappers for adaptive-aware consumers. Defaults to false. */
	includeAdaptiveChains?: boolean;
	/** Load project-local prompt roots only when the current Pi session trusts the project. Defaults to true. */
	projectTrusted?: boolean;
}

export interface ResolveSkillPathOptions {
	/** Search project-local skill roots only when the current Pi session trusts the project. Defaults to true. */
	includeProjectSkills?: boolean;
}

export interface PromptSourceRecord {
	promptName: string;
	filePath: string;
	promptRoot: string;
	cwd: string;
	source: PromptSource;
	rootKind: PromptRootKind;
	promptCapable: boolean;
	rawBody: string;
	includes?: string[];
	hasInlineIncludes: boolean;
	hasIncludesPlaceholder: boolean;
	isChainWrapper: boolean;
	/** True only when the original declaration used the structured chain array shape. */
	isStructuredChainDeclaration?: boolean;
	hidden?: boolean;
	includeMetadataInvalid?: boolean;
	skippedReason?: string;
}

export interface CollectPromptSourceRecordsResult {
	records: PromptSourceRecord[];
	inventoryRecords: PromptSourceRecord[];
	diagnostics: PromptLoaderDiagnostic[];
}

/** Select one canonical inventory record per name using the loader's root/layer precedence. */
export function selectEffectivePromptSourceRecords(records: readonly PromptSourceRecord[]): Map<string, PromptSourceRecord> {
	const selected = new Map<string, PromptSourceRecord>();
	for (const record of records) {
		// Inventory retains these for validation, but they can never own a command name.
		if (record.skippedReason || RESERVED_COMMAND_NAMES.has(record.promptName)) continue;
		const existing = selected.get(record.promptName);
		// Inventory is already in root-priority and lexical traversal order: first in
		// one source layer wins, while the project layer canonically replaces user.
		if (!existing || (existing.source === "user" && record.source === "project")) selected.set(record.promptName, record);
	}
	return selected;
}

function createDiagnostic(
	code: string,
	filePath: string,
	source: PromptSource,
	message: string,
): PromptLoaderDiagnostic {
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

function normalizeStringField(
	field: string,
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				`invalid-${field}`,
				filePath,
				source,
				`Ignoring invalid ${field} value in ${filePath}: expected a string.`,
			),
		);
		return undefined;
	}

	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function isFrontmatterRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePromptBudget(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): { ok: true; budget?: PromptBudgetConfig } | { ok: false } {
	if (value === undefined) return { ok: true };
	if (!isFrontmatterRecord(value)) {
		diagnostics.push(createDiagnostic("invalid-budget", filePath, source, `Skipping prompt template at ${filePath}: frontmatter field "budget" must be an object.`));
		return { ok: false };
	}
	if (Object.keys(value).some((key) => key !== "warnTokens" && key !== "maxTokens")) {
		diagnostics.push(createDiagnostic("invalid-budget", filePath, source, `Skipping prompt template at ${filePath}: frontmatter field "budget" only supports "warnTokens" and "maxTokens".`));
		return { ok: false };
	}
	const validLimit = (limit: unknown) => limit === undefined || (Number.isSafeInteger(limit) && Number(limit) > 0);
	if (!validLimit(value.warnTokens) || !validLimit(value.maxTokens)) {
		diagnostics.push(createDiagnostic("invalid-budget", filePath, source, `Skipping prompt template at ${filePath}: budget limits must be positive safe integers.`));
		return { ok: false };
	}
	const warnTokens = value.warnTokens as number | undefined;
	const maxTokens = value.maxTokens as number | undefined;
	if (warnTokens === undefined && maxTokens === undefined) {
		diagnostics.push(createDiagnostic("invalid-budget", filePath, source, `Skipping prompt template at ${filePath}: budget must set "warnTokens" and/or "maxTokens".`));
		return { ok: false };
	}
	if (warnTokens !== undefined && maxTokens !== undefined && warnTokens > maxTokens) {
		diagnostics.push(createDiagnostic("invalid-budget", filePath, source, `Skipping prompt template at ${filePath}: budget.warnTokens cannot exceed budget.maxTokens.`));
		return { ok: false };
	}
	return { ok: true, budget: { ...(warnTokens !== undefined ? { warnTokens } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}) } };
}

function normalizePromptInputs(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): { ok: true; inputs?: PromptInputSchema } | { ok: false } {
	if (value === undefined) return { ok: true };
	const errors = validatePromptInputSchema(value);
	if (errors.length > 0 || !isFrontmatterRecord(value)) {
		for (const error of errors.length > 0 ? errors : ["inputs must be a mapping"]) {
			diagnostics.push(createDiagnostic("invalid-inputs", filePath, source, `Skipping prompt template at ${filePath}: ${error}.`));
		}
		return { ok: false };
	}
	return { ok: true, inputs: value as PromptInputSchema };
}

function isValidModelSelectionSpec(spec: string): boolean {
	if (!spec || spec.includes("*") || /\s/.test(spec)) return false;

	const slashIndex = spec.indexOf("/");
	if (slashIndex === -1) return true;
	if (slashIndex === 0) return false;
	const modelId = spec.slice(slashIndex + 1);
	if (modelId.length === 0) return false;
	if (modelId.split("/").some((segment) => segment.length === 0)) return false;
	return true;
}

function normalizeFrontmatterRecord(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): Record<string, unknown> | undefined {
	if (isFrontmatterRecord(value)) {
		return value;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-frontmatter",
			filePath,
			source,
			`Skipping prompt template at ${filePath}: frontmatter must be a key-value object.`,
		),
	);
	return undefined;
}

function normalizeModelSpecs(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				"invalid-model",
				filePath,
				source,
				`Skipping prompt template at ${filePath}: frontmatter field "model" must be a string.`,
			),
		);
		return undefined;
	}

	const models = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

	if (models.length === 0) {
		diagnostics.push(
			createDiagnostic(
				"empty-model",
				filePath,
				source,
				`Skipping prompt template at ${filePath}: frontmatter field "model" is empty.`,
			),
		);
		return undefined;
	}

	const invalidSpec = models.find((model) => !isValidModelSelectionSpec(model));
	if (invalidSpec) {
		diagnostics.push(
			createDiagnostic(
				"invalid-model-spec",
				filePath,
				source,
				`Skipping prompt template at ${filePath}: invalid model spec ${JSON.stringify(invalidSpec)} in frontmatter field "model".`,
			),
		);
		return undefined;
	}

	return models;
}

function normalizeRestore(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return true;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-restore",
			filePath,
			source,
			`Using default restore=true for ${filePath}: frontmatter field "restore" must be true or false.`,
		),
	);
	return true;
}

function normalizeFresh(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-fresh",
			filePath,
			source,
			`Using default fresh=false for ${filePath}: frontmatter field "fresh" must be true or false.`,
		),
	);
	return false;
}

function normalizeHidden(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-hidden",
			filePath,
			source,
			`Using default hidden=false for ${filePath}: frontmatter field "hidden" must be true or false.`,
		),
	);
	return false;
}

function normalizeRotate(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-rotate",
			filePath,
			source,
			`Using default rotate=false for ${filePath}: frontmatter field "rotate" must be true or false.`,
		),
	);
	return false;
}

function normalizeBoomerang(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-boomerang",
			filePath,
			source,
			`Using default boomerang=false for ${filePath}: frontmatter field "boomerang" must be true or false.`,
		),
	);
	return false;
}

function normalizeLoop(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): number | null | undefined {
	if (value === undefined) return undefined;

	if (value === true || (typeof value === "string" && value.trim().toLowerCase() === "unlimited")) {
		return null;
	}

	let normalizedValue: number | undefined;
	if (typeof value === "number") {
		normalizedValue = value;
	} else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		normalizedValue = parseInt(value.trim(), 10);
	}

	if (normalizedValue !== undefined && Number.isInteger(normalizedValue) && normalizedValue >= 1 && normalizedValue <= 999) {
		return normalizedValue;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-loop",
			filePath,
			source,
			`Ignoring invalid loop value in ${filePath}: frontmatter field "loop" must be an integer between 1 and 999, true, or "unlimited".`,
		),
	);
	return undefined;
}

function normalizeStringArrayField(
	field: string,
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		diagnostics.push(
			createDiagnostic(
				`invalid-${field}`,
				filePath,
				source,
				`Ignoring invalid ${field} value in ${filePath}: expected an array of strings.`,
			),
		);
		return undefined;
	}

	const args: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			diagnostics.push(
				createDiagnostic(
					`invalid-${field}`,
					filePath,
					source,
					`Ignoring invalid ${field} value in ${filePath}: expected an array of strings.`,
				),
			);
			return undefined;
		}
		args.push(entry);
	}
	return args;
}

const VALID_EXACT_SKILL_NAME = /^[A-Za-z0-9._-]+$/;
const VALID_SUFFIX_WILDCARD_SKILL_SELECTOR = /^[A-Za-z0-9._-]+\*$/;

function normalizeSkillName(raw: string): string {
	const trimmed = raw.trim();
	return trimmed.startsWith("skill:") ? trimmed.slice("skill:".length).trim() : trimmed;
}

function isValidSkillNameOrSelector(value: string): boolean {
	return VALID_EXACT_SKILL_NAME.test(value) || VALID_SUFFIX_WILDCARD_SKILL_SELECTOR.test(value);
}

function invalidSkillNameMessage(field: "skill" | "skills", value: string): string {
	if (value.includes("*")) {
		return `frontmatter field "${field}" contains invalid skill wildcard ${JSON.stringify(value)}: only non-empty suffix "*" prefix matching is supported.`;
	}
	return `frontmatter field "${field}" contains invalid skill name ${JSON.stringify(value)}.`;
}

function pushInvalidSkillsDiagnostic(
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
	message: string,
) {
	diagnostics.push(createDiagnostic("invalid-skills", filePath, source, `Skipping prompt template at ${filePath}: ${message}`));
}

type NormalizedSkills = { ok: true; skill?: string; skills?: string[] } | { ok: false };

function normalizePromptSkills(
	frontmatter: Record<string, unknown>,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): NormalizedSkills {
	const normalizedSkills: string[] = [];
	let normalizedSkill: string | undefined;

	if (Object.hasOwn(frontmatter, "skill")) {
		if (typeof frontmatter.skill !== "string") {
			pushInvalidSkillsDiagnostic(filePath, source, diagnostics, 'frontmatter field "skill" must be a non-empty string.');
			return { ok: false };
		}
		normalizedSkill = normalizeSkillName(frontmatter.skill);
		if (!normalizedSkill || !isValidSkillNameOrSelector(normalizedSkill)) {
			pushInvalidSkillsDiagnostic(filePath, source, diagnostics, invalidSkillNameMessage("skill", normalizedSkill));
			return { ok: false };
		}
		normalizedSkills.push(normalizedSkill);
	}

	if (Object.hasOwn(frontmatter, "skills")) {
		if (!Array.isArray(frontmatter.skills)) {
			pushInvalidSkillsDiagnostic(filePath, source, diagnostics, 'frontmatter field "skills" must be a YAML list of non-empty skill names. Use "skill" for a scalar single skill.');
			return { ok: false };
		}
		for (const entry of frontmatter.skills) {
			if (typeof entry !== "string") {
				pushInvalidSkillsDiagnostic(filePath, source, diagnostics, 'frontmatter field "skills" must be a YAML list of non-empty strings.');
				return { ok: false };
			}
			const normalized = normalizeSkillName(entry);
			if (!normalized || !isValidSkillNameOrSelector(normalized)) {
				pushInvalidSkillsDiagnostic(filePath, source, diagnostics, invalidSkillNameMessage("skills", normalized));
				return { ok: false };
			}
			normalizedSkills.push(normalized);
		}
	}

	return {
		ok: true,
		...(normalizedSkill ? { skill: normalizedSkill } : {}),
		...(normalizedSkills.length > 0 ? { skills: normalizedSkills } : {}),
	};
}

type NormalizedPromptIncludes =
	| { ok: true; includes: string[] | undefined; declaredKey?: "include" | "includes" }
	| { ok: false };

function normalizePromptIncludes(
	frontmatter: Record<string, unknown>,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): NormalizedPromptIncludes {
	const hasInclude = Object.hasOwn(frontmatter, "include");
	const hasIncludes = Object.hasOwn(frontmatter, "includes");
	if (!hasInclude && !hasIncludes) return { ok: true, includes: undefined };

	if (hasInclude && hasIncludes) {
		diagnostics.push(
			createDiagnostic(
				"invalid-includes-conflict",
				filePath,
				source,
				`Skipping prompt template at ${filePath}: frontmatter fields "include" and "includes" cannot be combined.`,
			),
		);
		return { ok: false };
	}

	if (hasInclude) {
		const value = frontmatter.include;
		if (typeof value !== "string" || value.trim().length === 0) {
			diagnostics.push(
				createDiagnostic(
					"invalid-include",
					filePath,
					source,
					`Skipping prompt template at ${filePath}: frontmatter field "include" must be a non-empty string.`,
				),
			);
			return { ok: false };
		}
		return { ok: true, includes: [value.trim()], declaredKey: "include" };
	}

	const value = frontmatter.includes;
	if (!Array.isArray(value)) {
		diagnostics.push(
			createDiagnostic(
				"invalid-includes",
				filePath,
				source,
				`Skipping prompt template at ${filePath}: frontmatter field "includes" must be an array of non-empty strings.`,
			),
		);
		return { ok: false };
	}

	const includes: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			diagnostics.push(
				createDiagnostic(
					"invalid-includes",
					filePath,
					source,
					`Skipping prompt template at ${filePath}: frontmatter field "includes" must be an array of non-empty strings.`,
				),
			);
			return { ok: false };
		}
		includes.push(entry.trim());
	}

	return { ok: true, includes, declaredKey: "includes" };
}

function normalizeDeterministicHandoff(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): DeterministicHandoff {
	if (value === undefined) return "always";
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "always" || normalized === "never" || normalized === "on-success" || normalized === "on-failure") {
			return normalized;
		}
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-deterministic-handoff",
			filePath,
			source,
			`Using default deterministic handoff=always for ${filePath}: expected "always", "never", "on-success", or "on-failure".`,
		),
	);
	return "always";
}

function normalizeTimeoutMs(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): number | undefined {
	if (value === undefined) return undefined;
	let timeoutMs: number | undefined;
	if (typeof value === "number") timeoutMs = value;
	if (typeof value === "string" && /^\d+$/.test(value.trim())) timeoutMs = parseInt(value.trim(), 10);
	if (timeoutMs !== undefined && Number.isInteger(timeoutMs) && timeoutMs >= 1) return timeoutMs;

	diagnostics.push(
		createDiagnostic(
			"invalid-deterministic-timeout",
			filePath,
			source,
			`Ignoring invalid deterministic timeout in ${filePath}: expected an integer greater than or equal to 1 (milliseconds).`,
		),
	);
	return undefined;
}

function normalizeDeterministicEnv(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): DeterministicEnv | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-env",
				filePath,
				source,
				`Ignoring invalid deterministic env in ${filePath}: expected an object with string/number/boolean values.`,
			),
		);
		return undefined;
	}

	const env: DeterministicEnv = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!key.trim()) {
			diagnostics.push(
				createDiagnostic(
					"invalid-deterministic-env",
					filePath,
					source,
					`Ignoring invalid deterministic env in ${filePath}: env keys must be non-empty strings.`,
				),
			);
			return undefined;
		}
		if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
			diagnostics.push(
				createDiagnostic(
					"invalid-deterministic-env",
					filePath,
					source,
					`Ignoring invalid deterministic env in ${filePath}: env value for ${JSON.stringify(key)} must be a string, number, or boolean.`,
				),
			);
			return undefined;
		}
		env[key] = String(raw);
	}

	return Object.keys(env).length > 0 ? env : undefined;
}

function normalizeDeterministicNonInteractive(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return true;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-deterministic-non-interactive",
			filePath,
			source,
			`Using default deterministic nonInteractive=true for ${filePath}: expected true or false.`,
		),
	);
	return true;
}

function normalizeDeterministicRunValue(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): DeterministicExecution | undefined {
	if (typeof value === "string") {
		const command = value.trim();
		if (command) return { kind: "run", command };
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-run",
				filePath,
				source,
				`Ignoring invalid deterministic run value in ${filePath}: expected a non-empty string or an object with command/args.`,
			),
		);
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-run",
				filePath,
				source,
				`Ignoring invalid deterministic run value in ${filePath}: expected a non-empty string or an object with command/args.`,
			),
		);
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const command = normalizeStringField("deterministic.run.command", record.command, filePath, source, diagnostics);
	if (!command) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-run",
				filePath,
				source,
				`Ignoring invalid deterministic run value in ${filePath}: expected object field "command" to be a non-empty string.`,
			),
		);
		return undefined;
	}
	const args = normalizeStringArrayField("deterministic.run.args", record.args, filePath, source, diagnostics);
	if (!args) return undefined;
	let shell = false;
	if (record.shell !== undefined) {
		if (typeof record.shell === "boolean") {
			shell = record.shell;
		} else {
			diagnostics.push(
				createDiagnostic(
					"invalid-deterministic-run",
					filePath,
					source,
					`Ignoring invalid deterministic run value in ${filePath}: object field "shell" must be true or false.`,
				),
			);
			return undefined;
		}
	}
	return { kind: "command", command, args, shell };
}

function normalizeDeterministicScriptValue(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): DeterministicExecution | undefined {
	if (typeof value === "string") {
		const path = value.trim();
		if (path) return { kind: "script", path, args: [] };
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-script",
				filePath,
				source,
				`Ignoring invalid deterministic script value in ${filePath}: expected a non-empty string or an object with path/args.`,
			),
		);
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-script",
				filePath,
				source,
				`Ignoring invalid deterministic script value in ${filePath}: expected a non-empty string or an object with path/args.`,
			),
		);
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const path = normalizeStringField("deterministic.script.path", record.path, filePath, source, diagnostics);
	if (!path) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-script",
				filePath,
				source,
				`Ignoring invalid deterministic script value in ${filePath}: expected object field "path" to be a non-empty string.`,
			),
		);
		return undefined;
	}
	const args = normalizeStringArrayField("deterministic.script.args", record.args, filePath, source, diagnostics);
	if (!args) return undefined;
	return { kind: "script", path, args };
}

function normalizeDeterministic(
	frontmatter: Record<string, unknown>,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): DeterministicStep | undefined {
	const hasNested = Object.hasOwn(frontmatter, "deterministic");
	const hasRun = Object.hasOwn(frontmatter, "run");
	const hasScript = Object.hasOwn(frontmatter, "script");
	const hasHandoff = Object.hasOwn(frontmatter, "handoff");
	const hasTimeout = Object.hasOwn(frontmatter, "timeout");
	const hasEnv = Object.hasOwn(frontmatter, "env");
	const hasNonInteractive = Object.hasOwn(frontmatter, "nonInteractive");
	if (!hasNested && !hasRun && !hasScript && !hasHandoff && !hasTimeout && !hasEnv && !hasNonInteractive) return undefined;

	if (hasNested && (hasRun || hasScript || hasHandoff || hasTimeout || hasEnv || hasNonInteractive)) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic-mixed-shorthand",
				filePath,
				source,
				`Ignoring top-level deterministic shorthand in ${filePath}: use either "deterministic" or top-level run/script/handoff/timeout/env/nonInteractive, not both.`,
			),
		);
	}

	let record: Record<string, unknown>;
	if (hasNested) {
		const raw = frontmatter.deterministic;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			diagnostics.push(
				createDiagnostic(
					"invalid-deterministic",
					filePath,
					source,
					`Ignoring invalid deterministic config in ${filePath}: frontmatter field "deterministic" must be an object.`,
				),
			);
			return undefined;
		}
		record = raw as Record<string, unknown>;
	} else {
		record = {
			run: frontmatter.run,
			script: frontmatter.script,
			handoff: frontmatter.handoff,
			timeout: frontmatter.timeout,
			env: frontmatter.env,
			nonInteractive: frontmatter.nonInteractive,
		};
	}

	const runValue = Object.hasOwn(record, "run") ? record.run : undefined;
	const scriptValue = Object.hasOwn(record, "script") ? record.script : undefined;
	if (runValue !== undefined && scriptValue !== undefined) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic",
				filePath,
				source,
				`Ignoring deterministic config in ${filePath}: "run" and "script" cannot be declared together.`,
			),
		);
		return undefined;
	}

	const execution = runValue !== undefined
		? normalizeDeterministicRunValue(runValue, filePath, source, diagnostics)
		: scriptValue !== undefined
			? normalizeDeterministicScriptValue(scriptValue, filePath, source, diagnostics)
			: undefined;
	if (!execution) {
		diagnostics.push(
			createDiagnostic(
				"invalid-deterministic",
				filePath,
				source,
				`Ignoring deterministic config in ${filePath}: expected either "run" or "script".`,
			),
		);
		return undefined;
	}

	const handoff = normalizeDeterministicHandoff(record.handoff, filePath, source, diagnostics);
	const timeoutMs = normalizeTimeoutMs(record.timeout, filePath, source, diagnostics);
	const cwd = normalizeCwd(record.cwd, filePath, source, diagnostics);
	const env = normalizeDeterministicEnv(record.env, filePath, source, diagnostics);
	const nonInteractive = normalizeDeterministicNonInteractive(record.nonInteractive, filePath, source, diagnostics);
	return {
		execution,
		handoff,
		nonInteractive,
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(cwd ? { cwd } : {}),
		...(env ? { env } : {}),
	};
}

function normalizeConverge(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return true;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-converge",
			filePath,
			source,
			`Using default converge=true for ${filePath}: frontmatter field "converge" must be true or false.`,
		),
	);
	return true;
}

function normalizeLineupSlot(
	value: unknown,
	field: "workers" | "reviewers" | "finalApplier",
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
	index: number,
): DelegationLineupSlot | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		diagnostics.push(createDiagnostic(`invalid-${field}`, filePath, source, `Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} must be an object.`));
		return undefined;
	}
	const slot = value as Record<string, unknown>;
	const allowedKeys = new Set(["agent", "subagent", "model", "task", "taskSuffix", "cwd", "count"]);
	const unknownKeys = Object.keys(slot).filter((key) => !allowedKeys.has(key));
	if (unknownKeys.length > 0) {
		diagnostics.push(createDiagnostic(`invalid-${field}`, filePath, source, `Skipping prompt template at ${filePath}: ${field} slot ${index + 1} contains unsupported field(s): ${unknownKeys.join(", ")}.`));
		return undefined;
	}
	if (slot.agent !== undefined && slot.subagent !== undefined) {
		diagnostics.push(createDiagnostic(`invalid-${field}`, filePath, source, `Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} cannot combine "agent" and "subagent".`));
		return undefined;
	}
	let agent: string | undefined;
	if (typeof slot.agent === "string" && slot.agent.trim()) agent = slot.agent.trim();
	else if (slot.agent !== undefined) {
		diagnostics.push(createDiagnostic(`invalid-${field}`, filePath, source, `Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} requires a non-empty string "agent".`));
		return undefined;
	}
	if (!agent && slot.subagent !== undefined) {
		if (slot.subagent === true) agent = field === "reviewers" ? "reviewer" : "delegate";
		else if (typeof slot.subagent === "string" && slot.subagent.trim()) agent = slot.subagent.trim();
		else {
			diagnostics.push(createDiagnostic(`invalid-${field}`, filePath, source, `Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} requires "subagent" to be true or a non-empty string.`));
			return undefined;
		}
	}
	if (!agent) {
		diagnostics.push(createDiagnostic(`invalid-${field}`, filePath, source, `Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} requires "agent" or "subagent".`));
		return undefined;
	}
	const normalized: DelegationLineupSlot = { agent };
	if (slot.model !== undefined) {
		if (typeof slot.model !== "string" || !slot.model.trim() || !isValidModelSelectionSpec(slot.model.trim())) {
			diagnostics.push(createDiagnostic(`invalid-${field}`, filePath, source, `Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} has an invalid "model".`));
			return undefined;
		}
		normalized.model = slot.model.trim();
	}
	for (const key of ["task", "taskSuffix"] as const) {
		if (slot[key] === undefined) continue;
		if (typeof slot[key] !== "string") {
			diagnostics.push(createDiagnostic(`invalid-${field}`, filePath, source, `Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} has a non-string "${key}".`));
			return undefined;
		}
		const valueText = slot[key].trim();
		if (valueText) normalized[key] = valueText;
	}
	if (slot.cwd !== undefined) {
		if (typeof slot.cwd !== "string") {
			diagnostics.push(createDiagnostic(`invalid-${field}`, filePath, source, `Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} has a non-string "cwd".`));
			return undefined;
		}
		const cwd = slot.cwd.trim();
		if (cwd) {
			const expanded = expandCwdPath(cwd);
			if (!expanded) {
				diagnostics.push(createDiagnostic(`invalid-${field}`, filePath, source, `Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} "cwd" must be an absolute path.`));
				return undefined;
			}
			normalized.cwd = expanded;
		}
	}
	if (slot.count !== undefined) {
		const count = typeof slot.count === "number" ? slot.count : typeof slot.count === "string" && /^\d+$/.test(slot.count.trim()) ? Number(slot.count.trim()) : NaN;
		if (!Number.isSafeInteger(count) || count < 1) {
			diagnostics.push(createDiagnostic(`invalid-${field}`, filePath, source, `Ignoring invalid ${field} value in ${filePath}: slot ${index + 1} "count" must be a safe integer greater than or equal to 1.`));
			return undefined;
		}
		normalized.count = count;
	}
	return normalized;
}

function normalizeLineup(
	value: unknown,
	field: "workers" | "reviewers",
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): DelegationLineupSlot[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0) {
		diagnostics.push(createDiagnostic(`invalid-${field}`, filePath, source, `Ignoring invalid ${field} value in ${filePath}: expected a non-empty array of slot objects.`));
		return undefined;
	}
	const slots: DelegationLineupSlot[] = [];
	for (let index = 0; index < value.length; index++) {
		const slot = normalizeLineupSlot(value[index], field, filePath, source, diagnostics, index);
		if (!slot) return undefined;
		slots.push(slot);
	}
	return slots;
}

function normalizeFinalApplier(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): DelegationLineupSlot | undefined {
	if (value === undefined) return undefined;
	const slot = normalizeLineupSlot(value, "finalApplier", filePath, source, diagnostics, 0);
	if (!slot) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.count !== undefined || raw.cwd !== undefined) {
		diagnostics.push(createDiagnostic("invalid-finalApplier", filePath, source, `Ignoring invalid finalApplier value in ${filePath}: "count" and "cwd" are not supported.`));
		return undefined;
	}
	return slot;
}

function normalizeBestOfN(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): BestOfNConfig | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		diagnostics.push(createDiagnostic("invalid-best-of-n", filePath, source, `Ignoring invalid bestOfN value in ${filePath}: frontmatter field "bestOfN" must be an object.`));
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const allowedKeys = new Set(["workers", "reviewers", "finalApplier"]);
	const unknownKeys = Object.keys(record).filter((key) => !allowedKeys.has(key));
	if (unknownKeys.length > 0) {
		diagnostics.push(createDiagnostic("invalid-best-of-n", filePath, source, `Skipping prompt template at ${filePath}: bestOfN contains unsupported field(s): ${unknownKeys.join(", ")}.`));
		return undefined;
	}
	const workers = normalizeLineup(record.workers, "workers", filePath, source, diagnostics);
	const reviewers = normalizeLineup(record.reviewers, "reviewers", filePath, source, diagnostics);
	const finalApplier = normalizeFinalApplier(record.finalApplier, filePath, source, diagnostics);
	if (record.workers !== undefined && !workers) return undefined;
	if (record.reviewers !== undefined && !reviewers) return undefined;
	if (record.finalApplier !== undefined && !finalApplier) return undefined;
	if (!workers || workers.length === 0) {
		diagnostics.push(createDiagnostic("invalid-best-of-n", filePath, source, `Ignoring invalid bestOfN value in ${filePath}: frontmatter field "bestOfN.workers" must contain at least one slot.`));
		return undefined;
	}
	return {
		workers,
		...(reviewers ? { reviewers } : {}),
		...(finalApplier ? { finalApplier } : {}),
	};
}

function normalizeSubagent(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): true | string | undefined {
	if (value === undefined) return undefined;
	if (value === true) return true;
	if (value === false) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				"invalid-subagent",
				filePath,
				source,
				`Ignoring invalid subagent value in ${filePath}: frontmatter field "subagent" must be true or a non-empty string.`,
			),
		);
		return undefined;
	}

	const normalized = value.trim();
	if (!normalized) {
		diagnostics.push(
			createDiagnostic(
				"invalid-subagent",
				filePath,
				source,
				`Ignoring invalid subagent value in ${filePath}: frontmatter field "subagent" must be true or a non-empty string.`,
			),
		);
		return undefined;
	}
	return normalized;
}

export function expandCwdPath(raw: string): string | undefined {
	const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
	return isAbsolute(expanded) ? expanded : undefined;
}

function normalizeCwd(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				"invalid-cwd",
				filePath,
				source,
				`Ignoring invalid cwd in ${filePath}: expected a string.`,
			),
		);
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const expanded = expandCwdPath(trimmed);
	if (!expanded) {
		diagnostics.push(
			createDiagnostic(
				"invalid-cwd",
				filePath,
				source,
				`Ignoring cwd in ${filePath}: must be an absolute path.`,
			),
		);
		return undefined;
	}
	return expanded;
}

function normalizeInheritContext(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-inherit-context",
			filePath,
			source,
			`Using default inheritContext=false for ${filePath}: frontmatter field "inheritContext" must be true or false.`,
		),
	);
	return false;
}

function normalizeChain(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): string | unknown[] | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) return value;
	if (typeof value !== "string") {
		diagnostics.push(
			createDiagnostic(
				"invalid-chain",
				filePath,
				source,
				`Ignoring invalid chain value in ${filePath}: frontmatter field "chain" must be a legacy string or structured array.`,
			),
		);
		return undefined;
	}

	const normalized = value.trim();
	if (normalized.length > 0) return normalized;

	diagnostics.push(
		createDiagnostic(
			"empty-chain",
			filePath,
			source,
			`Ignoring invalid chain value in ${filePath}: frontmatter field "chain" must be a non-empty string.`,
		),
	);
	return undefined;
}

function normalizeChainContext(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): "summary" | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "summary") return "summary";
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-chain-context",
			filePath,
			source,
			`Ignoring invalid chainContext value in ${filePath}: frontmatter field "chainContext" must be "summary".`,
		),
	);
	return undefined;
}

function normalizeThinking(
	value: unknown,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): ThinkingLevel | undefined {
	const thinking = normalizeStringField("thinking", value, filePath, source, diagnostics);
	if (thinking === undefined) return undefined;

	const normalized = thinking.toLowerCase();
	if ((VALID_THINKING_LEVELS as readonly string[]).includes(normalized)) {
		return normalized as ThinkingLevel;
	}

	diagnostics.push(
		createDiagnostic(
			"invalid-thinking",
			filePath,
			source,
			`Ignoring invalid thinking level in ${filePath}: ${JSON.stringify(thinking)}.`,
		),
	);
	return undefined;
}

function normalizeThinkingLevels(
	value: unknown,
	modelCount: number,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): ThinkingLevel[] | undefined {
	if (typeof value !== "string") return undefined;

	const levels = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

	const invalidLevel = levels.find((level) => !(VALID_THINKING_LEVELS as readonly string[]).includes(level.toLowerCase()));
	if (invalidLevel) {
		diagnostics.push(
			createDiagnostic(
				"invalid-thinking-levels",
				filePath,
				source,
				`Ignoring invalid thinking level in ${filePath}: ${JSON.stringify(invalidLevel)}.`,
			),
		);
		return undefined;
	}

	if (levels.length !== modelCount) {
		diagnostics.push(
			createDiagnostic(
				"invalid-thinking-level-count",
				filePath,
				source,
				`Ignoring comma-separated thinking levels in ${filePath}: expected ${modelCount} entries to match frontmatter field "model".`,
			),
		);
		return undefined;
	}

	return levels.map((level) => level.toLowerCase() as ThinkingLevel);
}

interface PromptRootDiscovery {
	roots: PromptRoot[];
	diagnostics: PromptLoaderDiagnostic[];
	patterns?: string[];
}

function expandSettingsPromptPath(value: string, baseDir: string): string {
	const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

function isSettingsPattern(value: string): boolean {
	return value.startsWith("!") || value.startsWith("+") || value.startsWith("-") || value.includes("*") || value.includes("?");
}

function loadSettingsPromptRoots(settingsPath: string, source: PromptSource, baseDir: string): PromptRootDiscovery {
	const diagnostics: PromptLoaderDiagnostic[] = [];
	if (!existsSync(settingsPath)) return { roots: [], diagnostics, patterns: [] };
	let settings: unknown;
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch (error) {
		diagnostics.push(createDiagnostic("invalid-settings-json", settingsPath, source, `Skipping prompt settings at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}.`));
		return { roots: [], diagnostics };
	}
	if (!isFrontmatterRecord(settings)) {
		diagnostics.push(createDiagnostic("invalid-settings", settingsPath, source, `Skipping prompt settings at ${settingsPath}: settings must be a JSON object.`));
		return { roots: [], diagnostics };
	}
	if (settings.prompts === undefined) return { roots: [], diagnostics };
	if (!Array.isArray(settings.prompts)) {
		diagnostics.push(createDiagnostic("invalid-settings-prompts", settingsPath, source, `Ignoring prompts in ${settingsPath}: expected "prompts" to be an array of strings.`));
		return { roots: [], diagnostics };
	}
	const paths: string[] = [];
	const patterns: string[] = [];
	for (const [index, entry] of settings.prompts.entries()) {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			diagnostics.push(createDiagnostic("invalid-settings-prompt-entry", settingsPath, source, `Ignoring prompts[${index}] in ${settingsPath}: expected a non-empty string.`));
			continue;
		}
		const value = entry.trim();
		if (isSettingsPattern(value)) patterns.push(value);
		else paths.push(value);
	}
	const roots: PromptRoot[] = [];
	for (const rawPath of paths) {
		const resolvedPath = expandSettingsPromptPath(rawPath, baseDir);
		if (!existsSync(resolvedPath)) {
			diagnostics.push(createDiagnostic("missing-prompt-path", resolvedPath, source, `Skipping configured prompt path ${JSON.stringify(rawPath)} from ${settingsPath}: resolved path ${resolvedPath} does not exist.`));
			continue;
		}
		try {
			const stats = statSync(resolvedPath);
			if (stats.isDirectory()) roots.push({ source, kind: "prompts", dir: resolvedPath, patterns, patternsBaseDir: baseDir, applyResourceIgnores: true });
			else if (stats.isFile() && resolvedPath.endsWith(".md")) roots.push({ source, kind: "prompts", dir: dirname(resolvedPath), onlyFileName: basename(resolvedPath), patterns, patternsBaseDir: baseDir });
			else diagnostics.push(createDiagnostic("invalid-prompt-path", resolvedPath, source, `Skipping configured prompt path ${JSON.stringify(rawPath)} from ${settingsPath}: expected a directory or .md file.`));
		} catch (error) {
			diagnostics.push(createDiagnostic("unreadable-prompt-path", resolvedPath, source, `Skipping configured prompt path ${JSON.stringify(rawPath)} from ${settingsPath}: ${error instanceof Error ? error.message : String(error)}.`));
		}
	}
	return { roots, diagnostics, patterns };
}

function normalizeSettingsPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return normalized.replace(/\\/g, "/");
}

function matchesSettingsPattern(filePath: string, pattern: string, baseDir: string): boolean {
	const normalizedPattern = pattern.replace(/\\/g, "/");
	const candidates = [
		relative(baseDir, filePath).replace(/\\/g, "/"),
		basename(filePath),
		filePath.replace(/\\/g, "/"),
	];
	return candidates.some((candidate) => minimatch(candidate, normalizedPattern));
}

function matchesExactSettingsPattern(filePath: string, pattern: string, baseDir: string): boolean {
	const normalizedPattern = normalizeSettingsPattern(pattern);
	const relativePath = relative(baseDir, filePath).replace(/\\/g, "/");
	return normalizedPattern === relativePath || normalizedPattern === filePath.replace(/\\/g, "/");
}

function matchesSettingsPatterns(filePath: string, patterns: readonly string[], baseDir: string): boolean {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];

	for (const pattern of patterns) {
		if (pattern.startsWith("+")) forceIncludes.push(pattern.slice(1));
		else if (pattern.startsWith("-")) forceExcludes.push(pattern.slice(1));
		else if (pattern.startsWith("!")) excludes.push(pattern.slice(1));
		else includes.push(pattern);
	}

	let enabled = includes.length === 0 || includes.some((pattern) => matchesSettingsPattern(filePath, pattern, baseDir));
	if (excludes.some((pattern) => matchesSettingsPattern(filePath, pattern, baseDir))) enabled = false;
	if (forceIncludes.some((pattern) => matchesExactSettingsPattern(filePath, pattern, baseDir))) enabled = true;
	if (forceExcludes.some((pattern) => matchesExactSettingsPattern(filePath, pattern, baseDir))) enabled = false;
	return enabled;
}

function discoverPromptRoots(cwd: string, options: Pick<LoadPromptsWithModelOptions, "projectTrusted"> = {}): PromptRootDiscovery {
	const userBase = join(homedir(), ".pi", "agent");
	const projectBase = resolve(cwd, ".pi");
	const userSettings = loadSettingsPromptRoots(join(userBase, "settings.json"), "user", userBase);
	const projectSettings: { roots: PromptRoot[]; patterns?: string[]; diagnostics: PromptLoaderDiagnostic[] } = options.projectTrusted === false
		? { roots: [], patterns: undefined, diagnostics: [] }
		: loadSettingsPromptRoots(join(projectBase, "settings.json"), "project", projectBase);
	return {
		roots: [
			...userSettings.roots,
			{ source: "user", kind: "prompts", dir: join(userBase, "prompts"), patterns: userSettings.patterns?.filter((pattern) => /^[!+-]/.test(pattern)), patternsBaseDir: userBase },
			{ source: "user", kind: "prompt-library", dir: join(userBase, "prompt-library") },
			...projectSettings.roots,
			...(options.projectTrusted === false ? [] : [
				{ source: "project" as const, kind: "prompts" as const, dir: join(projectBase, "prompts"), patterns: projectSettings.patterns?.filter((pattern) => /^[!+-]/.test(pattern)), patternsBaseDir: projectBase },
			]),
			{ source: "project" as const, kind: "prompt-library" as const, dir: join(projectBase, "prompt-library") },
		],
		diagnostics: [...userSettings.diagnostics, ...projectSettings.diagnostics],
	};
}

function isPathInsideOrEqual(path: string, root: string): boolean {
	const canonicalPath = realpathSync(path);
	const canonicalRoot = realpathSync(root);
	const relativePath = relative(canonicalRoot, canonicalPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function shouldSkipPromptLibraryEntry(entryName: string, rootKind: PromptRootKind): boolean {
	return rootKind === "prompt-library" && entryName.startsWith(".");
}

interface PromptIgnoreRule {
	baseDir: string;
	pattern: string;
	anchored: boolean;
	directoryOnly: boolean;
	negated: boolean;
}

const PROMPT_RESOURCE_IGNORE_FILES = [".gitignore", ".ignore", ".fdignore"] as const;

function readPromptIgnoreRules(dir: string): PromptIgnoreRule[] {
	const rules: PromptIgnoreRule[] = [];
	for (const fileName of PROMPT_RESOURCE_IGNORE_FILES) {
		const filePath = join(dir, fileName);
		if (!existsSync(filePath)) continue;
		try {
			for (const rawLine of readFileSync(filePath, "utf-8").split(/\r?\n/)) {
				let pattern = rawLine.trim();
				if (!pattern || pattern.startsWith("#")) continue;
				if (pattern.startsWith("\\#")) pattern = pattern.slice(1);
				let negated = false;
				if (pattern.startsWith("!")) {
					negated = true;
					pattern = pattern.slice(1);
				}
				const anchored = pattern.startsWith("/");
				const directoryOnly = pattern.endsWith("/");
				pattern = pattern.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\\/g, "/");
				if (!pattern) continue;
				rules.push({ baseDir: dir, pattern, anchored, directoryOnly, negated });
			}
		} catch {
			// Ignore unreadable resource-ignore files and continue discovery.
		}
	}
	return rules;
}

function matchesPromptIgnoreRule(fullPath: string, isDirectory: boolean, rule: PromptIgnoreRule): boolean {
	if (rule.directoryOnly && !isDirectory) return false;
	const relativePath = relative(rule.baseDir, fullPath).replace(/\\/g, "/");
	if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) return false;
	return minimatch(relativePath, rule.pattern, {
		dot: true,
		matchBase: !rule.anchored && !rule.pattern.includes("/"),
	});
}

function shouldSkipPromptResource(fullPath: string, isDirectory: boolean, applyResourceIgnores: boolean, rules: readonly PromptIgnoreRule[]): boolean {
	if (!applyResourceIgnores) return false;
	if (basename(fullPath).startsWith(".") || (isDirectory && basename(fullPath) === "node_modules")) return true;
	let ignored = false;
	for (const rule of rules) {
		if (matchesPromptIgnoreRule(fullPath, isDirectory, rule)) ignored = !rule.negated;
	}
	return ignored;
}

function hasDotPrefixedPathSegment(path: string): boolean {
	return path.split(/[\\/]+/).some((segment) => segment.startsWith("."));
}

function promptLibrarySymlinkTargetHasDotSegment(fullPath: string, promptRoot: string, rootKind: PromptRootKind): boolean {
	if (rootKind !== "prompt-library") return false;
	const relativeTarget = relative(realpathSync(promptRoot), realpathSync(fullPath));
	return relativeTarget.length > 0 && hasDotPrefixedPathSegment(relativeTarget);
}

function rejectPromptLibrarySymlinkRoot(
	dir: string,
	promptRoot: string,
	rootKind: PromptRootKind,
	source: PromptSource,
	loadCwd: string,
	diagnostics: PromptLoaderDiagnostic[],
): boolean {
	if (rootKind !== "prompt-library" || dir !== promptRoot) return false;
	try {
		const isSymlink = lstatSync(dir).isSymbolicLink();
		const expectedCanonicalRoot = source === "project" ? resolve(realpathSync(loadCwd), ".pi", "prompt-library") : undefined;
		const canonicalRoot = realpathSync(dir);
		if (!isSymlink && (expectedCanonicalRoot === undefined || canonicalRoot === expectedCanonicalRoot)) return false;
		diagnostics.push(
			createDiagnostic(
				"symlink-outside-prompt-root",
				dir,
				source,
				expectedCanonicalRoot
					? `Skipping prompt-library root at ${dir}: prompt-library roots must resolve to ${expectedCanonicalRoot} and must not be symlinks or symlinked through ancestors.`
					: `Skipping prompt-library root at ${dir}: prompt-library roots must not be symlinks.`,
			),
		);
		return true;
	} catch {
		return false;
	}
}

function resolvePromptSymlinkEntryKind(
	fullPath: string,
	promptRoot: string,
	rootKind: PromptRootKind,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): { isFile: boolean; isDirectory: boolean } {
	try {
		if (rootKind === "prompt-library" && !isPathInsideOrEqual(fullPath, promptRoot)) {
			diagnostics.push(
				createDiagnostic(
					"symlink-outside-prompt-root",
					fullPath,
					source,
					`Skipping symlink at ${fullPath}: resolved target is outside prompt root ${promptRoot}.`,
				),
			);
			return { isFile: false, isDirectory: false };
		}
		if (promptLibrarySymlinkTargetHasDotSegment(fullPath, promptRoot, rootKind)) {
			diagnostics.push(
				createDiagnostic(
					"dot-prefixed-prompt-library-entry",
					fullPath,
					source,
					`Skipping symlink at ${fullPath}: resolved target uses dot-prefixed files or directories under prompt-library root ${promptRoot}.`,
				),
			);
			return { isFile: false, isDirectory: false };
		}

		const stats = statSync(fullPath);
		return { isFile: stats.isFile(), isDirectory: stats.isDirectory() };
	} catch (error) {
		diagnostics.push(
			createDiagnostic(
				"unreadable-symlink",
				fullPath,
				source,
				`Skipping unreadable symlink at ${fullPath}: ${error instanceof Error ? error.message : String(error)}.`,
			),
		);
		return { isFile: false, isDirectory: false };
	}
}

const MODEL_CONDITIONAL_DIRECTIVE_PATTERN = /<if-model(?:\s|>)|<else(?:\s|>)|<\/if-model\s*>|<\/else(?:\s|>)/;

function isPromptCapable(input: {
	chain?: unknown;
	hasModelField: boolean;
	hasExtensionSpecificConfig: boolean;
}): boolean {
	return input.chain !== undefined || input.hasModelField || input.hasExtensionSpecificConfig;
}

function calculatePromptCapable(input: {
	frontmatter: Record<string, unknown>;
	body: string;
	chain?: unknown;
	hasExtensionSpecificConfig?: boolean;
	ignoreBodyIncludes?: boolean;
}): boolean {
	const hasIncludeMetadata = Object.hasOwn(input.frontmatter, "include") || Object.hasOwn(input.frontmatter, "includes");
	const hasBodyIncludes = input.ignoreBodyIncludes ? false : hasPromptIncludeDirectives(input.body);
	const hasSkillConfig = Object.hasOwn(input.frontmatter, "skill") || Object.hasOwn(input.frontmatter, "skills");
	const hasModelConditionalDirectives = MODEL_CONDITIONAL_DIRECTIVE_PATTERN.test(input.body);
	return isPromptCapable({
		chain: input.chain,
		hasModelField: Object.hasOwn(input.frontmatter, "model"),
		hasExtensionSpecificConfig:
			input.hasExtensionSpecificConfig === true ||
			hasIncludeMetadata ||
			(input.ignoreBodyIncludes ? false : hasBodyIncludes) ||
			hasSkillConfig ||
			hasModelConditionalDirectives,
	});
}

function hasPromptLibraryCommandMarker(frontmatter: Record<string, unknown>): boolean {
	if (typeof frontmatter.thinking === "string" && (VALID_THINKING_LEVELS as readonly string[]).includes(frontmatter.thinking.trim().toLowerCase())) {
		return true;
	}
	return REMOVED_LEGACY_DELEGATION_FIELDS.some((key) => Object.hasOwn(frontmatter, key)) || [
		"model",
		"skill",
		"skills",
		"budget",
		"subagent",
		"deterministic",
		"run",
		"script",
		"fresh",
		"loop",
		"converge",
		"boomerang",
		"bestOfN",
		"inputs",
	].some((key) => Object.hasOwn(frontmatter, key));
}

function loadPromptsWithModelFromDir(
	dir: string,
	source: PromptSource,
	rootKind: PromptRootKind,
	includePlainPrompts: boolean,
	loadCwd: string,
	promptRoot = dir,
	subdir = "",
	visitedDirectories = new Set<string>(),
	onlyFileName?: string,
	seenFiles?: Set<string>,
	patterns: readonly string[] = [],
	patternsBaseDir = promptRoot,
	applyResourceIgnores = false,
	ignoreRules: readonly PromptIgnoreRule[] = [],
): { prompts: PromptWithModel[]; diagnostics: PromptLoaderDiagnostic[] } {
	const prompts: PromptWithModel[] = [];
	const diagnostics: PromptLoaderDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { prompts, diagnostics };
	}
	if (rejectPromptLibrarySymlinkRoot(dir, promptRoot, rootKind, source, loadCwd, diagnostics)) {
		return { prompts, diagnostics };
	}

	let canonicalDir: string;
	try {
		canonicalDir = realpathSync(dir);
	} catch (error) {
		diagnostics.push(
			createDiagnostic(
				"unreadable-directory",
				dir,
				source,
				`Skipping prompt directory ${dir}: ${error instanceof Error ? error.message : String(error)}.`,
			),
		);
		return { prompts, diagnostics };
	}

	if (visitedDirectories.has(canonicalDir)) {
		diagnostics.push(
			createDiagnostic(
				"directory-cycle",
				dir,
				source,
				`Skipping already visited prompt directory at ${dir}.`,
			),
		);
		return { prompts, diagnostics };
	}

	visitedDirectories.add(canonicalDir);
	const activeIgnoreRules = applyResourceIgnores ? [...ignoreRules, ...readPromptIgnoreRules(dir)] : ignoreRules;

	try {
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => lexicalCompare(a.name, b.name));

		for (const entry of entries) {
			if (onlyFileName && entry.name !== onlyFileName) continue;
			const fullPath = join(dir, entry.name);
			if (shouldSkipPromptLibraryEntry(entry.name, rootKind)) continue;

			let isFile = entry.isFile();
			let isDirectory = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				const resolvedKind = resolvePromptSymlinkEntryKind(fullPath, promptRoot, rootKind, source, diagnostics);
				isFile = resolvedKind.isFile;
				isDirectory = resolvedKind.isDirectory;
				if (!isFile && !isDirectory) continue;
			}

			if (shouldSkipPromptResource(fullPath, isDirectory, applyResourceIgnores, activeIgnoreRules)) continue;

			if (isDirectory) {
				if (onlyFileName) continue;
				const nextSubdir = subdir ? `${subdir}:${entry.name}` : entry.name;
				const nested = loadPromptsWithModelFromDir(fullPath, source, rootKind, includePlainPrompts, loadCwd, promptRoot, nextSubdir, visitedDirectories, undefined, seenFiles, patterns, patternsBaseDir, applyResourceIgnores, activeIgnoreRules);
				prompts.push(...nested.prompts);
				diagnostics.push(...nested.diagnostics);
				continue;
			}

			if (!isFile || !entry.name.endsWith(".md")) continue;
			if (patterns.length > 0 && !matchesSettingsPatterns(fullPath, patterns, patternsBaseDir)) continue;
			const canonicalFile = realpathSync(fullPath);
			if (seenFiles?.has(canonicalFile)) continue;
			seenFiles?.add(canonicalFile);

			try {
				const rawContent = readFileSync(fullPath, "utf-8");
				const parsed = parseFrontmatter<Record<string, unknown>>(rawContent);
				if (rootKind === "prompt-library" && !isFrontmatterRecord(parsed.frontmatter)) continue;
				const frontmatter = normalizeFrontmatterRecord(parsed.frontmatter, fullPath, source, diagnostics);
				if (!frontmatter) continue;
				const { body } = parsed;
				const includesResult = normalizePromptIncludes(frontmatter, fullPath, source, diagnostics);
				if (!includesResult.ok) continue;
				const includes = includesResult.includes;
				const rawChain = normalizeChain(frontmatter.chain, fullPath, source, diagnostics);
				const chain = typeof rawChain === "string" ? rawChain : undefined;
				let adaptiveChain: PromptWithModel["adaptiveChain"];
				const hasBodyIncludeDirectives = rawChain ? false : hasPromptIncludeDirectives(body);
				const hasModelConditionalDirectives = MODEL_CONDITIONAL_DIRECTIVE_PATTERN.test(body);
				if (rootKind === "prompt-library" && !rawChain && includes === undefined && !hasBodyIncludeDirectives && !hasModelConditionalDirectives && !hasPromptLibraryCommandMarker(frontmatter)) {
					continue;
				}
				if (rawChain && includesResult.declaredKey) {
					diagnostics.push(
						createDiagnostic(
							"invalid-includes-chain",
							fullPath,
							source,
							`Skipping prompt template at ${fullPath}: frontmatter field "${includesResult.declaredKey}" cannot be used on chain wrapper templates in v1. Put include/includes on referenced step templates instead.`,
						),
					);
					continue;
				}
				let parsedChainDeclarationResult:
					| ReturnType<typeof parseChainDeclaration>
					| undefined;
				const chainContext = rawChain ? normalizeChainContext(frontmatter.chainContext, fullPath, source, diagnostics) : undefined;
				if (rawChain) {
					parsedChainDeclarationResult = parseChainDeclaration(rawChain, Array.isArray(rawChain) ? frontmatter.limits : undefined);
					if (parsedChainDeclarationResult.invalidSegments.length > 0 || parsedChainDeclarationResult.steps.length === 0) {
						diagnostics.push(
							createDiagnostic(
								"invalid-chain-declaration",
								fullPath,
								source,
								`Skipping prompt template at ${fullPath}: invalid chain declaration segment ${JSON.stringify(parsedChainDeclarationResult.invalidSegments[0] ?? rawChain)}.`,
							),
						);
						continue;
					}
					if (Array.isArray(rawChain) && "limits" in parsedChainDeclarationResult) {
						adaptiveChain = { steps: parsedChainDeclarationResult.steps, limits: parsedChainDeclarationResult.limits };
					}
				}
				if (adaptiveChain) {
					const legacyLoopControls = ["chainContext", "loop", "fresh", "converge"].filter((key) => Object.hasOwn(frontmatter, key));
					if (legacyLoopControls.length > 0) {
						diagnostics.push(createDiagnostic("invalid-adaptive-loop-controls", fullPath, source, `Skipping adaptive chain template at ${fullPath}: structured chain wrappers do not support legacy chain-context or loop controls (${legacyLoopControls.join(", ")}).`));
						continue;
					}
				}
				const removedDelegationFields = REMOVED_LEGACY_DELEGATION_FIELDS
					.filter((key) => Object.hasOwn(frontmatter, key));
				if (removedDelegationFields.length > 0) {
					diagnostics.push(createDiagnostic(
						"unsupported-legacy-delegation",
						fullPath,
						source,
						`Skipping prompt template at ${fullPath}: removed legacy delegation field(s): ${removedDelegationFields.join(", ")}. Use one structured subagent request per prompt, or a sequential/adaptive chain.`,
					));
					continue;
				}
				const topLevelCompareFields = ["workers", "reviewers", "finalApplier"]
					.filter((key) => Object.hasOwn(frontmatter, key));
				if (topLevelCompareFields.length > 0) {
					diagnostics.push(createDiagnostic(
						"unsupported-legacy-delegation",
						fullPath,
						source,
						`Skipping prompt template at ${fullPath}: top-level compare field(s) ${topLevelCompareFields.join(", ")} are unsupported; use nested "bestOfN" configuration.`,
					));
					continue;
				}
				const bestOfN = normalizeBestOfN(frontmatter.bestOfN, fullPath, source, diagnostics);
				if (Object.hasOwn(frontmatter, "bestOfN") && !bestOfN) continue;
				let subagent = normalizeSubagent(frontmatter.subagent, fullPath, source, diagnostics);

				const cwd = normalizeCwd(frontmatter.cwd, fullPath, source, diagnostics);
				const inheritContext = normalizeInheritContext(frontmatter.inheritContext, fullPath, source, diagnostics);
				let deterministic = normalizeDeterministic(frontmatter, fullPath, source, diagnostics);
				if (rawChain && subagent !== undefined) {
					diagnostics.push(createDiagnostic("invalid-subagent-chain", fullPath, source, `Ignoring subagent in ${fullPath}: frontmatter fields "chain" and "subagent" cannot be combined.`));
					subagent = undefined;
				}
				if (rawChain && deterministic !== undefined) {
					diagnostics.push(createDiagnostic("invalid-deterministic-chain", fullPath, source, `Ignoring deterministic config in ${fullPath}: frontmatter field "deterministic" cannot be combined with "chain".`));
					deterministic = undefined;
				}
				if (subagent !== undefined && deterministic !== undefined) {
					diagnostics.push(createDiagnostic("invalid-deterministic-subagent", fullPath, source, `Ignoring deterministic config in ${fullPath}: frontmatter field "deterministic" cannot be combined with "subagent".`));
					deterministic = undefined;
				}
				if (subagent === undefined && inheritContext) {
					diagnostics.push(createDiagnostic("invalid-inherit-context", fullPath, source, `Ignoring inheritContext in ${fullPath}: frontmatter field "inheritContext" requires "subagent".`));
				}
				if (bestOfN) {
					const incompatibleBestOfNFields = ["chain", "loop", "fresh", "converge", "boomerang", "deterministic", "subagent", "inputs"]
						.filter((key) => Object.hasOwn(frontmatter, key));
					if (inheritContext) incompatibleBestOfNFields.push("inheritContext");
					if (incompatibleBestOfNFields.length > 0) {
						diagnostics.push(createDiagnostic("invalid-best-of-n-mode", fullPath, source, `Skipping compare prompt at ${fullPath}: bestOfN cannot be combined with ${incompatibleBestOfNFields.join(", ")}.`));
						continue;
					}
				}
				if (!rawChain && subagent === undefined && cwd) {
					if (deterministic) deterministic = { ...deterministic, ...(deterministic.cwd ? {} : { cwd }) };
					else diagnostics.push(createDiagnostic("invalid-cwd", fullPath, source, `Ignoring cwd in ${fullPath}: frontmatter field "cwd" requires "subagent", "chain", or deterministic execution.`));
				}

				const hasModelField = Object.hasOwn(frontmatter, "model");
				const parsedModels = rawChain ? [] : normalizeModelSpecs(frontmatter.model, fullPath, source, diagnostics);
				if (!rawChain && hasModelField && !parsedModels) continue;
				const models = rawChain ? [] : (parsedModels ?? []);
				const rotate = rawChain ? false : normalizeRotate(frontmatter.rotate, fullPath, source, diagnostics);
				const hidden = normalizeHidden(frontmatter.hidden, fullPath, source, diagnostics);
				const budgetResult = normalizePromptBudget(frontmatter.budget, fullPath, source, diagnostics);
				if (!budgetResult.ok) continue;
				const budget = budgetResult.budget;
				const inputsResult = normalizePromptInputs(frontmatter.inputs, fullPath, source, diagnostics);
				if (!inputsResult.ok) continue;
				const inputs = inputsResult.inputs;
				if (inputs && (rawChain || frontmatter.loop !== undefined || frontmatter.subagent || frontmatter.deterministic)) {
					diagnostics.push(createDiagnostic(rawChain ? "invalid-inputs-chain" : "invalid-inputs-mode", fullPath, source, rawChain ? "Prompt inputs are not supported on chain wrappers in v1." : "Prompt inputs are unsupported with loops, delegation, or deterministic execution."));
					continue;
				}
				if (budget && rawChain) {
					diagnostics.push(createDiagnostic("invalid-budget-chain", fullPath, source, "Prompt budgets belong on executable chain step templates, not chain wrappers."));
					continue;
				}

				const name = entry.name.slice(0, -3);
				if (RESERVED_COMMAND_NAMES.has(name)) {
					diagnostics.push(
						createDiagnostic(
							"reserved-command-name",
							fullPath,
							source,
							`Skipping prompt template at ${fullPath}: command name "${name}" is reserved.`,
						),
					);
					continue;
				}

				const safeInheritContext = subagent !== undefined && inheritContext;
				const safeCwd = (rawChain || subagent !== undefined) ? cwd : undefined;
				const description = normalizeStringField("description", frontmatter.description, fullPath, source, diagnostics) ?? "";
				const skillResult = rawChain ? { ok: true as const } : normalizePromptSkills(frontmatter, fullPath, source, diagnostics);
				if (!skillResult.ok) continue;
				const skill = skillResult.skill;
				const skills = skillResult.skills;
				let thinking: ThinkingLevel | undefined;
				let thinkingLevels: ThinkingLevel[] | undefined;
				if (!rawChain) {
					if (rotate && typeof frontmatter.thinking === "string" && frontmatter.thinking.includes(",")) {
						thinkingLevels = normalizeThinkingLevels(frontmatter.thinking, models.length, fullPath, source, diagnostics);
					} else {
						thinking = normalizeThinking(frontmatter.thinking, fullPath, source, diagnostics);
					}
				}
				const restore = normalizeRestore(frontmatter.restore, fullPath, source, diagnostics);
				const fresh = normalizeFresh(frontmatter.fresh, fullPath, source, diagnostics);
				const loop = normalizeLoop(frontmatter.loop, fullPath, source, diagnostics);
				const converge = normalizeConverge(frontmatter.converge, fullPath, source, diagnostics);
				let boomerang = normalizeBoomerang(frontmatter.boomerang, fullPath, source, diagnostics);
				if (rawChain && boomerang) {
					diagnostics.push(
						createDiagnostic(
							"invalid-boomerang-chain",
							fullPath,
							source,
							`Ignoring boomerang in ${fullPath}: frontmatter fields "chain" and "boomerang" cannot be combined.`,
						),
					);
					boomerang = false;
				}
				if (loop !== undefined && deterministic !== undefined) {
					diagnostics.push(
						createDiagnostic(
							"invalid-deterministic-loop",
							fullPath,
							source,
							`Ignoring deterministic config in ${fullPath}: frontmatter field "deterministic" cannot be combined with "loop" in v1.`,
						),
					);
					deterministic = undefined;
				}
				if (budget && deterministic) {
					diagnostics.push(createDiagnostic("invalid-budget-deterministic", fullPath, source, "Prompt budgets are not supported on deterministic prompts because the command runs before an optional LLM handoff."));
					continue;
				}
				let content = body;
				let includeGraph: PromptIncludeGraph | undefined;
				const includeConfigIsCommandCapable = includes !== undefined;
				const hasExtensionSpecificConfig =
					skills !== undefined ||
					thinking !== undefined ||
					fresh === true ||
					loop !== undefined ||
					converge === false ||
					boomerang === true ||
					budget !== undefined ||
					inputs !== undefined ||
					includeConfigIsCommandCapable ||
					bestOfN !== undefined ||
					deterministic !== undefined ||
					subagent !== undefined ||
					safeInheritContext;
				const promptCapable = calculatePromptCapable({
					frontmatter,
					body: content,
					chain: rawChain,
					hasExtensionSpecificConfig,
					ignoreBodyIncludes: rootKind === "prompt-library" && includes === undefined,
				});
				const shouldRenderIncludes = !rawChain && (includes !== undefined || (hasBodyIncludeDirectives && promptCapable));
				if (shouldRenderIncludes) {
					const renderedIncludes = renderPromptIncludes({
						promptName: name,
						content: body,
						includes,
						promptFilePath: fullPath,
						promptRoot,
						cwd: loadCwd,
						source,
						rootKind,
					});
					if (!renderedIncludes.ok) {
						diagnostics.push(...renderedIncludes.diagnostics);
						continue;
					}
					content = renderedIncludes.content;
					includeGraph = renderedIncludes.includeGraph;
				}
				if (inputs) {
					const inputReferenceErrors = validatePromptInputReferences(content, inputs);
					if (inputReferenceErrors.length > 0) {
						for (const error of inputReferenceErrors) diagnostics.push(createDiagnostic("invalid-inputs", fullPath, source, `Skipping prompt template at ${fullPath}: ${error}.`));
						continue;
					}
				}
				if (!promptCapable && (rootKind === "prompt-library" || !includePlainPrompts)) {
					continue;
				}

				prompts.push({
					name,
					description,
					content,
					models,
					budget,
					inputs,
					hidden: hidden || undefined,
					...(includes !== undefined ? { includes } : {}),
					chain: chain || undefined,
					adaptiveChain,
					chainContext,
					restore,
					skill,
					...(skills !== undefined ? { skills } : {}),
					thinking,
					thinkingLevels,
					rotate: rotate || undefined,
					fresh: fresh || undefined,
					loop: loop !== undefined ? loop : undefined,
					converge: converge === false ? false : undefined,
					boomerang: boomerang || undefined,
					bestOfN,
					deterministic,
					subagent,
					inheritContext: safeInheritContext || undefined,
					cwd: safeCwd || undefined,
					source,
					rootKind,
					subdir: subdir || undefined,
					filePath: fullPath,
					includeGraph,
				});
			} catch (error) {
				diagnostics.push(
					createDiagnostic(
						"invalid-prompt-file",
						fullPath,
						source,
						`Skipping prompt template at ${fullPath}: ${error instanceof Error ? error.message : String(error)}.`,
					),
				);
			}
		}
	} catch (error) {
		diagnostics.push(
			createDiagnostic(
				"unreadable-directory",
				dir,
				source,
				`Skipping prompt directory ${dir}: ${error instanceof Error ? error.message : String(error)}.`,
			),
		);
	}

	return { prompts, diagnostics };
}

function collectPromptSourceRecordsFromDir(
	dir: string,
	source: PromptSource,
	rootKind: PromptRootKind,
	includePlainPrompts: boolean,
	loadCwd: string,
	promptRoot = dir,
	subdir = "",
	visitedDirectories = new Set<string>(),
	onlyFileName?: string,
	seenFiles?: Set<string>,
	patterns: readonly string[] = [],
	patternsBaseDir = promptRoot,
	applyResourceIgnores = false,
	ignoreRules: readonly PromptIgnoreRule[] = [],
): { records: PromptSourceRecord[]; diagnostics: PromptLoaderDiagnostic[] } {
	const records: PromptSourceRecord[] = [];
	const diagnostics: PromptLoaderDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { records, diagnostics };
	}
	if (rejectPromptLibrarySymlinkRoot(dir, promptRoot, rootKind, source, loadCwd, diagnostics)) {
		return { records, diagnostics };
	}

	let canonicalDir: string;
	try {
		canonicalDir = realpathSync(dir);
	} catch (error) {
		diagnostics.push(
			createDiagnostic(
				"unreadable-directory",
				dir,
				source,
				`Skipping prompt directory ${dir}: ${error instanceof Error ? error.message : String(error)}.`,
			),
		);
		return { records, diagnostics };
	}

	if (visitedDirectories.has(canonicalDir)) {
		diagnostics.push(
			createDiagnostic(
				"directory-cycle",
				dir,
				source,
				`Skipping already visited prompt directory at ${dir}.`,
			),
		);
		return { records, diagnostics };
	}

	visitedDirectories.add(canonicalDir);
	const activeIgnoreRules = applyResourceIgnores ? [...ignoreRules, ...readPromptIgnoreRules(dir)] : ignoreRules;

	try {
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => lexicalCompare(a.name, b.name));

		for (const entry of entries) {
			if (onlyFileName && entry.name !== onlyFileName) continue;
			const fullPath = join(dir, entry.name);
			if (shouldSkipPromptLibraryEntry(entry.name, rootKind)) continue;

			let isFile = entry.isFile();
			let isDirectory = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				const resolvedKind = resolvePromptSymlinkEntryKind(fullPath, promptRoot, rootKind, source, diagnostics);
				isFile = resolvedKind.isFile;
				isDirectory = resolvedKind.isDirectory;
				if (!isFile && !isDirectory) continue;
			}

			if (shouldSkipPromptResource(fullPath, isDirectory, applyResourceIgnores, activeIgnoreRules)) continue;

			if (isDirectory) {
				if (onlyFileName) continue;
				const nextSubdir = subdir ? `${subdir}:${entry.name}` : entry.name;
				const nested = collectPromptSourceRecordsFromDir(fullPath, source, rootKind, includePlainPrompts, loadCwd, promptRoot, nextSubdir, visitedDirectories, undefined, seenFiles, patterns, patternsBaseDir, applyResourceIgnores, activeIgnoreRules);
				records.push(...nested.records);
				diagnostics.push(...nested.diagnostics);
				continue;
			}

			if (!isFile || !entry.name.endsWith(".md")) continue;
			if (patterns.length > 0 && !matchesSettingsPatterns(fullPath, patterns, patternsBaseDir)) continue;
			const canonicalFile = realpathSync(fullPath);
			if (seenFiles?.has(canonicalFile)) continue;
			seenFiles?.add(canonicalFile);

			try {
				const rawContent = readFileSync(fullPath, "utf-8");
				const parsed = parseFrontmatter<Record<string, unknown>>(rawContent);
				const promptName = entry.name.slice(0, -3);
				if (rootKind === "prompt-library" && !isFrontmatterRecord(parsed.frontmatter)) {
					if (!includePlainPrompts) continue;
					records.push({
						promptName,
						filePath: fullPath,
						promptRoot,
						cwd: loadCwd,
						source,
						rootKind,
						promptCapable: false,
						rawBody: parsed.body,
						hasInlineIncludes: false,
						hasIncludesPlaceholder: false,
						isChainWrapper: false,
						skippedReason: "invalid-frontmatter",
					});
					continue;
				}
				const frontmatter = normalizeFrontmatterRecord(parsed.frontmatter, fullPath, source, diagnostics);
				if (!frontmatter) continue;

				if (RESERVED_COMMAND_NAMES.has(promptName)) {
					const hidden = normalizeHidden(frontmatter.hidden, fullPath, source, diagnostics);
					const rawChain = normalizeChain(frontmatter.chain, fullPath, source, diagnostics);
					const hasIncludeMetadata = Object.hasOwn(frontmatter, "include") || Object.hasOwn(frontmatter, "includes");
					const promptCapable = calculatePromptCapable({
						frontmatter,
						body: parsed.body,
						chain: rawChain,
						ignoreBodyIncludes: rawChain !== undefined || (rootKind === "prompt-library" && !hasIncludeMetadata),
					});
					records.push({
						promptName,
						filePath: fullPath,
						promptRoot,
						cwd: loadCwd,
						source,
						rootKind,
						promptCapable,
						rawBody: parsed.body,
						hasInlineIncludes: rawChain === undefined && extractPromptInlineIncludes(parsed.body).length > 0,
						hasIncludesPlaceholder: rawChain === undefined && hasPromptIncludesPlaceholder(parsed.body),
						isChainWrapper: rawChain !== undefined,
						hidden: hidden || undefined,
						skippedReason: "reserved-command-name",
					});
					continue;
				}

				const includesDiagnosticStart = diagnostics.length;
				const includesResult = normalizePromptIncludes(frontmatter, fullPath, source, diagnostics);
				const includes = includesResult.ok ? includesResult.includes : undefined;
				const chain = normalizeChain(frontmatter.chain, fullPath, source, diagnostics);
				const isChainWrapper = chain !== undefined;
				const hasModelConditionalDirectives = !isChainWrapper && MODEL_CONDITIONAL_DIRECTIVE_PATTERN.test(parsed.body);
				if (rootKind === "prompt-library" && !isChainWrapper && includesResult.ok && includes === undefined && !hasPromptIncludeDirectives(parsed.body) && !hasModelConditionalDirectives && !hasPromptLibraryCommandMarker(frontmatter)) {
					if (!includePlainPrompts) continue;
					const hidden = frontmatter.hidden === true || (typeof frontmatter.hidden === "string" && frontmatter.hidden.trim().toLowerCase() === "true");
					records.push({
						promptName,
						filePath: fullPath,
						promptRoot,
						cwd: loadCwd,
						source,
						rootKind,
						promptCapable: false,
						rawBody: parsed.body,
						hasInlineIncludes: false,
						hasIncludesPlaceholder: false,
						isChainWrapper: false,
						hidden: hidden || undefined,
					});
					continue;
				}
				const includeMetadataInvalid = !includesResult.ok || (isChainWrapper && includesResult.ok && includesResult.declaredKey !== undefined);
				const skippedReason = !includesResult.ok ? diagnostics[includesDiagnosticStart]?.code : includeMetadataInvalid ? "invalid-includes-chain" : undefined;
				const hasInlineIncludes = isChainWrapper ? false : extractPromptInlineIncludes(parsed.body).length > 0;
				const hasIncludesPlaceholder = isChainWrapper ? false : hasPromptIncludesPlaceholder(parsed.body);
				const hidden = normalizeHidden(frontmatter.hidden, fullPath, source, diagnostics);

				const fresh = normalizeFresh(frontmatter.fresh, fullPath, source, diagnostics);
				const loop = normalizeLoop(frontmatter.loop, fullPath, source, diagnostics);
				const converge = normalizeConverge(frontmatter.converge, fullPath, source, diagnostics);
				const boomerang = normalizeBoomerang(frontmatter.boomerang, fullPath, source, diagnostics);
				const thinking = isChainWrapper ? undefined : normalizeThinking(frontmatter.thinking, fullPath, source, diagnostics);

				const bodyIncludesAreCommandCapable = !(rootKind === "prompt-library" && includes === undefined);
				const hasSourceGraphFeature =
						isChainWrapper ||
						includes !== undefined ||
						(bodyIncludesAreCommandCapable && (hasInlineIncludes || hasIncludesPlaceholder)) ||
						fresh === true ||
						loop !== undefined ||
						converge === false ||
						boomerang === true ||
						thinking !== undefined ||
						Object.hasOwn(frontmatter, "budget") ||
						Object.hasOwn(frontmatter, "subagent") ||
						Object.hasOwn(frontmatter, "deterministic") ||
						Object.hasOwn(frontmatter, "run") ||
						Object.hasOwn(frontmatter, "script") ||
						Object.hasOwn(frontmatter, "bestOfN") ||
						REMOVED_LEGACY_DELEGATION_FIELDS.some((key) => Object.hasOwn(frontmatter, key));
				const promptCapable = calculatePromptCapable({
					frontmatter,
					body: parsed.body,
					chain,
					hasExtensionSpecificConfig: hasSourceGraphFeature,
					ignoreBodyIncludes: isChainWrapper || !bodyIncludesAreCommandCapable,
				});
				if (!promptCapable && !includePlainPrompts) continue;

				records.push({
					promptName,
					filePath: fullPath,
					promptRoot,
					cwd: loadCwd,
					source,
					rootKind,
					promptCapable,
					rawBody: parsed.body,
					...(includes !== undefined ? { includes } : {}),
					hasInlineIncludes,
					hasIncludesPlaceholder,
					isChainWrapper,
					isStructuredChainDeclaration: Array.isArray(frontmatter.chain),
					hidden: hidden || undefined,
					...(includeMetadataInvalid ? { includeMetadataInvalid: true, skippedReason } : {}),
				});
			} catch (error) {
				diagnostics.push(
					createDiagnostic(
						"invalid-prompt-file",
						fullPath,
						source,
						`Skipping prompt template at ${fullPath}: ${error instanceof Error ? error.message : String(error)}.`,
					),
				);
			}
		}
	} catch (error) {
		diagnostics.push(
			createDiagnostic(
				"unreadable-directory",
				dir,
				source,
				`Skipping prompt directory ${dir}: ${error instanceof Error ? error.message : String(error)}.`,
			),
		);
	}

	return { records, diagnostics };
}

function dedupeDiagnostics(diagnostics: PromptLoaderDiagnostic[]): PromptLoaderDiagnostic[] {
	const seen = new Set<string>();
	const deduped: PromptLoaderDiagnostic[] = [];
	for (const diagnostic of diagnostics) {
		if (seen.has(diagnostic.key)) continue;
		seen.add(diagnostic.key);
		deduped.push(diagnostic);
	}
	return deduped;
}

function isIncludeGraphRelevantSkippedRecord(record: PromptSourceRecord): boolean {
	return record.includes !== undefined || record.hasInlineIncludes || record.hasIncludesPlaceholder || record.includeMetadataInvalid === true;
}

export function collectPromptSourceRecords(
	cwd: string,
	includePlainPrompts = true,
	options: LoadPromptsWithModelOptions = {},
): CollectPromptSourceRecordsResult {
	const recordMap = new Map<string, PromptSourceRecord[]>();
	const inventoryRecords: PromptSourceRecord[] = [];
	const diagnostics: PromptLoaderDiagnostic[] = [];
	const discovery = discoverPromptRoots(cwd, options);
	diagnostics.push(...discovery.diagnostics);
	const seenFilesBySource: Record<PromptSource, Set<string>> = { user: new Set<string>(), project: new Set<string>() };
	const loaderResult = loadPromptsWithModel(cwd, includePlainPrompts, { ...options, includeAdaptiveChains: true });
	const effectivePromptPaths = new Set([...loaderResult.prompts.values()].map((prompt) => prompt.filePath));

	function replaceRecord(bucket: PromptSourceRecord[], existing: PromptSourceRecord, record: PromptSourceRecord): PromptSourceRecord[] {
		return bucket.map((item) => (item === existing ? record : item));
	}

	function addRecord(record: PromptSourceRecord) {
		const recordIsEffective = effectivePromptPaths.has(record.filePath);
		if (!recordIsEffective && !isIncludeGraphRelevantSkippedRecord(record) && record.rootKind !== "prompt-library") {
			return;
		}

		const existingBucket = recordMap.get(record.promptName);
		if (!existingBucket) {
			recordMap.set(record.promptName, [record]);
			return;
		}

		const sameSourceExisting = existingBucket.find((existing) => existing.source === record.source);
		if (sameSourceExisting) {
			const existingIsEffective = effectivePromptPaths.has(sameSourceExisting.filePath);
			if (!existingIsEffective && recordIsEffective) {
				recordMap.set(record.promptName, replaceRecord(existingBucket, sameSourceExisting, record));
				return;
			}
			if (!existingIsEffective || !recordIsEffective) {
				return;
			}
			diagnostics.push(
				createDiagnostic(
					"duplicate-command-name",
					record.filePath,
					record.source,
					`Skipping ${record.source} prompt template "${record.promptName}" at ${record.filePath} because it conflicts with ${sameSourceExisting.filePath}.`,
				),
			);
			return;
		}

		if (!recordIsEffective) {
			recordMap.set(record.promptName, [...existingBucket, record]);
			return;
		}

		recordMap.set(
			record.promptName,
			[
				...existingBucket.filter((existing) => !effectivePromptPaths.has(existing.filePath) && isIncludeGraphRelevantSkippedRecord(existing)),
				record,
			],
		);
	}

	for (const root of discovery.roots) {
		const rootResult = collectPromptSourceRecordsFromDir(root.dir, root.source, root.kind, includePlainPrompts, cwd, root.dir, "", new Set<string>(), root.onlyFileName, seenFilesBySource[root.source], root.patterns, root.patternsBaseDir, root.applyResourceIgnores);
		inventoryRecords.push(...rootResult.records);
		diagnostics.push(...rootResult.diagnostics);
		for (const record of rootResult.records) addRecord(record);
	}

	return { records: [...recordMap.values()].flat(), inventoryRecords, diagnostics: dedupeDiagnostics([...diagnostics, ...loaderResult.diagnostics]) };
}

export function loadPromptsWithModel(
	cwd: string,
	includePlainPrompts = false,
	options: LoadPromptsWithModelOptions = {},
): LoadPromptsWithModelResult {
	const promptMap = new Map<string, PromptWithModel>();
	const diagnostics: PromptLoaderDiagnostic[] = [];
	const discovery = discoverPromptRoots(cwd, options);
	diagnostics.push(...discovery.diagnostics);
	const seenFilesBySource: Record<PromptSource, Set<string>> = { user: new Set<string>(), project: new Set<string>() };

	function addPrompt(prompt: PromptWithModel) {
		const existing = promptMap.get(prompt.name);
		if (!existing) {
			promptMap.set(prompt.name, prompt);
			return;
		}

		if (existing.source === prompt.source) {
			diagnostics.push(
				createDiagnostic(
					"duplicate-command-name",
					prompt.filePath,
					prompt.source,
					`Skipping ${prompt.source} prompt template "${prompt.name}" at ${prompt.filePath} because it conflicts with ${existing.filePath}.`,
				),
			);
			return;
		}

		promptMap.set(prompt.name, prompt);
	}

	for (const root of discovery.roots) {
		const rootResult = loadPromptsWithModelFromDir(root.dir, root.source, root.kind, includePlainPrompts, cwd, root.dir, "", new Set<string>(), root.onlyFileName, seenFilesBySource[root.source], root.patterns, root.patternsBaseDir, root.applyResourceIgnores);
		diagnostics.push(...rootResult.diagnostics);
		for (const prompt of rootResult.prompts) {
			addPrompt(prompt);
		}
	}

	const visiblePrompts = options.includeAdaptiveChains === true
		? promptMap
		: new Map([...promptMap].filter(([, prompt]) => prompt.adaptiveChain === undefined));
	return { prompts: visiblePrompts, diagnostics };
}

export function formatPromptSourceLabel(prompt: Pick<PromptWithModel, "source" | "rootKind" | "subdir">): string {
	const rootLabel = prompt.rootKind === "prompt-library" ? `${prompt.source} library` : prompt.source;
	return prompt.subdir ? `${rootLabel}:${prompt.subdir}` : rootLabel;
}

export function buildPromptCommandDescription(prompt: PromptWithModel): string {
	const sourceLabel = `(${formatPromptSourceLabel(prompt)})`;
	if (prompt.adaptiveChain) {
		const { maxSteps, maxModelCalls } = prompt.adaptiveChain.limits;
		const stepCount = (prompt.adaptiveChain.steps as StructuredChainStep[]).length;
		const details = `[adaptive chain steps:${stepCount}/${maxSteps} model-calls:${maxModelCalls}] ${sourceLabel}`;
		return prompt.description ? `${prompt.description} ${details}` : details;
	}
	if (prompt.chain) {
		const chainContextLabel = prompt.chainContext ? ` ${prompt.chainContext}` : "";
		const cwdLabel = prompt.cwd ? ` cwd:${prompt.cwd}` : "";
		const details = `[chain: ${prompt.chain}${chainContextLabel}${cwdLabel}] ${sourceLabel}`;
		return prompt.description ? `${prompt.description} ${details}` : details;
	}
	const modelLabel = prompt.models.length > 0 ? prompt.models.map((model) => model.split("/").pop() || model).join("|") : "current";
	const rotateLabel = prompt.rotate ? " rotate" : "";
	const skillLabel = prompt.skills && prompt.skills.length > 0 ? ` +${prompt.skills.join(",+")}` : prompt.skill ? ` +${prompt.skill}` : "";
	const thinkingValue = prompt.thinkingLevels ? prompt.thinkingLevels.join(",") : prompt.thinking;
	const thinkingLabel = thinkingValue ? ` ${thinkingValue}` : "";
	const loopLabel = prompt.loop !== undefined ? ` loop:${prompt.loop === null ? "unlimited" : prompt.loop}` : "";
	const boomerangLabel = prompt.boomerang ? " boomerang" : "";
	const compareLabel = prompt.bestOfN ? ` compare:${prompt.bestOfN.workers?.length ?? 0} workers${prompt.bestOfN.reviewers ? `/${prompt.bestOfN.reviewers.length} reviewers` : ""}${prompt.bestOfN.finalApplier ? " +final" : ""}` : "";
	const subagentLabel = prompt.subagent ? ` subagent:${prompt.subagent === true ? "delegate" : prompt.subagent}` : "";
	const deterministicLabel = prompt.deterministic ? ` deterministic-step:${prompt.deterministic.handoff}` : "";
	const cwdLabel = prompt.cwd ? ` cwd:${prompt.cwd}` : "";
	const inheritContextLabel = prompt.inheritContext ? " fork" : "";
	const details =
		`[${modelLabel}${rotateLabel}${thinkingLabel}${skillLabel}${loopLabel}${boomerangLabel}${compareLabel}${subagentLabel}${deterministicLabel}${cwdLabel}${inheritContextLabel}] ${sourceLabel}`;
	return prompt.description ? `${prompt.description} ${details}` : details;
}

function getSkillCandidates(baseDir: string, skillName: string): string[] {
	return [join(baseDir, skillName, "SKILL.md"), join(baseDir, `${skillName}.md`)];
}

function* walkAncestors(startDir: string, stopDir?: string): Generator<string> {
	let current = startDir;
	while (true) {
		yield current;
		if (stopDir && current === stopDir) return;
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

function findRepoRoot(startDir: string): string | undefined {
	for (const dir of walkAncestors(startDir)) {
		if (existsSync(join(dir, ".git"))) return dir;
	}
	return undefined;
}

function findFirstExisting(paths: string[]): string | undefined {
	for (const path of paths) {
		if (existsSync(path)) return path;
	}
	return undefined;
}

export function resolveSkillPath(
	skillName: string,
	cwd: string,
	options: ResolveSkillPathOptions = {},
): string | undefined {
	const projectDir = resolve(cwd);

	if (options.includeProjectSkills !== false) {
		const projectPiSkill = findFirstExisting(getSkillCandidates(resolve(projectDir, ".pi", "skills"), skillName));
		if (projectPiSkill) return projectPiSkill;

		const repoRoot = findRepoRoot(projectDir);
		for (const dir of walkAncestors(projectDir, repoRoot)) {
			const projectAgentsSkill = findFirstExisting(getSkillCandidates(join(dir, ".agents", "skills"), skillName));
			if (projectAgentsSkill) return projectAgentsSkill;
		}
	}

	const globalPiSkill = findFirstExisting(getSkillCandidates(join(homedir(), ".pi", "agent", "skills"), skillName));
	if (globalPiSkill) return globalPiSkill;

	return findFirstExisting(getSkillCandidates(join(homedir(), ".agents", "skills"), skillName));
}

export interface DiscoveredSkill {
	skillName: string;
	skillPath: string;
}

function getSkillDiscoveryRoots(cwd: string, options: ResolveSkillPathOptions): string[] {
	const projectDir = resolve(cwd);
	const roots: string[] = [];
	if (options.includeProjectSkills !== false) {
		roots.push(resolve(projectDir, ".pi", "skills"));
		const repoRoot = findRepoRoot(projectDir);
		for (const dir of walkAncestors(projectDir, repoRoot)) {
			roots.push(join(dir, ".agents", "skills"));
		}
	}
	roots.push(join(homedir(), ".pi", "agent", "skills"));
	roots.push(join(homedir(), ".agents", "skills"));
	return roots;
}

function isValidDiscoveredSkillName(skillName: string): boolean {
	return VALID_EXACT_SKILL_NAME.test(skillName);
}

function isReadableParseableSkillFile(skillPath: string): boolean {
	try {
		const skillStats = lstatSync(skillPath);
		if (!skillStats.isFile()) return false;
		parseFrontmatter(readFileSync(skillPath, "utf-8"));
		return true;
	} catch {
		return false;
	}
}

function discoverSkillsInRoot(root: string): DiscoveredSkill[] {
	try {
		const entries = readdirSync(root, { withFileTypes: true });
		const discovered = new Map<string, { skillPath: string; priority: number }>();

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.isSymbolicLink()) continue;
			const entryPath = join(root, entry.name);

			if (entry.isDirectory()) {
				const skillName = entry.name;
				if (!isValidDiscoveredSkillName(skillName)) continue;
				const skillPath = join(entryPath, "SKILL.md");
				if (!isReadableParseableSkillFile(skillPath)) continue;
				discovered.set(skillName, { skillPath, priority: 0 });
				continue;
			}

			if (!entry.isFile()) continue;
			if (!entry.name.endsWith(".md")) continue;
			const skillName = entry.name.slice(0, -3);
			if (skillName.startsWith(".")) continue;
			if (!isValidDiscoveredSkillName(skillName)) continue;
			const existing = discovered.get(skillName);
			if (existing && existing.priority <= 1) continue;
			if (!isReadableParseableSkillFile(entryPath)) continue;
			discovered.set(skillName, { skillPath: entryPath, priority: 1 });
		}

		return Array.from(discovered, ([skillName, value]) => ({ skillName, skillPath: value.skillPath }))
			.sort((a, b) => lexicalCompare(a.skillName, b.skillName));
	} catch {
		return [];
	}
}

export function discoverFilesystemSkills(
	cwd: string,
	options: ResolveSkillPathOptions = {},
): DiscoveredSkill[] {
	return getSkillDiscoveryRoots(cwd, options).flatMap((root) => discoverSkillsInRoot(root));
}

export function readSkillContent(skillPath: string): string {
	const raw = readFileSync(skillPath, "utf-8");
	return parseFrontmatter(raw).body;
}
