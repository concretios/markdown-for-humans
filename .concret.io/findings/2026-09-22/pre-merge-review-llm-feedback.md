# Pre-Merge Review: `feature/llm-feedback` → `main`

**Date:** 2026-09-22
**Branch:** `feature/llm-feedback` (65 commits, 242 files, +116,783/-3,054 vs `main` at `331ebe1`)
**Scope:** Feedback annotation feature (sealed `md4h-feedback/v2` evidence bundle for AI coding agents), document sync/save reliability rework, TipTap 3.0→3.30.5 upgrade, Mermaid/esbuild upgrades, manifest and CI changes.
**Method:** Seven parallel read-only reviews covering host state/persistence, evidence/protocol contracts, the extension-host provider, the Feedback review UI, capture/selection mapping, regressions to pre-existing editor behavior, and cross-cutting security/supply chain. Top findings were independently re-verified against the code and, where practical, reproduced by running the real modules (not the subagents' say-so alone). Verified items are marked accordingly below; everything else is the originating reviewer's CONFIRMED/PLAUSIBLE label.

**Automated gates (all green):**

| Check | Result |
|---|---|
| `npm run lint` (0 warnings allowed) | Pass |
| `npm test` | Pass — 148 suites, 2,756 tests (27 pre-existing skips, all on `main` already) |
| `npm run build:release` + `verify-build` | Pass |
| `npm ls` (lockfile matches manifest) | Pass |
| `npm audit --omit=dev` (shipped code) | 0 vulnerabilities |
| `npm audit` (incl. dev) | 1 high, `js-yaml` DoS advisory, dev-only (eslint/mocha/vsce/jest), fix available |
| Secrets/tokens in diff | None found |

**Bottom line:** passing tests and a clean build do not mean this is safe to ship. Two blockers and three high-severity defects corrupt or drop content on ordinary edit-and-save, for every user, whether or not they ever touch Feedback. Root cause is the TipTap upgrade's new Markdown escaper and list parser, only partially patched by this branch. The Feedback feature itself has no blockers.

---

## 1. Blockers — do not ship

### B1. URLs and emails containing `_ * [ ] ~ \` grow backslashes on every save
- **Files:** `src/webview/extensions/markdownCompatibilityMarks.ts:30-37`, `src/webview/utils/markdownSerialization.ts:80-92`
- **Reproduced independently** (jsdom harness against the real extension stack, TipTap 3.30.5 vs `main`'s 3.12.1):
  - Input: `See https://en.wikipedia.org/wiki/Foo_bar_baz for details.`
  - Save 1: `Foo\_bar\_baz`
  - Save 2: `Foo\\\_bar\\\_baz`
  - Save 3: `Foo\\\\\\\_bar\\\\\\_baz` — grows without bound on every open/edit/save cycle
  - `main`: unchanged on every save.
- **Cause:** the new `parseMarkdown` keeps autolinks as unmarked text; TipTap 3.30.5's `escapeMarkdownSyntax` (`node_modules/@tiptap/markdown/dist/index.js:1037`) escapes them, and only the entity part of `encodeTextForMarkdown` was patched for the upgrade. On reload, marked's `url` tokenizer swallows the backslashes back into the text, so they get escaped again next save.
- **User impact:** visible backslashes in the editor, links stop being clickable, permanent git diff churn on any file with underscored URLs/emails.
- **Fix direction:** keep autolink text unescaped, emit bare only when text equals href (e.g. via `PreservedMarkdownLiteral`); override `escapeMarkdownSyntax` (see B3/H2 below, same root cause).

### B2. Literal `&lt;div&gt;`-style entity text is converted to real HTML on save 1, then deleted on save 2
- **File:** `src/webview/utils/markdownSerialization.ts:89`
- **Reproduced independently:**
  - Input: `Use the &lt;div&gt; element.`
  - Save 1: `Use the <div> element.` (now real HTML)
  - Save 2: `Use the  element.` — the tag and its content are gone.
  - `main`: unchanged on every save.
- **Cause:** `.replace(/&gt;/g,'>').replace(/&lt;/g,'<')` un-encodes too broadly; TipTap decodes the entity on parse, so the round-trip writes real HTML the first time, which is then dropped as unrenderable raw HTML the second time.
- **User impact:** silent, permanent data loss for any document describing HTML syntax in prose (docs, READMEs, tutorials) — exactly the kind of file this extension targets.
- **Fix direction:** only un-encode `&amp;` and `&gt;`; keep `&lt;` encoded when followed by `[A-Za-z/!?]`, or leave `&lt;` encoded outside code entirely.

---

## 2. High severity

### H1. Checkboxes in numbered lists are silently deleted on save
- **File:** `src/webview/extensions/orderedListMarkdownFix.ts:34-44` (parse at `:56-64`)
- **Confirmed** by the originating reviewer, code-traced and consistent with the shared root cause.
- Input: `1. [x] done\n2. [ ] todo\n3. plain` → saves as `1. done\n2. todo\n3. plain`. Also fails for nested items, `10. [ ]`, and `1) [ ]`.
- **Cause:** the tokenizer returns `undefined` for numeric lists under the new parser, so marked's default tokenizer strips `[ ]`/`[x]` into flags the branch's `parseMarkdown` never reads.
- `main`: preserved `1. [x] done`.
- **Fix direction:** read `item.task`/`item.checked` in `parseMarkdown` and emit taskItems, or re-prefix `[ ] `/`[x] ` on the item text.

### H2. Ordinary prose gets escaped on save — footnotes specifically break
- **Files:** same unpatched `escapeMarkdownSyntax`, `src/webview/utils/markdownSerialization.ts:64-92`
- **Reproduced independently:**
  - `A snake_case name here.` → `A snake\_case name here.` (branch), unchanged on `main`
  - `Status: [WIP] item.` → `Status: \[WIP\] item.` (branch), unchanged on `main`
  - `Text[^1].\n\n[^1]: The note.` → `Text\[^1\].\n\n\[^1\]: The note.` (branch) — **this breaks GitHub-flavored footnote syntax**, not just a cosmetic escape. `main`: unchanged.
- Also affects tables, headings, `~85%` → `\~85%`, `C:\Users` → `C:\\Users`.
- **Fix direction:** override `escapeMarkdownSyntax` to escape only where structurally required (emphasis-opening `_`/`*`, real link/image `[`), never touch `[^`, escape backslashes only before ASCII punctuation.

### H3 (unverified, needs real Extension Host). Typing just before a tab switch may never reach disk
- **Files:** `src/webview/editor.ts:429-434`, `src/webview/documentSyncController.ts:105-127`, `src/editor/MarkdownEditorProvider.ts:836`
- **Trigger:** type, then switch tabs/groups within the 500ms serialization debounce.
- **Why plausible:** `retainContextWhenHidden` was changed to `false` (see M1), so the webview frame is destroyed on hide. The last edit depends on a `pagehide`/`visibilitychange` handler firing before teardown, which the reviewer believes is unreliable for an iframe on tab switch but could not confirm without a real host.
- **Action needed before release:** manually verify in a packaged Extension Host — type one character, switch tabs within ~300ms, switch back, check the file.

---

## 3. Medium severity — general (not Feedback-specific)

| # | Issue | File(s) | Status |
|---|---|---|---|
| M1 | Undo history (ProseMirror, unpersisted) is wiped on every tab switch | `MarkdownEditorProvider.ts:836` (`retainContextWhenHidden` → false) | Confirmed; also the root cause of H3 |
| M2 | "Copy selection as Markdown" bypasses the entity/escaping patch entirely | `src/webview/utils/copyMarkdown.ts:51` vs `markdownSerialization.ts:336` | Confirmed; patch is installed lazily and the copy path skips it |
| M3 | Ctrl+S can silently do nothing — no error, no save | `MarkdownEditorProvider.ts:10857-10873` | Plausible; triggered by a flush-boundary failure (pending image write, reconciliation in flight) |
| M4 | Rich view can go stale after an external A→B→A change (e.g. `git checkout`, undoing an AI edit); next edit from that view is rejected and lost | `MarkdownEditorProvider.ts:1281-1358`, `:11024-11051` | Traced in code: `main` reset `lastWebviewContent` after every post (`main:666`); this branch dropped that reset |
| M5 | Any document containing the literal text `md4h-pending-image:` cannot be edited in rich view — every edit throws and is discarded | `MarkdownEditorProvider.ts:8463-8496`, `:10965-10982` | Confirmed in code; no tracked file in this repo contains it, but a hostile or extension-doc file would trip it |
| M6 | Images referenced outside the workspace root (`../sibling/img.png`) stop rendering; `main` had a comment saying this was explicitly supported | `MarkdownEditorProvider.ts:1025-1040`, `:7893-7970` | Deliberate hardening, confirmed via test assertion, but not called out clearly as a behavior change in CHANGELOG |
| M7 | A rejected edit (base-version mismatch after an external change) discards the newest local typing instead of merging it | `src/webview/editor.ts:1626-1640, 2408-2412`, `documentSyncController.ts:97-101` | Plausible; may be deliberate per CHANGELOG's "reconciliation after rejected edits," not fully traced |
| M8 | A late edit ACK after a host flush barrier can leave the renderer's base version stale, causing the next edit to be rejected and lost | `documentSyncController.ts:117-120`, `editor.ts:1625, 2128` | Plausible |

## 4. Low severity — general

- Inline code spans containing backticks get mangled by TipTap's new delimiter logic (`` ```javascript` `` → `` ````javascript` ``, can lose text on a second save).
- `markdownForHumans.blankLines.mode: preserve` loses blank lines; TipTap 3.30.5's `parseTokens` bypasses `BlankLinePreservation.parseMarkdown`. Default mode also emits a stray whitespace-only line in some list cases.
- Word export: a `.png` that's actually a JPEG (common with renamed screenshots), or AVIF/TIFF/`.jfif`, falls back to a 400×300 default since the new bounded image-header readers require both extension and byte signature to match. `image-size` (removed) sniffed the real format.
- Two pre-existing (not new) commands-without-when-clause and settings-allowlist gaps: `handleUpdateSetting` writes any webview-supplied key/value into Global settings with no allowlist (`MarkdownEditorProvider.ts:10210`); low exploitability since the CSP is nonce-only.
- Feedback commands do nothing (silently) when run from the Command Palette outside a Markdown for Humans editor.

## 5. Pre-existing on `main` — not introduced by this branch, flagged for awareness

- **PDF export HTML injection:** `<base href="file://${docDir}/">` built by raw string concatenation with no escaping (`documentExport.ts:1252`, identical on `main:547`). A maliciously named directory in a cloned repo can inject markup/script into the exported PDF's page, no CSP present there.
- **Word export path traversal:** image `src` resolved with `path.resolve` and read with no containment check, size cap, or signature check before embedding (`documentExport.ts:1810-1818`). `![](../../.ssh/id_rsa)`-style paths copy arbitrary local files into the generated `.docx`.
- **`markdownForHumans.chromePath` has no `scope`**, so a workspace `.vscode/settings.json` can point PDF export at an attacker-committed binary once the folder is trusted (`package.json`).
- **Symlink-unaware containment check** (`isPathContainedWithin`) on several image handlers — lexical only, no `realpath`.
- Recommend filing these as separate hardening tickets; not blocking this PR since they don't regress from `main`.

---

## 6. Feedback feature — no blockers, several fixable defects

### High
- **Comment on an all-empty table-cell selection breaks the session.** `feedbackItemSummaryV2.ts:51` derives `focus` from the cell text; for blank cells that's `''` or only tabs/newlines. The protocol validator (`feedbackProtocol.ts:558-565`) rejects a blank `focus` after trim, so the whole `feedback.updated`/`feedback.started` host message is dropped. Verified in code: the webview's own fallback (`'[Empty cells]'`, `feedbackTableScopes.ts:69`) was never mirrored on the host side. Once triggered, every later add/edit/delete for that session silently fails to render, and the draft can't be resumed.

### Medium
- A comment on inline text containing a control character or exceeding 64 KiB is rejected with an opaque "renderer constraint is incompatible" error (block-scope comments still work).
- A failed image/CSS/font fetch during screenshot capture can produce a blank or partial PNG that is still accepted and saved as evidence — verified the fetch-timeout override: the app passes its own `AbortSignal` (`feedbackDomCapture.ts:1240`) which overrides the library's own timeout controller (`modern-screenshot` spreads `...requestInit` after its own `signal`, `index.mjs:1068`).
- Horizontally scrolled wide tables/long code lines are captured unscrolled — the screenshot doesn't match what the user saw (code-traced, not run in a browser).
- Starting Feedback from the Command Palette silently clicks Cancel on any open Math/Mermaid editor, discarding unsaved LaTeX/diagram text — confirmed; `mathEditor.ts` deliberately has no click-outside-cancel specifically to protect this text, so this defeats that design.
- The annotation dialog closes and discards a typed comment/strokes if the source file changes underneath it (git checkout, formatter, an AI agent's edit); the text composer instead goes read-only and preserves the draft — inconsistent behavior, confirmed.
- `.md4h/feedback/` drafts are not authenticated. Per the feature's own README they're intentionally not gitignored and may be committed, so a cloned repo can ship a poisoned draft; if a user Resumes it, attacker-authored text is sealed into the bundle handed to the AI agent (prompt-injection vector). Plausible, not exploited end-to-end.
- Feedback may fail to start on files with mixed/lone-CR line endings (`feedbackSnapshotService.ts:404-410` requires an exact byte/text match) — flagged independently by two reviewers, neither confirmed VS Code's actual EOL-normalization behavior.
- Four draft-store failure modes under crash or unusual filesystems: a host crash mid-screenshot-replace can brick a draft (unopenable, can't discard); an orphaned asset file blocks all further screenshot adds until a text item is added; a leaked report lock (Windows EPERM/EBUSY on unlink) blocks all further edits to that draft for the process's lifetime; screenshot storage depends on hard links with no fallback, failing outright on exFAT/some SMB/FUSE mounts.

### Low
- A stale "resume from a peer" offer can leave a view read-only with its toolbar disabled with no UI path to recover except reloading the webview (plausible, not fully traced).
- `aria-readonly`/`tabindex` can be left wrong (announcing an editable document as read-only to screen readers) after a peer-lock handoff.
- Capture has a hard 4,096 DOM-node cap per block with no way to satisfy it by "selecting a smaller area" when a single block (e.g. a long code block) exceeds it alone.
- Keyboard-invoked block capture has no deadline or cancel path, so a hung resource fetch can leave capture stuck for the rest of the session.
- Discard-draft's use of `useTrash: true` likely fails outright in remote/SSH/Codespaces workspaces, which this branch's `extensionKind: workspace` manifest change makes more common (unverified).

---

## 7. Manifest / release hygiene

- `capabilities.virtualWorkspaces.supported: false` is a **behavior change**, not just an explicit statement of the prior default: VS Code defaults undeclared extensions to `virtualWorkspaces: true`, so this newly disables the extension in GitHub Repositories / vscode.dev. `untrustedWorkspaces: false` matches the pre-existing default, so that one is not a regression. Neither is called out in the CHANGELOG.
- CHANGELOG's Security section claims "Production and development audits now report zero known vulnerabilities" — currently false; one high `js-yaml` dev-only advisory exists (`npm audit fix` available).
- CHANGELOG has a formatting artifact: `src/**tests**/...` should read `src/__tests__/...` (double-underscore mangled by a Markdown-bold formatter).
- `package.json` version is still `0.3.0` while the CHANGELOG entry is under `[Unreleased]` — needs a version bump before release.
- Untracked `test.md` in the repo root is not part of this diff, but a local `vsce package` run (not CI) would currently include it in the VSIX. Left as-is since it's outside this branch's changes.

---

## 8. Recommendation

**Do not merge as-is.** The two blockers (B1, B2) and the checkbox/footnote regressions (H1, H2) will corrupt ordinary users' files on save, independent of the Feedback feature, and are easy to hit (any doc with an underscored URL, an inline `&lt;tag&gt;`, a numbered checklist, or footnotes).

Suggested path:
1. Fix B1/B2/H1/H2 (all trace to the same unpatched `escapeMarkdownSyntax`/entity-decode/list-tokenizer gaps from the TipTap upgrade) and add the 117-file round-trip corpus diff as a permanent regression test.
2. Manually verify H3 (tab-switch data loss) in a packaged Extension Host before release; it cannot be confirmed from unit tests alone.
3. Fix the Feedback empty-table-cell bug (§6 High) since it can brick a user's draft session.
4. Ship the rest of the Medium/Low items as fast-follow PRs; none of them block the release on their own.
5. Update the CHANGELOG's audit claim and note the `virtualWorkspaces` behavior change before publishing release notes.

---

*Generated from a seven-agent parallel read-only review plus independent verification (code reads and a jsdom round-trip harness built from the real extension stack) of the highest-severity claims. No repository files were modified in the course of this review.*
