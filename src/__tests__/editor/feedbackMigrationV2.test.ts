/**
 * Direct tests for deterministic Feedback v1 item migration into v2.
 */

import { createHash } from 'crypto';
import type {
  FeedbackItem,
  ScreenshotFeedbackItem,
  TextFeedbackItem,
} from '../../editor/feedbackSessionStore';
import {
  FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2,
  FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2,
  FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2,
  feedbackEvidenceEnvelopeTextBytesV2,
  type FeedbackItemV2,
} from '../../shared/feedbackEvidenceV2';
import type { FeedbackCellTargetV1, FeedbackRenderedRangeV1 } from '../../shared/feedbackProtocol';
import { createFeedbackSourceIndex } from '../../editor/feedbackSourceEvidence';
import type { FeedbackCanonicalEndpointStateV2 } from '../../editor/feedbackTargetEvidenceV2';
import {
  degradeFeedbackItemV2ForStaleLocator,
  FeedbackMigrationV2Error,
  migrateFeedbackItemV1ToV2,
  type DegradeFeedbackItemV2ForStaleLocatorInput,
  type MigrateFeedbackItemV1ToV2Input,
} from '../../editor/feedbackMigrationV2';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const ASSET_HASH = 'c'.repeat(64);
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

function textItem(overrides: Partial<TextFeedbackItem> = {}): TextFeedbackItem {
  return {
    id: 'F1',
    sequence: 1,
    kind: 'text',
    startLine: 1,
    endLine: 1,
    focus: 'Legacy Focus',
    feedback: 'Clarify this selection.',
    ...overrides,
  };
}

function screenshotItem(overrides: Partial<ScreenshotFeedbackItem> = {}): ScreenshotFeedbackItem {
  return {
    id: 'F2',
    sequence: 2,
    kind: 'screenshot',
    startLine: 1,
    endLine: 1,
    feedback: 'Review this visual region.',
    assetRelativePath: 'assets/F2.png',
    assetSha256: ASSET_HASH,
    ...overrides,
  };
}

function migrationInput(
  sourceText: string,
  item: FeedbackItem = textItem(),
  overrides: Partial<MigrateFeedbackItemV1ToV2Input> = {}
): MigrateFeedbackItemV1ToV2Input {
  const startBlock = endpoint();
  return {
    sourceIndex: createFeedbackSourceIndex(Buffer.from(sourceText, 'utf8')),
    sourceLines: { startLine: item.startLine, endLine: item.endLine },
    startBlock,
    endBlock: { ...startBlock },
    item,
    locatorValidity: { renderedRange: false, cellTarget: false },
    sourceFormat: 'markdown',
    currentAggregateEmbeddedSourceBytes: 0,
    currentExactCellCount: 0,
    ...overrides,
  };
}

function staleLocatorInput(
  sourceText: string,
  item: FeedbackItemV2,
  overrides: Partial<DegradeFeedbackItemV2ForStaleLocatorInput> = {}
): DegradeFeedbackItemV2ForStaleLocatorInput {
  const startBlock = endpoint();
  return {
    sourceIndex: createFeedbackSourceIndex(Buffer.from(sourceText, 'utf8')),
    sourceLines: { startLine: item.startLine, endLine: item.endLine },
    startBlock,
    endBlock: { ...startBlock },
    item,
    sourceFormat: 'markdown',
    currentAggregateEmbeddedSourceBytes: 0,
    currentExactCellCount: 0,
    ...overrides,
  };
}

