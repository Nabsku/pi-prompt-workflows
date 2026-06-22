import type { MessageRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";

export const PROMPT_TEMPLATE_COMMIT_ASK_MESSAGE_TYPE = "prompt-template-commit-ask";

interface CommitAskMessage {
	content?: unknown;
	details?: {
		approvalText?: unknown;
	};
}

const PREVIEW_LINES = 24;

function sanitizeApprovalText(value: string): string {
	return value.split("\n").map((line) => JSON.stringify(line).slice(1, -1)).join("\n");
}

export function renderCommitAskMessage(message: CommitAskMessage, options: MessageRenderOptions, theme: Theme) {
	const content = typeof message.details?.approvalText === "string" ? sanitizeApprovalText(message.details.approvalText) : "";
	const container = new Container();
	container.addChild(new Spacer(1));
	const box = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
	box.addChild(new Text(`${theme.fg("warning", "ask")} ${theme.fg("toolTitle", theme.bold("commit approval"))} | manual`, 0, 0));
	box.addChild(new Spacer(1));
	const lines = content.split("\n");
	const rendered = options.expanded || lines.length <= PREVIEW_LINES
		? content
		: `${lines.slice(0, PREVIEW_LINES).join("\n")}\n... (${lines.length - PREVIEW_LINES} more lines hidden — Ctrl+O to expand)`;
	box.addChild(new Text(theme.fg("toolOutput", rendered), 0, 0));
	container.addChild(box);
	return container;
}
