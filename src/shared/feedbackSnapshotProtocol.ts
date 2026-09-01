/**
 * Strict host/renderer protocol for the two-stage Feedback snapshot boundary.
 *
 * Inspection reports expose only the current renderer text needed to detect
 * divergent dirty splits. Applied reports acknowledge authoritative source
 * installation, return the renderer's freshly serialized text for independent
 * host verification, and optionally carry canonical blocks from the owner.
 */

import type { CanonicalFeedbackBlock } from './feedbackProtocol';

export const FEEDBACK_SNAPSHOT_PROTOCOL_VERSION = 2 as const;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_SOURCE_LENGTH = 64 * 1024 * 1024;
const MAX_BLOCKS = 100_000;
const MAX_BLOCK_KIND_LENGTH = 128;
const TABLE_FINGERPRINT_PATTERN = /^md4h-table\/v1:[a-f0-9]{16}$/;

interface FeedbackSnapshotIdentity {
  readonly protocolVersion: typeof FEEDBACK_SNAPSHOT_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operationId: string;
  readonly documentVersion: number;
}

export interface FeedbackSnapshotInspectRequest extends FeedbackSnapshotIdentity {
  readonly type: 'feedback.snapshot.inspect';
}

export interface FeedbackSnapshotApplyRequest extends FeedbackSnapshotIdentity {
  readonly type: 'feedback.snapshot.apply';
  readonly content: string;
  readonly descriptorRevision: number;
  readonly includeCanonicalBlocks: boolean;
}

export type FeedbackSnapshotHostMessage =
  FeedbackSnapshotInspectRequest | FeedbackSnapshotApplyRequest;

interface FeedbackSnapshotReportBase extends FeedbackSnapshotIdentity {
  readonly type: 'feedback.snapshot.report';
  readonly viewGeneration: string;
  readonly localRevision: number;
  readonly dirty: boolean;
}

export interface FeedbackSnapshotInspectReport extends FeedbackSnapshotReportBase {
  readonly stage: 'inspect';
  readonly content: string;
}

export interface FeedbackSnapshotAppliedReport extends FeedbackSnapshotReportBase {
  readonly stage: 'applied';
  readonly dirty: false;
  /** Renderer serialization after applying the authoritative source. */
  readonly content: string;
  readonly canonicalDescriptorRevision: number;
  readonly blocks?: readonly CanonicalFeedbackBlock[];
}

export type FeedbackSnapshotReport = FeedbackSnapshotInspectReport | FeedbackSnapshotAppliedReport;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSource(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_SOURCE_LENGTH;
}

function hasIdentity(record: Record<string, unknown>): boolean {
  return (
    record.protocolVersion === FEEDBACK_SNAPSHOT_PROTOCOL_VERSION &&
    isIdentifier(record.requestId) &&
    isIdentifier(record.operationId) &&
    isRevision(record.documentVersion)
  );
}

function parseBlocks(value: unknown): readonly CanonicalFeedbackBlock[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BLOCKS) return null;

  let previousOrdinal = -1;
  let totalMarkdownLength = 0;
  const blocks: CanonicalFeedbackBlock[] = [];
  for (const candidate of value) {
    const hasTableFingerprint =
      isRecord(candidate) && Object.prototype.hasOwnProperty.call(candidate, 'tableFingerprint');
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, [
        'ordinal',
        'kind',
        'markdown',
        'contentSize',
        ...(hasTableFingerprint ? ['tableFingerprint'] : []),
      ]) ||
      !isRevision(candidate.ordinal) ||
      candidate.ordinal <= previousOrdinal ||
      typeof candidate.kind !== 'string' ||
      candidate.kind.length === 0 ||
      candidate.kind.length > MAX_BLOCK_KIND_LENGTH ||
      typeof candidate.markdown !== 'string' ||
      !isRevision(candidate.contentSize) ||
      (hasTableFingerprint &&
        (candidate.kind !== 'table' ||
          typeof candidate.tableFingerprint !== 'string' ||
          !TABLE_FINGERPRINT_PATTERN.test(candidate.tableFingerprint)))
    ) {
      return null;
    }
    totalMarkdownLength += candidate.markdown.length;
    if (totalMarkdownLength > MAX_SOURCE_LENGTH) return null;
    previousOrdinal = candidate.ordinal;
    blocks.push({
      ordinal: candidate.ordinal,
      kind: candidate.kind,
      markdown: candidate.markdown,
      contentSize: candidate.contentSize,
      ...(hasTableFingerprint ? { tableFingerprint: candidate.tableFingerprint as string } : {}),
    });
  }
  return blocks;
}

