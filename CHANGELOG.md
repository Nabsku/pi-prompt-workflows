# Changelog

## [0.14.0](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.13.1...v0.14.0) (2026-06-22)


### Features

* add best-of-n preset resolution ([e0f45e6](https://github.com/Nabsku/pi-prompt-workflows/commit/e0f45e64490e6874e6693e7b6450954d7f9dde64))


### Bug Fixes

* address best-of-n preset review comments ([0dfdf80](https://github.com/Nabsku/pi-prompt-workflows/commit/0dfdf8065c0a241f0786f7271800b1c877b117cc))
* close preset review edge cases ([df85bf3](https://github.com/Nabsku/pi-prompt-workflows/commit/df85bf3d86c2f43bcbec8d9fdb150e2fde37e61f))
* close preset validation review gaps ([1822061](https://github.com/Nabsku/pi-prompt-workflows/commit/1822061ae90ee9b5ee2d7ea222ce9cabc9698e79))
* harden best-of-n preset overrides ([caa0981](https://github.com/Nabsku/pi-prompt-workflows/commit/caa0981936d5e264f5e2dd334d9f0e1abe59aa59))
* harden project preset resolution ([04cddc9](https://github.com/Nabsku/pi-prompt-workflows/commit/04cddc919256b0c40b28a51b67c185a592f899fb))
* prevent invalid project presets from falling through ([8b0f589](https://github.com/Nabsku/pi-prompt-workflows/commit/8b0f5899ca5ebd1350218cd0d87d24af891a9656))
* validate presets from prompt cwd ([ce97729](https://github.com/Nabsku/pi-prompt-workflows/commit/ce9772947bf31abbc1fc4481bdc13bf51385da62))

## [0.13.1](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.13.0...v0.13.1) (2026-06-21)


### Bug Fixes

* harden prompt-library parity coverage ([1666691](https://github.com/Nabsku/pi-prompt-workflows/commit/16666916eff1757cefa4b743cdbb18ea704b95a5))

## [0.13.0](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.12.0...v0.13.0) (2026-06-21)

### Prompt library

* Added `.pi/prompt-library` and `~/.pi/agent/prompt-library` roots for reusable prompt commands, chain steps, and include fragments ([b5e235b](https://github.com/Nabsku/pi-prompt-workflows/commit/b5e235b099df3a4089b196a3e482c64e545f5bbb), [4eba6b3](https://github.com/Nabsku/pi-prompt-workflows/commit/4eba6b3c98b83d50ab167e66eb26c782ade00d99)).
* Prompt-library commands now support validation, source summaries, dry-run/TUI labels, and includes from library-local fragments ([7dec4c8](https://github.com/Nabsku/pi-prompt-workflows/commit/7dec4c8bc2f774fa6451c842f9ee12cc875de648), [5468b16](https://github.com/Nabsku/pi-prompt-workflows/commit/5468b16e19ac1e556980f9a5416fc574be055aeb), [ceda208](https://github.com/Nabsku/pi-prompt-workflows/commit/ceda208e9f027d7a45c600bf2bcfb36d4552f55e)).
* Added `hidden: true` for internal prompt-library commands: hidden commands stay out of slash-command discovery and pickers, but remain addressable by exact dry-run/print lookup and chain references ([413ef55](https://github.com/Nabsku/pi-prompt-workflows/commit/413ef55ac8c3bafe61c8b1a3d560eb644e7e7d15)).

### Hardening and compatibility

* Tightened project prompt-library trust boundaries, including chain preflight approval and safer handling of project library includes ([c1198cf](https://github.com/Nabsku/pi-prompt-workflows/commit/c1198cf918045db38d2d7c8f767e1be82843f634), [40c4458](https://github.com/Nabsku/pi-prompt-workflows/commit/40c44587ff8a94e2f6d6d94f13a9c2894503d35b)).
* Hardened prompt-library loading around symlinks, dot-prefixed entries, invalid metadata, include-only fragments, and stale hidden command handlers ([94c8bdd](https://github.com/Nabsku/pi-prompt-workflows/commit/94c8bddcba1d16502676d34f47fccbeb3235fd05), [b62cbec](https://github.com/Nabsku/pi-prompt-workflows/commit/b62cbecbeaf25ecef66abf14c6e71bca03c40c3c), [ace7651](https://github.com/Nabsku/pi-prompt-workflows/commit/ace76519fcea80a20b217ce82e62a201ad0afa06)).
* Plain prompt-library fragments now stay quiet unless included, while valid thinking-only and model-conditional library commands still load normally ([c353e1e](https://github.com/Nabsku/pi-prompt-workflows/commit/c353e1e0d10377e94bae763084efd1f9ac398260), [f2e8850](https://github.com/Nabsku/pi-prompt-workflows/commit/f2e8850ea2c5be080d7c73764303f5fabdcd1c44), [8808b05](https://github.com/Nabsku/pi-prompt-workflows/commit/8808b05eeafd226adfb5a57a07c195d0550fe4e8), [dea05fc](https://github.com/Nabsku/pi-prompt-workflows/commit/dea05fc9b27755f9407976e4028f77704e27e044)).
* Validation source summaries now count broken, skipped, duplicate, empty-model, invalid-marker, and shadowed library commands consistently instead of misreporting them as fragments or dropping them ([354bea9](https://github.com/Nabsku/pi-prompt-workflows/commit/354bea956a13e0845167246f4ba68778db5ce6b8), [126ab9b](https://github.com/Nabsku/pi-prompt-workflows/commit/126ab9bbe2149f1c6c78967ded308f56f933a6e7), [fd028ca](https://github.com/Nabsku/pi-prompt-workflows/commit/fd028ca1ad78f329ef1d9325158d66a2541701e4), [0fc6877](https://github.com/Nabsku/pi-prompt-workflows/commit/0fc6877dca2b16385d7a95e6d01a7a3f94d2ce07), [e8a91d1](https://github.com/Nabsku/pi-prompt-workflows/commit/e8a91d14be0430894cdc3716f28754ad561edd68), [73c91c1](https://github.com/Nabsku/pi-prompt-workflows/commit/73c91c1b2d41792528dc32c5e9798b7bb213c09e)).

## [0.12.0](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.11.2...v0.12.0) (2026-06-20)


### Features

* add includes pane to dry-run TUI ([50624a4](https://github.com/Nabsku/pi-prompt-workflows/commit/50624a46a5722d2ca74ebcb0423e5e99f75dbad1))
* attach include graphs to dry runs ([a1d7eba](https://github.com/Nabsku/pi-prompt-workflows/commit/a1d7eba676158faed0c4e9cf889e5525cf5e5923))
* attach include graphs to validation ([d694724](https://github.com/Nabsku/pi-prompt-workflows/commit/d69472452a6af1b7f94f75df3002b65d5bdc62c8))
* collect prompt include graphs ([be7c726](https://github.com/Nabsku/pi-prompt-workflows/commit/be7c726fb17a43524068ef8da819306304e79091))
* collect prompt source records ([0d0df7a](https://github.com/Nabsku/pi-prompt-workflows/commit/0d0df7a38a460fb1d890596e8f334a9be5772892))
* expose prompt include parsing helpers ([3e784a6](https://github.com/Nabsku/pi-prompt-workflows/commit/3e784a672304100e70ae3a6603a05be6c2744e5e))
* report prompt include graphs ([5332c8e](https://github.com/Nabsku/pi-prompt-workflows/commit/5332c8e8c49925aec20ebe2ba913e6b6a13f814f))


### Bug Fixes

* avoid duplicate include graph diagnostics ([adb6c97](https://github.com/Nabsku/pi-prompt-workflows/commit/adb6c971fa3e1faea902aead4493fd47cf4121a6))
* preserve skipped include graphs for overrides ([2b0e69f](https://github.com/Nabsku/pi-prompt-workflows/commit/2b0e69f3f158c8e5e8ef3bae45053cdd267a19e7))

## [0.11.2](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.11.1...v0.11.2) (2026-06-19)


### Bug Fixes

* publish after release-please releases ([7949c6c](https://github.com/Nabsku/pi-prompt-workflows/commit/7949c6cb313f62f2dc8cc5ab707b90413e3095ac))

## [0.11.1](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.11.0...v0.11.1) (2026-06-19)


### Bug Fixes

* allow skills in delegated prompts ([d7c0e0e](https://github.com/Nabsku/pi-prompt-workflows/commit/d7c0e0e1c8a8e2b728aa2fa20c9e5037002b761e))

## [0.11.0](https://github.com/Nabsku/pi-prompt-workflows/compare/v0.10.0...v0.11.0) (2026-06-19)


### Features

* add prompt dry-run commands ([80548b3](https://github.com/Nabsku/pi-prompt-workflows/commit/80548b34471aa1ae98436c61f5a202d9734f831c))
* add prompt dry-run core ([3edc51a](https://github.com/Nabsku/pi-prompt-workflows/commit/3edc51aace8eccac557bec4d0e83c859a6baa4a8))
* add prompt dry-run TUI ([d99e7da](https://github.com/Nabsku/pi-prompt-workflows/commit/d99e7da3e62f70ecda9fcaebcf5ce1b84e306a73))
* add prompt validation command ([a82a029](https://github.com/Nabsku/pi-prompt-workflows/commit/a82a029e56e51a29295f0b98379acaa643721a24))
* render prompt dry-run output ([8c0cdb5](https://github.com/Nabsku/pi-prompt-workflows/commit/8c0cdb5bcc622ca38f215a146a59f9e3dca55e0a))


### Bug Fixes

* address dry-run TUI review feedback ([af3b6b0](https://github.com/Nabsku/pi-prompt-workflows/commit/af3b6b0f30ad779b79f5548aea51ac22c3fde4be))
* align prompt dry-run loop metadata ([bd9f9ea](https://github.com/Nabsku/pi-prompt-workflows/commit/bd9f9eae3841a515b848a7b73c83b86711b6b456))
* keep prompt dry-run out of history ([86e31b8](https://github.com/Nabsku/pi-prompt-workflows/commit/86e31b8a895a8579ec0a8d40b800c6dd6faa827b))
* polish TUI rendering edge cases ([d5c5c77](https://github.com/Nabsku/pi-prompt-workflows/commit/d5c5c776d0ad34c75e67f147f35cb72a39e14b1e))
* support Kitty inspector controls ([f09904c](https://github.com/Nabsku/pi-prompt-workflows/commit/f09904c5359e75e2cbf4a784bdcddc487d6ad8c7))
* support Kitty picker input ([2679c62](https://github.com/Nabsku/pi-prompt-workflows/commit/2679c6237d85d455a34ff87a76eb463843010b1c))

## [Unreleased]

### Added
- Added `/print-prompt` and `/dry-run-prompt` to preview rendered prompt templates without execution.
- Added a Pi-native dry-run TUI: no-name dry-run commands open a searchable template picker in Pi TUI mode, while named templates open a read-only inspector for prompt body, metadata, skills, includes, warnings, and the raw report.
- Added a static, permanent `Includes` pane to the dry-run TUI inspector. It shows the include graph captured during dry-run rendering, or `No includes.` for prompts without include metadata or inline include directives.

### Changed
- Added `/validate-prompts` to validate prompt templates, includes, chain declarations, and skill references before runtime, including include graph reporting for prompt dependencies and include failures.
- Updated development-only Pi packages from the deprecated `@mariozechner/*` namespace to `@earendil-works/*` `0.79.7`, and bumped `tsx` to `^4.22.4`.
- Added Dependabot version updates for npm development dependencies and GitHub Actions.
- Added Release Please release automation and npm trusted publishing workflow.

### Fixed
- Delegated prompt templates can now combine `subagent:`/runtime `--subagent` with `skill` or `skills`; resolved skill content is prepended to delegated task text instead of rejecting the template.
- Kept dry-run output out of LLM/session history by writing plain previews to stdout instead of custom session messages.
- Aligned dry-run delegation metadata with runtime behavior for default agents, missing delegated `cwd`, loop prefixes, and parallel delegated task preambles.

## [0.10.0] - 2026-06-18

### Added
- Published under the separate package name `pi-prompt-workflows` for the enhanced fork line.
- Added plural `skills` frontmatter for prompt templates, including ordered multi-skill injection and constrained suffix-wildcard selectors such as `golang-*`.

### Changed
- Skill context now renders as one combined context message while preserving backward compatibility for singular `skill` prompts.

### Fixed
- Fixed delegated prompt execution discovery for current `pi-subagents` npm package layouts, including `src/agents/agents.ts`, so `pi install npm:pi-subagents` works without setting `PI_SUBAGENT_RUNTIME_ROOT` manually.

## [0.9.3] - 2026-04-28

### Fixed
- Delegated prompt templates now discover `pi-subagents` installs from project-local Pi npm paths and sibling npm package paths instead of the legacy `subagent` extension path, fixing #1. Thanks @hschne for the report.

## [0.9.2] - 2026-04-28

### Fixed
- Prompt templates now accept provider-qualified model IDs that contain additional slashes, such as `openrouter/openai/gpt-5.4`, across prompt loading, model selection, compare lineups, and `<if-model>` conditionals.

## [0.9.1] - 2026-04-26

### Fixed
- `boomerang: true` prompt collapses now signal rewind to keep current files automatically, avoiding the restore-options prompt during collapse.

## [0.9.0] - 2026-04-25

### Added
- Added `boomerang: true` prompt frontmatter so non-chain templates, including looped templates, can run through prompt-template-model and then collapse their execution context back to the pre-run branch.

### Fixed
- Migrated extension tool schemas from `@sinclair/typebox` to `typebox` 1.x so packaged installs follow Pi's current extension runtime contract.

### Changed
- Added `typebox` as a runtime dependency for packaged installs.

## [0.8.2] - 2026-04-21

### Added
- Added the packaged `prompt-template-authoring` skill for creating and maintaining prompt templates with this extension.

### Changed
- Tightened the shipped skill guide so it stays short, repo-specific, and aligned with the actual prompt-template runtime.

### Fixed
- Corrected the shipped skill examples for model fallback vs rotation, argument substitution, deterministic handoff behavior, chain context wording, runtime flag syntax, and prompt discovery rules.
- Removed the emoji from the skill-loaded renderer so the UI copy matches the extension's plain-text style.

## [0.8.1] - 2026-04-21

### Added
- Added agent skill `prompt-template-authoring` for writing, managing, and running custom prompt templates. Registered in `package.json` under `pi.skills`.

## [0.8.0] - 2026-04-21

### Added
- Added first-class deterministic prompt-template execution for single prompt templates via `deterministic:` or shorthand `run` / `script` frontmatter. Templates can run one direct command or script before any optional LLM turn.
- Added configurable deterministic-step handoff policies: `always`, `never`, `on-success`, and `on-failure`.
- Added deterministic result cards that always show the executed command or script, resolved `cwd`, exit code, duration, and stdout/stderr previews.
- Added deterministic-step `env` support plus `nonInteractive` control for deploy/release-style scripts that need explicit environment variables or want to disable the default non-interactive guardrail env bundle.
- Added a visible deterministic completion message for `handoff: never`, so no-handoff runs still end with an explicit completion marker after the result card.

### Changed
- When a deterministic prompt hands off to the model, the extension now prepends a generated `[Deterministic step]` block with structured execution metadata and truncated stdout/stderr previews before the prompt body.
- Deterministic stdout/stderr payloads are now capped before they are stored in message details, while preserving total line/character counts and truncation metadata for both the card UI and the LLM handoff block.

### Fixed
- Added regression coverage for deterministic loader parsing, relative script resolution, handoff gating, and the no-handoff fast path.
- Deterministic timeouts now escalate from `SIGTERM` to `SIGKILL` if the child process does not exit within the post-timeout grace window.

## [0.7.3] - 2026-04-14

### Fixed
- `/chain-prompts` and chain templates now resolve plain prompt files without extension-specific frontmatter, so standard prompts like `double-check -> deslop` work in chain execution.
- Added regression coverage for plain-prompt chain resolution while keeping ordinary prompt-template command registration unchanged.

## [0.7.2] - 2026-04-04

### Changed
- Added a `promptSnippet` for `run-prompt` so Pi 0.59+ includes it in the default tool prompt section and keeps prompt-template execution discoverable in agent turns.

## [0.7.1] - 2026-04-03

### Changed
- Bumped `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, and `@mariozechner/pi-tui` to `^0.65.0` and updated the extension for the pi `0.65.0` session/runtime breaking changes (`session_start` migration and `getApiKeyAndHeaders()` auth lookup).

### Fixed
- Added regression coverage for the shipped `best-of-n` example and re-verified the installed prompt still matches the shipped example used for manual installs.

## [0.7.0] - 2026-04-01

### Added
- Added a first-class `bestOfN:` prompt-template authoring surface for compare workflows, with configurable `workers`, `reviewers`, optional `finalApplier`, and nested `bestOfN.worktree` support.
- Added configurable compare runtime overrides via `--workers`, `--reviewers`, `--workers-append`, `--reviewers-append`, and `--final-applier`.
- Added `count: N` compare-slot shorthand so one worker or reviewer slot can fan out into repeated identical runs without manual duplication.
- Added a shipped `/best-of-n` example prompt that demonstrates mixed worker counts, mixed reviewer counts, thinking-level model suffixes, `taskSuffix`, and final real-branch application.

### Changed
- Compare prompts now run as worker fan-out, reviewer fan-in, then an optional final apply step that edits the real branch instead of stopping at recommendation prose.
- Reviewer defaults now stay findings-only, while `finalApplier` handles winner-picking or synthesis plus best-effort verification on the current branch.
- Legacy top-level compare frontmatter in templates (`workers`, `reviewers`, `finalApplier`, top-level compare `worktree`) is now rejected in favor of `bestOfN:`.
- Delegated parallel live rendering now shows richer per-task output, including task index, model, recent tools, and bounded rolling output lines.
- README and bundled examples were refreshed to match the shipped compare/runtime surface, including `bestOfN`, compare-wide vs slot-level `cwd`, and chain `parallel(...)` `cwd` rules under `worktree: true`.

### Fixed
- Compare execution now allows partial success by phase: worker and reviewer phases continue as long as at least one slot succeeds, and `finalApplier` can still fall back to worker-only evidence when every reviewer fails.
- Preserved successful worker `=== Worktree Changes ===` summaries when building reviewer and final-apply inputs, so downstream compare stages do not lose worktree evidence.
- Invalid `bestOfN` blocks and legacy compare templates no longer degrade into ordinary runnable prompts after diagnostics; they are skipped entirely.
- `finalApplier` validation now correctly rejects unsupported `cwd` and `count` fields in both frontmatter and runtime overrides.
- Corrected remaining docs/tooling drift, including the `run-prompt` unlimited-loop cap text and compare/chain `cwd` wording.

## [0.6.10] - 2026-03-30

### Added
- Added lineup-based compare frontmatter for prompt templates: `workers` and `reviewers` slot lists (`agent` or `subagent`, optional `model`, optional `task`, optional `taskSuffix`, optional `cwd`, optional `count`), plus optional `finalApplier` for one final apply step.
- Added a two-phase compare execution flow for lineup templates: parallel worker phase first, then reviewer phase fed by aggregated worker output.
- Added runtime lineup override flags for compare templates: `--workers`, `--reviewers`, `--workers-append`, `--reviewers-append`, and `--final-applier`.
- Added compare lineup `count: N` shorthand so one worker or reviewer slot can expand into repeated identical runs without manually duplicating entries.
- Added an example compare prompt template under `examples/`: `best-of-n`, intended for manual installation into `~/.pi/agent/prompts/`.
- Added compare-lineup `subagent` shorthand so prompt authors can use `subagent: true` for default worker/reviewer slots instead of spelling the internal `delegate` / `reviewer` agent names directly.

### Changed
- Prompt-template compare authoring now uses nested `bestOfN:` frontmatter; the loader lowers `bestOfN.workers`, `bestOfN.reviewers`, `bestOfN.finalApplier`, and `bestOfN.worktree` into the existing runtime compare fields and rejects legacy top-level compare fields in templates.
- Removed fixed three-worker compare assumptions from docs and prompt guidance; compare lineups are now caller-defined and duplicate slots are preserved.
- The shipped `best-of-n` example now shows mixed workers, mixed reviewers, and an optional final apply phase, while the runtime fallback still stays at one worker when `workers` is omitted.
- Reviewers now default to findings-only output, and the optional final phase now applies the real-branch patch instead of ending at recommendation prose.
- Parallel delegated task contract now supports per-task `cwd` passthrough end-to-end across the prompt-template bridge.
- README now explains same-model vs multi-model best-of-N configuration explicitly.

### Fixed
- Compare execution now uses partial-success-by-phase behavior: worker and reviewer phases continue as long as at least one slot succeeds, and `finalApplier` can fall back to worker-only synthesis if reviewer slots all fail.
- Compare lineup slots now support `taskSuffix` so shared worker/reviewer instructions can stay in the prompt body while slots add small per-model suffixes such as output-file paths.
- Documented the current compare worktree constraint explicitly: when `worktree: true` is enabled, all worker slots must resolve to the same `cwd`.

## [0.6.9] - 2026-03-28

### Added
- Added `worktree: true` frontmatter and `--worktree` runtime flag for chain templates with parallel steps. When enabled, each parallel subagent runs in its own git worktree to avoid file conflicts during concurrent execution. Requires a chain with at least one `parallel()` step.
- Added `parallel: N` frontmatter for delegated prompts. This expands one delegated prompt into `N` parallel `pi-subagents` tasks targeting the same agent, with automatic slot headers like `[Parallel subagent 2/3]` prepended to each task.

### Changed
- Bumped `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, and `@mariozechner/pi-tui` to `^0.64.0`.
- Delegated prompt execution now forwards `ctx.signal` into subagent runs so turn cancellation can stop in-flight delegated work for both single delegated prompts and delegated parallel chain steps.
- `worktree: true` now also works on delegated prompts that use `parallel: N`, not just chain templates with `parallel()` steps.

## [0.6.8] - 2026-03-28

### Added
- Delegated prompt results are now injected back into the parent conversation as a user message, triggering an agent turn so the parent agent can process and respond to the delegation outcome. Applies to single delegated runs, delegated loops, and delegated chain steps.

## [0.6.7] - 2026-03-28

### Changed
- Delegation progress widget now shows a unified tool stream where completed tools scroll chronologically with the active tool highlighted at the bottom, replacing the old design where the active tool flashed at the top and disappeared on completion.
- Delegation progress widget now renders the subagent's model name in the header (e.g., `delegate [fork] gpt-5.3-codex | 14 tools, 170k tok, 2m47s`).
- Delegation progress widget no longer caps tool history or output lines. The box grows to show the full execution trace.
- Delegation progress widget now refreshes every second during idle periods (model thinking) so the elapsed timer ticks smoothly instead of freezing between progress updates.
- Enriched the delegation bridge protocol to pass through full `recentOutputLines`, `recentTools` history, and `model` from pi-subagents progress data, replacing the old single-line `recentOutput` and missing tool/model fields.
- Removed `lastTool`/`lastToolArgs` tracking from live state (dead code after the unified tool stream redesign).

## [0.6.6] - 2026-03-28

### Added
- Added `--model=provider/model-id` runtime flag to override a template's model for a single invocation. Works with single execution, loops, and delegation.
- Added `--fork` runtime flag to enable `inheritContext` (forked context) at invocation time. Implies `--subagent` if not already set.
- Inline loop iterations now include a `[Loop 2/5]` prefix so the agent knows it's in a loop and which iteration it's on. Delegated (subagent) loops are unaffected.
- Added `loop: unlimited` (and `loop: true`) frontmatter for open-ended loops that run until convergence, user interrupt, or the 999-iteration safety cap.
- Added model rotation for loop iterations via `rotate: true` frontmatter. Cycles through comma-separated models and thinking levels each iteration instead of using fallback semantics.

### Fixed
- Pressing Escape during a loop or chain iteration now stops the loop. Previously, aborted inline turns were treated as "no changes" and the loop continued.
- Delegation errors during loop iterations no longer abort the entire loop. The error is reported and the loop continues to the next iteration (useful with model rotation where one model may fail but others succeed).
- Per-step bare `--loop` in chain declarations (e.g., `double-check --loop -> deslop`) now correctly runs unlimited iterations instead of running once.

### Changed
- Unlimited loops (`--loop` bare or `loop: unlimited`) no longer force convergence on. Convergence follows the `converge` field like bounded loops. Safety cap raised from 50 to 999.

## [0.6.5] - 2026-03-24

### Added
- Added delegated chain-step context summaries via `chainContext: summary` (chain frontmatter), `/chain-prompts ... --chain-context` (command-level), and per-step `--with-context` (single delegated chain steps).

## [0.6.4] - 2026-03-23

### Fixed
- Updated skill command resolution to use `sourceInfo.path` instead of the removed `path` field on `SlashCommandInfo`, fixing compatibility with pi-coding-agent 0.62.0 source provenance changes.

## [0.6.3] - 2026-03-21

### Added
- Chain step progress now shows in the status bar (e.g., `step 2/3: simplify`) and persists until the chain completes, instead of only appearing as a notification that scrolls away.
- Added `parallel(...)` chain step support for delegated prompt templates, including parser/frontmatter validation, delegated task fan-out, aggregated result rendering, and per-task progress display.

### Fixed
- Delegated subagent errors now show as clean notifications instead of extension crash messages with stack traces, matching how other validation errors (missing skill, missing template, etc.) are presented.
- When no subagent bridge is listening (extension not loaded, name collision with another extension), delegation now fails immediately with a diagnostic message instead of silently waiting 15 seconds before timing out.
- Timeout error message no longer dumps the full rendered prompt content; uses the agent name instead.
- Parallel delegated status now prefers aggregate `parallel X/Y running` updates over first-task tool labels, avoiding misleading `running <tool>` status lines during multi-task execution.

## [0.6.2] - 2026-03-20

### Added
- Added delegated-subprocess working directory controls via `cwd` frontmatter (for `subagent` prompts and chain-template defaults) plus runtime `--cwd=<path>` overrides.

### Fixed
- Rewrote README for clarity: fixed default subagent name (`delegate`, not `worker`), corrected provider priority to include `openai-codex`, merged broken frontmatter table into grouped sections with readable descriptions, cut redundant examples, and tightened prose throughout.

## [0.6.1] - 2026-03-20

### Added
- Added delegated prompt execution via direct extension event bus communication with `subagent` (`prompt-template:subagent:*` channels), including delegated custom-message persistence for loop summaries and context carry-forward.
- Added prompt frontmatter support for `subagent` and `inheritContext`, with `inheritContext: true` mapped to delegated fork context.
- Fork context preamble is handled by the subagent extension directly (via `DEFAULT_FORK_PREAMBLE` in `types.ts`), applying to all fork-context subagent runs universally.
- Added runtime delegation override flags: `--subagent`, `--subagent=<name>`, and `--subagent:<name>`.
- Added live progress widget above editor during delegated subagent runs showing elapsed time, tool count, tokens, current tool, and task preview — matching the native subagent tool card layout.
- Added styled completion card with task preview, tool call history, expandable output (Ctrl+O), and usage stats footer.

### Changed
- Updated provider priority for ambiguous bare model IDs to prefer `openai-codex` before `anthropic`, `github-copilot`, and `openrouter`.
- Updated loop convergence and fresh-summary analysis to account for delegated subagent message payloads.

### Fixed
- Delegated start-time hangs now fail fast with explicit timeout errors when a subagent run never emits a start signal.
- Delegated runs no longer treat arbitrary escape-sequence-bearing terminal input as an Esc cancellation signal; only literal Esc cancels.
- Chain and loop restore paths now use live runtime model/thinking state during cleanup, preventing skipped restore on mid-step failures.

## [0.6.0] - 2026-03-19

### Changed

- Clarified the README chain examples so the optional ` -- ` shared-args separator is clearly distinct from loop flags like `--loop`, `--fresh`, and `--no-converge`.
- Clarified in the README that chain frontmatter declarations support per-step `--loop N` inside the `chain:` value.
- Argument substitution now accepts `@$` as an alias for `$@` for compatibility with commonly-typed placeholder variants.
- Skill injection now uses a next-turn context message from `before_agent_start` instead of mutating the turn system prompt.
- Non-chain templates can now omit `model` and inherit the current session model, so inline `<if-model ...>` rendering and skill injection still work without explicit model frontmatter.
- Chain steps without `model` now inherit a fixed chain-start model snapshot, so model-less chain steps behave as if that model were declared in frontmatter while remaining deterministic across step switches.

### Fixed

- Chain step execution now avoids implicit previous-step model bleed for model-less templates by resolving them against the chain-start model snapshot instead of whichever model was active after the prior step.
- Model-less prompt loading now skips plain templates that do not use extension features, preventing command collisions with other extension commands like `/review` and `/handover`.
- Model-less prompt loading now also ignores no-op/invalid-only extension metadata (for example `restore`-only or invalid loop flags), so ineffective frontmatter does not unnecessarily claim command names.
- Model-less prompt loading now recognizes invalid conditional closers like `</else>` as extension-relevant markup, so those templates stay in this extension path and surface proper conditional-parse warnings instead of silently bypassing extension handling.
- Model-less prompt execution now tracks runtime model changes (`model_select` + internal switches/restores) and uses that tracked model instead of potentially stale command-context snapshots.
- Prompt commands now fail fast when a configured `skill` file is missing or unreadable, instead of silently sending the prompt without skill context.
- Skill resolution now returns a typed success/error outcome that callers handle explicitly, rather than emitting notifications from inside the resolver and returning sentinel `null` values.
- Session start/switch now clear any queued skill context message so stale pending skill payloads cannot leak across session boundaries.
- Session start/switch now also clear pending single-command restore state (`previousModel`/`previousThinking`) so restore writes cannot leak into a different session.
- Skill frontmatter resolution now checks registered skill commands first (`pi.getCommands()` skill entries), accepts both `<name>` and `skill:<name>` values, searches additional standard pi skill locations (`.agents/skills` in project ancestors and `~/.agents/skills`), supports direct `<skill>.md` files alongside `SKILL.md` directories, and rejects traversal-like skill names for path fallback.
- `extractLoopCount()` now strips repeated unquoted `--loop` tokens once looping is active, preventing stray loop flags from leaking into prompt arguments.
- Chain frontmatter step parsing now strips repeated per-step `--loop` tokens once a valid per-step loop is resolved, and keeps the first valid value (including mixed invalid/valid numeric sequences like `--loop 1000 --loop 2`).
- Loop-mode restore now tracks runtime model/thinking state per iteration instead of relying on command-context model snapshots, so model restoration remains correct even when command context values are stale.
- Chain execution now restores model/thinking state in a `finally` path, so restore still runs after unexpected runtime errors during a chain step and chain cleanup state is still reset even when restore itself fails.
- Loop and chain executions no longer report `Loop finished`/`Loop converged` when runtime errors abort execution mid-loop.
- Loop and chain error propagation now preserves thrown falsy values (for example `throw 0`) instead of treating them as success, preventing swallowed errors and false completion notifications.

## [0.5.0] - 2026-03-17

### Added

- Loop execution via `--loop` flag: `--loop N`, `--loop=N` to run a prompt N times (1-999), or bare `--loop` for unlimited until convergence with a 50-iteration safety cap. Bare `--loop` always forces convergence on.
- Frontmatter loop controls: templates can now set `loop: N` (1-999) and `converge: false` defaults; CLI `--loop` overrides frontmatter `loop`, and `--no-converge` disables convergence for bounded loops.
- Convergence detection: loops stop early when an iteration makes no file changes (`write`/`edit`). Enabled by default; `--no-converge` opts out.
- Fresh context mode: `--fresh` flag or `fresh: true` frontmatter collapses conversation between loop iterations, keeping only accumulated summaries. Saves tokens on long loops.
- Loop iteration context injected into the system prompt so the agent builds on previous work across iterations.
- Loop progress indicator in the TUI status bar.
- `run-prompt` agent tool: the agent can run prompt templates, chains, and loops on its own. Opt-in via `/prompt-tool on [guidance]`. Config persists in `~/.pi/agent/prompt-template-model.json`.
- Chain templates: new `chain` frontmatter field to declare reusable template pipelines (`chain: double-check --loop 2 -> deslop --loop 2`). Per-step `--loop N` loops each step independently. No `model` required — each step uses its own. Supports `loop`, `fresh`, `converge`, `restore` for overall execution control. Chain nesting is rejected at runtime.

### Fixed

- `readSkillContent` no longer swallows read errors. The caller now sees the actual error message (e.g., permission denied) instead of a generic "Failed to read skill" notification.
- `restoreSessionState` no longer clears `pendingSkill` as a side effect unrelated to model/thinking restoration.
- Error diagnostics now consistently use `String(error)` instead of hardcoded fallback strings.

## [0.4.0] - 2026-03-13

### Added

- Inline `<if-model is="...">...</if-model>` blocks with optional `<else>` branches inside prompt bodies.
- Provider wildcard matching in conditionals with syntax like `anthropic/*`.
- Conditional rendering now happens after model fallback resolution for both single prompt commands and `/chain-prompts`.
- Prompt argument substitution now mirrors pi core more closely, including `${@:N}` and `${@:N:L}` slice syntax. See README for full placeholder reference.

### Fixed

- Model fallback now preserves the currently active model whenever it matches any listed fallback candidate, including ambiguous bare model IDs that would otherwise resolve through provider preference, instead of switching to an earlier candidate unnecessarily.
- Prompt templates that collide with reserved slash commands, including built-ins like `/model` and the extension’s own `/chain-prompts`, are now skipped with a warning instead of being silently shadowed.
- Prompt discovery is now deterministic in a locale-independent way, and duplicate model-enabled prompt names within the same source layer are skipped with a warning instead of silently depending on traversal order.
- Invalid `model` frontmatter declarations are now rejected during prompt loading with diagnostics instead of failing later at execution time.
- Literal tags like `<elsewhere>` and `</if-modeling>` no longer get misparsed as malformed conditional directives.
- Non-interactive notifications now go to stderr so print-mode stdout stays clean.
- Bare model IDs with multiple providers can now still resolve through OAuth-backed auth checks even when fast availability checks alone are inconclusive.
- Optional string frontmatter fields are now trimmed so quoted values like `thinking: " high "` and `skill: " tmux "` behave as expected.
- Existing prompt commands now refresh prompt files before execution, so edits made during a session take effect on the next run instead of waiting for a new session.
- Skill-loaded custom messages now fail safe if their details payload is missing instead of crashing the renderer.
- Frontmatter `model` specs and inline conditional `is` specs now reject internal whitespace like `anthropic /model` or `anthropic /*` instead of silently registering values that can never match.
- Recursive prompt discovery now detects already-visited directories and skips symlink loops instead of risking infinite recursion or duplicate traversal.
- Bare model IDs now honor provider priority across all auth-capable candidates, including OAuth-backed providers, instead of incorrectly favoring a lower-priority provider just because it appeared in the fast-available set.
- Prompt loading now rejects non-object YAML frontmatter roots, like lists, with a diagnostic instead of silently treating them as missing `model` fields.
- `/chain-prompts` now only restores model and thinking when they actually changed, avoiding redundant state writes and noisy restore notifications on no-op chains.
- `/chain-prompts` now tracks thinking changes caused by model switches even when a step does not set `thinking`, so final restoration stays correct when the runtime clamps or resets thinking during a model change.
- `/chain-prompts` now rejects empty or quote-only step segments explicitly instead of treating them as blank template names.
- Single-command auto-restore now also skips no-op thinking restores and notifications when the runtime is already back on the original thinking level.
- Removed unnecessary exports: `modelSpecMatches` from model-selection.ts and `VALID_THINKING_LEVELS` from prompt-loader.ts are now internal implementation details.
- `/chain-prompts` now correctly ignores ` -- ` and `->` inside quoted per-step arguments instead of misinterpreting them as separators.
- `</else>` is now explicitly rejected with a helpful error message explaining that `<else>` is a separator, not a container.
- Fast-path optimization now correctly includes `</else>` check so standalone invalid tags are caught.
- Empty prompt abort in single-command mode now notifies as "error" instead of "warning" for consistency with chain mode.

## [0.3.1] - 2026-02-08

### Fixed

- Prompts map now initialized at extension load instead of waiting for `session_start`. Commands invoked before the first session event no longer fail with stale empty state.

## [0.3.0] - 2026-02-08

### Added

- **Chain command**: `/chain-prompts` orchestrates multiple prompt templates sequentially, each with its own model, skill, and thinking level. Conversation context flows between steps naturally.
- Per-step args override shared args: `/chain-prompts analyze "error handling" -> fix-plan "focus on perf" -> summarize -- src/main.ts`
- Mid-chain failure rolls back to the original model and thinking level
- Step progress notifications show which step is running
- State isolation: chain uses local variables, never interferes with single-command restore behavior

## [0.2.1] - 2026-01-31

### Fixed

- Thinking level now correctly restored after commands that switch model without a `thinking` field. Previously, running a prompt template that only specified `model` would reset thinking to "off" instead of restoring the original level (e.g., "high").

## [0.2.0] - 2025-01-31

### Added

- **Model fallback**: The `model` field now accepts a comma-separated list of models tried in order
- First model that resolves and has auth configured is used
- Supports mixing bare model IDs and explicit `provider/model-id` specs
- If the current model matches any candidate, it's used without switching
- Single consolidated error when all candidates fail
- Autocomplete shows fallback chain with pipe separator: `[haiku|sonnet]`
- Banner image

## [0.1.0] - 2025-01-12

### Added

- **Model switching** via `model` frontmatter in prompt templates
- **Print mode support**: Commands work with `pi -p "/command args"` for scripting
- **Thinking level control**: `thinking` frontmatter field with levels `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- **Skill injection**: `skill` frontmatter field injects skill content into system prompt via `<skill>` tags
- **Subdirectory support**: Recursive scanning creates namespaced commands like `(user:subdir)`
- **Auto-restore**: Previous model and thinking level restored after response (configurable via `restore: false`)
- **Provider resolution** with priority fallback (anthropic, github-copilot, openrouter)
- Support for explicit `provider/model-id` format
- Fancy TUI display for skill loading with expandable content preview
