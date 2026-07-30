---
description: Read-only staged Git whitespace/error check used by the adaptive example
hidden: true
deterministic:
  run: git --no-optional-locks -c core.fsmonitor=false --no-pager diff --cached --no-ext-diff --no-textconv --check
  handoff: never
  timeout: 120000
---
