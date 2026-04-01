---
description: Best-of-N code task with parallel workers using different models in separate worktrees, parallel reviewers, and a final apply step that picks or synthesizes the final patch.
# Usage: /best-of-n fix the flaky auth test
# Usage: /best-of-n implement the plan: /path/to/plan.md
bestOfN:
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
    # All reviewers see the same aggregated successful worker results.
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
---
$@
