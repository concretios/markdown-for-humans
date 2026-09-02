/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Pure scope-first Feedback evidence v2 contracts and codecs.
 * Renderer inputs deliberately exclude host-owned source, resolution, hashes,
 * and provenance. Persisted values use closed discriminants, exact keys, and
 * bounded canonical clones suitable for strict report serialization.
 */

export const FEEDBACK_SCHEMA_V2 = 'md4h-feedback/v2' as const;
export const FEEDBACK_GUIDE_VERSION_V2 = 2 as const;

/** Maximum UTF-8 bytes across effective and original textual evidence per item. */
export const FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2 = 64 * 1024;

/** Maximum embedded source evidence bytes across one Feedback report. */
export const FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2 = 1024 * 1024;

/** Maximum canonical JSON bytes in either v2 machine metadata comment. */
export const FEEDBACK_MAX_METADATA_BYTES_V2 = 2 * 1024;

/** Existing exact table geometry limits retained by v2. */
export const FEEDBACK_MAX_EXACT_CELLS_PER_ITEM_V2 = 256;
export const FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2 = 4_096;

/** Semantic cell text is represented explicitly as incomplete beyond this bound. */
export const FEEDBACK_MAX_TABLE_CELL_CHARACTERS_V2 = 240;

/** Existing flattened screenshot limits retained by v2. */
export const FEEDBACK_MAX_SCREENSHOT_PIXELS_V2 = 12_000_000;
export const FEEDBACK_MAX_SCREENSHOT_BYTES_V2 = 10 * 1024 * 1024;

/** Maximum base64 PNG data URL length for a screenshot within the raw byte cap above. */
export const FEEDBACK_MAX_SCREENSHOT_DATA_URL_LENGTH_V2 =
  Math.ceil(FEEDBACK_MAX_SCREENSHOT_BYTES_V2 / 3) * 4 + 'data:image/png;base64,'.length;

const FEEDBACK_MAX_ORDINAL_V2 = 99_999;
const FEEDBACK_MAX_TABLE_COORDINATE_V2 = 100_000;
const FEEDBACK_MAX_SCREENSHOT_DIMENSION_V2 = 100_000;
const FEEDBACK_MAX_SOURCE_SLICE_BYTES_V2 = 64 * 1024 * 1024;
const FEEDBACK_LANGUAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_+.#-]{0,31}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TABLE_FINGERPRINT_PATTERN = /^md4h-table\/v1:[a-f0-9]{16}$/;
const SCREENSHOT_ASSET_PATTERN = /^assets\/F[1-9]\d*\.png$/;

export type FeedbackScopeV2 = 'rendered-text' | 'table-cells' | 'blocks' | 'visual-region';

export type FeedbackBlockKindV2 =
  | 'paragraph'
  | 'heading'
  | 'code'
  | 'table'
  | 'mermaid'
  | 'math'
  | 'image'
  | 'list'
  | 'blockquote'
  | 'alert'
  | 'horizontal-rule'
  | 'frontmatter'
  | 'html'
  | 'other';

export type FeedbackCoarsenedReasonV2 =
  | 'opaque-node'
  | 'unmappable-range'
  | 'merged-cells'
  | 'irregular-table'
  | 'item-cell-limit'
  | 'session-cell-budget'
  | 'stale-locator'
  | 'unsupported-block';

export type FeedbackRendererCoarsenedReasonV2 = Exclude<FeedbackCoarsenedReasonV2, 'stale-locator'>;

