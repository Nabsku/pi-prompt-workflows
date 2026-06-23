import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { DelegationLineupSlot, PromptLoaderDiagnostic, PromptSource } from "./prompt-loader.js";

const MAX_PRESET_FILE_BYTES = 1024 * 1024;

export interface BestOfNPreset {
	description?: string;
	defaultModel?: string;
	maxModelCalls?: number;
	workers?: DelegationLineupSlot[];
	reviewers?: DelegationLineupSlot[];
}

export interface ResolvedBestOfNPreset extends BestOfNPreset {
	name: string;
	source: PromptSource;
	sourceKind: PromptSource;
	sourcePath: string;
	filePath: string;
}

export type BestOfNPresetTrustLabel = "trusted-user" | "untrusted-project-approval-required";

export interface BestOfNPresetDiscoveryEntry {
	name: string;
	source: PromptSource;
	sourceKind: PromptSource;
	sourcePath: string;
	filePath: string;
	trustLabel: BestOfNPresetTrustLabel;
	description?: string;
	defaultModel?: string;
	maxModelCalls?: number;
	workerCount: number;
	reviewerCount: number;
	hasFinalApplier: false;
	preset: ResolvedBestOfNPreset;
}

export interface BestOfNPresetCatalog {
	presets: Map<string, ResolvedBestOfNPreset>;
	discoveredPresets: BestOfNPresetDiscoveryEntry[];
	invalidPresetNames: Set<string>;
	diagnostics: PromptLoaderDiagnostic[];
	projectFileInvalid: boolean;
}

