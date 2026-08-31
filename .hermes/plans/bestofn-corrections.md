# Best-of-N Correction Plan — pi-prompt-workflows fork

- **Goal:** Fix the confirmed correctness and lifecycle defects in the published best-of-N implementation at commit `fb5ad757` (PR #69) with the smallest possible changes.
- **Plan date:** 2026-08-31
- **Repository:** `/Users/yannick/clawd/repos/pi-prompt-workflows-bestofn`
- **Branch:** `restore-best-of-n`, clean at `fb5ad757ce2b57f7b53b2c05ee41201526d65d1b`
- **PR:** https://github.com/Nabsku/pi-prompt-workflows/pull/69 (open, unmerged)
- **Upstream base:** `accfa781` (`nicobailon/pi-prompt-template-model`)

## Scope

Fix defects found by the two independent reviews plus my verification. Do not redesign the transport. Do not add speculative features.

## Non-goals

- No legacy `tasks[]`/`parallel`/`worktree` transport restoration.
- No `pi-subagents` public worktree API proposal.
- No setup hooks, dependency linking, or sandbox machinery.
- No changes to the 32-request cap or slot schema.
- No separate candidate-patch artifact format.
- No automatic commit, merge, release, or deploy.

## Current state (evidence)

- `subagent-step.ts:538-541` — on abort, emits cancel, rejects the host promise immediately; the bridge keeps the child running and emits its terminal response later (`prompt-template-bridge.ts:297-337`). `best-of-n.ts:323-330` then deletes worktrees in `finally` while a child may still be unwinding.
- `best-of-n-worktree.ts:72-79` — clean check uses `git diff-index` + `ls-files --others --exclude-standard`; misses `assume-unchanged`/`skip-worktree` hidden edits and does not exempt bridge-owned `.pi/subagents` runtime state.
- `index.ts:2136` — best-of-N parses `lineup.args`; `--model/--cwd/--fork` leak into `$@`/`$ARGUMENTS` substitutions.
- `prompt-loader.ts:1137-1142` + `best-of-n.ts:122` — slot `model: "one,two"` passes through as a single spec; exact match fails; fallback broken.
- `best-of-n.ts:79-93` — `appendEvidence` concatenates full outputs with no byte limit; bridge rejects tasks over 1 MiB (`delegation-request.ts:31-33`).
- `best-of-n-worktree.ts:95-107` — each worktree re-reads `HEAD` independently; no run-level baseline; final applier runs against the live target with no revalidation.
- Workers can change files; on failure, cancellation, or absent final applier, `finally` force-removes worktrees — candidate changes are destroyed although workers are instructed to leave useful changes.
- Worktrees contain tracked files only; ignored `node_modules`/`.venv`/build output are absent (verified).
- `best-of-n.ts:311` — `changed` aggregates candidate changes and target changes into one boolean.
- README/SKILL wording can imply worktrees are a filesystem sandbox; `cwd` is not an OS boundary.

## Decisions

1. **Transport stays.** One structured request per slot is correct for the installed `pi-subagents` 0.49 contract.
2. **Fix lifecycle in this extension only.** No `pi-subagents` changes.
3. **Cancellation waits for child termination** (bounded). Host-side wait, not bridge API changes.
4. **Baseline pinning is per source repository**, captured once before the first worktree, reused for all slots and revalidated before the final apply.
5. **Candidate preservation is textual**: unified diff of worktree changes is passed forward and kept in the result; no patch artifact files, no automatic apply.
6. **No automatic apply of preserved patches.** Preservation only. The user reads the diff and decides.
7. **Ignored dependencies are a documented limitation.** Fail early with a clear error when slot `cwd` lives under an ignored path.
8. **`changed` stays one boolean** but counts only final-applier/target changes.
9. **Fail-closed everywhere**: any new check rejects with a clear error instead of degrading.
10. **Docs update with the code**, in the same slice.
11. Each slice lands as one commit with focused tests (`fix: ...`).
12. Slice 6 (progress UI) is optional and last; drop it if time is short.

## Task slices

### Slice 1 — Contract fixes (S, 1.5–2.5 h) — complete

- [x] Test: `/compare --model M --cwd /tmp/x --fork task` → worker request task contains no `--model`/`--cwd`/`--fork`; substitutions use only `task`
- [x] Test: slot `model: "m1,m2"` with only `m2` available → request uses `m2`
- [x] Test: slot `model: "bad spec"` → rejected with a load-time diagnostic
- [x] Test: two 600 KiB worker outputs → reviewer and final-applier tasks stay under 1 MiB with a truncation marker
- [x] Fix `index.ts:~2136` to parse `argsWithoutSubagent` (keep `boundary.after`)
- [x] Fix slot model normalization in `prompt-loader.ts:~1136-1143`
- [x] Add byte budget to `appendEvidence` (`best-of-n.ts:79-93`)
- **Gate:** `npx tsx --test --test-concurrency=1 test/best-of-n.test.ts test/index-loop.test.ts test/prompt-loader.test.ts` — **314/314 passed**; controller rerun passed; read-only review found no code blocker. The review-only note about the untracked plan file was pre-existing and out of slice scope.

**Slice 1 handoff:** changed `index.ts`, `prompt-loader.ts`, `best-of-n.ts`, `test/best-of-n.test.ts`, `test/index-loop.test.ts`, and `test/prompt-loader.test.ts`. The evidence cap is `917,504` UTF-8 bytes (`1 MiB` transport limit minus `128 KiB` reserve) and truncates with an explicit marker. Commit after staging and diff review.

### Slice 2 — Clean-source gate (S, 1.5–2 h)

- [ ] Test: `--assume-unchanged` tracked edit → rejected
- [ ] Test: `--skip-worktree` tracked edit → rejected
- [ ] Test: untracked `.pi/subagents/run-state.json` only → accepted
- [ ] Test: untracked non-runtime file → still rejected
- [ ] Fix `best-of-n-worktree.ts:72-79`: detect hidden index flags (`ls-files -v` markers or raw snapshot reuse — pick smaller diff); scope runtime-state exemption to the exact bridge subtree
- **Gate:** focused suite green; existing dirty-source tests unchanged

### Slice 3 — Baseline + final-apply fence (M, 2.5–4 h)

- [ ] Test: `HEAD` advances between `create()` calls → all worktrees use the same base commit
- [ ] Test: source advances after workers finish → final-applier phase aborts fail-closed, candidate evidence preserved
- [ ] Test: source unchanged → final applier runs normally
- [ ] Capture `HEAD` + clean-state digest once per source cwd before first `create()`; create all worktrees from the pinned SHA
- [ ] Revalidate before the final-applier phase
- **Gate:** focused suite + full `npm run test`; no timing-dependent flakiness (deterministic `HEAD` advance via test seam, no sleeps)

### Slice 4 — Candidate preservation + cancellation drain (M/L, 4–7 h)

- [ ] Test: final applier fails; worker wrote a file → result text contains the unified diff; worktree removed after extraction
- [ ] Test: cancel during worker phase (delayed terminal response) → cleanup waits; worktree not removed before terminal response
- [ ] Test: drain timeout expires → worktree kept, warning + path reported
- [ ] Test: absent final applier with changed candidates → diff in result; `changed` false
- [ ] Test: worker commits despite instruction → `git diff <base>..HEAD` fallback still extracts the diff
- [ ] Extract `git -C <worktree> diff <pinnedBase>` (+ `--stat`) before cleanup when `outcome.changed === true`
- [ ] Add bounded, env-overridable drain wait for the bridge terminal response in `requestDelegatedRun`; keep listeners alive during the wait; reuse for TUI Escape
- **Gate:** focused suite + full `npm run test`; no test sleeps longer than ~1s; existing cancellation tests still pass

### Slice 5 — Docs + packaging (S, 1 h)

- [ ] Document: runtime-state exemption, hidden-index rejection, baseline pinning + final fence, candidate diff preservation, cancellation drain, target-only `changed`, ignored-dependency limitation, `cwd`-is-not-a-sandbox wording
- [ ] Replace the misleading "does not restore the removed parallel/task/worktree delegation transport" phrasing with the agreed upstream-comparison wording
- [ ] `npm pack --dry-run --json` still lists `best-of-n-worktree.ts`; no unexpected new files
- **Gate:** every documented claim matches implemented behavior

### Slice 6 — Progress UI (S, optional, 1–2 h)

- [ ] Test: first worker finishes → global working message remains until phase end
- [ ] Optional flag to skip global set/clear in `subagent-step.ts`
- **Stop rule:** drop the slice if it needs more than `best-of-n.ts` + `subagent-step.ts`

## Verification gates

- Per slice: red → green focused tests. Slices 3–4: full `npm run test`.
- Final: `npm run test`, `git diff --check`, `npm pack --dry-run --json`, staged diff review, one commit per slice.

## Estimate

- **Total: 11–17.5 focused hours** (10.5–16.5 h without slice 6)

## Authority boundaries

- Plan is not authorization. Commit per slice after its gate passes; no push, PR update, merge, or release without explicit approval.
- No `pi-subagents` dependency changes. No upstream repo operations.

## Risk register

- Cancellation drain vs. start-timeout interaction in `requestDelegatedRun` — keep the drain independent of the start timer.
- `ls-files -v` markers vary subtly across Git versions — verify against installed Git; reuse `git-worktree-snapshot` fixtures.
- Committed-in-worktree worker silently yields an empty diff without the test 4b fallback.
