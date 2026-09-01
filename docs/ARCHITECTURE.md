# Markdown for Humans Technical Architecture

This document describes the implementation that exists in the repository. Code and tests remain the source of truth.

**Runtime floor:** VS Code 1.98.0

**Extension host target:** Node.js 20

**Webview target:** Chromium 132

**Last verified against the code:** August 26, 2026

## Architecture at a Glance

```text
VS Code desktop
┌──────────────────────────────────────────────────────────────────┐
│ Extension host, Node.js 20                                      │
│                                                                  │
│ extension.ts                                                     │
│   ├─ commands, outline and status integrations                   │
│   └─ MarkdownEditorProvider, CustomTextEditorProvider             │
│        ├─ TextDocument, authoritative editable source             │
│        ├─ per-document DocumentEditCoordinator                    │
│        ├─ Feedback snapshot, transport and durable bundle store   │
│        └─ WebviewPanel lifecycle                                  │
│                         ⇅ validated messages                      │
│ Webview, Chromium 132                                             │
│   ├─ TipTap 3.30.5 on ProseMirror                                 │
│   ├─ DocumentSyncController                                       │
│   ├─ editing, tables, images, math and Mermaid                    │
│   ├─ Feedback review and capture modules                          │
│   └─ small VS Code presentation-state checkpoint                  │
└──────────────────────────────────────────────────────────────────┘
```

Markdown stays a text document. `CustomTextEditorProvider` lets VS Code own save, dirty-state, undo, redo and Git integration while the webview provides the rich editing surface.

## Supported Runtime Boundary

`package.json` declares `engines.vscode: ^1.98.0`. The release build targets the runtimes embedded by that floor:

- `node20` for `dist/extension.js`
- `chrome132` for `dist/webview.js`
- exact `@types/vscode@1.98.0` and Node 20 types for compile-time compatibility

The extension is a workspace extension. It deliberately declares virtual workspaces and untrusted workspaces unsupported because images, exports and Feedback bundles read or write workspace files. The automated Extension Development Host suite is a desktop suite. Remote-host variants need separate qualification before they are advertised as supported.

Development CI uses newer Node.js releases to run tooling. That does not change the Node 20 extension-host target.

## Ownership and Sources of Truth

| Concern                 | Owner                  | Rule                                                                          |
| ----------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| Editable Markdown       | VS Code `TextDocument` | The webview proposes edits; the host accepts or rejects them.                 |
| Rich editor state       | TipTap                 | ProseMirror state is transient and must reconcile with the host.              |
| Save, undo and redo     | VS Code                | All source mutations use `WorkspaceEdit`.                                     |
| Feedback session        | Extension host         | The host owns the frozen snapshot, anchors, lifecycle and durable store.      |
| Feedback presentation   | Webview                | Decorations, cards, selection and capture UI are disposable views.            |
| Hidden-webview recovery | VS Code webview state  | Only selection and scroll are persisted, never Markdown or session authority. |

This separation is important. A queued `Webview.postMessage()` is not proof that the receiver applied it, a hidden webview can be destroyed, and two splits can briefly hold different unsent content. Protocols therefore carry explicit identity and application acknowledgements where correctness depends on delivery.

## Document Synchronization

### Renderer to host

`src/shared/documentSyncProtocol.ts` defines document sync protocol v2. Each renderer lifetime creates a `viewGeneration`. Every versioned edit includes:

- `editId`
- `viewGeneration`
- monotonic `localRevision`
- `baseDocumentVersion`
- normalized Markdown content
- an edit reason

`DocumentSyncController` keeps serialization off the keystroke path. `markDirty()` records a dirty bit and owns at most one 500 ms timer. Markdown is serialized only when the timer drains or an explicit flush/save boundary runs. It does not retain an eager serialized snapshot while images or other prerequisites are pending.