function createPresetDiagnostic(code: string, filePath: string, source: PromptSource, message: string): PromptLoaderDiagnostic {
	return {
		code,
		filePath,
		source,
		message,
		key: `${code}:${filePath}:${message}`,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPathInside(child: string, parent: string): boolean {
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(`..${sep}`));
}

function verifyPresetPath(filePath: string, source: PromptSource, diagnostics: PromptLoaderDiagnostic[]): boolean {
	const resolvedPath = resolve(filePath);
	const root = source === "user" ? resolve(homedir(), ".pi", "agent") : resolve(dirname(dirname(resolvedPath)));
	try {
		const rootRealPath = realpathSync(root);
		const fileParentRealPath = realpathSync(dirname(resolvedPath));
		if (!isPathInside(fileParentRealPath, rootRealPath)) {
			diagnostics.push(createPresetDiagnostic("invalid-best-of-n-presets-file", resolvedPath, source, `Skipping best-of-N presets file ${resolvedPath}: resolved parent escapes ${rootRealPath}.`));
			return false;
		}

		let cursor = resolvedPath;
		while (true) {
			const stats = lstatSync(cursor);
			if (stats.isSymbolicLink()) {
				diagnostics.push(createPresetDiagnostic("invalid-best-of-n-presets-file", resolvedPath, source, `Skipping best-of-N presets file ${resolvedPath}: symlinked preset paths are not trusted.`));
				return false;
			}
			if (cursor === root || cursor === dirname(cursor)) break;
			cursor = dirname(cursor);
		}

		const stats = statSync(resolvedPath);
		if (!stats.isFile()) {
			diagnostics.push(createPresetDiagnostic("invalid-best-of-n-presets-file", resolvedPath, source, `Skipping best-of-N presets file ${resolvedPath}: expected a regular file.`));
			return false;
		}
		if (stats.size > MAX_PRESET_FILE_BYTES) {
			diagnostics.push(createPresetDiagnostic("invalid-best-of-n-presets-file", resolvedPath, source, `Skipping best-of-N presets file ${resolvedPath}: file is ${stats.size} bytes, max is ${MAX_PRESET_FILE_BYTES} bytes.`));
			return false;
		}
		return true;
	} catch (error) {
		diagnostics.push(createPresetDiagnostic("invalid-best-of-n-presets-file", resolvedPath, source, `Skipping best-of-N presets file ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}.`));
		return false;
	}
}

function parseStaticPresetFile(filePath: string, text: string): unknown {
	const extension = extname(filePath).toLowerCase();
	if (extension === ".yaml" || extension === ".yml") {
		return parseFrontmatter<Record<string, unknown>>(`---\n${text}\n---\n`).frontmatter;
	}
	return JSON.parse(text);
}

function expandedLineupCount(slots: DelegationLineupSlot[] | undefined): number {
	return (slots ?? []).reduce((total, slot) => total + (slot.count ?? 1), 0);
}

function createDiscoveryEntry(preset: ResolvedBestOfNPreset): BestOfNPresetDiscoveryEntry {
	return {
		name: preset.name,
		source: preset.source,
		sourceKind: preset.sourceKind,
		sourcePath: preset.sourcePath,
		filePath: preset.filePath,
		trustLabel: preset.source === "project" ? "untrusted-project-approval-required" : "trusted-user",
		description: preset.description,
		defaultModel: preset.defaultModel,
		maxModelCalls: preset.maxModelCalls,
		workerCount: expandedLineupCount(preset.workers),
		reviewerCount: expandedLineupCount(preset.reviewers),
		hasFinalApplier: false,
		preset,
	};
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

function rejectUnsupportedKeys(
	value: Record<string, unknown>,
	allowedKeys: Set<string>,
	presetName: string,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
	context: string,
): boolean {
	const unsupportedKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
	if (unsupportedKeys.length === 0) return false;
	diagnostics.push(createPresetDiagnostic("invalid-best-of-n-preset", filePath, source, `Ignoring preset ${JSON.stringify(presetName)} in ${filePath}: ${context} has unsupported field(s): ${unsupportedKeys.join(", ")}.`));
	return true;
}

const PRESET_KEYS = new Set(["description", "defaultModel", "maxModelCalls", "workers", "reviewers"]);
const PRESET_SLOT_KEYS = new Set(["agent", "subagent", "model", "count"]);

function normalizePresetSlot(
	value: unknown,
	field: "workers" | "reviewers",
	presetName: string,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
	index: number,
): DelegationLineupSlot | undefined {
	if (!isRecord(value)) {
		diagnostics.push(createPresetDiagnostic("invalid-best-of-n-preset", filePath, source, `Ignoring preset ${JSON.stringify(presetName)} in ${filePath}: ${field} slot ${index + 1} must be an object.`));
		return undefined;
	}
	if (rejectUnsupportedKeys(value, PRESET_SLOT_KEYS, presetName, filePath, source, diagnostics, `${field} slot ${index + 1}`)) {
		return undefined;
	}
	if (value.agent !== undefined && value.subagent !== undefined) {
		diagnostics.push(createPresetDiagnostic("invalid-best-of-n-preset", filePath, source, `Ignoring preset ${JSON.stringify(presetName)} in ${filePath}: ${field} slot ${index + 1} cannot combine "agent" and "subagent".`));
		return undefined;
	}

	let agent: string | undefined;
	if (typeof value.agent === "string" && value.agent.trim()) {
		agent = value.agent.trim();
	} else if (value.agent !== undefined) {
		diagnostics.push(createPresetDiagnostic("invalid-best-of-n-preset", filePath, source, `Ignoring preset ${JSON.stringify(presetName)} in ${filePath}: ${field} slot ${index + 1} requires a non-empty string "agent".`));
		return undefined;
	}
	if (!agent && value.subagent !== undefined) {
		if (value.subagent === true) {
			agent = field === "reviewers" ? "reviewer" : "delegate";
		} else if (typeof value.subagent === "string" && value.subagent.trim()) {
			agent = value.subagent.trim();
		} else {
			diagnostics.push(createPresetDiagnostic("invalid-best-of-n-preset", filePath, source, `Ignoring preset ${JSON.stringify(presetName)} in ${filePath}: ${field} slot ${index + 1} requires "subagent" to be true or a non-empty string.`));
			return undefined;
		}
	}
	if (!agent) agent = field === "reviewers" ? "reviewer" : "delegate";

	const slot: DelegationLineupSlot = { agent };
	if (value.model !== undefined) {
		if (typeof value.model !== "string" || !value.model.trim() || !isValidModelSelectionSpec(value.model.trim())) {
			diagnostics.push(createPresetDiagnostic("invalid-best-of-n-preset", filePath, source, `Ignoring preset ${JSON.stringify(presetName)} in ${filePath}: ${field} slot ${index + 1} has an invalid "model".`));
			return undefined;
		}
		slot.model = value.model.trim();
	}
	if (value.count !== undefined) {
		let count: number | undefined;
		if (typeof value.count === "number") count = value.count;
		else if (typeof value.count === "string" && /^\d+$/.test(value.count.trim())) count = parseInt(value.count.trim(), 10);
		if (count === undefined || !Number.isInteger(count) || count < 1) {
			diagnostics.push(createPresetDiagnostic("invalid-best-of-n-preset", filePath, source, `Ignoring preset ${JSON.stringify(presetName)} in ${filePath}: ${field} slot ${index + 1} "count" must be an integer greater than or equal to 1.`));
			return undefined;
		}
		slot.count = count;
	}
	return slot;
}

function normalizePresetLineup(
	value: unknown,
	field: "workers" | "reviewers",
	presetName: string,
	filePath: string,
	source: PromptSource,
	diagnostics: PromptLoaderDiagnostic[],
): DelegationLineupSlot[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0) {
		diagnostics.push(createPresetDiagnostic("invalid-best-of-n-preset", filePath, source, `Ignoring preset ${JSON.stringify(presetName)} in ${filePath}: ${field} must be a non-empty array.`));
		return undefined;
	}
	const slots: DelegationLineupSlot[] = [];
	for (let i = 0; i < value.length; i++) {
		const slot = normalizePresetSlot(value[i], field, presetName, filePath, source, diagnostics, i);
		if (!slot) return undefined;
		slots.push(slot);
	}
	return slots;
}

function normalizePreset(name: string, value: unknown, filePath: string, source: PromptSource, diagnostics: PromptLoaderDiagnostic[]): BestOfNPreset | undefined {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
		diagnostics.push(createPresetDiagnostic("invalid-best-of-n-preset", filePath, source, `Ignoring invalid best-of-N preset name ${JSON.stringify(name)} in ${filePath}.`));
		return undefined;
	}
	if (!isRecord(value)) {
		diagnostics.push(createPresetDiagnostic("invalid-best-of-n-preset", filePath, source, `Ignoring preset ${JSON.stringify(name)} in ${filePath}: preset must be an object.`));
		return undefined;
	}
	if (rejectUnsupportedKeys(value, PRESET_KEYS, name, filePath, source, diagnostics, "preset")) {
		return undefined;
	}
	const preset: BestOfNPreset = {};
	if (value.description !== undefined) {
		if (typeof value.description !== "string") {
			diagnostics.push(createPresetDiagnostic("invalid-best-of-n-preset", filePath, source, `Ignoring preset ${JSON.stringify(name)} in ${filePath}: description must be a string.`));
			return undefined;
		}
		const description = value.description.trim();
		if (description) preset.description = description;
	}
	if (value.defaultModel !== undefined) {
		if (typeof value.defaultModel !== "string" || !value.defaultModel.trim() || !isValidModelSelectionSpec(value.defaultModel.trim())) {
			diagnostics.push(createPresetDiagnostic("invalid-best-of-n-preset", filePath, source, `Ignoring preset ${JSON.stringify(name)} in ${filePath}: defaultModel must be a valid model spec string.`));
			return undefined;
		}
		preset.defaultModel = value.defaultModel.trim();
	}
	if (value.maxModelCalls !== undefined) {
		if (typeof value.maxModelCalls !== "number" || !Number.isInteger(value.maxModelCalls) || value.maxModelCalls < 1) {
			diagnostics.push(createPresetDiagnostic("invalid-best-of-n-preset", filePath, source, `Ignoring preset ${JSON.stringify(name)} in ${filePath}: maxModelCalls must be an integer greater than or equal to 1.`));
			return undefined;
		}
		preset.maxModelCalls = value.maxModelCalls;
	}
	const workers = normalizePresetLineup(value.workers, "workers", name, filePath, source, diagnostics);
	if (value.workers !== undefined && !workers) return undefined;
	const reviewers = normalizePresetLineup(value.reviewers, "reviewers", name, filePath, source, diagnostics);
	if (value.reviewers !== undefined && !reviewers) return undefined;
	if (workers) preset.workers = workers;
	if (reviewers) preset.reviewers = reviewers;
	if (!preset.workers && !preset.reviewers && value.workers === undefined && value.reviewers === undefined) {
		diagnostics.push(createPresetDiagnostic("invalid-best-of-n-preset", filePath, source, `Ignoring preset ${JSON.stringify(name)} in ${filePath}: expected workers or reviewers.`));
		return undefined;
	}
	if (!preset.workers && !preset.reviewers) return undefined;
	return preset;
}

