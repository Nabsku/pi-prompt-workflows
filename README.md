<p>
  <img src="banner.png" alt="pi-prompt-workflows" width="1100">
</p>

# Pi Prompt Workflows

> This package is an enhanced fork of [`pi-prompt-template-model`](https://github.com/nicobailon/pi-prompt-template-model). It builds on the original extension's solid prompt-template foundation, stays close to upstream, and publishes the additional features under the separate package name `pi-prompt-workflows`.

Adds model selection, thinking levels, reusable prompt partials, and one-or-many skill injection to pi prompt templates. Define slash commands that switch to the right model, include shared instructions, load the exact skills needed, and auto-restore your session when done.

```
/review src/server.ts
  → switches to Sonnet
  → includes shared repo-review instructions
  → loads tmux + TypeScript skills
  → restores your previous model when finished
```

## Why?

Each prompt template becomes a self-contained agent mode. `/quick-debug` spins up a cheap model with REPL skills. `/deep-analysis` brings in extended thinking with refactoring expertise. `/review` can include the same shared repo rules every time without copying them into every template. When the command finishes, you're back to your daily driver without touching anything.

No more manually switching models, copying standard instructions between prompts, or hoping the agent picks up the right skills. You define the configuration once, and the slash command handles the rest.

## What this adds

- **Model routing**: choose one model, an explicit provider/model pair, or a fallback list.
- **Thinking control**: set per-command thinking levels.
- **Prompt includes**: reuse shared Markdown partials with `includes`, `include`, `<includes />`, and inline `<include file="..." />` directives.
- **Multiple skills**: inject one skill with `skill`, many skills with `skills`, or constrained wildcard groups like `golang-*`.
- **Dry-run preview**: inspect the exact rendered prompt body, metadata, warnings, and optional skill content before execution.
- **Pi-native TUI**: browse templates and inspect dry-run output interactively in Pi TUI mode without typing template names.
- **Prompt budgets**: inspect approximate rendered-token cost, set warning thresholds, and fail closed above an explicit maximum.
- **Execution control**: loops, model rotation, fresh context, boomerang collapse, structured subagent delegation, bounded best-of-N comparison, and sequential chains.

## Differences from upstream

This package is an enhanced fork of [`pi-prompt-template-model`](https://github.com/nicobailon/pi-prompt-template-model), with compatibility preserved where practical and new workflow features kept opt-in where possible.

### Additions

- Prompt includes from shared Markdown partials and prompt-library roots.
- Multiple skill injection via `skills`, plus constrained wildcard skill selectors.
- Dry-run previews and a Pi-native TUI picker/inspector for prompt templates.
- Loop controls, model rotation, fresh context, and boomerang context collapse.
- Chain templates, deterministic prompt steps, structured subagent delegation, and bounded best-of-N comparison.
- Richer `/validate-prompts` diagnostics, include graphs, and source summaries.

### Behavior changes and stricter validation

- Invalid prompt config is reported and skipped more consistently instead of running with silently degraded behavior.
- Prompt-library commands have extra trust checks because they can come from project-local reusable libraries.
- Duplicate prompt and prompt-library precedence is deterministic and reported with diagnostics.
- Runtime flags are scoped to prompt types that support them. Removed `--worktree`, `--preset`, and `--keep-artifacts` controls fail before execution and dry-run instead of degrading silently. Best-of-N uses `--workers`, `--workers-append`, `--reviewers`, `--reviewers-append`, and `--final-applier` only for compare prompts. Quote a runtime-looking flag when it is prompt content.
- Delegated execution accepts only a trusted session cwd or one of its child directories. The pi-subagents bridge loads child-local agent definitions and extensions from the delegated cwd. To delegate into another project root, start Pi in that root and approve project trust there.
- Prompt invocation events fail closed for execution paths without a bounded completion contract. Deterministic prompts need `timeout`; delegated prompts, runtime `--subagent`/`--fork`, and removed legacy runtime flags are refused with `accepted: false` and `reason: "unsupported-context"`.

### Breaking or migration notes

- `pi-subagents` 0.44 removed its legacy parallel/task/worktree transport. This extension keeps the structured single-delegation contract and restores best-of-N by issuing one bounded structured request per worker, reviewer, or final applier. Templates that use legacy `parallel`, `worktree`, `commit`, or `preset` fields are rejected with `unsupported-legacy-delegation`; nested `bestOfN` is supported.
- `skills:` must be a list. Use `skill: name` for a single skill.
- Some fields that upstream accepted loosely are now type-checked before registration, including prompt includes, chain declarations, loop values, cwd paths, and delegated skill selectors.

### Small tweaks

- Better command descriptions and runtime warnings for ignored or unsupported flags.
- More deterministic model/thinking fallback behavior in dry-run and execution paths.
- Packaged examples, authoring skill docs, and validation output are kept aligned with shipped behavior.

## Installation

```bash
pi install npm:pi-prompt-workflows
```

Existing installs: run the same install command again to fetch the published package version you want. If your Pi build has a separate update verb, use that; this extension does not currently rely on a package-specific update command.

If you previously installed the package under its old name, remove it before installing the renamed package to avoid duplicate commands and tool conflicts:

```bash
pi remove npm:pi-prompt-template-model-enhanced
pi install npm:pi-prompt-workflows
```

Restart pi to load the extension.

### Prompt discovery

Alongside the default user (`~/.pi/agent/prompts`) and project (`<cwd>/.pi/prompts`) directories, the extension loads `prompts` paths from the corresponding `settings.json` files. Relative entries resolve from the settings file's directory; absolute paths, `~/...`, directories, and individual Markdown files are supported. Settings paths precede defaults within a scope, while project prompts continue to override user prompts. Missing or malformed settings entries are reported without stopping discovery.

### Command map

| Command | Use it for |
| --- | --- |
| `/validate-prompts` | Reload and validate prompt templates, includes, skills, chains, models, and legacy-field diagnostics before execution. |
| `/print-prompt <name> --plain ...` | Print the exact rendered prompt/preflight report without executing it. |
| `/dry-run-prompt <name> --plain ...` | Same read-only preview path, with warnings and execute guidance. |

For delegated subagent execution (`subagent` and `inheritContext` frontmatter), install [pi-subagents](https://github.com/nicobailon/pi-subagents/) separately:

```bash
pi install npm:pi-subagents
```

pi-subagents is optional — everything else works without it. Using `subagent: true` without it installed fails fast with a clear error.

## First successful use in 2 minutes

Start with a skill-free prompt that inherits the current session model. This proves install, prompt loading, validation, preview, and execution before you try larger workflows.

```bash
pi install npm:pi-prompt-workflows
mkdir -p ~/.pi/agent/prompts
cat > ~/.pi/agent/prompts/hello.md <<'EOF'
---
description: Tiny smoke prompt for pi-prompt-workflows
---
Reply with one sentence: hello from this Pi session.
EOF
```

Restart `pi` if it is already running. Prompt files are loaded on session start and when an extension-owned command runs, but a restart/reload is the least surprising first-run path after installing the extension or adding a brand-new command file.

Then run the cheap preflight path first:

```text
/validate-prompts
/print-prompt hello --plain
/hello
```

If that works, you can stop there: the inline `hello.md` is the first-run path and does not require packaged examples.

Packaged examples are optional starter prompts. Copy them only when you want a larger template to customize, then preview before execution. Use either a repo checkout you already have, or unpack the published npm tarball into a temporary directory; do not rely on an undocumented Pi package-install location:

```bash
# Option A: from a local checkout of this repository
REPO=/path/to/your/pi-prompt-workflows-checkout
cp "$REPO/examples/review.md" ~/.pi/agent/prompts/review.md

# Option B: from the published npm package tarball
TMPDIR=$(mktemp -d)
npm pack pi-prompt-workflows --pack-destination "$TMPDIR"
tar -xzf "$TMPDIR"/pi-prompt-workflows-*.tgz -C "$TMPDIR"
cp "$TMPDIR/package/examples/review.md" ~/.pi/agent/prompts/review.md
```

```text
/validate-prompts
/print-prompt review --plain src/server.ts
/review src/server.ts
```

## Quick Start

Add `model`, optional `includes`, and optional `skill` / `skills` to any prompt template:

```markdown
---
description: Review TypeScript with shared repo rules
model: claude-sonnet-4-20250514
includes:
  - shared/repo-rules.md
  - shared/review-checklist.md
skills:
  - tmux
  - typescript-*
---
Review this change: $@
```

Run `/review src/server.ts` and the agent switches to Sonnet, prepends the shared partials, injects the requested skills, and starts working. When it finishes, your previous model is restored.

For a smaller prompt, the old single-skill form still works:

```markdown
---
description: Debug Python in tmux REPL
model: claude-sonnet-4-20250514
skill: tmux
---
Start a Python REPL session and help me debug: $@
```

For a prompt that needs typed named values, declare an `inputs` mapping. V1 supports `string`, `choice`, and `boolean` inputs:

```markdown
---
description: Review a selected target
model: claude-sonnet-4-20250514
inputs:
  target:
    type: string
    required: true
  depth:
    type: choice
    options: [quick, deep]
    default: quick
  run-tests:
    type: boolean
    default: false
---
Review `${input.target}` at `${input.depth}` depth.
<if-input name="run-tests" is="true">Run focused tests.<else>Do not run tests.</if-input>
```

Invoke named values with `--name=value` or `--name value`; boolean inputs also accept `--no-name`. A quote-aware `--` boundary leaves everything after it as positional `$@` text. `${input.name}` and `<if-input>` affect Markdown body content only; static include paths and executable configuration remain fixed. Missing values open one compact form in interactive TUI mode. Plain, RPC, dry-run, and other headless paths never block for input: they apply defaults and report unresolved values with an actionable error. Input-enabled loops, chains, delegation, and deterministic prompts are rejected. Compare/best-of-N execution has been removed entirely.

See [`examples/interactive-inputs.md`](examples/interactive-inputs.md) for a complete safe review example.


Run `/validate-prompts` to check prompt templates before using them. It reloads the project and user prompt directories, validates frontmatter, include paths, include cycles, chain declarations, reserved command names, and skill references that can be resolved from registered or filesystem skills.

Validation also reports an include graph for prompts that declare frontmatter includes (`include` / `includes`), use inline include directives, or fail include processing. Each relevant prompt is listed with its include dependencies, including nested partial-to-partial includes. The report also includes a source summary that separates project prompts, user prompts, prompt-library commands, and include-only prompt-library fragments so command-capable library entries are easy to distinguish from reusable parts.

A clean library reports success:

```text
[pi-prompt-workflows] Prompt validation passed: 4 prompt template(s) loaded.
Include graph:
- review [ok] /repo/.pi/prompts/review.md
  - review -> /repo/.pi/prompts/shared/rules.md (frontmatter shared/rules.md) [ok]
```

Invalid libraries fail with explicit diagnostics:

```text
[pi-prompt-workflows] Prompt validation failed: 2 issue(s) found across 3 loaded prompt template(s).
- include-not-found (project) /repo/.pi/prompts/review.md: Prompt include "shared/rules.md" was not found ...
- skill-not-found (project) /repo/.pi/prompts/debug.md: Prompt template ... references skill "tmux", but it was not found ...
Include graph:
- review [skipped] /repo/.pi/prompts/review.md
  - review -> unresolved:shared/rules.md (frontmatter shared/rules.md) [failed]
    ! include-not-found: Prompt include "shared/rules.md" was not found ...
```

Include graph statuses are concise: `[ok]` means the prompt or edge resolved successfully, `[skipped]` means the loader skipped that prompt because include processing failed or was invalid, and `[failed]` marks a failed edge or root diagnostic. Prompts skipped for missing, cyclic, or invalid includes still appear in the include graph with `[skipped]`, failed include edges, and diagnostic codes such as `include-not-found` or `include-cycle`.

## Prompt budgets

Prompt budgets make prompt size visible and optionally enforce a hard maximum before model switching, message sending, or subagent delegation:

```yaml
---
model: claude-sonnet-4-20250514
budget:
  warnTokens: 1200
  maxTokens: 1800
---
Review this change: $@
```

`warnTokens` emits a warning and continues. `maxTokens` fails closed when the final rendered prompt exceeds the limit. Both values are optional positive integers, at least one is required, and `warnTokens` cannot exceed `maxTokens`.

Token counts are deterministic estimates calculated as `ceil(UTF-8 bytes / 4)`; they are intentionally labeled as estimates rather than model-tokenizer-exact counts. Runtime enforcement uses the rendered prompt after include expansion, model conditionals, and argument substitution. `/validate-prompts` reports static rendered estimates for configured templates and rejects a template already above its maximum before runtime arguments are added, except when unresolved model conditionals make the raw estimate an unsafe upper bound; those prompts are enforced at runtime instead. `/print-prompt` and `/dry-run-prompt` report the exact runtime estimate, verdict, thresholds, and diagnostic source estimates for the root prompt, resolved includes, and loaded skills. Source estimates are not additive because includes can be nested or repeated and runtime rendering can change content.

Budgets are opt-in. A prompt without `budget` continues to run normally while dry-run still shows its unconfigured size estimate. Put budgets on executable chain step templates rather than chain wrappers. Deterministic prompts reject budget frontmatter because their command runs before an optional LLM handoff.

## Dry-run and TUI preview

Use `/print-prompt` or `/dry-run-prompt` to preview what a prompt template would send before it executes. The preview uses the same include rendering, model conditionals, argument substitution, skill resolution, loop metadata, delegation metadata, and runtime flags as normal execution, but it does not switch models, send user messages, run deterministic commands, or start subagents.

```text
/print-prompt review src/server.ts
/dry-run-prompt review --model=gpt-5.2 src/server.ts
```

With `--plain`, or in contexts without Pi UI, these commands print a Markdown report to stdout. In non-TUI UI contexts, they show the same report as a notification. By default, full skill content is hidden; add `--show-skills` when you explicitly want the preview to include loaded skill bodies. For delegated prompts, the preview reports the exact host-resolved skills. At runtime the host embeds those resolved `<skill>` blocks in the delegated task instead of sending names that the child could rebind to different files.

```text
/print-prompt review --show-skills src/server.ts
```

In Pi TUI mode, the commands open an interactive picker/inspector by default:

```text
/dry-run-prompt          # pick a template from a searchable list
/print-prompt            # same picker, useful when you do not remember the template name
/dry-run-prompt review   # open the inspector directly for review
```

TUI behavior:

- no template name opens a searchable template picker;
- picker rows label prompt-library commands as `project library` or `user library`, so reusable library commands are distinct from core `.pi/prompts` templates;
- `hidden: true` command-capable prompts are omitted from the picker, but an exact `/print-prompt <name>` or `/dry-run-prompt <name>` still opens them;
- a template name opens the inspector directly;
- `--plain` forces the stdout/plain report even in TUI mode;
- unsupported templates, such as deterministic or chain templates, show the same diagnostic as the plain path;
- full skill content remains hidden unless the dry-run result was created with `--show-skills`;
- the inspector always includes a static `Budget` pane with the rendered estimate, verdict, thresholds, and source estimates;
- the inspector always includes a static `Includes` pane. Prompts with include metadata or inline include directives show the include graph captured during dry-run rendering; prompts without includes show `No includes.`.

The inspector is read-only. It has no execute button and does not mutate the session.

## Prompt Discovery

The extension scans the default prompt directories:

- User defaults: `~/.pi/agent/prompts/`
- User prompt library: `~/.pi/agent/prompt-library/`
- Project defaults: `<cwd>/.pi/prompts/`
- Project prompt library: `<cwd>/.pi/prompt-library/`

Project prompts override user prompts when names collide. Prompt-library files are command-capable only when they use extension metadata such as `model`, `skill`, `skills`, `include`, `includes`, or `chain`; plain prompt-library files stay available as include fragments instead of becoming slash commands.

## Frontmatter Reference

All fields are optional. Templates that don't use any extension features (no `model`, `skill`, `skills`, `include`, `includes`, `thinking`, etc.) are left to pi's default prompt loader.

### Core Fields

| Field | Default | What it does |
|-------|---------|--------------|
| `model` | current session model | Which model to use. Accepts a single model, a `provider/model-id` pair, or a comma-separated fallback list (see [Model Format](#model-format)). Ignored when `chain` is set. |
| `skill` | — | Injects a skill, or a constrained suffix-`*` wildcard selector such as `golang-*`, as context before the agent handles your task. Kept for backward compatibility and simple prompts. See [Skills](#skills). |
| `skills` | — | List of skills to inject, with optional suffix-`*` wildcard selectors such as `golang-*`. See [Skills](#skills). |
| `thinking` | — | Thinking level for the model: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. `max` requires Pi 0.80.6 or newer and a model that exposes that level; older runtimes retain their existing levels. |
| `includes` | — | List of shared `.md` partials to insert into the prompt. See [Prompt includes](#prompt-includes). |
| `include` | — | Shortcut for a single partial, equivalent to `includes: [file.md]`. See [Prompt includes](#prompt-includes). |
| `description` | — | Short text shown next to the command in autocomplete. |
| `budget` | — | Optional `{ warnTokens, maxTokens }` rendered-prompt budget. Counts use the deterministic UTF-8 byte estimate described in [Prompt budgets](#prompt-budgets). `maxTokens` aborts before model/message/subagent side effects. Not supported on chain wrappers or deterministic prompts. |
| `hidden` | `false` | Hide a command-capable prompt from slash-command registration and the TUI picker while keeping it addressable by exact `/print-prompt` / `/dry-run-prompt` name and usable as an internal chain step. Visibility metadata alone does not make a plain file command-capable. |
| `chain` | — | Declares a reusable pipeline of templates (`step -> step`). When set, the body is ignored. See [Chain Templates](#chain-templates). |
| `chainContext` | — | Chain templates only. Set to `summary` so delegated steps receive a compact summary of what previous steps did. Steps with `inheritContext: true` are excluded. See [Chain context for delegated steps](#chain-context-for-delegated-steps). |

### Execution Control

| Field | Default | What it does |
|-------|---------|--------------|
| `restore` | `true` | After the command finishes, switch back to whatever model and thinking level were active before. Set `false` to stay on the new model. |
| `loop` | — | Run this template multiple times by default (1–999, `true`, or `unlimited`). CLI `--loop` overrides this. See [Loop Execution](#loop-execution). |
| `rotate` | `false` | When `true` and looping, cycle through models in the `model` list instead of using fallback semantics. Thinking levels can also be comma-separated to pair with each model. |
| `fresh` | `false` | When looping, collapse the conversation between iterations to a brief summary instead of carrying the full context forward. Saves tokens on long loops. |
| `converge` | `true` | When looping, stop early if an iteration makes no file changes. Set `false` to always run every iteration. |
| `boomerang` | `false` | After a non-chain prompt finishes, collapse its execution context back to the branch point with a brief summary. Works with loops, including `fresh` loop summaries. Useful for review prompts like `/double-check`. |

### Delegation

| Field | Default | What it does |
|-------|---------|--------------|
| `subagent` | — | Delegate execution to a subagent instead of running in the current session. `true` uses the default `delegate` agent; a string value like `reviewer` targets that specific agent. Requires [pi-subagents](https://github.com/nicobailon/pi-subagents/). |
| `inheritContext` | `false` | Only meaningful with `subagent`. When `true`, the subagent receives a fork of the current conversation context instead of starting fresh. |
| `cwd` | — | Working directory for delegated subagent subprocesses. Must be an absolute path (`~/...` is expanded). Valid with `subagent` and on chain templates as the default cwd for delegated steps. |
| `bestOfN` | — | Runs bounded independent workers, optional reviewers, and one optional final applier through individual structured subagent requests. See [Best-of-N comparison](#best-of-n-comparison). |

### Best-of-N comparison

Use `bestOfN` when independent answers are useful. Each worker is one structured delegation request. Reviewers receive the successful worker outputs. The optional final applier receives both worker outputs and reviewer findings and returns the user-facing answer.

```yaml
bestOfN:
  workers:
    - agent: delegate
      model: anthropic/claude-sonnet-4-20250514
      count: 2
    - agent: specialist
      taskSuffix: Focus on security and failure modes.
  reviewers:
    - agent: reviewer
  finalApplier:
    agent: synthesizer
```

`agent` and `subagent` are accepted as slot names. A slot may set `model`, `task`, `taskSuffix`, `cwd`, and (for workers or reviewers) a positive `count`. Runtime replace/append overrides are available with `--workers=JSON`, `--workers-append=JSON`, `--reviewers=JSON`, `--reviewers-append=JSON`, and `--final-applier=JSON`. The total number of worker, reviewer, and final-applier requests is bounded at 32 per invocation. Best-of-N does not restore the removed worktree or automatic commit transport.

## Model Format

```yaml
model: claude-sonnet-4-20250514            # bare model ID — auto-selects provider
model: anthropic/claude-sonnet-4-20250514  # explicit provider/model
```

Bare model IDs resolve through a provider priority list: `openai-codex` → `anthropic` → `github-copilot` → `openrouter`. The first provider with valid auth wins.

For explicit control:

```yaml
model: anthropic/claude-opus-4-5        # Direct Anthropic API
model: openai-codex/gpt-5.2             # Via Codex subscription (OAuth)
model: github-copilot/claude-opus-4-5   # Via Copilot subscription
model: openrouter/claude-opus-4-5       # Via OpenRouter
model: openai/gpt-5.2                   # Direct OpenAI API
```

### Model Fallback

Comma-separated lists try each model in order:

```yaml
model: claude-haiku-4-5, claude-sonnet-4-20250514
```

Haiku is tried first. If it can't be found or has no API key, Sonnet is used instead. If the session is already on one of the listed models, that one is kept without switching. When every candidate fails, you get a single error listing what was tried.

You can mix bare IDs and explicit provider specs:

```yaml
model: anthropic/claude-haiku-4-5, openrouter/claude-haiku-4-5, claude-sonnet-4-20250514
```

## Skills

Normally, pi lists available skills in the system prompt, the agent reads your task, decides which skill it needs, and loads it with the read tool. That's an extra round-trip, and the agent might not pick the right one.

The `skill` field bypasses all of that and remains fully backward compatible:

```markdown
---
description: Browser testing mode
model: claude-sonnet-4-20250514
skill: surf
---
$@
```

The skill content is injected as a context message before the agent processes your task. No decision-making, no tool call — immediate expertise. If a requested skill can't be found or read, the command fails fast instead of running without it.

To load multiple skills, use `skills:` as a YAML list:

```markdown
---
description: Go review mode
model: claude-sonnet-4-20250514
skills:
  - tmux
  - golang-style
  - golang-tests
---
Review this change: $@
```

Scalar `skills` values are invalid. Use `skill: tmux` for one skill, not `skills: tmux`. A prompt with invalid `skills` frontmatter is skipped with a diagnostic rather than registered without its requested context.

You can combine `skill` and `skills` during migration or composition. The singular `skill` is loaded first, followed by the list entries:

```yaml
skill: tmux
skills:
  - golang-style
  - golang-tests
# loads: tmux, golang-style, golang-tests
```

After wildcard expansion, duplicate skill names are removed from the final load list; the first requested occurrence wins. For example, `skills: [golang-style, golang-*]` injects `golang-style` only once even if the wildcard also matches it.

Skills are resolved and validated before any deterministic script runs, before model switching, and before the user prompt is sent. That means invalid skill configuration aborts before potentially side-effectful deterministic steps execute.

### Skill Resolution

Skill names accept a bare name or a `skill:` prefix:

```yaml
skill: tmux
skill: skill:tmux    # equivalent
```

The same normalization applies inside `skills:` entries, including wildcard selectors: `skill:golang-*` is equivalent to `golang-*`.

Resolution order:

1. Registered skill commands from `pi.getCommands()` (source: `"skill"`)
2. `<cwd>/.pi/skills/<name>/SKILL.md` or `<cwd>/.pi/skills/<name>.md`
3. `.agents/skills` in the current directory and ancestors (up to the git root, or the filesystem root if no git root is found)
4. `~/.pi/agent/skills/<name>/SKILL.md` or `~/.pi/agent/skills/<name>.md`
5. `~/.agents/skills/<name>/SKILL.md` or `~/.agents/skills/<name>.md`

For direct prompts, `<cwd>` is the Pi session/project cwd. For delegated prompts, frontmatter `cwd:` or runtime `--cwd` selects both the child working directory and the skill-resolution root. Runtime execution, dry-run, and static validation use that same effective delegated cwd. Project skill roots are available only when the session is trusted and the effective delegated cwd resolves inside the real session subtree. Otherwise, only allowed global or registered skill content is embedded.

### Skill wildcards

`skill` and `skills:` entries may use one constrained wildcard form: a non-empty prefix followed by a final `*`. This means `skill: golang-*` is valid too; it can inject more than one matching skill while preserving the same ordering and de-dupe rules.

```yaml
skills:
  - golang-*
  - repo-review
```

This is prefix matching, not general globbing. `golang-*` is valid; `*`, `go**`, `go*lang`, `go?*`, path-like selectors, and selectors containing whitespace or XML/quote characters are rejected.

Wildcard expansion searches the same skill sources as exact skill resolution, in the same source order. Within each source, matches are sorted lexically by normalized skill name. If the same normalized name appears in more than one source, the first source wins. If a wildcard matches nothing, prompt execution aborts with an error such as `No skills matched "golang-*"`.

Wildcard discovery is bounded to direct skill entries only: direct `name.md` files and direct `name/SKILL.md` directories. It does not recursively scan nested directories.

Skill-to-skill references are not recursive in v1. Loaded skills are treated as Markdown content only; if a skill mentions another skill in prose, frontmatter, `related_skills`, or other metadata, that other skill is not loaded automatically. Add every required skill to the prompt's `skill`/`skills` frontmatter explicitly.

### Skills with chains and subagents

`skill` and `skills` apply to direct prompt execution.

Chain wrapper templates ignore `skill` and `skills`; put skill frontmatter on the step templates instead. When a chain runs a step, that step uses its own skill configuration.

Delegated prompts can combine `subagent:` with `skill` or `skills`. The host resolves and trust-checks each selector against the effective delegated cwd, includes the exact resolved content in budget checks, and embeds that content in the delegated task. It does not send skill names for the child to resolve again, because a same-name project skill could otherwise replace the content that the host approved. Runtime `--subagent` uses the same single-task behavior for direct prompts and chain steps; runtime `--fork` uses it for direct prompts, while chain steps use their own `inheritContext` frontmatter.


## Prompt includes

Prompt includes let you write the common parts of your prompts once and reuse them. Put shared Markdown in partials, then pull those partials into any prompt that needs them.

### Prompt library

`.pi/prompt-library/` is an extension-managed prompt library. Pi core does not load files from this directory. If you want a file managed only by this extension rather than Pi core, place it in `.pi/prompt-library/` instead of `.pi/prompts/`.

User prompt-library files live at `~/.pi/agent/prompt-library/` (that is the current OS user's home directory as reported by the runtime, not the repository root).

Prompt-library files can be executable extension prompt templates, chain steps, or include targets. A prompt-library file becomes an extension command only when it is command-capable under the same rules as `.pi/prompts` templates: for example, it has extension frontmatter such as `model`, `chain`, `skill`, `skills`, `include`, `includes`, or other supported extension fields. Plain Markdown fragments under `partials/` are intended to be included and should not appear as slash commands, chain steps, or dry-run targets. The `partials/` directory name is a convention, not an enforced policy: any plain, non-command-capable prompt-library Markdown file can be included, and command-capable files can live under any non-hidden directory.

Set `hidden: true` on command-capable prompt-library files that should stay internal. Hidden commands are not registered as top-level slash commands and do not appear in the dry-run picker, but they can still be opened by exact `/print-prompt <name>` / `/dry-run-prompt <name>` and referenced by chains. Project prompt-library trust approval still applies when a hidden project-library step executes through a chain.

Dot-prefixed files and directories under prompt-library roots are ignored. Symlinks are followed only when their resolved target remains inside the canonical prompt root; symlinks that escape the root are skipped.

Project prompt-library commands require extension-side per-session UI approval before execution. This approval is separate from Pi's project trust state: even trusted projects still need the extension approval for commands loaded from `.pi/prompt-library/`. Non-UI/headless contexts cannot show that prompt, so move commands that must run headlessly in trusted projects to a core prompt root such as `.pi/prompts/`; keep `.pi/prompt-library/` for UI-approved project commands and include-only fragments.

For example, a project prompt can include a standards fragment from the project prompt library:

```text
.pi/prompts/review.md
.pi/prompt-library/partials/repo-standards.md
```

```markdown
---
description: Review with shared repo standards
model: claude-sonnet-4-20250514
include: partials/repo-standards.md
---
Review this change: $@
```

With that layout, `.pi/prompts/review.md` resolves `partials/repo-standards.md` to `.pi/prompt-library/partials/repo-standards.md` when no closer match exists. Included prompt-library files insert only their Markdown body; frontmatter such as `description`, `model`, `skill`, or `skills` is not inherited by the including prompt.

### Syntax

Use `includes:` for the shared block you want at the top of a prompt:

```markdown
---
description: Review with shared repo rules
model: claude-sonnet-4-20250514
includes:
  - shared/repo-rules.md
  - shared/review-checklist.md
---
Review this change: $@
```

If the body has no `<includes />` marker, Pi prepends the rendered partials:

```markdown
<rendered shared/repo-rules.md>

<rendered shared/review-checklist.md>

Review this change: $@
```

Add `<includes />` when the shared block belongs somewhere else:

```markdown
---
model: claude-sonnet-4-20250514
includes:
  - shared/context.md
  - shared/checklist.md
---
Start with the project-specific context.

<includes />

Now answer the user's request: $@
```

For one partial, `include:` is shorter:

```markdown
---
model: claude-sonnet-4-20250514
include: shared/repo-rules.md
---
Apply the shared rules above, then inspect: $@
```

Use an inline include when the partial belongs at an exact spot in the prompt:

```markdown
---
model: claude-sonnet-4-20250514
includes:
  - shared/repo-rules.md
---
<includes />

Focus area:
<include file="languages/typescript.md" />

Task: $@
```

Partials can include other partials with the same inline syntax.

### Partial roots and resolution order

Include paths are local `.md` files. Resolution starts next to the file that asked for the include. For frontmatter `include` / `includes` and inline includes in the prompt body, that means the prompt file. For nested inline includes, it means the current partial.

If Pi does not find the file there, it checks these roots in order:

1. Current file directory
2. Current owner root
3. Original prompt root
4. Project prompt-library (project prompts only; user/global prompts do not fall back into the current project's prompt library)
5. User prompt-library
6. Global prompt-partials
7. Project prompt-partials

Example project layout:

```text
<cwd>/.pi/prompts/review.md
<cwd>/.pi/prompts/shared/repo-rules.md
<cwd>/.pi/prompt-library/partials/repo-standards.md
~/.pi/agent/prompt-partials/shared/review-checklist.md
<cwd>/.pi/prompt-partials/languages/typescript.md
```

With that layout, the project prompt `.pi/prompts/review.md` can include `shared/repo-rules.md`, `partials/repo-standards.md`, `shared/review-checklist.md`, and `languages/typescript.md` without absolute paths. The project-library fallback (`partials/repo-standards.md`) applies because `review.md` is a project prompt; a user prompt from `~/.pi/agent/prompts/` would not search `<cwd>/.pi/prompt-library/` for that include.

### Rules and guardrails

- Partials must be Markdown files (`.md`).
- Includes are local files. URLs and globs are rejected, even if a local file happens to have that name.
- Nested includes work. Cycles do not: Pi skips the command and reports a diagnostic.
- Include expansion stops after 64 nested levels. If a chain goes deeper, Pi skips the command and points the diagnostic at the partial with the include that crossed the limit.
- Partial frontmatter is stripped and ignored. Put active `include` / `includes` metadata on prompt templates, not inside partials. For nesting, use `<include file="..." />` in the partial body.
- Missing or invalid includes skip command registration. Broken slash commands should fail loudly, not register half-rendered prompts.
- `chain:` wrapper templates cannot use frontmatter `include` or `includes` in v1. Put includes on the step templates instead.
- `~/...` paths are allowed only when they resolve under a Pi prompt root or prompt-partials root. Other absolute paths are rejected.
- Include boundary comments appear only in debug/diagnostic mode. Normal prompt content does not contain `<!-- BEGIN include ... -->` / `<!-- END include ... -->` comments.
- Prompt and prompt-library command names are still plain basenames. There is no source or directory namespace for slash commands; if two effective templates use the same basename, normal source precedence/duplicate handling decides which one registers.
- `validate-prompts` validates extension-visible prompts, command-capable prompt-library files, and include graphs. It is not a general filesystem audit; plain unreferenced fragments are ignored except when they are pulled into an include graph.

## Inline Model Conditionals

Prompt bodies can include sections that only render for specific models:

```markdown
---
description: Cross-model code review
model: claude-haiku-4-5, claude-sonnet-4-20250514
---
Summarize the change first.

<if-model is="claude-haiku-4-5">
Keep the answer brief and cost-conscious.
<else>
Do a deeper pass and call out subtle risks.
</if-model>
```

Conditionals evaluate against whichever model actually runs — after fallback resolution for multi-model templates, or against the session model when `model` is omitted.

The `is` attribute supports exact model IDs, `provider/model-id` pairs, provider wildcards like `anthropic/*`, and comma-separated combinations:

```markdown
<if-model is="anthropic/*">Anthropic-specific instructions</if-model>
<if-model is="openai/gpt-5.2, anthropic/*">Either OpenAI or Anthropic</if-model>
```

`<else>` is the fallback branch. Nested `<if-model>` blocks work.

## Argument Substitution

Prompt bodies support placeholders that expand to the arguments passed after the command name:

| Placeholder | Expands to |
|-------------|------------|
| `$1`, `$2`, ... | The Nth argument (1-indexed) |
| `$@` or `@$` or `$ARGUMENTS` | All arguments joined with spaces |
| `${@:N}` | All arguments from position N onward |
| `${@:N:L}` | L arguments starting from position N |

```markdown
---
model: claude-sonnet-4-20250514
---
Analyze $1 focusing on $2. Additional context: ${@:3}
```

`/analyze src/main.ts performance edge cases error handling` expands `$1` to `src/main.ts`, `$2` to `performance`, and `${@:3}` to `edge cases error handling`.

## Delegated Subagent Execution

Instead of running a prompt in the current session, you can hand it off to a subagent:

```markdown
---
model: anthropic/claude-sonnet-4-20250514
subagent: true
---
Review and simplify this code: $@
```

`subagent: true` delegates to the default `delegate` agent. To target a specific agent:

```markdown
---
model: anthropic/claude-sonnet-4-20250514
subagent: reviewer
inheritContext: true
---
Audit this diff for correctness and edge cases: $@
```

`inheritContext: true` forks the current conversation so the subagent has full context. Without it, the subagent starts fresh.

To force a subagent into a specific working directory, add `cwd`:

```markdown
---
model: claude-sonnet-4-20250514
subagent: browser-screenshoter
cwd: /tmp/screenshots
---
Use url in the prompt to take screenshot: $@
```

The subagent process runs with `/tmp/screenshots` as its working directory. Paths must be absolute (`~/...` is expanded). The directory is validated at execution time.

During execution, a live progress widget appears above the editor showing elapsed time, tool count, token usage, and the current tool. When the run finishes, it's replaced by a completion card with the task preview, aggregate tool count, output, and usage stats.

You can override delegation at runtime per invocation with `--subagent`, `--subagent=<name>`, `--subagent:<name>`, or `--cwd=<path>`. `--cwd=<path>` must be absolute after optional `~/...` expansion. Runtime flags take precedence for that invocation only.

Two additional runtime flags work for any prompt (not just delegated ones):

- `--model=provider/model-id` — override the template's `model` for this invocation. Works with single execution, loops, and delegation.
- `--fork` — run with `inheritContext` (forked context). Implies `--subagent` if not already set.

```
/double-check --model=anthropic/claude-opus-4-6
/double-check --fork --subagent:worker
/deslop --model=openai/gpt-5.4 --loop 3
```

## Packaged prompt examples

This repo ships copyable starter prompts under `examples/`:

- `examples/hello.md` installs as `/hello` and uses the current session model with no skills.
- `examples/review.md` installs as `/review` and gives a simple skill-free review checklist.

Installing these examples is optional. The first-run `hello.md` above works without copying packaged examples; copy these only when you want starter templates to edit.

Use a repo checkout when you have one:

```bash
REPO=/path/to/your/pi-prompt-workflows-checkout
mkdir -p ~/.pi/agent/prompts
cp "$REPO/examples/hello.md" ~/.pi/agent/prompts/hello.md
cp "$REPO/examples/review.md" ~/.pi/agent/prompts/review.md
```

Or copy from the published npm tarball without guessing where Pi installed the package:

```bash
TMPDIR=$(mktemp -d)
npm pack pi-prompt-workflows --pack-destination "$TMPDIR"
tar -xzf "$TMPDIR"/pi-prompt-workflows-*.tgz -C "$TMPDIR"
mkdir -p ~/.pi/agent/prompts
cp "$TMPDIR/package/examples/hello.md" ~/.pi/agent/prompts/hello.md
cp "$TMPDIR/package/examples/review.md" ~/.pi/agent/prompts/review.md
```

After copying files, restart `pi` if it is already running. Check minimal prompts with a read-only preview before executing them:

```text
/dry-run-prompt hello --plain
/hello
/dry-run-prompt review --plain src/server.ts
```

## Deterministic Steps

Prompt templates can run one deterministic command or script before any optional LLM turn. Use this when the first step should be direct code, not model latency.

The flow is simple:

1. Run one command or script.
2. Always render a visible deterministic result card with the command, exit code, duration, and stdout/stderr previews.
3. Optionally hand the structured result to the model as a `[Deterministic step]` preamble before the prompt body.
4. If `handoff: never`, stop after the result card and a visible completion marker — no LLM turn happens.

That handoff preamble is intentionally structured and uses stable field names like `status`, `executionKind`, `command`, `cwd`, `exitCode`, `signal`, `durationMs`, `timedOut`, `lineCount`, `charCount`, `truncated`, `omittedChars`, and `preview`.

V1 scope is intentionally narrow: deterministic execution only works on single prompt templates. It does not combine with chain templates, delegated/subagent prompts, `parallel`, or loops. At runtime, deterministic prompts explicitly reject `--loop`, `--subagent`, and `--fork` in v1.

### Authoring forms

You can write deterministic steps as **top-level shorthand** or **nested under `deterministic:`**. Both are equivalent. Use shorthand for brevity, nested when you want everything grouped under one key.

**Top-level shorthand** — put `run`, `script`, `handoff`, `timeout`, `cwd`, `env`, and `nonInteractive` directly in frontmatter:

```markdown
---
run: git push origin HEAD:main
handoff: on-failure
timeout: 30000
---
If the push failed, explain why and suggest the next step.
```

You can also use `script:` as shorthand:

```markdown
---
script: ./scripts/ship.sh
handoff: always
timeout: 15000
---
Summarize the script result.
```

**Nested form** — group everything under `deterministic:`:

```markdown
---
model: claude-sonnet-4-20250514
deterministic:
  script:
    path: ./scripts/ship.sh
    args:
      - --fast
  handoff: always
  timeout: 15000
  cwd: ~/src/my-repo
---
Summarize the script result and call out anything risky.
```

**Structured command form** — when you need explicit args instead of a single shell string, use `deterministic.run.command` with `args`:

```markdown
---
model: claude-sonnet-4-20250514
deterministic:
  run:
    command: git
    args: [status, --short]
  handoff: always
---
Interpret the repo state.
```

Do not mix top-level shorthand with nested `deterministic:` in the same prompt. Pick one style.

### Model requirement

Deterministic prompts that hand off to the model (`handoff: always`, `on-success`, or `on-failure`) need a model to continue into. You can either:

- Add a `model:` field explicitly
- Omit `model:` and let the prompt inherit whatever model is currently active

`handoff: never` prompts do not need a model field because they never reach the LLM.

### Handoff values

- `always` — always continue into the LLM after the deterministic card is emitted.
- `never` — stop after the deterministic card and completion marker.
- `on-success` — continue only when the command exits `0`.
- `on-failure` — continue only when the command exits non-zero.

Command descriptions in the slash-command picker show this feature as `deterministic-step:<handoff>`.

### Timeout

`timeout` is in milliseconds. When a timeout fires, the runner sends `SIGTERM` first. If the process still has not exited after a short grace window, it escalates to `SIGKILL`.

### Script path resolution

Relative script paths resolve from the prompt file's directory first, then fall back to the command invocation `cwd`. Absolute script paths also work.

### Environment and non-interactive mode

You can provide explicit environment variables and control the runner's non-interactive guardrails:

```markdown
---
deterministic:
  run: ./deploy.sh
  handoff: never
  nonInteractive: false
  env:
    SPECIAL_TOKEN: abc123
    RETRIES: 2
---
```

`nonInteractive` defaults to `true`. In that mode the runner keeps stdin ignored and adds a few guardrail environment defaults such as `CI=1`, `GIT_TERMINAL_PROMPT=0`, `PAGER=cat`, and `GIT_PAGER=cat`. Set `nonInteractive: false` when the command needs a more normal process environment and you explicitly want to opt out of those defaults. Explicit `env` values override the built-in defaults.

### Output capping

Large stdout/stderr streams are capped before they are stored in the conversation card payload. The card and the LLM handoff block both show the total character and line counts plus explicit truncation metadata when output was capped.

## Loop Execution

Run a template multiple times with `--loop`:

```
/deslop --loop 5
/deslop --loop=5
/deslop --loop          # unlimited — runs until convergence or cap (999)
```

You can also set a default in frontmatter. CLI `--loop` always overrides:

```markdown
---
loop: 5
---
```

Use `loop: unlimited` (or `loop: true`) for open-ended loops that run until convergence, user interrupt, or the safety cap of 999 iterations:

```markdown
---
loop: unlimited
converge: false
fresh: true
subagent: true
---
```

### How looping works

Each iteration runs the same prompt. By default, context accumulates — iteration 3 sees the full conversation from iterations 1 and 2 and builds on that work.

**Convergence**: If an iteration makes no file changes (no `write` or `edit` tool calls), the loop stops early. This is on by default. Use `--no-converge` or `converge: false` to always run every iteration.

**Fresh context**: Add `--fresh` (or `fresh: true` in frontmatter) to collapse the conversation between iterations. Each iteration gets a clean slate with only brief summaries of what previous iterations did. Good for long loops where accumulated context would blow up the token count.

**Status**: The TUI status bar shows `loop 2/5` during execution.

Model, thinking level, and skill are maintained throughout. If `restore: true` (the default), everything is restored after the final iteration.

## Model Rotation

`rotate: true` turns a comma-separated `model` list from a fallback chain into a cycling list. Each loop iteration uses the next model in the list, wrapping around:

```markdown
---
model: claude-opus-4-6, gpt-5.4, gpt-5.3-codex
thinking: high, xhigh, off
loop: 9
rotate: true
fresh: true
---
Review and fix issues in this codebase.
```

Iteration 1 runs Opus + `high`, iteration 2 runs GPT-5.4 + `xhigh`, iteration 3 runs Codex + `off`, then wraps back to Opus. The status bar shows which model is active: `loop 2/9 · gpt-5.4 xhigh`.

This is especially useful for [ralph-style loops](https://ghuntley.com/ralph/) where different models catch different things. The `subagent` examples below require [pi-subagents](https://github.com/nicobailon/pi-subagents/). A single-model ralph loop that delegates with fresh context each iteration:

```markdown
---
model: claude-sonnet-4-20250514
subagent: true
inheritContext: true
loop: 5
fresh: true
---
Simplify this code: $@
```

Add `rotate` and multiple models to cycle different perspectives on each pass:

```markdown
---
model: claude-opus-4-6, gpt-5.4, gpt-5.3-codex
thinking: xhigh, high, high
loop: 9
rotate: true
fresh: true
subagent: true
---
Review and fix issues in this codebase.
```

Each iteration gets fresh context, a different model, and its own thinking level. Convergence stops the loop when an iteration makes no file changes — use `converge: false` to guarantee every model gets at least one shot.

`thinking` pairing with `rotate: true`:

- Single value (`thinking: high`) — applied to every model.
- Comma-separated (`thinking: high, xhigh, off`) — positional, must match the number of models.
- Omitted — each iteration inherits the session default.

Without `loop`, `rotate` has no effect and comma-separated `model` keeps normal fallback behavior.

## Adaptive Chains

Adaptive chains are a structured, deterministic alternative to legacy string chains. They select one action at a time from normalized execution evidence; they never parse model prose and do not support arbitrary expressions.

```yaml
---
description: Implement, test, repair once, then review final changes
chain:
  - id: implement
    prompt: adaptive-implement
  - id: review-implementation
    prompt: adaptive-review
    when: changed
  - id: test
    run: adaptive-test
    onSuccess: done
    onFailure: fix
  - id: fix
    prompt: adaptive-fix
  - id: review-fix
    prompt: adaptive-review
    when: changed
  - id: retest
    run: adaptive-test
    onSuccess: done
    onFailure: done
    onBlocked: done
  - id: done
    run: adaptive-status
limits:
  maxSteps: 7
  maxModelCalls: 4
---
```

Each list item sets exactly one of `prompt` or `run`. `id` is optional: when omitted, the trimmed target name is the stable generated ID. Use an explicit non-empty `id` when a target appears more than once, as above. IDs must be unique. `onSuccess`, `onFailure`, and `onBlocked` name step IDs; omitting the matching transition falls through to the next declared step, and falling through after the last step ends the chain. Gates are `always` (default), `changed`, `succeeded`, and `failed`. Outcomes are normalized by the runtime to `succeeded`, `failed`, `blocked`, or `skipped`; `blocked` is an explicit guardrail/refusal outcome, not text inferred from an answer. Gate-skipped steps execute nothing.

`limits` is optional but always effective. Defaults are `maxSteps: 10` and `maxModelCalls: 5`; author values must be positive safe integers and cannot exceed the hard caps `maxSteps: 100` and `maxModelCalls: 50`. Every selected prompt consumes exactly one model call. Selected `run` actions and gate-skipped actions consume zero. Prompt targets that can expand into multiple top-level calls are rejected: nested or adaptive chains, loops, delegated/subagent or inherited-context prompts, boomerang prompts, and deterministic handoffs. A `run` target must be deterministic with `handoff: never`; a `prompt` target must not be deterministic.

### Verified changed-state semantics

Adaptive execution snapshots the effective Git worktree before and after each selected action and compares the final repository-visible state. This is not based on tool-call or child self-report. The comparison covers HEAD identity, the complete index tree, staged/index entries, tracked worktree content, symlinks, and all untracked files reported by Git. Pre-dirty work is preserved: an action counts as changed only if the before and after snapshots differ, so mutate-then-restore is unchanged while modifying an already-dirty file is changed. A readable Git worktree is required wherever changed evidence is needed. Every capture has one aggregate 10-second monotonic deadline shared by all bounded Git calls; optional locks, fsmonitor, pagers, external diff helpers, and interactive prompting are suppressed. Snapshot/read/race/timeout errors fail closed; dirty submodules are rejected rather than guessed at. Validation deduplicates canonical effective cwd probes and applies one aggregate 10-second deadline plus a 64-unique-cwd cap, failing closed when either bound is reached.

### Preflight, operation, and troubleshooting

Use these read-only commands before execution:

```text
/validate-prompts
/print-prompt adaptive-fix-review --plain <task>
/dry-run-prompt adaptive-fix-review --plain <task>
```

The plain report and Pi TUI inspector show the bounded graph, gates/transitions, target kinds, effective cwd/model/skills/includes/budgets, completing-path call and token bounds, reachable exhaustion, and whether graph analysis was complete. Static analysis is capped at 4,096 enqueued states; exceeding it is reported as **inconclusive** and blocks preflight rather than presenting conservative bounds as exact. Validation and dry-run are read-only snapshots: they do not execute commands, capture full runtime snapshots, approve trust, switch models, or send messages. Runtime reloads/re-resolves targets and revalidates models, skills, budgets, cwd, target mode, limits, and Git snapshots before dispatch, so files or availability can change after preview.

Only one adaptive chain is allowed in flight for the extension. Cancellation is checked before routing, before dispatch, after snapshots, and after an action; the partial report is retained. Child command cleanup uses the deterministic runner's TERM-then-KILL behavior. On Unix this targets the managed child/process group where available, but no API can guarantee cleanup of a daemon that deliberately detaches itself. Windows uses the platform's available child termination fallback and cannot promise Unix signal/process-group semantics. Snapshot failure, malformed/reloaded targets, missing targets, unsupported modes, and report errors fail closed instead of bypassing routing checks.

Packaged starters are `examples/adaptive-fix-review.md` (plus its hidden companion targets) and `examples/adaptive-validation-review.md`. Copy the complete adaptive example set so target names resolve. Their deterministic checks are hardened read-only Git commands: the staged-only whitespace check `git --no-optional-locks -c core.fsmonitor=false --no-pager diff --cached --no-ext-diff --no-textconv --check`, plus status companions that combine `git --no-optional-locks -c core.fsmonitor=false ls-files --modified --deleted --others --exclude-standard` with `git --no-optional-locks -c core.fsmonitor=false --no-pager diff --cached --name-status --no-ext-diff --no-textconv --`. Thus staged additions, deletions, renames, and modifications are reported alongside worktree/untracked changes. The packaged whitespace check intentionally does not inspect unstaged content, because configured conversion filters can execute while Git prepares an unstaged diff. These commands disable configured external diff/textconv/pager helpers and fsmonitor/index-refresh side effects, never invoke package lifecycle/config hooks, and never hand off to another model. Prompt/model steps can edit by design: implementation and fix prompts may mutate the worktree, while the companion review prompt explicitly requests findings only.

To migrate `chain: analyze -> fix -> review`, replace the scalar with a list of `{prompt: ...}` entries. With no gates/transitions, natural fallthrough preserves sequential intent, but adaptive limits and Git snapshot requirements still apply. Keep legacy string chains when you need supported looping, single delegation, shared arguments, or chain-context behavior; structured adaptive chains deliberately do not emulate those multi-call modes.

Common failures: `target missing` means copy/install the companion prompt; `kind mismatch` means use `run` only for deterministic `handoff: never` targets; `changed requires Git` means run from or set an effective cwd inside a Git worktree; `analysis inconclusive` means simplify branching; limit exhaustion means increase a configured limit within the hard cap or shorten the path. Project/user, hidden, duplicate, reserved-name, and prompt-library trust precedence is exactly the normal effective prompt catalog—hidden affects discovery, not target authority.

## Chaining Templates

`/chain-prompts` runs multiple templates in sequence. Each step uses its own model, skill, and thinking level, while conversation context flows between them:

```
/chain-prompts analyze-code -> fix-plan -> summarize -- src/main.ts
```

This runs `analyze-code`, then `fix-plan` (which sees the analysis), then `summarize`. The ` -- ` separator marks shared args — everything after it is passed to each step as `$@`, unless a step has its own inline args:

```
/chain-prompts analyze-code "error handling" -> fix-plan -> summarize -- src/main.ts
```

Step 1 gets `"error handling"` as its args. Steps 2 and 3 fall back to the shared `"src/main.ts"`.

The chain captures your model and thinking level before starting and restores them when finished (or if any step fails).

### Chain Templates

For reusable pipelines, put the chain in frontmatter:

```markdown
---
description: Review then clean up
chain: double-check --loop 2 -> deslop --loop 2
---
```

This registers the file's name as a command that runs `double-check` twice, then `deslop` twice. Per-step `--loop N` repeats that step before moving to the next, with per-step convergence (stops early if no changes, unless the step's template has `converge: false`).

Steps with a `model` field use their own model. Steps without one inherit a snapshot of whatever model was active when the chain started — not the previous step's model. This keeps behavior deterministic regardless of what earlier steps do.

Chain templates support `loop`, `fresh`, `converge`, `restore`, and `cwd` in their frontmatter for controlling the overall execution:

```markdown
---
chain: analyze -> fix
loop: 3
fresh: true
converge: false
---
```

This runs the full analyze → fix chain 3 times, with fresh context between iterations and no early stopping. Chain nesting is not supported — steps can't reference other chain templates.

When a chain template sets `cwd`, it becomes the default delegated subprocess working directory for all delegated steps in that chain. Runtime `--cwd=<path>` overrides the chain template value.

### Chain context for delegated steps

Delegated chain steps start fresh — they don't see what earlier steps did. Chain context prepends a compact summary of previous steps to each delegated task so later steps can build on earlier work.

Enable it chain-wide with `chainContext: summary` in frontmatter or `--chain-context` on the CLI:

```markdown
---
chain: analyze -> fix
chainContext: summary
---
```

```
/chain-prompts analyze -> fix --chain-context
```

To enable it for a single step, attach `--with-context` to that step name:

```
/chain-prompts analyze -> reviewer --with-context -> summarize
```

Here only `reviewer` receives the summary of `analyze`. The `summarize` step does not.

Steps using `inheritContext: true` already fork the full parent conversation and skip the summary preamble. When a chain uses `loop`, summaries reset each iteration.

### Looping from the CLI

Looping applies to the entire chain:

```
/chain-prompts analyze -> fix --loop 3
/chain-prompts analyze -> fix --loop 3 --fresh
/chain-prompts analyze -> fix --loop 3 --no-converge
/chain-prompts analyze -> fix --loop
```

Convergence applies across all steps in each iteration — if no step made file changes, the loop stops. Templates are re-read from disk between iterations, so edits take effect live.

## Agent Tool

The agent can invoke prompt templates itself via a `run-prompt` tool. It's off by default:

```
/prompt-tool on
```

Once enabled, the agent sees `run-prompt` in its tool list:

```
run-prompt({ command: "deslop --loop 5 --fresh" })
run-prompt({ command: "chain-prompts analyze -> fix --chain-context" })
run-prompt({ command: "chain-prompts analyze -> fix --loop 3" })
run-prompt({ command: "deslop --subagent" })
```

The tool queues the command for execution after the agent's current turn ends. All loop, chain, and convergence features work the same as slash commands.

You can add guidance to steer when the agent reaches for it:

```
/prompt-tool on Use run-prompt for iterative code improvement tasks
/prompt-tool guidance Use sparingly, only for multi-pass refinement
/prompt-tool guidance clear
/prompt-tool off
/prompt-tool                   # show current status
```

Config persists across sessions in `~/.pi/agent/prompt-template-model.json`.

## Autocomplete

Commands show their configuration in the autocomplete description:

```
/debug-python    Debug Python session [sonnet +tmux] (user)
/deep-analysis   Deep code analysis [sonnet high] (user)
/save-progress   Save progress doc [haiku|sonnet] (user)
/component       Create React component [sonnet] (user:frontend)
```

## Subdirectories

Organize prompts in subdirectories for namespacing:

```
~/.pi/agent/prompts/
├── quick.md                    → /quick (user)
├── debug-python.md             → /debug-python (user)
└── frontend/
    ├── component.md            → /component (user:frontend)
    └── hook.md                 → /hook (user:frontend)
```

The subdirectory shows as the source label in autocomplete. Command names are based on filename only. Duplicates within the same source layer are skipped with a warning, as are reserved names like `model`, `reload`, and `chain-prompts`.

## Print Mode

These commands work in `pi -p` too:

```bash
pi -p "/debug-python my code crashes on line 42"
```

The model switches, skill is injected, the agent responds, and output goes to stdout. Useful for scripting or piping.

## Examples

**Thinking levels** — max thinking for thorny analysis:

```markdown
---
description: Deep code analysis with extended thinking
model: claude-sonnet-4-20250514
thinking: high
---
Analyze this code thoroughly, considering edge cases and potential issues: $@
```

**Sticky mode switch** — switch models for the rest of the session:

```markdown
---
description: Switch to Haiku for this session
model: claude-haiku-4-5
restore: false
---
Switched to Haiku. How can I help?
```

**Cross-provider fallback** — try the same model on different providers:

```markdown
---
description: Quick analysis
model: anthropic/claude-haiku-4-5, openrouter/claude-haiku-4-5
---
$@
```

## Release process

Releases are managed with [Release Please](https://github.com/googleapis/release-please) from conventional commits on `main`.

1. Land normal commits such as `feat:`, `fix:`, `docs:`, or `chore:`.
2. Release Please opens a release PR that updates `package.json`, `package-lock.json`, `CHANGELOG.md`, and the release manifest.
3. Merge the release PR to create the GitHub Release/tag.
4. The publish workflow verifies the tag matches `package.json`, runs the Node 24 test suite, checks production audit, verifies package contents, and publishes to npm with provenance through trusted publishing.

## Limitations

- Prompt files are reloaded on session start and whenever an extension-owned command runs. If you add a new prompt file mid-session, run any extension command (like `/chain-prompts`), start a new session, or reload pi to pick it up.
- Model restore state is in-memory. Closing pi mid-response loses it.
- Adaptive-chain preflight graph analysis is deterministically capped at 4,096 enqueued states. If that limit is reached, preflight fails closed with an inconclusive-analysis diagnostic and reports only conservative, unavailable-as-exact bounds; the execution router and its configured `maxSteps`/`maxModelCalls` limits are unchanged.
- Adaptive preflight is a read-only snapshot of skills, referenced files, model availability, and estimated prompt costs. Runtime revalidates those inputs before execution; preflight output is not an immutable approval or availability guarantee.
- In chains, model-less steps inherit the chain-start model snapshot, not the previous step's model. This is intentional for deterministic behavior.
- Delegated `subagent` prompts require [pi-subagents](https://github.com/nicobailon/pi-subagents/).
- `run-prompt` must be explicitly enabled with `/prompt-tool on`.
