# Task: Feedback/LLM Review – Code-Review Bug Fixes

## 1. Task Metadata

- **Task name:** Feedback/LLM review code-review bug fixes
- **Slug:** feedback-review-bugfixes
- **Status:** planned
- **Created:** 2026-09-18
- **Last updated:** 2026-09-18
- **Shipped:** _(pending)_
- **Branch under review:** `feature/llm-feedback` (53 commits, ~115k insertions)

---

## 2. Context & Problem

The `feature/llm-feedback` branch adds a large AI/LLM feedback-review subsystem
(capture, snapshots, lifecycle state machines, evidence-v2, session store,
peer-locking, serialization, provider integration). A deep code review was
performed against the branch.

**Review baseline (all green, no action needed):**
- `npm run build:debug` ✅, `npm run lint` ✅ (0 warnings)
- Full Jest suite ✅ — 145 suites / 2,739 tests pass (27 skipped, 120 todo)
- The subsystem is unusually well-hardened (SHA-256 boundary binding, atomic
  writes with rollback, fail-closed validation, bounded retries).

**Bugs found (this task fixes them). Two P1s are runtime-confirmed:**
- **P1-A (confirmed):** prose `<`/`>` are HTML-entity-corrupted to `&lt;`/`&gt;`
  on every save/snapshot.
- **P1-B (confirmed):** screenshot capture mis-maps block ordinals when a
  ProseMirror gap-cursor/widget is a direct child of the editor root.

**Why it matters:**
- P1-A silently rewrites the user's `.md` on disk (comparisons `a < b`,
  generics `List<String>`, arrows `->`), producing noisy git diffs and poisoning
  feedback source-evidence slices + block SHA-256 hashes. It directly violates
  the product's "write markdown naturally / clean Git integration" core value.
- P1-B produces wrong screenshot crops and wrong source-line anchoring for
  feedback items — the feedback is attributed to the wrong lines.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Prose `<`, `>`, `&` round-trip unchanged through save/snapshot (outside code),
  verified by a real-editor round-trip test.
- Screenshot capture ordinal→element mapping is correct even when a
  gap-cursor/widget is a direct child of the ProseMirror root.
- All new behavior covered by failing-first tests (TDD), and the full existing
  suite still passes (`npm test`), lint clean, `build:release` succeeds.
- No regression to the well-hardened paths already verified in review.

**In scope:** all bugs listed in §5 (P1, P2, P3, and the latent lifecycle-reducer
issues — the user requested "everything").

**Out of scope:**
- New feature work; refactors beyond what a fix requires.
- Broad dependency upgrades (the tiptap pin stays at `3.30.5`; we patch around it).
- Running the Electron/VS Code integration + performance-fixture gates is a
  pre-merge verification step, not a code change here.

---

## 4. UX & Behavior

- Saving a document containing `<`, `>`, `&` in prose leaves those characters
  intact on disk; inside inline code / code blocks the existing behavior is
  preserved (untouched).
- Capturing an area or selected blocks for feedback anchors the screenshot and
  the `@file#lines` reference to the correct source lines regardless of whether a
  gap cursor is currently rendered.
- Error/robustness behaviors (memory caps, capture-abort on scroll, stuck
  "Saving…", stuck image placeholder) fail safe and surface a user-visible state
  instead of hanging or leaking.

---

## 5. Technical Plan (bug-by-bug, tests-first)

Legend — Severity: P1 (data loss/corruption/core-feature broken), P2
(robustness/edge/security), P3 (fidelity/polish). Confidence noted where < high.

### P1-A — `<`/`>` entity corruption on save/snapshot  ✅ runtime-confirmed
- **Files:** `src/webview/utils/markdownSerialization.ts` (`patchAmpersandOverEncoding`, ~lines 62–82; applied at ~line 325).
- **Root cause:** tiptap 3.30.5 `encodeHtmlEntities` encodes `&`,`<`,`>`
  (`node_modules/@tiptap/core/dist/index.js:3926`). The branch's patch reverts
  only `&amp;`, leaving `&lt;`/`&gt;` in prose text nodes.