function readPresetFile(filePath: string, source: PromptSource): BestOfNPresetCatalog {
	const presets = new Map<string, ResolvedBestOfNPreset>();
	const discoveredPresets: BestOfNPresetDiscoveryEntry[] = [];
	const invalidPresetNames = new Set<string>();
	const diagnostics: PromptLoaderDiagnostic[] = [];
	if (!existsSync(filePath)) return { presets, discoveredPresets, invalidPresetNames, diagnostics, projectFileInvalid: false };
	let projectFileInvalid = false;
	let parsed: unknown;
	try {
		if (!verifyPresetPath(filePath, source, diagnostics)) {
			projectFileInvalid = source === "project";
			return { presets, discoveredPresets, invalidPresetNames, diagnostics, projectFileInvalid };
		}
		parsed = parseStaticPresetFile(filePath, readFileSync(filePath, "utf-8"));
	} catch (error) {
		projectFileInvalid = source === "project";
		diagnostics.push(createPresetDiagnostic("invalid-best-of-n-presets-file", filePath, source, `Skipping best-of-N presets file ${filePath}: ${error instanceof Error ? error.message : String(error)}.`));
		return { presets, discoveredPresets, invalidPresetNames, diagnostics, projectFileInvalid };
	}
	if (!isRecord(parsed) || !isRecord(parsed.presets)) {
		projectFileInvalid = source === "project";
		diagnostics.push(createPresetDiagnostic("invalid-best-of-n-presets-file", filePath, source, `Skipping best-of-N presets file ${filePath}: expected top-level object with a "presets" object.`));
		return { presets, discoveredPresets, invalidPresetNames, diagnostics, projectFileInvalid };
	}
	for (const [name, rawPreset] of Object.entries(parsed.presets)) {
		const preset = normalizePreset(name, rawPreset, filePath, source, diagnostics);
		if (!preset) {
			invalidPresetNames.add(name);
			continue;
		}
		const resolvedPreset: ResolvedBestOfNPreset = { name, source, sourceKind: source, sourcePath: filePath, filePath, ...preset };
		presets.set(name, resolvedPreset);
		discoveredPresets.push(createDiscoveryEntry(resolvedPreset));
	}
	return { presets, discoveredPresets, invalidPresetNames, diagnostics, projectFileInvalid };
}

