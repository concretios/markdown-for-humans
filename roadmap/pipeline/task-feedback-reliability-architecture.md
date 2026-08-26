# Task: Feedback Reliability Architecture and Dependency Modernization

## 1. Task Metadata

- **Task name:** Feedback reliability architecture, VS Code compatibility, and dependency modernization
- **Slug:** `feedback-reliability-architecture`
- **Status:** in-progress
- **Created:** 2026-08-26
- **Last updated:** 2026-08-26
- **Shipped:** _(pending)_
- **Related plan:** `roadmap/pipeline/task-rich-view-feedback.md`
- **Primary feedback source:** `Feedback for feature Log Feedback for LLM.docx`

### Executive recommendation

Keep `CustomTextEditorProvider` and TipTap. Neither is the root cause of the reported failures.

The implementation now has the main safety foundations: a per-document edit coordinator, versioned renderer edit identities and acknowledgements, strict snapshot parity, acknowledged Feedback delivery for several critical stages, transactional renderer setup, typed table selection, a capture reducer, generation-bound peer locks and releases, and bounded renderer state restoration with hidden-context retention disabled.

The complete TipTap family is now exactly pinned at `3.30.3` and deduplicated through `@tiptap/pm@3.30.3`. Mermaid is installed at `11.17.2`, `image-size` and its redundant types are removed, and both production and full dependency audits currently report zero known vulnerabilities.

This plan remains in progress. Active-session ownership transfer is now a strict generation-bound apply/commit/abort transaction, but the pure host and renderer lifecycle reducers are not yet the production lifecycle authority and initial host prepare/commit activation is not complete. The analysis service and worker, bounded diagnostics store, draft-discovery caching, provider decomposition, packaged real-webview fault tests, memory profiling, physical Windows profiling, and manual reading review also remain open.

---

## 2. Context and Problem

### Current architecture

- `CustomTextEditorProvider` correctly uses VS Code's `TextDocument` as the document model.
- Each rich editor is a TipTap webview. A document can have multiple split webviews sharing one `TextDocument`.
- `MarkdownEditorProvider.ts` is currently about 9,500 lines. It now delegates edits, snapshots, transport retries, and minimal replacement calculation, but still owns most provider, lifecycle, persistence, image, split, and recovery behavior.
- `feedbackReview.ts` is currently about 4,500 lines. Transactional activation, selection mapping, capture state, and annotation work have been extracted, but the facade still owns substantial lifecycle, UI, mutation, and recovery behavior.
- Correctness-critical Feedback delivery is mixed. Start delivery, close/transition stages, peer-lock acquisition, two-phase peer release, and active ownership transfer have application acknowledgements and bounded retries. A few presentation and compatibility paths remain raw messages.
- The 500 ms document-sync debounce now defers Markdown serialization itself. The renderer tracks dirty revisions, serializes once at a send boundary, and retains dirty state across serialization or send failures.
- Renderer edits carry protocol version, edit ID, view generation, local revision, base document version, and application ACK state. Teardown can pipeline one final dependent revision before a non-retained webview is destroyed.
- The package manifest and build policy now agree on VS Code `^1.98.0`, exact `@types/vscode@1.98.0`, Node 20 declarations, a Node 20 extension target, and a Chromium 132 webview target.
- Every direct TipTap dependency is exactly `3.30.3`, including the directly imported paragraph extension. `npm ls` currently shows one deduplicated TipTap/ProseMirror graph through `@tiptap/pm@3.30.3`.

### Reported symptoms and verified failure classes

| Feedback symptom                                                       | Verified failure class                                                                                                                                               | Architecture treatment                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Start remains on a solid border and the editor stays read-only         | `feedback.started` is not acknowledged; renderer activation mutates state and UI non-transactionally; recovery depends on timers                                     | Versioned transport, renderer prepare/commit transaction, rollback, and authoritative status query             |
| Capture cannot begin or complete near document margins                 | Cached bounds, incomplete pointer terminal handling, and contradictory overlay/toolbar ownership                                                                     | Explicit capture reducer, live viewport geometry, one modal surface, and complete pointer cleanup              |
| A 4 by 4 table selection has no working comment action                 | A valid ProseMirror `CellSelection` is treated like a collapsed native caret or mapped to `null`                                                                     | Typed cell targets using `@tiptap/pm/tables`, event coalescing, and diagnostic failure reasons                 |
| Start can remain frozen after screenshot work                          | The same lifecycle delivery and partial activation defect is amplified by capture cleanup and pending mutation state                                                 | One lifecycle coordinator and idempotent transition reconciliation                                             |
| Automatic selection action sometimes does not appear                   | Native `selectionchange` and ProseMirror `selectionUpdate` race; a transient collapsed native selection clears a valid structural selection                          | One animation-frame selection sample with ProseMirror authority for structural selections                      |
| Feedback starts against stale content after an external or disk change | Blocks are enumerated before final convergence, disk and editor snapshots are not one atomic identity, and anchor validation checks shape more strongly than content | Versioned snapshot service, saved-byte and renderer parity, content fingerprints, and fail-closed invalidation |

### Confirmed performance and memory risks

- Per-transaction serialization has been removed from the typing hot path and is covered by a deterministic 10,000-transaction operation-count harness.
- Full-document structural equivalence can parse both current and incoming Markdown on the extension-host event loop.
- Document writes now pass through a serial coordinator. Documents at or above 32 KiB use a tested common-prefix/suffix replacement instead of an unconditional full replacement.
- Snapshot inspection detects divergent dirty splits by identity and content rather than choosing a last response, but some lifecycle operations still contain large provider-side sequences on the extension-host event loop.
- Capture now discovers and clones only intersecting top-level blocks and, within a large table or nested list, only intersecting rows, cells, and list items. Fixed geometry spacers preserve crop coordinates and ordered-list numbering. Complex row-span tables fail closed to the existing bounded path rather than risking a structurally invalid clone.
- Annotation layout has deterministic indexed-operation coverage for 500 items. A general Markdown analysis cache and worker boundary do not yet exist.
- Draft discovery parses bounded report metadata and validates contained screenshot file identity and quotas, but defers PNG reads and SHA-256 verification until explicit Resume. Discovery results are not yet cached.
- `retainContextWhenHidden` is now `false`, and only bounded selection and scroll state is persisted. Heap behavior across repeated long-document hide, restore, and close cycles has not been profiled.
- `MarkdownEditorProvider.ts` and `feedbackReview.ts` remain too large to make all lifecycle invariants obvious or independently testable.

### Test gap

The repository now has strong Jest coverage, deterministic performance fixtures, purpose-built Electron capture and annotation fixtures, and an official VS Code Extension Development Host smoke suite. CI is configured for Ubuntu and Windows, VS Code 1.98 and stable. The real-host suite proves activation, command registration, custom-editor opening, split survival, workspace edit/save, close, and reopen. It does not install the generated VSIX or drive the actual webview message listener, dropped ACKs, hidden renderer teardown, Feedback activation, capture, or lifecycle fault injection. Those packaged real-webview integration cases remain open, as does macOS coverage.

---

## 3. VS Code Platform Constraints

These are design constraints, not optional implementation preferences.

| Constraint                                                                                                 | Consequence for this extension                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `CustomTextEditorProvider` has one `TextDocument` per resource but can have multiple webviews for splits | The resource needs one coordinator with N disposable view replicas. `supportsMultipleEditorsPerDocument: false` must not be treated as a split-prevention guarantee for a custom text editor.            |
| `TextDocument` is the model for save, dirty state, undo, redo, revert, and hot exit                        | Keep `CustomTextEditorProvider`. Do not switch to `CustomEditorProvider`. All content changes continue through standard text-editing APIs.                                                               |
| `Webview.postMessage()` returning `true` does not mean the listener received or applied the message        | Every correctness-critical message needs an application ACK, deduplication, bounded replay, and status reconciliation.                                                                                   |
| Hidden webview behavior is not a safe correctness dependency                                               | Hidden views do not block a transition. The host persists desired state and resynchronizes a view when it sends `view.ready`.                                                                            |
| `retainContextWhenHidden` has high memory overhead; `getState` and `setState` are preferred                | Implement state restoration, then measure and remove retention. Store only small view state, never authoritative document state.                                                                         |
| Other editors, extensions, undo/revert, and external changes can still change the shared document          | Webview read-only mode is cooperative, not a global document lock. Every asynchronous result must validate `TextDocument.version`.                                                                       |
| The Node extension host is a shared event loop                                                             | Full Markdown parsing, hashing, file discovery, or synchronous image probing must not monopolize the host. Pure analysis should be cached, cancelable, and moved to a worker when it exceeds the budget. |
| VS Code recommends minimal workspace edits                                                                 | Introduce a serial queue first, then replace full-document writes with a tested minimal replacement range.                                                                                               |
| Local, remote, and web extension hosts are distinct                                                        | This remains a Node desktop/workspace extension. Declare and test its intended workspace location. Do not imply vscode.dev support without a `browser` entry and URI-first file APIs.                    |
| `engines.vscode` defines the minimum available VS Code API and bundled runtime                             | Pin `@types/vscode` to the chosen minimum. Test that minimum and current stable. A package-level Node engine cannot upgrade VS Code's embedded Node runtime.                                             |

Official references:

