# Implementing Word-Processor Features with Native Markdown

This document outlines the guidelines and approach for extending the Markdown for Humans editor to support "quality word processor" features while maintaining strict native Markdown compatibility. 

## Philosophy
Every new feature should have a graceful degradation path. The raw `.md` file must remain perfectly readable and parseable by standard tooling. If a visual feature (like yellow highlighting) is added, it must serialize into common markdown conventions or safe HTML tags that other markdown renderers can parse or strip safely.

---

## Example 1: Multi-Level Lists Inside Tables

**The Goal:**
Tables in standard markdown do not easily support complex blocks like nested multi-level lists. We want to enable this using varying bullet styles to denote levels.

```markdown
| Feature | Details |
| :--- | :--- |
| Advanced Lists | - Level 1<br>  + Level 2<br>    * Level 3 |
```

**Implementation Guideline:**
1. **TipTap Extension:** Enhance the `@tiptap/extension-table` and `@tiptap/extension-list` to allow lists within table cells (which is natively restrictive in standard GFM). 
2. **Markdown Parsing (`editor.ts`):** Configure the markdown parser to recognize the indentation and different bullet characters (`-`, `+`, `*`) as nested lists even inside table cell contexts.
3. **Serialization (`markdownSerialization.ts`):** 
   - Write custom serialization logic to convert TipTap's nested list JSON inside a table cell into flat `<br>` separated text nodes with non-breaking spaces `&nbsp;&nbsp;` or raw spaces to simulate indentation. Standard markdown parsers will choke on raw list tokens inside tables, so we must serialize them visually using HTML/spacing.

---

## Example 2: Obsidian-Style Highlights (`==highlight==`)

**The Goal:**
Users can type `==important text==` and it renders with a yellow highlight background in the editor.

**Implementation Guideline:**
1. **TipTap Extension:** Install and register `@tiptap/extension-highlight`. 
2. **Markdown Parser Options:** Configure the markdown parser (in `editor.ts`) to recognize the `==` token. If using `marked`, you may need a custom tokenizer for the `==` spans.
3. **Serialization:** 
   - Serialize the highlighted text either perfectly back to `==important text==` (if using an extended parser) or to `<mark>important text</mark>` for universal HTML-in-Markdown compatibility.
4. **Styling (`editor.css`):**
   ```css
   .markdown-editor mark {
     background-color: var(--md-focus, rgba(255, 235, 59, 0.4));
     color: inherit;
     border-radius: 2px;
     padding: 0 2px;
   }
   ```

---

## Other Planned Quality-of-Life (QoL) Examples

To bridge the gap between markdown and a professional word processor, we can apply similar workflows to these features:

### 3. Footnotes
**Goal:** Add reference footnotes like `[^1]` in the text and a list of definitions at the bottom.
**How to Build:**
- Implement `@tiptap/extension-superscript` or a custom TipTap node for Footnotes.
- Parse `[^ID]` tokens into footnote links.
- Render a protected bottom-section widget for footnote definitions (`[^ID]: The explanation.`).

### 4. Subscript and Superscript
**Goal:** Render `~subscript~` and `^superscript^` natively (useful for math or chemistry).
**How to Build:**
- Register `@tiptap/extension-subscript` and `@tiptap/extension-superscript`.
- Modify serialization to preserve `~` and `^` wraparound markers instead of HTML `<sub>` `/` `<sup>` if possible, though HTML is strongly universally supported in markdown.

### 5. Text Alignment Modifiers
**Goal:** Allow users to center or right-align paragraphs. 
**How to Build:**
- Implement `@tiptap/extension-text-align`.
- **Serialization:** Since Markdown has no generic alignment syntax, serialize using wrapping HTML: `<div align="center">...</div>` or `<p style="text-align: center;">...</p>`, which renders gracefully in GitHub and VS Code.

### 6. Keyboard Shortcuts `<kbd>`
**Goal:** Make `Ctrl+C` look like physical keycaps.
**How to Build:**
- Create a custom inline TipTap extension mapping `[[Ctrl+C]]` or a similar markdown extension into `<kbd>` blocks. 
- Apply standard Apple/VSCode keycap CSS styles in `editor.css`.

### 7. Explicit Page Breaks (Print / PDF)
**Goal:** Allow users to force a page break for PDF exports mapping to `page-break-after: always`.
**How to Build:**
- Add a custom block extension triggered by a slash command `/pagebreak` or parsing `***page-break***` or `<!-- pagebreak -->`.
- When printing or exporting to PDF, inject a `<div style="page-break-after: always;"></div>`.

### 8. Collapsible Sections (Details / Summary)
**Goal:** Natively render HTML `<details>` and `<summary>` blocks for large expandable documentation sections.
**How to Build:**
- Build a custom TipTap node that renders a toggleable triangle widget. 
- Serialize directly back into the literal HTML `<details>` and `<summary>` tags in the Markdown source file, allowing safe degradation in GitHub.

---

## Summary Workflow for Adding QoL Word-Processor Features:
1. **Define the Syntax:** Pick what the raw Markdown will look like. Prioritize standard Markdown, GFM, or HTML tags that natively degrade well everywhere.
2. **Build TipTap Node/Mark:** Create or import the Prosemirror extension to render it gracefully in the visual editor.
3. **Parse from Markdown:** Ensure `markdown-it` / `marked` configuration respects the new tokens from `.md` to TipTap JSON.
4. **Serialize to Markdown:** Ensure `markdownSerialization.ts` writes the node back to strictly valid Markdown without corrupting surrounding elements.
5. **Style:** Inject beautiful, VS Code-themed CSS into `editor.css`.
