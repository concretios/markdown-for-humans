/**
 * @file feedbackMigrationV2.ts - Pure Feedback v1 item migration
 * @description Converts one trusted v1 draft item into strict v2 target and
 *              evidence state without guessing source, table matrices, or
 *              locator validity. The caller supplies frozen host state and
 *              allocates items in stable ID order.
 */

import {
  FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2,
  FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2,
  FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2,
  feedbackTextualEvidenceBytesV2,
  isFeedbackTargetEvidenceCompatibleV2,
  parseFeedbackEvidenceEnvelopeV2,
  parseFeedbackTargetV2,
  type FeedbackBlockKindV2,
  type FeedbackBlockSpanV2,
  type FeedbackEvidenceEnvelopeV2,
  type FeedbackEvidenceV2,
  type FeedbackExactTargetV2,
  type FeedbackItemV2,
  type FeedbackTargetV2,
} from '../shared/feedbackEvidenceV2';
import type { FeedbackCellTargetV1, FeedbackRenderedRangeV1 } from '../shared/feedbackProtocol';
import {
  FeedbackSourceEvidenceError,
  projectFeedbackSourceEvidence,
  type FeedbackSourceEvidenceFormat,
  type FeedbackSourceIndex,
} from './feedbackSourceEvidence';
import type { FeedbackCanonicalEndpointStateV2 } from './feedbackTargetEvidenceV2';

const MAX_ITEM_SEQUENCE = 2_000;
const MAX_FEEDBACK_LENGTH = 100_000;
const MAX_BLOCK_ORDINAL = 99_999;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ITEM_ID_PATTERN = /^F[1-9]\d*$/;
const TABLE_FINGERPRINT_PATTERN = /^md4h-table\/v1:[a-f0-9]{16}$/;

const RENDERED_RANGE_KINDS = new Set<FeedbackBlockKindV2>([
  'paragraph',
  'heading',
  'code',
  'table',
  'list',
  'blockquote',
  'alert',
  'frontmatter',
  'html',
]);

/** Closed failures produced by one v1 item migration. */
export type FeedbackMigrationV2ErrorCode =
  | 'invalid-host-input'
  | 'invalid-v1-item'
  | 'invalid-locator-validity'
  | 'invalid-rendered-locator'
  | 'invalid-cell-locator'
  | 'invalid-screenshot'
  | 'invalid-stale-item'
  | 'invalid-migrated-output';

/** Typed content-free migration failure. */
export class FeedbackMigrationV2Error extends Error {
  /**
   * @param code - Stable migration failure category
   * @param message - Safe diagnostic without source, Focus, or feedback text
   */
  public constructor(
    public readonly code: FeedbackMigrationV2ErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'FeedbackMigrationV2Error';
  }
}

/** Trusted result of revalidating each optional v1 locator. */
export interface FeedbackMigrationLocatorValidityV2 {
  readonly renderedRange: boolean;
  readonly cellTarget: boolean;
}

/** Store-independent v1 item shape accepted by the pure migrator. */
export type FeedbackMigrationItemV1 =
  | {
      readonly id: string;
      readonly sequence: number;
      readonly kind: 'text';
      readonly startLine: number;
      readonly endLine: number;
      readonly focus: string;
      readonly feedback: string;
      readonly renderedRange?: FeedbackRenderedRangeV1;
      readonly cellTarget?: FeedbackCellTargetV1;
    }
  | {
      readonly id: string;
      readonly sequence: number;
      readonly kind: 'screenshot';
      readonly startLine: number;
      readonly endLine: number;
      readonly feedback: string;
      readonly assetRelativePath: string;
      readonly assetSha256: string;
    };

/** Complete pure input for migrating one v1 item. */
export interface MigrateFeedbackItemV1ToV2Input {
  readonly sourceIndex: FeedbackSourceIndex;
  readonly sourceLines: { readonly startLine: number; readonly endLine: number };
  readonly startBlock: FeedbackCanonicalEndpointStateV2;
  readonly endBlock: FeedbackCanonicalEndpointStateV2;
  readonly item: FeedbackMigrationItemV1;
  readonly locatorValidity: FeedbackMigrationLocatorValidityV2;
  readonly sourceFormat: FeedbackSourceEvidenceFormat;
  readonly screenshotDimensions?: { readonly width: number; readonly height: number };
  readonly currentAggregateEmbeddedSourceBytes: number;
  readonly currentExactCellCount: number;
}

