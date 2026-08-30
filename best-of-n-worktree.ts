import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { sanitizedGitEnvironment } from "./git-environment.js";

const GIT_COMMAND_TIMEOUT_MS = 120_000;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
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
}

export interface BestOfNWorktreeManager {
	create(sourceCwd: string, label: string): IsolatedBestOfNWorktree;
	cleanup(): void;
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

function cleanRepository(sourceCwd: string): void {
	const trackedChanges = runGit(sourceCwd, ["diff-index", "--name-only", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
	const untrackedChanges = runGit(sourceCwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (trackedChanges.length > 0 || untrackedChanges.length > 0) {
		throw new BestOfNWorktreeError(
			`Best-of-N worker isolation requires a clean Git worktree at \`${sourceCwd}\`. Commit or stash changes before retrying.`,
		);
	}
}

function safeDirectoryName(label: string): string {
	const normalized = label.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
	return normalized || "slot";
}

export function createBestOfNWorktreeManager(): BestOfNWorktreeManager {
	const runRoot = mkdtempSync(join(tmpdir(), "pi-prompt-best-of-n-worktrees-"));
	const created: IsolatedBestOfNWorktree[] = [];
	let cleaned = false;

	return {
		create(sourceCwd, label) {
			if (cleaned) throw new BestOfNWorktreeError("Best-of-N worker worktree manager was already cleaned up.");
			const canonicalSourceCwd = canonicalPath(sourceCwd, "worker cwd");
			cleanRepository(canonicalSourceCwd);
			const repositoryRoot = canonicalPath(runGit(canonicalSourceCwd, ["rev-parse", "--show-toplevel"]).trim(), "Git repository root");
			const sourceRelativeCwd = relative(repositoryRoot, canonicalSourceCwd);
			if (!isWithin(repositoryRoot, canonicalSourceCwd)) {
				throw new BestOfNWorktreeError(`Worker cwd \`${canonicalSourceCwd}\` is outside its Git repository root.`);
			}
			const head = runGit(canonicalSourceCwd, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
			if (!head) throw new BestOfNWorktreeError(`Git repository at \`${canonicalSourceCwd}\` has no commit to isolate.`);

			const target = join(runRoot, `${created.length + 1}-${safeDirectoryName(label)}`);
			try {
				runGit(canonicalSourceCwd, ["worktree", "add", "--detach", target, head]);
				const root = canonicalPath(target, "created worker worktree");
				const cwd = canonicalPath(join(root, sourceRelativeCwd), "created worker cwd");
				const workspace = { root, cwd, sourceCwd: canonicalSourceCwd };
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

		cleanup() {
			if (cleaned) return;
			cleaned = true;
			const errors: unknown[] = [];
			for (const workspace of [...created].reverse()) {
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
			try {
				rmSync(runRoot, { recursive: true, force: true });
			} catch (error) {
				errors.push(error);
			}
			if (errors.length > 0) {
				throw new BestOfNWorktreeError(`Failed to clean up ${errors.length} best-of-N worker worktree operation(s).`, { cause: errors[0] });
			}
		},
	};
}
