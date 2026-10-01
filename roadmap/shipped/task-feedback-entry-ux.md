# Task: Responsive Feedback Entry and Existing-Draft Guidance

## 1. Task Metadata

- **Slug:** feedback-entry-ux
- **Status:** shipped
- **Created / last updated:** 2026-09-30
- **Branch:** feature/feedback-entry-ux
- **PR base:** main (`15cc331`, merge of `feature/llm-feedback`)
- **Shipped:** 2026-09-30, PR #100 (merge `355e037`)
- **Follow-up:** post-merge fixes in `roadmap/pipeline/task-fix-postmerge-07-feedback-entry-ux.md`

## 2. Context & Problem

The Feedback action can appear available while a click produces no visible result.
Computer Use reproduced the search case in the installed extension whose webview
bundle matched this branch: the full-width transparent search wrapper captures
toolbar clicks. Source inspection also found that unfinished comment actions only
announce their refusal to a hidden live region, and peer Feedback locks make the
entire formatting toolbar inert without an actionable route to its owner.

The original workspace contained unrelated SVG implementation changes. Following
the user's request to isolate these fixes for a PR, the Feedback-only files and
hunks were copied into a fresh worktree. The branch is based on `main` after its
merge of `feature/llm-feedback`; the two base trees are identical. The original
workspace and SVG implementation were left intact.

## 3. Desired Outcome & Scope

- Search cannot swallow clicks outside its visible panel.
- Starting/resuming Feedback closes search without restoring an old selection or
  jumping away from the current reading position.
- Conflicting actions visibly explain how to finish the existing draft, reveal
  that draft, and preserve its text and target.
- A locked peer view offers an enabled Go to active feedback action outside the
  inert formatting controls. It navigates to the current live owner without
  transferring ownership or creating a session.
- Genuine modal dialogs retain their background and keyboard isolation.
- Comment actions remain reachable in short editor panes. Locked peer views let
  Tab and Shift+Tab move focus instead of invoking indentation commands.
- Existing read-only, snapshot, draft, capture and source-integrity guards remain.

Out of scope: redesigning Feedback storage, concurrent drafts, changing snapshot
ownership rules, unrelated repository bugs, publishing or installing a release.

## 4. UX & Behavior

1. Open Find, optionally navigate to a match, then click Feedback. Search closes;
   Feedback visibly starts at the same reading location. Search controls continue
   to accept mouse and keyboard input before the transition.
2. While a comment/edit is unfinished, request another action. The existing
   surface receives focus and visible guidance. Its unsaved content remains.
3. In a sibling view locked by Feedback, choose Go to active feedback. The owner
   becomes active. A stale owner or transition yields a useful visible response.
4. Finish/annotation/discard modals keep their explicit completion or cancellation
   flow. Repeated actions must not create duplicate requests or erase drafts.

Use theme colors, keyboard-visible focus, polite announcements, and reduced-motion
safe attention styling. Do not add document-wide work to typing handlers.

## 5. Technical Plan

- Search CSS: pass pointer events through the wrapper; enable the panel only.
- Search dismissal: explicit focus/position-preserving mode for Feedback entry;
  share cleanup across toolbar, command and resume entry points.
- Feedback review: visible, bounded existing-draft guidance and reveal behavior
  at explicit blocked-action boundaries, with cleanup when the surface closes.
- Peer lock: accessible navigation button outside inert toolbar; validate its
  request against the live document owner before revealing its panel.
- Keep strict message parsing and lifecycle guards; no new dependencies.

## 6. Work Breakdown and Verification

- [x] Audit relevant toolbar, search, review, peer-lock, protocol and host paths.
- [x] RED: add failing behavioral/unit regressions before implementation.
- [x] GREEN: implement narrow fixes and run focused tests.
- [x] Review changes and run full Jest, TypeScript, lint and release build.
- [x] Computer Use on an isolated fixture loaded by an Extension Development Host.
- [x] Long-document visual exercise: 4,094 words, over 10 minutes of live editor
  interaction, light and dark, with a high-contrast spot check. This was an
  interactive QA exercise, not an uninterrupted human reading-comfort study.

