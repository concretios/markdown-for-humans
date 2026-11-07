# Task: Localization (translation) support

## 1. Task Metadata

- **Task name:** Localization (translation) support
- **Slug:** localization
- **Status:** shipped in 0.4.4 (2026-10-12); the follow-ups in section 9 were the release and the issue replies
- **Created:** 2026-10-11
- **Last updated:** 2026-10-11
- **Shipped:** 2026-10-12 (0.4.4)
- **Issues:** [#55](https://github.com/concretios/markdown-for-humans/issues/55) (Chinese Simplified, suggests `vscode-nls`, offers to review), [#77](https://github.com/concretios/markdown-for-humans/issues/77) (translate the extension, "including icons with a letter such as B for bold")

**Recommendation in one paragraph.** Do the invisible groundwork now (Phase 0, 1.5 working days, English only), not the full conversion. Full translation is about 16.5 working days for one locale; the smallest translated release that reads as finished is about 12. Demand today is two issues, both self-rated "Low - Nice to have", with no comments. Phase 0 stops the string debt from growing while three feature branches add more text, and costs nothing visible. Schedule the area conversions as small pull requests between features, and switch a language on only when the gate in section 6 passes.

---

## 2. Context & Problem

**Current state (measured at `a6b5579`, origin/main, 2026-10-11):**

- Every user-facing string is hardcoded English. No `package.nls.json`, no `l10n` folder, no `vscode.l10n` call.
- `engines.vscode` is `^1.98.0`. Everything needed exists at that floor (section 5.1).
- 134 source files, 74,835 lines. 11,818 string literals contain letters. About 925 of them are user-facing text.

**Pain points:**

- **No way to contribute a translation:** issue #55 offers Chinese text and review, and there is nowhere to put it.
- **Letter icons:** issue #77 points at the bold button. Its glyph is a drawn Latin "B" from the Codicon font, so it cannot be translated as a string (section 5.4, item 5).
- **Debt grows daily:** 87 of the last 306 commits (90 days) touched the files that hold UI text.

**Why it matters:**

- **Reach:** VS Code ships 14 non-English display languages. Simplified Chinese is the largest; its language pack has 3.65 million downloads on Open VSX alone [S15].
- **Cost of waiting:** each new feature adds strings that must later be converted one by one.
- **Platform standard:** VS Code has had a built-in translation API since 1.73 [S1][S5]. `vscode-nls`, which #55 suggests, still works but receives no new features [S8].

### Measured counts

How it was counted: a TypeScript AST walk over `src/` (tests and mocks excluded) classified every string literal by where it flows (notification call, DOM text or attribute assignment, UI helper argument, `throw`, `console.*`, comparison, selector). Text inside HTML templates was split into visible text nodes and `title`, `aria-label`, `placeholder`, `alt` attributes. I read every row of the host group (131 rows, 1 false positive, 8 missed in `wordCount.ts`) and about 600 webview rows. Treat the totals as accurate to about plus or minus 5 percent. Scripts: `l10n-scoping/` in the shared session notes folder.

| Group                                   | Strings | Notes                                                                 |
| --------------------------------------- | ------: | --------------------------------------------------------------------- |
| Manifest (`package.json`)               |      41 | 39 translatable; `displayName` and `description` stay literal         |
| Extension host UI                       |    ~140 | notifications, dialogs, quick picks, progress, status bar             |
| Webview UI                              |     754 | 668 distinct texts; 77 texts appear more than once                    |
| **Translatable total**                  | **~925** |                                                                       |
| Diagnostic error text (host + webview)  |     206 | `throw new Error(...)` detail; recommended to stay English            |
| Never translate: report and validators  |     749 | sealed Feedback bundle, agent handoff prompt, bundle validators       |
| Never translate: log lines              |     314 | 277 literals carry the `[MD4H]` prefix                                |
| Never translate: keys and technical     |  ~9,800 | command IDs, selectors, class names, protocol values, Markdown syntax |

Manifest breakdown: 16 command titles, 10 setting descriptions, 2 setting Markdown descriptions, 8 color descriptions, 1 configuration title, 1 custom editor name, 1 view name, 2 listing fields.

Webview by area:

| Area                         | Strings | Largest files                                                                                   |
| ---------------------------- | ------: | ----------------------------------------------------------------------------------------------- |
| Feedback review              |     323 | `feedbackReview.ts` 162, `feedbackCapture.ts` 46, `feedbackTargetPresentation.ts` 46            |
| Toolbar and menus            |     124 | `BubbleMenuView.ts` 109, `mermaidTemplates.ts` 15                                               |
| Image dialogs                |     120 | `imageResizeModal.ts` 24, `imageRenameDialog.ts` 22, `imageInsertDialog.ts` 16                  |
| Dialogs and overlays         |     118 | `linkDialog.ts` 39, `mathEditor.ts` 33, `searchOverlay.ts` 11, `tocOverlay.ts` 9                |
| Audit                        |      38 | `auditOverlay.ts` 27, `auditDocument.ts` 11                                                     |
| Editor core and node views   |      31 | `editor.ts` 14, `codeBlockCopyNodeView.ts` 7                                                    |

Host by file: `MarkdownEditorProvider.ts` 83 (about 33 belong to Feedback), `documentExport.ts` 38, `wordCount.ts` 12, `outlineView.ts` 2, `feedbackCommandReadiness.ts` 2, `extension.ts` 1, `documentEditCoordinator.ts` 1.

Never translate, and why:

- **Log lines** with `[MD4H]`: support and bug reports depend on searchable English.
- **Command IDs, setting keys, protocol values, selectors, Markdown and Mermaid syntax, LaTeX templates.**
- **Feedback bundle and agent handoff** (`feedbackReportV2.ts`, `feedbackHandoffPrompt.ts`, `feedbackItemSummaryV2.ts`, `feedbackSessionStore.ts` and 7 more files): the text is a file format read by AI agents and by the bundle validators.
- **Diagnostic detail** inside wrappers such as `Failed to save image: {0}`: translate the wrapper, keep the inner error English.

---

## 3. Desired Outcome & Scope

**Success criteria:**

- A user whose VS Code display language has a complete bundle sees the manifest, notifications and editor UI in that language.
- A string or language without a translation shows English. Nothing is ever blank or shows a key.
- No release ships a language that covers only part of the product (gate in section 6).
- Editor start stays under 500 ms and typing under 16 ms. Measured cost of the mechanism: 0.3 ms host render plus 0.3 ms webview parse for a 900-string bundle; 0.2 microseconds per lookup.
- No new runtime dependency.
- CI fails on stale, broken or unextractable translations.

**In scope:**

- Manifest strings except `displayName` and `description`.
- Host notifications, dialogs, quick picks, progress and status bar text.
- Webview toolbar, menus, dialogs, overlays, placeholders, tooltips, `aria-label` text, live-region announcements.
- A contributor path for community translators.

**Out of scope:**

- `displayName`, `description`, `keywords`, README, CHANGELOG, Marketplace listing.
- Log lines, error detail, the Feedback bundle and handoff prompt.
- Right-to-left layout (section 5.4, item 8).
- A language switch inside the extension. The VS Code display language decides.
- Machine translation at runtime, any network call, any hosted translation service.

---

## 4. UX & Behavior

**Entry points:**

- None new. The user picks a language with VS Code's "Configure Display Language", which needs that language's Language Pack [S10].

**User flows:**

### Flow 1: User with a translated display language

1. VS Code starts with display language `zh-cn`.
2. VS Code loads `package.nls.zh-cn.json` for the manifest and `l10n/bundle.l10n.zh-cn.json` for code.
3. The host renders the loaded bundle into the webview HTML.
4. Toolbar, dialogs and notifications appear in Chinese.

### Flow 2: User with a language that has no bundle, or English

1. VS Code finds no bundle; `vscode.l10n.bundle` is `undefined` [S4].
2. The host adds nothing to the HTML.
3. Everything appears in English, exactly as today.

### Flow 3: Community translator

1. Copies `l10n/bundle.l10n.json` to `bundle.l10n.<locale>.json` and translates the values.
2. Opens a pull request that touches only translation files.
3. CI checks keys, placeholders and markup. A second native speaker or a back-translation review approves (section 5.6).

**Behavior rules:**

- Lookup is by the display language VS Code resolved (`zh-cn`, `pt-br`, `de`). VS Code maps a regional locale to an installed Language Pack by dropping the region, then loads exactly `bundle.l10n.<that id>.json`; there is no further fallback between bundles [S9].
- A changed English sentence loses its translation until re-translated, and shows English meanwhile.
- Keyboard shortcut names (`Ctrl`, `Shift`, `Enter`, `Escape`) stay as printed on the key.
- Product and format names stay untranslated: Mermaid, Markdown, LaTeX, KaTeX, PDF, Word, Chrome, language names in the code block menu.

---

## 5. Technical Plan

### 5.1 How VS Code localizes extensions (verified)

| Mechanism                          | What it covers                         | Minimum VS Code                     | This extension (`^1.98.0`)        |
| ---------------------------------- | -------------------------------------- | ----------------------------------- | --------------------------------- |
| `package.nls.json` + `%key%`       | Manifest strings                       | Older than 1.73; docs state no version [S1] | Available                 |
| `package.nls.<locale>.json`        | Manifest translations, English fallback per key | Same                       | Available                         |
| `vscode.l10n.t`, `.bundle`, `.uri` | Host code strings                      | 1.73 [S1][S5]                       | Available; confirmed in the pinned `@types/vscode@1.98.0` |
| `"l10n": "./l10n"` manifest field  | Tells VS Code where bundles live; required [S6] | 1.73                       | Not set today                     |
| `l10n/bundle.l10n.<locale>.json`   | Translations keyed by English text     | 1.73                                | None today                        |
| `@vscode/l10n-dev` 0.0.35 (dev tool) | Extract strings, XLIFF, pseudo-locale | Any; runs at build time [S3]        | Not used; see 5.3                 |
| `@vscode/l10n` 0.0.18 (runtime lib) | Same `t()` for subprocesses           | Any [S2]                            | Not used; see 5.3                 |

Facts that shape the design:

- `vscode.l10n.bundle` and `.uri` are `undefined` when no bundle was found or the language is the default [S4].
- The bundle file name uses the exact app language; a missing key returns the English message [S9].
- A key with a translator comment is `message/comment` [S9].
- VS Code offers no plural or gender support in this API.
- A non-English display language requires an installed Language Pack [S10].

### 5.2 How strings reach the webview

Microsoft has no supported webview path. The maintainer's words: "there is no recommended way to do this" [S7]. Three options exist:

| Option | Startup | Content Security Policy | Bundle size | Verdict |
| ------ | ------- | ----------------------- | ----------- | ------- |
| A. Host renders `vscode.l10n.bundle` into a `<body>` attribute; webview has its own `t()` | Synchronous, ready before any UI is built; 0.3 ms + 0.3 ms for 900 strings (119 KB of HTML) | Unchanged. No script, no fetch | 563 bytes minified, 376 gzip | **Chosen. Built in the proof of concept** |
| B. Host posts a string map by `postMessage` after `ready` | Arrives after first paint; toolbar would render English, then need a rebuild | Unchanged | Same as A | Rejected: flash of English or delayed first paint |
| C. `@vscode/l10n` in the webview with `config({ uri })` [S2][S7] | One async fetch before UI can render | Uses the existing `connect-src` and extension resource root | 2,969 bytes plus a licence entry | Rejected: new runtime dependency and an awaited fetch for no gain |

Option A copies an existing pattern: the provider already passes `data-highlighting-worker-uri` on `<body>`.

### 5.3 Recommended architecture

```text
package.json  --%key%-->  package.nls.json  +  package.nls.<locale>.json     (VS Code resolves)

Host code     vscode.l10n.t('English {0}', x)        <-- l10n/bundle.l10n.<locale>.json
                    |                                     (VS Code loads the one for the display language)
                    v
              vscode.l10n.bundle  --render-->  <body data-l10n-bundle="...">
                                                         |
Webview code  l10n.t('English {0}', x)  <--- parsed once, on first lookup
              (src/webview/l10n.ts)          missing key or no bundle: English
```

- **One format for both halves.** English text is the key; `{0}`, `{1}` mark arguments. One bundle file per locale serves host and webview.
- **English as key means zero churn in existing tests.** `t('Bold')` returns `'Bold'` with no bundle, so the 424 English assertions keep passing.
- **Own extractor, in Jest.** `src/__tests__/l10n/bundles.test.ts` finds every `l10n.t(...)` call with the TypeScript compiler, which is already a dev dependency.

Alternatives rejected:

| Alternative | Reason |
| ----------- | ------ |
| `vscode-nls` (suggested in #55) | Superseded by `vscode.l10n` in 1.73; no new features [S8]. Its build step rewrites source files. |
| Symbolic keys (`toolbar.bold.label`) | Every test that asserts English text would need a lookup table; code becomes harder to read. Costs the 424 assertions for no user benefit. |
| `@vscode/l10n-dev` as the extractor | Verified on this branch: it only sees `l10n.t` when the module is imported from `vscode` or `@vscode/l10n`. It extracted 0 of 11 calls made through our own webview helper. Using it would force option C. Revisit only if XLIFF or pseudo-locale tooling is wanted. |
| i18next, FormatJS, ICU MessageFormat | A runtime dependency and a licence entry each; bundle cost not measured here. Plurals are the only gain, and 16 call sites do not justify it. |
| Separate bundles for host and webview | Two files per locale for translators; no measurable saving at this size. |
| Placeholders for `displayName` and `description` | See 5.5. No benefit, some risk. |

### 5.4 Hard cases (file and line at `a6b5579`)

1. **HTML templates: 31 templates, 137 text segments.** Text sits inside `innerHTML` strings, so a translation would be parsed as markup.
   - `linkDialog.ts:728` (3), `:739` (23); `imageRenameDialog.ts:91` (14); `imageResizeModal.ts:381` (13); `imageInsertDialog.ts:88` (12); `localImageOutsideRepoDialog.ts:67` (12)
   - `hugeImageDialog.ts:163` (6); `imageConfirmation.ts:66` (6); `imageResizeWarning.ts:55` (5); `mathEditor.ts:127` (4), `:270` (3), `:327`, `:344`
   - `tableInsert.ts:67` (3), `:78` (4); `tocOverlay.ts:42` (3), `:86` (4); `mermaidEditor.ts:71` (3), `:116` (2)
   - `auditOverlay.ts:305` (2), `:718`, `:782`, `:794`, `:800`, `:950`; `imageMenu.ts:67` (2); `imageMetadata.ts:258`, `:301`; `editor.ts:1449` (2); `mathBlock.ts:148`; `mermaid.ts:211`
   - Fix: escape every translated value before it enters a template, and reject `<` or `>` in translations in CI.
2. **Plurals and grammar agreement: 16 sites.**
   - `feedbackReview.ts:1546`, `:1551`, `:1553`, `:1565`, `:2191`, `:3177`, `:3257`, `:3262`, `:4688`
   - `imageRenameDialog.ts:510`, `imageResizeModal.ts:840` (a lone `s` suffix); `imageConfirmation.ts:68`; `imageInsertDialog.ts:241`; `auditOverlay.ts:962`; `feedbackTargetPresentation.ts:158`; `MarkdownEditorProvider.ts:5659`
   - Fix: one whole sentence per form, picked with `Intl.PluralRules`, or count-neutral wording ("Comments: {0}"). Russian and Polish need more than two forms; accept two forms at first.
3. **Sentences built from parts: 22 concatenations and 120 template literals with variables.**
   - Concatenation: `BubbleMenuView.ts:791`, `:793`, `:812`, `:814`; `feedbackReview.ts:1551`, `:1553`, `:2192`; `feedbackTargetPresentation.ts:408`, `:464`; `imageMenu.ts:57`; `MarkdownEditorProvider.ts:5515`
   - Template literals: `MarkdownEditorProvider.ts` 30, `feedbackReview.ts` 24, `BubbleMenuView.ts` 8, `auditDocument.ts` 8, `documentExport.ts` 7, `feedbackTargetPresentation.ts` 6
   - Fix: convert to a literal with `{0}` arguments. The CI guard already fails on a non-literal message.
4. **Text used as a lookup key.**
   - Host button labels compared after the dialog returns, 15 sites: `documentExport.ts:1231`, `:1233`, `:1248`, `:1252`, `:1313`, `:1317`, `:1324`, `:1327`; `MarkdownEditorProvider.ts:5668`, `:7663`, `:7721`, `:8984`, `:11233`, `:11256`, `:11277`. Fix: keep the translated label in a constant and compare against it.
   - Tests that select by English `aria-label` or `title`: 14 selectors in 6 files. They keep working in English.
   - Production code never selects by `aria-label` or `title`.
5. **Icons that are letters (issue #77).**
   - Toolbar icons are Codicon font glyphs chosen by name (`BubbleMenuView.ts:342`, `:352`, `:362`). The `bold` glyph is itself a drawn "B".
   - Text fallbacks (`B`, `I`, `S`, `H+`, `Tbl`, `Mer`, `TOC`) show only when the font fails to load (`editor.css:3648`, `content: attr(data-fallback)`).
   - `H1`, `H2`, `H3` have no glyph and always render as text (`BubbleMenuView.ts:382`, `:391`, `:400`).
   - Fix: a translatable glyph letter with a translator comment; when a locale supplies a different letter, render text instead of the glyph. About half a day, in Phase 3a.
6. **Text in CSS: 2 strings.** `editor.css:1272` (`'Start writing...'`), `:1290` (`'Drop image here'`). Fix: `content: attr(...)` or a CSS variable set from script.
7. **Dates and numbers.**
   - `imageMetadata.ts:147`, `:150`, `:154` hardcode `'en-US'`, "Yesterday" and "{n} days ago". Fix: `Intl.RelativeTimeFormat` and `Intl.DateTimeFormat` with the display language.
   - `wordCount.ts:73-76`, `:156`, `:181`, `:199-202` already use `toLocaleString()`.
   - File sizes use `toFixed(1)` with English units: `hugeImageDialog.ts:83-84`, `imageMetadata.ts:129-131`, `imageInsertDialog.ts:247`.
   - `'en-US'` in the Feedback report files is correct and must stay.
8. **Right to left.** `editor.css` has 130 physical left or right declarations and 0 logical ones; no `dir` handling anywhere; the HTML shell hardcodes `lang="en"` (`MarkdownEditorProvider.ts:11628`). None of VS Code's 14 non-English display languages is right to left [S10], so this is out of scope. Set `lang` from `vscode.env.language` in Phase 0.
9. **Short words that mean different things.** 75 single-word labels; "Cancel" appears 12 times, "Retry" 6, and "Quote", "Source", "Table", "Open" can be noun or verb. Fix: translator comments, which make a distinct key (`message/comment`), matching VS Code [S9].
10. **Feedback boundary.** 323 webview strings sit next to 749 report strings that must stay English. Not verified: whether any webview label (for example "Whole table" in `feedbackTargetPresentation.ts`) is also written into the sealed bundle. Check before Phase 3e.

### 5.5 Marketplace, Open VSX and other hosts

- **`vsce` replaces `%key%` with the English value from `package.nls.json` when it packages.** Read in `node_modules/@vscode/vsce/out/nls.js` and `package.js` (`readManifest`, version 4.0.0). The Marketplace therefore receives the same literal English `DisplayName` and `Description` either way.
- **The Marketplace does not use `package.nls.<locale>.json` for listing text.** The request to honor it has been open since 2022-09-28 [S11]; a 2025 report confirms listings stay English [S12].
- **Search weights the display name most, then the short description; keywords become tags** [S13][S14]. These are maintainer comments in issues, not documentation.
- **Not answered by any documentation:** whether a placeholder `displayName` changes ranking. The packaging code says the indexed text is identical, but a known bug turns the comment form of an `nls` value into `[object Object]` in the listing [S16].
- **Decision: keep `displayName` and `description` literal.** Translating them gains nothing, and the policy test and the recent rename depend on the literals.
- **Open VSX:** `ovsx` packages with `vsce` [S17], and the registry treats `extension.vsixmanifest` as the source of truth [S18], so it sees the same resolved English text.
- **VSCodium and Cursor:** the official Simplified Chinese Language Pack is on Open VSX (namespace `MS-CEINTL`, published by the Open VSX account, version 1.131.0) [S15]. Extension bundles load through the same `vscode.l10n` code path in any Code OSS build [S9]. **Cursor 3.24.12 (Code OSS 1.128.0) is verified on this branch**: its marketplace installed the pack and the proof of concept rendered in Chinese (section 7). VSCodium and Windsurf are not tested.

### 5.6 Translator workflow and review

- **Contribute:** copy `l10n/bundle.l10n.json` and `package.nls.json`, translate values, open a pull request. `l10n/README.md` holds the four rules.
- **Safe to merge without reading the language:** CI proves the pull request cannot break the product. It checks keys, placeholders, non-empty values and no markup. A translation-only pull request changes no code.
- **Meaning review when no maintainer reads the language:**
  1. A second native speaker approves (the author of #55 offered for Chinese), or
  2. a maintainer reviews a machine back-translation of the diff to catch wrong, offensive or promotional text.
- **Ownership:** each locale lists its maintainer and the last version reviewed in `l10n/README.md`. A locale more than two releases behind, or below the coverage gate, is removed from the package, not shipped half-done.
- **Glossary:** a short term list per locale (Feedback, Audit, Outline, Source view) to keep wording consistent.

### 5.7 CI detection of missing and stale translations

Already implemented in `src/__tests__/l10n/bundles.test.ts` (runs with `npx jest`):

| Check | Result |
| ----- | ------ |
| `l10n.t(...)` message is not a string literal | Fail, with `file:line` |
| `bundle.l10n.json` differs from the messages in code | Fail (stale English bundle) |
| Locale bundle has a key the code no longer uses | Fail (stale translation) |
| Translation drops or adds a `{n}` placeholder | Fail |
| Empty translation | Fail |
| Missing translation | Listed; the sample asserts its one known gap |

To add in Phase 0 and Phase 1:

- Fail when a translation contains `<` or `>` that the English source does not.
- `npm run l10n:extract` to regenerate `bundle.l10n.json` (reuse the extractor in the test).
- A locale status list (`complete` or `draft`); only `complete` locales are packaged, and for them a missing translation fails.
- Manifest parity: every `%key%` exists in `package.nls.json`; no orphan keys in any `package.nls.<locale>.json`.
- A pseudo-locale bundle generated in tests to prove no converted surface still shows raw English.

### 5.8 What breaks in the test suite

| Item | Count | Effect |
| ---- | ----: | ------ |
| Test files | 217 | |
| Files that reference English UI text | 76 (35%) | None while the test runs in English |
| Exact English UI literals in assertions | 424 | None, because English is the key |
| Selectors by English `aria-label` or `title` | 14 in 6 files | None in English |
| Partial or template matches | 58 in 21 files | None in English |
| Files with a hand-written `jest.mock('vscode')` | 5 | Each needs an `l10n` entry once the code under test calls `vscode.l10n`. One already hit and fixed: `inMemoryFiles.test.ts` |
| `marketplaceListingPolicy.test.ts` | 2 of 8 tests | 4 literal assertions break when the open command title, the configuration title, the custom editor name and the view name become `%key%`. Fix: resolve through `package.nls.json` in the test, and extend the old-product-name scan to `package.nls*.json`. The `displayName` and `description` tests stay as they are |

Most hit files: `feedbackReview.test.ts` 85, `feedbackProvider.test.ts` 43, `feedbackTargetPresentation.test.ts` 24, `documentExport.test.ts` 23, `feedbackCapture.test.ts` 23.

Real test work comes from restructuring, not from wrapping: label-as-key sites, plural rewrites and HTML template splits change behavior and need new tests.

### 5.9 Surfaces and key changes

- `src/shared/l10n.ts` (done): format, bundle parsing, `<body>` attribute rendering.
- `src/webview/l10n.ts` (done): `t()`, `configureL10n()`, `resetL10n()`.
- `src/editor/MarkdownEditorProvider.ts` (done): one import, one attribute in `getHtmlForWebview`.
- `src/__mocks__/vscode.ts` (done): `l10n` mock that behaves like English.
- `l10n/` (done as sample): English bundle, sample `zh-cn` bundle, translator rules.
- `package.json` (Phase 0 and 1): `"l10n": "./l10n"`, then `%key%` values.
- `package.nls.json` (Phase 1).

**Performance:** bundle parse is lazy and happens once per webview. No work on the typing path. The release `webview.js` is 4,710,330 bytes; the helper adds 563. About 10 bytes per converted call site adds roughly 8 KB for all 754.

---

## 6. Work Breakdown

**The rule that prevents a half-translated release:** wrapping a string in `l10n.t(...)` changes nothing a user sees. Only shipping a locale file does. So conversion can land in any order, and a locale is packaged only when (a) every surface in the release scope is converted and (b) that locale covers 100 percent of the English bundle and `package.nls.json`.

Estimates are working days for one developer working the way this repository does (test first, real VS Code host check per phase). They assume the three in-flight branches have merged, conversion pull requests are reviewed within a day, and no visual redesign for longer text.

| Phase | Content | Strings | Days | User-visible change |
| ----- | ------- | ------: | ---: | ------------------- |
| 0. Infrastructure, English only | Merge the helper and guard; `"l10n"` field; `lang` attribute; translator comments in `t()`; markup check; extract script; locale status list; contributor doc; host check on 1.98.0 and stable | 12 | 1.5 | None |
| 1. Manifest | 39 strings to `package.nls.json`; policy test resolves keys; parity check | 39 | 0.5 | None |
| 2. Host messages | 7 files; 15 label-as-key sites; 5 custom mocks | ~140 | 2.0 | None |
| 3a. Toolbar and menus | `BubbleMenuView.ts`, Mermaid template names, shortcut tooltips, letter glyphs (#77) | 124 | 1.5 | None |
| 3b. Dialogs and overlays | link, table, outline, math, Mermaid editors; 2 CSS strings | 118 | 2.0 | None |
| 3c. Image dialogs | 9 HTML templates, dates, sizes | 120 | 2.0 | None |
| 3d. Audit, editor core, node views | | 69 | 1.0 | None |
| 3e. Feedback review | 9 plural sites, live announcements, bundle boundary check | 323 | 4.0 | None |
| 4. First language | `zh-cn` with the #55 author; pseudo-locale pass; layout check for long text in real VS Code; switch the locale to `complete` | all | 2.0 | Simplified Chinese |
| **Total** | | **~925** | **16.5** | |

Each further language: 0.5 to 1 day of maintainer time for review and a layout pass, if a community translator supplies the text.

**Smallest useful first release (translated):** everything except Feedback review. Phases 0, 1, 2 (non-Feedback part, about 105 strings), 3a to 3d, and 4: about 575 strings and **12 working days** (1.5 + 0.5 + 1.5 + 6.5 + 2). The Feedback remainder is 4.5 days. Feedback review is a separate mode a user enters on purpose, so it is the one boundary where English next to a translated editor reads as intended, not as unfinished. It needs a release note saying so.

**Smallest release with value and no risk (not translated):** Phase 0 alone, 1.5 days.

- [ ] **Phase 0: Infrastructure, English only**
  - [x] Shared format, webview `t()`, host delivery, guard test (proof of concept)
  - [ ] `"l10n": "./l10n"` in `package.json`; drop or complete the sample bundle first
  - [ ] Translator comment overload; markup check; `l10n:extract` script; locale status list
  - [ ] `lang` attribute from `vscode.env.language`
  - [x] Real host check of the delivery path on 1.98.0, 1.141.0 and Cursor (section 7)
  - [ ] Pseudo-locale bundle for coverage checks
- [ ] **Phase 1: Manifest**
- [ ] **Phase 2: Host messages**
- [ ] **Phase 3: Webview areas**, one pull request per area (3a to 3e)
- [ ] **Phase 4: First language**
- [ ] **Testing**
  - [x] Unit tests for format, parsing, lookup, fallback, placeholder substitution
  - [x] Host-to-webview delivery through the real provider HTML
  - [x] Bundle guard (extraction, stale keys, placeholders)
  - [ ] Pseudo-locale coverage per converted area
  - [x] Real VS Code host, automated: display language `zh-cn` with the Language Pack, strings read back from the live webview
  - [ ] Real VS Code host, visual: light and dark, long-text layout (needs converted surfaces first)

---

## 7. Implementation Log

### 2026-10-11 - Scoping and proof of concept

- **What:** Research, string census, and one end-to-end slice: the search overlay (11 webview strings) and the word count notification (1 host string).
- **Files:** `src/shared/l10n.ts`, `src/webview/l10n.ts`, `src/webview/features/searchOverlay.ts`, `src/features/wordCount.ts`, `src/editor/MarkdownEditorProvider.ts` (2 lines), `src/__mocks__/vscode.ts`, `l10n/*`, 4 new test files, 3 extended test files.
- **Tests:** written first and seen failing. `npm run lint` clean. `npx jest`: 216 suites passed, 1 skipped; 4,445 tests passed.
- **Notes:**
  - The slice is inert in a real install: `package.json` has no `"l10n"` field, so VS Code loads no bundle and the product stays English. This was deliberate; three other branches are editing `package.json`.
  - The `zh-cn` bundle is sample text, not reviewed by a native speaker. It leaves "Close search" untranslated on purpose to prove the fallback.
  - `@vscode/l10n-dev` 0.0.35 was run from a scratch folder, not installed. It found the host call and none of the webview calls.
  - The first version of this plan listed the real-host check as not done. It was done later the same day; see the next entry.

### 2026-10-11 - Real host verification (VS Code 1.141.0, VS Code 1.98.0, Cursor)

- **What:** Ran the proof of concept in real Extension Development Hosts after the owner allowed launching VS Code and Cursor.
- **How:** `@vscode/test-electron` with an isolated profile per host; the official `MS-CEINTL.vscode-language-pack-zh-hans` installed into that profile; `--locale=zh-cn`. Temporary, uncommitted changes: `"l10n": "./l10n"` in `package.json` and a probe that opened the search overlay in the live webview, read its DOM and posted the values to the host. All of it was reverted and the profiles deleted. Harness and patch: `l10n-scoping/real-host-harness/` in the shared session notes.
- **Not computer use:** another session's QA host was running, and computer use sees one VS Code process only. The values below come from the real webview DOM, not from a screenshot.

| Host | `vscode.env.language` | Bundle keys loaded | Host notification | Webview placeholder | Counter | Untranslated string |
| ---- | --------------------- | -----------------: | ----------------- | ------------------- | ------- | ------------------- |
| VS Code 1.141.0, `zh-cn` | `zh-cn` | 11 | 没有打开的 Markdown 文档 | 在文档中查找... | 第 1 项，共 16 项 / 无结果 | Close search (English, as designed) |
| VS Code 1.141.0, no locale | `en` | 0 | No markdown document open | Find in document... | 1 of 16 / No results | n/a |
| VS Code 1.98.0, `zh-cn` | `zh-cn` | 11 | 没有打开的 Markdown 文档 | 在文档中查找... | 第 1 项，共 16 项 / 无结果 | Close search |
| Cursor 3.24.12 (Code OSS 1.128.0), `zh-cn` | `zh-cn` | 11 | 没有打开的 Markdown 文档 | 在文档中查找... | 第 1 项，共 16 项 / 无结果 | Close search |

- **Confirmed:**
  - `vscode.l10n.bundle` and `.uri` are populated from `l10n/bundle.l10n.zh-cn.json` at the 1.98.0 floor and on current stable.
  - The `<body data-l10n-bundle>` attribute reaches the webview (354 characters for the sample) and is parsed under the unchanged Content Security Policy (`default-src 'none'`, nonce-only `script-src`).
  - In English the attribute is absent and every string is the English source.
  - The toolbar still renders its 26 buttons in every run.
- **Learned:**
  - The first launch after installing a Language Pack from the command line comes up in English. VS Code writes `languagepacks.json` during that launch; the second launch is translated. A CI job for this must launch twice or pre-seed that file.
  - Cursor's marketplace served the Microsoft Language Pack (version 1.128.0) and Cursor honored `--locale`.

### 2026-10-11 - Owner decisions: full conversion, five languages

- **Decision:** do the full conversion now (owner, in chat), not only Phase 0.
- **Decision:** ship five languages: Simplified Chinese, Japanese, Spanish, Portuguese (Brazil), Russian.
- **Why these five:** installs of VS Code's official Language Packs, read from the Marketplace and Open VSX public APIs on 2026-10-11. A user needs that pack for any extension translation to show. Counts are cumulative installs, not active users.

| Rank | Language (locale id) | Marketplace installs | Share of all packs | Open VSX downloads |
| ---: | -------------------- | -------------------: | -----------------: | -----------------: |
| 1 | Chinese Simplified (`zh-cn`) | 56.1M | 39.5% | 3.65M |
| 2 | Japanese (`ja`) | 15.7M | 11.0% | 1.49M |
| 3 | Spanish (`es`) | 12.1M | 8.6% | 0.85M |
| 4 | Portuguese Brazil (`pt-br`) | 9.7M | 6.8% | 0.62M |
| 5 | Russian (`ru`) | 9.2M | 6.5% | 0.46M |
| 6 | Korean (`ko`) | 7.2M | 5.0% | 0.60M |
| 7 | French (`fr`) | 6.6M | 4.7% | 0.54M |
| 8 | German (`de`) | 5.8M | 4.1% | 0.52M |

- **Community signal:** of 37 issues, #55 asks for Simplified Chinese, #77 asks for "translation" without naming a language, and #4 contains Chinese sample text. Neither request has a reaction or a comment.
- **Open risk the owner accepted:** only Chinese has a volunteer reviewer. The other four have none yet.

### 2026-10-11 - Phase 0 done, conversion started

- **Phase 0 (commit `ab1c71a`):** `"l10n": "./l10n"` in the manifest; translator comments (`{ message, comment }`); `l10n.html` for templates; extraction of singular and plural choices; `l10n/drafts/` for unfinished languages (not packaged) versus `l10n/` for complete ones; `npm run l10n:extract`; the rule in `AGENTS.md` and `vibe-coding-rules/localization.md`.
- **Ratchet:** `src/__tests__/l10n/hardcodedText.test.ts` counts English text written straight into a UI sink. Start: 529 strings in 45 files. It may only go down, and a new file must have none. It sees direct sinks only, so zero is necessary, not sufficient.
- **Found while converting:** `l10n.t` threw when a module was evaluated without a `document` (the highlighting worker, node-environment tests). It now returns English there; covered by `l10nWithoutDom.test.ts`.
- **Issue #77:** Bold, Italic and Strikethrough keep their icon-font glyph unless a language supplies another letter (`B/Bold button letter` and so on); then the letter renders as text. `H1` to `H3` are translatable text.
- **Order of work:** files that neither `main` nor the open feature branches touch first; `package.json` and `src/feedbackCommandReadiness.ts` after the next sync with `main`.

### 2026-10-11 - Conversion done, five languages drafted and reviewed

- **Conversion (commit `2d4d0ae` and follow-ups):** toolbar, dialogs and overlays, image dialogs, audit, Feedback review and capture, provider notifications, export, outline, word count. 778 messages in `l10n/bundle.l10n.json`. The hardcoded-text ratchet went from 529 to 2; the two left are in `src/feedbackCommandReadiness.ts`, which changed on `main`.
- **How:** six parallel agents on disjoint file sets, each with the rules in `vibe-coding-rules/localization.md`; every result reviewed and the full suite run before commit (4,632 tests pass).
- **Settled the open question from section 5.4, item 10:** no webview label reaches the stored Feedback bundle. The report builds its own English labels. A real-editor test pseudo-translates every message and asserts that nothing translated is posted to the host.
- **Found and fixed on the way:**
  - `l10n.t` threw without a `document` (highlighting worker). It now returns English there.
  - `npm run l10n:extract` never exited (in-process `jest.run()`). It now runs Jest as a child process.
  - Six English messages contained an em dash; reworded before translation, since the English text is the key.
  - The audit title said "1 issues" and the status bar "1 words". Both have singular forms now.
  - The two placeholder texts drawn by CSS (`Start writing...`, `Drop image here`) read their text from custom properties.
  - A language's own letter for Bold, Italic or Strikethrough is drawn in that style.
- **Translations:** one translator agent and one independent reviewer agent per language, both checking against VS Code's own language pack terms. Entries changed by the reviewer: zh-cn 56, ja 49, es 83, pt-br 42, ru 53, of 773. All five reviewers rated their file "fit to show users, with caveats". They remain machine translations and sit in `l10n/drafts/`.
- **Decisions the reviewers made that a native reader should confirm:**
  - zh-cn: agent is 智能体; GitHub alert is 提示块; comments are 评论.
  - ja: Audit is チェック; sealed is 確定 beside ロック for locked.
  - es: the Feedback feature is "revisión", an item is "comentario"; strikethrough letter is T.
  - pt-br: locked is "lacrado"; handoff is "prompt para o agente"; strikethrough letter is T.
  - ru: Feedback is «замечания»; lock is «зафиксировать», which VS Code's Russian pack uses for a Git commit.
- **Still open:**
  - Manifest strings (`package.nls.json`) and the two messages in `src/feedbackCommandReadiness.ts`: both wait for a sync with `main`, which the app blocks until the owner confirms the pinned Git origin.
  - 73 `FeedbackSessionError` messages in the provider reach users through `showErrorMessage` but are written as thrown errors and stay English.
  - The word counter splits on whitespace, so Chinese and Japanese documents show a near-zero word count. Existing behaviour; now more visible.
  - Lists of ids are joined with `', '` in code inside translated sentences.

### 2026-10-11 - Five languages checked in real hosts

- **How:** the same isolated-profile harness as before, with the five draft bundles copied into `l10n/` for the run and removed afterwards. A temporary probe read the live webview DOM. No computer use; nobody looked at the screen. Harness, patch and raw results: `l10n-scoping/real-host-harness/` in the shared session notes.

| Host | Languages run | Display language seen by the extension | Messages loaded | Toolbar labels still English |
| ---- | ------------- | -------------------------------------- | --------------: | ---------------------------- |
| VS Code 1.141.0 | en, zh-cn, ja, es, pt-br, ru | matches each | 0 for en, 778 for the rest | 12 of 76, all programming language names |
| VS Code 1.98.0 | zh-cn, ru | matches each | 778 | same 12 |
| Cursor 3.24.12 (Code OSS 1.128.0) | zh-cn, ja | matches each | 778 | same 12 |

- **Confirmed in every translated run:**
  - Host notification, status bar count, search box, search counter and the two CSS-drawn texts are translated.
  - `<html lang>` carries the display language; in English it stays `en` and no bundle attribute is rendered.
  - The main toolbar has the same height (61 px) and no horizontal overflow in all five languages at the same width as English. Its buttons are icon-only, so label length does not affect it.
  - Letter icons: Spanish shows N, K, T; Portuguese N and T with the italic glyph; Russian Ж and К with the strikethrough glyph; Chinese and Japanese keep all three glyphs.
- **Bundle delivered to the webview:** 38 KB (zh-cn) to 59 KB (es) of HTML attribute per editor open.
- **Not covered by this run:**
  - The Feedback toolbar, whose buttons show text. The Russian reviewer expects it to be about a third wider than English.
  - Dialogs, menus and the Feedback flow were not opened; their text is covered by Jest only.
  - Visual quality in light and dark themes.

---

### 2026-10-11 - Owner decision: ship all five; main merged; narrow toolbar fixed

- **Decision (owner):** ship Simplified Chinese, Japanese, Spanish, Brazilian Portuguese and Russian now, marked as AI translated and open to community review. Issue replies on #55 and #77 go out after the merge.
- **Shipped files:** the five bundles moved from `l10n/drafts/` to `l10n/`, and the five `package.nls.<locale>.json` files to the repo root (`git mv`). `l10n/drafts/` is empty and stays the place for a language in progress.
- **Main merged:** font and readability settings (PR 154) and the new "Feedback is not ready" wording. Six setting descriptions became `%key%` entries, the two warnings in `src/feedbackCommandReadiness.ts` use `vscode.l10n.t`, and the hardcoded-text baseline is now empty. All eight strings are translated in the five languages; typography terms were checked against VS Code's own language packs.
- **Feedback toolbar in a narrow editor:** real screenshots showed the button labels running into each other below about 620 px of editor width in English and below about 735 px in Russian. The buttons no longer shrink; `fitFeedbackToolbarLabels` switches the toolbar to icons when the labels do not fit, whatever the language, and each button keeps its name as tooltip and accessible name. The fixed 520 px rule stays as a fallback.
- **Docs:** README has a Languages section, CHANGELOG lists the languages and the fixes, `l10n/README.md` shows the five as shipped without native review.
- **Marketplace short description and keywords:** unchanged; options are with the owner.

## 8. Decisions & Tradeoffs

- **English text as the key:** chosen over symbolic keys. Gain: no churn in 424 test assertions, readable code, same convention as VS Code. Cost: editing an English sentence orphans its translations until redone, and identical short words need a comment to tell them apart.
- **Own 563-byte helper, no `@vscode/l10n`:** chosen to avoid a runtime dependency and an awaited fetch. Cost: the official extractor cannot see webview calls, so extraction lives in a Jest test. Switching later is an import change, because the call shape is identical.
- **Bundle on a `<body>` attribute:** chosen over `postMessage` for synchronous availability and an unchanged Content Security Policy. Cost: about 119 KB of HTML per editor open for a full 900-string bundle, 0.6 ms total.
- **Empty translation means missing in the webview.** VS Code's host returns an empty translation as written [S9]; the CI guard rejects empty values so the two never differ in practice.
- **`displayName` and `description` stay literal:** no listing or search benefit exists, and a known Marketplace bug can corrupt them.
- **Diagnostics stay English:** 206 error-detail strings and all logs. Users paste them into issues; maintainers must be able to search them.
- **No right-to-left work:** none of VS Code's display languages needs it.

### Risks

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Search ranking drops | Low | High | Do not touch `displayName`, `description`, `keywords`. Policy test keeps pinning them |
| Test churn | Low for wrapping, medium for restructuring | Medium | English as key; convert one area per pull request; 5 custom `vscode` mocks need `l10n` |
| Bundle size and startup | Low | Low | Measured: 563 bytes, 0.6 ms. Re-measure when the bundle is full |
| Merge conflicts with in-flight work | High today | Medium | Start Phase 0 only after copy-ai-reference, font-settings and paste-as-plain-text merge. The proof of concept touches one line of `MarkdownEditorProvider.ts` and none of `package.json`, `extension.ts`, `BubbleMenuView.ts` |
| Ongoing cost for every new string | Certain | Medium | Every UI string change needs `l10n.t`, a bundle regeneration and, per locale, a re-translation. Missing text shows English, so features never wait for translators |
| Translations go stale | High over time | Medium | CI fails on stale keys; a locale that falls behind is unpackaged, not shipped partial |
| Bad or hostile translation merged | Low | Medium | Markup check, back-translation review, second native reviewer |
| Translated text breaks layout | Medium | Medium | Pseudo-locale and real host pass per area; as a rule of thumb German text runs about a third longer than English |
| Markup injection through a translation | Low | High | Escape translated values in the 31 HTML templates; reject `<` and `>` in CI |
| Works in VS Code, not in a fork | Low for Cursor (verified), unknown for VSCodium and Windsurf | Low | Same Code OSS code path; falls back to English if a host differs. Manual check before announcing |

### Could not verify

- Whether a placeholder `displayName` or `description` affects Marketplace ranking. No documentation covers it.
- The minimum VS Code version for `package.nls.json`. The docs give none; it predates 1.73.
- Behavior in VSCodium and Windsurf. Cursor is verified.
- Manifest translation (`package.nls.<locale>.json`) in a real host. No such file exists yet, so only the code path was exercised.
- Visual layout with translated text. The real-host check read strings back from the DOM; nobody looked at the screen.
- Whether any webview Feedback label is also written into the sealed bundle.
- The search weighting claims come from maintainer comments in 2018 and 2022 issues and may have changed.

### Sources

- [S1] microsoft/vscode-l10n README: https://github.com/microsoft/vscode-l10n
- [S2] `@vscode/l10n` README: https://github.com/microsoft/vscode-l10n/blob/main/l10n/README.md
- [S3] `@vscode/l10n-dev` README: https://github.com/microsoft/vscode-l10n/blob/main/l10n-dev/README.md
- [S4] VS Code API reference, `l10n` namespace: https://code.visualstudio.com/api/references/vscode-api#l10n (same text in `node_modules/@types/vscode/index.d.ts`, version 1.98.0, line 17788)
- [S5] VS Code 1.73 release notes, "Localization improvements in the web": https://code.visualstudio.com/updates/v1_73
- [S6] Official l10n sample: https://github.com/microsoft/vscode-extension-samples/tree/main/l10n-sample
- [S7] Webview localization, maintainer answers: https://github.com/microsoft/vscode-extension-samples/issues/877 and https://github.com/microsoft/vscode/issues/206547
- [S8] "Localization as part of the API": https://github.com/microsoft/vscode-discussions/discussions/159
- [S9] VS Code source, `extHostLocalizationService.ts`: https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/common/extHostLocalizationService.ts
- [S10] Display Language docs: https://code.visualstudio.com/docs/configure/locales
- [S11] "Honor package.nls.LOCALE.json files", open: https://github.com/microsoft/vsmarketplace/issues/489
- [S12] "Extension title/descriptions/commands are not translated in marketplace": https://github.com/microsoft/vsmarketplace/issues/1146
- [S13] Marketplace search weighting, maintainer comments: https://github.com/microsoft/vscode/issues/42890
- [S14] Indexed fields and keywords as tags: https://github.com/microsoft/vscode-loc/issues/714
- [S15] Open VSX registry entry: https://open-vsx.org/api/MS-CEINTL/vscode-language-pack-zh-hans
- [S16] `nls` comment form shows `[object Object]`: https://github.com/microsoft/vsmarketplace/issues/488
- [S17] Open VSX publishing wiki: https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions
- [S18] Open VSX manifest validation: https://github.com/eclipse-openvsx/openvsx/pull/1825
- [S19] Community Cursor language pack architecture notes (not official): https://github.com/polang233/cursor-language-pack/blob/main/docs/architecture.md
- Extension Manifest reference: https://code.visualstudio.com/api/references/extension-manifest
- Local source read: `node_modules/@vscode/vsce/out/nls.js`, `out/package.js` (version 4.0.0)

---

## 9. Follow-up & Future Work

### TODO before this task is closed (merged in PR 155 on 2026-10-11, not released yet)

Do these from `main`, in this order.

- [ ] **Release.** Bump the version (owner picks 0.4.5 or 0.5.0; 0.5.0 suggested, since five languages plus the font settings of PR 154 is a feature release), turn `## [Unreleased]` in `CHANGELOG.md` into the version heading, tag, publish to the VS Code Marketplace and to Open VSX. Follow `docs/RELEASE_CHECKLIST.md`. The owner wants it live on 2026-10-11; issues 86 and 15 were promised the font settings the same day.
- [ ] **Confirm both stores** show the new version and the README's Languages section.
- [ ] **Reply on #55 and #77, then close them.** Only after the stores are live, so the reply can name the version. The owner asked for the wording "live today, check on 12 October"; adjust the date if the release slips. The approved texts are in the session hand-over note, not in this repository. Nothing has been posted.
- [ ] **Marketplace short description and keywords.** Unchanged in PR 155. Owner's choice between leaving them (suggested while the rename rank sampling runs through 2026-10-15) and appending "In 6 languages." to the description.
- [ ] **Close the plans.** After the release, `git mv` this file and `task-cjk-word-count.md` to `roadmap/shipped/` and update `roadmap/pipeline/README.md`.

### Known gaps carried forward

- No native speaker has reviewed any of the five languages. #55's author offered to review Chinese.
- In icon mode the Feedback toolbar shows the comment count only in the tooltip. Russian needs about 900 px of editor width to show labels.
- Not tested on VSCodium, Devin Desktop or remote hosts.
- `scripts/svg-image-fixture/pdf-export.mjs` has its own hand-written `vscode` module. A new `vscode` API used by `documentExport.ts` must be added there too; CI runs it as `npm run test:svg-browser`.

### Later

- A count ratchet: fail CI when the number of unconverted UI strings in a converted area rises.
- Plural forms beyond two, if a Slavic language is contributed.
- Right-to-left layout, if VS Code gains such a display language.
- Translated README section or Marketplace gallery text, if the Marketplace starts honoring locale files [S11].

---

## 10. Best-practice audit (2026-10-11)

Every part of the extension checked against published localization practice. Method: a second full string census of `src/` after conversion (it also looks at text that reaches the UI through variables, which the CI ratchet cannot see), targeted searches for formatting, joining and sorting, the packaging file list, and the real-host runs in section 7.

**Sources**

- [B1] Microsoft Learn, Software internationalization: https://learn.microsoft.com/en-us/globalization/methodology/software-internationalization
- [B2] Microsoft Learn, Concatenation: https://learn.microsoft.com/en-us/globalization/internationalization/concatenation
- [B3] Microsoft Learn, Message formatting: https://learn.microsoft.com/en-us/globalization/internationalization/message-formatting
- [B4] Microsoft Learn, Pluralization: https://learn.microsoft.com/en-us/globalization/internationalization/pluralization
- [B5] Microsoft Learn, Externalize resources: https://learn.microsoft.com/en-us/globalization/internationalization/externalize-resources
- [B6] Microsoft Learn, Best practices for world-ready apps: https://learn.microsoft.com/en-us/dotnet/core/extensions/best-practices-for-developing-world-ready-apps
- VS Code: [S1] vscode-l10n README, [S3] l10n-dev README, [S4] API reference, [S6] l10n sample, [S8] "Localization as part of the API", [S9] `extHostLocalizationService.ts`, plus:
- [B7] VS Code source, `remoteExtensionsScanner.ts` (language passed to remote scans, language pack installed on the remote): https://github.com/microsoft/vscode/blob/main/src/vs/server/node/remoteExtensionsScanner.ts
- [B8] VS Code PR 331626, command titles lose localization after an install or update until restart: https://github.com/microsoft/vscode/pull/331626

**Status key:** Met, Partial (works, with a stated limit), Gap (not done), n/a.

### A. VS Code platform practices

| # | Practice | Source | Status | Evidence and limits |
| - | -------- | ------ | ------ | ------------------- |
| A1 | Manifest text uses `%key%` with English in `package.nls.json` | S1, S6 | Met | 39 entries; `manifest.test.ts` fails on any literal under `contributes`. Settings added on `main` after this branch was cut are not in yet |
| A2 | Per-language manifest files `package.nls.<locale>.json` | S1 | Met | Drafts for 5 languages; checked for kept links, code spans and `{{placeholders}}` |
| A3 | Code text uses `vscode.l10n.t` | S1, S4 | Met | Host files use it directly |
| A4 | `"l10n"` field points at the bundle folder | S6 | Met | `"l10n": "./l10n"` |
| A5 | Bundles named `bundle.l10n.<locale>.json` with VS Code locale ids | S1, S9 | Met | `zh-cn`, `ja`, `es`, `pt-br`, `ru`; loaded by exact id in real hosts |
| A6 | Subprocess or webview receives `l10n.bundle` or `l10n.uri` from the host | S1, S8 | Met | Bundle rendered on `<body>`; read back in VS Code 1.98.0, 1.141.0 and Cursor |
| A7 | Do not use `@vscode/l10n` in the main process; `vscode-nls` is superseded | S1, S8 | Met | Neither is a dependency |
| A8 | Translator comments disambiguate identical English text | S8 | Partial | 21 of 872 messages carry a comment. 56 messages are used in more than one file; the most reused are true synonyms ("Cancel", "Retry", "Close") |
| A9 | Extract strings with tooling, do not hand-maintain the bundle | S3 | Met | `npm run l10n:extract`; CI fails when the bundle and the code differ. Own extractor, because the official one cannot see the webview helper (section 5.3) |
| A10 | Missing translation falls back to English per key | S1, S9 | Met | Unit tests and real-host run ("Close search" left out on purpose in the first run) |
| A11 | Test with pseudo-localization | S3, S6, B2 | Partial | One real-editor test pseudo-translates every message. No `qps-ploc` pass over the whole UI in a real host |
| A12 | Keep Marketplace listing fields plain | S16 | Met | `displayName`, `description` literal; English manifest values are plain strings, not the comment form |
| A13 | Works in remote hosts (SSH, WSL, containers) | B7 | Partial | VS Code's source passes the display language to remote scans and installs the language pack there. Not run by us |
| A14 | Works in forks | S19 | Partial | Cursor verified for `zh-cn` and `ja`. VSCodium and Windsurf not run |
| A15 | Package the translation files | vsce | Met | `vsce ls` lists `package.nls.*.json` and `l10n/bundle.l10n.*.json`; `l10n/drafts/` and `l10n/README.md` are excluded |
| A16 | Language change needs no code in the extension | S10 | Met | VS Code restarts on a display language change; no setting of our own |

### B. General localization practices

| # | Practice | Source | Status | Evidence and limits |
| - | -------- | ------ | ------ | ------------------- |
| B1 | Externalize every user-facing string | B1, B5 | Met | Census: of 656 UI strings found, 627 go through translation; the rest are language names, icon fallbacks and 2 lines waiting on `main`. Ratchet in CI holds it |
| B2 | Keep non-user text (logs, debug) out of translation | B1, B5 | Met | `[MD4H]` logs untouched; internal errors stay English by rule |
| B3 | Errors a user can act on are translated | B1 | Met | 98 thrown errors sorted and converted in two passes; 69 internal ones in the provider left English on purpose |
| B4 | No concatenation; whole sentences | B2, B3, B6 | Met | Extractor rejects non-literal messages; plural suffixes and "is/are" fragments rewritten as whole sentences |
| B5 | Do not join sentences or list items in code | B2 | Partial | The one sentence join now goes through a message, so a language can drop the space. Lists of item ids (F1, F2) are still joined with `', '` in 4 places |
| B6 | Placeholders can be reordered | B2, B3 | Met | Indexed `{0}`; tested with reordered and repeated placeholders |
| B7 | Prefer named placeholders, document what each stands for | B3, B5 | Gap | 200 messages use numbered placeholders and none documents them. VS Code supports named ones; converting would change every key |
| B8 | Plurals follow each language's rules | B4 | Partial | Two forms (one, other) chosen in code. Enough for the five languages only because Russian uses a "label: number" shape; no ICU plural categories |
| B9 | Inserted words must not break grammar | B2, B3 | Partial | Block kinds and counted phrases are inserted into other sentences in about 10 messages. Reviewers reshaped those sentences per language; a few read as labels |
| B10 | Do not reuse one string for different meanings | B3, B5 | Partial | Verb or noun cases carry comments. Not audited message by message beyond the reviewers' pass |
| B11 | Never use display text as an identifier | B5 | Met | 15 "compare with the button label" sites and one "match the label with a regex" site fixed; nothing translated is stored or sent to the host (pseudo-translation test) |
| B12 | Dates, numbers and units follow the locale | B1, B3, B6 | Met | Host counts use `vscode.env.language`; webview sizes use `l10n.formatNumber`; dates use `Intl` with the document language. Units (KB, MB, px) are inside the message |
| B13 | No hardcoded locale | B6 | Met | The only `'en-US'` left in UI code is the fallback when no language is set. The Feedback report keeps `'en-US'` on purpose |
| B14 | Markup stays out of translatable text | B3 | Met | `l10n.html` escapes; CI rejects `<` and `>` in translations; markup is inserted around a placeholder in code |
| B15 | No text inside images | B1 | Met | Icons are font glyphs or SVG shapes without words. Letter glyphs (B, I, S) can be replaced per language |
| B16 | Layout survives longer text | B1, B6 | Partial | Main toolbar measured identical in 5 languages. The Feedback toolbar (text buttons), dialogs and menus were not measured or looked at |
| B17 | Right-to-left layout | B1 | n/a | None of VS Code's display languages is right to left; 130 physical left or right rules in CSS would need work |
| B18 | Declare the content language | W3C | Met | `<html lang>` follows the display language once its bundle is loaded |
| B19 | Accessibility text is translated | B1 | Met | `aria-label`, `title`, `alt`, placeholders and live-region announcements are converted |
| B20 | Keyboard shortcuts are not assumed | B1 | Met | Key names are arguments or left as printed; no shortcut is changed by language |
| B21 | User content in any script works | B1 | Met | Chinese and Japanese text now counts one per character, the word-processor convention, with English counts unchanged (`task-cjk-word-count.md`). Thai, Lao, Khmer and Burmese still count by whitespace |
| B22 | Sorting and case follow the locale | B1 | n/a | No user-visible list is sorted alphabetically |
| B23 | Encoding | B1 | Met | UTF-8 JSON throughout |
| B24 | Tests do not depend on the machine's locale | B6 | Met | Tests run in English with a fixed fallback; translated runs set the bundle explicitly |
| B25 | Translation process: review, staleness, ownership | B5 | Partial | Drafts versus shipped folders, CI checks, translator guide. No native human has reviewed any language yet |

### What remains, in order of user impact

1. **Native review of the five languages** (B25). Both passes were AI. Chinese has a volunteer; the others have none.
2. **Sync with `main`** (A1): two messages and the newer settings.
3. **Screen check of the Feedback toolbar, dialogs and menus** in each language (B16).
4. ~~Word count for Chinese and Japanese (B21)~~ Done on 2026-10-11, without `Intl.Segmenter`; see `task-cjk-word-count.md`.
5. **Placeholder documentation or named placeholders** (B7) and more translator comments (A8).
6. **A full pseudo-language pass in a real host** (A11).
7. **Remote and other forks** (A13, A14): one manual run each.

