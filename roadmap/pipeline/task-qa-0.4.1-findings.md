# QA findings against 0.4.1 (main @ f448a4e)

**Source:** real VS Code 1.140.0 Extension Host run on 2026-10-04, 207 cases, 192 pass, 15 fail. The 15 failures reduce to the 10 findings below plus 5 already in `KNOWN_ISSUES.md`.

**Status:** hotfix branch `hotfix/qa-0.4.1-findings`. F1 to F6, F8, F9 and the later findings F12 to F15 are fixed with regression tests; F7 and F10 are documented in `KNOWN_ISSUES.md`; F11 was retracted (not reproducible). One open decision remains, host-driven undo (see the end). Ordered by severity. Each item has a repro, expected vs actual, where to look first (suspected, not verified), and the test that caught it.

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
| F8 | Low | Plain click on a link opens the browser (manual says it should not) | **Fixed**: Cmd/Ctrl+click opens, plain click places the caret. Wiki still says plain click |
| F9 | Low | Link tooltip advertises Cmd+K, only Cmd+K then Cmd+L works | **Fixed** (tooltip). Wiki still says Cmd+K, see below |
| F10 | Low | Typed bare fence is saved as `plaintext` | By design (`defaultLanguage`); **documented** in KNOWN_ISSUES |
| F11 | Medium | Undoing back to the original text leaves the tab marked dirty | **Retracted**: not reproducible. The QA case reused a file the previous case had left dirty |
| F12 | High | Saving inserts blank lines between blocks you did not edit (heading, label or text directly above a list, fence or text) | **Fixed**, found by the corpus run |
| F13 | High | Link reference definitions (`[0.2.1]: https://...`) deleted on save | **Fixed**, found by the corpus run |
| F14 | Low | `toggleTocOutlineView` command does nothing (message not handled) | **Fixed** |
| F15 | Medium | Toolbar buttons clipped and unreachable when the editor is narrow | **Fixed**: the toolbar wraps onto a second row |

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

## F11 (retracted): tab stays dirty after undoing to the original

Not a product bug. With a clean file, Cmd+Z back to the original text leaves the tab clean, including six presses 80 ms apart (8 of 8 runs). The QA case that failed (`02.7`) reused `hello.md` right after `02.6` had typed into it, so the in-memory document was still dirty. The case now uses its own file and passes.

## F12 (High, fixed): blank lines inserted between blocks you did not edit

Found by editing only the first heading of each of this repository's 156 Markdown files in the real editor and diffing the rest. Only 54 came back byte-identical; 863 blank lines were inserted across 84 files. The documented entry covered text directly above a list (569 of them) but not a heading above a list (178), a heading above text (50), or a label above a code fence (49).

**Cause:** an unedited block kept its own text but not its join to the next block, so every tight boundary was rewritten with a blank line.
**Fix:** each remembered source block records the original block that followed it with no blank line (`tightNext`, in `markdownSerialization.ts`). The tight join is written back only while that same unedited block is still next. If either neighbor is edited, moved or turned into something else, a blank line is used so two blocks can never merge into one paragraph. Marked folds a single blank line into a neighboring token's raw text, so tightness is decided by counting the newlines between the two blocks' content.
**Result:** 129 of 156 identical (from 54); inserted blank lines 863 to 8, all end-of-file cases that are documented design.

## F13 (High, fixed): link reference definitions deleted on save

Found by the same corpus run. `CHANGELOG.md` lost its 40 trailing `[version]: https://...` lines after a heading edit, while the unedited `## [0.2.1]` headings above still depended on them.
**Fix:** a `def` token now becomes the same marker block as an HTML comment (`markedLexerNormalizer.ts`), so each definition shows as a muted line and saves exactly as written. Reference links in the text above still resolve.

## F15 (Medium, fixed): toolbar clipped at normal editor widths

At a 786 px editor (sidebar plus a chat panel open) the last three toolbar buttons, Export, Audit and Export settings, were cut off with no overflow control, so they could not be used. A split view is narrower still. `.formatting-toolbar` was `flex-wrap: nowrap`; it now wraps (`editor.css`), and a test guards the rule. Verified in the real host at 786 px: two rows, every button reachable.

## F14 (Low, fixed): toggleTocOutlineView does nothing

The command posted `{ type: 'toggleTocOutlineView' }` and the webview had no handler. It is not contributed in `package.json`, so only a custom keybinding reaches it. `editor.ts` now handles the message through the same path as the toolbar button.

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
| Jest | 205 suites, 3,817 tests pass (baseline 3,721, 96 new) |
| `eslint --max-warnings 0`, `tsc --noEmit` | clean |
| Real VS Code, each suite in a fresh host | 15 of 16 suites fully green; `f03-f06-text` fails 1 to 6 toolbar-click cases per run, a different set each time, in code this branch does not touch |
| Corpus (156 real docs, first-heading edit) | 129 byte-identical, up from 54 |

Behavior changes to confirm:

- **Wrapper tags (F1)** such as `<div align="center">` show as muted one-line markers, the same style as HTML comments. Before they were invisible and silently deleted on save. They are stripped from PDF and Word export.
- **Link click (F8)** now needs Cmd/Ctrl. `wiki/Keyboard-Shortcuts.md` still says "Click link" (separate repo, not edited).
- **Link definitions (F13)** appear as muted marker lines where they sit in the file.

Decided and documented: **host-driven undo.** Content the host pushes in (an extension edit, a Git change) is recorded in the editor's undo history, so Cmd+Z first steps back to the text from before that change. This was verified in the real editor and matches VS Code's own behavior for edits applied by other extensions. Skipping history for every host update would also wipe undo after each format-on-save write, so it is listed in `KNOWN_ISSUES.md` instead of changed.

Follow-up, not in this PR: typing on a 17,500-line document measures about 30 ms median (budget 16 ms, interaction budget 50 ms). Untouched `main` measures the same, so it predates this branch.

Skipped on purpose: renaming the shared `htmlComment` node (it now also holds wrapper tags and link definitions) is a separate refactor.

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
