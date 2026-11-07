# Task: Font and readability settings

## 1. Task Metadata

- **Task name:** Font and readability settings for body text
- **Slug:** font-readability-settings
- **Status:** shipped
- **Created:** 2026-10-11
- **Last updated:** 2026-10-11
- **Shipped:** 2026-10-11 (0.4.4)
- **Issues:** #86 (font options, ADHD reader), #15 (respect `"[markdown]"` editor settings), #27 last comment (size)

---

## 2. Context & Problem

**Current state (verified on main, 2026-10-11):**

- `src/webview/editor.css` sets no `font-family` on `.markdown-editor`. Body text inherits VS Code's injected webview default, `body { font-family: var(--vscode-font-family); font-weight: var(--vscode-font-weight) }`. That is the workbench UI font at a fixed `normal` weight, not `editor.fontFamily`.
- Body size is `--md-base-size`, which is `var(--vscode-editor-font-size, 14px)` scaled by `markdownForHumans.zoom` (50 to 200).
- Line height is a hard-coded `1.58` (root, `p`, `li`, `blockquote`, `.github-alert`); letter spacing is `-0.003em`; word spacing is the browser default.
- Code uses `var(--vscode-editor-font-family, monospace)` or fixed monospace stacks.
- Existing reader settings: `markdownForHumans.zoom`, `markdownForHumans.paragraph.spacingBefore`, `markdownForHumans.paragraph.spacingAfter`. All are `application` scope, read in `MarkdownEditorProvider`, posted in `update` and `settingsUpdate`, and applied by `applyEditorSettings` in `src/webview/editor.ts` as CSS custom properties on `<html>`.
- PDF export uses its own print stylesheet (Charter/Georgia serif, 16px, 1.6). Word export uses the `docx` library defaults. Neither reads zoom, paragraph spacing or any editor font.

**What a webview can and cannot know (verified against VS Code source and typings):**

- `microsoft/vscode` `src/vs/workbench/contrib/webview/browser/themeing.ts` builds `--vscode-editor-font-family`, `--vscode-editor-font-weight` and `--vscode-editor-font-size` from `configurationService.getValue('editor')` with no language override. A `"[markdown]"` block is therefore invisible to webview CSS.
- `--vscode-font-family` is the workbench default font; `--vscode-font-weight` is the literal `normal`; `--vscode-font-size` is `13px`.
- `@types/vscode` 1.98.0: `getConfiguration(section?, scope?: ConfigurationScope)` where `ConfigurationScope` includes `{ uri?: Uri; languageId: string }`. The extension host can read the `"[markdown]"` value with `getConfiguration('editor', { languageId: 'markdown' })`.

**Pain points:**

