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

The three most likely to cost a bad review if left alone:

1. **Blank editor (#127, and a second user on closed #12).** Two people on 0.3.0 report an editor that opens blank. It did not reproduce with 0.3.0 or 0.4.3 on macOS, and the Linux Extension Host tests pass, so the cause is unknown. Both reports are unanswered.
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
| 127 | lesh59 | Needs info | unknown | Blank editor on 0.3.0, VS Code 1.140, Linux. Not reproduced: 0.3.0 and 0.4.3 both render on macOS 1.141 (native), and the Linux Extension Host tests start Feedback on rendered documents. The "local-network-access" console line is a VS Code warning. 0.4.x was published the day after the report. |
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
| 12 | osawereao | Closed as fixed 2026-05-19 | A different user (@orionseye, 2026-08-24, on 0.3.0) says it is not fixed: files open blank until retried. Same symptom as #127. Do not ask anyone on this thread for a rating; reply and fold it into #127. |
| 27 | dlivxpr | Closed 2026-05-11 | The last comment asks for a smaller default text size. `markdownForHumans.zoom` now covers that; a short answer is owed. |

Reporters whose issue was fixed and closed, in the order I would ask for a rating: @marchy (#14, already replied "Amazing"), @ZashIn (#20), @unSerori (#18), @epmsmid (#28), @SiweiCui (#52), @zhirafovod (#37, #39), @dlivxpr (#27, after the zoom answer). Fix versions below are inferred from close dates, not verified per issue.

## Draft replies

None of these has been posted.

### Already fixed

**#56** (close)
> Thanks for the precise report. This was fixed after 0.2.1: inline code inside link text now round-trips, and there are regression tests for exactly this case. I reran your example, `` [`foo()`](./bar.ts:10) ``, against 0.4.3 and it saves unchanged. Please update to 0.4.3 and reopen if you still see it.

**#80** (close)
> Fixed. The 0.4 series replaced the highlighter, and it now covers 36 languages including C#. I opened your attached file in 0.3.0 (no colors, as you reported) and in 0.4.3 (highlighted). Please update to 0.4.3.

### Already available

**#25** (close)
> The Explorer sidebar has a view called "Markdown Editor for Humans: Outline". It lists the document's headings, follows the cursor, and jumps to a heading when you click it. It appears while the editor is active; if you do not see it, right-click the Explorer title and enable it. It is our own view, not VS Code's OUTLINE panel.

**#64** (close)
> Both exist. Run **Open with Markdown Editor for Humans** from the Command Palette on the active Markdown file, and bind it under Keyboard Shortcuts (command ID `markdownForHumans.openFile`). To open every Markdown file with it, right-click a `.md` file, choose **Open With...**, then **Configure default editor for '*.md'...** and pick **Visual Editor** (Markdown Editor for Humans).

### Needs information

**#127**
> Sorry for the slow reply. Version 0.4.3 is now on the Marketplace; 0.3.0 was the last published version when you reported this, and a lot of the loading path changed in between. Could you update and try again? If it is still blank, three things would help: the list of other Markdown extensions you have enabled, whether it happens with all other extensions disabled (Extensions: Disable All Installed Extensions, then enable only this one), and any red errors in Help > Toggle Developer Tools > Console. The "local-network-access" line is a VS Code warning and not the cause.

**#12** (comment for @orionseye; consider reopening)
> @orionseye this should not have stayed closed without an answer to you. 0.4.3 is out and changed how the editor loads. If files still open blank after updating, please add your VS Code version, OS and enabled Markdown extensions to #127, where we are tracking it. The tab that closes when you open the next file is VS Code's preview tab behavior: double-click a file, or set `workbench.editor.enablePreview` to false, to keep tabs open.

### Defects, acknowledged

**#23**
> Confirmed, and you are right that it should follow your default editor. Links to other files are opened with the plain text editor today, whatever your default is. Fix planned for the next release.

**#81**
> Confirmed: the dropdown has 13 languages and C# is not among them, although C# highlighting itself works since 0.4 (type ```` ```csharp ````). We will add it, with the other languages the highlighter supports.

**#84**
> You are right, and thank you for tracing it. PR #54 was merged, then reverted before 0.3.0 was tagged, and the changelog and release notes kept the entry. That is our mistake. We are removing the entry from both. Your contribution is still credited in the notes, marked as not shipped.

**#69**
> An honest status: the single-newline rendering is unchanged in 0.4.3. A hard-wrapped paragraph still shows one line per source line. What did change is the save path: since 0.4.1, blocks you do not edit are written back byte for byte, which removes most of the reflow churn that sank #70 and #99. We are planning the rendering change as its own piece of work for the next minor release and will post the plan here.

**#13**
> It depends on how the image is added. Dragging it from the VS Code Explorer links the existing file in place (hold Shift if the drop does nothing). Choosing it with "browse" in the insert dialog, or dropping it from Finder or File Explorer, always saves a copy, because the editor only receives the image's contents and not its path. We agree it should reuse the existing file and have it on the list.

### Questions and requests

**#46**
> It is on purpose for now. The editor reads and writes files, renders their content, and can launch Chrome for PDF export from a setting, so it declares that it needs a trusted workspace. Enabling it for an untrusted folder through settings is as safe as trusting the Markdown files in that folder: a document cannot run code in the editor, but export and image handling do touch the disk. A limited mode for untrusted folders is a reasonable request and we will track it here.

**#140**
> It was removed on purpose in 0.4.0 when the feedback workflow came in, and you are the second person to ask for it back. A plain "copy reference" command with no extra UI is a fair request. We are deciding whether to restore it as a Command Palette command you can bind to a key, including inside tables.

**#86 / #15**
> Font control is on the shortlist for the next release: family, weight and line height for body text, falling back to your VS Code font. Text size already has `markdownForHumans.zoom`. If there is a specific font you rely on, tell us and we will test with it.

**#27** (closed; answer the follow-up)
> For the text size: `markdownForHumans.zoom` sets the editor's size as a percentage, and the editor follows your VS Code font otherwise.

### Thank-you for closed, fixed issues

For @marchy (#14), @ZashIn (#20), @unSerori (#18), @epmsmid (#28), @SiweiCui (#52), @zhirafovod (#37, #39):

> Thanks again for reporting this. The fix has shipped, and the extension is now called Markdown Editor for Humans (0.4.3). If it has been useful, a rating helps other people find it: [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=concretio.markdown-for-humans&ssr=false#review-details), or [Open VSX](https://open-vsx.org/extension/concretio/markdown-for-humans/reviews) if you use Cursor or Devin Desktop.

## Decisions for the owner

1. **Post the replies?** They would go out from the owner's GitHub account. Closing #56, #80, #25 and #64 takes the open count from 25 to 21.
2. **#140:** restore the copy reference command, or keep it retired.
3. **#69:** commit to the soft-break rendering change for 0.5.0, or tell the reporters it will stay as is.
