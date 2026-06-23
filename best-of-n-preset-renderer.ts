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

function formatUsePresetCommand(promptName: string, presetName: string, dryRun: boolean, keepArtifacts = false): string {
	const command = dryRun ? "dry-run-prompt" : promptName;
	const promptArg = dryRun ? `${promptName} ` : "";
	const plain = dryRun ? " --plain" : "";
	const artifactRetention = keepArtifacts ? " --keep-artifacts" : "";
	return `/${command} ${promptArg}--preset ${presetName}${plain}${artifactRetention} <task>`;
}

function trustDescription(entry: BestOfNPresetDiscoveryEntry): string {
	if (entry.source === "project") {
		return "project preset; approval is required for this compare cwd/session. Project presets can choose worker/reviewer agents, models, counts, cost, and concurrency.";
	}
	return "user config; no project preset approval required. This does not mean the preset is audited safe.";
}

function promptPolicyDescription(): string {
	return "prompt still owns task, cwd/worktree, final-applier, and commit policy.";
}

function formatLineupSlot(slot: { agent?: string; model?: string; count?: number }, index: number): string {
	const repeat = slot.count && slot.count > 1 ? `${slot.count}x ` : "";
	const agent = sanitizeInline(slot.agent ?? "default");
	const model = slot.model ? ` @ ${sanitizeInline(slot.model)}` : "";
	return `${index + 1}:${repeat}${agent}${model}`;
}

function formatLineup(slots: Array<{ agent?: string; model?: string; count?: number }> | undefined): string {
	if (!slots || slots.length === 0) return "none";
	return slots.map(formatLineupSlot).join("; ");
}

function formatPreset(entry: BestOfNPresetDiscoveryEntry): string[] {
	const lines = [`## ${sanitizeInline(entry.name)}`];
	lines.push(`- Source: ${sanitizeInline(entry.source)}`);
	lines.push(`- Source file: ${sanitizeInline(entry.filePath)}`);
	lines.push(`- Trust: ${sanitizeInline(trustDescription(entry))}`);
	lines.push(`- Prompt policy: ${sanitizeInline(promptPolicyDescription())}`);
	lines.push(`- Default model: ${formatMaybe(entry.defaultModel)}`);
	lines.push(`- Max model calls: ${formatMaybe(entry.maxModelCalls)}`);
	lines.push(`- Workers: ${entry.workerCount}`);
	lines.push(`- Worker lineup: ${formatLineup(entry.preset.workers)}`);
	lines.push(`- Reviewers: ${entry.reviewerCount}`);
	lines.push(`- Reviewer lineup: ${formatLineup(entry.preset.reviewers)}`);
	lines.push(`- Final applier: ${formatMaybe(entry.hasFinalApplier)}`);
	lines.push("- Use:");
	lines.push(`  - Dry run (read-only): ${formatUsePresetCommand("best-of-n", entry.name, true)}`);
	lines.push(`  - Execute (retains evidence artifacts): ${formatUsePresetCommand("best-of-n", entry.name, false, true)}`);
	lines.push(`  - Execute (summary-only, fewer local artifacts): ${formatUsePresetCommand("best-of-n", entry.name, false)}`);
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
