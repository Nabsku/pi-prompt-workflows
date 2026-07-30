import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	GitWorktreeSnapshotError,
	captureGitWorktreeSnapshot,
	compareGitWorktreeSnapshots,
	isPlatformAbsolutePath,
} from "../git-worktree-snapshot.ts";

function repo(): string {
	const cwd = mkdtempSync(join(tmpdir(), "git-snapshot-"));
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd });
	writeFileSync(join(cwd, "tracked.txt"), "base\n");
	writeFileSync(join(cwd, "delete.txt"), "delete\n");
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["commit", "-qm", "initial"], { cwd });
	return cwd;
}
function changed(cwd: string, action: () => void): boolean {
	const before = captureGitWorktreeSnapshot(cwd);
	action();
	return compareGitWorktreeSnapshots(before, captureGitWorktreeSnapshot(cwd)).changed;
}
function snapshotProbe(cwd: string, bin: string, deadlineMs?: number): { ok: boolean; code?: string; message?: string; cleanupStatus?: string } {
	const moduleUrl = new URL("../git-worktree-snapshot.ts", import.meta.url).href;
	const source = `import { captureGitWorktreeSnapshot } from ${JSON.stringify(moduleUrl)};\ntry { captureGitWorktreeSnapshot(${JSON.stringify(cwd)}, ${JSON.stringify(deadlineMs === undefined ? {} : { deadlineMs })}); console.log(JSON.stringify({ ok: true })); } catch (error) { console.log(JSON.stringify({ ok: false, code: error?.code, message: error?.message, cleanupStatus: error?.cause?.cleanupStatus })); }`;
	return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
	}).trim());
}

test("clean to unchanged, tracked edit, and untracked creation", () => {
	const cwd = repo();
	assert.equal(changed(cwd, () => {}), false);
	assert.equal(changed(cwd, () => writeFileSync(join(cwd, "tracked.txt"), "edited\n")), true);
	const clean = repo();
	assert.equal(changed(clean, () => writeFileSync(join(clean, "new file.txt"), "new\n")), true);
});

test("pre-existing dirty state counts only when its content changes", () => {
	const cwd = repo();
	writeFileSync(join(cwd, "tracked.txt"), "dirty\n");
	writeFileSync(join(cwd, "scratch file.txt"), "scratch\n");
	assert.equal(changed(cwd, () => {}), false);
	assert.equal(changed(cwd, () => writeFileSync(join(cwd, "tracked.txt"), "dirtier\n")), true);
	assert.equal(changed(cwd, () => writeFileSync(join(cwd, "scratch file.txt"), "changed\n")), true);
});

test("detects clean to staged edit and an index-only replacement in pre-dirty MM state", () => {
	const clean = repo();
	assert.equal(changed(clean, () => { writeFileSync(join(clean, "tracked.txt"), "staged\n"); execFileSync("git", ["add", "tracked.txt"], { cwd: clean }); }), true);

	const cwd = repo();
	writeFileSync(join(cwd, "tracked.txt"), "first staged\n");
	execFileSync("git", ["add", "tracked.txt"], { cwd });
	writeFileSync(join(cwd, "tracked.txt"), "unchanged worktree\n");
	const before = captureGitWorktreeSnapshot(cwd);
	writeFileSync(join(cwd, "tracked.txt"), "second staged\n");
	execFileSync("git", ["add", "tracked.txt"], { cwd });
	writeFileSync(join(cwd, "tracked.txt"), "unchanged worktree\n");
	assert.equal(compareGitWorktreeSnapshots(before, captureGitWorktreeSnapshot(cwd)).changed, true);
});

test("snapshots a staged new tree with read-only object storage without creating objects", () => {
	const cwd = repo();
	writeFileSync(join(cwd, "new.txt"), "new staged content\n");
	execFileSync("git", ["add", "new.txt"], { cwd });
	const objects = join(cwd, ".git", "objects");
	const before = execFileSync("git", ["count-objects", "-v"], { cwd, encoding: "utf8" });
	execFileSync("chmod", ["-R", "a-w", objects]);
	try {
		const snapshot = captureGitWorktreeSnapshot(cwd);
		assert.match(snapshot.indexTree, /^[0-9a-f]{64}$/);
		assert.equal(execFileSync("git", ["count-objects", "-v"], { cwd, encoding: "utf8" }), before);
	} finally {
		execFileSync("chmod", ["-R", "u+w", objects]);
	}
});

