/**
 * @jest-environment jsdom
 */

import { Schema, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  createFeedbackTargetPresentationView,
  FEEDBACK_CELL_PREVIEW_COLUMN_LIMIT,
  FEEDBACK_CELL_PREVIEW_ROW_LIMIT,
  getFeedbackTargetPresentation,
} from '../../webview/features/feedbackTargetPresentation';
import { fingerprintFeedbackTable } from '../../webview/features/feedbackSelectionMapping';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: {
      content: 'inline*',
      group: 'block',
      attrs: { level: { default: 2 } },
    },
    codeBlock: {
      content: 'text*',
      group: 'block',
      code: true,
      attrs: { language: { default: null } },
    },
    mermaid: {
      content: 'text*',
      group: 'block',
      code: true,
      attrs: { language: { default: 'mermaid' } },
    },
    mathBlock: {
      content: 'text*',
      group: 'block',
      code: true,
      attrs: { latex: { default: '' } },
    },
    image: {
      group: 'block',
      atom: true,
      attrs: {
        src: { default: '' },
        alt: { default: '' },
        title: { default: null },
      },
    },
    table: {
      content: 'tableRow+',
      group: 'block',
      tableRole: 'table',
      isolating: true,
    },
    tableRow: { content: '(tableHeader | tableCell)+', tableRole: 'row' },
    tableHeader: {
      content: 'paragraph+',
      tableRole: 'header_cell',
      isolating: true,
      attrs: {
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
      },
    },
    tableCell: {
      content: 'paragraph+',
      tableRole: 'cell',
      isolating: true,
      attrs: {
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
      },
    },
  },
});

function textBlock(type: 'paragraph' | 'heading', text: string): ProseMirrorNode {
  return schema.nodes[type].create(null, text.length > 0 ? schema.text(text) : undefined);
}

function codeBlock(text: string, language: string | null = 'typescript'): ProseMirrorNode {
  return schema.nodes.codeBlock.create(
    { language },
    text.length > 0 ? schema.text(text) : undefined
  );
}

function table(rows: number, columns: number): ProseMirrorNode {
  return schema.nodes.table.create(
    null,
    Array.from({ length: rows }, (_, row) =>
      schema.nodes.tableRow.create(
        null,
        Array.from({ length: columns }, (_, column) => {
          const cellType = row === 0 ? schema.nodes.tableHeader : schema.nodes.tableCell;
          return cellType.create(
            { colspan: 1, rowspan: 1, colwidth: null },
            schema.nodes.paragraph.create(null, schema.text(`R${row + 1}C${column + 1}`))
          );
        })
      )
    )
  );
}

function documentWith(...blocks: ProseMirrorNode[]): ProseMirrorNode {
  return schema.nodes.doc.create(null, blocks);
}

