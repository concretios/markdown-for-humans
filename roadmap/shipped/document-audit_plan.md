# Task: Document Audit

## 1. Task Metadata

- **Task name:** Document Audit
- **Slug:** document-audit
- **Status:** shipped in 0.4.0
- **Created:** 2026-04-02
- **Last updated:** 2026-04-07
- **Shipped:** 2026-04-07

---

## 2. Context & Problem

**Current state:**
- No way to detect broken links, images, or invalid references in markdown documents. 
- Users discover broken links/images only when clicking them or exporting.
- No automated validation of file paths, URLs, or heading anchors.
- Manual checking is tedious for long documents.

**Pain points:**
- **Silent failures:** Broken links/images don't show errors until clicked.
- **Export issues:** PDF/Word exports fail silently when images are missing.
- **Refactoring risk:** Renaming files or headings breaks links with no warning.
- **User frustration:** Users must manually verify every link/image in large documents.
- **No auto-fix:** Even when issues are found, users must fix them manually.

**Why it matters:**
- **Reliability:** Prevents silent failures in exports and broken references, significantly improving document reliability.
- **Efficiency:** Reduces manual work for users checking large documents, bringing a vital automated safety net.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Click toolbar "Audit" button → scans current document for broken items.
- Broken items highlighted inline with visual indicators (red underline/border).
- Summary panel shows categorized list of issues (Links, Images, Headings).
- Click issue in panel → navigates to item in document.
- Auto-fix suggests corrections for common issues (file path typos, case sensitivity).
- URL validation runs async (doesn't block UI).
- Audit completes in <2 seconds for typical documents (<5000 lines).

**In scope:**
- **Link validation:** File links, URL links, Heading links.
- **Image validation:** Check if image file exists at specified path.
- **Inline highlighting:** Use ProseMirror decorations to highlight broken items.
- **Summary panel:** Categorized list with navigation and actions.
- **Auto-fix suggestions:** File path typos, case sensitivity, heading slug mismatches.

**Out of scope:**
- Deep validation of external web APIs beyond checking if a URL fetch baseline succeeds.
- Fully automated fixing without user interaction.
- Validation types beyond Links, Images, and Headings for now.

---

## 4. UX & Behavior

**Entry points:**
- Toolbar "Audit" button.

**User flows:**

### Flow 1: Running an Audit
1. User clicks "Audit" button in toolbar.
2. System asynchronously scans the document and communicates with the extension host.
3. System highlights broken links/images inline and opens summary panel.
4. User clicks an issue in the panel.
5. Editor scrolls to the broken item and selects it.

### Flow 2: Auto-fixing an issue
1. User sees an issue in the summary panel with a typo/incorrect path.
2. System suggests a correction (auto-fix).
3. User clicks "Fix".
4. System automatically applies the fix in the document and removes the issue from the list.

**Behavior rules:**
- URL validation runs asynchronously without blocking editing.
- Auto-fix should handle basic case insensitivity or small typos.
- File existence must be validated using the extension host API (`MarkdownEditorProvider`).

---

## 5. Technical Plan

**Surfaces:**
- Webview (TipTap Editor & UI).
- Extension host (`MarkdownEditorProvider`).

**Key changes:**
- `src/webview/features/auditDocument.ts` (NEW) – Main audit logic to extract items, validate, and create decorations.
- `src/webview/BubbleMenuView.ts` (MODIFY) – Add Audit button to the toolbar.
- `src/webview/editor.ts` (MODIFY) – Wire up the audit functionality.
- `src/editor/MarkdownEditorProvider.ts` (MODIFY) – Add file existence checks handling via extension host messages.
- `src/webview/editor.css` (MODIFY) – Add styles for inline highlights (decorations) and the summary panel.

**Architecture notes:**
- Webview logic primarily handles extracting document nodes and displaying decorations via ProseMirror.
- To check file existences, the Webview will dispatch messages to the extension host (`MarkdownEditorProvider`) which executes file-system checks and returns results.

**Performance considerations:**
- The audit MUST complete in <2 seconds for typical <5000 line documents.
- Process URLs asynchronously to avoid trailing blockages.

---

## 6. Work Breakdown

- [x] **Phase 1: Core Audit Logic**
  - Extract items, validate, create decorations.
- [x] **Phase 2: UI Components**
  - Add toolbar button, build summary panel structure, navigation.
- [x] **Phase 3: URL Validation**
  - Enable async URL checking with `fetch`.
- [x] **Phase 4: Auto-fix**
  - Add fuzzy matching logic (case correction, slug fixes, file typoes) and map fix actions.
- [x] **Phase 5: Polish & Testing**
  - Implement integration tests, verify performance budgets, test accessibility.