test("fingerprints staged add, delete, and rename index states", () => {
	for (const action of [
		(cwd: string) => { writeFileSync(join(cwd, "new.txt"), "new\n"); execFileSync("git", ["add", "new.txt"], { cwd }); },
		(cwd: string) => execFileSync("git", ["rm", "-q", "delete.txt"], { cwd }),
		(cwd: string) => execFileSync("git", ["mv", "delete.txt", "renamed.txt"], { cwd }),
	]) {
		const cwd = repo();
		assert.equal(changed(cwd, () => action(cwd)), true);
	}
});

test("represents absent entries and every conflict stage deterministically", () => {
	const cwd = repo();
	writeFileSync(join(cwd, "untracked.txt"), "x\n");
	let snapshot = captureGitWorktreeSnapshot(cwd);
	const untracked = snapshot.index.find((entry) => Buffer.from(entry.path, "base64").toString() === "untracked.txt");
	assert.deepEqual(untracked?.entries, []);

	const hashes = ["base\n", "ours\n", "theirs\n"].map((content) => execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd, input: content }).toString().trim());
	execFileSync("git", ["update-index", "--index-info"], { cwd, input: `0 0000000000000000000000000000000000000000\ttracked.txt\n100644 ${hashes[0]} 1\ttracked.txt\n100644 ${hashes[1]} 2\ttracked.txt\n100644 ${hashes[2]} 3\ttracked.txt\n` });
	assert.throws(() => captureGitWorktreeSnapshot(cwd), (error: unknown) => error instanceof GitWorktreeSnapshotError && error.code === "INVALID_INDEX");
});

test("detects add, remove, delete, rename, mode, and paths with spaces", () => {
	for (const action of [
		(cwd: string) => { writeFileSync(join(cwd, "added file.txt"), "add\n"); execFileSync("git", ["add", "added file.txt"], { cwd }); },
		(cwd: string) => rmSync(join(cwd, "delete.txt")),
		(cwd: string) => execFileSync("git", ["mv", "delete.txt", "renamed file.txt"], { cwd }),
		(cwd: string) => { writeFileSync(join(cwd, "gone.txt"), "x"); rmSync(join(cwd, "gone.txt")); },
		(cwd: string) => chmodSync(join(cwd, "tracked.txt"), 0o755),
	]) {
		const cwd = repo();
		const expected = action.toString().includes("gone.txt") ? false : true;
		assert.equal(changed(cwd, () => action(cwd)), expected);
	}
});

test("symlinks fingerprint target text and never follow target contents", () => {
	const cwd = repo();
	const outside = mkdtempSync(join(tmpdir(), "git-snapshot-outside-"));
	writeFileSync(join(outside, "a"), "outside a");
	writeFileSync(join(outside, "b"), "outside b");
	symlinkSync(join(outside, "a"), join(cwd, "link"));
	const before = captureGitWorktreeSnapshot(cwd);
	writeFileSync(join(outside, "a"), "mutated outside");
	assert.equal(compareGitWorktreeSnapshots(before, captureGitWorktreeSnapshot(cwd)).changed, false);
	rmSync(join(cwd, "link")); symlinkSync(join(outside, "b"), join(cwd, "link"));
	assert.equal(readlinkSync(join(cwd, "link")), join(outside, "b"));
	assert.equal(compareGitWorktreeSnapshots(before, captureGitWorktreeSnapshot(cwd)).changed, true);
});

test("mutate then restore is no change at final comparison", () => {
	const cwd = repo();
	const before = captureGitWorktreeSnapshot(cwd);
	writeFileSync(join(cwd, "tracked.txt"), "temporary\n");
	writeFileSync(join(cwd, "tracked.txt"), "base\n");
	assert.equal(compareGitWorktreeSnapshots(before, captureGitWorktreeSnapshot(cwd)).changed, false);
});

