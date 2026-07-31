import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { substituteArgs } from "./args.js";
import { getResolvedModelRef, selectModelCandidate, type RegistryLike, type SelectedModelCandidate } from "./model-selection.js";
import type { PromptWithModel } from "./prompt-loader.js";
import { evaluatePromptBudget } from "./prompt-budget.js";
import { renderTemplateConditionals, renderTemplateConditionalsWithInputs } from "./template-conditionals.js";

export interface PreparedPromptExecution {
	selectedModel: SelectedModelCandidate;
	content: string;
	warning?: string;
}

export interface EmptyPromptAbort {
	message: string;
	warning?: string;
}

interface PromptExecutionOptions {
	inheritedModel?: Model<any>;
}

export interface RenderedPrompt {
	content?: string;
	warning?: string;
	empty?: string;
}

export interface PromptExecutionBudgetCheck {
	message?: string;
	warning?: string;
}

export class PromptBudgetExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PromptBudgetExceededError";
	}
}

export type StepExecutionStatus = "succeeded" | "failed" | "blocked";

export type StepExecutionOutcome<TResult> =
	| { status: "succeeded"; result: TResult }
	| { status: "failed"; result: TResult }
	| { status: "failed" | "blocked"; error: unknown };

/** Adaptive-runtime adapter. Legacy callers continue to receive/throw their original values. */
export async function captureStepExecutionOutcome<TResult>(
	execute: () => Promise<TResult>,
): Promise<StepExecutionOutcome<TResult>> {
	try {
		return { status: "succeeded", result: await execute() };
	} catch (error) {
		return error instanceof PromptBudgetExceededError
			? { status: "blocked", error }
			: { status: "failed", error };
	}
}

/** Normalize Pi's structured assistant completion state without inferring from prose. */
export function normalizePromptCompletionOutcome(
	message: AssistantMessage,
): StepExecutionOutcome<AssistantMessage> {
	switch (message.stopReason) {
		case "stop":
		case "length":
		case "toolUse":
			return { status: "succeeded", result: message };
		case "error":
		case "aborted":
			return { status: "failed", result: message };
		default:
			throw new Error(`Assistant completion has unknown or missing stopReason: ${String(message.stopReason)}`);
	}
}

/** Adaptive prompt seam: budget preflight happens before the execution callback. */
export async function capturePromptExecutionOutcome(
	prompt: Pick<PromptWithModel, "name" | "budget">,
	content: string,
	execute: () => Promise<AssistantMessage>,
): Promise<StepExecutionOutcome<AssistantMessage>> {
	const budgetCheck = checkPromptExecutionBudget(prompt, content);
	if (budgetCheck.message) {
		return { status: "blocked", error: new PromptBudgetExceededError(budgetCheck.message) };
	}
	try {
		return normalizePromptCompletionOutcome(await execute());
	} catch (error) {
		return { status: "failed", error };
	}
}

export function checkPromptExecutionBudget(
	prompt: Pick<PromptWithModel, "name" | "budget">,
	content: string,
): PromptExecutionBudgetCheck {
	const budget = evaluatePromptBudget(content, prompt.budget);
	if (budget.verdict === "exceeded") {
		return { message: `Prompt \`${prompt.name}\` estimated ${budget.estimatedTokens} tokens exceeds configured maximum of ${budget.config?.maxTokens}.` };
	}
	if (budget.verdict === "warning") {
		return { warning: `Prompt \`${prompt.name}\` estimated ${budget.estimatedTokens} tokens reached warning threshold of ${budget.config?.warnTokens}.` };
	}
	return {};
}

export function renderPromptForResolvedModel(
	prompt: Pick<PromptWithModel, "name" | "content" | "resolvedInputValues">,
	args: string[],
	model: Model<any>,
): RenderedPrompt {
	const rendered = prompt.resolvedInputValues
		? renderTemplateConditionalsWithInputs(prompt.content, getResolvedModelRef(model), prompt.resolvedInputValues, prompt.name)
		: renderTemplateConditionals(prompt.content, getResolvedModelRef(model), prompt.name);
	const content = substituteArgs(rendered.content, args);
	if (content.trim().length === 0) {
		return {
			empty: `Prompt \`${prompt.name}\` rendered to an empty message.`,
			warning: rendered.error,
		};
	}
	return {
		content,
		warning: rendered.error,
	};
}

function sameModel(a: Model<any> | undefined, b: Model<any> | undefined): boolean {
	if (!a || !b) return a === b;
	return a.provider === b.provider && a.id === b.id;
}

export async function preparePromptExecution(
	prompt: Pick<PromptWithModel, "name" | "content" | "models" | "budget" | "resolvedInputValues">,
	args: string[],
	currentModel: Model<any> | undefined,
	modelRegistry: RegistryLike,
	options?: PromptExecutionOptions,
): Promise<PreparedPromptExecution | EmptyPromptAbort | undefined> {
	const selectedModel =
		prompt.models.length === 0
			? (() => {
				const hasInheritedModel = options !== undefined && Object.hasOwn(options, "inheritedModel");
				const inheritedModel = hasInheritedModel ? options.inheritedModel : currentModel;
				if (!inheritedModel) {
					return {
						message: `Prompt \`${prompt.name}\` has no \`model\` configured and there is no active session model to inherit.`,
					};
				}
				return {
					model: inheritedModel,
					alreadyActive: sameModel(currentModel, inheritedModel),
				};
			})()
			: await selectModelCandidate(prompt.models, currentModel, modelRegistry);
	if (!selectedModel) return undefined;
	if ("message" in selectedModel) return selectedModel;

	const rendered = renderPromptForResolvedModel(prompt, args, selectedModel.model);
	if (rendered.empty) {
		return {
			message: rendered.empty,
			warning: rendered.warning,
		};
	}

	return {
		selectedModel,
		content: rendered.content ?? "",
		warning: rendered.warning,
	};
}
