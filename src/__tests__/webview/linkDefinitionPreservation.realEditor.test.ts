/** @jest-environment jsdom */

/**
 * Reference-style link definitions must survive a save.
 *
 * `[0.2.1]: https://…` lines carry no visible content, so no block was made for
 * them and the next save deleted them, while the unedited text above still used
 * `[0.2.1]` as a link. Each definition is now kept as a muted marker line that
 * saves its source unchanged.
 */

import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { HtmlComment, HtmlCommentInline } from '../../webview/extensions/htmlComment';
import { MarkdownLink } from '../../webview/extensions/markdownCompatibilityMarks';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

function createEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ paragraph: false, link: false }),
      MarkdownParagraph,
      MarkdownLink,
      HtmlComment,
      HtmlCommentInline,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ],
    content: '',
    contentType: 'markdown',
  });
  const storage = editor as unknown as { markdown?: { instance?: unknown } };
  if (storage.markdown?.instance) installBlankLineLexerNormalizer(storage.markdown.instance);
  return editor;
}

function appendToHeading(editor: Editor): void {
  let end = -1;
  editor.state.doc.descendants((node, pos) => {
    if (end !== -1) return false;
    if (node.type.name === 'heading') {
      end = pos + node.nodeSize - 1;
      return false;
    }
    return true;
  });
  editor.commands.insertContentAt(end, ' EDITED');
}

const CHANGELOG = [
  '# Changelog',
  '',
  '## [0.2.1] - 2025-01-01',
  '',
  'Text with a [reference link][docs] and a shortcut [0.2.0].',
  '',
  '[Unreleased]: https://example.com/compare/v0.2.1...HEAD',
  '[0.2.1]: https://example.com/compare/v0.2.0...v0.2.1',
  '[0.2.0]: https://example.com/releases/v0.2.0',
  '[docs]: https://example.com/docs "Docs title"',
].join('\n');

describe('link reference definitions', () => {
  afterEach(() => document.body.replaceChildren());

  it('saves definitions untouched when nothing is edited', () => {
    const editor = createEditor();
    setMarkdownContentPreservingSource(editor, CHANGELOG);
    expect(getEditorMarkdownForSync(editor)).toBe(CHANGELOG);
    editor.destroy();
  });

  it('keeps every definition when a heading elsewhere is edited', () => {
    const editor = createEditor();
    setMarkdownContentPreservingSource(editor, CHANGELOG);
    appendToHeading(editor);
    expect(getEditorMarkdownForSync(editor)).toBe(
      CHANGELOG.replace('# Changelog', '# Changelog EDITED')
    );
    editor.destroy();
  });

  it('still resolves reference links in the text above them', () => {
    const editor = createEditor();
    setMarkdownContentPreservingSource(editor, CHANGELOG);
    const hrefs: string[] = [];
    editor.state.doc.descendants(node => {
      node.marks.forEach(mark => {
        if (mark.type.name === 'link') hrefs.push(String(mark.attrs.href));
      });
    });
    expect(hrefs).toEqual(expect.arrayContaining(['https://example.com/docs']));
    editor.destroy();
  });
});

describe('comment at the end of a heading', () => {
  afterEach(() => document.body.replaceChildren());

  it('keeps the comment when the heading is edited', () => {
    const markdown = '# Comments <!-- heading note -->\n\nBody.';
    const editor = createEditor();
    setMarkdownContentPreservingSource(editor, markdown);
    appendToHeading(editor);
    expect(getEditorMarkdownForSync(editor)).toContain('<!-- heading note -->');
    editor.destroy();
  });
});