test("pure comparison is deterministic and separately testable", () => {
	const base = captureGitWorktreeSnapshot(repo());
	assert.deepEqual(compareGitWorktreeSnapshots(base, structuredClone(base)), { changed: false });
	assert.deepEqual(compareGitWorktreeSnapshots(base, { ...base, headIdentity: base.headIdentity.replace(/[0-9a-f]$/, (x) => x === "0" ? "1" : "0") }), { changed: true });
	assert.throws(() => compareGitWorktreeSnapshots(base, { ...base, repositoryRoot: Buffer.from("/other").toString("base64") }), /different repositories/i);
	assert.throws(() => compareGitWorktreeSnapshots(base, { ...base, repositoryIdentity: { ...base.repositoryIdentity, rootFileId: "0:0" } }), /different repositories/i);
});

test("platform absolute-path validation accepts Windows drive and UNC roots cross-platform", () => {
	assert.equal(isPlatformAbsolutePath("C:\\repo\\worktree", "win32"), true);
	assert.equal(isPlatformAbsolutePath("\\\\server\\share\\repo", "win32"), true);
	assert.equal(isPlatformAbsolutePath("repo\\worktree", "win32"), false);
	assert.equal(isPlatformAbsolutePath("/repo/worktree", "linux"), true);
	assert.equal(isPlatformAbsolutePath("repo/worktree", "linux"), false);
});

test("literal pathspecs isolate magic, colon, option-like, and spaced dirty paths", () => {
	const cwd = repo(); const names = [":(glob)*", ":foo", "-leading", "has spaces"];
	for (const name of names) writeFileSync(join(cwd, name), "base\n");
	execFileSync("git", ["--literal-pathspecs", "add", "--", ...names], { cwd }); execFileSync("git", ["commit", "-qm", "names"], { cwd });
	for (const name of names) writeFileSync(join(cwd, name), `dirty ${name}\n`);
	const snapshot = captureGitWorktreeSnapshot(cwd);
	assert.deepEqual(snapshot.index.map((x) => Buffer.from(x.path, "base64").toString()), [...names, "tracked.txt", "delete.txt"].sort((a, b) => Buffer.from(a).toString("base64").localeCompare(Buffer.from(b).toString("base64"))));
	assert.ok(snapshot.index.every((x) => x.entries.length === 1));
	assert.throws(() => captureGitWorktreeSnapshot(cwd, { maxFiles: 3 }), (error: unknown) => error instanceof GitWorktreeSnapshotError && error.code === "FILE_LIMIT_EXCEEDED");
});

test("snapshot validation rejects accessors, toJSON, unknown keys, and malformed nested data without executing them", () => {
	const base = captureGitWorktreeSnapshot(repo()); let calls = 0;
	const accessor = structuredClone(base) as any; Object.defineProperty(accessor, "status", { enumerable: true, get() { calls++; throw new Error("executed"); } });
	assert.throws(() => compareGitWorktreeSnapshots(accessor, base), (e: unknown) => e instanceof GitWorktreeSnapshotError && e.code === "INVALID_SNAPSHOT");
	const toJSON = structuredClone(base) as any; Object.defineProperty(toJSON, "toJSON", { enumerable: true, value() { calls++; throw new Error("executed"); } });
	assert.throws(() => compareGitWorktreeSnapshots(toJSON, base), (e: unknown) => e instanceof GitWorktreeSnapshotError && e.code === "INVALID_SNAPSHOT");
	const nested = structuredClone(base) as any; Object.defineProperty(nested.repositoryIdentity, "gitDir", { enumerable: true, get() { calls++; throw new Error("executed"); } });
	assert.throws(() => compareGitWorktreeSnapshots(nested, base), (e: unknown) => e instanceof GitWorktreeSnapshotError && e.code === "INVALID_SNAPSHOT");
	for (const malformed of [{ ...base, status: "not base64!" }, { ...base, extra: true }, { ...base, repositoryIdentity: { ...base.repositoryIdentity, rootFileId: "invalid" } }, { ...base, files: Object.assign([], { extra: true }) }]) assert.throws(() => compareGitWorktreeSnapshots(malformed as any, base), (e: unknown) => e instanceof GitWorktreeSnapshotError && e.code === "INVALID_SNAPSHOT");
	assert.equal(calls, 0);
});

