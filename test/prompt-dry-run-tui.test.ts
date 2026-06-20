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
	assert.match(text, /Prompt\s+Metadata\s+Skills\s+Includes\s+Warnings\s+Raw|\[Prompt\]/);
	assert.match(text, /# Prompt body/);
	assert.match(text, /Review src\/server\.ts/);
	assert.match(text, /warning/i);
	assert.match(text, /git/);
	assert.match(text, /typescript/);
	assert.doesNotMatch(text, /SECRET FULL TYPESCRIPT SKILL CONTENT/);
	assert.match(text, /content hidden|--show-skills/i);
	assertWidthSafe(lines, 72);
});

test("inspector always exposes an Includes pane and shows No includes when the graph is empty", () => {
	const inspector = new PromptDryRunInspector(createPromptDryRunTuiViewModel(okResult, plainReport));

	inspector.handleInput("4");
	const text = renderText(inspector.render(80));

	assert.match(text, /\[Includes\]/);
	assert.match(text, /No includes\./);
	assert.match(text, /pane 4\/6/);
});

test("inspector Includes pane renders root-only include diagnostics without edges", () => {
	const diagnostic = {
		code: "include-placeholder-without-includes",
		message: "Prompt body uses <includes /> but frontmatter is missing includes metadata.",
		filePath: "/repo/.pi/prompts/review.md",
		source: "project" as const,
		key: "root-diagnostic",
	};
	const result: PromptDryRunResult = okResult.status === "ok"
		? {
			...okResult,
			includeGraph: {
				root: {
					promptName: "review",
					filePath: "/repo/.pi/prompts/review.md",
					promptRoot: "/repo/.pi/prompts",
					cwd: "/repo",
					source: "project",
					rawBody: "<includes />",
					hasInlineIncludes: false,
					hasIncludesPlaceholder: true,
					isChainWrapper: false,
				},
				nodes: [{ id: "root", kind: "prompt", status: "ok", filePath: "/repo/.pi/prompts/review.md", diagnostics: [diagnostic] }],
				edges: [],
				diagnostics: [diagnostic],
			},
		}
		: okResult;
	const inspector = new PromptDryRunInspector(createPromptDryRunTuiViewModel(result, plainReport));

	inspector.handleInput("4");
	const text = renderText(inspector.render(120));

	assert.match(text, /- review \[ok\] \/repo\/\.pi\/prompts\/review\.md/);
	assert.match(text, /! include-placeholder-without-includes: Prompt body uses <includes \/>/);
	assert.doesNotMatch(text, /No includes\./);
});

