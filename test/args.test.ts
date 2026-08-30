import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	extractChainContextFlag,
	extractLoopCount,
	extractLoopFlags,
	extractLineupOverrides,
	extractSubagentOverride,
	findRemovedLegacyRuntimeFlag,
	parseCommandArgs,
	substituteArgs,
} from "../args.ts";

test("parseCommandArgs respects quoted segments", () => {
	assert.deepEqual(parseCommandArgs('alpha "two words" beta'), ["alpha", "two words", "beta"]);
	assert.deepEqual(parseCommandArgs("one 'two three' four"), ["one", "two three", "four"]);
});

test("parseCommandArgs decodes JSON-style quote and backslash escapes in double-quoted values", () => {
	const value = '/tmp/repo\\with "quotes"';
	assert.deepEqual(parseCommandArgs(`--cwd ${JSON.stringify(value)}`), ["--cwd", value]);
});

test("substituteArgs supports positional, aggregate, and slice replacements", () => {
	const result = substituteArgs("$1 | $@ | $ARGUMENTS | ${@:2} | ${@:2:2}", ["one", "two", "three", "four"]);
	assert.equal(result, "one | one two three four | one two three four | two three four | two three");
});

test("substituteArgs is non-recursive", () => {
	const result = substituteArgs("$1 / $@", ["$2", "$ARGUMENTS"]);
	assert.equal(result, "$2 / $2 $ARGUMENTS");
});

test("substituteArgs supports @$ as alias for all args", () => {
	const result = substituteArgs("Args: @$", ["one", "two"]);
	assert.equal(result, "Args: one two");
});

test("findRemovedLegacyRuntimeFlag rejects retired delegation controls but preserves quoted literals", () => {
	for (const flag of [
		"--worktree",
		"--preset=quick",
		"--preset quick",
		"--keep-artifacts",
	]) {
		assert.ok(findRemovedLegacyRuntimeFlag(`task ${flag}`), flag);
	}
	assert.equal(findRemovedLegacyRuntimeFlag("task -- --worktree"), "--worktree");
	assert.equal(findRemovedLegacyRuntimeFlag('task "--worktree" \'--preset=quick\''), undefined);
});

test("findRemovedLegacyRuntimeFlag uses the command parser grammar around escaped quotes", () => {
	const raw = "\\'literal' --worktree";
	assert.deepEqual(parseCommandArgs(raw), ["\\literal", "--worktree"]);
	assert.equal(findRemovedLegacyRuntimeFlag(raw), "--worktree");
});

test("findRemovedLegacyRuntimeFlag rejects retired flags with partially quoted tokens", () => {
	for (const [raw, parsed, expected] of [
		['--preset="quick"', ["--preset=quick"], "--preset"],
		['""--worktree', ["--worktree"], "--worktree"],
	] as const) {
		assert.deepEqual(parseCommandArgs(raw), parsed, raw);
		assert.equal(findRemovedLegacyRuntimeFlag(raw), expected, raw);
	}
});

test("extractLineupOverrides removes structured compare flags and preserves ordinary args", () => {
	const result = extractLineupOverrides(`task --workers=${JSON.stringify([{ agent: "one", count: 2 }])} --workers-append=${JSON.stringify([{ agent: "two" }])} --final-applier=${JSON.stringify({ agent: "final" })}`);
	assert.equal(result.errors.length, 0);
	assert.equal(result.args, "task");
	assert.deepEqual(result.actions.map((action) => [action.target, action.mode, action.slots.length]), [
		["workers", "replace", 1],
		["workers", "append", 1],
		["finalApplier", "replace", 1],
	]);
});

test("extractLineupOverrides accepts the documented subagent slot alias", () => {
	const result = extractLineupOverrides(`--workers=${JSON.stringify([{ subagent: "worker" }])} --reviewers=${JSON.stringify([{ subagent: true }])}`);
	assert.equal(result.errors.length, 0);
	assert.deepEqual(result.actions.map((action) => action.slots[0].agent), ["worker", "reviewer"]);
});