/** One strict migrated item plus aggregate counters consumed by it. */
export interface MigrateFeedbackItemV1ToV2Result {
  readonly item: FeedbackItemV2;
  readonly aggregateEmbeddedSourceBytesConsumed: number;
  readonly exactCellCountConsumed: number;
}

/** Trusted input for replacing one now-stale exact v2 text locator. */
export interface DegradeFeedbackItemV2ForStaleLocatorInput {
  readonly sourceIndex: FeedbackSourceIndex;
  readonly sourceLines: { readonly startLine: number; readonly endLine: number };
  readonly startBlock: FeedbackCanonicalEndpointStateV2;
  readonly endBlock: FeedbackCanonicalEndpointStateV2;
  readonly item: FeedbackItemV2;
  readonly sourceFormat: FeedbackSourceEvidenceFormat;
  readonly currentAggregateEmbeddedSourceBytes: number;
  readonly currentExactCellCount: number;
}

/** One stale-locator degradation plus aggregate counters consumed by it. */
export interface DegradeFeedbackItemV2ForStaleLocatorResult {
  readonly item: FeedbackItemV2;
  readonly aggregateEmbeddedSourceBytesConsumed: number;
  readonly exactCellCountConsumed: number;
}

interface TrustedMigrationState {
  readonly blockSpan: FeedbackBlockSpanV2;
}

interface TrustedStaleLocatorState extends TrustedMigrationState {
  readonly target: FeedbackExactTargetV2;
  readonly evidence: FeedbackEvidenceEnvelopeV2;
}

interface SourceEnvelopeResult {
  readonly evidence: FeedbackEvidenceEnvelopeV2;
  readonly aggregateEmbeddedSourceBytesConsumed: number;
}

interface SourceProjectionContext {
  readonly sourceIndex: FeedbackSourceIndex;
  readonly sourceLines: { readonly startLine: number; readonly endLine: number };
  readonly sourceFormat: FeedbackSourceEvidenceFormat;
  readonly currentAggregateEmbeddedSourceBytes: number;
}

/**
 * Migrates one v1 item without interpreting legacy Focus as authored source or
 * table structure. Aggregate counters are consumed only by embedded source and
 * retained exact cell geometry.
 *
 * @param input - Trusted frozen state, v1 item, locator validity, and current budgets
 * @returns One canonical v2 item and the counters consumed by that item
 * @throws FeedbackMigrationV2Error when migration cannot preserve the v1 item exactly
 */
