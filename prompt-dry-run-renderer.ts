import type { BestOfNPreflight, BestOfNPreflightSlot } from "./best-of-n-preflight.js";
import type { PromptDryRunResult, PromptDryRunRuntimeMetadata } from "./prompt-dry-run.js";
import { sanitizeForTerminal } from "./render-safe.js";

function sanitizeInline(value: string): string {
	return sanitizeForTerminal(value);
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
	const safeContent = sanitizeForTerminal(content, { preserveLineBreaks: true });
	const longest = Math.max(3, ...Array.from(safeContent.matchAll(/`+/g), (match) => match[0].length + 1));
	const fence = "`".repeat(longest);
	return `${fence}${language}\n${safeContent}\n${fence}`;
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

function appendCompareSlots(lines: string[], title: string, slots: BestOfNPreflightSlot[]): void {
	lines.push("", `### ${title}`);
	if (slots.length === 0) {
		lines.push("- (none)");
		return;
	}
	for (const slot of slots) {
		lines.push(`- ${slot.kind} ${slot.index}: agent=${formatScalar(slot.agent ?? "delegate")}, model=${formatScalar(slot.effectiveModelLabel)}, cwd=${formatScalar(slot.cwd)}, source=${formatScalar(slot.source)}`);
		if (slot.taskSuffix) lines.push(`  - task suffix: ${formatScalar(slot.taskSuffix)}`);
	}
}

function appendComparePreflight(lines: string[], preflight: BestOfNPreflight): void {
	lines.push("", "## Compare preflight");
	lines.push(`- Prompt source: ${formatScalar(preflight.prompt.source)} ${formatScalar(preflight.prompt.filePath)}`);
	lines.push(`- Compare cwd: ${formatScalar(preflight.compareCwd.resolved)} (${formatScalar(preflight.compareCwd.source)})`);
	if (preflight.preset) {
		lines.push(`- Preset: ${formatScalar(preflight.preset.name)} (${formatScalar(preflight.preset.trust)})`);
		if (preflight.preset.filePath) lines.push(`  - Path: ${formatScalar(preflight.preset.filePath)}`);
		if (preflight.preset.defaultModel) lines.push(`  - Default model: ${formatScalar(preflight.preset.defaultModel)}`);
		if (preflight.preset.maxModelCalls !== undefined) lines.push(`  - Max model calls: ${formatScalar(preflight.preset.maxModelCalls)}`);
	} else {
		lines.push("- Preset: none");
	}
	lines.push(`- Calls: workers=${formatScalar(preflight.callCount.workers)}, reviewers=${formatScalar(preflight.callCount.reviewers)}, final-applier=${formatScalar(preflight.callCount.finalApplier)}, total=${formatScalar(preflight.callCount.total)}, cap=${formatScalar(preflight.callCount.cap)}, status=${formatScalar(preflight.callCount.capStatus)}`);
	lines.push(`- Worktree: ${formatScalar(preflight.policies.worktree.enabled)} (${formatScalar(preflight.policies.worktree.workerCwdPolicy)})`);
	lines.push(`- Final applier: ${formatScalar(preflight.policies.finalApplier.enabled)}`);
	lines.push(`- Commit policy: ${formatScalar(preflight.policies.commit.mode)}`);
	lines.push(`- Report root: ${formatScalar(preflight.artifacts.report.root)}`);
	lines.push(`- Raw artifacts: keep=${formatScalar(preflight.artifacts.rawArtifacts.keepArtifacts)}, files=${formatScalar(preflight.artifacts.rawArtifacts.expectedFiles.join(", ") || "none")}`);
	appendCompareSlots(lines, "Workers", preflight.slots.workers);
	appendCompareSlots(lines, "Reviewers", preflight.slots.reviewers);
	if (preflight.slots.finalApplier) appendCompareSlots(lines, "Final applier", [preflight.slots.finalApplier]);
	if (preflight.diagnostics.length) {
		lines.push("", "### Compare diagnostics");
		for (const diagnostic of preflight.diagnostics) lines.push(`- ${formatScalar(diagnostic.severity)} ${formatScalar(diagnostic.code)}: ${formatScalar(diagnostic.message)}`);
	}
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
	lines.push(`- Model: ${result.model !== undefined ? sanitizeInline(modelLabel(result.model)) : "compare preflight"}`);
	lines.push(`- Model already active: ${formatScalar(result.modelAlreadyActive)}`);
	formatRuntime(result.runtime, lines);
	if (result.comparePreflight) appendComparePreflight(lines, result.comparePreflight);
	appendWarnings(lines, result.warnings);
	appendSkills(lines, result);
	appendArgs(lines, result.args);
	lines.push("", "## Prompt body", fencedBlock("markdown", result.content));
	return `${lines.join("\n")}\n`;
}
