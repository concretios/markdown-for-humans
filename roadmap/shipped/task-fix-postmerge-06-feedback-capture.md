# Task: Fix Feedback capture and selection findings from post-merge review

## 1. Task Metadata

- **Task name:** Fix Feedback capture and selection findings
- **Slug:** fix-postmerge-06-feedback-capture
- **Status:** shipped in 0.4.0
- **Created:** 2026-09-30
- **Last updated:** 2026-10-01
- **Shipped:** 2026-10-01 (0.4.0)
- **Base:** `origin/main` @ `1b8244b`
- **Overview:** `task-fix-postmerge-00-overview.md`

---

## 2. Context & Problem

Area capture and selection mapping have a stuck state, a blank-screenshot race, and unbounded DOM work that breaks the performance budgets on large documents.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Area capture recovers after a viewport change during rasterization
- Saved screenshots are never blank
- Capture block mapping and selection sampling stay under 50ms on a 10,000-line document
- `npm test` passes

**In scope:** C1 to C5
**Out of scope:** capture UX redesign

---

## 4. Findings

### C1. MED (#93): area capture stuck after a viewport change during rasterization. Logic confirmed; trigger plausible.

- **Where:** `src/webview/features/feedbackCaptureWorkflow.ts:585-590` with `src/webview/features/feedbackCaptureMachine.ts:321-322`
- **Defect:** `handleViewportMutation` always updates `viewport` and increments `viewportGeneration`. In `Rasterizing`, `updateViewport` is ignored (`wrong-phase`), so the machine stays at generation G while the workflow moves to G+1.
- **Scenario (raster fails):** window or panel resize during "Preparing capture...", then raster fails (Mermaid or resource timeout). Machine returns to `Armed` at G. Retry calls `complete()` (`:669-687`); `handleViewportMutation` returns early; `rasterStarted{G+1}` is ignored as `stale-viewport-generation`. Retry does nothing; every `pointerDown{G+1}` is ignored; overlay dead until Cancel or Escape.
- **Scenario (raster succeeds):** stale crop accepted; `blockRange` computed before the change (`src/webview/features/feedbackCapture.ts:644`).
- **Note:** comment at `feedbackCaptureWorkflow.ts:969-972` claims this path is guarded "the same way". It is not while rasterizing.
- **Fix direction:** have the machine accept generation updates during `Rasterizing` and invalidate the in-flight raster.
- **Test first:** viewport mutation during Rasterizing, then raster failure; Retry and new pointerDown work.

### C2. MED (#93): "Add feedback" can save a blank screenshot. Plausible.

- **Where:** `src/webview/features/feedbackCapture.ts:1387` calls `drawImage` (`:869`) on the `<img>` created at `:1077` without checking `complete`, `naturalWidth` or `decode()`.
- **Scenario:** Retake or replace paths prefill text, so Add is enabled immediately. Clicking before a large PNG (up to 12 MP) decodes draws nothing; the blank PNG passes the `data:image/png` check and is persisted.
- **Fix direction:** `await image.decode()` before flattening; keep Add disabled until decoded.
- **Test first:** submit before decode resolves waits and produces non-empty pixels.

### C3. LOW-MED (#93): unbounded DOM work when mapping a capture to blocks. Confirmed.

- **Where:** `src/webview/features/feedbackCapture.ts:447-457` (`rectangleHitsRenderedBlockContent`), with `:401-445`
- **Defect:** builds full arrays per candidate block (Range and `getClientRects` for every text node; `getComputedStyle` and `getBoundingClientRect` for every descendant) with no node cap and no early exit. `feedbackDomCapture` has a 4,096-node cap; this path does not.
- **Scenario:** a small crop over part of a table with thousands of rows walks the whole table synchronously; multi-second main-thread stall, not abortable.
- **Fix direction:** iterate lazily with early exit on first hit; add a node ceiling.
- **Test first:** crop over a 5,000-row table maps in under 50ms (or node visits bounded).

