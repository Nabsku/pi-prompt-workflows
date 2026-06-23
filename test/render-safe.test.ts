import test from "node:test";
import assert from "node:assert/strict";
import { capSanitizedText, sanitizeForTerminal, terminalVisibleWidth, truncateForTerminalWidth } from "../render-safe.js";

const hostile = "\u001b[31mred\u001b[0m\u001b]0;owned\u0007\u009b2Jtab\tcr\rother\u0001";

test("shared sanitizer strips ANSI/OSC/CSI payloads and escapes controls", () => {
	const rendered = sanitizeForTerminal(hostile);
	assert.equal(rendered.includes("\u001b"), false);
	assert.equal(rendered.includes("\u009b"), false);
	assert.equal(rendered.includes("\u0007"), false);
	assert.match(rendered, /red/);
	assert.doesNotMatch(rendered, /owned/);
	assert.match(rendered, /tab\\u0009cr\\u000dother\\u0001/);
});

test("shared sanitizer preserves real line breaks only for block rendering", () => {
	assert.equal(sanitizeForTerminal("a\nb"), "a\\nb");
	assert.equal(sanitizeForTerminal("a\nb", { preserveLineBreaks: true }), "a\nb");
	assert.equal(sanitizeForTerminal("a\rb", { preserveLineBreaks: true }), "a\\u000db");
});

test("shared truncation sanitizes before width capping and shows original byte size", () => {
	const rendered = truncateForTerminalWidth("abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz\u001b[2Jghij", 60, { originalBytes: 123 });
	assert.equal(rendered.includes("\u001b"), false);
	assert.match(rendered, /\[truncated, original 123 bytes\]/);
	assert.ok(terminalVisibleWidth(rendered) <= 60, rendered);
});

test("shared sanitizer covers untrusted render fields across current and future inspectors", () => {
	const fields = {
		runName: "run\u001b[2J\rname",
		reportPreview: "# Report\u001b]8;;https://evil\u0007link",
		artifactContent: "worker output\u001b[H\tspoof",
		filePath: "/tmp/project\r/forged",
		diagnostic: "warning\u009b31m\nnext",
		presetDescription: "Strict oracle\u001b]0;owned\u0007 preset",
		promptName: "prompt\u001b[31m-name",
		presetName: "preset\u0007-name",
	};
	for (const [name, value] of Object.entries(fields)) {
		const rendered = sanitizeForTerminal(value);
		assert.doesNotMatch(rendered, /[\u001b\u0007\u009b\r\t]/, name);
	}
});

test("shared capped text truncates after sanitization", () => {
	const rendered = capSanitizedText("safe\u001b[2Jcontent", 7, { originalBytes: 55 });
	assert.equal(rendered.includes("\u001b"), false);
	assert.match(rendered, /^safecon/);
	assert.match(rendered, /original 55 bytes/);
});
