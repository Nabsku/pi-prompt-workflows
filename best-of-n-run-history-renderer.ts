import type { BestOfNRunHistoryResult } from "./best-of-n-run-history.js";

function sanitizeInline(value: string): string {
	return JSON.stringify(value).slice(1, -1).replace(/[\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function formatMaybe(value: unknown): string {
	if (value === undefined || value === null || value === "") return "unknown";
	if (typeof value === "boolean") return value ? "yes" : "no";
	return sanitizeInline(String(value));
}

function formatArtifactStatus(status: string): string {
	return status.replace(/-/g, " ");
}

export function formatBestOfNRunHistory(result: BestOfNRunHistoryResult): string {
	const lines: string[] = ["# Compare run history", "", `Root: ${sanitizeInline(result.root)}`, ""];
	for (const diagnostic of result.diagnostics) lines.push(`Warning: ${sanitizeInline(diagnostic)}`);
	if (result.diagnostics.length > 0) lines.push("");
	if (result.entries.length === 0) {
		lines.push("No best-of-N compare runs found.", "", "Run a compare prompt first; reports are written under `.pi/runs/best-of-n/`.");
		return `${lines.join("\n")}\n`;
	}

	for (const [index, run] of result.entries.entries()) {
		lines.push(`## ${index + 1}. ${sanitizeInline(run.name)}`);
		lines.push(`- Path: ${sanitizeInline(run.path)}`);
		lines.push(`- Report: ${sanitizeInline(run.reportPath)}`);
		lines.push(`- Status: ${formatMaybe(run.status)}`);
		lines.push(`- Prompt: ${formatMaybe(run.prompt)}`);
		lines.push(`- Preset: ${formatMaybe(run.preset)}`);
		lines.push(`- Commit policy: ${formatMaybe(run.commit)}`);
		lines.push(`- Worker calls: ${formatMaybe(run.workerCalls)}`);
		lines.push(`- Reviewer calls: ${formatMaybe(run.reviewerCalls)}`);
		lines.push(`- Final applier: ${formatMaybe(run.finalApplier)}`);
		lines.push(`- Raw artifacts retained: ${formatMaybe(run.keepArtifacts)}`);
		if (run.reportPreview) lines.push(`- Preview: ${sanitizeInline(run.reportPreview)}`);
		if (run.artifacts.length > 0) {
			lines.push("- Artifacts:");
			for (const artifact of run.artifacts) {
				const size = artifact.size !== undefined ? `, ${artifact.size} bytes` : "";
				const diagnostic = artifact.diagnostic ? ` — ${sanitizeInline(artifact.diagnostic)}` : "";
				lines.push(`  - ${sanitizeInline(artifact.name)}: ${formatArtifactStatus(artifact.status)}${size} (${sanitizeInline(artifact.path)})${diagnostic}`);
			}
		} else {
			lines.push("- Artifacts: none discovered");
		}
		for (const diagnostic of run.diagnostics) lines.push(`- Warning: ${sanitizeInline(diagnostic)}`);
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}
