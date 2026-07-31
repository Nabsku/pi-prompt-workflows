---
description: Review a change with optional test execution
model: claude-sonnet-4-20250514
inputs:
  target:
    type: string
    required: true
  run-tests:
    type: boolean
    default: false
---
Review `${input.target}` against the repository rules.

<if-input name="run-tests" is="true">
Run the focused tests for the changed area and report failures.
<else>
Do not run tests; inspect the change and explain what should be tested.
</if-input>

Additional positional context: $@