Only one emitted renderer edit can remain unacknowledged at a time. The host returns `document.edit.ack` with the exact edit identity, acceptance result and resulting document version. A replayable ID is bound to an immutable hash of its generation, revisions, reason, predecessor, and content, so conflicting reuse is rejected instead of replaying an unrelated success. A rejection causes an authoritative host replay before later dirty work is sent.

The extension validates the envelope and the current renderer generation, then submits the mutation to `DocumentEditCoordinator`. The coordinator:

- serializes asynchronous work independently for each document URI
- assigns monotonic queue revisions
- coalesces only adjacent, not-yet-started typing edits with the same generation and base version
- never coalesces explicit operations or barriers
- contains failures and cancellation so later queued work can continue

Save, autosave and Feedback snapshot boundaries drain the same queue rather than waiting on an unrelated "latest promise". Explicit save then sends a correlated generation-and-host-version flush barrier to the current renderer, requires accepted application results for any newer revision it emits, drains again, and only then invokes VS Code save. Closing the final panel converts an already-armed custom autosave into a host-owned drain and save rather than cancelling it with the panel timer.

### Applying source edits

For small documents the provider retains the simple whole-document replacement. At 32 KiB and above, it computes one minimal prefix/suffix replacement and applies only that range. Boundaries expand when needed so a range never splits a UTF-16 surrogate pair or CRLF delimiter.

The large-document path reduces undo and diff work without introducing a general-purpose diff engine.

Cosmetic Markdown normalization can suppress a write only after raw HTML-bearing token contexts match source-exactly. This conservative rule preserves edits where inline HTML or CSS makes whitespace significant.

### Host to renderer

Host updates carry the authoritative document version and are tracked per webview split. The host distinguishes the currently pending delivery from the last delivery whose post completed successfully, so an A to B to A document race cannot reuse stale proof that A reached the renderer. Any renderer-origin edit invalidates both delivery proofs. Source-specific echo suppression prevents the originating split from processing its own immediate echo without starving sibling splits.

The renderer also protects an active cursor from an ordinary update for a short recent-edit window. It requests later host reconciliation instead of silently treating its local state as authoritative. Forced recovery and Feedback lifecycle messages bypass these ordinary echo guards.

Do not reintroduce a shared `ignoreNextUpdate` boolean. It cannot identify which asynchronous edit, renderer generation or split produced a change.

## Webview Lifecycle and State Restoration

The custom editor uses `retainContextWhenHidden: false`. Hidden panels may therefore release their DOM, TipTap instance, Mermaid output and screenshot state instead of keeping a full renderer alive for every tab.

Before teardown, the renderer flushes pending document sync and writes a small versioned payload through `vscode.setState()`:

```text
version + documentVersion + { selection.from, selection.to } + scrollTop
```

Writes are coalesced to one animation frame. Restoration happens only after host content initializes, only for the saved document version or the immediate version increment caused by the teardown flush, and with positions clamped to the live document. A second animation-frame scroll correction accounts for layout settling.

If one edit is still awaiting its application ACK while a newer renderer revision is dirty, teardown uses a correlated `document.teardown.edit` instead of dropping the newer revision. The host queues it behind the exact predecessor and accepts it only if that predecessor succeeded and its resulting `TextDocument.version` is still current.

Image insertion uses compact pending destinations instead of retaining a serialized base64 document. The renderer reserves at most 128 concurrent operations before conversion, and the host caps unresolved image state at 128 entries and 64 MiB per view. Image bytes cross the VS Code bridge as a typed array and are copied once into an exact-size host buffer, so a small view cannot retain a larger backing allocation. The host never evicts an unresolved marker to admit new work and releases retained bytes when the write settles.

An `imageSaved` or `imageError` post is not treated as applied until the exact renderer generation atomically updates or removes every matching ProseMirror node and returns a correlated application ACK. False, rejected, or unacknowledged posts retry the same immutable completion. Disposal cancels provider-owned retry timers, while teardown still resolves an exact pending marker to the saved path or bounded data-URI fallback. Unknown or wrong-generation markers reject the edit instead of entering Markdown.