export function migrateFeedbackItemV1ToV2(
  input: MigrateFeedbackItemV1ToV2Input
): MigrateFeedbackItemV1ToV2Result {
  const trusted = validateMigrationInput(input);
  const item = input.item;

  if (item.kind === 'screenshot') {
    return migrateScreenshot(input, trusted.blockSpan);
  }

  const hasRenderedRange = item.renderedRange !== undefined;
  const hasCellTarget = item.cellTarget !== undefined;
  if (hasRenderedRange && hasCellTarget) {
    throw new FeedbackMigrationV2Error(
      'invalid-v1-item',
      'A v1 text item cannot contain competing locators.'
    );
  }
  validateLocatorValidity(input.locatorValidity, hasRenderedRange, hasCellTarget);

  if (item.renderedRange !== undefined) {
    if (input.locatorValidity.renderedRange) {
      validateRenderedRange(item.renderedRange, input, trusted.blockSpan);
      return finalizeTextItem(
        item,
        {
          version: 2,
          requestedScope: 'rendered-text',
          effectiveScope: 'rendered-text',
          resolution: 'exact',
          blockSpan: trusted.blockSpan,
          locator: { kind: 'rendered-range', value: { ...item.renderedRange } },
        },
        {
          effective: {
            kind: 'rendered-text',
            fidelity: 'rendered-exact',
            text: item.focus,
            complete: true,
          },
        },
        0,
        0
      );
    }
    return migrateDegradedText(input, trusted.blockSpan, 'rendered-text', 'stale-locator', {
      kind: 'rendered-text',
      fidelity: 'rendered-exact',
      text: item.focus,
      complete: true,
    });
  }

  if (item.cellTarget !== undefined) {
    if (!input.locatorValidity.cellTarget) {
      return migrateDegradedText(
        input,
        trusted.blockSpan,
        'table-cells',
        'stale-locator',
        legacyFocus(item.focus)
      );
    }
    const cellCount = validateCellTarget(
      item.cellTarget,
      trusted.blockSpan,
      input.startBlock.tableFingerprint
    );
    if (input.currentExactCellCount + cellCount > FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2) {
      return migrateDegradedText(
        input,
        trusted.blockSpan,
        'table-cells',
        'session-cell-budget',
        legacyFocus(item.focus)
      );
    }
    return finalizeTextItem(
      item,
      {
        version: 2,
        requestedScope: 'table-cells',
        effectiveScope: 'table-cells',
        resolution: 'exact',
        blockSpan: trusted.blockSpan,
        locator: { kind: 'table-cells', value: cloneCellTarget(item.cellTarget) },
      },
      { effective: legacyFocus(item.focus) },
      0,
      cellCount
    );
  }

  const source = buildContainingSourceEnvelope(input, legacyFocus(item.focus));
  return finalizeTextItem(
    item,
    {
      version: 2,
      effectiveScope: 'blocks',
      resolution: 'legacy-unknown',
      legacyOrigin: 'v1-no-locator',
      blockSpan: trusted.blockSpan,
    },
    source.evidence,
    source.aggregateEmbeddedSourceBytesConsumed,
    0
  );
}

/**
 * Replaces one exact v2 rendered or cell locator after host revalidation marks
 * it stale. Prior effective evidence is retained intact as bounded original
 * evidence, while trusted saved source becomes the effective evidence.
 *
 * @param input - Exact v2 text item, trusted source state, and current budgets
 * @returns A new degraded item; the input item is never mutated
 * @throws FeedbackMigrationV2Error when the item is not exact locator evidence
 */
export function degradeFeedbackItemV2ForStaleLocator(
  input: DegradeFeedbackItemV2ForStaleLocatorInput
): DegradeFeedbackItemV2ForStaleLocatorResult {
  const trusted = validateStaleLocatorInput(input);
  const source = buildContainingSourceEnvelope(input, trusted.evidence.effective);
  const canonical = canonicalTargetEvidence(
    {
      version: 2,
      requestedScope: trusted.target.requestedScope,
      effectiveScope: 'blocks',
      resolution: 'degraded',
      coarsening: { reason: 'stale-locator', origin: 'host' },
      blockSpan: trusted.blockSpan,
    },
    source.evidence,
    'invalid-stale-item'
  );
  const item = input.item;
  if (item.kind !== 'text') throw invalidStaleItem();
  return {
    item: {
      id: item.id,
      sequence: item.sequence,
      kind: 'text',
      startLine: item.startLine,
      endLine: item.endLine,
      feedback: item.feedback,
      target: canonical.target,
      evidence: canonical.evidence,
    },
    aggregateEmbeddedSourceBytesConsumed: source.aggregateEmbeddedSourceBytesConsumed,
    exactCellCountConsumed: 0,
  };
}

function migrateDegradedText(
  input: MigrateFeedbackItemV1ToV2Input,
  blockSpan: FeedbackBlockSpanV2,
  requestedScope: 'rendered-text' | 'table-cells',
  reason: 'stale-locator' | 'session-cell-budget',
  original: FeedbackEvidenceV2
): MigrateFeedbackItemV1ToV2Result {
  if (input.item.kind !== 'text') throw invalidV1Item();
  const source = buildContainingSourceEnvelope(input, original);
  return finalizeTextItem(
    input.item,
    {
      version: 2,
      requestedScope,
      effectiveScope: 'blocks',
      resolution: 'degraded',
      coarsening: { reason, origin: 'host' },
      blockSpan,
    },
    source.evidence,
    source.aggregateEmbeddedSourceBytesConsumed,
    0
  );
}

