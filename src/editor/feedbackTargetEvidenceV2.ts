/**
 * @file feedbackTargetEvidenceV2.ts - Host-authoritative Feedback v2 resolution
 * @description Validates renderer target intent against trusted frozen block
 *              state, enriches exact locators, derives source evidence, and
 *              allocates item, source-session, and cell-session budgets.
 *              This pure module performs no I/O and accepts no renderer-owned
 *              source, hashes, effective scope, fidelity, or provenance.
 */

import {
  FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2,
  FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2,
  FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2,
  feedbackEvidenceEnvelopeTextBytesV2,
  feedbackTextualEvidenceBytesV2,
  isFeedbackRendererTargetEvidenceCompatibleV2,
  isFeedbackTargetEvidenceCompatibleV2,
  parseFeedbackEvidenceEnvelopeV2,
  parseFeedbackRendererEvidenceV2,
  parseFeedbackRendererTargetV2,
  parseFeedbackTargetV2,
  type FeedbackBlockKindV2,
  type FeedbackBlockSpanV2,
  type FeedbackCoarsenedReasonV2,
  type FeedbackEvidenceEnvelopeV2,
  type FeedbackEvidenceV2,
  type FeedbackRendererEvidenceV2,
  type FeedbackRendererTargetV2,
  type FeedbackScopeV2,
  type FeedbackTargetV2,
} from '../shared/feedbackEvidenceV2';
import {
  FeedbackSourceEvidenceError,
  projectFeedbackSourceEvidence,
  type FeedbackSourceEvidenceFormat,
  type FeedbackSourceIndex,
} from './feedbackSourceEvidence';

const MAX_BLOCK_ORDINAL = 99_999;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
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

const OPAQUE_BLOCK_KINDS = new Set<FeedbackBlockKindV2>([
  'mermaid',
  'math',
  'image',
  'horizontal-rule',
]);

/** Closed failures from host target and evidence resolution. */
export type FeedbackTargetEvidenceV2ErrorCode =
  | 'invalid-host-input'
  | 'invalid-renderer-target'
  | 'invalid-renderer-evidence'
  | 'incompatible-renderer-input'
  | 'incompatible-renderer-constraint'
  | 'invalid-rendered-locator'
  | 'invalid-table-locator'
  | 'exact-visual-requires-screenshot'
  | 'invalid-resolved-output';

/** Safe typed failure that never includes renderer or source evidence text. */
export class FeedbackTargetEvidenceV2Error extends Error {
  /**
   * @param code - Stable host-resolution failure category
   * @param message - Content-free diagnostic
   */
  public constructor(
    public readonly code: FeedbackTargetEvidenceV2ErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'FeedbackTargetEvidenceV2Error';
  }
}

/** Trusted frozen endpoint state supplied by the extension host. */
export interface FeedbackCanonicalEndpointStateV2 {
  readonly ordinal: number;
  /** Rich v2 kind or one of the explicitly normalized legacy renderer names. */
  readonly kind: string;
  readonly contentSize: number;
  readonly sha256: string;
  /** Frozen renderer table identity; valid only when the normalized kind is table. */
  readonly tableFingerprint?: string;
}

/** Complete pure input required to resolve one renderer text-feedback request. */
export interface ResolveFeedbackTargetEvidenceV2Input {
  readonly sourceIndex: FeedbackSourceIndex;
  readonly sourceLines: { readonly startLine: number; readonly endLine: number };
  readonly startBlock: FeedbackCanonicalEndpointStateV2;
  readonly endBlock: FeedbackCanonicalEndpointStateV2;
  readonly rendererTarget: unknown;
  readonly rendererEvidence?: unknown;
  readonly sourceFormat: FeedbackSourceEvidenceFormat;
  /** Embedded source already allocated by earlier stable feedback IDs. */
  readonly currentAggregateEmbeddedSourceBytes: number;
  /** Exact cell geometry already allocated by earlier stable feedback IDs. */
  readonly currentExactCellCount: number;
}

/** Canonical persisted target/evidence plus the counters consumed by this item. */
export interface ResolvedFeedbackTargetEvidenceV2 {
  readonly sourceBytesSha256: string;
  readonly target: FeedbackTargetV2;
  readonly evidence: FeedbackEvidenceEnvelopeV2;
  readonly aggregateEmbeddedSourceBytesConsumed: number;
  readonly exactCellCountConsumed: number;
}

interface TrustedResolutionState {
  readonly blockSpan: FeedbackBlockSpanV2;
  readonly startBlock: FeedbackCanonicalEndpointStateV2;
  readonly endBlock: FeedbackCanonicalEndpointStateV2;
}

