# QA findings against 0.4.1 (main @ f448a4e)

**Source:** real VS Code 1.140.0 Extension Host run on 2026-10-04, 207 cases, 192 pass, 15 fail. The 15 failures reduce to the 10 findings below plus 5 already in `KNOWN_ISSUES.md`.

**Status:** hotfix branch `hotfix/qa-0.4.1-findings`, uncommitted. F1 to F6 and F9 are fixed with regression tests; F7 and F10 are documented in `KNOWN_ISSUES.md`; F8 needs a product decision; F11 is new and open. Ordered by severity. Each item has a repro, expected vs actual, where to look first (suspected, not verified), and the test that caught it.

**Method note:** every finding was observed through real keystrokes and mouse events in the actual webview, then checked against the `TextDocument` and disk. Browser-only or JSDOM checks would not have caught F1 to F3, because rendering was correct and only the saved bytes were wrong.

---

## Summary

| ID | Severity | Title | Status |
|---|---|---|---|
| F1 | High | Closing tags deleted from HTML wrapper blocks that contain blank lines | **Fixed**, verified in VS Code |
| F2 | High | Undo past the loaded state empties the document | **Fixed**, verified in Jest; VS Code case now gets past the restore step (see F11) |
| F3 | Medium | Inline raw HTML (`<kbd>`) stripped from an edited paragraph | **Fixed** for `kbd`, `sub`, `sup` |
| F4 | Medium | Copy as Markdown splits inline marks into separate paragraphs | **Fixed**, verified in VS Code |
| F5 | Medium | First right-click on a table cell does not open the table menu | **Fixed**, verified in VS Code |
| F6 | Low | Angle-bracket autolinks rewritten in an edited paragraph | **Fixed**, verified in VS Code |
| F7 | Low | Trailing newline appended to a file that had none | By design (MD047); **documented** in KNOWN_ISSUES |
| F8 | Low | Plain click on a link opens the browser (manual says it should not) | **Open, needs a decision** |
| F9 | Low | Link tooltip advertises Cmd+K, only Cmd+K then Cmd+L works | **Fixed** (tooltip). Wiki still says Cmd+K, see below |
| F10 | Low | Typed bare fence is saved as `plaintext` | By design (`defaultLanguage`); **documented** in KNOWN_ISSUES |
| F11 | Medium | Undoing back to the original text leaves the tab marked dirty | **New, open** |

---

## F1 (High): closing tags deleted from HTML wrapper blocks

**Repro** (file `a.md`):

````markdown
# Title

<div align="center">

**bold**

</div>

Tail paragraph.
````

1. Open in Markdown for Humans.
2. Click the heading, type `X`, save.

**Expected:** only the heading line changes (0.4.1 promise: unedited blocks keep exact source).
**Actual:** `</div>` is gone. Same for `<details>...</details>` and `<center>...</center>` when blank lines separate the tags from the content. The document no longer closes its wrapper on GitHub.

**Not affected (passed):** wrappers with no blank lines, single-line `<div>`, `<p align="center"><img ...></p>`, raw `<table>`, `<picture>`, paired comments.

**Why it matters:** the README header pattern `<div align="center">` with blank lines inside is common. The user never edited that block, so there is no warning.

**Look first:** how an HTML block is split by blank lines into separate tokens, and which token is dropped when the document is re-serialized. Start at `src/webview/utils/markedLexerNormalizer.ts`, `src/webview/utils/markdownSerialization.ts` and `src/webview/extensions/htmlComment.ts` (the 0.4.1 comment-preservation work is the closest precedent).

**Caught by:** `13b div wrapper with blank lines`, `13b details with blank lines`, `13b html block then markdown`, `13.2`.
**Fix done when:** a regression test saves each of the three failing shapes after a heading-only edit and asserts byte equality.

---

## F2 (High): undo past the loaded state empties the document

**Repro:**
1. Open `hello.md` (`# Hello`, one paragraph).
2. Click the end of the paragraph, type `abc`.
3. Press Cmd+Z once: text returns to the original (correct).
4. Press Cmd+Z again: the editor goes blank.
5. Press Cmd+Z a third time: VS Code's document is now empty and dirty.

**Expected:** undo stops at the state the file was opened in, as in a normal VS Code editor.
**Actual:** the initial content load is an undo step. Repeated Cmd+Z, a natural thing to do, wipes the file and syncs the empty text to the document. Redo was not tested.

**Look first:** the ProseMirror history setup and the initial `setContent` call in `src/webview/editor.ts`. Likely fix is to load content without adding to history, or clear history after load. Check the external-update path (`document.edit.ack`, reconcile) for the same problem.

**Caught by:** `02.7` (a 6x Cmd+Z overshoot) plus follow-up probe.
**Fix done when:** a test undoes 10 times after one edit and asserts the document equals the original and is not dirty.

