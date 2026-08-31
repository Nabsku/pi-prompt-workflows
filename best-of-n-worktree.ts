import { execFileSync, spawn } from "node:child_process";
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
	registerFinalTarget(targetCwd: string): string;
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

interface BoundedGitOutput {
	readonly output: string;
	readonly truncated: boolean;
}

function runGitBounded(
	cwd: string,
	args: readonly string[],
	maxBytes: number,
	allowedStatuses: readonly number[] = [],
): Promise<BoundedGitOutput> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let outputBytes = 0;
		let truncated = false;
		let killRequested = false;
		let timedOut = false;
		let settled = false;
		let stderr = "";
		const child = spawn("git", [...GIT_SAFE_ARGS, ...args], {
			cwd,
			env: sanitizedGitEnvironment(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, GIT_COMMAND_TIMEOUT_MS);
		const fail = (cause: unknown): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(new BestOfNWorktreeError("Git worktree operation failed.", { cause }));
		};

		child.stdout?.on("data", (chunk: Buffer | string) => {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (outputBytes < maxBytes) {
				const remaining = maxBytes - outputBytes;
				const kept = bytes.subarray(0, remaining);
				if (kept.length > 0) {
					chunks.push(kept);
					outputBytes += kept.length;
				}
				if (kept.length < bytes.length) truncated = true;
			} else if (bytes.length > 0) {
				truncated = true;
			}
			if (truncated && !killRequested) {
				killRequested = true;
				child.kill("SIGTERM");
			}
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length);
		});
		child.once("error", (cause: unknown) => fail(cause));
		child.once("close", (status: number | null, signal: string | null) => {
			clearTimeout(timeout);
			if (settled) return;
			if (timedOut) {
				fail(new Error(`Git worktree operation timed out after ${GIT_COMMAND_TIMEOUT_MS}ms.`));
				return;
			}
			if (status === 0 || (status !== null && allowedStatuses.includes(status)) || (truncated && killRequested)) {
				settled = true;
				resolve({ output: Buffer.concat(chunks).toString("utf8"), truncated });
				return;
			}
			const detail = stderr.trim().split(/\r?\n/, 1)[0];
			const cause = new Error(`git exited with ${signal ? `signal ${signal}` : `status ${status}`}${detail ? `: ${detail}` : ""}`);
			fail(cause);
		});
	});
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

