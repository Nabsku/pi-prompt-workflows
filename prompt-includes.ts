import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { PromptLoaderDiagnostic, PromptSource, PromptSourceRecord } from "./prompt-loader.js";

export interface RenderPromptIncludesInput {
	content: string;
	includes?: string[];
	promptFilePath: string;
	promptRoot: string;
	cwd: string;
	source: PromptSource;
	debugBoundaries?: boolean;
	homeDir?: string;
}

export type RenderPromptIncludesResult =
	| { ok: true; content: string }
	| { ok: false; diagnostics: PromptLoaderDiagnostic[] };

export interface ResolvePromptIncludePathInput {
	includePath: string;
	promptFilePath: string;
	promptRoot: string;
	cwd: string;
	source: PromptSource;
	homeDir?: string;
}

export type ResolvePromptIncludePathResult =
	| { ok: true; filePath: string }
	| { ok: false; diagnostics: PromptLoaderDiagnostic[] };

export interface CollectPromptIncludeGraphsInput {
	records: PromptSourceRecord[];
	homeDir?: string;
}

export interface CollectPromptIncludeGraphsResult {
	graphs: PromptIncludeGraph[];
}

export interface PromptIncludeGraph {
	root: PromptSourceRecord;
	nodes: PromptIncludeGraphNode[];
	edges: PromptIncludeGraphEdge[];
	diagnostics: PromptLoaderDiagnostic[];
}

export type PromptIncludeGraphNodeKind = "prompt" | "partial" | "unresolved";
export type PromptIncludeGraphNodeStatus = "ok" | "failed";

export interface PromptIncludeGraphNode {
	id: string;
	kind: PromptIncludeGraphNodeKind;
	status: PromptIncludeGraphNodeStatus;
	filePath?: string;
	includePath?: string;
	diagnostics: PromptLoaderDiagnostic[];
}

export type PromptIncludeGraphEdgeKind = "frontmatter" | "inline";

export interface PromptIncludeGraphEdge {
	fromNodeId: string;
	toNodeId: string;
	kind: PromptIncludeGraphEdgeKind;
	includePath: string;
	order: number;
	status: PromptIncludeGraphNodeStatus;
	diagnostics: PromptLoaderDiagnostic[];
}

interface IncludeRoot {
	label: string;
	path: string;
	canonicalPath?: string;
	expectedCanonicalPath?: string | null;
}

interface IncludeRenderContext {
	promptFilePath: string;
	source: PromptSource;
	debugBoundaries: boolean;
	homeDir: string;
	diagnostics: PromptLoaderDiagnostic[];
	roots: IncludeRoot[];
	allowedRoots: IncludeRoot[];
}

interface ResolvedPromptIncludePath {
	filePath: string;
}

