# Task: Rich-View Feedback Sessions

## 1. Task Metadata

- **Task name:** Rich-view feedback sessions
- **Slug:** rich-view-feedback
- **Status:** in-progress
- **Created:** 2026-08-21
- **Last updated:** 2026-08-23
- **Shipped:** _(pending)_

---

## 2. Context & Problem

**Current state:**

- Rich Markdown can be edited and copied as AI context, but review notes live outside the document.
- Rendered selections do not have a durable, exact mapping to saved source lines.

**Pain points:**

- Visual feedback loses its relationship to the rendered content.
- Agents receive prose descriptions without stable source hashes, exact lines, or screenshot evidence.
- Existing collaboration tools are heavier than a disposable implementation handoff.
- The current fixed marker rail and independently scrolling drawer drift away from long documents, so users cannot reliably see which content already has feedback or which card belongs to which target.

**Why it matters:**

- Review should preserve the editor's reading quality while producing precise, Git-friendly agent input.
- A frozen snapshot prevents comments from silently drifting as Markdown changes.

---

## 3. Desired Outcome & Scope

**Success criteria:**

- A user can start a frozen Feedback session, add exact text and annotated screenshot feedback, and finish by copying an agent prompt.
- The trackable `.md4h/feedback/` bundle contains an exact source hash, line ranges, focus text, PNG evidence, and stable feedback IDs.
- Saved feedback remains visibly connected to its rendered target while the document scrolls, with exact inline highlighting where a versioned rendered range is available and an honest block bracket everywhere else.
- Feedback adds no measurable typing overhead outside its active mode and remains usable on 10,000-line documents.
- New and existing tests, lint, and builds pass.

**In scope:**

- Feedback-only toolbar state, framed read-only canvas, document-synchronous annotation layer, exact text highlights, anchored compact cards, text composer, area capture, screenshot markup, draft recovery, sealing, diagnostics, accessibility.
- Strict block-parity anchoring and host-validated bundle persistence.

**Out of scope:**

- Replies, authors, priorities, live collaboration, fuzzy re-anchoring, arrows, labels, redaction, editable vector layers, automatic bundle cleanup.

---

## 4. UX & Behavior

**Entry points:**

- A round AI-comment toolbar action labelled `Start feedback` for assistive technology and tooltips, plus unbound Command Palette commands.

**Primary flow:**

1. Save and fingerprint the active Markdown source.
2. Replace formatting controls with `Finish & copy`, `Capture area`, `Comments`, and overflow.
3. Add text feedback from the floating comment action beside a valid selection, or capture and annotate one visible rectangle. Saved highlights, pins, and cards share the document's scroll coordinates.
4. Persist every submitted item to a draft bundle.
5. Validate, seal, copy the provider-neutral prompt, and restore editing.

**Behavior rules:**

- Never guess source locations or re-anchor stale feedback.
- Preserve incomplete input after recoverable failures.
- No default keyboard shortcuts; all controls remain keyboard and screen-reader accessible.
- External source changes invalidate finishing but never discard the draft.

---

## 5. Technical Plan

**Surfaces:**

- Extension host: snapshot mapping, file/hash validation, bundle lifecycle, command routing.
- Webview: Feedback state machine, feedback-only ProseMirror decorations, document-synchronous annotation layer/composer, rectangle selection, DOM rasterization, SVG annotation preview.

**Architecture notes:**

- `TextDocument` remains canonical; Feedback mode blocks mutations rather than creating a second document model.
- Raw and canonical Markdown top-level token maps must have structural parity before line anchors are accepted.
- Screenshot markup is flattened to a portable PNG only on submission.

**Performance:**

- No document traversal on typing; build the block map once at session start.
- No annotation work on scroll. Pins, connectors, and cards move natively because they live in the same document coordinate space as the rich view.
- Capture only intersecting visible blocks and cap output at 12 MP / 10 MiB.

---

## 6. Work Breakdown

- [x] **Phase 1: Contracts and RED tests**
  - [x] Anchor-map tests
  - [x] Bundle/storage tests
  - [x] Feedback UI and annotation tests
- [x] **Phase 2: Host foundations**
  - [x] Snapshot mapping and validation
  - [x] Draft/sealed bundle lifecycle
- [x] **Phase 3: Feedback UI**
  - [x] Toolbar mode, framed snapshot, marker rail, text composer
  - [x] Read-only transaction and input guards
- [x] **Phase 4: Screenshot feedback**
  - [x] Visible area mapping and DOM capture
  - [x] Annotation modal and PNG flattening
- [x] **Phase 5: Integration and recovery**
  - [x] Commands/messages, invalidation, resume, diagnostics
- [x] **Phase 6: Document-synchronous annotations and exact review highlights**
  - [x] Versioned rendered-range contract and backward-compatible draft persistence
  - [x] Exact selection mapping and feedback-only decoration plugin
  - [x] Same-scroll pins, collision-packed cards, and connector layer
  - [x] Responsive, accessibility, capture-suppression, and performance verification
- [x] **Phase 7: Completion, capture-state, and visual polish**
  - [x] Reversible finish checkpoint and sealed handoff result
  - [x] Explicit first-click area-capture state and draft-conflict explanation
  - [x] Theme-yellow review perimeter and AI-oriented Feedback icons
  - [x] Focus, lifecycle, theme, zoom, and no-scroll-regression verification
- [ ] **Testing and verification**
  - [x] Targeted unit/DOM tests
  - [x] Full test, type-check, and development/production builds
  - [x] Coverage, Electron theme/zoom matrices, and 10,000-line performance checks
  - [x] Repository-wide baseline lint cleanup
  - [ ] Manual Extension Host theme/zoom and 10-minute reading checks

---

## 7. Implementation Log

### 2026-08-21 - Implementation started

- **What:** Created `codex/feedback-review`, locked the UX and artifact contracts, and started contract-first tests.
- **Files:** This task record plus new feedback feature modules and tests.
- **Notes:** No commits or pushes. Screenshot rasterization must pass an Electron fixture before release.

### 2026-08-21 - Feature implementation and automated verification

- **What:** Completed snapshot sessions, exact source anchoring, feedback-only toolbar and rail, text comments, annotated DOM capture, bundle persistence, recovery, invalidation, diagnostics, accessibility, and unbound command routing.
- **Verification:** 80 Jest suites passed with 1,100 tests; TypeScript and the production build passed; scoped lint for every changed TypeScript file passed; `modern-screenshot@4.7.0` passed nine Electron cases covering light, dark, high contrast, 100%, 125%, and 200% zoom with local images, tables, Mermaid, and KaTeX.
- **Remaining:** Real VS Code Extension Host interaction and the required long-form manual reading pass. Repository-wide lint remains blocked by seven pre-existing Prettier findings in five unrelated files.
- **Notes:** No commits or pushes.

### 2026-08-21 - Extension Host serializer fix

- **What:** Reproduced and fixed Feedback startup failing with `Markdown serializer is unavailable` in the real Extension Host.
- **Cause:** The Feedback enumerator recognized legacy Markdown storage shapes but not TipTap v3's live `editor.markdown` / `storage.markdown.manager` API.
- **Verification:** Added a failing runtime-shape regression test, then passed the 20-test Feedback review suite, scoped lint, TypeScript, and a fresh development build. Restarted the isolated Extension Host with the corrected bundle.

### 2026-08-21 - Visible start errors and transition guard

- **What:** Fixed the apparent Start feedback flicker and guarded repeated keyboard or Command Palette activation while a session is pending.
- **Cause:** The manual host initially opened only a file, so the required workspace root was unavailable. The correlated host error restored editing, but the pre-session live region had not been created and displayed no reason.
- **Fix:** Routed pre-session failures to the existing visible toast channel, marked Start disabled and busy during the transition, and ignored duplicate start/resume requests.
- **Verification:** Added RED/GREEN tests for visible start failure recovery, one-request transition behavior, and disabled/busy toolbar semantics. The focused review and toolbar suites pass all 33 tests; scoped lint, TypeScript, and the development build pass. The corrected workspace-backed run created `.md4h/feedback/docs/review.md--20260821T171731Z-c645/feedback.md` as a draft.

### 2026-08-21 - Comment drawer collapse recovery

- **What:** Restored the slim 36px comment rail after canceling an empty composer, deleting the last comment, hiding comments, or invalidating the snapshot. Added a labelled collapse control for an expanded drawer.
- **Cause:** Composer and marker actions added the rail's `expanded` state, but several closing paths removed only the content and left that state behind.
- **Verification:** Added RED/GREEN regressions for empty composer cancellation, last-comment deletion, and the explicit collapse control. The focused review and toolbar suites pass all 35 tests; scoped lint and TypeScript pass. The full suite passes 80 runnable suites and 1,106 tests, and both development and production builds pass.

### 2026-08-21 - Selection-local commenting and exact focus recall

- **What:** Replaced the temporary rail-bound Add feedback pill with a Google Docs-style floating comment action beside the selected text. New-comment composition now hides saved cards, while saved text cards show their exact quoted focus and activate the corresponding rendered blocks.
- **Code selection:** Native non-collapsed selection is authoritative over stale ProseMirror state. Feedback mode keeps the editor's selection-capable content surface and enforces immutability through the transaction, input, command, and NodeView guards. Code NodeViews explicitly retain text selection.
- **Contract update:** This supersedes the original rail placement for the temporary Add feedback action. The rail now contains saved comment bubbles only.
- **Verification:** Added RED/GREEN coverage for composer isolation, host refreshes during composition, exact focus cards, active target clearing, selection-local geometry, hidden-rail selection, collapsed carets, and native code selection over stale editor state. The focused review and toolbar suites pass all 40 tests; scoped lint and TypeScript pass. The full suite passes 80 runnable suites and 1,111 tests, and both development and production builds pass.

### 2026-08-21 - Saved capture previews

- **What:** Screenshot comment cards now display the persisted annotated PNG. Existing drafts reconstruct previews on resume, and complete capture replacement rotates a host-owned resource revision so the browser cannot retain stale pixels.
- **Safety and recovery:** The host resolves only the exact store-owned `assets/F<n>.png` through VS Code's scoped webview URI. It does not return image bytes, direct file URIs, or broaden the existing workspace resource roots. A failed image load leaves the feedback and actions available with a visible inline explanation.
- **Verification:** Added RED/GREEN provider and webview coverage for safe URI generation, ordinary-edit stability, replacement cache busting, draft resume, card rendering, text-card isolation, inline load failure, and open-card refresh. The focused suites pass all 52 tests; scoped lint and TypeScript pass. The full suite passes 80 runnable suites and 1,114 tests, and both development and production builds pass.

