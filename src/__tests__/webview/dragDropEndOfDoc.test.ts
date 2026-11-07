/** @jest-environment jsdom */

/**
 * Regression tests for two drag-and-drop bugs:
 *
 *   1. Dropping any block at "below the document" used to land it AFTER the
 *      auto-appended trailing empty paragraph; on serialization the trailing
 *      empties were stripped only if they were truly trailing, so the now-
 *      mid-document empty paragraph emitted a phantom blank line in the
 *      saved markdown.
 *
 *   2. (Covered separately by the auto-scroll re-evaluation; not exercised
 *      here because jsdom doesn't simulate scroll/auto-scroll meaningfully.)
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { ListKit } from '@tiptap/extension-list';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { BlankLinePreservation } from '../../webview/extensions/blankLinePreservation';
import { DraggableBlocks } from '../../webview/extensions/draggableBlocks';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

function createRealEditor(initialMarkdown: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        paragraph: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        undoRedo: { depth: 100 },
      }),
      MarkdownParagraph,
      BlankLinePreservation,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      ListKit.configure({ listItem: false, orderedList: false, taskItem: { nested: true } }),
      MarkdownListItem,
      OrderedListMarkdownFix,
      DraggableBlocks,
    ],
    content: '',
    contentType: 'markdown',
  });
  const markdownStorage = editor as unknown as {
    markdown?: { instance?: unknown };
    storage?: { markdown?: { instance?: unknown } };
  };
  const markedInstance =
    markdownStorage.markdown?.instance ?? markdownStorage.storage?.markdown?.instance;
  if (markedInstance) installBlankLineLexerNormalizer(markedInstance);
  if (initialMarkdown) {
    editor.commands.setContent(initialMarkdown, { contentType: 'markdown' });
  }
  return editor;
}

/**
 * Mirror what computeDropTarget does for "drop at end of document": pass
 * `doc.content.size`. The fixed validate() clamps this to the position
 * before any trailing empty paragraphs.
 */
function applyDropAtEnd(editor: Editor, draggedPos: number): boolean {
  const state = editor.state;
  const draggedNode = state.doc.resolve(draggedPos).nodeAfter;
  if (!draggedNode) return false;
  const draggedSize = draggedNode.nodeSize;

  // Find the position before any trailing empty paragraphs — same logic as
  // lastInsertablePos() inside the extension.
  let endPos = state.doc.content.size;
  for (let i = state.doc.childCount - 1; i >= 0; i--) {
    const child = state.doc.child(i);
    if (child.type.name === 'paragraph' && child.content.size === 0) {
      endPos -= child.nodeSize;
    } else {
      break;
    }
  }

  if (endPos === draggedPos || endPos === draggedPos + draggedSize) return false;
  const tr = state.tr;
  const content = state.doc.slice(draggedPos, draggedPos + draggedSize);
  tr.insert(endPos, content.content);
  const mappedDragPos = tr.mapping.map(draggedPos);
  tr.delete(mappedDragPos, mappedDragPos + draggedSize);
  editor.view.dispatch(tr);
  return true;
}

function firstNonEmptyChildPos(editor: Editor, name: string): number {
  let pos = 0;
  const doc = editor.state.doc;
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    if (child.type.name === name && child.content.size > 0) return pos;
    pos += child.nodeSize;
  }
  return -1;
}

describe('drop-at-end serialization (issue 1)', () => {
  it('heading dropped at end after a paragraph emits no phantom blank line', () => {
    const editor = createRealEditor('# A\n\n# B\n\nText\n');
    const draggedPos = firstNonEmptyChildPos(editor, 'heading');
    applyDropAtEnd(editor, draggedPos);
    const md = getEditorMarkdownForSync(editor);
    expect(md).toBe('# B\n\nText\n\n# A');
    editor.destroy();
  });

  it('paragraph dropped at end after a heading emits no phantom blank line', () => {
    const editor = createRealEditor('Para A\n\nPara B\n\n# H\n');
    const draggedPos = firstNonEmptyChildPos(editor, 'paragraph');
    applyDropAtEnd(editor, draggedPos);
    const md = getEditorMarkdownForSync(editor);
    expect(md).toBe('Para B\n\n# H\n\nPara A');
    editor.destroy();
  });

  it('heading dropped at end of doc whose last block is a heading', () => {
    const editor = createRealEditor('Text\n\n# A\n\n# B\n');
    // Drag heading "A" to the end.
    let draggedPos = -1;
    let pos = 0;
    const doc = editor.state.doc;
    for (let i = 0; i < doc.childCount; i++) {
      const child = doc.child(i);
      if (child.type.name === 'heading' && child.textContent === 'A') {
        draggedPos = pos;
        break;
      }
      pos += child.nodeSize;
    }
    expect(draggedPos).toBeGreaterThan(-1);
    applyDropAtEnd(editor, draggedPos);
    const md = getEditorMarkdownForSync(editor);
    expect(md).toBe('Text\n\n# B\n\n# A');
    editor.destroy();
  });

  it('paragraph dropped at end keeps no phantom blank line', () => {
    const editor = createRealEditor('A\n\nB\n\nC\n');
    applyDropAtEnd(editor, 0);
    const md = getEditorMarkdownForSync(editor);
    expect(md).toBe('B\n\nC\n\nA');
    editor.destroy();
  });
});
