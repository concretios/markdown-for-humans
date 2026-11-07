# Issue triage, October 2026

**Date:** 2026-10-10 · **Checked against:** `main` at `3678ce9` (0.4.3 plus README changes) · **Scope:** all 25 open issues, every one opened by an outside reporter.

Each issue was read in full and checked against the current code, `CHANGELOG.md` and `KNOWN_ISSUES.md`. Where it says "native", the behavior was also checked in a real VS Code 1.141.0 window on macOS with the published 0.4.3 VSIX (click-only computer use). Verdicts not confirmed that way are marked "code only" or "unverified".

## Summary

| Bucket | Count | Issues |
|---|---|---|
| Already fixed, can be closed | 2 | #56, #80 |
| Already available, answer and close | 2 | #25, #64 |
| Real defect, still present | 5 | #13, #23, #69, #81, #84 |
| Needs information | 1 | #127 |
| Feature request | 14 | #11, #15, #16, #19, #29, #46, #55, #58, #61, #62, #72, #77, #86, #140 |
| Out of scope | 1 | #60 |

The three that most need attention:

1. **Blank editor (#127, and a second user on closed #12).** Two people on 0.3.0 report an editor that opens blank. It did not reproduce with 0.3.0 or 0.4.3 on macOS, including a multi-folder workspace like the reporter's, and the Linux Extension Host tests pass. The cause is unknown, and no change in 0.4.x is known to address it.
2. **Hard-wrapped paragraphs render as broken lines (#69).** Confirmed natively on 0.4.3. Two community PRs were closed on 2026-10-01 with the note that it was "being fixed in the serializer"; the rendering has not changed.
3. **Release notes describe a feature that does not exist (#84).** The 0.3.0 changelog and GitHub release announce an editor theme override that was reverted before the release. The contributor who wrote it found the gap himself.

## All open issues

| # | Reporter | Bucket | Size | Verdict |
|---|---|---|---|---|
| 11 | BVerma-CRM | Feature | S/M | Paste as plain text (Ctrl/Cmd+Shift+V) is not implemented. Fits the product. Code only. |
| 13 | KostasDgk | Defect | M | Dragging from the VS Code Explorer links an in-workspace image in place, but the insert dialog's "browse" and drops from the OS always save a new copy, because the webview never learns the file's path. Code only. |
| 15 | BeeboTaylor | Feature | M | Body text uses `--vscode-font-family`; `[markdown]` editor settings are not read and there is no font setting. Same ask as #86. |
| 16 | BeeboTaylor | Feature | S/M | No setting or command hides the toolbar. Fits "distraction free". |
| 19 | yostar | Feature | S | No emoji picker. The OS picker (Win+. or Ctrl+Cmd+Space) should work in the editor; unverified. |
| 23 | WAKUDOdani | Defect | S | `handleOpenFileLink` opens every non-image link with `openTextDocument` + `showTextDocument`, so a link to another `.md` file always opens in the text editor, even when this editor is the default. Code only (links need Cmd/Ctrl+click, which computer use cannot send). |
| 25 | BeeboTaylor | Available | none | The Explorer has a "Markdown Editor for Humans: Outline" view with click to jump (native). It is not VS Code's own OUTLINE panel. |
| 29 | phpw0929 | Feature | M | List items are written with marker-width indentation (2 spaces for `- `); there is no setting. Since 0.4.1 a list you do not edit keeps its original indentation. |
| 46 | charles-slc | Feature (question) | M | `untrustedWorkspaces.supported` is `false` on purpose: the extension reads, writes and exports workspace content and can launch Chrome from a setting. A limited mode is possible but security sensitive. |
| 55 | Mutotoo | Feature | L | No localization layer; UI strings are hardcoded. Same ask as #77. |
| 56 | karanrahar | Fixed | none | `` [`foo()`](./bar.ts:10) `` round-trips unchanged. Regression tests exist since 2026-07-13 (shipped in 0.3.0); the exact case was rerun against `main` and passes; code inside a link renders with both styles (native). Reported on 0.2.1. |
| 58 | jelez | Feature | M | `==highlight==` is not parsed or rendered. |
| 60 | osawereao | Out of scope | L | Zed uses a different extension system; this is a VS Code custom editor built on a webview. |
| 61 | kulinna | Feature | L | Line numbers and Quick Fix integration for AI extensions. Overlaps #140. |
| 62 | MEntOMANdo | Feature | S/M | No triple-click handling: the browser default selects the whole code block. The copy button they also asked for exists since 0.3.0. Code only. |
| 64 | karellm | Available | none | The command **Open with Markdown Editor for Humans** is in the Command Palette and can be bound to a key; **Open With... > Configure default editor** makes it the default. There is no default keybinding. |
| 69 | nacisimsek | Defect | M/L | `breaks: true` in `src/webview/editor.ts` still turns every single newline into a line break (native: a three-line hard-wrapped paragraph shows as three lines). PRs #70 and #99 were closed unmerged. |
| 72 | zhouxinghong | Feature | M/L | Raw HTML such as `<video>` is shown as source, as documented. Rendering media needs a content security review. |
| 77 | FrankSAURET | Feature | L | Translation. Same as #55. |
| 80 | laicasaane | Fixed | none | C# highlighting. Reproduced on 0.3.0 (no colors), fixed on 0.4.3 with the reporter's own file (native). The 0.4.0 highlighter loads 36 grammars including `csharp`. |
| 81 | laicasaane | Defect | S | The toolbar code block dropdown lists 13 languages and C# is not one of them. Typing ```` ```csharp ```` works. Code only. |
| 84 | jprisant | Defect (docs) | S | `CHANGELOG.md` [0.3.0] and the v0.3.0 GitHub release announce `markdownForHumans.display.editorTheme` and a toolbar toggle. PR #54 was reverted on 2026-06-19 (`decf0c6`); neither exists in the code. |
| 86 | davidjdixon | Feature | M | Font family, weight, size and line height for readability (accessibility). The reporter calls it the blocker to making this the default editor. The owner's question from 2026-09-27 is unanswered. Same as #15. |
| 127 | lesh59 | Needs info | unknown | Blank editor on 0.3.0, VS Code 1.140, Linux. Not reproduced: 0.3.0 and 0.4.3 both render on macOS 1.141 (native), and the Linux Extension Host tests start Feedback on rendered documents. Whether the "local-network-access" console line is related is not established. 0.4.x was published the day after the report; no change in it is known to address this. |
| 140 | bperunx | Feature (question) | S/M | Copy AI Context Reference (`@file#L10-14`, Alt+C) was removed on purpose in 0.4.0 (PR #90). The old code is kept at tag `archive/copy-ai-context-line-numbers`. Second request for the same thing after #61. |

Size: S is under a day with tests, M is one to three days, L is a week or more.

## Shortlist for 0.4.4

Ranked by user value against risk. The existing branch `fix/toolbar-label-and-word-export` (Word export fixes, toolbar gear label) is already slated and is not repeated here.

| Rank | Issue | Change | Files | Suggested test |
|---|---|---|---|---|
| 1 | #84 | Remove the Editor Theme Override entry from the [0.3.0] changelog and correct the v0.3.0 GitHub release. | `CHANGELOG.md`, GitHub release | None; docs. |
| 2 | #23 | Open linked `.md` files with `vscode.open` (which honors the user's default editor) and keep `showTextDocument` for other text files. | `src/editor/MarkdownEditorProvider.ts` (`handleOpenFileLink`) | Jest: a `.md` link calls `vscode.open` with the file URI; a `.ts` link still calls `showTextDocument`. |
| 3 | #81 | Add C#, C, C++, PHP, Ruby, YAML, Kotlin, Swift and Shell to the dropdown, built from the highlighter's registry so the two cannot drift. | `src/webview/BubbleMenuView.ts`, `src/webview/highlighting/languageRegistry.ts` | Jest: every dropdown language resolves to a registered grammar; `csharp` is present. |
| 4 | #15, #86 | Settings for body font family, line height and weight, falling back to the VS Code font. Size already has `markdownForHumans.zoom`. | `package.json`, `src/editor/MarkdownEditorProvider.ts`, `src/webview/editor.css`, README settings table | Jest: settings become CSS variables on the editor root; empty values keep today's fonts. Native read of a long document in both themes. |
| 5 | #11 | Paste as plain text on Ctrl/Cmd+Shift+V. | `src/webview/utils/pasteHandler.ts`, `package.json` keybinding | Jest: a plain paste of rich clipboard content inserts unformatted text and no code block. |
| 6 | #62 | Triple-click inside a code block selects the line, not the block. | code block node view under `src/webview/extensions/` | Jest: a click with `detail === 3` selects from line start to line end. |
| 7 | #140 | Restore "Copy reference for AI" as a Command Palette command (no toolbar button), from the archived tag. Needs the owner's yes, since it was removed on purpose. | `package.json`, `src/extension.ts`, archived implementation | Jest: selection in a paragraph and in a table cell both produce `@path#Lx-y`. |

Not in 0.4.4:

- **#69 soft breaks.** The highest value item on the list for reading experience, and the riskiest: two PRs foundered on save churn. Saves now keep unedited blocks byte for byte (0.4.1), which removes most of that objection. It deserves its own plan file and a 0.5.0 slot, not a patch release.
- **#13 image copies.** Medium, touches the image pipeline; next after the fonts work.

## Closed issues worth a second look

| # | Reporter | State | Note |
|---|---|---|---|
| 12 | osawereao | Closed as fixed 2026-05-19 | A different user (@orionseye, 2026-08-24, on 0.3.0) says it is not fixed: files open blank until retried. Same symptom as #127. Treat it as open and track it with #127. |
| 27 | dlivxpr | Closed 2026-05-11 | The last comment asks for a smaller default text size. `markdownForHumans.zoom` now covers that; a short answer is owed. |

## Decisions for the owner

1. **#140:** restore the copy reference command, or keep it retired.
2. **#69:** logged as a planned task in `task-soft-breaks.md`, to be done on its own branch.

Replies to reporters are not part of this document. Nothing is posted on an issue until the analysis behind it has been tested and reviewed.