The state parser projects only the fields above. It must not persist document content, Feedback sessions, peer locks, draft data or other host-owned state. Feedback recovery takes precedence over ordinary cursor and scroll restoration.

## Editor Stack and Dependency Policy

### TipTap and ProseMirror

Every direct `@tiptap/*` runtime package is pinned to exactly `3.30.5`, including `@tiptap/core`, `@tiptap/markdown`, `@tiptap/pm`, `@tiptap/starter-kit` and the direct extensions. This is the one-family rule:

1. Upgrade all direct TipTap packages as one tested set.
2. Import ProseMirror APIs through `@tiptap/pm/*`.
3. Do not add a second direct ProseMirror or mixed TipTap version family.
4. Verify serialization, selection mapping, tables, custom NodeViews, bundle output and the full test suite before accepting an upgrade.

TipTap supplies the editor framework, not document authority. Custom extensions preserve Markdown constructs and editor behaviors that the stock schema does not cover by itself.

### Other key libraries

| Library                                       | Current role                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `mermaid@^11.17.2`                            | Render diagrams inside a custom TipTap node.                                  |
| `modern-screenshot@4.7.0`                     | Rasterize bounded Feedback DOM clones.                                        |
| `markdown-it@^14.0.0`                         | Parse saved source for exact Feedback line mapping and semantic verification. |
| `highlight.js@^11.11.1` and `lowlight@^2.9.0` | Code-block highlighting.                                                      |
| `katex@^0.16.9`                               | Inline and display math rendering.                                            |
| `esbuild@^0.28.2`                             | Produce extension-host and browser bundles.                                   |

All webview runtime dependencies are bundled. The webview does not depend on a CDN.

### Upgrade posture

The TipTap family is on the reviewed 3.30.5 security patch. Other available major versions are deliberately separate migrations, not safe mechanical bumps:

| Candidate       | Posture                       | Validation required before adoption                                                          |
| --------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| Babel 8         | Defer                         | Jest transform compatibility, supported tooling Node version and full unit suite.            |
| ESLint 10       | Defer                         | TypeScript ESLint compatibility, configuration migration and zero-warning lint.              |
| TypeScript 7    | Defer                         | VS Code 1.98 API/types compatibility, declaration behavior and full compile/build gates.     |
| KaTeX 0.18      | Defer to an independent slice | Inline/display parsing, malformed formulas, light/dark rendering and CSS/font bundle output. |
| lowlight 3      | Evaluate independently        | CodeBlockLowlight integration, configured languages, round trips and bundle size.            |
| markdown-it 15  | High-risk evaluation          | Feedback raw-token line mapping, semantic block fingerprints, frontmatter and HTML cases.    |
| concurrently 10 | Defer; 9.2.4 is installed     | Version 10 requires Node 22 and ESM. Recheck watch scripts on Windows and Unix separately.   |

Keep `@types/node` on the Node 20 line and `@types/vscode` at 1.98.0 while those are the declared runtime floors. Upgrading either type baseline without raising and retesting the runtime contract can compile code that the minimum host cannot run.

## Feature Modules

The webview entry point is `src/webview/editor.ts`. It composes focused modules rather than putting feature logic into the provider:

- `src/webview/extensions/` contains TipTap extensions for Markdown compatibility, tables, images, math, code blocks, Mermaid and interaction behavior.
- `src/webview/features/` contains dialogs, overlays, export helpers and Feedback controllers.
- `src/webview/utils/` contains serialization, paste, outline and rich-view state helpers.
- `src/webview/BubbleMenuView.ts` owns the visible formatting controls.

The extension side is partway through the same split. Focused modules own document queues, Feedback anchors, snapshot proofs, transport primitives and persistence, while `MarkdownEditorProvider` still contains the production Feedback lifecycle adapter and remains too large. The pure host and renderer lifecycle machines are tested migration models, not yet the production authority.

