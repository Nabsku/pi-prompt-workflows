---
name: prompt-template-authoring
description: |
  Write and run custom Pi prompt templates (slash commands) for this extension.
  Use when creating templates with model selection, deterministic pre-steps,
  loops, sequential chains, best-of-N comparisons, or structured single-subagent delegation.
---

# Prompt Template Authoring

Use this skill when working on prompt templates for `pi-prompt-workflows`.
Templates are markdown files that register as slash commands.

## Where Templates Live

- `~/.pi/agent/prompts/` — user prompts (highest priority)
- `.pi/prompts/` inside a project — project-specific prompts

Extension `examples/` are reference files only. Copy them to a prompt directory to register them.

## Minimal Template

```markdown
---
description: Tiny smoke prompt
---
Reply with one sentence: hello from this Pi session.
```

Save as `~/.pi/agent/prompts/hello.md`, restart Pi if it is already running, then run `/validate-prompts`, `/print-prompt hello --plain`, and `/hello`. Omit `model:` to inherit the current session model; add `description:` for autocomplete text.

## Model Selection

Omit `model:` to inherit the current session model. Otherwise:

- `model: claude-sonnet-4-20250514` — specific model
- `model: claude-opus-4, gpt-5.4` — fallback order (tries first, falls back to second if unavailable)
- `model: claude-opus-4, gpt-5.4` + `rotate: true` — cycle through list on each loop iteration

## Argument Substitution

The prompt body can use placeholders:

- `$@` — all arguments passed to the command
- `$1`, `$2` — specific positional arguments
- `${@:1}` — argument 1 and everything after

## Prompt Budgets

Use an opt-in budget to make rendered prompt size visible and fail closed above an explicit maximum:

```yaml
---
budget:
  warnTokens: 1200
  maxTokens: 1800
---
$@
```

- Counts are deterministic estimates: `ceil(UTF-8 bytes / 4)`, not model-tokenizer-exact values.
- `warnTokens` warns and continues; `maxTokens` aborts before model switching, message sending, or subagent delegation.
- `/validate-prompts` reports static estimates; `/print-prompt <name> --plain ...` reports the final rendered estimate after includes, conditionals, and arguments.
- Dry-run source estimates identify the root prompt, resolved includes, and loaded skills. They are diagnostic and not additive.
- Put budgets on executable chain step templates, not chain wrappers.
- Deterministic prompts do not support budgets because their command runs before an optional LLM handoff.

## Deterministic Steps (Pre-LLM Execution)

Run a command or script before the LLM turn. The model only sees the output if you want it to.

Two equivalent forms. Don't mix them in the same prompt.

**Shorthand form** — top-level keys:

```yaml
---
run: git status --short
handoff: always
---
Summarize the repo state.
```

**Nested form** — under `deterministic:`:

```yaml
---
deterministic:
  run: ./scripts/ship.sh
  handoff: on-failure
  timeout: 60000
---
Diagnose the failure and suggest a fix.
```

**Handoff controls when the LLM sees the result:**

- `never` — run, show result, done (no LLM turn)
- `always` — always hand result to model
- `on-failure` — only hand off if command exits non-zero
- `on-success` — only hand off if command exits zero

**Execution forms:**

- `run: command string` — runs via `/bin/bash -lc`
- `run: {command: git, args: [status], shell: false}` — explicit args, optional shell
- `script: ./script.sh` or `script: {path: ./script.sh, args: [--fast]}` — run a file

**Constraints:**
- Only single prompt templates (no `chain`, `loop`, or `subagent`)
- Runtime flags `--loop`, `--subagent`, `--fork` are rejected for deterministic prompts

## Subagent Delegation

Delegate to another Pi agent instead of running inline:

```yaml
---
model: claude-sonnet-4-20250514
subagent: delegate          # or true, or a specific agent name
inheritContext: true        # fork conversation context (optional)
cwd: /absolute/path         # working directory for the subagent (optional)
---
$@
```

