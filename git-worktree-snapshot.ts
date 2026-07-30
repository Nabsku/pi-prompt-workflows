import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, join, win32 } from "node:path";

export type GitWorktreeSnapshotErrorCode =
	| "NOT_GIT_REPOSITORY" | "GIT_NOT_FOUND" | "INVALID_CWD" | "PERMISSION_DENIED"
	| "GIT_ERROR" | "GIT_TIMEOUT" | "SNAPSHOT_TIMEOUT" | "LIMIT_EXCEEDED" | "INVALID_STATUS" | "INVALID_INDEX"
	| "UNSUPPORTED_SUBMODULE" | "UNSAFE_PATH" | "FILE_LIMIT_EXCEEDED"
	| "BYTE_LIMIT_EXCEEDED" | "IO_ERROR" | "INVALID_SNAPSHOT" | "RACE_DETECTED";

export class GitWorktreeSnapshotError extends Error {
	constructor(readonly code: GitWorktreeSnapshotErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options); this.name = "GitWorktreeSnapshotError";
	}
}

export interface GitWorktreeFileSnapshot {
	readonly path: string;
	readonly kind: "missing" | "file" | "symlink" | "directory" | "other";
	readonly fingerprint?: string; readonly mode?: number; readonly size?: number;
}
export interface GitIndexPathSnapshot { readonly path: string; readonly entries: readonly string[]; readonly fingerprint: string; }
export interface GitWorktreeSnapshot {
	readonly version: 1;
	readonly repositoryRoot: string;
	/** Canonical git-dir and common-dir, separated to distinguish linked worktrees/repository replacement. */
	readonly repositoryIdentity: { readonly rootFileId: string; readonly gitDir: string; readonly commonDir: string; readonly gitDirFileId: string; readonly commonDirFileId: string };
	/** Symbolic ref name plus target object, or detached/unborn marker. */
	readonly headIdentity: string;
	/** Compact identity of the complete index. */
	readonly indexTree: string;
	readonly status: string; readonly files: readonly GitWorktreeFileSnapshot[]; readonly index: readonly GitIndexPathSnapshot[];
}
export interface CaptureGitWorktreeSnapshotOptions { readonly maxFiles?: number; readonly maxBytes?: number; readonly maxGitOutputBytes?: number; readonly deadlineMs?: number; }
const DEFAULT_MAX_FILES = 10_000, DEFAULT_MAX_BYTES = 64 * 1024 * 1024, DEFAULT_MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
/** One monotonic wall-clock budget shared by every Git subprocess in a capture. */
export const GIT_WORKTREE_SNAPSHOT_DEADLINE_MS = 10_000;
const GIT_SAFE_GLOBAL_ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "core.pager=cat"] as const;

