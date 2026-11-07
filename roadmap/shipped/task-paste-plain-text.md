# Task: Paste as plain text

## 1. Task Metadata

- **Task name:** Paste as plain text (Ctrl/Cmd+Shift+V)
- **Slug:** paste-plain-text
- **Status:** shipped
- **Created:** 2026-10-11
- **Last updated:** 2026-10-11
- **Shipped:** 2026-10-12 (0.4.4)
- **Issue:** #11

---

## 2. Context & Problem

**Current state:**
- Ctrl+Shift+V (Cmd+Shift+V on macOS) does nothing in the rich editor.
- A single identifier copied from a VS Code text editor and pasted with Ctrl/Cmd+V lands as a code block that splits the paragraph. Reproduced on `main` at `a6b5579` in a real TipTap editor (jsdom): `Hello world` becomes `Hello`, a `typescript` code block, ` world`.
- `src/webview/utils/pasteHandler.ts` (reworked in `8f637ab` and `76977c1`, July 2026) already classifies VS Code's span-wrapped HTML as plain text. That did not fix the symptom: the paste is then left to TipTap, and TipTap's stock CodeBlock extension has a paste plugin (`codeBlockVSCodeHandler`) that wraps any clipboard carrying `vscode-editor-data` with a language in a code block. `CodeBlockWithCopy` inherits that plugin.

**Pain points:**
- **No way to drop formatting:** text copied from a web page, Word or another editor always arrives with its formatting or is read as Markdown.
- **Copy from code, paste in prose:** a class name copied from the code editor breaks the sentence it is pasted into.

**Why it matters:**
- **Convention:** Ctrl/Cmd+Shift+V is "paste without formatting" in browsers, Google Docs, Slack and Office.
- **Reading experience:** an unwanted code block in the middle of a sentence is the opposite of writing naturally.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Ctrl+Shift+V (Cmd+Shift+V on macOS) inserts the clipboard's plain text at the caret: no formatting from the clipboard, no automatic code block, no Markdown conversion, no HTML conversion.
- Limit found during the work: "no Markdown conversion" holds at paste time, not across a reload. When the pasted text would change on reload, the editor asks how to paste it. See sections 4 and 8.
- Line breaks are kept: one newline is a line break, a blank line starts a new paragraph.
- The paste is one undo step.
- Ctrl/Cmd+V is unchanged, except that a single line copied from a VS Code editor now lands as inline text.
- Pastes into the search box, dialogs and other inputs are unchanged.

**In scope:**
- A command, `markdownForHumans.pastePlainText`, titled "Markdown Editor for Humans: Paste as Plain Text", with a default keybinding that users can rebind.
- The fix for the single-line VS Code copy.

**Out of scope:**
- Multi-line copies from a VS Code editor: they still become a code block with the source language.
- A toolbar button or context menu entry.
- Browser-hosted VS Code (Codespaces in a browser, code-server). See section 8.

---

## 4. UX & Behavior

**Entry points:**
- Ctrl+Shift+V on Windows and Linux, Cmd+Shift+V on macOS, while the rich editor has focus.
- Command Palette: "Markdown Editor for Humans: Paste as Plain Text".

**Behavior rules (plain-text paste):**

| Caret is in | What is inserted |
| --- | --- |
| Paragraph, list item, blockquote | The text. Each single newline becomes a line break in the same paragraph. One or more blank lines start a new paragraph (a run of blank lines counts as one). |
| Heading | The first line joins the heading. Every further line becomes a paragraph below it, because a Markdown heading cannot hold a line break. |
| Code block | The text exactly as it is, newlines included. A fenced block in the clipboard is not unwrapped (Ctrl/Cmd+V unwraps it). |
| Table cell | The text stays in that cell. Every newline becomes a line break (`<br>` in the saved table). No rows, cells or paragraphs are added, and a tab does not move to the next cell. |

- A selection is replaced by the pasted text.
- The pasted text takes the formatting at the caret (pasting inside bold text gives bold text), as "paste and match style" does elsewhere. Nothing is taken from the clipboard's HTML.
- Leading and trailing newlines are dropped, except inside a code block.
- Windows line endings are read as plain newlines.
- Markdown syntax in the text stays literal on screen: `**bold**` shows as asterisks. No input rules or paste rules run.
- The file gets the text as written. The serializer does not escape prose, so Markdown syntax in pasted text would be read as Markdown the next time the file is loaded.
- **Choice when that would happen:** if the text would read differently after a reload, nothing is inserted yet and a quick pick asks how to paste it.

  | Choice (in this order) | Result |
  | --- | --- |
  | Paste as code | Inline code for one line, a code block for several lines or text with a backtick. In a table cell: inline code on each line. Literal now and after reload. |
  | Paste as Markdown | The text is read as Markdown source and formatted now, as a normal paste of Markdown would be. |
  | Paste as plain text | The behavior in the table above: literal now, formatting after reload. |
  | Escape | Nothing is pasted. |

