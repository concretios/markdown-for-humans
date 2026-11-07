# Task: "Add to GitHub Copilot" Toolbar Button with Multi-Context

**Status:** Implemented, tests green, verified in real VS Code Extension Development Host (integration suite)
**Date:** 2026-10-13
**Scope:** Toolbar button next to "Copy AI reference"; context action visible only when GitHub Copilot is available; each press = one dedicated chat context (chip), stackable.

## Goal

Like `copyReferenceForAi`, the button resolves the selected text lines and passes them
directly to GitHub Copilot Chat as context. Multiple presses yield multiple contexts that
are **treated distinctly** in the chat API (each with its own attachment identity,
individually removable chips).

## Key decisions

1. **One chip per press (additive).** VS Code's `workbench.action.chat.open` with
   `{ isPartialQuery: true, attachFiles: [...] }` appends entries (`attachmentModel.addFile`);
   it replaces nothing. Source: `src/vs/workbench/contrib/chat/browser/actions/chatActions.ts`.
2. **Context identity = URI fragment.** Chat attachment ids are
   `uri.toString() + range?.toString()` (`asFileVariableEntry`). A `range` that crosses the
   extension host loses its `Range` prototype over JSON-RPC, so `toString()` yields
   `[object Object]` and two ranges of the same file collide — the second context would be
   dropped silently. Therefore every context also carries its lines as a fragment in the
   familiar reference form: `file.md#L10-14`. Different ranges ⇒ different ids ✓,
   the same range again ⇒ natural dedupe ✓, the chip label stays the file name
   (`basename` only uses `path`), `fileService` ignores the fragment.
3. **`range` = internal 1-based `IRange`** (`{startLineNumber, startColumn, endLineNumber,
endColumn}`), like VS Code's own "Add Selection to Chat" — not `vscode.Range`.
4. **Parity with `copyReferenceForAi`:** flush barrier + save rule before the line mapping,
   `untitled` refused, line resolution fail-closed via `resolveAiReferenceLines`
   (never estimated), whole-file fallback with a warning toast when the spot cannot be
   matched.
5. **Availability:** `vscode.extensions.getExtension('github.copilot-chat')` **and**
   `getCommands(true)` contains `workbench.action.chat.open`. Broadcast as
   `copilotChatAvailability` to all rich views on `ready` and via `extensions.onDidChange`.
   The button is hidden by default (`isVisible` hook in the toolbar).
6. **Context numbering** ("(context 1)") per document, discarded when the last split
   closes — contexts accumulate per document opening without a reset UI.
7. **Scope:** Toolbar button only — no command, no keybinding, no setting
   (`package.json` unchanged), no context menu.

## Tests (TDD, RED → GREEN)

| Test                                                       | Covers                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/__tests__/shared/copilotContextProtocol.test.ts`      | Fail-closed parsing of `addToCopilot` / `copilotChatAvailability`; distinct selections stay distinct                                                                                                                                                                                                                                                                          |
| `src/__tests__/editor/copilotContextProvider.test.ts`      | Exact lines as one differentiated chat context; each press its own context + own identity; stable context numbers including repetition; numbering forgotten on document close; save rule; save failure; untitled; whole-file fallback; clipboard fallback without Copilot; malformed fail-closed; availability post/broadcast; `toCopilotChatAttachRange` (IRange + clamping) |
| `src/__tests__/webview/toolbarCopilotButton.test.ts`       | Button directly after Copy-Reference, `codicon-copilot` icon, l10n tooltip, hidden initially, visibility via `setToolbarCopilotVisible`, click dispatches `addToCopilot`                                                                                                                                                                                                      |
| `src/__tests__/webview/toolbarCopyReferenceButton.test.ts` | Ordering updated: Copy button → Copilot button → separator                                                                                                                                                                                                                                                                                                                    |
| `test/integration/addToCopilot.extHost.test.cjs`           | **Real VS Code:** availability rule; `workbench.action.chat.open` accepts the fragment+IRange payload twice (two distinct contexts)                                                                                                                                                                                                                                           |

## Implementation

- `src/shared/copilotContextProtocol.ts` (new) — webview↔host contract, fail-closed parsers
  (`parseAiReferenceSelection` reused/refactored from `aiReferenceProtocol.ts`).
- `src/editor/copilotContext.ts` (new) — availability, `copilotContextFragment`,
  `toCopilotChatAttachRange`.
- `src/editor/MarkdownEditorProvider.ts` — `handleAddToCopilot` (same shape as
  `handleCopyReferenceForAi`; both now share the `runAiReferenceAction` driver),
  `registerCopilotContext`, `postCopilotChatAvailability`,
  `broadcastCopilotChatAvailability`, `addToCopilot` case + `ready` announce +
  `extensions.onDidChange` in `register`, registry disposal in `unregisterFeedbackWebview`.
- `src/webview/BubbleMenuView.ts` — `copilot-add-button` after `copy-reference-button`,
  `isVisible` hook + `setToolbarCopilotVisible`, `element.hidden` in `refreshActiveStates`.
- `src/webview/editor.css` — `.toolbar-button[hidden] { display: none; }`.
- `src/webview/editor.ts` — `addToCopilot` listener (same payload as `copyReferenceForAi`),
  `addToCopilot.result` (toast) and `copilotChatAvailability` (visibility) cases.
- l10n: 8 new strings, `npm run l10n:extract`, translations in all 5 bundles
  ("GitHub Copilot" left untranslated). `vibe-coding-rules/env-context.md` key files updated.

## Verification

- `npx jest` green for all new/changed suites (27+14+7 tests).
- `npm test`: 5050+ tests green; 6 failed suites = pre-existing (list from the repo notes:
  feedbackReportV2, imagePathResolution, feedbackEvidenceV2.golden, feedbackProvider,
  feedbackSessionStore + `typographyStyles` — the latter also pre-existing, verified against
  HEAD via git stash: CRLF worktree vs. the test's LF regex).
- `npx tsc --noEmit` clean; ESLint shows no non-prettier errors (the prettier EOL noise is the
  documented `core.autocrlf` environment state).
- `npm run build:release` + `npm run verify-build` PASSED.
- `npm run test:integration` (real VS Code ext host): **18 passing**, including the new
  attach contract test (payload executed twice, without errors).
- **Open (no computer-use tools in this environment):** native UI checks — button visibility
  in the toolbar rendering, actual chips in the Copilot chat input, multi-chip differentiation
  in the UI, 10-minute reading check. Per AGENTS.md, browser tests are no substitute; these
  checks remain to be done during user review (procedure: plan section "Verification").
