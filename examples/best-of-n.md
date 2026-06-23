---
description: Best-of-N code task with parallel workers using different models in separate worktrees, parallel reviewers, and a final apply step that picks or synthesizes the final patch.
# Usage: /best-of-n fix the flaky auth test
# Usage: /best-of-n implement the plan: /path/to/plan.md
bestOfN:
  # To reuse a shared lineup instead of the explicit workers/reviewers below, define
  # `~/.pi/agent/best-of-n-presets.json` or `<repo>/.pi/best-of-n-presets.json`, then run:
  #   /compare-presets
  #   /compare-presets --plain
  #   /dry-run-prompt best-of-n --preset quick --plain your task
  #   /best-of-n --preset quick --keep-artifacts your task
  #   /compare-runs
  #   /compare-runs --plain --id <run-id>
  # Project presets override same-named user presets, but execution asks for session approval.
  # JSON and YAML preset files are supported. Minimal YAML example:
  #   presets:
  #     quick:
  #       defaultModel: openai-codex/gpt-5.4-mini:low
  #       maxModelCalls: 3 # expanded workers + reviewers + optional final applier
  #       workers:
  #         - agent: delegate
  #           count: 2
  #       reviewers:
  #         - agent: reviewer
  # preset: quick
  # Workers run in temporary worktrees; the final apply step edits the current branch.
  worktree: true
  workers:
    # count means "run this exact slot N times in parallel".
    # So this example below runs 3 spark workers and 2 gpt-5.4-mini workers in parallel.
    - model: openai-codex/gpt-5.3-codex-spark:low
      count: 3
    - model: openai-codex/gpt-5.4-mini:high
      count: 2
  reviewers:
    # Reviewers use the base `reviewer` agent from pi-subagents.
    # These slots can override its default model, and they get a generated compare task built from
    # the original request, successful worker outputs/worktree summaries, and these slot instructions.
    # count works the same way here: it runs the same reviewer slot multiple times in parallel.
    # taskSuffix appends extra instructions to just that slot without replacing the shared prompt body.
    - model: openai-codex/gpt-5.3-codex-spark:medium
      count: 2
    - model: openai-codex/gpt-5.4-mini:high
      taskSuffix: Focus extra attention on regression risk and missing edge cases.
  finalApplier:
    # The final apply step picks or synthesizes from worker/reviewer findings and applies on the current branch.
    model: openai-codex/gpt-5.4-mini:xhigh
    taskSuffix: Apply the final patch directly on the current branch, run best-effort relevant verification, and report changed files plus verification run.
  # Ask mode never commits automatically. It renders changed files, a diff summary,
  # the run report path, and copyable git add/commit commands for manual approval.
  commit: ask
---
$@