export interface FeedbackCellRectangleV2 {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** Untrusted, unhashed rendered-range locator sent by the renderer. */
export interface FeedbackRendererRenderedRangeV1 {
  version: 1;
  startOrdinal: number;
  startOffset: number;
  endOrdinal: number;
  endOffset: number;
}

/** Untrusted, unhashed table-cell locator sent by the renderer. */
export interface FeedbackRendererCellTargetV1 {
  version: 1;
  tableOrdinal: number;
  rectangle: FeedbackCellRectangleV2;
  tableFingerprint: string;
}

export type FeedbackRendererLocatorV2 =
  | { kind: 'rendered-range'; value: FeedbackRendererRenderedRangeV1 }
  | { kind: 'table-cells'; value: FeedbackRendererCellTargetV1 };

/** Closed renderer observation. The host independently validates and adds origin. */
export interface FeedbackRendererConstraintV2 {
  reason: FeedbackRendererCoarsenedReasonV2;
}

export type FeedbackRendererTargetV2 =
  | { version: 2; requestedScope: 'blocks' }
  | { version: 2; requestedScope: 'visual-region' }
  | {
      version: 2;
      requestedScope: 'visual-region';
      constraint: FeedbackRendererConstraintV2;
    }
  | {
      version: 2;
      requestedScope: 'rendered-text';
      locator: Extract<FeedbackRendererLocatorV2, { kind: 'rendered-range' }>;
    }
  | {
      version: 2;
      requestedScope: 'rendered-text';
      constraint: FeedbackRendererConstraintV2;
    }
  | {
      version: 2;
      requestedScope: 'table-cells';
      locator: Extract<FeedbackRendererLocatorV2, { kind: 'table-cells' }>;
    }
  | {
      version: 2;
      requestedScope: 'table-cells';
      constraint: FeedbackRendererConstraintV2;
    };

export interface FeedbackTableCellV2 {
  role: 'header' | 'data';
  text: string;
  complete: boolean;
}

export interface FeedbackRendererRenderedTextEvidenceV2 {
  kind: 'rendered-text';
  text: string;
  complete: true;
  language?: string;
}

export interface FeedbackRendererTableCellsEvidenceV2 {
  kind: 'table-cells';
  complete: boolean;
  rows: FeedbackTableCellV2[][];
}

export interface FeedbackRendererSemanticTextEvidenceV2 {
  kind: 'semantic-text';
  text: string;
  complete: boolean;
}

export type FeedbackRendererEvidenceV2 =
  | FeedbackRendererRenderedTextEvidenceV2
  | FeedbackRendererTableCellsEvidenceV2
  | FeedbackRendererSemanticTextEvidenceV2;

export interface FeedbackBlockSpanV2 {
  startOrdinal: number;
  endOrdinal: number;
  startKind: FeedbackBlockKindV2;
  endKind: FeedbackBlockKindV2;
  startBlockSha256: string;
  endBlockSha256: string;
}

/** Host-enriched rendered range persisted in v2 target metadata. */
export interface FeedbackRenderedRangeV1 {
  version: 1;
  startOrdinal: number;
  startOffset: number;
  endOrdinal: number;
  endOffset: number;
  startBlockSha256: string;
  endBlockSha256: string;
}

/** Host-enriched table-cell locator persisted in v2 target metadata. */
export interface FeedbackCellTargetV1 {
  version: 1;
  tableOrdinal: number;
  rectangle: FeedbackCellRectangleV2;
  tableFingerprint: string;
  tableBlockSha256: string;
}

export type FeedbackPersistedLocatorV2 =
  | { kind: 'rendered-range'; value: FeedbackRenderedRangeV1 }
  | { kind: 'table-cells'; value: FeedbackCellTargetV1 };

export interface FeedbackCoarseningV2 {
  reason: FeedbackCoarsenedReasonV2;
  origin: 'renderer' | 'host';
}

export interface FeedbackExactTargetV2 {
  version: 2;
  requestedScope: FeedbackScopeV2;
  effectiveScope: FeedbackScopeV2;
  resolution: 'exact';
  blockSpan: FeedbackBlockSpanV2;
  locator?: FeedbackPersistedLocatorV2;
}

export interface FeedbackDegradedTargetV2 {
  version: 2;
  requestedScope: Exclude<FeedbackScopeV2, 'blocks'>;
  effectiveScope: 'blocks';
  resolution: 'degraded';
  coarsening: FeedbackCoarseningV2;
  blockSpan: FeedbackBlockSpanV2;
}

export interface FeedbackLegacyUnknownTargetV2 {
  version: 2;
  effectiveScope: 'blocks';
  resolution: 'legacy-unknown';
  legacyOrigin: 'v1-no-locator';
  blockSpan: FeedbackBlockSpanV2;
}

export type FeedbackTargetV2 =
  FeedbackExactTargetV2 | FeedbackDegradedTargetV2 | FeedbackLegacyUnknownTargetV2;

interface FeedbackSourceEvidenceBaseV2 {
  kind: 'source';
  relationship: 'selected-blocks' | 'containing-blocks';
  format: 'markdown' | 'html' | 'text';
  normalization: 'lf';
  sourceSliceSha256: string;
}

export interface FeedbackEmbeddedSourceEvidenceV2 extends FeedbackSourceEvidenceBaseV2 {
  fidelity: 'source-exact';
  availability: 'embedded';
  text: string;
  utf8Bytes: number;
}

export interface FeedbackOmittedSourceEvidenceV2 extends FeedbackSourceEvidenceBaseV2 {
  fidelity: 'source-reference';
  availability: 'omitted';
  omittedReason: 'evidence-budget' | 'unsafe-control';
  omittedUtf8Bytes: number;
}

export type FeedbackSourceEvidenceV2 =
  FeedbackEmbeddedSourceEvidenceV2 | FeedbackOmittedSourceEvidenceV2;

export interface FeedbackRenderedTextEvidenceV2 {
  kind: 'rendered-text';
  fidelity: 'rendered-exact';
  text: string;
  complete: true;
  language?: string;
}

export interface FeedbackTableCellsEvidenceV2 {
  kind: 'table-cells';
  fidelity: 'structured-semantic';
  complete: boolean;
  rows: FeedbackTableCellV2[][];
}

export interface FeedbackSemanticTextEvidenceV2 {
  kind: 'semantic-text';
  fidelity: 'semantic-context';
  text: string;
  complete: boolean;
  provenance: 'renderer-fallback';
}

/** Migration-only evidence whose v1 Focus semantics cannot be upgraded honestly. */
export interface FeedbackLegacyFocusEvidenceV2 {
  kind: 'legacy-focus';
  fidelity: 'legacy-unclassified';
  text: string;
}

export interface FeedbackVisualSourceReferenceV2 {
  relationship: 'containing-blocks';
  format: 'markdown' | 'html' | 'text';
  normalization: 'lf';
  sourceSliceSha256: string;
}

export interface FeedbackVisualEvidenceV2 {
  kind: 'visual';
  fidelity: 'visual-exact';
  assetRelativePath: string;
  assetSha256: string;
  width: number;
  height: number;
  sourceReference: FeedbackVisualSourceReferenceV2;
}

export type FeedbackEvidenceV2 =
  | FeedbackSourceEvidenceV2
  | FeedbackRenderedTextEvidenceV2
  | FeedbackTableCellsEvidenceV2
  | FeedbackSemanticTextEvidenceV2
  | FeedbackLegacyFocusEvidenceV2
  | FeedbackVisualEvidenceV2;

export interface FeedbackEvidenceEnvelopeV2 {
  effective: FeedbackEvidenceV2;
  original?: FeedbackEvidenceV2;
}

export interface FeedbackSessionSnapshotV2 {
  schema: typeof FEEDBACK_SCHEMA_V2;
  guideVersion: typeof FEEDBACK_GUIDE_VERSION_V2;
  state: 'draft' | 'sealed';
  round: string;
  source: string;
  sourceSha256: string;
  createdAt: string;
  sealedAt?: string;
}

interface FeedbackItemBaseV2 {
  id: string;
  sequence: number;
  startLine: number;
  endLine: number;
  feedback: string;
  target: FeedbackTargetV2;
  evidence: FeedbackEvidenceEnvelopeV2;
}

export interface FeedbackTextItemV2 extends FeedbackItemBaseV2 {
  kind: 'text';
}

export interface FeedbackScreenshotItemV2 extends FeedbackItemBaseV2 {
  kind: 'screenshot';
  assetRelativePath: string;
  assetSha256: string;
  width: number;
  height: number;
}

export type FeedbackItemV2 = FeedbackTextItemV2 | FeedbackScreenshotItemV2;

export type FeedbackSourceEvidenceDescriptorV2 = Omit<FeedbackEmbeddedSourceEvidenceV2, 'text'>;

export type FeedbackOmittedSourceEvidenceDescriptorV2 = FeedbackOmittedSourceEvidenceV2;

export type FeedbackRenderedTextEvidenceDescriptorV2 = Omit<FeedbackRenderedTextEvidenceV2, 'text'>;

export interface FeedbackTableCellsEvidenceDescriptorV2 {
  kind: 'table-cells';
  fidelity: 'structured-semantic';
  complete: boolean;
  rowCount: number;
  columnCount: number;
}

export type FeedbackSemanticTextEvidenceDescriptorV2 = Omit<FeedbackSemanticTextEvidenceV2, 'text'>;

export type FeedbackLegacyFocusEvidenceDescriptorV2 = Omit<FeedbackLegacyFocusEvidenceV2, 'text'>;

export type FeedbackEvidenceDescriptorV2 =
  | FeedbackSourceEvidenceDescriptorV2
  | FeedbackOmittedSourceEvidenceDescriptorV2
  | FeedbackRenderedTextEvidenceDescriptorV2
  | FeedbackTableCellsEvidenceDescriptorV2
  | FeedbackSemanticTextEvidenceDescriptorV2
  | FeedbackLegacyFocusEvidenceDescriptorV2
  | FeedbackVisualEvidenceV2;

export interface FeedbackEvidenceEnvelopeDescriptorV2 {
  effective: FeedbackEvidenceDescriptorV2;
  original?: FeedbackEvidenceDescriptorV2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(record).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isOrdinal(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value <= FEEDBACK_MAX_ORDINAL_V2;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isFeedbackScope(value: unknown): value is FeedbackScopeV2 {
  return (
    value === 'rendered-text' ||
    value === 'table-cells' ||
    value === 'blocks' ||
    value === 'visual-region'
  );
}

function isFeedbackBlockKind(value: unknown): value is FeedbackBlockKindV2 {
  return (
    value === 'paragraph' ||
    value === 'heading' ||
    value === 'code' ||
    value === 'table' ||
    value === 'mermaid' ||
    value === 'math' ||
    value === 'image' ||
    value === 'list' ||
    value === 'blockquote' ||
    value === 'alert' ||
    value === 'horizontal-rule' ||
    value === 'frontmatter' ||
    value === 'html' ||
    value === 'other'
  );
}

function isFeedbackCoarsenedReason(value: unknown): value is FeedbackCoarsenedReasonV2 {
  return (
    value === 'opaque-node' ||
    value === 'unmappable-range' ||
    value === 'merged-cells' ||
    value === 'irregular-table' ||
    value === 'item-cell-limit' ||
    value === 'session-cell-budget' ||
    value === 'stale-locator' ||
    value === 'unsupported-block'
  );
}

function isRendererCoarsenedReason(value: unknown): value is FeedbackRendererCoarsenedReasonV2 {
  return isFeedbackCoarsenedReason(value) && value !== 'stale-locator';
}

/** Returns UTF-8 bytes without relying on Node Buffer or a webview TextEncoder global. */
export function feedbackUtf8ByteLengthV2(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      // A lone surrogate is encoded as the three-byte replacement character.
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

function hasUnsafeTextControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a) || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function isSafeEvidenceText(value: unknown, allowEmpty: boolean): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    !hasUnsafeTextControl(value) &&
    feedbackUtf8ByteLengthV2(value) <= FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2
  );
}

/** Returns a valid optional language token, otherwise omits it. */
export function sanitizeFeedbackLanguageV2(value: unknown): string | undefined {
  return typeof value === 'string' && FEEDBACK_LANGUAGE_PATTERN.test(value) && !value.includes('--')
    ? value
    : undefined;
}

function jsonByteLength(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string'
      ? feedbackUtf8ByteLengthV2(encoded)
      : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Checks one canonical metadata payload against the 2 KiB comment budget. */
export function isFeedbackMetadataWithinBudgetV2(value: unknown): boolean {
  return jsonByteLength(value) <= FEEDBACK_MAX_METADATA_BYTES_V2;
}

function parseCellRectangle(value: unknown): FeedbackCellRectangleV2 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['top', 'left', 'bottom', 'right']) ||
    !isNonNegativeSafeInteger(value.top) ||
    !isNonNegativeSafeInteger(value.left) ||
    !isNonNegativeSafeInteger(value.bottom) ||
    !isNonNegativeSafeInteger(value.right) ||
    value.top >= value.bottom ||
    value.left >= value.right ||
    value.bottom > FEEDBACK_MAX_TABLE_COORDINATE_V2 ||
    value.right > FEEDBACK_MAX_TABLE_COORDINATE_V2
  ) {
    return null;
  }
  const rowCount = value.bottom - value.top;
  const columnCount = value.right - value.left;
  if (columnCount > FEEDBACK_MAX_EXACT_CELLS_PER_ITEM_V2) return null;
  if (rowCount > Math.floor(FEEDBACK_MAX_EXACT_CELLS_PER_ITEM_V2 / columnCount)) return null;
  return { top: value.top, left: value.left, bottom: value.bottom, right: value.right };
}