/** Parse one untrusted host snapshot command at the renderer boundary. */
export function parseFeedbackSnapshotHostMessage(
  value: unknown
): FeedbackSnapshotHostMessage | null {
  if (!isRecord(value) || !hasIdentity(value)) return null;

  if (value.type === 'feedback.snapshot.inspect') {
    return hasExactKeys(value, [
      'type',
      'protocolVersion',
      'requestId',
      'operationId',
      'documentVersion',
    ])
      ? {
          type: 'feedback.snapshot.inspect',
          protocolVersion: FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
          requestId: value.requestId as string,
          operationId: value.operationId as string,
          documentVersion: value.documentVersion as number,
        }
      : null;
  }

  if (
    value.type !== 'feedback.snapshot.apply' ||
    !hasExactKeys(value, [
      'type',
      'protocolVersion',
      'requestId',
      'operationId',
      'documentVersion',
      'content',
      'descriptorRevision',
      'includeCanonicalBlocks',
    ]) ||
    !isSource(value.content) ||
    !isRevision(value.descriptorRevision) ||
    typeof value.includeCanonicalBlocks !== 'boolean'
  ) {
    return null;
  }

  return {
    type: 'feedback.snapshot.apply',
    protocolVersion: FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
    requestId: value.requestId as string,
    operationId: value.operationId as string,
    documentVersion: value.documentVersion as number,
    content: value.content,
    descriptorRevision: value.descriptorRevision,
    includeCanonicalBlocks: value.includeCanonicalBlocks,
  };
}

/** Parse one untrusted renderer report at the extension-host boundary. */
export function parseFeedbackSnapshotReport(value: unknown): FeedbackSnapshotReport | null {
  if (
    !isRecord(value) ||
    value.type !== 'feedback.snapshot.report' ||
    !hasIdentity(value) ||
    !isIdentifier(value.viewGeneration) ||
    !isRevision(value.localRevision) ||
    typeof value.dirty !== 'boolean'
  ) {
    return null;
  }

  const common = {
    type: 'feedback.snapshot.report' as const,
    protocolVersion: FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
    requestId: value.requestId as string,
    operationId: value.operationId as string,
    documentVersion: value.documentVersion as number,
    viewGeneration: value.viewGeneration,
    localRevision: value.localRevision,
  };

  if (value.stage === 'inspect') {
    if (
      !hasExactKeys(value, [
        'type',
        'protocolVersion',
        'requestId',
        'operationId',
        'documentVersion',
        'stage',
        'viewGeneration',
        'localRevision',
        'dirty',
        'content',
      ]) ||
      !isSource(value.content)
    ) {
      return null;
    }
    return { ...common, stage: 'inspect', dirty: value.dirty, content: value.content };
  }

  const hasBlocks = Object.prototype.hasOwnProperty.call(value, 'blocks');
  if (
    value.stage !== 'applied' ||
    value.dirty !== false ||
    !hasExactKeys(value, [
      'type',
      'protocolVersion',
      'requestId',
      'operationId',
      'documentVersion',
      'stage',
      'viewGeneration',
      'localRevision',
      'dirty',
      'content',
      'canonicalDescriptorRevision',
      ...(hasBlocks ? ['blocks'] : []),
    ]) ||
    !isSource(value.content) ||
    !isRevision(value.canonicalDescriptorRevision)
  ) {
    return null;
  }
  const blocks = hasBlocks ? parseBlocks(value.blocks) : undefined;
  if (hasBlocks && blocks === null) return null;

  return {
    ...common,
    stage: 'applied',
    dirty: false,
    content: value.content,
    canonicalDescriptorRevision: value.canonicalDescriptorRevision,
    ...(blocks === undefined || blocks === null ? {} : { blocks }),
  };
}
