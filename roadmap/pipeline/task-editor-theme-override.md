# Task: Editor Theme Override (Display setting + toolbar toggle)

## 1. Task Metadata

- **Task name:** Editor Theme Override
- **Slug:** editor-theme-override
- **Status:** in-progress
- **Created:** 2026-05-26
- **Last updated:** 2026-05-26
- **Shipped:** _(pending)_

---

## 2. Context & Problem

**Current state:**
- The WYSIWYG editor derives every color from `--vscode-*` CSS variables (`src/webview/editor.css:6-30`), so its appearance always mirrors the user's active VS Code color theme.
- Syntax-highlighting rules are scoped to the webview body class `.vscode-dark`, which VS Code sets based on the active theme.
- There is no way to view the editor in a light skin while VS Code is dark (or vice versa).

**Pain points:**
- **No independent control:** A user who keeps VS Code in dark mode cannot preview/edit a document with a light "paper" look without changing their whole VS Code theme.
- **No quick switch:** Even if a preference existed, flipping it should be one click from the editor, not a trip into Settings.

**Why it matters:**
- Writing and reviewing prose often benefits from a light reading surface even when the rest of the IDE is dark.
- Document-centric editors (Typora, Obsidian, Notion) all let the document surface be themed independently of the chrome. This brings the editor to parity.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- A new setting `markdownForHumans.display.editorTheme` offers: Follow VS Code theme (default), Always use the default light theme, Always use the default dark theme.
- Selecting a forced theme renders the editor (content + toolbar) in a self-contained light or dark palette regardless of the active VS Code theme.
- A toolbar button toggles between the default light and default dark theme; the change applies to every open editor instance, not just the current file.
- "Follow VS Code theme" reproduces today's behavior exactly (no regression).
- Code blocks keep correct syntax-highlight colors under a forced theme.

**In scope:**
- The `editorTheme` enum setting (`scope: application`).
- A `color-mode` toolbar toggle button that writes the opposite of the currently effective appearance to global config.
- Self-contained light and dark palettes in `editor.css`, applied via a body class.
- Re-scoping the `.vscode-dark` syntax-highlight block to also fire under forced dark.
- Broadcasting the setting to all open panels on change (reusing the existing flow).

**Out of scope:**
- Per-file persistence of the theme choice (the toggle changes the global default for all files by design).
- Custom / user-defined palettes.
- Storing the choice in document frontmatter.
- Mirroring the user's *specific* configured light/dark theme; we use fixed Light+/Dark+ stock palettes.

---

## 4. UX & Behavior

**Entry points:**
- Settings UI: `Markdown for Humans > Display: Editor Theme`.
- Toolbar: a `color-mode` (half-filled circle) button placed at the end of the toolbar, immediately to the right of the gear/settings button.

**User flows:**

### Flow 1: Choose a fixed theme from Settings
1. User sets `Display: Editor Theme` to "Always use the default dark theme".
2. All open Markdown for Humans editors re-render in the fixed dark palette immediately.
3. New editors open in the fixed dark palette.

### Flow 2: Quick toggle from the toolbar
1. Setting is "Follow VS Code theme"; VS Code is dark, so the editor shows dark.
2. User clicks the toolbar theme toggle.
3. Extension computes the effective appearance (dark) and writes the opposite (`defaultLight`) to global config.
4. All open editors switch to the fixed light palette. Subsequent clicks flip Light <-> Dark.

**Behavior rules:**
- Effective appearance resolution: if `editorTheme === 'vscode'`, use `vscode.window.activeColorTheme.kind` (Dark and HighContrast -> dark; Light and HighContrastLight -> light); otherwise use the setting value.
- The toggle only ever writes `defaultLight` or `defaultDark`. "Follow VS Code theme" is re-selectable only from the Settings dropdown.
- The config write targets `ConfigurationTarget.Global` so it changes the default for all windows/files.
- When `editorTheme === 'vscode'`, no override class is applied and the editor behaves exactly as today.

---

## 5. Technical Plan

**Surfaces:**
- Extension host (VS Code API): settings contribution, config read/broadcast, toggle message handler.
- Webview (TipTap editor): toolbar button, apply/clear override class.
- Styles: `editor.css` light/dark palettes.

