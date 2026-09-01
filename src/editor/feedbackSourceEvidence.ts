/**
 * @file feedbackSourceEvidence.ts - Exact saved-source evidence projection
 * @description Builds a reusable logical-line index over validated saved UTF-8
 *              bytes and projects complete, LF-normalized source evidence.
 *              The module is deterministic, performs no I/O, and never treats
 *              renderer text as authored source.
 *
 * Key responsibilities:
 * - Bind projections to the SHA-256 of the exact saved bytes
 * - Preserve UTF-8 byte offsets across LF, CRLF, lone CR, BOM, and Unicode
 * - Enforce all-or-none item and aggregate embedding budgets
 * - Omit unsafe control-bearing text without returning its contents
 */

import { createHash } from 'crypto';

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF8_VALIDATION_CHUNK_BYTES = 64 * 1024;
const NORMALIZED_LINE_TERMINATOR = Buffer.from('\n', 'utf8');

/** Closed failures produced while indexing or projecting saved source evidence. */
export type FeedbackSourceEvidenceErrorCode =
  | 'invalid-source-bytes'
  | 'invalid-source-index'
  | 'invalid-utf8'
  | 'invalid-line-span'
  | 'invalid-budget'
  | 'invalid-projection-options';

/** Typed failure for a rejected source-evidence input. */
export class FeedbackSourceEvidenceError extends Error {
  /**
   * Creates a non-content-bearing source-evidence failure.
   *
   * @param code - Stable failure category
   * @param message - Safe diagnostic that does not include source contents
   */
  public constructor(
    public readonly code: FeedbackSourceEvidenceErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'FeedbackSourceEvidenceError';
  }
}

/** Physical terminator following one decoded logical source line. */
export type FeedbackSourceLineTerminator = 'lf' | 'crlf' | 'cr' | 'none';

/** Byte offsets for one 1-based logical line in the exact saved source. */
export interface FeedbackSourceLine {
  readonly line: number;
  /** Inclusive byte offset after an optional leading UTF-8 BOM. */
  readonly startByteOffset: number;
  /** Exclusive byte offset before this line's physical terminator. */
  readonly endByteOffset: number;
  /** Exclusive byte offset after this line's physical terminator. */
  readonly terminatorEndByteOffset: number;
  readonly terminator: FeedbackSourceLineTerminator;
}

/** Reusable, immutable index bound to one exact validated saved-byte snapshot. */
export interface FeedbackSourceIndex {
  readonly sourceBytesSha256: string;
  readonly sourceByteLength: number;
  readonly hasUtf8Bom: boolean;
  readonly lines: readonly FeedbackSourceLine[];
}

/** How a source excerpt relates to the effective feedback target. */
export type FeedbackSourceEvidenceRelationship = 'selected-blocks' | 'containing-blocks';

/** Authored format of the source excerpt. */
export type FeedbackSourceEvidenceFormat = 'markdown' | 'html' | 'text';

interface FeedbackSourceEvidenceBase {
  readonly kind: 'source';
  readonly relationship: FeedbackSourceEvidenceRelationship;
  readonly format: FeedbackSourceEvidenceFormat;
  readonly normalization: 'lf';
  readonly sourceSliceSha256: string;
}

/** Complete normalized source text that fits both embedding budgets. */
export interface FeedbackEmbeddedSourceEvidence extends FeedbackSourceEvidenceBase {
  readonly fidelity: 'source-exact';
  readonly availability: 'embedded';
  readonly text: string;
  readonly utf8Bytes: number;
}

/** Complete source identity retained when its text cannot safely be embedded. */
export interface FeedbackOmittedSourceEvidence extends FeedbackSourceEvidenceBase {
  readonly fidelity: 'source-reference';
  readonly availability: 'omitted';
  readonly omittedReason: 'evidence-budget' | 'unsafe-control';
  readonly omittedUtf8Bytes: number;
}

/** Source-evidence value ready for later v2 report integration. */
export type FeedbackProjectedSourceEvidence =
  FeedbackEmbeddedSourceEvidence | FeedbackOmittedSourceEvidence;

