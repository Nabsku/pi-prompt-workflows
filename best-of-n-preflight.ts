import type { DelegationLineupSlot, PromptRootKind, PromptSource } from "./prompt-loader.js";

export const BEST_OF_N_PREFLIGHT_SCHEMA_VERSION = 1;

export type BestOfNPreflightSchemaVersion = typeof BEST_OF_N_PREFLIGHT_SCHEMA_VERSION;
export type BestOfNPreflightDiagnosticSeverity = "warning" | "error";
export type BestOfNPreflightSlotKind = "worker" | "reviewer" | "final-applier";
export type BestOfNPreflightSlotSource = "prompt" | "preset" | "default" | "runtime-override";
export type BestOfNPreflightCwdSource = "runtime-cwd" | "prompt-cwd" | "context-cwd" | "path-argument";
export type BestOfNPreflightPresetTrust = "none" | "user" | "project-approval-required" | "project-approved" | "not-found" | "invalid";
export type BestOfNPreflightCommitMode = "none" | "ask";
export type BestOfNPreflightCallCapStatus = "within-cap" | "exceeded" | "uncapped";

export interface BestOfNPreflightPromptIdentity {
	name: string;
	description: string;
	source: PromptSource;
	rootKind: PromptRootKind;
	filePath: string;
}

export interface BestOfNPreflightCompareCwd {
	resolved: string;
	source: BestOfNPreflightCwdSource;
	requested?: string;
	approvalCwd?: string;
}

export interface BestOfNPreflightPresetIdentity {
	name: string;
	trust: BestOfNPreflightPresetTrust;
	source?: PromptSource;
	filePath?: string;
	description?: string;
	defaultModel?: string;
	maxModelCalls?: number;
	runtimeOverride: boolean;
}

export interface BestOfNPreflightSlot extends DelegationLineupSlot {
	kind: BestOfNPreflightSlotKind;
	index: number;
	source: BestOfNPreflightSlotSource;
	effectiveModelLabel: string;
	effectiveTask?: string;
	expandedFromIndex?: number;
}

export interface BestOfNPreflightSlots {
	workers: BestOfNPreflightSlot[];
	reviewers: BestOfNPreflightSlot[];
	finalApplier?: BestOfNPreflightSlot;
}

export interface BestOfNPreflightModelLabels {
	base: string;
	workers: string[];
	reviewers: string[];
	finalApplier?: string;
}

export interface BestOfNPreflightTaskArgs {
	raw?: string;
	parsed: string[];
	renderedTask?: string;
}

export interface BestOfNPreflightWorktreePolicy {
	enabled: boolean;
	requiredByFinalApplier: boolean;
	workerCwdPolicy: "shared" | "independent";
}

export interface BestOfNPreflightFinalApplierPolicy {
	enabled: boolean;
	requiresWorktree: boolean;
}

export interface BestOfNPreflightCommitPolicy {
	mode: BestOfNPreflightCommitMode;
	approvalCwd?: string;
}

export interface BestOfNPreflightArtifactExpectations {
	report: {
		willWrite: boolean;
		root?: string;
	};
	rawArtifacts: {
		keepArtifacts: boolean;
		expectedFiles: string[];
	};
}

export interface BestOfNPreflightCallCount {
	workers: number;
	reviewers: number;
	finalApplier: number;
	total: number;
	cap?: number;
	capStatus: BestOfNPreflightCallCapStatus;
}

export interface BestOfNPreflightDiagnostic {
	severity: BestOfNPreflightDiagnosticSeverity;
	code: string;
	message: string;
	source?: PromptSource | "runtime" | "preset";
	filePath?: string;
}

export interface BestOfNPreflightPolicies {
	worktree: BestOfNPreflightWorktreePolicy;
	finalApplier: BestOfNPreflightFinalApplierPolicy;
	commit: BestOfNPreflightCommitPolicy;
}

export interface BestOfNPreflight {
	schemaVersion: BestOfNPreflightSchemaVersion;
	prompt: BestOfNPreflightPromptIdentity;
	compareCwd: BestOfNPreflightCompareCwd;
	preset?: BestOfNPreflightPresetIdentity;
	slots: BestOfNPreflightSlots;
	models: BestOfNPreflightModelLabels;
	task: BestOfNPreflightTaskArgs;
	policies: BestOfNPreflightPolicies;
	artifacts: BestOfNPreflightArtifactExpectations;
	callCount: BestOfNPreflightCallCount;
	diagnostics: BestOfNPreflightDiagnostic[];
}
