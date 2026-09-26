# VS Code Integration

> Current custom-editor patterns, VS Code limitations and the checks required for platform changes.

## Compatibility Boundary

- Minimum supported VS Code is 1.98.0.
- The extension bundle targets Node.js 20.
- The webview bundle targets Chromium 132.
- `@types/vscode@1.98.0` and Node 20 types are intentional compatibility baselines, not routine upgrade targets.
- The extension runs as `extensionKind: ["workspace"]`.
- Virtual and untrusted workspaces are explicitly unsupported because core workflows require trusted file access.

When using a newer VS Code API, first verify that it exists at 1.98.0. Test the resulting bundle at that floor and current stable.

## Why `CustomTextEditorProvider`

Markdown is text, so the provider uses `CustomTextEditorProvider` rather than a binary `CustomEditorProvider`.

This keeps:

- `TextDocument` as the authoritative editable source
- VS Code save, dirty-state, undo and redo behavior
- normal Git diffs and workspace change events
- file and untitled Markdown selectors

All source changes must use `WorkspaceEdit`. Do not write the Markdown file behind the open `TextDocument`.

The provider registers:

```text
view type: markdownForHumans.editor
supportsMultipleEditorsPerDocument: true
enableFindWidget: true
retainContextWhenHidden: false
```

Multiple-editor support is a real architecture requirement. Never keep URI-wide state when the behavior is panel-specific.

## Extension Activation and Disposal

- Keep `extension.ts` focused on registration and thin command forwarding.
- Push every VS Code disposable into the extension context or an owned disposable aggregate.
- Dispose provider-owned queues, transports, timers and waiters explicitly.
- Do not rely on `deactivate()` for panel-scoped cleanup; panel disposal is the real boundary.
- A custom editor does not appear as a normal `activeTextEditor`. Track the active webview panel through custom-editor view-state events.

The real Extension Development Host suite proves that the shipped bundle activates, registers its command, opens as `TabInputCustom`, survives one split closing, persists a `WorkspaceEdit`, and reopens the shared document.

## Webview Lifecycle

VS Code may destroy a hidden webview when `retainContextWhenHidden` is false. This is intentional to avoid retaining TipTap, Mermaid and capture state for every hidden tab.

Before teardown, the renderer:

1. flushes pending document sync
2. writes a bounded presentation checkpoint with `vscode.setState()`

The checkpoint contains only schema version, host document version, selection and scroll position. Writes are coalesced to an animation frame. Restore occurs after authoritative host content and accepts only the same document version or the one version increment caused by the teardown flush.

Do not persist Markdown, Feedback sessions, locks or drafts in webview state. The extension host and durable Feedback store remain authoritative after a reload.

## Message Delivery Rules

Extension and webview contexts communicate only through message passing. Treat both directions as untrusted boundaries.

- Define shared discriminated unions and strict parsers for correctness-critical messages.
- Reject malformed versions, unknown fields, invalid identifiers and stale identity before effects.
- Keep payload sizes bounded.
- Authorize the sender against the current document, panel and renderer generation.

`webview.postMessage()` confirms queueing, not application. Correctness-critical state requires an application-level ACK and idempotent retry. Feedback activation also uses a renderer-status query after ACK exhaustion.

## Document Sync

Document sync protocol v2 carries:

```text
editId + viewGeneration + localRevision + baseDocumentVersion + content + reason
```

The renderer serializes only after a 500 ms quiet period or an explicit flush. It waits for the exact `document.edit.ack` before later dirty work derives from the accepted host version.

The provider validates the generation and sends every accepted mutation through `DocumentEditCoordinator`. Coalescing is allowed only for adjacent pending typing from the same generation and base version. Save, autosave, Feedback and recovery use ordered barriers.

Host updates carry `documentVersion`, use per-webview delivery caches, and request reconciliation if an ordinary recent-edit guard delays application. Do not implement synchronization with `ignoreNextUpdate`.

## Save and Autosave

VS Code owns explicit save. The webview always forwards its save request even if
an older edit still awaits acknowledgement. The provider drains that work,
sends a correlated host-version flush barrier to the current renderer generation,
requires any revision emitted by the barrier to be accepted, drains again, and
only then calls `save()` on the captured `TextDocument`. Do not use the global
save command after an asynchronous wait because focus may have moved to another file.

