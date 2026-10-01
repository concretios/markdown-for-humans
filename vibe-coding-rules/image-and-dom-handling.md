# Image & DOM Handling Guidelines

**Purpose:** Consolidated patterns for working with images, Enter/newline behavior, and DOM manipulation in our TipTap/ProseMirror editor.

**Load this guide when:** Working on images, Enter key handling, NodeViews, or Markdown serialization.

**Last updated:** 2025-12-13

---

## TL;DR (Quick Reference)

| Topic | Pattern | Anti-pattern |
|-------|---------|--------------|
| **Images** | `inline: true` with atomic behavior | Block-level images create phantom gaps |
| **Enter handling** | Return `true` to stop propagation | Only `preventDefault()` without `return true` |
| **Empty paragraphs** | Filter at serialization time | Delete during typing (causes cursor jumps) |
| **Type checking** | Duck-typing + `instanceof` fallback | Only `instanceof` (fails in tests) |
| **Content modification** | `replaceWith()` for atomic changes | `delete()` for complex structures |
| **Position calculation** | `$pos.index()` for child indices | `$pos.end(0)` (returns absolute pos, can overflow) |

---

## 1. Image Configuration

### Current Setup (Stable)

```typescript
// src/webview/extensions/customImage.ts
export const CustomImage = Image.extend({
  inline: true,      // Images live inside paragraphs
  atom: true,        // Treated as single unit for selection
  selectable: true,  // Can be selected as NodeSelection
  group: 'inline',   // Belongs to inline content group
});
```

### Why Inline Images?

| Approach | Behavior | Issue |
|----------|----------|-------|
| `inline: false` (default) | Each image is a block node | Creates phantom gaps between consecutive images |
| `inline: true` | Images live inside paragraphs | No gaps, provides clean flow for consecutive images |

**Key insight:** With `breaks: true` in Markdown config, consecutive image lines with trailing spaces (`![](img)  \n`) create hardBreaks between images. With block-level images, these become editable gaps. With inline images, they remain inside the same paragraph.

### NodeView Structure

```typescript
addNodeView() {
  return ({ node }) => {
    const wrapper = document.createElement('span');
    wrapper.className = 'image-wrapper';
    // ... image element ...
    return { dom: wrapper };
  };
}
```

**CSS requirements:**
```css
.markdown-image {
  margin: 0;              /* No margins on image itself */
  display: block;
}
.image-wrapper {
  display: inline-block;  /* Inline-block needed for proper image rendering behavior */
  margin: 0.25em 0;       /* Spacing between images */
}
```

---

## 2. Enter Key Handling

### Core Rules

1. **Return `true` to stop propagation** - `preventDefault()` alone doesn't stop ProseMirror handlers
2. **Scope handlers narrowly** - Don't break lists/structured blocks
3. **Check handler order** - Your extension must run before baseKeymap

### Correct Pattern

```typescript
addProseMirrorPlugins() {
  return [
    new Plugin({
      props: {
        handleKeyDown: (view, event) => {
          if (event.key !== 'Enter') return false;
          
          // Only handle specific context
          if (!shouldHandleEnter(view.state)) {
            return false;  // Let other handlers run
          }
          
          event.preventDefault();
          event.stopPropagation();
          
          // Do your thing
          performAction(view);
          
          return true;  // ← CRITICAL: stops other handlers
        },
      },
    }),
  ];
}
```

### What NOT to Do

```typescript
// ❌ WRONG: Only preventDefault, no return true
handleKeyDown: (view, event) => {
  event.preventDefault();
  // ... other handlers still run!
}

// ❌ WRONG: Global Enter override
Enter: () => {
  editor.commands.setHardBreak();
  return true;  // Breaks lists!
}
```

---

## 3. Empty Paragraph Handling

### The Problem

Pressing Enter after a heading creates an empty paragraph. When serialized:
```
heading → "\n\n" → empty paragraph → "\n\n" → content
```
Result: Triple blank lines.

### The Solution: Output-Time Normalization

**Do NOT delete empty paragraphs during typing** - causes cursor jumps.

**DO filter them at serialization:**