interface SourceEnvelopeResult {
  readonly evidence: FeedbackEvidenceEnvelopeV2;
  readonly aggregateEmbeddedSourceBytesConsumed: number;
}

/**
 * Resolves one renderer request into host-owned v2 target and evidence state.
 * Callers allocate aggregate budgets in stable feedback-ID order and add the
 * returned counters only after persistence succeeds.
 *
 * @param input - Trusted source/block state, untrusted renderer values, and current counters
 * @returns Canonical persisted target/evidence and this item's consumed counters
 * @throws FeedbackTargetEvidenceV2Error when any trust, compatibility, or budget invariant fails
 */
export function resolveFeedbackTargetEvidenceV2(
  input: ResolveFeedbackTargetEvidenceV2Input
): ResolvedFeedbackTargetEvidenceV2 {
  const trusted = validateTrustedInput(input);
  const rendererTarget = parseFeedbackRendererTargetV2(input.rendererTarget);
  if (rendererTarget === null) {
    throw new FeedbackTargetEvidenceV2Error(
      'invalid-renderer-target',
      'The renderer Feedback target is not a valid v2 request.'
    );
  }

  const rendererEvidence = parseRendererEvidence(input.rendererEvidence);
  if (!isFeedbackRendererTargetEvidenceCompatibleV2(rendererTarget, rendererEvidence)) {
    throw new FeedbackTargetEvidenceV2Error(
      'incompatible-renderer-input',
      'The renderer Feedback target and evidence are incompatible.'
    );
  }

  if (rendererTarget.requestedScope === 'blocks') {
    const source = buildSourceEnvelope(input, 'selected-blocks');
    return finalizeResolution(
      input,
      {
        version: 2,
        requestedScope: 'blocks',
        effectiveScope: 'blocks',
        resolution: 'exact',
        blockSpan: trusted.blockSpan,
      },
      source.evidence,
      source.aggregateEmbeddedSourceBytesConsumed,
      0
    );
  }

  if ('constraint' in rendererTarget) {
    validateRendererConstraint(rendererTarget, trusted, input.currentExactCellCount);
    const original =
      rendererEvidence === undefined ? undefined : persistRendererEvidence(rendererEvidence);
    return resolveDegraded(
      input,
      trusted.blockSpan,
      rendererTarget.requestedScope,
      rendererTarget.constraint.reason,
      'renderer',
      original
    );
  }

  if (rendererTarget.requestedScope === 'visual-region') {
    throw new FeedbackTargetEvidenceV2Error(
      'exact-visual-requires-screenshot',
      'Exact visual-region Feedback requires flattened screenshot evidence.'
    );
  }

  if (rendererTarget.requestedScope === 'rendered-text') {
    validateRenderedLocator(rendererTarget, trusted);
    if (rendererEvidence?.kind !== 'rendered-text') {
      throw new FeedbackTargetEvidenceV2Error(
        'incompatible-renderer-input',
        'Exact rendered Feedback requires rendered-text evidence.'
      );
    }
    const locator = rendererTarget.locator.value;
    return finalizeResolution(
      input,
      {
        version: 2,
        requestedScope: 'rendered-text',
        effectiveScope: 'rendered-text',
        resolution: 'exact',
        blockSpan: trusted.blockSpan,
        locator: {
          kind: 'rendered-range',
          value: {
            ...locator,
            startBlockSha256: trusted.startBlock.sha256,
            endBlockSha256: trusted.endBlock.sha256,
          },
        },
      },
      { effective: persistRendererEvidence(rendererEvidence) },
      0,
      0
    );
  }

  validateTableLocator(rendererTarget, trusted);
  if (rendererEvidence?.kind !== 'table-cells') {
    throw new FeedbackTargetEvidenceV2Error(
      'incompatible-renderer-input',
      'Exact table-cell Feedback requires a typed cell matrix.'
    );
  }
  const rectangle = rendererTarget.locator.value.rectangle;
  const cellCount = (rectangle.bottom - rectangle.top) * (rectangle.right - rectangle.left);
  const persistedCells = persistRendererEvidence(rendererEvidence);

  if (input.currentExactCellCount + cellCount > FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2) {
    return resolveDegraded(
      input,
      trusted.blockSpan,
      'table-cells',
      'session-cell-budget',
      'host',
      persistedCells
    );
  }

  return finalizeResolution(
    input,
    {
      version: 2,
      requestedScope: 'table-cells',
      effectiveScope: 'table-cells',
      resolution: 'exact',
      blockSpan: trusted.blockSpan,
      locator: {
        kind: 'table-cells',
        value: {
          ...rendererTarget.locator.value,
          tableBlockSha256: trusted.startBlock.sha256,
        },
      },
    },
    { effective: persistedCells },
    0,
    cellCount
  );
}