function migrateScreenshot(
  input: MigrateFeedbackItemV1ToV2Input,
  blockSpan: FeedbackBlockSpanV2
): MigrateFeedbackItemV1ToV2Result {
  const item = input.item;
  const dimensions = input.screenshotDimensions;
  if (
    item.kind !== 'screenshot' ||
    dimensions === undefined ||
    input.locatorValidity.renderedRange ||
    input.locatorValidity.cellTarget ||
    item.assetRelativePath !== `assets/${item.id}.png` ||
    !SHA256_PATTERN.test(item.assetSha256)
  ) {
    throw invalidScreenshot();
  }

  let sourceSliceSha256: string;
  try {
    sourceSliceSha256 = projectFeedbackSourceEvidence(input.sourceIndex, {
      startLine: input.sourceLines.startLine,
      endLine: input.sourceLines.endLine,
      relationship: 'containing-blocks',
      format: input.sourceFormat,
      itemUtf8Budget: 0,
      remainingAggregateUtf8Budget: 0,
    }).sourceSliceSha256;
  } catch (error) {
    if (!(error instanceof FeedbackSourceEvidenceError)) throw error;
    throw invalidHostInput();
  }

  const target: FeedbackTargetV2 = {
    version: 2,
    requestedScope: 'visual-region',
    effectiveScope: 'visual-region',
    resolution: 'exact',
    blockSpan,
  };
  const evidence: FeedbackEvidenceEnvelopeV2 = {
    effective: {
      kind: 'visual',
      fidelity: 'visual-exact',
      assetRelativePath: item.assetRelativePath,
      assetSha256: item.assetSha256,
      width: dimensions.width,
      height: dimensions.height,
      sourceReference: {
        relationship: 'containing-blocks',
        format: input.sourceFormat,
        normalization: 'lf',
        sourceSliceSha256,
      },
    },
  };
  const canonical = canonicalTargetEvidence(target, evidence, 'invalid-screenshot');
  return {
    item: {
      id: item.id,
      sequence: item.sequence,
      kind: 'screenshot',
      startLine: item.startLine,
      endLine: item.endLine,
      feedback: item.feedback,
      assetRelativePath: item.assetRelativePath,
      assetSha256: item.assetSha256,
      width: dimensions.width,
      height: dimensions.height,
      target: canonical.target,
      evidence: canonical.evidence,
    },
    aggregateEmbeddedSourceBytesConsumed: 0,
    exactCellCountConsumed: 0,
  };
}

function buildContainingSourceEnvelope(
  input: SourceProjectionContext,
  original: FeedbackEvidenceV2
): SourceEnvelopeResult {
  const canonicalOriginal = canonicalEvidence({ effective: original }).effective;
  const itemUtf8Budget =
    FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2 - feedbackTextualEvidenceBytesV2(canonicalOriginal);
  try {
    const projection = projectFeedbackSourceEvidence(input.sourceIndex, {
      startLine: input.sourceLines.startLine,
      endLine: input.sourceLines.endLine,
      relationship: 'containing-blocks',
      format: input.sourceFormat,
      itemUtf8Budget,
      remainingAggregateUtf8Budget:
        FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2 -
        input.currentAggregateEmbeddedSourceBytes,
    });
    return {
      evidence: canonicalEvidence({ effective: projection.evidence, original: canonicalOriginal }),
      aggregateEmbeddedSourceBytesConsumed: projection.aggregateUtf8BytesConsumed,
    };
  } catch (error) {
    if (!(error instanceof FeedbackSourceEvidenceError)) throw error;
    throw invalidHostInput();
  }
}

function finalizeTextItem(
  item: Extract<FeedbackMigrationItemV1, { kind: 'text' }>,
  targetValue: FeedbackTargetV2,
  evidenceValue: FeedbackEvidenceEnvelopeV2,
  aggregateEmbeddedSourceBytesConsumed: number,
  exactCellCountConsumed: number
): MigrateFeedbackItemV1ToV2Result {
  const canonical = canonicalTargetEvidence(targetValue, evidenceValue, 'invalid-migrated-output');
  return {
    item: {
      id: item.id,
      sequence: item.sequence,
      kind: 'text',
      startLine: item.startLine,
      endLine: item.endLine,
      feedback: item.feedback,
      target: canonical.target,
      evidence: canonical.evidence,
    },
    aggregateEmbeddedSourceBytesConsumed,
    exactCellCountConsumed,
  };
}