test("capture revalidates repository identity after all work", () => {
	const cwd = repo(), bin = mkdtempSync(join(tmpdir(), "git-wrapper-")), count = join(bin, "count"); mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" rev-parse --show-toplevel "*)\n  /usr/bin/git "$@"; rc=$?\n  n=0; [ -f '${count}' ] && n=$(cat '${count}'); n=$((n+1)); printf %s "$n" > '${count}'\n  if [ "$n" = 2 ]; then mv .git .git-before-swap && cp -R .git-before-swap .git; fi\n  exit $rc\n  ;;\nesac\nexec /usr/bin/git "$@"\n`); chmodSync(join(bin, "git"), 0o755);
	const result = snapshotProbe(cwd, bin);
	assert.equal(result.code, "RACE_DETECTED");
});

test("capture rejects a relevant content mutation even when porcelain status is unchanged", () => {
	const cwd = repo(), bin = mkdtempSync(join(tmpdir(), "git-wrapper-")), count = join(bin, "root-count");
	writeFileSync(join(cwd, "tracked.txt"), "dirty before\n");
	writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" rev-parse --show-toplevel "*)\n  /usr/bin/git "$@"; rc=$?\n  n=0; [ -f '${count}' ] && n=$(cat '${count}'); n=$((n+1)); printf %s "$n" > '${count}'\n  [ "$n" = 2 ] && printf 'dirty after\\n' > tracked.txt\n  exit $rc\n  ;;\nesac\nexec /usr/bin/git "$@"\n`);
	chmodSync(join(bin, "git"), 0o755);
	const result = snapshotProbe(cwd, bin);
	assert.equal(result.code, "RACE_DETECTED");
});

test("capture detects replacement of a separate-git-dir working-tree root", () => {
	const parent = mkdtempSync(join(tmpdir(), "git-snapshot-separated-"));
	const cwd = join(parent, "worktree"), gitDir = join(parent, "repository.git");
	mkdirSync(cwd);
	execFileSync("git", ["init", "-q", "--separate-git-dir", gitDir, cwd]);
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd });
	writeFileSync(join(cwd, "tracked.txt"), "base\n");
	execFileSync("git", ["add", "tracked.txt"], { cwd });
	execFileSync("git", ["commit", "-qm", "initial"], { cwd });

	const bin = mkdtempSync(join(tmpdir(), "git-wrapper-")), count = join(bin, "count");
	writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" rev-parse --show-toplevel "*)\n  /usr/bin/git "$@"; rc=$?\n  n=0; [ -f '${count}' ] && n=$(cat '${count}'); n=$((n+1)); printf %s "$n" > '${count}'\n  if [ "$n" = 2 ]; then old="$PWD-before-swap"; mv "$PWD" "$old" && mkdir "$PWD" && cp -R "$old/." "$PWD/"; fi\n  exit $rc\n  ;;\nesac\nexec /usr/bin/git "$@"\n`);
	chmodSync(join(bin, "git"), 0o755);
	const result = snapshotProbe(cwd, bin);
	assert.equal(result.code, "RACE_DETECTED");
});

test("clean HEAD changes and bounded Git output are detected", () => {
	const cwd = repo();
	const before = captureGitWorktreeSnapshot(cwd);
	execFileSync("git", ["commit", "--allow-empty", "-qm", "next"], { cwd });
	assert.equal(compareGitWorktreeSnapshots(before, captureGitWorktreeSnapshot(cwd)).changed, true);
	writeFileSync(join(cwd, "dirty"), "x");
	assert.throws(() => captureGitWorktreeSnapshot(cwd, { maxGitOutputBytes: 1 }), (error: unknown) => error instanceof GitWorktreeSnapshotError && error.code === "LIMIT_EXCEEDED");
});

test("relevant gitlinks fail closed as unsupported submodules", () => {
	const cwd = repo();
	const oid = execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
	execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${oid},submodule`], { cwd });
	assert.throws(() => captureGitWorktreeSnapshot(cwd), (error: unknown) => error instanceof GitWorktreeSnapshotError && error.code === "UNSUPPORTED_SUBMODULE");
});

