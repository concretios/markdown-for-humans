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
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { isMarkdownStructurallyEquivalent } from '../../editor/markdownAstEquivalence';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { BlankLinePreservation } from '../../webview/extensions/blankLinePreservation';
import {
  installBlankLineLexerNormalizer,
  mergeSplitHtmlBlocks,
} from '../../webview/utils/markedLexerNormalizer';
import { htmlToMarkdown, processPasteContent } from '../../webview/utils/pasteHandler';
import { getEditorMarkdownForSync } from '../../webview/utils/markdownSerialization';

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

  it('preserves merged-cell spans when serializing an HTML-origin table', () => {
    const editor = createEditor();
    try {
      const source = [
        '<table>',
        '  <tr><th rowspan="2">State</th><th colspan="2">Actions</th></tr>',
        '  <tr><td>Review</td><td>Approve</td></tr>',
        '</table>',
      ].join('\n');
      editor.commands.setContent(source, { contentType: 'markdown' });

      const serialized = getEditorMarkdownForSync(editor, 'strip');
      expect(serialized).toContain('<th rowspan="2">State</th>');
      expect(serialized).toContain('<th colspan="2">Actions</th>');
      expect(isMarkdownStructurallyEquivalent(serialized, source)).toBe(true);
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

  it('keeps the Feedback v2 golden source structurally equivalent after serialization', () => {
    const editor = createEditor();
    const source = readFileSync(
      resolve(__dirname, '../fixtures/feedback-evidence-v2/source.md'),
      'utf8'
    );
    try {
      editor.commands.setContent(source, { contentType: 'markdown' });

      const serialized = getEditorMarkdownForSync(editor, 'strip');
      expect(serialized).toContain('Password \\| reset');
      expect(serialized).toContain('<th colspan="2">Actions</th>');
      expect(isMarkdownStructurallyEquivalent(serialized, source)).toBe(true);
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

describe('markdown-origin tables are never saved back as HTML', () => {
  it('a pasted markdown pipe table is never saved back as HTML', () => {
    // Plain-text markdown paste routes through markdown-it too, so a pasted
    // pipe table hit the same htmlOrigin trap as an HTML table: every
    // DOM-parsed table used to be tagged htmlOrigin regardless of how it was
    // authored, which meant a plain markdown table would round-trip back out
    // as `<table>` markup on the very first save.
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

  /**
   * `@tiptap/markdown` runs each HTML token through `generateJSON`, and a
   * fragment with no renderable content still yields a doc holding one empty
   * paragraph — which lands in the document as a blank line. So a bare
   * doctype, the `<html>`/`<body>` wrapper, a comment, or a stray closing tag
   * each inserted a visible gap. These assert that scaffolding is dropped
   * instead.
   */
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