/** Validated inputs for projecting one inclusive logical-line span. */
export interface ProjectFeedbackSourceEvidenceOptions {
  readonly startLine: number;
  readonly endLine: number;
  readonly relationship: FeedbackSourceEvidenceRelationship;
  readonly format: FeedbackSourceEvidenceFormat;
  /** UTF-8 bytes still available to this item's textual evidence. */
  readonly itemUtf8Budget: number;
  /** UTF-8 bytes still available to embedded source across the bundle. */
  readonly remainingAggregateUtf8Budget: number;
}

/** Host-owned projection metadata plus its embedded or omitted v2 evidence. */
export interface FeedbackSourceEvidenceProjection {
  /** SHA-256 of the exact saved bytes, including BOM and original terminators. */
  readonly sourceBytesSha256: string;
  readonly sourceByteLength: number;
  readonly hasUtf8Bom: boolean;
  readonly sourceLineCount: number;
  readonly startLine: number;
  readonly endLine: number;
  /** Raw saved-byte range, with the final selected terminator excluded. */
  readonly sourceByteRange: {
    readonly startByteOffset: number;
    readonly endByteOffset: number;
  };
  /** Byte length after internal terminators are normalized to LF. */
  readonly normalizedByteLength: number;
  /** SHA-256 of the normalized logical-line projection. */
  readonly sourceSliceSha256: string;
  /** Aggregate source budget consumed by this result. Omitted evidence consumes zero. */
  readonly aggregateUtf8BytesConsumed: number;
  readonly evidence: FeedbackProjectedSourceEvidence;
}

class IndexedFeedbackSource implements FeedbackSourceIndex {
  readonly #sourceBytes: Buffer;
  readonly #lines: readonly FeedbackSourceLine[];

  public readonly sourceBytesSha256: string;
  public readonly sourceByteLength: number;
  public readonly hasUtf8Bom: boolean;

  public get lines(): readonly FeedbackSourceLine[] {
    return this.#lines;
  }

