import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { PromptWithModel, DeterministicStep, DeterministicExecution, DeterministicEnv } from "./prompt-loader.ts";
import type { StepExecutionOutcome } from "./prompt-execution.ts";

export const PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE = "prompt-template-deterministic";
export const PROMPT_TEMPLATE_DETERMINISTIC_COMPLETION_MESSAGE_TYPE = "prompt-template-deterministic-complete";

const DEFAULT_MAX_CAPTURE_STDOUT_CHARS = 16_000;
const DEFAULT_MAX_CAPTURE_STDERR_CHARS = 16_000;
const PROCESS_GROUP_POLL_MS = 10;
const PROCESS_GROUP_TERM_GRACE_MS = 100;
const PROCESS_GROUP_CLEANUP_DEADLINE_MS = 8_000;
const PROCESS_GROUP_PROBE_TIMEOUT_MS = 250;

interface CapturedOutput {
	text: string;
	totalChars: number;
	totalNewlines: number;
	trailingNewlineRun: number;
	sawNonNewline: boolean;
	truncated: boolean;
	maxChars: number;
}

export interface DeterministicExecutionResult {
	execution: DeterministicExecution;
	cwd: string;
	nonInteractive: boolean;
	resolvedScriptPath?: string;
	exitCode: number | null;
	signal?: NodeJS.Signals;
	termination?: "cancelled" | "aborted";
	stdout: string;
	stdoutTotalChars: number;
	stdoutTotalLines: number;
	stdoutTruncated: boolean;
	stderr: string;
	stderrTotalChars: number;
	stderrTotalLines: number;
	stderrTruncated: boolean;
	durationMs: number;
	timedOut: boolean;
	cleanupScope: "process-group" | "direct-child";
	processGroupExtinct?: boolean;
	cleanupError?: string;
}

export interface DeterministicPreambleOptions {
	maxStdoutChars?: number;
	maxStderrChars?: number;
}

export function normalizeDeterministicExecutionOutcome(
	result: DeterministicExecutionResult,
): StepExecutionOutcome<DeterministicExecutionResult> {
	if (result.exitCode !== null && (typeof result.exitCode !== "number" || !Number.isInteger(result.exitCode))) {
		throw new Error("Deterministic execution result is missing a structured exitCode.");
	}
	if (typeof result.timedOut !== "boolean") {
		throw new Error("Deterministic execution result is missing structured timedOut state.");
	}
	if (result.termination !== undefined && result.termination !== "cancelled" && result.termination !== "aborted") {
		throw new Error(`Deterministic execution result has unknown termination: ${String(result.termination)}`);
	}
	if (result.exitCode === 0) {
		if (result.signal || result.timedOut || result.termination) {
			throw new Error("Deterministic execution result has contradictory successful exit and failure termination state.");
		}
		return { status: "succeeded", result };
	}
	if (typeof result.exitCode === "number") {
		if (result.signal || result.timedOut || result.termination) {
			throw new Error("Deterministic execution result has contradictory exit code and termination state.");
		}
		return { status: "failed", result };
	}
	if (result.termination && (result.signal || result.timedOut)) {
		throw new Error("Deterministic execution result has contradictory cancellation and process termination state.");
	}
	if (result.signal || result.timedOut || result.termination) return { status: "failed", result };
	throw new Error("Deterministic execution result has unknown termination state.");
}

function createCapturedOutput(maxChars: number): CapturedOutput {
	return {
		text: "",
		totalChars: 0,
		totalNewlines: 0,
		trailingNewlineRun: 0,
		sawNonNewline: false,
		truncated: false,
		maxChars,
	};
}

function appendCapturedOutput(output: CapturedOutput, chunk: string): void {
	if (!chunk) return;
	output.totalChars += chunk.length;
	const newlines = chunk.match(/\n/g)?.length ?? 0;
	output.totalNewlines += newlines;
	if (/[^\n]/.test(chunk)) output.sawNonNewline = true;
	const trailingRun = chunk.match(/\n+$/)?.[0].length ?? 0;
	if (trailingRun === 0) {
		output.trailingNewlineRun = 0;
	} else if (trailingRun === chunk.length) {
		output.trailingNewlineRun += trailingRun;
	} else {
		output.trailingNewlineRun = trailingRun;
	}

	if (output.text.length < output.maxChars) {
		const remaining = output.maxChars - output.text.length;
		output.text += chunk.slice(0, remaining);
	}
	if (output.totalChars > output.maxChars) output.truncated = true;
}

function capturedLineCount(output: Pick<CapturedOutput, "totalChars" | "sawNonNewline" | "totalNewlines" | "trailingNewlineRun">): number {
	if (output.totalChars === 0) return 0;
	if (!output.sawNonNewline) return 1;
	return output.totalNewlines - output.trailingNewlineRun + 1;
}

