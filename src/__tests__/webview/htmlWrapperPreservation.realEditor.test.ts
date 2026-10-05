/** @jest-environment jsdom */

/**
 * Raw HTML wrappers must survive an edit made somewhere else in the document.
 *
 * Marked ends an HTML block at the first blank line, so a wrapper such as
 * `<div align="center">` with a Markdown body inside arrives as an opening
 * `html` token, a paragraph, and a closing `html` token. The closing tag parsed
 * to nothing and was dropped, and the opening tag was lost with it, so saving
 * after an unrelated edit rewrote the file without its wrapper.
 */

import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { ListKit } from '@tiptap/extension-list';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { CustomImage } from '../../webview/extensions/customImage';
import { BlankLinePreservation } from '../../webview/extensions/blankLinePreservation';
import { GitHubAlerts } from '../../webview/extensions/githubAlerts';
import { HtmlComment, HtmlCommentInline } from '../../webview/extensions/htmlComment';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { MarkdownTaskList } from '../../webview/extensions/markdownTaskList';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';
import {
  installBlankLineLexerNormalizer,
  normalizeBlankLineGreedyTokens,
} from '../../webview/utils/markedLexerNormalizer';

function createEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      GitHubAlerts,
      StarterKit.configure({
        paragraph: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
      }),
      MarkdownParagraph,
      CustomImage,
      HtmlComment,
      HtmlCommentInline,
      BlankLinePreservation,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      HtmlPreservingTable.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      ListKit.configure({ listItem: false, orderedList: false, taskList: false }),
      MarkdownTaskList,
      MarkdownListItem,
      OrderedListMarkdownFix,
    ],
    content: '',
    contentType: 'markdown',
  });
  const storage = editor as unknown as {
    markdown?: { instance?: unknown };
    storage?: { markdown?: { instance?: unknown } };
  };
  const marked = storage.markdown?.instance ?? storage.storage?.markdown?.instance;
  if (marked) installBlankLineLexerNormalizer(marked);
  return editor;
}

/** Append text to the first heading, forcing a re-serialize of the document. */
function editHeading(editor: Editor): void {
  let end = -1;
  editor.state.doc.descendants((node, pos) => {
    if (end !== -1) return false;
    if (node.type.name === 'heading') {
      end = pos + node.nodeSize - 1;
      return false;
    }
    return true;
  });
  if (end === -1) throw new Error('No heading in document');
  editor.commands.insertContentAt(end, ' EDITED');
}

const WRAPPERS: Array<[string, string]> = [
  ['a div with a Markdown body', '<div align="center">\n\n**bold**\n\n</div>'],
  ['a div with a plain paragraph body', '<div align="center">\n\nplain text\n\n</div>'],
  [
    'details with a Markdown body',
    '<details>\n<summary>More</summary>\n\nHidden body\n\n</details>',
  ],
  ['a compact details block', '<details><summary>More</summary>\n\nHidden body\n\n</details>'],
  ['center around a heading', '<center>\n\n## inside center\n\n</center>'],
  ['a div around a list', '<div>\n\n- one\n- two\n\n</div>'],
  [
    'a p with blank lines around an image',
    '<p align="center">\n\n<img src="a.png" width="100" alt="logo">\n\n</p>',
  ],
  ['a div whose opening line has text', '<div>Intro text\n\n**bold**\n\n</div>'],
  [
    'a div with text after an inner wrapper',
    '<div class="a">\n\n<div class="b">Inner text\n\nbody\n\n</div>\n\n</div>',
  ],
  ['nested divs', '<div class="a">\n\n<div class="b">\n\ninner\n\n</div>\n\n</div>'],
];

describe('raw HTML wrapper preservation', () => {
  afterEach(() => document.body.replaceChildren());

  it.each(WRAPPERS)('keeps %s byte-identical after an unrelated heading edit', (_name, html) => {
    const markdown = `# Title\n\n${html}\n\nTail paragraph.`;
    const editor = createEditor();
    try {
      setMarkdownContentPreservingSource(editor, markdown);
      editHeading(editor);
      expect(getEditorMarkdownForSync(editor)).toBe(markdown.replace('# Title', '# Title EDITED'));
    } finally {
      editor.destroy();
    }
  });

  it.each(WRAPPERS)('saves %s untouched when nothing is edited', (_name, html) => {
    const markdown = `# Title\n\n${html}\n\nTail paragraph.`;
    const editor = createEditor();
    try {
      setMarkdownContentPreservingSource(editor, markdown);
      expect(getEditorMarkdownForSync(editor)).toBe(markdown);
    } finally {
      editor.destroy();
    }
  });

  it('keeps an opener that is never closed, and everything after it', () => {
    const markdown = '# Title\n\n<div class="x">\n\nBody paragraph.\n\nTail paragraph.';
    const editor = createEditor();
    try {
      setMarkdownContentPreservingSource(editor, markdown);
      editHeading(editor);
      expect(getEditorMarkdownForSync(editor)).toBe(markdown.replace('# Title', '# Title EDITED'));
    } finally {
      editor.destroy();
    }
  });

  it('does not slow down on a very large raw HTML table', () => {
    const rows = Array.from({ length: 8000 }, (_, i) => `<tr><td>cell ${i}</td><td>x</td></tr>`);
    const raw = `<table>\n${rows.join('\n')}\n</table>\n`;
    const started = performance.now();
    normalizeBlankLineGreedyTokens([{ type: 'html', raw, text: raw, block: true }] as never);
    // Quadratic tag stripping took about 600 ms here; linear work takes a few.
    expect(performance.now() - started).toBeLessThan(250);
  });

  it.each([
    ['no blank lines inside a div', '<div align="center">\n**bold**\n</div>'],
    ['a one-line div', '<div align="center"><b>one line</b></div>'],
    [
      'a README logo header',
      '<p align="center">\n  <img src="a.png" width="100" alt="logo">\n</p>',
    ],
    ['a raw HTML table', '<table>\n  <tr><td>a</td><td>b</td></tr>\n</table>'],
  ])('still preserves %s (previously passing)', (_name, html) => {
    const markdown = `# Title\n\n${html}\n\nTail paragraph.`;
    const editor = createEditor();
    try {
      setMarkdownContentPreservingSource(editor, markdown);
      editHeading(editor);
      expect(getEditorMarkdownForSync(editor)).toBe(markdown.replace('# Title', '# Title EDITED'));
    } finally {
      editor.destroy();
    }
  });
});
