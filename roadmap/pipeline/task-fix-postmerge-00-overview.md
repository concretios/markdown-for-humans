# Post-merge review findings: overview (PRs #93, #97, #100, #101, #102)

## 1. Metadata

- **Created:** 2026-09-30
- **Base reviewed:** `origin/main` @ `1b8244b` (all line numbers in the chunk files refer to this commit)
- **Source:** post-merge code review, 2026-09-30 (six parallel reviewers, read-only, findings verified by reading code; some confirmed by running the real TipTap editor)
- **Status:** live index — chunks 02–07 + 01-R1 shipped in 0.4.0; open work is 01 (R2–R5), 08, and followups

---

## 0. Release 0.4.0 cut (2026-10-01) and what is left

**Shipped in 0.4.0** (plans now under `roadmap/shipped/`):

| Chunk | Plan path | Notes |
|---|---|---|
| 02 Security | `roadmap/shipped/task-fix-postmerge-02-security.md` | Open review findings logged, not all fixed |
| 03 Sync | `roadmap/shipped/task-fix-postmerge-03-document-sync-save.md` | Same |
| 04 Images | `roadmap/shipped/task-fix-postmerge-04-images.md` | Merged #105 |
| 05 Feedback session | `roadmap/shipped/task-fix-postmerge-05-feedback-session.md` | Same |
| 06 Feedback capture | `roadmap/shipped/task-fix-postmerge-06-feedback-capture.md` | Same |
| 07 Feedback entry UX | `roadmap/shipped/task-fix-postmerge-07-feedback-entry-ux.md` | Related UX plan: `roadmap/shipped/task-feedback-entry-ux.md` (PR #100) |
| 01 (R1 only) | (extract on main) | Minimal R1 serializer fix shipped; R2–R5 held in pipeline chunk 01 |

The 03 and 07 CSS conflict was resolved on the release branch: the out-of-sync banner now follows chunk 07's pattern (moves below Find instead of letting Find cover the toolbar).

**Open work (pipeline only):**
- **Chunk 01 (remainder):** `task-fix-postmerge-01-markdown-roundtrip.md` — R2 to R5, decision #3 (hard-break source forms), escape and paste work. Carries 1 HIGH (clipboard HTML → literal-mark attrs on disk), 6 medium, 11 low. Recommendation: split decision #3 onto its own branch.
- **Chunk 08:** `task-fix-postmerge-08-ai-review-ci.md` — AI reviewer CI coverage.
- **Follow-ups:** `task-followups-postmerge.md` (FU1 symlink containment; FU1b task item data loss are priorities).
- **Pending decisions:** (a) split decision #3 out of chunk 01; (b) make the editor read-only while out of sync so edits typed after the banner cannot be lost on Reload.

**Scratch / do not resume blindly:**
- Chunk worktrees `/Users/abhinav/code/markdown-for-humans-pm0N` (branches `fix/postmerge-0N-*`) and `.concret.io/postmerge/wip/` patches are **stale scratch behind main**. Re-diff vs current HEAD before any resume; do not treat them as authoritative.
- `.concret.io/postmerge/` locally now has only `findings/` and `wip/` (`reviewed/` and `release/` are gone).

**Still worth doing (not blocking the index):**
1. Re-gate any resumed 01 work against current findings JSON under `.concret.io/postmerge/findings/`.
2. Real VS Code verification of shipped 03/07 behavior on a current build if regenerating confidence.
3. Chunk 09 (large-file refactor) remains unscoped here.

---

## 2. Why this review happened

The automated reviewer gave almost no coverage on the recent merges:

| PR | Automated review result |
|---|---|
| #93 LLM Feedback sessions (+119k lines) | Never ran. Seven failures: GitHub diff API rejects diffs over 20,000 lines (HTTP 406) |
| #97 AI reviewer v2 upgrade | Approved; its one Low finding was lost (inline POST failed with 422) |
| #100 Feedback entry UX | No review posted (v2 silently skipped it) |
| #101 SVG images | "0 concerns" but only 81/418 changed ranges covered (budget exhausted) |
| #102 AI reviewer fix | Complete, 0 concerns |

---

## 3. Chunks

Each chunk is sized to be one branch and one PR. TDD applies: write the failing test listed under each item first.

| # | File | Theme | Live? | Source PRs |
|---|---|---|---|---|
| 01 | `pipeline/task-fix-postmerge-01-markdown-roundtrip.md` | Saved Markdown silently rewritten | **open** (R2–R5) | #93, #101 |
| 02 | `shipped/task-fix-postmerge-02-security.md` | Local file leak via PDF, unescaped toast | shipped 0.4.0 | #93, #101 |
| 03 | `shipped/task-fix-postmerge-03-document-sync-save.md` | Lost keystrokes, sync loop, silent Ctrl+S | shipped 0.4.0 | #93 |
| 04 | `shipped/task-fix-postmerge-04-images.md` | Paste bypasses lock, base64 bloat, path edge cases | shipped (#105 / 0.4.0) | #93, #101 |
| 05 | `shipped/task-fix-postmerge-05-feedback-session.md` | Discard on remote, stuck saves, locks | shipped 0.4.0 | #93 |
| 06 | `shipped/task-fix-postmerge-06-feedback-capture.md` | Area capture stuck, blank screenshots, perf | shipped 0.4.0 | #93 |
| 07 | `shipped/task-fix-postmerge-07-feedback-entry-ux.md` | Start refused with TOC open, stale notices, focus | shipped 0.4.0 | #93, #100 |
| 08 | `pipeline/task-fix-postmerge-08-ai-review-ci.md` | Reviewer coverage and silent skips | **open** | #97, #102 |

**Suggested order for remaining work:** 01 remainder, then 08, then followups.

**Confidence labels used in chunk files:**
- **confirmed:** reproduced, or traced end to end in code
- **plausible:** code path traced, trigger not reproduced

---

## 4. Cross-cutting recommendations

**Test infrastructure (unblocks several chunks):**
- **Round-trip corpus test:** open each Markdown fixture, make an unrelated edit, save, assert byte-identical output. Would have caught 01/R1, R2, R3.
- **Real VS Code verification** for layout, focus and timing behavior: Extension Host tests (`npm run test:integration`) plus manual or computer-use checks in an Extension Development Host. jsdom cannot model CSS transitions, focus on hidden elements, or hit testing, and the standalone Electron fixtures do not match VS Code's webview host, so they do not count as verification. Would have caught 07/E1, E3, E4 and 04/I1.

**Architecture:**
- Two sync models coexist in the host (new version/ack protocol plus older timing and content-cache skips). Retire the old skips (see 03/Y1).
- File sizes: `MarkdownEditorProvider.ts` 11.4k lines, `feedbackReview.ts` 6k, `feedbackSessionStore.ts` 5.2k, `editor.ts` 3k. Candidates to extract: `DocumentSyncHost`, `FeedbackController`; move webview sync globals (`hostReconciliationPending`, `allowNextHostSyncDespite*`) into `DocumentSyncController`.

**Housekeeping:**
- `src/webview/features/feedbackLifecycleMachine.ts` states in its header that it is not wired into production. Wire it or remove it.
- `feedbackSessionStore.ts` carries v1 to v2 migration and legacy report variants although Feedback first shipped in #93. Check whether the v1 layers are dead weight.
- `package.json` sets `capabilities.untrustedWorkspaces.supported: false` (extension disabled in Restricted Mode). Not in CHANGELOG. Confirm intended.
- Feedback entry UX and PR93 plans are now under `roadmap/shipped/` (including `task-feedback-entry-ux.md` and `task-fix-postmerge-07-feedback-entry-ux.md`).
- PR scope: #101 bundled an unrelated Feedback and paste change (`4b00ab6`) that caused 04/I1. Keep unrelated fixes in their own PRs.
- Local `main` was 91 commits behind `origin/main` at review time.