test("inspector Includes pane renders include edges in graph order with diagnostics and stays width-safe", () => {
	const edgeDiagnostic = {
		code: "include-not-found\u001b[31m",
		message: "Missing	partial",
		filePath: "/repo/.pi/prompts/review.md",
		source: "project" as const,
		key: "edge-diagnostic",
	};
	const result: PromptDryRunResult = okResult.status === "ok"
		? {
			...okResult,
			includeGraph: {
				root: {
					promptName: "review",
					filePath: "/repo/.pi/prompts/review.md",
					promptRoot: "/repo/.pi/prompts",
					cwd: "/repo",
					source: "project",
					rawBody: "body",
					includes: ["b.md", "a.md"],
					hasInlineIncludes: true,
					hasIncludesPlaceholder: false,
					isChainWrapper: false,
				},
				nodes: [
					{ id: "root", kind: "prompt", status: "ok", filePath: "/repo/.pi/prompts/review.md", diagnostics: [] },
					{ id: "a", kind: "partial", status: "ok", filePath: "/repo/.pi/prompts/a.md", diagnostics: [] },
					{ id: "b", kind: "partial", status: "ok", filePath: "/repo/.pi/prompts/b.md", diagnostics: [] },
					{ id: "missing", kind: "unresolved", status: "failed", includePath: "missing\r.md", diagnostics: [edgeDiagnostic] },
				],
				edges: [
					{ fromNodeId: "root", toNodeId: "b", kind: "frontmatter", includePath: "b.md", order: 1, status: "ok", diagnostics: [] },
					{ fromNodeId: "root", toNodeId: "a", kind: "inline", includePath: "a.md", order: 0, status: "ok", diagnostics: [] },
					{ fromNodeId: "a", toNodeId: "missing", kind: "inline", includePath: "missing\r.md", order: 2, status: "failed", diagnostics: [edgeDiagnostic] },
				],
				diagnostics: [edgeDiagnostic],
			},
		}
		: okResult;
	const inspector = new PromptDryRunInspector(createPromptDryRunTuiViewModel(result, plainReport));

	inspector.handleInput("4");
	const wideText = renderText(inspector.render(200));
	const lines = inspector.render(72);
	const text = renderText(lines);

	assert.ok(wideText.indexOf("inline a.md") < wideText.indexOf("frontmatter b.md"), wideText);
	assert.match(text, /unresolved:missing\\u000d\.md/);
	assert.match(text, /include-not-found: Missing\\u0009partial/);
	assert.doesNotMatch(wideText, /\u001b|\r|	/);
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

test("TUI sanitizer escapes tabs in inspector and picker text before truncation", () => {
	const tabbedResult: PromptDryRunResult = okResult.status === "ok"
		? {
			...okResult,
			promptName: "review	name",
			content: "prompt	content",
			skills: [{ skillName: "skill	name", skillPath: "/tmp/skill	path", skillContent: "skill	content" }],
		}
		: okResult;
	const inspectorText = renderText(new PromptDryRunInspector(createPromptDryRunTuiViewModel(tabbedResult, "raw	report")).render(120));
	assert.doesNotMatch(inspectorText, /	/);
	assert.match(inspectorText, /prompt\\u0009content/);
	assert.match(inspectorText, /skill\\u0009content/);

	const narrowInspectorText = renderText(new PromptDryRunInspector(createPromptDryRunTuiViewModel(tabbedResult, "raw	report")).render(20));
	assert.doesNotMatch(narrowInspectorText, /	/);
	assert.match(narrowInspectorText, /prompt\\u0009/);

	const picker = new PromptDryRunPicker([
		{ name: "name	with-tab", source: "project", displaySource: "project", description: "desc	with-tab" },
	], undefined);
	const pickerText = renderText(picker.render(120));
	assert.doesNotMatch(pickerText, /	/);
	assert.match(pickerText, /name\\u0009with-tab/);
	assert.match(pickerText, /desc\\u0009with-tab/);
});

test("picker windows large catalogs while keeping controls and selected row visible", () => {
	const largeCatalog: PromptTemplateCatalogItem[] = Array.from({ length: 250 }, (_, index) => ({
		name: `template-${index.toString().padStart(3, "0")}`,
		source: "project",
		displaySource: "project",
		description: `description ${index}`,
	}));
	const picker = new PromptDryRunPicker(largeCatalog, undefined);

	for (let i = 0; i < 125; i++) picker.handleInput("j");

	const lines = picker.render(100);
	const text = renderText(lines);
	assert.ok(lines.length <= 26, `expected bounded render, got ${lines.length} lines`);
	assert.match(text, /Prompt dry-run/);
	assert.match(text, /search: \(type to filter\)/);
	assert.match(text, /Enter: inspect/);
	assert.match(text, />\s*template-125/);
	assert.doesNotMatch(text, /template-000\s+project/);
	assert.match(text, /earlier template/);
	assert.match(text, /later template/);
});

test("inspector tab, numeric jump, back, scroll, and quit keybindings are render-only", () => {
	const doneValues: unknown[] = [];
	const viewModel = createPromptDryRunTuiViewModel(okResult, plainReport);
	const inspector = new PromptDryRunInspector(viewModel, undefined, undefined, (value) => doneValues.push(value));

	inspector.handleInput("	");
	assert.match(renderText(inspector.render(80)), /\[Metadata\]|Metadata/i);
	inspector.handleInput("3");
	assert.match(renderText(inspector.render(80)), /\[Skills\]|Skills/i);
	inspector.handleInput("4");
	assert.match(renderText(inspector.render(80)), /\[Includes\]|No includes\./i);
	inspector.handleInput("6");
	assert.match(renderText(inspector.render(80)), /# Prompt dry-run: review|Raw/i);
	inspector.handleInput("j");
	assert.match(renderText(inspector.render(80)), /scroll|↓|line/i);
	inspector.handleInput("b");
	assert.deepEqual(doneValues.at(-1), { action: "back" });
	inspector.handleInput("q");
	assert.deepEqual(doneValues.at(-1), { action: "closed" });
});

test("inspector supports Kitty CSI-u close, back, tab, numeric panes, and scroll controls", () => {
	const doneValues: unknown[] = [];
	const viewModel = createPromptDryRunTuiViewModel(okResult, plainReport);
	const inspector = new PromptDryRunInspector(viewModel, undefined, undefined, (value) => doneValues.push(value));

	setKittyProtocolActive(true);
	try {
		inspector.handleInput("\x1b[9u");
		assert.match(renderText(inspector.render(80)), /\[Metadata\]/);

		inspector.handleInput("\x1b[54u");
		let text = renderText(inspector.render(80));
		assert.match(text, /\[Raw\]/);
		assert.match(text, /line 1\/9/);

		inspector.handleInput("\x1b[106u");
		text = renderText(inspector.render(80));
		assert.match(text, /line 2\/9/);

		inspector.handleInput("\x1b[107u");
		text = renderText(inspector.render(80));
		assert.match(text, /line 1\/9/);

		inspector.handleInput("\x1b[1;1B");
		text = renderText(inspector.render(80));
		assert.match(text, /line 2\/9/);

		inspector.handleInput("\x1b[1;1A");
		text = renderText(inspector.render(80));
		assert.match(text, /line 1\/9/);

		inspector.handleInput("\x1b[98u");
		assert.deepEqual(doneValues.at(-1), { action: "back" });

		inspector.handleInput("\x1b[113u");
		assert.deepEqual(doneValues.at(-1), { action: "closed" });
	} finally {
		setKittyProtocolActive(false);
	}
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

test("inspector treats empty skillContent as present --show-skills data", () => {
	const emptySkillResult: PromptDryRunResult = okResult.status === "ok"
		? {
			...okResult,
			skills: [{ skillName: "empty", skillPath: "/repo/.pi/skills/empty/SKILL.md", skillContent: "" }],
		}
		: okResult;
	const viewModel = createPromptDryRunTuiViewModel(emptySkillResult, plainReport);
	const text = renderText(new PromptDryRunInspector(viewModel).render(100));

	assert.match(viewModel.panes.skills, /- empty \(\/repo\/\.pi\/skills\/empty\/SKILL\.md\)/);
	assert.doesNotMatch(viewModel.panes.skills, /full skill content hidden|--show-skills/i);
	assert.doesNotMatch(text, /full skill content hidden|--show-skills/i);
});