test("extractLineupOverrides expands home-relative slot cwds", () => {
	const result = extractLineupOverrides(`--workers=${JSON.stringify([{ agent: "worker", cwd: "~/delegated" }])}`);
	assert.equal(result.errors.length, 0);
	assert.equal(result.actions[0]?.slots[0]?.cwd, join(homedir(), "delegated"));
});

test("extractLineupOverrides decodes single- and double-quoted JSON values", () => {
	const json = JSON.stringify([{ agent: "worker", task: "focus on \"quoted\" output" }]);
	const result = extractLineupOverrides(`keep --workers='${json}' --reviewers=${JSON.stringify(json)} tail`);
	assert.equal(result.errors.length, 0);
	assert.deepEqual(parseCommandArgs(result.args), ["keep", "tail"]);
	assert.deepEqual(result.actions.map((action) => action.slots[0]?.agent), ["worker", "worker"]);
	assert.deepEqual(result.actions.map((action) => action.slots[0]?.task), ["focus on \"quoted\" output", "focus on \"quoted\" output"]);
});

test("extractLineupOverrides rejects invalid slot JSON and unsupported final-applier count", () => {
	const result = extractLineupOverrides('--workers=[{"agent":""}] --final-applier={"agent":"final","count":2}');
	assert.equal(result.actions.length, 0);
	assert.match(result.errors.join(" "), /non-empty|count/);
});

test("extractLoopCount extracts --loop N and --loop=N forms", () => {
	assert.deepEqual(extractLoopCount("--loop 5"), { args: "", loopCount: 5, fresh: false, converge: true });
	assert.deepEqual(extractLoopCount("--loop=5"), { args: "", loopCount: 5, fresh: false, converge: true });
	assert.deepEqual(extractLoopCount("--loop 1"), { args: "", loopCount: 1, fresh: false, converge: true });
	assert.deepEqual(extractLoopCount("--loop=999"), { args: "", loopCount: 999, fresh: false, converge: true });
});

test("extractLoopCount preserves surrounding quoted args", () => {
	assert.deepEqual(extractLoopCount('"fix auth bug" --loop 3'), { args: '"fix auth bug"', loopCount: 3, fresh: false, converge: true });
	assert.deepEqual(extractLoopCount("'fix auth bug' --loop=3"), { args: "'fix auth bug'", loopCount: 3, fresh: false, converge: true });
});

test("extractLoopCount handles chain-style args with -> and --", () => {
	const result = extractLoopCount('analyze -> fix --loop=3 -- "src/main.ts"');
	assert.ok(result);
	assert.equal(result.loopCount, 3);
	assert.equal(result.args, 'analyze -> fix  -- "src/main.ts"');
	assert.equal(result.converge, true);
});

test("extractLoopCount treats bare --loop as unlimited", () => {
	assert.deepEqual(extractLoopCount("--loop"), { args: "", loopCount: null, fresh: false, converge: true });
	assert.deepEqual(extractLoopCount("--loop 5x"), { args: "5x", loopCount: null, fresh: false, converge: true });
	assert.deepEqual(extractLoopCount("--loop -1"), { args: "-1", loopCount: null, fresh: false, converge: true });
	assert.deepEqual(extractLoopCount("--loop --fresh"), { args: "", loopCount: null, fresh: true, converge: true });
	assert.deepEqual(extractLoopCount("--loop --no-converge"), { args: "", loopCount: null, fresh: false, converge: false });
});

test("extractLoopCount keeps quoted --loop as literal", () => {
	assert.equal(extractLoopCount('"--loop"'), null);
	assert.equal(extractLoopCount('"--loop" task'), null);
});

test("extractLoopCount treats invalid --loop numeric values as regular args", () => {
	assert.equal(extractLoopCount("--loop 0"), null);
	assert.equal(extractLoopCount("--loop 1000"), null);
	assert.equal(extractLoopCount("--loop=0"), null);
	assert.equal(extractLoopCount("--loop=1000"), null);
	assert.equal(extractLoopCount("--loop=abc"), null);
});

test("extractLoopCount allows bounded --loop with no-converge", () => {
	assert.deepEqual(extractLoopCount("--loop 5 --no-converge"), {
		args: "",
		loopCount: 5,
		fresh: false,
		converge: false,
	});
	assert.deepEqual(extractLoopCount("--loop 5 --fresh"), {
		args: "",
		loopCount: 5,
		fresh: true,
		converge: true,
	});
});

