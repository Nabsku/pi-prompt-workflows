import { parseCommandArgs } from "./args.ts";

export interface ChainStep {
	name: string;
	args: string[];
	loopCount?: number | null;
	withContext?: boolean;
}

export interface ParallelChainStep {
	parallel: ChainStep[];
}

export type ChainStepOrParallel = ChainStep | ParallelChainStep;

export interface ParsedChainSteps {
	steps: ChainStepOrParallel[];
	sharedArgs: string[];
	invalidSegments: string[];
}

export interface ParsedChainDeclaration {
	steps: ChainStepOrParallel[];
	invalidSegments: string[];
}

export type ChainOutcome = "succeeded" | "failed" | "blocked" | "skipped";
export type ChainGate = "always" | "changed" | "succeeded" | "failed";
export interface ChainLimits { readonly maxSteps: number; readonly maxModelCalls: number }
export interface StructuredChainStep {
	id: string;
	kind: "prompt" | "run";
	target: string;
	when: ChainGate;
	onSuccess?: string;
	onFailure?: string;
	onBlocked?: string;
}
export interface ParsedStructuredChainDeclaration {
	steps: StructuredChainStep[];
	limits: ChainLimits;
	invalidSegments: string[];
}

export const DEFAULT_CHAIN_LIMITS: Readonly<ChainLimits> = Object.freeze({ maxSteps: 10, maxModelCalls: 5 });
export const MAX_CHAIN_LIMITS: Readonly<ChainLimits> = Object.freeze({ maxSteps: 100, maxModelCalls: 50 });

export function normalizeChainOutcome(value: unknown): ChainOutcome | undefined {
	return value === "succeeded" || value === "failed" || value === "blocked" || value === "skipped" ? value : undefined;
}

interface SegmentToken {
	start: number;
	end: number;
	value: string;
	quoted: boolean;
}

function scanSegmentTokens(segment: string): SegmentToken[] {
	const tokens: SegmentToken[] = [];
	let i = 0;

	while (i < segment.length) {
		while (i < segment.length && /\s/.test(segment[i])) i++;
		if (i >= segment.length) break;

		const start = i;
		let inQuote: string | null = null;
		let value = "";
		let sawQuoted = false;
		let sawUnquoted = false;

		while (i < segment.length) {
			const char = segment[i];
			if (inQuote) {
				if (char === inQuote) {
					inQuote = null;
				} else {
					value += char;
				}
				i++;
				continue;
			}

			if (char === '"' || char === "'") {
				inQuote = char;
				sawQuoted = true;
				i++;
				continue;
			}
			if (/\s/.test(char)) break;

			value += char;
			sawUnquoted = true;
			i++;
		}

		tokens.push({
			start,
			end: i,
			value,
			quoted: sawQuoted && !sawUnquoted,
		});
	}

	return tokens;
}

function extractStepFlags(segment: string): { cleanedSegment: string; loopCount?: number | null; withContext: boolean } {
	const tokens = scanSegmentTokens(segment);
	const loopTokenRanges: Array<{ start: number; end: number }> = [];
	const withContextTokenRanges: Array<{ start: number; end: number }> = [];
	let loopCount: number | null | undefined;
	let withContext = false;

	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.quoted) continue;

		if (token.value === "--with-context") {
			withContext = true;
			withContextTokenRanges.push({ start: token.start, end: token.end });
			continue;
		}

		if (token.value.startsWith("--loop=")) {
			loopTokenRanges.push({ start: token.start, end: token.end });
			const value = token.value.slice("--loop=".length);
			if (!/^\d+$/.test(value)) continue;
			const parsed = parseInt(value, 10);
			if (parsed >= 1 && parsed <= 999 && loopCount === undefined) {
				loopCount = parsed;
			}
			continue;
		}

		if (token.value === "--loop") {
			loopTokenRanges.push({ start: token.start, end: token.end });
			if (i + 1 < tokens.length) {
				const next = tokens[i + 1];
				if (!next.quoted && /^\d+$/.test(next.value)) {
					loopTokenRanges.push({ start: next.start, end: next.end });
					const parsed = parseInt(next.value, 10);
					if (parsed >= 1 && parsed <= 999 && loopCount === undefined) {
						loopCount = parsed;
					}
					i++;
					continue;
				}
			}
			if (loopCount === undefined) {
				loopCount = null;
			}
			continue;
		}
	}

	const loopRangesToRemove = loopCount !== undefined ? loopTokenRanges : [];
	if (loopRangesToRemove.length === 0 && withContextTokenRanges.length === 0) {
		return { cleanedSegment: segment, withContext: false };
	}

	const rangesToRemove = [...loopRangesToRemove, ...withContextTokenRanges].sort((a, b) => b.start - a.start);
	let cleanedSegment = segment;
	for (const { start, end } of rangesToRemove) {
		cleanedSegment = `${cleanedSegment.slice(0, start)}${cleanedSegment.slice(end)}`;
	}

	return { cleanedSegment: cleanedSegment.trim(), loopCount, withContext };
}

