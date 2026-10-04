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
import { ListKit } from '@tiptap/extension-list';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
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
      GitHubAlerts,
      StarterKit.configure({
        paragraph: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
      }),
      MarkdownParagraph,
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

  it.each([
    ['block', '<!-- <img src=x onerror="window.__md4hXss=1"><style>body{color:red}</style> -->'],
    ['inline', 'Text <!-- <img src=x onerror="window.__md4hXss=1"> --> more.'],
  ])('renders %s comment markup as text, never as DOM', (_name, markdown) => {
    withEditor(markdown, editor => {
      const marker = editor.view.dom.querySelector('.md4h-html-comment');
      expect(marker?.textContent).toContain('<img src=x onerror=');
      expect(
        editor.view.dom.querySelector('.md4h-html-comment img, .md4h-html-comment style')
      ).toBeNull();
      expect((window as unknown as { __md4hXss?: number }).__md4hXss).toBeUndefined();
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

  describe('inside lists and blockquotes', () => {
    it.each([
      ['a loose list item', '- item\n\n  <!-- nested -->\n\n- next'],
      ['a tight list item', '- item\n  <!-- nested -->\n- next'],
      ['an ordered list item', '1. item\n\n   <!-- nested -->\n\n2. next'],
      ['a blockquote', '> quoted\n>\n> <!-- nested -->'],
      ['a blockquote before more text', '> quoted\n>\n> <!-- nested -->\n> after'],
    ])('keeps a comment in %s', (_name, markdown) => {
      withEditor(markdown, editor => {
        expect(getEditorMarkdownForSync(editor)).toBe(markdown);
        const marker = editor.view.dom.querySelector('.md4h-html-comment');
        expect(marker?.textContent).toBe('<!-- nested -->');
      });
    });

    it.each([
      // An edited loose list re-renders tight (KNOWN_ISSUES: loose list markers).
      [
        'a loose list',
        '- item\n\n  <!-- nested -->\n\n- next',
        '- item\n  <!-- nested -->\n- next Edited.',
      ],
      [
        'a tight list',
        '- item\n  <!-- nested -->\n- next',
        '- item\n  <!-- nested -->\n- next Edited.',
      ],
      [
        'an ordered list',
        '1. item\n   <!-- nested -->\n2. next',
        '1. item\n   <!-- nested -->\n2. next Edited.',
      ],
    ])('keeps a comment in %s after the list is edited', (_name, markdown, expected) => {
      withEditor(markdown, editor => {
        editParagraph(editor, 'next');
        expect(getEditorMarkdownForSync(editor)).toBe(expected);
      });
    });

    it.each([
      ['a nested block', '- [ ] item\n  <!-- nested -->\n- [ ] next', undefined],
      ['a line of text', '- [ ] item <!-- inline --> text\n- [ ] next', undefined],
      [
        'a nested blockquote',
        '- [ ] item\n  > quoted\n  > <!-- nested -->\n- [ ] next',
        // A re-serialized quote separates its blocks with a blank `>` line.
        '- [ ] item\n  > quoted\n  >\n  > <!-- nested -->\n- [ ] next',
      ],
    ])('keeps a comment in a task list item with %s', (_name, markdown, reserialized) => {
      withEditor(markdown, editor => {
        expect(editor.view.dom.querySelector('.md4h-html-comment')).not.toBeNull();
        editParagraph(editor, 'next');
        expect(getEditorMarkdownForSync(editor)).toBe(`${reserialized ?? markdown} Edited.`);
      });
    });

    it('keeps comments in a task item that shares a list with plain items', () => {
      // TipTap splits a mixed list and re-lexes the task item's line by itself.
      const editor = createEditor();
      try {
        editor.commands.setContent('- plain\n\n- [ ] task <!-- inline -->\n  <!-- nested -->', {
          contentType: 'markdown',
        });
        const saved = getEditorMarkdownForSync(editor);
        expect(saved).toContain('- [ ] task <!-- inline -->');
        expect(saved).toContain('<!-- nested -->');
      } finally {
        editor.destroy();
      }
    });

    it('keeps nested comments when the whole document is re-serialized', () => {
      const markdown = '- item\n  <!-- in list -->\n- next\n\n> quoted\n> <!-- in quote -->';
      const editor = createEditor();
      try {
        editor.commands.setContent(markdown, { contentType: 'markdown' });
        // A re-serialized quote separates its blocks with a blank `>` line.
        expect(getEditorMarkdownForSync(editor)).toBe(
          markdown.replace('> quoted\n> <!--', '> quoted\n>\n> <!--')
        );
      } finally {
        editor.destroy();
      }
    });

    it('keeps a quoted comment when the blockquote itself is edited', () => {
      withEditor('> quoted\n>\n> <!-- nested -->', editor => {
        editParagraph(editor, 'quoted');
        // The quoted paragraph and comment stay separate blocks, as in source.
        expect(getEditorMarkdownForSync(editor)).toBe('> quoted Edited.\n>\n> <!-- nested -->');
      });
    });
  });

  describe('inside a line of text', () => {
    it.each([
      ['a paragraph', 'Text <!-- inline --> more.'],
      ['a heading', '# Title <!-- inline -->'],
      ['a list item', '- Text <!-- inline --> more.'],
      ['a multi-line comment', 'Text <!-- first\nsecond --> more.'],
    ])('keeps an inline comment in %s', (_name, markdown) => {
      withEditor(markdown, editor => {
        expect(topLevelTypes(editor)).not.toContain('htmlComment');
        expect(getEditorMarkdownForSync(editor)).toBe(markdown);
      });
    });

    it('shows an inline comment as a muted inline marker', () => {
      withEditor('Text <!-- inline --> more.', editor => {
        const marker = editor.view.dom.querySelector('span.md4h-html-comment');
        expect(marker?.textContent).toBe('<!-- inline -->');
        expect(marker?.getAttribute('contenteditable')).toBe('false');
        expect(editor.state.doc.textContent).toBe('Text  more.');
      });
    });

    it('keeps an inline comment after its paragraph is edited', () => {
      withEditor('Text <!-- inline --> more.\n\nNext.', editor => {
        editParagraph(editor, 'Text');
        expect(getEditorMarkdownForSync(editor)).toBe(
          'Text <!-- inline --> more. Edited.\n\nNext.'
        );
      });
    });

    it('keeps inline comments when the whole document is re-serialized', () => {
      const editor = createEditor();
      try {
        editor.commands.setContent('Text <!-- inline --> more.\n\n- item <!-- x -->', {
          contentType: 'markdown',
        });
        expect(getEditorMarkdownForSync(editor)).toBe(
          'Text <!-- inline --> more.\n\n- item <!-- x -->'
        );
      } finally {
        editor.destroy();
      }
    });

    it('keeps inline comments in table cells', () => {
      const editor = createEditor();
      try {
        editor.commands.setContent('| A <!-- c --> | B |\n| --- | --- |\n| 1 | 2 |', {
          contentType: 'markdown',
        });
        expect(getEditorMarkdownForSync(editor)).toMatch(/^\| A <!-- c --> \|/);
      } finally {
        editor.destroy();
      }
    });

    it('does not split emphasis around a comment inside it', () => {
      // An atom cannot carry the surrounding mark, so the comment is dropped
      // (KNOWN_ISSUES) rather than ending the bold text early.
      const editor = createEditor();
      try {
        editor.commands.setContent('**a <!-- c --> b**', { contentType: 'markdown' });
        expect(getEditorMarkdownForSync(editor)).toBe('**a  b**');
      } finally {
        editor.destroy();
      }
    });

    it('leaves inline HTML that is not only a comment to the HTML parser', () => {
      withEditor('Text <b>bold</b> more.', editor => {
        expect(editor.view.dom.querySelector('.md4h-html-comment')).toBeNull();
      });
    });
  });
});
