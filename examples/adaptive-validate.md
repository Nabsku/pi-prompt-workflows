---
description: Read-only Git change observation for the adaptive validation example
hidden: true
deterministic:
  run:
    command: git
    args: [--no-optional-locks, -c, core.fsmonitor=false, ls-files, --modified, --deleted, --others, --exclude-standard]
    shell: false
  handoff: never
  timeout: 120000
---