- **Confirmed evidence (real-editor `getEditorMarkdownForSync` round-trip):**
  `"if x < 5 and y > 3"` → `"if x &lt; 5 and y &gt; 3"`;
  `"List<String>"` → `"List&lt;String&gt;"`; `&` preserved; inline code untouched.
- **Test first:** add a real-editor round-trip test (jsdom, mirroring
  `aiContextReference.realEditor.test.ts` wiring) asserting `<`,`>`,`&` survive
  outside code and remain encoded/handled correctly inside code. Also assert the
  block SHA-256 / source-evidence slice for a `<`-containing block matches the
  on-disk bytes.
- **Fix approach:** extend the non-code un-encode to also revert `&lt;`→`<` and
  `&gt;`→`>` (keep the `isEncodedInsideCode` guard). Consider ordering so a
  literal typed `&amp;`/`&lt;` isn't double-decoded (see P3-C).

### P1-B — Capture ordinal mapping ignores gap-cursor/widget direct children  ✅ runtime-confirmed
- **Files:** `src/webview/features/feedbackCaptureWorkflow.ts` — `mappedBlocks` (~line 90) and `prepareBlockCaptureRectangle` (~line 839), both using raw `root.children.item(ordinal)`.
- **Root cause:** feedback mode keeps the surface `contenteditable`
  (`feedbackReview.ts` `setReadOnly`), so ProseMirror can insert a
  `.ProseMirror-gapcursor`/`.ProseMirror-widget` as a direct child of the root.
  Raw child-index then diverges from document ordinal. The correct pattern
  already exists elsewhere: `createTopLevelDomIndex`
  (`feedbackRenderedRange.ts` ~line 296) and `feedbackBlockAction.ts` filter
  widgets and fall back to `editor.view.nodeDOM(offset)`.
- **Confirmed evidence:** with a real `GapCursor` selection rendering the widget
  as the first root child, `root.children.item(0)` returns the gap-cursor `<div>`
  and every subsequent ordinal is off by one (last block dropped).
- **Test first:** add a real-editor test that places a genuine `GapCursor`
  selection (doc starting with an `hr`, `trailingNode:false`) and asserts the
  capture ordinal→element resolution returns the correct block for each ordinal
  and never returns a widget element.
- **Fix approach:** route both call sites through the shared filtered index
  (reuse/extract `createTopLevelDomIndex` or the `feedbackBlockAction`
  `blockElementIndex` helper) instead of raw `root.children.item`.

### P2-C — V1 `deleteFeedback` never enforces the tombstone screenshot budget
- **Files:** `src/editor/feedbackSessionStore.ts` `deleteFeedback` (~lines 1996–2056; tombstone set ~2042). Compare working `deleteFeedbackV2` (~2091–2106).
- **Impact:** v1 sessions retaining large decoded PNG buffers unbounded on
  delete-only sequences (cap `MAX_TOMBSTONE_SCREENSHOT_BYTES_PER_BUNDLE = 16 MiB`
  never runs on the v1 delete path). Confidence: high.
- **Test first:** v1 session, delete several large screenshots without a
  subsequent add/restore, assert retained tombstone bytes ≤ 16 MiB.
- **Fix approach:** mirror v2 — run the eviction computation
  (`validateScreenshotAssetsForItems(..., true)` +
  `applyScreenshotAssetQuotaEviction(...)`) on the v1 delete path.

### P2-D — Keyboard block-capture has no scroll/resize abort during rasterization
- **Files:** `src/webview/features/feedbackCaptureWorkflow.ts` `captureBlockRange` (~873–953) → `captureRectangle` (~341–364).
- **Impact:** client-rect captured pre-await is reused after async raster
  (fonts/images/rAF/mermaid); scrolling mid-capture yields a stale crop. Area
  capture is guarded via `handleViewportMutation` + viewport generation; the
  keyboard path is not. Confidence: medium.
- **Test first:** simulate a scroll/viewport mutation between rectangle
  preparation and raster resolution; assert the capture aborts (or re-measures)
  rather than producing a stale crop.
- **Fix approach:** bind the keyboard path to the same viewport-generation guard
  / scroll+resize abort used by area capture.

