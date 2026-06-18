import type { MessageRenderOptions, Theme } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@mariozechner/pi-tui";

export interface LoadedSkillDetails {
	skillName: string;
	skillContent: string;
	skillPath: string;
}

export interface SkillLoadedDetails {
	skills: LoadedSkillDetails[];
}

type LegacySkillLoadedDetails = LoadedSkillDetails;
type SkillLoadedDetailsWithLegacy = SkillLoadedDetails | LegacySkillLoadedDetails;

const SKILL_PREVIEW_LINES = 5;

function normalizeDetails(details: SkillLoadedDetailsWithLegacy | undefined): LoadedSkillDetails[] {
	if (!details) return [];
	if ("skills" in details && Array.isArray(details.skills)) return details.skills;
	if ("skillName" in details && "skillContent" in details && "skillPath" in details) {
		return [details];
	}
	return [];
}

export function renderSkillLoaded(
	message: { details?: SkillLoadedDetailsWithLegacy },
	options: MessageRenderOptions,
	theme: Theme,
) {
	const container = new Container();
	const skills = normalizeDetails(message.details);
	if (skills.length === 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("warning", "Skill loaded message is missing details."), 0, 0));
		return container;
	}

	container.addChild(new Spacer(1));

	const box = new Box(1, 1, (text: string) => theme.bg("toolSuccessBg", text));
	const title = skills.length === 1
		? `Skill loaded: ${skills[0]!.skillName}`
		: `Skills loaded: ${skills.map((skill) => skill.skillName).join(", ")}`;
	box.addChild(new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0));
	for (const skill of skills) {
		box.addChild(new Text(theme.fg("toolOutput", `   ${skill.skillPath}`), 0, 0));
	}
	box.addChild(new Spacer(1));

	if (options.expanded) {
		for (const [index, skill] of skills.entries()) {
			if (skills.length > 1) {
				box.addChild(new Text(theme.fg("toolTitle", `--- ${skill.skillName} ---`), 0, 0));
			}
			const lines = skill.skillContent.split("\n");
			box.addChild(new Text(lines.map((line) => theme.fg("toolOutput", line)).join("\n"), 0, 0));
			if (index < skills.length - 1) box.addChild(new Spacer(1));
		}
	} else {
		for (const [index, skill] of skills.entries()) {
			if (skills.length > 1) {
				box.addChild(new Text(theme.fg("toolTitle", `--- ${skill.skillName} ---`), 0, 0));
			}
			const lines = skill.skillContent.split("\n");
			const previewLines = lines.slice(0, SKILL_PREVIEW_LINES);
			const remaining = lines.length - SKILL_PREVIEW_LINES;
			box.addChild(new Text(previewLines.map((line) => theme.fg("toolOutput", line)).join("\n"), 0, 0));
			if (remaining > 0) {
				box.addChild(new Text(theme.fg("warning", `\n... (${remaining} more lines)`), 0, 0));
			}
			if (index < skills.length - 1) box.addChild(new Spacer(1));
		}
	}

	container.addChild(box);
	return container;
}
