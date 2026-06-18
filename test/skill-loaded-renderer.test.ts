import test from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderSkillLoaded } from "../skill-loaded-renderer.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

test("renderSkillLoaded fails safe when message details are missing", () => {
	const rendered = renderSkillLoaded({}, { expanded: false } as never, theme);

	assert.ok(rendered);
});

test("renderSkillLoaded collapsed mode shows plural title and paths", () => {
	const rendered = renderSkillLoaded(
		{
			details: {
				skills: [
					{ skillName: "a", skillPath: "/skills/a/SKILL.md", skillContent: "a1\na2\na3\na4\na5\na6" },
					{ skillName: "b", skillPath: "/skills/b/SKILL.md", skillContent: "b1" },
				],
			},
		},
		{ expanded: false } as never,
		theme,
	);

	const output = rendered.render(120).join("\n");
	assert.match(output, /Skills loaded: a, b/);
	assert.match(output, /\/skills\/a\/SKILL\.md/);
	assert.match(output, /\/skills\/b\/SKILL\.md/);
	assert.match(output, /a1/);
	assert.match(output, /\.\.\. \(1 more lines\)/);
});

test("renderSkillLoaded expanded mode includes all skill contents", () => {
	const rendered = renderSkillLoaded(
		{
			details: {
				skills: [
					{ skillName: "a", skillPath: "/skills/a/SKILL.md", skillContent: "a1\na2\na3\na4\na5\na6" },
					{ skillName: "b", skillPath: "/skills/b/SKILL.md", skillContent: "b full content" },
				],
			},
		},
		{ expanded: true } as never,
		theme,
	);

	const output = rendered.render(120).join("\n");
	assert.match(output, /a6/);
	assert.match(output, /b full content/);
	assert.doesNotMatch(output, /more lines/);
});

test("renderSkillLoaded handles legacy single-skill details", () => {
	const rendered = renderSkillLoaded(
		{
			details: {
				skillName: "tmux",
				skillPath: "/skills/tmux/SKILL.md",
				skillContent: "Use tmux.",
			},
		},
		{ expanded: false } as never,
		theme,
	);

	const output = rendered.render(120).join("\n");
	assert.match(output, /Skill loaded: tmux/);
	assert.match(output, /\/skills\/tmux\/SKILL\.md/);
	assert.match(output, /Use tmux\./);
});
