import type { AdaptiveChainDecision } from "./adaptive-chain.js";
import type { AdaptiveRuntimeReport } from "./adaptive-runtime.js";
import { capSanitizedText } from "./render-safe.js";

function safe(value: unknown, max = 240): string { return capSanitizedText(value, max); }
export function formatAdaptiveDecision(decision: AdaptiveChainDecision): string {
	const source = decision.sourceStep === null ? "start" : safe(decision.sourceStep);
	const target = decision.selectedTarget === null ? "terminal" : safe(decision.selectedTarget);
	const observed = decision.observedOutcome === null ? "initial" : decision.observedOutcome;
	return safe(`${decision.reason}: ${source} --${decision.matchedRule}/${observed}${decision.matchedGate ? ` gate=${decision.matchedGate}` : ""}--> ${target}`, 600);
}
export function formatAdaptiveRuntimeReport(name: string, report: AdaptiveRuntimeReport, status: "completed" | "cancelled" | "failed" = "completed"): string {
	const lines = [`Adaptive chain ${safe(name)} ${status}: ${report.actions.length} action(s), ${report.state.modelCalls} model call(s).`, "Decisions:"];
	lines.push(...(report.decisions.length ? report.decisions.map((decision) => `- ${formatAdaptiveDecision(decision)}`) : ["- none"]));
	lines.push("Actions:");
	lines.push(...(report.actions.length ? report.actions.map((action) => `- ${safe(action.stepId)} [${action.kind}] ${safe(action.target)}: ${action.outcome}; changed=${action.changed === undefined ? "unobserved" : action.changed}${action.errorReason ? `; reason=${safe(action.errorReason, 500)}` : ""}`) : ["- none"]));
	return capSanitizedText(lines.join("\n"), 16_000, { preserveLineBreaks: true });
}

export function formatAdaptiveError(name: unknown, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return capSanitizedText(`Adaptive chain ${safe(name)} failed: ${safe(message, 2_000)}`, 4_000, { preserveLineBreaks: true });
}
