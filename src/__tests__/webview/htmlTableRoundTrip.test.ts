/**
 * @jest-environment jsdom
 */

/**
 * Regression coverage for HTML tables surviving the two conversion boundaries:
 *
 *  1. Paste  — clipboard HTML -> turndown -> markdown-it -> TipTap.
 *     Turndown ships no table rules and treats TABLE/TR/TD as block elements,
 *     so without an explicit `keep` every cell became its own paragraph and a
 *     4-column table pasted as one column of text.
 *
 *  2. Load   — markdown on disk -> marked -> ProseMirror.
 *     Marked ends an HTML block at the first blank line, so a pretty-printed
 *     table arrives as several `html` tokens. Parsed separately, table-scoped
 *     fragments are discarded by the HTML parser and the grid is flattened.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { BlankLinePreservation } from '../../webview/extensions/blankLinePreservation';
import {
  installBlankLineLexerNormalizer,
  mergeSplitHtmlBlocks,
} from '../../webview/utils/markedLexerNormalizer';
import { htmlToMarkdown, processPasteContent } from '../../webview/utils/pasteHandler';

const CLIPBOARD_TABLE_HTML = [
  '<table class="data">',
  '  <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Score</th></tr></thead>',
  '  <tbody>',
  '    <tr><td>Alice Johnson</td><td>Developer</td><td>Active</td><td>95</td></tr>',
  '    <tr><td>Bob Smith</td><td>QA Engineer</td><td>Active</td><td>89</td></tr>',
  '  </tbody>',
  '</table>',
].join('\n');

// What a browser puts on the plain-text flavour of the clipboard for a table.
const CLIPBOARD_TABLE_TEXT = [
  'Name\tRole\tStatus\tScore',
  'Alice Johnson\tDeveloper\tActive\t95',
  'Bob Smith\tQA Engineer\tActive\t89',
].join('\n');

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

  // Production installs this on the editor's marked instance after construction.
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

/** Row-major cell text, so a flattened table is obvious in a diff. */
function readTableCells(editor: Editor): string[][] {
  const doc = editor.getJSON() as JsonNode;
  const table = (doc.content ?? []).find(node => node.type === 'table');
  if (!table) return [];
  return (table.content ?? []).map(row =>
    (row.content ?? []).map(cell => collectText(cell).trim())
  );
}

describe('HTML table paste', () => {
  it('keeps the table markup instead of flattening cells into paragraphs', () => {
    const markdown = htmlToMarkdown(CLIPBOARD_TABLE_HTML);

    expect(markdown).toContain('<table');
    expect(markdown).toContain('<td>Alice Johnson</td>');
    // The old failure mode: every cell emitted as its own block.
    expect(markdown).not.toMatch(/^Alice Johnson$/m);
  });

  it('hands TipTap real table markup from a clipboard paste', () => {
    const result = processPasteContent(fakeClipboard(CLIPBOARD_TABLE_HTML, CLIPBOARD_TABLE_TEXT));

    expect(result.isHtml).toBe(true);
    expect(result.content).toContain('<table');
    expect(result.content).toContain('<th>Name</th>');
    // Regression guard: 12 cells must not arrive as 12 paragraphs.
    expect(result.content).not.toContain('<p>Alice Johnson</p>');
  });

  it('produces a real table node when the pasted markup is inserted', () => {
    const editor = createEditor();
    try {
      const result = processPasteContent(fakeClipboard(CLIPBOARD_TABLE_HTML, CLIPBOARD_TABLE_TEXT));
      editor.commands.insertContent(result.content);

      expect(readTableCells(editor)).toEqual([
        ['Name', 'Role', 'Status', 'Score'],
        ['Alice Johnson', 'Developer', 'Active', '95'],
        ['Bob Smith', 'QA Engineer', 'Active', '89'],
      ]);
    } finally {
      editor.destroy();
    }
  });
});