Custom-editor focus does not behave exactly like a normal `TextEditor` for `files.autoSave` focus modes. The provider bridges panel and window focus changes by flushing the active rich view, draining the edit queue and saving only after the `TextDocument` is current.

Keep save policy separate from source mutation:

- `WorkspaceEdit` updates the in-memory document and undo stack.
- `document.save()` or the VS Code save command persists it.
- A timer must wait for the exact queued edit it intends to save.

## Split Views and Feedback

Every live split is registered under the shared document URI, but panel-specific state stays panel-specific.

Before Feedback starts:

- all splits report dirty state and current content
- divergent dirty digests fail before any flush
- all pending edits drain through the shared document queue
- the exact saved source is applied to every split
- only the owner enumerates canonical blocks after authoritative apply

During a host-owned Feedback transition, sibling splits are locked and recover from exact host content. Closing one split must not dispose the shared document queue, autosave state or active session while another split survives.

## Webview Security and Resources

- Use a nonce-based Content Security Policy.
- Keep `localResourceRoots` as narrow as the feature requires.
- Convert allowed local files with `webview.asWebviewUri()`.
- The webview has browser APIs, not Node.js filesystem authority.
- Validate links, paths, data URLs and host messages before use.
- Do not load runtime scripts from a CDN.

Screenshot capture must reject resources unavailable through the webview boundary. It must not use Electron `WebContents` or capture VS Code chrome.

## Commands and Keybindings

- Contribute commands in `package.json` and register the same IDs once in `extension.ts`.
- Scope editor-only keybindings with `activeCustomEditorId == 'markdownForHumans.editor'`.
- Follow platform conventions and avoid claiming common chords.
- Prefer visible toolbar or inline actions for frequent editing work.
- Feedback commands are discoverable but intentionally have no default shortcuts.
- Host commands that depend on selection should forward to the active webview, which owns the live ProseMirror selection.

## Configuration

- Provide typed defaults, ranges or enums in `package.json`.
- Use resource scope when multi-root folders may need different values.
- Read document-scoped settings with the document URI.
- Send only renderer-relevant values through validated settings messages.
- Reapply live-safe settings without rebuilding the editor; clearly document settings that require reopening because they change the TipTap extension set.

## Testing Matrix

Fast unit tests cover adapters, message protocols and provider behavior. Platform integration uses the official desktop runner configured by `.vscode-test.mjs`.

CI runs real Extension Development Host tests on:

| Operating system | VS Code versions  |
| ---------------- | ----------------- |
| Ubuntu           | 1.98.0 and stable |
| Windows          | 1.98.0 and stable |

Run locally with:

```sh
VSCODE_TEST_VERSION=1.98.0 npm run test:integration
VSCODE_TEST_VERSION=stable npm run test:integration
```

On Linux CI the command runs under `xvfb-run`. The VSIX excludes the integration workspace, downloaded test hosts, source maps and nested VSIX artifacts.

## What CI Does Not Prove

The host matrix proves desktop API compatibility and critical custom-editor wiring. It does not prove:

- physical Windows i5/16 GB latency or memory use
- high-DPI and assistive-technology behavior
- remote extension-host compatibility
- every VS Code-derived editor such as Cursor, Windsurf or VSCodium
- long-form light/dark reading quality

Keep those results separate and manual until a dedicated automated environment exists.

## Quick Change Map

| Change                     | Files to inspect                                                    |
| -------------------------- | ------------------------------------------------------------------- |
| Custom editor registration | `src/editor/MarkdownEditorProvider.ts`, `package.json`              |
| Command or keybinding      | `src/extension.ts`, `package.json`                                  |
| Document message           | `src/shared/documentSyncProtocol.ts`, provider, renderer            |
| Feedback message           | `src/shared/feedback*Protocol.ts`, provider, renderer               |
| Hidden-view state          | `src/webview/utils/richViewState.ts`, `src/webview/editor.ts`       |
| Autosave or save boundary  | provider, `src/__tests__/editor/autoSave.test.ts`                   |
| Split-view lifecycle       | provider, Feedback split tests, Extension Host suite                |
| VS Code floor              | `package.json`, runtime targets, types, test matrix, build verifier |

For every integration change, add the smallest failing test at the lowest useful layer, then run focused tests, the full suite, lint, the release build and the real host matrix appropriate to the risk.
