import { discoverFilesystemSkills, readSkillContent, resolveSkillPath, type PromptWithModel } from "./prompt-loader.js";
import type { SkillLoadedDetails } from "./skill-loaded-renderer.js";

export interface RuntimeSkillCommand {
	name: string;
	source?: string;
	sourceInfo?: { path?: string };
}

export interface PendingSkillMessage {
	customType: "skill-loaded";
	content: string;
	display: true;
	details: SkillLoadedDetails;
}

export type LoadedPromptSkill = {
	skillName: string;
	skillContent: string;
	skillPath: string;
};

type SkillResolution =
	| { kind: "none" }
	| { kind: "ready"; skills: LoadedPromptSkill[] }
	| { kind: "error"; error: string };

type ExpandedSkill = { skillName: string; skillPath?: string };

export function buildSkillLoadedMessage(skills: LoadedPromptSkill[]): PendingSkillMessage {
	return {
		customType: "skill-loaded",
		content: skills.map((skill) => `<skill name="${skill.skillName}">\n${skill.skillContent}\n</skill>`).join("\n\n"),
		display: true,
		details: { skills },
	};
}

function normalizeSkillName(skillName: string): string {
	return skillName.startsWith("skill:") ? skillName.slice("skill:".length) : skillName;
}

function isSafeXmlSkillName(skillName: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(skillName);
}

function lexicalCompare(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function isWildcardSelector(skillName: string): boolean {
	return skillName.includes("*");
}

function isValidSuffixWildcardSelector(skillName: string): boolean {
	const firstStar = skillName.indexOf("*");
	return firstStar > 0 && firstStar === skillName.length - 1 && skillName.indexOf("*", firstStar + 1) === -1 && isSafeXmlSkillName(skillName.slice(0, -1));
}

function invalidWildcardError(skillName: string): string {
	return `Invalid skill wildcard "${skillName}": only non-empty suffix "*" prefix matching is supported.`;
}

function isPathResolvableSkillName(skillName: string): boolean {
	return skillName !== "." && skillName !== "..";
}

function getSourceInfo(command: RuntimeSkillCommand): { path?: string } | undefined {
	return "sourceInfo" in command ? command.sourceInfo : undefined;
}

function resolveRegisteredSkillPath(skillName: string, commands: RuntimeSkillCommand[]): string | undefined {
	const normalizedSkillName = normalizeSkillName(skillName);
	if (!normalizedSkillName) return undefined;
	const candidates = new Set([normalizedSkillName, `skill:${normalizedSkillName}`]);

	for (const command of commands) {
		if (command.source !== "skill") continue;
		const sourceInfo = getSourceInfo(command);
		if (!sourceInfo?.path) continue;
		if (!candidates.has(command.name)) continue;
		return sourceInfo.path;
	}

	return undefined;
}

function discoverRegisteredWildcardMatches(prefix: string, commands: RuntimeSkillCommand[]): Array<{ skillName: string; skillPath: string }> {
	const matches = new Map<string, string>();
	for (const command of commands) {
		if (command.source !== "skill") continue;
		const sourceInfo = getSourceInfo(command);
		if (!sourceInfo?.path) continue;
		const normalizedSkillName = normalizeSkillName(command.name);
		if (!isSafeXmlSkillName(normalizedSkillName)) continue;
		if (!normalizedSkillName.startsWith(prefix)) continue;
		if (!matches.has(normalizedSkillName)) matches.set(normalizedSkillName, sourceInfo.path);
	}
	return Array.from(matches, ([skillName, skillPath]) => ({ skillName, skillPath }))
		.sort((a, b) => lexicalCompare(a.skillName, b.skillName));
}

function expandWildcardSelector(selector: string, cwd: string, commands: RuntimeSkillCommand[]): SkillResolution | { kind: "matches"; skills: ExpandedSkill[] } {
	if (!isValidSuffixWildcardSelector(selector)) {
		return { kind: "error", error: invalidWildcardError(selector) };
	}
	const prefix = selector.slice(0, -1);
	const matches: ExpandedSkill[] = [];
	const seen = new Set<string>();
	for (const skill of discoverRegisteredWildcardMatches(prefix, commands)) {
		if (seen.has(skill.skillName)) continue;
		seen.add(skill.skillName);
		matches.push(skill);
	}
	for (const skill of discoverFilesystemSkills(cwd)) {
		if (!skill.skillName.startsWith(prefix)) continue;
		if (seen.has(skill.skillName)) continue;
		seen.add(skill.skillName);
		matches.push(skill);
	}
	if (matches.length === 0) {
		return { kind: "error", error: `No skills matched "${selector}"` };
	}
	return { kind: "matches", skills: matches };
}

function expandRequestedSkillNames(skillNames: string[], cwd: string, commands: RuntimeSkillCommand[]): SkillResolution | { kind: "expanded"; skills: ExpandedSkill[] } {
	const expanded: ExpandedSkill[] = [];
	const seen = new Set<string>();
	for (const skillName of skillNames) {
		const normalizedSkillName = normalizeSkillName(skillName);
		if (!normalizedSkillName) {
			return { kind: "error", error: `Skill "${skillName}" not found` };
		}
		if (isWildcardSelector(normalizedSkillName)) {
			const wildcard = expandWildcardSelector(normalizedSkillName, cwd, commands);
			if (wildcard.kind !== "matches") return wildcard;
			for (const matchedSkill of wildcard.skills) {
				if (seen.has(matchedSkill.skillName)) continue;
				seen.add(matchedSkill.skillName);
				expanded.push(matchedSkill);
			}
			continue;
		}
		if (!isSafeXmlSkillName(normalizedSkillName)) {
			return { kind: "error", error: `Skill "${skillName}" has invalid name "${normalizedSkillName}"` };
		}
		if (seen.has(normalizedSkillName)) continue;
		seen.add(normalizedSkillName);
		expanded.push({ skillName: normalizedSkillName });
	}
	return { kind: "expanded", skills: expanded };
}

export function resolvePromptSkills(skillNames: string[], cwd: string, commands: RuntimeSkillCommand[]): SkillResolution {
	if (skillNames.length === 0) {
		return { kind: "none" };
	}

	const expandedSkillNames = expandRequestedSkillNames(skillNames, cwd, commands);
	if (expandedSkillNames.kind !== "expanded") return expandedSkillNames;

	const loadedSkills: LoadedPromptSkill[] = [];
	for (const skill of expandedSkillNames.skills) {
		const skillPath = skill.skillPath ?? resolveRegisteredSkillPath(skill.skillName, commands) ?? (isPathResolvableSkillName(skill.skillName) ? resolveSkillPath(skill.skillName, cwd) : undefined);
		if (!skillPath) {
			return { kind: "error", error: `Skill "${skill.skillName}" not found` };
		}

		try {
			const skillContent = readSkillContent(skillPath);
			loadedSkills.push({ skillName: skill.skillName, skillContent, skillPath });
		} catch (error) {
			return {
				kind: "error",
				error: `Failed to read skill "${skill.skillName}": ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	return { kind: "ready", skills: loadedSkills };
}

export function getRequestedSkills(prompt: Pick<PromptWithModel, "skill" | "skills">): string[] {
	return prompt.skills ?? (prompt.skill ? [prompt.skill] : []);
}