const HAS_INCLUDES_PLACEHOLDER_PATTERN = /<includes\s*\/\s*>/;
const INCLUDES_PLACEHOLDER_PATTERN = /<includes\s*\/\s*>/g;
const HAS_INLINE_INCLUDE_PATTERN = /<include\s+file\s*=\s*(["'])([^"']+)\1\s*\/\s*>/;
const INLINE_INCLUDE_PATTERN = /<include\s+file\s*=\s*(["'])([^"']+)\1\s*\/\s*>/g;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const GLOB_META_PATTERN = /[*?\[\]]/;
export const MAX_INCLUDE_DEPTH = 64;

export function hasPromptIncludeDirectives(content: string): boolean {
	return HAS_INCLUDES_PLACEHOLDER_PATTERN.test(content) || HAS_INLINE_INCLUDE_PATTERN.test(content);
}

export function extractPromptInlineIncludes(content: string): string[] {
	return Array.from(content.matchAll(INLINE_INCLUDE_PATTERN), (match) => match[2]);
}

export function hasPromptIncludesPlaceholder(content: string): boolean {
	return HAS_INCLUDES_PLACEHOLDER_PATTERN.test(content);
}

export function stripPromptPartialFrontmatter(content: string): string {
	return stripMarkdownFrontmatter(content);
}

export function renderPromptIncludes(input: RenderPromptIncludesInput): RenderPromptIncludesResult {
	const context = createIncludeRenderContext(input);
	const hasIncludesPlaceholder = HAS_INCLUDES_PLACEHOLDER_PATTERN.test(input.content);
	if (hasIncludesPlaceholder && input.includes === undefined) {
		context.diagnostics.push(
			createDiagnostic(
				context,
				context.promptFilePath,
				"include-placeholder-without-includes",
				'Prompt body uses <includes /> but frontmatter does not declare "include" or "includes"; add include/includes metadata or remove the placeholder.',
			),
		);
		return { ok: false, diagnostics: context.diagnostics };
	}

	const initialStack = canonicalPromptStackEntry(input.promptFilePath);
	const stack = initialStack ? [initialStack] : [];

	const includeGroup = renderIncludeGroup(input.includes ?? [], context, stack, context.promptFilePath);
	let content = input.content;

	if (hasIncludesPlaceholder) {
		content = content.replace(INCLUDES_PLACEHOLDER_PATTERN, () => includeGroup);
	} else if (includeGroup) {
		content = content ? `${includeGroup}\n\n${content}` : includeGroup;
	}

	const renderedContent = renderInlineIncludes(content, context, stack, context.promptFilePath);
	if (context.diagnostics.length > 0) {
		return { ok: false, diagnostics: context.diagnostics };
	}

	return { ok: true, content: renderedContent };
}

export function resolvePromptIncludePath(input: ResolvePromptIncludePathInput): ResolvePromptIncludePathResult {
	const diagnostics: PromptLoaderDiagnostic[] = [];
	const context = createIncludeRenderContext({ ...input, content: "", diagnostics });
	const resolved = resolveIncludePath(input.includePath, context, context.promptFilePath);
	if (!resolved) return { ok: false, diagnostics };
	return { ok: true, filePath: resolved.filePath };
}

export function collectPromptIncludeGraphs(input: CollectPromptIncludeGraphsInput): CollectPromptIncludeGraphsResult {
	return {
		graphs: input.records.map((record) => collectPromptIncludeGraph(record, input.homeDir)),
	};
}

function collectPromptIncludeGraph(record: PromptSourceRecord, homeDir?: string): PromptIncludeGraph {
	const diagnostics: PromptLoaderDiagnostic[] = [];
	const context = createIncludeRenderContext({
		content: record.rawBody,
		includes: record.includes,
		promptFilePath: record.filePath,
		promptRoot: record.promptRoot,
		cwd: record.cwd,
		source: record.source,
		homeDir,
		diagnostics,
	});
	const nodes = new Map<string, PromptIncludeGraphNode>();
	const edges: PromptIncludeGraphEdge[] = [];
	const traversedPartials = new Set<string>();
	let nextUnresolvedNodeId = 0;
	let nextOrder = 0;

	const rootNodeId = nodeIdForFile(context.promptFilePath);
	pushNode(nodes, {
		id: rootNodeId,
		kind: "prompt",
		status: "ok",
		filePath: context.promptFilePath,
		diagnostics: [],
	});

	if (record.includeMetadataInvalid === true && record.skippedReason) {
		addRootDiagnostic(context, nodes, rootNodeId, createIncludeMetadataInvalidGraphDiagnostic(context, record));
	} else if (!record.isChainWrapper && record.hasIncludesPlaceholder && record.includes === undefined) {
		addRootDiagnostic(
			context,
			nodes,
			rootNodeId,
			createDiagnostic(
				context,
				context.promptFilePath,
				"include-placeholder-without-includes",
				'Prompt body uses <includes /> but frontmatter does not declare "include" or "includes"; add include/includes metadata or remove the placeholder.',
			),
		);
	}

	if (!record.isChainWrapper && record.includeMetadataInvalid !== true) {
		for (const includePath of record.includes ?? []) {
			collectIncludeEdge({
				includePath,
				kind: "frontmatter",
				fromNodeId: rootNodeId,
				currentFilePath: context.promptFilePath,
				context,
				nodes,
				edges,
				traversedPartials,
				stack: canonicalPromptStackEntry(context.promptFilePath) ? [canonicalPromptStackEntry(context.promptFilePath)!] : [],
				nextOrder: () => nextOrder++,
				nextUnresolvedNodeId: () => nextUnresolvedNodeId++,
			});
		}

		for (const includePath of extractPromptInlineIncludes(record.rawBody)) {
			collectIncludeEdge({
				includePath,
				kind: "inline",
				fromNodeId: rootNodeId,
				currentFilePath: context.promptFilePath,
				context,
				nodes,
				edges,
				traversedPartials,
				stack: canonicalPromptStackEntry(context.promptFilePath) ? [canonicalPromptStackEntry(context.promptFilePath)!] : [],
				nextOrder: () => nextOrder++,
				nextUnresolvedNodeId: () => nextUnresolvedNodeId++,
			});
		}
	}

	return { root: record, nodes: [...nodes.values()], edges, diagnostics };
}

function createIncludeRenderContext(input: RenderPromptIncludesInput & { diagnostics?: PromptLoaderDiagnostic[] }): IncludeRenderContext {
	const homeDir = input.homeDir ?? homedir();
	const canonicalHomeDir = canonicalDirectory(homeDir);
	const canonicalCwd = canonicalDirectory(input.cwd);
	const fallbackRoots: IncludeRoot[] = [
		{ label: "prompt root", path: resolve(input.promptRoot) },
		{
			label: "global prompt partials",
			path: resolve(join(homeDir, ".pi", "agent", "prompt-partials")),
			expectedCanonicalPath: canonicalHomeDir ? resolve(canonicalHomeDir, ".pi", "agent", "prompt-partials") : null,
		},
		{
			label: "project prompt partials",
			path: resolve(join(input.cwd, ".pi", "prompt-partials")),
			expectedCanonicalPath: canonicalCwd ? resolve(canonicalCwd, ".pi", "prompt-partials") : null,
		},
	];
	const promptDirectoryRoot: IncludeRoot = { label: "prompt directory", path: dirname(resolve(input.promptFilePath)) };
	const roots = canonicalizeRoots(fallbackRoots);
	const allowedRoots = canonicalizeRoots([promptDirectoryRoot, ...fallbackRoots]);

	return {
		promptFilePath: resolve(input.promptFilePath),
		source: input.source,
		debugBoundaries: input.debugBoundaries ?? false,
		homeDir,
		diagnostics: input.diagnostics ?? [],
		roots,
		allowedRoots,
	};
}

function canonicalizeRoots(roots: IncludeRoot[]): IncludeRoot[] {
	return dedupeRoots(roots.map((root) => ({ ...root, canonicalPath: canonicalDirectory(root.path, { expectedCanonicalPath: root.expectedCanonicalPath }) })));
}

function includeRootsForCurrentFile(currentFilePath: string, context: IncludeRenderContext): IncludeRoot[] {
	const currentDirectory = dirname(resolve(currentFilePath));
	const currentRoot: IncludeRoot = { label: "current file directory", path: currentDirectory, canonicalPath: canonicalDirectory(currentDirectory) };
	return dedupeRoots([currentRoot, ...context.roots]);
}

function canonicalDirectory(path: string, options: { expectedCanonicalPath?: string | null } = {}): string | undefined {
	if (options.expectedCanonicalPath === null) return undefined;
	try {
		const canonicalPath = realpathSync(path);
		if (options.expectedCanonicalPath !== undefined && !isSamePath(canonicalPath, options.expectedCanonicalPath)) return undefined;
		return statSync(canonicalPath).isDirectory() ? canonicalPath : undefined;
	} catch {
		return undefined;
	}
}

function isSamePath(left: string, right: string): boolean {
	return resolve(left) === resolve(right);
}

function dedupeRoots(roots: IncludeRoot[]): IncludeRoot[] {
	const seen = new Set<string>();
	const deduped: IncludeRoot[] = [];
	for (const root of roots) {
		const key = root.canonicalPath ?? root.path;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(root);
	}
	return deduped;
}

function canonicalPromptStackEntry(promptFilePath: string): string | undefined {
	try {
		return realpathSync(promptFilePath);
	} catch {
		return undefined;
	}
}

function renderIncludeGroup(includePaths: string[], context: IncludeRenderContext, stack: string[], currentFilePath: string): string {
	return includePaths
		.map((includePath) => renderIncludeFile(includePath, context, stack, currentFilePath))
		.filter((content): content is string => content !== undefined)
		.join("\n\n");
}

function renderInlineIncludes(content: string, context: IncludeRenderContext, stack: string[], currentFilePath: string): string {
	return content.replace(INLINE_INCLUDE_PATTERN, (_tag, _quote: string, includePath: string) => {
		return renderIncludeFile(includePath, context, stack, currentFilePath) ?? "";
	});
}

function renderIncludeFile(includePath: string, context: IncludeRenderContext, stack: string[], currentFilePath: string): string | undefined {
	const resolved = resolveIncludePath(includePath, context, currentFilePath);
	if (!resolved) return undefined;

	if (stack.includes(resolved.filePath)) {
		context.diagnostics.push(
			createDiagnostic(
				context,
				currentFilePath,
				"include-cycle",
				`Cyclic prompt include detected for ${JSON.stringify(includePath)}: ${[...stack, resolved.filePath].join(" -> ")}.`,
			),
		);
		return undefined;
	}

	if (stack.length > MAX_INCLUDE_DEPTH) {
		context.diagnostics.push(
			createDiagnostic(
				context,
				currentFilePath,
				"include-depth-exceeded",
				`Prompt include ${JSON.stringify(includePath)} exceeds the maximum nested include depth of ${MAX_INCLUDE_DEPTH}.`,
			),
		);
		return undefined;
	}

	let rawContent: string;
	try {
		rawContent = readFileSync(resolved.filePath, "utf8");
	} catch (error) {
		context.diagnostics.push(
			createDiagnostic(
				context,
				currentFilePath,
				"include-read-error",
				`Unable to read prompt include ${JSON.stringify(includePath)} at ${resolved.filePath}: ${error instanceof Error ? error.message : String(error)}.`,
			),
		);
		return undefined;
	}

	const body = stripMarkdownFrontmatter(rawContent);
	const renderedBody = renderInlineIncludes(body, context, [...stack, resolved.filePath], resolved.filePath);
	if (!context.debugBoundaries) return renderedBody;

	return [`<!-- BEGIN include: ${includePath.trim()} -->`, renderedBody, `<!-- END include: ${includePath.trim()} -->`].join("\n");
}

interface CollectIncludeEdgeInput {
	includePath: string;
	kind: PromptIncludeGraphEdgeKind;
	fromNodeId: string;
	currentFilePath: string;
	context: IncludeRenderContext;
	nodes: Map<string, PromptIncludeGraphNode>;
	edges: PromptIncludeGraphEdge[];
	traversedPartials: Set<string>;
	stack: string[];
	nextOrder: () => number;
	nextUnresolvedNodeId: () => number;
}

function collectIncludeEdge(input: CollectIncludeEdgeInput): void {
	const diagnosticStart = input.context.diagnostics.length;
	const edgeOrder = input.nextOrder();
	const resolved = resolveIncludePath(input.includePath, input.context, input.currentFilePath);
	const resolveDiagnostics = input.context.diagnostics.slice(diagnosticStart);
	if (!resolved) {
		const toNodeId = `unresolved:${input.nextUnresolvedNodeId()}`;
		const diagnostics = [...resolveDiagnostics];
		pushNode(input.nodes, {
			id: toNodeId,
			kind: "unresolved",
			status: "failed",
			includePath: input.includePath,
			diagnostics,
		});
		input.edges.push({
			fromNodeId: input.fromNodeId,
			toNodeId,
			kind: input.kind,
			includePath: input.includePath,
			order: edgeOrder,
			status: "failed",
			diagnostics,
		});
		return;
	}

	const toNodeId = nodeIdForFile(resolved.filePath);
	const existingNode = input.nodes.get(toNodeId);
	pushNode(input.nodes, {
		id: toNodeId,
		kind: "partial",
		status: "ok",
		filePath: resolved.filePath,
		diagnostics: [],
	});

	if (input.stack.includes(resolved.filePath)) {
		const diagnostic = createDiagnostic(
			input.context,
			input.currentFilePath,
			"include-cycle",
			`Cyclic prompt include detected for ${JSON.stringify(input.includePath)}: ${[...input.stack, resolved.filePath].join(" -> ")}.`,
		);
		input.context.diagnostics.push(diagnostic);
		const diagnostics = [diagnostic];
		input.nodes.set(toNodeId, {
			...(existingNode ?? input.nodes.get(toNodeId)!),
			status: "failed",
			diagnostics: [...(existingNode?.diagnostics ?? []), diagnostic],
		});
		input.edges.push({
			fromNodeId: input.fromNodeId,
			toNodeId,
			kind: input.kind,
			includePath: input.includePath,
			order: edgeOrder,
			status: "failed",
			diagnostics,
		});
		return;
	}

	if (input.stack.length > MAX_INCLUDE_DEPTH) {
		const diagnostic = createDiagnostic(
			input.context,
			input.currentFilePath,
			"include-depth-exceeded",
			`Prompt include ${JSON.stringify(input.includePath)} exceeds the maximum nested include depth of ${MAX_INCLUDE_DEPTH}.`,
		);
		input.context.diagnostics.push(diagnostic);
		input.nodes.set(toNodeId, {
			...(existingNode ?? input.nodes.get(toNodeId)!),
			status: "failed",
			diagnostics: [...(existingNode?.diagnostics ?? []), diagnostic],
		});
		input.edges.push({
			fromNodeId: input.fromNodeId,
			toNodeId,
			kind: input.kind,
			includePath: input.includePath,
			order: edgeOrder,
			status: "failed",
			diagnostics: [diagnostic],
		});
		return;
	}

	if (input.traversedPartials.has(resolved.filePath)) {
		input.edges.push({
			fromNodeId: input.fromNodeId,
			toNodeId,
			kind: input.kind,
			includePath: input.includePath,
			order: edgeOrder,
			status: "ok",
			diagnostics: [],
		});
		return;
	}
	input.traversedPartials.add(resolved.filePath);

	let rawContent: string;
	try {
		rawContent = readFileSync(resolved.filePath, "utf8");
	} catch (error) {
		const diagnostic = createDiagnostic(
			input.context,
			input.currentFilePath,
			"include-read-error",
			`Unable to read prompt include ${JSON.stringify(input.includePath)} at ${resolved.filePath}: ${error instanceof Error ? error.message : String(error)}.`,
		);
		input.context.diagnostics.push(diagnostic);
		input.nodes.set(toNodeId, {
			...(input.nodes.get(toNodeId)!),
			status: "failed",
			diagnostics: [...(input.nodes.get(toNodeId)?.diagnostics ?? []), diagnostic],
		});
		input.edges.push({
			fromNodeId: input.fromNodeId,
			toNodeId,
			kind: input.kind,
			includePath: input.includePath,
			order: edgeOrder,
			status: "failed",
			diagnostics: [diagnostic],
		});
		return;
	}

	input.edges.push({
		fromNodeId: input.fromNodeId,
		toNodeId,
		kind: input.kind,
		includePath: input.includePath,
		order: edgeOrder,
		status: "ok",
		diagnostics: [],
	});

	const body = stripMarkdownFrontmatter(rawContent);
	const nextStack = [...input.stack, resolved.filePath];
	for (const nestedIncludePath of extractPromptInlineIncludes(body)) {
		collectIncludeEdge({
			...input,
			includePath: nestedIncludePath,
			kind: "inline",
			fromNodeId: toNodeId,
			currentFilePath: resolved.filePath,
			stack: nextStack,
		});
	}
}

function nodeIdForFile(filePath: string): string {
	return `file:${filePath}`;
}

function pushNode(nodes: Map<string, PromptIncludeGraphNode>, node: PromptIncludeGraphNode): void {
	if (!nodes.has(node.id)) nodes.set(node.id, node);
}

function addRootDiagnostic(context: IncludeRenderContext, nodes: Map<string, PromptIncludeGraphNode>, rootNodeId: string, diagnostic: PromptLoaderDiagnostic): void {
	context.diagnostics.push(diagnostic);
	const rootNode = nodes.get(rootNodeId);
	if (rootNode) {
		nodes.set(rootNodeId, {
			...rootNode,
			status: "failed",
			diagnostics: [...rootNode.diagnostics, diagnostic],
		});
	}
}

function createIncludeMetadataInvalidGraphDiagnostic(context: IncludeRenderContext, record: PromptSourceRecord): PromptLoaderDiagnostic {
	const code = record.skippedReason ?? "invalid-include-metadata";
	const message =
		code === "invalid-includes-chain"
			? `Include graph skipped for ${record.filePath}: frontmatter include/includes cannot be used on chain wrapper templates; put include/includes on referenced step templates instead.`
			: `Include graph skipped for ${record.filePath}: invalid include metadata (${code}).`;
	return createDiagnostic(context, record.filePath, code, message, record.filePath);
}

function resolveIncludePath(includePath: string, context: IncludeRenderContext, currentFilePath: string): ResolvedPromptIncludePath | undefined {
	const normalizedPath = includePath.trim();
	if (!normalizedPath) {
		context.diagnostics.push(createDiagnostic(context, currentFilePath, "include-invalid-path", "Prompt include path must be a non-empty string."));
		return undefined;
	}
	if (normalizedPath.includes("\0")) {
		context.diagnostics.push(createDiagnostic(context, currentFilePath, "include-invalid-path", `Prompt include path ${JSON.stringify(normalizedPath)} contains a NUL byte.`));
		return undefined;
	}
	if (hasUrlScheme(normalizedPath)) {
		context.diagnostics.push(
			createDiagnostic(context, currentFilePath, "include-url-disallowed", `Prompt include ${JSON.stringify(normalizedPath)} is not allowed: URL include paths are rejected.`),
		);
		return undefined;
	}
	if (hasGlobMeta(normalizedPath)) {
		context.diagnostics.push(
			createDiagnostic(context, currentFilePath, "include-glob-disallowed", `Prompt include ${JSON.stringify(normalizedPath)} is not allowed: glob patterns are rejected.`),
		);
		return undefined;
	}
	if (!hasMarkdownExtension(normalizedPath)) {
		context.diagnostics.push(
			createDiagnostic(context, currentFilePath, "include-non-markdown", `Prompt include ${JSON.stringify(normalizedPath)} is not allowed: only .md files can be included.`),
		);
		return undefined;
	}

	if (normalizedPath.startsWith("~/")) {
		return resolveHomeIncludePath(normalizedPath, context, currentFilePath);
	}

	if (isAbsolute(normalizedPath)) {
		context.diagnostics.push(
			createDiagnostic(
				context,
				currentFilePath,
				"include-absolute-disallowed",
				`Prompt include ${JSON.stringify(normalizedPath)} is not allowed: absolute paths are rejected unless they use ~/ and resolve under a Pi prompt root.`,
			),
		);
		return undefined;
	}

	let sawEscapedCandidate = false;
	for (const root of includeRootsForCurrentFile(currentFilePath, context)) {
		if (!root.canonicalPath) continue;
		const candidate = resolve(root.path, normalizedPath);
		if (!isPathInside(root.path, candidate)) {
			sawEscapedCandidate = true;
			continue;
		}
		if (!existsSync(candidate)) continue;
		return validateExistingIncludeCandidate(candidate, normalizedPath, context, currentFilePath);
	}

	if (sawEscapedCandidate) {
		context.diagnostics.push(
			createDiagnostic(
				context,
				currentFilePath,
				"include-path-escaped",
				`Prompt include ${JSON.stringify(normalizedPath)} escapes the allowed include roots.`,
			),
		);
		return undefined;
	}

	context.diagnostics.push(
		createDiagnostic(
			context,
			currentFilePath,
			"include-not-found",
			`Prompt include ${JSON.stringify(normalizedPath)} was not found in current file directory, prompt root, global prompt partials, or project prompt partials.`,
		),
	);
	return undefined;
}

function resolveHomeIncludePath(includePath: string, context: IncludeRenderContext, currentFilePath: string): ResolvedPromptIncludePath | undefined {
	const expandedPath = resolve(join(context.homeDir, includePath.slice(2)));

	if (!isPathInsideAny(context.allowedRoots.map((root) => root.path), expandedPath)) {
		context.diagnostics.push(
			createDiagnostic(
				context,
				currentFilePath,
				"include-absolute-disallowed",
				`Prompt include ${JSON.stringify(includePath)} is not allowed: ~/ paths must resolve under a Pi prompt root.`,
			),
		);
		return undefined;
	}

	if (!existsSync(expandedPath)) {
		context.diagnostics.push(createDiagnostic(context, currentFilePath, "include-not-found", `Prompt include ${JSON.stringify(includePath)} was not found at ${expandedPath}.`));
		return undefined;
	}

	return validateExistingIncludeCandidate(expandedPath, includePath, context, currentFilePath);
}

function validateExistingIncludeCandidate(candidate: string, includePath: string, context: IncludeRenderContext, currentFilePath: string): ResolvedPromptIncludePath | undefined {
	let canonicalPath: string;
	try {
		canonicalPath = realpathSync(candidate);
	} catch (error) {
		context.diagnostics.push(
			createDiagnostic(
				context,
				currentFilePath,
				"include-read-error",
				`Unable to resolve prompt include ${JSON.stringify(includePath)} at ${candidate}: ${error instanceof Error ? error.message : String(error)}.`,
			),
		);
		return undefined;
	}

	if (!isPathInsideAny(canonicalAllowedRootPaths(context), canonicalPath)) {
		context.diagnostics.push(
			createDiagnostic(
				context,
				currentFilePath,
				"include-path-escaped",
				`Prompt include ${JSON.stringify(includePath)} resolves outside the allowed Pi prompt roots after canonicalization.`,
			),
		);
		return undefined;
	}

	if (!hasMarkdownExtension(canonicalPath)) {
		context.diagnostics.push(
			createDiagnostic(
				context,
				currentFilePath,
				"include-non-markdown",
				`Prompt include ${JSON.stringify(includePath)} resolves to ${canonicalPath}, which is not a .md file.`,
			),
		);
		return undefined;
	}

	let isFile = false;
	try {
		isFile = statSync(canonicalPath).isFile();
	} catch (error) {
		context.diagnostics.push(
			createDiagnostic(
				context,
				currentFilePath,
				"include-read-error",
				`Unable to stat prompt include ${JSON.stringify(includePath)} at ${canonicalPath}: ${error instanceof Error ? error.message : String(error)}.`,
			),
		);
		return undefined;
	}

	if (!isFile) {
		context.diagnostics.push(createDiagnostic(context, currentFilePath, "include-not-file", `Prompt include ${JSON.stringify(includePath)} resolves to ${canonicalPath}, which is not a file.`));
		return undefined;
	}

	return { filePath: canonicalPath };
}

function canonicalAllowedRootPaths(context: IncludeRenderContext): string[] {
	return context.allowedRoots.map((root) => root.canonicalPath).filter((path): path is string => path !== undefined);
}

function hasMarkdownExtension(path: string): boolean {
	return extname(path).toLowerCase() === ".md";
}

function hasUrlScheme(path: string): boolean {
	return URL_SCHEME_PATTERN.test(path);
}

function hasGlobMeta(path: string): boolean {
	return GLOB_META_PATTERN.test(path);
}

function isPathInsideAny(roots: string[], path: string): boolean {
	return roots.some((root) => isPathInside(root, path));
}

function isPathInside(root: string, path: string): boolean {
	const normalizedRoot = resolve(root);
	const normalizedPath = resolve(path);
	return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function stripMarkdownFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;

	const openingLineEndingLength = lineEndingLengthAt(content, 3);
	if (openingLineEndingLength === 0) return content;

	let lineStart = 3 + openingLineEndingLength;
	while (lineStart <= content.length) {
		const lineEnd = findLineEnd(content, lineStart);
		if (content.slice(lineStart, lineEnd.index) === "---") {
			return content.slice(lineEnd.index + lineEnd.length);
		}
		if (lineEnd.length === 0) return content;
		lineStart = lineEnd.index + lineEnd.length;
	}

	return content;
}

function lineEndingLengthAt(content: string, index: number): number {
	const char = content[index];
	if (char === "\n") return 1;
	if (char === "\r") return content[index + 1] === "\n" ? 2 : 1;
	return 0;
}

function findLineEnd(content: string, start: number): { index: number; length: number } {
	for (let index = start; index < content.length; index += 1) {
		const char = content[index];
		if (char === "\n") return { index, length: 1 };
		if (char === "\r") return { index, length: content[index + 1] === "\n" ? 2 : 1 };
	}
	return { index: content.length, length: 0 };
}

function createDiagnostic(context: IncludeRenderContext, currentFilePath: string, code: string, message: string, filePath = currentFilePath): PromptLoaderDiagnostic {
	return {
		code,
		message,
		filePath,
		source: context.source,
		key: `${code}:${filePath}:${message}`,
	};
}
