export interface SanitizeForTerminalOptions {
	preserveLineBreaks?: boolean;
}

export interface TruncateForTerminalOptions extends SanitizeForTerminalOptions {
	originalBytes?: number;
	marker?: string;
}

const TERMINAL_ESCAPE_PATTERN = /\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)|\u009d[\s\S]*?(?:\u0007|\u009c|$)|\u001b[PX^_][\s\S]*?(?:\u001b\\|$)|\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
const CONTROL_WITH_LF_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;
const CONTROL_EXCEPT_LF_PATTERN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

function escapeControl(char: string): string {
	if (char === "\n") return "\\n";
	return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

export function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

export function sanitizeForTerminal(value: unknown, options: SanitizeForTerminalOptions = {}): string {
	const text = String(value ?? "").replace(TERMINAL_ESCAPE_PATTERN, "");
	return text.replace(options.preserveLineBreaks ? CONTROL_EXCEPT_LF_PATTERN : CONTROL_WITH_LF_PATTERN, escapeControl);
}

function codePointWidth(char: string): number {
	const codePoint = char.codePointAt(0) ?? 0;
	if (codePoint === 0) return 0;
	if (codePoint < 32 || (codePoint >= 0x7f && codePoint <= 0x9f)) return 0;
	if (
		codePoint >= 0x1100 &&
		(codePoint <= 0x115f ||
			codePoint === 0x2329 ||
			codePoint === 0x232a ||
			(codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
			(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
			(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
			(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
			(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
			(codePoint >= 0xff00 && codePoint <= 0xff60) ||
			(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
			(codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
			(codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
			(codePoint >= 0x20000 && codePoint <= 0x3fffd))
	) return 2;
	return 1;
}

export function terminalVisibleWidth(value: string): number {
	let width = 0;
	for (const char of value) width += codePointWidth(char);
	return width;
}

function truncateSanitized(value: string, width: number): string {
	if (width <= 0) return "";
	let used = 0;
	let output = "";
	for (const char of value) {
		const charWidth = codePointWidth(char);
		if (used + charWidth > width) break;
		output += char;
		used += charWidth;
	}
	return output;
}

export function truncationMarker(originalBytes?: number): string {
	return originalBytes !== undefined ? `… [truncated, original ${originalBytes} bytes]` : "… [truncated]";
}

export function truncateForTerminalWidth(value: unknown, width: number, options: TruncateForTerminalOptions = {}): string {
	const sanitized = sanitizeForTerminal(value, options);
	if (terminalVisibleWidth(sanitized) <= width) return sanitized;
	const marker = options.marker ?? truncationMarker(options.originalBytes);
	const markerWidth = terminalVisibleWidth(marker);
	if (markerWidth >= width) return truncateSanitized(marker, width);
	return `${truncateSanitized(sanitized, width - markerWidth)}${marker}`;
}

export function capSanitizedText(value: unknown, maxChars: number, options: TruncateForTerminalOptions = {}): string {
	const sanitized = sanitizeForTerminal(value, options);
	if (sanitized.length <= maxChars) return sanitized;
	return `${sanitized.slice(0, Math.max(0, maxChars))}${options.marker ?? truncationMarker(options.originalBytes ?? utf8ByteLength(String(value ?? "")))}`;
}