describe('Feedback target presentation', () => {
  it('describes exact prose as bounded literal text without interpreting HTML-like content', () => {
    const focus = '<img src=x onerror=alert(1)> **literal Markdown**';
    const doc = documentWith(textBlock('paragraph', focus));

    const presentation = getFeedbackTargetPresentation(doc, {
      startOrdinal: 0,
      endOrdinal: 0,
      focus,
      renderedRange: {
        version: 1,
        startOrdinal: 0,
        startOffset: 0,
        endOrdinal: 0,
        endOffset: focus.length,
      },
    });

    expect(presentation).toMatchObject({
      kind: 'selected-text',
      label: 'Selected text',
      preferredComposerSize: 'compact',
      lineContext: 'containing-source',
      preview: { kind: 'quote', text: focus },
    });
  });

  it('distinguishes partial code from a whole code block and preserves whitespace', () => {
    const source = '  alpha\n    beta\nthird';
    const doc = documentWith(codeBlock(source));
    const partial = '  alpha\n    beta';

    expect(
      getFeedbackTargetPresentation(doc, {
        startOrdinal: 0,
        endOrdinal: 0,
        focus: partial,
        renderedRange: {
          version: 1,
          startOrdinal: 0,
          startOffset: 0,
          endOrdinal: 0,
          endOffset: partial.length,
        },
      })
    ).toMatchObject({
      kind: 'selected-code',
      label: 'Selected code',
      detail: 'TypeScript · 2 lines',
      preferredComposerSize: 'wide',
      lineContext: 'containing-source',
      preview: { kind: 'code', text: partial },
    });

    expect(
      getFeedbackTargetPresentation(doc, {
        startOrdinal: 0,
        endOrdinal: 0,
        focus: source,
        presentationReason: 'whole-block-action',
      })
    ).toEqual(
      expect.objectContaining({
        kind: 'whole-code',
        label: 'Whole code block',
        detail: 'TypeScript · 3 lines',
        preferredComposerSize: 'wide',
        lineContext: 'source',
        preview: null,
      })
    );
  });

  it('keeps a whole-looking native code range as rendered selected code', () => {
    const source = '  alpha\n    beta\nthird';
    const doc = documentWith(codeBlock(source));

    expect(
      getFeedbackTargetPresentation(doc, {
        startOrdinal: 0,
        endOrdinal: 0,
        focus: source,
        renderedRange: {
          version: 1,
          startOrdinal: 0,
          startOffset: 0,
          endOrdinal: 0,
          endOffset: source.length,
        },
      })
    ).toMatchObject({
      kind: 'selected-code',
      label: 'Selected code',
      detail: 'TypeScript · 3 lines',
      preferredComposerSize: 'wide',
      lineContext: 'containing-source',
      preview: { kind: 'code', text: source },
    });
  });

  it('summarizes a whole table without flattening its cell content', () => {
    const doc = documentWith(table(5, 2));

    const presentation = getFeedbackTargetPresentation(doc, {
      startOrdinal: 0,
      endOrdinal: 0,
      focus: 'R1C1\tR1C2\nR2C1\tR2C2',
      presentationReason: 'whole-block-action',
    });

    expect(presentation).toMatchObject({
      kind: 'whole-table',
      label: 'Whole table',
      detail: '5 rows × 2 columns',
      preferredComposerSize: 'wide',
      lineContext: 'source',
      preview: null,
    });
    expect(JSON.stringify(presentation)).not.toContain('R1C1');
  });

  it('builds a bounded semantic mini-grid for rectangular selected cells', () => {
    const doc = documentWith(table(7, 7));
    const tableFingerprint = fingerprintFeedbackTable({
      version: 1,
      tableOrdinal: 0,
      table: doc.child(0),
    }).fingerprint;

    const presentation = getFeedbackTargetPresentation(doc, {
      startOrdinal: 0,
      endOrdinal: 0,
      focus: 'selected cells',
      cellTarget: {
        version: 1,
        tableOrdinal: 0,
        rectangle: { top: 0, left: 0, bottom: 7, right: 7 },
        tableFingerprint,
      },
    });

    expect(presentation).toMatchObject({
      kind: 'selected-cells',
      label: 'Selected cells',
      detail: 'Rows 1–7 · Columns 1–7 · 49 cells',
      preferredComposerSize: 'wide',
      lineContext: 'containing-source',
      preview: { kind: 'cells', truncated: true },
    });
    expect(presentation.preview?.kind).toBe('cells');
    if (presentation.preview?.kind === 'cells') {
      expect(presentation.preview.rows).toHaveLength(FEEDBACK_CELL_PREVIEW_ROW_LIMIT);
      expect(presentation.preview.rows[0]).toHaveLength(FEEDBACK_CELL_PREVIEW_COLUMN_LIMIT);
      expect(presentation.preview.rows[0][0]).toEqual({ text: 'R1C1', header: true });
    }

    const view = createFeedbackTargetPresentationView({
      ownerDocument: document,
      presentation,
    });
    expect(view.querySelector('table')).not.toBeNull();
    expect(view.querySelectorAll('th')).toHaveLength(FEEDBACK_CELL_PREVIEW_COLUMN_LIMIT);
    expect(view.querySelectorAll('td')).toHaveLength(
      FEEDBACK_CELL_PREVIEW_COLUMN_LIMIT * (FEEDBACK_CELL_PREVIEW_ROW_LIMIT - 1)
    );
    expect(view.querySelector('th[scope], td[scope]')).toBeNull();
  });

  it('bounds an oversized cell preview before traversing its complete content', () => {
    const source = 'x'.repeat(1024 * 1024 + 1);
    const tableNode = schema.nodes.table.create(null, [
      schema.nodes.tableRow.create(null, [
        schema.nodes.tableHeader.create(
          { colspan: 1, rowspan: 1, colwidth: null },
          schema.nodes.paragraph.create(null, schema.text(source))
        ),
      ]),
    ]);
    const doc = documentWith(tableNode);
    const tableFingerprint = fingerprintFeedbackTable({
      version: 1,
      tableOrdinal: 0,
      table: tableNode,
    }).fingerprint;
    const cell = tableNode.child(0).child(0);
    const textBetweenSpy = jest.spyOn(cell, 'textBetween');

    try {
      const presentation = getFeedbackTargetPresentation(doc, {
        startOrdinal: 0,
        endOrdinal: 0,
        focus: 'selected cell',
        cellTarget: {
          version: 1,
          tableOrdinal: 0,
          rectangle: { top: 0, left: 0, bottom: 1, right: 1 },
          tableFingerprint,
        },
      });

      expect(presentation.preview?.kind).toBe('cells');
      if (presentation.preview?.kind === 'cells') {
        expect(presentation.preview.rows[0][0].text).toHaveLength(120);
        expect(presentation.preview.rows[0][0].text.endsWith('…')).toBe(true);
      }
      expect(textBetweenSpy).toHaveBeenCalled();
      expect(textBetweenSpy.mock.calls.every(([, to]) => typeof to === 'number' && to <= 120)).toBe(
        true
      );
    } finally {
      textBetweenSpy.mockRestore();
    }
  });

  it('falls an oversized cold cell target back before fingerprint or preview traversal', () => {
    const doc = documentWith(table(40, 40));
    const tableNode = doc.child(0);
    const nodeAt = jest.spyOn(tableNode, 'nodeAt');
    const toJSON = jest.spyOn(tableNode, 'toJSON');

    const presentation = getFeedbackTargetPresentation(doc, {
      startOrdinal: 0,
      endOrdinal: 0,
      focus: '1,600 selected cells',
      presentationReason: 'large-table-selection',
      cellTarget: {
        version: 1,
        tableOrdinal: 0,
        rectangle: { top: 0, left: 0, bottom: 40, right: 40 },
        tableFingerprint: 'md4h-table/v1:0123456789abcdef',
      },
    });

    expect(presentation).toMatchObject({
      kind: 'whole-table',
      label: 'Whole table',
      detail: '40 rows × 40 columns',
      preview: null,
      explanation: expect.stringContaining('too large to anchor cell by cell'),
    });
    expect(nodeAt).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it.each([
    { nodeName: 'mermaid', label: 'Whole Mermaid diagram' },
    { nodeName: 'mathBlock', label: 'Whole math block' },
    { nodeName: 'image', label: 'Whole image' },
  ])('uses a descriptor rather than a rich duplicate for $nodeName', ({ nodeName, label }) => {
    const node =
      nodeName === 'image'
        ? schema.nodes.image.create({ src: 'diagram.png', alt: 'System diagram', title: null })
        : schema.nodes[nodeName].create(
            nodeName === 'mermaid' ? { language: 'mermaid' } : { latex: String.raw`E = mc^2` },
            schema.text(nodeName === 'mermaid' ? 'graph TD; A-->B' : String.raw`E = mc^2`)
          );
    const doc = documentWith(node);

    const presentation = getFeedbackTargetPresentation(doc, {
      startOrdinal: 0,
      endOrdinal: 0,
      focus: node.textContent || 'System diagram',
      presentationReason: 'whole-block-action',
    });

    expect(presentation).toMatchObject({
      label,
      preferredComposerSize: 'wide',
      preview: null,
      lineContext: 'source',
    });
  });

  it('explains that an opaque partial selection applies to the whole diagram', () => {
    const doc = documentWith(
      schema.nodes.mermaid.create({ language: 'mermaid' }, schema.text('graph TD; A-->B'))
    );

    const presentation = getFeedbackTargetPresentation(doc, {
      startOrdinal: 0,
      endOrdinal: 0,
      focus: 'graph TD; A-->B',
      presentationReason: 'opaque-node',
    });

    expect(presentation).toMatchObject({
      kind: 'opaque-block',
      label: 'Whole Mermaid diagram',
      preferredComposerSize: 'wide',
      explanation:
        'Rendered diagram parts cannot be anchored independently. This feedback applies to the whole diagram. Use Capture area for a visual sub-area.',
    });
  });

  it('distinguishes exact text spanning blocks from a structural multi-block target', () => {
    const doc = documentWith(
      textBlock('paragraph', 'Alpha'),
      textBlock('heading', 'Heading'),
      textBlock('paragraph', 'Omega')
    );

    expect(
      getFeedbackTargetPresentation(doc, {
        startOrdinal: 0,
        endOrdinal: 1,
        focus: 'Alpha\nHeading',
        renderedRange: {
          version: 1,
          startOrdinal: 0,
          startOffset: 0,
          endOrdinal: 1,
          endOffset: 7,
        },
      })
    ).toMatchObject({
      kind: 'selected-text',
      label: 'Selected text',
      detail: '2 blocks · paragraph to heading',
      preferredComposerSize: 'wide',
      preview: { kind: 'quote', text: 'Alpha\nHeading' },
    });

    expect(
      getFeedbackTargetPresentation(doc, {
        startOrdinal: 0,
        endOrdinal: 2,
        focus: 'Alpha\nHeading\nOmega',
        presentationReason: 'manual-block-range',
      })
    ).toMatchObject({
      kind: 'multi-block',
      label: 'Selected blocks',
      detail: '3 blocks · paragraph to paragraph',
      preferredComposerSize: 'wide',
      preview: null,
    });
  });

  it('expands clipped selected text in place without rendering a duplicate preview', async () => {
    const focus = Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1}`).join('\n');
    const doc = documentWith(textBlock('paragraph', focus));
    const presentation = getFeedbackTargetPresentation(doc, {
      startOrdinal: 0,
      endOrdinal: 0,
      focus,
      renderedRange: {
        version: 1,
        startOrdinal: 0,
        startOffset: 0,
        endOrdinal: 0,
        endOffset: focus.length,
      },
    });
    const view = createFeedbackTargetPresentationView({ ownerDocument: document, presentation });
    const preview = view.querySelector<HTMLElement>('[data-feedback-target-preview]');
    const disclosure = view.querySelector<HTMLDetailsElement>('.feedback-target-disclosure');
    const summary = disclosure?.querySelector('summary');

    expect(preview?.textContent).toBe(
      presentation.preview?.kind === 'quote' ? presentation.preview.collapsedText : undefined
    );
    expect(view.querySelectorAll('[data-feedback-target-preview]')).toHaveLength(1);
    expect(view.querySelector('.feedback-target-expanded')).toBeNull();

    summary?.click();
    await new Promise(resolve => window.setTimeout(resolve, 0));
    expect(disclosure?.open).toBe(true);
    expect(preview?.textContent).toBe(focus);
    expect(summary?.textContent).toBe('Show less selected content');
    expect(view.querySelectorAll('[data-feedback-target-preview]')).toHaveLength(1);

    summary?.click();
    await new Promise(resolve => window.setTimeout(resolve, 0));
    expect(disclosure?.open).toBe(false);
    expect(preview?.textContent).toBe(
      presentation.preview?.kind === 'quote' ? presentation.preview.collapsedText : undefined
    );
    expect(summary?.textContent).toBe('Show more selected content');
  });

  it('fails closed when target ordinals no longer exist', () => {
    const doc = documentWith(textBlock('paragraph', 'Alpha'));

    expect(
      getFeedbackTargetPresentation(doc, {
        startOrdinal: 7,
        endOrdinal: 7,
        focus: 'stale target',
      })
    ).toEqual({
      kind: 'unknown',
      label: 'Selected content',
      detail: 'Target details unavailable',
      preferredComposerSize: 'compact',
      lineContext: 'source',
      preview: null,
      explanation: null,
    });
  });
});
