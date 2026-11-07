/**
 * Direct host-authority tests for resolving Feedback v2 targets and evidence.
 */

import { createHash } from 'crypto';
import {
  FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2,
  FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2,
  FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2,
  feedbackEvidenceEnvelopeTextBytesV2,
} from '../../shared/feedbackEvidenceV2';
import { createFeedbackSourceIndex } from '../../editor/feedbackSourceEvidence';
import {
  FeedbackTargetEvidenceV2Error,
  resolveFeedbackTargetEvidenceV2,
  type FeedbackCanonicalEndpointStateV2,
  type ResolveFeedbackTargetEvidenceV2Input,
} from '../../editor/feedbackTargetEvidenceV2';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const TABLE_FINGERPRINT = 'md4h-table/v1:0123456789abcdef';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function endpoint(
  overrides: Partial<FeedbackCanonicalEndpointStateV2> = {}
): FeedbackCanonicalEndpointStateV2 {
  return {
    ordinal: 0,
    kind: 'paragraph',
    contentSize: 64,
    sha256: HASH_A,
    ...overrides,
  };
}

function resolverInput(
  sourceText: string,
  overrides: Partial<ResolveFeedbackTargetEvidenceV2Input> = {}
): ResolveFeedbackTargetEvidenceV2Input {
  const startBlock = endpoint();
  return {
    sourceIndex: createFeedbackSourceIndex(Buffer.from(sourceText, 'utf8')),
    sourceLines: { startLine: 1, endLine: 1 },
    startBlock,
    endBlock: { ...startBlock },
    rendererTarget: { version: 2, requestedScope: 'blocks' },
    sourceFormat: 'markdown',
    currentAggregateEmbeddedSourceBytes: 0,
    currentExactCellCount: 0,
    ...overrides,
  };
}

