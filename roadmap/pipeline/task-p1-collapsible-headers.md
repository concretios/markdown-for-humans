# Task: Collapsible Headers

## 1. Task Metadata

- **Task name:** Collapsible Headers
- **Slug:** collapsible-headers
- **Status:** planned
- **Created:** 2025-11-29
- **Last updated:** 2025-11-29
- **Shipped:** _(pending)_

---

## 2. Context & Problem

**Current state:**
- All content always visible, no way to collapse sections
- Long documents require excessive scrolling
- No way to focus on specific sections
- Headers don't indicate they can be interacted with

**Pain points:**
- **Information overload:** Large documents show all content at once, overwhelming readers
- **Slow navigation:** Must scroll through irrelevant sections to reach desired content
- **No focus mode:** Can't hide unrelated sections to concentrate on current work
- **Lost context:** Hard to see document structure when all sections expanded
- **User need:** Collapsible sections help users focus on relevant content and navigate long documents

**Why it matters:**
- **Long document usability:** Technical docs, API references, guides often 1000+ lines
- **Reading efficiency:** Collapse completed sections, focus on current section
- **Document overview:** Collapsed view shows structure like an outline
- **Presentation mode:** Collapse all, reveal sections progressively
- **Professional feature:** Standard in modern documentation tools and markdown editors

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Headers (H1-H6) show collapse/expand indicators on hover
- Click indicator (or header itself) to collapse section
- Collapsed sections hide all content until next same-level header
- Collapsed state shows ellipsis or indicator (e.g., "... 25 lines hidden")
- Keyboard shortcuts for collapse/expand operations
- Command palette commands for "Collapse All" / "Expand All"
- Collapsed state remembered per document (workspace state)
- Works smoothly with 100+ collapsible sections

**In scope:**
- **Collapse indicators:**
  - Chevron icon (▶/▼) appears on header hover
  - Icon positioned in left gutter (before header text)
  - Click chevron OR header text to toggle
- **Collapse behavior:**
  - Collapses all content from header to next same-level header
  - Nested headers collapse recursively (H2 under H1, etc.)
  - Shows summary line: `... (12 lines, 3 subsections) ...`
- **Keyboard shortcuts:**
  - `Ctrl+Shift+[` - Collapse current section
  - `Ctrl+Shift+]` - Expand current section
  - `Ctrl+K Ctrl+0` - Collapse all
  - `Ctrl+K Ctrl+J` - Expand all
- **Command palette:**
  - "Fold Section"
  - "Unfold Section"
  - "Fold All Sections"
  - "Unfold All Sections"
  - "Fold Level 1-6" (collapse all H1s, H2s, etc.)
- **State persistence:** Remember collapsed state per file
- **Integration with outline:** Outline panel shows collapse state

**Out of scope:**
- Manual fold regions (like `#region` in code) - future feature
- Collapse based on list items - focus on headers only
- Collapse animations (start with instant toggle) - polish later
- Custom fold markers - future feature
- Fold on save/open behavior - future feature

---

## 4. UX & Behavior

**Entry points:**
- **Primary:** Hover over header → click chevron icon
- **Alternative:** Click anywhere on header text
- **Keyboard:** `Ctrl+Shift+[` when cursor in section
- **Command palette:** "Fold Section" / "Unfold Section"
- **Context menu:** Right-click header → "Fold Section"

**User flows:**

### Flow 1: Collapsing a single section
1. User has long document with section:
   ```
   ## Installation

   To install the extension:
   1. Open VS Code
   2. Navigate to Extensions
   3. Search for "Markdown Editor for Humans"

   ### Prerequisites

   You need Node.js 20+.

   ## Configuration
   ```
2. User hovers over "Installation" header
3. Chevron icon (▼) appears in left gutter
4. User clicks chevron (or header text)
5. Section collapses:
   ```
   ▶ ## Installation ... (7 lines, 1 subsection)

   ## Configuration
   ```
6. Content hidden, summary shows what's collapsed

### Flow 2: Expanding collapsed section
1. User sees collapsed section: `▶ ## Installation ... (7 lines, 1 subsection)`
2. User clicks chevron (now pointing right ▶)
3. Section expands, chevron changes to ▼
4. All content visible again

### Flow 3: Nested section collapse
1. Document structure:
   ```
   # API Reference

   ## Authentication
   ### OAuth
   ### API Keys

   ## Endpoints
   ### GET /users
   ### POST /users
   ```
