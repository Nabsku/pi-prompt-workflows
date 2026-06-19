import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { PromptDryRunResult } from "./prompt-dry-run.js";

export interface PromptTemplateCatalogItem {
	name: string;
	source: "project" | "user" | "reserved";
	displaySource: "project" | "user" | "reserved";
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
		skills: string;
		warnings: string;
		raw: string;
	};
}

export interface PromptDryRunTuiResult {
	action: "closed" | "selected" | "back";
	templateName?: string;
}

const ANSI_ESCAPE_PATTERN = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000d\u000e-\u001f\u007f-\u009f]/g;

function sanitizeText(value: string): string {
	return value
		.replace(ANSI_ESCAPE_PATTERN, "")
		.replace(CONTROL_PATTERN, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function lineSafe(line: string, width: number): string {
	return truncateToWidth(sanitizeText(line), Math.max(1, width));
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
		if (skill.skillContent) {
			lines.push(skill.skillContent);
		} else {
			lines.push("  full skill content hidden; rerun with --show-skills to preview it");
		}
	}
	return lines.join("\n");
}

export function createPromptDryRunTuiViewModel(result: PromptDryRunResult, plainReport: string): PromptDryRunTuiViewModel {
	const warnings = result.warnings.length ? result.warnings.map((warning) => `- ${warning}`).join("\n") : "No warnings.";
	const prompt = result.status === "ok" ? `# Prompt body\n${result.content}` : `# Error\n${result.error}`;
	const metadata = [
		`Prompt: ${result.promptName}`,
		`Status: ${result.status}`,
		`Model: ${modelLabel(result)}`,
		...(result.status === "ok" ? [`Arguments: ${result.args.length ? result.args.join(" ") : "(none)"}`] : []),
		...formatRuntime(result),
	].join("\n");
	return {
		result,
		plainReport,
		panes: {
			prompt,
			metadata,
			skills: formatSkills(result),
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
			for (const [index, item] of items.entries()) {
				const marker = index === this.selectedIndex ? ">" : " ";
				const unsupported = item.unsupportedReason ? ` — unsupported: ${item.unsupportedReason}` : "";
				const skills = item.skillCount !== undefined ? ` · ${item.skillCount} skill${item.skillCount === 1 ? "" : "s"}` : "";
				const description = item.description ? ` — ${item.description}` : "";
				lines.push(`${marker} ${item.name}  ${item.displaySource}${skills}${description}${unsupported}`);
			}
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

const PANE_NAMES = ["Prompt", "Metadata", "Skills", "Warnings", "Raw"] as const;
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
			`pane ${this.paneIndex + 1}/5 · line ${Math.min(this.scroll + 1, paneLines.length)}/${paneLines.length} · j/down scroll · tab next · b back · q quit`,
		];
		return linesSafe(lines, width);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "q") || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done?.({ action: "closed" });
			return;
		}
		if (matchesKey(data, "b")) {
			this.done?.({ action: "back" });
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.paneIndex = (this.paneIndex + 1) % PANE_NAMES.length;
			this.scroll = 0;
			return;
		}
		const paneKey = (["1", "2", "3", "4", "5"] as const).find((key) => matchesKey(data, key));
		if (paneKey) {
			this.paneIndex = Number(paneKey) - 1;
			this.scroll = 0;
			return;
		}
		if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
			this.scroll = Math.min(this.scroll + 1, Math.max(0, this.paneText().split("\n").length - 1));
		} else if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
			this.scroll = Math.max(0, this.scroll - 1);
		}
	}

	invalidate(): void {}
}
