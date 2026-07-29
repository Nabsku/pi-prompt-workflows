---
description: Small bounded validation and review adaptive chain
chain:
  - id: validate
    run: adaptive-validate
    onSuccess: review
    onFailure: diagnose
    onBlocked: blocked-review
  - id: diagnose
    prompt: adaptive-fix
    onSuccess: review
    onFailure: blocked-review
    onBlocked: blocked-review
  - id: blocked-review
    prompt: adaptive-review
  - id: review
    prompt: adaptive-review
limits:
  maxSteps: 4
  maxModelCalls: 3
---
This body is ignored by an adaptive chain wrapper.
