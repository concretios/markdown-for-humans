/** @jest-environment jsdom */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { sortTableRowsByColumn, TableSorting } from '../../webview/extensions/tableSorting';

function createTableEditor(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);

  return new Editor({
    element,
    extensions: [StarterKit, HtmlPreservingTable, TableRow, TableHeader, TableCell, TableSorting],
    content,
  });
}

describe('TableSorting extension', () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
    document.body.replaceChildren();
  });

  it('sorts body rows by text while preserving the header row', () => {
    editor = createTableEditor(
      '<table><tbody><tr><th>Name</th><th>Score</th></tr><tr><td>Charlie</td><td>2</td></tr><tr><td>Alice</td><td>3</td></tr><tr><td>Bob</td><td>1</td></tr></tbody></table>'
    );

    expect(sortTableRowsByColumn(editor.view, 0, 0, 'asc')).toBe(true);

    const html = editor.getHTML();
    expect(html.indexOf('Name')).toBeLessThan(html.indexOf('Alice'));
    expect(html.indexOf('Alice')).toBeLessThan(html.indexOf('Bob'));
    expect(html.indexOf('Bob')).toBeLessThan(html.indexOf('Charlie'));
  });

  it('sorts numeric columns descending', () => {
    editor = createTableEditor(
      '<table><tbody><tr><th>Name</th><th>Score</th></tr><tr><td>Charlie</td><td>2</td></tr><tr><td>Alice</td><td>30</td></tr><tr><td>Bob</td><td>10</td></tr></tbody></table>'
    );

    expect(sortTableRowsByColumn(editor.view, 0, 1, 'desc')).toBe(true);

    const html = editor.getHTML();
    expect(html.indexOf('Alice')).toBeLessThan(html.indexOf('Bob'));
    expect(html.indexOf('Bob')).toBeLessThan(html.indexOf('Charlie'));
  });
});
