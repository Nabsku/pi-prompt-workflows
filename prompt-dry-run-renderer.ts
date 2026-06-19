import type { PromptDryRunResult, PromptDryRunRuntimeMetadata } from "./prompt-dry-run.js";

function sanitizeInline(value: string): string {
	return JSON.stringify(value).slice(1, -1);
}

function formatScalar(value: string | number | boolean | null | undefined): string {
	if (value === undefined) return "not set";
	if (value === null) return "none";
	return sanitizeInline(String(value));
}

function modelLabel(model: { provider?: string; id?: string; name?: string }): string {
	if (model.provider && model.id) return `${model.provider}/${model.id}`;
	if (model.id) return model.id;
	if (model.name) return model.name;
	return "unknown";
}

function fencedBlock(language: string, content: string): string {
	const longest = Math.max(3, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length + 1));
	const fence = "`".repeat(longest);
	return `${fence}${language}\n${content}\n${fence}`;
}

function formatRuntime(runtime: Partial<PromptDryRunRuntimeMetadata> | undefined, lines: string[]): void {
	if (!runtime) return;
	if (runtime.model !== undefined) lines.push(`- Requested model override: ${formatScalar(runtime.model)}`);
	lines.push(`- Restore: ${formatScalar(runtime.restore)}`);
	if (runtime.thinking !== undefined) lines.push(`- Thinking: ${formatScalar(runtime.thinking)}`);
	lines.push(`- Boomerang: ${formatScalar(runtime.boomerang)}`);
	if (runtime.cwd !== undefined) lines.push(`- Runtime cwd: ${formatScalar(runtime.cwd)}`);
	if (runtime.inheritContext !== undefined) lines.push(`- Inherit context: ${formatScalar(runtime.inheritContext)}`);
	if (runtime.delegation) {
		lines.push("- Delegation: enabled");
		if (runtime.delegation.agent !== undefined) lines.push(`  - Agent: ${formatScalar(runtime.delegation.agent)}`);
		if (runtime.delegation.fork !== undefined) lines.push(`  - Fork: ${formatScalar(runtime.delegation.fork)}`);
		if (runtime.delegation.inheritContext !== undefined) lines.push(`  - Inherit context: ${formatScalar(runtime.delegation.inheritContext)}`);
		if (runtime.delegation.parallel !== undefined) lines.push(`  - Parallel: ${formatScalar(runtime.delegation.parallel)}`);
	} else {
		lines.push("- Delegation: disabled");
	}
	if (runtime.loop) {
		lines.push(
			`- Loop: count=${formatScalar(runtime.loop.count)}, fresh=${formatScalar(runtime.loop.fresh)}, converge=${formatScalar(runtime.loop.converge)}`,
		);
	}
}

function appendWarnings(lines: string[], warnings: string[]): void {
	if (warnings.length === 0) return;
	lines.push("", "## Warnings");
	for (const warning of warnings) lines.push(`- ${sanitizeInline(warning)}`);
}

function appendSkills(lines: string[], result: Extract<PromptDryRunResult, { status: "ok" }>): void {
	if (result.skills.length === 0) return;
	lines.push("", "## Skills");
	for (const skill of result.skills) {
		lines.push(``, `### Skill: ${sanitizeInline(skill.skillName)}`);
		lines.push(`- Path: ${sanitizeInline(skill.skillPath)}`);
		if (skill.skillContent !== undefined) {
			lines.push("- Skill content:", fencedBlock("markdown", skill.skillContent));
		}
	}
}

function appendArgs(lines: string[], args: string[]): void {
	lines.push("", "## Args");
	if (args.length === 0) {
		lines.push("- (none)");
		return;
	}
	for (const arg of args) lines.push(`- ${sanitizeInline(arg)}`);
}

export function formatPromptDryRun(result: PromptDryRunResult): string {
	const lines: string[] = [`# Prompt dry-run: ${sanitizeInline(result.promptName)}`];
	lines.push(`Status: ${result.status}`);

	if (result.status === "error") {
		lines.push("", "## Metadata");
		formatRuntime(result.runtime, lines);
		appendWarnings(lines, result.warnings);
		lines.push("", "## Error", `Error: ${sanitizeInline(result.error)}`);
		return `${lines.join("\n")}\n`;
	}

	lines.push("", "## Metadata");
	lines.push(`- Model: ${sanitizeInline(modelLabel(result.model))}`);
	lines.push(`- Model already active: ${formatScalar(result.modelAlreadyActive)}`);
	formatRuntime(result.runtime, lines);
	appendWarnings(lines, result.warnings);
	appendSkills(lines, result);
	appendArgs(lines, result.args);
	lines.push("", "## Prompt body", fencedBlock("markdown", result.content));
	return `${lines.join("\n")}\n`;
}
