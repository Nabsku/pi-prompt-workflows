---
description: Read-only Git diff whitespace/error check used by the adaptive example
hidden: true
deterministic:
  run:
    command: git
    args: [--no-pager, diff, --no-ext-diff, --no-textconv, --check]
    shell: false
  handoff: never
  timeout: 120000
---