### 2026-08-22 - Three-state comments disclosure and interaction polish

- **What:** Made hidden, collapsed-marker, and expanded-drawer states explicit across the toolbar and review rail. The Comments control now changes icon, pressed/expanded state, active styling, title, and accessible label with the rail. Expanded comments overlay the document without reflow, the snapshot label clears the drawer, and narrow/high-contrast/reduced-motion layouts retain a focused reading surface.
- **Interaction hardening:** Preserved focus through toolbar rerenders, draft resume, host refreshes, cluster changes, delete/Undo/restore, and keyboard block selection. A pending composer can no longer be hidden, replaced, or bypassed by Finish. The final Undo view collapses to hidden and reopens in one Comments activation. Invalidation preserves typed feedback as a read-only draft.
- **Verification:** Added RED/GREEN coverage for the three toolbar states, ARIA relationships, selection/composer lifecycle, marker clustering, final-delete recovery, and keyboard focus. The focused review and toolbar suites pass all 74 tests. The full suite passes 80 runnable suites and 1,147 tests, TypeScript and scoped lint pass, and development plus production build verification pass. Repository-wide lint still reports the same seven pre-existing Prettier findings in five unrelated files.
- **Notes:** Independent accessibility, host-state, and webview-lifecycle audits found no remaining high- or medium-severity issue in the changed paths. No commits or pushes.

### 2026-08-22 - Document-synchronous annotation redesign planned

- **What:** Researched and specified a replacement for the fixed viewport rail and independently scrolling drawer. The locked UX uses feedback-only semantic highlights, document-synchronous pins, compact anchored cards, one expanded active card, deterministic collision packing, and connector stems.
- **Evidence:** The current implementation derives marker positions from viewport rectangles and recomputes them on scroll, while the drawer owns a second vertical scroll surface. It also discards exact ProseMirror offsets after selection, so resume can restore only containing blocks without a bundle-format addition.
- **Scope:** Planning only. No annotation implementation was performed in this pass. Phase 6 implementation must begin with verified failing tests.

### 2026-08-22 - Phase 6 RED, GREEN, REFACTOR implementation

- **Rendered-range contract:** Added strict, versioned half-open block-relative ranges, host-owned block hashes, draft-only metadata, exact-key protocol parsing in both directions, legacy draft compatibility, sealed omission, and per-item block fallback with `MD4H-FB-ANCHOR-001` when otherwise valid exact metadata no longer resolves. Malformed metadata still rejects the draft. Provider/store/protocol boundary suites are green.
- **Selection and decorations:** Added exact native DOM and ProseMirror selection conversion, UTF-16 offsets, Focus validation, feedback-only overlap-swept inline decorations, opaque-node fallback, pending exact selection decoration, and teardown. The 31-case real selection matrix covers repeated text, Unicode, CRLF normalization, marks, links, lists, blockquotes, code, tables, images, Mermaid-like and math-like atoms, and boundary selections without fuzzy search.
- **Same-scroll layout:** Replaced the fixed drawer and scroll listener with an absolute sibling layer under `#editor`. Added deterministic clustering, active-pivot card packing, connectors, exact target/card geometry indexes, EOF overflow, canonical cluster identity, narrow active-card visibility, and a warm 200-comment layout budget below 16 ms. A 10,000-line/500-comment stress fixture remains linear in comment count.
- **Failure recovery:** Removed fabricated ordinal/card positions. Layout now retains only session-local last-valid measurements, reports stale or unavailable targets in an accessible Retry alert, preserves source-ordered Open actions, and restores positions without guessing. Narrow active cards prefer a position below the target.
- **Capture and boundaries:** Capture teardown is session-aware across picker, crop, rasterization, and annotation modal. Capture hides the review frame and all annotation artifacts. Visible-area candidate discovery now uses cached binary searches before exact DOM intersection; the 10,000-block fixture dropped from 10,003 geometry reads in RED to 28 in GREEN under a 32-read ceiling.
- **Electron verification:** `test:feedback-annotations` passes its verifier, 14 theme/zoom/reduced-motion scenarios, a focused production-controller integration with zero scroll drift and clean teardown, and 10,000-line stress. The fixture documents that the broad visual matrix uses a parallel DOM harness; the focused case mounts the real TipTap controller. The existing capture Electron fixture remains the rasterization gate.
- **Remaining gate:** Run the final repository-wide suites/builds after lifecycle and bracket hardening. The required 10-minute light/dark, keyboard-and-pointer reading pass in the real VS Code Extension Host remains blocked while the Mac UI is locked. Phase 6 stays open until that manual gate is completed.

### 2026-08-22 - Final lifecycle, storage, and delivery hardening

- **Host ownership and races:** Normalized flushed Markdown before hashing, bound each frozen session to its owning split view, serialized Finish and Discard behind accepted mutations, made Discard phase transitions race-safe, and failed closed when line anchors cannot be mapped. Every start or resume now receives a fresh runtime token distinct from its durable round. All active host responses are correlated to that token, while inactive draft discard uses a separate response, so stale async messages cannot update, invalidate, or close a newer session.
- **Capture lifecycle:** Added one controller-owned draft-surface gate across text composition, block selection, area selection, rasterization, and annotation. Finish and Discard focus the incomplete surface instead of losing work. Capture chrome suspension is balanced across success, failure, Retake, Cancel, and session end. Intersecting Mermaid diagrams expose pending, ready, or error state; capture waits for readiness and fails explicitly on error or timeout.
- **Store boundaries:** Enforced 2,000 monotonic allocated IDs, a 64 MiB aggregate screenshot quota, report line and byte limits before parsing, token-owned write locks with narrowly validated stale-lock recovery, strict PNG structure/hash validation, and sealed immutability.
- **Verification:** The complete Jest run passes 89 suites and 1,415 tests, with 27 skipped and 120 existing todos. Coverage passes at 84.33% statements, 77.77% branches, 88.41% functions, and 84.94% lines. TypeScript, scoped lint, debug/release builds, build verification, `git diff --check`, the nine-case Electron capture matrix, the 14-case annotation matrix, and the 10,000-line/500-comment stress run pass. The broad annotation matrix uses 4,378 rendered words; observed 200-comment initial layout was 7.4 ms or less, interactions were 1.8 ms or less, and scroll performed zero annotation layout work.
- **Remaining gate:** Repository-wide lint still reports seven pre-existing Prettier findings in five unrelated files. The required 10-minute real Extension Host reading pass remains open; the isolated development-host process was running but unavailable to the UI controller, so the result was not claimed. A temporary manual fixture created in another workspace was moved to Trash. Phase 6 remains open until the real-host pass is completed.

### 2026-08-22 - Post-audit split, recovery, search, and capture corrections

- **Split-view ownership:** Every non-owning rich-view split now receives a correlated, visible read-only lock during start, resume, review, and reserved transitions. The host blocks peer edits even during the owner's flush window, late-opened splits lock immediately, stale unlocks cannot clear a newer lock, and peers unlock after failure, finish, discard, or owner disposal.
- **Recovery serialization:** Inactive-draft discard now reserves the document through validation, confirmation, and Trash deletion. Resume or Start cannot race the destructive operation, and source changes abort it without deleting the draft.
- **Review search:** Search matches remain visible while browsing a Feedback snapshot. The existing capture-only rule still suppresses them while pixels are generated.
- **Keyboard block capture:** A selected block range must be fully visible before rasterization. Partially offscreen ranges stay in the picker with their values preserved, an accessible recoverable error, and no screenshot or feedback write. Retrying after scrolling captures the exact range.
- **Verification:** The final Jest and coverage runs pass 90 suites and 1,442 tests, with 27 skipped and 120 existing todos. Coverage passes at 84.35% statements, 77.95% branches, 88.41% functions, and 84.96% lines. TypeScript, scoped ESLint and Prettier, debug/release builds, build verification, `git diff --check`, the nine-case Electron capture matrix, the 14-case annotation matrix, the focused production-controller fixture, and the 10,000-line/500-comment stress run pass.
- **Remaining gate:** The required 10-minute light/dark real Extension Host reading pass remains open and is not claimed. No commits or pushes were made.

### 2026-08-22 - Correlated close, owner lock, and retry hardening

- **Fail-closed lifecycle:** Finish and Discard now use a revisioned close handshake. The owner applies exact host-authoritative content while every mutation guard remains active, acknowledges the revision, waits for host release, and becomes editable only after the correlated unlock. Source changes during any handshake produce a newer revision instead of a stale unlock.
- **Transition ownership:** Start, Resume, and inactive-draft Discard immediately lock the initiating rich view as well as sibling splits. Successful session activation reaches the owner before the transition token retires, while cancel, error, and invalidation retain the lock until exact recovery or correlated release.
- **Recovery UI:** Failed TipTap restore operations keep the document read-only and expose labelled close/transition Retry controls. Retry messages are strictly parsed and revision-bound. Typed review data and the source restore state remain available for another attempt.
- **Split lifecycle:** Rich-view panels are registered per split, so closing one split cannot erase a surviving owner's pending edit, in-flight flush, autosave timer, or window-autosave bridge. Host deliveries and echo suppression are also scoped to the exact webview.
- **Verification:** The complete coverage run passes 92 suites and 1,485 tests, with 27 skipped and 120 existing todos. Coverage is 84.74% statements, 79.39% branches, 88.84% functions, and 85.31% lines. TypeScript, scoped ESLint, debug and release builds, build verification, the nine-case Electron capture matrix, the 14-case annotation matrix, the focused production-controller fixture, and the 10,000-line/500-comment stress run pass.
- **Remaining gate:** Repository-wide lint still reports the same seven pre-existing Prettier findings in five unrelated files. The required 10-minute light/dark real Extension Host reading pass remains open and is not claimed. No commits or pushes were made.

### 2026-08-22 - Final split-flush and interaction-state hardening

