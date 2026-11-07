/** @jest-environment jsdom */

/**
 * Copy selection as Markdown must serialize a partial selection as one line of
 * text, not as one block per styled run.
 *
 * `doc.slice` of a selection inside a paragraph holds bare inline nodes. Placing
 * them directly under the document node made the serializer treat each run as its
 * own block, so `with **bold**, *italic*` was copied as three paragraphs, and a
 * run of plain text copied nothing at all.
 */

import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { ListKit } from '@tiptap/extension-list';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { MarkdownLink } from '../../webview/extensions/markdownCompatibilityMarks';
import { HtmlKbd } from '../../webview/extensions/inlineHtmlMarks';
import { getSelectionAsMarkdown } from '../../webview/utils/copyMarkdown';
import { setMarkdownContentPreservingSource } from '../../webview/utils/markdownSerialization';

function createEditor(markdown: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        paragraph: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        link: false,
      }),
      MarkdownParagraph,
      MarkdownLink,
      HtmlKbd,
      ListKit.configure({ taskList: false }),
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ],
    content: '',
    contentType: 'markdown',
  });
  setMarkdownContentPreservingSource(editor, markdown);
  return editor;
}

/** Document position of `needle[offset]`, found by scanning text nodes. */
function positionOf(editor: Editor, needle: string, atEnd = false): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found !== -1 || !node.isText) return;
    const index = (node.text ?? '').indexOf(needle);
    if (index !== -1) found = pos + index + (atEnd ? needle.length : 0);
  });
  if (found === -1) throw new Error(`"${needle}" not found in document`);
  return found;
}

function select(editor: Editor, from: string, to: string): void {
  editor.commands.setTextSelection({
    from: positionOf(editor, from),
    to: positionOf(editor, to, true),
  });
}

const PARAGRAPH =
  'Plain paragraph with **bold**, *italic*, `code`, and a [link](https://example.com).';

describe('getSelectionAsMarkdown', () => {
  afterEach(() => document.body.replaceChildren());

  it('copies words inside one text run', () => {
    const editor = createEditor(PARAGRAPH);
    select(editor, 'Plain', 'paragraph');
    expect(getSelectionAsMarkdown(editor)).toBe('Plain paragraph');
    editor.destroy();
  });

  it('keeps bold and italic runs on one line', () => {
    const editor = createEditor(PARAGRAPH);
    select(editor, 'with', 'italic');
    expect(getSelectionAsMarkdown(editor)).toBe('with **bold**, *italic*');
    editor.destroy();
  });

  it('keeps a link and the text around it on one line', () => {
    const editor = createEditor(PARAGRAPH);
    select(editor, 'and a', 'link');
    expect(getSelectionAsMarkdown(editor)).toBe('and a [link](https://example.com)');
    editor.destroy();
  });

  it('keeps inline code and kbd on one line', () => {
    const editor = createEditor('Run `cmd` then <kbd>Enter</kbd> now.');
    select(editor, 'Run', 'Enter');
    expect(getSelectionAsMarkdown(editor)).toBe('Run `cmd` then <kbd>Enter</kbd>');
    editor.destroy();
  });

  it('copies part of a heading without losing the heading level', () => {
    const editor = createEditor('## Section title here');
    select(editor, 'title', 'title');
    expect(getSelectionAsMarkdown(editor)).toBe('title');
    editor.destroy();
  });

  it('copies part of a list item as text', () => {
    const editor = createEditor('- alpha **beta** gamma');
    select(editor, 'alpha', 'beta');
    expect(getSelectionAsMarkdown(editor)).toBe('alpha **beta**');
    editor.destroy();
  });

  it('still serializes a selection across blocks as blocks', () => {
    const editor = createEditor('# Title\n\nFirst **bold** paragraph.\n\nSecond paragraph.');
    select(editor, 'Title', 'Second paragraph.');
    expect(getSelectionAsMarkdown(editor)).toBe(
      '# Title\n\nFirst **bold** paragraph.\n\nSecond paragraph.'
    );
    editor.destroy();
  });

  it('copies text selected inside a code block literally, without Markdown escaping', () => {
    const editor = createEditor('```js\nconst a = x*y + z_w;\n```');
    select(editor, 'x*y', 'z_w');
    expect(getSelectionAsMarkdown(editor)).toBe('x*y + z_w');
    editor.destroy();
  });

  it('returns null for an empty selection', () => {
    const editor = createEditor(PARAGRAPH);
    editor.commands.setTextSelection(3);
    expect(getSelectionAsMarkdown(editor)).toBeNull();
    editor.destroy();
  });
});
