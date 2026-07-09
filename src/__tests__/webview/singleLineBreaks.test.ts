/** @jest-environment jsdom */

import type { JSONContent } from '@tiptap/core';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { ListKit } from '@tiptap/extension-list';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';

/**
 * Builds an editor identical (for the relevant part) to the real one, with the
 * marked `breaks` option toggled. This is what the
 * `markdownForHumans.render.singleLineBreaks` setting controls in editor.ts.
 */
function createTestEditor(breaks: boolean): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);

  return new Editor({
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
      Markdown.configure({
        markedOptions: {
          gfm: true,
          breaks,
        },
      }),
      ListKit.configure({
        orderedList: false,
        taskItem: { nested: true },
      }),
      OrderedListMarkdownFix,
    ],
  });
}

function countNodesOfType(doc: JSONContent, type: string): number {
  let count = 0;
  const walk = (node: JSONContent): void => {
    if (node.type === type) count++;
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(doc);
  return count;
}

// A paragraph hard-wrapped across two source lines, which is how most authored
// Markdown (including product documentation) is written.
const HARD_WRAPPED = 'Line one of a wrapped paragraph\nLine two of the same paragraph';

describe('render.singleLineBreaks setting (marked "breaks" option)', () => {
  it('renders a single newline as a hard break when breaks=true', () => {
    const editor = createTestEditor(true);
    try {
      editor.commands.setContent(HARD_WRAPPED, { contentType: 'markdown' });

      // A <br> is inserted for the single newline.
      expect(editor.getHTML()).toContain('<br');
      expect(countNodesOfType(editor.getJSON(), 'hardBreak')).toBeGreaterThanOrEqual(1);
      // Both lines still live in one paragraph.
      expect(countNodesOfType(editor.getJSON(), 'paragraph')).toBe(1);
    } finally {
      editor.destroy();
    }
  });

  it('treats a single newline as a soft break (CommonMark) when breaks=false', () => {
    const editor = createTestEditor(false);
    try {
      editor.commands.setContent(HARD_WRAPPED, { contentType: 'markdown' });

      // No <br>: the wrapped lines flow into one continuous paragraph, matching
      // VS Code's built-in Markdown preview.
      expect(editor.getHTML()).not.toContain('<br');
      expect(countNodesOfType(editor.getJSON(), 'hardBreak')).toBe(0);
      expect(countNodesOfType(editor.getJSON(), 'paragraph')).toBe(1);
      // The text of both source lines is preserved.
      expect(editor.getText()).toContain('Line one of a wrapped paragraph');
      expect(editor.getText()).toContain('Line two of the same paragraph');
    } finally {
      editor.destroy();
    }
  });

  it('still separates paragraphs on a blank line regardless of the setting', () => {
    for (const breaks of [true, false]) {
      const editor = createTestEditor(breaks);
      try {
        editor.commands.setContent('First paragraph.\n\nSecond paragraph.', {
          contentType: 'markdown',
        });
        expect(countNodesOfType(editor.getJSON(), 'paragraph')).toBe(2);
      } finally {
        editor.destroy();
      }
    }
  });
});
