export interface LoopExtraction {
	args: string;
	loopCount: number | null;
	fresh: boolean;
	converge: boolean;
}

export interface LoopFlags {
	args: string;
	fresh: boolean;
	converge: boolean;
}

export interface SubagentOverride {
	enabled: true;
	agent?: string;
}

export interface SubagentOverrideExtraction {
	args: string;
	override?: SubagentOverride;
	cwd?: string;
	model?: string;
	fork?: boolean;
}

export const REMOVED_LEGACY_RUNTIME_FLAGS = [
	"--worktree",
	"--preset",
	"--workers",
	"--workers-append",
	"--reviewers",
	"--reviewers-append",
	"--final-applier",
	"--keep-artifacts",
] as const;

export function findRemovedLegacyRuntimeFlag(argsString: string): string | undefined {
	for (const token of parseCommandArgTokens(argsString)) {
		if (token.firstCharacterQuoted) continue;
		for (const flag of REMOVED_LEGACY_RUNTIME_FLAGS) {
			if (token.value === flag || token.value.startsWith(`${flag}=`)) return flag;
		}
	}
	return undefined;
}

export function extractLoopCount(argsString: string): LoopExtraction | null {
	let loopCount: number | null = null;
	let loopFound = false;
	let fresh = false;
	let noConverge = false;
	const tokensToRemove: Array<{ start: number; end: number }> = [];
	const loopTokenRanges: Array<{ start: number; end: number }> = [];

	let i = 0;
	while (i < argsString.length) {
		const char = argsString[i];

		if (char === '"' || char === "'") {
			const quote = char;
			i++;
			while (i < argsString.length && argsString[i] !== quote) i++;
			if (i < argsString.length) i++;
			continue;
		}

		if (/\s/.test(char)) {
			i++;
			continue;
		}

		const tokenStart = i;
		while (i < argsString.length && !/\s/.test(argsString[i])) i++;
		const token = argsString.slice(tokenStart, i);

		if (token.startsWith("--loop=")) {
			loopTokenRanges.push({ start: tokenStart, end: i });
			const value = token.slice("--loop=".length);
			if (/^\d+$/.test(value)) {
				const parsed = parseInt(value, 10);
				if (parsed >= 1 && parsed <= 999 && !loopFound) {
					loopFound = true;
					loopCount = parsed;
				}
			}
			continue;
		}

		if (token === "--loop") {
			let lookahead = i;
			while (lookahead < argsString.length && /\s/.test(argsString[lookahead])) lookahead++;

			if (lookahead < argsString.length && argsString[lookahead] !== '"' && argsString[lookahead] !== "'") {
				const nextTokenStart = lookahead;
				while (lookahead < argsString.length && !/\s/.test(argsString[lookahead])) lookahead++;
				const nextToken = argsString.slice(nextTokenStart, lookahead);

				if (/^\d+$/.test(nextToken)) {
					loopTokenRanges.push({ start: tokenStart, end: i }, { start: nextTokenStart, end: lookahead });
					const parsed = parseInt(nextToken, 10);
					if (parsed >= 1 && parsed <= 999 && !loopFound) {
						loopFound = true;
						loopCount = parsed;
					}
					i = lookahead;
					continue;
				}
			}

			loopTokenRanges.push({ start: tokenStart, end: i });
			if (!loopFound) {
				loopFound = true;
				loopCount = null;
			}
			continue;
		}

		if (token === "--fresh") {
			fresh = true;
			tokensToRemove.push({ start: tokenStart, end: i });
		}

		if (token === "--no-converge") {
			noConverge = true;
			tokensToRemove.push({ start: tokenStart, end: i });
		}
	}

	if (!loopFound) return null;

	const allRanges = [...tokensToRemove, ...loopTokenRanges];
	allRanges.sort((a, b) => b.start - a.start);
	let cleaned = argsString;
	for (const { start, end } of allRanges) {
		cleaned = cleaned.slice(0, start) + cleaned.slice(end);
	}

	const converge = !noConverge;
	return { args: cleaned.trim(), loopCount, fresh, converge };
}

