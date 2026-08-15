# Task: Mermaid diagram lightbox (zoom & pan)

## 1. Task Metadata

- **Task name:** Mermaid diagram lightbox (zoom & pan)
- **Slug:** mermaid-lightbox
- **Status:** shipped
- **Created:** 2026-08-15
- **Last updated:** 2026-08-15
- **Shipped:** 2026-08-15

---

## 2. Context & Problem

**Current state:**
- Rendered Mermaid diagrams are sized to the editor column (`.mermaid-render svg { max-width: 100% }`) with no way to inspect them closer.
- Single click highlights the node; double click opens the code editor. Neither reveals detail.

**Pain points:**
- **Dense diagrams are unreadable:** a wide flowchart or sequence diagram shrinks to fit the column, and node labels become too small to read.
- **No way to inspect a region:** users cannot magnify one part of a large diagram while keeping their place in the document.
- **Editing to read is wrong:** the only current escape is opening the code modal and reading the source, which is not the same as reading the picture.

**Why it matters:**
- Diagrams are a primary reason to use Mermaid in a WYSIWYG editor; if they can't be read, the feature is decorative.
- Every diagramming tool (draw.io, Excalidraw, GitHub's own Mermaid renderer) offers zoom and pan. Its absence reads as missing, not minimal.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- A rendered diagram can be opened in a viewer that fills the editor pane, fitted and centred on open.
- Zoom works via wheel, on-screen buttons, and keyboard; pan works by dragging.
- The diagram stays sharp at high zoom (vector re-render, not an upscaled bitmap).
- Zoom and pan are view-only: the Markdown document is never modified.
- No regression to existing single-click highlight or double-click edit behaviour.

**In scope:**
- Hover-revealed magnifier button on rendered diagrams.
- Full-pane viewer with zoom, pan, fit, and close.
- Keyboard support and focus management for the viewer.
- Error and empty states hide the button.

**Out of scope:**
- Inline zoom/pan on the diagram in the document flow (viewer only).
- Export of the zoomed view.
- Pinch-to-zoom / touch gestures.
- Persisting zoom level between openings.

---

## 4. UX & Behavior

**Entry points:**
- Magnifier button in the top-right corner of a rendered diagram, revealed on hover or keyboard focus.

**User flows:**

### Flow 1: Read a dense diagram
1. User hovers a rendered diagram; the magnifier appears.
2. User clicks it; the viewer opens fitted to the pane.
3. User scrolls to zoom in on a region and drags to pan around it.
4. User presses `Esc`; the viewer closes and the document is unchanged.

### Flow 2: Keyboard-only
1. User tabs to the magnifier button (a visible focus ring appears) and presses Enter.
2. Focus moves into the viewer; `+`/`-` zoom, `0` re-fits, Tab cycles the controls without leaving the dialog.
3. `Esc` closes and focus returns to the magnifier button.

**Behavior rules:**
- Single click and double click on the diagram keep their existing meanings; the button suppresses `mousedown`, `click`, and `dblclick` so it triggers neither.
- Clicking empty space beside the diagram dismisses the viewer; clicking the diagram or the controls does not.
- A drag that ends over empty space does not dismiss the viewer.
- Scale is clamped to 10%–1000%.
- The button is hidden when the diagram is empty or failed to render.
- A failure to load the viewer module is logged, not surfaced — the diagram stays readable inline.

---

## 5. Technical Plan

**Surfaces:**
- Webview only. No extension-host changes, no message protocol changes.

**Key changes:**
- `src/webview/features/mermaidLightbox.ts` – new; the viewer, its zoom/pan state, and focus management.
- `src/webview/extensions/mermaid.ts` – adds the magnifier button to the NodeView and wires it to a dynamic import of the viewer.
- `src/webview/editor.css` – button styles inside the `.markdown-editor` scope; viewer styles at top level.
- `src/__tests__/webview/mermaid-lightbox.test.ts` – new; viewer behaviour.
- `src/__tests__/webview/mermaid-zoom-button.test.ts` – new; NodeView button behaviour against a real TipTap editor.

**Architecture notes:**
- Zoom/pan state lives in the `showMermaidLightbox` closure and is never serialised, so the document cannot be dirtied by viewing.
- The viewer is loaded via dynamic `import()` so it costs nothing until first use. esbuild inlines it into the single webview bundle.
- Viewer styles sit **outside** the `.markdown-editor` nesting block because the overlay mounts on `document.body`.
- The overlay is `position: fixed` within the webview iframe, so it covers the editor pane rather than the whole VS Code window. This is a platform limit, not a choice.

**Performance considerations:**
- No `will-change` on the transformed element. It promotes the layer to a fixed-size raster and makes zoom render an upscaled bitmap instead of re-rendering the SVG.

---

## 6. Work Breakdown

- [x] **Phase 1: Viewer** - standalone `showMermaidLightbox`
  - [x] Open/close: Escape, close button, click on empty space
  - [x] Zoom: wheel, buttons, keyboard, clamping, fit-on-open
  - [x] Pan: drag with accumulation, plus the drag-vs-dismiss guard
  - [x] Focus: move in on open, trap Tab, restore to opener on close
- [x] **Phase 2: NodeView integration**
  - [x] Hover-revealed button with a focus ring
  - [x] Event suppression so it never selects or edits the node
  - [x] Hidden on empty and error states
  - [x] Error handling around the dynamic import
- [x] **Testing**
  - [x] 31 unit tests for the viewer (jsdom)
  - [x] 6 tests for the NodeView button against a real TipTap editor
  - [x] End-to-end verification driving real VS Code with the packaged VSIX
  - [x] QA manual updated (§5.10)

---

## 7. Implementation Log

### 2026-08-15 – Built and shipped

- **What:** Full feature, TDD throughout — four red/green cycles for the viewer, one for the NodeView button.
- **Files:** `mermaidLightbox.ts` (new), `mermaid.ts`, `editor.css`, two new test files.
- **Notes:** Two bugs surfaced only because tests forced the drag-vs-click question: an early version closed the viewer when the zoom buttons were clicked, and again whenever a pan gesture ended over empty space.

### 2026-08-15 – Blurry zoom, root-caused and fixed

- **What:** Zooming past ~200% produced a soft, upscaled image.
- **Files:** `editor.css`.
- **Notes:** Cause was `will-change: transform` on `.mermaid-lightbox-canvas`. It promotes the element to a compositor layer rasterised once at its natural size (281px here), which the GPU then scaled to 2016px at 716% zoom. Isolated by comparing three variants at identical zoom in a real window: as-shipped (blurry), `will-change` removed (sharp), and SVG re-layout in pixels (sharp). Removing the hint was the smaller of the two fixes and equally sharp, so the transform approach stayed.

### 2026-08-15 – Self-review against `vibe-coding-rules/`

- **What:** Audit found four gaps; all closed.
- **Files:** `mermaidLightbox.ts`, `mermaid.ts`, `editor.css`, `docs/QA_MANUAL.md`, this plan.
- **Notes:** Missing `try/catch` on the async click handler; no focus ring on the magnifier button; `aria-modal="true"` set without any real focus management behind it; no plan file or QA steps.

---

## 8. Decisions & Tradeoffs

- **Viewer over inline zoom:** inline zoom would have to fight the NodeView's existing `mousedown`/`click`/`dblclick` handlers, the draggable-block handle, and page scroll. The viewer sidesteps all four, and the transform code can be reused if inline zoom is wanted later.
- **New hover button over rebinding double click:** double click already opens the code editor and is shipped behaviour (`task-mermaid-double-click-edit`). Changing it would break existing muscle memory.
- **CSS transform over SVG re-layout:** both render equally sharp once `will-change` is gone. The transform version is smaller and already tested.
- **Dropped the double-click fit/100% toggle:** for any diagram that already fits, the two states are identical, so the toggle would usually do nothing. The fit button and `0` cover the need.
- **Dismiss on empty space, not "backdrop":** the viewport fills the overlay, so there is effectively no backdrop to click.

---

## 9. Follow-up & Future Work

- Inline zoom/pan on the diagram in the document flow, reusing the transform logic here.
- `task-p0-mermaid-split-view` rebuilds this NodeView; the button and its event suppression will need re-wiring.
- Rename the button's label — it says "Open diagram in full screen", but a webview overlay can only cover the editor pane.
- Rapid repeated zooming can show brief softness mid-gesture while Chromium re-rasterises. Sizing the SVG in pixels instead of transforming it would remove this entirely.
- `.mermaid-preview-btn` in `editor.css` is dead: nothing renders it, only a test fixture references it.