### P2-E — Screenshot submission can hang "Saving…" forever (no timeout)
- **Files:** `src/webview/features/feedbackCapture.ts` `submit` (~1365–1388); `feedbackReview.ts addScreenshotFeedback` (~5117–5148); `feedbackCaptureMachine.ts` header notes `Submitting` state specified but not wired.
- **Impact:** a lost host ack leaves the annotation modal disabled with no
  escape until session teardown. Confidence: medium (documented deferred).
- **Test first:** simulate a host that never replies; assert the modal surfaces a
  timeout/cancel path (or the `Submitting` state resolves) rather than hanging.
- **Fix approach:** add a bounded timeout + user-visible retry/cancel; optionally
  wire the `Submitting` capture-machine state as designed.

### P2-F — Image-save completion "give up" leaves a stuck live placeholder
- **Files:** `src/editor/imageSaveCompletionDelivery.ts` (~166–171).
- **Impact:** after max attempts to a still-alive renderer, no
  `imageSaved`/`imageError` is delivered; the placeholder only reconciles on the
  next sync, with no user-visible error. Confidence: low–medium.
- **Test first:** simulate exhausted attempts with a live renderer; assert a
  terminal `imageError` (or equivalent) is delivered so the UI can surface it.
- **Fix approach:** on give-up for a live renderer, emit a terminal error signal.

### P2-G — Image reveal/metadata handlers lack path-containment guard (traversal)
- **Files:** `src/editor/MarkdownEditorProvider.ts` — `handleRevealImageInOS` (~9486), `handleRevealImageInExplorer` (~9534), `handleCheckImageInWorkspace` (~9335), `handleGetImageMetadata` (~9410). `normalizeImagePath` preserves `..` (~11186); guard `isPathContainedWithin` (~11214) is used by every file-mutating handler but not these.
- **Impact:** a document/webview-supplied `imagePath` like `../../../etc/passwd`
  can reveal/stat arbitrary files. Pre-existing (not introduced by this branch),
  mitigated by the extension's no-untrusted-workspaces stance. Confidence: high
  on the gap, medium on exploitability.
- **Test first:** unit test each handler rejects a non-contained path (reuse the
  existing `pathContainment.test.ts` patterns).
- **Fix approach:** apply `isPathContainedWithin` in these read handlers,
  consistent with the write handlers.

### P2-H — `deactivate()` doesn't reset `unresolvedCellTargetIds`
- **Files:** `src/webview/features/feedbackReview.ts` (~4370–4373; field declared ~1070, read ~1246/1936/2362/2783).
- **Impact:** asymmetric teardown vs sibling sets; latent today (overwritten
  before next read) but a footgun. Confidence: high on omission, low on impact.
- **Test first:** assert `deactivate()` clears `unresolvedCellTargetIds`.
- **Fix approach:** reset it alongside the other unresolved sets on teardown.

### P3-I — Reference-style links flattened to inline; definitions dropped
- **Files:** `src/webview/extensions/markdownCompatibilityMarks.ts` (~30–39).
- **Impact:** `[foo]` + `[foo]: url` → `[foo](url)` and the definition line is
  deleted (source fidelity/diff noise; rendering equivalent). Likely partly
  pre-existing extension-link behavior. Confidence: medium.
- **Test first:** round-trip test asserting reference form (or at least the
  definition) is preserved.
- **Fix approach:** preserve reference syntax/definitions during
  parse/serialize (scope carefully to avoid regressions).

### P3-J — Angle-bracket autolinks `<https://…>` lose their `<>`
- **Files:** `src/webview/extensions/markdownCompatibilityMarks.ts` (~30–34).
- **Impact:** `See <https://x>` → `See https://x` (GFM re-autolinks, so render
  survives; source rewritten). Confidence: medium.
- **Test first:** round-trip test asserting `<...>` autolink delimiters survive.
- **Fix approach:** retain the autolink mark/delimiters for explicit `<...>`.

### P3-K — Literal `&amp;`/`&lt;` typed as prose collapses to `&`/`<`
- **Files:** `src/webview/utils/markdownSerialization.ts` (~76–80; interacts with the P1-A fix).
- **Impact:** rare lossy case where a user types the literal characters `&amp;`.
  Confidence: low–medium.