**Key changes:**
- `package.json` - add `markdownForHumans.display.editorTheme` enum under `contributes.configuration` (with `enumDescriptions`, `scope: application`).
- `src/editor/MarkdownEditorProvider.ts` - read `editorTheme`, include it in the `update`, `ready`, and `settingsUpdate` payloads; extend `onDidChangeConfiguration` to watch `markdownForHumans.display.editorTheme`; add a `toggleTheme` message handler that calls a pure resolver and writes opposite value to global config.
- `src/editor/themeResolver.ts` (new) - pure function `resolveToggleTarget(setting, vscodeKind) => 'defaultLight' | 'defaultDark'` so it is unit-testable without VS Code.
- `src/webview/BubbleMenuView.ts` - add the `color-mode` toggle button as the last entry in the `buttons` array, after the `settings-button` gear (posts `{type:'toggleTheme'}`).
- `src/webview/editor.ts` - handle `editorTheme` in `update`/`settingsUpdate`; add `applyThemeOverride(mode)` next to `applyEditorSettings()` to set/clear `mdfh-force-light`/`mdfh-force-dark` on `document.body`.
- `src/webview/editor.css` - define `.mdfh-force-light` and `.mdfh-force-dark` blocks that override the `--vscode-*` variables the editor consumes (editor bg/fg, widget bg/border, button bg/fg, link, code bg, panel border, list hover, focus border); add `.mdfh-force-dark` as a sibling selector to the existing `.vscode-dark` syntax-highlight rules.

**Architecture notes:**
- Single source of truth is the `editorTheme` setting; the toggle is a binary writer to it. No new persistence layer.
- Overriding the underlying `--vscode-*` variables (rather than each `--md-*` token or per-rule colors) means both content and toolbar chrome re-theme from one class with no per-rule edits.
- Reuses the existing `settingsUpdate` broadcast and `onDidChangeConfiguration` plumbing already used for zoom and paragraph spacing.

**Performance considerations:**
- Theme change is a class toggle + CSS variable recompute; negligible. No layout/typing impact.

---

## 6. Work Breakdown

- [ ] **Phase 1: Setting + plumbing** - declare setting, flow value to webview
  - [ ] Add `markdownForHumans.display.editorTheme` to `package.json`
  - [ ] Include `editorTheme` in `update`/`ready`/`settingsUpdate` payloads
  - [ ] Watch the setting in `onDidChangeConfiguration` and broadcast to all panels
- [ ] **Phase 2: Theme resolver (TDD)** - pure toggle logic
  - [ ] Write failing tests for `resolveToggleTarget` (all settings x dark/light/HC)
  - [ ] Implement `src/editor/themeResolver.ts`
- [ ] **Phase 3: Toolbar toggle** - UI + message
  - [ ] Add `color-mode` button in `BubbleMenuView.ts` posting `toggleTheme`
  - [ ] Handle `toggleTheme` in provider: resolve target, `config.update(..., Global)`
- [ ] **Phase 4: CSS palettes** - forced light/dark
  - [ ] Add `.mdfh-force-light` / `.mdfh-force-dark` variable overrides
  - [ ] Re-scope `.vscode-dark` syntax-highlight rules to include forced dark
  - [ ] Add `applyThemeOverride()` in `editor.ts` and wire to messages
- [ ] **Testing**
  - [ ] Unit tests for `resolveToggleTarget`
  - [ ] Webview test that `applyThemeOverride` sets/clears the correct body class
  - [ ] Manual: each setting value x VS Code dark/light; toggle across multiple open files; code-block colors; `npm run verify-build`

---

## 7. Implementation Log

### 2026-05-26 - Feature implemented (TDD)