function expectResolverError(
  operation: () => unknown,
  code: FeedbackTargetEvidenceV2Error['code']
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(FeedbackTargetEvidenceV2Error);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected FeedbackTargetEvidenceV2Error ${code}.`);
}

function renderedTarget(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    requestedScope: 'rendered-text',
    locator: {
      kind: 'rendered-range',
      value: {
        version: 1,
        startOrdinal: 0,
        startOffset: 2,
        endOrdinal: 0,
        endOffset: 8,
      },
    },
    ...overrides,
  };
}

function renderedEvidence(text = 'exact', language?: string): Record<string, unknown> {
  return {
    kind: 'rendered-text',
    text,
    complete: true,
    ...(language === undefined ? {} : { language }),
  };
}

function tableTarget(): Record<string, unknown> {
  return {
    version: 2,
    requestedScope: 'table-cells',
    locator: {
      kind: 'table-cells',
      value: {
        version: 1,
        tableOrdinal: 4,
        rectangle: { top: 0, left: 0, bottom: 2, right: 2 },
        tableFingerprint: TABLE_FINGERPRINT,
      },
    },
  };
}

function tableEvidence(): Record<string, unknown> {
  return {
    kind: 'table-cells',
    complete: true,
    rows: [
      [
        { role: 'header', text: 'Name', complete: true },
        { role: 'header', text: 'State', complete: true },
      ],
      [
        { role: 'data', text: 'Alpha', complete: true },
        { role: 'data', text: 'Ready', complete: true },
      ],
    ],
  };
}

describe('Feedback v2 host target and evidence authority', () => {
  it('derives exact selected-block source and normalizes trusted canonical endpoint kinds', () => {
    const raw = '\ufeff# Title\r\n\r\nParagraph **bold**.\r\n';
    const normalized = '# Title\n\nParagraph **bold**.';
    const result = resolveFeedbackTargetEvidenceV2(
      resolverInput(raw, {
        sourceLines: { startLine: 1, endLine: 3 },
        startBlock: endpoint({ ordinal: 0, kind: 'heading', sha256: HASH_A }),
        endBlock: endpoint({ ordinal: 1, kind: 'markdownParagraph', sha256: HASH_B }),
      })
    );

    expect(result).toEqual({
      sourceBytesSha256: sha256(raw),
      target: {
        version: 2,
        requestedScope: 'blocks',
        effectiveScope: 'blocks',
        resolution: 'exact',
        blockSpan: {
          startOrdinal: 0,
          endOrdinal: 1,
          startKind: 'heading',
          endKind: 'paragraph',
          startBlockSha256: HASH_A,
          endBlockSha256: HASH_B,
        },
      },
      evidence: {
        effective: {
          kind: 'source',
          fidelity: 'source-exact',
          relationship: 'selected-blocks',
          format: 'markdown',
          normalization: 'lf',
          sourceSliceSha256: sha256(normalized),
          availability: 'embedded',
          text: normalized,
          utf8Bytes: Buffer.byteLength(normalized, 'utf8'),
        },
      },
      aggregateEmbeddedSourceBytesConsumed: Buffer.byteLength(normalized, 'utf8'),
      exactCellCountConsumed: 0,
    });
  });

  it('uses the trusted source format for a whole HTML block', () => {
    const sourceText = '<table>\r\n<tr><td>A</td></tr>\r\n</table>\r\n';
    const normalized = '<table>\n<tr><td>A</td></tr>\n</table>';
    const html = endpoint({ kind: 'htmlBlock' });
    const result = resolveFeedbackTargetEvidenceV2(
      resolverInput(sourceText, {
        sourceLines: { startLine: 1, endLine: 3 },
        startBlock: html,
        endBlock: { ...html },
        sourceFormat: 'html',
      })
    );

    expect(result.target.blockSpan).toMatchObject({ startKind: 'html', endKind: 'html' });
    expect(result.evidence.effective).toMatchObject({
      kind: 'source',
      relationship: 'selected-blocks',
      format: 'html',
      text: normalized,
    });
  });

  it('enriches a bounded rendered locator and converts renderer evidence fidelity', () => {
    const block = endpoint({ kind: 'codeBlock', contentSize: 12 });
    const result = resolveFeedbackTargetEvidenceV2(
      resolverInput('```ts\nconst x = 1;\n```', {
        startBlock: block,
        endBlock: { ...block },
        rendererTarget: renderedTarget(),
        rendererEvidence: renderedEvidence('const ', 'typescript'),
      })
    );

    expect(result.target).toEqual({
      version: 2,
      requestedScope: 'rendered-text',
      effectiveScope: 'rendered-text',
      resolution: 'exact',
      blockSpan: {
        startOrdinal: 0,
        endOrdinal: 0,
        startKind: 'code',
        endKind: 'code',
        startBlockSha256: HASH_A,
        endBlockSha256: HASH_A,
      },
      locator: {
        kind: 'rendered-range',
        value: {
          version: 1,
          startOrdinal: 0,
          startOffset: 2,
          endOrdinal: 0,
          endOffset: 8,
          startBlockSha256: HASH_A,
          endBlockSha256: HASH_A,
        },
      },
    });
    expect(result.evidence).toEqual({
      effective: {
        kind: 'rendered-text',
        fidelity: 'rendered-exact',
        text: 'const ',
        complete: true,
        language: 'typescript',
      },
    });
    expect(result.aggregateEmbeddedSourceBytesConsumed).toBe(0);
    expect(result.exactCellCountConsumed).toBe(0);
  });

  it.each([
    [
      'ordinal mismatch',
      renderedTarget({
        locator: {
          kind: 'rendered-range',
          value: {
            version: 1,
            startOrdinal: 1,
            startOffset: 0,
            endOrdinal: 1,
            endOffset: 1,
          },
        },
      }),
    ],
    [
      'offset overflow',
      renderedTarget({
        locator: {
          kind: 'rendered-range',
          value: {
            version: 1,
            startOrdinal: 0,
            startOffset: 2,
            endOrdinal: 0,
            endOffset: 65,
          },
        },
      }),
    ],
    [
      'empty start endpoint at the block boundary',
      renderedTarget({
        locator: {
          kind: 'rendered-range',
          value: {
            version: 1,
            startOrdinal: 0,
            startOffset: 64,
            endOrdinal: 1,
            endOffset: 1,
          },
        },
      }),
    ],
  ])('rejects a rendered locator with %s', (_label, rendererTarget) => {
    const startBlock = endpoint();
    const endBlock =
      (rendererTarget.locator as { value: { endOrdinal: number } }).value.endOrdinal === 1
        ? endpoint({ ordinal: 1, sha256: HASH_B })
        : { ...startBlock };
    expectResolverError(
      () =>
        resolveFeedbackTargetEvidenceV2(
          resolverInput('paragraph', {
            startBlock,
            endBlock,
            rendererTarget,
            rendererEvidence: renderedEvidence(),
          })
        ),
      'invalid-rendered-locator'
    );
  });

  it('rejects an exact rendered locator on a known opaque block', () => {
    const mermaid = endpoint({ kind: 'mermaid' });
    expectResolverError(
      () =>
        resolveFeedbackTargetEvidenceV2(
          resolverInput('```mermaid\nflowchart LR\n```', {
            startBlock: mermaid,
            endBlock: { ...mermaid },
            rendererTarget: renderedTarget(),
            rendererEvidence: renderedEvidence(),
          })
        ),
      'invalid-rendered-locator'
    );
  });

  it('enriches exact table geometry and consumes its rectangle at the session boundary', () => {
    const table = endpoint({
      ordinal: 4,
      kind: 'table',
      sha256: HASH_B,
      tableFingerprint: TABLE_FINGERPRINT,
    });
    const result = resolveFeedbackTargetEvidenceV2(
      resolverInput('| Name | State |\n| --- | --- |\n| Alpha | Ready |', {
        startBlock: table,
        endBlock: { ...table },
        rendererTarget: tableTarget(),
        rendererEvidence: tableEvidence(),
        currentExactCellCount: FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2 - 4,
      })
    );

    expect(result.target).toMatchObject({
      requestedScope: 'table-cells',
      effectiveScope: 'table-cells',
      resolution: 'exact',
      locator: {
        kind: 'table-cells',
        value: { tableOrdinal: 4, tableBlockSha256: HASH_B },
      },
    });
    expect(result.evidence.effective).toMatchObject({
      kind: 'table-cells',
      fidelity: 'structured-semantic',
      complete: true,
      rows: (tableEvidence() as { rows: unknown }).rows,
    });
    expect(result.exactCellCountConsumed).toBe(4);
    expect(result.aggregateEmbeddedSourceBytesConsumed).toBe(0);
  });

  it('coarsens exact cells with an honest host reason when session geometry would overflow', () => {
    const sourceText = '| Name | State |\n| --- | --- |\n| Alpha | Ready |';
    const table = endpoint({
      ordinal: 4,
      kind: 'table',
      sha256: HASH_B,
      tableFingerprint: TABLE_FINGERPRINT,
    });
    const result = resolveFeedbackTargetEvidenceV2(
      resolverInput(sourceText, {
        sourceLines: { startLine: 1, endLine: 3 },
        startBlock: table,
        endBlock: { ...table },
        rendererTarget: tableTarget(),
        rendererEvidence: tableEvidence(),
        currentExactCellCount: FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2 - 3,
      })
    );

    expect(result.target).toEqual({
      version: 2,
      requestedScope: 'table-cells',
      effectiveScope: 'blocks',
      resolution: 'degraded',
      coarsening: { reason: 'session-cell-budget', origin: 'host' },
      blockSpan: {
        startOrdinal: 4,
        endOrdinal: 4,
        startKind: 'table',
        endKind: 'table',
        startBlockSha256: HASH_B,
        endBlockSha256: HASH_B,
      },
    });
    expect(result.evidence.effective).toMatchObject({
      kind: 'source',
      relationship: 'containing-blocks',
      availability: 'embedded',
      text: sourceText,
    });
    expect(result.evidence.original).toMatchObject({
      kind: 'table-cells',
      fidelity: 'structured-semantic',
    });
    expect(result.exactCellCountConsumed).toBe(0);
    expect(result.aggregateEmbeddedSourceBytesConsumed).toBe(Buffer.byteLength(sourceText, 'utf8'));
  });

  it.each([
    ['missing', undefined],
    ['stale', 'md4h-table/v1:fedcba9876543210'],
  ])('rejects an exact table locator when its trusted fingerprint is %s', (_label, fingerprint) => {
    const table = endpoint({
      ordinal: 4,
      kind: 'table',
      sha256: HASH_B,
      ...(fingerprint === undefined ? {} : { tableFingerprint: fingerprint }),
    });

    expectResolverError(
      () =>
        resolveFeedbackTargetEvidenceV2(
          resolverInput('| A | B |\n| - | - |\n| 1 | 2 |', {
            sourceLines: { startLine: 1, endLine: 3 },
            startBlock: table,
            endBlock: { ...table },
            rendererTarget: tableTarget(),
            rendererEvidence: tableEvidence(),
          })
        ),
      'invalid-table-locator'
    );
  });

  it.each([
    ['a fingerprint on a paragraph', endpoint({ tableFingerprint: TABLE_FINGERPRINT })],
    [
      'a malformed table fingerprint',
      endpoint({ kind: 'table', tableFingerprint: 'md4h-table/v1:INVALID' }),
    ],
  ])('rejects trusted endpoint state with %s', (_label, block) => {
    expectResolverError(
      () =>
        resolveFeedbackTargetEvidenceV2(
          resolverInput('source', { startBlock: block, endBlock: { ...block } })
        ),
      'invalid-host-input'
    );
  });

  it('turns an opaque Mermaid constraint into renderer-origin degradation with semantic provenance', () => {
    const sourceText = '```mermaid\nflowchart LR\n  Draft --> Review\n```';
    const mermaid = endpoint({ kind: 'mermaid' });
    const result = resolveFeedbackTargetEvidenceV2(
      resolverInput(sourceText, {
        sourceLines: { startLine: 1, endLine: 4 },
        startBlock: mermaid,
        endBlock: { ...mermaid },
        rendererTarget: {
          version: 2,
          requestedScope: 'rendered-text',
          constraint: { reason: 'opaque-node' },
        },
        rendererEvidence: { kind: 'semantic-text', text: 'Draft\nReview', complete: true },
      })
    );

    expect(result.target).toMatchObject({
      requestedScope: 'rendered-text',
      effectiveScope: 'blocks',
      resolution: 'degraded',
      coarsening: { reason: 'opaque-node', origin: 'renderer' },
      blockSpan: { startKind: 'mermaid', endKind: 'mermaid' },
    });
    expect(result.evidence).toEqual({
      effective: {
        kind: 'source',
        fidelity: 'source-exact',
        relationship: 'containing-blocks',
        format: 'markdown',
        normalization: 'lf',
        sourceSliceSha256: sha256(sourceText),
        availability: 'embedded',
        text: sourceText,
        utf8Bytes: Buffer.byteLength(sourceText, 'utf8'),
      },
      original: {
        kind: 'semantic-text',
        fidelity: 'semantic-context',
        text: 'Draft\nReview',
        complete: true,
        provenance: 'renderer-fallback',
      },
    });
  });

  it('uses source omission to keep degraded effective and original evidence within 64 KiB', () => {
    const originalText = 'x'.repeat(FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2 - 1);
    const result = resolveFeedbackTargetEvidenceV2(
      resolverInput('source', {
        rendererTarget: {
          version: 2,
          requestedScope: 'rendered-text',
          constraint: { reason: 'unmappable-range' },
        },
        rendererEvidence: { kind: 'semantic-text', text: originalText, complete: true },
      })
    );

    expect(result.evidence.effective).toMatchObject({
      kind: 'source',
      availability: 'omitted',
      omittedReason: 'evidence-budget',
      omittedUtf8Bytes: 6,
    });
    expect(result.evidence.original).toMatchObject({ text: originalText });
    expect(feedbackEvidenceEnvelopeTextBytesV2(result.evidence)).toBe(
      FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2 - 1
    );
    expect(result.aggregateEmbeddedSourceBytesConsumed).toBe(0);
  });

  it('embeds source at the exact aggregate boundary and omits it one byte later', () => {
    const sourceText = 'source';
    const atLimit = resolveFeedbackTargetEvidenceV2(
      resolverInput(sourceText, {
        currentAggregateEmbeddedSourceBytes:
          FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2 - Buffer.byteLength(sourceText),
      })
    );
    const overLimit = resolveFeedbackTargetEvidenceV2(
      resolverInput(sourceText, {
        currentAggregateEmbeddedSourceBytes:
          FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2 - Buffer.byteLength(sourceText) + 1,
      })
    );

    expect(atLimit.evidence.effective).toMatchObject({ availability: 'embedded' });
    expect(atLimit.aggregateEmbeddedSourceBytesConsumed).toBe(6);
    expect(overLimit.evidence.effective).toMatchObject({
      availability: 'omitted',
      omittedReason: 'evidence-budget',
      omittedUtf8Bytes: 6,
    });
    expect(overLimit.aggregateEmbeddedSourceBytesConsumed).toBe(0);
  });

  it('propagates unsafe source omission without leaking source text', () => {
    const result = resolveFeedbackTargetEvidenceV2(resolverInput('safe\u0000DO-NOT-LEAK'));

    expect(result.evidence.effective).toMatchObject({
      availability: 'omitted',
      omittedReason: 'unsafe-control',
    });
    expect(JSON.stringify(result)).not.toContain('DO-NOT-LEAK');
  });

  it.each([
    [
      'host target fields',
      renderedTarget({
        effectiveScope: 'rendered-text',
        resolution: 'exact',
        blockSpan: { startBlockSha256: HASH_A },
      }),
      renderedEvidence(),
      'invalid-renderer-target',
    ],
    [
      'host locator hashes',
      {
        version: 2,
        requestedScope: 'rendered-text',
        locator: {
          kind: 'rendered-range',
          value: {
            version: 1,
            startOrdinal: 0,
            startOffset: 1,
            endOrdinal: 0,
            endOffset: 2,
            startBlockSha256: HASH_A,
          },
        },
      },
      renderedEvidence(),
      'invalid-renderer-target',
    ],
    [
      'source evidence',
      renderedTarget(),
      { kind: 'source', text: 'untrusted', sourceSliceSha256: HASH_A },
      'invalid-renderer-evidence',
    ],
    [
      'persisted fidelity',
      renderedTarget(),
      { ...renderedEvidence(), fidelity: 'rendered-exact' },
      'invalid-renderer-evidence',
    ],
  ])('rejects renderer-supplied %s', (_label, rendererTarget, rendererEvidence, code) => {
    expectResolverError(
      () =>
        resolveFeedbackTargetEvidenceV2(
          resolverInput('paragraph', { rendererTarget, rendererEvidence })
        ),
      code as FeedbackTargetEvidenceV2Error['code']
    );
  });

  it('rejects exact visual-region input because text resolution has no flattened screenshot', () => {
    expectResolverError(
      () =>
        resolveFeedbackTargetEvidenceV2(
          resolverInput('![alt](image.png)', {
            startBlock: endpoint({ kind: 'image' }),
            endBlock: endpoint({ kind: 'image' }),
            rendererTarget: { version: 2, requestedScope: 'visual-region' },
          })
        ),
      'exact-visual-requires-screenshot'
    );
  });

  it('allows a constrained visual region to degrade to containing image source', () => {
    const image = endpoint({ kind: 'image' });
    const result = resolveFeedbackTargetEvidenceV2(
      resolverInput('![alt](image.png)', {
        startBlock: image,
        endBlock: { ...image },
        rendererTarget: {
          version: 2,
          requestedScope: 'visual-region',
          constraint: { reason: 'opaque-node' },
        },
        rendererEvidence: { kind: 'semantic-text', text: 'alt', complete: true },
      })
    );

    expect(result.target).toMatchObject({
      requestedScope: 'visual-region',
      effectiveScope: 'blocks',
      resolution: 'degraded',
      coarsening: { reason: 'opaque-node', origin: 'renderer' },
    });
    expect(result.evidence.effective).toMatchObject({ relationship: 'containing-blocks' });
  });

  it('accepts renderer session-budget provenance only when the trusted host count is exhausted', () => {
    const table = endpoint({ ordinal: 4, kind: 'table' });
    const constrainedInput = resolverInput('| A |\n| - |\n| B |', {
      sourceLines: { startLine: 1, endLine: 3 },
      startBlock: table,
      endBlock: { ...table },
      rendererTarget: {
        version: 2,
        requestedScope: 'table-cells',
        constraint: { reason: 'session-cell-budget' },
      },
      rendererEvidence: { kind: 'semantic-text', text: 'A\nB', complete: true },
    });

    expectResolverError(
      () =>
        resolveFeedbackTargetEvidenceV2({
          ...constrainedInput,
          currentExactCellCount: FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2 - 1,
        }),
      'incompatible-renderer-constraint'
    );
    expect(
      resolveFeedbackTargetEvidenceV2({
        ...constrainedInput,
        currentExactCellCount: FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2,
      }).target
    ).toMatchObject({
      coarsening: { reason: 'session-cell-budget', origin: 'renderer' },
    });
  });

  it.each([
    [
      'opaque paragraph',
      endpoint({ kind: 'paragraph' }),
      {
        version: 2,
        requestedScope: 'rendered-text',
        constraint: { reason: 'opaque-node' },
      },
    ],
    [
      'cells on paragraph',
      endpoint({ kind: 'paragraph' }),
      {
        version: 2,
        requestedScope: 'table-cells',
        constraint: { reason: 'merged-cells' },
      },
    ],
  ])('rejects an incompatible renderer constraint for %s', (_label, block, rendererTarget) => {
    expectResolverError(
      () =>
        resolveFeedbackTargetEvidenceV2(
          resolverInput('paragraph', {
            startBlock: block,
            endBlock: { ...block },
            rendererTarget,
          })
        ),
      'incompatible-renderer-constraint'
    );
  });

  it.each([
    ['unknown canonical kind', { startBlock: endpoint({ kind: 'mysteryNode' }) }],
    [
      'inconsistent same-ordinal endpoints',
      {
        startBlock: endpoint({ sha256: HASH_A }),
        endBlock: endpoint({ sha256: HASH_B }),
      },
    ],
    ['negative source aggregate', { currentAggregateEmbeddedSourceBytes: -1 }],
    [
      'oversized source aggregate',
      {
        currentAggregateEmbeddedSourceBytes: FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2 + 1,
      },
    ],
    ['negative cell aggregate', { currentExactCellCount: -1 }],
    [
      'oversized cell aggregate',
      { currentExactCellCount: FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2 + 1 },
    ],
  ])('fails closed for invalid trusted input: %s', (_label, overrides) => {
    expectResolverError(
      () => resolveFeedbackTargetEvidenceV2(resolverInput('paragraph', overrides)),
      'invalid-host-input'
    );
  });
});
