/**
 * Renderer-facing summary projection for durable Feedback v2 items.
 */

import type { FeedbackTextItemV2 } from '../../shared/feedbackEvidenceV2';
import { projectFeedbackTextItemSummaryV2 } from '../../editor/feedbackItemSummaryV2';

const HASH = 'a'.repeat(64);

function item(
  overrides: Partial<FeedbackTextItemV2> & Pick<FeedbackTextItemV2, 'target' | 'evidence'>
): FeedbackTextItemV2 {
  return {
    id: 'F1',
    sequence: 1,
    kind: 'text',
    startLine: 1,
    endLine: 3,
    feedback: 'Review this.',
    ...overrides,
  };
}

const BLOCK_SPAN = {
  startOrdinal: 0,
  endOrdinal: 0,
  startKind: 'table' as const,
  endKind: 'table' as const,
  startBlockSha256: HASH,
  endBlockSha256: HASH,
};

describe('Feedback v2 renderer summary projection', () => {
  it('projects exact rendered evidence with its validated locator', () => {
    const locator = {
      version: 1 as const,
      startOrdinal: 0,
      startOffset: 2,
      endOrdinal: 0,
      endOffset: 8,
      startBlockSha256: HASH,
      endBlockSha256: HASH,
    };
    const value = item({
      target: {
        version: 2,
        requestedScope: 'rendered-text',
        effectiveScope: 'rendered-text',
        resolution: 'exact',
        blockSpan: { ...BLOCK_SPAN, startKind: 'code', endKind: 'code' },
        locator: { kind: 'rendered-range', value: locator },
      },
      evidence: {
        effective: {
          kind: 'rendered-text',
          fidelity: 'rendered-exact',
          text: 'const ',
          complete: true,
          language: 'typescript',
        },
      },
    });

    expect(projectFeedbackTextItemSummaryV2(value)).toEqual({
      focus: 'const ',
      renderedRange: locator,
    });
  });

  it('derives escaped TSV and exposes exact cell geometry from a typed matrix', () => {
    const locator = {
      version: 1 as const,
      tableOrdinal: 0,
      rectangle: { top: 0, left: 0, bottom: 2, right: 2 },
      tableFingerprint: 'md4h-table/v1:0123456789abcdef',
      tableBlockSha256: HASH,
    };
    const value = item({
      target: {
        version: 2,
        requestedScope: 'table-cells',
        effectiveScope: 'table-cells',
        resolution: 'exact',
        blockSpan: BLOCK_SPAN,
        locator: { kind: 'table-cells', value: locator },
      },
      evidence: {
        effective: {
          kind: 'table-cells',
          fidelity: 'structured-semantic',
          complete: true,
          rows: [
            [
              { role: 'header', text: 'A\tB', complete: true },
              { role: 'header', text: '', complete: true },
            ],
            [
              { role: 'data', text: '1\n2', complete: true },
              { role: 'data', text: 'x\\y', complete: true },
            ],
          ],
        },
      },
    });

    expect(projectFeedbackTextItemSummaryV2(value)).toEqual({
      focus: 'A\\tB\t\n1\\n2\tx\\\\y',
      cellTarget: locator,
    });
  });

  it('uses original partial evidence for degraded items without restoring a stale locator', () => {
    const value = item({
      target: {
        version: 2,
        requestedScope: 'rendered-text',
        effectiveScope: 'blocks',
        resolution: 'degraded',
        coarsening: { reason: 'stale-locator', origin: 'host' },
        blockSpan: { ...BLOCK_SPAN, startKind: 'paragraph', endKind: 'paragraph' },
      },
      evidence: {
        effective: {
          kind: 'source',
          fidelity: 'source-exact',
          relationship: 'containing-blocks',
          format: 'markdown',
          normalization: 'lf',
          sourceSliceSha256: HASH,
          availability: 'embedded',
          text: 'Paragraph with **formatting**.',
          utf8Bytes: 30,
        },
        original: {
          kind: 'rendered-text',
          fidelity: 'rendered-exact',
          text: 'with formatting',
          complete: true,
        },
      },
    });

    expect(projectFeedbackTextItemSummaryV2(value)).toEqual({ focus: 'with formatting' });
  });

  it('shows exact block source and a bounded omission descriptor without inventing content', () => {
    const exact = item({
      target: {
        version: 2,
        requestedScope: 'blocks',
        effectiveScope: 'blocks',
        resolution: 'exact',
        blockSpan: BLOCK_SPAN,
      },
      evidence: {
        effective: {
          kind: 'source',
          fidelity: 'source-exact',
          relationship: 'selected-blocks',
          format: 'markdown',
          normalization: 'lf',
          sourceSliceSha256: HASH,
          availability: 'embedded',
          text: '| A | B |',
          utf8Bytes: 9,
        },
      },
    });
    const omitted = item({
      target: exact.target,
      evidence: {
        effective: {
          kind: 'source',
          fidelity: 'source-reference',
          relationship: 'selected-blocks',
          format: 'markdown',
          normalization: 'lf',
          sourceSliceSha256: HASH,
          availability: 'omitted',
          omittedReason: 'evidence-budget',
          omittedUtf8Bytes: 200_012,
        },
      },
    });

    expect(projectFeedbackTextItemSummaryV2(exact)).toEqual({ focus: '| A | B |' });
    expect(projectFeedbackTextItemSummaryV2(omitted)).toEqual({
      focus: 'Source evidence omitted (200,012 UTF-8 bytes).',
    });
  });
});
