import type { BestOfNRunHistoryEntry, BestOfNRunHistoryResult } from "./best-of-n-run-history.js";
import { sanitizeForTerminal } from "./render-safe.js";

function sanitizeInline(value: string): string {
	return sanitizeForTerminal(value);
}

function formatMaybe(value: unknown): string {
	if (value === undefined || value === null || value === "") return "unknown";
	if (typeof value === "boolean") return value ? "yes" : "no";
	return sanitizeInline(String(value));
}

function formatArtifactStatus(status: string): string {
	return status.replace(/-/g, " ");
}

function formatDate(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "unknown";
	return new Date(ms).toISOString();
}

function quoteSlashCommandArg(value: string): string {
	if (!/[\s"'\\]/.test(value)) return value;
	return JSON.stringify(value);
}

function cwdArg(result: BestOfNRunHistoryResult, commandCwd?: string): string {
	const historyCwd = result.cwd;
	if (!commandCwd || !historyCwd || historyCwd === commandCwd) return "";
	return ` --cwd ${quoteSlashCommandArg(historyCwd)}`;
}

function runInspectCommand(result: BestOfNRunHistoryResult, run: BestOfNRunHistoryEntry, commandCwd?: string): string {
	return `/compare-runs${cwdArg(result, commandCwd)} --id ${run.name}`;
}

function runPlainDetailCommand(result: BestOfNRunHistoryResult, run: BestOfNRunHistoryEntry, commandCwd?: string): string {
	return `/compare-runs --plain${cwdArg(result, commandCwd)} --id ${run.name}`;
}

function rawArtifactGuidance(run: BestOfNRunHistoryEntry): string | undefined {
	if (run.keepArtifacts === false) return "not retained; rerun the compare command with --keep-artifacts to keep raw worker/reviewer outputs.";
	return undefined;
}

function artifactExplanation(status: BestOfNRunHistoryEntry["artifacts"][number]["status"], maxBytes: number, path: string): string {
	if (status === "not-retained") return "not retained; rerun with --keep-artifacts to keep raw worker/reviewer outputs.";
	if (status === "missing") return "missing; the expected file is gone, only partially copied, or was manually cleaned up.";
	if (status === "rejected") return "rejected; safety refusal for a symlink, non-regular file, or path escape.";
	if (status === "truncated") return `truncated; preview is limited to ${maxBytes} bytes. Open the full file at ${path}.`;
	return `retained; full file path: ${path}.`;
}

function nextSteps(result: BestOfNRunHistoryResult, run: BestOfNRunHistoryEntry, commandCwd?: string): string[] {
	const steps = [
		`Open the report: ${run.reportPath}`,
		`Copyable detail command: ${runPlainDetailCommand(result, run, commandCwd)}`,
		"Browse recent runs: /compare-runs",
	];
	if (run.keepArtifacts === false || run.artifacts.some((artifact) => artifact.status === "not-retained")) steps.push("Need raw worker/reviewer output? Rerun the compare command with --keep-artifacts.");
	if (run.artifacts.some((artifact) => artifact.status === "missing")) steps.push("Missing artifacts mean the expected file is gone, partially copied, or manually cleaned up; rerun with --keep-artifacts if you need a complete set.");
	if (run.artifacts.some((artifact) => artifact.status === "rejected")) steps.push("Rejected artifacts were not read because they were unsafe filesystem entries; inspect the path manually only if you trust it.");
	if (run.artifacts.some((artifact) => artifact.status === "truncated")) steps.push("Truncated artifacts show only a bounded preview here; open the listed full-file path for the complete output.");
	return steps;
}

export function formatBestOfNRunHistory(result: BestOfNRunHistoryResult, options: { commandCwd?: string } = {}): string {
	const lines: string[] = ["# Compare run history", "", `Root: ${sanitizeInline(result.root)}`, ""];
	for (const diagnostic of result.diagnostics) lines.push(`Warning: ${sanitizeInline(diagnostic)}`);
	if (result.diagnostics.length > 0) lines.push("");
	if (result.entries.length === 0) {
		lines.push("No best-of-N compare runs found.", "", "Run a compare prompt first; reports are written under `.pi/runs/best-of-n/`.");
		return `${lines.join("\n")}\n`;
	}

	for (const [index, run] of result.entries.entries()) {
		lines.push(`## ${index + 1}. ${sanitizeInline(run.name)}`);
		lines.push(`- Run id: ${sanitizeInline(run.name)}`);
		lines.push(`- Modified: ${formatDate(run.mtimeMs)}`);
		lines.push(`- Path: ${sanitizeInline(run.path)}`);
		lines.push(`- Report: ${sanitizeInline(run.reportPath)}`);
		lines.push(`- Inspect: ${sanitizeInline(runInspectCommand(result, run, options.commandCwd))}`);
		lines.push(`- Plain detail: ${sanitizeInline(runPlainDetailCommand(result, run, options.commandCwd))}`);
		lines.push(`- Status: ${formatMaybe(run.status)}`);
		lines.push(`- Prompt: ${formatMaybe(run.prompt)}`);
		lines.push(`- Preset: ${formatMaybe(run.preset)}`);
		lines.push(`- Commit policy: ${formatMaybe(run.commit)}`);
		lines.push(`- Worker calls: ${formatMaybe(run.workerCalls)}`);
		lines.push(`- Reviewer calls: ${formatMaybe(run.reviewerCalls)}`);
		lines.push(`- Final applier: ${formatMaybe(run.finalApplier)}`);
		lines.push(`- Raw artifacts retained: ${formatMaybe(run.keepArtifacts)}`);
		const artifactGuidance = rawArtifactGuidance(run);
		if (artifactGuidance) lines.push(`- Raw artifact guidance: ${sanitizeInline(artifactGuidance)}`);
		if (run.reportPreview) lines.push(`- Preview: ${sanitizeInline(run.reportPreview)}`);
		if (run.artifacts.length > 0) {
			lines.push("- Artifacts:");
			for (const artifact of run.artifacts) {
				const size = artifact.size !== undefined ? `, ${artifact.size} bytes` : "";
				const diagnostic = artifact.diagnostic ? ` — ${sanitizeInline(artifact.diagnostic)}` : "";
				const explanation = artifactExplanation(artifact.status, result.maxBytes, artifact.path);
				lines.push(`  - ${sanitizeInline(artifact.name)}: ${formatArtifactStatus(artifact.status)}${size} (${sanitizeInline(artifact.path)}) — ${sanitizeInline(explanation)}${diagnostic}`);
			}
		} else {
			lines.push("- Artifacts: none discovered");
		}
		for (const diagnostic of run.diagnostics) lines.push(`- Warning: ${sanitizeInline(diagnostic)}`);
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

export function formatBestOfNRunDetail(result: BestOfNRunHistoryResult, run: BestOfNRunHistoryEntry, options: { commandCwd?: string } = {}): string {
	const lines: string[] = ["# Compare run detail", "", `Root: ${sanitizeInline(result.root)}`, `Run: ${sanitizeInline(run.name)}`, ""];
	for (const diagnostic of result.diagnostics) lines.push(`Warning: ${sanitizeInline(diagnostic)}`);
	for (const diagnostic of run.diagnostics) lines.push(`Warning: ${sanitizeInline(diagnostic)}`);
	if (result.diagnostics.length > 0 || run.diagnostics.length > 0) lines.push("");
	lines.push("## Summary");
	lines.push(`- Run id: ${sanitizeInline(run.name)}`);
	lines.push(`- Modified: ${formatDate(run.mtimeMs)}`);
	lines.push(`- Path: ${sanitizeInline(run.path)}`);
	lines.push(`- Report: ${sanitizeInline(run.reportPath)}`);
	lines.push(`- Preview limit: ${result.maxBytes} bytes`);
	lines.push(`- Inspect: ${sanitizeInline(runInspectCommand(result, run, options.commandCwd))}`);
	lines.push(`- Plain detail: ${sanitizeInline(runPlainDetailCommand(result, run, options.commandCwd))}`);
	lines.push("- Browse recent: /compare-runs");
	lines.push(`- Status: ${formatMaybe(run.status)}`);
	lines.push(`- Prompt: ${formatMaybe(run.prompt)}`);
	lines.push(`- Preset: ${formatMaybe(run.preset)}`);
	lines.push(`- Commit policy: ${formatMaybe(run.commit)}`);
	lines.push(`- Worker calls: ${formatMaybe(run.workerCalls)}`);
	lines.push(`- Reviewer calls: ${formatMaybe(run.reviewerCalls)}`);
	lines.push(`- Final applier: ${formatMaybe(run.finalApplier)}`);
	lines.push(`- Raw artifacts retained: ${formatMaybe(run.keepArtifacts)}`);
	const artifactGuidance = rawArtifactGuidance(run);
	if (artifactGuidance) lines.push(`- Raw artifact guidance: ${sanitizeInline(artifactGuidance)}`);
	lines.push("", "## Next steps");
	for (const step of nextSteps(result, run, options.commandCwd)) lines.push(`- ${sanitizeInline(step)}`);
	lines.push("", "## Lineup", run.lineupText ? sanitizeForTerminal(run.lineupText, { preserveLineBreaks: true }) : "lineup.json is unavailable or invalid. See diagnostics.");
	lines.push("", "## Report", run.reportText ? sanitizeForTerminal(run.reportText, { preserveLineBreaks: true }) : "report.md is unavailable. See diagnostics.");
	lines.push("", "## Artifacts");
	if (run.artifacts.length === 0) {
		lines.push("No artifacts discovered.");
	} else {
		for (const artifact of run.artifacts) {
			const size = artifact.size !== undefined ? `, ${artifact.size} bytes` : "";
			const diagnostic = artifact.diagnostic ? ` — ${sanitizeInline(artifact.diagnostic)}` : "";
			const explanation = artifactExplanation(artifact.status, result.maxBytes, artifact.path);
			lines.push(`### ${sanitizeInline(artifact.name)}`);
			lines.push(`${formatArtifactStatus(artifact.status)}${size} (${sanitizeInline(artifact.path)}) — ${sanitizeInline(explanation)}${diagnostic}`);
			if (artifact.previewText) lines.push("", sanitizeForTerminal(artifact.previewText, { preserveLineBreaks: true }));
		}
	}
	lines.push("", "## Diagnostics");
	const diagnostics = [...result.diagnostics, ...run.diagnostics];
	lines.push(...(diagnostics.length ? diagnostics.map((diagnostic) => `- ${sanitizeInline(diagnostic)}`) : ["No diagnostics."]));
	return `${lines.join("\n").trimEnd()}\n`;
}
