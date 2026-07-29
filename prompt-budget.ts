export const PROMPT_TOKEN_ESTIMATE_METHOD = "utf8-bytes-divided-by-4" as const;

export interface PromptBudgetConfig {
	warnTokens?: number;
	maxTokens?: number;
}

export interface PromptTokenEstimate {
	bytes: number;
	estimatedTokens: number;
	method: typeof PROMPT_TOKEN_ESTIMATE_METHOD;
}

export type PromptBudgetVerdict = "unconfigured" | "within" | "warning" | "exceeded";

export interface PromptBudgetResult extends PromptTokenEstimate {
	verdict: PromptBudgetVerdict;
	config?: PromptBudgetConfig;
	sources?: PromptBudgetSourceEstimate[];
}

export interface PromptBudgetSourceEstimate extends PromptTokenEstimate {
	kind: "prompt" | "include" | "skill";
	label: string;
	filePath?: string;
}

export function estimatePromptTokens(content: string): PromptTokenEstimate {
	const bytes = Buffer.byteLength(content, "utf8");
	return {
		bytes,
		estimatedTokens: Math.ceil(bytes / 4),
		method: PROMPT_TOKEN_ESTIMATE_METHOD,
	};
}

export function evaluatePromptBudget(content: string, config: PromptBudgetConfig | undefined): PromptBudgetResult {
	const estimate = estimatePromptTokens(content);
	let verdict: PromptBudgetVerdict = "unconfigured";
	if (config) {
		if (config.maxTokens !== undefined && estimate.estimatedTokens > config.maxTokens) verdict = "exceeded";
		else if (config.warnTokens !== undefined && estimate.estimatedTokens >= config.warnTokens) verdict = "warning";
		else verdict = "within";
	}
	return { ...estimate, ...(config ? { config } : {}), verdict };
}
