# Task: Fix PR 93 review findings

## 1. Task Metadata

- **Task name:** Fix PR 93 entity, screenshot rollback, transfer retry, and focus defects
- **Slug:** pr93-stability-fixes
- **Status:** shipped in 0.4.0
- **Created:** 2026-09-27
- **Last updated:** 2026-09-27
- **Shipped:** 2026-10-01 (0.4.0)
- **Branch:** `feature/pr93-stability-fixes`
- **Base commit:** `0d5925fc2d453e1c5e471c17bd456eabd3a375a5`
- **Checkout:** `/Users/abhinav/code/markdown-for-humans-public`
- **Pre-existing changes:** none

## 2. Context & Problem

The fourth read-only review and follow-up VS Code QA confirmed four issues:

| ID | Priority | Problem |
| --- | --- | --- |
| U01 | P1 | Global entity sentinels become visible document content and persist into code, link attributes, and HTML tables. |
| U02 | P2 | Failed screenshot cleanup runs after releasing the report lock and can delete another writer's later committed asset. |
| U03 | P2 | An apply refusal suppresses negative ACK replay, leaving ownership transfer stuck if the first ACK is lost. |
| U04 | P2 | Snapshot invalidation steals focus from the source editor and drops subsequent typing. |

Source evidence: the off-repository `PR-93-review-round-4.md` and `PR-93-VS-Code-edge-case-QA.md` reports in `/Users/abhinav/.codex/visualizations/2026/09/26/01a0def1-447f-7a31-a6c1-9d32acc351f3/`.

## 3. Desired Outcome & Scope

- Correct visible content and serialization for literal entities in prose, code, links, and table cells. No internal markers enter the editor model.
- Publication, report commit, and rollback cleanup remain protected against another store's Resume/capture.
- Exact refused-apply retries replay the same negative ACK, without changing ownership or losing drafts; an exact abort remains safe and idempotent.
- Source changes invalidate Feedback without taking focus from another editor group; local accessibility recovery remains usable.
- New regression tests must fail before implementation and pass afterward. Existing required checks must pass.
- Repeat original deterministic storage/transport probes and VS Code entity/focus/lifecycle cases with isolated fixtures.
- No commits, pushes, publishing, or changes to the original review evidence. Keep work as a reviewable branch diff.

## 4. UX & Behavior

1. Open Markdown with escaped entities, make an unrelated edit, save and reopen. Rendered prose is correct and code/attribute values preserve their authored meaning.
2. Fail a screenshot submission while another store resumes and submits a capture. A later successful capture and its report remain intact.
3. Refuse transfer because of a live draft, lose the first negative ACK, retry. The host recovers to its original active owner and the draft can still be submitted.
4. Keep rich Feedback and raw source in separate groups. With and without Finish open, type in source. The snapshot becomes stale, finishing is disabled, and all source keystrokes continue at the source caret.

## 5. Technical Plan

- **U01:** Replace full-source marker substitution with context-aware parsing/serialization that keeps genuine text in the editor model. Cover real TipTap parse, display/model, and unrelated edit/save behavior rather than only a source round trip.
- **U02:** Keep failed asset rollback within the same report-lock lifetime as publication and commit, for both current and legacy screenshot paths. Add a deterministic two-store interleaving test with delayed cleanup and asset/hash assertions.
- **U03:** Track a refused apply separately from a completed abort. Replay only for the exact retained identity; preserve stale/conflict and bounded-history behavior. Exercise lost first ACK with production client/transport behavior.
- **U04:** Capture focus ownership before invalidation changes the DOM. Avoid focus transfer when the webview was unfocused; retain appropriate local recovery when focus was inside Feedback.
- Update adjacent comments and architecture/pitfall guidance only where the resulting contract changes or needs clarification. No new dependencies planned.

Independent code areas may be implemented in parallel after this plan is saved, with separate test-first evidence and root integration review.

## 6. Work Breakdown

- [x] Confirm clean baseline and create branch.
- [x] Write this plan before product changes.
- [x] Reproduce U01 in failing tests, fix, and run focused tests.
- [x] Reproduce U02 in failing tests, fix, and run focused tests.
- [x] Reproduce U03 in failing tests, fix, and run focused tests.
- [x] Reproduce U04 in failing tests, fix, and run focused tests.
- [x] Review combined diff and run full Jest, lint, TypeScript, release build, and bundle verification.
- [x] Run affected Electron capture/annotation and deterministic performance checks.
- [x] Run Extension Host checks on verified VS Code 1.98.0 and stable.
- [x] Repeat original controlled failure probes and relevant native VS Code cases.
- [x] Read a 3,000+ word fixture for at least ten minutes across light/dark themes; record actual coverage and limits.
- [x] Record final findings, evidence, remaining risks, and branch status. No commit or push.

