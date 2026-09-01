# Common Pitfalls to Avoid

> Known failure modes and the implementation patterns that prevent them. See `AGENTS.md` for the canonical workflow.

## 1. Using `ignoreNextUpdate` for Document Sync

**Failure:** One global boolean cannot identify which asynchronous edit, webview split or renderer lifetime produced a change. It can suppress a real external update or allow an older completion to overwrite newer content.

**Use instead:**

- document sync protocol v2 identity: `editId`, `viewGeneration`, `localRevision`, `baseDocumentVersion`
- exact `document.edit.ack` correlation
- per-webview delivery and echo tracking
- authoritative replay after rejection or a skipped recent-edit update

Never add an uncorrelated feedback-loop flag back to the provider or renderer.

## 2. Serializing Markdown on Every TipTap Update

**Failure:** `onUpdate` runs on the typing path. Serializing a large document there makes keystroke cost proportional to document size, even if a later debounce drops the value.

**Use instead:** Call `DocumentSyncController.markDirty()`. It stores a dirty bit and serializes the latest editor state only when the 500 ms timer drains or an explicit flush boundary runs.

For repeated syncs, preserve immutable ProseMirror node identity so unchanged top-level block serialization can be reused. Never cache a failed serialization result as authoritative content.

## 3. Applying Async `WorkspaceEdit`s Without Ordering

**Failure:** Fire-and-forget edits can complete out of order. Waiting on a single "latest promise" can also report idle while an older edit still runs.

**Use instead:** Put every document mutation through `DocumentEditCoordinator` and use its barrier for save, snapshot and recovery boundaries.

Typing coalescing is safe only for adjacent pending entries with the same renderer generation and base document version. Started work, explicit operations and barriers are immutable.

For explicit save, a queue drain alone is insufficient. An older renderer edit
can be in flight while a newer revision remains dirty and unsent. Drain first,
send a correlated host-version flush barrier to that renderer generation, require
accepted application results for any emitted edit, drain again, and only then save.

## 4. Replacing an Entire Large Document for a Tiny Change

**Failure:** Whole-buffer edits increase VS Code undo, diff and allocation work on large files.

**Use instead:** At 32 KiB and above, compute the single minimal prefix/suffix replacement. Keep UTF-16 surrogate pairs and CRLF delimiters intact at range boundaries. Do not add a full diff engine without measured evidence that one replacement is insufficient.

## 5. Treating `postMessage()` as Application Success

**Failure:** A true result means VS Code accepted a message for delivery. The renderer may reload, reject the payload or fail while applying it.

**Use instead:** For correctness-critical state, require a versioned application ACK with exact operation, session and stage identity. Retried effects must be idempotent and bounded. When ACKs are exhausted, reconcile against renderer-reported state before failing or rolling back.

## 6. Building Feedback Anchors Before the Saved Source Is Authoritative

**Failure:** Canonical blocks enumerated before pending edits flush can describe a different document from the saved bytes and raw line map.

**Use instead:**

1. inspect every split and reject divergent dirty contents
2. flush all splits and drain the document queue
3. save and read exact bytes
4. apply the saved source to every renderer
5. enumerate canonical blocks only from the owner after that apply
6. verify source, renderer and per-block semantic fingerprints

Any ambiguity must fail closed with the snapshot error. Never fuzzy-match a similar block to make a round start.

## 7. Assuming One Webview per Document

**Failure:** VS Code supports multiple custom editors for the same document. A URI-wide delivery cache can leave a sibling stale, and two dirty splits can contain different unsent Markdown.

**Use instead:** Track webviews per document, keep delivery caches per webview, lock peers during host-owned Feedback transitions, and inspect all split contents before freezing a snapshot.

## 8. Persisting Authority in `vscode.setState()`

**Failure:** Hidden webviews can be destroyed and recreated. Persisting Markdown, Feedback sessions or locks in renderer state creates a second source of truth that can outlive the host state it describes.

**Use instead:** Persist only the versioned document version, selection and scroll position. Restore after host content initializes, clamp positions, reject stale versions and let Feedback recovery override presentation restoration.

The custom editor intentionally uses `retainContextWhenHidden: false` to release hidden renderer memory.

A teardown flush cannot simply ignore `DocumentSyncController.flush()` returning
`blocked`. If a newer dirty revision depends on one in-flight edit, pipeline it
with the exact predecessor identity. The host may apply it only after that
predecessor succeeds and its resulting document version is still current.

## 9. Breaking Cursor Position During Host Reconciliation

**Failure:** `setContent()` replaces the ProseMirror document and may invalidate the previous selection.

**Use instead:** Save `{ from, to }`, apply host content, then restore the exact selection or clamp to a safe live position. Forced host recovery may bypass ordinary recent-edit guards, but it must still preserve or safely repair selection.

## 10. Mixing TipTap or ProseMirror Families

**Failure:** Mixed TipTap versions can duplicate ProseMirror packages, break `instanceof` and selection semantics, and increase the bundle.

**Use instead:** Keep every direct `@tiptap/*` package exactly aligned at 3.30.5 and import ProseMirror APIs from `@tiptap/pm/*`. Upgrade the family as one reviewed change and run serialization, NodeView, table, selection and bundle checks.

## 11. Treating Table Cells as Generic Text Ranges

**Failure:** ProseMirror table selections have structural meaning that a flat text range cannot preserve, especially with merged or irregular cells.

**Use instead:** Use the typed rectangular cell target, validate row/column bounds and the table fingerprint, and bind it to the host SHA-256 of the containing canonical table block. If restored metadata is stale, degrade visibly to the containing block. Never guess another table or rectangle.

## 12. Unbounded Screenshot Traversal

**Failure:** Cloning a large DOM or waiting on unlimited resources can freeze a constrained machine and keep work alive after Cancel or session invalidation.

**Use instead:**

- pass the capture `AbortSignal` through clone, resource, Mermaid, frame and raster waits
- cap staging at 4,096 nodes and 1,024 resource references
- capture only mapped visible intersections
- reject resources outside the webview boundary
- enforce 12 MP and 10 MiB output ceilings
- restore annotations and release temporary resources on every terminal path

## 13. Assuming Mermaid Is Synchronously Ready

**Failure:** Mermaid rendering is asynchronous. Capturing or measuring its placeholder produces incorrect evidence and geometry.

**Use instead:** Wait for the explicit pending, ready or error lifecycle of intersecting Mermaid wrappers. A render error or bounded timeout must fail visibly instead of capturing a placeholder.

## 14. Hard-Coding Theme Colors

**Failure:** Literal colors break light, dark and high-contrast themes.

**Use instead:** Use VS Code theme variables for adaptive colors.

```css
.editor {
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
}
```

See `vibe-coding-rules/styling.md` for the complete styling contract.

## 15. Calling a Shared-Runner Timing a Windows Performance Proof

**Failure:** Hosted CI hardware does not represent the reference Windows i5/16 GB machine, and elapsed thresholds become noisy.

**Use instead:** Gate deterministic work counts in Ubuntu and Windows CI, then collect p95 timings, memory snapshots, high-DPI capture and long-form reading evidence on the physical reference machine. Report these as separate automated and manual results.
