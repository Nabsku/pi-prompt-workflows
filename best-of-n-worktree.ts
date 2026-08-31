import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { sanitizedGitEnvironment } from "./git-environment.js";

const GIT_COMMAND_TIMEOUT_MS = 120_000;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
const CANDIDATE_CHANGE_STAT_BYTE_LIMIT = 64 * 1024;
const CANDIDATE_CHANGE_DIFF_BYTE_LIMIT = 512 * 1024;
const CANDIDATE_CHANGE_TRUNCATION_MARKER = "\n[bestOfN candidate change evidence truncated.]\n";
const BRIDGE_RUNTIME_SUBAGENTS_PATH = ".pi/subagents";
const GIT_SAFE_ARGS = [
	"--no-optional-locks",
	"--no-replace-objects",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"diff.external=",
	"-c",
	"core.pager=cat",
	"-c",
	`core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
] as const;

export class BestOfNWorktreeError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "BestOfNWorktreeError";
	}
}

export interface IsolatedBestOfNWorktree {
	readonly root: string;
	readonly cwd: string;
	readonly sourceCwd: string;
	readonly baseCommit: string;
}

export interface BestOfNWorktreeChanges {
	readonly stat: string;
	readonly diff: string;
	readonly truncated: boolean;
}

export interface BestOfNWorktreeCleanupResult {
	readonly preservedWorktrees: readonly string[];
	readonly preservedRunRoot?: string;
}

export interface BestOfNWorktreeManager {
	create(sourceCwd: string, label: string): IsolatedBestOfNWorktree;
	assertSourceBaselinesUnchanged(): void;
	cleanup(options?: { preserveRoots?: readonly string[] }): BestOfNWorktreeCleanupResult;
}

interface SourceCleanState {
	readonly hiddenIndexFlagPaths: readonly string[];
	readonly trackedChanges: readonly string[];
	readonly untrackedChanges: readonly string[];
	readonly digest: string;
}

interface SourceBaseline {
	readonly repositoryRoot: string;
	readonly baseCommit: string;
	readonly cleanState: SourceCleanState;
}

interface SourceCwdContext {
	readonly canonicalSourceCwd: string;
	readonly repositoryRoot: string;
	readonly sourceRelativeCwd: string;
}

function runGit(cwd: string, args: readonly string[]): string {
	try {
		return execFileSync("git", [...GIT_SAFE_ARGS, ...args], {
			cwd,
			encoding: "utf8",
			env: sanitizedGitEnvironment(),
			maxBuffer: GIT_MAX_OUTPUT_BYTES,
			timeout: GIT_COMMAND_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (cause: any) {
		const stderr = typeof cause?.stderr === "string" ? cause.stderr.trim().split(/\r?\n/, 1)[0] : "";
		throw new BestOfNWorktreeError(
			`Git worktree operation failed${stderr ? `: ${stderr.slice(0, 400)}` : ""}.`,
			{ cause },
		);
	}
}

function runGitAllowingExit(cwd: string, args: readonly string[], allowedStatuses: readonly number[]): string {
	try {
		return execFileSync("git", [...GIT_SAFE_ARGS, ...args], {
			cwd,
			encoding: "utf8",
			env: sanitizedGitEnvironment(),
			maxBuffer: GIT_MAX_OUTPUT_BYTES,
			timeout: GIT_COMMAND_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (cause: any) {
		const status = typeof cause?.status === "number" ? cause.status : undefined;
		if (status !== undefined && allowedStatuses.includes(status)) {
			return typeof cause.stdout === "string" ? cause.stdout : "";
		}
		const stderr = typeof cause?.stderr === "string" ? cause.stderr.trim().split(/\r?\n/, 1)[0] : "";
		throw new BestOfNWorktreeError(
			`Git worktree operation failed${stderr ? `: ${stderr.slice(0, 400)}` : ""}.`,
			{ cause },
		);
	}
}

function canonicalPath(path: string, label: string): string {
	try {
		return realpathSync(path);
	} catch (cause) {
		throw new BestOfNWorktreeError(`Cannot resolve ${label} \`${path}\` for best-of-N worker isolation.`, { cause });
	}
}

function isWithin(root: string, candidate: string): boolean {
	const childPath = relative(root, candidate);
	return childPath === "" || (childPath !== ".." && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath));
}

function gitPath(path: string): string {
	return path.split(sep).join("/");
}