- **No font choice (#86):** a reader with ADHD who depends on a specific font cannot use the editor daily. They call it "the real blocker".
- **Editor font ignored (#15):** a user who set `"[markdown]": { "editor.fontFamily": "Aptos", "editor.fontWeight": "500" }` sees no effect.
- **Spacing is fixed:** readers who need looser lines, letters or words have no control.

**Why it matters:**

- Reading experience is the product's first principle. A reader who cannot use their font cannot read comfortably at all.
- WCAG 2.2 success criterion 1.4.12 (Text Spacing) names four properties readers override: line height (1.5), paragraph spacing (2em), letter spacing (0.12em), word spacing (0.16em). The editor offers one of the four today.

---

## 3. Desired Outcome & Scope

**Success criteria:**

- With every new setting at its default, no CSS custom property is set and each stylesheet fallback equals today's value. Proven by test.
- A reader can set the body font family, weight, line height, letter spacing and word spacing; each applies live to every open editor without reopening the file.
- A hostile font-family value cannot inject styles. Proven by test.
- Code blocks and inline code stay monospace when a body font is set.
- No new dependency, no bundled font, no network call.

**Settings (all `"scope": "application"`, like `zoom`):**

| Key | Type | Default | Allowed | Applies as |
| --- | --- | --- | --- | --- |
| `markdownForHumans.font.family` | string | `""` | CSS font-family list, up to 16 families and 1024 characters | `--md-font-family` |
| `markdownForHumans.font.weight` | number | `400` | 100 to 900 | `--md-font-weight` |
| `markdownForHumans.font.lineHeight` | number | `1.58` | 1 to 3 (multiple of font size) | `--md-line-height` |
| `markdownForHumans.font.letterSpacing` | number | `0` | 0 to 0.5 (em) | `--md-letter-spacing` |
| `markdownForHumans.font.wordSpacing` | number | `0` | 0 to 1 (em) | `--md-word-spacing` |
| `markdownForHumans.font.useEditorFont` | boolean | `false` | | resolves family, weight and size from `editor.*` |

**What the settings apply to:**

| Element | Family | Weight | Line height | Letter and word spacing |
| --- | --- | --- | --- | --- |
| Paragraphs, lists, tables, blockquotes, alerts | yes | yes | yes | yes |
| Headings | yes | no (stay bold) | no (keep 1.2 to 1.25) | yes |
| Bold text | yes | no (stays 700) | inherits | yes |
| Inline code, code blocks, Mermaid source, HTML comment markers | no (monospace) | no | no | no |
| Math (KaTeX) | no (KaTeX fonts) | no | no | no |
| Mermaid diagrams | no (VS Code font, see section 8) | no | no | no |
| Toolbar, dialogs, menus | no | no | no | no |

**Fallback chain for the family:** the reader's list, then `var(--vscode-font-family)`. A font that is not installed falls back to today's font, never to the browser's default serif.

**In scope:**

- The six settings above, live update, safe application, tests, docs.
- Export behavior decided and documented (not honored, see section 8).

**Out of scope:**

- A second size setting. `markdownForHumans.zoom` already scales body text and headings from 50 to 200 percent, which covers the need in #86 and #27.
- Separate heading or code font settings (#86 mentions "the different styles in use"). Code already follows `editor.fontFamily`.
- Word wrap width from #15 (line length is layout, not font).
- Honoring the settings in PDF and Word export.
- Bundled fonts and web fonts.

---

## 4. UX & Behavior

**Entry points:**

- VS Code Settings, search `markdownForHumans.font`; or the gear in the editor toolbar.

**User flows:**

### Flow 1: A reader sets a readability font

1. The reader installs a font on their machine (for example Atkinson Hyperlegible or Lexend).
2. They set `markdownForHumans.font.family` to `Atkinson Hyperlegible`.
3. Every open rich editor switches body text and headings to that font at once.
4. Code stays monospace. If the font is missing, text stays in today's font.

### Flow 2: A reader loosens spacing

1. They set `font.lineHeight` to `1.8`, `font.letterSpacing` to `0.05`, `font.wordSpacing` to `0.16`.
2. Prose reflows live. Code, math and diagrams keep their own metrics.

### Flow 3: A user wants their VS Code editor font (#15)

1. They turn on `markdownForHumans.font.useEditorFont`.
2. Body text takes `editor.fontFamily`, `editor.fontWeight` and `editor.fontSize`, including values inside `"[markdown]"`.
3. `font.family` and `font.weight`, when changed from their defaults, still win.

**Behavior rules:**

- A setting at its default posts `null`; the webview removes the custom property, so the stylesheet fallback applies.
- Out-of-range numbers are clamped. Non-numbers and non-strings are ignored (treated as the default).
- The font family is parsed into family names and written back as quoted CSS strings plus generic keywords. Nothing else from the value reaches CSS.
- `strong` stays 700. With a body weight above 700 bold text is no heavier than body text; this is the reader's choice and is noted in the description.

---

## 5. Technical Plan

**Surfaces:**

- Extension host (read and resolve settings), shared module (validation), webview (apply), stylesheet (fallbacks).

**Key changes:**

- `src/shared/typographySettings.ts` (new): `TypographySettings` type, `normalizeFontFamily`, `normalizeTypographySettings` (boundary validator used on both sides), `resolveTypographySettings` (host: defaults to `null`, editor font precedence).
- `src/webview/utils/typographyStyles.ts` (new): `applyTypographySettings(target, value)` sets or removes the custom properties with `style.setProperty` and `style.removeProperty`.
- `src/webview/editor.ts`: `applyEditorSettings` calls `applyTypographySettings` when a message carries `typography`; zoom multiplies the same base size the stylesheet uses.
- `src/webview/editor.css`: root rule uses the custom properties with today's values as fallbacks; `p`, `li`, `blockquote`, `.github-alert` use `var(--md-line-height, 1.58)`; code and math opt out of letter and word spacing; bare `pre` and comment markers keep the standard weight; `.mermaid-render` is pinned to VS Code's font and weight.
- `src/editor/MarkdownEditorProvider.ts`: `getTypographySettings()`; `typography` added to the `update` payload and both `settingsUpdate` payloads; the configuration listener also watches `markdownForHumans.font` and the three `editor.font*` keys scoped to Markdown.
- `package.json`: six settings.
- `test/integration/typographySettings.extHost.test.cjs` (new) and `test/integration/workspace/.vscode/settings.json` (new fixture): contributed defaults and `"[markdown]"` visibility in a real Extension Host.
- Docs: `CHANGELOG.md`, `README.md`, `vibe-coding-rules/styling.md`.

**Architecture notes:**

- One message field, `typography`, carries six nullable values. A message without the field changes nothing, so partial `settingsUpdate` messages stay valid.
- Validation runs twice: the host resolves and normalizes, and the webview normalizes again before touching the DOM. The webview never trusts the message.
- The value is never concatenated into a stylesheet or HTML. It is set as one custom property value. The existing CSP (`default-src 'none'`, `font-src` limited to the extension) is unchanged, so no font can be fetched.
- Code and math opt out through `var(--md-code-text-spacing, inherit)`. At defaults the variable is unset and they inherit exactly as today; when the reader sets letter or word spacing the webview sets it to `normal`.
- The editor font size from the opt-in is `--md-editor-font-size`; `--md-base-size` and zoom read it before `--vscode-editor-font-size`.

**Performance considerations:**

- Seven `setProperty` or `removeProperty` calls per settings message. No per-keystroke work, no layout reads, no new listeners in the webview.
- A font change causes one reflow, the same as a zoom change.

---

## 6. Work Breakdown

- [x] **Phase 1: Understand** - issues, current pipeline, VS Code webview facts, WCAG 1.4.12
- [x] **Phase 2: Plan** - this file
- [x] **Phase 3: Failing tests**
  - [x] `src/__tests__/shared/typographySettings.test.ts`
  - [x] `src/__tests__/webview/typographyStyles.test.ts`
  - [x] `src/__tests__/webview/typographySettingsWiring.test.ts`
  - [x] `src/__tests__/editor/typographySettingsProvider.test.ts`
  - [x] `src/__tests__/features/typographySettingsManifest.test.ts`
  - [x] `test/integration/typographySettings.extHost.test.cjs`
- [x] **Phase 4: Implementation** - shared module, webview util, CSS, provider, manifest
- [x] **Phase 5: Docs** - changelog, README, styling guide, JSDoc
- [x] **Testing**
  - [x] `npm run lint`, `npx jest`, `npm run test:integration`
  - [x] Performance budget gates (`scripts/feedback-performance-fixture`)
  - [ ] Native VS Code pass in light and dark themes (lead session; not done here)

---

## 7. Implementation Log

### 2026-10-11 - Research and plan

- **What:** Read issues 86, 15 and 27, the settings pipeline, the VS Code webview theming source, the API typings and WCAG 1.4.12.
- **Notes:** The body font is inherited from VS Code's default webview stylesheet, not set by `editor.css`. `"[markdown]"` overrides never reach webview CSS variables; only the host can read them.

### 2026-10-11 - Tests first, then implementation

- **What:** Wrote the five Jest files (102 tests), confirmed red (three could not compile, two failed on assertions), then implemented until green.
- **Files:** see section 5. Two exact-payload assertions in `undoSync.test.ts` gained the new `typography` field, all `null` at defaults.
- **Results:** `npm run lint` clean. `npx jest`: 216 suites passed, 1 skipped; 4488 tests passed, 27 skipped, 121 todo. Performance gates: `verification.test.mjs` 7 of 7, `run.mjs` `"passed": true`. `npm run test:integration`: 10 passing on VS Code 1.141.0 (stable). On 1.98.0 the two new tests pass in every run; the suite as a whole is subject to the existing flake described below.

### 2026-10-11 - Supplementary Chromium check (not a VS Code pass)

- **What:** Loaded the stylesheet from `origin/main` and the new one in headless Chrome 155 with VS Code's default webview body rule and `--vscode-*` variables simulated, and compared computed `font-family`, `font-weight`, `font-size`, `line-height`, `letter-spacing` and `word-spacing` on 17 elements (headings, paragraph, bold, inline code, list, quote, alert, table cells, code block, comment marker, Mermaid).
- **Results:** No difference at the defaults. With settings applied, prose changed and code, comment markers and Mermaid kept their own font, weight and spacing. A missing font fell back to the standard font. A hostile family value stayed one quoted name: `body` stayed visible, no node or stylesheet was added.
- **Notes:** The check found that a bare `pre` (Mermaid source) and comment markers followed the body weight; fixed with an explicit weight rule and a test. jsdom cannot evaluate `var()` fallbacks, so the Jest CSS tests assert the declarations and this run confirmed the computed result.

### 2026-10-11 - Extension Host evidence and a flake that is not from this change

- **What:** A first version of the host test wrote a `"[markdown]"` override with `WorkspaceConfiguration.update` and restored it. On VS Code 1.141.0 and 1.98.0 the scoped read returned the override, the unscoped read did not, and `affectsConfiguration('editor.fontFamily', { languageId: 'markdown' })` was true for the change. The committed test reads the same override from a static fixture workspace setting instead, so the suite stays read-only.
- **Existing flake, measured:** On VS Code 1.98.0 on this machine (macOS, Apple silicon) the existing test `SVG image integrity > preserves SVG files and sized image source through splits, reopen, and live Feedback` fails intermittently with `Feedback command must reach the ready, active SVG editor` after a 10 second wait. Interleaved runs on 2026-10-11: an untouched copy of `origin/main` (adcd006) failed 6 of 10; this branch failed 2 of 10. It is the first webview the suite opens on `origin/main`. No failure was seen on 1.141.0 (7 of 7 runs green on this branch).
- **Correction:** An earlier reading of five green baseline runs blamed the runtime settings write. The 20 run comparison does not support that; the flake exists without this change.
### 2026-10-11 - Brought up to date with main (0.4.4)

- **What:** `origin/main` gained PRs 149, 150 and 151 (release 0.4.4) during this work. Merged it into the branch. The merge was clean, but it placed the changelog entry inside the released `[0.4.4]` section; moved it to `[Unreleased]`.
- **Results on the merged tree:** `npm run lint` clean. `npx jest`: 219 suites passed, 1 skipped; 4509 tests passed, 27 skipped, 121 todo. Performance gates 7 of 7 and `"passed": true`. `npm run test:integration`: 10 passing on VS Code 1.141.0.
- **Notes:** This feature is not part of 0.4.4. It needs its own version bump when released.
### 2026-10-11 - Second merge of main (PRs 152 and 153)

- **What:** Merged `origin/main` 1054729. It brings the Extension Host warm-up that fixes the 1.98.0 flake described above (PR 152) and a clearer "Feedback is not ready" warning (PR 153). One conflict, in `CHANGELOG.md` under `[Unreleased]`; kept both entries.
- **Results on the merged tree:** `npm run lint` clean. `npx jest`: 219 suites passed, 1 skipped; 4509 tests passed, 27 skipped, 121 todo. Performance gates 7 of 7 and `"passed": true`. `npm run test:integration`: 10 passing on VS Code 1.141.0; 10 of 10 runs green on 1.98.0.

---

## 8. Decisions & Tradeoffs

- **Defaults post `null`, not today's numbers.** The stylesheet fallback is the single place that holds today's values, so "nothing changes" is provable by reading one rule.
- **Font family is re-serialized, not filtered.** Each family becomes a quoted CSS string with `"` and `\` escaped; generic keywords such as `sans-serif` pass through. A blocklist of characters would be easier to get wrong, and jsdom does not validate custom property values, so tests could not rely on the browser rejecting bad input.
- **Word spacing is included.** WCAG 1.4.12 lists it with line height, paragraph spacing and letter spacing, and its benefits section names readers with dyslexia. Dyslexia style guidance (British Dyslexia Association 2018, as quoted by secondary sources; Dyslexia Scotland) says word spacing should grow with letter spacing, about 3 to 3.5 times. Letter spacing without word spacing blurs word boundaries.
- **No second size setting.** Zoom scales paragraphs and headings together and already ranges 50 to 200 percent.
- **Headings follow the family but keep their weight and line height.** Headings are short and mostly one line; a body line height of 2 on a 2.4x heading leaves large gaps.
- **Code, math and diagrams are excluded.** Word spacing breaks column alignment in code, and letter spacing breaks KaTeX layout. Mermaid renders with `fontFamily: 'inherit'` and measures its label boxes before the SVG enters the editor, so a different body font or weight would clip labels; diagrams stay on VS Code's font.
- **In-editor controls inherit the reader's font.** Small widgets inside the document area (alert labels, image hover details) already inherit the editor's spacing today and now follow the body font too. The toolbar, menus and dialogs live outside the document and do not change.
- **`"[markdown]"` editor font is an explicit opt-in (`font.useEditorFont`, default off).** Applying it silently would change the look for every user whose `editor.fontFamily` is a monospace font, which is the VS Code default. Rejected alternatives: a magic value inside `font.family` (hard to discover) and silent inheritance (breaks "nothing changes").
- **Exports do not honor the settings.** PDF and Word already have their own print typography and ignore zoom and paragraph spacing. An export is usually read by someone else, on a machine that may not have the reader's font. The setting descriptions and README say so.
- **`application` scope.** Same as `zoom` and paragraph spacing: a reading preference belongs to the person, and a repository's `.vscode/settings.json` cannot change it.
- **Tradeoff, precedence under the opt-in:** `font.weight` at exactly 400 means "not set", so with the opt-in on and `editor.fontWeight` at 500 a reader cannot force 400 through `font.weight`. They can turn the opt-in off or change `editor.fontWeight`.

---

## 9. Follow-up & Future Work

- Export option to use the reading font in PDF and Word, if readers ask for it.
- Line length (measure) setting, which answers the word wrap width part of #15 and WCAG 1.4.8.
- Separate heading font family, if #86's reporter asks for per-style control.
- Reply on #86 and #15 once released (drafts only; owner posts).
