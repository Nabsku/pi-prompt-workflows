import test from "node:test";
import assert from "node:assert/strict";
import { createDelegatedProgressWidget } from "../subagent-widget.ts";
import { renderDelegatedSubagentResult } from "../subagent-renderer.ts";
import { clearDelegatedLiveState, updateDelegatedLiveState } from "../subagent-runtime.ts";

const theme = {
	fg(_token: string, text: string) { return text; },
	bg(_token: string, text: string) { return text; },
	bold(text: string) { return text; },
} as any;

test("delegated widget renders one structured subagent state", () => {
	const requestId = "widget-structured-rich";
	clearDelegatedLiveState(requestId);
	updateDelegatedLiveState(requestId, {
		status: "running",
		model: "openai-codex/gpt-5.3-codex-spark",
		currentTool: "read",
		currentToolArgs: "README.md",
		recentTools: [{ tool: "bash", args: "git diff -- README.md" }],
		recentOutput: ["found section", "writing focused test"],
		toolCount: 2,
		tokens: 1200,
	});

	const widget = createDelegatedProgressWidget(
		requestId,
		"delegate",
		"fork",
		"do work",
		theme,
		"openai-codex/fallback",
	);

	const rendered = widget.render(120).join("\n");
	clearDelegatedLiveState(requestId);

	assert.match(rendered, /delegate \[fork\] gpt-5\.3-codex-spark \| 2 tools, 1\.2k tok/);
	assert.match(rendered, /Task: do work/);
	assert.match(rendered, /\$ git diff -- README\.md/);
	assert.match(rendered, /> \[read: README\.md\]/);
	assert.match(rendered, /found section/);
	assert.match(rendered, /writing focused test/);
});

test("delegated widget rerenders when output changes without a status change", () => {
	const requestId = "widget-structured-rerender";
	clearDelegatedLiveState(requestId);
	updateDelegatedLiveState(requestId, {
		status: "running",
		recentOutput: ["line 1"],
	});

	const widget = createDelegatedProgressWidget(requestId, "delegate", "fresh", "do work", theme);
	const first = widget.render(120).join("\n");
	updateDelegatedLiveState(requestId, {
		status: "running",
		recentOutput: ["line 1", "line 2"],
	});
	const second = widget.render(120).join("\n");
	clearDelegatedLiveState(requestId);

	assert.match(first, /line 1/);
	assert.doesNotMatch(first, /line 2/);
	assert.match(second, /line 2/);
});


test("delegated completion renderer uses aggregate bridge usage", () => {
	const rendered = renderDelegatedSubagentResult(
		{
			content: [{ type: "text", text: "Done." }],
			details: {
				agent: "delegate",
				task: "Review the change",
				model: "anthropic/claude-sonnet",
				usage: {
					input: 120,
					output: 34,
					cacheRead: 5,
					cacheWrite: 6,
					cost: 0.1234,
					turns: 3,
					toolCalls: 7,
					durationMs: 1500,
				},
			},
		},
		{ expanded: false } as never,
		theme,
	);

	const output = rendered.render(120).join("\n");
	assert.match(output, /delegate \| 7 tools, 34 tok/);
	assert.match(output, /3 turns in:120 out:34 R5 W6 \$0\.1234 1\.5s anthropic\/claude-sonnet/);
});
