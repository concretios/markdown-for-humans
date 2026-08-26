/** @jest-environment jsdom */

import { Editor } from '@tiptap/core';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import StarterKit from '@tiptap/starter-kit';
import {
  fingerprintFeedbackTable,
  mapFeedbackSelection,
  resolveFeedbackCellTarget,
  type FeedbackSelectionMappingInput,
} from '../../webview/features/feedbackSelectionMapping';

function createEditor(content: Record<string, unknown>): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  return new Editor({
    element,
    extensions: [StarterKit, Table, TableRow, TableHeader, TableCell],
    content,
  });
}

function paragraph(text: string): Record<string, unknown> {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function rectangularTable(rows: number, columns: number): Record<string, unknown> {
  return {
    type: 'doc',
    content: [
      {
        type: 'table',
        content: Array.from({ length: rows }, (_, row) => ({
          type: 'tableRow',
          content: Array.from({ length: columns }, (_, column) => ({
            type: row === 0 ? 'tableHeader' : 'tableCell',
            content: [paragraph(row === 0 ? `H${column + 1}` : `R${row}C${column + 1}`)],
          })),
        })),
      },
    ],
  };
}

function cellPositions(doc: ProseMirrorNode): number[] {
  const positions: number[] = [];
  doc.descendants((node, position) => {
    if (node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell') {
      positions.push(position);
    }
  });
  return positions;
}

function cellSelectionInput(
  doc: ProseMirrorNode,
  anchorCell: number,
  headCell: number,
  nativeSelection: FeedbackSelectionMappingInput['nativeSelection'] = { kind: 'unavailable' }
): FeedbackSelectionMappingInput {
  return {
    doc,
    selection: CellSelection.create(doc, anchorCell, headCell),
    mappedOrdinals: [0],
    nativeSelection,
  };
}

function textDocument(): Record<string, unknown> {
  return {
    type: 'doc',
    content: [paragraph('Alpha beta'), paragraph('Gamma delta')],
  };
}

function tableNodes(
  schema: Schema,
  rows: readonly (readonly ProseMirrorNode[])[]
): ProseMirrorNode {
  const rowType = schema.nodes.tableRow;
  const tableType = schema.nodes.table;
  return tableType.create(
    null,
    rows.map(cells => rowType.create(null, cells))
  );
}

function tableCell(
  schema: Schema,
  text: string,
  options: { readonly header?: boolean; readonly colspan?: number; readonly rowspan?: number } = {}
): ProseMirrorNode {
  const cellType = options.header ? schema.nodes.tableHeader : schema.nodes.tableCell;
  return cellType.create(
    {
      colspan: options.colspan ?? 1,
      rowspan: options.rowspan ?? 1,
      colwidth: null,
    },
    schema.nodes.paragraph.create(null, schema.text(text))
  );
}

describe('typed Feedback selection mapping', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it.each([
    { direction: 'forward', anchorIndex: 0, headIndex: 15 },
    { direction: 'backward', anchorIndex: 15, headIndex: 0 },
  ])('maps a $direction 4x4 CellSelection to one rectangular cell target', testCase => {
    const editor = createEditor(rectangularTable(4, 4));
    const cells = cellPositions(editor.state.doc);

    const result = mapFeedbackSelection(
      cellSelectionInput(editor.state.doc, cells[testCase.anchorIndex], cells[testCase.headIndex], {
        kind: 'collapsed-inside',
      })
    );

    expect(result).toEqual({
      kind: 'cells',
      authority: 'prosemirror-structural',
      tableOrdinal: 0,
      rectangle: { top: 0, left: 0, bottom: 4, right: 4 },
      tableFingerprint: expect.stringMatching(/^md4h-table\/v1:[0-9a-f]{16}$/),
      blockRange: { fromOrdinal: 0, toOrdinal: 0 },
      focusText: [
        'H1\tH2\tH3\tH4',
        'R1C1\tR1C2\tR1C3\tR1C4',
        'R2C1\tR2C2\tR2C3\tR2C4',
        'R3C1\tR3C2\tR3C3\tR3C4',
      ].join('\n'),
    });
    editor.destroy();
  });

  it('maps ordinary header cells without downgrading their structural selection', () => {
    const editor = createEditor(rectangularTable(3, 4));
    const cells = cellPositions(editor.state.doc);

    const result = mapFeedbackSelection(
      cellSelectionInput(editor.state.doc, cells[0], cells[2], { kind: 'collapsed-inside' })
    );

    expect(result).toMatchObject({
      kind: 'cells',
      rectangle: { top: 0, left: 0, bottom: 1, right: 3 },
      focusText: 'H1\tH2\tH3',
    });
    editor.destroy();
  });

  it('keeps CellSelection authoritative over a transient collapsed native caret', () => {
    const editor = createEditor(rectangularTable(2, 2));
    const cells = cellPositions(editor.state.doc);

    const result = mapFeedbackSelection(
      cellSelectionInput(editor.state.doc, cells[0], cells[3], {
        kind: 'collapsed-inside',
      })
    );

    expect(result.kind).toBe('cells');
    if (result.kind === 'cells') {
      expect(result.authority).toBe('prosemirror-structural');
      expect(result.rectangle).toEqual({ top: 0, left: 0, bottom: 2, right: 2 });
    }
    editor.destroy();
  });

  it('falls back to the containing table block when selected cells are merged', () => {
    const schemaEditor = createEditor(rectangularTable(2, 3));
    const schema = schemaEditor.schema;
    const table = tableNodes(schema, [
      [
        tableCell(schema, 'Merged', { header: true, colspan: 2 }),
        tableCell(schema, 'H3', { header: true }),
      ],
      [tableCell(schema, 'A'), tableCell(schema, 'B'), tableCell(schema, 'C')],
    ]);
    const doc = schema.topNodeType.create(null, table);
    const cells = cellPositions(doc);

    const result = mapFeedbackSelection(cellSelectionInput(doc, cells[0], cells[4]));

    expect(result).toMatchObject({
      kind: 'blocks',
      authority: 'prosemirror-structural',
      blockRange: { fromOrdinal: 0, toOrdinal: 0 },
      reason: 'merged-table-cells',
    });
    if (result.kind === 'blocks') expect(result.focusText).toContain('Merged');
    schemaEditor.destroy();
  });

  it('falls back to the containing table block for an irregular table map', () => {
    const schemaEditor = createEditor(rectangularTable(2, 2));
    const schema = schemaEditor.schema;
    const table = tableNodes(schema, [
      [tableCell(schema, 'H1', { header: true }), tableCell(schema, 'H2', { header: true })],
      [tableCell(schema, 'Only one')],
    ]);
    const doc = schema.topNodeType.create(null, table);
    const cells = cellPositions(doc);

    const result = mapFeedbackSelection(cellSelectionInput(doc, cells[0], cells[2]));

    expect(result).toMatchObject({
      kind: 'blocks',
      blockRange: { fromOrdinal: 0, toOrdinal: 0 },
      reason: 'irregular-table',
    });
    schemaEditor.destroy();
  });

  it('returns an explicit failure when the containing table is not source-mapped', () => {
    const editor = createEditor(rectangularTable(2, 2));
    const cells = cellPositions(editor.state.doc);
    const input = cellSelectionInput(editor.state.doc, cells[0], cells[3]);

    const result = mapFeedbackSelection({ ...input, mappedOrdinals: [] });

    expect(result).toEqual({ kind: 'failure', reason: 'unmapped-block' });
    editor.destroy();
  });

  it('keeps CellSelection authoritative over a transient native selection outside the editor', () => {
    const editor = createEditor(rectangularTable(2, 2));
    const cells = cellPositions(editor.state.doc);

    const result = mapFeedbackSelection(
      cellSelectionInput(editor.state.doc, cells[0], cells[3], {
        kind: 'outside-editor',
      })
    );

    expect(result).toMatchObject({
      kind: 'cells',
      authority: 'prosemirror-structural',
      rectangle: { top: 0, left: 0, bottom: 2, right: 2 },
    });
    editor.destroy();
  });

  it('reports an outside-editor native selection for a non-structural selection', () => {
    const editor = createEditor(textDocument());

    const result = mapFeedbackSelection({
      doc: editor.state.doc,
      selection: TextSelection.create(editor.state.doc, 1, 6),
      mappedOrdinals: [0, 1],
      nativeSelection: { kind: 'outside-editor' },
    });

    expect(result).toEqual({ kind: 'failure', reason: 'native-selection-outside-editor' });
    editor.destroy();
  });

  it('maps a non-empty ProseMirror text selection to an exact text target', () => {
    const editor = createEditor(textDocument());

    const result = mapFeedbackSelection({
      doc: editor.state.doc,
      selection: TextSelection.create(editor.state.doc, 1, 6),
      mappedOrdinals: [0, 1],
      nativeSelection: { kind: 'unavailable' },
    });

    expect(result).toEqual({
      kind: 'text',
      authority: 'prosemirror-text',
      blockRange: { fromOrdinal: 0, toOrdinal: 0 },
      renderedRange: {
        version: 1,
        startOrdinal: 0,
        startOffset: 0,
        endOrdinal: 0,
        endOffset: 5,
      },
      focusText: 'Alpha',
    });
    editor.destroy();
  });

  it('uses a live mapped native range instead of a stale regular text selection', () => {
    const editor = createEditor(textDocument());

    const result = mapFeedbackSelection({
      doc: editor.state.doc,
      selection: TextSelection.create(editor.state.doc, 1, 6),
      mappedOrdinals: [0, 1],
      nativeSelection: {
        kind: 'text',
        target: {
          blockRange: { fromOrdinal: 1, toOrdinal: 1 },
          renderedRange: {
            version: 1,
            startOrdinal: 1,
            startOffset: 0,
            endOrdinal: 1,
            endOffset: 5,
          },
          focusText: 'Gamma',
        },
      },
    });

    expect(result).toMatchObject({
      kind: 'text',
      authority: 'native-text',
      blockRange: { fromOrdinal: 1, toOrdinal: 1 },
      focusText: 'Gamma',
    });
    editor.destroy();
  });

  it('does not reuse a stale regular text range after the native caret collapses', () => {
    const editor = createEditor(textDocument());

    const result = mapFeedbackSelection({
      doc: editor.state.doc,
      selection: TextSelection.create(editor.state.doc, 1, 6),
      mappedOrdinals: [0, 1],
      nativeSelection: { kind: 'collapsed-inside' },
    });

    expect(result).toEqual({ kind: 'failure', reason: 'native-selection-collapsed' });
    editor.destroy();
  });

  it('maps a structural node selection to an explicit block target', () => {
    const editor = createEditor(textDocument());

    const result = mapFeedbackSelection({
      doc: editor.state.doc,
      selection: NodeSelection.create(editor.state.doc, 0),
      mappedOrdinals: [0, 1],
      nativeSelection: { kind: 'collapsed-inside' },
    });

    expect(result).toEqual({
      kind: 'blocks',
      authority: 'prosemirror-structural',
      blockRange: { fromOrdinal: 0, toOrdinal: 0 },
      focusText: 'Alpha beta',
      reason: 'structural-node-selection',
    });
    editor.destroy();
  });

  it('defines a deterministic, content-sensitive table fingerprint contract', () => {
    const first = createEditor(rectangularTable(2, 2));
    const same = createEditor(rectangularTable(2, 2));
    const changed = createEditor({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [paragraph('Changed')] },
                { type: 'tableHeader', content: [paragraph('H2')] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [paragraph('R1C1')] },
                { type: 'tableCell', content: [paragraph('R1C2')] },
              ],
            },
          ],
        },
      ],
    });
    const firstTable = first.state.doc.child(0);
    const sameTable = same.state.doc.child(0);
    const changedTable = changed.state.doc.child(0);

    const firstFingerprint = fingerprintFeedbackTable({
      version: 1,
      tableOrdinal: 0,
      table: firstTable,
    });
    const sameFingerprint = fingerprintFeedbackTable({
      version: 1,
      tableOrdinal: 0,
      table: sameTable,
    });
    const changedFingerprint = fingerprintFeedbackTable({
      version: 1,
      tableOrdinal: 0,
      table: changedTable,
    });

    expect(firstFingerprint).toEqual({
      version: 1,
      tableOrdinal: 0,
      fingerprint: expect.stringMatching(/^md4h-table\/v1:[0-9a-f]{16}$/),
    });
    expect(sameFingerprint).toEqual(firstFingerprint);
    expect(changedFingerprint.fingerprint).not.toBe(firstFingerprint.fingerprint);
    first.destroy();
    same.destroy();
    changed.destroy();
  });

  it('resolves a persisted rectangle to exact current cell-node boundaries', () => {
    const editor = createEditor(rectangularTable(4, 4));
    const table = editor.state.doc.child(0);
    const tableFingerprint = fingerprintFeedbackTable({
      version: 1,
      tableOrdinal: 0,
      table,
    }).fingerprint;

    const result = resolveFeedbackCellTarget(editor.state.doc, {
      version: 1,
      tableOrdinal: 0,
      rectangle: { top: 1, left: 1, bottom: 3, right: 3 },
      tableFingerprint,
    });

    expect(result.kind).toBe('cells');
    if (result.kind === 'cells') {
      expect(result.cells.map(cell => editor.state.doc.nodeAt(cell.from)?.textContent)).toEqual([
        'R1C2',
        'R1C3',
        'R2C2',
        'R2C3',
      ]);
      expect(
        result.cells.every(
          cell => editor.state.doc.nodeAt(cell.from)?.nodeSize === cell.to - cell.from
        )
      ).toBe(true);
    }
    editor.destroy();
  });

  it('fails closed when persisted cell metadata has a stale fingerprint or invalid bounds', () => {
    const editor = createEditor(rectangularTable(2, 2));
    const tableFingerprint = fingerprintFeedbackTable({
      version: 1,
      tableOrdinal: 0,
      table: editor.state.doc.child(0),
    }).fingerprint;

    expect(
      resolveFeedbackCellTarget(editor.state.doc, {
        version: 1,
        tableOrdinal: 0,
        rectangle: { top: 0, left: 0, bottom: 1, right: 1 },
        tableFingerprint: 'md4h-table/v1:0123456789abcdef',
      })
    ).toEqual({ kind: 'fallback' });
    expect(
      resolveFeedbackCellTarget(editor.state.doc, {
        version: 1,
        tableOrdinal: 0,
        rectangle: { top: 0, left: 0, bottom: 3, right: 2 },
        tableFingerprint,
      })
    ).toEqual({ kind: 'fallback' });
    editor.destroy();
  });

  it('fails restored cell geometry closed for a merged table', () => {
    const schemaEditor = createEditor(rectangularTable(2, 3));
    const schema = schemaEditor.schema;
    const table = tableNodes(schema, [
      [
        tableCell(schema, 'Merged', { header: true, colspan: 2 }),
        tableCell(schema, 'H3', { header: true }),
      ],
      [tableCell(schema, 'A'), tableCell(schema, 'B'), tableCell(schema, 'C')],
    ]);
    const doc = schema.topNodeType.create(null, table);
    const tableFingerprint = fingerprintFeedbackTable({
      version: 1,
      tableOrdinal: 0,
      table,
    }).fingerprint;

    expect(
      resolveFeedbackCellTarget(doc, {
        version: 1,
        tableOrdinal: 0,
        rectangle: { top: 0, left: 0, bottom: 2, right: 3 },
        tableFingerprint,
      })
    ).toEqual({ kind: 'fallback' });
    schemaEditor.destroy();
  });
});
