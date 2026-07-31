---
description: Read-only terminal change observation for adaptive examples
hidden: true
deterministic:
  run:
    command: git
    args: [--no-optional-locks, -c, core.fsmonitor=false, status, --short]
    shell: false
  handoff: never
  timeout: 120000
---
