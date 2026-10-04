# Environment Context for the VS Code Extension

> Lean implementation context for agents working in `markdown-for-humans`. See `docs/ARCHITECTURE.md` for the full design.

## Runtime and Editor Stack

| Boundary       | Contract                                  |
| -------------- | ----------------------------------------- |
| VS Code floor  | `^1.98.0`                                 |
| Extension host | Node.js 20 target                         |
| Webview        | Chromium 132 target                       |
| Editor         | TipTap 3.31.4 on ProseMirror              |
| Diagrams       | Mermaid 11.17.2 or compatible 11.x update |
| Capture        | `modern-screenshot@4.7.0`                 |

All direct `@tiptap/*` packages are pinned to exactly `3.31.4`. Upgrade them as one family, import ProseMirror through `@tiptap/pm/*`, and reject mixed TipTap or direct ProseMirror version families.

## Architecture

```text
VS Code extension host, Node.js 20
  MarkdownEditorProvider, CustomTextEditorProvider
    TextDocument, authoritative editable source
    DocumentEditCoordinator, one ordered queue per document
    Feedback snapshot, transport and durable store
                      ⇅ validated messages
Webview, Chromium 132
  TipTap + feature modules
  DocumentSyncController
  disposable Feedback review/capture UI
  bounded selection/scroll state checkpoint
```

`TextDocument` is canonical for editable Markdown. VS Code owns save, dirty-state, undo, redo and Git diffs. The webview is a rich projection that proposes edits and reconciles with host acknowledgements.

The extension declares virtual and untrusted workspaces unsupported because image, export and Feedback workflows require trusted, disk-backed workspace access.

## Document Sync Contract

Markdown entities are decoded only in inline text contexts. Authored entity spellings are retained in nonvisual mark attributes while their decoded text is unchanged; code, destinations and raw HTML use their own parsers. Never replace whole-source substrings with visible placeholder characters.

- Protocol v2 envelopes use `editId`, renderer `viewGeneration`, `localRevision` and `baseDocumentVersion`.
- A 500 ms controller debounce stores only a dirty bit. It serializes the latest TipTap state only at a timer drain or explicit flush boundary.
- The first change after idle drains on a zero-delay timer, so the `TextDocument` turns dirty before VS Code can close a clean-looking tab without prompting. Later changes in that burst use the 500 ms debounce. Messages a webview posts while its tab is closing never reach the host, so teardown flushes cannot replace this.
- Serialization reuses each unchanged top-level block's cached Markdown. Loads seed that cache with the block's authored source, so only edited blocks take TipTap's canonical form.
- One emitted edit waits for its exact `document.edit.ack` before another derives from the accepted host version.
- Explicit save drains accepted host edits, sends a correlated host-version flush barrier, requires any newly emitted edit to be accepted, drains again, then invokes VS Code save.
- Before a non-retained webview is destroyed, a newer dirty revision blocked behind one in-flight edit is sent as `document.teardown.edit`. The host applies it only after that exact predecessor succeeds and its resulting document version is still current.
- The host validates renderer generation and keeps a bounded idempotent ACK history.
- A replayable edit ID is bound to an immutable content and lineage envelope. Conflicting reuse is negatively acknowledged rather than replaying a prior result.
- Every document mutation enters `DocumentEditCoordinator`. Only adjacent pending typing from the same generation and base version may coalesce. Operations and barriers never coalesce.
- Documents of at least 32 KiB use one minimal prefix/suffix `WorkspaceEdit`. Boundaries never split a surrogate pair or CRLF.
- Host delivery and echo suppression are split-specific. Pending delivery is tracked separately from last proven delivery, so A to B to A races cannot suppress the final A. A skipped recent-edit update requests authoritative reconciliation instead of becoming a silent fork.
- Content a split already has (its echo, or blank lines hidden by strip mode) is answered with a version-only `document.version`. An echo counts only until other content is posted to that split, and it ignores CRLF versus LF. There is no timestamp echo window.
- A forced replay never discards typing the host has not accepted. The renderer keeps it and resends it on the replayed version; if a visible host change was deferred meanwhile, the host first shows a conflict notice that can open the replaced text. Replay requests back off (0, 250, 500, 1000 ms) and then stop with a Reload Editor error notification plus a persistent in-editor banner (`src/webview/features/outOfSyncBanner.ts`) whose Reload editor action posts `document.sync.reload`. Retries in progress never show the banner; an applied replay or an accepted edit removes it.
- Pending image destinations retain at most 128 unresolved entries and 64 MiB per view. The renderer reserves the same bounded number before conversion. Typed-array input is copied once into an exact-size host buffer and released when the write settles.
- Image completion is not complete when `postMessage()` queues it. The exact renderer generation atomically applies every matching ProseMirror mutation, ACKs application, and idempotently re-ACKs retries. Capacity errors use the same correlated path, and unknown or wrong-generation markers reject the document edit.
- Image completion mutations stay outside undo history. Failed-save data URI fallback is limited to 256 KiB including its header; larger failures reject the edit instead of embedding the preview. Image paste/drop checks the live Feedback owner/peer lock before side effects, independently of capture-listener order.
- Raw HTML token contexts are source-exact in structural-equivalence checks because HTML/CSS can make otherwise collapsible whitespace visible.
- Never reintroduce a shared `ignoreNextUpdate` boolean.

