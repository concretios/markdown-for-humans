# Post-merge review findings: overview (PRs #93, #97, #100, #101, #102)

## 1. Metadata

- **Created:** 2026-09-30
- **Base reviewed:** `origin/main` @ `1b8244b` (all line numbers in the chunk files refer to this commit)
- **Source:** post-merge code review, 2026-09-30 (six parallel reviewers, read-only, findings verified by reading code; some confirmed by running the real TipTap editor)
- **Status:** partially shipped in 0.4.0 (2026-10-01); remaining work listed in section 0

---

## 0. Release 0.4.0 cut (2026-10-01) and what is left

**Shipped in 0.4.0** (branch `release/0.4.0`), each at its deep-reviewed state:

| Chunk | Commit subject | Open review findings shipped (logged, not fixed) |
|---|---|---|
| 02 Security | fix(security): contain export image sources... | 2 medium (NBSP or U+FEFF bypass of the export drop pass; Word export can read out-of-root files via `blob:` or `vscode-webview://`), 7 low |
| 03 Sync | fix(sync): stop losing keystrokes... | 2 medium (a racing outside writer can exhaust the retry budget and leave the view out of sync; the A->B->A revert fix is defeated for 2 s after the split's own send), 17 low |
| 05 Feedback session | fix(feedback): harden session lifecycle... | 9 low (one is security hygiene: error notifications can render a `command:` link built from a repo directory name) |
| 06 Feedback capture | fix(feedback): recover area capture... | 5 low |
| 07 Feedback entry UX | fix(feedback): keep Feedback entry responsive... | 5 low |
| 01 (R1 only) | fix(serializer): stop rewriting mid-line > as &gt; | Minimal extract of R1 with its tests; the rest of chunk 01 is held |

The 03 and 07 CSS conflict was resolved on the release branch: the out-of-sync banner now follows chunk 07's pattern (moves below Find instead of letting Find cover the toolbar).

**Held for the next build:**
- **Chunk 01 (rest):** R2 to R5, decision #3 (hard-break source forms), the escape and paste work. It carries 1 HIGH security finding introduced by the round-2 paste fix (crafted clipboard HTML can set literal-mark attributes that are written to disk verbatim), 6 medium (mostly in the decision #3 hard-break code) and 11 low. Recommendation: split decision #3 into its own branch and ship it via a pre-release.
- **Pending decisions:** (a) split decision #3 out of chunk 01; (b) make the editor read-only while out of sync, so edits typed after the banner appears cannot be lost on Reload.

**Where the work is:**
- Chunk worktrees `/Users/abhinav/code/markdown-for-humans-pm0N` (branches `fix/postmerge-0N-*`) hold the stopped deep-fix round's partial work, unverified (fixers were stopped mid-run; rerun all gates before trusting them).
- `.concret.io/postmerge/` in the main checkout (local, untracked): `reviewed/` (deep-reviewed patches and files per chunk), `wip/` (the stopped round's partial patches), `findings/` (per-chunk upheld findings JSON with skeptic notes, `deep-result.json`), `release/` (R1 patch, gate logs).

**Not done yet:**
1. Finish the deep-review fix round for all chunks (findings JSON above), then re-review and re-gate.
2. Real VS Code verification of the shipped 03 and 07 behavior (out-of-sync banner, conflict notice, Start with TOC, Find or dialogs open, focus) on the 0.4.0 VSIX. Chunks 01, 02 and 05 were checked in VS Code in round 1; 06 and 07 only through Jest and Extension Host tests.
3. Follow-ups in `task-followups-postmerge.md` (FU1 symlink containment in image handlers and FU1b task item data loss are the priorities).
4. Chunk 08 (AI reviewer CI coverage) and chunk 09 (large-file refactor plan).

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

| # | File | Theme | High | Med | Low | Source PRs |
|---|---|---|---|---|---|---|
| 01 | `task-fix-postmerge-01-markdown-roundtrip.md` | Saved Markdown silently rewritten | 2 | 2 | 1 | #93, #101 |
| 02 | `task-fix-postmerge-02-security.md` | Local file leak via PDF, unescaped toast | 0 | 2 | 0 | #93, #101 |
| 03 | `task-fix-postmerge-03-document-sync-save.md` | Lost keystrokes, sync loop, silent Ctrl+S | 0 | 3 | 1 | #93 |
| 04 | `task-fix-postmerge-04-images.md` | Paste bypasses lock, base64 bloat, path edge cases | 0 | 1 | 5 | #93, #101 |
| 05 | `task-fix-postmerge-05-feedback-session.md` | Discard on remote, stuck saves, locks | 0 | 3 | 4 | #93 |
| 06 | `task-fix-postmerge-06-feedback-capture.md` | Area capture stuck, blank screenshots, perf | 0 | 2 | 3 | #93 |
| 07 | `task-fix-postmerge-07-feedback-entry-ux.md` | Start refused with TOC open, stale notices, focus | 0 | 1 | 5 | #93, #100 |
| 08 | `task-fix-postmerge-08-ai-review-ci.md` | Reviewer coverage and silent skips | 1 | 2 | 2 | #97, #102 |

**Suggested order:** 01, 02, 03, then 08 (so later PRs get real review), then 04 to 07.

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
- `roadmap/pipeline/task-feedback-entry-ux.md` still says "Shipped: pending"; move to `roadmap/shipped/` with `git mv`. Check the other merged-work plans in `pipeline/` (`pr93-stability-fixes.md`, `task-fix-pr93-*`) the same way.
- PR scope: #101 bundled an unrelated Feedback and paste change (`4b00ab6`) that caused 04/I1. Keep unrelated fixes in their own PRs.
- Local `main` was 91 commits behind `origin/main` at review time.
