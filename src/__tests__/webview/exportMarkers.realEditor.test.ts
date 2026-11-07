/** @jest-environment jsdom */

/**
 * Exports must not contain the editor's HTML marker nodes.
 *
 * Comments and wrapper tags such as `<div align="center">` are shown in the editor
 * as muted marker lines. They are source, not content, so a PDF or Word export
 * must leave them out rather than print the literal tag text.
 */

import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { HtmlComment, HtmlCommentInline } from '../../webview/extensions/htmlComment';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { collectExportContent } from '../../webview/utils/exportContent';
import { setMarkdownContentPreservingSource } from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

async function exportedHtml(markdown: string): Promise<string> {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ paragraph: false }),
      MarkdownParagraph,
      HtmlComment,
      HtmlCommentInline,
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    content: '',
    contentType: 'markdown',
  });
  const storage = editor as unknown as { markdown?: { instance?: unknown } };
  if (storage.markdown?.instance) installBlankLineLexerNormalizer(storage.markdown.instance);
  setMarkdownContentPreservingSource(editor, markdown);
  try {
    return (await collectExportContent(editor)).html;
  } finally {
    editor.destroy();
  }
}

describe('export content', () => {
  afterEach(() => document.body.replaceChildren());

  it('omits wrapper tag markers but keeps the content between them', async () => {
    const html = await exportedHtml('# T\n\n<div align="center">\n\n**bold**\n\n</div>\n\nTail.');
    expect(html).not.toContain('align=&quot;center&quot;');
    expect(html).not.toContain('&lt;div');
    expect(html).not.toContain('md4h-html-comment');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('Tail.');
  });

  it('omits block and inline comment markers', async () => {
    const html = await exportedHtml('<!-- block note -->\n\nText <!-- inline note --> more.');
    expect(html).not.toContain('block note');
    expect(html).not.toContain('inline note');
    expect(html).toContain('more.');
  });
});
