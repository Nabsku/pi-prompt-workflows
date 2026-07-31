---
description: Read-only Git change observation for the adaptive validation example
hidden: true
deterministic:
  run:
    command: /bin/sh
    args: [-c, 'git --no-optional-locks -c core.fsmonitor=false ls-files --modified --deleted --others --exclude-standard && git --no-optional-locks -c core.fsmonitor=false --no-pager diff --cached --name-status --no-ext-diff --no-textconv --']
    shell: false
  handoff: never
  timeout: 120000
---