describe('HTML table load from markdown', () => {
  it('round-trips a compact HTML table', () => {
    const editor = createEditor();
    try {
      editor.commands.setContent(
        [
          '<table class="markdown-table">',
          '  <tr><th>Name</th><th>Role</th></tr>',
          '  <tr><td>Alice Johnson</td><td>Developer</td></tr>',
          '</table>',
        ].join('\n'),
        { contentType: 'markdown' }
      );

      expect(readTableCells(editor)).toEqual([
        ['Name', 'Role'],
        ['Alice Johnson', 'Developer'],
      ]);
      expect(editor.getMarkdown()).toContain('<table class="markdown-table">');
    } finally {
      editor.destroy();
    }
  });

  it('rebuilds a table whose HTML block is split by blank lines', () => {
    const editor = createEditor();
    try {
      editor.commands.setContent(
        [
          '<table class="markdown-table">',
          '  <thead>',
          '    <tr><th>Name</th><th>Role</th></tr>',
          '  </thead>',
          '',
          '  <tbody>',
          '    <tr><td>Alice Johnson</td><td>Developer</td></tr>',
          '    <tr><td>Bob Smith</td><td>QA Engineer</td></tr>',
          '  </tbody>',
          '</table>',
        ].join('\n'),
        { contentType: 'markdown' }
      );

      // Before the fix the <tbody> half was parsed on its own, the HTML parser
      // discarded the orphaned rows, and only the header survived as a table.
      expect(readTableCells(editor)).toEqual([
        ['Name', 'Role'],
        ['Alice Johnson', 'Developer'],
        ['Bob Smith', 'QA Engineer'],
      ]);
    } finally {
      editor.destroy();
    }
  });

  it('leaves GFM pipe tables as pipe tables', () => {
    const editor = createEditor();
    try {
      editor.commands.setContent(['| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n'), {
        contentType: 'markdown',
      });

      const serialized = editor.getMarkdown();
      // Columns are padded to a common width, so match on structure not spacing.
      expect(serialized).toMatch(/\|\s*A\s*\|\s*B\s*\|/);
      expect(serialized).toMatch(/\|\s*-+\s*\|/);
      expect(serialized).not.toContain('<table');
    } finally {
      editor.destroy();
    }
  });
});

describe('mergeSplitHtmlBlocks', () => {
  const html = (raw: string) => ({ type: 'html', raw, text: raw, block: true });
  const space = (raw: string) => ({ type: 'space', raw });

  it('merges fragments of one unclosed container', () => {
    const merged = mergeSplitHtmlBlocks([
      html('<table>\n<thead><tr><th>A</th></tr></thead>\n'),
      space('\n'),
      html('<tbody><tr><td>1</td></tr></tbody>\n</table>\n'),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].type).toBe('html');
    expect(merged[0].raw).toContain('<thead>');
    expect(merged[0].raw).toContain('<tbody>');
    expect(merged[0].raw).toContain('</table>');
  });

  it('preserves the block flag on the merged token', () => {
    const merged = mergeSplitHtmlBlocks([
      html('<ul>\n<li>a</li>\n'),
      space('\n'),
      html('<li>b</li>\n</ul>\n'),
    ]);

    expect(merged[0].block).toBe(true);
    expect(merged[0].text).toBe(merged[0].raw);
  });

  it('leaves balanced HTML blocks untouched', () => {
    const tokens = [html('<div>one</div>\n'), space('\n'), html('<div>two</div>\n')];
    expect(mergeSplitHtmlBlocks(tokens)).toEqual(tokens);
  });

  it('leaves a never-closed block untouched rather than swallowing the document', () => {
    const tokens = [
      html('<table>\n<tr><td>orphan</td></tr>\n'),
      space('\n'),
      { type: 'paragraph', raw: 'Unrelated text\n' },
    ];
    expect(mergeSplitHtmlBlocks(tokens)).toEqual(tokens);
  });

  it('stops at the first non-HTML token instead of absorbing markdown', () => {
    const paragraph = { type: 'paragraph', raw: 'Body copy\n' };
    const closing = html('</table>\n');
    const tokens = [html('<table>\n<tr><td>\n'), space('\n'), paragraph, closing];

    // The run never balances before the paragraph, so nothing is merged.
    expect(mergeSplitHtmlBlocks(tokens)).toEqual(tokens);
  });

  it('ignores tags inside comments', () => {
    const tokens = [html('<!-- <table> -->\n')];
    expect(mergeSplitHtmlBlocks(tokens)).toEqual(tokens);
  });

  it('does not open a scope for void or self-closing tags', () => {
    const tokens = [html('<img src="a.png">\n'), space('\n'), html('<br/>\n')];
    expect(mergeSplitHtmlBlocks(tokens)).toEqual(tokens);
  });
});