function parseRendererRenderedRange(value: unknown): FeedbackRendererRenderedRangeV1 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'startOrdinal', 'startOffset', 'endOrdinal', 'endOffset']) ||
    value.version !== 1 ||
    !isOrdinal(value.startOrdinal) ||
    !isNonNegativeSafeInteger(value.startOffset) ||
    !isOrdinal(value.endOrdinal) ||
    !isNonNegativeSafeInteger(value.endOffset) ||
    value.startOrdinal > value.endOrdinal ||
    value.endOffset === 0 ||
    (value.startOrdinal === value.endOrdinal && value.startOffset >= value.endOffset)
  ) {
    return null;
  }
  return {
    version: 1,
    startOrdinal: value.startOrdinal,
    startOffset: value.startOffset,
    endOrdinal: value.endOrdinal,
    endOffset: value.endOffset,
  };
}

function parseRendererCellTarget(value: unknown): FeedbackRendererCellTargetV1 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'tableOrdinal', 'rectangle', 'tableFingerprint']) ||
    value.version !== 1 ||
    !isOrdinal(value.tableOrdinal) ||
    typeof value.tableFingerprint !== 'string' ||
    !TABLE_FINGERPRINT_PATTERN.test(value.tableFingerprint)
  ) {
    return null;
  }
  const rectangle = parseCellRectangle(value.rectangle);
  return rectangle === null
    ? null
    : {
        version: 1,
        tableOrdinal: value.tableOrdinal,
        rectangle,
        tableFingerprint: value.tableFingerprint,
      };
}

function parseRendererConstraint(value: unknown): FeedbackRendererConstraintV2 | null {
  return isRecord(value) &&
    hasExactKeys(value, ['reason']) &&
    isRendererCoarsenedReason(value.reason)
    ? { reason: value.reason }
    : null;
}

function rendererReasonMatchesScope(
  scope: Exclude<FeedbackScopeV2, 'blocks'>,
  reason: FeedbackRendererCoarsenedReasonV2
): boolean {
  if (reason === 'unsupported-block') return true;
  if (scope === 'rendered-text') {
    return reason === 'opaque-node' || reason === 'unmappable-range';
  }
  if (scope === 'table-cells') {
    return (
      reason === 'merged-cells' ||
      reason === 'irregular-table' ||
      reason === 'item-cell-limit' ||
      reason === 'session-cell-budget'
    );
  }
  return reason === 'opaque-node' || reason === 'unmappable-range';
}

