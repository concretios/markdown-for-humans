/** @jest-environment jsdom */

/**
 * `<https://…>` and `<me@host>` autolinks must be written back in angle form.
 *
 * The link mark rendered every link as `[text](href)`, so editing a paragraph
 * rewrote `<https://example.com/a_b>` as `[https://example.com/a_b](https://example.com/a_b)`.
 * The rendered result is the same, but the source got longer and noisier.
 */

import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { MarkdownLink } from '../../webview/extensions/markdownCompatibilityMarks';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';

function createEditor(markdown: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ paragraph: false, link: false }),
      MarkdownParagraph,
      MarkdownLink,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ],
    content: '',
    contentType: 'markdown',
  });
  setMarkdownContentPreservingSource(editor, markdown);
  return editor;
}

function appendToFirstParagraph(editor: Editor, text: string): void {
  let end = -1;
  editor.state.doc.descendants((node, pos) => {
    if (end !== -1) return false;
    if (node.type.name === 'paragraph') {
      end = pos + node.nodeSize - 1;
      return false;
    }
    return true;
  });
  editor.commands.insertContentAt(end, text);
}

describe('autolink preservation', () => {
  afterEach(() => document.body.replaceChildren());

  it.each([
    ['a URL autolink', 'See <https://example.com/a_b_c> now.'],
    ['an email autolink', 'Mail <me_x@example.com> now.'],
    ['both', 'Autolink <https://example.com/a_b_c> and email <me_x@example.com>.'],
  ])('keeps %s in angle form when its paragraph is edited', (_name, markdown) => {
    const editor = createEditor(markdown);
    appendToFirstParagraph(editor, ' EDITED');
    expect(getEditorMarkdownForSync(editor)).toBe(`${markdown} EDITED`);
    editor.destroy();
  });

  it('keeps an explicit bracketed link bracketed, even when its text equals the URL', () => {
    const markdown = 'See [https://example.com](https://example.com) now.';
    const editor = createEditor(markdown);
    appendToFirstParagraph(editor, ' EDITED');
    expect(getEditorMarkdownForSync(editor)).toBe(`${markdown} EDITED`);
    editor.destroy();
  });

  it('keeps a bare GFM autolink as plain text', () => {
    const markdown = 'See https://example.com now.';
    const editor = createEditor(markdown);
    appendToFirstParagraph(editor, ' EDITED');
    expect(getEditorMarkdownForSync(editor)).toBe(`${markdown} EDITED`);
    editor.destroy();
  });

  it('falls back to the bracketed form once the link text no longer matches the URL', () => {
    const editor = createEditor('See <https://example.com> now.');
    let from = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.marks.some(m => m.type.name === 'link')) from = pos;
    });
    editor.commands.insertContentAt(from + 'https://example.com'.length, ' docs', {
      updateSelection: false,
    });
    expect(getEditorMarkdownForSync(editor)).toContain('](https://example.com)');
    expect(getEditorMarkdownForSync(editor)).not.toContain('<https://example.com>');
    editor.destroy();
  });
});