## Feedback Architecture

Feedback mode reviews one saved source snapshot. It does not create a second editable document model.

### Authoritative snapshot boundary

For snapshot-capable renderers, a new Start and a durable-draft Resume use a two-stage protocol:

1. Every open split reports whether it is dirty and, on this explicit user action, serializes its current Markdown for inspection.
2. If dirty splits have different digests, the host fails before flushing either one.
3. The host flushes all splits, drains the document queue, saves and reads the exact file bytes.
4. `FeedbackSnapshotService` binds the captured `TextDocument` version and UTF-8 text digest to the saved-byte digest.
5. The host applies that same authoritative source to every split. Only the owning split enumerates fresh canonical TipTap blocks after the apply.
6. The service verifies renderer identity, canonical descriptor revision, raw-source block mapping and per-block semantic content fingerprints before a session can start.

Any ambiguity fails closed with `MD4H-FB-SNAPSHOT-001`. An external source change later invalidates the active round, preserves its draft and blocks new mutations and sealing.

### Delivery and lifecycle recovery

`feedback.started` uses an application-level delivery envelope. It is correlated by message, operation, session and stage identities. Delivery retries are idempotent and bounded. If application acknowledgements are lost, the host queries the renderer's actual `applied`, `inactive` or `mismatch` state before deciding whether activation succeeded.

Renderer activation is transactional. Every UI, transaction-filter and DOM effect registers cleanup before the next effect runs; review mode becomes active only after commit, and a preparation or commit failure rolls the complete activation back before the renderer acknowledges it.

Pure host and renderer lifecycle reducers reject stale stage revisions and duplicate transitions in deterministic tests. Production Start, close, recovery and split-lock paths currently use provider and renderer adapters rather than those reducers as their sole authority. Close and recovery handshakes keep peers locked until the authoritative source is applied and released. If a webview reloads, volatile session ownership is not recovered from `setState`; the durable draft remains the recovery authority.

Transferring an already-active round does not freeze a new source. It reapplies the existing frozen source to the proposed owner and reuses the host's verified canonical snapshot. The handoff is generation-bound and application-acknowledged: the new owner stages first, the old owner freezes second, and the host revalidates the exact document version and source digest before sending commit. The host session remains `resuming` until both owners and every peer lock confirm commit, then becomes `active`.

If pre-commit validation changes or fails, both staged renderers receive an idempotent abort and the old owner becomes active only after rollback ACKs. Exhausted apply, commit, or abort delivery terminates the user request without unlocking an ambiguous renderer, while retaining the exact identity for late-ACK recovery. The legacy `feedback.session.transferred` parser remains only for compatibility with an older renderer already alive across an extension-host restart; production no longer sends it.

### Anchors and typed table cells

The host builds one exact map between canonical rich blocks and raw Markdown line spans. Text selections may carry a versioned half-open ProseMirror range. Table selections may instead carry a typed cell target:

- containing table ordinal
- zero-based rectangular row and column coordinates
- renderer table fingerprint
- host-enriched SHA-256 for the containing canonical table block

The host validates that the target is one canonical table block, checks the rectangle shape, and enriches it with that block's SHA-256. The renderer validates the table fingerprint, live row and column bounds, and merged or irregular geometry before drawing cell decorations. Exact per-cell work is capped at 256 cells per item and 4,096 cells per session; larger or later-overflow selections coarsen to whole-table source evidence before cell traversal, fingerprinting, preview, or geometry, with a visible explanation. Per-cell extraction and aggregate structured evidence are independently bounded before traversal. Persisted locators continue to consume the host and store budget until degradation is durably written at seal. A stale cell target becomes a host-origin `stale-locator` degradation with requested scope and original evidence preserved. It is never fuzzy-matched to a similar table. Exact range and cell locators remain in sealed reports only while Finish-time frozen-document validation still proves them. `feedback.finish` may carry a bounded, unique list of degraded item IDs without document content; the host unions that signal with its own fresh validation and the store writes the canonical degraded v2 envelope atomically. Source path, source SHA-256, containing source lines, target metadata, and typed evidence remain distinct authorities. Table coordinates describe the frozen rendered model, not proven raw Markdown cell columns, and cell TSV is a derived projection rather than a literal quote or canonical table representation.