export function extractLoopFlags(argsString: string): LoopFlags {
	let fresh = false;
	let noConverge = false;
	const tokensToRemove: Array<{ start: number; end: number }> = [];

	let i = 0;
	while (i < argsString.length) {
		const char = argsString[i];

		if (char === '"' || char === "'") {
			const quote = char;
			i++;
			while (i < argsString.length && argsString[i] !== quote) i++;
			if (i < argsString.length) i++;
			continue;
		}

		if (/\s/.test(char)) {
			i++;
			continue;
		}

		const tokenStart = i;
		while (i < argsString.length && !/\s/.test(argsString[i])) i++;
		const token = argsString.slice(tokenStart, i);

		if (token === "--fresh") {
			fresh = true;
			tokensToRemove.push({ start: tokenStart, end: i });
		}

		if (token === "--no-converge") {
			noConverge = true;
			tokensToRemove.push({ start: tokenStart, end: i });
		}
	}

	tokensToRemove.sort((a, b) => b.start - a.start);
	let cleaned = argsString;
	for (const { start, end } of tokensToRemove) {
		cleaned = cleaned.slice(0, start) + cleaned.slice(end);
	}

	return { args: cleaned.trim(), fresh, converge: !noConverge };
}

function extractBooleanFlag(argsString: string, flag: string): { args: string; found: boolean } {
	let found = false;
	const tokensToRemove: Array<{ start: number; end: number }> = [];

	let i = 0;
	while (i < argsString.length) {
		const char = argsString[i];

		if (char === '"' || char === "'") {
			const quote = char;
			i++;
			while (i < argsString.length && argsString[i] !== quote) i++;
			if (i < argsString.length) i++;
			continue;
		}

		if (/\s/.test(char)) {
			i++;
			continue;
		}

		const tokenStart = i;
		while (i < argsString.length && !/\s/.test(argsString[i])) i++;
		const token = argsString.slice(tokenStart, i);

		if (token === flag) {
			found = true;
			tokensToRemove.push({ start: tokenStart, end: i });
		}
	}

	if (tokensToRemove.length === 0) {
		return { args: argsString.trim(), found: false };
	}

	tokensToRemove.sort((a, b) => b.start - a.start);
	let cleaned = argsString;
	for (const { start, end } of tokensToRemove) {
		cleaned = cleaned.slice(0, start) + cleaned.slice(end);
	}

	return { args: cleaned.trim(), found };
}

export function extractChainContextFlag(argsString: string): { args: string; chainContext: boolean } {
	const { args, found } = extractBooleanFlag(argsString, "--chain-context");
	return { args, chainContext: found };
}

function readSpaceSeparatedFlagValue(argsString: string, valueStart: number): { value: string; end: number } | null {
	let i = valueStart;
	while (i < argsString.length && /\s/.test(argsString[i])) i++;
	if (i >= argsString.length) return null;

	const char = argsString[i];
	if (char === '"' || char === "'") {
		const quote = char;
		let end = i + 1;
		let value = "";
		while (end < argsString.length) {
			const current = argsString[end];
			if (current === "\\" && end + 1 < argsString.length) {
				value += argsString[end + 1];
				end += 2;
				continue;
			}
			if (current === quote) return { value, end: end + 1 };
			value += current;
			end++;
		}
		return { value, end };
	}

	const start = i;
	while (i < argsString.length && !/\s/.test(argsString[i])) i++;
	const value = argsString.slice(start, i);
	if (!value || value.startsWith("--")) return null;
	return { value, end: i };
}