- Text that survives a reload unchanged (an identifier, prose, `a * b * c`, `<b>x</b>`, `AT&T`) pastes with no question. Inside a code block there is never a question.
- Nothing happens when the clipboard has no text (for example an image), while Feedback has the document locked, or while focus is in the search box, the link dialog, the math editor or another input.

**Behavior rule (normal paste):**
- A single line copied from a VS Code text editor is inserted as inline text. A whole-line copy made with an empty selection counts as a single line.

---

## 5. Technical Plan

**How the keystroke travels (verified against VS Code source, releases 1.98 and 1.141):**

```
keydown in webview iframe
   |
   |  our document keydown handler: no match, lets it bubble
   v
VS Code's injected handler (webview/browser/pre/index.html, handleInnerKeydown)
   |  isCopyPasteOrCut = (ctrl or meta) and key is C, V or X. Shift is not checked.
   |  On Electron it calls preventDefault(), so Chromium never fires a paste event.
   v
did-keydown message to the workbench, re-dispatched on the webview element
   |
   v
keybinding service: markdownForHumans.pastePlainText (when clause below)
   |
   v
extension host: vscode.env.clipboard.readText()
   |
   v
postMessage { type: 'pastePlainText', text } to the active webview
   |
   v
insertPlainText(editor, text): one ProseMirror transaction
```

**Mechanism chosen: contributed command and keybinding.**

| Option | Verdict | Why |
| --- | --- | --- |
| Contributed command and keybinding, host reads the clipboard | Chosen | Uses only documented API. Rebindable and visible in the Command Palette. Same on macOS and Windows. Follows `vscode-integration.md` (host commands forward to the active webview). |
| Paste event flag (let Chromium paste, read the Shift state) | Rejected | On desktop VS Code the paste event never fires for this chord: VS Code cancels the keydown. |
| Webview keydown plus `navigator.clipboard.readText()` | Rejected | Works only because VS Code grants the webview `clipboard-read`, which is not a documented contract. The shortcut would be hard-coded and not rebindable. |

**When clause:** `activeCustomEditorId == 'markdownForHumans.editor' && !terminalFocus && !inputFocus`
- External extension keybindings outrank built-in ones (weight 400 against 200 and 300), so the clause must not match while a terminal has focus: Ctrl+Shift+V is terminal paste on Linux and Windows.
- `!inputFocus` keeps the chord away from VS Code's own text inputs. While the webview has focus the workbench's active element is the iframe, which is not an input, so the clause holds.
- VS Code's "Markdown: Open Preview" on the same chord does not apply: it needs a focused text editor (`editorFocus` in 1.141, `editorLangId` in 1.98 and 1.108).

**Key changes:**
- `package.json`: command `markdownForHumans.pastePlainText` and its keybinding.
- `src/extension.ts`: register the command; read the clipboard; post `pastePlainText` to the active webview.
- `src/webview/utils/plainTextPaste.ts` (new): `insertPlainText(editor, text)`, the behavior table above in one transaction, closed off from the previous undo group with `closeHistory`.
- `src/webview/editor.ts`: handle the `pastePlainText` message with the Feedback lock and focus guards.
- `src/webview/utils/pasteHandler.ts`: `getSingleLineEditorCopy(clipboardData)`.
- `src/webview/extensions/codeBlockWithCopy.ts`: a paste plugin placed before TipTap's inherited one that inserts a single-line VS Code copy as plain text.
- `test/integration/pastePlainText.extHost.test.cjs` (new): runs the command in a real Extension Development Host.
- `src/webview/utils/plainTextPaste.ts`: `readsAsMarkdown(editor, text)` and the `code` and `markdown` modes of `insertPlainText`.
- `src/features/pastePlainTextChoice.ts` (new): the quick pick. `MarkdownEditorProvider` routes the webview's `pastePlainText.choose` message to it.

**Choice flow:**

```
host: pastePlainText {text}  ->  webview
webview: readsAsMarkdown?  no  -> insert as plain
                           yes -> pastePlainText.choose {text}  ->  host
host: quick pick (code / Markdown / plain)
host: pastePlainText {text, mode}  ->  webview inserts in that mode
```

**Detection without patterns:** `readsAsMarkdown` writes the plain paragraphs out with the editor's serializer, parses the result with the editor's parser, and compares. Any difference means the text holds live Markdown. A regular expression would flag `a * b * c` (not emphasis) and miss `__init__` (bold). A separate source code detector is not needed: code that would be misread is caught by the same check, and code that would not be misread pastes without loss.