/**
 * Parses a renderer target request without accepting any host-owned fields.
 * Exact partial requests carry one unhashed locator. Honest renderer fallbacks
 * carry one compatible closed constraint and no competing locator.
 */
export function parseFeedbackRendererTargetV2(value: unknown): FeedbackRendererTargetV2 | null {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !isFeedbackScope(value.requestedScope) ||
    !isFeedbackMetadataWithinBudgetV2(value)
  ) {
    return null;
  }

  if (value.requestedScope === 'blocks') {
    return hasExactKeys(value, ['version', 'requestedScope'])
      ? { version: 2, requestedScope: 'blocks' }
      : null;
  }

  if (value.requestedScope === 'visual-region') {
    if (hasExactKeys(value, ['version', 'requestedScope'])) {
      return { version: 2, requestedScope: 'visual-region' };
    }
    if (!hasExactKeys(value, ['version', 'requestedScope', 'constraint'])) return null;
    const constraint = parseRendererConstraint(value.constraint);
    return constraint !== null && rendererReasonMatchesScope('visual-region', constraint.reason)
      ? { version: 2, requestedScope: 'visual-region', constraint }
      : null;
  }

  if (hasExactKeys(value, ['version', 'requestedScope', 'constraint'])) {
    const constraint = parseRendererConstraint(value.constraint);
    if (constraint === null) return null;
    if (
      value.requestedScope === 'rendered-text' &&
      rendererReasonMatchesScope('rendered-text', constraint.reason)
    ) {
      return { version: 2, requestedScope: 'rendered-text', constraint };
    }
    return value.requestedScope === 'table-cells' &&
      rendererReasonMatchesScope('table-cells', constraint.reason)
      ? { version: 2, requestedScope: 'table-cells', constraint }
      : null;
  }
  if (!hasExactKeys(value, ['version', 'requestedScope', 'locator']) || !isRecord(value.locator)) {
    return null;
  }

  if (
    value.requestedScope === 'rendered-text' &&
    hasExactKeys(value.locator, ['kind', 'value']) &&
    value.locator.kind === 'rendered-range'
  ) {
    const range = parseRendererRenderedRange(value.locator.value);
    return range === null
      ? null
      : {
          version: 2,
          requestedScope: 'rendered-text',
          locator: { kind: 'rendered-range', value: range },
        };
  }

  if (
    value.requestedScope === 'table-cells' &&
    hasExactKeys(value.locator, ['kind', 'value']) &&
    value.locator.kind === 'table-cells'
  ) {
    const target = parseRendererCellTarget(value.locator.value);
    return target === null
      ? null
      : {
          version: 2,
          requestedScope: 'table-cells',
          locator: { kind: 'table-cells', value: target },
        };
  }
  return null;
}

function parseTableCell(value: unknown): FeedbackTableCellV2 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['role', 'text', 'complete']) ||
    (value.role !== 'header' && value.role !== 'data') ||
    !isSafeEvidenceText(value.text, true) ||
    Array.from(value.text).length > FEEDBACK_MAX_TABLE_CELL_CHARACTERS_V2 ||
    typeof value.complete !== 'boolean'
  ) {
    return null;
  }
  return { role: value.role, text: value.text, complete: value.complete };
}

function parseTableRows(value: unknown): FeedbackTableCellV2[][] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > FEEDBACK_MAX_EXACT_CELLS_PER_ITEM_V2
  ) {
    return null;
  }
  const firstRow = value[0];
  if (
    !Array.isArray(firstRow) ||
    firstRow.length === 0 ||
    firstRow.length > FEEDBACK_MAX_EXACT_CELLS_PER_ITEM_V2 ||
    value.length > Math.floor(FEEDBACK_MAX_EXACT_CELLS_PER_ITEM_V2 / firstRow.length)
  ) {
    return null;
  }

  const rows: FeedbackTableCellV2[][] = [];
  let textualBytes = 0;
  for (const candidateRow of value) {
    if (!Array.isArray(candidateRow) || candidateRow.length !== firstRow.length) return null;
    const row: FeedbackTableCellV2[] = [];
    for (const candidateCell of candidateRow) {
      const cell = parseTableCell(candidateCell);
      if (cell === null) return null;
      textualBytes += feedbackUtf8ByteLengthV2(cell.text);
      if (textualBytes > FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2) return null;
      row.push(cell);
    }
    rows.push(row);
  }
  return rows;
}

/** Parses bounded, semantic renderer evidence without accepting persisted fidelity fields. */
export function parseFeedbackRendererEvidenceV2(value: unknown): FeedbackRendererEvidenceV2 | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;

  if (value.kind === 'rendered-text') {
    const expectedKeys = [
      'kind',
      'text',
      'complete',
      ...(hasOwn(value, 'language') ? ['language'] : []),
    ];
    if (
      !hasExactKeys(value, expectedKeys) ||
      !isSafeEvidenceText(value.text, false) ||
      value.complete !== true ||
      (hasOwn(value, 'language') && typeof value.language !== 'string')
    ) {
      return null;
    }
    const language = sanitizeFeedbackLanguageV2(value.language);
    return {
      kind: 'rendered-text',
      text: value.text,
      complete: true,
      ...(language === undefined ? {} : { language }),
    };
  }

  if (value.kind === 'table-cells') {
    if (!hasExactKeys(value, ['kind', 'complete', 'rows']) || typeof value.complete !== 'boolean') {
      return null;
    }
    const rows = parseTableRows(value.rows);
    if (rows === null || value.complete !== rows.every(row => row.every(cell => cell.complete))) {
      return null;
    }
    return { kind: 'table-cells', complete: value.complete, rows };
  }

  if (value.kind === 'semantic-text') {
    return hasExactKeys(value, ['kind', 'text', 'complete']) &&
      isSafeEvidenceText(value.text, false) &&
      typeof value.complete === 'boolean'
      ? {
          kind: 'semantic-text',
          text: value.text,
          complete: value.complete,
        }
      : null;
  }
  return null;
}