export function getBestOfNPresetPaths(cwd: string): { user: string; project: string } {
	return {
		user: join(homedir(), ".pi", "agent", "best-of-n-presets.json"),
		project: resolve(cwd, ".pi", "best-of-n-presets.json"),
	};
}

export function getBestOfNPresetCandidatePaths(cwd: string): { user: string[]; project: string[] } {
	return {
		user: [
			join(homedir(), ".pi", "agent", "best-of-n-presets.json"),
			join(homedir(), ".pi", "agent", "best-of-n-presets.yaml"),
			join(homedir(), ".pi", "agent", "best-of-n-presets.yml"),
		],
		project: [
			resolve(cwd, ".pi", "best-of-n-presets.json"),
			resolve(cwd, ".pi", "best-of-n-presets.yaml"),
			resolve(cwd, ".pi", "best-of-n-presets.yml"),
		],
	};
}

function readFirstPresetFile(paths: string[], source: PromptSource): BestOfNPresetCatalog {
	const filePath = paths.find((candidate) => existsSync(candidate));
	if (filePath) return readPresetFile(filePath, source);
	return { presets: new Map(), discoveredPresets: [], invalidPresetNames: new Set(), diagnostics: [], projectFileInvalid: false };
}

export function loadBestOfNPresetCatalog(cwd: string): BestOfNPresetCatalog {
	const paths = getBestOfNPresetCandidatePaths(cwd);
	const user = readFirstPresetFile(paths.user, "user");
	const project = readFirstPresetFile(paths.project, "project");
	const presets = project.projectFileInvalid ? new Map(project.presets) : new Map([...user.presets, ...project.presets]);
	for (const name of project.invalidPresetNames) presets.delete(name);
	const discoveredPresets = [...presets.values()].map(createDiscoveryEntry).sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
	return {
		presets,
		discoveredPresets,
		invalidPresetNames: new Set([...user.invalidPresetNames, ...project.invalidPresetNames]),
		diagnostics: [...user.diagnostics, ...project.diagnostics],
		projectFileInvalid: project.projectFileInvalid,
	};
}

export function applyPresetDefaultModel(slots: DelegationLineupSlot[] | undefined, defaultModel: string | undefined): DelegationLineupSlot[] | undefined {
	if (!slots || !defaultModel) return slots?.map((slot) => ({ ...slot }));
	return slots.map((slot) => ({ ...slot, model: slot.model ?? defaultModel }));
}