---

## F3 (Medium): inline raw HTML stripped from an edited paragraph

**Repro:**

````markdown
# Heading

Press <kbd>Ctrl</kbd>+<kbd>C</kbd> keys.
````

1. Click at the end of `keys`, type ` EDITED`, save.

**Actual:** `Press Ctrl+C keys EDITED.` The `<kbd>` tags are gone.
**Control:** editing the heading instead leaves the paragraph byte-identical.

**Why it matters:** `<kbd>`, `<sub>`, `<sup>` are common in docs. Same mechanism as the documented standard-form re-serialization, but it removes content rather than reformatting it. Only `<kbd>` was tested in an edited paragraph, so `<sub>`/`<sup>` need checking when this is fixed.

**Look first:** whether the schema has an inline-HTML mark or node, and how `markdownCompatibilityMarks.ts` handles unknown inline tags.

**Caught by:** `02.3 one-block edit in comments-html.md`, follow-up `kbd isolation`.

---

## F4 (Medium): Copy as Markdown splits inline marks into paragraphs

**Repro:** in `Plain paragraph with **bold**, *italic*, ...` select from `with` to `italic` and click the toolbar **Copy selection as Markdown**.

**Expected:** `with **bold**, *italic*`
**Actual:** `with \n\n**bold**\n\n, \n\n*italic*`

**Look first:** `getSelectionAsMarkdown` in `src/webview/utils/copyMarkdown.ts`. A partial-paragraph slice is wrapped in a fresh top node, so inline fragments serialize as separate blocks. Wrapping the slice's inline content in a paragraph before serializing is the likely fix.

**Related, unconfirmed:** a plain-text-only fragment copied nothing once in 6 attempts. Re-test after the fix.

**Caught by:** `17.2c`, probe `copy as markdown variants`.

---

## F5 (Medium): first right-click on a table cell shows no table menu

**Repro:**
1. Open `tables.md`, click in a paragraph outside the table.
2. Right-click a table cell: nothing from the extension appears and VS Code's native webview menu opens.
3. Right-click the same cell again: the table menu appears.

**Cause (read from code):** `contextMenuHandler` in `src/webview/editor.ts` (around line 1165) checks `editorInstance.isActive('table')`, but the right-click has not moved the selection into the table yet. The first click moves it, the second passes the check.

**Fix idea:** decide from the event target (`closest('td, th')`) and place the selection in that cell before showing the menu.
README promises "Right-click to add rows", so a first-time user will hit this immediately.

**Caught by:** `08.6b`.

---

## F6 (Low): autolinks rewritten in an edited paragraph

`Autolink <https://example.com/a_b_c> and <me_x@example.com>.` becomes `[https://example.com/a_b_c](https://example.com/a_b_c) and [me_x@example.com](mailto:me_x@example.com).` after any edit in that paragraph. Underscores survive. Rendered result is the same; the source gets longer and noisier. Add the construct to KNOWN_ISSUES under standard-form re-serialization if it is left as is.

**Caught by:** `02.2`, `13.3`.

## F7 (Low): trailing newline appended

A file that ends without a final newline gets `\n` added to the document text on the first keystroke, before any save. Causes a diff on a one-word change. Related to the CRLF work in 0.4.1; CRLF itself was preserved.

**Caught by:** `02.5`.

## F8 (Low): plain click on a link opens the browser

`handleLinkClick` in `src/webview/editor.ts` (around line 1320) sends `openExternalLink` for any click on an `http(s)` or `mailto` link, and the caret also lands in the link. `docs/QA_MANUAL.md` section 5.6 says links must not open on click while editing. Decide which is right, then fix the code (Cmd/Ctrl+click is the usual convention) or the manual.

**Caught by:** `09.4`.

## F9 (Low, fixed in code): wrong shortcut in link tooltip

Toolbar tooltip reads `Insert/edit link (Cmd+K)`. Cmd+K alone does nothing because VS Code reserves it as a chord prefix; the working shortcut is Cmd+K then Cmd+L (handled around line 1240 of `src/webview/editor.ts`). The tooltip is fixed in `src/webview/BubbleMenuView.ts`. **Still to do:** `wiki/Keyboard-Shortcuts.md` (lines 33, 34, 197, 220) also says Cmd/Ctrl+K alone. The wiki is a separate repository (a git submodule), so it was not edited here.

**Caught by:** `09.0`, `09.1`.

## F10 (Low): bare fence saved as `plaintext`

