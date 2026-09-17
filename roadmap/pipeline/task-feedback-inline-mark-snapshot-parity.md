# Task: Feedback parity for formatting across line breaks

## 1. Task Metadata

- **Slug:** feedback-inline-mark-snapshot-parity
- **Status:** in-progress
- **Created:** 2026-09-17
- **Base:** `8cd2214a5322e73a77b0e714c113f68ae61293da`
- **Branch:** `feature/llm-feedback`
- **Shipped:** _(pending)_

## 2. Context & Problem

QA-001 reproduced Feedback startup rejecting an unchanged document containing
italic text across source newlines. TipTap closes and reopens formatting marks
around hard breaks. The Feedback comparator compares the resulting HTML nesting
literally, falsely rejecting equivalent text and formatting. Bold is affected too.

Source QA report: `/private/tmp/deck-feedback-investigation/qa-report-llm-feedback-deck-feature-qa-162426.md`.
The original deck stays outside the repository; regression fixtures use synthetic text.

## 3. Desired Outcome & Scope

- Unchanged italic and bold spans across line breaks pass Feedback snapshot validation.
- Actual text, formatting, line-break, link, code, and raw-HTML changes still fail.
- Ordinary document-write equivalence and blank-line preservation stay unchanged.
- Preserve source bytes and exact source anchors; no dependency or schema changes.

## 4. UX & Behavior

Starting Feedback on an unchanged document succeeds without rewriting its Markdown.
The existing fail-closed error continues to protect against real source mismatches.
No UI or typography changes are required.

## 5. Technical Plan

Normalize matching generated emphasis/strong closing and opening tokens on either
side of a single inline break, only in renderer equivalence. Keep this token-based
and linear, after existing raw-HTML checks. Never strip formatting tags globally.

- `src/editor/markdownAstEquivalence.ts`: renderer-only token normalization.
- `src/__tests__/editor/markdownAstEquivalence.test.ts`: positive and adversarial comparison cases.
- `src/__tests__/webview/feedbackSnapshotRoundTrip.realEditor.test.ts`: real TipTap regression cases and source anchors.
- `vibe-coding-rules/env-context.md`: document the narrow renderer contract.

## 6. Work Breakdown

- [x] Confirm QA-001 and establish clean branch from the tested baseline.
- [x] RED: add and run regression tests before implementation.
- [x] GREEN: implement narrow token normalization.
- [x] VERIFY: focused tests, original deck snapshot, full tests, lint, release build.
- [x] Retest Feedback in an isolated VS Code Development Host.
- [ ] Complete the 3,000-word, ten-minute reading check in light and dark themes.
- [x] Self-review diff and record stabilization evidence.

## 7. Implementation Log

### 2026-09-17: Plan and reproduction

The existing 63 focused tests passed while the original deck failed. Temporary
real-editor diagnostics established that only the two wrapped italic paragraphs
caused the mismatch. No pre-existing worktree changes were present.

### 2026-09-17: RED, GREEN and automated review

- Before implementation, seven comparison cases and eight real-editor cases
  failed at the renderer-equivalence assertion. Existing controls passed.
- A linear token pass joins matching `em` and `strong` boundaries immediately
  surrounding an inline soft/hard break. Other tokens remain barriers.
- All 90 comparison/real-editor tests passed after the fix. Added host snapshot
  tests also exercise saved bytes, source spans, semantic fingerprints, and
  rejection of formatting loss with a matching reported digest.
- Initial full suite: 145 suites and 2,726 tests passed, with 27 pre-existing
  skips and 120 TODO cases. Lint and release bundle verification passed.
- Independent review found no actionable issues. Local comparison benchmark
  medians: 3,000 words 1.10 ms patched vs 1.13 ms baseline; 10,000 marked lines
  17.87 ms patched vs 17.78 ms baseline. These are local observations, not a
  cross-platform performance claim.
- Native host prepared at `/private/tmp/md4h-inline-mark-native/`. Computer Use
  reported the Mac locked; requested unlock before native UI and reading checks.