The highlighted document is the canonical Feedback preview. The composer and expanded cards derive bounded renderer-local descriptions from the frozen ProseMirror document: literal excerpts for exact text and partial code, a fixed-size semantic grid for valid cell rectangles, and structural summaries for whole tables, code blocks, opaque NodeViews, and multi-block targets. Renderer-side selection evidence is bounded before traversal. The previews do not parse Markdown or rerun Mermaid, KaTeX, image, or syntax renderers. Complex targets select a stable wide composer preset, ordinary prose stays compact, and an accessible override changes that preset. The feedback input grows only to a viewport-relative cap before scrolling internally and is remeasured after responsive width changes. Wide composers first prefer a collision-free edge of full-width targets; every measured active composer and tall saved-comment edit form clamps below the sticky toolbar and inside the current viewport when its visible target would otherwise leave the form unreachable. While a saved comment is being edited, its card is the only card in the layout and pending Undo controls return after Save or Cancel, so keyboard focus cannot move to an offscreen packed surface.

### Durable bundle

Drafts are written atomically below `.md4h/feedback/` in the workspace folder that contains the source. New rounds use the strict `md4h-feedback/v2` grammar and screenshot items use hash-bound `assets/F<n>.png` files. V2 separates requested and effective target scope from evidence fidelity. Complete source-addressable blocks carry a bounded host-derived source slice when exact source mapping and embedding budgets permit it; otherwise the item records an explicit omission or degradation. Native drags carry exact rendered text plus a rendered locator, regular cell rectangles carry a typed matrix plus derived escaped TSV, and visual sub-regions carry a PNG plus a containing-source reference. Whole tables never use TSV as canonical evidence. Parity-proven GFM and HTML table shapes retain authored source, while unsupported raw-HTML shapes fail closed instead of emitting inaccurate evidence.

The v2 parser validates canonical metadata, block hashes, fingerprints, evidence bodies, byte and cell budgets, screenshot paths, and writer-derived summaries. IDs are monotonic, sealed bundles are immutable, and Resume reparses and revalidates the complete bundle against the retained source and frozen rich model. Sealed v1 bundles remain byte-immutable. A v1 draft migrates atomically only on its first explicit mutation or seal; locator-free Focus remains labelled legacy evidence and is never promoted to exact text or table structure.

Automatic draft discovery is metadata-first. It reads the bounded report, checks exact source identity, contained regular screenshot files, individual size, and cumulative quota, but does not read and hash every PNG during editor startup. Explicit Resume performs full PNG structure and SHA-256 validation before restoring a writable store.

Only fenced `### Feedback` text is an instruction to an agent. Target summaries, selected source, rendered text, typed cells, legacy Focus, and screenshot pixels are untrusted evidence. See the user-facing bundle contract in `README.md` for the complete grammar.

### Bounded, cancelable capture

Feedback screenshot capture uses a DOM clone, not an Electron compositor:

- the crop must intersect mapped, visible top-level blocks
- annotation UI and editor controls are filtered from the clone
- fonts, images and intersecting Mermaid output must settle before rasterization
- cancellation or session invalidation propagates through an `AbortSignal`
- staging is capped at 4,096 rendered nodes and 1,024 resource references
- large intersecting tables and nested lists are shallow-cloned to intersecting rows, cells and items, with fixed-size spacers preserving crop geometry and ordered-list numbering
- row-span tables use the existing bounded fail-closed path rather than producing an invalid partial table
- resources outside the VS Code webview boundary fail closed
- output is capped at 12 megapixels and 10 MiB
- the host performs a bounded PNG structure, dimension, path and hash validation