function expectMigrationError(
  operation: () => unknown,
  code: FeedbackMigrationV2Error['code']
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(FeedbackMigrationV2Error);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected FeedbackMigrationV2Error ${code}.`);
}

function renderedRange(overrides: Partial<FeedbackRenderedRangeV1> = {}): FeedbackRenderedRangeV1 {
  return {
    version: 1,
    startOrdinal: 0,
    startOffset: 0,
    endOrdinal: 0,
    endOffset: 5,
    startBlockSha256: HASH_A,
    endBlockSha256: HASH_A,
    ...overrides,
  };
}

function cellTarget(overrides: Partial<FeedbackCellTargetV1> = {}): FeedbackCellTargetV1 {
  return {
    version: 1,
    tableOrdinal: 4,
    rectangle: { top: 0, left: 0, bottom: 2, right: 2 },
    tableFingerprint: TABLE_FINGERPRINT,
    tableBlockSha256: HASH_B,
    ...overrides,
  };
}

describe('Feedback v1 to v2 item migration', () => {
  it('migrates a valid rendered locator to exact rendered evidence from legacy Focus', () => {
    const item = textItem({ focus: 'First', renderedRange: renderedRange() });
    const result = migrateFeedbackItemV1ToV2(
      migrationInput('First paragraph.', item, {
        locatorValidity: { renderedRange: true, cellTarget: false },
      })
    );

    expect(result).toEqual({
      item: {
        id: 'F1',
        sequence: 1,
        kind: 'text',
        startLine: 1,
        endLine: 1,
        feedback: 'Clarify this selection.',
        target: {
          version: 2,
          requestedScope: 'rendered-text',
          effectiveScope: 'rendered-text',
          resolution: 'exact',
          blockSpan: {
            startOrdinal: 0,
            endOrdinal: 0,
            startKind: 'paragraph',
            endKind: 'paragraph',
            startBlockSha256: HASH_A,
            endBlockSha256: HASH_A,
          },
          locator: { kind: 'rendered-range', value: renderedRange() },
        },
        evidence: {
          effective: {
            kind: 'rendered-text',
            fidelity: 'rendered-exact',
            text: 'First',
            complete: true,
          },
        },
      },
      aggregateEmbeddedSourceBytesConsumed: 0,
      exactCellCountConsumed: 0,
    });
  });

  it('keeps a valid cell locator exact but tags Focus as legacy instead of parsing TSV', () => {
    const focus = 'Name\tState\nAlpha\tReady';
    const item = textItem({ endLine: 3, focus, cellTarget: cellTarget() });
    const table = endpoint({
      ordinal: 4,
      kind: 'table',
      sha256: HASH_B,
      tableFingerprint: TABLE_FINGERPRINT,
    });
    const result = migrateFeedbackItemV1ToV2(
      migrationInput('| Name | State |\n| --- | --- |\n| Alpha | Ready |', item, {
        startBlock: table,
        endBlock: { ...table },
        locatorValidity: { renderedRange: false, cellTarget: true },
        currentExactCellCount: FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2 - 4,
      })
    );

    expect(result.item.target).toMatchObject({
      requestedScope: 'table-cells',
      effectiveScope: 'table-cells',
      resolution: 'exact',
      locator: { kind: 'table-cells', value: cellTarget() },
    });
    expect(result.item.evidence).toEqual({
      effective: { kind: 'legacy-focus', fidelity: 'legacy-unclassified', text: focus },
    });
    expect(result.item.evidence.effective.kind).not.toBe('table-cells');
    expect(result.exactCellCountConsumed).toBe(4);
    expect(result.aggregateEmbeddedSourceBytesConsumed).toBe(0);
  });

  it('migrates locator-free text to legacy-unknown with containing source and original Focus', () => {
    const sourceText = '\ufeffParagraph **authored**.\r\n';
    const normalized = 'Paragraph **authored**.';
    const item = textItem({ focus: 'Paragraph authored.' });
    const result = migrateFeedbackItemV1ToV2(migrationInput(sourceText, item));

    expect(result.item.target).toMatchObject({
      version: 2,
      effectiveScope: 'blocks',
      resolution: 'legacy-unknown',
      legacyOrigin: 'v1-no-locator',
    });
    expect(result.item.evidence).toEqual({
      effective: {
        kind: 'source',
        fidelity: 'source-exact',
        relationship: 'containing-blocks',
        format: 'markdown',
        normalization: 'lf',
        sourceSliceSha256: sha256(normalized),
        availability: 'embedded',
        text: normalized,
        utf8Bytes: Buffer.byteLength(normalized, 'utf8'),
      },
      original: {
        kind: 'legacy-focus',
        fidelity: 'legacy-unclassified',
        text: 'Paragraph authored.',
      },
    });
    expect(result.aggregateEmbeddedSourceBytesConsumed).toBe(Buffer.byteLength(normalized, 'utf8'));
    expect(result.exactCellCountConsumed).toBe(0);
  });

  it('degrades an invalid rendered locator with host stale provenance and original rendered text', () => {
    const item = textItem({ focus: 'First', renderedRange: renderedRange() });
    const result = migrateFeedbackItemV1ToV2(
      migrationInput('First paragraph.', item, {
        locatorValidity: { renderedRange: false, cellTarget: false },
      })
    );

    expect(result.item.target).toMatchObject({
      requestedScope: 'rendered-text',
      effectiveScope: 'blocks',
      resolution: 'degraded',
      coarsening: { reason: 'stale-locator', origin: 'host' },
    });
    expect(result.item.evidence.effective).toMatchObject({
      kind: 'source',
      relationship: 'containing-blocks',
    });
    expect(result.item.evidence.original).toEqual({
      kind: 'rendered-text',
      fidelity: 'rendered-exact',
      text: 'First',
      complete: true,
    });
  });

  it('degrades an invalid cell locator without interpreting its legacy Focus', () => {
    const focus = 'A\tB\n1\t2';
    const item = textItem({ endLine: 3, focus, cellTarget: cellTarget() });
    const table = endpoint({ ordinal: 4, kind: 'table', sha256: HASH_B });
    const result = migrateFeedbackItemV1ToV2(
      migrationInput('| A | B |\n| - | - |\n| 1 | 2 |', item, {
        sourceLines: { startLine: 1, endLine: 3 },
        startBlock: table,
        endBlock: { ...table },
      })
    );

    expect(result.item.target).toMatchObject({
      requestedScope: 'table-cells',
      effectiveScope: 'blocks',
      resolution: 'degraded',
      coarsening: { reason: 'stale-locator', origin: 'host' },
    });
    expect(result.item.evidence.original).toEqual({
      kind: 'legacy-focus',
      fidelity: 'legacy-unclassified',
      text: focus,
    });
  });

  it('coarsens a valid cell locator when retaining it would exceed the host cell budget', () => {
    const item = textItem({
      endLine: 3,
      focus: 'A\tB\n1\t2',
      cellTarget: cellTarget(),
    });
    const table = endpoint({
      ordinal: 4,
      kind: 'table',
      sha256: HASH_B,
      tableFingerprint: TABLE_FINGERPRINT,
    });
    const result = migrateFeedbackItemV1ToV2(
      migrationInput('| A | B |\n| - | - |\n| 1 | 2 |', item, {
        sourceLines: { startLine: 1, endLine: 3 },
        startBlock: table,
        endBlock: { ...table },
        locatorValidity: { renderedRange: false, cellTarget: true },
        currentExactCellCount: FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2 - 3,
      })
    );

    expect(result.item.target).toMatchObject({
      requestedScope: 'table-cells',
      effectiveScope: 'blocks',
      resolution: 'degraded',
      coarsening: { reason: 'session-cell-budget', origin: 'host' },
    });
    expect(result.item.evidence.original).toMatchObject({ kind: 'legacy-focus' });
    expect(result.exactCellCountConsumed).toBe(0);
  });

  it.each([
    ['missing', undefined],
    ['stale', 'md4h-table/v1:fedcba9876543210'],
  ])('fails closed when a valid cell locator has %s trusted fingerprint state', (_label, value) => {
    const item = textItem({ endLine: 3, focus: 'A\tB\n1\t2', cellTarget: cellTarget() });
    const table = endpoint({
      ordinal: 4,
      kind: 'table',
      sha256: HASH_B,
      ...(value === undefined ? {} : { tableFingerprint: value }),
    });

    expectMigrationError(
      () =>
        migrateFeedbackItemV1ToV2(
          migrationInput('| A | B |\n| - | - |\n| 1 | 2 |', item, {
            startBlock: table,
            endBlock: { ...table },
            locatorValidity: { renderedRange: false, cellTarget: true },
          })
        ),
      'invalid-cell-locator'
    );
  });

  it('migrates a screenshot to exact visual evidence with trusted dimensions and source reference', () => {
    const sourceText = '<figure>image</figure>\r\n';
    const item = screenshotItem();
    const html = endpoint({ kind: 'htmlBlock' });
    const result = migrateFeedbackItemV1ToV2(
      migrationInput(sourceText, item, {
        startBlock: html,
        endBlock: { ...html },
        sourceFormat: 'html',
        screenshotDimensions: { width: 1200, height: 800 },
      })
    );

    expect(result).toEqual({
      item: {
        id: 'F2',
        sequence: 2,
        kind: 'screenshot',
        startLine: 1,
        endLine: 1,
        feedback: 'Review this visual region.',
        assetRelativePath: 'assets/F2.png',
        assetSha256: ASSET_HASH,
        width: 1200,
        height: 800,
        target: {
          version: 2,
          requestedScope: 'visual-region',
          effectiveScope: 'visual-region',
          resolution: 'exact',
          blockSpan: {
            startOrdinal: 0,
            endOrdinal: 0,
            startKind: 'html',
            endKind: 'html',
            startBlockSha256: HASH_A,
            endBlockSha256: HASH_A,
          },
        },
        evidence: {
          effective: {
            kind: 'visual',
            fidelity: 'visual-exact',
            assetRelativePath: 'assets/F2.png',
            assetSha256: ASSET_HASH,
            width: 1200,
            height: 800,
            sourceReference: {
              relationship: 'containing-blocks',
              format: 'html',
              normalization: 'lf',
              sourceSliceSha256: sha256('<figure>image</figure>'),
            },
          },
        },
      },
      aggregateEmbeddedSourceBytesConsumed: 0,
      exactCellCountConsumed: 0,
    });
  });

  it('omits source rather than truncating Focus when combined item evidence reaches 64 KiB', () => {
    const focus = 'x'.repeat(FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2 - 1);
    const result = migrateFeedbackItemV1ToV2(migrationInput('source', textItem({ focus })));

    expect(result.item.evidence.effective).toMatchObject({
      kind: 'source',
      availability: 'omitted',
      omittedReason: 'evidence-budget',
      omittedUtf8Bytes: 6,
    });
    expect(result.item.evidence.original).toMatchObject({ text: focus });
    expect(feedbackEvidenceEnvelopeTextBytesV2(result.item.evidence)).toBe(
      FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2 - 1
    );
    expect(result.aggregateEmbeddedSourceBytesConsumed).toBe(0);
  });

  it('uses the exact remaining aggregate source budget', () => {
    const sourceText = 'source';
    const atLimit = migrateFeedbackItemV1ToV2(
      migrationInput(sourceText, textItem(), {
        currentAggregateEmbeddedSourceBytes:
          FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2 - Buffer.byteLength(sourceText),
      })
    );
    const overLimit = migrateFeedbackItemV1ToV2(
      migrationInput(sourceText, textItem(), {
        currentAggregateEmbeddedSourceBytes:
          FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2 - Buffer.byteLength(sourceText) + 1,
      })
    );

    expect(atLimit.item.evidence.effective).toMatchObject({ availability: 'embedded' });
    expect(atLimit.aggregateEmbeddedSourceBytesConsumed).toBe(6);
    expect(overLimit.item.evidence.effective).toMatchObject({
      availability: 'omitted',
      omittedReason: 'evidence-budget',
    });
    expect(overLimit.aggregateEmbeddedSourceBytesConsumed).toBe(0);
  });

  it.each([
    [
      'rendered hash mismatch',
      textItem({ renderedRange: renderedRange({ startBlockSha256: HASH_B }) }),
      { renderedRange: true, cellTarget: false },
      endpoint(),
      undefined,
      'invalid-rendered-locator',
    ],
    [
      'cell locator on a non-table',
      textItem({ cellTarget: cellTarget({ tableOrdinal: 0, tableBlockSha256: HASH_A }) }),
      { renderedRange: false, cellTarget: true },
      endpoint(),
      undefined,
      'invalid-cell-locator',
    ],
    [
      'absent locator marked valid',
      textItem(),
      { renderedRange: true, cellTarget: false },
      endpoint(),
      undefined,
      'invalid-locator-validity',
    ],
    [
      'screenshot without dimensions',
      screenshotItem(),
      { renderedRange: false, cellTarget: false },
      endpoint(),
      undefined,
      'invalid-screenshot',
    ],
    [
      'screenshot asset not bound to its ID',
      screenshotItem({ assetRelativePath: 'assets/F9.png' }),
      { renderedRange: false, cellTarget: false },
      endpoint(),
      { width: 10, height: 10 },
      'invalid-screenshot',
    ],
  ])('fails closed for %s', (_label, item, locatorValidity, block, screenshotDimensions, code) => {
    expectMigrationError(
      () =>
        migrateFeedbackItemV1ToV2(
          migrationInput('source', item, {
            startBlock: block,
            endBlock: { ...block },
            locatorValidity,
            ...(screenshotDimensions === undefined ? {} : { screenshotDimensions }),
          })
        ),
      code as FeedbackMigrationV2Error['code']
    );
  });

  it('rejects legacy Focus that cannot fit intact in v2 evidence', () => {
    const focus = 'x'.repeat(FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2 + 1);
    expectMigrationError(
      () => migrateFeedbackItemV1ToV2(migrationInput('source', textItem({ focus }))),
      'invalid-v1-item'
    );
  });

  it.each([
    ['source lines do not match item', { sourceLines: { startLine: 1, endLine: 2 } }],
    ['negative source budget', { currentAggregateEmbeddedSourceBytes: -1 }],
    [
      'source budget overflow',
      {
        currentAggregateEmbeddedSourceBytes: FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2 + 1,
      },
    ],
    ['negative cell budget', { currentExactCellCount: -1 }],
    [
      'cell budget overflow',
      { currentExactCellCount: FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2 + 1 },
    ],
  ])('rejects invalid trusted migration input: %s', (_label, overrides) => {
    expectMigrationError(
      () => migrateFeedbackItemV1ToV2(migrationInput('source', textItem(), overrides)),
      'invalid-host-input'
    );
  });
});

describe('stale v2 locator degradation', () => {
  it('degrades exact rendered text to containing source and preserves prior evidence as original', () => {
    const exact = migrateFeedbackItemV1ToV2(
      migrationInput(
        'First paragraph.',
        textItem({ focus: 'First', renderedRange: renderedRange() }),
        {
          locatorValidity: { renderedRange: true, cellTarget: false },
        }
      )
    ).item;
    const before = JSON.parse(JSON.stringify(exact)) as FeedbackItemV2;

    const result = degradeFeedbackItemV2ForStaleLocator(
      staleLocatorInput('First paragraph.', exact)
    );

    expect(result.item).toMatchObject({
      id: exact.id,
      sequence: exact.sequence,
      kind: 'text',
      startLine: exact.startLine,
      endLine: exact.endLine,
      feedback: exact.feedback,
      target: {
        requestedScope: 'rendered-text',
        effectiveScope: 'blocks',
        resolution: 'degraded',
        coarsening: { reason: 'stale-locator', origin: 'host' },
      },
      evidence: {
        effective: {
          kind: 'source',
          relationship: 'containing-blocks',
          availability: 'embedded',
          text: 'First paragraph.',
        },
        original: exact.evidence.effective,
      },
    });
    expect('locator' in result.item.target).toBe(false);
    expect(result.aggregateEmbeddedSourceBytesConsumed).toBe(16);
    expect(result.exactCellCountConsumed).toBe(0);
    expect(exact).toEqual(before);
  });

  it('degrades exact table cells without parsing or replacing prior legacy evidence', () => {
    const sourceText = '| A | B |\n| - | - |\n| 1 | 2 |';
    const table = endpoint({
      ordinal: 4,
      kind: 'table',
      sha256: HASH_B,
      tableFingerprint: TABLE_FINGERPRINT,
    });
    const exact = migrateFeedbackItemV1ToV2(
      migrationInput(
        sourceText,
        textItem({ endLine: 3, focus: 'A\tB\n1\t2', cellTarget: cellTarget() }),
        {
          startBlock: table,
          endBlock: { ...table },
          locatorValidity: { renderedRange: false, cellTarget: true },
        }
      )
    ).item;

    const result = degradeFeedbackItemV2ForStaleLocator(
      staleLocatorInput(sourceText, exact, {
        startBlock: table,
        endBlock: { ...table },
        currentExactCellCount: 4,
      })
    );

    expect(result.item.target).toMatchObject({
      requestedScope: 'table-cells',
      effectiveScope: 'blocks',
      resolution: 'degraded',
      coarsening: { reason: 'stale-locator', origin: 'host' },
    });
    expect(result.item.evidence.original).toEqual(exact.evidence.effective);
    expect(result.item.evidence.original).toMatchObject({ kind: 'legacy-focus' });
    expect(result.exactCellCountConsumed).toBe(0);
  });

  it.each([
    ['a screenshot', 'screenshot'],
    ['a locator-free item', 'locator-free'],
    ['an already degraded item', 'degraded'],
  ])('rejects %s instead of mutating it', (_label, scenario) => {
    let item: FeedbackItemV2;
    const sourceText = 'source';
    const startBlock = endpoint();
    if (scenario === 'screenshot') {
      item = migrateFeedbackItemV1ToV2(
        migrationInput(sourceText, screenshotItem(), {
          screenshotDimensions: { width: 10, height: 10 },
        })
      ).item;
    } else if (scenario === 'locator-free') {
      item = migrateFeedbackItemV1ToV2(migrationInput(sourceText)).item;
    } else {
      const exact = migrateFeedbackItemV1ToV2(
        migrationInput(sourceText, textItem({ focus: 'source', renderedRange: renderedRange() }), {
          locatorValidity: { renderedRange: true, cellTarget: false },
        })
      ).item;
      item = degradeFeedbackItemV2ForStaleLocator(staleLocatorInput(sourceText, exact)).item;
    }
    const before = JSON.parse(JSON.stringify(item)) as FeedbackItemV2;

    expectMigrationError(
      () =>
        degradeFeedbackItemV2ForStaleLocator(
          staleLocatorInput(sourceText, item, { startBlock, endBlock: { ...startBlock } })
        ),
      'invalid-stale-item'
    );
    expect(item).toEqual(before);
  });
});