- **Lossless split transitions:** Start, Resume, and inactive-draft Discard flush every registered split before binding the initiating view to its host lock. Accepted pre-lock edits now require correlated source recovery whenever a later flush, save, mapping, or store step fails. A fired debounce is cleared, so a later host flush cannot resend historical content and spuriously cancel Feedback.
- **Owner disposal safety:** Closing the Feedback owner force-synchronizes every surviving split before unlock. If its final WorkspaceEdit is still pending, the peer lock remains in place until that edit settles, then the current TextDocument is delivered before release. This closes the stale-DOM overwrite window during owner-tab disposal.
- **Closing and recovery UX:** The normal toolbar is fully disabled and busy during Start, Resume, and inactive Discard. The Feedback toolbar is fully disabled and busy during Finish and active Discard. Closing sessions are non-writable, duplicate close actions are ignored, recoverable Retry failures re-enable and refocus Retry, and successful close or transition removal restores logical editor or draft-action focus. Disabled actions now have consistent visual treatment.
- **Editor-boundary safety:** Local pre-session locks now block link, math, paste, save, and other document commands just like active sessions and peer locks. An Audit that finishes after Feedback becomes locked discards its stale result instead of reopening overlays or decorations. Rejected asynchronous audits now dismiss their non-expiring loading toast through a guaranteed cleanup path.
- **Verification:** The focused Feedback matrix passes 19 suites and 529 tests. The complete coverage run passes 92 suites plus 1 skipped suite and 1,502 tests, with 27 skipped and 120 existing todos. Coverage is 84.74% statements, 79.39% branches, 88.84% functions, and 85.31% lines. TypeScript, scoped ESLint and Prettier, debug and release builds, build verification, `git diff --check`, the nine-case Electron capture matrix, the 14-case annotation matrix, the focused production-controller fixture, and the 10,000-line/500-comment stress run pass.
- **Remaining gate:** Repository-wide lint still reports the same seven pre-existing Prettier findings in five unrelated files. The required 10-minute light/dark real Extension Host reading pass remains open and is not claimed. No commits or pushes were made.

### 2026-08-22 - Mixed-list startup and disposed-webview regression fixes

- **Exact mixed-list anchoring:** Reproduced the reported `Block ordinal 58 produced 2 top-level Markdown blocks` failure against the real 686-line `ref.md`. TipTap's ordered-list tokenizer kept two-space nested bullets inside the preceding ordered item while `markdown-it` split them. The host mapper remains strict, but now applies a narrow, line-count-preserving parser shadow only for a proven level-zero dot-ordered continuation extent. Raw bytes and source line spans are unchanged, unrelated multi-block canonical Markdown still fails closed, and there is no fuzzy text or nearest-line fallback.
- **Start-session delivery:** Increased the fail-closed Feedback flush acknowledgement deadline from the autosave bridge's 250 ms to 2 seconds for busy rich views. Live tracing then exposed the real repeated failure: VS Code invalidates `webviewPanel.webview` before its disposal callback runs, so cleanup re-read the invalid getter, threw, and left a dead peer registered. Resolution now captures the live webview once, uses that reference throughout lifecycle and autosave paths, prunes only peers whose `postMessage` explicitly reports them unavailable, and still fails closed for an unavailable owner or a live unresponsive split.
- **Final adversarial hardening:** The ordered-list parser shadow now applies only to a proven column-zero TipTap root, preserving the separate block boundaries TipTap produces for one- and two-space roots. A rich-view edit invalidates that split's last host-delivery cache so an external `A -> B -> A` revert is always delivered. Pending-edit flushes accept only a literal `ok: true`; missing, false, and malformed acknowledgements fail closed.
- **Notification containment:** Feedback-local errors use a keyed toast. Repeated retries refresh and replace one notification instead of stacking identical banners.
- **RED/GREEN coverage:** Added the exact mixed-list fixture plus a real configured TipTap integration test, strict unrelated-multiblock rejection, indented-root boundaries, delayed, missing, false, and malformed flush acknowledgements, external source reverts, disposed-getter ordering, unavailable owner/peer handling, peer disposal between delivery and acknowledgement, window-autosave disposal races, and keyed toast lifetime/message replacement.
- **Verification:** The complete Jest run passes 93 suites and 1,521 tests, with 1 suite skipped, 27 tests skipped, and 120 existing todos. TypeScript, scoped ESLint/Prettier, the production release build and bundle verifier, and `git diff --check` pass. In the real Extension Development Host, the exact failing `ref.md` now enters Feedback mode and announces `Feedback review started. Snapshot saved.` with `Finish & copy`, `Capture area`, and `Comments`; neither the ordinal error nor flush error appears.
- **Remaining gate:** Repository-wide lint still reports the same seven pre-existing Prettier findings in five unrelated files. The required 10-minute light/dark reading pass remains open and is not claimed. No commits or pushes were made.

### 2026-08-22 - Deep-selection composer scroll preservation

- **Cause:** The document-synchronous composer is absolutely positioned beside its target during the next animation frame. Its textarea was focused immediately with the browser default, so Chromium could scroll the still-unpositioned composer at the top of the annotation layer into view before layout placed it beside a deep code-block selection.
- **Fix:** Initial composer focus now uses `focus({ preventScroll: true })`, preserving the current viewport while retaining immediate keyboard focus. Cancel restores focus to the invoking editor surface with the same non-scrolling option, preventing the paired return-focus jump.
- **RED/GREEN coverage:** Added exact code-selection coverage for `marketplace-assets/ref.md` lines 242-276. The tests model native browser focus scrolling from a document `scrollTop` of 4,800 and verify both composer opening and cancellation leave it unchanged.
- **Verification:** The complete Jest run passes 93 suites and 1,523 tests, with 1 suite skipped, 27 tests skipped, and 120 existing todos. TypeScript, scoped ESLint/Prettier, the production release build and bundle verifier, and `git diff --check` pass. In the real Extension Development Host, selecting the reported TypeScript code in `ref.md`, opening the composer, and cancelling it all keep the TypeScript block and following `8.2 Python` heading in the same viewport while the field receives focus and reports source lines 242-276. No commits or pushes were made.

### 2026-08-23 - Completion, capture-state, and visual polish planned

- **What:** Locked a focused Phase 7 plan without changing the document-synchronous rail or its scroll geometry.
- **Finish flow:** Replace the unreliable native confirmation with a labelled, focus-trapped checkpoint. It shows the workspace-relative bundle path and current item count, defaults focus to `Resume feedback`, and sends no finish request until the irreversible action is explicitly confirmed. A sealed result uses the host-authoritative locked count and clipboard outcome.
- **Completion protocol note:** The implementation adds both host-authoritative `itemCount` and the already-generated, content-safe agent `prompt` to `feedback.finished`. The prompt is needed only for the sealed result's webview-owned `Copy again` recovery after the editor unlocks; it avoids rebuilding the handoff in mutable webview state and replaces the duplicate native VS Code warning.
- **Capture flow:** Model `idle`, `armed`, and `rasterizing` explicitly. One toolbar click must visibly arm capture, expose `Cancel capture`, and explain any competing unfinished draft instead of silently consuming the request.
- **Visual identity:** Use a static, layout-neutral, theme-warning-yellow perimeter and warmer annotation accents only during Feedback mode. Use the bundled `comment-discussion-sparkle` Codicon for Feedback comment actions while preserving the existing rail DOM and marker geometry.
- **TDD:** Phase 7 begins with focused RED tests for the controller modal, strict protocol count, toolbar state, capture lifecycle, conflict messages, CSS gating, high contrast, and ordinary-mode absence. No commits or pushes.

### 2026-08-23 - Completion, capture-state, and visual polish implemented

- **Reversible completion:** `Finish & copy` now opens a focus-trapped checkpoint with the workspace-relative bundle path, current item count, safe initial focus on `Resume feedback`, Reveal, zero-item protection, one-shot finish correlation, and no background scrolling. The sealed result survives editor unlock, reports the host-authoritative locked count and clipboard state, and supports `Copy again` without making the sealed bundle mutable.
- **Explicit capture lifecycle:** Area capture now exposes `idle`, `armed`, and `rasterizing` toolbar states. The first click synchronously shows a labelled crop dialog and `Cancel capture`; Escape works even after focus moves to a rerendered toolbar, repeat commands receive state-accurate guidance, recoverable failures return to armed Retry, and logical focus survives toolbar replacement and falls back to the editor.
- **Feedback identity:** Feedback mode uses a layout-neutral, theme-warning perimeter, warmer saved and active highlights, high-contrast non-color cues, reduced-motion handling, and the bundled `comment-discussion-sparkle` icon. The document-synchronous rail, comment packing, and zero-work-on-scroll architecture were not changed.
- **Audit hardening:** Independent lifecycle and visual audits found no P1 issue. Their P2 findings were fixed with regressions for modal command containment, disabled Finish focus fallback, capture-global Escape, annotation focus restoration, accessible count and path semantics, and high-contrast capture state. A new Electron activation gate exposed a real high-contrast inline-border shift; replacing it with a paint-only inset indicator reduced editor, target, and scroll activation drift to exactly 0 CSS px in every scenario.
- **Verification:** The final Jest run passes 93 suites and 1,561 tests, with 1 suite skipped, 27 tests skipped, and 120 existing todos. Coverage passes at 84.91% statements, 79.33% branches, 89.17% functions, and 85.58% lines. TypeScript, scoped ESLint and Prettier, debug and release builds, bundle verification, `git diff --check`, the nine-case Electron capture matrix, the 14-case annotation matrix, the real-controller fixture, and the 10,000-line/500-comment stress run pass.
- **Remaining gate:** The real Extension Development Host light, dark, and high-contrast pass at 100%, 125%, and 200% zoom, including the required 10-minute reading session, remains open and is not claimed.

### 2026-08-23 - Commit cleanup and final automated verification

- **Cleanup:** Removed unrelated whole-file formatter churn from the editor stylesheet, README, architecture guide, environment context, and third-party license file. The active pre-commit lint baseline was normalized in five existing TypeScript files. User-owned `.chetana/` profile state remains untouched and locally excluded from staging.
- **Final audit fixes:** Navigation now stays behind any active modal, Finish focus restoration rejects semantically disabled or hidden return targets, area capture inerts and focus-traps the background, and annotation completion restores a logical replacement action after toolbar or card rerenders. Focused regressions cover each path.
- **Verification:** The repository-wide Jest run passes 93 suites and 1,564 tests, with 1 suite skipped, 27 tests skipped, and 120 existing todos. Repository lint, strict TypeScript, the production release build, bundle verification, both staged Electron fixtures, all 9 capture combinations, all 14 annotation scenarios, and the 10,000-line/500-comment stress gate pass.
- **Delivery:** Work was committed locally in dependency-safe phases after explicit user approval. Nothing was pushed. The real Extension Host theme/zoom and 10-minute reading gate remains open.

### 2026-08-23 - Closed-tab session recovery