  public constructor(sourceBytes: Uint8Array) {
    this.#sourceBytes = Buffer.from(sourceBytes);
    this.sourceByteLength = this.#sourceBytes.byteLength;
    this.hasUtf8Bom = startsWithUtf8Bom(this.#sourceBytes);
    validateUtf8(this.#sourceBytes, this.hasUtf8Bom ? UTF8_BOM.length : 0);
    this.sourceBytesSha256 = sha256(this.#sourceBytes);
    this.#lines = indexLogicalLines(this.#sourceBytes, this.hasUtf8Bom ? UTF8_BOM.length : 0);
  }

  /**
   * Projects one complete normalized source slice from this exact snapshot.
   *
   * @param options - Inclusive line span, source metadata, and remaining budgets
   * @returns Complete embedded evidence or a content-free omission reference
   * @throws FeedbackSourceEvidenceError when the span, budgets, or metadata are invalid
   */
  public project(options: ProjectFeedbackSourceEvidenceOptions): FeedbackSourceEvidenceProjection {
    validateProjectionOptions(options, this.#lines.length);

    const selectedLines = this.#lines.slice(options.startLine - 1, options.endLine);
    const firstLine = selectedLines[0];
    const lastLine = selectedLines[selectedLines.length - 1];
    const normalizedByteLength = selectedLines.reduce(
      (total, line, index) =>
        total + (line.endByteOffset - line.startByteOffset) + (index === 0 ? 0 : 1),
      0
    );
    const sliceHash = createHash('sha256');
    let hasUnsafeControl = false;

    selectedLines.forEach((line, index) => {
      const lineBytes = this.#sourceBytes.subarray(line.startByteOffset, line.endByteOffset);
      sliceHash.update(lineBytes);
      hasUnsafeControl ||= containsUnsafeControl(lineBytes);
      if (index < selectedLines.length - 1) sliceHash.update(NORMALIZED_LINE_TERMINATOR);
    });

    const sourceSliceSha256 = sliceHash.digest('hex');
    const projectionBase = {
      sourceBytesSha256: this.sourceBytesSha256,
      sourceByteLength: this.sourceByteLength,
      hasUtf8Bom: this.hasUtf8Bom,
      sourceLineCount: this.#lines.length,
      startLine: options.startLine,
      endLine: options.endLine,
      sourceByteRange: {
        startByteOffset: firstLine.startByteOffset,
        endByteOffset: lastLine.endByteOffset,
      },
      normalizedByteLength,
      sourceSliceSha256,
    } as const;
    const evidenceBase = {
      kind: 'source',
      relationship: options.relationship,
      format: options.format,
      normalization: 'lf',
      sourceSliceSha256,
    } as const;

    if (hasUnsafeControl) {
      return {
        ...projectionBase,
        aggregateUtf8BytesConsumed: 0,
        evidence: {
          ...evidenceBase,
          fidelity: 'source-reference',
          availability: 'omitted',
          omittedReason: 'unsafe-control',
          omittedUtf8Bytes: normalizedByteLength,
        },
      };
    }

    if (
      normalizedByteLength > options.itemUtf8Budget ||
      normalizedByteLength > options.remainingAggregateUtf8Budget
    ) {
      return {
        ...projectionBase,
        aggregateUtf8BytesConsumed: 0,
        evidence: {
          ...evidenceBase,
          fidelity: 'source-reference',
          availability: 'omitted',
          omittedReason: 'evidence-budget',
          omittedUtf8Bytes: normalizedByteLength,
        },
      };
    }

    const normalizedBytes = Buffer.allocUnsafe(normalizedByteLength);
    let outputOffset = 0;
    selectedLines.forEach((line, index) => {
      outputOffset += this.#sourceBytes.copy(
        normalizedBytes,
        outputOffset,
        line.startByteOffset,
        line.endByteOffset
      );
      if (index < selectedLines.length - 1) {
        normalizedBytes[outputOffset] = NORMALIZED_LINE_TERMINATOR[0];
        outputOffset += 1;
      }
    });

    // The file-leading BOM was removed by byte offset. Any later U+FEFF is authored content.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(normalizedBytes);
    return {
      ...projectionBase,
      aggregateUtf8BytesConsumed: normalizedByteLength,
      evidence: {
        ...evidenceBase,
        fidelity: 'source-exact',
        availability: 'embedded',
        text,
        utf8Bytes: normalizedByteLength,
      },
    };
  }
}

/**
 * Builds a reusable logical-line index over one exact saved UTF-8 snapshot.
 * The input is defensively copied so later caller mutation cannot invalidate
 * its saved-byte hash or line offsets.
 *
 * @param sourceBytes - Exact bytes read from the saved source file
 * @returns Immutable line metadata bound to the exact saved-byte SHA-256
 * @throws FeedbackSourceEvidenceError when input is not bytes or is malformed UTF-8
 */
export function createFeedbackSourceIndex(sourceBytes: Uint8Array): FeedbackSourceIndex {
  if (!(sourceBytes instanceof Uint8Array)) {
    throw new FeedbackSourceEvidenceError(
      'invalid-source-bytes',
      'Feedback source evidence requires exact saved bytes.'
    );
  }
  return new IndexedFeedbackSource(sourceBytes);
}

/**
 * Projects one inclusive logical-line span from a validated saved-source index.
 * Internal terminators become LF, the final selected terminator is excluded,
 * and text is returned only when the complete slice is safe and within budget.
 *
 * @param source - Index returned by createFeedbackSourceIndex
 * @param options - Inclusive line span, relationship, format, and remaining budgets
 * @returns Deterministic embedded evidence or a content-free omission reference
 * @throws FeedbackSourceEvidenceError when the index or projection inputs are invalid
 */
export function projectFeedbackSourceEvidence(
  source: FeedbackSourceIndex,
  options: ProjectFeedbackSourceEvidenceOptions
): FeedbackSourceEvidenceProjection {
  if (!(source instanceof IndexedFeedbackSource)) {
    throw new FeedbackSourceEvidenceError(
      'invalid-source-index',
      'Feedback source evidence requires an index created from exact saved bytes.'
    );
  }
  return source.project(options);
}

function startsWithUtf8Bom(sourceBytes: Uint8Array): boolean {
  return (
    sourceBytes.byteLength >= UTF8_BOM.length &&
    sourceBytes[0] === UTF8_BOM[0] &&
    sourceBytes[1] === UTF8_BOM[1] &&
    sourceBytes[2] === UTF8_BOM[2]
  );
}

function validateUtf8(sourceBytes: Uint8Array, payloadStart: number): void {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (
      let offset = payloadStart;
      offset < sourceBytes.byteLength;
      offset += UTF8_VALIDATION_CHUNK_BYTES
    ) {
      decoder.decode(
        sourceBytes.subarray(
          offset,
          Math.min(offset + UTF8_VALIDATION_CHUNK_BYTES, sourceBytes.byteLength)
        ),
        { stream: true }
      );
    }
    decoder.decode();
  } catch {
    throw new FeedbackSourceEvidenceError(
      'invalid-utf8',
      'The saved Feedback source is not valid UTF-8.'
    );
  }
}

function indexLogicalLines(
  sourceBytes: Uint8Array,
  contentStartByteOffset: number
): readonly FeedbackSourceLine[] {
  const lines: FeedbackSourceLine[] = [];
  let lineStartByteOffset = contentStartByteOffset;
  let cursor = contentStartByteOffset;

  while (cursor < sourceBytes.byteLength) {
    const byte = sourceBytes[cursor];
    if (byte !== 0x0a && byte !== 0x0d) {
      cursor += 1;
      continue;
    }

    const crlf =
      byte === 0x0d && cursor + 1 < sourceBytes.byteLength && sourceBytes[cursor + 1] === 0x0a;
    const terminator: FeedbackSourceLineTerminator = crlf ? 'crlf' : byte === 0x0d ? 'cr' : 'lf';
    const terminatorEndByteOffset = cursor + (crlf ? 2 : 1);
    lines.push(
      Object.freeze({
        line: lines.length + 1,
        startByteOffset: lineStartByteOffset,
        endByteOffset: cursor,
        terminatorEndByteOffset,
        terminator,
      })
    );
    lineStartByteOffset = terminatorEndByteOffset;
    cursor = terminatorEndByteOffset;
  }

  lines.push(
    Object.freeze({
      line: lines.length + 1,
      startByteOffset: lineStartByteOffset,
      endByteOffset: sourceBytes.byteLength,
      terminatorEndByteOffset: sourceBytes.byteLength,
      terminator: 'none' as const,
    })
  );
  return Object.freeze(lines);
}

function validateProjectionOptions(
  options: ProjectFeedbackSourceEvidenceOptions,
  lineCount: number
): void {
  if (
    !Number.isSafeInteger(options.startLine) ||
    !Number.isSafeInteger(options.endLine) ||
    options.startLine < 1 ||
    options.endLine < options.startLine ||
    options.endLine > lineCount
  ) {
    throw new FeedbackSourceEvidenceError(
      'invalid-line-span',
      'Feedback source evidence requires a valid inclusive logical-line span.'
    );
  }
  if (
    !isByteBudget(options.itemUtf8Budget) ||
    !isByteBudget(options.remainingAggregateUtf8Budget)
  ) {
    throw new FeedbackSourceEvidenceError(
      'invalid-budget',
      'Feedback source evidence budgets must be non-negative safe integers.'
    );
  }
  if (
    (options.relationship !== 'selected-blocks' && options.relationship !== 'containing-blocks') ||
    (options.format !== 'markdown' && options.format !== 'html' && options.format !== 'text')
  ) {
    throw new FeedbackSourceEvidenceError(
      'invalid-projection-options',
      'Feedback source evidence relationship or format is invalid.'
    );
  }
}

function isByteBudget(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function containsUnsafeControl(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index];
    if ((byte <= 0x1f && byte !== 0x09) || byte === 0x7f) return true;
    if (
      byte === 0xc2 &&
      index + 1 < bytes.byteLength &&
      bytes[index + 1] >= 0x80 &&
      bytes[index + 1] <= 0x9f
    ) {
      return true;
    }
  }
  return false;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
