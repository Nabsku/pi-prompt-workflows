---
description: Low-cost report-only best-of-N smoke prompt with one worker and one reviewer.
bestOfN:
  workers:
    - subagent: true
      count: 1
      taskSuffix: Do not edit files. Produce a concise proposed answer or plan only.
  reviewers:
    - subagent: true
      count: 1
      taskSuffix: Do not edit files. Review the worker output for correctness, risk, and missing steps.
---
Run a report-only compare pass for this request.

Do not apply changes, commit, or ask a final applier to edit the branch. Return the worker proposal and reviewer findings clearly.

Request: $@
