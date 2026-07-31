export type PromptInputType = "string" | "choice" | "boolean";

export interface PromptInputDefinition {
	type: PromptInputType;
	required?: boolean;
	default?: string | boolean;
	options?: string[];
	description?: string;
}

export type PromptInputSchema = Record<string, PromptInputDefinition>;

export interface ResolvedPromptInput {
	name: string;
	type: PromptInputType;
	value: string | boolean;
	source: "default" | "flag" | "interactive";
}

export interface ResolvePromptInputsResult {
	values: Record<string, ResolvedPromptInput>;
	positional: string[];
	errors: string[];
}

const INPUT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// This is deliberately explicit. Add a spelling here when a runtime extractor is added.
export const RUNTIME_FLAG_ALIASES = new Set([
	"--loop", "--fresh", "--converge", "--no-converge", "--chain-context", "--worktree",
	"--subagent", "--fork", "--cwd", "--model", "--preset", "--plain",
	"--tui", "--show-skills", "--keep-artifacts", "--id", "--run",
	"--limit", "--with-context", "--workers", "--workers-append", "--reviewers", "--reviewers-append", "--final-applier", "--final-applier-append",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flagAliases(name: string, type: PromptInputType): string[] {
	return type === "boolean" ? [`--${name}`, `--no-${name}`] : [`--${name}`];
}

export function validatePromptInputSchema(schema: unknown): string[] {
	const errors: string[] = [];
	if (!isRecord(schema)) return ["inputs must be a mapping"];
	const aliases = new Map<string, string>();
	for (const [name, raw] of Object.entries(schema)) {
		if (!INPUT_NAME.test(name)) {
			errors.push(`input name ${JSON.stringify(name)} must be kebab-case`);
			continue;
		}
		if (!isRecord(raw)) {
			errors.push(`input ${JSON.stringify(name)} must be a mapping`);
			continue;
		}
		const type = raw.type;
		if (type !== "string" && type !== "choice" && type !== "boolean") {
			errors.push(`input ${JSON.stringify(name)} has unsupported type`);
			continue;
		}
		for (const alias of flagAliases(name, type)) {
			const owner = aliases.get(alias);
			if (owner) errors.push(`input ${JSON.stringify(name)} flag ${alias} collides with input ${JSON.stringify(owner)}`);
			else if (RUNTIME_FLAG_ALIASES.has(alias)) errors.push(`input ${JSON.stringify(name)} flag ${alias} collides with a runtime flag`);
			else aliases.set(alias, name);
		}
		if (raw.required !== undefined && typeof raw.required !== "boolean") errors.push(`input ${JSON.stringify(name)} required must be boolean`);
		if (raw.required === true && raw.default !== undefined) errors.push(`input ${JSON.stringify(name)} cannot be both required and have a default`);
		if (type === "boolean") {
			if (typeof raw.default !== "boolean") errors.push(`boolean input ${JSON.stringify(name)} requires a boolean default`);
		} else if (raw.required !== true && raw.default === undefined) {
			errors.push(`input ${JSON.stringify(name)} must be required or have a default`);
		}
		if (type === "choice") {
			if (!Array.isArray(raw.options) || raw.options.length === 0 || raw.options.some((option) => typeof option !== "string")) {
				errors.push(`choice input ${JSON.stringify(name)} options must be a non-empty list of strings`);
			} else if (new Set(raw.options).size !== raw.options.length) {
				errors.push(`choice input ${JSON.stringify(name)} options must be unique`);
			} else if (raw.default !== undefined && (typeof raw.default !== "string" || !raw.options.includes(raw.default))) {
				errors.push(`choice input ${JSON.stringify(name)} default must be one of its options`);
			}
		}
		if (type === "string" && raw.default !== undefined && typeof raw.default !== "string") errors.push(`string input ${JSON.stringify(name)} default must be a string`);
		if (type === "boolean" && raw.required === true) errors.push(`boolean input ${JSON.stringify(name)} cannot be required; give it a default`);
	}
	for (const name of Object.keys(schema)) {
		if (!INPUT_NAME.test(name)) continue;
		const positive = `--${name}`;
		const negative = `--no-${name}`;
		const other = schema[`no-${name}`] ? `no-${name}` : undefined;
		if (other) errors.push(`input ${JSON.stringify(name)} flag ${positive} collides with input ${JSON.stringify(other)}`);
		if (name.startsWith("no-") && RUNTIME_FLAG_ALIASES.has(`--${name.slice(3)}`)) errors.push(`input ${JSON.stringify(name)} flag ${positive} collides with a runtime flag`);
		if (RUNTIME_FLAG_ALIASES.has(positive) || RUNTIME_FLAG_ALIASES.has(negative)) errors.push(`input ${JSON.stringify(name)} flag aliases collide with a runtime flag`);
	}
	return errors;
}

function parseOptionTokens(tokens: string[], schema: PromptInputSchema): { options: string[]; positional: string[]; errors: string[] } {
	const options: string[] = [];
	const positional: string[] = [];
	const errors: string[] = [];
	let afterBoundary = false;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (afterBoundary) { positional.push(token); continue; }
		if (token === "--") { afterBoundary = true; continue; }
		if (token.startsWith("--")) {
			options.push(token);
			const equals = token.indexOf("=");
			const rawName = equals === -1 ? token : token.slice(0, equals);
			const isNegative = rawName.startsWith("--no-");
			const name = isNegative ? rawName.slice(5) : rawName.slice(2);
			const definition = Object.prototype.hasOwnProperty.call(schema, name) ? schema[name] : undefined;
			if (isNegative && definition && definition.type !== "boolean") errors.push(`input ${JSON.stringify(name)} does not support a negative alias`);
			if (definition && definition.type !== "boolean" && equals === -1) {
				const next = tokens[index + 1];
				if (next !== undefined && next !== "--" && !next.startsWith("--")) { options.push(next); index++; }
			}
		} else positional.push(token);
	}
	return { options, positional, errors };
}

export function inputModeEligibilityError(prompt: {
	inputs?: PromptInputSchema;
	chain?: unknown;
	loop?: unknown;
	workers?: unknown;
	reviewers?: unknown;
	finalApplier?: unknown;
	preset?: unknown;
	deterministic?: unknown;
	subagent?: unknown;
	parallel?: unknown;
}): string | undefined {
	if (!prompt.inputs) return undefined;
	if (prompt.chain || prompt.loop !== undefined || prompt.workers || prompt.reviewers || prompt.finalApplier || prompt.preset || prompt.deterministic || prompt.subagent || prompt.parallel) {
		return "Prompt inputs are only supported on ordinary prompts without loops, chains, delegation, compare, or deterministic execution";
	}
	return undefined;
}

export function resolvePromptInputs(schema: PromptInputSchema, args: string[]): ResolvePromptInputsResult {
	const schemaErrors = validatePromptInputSchema(schema);
	if (schemaErrors.length > 0) return { values: {}, positional: args, errors: schemaErrors };
	const inputArgs = parseOptionTokens(args, schema);
	const values: Record<string, ResolvedPromptInput> = Object.create(null);
	const seen = new Set<string>();
	const definitions = schema;
	for (const [name, definition] of Object.entries(definitions)) {
		if (definition.default !== undefined) values[name] = { name, type: definition.type, value: definition.default, source: "default" };
	}
	for (let index = 0; index < inputArgs.options.length; index++) {
		const token = inputArgs.options[index];
		const equals = token.indexOf("=");
		const rawName = equals === -1 ? token : token.slice(0, equals);
		const name = rawName.startsWith("--no-") ? rawName.slice(5) : rawName.slice(2);
		const definition = Object.prototype.hasOwnProperty.call(definitions, name) ? definitions[name] : undefined;
		if (!definition) { inputArgs.errors.push(`unknown option ${token}`); continue; }
		if (seen.has(name)) { inputArgs.errors.push(`duplicate input ${JSON.stringify(name)}`); continue; }
		seen.add(name);
		let rawValue: string | boolean;
		if (definition.type === "boolean") {
			if (rawName.startsWith("--no-") && equals !== -1) { inputArgs.errors.push(`negative boolean input ${JSON.stringify(name)} cannot take a value`); continue; }
			rawValue = rawName.startsWith("--no-") ? false : equals === -1 ? true : token.slice(equals + 1);
			if (rawValue !== true && rawValue !== false && rawValue !== "true" && rawValue !== "false") inputArgs.errors.push(`input ${JSON.stringify(name)} must be true or false`);
			else values[name] = { name, type: definition.type, value: rawValue === true || rawValue === "true", source: "flag" };
			continue;
		}
		rawValue = equals === -1 ? inputArgs.options[++index] : token.slice(equals + 1);
		if (equals === -1 && typeof rawValue === "string" && rawValue.startsWith("--")) {
			inputArgs.errors.push(`missing value for input ${JSON.stringify(name)}`);
			index--;
			continue;
		}
		if (rawValue === undefined) { inputArgs.errors.push(`missing value for input ${JSON.stringify(name)}`); continue; }
		if (definition.type === "choice" && !definition.options?.includes(rawValue as string)) inputArgs.errors.push(`invalid value for input ${JSON.stringify(name)}: ${JSON.stringify(rawValue)}`);
		else values[name] = { name, type: definition.type, value: rawValue, source: "flag" };
	}
	for (const [name, definition] of Object.entries(definitions)) if (!Object.prototype.hasOwnProperty.call(values, name) && definition.required) inputArgs.errors.push(`missing required input ${JSON.stringify(name)}`);
	return { values, positional: inputArgs.positional, errors: inputArgs.errors };
}

export function validatePromptInputReferences(content: string, schema: PromptInputSchema): string[] {
	const errors: string[] = [];
	const names = new Set(Object.keys(schema));
	const references = [...content.matchAll(/\$\{input\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\}|<if-input\s+name="([a-z][a-z0-9]*(?:-[a-z0-9]+)*)"/g)];
	for (const match of references) {
		const name = match[1] ?? match[2];
		if (!names.has(name)) errors.push(`input reference "${name}" is not declared`);
	}
	if (content.includes("<if-input") && !content.includes("</if-input>")) errors.push("missing closing </if-input> tag");
	if (content.includes("</if-input>") && !content.includes("<if-input")) errors.push("closing </if-input> tag has no opening tag");
	return [...new Set(errors)];
}

export function renderPromptInputConditionals(content: string, values: Record<string, ResolvedPromptInput>): { content: string; error?: string } {
	if (!content.includes("<if-input")) return { content };
	const open = /<if-input\s+name="([a-z][a-z0-9]*(?:-[a-z0-9]+)*)"\s+is="([^"]*)">/g;
	const stack: Array<{ start: number; name: string; expected: string; elseAt?: number }> = [];
	const replacements: Array<{ start: number; end: number; value: string }> = [];
	let cursor = 0;
	while (cursor < content.length) {
		const nextOpen = content.indexOf("<if-input", cursor);
		const nextElse = content.indexOf("<else>", cursor);
		const nextClose = content.indexOf("</if-input>", cursor);
		const candidates = [nextOpen, nextElse, nextClose].filter((index) => index >= 0);
		if (candidates.length === 0) break;
		const index = Math.min(...candidates);
		if (index === nextOpen) {
			open.lastIndex = index;
			const match = open.exec(content);
			if (!match || match.index !== index) return { content, error: "Invalid <if-input> opening tag." };
			stack.push({ start: index, name: match[1], expected: match[2] });
			cursor = index + match[0].length;
		} else if (index === nextElse) {
			const frame = stack[stack.length - 1];
			if (!frame || frame.elseAt !== undefined) return { content, error: "Invalid <else> in <if-input> markup." };
			frame.elseAt = index;
			cursor = index + 6;
		} else {
			const frame = stack.pop();
			if (!frame) return { content, error: "Closing </if-input> without a matching opening tag." };
			const closeEnd = index + "</if-input>".length;
			const bodyStart = frame.start + content.slice(frame.start, cursor).indexOf(">") + 1;
			const truthyEnd = frame.elseAt ?? index;
			const truthyRaw = content.slice(bodyStart, truthyEnd);
			const falsyRaw = frame.elseAt === undefined ? "" : content.slice(frame.elseAt + 6, index);
			const truthy = renderPromptInputConditionals(truthyRaw, values);
			const falsy = renderPromptInputConditionals(falsyRaw, values);
			if (truthy.error || falsy.error) return { content, error: truthy.error ?? falsy.error };
			const actual = values[frame.name]?.value;
			const canonical = actual === undefined ? undefined : String(actual);
			replacements.push({ start: frame.start, end: closeEnd, value: canonical === frame.expected ? truthy.content : falsy.content });
			cursor = closeEnd;
		}
	}
	if (stack.length > 0) return { content, error: "Missing closing </if-input> tag." };
	for (const replacement of replacements.sort((a, b) => b.start - a.start)) content = content.slice(0, replacement.start) + replacement.value + content.slice(replacement.end);
	return { content };
}

export function renderPromptInputValues(content: string, values: Record<string, ResolvedPromptInput>): string {
	const conditionals = renderPromptInputConditionals(content, values);
	if (conditionals.error) throw new Error(`Invalid <if-input> markup: ${conditionals.error}`);
	return conditionals.content.replace(/\$\{input\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\}/g, (match, name: string) => {
		const value = values[name]?.value;
		return value === undefined ? match : String(value);
	});
}