```typescript
// src/webview/extensions/markdownParagraph.ts
export const MarkdownParagraph = Paragraph.extend({
  renderMarkdown: (node, helpers, _ctx) => {
    const content = helpers.renderChildren(node.content || []);
    
    // Skip empty paragraphs
    if (!hasMeaningfulContent(node) && content.trim() === '') {
      return null;  // ← Skip this node in output
    }
    
    return content;
  },
});
```

**Helper function:**
```typescript
function isMeaningfulInlineNode(node: JSONContent): boolean {
  if (!node || typeof node.type !== 'string') return false;
  if (node.type === 'hardBreak' || node.type === 'hard_break') return false;
  if (node.type === 'text') {
    return (node.text?.trim().length ?? 0) > 0;
  }
  return true;  // Images, links, etc. are meaningful
}
```

---

## 4. Position Calculation

### Safe Patterns

```typescript
// Get position immediately after current block
const insertPos = $from.after($from.depth);

// Get child index (not offset)
const indexInParent = $from.index();

// Calculate position after a specific block
function getPositionAfterBlock(state: EditorState, blockIndex: number): number {
  let pos = 1;  // After doc opening
  for (let i = 0; i <= blockIndex && i < state.doc.childCount; i++) {
    pos += state.doc.child(i).nodeSize;
  }
  return pos;
}
```

### Dangerous Patterns

```typescript
// ❌ WRONG: $pos.end(0) returns absolute position, can be huge
const docPos = $pos.end(0);  // Could be 12691 for large paragraphs!

// ❌ WRONG: Using parentOffset for index-based operations
const offset = $from.parentOffset;  // This is byte offset, not index
```

---

## 5. Content Modification

### For Complex Structures: Rebuild, Don't Delete

When modifying paragraphs with images (schema constraints apply):

```typescript
// ❌ WRONG: Direct deletion can cause schema errors
state.tr.delete(from, to);  // "Invalid content for node paragraph"

// ✅ CORRECT: Rebuild content atomically
const children: ProseMirrorNode[] = [];
parent.forEach((node, _offset, index) => {
  if (index !== imageIndexToDelete) {
    children.push(node);
  }
});

const newContent = Fragment.from(children);
state.tr.replaceWith(contentStart, contentEnd, newContent);
```

### For Simple Insertions

```typescript
// Insert at document level
const tr = state.tr.insert(insertPos, paragraphType.create());

// Set cursor after insert
tr.setSelection(TextSelection.create(tr.doc, insertPos + 1));
view.dispatch(tr.scrollIntoView());
```

---

## 6. Type Checking (Test Compatibility)

### Problem: `instanceof` Fails in Tests

Multiple ProseMirror module copies in test environment cause `instanceof` to fail.

### Solution: Duck-Typing Fallback

```typescript
function isImageNode(selection: unknown, imageTypeName: string): selection is NodeSelection {
  // Try instanceof first
  if (selection instanceof NodeSelection) {
    return selection.node.type.name === imageTypeName;
  }
  // Duck-typing fallback
  const sel = selection as any;
  return sel?.node?.type?.name === imageTypeName;
}

function isGapCursorSelection(selection: unknown): selection is GapCursor {
  if (selection instanceof GapCursor) return true;
  const sel = selection as any;
  return sel?.constructor?.name === 'GapCursor' || sel?.type === 'gapcursor';
}

function isTextSelection(selection: unknown): selection is TextSelection {
  if (selection instanceof TextSelection) return true;
  const sel = selection as any;
  return (
    sel?.constructor?.name === 'TextSelection' ||
    (sel?.$from && sel?.$to && !sel?.node && sel?.empty !== undefined)
  );
}
```

---

## 7. Two-Step Delete Pattern

For destructive operations on images, use visual confirmation:

### Flow
1. **First press:** Select image, show red border (`image-pending-delete` class)
2. **Second press:** Delete the image
3. **Any other action:** Clear pending state

### Implementation

```typescript
// Plugin state tracks pending deletion
interface PluginState {
  pendingDeleteImagePos: number | null;
}

// First press: mark for deletion
if (pendingDeleteImagePos === null) {
  // Set pending state, add decoration
  return true;
}

// Second press: confirm delete
if (pendingDeleteImagePos === imagePos) {
  deleteImage(view, state, selection);
  return true;
}
```

