---
description: Simple current-model review prompt with no required external skills.
thinking: low
---
Review the user's target or pasted change.

Keep it concise and practical:
- list blockers first;
- call out likely bugs, regressions, or confusing behavior;
- separate required fixes from optional polish;
- if there is not enough context, say exactly what to inspect next.

Target: $@
