import test from "node:test";
import assert from "node:assert/strict";
import { setKittyProtocolActive, visibleWidth } from "@earendil-works/pi-tui";
import {
	createPromptDryRunTuiViewModel,
	PromptDryRunInspector,
	PromptDryRunPicker,
	type PromptTemplateCatalogItem,
} from "../prompt-dry-run-tui.js";
import type { PromptDryRunResult } from "../prompt-dry-run.js";

const catalog: PromptTemplateCatalogItem[] = [
	{
		name: "review",
		source: "project",
		displaySource: "project",
		file: ".pi/prompts/review.md",
		description: "Review a file",
		model: "anthropic/claude-sonnet-4",
		skillCount: 2,
		skills: ["git", "typescript"],
	},
	{
		name: "implement-plan",
		source: "user",
		displaySource: "user",
		file: "~/.pi/prompts/implement-plan.md",
		description: "Implement from a plan",
		model: "openai/gpt-5.2",
		skillCount: 1,
		skills: ["patch"],
	},
	{
		name: "deterministic-report",
		source: "project",
		displaySource: "project",
		file: ".pi/prompts/deterministic-report.md",
		description: "Unsupported deterministic prompt",
		unsupportedReason: "Dry-run for deterministic prompts is not supported in v1 because it would require running configured commands/scripts.",
	},
];

const okResult: PromptDryRunResult = {
	status: "ok",
	promptName: "review",
	content: "# Prompt body\nReview src/server.ts and summarize concrete findings.",
	args: ["src/server.ts"],
	model: { provider: "anthropic", id: "claude-sonnet-4" } as never,
	modelAlreadyActive: true,
	warnings: ["conditional warning"],
	skills: [
		{ skillName: "git", skillPath: "/repo/.pi/skills/git/SKILL.md" },
		{ skillName: "typescript", skillPath: "/repo/.pi/skills/typescript/SKILL.md" },
	],
	details: { skills: [] },
	runtime: { cwd: "/repo", restore: false, boomerang: false },
};

const plainReport = [
	"# Prompt dry-run: review",
	"Status: ok",
	"",
	"## Prompt body",
	"```markdown",
	okResult.status === "ok" ? okResult.content : "",
	"```",
	"",
].join("\n");

function renderText(lines: string[]): string {
	return lines.join("\n");
}

