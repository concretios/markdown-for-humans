---
name: Fix Enter key at gap cursor before image
overview: Fix Enter key behavior when gap cursor is positioned to the left of an inline image (after ArrowLeft navigation). Currently inserts paragraph to the right of image instead of left. Add tests to verify correct behavior.
todos:
  - id: fix-gap-cursor-enter
    content: Fix gap cursor Enter handler in imageEnterSpacing.ts to calculate correct document-level position based on containing block
    status: completed
  - id: add-test-gap-before
    content: "Add test: Gap cursor before inline image + Enter inserts paragraph before containing block"
    status: completed
    dependencies:
      - fix-gap-cursor-enter
  - id: add-test-gap-after
    content: "Add test: Gap cursor after inline image + Enter inserts paragraph after containing block"
    status: completed
    dependencies:
      - fix-gap-cursor-enter
  - id: add-test-arrow-left-enter
    content: "Add integration test: ArrowLeft on selected image → Enter inserts paragraph before image"
    status: completed
    dependencies:
      - fix-gap-cursor-enter
  - id: add-test-arrow-right-enter
    content: "Add integration test: ArrowRight on selected image → Enter inserts paragraph after image"
    status: completed
    dependencies:
      - fix-gap-cursor-enter
  - id: verify-all-tests
    content: Run npm test to verify all tests pass (existing + new)
    status: completed
    dependencies:
      - add-test-gap-before
      - add-test-gap-after
      - add-test-arrow-left-enter
      - add-test-arrow-right-enter
---

# Fix Enter Key at Gap Cursor Before Image

## Problem

When navigating with arrow keys on a selected image:

1. ArrowLeft moves gap cursor to `selection.from` (before the image, inside the paragraph)
2. Pressing Enter uses `selection.head` directly as insertion position
3. Since `selection.head` is inside a paragraph (not at document-level boundary), `insertParagraphAtDocPos` inserts at wrong position (to the right of image instead of left)

## Root Cause

In [`src/webview/extensions/imageEnterSpacing.ts`](src/webview/extensions/imageEnterSpacing.ts) lines 734-760, the gap cursor Enter handler uses `selection.head` directly without considering:

- Gap cursor position is inside a paragraph (for inline images)
- Need to find the containing block and insert at document-level boundary
- Direction matters: before image = insert before block, after image = insert after block

## Solution

Modify the gap cursor Enter handler to:

1. Detect if gap cursor is before or after an image (`imageAfter` vs `imageBefore`)
2. Find the containing block (paragraph) of the image
3. Calculate correct document-level insertion position:

- If `imageAfter` (cursor before image): insert paragraph BEFORE containing block
- If `imageBefore` (cursor after image): insert paragraph AFTER containing block

## Implementation

### 1. Fix Gap Cursor Enter Handler

**File**: [`src/webview/extensions/imageEnterSpacing.ts`](src/webview/extensions/imageEnterSpacing.ts)**Location**: Lines 734-760 (gap cursor Enter handling)**Changes**:

- Replace direct use of `selection.head` with calculated document-level position
- Use `$from.depth` and `$from.index()` to find containing block
- Use `getPositionAfterBlock()` to calculate insertion position based on block index
- Handle both `imageBefore` and `imageAfter` cases correctly

**Key logic**:

```typescript
if (isGapCursorSelection(selection)) {
  const imageBefore = selection.$from.nodeBefore?.type.name === imageType.name;
  const imageAfter = selection.$from.nodeAfter?.type.name === imageType.name;

  if (imageBefore || imageAfter) {
    const $pos = selection.$from;
    let insertPos: number;
    
    // Find the containing block (paragraph) of the image
    // For inline images, we need to go up to the block level
    let blockDepth = $pos.depth;
    let blockNode = $pos.node(blockDepth);
    
    // If we're inside a paragraph, find the document-level block index
    if (blockNode.type.name === 'paragraph' && blockDepth > 0) {
      blockDepth = blockDepth - 1;
      blockNode = $pos.node(blockDepth);
    }
    
    const blockIndex = $pos.index(blockDepth);
    
    if (imageAfter) {
      // Gap cursor is BEFORE image - insert paragraph BEFORE containing block
      insertPos = getPositionAfterBlock(state, blockIndex - 1);
    } else {
      // Gap cursor is AFTER image - insert paragraph AFTER containing block
      insertPos = getPositionAfterBlock(state, blockIndex);
    }

    if (!canInsertParagraphAtDocPos(state, insertPos)) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    return insertParagraphAtDocPos(view, state, insertPos);
  }
}
```