## Hidden Webviews

The editor registers with `retainContextWhenHidden: false`. Before teardown, the renderer flushes pending sync and persists only:

```text
schema version + document version + selection + scrollTop
```

`vscode.setState()` writes are animation-frame coalesced. Restore occurs after authoritative content initialization, checks the document version, clamps positions and yields to Feedback recovery. Never put Markdown, Feedback sessions, draft content or peer-lock authority in webview state.

The `ready` handshake always forces one authoritative document update. The
optimistic startup post can occur before the webview listener is installed, so
normal content deduplication is not safe at this boundary.

## Code Block Highlighting

`CodeBlockWithCopy` extends the plain TipTap code-block extension and installs one
`codeSyntaxHighlighting` plugin. Do not add CodeBlockLowlight or a second highlighting
plugin alongside it. Highlighting is presentation state, never a document mutation.

- The plugin maps an occurrence index and existing decorations through transactions. Ordinary edits inspect changed ranges, including attribute-only changes; an unknown step can require a conservative full index scan.
- Lexical work runs in the lazily loaded, packaged `highlighting-worker.js`. Each webview owns its worker, bounded token cache, timers and disposal. None belongs in persisted webview state.
- `languageRegistry.ts` defines the supported grammar and alias inventory without importing grammar code into the editor bundle. Worker registration preserves the existing Lowlight common grammars and the editor's explicit highlight.js overrides; inventory tests guard compatibility.
- Grammar lookup uses only the normalized first fence token. Empty, explicit plain-text and unsupported tokens stay plain without automatic language detection or a warning. The document keeps its authored info string; menu changes replace the language token while retaining each block's metadata suffix.
- Worker results contain validated, block-relative UTF-16 spans. Publication rechecks the occurrence, revision, grammar and source before creating decorations. Color-only transactions do not enter undo history or document sync.
- Source/token limits and worker failures keep the code editable and show a short explanation outside the code content. The copy control reads the current document node's raw text.
- Surface, font and token colors use VS Code variables and contributed `markdownForHumans.code*` colors. Theme changes do not require new lexical work.

These boundaries do not establish an input-to-paint performance result. Large-result
publication, document replacement, memory disposal and real-host theme checks remain
release gates in the active syntax-highlighting plan.

## Feedback Snapshot and Delivery

Public Feedback commands wait for the generation-validated controller-ready
signal before posting to the original active panel. The bounded startup wait is
cancelled on hide, reload or disposal; queue acceptance is not session activation.