function canonicalTargetEvidence(
  targetValue: unknown,
  evidenceValue: unknown,
  failureCode: FeedbackMigrationV2ErrorCode
): { target: FeedbackTargetV2; evidence: FeedbackEvidenceEnvelopeV2 } {
  const target = parseFeedbackTargetV2(targetValue);
  const evidence = parseFeedbackEvidenceEnvelopeV2(evidenceValue);
  if (
    target === null ||
    evidence === null ||
    !isFeedbackTargetEvidenceCompatibleV2(target, evidence)
  ) {
    throw new FeedbackMigrationV2Error(
      failureCode,
      'The v1 item cannot be represented as compatible strict v2 target and evidence state.'
    );
  }
  return { target, evidence };
}

function canonicalEvidence(value: unknown): FeedbackEvidenceEnvelopeV2 {
  const evidence = parseFeedbackEvidenceEnvelopeV2(value);
  if (evidence === null) throw invalidV1Item();
  return evidence;
}

function validateMigrationInput(input: MigrateFeedbackItemV1ToV2Input): TrustedMigrationState {
  if (
    !isRecord(input) ||
    !isValidSourceIndex(input.sourceIndex) ||
    !isRecord(input.sourceLines) ||
    !isRecord(input.locatorValidity) ||
    !hasExactKeys(input.locatorValidity, ['renderedRange', 'cellTarget']) ||
    typeof input.locatorValidity.renderedRange !== 'boolean' ||
    typeof input.locatorValidity.cellTarget !== 'boolean' ||
    !isSourceFormat(input.sourceFormat) ||
    !isBoundedCounter(
      input.currentAggregateEmbeddedSourceBytes,
      FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2
    ) ||
    !isBoundedCounter(input.currentExactCellCount, FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2)
  ) {
    throw invalidHostInput();
  }
  validateV1Item(input.item);
  if (
    input.sourceLines.startLine !== input.item.startLine ||
    input.sourceLines.endLine !== input.item.endLine ||
    input.sourceLines.startLine < 1 ||
    input.sourceLines.endLine < input.sourceLines.startLine ||
    input.sourceLines.endLine > input.sourceIndex.lines.length
  ) {
    throw invalidHostInput();
  }

  const startKind = normalizeBlockKind(input.startBlock?.kind);
  const endKind = normalizeBlockKind(input.endBlock?.kind);
  if (
    startKind === null ||
    endKind === null ||
    !isValidEndpoint(input.startBlock) ||
    !isValidEndpoint(input.endBlock) ||
    input.startBlock.ordinal > input.endBlock.ordinal
  ) {
    throw invalidHostInput();
  }
  if (
    input.startBlock.ordinal === input.endBlock.ordinal &&
    (startKind !== endKind ||
      input.startBlock.contentSize !== input.endBlock.contentSize ||
      input.startBlock.sha256 !== input.endBlock.sha256 ||
      input.startBlock.tableFingerprint !== input.endBlock.tableFingerprint)
  ) {
    throw invalidHostInput();
  }
  if (input.item.kind === 'text' && input.screenshotDimensions !== undefined) {
    throw invalidHostInput();
  }

  return {
    blockSpan: {
      startOrdinal: input.startBlock.ordinal,
      endOrdinal: input.endBlock.ordinal,
      startKind,
      endKind,
      startBlockSha256: input.startBlock.sha256,
      endBlockSha256: input.endBlock.sha256,
    },
  };
}