export function extractSubagentOverride(argsString: string): SubagentOverrideExtraction {
	let override: SubagentOverride | undefined;
	let cwdRaw: string | undefined;
	let modelRaw: string | undefined;
	let fork = false;
	const tokensToRemove: Array<{ start: number; end: number }> = [];

	let i = 0;
	while (i < argsString.length) {
		const char = argsString[i];

		if (char === '"' || char === "'") {
			const quote = char;
			i++;
			while (i < argsString.length && argsString[i] !== quote) i++;
			if (i < argsString.length) i++;
			continue;
		}

		if (/\s/.test(char)) {
			i++;
			continue;
		}

		const tokenStart = i;
		while (i < argsString.length && !/\s/.test(argsString[i])) i++;
		const token = argsString.slice(tokenStart, i);

		if (token === "--subagent") {
			tokensToRemove.push({ start: tokenStart, end: i });
			override = { enabled: true };
			continue;
		}

		if (token.startsWith("--subagent=") || token.startsWith("--subagent:")) {
			tokensToRemove.push({ start: tokenStart, end: i });
			const value = token.includes("=") ? token.slice("--subagent=".length) : token.slice("--subagent:".length);
			override = value ? { enabled: true, agent: value } : { enabled: true };
			continue;
		}

		if (token.startsWith("--cwd=")) {
			tokensToRemove.push({ start: tokenStart, end: i });
			const value = token.slice("--cwd=".length);
			cwdRaw = value || undefined;
			continue;
		}

		if (token === "--cwd") {
			const parsed = readSpaceSeparatedFlagValue(argsString, i);
			if (parsed) {
				tokensToRemove.push({ start: tokenStart, end: i }, { start: i, end: parsed.end });
				cwdRaw = parsed.value || undefined;
				i = parsed.end;
				continue;
			}
			tokensToRemove.push({ start: tokenStart, end: i });
			continue;
		}

		if (token.startsWith("--model=")) {
			tokensToRemove.push({ start: tokenStart, end: i });
			const value = token.slice("--model=".length);
			modelRaw = value || undefined;
			continue;
		}

		if (token === "--model") {
			const parsed = readSpaceSeparatedFlagValue(argsString, i);
			if (parsed) {
				tokensToRemove.push({ start: tokenStart, end: i }, { start: i, end: parsed.end });
				modelRaw = parsed.value || undefined;
				i = parsed.end;
				continue;
			}
			tokensToRemove.push({ start: tokenStart, end: i });
			continue;
		}

		if (token === "--fork") {
			tokensToRemove.push({ start: tokenStart, end: i });
			fork = true;
			continue;
		}
	}

	if (tokensToRemove.length === 0) return { args: argsString.trim() };

	tokensToRemove.sort((a, b) => b.start - a.start);
	let cleaned = argsString;
	for (const { start, end } of tokensToRemove) {
		cleaned = cleaned.slice(0, start) + cleaned.slice(end);
	}

	if (fork && !override) override = { enabled: true };

	return {
		args: cleaned.trim(),
		...(override ? { override } : {}),
		...(cwdRaw !== undefined ? { cwd: cwdRaw } : {}),
		...(modelRaw !== undefined ? { model: modelRaw } : {}),
		...(fork ? { fork: true } : {}),
	};
}

export function splitByUnquotedSeparator(input: string, separator: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let inQuote: string | null = null;

	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (inQuote) {
			if (char === inQuote) inQuote = null;
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (i <= input.length - separator.length && input.startsWith(separator, i)) {
			parts.push(input.slice(start, i));
			start = i + separator.length;
			i += separator.length - 1;
		}
	}

	parts.push(input.slice(start));
	return parts;
}

export function splitRawArgsAtBoundary(argsString: string): { before: string; after: string[] } {
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < argsString.length; i++) {
		const c = argsString[i];
		if (quote) {
			if (c === "\\" && quote === '"') i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") { quote = c; continue; }
		if (c === "-" && argsString.slice(i, i + 2) === "--" && (i === 0 || /\s/.test(argsString[i - 1])) && (i + 2 === argsString.length || /\s/.test(argsString[i + 2]))) {
			const before = argsString.slice(0, i).trim();
			const after = parseCommandArgs(argsString.slice(i + 2));
			return { before, after };
		}
	}
	return { before: argsString, after: [] };
}

interface CommandArgToken {
	value: string;
	firstCharacterQuoted: boolean;
}

function parseCommandArgTokens(argsString: string): CommandArgToken[] {
	const args: CommandArgToken[] = [];
	let current = "";
	let inQuote: string | null = null;
	let firstCharacterQuoted = false;
	const append = (value: string, fromQuote: boolean) => {
		if (!value) return;
		if (!current) firstCharacterQuoted = fromQuote;
		current += value;
	};

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === "\\" && inQuote === '"' && (argsString[i + 1] === '"' || argsString[i + 1] === "\\")) {
				append(argsString[i + 1], true);
				i += 1;
			} else if (char === inQuote) {
				inQuote = null;
			} else {
				append(char, true);
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (/\s/.test(char)) {
			if (current) {
				args.push({ value: current, firstCharacterQuoted });
				current = "";
				firstCharacterQuoted = false;
			}
		} else {
			append(char, false);
		}
	}

	if (current) {
		args.push({ value: current, firstCharacterQuoted });
	}

	return args;
}

export function parseCommandArgs(argsString: string): string[] {
	return parseCommandArgTokens(argsString).map((token) => token.value);
}

export function substituteArgs(content: string, args: string[]): string {
	let result = content;

	result = result.replace(/\$(\d+)/g, (_, num) => {
		const index = parseInt(num, 10) - 1;
		return args[index] ?? "";
	});

	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;

		if (lengthStr) {
			const length = parseInt(lengthStr, 10);
			return args.slice(start, start + length).join(" ");
		}

		return args.slice(start).join(" ");
	});

	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	result = result.replace(/@\$/g, allArgs);

	return result;
}