**Performance considerations:**
- One clipboard read and one transaction per paste. Nothing is added to the typing path.

---

## 6. Work Breakdown

- [x] **Research** - keybinding path, clipboard access, root cause of the code block
- [x] **Tests first**
  - [x] `plainTextPaste.realEditor.test.ts` (58): the plain cases, the `code` and `markdown` modes, and `readsAsMarkdown` (inert text, live syntax, caret context, agreement with a real save and reload)
  - [x] `pasteVsCodeIdentifier.realEditor.test.ts` (13): the issue's symptom through a real paste event on macOS and Windows clipboard shapes, whole-line copy, undo, multi-line copy unchanged, paste into a code block, `getSingleLineEditorCopy`
  - [x] `pastePlainTextCommand.test.ts` (6): manifest entry, keybinding, host routing, empty clipboard, read failure
  - [x] `pastePlainTextMessage.test.ts` (18): webview message routing, focus and Feedback guards, asking the host, modes
  - [x] `pastePlainTextChoice.test.ts` (6): the three choices and their wording, the reply, dismissal
  - [x] `pastePlainText.extHost.test.cjs` (3): command registered; clipboard text reaches the document; text with Markdown syntax raises the choice and pastes as code
- [x] **Implementation**
- [x] **Docs** - `CHANGELOG.md`, `README.md`, `KNOWN_ISSUES.md`
- [x] **Manual check at a real keyboard** on macOS (section 7). Windows still open.

---

## 7. Implementation Log

### 2026-10-11 – Research, tests, implementation

- **What:** everything in section 6 except the manual check.
- **Symptom:** the issue's code block symptom was still present on `main`. The July paste rework did not fix it; the cause is TipTap's inherited VS Code paste plugin, not the HTML classification. The new test failed on `main` with `Hello`, a code block, ` world`.
- **Verified in a real host:** `npm run test:integration` on VS Code 1.141.0 (darwin-arm64) and on the 1.98.0 floor. The new suite runs the command the keybinding runs: the host reads the system clipboard, the shipped webview inserts the text, and the edit reaches the `TextDocument` with no code block.
- **Not verified:** the keystroke itself. This session was told not to launch VS Code windows by hand or use computer use, and the Extension Host API cannot press keys. That the chord reaches the command rests on VS Code's source (section 5) and on the existing `ctrl+alt+b` binding, which uses the same forwarding.

**Manual checklist (macOS and Windows):**
1. Copy formatted text from a web page (bold, a link, a heading). Cmd/Ctrl+Shift+V in a paragraph: plain text, no formatting. Cmd/Ctrl+V: still formatted.
2. Copy a class name from a VS Code code editor. Cmd/Ctrl+V mid-sentence: inline text, no code block.
3. Copy three lines with a blank line between the second and third. Cmd/Ctrl+Shift+V: two lines in one paragraph, then a new paragraph.
4. Cmd/Ctrl+Shift+V inside a code block and inside a table cell: see the table in section 4.
5. One Cmd/Ctrl+Z removes the whole paste and nothing else, even right after typing.
6. Open the search box (Cmd/Ctrl+F), press Cmd/Ctrl+Shift+V: the document does not change.
7. Focus the integrated terminal with the rich editor open, press Ctrl+Shift+V (Windows, Linux): the terminal pastes, the document does not change.
8. Open a `.md` file in the plain text editor, press Cmd/Ctrl+Shift+V: VS Code's Markdown preview still opens.
9. Command Palette, "Markdown Editor for Humans: Paste as Plain Text": pastes at the caret.
10. Keyboard Shortcuts: the command is listed and can be rebound.

### 2026-10-11 – Merge of main, translations, paste choice

- **Merge:** `origin/main` at `1b271df` (0.4.4) merged in. Only `CHANGELOG.md` conflicted; both entries now sit under [Unreleased]. The command title and the clipboard error go through the translation mechanism from PR 155, with all five shipped locales.
- **Paste choice:** the owner asked for detection of Markdown or code in the pasted text, a statement of the consequences, and an offer to paste as a code block or otherwise. Built as the quick pick in section 4. Eight new messages, translated for the five locales (AI drafts, open to correction).
- **Verified in a real host:** 13 passing on VS Code 1.141.0 and on 1.98.0 (darwin-arm64), run from a `git archive` export of `2f8ff05`. The new test puts `**not bold**` on the clipboard, runs the command, answers the quick pick with code, and finds the text in backticks in the document.
- **Still not verified:** the keystroke itself, and how the quick pick looks and reads in a real window.

