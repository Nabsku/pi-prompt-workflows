import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DelegationLineupSlot, PromptLoaderDiagnostic, PromptSource } from "./prompt-loader.js";

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
	filePath: string;
}

export interface BestOfNPresetCatalog {
	presets: Map<string, ResolvedBestOfNPreset>;
	invalidPresetNames: Set<string>;
	diagnostics: PromptLoaderDiagnostic[];
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
	const reviewers = normalizePresetLineup(value.reviewers, "reviewers", name, filePath, source, diagnostics);
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
	const invalidPresetNames = new Set<string>();
	const diagnostics: PromptLoaderDiagnostic[] = [];
	if (!existsSync(filePath)) return { presets, invalidPresetNames, diagnostics };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf-8"));
	} catch (error) {
		diagnostics.push(createPresetDiagnostic("invalid-best-of-n-presets-file", filePath, source, `Skipping best-of-N presets file ${filePath}: ${error instanceof Error ? error.message : String(error)}.`));
		return { presets, invalidPresetNames, diagnostics };
	}
	if (!isRecord(parsed) || !isRecord(parsed.presets)) {
		diagnostics.push(createPresetDiagnostic("invalid-best-of-n-presets-file", filePath, source, `Skipping best-of-N presets file ${filePath}: expected top-level object with a "presets" object.`));
		return { presets, invalidPresetNames, diagnostics };
	}
	for (const [name, rawPreset] of Object.entries(parsed.presets)) {
		const preset = normalizePreset(name, rawPreset, filePath, source, diagnostics);
		if (!preset) {
			invalidPresetNames.add(name);
			continue;
		}
		presets.set(name, { name, source, filePath, ...preset });
	}
	return { presets, invalidPresetNames, diagnostics };
}

export function getBestOfNPresetPaths(cwd: string): { user: string; project: string } {
	return {
		user: join(homedir(), ".pi", "agent", "best-of-n-presets.json"),
		project: resolve(cwd, ".pi", "best-of-n-presets.json"),
	};
}

export function loadBestOfNPresetCatalog(cwd: string): BestOfNPresetCatalog {
	const paths = getBestOfNPresetPaths(cwd);
	const user = readPresetFile(paths.user, "user");
	const project = readPresetFile(paths.project, "project");
	const presets = new Map([...user.presets, ...project.presets]);
	for (const name of project.invalidPresetNames) presets.delete(name);
	return {
		presets,
		invalidPresetNames: new Set([...user.invalidPresetNames, ...project.invalidPresetNames]),
		diagnostics: [...user.diagnostics, ...project.diagnostics],
	};
}

export function applyPresetDefaultModel(slots: DelegationLineupSlot[] | undefined, defaultModel: string | undefined): DelegationLineupSlot[] | undefined {
	if (!slots || !defaultModel) return slots?.map((slot) => ({ ...slot }));
	return slots.map((slot) => ({ ...slot, model: slot.model ?? defaultModel }));
}