Typing three backticks then code writes a ```` ```plaintext ```` fence to the file. Bare fences that were already in the file are preserved. Cosmetic, but it changes what the user typed.

**Caught by:** `07.2`.

---

## F11 (Medium, new): tab stays dirty after undoing back to the original

Found when F2's QA case got further than before. After typing and pressing Cmd+Z, the text matches the original again but `TextDocument.isDirty` stays true, so VS Code still shows the unsaved dot and prompts on close. `docs/QA_MANUAL.md` section 5.1 says the indicator should clear when you undo back to the initial content.

**Likely cause:** the webview sends each state as a `WorkspaceEdit` that replaces the text, so VS Code sees two edits rather than one undone edit, and its saved-version marker never matches again.
**Look first:** `MarkdownEditorProvider` edit application (around line 11380 of `src/editor/MarkdownEditorProvider.ts`). Clearing dirty needs either routing undo through VS Code's own undo stack or reverting the document when the text equals the saved bytes. The second option resets the webview, so it needs care.
**Caught by:** `02.7` (fails at "dirty cleared by undo").

---

## Smaller observations (no action decided)

| Observation | Note |
|---|---|
| Feedback refuses a mixed plain/task list with no visible message | KNOWN_ISSUES says Start is "stopped" but does not say it is silent. A toast would help. Case `21.9`. |
| Empty `[MD4H] Uncaught error:` on one cold open of `images.md` (1 of 6) | `window` `error` handler at `src/webview/editor.ts:2983` logs `event.error`, which is empty for image load errors. Log `event.message` or filter resource errors. |
| Typing latency 27.8 ms median on a 17,500-line document | Over the 16 ms typing budget in `AGENTS.md`, under the 50 ms interaction budget. Debug build only; measure the release bundle first. Case `23.3`. |
| `` `` a`b `` `` becomes ``` ``a`b`` ``` in an edited paragraph | Equivalent render; covered by the standard-form note. |

## Already in KNOWN_ISSUES (confirmed again, no new work)

`*` markers become `-`; blank line inserted between a label and its list; escaped characters lose backslashes in an edited block; text after `\` line break in a task item is lost; edited tables are re-padded.

---

## Hotfix status

| Check | Result |
|---|---|
| Jest | 200 suites, 3,778 tests pass (baseline 3,721, 57 new) |
| `eslint --max-warnings 0`, `tsc --noEmit` | clean |
| Real VS Code re-run | 207 pass, 10 fail (was 192 / 15). Eight original failures resolved |
| Still failing, expected | 02.3 lists and 02.3 code (documented standard-form behavior), 02.5 (F7, by design), 09.0 (asserts the old tooltip), 09.4 (F8), 02.7 (F11) |
| Feedback suite flakiness | Fails intermittently on **untouched main** too (4 of 10 runs vs 6 of 10 on the branch, difference not significant). Case `21.11` flakes on both. Treat as harness timing, not a product signal |

Files changed: `markedLexerNormalizer.ts` (F1), `markdownSerialization.ts` and `editor.ts` (F2), new `inlineHtmlMarks.ts` (F3), `copyMarkdown.ts` (F4), `BubbleMenuView.ts` and `editor.ts` (F5, F9), `markdownCompatibilityMarks.ts` (F6), plus `CHANGELOG.md` and `KNOWN_ISSUES.md`. Six new test files under `src/__tests__/webview/`.

**Behavior change to confirm (F1):** wrapper tags such as `<div align="center">` now appear as muted one-line markers, the same style as HTML comments. Before, they were invisible and silently deleted on save. Showing them is what makes the save lossless.

## Reproducing and extending the tests

The harness is not tracked: it lives in git-ignored `temp/qa/` on the machine that ran it.

| Item | Location |
|---|---|
| Full report with passing areas | `temp/qa/TEST_REPORT.md` |
| Test plan | `temp/qa/TEST_PLAN.md` |
| Run everything (about 11 minutes) | `temp/qa/go.sh all` |
| Run one suite | `temp/qa/go.sh f13b-html-loss` |
| Mock repo generator | `temp/qa/fixtures/generate.cjs` |
| Screenshots | `temp/qa/evidence/` |

**Decision needed:** promote the suites into `test/integration/` (tracked, run by `npm run test:integration`) or keep them local. Per `AGENTS.md` each fix needs a failing test first, so at minimum port the F1, F2, F3 and F5 cases. They need CDP access to the webview, which the current `.vscode-test.mjs` does not enable (it would need `--remote-debugging-port`).

## Not covered by this QA pass

Feedback Next/Previous/Choose scope/Capture selected blocks/Reveal commands, block gutter action, table-cell feedback, Outline sidebar tree and filter, status-bar stats click, Redo after the F2 overshoot, Windows, Linux, Remote, Cursor, the release (minified) bundle. Computer-use control of VS Code was denied, so OS-level Cmd+C/Cmd+V, Finder drag-drop and native menus are unverified.