test("non-git cwd and caps fail visibly with structured errors", () => {
	const nonGit = mkdtempSync(join(tmpdir(), "not-git-"));
	assert.throws(() => captureGitWorktreeSnapshot(nonGit), (error: unknown) => error instanceof GitWorktreeSnapshotError && error.code === "NOT_GIT_REPOSITORY");
	const cwd = repo();
	writeFileSync(join(cwd, "one"), "1"); writeFileSync(join(cwd, "two"), "2");
	assert.throws(() => captureGitWorktreeSnapshot(cwd, { maxFiles: 1 }), (error: unknown) => error instanceof GitWorktreeSnapshotError && error.code === "FILE_LIMIT_EXCEEDED");
	const bytes = repo(); writeFileSync(join(bytes, "large"), "12345");
	assert.throws(() => captureGitWorktreeSnapshot(bytes, { maxBytes: 4 }), (error: unknown) => error instanceof GitWorktreeSnapshotError && error.code === "BYTE_LIMIT_EXCEEDED");
});

test("capture suppresses configured fsmonitor and external helpers", () => {
	const cwd = repo(), marker = join(cwd, "helper-marker"), helper = join(cwd, "hostile-helper.sh");
	writeFileSync(helper, `#!/bin/sh\nprintf invoked >> '${marker}'\nsleep 5\n`); chmodSync(helper, 0o755);
	execFileSync("git", ["config", "core.fsmonitor", helper], { cwd });
	execFileSync("git", ["config", "diff.external", helper], { cwd });
	execFileSync("git", ["config", "core.pager", helper], { cwd });
	captureGitWorktreeSnapshot(cwd);
	assert.equal(existsSync(marker), false);
});

test("capture enforces one aggregate deadline and returns a structured timeout without leaving the fake git alive", () => {
	const cwd = repo(), bin = mkdtempSync(join(tmpdir(), "git-timeout-")), pidFile = join(bin, "pid");
	writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf %s $$ > '${pidFile}'\nexec sleep 5\n`); chmodSync(join(bin, "git"), 0o755);
	const started = performance.now();
	const result = snapshotProbe(cwd, bin, 500);
	assert.ok(["GIT_TIMEOUT", "SNAPSHOT_TIMEOUT"].includes(result.code ?? ""));
	assert.ok(performance.now() - started < 1700);
	const pid = Number(readFileSync(pidFile, "utf8"));
	assert.throws(() => process.kill(pid, 0));
});

test("tracked assume-unchanged and skip-worktree edits remain observable", () => {
	for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
		const cwd = repo();
		execFileSync("git", ["update-index", flag, "tracked.txt"], { cwd });
		const before = captureGitWorktreeSnapshot(cwd);
		writeFileSync(join(cwd, "tracked.txt"), `${flag} edit\n`);
		assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }), "");
		assert.equal(compareGitWorktreeSnapshots(before, captureGitWorktreeSnapshot(cwd)).changed, true);
	}
});

test("capture maxBytes public cap self-validates at the boundary", () => {
	const cwd = repo();
	const boundary = 64 * 1024 * 1024;
	const snapshot = captureGitWorktreeSnapshot(cwd, { maxBytes: boundary });
	assert.deepEqual(compareGitWorktreeSnapshots(snapshot, snapshot), { changed: false });
	assert.throws(() => captureGitWorktreeSnapshot(cwd, { maxBytes: boundary + 1 }), (error: unknown) => error instanceof GitWorktreeSnapshotError && error.code === "INVALID_SNAPSHOT" && /cannot exceed/.test(error.message));
});
