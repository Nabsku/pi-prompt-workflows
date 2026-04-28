export interface ResolvedModelRef {
	provider: string;
	id: string;
}

type Node =
	| { type: "text"; value: string }
	| { type: "if"; specs: string[]; truthy: Node[]; falsy: Node[] };

type OpenToken = { type: "open"; specs: string[] };
type ElseToken = { type: "else" };
type CloseToken = { type: "close" };
type Token = OpenToken | ElseToken | CloseToken;

interface ParseError {
	message: string;
}

interface ParseSuccess {
	ok: true;
	nodes: Node[];
}

interface ParseFailure {
	ok: false;
	error: ParseError;
}

type ParseResult = ParseSuccess | ParseFailure;

interface StackFrame {
	specs: string[];
	truthy: Node[];
	falsy: Node[];
	inElse: boolean;
}

export interface RenderConditionalsResult {
	content: string;
	error?: string;
}

function isValidSpec(spec: string): boolean {
	if (!spec || /\s/.test(spec)) return false;
	if (spec.includes("*")) {
		const segments = spec.split("/");
		return segments.length === 2 && segments[0].length > 0 && segments[1] === "*";
	}

	const slashIndex = spec.indexOf("/");
	if (slashIndex === -1) return true;
	if (slashIndex === 0) return false;
	const modelId = spec.slice(slashIndex + 1);
	if (modelId.length === 0) return false;
	if (modelId.split("/").some((segment) => segment.length === 0)) return false;
	return true;
}

function matchSpec(spec: string, model: ResolvedModelRef): boolean {
	if (spec === `${model.provider}/${model.id}`) return true;
	if (spec === model.id) return true;
	if (spec === `${model.provider}/*`) return true;
	return false;
}

function parseIfModelTag(tagContent: string): OpenToken | ParseFailure {
	let cursor = 0;
	const attributes = new Map<string, string>();

	while (cursor < tagContent.length) {
		while (cursor < tagContent.length && /\s/.test(tagContent[cursor])) cursor++;
		if (cursor >= tagContent.length) break;

		const nameStart = cursor;
		while (cursor < tagContent.length && /[a-z-]/.test(tagContent[cursor])) cursor++;
		if (nameStart === cursor) {
			return { ok: false, error: { message: 'Invalid `<if-model>` attribute syntax.' } };
		}

		const name = tagContent.slice(nameStart, cursor);
		while (cursor < tagContent.length && /\s/.test(tagContent[cursor])) cursor++;
		if (tagContent[cursor] !== "=") {
			return { ok: false, error: { message: `Attribute "${name}" in \`<if-model>\` must use =.` } };
		}
		cursor++;
		while (cursor < tagContent.length && /\s/.test(tagContent[cursor])) cursor++;
		if (tagContent[cursor] !== '"') {
			return { ok: false, error: { message: `Attribute "${name}" in \`<if-model>\` must use double quotes.` } };
		}
		cursor++;
		const valueStart = cursor;
		while (cursor < tagContent.length && tagContent[cursor] !== '"') cursor++;
		if (cursor >= tagContent.length) {
			return { ok: false, error: { message: 'Unterminated quoted attribute in `<if-model>`.' } };
		}
		const value = tagContent.slice(valueStart, cursor);
		cursor++;

		if (attributes.has(name)) {
			return { ok: false, error: { message: `Duplicate attribute "${name}" in \`<if-model>\`.` } };
		}
		attributes.set(name, value);
	}

	if (!attributes.has("is")) {
		return { ok: false, error: { message: '`<if-model>` requires an `is` attribute.' } };
	}

	for (const name of attributes.keys()) {
		if (name !== "is") {
			return { ok: false, error: { message: `Unknown attribute "${name}" in \`<if-model>\`.` } };
		}
	}

	const specs = attributes
		.get("is")!
		.split(",")
		.map((spec) => spec.trim())
		.filter(Boolean);

	if (specs.length === 0) {
		return { ok: false, error: { message: '`<if-model>` must declare at least one model spec.' } };
	}

	for (const spec of specs) {
		if (!isValidSpec(spec)) {
			return { ok: false, error: { message: `Invalid model spec ${JSON.stringify(spec)} in \`<if-model>\`.` } };
		}
	}

	return { type: "open", specs };
}

function isDirectiveBoundaryChar(char: string | undefined): boolean {
	return char === undefined || char === ">" || /\s/.test(char);
}