### C4. LOW (#93): text limits applied to ProseMirror positions, not characters. Confirmed.

- **Where:** `src/webview/features/feedbackSelectionMapping.ts:186-190`, `src/webview/features/feedbackRenderedRange.ts:488-494`
- **Defect:** `traversalEnd = min(node.content.size, max)` compared against a character limit; `content.size` counts structural tokens (cell with a paragraph has size L+2). `slice` can split a surrogate pair.
- **Scenario:** a 239 to 240 character table cell is marked truncated and cut to 227 chars plus "... [truncated]". An emoji at the cut becomes a lone surrogate, which the host encodes as U+FFFD. List-heavy blocks near 64 KiB are falsely truncated.
- **Fix direction:** measure text length, not positions; cut on code point boundaries.
- **Test first:** 240-char cell not truncated; emoji at the boundary survives intact.

### C5. LOW (#93): heavy work per selection change in review mode. Plausible.

- **Where:** `src/webview/features/feedbackRenderedRange.ts:581-618`, `hasOpaqueContent` at `:395-417`
- **Defect:** each sample runs `nativeRange.toString()`, `querySelectorAll('[contenteditable="false"]')` plus `intersectsNode` per block, `nodesBetween`, and a second `toString()`; caller also runs `nativeSelection.toString()`.
- **Mitigation already present:** writable review sessions only; coalesced to one run per animation frame.
- **Scenario:** drag-selecting across a large part of a 10,000-line doc repeats O(selected DOM) serialization every frame; likely exceeds the 16 to 50ms budgets.
- **Fix direction:** compute cheap bounds per frame; do full serialization only when selection settles (pointerup or short idle).
- **Test first:** performance fixture (`scripts/feedback-performance-fixture/`) with a large drag selection stays within budget.

---

## 5. Progress

All five findings reproduced at `origin/main` @ `6412d17`: every new test below failed before its fix and passes after it.

| ID | Test | Fix | Verified |
|---|---|---|---|
| C1 | `feedbackCaptureMachine.test.ts`: "invalidates an in-flight raster when a newer viewport arrives during rasterization", "keeps rasterizing for duplicate viewports and rejects stale or conflicting ones". `feedbackCaptureWorkflow.test.ts`: "recovers when the viewport changes while rasterizing and the stale raster then fails", "discards a raster that succeeds after the viewport changed mid-capture" | `feedbackCaptureMachine.ts` `updateViewport`; `feedbackCaptureWorkflow.ts` `startFeedbackAreaCapture` (`restoreArmedSurface`, per-attempt annotation restore), comment in `captureBlockRange` | done |
| C2 | `feedbackCapture.test.ts` "base image decode before flattening": "keeps Add disabled until the screenshot decodes, then enables it", "waits for decode before drawing the base image when submitted early", "never saves a screenshot whose base image fails to decode" | `feedbackCapture.ts` `createFeedbackAnnotationModal` (`decodeAnnotationImage`, `imageReady`) | done |
| C3 | `feedbackCapture.test.ts` "rendered-content hit test inside one large block": "maps a small crop over a 5,000-row table with bounded DOM work" (25,004 DOM reads before, at most 16 after), "caps the walk when the cropped content is deep inside a 5,000-item list" (10,002 before, at most 4,112 after), "still excludes blank space beside short content in a large list" | `feedbackCapture.ts` `rectangleHitsRenderedBlockContent` and `findIntersectingTopLevelBlocks` | done |
| C4 | `feedbackSelectionMapping.test.ts` "selected-cell Focus measured in characters": "keeps a 240-character cell intact", "keeps a cell of 240 astral characters intact", "cuts an oversized cell on a code point boundary". `feedbackRenderedRange.test.ts`: "measures whole-block Focus in characters, not ProseMirror positions", "cuts truncated whole-block Focus on a code point boundary" | `feedbackRenderedRange.ts` (`codePointLength`, `codePointPrefix`, `boundedNodeText`, Focus bounding); `feedbackSelectionMapping.ts` (`boundedSemanticText`, `textWithTruncationSentinel`, `selectedCellFocus`) | done |
| C5 | `feedbackReview.test.ts`: "defers selection serialization during a pointer drag until the selection settles" (150 serializations over 30 drag frames before, 0 after; one bounded sample on release) | `feedbackReview.ts` `handleSelectionChange` | done |

