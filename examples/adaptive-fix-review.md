---
description: Adaptive implement, changed-only review, test, fix-on-failure, and retest
chain:
  - id: implement
    prompt: adaptive-implement
  - id: review-implementation
    prompt: adaptive-review
    when: changed
  - id: test
    run: adaptive-test
    onSuccess: done
    onFailure: fix
  - id: fix
    prompt: adaptive-fix
  - id: review-fix
    prompt: adaptive-review
    when: changed
  - id: retest
    run: adaptive-test
    onSuccess: done
    onFailure: done
    onBlocked: done
  - id: done
    run: adaptive-status
limits:
  maxSteps: 7
  maxModelCalls: 4
---
This body is ignored by an adaptive chain wrapper.