/** Cross-validates a parsed renderer target with its optional evidence payload. */
export function isFeedbackRendererTargetEvidenceCompatibleV2(
  target: FeedbackRendererTargetV2,
  evidence: FeedbackRendererEvidenceV2 | undefined
): boolean {
  if (target.requestedScope === 'blocks') return evidence === undefined;
  if ('constraint' in target) {
    return evidence === undefined || evidence.kind === 'semantic-text';
  }
  if (target.requestedScope === 'visual-region') return evidence === undefined;
  if (target.requestedScope === 'rendered-text') return evidence?.kind === 'rendered-text';
  if (evidence?.kind !== 'table-cells') return false;
  const rectangle = target.locator.value.rectangle;
  return (
    evidence.rows.length === rectangle.bottom - rectangle.top &&
    evidence.rows.every(row => row.length === rectangle.right - rectangle.left)
  );
}

function parseBlockSpan(value: unknown): FeedbackBlockSpanV2 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'startOrdinal',
      'endOrdinal',
      'startKind',
      'endKind',
      'startBlockSha256',
      'endBlockSha256',
    ]) ||
    !isOrdinal(value.startOrdinal) ||
    !isOrdinal(value.endOrdinal) ||
    value.startOrdinal > value.endOrdinal ||
    !isFeedbackBlockKind(value.startKind) ||
    !isFeedbackBlockKind(value.endKind) ||
    !isSha256(value.startBlockSha256) ||
    !isSha256(value.endBlockSha256) ||
    (value.startOrdinal === value.endOrdinal &&
      (value.startKind !== value.endKind || value.startBlockSha256 !== value.endBlockSha256))
  ) {
    return null;
  }
  return {
    startOrdinal: value.startOrdinal,
    endOrdinal: value.endOrdinal,
    startKind: value.startKind,
    endKind: value.endKind,
    startBlockSha256: value.startBlockSha256,
    endBlockSha256: value.endBlockSha256,
  };
}

function parsePersistedRenderedRange(value: unknown): FeedbackRenderedRangeV1 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'startOrdinal',
      'startOffset',
      'endOrdinal',
      'endOffset',
      'startBlockSha256',
      'endBlockSha256',
    ]) ||
    value.version !== 1 ||
    !isOrdinal(value.startOrdinal) ||
    !isNonNegativeSafeInteger(value.startOffset) ||
    !isOrdinal(value.endOrdinal) ||
    !isNonNegativeSafeInteger(value.endOffset) ||
    value.startOrdinal > value.endOrdinal ||
    value.endOffset === 0 ||
    (value.startOrdinal === value.endOrdinal && value.startOffset >= value.endOffset) ||
    !isSha256(value.startBlockSha256) ||
    !isSha256(value.endBlockSha256)
  ) {
    return null;
  }
  return {
    version: 1,
    startOrdinal: value.startOrdinal,
    startOffset: value.startOffset,
    endOrdinal: value.endOrdinal,
    endOffset: value.endOffset,
    startBlockSha256: value.startBlockSha256,
    endBlockSha256: value.endBlockSha256,
  };
}

function parsePersistedCellTarget(value: unknown): FeedbackCellTargetV1 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'tableOrdinal',
      'rectangle',
      'tableFingerprint',
      'tableBlockSha256',
    ]) ||
    value.version !== 1 ||
    !isOrdinal(value.tableOrdinal) ||
    typeof value.tableFingerprint !== 'string' ||
    !TABLE_FINGERPRINT_PATTERN.test(value.tableFingerprint) ||
    !isSha256(value.tableBlockSha256)
  ) {
    return null;
  }
  const rectangle = parseCellRectangle(value.rectangle);
  return rectangle === null
    ? null
    : {
        version: 1,
        tableOrdinal: value.tableOrdinal,
        rectangle,
        tableFingerprint: value.tableFingerprint,
        tableBlockSha256: value.tableBlockSha256,
      };
}

function parsePersistedLocator(value: unknown): FeedbackPersistedLocatorV2 | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'value'])) return null;
  if (value.kind === 'rendered-range') {
    const range = parsePersistedRenderedRange(value.value);
    return range === null ? null : { kind: 'rendered-range', value: range };
  }
  if (value.kind === 'table-cells') {
    const target = parsePersistedCellTarget(value.value);
    return target === null ? null : { kind: 'table-cells', value: target };
  }
  return null;
}

function parseCoarsening(value: unknown): FeedbackCoarseningV2 | null {
  return isRecord(value) &&
    hasExactKeys(value, ['reason', 'origin']) &&
    isFeedbackCoarsenedReason(value.reason) &&
    (value.origin === 'renderer' || value.origin === 'host')
    ? { reason: value.reason, origin: value.origin }
    : null;
}

function exactTargetLocatorIsCompatible(
  scope: FeedbackScopeV2,
  span: FeedbackBlockSpanV2,
  locator: FeedbackPersistedLocatorV2 | undefined
): boolean {
  if (scope === 'blocks' || scope === 'visual-region') return locator === undefined;
  if (scope === 'rendered-text') {
    if (locator?.kind !== 'rendered-range') return false;
    const range = locator.value;
    return (
      range.startOrdinal === span.startOrdinal &&
      range.endOrdinal === span.endOrdinal &&
      range.startBlockSha256 === span.startBlockSha256 &&
      range.endBlockSha256 === span.endBlockSha256
    );
  }
  if (locator?.kind !== 'table-cells') return false;
  return (
    span.startOrdinal === span.endOrdinal &&
    span.startKind === 'table' &&
    span.endKind === 'table' &&
    locator.value.tableOrdinal === span.startOrdinal &&
    locator.value.tableBlockSha256 === span.startBlockSha256 &&
    locator.value.tableBlockSha256 === span.endBlockSha256
  );
}