test("extractLoopCount removes repeated loop tokens and loop-adjacent flags", () => {
	assert.deepEqual(extractLoopCount("--loop 2 --loop 3 task --fresh --fresh --no-converge --no-converge"), {
		args: "task",
		loopCount: 2,
		fresh: true,
		converge: false,
	});
	assert.deepEqual(extractLoopCount("--loop 0 --loop 2 task"), {
		args: "task",
		loopCount: 2,
		fresh: false,
		converge: true,
	});
});

test("extractLoopCount handles newline-separated flags", () => {
	assert.deepEqual(extractLoopCount("task\n--loop 3\n--fresh"), {
		args: "task",
		loopCount: 3,
		fresh: true,
		converge: true,
	});
});

test("extractLoopCount returns null when no loop token exists", () => {
	assert.equal(extractLoopCount("regular args"), null);
	assert.equal(extractLoopCount(""), null);
	assert.equal(extractLoopCount("5x"), null);
	assert.equal(extractLoopCount("3x task"), null);
});

test("extractLoopCount ignores --fresh and --no-converge without --loop", () => {
	assert.equal(extractLoopCount("--fresh"), null);
	assert.equal(extractLoopCount("task --fresh"), null);
	assert.equal(extractLoopCount("--no-converge"), null);
	assert.equal(extractLoopCount("task --no-converge"), null);
});

test("extractLoopCount composes with parseCommandArgs and substituteArgs", () => {
	const loop = extractLoopCount('"focus on performance" --loop 3');
	assert.ok(loop);
	const args = parseCommandArgs(loop.args);
	assert.equal(substituteArgs("Review: $@", args), "Review: focus on performance");
});

test("extractLoopFlags removes unquoted --fresh and --no-converge", () => {
	assert.deepEqual(extractLoopFlags("--fresh task --no-converge --fresh"), {
		args: "task",
		fresh: true,
		converge: false,
	});
});

test("extractLoopFlags preserves quoted flags", () => {
	assert.deepEqual(extractLoopFlags('"--fresh" \'--no-converge\' --fresh'), {
		args: '"--fresh" \'--no-converge\'',
		fresh: true,
		converge: true,
	});
});

test("extractLoopFlags defaults when no flags are present", () => {
	assert.deepEqual(extractLoopFlags("regular args"), {
		args: "regular args",
		fresh: false,
		converge: true,
	});
});

test("extractLoopFlags composes with parseCommandArgs and substituteArgs", () => {
	const flags = extractLoopFlags('--fresh "focus on performance"');
	assert.equal(flags.fresh, true);
	assert.equal(flags.converge, true);
	const args = parseCommandArgs(flags.args);
	assert.equal(substituteArgs("Review: $@", args), "Review: focus on performance");
});

test("extractLoopFlags extracts --no-converge and removes all occurrences", () => {
	assert.deepEqual(extractLoopFlags("--no-converge task --no-converge"), {
		args: "task",
		fresh: false,
		converge: false,
	});
});

test("extractLoopFlags handles newline-separated flags", () => {
	assert.deepEqual(extractLoopFlags("task\n--fresh\r\n--no-converge"), {
		args: "task",
		fresh: true,
		converge: false,
	});
});

test("extractChainContextFlag strips bare --chain-context tokens", () => {
	assert.deepEqual(extractChainContextFlag("task --chain-context"), {
		args: "task",
		chainContext: true,
	});
});

test("extractChainContextFlag strips repeated flags", () => {
	assert.deepEqual(extractChainContextFlag("--chain-context task --chain-context"), {
		args: "task",
		chainContext: true,
	});
});

test("extractChainContextFlag preserves quoted flags", () => {
	const extracted = extractChainContextFlag('"--chain-context" --chain-context task');
	assert.equal(extracted.chainContext, true);
	assert.deepEqual(parseCommandArgs(extracted.args), ["--chain-context", "task"]);
});