function readToken(input: string, index: number): { token: Token; length: number } | ParseFailure | undefined {
	if (input.startsWith("</if-model>", index)) {
		return { token: { type: "close" }, length: "</if-model>".length };
	}

	if (input.startsWith("</if-model", index) && isDirectiveBoundaryChar(input[index + "</if-model".length])) {
		return { ok: false, error: { message: '`</if-model>` cannot have attributes or extra characters.' } };
	}

	if (input.startsWith("<else>", index)) {
		return { token: { type: "else" }, length: "<else>".length };
	}

	if (input.startsWith("<else", index) && isDirectiveBoundaryChar(input[index + "<else".length])) {
		return { ok: false, error: { message: '`<else>` cannot have attributes or extra characters.' } };
	}

	// Reject </else> - it's not valid syntax (else is a separator, not a container)
	if (input.startsWith("</else>", index)) {
		return { ok: false, error: { message: '`</else>` is not valid. `<else>` is a separator, not a container - use `<else>content</if-model>` instead.' } };
	}

	if (input.startsWith("</else", index) && isDirectiveBoundaryChar(input[index + "</else".length])) {
		return { ok: false, error: { message: '`</else>` is not valid. `<else>` is a separator, not a container - use `<else>content</if-model>` instead.' } };
	}

	if (!input.startsWith("<if-model", index)) {
		return undefined;
	}

	const closeIndex = input.indexOf(">", index);
	if (closeIndex === -1) {
		return { ok: false, error: { message: 'Missing closing `>` for `<if-model>`.' } };
	}

	const nextChar = input[index + "<if-model".length];
	if (nextChar !== undefined && nextChar !== ">" && !/\s/.test(nextChar)) {
		return undefined;
	}

	const tagContent = input.slice(index + "<if-model".length, closeIndex);
	const parsed = parseIfModelTag(tagContent);
	if ("ok" in parsed && !parsed.ok) {
		return parsed;
	}

	return { token: parsed as OpenToken, length: closeIndex - index + 1 };
}

function appendNode(stack: StackFrame[], root: Node[], node: Node) {
	const frame = stack[stack.length - 1];
	if (!frame) {
		root.push(node);
		return;
	}

	if (frame.inElse) {
		frame.falsy.push(node);
	} else {
		frame.truthy.push(node);
	}
}

function parseNodes(input: string): ParseResult {
	const root: Node[] = [];
	const stack: StackFrame[] = [];
	let cursor = 0;
	let textStart = 0;

	while (cursor < input.length) {
		if (input[cursor] !== "<") {
			cursor++;
			continue;
		}

		const tokenResult = readToken(input, cursor);
		if (!tokenResult) {
			cursor++;
			continue;
		}
		if ("ok" in tokenResult && !tokenResult.ok) {
			return tokenResult;
		}

		if (textStart < cursor) {
			appendNode(stack, root, { type: "text", value: input.slice(textStart, cursor) });
		}

		const { token, length } = tokenResult as { token: Token; length: number };
		if (token.type === "open") {
			stack.push({ specs: token.specs, truthy: [], falsy: [], inElse: false });
		} else if (token.type === "else") {
			const frame = stack[stack.length - 1];
			if (!frame) {
				return { ok: false, error: { message: 'Found orphan `<else>` outside `<if-model>`.' } };
			}
			if (frame.inElse) {
				return { ok: false, error: { message: 'Found multiple `<else>` tags in one `<if-model>` block.' } };
			}
			frame.inElse = true;
		} else {
			const frame = stack.pop();
			if (!frame) {
				return { ok: false, error: { message: 'Found closing `</if-model>` without a matching `<if-model>`.' } };
			}
			appendNode(stack, root, { type: "if", specs: frame.specs, truthy: frame.truthy, falsy: frame.falsy });
		}

		cursor += length;
		textStart = cursor;
	}

	if (textStart < input.length) {
		appendNode(stack, root, { type: "text", value: input.slice(textStart) });
	}

	if (stack.length > 0) {
		return { ok: false, error: { message: 'Missing closing `</if-model>` tag.' } };
	}

	return { ok: true, nodes: root };
}

function renderNodes(nodes: Node[], model: ResolvedModelRef): string {
	let output = "";

	for (const node of nodes) {
		if (node.type === "text") {
			output += node.value;
			continue;
		}

		const branch = node.specs.some((spec) => matchSpec(spec, model)) ? node.truthy : node.falsy;
		output += renderNodes(branch, model);
	}

	return output;
}

export function renderTemplateConditionals(
	content: string,
	model: ResolvedModelRef,
	commandName?: string,
): RenderConditionalsResult {
	if (!content.includes("<if-model") && !content.includes("<else") && !content.includes("</if-model") && !content.includes("</else")) {
		return { content };
	}

	const parsed = parseNodes(content);
	if (parsed.ok) {
		return { content: renderNodes(parsed.nodes, model) };
	}

	const label = commandName ? ` in prompt \`${commandName}\`` : "";
	const error = (parsed as ParseFailure).error;
	return {
		content,
		error: `Invalid <if-model> markup${label}: ${error.message}`,
	};
}
