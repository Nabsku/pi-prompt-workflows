---
description: Best-of-N parallel implementation compare in the current repo with one openai-codex lineup plus an optional final arbiter (worktree needs a clean repo)
# Usage: /best-of-n fix the flaky auth test
# Usage: /best-of-n implement the plan: /path/to/plan.md
workers:
  # Three independent tries from the fast worker model.
  - subagent: true
    model: openai-codex/gpt-5.3-codex-spark
    count: 3
  # Two comparison runs from a stronger model in the same provider.
  - subagent: true
    model: openai-codex/gpt-5.4-mini
    count: 2
reviewers:
  # All reviewers see the same aggregated successful worker results.
  - subagent: true
    model: openai-codex/gpt-5.3-codex-spark
    count: 2
  - subagent: true
    model: openai-codex/gpt-5.4-mini
    taskSuffix: Focus extra attention on regression risk and missing edge cases.
finalReviewer:
  # The arbiter compares reviewer outputs side by side and can fall back to raw worker synthesis if reviewer runs fail.
  subagent: true
  model: openai-codex/gpt-5.4-mini
  taskSuffix: Produce one seamless final review that either picks the best single variant or recommends a concrete merge plan.
worktree: true
---
$@
