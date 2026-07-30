/**
 * @jest-environment jsdom
 */

/**
 * Coverage for the `markdownForHumans.paste.htmlHandling` setting and for the
 * blank lines that document scaffolding used to leave behind.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { BlankLinePreservation } from '../../webview/extensions/blankLinePreservation';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';
import {
  getPasteHtmlHandling,
  htmlToMarkdown,
  processPasteContent,
  setPasteHtmlHandling,
} from '../../webview/utils/pasteHandler';

const TABLE_HTML = [
  '<table class="data" border="1">',
  '  <thead><tr><th>Name</th><th>Role</th></tr></thead>',
  '  <tbody>',
  '    <tr><td>Alice Johnson</td><td><b>Developer</b></td></tr>',
  '    <tr><td>Bob Smith</td><td>QA Engineer</td></tr>',
  '  </tbody>',
  '</table>',
].join('\n');

const TABLE_TEXT = 'Name\tRole\nAlice Johnson\tDeveloper\nBob Smith\tQA Engineer';

function fakeClipboard(html: string, text: string): DataTransfer {
  return {
    getData: (type: string) => (type === 'text/html' ? html : text),
    items: [] as unknown as DataTransferItemList,
  } as unknown as DataTransfer;
}

function createEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);

  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ paragraph: false } as never),
      MarkdownParagraph,
      BlankLinePreservation,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      HtmlPreservingTable.configure({ HTMLAttributes: { class: 'markdown-table' } }),
      TableRow,
      TableHeader,
      TableCell,
    ],
  });

  const instance =
    (editor as unknown as { markdown?: { instance?: unknown } }).markdown?.instance ??
    (editor as unknown as { storage?: { markdown?: { instance?: unknown } } }).storage?.markdown
      ?.instance;
  installBlankLineLexerNormalizer(instance);

  return editor;
}

type JsonNode = { type?: string; text?: string; content?: JsonNode[] };

function collectText(node: JsonNode): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(collectText).join('');
}

function readTableCells(editor: Editor): string[][] {
  const doc = editor.getJSON() as JsonNode;
  const table = (doc.content ?? []).find(node => node.type === 'table');
  if (!table) return [];
  return (table.content ?? []).map(row =>
    (row.content ?? []).map(cell => collectText(cell).trim())
  );
}

/**
 * Top-level node types, minus the single empty paragraph TipTap always keeps at
 * the end of the doc for cursor placement. Empty paragraphs anywhere else are
 * reported as `EMPTY-P` — those are the visible blank lines under test.
 */
function nodeTypes(editor: Editor): string[] {
  const doc = editor.getJSON() as JsonNode;
  const nodes = [...(doc.content ?? [])];
  const last = nodes[nodes.length - 1];
  if (last && last.type === 'paragraph' && !last.content) {
    nodes.pop();
  }
  return nodes.map(node =>
    node.type === 'paragraph' && !node.content ? 'EMPTY-P' : (node.type ?? '?')
  );
}

/** Paste, then report the markdown that would be written to disk. */
function pasteAndSave(html: string, text: string): { editor: Editor; saved: string } {
  const editor = createEditor();
  const result = processPasteContent(fakeClipboard(html, text));
  editor.commands.insertContent(result.content);
  return { editor, saved: getEditorMarkdownForSync(editor, 'preserve') };
}