test("extractChainContextFlag composes with chain-style args and shared args separator", () => {
	assert.deepEqual(extractChainContextFlag('analyze -> fix --chain-context -- "src/main.ts"'), {
		args: 'analyze -> fix  -- "src/main.ts"',
		chainContext: true,
	});
});

test("extractSubagentOverride parses bare and named runtime overrides", () => {
	assert.deepEqual(extractSubagentOverride("--subagent task"), {
		args: "task",
		override: { enabled: true },
	});
	assert.deepEqual(extractSubagentOverride("task --subagent:worker"), {
		args: "task",
		override: { enabled: true, agent: "worker" },
	});
	assert.deepEqual(extractSubagentOverride("task --subagent=reviewer"), {
		args: "task",
		override: { enabled: true, agent: "reviewer" },
	});
});

test("extractSubagentOverride ignores quoted flags and strips repeated overrides", () => {
	assert.deepEqual(extractSubagentOverride('"--subagent" task'), {
		args: '"--subagent" task',
	});
	assert.deepEqual(extractSubagentOverride("task --subagent --subagent:worker"), {
		args: "task",
		override: { enabled: true, agent: "worker" },
	});
});

test("extractSubagentOverride extracts --cwd and strips it from args", () => {
	assert.deepEqual(extractSubagentOverride("--cwd=/tmp/nfd task"), {
		args: "task",
		cwd: "/tmp/nfd",
	});
	assert.deepEqual(extractSubagentOverride("--cwd /tmp/nfd task"), {
		args: "task",
		cwd: "/tmp/nfd",
	});
	assert.deepEqual(extractSubagentOverride('--cwd "/tmp/repo with space" task'), {
		args: "task",
		cwd: "/tmp/repo with space",
	});
	assert.deepEqual(extractSubagentOverride("task --subagent=reviewer --cwd=/tmp/nfd"), {
		args: "task",
		override: { enabled: true, agent: "reviewer" },
		cwd: "/tmp/nfd",
	});
});

test("extractSubagentOverride handles quoted, empty, and repeated --cwd flags", () => {
	assert.deepEqual(extractSubagentOverride('"--cwd=/tmp" task'), {
		args: '"--cwd=/tmp" task',
	});
	assert.deepEqual(extractSubagentOverride("task --cwd="), {
		args: "task",
	});
	assert.deepEqual(extractSubagentOverride("task --cwd=/tmp/one --cwd=/tmp/two"), {
		args: "task",
		cwd: "/tmp/two",
	});
});

test("extractSubagentOverride extracts --model and strips it from args", () => {
	assert.deepEqual(extractSubagentOverride("--model=anthropic/claude-opus-4-6 task"), {
		args: "task",
		model: "anthropic/claude-opus-4-6",
	});
	assert.deepEqual(extractSubagentOverride("--model anthropic/claude-opus-4-6 task"), {
		args: "task",
		model: "anthropic/claude-opus-4-6",
	});
	assert.deepEqual(extractSubagentOverride('--model "anthropic/claude-opus-4-6" task'), {
		args: "task",
		model: "anthropic/claude-opus-4-6",
	});
	assert.deepEqual(extractSubagentOverride("task --subagent --model=openai/gpt-5.4"), {
		args: "task",
		override: { enabled: true },
		model: "openai/gpt-5.4",
	});
});

test("extractSubagentOverride ignores empty --model= and quoted --model", () => {
	assert.deepEqual(extractSubagentOverride("task --model="), {
		args: "task",
	});
	assert.deepEqual(extractSubagentOverride('"--model=anthropic/opus" task'), {
		args: '"--model=anthropic/opus" task',
	});
});

test("extractSubagentOverride extracts --fork and implies --subagent", () => {
	assert.deepEqual(extractSubagentOverride("task --fork"), {
		args: "task",
		override: { enabled: true },
		fork: true,
	});
	assert.deepEqual(extractSubagentOverride("task --fork --subagent:worker"), {
		args: "task",
		override: { enabled: true, agent: "worker" },
		fork: true,
	});
});

test("extractSubagentOverride preserves quoted --fork", () => {
	assert.deepEqual(extractSubagentOverride('"--fork" task'), {
		args: '"--fork" task',
	});
});