function countLines(value: string): number {
	if (!value) return 0;
	const normalized = value.replace(/\n+$/g, "");
	if (!normalized) return 1;
	return normalized.split("\n").length;
}

function buildTextPreview(label: string, value: string, totalChars: number, maxChars: number): { text: string; truncated: boolean; omittedChars: number } {
	const shownChars = Math.min(value.length, maxChars);
	const preview = value.slice(0, shownChars);
	const omittedChars = Math.max(0, totalChars - shownChars);
	if (omittedChars === 0) {
		return { text: preview, truncated: false, omittedChars: 0 };
	}
	return {
		text: `${preview}\n...[${label} truncated, ${omittedChars} more chars omitted]`,
		truncated: true,
		omittedChars,
	};
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function formatDeterministicExecution(execution: DeterministicExecution, resolvedScriptPath?: string): string {
	switch (execution.kind) {
		case "run":
			return execution.command;
		case "command": {
			const parts = [execution.command, ...execution.args].map((part) => shellQuote(part));
			return execution.shell ? `${parts.join(" ")} (shell)` : parts.join(" ");
		}
		case "script": {
			const scriptPath = resolvedScriptPath ?? execution.path;
			const parts = [scriptPath, ...execution.args].map((part) => shellQuote(part));
			return parts.join(" ");
		}
	}
}

export function shouldHandoffToLlm(step: DeterministicStep, result: Pick<DeterministicExecutionResult, "exitCode">): boolean {
	switch (step.handoff) {
		case "always": return true;
		case "never": return false;
		case "on-success": return result.exitCode === 0;
		case "on-failure": return result.exitCode !== 0;
	}
}

function buildOutputPreambleSectionFromResult(
	label: "stdout" | "stderr",
	value: string,
	meta: { totalChars: number; totalLines: number },
	maxChars: number,
): string[] {
	const preview = buildTextPreview(label, value, meta.totalChars, maxChars);
	return [
		`[${label}]`,
		`lineCount: ${meta.totalLines}`,
		`charCount: ${meta.totalChars}`,
		`truncated: ${preview.truncated ? "true" : "false"}`,
		preview.truncated ? `omittedChars: ${preview.omittedChars}` : undefined,
		"preview:",
		preview.text || "(empty)",
	];
}

export function buildDeterministicPreamble(
	result: DeterministicExecutionResult,
	options: DeterministicPreambleOptions = {},
): string {
	const maxStdoutChars = options.maxStdoutChars ?? 8_000;
	const maxStderrChars = options.maxStderrChars ?? 4_000;
	const command = formatDeterministicExecution(result.execution, result.resolvedScriptPath);
	return [
		"[Deterministic step]",
		`status: ${result.exitCode === 0 ? "succeeded" : "failed"}`,
		`executionKind: ${result.execution.kind}`,
		`command: ${command.includes("\n") ? JSON.stringify(command) : command}`,
		result.resolvedScriptPath ? `resolvedScript: ${result.resolvedScriptPath}` : undefined,
		`cwd: ${result.cwd}`,
		`nonInteractive: ${result.nonInteractive ? "true" : "false"}`,
		`exitCode: ${result.exitCode}`,
		result.signal ? `signal: ${result.signal}` : undefined,
		`durationMs: ${result.durationMs}`,
		`timedOut: ${result.timedOut ? "true" : "false"}`,
		"",
		...buildOutputPreambleSectionFromResult("stdout", result.stdout, {
			totalChars: result.stdoutTotalChars,
			totalLines: result.stdoutTotalLines,
		}, maxStdoutChars),
		"",
		...buildOutputPreambleSectionFromResult("stderr", result.stderr, {
			totalChars: result.stderrTotalChars,
			totalLines: result.stderrTotalLines,
		}, maxStderrChars),
	].filter((line): line is string => line !== undefined).join("\n");
}

function resolveScriptPath(prompt: Pick<PromptWithModel, "filePath">, cwd: string, execution: Extract<DeterministicExecution, { kind: "script" }>): string {
	if (isAbsolute(execution.path)) return execution.path;
	const promptRelative = resolve(dirname(prompt.filePath), execution.path);
	if (existsSync(promptRelative)) return promptRelative;
	return resolve(cwd, execution.path);
}

function buildDeterministicEnv(step: Pick<DeterministicStep, "env" | "nonInteractive">): NodeJS.ProcessEnv {
	const nonInteractiveDefaults: DeterministicEnv = step.nonInteractive
		? {
			CI: "1",
			GIT_TERMINAL_PROMPT: "0",
			PAGER: "cat",
			GIT_PAGER: "cat",
		}
		: {};
	return {
		...process.env,
		...nonInteractiveDefaults,
		...(step.env ?? {}),
	};
}

function spawnProcess(command: string, args: string[], options: { cwd: string; shell?: boolean; env: NodeJS.ProcessEnv }) {
	return spawn(command, args, {
		cwd: options.cwd,
		shell: options.shell ?? false,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
}

function signalProcessTree(child: ReturnType<typeof spawnProcess>, signal: NodeJS.Signals): "process-group" | "direct-child" {
	const pid = child.pid;
	if (process.platform !== "win32" && typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1) {
		try {
			process.kill(-pid, signal);
			return "process-group";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return "process-group";
		}
	}
	try { child.kill(signal); } catch { /* The child already exited. */ }
	return "direct-child";
}

function processGroupExists(pid: number): { exists: boolean; attributable: boolean; probeError?: string } {
	try {
		process.kill(-pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return { exists: false, attributable: false };
		return { exists: true, attributable: false, probeError: error instanceof Error ? error.message : String(error) };
	}
	// A killed descendant can remain as a zombie until its external reaper runs.
	// Zombies cannot execute or write, so they are operationally extinct. Exact
	// live PGID membership also preserves authority after the leader closes.
	if (process.platform !== "win32") {
		const inspected = spawnSync("ps", ["-o", "pgid=,stat=", "-g", String(pid)], { encoding: "utf8", timeout: PROCESS_GROUP_PROBE_TIMEOUT_MS });
		if (inspected.status === 0) {
			const members = inspected.stdout.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => /^(\d+)\s+(\S+)/.exec(line));
			if (members.length === 0 || members.some((member) => !member || Number(member[1]) !== pid)) return { exists: true, attributable: false, probeError: "process group membership could not be attributed to the original PGID" };
			if (members.every((member) => member![2]!.startsWith("Z"))) return { exists: false, attributable: true };
			return { exists: true, attributable: true };
		}
		else return { exists: true, attributable: false, probeError: inspected.error?.message ?? `ps exited with status ${String(inspected.status)}` };
	}
	return { exists: true, attributable: false };
}

function killAttributedProcessGroup(pid: number): void {
	const probe = processGroupExists(pid);
	if (!probe.exists || !probe.attributable) return;
	try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

async function waitForProcessGroupExtinction(pid: number): Promise<void> {
	const deadline = performance.now() + PROCESS_GROUP_CLEANUP_DEADLINE_MS;
	let lastProbeError: string | undefined;
	for (;;) {
		const probe = processGroupExists(pid);
		if (!probe.exists) return;
		if (probe.probeError) lastProbeError = probe.probeError;
		if (performance.now() >= deadline) {
			const detail = lastProbeError ? `; process inspection repeatedly failed: ${lastProbeError}` : "";
			throw new Error(`Deterministic process group ${pid} did not become extinct within ${PROCESS_GROUP_CLEANUP_DEADLINE_MS}ms${detail}`);
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, PROCESS_GROUP_POLL_MS));
	}
}

export async function runDeterministicStep(
	prompt: Pick<PromptWithModel, "filePath">,
	step: DeterministicStep,
	cwd: string,
	signal?: AbortSignal,
	testHooks?: { readonly timeoutStart?: Promise<void> },
): Promise<DeterministicExecutionResult> {
	const startedAt = Date.now();
	const execution = step.execution;
	const resolvedCwd = step.cwd ?? cwd;
	const env = buildDeterministicEnv(step);
	const resolvedScriptPath = execution.kind === "script"
		? resolveScriptPath(prompt, resolvedCwd, execution)
		: undefined;
	const child = execution.kind === "run"
		? spawnProcess("/bin/bash", ["-lc", execution.command], { cwd: resolvedCwd, env })
		: execution.kind === "command"
			? spawnProcess(execution.command, execution.args, { cwd: resolvedCwd, shell: execution.shell, env })
			: spawnProcess(resolvedScriptPath!, execution.args, { cwd: resolvedCwd, env });

	const stdout = createCapturedOutput(DEFAULT_MAX_CAPTURE_STDOUT_CHARS);
	const stderr = createCapturedOutput(DEFAULT_MAX_CAPTURE_STDERR_CHARS);
	let timedOut = false;
	let cancelled = false;
	let terminationRequested = false;
	let escalationHandle: ReturnType<typeof setTimeout> | undefined;
	let finishEscalation: (() => void) | undefined;
	let escalationPromise: Promise<void> | undefined;
	let cleanupScope: "process-group" | "direct-child" = process.platform === "win32" ? "direct-child" : "process-group";
	const terminate = () => {
		if (terminationRequested) return;
		terminationRequested = true;
		cleanupScope = signalProcessTree(child, "SIGTERM");
		if (cleanupScope === "process-group") {
			escalationPromise = new Promise((resolveEscalation) => {
				finishEscalation = resolveEscalation;
				escalationHandle = setTimeout(() => {
					escalationHandle = undefined;
					// While the original detached leader is still live, its PID is also the
					// owned PGID, so the whole group can be escalated without external
					// inspection. Once it exits, require exact group re-attribution.
					if (child.exitCode === null && child.signalCode === null) {
						try { process.kill(-child.pid!, "SIGKILL"); } catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
						}
					} else if (typeof child.pid === "number") {
						killAttributedProcessGroup(child.pid);
					}
					finishEscalation = undefined;
					resolveEscalation();
				}, PROCESS_GROUP_TERM_GRACE_MS);
			});
		}
	};
	const cancel = () => {
		cancelled = true;
		terminate();
	};
	if (signal?.aborted) cancel();
	else signal?.addEventListener("abort", cancel, { once: true });

	child.stdout.on("data", (chunk) => {
		appendCapturedOutput(stdout, chunk.toString());
	});
	child.stderr.on("data", (chunk) => {
		appendCapturedOutput(stderr, chunk.toString());
	});

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let settled = false;
	void (testHooks?.timeoutStart ?? Promise.resolve()).then(() => {
		if (settled || !step.timeoutMs) return;
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			terminate();
		}, step.timeoutMs);
	});

	const clearEscalation = () => {
		if (!terminationRequested || cleanupScope !== "process-group") {
			if (escalationHandle) clearTimeout(escalationHandle);
			escalationHandle = undefined;
			finishEscalation?.();
			finishEscalation = undefined;
		}
	};

	return await new Promise((resolveResult) => {
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearEscalation();
			signal?.removeEventListener("abort", cancel);
			if (timeoutHandle) clearTimeout(timeoutHandle);
			resolveResult({
				execution,
				cwd: resolvedCwd,
				nonInteractive: step.nonInteractive,
				resolvedScriptPath,
				exitCode: 1,
				stdout: stdout.text,
				stdoutTotalChars: stdout.totalChars,
				stdoutTotalLines: capturedLineCount(stdout),
				stdoutTruncated: stdout.truncated,
				stderr: stderr.text ? `${stderr.text}\n${error.message}` : error.message,
				stderrTotalChars: stderr.totalChars + (stderr.text ? error.message.length + 1 : error.message.length),
				stderrTotalLines: countLines(stderr.text ? `${stderr.text}\n${error.message}` : error.message),
				stderrTruncated: stderr.truncated,
				durationMs: Date.now() - startedAt,
				timedOut,
				cleanupScope,
			});
		});
		child.on("close", async (exitCode, signalName) => {
			if (settled) return;
			settled = true;
			clearEscalation();
			if (escalationPromise) await escalationPromise;
			signal?.removeEventListener("abort", cancel);
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (terminationRequested && cleanupScope === "process-group" && typeof child.pid === "number") {
				try {
					await waitForProcessGroupExtinction(child.pid);
				} catch (error) {
					const cleanupError = error instanceof Error ? error.message : String(error);
					appendCapturedOutput(stderr, `${stderr.totalChars > 0 ? "\n" : ""}[cleanup] ${cleanupError}`);
					resolveResult({
						execution, cwd: resolvedCwd, nonInteractive: step.nonInteractive, resolvedScriptPath,
						exitCode: null, termination: cancelled ? "cancelled" : undefined,
						stdout: stdout.text, stdoutTotalChars: stdout.totalChars,
						stdoutTotalLines: capturedLineCount(stdout), stdoutTruncated: stdout.truncated,
						stderr: stderr.text, stderrTotalChars: stderr.totalChars,
						stderrTotalLines: capturedLineCount(stderr), stderrTruncated: stderr.truncated,
						durationMs: Date.now() - startedAt, timedOut, cleanupScope,
						processGroupExtinct: false, cleanupError,
					});
					return;
				}
			}
			resolveResult({
				execution,
				cwd: resolvedCwd,
				nonInteractive: step.nonInteractive,
				resolvedScriptPath,
				exitCode: cancelled || timedOut ? null : exitCode,
				signal: !cancelled && !timedOut ? signalName ?? undefined : undefined,
				termination: cancelled ? "cancelled" : undefined,
				stdout: stdout.text,
				stdoutTotalChars: stdout.totalChars,
				stdoutTotalLines: capturedLineCount(stdout),
				stdoutTruncated: stdout.truncated,
				stderr: stderr.text,
				stderrTotalChars: stderr.totalChars,
				stderrTotalLines: capturedLineCount(stderr),
				stderrTruncated: stderr.truncated,
				durationMs: Date.now() - startedAt,
				timedOut,
				cleanupScope,
				processGroupExtinct: terminationRequested && cleanupScope === "process-group" ? true : undefined,
			});
		});
	});
}