function validateStaleLocatorInput(
  input: DegradeFeedbackItemV2ForStaleLocatorInput
): TrustedStaleLocatorState {
  if (
    !isRecord(input) ||
    !isValidSourceIndex(input.sourceIndex) ||
    !isRecord(input.sourceLines) ||
    !isSourceFormat(input.sourceFormat) ||
    !isBoundedCounter(
      input.currentAggregateEmbeddedSourceBytes,
      FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2
    ) ||
    !isBoundedCounter(input.currentExactCellCount, FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2)
  ) {
    throw invalidHostInput();
  }
  validateStaleV2TextItem(input.item);
  if (
    input.sourceLines.startLine !== input.item.startLine ||
    input.sourceLines.endLine !== input.item.endLine ||
    input.sourceLines.startLine < 1 ||
    input.sourceLines.endLine < input.sourceLines.startLine ||
    input.sourceLines.endLine > input.sourceIndex.lines.length
  ) {
    throw invalidHostInput();
  }

  const startKind = normalizeBlockKind(input.startBlock?.kind);
  const endKind = normalizeBlockKind(input.endBlock?.kind);
  if (
    startKind === null ||
    endKind === null ||
    !isValidEndpoint(input.startBlock) ||
    !isValidEndpoint(input.endBlock) ||
    input.startBlock.ordinal > input.endBlock.ordinal
  ) {
    throw invalidHostInput();
  }
  if (
    input.startBlock.ordinal === input.endBlock.ordinal &&
    (startKind !== endKind ||
      input.startBlock.contentSize !== input.endBlock.contentSize ||
      input.startBlock.sha256 !== input.endBlock.sha256 ||
      input.startBlock.tableFingerprint !== input.endBlock.tableFingerprint)
  ) {
    throw invalidHostInput();
  }

  const canonical = canonicalTargetEvidence(
    input.item.target,
    input.item.evidence,
    'invalid-stale-item'
  );
  const target = canonical.target;
  if (
    target.resolution !== 'exact' ||
    (target.requestedScope !== 'rendered-text' && target.requestedScope !== 'table-cells') ||
    target.effectiveScope !== target.requestedScope ||
    target.locator === undefined ||
    (target.requestedScope === 'rendered-text' && target.locator.kind !== 'rendered-range') ||
    (target.requestedScope === 'table-cells' && target.locator.kind !== 'table-cells')
  ) {
    throw invalidStaleItem();
  }

  return {
    blockSpan: {
      startOrdinal: input.startBlock.ordinal,
      endOrdinal: input.endBlock.ordinal,
      startKind,
      endKind,
      startBlockSha256: input.startBlock.sha256,
      endBlockSha256: input.endBlock.sha256,
    },
    target,
    evidence: canonical.evidence,
  };
}

function validateStaleV2TextItem(item: unknown): asserts item is FeedbackItemV2 {
  if (
    !isRecord(item) ||
    item.kind !== 'text' ||
    !hasExactKeys(item, [
      'id',
      'sequence',
      'kind',
      'startLine',
      'endLine',
      'feedback',
      'target',
      'evidence',
    ]) ||
    typeof item.id !== 'string' ||
    !ITEM_ID_PATTERN.test(item.id) ||
    !Number.isSafeInteger(item.sequence) ||
    (item.sequence as number) < 1 ||
    (item.sequence as number) > MAX_ITEM_SEQUENCE ||
    !Number.isSafeInteger(item.startLine) ||
    !Number.isSafeInteger(item.endLine) ||
    (item.startLine as number) < 1 ||
    (item.endLine as number) < (item.startLine as number) ||
    !isSafeRequiredText(item.feedback, MAX_FEEDBACK_LENGTH)
  ) {
    throw invalidStaleItem();
  }
}

function validateV1Item(item: unknown): asserts item is FeedbackMigrationItemV1 {
  if (!isRecord(item) || (item.kind !== 'text' && item.kind !== 'screenshot')) {
    throw invalidV1Item();
  }
  const commonKeys = ['id', 'sequence', 'kind', 'startLine', 'endLine', 'feedback'];
  const expectedKeys =
    item.kind === 'screenshot'
      ? [...commonKeys, 'assetRelativePath', 'assetSha256']
      : [
          ...commonKeys,
          'focus',
          ...(hasOwn(item, 'renderedRange') ? ['renderedRange'] : []),
          ...(hasOwn(item, 'cellTarget') ? ['cellTarget'] : []),
        ];
  if (
    !hasExactKeys(item, expectedKeys) ||
    typeof item.id !== 'string' ||
    !ITEM_ID_PATTERN.test(item.id) ||
    !Number.isSafeInteger(item.sequence) ||
    (item.sequence as number) < 1 ||
    (item.sequence as number) > MAX_ITEM_SEQUENCE ||
    !Number.isSafeInteger(item.startLine) ||
    !Number.isSafeInteger(item.endLine) ||
    (item.startLine as number) < 1 ||
    (item.endLine as number) < (item.startLine as number) ||
    !isSafeRequiredText(item.feedback, MAX_FEEDBACK_LENGTH) ||
    (item.kind === 'text' && typeof item.focus !== 'string')
  ) {
    throw invalidV1Item();
  }
}