function splitByTopLevelSeparator(input: string, separator: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let inQuote: string | null = null;
	let parenDepth = 0;

	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			continue;
		}

		if (char === '"' || char === "'") {
			inQuote = char;
			continue;
		}
		if (char === "(") {
			parenDepth++;
			continue;
		}
		if (char === ")" && parenDepth > 0) {
			parenDepth--;
			continue;
		}

		if (parenDepth === 0 && i <= input.length - separator.length && input.startsWith(separator, i)) {
			parts.push(input.slice(start, i));
			start = i + separator.length;
			i += separator.length - 1;
		}
	}

	parts.push(input.slice(start));
	return parts;
}

function findMatchingParen(segment: string, openIndex: number): number {
	let inQuote: string | null = null;
	let depth = 0;

	for (let i = openIndex; i < segment.length; i++) {
		const char = segment[i];
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			continue;
		}

		if (char === '"' || char === "'") {
			inQuote = char;
			continue;
		}
		if (char === "(") {
			depth++;
			continue;
		}
		if (char !== ")") continue;
		depth--;
		if (depth === 0) return i;
	}

	return -1;
}

function parseSingleStepSegment(segment: string): ChainStep | undefined {
	const { cleanedSegment, loopCount, withContext } = extractStepFlags(segment);
	const tokens = parseCommandArgs(cleanedSegment);
	if (tokens.length === 0) return undefined;
	return { name: tokens[0], args: tokens.slice(1), loopCount, ...(withContext ? { withContext: true } : {}) };
}

