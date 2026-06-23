---
name: prompt-template-authoring
description: |
  Write and run custom Pi prompt templates (slash commands) for this extension.
  Use when creating templates with model selection, deterministic pre-steps,
  loops, chains, subagents, or best-of-N compare flows.
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
- Only single prompt templates (no `chain`, `loop`, `subagent`, or `parallel`)
- Runtime flags `--loop`, `--subagent`, `--fork` are rejected for deterministic prompts

## Subagent Delegation

Delegate to another Pi agent instead of running inline:

```yaml
---
model: claude-sonnet-4-20250514
subagent: delegate          # or true, or a specific agent name
inheritContext: true        # fork conversation context (optional)
cwd: /absolute/path         # working directory for the subagent (optional)
parallel: 3                 # run 3 copies in parallel (optional)
---
$@
```

Requires [pi-subagents](https://github.com/nicobailon/pi-subagents/) to be installed.

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

## Best-of-N Compare

Run multiple workers, aggregate with reviewers, optionally apply final changes. Put workflow policy in the prompt and reusable lineup choices in optional presets:

Preset mental model: presets choose who participates and the model-call cap; prompt templates choose what work is allowed. Put reusable lineups, models, counts, default model, and `maxModelCalls` in presets. Keep task text, `cwd`, `worktree`, `finalApplier`, `commit`, dirty/report policy, and other execution behavior in prompt templates. `maxModelCalls` counts expanded workers + reviewers + an optional final applier.

```json
{
  "presets": {
    "quick": {
      "defaultModel": "openai-codex/gpt-5.4-mini:low",
      "maxModelCalls": 3,
      "workers": [{ "agent": "delegate", "count": 2 }],
      "reviewers": [{ "agent": "reviewer" }]
    }
  }
}
```

YAML preset files are also supported:

```yaml
presets:
  quick:
    defaultModel: openai-codex/gpt-5.4-mini:low
    maxModelCalls: 3
    workers:
      - agent: delegate
        count: 2
    reviewers:
      - agent: reviewer
```

Preset files live at `~/.pi/agent/best-of-n-presets.json` / `.yaml` / `.yml` and `<compare-cwd>/.pi/best-of-n-presets.json` / `.yaml` / `.yml`. Project presets override same-named user presets, but execution asks for per-session approval; `/compare-presets` and `/dry-run-prompt <compare> --preset <name>` are read-only and do not approve or run them. Use `/compare-presets --plain` for deterministic stdout. Preset slots only support `agent`/`subagent`, `model`, and `count`; keep `task`, `taskSuffix`, `cwd`, `finalApplier`, `worktree`, and dirty/report/commit policy in prompt templates. Successful compare runs write `.pi/runs/best-of-n/<timestamp>-<prompt>-<id>/report.md` plus `lineup.json`; inspect them with `/compare-runs`, `/compare-runs --plain --limit 5`, or `/compare-runs --plain --id <run-id>`. Add `--keep-artifacts` when you also need raw worker/reviewer/final-applier outputs. Use `bestOfN.commit: ask` with a `finalApplier` when you want a display-only commit approval block with changed files, diff summary, report path, suggested commit message, and safe manual `git -C <compare-cwd> add --patch` / `git -C <compare-cwd> commit -m ...` commands without auto-committing. For intended new files shown as `??`, mark them with `git -C <compare-cwd> add -N -- <path>` or explicitly stage them before committing.

Common compare workflows:

- Evidence-retaining adversarial oracle review: `/compare-presets --plain`, `/dry-run-prompt best-of-n --preset quick --plain review the change`, `/best-of-n --preset quick --keep-artifacts review the change`, then `/compare-runs --plain --id <run-id>`.
- Evidence-retaining compare operator happy path: `/compare-presets`, `/dry-run-prompt best-of-n --preset quick --plain <task>`, `/best-of-n --preset quick --keep-artifacts <task>`, then `/compare-runs --id <run-id>`.
- Summary-only compare, then inspect history: `/print-prompt best-of-n --preset quick --plain refactor the parser`, `/best-of-n --preset quick refactor the parser`, then `/compare-runs` for the TUI picker or `/compare-runs --plain --id <run-id>` for stdout. Omit `--keep-artifacts` intentionally when the durable summary report and lineup are enough.
- Summary-only safe final-applier: set `bestOfN.worktree: true`, configure one `finalApplier`, set `commit: ask`, then run `/dry-run-prompt best-of-n --preset quick --plain implement the cleanup` before `/best-of-n --preset quick implement the cleanup`. Add `--keep-artifacts` if you need raw final-applier evidence retained.

```yaml
---
description: Best-of-N code review
bestOfN:
  preset: quick
  worktree: true            # required if using finalApplier
  finalApplier:
    agent: delegate
    model: anthropic/claude-sonnet-4-20250514:high
  commit: ask              # manual commit approval block after finalApplier
---
$@
```

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
- `--worktree` — use git worktrees for parallel delegated work
- `--preset=<name>` / `--preset <name>` — select a best-of-N preset for compare prompts only
- `--keep-artifacts` — retain raw best-of-N worker/reviewer/final-applier artifacts next to the generated report

When stuck, check `README.md` and the packaged examples: start with `examples/hello.md` or `examples/review.md`, then use `examples/best-of-n-smoke.md` before the advanced `examples/best-of-n.md` compare prompt.