export function isPlatformAbsolutePath(value: string, platform: NodeJS.Platform = process.platform): boolean {
	return platform === "win32" ? win32.isAbsolute(value) : isAbsolute(value);
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 0) throw new GitWorktreeSnapshotError("INVALID_SNAPSHOT", `${name} must be a non-negative safe integer`);
	return result;
}
function classifyExecError(cause: any, fallback: GitWorktreeSnapshotErrorCode): GitWorktreeSnapshotErrorCode {
	// maxBuffer overflow also terminates the child with SIGTERM; preserve the
	// more specific output-limit classification before considering its signal.
	if (cause?.code === "ENOBUFS" || /maxBuffer/i.test(String(cause?.message))) return "LIMIT_EXCEEDED";
	if (cause?.code === "ETIMEDOUT" || cause?.signal === "SIGTERM" && cause?.status === null) return "GIT_TIMEOUT";
	if (cause?.code === "ENOENT") return "GIT_NOT_FOUND";
	if (cause?.code === "ENOTDIR") return "INVALID_CWD";
	if (cause?.code === "EACCES" || cause?.code === "EPERM") return "PERMISSION_DENIED";
	return fallback;
}
interface CaptureDeadline { readonly expiresAt: number; }
function remainingTimeout(deadline: CaptureDeadline): number {
	const remaining = Math.floor(deadline.expiresAt - performance.now());
	if (remaining <= 0) throw new GitWorktreeSnapshotError("SNAPSHOT_TIMEOUT", "Git working-tree snapshot aggregate deadline exceeded");
	return remaining;
}
function runGit(cwd: string, args: string[], fallback: GitWorktreeSnapshotErrorCode, maxBuffer: number, deadline: CaptureDeadline, input?: Buffer): Buffer {
	const safeArgs = [...GIT_SAFE_GLOBAL_ARGS, ...args];
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
	Object.assign(env, {
		GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat",
		GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1",
		GCM_INTERACTIVE: "Never", PAGER: "cat",
	});
	try {
		return execFileSync("git", safeArgs, { cwd, input, encoding: "buffer", maxBuffer, timeout: remainingTimeout(deadline), killSignal: "SIGTERM", env }) as Buffer;
	}
	catch (cause: any) {
		if (cause instanceof GitWorktreeSnapshotError) throw cause;
		let code = classifyExecError(cause, fallback);
		if (code === "GIT_TIMEOUT") code = performance.now() >= deadline.expiresAt ? "SNAPSHOT_TIMEOUT" : "GIT_TIMEOUT";
		if (fallback === "NOT_GIT_REPOSITORY" && code === fallback) {
			const stderr = Buffer.isBuffer(cause?.stderr) ? cause.stderr.toString() : String(cause?.stderr ?? "");
			if (!/not a git repository/i.test(stderr)) code = "GIT_ERROR";
		}
		throw new GitWorktreeSnapshotError(code, code === "NOT_GIT_REPOSITORY" ? `Not a Git repository: ${cwd}` : code === "GIT_TIMEOUT" || code === "SNAPSHOT_TIMEOUT" ? `Git working-tree snapshot timed out while running git ${args.join(" ")}` : `Git command failed: git ${args.join(" ")}`, { cause });
	}
}
function oneLine(output: Buffer, label: string): string {
	let end = output.length;
	if (end && output[end - 1] === 0x0a) { end--; if (end && output[end - 1] === 0x0d) end--; }
	if (!end || output.subarray(0, end).includes(0x0a)) throw new GitWorktreeSnapshotError("GIT_ERROR", `Invalid ${label} output`);
	return output.subarray(0, end).toString("utf8");
}
function splitNul(output: Buffer, code: "INVALID_STATUS" | "INVALID_INDEX" = "INVALID_STATUS"): Buffer[] {
	if (!output.length) return [];
	if (output.at(-1) !== 0) throw new GitWorktreeSnapshotError(code, "Git output was not NUL terminated");
	const records: Buffer[] = []; let start = 0;
	for (let i = 0; i < output.length; i++) if (output[i] === 0) { records.push(output.subarray(start, i)); start = i + 1; }
	return records;
}
function parseUntrackedPaths(output: Buffer): Buffer[] {
	const unique = new Map<string, Buffer>();
	for (const path of splitNul(output)) unique.set(path.toString("base64"), Buffer.from(path));
	return [...unique].sort(([a], [b]) => a.localeCompare(b)).map(([, path]) => path);
}
function fingerprintIndex(paths: readonly Buffer[], output: Buffer, maxRecords: number): GitIndexPathSnapshot[] {
	const wanted = new Map(paths.map((p) => [p.toString("base64"), [] as Buffer[]])); let count = 0;
	for (const record of splitNul(output, "INVALID_INDEX")) {
		const tab = record.indexOf(9); if (tab < 0) throw new GitWorktreeSnapshotError("INVALID_INDEX", "Malformed Git index record");
		const metadata = record.subarray(0, tab); const text = metadata.toString("ascii");
		if (!/^[0-7]{6} [0-9a-f]+ [0-3]$/.test(text)) throw new GitWorktreeSnapshotError("INVALID_INDEX", "Malformed Git index metadata");
		if (!text.endsWith(" 0")) throw new GitWorktreeSnapshotError("INVALID_INDEX", "Unmerged Git index cannot be snapshotted");
		const entries = wanted.get(record.subarray(tab + 1).toString("base64")); if (!entries) continue;
		if (++count > maxRecords) throw new GitWorktreeSnapshotError("FILE_LIMIT_EXCEEDED", "Git index snapshot record limit exceeded");
		entries.push(Buffer.from(metadata));
	}
	return paths.map((path) => { const entries = wanted.get(path.toString("base64"))!; entries.sort(Buffer.compare); const hash = createHash("sha256").update(path).update(Buffer.from([0])); if (!entries.length) hash.update("absent"); else entries.forEach((e) => hash.update(e).update(Buffer.from([0]))); return { path: path.toString("base64"), entries: entries.map((e) => e.toString("base64")), fingerprint: hash.digest("hex") }; });
}
function absolutePath(root: Buffer, relative: Buffer): Buffer {
	if (!relative.length || relative[0] === 0x2f || relative.toString("latin1").split("/").some((p) => !p || p === "." || p === "..")) throw new GitWorktreeSnapshotError("UNSAFE_PATH", "Git reported an unsafe path");
	return Buffer.concat([root, Buffer.from("/"), relative]);
}
function assertNoSymlinkedAncestors(root: Buffer, relative: Buffer): void {
	let current = root;
	let start = 0;
	for (let slash = relative.indexOf(0x2f); slash >= 0; slash = relative.indexOf(0x2f, start)) {
		current = Buffer.concat([current, Buffer.from("/"), relative.subarray(start, slash)]);
		start = slash + 1;
		try {
			const stat = lstatSync(current);
			if (stat.isSymbolicLink()) throw new GitWorktreeSnapshotError("UNSAFE_PATH", "Refusing to traverse a symlinked working-tree ancestor");
			if (!stat.isDirectory()) return;
		} catch (cause: any) {
			if (cause instanceof GitWorktreeSnapshotError) throw cause;
			if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return;
			throw new GitWorktreeSnapshotError("IO_ERROR", "Unable to inspect working-tree path ancestor", { cause });
		}
	}
}
function hashFile(path: Buffer, pre: Stats, remaining: number): { fingerprint: string; size: number; consumed: number } {
	let fd: number | undefined;
	try {
		if (!pre.isFile()) throw new GitWorktreeSnapshotError("UNSAFE_PATH", "Refusing to open a non-regular file");
		if (typeof constants.O_NOFOLLOW !== "number") throw new GitWorktreeSnapshotError("UNSAFE_PATH", "O_NOFOLLOW is unavailable");
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const stat = fstatSync(fd);
		if (!stat.isFile() || stat.dev !== pre.dev || stat.ino !== pre.ino || stat.mode !== pre.mode) throw new GitWorktreeSnapshotError("UNSAFE_PATH", "Working-tree path changed while opening");
		if (stat.size > remaining) throw new GitWorktreeSnapshotError("BYTE_LIMIT_EXCEEDED", "Working-tree snapshot byte limit exceeded");
		const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, remaining))); let consumed = 0;
		while (consumed < remaining) { const n = readSync(fd, chunk, 0, Math.min(chunk.length, remaining - consumed), null); if (!n) break; consumed += n; hash.update(chunk.subarray(0, n)); }
		const after = fstatSync(fd); if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || after.mode !== stat.mode || after.size !== consumed || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new GitWorktreeSnapshotError("IO_ERROR", "File changed while being fingerprinted");
		return { fingerprint: hash.digest("hex"), size: consumed, consumed };
	} catch (cause) { if (cause instanceof GitWorktreeSnapshotError) throw cause; throw new GitWorktreeSnapshotError("UNSAFE_PATH", "Unable to safely fingerprint working-tree file", { cause }); }
	finally { if (fd !== undefined) closeSync(fd); }
}
function fingerprint(root: Buffer, path: Buffer, remaining: number): { snapshot: GitWorktreeFileSnapshot; consumed: number } {
	const full = absolutePath(root, path); assertNoSymlinkedAncestors(root, path); let stat;
	try { stat = lstatSync(full); } catch (cause: any) { if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return { snapshot: { path: path.toString("base64"), kind: "missing" }, consumed: 0 }; throw new GitWorktreeSnapshotError("IO_ERROR", "Unable to inspect working-tree path", { cause }); }
	// Git tracks only the executable bit for regular files.
	const mode = stat.isFile() ? ((stat.mode & 0o111) ? 0o755 : 0o644) : stat.mode & 0o7777;
	if (stat.isSymbolicLink()) { try { const target = readlinkSync(full, { encoding: "buffer" }); const after = lstatSync(full); if (!after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.mode !== stat.mode) throw new GitWorktreeSnapshotError("RACE_DETECTED", "Symlink changed while being fingerprinted"); if (target.length > remaining) throw new GitWorktreeSnapshotError("BYTE_LIMIT_EXCEEDED", "Working-tree snapshot byte limit exceeded"); return { snapshot: { path: path.toString("base64"), kind: "symlink", mode, size: target.length, fingerprint: createHash("sha256").update(target).digest("hex") }, consumed: target.length }; } catch (cause) { if (cause instanceof GitWorktreeSnapshotError) throw cause; throw new GitWorktreeSnapshotError("RACE_DETECTED", "Symlink changed while reading", { cause }); } }
	if (stat.isFile()) { const h = hashFile(full, stat, remaining); return { snapshot: { path: path.toString("base64"), kind: "file", mode, size: h.size, fingerprint: h.fingerprint }, consumed: h.consumed }; }
	if (stat.isDirectory()) return { snapshot: { path: path.toString("base64"), kind: "directory" }, consumed: 0 };
	throw new GitWorktreeSnapshotError("UNSAFE_PATH", "Refusing to snapshot a special file or directory");
}
function semanticIndexIdentity(stageOutput: Buffer, flagOutput: Buffer): string {
	// Read-only ls-files views combine mode, object id, conflict stage, raw path,
	// and semantic per-entry flags (assume-unchanged / skip-worktree). Unlike
	// hashing the index file, they exclude stat-cache refreshes.
	splitNul(stageOutput, "INVALID_INDEX");
	for (const record of splitNul(flagOutput, "INVALID_INDEX")) if (record.length < 3 || record[1] !== 0x20) throw new GitWorktreeSnapshotError("INVALID_INDEX", "Malformed Git index flag record");
	return createHash("sha256").update(stageOutput).update(Buffer.from([0])).update(flagOutput).digest("hex");
}
function verifySubmodule(root: string, path: Buffer, metadata: Buffer, maxGit: number, deadline: CaptureDeadline): void {
	const relative = path.toString("utf8");
	if (!Buffer.from(relative).equals(path)) throw new GitWorktreeSnapshotError("UNSUPPORTED_SUBMODULE", "Submodule path is not safely observable");
	const full = join(root, relative);
	let stat: Stats;
	try { stat = lstatSync(full); }
	catch (cause) { throw new GitWorktreeSnapshotError("UNSUPPORTED_SUBMODULE", "Submodule is uninitialized or unobservable", { cause }); }
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GitWorktreeSnapshotError("UNSUPPORTED_SUBMODULE", "Submodule is uninitialized or unobservable");
	const match = /^160000 ([0-9a-f]+) 0$/.exec(metadata.toString("ascii"));
	if (!match) throw new GitWorktreeSnapshotError("INVALID_INDEX", "Malformed Git submodule index entry");
	let head: string;
	try { head = oneLine(runGit(full, ["rev-parse", "--verify", "HEAD^{commit}"], "GIT_ERROR", maxGit, deadline), "submodule HEAD"); }
	catch (cause) { throw new GitWorktreeSnapshotError("UNSUPPORTED_SUBMODULE", "Submodule is uninitialized or unobservable", { cause }); }
	if (head !== match[1]) throw new GitWorktreeSnapshotError("UNSUPPORTED_SUBMODULE", "Submodule HEAD does not match its staged gitlink");
	try {
		// Check HEAD versus the index without consulting worktree filters, then
		// compare every indexed path to its raw, no-filter object id.
		runGit(full, ["diff-index", "--cached", "--quiet", "HEAD", "--"], "GIT_ERROR", maxGit, deadline);
		const records = splitNul(runGit(full, ["ls-files", "--stage", "-z"], "GIT_ERROR", maxGit, deadline), "INVALID_INDEX");
		if (records.length > DEFAULT_MAX_FILES) throw new GitWorktreeSnapshotError("UNSUPPORTED_SUBMODULE", "Submodule file limit exceeded");
		let consumed = 0;
		for (const record of records) {
			const tab = record.indexOf(9); if (tab < 0) throw new GitWorktreeSnapshotError("INVALID_INDEX", "Malformed submodule index record");
			const entry = /^(100644|100755|120000|160000) ([0-9a-f]+) 0$/.exec(record.subarray(0, tab).toString("ascii"));
			if (!entry) throw new GitWorktreeSnapshotError("INVALID_INDEX", "Malformed submodule index metadata");
			if (entry[1] === "160000") throw new GitWorktreeSnapshotError("UNSUPPORTED_SUBMODULE", "Nested submodules are not safely observable");
			const subPath = Buffer.from(record.subarray(tab + 1));
			const relativeSubPath = subPath.toString("utf8");
			if (!Buffer.from(relativeSubPath).equals(subPath)) throw new GitWorktreeSnapshotError("UNSUPPORTED_SUBMODULE", "Submodule path is not safely observable");
			const first = fingerprint(Buffer.from(full), subPath, DEFAULT_MAX_BYTES - consumed); consumed += first.consumed;
			const expectedKind = entry[1] === "120000" ? "symlink" : "file";
			if (first.snapshot.kind !== expectedKind || expectedKind === "file" && first.snapshot.mode !== Number.parseInt(entry[1].slice(3), 8)) throw new GitWorktreeSnapshotError("UNSUPPORTED_SUBMODULE", "Submodule path type or mode differs from its index");
			const oid = oneLine(runGit(full, ["hash-object", "--no-filters", "--", relativeSubPath], "GIT_ERROR", maxGit, deadline), "submodule object id");
			const second = fingerprint(Buffer.from(full), subPath, DEFAULT_MAX_BYTES - (consumed - first.consumed));
			if (oid !== entry[2] || JSON.stringify(first.snapshot) !== JSON.stringify(second.snapshot)) throw new GitWorktreeSnapshotError("UNSUPPORTED_SUBMODULE", "Submodule worktree differs from its index");
		}
		if (runGit(full, ["ls-files", "--others", "--exclude-standard", "-z"], "GIT_ERROR", maxGit, deadline).length) throw new GitWorktreeSnapshotError("UNSUPPORTED_SUBMODULE", "Submodule has untracked content");
	} catch (cause) {
		if (cause instanceof GitWorktreeSnapshotError && cause.code === "UNSUPPORTED_SUBMODULE") throw cause;
		throw new GitWorktreeSnapshotError("UNSUPPORTED_SUBMODULE", "Submodule is dirty or unobservable", { cause });
	}
}
function resolveRepositoryIdentity(cwd: string, maxGit: number, deadline: CaptureDeadline): { canonicalRoot: string; repositoryIdentity: GitWorktreeSnapshot["repositoryIdentity"] } {
	try {
		const canonicalRoot = realpathSync(oneLine(runGit(cwd, ["rev-parse", "--show-toplevel"], "NOT_GIT_REPOSITORY", maxGit, deadline), "repository root"));
		const rootLstat = lstatSync(canonicalRoot), rootStat = statSync(canonicalRoot);
		if (!rootLstat.isDirectory() || !rootStat.isDirectory() || rootLstat.dev !== rootStat.dev || rootLstat.ino !== rootStat.ino) throw new GitWorktreeSnapshotError("RACE_DETECTED", "Git working-tree root changed while resolving repository identity");
		const gitDir = realpathSync(oneLine(runGit(canonicalRoot, ["rev-parse", "--absolute-git-dir"], "GIT_ERROR", maxGit, deadline), "git dir"));
		const commonRaw = oneLine(runGit(canonicalRoot, ["rev-parse", "--git-common-dir"], "GIT_ERROR", maxGit, deadline), "git common dir");
		const commonDir = realpathSync(isPlatformAbsolutePath(commonRaw) ? commonRaw : `${canonicalRoot}/${commonRaw}`);
		const gitStat = statSync(gitDir), commonStat = statSync(commonDir);
		return { canonicalRoot, repositoryIdentity: { rootFileId: `${rootStat.dev}:${rootStat.ino}`, gitDir, commonDir, gitDirFileId: `${gitStat.dev}:${gitStat.ino}`, commonDirFileId: `${commonStat.dev}:${commonStat.ino}` } };
	} catch (cause) { if (cause instanceof GitWorktreeSnapshotError) throw cause; throw new GitWorktreeSnapshotError("IO_ERROR", "Unable to resolve Git repository identity", { cause }); }
}
export function captureGitWorktreeSnapshot(cwd: string, options: CaptureGitWorktreeSnapshotOptions = {}): GitWorktreeSnapshot {
	const maxFiles = positiveLimit(options.maxFiles, DEFAULT_MAX_FILES, "maxFiles"), maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes"), maxGit = positiveLimit(options.maxGitOutputBytes, DEFAULT_MAX_GIT_OUTPUT_BYTES, "maxGitOutputBytes");
	if (maxFiles > DEFAULT_MAX_FILES) throw new GitWorktreeSnapshotError("INVALID_SNAPSHOT", `maxFiles cannot exceed ${DEFAULT_MAX_FILES}`);
	if (maxBytes > DEFAULT_MAX_BYTES) throw new GitWorktreeSnapshotError("INVALID_SNAPSHOT", `maxBytes cannot exceed ${DEFAULT_MAX_BYTES}`);
	const deadlineMs = positiveLimit(options.deadlineMs, GIT_WORKTREE_SNAPSHOT_DEADLINE_MS, "deadlineMs");
	const deadline = { expiresAt: performance.now() + deadlineMs };
	const { canonicalRoot, repositoryIdentity } = resolveRepositoryIdentity(cwd, maxGit, deadline);
	let symbolic = "";
	try { symbolic = oneLine(runGit(canonicalRoot, ["symbolic-ref", "-q", "HEAD"], "GIT_ERROR", maxGit, deadline), "symbolic HEAD"); }
	catch (error: any) { const status = error?.cause?.status; if (status !== 1) throw error; }
	let headIdentity: string;
	try {
		const oid = oneLine(runGit(canonicalRoot, ["rev-parse", "--verify", "HEAD^{commit}"], "GIT_ERROR", maxGit, deadline), "HEAD");
		headIdentity = symbolic ? `symbolic:${symbolic}:${oid}` : `detached:${oid}`;
	} catch (error) {
		if (!symbolic) throw error;
		headIdentity = `unborn:${symbolic}`;
	}
	// Avoid `git status`: it can run configured clean/process filters. Tracked
	// paths are covered by the index and raw worktree fingerprints already.
	const status = runGit(canonicalRoot, ["ls-files", "--others", "--exclude-standard", "-z"], "GIT_ERROR", maxGit, deadline);
	const statusPaths = parseUntrackedPaths(status);
	const indexOutput = runGit(canonicalRoot, ["ls-files", "--stage", "-z"], "GIT_ERROR", maxGit, deadline);
	const indexFlagsOutput = runGit(canonicalRoot, ["ls-files", "-v", "-z"], "GIT_ERROR", maxGit, deadline);
	const indexTree = semanticIndexIdentity(indexOutput, indexFlagsOutput);
	const trackedPaths = splitNul(indexOutput, "INVALID_INDEX").map((record) => { const tab = record.indexOf(9); if (tab < 0) throw new GitWorktreeSnapshotError("INVALID_INDEX", "Malformed Git index record"); return Buffer.from(record.subarray(tab + 1)); });
	const uniquePaths = new Map<string, Buffer>(); for (const path of [...statusPaths, ...trackedPaths]) uniquePaths.set(path.toString("base64"), path);
	const paths = [...uniquePaths].sort(([a], [b]) => a.localeCompare(b)).map(([, path]) => path);
	if (paths.length > maxFiles) throw new GitWorktreeSnapshotError("FILE_LIMIT_EXCEEDED", `Working-tree snapshot file limit exceeded (${paths.length} > ${maxFiles})`);
	const index = fingerprintIndex(paths, indexOutput, maxFiles * 3); const files: GitWorktreeFileSnapshot[] = []; let consumed = 0; const rootBytes = Buffer.from(canonicalRoot);
	const gitlinks = new Map(index.flatMap((entry) => entry.entries.filter((encoded) => Buffer.from(encoded, "base64").toString("ascii").startsWith("160000 ")).map((encoded) => [entry.path, Buffer.from(encoded, "base64")] as const)));
	for (const path of paths) { const gitlink = gitlinks.get(path.toString("base64")); if (gitlink) { verifySubmodule(canonicalRoot, path, gitlink, maxGit, deadline); files.push({ path: path.toString("base64"), kind: "directory" }); continue; } const result = fingerprint(rootBytes, path, maxBytes - consumed); consumed += result.consumed; files.push(result.snapshot); }
	const finalIdentity = resolveRepositoryIdentity(canonicalRoot, maxGit, deadline);
	if (finalIdentity.canonicalRoot !== canonicalRoot || finalIdentity.repositoryIdentity.rootFileId !== repositoryIdentity.rootFileId || finalIdentity.repositoryIdentity.gitDir !== repositoryIdentity.gitDir || finalIdentity.repositoryIdentity.commonDir !== repositoryIdentity.commonDir || finalIdentity.repositoryIdentity.gitDirFileId !== repositoryIdentity.gitDirFileId || finalIdentity.repositoryIdentity.commonDirFileId !== repositoryIdentity.commonDirFileId) throw new GitWorktreeSnapshotError("RACE_DETECTED", "Git repository identity changed during snapshot capture");
	let verifiedSymbolic = "";
	try { verifiedSymbolic = oneLine(runGit(canonicalRoot, ["symbolic-ref", "-q", "HEAD"], "GIT_ERROR", maxGit, deadline), "symbolic HEAD"); }
	catch (error: any) { const exitStatus = error?.cause?.status; if (exitStatus !== 1) throw error; }
	let verifiedHeadIdentity: string;
	try {
		const oid = oneLine(runGit(canonicalRoot, ["rev-parse", "--verify", "HEAD^{commit}"], "GIT_ERROR", maxGit, deadline), "HEAD");
		verifiedHeadIdentity = verifiedSymbolic ? `symbolic:${verifiedSymbolic}:${oid}` : `detached:${oid}`;
	} catch (error) {
		if (!verifiedSymbolic) throw error;
		verifiedHeadIdentity = `unborn:${verifiedSymbolic}`;
	}
	const verifiedStatus = runGit(canonicalRoot, ["ls-files", "--others", "--exclude-standard", "-z"], "GIT_ERROR", maxGit, deadline);
	const verifiedIndexOutput = runGit(canonicalRoot, ["ls-files", "--stage", "-z"], "GIT_ERROR", maxGit, deadline);
	const verifiedIndexFlagsOutput = runGit(canonicalRoot, ["ls-files", "-v", "-z"], "GIT_ERROR", maxGit, deadline);
	const verifiedIndexTree = semanticIndexIdentity(verifiedIndexOutput, verifiedIndexFlagsOutput);
	const verifiedIndex = fingerprintIndex(paths, verifiedIndexOutput, maxFiles * 3);
	const verifiedFiles: GitWorktreeFileSnapshot[] = []; let verifiedConsumed = 0;
	for (const path of paths) { const gitlink = gitlinks.get(path.toString("base64")); if (gitlink) { verifySubmodule(canonicalRoot, path, gitlink, maxGit, deadline); verifiedFiles.push({ path: path.toString("base64"), kind: "directory" }); continue; } const result = fingerprint(rootBytes, path, maxBytes - verifiedConsumed); verifiedConsumed += result.consumed; verifiedFiles.push(result.snapshot); }
	const equalFiles = files.length === verifiedFiles.length && files.every((entry, i) => {
		const verified = verifiedFiles[i]!;
		return entry.path === verified.path && entry.kind === verified.kind && entry.mode === verified.mode && entry.size === verified.size && entry.fingerprint === verified.fingerprint;
	});
	const equalIndex = index.length === verifiedIndex.length && index.every((entry, i) => {
		const verified = verifiedIndex[i]!;
		return entry.path === verified.path && entry.fingerprint === verified.fingerprint && entry.entries.length === verified.entries.length && entry.entries.every((value, j) => value === verified.entries[j]);
	});
	if (verifiedHeadIdentity !== headIdentity || verifiedIndexTree !== indexTree || !verifiedStatus.equals(status) || !equalFiles || !equalIndex) throw new GitWorktreeSnapshotError("RACE_DETECTED", "Git HEAD, index, status, or relevant content changed during snapshot capture");
	return { version: 1, repositoryRoot: rootBytes.toString("base64"), repositoryIdentity, headIdentity, indexTree, status: status.toString("base64"), files, index };
}
function dataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
	if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return undefined;
	const descriptors = Object.getOwnPropertyDescriptors(value); const actual = Object.keys(descriptors).sort();
	if (actual.length !== keys.length || !keys.every((key, i) => actual[i] === key)) return undefined;
	for (const descriptor of Object.values(descriptors)) if (!("value" in descriptor) || descriptor.get || descriptor.set) return undefined;
	return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}