### Clear State On

- Arrow keys, typing, Escape, Tab
- Mouse clicks, selection changes
- Any navigation

---

## 8. Common Pitfalls

### 1. Schema Validation Errors

**Symptom:** `Invalid content for node paragraph: <image>`

**Cause:** ProseMirror schema doesn't allow paragraphs with only images (in some configs).

**Fix:** Rebuild content atomically instead of using `split()`.

### 2. Cursor Jumping to Wrong Position

**Symptom:** After Enter, cursor ends up after a subsequent block (like GitHub alert).

**Cause:** Using document-level position calculation instead of relative.

**Fix:** Use `$from.after($from.depth)` for position immediately after current block.

### 3. Multiple Blank Lines in Output

**Symptom:** Extra newlines between blocks.

**Cause:** Empty paragraphs being serialized.

**Fix:** Filter empty paragraphs in `renderMarkdown` by returning `null`.

### 4. Tests Pass but Production Fails (or vice versa)

**Symptom:** `instanceof` checks behave differently.

**Cause:** Module bundling creates multiple copies of ProseMirror classes.

**Fix:** Use duck-typing fallback for all type checks.

---

## 9. Testing Guidelines

### Document Structure for Tests

Replicate real-world markdown with multiple images:

```typescript
// Create 4-image paragraph structure
const realWorldDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'image', attrs: { src: './1.png' } },
        { type: 'hardBreak' },
        { type: 'image', attrs: { src: './2.png' } },
        { type: 'hardBreak' },
        { type: 'image', attrs: { src: './3.png' } },
        { type: 'hardBreak' },
        { type: 'image', attrs: { src: './4.png' } },
      ],
    },
    { type: 'blockquote', content: [...] },
  ],
};
```

### Test Fixtures

Use `src/__tests__/fixtures/epicReaderFriendly.ts` as canonical fixture for image/Enter tests.

---

## 10. File Reference

| File | Purpose |
|------|---------|
| `src/webview/extensions/customImage.ts` | Image extension with inline config |
| `src/webview/extensions/imageEnterSpacing.ts` | Enter/Backspace/Delete handling |
| `src/webview/extensions/markdownParagraph.ts` | Empty paragraph filtering |
| `src/webview/utils/markdownSerialization.ts` | Pre-serialize JSON normalization |
| `src/webview/editor.css` | Image wrapper and pending-delete styles |
| `src/__tests__/webview/imageEnterSpacing.test.ts` | Comprehensive test suite |

---


## 11. SVG rendering and display dimensions

Keep SVG in an `<img>` resource context. Never inject SVG markup into the editor DOM. After decode, `CustomImage` gives unsized images a DOM-only natural width to prevent `fit-content` and `max-width: 100%` from collapsing viewBox-only SVGs. This fallback is not written to image node attributes. Authored width/height are validated and applied separately. Error and rejected-resolution states retain the authored destination and ignore late results after disposal.

`htmlImageSource.ts` handles supported HTML `<img>` tokens, retains their exact original source while unchanged, and serializes deliberate dimension changes with escaped attributes. Block image tokens must remain paragraphs; inline images in lists/tables must stay inline. `MarkdownParagraph` overrides the upstream single-image unwrapping because this editor uses inline images; otherwise blank-line-separated image paragraphs merge during schema repair. Raw HTML equivalence remains strict, including Feedback mapping. Sized image round-trip tests must use production paragraph/list/table extensions.

Local SVGs use `svgDisplaySize.ts`. Size changes are document transactions, not file writes. Apply, reset, undo, read-only locks, stale nodes and focus disposal require coverage. The raster resize/redo host boundaries reject SVG by path or bounded original-file signature before any backup/write. Legitimate original backup restoration is still supported.

The shared paragraph renderer uses a backslash hard break after a leading sized HTML image when more Markdown follows. A two-space break at that boundary starts a CommonMark HTML block and makes the following Markdown literal. Keep authored HTML blocks unchanged, and preserve leading image indentation in the sync serializer so image-only indented blocks retain their existing parser path.