/** Parses one strict, host-owned v2 target and returns canonical key order. */
export function parseFeedbackTargetV2(value: unknown): FeedbackTargetV2 | null {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !isFeedbackMetadataWithinBudgetV2(value) ||
    !isRecord(value.blockSpan)
  ) {
    return null;
  }
  const span = parseBlockSpan(value.blockSpan);
  if (span === null) return null;

  if (value.resolution === 'legacy-unknown') {
    return hasExactKeys(value, [
      'version',
      'effectiveScope',
      'resolution',
      'legacyOrigin',
      'blockSpan',
    ]) &&
      value.effectiveScope === 'blocks' &&
      value.legacyOrigin === 'v1-no-locator'
      ? {
          version: 2,
          effectiveScope: 'blocks',
          resolution: 'legacy-unknown',
          legacyOrigin: 'v1-no-locator',
          blockSpan: span,
        }
      : null;
  }

  if (!isFeedbackScope(value.requestedScope) || !isFeedbackScope(value.effectiveScope)) {
    return null;
  }
  if (value.resolution === 'exact') {
    const expectedKeys = [
      'version',
      'requestedScope',
      'effectiveScope',
      'resolution',
      'blockSpan',
      ...(hasOwn(value, 'locator') ? ['locator'] : []),
    ];
    if (!hasExactKeys(value, expectedKeys) || value.requestedScope !== value.effectiveScope) {
      return null;
    }
    const locator = hasOwn(value, 'locator') ? parsePersistedLocator(value.locator) : undefined;
    if (locator === null || !exactTargetLocatorIsCompatible(value.requestedScope, span, locator)) {
      return null;
    }
    return {
      version: 2,
      requestedScope: value.requestedScope,
      effectiveScope: value.effectiveScope,
      resolution: 'exact',
      blockSpan: span,
      ...(locator === undefined ? {} : { locator }),
    };
  }

  if (
    value.resolution !== 'degraded' ||
    !hasExactKeys(value, [
      'version',
      'requestedScope',
      'effectiveScope',
      'resolution',
      'coarsening',
      'blockSpan',
    ]) ||
    value.requestedScope === 'blocks' ||
    value.effectiveScope !== 'blocks'
  ) {
    return null;
  }
  const coarsening = parseCoarsening(value.coarsening);
  return coarsening === null
    ? null
    : {
        version: 2,
        requestedScope: value.requestedScope,
        effectiveScope: 'blocks',
        resolution: 'degraded',
        coarsening,
        blockSpan: span,
      };
}

function isSourceRelationship(
  value: unknown
): value is FeedbackSourceEvidenceBaseV2['relationship'] {
  return value === 'selected-blocks' || value === 'containing-blocks';
}

function isSourceFormat(value: unknown): value is FeedbackSourceEvidenceBaseV2['format'] {
  return value === 'markdown' || value === 'html' || value === 'text';
}

function parseSourceEvidence(value: Record<string, unknown>): FeedbackSourceEvidenceV2 | null {
  if (
    !isSourceRelationship(value.relationship) ||
    !isSourceFormat(value.format) ||
    value.normalization !== 'lf' ||
    !isSha256(value.sourceSliceSha256)
  ) {
    return null;
  }

  if (value.availability === 'embedded') {
    if (
      !hasExactKeys(value, [
        'kind',
        'fidelity',
        'relationship',
        'format',
        'normalization',
        'sourceSliceSha256',
        'availability',
        'text',
        'utf8Bytes',
      ]) ||
      value.fidelity !== 'source-exact' ||
      !isSafeEvidenceText(value.text, true) ||
      !isNonNegativeSafeInteger(value.utf8Bytes) ||
      value.utf8Bytes !== feedbackUtf8ByteLengthV2(value.text)
    ) {
      return null;
    }
    return {
      kind: 'source',
      fidelity: 'source-exact',
      relationship: value.relationship,
      format: value.format,
      normalization: 'lf',
      sourceSliceSha256: value.sourceSliceSha256,
      availability: 'embedded',
      text: value.text,
      utf8Bytes: value.utf8Bytes,
    };
  }

  if (
    !hasExactKeys(value, [
      'kind',
      'fidelity',
      'relationship',
      'format',
      'normalization',
      'sourceSliceSha256',
      'availability',
      'omittedReason',
      'omittedUtf8Bytes',
    ]) ||
    value.fidelity !== 'source-reference' ||
    value.availability !== 'omitted' ||
    (value.omittedReason !== 'evidence-budget' && value.omittedReason !== 'unsafe-control') ||
    !isPositiveSafeInteger(value.omittedUtf8Bytes) ||
    value.omittedUtf8Bytes > FEEDBACK_MAX_SOURCE_SLICE_BYTES_V2
  ) {
    return null;
  }
  return {
    kind: 'source',
    fidelity: 'source-reference',
    relationship: value.relationship,
    format: value.format,
    normalization: 'lf',
    sourceSliceSha256: value.sourceSliceSha256,
    availability: 'omitted',
    omittedReason: value.omittedReason,
    omittedUtf8Bytes: value.omittedUtf8Bytes,
  };
}

function parseRenderedTextEvidence(
  value: Record<string, unknown>
): FeedbackRenderedTextEvidenceV2 | null {
  const expectedKeys = [
    'kind',
    'fidelity',
    'text',
    'complete',
    ...(hasOwn(value, 'language') ? ['language'] : []),
  ];
  if (
    !hasExactKeys(value, expectedKeys) ||
    value.fidelity !== 'rendered-exact' ||
    !isSafeEvidenceText(value.text, false) ||
    value.complete !== true ||
    (hasOwn(value, 'language') && typeof value.language !== 'string')
  ) {
    return null;
  }
  const language = sanitizeFeedbackLanguageV2(value.language);
  return {
    kind: 'rendered-text',
    fidelity: 'rendered-exact',
    text: value.text,
    complete: true,
    ...(language === undefined ? {} : { language }),
  };
}

function parseTableCellsEvidence(
  value: Record<string, unknown>
): FeedbackTableCellsEvidenceV2 | null {
  if (
    !hasExactKeys(value, ['kind', 'fidelity', 'complete', 'rows']) ||
    value.fidelity !== 'structured-semantic' ||
    typeof value.complete !== 'boolean'
  ) {
    return null;
  }
  const rows = parseTableRows(value.rows);
  if (rows === null || value.complete !== rows.every(row => row.every(cell => cell.complete))) {
    return null;
  }
  return {
    kind: 'table-cells',
    fidelity: 'structured-semantic',
    complete: value.complete,
    rows,
  };
}

function parseSemanticTextEvidence(
  value: Record<string, unknown>
): FeedbackSemanticTextEvidenceV2 | null {
  return hasExactKeys(value, ['kind', 'fidelity', 'text', 'complete', 'provenance']) &&
    value.fidelity === 'semantic-context' &&
    isSafeEvidenceText(value.text, false) &&
    typeof value.complete === 'boolean' &&
    value.provenance === 'renderer-fallback'
    ? {
        kind: 'semantic-text',
        fidelity: 'semantic-context',
        text: value.text,
        complete: value.complete,
        provenance: 'renderer-fallback',
      }
    : null;
}