function dataArray(value: unknown): readonly unknown[] | undefined {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
	if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return undefined;
	const descriptors = Object.getOwnPropertyDescriptors(value as object) as Record<string, PropertyDescriptor>; const lengthDescriptor = descriptors["length"]; const rawLength = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
	if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 0 || Object.keys(descriptors).length !== rawLength + 1) return undefined; const length = rawLength;
	const result: unknown[] = []; for (let i = 0; i < length; i++) { const d = descriptors[String(i)]; if (!d || !("value" in d) || d.get || d.set) return undefined; result.push(d.value); }
	return result;
}
function canonicalBase64(value: unknown, maxBytes = DEFAULT_MAX_GIT_OUTPUT_BYTES): Buffer | undefined { if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4) return undefined; const decoded = Buffer.from(value, "base64"); return decoded.length <= maxBytes && decoded.toString("base64") === value ? decoded : undefined; }
function safeRelativePath(value: unknown): string | undefined { const bytes = canonicalBase64(value, 1024 * 1024); if (!bytes) return undefined; try { absolutePath(Buffer.from("/root"), bytes); } catch { return undefined; } return value as string; }
function canonicalSnapshot(value: unknown): GitWorktreeSnapshot | undefined {
	const top = dataRecord(value, ["files", "headIdentity", "index", "indexTree", "repositoryIdentity", "repositoryRoot", "status", "version"]); if (!top || top.version !== 1) return undefined;
	const root = canonicalBase64(top.repositoryRoot, 1024 * 1024), status = canonicalBase64(top.status); if (!root || !status || !root.length || root.includes(0) || !Buffer.from(root.toString("utf8")).equals(root) || !isPlatformAbsolutePath(root.toString("utf8"))) return undefined;
	const identity = dataRecord(top.repositoryIdentity, ["commonDir", "commonDirFileId", "gitDir", "gitDirFileId", "rootFileId"]); if (!identity) return undefined;
	if (![identity.gitDir, identity.commonDir].every((x) => typeof x === "string" && x.length <= 1024 * 1024 && isPlatformAbsolutePath(x) && !x.includes("\0")) || ![identity.rootFileId, identity.gitDirFileId, identity.commonDirFileId].every((x) => typeof x === "string" && x.length <= 64 && /^\d+:\d+$/.test(x))) return undefined;
	if (typeof top.headIdentity !== "string" || top.headIdentity.length > 1024 || !/^(?:(?:symbolic:[^:\0]+|detached):[0-9a-f]{40,64}|unborn:[^:\0]+)$/.test(top.headIdentity) || typeof top.indexTree !== "string" || !/^[0-9a-f]{40,64}$/.test(top.indexTree)) return undefined;
	const rawFiles = dataArray(top.files), rawIndex = dataArray(top.index); if (!rawFiles || !rawIndex || rawFiles.length > DEFAULT_MAX_FILES || rawIndex.length !== rawFiles.length) return undefined;
	const files: GitWorktreeFileSnapshot[] = [], index: GitIndexPathSnapshot[] = []; let previous = "", bytes = 0;
	for (let i = 0; i < rawFiles.length; i++) {
		const f0 = rawFiles[i]; if (!f0 || typeof f0 !== "object") return undefined; const names = Object.keys(Object.getOwnPropertyDescriptors(f0)); const f = dataRecord(f0, names.sort()); if (!f || !names.every((k) => ["fingerprint", "kind", "mode", "path", "size"].includes(k))) return undefined;
		const path = safeRelativePath(f.path); if (!path || (previous && previous.localeCompare(path) >= 0)) return undefined; previous = path;
		if (!(["missing", "file", "symlink", "directory"] as unknown[]).includes(f.kind)) return undefined;
		if (f.kind === "missing" || f.kind === "directory") { if (names.length !== 2 || !names.includes("kind") || !names.includes("path")) return undefined; files.push({ path, kind: f.kind }); }
		else { if (names.length !== 5 || typeof f.mode !== "number" || !Number.isSafeInteger(f.mode) || f.mode < 0 || f.mode > 0o7777 || typeof f.size !== "number" || !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(f.fingerprint)) return undefined; bytes += f.size; if (bytes > DEFAULT_MAX_BYTES) return undefined; files.push({ path, kind: f.kind as "file" | "symlink", mode: f.mode, size: f.size, fingerprint: f.fingerprint }); }
		const x = dataRecord(rawIndex[i], ["entries", "fingerprint", "path"]); const entries0 = x && dataArray(x.entries); if (!x || x.path !== path || typeof x.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(x.fingerprint) || !entries0 || entries0.length > 3) return undefined;
		const entries: string[] = []; let prior = ""; for (const entry of entries0) { const decoded = canonicalBase64(entry); if (!decoded || !/^[0-7]{6} [0-9a-f]{40,64} [0-3]$/.test(decoded.toString("ascii")) || (prior && (entry as string) <= prior)) return undefined; prior = entry as string; entries.push(entry as string); }
		const isGitlink = entries.length === 1 && Buffer.from(entries[0]!, "base64").toString("ascii").startsWith("160000 ");
		if (isGitlink && f.kind !== "directory") return undefined;
		const hash = createHash("sha256").update(Buffer.from(path, "base64")).update(Buffer.from([0])); if (!entries.length) hash.update("absent"); else entries.forEach((e) => hash.update(Buffer.from(e, "base64")).update(Buffer.from([0]))); if (hash.digest("hex") !== x.fingerprint) return undefined;
		index.push({ path, entries, fingerprint: x.fingerprint });
	}
	let statusPaths: Buffer[]; try { statusPaths = parseUntrackedPaths(status); } catch { return undefined; } const filePaths = new Set(files.map((file) => file.path)); if (statusPaths.some((p) => !filePaths.has(p.toString("base64")))) return undefined;
	return { version: 1, repositoryRoot: root.toString("base64"), repositoryIdentity: { rootFileId: identity.rootFileId as string, gitDir: identity.gitDir as string, commonDir: identity.commonDir as string, gitDirFileId: identity.gitDirFileId as string, commonDirFileId: identity.commonDirFileId as string }, headIdentity: top.headIdentity, indexTree: top.indexTree, status: status.toString("base64"), files, index };
}
export function compareGitWorktreeSnapshots(before: GitWorktreeSnapshot, after: GitWorktreeSnapshot): { changed: boolean } {
	const a = canonicalSnapshot(before), b = canonicalSnapshot(after); if (!a || !b) throw new GitWorktreeSnapshotError("INVALID_SNAPSHOT", "Invalid Git working-tree snapshot");
	if (a.repositoryRoot !== b.repositoryRoot || a.repositoryIdentity.rootFileId !== b.repositoryIdentity.rootFileId || a.repositoryIdentity.gitDir !== b.repositoryIdentity.gitDir || a.repositoryIdentity.commonDir !== b.repositoryIdentity.commonDir || a.repositoryIdentity.gitDirFileId !== b.repositoryIdentity.gitDirFileId || a.repositoryIdentity.commonDirFileId !== b.repositoryIdentity.commonDirFileId) throw new GitWorktreeSnapshotError("INVALID_SNAPSHOT", "Cannot compare snapshots from different repositories");
	const equalFiles = a.files.length === b.files.length && a.files.every((x, i) => { const y = b.files[i]!; return x.path === y.path && x.kind === y.kind && x.mode === y.mode && x.size === y.size && x.fingerprint === y.fingerprint; });
	const equalIndex = a.index.length === b.index.length && a.index.every((x, i) => { const y = b.index[i]!; return x.path === y.path && x.fingerprint === y.fingerprint && x.entries.length === y.entries.length && x.entries.every((e, j) => e === y.entries[j]); });
	return { changed: a.headIdentity !== b.headIdentity || a.indexTree !== b.indexTree || a.status !== b.status || !equalFiles || !equalIndex };
}