describe('paste.htmlHandling setting', () => {
  afterEach(() => {
    setPasteHtmlHandling('preserveHtml');
  });

  it('defaults to preserveHtml', () => {
    expect(getPasteHtmlHandling()).toBe('preserveHtml');
  });

  it('ignores values that are not one of the two modes', () => {
    setPasteHtmlHandling('convertToMarkdown');
    setPasteHtmlHandling('somethingElse');
    expect(getPasteHtmlHandling()).toBe('convertToMarkdown');
  });

  describe('preserveHtml', () => {
    beforeEach(() => setPasteHtmlHandling('preserveHtml'));

    it('keeps the original table markup', () => {
      expect(htmlToMarkdown(TABLE_HTML)).toContain('<table');
      expect(htmlToMarkdown(TABLE_HTML)).not.toContain('| Name |');
    });

    it('saves the table as HTML', () => {
      const { editor, saved } = pasteAndSave(TABLE_HTML, TABLE_TEXT);
      try {
        expect(saved).toContain('<table');
        expect(saved).toContain('<th>Name</th>');
        expect(saved).not.toContain('| Name |');
      } finally {
        editor.destroy();
      }
    });
  });

  describe('convertToMarkdown', () => {
    beforeEach(() => setPasteHtmlHandling('convertToMarkdown'));

    it('rewrites the table as a GFM pipe table', () => {
      const markdown = htmlToMarkdown(TABLE_HTML);

      expect(markdown).not.toContain('<table');
      expect(markdown).toContain('| Name | Role |');
      expect(markdown).toContain('| --- | --- |');
      // Inline formatting inside a cell is kept.
      expect(markdown).toContain('**Developer**');
    });

    it('saves the table as markdown, not HTML', () => {
      const { editor, saved } = pasteAndSave(TABLE_HTML, TABLE_TEXT);
      try {
        expect(saved).not.toContain('<table');
        expect(saved).toMatch(/\|\s*Name\s*\|\s*Role\s*\|/);
        expect(saved).toMatch(/Alice Johnson/);
      } finally {
        editor.destroy();
      }
    });

    it('still produces a real table node in the editor', () => {
      const { editor } = pasteAndSave(TABLE_HTML, TABLE_TEXT);
      try {
        expect(readTableCells(editor)).toEqual([
          ['Name', 'Role'],
          ['Alice Johnson', 'Developer'],
          ['Bob Smith', 'QA Engineer'],
        ]);
      } finally {
        editor.destroy();
      }
    });

    it('synthesises a header for a table that has no <th>', () => {
      const markdown = htmlToMarkdown('<table><tr><td>a</td><td>b</td></tr></table>');
      expect(markdown.split('\n')[0]).toBe('|  |  |');
      expect(markdown).toContain('| a | b |');
    });

    it('pads short rows to a uniform column count', () => {
      const markdown = htmlToMarkdown(
        '<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td></tr></table>'
      );
      expect(markdown).toContain('| 1 |  |  |');
    });

    it('escapes pipes inside cell text', () => {
      const markdown = htmlToMarkdown('<table><tr><th>H</th></tr><tr><td>a|b</td></tr></table>');
      expect(markdown).toContain('a\\|b');
    });
  });

  /**
   * Pasting HTML *source* (copied from a file or editor, so the plain-text
   * flavour of the clipboard is the markup itself) is the paste most people use
   * to test this setting. `isRichHtml` deliberately refuses to convert it, so
   * before this the setting appeared to do nothing at all on that path.
   */
  describe('pasting HTML source text', () => {
    // The user's two samples. They differ only in indentation, which is what
    // made them behave differently once written to disk.
    const FOUR_SPACE_PAGE = [
      '<!DOCTYPE html>',
      '<html>',
      '<head>',
      '    <title>HTML Link and Table Example</title>',
      '</head>',
      '<body>',
      '',
      '    <h1>Welcome to My Web Page</h1>',
      '',
      '    <table border="1" cellpadding="8" cellspacing="0">',
      '        <tr><th>Name</th><th>Age</th></tr>',
      '        <tr><td>Alice</td><td>22</td></tr>',
      '    </table>',
      '',
      '</body>',
      '</html>',
    ].join('\n');

    const TWO_SPACE_PAGE = [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <title>My Web Page</title>',
      '</head>',
      '<body>',
      '  <table border="1">',
      '    <tr><th>Name</th><th>Age</th></tr>',
      '    <tr><td>Alice</td><td>25</td></tr>',
      '  </table>',
      '</body>',
      '</html>',
    ].join('\n');

    it('preserveHtml leaves the source literal', () => {
      setPasteHtmlHandling('preserveHtml');
      const result = processPasteContent(fakeClipboard(TWO_SPACE_PAGE, TWO_SPACE_PAGE));

      expect(result.wasConverted).toBe(false);
      expect(result.isHtml).toBe(false);
      expect(result.content).toBe(TWO_SPACE_PAGE);
    });

    it.each([
      ['4-space indented page', FOUR_SPACE_PAGE],
      ['2-space indented page', TWO_SPACE_PAGE],
    ])('convertToMarkdown converts the %s', (_label, page) => {
      setPasteHtmlHandling('convertToMarkdown');
      const result = processPasteContent(fakeClipboard(page, page));

      expect(result.wasConverted).toBe(true);
      expect(result.isHtml).toBe(true);
      expect(result.content).toContain('<table');
      expect(result.content).toContain('<th>Name</th>');
      // Indentation must not matter — neither page may come back as code.
      expect(result.content).not.toContain('<pre>');
      expect(result.content).not.toContain('<code>');
    });

    it.each([
      ['4-space indented page', FOUR_SPACE_PAGE],
      ['2-space indented page', TWO_SPACE_PAGE],
    ])('convertToMarkdown saves the %s as markdown', (_label, page) => {
      setPasteHtmlHandling('convertToMarkdown');
      const { editor, saved } = pasteAndSave(page, page);
      try {
        expect(saved).not.toContain('<table');
        expect(saved).not.toContain('```');
        expect(saved).toMatch(/\|\s*Name\s*\|\s*Age\s*\|/);
        expect(saved).toMatch(/Alice/);
      } finally {
        editor.destroy();
      }
    });

    it('leaves non-HTML plain text alone in either mode', () => {
      for (const mode of ['preserveHtml', 'convertToMarkdown'] as const) {
        setPasteHtmlHandling(mode);
        const result = processPasteContent(fakeClipboard('', 'just some prose'));
        expect(result.isHtml).toBe(false);
        expect(result.content).toBe('just some prose');
      }
    });
  });

  it('a pasted markdown pipe table is never saved back as HTML', () => {
    // Plain-text markdown paste routes through markdown-it too, so it hit the
    // same htmlOrigin trap as a converted table.
    const { editor, saved } = pasteAndSave('', '| A | B |\n| --- | --- |\n| 1 | 2 |');
    try {
      expect(saved).not.toContain('<table');
      expect(saved).toMatch(/\|\s*A\s*\|\s*B\s*\|/);
    } finally {
      editor.destroy();
    }
  });
});