2. User collapses "API Reference" (H1)
3. All nested content (H2, H3) collapses:
   ```
   ▶ # API Reference ... (15 lines, 2 sections, 4 subsections)
   ```
4. User expands "API Reference"
5. H2 headers visible, but their collapsed state preserved:
   ```
   # API Reference

   ▶ ## Authentication ... (8 lines, 2 subsections)
   ▶ ## Endpoints ... (6 lines, 2 subsections)
   ```

### Flow 4: Collapse All
1. User has document with 20 top-level sections
2. User wants to see overview of document
3. User presses `Ctrl+K Ctrl+0` (collapse all)
4. All H1 sections collapse:
   ```
   ▶ # Introduction ... (5 lines)
   ▶ # Getting Started ... (12 lines, 2 subsections)
   ▶ # Features ... (35 lines, 5 subsections)
   ▶ # API Reference ... (100 lines, 10 subsections)
   ▶ # Conclusion ... (3 lines)
   ```
5. Document structure visible at a glance

### Flow 5: Keyboard workflow
1. User's cursor is inside "Authentication" section
2. User presses `Ctrl+Shift+[`
3. Current section collapses
4. User presses Down arrow to move to next section
5. User presses `Ctrl+Shift+]` to expand that section
6. Efficient keyboard-driven navigation

### Flow 6: Outline integration
1. User has outline panel open
2. Document has some collapsed sections
3. Outline shows collapse state:
   ```
   📄 My Document
   ├─ ▶ Introduction (collapsed)
   ├─ ▼ Getting Started (expanded)
   │  ├─ Installation
   │  └─ Configuration
   └─ ▶ Features (collapsed)
   ```
4. Clicking outline item expands collapsed section and navigates to it

### Flow 7: Working with collapsed content
1. User collapses "Features" section
2. User presses `Ctrl+F` to find "table feature"
3. Search finds match inside collapsed section
4. Section auto-expands to show search result
5. User navigates to match

**Behavior rules:**
- **Collapse scope:** From header to next same-or-higher level header
- **Recursive collapse:** Nested headers collapse when parent collapses
- **State preservation:** Nested collapse states preserved when parent expands
- **Cursor behavior:**
  - If cursor in section when collapsed, move to header line
  - If cursor before collapsed section, maintain position
- **Editing behavior:**
  - Can't edit collapsed content (auto-expands if user tries)
  - Paste/insert operations auto-expand affected sections
- **Search integration:** Finding text in collapsed section auto-expands it
- **Selection:** Can't select text across collapsed sections
- **Undo/redo:** Collapse/expand is NOT undoable (view state, not content change)

**Visual design:**
- **Chevron indicator:**
  - Position: Left gutter, aligned with header text
  - Size: 16x16px
  - Icon: ▶ (collapsed) / ▼ (expanded)
  - Color: Muted (matches header color at 70% opacity)
  - Hover: Brighter color, slight background highlight
  - Cursor: Pointer on hover

- **Collapsed section summary:**
  - Format: `... (X lines, Y subsections) ...`
  - Style: Italic, muted color
  - Indent: Same as header
  - Click: Expands section

- **Header interaction:**
  - Entire header clickable for collapse/expand
  - No visual change to header text itself
  - Smooth transition (100ms fade)

**Edge cases:**
- **Document start:** Can't collapse content before first header (no parent)
- **Empty sections:** Headers with no content show `... (empty)`
- **Adjacent headers:** Two headers with no content between them both visible
- **Last section:** Section at document end collapses to EOF
- **Malformed hierarchy:** Skip-level headers (H1 → H3) use DOM hierarchy
- **Very large sections:** Collapse 1000+ line sections without performance hit
- **Concurrent editing:** If file changes externally, maintain collapse state if possible

---

## 5. Technical Plan

_(To be filled during task refinement)_

---

## 6. Work Breakdown

_(To be filled during task refinement)_

---

## 7. Implementation Log

_(To be filled during implementation)_

---

## 8. Decisions & Tradeoffs

_(To be filled during implementation)_

---

## 9. Follow-up & Future Work

- Collapse animations (smooth expand/collapse)
- Manual fold regions (custom markers)
- Fold on save/open (e.g., always collapse H1s)
- Fold persistence across sessions (remember per file)
- Fold based on code blocks, lists
- Fold level indicator in outline
- Export with collapsed sections (e.g., PDF with expandable sections)
- Fold gutter (dedicated column for collapse indicators)
