/** @jest-environment jsdom */

/**
 * HTML comments must survive load and save.
 *
 * The lexer normalizer used to drop comment-only HTML blocks so they would not
 * render as empty paragraphs. That deleted every comment on the first save and
 * blocked Feedback, whose snapshot check found the rendered Markdown shorter
 * than the saved file. Comments now load as an `htmlComment` block that shows a
 * muted marker and saves its raw source.
 */

import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { HtmlComment } from '../../webview/extensions/htmlComment';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

const MEDIUM_TABLE = [
  '# Title',
  '',
  '<!-- medium: export as image -->',
  '| | System 1 | System 2 |',
  '|---|---|---|',
  '| Speed | Instant | Slow |',
  '',
  'Text after the table.',
].join('\n');

function createEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ paragraph: false }),
      MarkdownParagraph,
      HtmlComment,
      HtmlPreservingTable.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
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

function withEditor(markdown: string, run: (editor: Editor) => void): void {
  const editor = createEditor();
  try {
    setMarkdownContentPreservingSource(editor, markdown);
    run(editor);
  } finally {
    editor.destroy();
  }
}

function topLevelTypes(editor: Editor): string[] {
  const types: string[] = [];
  editor.state.doc.forEach(node => types.push(node.type.name));
  return types;
}

/** Append text to the first paragraph containing `needle`, forcing a re-serialize. */
function editParagraph(editor: Editor, needle: string): void {
  let end = -1;
  editor.state.doc.descendants((node, pos) => {
    if (end !== -1) return false;
    if (node.type.name === 'paragraph' && node.textContent.includes(needle)) {
      end = pos + node.nodeSize - 1;
      return false;
    }
    return true;
  });
  if (end === -1) throw new Error(`No paragraph containing ${needle}`);
  editor.commands.insertContentAt(end, ' Edited.');
}

describe('HTML comment preservation', () => {
  afterEach(() => document.body.replaceChildren());

  it('loads a comment as its own block without an empty-paragraph gap', () => {
    withEditor(MEDIUM_TABLE, editor => {
      expect(topLevelTypes(editor)).toEqual(['heading', 'htmlComment', 'table', 'paragraph']);
    });
  });

  it('shows the comment as a muted marker', () => {
    withEditor(MEDIUM_TABLE, editor => {
      const marker = editor.view.dom.querySelector('.md4h-html-comment');
      expect(marker?.textContent).toBe('<!-- medium: export as image -->');
      expect(marker?.getAttribute('contenteditable')).toBe('false');
    });
  });

  it('saves an unedited document byte-identical', () => {
    withEditor(MEDIUM_TABLE, editor => {
      expect(getEditorMarkdownForSync(editor)).toBe(MEDIUM_TABLE);
    });
  });

  it('keeps the comment and its tight join to the table after another block is edited', () => {
    withEditor(MEDIUM_TABLE, editor => {
      editParagraph(editor, 'Text after');
      expect(getEditorMarkdownForSync(editor)).toBe(
        MEDIUM_TABLE.replace('Text after the table.', 'Text after the table. Edited.')
      );
    });
  });

  it('keeps the comment when the whole document is re-serialized', () => {
    const editor = createEditor();
    try {
      // Plain setContent skips source preservation, so every block uses its renderer.
      editor.commands.setContent(MEDIUM_TABLE, { contentType: 'markdown' });
      const saved = getEditorMarkdownForSync(editor);
      expect(saved).toContain('<!-- medium: export as image -->\n| ');
    } finally {
      editor.destroy();
    }
  });

  it.each([
    ['a blank line after it', '<!-- note -->\n\nA paragraph.'],
    ['a multi-line body', '<!--\n  first line\n  second line\n-->\n\nA paragraph.'],
    ['two comments on one line', '<!-- a --><!-- b -->\n\nA paragraph.'],
    ['a comment between headings', '# A\n\n<!-- note -->\n\n# B\n\nLast.'],
  ])('round-trips a comment with %s after an edit', (_name, markdown) => {
    withEditor(markdown, editor => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, '!');
      const lastBlock = markdown.split('\n').pop() as string;
      expect(getEditorMarkdownForSync(editor)).toBe(
        markdown.slice(0, markdown.length - lastBlock.length) + `${lastBlock}!`
      );
    });
  });

  it('leaves a comment followed by text on the same line to the HTML parser', () => {
    withEditor('<!-- note --> visible text\n\nAfter.', editor => {
      expect(topLevelTypes(editor)).not.toContain('htmlComment');
    });
  });
});