References checked: [Markdown-it token architecture](https://github.com/markdown-it/markdown-it/blob/master/docs/architecture.md)
and [related TipTap line-break issue](https://github.com/ueberdosis/tiptap/issues/8136).
The fix uses the locally installed TipTap 3.30.5 behavior as its authority; the
related upstream issue describes a different soft-break contract.

### 2026-09-17: Final verification

- Final full suite: **145 suites, 2,728 tests passed**; 27 existing skips and
  120 TODO cases remain. All 29 new regression cases pass.
- Full lint, release build verification, package build, and diff whitespace
  checks passed. No new dependencies or license updates are required.
- The frozen original deck and all nine diagnostic variants pass real-editor
  comparison, anchor mapping, source preparation, and snapshot finalization.
- An isolated VS Code 1.138 host running the release bundle passed five native
  cases: original deck, current deck copy, repeat original, wrapped italic,
  wrapped bold. Each persisted the correct source hash, completed a session-bound
  renderer-to-host Reveal request, and preserved the source bytes.
- Native evidence: `/private/tmp/feedback-native-api-xesg5nix/installed-results.json`.
- Packaged build: `/private/tmp/markdown-for-humans-0.3.0-inline-mark-fix.vsix`.
- The only incomplete gate is the visual 3,000-word, ten-minute light/dark
  reading check. Computer Use cannot inspect the locked Mac. Keep this plan in
  pipeline until that gate is completed or the user explicitly accepts the gap.
- The user's installed extension and original deck were not edited. Changes are
  uncommitted on the recorded feature branch; no push was performed.

## 8. Decisions & Tradeoffs

### Branch consolidation, 2026-09-17

Renamed the working branch to `feature/llm-feedback` at the user's request.
The following local branch tips were verified as ancestors of the current HEAD
before removing their redundant branch names:

| Former branch | Preserved commit |
| --- | --- |
| `codex/feedback-review` | `ff99339` |
| `fix/feedback-review-findings` | `7a018c6` |
| `feature/feedback-native-selection` | `2a75861` |
| `feature/semantic-feedback-selection` | `82b8bfa` |
| `feature/feedback-list-snapshot-parity` | `8cd2214` |

Applied the remaining `fix/copy-ai-context-line-numbers` change without creating
a commit. Its original commit `b8746c4` is retained under the lightweight tag
`archive/copy-ai-context-line-numbers`; its local branch was then removed.
Resolved a test-import conflict while retaining the current literal-preservation
extension. Updated the imported frontmatter predicate to match the current
host's variable-length fence handling. Two new long-fence regression cases
failed before that compatibility adjustment; all 75 AI-context tests then passed.

All tracked changes from the preceding snapshot fix were compared byte-for-byte
against a recovery patch and preserved. No commit, push, remote branch deletion,
or unrelated worktree cleanup was performed. Combined changes are unstaged and
ready for review. A recovery snapshot of branch refs and pre-existing changes is
at `/var/folders/np/5fgmkwvs4hd84stjfp2pr78c0000gn/T/llm-feedback-consolidation-lxmfv7kx`.

Combined package: `markdown-for-humans-0.3.0-llm-feedback.vsix` in the repository root.
Final consolidation verification: 145 suites and **2,739 tests passed**, with the
same 27 skips and 120 TODO cases. Lint, release build, VSIX creation, archive
integrity, and diff whitespace checks passed. The earlier visual reading gate
remains pending; consolidation does not claim to complete that check.

Keep the correction inside Feedback renderer equivalence. The snapshot guard and
source-writing policy retain their safety contracts. Do not add private deck prose
to fixtures or rewrite the original document to work around the defect.

## 9. Follow-up & Future Work

The user subsequently requested review and commit. Review of the consolidated
production changes, regression tests, and verification evidence found no blocking
issues. The reviewed changes are authorized for a local commit; no push is
authorized. The generated VSIX remains an ignored local build artifact.

Complete the pending 3,000-word, ten-minute light/dark reading check before
marking this plan shipped. Automated verification does not replace that gate.
