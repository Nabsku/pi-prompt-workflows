import { decodeKittyPrintable, Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { PromptInputDefinition, PromptInputSchema } from "./prompt-inputs.js";

export type PromptInputFormResult =
	| { action: "submitted"; values: Record<string, string | boolean> }
	| { action: "cancelled" };

export class PromptInputForm implements Component {
	private readonly names: string[];
	private readonly values: Record<string, string | boolean>;
	private index = 0;
	private error = "";

	constructor(
		private readonly schema: PromptInputSchema,
		initialValues: Record<string, string | boolean>,
		private readonly done?: (result: PromptInputFormResult) => void,
	) {
		this.names = Object.keys(schema);
		this.values = { ...initialValues };
		for (const name of this.names) {
			const definition = schema[name]!;
			if (!(name in this.values)) this.values[name] = definition.type === "boolean" ? false : definition.type === "choice" ? definition.options?.[0] ?? "" : "";
		}
	}

	private current(): { name: string; definition: PromptInputDefinition; value: string | boolean } | undefined {
		const name = this.names[this.index];
		if (!name) return undefined;
		return { name, definition: this.schema[name]!, value: this.values[name]! };
	}

	render(width: number): string[] {
		const current = this.current();
		const lines = [
			"Prompt inputs",
			"Complete the missing or invalid values",
			"",
			...this.names.map((name, index) => `${index === this.index ? ">" : " "} ${name}: ${String(this.values[name])}`),
			"",
			`Editing: ${current?.name ?? "(none)"}${current?.definition.type === "choice" ? ` [${current.definition.options?.join(" | ") ?? ""}]` : ""}`,
			this.error,
			"Enter: next/submit · ↑/↓: field · Space: toggle/cycle · Esc/q: cancel",
		];
		return lines.map((line) => line.length > width ? `${line.slice(0, Math.max(1, width - 1))}…` : line);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "q") || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.done?.({ action: "cancelled" }); return; }
		if (matchesKey(data, Key.up)) { this.index = Math.max(0, this.index - 1); this.error = ""; return; }
		if (matchesKey(data, Key.down)) { this.index = Math.min(Math.max(0, this.names.length - 1), this.index + 1); this.error = ""; return; }
		const current = this.current();
		if (!current) return;
		if (data === " ") {
			if (current.definition.type === "boolean") this.values[current.name] = !current.value;
			else if (current.definition.type === "choice") {
				const options = current.definition.options ?? [];
				const next = Math.max(0, options.indexOf(String(current.value)) + 1) % Math.max(1, options.length);
				this.values[current.name] = options[next] ?? "";
			}
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\n") {
			if (this.index < this.names.length - 1) { this.index++; this.error = ""; return; }
			this.done?.({ action: "submitted", values: { ...this.values } });
			return;
		}
		if (current.definition.type !== "string" && current.definition.type !== "choice") return;
		if (matchesKey(data, Key.backspace)) { this.values[current.name] = String(current.value).slice(0, -1); this.error = ""; return; }
		const printable = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " && data !== "\u007f" ? data : undefined);
		if (printable !== undefined && current.definition.type === "string") { this.values[current.name] = `${current.value}${printable}`; this.error = ""; }
	}

	invalidate(): void {}
}