Imports validate SVG XML and preserve exact bytes, including valid `.svg` files with absent/generic MIME. They bypass the huge-image raster dialog and canvas conversion while keeping pending-image capacity/ACK rules. Local paths are split from query/fragment before decoding through `shared/imageSource.ts`; resolve/reveal/metadata/rename must agree on file identity. For legacy destinations containing raw `#` or `?`, host normalization prefers the complete decoded path when that file exists. Rename also preserves the known original identity after the file has moved. Otherwise the authored query/fragment remains a URL suffix.

Rename updates exact Markdown and HTML image source spans through `imageSourceReferences.ts` and the document edit queue. Its scanner indexes bracket matches and quoted HTML tag endings once and uses only markdown-it block parsing, avoiding repeated suffix searches for malformed openers. Keep the 280/560 KB malformed-input work budgets and renderer/scanner parity tests. After a successful file move, reference failures are isolated per document: report success for the rename, continue other updates, and warn with the files requiring manual repair.

Block-only parsing bypasses markdown-it's core newline normalization. Normalize CRLF and CR to LF only in the parser input, and map token line numbers to the original source using all three line endings. Scan and replace the original text so rename preserves authored line endings and exact destination spans. Keep regressions for standalone space-containing paths and mixed indented code after prose; CRLF blank lines must separate these blocks just as LF blank lines do.

Generated destinations must encode each filesystem path segment exactly once with `encodeImageFilePath`, including literal `#`, `?`, and `%` in filenames or directories. Do not apply this encoder to authored URLs: their query/fragment remains a real suffix. Preview and Document Audit consume the same decoded file identity. Rename scanning includes the renderer's standalone space-containing paths and image-only indented blocks, while excluding tight-list literals, mixed prose/code, escaped examples and comments. Keep renderer/scanner parity tests when changing either grammar.

Run `npm run test:svg-browser` for real Chromium geometry, Display size, themes, narrow layouts, high DPI and Feedback capture. Jest alone cannot prove that a decoded SVG occupies space. Keep private documents outside the repository and use synthetic fixtures in tests.

Export (PDF and Word) first passes every local image destination through the preview's containment resolver (`resolveContainedImageSource`). A contained file becomes a segment-encoded URL relative to the document base; a refused one loses `src`. An `http:` image, in any letter case, loses `src` too, because the preview CSP (`img-src` webview resources, `https:`, `data:`, `blob:`) refuses it; `https:`, `data:` and `blob:` sources pass through unchanged. Chrome never resolves the authored string, because its URL parser treats `\`, tabs and `//host` differently from Node paths (#101). The resolver also compares real paths for existing files, so a committed symlink cannot point outside the allowed roots. Local and `http:` loads outside `img` (CSS `url()`, `image-set()`, `@import`, SVG `href`, table `background`) are dropped, since the preview never resolves them to files and its CSP refuses `http:`. Only CSS contexts are scanned for CSS loads (`style`, `<style>`, `url()` presentation attributes, SMIL values), so a `url(` in `src`, `alt`, `title` or a link `href` stays. Print with an incognito profile under the temporary export directory, then remove that directory after process exit. Browser regression acceptance requires the expected SVG drawing, a natural successful Chrome exit, and the completed export notification. Terminating Chrome after a PDF appears is a test failure, not successful command completion.

### Image paste event ordering

The image paste listener runs in capture phase so supported image payloads are
claimed before ProseMirror schedules its native paste fallback and delayed focus.
Ordinary text/HTML payloads pass through to the existing paste pipeline. Dispose
the capture listener with its editor. The SVG import regressions cover both image
claiming and ordinary text paste.

Consult the live Feedback owner/peer editing lock before paste or drop side effects.
Capture listener registration order cannot enforce that lock because image setup
can run before the Feedback guards. Keep the host mutation guards as well.

Saved-image replacement and failed-preview deletion use `addToHistory: false` so
undo/redo cannot resurrect transient data URLs or stale placeholder IDs. A failed
host save may use a fallback only when the complete serialized data URI is at most
256 KiB. Check the encoded size before allocating base64; larger failures reject
the pending document edit visibly and release the transfer buffer.