- **Lifecycle recovery:** Closing the only rich-view tab releases its volatile Feedback owner while preserving the Git-trackable draft. Reopening the Markdown file advertises the matching draft. Start reopens that Resume choice, while `Start new` is an explicit secondary action.
- **Orphan reconciliation:** A replacement rich view now reclaims a session or startup transition whose owner is no longer registered. An accepted WorkspaceEdit remains fail-closed until it settles, then the next Start safely retries reconciliation.
- **RED/GREEN coverage:** Added full resolve, start, dispose, reopen, draft discovery, and restart coverage, plus simulated incomplete-disposal and pending-edit races. Direct provider fixtures now register their webview owners to match the production lifecycle.
- **Verification:** The repository-wide Jest run passes 93 suites and 1,567 tests, with 1 suite skipped, 27 tests skipped, and 120 existing todos. Repository lint, strict TypeScript, the production release build, bundle verification, and `git diff --check` pass. No commit or push was made for this follow-up fix.

### 2026-08-23 - Idempotent Start and lost-controller recovery

- **Recovery entry point:** `Start feedback` now detects a host-active session or exact-hash saved draft and returns a correlated Resume prompt instead of the generic already-active error. The prompt exposes only round, count, timestamp, and bundle path metadata.
- **Safe rehydration:** Confirming Resume rebuilds the strict host anchor map from the current rich-view blocks, waits for accepted feedback writes, verifies the frozen source hash, preserves all item IDs, and issues a fresh runtime token. A stale runtime token can no longer mutate the recovered session.
- **Split behavior:** Start alone never changes ownership. An explicit Resume from another rich-view split transfers ownership, deactivates the old runtime, and replaces the peer-lock token without an editable gap at the host boundary.
- **Duplicate-round control:** A dismissed draft is shown again when Start is selected. Creating another round requires the explicit `Start new` action and leaves older drafts untouched.
- **Reload reconciliation:** Repeated Start and Resume entry operations are serialized per document. A recreated owner controller is locked while accepted writes and Finish/Discard close operations settle, then it and every sibling receive authoritative Markdown before volatile ownership is demoted to the durable draft and Resume is offered again. Invalidated same-owner runtimes no longer leave Start behind an impossible Resume loop.
- **Transfer authorization:** A live-session Resume requires a fresh, one-shot host offer for that webview, round, and runtime token. Clicking a stale saved-draft banner first produces an explicit `Resume here` transfer warning and cannot silently take ownership from another split.
- **Host-authoritative Start:** Start always asks the extension host to revalidate current source and draft state. Cached draft metadata no longer bypasses exact-hash preflight after later document edits.
- **RED/GREEN coverage:** Added strict protocol parsing, same-owner controller-loss recovery, in-flight Start reload recovery, saved-draft preflight, explicit new-round creation, live-peer confirmation, stale-banner transfer rejection, closed-tab and orphaned-owner resume, stale-token and async-resurrection rejection, invalidation recovery, source-mismatch release, Finish/Discard reload ordering, peer handoff ordering, focus/read-only behavior, and editor-boundary routing tests.
- **Verification:** The focused recovery matrix passes 6 suites and 325 tests. The deterministic repository-wide Jest run passes 94 suites and 1,640 tests, with 1 suite skipped, 27 tests skipped, and 120 existing todos. Repository lint, strict TypeScript, the production build, bundle verification, and `git diff --check` pass. No commit or push was made.

### 2026-08-23 - Inline comment editing and action cleanup

- **Root cause:** Comment editing depended on `window.prompt()`, but VS Code webview iframes do not grant the browser `allow-modals` sandbox capability. The Edit click therefore had no reliable visible result even though the host edit protocol and persistence path were valid.
- **Inline edit surface:** Edit now opens a labelled textarea inside the active card for text and screenshot feedback. Save trims and serializes one mutation, blocks duplicates, retains the draft and caret after a failed or unrelated host refresh, and restores focus after Save, Cancel, or Escape. The shared draft-surface gate prevents Finish, capture, navigation, rail collapse, or another comment from replacing an incomplete edit.
- **Action cleanup:** Removed the obsolete `Show target` button. Cards, markers, and targets now share the document scroll coordinates, marker/card activation already strengthens the yellow target, and Next/Previous performs explicit offscreen navigation. A second scroll-only control was both redundant and visually imperceptible when the target was already beside the card.
- **Verification:** The focused controller and style suites pass 156 tests. The repository-wide Jest run passes 94 suites and 1,644 tests, with 1 suite skipped, 27 tests skipped, and 120 existing todos. Repository lint, strict TypeScript, the production build, and bundle verification pass. No commit or push was made.

### 2026-08-23 - Review perimeter spacing and weight

- **Visual separation:** Replaced the inset 2px border with a 3px theme-warning outline offset 11px from the Markdown surface. The stroke moves outward into the editor's existing margin, leaving prose geometry and line wrapping unchanged while creating a visibly calmer gap around the content.
- **Narrow-layout correction:** The first negative-inset implementation failed the Electron narrow-view gate with 14px of horizontal overflow. The final offset-outline implementation preserves the same visual expansion without contributing to scroll overflow. High contrast remains solid and theme-derived, and capture still suppresses the perimeter.
- **Verification:** The focused CSS contract passes 17 tests. The full 14-scenario Electron annotation matrix passes light, dark, high contrast, 100%, 125%, 200%, narrow, and reduced-motion cases with zero activation shift, zero scroll shift, and zero horizontal overflow. The repository-wide Jest run passes 93 suites and 1,567 tests. Repository lint, strict TypeScript, the production release build, bundle verification, and `git diff --check` pass.

---

## 8. Decisions & Tradeoffs

- **Frozen snapshot:** Exact anchors and predictable handoff outweigh editing during a session.
- **Feedback-only toolbar:** Keeps actions discoverable without leaving disabled formatting controls visible.
- **Document-synchronous annotation layer:** Pins and cards share the rich document's scroll coordinates without entering ProseMirror's managed DOM or reflowing prose.
- **Feedback-only hybrid highlighting:** Exact text receives a subtle semantic highlight only while Feedback mode is active; screenshots, opaque NodeViews, legacy drafts, and block selections use a restrained edge bracket.
- **Compact-card disclosure:** Expanded comments show compact cards in source order, with only one active card expanded. Collision displacement is made explicit with connector stems.
- **Reversible completion checkpoint:** An accidental Finish click never seals. Resume remains available only before the existing `feedback.finish` request is posted.
- **Explicit capture state:** Capture activation is synchronous and visible. Competing drafts retain their data, receive focus, and explain why capture did not begin.
- **Feedback visual identity:** A non-layout-changing, theme-yellow review perimeter distinguishes Feedback mode without changing prose width, target coordinates, or the document-synchronous rail.
- **AI-oriented comment affordance:** `comment-discussion-sparkle` communicates feedback prepared for an agent without implying that the agent authored it.
- **Flattened screenshot markup:** Maximizes portability; post-submit vector editing is deferred.
- **No default shortcuts:** VS Code retains ownership of the keyboard space.

---

## 9. Locked Phase 6 Plan: Document-Synchronous Annotations

### 9.1 Problem diagnosis and research basis

This phase replaces the current rail architecture rather than adding another scroll callback:

- `.feedback-comment-rail` is fixed to the viewport.
- Marker `top` is calculated as `block.getBoundingClientRect() - rail.getBoundingClientRect()` and recalculated during scroll.
- `.feedback-comments-panel` has its own `overflow: auto`, so the document, markers, and cards do not share a vertical coordinate system.
- Saved text items retain top-level block ordinals, line ranges, and `Focus`, but not the half-open ProseMirror range. Resume can therefore restore a block, not an exact repeated-text occurrence.

The design follows these primary references:

