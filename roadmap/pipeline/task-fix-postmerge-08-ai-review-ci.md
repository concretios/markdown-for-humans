# Task: Fix AI PR reviewer coverage and silent skips

## 1. Task Metadata

- **Task name:** Fix AI PR reviewer coverage and silent skips
- **Slug:** fix-postmerge-08-ai-review-ci
- **Status:** planned
- **Created:** 2026-09-30
- **Last updated:** 2026-09-30
- **Shipped:** _(pending)_
- **Base:** `origin/main` @ `1b8244b`
- **Overview:** `task-fix-postmerge-00-overview.md`

---

## 2. Context & Problem

After the v2 upgrade (#97, #102), the reviewer runs but gives little coverage and fails silently:
- From 2026-09-27 to 2026-09-30 every run passed in 8 to 12s with no review; #93, #98 and #100 merged with zero AI review.
- #101 merged at 81/418 changed ranges reviewed, showing "0 concerns".

v2 (`concretios/ai-pr-reviewer`) caps input at 32k tokens per request and 12 attempts in auto mode (24 in extended); the cap is hard-coded in `limits()` in the action's `src/config.ts`. Rules are sent in full with every request.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- A #101-sized PR gets most of its ranges reviewed in auto mode (re-measure after change)
- A skipped or partial review is visible on the PR (not a silent green check)
- Test asserts every configured rules path exists
- Only repo members can trigger comment reviews

**In scope:** A1 to A5 in this repo; upstream issue for A6
**Out of scope:** switching review provider

---

## 4. Findings

### A1. HIGH: rules prefix uses most of each request's budget. Mechanism confirmed; share estimated.

- **Where:** `.ai-review.yml:5-7` (`rules_paths: [AGENTS.md, vibe-coding-rules/]`)
- **Defect:** about 88 KB of Markdown (10 files, roughly 22k tokens) is sent with every request, leaving about 8k tokens for diff and context.
- **Evidence:** #101 run: all 12 attempts at 25k to 30k prompt tokens, 81/418 ranges covered, 4 ranges "Indivisible input cannot fit". #99 retest: 32/46.
- **Fix:**
  1. Write `review-rules.md` (2 to 3 KB) with only diff-checkable rules, drawn from `AGENTS.md` and `vibe-coding-rules/`:
     - Markdown round-trip fidelity (no unrequested rewrites)
     - No per-keystroke heavy work or DOM measurement (<16ms typing budget)
     - Theme colors only (`var(--vscode-*)`), no hard-coded colors
     - Tests accompany behavior changes (TDD)
     - Every async path has try/catch; critical failures surface to the user
     - No `innerHTML` with document, host or LLM-derived content
     - Listener, observer and timer cleanup on dispose
     - Path containment for any file read or write
  2. Point config at it and exclude non-code:
     ```yaml
     rules_paths:
       - review-rules.md
     exclude_paths:
       - package-lock.json
       - roadmap/
       - docs/
       - src/__tests__/fixtures/
     ```
  3. Re-measure coverage on a #101-sized PR.
- **Why not trim AGENTS.md:** most of it is agent workflow guidance (plan workflow, doc triggers, manual reading test) that a diff reviewer cannot check.

### A2. MED: skipped or partial reviews show green. Confirmed.

- **Where:** `.github/workflows/ai-review.yml:80-87` never reads `steps.review.outputs.review_status`
- **Fix:** add a step reading `review_status` via an `env:` variable (not inline `${{ }}` in `run:`):
  - `skipped` on a same-repo `pull_request` event: fail the job
  - `partial`: write a warning and coverage to `$GITHUB_STEP_SUMMARY`
- **Test first:** extend `src/__tests__/ci/aiReviewWorkflow.test.ts` to assert the status step exists.

### A3. MED: fork PRs are never reviewed; repo is public. Confirmed.

- **Where:** `.github/workflows/ai-review.yml:56-59`, `.github/workflows/ai-review-request.yml:19-22`
- **Defect:** v2 excludes fork PRs even for maintainer dispatch or comment commands ("Fork and Dependabot PRs are excluded from live review", action `src/github/authorize.ts`). The request workflow's header implies a maintainer comment reviews forks. v1 did review forks, so this is a coverage regression.
- **Fix:** correct the header comment and CONTRIBUTING note; open an upstream issue if fork coverage matters.

### A4. LOW: comment trigger has no `author_association` filter. Medium confidence.

- **Where:** `.github/workflows/ai-review-request.yml:19-22`
- **Scenario:** anyone can post the command and start a job with `GEMINI_API_KEY` in scope; the action rejects them at its permission check. No exfiltration path (no PR code runs), but outsiders can create failed runs and notification noise.
- **Fix:** add `if: contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)`.

### A5. LOW: test does not assert rules paths exist. Confirmed.

- **Where:** `src/__tests__/ci/aiReviewWorkflow.test.ts:71-76` regex-matches `rules_paths` text only.
- **Scenario:** renaming `AGENTS.md` or `vibe-coding-rules/` fails silently with only a notice.
- **Fix:** parse `.ai-review.yml` and assert each entry exists on disk.

### A6. UPSTREAM (`concretios/ai-pr-reviewer`): make the 32k input cap configurable.

- Gemini 2.5 Flash supports far larger context; the hard-coded 32k is the root limit. Raising it or making it an input removes the need for `@dr-concretio extend` on large PRs.

### Info: #97's lost "Low 1" finding is unrecoverable.

- Run 36299919549 used the v1 action (SHA `7d151e6`) because `pull_request_target` runs from the base branch; v2 was never exercised before merge. v1 posted the summary, the inline POST failed with 422, the log misreported "1 posted", and no artifact exists. v2 prevents this class of loss (every concern appears in the main comment).

### Verified OK

- All actions pinned to full SHAs; top-level `permissions: {}`; minimal job permissions; no `${{ github.event.* }}` in `run:`; no checkout of PR code.
- `AGENTS.md` and `vibe-coding-rules/` load correctly (the "rules path not found" notice on #102 came from the pre-merge base).
- v2 builds diffs with local `git diff`, so the #93 HTTP 406 failure cannot recur; oversized PRs finish as `partial`.

---

## 5. Progress

| ID | Test | Fix | Verified |
|---|---|---|---|
| A1 | | | coverage re-measured |
| A2 | | | |
| A3 | n/a | | |
| A4 | | | |
| A5 | | | |
| A6 | n/a | upstream issue | |