| Case | Expected outcome | Evidence/status |
| --- | --- | --- |
| Normal start, rapid repeat click | One visible session transition | Start passed in UI; re-entry guarded in unit tests |
| Search empty, match, no match | Toolbar reachable; entry closes Find without jump | UI passed for Start, Start new and Resume; focus/selection tests passed |
| Search mouse, keyboard, Escape | Search stays functional | UI typing, Enter and pointer actions passed; Escape covered by search suite |
| Unsaved comment, repeated new target, deep scroll | Existing draft revealed; text/target preserved; visible message | UI preserved draft on Finish; alternate targets and deep-scroll layout covered by tests |
| Saved comment edit, capture or finish in progress | Existing action preserved; useful guidance | UI edit + Capture + Finish passed; pending capture/save paths passed unit tests |
| Peer split, owner active/hidden/disposed | Owner navigation or useful stale-state response; no transfer | Active/hidden owner passed UI; stale/disposed/transition cases passed host tests |
| Keyboard, narrow split, light/dark/high contrast | Controls and guidance visible, usable and contained | UI passed; two additional defects found and fixed with TDD |
| Cancel, complete, reopen | No stale guidance, blocked toolbar or duplicate handlers | UI completion Resume, Finish, Done, reload and saved Resume passed |
| Unrelated document and modal input | Separate document editable; genuine modal preserved | Independent editing and unsaved equation + Start command passed UI |

## 7. Implementation Log

- 2026-09-30: Plan created. Earlier read-only drill reproduced search interception;
  existing toolbar and peer-lock suites passed 37 tests despite the UX defect.
- 2026-09-30: Added failing tests, then implemented search hit testing and
  dismissal, visible draft guidance, modal preservation, and validated peer-owner
  navigation. Updated the obsolete test expecting Finish to be disabled with an
  unfinished comment; it now dispatches to the draft-preserving controller.
- 2026-09-30: Computer Use exposed recovery banners overlapping Find, clipped
  composer buttons in horizontal splits, and Tab indentation swallowing focus
  traversal in a locked peer. Added regressions before each fix and retested the
  actual UI. Internal composer scrolling retains document position and input.
- 2026-09-30: Latest full Jest run passed 3,058 tests across 163 suites, with
  27 existing skipped tests and 120 todo cases. TypeScript, lint, release build,
  and diff checks passed. The shared branch also contains concurrent SVG tests;
  this total describes the whole working tree, not just this feature.
- 2026-09-30: Extracted the Feedback changes into `feature/feedback-entry-ux` for
  the requested PR. Only two Feedback hunks from `MarkdownEditorProvider.ts` and
  four Feedback/search hunks from `editor.css` were retained. No SVG, dependency,
  package script, README, or CI changes are included.
- 2026-09-30: Updated the branch base to `origin/main` at the user's request after
  `feature/llm-feedback` was merged. Verified the base file trees are identical,
  so the extraction and validation remain applicable without source changes.
- The Computer Use matrix above summarizes the original local QA report, which
  is excluded from Git by the repository's findings policy. Its UI checks ran on
  the original combined working tree; isolated branch validation is recorded
  below before creating the PR.
- 2026-09-30: Isolated branch Jest passed 2,824 tests across 151 suites, with
  27 existing skipped tests and 120 todo cases. TypeScript, lint and release build
  passed. VSIX packaging also passed using a local dependency installation with
  the unchanged lockfile. The smaller total excludes unrelated SVG tests. Before/after screen
  recordings are not available, so the requested PR is opened as a draft in
  accordance with the PR template's visual-evidence requirement.

## 8. Decisions & Tradeoffs

- Navigate to the current Feedback owner instead of silently moving ownership.
- Preserve unfinished work; explain the required next action visibly.
- Use real rendered UI checks for hit testing because jsdom cannot prove pointer
  interception or visual layout.

## 9. Follow-up & Future Work

Review the isolated PR before merging or shipping. The user explicitly requested
branch creation and a PR after the implementation review. No release installation
was performed. UI execution used macOS and VS Code 1.139.1;
Windows, Linux, the minimum supported VS Code version, race timing in a real host,
and uninterrupted human reading comfort remain outside this execution evidence.