Gates: `npm test` 166 suites, 3,125 passed (27 skipped, 120 todo); `npm run lint` clean; `npx tsc --noEmit` clean; `npm run test:integration` 6 passing (one earlier run had a single SVG Feedback start failure that did not reproduce on two reruns). `npm run test:feedback-capture` not run: it only exercises the `feedbackDomCapture` rasterizer, which this task does not change.

### Decisions

- **C1:** the machine now accepts a newer viewport generation in `Rasterizing`, returns to `Armed` with no selection and `viewport-changed`, and emits `abortPhase` for the in-flight capture. Duplicate, stale and conflicting generations keep their existing dispositions. The workflow re-arms the overlay synchronously instead of waiting for the aborted raster to settle, so a slow abort cannot keep `busy` set. Annotation restoration in `complete()`'s `finally` now runs only for the attempt that is still active, because a newer attempt may own the shared restore slot.
- **C2:** `HTMLImageElement.decode()` gates both the Add button and `submit()`. Engines without `decode` (jsdom) resolve at once. A decode failure keeps Add disabled and asks the user to retake; that prompt stays through later edits of the feedback text.
- **C3:** one document-order walk over text and elements with first-hit exit replaces the two eager arrays. A 4,096-node budget, matching the staging cap, is shared across all candidate blocks in one mapping. When it runs out, a block whose own box intersects the crop counts as hit (fail open). The alternative, failing closed, could drop visibly captured content and reject the crop. Tradeoff: a crop over only blank space in a huge block, or in any candidate checked after the budget ran out, now maps to that block.
- **C4:** limits are measured in code points, matching the host (`Array.from(text).length` in `feedbackEvidenceV2.ts` and `feedbackReportV2.ts`). `boundedNodeText` reads a node whole with `textBetween` when `content.size` is within the limit, then cuts it to the limit: a block leaf such as a horizontal rule yields two characters for one position, so that text can reach twice the limit (cut added in review fix round 3). A larger node gets one `nodesBetween` walk that applies textBetween's separators, counts code points as it appends, and stops entering nodes at the first character past the limit (revised in the review fix round; the first version re-read from position 0 with a doubling window). The aggregate 64 Ki Focus limits also count code points now. The host Focus limit is 1,000,000 UTF-16 units, so the longer UTF-16 strings this allows stay valid.
- **C5:** while `blockPointerSelecting` is set (a pointer pressed in the editor), selection samples do no serialization. The pointerup, pointercancel, contextmenu, window-blur and visibilitychange handlers schedule one full sample once the selection settles; contextmenu and visibilitychange cover a native menu or hidden page that swallows the release. Keyboard selection keeps sampling at most once per frame (see open question).
- **Docs:** `vibe-coding-rules/performance.md` records the hit-test budget and drag-deferred sampling.

### Open questions

- Holding Shift+Arrow over a very large selection still serializes once per frame on autorepeat. A short idle debounce for keyboard selection would close this, but it changes when the selection button appears and needs a UX decision.
- Wall-clock latency on the reference machine was not measured. The tests gate deterministic work counts only, per `vibe-coding-rules/testing.md`.
- `buildFeedbackTableCellEvidence` (v2 cell evidence) still uses a fixed 512-position window. GFM cells hold one paragraph, so it is correct in practice, but it could use `boundedNodeText` for exactness.

### Review fix round