- **What:** Built the setting, toolbar toggle, and forced palettes end to end.
- **Files:**
  - `src/shared/editorTheme.ts` (new) - pure helpers `appearanceFromKind`, `effectiveAppearance`, `resolveToggleTarget`, `forcedThemeClass`.
  - `src/__tests__/editor/editorTheme.test.ts` (new) - 15 unit tests (written first; watched red then green).
  - `package.json` - `markdownForHumans.display.editorTheme` enum (scope: application).
  - `src/editor/MarkdownEditorProvider.ts` - `getEditorTheme()`, `editorTheme` in update/ready/settingsUpdate payloads, config watch, `toggleTheme` -> `handleToggleTheme()` writing the opposite to global config.
  - `src/webview/BubbleMenuView.ts` - `color-mode` toggle button after the gear.
  - `src/webview/editor.ts` - `toggleTheme` event bridge + `applyThemeOverride()` wired into `applyEditorSettings`.
  - `src/webview/editor.css` - `.mdfh-force-light` / `.mdfh-force-dark` palettes overriding the `--vscode-*` tokens; dark syntax-highlight selectors guarded with `:not(.mdfh-force-light)` and given `.mdfh-force-dark` alternates.
  - `src/__tests__/editor/undoSync.test.ts` - updated two payload assertions for the new `editorTheme` field.
  - `scripts/verify-build.js` - added `toggleTheme` and `.mdfh-force-dark` as tree-shake guards.
- **Notes:**
  - Per-panel `onDidChangeConfiguration` means a single global config write re-themes every open editor with no extra broadcast code.
  - Verified: 873 tests pass, `npm run build:release` + `verify-build` pass (7/7, 6/6, 4/4 features).
  - Pre-existing repo state: the Windows checkout is CRLF (`core.autocrlf=true`) while prettier expects LF, so `npm run lint` reports CRLF errors across all files (not introduced here). Git normalizes to LF on commit. No non-CRLF lint issues in the changed files.
- **Remaining:** manual verification in the Extension Development Host (the webview/provider are excluded from unit coverage by design) and a screen recording for the PR per CONTRIBUTING.

### 2026-05-27 - Refinements from local VSIX testing

Three issues surfaced while testing packaged builds; each was root-caused and fixed:

- **Container/background frame:** the forced palette only set `--vscode-*` on `body`, so the page root and body element backgrounds stayed on the real theme, leaving a mismatched frame around the editor. Fixed by giving `body.mdfh-force-*` an explicit forced `background-color` and adding `html.mdfh-force-*` blocks with a literal page-background color for the overscroll area.
- **Inherit the real theme:** forcing dark always used the synthetic `#1f1f1f` palette even when the user's VS Code dark theme differed. Replaced `forcedThemeClass(setting)` with `overrideClassFor(setting, vscodeIsDark)`: when the requested direction already matches VS Code's active appearance we apply no override (inherit the live theme); the synthetic palette is used only when forcing the opposite. The provider now reports `vscodeIsDark` (via `appearanceFromKind(activeColorTheme.kind)`) in the payloads and re-broadcasts on `onDidChangeActiveColorTheme` so the decision stays live.
- **First-load race (needed a second reload):** VS Code reassigns `body.className` during its theme handshake, wiping our class right after the first apply. Made the override self-healing with a `MutationObserver` on the `class` attribute of `html`/`body` that re-asserts the desired state (reconcile only mutates when out of sync, so it settles in one pass).

Test suite updated accordingly (now 875 passing): `overrideClassFor` replaces `forcedThemeClass` in tests; the `vscode` mock and the `inMemoryFiles` inline mock gained `activeColorTheme` + `onDidChangeActiveColorTheme`; `undoSync` payload assertions include `vscodeIsDark`.

---

## 8. Decisions & Tradeoffs

- **Toggle writes global config (not per-file state):** Matches the requested "changes the default for all opened files" behavior and avoids a new persistence layer. Tradeoff: no per-file theme memory.
- **Override `--vscode-*` variables on a body class:** Cascades to content and toolbar with no per-rule edits. Tradeoff: relies on the editor consuming `--vscode-*` consistently (true today).
- **Fixed Light+/Dark+ palettes:** Predictable and simple. Tradeoff: does not mirror the user's specific configured theme.
- **"Follow VS Code" only via dropdown:** A binary toggle cannot cleanly represent three states; keeping "Follow" in Settings keeps the icon meaning unambiguous.

---

## 9. Follow-up & Future Work

- Optional per-file theme memory (workspace state keyed by URI).
- User-customizable palette tokens.
- Auto-detect OS color scheme as a fourth mode.