- [Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [Webview API and persistence](https://code.visualstudio.com/api/extension-guides/webview)
- [Webview.postMessage contract](https://code.visualstudio.com/api/references/vscode-api#Webview.postMessage)
- [Efficient webview typed-array transfer for VS Code 1.57+](https://code.visualstudio.com/updates/v1_57#_improved-webview-array-buffer-transfers)
- [TextDocument API](https://code.visualstudio.com/api/references/vscode-api#TextDocument)
- [Extension host locations](https://code.visualstudio.com/api/advanced-topics/extension-host)
- [Remote extension architecture](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
- [Extension-host high CPU guidance](https://github.com/microsoft/vscode/wiki/Explain-extension-causes-high-cpu-load)
- [Extension compatibility](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#visual-studio-code-compatibility)
- [Official Extension Host testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [Extension CI guidance](https://code.visualstudio.com/api/working-with-extensions/continuous-integration)

---

## 4. Desired Outcome and Scope

### Success criteria

- A Feedback Start ends in `Active`, an editable recoverable state, or a clearly resumable draft. It never remains indefinitely in a local `starting` state.
- Dropped, rejected, delayed, duplicated, and reordered critical messages are covered by deterministic tests.
- A renderer exception during activation leaves no session class, read-only flag, plugin, observer, toolbar, rail, or pending request behind.
- The host marks a session active only after the renderer acknowledges the committed activation epoch.
- Every snapshot records and validates one document version, text digest, saved-byte digest, renderer generation, and canonical descriptor revision.
- A same-shape but different-content document fails snapshot or anchor validation.
- Divergent dirty split content fails visibly. The host never chooses owner-last or peer-last precedence by accident.
- A rectangular table `CellSelection`, including a 4 by 4 selection, always produces a typed target or a visible reason it cannot be represented.
- Capture always reaches a terminal state after `pointerup`, `pointercancel`, `lostpointercapture`, blur, visibility loss, Escape, disposal, or raster failure.
- Typing does not perform full Markdown serialization on each transaction. On the reference Windows i5/16 GB machine, p95 keystroke handling stays below 16 ms for the agreed 10,000-line fixture.
- Cursor, formatting, selection, and pointer-move work stay below 50 ms, with pointer-move work targeted below one 16 ms frame.
- Feedback Start shows stage feedback within 300 ms. A 3,000-word document should normally activate in under 1 second; the 10,000-line stress fixture should stay below 3 seconds on the reference machine or show continuing progress and cancellation without guessing that the operation failed.
- Hidden webviews do not retain authoritative state and do not block any operation. If retention is removed, reopening restores scroll, selection, and Feedback UI correctly.
- Real VS Code integration tests run on Windows and at least one Unix platform, against both the minimum supported VS Code and current stable.
- The complete unit, real-editor, Electron, Extension Host, lint, build, package, and manual reading checks pass.

### In scope

- Per-document coordination for edits, snapshots, Feedback lifecycle, and split replicas.
- Versioned and acknowledged lifecycle transport.
- Transactional renderer activation and deterministic recovery.
- Atomic document and saved-source snapshots.
- Typed text, block, and table-cell Feedback targets.
- Complete capture pointer lifecycle and bounded capture work.
- Serialization, parsing, lookup, draft-discovery, and hidden-webview performance.
- VS Code runtime/API compatibility policy and real Extension Host tests.
- A controlled TipTap 3.30.3 upgrade and use of relevant stable improvements.
- Targeted dependency security and maintenance upgrades.
- Modular extraction from the two oversized files while preserving public behavior.

### Out of scope

- Replacing TipTap or `CustomTextEditorProvider`.
- Using VS Code's Comments API as the primary TipTap comment UI. It does not render comment threads inside an extension-owned webview DOM.
- Using VS Code's experimental hybrid Markdown editor as a reusable editor component. It is not a public embeddable surface.
- Collaborative multi-user editing or CRDT support.
- Virtual scrolling. It would change DOM-to-source mapping, selection, capture, and reading behavior and is not justified before the measured hot paths are fixed.
- A TypeScript 7, ESLint 10, lowlight 3, markdown-it 15, or KaTeX 0.18 migration in the same work.
- A web-extension entry point for vscode.dev.
- Changing the sealed Feedback bundle format unless a separately versioned migration is required. Existing sealed bundles remain readable and immutable.
- External telemetry collection. Diagnostics remain local and content-free unless a separate privacy-reviewed feature is approved.

---

## 5. UX and Behavior

### Flow 1: Start Feedback

1. The user selects **Start Feedback**.
2. The action responds immediately and shows the current stage, such as `Preparing`, `Synchronizing`, `Saving`, or `Starting review`.
3. The host creates one operation for the document and reconciles all live view generations through the document edit queue.
4. A short quiesce stage prevents new rich-view mutations while the final snapshot is fixed. The UI remains cancelable and status-driven.
5. The host saves and verifies the exact snapshot, then asks the owner renderer to apply the authoritative content and describe its canonical blocks.
6. The renderer prepares Feedback UI transactionally without exposing a partial active state.
7. The host commits the activation epoch. The renderer reveals the active UI and acknowledges it.
8. The host marks the session active and broadcasts authoritative state to peers.

### Flow 2: Lost or delayed activation message

1. The renderer does not receive or acknowledge a critical stage message.
2. The transport retries the same idempotent message with the same message and operation identity.
3. If the ACK remains absent, the renderer or host requests authoritative status.
4. The current stage is restored from host state. No local timer unlocks or invents a result.
5. If the owner disappeared, the host either transfers a resumable draft to a live view or restores all views to editable state.

### Flow 3: Two dirty split views

1. Both splits report their view generation, base document version, local revision, dirty state, and content hash.
2. If their unsynchronized content is identical, the queue accepts it once.
3. If their unsynchronized content differs, Start stops before creating an active session.
4. The user sees a concise conflict message and both views receive the authoritative `TextDocument` state.
5. No split wins because it replied last.

### Flow 4: Table-cell feedback

1. The user drag-selects a rectangular set of table cells.
2. ProseMirror `CellSelection` and `TableMap` produce a stable rectangular target.
3. The action appears near the visible selection and remains through transient native selection events.
4. Feedback stores the containing table source-line anchor plus draft-only cell coordinates and a table fingerprint.
5. If merged or irregular cells cannot be represented honestly in Markdown, the action falls back to the table block or explains the limitation.

### Flow 5: Capture area

1. The user enters capture mode. A single modal capture root owns the hit surface and a minimal command strip with Cancel.
2. The current editor viewport is measured immediately and kept current through resize and visual viewport changes.
3. One pointer ID owns the drag.
4. Every terminal event cleans up pointer capture, overlay state, listeners, observers, and abort tokens.
5. Rasterization prunes non-intersecting rows, cells, and resources. Large captures either complete within the tested ceiling or fail with a specific message.

### Behavior rules

- A fixed timeout can request status or offer cancellation. It cannot decide that content is safe, unlock a document, or roll back a committed epoch.
- Hidden or disposed views never block a lifecycle operation.
- Every reloaded renderer receives a full authoritative state after `view.ready`.
- A live external `TextDocument` change invalidates work computed for an older version.
- Feedback mutations remain disabled until the renderer and host agree on the same active epoch.
- Durable drafts survive an activation failure. Rollback never deletes user evidence.
- Diagnostics are copyable even when activation never completed.
- All errors use stable codes plus a user-facing action: retry, resume, reload, reveal draft, or cancel.

---

## 6. Target Architecture

### Component model

```text
                         VS Code TextDocument
                                  |
                    DocumentCoordinatorRegistry
                                  |
                    DocumentCoordinator (per URI)
              +-------------------+-------------------+
              |                   |                   |
   DocumentEditCoordinator  FeedbackLifecycle   Panel/View Registry
              |              Coordinator               |
              |          +--------+--------+       View replicas
              |          |        |        |      A, B, hidden,
              |      Snapshot  Transport  Store       reloaded
              |       Service      |                    |
              +----------+---------+--------------------+
                         VS Code adapter
                  MarkdownEditorProvider.ts
                                  |
                       versioned messages + ACKs
                                  |
                     Webview DocumentSyncController
                                  |
                  FeedbackLifecycleMachine (pure)
                     +------------+------------+
                     |            |            |
                Activation    Selection      Capture
                Controller    Controller     Workflow
                     |            |            |
                     +-------- Feedback chrome +--------+
                                  |
                              TipTap editor
```

### Source-of-truth rules

| State                                         | Authority                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Editable Markdown                             | VS Code `TextDocument`                                                                 |
| Saved source bytes                            | Bytes read after a successful `document.save()` for the same verified document version |
| Accepted rich-view writes                     | Per-document edit queue                                                                |
| Feedback lifecycle and owner epoch            | Extension-host lifecycle coordinator                                                   |
| Durable draft and sealed bundle               | Existing Feedback session store                                                        |
| Desired state of every split                  | Extension-host coordinator                                                             |
| Ephemeral scroll, selection, and UI expansion | Individual webview state via `setState`                                                |
| Structural table selection                    | ProseMirror selection state                                                            |
| Browser text selection geometry               | Native `Range`, only when its endpoints are inside the editor                          |
| Capture pointer ownership                     | Webview capture state machine                                                          |

### Required invariants

1. At most one document edit is applied at a time for a document URI.
2. At most one Feedback lifecycle operation owns a document at a time.
3. Every accepted edit has an operation identity, base version, view generation, and local revision.
4. Results computed for an obsolete document version are discarded.
5. No renderer is considered active until it acknowledges the committed activation epoch.
6. No renderer becomes editable while the host still owns a transition or active-session lock.
7. A committed activation epoch is never ambiguously rolled back. It is retransmitted or reconciled.
8. A failed pre-commit activation is completely rolled back and leaves a resumable draft when persistence already occurred.
9. Hidden, suspended, missing, and disposed webviews never block host progress.
10. Every renderer generation begins with `view.ready` and a full authoritative status response.
11. Snapshot content, canonical blocks, anchors, and saved bytes all identify the same versioned source.
12. Divergent split content fails closed.
13. User text, selected text, image data, absolute paths, and feedback prose never enter diagnostics.

### Module map and current status

#### Shared contracts

- `src/shared/documentSyncProtocol.ts`
  - **Implemented:** versioned edits, dependent teardown edits, ready handshake, host flush barrier, edit ACK, and generation-bound flush ACK contracts.
- `src/shared/feedbackDeliveryProtocol.ts`
  - **Implemented:** strict `feedback.started` delivery, application ACK, and authoritative status-query contracts.
- `src/shared/feedbackSnapshotProtocol.ts`
  - **Implemented:** strict split inspection and authoritative snapshot apply/report contracts.
- `src/shared/pendingImageProtocol.ts`
  - **Implemented:** compact pending-image destinations plus versioned, renderer-generation-bound completion and application-ACK contracts. Typed-array payloads remain binary across the webview bridge.
- `src/shared/feedbackProtocol.ts`
  - **Partly implemented:** strict Feedback schemas now include typed table-cell targets, renderer generation data, peer-lock acquisition, two-phase peer release, and apply/commit/abort active ownership transfer. One uniform envelope remains open.
- `src/shared/feedbackDiagnostics.ts`
  - **Planned:** stable stage, event, timing, and error-code types with content-free validation.

#### Extension host

- `src/editor/documentEditCoordinator.ts`
  - **Implemented and integrated:** serial queue per document, same-lineage pending typing coalescing, barriers, cancellation, and failure containment. Provider integration adds base-version checks and edit acknowledgements.
- `src/editor/feedbackLifecycleCoordinator.ts`
  - **Partly implemented as `feedbackLifecycleMachine.ts`:** pure host transitions exist and are unit tested, but production still uses provider-owned lifecycle state and maps.
- `src/editor/feedbackSnapshotService.ts`
  - **Implemented and integrated:** binds document text, saved bytes, document version, renderer generation and revision, split reports, canonical descriptors, content fingerprints, and anchor-map construction.
- `src/editor/feedbackTransport.ts`
  - **Implemented and integrated for selected stages:** bounds unresolved sender promises, checks post results, waits for application ACKs, retries exact idempotent messages, rejects stale identities, and can query authoritative status. It is not yet the only lifecycle delivery path.
- `src/editor/markdownAnalysisService.ts`
  - **Planned:** cache and cancellation boundary for Markdown equivalence, block analysis, and anchor construction.
- `src/editor/workers/markdownAnalysisWorker.ts`
  - **Planned:** worker implementation for pure CPU work that exceeds event-loop budgets.
- `src/editor/feedbackDiagnosticsStore.ts`
  - **Planned:** bounded per-document ring buffer available before and after activation.
- `src/editor/MarkdownEditorProvider.ts`
  - **Still in migration:** integrates the new edit, snapshot, transport, peer-lock, peer-release, image, and minimal-edit boundaries, but remains the primary lifecycle and persistence implementation.
- `src/editor/minimalTextEdit.ts`
  - **Implemented and integrated:** safe common-prefix/suffix replacement with CRLF and surrogate-pair boundary protection.

#### Webview

- `src/webview/documentSyncController.ts`
  - **Implemented and integrated:** marks revisions dirty, serializes once after debounce, retains failures for explicit retry, supports urgent and teardown boundaries, and tracks exact edit ACKs and accepted host versions.
- `src/webview/features/feedbackLifecycleMachine.ts`
  - **Implemented but not the production authority:** the pure renderer reducer has deterministic tests, while the facade still owns production lifecycle state.
- `src/webview/features/feedbackActivationController.ts`
  - **Implemented and integrated for renderer-local setup:** provisional setup, reverse cleanup, commit, rollback, recovery, and disposal. A distinct host-driven prepare/commit protocol is still open.
- `src/webview/features/feedbackSelectionController.ts`
  - **Implemented as selection sampling in `feedbackReview.ts` plus `feedbackSelectionMapping.ts`:** one animation-frame sample, typed text/block/cell mapping, action placement, and explicit fallback reasons.
- `src/webview/features/feedbackReviewChrome.ts`
  - **Planned extraction:** toolbar, frame, cards, composer, focus, and accessible alerts remain mostly in `feedbackReview.ts`.
- `src/webview/features/feedbackCaptureWorkflow.ts`
  - **Implemented behind `feedbackCaptureMachine.ts`:** pointer ownership, terminal-event cleanup, viewport generations, abortable raster phases, bounded top-level DOM capture, and visible retry errors.
- `src/webview/features/feedbackPeerLockClient.ts` and `feedbackPeerReleaseClient.ts`
  - **Implemented and integrated:** renderer-generation-bound lock acquisition and content-bearing apply/commit release with idempotent ACK replay.
- `src/webview/features/feedbackSnapshotClient.ts`
  - **Implemented and integrated:** strict split inspection and authoritative content apply before canonical block enumeration.
- `src/webview/utils/richViewState.ts`
  - **Implemented and integrated:** bounded selection and scroll restoration without storing document or Feedback authority in webview state.
- `src/webview/features/feedbackReview.ts`
  - **Still in migration:** remains the compatibility facade and has not yet shrunk to composition and message routing.

File names are proposed boundaries. Implementation may adjust a name to match nearby conventions, but must preserve the responsibility split.

### Host lifecycle state machine

```text
Idle
  -> Preparing
  -> Quiescing
  -> Reconciling
  -> Saving
  -> Describing
  -> PreparingActivation
  -> CommittingActivation
  -> Active
  -> Closing
  -> Restoring
  -> Idle

Any pre-commit failure
  -> Recovering
  -> Idle or DraftAvailable
```

### Renderer lifecycle state machine

```text
Editing
  -> StartRequested
  -> Quiesced
  -> ApplyingSnapshot
  -> PreparingReview
  -> CommittingReview
  -> Reviewing
  -> Closing
  -> ApplyingRecovery
  -> Editing or DraftAvailable
```

### Activation protocol

1. The owner posts `feedback.activation.request` with its view generation and latest local revision.
2. The host allocates a unique operation and serializes it behind the document coordinator.
3. Every live view receives `document.quiesce`. Each replies with base document version, local revision, dirty state, content hash, and Markdown only when required.
4. The edit coordinator rejects stale writes, detects divergent dirty splits, applies accepted content in order, and drains through a barrier.
5. The snapshot service saves, rereads source bytes, and captures one immutable snapshot identity.
6. The owner receives `document.snapshot.apply`, applies the authoritative text, and replies with applied text hash plus canonical block descriptors for that renderer generation.
7. The snapshot service verifies block fingerprints against the same source and builds the exact anchor map.
8. The host creates or opens a durable provisional draft.
9. The host sends `feedback.activation.prepare`.
10. The renderer builds read-only enforcement, plugins, observers, annotations, capture integration, and review chrome behind a rollback stack. It remains visually provisional.
11. The renderer replies `feedback.activation.prepared` or `feedback.activation.failed`.
12. The host sends monotonic `feedback.activation.commit`.
13. The renderer atomically reveals the review UI and replies `feedback.activation.committed`.
14. Only then does the host publish `Active` and broadcast desired state to peers.

### Protocol envelope

Every critical message must carry the identities needed to reject stale work:

```ts
interface ProtocolEnvelope<TPayload> {
  protocolVersion: 2;
  messageId: string;
  operationId: string;
  requestId: string;
  viewId: string;
  viewGeneration: string;
  documentVersion: number;
  sessionEpoch?: string;
  stageRevision: number;
  payload: TPayload;
}
```

Rules:

- The same `messageId` always means the same idempotent command and result.
- Duplicate commands return the previous ACK or result.
- An ACK means the receiver validated and applied the stage, not just that transport queued it.
- Bounded retry is allowed only for idempotent messages.
- After retry exhaustion, query status. Do not guess failure or success.
- A new webview initialization gets a new `viewGeneration`; messages for older generations are ignored.
- Protocol parsing stays strict at both boundaries.
- Large binary payloads use the efficient typed-array transfer available to extensions targeting VS Code 1.57 and newer. The renderer must not expand bytes into a JavaScript number array, and existing size limits remain enforced.

### Document edit coordinator

- Queue all extension-initiated edits for a document, including typing, save-policy enforcement, Feedback flushes, recovery, and any sibling-view synchronization that writes content.
- Coalesce only not-yet-started typing edits from the same view generation and base lineage.
- Never coalesce across a save, quiesce, Feedback, undo, external-change, or explicit flush barrier.
- Return an ACK containing accepted edit ID and resulting `TextDocument.version`.
- Abort or reconcile if the document changed outside the expected queue lineage.
- Keep the existing full replacement during the queue extraction to minimize behavior changes.
- In a later isolated slice, compute one minimal replacement using common prefix/suffix boundaries. Test CRLF, surrogate pairs, combining characters, frontmatter, empty files, undo grouping, and selection preservation.
- Do not rely on ordering across independent `workspace.applyEdit` calls. The coordinator creates that order.

### Snapshot service

The snapshot identity must include:

- document URI identity
- operation ID
- `TextDocument.version`
- normalized text SHA-256
- saved raw-byte SHA-256
- source byte count
- renderer view generation
- canonical descriptor revision
- block count and content fingerprints

Required sequence:

1. Drain accepted view edits.
2. Capture text and document version.
3. Save and require a successful result.
4. Confirm the document version has not changed unexpectedly.
5. Read saved bytes through the workspace-aware file boundary.
6. Bind both text and raw-byte digests to the operation.
7. Apply the exact authoritative text to the owner renderer.
8. Enumerate canonical blocks only after that apply ACK.
9. Compare normalized semantic fingerprints, with strict handling for code, frontmatter, raw HTML, and table cells.
10. Build anchors or fail closed.

For resume, perform the same source and renderer parity checks. Never accept block count, order, and kind as sufficient proof by themselves.

### Typed selection targets

```ts
type FeedbackSelectionTarget =
  | {
      kind: 'text';
      blockRange: { fromOrdinal: number; toOrdinal: number };
      renderedRange: FeedbackRenderedRange;
      focusText: string;
    }
  | {
      kind: 'cells';
      tableOrdinal: number;
      rectangle: { top: number; left: number; bottom: number; right: number };
      tableFingerprint: string;
      blockRange: { fromOrdinal: number; toOrdinal: number };
      focusText: string;
    }
  | {
      kind: 'blocks';
      blockRange: { fromOrdinal: number; toOrdinal: number };
      focusText: string;
    };
```

Selection rules:

- Import `CellSelection` and `TableMap` from `@tiptap/pm/tables`. Do not add another ProseMirror instance.
- ProseMirror is authoritative for structural selections.
- Native `Range` is authoritative only for browser text selection geometry inside the editor.
- Coalesce ProseMirror and native events into one animation-frame sample.
- Keep a valid action through one transient collapsed native event. Clear it only when focus leaves, selection identity changes, or the target becomes invalid.
- Return a typed diagnostic reason instead of silent `null`.
- Persist source lines for the containing table. Cell coordinates are draft metadata unless exact Markdown row mapping is proven.

### Capture state machine

```text
Idle
  -> Armed
  -> Dragging(pointerId)
  -> Rasterizing(captureId)
  -> Annotating
  -> Submitting
  -> Idle
```

Required behavior:

- Track exactly one active pointer ID.
- Handle `pointerup`, `pointercancel`, `lostpointercapture`, window blur, visibility loss, Escape, and disposal.
- Release pointer capture and every listener/observer in all terminal paths.
- Recompute viewport bounds through `ResizeObserver`, `visualViewport`, resize, scroll-container changes, and immediately before rasterization.
- Use one modal root for the hit surface and a minimal capture command strip. Ordinary review controls are hidden or inert while capture owns interaction.
- Clamp edge coordinates or show a boundary error. Never silently remain armed.
- Add abort checks between clone, resource, raster, encode, and submit stages.
- Prune non-intersecting table/list subtrees and wait only for intersecting resources.
- Enforce a tested complexity ceiling with a visible recovery action.

### Diagnostics

Keep a bounded, local, content-free event stream containing:

- operation, message, session, view, and generation identifiers
- lifecycle stage and stage revision
- document and local view revisions
- digest prefixes only
- document byte/line/block counts and Feedback item count
- queue, save, analysis, post, ACK, retry, activation, and recovery timings
- anchor result and stable failure code
- selection kind or mapping failure reason
- pointer terminal event and capture stage counts/timings
- platform, architecture, VS Code version, extension version, TipTap version, zoom, and device pixel ratio

Never record source text, selection text, Feedback text, screenshots, absolute paths, or image bytes. Add **Copy Feedback Diagnostics** before activation so a failed Start is diagnosable.

### Extension location and resource security

- Add and test `extensionKind: ["workspace"]` if the runtime/API audit confirms workspace-host behavior for all supported features.
- Migrate Feedback storage and document-adjacent file access toward URI-first `vscode.workspace.fs` boundaries.
- Explicitly decide support for remote and virtual workspaces. Until proven, declare unsupported environments rather than failing halfway through Start.
- Remove `engines.node` as evidence of extension-host capability. Express development Node requirements through CI and a development-version file or `packageManager` metadata.
- Narrow `localResourceRoots`. Do not grant the parent of the workspace by default merely to support arbitrary sibling paths. Resolve and authorize required image locations explicitly.
- Keep nonce-based scripts and strict message parsing. Review whether broad `https:`, `data:`, and `blob:` image sources are all required.
- Honor `resolveCustomTextEditor` cancellation and dispose all panel-scoped resources.

---

## 7. Performance Architecture

### Webview hot path

- `onUpdate` increments an editor-local revision and marks the serializer dirty.
- Schedule serialization, not an already-computed string, behind the 500 ms debounce.
- Cache one serialized Markdown value per TipTap transaction generation.
- An urgent quiesce or save consumes the cached value or runs one single-flight serialization.
- Cancel or discard superseded outline and auxiliary work.
- Instrument transaction handler time separately from eventual serialization time.

### Extension-host hot path

- Cache Markdown equivalence and block analysis by text digest plus `TextDocument.version`.
- Build ordinal, item, and anchor indexes once. Avoid `items x blocks` scans.
- Restored Feedback line endpoints now use two lower-bound searches over the frozen anchor spans; the 10,000-block regression gate permits at most 64 indexed reads.
- Make draft discovery metadata-first. Validate screenshot bytes lazily when a draft is opened, sealed, or explicitly verified.
- Keep file IO asynchronous and bounded.
- Put Markdown analysis behind `MarkdownAnalysisService`. If inline p95 exceeds 50 ms or creates an event-loop stall above 50 ms on the stress fixture, use the worker entry point by default.
- Worker input is immutable `{ operationId, version, digest, text }`. Stale or canceled results are ignored.
- Bundle the worker as an explicit extension build entry and verify it is included in the VSIX and works in the remote workspace extension host.

### Rendering and capture

- Index annotation targets and update only changed ranges.
- Keep existing pure geometry modules and test their layout-read counts.
- Prune cloned capture DOM to the crop neighborhood before deep cloning expensive tables and lists.
- Load and wait for only intersecting images, fonts, diagrams, and math.
- Evaluate Tiptap 3.30's manual and changed-range Decorations API only after behavior parity. It is a separate spike, not part of the version bump.

### Memory

- A generation-bound ready handshake and host resynchronization are implemented for document state and active Feedback restoration.
- `setState` currently persists only bounded document version, selection, and scroll data. It does not persist document or Feedback authority.
- `retainContextWhenHidden` is now `false`.
- Benchmark the non-retained path with several long documents and splits on the reference machine.
- Require `editor.destroy()`, plugin cleanup, observer cleanup, pending promise rejection, and listener disposal for every renderer generation.
- Record heap snapshots before/after repeatedly opening, hiding, restoring, and closing long documents.

---

## 8. Dependency Modernization Plan

Versions were checked on 2026-08-26. Recheck before implementation and update this table if a security release supersedes the target.

| Package group                 |                                         Installed | Target or decision                                    | Reason and gate                                                                                                          |
| ----------------------------- | ------------------------------------------------: | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Tiptap family                 |                                    Exact `3.30.3` | Keep the complete family exactly synchronized         | Upgrade is complete and the graph is deduplicated. The full compatibility corpus and manual reading gate remain open.    |
| ProseMirror                   |                  Through `@tiptap/pm@3.30.3` only | Keep upgrades through `@tiptap/pm`                    | `npm ls` currently shows one model, state, view, and tables graph. Production has no direct `prosemirror-*` imports.     |
| `@tiptap/extension-paragraph` |                             Exact direct `3.30.3` | Keep declared directly                                | Production imports it directly.                                                                                          |
| `@tiptap/markdown` parser     |                `3.30.3` with transitive Marked 17 | Keep; preserve the narrow Jest transform              | The harness transforms Marked's single ESM runtime entry instead of forcing an unsupported downgrade.                    |
| `modern-screenshot`           |                                           `4.7.0` | Keep                                                  | Pointer lifecycle and clone scope are application concerns.                                                              |
| Mermaid                       |                                         `11.17.2` | Keep and monitor advisories                           | Security upgrade is complete. Mermaid fixtures still belong in final verification.                                       |
| `image-size`                  |                                           Removed | Keep removed                                          | Bounded dependency-free PNG, JPEG, GIF, and WebP header readers replaced the vulnerable package and `@types/image-size`. |
| `highlight.js`                | `11.12.0` direct plus `11.8.0` through lowlight 2 | Keep direct patch; defer dedupe to lowlight migration | Do not force lowlight 3 into this task.                                                                                  |
| lowlight                      |                                           `2.9.0` | Defer `3.3.0`                                         | Version 3 is ESM-only and changes construction and registration APIs.                                                    |
| markdown-it                   |                                          `14.3.0` | Defer `15.0.0`                                        | The major affects equivalence, anchors, paste, entities, and linkification.                                              |
| KaTeX                         |                                         `0.16.47` | Keep                                                  | Mermaid 11.17.2 still accepts this line. A direct 0.18 upgrade risks two copies and CSS/font divergence.                 |
| esbuild                       |                                          `0.28.2` | Keep patch and explicit runtime targets               | Extension and webview builds target the chosen VS Code floor.                                                            |
| Jest / ts-jest                |                  Jest `30.4.2`, ts-jest `29.4.12` | Keep with narrow Marked ESM handling                  | Current harness loads TipTap Markdown without widening all `node_modules` transforms.                                    |
| TypeScript                    |                                           `5.9.3` | Keep                                                  | TypeScript 7 remains outside this task.                                                                                  |
| `@types/vscode`               |                                    Exact `1.98.0` | Keep equal to the minimum VS Code floor               | Manifest, types, builds, and CI use the same floor.                                                                      |
| `@types/node`                 |                                        `20.17.58` | Keep on Node 20 declarations                          | These declarations match the VS Code 1.98 extension-host runtime line.                                                   |
| VS Code test stack            |  `@vscode/test-cli@0.0.15`, `test-electron@3.1.0` | Keep; expand beyond the current smoke boundary        | The harness is installed and CI-matrixed, but packaged real-webview message and fault tests remain open.                 |
| Mermaid transitive DOMPurify  |                                          `3.4.14` | Keep patched compatible release                       | Current audits report zero known vulnerabilities.                                                                        |
| docx transitive nanoid        |                                          `5.1.16` | Keep patched compatible release                       | DOCX behavior remains in final verification.                                                                             |
| cheerio transitive undici     |                                          `7.29.0` | Keep patched compatible release                       | Export and URL behavior remain in final verification.                                                                    |

### Current audit result

Both `npm audit` and `npm audit --omit=dev` currently report zero known vulnerabilities. This replaces the historical baseline of five production vulnerability groups. The audit must still be rerun in final verification and after any later dependency change.

Relevant advisories:

- [Mermaid CSS injection](https://github.com/advisories/GHSA-6x64-9x62-f2gx)
- [image-size ICNS infinite loop](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
- [image-size JXL and HEIF infinite loops](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)

### TipTap upgrade rules

1. Use exact synchronized versions for every direct `@tiptap/*` package.
2. Add all production imports as direct dependencies.
3. Import ProseMirror APIs only through `@tiptap/pm/*`.
4. Run `npm dedupe` and assert a single TipTap/ProseMirror family with `npm ls`.
5. Keep the lockfile and do not use broad caret ranges for the coupled family.
6. Update `THIRD_PARTY_LICENSES.md` for additions, removals, or replacement packages.
7. Treat `@tiptap/markdown` as Beta. Maintain an explicit compatibility corpus and rollback point.
8. Do not adopt the new Decorations API during the version bump. Evaluate it only after version parity is green.

### TipTap 3.30.3 value

The releases between 3.12.1 and 3.30.3 include fixes directly relevant to this editor:

- Markdown blank-line, whitespace, escaping, empty content, overlapping mark, entity, list, table-cell, and HTML round trips.
- Correct plain-text copy for table cell selections.
- Multi-range deletion behavior that preserves table selections.
- Table cursor and last-row/last-column fixes.
- Editor destruction memory-leak fixes.
- New manual and changed-range Decorations APIs that may later reduce annotation work.

Official references:

- [TipTap Markdown documentation and Beta limitations](https://tiptap.dev/docs/editor/markdown)
- [TipTap core changelog](https://tiptap.dev/docs/resources/changelog/core)
- [TipTap Markdown changelog](https://tiptap.dev/docs/resources/changelog/markdown)
- [TipTap table changelog](https://tiptap.dev/docs/resources/changelog/extension-table)
- [TipTap ProseMirror dependency guidance](https://tiptap.dev/docs/editor/core-concepts/prosemirror)
- [TipTap 3.30 release discussion](https://github.com/ueberdosis/tiptap/discussions/8178)

### Upgrade implementation result

The TipTap 3.30.3 upgrade is now present in the working tree:

- Every direct `@tiptap/*` dependency is exactly `3.30.3`.
- Production imports ProseMirror APIs through `@tiptap/pm/*` only.
- `npm ls` shows one deduplicated TipTap and ProseMirror family.
- The Jest harness narrowly transforms Marked 17's ESM runtime entry, so the prior module-loading blocker is removed without a transitive downgrade.
- The paragraph extension is a direct dependency and third-party license records have been updated.

Focused compatibility tests and builds have been exercised during implementation. The complete Markdown compatibility corpus, packaged minimum/current host run, and manual long-form reading review remain final gates, so the dependency phase is not yet fully verified.

---

## 9. VS Code and Runtime Compatibility Decision

### Implemented compatibility decision

- The manifest now advertises VS Code `^1.98.0` and no longer declares a misleading package-level Node engine.
- `@types/vscode` is exactly `1.98.0` and `@types/node` is `20.17.58`.
- The extension bundle targets Node 20 and the webview bundle targets Chromium 132.
- `extensionKind` is `workspace`. Virtual and untrusted workspaces are explicitly unsupported.
- The official Extension Host runner is configured for Ubuntu and Windows against VS Code 1.98 and current stable.
- README and architecture guidance describe the new floor.

The earlier 1.85 manifest, 1.125 API types, Node 22 package-engine claim, and implicit `esnext` build targets were historical contradictions and are no longer the installed configuration. The current real-host suite is a development-extension smoke test, not a packaged VSIX or real-webview fault suite. Packaged verification at the minimum and stable hosts therefore remains open.

Runtime references:

- [VS Code 1.85 release notes](https://code.visualstudio.com/updates/v1_85)
- [VS Code 1.98 release notes](https://code.visualstudio.com/updates/v1_98)

---

## 10. Work Breakdown with TDD Gates

Every phase follows RED, GREEN, REFACTOR, VERIFY. No implementation phase is complete until all existing and new tests pass.

### Phase 0: Baseline, compatibility ADR, and fault injection

- [ ] Record installed dependency graph, VSIX contents, bundle sizes, startup, memory, serialization, analysis, Feedback Start, and capture timings.
- [x] Add a reproducible 3,000-word reading fixture and one 10,000-line stress fixture with tables, lists, images, Mermaid, math, raw HTML, code, and frontmatter.
- [x] Add deterministic transport fault injection for rejected posts, never-settling send promises, dropped ACKs, delayed ACKs, duplicate identities, and stale identities. End-to-end packaged webview reordering remains open.
- [ ] Add activation failures at every renderer side-effect boundary. Representative prepare, commit, and real-editor rollback failures are covered, but the exhaustive boundary matrix is not complete.
- [x] Add overlapping `WorkspaceEdit`, slow or failed save, stale split, disposal, reload, and non-retained teardown fault coverage at unit/provider level.
- [x] Add same-shape/different-content saved-source, renderer-block, and persisted-table fingerprint failures.
- [x] Decide the minimum VS Code/runtime floor and pin types for the decision.
- [x] Add explicit esbuild targets. Packaged minimum-host verification remains in the integration slice.
- [ ] RED: prove the current implementation fails the new lifecycle, snapshot, selection, pointer, and serialization-count tests.
- [ ] VERIFY: save baseline profiles from the reference Windows i5/16 GB machine and a current development machine.

### Phase 1: Dependency security slice

- [x] Preserve Mermaid render, interaction, sanitization, theme, lifecycle, and error fixtures. Export remains part of final verification.
- [x] Upgrade Mermaid to 11.17.2 as a standalone change.
- [x] Refresh patched compatible DOMPurify, nanoid, and undici lock entries with focused tests.
- [x] Add a strict source/signature image-format allowlist before dimension reads.
- [x] Replace `image-size` with bounded dependency-free PNG, JPEG, GIF, and WebP dimension readers.
- [x] Remove `image-size` and `@types/image-size`.
- [x] Run `npm audit --omit=dev`; the result is zero known vulnerabilities.
- [ ] VERIFY: full tests, Mermaid fixtures, DOCX/PDF/HTML export checks, release build, package boundary, and license file.

### Phase 2: Serialized document sync and debounced serialization

- [x] RED: assert only one `WorkspaceEdit` is in flight per document and every accepted edit is awaited.
- [x] RED: assert 20 rapid editor transactions cause one eventual Markdown serialization, not 20.
- [x] Implement `documentEditCoordinator.ts` behind the current provider API.
- [x] Implement `documentSyncController.ts` behind the current webview sync calls.
- [x] Add view generation, local revision, base version, edit ID, and accepted-version ACKs, including negative ACKs for identifiable malformed edits.
- [x] Add explicit queue drain, host flush, save, Feedback snapshot, and teardown barriers.
- [x] Preserve full replacements during extraction and verify focused undo behavior. Sibling integration remains in the ACK slice.
- [ ] REFACTOR: the serial coordinator replaced latest-promise-only correctness, but duplicated provider flush and compatibility bookkeeping still needs consolidation.
- [ ] VERIFY: typing, save, autosave, undo/redo, blank-line modes, split views, external edits, and 10,000-line timing.

### Phase 3: Versioned transport and lifecycle reducers

- [x] RED/GREEN: a queued-but-unreceived or never-settling `feedback.started` delivery cannot silently count as renderer activation.
- [x] RED/GREEN: duplicate activation, transport, peer-lock, peer-release, close, and recovery identities are idempotent in focused tests.
- [x] RED/GREEN: old webview generations, operation identities, stage revisions, and session identities are rejected in focused tests.
- [x] Implement generation-bound active ownership apply, commit, and rollback with terminal fail-closed delivery, late-ACK recovery, disposal handling, and host activation only after all commit ACKs and peer locks.
- [x] Implement pure host and renderer lifecycle reducers with deterministic transition tests.
- [x] Implement `feedbackTransport.ts` with checked and bounded post results, application ACKs, idempotent replay, stale rejection, cancellation, and status query.
- [x] Add a generation-bound `ready` handshake, host-authoritative document restoration, active-session rehydration, and bounded renderer UI state restoration.
- [ ] Add bounded local diagnostics before activation.
- [ ] Route the existing lifecycle through adapters while public behavior remains unchanged.
- [ ] REFACTOR: remove obsolete boolean/map flags only after split, close, transfer, reload, and recovery parity tests pass.
- [x] VERIFY: deterministic model-based transition tests plus real provider message tests.

### Phase 4: Atomic snapshot and renderer activation

- [x] RED/GREEN: old rendered blocks plus new same-kind source blocks fail parity.
- [x] RED/GREEN: two divergent dirty splits cannot start Feedback.
- [x] RED/GREEN: renderer prepare or commit failures roll back installed effects and never expose an active transaction.
- [x] Implement and integrate `feedbackSnapshotService.ts` with text, saved-byte, split, renderer, descriptor, and content fingerprints.
- [x] Apply authoritative content before canonical block enumeration and independently verify the renderer's serialized result.
- [x] Implement and integrate provisional renderer setup with a reverse-order rollback/disposable stack.
- [ ] Implement prepare, commit, committed ACK, and recovery protocol.
- [ ] Reconcile or retry by state after timeouts. Remove timer-driven correctness decisions.
- [x] Keep durable draft and sealed-bundle parsing, resume, mutation, seal, and immutability compatibility in focused tests.
- [ ] REFACTOR: shrink lifecycle and snapshot responsibilities out of `MarkdownEditorProvider.ts` and `feedbackReview.ts`.
- [ ] VERIFY: new session, resume, start-new, finish, discard, transfer, reload, owner disposal, external change, save failure, and restart.

### Phase 5: Isolated TipTap 3.30.3 upgrade

- [ ] RED: freeze the complete Markdown round-trip compatibility corpus and real-editor selection behavior.
- [x] Update Jest/ts-jest configuration so Marked 17 ESM loads without an unsupported dependency override.
- [x] Convert production ProseMirror imports to `@tiptap/pm/model`, `@tiptap/pm/state`, `@tiptap/pm/view`, and `@tiptap/pm/tables`.
- [x] Declare every directly imported TipTap package.
- [x] Pin every direct TipTap package to exact 3.30.3 in one package/lockfile slice.
- [x] Assert one core, PM, model, state, view, and tables instance with `npm ls`.
- [ ] Review every allowed Markdown-output change. No unexplained golden-file rewrite is accepted.
- [ ] Run plugin teardown/leak, table copy/delete, multi-range, empty content, blank-line, nested-list, raw HTML, mark overlap, escape, entity, and table-cell cases.
- [x] Update third-party license and architecture documentation for the dependency graph.
- [ ] VERIFY: all tests and fixtures, release build, VSIX package, minimum/current VS Code, and manual reading pass.

### Phase 6: Typed selection and table-cell feedback

- [x] RED/GREEN: reproduce forward and backward 4 by 4 `CellSelection` plus collapsed and outside-editor native-event races with a real TipTap editor.
- [x] Implement typed text, block, and cell target unions.
- [x] Add `CellSelection` and `TableMap` mapping through `@tiptap/pm/tables`.
- [x] Coalesce native and ProseMirror events in one animation-frame sampler.
- [x] Preserve valid structural actions through transient collapsed or outside-editor native events.
- [x] Add explicit mapping and block-fallback reasons with accessible toolbar behavior.
- [x] Validate restored table targets against the table fingerprint, rectangle, cell nodes, and containing block.
- [ ] VERIFY: forward/backward selection, merged/irregular cells, empty cells, headers, scrolled tables, zoom, keyboard selection, focus changes, and split views.

### Phase 7: Capture pointer and complexity architecture

- [x] RED/GREEN: edge start, pointer cancellation, lost capture, blur, visibility loss, wrong pointer ID, stale viewport, and raster abort.
- [x] Implement and integrate the pure capture reducer and one-pointer ownership.
- [x] Create one modal capture root and complete tested cleanup paths.
- [x] Add `ResizeObserver`, visual-viewport, resize and scroll observation, plus final pre-raster generation checks.
- [x] Add phase abort tokens and idempotent cancellation.
- [x] Prune to intersecting top-level blocks and intersecting rendered resources with bounded node and resource ceilings.
- [x] Prune non-intersecting rows, cells, and nested list subtrees inside one large intersecting block, with a bounded fail-closed path for row spans.
- [x] Add visible complexity, boundary, raster, encoding, and retry errors.
- [ ] VERIFY: 100%, 125%, 150%, and 200% scale; light/dark/high contrast; margin starts; long tables; local/remote images; Mermaid; math; and all terminal events.

### Phase 8: Performance, memory, integration CI, and documentation

- [x] Add deterministic annotation indexes and operation-count gates for 500 Feedback items.
- [ ] Implement cached and cancelable Markdown equivalence, block, and anchor analysis behind `MarkdownAnalysisService`.
- [ ] Add the Markdown analysis worker if the recorded gate is exceeded.
- [x] Implement and test minimal replacement edits for documents at or above 32 KiB, including CRLF and surrogate boundaries.
- [ ] Cache draft discovery. Screenshot bodies and hashes are now validated lazily on explicit Resume, while discovery checks bounded report metadata, path safety, file type, and quotas.
- [x] Disable `retainContextWhenHidden` after adding bounded `getState`/`setState`, ready recovery, teardown edit, and active-session restoration coverage. Memory evaluation remains open.
- [x] Add `@vscode/test-cli` and `@vscode/test-electron` Extension Development Host smoke tests.
- [x] Configure Extension Host and deterministic performance jobs on Windows and Ubuntu for pull requests. macOS remains open.
- [x] Configure the real-host matrix for VS Code 1.98 and stable, including custom-editor open, split close/survival, workspace edit/save, close, and reopen.
- [ ] Add real-host coverage for actual webview messages, hide/show teardown, Feedback restore, dropped or delayed ACKs, slow host, and external-edit faults.
- [x] Keep the existing Electron DOM fixtures for scale, theme, capture, annotation, and layout coverage.
- [ ] Add a physical Windows i5/16 GB manual pass. Device scale simulation does not replace one real DPI run.
- [x] Update `vibe-coding-rules/env-context.md`, `common-pitfalls.md`, `performance.md`, `testing.md`, `docs/ARCHITECTURE.md`, README compatibility text, and this implementation plan. The separate user-owned rich-view Feedback plan remains untouched.
- [x] VERIFY: `npm run lint`, all local test tiers, `npm run build:release`, `npm run verify-build`, VSIX packaging, `npm audit --omit=dev`, and `git diff --check`. VS Code 1.98 and stable passed locally on macOS; the configured Windows and Ubuntu CI jobs have not run in this worktree.
- [ ] Complete the required 3,000-word, 10-minute light/dark reading pass.

---

## 11. Test Architecture

### Implemented unit and real-editor suites

- `src/__tests__/editor/documentEditCoordinator.test.ts`
- `src/__tests__/editor/feedbackLifecycleMachine.test.ts`
- `src/__tests__/editor/feedbackSnapshotService.test.ts`
- `src/__tests__/editor/feedbackTransport.test.ts`
- `src/__tests__/editor/minimalTextEdit.test.ts`
- `src/__tests__/webview/documentSyncController.test.ts`
- `src/__tests__/webview/feedbackLifecycleMachine.test.ts`
- `src/__tests__/webview/feedbackActivationController.test.ts`
- `src/__tests__/webview/feedbackSelectionMapping.test.ts`
- `src/__tests__/webview/feedbackCaptureMachine.test.ts`
- `src/__tests__/webview/feedbackPeerLockClient.test.ts`
- `src/__tests__/webview/feedbackPeerReleaseClient.test.ts`
- `src/__tests__/webview/feedbackSnapshotClient.test.ts`
- `src/__tests__/webview/richViewState.test.ts`
- `src/__tests__/shared/documentSyncProtocol.test.ts`
- `src/__tests__/shared/feedbackDeliveryProtocol.test.ts`
- `src/__tests__/shared/feedbackSnapshotProtocol.test.ts`
- `src/__tests__/shared/pendingImageProtocol.test.ts`

The existing `feedbackReviewLifecycle.realEditor.test.ts` now contains the real TipTap 4 by 4 cell-selection, event-ordering, exact-cell restoration, and fallback coverage. Capture pointer lifecycle is covered in `feedbackCaptureMachine.test.ts` and the integrated workflow suite.

### Planned unit boundaries

- `src/__tests__/editor/markdownAnalysisService.test.ts`
- production-adapter tests proving the pure host and renderer lifecycle reducers are the only lifecycle authority
- active ownership-transfer transaction tests with dropped, duplicate, delayed, and disposal ACK faults
- bounded diagnostics-store tests available before activation

### Existing suites to extend

- `src/__tests__/shared/feedbackProtocol.test.ts`
- `src/__tests__/editor/feedbackProvider.test.ts`
- `src/__tests__/editor/feedbackSplitLifecycle.test.ts`
- `src/__tests__/editor/feedbackAnchors.test.ts`
- `src/__tests__/editor/markdownAstEquivalence.test.ts`
- `src/__tests__/webview/feedbackReview.test.ts`
- `src/__tests__/webview/feedbackReviewLifecycle.realEditor.test.ts`
- `src/__tests__/webview/feedbackRenderedRange.test.ts`
- `src/__tests__/webview/feedbackCaptureWorkflow.test.ts`
- `src/__tests__/webview/feedbackDomCapture.test.ts`
- `src/__tests__/webview/feedbackCloseRetry.test.ts`
- `src/__tests__/webview/blankLinePreservation.test.ts`
- `src/__tests__/webview/htmlTableRoundTrip.test.ts`
- `src/__tests__/webview/preservedCodeBlock.test.ts`
- Mermaid, math, paste, image, undo, and export suites affected by dependency changes

### Integration layers

1. **Implemented:** pure reducer, protocol, coordinator, transport, snapshot, and boundary tests.
2. **Implemented:** Jest real TipTap editor tests for transactions, plugins, serialization, lifecycle rollback, and selection behavior.
3. **Implemented:** Electron renderer fixtures for capture, annotations, scale, themes, and layout counts.
4. **Partly implemented:** VS Code Extension Development Host smoke tests for activation, registration, custom-editor open, splits, workspace edit/save, close, and reopen.
5. **Planned:** real-host webview-message and fault tests plus packaged VSIX smoke tests against minimum and current VS Code.
6. **Planned:** physical low-spec Windows profiling, memory profiling, and manual UX review.

### Dependency compatibility corpus

At minimum, cover:

- empty document and trailing newline policy
- YAML frontmatter, including embedded fence runs
- paragraphs with preserved spaces and blank-line modes
- ordered, bullet, task, nested, and mixed lists
- headings, blockquotes, rules, links, autolinks, and escaped punctuation
- inline code with pipes and overlapping marks
- fenced and indented code blocks
- pipe tables with empty cells, line breaks, escaped pipes, alignment, and HTML-preserved merged tables
- images with spaces, relative paths, dimensions, captions, and unsupported formats
- raw HTML and GitHub alerts
- Mermaid and math blocks
- 3,000-word and 10,000-line documents
- source forms that render equivalently but must retain original bytes

### Fault matrix

- [x] Message post returns false, rejects, or never settles.
- [x] Message is queued without an application ACK.
- [x] ACK is dropped or delayed.
- [x] Command or ACK is duplicated or reuses a conflicting identity.
- [x] Old renderer generation, operation, stage, or session response arrives.
- [ ] Lifecycle stage messages are reordered through a packaged real webview.
- [ ] Owner is hidden, restored, reloaded, or disposed at every lifecycle stage. Focused provider cases exist, but the full matrix is open.
- [x] Peer split is dirty, stale, divergent, unavailable, or disposed during a boundary.
- [x] Save returns false or throws in focused host tests.
- [x] Document changes externally before or after save and snapshot analysis in focused tests.
- [ ] Worker is slow, crashes, or returns stale data. The worker does not exist yet.
- [ ] Activation plugin, chrome, and observer setup throws at every boundary. Representative rollback paths exist.
- [x] Pointer ends through pointerup, pointercancel, lost capture, blur, visibility loss, cancellation, disposal, and stale viewport paths.
- [x] Image probe receives an unsupported, malformed, oversized, or adversarial format.

---

## 12. Rollout and Migration Safety

- Keep `feedbackReview.ts` as a facade while responsibilities move behind it.
- Keep `MarkdownEditorProvider.ts` as an adapter while document and lifecycle coordinators move out.
- Migrate one transition family at a time: edit queue, start/resume, active mutations, close, then recovery.
- Use an internal development switch only while both paths are under test. Do not ship two competing lifecycle authorities.
- Preserve durable draft and sealed-bundle compatibility throughout.
- Keep each dependency upgrade as a separate reviewable slice from architecture changes.
- Preserve a lockfile rollback point for TipTap.
- Reject mismatched protocol versions and request a full reload/status sync after an extension update.
- Do not delete old flags or maps until equivalent tests prove they are no longer read or written.
- Do not commit or push. The user reviews every implementation slice first.

---

## 13. Decisions and Tradeoffs

- **Keep `CustomTextEditorProvider`:** It preserves VS Code save, undo, backup, dirty-state, and Git integration. A custom document model adds responsibility without fixing the defects.
- **Keep TipTap and upgrade it:** The library has relevant fixes and remains a good editor foundation. The custom protocol and mapping code still need repair.
- **One coordinator per resource:** Document state is shared; a coordinator per panel cannot prevent split races.
- **Application ACKs for critical messages:** Transport success is weaker than application success.
- **Status reconciliation instead of timeout unlock:** A timer is not evidence of document or session state.
- **Two-phase renderer activation:** Partial UI mutation is the direct cause of stranded states. Prepare/commit makes rollback testable.
- **Fail closed on divergent splits:** Guessing a winner risks silent content loss.
- **Exact coupled dependency versions:** TipTap Markdown is Beta and the family must share one ProseMirror identity.
- **Upgrade ProseMirror only through `@tiptap/pm`:** Direct versions can create incompatible selection and plugin classes.
- **Do not adopt Decorations API during the TipTap bump:** Version compatibility and annotation architecture are separate risks.
- **Serial queue before minimal diffs:** Correct ordering comes first; the minimal-edit optimization follows with dedicated Unicode and undo tests.
- **Worker boundary after or at measured threshold:** The abstraction is required immediately; a worker becomes default when host stalls exceed budget.
- **Remove hidden-context reliance:** Host state plus `view.ready` is more reliable and uses less memory.
- **Raise the VS Code floor rather than claim false compatibility:** The recommended first candidate is 1.98, subject to an exact API audit and minimum-host test.
- **No big-bang rewrite:** Facades and characterization tests reduce regression risk in a mature, heavily tested feature.

---

## 14. Risks and Mitigations

| Risk                                                        | Mitigation                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Lifecycle refactor regresses close/recovery behavior        | Pure model tests, compatibility facades, transition-by-transition migration, fault injection                  |
| TipTap Markdown changes serialized bytes                    | Exact pin, golden corpus, byte-preservation cases, isolated version slice, rollback point                     |
| Marked 17 ESM destabilizes Jest                             | Fix and prove the harness before changing TipTap; do not downgrade Marked behind TipTap                       |
| Worker packaging fails in VSIX or remote host               | Explicit esbuild entry, package-boundary test, minimum/current/remote smoke tests                             |
| Minimal edits break Unicode, CRLF, undo, or cursor behavior | Separate implementation slice with boundary-specific tests and full-replacement fallback during development   |
| Turning off retained contexts loses UI state                | Implement `setState` restoration and authoritative `view.ready` sync first; compare memory and behavior       |
| Exact table-cell anchors cannot survive Markdown edits      | Keep source-line truth at the table block, validate cell metadata by table fingerprint, degrade visibly       |
| Capture pruning changes visual output                       | Pixel/structure fixtures across scale, theme, tables, images, Mermaid, and math                               |
| Dependency security fix changes export/render output        | Focused contract tests plus full build/package and audit after every slice                                    |
| Raising VS Code minimum excludes users                      | Use install analytics or support policy if available, publish the change clearly, and test the chosen minimum |

---

## 15. Definition of Done

- [x] All six reported feedback scenarios are represented by deterministic transport, snapshot, real-editor selection, and capture tests.
- [ ] All architecture invariants have automated tests.
- [ ] No critical lifecycle message is fire-and-forget.
- [ ] Renderer activation is transactional and recoverable.
- [x] Snapshot and anchor tests prove source, saved-byte, renderer-content, canonical-block, and table-fingerprint parity rather than block shape alone.
- [x] Renderer edits are serialized and Markdown serialization occurs after debounce rather than on the typing hot path.
- [x] Table `CellSelection` and capture pointer lifecycle pass focused real-editor and renderer tests.
- [x] TipTap 3.30.3 is exactly pinned, deduplicated, and passes the automated compatibility corpus.
- [x] Mermaid, `image-size`, transitive production advisories, and current dependency audits are resolved.
- [x] The VS Code/API/runtime floor is coherent and tested locally against VS Code 1.98 and stable.
- [ ] Real VS Code integration tests run on Windows and Unix.
- [ ] Performance budgets pass on the reference i5/16 GB Windows machine.
- [ ] Hidden/reloaded/split views pass lifecycle and memory tests.
- [x] All new and existing local tests, lint, release build, verification, audit, and VSIX packaging pass.
- [x] Documentation and third-party licenses match the implemented architecture and dependency graph.
- [ ] The required 3,000-word, 10-minute light/dark reading review is complete.
- [ ] User review is complete before any commit or push.

---

## 16. Implementation Log

Implementation agents are finished. Final local automated results are recorded below. Physical Windows profiling, CI execution, memory profiling, packaged real-webview fault injection, and manual reading remain separate acceptance gates.

### 2026-08-26 - Security, dependencies, and runtime

- **Dependency security:** Policy tests drove Mermaid to `11.17.2`, compatible DOMPurify, nanoid, undici, brace-expansion, fast-uri, and js-yaml refreshes, plus removal of `image-size` and `@types/image-size`. Dependency-free PNG, JPEG, GIF, and WebP header readers are source/signature matched and bounded.
- **Audit:** Both full and production-only npm audits currently report zero known vulnerabilities.
- **TipTap:** The complete direct family is exact `3.30.3`, direct imports are declared, production ProseMirror imports use `@tiptap/pm/*`, and the installed graph is deduplicated. A narrow Babel transform loads Marked 17 in Jest.
- **Runtime:** VS Code 1.98 is the declared floor. API types, Node 20 declarations, Node 20/Chromium 132 build targets, workspace extension placement, and virtual/untrusted workspace declarations now agree.
- **Tooling:** `@typescript-eslint` 8.68, `@eslint/js` 9.39.5, and concurrently 9.2.4 are installed. The VS Code test stack is pinned.

### 2026-08-26 - Document synchronization and hidden renderer recovery

- **Serialized edits:** `documentEditCoordinator.ts` serializes document mutations, coalesces only compatible pending typing, exposes barriers and cancellation, and contains execution failure so later work can proceed.
- **Versioned protocol:** `documentSyncProtocol.ts` and provider integration bind edit ID, renderer generation, local revision, base document version, accepted version, host flushes, and dependent teardown edits. Identifiable malformed edits receive negative ACKs.
- **Deferred serialization:** `documentSyncController.ts` removes Markdown serialization from the transaction hot path, retains dirty state when serialization or sending fails, prevents busy retry loops, and supports explicit save, Feedback, host-flush, and teardown boundaries.
- **Save and reload safety:** save barriers are bounded even when `postMessage()` never settles. Renderer replacement waits for accepted edit lineage, hidden on-focus/window autosave has a host fallback, and bounded selection/scroll state replaces retained DOM context.
- **Pending images:** compact markers let teardown transmit a bounded document while the host completes the file write. The renderer reserves at most 128 operations, retained bytes are capped at 64 MiB, and one exact-size host copy prevents subviews or later sender mutation from retaining or changing the payload. Success, failure, and capacity rejection are generation-bound, applied atomically in ProseMirror, ACKed, and retried idempotently. Unknown markers fail closed. Normal sync and host barriers remain blocked until the image boundary is safe.
- **Delivery lineage:** a host A to B to A update cannot reuse stale delivery proof. Each webview tracks its currently pending host content separately from the last content whose post completed successfully, and renderer-origin edits invalidate both proofs.
- **Flush and edit identity:** flush ACKs are bound to the exact renderer generation and document version. Replayable edit IDs are also bound to an immutable SHA-256 envelope, so conflicting reuse receives a negative ACK instead of replaying an unrelated success.
- **Content equivalence:** raw HTML token contexts are compared source-exactly before cosmetic Markdown normalization, preventing visible CSS-sensitive whitespace edits from being suppressed.
- **Final-panel autosave:** disposing the last rich view converts an armed custom autosave timer into a host-owned edit-queue drain and document save instead of silently cancelling it.
- **Edit size:** documents at or above 32 KiB use one safe minimal replacement with CRLF and surrogate-pair boundary tests.

### 2026-08-26 - Feedback transport, snapshots, and split locks

- **Transport:** `feedbackTransport.ts` covers false, rejected, delayed, duplicate, stale, timed-out, and never-settling delivery behavior with bounded retry, application ACK, cancellation, deduplication, and authoritative status reconciliation where implemented.
- **Snapshot:** `feedbackSnapshotService.ts` and the snapshot client/protocol bind exact source text, saved bytes, document version, renderer generation/revision, split reports, canonical descriptors, and content fingerprints. Same-shape content changes and divergent dirty splits fail closed.
- **Renderer setup:** `feedbackActivationController.ts` is integrated into `feedbackReview.ts` and reverses provisional effects when prepare or commit fails. This is renderer-local transactionality, not yet a complete host prepare/commit protocol.
- **Split safety:** renderer-generation-bound peer lock acquisition is application-ACKed. Peer release is content-bearing and two-phase, applying authoritative Markdown while locked before a correlated commit unlocks the renderer.
- **Active ownership transfer:** production uses a generation-bound apply/commit/abort transaction. The new owner stages before the old owner freezes, the host revalidates document version and source digest, and the next host session remains `resuming` until all owner ACKs and peer locks confirm commit. Apply or commit exhaustion terminates the user request fail-closed while preserving late-ACK identity; pre-commit failure rolls both sides back through exact abort ACKs. Raw `feedback.session.transferred` handling is compatibility-only.
- **Remaining lifecycle gap:** the pure host and renderer reducers exist but production does not use them as its sole state authority. Initial Start still lacks a distinct host-driven prepare/commit/committed epoch even though `feedback.started` itself is application-ACKed and reconciled.

### 2026-08-26 - Selection, capture, performance, and integration

- **Table selection:** production uses `CellSelection` and `TableMap` through `@tiptap/pm/tables`. One animation-frame sampler preserves structural authority across native selection races, returns typed targets or explicit fallbacks, and validates persisted cell rectangles with a table fingerprint.
- **Capture:** `feedbackCaptureMachine.ts` is integrated with pointer ownership, terminal-event cleanup, viewport generations, abortable raster phases, bounded top-level discovery, row/cell/nested-list pruning, fixed geometry spacers, resource ceilings, and visible recovery errors.
- **Resource boundary:** webviews can load local resources only from the extension and the exact containing workspace or document directory. Image URI resolution rejects paths outside those roots, and cancelled custom-editor resolution initializes no panel state.
- **Performance:** deterministic fixtures contain exactly 3,000 reading words, 10,000 stress lines, 500 Feedback items, and 10,000 typing transactions. They gate serialization, timer, lookup, geometry-read, and reachability operation counts without treating shared-runner wall time as a hardware benchmark.
- **Snapshot indexing:** finalization builds the source-line index once instead of splitting the complete document for every canonical block. A 500-block regression reduced exact full-source splits from 503 to a constant bound.
- **Anchor indexing:** restored Feedback items use logarithmic line-to-ordinal lookup rather than repeated linear scans; a 10,000-block proxy records at most 64 indexed reads.
- **Draft discovery:** automatic discovery validates bounded report metadata plus screenshot path/type/size quotas without reading every PNG body. Exact PNG structure and SHA-256 remain mandatory on explicit Resume.
- **Extension Host:** the official runner and CI matrix cover Ubuntu and Windows at VS Code 1.98 and stable. Current tests are development-extension smoke tests and do not yet drive actual webview messages or a packaged VSIX.
- **Worktree safety:** no commit or push is authorized. The user-owned rich-view Feedback plan remains untouched.

### 2026-08-26 - Final local automated verification

- **Jest:** 126 of 127 suites passed and one suite was skipped. 2,171 tests passed, 27 were skipped, and 120 remain explicit todos, for 2,318 total tests. Coverage passed at 86.46% statements, 83.70% branches, 92.90% functions, and 88.48% lines.
- **Critical reliability slices:** the 10-suite Feedback transfer matrix passed 467 of 467 tests. The seven-suite pending-image matrix passed 67 of 67 tests.
- **Performance:** all seven deterministic verifier tests passed with an exact 3,000-word reading fixture, 10,000 source lines, 500 Feedback items, and 10,000 typing transactions. Typing performed zero hot-path serializations, retained at most one timer, and completed with one drain serialization and send. Annotation layout performed 1,000 indexed geometry reads and zero source-line scans.
- **Electron UI:** all 11 annotation verifier tests plus the 14-case theme, zoom, narrow-layout, reduced-motion, stress, and real-controller matrix passed. Capture passed all nine light, dark, and high-contrast cases at 100%, 125%, and 200% zoom with actual Mermaid, KaTeX, local SVG, and table content.
- **VS Code host:** the three-test Extension Development Host suite passed locally on macOS against VS Code 1.98.0 and stable. Windows and Ubuntu jobs are configured in CI but were not executed locally.
- **Static and release gates:** TypeScript, lint, `git diff --check`, release build, build verification, full and production npm audits, dependency deduplication, and the VSIX package boundary passed. The generated VSIX contains 72 files, is 2.95 MB, and excludes source, tests, development dependencies, docs, roadmap, scripts, coverage, lockfiles, and source maps.

### Remaining architecture and acceptance gaps

- Wire the pure lifecycle reducers into production as the sole lifecycle state authority.
- Complete host-driven prepare/commit activation before marking a session active.
- Add `MarkdownAnalysisService`, the measured worker boundary, and a bounded pre-activation diagnostics store.
- Cache metadata-first draft discovery and invalidate it on bundle or source changes.
- Shrink the provider and review facade. They remain about 9,500 and 4,500 lines respectively.
- Review whether every broad image CSP source is still required.
- Add packaged real-webview lifecycle fault tests, macOS coverage, and complete VSIX smoke verification.
- Complete heap profiling, the physical Windows i5/16 GB performance and DPI pass, the 3,000-word 10-minute light/dark reading review, and user review.

---

## 17. Follow-up Work

- Evaluate TipTap 3.30 Decorations after the main architecture is stable and benchmarked.
- Plan a dedicated lowlight 3 and code-highlighting dependency dedupe migration.
- Plan a dedicated markdown-it 15 semantic migration after snapshot fingerprints are stable.
- Revisit KaTeX 0.18 when Mermaid no longer encourages the 0.16 line or bundle duplication is resolved.
- Revisit TypeScript 7 and ESLint 10 when the Jest and typescript-eslint ecosystem supports them.
- Consider an optional VS Code source-editor Comments projection after the TipTap-native Feedback experience is reliable.
- Consider remote workspace support as a separately tested product capability if URI-first migration is not completed here.
