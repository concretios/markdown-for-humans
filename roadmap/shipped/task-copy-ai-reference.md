# Task: Copy Reference for AI

## 1. Task Metadata

- **Task name:** Copy Reference for AI (file and exact source lines)
- **Slug:** copy-ai-reference
- **Status:** shipped
- **Created:** 2026-10-11
- **Last updated:** 2026-10-11 (merged main after 0.4.4)
- **Shipped:** 2026-10-12 (0.4.4)

---

## 2. Context & Problem

**Current state:**
- 0.4.0 retired "Copy AI Context Reference" (PR 90, commit `3b87155`) when the Feedback workflow shipped. Nothing replaces it for the quick case.
- Issue 140: Feedback is too much when all a user needs is a reliable line reference to paste into an agent. The old version copied nothing useful inside tables. The user asks for a command that can be bound to a key.
- Issue 61: users of Cline and similar tools need source line numbers, which the rendered view does not show.

**Weaknesses of the retired version** (read from tag `archive/copy-ai-context-line-numbers`):

| Weakness | Cause |
|---|---|
| Line numbers were computed, not read | The webview serialized each top-level block again and added up line counts (`cursorLine += 2 + pendingBlanks`). Correct only if the saved file is byte-identical to that serialization |
| Block rounded | A caret anywhere in a 40-row table, a long list or a code block returned the whole block |
| Depended on focus | `shouldIncludeLineRange(isFocused, selectionEmpty)`: from the Command Palette the editor is blurred, so a plain caret gave a bare `@file` |
| Frontmatter by subtraction | Subtracted the two fence lines of the wrapped frontmatter, a second copy of a host rule |
| Dialog and setting | A save-confirmation dialog plus `copyAiContextRef.skipSaveWarning` |
| Alt+C | Collides with Toggle Find Case Sensitive on Windows and Linux, which this editor's own find widget uses |

**Why it matters:**
- A wrong line number sends an agent to edit the wrong place. A missing number is an inconvenience; a wrong one is a defect.
- Since 0.4.0 the host has `buildFeedbackAnchorMap`, which reads line spans from the real file text. That did not exist when the old command was written.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Output is `@<path>#L<start>-<end>`, or `#L<n>` for one line. Path is relative to the file's workspace folder, forward slashes on every platform.
- Every line number is a 1-based line of the saved file and is read from that file's text. It is exact, or it is the exact range of the smallest enclosing block that could be verified, or it is absent. It is never estimated.
- Exact to the line in: paragraphs (including hard-wrapped), headings, nested lists, task lists, blockquotes, GitHub alerts, table rows, code block lines, frontmatter lines, and documents with blank-line runs.
- One Command Palette command, bindable, enabled only in this editor. No new setting.
- Works on a 10,000-line document.

**In scope:**
- Host line resolver, reference formatter, webview selection describer, command, toolbar button, toast, tests, docs.

