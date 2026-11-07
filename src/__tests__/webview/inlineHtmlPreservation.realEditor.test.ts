/** @jest-environment jsdom */

/**
 * Inline raw HTML must survive an edit to its own paragraph.
 *
 * `<kbd>Ctrl</kbd>` reached the schema as plain text, because no mark claimed the
 * tag, so editing the paragraph rewrote it as `Ctrl`. Documentation relies on
 * `<kbd>`, `<sub>` and `<sup>`, so each is now a mark that saves its own tags.
 */

import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { ListKit } from '@tiptap/extension-list';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { BlankLinePreservation } from '../../webview/extensions/blankLinePreservation';
import { CustomImage } from '../../webview/extensions/customImage';
import { GitHubAlerts } from '../../webview/extensions/githubAlerts';
import { HtmlComment, HtmlCommentInline } from '../../webview/extensions/htmlComment';
import { HtmlKbd, HtmlSub, HtmlSup } from '../../webview/extensions/inlineHtmlMarks';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { MarkdownListItem } from '../../webview/extensions/markdownListItem';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { MarkdownTaskList } from '../../webview/extensions/markdownTaskList';
import { OrderedListMarkdownFix } from '../../webview/extensions/orderedListMarkdownFix';
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
      HtmlKbd,
      HtmlSub,
      HtmlSup,
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

/** Append text to the end of the first paragraph, forcing a re-serialize of it. */
function editFirstParagraph(editor: Editor): void {
  let end = -1;
  editor.state.doc.descendants((node, pos) => {
    if (end !== -1) return false;
    if (node.type.name === 'paragraph') {
      end = pos + node.nodeSize - 1;
      return false;
    }
    return true;
  });
  if (end === -1) throw new Error('No paragraph in document');
  editor.commands.insertContentAt(end, ' EDITED');
}

const INLINE_HTML: Array<[string, string]> = [
  ['kbd', 'Press <kbd>Ctrl</kbd>+<kbd>C</kbd> now.'],
  ['sub', 'Water is H<sub>2</sub>O.'],
  ['sup', 'Area is 5 m<sup>2</sup>.'],
  ['kbd inside bold', 'Use **<kbd>Cmd</kbd>** here.'],
  ['kbd inside a link', 'See [<kbd>F1</kbd> help](https://example.com).'],
  ['kbd next to inline code', 'Run `cmd` then <kbd>Enter</kbd>.'],
];

describe('inline raw HTML preservation', () => {
  afterEach(() => document.body.replaceChildren());

  it.each(INLINE_HTML)('keeps %s after its own paragraph is edited', (_name, paragraph) => {
    const markdown = `# Title\n\n${paragraph}`;
    const editor = createEditor();
    try {
      setMarkdownContentPreservingSource(editor, markdown);
      editFirstParagraph(editor);
      expect(getEditorMarkdownForSync(editor)).toBe(`${markdown} EDITED`);
    } finally {
      editor.destroy();
    }
  });

  it.each(INLINE_HTML)('saves %s untouched when nothing is edited', (_name, paragraph) => {
    const markdown = `# Title\n\n${paragraph}`;
    const editor = createEditor();
    try {
      setMarkdownContentPreservingSource(editor, markdown);
      expect(getEditorMarkdownForSync(editor)).toBe(markdown);
    } finally {
      editor.destroy();
    }
  });

  it('keeps Markdown-looking text between kbd tags exactly as written', () => {
    const editor = createEditor();
    try {
      setMarkdownContentPreservingSource(editor, 'Hit <kbd>**Esc**</kbd> to leave.');
      editFirstParagraph(editor);
      expect(getEditorMarkdownForSync(editor)).toBe('Hit <kbd>**Esc**</kbd> to leave. EDITED');
    } finally {
      editor.destroy();
    }
  });

  it('shows the key text as a styled kbd element, not as markers', () => {
    const editor = createEditor();
    try {
      setMarkdownContentPreservingSource(editor, 'Press <kbd>Ctrl</kbd> now.');
      expect(editor.view.dom.querySelector('kbd')?.textContent).toBe('Ctrl');
    } finally {
      editor.destroy();
    }
  });
});