## 7. Implementation Log

### 2026-09-27: plan and baseline

- Confirmed reviewed HEAD and clean working tree; created `feature/pr93-stability-fixes`.
- Imported U01-U04 and their original reproduction criteria.
- Product implementation has not started at this checkpoint.

### 2026-09-27: regression-first implementation

- **U03:** Four new failing tests captured lost refusal ACK replay across roles and production transport. Retained refusal is now distinct from completed abort. Client and transport suites pass 34 tests. A rebuilt coupled provider/client/transport/real-TipTap probe confirms rollback, preserved draft, active original owner, and successful subsequent submission with and without the first refusal ACK. Logs: `/tmp/md4h-pr93-fix/u03/`.
- **U04:** Three controller regressions failed before adding focus-ownership guards, including editing an existing comment. Two additional capture regressions exposed the same lifecycle focus theft; their guards preserve local cancellation recovery. Related suites passed 266 tests before the additional block-selector regression, which also failed before its fix. Logs: `/tmp/md4h-pr93-fix/u04/`.
- **U01:** Removed global sentinel substitution and retained authored entity source in nonvisual inline mark attributes. Thirteen initial regressions failed before the fix; the expanded real-editor suite has 18 cases, and eight related suites pass 115 tests. Code, destinations/titles, HTML tables, genuine private-use text, editing and formatting fragments are covered. Logs: `/tmp/md4h-pr93-fix/u01/`.
- **U02:** Moved screenshot rollback inside the exclusive report lock for both storage versions. Five new regressions cover cleanup overlap before/after report replacement and failed report restoration. All 145 storage tests and the rebuilt two-store race probe pass. Logs: `/tmp/md4h-pr93-fix/u02/`.
- **U04 addendum:** Deferred marker regrouping also honors focus ownership; two new regressions failed before this fix and the local focus positive control passes. Controller suite: 185 passing tests.
- **Combined gates:** Node 22.23.3 full Jest: 150 suites / 2,765 passed, with 27 skipped and 120 todo existing tests. ESLint, TypeScript, release build/bundle verification, deterministic performance contract/run, Electron screenshot capture and annotation checks pass. Both final Extension Host runs pass four tests each, with actual versions 1.98.0 and 1.139.1 asserted inside the host. Native entity save/reopen, source-focus idle and Finish-open cases, capture cancellation, screenshot persistence/reopen/Resume/seal all pass. The annotated PNG hash matches the sealed report. Logs and observations: `/tmp/md4h-pr93-fix/`.

### 2026-09-27: independent review and final rerun

- Independent review found adjacent invalid numeric and unknown named-entity cases. Five new tests failed before switching to MarkdownIt's actual inline entity rule. The final U01 suite has 23 cases; eight focused suites pass 120 tests. A separate 384-case sweep found no introduced defect after the correction.
- Rebuilt release bundles, reran full Node 22 Jest (2,765 passed), ESLint, TypeScript and both Extension Host versions after that correction. No assertions or timeouts were weakened.
- Native source invalidation preserved every character and the following newline both while idle and with Finish open. Native screenshot QA confirmed local Escape recovery, retained dirty annotations, reopen/Resume, and a sealed PNG with matching SHA-256.

## 8. Decisions & Tradeoffs

- Fix confirmed root causes with deterministic regression tests and actual VS Code verification.
- Preserve existing fail-closed transport/storage behavior where an outcome is ambiguous; repair only the confirmed retry/rollback gaps.
- Do not treat GUI success as proof of fault-injected races or hardware latency budgets.
- Prior CI timeout is a validation signal, not yet a confirmed product defect. Investigate if encountered; do not increase timeouts or weaken assertions to hide a failure.

## 9. Follow-up & Future Work

- User reviews the completed diff and decides whether to commit, push, or merge.
- Physical Windows hardware latency and high-DPI manual validation remain outside this macOS run.
- Final stability report: `/Users/abhinav/code/markdown-for-humans-public/.concret.io/findings/2026-09-27/stability-report-pr-93-vscode-edge-cases-qa-stabilize-201833.md`.
- Reading evidence: 3,640-word fixture, headings, prose, lists, tables, code blocks, checkboxes and outline navigation checked across light/dark themes and full/split widths. Reading/navigation and related long-document interactions ran in two segments, 14:32:44-14:38:27 UTC and 14:42:50-14:48:33 UTC, exceeding ten minutes combined. No new clipping, overlap or navigation failure observed. This is a Computer Use visual pass, not a human usability study or latency measurement.