function validateTrustedInput(input: ResolveFeedbackTargetEvidenceV2Input): TrustedResolutionState {
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

  const { startLine, endLine } = input.sourceLines;
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > input.sourceIndex.lines.length
  ) {
    throw invalidHostInput();
  }

  const startKind = normalizeFeedbackBlockKindV2(input.startBlock?.kind);
  const endKind = normalizeFeedbackBlockKindV2(input.endBlock?.kind);
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

  return {
    startBlock: input.startBlock,
    endBlock: input.endBlock,
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

function parseRendererEvidence(value: unknown): FeedbackRendererEvidenceV2 | undefined {
  if (value === undefined) return undefined;
  const parsed = parseFeedbackRendererEvidenceV2(value);
  if (parsed === null) {
    throw new FeedbackTargetEvidenceV2Error(
      'invalid-renderer-evidence',
      'The renderer Feedback evidence is not a valid v2 value.'
    );
  }
  return parsed;
}

function validateRenderedLocator(
  target: Extract<FeedbackRendererTargetV2, { requestedScope: 'rendered-text'; locator: unknown }>,
  trusted: TrustedResolutionState
): void {
  const range = target.locator.value;
  if (
    !RENDERED_RANGE_KINDS.has(trusted.blockSpan.startKind) ||
    !RENDERED_RANGE_KINDS.has(trusted.blockSpan.endKind) ||
    range.startOrdinal !== trusted.startBlock.ordinal ||
    range.endOrdinal !== trusted.endBlock.ordinal ||
    range.startOffset >= trusted.startBlock.contentSize ||
    range.endOffset > trusted.endBlock.contentSize
  ) {
    throw new FeedbackTargetEvidenceV2Error(
      'invalid-rendered-locator',
      'The rendered range does not match the trusted frozen block endpoints.'
    );
  }
}

function validateTableLocator(
  target: Extract<FeedbackRendererTargetV2, { requestedScope: 'table-cells'; locator: unknown }>,
  trusted: TrustedResolutionState
): void {
  if (
    trusted.startBlock.ordinal !== trusted.endBlock.ordinal ||
    trusted.blockSpan.startKind !== 'table' ||
    trusted.blockSpan.endKind !== 'table' ||
    target.locator.value.tableOrdinal !== trusted.startBlock.ordinal ||
    trusted.startBlock.tableFingerprint === undefined ||
    target.locator.value.tableFingerprint !== trusted.startBlock.tableFingerprint
  ) {
    throw new FeedbackTargetEvidenceV2Error(
      'invalid-table-locator',
      'The table-cell locator does not match one trusted frozen table block.'
    );
  }
}

function validateRendererConstraint(
  target: Extract<FeedbackRendererTargetV2, { constraint: unknown }>,
  trusted: TrustedResolutionState,
  currentExactCellCount: number
): void {
  const reason = target.constraint.reason;
  const isSingleTable =
    trusted.startBlock.ordinal === trusted.endBlock.ordinal &&
    trusted.blockSpan.startKind === 'table' &&
    trusted.blockSpan.endKind === 'table';
  let compatible = true;

  if (target.requestedScope === 'table-cells') compatible = isSingleTable;
  if (reason === 'opaque-node') {
    compatible =
      compatible &&
      (OPAQUE_BLOCK_KINDS.has(trusted.blockSpan.startKind) ||
        OPAQUE_BLOCK_KINDS.has(trusted.blockSpan.endKind));
  }
  if (reason === 'unsupported-block') {
    compatible =
      compatible &&
      (trusted.blockSpan.startKind === 'other' || trusted.blockSpan.endKind === 'other');
  }
  if (reason === 'session-cell-budget') {
    compatible = compatible && currentExactCellCount === FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2;
  }

  if (!compatible) {
    throw new FeedbackTargetEvidenceV2Error(
      'incompatible-renderer-constraint',
      'The renderer constraint is incompatible with trusted frozen block state.'
    );
  }
}

function resolveDegraded(
  input: ResolveFeedbackTargetEvidenceV2Input,
  blockSpan: FeedbackBlockSpanV2,
  requestedScope: Exclude<FeedbackScopeV2, 'blocks'>,
  reason: FeedbackCoarsenedReasonV2,
  origin: 'renderer' | 'host',
  original?: FeedbackEvidenceV2
): ResolvedFeedbackTargetEvidenceV2 {
  const source = buildSourceEnvelope(input, 'containing-blocks', original);
  return finalizeResolution(
    input,
    {
      version: 2,
      requestedScope,
      effectiveScope: 'blocks',
      resolution: 'degraded',
      coarsening: { reason, origin },
      blockSpan,
    },
    source.evidence,
    source.aggregateEmbeddedSourceBytesConsumed,
    0
  );
}

function buildSourceEnvelope(
  input: ResolveFeedbackTargetEvidenceV2Input,
  relationship: 'selected-blocks' | 'containing-blocks',
  original?: FeedbackEvidenceV2
): SourceEnvelopeResult {
  const originalBytes = original === undefined ? 0 : feedbackTextualEvidenceBytesV2(original);
  const itemUtf8Budget = FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2 - originalBytes;
  const remainingAggregateUtf8Budget =
    FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2 - input.currentAggregateEmbeddedSourceBytes;

  try {
    const projection = projectFeedbackSourceEvidence(input.sourceIndex, {
      startLine: input.sourceLines.startLine,
      endLine: input.sourceLines.endLine,
      relationship,
      format: input.sourceFormat,
      itemUtf8Budget,
      remainingAggregateUtf8Budget,
    });
    const evidence = canonicalEvidenceEnvelope({
      effective: projection.evidence,
      ...(original === undefined ? {} : { original }),
    });
    return {
      evidence,
      aggregateEmbeddedSourceBytesConsumed: projection.aggregateUtf8BytesConsumed,
    };
  } catch (error) {
    if (!(error instanceof FeedbackSourceEvidenceError)) throw error;
    throw new FeedbackTargetEvidenceV2Error(
      'invalid-host-input',
      'The trusted saved-source index or line span is invalid.'
    );
  }
}

function persistRendererEvidence(evidence: FeedbackRendererEvidenceV2): FeedbackEvidenceV2 {
  if (evidence.kind === 'rendered-text') {
    return {
      kind: 'rendered-text',
      fidelity: 'rendered-exact',
      text: evidence.text,
      complete: true,
      ...(evidence.language === undefined ? {} : { language: evidence.language }),
    };
  }
  if (evidence.kind === 'table-cells') {
    return {
      kind: 'table-cells',
      fidelity: 'structured-semantic',
      complete: evidence.complete,
      rows: evidence.rows,
    };
  }
  return {
    kind: 'semantic-text',
    fidelity: 'semantic-context',
    text: evidence.text,
    complete: evidence.complete,
    provenance: 'renderer-fallback',
  };
}

function finalizeResolution(
  input: ResolveFeedbackTargetEvidenceV2Input,
  targetValue: FeedbackTargetV2,
  evidenceValue: FeedbackEvidenceEnvelopeV2,
  aggregateEmbeddedSourceBytesConsumed: number,
  exactCellCountConsumed: number
): ResolvedFeedbackTargetEvidenceV2 {
  const target = parseFeedbackTargetV2(targetValue);
  const evidence = parseFeedbackEvidenceEnvelopeV2(evidenceValue);
  if (
    target === null ||
    evidence === null ||
    !isFeedbackTargetEvidenceCompatibleV2(target, evidence) ||
    feedbackEvidenceEnvelopeTextBytesV2(evidence) > FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2
  ) {
    throw new FeedbackTargetEvidenceV2Error(
      'invalid-resolved-output',
      'Host resolution produced an invalid Feedback v2 target or evidence envelope.'
    );
  }
  return {
    sourceBytesSha256: input.sourceIndex.sourceBytesSha256,
    target,
    evidence,
    aggregateEmbeddedSourceBytesConsumed,
    exactCellCountConsumed,
  };
}

function canonicalEvidenceEnvelope(value: unknown): FeedbackEvidenceEnvelopeV2 {
  const parsed = parseFeedbackEvidenceEnvelopeV2(value);
  if (parsed === null) {
    throw new FeedbackTargetEvidenceV2Error(
      'invalid-resolved-output',
      'Host resolution produced invalid Feedback v2 evidence.'
    );
  }
  return parsed;
}

/** Normalizes trusted canonical renderer names into the closed persisted v2 taxonomy. */
export function normalizeFeedbackBlockKindV2(kind: unknown): FeedbackBlockKindV2 | null {
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
  const kind = isRecord(value) ? normalizeFeedbackBlockKindV2(value.kind) : null;
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

function isSourceFormat(value: unknown): value is FeedbackSourceEvidenceFormat {
  return value === 'markdown' || value === 'html' || value === 'text';
}

function isBoundedCounter(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidHostInput(): FeedbackTargetEvidenceV2Error {
  return new FeedbackTargetEvidenceV2Error(
    'invalid-host-input',
    'Trusted Feedback source, block, line, format, or budget state is invalid.'
  );
}