function assertWidthSafe(lines: string[], width: number) {
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${line} (${visibleWidth(line)})`);
	}
}

test("picker renders a searchable template picker by default, marks unsupported rows, and is width-safe", () => {
	const picker = new PromptDryRunPicker(catalog, undefined);
	const lines = picker.render(54);
	const text = renderText(lines);

	assert.match(text, /Prompt dry-run/i);
	assert.match(text, /Pick a prompt template/i);
	assert.match(text, /search:/i);
	assert.match(text, /review/);
	assert.match(text, /implement-plan/);
	assert.match(text, /deterministic-report/);
	assert.match(text, /unsupported|not supported/i);
	assert.match(text, /Enter.*inspect/i);
	assert.match(text, /Esc|q.*quit/i);
	assertWidthSafe(lines, 54);
});

test("picker filters by typed text and selects the highlighted template with enter", () => {
	const doneValues: unknown[] = [];
	const picker = new PromptDryRunPicker(catalog, undefined, undefined, undefined, (value) => doneValues.push(value));

	for (const ch of "plan") picker.handleInput(ch);
	let text = renderText(picker.render(80));
	assert.match(text, /implement-plan/);
	assert.doesNotMatch(text, /review\s+project/);

	picker.handleInput("\r");
	assert.deepEqual(doneValues.at(-1), { action: "selected", templateName: "implement-plan" });
});

test("picker decodes Kitty CSI-u printable text for search filtering", () => {
	const doneValues: unknown[] = [];
	const picker = new PromptDryRunPicker(catalog, undefined, undefined, undefined, (value) => doneValues.push(value));

	for (const data of ["\x1b[112u", "\x1b[108u", "\x1b[97u", "\x1b[110u"]) picker.handleInput(data);
	const text = renderText(picker.render(80));
	assert.match(text, /search: plan/);
	assert.match(text, /implement-plan/);
	assert.doesNotMatch(text, /review\s+project/);

	picker.handleInput("\x1b[13u");
	assert.deepEqual(doneValues.at(-1), { action: "selected", templateName: "implement-plan" });
});

test("picker preserves raw newline selection while Kitty protocol is active", () => {
	const doneValues: unknown[] = [];
	const picker = new PromptDryRunPicker(catalog, undefined, undefined, undefined, (value) => doneValues.push(value));

	setKittyProtocolActive(true);
	try {
		picker.handleInput("\n");
	} finally {
		setKittyProtocolActive(false);
	}

	assert.deepEqual(doneValues.at(-1), { action: "selected", templateName: "review" });
});

test("picker treats Kitty CSI-u j, k, and q as shortcuts before printable filtering", () => {
	const doneValues: unknown[] = [];
	const picker = new PromptDryRunPicker(catalog, undefined, undefined, undefined, (value) => doneValues.push(value));

	picker.handleInput("\x1b[106u");
	let text = renderText(picker.render(80));
	assert.match(text, />\s*implement-plan/);
	assert.match(text, /search: \(type to filter\)/);

	picker.handleInput("\x1b[107u");
	text = renderText(picker.render(80));
	assert.match(text, />\s*review/);
	assert.match(text, /search: \(type to filter\)/);

	picker.handleInput("\x1b[113u");
	assert.deepEqual(doneValues.at(-1), { action: "closed" });
});

test("picker supports Kitty CSI-u escape and backspace parity", () => {
	const doneValues: unknown[] = [];
	const picker = new PromptDryRunPicker(catalog, undefined, undefined, undefined, (value) => doneValues.push(value));

	picker.handleInput("\x1b[112u");
	picker.handleInput("\x1b[108u");
	picker.handleInput("\x1b[127u");
	assert.match(renderText(picker.render(80)), /search: p/);

	picker.handleInput("\x1b[27u");
	assert.deepEqual(doneValues.at(-1), { action: "closed" });
});

test("picker returns unsupported highlighted templates on enter so callers can surface dry-run diagnostics", () => {
	const doneValues: unknown[] = [];
	const picker = new PromptDryRunPicker(catalog, "deterministic-report", undefined, undefined, (value) => doneValues.push(value));

	assert.match(renderText(picker.render(100)), />\s*deterministic-report/);
	picker.handleInput("\r");

	assert.deepEqual(doneValues.at(-1), { action: "selected", templateName: "deterministic-report" });
});

test("picker supports initial preselection and quit keys", () => {
	const doneValues: unknown[] = [];
	const picker = new PromptDryRunPicker(catalog, "implement-plan", undefined, undefined, (value) => doneValues.push(value));
	assert.match(renderText(picker.render(80)), />\s*implement-plan/);

	for (const key of ["q", "\u001b", "\u0003"]) {
		picker.handleInput(key);
		assert.deepEqual(doneValues.pop(), { action: "closed" });
	}
});

test("inspector default pane is Prompt, shows prompt body, warning badge, and hides full skill content by default", () => {
	const viewModel = createPromptDryRunTuiViewModel(okResult, plainReport);
	const inspector = new PromptDryRunInspector(viewModel);
	const lines = inspector.render(72);
	const text = renderText(lines);

	assert.match(text, /Prompt dry-run: review/);
	assert.match(text, /\[Prompt\]|Prompt\s+Metadata\s+Skills/);
	assert.match(text, /# Prompt body/);
	assert.match(text, /Review src\/server\.ts/);
	assert.match(text, /warning/i);
	assert.match(text, /git/);
	assert.match(text, /typescript/);
	assert.doesNotMatch(text, /SECRET FULL TYPESCRIPT SKILL CONTENT/);
	assert.match(text, /content hidden|--show-skills/i);
	assertWidthSafe(lines, 72);
});

test("inspector strips terminal control sequences from untrusted prompt and skill text", () => {
	const hostileResult: PromptDryRunResult = okResult.status === "ok"
		? {
			...okResult,
			promptName: "review\u001b[2J",
			content: "safe\u001b[31m red \u001b]0;owned\u0007 end",
			skills: [{ skillName: "ansi", skillPath: "/tmp/\u001b[Hskill", skillContent: "secret\u001b[2Jcontent" }],
		}
		: okResult;
	const text = renderText(new PromptDryRunInspector(createPromptDryRunTuiViewModel(hostileResult, plainReport)).render(100));
	assert.doesNotMatch(text, /\u001b|\u0007/);
	assert.match(text, /safe red  end/);
});

test("TUI sanitizer escapes bare carriage returns in inspector and picker rendered text", () => {
	const hostileResult: PromptDryRunResult = okResult.status === "ok"
		? {
			...okResult,
			promptName: "review\rname",
			content: "line one\rline two",
			skills: [{ skillName: "skill\rname", skillPath: "/tmp/skill\rpath", skillContent: "skill\rcontent" }],
		}
		: okResult;
	const inspectorText = renderText(new PromptDryRunInspector(createPromptDryRunTuiViewModel(hostileResult, "raw\rreport")).render(120));
	assert.doesNotMatch(inspectorText, /\r/);
	assert.match(inspectorText, /\\u000d/);

	const picker = new PromptDryRunPicker([
		{ name: "name\rwith-cr", source: "project", displaySource: "project", description: "desc\rwith-cr" },
	], undefined);
	const pickerText = renderText(picker.render(120));
	assert.doesNotMatch(pickerText, /\r/);
	assert.match(pickerText, /\\u000d/);
});

test("inspector tab, numeric jump, back, scroll, and quit keybindings are render-only", () => {
	const doneValues: unknown[] = [];
	const viewModel = createPromptDryRunTuiViewModel(okResult, plainReport);
	const inspector = new PromptDryRunInspector(viewModel, undefined, undefined, (value) => doneValues.push(value));

	inspector.handleInput("\t");
	assert.match(renderText(inspector.render(80)), /\[Metadata\]|Metadata/i);
	inspector.handleInput("3");
	assert.match(renderText(inspector.render(80)), /\[Skills\]|Skills/i);
	inspector.handleInput("5");
	assert.match(renderText(inspector.render(80)), /# Prompt dry-run: review|Raw/i);
	inspector.handleInput("j");
	assert.match(renderText(inspector.render(80)), /scroll|↓|line/i);
	inspector.handleInput("b");
	assert.deepEqual(doneValues.at(-1), { action: "back" });
	inspector.handleInput("q");
	assert.deepEqual(doneValues.at(-1), { action: "closed" });
});

test("inspector includes full skill content only when --show-skills data is present in the shared dry-run result", () => {
	const shownResult: PromptDryRunResult = okResult.status === "ok"
		? {
			...okResult,
			skills: [
				{ skillName: "git", skillPath: "/repo/.pi/skills/git/SKILL.md" },
				{ skillName: "typescript", skillPath: "/repo/.pi/skills/typescript/SKILL.md", skillContent: "SECRET FULL TYPESCRIPT SKILL CONTENT" },
			],
		}
		: okResult;
	const shown = createPromptDryRunTuiViewModel(shownResult, plainReport);
	assert.match(renderText(new PromptDryRunInspector(shown).render(100)), /SECRET FULL TYPESCRIPT SKILL CONTENT/);

	const hidden = createPromptDryRunTuiViewModel(okResult, plainReport);
	assert.doesNotMatch(renderText(new PromptDryRunInspector(hidden).render(100)), /SECRET FULL TYPESCRIPT SKILL CONTENT/);
});