function splitNulRecords(output: string): string[] {
	return output.split("\0").filter((record) => record.length > 0);
}

function isBridgeRuntimeSubagentsPath(path: string): boolean {
	return path === BRIDGE_RUNTIME_SUBAGENTS_PATH || path.startsWith(`${BRIDGE_RUNTIME_SUBAGENTS_PATH}/`);
}

function formatPathList(paths: readonly string[]): string {
	const visible = paths.slice(0, 3).map((path) => `\`${path}\``).join(", ");
	const remaining = paths.length - Math.min(paths.length, 3);
	return remaining > 0 ? `${visible}, and ${remaining} more` : visible;
}

function digestCleanState(state: Omit<SourceCleanState, "digest">): string {
	const hash = createHash("sha256");
	for (const path of state.hiddenIndexFlagPaths) hash.update("hidden").update("\0").update(path).update("\0");
	for (const path of state.trackedChanges) hash.update("tracked").update("\0").update(path).update("\0");
	for (const path of state.untrackedChanges) hash.update("untracked").update("\0").update(path).update("\0");
	return hash.digest("hex");
}

function hiddenIndexFlagPaths(sourceCwd: string): string[] {
	const entries = splitNulRecords(runGit(sourceCwd, ["ls-files", "-v", "-z"]));
	return entries.flatMap((entry) => {
		const marker = entry[0];
		const path = entry.slice(2);
		if (!marker || entry[1] !== " " || !path) {
			throw new BestOfNWorktreeError(`Git returned an unexpected tracked-file record while checking \`${sourceCwd}\` for best-of-N worker isolation.`);
		}
		return marker === "S" || /^[a-z]$/.test(marker) ? [path] : [];
	});
}