- A new Start and a durable-draft Resume inspect every split first. Divergent dirty split digests fail before any flush chooses a winner.
- The host flushes all splits, drains the document queue, saves, reads exact bytes, and binds the `TextDocument` version plus text SHA-256 to the saved-byte SHA-256.
- The saved source is applied back to every split. Only the owner enumerates canonical blocks after that authoritative apply.
- `feedbackSnapshotService.ts` verifies renderer identity, descriptor revision, exact source mapping and semantic content fingerprints per block.
- Restored item line endpoints use the frozen anchor index with logarithmic lookup. Do not reintroduce an `items x blocks` scan.
- `feedback.started` is not considered applied because `postMessage()` returned true. It uses bounded idempotent delivery, an application ACK and an authoritative status query fallback.
- Active ownership transfer uses generation-bound apply, commit, and abort stages. The proposed host session remains `resuming` until both owners and every peer lock ACK commit. Ambiguous delivery remains fail-closed, while definitive disposal is reinitialized from host authority on the next `ready`.
- Refused transfer applies retain their negative result for exact retry ACKs until an explicit abort. Refusal does not mean the abort stage has completed.
- Pure host and renderer lifecycle reducers reject stale stages in deterministic tests. Production still routes lifecycle effects through provider and renderer adapters, so do not treat those reducers as the sole authority until that migration is completed. Durable drafts, not webview state, are the recovery authority after reload.
- Any later source change invalidates the frozen round, preserves the draft, and blocks new writes and sealing.
- Invalidation and deferred annotation layout preserve focus in another editor group. The webview's stale `activeElement` is not proof of focus; check `document.hasFocus()` before restoring local controls.

Screenshot publication, report commit, and failed-asset rollback share the report
lock with Resume. Restore the previous report before deleting an unpublished
asset; if restoration fails, preserve assets referenced by the report still on disk.

Feedback structural choices are indexed once per frozen document. Top-level heading sections use complete v2 source block spans. Nested scopes use existing exact rendered-text locators, with source lines labelled as containing context; they do not assert exact nested authored-source regions. Ancestor choices use parent pointers, and table matrices are built only when the user opens Change scope. Ordinary text drags never capture the pointer. Frozen indexes are disposed with their session, and the host source-format index is reset during ownership transfer.

Text anchors use exact block-relative ranges. Table selections use typed rectangular cell targets bound to a table fingerprint and host-enriched canonical table-block SHA-256. Exact table geometry is capped at 256 cells per item and 4,096 cells per session. Invalid or over-budget restored cell metadata degrades to the containing block and never fuzzy-matches.

Feedback renderer equivalence normalizes single-paragraph list wrappers using
Markdown-it tokens, including items with nested lists or verbatim code blocks.
Actual nesting changes, multiple paragraphs, code whitespace and raw HTML remain
strict. Matching italic/bold spans closed and reopened around a single inline
line break are equivalent to one continuous span. This renderer-only comparison
preserves the break and rejects actual text, formatting and link changes.
Numbered lists use marked's CommonMark tokenizer and the local
`MarkdownListItem` serializer, whose child indentation follows the actual marker
width (including `0.` and `10.`). Ordinary document-write equivalence and the
explicit preserve-blank-lines policy are unchanged.

## Feedback Capture Limits

- Capture is DOM-based and limited to mapped visible blocks.
- Cancellation and session invalidation propagate through `AbortSignal`.
- Staging is capped at 4,096 rendered nodes and 1,024 resource references.
- Large intersecting tables and nested lists are pruned to intersecting rows, cells and items. Fixed spacers preserve geometry and ordered-list numbering; row spans use the bounded fail-closed path.
- Resources outside the VS Code webview boundary fail closed.
- Output is capped at 12 megapixels and 10 MiB; the host revalidates PNG structure, dimensions, containment and hash.

## Performance Budgets and Gates

| Metric                |                        Budget |
| --------------------- | ----------------------------: |
| Editor initialization |                  under 500 ms |
| Typing                |                   under 16 ms |
| Cursor and formatting |                   under 50 ms |
| Menu and toolbar      |                  under 300 ms |
| Document target       | 10,000 or more lines smoothly |