**Out of scope:**
- A line-number gutter in the rendered view (issue 61's other ask). One rendered block is not one source line, so this is a separate design.
- A live "Ln 12" status bar readout.
- Copying the quoted text with the reference.

---

## 4. UX & Behavior

**Name:** "Copy Reference for AI". Command ID `markdownForHumans.copyReferenceForAi` (the retired ID `copyAiContextRef` stays retired; its guard test is unchanged).

**Entry points:**
- Command Palette: **Markdown Editor for Humans: Copy Reference for AI**, visible and enabled only when `activeCustomEditorId == 'markdownForHumans.editor'`.
- Toolbar: one `@` icon button directly after the Feedback button, before the first separator. Tooltip: "Copy reference for AI (@file#L10-14)". Feedback stays the first control.
- Keybinding: none shipped and none suggested. The command can be bound in Keyboard Shortcuts.

```text
[Feedback] [@] | B I S <> H1 H2 H3 H+ | lists | table quote ... math | Outline Source | Copy MD  Export | Audit  Gear
            ^ new: the two AI actions sit together
```

**Flow:**
1. User places the caret or selects, then runs the command or clicks `@`.
2. If the file has unsaved changes it is saved first (the same flush and save path the autosave bridge uses).
3. The reference is on the clipboard. A toast in the editor shows it: "Copied @bom/README.md#L10-14".

**Behavior rules:**

| Situation | Result |
|---|---|
| No selection | The line of the caret |
| Selection | First through last source line with selected content. A selection that ends at the very start of a block or line does not include that block or line |
| Whole block selected as a node | That block's full range, fences included for a code block |
| Caret in a table cell | That row's line |
| Caret in a code block | That code line, not the fence |
| Caret on a blank line | That blank line when the gap matches the editor's layout, else the blank gap's range |
| A nested position that cannot be verified | The exact range of the smallest verified enclosing block (item, quote, list, table, top-level block) |
| The document cannot be matched to the file at all | `@path` with no line suffix, and the toast says no line numbers were available |
| Untitled document | Not copied. Toast: save the file first |
| Save fails or the editor cannot flush | Not copied. Toast says so |
| Feedback mode active | Works, read only: no flush, no save (the file is already frozen at saved bytes). If the file is dirty there, not copied |
| File outside every workspace folder | Absolute path with forward slashes |

**Fallback, defined precisely.** A step from a block to one of its children is taken only when markdown-it's parse of that block's own source lines has the same number of children as the rendered node and the target child has the same kind. A line inside a paragraph is taken only when the paragraph's source line count equals the rendered line count and every source newline is a line break token. A code line is taken only when the code line counts match. The first check that fails stops the descent, and the range of the last verified node is used.

---

## 5. Technical Plan

**Surfaces:** extension host (resolution, save, clipboard), webview (selection description, toolbar, toast).

```text
command or toolbar
      |
      v
webview: describe selection (block ordinal + child steps + line in block)
         + canonical top-level blocks (same enumeration Feedback uses)
      |  message: copyReferenceForAi
      v
host: flush + save if dirty
      buildFeedbackAnchorMap(saved text, blocks)   -> exact top-level line spans
      verify the touched blocks' content           -> same check Feedback uses
      walk markdown-it tokens of that one block    -> row / item / line
      format, write clipboard
      |  message: copyReferenceForAi.result
      v
webview: toast
```

**Key changes:**
- `src/shared/aiReferenceProtocol.ts` (new): point and selection types, node kind vocabulary, strict request parser.
- `src/editor/aiReference.ts` (new): `resolveAiReferenceLines`, `aiReferencePath`, `formatAiReference`.
- `src/webview/features/aiReferenceSelection.ts` (new): `describeAiReferenceSelection(state)`.
- `src/editor/feedbackSnapshotService.ts`: export the per-block content check and the reference collection it already performs (no behavior change).
- `src/shared/feedbackSnapshotProtocol.ts`: export the existing canonical block parser.
- `src/editor/MarkdownEditorProvider.ts`: `copyReferenceForAi` message handler.
- `src/extension.ts`, `package.json`: command registration and contribution.
- `src/webview/editor.ts`, `src/webview/BubbleMenuView.ts`: trigger, toolbar button, toast.

**Architecture notes:**
- Reuses `buildFeedbackAnchorMap` unchanged. No second parser, no new dependency, no network.
- Line numbers always come from the host's `TextDocument` text after the save. The webview only says which block and which child.
- The clipboard is written on the host (`vscode.env.clipboard`), so it does not depend on webview focus.
- The selection is read from ProseMirror state, which survives blur, so the Command Palette path and the toolbar path behave the same.

**Performance considerations:**
- One block enumeration in the webview and one anchor map build on the host per invocation, the same work Feedback does at start. Nested parsing touches only the one or two blocks at the selection ends.

---

## 6. Work Breakdown

- [x] **Phase 1: Research** - issues 140 and 61, retired code, Feedback mapping, toolbar, external formats
- [x] **Phase 2: Mapping** - failing tests, then `aiReference.ts` and `aiReferenceSelection.ts`
- [x] **Phase 3: Wiring** - failing tests, then command, provider handler, webview trigger and toast
- [x] **Phase 4: Toolbar button** - separate commit so it can be dropped on its own
- [x] **Phase 5: Docs** - CHANGELOG, README, QA manual, key files table
- [ ] **Testing**
  - [x] Jest: resolver per block type, multi-block, CRLF, frontmatter, 10,000 lines
  - [x] Jest: formatting (Windows paths, spaces, outside workspace)
  - [x] Jest: real editor end to end (selection to lines), plus this repository's own documents
  - [x] Jest: `package.json` and `extension.ts` wiring, host handler, toolbar button
  - [x] Extension Development Host: command to clipboard, including the save-first rule
  - [x] Real VS Code window pass: toolbar click, toast, click selections, save-first, Feedback, spaces
  - [x] By the owner: a user keybinding and a drag selection across blocks
  - [ ] By hand: the Command Palette entry by typing, light theme

---

## 7. Implementation Log

### 2026-10-11 - Research and plan

- **What:** Read both issues, PR 90, the archived implementation and its three commits, the Feedback anchor and snapshot code, and the toolbar. Confirmed markdown-it line maps for table rows, list items, quote paragraphs and fences.
- **Notes:** The archived code emitted `#10-14` with no `L`. Issue 140 writes `#L10-14`. Claude Code's current docs show `@app.ts#5-10`; its older docs showed `@File#L1-99`. See Decisions.

### 2026-10-11 - Built and verified

- **What:** Resolver, selection describer, protocol, command, host handler, toolbar button, toast, docs.
- **Files:** `src/editor/aiReference.ts`, `src/webview/features/aiReferenceSelection.ts`, `src/shared/aiReferenceProtocol.ts`, `src/editor/MarkdownEditorProvider.ts`, `src/extension.ts`, `src/webview/editor.ts`, `src/webview/BubbleMenuView.ts`, `package.json`, tests under `src/__tests__/` and `test/integration/`.
- **Results:** `npm run lint` clean. `npx jest`: 218 suites and 4,490 tests passed, none failed. `npm run test:integration` on VS Code 1.141.0: 10 passed.
- **Accuracy audit:** carets placed inside 4,994 words across 12 of this repository's Markdown files. 4,989 resolved to the exact line, 5 to no line (a malformed fence inside a nested list), 0 to a wrong line. Four of those files are kept as a permanent test.
- **Found while testing:**
  - Link reference definitions (`[0.4.3]: https://...`) are a marker block in the editor but no block for markdown-it, so the anchor map rejected the whole document (this repository's CHANGELOG got no line numbers). The resolver now leaves such blocks out of the anchor map and resolves them by exact text match against the lines between their neighbors. Feedback itself still has this limit; see Follow-up.
  - After a document loads, the caret is at the end of the document, not the start. The host test places it with `markdownForHumans.navigateToHeading`.
  - A run of blank lines does not load as one empty paragraph per extra line (three blank lines load as one), so a caret on such a paragraph resolves to the blank gap's range unless the file has the editor's own layout.
- **Not verified in a real window:** toolbar click, toast appearance, mouse selections, and a user keybinding firing while the rich view has focus. Background control could not address a second VS Code process while another VS Code window was open, and taking over the screen was not appropriate with other sessions active.

### 2026-10-11 - Merged main after 0.4.4 and localized the new text

- **What:** Merged origin/main `1b271df` (0.4.4, translations, font settings, toolbar changes). This feature is not in 0.4.4; it targets the next release.
- **Text:** The command title is `%command.copyReferenceForAi.title%` with English in `package.nls.json`. The toolbar label and tooltip, the webview failure toast and the five host messages go through `l10n.t` and `vscode.l10n.t`. The tooltip's example (`@file#L10-14`) is passed as an argument, so it is not part of the translated sentence.
- **Locales:** nine new entries in each of `zh-cn`, `ja`, `es`, `pt-br`, `ru` (bundle and `package.nls`). AI translated, same status as the rest of those files.
- **Notes:** `test/integration/workspace/.vscode/settings.json` from main is in the commit but not in this worktree's working copy, because the app's sync tool treats it as a protected path. The Extension Development Host suite therefore has to run from an export of the commit.

### 2026-10-11 - Hands-on pass in a real VS Code window

- **Setup:** VS Code 1.141.0 Extension Development Host on this branch's debug build, isolated profile, demo document with frontmatter, a hard-wrapped paragraph, a nested list, an alert, a table and a code block. Driven through the window's debugging port with screenshots, wheel scrolling and plain left clicks (single, double, triple). No key presses and no drags.
- **Toolbar button, caret:** 14 of 14 exact, with 60 to 300 ms between placing the caret and clicking `@`: table header and body rows, wrapped paragraph lines 2 and 3, nested item and its continuation line, both alert lines, a frontmatter line, heading, the paragraph after two blank lines.
- **Selections:** double-click a word gives its line (paragraph, table cell, code); triple-click the wrapped paragraph gives `#L8-10`; triple-click the nested item gives `#L17-18`.
- **Code block:** caret on a code line, on the empty code line, and a double-clicked word each give that code line, never the fence.
- **Unsaved changes:** after bolding a word the tab was dirty; the click saved it and the toast read "Saved the file and copied @bom/README.md#L36". The save itself collapsed the two blank lines (existing strip mode), moving that paragraph from 37 to 36, and the reference named 36, the line in the saved file.
- **Path with spaces:** `@"release notes/v1 draft.md#L5"`.
- **Feedback active:** the command copied the reference, showed the toast, left the file clean and the Feedback session running. The `@` button is not shown there because Feedback replaces the toolbar.
- **Toast:** bottom right, check icon, the reference in full.
- **Driver lesson:** early runs failed about one time in three. The cause was the test driver, which attached and detached a viewport override on every call and so resized the window around each click. One persistent session removed every failure.
- **Still not done:** a key press (a user keybinding firing while the rich view has focus, and finding the command by typing in the Command Palette), a drag selection across blocks, a light theme look, Windows and Linux.

### 2026-10-11 - Owner's test in a real window

- **Passed:** Option+K in a table row (`#L27`), Ctrl+Option+K in a wrapped paragraph line (`#L11`), a drag selection from line 11 into the table followed by the `@` button (`#L11-26`).
- **Failed:** Option+K also typed a ring character on a Mac. With a selection in the code block it replaced the selected code. See Decisions.
- **Changed as a result:** the README no longer suggests a shortcut; the `@` button moved beside the Feedback button.
- **Not answered in that run:** the Command Palette entry, the tooltip text, light theme.

### 2026-10-11 - Complex document round, merged main after PR 159

- **Fixture:** `src/__tests__/fixtures/aiReferenceComplex.md`, 226 lines. Every text line carries its own source line as `(L<n>)` at both ends, so the expected answer for any caret is read from the rendered text. It has lists nested three deep, a loose list holding code and a quote, task lists, quotes with lists, three alerts, an aligned table with formatting and an escaped pipe, a compact table, backtick, tilde and four-backtick fences, both kinds of hard break, blank-line runs, inline HTML, a comment and a link definition.
- **Jest, every caret position:** 4,555 positions, 4,490 exact, none wrong. The other 65 are one line with inline HTML, whose editor extension is not loaded in the test harness; they give no line.
- **Real VS Code 1.141.0 window, every sixth position:** 804 carets with a stated line, 801 matched it, none gave no line, and all 129 numbered lines were verified, the inline HTML line included. The 3 others were looked at one by one: two are lines that carry no number (the frontmatter's opening `---` and a bare fence line inside a code block) and were copied correctly; one is a position between two list items, where no text caret can sit, and it copied the following item's line.
- **Merge:** origin/main `d55549c` (PR 159, paste as plain text). Nine conflicts, all two-sided additions, resolved by keeping both. Lint clean; `npx jest`: 250 suites, 4,971 tests passed, none failed.

---

## 8. Decisions & Tradeoffs

- **Line format `#L10-14`: settled.** Read from Claude Code 2.1.296 itself. Its CLI parses mentions with `^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$`, so only the `#L` form gives it a line range; a bare `#10-14` attaches the whole file there. Its VS Code panel accepts both (`/#L?\d+(?:-\d+)?$/`) and writes the bare form, while its own terminal command (`claude-code.insertAtMentioned`) writes `#L`. `#L10-14` is therefore the one form that works in both.
- **Unsaved changes: save first.** The reference must match what the agent reads from disk. Refusing costs a second keypress every time; warning produces a reference that is wrong until the user saves. Saving is what the user would do next anyway, and Feedback already saves on entry. The toast says when a save happened. No dialog, no setting.
- **No default keybinding, and no suggested one.** Alt+C is Toggle Find Case Sensitive on Windows and Linux, including in this editor's find widget, and the retirement guard forbids it. Alt+K, which the README first suggested because Claude Code uses it in text editors, failed the owner's test on a Mac: Option+K ran the command and also typed a ring character into the document (replacing a selection), and save-first then wrote that character to disk. Ctrl+Option+K worked cleanly, so user keybindings do fire while the rich view has focus; the README now only says the command can be bound and warns against Option plus a letter on a Mac.
- **Toolbar button beside Feedback (owner's call, 2026-10-11).** First built in the copy group after Copy MD; moved to second position so the two AI actions sit together. Feedback is still the first control. Issue 140's reporter could not find the feature after the update, which a palette-only command would repeat.
- **Toast, not status bar.** Every other toolbar action in this editor confirms inside the editor, and the status bar can be hidden. The toast is not modal and shows the reference.
- **Bare `@path` when nothing can be verified,** instead of refusing. The path alone is true and still useful.
- **A path with spaces is quoted, with the line suffix inside the quotes:** `@"release notes/v1 draft.md#L3-5"`. Both Claude Code parsers read `@"..."` as one mention; unquoted, the mention would end at the first space. A path containing `#` or `"` is still copied as it is; Claude Code itself cannot reference such a path.
- **Multi-root workspaces:** the path is relative to the file's own folder, matching the issue's example.

---

## 9. Follow-up & Future Work

- Feedback cannot start on a document with link reference definitions, for the cause described in the log. The same idea (leave renderless marker blocks out of the anchor map) would fix it in `feedbackAnchors.ts`, with care for code that pairs descriptors and anchors by index.
- Partial anchoring: when the document as a whole cannot be matched (a list mixing plain and task items, a three-space ordered-list root), blocks before the first mismatch could still be anchored.
- Blank-line runs are not preserved one to one on load in the test harness (four blank lines load as one empty paragraph). Worth checking in the product.
- A status bar "Ln" readout for the caret (issue 61).
- A right-click entry through `webview/context`.
