---
description: Read-only Git status check for the adaptive validation example
hidden: true
deterministic:
  run:
    command: git
    args: [--no-optional-locks, -c, core.fsmonitor=false, status, --porcelain=v1]
    shell: false
  handoff: never
  timeout: 120000
---
