# Task: Follow-ups found during the post-merge fix chunks

## 1. Task Metadata

- **Task name:** Post-merge follow-ups (out of scope for chunks 01 to 07)
- **Slug:** followups-postmerge
- **Status:** planned
- **Created:** 2026-10-01
- **Last updated:** 2026-10-01
- **Shipped:** _(pending)_
- **Base:** `origin/main` @ `39dfe56`
- **Overview:** `task-fix-postmerge-00-overview.md`

Each item was found and verified while fixing the post-merge review chunks, but predates those chunks or sits outside their scope. Each item is small enough to become its own branch. Ordered by priority. Line numbers refer to `39dfe56`; locate code by symbol.

---

## 2. Items

### FU1. HIGH (security): image handlers still use lexical-only path containment

- **Where:** `src/editor/MarkdownEditorProvider.ts`, about 10 call sites of `isPathContainedWithin` in the rename, resize, reveal and metadata image handlers.
- **Defect:** containment is checked on the path string only. A symlink committed in a cloned repository can point outside the workspace and the check passes.
- **Impact:** the file-writing handlers (rename, resize) can write outside the workspace roots.
- **Context:** chunk 02 added a realpath-based `resolveContainedImageSource()` for preview and export. Reuse it here.
- **Test first:** a workspace symlink to an outside folder; rename and resize through it are refused.

### FU1b. HIGH (data loss): text after a line break inside a task item is dropped on reopen

- **Found by:** the chunk 01 decision #3 agent while probing hard breaks (pre-existing on `origin/main`).
- **Repro:** `- [ ] task\` followed by a newline and `x` (a backslash break inside a task item). Reopen the file: the text after the break is gone.
- **Impact:** silent content loss in task lists, a common pattern in notes and plans.
- **Test first:** real-editor round-trip for task items with each break form (soft, two spaces, backslash, `<br>`), asserting the text survives save and reopen.

### FU2. MED: Word export drops every image

- **Where:** `src/features/documentExport.ts`, `parseParagraphChildren` and the `ImageRun` construction.
- **Defects:**
  - Only an `<img>` that is a direct child of the paragraph is handled. The editor always wraps images in `span.image-wrapper`, so every image is dropped as plain text.
  - `ImageRun` from docx 9 needs an explicit `type` ('png', 'jpg' and so on). It is never passed, so media is stored with the extension `.undefined`.
- **Test first:** turn the existing `it.todo('embeds an in-root image in Word export')` in `src/__tests__/features/documentExportPdfImages.test.ts` into a real test using the real editor DOM.
- **Verify in real VS Code:** export a document with an in-root PNG and SVG; open the .docx and check `word/media/`.

### FU3. MED: list style is rewritten on save (decision #11)

- **Where:** `src/webview/extensions/orderedListMarkdownFix.ts`, `markdownListItem.ts`.
- **Defects:** a loose list becomes tight (`- item\n\n  1. nested` saves as `- item\n  1. nested`), and `1)` delimiters become `1.`.
- **Impact:** noisy diffs on existing documents after any edit.
- **Context:** pinned as "known serializer rewrites" in the chunk 01 corpus test; flip those rows when fixed.
- **Also:** continuation lines lose their indentation (`- item\n  more` saves as `- item\nmore`, a lazy continuation with the same structure). This is pinned in the corpus too.
- **Fix direction:** record looseness, delimiter and continuation indent on the list node at parse time and serialize them back, the same pattern as the hard-break form in decision #3.

### FU3b. LOW: a line break inside a heading reopens as a paragraph

- **Defect:** ATX headings are single-line in Markdown. A break created in a heading (Shift+Enter) saves as two spaces plus a newline, so the text after it reopens as a separate paragraph.
- **Fix direction:** decide between blocking hard breaks inside headings, or writing them as `<br>` (renders the same on GitHub).

### FU4. MED: image rename falls back to permanent delete without asking

- **Where:** `handleRenameImage` in `src/editor/MarkdownEditorProvider.ts` (uses `useTrash: true`).
- **Defect:** when Trash is unsupported (Remote-SSH, WSL, dev containers), it deletes permanently with no confirmation.
- **Fix direction:** reuse chunk 05's `deleteFeedbackBundle` pattern: a second modal before any permanent delete.

### FU5. LOW (security hardening): editor init error rendered as HTML

- **Where:** `initializeEditor` in `src/webview/editor.ts` writes `error.message` into `innerHTML`.
- **Defect:** ProseMirror "Invalid content" errors can include up to 50 characters of document text, so document text reaches markup. The CSP blocks scripts, but markup injection is possible.
- **Fix direction:** a 3-line `textContent` change. The only existing harness mocks the whole editor module, so add a small focused test.

### FU6. LOW: closing the TOC scrolls the selection into view

- **Where:** `hideTocOverlay(editor, false)` calls `editor.commands.focus()`, which scrolls one frame later. This contradicts the "without moving Feedback's invoking focus or scroll" note on `closeIncompatibleFeedbackSurfaces` in `src/webview/editor.ts`.
- **Fix direction:** focus with `preventScroll`, and keep the scroll position when Feedback closes the TOC.

### FU7. LOW: false conflict warning for authored two-space breaks (decision #4 residual)

- **Context:** decision #3 (chunk 01) keeps each hard break in its authored form, so new and soft breaks no longer trip `files.trimTrailingWhitespace`. Two-space breaks that users authored themselves are still trimmed by their own setting. If that lands while they type, the chunk 03 conflict warning appears and the resend restores the spaces.
- **Fix direction:** if it is still seen in practice, detect a save participant edit that only removes trailing whitespace from hard-break lines, and accept it silently.

### FU8. LOW: flaky tests under parallel load

- **Tests:**
  - `src/__tests__/webview/feedbackDomCapture.test.ts` "bounds layout reads when staging a tiny crop from 10,000 ordered blocks"
  - `codeHighlightingProjectionLifecycle` timeouts
- **Behavior:** both pass alone and fail intermittently in a full parallel `npm test`.
- **Fix direction:** replace wall-clock budgets with work counters, as chunk 06 did for its new performance tests.

---

## 3. Progress

| ID | Test | Fix | Verified in VS Code |
|---|---|---|---|
| FU1 | | | |
| FU1b | | | |
| FU2 | | | |
| FU3 | | | |
| FU3b | | | |
| FU4 | | | |
| FU5 | | | |
| FU6 | | | |
| FU7 | | | |
| FU8 | | | |