function splitNulRecords(output: string, dropIncompleteTrailingRecord = false): string[] {
	const records = output.split("\0");
	if (dropIncompleteTrailingRecord && !output.endsWith("\0")) records.pop();
	return records.filter((record) => record.length > 0);
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

function registerSourceBaseline(
	sourceCwd: string,
	baselines: Map<string, SourceBaseline>,
): { canonicalSourceCwd: string; repositoryRoot: string; sourceRelativeCwd: string; baseline: SourceBaseline } {
	const { canonicalSourceCwd, repositoryRoot, sourceRelativeCwd } = resolveSourceCwdContext(sourceCwd);
	assertSourceCwdIsTrackedByWorktree(repositoryRoot, canonicalSourceCwd, sourceRelativeCwd);
	let baseline = baselines.get(repositoryRoot);
	if (!baseline) {
		baseline = captureSourceBaseline(repositoryRoot);
		baselines.set(repositoryRoot, baseline);
	}
	return { canonicalSourceCwd, repositoryRoot, sourceRelativeCwd, baseline };
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

function truncateUtf8Prefix(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (utf8Bytes(value) <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (utf8Bytes(value.slice(0, mid)) <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return value.slice(0, low);
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
	if (utf8Bytes(value) <= maxBytes) return { text: value, truncated: false };
	const markerBytes = utf8Bytes(CANDIDATE_CHANGE_TRUNCATION_MARKER);
	const availableBytes = Math.max(0, maxBytes - markerBytes);
	return { text: `${truncateUtf8Prefix(value, availableBytes).trimEnd()}${CANDIDATE_CHANGE_TRUNCATION_MARKER}`, truncated: true };
}

const REDACTED_MARKER = "[REDACTED]";
const SENSITIVE_ASSIGNMENT_KEY = "(?:api[_-]?(?:key|token|secret)|access[_-]?(?:token|key|secret)|auth(?:entication)?[_-]?(?:token|key|secret)?|authorization|bearer|client[_-]?(?:secret|token|key)|credential(?:s)?|password|passwd|passphrase|pass|pwd|private[_-]?key|secret(?:s)?(?:[_-]?(?:value|key|token|access))?|token(?:[_-]?(?:value|secret|key))?|signing[_-]?key|encryption[_-]?key|master[_-]?key|refresh[_-]?token|session[_-]?token|webhook[_-]?secret|key|token)";
const SECRET_ASSIGNMENT = new RegExp(`((?:^|\\s|,|\\{|\\(|\\[|=|:|\\+|\\-)["']?(?:[A-Za-z_][A-Za-z0-9_.-]*?)?${SENSITIVE_ASSIGNMENT_KEY}[A-Za-z0-9_.-]*["']?\\s*[:=]\\s*)(.*)$`, "gi");
const SENSITIVE_ASSIGNMENT_HINT = /(?:api|access|auth|bearer|client|credential|pass|private|secret|token|signing|encryption|master|refresh|session|webhook|key)/i;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const AUTHORIZATION_CREDENTIALS = /\b(Bearer|Basic)\s+[^\s,;]+/gi;
const KNOWN_API_TOKENS = /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}|gh[pousr]_[A-Za-z0-9][A-Za-z0-9_-]{7,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g;
const PRIVATE_KEY_BEGIN = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i;
const PRIVATE_KEY_END = /-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/i;

function isSensitiveCandidatePath(path: string): boolean {
	const normalized = path.replace(/^"|"$/g, "").replaceAll("\\", "/");
	const basename = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
	return basename === ".env"
		|| basename.startsWith(".env.")
		|| basename.includes("credential")
		|| basename.includes("secret")
		|| basename.includes("password")
		|| basename.includes("token")
		|| basename.endsWith(".pem")
		|| basename.endsWith(".key")
		|| basename === "id_rsa"
		|| basename === "id_ed25519";
}

function diffPathsFromHeader(line: string): readonly [string, string] | undefined {
	const diffHeader = line.match(/^diff --git a\/(.+) b\/(.+)$/);
	return diffHeader ? [diffHeader[1], diffHeader[2]] : undefined;
}

function isDiffContentLine(line: string, inHunk: boolean): boolean {
	return inHunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"));
}

function redactDiffContentLine(line: string, inHunk: boolean): string {
	return `${isDiffContentLine(line, inHunk) ? line[0] : ""}${REDACTED_MARKER}`;
}

function redactSensitiveLine(line: string): string {
	let redacted = line.replace(URL_CREDENTIALS, `$1${REDACTED_MARKER}@`);
	redacted = redacted.replace(AUTHORIZATION_CREDENTIALS, `$1 ${REDACTED_MARKER}`);
	if (/[=:]/.test(redacted) && SENSITIVE_ASSIGNMENT_HINT.test(redacted)) {
		redacted = redacted.replace(SECRET_ASSIGNMENT, `$1${REDACTED_MARKER}`);
	}
	return redacted.replace(KNOWN_API_TOKENS, REDACTED_MARKER);
}

function redactGitOutput(output: string): string {
	let sensitiveFile = false;
	let inPrivateKey = false;
	let inHunk = false;
	return output.split("\n").map((line) => {
		const paths = diffPathsFromHeader(line);
		if (paths !== undefined) {
			sensitiveFile = paths.some((path) => isSensitiveCandidatePath(path));
			inHunk = false;
		}
		if (line.startsWith("@@")) inHunk = true;
		const contentLine = isDiffContentLine(line, inHunk);
		const payload = contentLine ? line.slice(1) : line;
		if (inPrivateKey) {
			if (PRIVATE_KEY_END.test(payload)) inPrivateKey = false;
			return redactDiffContentLine(line, inHunk);
		}
		if (contentLine && PRIVATE_KEY_BEGIN.test(payload)) {
			inPrivateKey = !PRIVATE_KEY_END.test(payload);
			return redactDiffContentLine(line, inHunk);
		}
		if (sensitiveFile && contentLine) return redactDiffContentLine(line, inHunk);
		return redactSensitiveLine(line);
	}).join("\n");
}

function untrackedDiffArgs(path: string, stat: boolean): string[] {
	const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
	return ["diff", "--no-index", "--no-ext-diff", "--no-textconv", ...(stat ? ["--stat"] : []), "--", nullFile, path];
}

interface EvidenceAccumulator {
	readonly maxBytes: number;
	value: string;
	truncated: boolean;
}

function evidenceAccumulator(maxBytes: number): EvidenceAccumulator {
	return { maxBytes, value: "", truncated: false };
}

function evidenceRemainingBytes(accumulator: EvidenceAccumulator): number {
	const separatorBytes = accumulator.value.length > 0 ? utf8Bytes("\n") : 0;
	return Math.max(0, accumulator.maxBytes - utf8Bytes(accumulator.value) - separatorBytes);
}

function appendEvidenceOutput(accumulator: EvidenceAccumulator, output: string, sourceTruncated = false): void {
	if (sourceTruncated) accumulator.truncated = true;
	const normalized = output.trimEnd();
	if (!normalized) return;
	const separator = accumulator.value.length > 0 ? "\n" : "";
	const availableBytes = accumulator.maxBytes - utf8Bytes(accumulator.value) - utf8Bytes(separator);
	if (availableBytes <= 0) {
		accumulator.truncated = true;
		return;
	}
	if (utf8Bytes(normalized) > availableBytes) accumulator.truncated = true;
	accumulator.value += `${separator}${truncateUtf8Prefix(normalized, availableBytes)}`;
}

async function appendUntrackedEvidence(
	accumulator: EvidenceAccumulator,
	workspaceRoot: string,
	path: string,
	stat: boolean,
): Promise<void> {
	if (accumulator.truncated) return;
	const remainingBytes = evidenceRemainingBytes(accumulator);
	if (remainingBytes <= 0) {
		accumulator.truncated = true;
		return;
	}
	const captured = await runGitBounded(workspaceRoot, untrackedDiffArgs(path, stat), remainingBytes, [0, 1]);
	appendEvidenceOutput(accumulator, redactGitOutput(captured.output), captured.truncated);
}

function truncateCapturedEvidence(value: string, maxBytes: number, alreadyTruncated: boolean): { text: string; truncated: boolean } {
	const truncated = truncateUtf8(value, maxBytes);
	if (!alreadyTruncated || truncated.truncated) return truncated;
	const markerBytes = utf8Bytes(CANDIDATE_CHANGE_TRUNCATION_MARKER);
	const availableBytes = Math.max(0, maxBytes - markerBytes);
	const prefix = truncateUtf8Prefix(value, availableBytes).trimEnd();
	return { text: `${prefix}${CANDIDATE_CHANGE_TRUNCATION_MARKER}`, truncated: true };
}

export async function captureBestOfNWorktreeChanges(workspace: IsolatedBestOfNWorktree): Promise<BestOfNWorktreeChanges | undefined> {
	const currentHead = runGit(workspace.root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	let trackedStat = await runGitBounded(workspace.root, ["diff", "--stat", "--no-ext-diff", "--no-textconv", workspace.baseCommit, "--"], CANDIDATE_CHANGE_STAT_BYTE_LIMIT);
	let trackedDiff = await runGitBounded(workspace.root, ["diff", "--no-ext-diff", "--no-textconv", workspace.baseCommit, "--"], CANDIDATE_CHANGE_DIFF_BYTE_LIMIT);
	if (!trackedDiff.output.trim() && currentHead !== workspace.baseCommit) {
		const baseToHead = `${workspace.baseCommit}..HEAD`;
		trackedStat = await runGitBounded(workspace.root, ["diff", "--stat", "--no-ext-diff", "--no-textconv", baseToHead, "--"], CANDIDATE_CHANGE_STAT_BYTE_LIMIT);
		trackedDiff = await runGitBounded(workspace.root, ["diff", "--no-ext-diff", "--no-textconv", baseToHead, "--"], CANDIDATE_CHANGE_DIFF_BYTE_LIMIT);
	}

	const untrackedListing = await runGitBounded(workspace.root, ["ls-files", "--others", "--exclude-standard", "-z"], GIT_MAX_OUTPUT_BYTES);
	const untracked = splitNulRecords(untrackedListing.output, untrackedListing.truncated)
		.filter((path) => !isBridgeRuntimeSubagentsPath(path));
	const statEvidence = evidenceAccumulator(CANDIDATE_CHANGE_STAT_BYTE_LIMIT);
	const diffEvidence = evidenceAccumulator(CANDIDATE_CHANGE_DIFF_BYTE_LIMIT);
	appendEvidenceOutput(statEvidence, redactGitOutput(trackedStat.output), trackedStat.truncated);
	appendEvidenceOutput(diffEvidence, redactGitOutput(trackedDiff.output), trackedDiff.truncated);
	for (const path of untracked) {
		await appendUntrackedEvidence(statEvidence, workspace.root, path, true);
		await appendUntrackedEvidence(diffEvidence, workspace.root, path, false);
		if (statEvidence.truncated && diffEvidence.truncated) break;
	}
	if (untrackedListing.truncated) {
		statEvidence.truncated = true;
		diffEvidence.truncated = true;
	}
	if (!statEvidence.value && !diffEvidence.value && !statEvidence.truncated && !diffEvidence.truncated) return undefined;

	const stat = truncateCapturedEvidence(statEvidence.value, CANDIDATE_CHANGE_STAT_BYTE_LIMIT, statEvidence.truncated);
	const diff = truncateCapturedEvidence(diffEvidence.value, CANDIDATE_CHANGE_DIFF_BYTE_LIMIT, diffEvidence.truncated);
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
	let registeredFinalTargetCwd: string | undefined;
	let cleaned = false;

	return {
		create(sourceCwd, label) {
			if (cleaned) throw new BestOfNWorktreeError("Best-of-N worker worktree manager was already cleaned up.");
			const { canonicalSourceCwd, repositoryRoot, sourceRelativeCwd, baseline } = registerSourceBaseline(sourceCwd, baselines);

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

		registerFinalTarget(targetCwd) {
			if (cleaned) throw new BestOfNWorktreeError("Best-of-N worker worktree manager was already cleaned up.");
			const registration = registerSourceBaseline(targetCwd, baselines);
			registeredFinalTargetCwd = registration.canonicalSourceCwd;
			return registeredFinalTargetCwd;
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
