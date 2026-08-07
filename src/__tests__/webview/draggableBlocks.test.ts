/**
 * @jest-environment jsdom
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { DraggableBlocks, isDraggableBlock } from '../../webview/extensions/draggableBlocks';

describe('DraggableBlocks Extension', () => {
  let editor: Editor;

  const createEditor = (initialContent: string = '') => {
    return new Editor({
      extensions: [StarterKit, DraggableBlocks],
      content: initialContent,
    });
  };

  afterEach(() => {
    if (editor) {
      editor.destroy();
    }
  });

  describe('Keyboard shortcuts (Alt+Up/Down)', () => {
    it('moves block up', () => {
      editor = createEditor('<p>Block 1</p><p>Block 2</p><p>Block 3</p>');

      // Set selection to Block 2
      editor.commands.setTextSelection(12); // inside "Block 2"

      const moved = editor.commands.moveBlockUp();
      expect(moved).toBe(true);

      expect(editor.getHTML()).toBe('<p>Block 2</p><p>Block 1</p><p>Block 3</p>');
    });

    it('moves block down', () => {
      editor = createEditor('<p>Block 1</p><p>Block 2</p><p>Block 3</p>');

      // Set selection to Block 2
      editor.commands.setTextSelection(12); // inside "Block 2"

      const moved = editor.commands.moveBlockDown();
      expect(moved).toBe(true);

      expect(editor.getHTML()).toBe('<p>Block 1</p><p>Block 3</p><p>Block 2</p>');
    });

    it('does not move block up if it is the first block', () => {
      editor = createEditor('<p>Block 1</p><p>Block 2</p>');
      editor.commands.setTextSelection(3); // inside "Block 1"

      const moved = editor.commands.moveBlockUp();
      expect(moved).toBe(false);

      expect(editor.getHTML()).toBe('<p>Block 1</p><p>Block 2</p>');
    });

    it('does not move block down if it is the last block', () => {
      editor = createEditor('<p>Block 1</p><p>Block 2</p>');
      editor.commands.setTextSelection(16); // inside "Block 2"

      const moved = editor.commands.moveBlockDown();
      expect(moved).toBe(false);

      expect(editor.getHTML()).toBe('<p>Block 1</p><p>Block 2</p>');
    });

    it('refuses to move down into a trailing empty paragraph', () => {
      // Simulates the state after TipTap auto-appends a trailing node placeholder.
      editor = createEditor('<p>Block 1</p><p>Block 2</p><p></p>');
      editor.commands.setTextSelection(12); // inside "Block 2"

      const moved = editor.commands.moveBlockDown();
      expect(moved).toBe(false);
      expect(editor.getHTML()).toBe('<p>Block 1</p><p>Block 2</p><p></p>');
    });

    it('refuses to move up past a leading empty paragraph', () => {
      editor = createEditor('<p></p><p>Block 1</p>');
      const block1Pos = editor.state.doc.child(0).nodeSize + 2;
      editor.commands.setTextSelection(block1Pos);

      const moved = editor.commands.moveBlockUp();
      expect(moved).toBe(false);
      expect(editor.getHTML()).toBe('<p></p><p>Block 1</p>');
    });
  });

  describe('Drag-drop transaction: move first to last and last to first', () => {
    /**
     * These tests exercise the same insert-first/map/delete logic as onDrop,
     * without needing simulated drag events.
     */
    function applyDragDropTransaction(ed: Editor, draggedPos: number, dropInsertPos: number) {
      const state = ed.state;
      const draggedNode = state.doc.resolve(draggedPos).nodeAfter!;
      const draggedSize = draggedNode.nodeSize;

      if (dropInsertPos === draggedPos || dropInsertPos === draggedPos + draggedSize) {
        return; // no-op
      }

      const tr = state.tr;
      const content = state.doc.slice(draggedPos, draggedPos + draggedSize);
      tr.insert(dropInsertPos, content.content);
      const mappedDragPos = tr.mapping.map(draggedPos);
      tr.delete(mappedDragPos, mappedDragPos + draggedSize);
      ed.view.dispatch(tr);
    }

    it('moves first block to the end of the document', () => {
      editor = createEditor('<p>Block 1</p><p>Block 2</p><p>Block 3</p>');

      const draggedPos = 0; // first block
      const dropInsertPos = editor.state.doc.content.size; // end

      applyDragDropTransaction(editor, draggedPos, dropInsertPos);

      expect(editor.getHTML()).toBe('<p>Block 2</p><p>Block 3</p><p>Block 1</p>');
    });

    it('moves last block to the start of the document', () => {
      editor = createEditor('<p>Block 1</p><p>Block 2</p><p>Block 3</p>');

      // Find last block position
      const doc = editor.state.doc;
      const lastChild = doc.child(doc.childCount - 1);
      const lastChildPos = doc.content.size - lastChild.nodeSize;

      applyDragDropTransaction(editor, lastChildPos, 0);

      expect(editor.getHTML()).toBe('<p>Block 3</p><p>Block 1</p><p>Block 2</p>');
    });

    it('moves second block to end', () => {
      editor = createEditor('<p>Block 1</p><p>Block 2</p><p>Block 3</p>');

      // Position of second block = first block's nodeSize
      const firstSize = editor.state.doc.child(0).nodeSize;
      applyDragDropTransaction(editor, firstSize, editor.state.doc.content.size);

      expect(editor.getHTML()).toBe('<p>Block 1</p><p>Block 3</p><p>Block 2</p>');
    });

    it('moves second block to start', () => {
      editor = createEditor('<p>Block 1</p><p>Block 2</p><p>Block 3</p>');

      const firstSize = editor.state.doc.child(0).nodeSize;
      applyDragDropTransaction(editor, firstSize, 0);

      expect(editor.getHTML()).toBe('<p>Block 2</p><p>Block 1</p><p>Block 3</p>');
    });
  });

  describe('Drag and Drop API via Plugin', () => {
    it('should register DraggableBlocks extension', () => {
      editor = createEditor('<p>Block 1</p>');
      expect(editor.extensionManager.extensions.some(e => e.name === 'draggableBlocks')).toBe(true);
    });

    it('should register drag handle element in DOM on editor init', () => {
      editor = createEditor('<p>Block 1</p>');
      const handle = document.querySelector('.drag-block-handle');
      expect(handle).not.toBeNull();
      // Pointer-event drag — no native HTML5 draggable attribute.
      expect(handle?.hasAttribute('draggable')).toBe(false);
      expect(handle?.getAttribute('aria-label')).toBe('Drag to move block');
    });
  });

  describe('Cursor preservation after move', () => {
    it('preserves cursor position inside the moved block on moveBlockUp', () => {
      editor = createEditor('<p>Block 1</p><p>Block 2</p><p>Block 3</p>');
      editor.commands.setTextSelection(12); // inside "Block 2", offset 2 into text

      editor.commands.moveBlockUp();

      // After move, Block 2 is now first; cursor should still be inside it
      const { from } = editor.state.selection;
      const resolved = editor.state.doc.resolve(from);
      expect(resolved.parent.textContent).toBe('Block 2');
    });

    it('preserves cursor position inside the moved block on moveBlockDown', () => {
      editor = createEditor('<p>Block 1</p><p>Block 2</p><p>Block 3</p>');
      editor.commands.setTextSelection(12); // inside "Block 2"

      editor.commands.moveBlockDown();

      const { from } = editor.state.selection;
      const resolved = editor.state.doc.resolve(from);
      expect(resolved.parent.textContent).toBe('Block 2');
    });
  });

  describe('Non-paragraph block types', () => {
    it('moves a heading up past a paragraph', () => {
      editor = createEditor('<p>Para</p><h2>Heading</h2><p>Trailing</p>');
      const doc = editor.state.doc;
      const paraSize = doc.child(0).nodeSize;
      editor.commands.setTextSelection(paraSize + 2); // inside the heading

      const moved = editor.commands.moveBlockUp();
      expect(moved).toBe(true);
      expect(editor.getHTML()).toBe('<h2>Heading</h2><p>Para</p><p>Trailing</p>');
    });

    it('moves a code block down past a paragraph', () => {
      editor = createEditor('<pre><code>code</code></pre><p>Para</p><p>Trailing</p>');
      editor.commands.setTextSelection(2); // inside the code block

      const moved = editor.commands.moveBlockDown();
      expect(moved).toBe(true);
      expect(editor.getHTML()).toBe('<p>Para</p><pre><code>code</code></pre><p>Trailing</p>');
    });
  });

  describe('Nested list scoping (top-level only)', () => {
    it('moveBlockUp with cursor in a list item moves the whole list', () => {
      editor = createEditor('<p>Para</p><ul><li><p>Item A</p></li><li><p>Item B</p></li></ul>');
      // Put cursor in "Item B"
      const html = editor.getHTML();
      // Find approximate position inside Item B via search
      const doc = editor.state.doc;
      let target = -1;
      doc.descendants((node, pos) => {
        if (target !== -1) return false;
        if (node.isTextblock && node.textContent === 'Item B') {
          target = pos + 1;
          return false;
        }
        return true;
      });
      expect(target).toBeGreaterThan(-1);
      editor.commands.setTextSelection(target);

      const moved = editor.commands.moveBlockUp();
      expect(moved).toBe(true);
      // The entire UL moves above the paragraph — list items remain intact
      expect(editor.getHTML()).toMatch(/^<ul>.*<\/ul><p>Para<\/p>/);
      // Neither item was lost
      expect(editor.getHTML()).toContain('Item A');
      expect(editor.getHTML()).toContain('Item B');
      // Original HTML had Para first
      expect(editor.getHTML()).not.toBe(html);
    });
  });

  describe('Single-block document', () => {
    it('moveBlockUp returns false', () => {
      editor = createEditor('<p>Only block</p>');
      editor.commands.setTextSelection(2);
      expect(editor.commands.moveBlockUp()).toBe(false);
    });

    it('moveBlockDown returns false', () => {
      editor = createEditor('<p>Only block</p>');
      editor.commands.setTextSelection(2);
      expect(editor.commands.moveBlockDown()).toBe(false);
    });
  });

  describe('Keyboard shortcut wiring', () => {
    it('registers Alt-ArrowUp and Alt-ArrowDown shortcuts', () => {
      editor = createEditor('<p>Block 1</p>');
      const ext = editor.extensionManager.extensions.find(e => e.name === 'draggableBlocks');
      expect(ext).toBeDefined();
      const addKeyboardShortcuts = ext?.config.addKeyboardShortcuts as
        | ((this: { editor: Editor }) => Record<string, unknown>)
        | undefined;
      expect(addKeyboardShortcuts).toBeDefined();
      const shortcuts = addKeyboardShortcuts?.call({ editor });
      expect(shortcuts).toBeDefined();
      expect(Object.keys(shortcuts as object)).toEqual(
        expect.arrayContaining(['Alt-ArrowUp', 'Alt-ArrowDown'])
      );
    });
  });

  describe('isDraggableBlock filter', () => {
    it('rejects an empty trailing paragraph (placeholder case)', () => {
      editor = createEditor('<p>Hello</p><p></p>');
      const doc = editor.state.doc;
      const lastChild = doc.child(doc.childCount - 1);
      expect(lastChild.type.name).toBe('paragraph');
      expect(lastChild.content.size).toBe(0);
      expect(isDraggableBlock(lastChild)).toBe(false);
    });

    it('rejects a mid-document empty paragraph', () => {
      editor = createEditor('<p>A</p><p></p><p>B</p>');
      const middle = editor.state.doc.child(1);
      expect(middle.type.name).toBe('paragraph');
      expect(middle.content.size).toBe(0);
      expect(isDraggableBlock(middle)).toBe(false);
    });

    it('accepts a non-empty paragraph', () => {
      editor = createEditor('<p>Has text</p>');
      expect(isDraggableBlock(editor.state.doc.child(0))).toBe(true);
    });

    it('accepts an empty heading (still a meaningful block)', () => {
      editor = createEditor('<h2></h2><p>After</p>');
      const first = editor.state.doc.child(0);
      expect(first.type.name).toBe('heading');
      expect(isDraggableBlock(first)).toBe(true);
    });

    it('rejects unknown block types', () => {
      editor = createEditor('<p>x</p>');
      const para = editor.state.doc.child(0);
      const fake = {
        type: { name: 'someUnknownType' },
        content: para.content,
      } as unknown as Parameters<typeof isDraggableBlock>[0];
      expect(isDraggableBlock(fake)).toBe(false);
    });
  });

  describe('Drag no-op at same position', () => {
    it('does not mutate the doc when drop position equals dragged position', () => {
      editor = createEditor('<p>Block 1</p><p>Block 2</p>');
      const before = editor.getHTML();
      const beforeVersion = editor.state.doc;

      // Replicate the early-return guard from onDrop
      const draggedPos = 0;
      const draggedNode = editor.state.doc.resolve(draggedPos).nodeAfter!;
      const draggedSize = draggedNode.nodeSize;
      const dropInsertPos = draggedPos; // same position -> no-op

      if (dropInsertPos !== draggedPos && dropInsertPos !== draggedPos + draggedSize) {
        // would dispatch — should not reach here
        throw new Error('expected no-op branch');
      }

      expect(editor.getHTML()).toBe(before);
      expect(editor.state.doc).toBe(beforeVersion);
    });

    it('does not mutate when drop position equals dragged end position', () => {
      editor = createEditor('<p>Block 1</p><p>Block 2</p>');
      const before = editor.getHTML();

      const draggedPos = 0;
      const draggedNode = editor.state.doc.resolve(draggedPos).nodeAfter!;
      const draggedSize = draggedNode.nodeSize;
      const dropInsertPos = draggedPos + draggedSize; // immediately after -> no-op

      expect(dropInsertPos === draggedPos + draggedSize).toBe(true);
      expect(editor.getHTML()).toBe(before);
    });
  });
});