- [ProseMirror guide](https://prosemirror.net/docs/guide/) and [reference](https://prosemirror.net/docs/ref/): decorations are view state rather than document content; `DecorationSet`, transaction metadata, `posAtDOM`, and `coordsAtPos` are the supported primitives.
- [TipTap Extension API](https://tiptap.dev/docs/editor/extensions/custom-extensions/create-new/extension): custom editor behavior belongs in extensions/plugins. The installed TipTap 3.12.1 API also exposes plugin registration and removal, allowing the annotation plugin to exist only during Feedback mode.
- [MDN containing-block rules](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_display/Containing_block): fixed elements use viewport coordinates, while an absolute sibling can use the editor wrapper as its containing block.
- [MDN ResizeObserver](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver) and [requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame): observe actual layout changes, coalesce work before paint, and avoid observer loops by separating reads from writes.
- [WAI keyboard-interface guidance](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/) and [disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/examples/disclosure-faq/): keep focus visible and predictable, distinguish focus from active selection, expose `aria-expanded`/`aria-controls`, and restore focus when details close.
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview): retain native semantic controls, VS Code theme variables, webview lifecycle cleanup, and the existing CSP boundary.

### 9.2 Locked UX contract

| State     | Saved targets                                      | Annotation UI                                                                    | Toolbar state                    |
| --------- | -------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------- |
| Hidden    | Hidden, except a pending new selection             | No pins or cards                                                                 | Unpressed; `aria-expanded=false` |
| Collapsed | Subtle saved highlights or block brackets          | Document-aligned pins; nearby targets may cluster                                | Pressed; `aria-expanded=false`   |
| Expanded  | Saved highlights remain; active target is stronger | All comments are compact anchored cards; only the active card shows full details | Pressed; `aria-expanded=true`    |

Additional behavior:

- A new native or ProseMirror selection shows `Add feedback` at the selection endpoint in the same document coordinate space. It is not confined to the side lane.
- Opening a new composer hides saved cards to avoid the old comment distracting from the new note. Saved pins and subtle target marks may remain. The anchored composer is the only expanded surface until Add or Cancel.
- A compact card shows stable `F<n>`, a short Focus or type label, and a two-line feedback preview. The active card shows exact Focus or screenshot, source lines, full feedback, and actions.
- A pin, saved highlight, or compact card activates the same stable item or cluster. A click-drag that creates a text selection must never be mistaken for highlight activation.
- The annotation region and pins remain in source order even when visual collision packing moves cards. Marker names include stable IDs, source lines, and a short Focus/type description; clusters announce their count and member IDs.
- Marker navigation uses one roving tab stop with Up/Down/Home/End only while the region owns focus. Enter or Space opens details, Escape closes them, and unbound Next/Previous feedback commands provide Command Palette navigation without claiming VS Code shortcuts.
- Activating an offscreen item through Next/Previous scrolls its target/card pair into a safe central region. Marker and compact-card activation strengthen the document-aligned target directly, so active cards do not duplicate that behavior with a separate target button. Escape closes details and restores focus to the matching pin.
- Code blocks use exact text ranges because their NodeView exposes `contentDOM`. Images, Mermaid, rendered math, and other opaque/atomic NodeViews use block brackets and never pretend to support character-level anchoring.
- On views at or below 840px, pins remain document-synchronous but inactive compact cards are suppressed. The one active card is nearly full width and anchored below or beside its target in the same scroll surface. This supersedes the independently scrolling bottom sheet.
- Native selection remains stronger than saved highlights. All visual annotations disappear on finish, discard, deactivation, or ordinary editing mode.

### 9.3 DOM ownership and scroll model

```text
body scroll surface
├── formatting toolbar (sticky)
└── #editor.feedback-review-surface (position: relative)
    ├── .markdown-editor                 ProseMirror-owned
    ├── aside.feedback-annotation-layer  extension-owned, absolute
    │   ├── svg.feedback-connectors      decorative, pointer-events: none
    │   ├── .feedback-marker-layer       buttons only
    │   └── .feedback-card-layer         compact and active cards
    └── .feedback-annotation-spacer      feedback-only EOF overflow, when needed
```

Rules:

- The annotation layer is a sibling of `editor.view.dom`, never a child of ProseMirror and never a widget decoration. This preserves top-level child ordinals, NodeView ownership, native selection, screenshot block enumeration, and Markdown serialization.
- The layer is absolute against `#editor`, with `pointer-events: none`; only semantic buttons and cards opt back into pointer input. It overlays the unused right margin and never changes prose width.
- Anchor Y is measured once in document coordinates by subtracting the `#editor` rectangle from a range or target rectangle. Both rectangles move equally during page scroll, so scrolling requires no geometry reads, animation frame, or style writes.
- One batched layout pass reads all annotated target/card geometry, computes placement in memory, then writes positions and connector paths. It runs on activation, item changes, active-card changes, wrapper/card resize, viewport resize or zoom, font readiness, and annotated image/Mermaid/math layout completion.
- Observe the editor root, card layer, and annotated asynchronous targets only. Never observe or traverse all blocks in a 10,000-line document.
- If packed cards extend beyond the prose at EOF, a feedback-only spacer adds only the necessary vertical scroll room. It must not change prose width and must be removed completely when Feedback mode ends.

### 9.4 Exact rendered-range contract and migration

Line ranges remain host-authoritative and agent-facing. Exact rich-view highlighting adds optional draft-only metadata:

```ts
interface FeedbackRenderedRangeV1 {
  version: 1;
  startOrdinal: number;
  startOffset: number;
  endOrdinal: number;
  endOffset: number; // half-open
  startBlockSha256: string;
  endBlockSha256: string;
}
```

- Offsets are relative to the content start of their zero-based top-level ProseMirror blocks. They distinguish repeated identical text without depending on positions of preceding blocks.
- The webview sends only the ordered block-relative offsets. The host validates safe integers, existing frozen ordinals, lexicographic `(startOrdinal, startOffset) < (endOrdinal, endOffset)`, and offsets within the block content sizes supplied by the frozen canonical map. The host adds canonical block SHA-256 values before persistence.
- Creation canonicalizes endpoints that land exactly on block boundaries so the first and last ordinals both contain selected content. Resume validation never clamps an invalid endpoint.
- New text comments store the range as a strict, canonical machine comment adjacent to the item in a draft, for example `<!-- md4h-rendered-range:{...} -->`. The metadata is removed while sealing, so the established agent-facing bundle remains unchanged.
- Edit, delete, Undo, restore, atomic rewrite, and host restart preserve draft metadata. Screenshot items and keyboard block-range comments cannot claim an inline range.
- Resume reconstructs current absolute ProseMirror positions only when the source hash, canonical block hashes, ordinal bounds, offsets, and exact visible Focus all validate. DOM Range text is used for visible-text validation where the NodeView exposes content. Only CRLF normalization is allowed.
- Any mismatch produces the stable containing-block bracket plus a safe diagnostic. It never searches for `Focus`, chooses a nearest line, clamps a bad range, or silently re-anchors.
- During Phase 7, existing development `md4h-feedback/v1` drafts without the optional comment remained valid and received block brackets. Phase 8 supersedes that temporary compatibility rule by replacing the unreleased v1 grammar in place. Malformed metadata is rejected as an invalid draft rather than ignored. Sealed bundles need no rendered metadata because sealed sessions are not resumable.

Protocol and model changes:

- Extend `CanonicalFeedbackBlock` with validated `contentSize` for host range bounds.
- Add a strict rendered-selection input to `feedback.text.add` and an optional host-enriched range to `FeedbackItemSummary`.
- Extend `TextFeedbackItem` with optional rendered metadata and `ActiveFeedbackSession.targets` with a rendered target union. Block and screenshot targets retain exact ordinal ranges.
- Reject partial fields, unknown keys, negative/non-integer offsets, collapsed/reversed ranges, offsets outside their claimed blocks, and inline ranges on non-text items at the host boundary.

### 9.5 Feedback-only decoration plugin

Create `src/webview/features/feedbackAnnotations.ts` with a `PluginKey`, immutable annotation state, and commands to set items, set active IDs, suspend for capture, restore, and clear.

- Register the ProseMirror plugin only after a Feedback session activates; unregister it before unlocking or replacing the document. Outside Feedback mode there is no annotation plugin, range processing, decoration DOM, listener, or style effect.
- Exact text uses non-overlapping `Decoration.inline` segments. Build segments with an interval sweep so overlapping comments do not stack translucent backgrounds; preserve the sorted associated IDs in plugin state/data attributes.
- Whole blocks and opaque targets use `Decoration.node` only at valid node boundaries. Multi-block block-level and fallback targets also receive a sibling-layer bracket spanning the containing blocks; an exact resolved cross-block inline range does not.
- Saved targets use a restrained theme-derived amber/warning fill or edge. Active targets strengthen the same semantic treatment. High contrast replaces translucent fill with a 2px underline/outline and edge; it never relies on color alone.
- Decorations are visual only, never focusable and never repeated to screen readers. Pins and cards own accessible names and interaction.
- Invalidation retains current decorations but disables mutations. Capture suspends both decoration state and the sibling layer before cloning/rasterization, then restores both after success, retry, Retake, Cancel, or failure.
- Use unique feedback classes. Do not reuse `.highlighted`, search, audit, Mermaid, math, selection, or NodeView state classes.

### 9.6 Clustering, collision packing, and connectors

Create `src/webview/features/feedbackAnnotationLayout.ts` as a pure module. Input contains stable ID/order, target Y, measured compact/active height, document bounds, and minimum gap. Output contains card top, attachment point, displacement, and connector path.

Algorithm:

1. Sort by target Y, source order, then numeric `F<n>`.
2. Cluster pins when rendered ranges overlap or their target centers are closer than one marker diameter. Cluster membership and member order remain deterministic across resize.
3. Place the active card closest to its preferred target, then pack earlier cards upward and later cards downward with an 8px minimum gap.
4. Clamp at the top, extend feedback-only EOF space at the bottom when required, and run final forward/backward passes without reversing source order.
5. Draw a short theme-aware SVG connector only when packing displaces a card by more than 4px. Clamp the attachment point to the card edge. Connectors are `aria-hidden` and noninteractive.

Complexity is one sort plus linear clustering/packing, `O(c log c)` for `c` comments. It must never become `O(document blocks × comments)`.

### 9.7 Module-level implementation map

- `src/shared/feedbackProtocol.ts`: rendered-range types, exact-key parsing, limits, host summary union.
- `src/editor/feedbackSessionStore.ts`: optional draft metadata rendering/parsing, preservation, sealed omission, legacy migration.
- `src/editor/MarkdownEditorProvider.ts`: canonical content sizes/hashes, host validation, active target state, resume reconstruction.
- `src/webview/features/feedbackRenderedRange.ts` (new): native DOM Range to ProseMirror conversion with `posAtDOM`, top-level relative offsets, resolution, and exact Focus validation.
- `src/webview/features/feedbackAnnotations.ts` (new): dynamically registered decoration plugin and overlap segmentation.
- `src/webview/features/feedbackAnnotationLayout.ts` (new): pure clustering, packing, and connector geometry.
- `src/webview/features/feedbackReview.ts`: session state, sibling-layer lifecycle, composer/cards, activation, navigation, batched layout, focus restoration; remove fixed-rail positioning and persistent scroll listener.
- `src/webview/features/feedbackDomCapture.ts` and `feedbackCaptureWorkflow.ts`: explicit annotation suspension plus cloned-DOM sanitization.
- `src/webview/editor.css`: review-gated highlight, bracket, pin, compact/active card, connector, responsive, high-contrast, and reduced-motion styles.
- `package.json` and `src/extension.ts`: add unbound Next feedback and Previous feedback commands only; claim no default chords.

### 9.8 RED, GREEN, REFACTOR, VERIFY sequence

Each slice starts by adding the stated failing tests and recording the expected RED failure in this task log. Implementation does not start until the new assertion fails for the intended reason.

1. **Rendered-range contract and draft migration**
   - RED: extend `feedbackProtocol.test.ts`, `feedbackSessionStore.test.ts`, and `feedbackProvider.test.ts` for valid half-open ranges; negative, collapsed, reversed, partial, unknown, and out-of-block data; exact draft round-trip; edit/delete/restore preservation; sealed omission and rollback; legacy resume; malformed metadata; repeated identical Focus; no fuzzy fallback.
   - GREEN: implement the strict protocol, host enrichment/validation, and optional draft metadata.
   - REFACTOR: centralize range validation and canonical encoding; keep storage writes serialized and atomic.
   - VERIFY: focused shared/editor suites, strict TypeScript, scoped lint, and diff check.

2. **Selection conversion and exact decoration state**
   - RED: add `feedbackRenderedRange.test.ts` and `feedbackAnnotations.realEditor.test.ts` using a real TipTap fixture with repeated phrases, hard wraps, CRLF source, Unicode, marks/links, lists, blockquotes, fenced code, tables, images, Mermaid, math, and boundary selections.
   - GREEN: map ordered native ranges with `view.posAtDOM`, use PM `from/to` when authoritative, resolve block-relative offsets, validate exact Focus, and render inline/node decorations.
   - REFACTOR: interval-sweep overlap segmentation and opaque-NodeView fallback as pure helpers.
   - VERIFY: document JSON and Markdown serialization remain byte-equivalent; decoration transactions are metadata-only; teardown leaves no plugin outside Feedback mode.

3. **Pure annotation layout**
   - RED: add `feedbackAnnotationLayout.test.ts` for equal/reversed inputs, stable IDs, no overlap, 8px gaps, active pivot packing, top/bottom bounds, fractional values, connector thresholds, cluster split/merge, invalid geometry, and deterministic output independent of input order.
   - GREEN: implement one sort plus linear clustering and packing.
   - REFACTOR: separate measurement inputs from placement outputs and keep all DOM out of the module.
   - VERIFY: 200 comments lay out below 16ms after warm-up; 5,000 synthetic comments remain below a loose 100ms CI ceiling with no nested scan.

4. **Same-scroll layer and interaction integration**
   - RED: extend `feedbackReview.test.ts` for sibling ownership, invariant document Y during scroll, zero scroll scheduling/geometry reads, hidden/collapsed/expanded synchronization, selection-local composer, compact/active card content, cluster identity, click-drag protection, host refresh, invalidation, Delete/Undo, focus restoration, and complete teardown.
   - GREEN: replace the fixed rail/drawer with the sibling layer and connect it to decoration/layout state.
   - REFACTOR: one explicit comments state machine and one coalesced layout scheduler; remove `getBlockTop`, `positionMarkers`, the panel scroll surface, and the persistent scroll listener.
   - VERIFY: a generated 10,000-line JSDOM fixture with 200 comments reads only annotated targets/cards, not every block, and performs zero annotation work on simulated scroll.

5. **Visual, responsive, accessibility, and capture polish**
   - RED: add `feedbackAnnotationStyles.test.ts`; extend capture workflow/DOM capture tests for suspension and restore; add keyboard/ARIA cases for labelled region, stable IDs, cluster names, roving marker navigation, Enter/Space, Home/End, Escape, `aria-controls`, `aria-expanded`, active-vs-focus distinction, live announcements, and 200% zoom.
   - GREEN: implement theme-derived styles, bracket/connector visuals, narrow anchored-card treatment, high contrast, reduced motion, Next/Previous commands, and capture sanitization.
   - REFACTOR: keep visual state selectors gated by `.feedback-review-active`; share focus/activation helpers and cleanup paths.
   - VERIFY: screenshots contain no feedback layer, highlight, connector, focus ring, or spacer after success, failure, Retake, replacement, or Cancel.

6. **Electron and delivery verification**
   - Add `scripts/feedback-annotation-fixture/`, reusing the existing Electron discovery and zoom setup rather than overloading the capture fixture.
   - Matrix: light, dark, and high contrast at 100%, 125%, and 200%; narrow light/dark/high contrast at 100%; reduced motion in light and high contrast.
   - Content: 3,000+ words, repeated text, marks/links, code, table, local image, Mermaid, KaTeX, screenshots, multi-block targets, top/middle/EOF comments, and five-plus dense collisions.
   - Automated gates: target-to-pin drift at most 2 CSS px after fast scroll and async reflow; no card overlap; at least 8px gaps; correct connector endpoints; no independent card-panel `scrollTop`; no horizontal overflow in narrow mode; no annotation artifacts after deactivation; 200-comment initial render below 300ms; compact/active interaction below 50ms; no annotation JavaScript or annotation-attributed long task during scroll.
   - Add a non-screenshot stress run with 10,000 source lines and 500 comments. Geometry reads remain bounded to annotated targets/cards, the final target stays reachable, and layout remains `O(c log c)` rather than depending on total block count.
   - Run focused suites, full Jest, coverage, TypeScript, repository lint with pre-existing findings separated, development and production builds, both Electron fixtures, and `git diff --check`.
   - Complete the required 10-minute light/dark keyboard-and-pointer reading pass on a 3,000+ word document. Confirm ordinary mode has no plugin, highlight DOM, annotation layer, altered prose width/height, listener, or measurable typing regression.

### 9.9 Failure policy and release gates

- Exact inline metadata failure degrades visibly to a containing-block bracket and safe diagnostic. It never guesses.
- A layout measurement failure retains usable source-ordered pins/cards at their last valid positions and offers Retry; it does not hide feedback.
- ResizeObserver callbacks schedule a later read/write frame and never directly mutate an observed size, preventing feedback loops.
- Existing source-hash invalidation remains authoritative and blocks additions/finish without removing annotations or typed drafts.
- The old fixed rail and independent drawer are removed only after the new controller, capture, resume, and accessibility tests are green.
- Phase 6 cannot be marked complete until all automated suites, Electron matrices, performance budgets, manual reading checks, documentation updates, and self-review pass. After explicit user approval, completed work may be committed in dependency-safe phases. Do not push.

---

## 10. Locked Phase 7 Plan: Completion and Feedback-Mode Polish

### 10.1 Completion dialog contract

The finish experience has three explicit local states around the existing host-owned seal and close handshake:

```text
active review
  -> confirm checkpoint       no host message, source remains locked
      -> Resume feedback      restore the exact review UI and scroll position
      -> Finish & copy        post one correlated feedback.finish request
          -> finishing        no Resume, all review actions disabled
          -> sealed result    authoritative count, bundle path, clipboard status
              -> close sync and release
              -> ordinary editor with dismissible result dialog
```

Rules:

- Opening the checkpoint hides or dims review chrome without changing document geometry, source state, comment disclosure state, or scroll position.
- The dialog is labelled, modal, focus trapped, and mounted outside ProseMirror. `Resume feedback` receives initial focus because sealing is irreversible. Escape is equivalent to Resume only in the pre-seal state; backdrop clicks do nothing.
- Show `1 feedback item ready to lock` or `<n> feedback items ready to lock`, the workspace-relative `feedback.md` path, `Resume feedback`, `Reveal feedback file`, and `Finish & copy`.
- With zero items, show `No feedback logged yet` and keep the irreversible action disabled.
- Confirming allocates one request ID, posts `feedback.finish` once, removes Resume, and keeps the editor read-only until the existing correlated source sync and peer unlock complete.
- Add `itemCount` to `feedback.finished`. The host obtains it after pending mutations settle and sealing succeeds, so the result can truthfully show `1 feedback item locked` or `<n> feedback items locked`.
- The sealed result survives controller deactivation long enough to report the bundle path and whether the agent handoff was copied. It cannot resume or mutate the sealed bundle. `Done` or Escape dismisses only the result.
- A correlated pre-seal error restores the checkpoint with an inline recoverable error and retry. Invalidation keeps the draft locked and disables sealing. Clipboard failure remains a successful seal and uses the existing safe retry path.

### 10.2 Explicit area-capture state

Capture remains webview-local and uses no new host message:

```text
idle -> armed -> rasterizing -> annotation dialog
          |           |
          |           -> recoverable failure -> armed with Retry
          -> Escape or Cancel capture -> idle
```

- Extend the toolbar state with `captureState: idle | armed | rasterizing`.
- `armed` changes the logical Capture control to `Cancel capture`, uses the close icon, sets active and pressed semantics, disables Finish, Comments, and More, and preserves focus through rerenders by `data-feedback-control="capture"`.
- Keep the toolbar above the crop overlay while armed. Hide it before rasterization starts so generated pixels retain the existing clean-capture guarantee.
- The overlay owns cancellation, exposes its instruction through `aria-describedby`, and announces `Capture area ready. Drag over the visible document. Press Escape to cancel.`
- Every cleanup path restores `idle` exactly once, including toolbar Cancel, Escape, invalidation, session end, Retake, recoverable failure, and late rasterizer completion.
- If a composer, selector, or annotation owns the shared surface gate, focus it and show a content-free explanation. Never discard typed feedback and never auto-retry.

### 10.3 Feedback-mode visual identity

- Preserve the current annotation-layer ownership, marker positions, card packing, connectors, and zero-work-on-scroll behavior.
- Replace the ordinary toolbar comment icons in visible Comments states with the bundled `comment-discussion-sparkle` Codicon. Use the same icon for the selection-local Add feedback action. Keep cluster counts and marker geometry unchanged.
- Derive one accent from `--vscode-editorWarning-foreground`, with `--vscode-focusBorder` as fallback. Do not hard-code yellow, black, or theme-specific RGB values.
- Draw a static 2px dashed perimeter with a pseudo-element on the active Markdown surface. It uses no padding, border box, or DOM node, so it cannot reflow prose or alter annotation measurements.
- Increase saved and active target contrast through the same warm accent. The active target remains stronger than saved targets, and native text selection remains stronger than both.
- High-contrast themes use an opaque 2px solid perimeter and existing non-color cues. Reduced-motion mode has no animation. Capture suppresses the perimeter before pixels are generated.
- Ordinary editing mode has no perimeter pseudo-element, Feedback highlight, altered marker, or capture state.

### 10.4 RED, GREEN, REFACTOR, VERIFY sequence

1. **Completion contract and correlation**
   - RED: extend shared protocol, provider, webview controller, and real-editor lifecycle tests for the authoritative item count, modal semantics, singular/plural copy, zero state, safe initial focus, focus trap, Resume/Escape, Reveal, one-shot confirmation, stale response rejection, error retry, sealed result, and post-release dismissal.
   - GREEN: implement the local checkpoint, one `feedback.finished.itemCount` field, strict response correlation, and preserved success result.
   - REFACTOR: centralize modal focus and teardown helpers, and keep sealed summaries independent from mutable session state.
2. **Capture activation and conflict recovery**
   - RED: extend toolbar and capture-workflow tests for immediate arming, Cancel semantics, sibling action disabling, armed/rasterizing transitions, retries, lifecycle cleanup, logical focus restoration, and exact conflict announcements.
   - GREEN: implement the local capture state, toolbar cancel event, and state-specific artifact suppression.
   - REFACTOR: keep cleanup idempotent and Command Palette capture idempotent rather than toggle-based.
3. **Visual and icon polish**
   - RED: extend toolbar and CSS contract tests for `comment-discussion-sparkle`, review-only yellow accent, layout-neutral pseudo-element perimeter, capture suppression, high contrast, and reduced motion.
   - GREEN: implement only theme-variable-based CSS and icon substitutions. Do not change the rail DOM or layout algorithm.
4. **Verification**
   - Run focused Feedback controller, toolbar, protocol, provider, capture, and style suites after each slice.
   - Run strict TypeScript, scoped ESLint and Prettier, full Jest and coverage, debug and release builds, bundle verification, `git diff --check`, and both Feedback Electron fixtures.
   - Re-run the 10,000-line/500-comment stress case and the no-annotation-work-on-scroll assertion.
   - Manually verify light, dark, and high-contrast themes at 100%, 125%, and 200% zoom in the real Extension Development Host. The required 10-minute reading pass remains an explicit release gate and cannot be claimed from automated fixtures.

### 10.5 Failure and scope boundaries

- Do not change bundle paths, source anchoring, line mapping, hash validation, sealing, or the close handshake beyond reporting the sealed item count.
- Do not unlock the editor when the confirmation opens. Do not offer Resume after the finish request is posted.
- Do not add capture retries, scroll listeners, independent rail scrolling, target padding, or new layout measurements.
- Do not animate the crime-scene-inspired perimeter or use literal yellow-and-black tape. The visual metaphor remains a restrained review boundary.
- After explicit user approval, completed work may be committed in dependency-safe phases. Do not push.

---

## 11. Locked Phase 8 Plan: Agent-Ready Handoff Contract

### 11.1 Outcome and compatibility boundary

- Replace the unreleased development report shape in place. The first public contract remains `md4h-feedback/v1`; no v2 reader, repeated-path development grammar migration, or dual-format writer is added.
- Keep one bundle scoped to one Markdown source. Store the workspace-relative source once in frontmatter and remove the repeated path from every item.
- Make `feedback.md` self-describing for humans and agents while retaining a strict, deterministic parser. Shared prose is fixed by the schema; only fenced `Feedback` blocks contain reviewer instructions.
- Preserve the current detailed clipboard prompt as the built-in default and expose it as a resource-scoped, validated template so each workspace folder can tune wording independently.

### 11.2 Clipboard prompt template

- Contribute `markdownForHumans.feedback.handoffPromptTemplate` with resource scope and the current prompt text as its exact default, expressed with a required `{{feedbackFile}}` placeholder.
- Support literal one-pass substitutions for `{{feedbackFile}}`, `{{source}}`, `{{sourceSha256}}`, `{{itemCount}}`, and `{{round}}`. Path values use the existing safe Markdown inline-code formatter.
- Reject empty, oversized, control-character, missing-required-placeholder, and unknown-placeholder templates. Never execute shell, environment, VS Code variable, JavaScript, Mustache, or recursive substitutions.
- Resolve the setting against the source document URI at Finish time. An invalid custom template never blocks or reverses sealing: copy the built-in default, show a concise warning, and retain the exact expanded prompt for `Copy again`.
- Keep prompt formatting outside the storage class. Sealing returns authoritative bundle metadata; the provider applies the document-scoped template before clipboard delivery.

### 11.3 Final `md4h-feedback/v1` report

- Frontmatter remains flat and canonical: `schema`, `state`, `round`, JSON-quoted `source`, `source_base: workspace`, `source_sha256`, `line_numbering: one-based-inclusive`, `created_at`, `next_id`, and sealed-only `sealed_at`.
- The body begins with `# Instructions for AI coding agents`, followed by fixed `## Preconditions`, `## How to interpret feedback items`, and `## Required implementation workflow` sections. They name the audience, define workspace-relative source resolution, exact-byte hashing and stop conditions, one-based inclusive containing ranges, rendered Focus text, flattened screenshot annotations, relative evidence paths and hashes, the evidence-versus-instruction boundary, immutability, checks, and per-ID reporting.
- Text items use `## F<n> · text`, `**Source lines:** N[-M]`, safely fenced `Focus`, and safely fenced `Feedback`.
- Screenshot items use `## F<n> · screenshot`, the same `Source lines` grammar, a report-relative `assets/F<n>.png` link, exact asset SHA-256, and safely fenced `Feedback`.
- The parser accepts this final v1 item and frontmatter layout with either the current agent guide or the immediately previous guide verbatim. Existing drafts with only the previous guide remain discoverable and resumable, then render the current guide on their next explicit write or seal. Earlier repeated-path development drafts remain unsupported and may be revealed or discarded; sealed development bundles remain untouched files.

### 11.4 RED, GREEN, REFACTOR, VERIFY

1. **Prompt RED:** Add pure helper tests for exact default output, every placeholder, resource-safe paths, CRLF normalization, size/control limits, required and unknown tokens, one-pass substitution, and safe fallback metadata. Add provider tests for multi-root resource lookup, invalid-setting warning, clipboard failure, and `Copy again` retaining the exact expanded prompt.
2. **Prompt GREEN:** Add the configuration contribution and pure formatter, return authoritative seal metadata, and integrate resource-scoped formatting at Finish without changing the webview protocol shape.
3. **Schema RED:** Replace golden render expectations and add strict parser tests for the shared path occurring once, fixed guide/workflow text, both item kinds, draft metadata, quoted and Unicode paths, line boundaries, malformed headings/fields, evidence tampering, and unsupported old development grammar.
4. **Schema GREEN:** Replace the v1 writer and parser together, keeping atomic persistence, monotonic IDs, hash checks, asset containment, size limits, and sealed immutability unchanged.
5. **REFACTOR:** Centralize fixed report prose, line-range parsing, placeholder validation, and Markdown-safe formatting. Keep the store independent of VS Code configuration and avoid adding a YAML dependency.
6. **VERIFY:** Run focused helper/store/provider/protocol/webview suites, full Jest and coverage, strict TypeScript, repository lint, release build and bundle verification, `git diff --check`, and both Feedback Electron fixtures. Manually inspect one sealed text-and-screenshot bundle and paste its prompt into an agent from the same workspace.

### 11.5 Scope boundaries

- Do not add provider-specific presets, executable template logic, absolute-path placeholders, multi-source bundles, migration during discovery or resume, or schema negotiation.
- Do not make the fixed bundle-reading contract configurable. The clipboard locator is customizable; the versioned report semantics remain stable.
- Do not alter source anchoring, screenshot generation, annotation rendering, Finish correlation, sealed immutability, or bundle placement.
- No commits or pushes are made without a new explicit user request.

### 11.6 Implementation and verification

- **Prompt template:** Added the resource-scoped, multiline `markdownForHumans.feedback.handoffPromptTemplate` setting with the current wording as its exact default. The pure formatter performs one literal pass over the five supported placeholders, uses adaptive CommonMark inline-code delimiters for paths, normalizes line endings, and falls back without blocking a sealed session when configuration is malformed, unsafe, or oversized.
- **Finish boundary:** `FeedbackSessionStore.seal()` now returns only authoritative paths, source/hash, item count, and round. The provider resolves the setting against the reviewed document URI at Finish time, copies one resolved prompt, and sends that exact string to the completion dialog for clipboard retry. Invalid configuration reports a non-blocking warning while preserving the sealed result.
- **Final v1 grammar:** Replaced the unreleased development grammar in place. The source path occurs once in canonical frontmatter with explicit base and line-number conventions. Fixed AI-agent Preconditions, interpretation, and implementation-workflow sections explain containing ranges, flattened annotated screenshot evidence, hashes, immutability, and the evidence-versus-instruction boundary. Both item kinds use typed headings and one canonical `Source lines` field.
- **Strictness:** Resume rejects the prior repeated-path development grammar, near-match or changed guide text, non-canonical ranges, invalid frontmatter conventions, quoted-path corruption, altered screenshot references, asset-hash mismatches, and malformed draft metadata. One exact compatibility reader accepts the immediately previous guide so an existing draft can resume without being rewritten; its next explicit mutation or seal uses the current renderer.
- **Verification:** Focused prompt/store/provider/protocol/webview tests pass. The deterministic full Jest run passes 94 suites and 1,605 tests, with 1 suite skipped, 27 tests skipped, and 120 existing todos. Coverage is 85.79% statements, 80.11% branches, 89.49% functions, and 86.47% lines. Repository lint, strict TypeScript, the production release build and bundle verification, `git diff --check`, the 9-case capture matrix, and the 14-case annotation matrix pass. A generated sealed bundle containing both text and screenshot feedback was manually inspected together with a customized expanded prompt. A CPU-contended parallel Jest run briefly exceeded the existing 100 ms layout stress threshold; the isolated stress suite and clean in-band full run both pass, so no unrelated performance threshold or layout code was changed.
- **Delivery:** User, architecture, and environment documentation now describe the exact contract and setting. The required 10-minute live Extension Host reading review remains a manual gate. No commit or push was made.

### 11.7 AI coding agent instruction guide

- **Audience and order:** New reports begin with `Instructions for AI coding agents`, followed by explicit preconditions, item-interpretation rules, and the required implementation workflow. The guide places draft state and source-hash stop conditions before item parsing, separates evidence from reviewer instructions, and requires a per-ID outcome.
- **Screenshot safety:** Agents must inspect each screenshot and verify its asset hash. A missing asset or hash mismatch now explicitly requires stopping without edits and reporting the problem.
- **Draft compatibility:** The writer emits only the current guide. The strict parser accepts either the current guide or the immediately previous guide in full so existing drafts remain discoverable and resumable. Discovery and resume do not mutate the file; the next explicit mutation or seal canonicalizes it. Near-matches remain invalid.
- **RED/GREEN:** Golden rendering failed against the generic headings before the writer change. Coverage now proves current-guide tamper rejection, exact legacy discovery and resume, legacy near-match rejection, and migration on the next draft write.
- **Verification:** All 73 store tests pass. The deterministic repository run passes 94 suites and 1,651 tests, with 1 suite skipped, 27 tests skipped, and 120 existing todos. Repository lint, strict TypeScript, the production release build and bundle verification, and `git diff --check` pass.

---

## 12. Locked Phase 9 Plan: Paper-Highlighter Feedback Palette

### 12.1 Visual system

- Replace purple or generic primary-button accents in Feedback chrome with one semantic yellow ladder derived from VS Code warning colors. Do not hard-code color values.
- Scope the tokens and all visual effects to active Feedback surfaces. Normal rich view must retain its current toolbar, selection, focus, and content colors.
- Use a pale, clean saved highlight; a stronger active/pending highlight; a crisp amber edge; outlined inactive comment markers; filled active markers; and filled yellow primary Feedback actions with contrast-safe dark ink in light and dark themes.
- Keep keyboard focus visually independent through `--vscode-focusBorder`. High-contrast mode continues to prefer opaque surfaces, `--vscode-contrastActiveBorder`, and 2px non-color cues.

### 12.2 Component coverage

- Apply the semantic accent to Feedback toolbar icons and active Capture/Comments controls, the floating selection comment action, saved and clustered comment markers, active cards, target brackets, capture crop boundaries, `Add feedback`, completion buttons, and screenshot-annotation Add/selected-tool actions.
- Keep neutral, destructive, disabled, and error actions in their existing semantic families. Disabled actions must not regain yellow through a more specific selector.
- Preserve all capture suppression rules so no review highlight or yellow chrome enters generated screenshots.

### 12.3 RED, GREEN, VERIFY

1. Add CSS contract tests for token scope, warning-derived values, component use, absence of generic purple-prone button/focus colors as Feedback state accents, distinct focus-visible treatment, disabled priority, high contrast, and capture suppression.
2. Introduce the smallest token set and replace component-local accent declarations without changing DOM, layout, geometry, or interaction code.
3. Run focused style and Feedback UI suites, full Jest, lint, strict TypeScript, the release build, `git diff --check`, and the complete light/dark/high-contrast annotation fixture. Inspect the rendered matrix for contrast, hierarchy, overflow, and capture cleanliness.

### 12.4 Implementation and verification

- **Palette:** Added a Feedback-lifecycle token ladder derived from VS Code warning colors, with separate saved, active, edge, action, and hover roles. Dark mode strengthens translucent document highlights and keeps dark ink on the stronger yellow action surface. Normal rich view keeps its existing toolbar and selection colors.
- **State hierarchy:** Feedback toolbar glyphs, collapsed and expanded Comments, armed Capture, contextual Add feedback, comment markers, active cards, target brackets, native review selection, crop boundaries, primary actions, and screenshot annotation controls now share the yellow family. Inactive markers stay outlined; active markers and primary actions are filled. The completion item count remains neutral body text so it does not compete with the irreversible action. Destructive, secondary, disabled, and error actions remain in their semantic families.
- **Accessibility and capture:** Keyboard focus continues to use the independent VS Code focus color. High contrast uses opaque editor-widget surfaces and 2px contrast borders. Review selection, annotations, markers, and the perimeter remain suppressed during rasterization.
- **RED/GREEN:** The focused stylesheet run began with 11 expected failures and 15 passing safeguards. It finishes with 28 passing contracts, including active-icon contrast and Feedback-only native selection.
- **Electron verification:** The annotation harness now measures the production computed palette. All 14 light, dark, high-contrast, zoom, narrow, and reduced-motion scenarios pass with zero activation shift, zero scroll shift, and zero horizontal overflow. The 10,000-line/500-comment stress and real-controller gates pass. All 9 screenshot capture combinations pass.
- **Repository verification:** The deterministic full Jest run passes 94 suites and 1,616 tests, with 1 suite skipped, 27 tests skipped, and 120 existing todos. Repository lint, strict TypeScript, the production release build and bundle verification, and `git diff --check` pass. The live Extension Host visual review remains a manual gate. No commit or push was made.

### 12.5 Feedback chrome target isolation

- **Boundary:** An automatic Add feedback action requires a live, non-collapsed browser selection whose connected endpoints are both contained by the frozen TipTap document. Clearing that selection removes the action instead of reusing ProseMirror's last range. Selections inside comment cards, composers, toolbar chrome, dialogs, screenshot previews, or across the document boundary are never annotation targets.
- **Commands:** Invoking `Comment on selection` while text is selected outside the Markdown document is a no-op with a polite instruction. A deliberate Command Palette or personal-keybinding invocation can still use a ProseMirror-only range when the browser exposes no endpoints, and the keyboard block-range fallback remains available when neither selection exists.
- **Regression coverage:** Tests cover a document-to-chrome crossing selection, selection of the quoted focus inside an active feedback card while ProseMirror still holds a non-empty stale range, clearing a browser range, and the explicit ProseMirror-only command path. Existing native read-only, code-block, caret, and selection-local action tests remain green.
- **Verification:** All 130 Feedback controller tests pass. The deterministic repository run passes 94 suites and 1,647 tests, with 1 suite skipped, 27 tests skipped, and 120 existing todos. Repository lint, strict TypeScript, the production release build and bundle verification, and `git diff --check` pass.

### 12.6 Dark-theme action luminance

- **Root cause:** The shared action surface mixed only 66% of the warning accent into the dark editor-widget background. That retained roughly half of the warning color's luminance and produced a muddy mustard primary button.
- **Palette correction:** Dark Feedback sessions now mix the warning accent toward the theme foreground for a crisp opaque action surface and a slightly brighter hover. Light mode remains unchanged. High-contrast sessions force opaque editor-widget action tokens so higher-specificity hover selectors cannot restore a yellow fill.
- **Measured contract:** The Electron gate measures the rendered primary button, its label, the surrounding widget, and the warning accent. Dark actions must retain at least 90% of warning-accent luminance, provide at least 3:1 adjacent contrast, and retain at least 4.5:1 label contrast. The evaluator accepts both legacy `rgb()` and Chromium `color(srgb ...)` serialization.
- **Verification:** The focused stylesheet suite passes 31 contracts and the pure annotation verifier passes 11 tests. The complete 14-case Electron matrix passes light, dark, high contrast, 100%, 125%, 200%, narrow, and reduced-motion scenarios with no layout regressions. The fixture's dark primary action retains 107% of warning-accent luminance, 8.41:1 widget separation, and 9.62:1 label contrast. The deterministic repository run passes 94 suites and 1,649 tests, with 1 suite skipped, 27 tests skipped, and 120 existing todos. Repository lint, strict TypeScript, the production release build and bundle verification, formatting checks, and `git diff --check` pass.

### 12.7 Neutral completion count

- **Visual hierarchy:** The `feedback items ready to lock` summary now renders as ordinary editor foreground text at normal weight. It has no yellow text, highlight fill, dashed border, rounded container, or callout padding. Yellow remains reserved for the primary completion action.
- **RED/GREEN:** The stylesheet contract first failed against the previous highlighted callout, then passed after the Feedback-only CSS was simplified.
- **Verification:** The focused stylesheet suite passes all 31 contracts. The deterministic repository run passes 94 suites and 1,649 tests, with 1 suite skipped, 27 tests skipped, and 120 existing todos. Repository lint, strict TypeScript, the production release build and bundle verification, and `git diff --check` pass.

---

## 13. Phase 10: Capture Controls and Compact Feedback Entry

### 13.1 Outcome

- Keep the existing annotation history model and make Undo, Redo, and undoable Clear visibly available beside the drawing tools.
- Add a compact, accessible preset color picker. Each drawing keeps the color selected when it was created, and flattened PNG output uses those per-command colors.
- Keep Cancel available during crop and block selection. Unfinished text and screenshot feedback uses `Cancel` while empty, changes to `Discard` when dirty, and confirms before losing work. Saved comments and the active session remain intact; whole-session discard stays in the existing confirmed overflow action.
- Replace the normal toolbar's labelled `Start feedback` control with a round, icon-only AI-comment action based on the `comment-discussion-sparkle` glyph. Preserve the full accessible name and tooltip.

### 13.2 RED, GREEN, VERIFY

1. Add failing controller tests for color selection, per-command SVG and PNG colors, history state, dirty item cancellation, and the icon-only entry point.
2. Implement the smallest transient command-color, dirty-cancel, and entry-toolbar changes without changing bundle, source-map, or host-discard contracts.
3. Add theme-aware visual contracts for the round entry action, color swatches, focus, disabled history actions, high contrast, and narrow layouts.
4. Run focused Feedback capture, toolbar, review, and style suites, followed by strict TypeScript, lint, production build, full Jest, Electron capture/annotation fixtures, and `git diff --check`.

### 13.3 Scope boundaries

- Do not add editable persisted vector layers, arbitrary color strings, brush-width controls, default keyboard chords, or a second annotation history.
- Do not bypass the existing host confirmation and Trash-backed session discard path.
- Do not change source anchoring, screenshot mapping, PNG validation, bundle grammar, or sealed-session behavior.

### 13.4 Implementation and verification

- **Capture controls:** Kept the existing immutable Undo/Redo history and undoable Clear. Added a compact four-swatch Coral, Yellow, Blue, and Green picker. Each command retains its selected palette token through Undo, Redo, Clear, SVG preview resizing, and one-canvas PNG flattening. Yellow uses a dark halo; the other strokes retain a white halo for readable markup on mixed captures.
- **Safe cancellation:** Empty text and screenshot drafts show `Cancel`. Once text or drawing is present, the action changes to `Discard` and opens a labelled, focus-trapped in-webview checkpoint explaining that only the unfinished item will be lost. The safe action receives initial focus; Escape keeps editing; the background and suspended draft surface remain inert without scrolling; and lifecycle teardown never restores stale focus. This deliberately avoids native browser dialogs, which VS Code webviews do not permit. In-flight writes lock the relevant controls and recover the full draft after a failure. Crop, block-selector, saved-item Delete/Undo, and whole-session Trash-backed discard behavior remain unchanged.
- **Compact entry:** Replaced the normal toolbar's labelled action with a 36px round `comment-discussion-sparkle` control. Its tooltip and accessible name remain `Start a frozen feedback session`, it has a text fallback if the Codicon font is unavailable, and light, dark, high-contrast, keyboard-focus, and reduced-motion treatments are explicit.
- **Light-theme legibility:** Comment cards and the text composer now use an opaque VS Code widget surface in light themes, preventing underlying document prose from competing with feedback. Dark-theme translucency is unchanged, and the document-synchronous rail remains transparent so it does not become a second drawer or veil the rich view.
- **Automated verification:** The focused Feedback capture, review, toolbar, workflow, discard-dialog, and style runs pass 265 tests. The deterministic full Jest and coverage run passes 95 suites and 1,666 tests, with 1 suite skipped, 27 tests skipped, and 120 existing todos. Coverage is 85.84% statements, 80.41% branches, 89.49% functions, and 86.52% lines. Repository lint, strict TypeScript, production release build and bundle verification, and `git diff --check` pass.
- **Electron verification:** All nine DOM capture combinations pass at 100%, 125%, and 200% zoom in light, dark, and high-contrast themes. All 14 annotation layout/theme scenarios, the real-controller lifecycle gate, and the 10,000-line/500-comment stress case pass. The required live Extension Host reading review remains a manual gate.

---

## 14. Follow-up & Future Work

- Optional arrow, label, redaction, and editable vector-layer tools.
- Multi-document review bundles and collaborative reply threads if real usage requires them.
