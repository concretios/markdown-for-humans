/**
 * @jest-environment jsdom
 *
 * Enter inside table cells must insert a hardBreak (GFM `<br>` / HTML newline),
 * not a second paragraph. Multi-paragraph cells corrupt HTML-origin serialization
 * (collectText joins without separators) and leave pipe tables harder to round-trip.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import type { JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { TableCellEnterHardBreak } from '../../webview/extensions/tableCellEnterHardBreak';

const PIPE_TABLE = `| Name | Notes |
| ---- | ----- |
| hello | world |`;

const HTML_TABLE = [
  '<table class="sq-table">',
  '  <tr><th>Column A</th><th>Column B</th></tr>',
  '  <tr><td>Value 1</td><td>Value 2</td></tr>',
  '</table>',
].join('\n');

function createTableEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);

  return new Editor({
    element,
    extensions: [
      StarterKit,
      Markdown.configure({
        markedOptions: {
          gfm: true,
          breaks: true,
        },
      }),
      HtmlPreservingTable,
      TableRow,
      TableHeader,
      TableCell,
      TableCellEnterHardBreak,
    ],
  });
}

function findFirstCellTextPos(
  editor: Editor,
  cellType: 'tableCell' | 'tableHeader'
): number {
  let textPos: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === cellType && textPos === null) {
      // Cell → paragraph → text offset
      textPos = pos + 2;
      return false;
    }
    return undefined;
  });
  if (textPos === null) {
    throw new Error(`Could not find ${cellType}`);
  }
  return textPos;
}

function cellAt(
  doc: JSONContent,
  rowIndex: number,
  columnIndex: number
): JSONContent {
  const table = doc.content?.[0];
  const row = table?.content?.[rowIndex];
  const cell = row?.content?.[columnIndex];
  if (!cell) {
    throw new Error(`Missing cell at ${rowIndex},${columnIndex}`);
  }
  return cell;
}

function countParagraphs(cell: JSONContent): number {
  return (cell.content ?? []).filter(child => child.type === 'paragraph').length;
}

function hasHardBreak(cell: JSONContent): boolean {
  return JSON.stringify(cell).includes('"type":"hardBreak"');
}

function placeCaretInCell(
  editor: Editor,
  cellType: 'tableCell' | 'tableHeader',
  offsetWithinCellText: number
): void {
  const pos = findFirstCellTextPos(editor, cellType) + offsetWithinCellText;
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
}

describe('TableCellEnterHardBreak', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('Enter in a GFM tableCell inserts hardBreak and keeps a single paragraph', () => {
    const editor = createTableEditor();
    try {
      editor.commands.setContent(PIPE_TABLE, { contentType: 'markdown' });
      placeCaretInCell(editor, 'tableCell', 'hello'.length);

      expect(editor.commands.keyboardShortcut('Enter')).toBe(true);

      const cell = cellAt(editor.getJSON(), 1, 0);
      expect(countParagraphs(cell)).toBe(1);
      expect(hasHardBreak(cell)).toBe(true);

      const markdown = editor.getMarkdown();
      expect(markdown).toMatch(/\|[^\n]*hello<br>[^\n]*\|[^\n]*world[^\n]*\|/);
      expect(markdown.split('\n').filter(line => line.includes('|')).length).toBeGreaterThanOrEqual(
        3
      );
    } finally {
      editor.destroy();
    }
  });

  it('Enter in a tableHeader inserts hardBreak and keeps a single paragraph', () => {
    const editor = createTableEditor();
    try {
      editor.commands.setContent(PIPE_TABLE, { contentType: 'markdown' });
      placeCaretInCell(editor, 'tableHeader', 'Name'.length);

      expect(editor.commands.keyboardShortcut('Enter')).toBe(true);

      const header = cellAt(editor.getJSON(), 0, 0);
      expect(countParagraphs(header)).toBe(1);
      expect(hasHardBreak(header)).toBe(true);

      const markdown = editor.getMarkdown();
      expect(markdown).toMatch(/\|[^\n]*Name<br>[^\n]*\|/);
    } finally {
      editor.destroy();
    }
  });

  it('Shift-Enter in a tableCell inserts hardBreak (same contract as Enter)', () => {
    const editor = createTableEditor();
    try {
      editor.commands.setContent(PIPE_TABLE, { contentType: 'markdown' });
      placeCaretInCell(editor, 'tableCell', 3); // mid "hello"

      expect(editor.commands.keyboardShortcut('Shift-Enter')).toBe(true);

      const cell = cellAt(editor.getJSON(), 1, 0);
      expect(countParagraphs(cell)).toBe(1);
      expect(hasHardBreak(cell)).toBe(true);
      expect(JSON.stringify(cell)).toContain('"text":"hel"');
      expect(JSON.stringify(cell)).toContain('"text":"lo"');
    } finally {
      editor.destroy();
    }
  });

  it('Enter mid-cell in an HTML-origin table serializes a newline via hardBreak', () => {
    const editor = createTableEditor();
    try {
      editor.commands.setContent(HTML_TABLE, { contentType: 'markdown' });
      placeCaretInCell(editor, 'tableCell', 3); // after "Val"

      expect(editor.commands.keyboardShortcut('Enter')).toBe(true);

      const cell = cellAt(editor.getJSON(), 1, 0);
      expect(countParagraphs(cell)).toBe(1);
      expect(hasHardBreak(cell)).toBe(true);

      const markdown = editor.getMarkdown();
      expect(markdown).toContain('<td>Val\nue 1</td>');
      expect(markdown).toContain('<table class="sq-table">');
    } finally {
      editor.destroy();
    }
  });

  it('Enter outside tables still creates a new paragraph', () => {
    const editor = createTableEditor();
    try {
      editor.commands.setContent('Hello world', { contentType: 'markdown' });
      editor.commands.setTextSelection(6); // after "Hello"

      expect(editor.commands.keyboardShortcut('Enter')).toBe(true);

      const doc = editor.getJSON();
      const paragraphs = (doc.content ?? []).filter(node => node.type === 'paragraph');
      expect(paragraphs.length).toBeGreaterThanOrEqual(2);
      expect(editor.getMarkdown()).not.toContain('<br>');
    } finally {
      editor.destroy();
    }
  });
});