Every success, error, retry, Retake, Cancel and invalidation path must restore suspended annotations and release temporary resources.

## Performance Architecture

Performance is controlled by work-count contracts first, then measured on target hardware.

Implemented hot-path protections include:

- zero Markdown serialization in the immediate typing transaction path
- one debounce timer and one serialization/send when a burst drains
- immutable ProseMirror top-level node caching, so an edit can reserialize only changed blocks after the initial pass
- serialized host edits with compatible pending typing coalescing
- minimal source ranges for documents of at least 32 KiB
- one source-line index per Feedback snapshot finalization instead of one full-document split per canonical block
- metadata-first draft discovery with screenshot bytes deferred to explicit Resume
- annotation layout indexed once by source line, with geometry reads bounded to annotated targets
- no annotation layout work on ordinary document scroll
- bounded screenshot DOM and resource traversal
- hidden-webview teardown with small presentation-state restoration

The deterministic harness in `scripts/feedback-performance-fixture/` exercises production sync and layout code against 3,000-word and 10,000-line corpora, 500 Feedback items and 10,000 typing transactions. It gates algorithmic work counts on Ubuntu and Windows CI. It deliberately does not use shared-runner milliseconds as a proxy for an i5/16 GB machine.

The product budgets remain:

| Metric                             |                        Budget |
| ---------------------------------- | ----------------------------: |
| Editor initialization              |                  under 500 ms |
| Typing latency                     |                   under 16 ms |
| Cursor and formatting interactions |                   under 50 ms |
| Menu and toolbar actions           |                  under 300 ms |
| Large-document target              | 10,000 or more lines smoothly |

Physical Windows p95 timings, memory snapshots, long-form reading and high-DPI capture checks remain manual release evidence.

## Security and Resource Boundaries

- Webview HTML uses a nonce-based Content Security Policy and explicit `localResourceRoots`.
- Extension and renderer message boundaries parse untrusted data before dispatch. Feedback protocols reject unknown fields rather than spreading arbitrary objects.
- Workspace paths are resolved and checked for containment before file operations.
- Screenshot data, identifiers, item counts and source sizes are bounded.
- Release builds bundle runtime dependencies and exclude development fixtures, source and test assets from the VSIX.
- Virtual and untrusted workspaces are explicitly unsupported.

Local file access is limited to the extension and the exact containing workspace folder, or the document directory for a standalone file. Image URI requests are resolved and containment-checked against those roots before `asWebviewUri` is called. A custom-editor request cancelled before resolution initializes no panel state. Reviewing whether every broad remote, data, and blob image CSP source is still required remains a security follow-up.

## Testing and CI

The repository has a substantial automated suite, not a test placeholder.

| Layer                              | What it covers                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| Jest unit tests                    | Pure reducers, protocols, queues, stores, path rules and serializers.                |
| jsdom webview tests                | Dialogs, capture, toolbar, message boundaries and lifecycle cleanup.                 |
| Real TipTap/ProseMirror tests      | Selection mapping, decorations, table cells, serialization and transaction behavior. |
| Fixture runners                    | Feedback capture, annotation geometry and deterministic performance contracts.       |
| VS Code Extension Development Host | Real activation, command registration and `TabInputCustom` behavior.                 |
| Release build verification         | Runtime targets, artifact boundaries, source-map policy and size ceilings.           |

CI runs:

- unit, coverage, lint and release build jobs on Ubuntu
- deterministic performance gates on Ubuntu and Windows
- real Extension Development Host smoke tests on Ubuntu and Windows against VS Code 1.98.0 and current stable
- VSIX packaging only after those jobs pass