function parseLegacyFocusEvidence(
  value: Record<string, unknown>
): FeedbackLegacyFocusEvidenceV2 | null {
  return hasExactKeys(value, ['kind', 'fidelity', 'text']) &&
    value.fidelity === 'legacy-unclassified' &&
    isSafeEvidenceText(value.text, false)
    ? {
        kind: 'legacy-focus',
        fidelity: 'legacy-unclassified',
        text: value.text,
      }
    : null;
}

function parseVisualSourceReference(value: unknown): FeedbackVisualSourceReferenceV2 | null {
  return isRecord(value) &&
    hasExactKeys(value, ['relationship', 'format', 'normalization', 'sourceSliceSha256']) &&
    value.relationship === 'containing-blocks' &&
    isSourceFormat(value.format) &&
    value.normalization === 'lf' &&
    isSha256(value.sourceSliceSha256)
    ? {
        relationship: 'containing-blocks',
        format: value.format,
        normalization: 'lf',
        sourceSliceSha256: value.sourceSliceSha256,
      }
    : null;
}

function parseVisualEvidence(value: Record<string, unknown>): FeedbackVisualEvidenceV2 | null {
  if (
    !hasExactKeys(value, [
      'kind',
      'fidelity',
      'assetRelativePath',
      'assetSha256',
      'width',
      'height',
      'sourceReference',
    ]) ||
    value.fidelity !== 'visual-exact' ||
    typeof value.assetRelativePath !== 'string' ||
    !SCREENSHOT_ASSET_PATTERN.test(value.assetRelativePath) ||
    !isSha256(value.assetSha256) ||
    !isPositiveSafeInteger(value.width) ||
    !isPositiveSafeInteger(value.height) ||
    value.width > FEEDBACK_MAX_SCREENSHOT_DIMENSION_V2 ||
    value.height > FEEDBACK_MAX_SCREENSHOT_DIMENSION_V2 ||
    value.width > Math.floor(FEEDBACK_MAX_SCREENSHOT_PIXELS_V2 / value.height)
  ) {
    return null;
  }
  const sourceReference = parseVisualSourceReference(value.sourceReference);
  return sourceReference === null
    ? null
    : {
        kind: 'visual',
        fidelity: 'visual-exact',
        assetRelativePath: value.assetRelativePath,
        assetSha256: value.assetSha256,
        width: value.width,
        height: value.height,
        sourceReference,
      };
}

function parseFeedbackEvidenceV2(value: unknown): FeedbackEvidenceV2 | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'source') return parseSourceEvidence(value);
  if (value.kind === 'rendered-text') return parseRenderedTextEvidence(value);
  if (value.kind === 'table-cells') return parseTableCellsEvidence(value);
  if (value.kind === 'semantic-text') return parseSemanticTextEvidence(value);
  if (value.kind === 'legacy-focus') return parseLegacyFocusEvidence(value);
  if (value.kind === 'visual') return parseVisualEvidence(value);
  return null;
}

/** Returns a content-free canonical descriptor safe for report metadata. */
export function feedbackEvidenceDescriptorV2(
  evidence: FeedbackEvidenceV2
): FeedbackEvidenceDescriptorV2 {
  if (evidence.kind === 'source') {
    if (evidence.availability === 'embedded') {
      return {
        kind: 'source',
        fidelity: 'source-exact',
        relationship: evidence.relationship,
        format: evidence.format,
        normalization: 'lf',
        sourceSliceSha256: evidence.sourceSliceSha256,
        availability: 'embedded',
        utf8Bytes: evidence.utf8Bytes,
      };
    }
    return {
      kind: 'source',
      fidelity: 'source-reference',
      relationship: evidence.relationship,
      format: evidence.format,
      normalization: 'lf',
      sourceSliceSha256: evidence.sourceSliceSha256,
      availability: 'omitted',
      omittedReason: evidence.omittedReason,
      omittedUtf8Bytes: evidence.omittedUtf8Bytes,
    };
  }
  if (evidence.kind === 'rendered-text') {
    return {
      kind: 'rendered-text',
      fidelity: 'rendered-exact',
      complete: true,
      ...(evidence.language === undefined ? {} : { language: evidence.language }),
    };
  }
  if (evidence.kind === 'table-cells') {
    return {
      kind: 'table-cells',
      fidelity: 'structured-semantic',
      complete: evidence.complete,
      rowCount: evidence.rows.length,
      columnCount: evidence.rows[0]?.length ?? 0,
    };
  }
  if (evidence.kind === 'semantic-text') {
    return {
      kind: 'semantic-text',
      fidelity: 'semantic-context',
      complete: evidence.complete,
      provenance: 'renderer-fallback',
    };
  }
  if (evidence.kind === 'legacy-focus') {
    return {
      kind: 'legacy-focus',
      fidelity: 'legacy-unclassified',
    };
  }
  return {
    kind: 'visual',
    fidelity: 'visual-exact',
    assetRelativePath: evidence.assetRelativePath,
    assetSha256: evidence.assetSha256,
    width: evidence.width,
    height: evidence.height,
    sourceReference: { ...evidence.sourceReference },
  };
}

/** Returns the canonical, content-free descriptor for an evidence envelope. */
export function feedbackEvidenceEnvelopeDescriptorV2(
  envelope: FeedbackEvidenceEnvelopeV2
): FeedbackEvidenceEnvelopeDescriptorV2 {
  return {
    effective: feedbackEvidenceDescriptorV2(envelope.effective),
    ...(envelope.original === undefined
      ? {}
      : { original: feedbackEvidenceDescriptorV2(envelope.original) }),
  };
}

/** Counts user-controlled UTF-8 body bytes in one evidence value. */
export function feedbackTextualEvidenceBytesV2(evidence: FeedbackEvidenceV2): number {
  if (evidence.kind === 'source') {
    return evidence.availability === 'embedded' ? evidence.utf8Bytes : 0;
  }
  if (evidence.kind === 'table-cells') {
    return evidence.rows.reduce(
      (total, row) =>
        total + row.reduce((rowTotal, cell) => rowTotal + feedbackUtf8ByteLengthV2(cell.text), 0),
      0
    );
  }
  if (evidence.kind === 'visual') return 0;
  return feedbackUtf8ByteLengthV2(evidence.text);
}

/** Counts shared textual evidence bytes across effective and original bodies. */
export function feedbackEvidenceEnvelopeTextBytesV2(envelope: FeedbackEvidenceEnvelopeV2): number {
  return (
    feedbackTextualEvidenceBytesV2(envelope.effective) +
    (envelope.original === undefined ? 0 : feedbackTextualEvidenceBytesV2(envelope.original))
  );
}

