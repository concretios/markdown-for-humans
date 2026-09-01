/** @jest-environment jsdom */

import { Editor } from '@tiptap/core';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import {
  buildFeedbackTableCellEvidence,
  fingerprintFeedbackTable,
} from '../../webview/features/feedbackSelectionMapping';

function paragraph(text: string): Record<string, unknown> {
  return { type: 'paragraph', content: text === '' ? [] : [{ type: 'text', text }] };
}

function createTableEditor(values: readonly (readonly string[])[]): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  return new Editor({
    element,
    extensions: [StarterKit, Table, TableRow, TableHeader, TableCell],
    content: {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: values.map((row, rowIndex) => ({
            type: 'tableRow',
            content: row.map(text => ({
              type: rowIndex === 0 ? 'tableHeader' : 'tableCell',
              content: [paragraph(text)],
            })),
          })),
        },
      ],
    },
  });
}

function targetForTable(table: ProseMirrorNode, rows: number, columns: number) {
  return {
    version: 1 as const,
    tableOrdinal: 0,
    rectangle: { top: 0, left: 0, bottom: rows, right: columns },
    tableFingerprint: fingerprintFeedbackTable({ version: 1, tableOrdinal: 0, table }).fingerprint,
  };
}

describe('Feedback typed table-cell evidence', () => {
  afterEach(() => document.body.replaceChildren());

  it('preserves a rectangular matrix, literal cell text, and header roles', () => {
    const editor = createTableEditor([
      ['Name', 'Notes'],
      ['A\\B', 'left\tright\nnext'],
    ]);
    try {
      const table = editor.state.doc.child(0);
      expect(buildFeedbackTableCellEvidence(editor.state.doc, targetForTable(table, 2, 2))).toEqual(
        {
          kind: 'table-cells',
          complete: true,
          rows: [
            [
              { role: 'header', text: 'Name', complete: true },
              { role: 'header', text: 'Notes', complete: true },
            ],
            [
              { role: 'data', text: 'A\\B', complete: true },
              { role: 'data', text: 'left\tright\nnext', complete: true },
            ],
          ],
        }
      );
    } finally {
      editor.destroy();
    }
  });

  it('keeps every cell while explicitly marking per-cell and matrix truncation', () => {
    const editor = createTableEditor([['Header'], ['λ'.repeat(300)]]);
    try {
      const table = editor.state.doc.child(0);
      const evidence = buildFeedbackTableCellEvidence(
        editor.state.doc,
        targetForTable(table, 2, 1)
      );
      expect(evidence?.rows).toHaveLength(2);
      expect(evidence?.rows[1][0]).toEqual({
        role: 'data',
        text: 'λ'.repeat(240),
        complete: false,
      });
      expect(evidence?.complete).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('applies the 64 KiB UTF-8 item budget without dropping matrix cells or splitting Unicode', () => {
    const editor = createTableEditor(
      Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => '😀'.repeat(240)))
    );
    try {
      const table = editor.state.doc.child(0);
      const evidence = buildFeedbackTableCellEvidence(
        editor.state.doc,
        targetForTable(table, 16, 16)
      );
      expect(evidence?.rows).toHaveLength(16);
      expect(evidence?.rows.every(row => row.length === 16)).toBe(true);
      expect(evidence?.complete).toBe(false);
      const bytes = evidence?.rows.reduce(
        (total, row) =>
          total +
          row.reduce((rowTotal, cell) => rowTotal + Buffer.byteLength(cell.text, 'utf8'), 0),
        0
      );
      expect(bytes).toBeLessThanOrEqual(64 * 1024);
      expect(evidence?.rows.every(row => row.every(cell => !cell.text.includes('\ufffd')))).toBe(
        true
      );
    } finally {
      editor.destroy();
    }
  });

  it('rejects a stale table fingerprint before producing semantic evidence', () => {
    const editor = createTableEditor([['Header'], ['Value']]);
    try {
      expect(
        buildFeedbackTableCellEvidence(editor.state.doc, {
          ...targetForTable(editor.state.doc.child(0), 2, 1),
          tableFingerprint: 'md4h-table/v1:0123456789abcdef',
        })
      ).toBeNull();
    } finally {
      editor.destroy();
    }
  });
});