The deterministic fixture gates production work counts on 3,000-word and 10,000-line corpora, 500 annotations and 10,000 typing transactions. Ubuntu and Windows CI run this fixture. Real Extension Development Host tests also run on both operating systems against VS Code 1.98.0 and stable.

Shared-runner gates do not prove physical Windows i5/16 GB p95 latency, memory use, high-DPI capture or the required 10-minute light/dark reading pass. Those remain manual release checks.

## Key Files

| Concern                     | File                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| Activation and commands     | `src/extension.ts`                                                                               |
| VS Code adapter             | `src/editor/MarkdownEditorProvider.ts`                                                           |
| Ordered document work       | `src/editor/documentEditCoordinator.ts`                                                          |
| Large-document edit range   | `src/editor/minimalTextEdit.ts`                                                                  |
| Sync protocol               | `src/shared/documentSyncProtocol.ts`                                                             |
| Renderer sync controller    | `src/webview/documentSyncController.ts`                                                          |
| TipTap composition          | `src/webview/editor.ts`                                                                          |
| Table Enter → hardBreak     | `src/webview/extensions/tableCellEnterHardBreak.ts`, `src/webview/extensions/htmlPreservingTable.ts` |
| Code block node view        | `src/webview/extensions/codeBlockWithCopy.ts`, `src/webview/extensions/codeBlockCopyNodeView.ts` |
| Highlight occurrence index  | `src/webview/highlighting/plugin.ts`                                                              |
| Highlight worker and limits | `src/webview/highlighting/client.ts`, `src/webview/highlighting/worker.ts`, `src/webview/highlighting/types.ts` |
| Fence info and grammars     | `src/webview/highlighting/fenceInfo.ts`, `src/webview/highlighting/languageRegistry.ts`, `src/webview/highlighting/tokenize.ts` |
| List Markdown compatibility | `src/webview/extensions/markdownListItem.ts`, `src/webview/extensions/orderedListMarkdownFix.ts`, `src/webview/extensions/markdownTaskList.ts` |
| Sync serialization          | `src/webview/utils/markdownSerialization.ts`                                                     |
| Hidden-view state           | `src/webview/utils/richViewState.ts`                                                             |
| Feedback request contract   | `src/shared/feedbackProtocol.ts`                                                                 |
| Snapshot protocol/service   | `src/shared/feedbackSnapshotProtocol.ts`, `src/editor/feedbackSnapshotService.ts`                |
| Delivery protocol/transport | `src/shared/feedbackDeliveryProtocol.ts`, `src/editor/feedbackTransport.ts`                      |
| Feedback bundle store       | `src/editor/feedbackSessionStore.ts`                                                             |
| Feedback renderer           | `src/webview/features/feedbackReview.ts`                                                         |
| Capture                     | `src/webview/features/feedbackCapture*.ts`, `feedbackDomCapture.ts`                              |
| Runtime targets             | `scripts/runtime-targets.js`                                                                     |
| Performance fixture         | `scripts/feedback-performance-fixture/`                                                          |
| Host integration tests      | `.vscode-test.mjs`, `test/integration/`                                                          |

## Change Pattern

1. Read the task and relevant tests.
2. Add a failing test before implementation.
3. Keep shared message validation versioned and strict.
4. Keep typing callbacks free of Markdown serialization and document-wide loops.
5. Run focused tests, the full suite, lint and release build verification.
6. For runtime changes, test VS Code 1.98.0 and stable. For performance claims, keep the physical Windows/manual evidence separate from CI.

## SVG image boundary

`CustomImage` renders SVG through the existing resource `<img>` path. Unsized SVGs fill the reading column; concrete and authored widths do not. `htmlImageSource.ts` preserves authored HTML image source and explicit dimensions. `svgDisplaySize.ts` changes one image occurrence through ordinary document transactions. `shared/imageSource.ts` separates local paths from URL suffixes, and `editor/imageSourceReferences.ts` edits exact rename references. SVG file imports preserve bytes; raster resize and redo reject vector targets at the host boundary. The real-browser regression is `scripts/svg-image-fixture/run.mjs`.
