import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillLoadedMessage, getRequestedSkills, resolvePromptSkills, type RuntimeSkillCommand } from "../prompt-skills.js";
import type { PromptWithModel } from "../prompt-loader.js";

function withTempHome(run: (root: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-skills-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

function project(root: string): string {
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });
	return cwd;
}

function writeProjectSkill(cwd: string, name: string, content: string): string {
	const skillDir = join(cwd, ".pi", "skills", name);
	mkdirSync(skillDir, { recursive: true });
	const skillPath = join(skillDir, "SKILL.md");
	writeFileSync(skillPath, content);
	return skillPath;
}

function writeRegisteredSkill(root: string, name: string, content: string): string {
	const skillDir = join(root, "registered");
	mkdirSync(skillDir, { recursive: true });
	const skillPath = join(skillDir, `${name}.md`);
	writeFileSync(skillPath, content);
	return skillPath;
}

function skillCommand(name: string, skillPath: string): RuntimeSkillCommand {
	return { name, source: "skill", sourceInfo: { path: skillPath } };
}

function assertReady(result: ReturnType<typeof resolvePromptSkills>) {
	assert.equal(result.kind, "ready");
	return result.kind === "ready" ? result.skills : [];
}

test("exact registered skill wins before filesystem skill", () => {
	withTempHome((root) => {
		const cwd = project(root);
		writeProjectSkill(cwd, "external", "filesystem content");
		const registeredPath = writeRegisteredSkill(root, "external", "registered content");

		const skills = assertReady(resolvePromptSkills(["external"], cwd, [skillCommand("skill:external", registeredPath)]));

		assert.deepEqual(skills.map((skill) => skill.skillName), ["external"]);
		assert.equal(skills[0]?.skillPath, registeredPath);
		assert.equal(skills[0]?.skillContent, "registered content");
		assert.match(buildSkillLoadedMessage(skills).content, /<skill name="external">\nregistered content\n<\/skill>/);
	});
});

test("skill: prefix normalization", () => {
	withTempHome((root) => {
		const cwd = project(root);
		const registeredPath = writeRegisteredSkill(root, "external", "prefixed content");

		const skills = assertReady(resolvePromptSkills(["skill:external"], cwd, [skillCommand("external", registeredPath)]));

		assert.deepEqual(skills.map((skill) => skill.skillName), ["external"]);
		assert.equal(skills[0]?.skillPath, registeredPath);
		assert.equal(skills[0]?.skillContent, "prefixed content");
	});
});

test("suffix wildcard expansion uses registered before filesystem", () => {
	withTempHome((root) => {
		const cwd = project(root);
		writeProjectSkill(cwd, "golang-one", "filesystem duplicate");
		writeProjectSkill(cwd, "golang-two", "filesystem two");
		const registeredPath = writeRegisteredSkill(root, "golang-one", "registered one");

		const skills = assertReady(resolvePromptSkills(["golang-*"], cwd, [skillCommand("skill:golang-one", registeredPath)]));

		assert.deepEqual(skills.map((skill) => skill.skillName), ["golang-one", "golang-two"]);
		assert.deepEqual(skills.map((skill) => skill.skillContent), ["registered one", "filesystem two"]);
	});
});

test("unsafe wildcard registered names are ignored", () => {
	withTempHome((root) => {
		const cwd = project(root);
		writeProjectSkill(cwd, "external-safe", "safe filesystem");
		const unsafePath = writeRegisteredSkill(root, "external-bad", "unsafe registered");

		const skills = assertReady(resolvePromptSkills(["external-*"], cwd, [skillCommand("skill:external-bad<xml", unsafePath)]));

		assert.deepEqual(skills.map((skill) => skill.skillName), ["external-safe"]);
		assert.doesNotMatch(buildSkillLoadedMessage(skills).content, /unsafe registered/);
	});
});

test("duplicate requested skills are de-duped in first occurrence order", () => {
	withTempHome((root) => {
		const cwd = project(root);
		writeProjectSkill(cwd, "golang-style", "style content");
		writeProjectSkill(cwd, "golang-tests", "tests content");
		writeProjectSkill(cwd, "tmux", "tmux content");

		const skills = assertReady(resolvePromptSkills(["golang-style", "golang-*", "tmux", "tmux"], cwd, []));

		assert.deepEqual(skills.map((skill) => skill.skillName), ["golang-style", "golang-tests", "tmux"]);
	});
});

test("unreadable or missing skill returns error", () => {
	withTempHome((root) => {
		const cwd = project(root);
		const unreadablePath = join(root, "unreadable-dir");
		mkdirSync(unreadablePath, { recursive: true });

		const unreadable = resolvePromptSkills(["unreadable"], cwd, [skillCommand("skill:unreadable", unreadablePath)]);
		assert.equal(unreadable.kind, "error");
		assert.match(unreadable.kind === "error" ? unreadable.error : "", /Failed to read skill "unreadable"/);

		const missing = resolvePromptSkills(["missing"], cwd, []);
		assert.equal(missing.kind, "error");
		assert.match(missing.kind === "error" ? missing.error : "", /Skill "missing" not found/);
	});
});

test("scalar empty skill names fail", () => {
	assert.deepEqual(getRequestedSkills({ skill: "" } as PromptWithModel), []);

	withTempHome((root) => {
		const cwd = project(root);
		const result = resolvePromptSkills([""], cwd, []);

		assert.equal(result.kind, "error");
		assert.match(result.kind === "error" ? result.error : "", /Skill "" not found/);
	});
});
