/** @jest-environment jsdom */

/**
 * Regression for the Feedback capture ordinal→element mapping. Feedback mode
 * keeps the editor surface contenteditable, so ProseMirror can insert a
 * GapCursor (a `.ProseMirror-widget` div) as a DIRECT child of the editor root.
 * A raw `root.children.item(ordinal)` lookup then drifts by one per widget and
 * can even return the widget itself, so screenshots anchor to the wrong block.
 * `collectCaptureBlocks` must resolve ordinals through the shared widget-aware
 * index so every anchored ordinal maps to its real block.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { ListKit } from '@tiptap/extension-list';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { CustomImage } from '../../webview/extensions/customImage';
import { PreservedMarkdownLiteral } from '../../webview/extensions/preservedMarkdownLiteral';
import { collectCaptureBlocks } from '../../webview/features/feedbackCaptureWorkflow';
import type { FeedbackSessionView } from '../../webview/features/feedbackReview';

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
        trailingNode: false,
        undoRedo: { depth: 100 },
      }),
      MarkdownParagraph,
      PreservedMarkdownLiteral,
      CustomImage,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      ListKit.configure({ listItem: false, orderedList: false, taskItem: { nested: true } }),
      MarkdownListItem,
      OrderedListMarkdownFix,
    ],
    content: '',
    contentType: 'markdown',
  });
  if (initialMarkdown) editor.commands.setContent(initialMarkdown, { contentType: 'markdown' });
  return editor;
}

function placeLeadingGapCursor(editor: Editor): boolean {
  const doc = editor.state.doc;
  for (let pos = 0; pos <= doc.content.size; pos += 1) {
    const $pos = doc.resolve(pos);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((GapCursor as any).valid($pos)) {
      editor.view.dispatch(editor.state.tr.setSelection(new GapCursor($pos)));
      editor.view.updateState(editor.state);
      editor.view.dom.dispatchEvent(new Event('focus'));
      return true;
    }
  }
  return false;
}

function sessionWithAnchors(count: number): FeedbackSessionView {
  const anchors = Array.from({ length: count }, (_unused, ordinal) => ({
    ordinal,
    startLine: ordinal + 1,
    endLine: ordinal + 1,
  }));
  return { anchors } as unknown as FeedbackSessionView;
}

describe('collectCaptureBlocks maps ordinals correctly with a gap cursor present', () => {
  it('resolves every ordinal to its real block and never to a widget', () => {
    // Doc STARTS with a leaf block so a gap cursor is required ahead of block 0.
    const editor = createRealEditor('---\n\nFirst para\n\nSecond para');
    try {
      const placed = placeLeadingGapCursor(editor);
      expect(placed).toBe(true);

      const root = editor.view.dom as HTMLElement;
      // Precondition: the widget really is a direct child that shifts raw indices.
      const hasWidgetChild = Array.from(root.children).some(child =>
        child.classList.contains('ProseMirror-widget')
      );
      expect(hasWidgetChild).toBe(true);

      const filteredBlocks = Array.from(root.children).filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && !child.classList.contains('ProseMirror-widget')
      );
      expect(filteredBlocks).toHaveLength(editor.state.doc.childCount);

      const blocks = collectCaptureBlocks(editor, sessionWithAnchors(editor.state.doc.childCount));

      expect(blocks.map(block => block.index)).toEqual([0, 1, 2]);
      // None of the resolved elements is the gap-cursor/widget.
      expect(blocks.every(block => !block.element.classList.contains('ProseMirror-widget'))).toBe(
        true
      );
      // Each ordinal maps to the correct block in document order.
      expect(blocks[0].element).toBe(filteredBlocks[0]);
      expect(blocks[1].element).toBe(filteredBlocks[1]);
      expect(blocks[2].element).toBe(filteredBlocks[2]);
      expect(blocks[0].element.tagName.toLowerCase()).toBe('hr');
    } finally {
      editor.destroy();
    }
  });
});
