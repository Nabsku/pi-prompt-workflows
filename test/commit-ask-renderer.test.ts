import test from "node:test";
import assert from "node:assert/strict";
import { renderCommitAskMessage } from "../commit-ask-renderer.js";

const theme = {
	fg(_token: string, text: string) { return text; },
	bg(_token: string, text: string) { return text; },
	bold(text: string) { return text; },
} as any;

test("commit ask renderer escapes control sequences while preserving lines", () => {
	const widget = renderCommitAskMessage(
		{ details: { approvalText: "git -C '/tmp/don'\"'\"'t' commit -m 'don'\"'\"'t'\n\u001b]2;forged\u0007\u001b[31mred\u009b31mred\u009dtitle" } },
		{ expanded: true } as any,
		theme,
	);
	const rendered = widget.render(120).join("\n");
	assert.match(rendered, /git -C '\/tmp\/don'"'"'t' commit -m 'don'"'"'t'/);
	assert.doesNotMatch(rendered, /\\"'\\"/);
	assert.match(rendered, /\\u001b\]2;forged\\u0007\\u001b\[31mred\\u009b31mred\\u009dtitle/);
	assert.doesNotMatch(rendered, /[\u001b\u009b\u009d]\]2;forged/);
});