Source: `findings-06.json` (8 findings, each checked by two skeptics). Each fix test failed on the pre-fix code for the stated reason. Each mutation check reverted the production change in the editor (no stash, checkout or reset), confirmed the test fails, then restored it.

| ID | Outcome | Test | Mutation check |
|---|---|---|---|
| 06-F1 | fixed: `imageDecodeFailed` keeps the decode message and `aria-invalid` through feedback edits | `feedbackCapture.test.ts` "keeps the decode failure message after the feedback is edited" (validation read `''` before) | decode branch in `updateSubmissionState` disabled: fails |
| 06-F2 | fixed: `boundedNodeText` reads a node whole with `textBetween` when `content.size <= limit`, otherwise one `nodesBetween` walk counting code points and stopping at the first character past the limit | `feedbackRenderedRange.test.ts` "reads a structure-heavy block once and stops at the character limit" (1,403 list items entered before, 501 after); "matches textBetween block and leaf separators at every limit" (equivalence guard) | doubling restored: 1,403 > 501, fails; early exit removed: 2,000, fails |
| 06-F3 | decision for user; no behavior change. The `findIntersectingTopLevelBlocks` JSDoc and the C3 tradeoff now state that every candidate checked after the budget runs out fails open | pinned by the 06-F6 test (`[0, 1]` for a blank-margin crop over two lists) | n/a |
| 06-F4 | fixed: document `contextmenu` and `visibilitychange` clear `blockPointerSelecting` and schedule one sample (pointercancel and blur already did) | `feedbackReview.test.ts` "resumes selection sampling when a context menu opens / the page is hidden without a pointerup" | both listeners removed: both cases fail |
| 06-F5 | fixed (pre-existing): the viewport-changed branch hides Retry and moves focus to the overlay if Retry had it | `feedbackCaptureWorkflow.test.ts` "hides Retry when the viewport changes after a rasterization failure" | hide removed: fails; focus move removed: fails |
| 06-F6 | fixed (test only) | `feedbackCapture.test.ts` "shares one node budget across every candidate block in a mapping" | budget reset per block: 8,196 DOM reads > 4,112, fails |
| 06-F7 | fixed (test only): exact one read per cell restored, now counted on `nodesBetween` | `feedbackSelectionMapping.test.ts` "bounds aggregate Focus for 256 oversized cells before traversing complete cell content" | oversized odd cells dropped: 128 cells read 0 times, only this test fails |
| 06-F8 | fixed (pre-existing): cell and whole-block previews use `boundedNodeText`; `truncateText` counts and cuts code points | `feedbackTargetPresentation.test.ts` "keeps a 119/120-character cell preview intact", "cuts an oversized cell preview on a code point boundary", "does not mark a list preview limited when its text fits" | UTF-16 slice restored: emoji test fails; position-bounded cell read: 4 fail; position-bounded whole-block read: list test fails |

