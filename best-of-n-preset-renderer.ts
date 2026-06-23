import type { BestOfNPresetCatalog, BestOfNPresetDiscoveryEntry } from "./best-of-n-presets.js";
import { sanitizeForTerminal } from "./render-safe.js";

function sanitizeInline(value: string): string {
	return sanitizeForTerminal(value);
}

function formatMaybe(value: unknown): string {
	if (value === undefined || value === null || value === "") return "none";
	if (typeof value === "boolean") return value ? "yes" : "no";
	return sanitizeInline(String(value));
}

function formatPreset(entry: BestOfNPresetDiscoveryEntry): string[] {
	const lines = [`## ${sanitizeInline(entry.name)}`];
	lines.push(`- Source: ${sanitizeInline(entry.source)}`);
	lines.push(`- Source file: ${sanitizeInline(entry.filePath)}`);
	lines.push(`- Trust: ${sanitizeInline(entry.trustLabel)}`);
	lines.push(`- Default model: ${formatMaybe(entry.defaultModel)}`);
	lines.push(`- Max model calls: ${formatMaybe(entry.maxModelCalls)}`);
	lines.push(`- Workers: ${entry.workerCount}`);
	lines.push(`- Reviewers: ${entry.reviewerCount}`);
	lines.push(`- Final applier: ${formatMaybe(entry.hasFinalApplier)}`);
	if (entry.description) lines.push(`- Description: ${sanitizeInline(entry.description)}`);
	return lines;
}

export function formatBestOfNPresetCatalog(catalog: BestOfNPresetCatalog, cwd: string): string {
	const lines: string[] = ["# Compare presets", "", `Catalog cwd: ${sanitizeInline(cwd)}`, ""];
	for (const diagnostic of catalog.diagnostics) {
		lines.push(`Warning: ${sanitizeInline(diagnostic.message)}`);
	}
	if (catalog.diagnostics.length > 0) lines.push("");
	if (catalog.discoveredPresets.length === 0) {
		lines.push("No best-of-N compare presets found.", "", "Define presets in `~/.pi/agent/best-of-n-presets.json` or `.pi/best-of-n-presets.json`.");
		return `${lines.join("\n")}\n`;
	}
	for (const [index, entry] of catalog.discoveredPresets.entries()) {
		if (index > 0) lines.push("");
		lines.push(...formatPreset(entry));
	}
	return `${lines.join("\n").trimEnd()}\n`;
}
