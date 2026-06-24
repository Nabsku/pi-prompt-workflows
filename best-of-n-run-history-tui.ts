import { decodeKittyPrintable, Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { BestOfNArtifactEntry, BestOfNRunHistoryEntry, BestOfNRunHistoryResult } from "./best-of-n-run-history.js";
import { sanitizeForTerminal, truncateForTerminalWidth } from "./render-safe.js";

export interface CompareRunCatalogItem {
	id: string;
	name: string;
	status?: string;
	prompt?: string;
	preset?: string;
	mtimeMs: number;
	diagnosticCount: number;
}

export type CompareRunHistoryTuiResult =
	| { action: "closed" }
	| { action: "back" }
	| { action: "refresh" }
	| { action: "selected"; runId: string };

const PICKER_VISIBLE_ROWS = 18;
const PANE_NAMES = ["Summary", "Next steps", "Report", "Lineup", "Artifacts", "Diagnostics"] as const;
type PaneName = typeof PANE_NAMES[number];

function lineSafe(line: string, width: number): string {
	return truncateForTerminalWidth(sanitizeForTerminal(line), Math.max(1, width), { marker: "…" });
}

function linesSafe(lines: string[], width: number): string[] {
	return lines.map((line) => lineSafe(line, width));
}

function formatMaybe(value: unknown): string {
	if (value === undefined || value === null || value === "") return "unknown";
	if (typeof value === "boolean") return value ? "yes" : "no";
	return sanitizeForTerminal(String(value));
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

function runPlainDetailCommand(result: BestOfNRunHistoryResult, run: BestOfNRunHistoryEntry, commandCwd?: string): string {
	return `/compare-runs --plain${cwdArg(result, commandCwd)} --id ${run.name}`;
}

function artifactExplanation(artifact: BestOfNArtifactEntry, maxBytes: number): string {
	if (artifact.status === "not-retained") return "not retained; rerun with --keep-artifacts to keep raw worker/reviewer outputs.";
	if (artifact.status === "missing") return "missing; expected file is gone, partially copied, or manually cleaned up.";
	if (artifact.status === "rejected") return "rejected; safety refusal for symlink, non-regular file, or path escape.";
	if (artifact.status === "truncated") return `truncated; preview limit is ${maxBytes} bytes, open full file at ${artifact.path}.`;
	return `retained; full file path: ${artifact.path}.`;
}

function nextSteps(result: BestOfNRunHistoryResult, run: BestOfNRunHistoryEntry, commandCwd?: string): string {
	const lines = [
		`Open report: ${run.reportPath}`,
		`Plain detail: ${runPlainDetailCommand(result, run, commandCwd)}`,
		"Browse/refresh: /compare-runs, or press b then r in this TUI.",
	];
	if (run.keepArtifacts === false || run.artifacts.some((artifact) => artifact.status === "not-retained")) lines.push("Need raw worker/reviewer outputs? Rerun with --keep-artifacts.");
	if (run.artifacts.some((artifact) => artifact.status === "missing")) lines.push("Missing artifacts usually mean partial copy or manual cleanup; rerun from the same cwd if needed.");
	if (run.artifacts.some((artifact) => artifact.status === "rejected")) lines.push("Rejected artifacts were not read for filesystem safety; inspect manually only if trusted.");
	if (run.artifacts.some((artifact) => artifact.status === "truncated")) lines.push("Truncated previews are bounded here; open the listed full-file paths for complete output.");
	return lines.map((line) => `- ${sanitizeForTerminal(line)}`).join("\n");
}

export function buildCompareRunCatalog(result: BestOfNRunHistoryResult): CompareRunCatalogItem[] {
	return result.entries.map((entry) => ({
		id: entry.name,
		name: entry.name,
		status: entry.status,
		prompt: entry.prompt,
		preset: entry.preset,
		mtimeMs: entry.mtimeMs,
		diagnosticCount: entry.diagnostics.length,
	}));
}

function formatArtifactSummary(artifact: BestOfNArtifactEntry, maxBytes: number): string {
	const size = artifact.size !== undefined ? `, ${artifact.size} bytes` : "";
	const diagnostic = artifact.diagnostic ? ` — ${sanitizeForTerminal(artifact.diagnostic)}` : "";
	return `- ${sanitizeForTerminal(artifact.name)}: ${artifact.status.replace(/-/g, " ")}${size} (${sanitizeForTerminal(artifact.path)}) — ${artifactExplanation(artifact, maxBytes)}${diagnostic}`;
}

export interface CompareRunDetailViewModel {
	result: BestOfNRunHistoryResult;
	run: BestOfNRunHistoryEntry;
	panes: {
		summary: string;
		lineup: string;
		report: string;
		nextSteps: string;
		artifacts: string;
		diagnostics: string;
	};
}

export function createCompareRunDetailViewModel(result: BestOfNRunHistoryResult, run: BestOfNRunHistoryEntry, options: { commandCwd?: string } = {}): CompareRunDetailViewModel {
	const summary = [
		`Run: ${sanitizeForTerminal(run.name)}`,
		`Path: ${sanitizeForTerminal(run.path)}`,
		`Modified: ${formatDate(run.mtimeMs)}`,
		`Report: ${sanitizeForTerminal(run.reportPath)}`,
		`Preview limit: ${result.maxBytes} bytes`,
		`Status: ${formatMaybe(run.status)}`,
		`Prompt: ${formatMaybe(run.prompt)}`,
		`Preset: ${formatMaybe(run.preset)}`,
		`Commit policy: ${formatMaybe(run.commit)}`,
		`Worker calls: ${formatMaybe(run.workerCalls)}`,
		`Reviewer calls: ${formatMaybe(run.reviewerCalls)}`,
		`Final applier: ${formatMaybe(run.finalApplier)}`,
		`Raw artifacts retained: ${formatMaybe(run.keepArtifacts)}`,
	].join("\n");
	const lineup = run.lineupText
		? sanitizeForTerminal(run.lineupText, { preserveLineBreaks: true })
		: "lineup.json is unavailable or invalid. See diagnostics.";
	const report = run.reportText
		? sanitizeForTerminal(run.reportText, { preserveLineBreaks: true })
		: "report.md is unavailable. See diagnostics.";
	const artifacts = run.artifacts.length
		? run.artifacts.flatMap((artifact) => [
			formatArtifactSummary(artifact, result.maxBytes),
			...(artifact.previewText ? [sanitizeForTerminal(artifact.previewText, { preserveLineBreaks: true })] : []),
		]).join("\n")
		: "No artifacts discovered.";
	const diagnostics = [
		...result.diagnostics.map((diagnostic) => `History: ${sanitizeForTerminal(diagnostic)}`),
		...run.diagnostics.map((diagnostic) => `Run: ${sanitizeForTerminal(diagnostic)}`),
	];
	return {
		result,
		run,
		panes: {
			summary,
			nextSteps: nextSteps(result, run, options.commandCwd),
			lineup,
			report,
			artifacts,
			diagnostics: diagnostics.length ? diagnostics.join("\n") : "No diagnostics.",
		},
	};
}

export class CompareRunPicker implements Component {
	private search = "";
	private selectedIndex = 0;

	constructor(
		readonly catalog: CompareRunCatalogItem[],
		readonly initialRunId?: string,
		readonly tui?: unknown,
		readonly theme?: unknown,
		readonly done?: (value: CompareRunHistoryTuiResult) => void,
	) {
		const initial = this.filteredCatalog().findIndex((item) => item.id === initialRunId);
		if (initial >= 0) this.selectedIndex = initial;
	}

	private filteredCatalog(): CompareRunCatalogItem[] {
		const needle = this.search.trim().toLowerCase();
		if (!needle) return this.catalog;
		return this.catalog.filter((item) => [item.name, item.status, item.prompt, item.preset]
			.filter(Boolean)
			.some((value) => String(value).toLowerCase().includes(needle)));
	}

	render(width: number): string[] {
		const items = this.filteredCatalog();
		if (this.selectedIndex >= items.length) this.selectedIndex = Math.max(0, items.length - 1);
		const lines = [
			"Compare run history",
			"Pick a recent run to inspect read-only details",
			`search: ${this.search || "(type to filter)"}`,
			"",
		];
		if (!items.length) {
			lines.push("No compare runs match your search.");
		} else {
			const visibleRows = Math.min(PICKER_VISIBLE_ROWS, items.length);
			let windowStart = Math.max(0, this.selectedIndex - Math.floor(visibleRows / 2));
			windowStart = Math.min(windowStart, Math.max(0, items.length - visibleRows));
			const windowEnd = Math.min(items.length, windowStart + visibleRows);
			if (windowStart > 0) lines.push(`… ${windowStart} earlier run${windowStart === 1 ? "" : "s"}`);
			for (let index = windowStart; index < windowEnd; index += 1) {
				const item = items[index]!;
				const marker = index === this.selectedIndex ? ">" : " ";
				const diagnostics = item.diagnosticCount ? ` · ⚠ ${item.diagnosticCount}` : "";
				lines.push(`${marker} ${item.name}  ${formatDate(item.mtimeMs)} · ${formatMaybe(item.status)} · ${formatMaybe(item.prompt)} · ${formatMaybe(item.preset)}${diagnostics}`);
			}
			const remaining = items.length - windowEnd;
			if (remaining > 0) lines.push(`… ${remaining} later run${remaining === 1 ? "" : "s"}`);
		}
		lines.push("", "Enter: inspect  ↑/↓: move  Backspace: edit  r: refresh  Esc/q: quit");
		return linesSafe(lines, width);
	}

	handleInput(data: string): void {
		const items = this.filteredCatalog();
		if ((this.search.length === 0 && matchesKey(data, "q")) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done?.({ action: "closed" });
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\n") {
			const item = items[this.selectedIndex];
			if (item) this.done?.({ action: "selected", runId: item.id });
			return;
		}
		if (this.search.length === 0 && matchesKey(data, "r")) {
			this.done?.({ action: "refresh" });
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.search = this.search.slice(0, -1);
			this.selectedIndex = 0;
			return;
		}
		if (matchesKey(data, "j") || matchesKey(data, Key.down)) this.selectedIndex = Math.min(items.length - 1, this.selectedIndex + 1);
		else if (matchesKey(data, "k") || matchesKey(data, Key.up)) this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		else {
			const printable = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " && data !== "\u007f" ? data : undefined);
			if (printable !== undefined) {
				this.search += printable;
				this.selectedIndex = 0;
			}
		}
	}

	invalidate(): void {}
}

export class CompareRunDetailInspector implements Component {
	private paneIndex = 2;
	private scroll = 0;

	constructor(
		readonly viewModel: CompareRunDetailViewModel,
		readonly tui?: unknown,
		readonly theme?: unknown,
		readonly done?: (value: CompareRunHistoryTuiResult) => void,
	) {}

	private activePane(): PaneName {
		return PANE_NAMES[this.paneIndex]!;
	}

	private paneText(): string {
		const key = this.activePane() === "Next steps"
			? "nextSteps"
			: this.activePane().toLowerCase() as keyof CompareRunDetailViewModel["panes"];
		return this.viewModel.panes[key];
	}

	render(width: number): string[] {
		const diagnostics = this.viewModel.result.diagnostics.length + this.viewModel.run.diagnostics.length;
		const tabLine = PANE_NAMES.map((name, index) => index === this.paneIndex ? `[${name}]` : name).join("  ");
		const paneLines = this.paneText().split("\n");
		const body = paneLines.slice(this.scroll, this.scroll + 18);
		const lines = [
			`Compare run: ${this.viewModel.run.name}${diagnostics ? `  ⚠ ${diagnostics} diagnostic${diagnostics === 1 ? "" : "s"}` : ""}`,
			tabLine,
			"",
			...body,
			"",
			`pane ${this.paneIndex + 1}/${PANE_NAMES.length} · line ${Math.min(this.scroll + 1, paneLines.length)}/${paneLines.length} · j/down scroll · tab next · b back · r refresh · q quit`,
		];
		return linesSafe(lines, width);
	}

	handleInput(data: string): void {
		const printable = decodeKittyPrintable(data);
		if (data === "q" || printable === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done?.({ action: "closed" });
			return;
		}
		if (data === "b" || printable === "b") {
			this.done?.({ action: "back" });
			return;
		}
		if (data === "r" || printable === "r") {
			this.done?.({ action: "refresh" });
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.paneIndex = (this.paneIndex + 1) % PANE_NAMES.length;
			this.scroll = 0;
			return;
		}
		const paneKey = Array.from({ length: PANE_NAMES.length }, (_, index) => String(index + 1)).find((key) => data === key || printable === key);
		if (paneKey) {
			this.paneIndex = Number(paneKey) - 1;
			this.scroll = 0;
			return;
		}
		if (data === "j" || printable === "j" || matchesKey(data, Key.down)) {
			this.scroll = Math.min(this.scroll + 1, Math.max(0, this.paneText().split("\n").length - 1));
		} else if (data === "k" || printable === "k" || matchesKey(data, Key.up)) {
			this.scroll = Math.max(0, this.scroll - 1);
		}
	}

	invalidate(): void {}
}
