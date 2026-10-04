# Task: Fix Feedback entry UX findings from post-merge review

## 1. Task Metadata

- **Task name:** Fix Feedback entry UX findings
- **Slug:** fix-postmerge-07-feedback-entry-ux
- **Status:** shipped in 0.4.0
- **Created:** 2026-09-30
- **Last updated:** 2026-10-01
- **Shipped:** 2026-10-01 (0.4.0)
- **Base:** `origin/main` @ `1b8244b` (findings); implemented on `origin/main` @ `39dfe56`
- **Branch:** `fix/postmerge-07-feedback-entry-ux`
- **Overview:** `task-fix-postmerge-00-overview.md`
- **Related plan:** `roadmap/shipped/task-feedback-entry-ux.md` (PR #100)

---

## 2. Context & Problem

PR #100 set out to make Feedback entry responsive alongside Find, unfinished drafts and split editors. Several paths still produce "nothing happens", wrong guidance, or stale notices. E1, E3 and E4 depend on real layout, focus and CSS transitions, which jsdom cannot exercise.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Start Feedback always gives visible feedback, with TOC, Find or Link open
- Guidance messages match the actual state and never go stale
- Focus always lands on a visible, focusable element, without moving the caret or the reading position
- Manual VS Code checks (section 5) cover Start with TOC, Find, Link and the audit overlay open
- `npm test` passes

**In scope:** E1 to E8, manual VS Code checks, plan housekeeping
**Out of scope:** new entry points

---

## 4. Findings

### E1. MED (#100): Start Feedback from Command Palette silently refused while TOC is open. Plausible; mechanism confirmed in Chromium.

- **Where:** `src/webview/editor.ts:2448-2450` closes the TOC, then `src/webview/features/feedbackReview.ts:4148` calls `focusModalSurfaceBefore` (filter at `:4112-4119`).
- **Defect:** the TOC (`role="dialog" aria-modal="true"`, `transition: visibility .2s`) is tested with `getComputedStyle(...).visibility` immediately after closing; it still reports `visible` during the fade, so the gate treats it as an open dialog.
- **Scenario:** `start()` bails; the guidance notice goes into the fading TOC panel; focus moves to a TOC control that becomes hidden. Nothing visible happens: the exact "Feedback looks unresponsive" bug #100 targeted.
- **Fix direction:** gate on explicit open state (class or flag), not computed visibility.
- **Test first:** jsdom with the real TOC module: close the TOC, run Start, session starts. Manual VS Code check M1.

### E2. LOW-MED (#100): "Go to active feedback" during a Start or Resume transition gives wrong advice. Confirmed.

- **Where:** `src/editor/MarkdownEditorProvider.ts:4700`; transition lock id is random hex (`:5949`); "changing state" branch at `:4712` is never reached. Also the owner's self-restore lock (`:6031`).
- **Scenario:** user sees "Active Feedback is no longer available... reopen this document and resume its saved Feedback draft" while the owner split is merely starting.
- **Test gap:** `src/__tests__/editor/feedbackPeerNavigation.test.ts:141-158` uses matching ids and asserts `/try again/i`; both messages contain "Try again", so it passes either way.
- **Fix direction:** check the transition before the session id comparison.
- **Test first:** transition with no session and a random lock id returns the "changing state" message; assert on a string unique to it.

### E3. LOW (#100): guidance notices persist in reused dialogs. Confirmed by code.

- **Where:** `src/webview/features/feedbackReview.ts:1293-1321` (`showSurfaceAttention`), called from `:4132`. Link dialog (`linkDialog.ts:1097`) and Table dialog (`tableInsert.ts:179`) are hidden singletons.
- **Scenario:** Link dialog open, click Feedback (toolbar z-index 100 is above link overlay 50), notice appears. Escape without starting. Next Cmd+K Link dialog still says "Complete or close this dialog before starting Feedback."
- **Fix direction:** clear the notice when the host dialog closes.
- **Test first:** close and reopen the Link dialog; no notice.

### E4. LOW (#100): keyboard focus lost when Start begins from the Find input. Plausible.

- **Where:** `src/webview/editor.ts:2445-2447` (`hideSearchOverlay(editor, false)`), `src/webview/features/searchOverlay.ts:591`, `src/webview/features/feedbackReview.ts:1479-1492` (`rememberTransitionFocus` / `restoreTransitionFocus`)
- **Scenario:** remembered target is the Find input, which is then hidden (Chromium blurs it to `BODY`). On failure or cancel, `.focus()` on the hidden input does nothing; because it is still connected, the editor or banner fallback is skipped.
- **Fix direction:** in `restoreTransitionFocus`, verify the target is visible and focusable; otherwise use the fallback.
- **Test first:** jsdom: Start from Find fails, `document.activeElement` is the editor. Manual VS Code check M3.

### E5. LOW (#100): with a saved-draft banner, Find covers toolbar buttons. Plausible (layout).

- **Where:** `src/webview/editor.css:3996-3999` moves Find into the toolbar row (z-index 1001 over toolbar 100, `pointer-events: auto`, 320 to 500px wide).
- **Scenario:** in narrow splits, live toolbar buttons under the panel cannot be clicked while Find is open.
- **Fix direction:** position Find below the toolbar, or make it narrower in this state.

### E6. LOW (#93): Feedback More menu can attach a listener after it closed. Plausible.

- **Where:** `src/webview/editor.ts`, `showFeedbackMoreMenu` last line: `setTimeout(() => addEventListener('pointerdown', ...), 0)`
- **Scenario:** menu closes before the timeout fires; a stale capture listener holding the old menu closes the next menu on click. A toolbar re-render (`replaceChildren` in `BubbleMenuView.ts`) removes the menu without `close`.
- **Fix direction:** guard the deferred add with a "still open" check; close on re-render.

### E7. NON-BUG (#100): duplicate messages on capture conflict.

- New blocked paths call `focusActive()`, which now shows a notice; `src/webview/features/feedbackCaptureWorkflow.ts:214` also announces its own message. Two differently worded messages appear. Keep one.

### E8. HOUSEKEEPING (#100)

- `roadmap/pipeline/task-feedback-entry-ux.md` still says "Shipped: pending". Move with `git mv` to `roadmap/shipped/`.

---

## 5. Progress

All tests were written first and seen failing for the stated reason before the fix.

| ID | Test (red before fix) | Fix | Verified |
|---|---|---|---|
| E1 | jsdom: closed TOC and Table dialogs blocked Start (jsdom computes the closed TOC as visible, as Chromium does during its 200 ms fade) | `feedbackReview.ts` `isOpenModal`: `.toc-overlay` and `.export-settings-overlay` are open only with their `visible` class; other dialogs keep the computed-style check | Jest; manual M1 pending |
| E2 | Transition lock id with no session, and the owner's self-restore lock, both got "no longer available" | `MarkdownEditorProvider.revealFeedbackOwner`: report "changing state" when the lock is the current transition id, or the sender's own session id, before the session id comparison | Jest |
| E3 | Link and Table: notice still present after close and reopen (jsdom) | `focusModalSurfaceBefore` observes the host dialog's `class`, `style`, `hidden` and `aria-hidden`; clears the notice once `isOpenModal` is false. `clearDraftSurfaceAttention` disconnects the observer | Jest; manual M2 pending |
| E4 | jsdom model: after a failed Start the remembered control refused focus (as a hidden control does in Chromium) and the editor fallback was skipped | `restoreTransitionFocus` uses `focusElementWithoutScroll`, which verifies focus landed; otherwise banner action or editor. Completed by 07-F1 and review fix round 3 | Jest; manual M3 pending |
| E5 | CSS contract test: with a saved-draft banner, Find moved into the toolbar row | `editor.css`: Find keeps its row below the toolbar; `body:has(.search-overlay.visible) .feedback-draft-banner { top: 104px }`. Peer-lock rule unchanged (toolbar is inert there) | Jest (CSS contract only); manual M4 pending |
| E6 | Menu closed before its deferred listener ran: next menu closed on click. Toolbar re-render left the capture listener attached | `editor.ts` `showFeedbackMoreMenu`: deferred add only while `closeFeedbackMoreMenu === close`; a `MutationObserver` on the toolbar closes the menu once it is detached | Jest |
| E7 | Real controller: capture blocked by a comment showed the inline notice and a `feedbackLocalError` toast | `feedbackCaptureWorkflow.ts` `focusActiveCaptureWorkflow` returns `gate.focusActive()`; the gate's notice on the owning surface is the only message | Jest |
| E8 | n/a | `git mv` to `roadmap/shipped/task-feedback-entry-ux.md`; Status shipped, Shipped 2026-09-30 (PR #100, `355e037`) | `git status` shows rename |

The Electron entry smoke test was removed from this chunk on the user's instruction: the standalone Electron build does not match VS Code. No item here relies on Electron results. Real layout, fades, scrolling and focus are covered by the manual VS Code checks below.

### Tests

- `src/__tests__/webview/feedbackEntryUx.realEditor.test.ts` (new, real TipTap plus real TOC, Find, audit, Link and Table modules; round 3 tests are listed in that section)
  - E1: `starts Feedback right after the TOC closes`, `starts Feedback right after the Table dialog closes`, `still redirects Start to a TOC that is open`
  - E3: `clears the Start notice when the Link dialog closes`, `... when the Table dialog closes`
  - E4: `falls back to the editor when the remembered control refuses focus` (renamed in the review fix round, see 07-F1), `returns focus to a remembered control that is still visible`
  - E7: `shows one message, on the comment, instead of a second toast`
- `src/__tests__/editor/feedbackPeerNavigation.test.ts` (E2): `reports a Start or Resume transition whose lock is not a session id as changing state`, `reports the owner restoring its own session as changing state`; the existing transition-state cases now assert `/changing state/` (both messages contain "Try again")
- `src/__tests__/webview/feedbackMoreMenu.test.ts` (new, E6): `does not let a menu that closed before its deferred listener close the next menu`, `closes the menu and drops its listener when a toolbar re-render removes it`
- `src/__tests__/webview/searchOverlay.test.ts` (E5): `keeps Find below the live toolbar and moves a saved-draft banner below Find` (replaces the test that required Find in the toolbar row)
- `src/__tests__/webview/feedbackCaptureWorkflow.test.ts` (E7): three conflict tests now assert one gate guidance call and no `feedbackLocalError`

### Decisions

- E1: explicit open state is the existing `visible` class of the two mounted, fading dialogs. No new flags; created-and-removed dialogs keep the computed-style check because they cannot lag.
- E2: the transition check requires a registered sender with the current view generation, so stale renderers still get the "no longer available" advice.
- E3: one observer in `feedbackReview.ts` instead of edits to `linkDialog.ts` and `tableInsert.ts`, so dialog modules stay unaware of Feedback.
- E4: jsdom does not refuse focus on hidden elements; the unit test stubs that refusal and manual check M3 covers real VS Code.
- E5: moved the banner, not Find. Narrowing Find in the toolbar row still covers buttons in a narrow split, and a banner of variable height cannot sit above Find. The banner returns to 48 px when Find closes. 104 px = Find row 50 px + 46 px panel (28 px controls, padding, border) + 8 px gap. Manual check M4 confirms the rendered geometry. The 56 px shift (48 px to 104 px) while Find is open was confirmed by the user as product decision #10 (see Decisions applied).
- E7: kept the gate notice (same wording family as every other blocked action, placed on the owning surface) and removed the capture-specific toast. Production controllers always provide `draftSurfaceGate`.
- No CHANGELOG entry, to avoid conflicts with sibling post-merge branches. Add one line when these branches merge.

### Verification (2026-10-01)

| Gate | Result |
|---|---|
| `npm ci` | ok |
| `npm test` | 185 suites passed (1 skipped), 3398 tests passed |
| `npm run lint` | clean |
| `npx tsc --noEmit` | clean |
| `npm run test:integration` | 7 passing on VS Code 1.140.0, first run (no flake) |

Still open: the manual VS Code checks below, the More menu in a real Extension Development Host, and the 3000 word reading pass in light and dark.

### Review fix round (2026-10-01)

Five findings from code review. Each new or strengthened test was seen failing for the stated reason. The mutation check reverted only that finding's production change (editor-level edit), ran the test, saw it fail, then restored the change.

| ID | Finding | Outcome | Fix | Tests | Mutation check |
|---|---|---|---|---|---|
| 07-F1 (MED) | E4 only partly fixed. A Start from Find that failed within the 150 ms fade restored focus to the fading input, which then dropped to `BODY`. A successful Start from Find always left `BODY`. The TOC had the same gap, because TipTap focuses the editor one frame later and the remembered TOC item was restored inside its fade | fixed | `feedbackReview.ts` `start()`: when focus sits in `.search-overlay:not(.visible)` or `.toc-overlay:not(.visible)`, move it to the editor before remembering the return target. This covers failure and success. Superseded in review fix round 3 (07-R1 to 07-R3) | `moves focus to the editor when Start from Find fails during the fade`, `leaves focus in the editor when Start from Find succeeds`, `moves focus to the editor when Start after closing the TOC fails`. The old Find test passed through the new path, so it was retargeted as `falls back to the editor when the remembered control refuses focus` to keep guarding the `restoreTransitionFocus` fallback. | Block removed: the 3 new tests fail (focus on the Find input or TOC item). Fallback reverted to `preferred.focus()`: the retargeted test fails |
| 07-F2 (LOW) | Notice for an open TOC was prepended to the full-viewport `.toc-overlay` root. It sat under the backdrop, pushed the panel sideways, and drew the outline off screen | fixed | `showSurfaceAttention`: add `.toc-overlay-panel` to the notice surfaces. The notice is prepended to the panel, as in the Link and Table panels | `still redirects Start to a TOC that is open` now requires the notice and attention class on the panel, not the root | Selector removed: jsdom test fails |
| 07-F3 (LOW, test only) | No test for the E2 rule that stale or unregistered senders still get "no longer available". Stale cases asserted a regex that matched both warnings | fixed (tests) | none | `tells a stale-generation / unregistered-sender / stale-owner renderer that its transition lock is no longer available`. The 6 existing stale-path cases now assert `/no longer available/` | Both guards removed: 3 fail. Only `peers?.has(webview)` removed: `unregistered-sender` fails. Only the generation check removed: `stale-generation` and `stale-owner` fail |
| 07-F4 (LOW, test only) | E3 observer guard (keep the notice while the dialog stays open) untested | fixed (tests) | none | `keeps the Start notice while the dialog stays open`. It uses a dialog with no known panel, such as SVG display size, where the 1800 ms attention timer changes the observed class. After 07-F2 the TOC attention target is the panel, so the TOC no longer exercises this guard | Guard made unconditional: test fails (notice removed) |
| 07-F5 (LOW) | A More menu closed by a toolbar re-render dropped keyboard focus to `BODY` | fixed | `editor.ts` `showFeedbackMoreMenu` re-render observer: if focus fell to `BODY` when the menu was detached, focus the re-rendered `[data-feedback-more]` button. Focus that the re-render moved elsewhere, such as Undo delete, is left alone | `moves focus to the re-rendered More button when a re-render removes the focused menu`, `keeps focus that the re-render moved elsewhere` | Refocus removed: first test fails. Refocus made unconditional: second test fails |

Verification after the fix round:

| Gate | Result |
|---|---|
| `npm test` | 185 suites passed (1 skipped), 3407 tests passed |
| `npm run lint` | clean |
| `npx tsc --noEmit` | clean |
| `npm run test:integration` | 7 passing on VS Code 1.140.0, first run |

### Review fix round 3, iteration 1 (2026-10-01)

Three claims upheld by independent skeptics. 07-R1 and 07-R3 share one root cause. Each test was seen failing for the stated reason before the fix. The mutation check reverted only that claim's production change (editor-level edit from a private backup), ran the tests, saw the named test fail, then restored the change.

| ID | Claim | Outcome | Fix | Tests | Mutation check |
|---|---|---|---|---|---|
| 07-R1 (MED, new defect) | 07-F1 focused the editor with a bare `focus()` while the selection was in the Find input. Chromium collapses that selection to the editor start; ProseMirror's `DOMObserver.flush` (prosemirror-view 1.42.3) treats it as a focus reset, restores the old caret and calls `scrollToSelection()`. Start from Find after scrolling snapped the page back to the caret | fixed | `feedbackReview.ts` `start()`: `editor.view.focus()` instead of `focusElementWithoutScroll(editorDom)`. It focuses with `preventScroll` and writes the ProseMirror selection to the DOM in the same step, so no reset is read and nothing scrolls | `keeps the reading position when Start from Find focuses the editor` | Bare focus restored: fails, `handleScrollToSelection` called once |
| 07-R3 (MED, new defect) | Same root cause. Without a focus event (the window lacks system focus, as on the Command Palette path) ProseMirror adopts the reset caret instead: the selection moves to the document start | fixed | Same change as 07-R1 | `keeps the caret when Start from Find focuses the editor without a focus event` | Bare focus restored: fails, selection 1 instead of 12 |
| 07-R2 (LOW, unresolved) | The handoff missed the audit overlay, which editor.ts also closes and which fades the same way with focusable items. It also ran after `if (session \|\| startRequestId) return`, so Start from Find during a session left focus to drop to `BODY` | fixed | `start()`: the handoff selector adds `.audit-overlay:not(.visible)`, and the handoff now runs before the session and pending-Start early returns (after the completion dialog branch, which moves focus itself) | `moves focus to the editor when Start succeeds after closing the audit overlay`, `moves focus to the editor when Start from Find runs during a session` | Audit selector removed: audit test fails (focus on the audit item). Handoff moved back after the early return: session test fails (focus on the Find input) |

Decisions:
- jsdom cannot scroll or reset a caret on focus. The 07-R1 and 07-R3 tests model Chromium's rule for `focus()` on a contenteditable root: the focus event fires, then a selection outside the editor collapses to its start; no focus event is fired while the window lacks system focus. ProseMirror's real `DOMObserver` then reads that caret. The scroll is observed through ProseMirror's public `handleScrollToSelection` prop.
- 07-R2: kept the handoff in the controller rather than moving it into editor.ts `closeIncompatibleFeedbackSurfaces`, the reviewer's alternative. Placing it before the early returns covers every return path the claim names, keeps the real-editor tests, and needs no new editor.ts harness.
- 07-R2: a Start during an active session stays a no-op. Focus now goes to the editor, as when Find is closed with Escape.
- TOC: unchanged. `hideTocOverlay` already focuses the editor one frame later with `editor.commands.focus()`, which scrolls to the selection; that predates this chunk.
- Not changed, observation only: the `restoreTransitionFocus` fallback (base code) still calls a bare `editorDom.focus()`. After this round, Find, TOC and audit Starts remember the editor, so the fallback runs only when another remembered control refuses focus.

Verification after round 3:

| Gate | Result |
|---|---|
| `npm test -- --maxWorkers=4` | 185 suites passed (1 skipped), 3411 tests passed |
| `npm run lint` | clean |
| `npx tsc --noEmit` | clean |
| `npm run test:integration` | 7 passing on VS Code 1.140.0, first run |

### Decisions applied (2026-10-01)

The user approved every recommendation in the post-merge decision list. Two items belong to this chunk. The test for 07-R4 was seen failing for the stated reason before the fix. Each mutation check reverted one production edit from a private backup, ran the tests, saw the named test fail, then restored the change.

| Item | Outcome | Change | Tests | Mutation check |
|---|---|---|---|---|
| Decision #10: the saved-draft banner may shift 56 px while Find is open | confirmed, no code change | None. E5 already moves the banner from `top: 48px` to `top: 104px` while `.search-overlay.visible` exists, and back when Find closes | Existing `keeps Find below the live toolbar and moves a saved-draft banner below Find` (`searchOverlay.test.ts`) | n/a (no production change) |
| 07-R4 (LOW, leftover claim): Start during a session with the Feedback More menu focused left focus on `BODY` | fixed | `editor.ts` `closeIncompatibleFeedbackSurfaces`: when focus is inside `.feedback-more-menu`, close the menu with focus return, as Escape does. `showFeedbackMoreMenu` `close`: the More button is focused with `preventScroll`. Start during a session stays a no-op | `keeps focus on the More button, without scrolling, when Start runs during a session` (red before the fix: active element was `BODY`); `leaves focus outside the menu in place when Start closes it` (guard: passes before and after) | Menu closed with `false` again: the first test fails (active element `BODY`). `preventScroll` removed: the first test fails (scrollTop 0, expected 900). Focus return made unconditional: the guard test fails (focus moved from the card to the More button) |

Decisions:
- 07-R4 target: the More button, not the editor. Each surface that Start closes hands focus to the place its own Escape would. Escape on Find returns to the editor (07-R2); Escape on the More menu returns to the More button. The button stays in the sticky toolbar, so it is always visible, and `preventScroll` keeps the reading position.
- 07-R4 scope: focus moves only when it was inside the menu. Focus that another control already holds, such as a card focused by Next feedback while the menu stays open, is left alone.
- Not changed, observation only: the 07-F5 re-render observer still calls a bare `focus()` on the re-rendered More button in the same sticky toolbar. Chromium should find it already in view, so no scroll is expected; it is outside this item.

Verification after the decisions round:

| Gate | Result |
|---|---|
| `npm test -- --maxWorkers=3` | 185 suites passed (1 skipped), 3413 tests passed |
| `npm run lint` | clean |
| `npx tsc --noEmit` | clean |
| `npm run test:integration` | 7 passing on VS Code 1.140.0, first run |

### Manual VS Code checks (pending)

jsdom has no fades, layout, scrolling or system focus, and the standalone Electron build was ruled inaccurate for VS Code. These checks replace it.

Setup:
- Run the `Run Extension` launch configuration (F5) from this worktree. In the Extension Development Host, open the worktree folder.
- Open `docs/ARCHITECTURE.md` (about 4,300 words) with **Open with Markdown for Humans**.
- Start Feedback has no default keybinding. Use **Markdown for Humans: Start Feedback** from the Command Palette, and for the keybinding path add a personal keybinding for `markdownForHumans.feedback.start` to any free key.
- To read focus: **Help > Toggle Developer Tools**, pick the webview's `active-frame` in the console context menu, and evaluate `document.activeElement`. "Editor" below means the `.ProseMirror` element; it must never be `body`.
- After each check, end the session with **Markdown for Humans: Discard Feedback Draft** (or Finish) so the next check starts clean.

| Check | Covers | Steps | Expected |
|---|---|---|---|
| M1 | E1 | Click the toolbar Outline button; focus is in the TOC. Run Start Feedback from the Command Palette | The TOC closes and Feedback starts. No "Complete or close this dialog before starting Feedback." notice. After 1 s the active element is the editor |
| M2 | E3 | Open the Link dialog (toolbar Link, or Cmd+K Cmd+L). Click the toolbar **Start feedback** button. Press Escape, then open the Link dialog again. Repeat with the toolbar Table dialog | The notice shows inside the open dialog, and is gone when the dialog opens again |
| M3 | E4, 07-F1 | (a) Cmd+F, type a word, keep focus in Find, run Start Feedback from the Command Palette. (b) Failure path: in a second window with no folder open, use **File > Open File...** on a copy of `docs/ARCHITECTURE.md` outside the workspace, open it with Markdown for Humans, press Cmd+F, run Start Feedback. (c) Same window as (b): open the Outline, run Start Feedback | (a) Find closes, Feedback starts, the active element is the editor. (b), (c) The host reports "Open this saved Markdown file inside a workspace before starting feedback."; after 1 s the active element is the editor, not the hidden Find input, a TOC item or `body` |
| M4 | E5 | Create a saved draft: Start Feedback, add one comment, close the editor tab without finishing, reopen the file with Markdown for Humans; the saved-draft banner shows. Narrow the editor group to about 600 px. Press Cmd+F | Find sits below the toolbar. Every toolbar button stays visible and clickable. The banner moves below Find (a 56 px shift, accepted as decision #10) with Resume and Start new clickable, and returns under the toolbar when Find closes |
| M5 | 07-R1, 07-R3 | Click in a paragraph about one third down the document. Press Cmd+F and leave the input empty. Scroll to the end of the document with the mouse wheel without clicking the document. Press the personal Start Feedback keybinding. Then press Right Arrow once. Repeat with the Command Palette, and once more after typing a word that matches near the top and pressing Enter to go to it, then scrolling to the end | Feedback starts and the viewport stays at the end of the document; no jump. The active element is the editor. Right Arrow brings the view to the paragraph one third down (or the match), not to the title, so the caret was kept |
| M6 | 07-R2 | Add `[broken](does-not-exist.md)` to the document and save. Click the toolbar Audit button; the audit panel lists the issue. Press Tab until an issue row is focused. Run Start Feedback from the Command Palette | The audit panel closes and Feedback starts. After 1 s the active element is the editor. No scroll jump |
| M7 | 07-R2 | With a Feedback session active, press Cmd+F and keep focus in Find. Run Start Feedback from the Command Palette | Find closes and the session is unchanged. After 1 s the active element is the editor |
| M8 | 07-R4 | With a Feedback session active, scroll to the middle of the document with the mouse wheel. Click the toolbar **More feedback actions** button (ellipsis); the menu opens with **Reveal feedback file** focused. Run Start Feedback from the Command Palette. Then press Space once | The menu closes, the session is unchanged and the viewport does not move. After 1 s the active element is the More button (`[data-feedback-more]`), not `body`. Space opens the More menu again instead of scrolling the page |

---

## 6. Refactor notes

Observations only; nothing here was changed.

**`src/webview/features/feedbackReview.ts` (~6.0k lines).** `createFeedbackReviewController` (`:966` to end) is one closure holding about 150 helpers and shared mutable state.
- Draft surface gate and guidance: `createFeedbackDraftSurfaceGate` `:352`, `clearDraftSurfaceAttention` `:981`, `showSurfaceAttention` `:1296`, `isOpenModal` / `focusModalSurfaceBefore` `:4110-4150`.
- Entry and transitions: `renderDraftBanner` `:1499-1645`, `remember/restoreTransitionFocus` `:1482`, `start` `:4154`, `completeTransition` `:5468`.
- Block action rail and selection sampling: `:1646-2020`, `handleSelectionChange` `:3907`.
- Completion checkpoint: `:2156-2590`.
- Cards, markers and annotation layout: `renderCards` `:2736`, `calculateAnnotationLayout` `:3385`, `renderMarkers` `:3737` (`:2736-3870`).
- Session transfer and close/peer release sync: `:4263-4390`, `:5266-5500`.
- Host message dispatch: `handleHostMessage` `:5500-5900`.
- Candidates: `FeedbackEntryGuidance` (gate, modal detection, notices, transition focus) as a small module taking `editorDom`; `FeedbackCompletionCheckpoint`; `AnnotationRail` (cards, markers, layout). A State pattern for the session lifecycle (idle, starting, active, closing) would replace the scattered `startRequestId`, `pendingClose`, `pendingTransitionRecovery` checks; `feedbackLifecycleMachine.ts` already models this but is unwired.

**`src/webview/editor.ts` (~3.0k lines).**
- Webview bootstrap and sync globals: `:175-780`; `initializeEditor` `:783-1350`.
- Host message switch: `:1351-2190` (about 840 lines in one listener).
- Content apply: `updateEditorContent` `:2224`, `updateEditorContentFromHost` `:2309`.
- Feedback entry glue: `closeIncompatibleFeedbackSurfaces` `:2414`, `showFeedbackMoreMenu` `:2468-2555`, `feedback*Requested` listeners `:2558-2613`.
- Toolbar actions, settings, export, paste routing: `:2616-2895`.
- Candidates: move the Feedback entry glue and More menu to `features/feedbackToolbarActions.ts` (testable without importing all of `editor.ts`); split the message switch into a handler map (Command pattern) keyed by message type, with sync, image and Feedback handlers in their own modules.

**`src/editor/MarkdownEditorProvider.ts` (~11.5k lines).**
- Webview setup and message routing: `resolveCustomTextEditor` `:1020`, `handleWebviewMessage` `:1440-1950`.
- Feedback transport, peer locks, transfer and release: `:1950-3470`.
- Feedback snapshot, targets and validation: `:3473-4660`.
- Feedback webview messages and lifecycle: `revealFeedbackOwner` `:4685`, `handleFeedbackWebviewMessage` `:4745-5630`, start/resume/transition/restore `:5629-7505`.
- Export and audit: `:7506-7900`. Images: `:7902-9800`. Files, links, settings: `:9791-10400`.
- Document sync and save: `:10405-11230`. HTML: `:11235-11500`.
- Candidates match the overview: `FeedbackController` (everything from `:1950` to `:7505`, behind a Facade the provider calls), `DocumentSyncHost` (`:10405-11230`), `ImageHost` (`:7902-9800`). Peer locks and session transfer are each a small state machine and fit the State pattern.

**`src/webview/features/feedbackCaptureWorkflow.ts` (~1.1k lines).**
- Shared helpers and gate access: `:73-290`. Area capture: `startFeedbackAreaCapture` `:373-790` (one 420 line closure). Block capture: `prepareBlockCaptureRectangle` `:813`, `captureBlockRange` `:884`. Keyboard selector: `openKeyboardBlockSelector` `:994-1115`.
- Candidate: extract the area capture overlay (pointer handling, viewport observer, raster abort) into its own module driven by `feedbackCaptureMachine.ts`, which already holds the reducer.

**`src/webview/editor.css` (~6.0k lines).** Feedback rules span `:3488-5978` (about 2.5k lines). Candidate: split into `feedback.css` and component files (toolbar, overlays, images) bundled in order; the Find, TOC and banner stacking values (`z-index` 100, 190, 210, 1000, 1001) would be easier to audit as named custom properties in one place.

**`scripts/feedback-annotation-fixture/renderer.ts` (~1.5k lines).** Visual matrix `:1021-1178`, stress `:1179-1285`, real controller `:1296-1481`. Candidate: one file per scenario with a shared `fixtureShell` helper.