describe('document scaffolding no longer leaves blank lines', () => {
  function load(markdown: string): string[] {
    const editor = createEditor();
    try {
      editor.commands.setContent(markdown, { contentType: 'markdown' });
      return nodeTypes(editor);
    } finally {
      editor.destroy();
    }
  }

  it.each([
    ['a doctype', '<!DOCTYPE html>'],
    ['closing wrapper tags', '</body>\n</html>'],
    ['an HTML comment', '<!-- just a note -->'],
    ['a stray closing tag', '</p>'],
  ])('drops %s instead of emitting an empty paragraph', (_label, scaffolding) => {
    expect(load(scaffolding)).toEqual([]);
  });

  it('does not insert a gap between blocks separated by scaffolding', () => {
    expect(load('# A\n\n<!-- note -->\n\n# B')).toEqual(['heading', 'heading']);
    expect(load('# A\n\n# B')).toEqual(['heading', 'heading']);
  });

  it('keeps HTML that renders even though it carries no text', () => {
    expect(load('<hr>')).toEqual(['horizontalRule']);
    // A table of empty cells has no text either, but it is still real content —
    // the emptiness heuristic must not swallow it.
    expect(load('<table><tr><td></td><td></td></tr></table>')).toEqual(['table']);
  });

  it('renders a full HTML page without leading blank lines', () => {
    expect(
      load(
        [
          '<!DOCTYPE html>',
          '<html>',
          '<head>',
          '<title>HTML Example</title>',
          '</head>',
          '<body>',
          '',
          '<h1>Welcome</h1>',
          '',
          '<table><tr><th>Name</th></tr><tr><td>Alice</td></tr></table>',
          '',
          '</body>',
          '</html>',
        ].join('\n')
      )
    ).toEqual(['heading', 'table']);
  });
});
