/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Behaviour of `markdownForHumans.render.singleLineBreaks` through the real
 * editor stack: what the user SEES (editor text / HTML) and what would be
 * WRITTEN to disk (`getEditorMarkdownForSync`).
 *
 * true  (default): every single newline is a hard break. A hard-wrapped
 *                  paragraph shows a break at each wrap and is saved back with
 *                  a trailing two-space break on each wrapped line.
 * false:           CommonMark soft break. The wrapped paragraph flows as one
 *                  line on screen, and an untouched paragraph is saved back
 *                  with its original wrapping byte for byte.
 */

import type { JSONContent } from '@tiptap/core';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { ListKit } from '@tiptap/extension-list';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import { SoftBreak } from '../../webview/extensions/softBreak';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';

/**
 * Mirrors editor.ts for the parts that matter here: the marked `breaks`
 * option, the SoftBreak node, and the lexer normalizer installed with the
 * soft-break predicate before any content is parsed.
 */
function createTestEditor(singleLineBreaks: boolean): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        paragraph: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        undoRedo: { depth: 100 },
      }),
      MarkdownParagraph,
      SoftBreak,
      Markdown.configure({ markedOptions: { gfm: true, breaks: singleLineBreaks } }),
      ListKit.configure({ orderedList: false, taskItem: { nested: true } }),
      OrderedListMarkdownFix,
    ],
  });
  const markedInstance = (editor as unknown as { markdown?: { instance?: unknown } }).markdown
    ?.instance;
  installBlankLineLexerNormalizer(markedInstance, () => !singleLineBreaks);
  return editor;
}

function withEditor<T>(singleLineBreaks: boolean, fn: (editor: Editor) => T): T {
  const editor = createTestEditor(singleLineBreaks);
  try {
    return fn(editor);
  } finally {
    editor.destroy();
  }
}

function roundTrip(markdown: string, singleLineBreaks: boolean): string {
  return withEditor(singleLineBreaks, editor => {
    editor.commands.setContent(markdown, { contentType: 'markdown' });
    return getEditorMarkdownForSync(editor);
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

describe('render.singleLineBreaks = true (default, hard breaks)', () => {
  it('shows a line break at the wrap point', () => {
    withEditor(true, editor => {
      editor.commands.setContent(HARD_WRAPPED, { contentType: 'markdown' });

      expect(editor.getHTML()).toContain('<br');
      expect(countNodesOfType(editor.getJSON(), 'hardBreak')).toBe(1);
      expect(countNodesOfType(editor.getJSON(), 'paragraph')).toBe(1);
    });
  });

  it('saves the wrap point back as a trailing two-space hard break', () => {
    expect(roundTrip('alpha\nbeta\ngamma', true)).toBe('alpha  \nbeta  \ngamma');
  });

  it('still separates paragraphs on a blank line', () => {
    expect(roundTrip('first para\n\nsecond para', true)).toBe('first para\n\nsecond para');
  });
});

describe('render.singleLineBreaks = false (CommonMark soft breaks)', () => {
  it('flows the wrapped lines into one line on screen', () => {
    withEditor(false, editor => {
      editor.commands.setContent(HARD_WRAPPED, { contentType: 'markdown' });

      expect(editor.getHTML()).not.toContain('<br');
      expect(countNodesOfType(editor.getJSON(), 'hardBreak')).toBe(0);
      expect(countNodesOfType(editor.getJSON(), 'paragraph')).toBe(1);
      // ProseMirror renders with white-space: break-spaces, so a raw "\n" left
      // in a text node would still display as a line break. The soft break
      // must be its own node that reads as a space.
      expect(countNodesOfType(editor.getJSON(), 'softBreak')).toBe(1);
      expect(editor.getText()).toBe(
        'Line one of a wrapped paragraph Line two of the same paragraph'
      );
      expect(JSON.stringify(editor.getJSON())).not.toContain('\\n');
    });
  });

  it('round-trips an untouched wrapped paragraph verbatim', () => {
    expect(roundTrip(HARD_WRAPPED, false)).toBe(HARD_WRAPPED);
  });

  it('injects no trailing two-space break at a wrap point', () => {
    expect(roundTrip('alpha\nbeta\ngamma', false)).toBe('alpha\nbeta\ngamma');
  });

  it('keeps the original wrapping when text elsewhere in the paragraph is edited', () => {
    const saved = withEditor(false, editor => {
      editor.commands.setContent(HARD_WRAPPED, { contentType: 'markdown' });
      editor.commands.insertContentAt(1, 'Edited: ');
      return getEditorMarkdownForSync(editor);
    });

    expect(saved).toBe('Edited: Line one of a wrapped paragraph\nLine two of the same paragraph');
  });

  it('still honours an explicit two-space hard break', () => {
    withEditor(false, editor => {
      editor.commands.setContent('first line  \nsecond line', { contentType: 'markdown' });

      expect(countNodesOfType(editor.getJSON(), 'hardBreak')).toBe(1);
      expect(countNodesOfType(editor.getJSON(), 'softBreak')).toBe(0);
      expect(getEditorMarkdownForSync(editor)).toBe('first line  \nsecond line');
    });
  });

  it('still separates paragraphs on a blank line', () => {
    expect(roundTrip('first para\n\nsecond para', false)).toBe('first para\n\nsecond para');
  });

  it('leaves newlines inside code blocks alone', () => {
    const code = '```\nline one\nline two\n```';

    expect(roundTrip(code, false)).toBe(code);
  });
});