/** Parses one strict evidence envelope and returns its canonical clone. */
export function parseFeedbackEvidenceEnvelopeV2(value: unknown): FeedbackEvidenceEnvelopeV2 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['effective', ...(hasOwn(value, 'original') ? ['original'] : [])])
  ) {
    return null;
  }
  const effective = parseFeedbackEvidenceV2(value.effective);
  const original = hasOwn(value, 'original') ? parseFeedbackEvidenceV2(value.original) : undefined;
  if (effective === null || original === null) return null;
  const envelope: FeedbackEvidenceEnvelopeV2 = {
    effective,
    ...(original === undefined ? {} : { original }),
  };
  return feedbackEvidenceEnvelopeTextBytesV2(envelope) <= FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2 &&
    isFeedbackMetadataWithinBudgetV2(feedbackEvidenceEnvelopeDescriptorV2(envelope))
    ? envelope
    : null;
}

/** Returns a canonical target clone or throws when the value violates v2. */
export function cloneFeedbackTargetV2(value: unknown): FeedbackTargetV2 {
  const parsed = parseFeedbackTargetV2(value);
  if (parsed === null) throw new TypeError('Invalid Feedback target v2.');
  return parsed;
}

/** Returns a canonical evidence clone or throws when the value violates v2. */
export function cloneFeedbackEvidenceEnvelopeV2(value: unknown): FeedbackEvidenceEnvelopeV2 {
  const parsed = parseFeedbackEvidenceEnvelopeV2(value);
  if (parsed === null) throw new TypeError('Invalid Feedback evidence envelope v2.');
  return parsed;
}

function exactTableMatrixMatchesTarget(
  target: FeedbackExactTargetV2,
  evidence: FeedbackTableCellsEvidenceV2
): boolean {
  if (target.locator?.kind !== 'table-cells') return false;
  const rectangle = target.locator.value.rectangle;
  return (
    evidence.rows.length === rectangle.bottom - rectangle.top &&
    evidence.rows.every(row => row.length === rectangle.right - rectangle.left)
  );
}

function isContainingSourceEvidence(
  evidence: FeedbackEvidenceV2 | undefined
): evidence is FeedbackSourceEvidenceV2 {
  return evidence?.kind === 'source' && evidence.relationship === 'containing-blocks';
}

function degradedOriginalMatchesRequestedScope(
  target: FeedbackDegradedTargetV2,
  original: FeedbackEvidenceV2 | undefined
): boolean {
  if (original === undefined) return true;
  if (original.kind === 'semantic-text') return true;
  if (target.requestedScope === 'rendered-text') {
    return original.kind === 'rendered-text' || original.kind === 'legacy-focus';
  }
  if (target.requestedScope === 'table-cells') {
    return original.kind === 'table-cells' || original.kind === 'legacy-focus';
  }
  return original.kind === 'visual' || original.kind === 'legacy-focus';
}

/** Cross-validates persisted scope, resolution, locator, and evidence fidelity. */
export function isFeedbackTargetEvidenceCompatibleV2(
  target: FeedbackTargetV2,
  evidence: FeedbackEvidenceEnvelopeV2
): boolean {
  if (target.resolution === 'legacy-unknown') {
    return (
      isContainingSourceEvidence(evidence.effective) && evidence.original?.kind === 'legacy-focus'
    );
  }

  if (target.resolution === 'degraded') {
    return (
      isContainingSourceEvidence(evidence.effective) &&
      degradedOriginalMatchesRequestedScope(target, evidence.original)
    );
  }

  if (evidence.original !== undefined) return false;
  if (target.effectiveScope === 'blocks') {
    return (
      evidence.effective.kind === 'source' && evidence.effective.relationship === 'selected-blocks'
    );
  }
  if (target.effectiveScope === 'rendered-text') {
    return evidence.effective.kind === 'rendered-text';
  }
  if (target.effectiveScope === 'table-cells') {
    return (
      evidence.effective.kind === 'legacy-focus' ||
      (evidence.effective.kind === 'table-cells' &&
        exactTableMatrixMatchesTarget(target, evidence.effective))
    );
  }
  return evidence.effective.kind === 'visual';
}

/** Counts only embedded source bodies across a report's evidence envelopes. */
export function feedbackEmbeddedSourceBytesV2(
  envelopes: readonly FeedbackEvidenceEnvelopeV2[]
): number {
  let total = 0;
  for (const envelope of envelopes) {
    if (envelope.effective.kind === 'source' && envelope.effective.availability === 'embedded') {
      total += envelope.effective.utf8Bytes;
    }
    if (envelope.original?.kind === 'source' && envelope.original.availability === 'embedded') {
      total += envelope.original.utf8Bytes;
    }
  }
  return total;
}

/** Checks the inclusive one MiB aggregate embedded-source budget. */
export function isFeedbackEmbeddedSourceBudgetWithinLimitV2(
  envelopes: readonly FeedbackEvidenceEnvelopeV2[]
): boolean {
  return (
    feedbackEmbeddedSourceBytesV2(envelopes) <= FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2
  );
}

/** Escapes one cell for the reversible, non-authoritative TSV projection. */
export function escapeFeedbackTsvCellV2(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/** Derives a human-readable TSV projection from a canonical cell matrix. */
export function renderFeedbackTableCellsTsvV2(
  rows: readonly (readonly FeedbackTableCellV2[])[]
): string {
  return rows.map(row => row.map(cell => escapeFeedbackTsvCellV2(cell.text)).join('\t')).join('\n');
}

function longestMarkerRun(value: string, marker: '`' | '~'): number {
  let longest = 0;
  let current = 0;
  for (const character of value) {
    if (character === marker) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

/**
 * Wraps literal evidence in a safe Markdown fence. Conventional backticks win
 * ties and one-character near-ties; a materially shorter tilde fence wins for
 * hostile backtick-heavy bodies. Unsafe optional language tokens are omitted.
 */
export function renderFeedbackFencedBlockV2(language: unknown, body: string): string {
  const backtickLength = Math.max(3, longestMarkerRun(body, '`') + 1);
  const tildeLength = Math.max(3, longestMarkerRun(body, '~') + 1);
  const marker = backtickLength <= tildeLength + 1 ? '`' : '~';
  const fenceLength = marker === '`' ? backtickLength : tildeLength;
  const fence = marker.repeat(fenceLength);
  const safeLanguage = sanitizeFeedbackLanguageV2(language);
  return `${fence}${safeLanguage ?? ''}\n${body}\n${fence}`;
}
