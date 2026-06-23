import { decodeKittyPrintable, Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { PromptDryRunResult } from "./prompt-dry-run.js";
import type { PromptIncludeGraph, PromptIncludeGraphEdge, PromptIncludeGraphNode } from "./prompt-includes.js";
import type { PromptLoaderDiagnostic } from "./prompt-loader.js";
import { sanitizeForTerminal, truncateForTerminalWidth } from "./render-safe.js";

export interface PromptTemplateCatalogItem {
	name: string;
	source: "project" | "user" | "reserved";
	displaySource: string;
	file?: string;
	description?: string;
	model?: string;
	skillCount?: number;
	unsupportedReason?: string;
	skills?: string[];
}

export interface PromptDryRunTuiViewModel {
	result: PromptDryRunResult;
	plainReport: string;
	panes: {
		prompt: string;
		metadata: string;
		compare: string;
		skills: string;
		includes: string;
		warnings: string;
		raw: string;
	};
}

export type PromptDryRunTuiResult =
	| { action: "closed" }
	| { action: "back" }
	| { action: "selected"; templateName: string };

const PICKER_VISIBLE_ROWS = 18;

function lineSafe(line: string, width: number): string {
	return truncateForTerminalWidth(line, Math.max(1, width), { marker: "…" });
}

function linesSafe(lines: string[], width: number): string[] {
	return lines.map((line) => lineSafe(line, width));
}

function modelLabel(result: PromptDryRunResult): string {
	if (result.status !== "ok") return "n/a";
	const model = result.model as { provider?: string; id?: string } | string | undefined;
	if (typeof model === "string") return model;
	return [model?.provider, model?.id].filter(Boolean).join("/") || "n/a";
}

function formatCompare(result: PromptDryRunResult): string {
	if (result.status !== "ok" || !result.comparePreflight) return "No compare preflight.";
	const preflight = result.comparePreflight;
	const lines = [
		"# Compare preflight",
		`Prompt: ${preflight.prompt.name}`,
		`Compare cwd: ${preflight.compareCwd.resolved} (${preflight.compareCwd.source})`,
		`Preset: ${preflight.preset ? `${preflight.preset.name} (${preflight.preset.trust})` : "none"}`,
		`Calls: workers=${preflight.callCount.workers} reviewers=${preflight.callCount.reviewers} final-applier=${preflight.callCount.finalApplier} total=${preflight.callCount.total} cap=${preflight.callCount.cap ?? "uncapped"} ${preflight.callCount.capStatus}`,
		`Policy: worktree=${preflight.policies.worktree.enabled} final-applier=${preflight.policies.finalApplier.enabled} commit=${preflight.policies.commit.mode}`,
		`Report root: ${preflight.artifacts.report.root ?? "n/a"}`,
		"",
		"## Slots",
		...preflight.slots.workers.map((slot) => `- worker ${slot.index}: agent=${slot.agent ?? "delegate"} model=${slot.effectiveModelLabel} cwd=${slot.cwd} source=${slot.source}`),
		...preflight.slots.reviewers.map((slot) => `- reviewer ${slot.index}: agent=${slot.agent ?? "reviewer"} model=${slot.effectiveModelLabel} cwd=${slot.cwd} source=${slot.source}`),
		...(preflight.slots.finalApplier ? [`- final-applier 1: agent=${preflight.slots.finalApplier.agent ?? "delegate"} model=${preflight.slots.finalApplier.effectiveModelLabel} cwd=${preflight.slots.finalApplier.cwd} source=${preflight.slots.finalApplier.source}`] : []),
		"",
		"## Diagnostics",
		...(preflight.diagnostics.length ? preflight.diagnostics.map((diagnostic) => `- ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`) : ["No compare diagnostics."]),
	];
	return sanitizeForTerminal(lines.join("\n"), { preserveLineBreaks: true });
}

function formatRuntime(result: PromptDryRunResult): string[] {
	const runtime = result.runtime;
	if (!runtime) return ["Runtime: n/a"];
	return [
		`cwd: ${runtime.cwd ?? "(session cwd)"}`,
		`restore: ${runtime.restore ?? false}`,
		`boomerang: ${runtime.boomerang ?? false}`,
		...(runtime.thinking ? [`thinking: ${runtime.thinking}`] : []),
		...(runtime.loop ? [`loop: ${runtime.loop.count ?? "∞"} fresh=${runtime.loop.fresh} converge=${runtime.loop.converge}`] : []),
		...(runtime.delegation ? [`delegation: ${runtime.delegation.agent ?? "default"}`] : []),
	];
}

function formatSkills(result: PromptDryRunResult): string {
	const skills = result.status === "ok" ? result.skills : [];
	if (!skills.length) return "No skills requested.";
	const lines: string[] = [];
	for (const skill of skills) {
		lines.push(`- ${skill.skillName} (${skill.skillPath})`);
		if (skill.skillContent !== undefined) {
			lines.push(skill.skillContent);
		} else {
			lines.push("  full skill content hidden; rerun with --show-skills to preview it");
		}
	}
	return lines.join("\n");
}

function lexicalCompare(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function diagnosticKey(diagnostic: PromptLoaderDiagnostic): string {
	return diagnostic.key || `${diagnostic.code}:${diagnostic.source}:${diagnostic.filePath}:${diagnostic.message}`;
}

function sortDiagnostics(diagnostics: PromptLoaderDiagnostic[]): PromptLoaderDiagnostic[] {
	return [...diagnostics].sort((a, b) => lexicalCompare(a.filePath, b.filePath) || lexicalCompare(a.code, b.code) || lexicalCompare(a.message, b.message));
}

function sortIncludeGraphEdges(edges: PromptIncludeGraphEdge[]): PromptIncludeGraphEdge[] {
	return [...edges].sort((a, b) => a.order - b.order || lexicalCompare(a.fromNodeId, b.fromNodeId) || lexicalCompare(a.toNodeId, b.toNodeId) || lexicalCompare(a.includePath, b.includePath));
}

function includeGraphNodeLabel(nodes: Map<string, PromptIncludeGraphNode>, nodeId: string): string {
	const node = nodes.get(nodeId);
	if (!node) return nodeId;
	if (node.filePath) return node.filePath;
	if (node.includePath) return `unresolved:${node.includePath}`;
	return node.id;
}

function formatIncludeDiagnostic(prefix: string, diagnostic: PromptLoaderDiagnostic): string {
	return `${prefix}${diagnostic.code}: ${diagnostic.message}`;
}

function rootOnlyIncludeDiagnostics(graph: PromptIncludeGraph): PromptLoaderDiagnostic[] {
	const edgeDiagnosticKeys = new Set(graph.edges.flatMap((edge) => edge.diagnostics.map(diagnosticKey)));
	return graph.diagnostics.filter((diagnostic) => !edgeDiagnosticKeys.has(diagnosticKey(diagnostic)));
}

function formatIncludes(result: PromptDryRunResult): string {
	const graph = result.status === "ok" ? result.includeGraph : undefined;
	if (!graph) return "No includes.";

	const rootDiagnostics = sortDiagnostics(rootOnlyIncludeDiagnostics(graph));
	if (graph.edges.length === 0 && rootDiagnostics.length === 0) return "No includes.";

	const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
	const rootNode = graph.nodes.find((node) => node.kind === "prompt" && node.filePath === graph.root.filePath);
	const rootStatus = rootNode?.status ?? (rootDiagnostics.length ? "failed" : "ok");
	const lines = [`- ${graph.root.promptName} [${rootStatus}] ${graph.root.filePath}`];

	for (const diagnostic of rootDiagnostics) {
		lines.push(formatIncludeDiagnostic("  ! ", diagnostic));
	}

	for (const edge of sortIncludeGraphEdges(graph.edges)) {
		const from = includeGraphNodeLabel(nodes, edge.fromNodeId);
		const to = includeGraphNodeLabel(nodes, edge.toNodeId);
		lines.push(`  - ${from} -> ${to} (${edge.kind} ${edge.includePath}) [${edge.status}]`);
		for (const diagnostic of sortDiagnostics(edge.diagnostics)) {
			lines.push(formatIncludeDiagnostic("    ! ", diagnostic));
		}
	}

	return lines.join("\n");
}

export function createPromptDryRunTuiViewModel(result: PromptDryRunResult, plainReport: string): PromptDryRunTuiViewModel {
	const warnings = result.warnings.length ? result.warnings.map((warning) => `- ${sanitizeForTerminal(warning)}`).join("\n") : "No warnings.";
	const prompt = result.status === "ok" ? `# Prompt body\n${sanitizeForTerminal(result.content, { preserveLineBreaks: true })}` : `# Error\n${sanitizeForTerminal(result.error, { preserveLineBreaks: true })}`;
	const metadata = [
		`Prompt: ${sanitizeForTerminal(result.promptName)}`,
		`Status: ${result.status}`,
		`Model: ${sanitizeForTerminal(modelLabel(result))}`,
		...(result.status === "ok" ? [`Arguments: ${result.args.length ? result.args.map((arg) => sanitizeForTerminal(arg)).join(" ") : "(none)"}`] : []),
		...formatRuntime(result),
	].join("\n");
	return {
		result,
		plainReport,
		panes: {
			prompt,
			metadata,
			compare: formatCompare(result),
			skills: formatSkills(result),
			includes: formatIncludes(result),
			warnings,
			raw: plainReport,
		},
	};
}

export class PromptDryRunPicker implements Component {
	private search = "";
	private selectedIndex = 0;

	constructor(
		readonly catalog: PromptTemplateCatalogItem[],
		readonly initialTemplateName: string | undefined,
		readonly tui?: unknown,
		readonly theme?: unknown,
		readonly done?: (value: PromptDryRunTuiResult) => void,
	) {
		const initial = this.filteredCatalog().findIndex((item) => item.name === initialTemplateName);
		if (initial >= 0) this.selectedIndex = initial;
	}

	private filteredCatalog(): PromptTemplateCatalogItem[] {
		const needle = this.search.trim().toLowerCase();
		if (!needle) return this.catalog;
		return this.catalog.filter((item) => [item.name, item.description, item.file, item.model, ...(item.skills ?? [])]
			.filter(Boolean)
			.some((value) => String(value).toLowerCase().includes(needle)));
	}

	render(width: number): string[] {
		const items = this.filteredCatalog();
		if (this.selectedIndex >= items.length) this.selectedIndex = Math.max(0, items.length - 1);
		const lines = [
			"Prompt dry-run",
			"Pick a prompt template to inspect without execution",
			`search: ${this.search || "(type to filter)"}`,
			"",
		];
		if (!items.length) {
			lines.push("No templates match your search.");
		} else {
			const visibleRows = Math.min(PICKER_VISIBLE_ROWS, items.length);
			let windowStart = Math.max(0, this.selectedIndex - Math.floor(visibleRows / 2));
			windowStart = Math.min(windowStart, Math.max(0, items.length - visibleRows));
			const windowEnd = Math.min(items.length, windowStart + visibleRows);
			if (windowStart > 0) lines.push(`… ${windowStart} earlier template${windowStart === 1 ? "" : "s"}`);
			for (let index = windowStart; index < windowEnd; index++) {
				const item = items[index]!;
				const marker = index === this.selectedIndex ? ">" : " ";
				const unsupported = item.unsupportedReason ? ` — unsupported: ${item.unsupportedReason}` : "";
				const skills = item.skillCount !== undefined ? ` · ${item.skillCount} skill${item.skillCount === 1 ? "" : "s"}` : "";
				const description = item.description ? ` — ${item.description}` : "";
				lines.push(`${marker} ${item.name}  ${item.displaySource}${skills}${description}${unsupported}`);
			}
			const remaining = items.length - windowEnd;
			if (remaining > 0) lines.push(`… ${remaining} later template${remaining === 1 ? "" : "s"}`);
		}
		lines.push("", "Enter: inspect  ↑/↓: move  Backspace: edit  Esc/q: quit");
		return linesSafe(lines, width);
	}

	handleInput(data: string): void {
		const items = this.filteredCatalog();
		if (matchesKey(data, "q") || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done?.({ action: "closed" });
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\n") {
			const item = items[this.selectedIndex];
			if (item) this.done?.({ action: "selected", templateName: item.name });
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

const PANE_NAMES = ["Prompt", "Metadata", "Compare", "Skills", "Includes", "Warnings", "Raw"] as const;
type PaneName = typeof PANE_NAMES[number];

export class PromptDryRunInspector implements Component {
	private paneIndex = 0;
	private scroll = 0;

	constructor(
		readonly viewModel: PromptDryRunTuiViewModel,
		readonly tui?: unknown,
		readonly theme?: unknown,
		readonly done?: (value: PromptDryRunTuiResult) => void,
	) {}

	private activePane(): PaneName {
		return PANE_NAMES[this.paneIndex]!;
	}

	private paneText(): string {
		const key = this.activePane().toLowerCase() as keyof PromptDryRunTuiViewModel["panes"];
		return this.viewModel.panes[key];
	}

	render(width: number): string[] {
		const result = this.viewModel.result;
		const warnings = result.warnings.length;
		const skills = result.status === "ok" ? result.skills.map((skill) => skill.skillName).join(", ") : "";
		const tabLine = PANE_NAMES.map((name, index) => index === this.paneIndex ? `[${name}]` : name).join("  ");
		const paneLines = this.paneText().split("\n");
		const body = paneLines.slice(this.scroll, this.scroll + 18);
		const skillSummary = this.viewModel.panes.skills.split("\n").slice(0, 8);
		const lines = [
			`Prompt dry-run: ${result.promptName}${warnings ? `  ⚠ ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`,
			tabLine,
			...(skills ? [`Skills: ${skills}`, ...skillSummary] : []),
			"",
			...body,
			"",
			`pane ${this.paneIndex + 1}/${PANE_NAMES.length} · line ${Math.min(this.scroll + 1, paneLines.length)}/${paneLines.length} · j/down scroll · tab next · b back · q quit`,
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
