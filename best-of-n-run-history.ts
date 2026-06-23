import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

export interface BestOfNRunHistoryOptions {
	limit?: number;
	maxBytes?: number;
	plain?: boolean;
}

export interface BestOfNArtifactEntry {
	name: string;
	status: "retained" | "not-retained" | "missing" | "rejected" | "truncated";
	path: string;
	size?: number;
	diagnostic?: string;
}

export interface BestOfNRunHistoryEntry {
	name: string;
	path: string;
	reportPath: string;
	status?: string;
	prompt?: string;
	preset?: string;
	commit?: string;
	workerCalls?: number;
	reviewerCalls?: number;
	finalApplier?: boolean;
	keepArtifacts?: boolean;
	reportPreview?: string;
	artifacts: BestOfNArtifactEntry[];
	diagnostics: string[];
	mtimeMs: number;
}

export interface BestOfNRunHistoryResult {
	root: string;
	entries: BestOfNRunHistoryEntry[];
	diagnostics: string[];
}

const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_BYTES = 32 * 1024;
const MAX_LINEUP_PARSE_BYTES = 64 * 1024 * 1024;
const MAX_LINEUP_ARTIFACT_SLOTS = 100;
const KNOWN_STATIC_ARTIFACTS = ["final-applier.md"];

function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !rel.includes(`..${sep}`) && !rel.startsWith(sep));
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_LIMIT;
	if (!Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
	return Math.floor(limit);
}

function safeJsonObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function safeString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function readBoundedText(filePath: string, root: string, maxBytes: number): { text?: string; size?: number; truncated?: boolean; diagnostic?: string } {
	const resolved = resolve(filePath);
	if (!isInside(root, resolved)) {
		return { diagnostic: `Rejected ${basename(filePath)}: path escapes run directory.` };
	}
	try {
		const link = lstatSync(resolved);
		if (link.isSymbolicLink()) return { diagnostic: `Rejected ${basename(filePath)}: symlink artifacts are not read.` };
		if (!link.isFile()) return { diagnostic: `Rejected ${basename(filePath)}: expected a regular file.` };
		const stat = statSync(resolved);
		const bytesToRead = Math.min(Math.max(maxBytes, 0), stat.size);
		const buffer = Buffer.alloc(bytesToRead);
		const fd = openSync(resolved, "r");
		try {
			const bytesRead = bytesToRead > 0 ? readSync(fd, buffer, 0, bytesToRead, 0) : 0;
			const text = buffer.subarray(0, bytesRead).toString("utf8");
			if (stat.size <= maxBytes) return { text, size: stat.size };
			return { text, size: stat.size, truncated: true, diagnostic: `${basename(filePath)} truncated to ${maxBytes} bytes (original ${stat.size} bytes).` };
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		return { diagnostic: `Could not read ${basename(filePath)}: ${error instanceof Error ? error.message : String(error)}.` };
	}
}

function validateRunRoot(cwd: string): { root: string; ok: true } | { root: string; ok: false; diagnostic?: string } {
	const piDir = resolve(cwd, ".pi");
	const runsDir = resolve(piDir, "runs");
	const root = resolve(runsDir, "best-of-n");
	for (const path of [piDir, runsDir, root]) {
		if (!existsSync(path)) return { root, ok: false };
		let stat;
		try {
			stat = lstatSync(path);
		} catch (error) {
			return { root, ok: false, diagnostic: `Could not inspect run root component ${path}: ${error instanceof Error ? error.message : String(error)}.` };
		}
		if (stat.isSymbolicLink()) return { root, ok: false, diagnostic: `Run root component ${path} is a symlink; refusing to read compare run history.` };
		if (!stat.isDirectory()) return { root, ok: false, diagnostic: `Run root component ${path} exists but is not a directory.` };
	}
	return { root, ok: true };
}

function parseLineup(filePath: string, runDir: string, diagnostics: string[]): Record<string, unknown> | undefined {
	const resolved = resolve(filePath);
	if (!isInside(runDir, resolved)) {
		diagnostics.push(`Rejected ${basename(filePath)}: path escapes run directory.`);
		return undefined;
	}
	let text;
	try {
		const link = lstatSync(resolved);
		if (link.isSymbolicLink()) {
			diagnostics.push(`Rejected ${basename(filePath)}: symlink artifacts are not read.`);
			return undefined;
		}
		if (!link.isFile()) {
			diagnostics.push(`Rejected ${basename(filePath)}: expected a regular file.`);
			return undefined;
		}
		const stat = statSync(resolved);
		if (stat.size > MAX_LINEUP_PARSE_BYTES) {
			diagnostics.push(`lineup.json ignored: exceeds ${MAX_LINEUP_PARSE_BYTES} byte parse limit.`);
			return undefined;
		}
		text = readFileSync(resolved, "utf8");
	} catch (error) {
		diagnostics.push(`Could not read ${basename(filePath)}: ${error instanceof Error ? error.message : String(error)}.`);
		return undefined;
	}
	try {
		const parsed = JSON.parse(text);
		const object = safeJsonObject(parsed);
		if (!object) diagnostics.push("lineup.json ignored: expected a JSON object.");
		return object;
	} catch (error) {
		diagnostics.push(`lineup.json ignored: ${error instanceof Error ? error.message : String(error)}.`);
		return undefined;
	}
}

function reportPreview(report: string | undefined): string | undefined {
	if (!report) return undefined;
	const lines = report.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
	const heading = lines.find((line) => line.startsWith("# "));
	const status = lines.find((line) => /^- Status:/i.test(line));
	return [heading, status].filter(Boolean).join(" | ") || lines.slice(0, 2).join(" | ") || undefined;
}

function artifactEntry(name: string, runDir: string, maxBytes: number, expectedRetained: boolean): BestOfNArtifactEntry {
	const artifactPath = join(runDir, name);
	if (!existsSync(artifactPath)) {
		return { name, path: artifactPath, status: expectedRetained ? "missing" : "not-retained" };
	}
	const read = readBoundedText(artifactPath, runDir, maxBytes);
	if (read.diagnostic && !read.text) return { name, path: artifactPath, status: "rejected", diagnostic: read.diagnostic };
	return {
		name,
		path: artifactPath,
		status: read.truncated ? "truncated" : "retained",
		size: read.size,
		diagnostic: read.diagnostic,
	};
}

function expectedArtifactNames(lineup: Record<string, unknown> | undefined, diagnostics: string[]): string[] {
	const names: string[] = [];
	const workers = safeArray(lineup?.workers);
	const reviewers = safeArray(lineup?.reviewers);
	const workerCount = Math.min(workers.length, MAX_LINEUP_ARTIFACT_SLOTS);
	const reviewerCount = Math.min(reviewers.length, MAX_LINEUP_ARTIFACT_SLOTS);
	if (workers.length > MAX_LINEUP_ARTIFACT_SLOTS) diagnostics.push(`lineup.json has ${workers.length} worker slots; artifact inventory capped at ${MAX_LINEUP_ARTIFACT_SLOTS}.`);
	if (reviewers.length > MAX_LINEUP_ARTIFACT_SLOTS) diagnostics.push(`lineup.json has ${reviewers.length} reviewer slots; artifact inventory capped at ${MAX_LINEUP_ARTIFACT_SLOTS}.`);
	for (let index = 0; index < workerCount; index += 1) names.push(`worker-${index + 1}.md`);
	for (let index = 0; index < reviewerCount; index += 1) names.push(`reviewer-${index + 1}.md`);
	if (lineup?.finalApplier !== undefined && lineup.finalApplier !== null) names.push("final-applier.md");
	return names;
}

function artifactInventory(runDir: string, lineup: Record<string, unknown> | undefined, maxBytes: number, diagnostics: string[]): BestOfNArtifactEntry[] {
	const expected = new Set(expectedArtifactNames(lineup, diagnostics));
	const expectedRetained = lineup?.keepArtifacts === true;
	const discovered = new Set<string>();
	let discoveredWorkers = 0;
	let discoveredReviewers = 0;
	let cappedWorkers = false;
	let cappedReviewers = false;
	try {
		for (const entry of readdirSync(runDir, { withFileTypes: true })) {
			if (/^worker-\d+\.md$/.test(entry.name)) {
				if (discoveredWorkers >= MAX_LINEUP_ARTIFACT_SLOTS) {
					cappedWorkers = true;
					continue;
				}
				discoveredWorkers += 1;
				discovered.add(entry.name);
			} else if (/^reviewer-\d+\.md$/.test(entry.name)) {
				if (discoveredReviewers >= MAX_LINEUP_ARTIFACT_SLOTS) {
					cappedReviewers = true;
					continue;
				}
				discoveredReviewers += 1;
				discovered.add(entry.name);
			} else if (KNOWN_STATIC_ARTIFACTS.includes(entry.name)) {
				discovered.add(entry.name);
			}
		}
	} catch (error) {
		diagnostics.push(`Could not list artifacts: ${error instanceof Error ? error.message : String(error)}.`);
	}
	if (cappedWorkers) diagnostics.push(`Discovered worker artifact inventory capped at ${MAX_LINEUP_ARTIFACT_SLOTS}.`);
	if (cappedReviewers) diagnostics.push(`Discovered reviewer artifact inventory capped at ${MAX_LINEUP_ARTIFACT_SLOTS}.`);
	const names = Array.from(new Set([...expected, ...discovered])).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	return names.map((name) => artifactEntry(name, runDir, maxBytes, expectedRetained && expected.has(name)));
}

function collectRun(runDir: string, maxBytes: number): BestOfNRunHistoryEntry {
	const diagnostics: string[] = [];
	const reportPath = join(runDir, "report.md");
	const report = readBoundedText(reportPath, runDir, maxBytes);
	if (report.diagnostic) diagnostics.push(report.diagnostic);
	const lineup = parseLineup(join(runDir, "lineup.json"), runDir, diagnostics);
	let stat;
	try {
		stat = statSync(runDir);
	} catch (error) {
		diagnostics.push(`Could not inspect run directory: ${error instanceof Error ? error.message : String(error)}.`);
		stat = { mtimeMs: 0 };
	}
	return {
		name: basename(runDir),
		path: runDir,
		reportPath,
		status: safeString(lineup?.status),
		prompt: safeString(lineup?.prompt),
		preset: safeString(lineup?.preset),
		commit: safeString(lineup?.commit),
		workerCalls: lineup ? safeArray(lineup.workers).length : undefined,
		reviewerCalls: lineup ? safeArray(lineup.reviewers).length : undefined,
		finalApplier: lineup ? lineup.finalApplier !== undefined && lineup.finalApplier !== null : undefined,
		keepArtifacts: typeof lineup?.keepArtifacts === "boolean" ? lineup.keepArtifacts : undefined,
		reportPreview: reportPreview(report.text),
		artifacts: artifactInventory(runDir, lineup, maxBytes, diagnostics),
		diagnostics,
		mtimeMs: stat.mtimeMs,
	};
}

export function collectBestOfNRunHistory(cwd: string, options: BestOfNRunHistoryOptions = {}): BestOfNRunHistoryResult {
	const rootCheck = validateRunRoot(cwd);
	const root = rootCheck.root;
	if (!rootCheck.ok) return { root, entries: [], diagnostics: rootCheck.diagnostic ? [rootCheck.diagnostic] : [] };
	const diagnostics: string[] = [];
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	let rootStat;
	try {
		rootStat = lstatSync(root);
	} catch (error) {
		return { root, entries: [], diagnostics: [`Could not inspect run root: ${error instanceof Error ? error.message : String(error)}.`] };
	}
	if (rootStat.isSymbolicLink()) return { root, entries: [], diagnostics: ["Run root is a symlink; refusing to read compare run history."] };
	if (!rootStat.isDirectory()) return { root, entries: [], diagnostics: ["Run root exists but is not a directory."] };

	const runDirs: Array<{ path: string; mtimeMs: number; name: string }> = [];
	let rootEntries;
	try {
		rootEntries = readdirSync(root, { withFileTypes: true });
	} catch (error) {
		return { root, entries: [], diagnostics: [`Could not list run root: ${error instanceof Error ? error.message : String(error)}.`] };
	}
	for (const entry of rootEntries) {
		const candidate = join(root, entry.name);
		if (entry.isSymbolicLink()) {
			diagnostics.push(`Ignoring ${entry.name}: symlink run directories are not read.`);
			continue;
		}
		if (!entry.isDirectory()) continue;
		const resolved = resolve(candidate);
		if (!isInside(root, resolved)) {
			diagnostics.push(`Ignoring ${entry.name}: path escapes run root.`);
			continue;
		}
		let stat;
		try {
			stat = statSync(resolved);
		} catch (error) {
			diagnostics.push(`Ignoring ${entry.name}: could not inspect run directory (${error instanceof Error ? error.message : String(error)}).`);
			continue;
		}
		runDirs.push({ path: resolved, mtimeMs: stat.mtimeMs, name: entry.name });
	}

	runDirs.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
	const entries = runDirs.slice(0, clampLimit(options.limit)).map((run) => collectRun(run.path, maxBytes));
	return { root, entries, diagnostics };
}

export function parseBestOfNRunHistoryArgs(args: string): BestOfNRunHistoryOptions {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let limit: number | undefined;
	let plain = false;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--plain") {
			plain = true;
		} else if (token === "--limit" && tokens[index + 1]) {
			limit = Number.parseInt(tokens[index + 1]!, 10);
			index += 1;
		} else if (token.startsWith("--limit=")) {
			limit = Number.parseInt(token.slice("--limit=".length), 10);
		}
	}
	return { limit, plain };
}