### 2. Add Test Cases

**File**: [`src/__tests__/webview/imageEnterSpacing.test.ts`](src/__tests__/webview/imageEnterSpacing.test.ts)**New tests needed**:

1. **Gap cursor before inline image + Enter**:

- Create document with paragraph containing inline image
- Position gap cursor before image (via ArrowLeft simulation)
- Press Enter
- Verify paragraph inserted BEFORE the containing paragraph block
- Verify cursor positioned in new paragraph

2. **Gap cursor after inline image + Enter**:

- Create document with paragraph containing inline image
- Position gap cursor after image (via ArrowRight simulation)
- Press Enter
- Verify paragraph inserted AFTER the containing paragraph block
- Verify cursor positioned in new paragraph

3. **Gap cursor before image in multi-image paragraph**:

- Create paragraph with multiple inline images
- Position gap cursor before first image
- Press Enter
- Verify paragraph inserted before the paragraph block (not between images)

4. **Gap cursor after image in multi-image paragraph**:

- Create paragraph with multiple inline images
- Position gap cursor after last image
- Press Enter
- Verify paragraph inserted after the paragraph block

5. **Integration: ArrowLeft → Enter flow**:

- Select an inline image (NodeSelection)
- Simulate ArrowLeft (moves to gap cursor before image)
- Simulate Enter
- Verify paragraph inserted before containing block

6. **Integration: ArrowRight → Enter flow**:

- Select an inline image (NodeSelection)
- Simulate ArrowRight (moves to gap cursor after image)
- Simulate Enter
- Verify paragraph inserted after containing block

### 3. Audit Existing Tests

**Review existing tests** for coverage:

- ✅ `inserts paragraph at a gap cursor beside an image` (line 177) - Tests block-level images, not inline
- ✅ `does not intercept Enter if gap cursor position is inside a paragraph` (line 125) - Tests invalid position, but doesn't test the fix
- ❌ **Missing**: Gap cursor before inline image + Enter
- ❌ **Missing**: Gap cursor after inline image + Enter
- ❌ **Missing**: ArrowLeft → Enter integration test
- ❌ **Missing**: ArrowRight → Enter integration test

**Action**: Add the missing test cases above.

## Testing Strategy

1. **Unit tests**: Add new test cases to `imageEnterSpacing.test.ts`
2. **Manual verification**:

- Select an inline image
- Press ArrowLeft (cursor moves to left of image)
- Press Enter
- Verify: New paragraph appears ABOVE the image
- Press ArrowRight (cursor moves to right of image)
- Press Enter
- Verify: New paragraph appears BELOW the image

## Files to Modify

1. [`src/webview/extensions/imageEnterSpacing.ts`](src/webview/extensions/imageEnterSpacing.ts) - Fix gap cursor Enter handler
2. [`src/__tests__/webview/imageEnterSpacing.test.ts`](src/__tests__/webview/imageEnterSpacing.test.ts) - Add test cases

## Success Criteria

- [x] Gap cursor before inline image + Enter inserts paragraph before containing block
- [x] Gap cursor after inline image + Enter inserts paragraph after containing block
- [x] ArrowLeft → Enter flow works correctly
- [x] ArrowRight → Enter flow works correctly
- [x] All existing tests pass

## Follow-up (2026-10-01)

The original ship marked this plan completed, but the live Enter handler still used
`selection.head` and failed `canInsertParagraphAtDocPos` for inline images. The
document-level before/after mapping (and direction-aware text-caret fallback) was
re-applied with dedicated regression tests in `imageEnterSpacing.test.ts`.
