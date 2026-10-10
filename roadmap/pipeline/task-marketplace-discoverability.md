# Task: Marketplace Discoverability (Rename to Markdown Editor for Humans)

## 1. Task Metadata

- **Task name:** Marketplace discoverability: display name, description, keywords
- **Slug:** marketplace-discoverability
- **Status:** in-progress
- **Created:** 2026-10-09
- **Last updated:** 2026-10-09
- **Shipped:** _(pending)_

---

## 2. Context & Problem

**Current state (measured 2026-10-09):**
- Display name `Markdown for Humans: WYSIWYG Editor`, 155 character description, 30 keywords (31 published tags after vsce adds `keybindings`).
- VS Code Marketplace rank: #76 for "markdown editor", #2 "wysiwyg", #8 "wysiwyg markdown", #156 "markdown viewer", #128 "markdown".
- Open VSX rank: #25 "markdown editor", #68 "markdown". Cursor re-sorts Open VSX's top 50 by installs.

**How ranking works (evidence in Section 8):**
- **VS Code Marketplace sorts in tiers by display name.** Extensions whose display name contains the exact query phrase rank first (ranks 1 to 74 of 162 for "markdown editor"). Names with both words split come next (we sit at #76). 35 extensions with fewer than 100 installs outrank us only because of the phrase.
- **Inside the top tier, weighted rating leads** (Spearman 0.94), then rating count (0.82) and shorter names (0.77). Installs matter less (0.42). Weighted rating fits `(avg * n + 4.45 * 10) / (n + 10)`; ours is 4.675, above every top tier extension today.
- **Open VSX scores** `name^5, displayName^5, tags^3, namespace^2, description`, multiplied by a relevance factor (rating, log downloads, recency). README and categories are not indexed on either registry.
- **Single word "markdown" is an installs race** (Spearman 0.91). Metadata cannot win it.

**Pain points:**
- **Invisible for the biggest query:** people who type "markdown editor" in the Extensions view do not see us on the first page.
- **Feature list description:** 155 characters, ends with an em dash and "all inside VS Code", although the extension ships to Cursor, Antigravity and Windsurf through Open VSX.
- **Keyword slots spent on dead terms:** `drag-drop`, `syntax-highlighting`, `tables` (duplicate), `cursor`, `agent`, `review` carry no measurable demand.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- VS Code Marketplace rank for "markdown editor" moves from #76 to the top 10 within 5 days of publishing (positions jitter; average 3 to 5 daily samples).
- No regression outside the top 10 for "wysiwyg" (today #2) and top 15 for "wysiwyg markdown" (today #8).
- Every user facing string in VS Code (Open With entry, Command Palette titles, Outline view, Settings section, messages) shows the new name.
- Extension ID, command IDs, setting keys and keybindings are unchanged.
- All tests, lint, build and the Extension Development Host suite pass.

**In scope:**
- `package.json`: `displayName`, `description`, `keywords`, every contributed label.
- Source strings visible to users.
- README (the listing page), CHANGELOG entry, docs, issue templates, legal documents (product name only), pipeline plans that quote UI labels, test fixtures and comments.
- Wiki submodule pages (local edit; the wiki repo needs its own commit and push).
- A manifest policy test that guards the listing metadata.
- New extension icon (`icon.png`, `marketplace-assets/icon/icon.png`, the feature tour fixture copy).

**Out of scope:**
- Extension ID or publisher change (would orphan installs and ratings).
- `roadmap/shipped/*` and past CHANGELOG entries (historical record of what shipped under the old name).
- GIFs and screenshots in `marketplace-assets/` (re-recording is separate work).
- In product rating prompt (next lever, separate plan).
- GitHub repository description and website copy (outward facing, owner action).

---

## 4. UX & Behavior

**Entry points that change label:**
- Explorer and editor tab right click: **Open With...** lists the editor as **Visual Editor**, with Markdown Editor for Humans as its detail line (see section 8)
- Command Palette: `Markdown Editor for Humans: Start Feedback` and the other Feedback commands, `Open with Markdown Editor for Humans`
- Explorer view: `Markdown Editor for Humans: Outline`
- Settings: section title `Markdown Editor for Humans`

**Behavior rules:**
- A user who made the editor their default for `*.md` keeps it: the default is stored by view type (`markdownForHumans.editor`), not by label.
- Existing keybindings keep working: they bind command IDs.

---

## 5. Technical Plan

**Listing metadata:**
- `displayName`: `Markdown Editor for Humans` (contains the "markdown editor" phrase, 4 words, keeps the brand words "for Humans"). Chosen by the owner over `WYSIWYG Markdown Editor for Humans`, accepting a likely drop on "wysiwyg" queries.
- `description` (113 characters): `WYSIWYG Markdown editor and viewer with visual tables, Mermaid diagrams and image resizing. Saves plain Markdown.` Keeps "WYSIWYG" findable now that it left the name, adds "viewer" (18,100 US searches a month for "markdown viewer"), drops the em dash and the VS Code only claim.
- `keywords` (30, the documented Marketplace cap; vsce does not enforce it):

| Keep (core and Open VSX tag weight) | Add (demand or alternative terms) | Drop (no demand or duplicate) |
|---|---|---|
| markdown, md, editor, wysiwyg, preview, table, mermaid, diagram, gfm, readme, documentation, writing, pdf, docx, image, image-resizing, notion-like, ai | markdown-editor, markdown-viewer, viewer, reader, markdown-preview, table-editor, katex, math, typora, obsidian, notion, rich-text | tables, drag-drop, syntax-highlighting, live-preview, formatting, export, visual, distraction-free, github-flavored-markdown, agent, cursor, review |

**Key changes:**
- `src/__tests__/extension/marketplaceListingPolicy.test.ts`: new policy test (written first).
- `package.json`: metadata above; contributed labels already renamed.
- `README.md`, `CHANGELOG.md`, `docs/*`, `.github/ISSUE_TEMPLATE/*`, `EULA.md`, `TERMS_OF_USE.md`, `PRIVACY_POLICY.md`, `THIRD_PARTY_LICENSES.md`, `CONTRIBUTING.md`, `KNOWN_ISSUES.md`, `roadmap/pipeline/*`, `test/**`, `scripts/highlighting-fixture/README.md`, `wiki/*.md`: product name.
- `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`: replace the nonexistent "Output → Markdown for Humans" channel with **Help > Toggle Developer Tools > Console** (the extension never calls `createOutputChannel`).

**Performance considerations:**
- None. Metadata and strings only.

---

## 6. Work Breakdown

- [x] **Phase 1: Rename user facing surfaces**: display name, Open With, commands, Outline view, Settings, messages
  - [x] Update `feedbackNavigationCommands.test.ts` first (RED), then `package.json` (GREEN)
- [x] **Phase 2: Listing metadata**: description and keywords
  - [x] Write `marketplaceListingPolicy.test.ts` (RED: description and keyword tests failed)
  - [x] Update `package.json` (GREEN)
- [x] **Phase 3: Documentation**: every remaining mention outside the historical record, wiki included
- [x] **Testing**
  - [x] `npm test`, `npm run lint`, `npm run build:debug`
  - [x] `npm run test:integration` (Extension Development Host)
  - [x] `vsce package` accepts the manifest; packaged tags are the 30 keywords plus the automatic `keybindings`
  - [x] Native render pass in VS Code 1.141.0 (see log)
  - [x] Native click pass: editor picker, contributed labels, Settings, editing, save, Feedback, audit (see log). Typing, the Command Palette search and the Explorer right click menu were not exercised: computer use gets click only access to VS Code.
- [ ] **Post release measurement**: sample ranks daily for 5 days on both registries

**Rank sampling command** (same request the Marketplace search page sends):

```bash
curl -s -X POST https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json;api-version=7.2-preview.1;excludeUrls=true' \
  -d '{"filters":[{"criteria":[{"filterType":8,"value":"Microsoft.VisualStudio.Code"},{"filterType":10,"value":"markdown editor"},{"filterType":12,"value":"37888"}],"pageSize":54,"pageNumber":1,"sortBy":0,"sortOrder":0}],"flags":870}' \
  | jq '[.results[0].extensions[] | .publisher.publisherName + "." + .extensionName] | index("concretio.markdown-for-humans")'
```

Open VSX: `curl -s 'https://open-vsx.org/api/-/search?query=markdown%20editor&size=50' | jq '[.extensions[] | .namespace + "." + .name] | index("concretio.markdown-for-humans")'`

---

## 7. Implementation Log

### 2026-10-09: Research and rename

- **What:** Measured ranking on both registries, settled the name with the owner, renamed every VS Code surface.
- **Files:** `package.json`, `src/extension.ts`, `src/editor/MarkdownEditorProvider.ts`, `src/webview/features/imageResizeWarning.ts`, `src/__tests__/extension/feedbackNavigationCommands.test.ts`, `README.md`, `KNOWN_ISSUES.md`, `CONTRIBUTING.md`, `docs/QA_MANUAL.md`, `test/manual/feature-tour.md`, `CHANGELOG.md`
- **Notes:** `npm test` (210 suites), lint, debug build and the Extension Development Host suite (8 tests) pass. KNOWN_ISSUES pointed at a nonexistent "Open File" command; corrected to the real `Open with` title.

### 2026-10-09: Listing metadata and documentation

- **What:** New description and 30 keywords guarded by `marketplaceListingPolicy.test.ts` (written first, 2 tests failed, then passed). Renamed the product across docs, issue templates, legal documents, pipeline plans, fixtures, comments and the wiki submodule. Replaced the nonexistent "Output → Markdown for Humans" log channel in CONTRIBUTING and the bug template with Help → Toggle Developer Tools → Console. Corrected 5 wiki references to a nonexistent "Open File" command.
- **Verification:** `npm test` 211 suites, 4,380 tests pass; lint clean; debug build; Extension Development Host suite 8 passing on VS Code 1.141.0; `vsce package` succeeds.
- **Left as is:** `roadmap/shipped/*`, past CHANGELOG entries, and the sample frontmatter title in `task-p1-frontmatter.md` (example document content inside an ASCII box).
- **Open:** manual check of labels in a real VS Code window; wiki commit and push in the submodule repo.

### 2026-10-09: New icon

- **What:** Owner supplied a 2750 px logo. Cropped to the circle (the source canvas had 164 px left and 55 px right margins), padded 3% evenly, exported at 256 px (57 KB). The old icon had an opaque white square that showed on dark themes; the new one has transparent corners.
- **Known weaknesses (designer follow-up):** the M mark sits 97 px (3.8%) right of the circle center in the source art, and white on the pastel gradient measures 1.4:1 to 1.84:1 contrast, so the mark looks faint at 24 to 42 px on the white Marketplace page.

### 2026-10-09: Native render pass

- **Setup:** packaged VSIX (release build) installed into an isolated profile in VS Code 1.141.0, `*.md` associated with `markdownForHumans.editor`, feature tour split into one file per section, each opened through the `code` CLI and captured from the test window only (`screencapture -l <window id>`). No clicks were available, so editing, the Open With picker, the Command Palette and Settings search were not exercised.
- **Light theme, all pass:** frontmatter, headings, inline formatting, blockquotes and the five alert types, nested bullet and ordered lists, task lists, both tables with column alignment, seven code blocks with highlighting and copy buttons, Mermaid flowchart and sequence diagram, inline and display KaTeX, PNG screenshot and the new 128 px icon inline, horizontal rule, footnotes and raw HTML shown as source (as documented).
- **Dark theme, all pass:** alerts, tables, code, math, images; Mermaid redrew in dark colors after a live theme switch without reopening the file.
- **Rename visible natively:** editor switcher reads "Markdown Editor for Humans"; the Explorer shows the Outline view as "Markdown Editor For Humans: Outline" (VS Code capitalizes view titles; the manifest keeps lowercase "for").

### 2026-10-10: Native click pass on the PR head

- **Build:** `376f694`, clean release build, VSIX installed into a fresh isolated profile, VS Code 1.141.0 on macOS, driven with computer use (left clicks only). Same commit: lint clean, Jest 211 suites and 4,382 tests pass, Extension Development Host suite 8 passing on macOS.
- **Labels, all pass:** editor picker reads `Visual Editor - Markdown Editor for Humans` (the name no longer appears twice). The extension page's Features tab lists every command as `Markdown Editor for Humans: ...` and the view as `Markdown Editor for Humans: Outline`. The toolbar gear opens Settings filtered to the extension under the new section title. The image resize warning reads "Markdown Editor for Humans will reduce the resolution of this image...".
- **Editing and save, all pass:** ticked a task, bolded a word from the toolbar, added a table row from the toolbar table menu, resized an image 128 to 125 px (backup written to `.md4h/image-backups/`), closed the tab and chose Save. The saved file differs from the original only in those edits; the compact table and the image Markdown are byte identical.
- **Other features, all pass:** Outline view jumps to a heading; source split opens and closes; Feedback starts, shows the finish dialog with Finish & copy disabled at zero comments, and discards; audit reports a healthy document; the export menu offers PDF and Word and reaches the Word save panel; the full feature tour renders in dark and light themes, with Mermaid redrawn after a live theme switch.
- **Expected, not regressions:** Feedback refuses `feature-tour.md` with "Canonical block content does not match the saved source snapshot" (the escaped `\*` and `\_` case in `KNOWN_ISSUES.md`). The extension page header still shows the old name, icon and description: VS Code overlays the live Marketplace listing for the same ID and version until the new version is published.
- **Not exercised:** typing, keyboard shortcuts, the Command Palette search, the Explorer right click menu, drag resize, Feedback comments with Finish & copy, PDF export, and writing the Word file (the tool could not confirm the save panel's target).
- **Docs corrected after this pass:** `README.md`, `KNOWN_ISSUES.md`, `CHANGELOG.md` and `test/manual/feature-tour.md` told users to pick "Markdown Editor for Humans" in **Open With...**; the entry there is now **Visual Editor**.
- **Rank baseline, 2026-10-10, before release:** VS Marketplace #76 "markdown editor", #125 "markdown", #2 "wysiwyg", #8 "wysiwyg markdown", outside the top 200 for "markdown preview" and "markdown viewer". Open VSX #25 "markdown editor", #6 "wysiwyg". 11,783 installs, 7 ratings.

---

## 8. Decisions & Tradeoffs

- **Name `Markdown Editor for Humans` over `WYSIWYG Markdown Editor for Humans`:** owner preference for a shorter name. Tradeoff: likely fall from #2 to below about #27 for "wysiwyg" (26 extensions carry the word in their name, with no tier exceptions), softened by keeping "WYSIWYG" first in the description.
- **Keyword count stays at 30:** tags give eligibility for rare terms (we rank #1 for `image-resizing`, #3 for `notion-like` from tags alone) and count 3x on Open VSX. They rarely lift rank on contested terms, so slots go to alternative terms people search.
- **Keyword stuffing rejected:** listings with 200 character keyword names rank #47 to #102; long names lose position inside a tier.
- **Historical docs untouched:** shipped plans and past CHANGELOG entries describe releases under the old name.
- **Custom editor named `Visual Editor`:** VS Code prints the custom editor name and the extension name side by side in the editor picker and **Open With...**. With both set to the product name the picker read it twice. The custom editor name is a contribution label, not listing metadata (display name, description, tags), so no ranking cost is expected; not measured.
- **Setting keys kept:** Settings shows each setting as `Markdown For Humans: ...` because VS Code builds that label from the `markdownForHumans.*` key. Renaming the keys would drop every user's saved settings.

**Evidence:** VS Code gallery `extensionquery` captured from the Marketplace search page and replayed for 11 queries (54 to 162 results each); Open VSX source (`ElasticSearchService.java`, `RelevanceService.java`); vsce `src/package.ts` (`TagsProcessor`); vscode-docs `extension-manifest.md` ("limited to 30 keywords"); DataForSEO US search volume.

---

## 9. Follow-up & Future Work

- In product rating prompt: rating count is the top in tier lever (10 five star ratings lift weighted rating to 4.725, 20 to 4.817).
- Use the `category` field for command titles so a future rename touches one string.
- Re-record marketplace GIFs that show the old name, if any.
- Update the GitHub repository description to match.
- README badges: the two `visual-studio-marketplace` shields.io badges render as "retired badge" on the listing page (same on `main`). Remove or replace them.
- An edited table saves its delimiter row one or two dashes wider than its columns (valid Markdown, misaligned source). Seen in the native pass; not caused by the rename.
- Outreach to listicles that ChatGPT cites for "best WYSIWYG markdown editor for VS Code" (we have zero ChatGPT mentions today).
