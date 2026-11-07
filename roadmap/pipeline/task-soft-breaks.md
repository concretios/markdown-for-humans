# Task: CommonMark soft breaks

## 1. Task Metadata

- **Task name:** Render a single newline as a soft break
- **Slug:** soft-breaks
- **Status:** planned (TODO, not started; to be done on its own branch)
- **Created:** 2026-10-10
- **Last updated:** 2026-10-10
- **Shipped:** _(pending)_
- **Issue:** #69

---

## 2. Context & Problem

**Current state:**
- `src/webview/editor.ts` configures the Markdown parser with `breaks: true`, so every single newline inside a paragraph becomes a visible line break.
- A paragraph hard-wrapped at 80 columns therefore shows one short line per source line. Confirmed on 0.4.3 in VS Code 1.141.0 (native, 2026-10-10).
- CommonMark and GFM treat a single newline as a soft break (a space). VS Code's built-in preview and GitHub render it that way.

**Pain points:**
- **Hard-wrapped documents look broken:** most READMEs and product docs are hard-wrapped.
- **Open promise:** PRs #70 and #99 were closed on 2026-10-01 with the note that soft breaks were "being fixed in the serializer". The save path was fixed (unedited blocks are written back byte for byte since 0.4.1); the rendering was not.

**Why it matters:**
- Reading experience is the product's first constraint, and this affects every hard-wrapped file a user opens.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- With the new mode on, a hard-wrapped paragraph flows as one paragraph on screen.
- Saving a file the user did not edit leaves it byte identical; editing elsewhere in a wrapped paragraph keeps its wrap points.
- Explicit hard breaks (two trailing spaces, backslash) still break.
- Feedback starts and finishes on hard-wrapped documents in both modes.

**In scope:**
- A setting (PR #99 used `markdownForHumans.render.singleLineBreaks`), default unchanged at first.
- Flipping the default in a later minor release, once the mode has been used in the wild.

**Out of scope:**
- Reflowing or rewrapping the source text.

---

## 4. Approach (from the prior work)

Two approaches were tried and failed:
- Setting only `breaks: false` changes nothing on screen: the newline stays inside the text node and the editor's `white-space` rule still draws it (PR #70).
- Joining lines at parse time flows on screen but rewrites every wrapped paragraph on save.

The approach that works is in PR #99 (closed unmerged, about 600 lines with tests, kept on branch `cursor/soft-breaks-retest-ad7a`):
- `src/webview/extensions/softBreak.ts`: an inline `SoftBreak` node that renders as a space and serializes back to the original newline.
- `src/webview/utils/markedLexerNormalizer.ts`: emits `softbreak` tokens for bare newlines when the mode is on; hard breaks, code and code spans are untouched.
- The setting is read in `MarkdownEditorProvider` and passed to the webview.

**State of that branch on 2026-10-10:** a trial merge into `main` (`git merge-tree`) conflicts in two files only, `CHANGELOG.md` and `src/webview/editor.ts`.

---

## 5. Work still to do

- [ ] Port PR #99 onto current `main` (credit the original authors as co-authors).
- [ ] Feedback: `src/editor/markdownAstEquivalence.ts` compares the saved file against the editor using the "newline is a line break" contract (`rendererMd` with `breaks: true`). It, `feedbackAnchors.ts` and `feedbackSnapshotService.ts` must follow the active mode.
- [ ] Review the other places that assume the current behavior: `pasteHandler.ts`, `markdownSerialization.ts`, `tableCellEnterHardBreak.ts`, `githubAlerts.ts`, `imageEnterSpacing.ts`, search across a wrap point, word count, and PDF and Word export.
- [ ] Tests first: round trip in both modes (displayed text and saved text), edit elsewhere keeps the wrap, edit at a wrap point, lists, blockquotes and table cells, Feedback start on a hard-wrapped fixture.
- [ ] Native pass in VS Code: read a long hard-wrapped document in both themes; type and delete across a wrap point (needs a human, computer use cannot type in VS Code).
- [ ] README settings table, `CHANGELOG.md`, and a reply on #69.

**Estimate:** two to four working days. Risk sits in the Feedback comparison and in edits made exactly at a wrap point.

---

## 6. Decisions

- 2026-10-10: logged as a TODO for a separate branch; not part of 0.4.3 or the README work. Release slot not yet chosen.
- Recommendation on file: ship behind the setting with the default unchanged, then make CommonMark behavior the default in the following minor release.