**Added to the manual checklist:**
11. Copy `**bold** text`, press Cmd/Ctrl+Shift+V: a quick pick offers code, Markdown and plain text. Try each; Escape pastes nothing.
12. Copy `a * b * c` or a class name: no quick pick.

### 2026-10-11 – Manual keyboard check (macOS)

- **Who:** the owner, by hand, in the VS Code 1.141.0 test build running this branch (`2de293f`), other extensions disabled, with a page of copy sources and a target document.
- **Result:** reported all checks working: Cmd+Shift+V pastes plain text, the quick pick appears for text with Markdown syntax and not for lookalikes, a class name copied from a code editor pastes inline, undo, search box, Command Palette.
- **Windows and Linux:** not tested by hand and will not be before release (owner decision, 2026-10-11: no such machine is available; macOS testing is the bar). CI runs the Extension Host suite on Windows and Ubuntu, which covers the command, the clipboard read, the quick pick route and the insertion there. Only the Ctrl+Shift+V keystroke and the terminal check stay unverified on those systems; the keybinding rests on VS Code's source (section 5).
- **Still open:** a pass in a normal profile with other extensions enabled.

---

## 8. Decisions & Tradeoffs

- **Markdown syntax is literal only until the file is reloaded.** The production serializer (`escapeMarkdownSyntaxForProse` in `markdownSerialization.ts`) deliberately does not escape prose, so pasted `**bold**` is saved as `**bold**` and is bold when the file is next opened. This is the same limit as "Escaped Markdown characters" in `KNOWN_ISSUES.md`. Options that were on the table:

  | Option | Pasted `**bold**` | Cost |
  | --- | --- | --- |
  | 1. As built | Asterisks now, bold after reopen | None. Screen and file disagree until reload. |
  | 2. Read Markdown at paste time | Bold now and after reopen | A few lines. Ctrl+Shift+V then only drops HTML formatting and the code block. This is what Typora and Obsidian do. |
  | 3. Escape on save | Asterisks always | Serializer work. Backslash escapes stop Feedback from starting (known issue); entities make the source hard to read. |

  **Decided 2026-10-11 (owner):** detect the case and ask. The quick pick offers option 2 (Markdown), option 1 (plain) and, in place of escaping, code, which keeps the text literal without touching the serializer.

- **Quick pick on the host, not a prompt in the webview:** it is native, keyboard driven, themed by VS Code and needs no CSS. It costs one round trip, because only the webview knows the caret context and has the parser.
- **Ask before pasting, not after:** one choice, one undo step. A paste followed by a "convert" chip would need a second edit and its own dismissal rules.
- **Code first in the list:** it is the only choice that matches "plain text" both now and after a reload, so Enter gives the safe result.
- **Known false positive:** the check looks at the pasted text on its own. A single line pasted mid-sentence is probed behind a word so `# x` and `- x` are not flagged there, but several lines pasted into a table cell or heading can raise the question for block syntax that would not take effect.

- **Line breaks:** a single newline becomes a line break, not a new paragraph. This matches how the editor reads a single newline in a file today (`breaks: true`) and how Markdown-looking pastes are handled. ProseMirror's own plain paste would make every line a paragraph and drop the difference between a line break and a blank line.
- **Own transaction, not `view.pasteText`:** ProseMirror's paste path marks the transaction as a paste, which runs TipTap's paste rules and would turn `**bold**` into bold text.
- **`closeHistory`:** ProseMirror merges changes made within 500 ms into one undo step. Without it, undo after "type, then paste at once" would also remove the typing.
- **Single line only for the VS Code fix:** the issue is about an identifier. Multi-line code copied from VS Code still becomes a code block, which is useful for code.
- **Clipboard read on the host:** `vscode.env.clipboard` also works when the extension host is remote.
- **Could not confirm from documentation:** that `editorLangId` is unset while a custom editor has focus. The source shows it is bound to the text editor widget, and the issue reporter saw no preview open. Our keybinding outranks the built-in one in either case.
- **Not covered: browser-hosted VS Code.** There VS Code does not cancel or forward the keydown, so the browser's own plain paste fires and our paste handler treats it like Ctrl+V. Behavior there is unchanged by this task.

---

## 9. Follow-up & Future Work

- A setting to remember the choice (always code, always Markdown, always ask), if the question proves too frequent.
- A fenced block pasted as plain text into a paragraph is saved with two trailing spaces on each line (the line breaks), which end up inside the code when the file is reopened.
- Multi-line prose copied from a `.md` file open in VS Code's text editor still pastes as a `markdown` code block when it has no Markdown syntax.
- Code copied from VS Code that contains `*` pairs (`a * b * c`) is read as Markdown emphasis by normal paste.
- Browser-hosted VS Code: honor Shift on the native paste event.
- A "Paste as plain text" entry in the context menu.
