import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { getDelegatedLiveState, type DelegatedSubagentLiveState } from "./subagent-runtime.js";

export const DELEGATED_WIDGET_KEY = "prompt-subagent-progress";

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return `${minutes}m${remaining}s`;
}

function formatTokens(n: number | undefined): string {
	if (!n) return "0";
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function normalizeModelLabel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	return model.includes("/") ? model.split("/").pop() : model;
}

function formatToolCall(tool: string, args: string): string {
	const safeArgs = args ?? "";
	switch (tool) {
		case "bash": {
			const cmd = safeArgs.replace(/[\n\t]/g, " ").trim();
			return `$ ${cmd.length > 80 ? `${cmd.slice(0, 80)}...` : cmd}`;
		}
		case "read": return `[read: ${safeArgs}]`;
		case "write": return `[write: ${safeArgs}]`;
		case "edit": return `[edit: ${safeArgs}]`;
		default: {
			const short = safeArgs.length > 60 ? `${safeArgs.slice(0, 60)}...` : safeArgs;
			return `[${tool}: ${short}]`;
		}
	}
}

function stateKey(state: DelegatedSubagentLiveState | undefined, elapsed: number): string {
	if (!state) return "none";
	const elapsedBucket = Math.floor(elapsed / 1000);
	const outputTail = state.recentOutput.at(-1)?.slice(0, 80) ?? "";
	const recentTool = state.recentTools.at(-1);
	return [
		state.status ?? "",
		state.currentTool ?? "",
		state.currentToolArgs ?? "",
		state.toolCount,
		state.tokens,
		state.recentOutput.length,
		outputTail,
		state.recentTools.length,
		recentTool?.tool ?? "",
		recentTool?.args ?? "",
		state.model ?? "",
		elapsedBucket,
	].join("|");
}

function rebuildBox(
	box: Box,
	agent: string,
	contextSuffix: string,
	taskPreview: string,
	state: DelegatedSubagentLiveState | undefined,
	elapsed: number,
	theme: Theme,
	requestModel?: string,
): void {
	box.clear();

	const toolCount = state?.toolCount ?? 0;
	const tokens = state?.tokens ?? 0;
	const duration = formatDuration(elapsed);
	const isThinking = toolCount === 0 && tokens === 0;
	const modelLabel = normalizeModelLabel(state?.model ?? requestModel);
	const modelSuffix = modelLabel ? ` ${theme.fg("dim", modelLabel)}` : "";
	const stats = isThinking
		? `thinking, ${duration}`
		: `${toolCount} tool${toolCount === 1 ? "" : "s"}, ${formatTokens(tokens)} tok, ${duration}`;

	box.addChild(new Text(
		`${theme.fg("warning", "...")} ${theme.fg("toolTitle", theme.bold(agent))}${contextSuffix}${modelSuffix} | ${stats}`,
		0,
		0,
	));
	box.addChild(new Spacer(1));
	box.addChild(new Text(theme.fg("dim", `Task: ${taskPreview}`), 0, 0));
	box.addChild(new Spacer(1));

	const recentTools = state?.recentTools ?? [];
	for (const tool of recentTools) {
		box.addChild(new Text(theme.fg("dim", formatToolCall(tool.tool, tool.args)), 0, 0));
	}
	if (state?.currentTool) {
		const active = formatToolCall(state.currentTool, state.currentToolArgs ?? "");
		box.addChild(new Text(theme.fg("warning", `> ${active}`), 0, 0));
	}

	if (state && state.recentOutput.length > 0) {
		if (recentTools.length > 0 || state.currentTool) box.addChild(new Spacer(1));
		for (const line of state.recentOutput) {
			box.addChild(new Text(theme.fg("dim", `  ${line}`), 0, 0));
		}
	}
}

export function createDelegatedProgressWidget(
	requestId: string,
	agent: string,
	context: "fresh" | "fork",
	task: string,
	theme: Theme,
	model?: string,
): Container & { dispose?(): void } {
	const contextSuffix = context === "fork" ? theme.fg("warning", " [fork]") : "";
	const taskPreview = task.length > 200 ? `${task.slice(0, 200)}...` : task;

	const container = new Container();
	container.addChild(new Spacer(1));
	const box = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
	container.addChild(box);

	let lastKey = "";
	container.render = (width: number): string[] => {
		const state = getDelegatedLiveState(requestId);
		const elapsed = state ? Date.now() - state.startedAt : 0;
		const key = stateKey(state, elapsed);
		if (key !== lastKey) {
			lastKey = key;
			rebuildBox(box, agent, contextSuffix, taskPreview, state, elapsed, theme, model);
		}
		return Container.prototype.render.call(container, width);
	};

	return container;
}