function validateLocatorValidity(
  validity: FeedbackMigrationLocatorValidityV2,
  hasRenderedRange: boolean,
  hasCellTarget: boolean
): void {
  if (
    (validity.renderedRange && !hasRenderedRange) ||
    (validity.cellTarget && !hasCellTarget) ||
    (hasRenderedRange && validity.cellTarget) ||
    (hasCellTarget && validity.renderedRange)
  ) {
    throw new FeedbackMigrationV2Error(
      'invalid-locator-validity',
      'V1 locator validity flags do not match the item locator.'
    );
  }
}

function validateRenderedRange(
  range: NonNullable<Extract<FeedbackMigrationItemV1, { kind: 'text' }>['renderedRange']>,
  input: MigrateFeedbackItemV1ToV2Input,
  blockSpan: FeedbackBlockSpanV2
): void {
  if (
    range.version !== 1 ||
    !RENDERED_RANGE_KINDS.has(blockSpan.startKind) ||
    !RENDERED_RANGE_KINDS.has(blockSpan.endKind) ||
    range.startOrdinal !== input.startBlock.ordinal ||
    range.endOrdinal !== input.endBlock.ordinal ||
    range.startBlockSha256 !== input.startBlock.sha256 ||
    range.endBlockSha256 !== input.endBlock.sha256 ||
    !Number.isSafeInteger(range.startOffset) ||
    !Number.isSafeInteger(range.endOffset) ||
    range.startOffset < 0 ||
    range.endOffset <= 0 ||
    range.startOffset > input.startBlock.contentSize ||
    range.endOffset > input.endBlock.contentSize ||
    (range.startOrdinal === range.endOrdinal && range.startOffset >= range.endOffset)
  ) {
    throw new FeedbackMigrationV2Error(
      'invalid-rendered-locator',
      'The valid v1 rendered locator does not match trusted frozen block state.'
    );
  }
}

function validateCellTarget(
  target: NonNullable<Extract<FeedbackMigrationItemV1, { kind: 'text' }>['cellTarget']>,
  blockSpan: FeedbackBlockSpanV2,
  trustedTableFingerprint: string | undefined
): number {
  const rectangle = target.rectangle;
  const rows = rectangle.bottom - rectangle.top;
  const columns = rectangle.right - rectangle.left;
  if (
    target.version !== 1 ||
    blockSpan.startOrdinal !== blockSpan.endOrdinal ||
    blockSpan.startKind !== 'table' ||
    blockSpan.endKind !== 'table' ||
    target.tableOrdinal !== blockSpan.startOrdinal ||
    target.tableBlockSha256 !== blockSpan.startBlockSha256 ||
    target.tableBlockSha256 !== blockSpan.endBlockSha256 ||
    trustedTableFingerprint === undefined ||
    target.tableFingerprint !== trustedTableFingerprint ||
    !TABLE_FINGERPRINT_PATTERN.test(target.tableFingerprint) ||
    !Number.isSafeInteger(rectangle.top) ||
    !Number.isSafeInteger(rectangle.left) ||
    !Number.isSafeInteger(rectangle.bottom) ||
    !Number.isSafeInteger(rectangle.right) ||
    rectangle.top < 0 ||
    rectangle.left < 0 ||
    rows <= 0 ||
    columns <= 0 ||
    rows > Math.floor(256 / columns)
  ) {
    throw new FeedbackMigrationV2Error(
      'invalid-cell-locator',
      'The valid v1 cell locator does not match one trusted frozen table block.'
    );
  }
  return rows * columns;
}

function legacyFocus(text: string): FeedbackEvidenceV2 {
  return { kind: 'legacy-focus', fidelity: 'legacy-unclassified', text };
}