function captureCleanState(sourceCwd: string): SourceCleanState {
	const flaggedIndexPaths = hiddenIndexFlagPaths(sourceCwd);
	const trackedChanges = splitNulRecords(runGit(sourceCwd, ["diff-index", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "HEAD", "--"]));
	const untrackedChanges = splitNulRecords(runGit(sourceCwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
		.filter((path) => !isBridgeRuntimeSubagentsPath(path));
	const state = { hiddenIndexFlagPaths: flaggedIndexPaths, trackedChanges, untrackedChanges };
	return { ...state, digest: digestCleanState(state) };
}

function assertCleanState(sourceCwd: string, state: SourceCleanState): void {
	const flaggedIndexPaths = state.hiddenIndexFlagPaths;
	if (flaggedIndexPaths.length > 0) {
		throw new BestOfNWorktreeError(
			`Best-of-N worker isolation requires tracked files to be visible to Git at \`${sourceCwd}\`. Clear assume-unchanged/skip-worktree index flags for ${formatPathList(flaggedIndexPaths)} before retrying.`,
		);
	}
	const trackedChanges = state.trackedChanges;
	const untrackedChanges = state.untrackedChanges;
	if (trackedChanges.length > 0 || untrackedChanges.length > 0) {
		throw new BestOfNWorktreeError(
			`Best-of-N worker isolation requires a clean Git worktree at \`${sourceCwd}\`. Commit or stash changes before retrying.`,
		);
	}
}

function assertSourceCwdIsTrackedByWorktree(repositoryRoot: string, canonicalSourceCwd: string, sourceRelativeCwd: string): void {
	if (!sourceRelativeCwd) return;
	const relativeGitPath = gitPath(sourceRelativeCwd);
	try {
		execFileSync("git", [...GIT_SAFE_ARGS, "check-ignore", "--quiet", "--no-index", "--", relativeGitPath], {
			cwd: repositoryRoot,
			encoding: "utf8",
			env: sanitizedGitEnvironment(),
			maxBuffer: GIT_MAX_OUTPUT_BYTES,
			timeout: GIT_COMMAND_TIMEOUT_MS,
			stdio: ["ignore", "ignore", "pipe"],
		});
		throw new BestOfNWorktreeError(
			`Best-of-N worker isolation cannot use ignored Git path \`${canonicalSourceCwd}\` as a slot cwd. Worker worktrees contain tracked files only and do not provision or link ignored dependencies; choose a tracked cwd before retrying.`,
		);
	} catch (cause: any) {
		if (cause instanceof BestOfNWorktreeError) throw cause;
		if (cause?.status === 1) return;
		const stderr = typeof cause?.stderr === "string" ? cause.stderr.trim().split(/\r?\n/, 1)[0] : "";
		throw new BestOfNWorktreeError(
			`Git worktree operation failed${stderr ? `: ${stderr.slice(0, 400)}` : ""}.`,
			{ cause },
		);
	}
}

function resolveSourceCwdContext(sourceCwd: string): SourceCwdContext {
	const canonicalSourceCwd = canonicalPath(sourceCwd, "worker cwd");
	const repositoryRoot = canonicalPath(runGit(canonicalSourceCwd, ["rev-parse", "--show-toplevel"]).trim(), "Git repository root");
	const sourceRelativeCwd = relative(repositoryRoot, canonicalSourceCwd);
	if (!isWithin(repositoryRoot, canonicalSourceCwd)) {
		throw new BestOfNWorktreeError(`Worker cwd \`${canonicalSourceCwd}\` is outside its Git repository root.`);
	}
	return { canonicalSourceCwd, repositoryRoot, sourceRelativeCwd };
}

export function assertBestOfNSourceCwdNotIgnored(sourceCwd: string): void {
	const { canonicalSourceCwd, repositoryRoot, sourceRelativeCwd } = resolveSourceCwdContext(sourceCwd);
	assertSourceCwdIsTrackedByWorktree(repositoryRoot, canonicalSourceCwd, sourceRelativeCwd);
}

function captureSourceBaseline(repositoryRoot: string): SourceBaseline {
	const cleanState = captureCleanState(repositoryRoot);
	assertCleanState(repositoryRoot, cleanState);
	const baseCommit = runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	if (!baseCommit) throw new BestOfNWorktreeError(`Git repository at \`${repositoryRoot}\` has no commit to isolate.`);
	return { repositoryRoot, baseCommit, cleanState };
}

function assertSourceBaselineUnchanged(baseline: SourceBaseline): void {
	const currentState = captureCleanState(baseline.repositoryRoot);
	assertCleanState(baseline.repositoryRoot, currentState);
	const currentHead = runGit(baseline.repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	if (currentHead !== baseline.baseCommit) {
		throw new BestOfNWorktreeError(
			`Best-of-N source baseline changed at \`${baseline.repositoryRoot}\`: HEAD changed from ${baseline.baseCommit} to ${currentHead}. Re-run best-of-N from a stable source workspace.`,
		);
	}
	if (currentState.digest !== baseline.cleanState.digest) {
		throw new BestOfNWorktreeError(
			`Best-of-N source baseline changed at \`${baseline.repositoryRoot}\`: source clean-state digest changed before final apply. Re-run best-of-N from a stable source workspace.`,
		);
	}
}

function safeDirectoryName(label: string): string {
	const normalized = label.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
	return normalized || "slot";
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
	if (utf8Bytes(value) <= maxBytes) return { text: value, truncated: false };
	const markerBytes = utf8Bytes(CANDIDATE_CHANGE_TRUNCATION_MARKER);
	const availableBytes = Math.max(0, maxBytes - markerBytes);
	let low = 0;
	let high = value.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (utf8Bytes(value.slice(0, mid)) <= availableBytes) low = mid;
		else high = mid - 1;
	}
	return { text: `${value.slice(0, low).trimEnd()}${CANDIDATE_CHANGE_TRUNCATION_MARKER}`, truncated: true };
}

function joinGitOutputs(outputs: readonly string[]): string {
	return outputs.map((output) => output.trimEnd()).filter((output) => output.length > 0).join("\n");
}

function untrackedDiffArgs(path: string, stat: boolean): string[] {
	const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
	return ["diff", "--no-index", "--no-ext-diff", ...(stat ? ["--stat"] : []), "--", nullFile, path];
}

export function captureBestOfNWorktreeChanges(workspace: IsolatedBestOfNWorktree): BestOfNWorktreeChanges | undefined {
	const currentHead = runGit(workspace.root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	let trackedStat = runGit(workspace.root, ["diff", "--stat", "--no-ext-diff", "--no-textconv", workspace.baseCommit, "--"]);
	let trackedDiff = runGit(workspace.root, ["diff", "--no-ext-diff", "--no-textconv", workspace.baseCommit, "--"]);
	if (!trackedDiff.trim() && currentHead !== workspace.baseCommit) {
		const baseToHead = `${workspace.baseCommit}..HEAD`;
		trackedStat = runGit(workspace.root, ["diff", "--stat", "--no-ext-diff", "--no-textconv", baseToHead, "--"]);
		trackedDiff = runGit(workspace.root, ["diff", "--no-ext-diff", "--no-textconv", baseToHead, "--"]);
	}

	const untracked = splitNulRecords(runGit(workspace.root, ["ls-files", "--others", "--exclude-standard", "-z"]))
		.filter((path) => !isBridgeRuntimeSubagentsPath(path));
	const untrackedStats = untracked.map((path) => runGitAllowingExit(workspace.root, untrackedDiffArgs(path, true), [0, 1]));
	const untrackedDiffs = untracked.map((path) => runGitAllowingExit(workspace.root, untrackedDiffArgs(path, false), [0, 1]));
	const rawStat = joinGitOutputs([trackedStat, ...untrackedStats]);
	const rawDiff = joinGitOutputs([trackedDiff, ...untrackedDiffs]);
	if (!rawStat && !rawDiff) return undefined;

	const stat = truncateUtf8(rawStat, CANDIDATE_CHANGE_STAT_BYTE_LIMIT);
	const diff = truncateUtf8(rawDiff, CANDIDATE_CHANGE_DIFF_BYTE_LIMIT);
	return {
		stat: stat.text,
		diff: diff.text,
		truncated: stat.truncated || diff.truncated,
	};
}

export function createBestOfNWorktreeManager(): BestOfNWorktreeManager {
	const runRoot = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-worktrees-"));
	const created: IsolatedBestOfNWorktree[] = [];
	const baselines = new Map<string, SourceBaseline>();
	let cleaned = false;

	return {
		create(sourceCwd, label) {
			if (cleaned) throw new BestOfNWorktreeError("Best-of-N worker worktree manager was already cleaned up.");
			const { canonicalSourceCwd, repositoryRoot, sourceRelativeCwd } = resolveSourceCwdContext(sourceCwd);
			assertSourceCwdIsTrackedByWorktree(repositoryRoot, canonicalSourceCwd, sourceRelativeCwd);
			let baseline = baselines.get(repositoryRoot);
			if (!baseline) {
				baseline = captureSourceBaseline(repositoryRoot);
				baselines.set(repositoryRoot, baseline);
			}

			const target = join(runRoot, `${created.length + 1}-${safeDirectoryName(label)}`);
			try {
				runGit(repositoryRoot, ["worktree", "add", "--detach", target, baseline.baseCommit]);
				const root = canonicalPath(target, "created worker worktree");
				const cwd = canonicalPath(join(root, sourceRelativeCwd), "created worker cwd");
				const workspace = { root, cwd, sourceCwd: canonicalSourceCwd, baseCommit: baseline.baseCommit };
				created.push(workspace);
				return workspace;
			} catch (error) {
				try {
					rmSync(target, { recursive: true, force: true });
				} catch {
					// Preserve the original isolation error. Cleanup retries the known worktrees.
				}
				throw error;
			}
		},

		assertSourceBaselinesUnchanged() {
			if (cleaned) throw new BestOfNWorktreeError("Best-of-N worker worktree manager was already cleaned up.");
			for (const baseline of baselines.values()) assertSourceBaselineUnchanged(baseline);
		},

		cleanup(options: { preserveRoots?: readonly string[] } = {}) {
			if (cleaned) return { preservedWorktrees: [] };
			cleaned = true;
			const errors: unknown[] = [];
			const preserveRoots = new Set(options.preserveRoots ?? []);
			const preservedWorktrees: string[] = [];
			for (const workspace of [...created].reverse()) {
				if (preserveRoots.has(workspace.root)) {
					preservedWorktrees.push(workspace.root);
					continue;
				}
				try {
					runGit(workspace.sourceCwd, ["worktree", "remove", "--force", workspace.root]);
				} catch (error) {
					errors.push(error);
					try {
						rmSync(workspace.root, { recursive: true, force: true });
					} catch (fallbackError) {
						errors.push(fallbackError);
					}
				}
			}
			created.length = 0;
			if (preservedWorktrees.length === 0) {
				try {
					rmSync(runRoot, { recursive: true, force: true });
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length > 0) {
				throw new BestOfNWorktreeError(`Failed to clean up ${errors.length} best-of-N worker worktree operation(s).`, { cause: errors[0] });
			}
			return {
				preservedWorktrees: preservedWorktrees.reverse(),
				...(preservedWorktrees.length > 0 ? { preservedRunRoot: runRoot } : {}),
			};
		},
	};
}
