import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";

export type GitWorktreeSnapshotErrorCode =
	| "NOT_GIT_REPOSITORY" | "GIT_NOT_FOUND" | "INVALID_CWD" | "PERMISSION_DENIED"
	| "GIT_ERROR" | "LIMIT_EXCEEDED" | "INVALID_STATUS" | "INVALID_INDEX"
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
export interface CaptureGitWorktreeSnapshotOptions { readonly maxFiles?: number; readonly maxBytes?: number; readonly maxGitOutputBytes?: number; }
const DEFAULT_MAX_FILES = 10_000, DEFAULT_MAX_BYTES = 64 * 1024 * 1024, DEFAULT_MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
function positiveLimit(value: number | undefined, fallback: number, name: string): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 0) throw new GitWorktreeSnapshotError("INVALID_SNAPSHOT", `${name} must be a non-negative safe integer`);
	return result;
}
function classifyExecError(cause: any, fallback: GitWorktreeSnapshotErrorCode): GitWorktreeSnapshotErrorCode {
	if (cause?.code === "ENOENT") return "GIT_NOT_FOUND";
	if (cause?.code === "ENOTDIR") return "INVALID_CWD";
	if (cause?.code === "EACCES" || cause?.code === "EPERM") return "PERMISSION_DENIED";
	if (cause?.code === "ENOBUFS" || /maxBuffer/i.test(String(cause?.message))) return "LIMIT_EXCEEDED";
	return fallback;
}
function runGit(cwd: string, args: string[], fallback: GitWorktreeSnapshotErrorCode, maxBuffer: number, input?: Buffer): Buffer {
	try { return execFileSync("git", args, { cwd, input, encoding: "buffer", stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], maxBuffer }); }
	catch (cause: any) {
		let code = classifyExecError(cause, fallback);
		if (fallback === "NOT_GIT_REPOSITORY" && code === fallback) {
			const stderr = Buffer.isBuffer(cause?.stderr) ? cause.stderr.toString() : String(cause?.stderr ?? "");
			if (!/not a git repository/i.test(stderr)) code = "GIT_ERROR";
		}
		throw new GitWorktreeSnapshotError(code, code === "NOT_GIT_REPOSITORY" ? `Not a Git repository: ${cwd}` : `Git command failed: git ${args.join(" ")}`, { cause });
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
function parseStatusPaths(output: Buffer): Buffer[] {
	const records = splitNul(output); const paths: Buffer[] = [];
	for (let i = 0; i < records.length; i++) {
		const record = records[i]!;
		if (record.length < 4 || record[2] !== 0x20) throw new GitWorktreeSnapshotError("INVALID_STATUS", "Malformed Git porcelain status record");
		paths.push(Buffer.from(record.subarray(3)));
		if ([record[0], record[1]].some((v) => v === 0x52 || v === 0x43)) { const source = records[++i]; if (!source) throw new GitWorktreeSnapshotError("INVALID_STATUS", "Rename/copy omitted source"); paths.push(Buffer.from(source)); }
	}
	const unique = new Map<string, Buffer>(); for (const path of paths) unique.set(path.toString("base64"), path);
	return [...unique].sort(([a], [b]) => a.localeCompare(b)).map(([, p]) => p);
}
function fingerprintIndex(paths: readonly Buffer[], output: Buffer, maxRecords: number): GitIndexPathSnapshot[] {
	const wanted = new Map(paths.map((p) => [p.toString("base64"), [] as Buffer[]])); let count = 0;
	for (const record of splitNul(output, "INVALID_INDEX")) {
		const tab = record.indexOf(9); if (tab < 0) throw new GitWorktreeSnapshotError("INVALID_INDEX", "Malformed Git index record");
		const metadata = record.subarray(0, tab); const text = metadata.toString("ascii");
		if (!/^[0-7]{6} [0-9a-f]+ [0-3]$/.test(text)) throw new GitWorktreeSnapshotError("INVALID_INDEX", "Malformed Git index metadata");
		const entries = wanted.get(record.subarray(tab + 1).toString("base64")); if (!entries) continue;
		if (++count > maxRecords) throw new GitWorktreeSnapshotError("FILE_LIMIT_EXCEEDED", "Git index snapshot record limit exceeded");
		if (text.startsWith("160000 ")) throw new GitWorktreeSnapshotError("UNSUPPORTED_SUBMODULE", "Dirty submodule state is not safely comparable");
		entries.push(Buffer.from(metadata));
	}
	return paths.map((path) => { const entries = wanted.get(path.toString("base64"))!; entries.sort(Buffer.compare); const hash = createHash("sha256").update(path).update(Buffer.from([0])); if (!entries.length) hash.update("absent"); else entries.forEach((e) => hash.update(e).update(Buffer.from([0]))); return { path: path.toString("base64"), entries: entries.map((e) => e.toString("base64")), fingerprint: hash.digest("hex") }; });
}
function absolutePath(root: Buffer, relative: Buffer): Buffer {
	if (!relative.length || relative[0] === 0x2f || relative.toString("latin1").split("/").some((p) => !p || p === "." || p === "..")) throw new GitWorktreeSnapshotError("UNSAFE_PATH", "Git reported an unsafe path");
	return Buffer.concat([root, Buffer.from("/"), relative]);
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
	const full = absolutePath(root, path); let stat;
	try { stat = lstatSync(full); } catch (cause: any) { if (cause?.code === "ENOENT") return { snapshot: { path: path.toString("base64"), kind: "missing" }, consumed: 0 }; throw new GitWorktreeSnapshotError("IO_ERROR", "Unable to inspect working-tree path", { cause }); }
	const mode = stat.mode & 0o7777;
	if (stat.isSymbolicLink()) { try { const target = readlinkSync(full, { encoding: "buffer" }); const after = lstatSync(full); if (!after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.mode !== stat.mode) throw new GitWorktreeSnapshotError("RACE_DETECTED", "Symlink changed while being fingerprinted"); if (target.length > remaining) throw new GitWorktreeSnapshotError("BYTE_LIMIT_EXCEEDED", "Working-tree snapshot byte limit exceeded"); return { snapshot: { path: path.toString("base64"), kind: "symlink", mode, size: target.length, fingerprint: createHash("sha256").update(target).digest("hex") }, consumed: target.length }; } catch (cause) { if (cause instanceof GitWorktreeSnapshotError) throw cause; throw new GitWorktreeSnapshotError("RACE_DETECTED", "Symlink changed while reading", { cause }); } }
	if (stat.isFile()) { const h = hashFile(full, stat, remaining); return { snapshot: { path: path.toString("base64"), kind: "file", mode, size: h.size, fingerprint: h.fingerprint }, consumed: h.consumed }; }
	throw new GitWorktreeSnapshotError("UNSAFE_PATH", "Refusing to snapshot a special file or directory");
}
function resolveRepositoryIdentity(cwd: string, maxGit: number): { canonicalRoot: string; repositoryIdentity: GitWorktreeSnapshot["repositoryIdentity"] } {
	try {
		const canonicalRoot = realpathSync(oneLine(runGit(cwd, ["rev-parse", "--show-toplevel"], "NOT_GIT_REPOSITORY", maxGit), "repository root"));
		const rootLstat = lstatSync(canonicalRoot), rootStat = statSync(canonicalRoot);
		if (!rootLstat.isDirectory() || !rootStat.isDirectory() || rootLstat.dev !== rootStat.dev || rootLstat.ino !== rootStat.ino) throw new GitWorktreeSnapshotError("RACE_DETECTED", "Git working-tree root changed while resolving repository identity");
		const gitDir = realpathSync(oneLine(runGit(canonicalRoot, ["rev-parse", "--absolute-git-dir"], "GIT_ERROR", maxGit), "git dir"));
		const commonRaw = oneLine(runGit(canonicalRoot, ["rev-parse", "--git-common-dir"], "GIT_ERROR", maxGit), "git common dir");
		const commonDir = realpathSync(commonRaw.startsWith("/") ? commonRaw : `${canonicalRoot}/${commonRaw}`);
		const gitStat = statSync(gitDir), commonStat = statSync(commonDir);
		return { canonicalRoot, repositoryIdentity: { rootFileId: `${rootStat.dev}:${rootStat.ino}`, gitDir, commonDir, gitDirFileId: `${gitStat.dev}:${gitStat.ino}`, commonDirFileId: `${commonStat.dev}:${commonStat.ino}` } };
	} catch (cause) { if (cause instanceof GitWorktreeSnapshotError) throw cause; throw new GitWorktreeSnapshotError("IO_ERROR", "Unable to resolve Git repository identity", { cause }); }
}
export function captureGitWorktreeSnapshot(cwd: string, options: CaptureGitWorktreeSnapshotOptions = {}): GitWorktreeSnapshot {
	const maxFiles = positiveLimit(options.maxFiles, DEFAULT_MAX_FILES, "maxFiles"), maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes"), maxGit = positiveLimit(options.maxGitOutputBytes, DEFAULT_MAX_GIT_OUTPUT_BYTES, "maxGitOutputBytes");
	const { canonicalRoot, repositoryIdentity } = resolveRepositoryIdentity(cwd, maxGit);
	let symbolic = "";
	try { symbolic = oneLine(runGit(canonicalRoot, ["symbolic-ref", "-q", "HEAD"], "GIT_ERROR", maxGit), "symbolic HEAD"); }
	catch (error: any) { const status = error?.cause?.status; if (status !== 1) throw error; }
	let headIdentity: string;
	try {
		const oid = oneLine(runGit(canonicalRoot, ["rev-parse", "--verify", "HEAD^{commit}"], "GIT_ERROR", maxGit), "HEAD");
		headIdentity = symbolic ? `symbolic:${symbolic}:${oid}` : `detached:${oid}`;
	} catch (error) {
		if (!symbolic) throw error;
		headIdentity = `unborn:${symbolic}`;
	}
	let indexTree: string; try { indexTree = oneLine(runGit(canonicalRoot, ["write-tree"], "INVALID_INDEX", maxGit), "index tree"); } catch (error) { if (error instanceof GitWorktreeSnapshotError && error.code === "INVALID_INDEX") throw error; throw error; }
	const status = runGit(canonicalRoot, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], "GIT_ERROR", maxGit);
	const paths = parseStatusPaths(status); if (paths.length > maxFiles) throw new GitWorktreeSnapshotError("FILE_LIMIT_EXCEEDED", `Working-tree snapshot file limit exceeded (${paths.length} > ${maxFiles})`);
	const indexParts: Buffer[] = []; let indexBytes = 0;
	// This Git lacks ls-files --pathspec-from-file. Query each already-bounded status path
	// separately: no aggregate argv/ARG_MAX exposure, and `--` prevents option injection.
	for (const path of paths) {
		const text = path.toString("utf8");
		if (!Buffer.from(text).equals(path)) throw new GitWorktreeSnapshotError("UNSAFE_PATH", "Git path is not valid UTF-8 on this platform");
		const part = runGit(canonicalRoot, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", text], "GIT_ERROR", maxGit);
		indexBytes += part.length;
		if (indexBytes > maxGit) throw new GitWorktreeSnapshotError("LIMIT_EXCEEDED", "Git index query output limit exceeded");
		indexParts.push(part);
	}
	const indexOutput = Buffer.concat(indexParts, indexBytes);
	const index = fingerprintIndex(paths, indexOutput, maxFiles * 3); const files: GitWorktreeFileSnapshot[] = []; let consumed = 0; const rootBytes = Buffer.from(canonicalRoot);
	for (const path of paths) { const result = fingerprint(rootBytes, path, maxBytes - consumed); consumed += result.consumed; files.push(result.snapshot); }
	const finalIdentity = resolveRepositoryIdentity(canonicalRoot, maxGit);
	if (finalIdentity.canonicalRoot !== canonicalRoot || finalIdentity.repositoryIdentity.rootFileId !== repositoryIdentity.rootFileId || finalIdentity.repositoryIdentity.gitDir !== repositoryIdentity.gitDir || finalIdentity.repositoryIdentity.commonDir !== repositoryIdentity.commonDir || finalIdentity.repositoryIdentity.gitDirFileId !== repositoryIdentity.gitDirFileId || finalIdentity.repositoryIdentity.commonDirFileId !== repositoryIdentity.commonDirFileId) throw new GitWorktreeSnapshotError("RACE_DETECTED", "Git repository identity changed during snapshot capture");
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
	const root = canonicalBase64(top.repositoryRoot, 1024 * 1024), status = canonicalBase64(top.status); if (!root || !status || !root.length || root[0] !== 0x2f || root.includes(0) || !Buffer.from(root.toString("utf8")).equals(root)) return undefined;
	const identity = dataRecord(top.repositoryIdentity, ["commonDir", "commonDirFileId", "gitDir", "gitDirFileId", "rootFileId"]); if (!identity) return undefined;
	if (![identity.gitDir, identity.commonDir].every((x) => typeof x === "string" && x.length <= 1024 * 1024 && x.startsWith("/") && !x.includes("\0")) || ![identity.rootFileId, identity.gitDirFileId, identity.commonDirFileId].every((x) => typeof x === "string" && x.length <= 64 && /^\d+:\d+$/.test(x))) return undefined;
	if (typeof top.headIdentity !== "string" || top.headIdentity.length > 1024 || !/^(?:(?:symbolic:[^:\0]+|detached):[0-9a-f]{40,64}|unborn:[^:\0]+)$/.test(top.headIdentity) || typeof top.indexTree !== "string" || !/^[0-9a-f]{40,64}$/.test(top.indexTree)) return undefined;
	const rawFiles = dataArray(top.files), rawIndex = dataArray(top.index); if (!rawFiles || !rawIndex || rawFiles.length > DEFAULT_MAX_FILES || rawIndex.length !== rawFiles.length) return undefined;
	const files: GitWorktreeFileSnapshot[] = [], index: GitIndexPathSnapshot[] = []; let previous = "", bytes = 0;
	for (let i = 0; i < rawFiles.length; i++) {
		const f0 = rawFiles[i]; if (!f0 || typeof f0 !== "object") return undefined; const names = Object.keys(Object.getOwnPropertyDescriptors(f0)); const f = dataRecord(f0, names.sort()); if (!f || !names.every((k) => ["fingerprint", "kind", "mode", "path", "size"].includes(k))) return undefined;
		const path = safeRelativePath(f.path); if (!path || (previous && previous.localeCompare(path) >= 0)) return undefined; previous = path;
		if (!(["missing", "file", "symlink"] as unknown[]).includes(f.kind)) return undefined;
		if (f.kind === "missing") { if (names.length !== 2 || !names.includes("kind") || !names.includes("path")) return undefined; files.push({ path, kind: "missing" }); }
		else { if (names.length !== 5 || typeof f.mode !== "number" || !Number.isSafeInteger(f.mode) || f.mode < 0 || f.mode > 0o7777 || typeof f.size !== "number" || !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(f.fingerprint)) return undefined; bytes += f.size; if (bytes > DEFAULT_MAX_BYTES) return undefined; files.push({ path, kind: f.kind as "file" | "symlink", mode: f.mode, size: f.size, fingerprint: f.fingerprint }); }
		const x = dataRecord(rawIndex[i], ["entries", "fingerprint", "path"]); const entries0 = x && dataArray(x.entries); if (!x || x.path !== path || typeof x.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(x.fingerprint) || !entries0 || entries0.length > 3) return undefined;
		const entries: string[] = []; let prior = ""; for (const entry of entries0) { const decoded = canonicalBase64(entry); if (!decoded || !/^[0-7]{6} [0-9a-f]{40,64} [0-3]$/.test(decoded.toString("ascii")) || (prior && (entry as string) <= prior)) return undefined; prior = entry as string; entries.push(entry as string); }
		const hash = createHash("sha256").update(Buffer.from(path, "base64")).update(Buffer.from([0])); if (!entries.length) hash.update("absent"); else entries.forEach((e) => hash.update(Buffer.from(e, "base64")).update(Buffer.from([0]))); if (hash.digest("hex") !== x.fingerprint) return undefined;
		index.push({ path, entries, fingerprint: x.fingerprint });
	}
	let statusPaths: Buffer[]; try { statusPaths = parseStatusPaths(status); } catch { return undefined; } if (statusPaths.length !== files.length || statusPaths.some((p, i) => p.toString("base64") !== files[i]!.path)) return undefined;
	return { version: 1, repositoryRoot: root.toString("base64"), repositoryIdentity: { rootFileId: identity.rootFileId as string, gitDir: identity.gitDir as string, commonDir: identity.commonDir as string, gitDirFileId: identity.gitDirFileId as string, commonDirFileId: identity.commonDirFileId as string }, headIdentity: top.headIdentity, indexTree: top.indexTree, status: status.toString("base64"), files, index };
}
export function compareGitWorktreeSnapshots(before: GitWorktreeSnapshot, after: GitWorktreeSnapshot): { changed: boolean } {
	const a = canonicalSnapshot(before), b = canonicalSnapshot(after); if (!a || !b) throw new GitWorktreeSnapshotError("INVALID_SNAPSHOT", "Invalid Git working-tree snapshot");
	if (a.repositoryRoot !== b.repositoryRoot || a.repositoryIdentity.rootFileId !== b.repositoryIdentity.rootFileId || a.repositoryIdentity.gitDir !== b.repositoryIdentity.gitDir || a.repositoryIdentity.commonDir !== b.repositoryIdentity.commonDir || a.repositoryIdentity.gitDirFileId !== b.repositoryIdentity.gitDirFileId || a.repositoryIdentity.commonDirFileId !== b.repositoryIdentity.commonDirFileId) throw new GitWorktreeSnapshotError("INVALID_SNAPSHOT", "Cannot compare snapshots from different repositories");
	const equalFiles = a.files.length === b.files.length && a.files.every((x, i) => { const y = b.files[i]!; return x.path === y.path && x.kind === y.kind && x.mode === y.mode && x.size === y.size && x.fingerprint === y.fingerprint; });
	const equalIndex = a.index.length === b.index.length && a.index.every((x, i) => { const y = b.index[i]!; return x.path === y.path && x.fingerprint === y.fingerprint && x.entries.length === y.entries.length && x.entries.every((e, j) => e === y.entries[j]); });
	return { changed: a.headIdentity !== b.headIdentity || a.indexTree !== b.indexTree || a.status !== b.status || !equalFiles || !equalIndex };
}