function cloneCellTarget(
  target: NonNullable<Extract<FeedbackMigrationItemV1, { kind: 'text' }>['cellTarget']>
) {
  return { ...target, rectangle: { ...target.rectangle } };
}

function normalizeBlockKind(kind: unknown): FeedbackBlockKindV2 | null {
  if (typeof kind !== 'string') return null;
  const compact = kind
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  switch (compact) {
    case 'paragraph':
    case 'markdownparagraph':
    case 'textblock':
      return 'paragraph';
    case 'heading':
      return 'heading';
    case 'code':
    case 'codeblock':
    case 'fence':
    case 'fencedcode':
    case 'preservedcodeblock':
    case 'indentedimagecodeblock':
      return 'code';
    case 'table':
      return 'table';
    case 'mermaid':
      return 'mermaid';
    case 'math':
    case 'mathblock':
    case 'blockmath':
    case 'inlinemath':
      return 'math';
    case 'image':
      return 'image';
    case 'list':
    case 'bulletlist':
    case 'orderedlist':
    case 'tasklist':
      return 'list';
    case 'blockquote':
      return 'blockquote';
    case 'alert':
    case 'githubalert':
      return 'alert';
    case 'horizontalrule':
    case 'thematicbreak':
    case 'hr':
      return 'horizontal-rule';
    case 'frontmatter':
    case 'yamlfrontmatter':
    case 'jsonfrontmatter':
      return 'frontmatter';
    case 'html':
    case 'htmlblock':
      return 'html';
    case 'other':
      return 'other';
    default:
      return null;
  }
}

function isValidEndpoint(value: unknown): value is FeedbackCanonicalEndpointStateV2 {
  const kind = isRecord(value) ? normalizeBlockKind(value.kind) : null;
  return (
    isRecord(value) &&
    kind !== null &&
    Number.isSafeInteger(value.ordinal) &&
    (value.ordinal as number) >= 0 &&
    (value.ordinal as number) <= MAX_BLOCK_ORDINAL &&
    typeof value.kind === 'string' &&
    Number.isSafeInteger(value.contentSize) &&
    (value.contentSize as number) >= 0 &&
    typeof value.sha256 === 'string' &&
    SHA256_PATTERN.test(value.sha256) &&
    (value.tableFingerprint === undefined ||
      (kind === 'table' &&
        typeof value.tableFingerprint === 'string' &&
        TABLE_FINGERPRINT_PATTERN.test(value.tableFingerprint)))
  );
}

function isValidSourceIndex(value: unknown): value is FeedbackSourceIndex {
  return (
    isRecord(value) &&
    typeof value.sourceBytesSha256 === 'string' &&
    SHA256_PATTERN.test(value.sourceBytesSha256) &&
    Number.isSafeInteger(value.sourceByteLength) &&
    (value.sourceByteLength as number) >= 0 &&
    typeof value.hasUtf8Bom === 'boolean' &&
    Array.isArray(value.lines) &&
    value.lines.length > 0
  );
}

function isSafeRequiredText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximumLength &&
    !hasUnsafeControl(value)
  );
}

function hasUnsafeControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a) || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function isSourceFormat(value: unknown): value is FeedbackSourceEvidenceFormat {
  return value === 'markdown' || value === 'html' || value === 'text';
}

function isBoundedCounter(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalidHostInput(): FeedbackMigrationV2Error {
  return new FeedbackMigrationV2Error(
    'invalid-host-input',
    'Trusted source, line, block, format, dimension, or budget state is invalid.'
  );
}

function invalidV1Item(): FeedbackMigrationV2Error {
  return new FeedbackMigrationV2Error(
    'invalid-v1-item',
    'The v1 Feedback item cannot be preserved as bounded strict v2 evidence.'
  );
}

function invalidScreenshot(): FeedbackMigrationV2Error {
  return new FeedbackMigrationV2Error(
    'invalid-screenshot',
    'The v1 screenshot asset binding or trusted dimensions are invalid.'
  );
}

function invalidStaleItem(): FeedbackMigrationV2Error {
  return new FeedbackMigrationV2Error(
    'invalid-stale-item',
    'Only an exact v2 text item with one rendered or table-cell locator can be degraded.'
  );
}