- **Test first:** round-trip test for literal entity text.
- **Fix approach:** decide/encode ordering so P1-A's decode doesn't eat
  intentionally-literal entities (e.g. only decode entities the encoder itself
  produced).

### Latent-L — Lifecycle reducers (documented as not yet wired to production)
- **Files:** `src/editor/feedbackLifecycleMachine.ts` — `operationFailed`
  accepted from `Active` (branch evaluated before the state `switch`, ~294–305 vs
  ~336–337); `HostRecoveryTarget` (`'Idle' | 'DraftAvailable'`) vs renderer
  target (`'Editing' | 'DraftAvailable'`) divergence (header ~11–18).
- **Impact:** inert today; must be reconciled before wiring or host/webview will
  disagree on post-recovery resting state, and a stray failure can push `Active`
  → `Recovering`. Confidence: medium (self-flagged).
- **Test first:** reducer tests rejecting `operationFailed` from `Active`, and a
  test pinning the reconciled host/renderer recovery targets.
- **Fix approach:** guard `operationFailed` by state; reconcile the two recovery
  targets to a single agreed value.

### Test/CI stability note (not a product bug)
- `src/__tests__/webview/feedbackAnnotationLayout.test.ts` has a ~100ms perf
  assertion that tripped once at 100.55ms under concurrent load (passed 3/3 in
  isolation). Consider widening the budget or making it timing-robust to avoid CI
  flakes. Also run the un-exercised gates before merge: `test:integration`,
  `test:feedback-capture`, `test:feedback-annotations`,
  `scripts/feedback-performance-fixture/*`.

---

## 6. Work Breakdown

- [ ] **Phase 1 — P1 data integrity (highest value)**
  - [ ] P1-A failing round-trip test → fix `<`/`>` un-encode → green
  - [ ] P1-B failing gap-cursor ordinal test → route capture through filtered index → green
- [ ] **Phase 2 — P2 robustness/security**
  - [ ] P2-C v1 tombstone budget; P2-D scroll-abort; P2-E submit timeout;
        P2-F image give-up error; P2-G path containment; P2-H deactivate reset
- [ ] **Phase 3 — P3 serialization fidelity**
  - [ ] P3-I reference links; P3-J autolinks; P3-K literal entities
- [ ] **Phase 4 — Latent lifecycle reducers**
  - [ ] Latent-L guards + recovery-target reconciliation (+ tests)
- [ ] **Verification**
  - [ ] `npm test` (all green), `npm run lint`, `npm run build:release`
  - [ ] Run integration/perf/extension-host gates
  - [ ] Manual: read a 3000+ word doc containing `<`, `>`, `&`, tables, code; save; confirm clean git diff (light + dark)

---

## 7. Implementation Log

_(to be filled during implementation)_

### 2026-09-18 – Review & plan
- **What:** Deep review of `feature/llm-feedback`; ran full suite (2,739 pass),
  lint, build. Runtime-confirmed P1-A (entity corruption) and P1-B (gap-cursor
  ordinal mismatch) via throwaway real-editor probes (since deleted). Compiled
  the bug list above.
- **Notes:** No fixes applied yet — this is the plan only, pending TDD execution.

---

## 8. Decisions & Tradeoffs

- **Patch around tiptap, don't upgrade:** keep the `3.30.5` pin and extend the
  existing entity patch rather than chasing an upstream fix.
- **Reuse existing filtered-index helper for capture:** prefer the proven
  `createTopLevelDomIndex`/`blockElementIndex` pattern over a new mapping.

---

## 9. Follow-up & Future Work

- Wire the `Submitting` capture-machine state and the lifecycle reducers into
  production once reconciled (Latent-L).
- Consider a serialization golden-corpus test guarding all entity/link/autolink
  round-trips to prevent regressions from future tiptap bumps.

---

## Quick Reference

- **RED → GREEN → REFACTOR → VERIFY** per bug (write the failing test first).
- A bug is "done" only when its new test passes AND the full suite stays green.
- Do not commit/push — user reviews first (per AGENTS.md).
