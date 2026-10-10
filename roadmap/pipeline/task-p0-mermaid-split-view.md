# Task: Mermaid Split-View Editor

## 1. Task Metadata

- **Task name:** Mermaid Split-View Editor
- **Slug:** mermaid-split-view
- **Status:** planned
- **Created:** 2025-11-29
- **Last updated:** 2025-11-29
- **Shipped:** _(pending)_

---

## 2. Context & Problem

**Current state:**
- Mermaid diagrams render beautifully, but users must toggle between code and rendered view
- Click the diagram → see code, click again → see render
- No simultaneous view of syntax and visual output

**Pain points:**
- **Learning curve:** Beginners can't see how syntax changes affect the diagram in real-time
- **Complex diagrams:** Users with intricate flowcharts/sequence diagrams need to switch views repeatedly to debug syntax
- **Workflow friction:** Constant toggling interrupts the writing flow, especially when fine-tuning layouts
- **Feature gap:** Side-by-side editing enhances the editing experience for complex documents with diagrams

**Why it matters:**
- **Reading/writing experience:** Diagrams are visual communication tools—seeing both code and output reduces cognitive load
- **User confidence:** Live preview shows syntax errors immediately, helping users learn Mermaid faster
- **Market differentiation:** Side-by-side editing is a valuable feature that enhances the editing experience for complex documents with diagrams

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Users can view Mermaid code and rendered diagram simultaneously while editing
- Split view updates in real-time as users type (with appropriate debouncing for performance)
- Mode persists across diagram instances (if user enables split view, stay in split view)
- Works seamlessly in both light and dark themes
- No performance degradation for large documents with multiple diagrams

**In scope:**
- Side-by-side layout (code left, render right) for Mermaid diagrams
- Toggle between split view and current click-to-toggle behavior
- Error display in render pane when syntax is invalid
- Resize splitter to adjust code/render ratio (nice-to-have, not blocking)

**Out of scope:**
- Live editing of rendered SVG elements (direct manipulation)
- Split view for code blocks (non-Mermaid)
- Collaborative cursor tracking in split mode
- Export functionality (separate feature)

---

## 4. UX & Behavior

**Entry points:**
- **Default mode:** Diagrams render in current toggle mode (backward compatible)
- **Split view activation:**
  - Click diagram → shows split view (code left, render right)
  - OR: New toolbar button "Split Diagram View" when cursor is in Mermaid block
  - OR: Command palette: "Markdown Editor for Humans: Toggle Diagram Split View"
  - OR: Keyboard shortcut: `Ctrl+Shift+D` (diagram split)

**User flows:**

### Flow 1: Creating a new diagram in split view
1. User types ` ```mermaid ` in the editor
2. Editor shows empty Mermaid block with placeholder
3. User clicks the block → split view appears (code left, render right)
4. User types `graph TD` in code pane
5. Render pane updates in real-time (~500ms debounce) showing rendered diagram
6. User continues editing, seeing live changes

### Flow 2: Editing existing diagram
1. User opens document with Mermaid diagram
2. Diagram renders in full view (current behavior)
3. User clicks diagram → split view appears
4. User edits syntax in left pane
5. Right pane updates with rendered output
6. User clicks outside diagram or presses `Esc` → returns to rendered view

### Flow 3: Handling syntax errors
1. User types invalid Mermaid syntax in code pane
2. Render pane shows friendly error message:
   - "Diagram Error: [error message]"
   - Link to Mermaid syntax guide
   - Option to view code only
3. User fixes syntax → render pane updates successfully

**Behavior rules:**
- **Performance:** Debounce rendering at 500ms to avoid excessive re-renders
- **Cursor preservation:** Editing in code pane doesn't reset cursor position
- **Theme sync:** Rendered diagram inherits VS Code theme (dark/light) automatically
- **Responsive layout:** Split view adjusts to editor width (min 400px per pane)
- **Accessibility:** Code pane fully keyboard-navigable, screen reader announces render updates

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

- Direct manipulation editing (drag nodes in rendered view, update code)
- Adjustable splitter with drag-to-resize
- Horizontal vs vertical split layout option
- Split view for other visualizations (KaTeX, charts)
