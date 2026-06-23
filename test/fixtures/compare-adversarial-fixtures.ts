import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const terminalControlPayload = "bad\u001b[2J-name\u0007-c1\u009b31m";

export interface CompareRunFixtureOptions {
	keepArtifacts?: boolean;
	malformedLineup?: boolean;
	lineup?: Record<string, unknown>;
	omitReport?: boolean;
	reportText?: string;
	hugeReportBytes?: number;
	hugeArtifactBytes?: number;
	manyWorkerArtifacts?: number;
	manyReviewerArtifacts?: number;
	manyWorkerSlots?: number;
	manyReviewerSlots?: number;
	workerArtifactText?: string;
	reviewerArtifactText?: string;
	finalArtifactText?: string;
}

export interface PresetCatalogFixtureOptions {
	malformed?: boolean;
	hugeDescriptionBytes?: number;
	presets?: Record<string, unknown>;
}

export function supportsPermissionDenialFixtures(): boolean {
	return process.platform !== "win32" && process.getuid?.() !== 0;
}

export function compareRunRoot(projectRoot: string): string {
	return join(projectRoot, ".pi", "runs", "best-of-n");
}

export function withAdversarialFixtureDir(run: (root: string) => void | Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-adversarial-"));
	return Promise.resolve(run(root)).finally(() => removeFixtureTree(root));
}

export function removeFixtureTree(root: string): void {
	const resolved = resolve(root);
	const temp = resolve(tmpdir());
	const relativeToTemp = relative(temp, resolved);
	if (!relativeToTemp || relativeToTemp.startsWith("..") || isAbsolute(relativeToTemp)) {
		throw new Error(`Refusing to remove fixture tree outside temp dir: ${root}`);
	}
	try {
		const stat = lstatSync(resolved);
		if (stat.isSymbolicLink()) {
			unlinkSync(resolved);
			return;
		}
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return;
		throw error;
	}
	rmSync(resolved, { recursive: true, force: true });
}

export function writeCompareRun(projectRoot: string, name: string, options: CompareRunFixtureOptions = {}): string {
	const runDir = join(compareRunRoot(projectRoot), name);
	mkdirSync(runDir, { recursive: true });
	if (!options.omitReport) {
		writeFileSync(join(runDir, "report.md"), options.reportText ?? hugeText("# Best-of-N run: compare\n\n- Status: review-complete\n\n## Task\n\nship it\n", options.hugeReportBytes));
	}
	writeFileSync(join(runDir, "lineup.json"), options.malformedLineup ? "{ nope" : `${JSON.stringify(options.lineup ?? defaultLineup(options), null, 2)}\n`);
	if (options.keepArtifacts) {
		writeFileSync(join(runDir, "worker-1.md"), hugeText(options.workerArtifactText ?? "worker output\n", options.hugeArtifactBytes));
		writeFileSync(join(runDir, "reviewer-1.md"), hugeText(options.reviewerArtifactText ?? "reviewer output\n", options.hugeArtifactBytes));
		writeFileSync(join(runDir, "final-applier.md"), options.finalArtifactText ?? "final output\n");
	}
	for (let index = 1; index <= (options.manyWorkerArtifacts ?? 0); index += 1) {
		writeFileSync(join(runDir, `worker-${index}.md`), `worker ${index}\n`);
	}
	for (let index = 1; index <= (options.manyReviewerArtifacts ?? 0); index += 1) {
		writeFileSync(join(runDir, `reviewer-${index}.md`), `reviewer ${index}\n`);
	}
	return runDir;
}

export function createSymlinkedRunRoot(projectRoot: string, target: string): string {
	mkdirSync(join(projectRoot, ".pi", "runs"), { recursive: true });
	const link = compareRunRoot(projectRoot);
	symlinkSync(target, link);
	return link;
}

export function createSymlinkedRunDir(projectRoot: string, name: string, target: string): string {
	mkdirSync(compareRunRoot(projectRoot), { recursive: true });
	const link = join(compareRunRoot(projectRoot), name);
	symlinkSync(target, link);
	return link;
}

export function createSymlinkedArtifact(runDir: string, artifactName: string, target: string): string {
	const link = join(runDir, artifactName);
	rmSync(link, { force: true });
	symlinkSync(target, link);
	return link;
}

export function makeUnreadable(path: string): () => void {
	if (!supportsPermissionDenialFixtures()) return () => {};
	const previousMode = lstatSync(path).mode & 0o777;
	chmodSync(path, 0o000);
	return () => chmodSync(path, previousMode);
}

export function writePresetCatalog(projectRoot: string, options: PresetCatalogFixtureOptions = {}): string {
	const catalogPath = join(projectRoot, ".pi", "best-of-n-presets.json");
	mkdirSync(join(projectRoot, ".pi"), { recursive: true });
	if (options.malformed) {
		writeFileSync(catalogPath, "{ not json");
		return catalogPath;
	}
	writeFileSync(catalogPath, `${JSON.stringify({
		presets: options.presets ?? {
			valid: { description: hugeText("valid", options.hugeDescriptionBytes), workers: [{ agent: "delegate" }] },
			invalidEmpty: { workers: [] },
			invalidPolicy: { workers: [{ agent: "delegate", cwd: "/tmp/escape", taskSuffix: "do more" }] },
		},
	}, null, 2)}\n`);
	return catalogPath;
}

function defaultLineup(options: CompareRunFixtureOptions): Record<string, unknown> {
	return {
		prompt: "compare",
		status: "review-complete",
		preset: "strict-oracle",
		commit: "ask",
		keepArtifacts: options.keepArtifacts ?? false,
		workers: Array.from({ length: options.manyWorkerSlots ?? 1 }, () => ({ agent: "worker", effectiveModel: "anthropic/claude", effectiveTask: "work" })),
		reviewers: Array.from({ length: options.manyReviewerSlots ?? 1 }, () => ({ agent: "reviewer", effectiveModel: "anthropic/claude", effectiveTask: "review" })),
		finalApplier: { agent: "applier", effectiveModel: "anthropic/claude", effectiveTask: "apply" },
	};
}

function hugeText(seed: string, byteLength: number | undefined): string {
	if (!byteLength || Buffer.byteLength(seed) >= byteLength) return seed;
	return `${seed}${"x".repeat(byteLength - Buffer.byteLength(seed))}`;
}