Requires [pi-subagents](https://github.com/nicobailon/pi-subagents/) to be installed. Current integration uses its structured single-delegation contract. Legacy `parallel`, `worktree`, `commit`, and `preset` fields remain unsupported and fail validation.

### Best-of-N comparisons

Use `bestOfN` for bounded independent candidates:

```yaml
bestOfN:
  workers:
    - agent: delegate
      count: 2
  reviewers:
    - agent: reviewer
  finalApplier:
    agent: synthesizer
```

- `workers` is required and must contain at least one slot. `reviewers` and `finalApplier` are optional.
- A slot accepts `agent` or the documented `subagent` alias, plus `model`, `task`, `taskSuffix`, `cwd`, and a positive `count` for workers or reviewers.
- Reviewers receive successful candidates and labelled worker failure summaries. The final applier receives those materials plus reviewer results and failure summaries.
- The total worker, reviewer, and final-applier requests cannot exceed 32 per invocation.
- Runtime lineup changes use `--workers=JSON`, `--workers-append=JSON`, `--reviewers=JSON`, `--reviewers-append=JSON`, and `--final-applier=JSON`.
- This feature does not restore legacy worktree, parallel, automatic commit, or preset transport. Those fields are rejected instead of ignored.

## Loops

Run the prompt multiple times:

```yaml
---
model: claude-sonnet-4-20250514
loop: 5                     # run exactly 5 times
converge: true              # stop early if no changes (default)
fresh: true                 # collapse context between iterations
---
$@
```

Or at runtime: `/command --loop 5`, `/command --loop` (unlimited), or `/command --loop=5 --fresh`.

## Chains

Chain templates declare a reusable pipeline:

```yaml
---
chain: analyze -> fix -> test
chainContext: summary        # pass step summaries to later delegated steps
---
$@
```

Or use `/chain-prompts analyze -> fix -> test` at runtime. Chain templates ignore the body and `model:` field.

## Adaptive Chains

Use a YAML list under `chain` for bounded outcome-based routing. Each step sets exactly one of `prompt` or `run`; optional `id` defaults to the target name and is required to distinguish repeated targets. Gates are `always`, `changed`, `succeeded`, and `failed`; transitions are `onSuccess`, `onFailure`, and `onBlocked` and point to step IDs. Omitted transitions naturally fall through.

```yaml
chain:
  - id: test
    run: adaptive-test
    onFailure: fix
  - id: fix
    prompt: adaptive-fix
  - id: review
    prompt: adaptive-review
    when: changed
limits:
  maxSteps: 3
  maxModelCalls: 2
```

Prompt actions cost one model call; run and skipped actions cost zero. `run` targets must be deterministic with `handoff: never`. Prompt targets cannot be loops, delegated, boomerang, deterministic, or nested chains. Changed evidence is a fail-closed before/after Git snapshot, so use a readable Git worktree. For read-only Git companions, put `--no-optional-locks -c core.fsmonitor=false` before the subcommand and disable helpers explicitly. Use the staged-only check `git --no-optional-locks -c core.fsmonitor=false --no-pager diff --cached --no-ext-diff --no-textconv --check`. Status companions should combine filter-free worktree/untracked evidence with `git --no-optional-locks -c core.fsmonitor=false --no-pager diff --cached --name-status --no-ext-diff --no-textconv --` so staged additions, deletions, renames, and modifications remain visible. Do not package a generic unstaged diff check, because configured conversion filters may execute while Git prepares it. Always run `/validate-prompts` and `/dry-run-prompt <chain> --plain` first; preflight is read-only and runtime revalidates targets, skills, models, budgets, cwd, and snapshots.

## Model Conditionals

Show different content based on which model runs:

```markdown
<if-model is="anthropic/*">
Use Claude-specific instructions.
<else>
Use default instructions.
</if-model>
```

Supports exact IDs, `provider/model-id` pairs, wildcards (`anthropic/*`), and comma-separated combinations.

## Runtime Flags

Override frontmatter at invocation:

- `--model=provider/model-id` — use this model instead
- `--subagent` / `--subagent=<name>` / `--subagent:<name>` — force delegation
- `--fork` — force delegation with context fork
- `--loop N` / `--loop=N` / `--loop` — override loop count (unlimited if bare)
- `--fresh` — collapse context between iterations
- `--no-converge` — run all iterations even if no changes
- `--cwd=/absolute/path` — working directory override when the prompt supports `cwd`
- `--chain-context` — pass summaries to later delegated chain steps

## Typed Prompt Inputs

Input-enabled templates may declare only `string`, `choice`, and `boolean` fields under `inputs`. Use `--name=value` or `--name value`; boolean fields also support `--no-name`. Defaults apply automatically. `${input.name}` and `<if-input name="..." is="...">...</if-input>` change body Markdown only. Use `--` before positional text when needed; named input flags are removed before `$@` substitution. Interactive TUI invocations open a compact form for unresolved values. Headless, plain, RPC, dry-run, and unsupported workflow modes never wait for input and instead fail clearly. Input values cannot select includes, models, skills, commands, paths, delegation, or other executable configuration.

When stuck, check `README.md` and the packaged examples. Start with `examples/hello.md` or `examples/review.md`.