function parseParallelStepSegment(segment: string): ParallelChainStep | undefined {
	if (!/^parallel\s*\(/.test(segment)) return undefined;
	const openIndex = segment.indexOf("(");
	if (openIndex < 0) return undefined;

	const closeIndex = findMatchingParen(segment, openIndex);
	if (closeIndex < 0) return undefined;
	if (segment.slice(closeIndex + 1).trim().length > 0) return undefined;

	const inner = segment.slice(openIndex + 1, closeIndex).trim();
	if (!inner) return undefined;

	const parsedSteps: ChainStep[] = [];
	for (const rawEntry of splitByTopLevelSeparator(inner, ",")) {
		const entry = rawEntry.trim();
		if (!entry) return undefined;
		if (/^parallel\s*\(/.test(entry)) return undefined;
		const parsed = parseSingleStepSegment(entry);
		if (!parsed) return undefined;
		parsedSteps.push(parsed);
	}

	if (parsedSteps.length === 0) return undefined;
	return { parallel: parsedSteps };
}

function parseChainSegment(segment: string): ChainStepOrParallel | undefined {
	const parallelStep = parseParallelStepSegment(segment);
	if (parallelStep) return parallelStep;
	if (/^parallel\s*\(/.test(segment)) return undefined;
	return parseSingleStepSegment(segment);
}

export function parseChainSteps(args: string): ParsedChainSteps {
	const sharedArgsSplit = splitByTopLevelSeparator(args, " -- ");
	const templatesPart = sharedArgsSplit[0];
	const argsPart = sharedArgsSplit.length > 1 ? sharedArgsSplit.slice(1).join(" -- ") : "";

	const invalidSegments: string[] = [];
	const steps: ChainStepOrParallel[] = [];

	for (const rawSegment of splitByTopLevelSeparator(templatesPart, "->")) {
		const segment = rawSegment.trim();
		if (!segment) {
			invalidSegments.push(rawSegment);
			continue;
		}
		const parsedSegment = parseChainSegment(segment);
		if (!parsedSegment) {
			invalidSegments.push(segment);
			continue;
		}
		steps.push(parsedSegment);
	}

	return { steps, sharedArgs: parseCommandArgs(argsPart), invalidSegments };
}

function parseStructuredChainDeclaration(chain: unknown[], limitsValue?: unknown): ParsedStructuredChainDeclaration {
	const defaultLimits = (): ChainLimits => ({ ...DEFAULT_CHAIN_LIMITS });
	const fail = (message: string): ParsedStructuredChainDeclaration => ({ steps: [], limits: defaultLimits(), invalidSegments: [message] });
	let limits = defaultLimits();
	if (chain.length > MAX_CHAIN_LIMITS.maxSteps) return fail(`structured chain must contain no more than ${MAX_CHAIN_LIMITS.maxSteps} declared steps`);
	if (limitsValue !== undefined) {
		if (limitsValue === null || typeof limitsValue !== "object" || Array.isArray(limitsValue)) return fail("limits must be an object");
		const raw = limitsValue as Record<string, unknown>;
		for (const key of Object.keys(raw)) if (key !== "maxSteps" && key !== "maxModelCalls") return fail(`unknown limits field ${JSON.stringify(key)}`);
		const maxSteps = Object.hasOwn(raw, "maxSteps") ? raw.maxSteps : DEFAULT_CHAIN_LIMITS.maxSteps;
		const maxModelCalls = Object.hasOwn(raw, "maxModelCalls") ? raw.maxModelCalls : DEFAULT_CHAIN_LIMITS.maxModelCalls;
		if (!Number.isSafeInteger(maxSteps) || Number(maxSteps) < 1 || Number(maxSteps) > MAX_CHAIN_LIMITS.maxSteps) return fail(`limits.maxSteps must be a positive safe integer no greater than ${MAX_CHAIN_LIMITS.maxSteps}`);
		if (!Number.isSafeInteger(maxModelCalls) || Number(maxModelCalls) < 1 || Number(maxModelCalls) > MAX_CHAIN_LIMITS.maxModelCalls) return fail(`limits.maxModelCalls must be a positive safe integer no greater than ${MAX_CHAIN_LIMITS.maxModelCalls}`);
		limits = { maxSteps: Number(maxSteps), maxModelCalls: Number(maxModelCalls) };
	}
	if (chain.length === 0) return fail("structured chain must contain at least one step");
	const steps: StructuredChainStep[] = [];
	const allowed = new Set(["prompt", "run", "when", "onSuccess", "onFailure", "onBlocked"]);
	for (let index = 0; index < chain.length; index++) {
		const raw = chain[index];
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail(`step ${index + 1} must be an object`);
		const record = raw as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (!allowed.has(key)) return fail(key.startsWith("on") ? `unknown outcome transition ${JSON.stringify(key)}` : `unknown structured chain field ${JSON.stringify(key)}`);
		}
		const hasPrompt = Object.hasOwn(record, "prompt");
		const hasRun = Object.hasOwn(record, "run");
		if (hasPrompt === hasRun) return fail(`step ${index + 1} must set exactly one of prompt or run`);
		const kind = hasPrompt ? "prompt" : "run";
		const targetValue = record[kind];
		if (typeof targetValue !== "string" || targetValue.trim() === "") return fail(`step ${index + 1} ${kind} target must be a non-empty string`);
		const target = targetValue.trim();
		const when = Object.hasOwn(record, "when") ? record.when : "always";
		if (when !== "always" && when !== "changed" && when !== "succeeded" && when !== "failed") return fail(`step ${index + 1} has unknown gate ${JSON.stringify(when)}`);
		const step: StructuredChainStep = { id: target, kind, target, when };
		for (const key of ["onSuccess", "onFailure", "onBlocked"] as const) {
			if (record[key] === undefined) continue;
			if (typeof record[key] !== "string" || record[key].trim() === "") return fail(`step ${index + 1} ${key} target must be a non-empty string`);
			step[key] = record[key].trim();
		}
		steps.push(step);
	}
	const ids = new Set<string>();
	for (const step of steps) {
		if (ids.has(step.id)) return fail(`duplicate structured chain target ${JSON.stringify(step.id)}`);
		ids.add(step.id);
	}
	const edges = new Map<string, string[]>();
	for (let index = 0; index < steps.length; index++) {
		const step = steps[index];
		const targets = [step.onSuccess, step.onFailure, step.onBlocked].filter((target): target is string => target !== undefined);
		for (const target of targets) {
			if (!ids.has(target)) return fail(`step ${JSON.stringify(step.id)} references unknown target ${JSON.stringify(target)}`);
			if (target === step.id) return fail(`step ${JSON.stringify(step.id)} has a self-transition`);
		}
		if ((targets.length < 3 || step.when !== "always") && index + 1 < steps.length) targets.push(steps[index + 1].id);
		edges.set(step.id, [...new Set(targets)]);
	}
	const visiting = new Set<string>(); const visited = new Set<string>();
	const cyclic = (id: string): boolean => { if (visiting.has(id)) return true; if (visited.has(id)) return false; visiting.add(id); for (const next of edges.get(id) ?? []) if (cyclic(next)) return true; visiting.delete(id); visited.add(id); return false; };
	if (cyclic(steps[0].id)) return fail("structured chain contains a cycle");
	const reachable = new Set<string>();
	const visit = (id: string) => { if (reachable.has(id)) return; reachable.add(id); for (const next of edges.get(id) ?? []) visit(next); };
	visit(steps[0].id);
	const unreachable = steps.find((step) => !reachable.has(step.id));
	if (unreachable) return fail(`structured chain has unreachable target ${JSON.stringify(unreachable.id)}`);
	return { steps, limits, invalidSegments: [] };
}

export function parseChainDeclaration(chain: string): ParsedChainDeclaration;
export function parseChainDeclaration(chain: unknown[], limits?: unknown): ParsedStructuredChainDeclaration;
export function parseChainDeclaration(chain: string | unknown[], limits?: unknown): ParsedChainDeclaration | ParsedStructuredChainDeclaration;
export function parseChainDeclaration(chain: string | unknown[], limits?: unknown): ParsedChainDeclaration | ParsedStructuredChainDeclaration {
	if (Array.isArray(chain)) return parseStructuredChainDeclaration(chain, limits);
	const invalidSegments: string[] = [];
	const steps: ChainStepOrParallel[] = [];

	for (const rawSegment of splitByTopLevelSeparator(chain, "->")) {
		const segment = rawSegment.trim();
		if (!segment) {
			invalidSegments.push(rawSegment);
			continue;
		}
		const parsedSegment = parseChainSegment(segment);
		if (!parsedSegment) {
			invalidSegments.push(segment);
			continue;
		}
		steps.push(parsedSegment);
	}

	return { steps, invalidSegments };
}