These automated matrices do not replace a physical Windows i5/16 GB performance pass, a 10-minute read of a 3,000-word document in light and dark themes, or physical DPI/accessibility checks.

## Build and Packaging

```sh
npm ci
npm run lint
npm test -- --runInBand
npm run build:release
npm run test:integration
npm run package:release
```

`build:release` creates minified bundles without source maps and runs `scripts/verify-build.js`. The extension bundle is CommonJS with `vscode` externalized. The webview is a self-contained browser IIFE with bundled styles and font assets.

Never publish directly from an unverified working tree. The repository instructions also prohibit agents from committing or pushing.

## Key Files

| Concern                            | File                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| Activation and commands            | `src/extension.ts`                                                                           |
| VS Code custom editor adapter      | `src/editor/MarkdownEditorProvider.ts`                                                       |
| Per-document edit serialization    | `src/editor/documentEditCoordinator.ts`                                                      |
| Minimal large-document edit        | `src/editor/minimalTextEdit.ts`                                                              |
| Document sync protocol             | `src/shared/documentSyncProtocol.ts`                                                         |
| Renderer debounce and ACK state    | `src/webview/documentSyncController.ts`                                                      |
| TipTap composition                 | `src/webview/editor.ts`                                                                      |
| Markdown sync serialization        | `src/webview/utils/markdownSerialization.ts`                                                 |
| Hidden-view presentation state     | `src/webview/utils/richViewState.ts`                                                         |
| Feedback request/response contract | `src/shared/feedbackProtocol.ts`                                                             |
| Feedback snapshot protocol         | `src/shared/feedbackSnapshotProtocol.ts`                                                     |
| Feedback delivery protocol         | `src/shared/feedbackDeliveryProtocol.ts`                                                     |
| Snapshot proof                     | `src/editor/feedbackSnapshotService.ts`                                                      |
| Feedback transport                 | `src/editor/feedbackTransport.ts`                                                            |
| Feedback durable store             | `src/editor/feedbackSessionStore.ts`                                                         |
| Feedback renderer                  | `src/webview/features/feedbackReview.ts`                                                     |
| Feedback activation transaction    | `src/webview/features/feedbackActivationController.ts`                                       |
| Host and renderer lifecycle        | `src/editor/feedbackLifecycleMachine.ts`, `src/webview/features/feedbackLifecycleMachine.ts` |
| Typed Feedback selection mapping   | `src/webview/features/feedbackSelectionMapping.ts`                                           |
| Feedback snapshot client           | `src/webview/features/feedbackSnapshotClient.ts`                                             |
| Feedback capture                   | `src/webview/features/feedbackCapture*.ts`, `feedbackDomCapture.ts`                          |
| Runtime build targets              | `scripts/runtime-targets.js`                                                                 |
| Deterministic performance fixture  | `scripts/feedback-performance-fixture/`                                                      |
| Desktop host tests                 | `.vscode-test.mjs`, `test/integration/`                                                      |

## Change Rules

- Treat the `TextDocument` and host-owned Feedback snapshot as authority.
- Add protocol fields through a versioned shared parser and cover malformed, stale and duplicate messages.
- Keep every direct TipTap dependency on one exact version family.
- Do not serialize Markdown from a keystroke callback.
- Put every document mutation and ordering barrier through the coordinator.
- Keep webview state presentation-only and bounded.
- Add performance work-count tests before adding a new loop over document nodes, blocks, annotations or resources.
- Verify behavior at VS Code 1.98.0 as well as current stable.

## Known Qualification Gaps

The architecture has automated cross-platform gates, but the following evidence is still physical or manual:

- p95 startup, typing, formatting and capture timings on the reference Windows i5/16 GB machine
- memory and long-session profiling on that machine
- 3,000-word, 10-minute reading checks in light and dark themes
- high-DPI, zoom, keyboard-only and assistive-technology review
- remote extension-host qualification if remote use becomes a supported product target