- **Updated tests:** "bounds whole-block Focus before traversing a block larger than one MiB" and "bounds an oversized cell preview before traversing its complete content" now assert the `nodesBetween` walk and keep the `textBetween` position bound.
- **06-F2 timing probe** (jest, loaded machine, outputs identical): 10,000 x 10 empty-cell table, doubling 77 ms vs single pass 25 ms; 10,000 x 5 cells of "ab", 61 ms vs 16 ms.
- **06-F3 options:** keep fail open for every later candidate (current; total work stays at 4,096 nodes), or give each candidate a small exact-check floor (for example 64 nodes) after the shared budget runs out, so short blocks are still tested exactly, at up to 64 extra node reads per visible candidate. Decided: keep fail open (decision #9, see "Decisions applied").
- **Docs:** `vibe-coding-rules/performance.md` lists the context menu and visibility change as sample triggers.
- **Gates:** `npm test` 183 suites, 3,413 passed (27 skipped, 120 todo); `npm run lint` clean; `npx tsc --noEmit` clean; `npm run test:integration` 7 passing.

### Review fix round 3

#### Iteration 1

Source: `claims-06.json` (5 claims upheld by skeptics). Same method as above: each fix test failed on the pre-fix code for the stated reason; vacuous-test claims got a test that passes now and fails under the claim's mutant. Every mutant was applied and reverted from a private backup.

| ID | Outcome | Test | Mutation check |
|---|---|---|---|
| 06-R1, 06-R2 | fixed (new defect from 06-F2): the `boundedNodeText` fast path cuts the `textBetween` output with `codePointPrefix` and sets `truncated` when it cuts, so selected-cell Focus gets its sentinel again | `feedbackRenderedRange.test.ts` "never exceeds the limit for a block whose rules yield more characters than positions" (10 rules: limit 10 returned 19 characters, `truncated:false`); `feedbackSelectionMapping.test.ts` "bounds a cell of horizontal rules to the cell limit" (399 newlines, no sentinel) | uncut fast path restored: both fail; cut kept but flag forced false: both fail |
| 06-R3 | fixed (test only) | `feedbackTargetPresentation.test.ts` "marks a whole-block preview limited when its text is cut" (4,001-character paragraph) | `false && bounded.truncated` in `wholeBlockTextPreview`: fails |
| 06-R4 | fixed (test only) | `feedbackTargetPresentation.test.ts` "keeps a 120-character cell preview with an astral character intact" (121 UTF-16 units) | UTF-16 count in `truncateText`: fails |
| 06-R5 | fixed (test only): the existing add/remove symmetry test now covers `contextmenu` and `visibilitychange` | `feedbackReviewLifecycle.realEditor.test.ts` "binds review listeners once across start and activation, then removes the same callbacks" | `contextmenu` removal dropped: fails; `visibilitychange` removal dropped: fails |

- **Not covered:** the window `blur` removal is still unasserted. That gap predates this task and is outside these claims.
- **Gates:** `npm test -- --maxWorkers=4` 183 suites, 3,417 passed (27 skipped, 120 todo); `npm run lint` clean; `npx tsc --noEmit` clean; `npm run test:integration` 7 passing.

### Decisions applied

The user approved every recommendation. Each mutant was applied from a private backup, run, and reverted; no production code changed in this step.

| Item | Outcome | Test | Mutation check |
|---|---|---|---|
| Decision #9 (06-F3): keep fail-open hit testing after the shared 4,096-node budget | confirmed; no behavior change. The C3 tradeoff, the `findIntersectingTopLevelBlocks` JSDoc and `vibe-coding-rules/performance.md` already describe it | `feedbackCapture.test.ts` "shares one node budget across every candidate block in a mapping" (`[0, 1]` for a blank-margin crop over two lists), "caps the walk when the cropped content is deep inside a 5,000-item list" | budget exhaustion returns `false` (fail closed): both fail |
| Leftover low claim (round 3): no test pinned the code point count in the `boundedNodeText` fast-path cut | fixed (test only); production code was already correct | `feedbackRenderedRange.test.ts` "counts code points, not UTF-16 units, when it cuts a block read whole" (a 7-position block of one emoji and three rules is kept whole; an 11-position block of five rules and two emoji is cut at 11 code points, keeping the first emoji whole) | `whole.slice(0, maximumCharacters)` for the cut: fails (6 code points kept, `truncated:true`); `whole.length > maximumCharacters` for the flag: fails (`truncated:true` for text that fits). It is the only failure in the three `boundedNodeText` suites (rendered range, selection mapping, target presentation); round 3 found both mutants survive the rest of the suite |

- **Gates:** `npm test -- --maxWorkers=3` 183 suites, 3,418 passed (27 skipped, 120 todo); `npm run lint` clean; `npx tsc --noEmit` clean; `npm run test:integration` 7 passing.

---

## 6. Refactor notes

Observations from working in the four large Feedback files. None of this was done here.

### `feedbackCapture.ts` (~1.5k lines)

- **Clusters:** pure geometry (normalize, clamp, intersect, `clientPointToBitmap`); crop-to-block mapping (binary search plus the C3 hit test); `captureVisibleArea` orchestration; annotation model (`AnnotationHistory`, shape commands); canvas flattening; SVG rendering; the ~550-line `createFeedbackAnnotationModal`.
- **Candidate extractions:** `feedbackCaptureGeometry.ts` and `feedbackCaptureHitTest.ts` (pure, already well tested); `feedbackAnnotationModal.ts` for the dialog.
- **Patterns:** `AnnotationHistory` is already Command plus undo stack; keep it. The modal's `busy`, `destroyed`, `imageReady` and `stickySubmissionError` flags form an implicit state machine (decoding, ready, submitting, closed). A small reducer like `feedbackCaptureMachine` would make transitions such as C2 explicit and testable without DOM.

### `feedbackCaptureWorkflow.ts` (~1.2k lines)

- **Clusters:** shared helpers (draft surface gate, chrome suspension, annotation suspension); area capture (the ~420-line `startFeedbackAreaCapture` closure mixing overlay DOM, machine effect interpretation, viewport tracking and raster orchestration); block-range capture (`prepareBlockCaptureRectangle`, `captureBlockRange` with its own ad hoc viewport guard); keyboard block selector UI; `openAnnotation`.
- **Candidate extractions:** a capture overlay view (Passive View: render-only functions driven by machine state), and an effect interpreter that maps `FeedbackCaptureEffect`s to DOM and AbortController calls.
- **Patterns:** make each raster attempt an object that owns its `AbortController` and annotation-restore function (Unit of Work). C1 needed a guard because the restore slot is shared mutable state. Route block-range capture through the same capture machine instead of its parallel `handleViewportShift` guard, so the two paths cannot drift again (C1's misleading comment came from that duplication).

### `feedbackDomCapture.ts` (~1.3k lines)

- **Clusters:** resource validation and async waits (`withAbortSignal`, `withTimeout`, two-frame and resource waits); intersection search (vertical and horizontal binary searches); pruned cloning of tables, rows and lists; Mermaid readiness; staging and the `modern-screenshot` adapter.
- **Candidate extractions:** one sorted-geometry search helper shared with `feedbackCapture.ts`, where `firstPotentialBlockIndex` and `firstBlockAfterCropIndex` repeat the same binary search (Strategy for the axis); an async-wait utility module.
- **Patterns:** the per-tag cloners (`cloneCaptureTable`, `cloneCaptureList`, `cloneCaptureTableRow`) fit a tag-keyed registry (Strategy or Visitor), so a new pruned block type is one entry rather than a new branch in `cloneCaptureNode`. The rasterizer is already an Adapter; keep that boundary.

### `feedbackReview.ts` (~6k lines)

- **Shape:** `createFeedbackReviewController` is a ~5,000-line closure with ~100 inner functions and ~110 mutable `let` bindings shared across concerns.
- **Clusters:** selection sampling and the pending selection button; block hover action; annotation rail (measurement, `calculateAnnotationLayout`, markers, cards, alerts); composer and edit drafts; completion checkpoint dialog; draft banner and session transfer; host message handling; read-only plugin wiring.
- **Candidate extractions:** `SelectionActionController`, `BlockActionController`, `AnnotationRailView`, `CompletionDialog`, each taking a narrow context interface (session view, editor, post, announce) instead of the whole closure.
- **Patterns:** keep the controller as a Mediator that owns session state and wires collaborators. Replace cross-cluster flags with explicit signals: C5 had to read `blockPointerSelecting`, owned by the block-action cluster, from selection sampling; a small pointer-gesture Observer would make that dependency visible. The host message `switch` fits a command map keyed by message type.
