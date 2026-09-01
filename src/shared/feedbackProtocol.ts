/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Validated host/webview contracts for snapshot feedback sessions.
 * The extension host must parse every webview message through this module before
 * dispatch so unknown fields and malformed payloads never reach file operations.
 */

import {
  isFeedbackRendererTargetEvidenceCompatibleV2,
  parseFeedbackRendererEvidenceV2,
  parseFeedbackRendererTargetV2,
  type FeedbackRendererEvidenceV2,
  type FeedbackRendererTargetV2,
} from './feedbackEvidenceV2';

export const FEEDBACK_ERROR_CODES = {
  targetDoesNotMap: 'MD4H-FB-ANCHOR-001',
  blockMismatch: 'MD4H-FB-ANCHOR-002',
  resourceUnavailable: 'MD4H-FB-CAPTURE-001',
  rasterizationFailed: 'MD4H-FB-CAPTURE-002',
  sourceChanged: 'MD4H-FB-SNAPSHOT-001',
} as const;

export type FeedbackErrorCode = (typeof FEEDBACK_ERROR_CODES)[keyof typeof FEEDBACK_ERROR_CODES];

/** Maximum number of cells represented by one exact table-cell locator. */
export const FEEDBACK_MAX_EXACT_CELL_COUNT = 256;

/** Maximum aggregate exact table-cell geometry retained by one Feedback session. */
export const FEEDBACK_MAX_EXACT_CELL_COUNT_PER_SESSION = 4_096;

/**
 * Validate an exact cell rectangle with an overflow-safe area bound.
 * Coordinates remain zero-based with exclusive bottom and right edges.
 */
export function isFeedbackCellRectangleWithinExactLimit(rectangle: {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}): boolean {
  if (
    !Number.isSafeInteger(rectangle.top) ||
    !Number.isSafeInteger(rectangle.left) ||
    !Number.isSafeInteger(rectangle.bottom) ||
    !Number.isSafeInteger(rectangle.right) ||
    rectangle.top < 0 ||
    rectangle.left < 0 ||
    rectangle.bottom <= rectangle.top ||
    rectangle.right <= rectangle.left
  ) {
    return false;
  }
  const rows = rectangle.bottom - rectangle.top;
  const columns = rectangle.right - rectangle.left;
  return rows <= Math.floor(FEEDBACK_MAX_EXACT_CELL_COUNT / columns);
}

export interface CanonicalFeedbackBlock {
  ordinal: number;
  kind: string;
  markdown: string;
  /** ProseMirror node.content.size for strict block-relative range bounds. */
  contentSize: number;
  /** Frozen structural identity available only for canonical table blocks. */
  tableFingerprint?: string;
}

/** Untrusted block-relative half-open range sent by the frozen rich view. */
export interface FeedbackRenderedRangeInputV1 {
  version: 1;
  startOrdinal: number;
  startOffset: number;
  endOrdinal: number;
  endOffset: number;
}

/** Host-enriched frozen rendered-text locator persisted with the feedback item. */
export interface FeedbackRenderedRangeV1 extends FeedbackRenderedRangeInputV1 {
  startBlockSha256: string;
  endBlockSha256: string;
}

/** Untrusted rectangular table-cell selection sent by the frozen rich view. */
export interface FeedbackCellTargetInputV1 {
  version: 1;
  tableOrdinal: number;
  rectangle: {
    /** Zero-based, inclusive row. */
    top: number;
    /** Zero-based, inclusive column. */
    left: number;
    /** Zero-based, exclusive row. */
    bottom: number;
    /** Zero-based, exclusive column. */
    right: number;
  };
  tableFingerprint: string;
}

/** Host-enriched rendered-table locator persisted with the feedback item. */
export interface FeedbackCellTargetV1 extends FeedbackCellTargetInputV1 {
  tableBlockSha256: string;
}

interface FeedbackItemSummaryBase {
  id: string;
  startOrdinal: number;
  endOrdinal: number;
  startLine: number;
  endLine: number;
  feedback: string;
}

/** Complete, kind-specific item data accepted by the Feedback webview. */
export type FeedbackItemSummary = FeedbackItemSummaryBase &
  (
    | {
        kind: 'text';
        focus: string;
        /** Present only when exact metadata validates against the frozen canonical blocks. */
        renderedRange?: FeedbackRenderedRangeV1;
        /** Present only when a table target validates against its frozen containing block. */
        cellTarget?: FeedbackCellTargetV1;
        imageUri?: never;
      }
    | {
        kind: 'screenshot';
        /** Host-generated, CSP-scoped URI for displaying the saved screenshot. */
        imageUri: string;
        focus?: never;
        renderedRange?: never;
        cellTarget?: never;
      }
  );

/** Safe, content-free metadata used to offer an existing draft for opt-in resume. */
export interface FeedbackDraftSummary {
  round: string;
  createdAt: string;
  itemCount: number;
  feedbackFile: string;
}

/** Complete active-session state staged during an acknowledged split handoff. */
export interface FeedbackTransferSession {
  sessionId: string;
  evidenceVersion?: 2;
  source: string;
  sourceSha256: string;
  round: string;
  feedbackFile: string;
  anchors: Array<{ ordinal: number; startLine: number; endLine: number }>;
  items: FeedbackItemSummary[];
}

export type FeedbackSessionTransferRole = 'new-owner' | 'old-owner' | 'same-owner';

interface FeedbackRequestBase {
  requestId: string;
}

interface FeedbackSessionRequestBase extends FeedbackRequestBase {
  sessionId: string;
}

export type FeedbackWebviewMessage =
  | (FeedbackRequestBase & {
      /** Proves the Feedback controller exists for this exact renderer lifetime. */
      type: 'feedback.controller.ready';
      viewGeneration: string;
    })
  | (FeedbackRequestBase & {
      type: 'feedback.start';
      /** Legacy fallback. Snapshot-capable renderers enumerate only after authoritative apply. */
      blocks?: CanonicalFeedbackBlock[];
    })
  | (FeedbackRequestBase & {
      type: 'feedback.start.new';
      blocks?: CanonicalFeedbackBlock[];
    })
  | (FeedbackRequestBase & {
      type: 'feedback.draft.resume';
      round: string;
      blocks?: CanonicalFeedbackBlock[];
    })
  | (FeedbackRequestBase & {
      type: 'feedback.draft.reveal';
      round: string;
    })
  | (FeedbackRequestBase & {
      type: 'feedback.draft.discard';
      round: string;
    })
  | (FeedbackSessionRequestBase & {
      type: 'feedback.text.add';
      startOrdinal: number;
      endOrdinal: number;
      focus: string;
      feedback: string;
      renderedRange?: FeedbackRenderedRangeInputV1;
      cellTarget?: FeedbackCellTargetInputV1;
    })
  | (FeedbackSessionRequestBase & {
      type: 'feedback.text.add';
      startOrdinal: number;
      endOrdinal: number;
      feedback: string;
      target: FeedbackRendererTargetV2;
      evidence?: FeedbackRendererEvidenceV2;
    })
  | (FeedbackSessionRequestBase & {
      type: 'feedback.screenshot.add';
      startOrdinal: number;
      endOrdinal: number;
      imageDataUrl: string;
      feedback: string;
    })
  | (FeedbackSessionRequestBase & {
      type: 'feedback.screenshot.replace';
      id: string;
      startOrdinal: number;
      endOrdinal: number;
      imageDataUrl: string;
      feedback: string;
    })
  | (FeedbackSessionRequestBase & {
      type: 'feedback.item.edit';
      id: string;
      feedback: string;
    })
  | (FeedbackSessionRequestBase & {
      type: 'feedback.item.delete' | 'feedback.item.restore';
      id: string;
    })
  | (FeedbackSessionRequestBase & {
      type: 'feedback.capture.error';
      code: FeedbackErrorCode;
    })
  | (FeedbackSessionRequestBase & {
      type: 'feedback.finish';
      /** Renderer-known exact locators that must seal as safe block targets. */
      degradedTargetIds?: string[];
    })
  | (FeedbackSessionRequestBase & {
      type:
        | 'feedback.discard'
        | 'feedback.reveal'
        | 'feedback.copyDiagnostics'
        | 'feedback.close.ready';
    })
  | (FeedbackSessionRequestBase & {
      type: 'feedback.close.applied' | 'feedback.close.released' | 'feedback.close.retry';
      revision: number;
    })
  | (FeedbackRequestBase & {
      type: 'feedback.transition.applied';
      lockId: string;
      revision: number;
    })
  | (FeedbackRequestBase & {
      type: 'feedback.transition.retry';
      lockId: string;
      revision: number;
    })
  | (FeedbackRequestBase & {
      type: 'feedback.peer.lock.acquired';
      acquisitionId: string;
      lockId: string;
      replacesLockId: string | null;
      viewGeneration: string;
      revision: number;
    })
  | (FeedbackRequestBase & {
      type: 'feedback.peer.released';
      phase: 'apply' | 'commit';
      releaseId: string;
      lockId: string;
      viewGeneration: string;
      revision: number;
      documentVersion: number;
      contentSha256: string;
    })
  | (FeedbackRequestBase & {
      type: 'feedback.session.transfer.ack';
      phase: 'apply' | 'commit' | 'abort';
      role: FeedbackSessionTransferRole;
      transferId: string;
      oldSessionId: string;
      newSessionId: string;
      viewGeneration: string;
      revision: number;
      documentVersion: number;
      sourceSha256: string;
      applied: boolean;
    });

export type FeedbackHostMessage =
  | {
      type: 'feedback.drafts.available';
      drafts: FeedbackDraftSummary[];
    }
  | {
      /** Correlated recovery offered after Start discovers reusable Feedback state. */
      type: 'feedback.resume.available';
      requestId: string;
      kind: 'active-owner' | 'active-peer' | 'saved-draft';
      drafts: FeedbackDraftSummary[];
    }
  | {
      /** Tells the previous owner to leave review mode after an explicit handoff. */
      type: 'feedback.session.transferred';
      oldSessionId: string;
      /** Replacement owner token installed atomically as this view's peer lock. */
      lockId: string;
      message: string;
    }
  | {
      /** Stage an exact active session while the current renderer guard remains installed. */
      type: 'feedback.session.transfer';
      phase: 'apply';
      role: FeedbackSessionTransferRole;
      transferId: string;
      requestId: string;
      oldSessionId: string;
      newSessionId: string;
      viewGeneration: string;
      revision: number;
      documentVersion: number;
      sourceSha256: string;
      peerLockMessage: string;
      session: FeedbackTransferSession;
    }
  | {
      /** Commit an already-staged ownership handoff without replaying session state. */
      type: 'feedback.session.transfer';
      phase: 'commit';
      role: FeedbackSessionTransferRole;
      transferId: string;
      requestId: string;
      oldSessionId: string;
      newSessionId: string;
      viewGeneration: string;
      revision: number;
      documentVersion: number;
      sourceSha256: string;
      peerLockMessage: string;
    }
  | {
      /** Roll back an already-staged ownership handoff before host ownership changes. */
      type: 'feedback.session.transfer';
      phase: 'abort';
      role: FeedbackSessionTransferRole;
      transferId: string;
      requestId: string;
      oldSessionId: string;
      newSessionId: string;
      viewGeneration: string;
      revision: number;
      documentVersion: number;
      sourceSha256: string;
      peerLockMessage: string;
    }
  | {
      type: 'feedback.started';
      requestId: string;
      sessionId: string;
      evidenceVersion?: 2;
      source: string;
      sourceSha256: string;
      round: string;
      feedbackFile: string;
      anchors: Array<{ ordinal: number; startLine: number; endLine: number }>;
      items: FeedbackItemSummary[];
    }
  | {
      type: 'feedback.updated';
      requestId: string;
      sessionId: string;
      items: FeedbackItemSummary[];
    }
  | {
      type: 'feedback.finished';
      requestId: string;
      sessionId: string;
      feedbackFile: string;
      itemCount: number;
      prompt: string;
      promptCopied: boolean;
    }
  | {
      type: 'feedback.discarded';
      requestId: string;
      sessionId: string;
    }
  | {
      /**
       * Authoritative source sent while the review owner is still locked.
       * The webview acknowledges only after applying it and closing locally.
       */
      type: 'feedback.close.sync';
      requestId: string;
      sessionId: string;
      revision: number;
      content: string;
    }
  | {
      /** Host confirmation that the applied revision is still authoritative. */
      type: 'feedback.close.release';
      requestId: string;
      sessionId: string;
      revision: number;
    }
  | {
      /** Host-owned transition token for the initiating rich-view split. */
      type: 'feedback.transition.locked';
      requestId: string;
      lockId: string;
    }
  | {
      /** Authoritative recovery for a failed Start, Resume, or draft transition. */
      type: 'feedback.transition.sync';
      requestId: string;
      lockId: string;
      revision: number;
      content: string;
    }
  | {
      type: 'feedback.draft.discarded';
      requestId: string;
      round: string;
    }
  | {
      type: 'feedback.diagnosticsCopied';
      requestId: string;
      sessionId: string;
    }
  | {
      type: 'feedback.invalidated';
      sessionId: string;
      code: typeof FEEDBACK_ERROR_CODES.sourceChanged;
      message: string;
    }
  | {
      type: 'feedback.error';
      requestId?: string;
      /** Present for errors produced by an active frozen session. */
      sessionId?: string;
      code?: FeedbackErrorCode | 'MD4H-FB-STORE-001' | 'MD4H-FB-STORE-002';
      message: string;
      recoverable: boolean;
    }
  | {
      /** Install a peer lock for one exact renderer generation, then ACK it. */
      type: 'feedback.peer.lock.acquire';
      acquisitionId: string;
      requestId: string;
      lockId: string;
      replacesLockId: string | null;
      viewGeneration: string;
      revision: number;
      message: string;
    }
  | {
      type: 'feedback.peer.locked';
      /** Correlates a later unlock so stale lifecycle messages fail closed. */
      lockId: string;
      message: string;
    }
  | {
      /** Apply authoritative content under lock before global commit. */
      type: 'feedback.peer.release';
      phase: 'apply';
      releaseId: string;
      requestId: string;
      lockId: string;
      viewGeneration: string;
      revision: number;
      documentVersion: number;
      contentSha256: string;
      content: string;
    }
  | {
      /** Unlock an already-applied identity without retransmitting Markdown. */
      type: 'feedback.peer.release';
      phase: 'commit';
      releaseId: string;
      requestId: string;
      lockId: string;
      viewGeneration: string;
      revision: number;
      documentVersion: number;
      contentSha256: string;
    }
  | {
      type: 'feedback.peer.unlocked';
      lockId: string;
    }
  | {
      type: 'feedback.command';
      command:
        | 'start'
        | 'commentSelection'
        | 'captureArea'
        | 'captureSelectedBlocks'
        | 'toggleComments'
        | 'nextFeedback'
        | 'previousFeedback'
        | 'finish'
        | 'reveal'
        | 'discard';
    };

const MAX_ID_LENGTH = 256;
const MAX_FEEDBACK_LENGTH = 100_000;
const MAX_FOCUS_LENGTH = 1_000_000;
const MAX_BLOCKS = 100_000;
const MAX_CANONICAL_MARKDOWN_LENGTH = 10 * 1024 * 1024;
const MAX_DOCUMENT_CONTENT_LENGTH = 64 * 1024 * 1024;
const MAX_PNG_DATA_URL_LENGTH = 14 * 1024 * 1024;
const MAX_PATH_LENGTH = 32_768;
const MAX_WEBVIEW_URI_LENGTH = 1024 * 1024;
const MAX_TABLE_COORDINATE = 100_000;
const MAX_FEEDBACK_ITEMS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnsafeTextControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 8 || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    !hasUnsafeTextControl(value) &&
    (allowEmpty || value.trim().length > 0)
  );
}

function isDocumentContent(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_DOCUMENT_CONTENT_LENGTH;
}

function isDocumentVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRequestId(value: unknown): value is string {
  return isBoundedString(value, MAX_ID_LENGTH);
}

function isSessionId(value: unknown): value is string {
  return isBoundedString(value, MAX_ID_LENGTH);
}

function isRoundId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{8}T\d{6}Z-[a-z0-9]{4}$/.test(value);
}

function isFeedbackId(value: unknown): value is string {
  return typeof value === 'string' && /^F[1-9]\d{0,8}$/.test(value);
}

function parseUniqueFeedbackIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_FEEDBACK_ITEMS) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isFeedbackId(candidate) || seen.has(candidate)) return null;
    seen.add(candidate);
    ids.push(candidate);
  }
  return ids;
}

function isFeedbackErrorCode(value: unknown): value is FeedbackErrorCode {
  return (
    value === FEEDBACK_ERROR_CODES.targetDoesNotMap ||
    value === FEEDBACK_ERROR_CODES.blockMismatch ||
    value === FEEDBACK_ERROR_CODES.resourceUnavailable ||
    value === FEEDBACK_ERROR_CODES.rasterizationFailed ||
    value === FEEDBACK_ERROR_CODES.sourceChanged
  );
}

function isOrdinal(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFeedbackItemCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_BLOCKS;
}

function isContentSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(record).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function parseRenderedRangeInput(value: unknown): FeedbackRenderedRangeInputV1 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'startOrdinal', 'startOffset', 'endOrdinal', 'endOffset']) ||
    value.version !== 1 ||
    !isOrdinal(value.startOrdinal) ||
    !isOrdinal(value.startOffset) ||
    !isOrdinal(value.endOrdinal) ||
    !isOrdinal(value.endOffset) ||
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

function parseCellRectangle(value: unknown): FeedbackCellTargetInputV1['rectangle'] | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['top', 'left', 'bottom', 'right']) ||
    !isOrdinal(value.top) ||
    !isOrdinal(value.left) ||
    !isOrdinal(value.bottom) ||
    !isOrdinal(value.right) ||
    value.top >= value.bottom ||
    value.left >= value.right ||
    value.bottom > MAX_TABLE_COORDINATE ||
    value.right > MAX_TABLE_COORDINATE ||
    !isFeedbackCellRectangleWithinExactLimit({
      top: value.top,
      left: value.left,
      bottom: value.bottom,
      right: value.right,
    })
  ) {
    return null;
  }
  return {
    top: value.top,
    left: value.left,
    bottom: value.bottom,
    right: value.right,
  };
}

function isTableFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^md4h-table\/v1:[a-f0-9]{16}$/.test(value);
}

function parseCellTargetInput(value: unknown): FeedbackCellTargetInputV1 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['version', 'tableOrdinal', 'rectangle', 'tableFingerprint']) ||
    value.version !== 1 ||
    !isOrdinal(value.tableOrdinal) ||
    value.tableOrdinal >= MAX_BLOCKS ||
    !isTableFingerprint(value.tableFingerprint)
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

function isRange(record: Record<string, unknown>): boolean {
  return (
    isOrdinal(record.startOrdinal) &&
    isOrdinal(record.endOrdinal) &&
    record.startOrdinal <= record.endOrdinal
  );
}

function parseBlocks(value: unknown): CanonicalFeedbackBlock[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BLOCKS) {
    return null;
  }

  let totalMarkdownLength = 0;
  const blocks: CanonicalFeedbackBlock[] = [];
  let previousOrdinal = -1;
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
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
      !isOrdinal(candidate.ordinal) ||
      candidate.ordinal <= previousOrdinal ||
      !isBoundedString(candidate.kind, 80) ||
      !isBoundedString(candidate.markdown, MAX_CANONICAL_MARKDOWN_LENGTH, true) ||
      !isContentSize(candidate.contentSize) ||
      (hasTableFingerprint &&
        (candidate.kind !== 'table' || !isTableFingerprint(candidate.tableFingerprint)))
    ) {
      return null;
    }

    totalMarkdownLength += candidate.markdown.length;
    if (totalMarkdownLength > MAX_CANONICAL_MARKDOWN_LENGTH) {
      return null;
    }

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

function isPngDataUrl(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_PNG_DATA_URL_LENGTH ||
    !value.startsWith('data:image/png;base64,')
  ) {
    return false;
  }

  const encoded = value.slice('data:image/png;base64,'.length);
  return encoded.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded);
}

/**
 * Parse an untrusted webview message into the small, explicit Feedback union.
 * Every top-level and nested object must exactly match its discriminated shape,
 * then the result is reconstructed field-by-field before host dispatch.
 */
export function parseFeedbackWebviewMessage(value: unknown): FeedbackWebviewMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !isRequestId(value.requestId)) {
    return null;
  }

  if (value.type === 'feedback.controller.ready') {
    return hasExactKeys(value, ['type', 'requestId', 'viewGeneration']) &&
      isSessionId(value.viewGeneration)
      ? {
          type: value.type,
          requestId: value.requestId,
          viewGeneration: value.viewGeneration,
        }
      : null;
  }

  if (value.type === 'feedback.start' || value.type === 'feedback.start.new') {
    const hasBlocks = hasOwn(value, 'blocks');
    if (!hasExactKeys(value, ['type', 'requestId', ...(hasBlocks ? ['blocks'] : [])])) return null;
    const blocks = hasBlocks ? parseBlocks(value.blocks) : undefined;
    return hasBlocks && !blocks
      ? null
      : {
          type: value.type,
          requestId: value.requestId,
          ...(blocks ? { blocks } : {}),
        };
  }

  if (value.type === 'feedback.draft.resume') {
    const hasBlocks = hasOwn(value, 'blocks');
    if (!hasExactKeys(value, ['type', 'requestId', 'round', ...(hasBlocks ? ['blocks'] : [])])) {
      return null;
    }
    const blocks = hasBlocks ? parseBlocks(value.blocks) : undefined;
    return (!hasBlocks || blocks) && isRoundId(value.round)
      ? {
          type: value.type,
          requestId: value.requestId,
          round: value.round,
          ...(blocks ? { blocks } : {}),
        }
      : null;
  }

  if (value.type === 'feedback.draft.reveal' || value.type === 'feedback.draft.discard') {
    if (!hasExactKeys(value, ['type', 'requestId', 'round'])) return null;
    return isRoundId(value.round)
      ? { type: value.type, requestId: value.requestId, round: value.round }
      : null;
  }

  if (value.type === 'feedback.transition.applied' || value.type === 'feedback.transition.retry') {
    return hasExactKeys(value, ['type', 'requestId', 'lockId', 'revision']) &&
      isSessionId(value.lockId) &&
      isCloseRevision(value.revision)
      ? {
          type: value.type,
          requestId: value.requestId,
          lockId: value.lockId,
          revision: value.revision,
        }
      : null;
  }

  if (value.type === 'feedback.peer.released') {
    return hasExactKeys(value, [
      'type',
      'phase',
      'releaseId',
      'requestId',
      'lockId',
      'viewGeneration',
      'revision',
      'documentVersion',
      'contentSha256',
    ]) &&
      (value.phase === 'apply' || value.phase === 'commit') &&
      isRequestId(value.releaseId) &&
      isSessionId(value.lockId) &&
      isSessionId(value.viewGeneration) &&
      isCloseRevision(value.revision) &&
      isDocumentVersion(value.documentVersion) &&
      isSha256(value.contentSha256)
      ? {
          type: value.type,
          phase: value.phase,
          releaseId: value.releaseId,
          requestId: value.requestId,
          lockId: value.lockId,
          viewGeneration: value.viewGeneration,
          revision: value.revision,
          documentVersion: value.documentVersion,
          contentSha256: value.contentSha256,
        }
      : null;
  }

  if (value.type === 'feedback.session.transfer.ack') {
    return hasExactKeys(value, [
      'type',
      'phase',
      'role',
      'transferId',
      'requestId',
      'oldSessionId',
      'newSessionId',
      'viewGeneration',
      'revision',
      'documentVersion',
      'sourceSha256',
      'applied',
    ]) &&
      (value.phase === 'apply' || value.phase === 'commit' || value.phase === 'abort') &&
      (value.role === 'new-owner' || value.role === 'old-owner' || value.role === 'same-owner') &&
      isRequestId(value.transferId) &&
      isSessionId(value.oldSessionId) &&
      isSessionId(value.newSessionId) &&
      value.oldSessionId !== value.newSessionId &&
      isSessionId(value.viewGeneration) &&
      isCloseRevision(value.revision) &&
      isDocumentVersion(value.documentVersion) &&
      isSha256(value.sourceSha256) &&
      typeof value.applied === 'boolean'
      ? {
          type: value.type,
          phase: value.phase,
          role: value.role,
          transferId: value.transferId,
          requestId: value.requestId,
          oldSessionId: value.oldSessionId,
          newSessionId: value.newSessionId,
          viewGeneration: value.viewGeneration,
          revision: value.revision,
          documentVersion: value.documentVersion,
          sourceSha256: value.sourceSha256,
          applied: value.applied,
        }
      : null;
  }

  if (value.type === 'feedback.peer.lock.acquired') {
    return hasExactKeys(value, [
      'type',
      'acquisitionId',
      'requestId',
      'lockId',
      'replacesLockId',
      'viewGeneration',
      'revision',
    ]) &&
      isRequestId(value.acquisitionId) &&
      isSessionId(value.lockId) &&
      (value.replacesLockId === null || isSessionId(value.replacesLockId)) &&
      isSessionId(value.viewGeneration) &&
      isCloseRevision(value.revision)
      ? {
          type: value.type,
          acquisitionId: value.acquisitionId,
          requestId: value.requestId,
          lockId: value.lockId,
          replacesLockId: value.replacesLockId,
          viewGeneration: value.viewGeneration,
          revision: value.revision,
        }
      : null;
  }

  if (!isSessionId(value.sessionId)) {
    return null;
  }

  const base = { requestId: value.requestId, sessionId: value.sessionId };
  switch (value.type) {
    case 'feedback.text.add': {
      if (hasOwn(value, 'target')) {
        const hasEvidence = hasOwn(value, 'evidence');
        if (
          !hasExactKeys(value, [
            'type',
            'requestId',
            'sessionId',
            'startOrdinal',
            'endOrdinal',
            'feedback',
            'target',
            ...(hasEvidence ? ['evidence'] : []),
          ]) ||
          !isRange(value) ||
          !isBoundedString(value.feedback, MAX_FEEDBACK_LENGTH)
        ) {
          return null;
        }
        const target = parseFeedbackRendererTargetV2(value.target);
        const evidence = hasEvidence ? parseFeedbackRendererEvidenceV2(value.evidence) : undefined;
        if (
          target === null ||
          (hasEvidence && evidence === null) ||
          !isFeedbackRendererTargetEvidenceCompatibleV2(target, evidence ?? undefined)
        ) {
          return null;
        }
        return {
          type: value.type,
          ...base,
          startOrdinal: value.startOrdinal as number,
          endOrdinal: value.endOrdinal as number,
          feedback: value.feedback,
          target,
          ...(evidence === undefined || evidence === null ? {} : { evidence }),
        };
      }
      if (
        !hasExactKeys(value, [
          'type',
          'requestId',
          'sessionId',
          'startOrdinal',
          'endOrdinal',
          'focus',
          'feedback',
          ...(hasOwn(value, 'renderedRange') ? ['renderedRange'] : []),
          ...(hasOwn(value, 'cellTarget') ? ['cellTarget'] : []),
        ])
      ) {
        return null;
      }
      const renderedRange =
        value.renderedRange === undefined
          ? undefined
          : parseRenderedRangeInput(value.renderedRange);
      const cellTarget =
        value.cellTarget === undefined ? undefined : parseCellTargetInput(value.cellTarget);
      if (
        !isRange(value) ||
        !isBoundedString(value.focus, MAX_FOCUS_LENGTH) ||
        !isBoundedString(value.feedback, MAX_FEEDBACK_LENGTH) ||
        (value.renderedRange !== undefined && renderedRange === null) ||
        (value.cellTarget !== undefined && cellTarget === null) ||
        (renderedRange !== undefined && cellTarget !== undefined && cellTarget !== null) ||
        (cellTarget !== undefined &&
          cellTarget !== null &&
          (value.startOrdinal !== value.endOrdinal ||
            value.startOrdinal !== cellTarget.tableOrdinal))
      ) {
        return null;
      }
      return {
        type: value.type,
        ...base,
        startOrdinal: value.startOrdinal as number,
        endOrdinal: value.endOrdinal as number,
        focus: value.focus,
        feedback: value.feedback,
        ...(renderedRange === undefined || renderedRange === null ? {} : { renderedRange }),
        ...(cellTarget === undefined || cellTarget === null ? {} : { cellTarget }),
      };
    }

    case 'feedback.screenshot.add':
      if (
        !hasExactKeys(value, [
          'type',
          'requestId',
          'sessionId',
          'startOrdinal',
          'endOrdinal',
          'imageDataUrl',
          'feedback',
        ]) ||
        !isRange(value) ||
        !isPngDataUrl(value.imageDataUrl) ||
        !isBoundedString(value.feedback, MAX_FEEDBACK_LENGTH)
      ) {
        return null;
      }
      return {
        type: value.type,
        ...base,
        startOrdinal: value.startOrdinal as number,
        endOrdinal: value.endOrdinal as number,
        imageDataUrl: value.imageDataUrl,
        feedback: value.feedback,
      };

    case 'feedback.screenshot.replace':
      if (
        !hasExactKeys(value, [
          'type',
          'requestId',
          'sessionId',
          'id',
          'startOrdinal',
          'endOrdinal',
          'imageDataUrl',
          'feedback',
        ]) ||
        !isFeedbackId(value.id) ||
        !isRange(value) ||
        !isPngDataUrl(value.imageDataUrl) ||
        !isBoundedString(value.feedback, MAX_FEEDBACK_LENGTH)
      ) {
        return null;
      }
      return {
        type: value.type,
        ...base,
        id: value.id,
        startOrdinal: value.startOrdinal as number,
        endOrdinal: value.endOrdinal as number,
        imageDataUrl: value.imageDataUrl,
        feedback: value.feedback,
      };

    case 'feedback.item.edit':
      if (
        !hasExactKeys(value, ['type', 'requestId', 'sessionId', 'id', 'feedback']) ||
        !isFeedbackId(value.id) ||
        !isBoundedString(value.feedback, MAX_FEEDBACK_LENGTH)
      ) {
        return null;
      }
      return { type: value.type, ...base, id: value.id, feedback: value.feedback };

    case 'feedback.item.delete':
    case 'feedback.item.restore':
      return hasExactKeys(value, ['type', 'requestId', 'sessionId', 'id']) && isFeedbackId(value.id)
        ? { type: value.type, ...base, id: value.id }
        : null;

    case 'feedback.capture.error':
      return hasExactKeys(value, ['type', 'requestId', 'sessionId', 'code']) &&
        isFeedbackErrorCode(value.code)
        ? { type: value.type, ...base, code: value.code }
        : null;

    case 'feedback.finish': {
      if (hasExactKeys(value, ['type', 'requestId', 'sessionId'])) {
        return { type: value.type, ...base };
      }
      if (!hasExactKeys(value, ['type', 'requestId', 'sessionId', 'degradedTargetIds'])) {
        return null;
      }
      const degradedTargetIds = parseUniqueFeedbackIds(value.degradedTargetIds);
      return degradedTargetIds === null ? null : { type: value.type, ...base, degradedTargetIds };
    }

    case 'feedback.discard':
    case 'feedback.reveal':
    case 'feedback.copyDiagnostics':
    case 'feedback.close.ready':
      return hasExactKeys(value, ['type', 'requestId', 'sessionId'])
        ? { type: value.type, ...base }
        : null;

    case 'feedback.close.applied':
    case 'feedback.close.released':
    case 'feedback.close.retry':
      return hasExactKeys(value, ['type', 'requestId', 'sessionId', 'revision']) &&
        isCloseRevision(value.revision)
        ? { type: value.type, ...base, revision: value.revision }
        : null;

    default:
      return null;
  }
}

function isPositiveLine(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isCloseRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isFeedbackHostErrorCode(
  value: unknown
): value is FeedbackErrorCode | 'MD4H-FB-STORE-001' | 'MD4H-FB-STORE-002' {
  return (
    value === 'MD4H-FB-STORE-001' || value === 'MD4H-FB-STORE-002' || isFeedbackErrorCode(value)
  );
}

function isFeedbackCommand(
  value: unknown
): value is Extract<FeedbackHostMessage, { type: 'feedback.command' }>['command'] {
  return (
    value === 'start' ||
    value === 'commentSelection' ||
    value === 'captureArea' ||
    value === 'captureSelectedBlocks' ||
    value === 'toggleComments' ||
    value === 'nextFeedback' ||
    value === 'previousFeedback' ||
    value === 'finish' ||
    value === 'reveal' ||
    value === 'discard'
  );
}

function parseRenderedRange(value: unknown): FeedbackRenderedRangeV1 | null {
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
    !isOrdinal(value.startOffset) ||
    !isOrdinal(value.endOrdinal) ||
    !isOrdinal(value.endOffset) ||
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

function parseCellTarget(value: unknown): FeedbackCellTargetV1 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'tableOrdinal',
      'rectangle',
      'tableFingerprint',
      'tableBlockSha256',
    ]) ||
    !isSha256(value.tableBlockSha256)
  ) {
    return null;
  }
  const input = parseCellTargetInput({
    version: value.version,
    tableOrdinal: value.tableOrdinal,
    rectangle: value.rectangle,
    tableFingerprint: value.tableFingerprint,
  });
  return input === null ? null : { ...input, tableBlockSha256: value.tableBlockSha256 };
}

function parseFeedbackItems(value: unknown): FeedbackItemSummary[] | null {
  if (!Array.isArray(value) || value.length > MAX_BLOCKS) return null;

  const items: FeedbackItemSummary[] = [];
  const itemIds = new Set<string>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !isFeedbackId(candidate.id) ||
      (candidate.kind !== 'text' && candidate.kind !== 'screenshot') ||
      !isOrdinal(candidate.startOrdinal) ||
      !isOrdinal(candidate.endOrdinal) ||
      candidate.startOrdinal > candidate.endOrdinal ||
      !isPositiveLine(candidate.startLine) ||
      !isPositiveLine(candidate.endLine) ||
      candidate.startLine > candidate.endLine
    ) {
      return null;
    }
    if (itemIds.has(candidate.id)) return null;
    itemIds.add(candidate.id);

    const commonKeys = [
      'id',
      'kind',
      'startOrdinal',
      'endOrdinal',
      'startLine',
      'endLine',
      'feedback',
    ];
    if (candidate.kind === 'text') {
      const expectedKeys = [
        ...commonKeys,
        'focus',
        ...(hasOwn(candidate, 'renderedRange') ? ['renderedRange'] : []),
        ...(hasOwn(candidate, 'cellTarget') ? ['cellTarget'] : []),
      ];
      if (
        !hasExactKeys(candidate, expectedKeys) ||
        !isBoundedString(candidate.focus, MAX_FOCUS_LENGTH) ||
        !isBoundedString(candidate.feedback, MAX_FEEDBACK_LENGTH)
      ) {
        return null;
      }
      const renderedRange = hasOwn(candidate, 'renderedRange')
        ? parseRenderedRange(candidate.renderedRange)
        : undefined;
      const cellTarget = hasOwn(candidate, 'cellTarget')
        ? parseCellTarget(candidate.cellTarget)
        : undefined;
      if (
        renderedRange === null ||
        cellTarget === null ||
        (renderedRange !== undefined && cellTarget !== undefined) ||
        (renderedRange !== undefined &&
          (renderedRange.startOrdinal !== candidate.startOrdinal ||
            renderedRange.endOrdinal !== candidate.endOrdinal)) ||
        (cellTarget !== undefined &&
          (candidate.startOrdinal !== candidate.endOrdinal ||
            cellTarget.tableOrdinal !== candidate.startOrdinal))
      ) {
        return null;
      }
      items.push({
        id: candidate.id,
        kind: 'text',
        startOrdinal: candidate.startOrdinal,
        endOrdinal: candidate.endOrdinal,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        focus: candidate.focus,
        feedback: candidate.feedback,
        ...(renderedRange === undefined ? {} : { renderedRange }),
        ...(cellTarget === undefined ? {} : { cellTarget }),
      });
      continue;
    }

    const expectedKeys = [...commonKeys, 'imageUri'];
    if (
      !hasExactKeys(candidate, expectedKeys) ||
      !isBoundedString(candidate.feedback, MAX_FEEDBACK_LENGTH) ||
      !isBoundedString(candidate.imageUri, MAX_WEBVIEW_URI_LENGTH)
    ) {
      return null;
    }
    items.push({
      id: candidate.id,
      kind: 'screenshot',
      startOrdinal: candidate.startOrdinal,
      endOrdinal: candidate.endOrdinal,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      feedback: candidate.feedback,
      imageUri: candidate.imageUri,
    });
  }

  return items;
}

function parseFeedbackDrafts(value: unknown): FeedbackDraftSummary[] | null {
  if (!Array.isArray(value) || value.length > MAX_BLOCKS) return null;

  const drafts: FeedbackDraftSummary[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['round', 'createdAt', 'itemCount', 'feedbackFile']) ||
      !isRoundId(candidate.round) ||
      !isBoundedString(candidate.createdAt, 128) ||
      !isOrdinal(candidate.itemCount) ||
      !isBoundedString(candidate.feedbackFile, MAX_PATH_LENGTH)
    ) {
      return null;
    }
    drafts.push({
      round: candidate.round,
      createdAt: candidate.createdAt,
      itemCount: candidate.itemCount,
      feedbackFile: candidate.feedbackFile,
    });
  }
  return drafts;
}

function parseFeedbackAnchors(
  value: unknown
): Array<{ ordinal: number; startLine: number; endLine: number }> | null {
  if (!Array.isArray(value) || value.length > MAX_BLOCKS) return null;

  const anchors: Array<{ ordinal: number; startLine: number; endLine: number }> = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['ordinal', 'startLine', 'endLine']) ||
      !isOrdinal(candidate.ordinal) ||
      !isPositiveLine(candidate.startLine) ||
      !isPositiveLine(candidate.endLine) ||
      candidate.startLine > candidate.endLine
    ) {
      return null;
    }
    anchors.push({
      ordinal: candidate.ordinal,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
    });
  }
  return anchors;
}

function parseFeedbackTransferSession(value: unknown): FeedbackTransferSession | null {
  const hasEvidenceVersion = isRecord(value) && hasOwn(value, 'evidenceVersion');
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'sessionId',
      ...(hasEvidenceVersion ? ['evidenceVersion'] : []),
      'source',
      'sourceSha256',
      'round',
      'feedbackFile',
      'anchors',
      'items',
    ]) ||
    !isSessionId(value.sessionId) ||
    (hasEvidenceVersion && value.evidenceVersion !== 2) ||
    !isBoundedString(value.source, MAX_PATH_LENGTH) ||
    !isSha256(value.sourceSha256) ||
    !isRoundId(value.round) ||
    !isBoundedString(value.feedbackFile, MAX_PATH_LENGTH)
  ) {
    return null;
  }
  const anchors = parseFeedbackAnchors(value.anchors);
  const items = parseFeedbackItems(value.items);
  return anchors === null || items === null
    ? null
    : {
        sessionId: value.sessionId,
        ...(hasEvidenceVersion ? { evidenceVersion: 2 as const } : {}),
        source: value.source,
        sourceSha256: value.sourceSha256,
        round: value.round,
        feedbackFile: value.feedbackFile,
        anchors,
        items,
      };
}

/**
 * Parse an untrusted extension-host message before it reaches Feedback UI state.
 * Every top-level and nested object must exactly match its discriminated shape.
 */
export function parseFeedbackHostMessage(value: unknown): FeedbackHostMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  switch (value.type) {
    case 'feedback.drafts.available': {
      if (!hasExactKeys(value, ['type', 'drafts'])) return null;
      const drafts = parseFeedbackDrafts(value.drafts);
      return drafts === null ? null : { type: value.type, drafts };
    }

    case 'feedback.resume.available': {
      if (
        !hasExactKeys(value, ['type', 'requestId', 'kind', 'drafts']) ||
        !isRequestId(value.requestId) ||
        (value.kind !== 'active-owner' &&
          value.kind !== 'active-peer' &&
          value.kind !== 'saved-draft')
      ) {
        return null;
      }
      const drafts = parseFeedbackDrafts(value.drafts);
      return drafts === null || drafts.length === 0
        ? null
        : {
            type: value.type,
            requestId: value.requestId,
            kind: value.kind,
            drafts,
          };
    }

    case 'feedback.session.transferred':
      return hasExactKeys(value, ['type', 'oldSessionId', 'lockId', 'message']) &&
        isSessionId(value.oldSessionId) &&
        isSessionId(value.lockId) &&
        isBoundedString(value.message, MAX_FEEDBACK_LENGTH)
        ? {
            type: value.type,
            oldSessionId: value.oldSessionId,
            lockId: value.lockId,
            message: value.message,
          }
        : null;

    case 'feedback.session.transfer': {
      const identityKeys = [
        'type',
        'phase',
        'role',
        'transferId',
        'requestId',
        'oldSessionId',
        'newSessionId',
        'viewGeneration',
        'revision',
        'documentVersion',
        'sourceSha256',
        'peerLockMessage',
      ];
      if (
        (value.phase !== 'apply' && value.phase !== 'commit' && value.phase !== 'abort') ||
        (value.role !== 'new-owner' && value.role !== 'old-owner' && value.role !== 'same-owner') ||
        !hasExactKeys(value, [...identityKeys, ...(value.phase === 'apply' ? ['session'] : [])]) ||
        !isRequestId(value.transferId) ||
        !isRequestId(value.requestId) ||
        !isSessionId(value.oldSessionId) ||
        !isSessionId(value.newSessionId) ||
        value.oldSessionId === value.newSessionId ||
        !isSessionId(value.viewGeneration) ||
        !isCloseRevision(value.revision) ||
        !isDocumentVersion(value.documentVersion) ||
        !isSha256(value.sourceSha256) ||
        !isBoundedString(value.peerLockMessage, MAX_FEEDBACK_LENGTH)
      ) {
        return null;
      }
      const identity = {
        role: value.role,
        transferId: value.transferId,
        requestId: value.requestId,
        oldSessionId: value.oldSessionId,
        newSessionId: value.newSessionId,
        viewGeneration: value.viewGeneration,
        revision: value.revision,
        documentVersion: value.documentVersion,
        sourceSha256: value.sourceSha256,
        peerLockMessage: value.peerLockMessage,
      } as const;
      if (value.phase !== 'apply') {
        return { type: value.type, phase: value.phase, ...identity };
      }
      const session = parseFeedbackTransferSession(value.session);
      return session?.sessionId === value.newSessionId &&
        session.sourceSha256 === value.sourceSha256
        ? { type: value.type, phase: 'apply', ...identity, session }
        : null;
    }

    case 'feedback.started': {
      const hasEvidenceVersion = hasOwn(value, 'evidenceVersion');
      if (
        !hasExactKeys(value, [
          'type',
          'requestId',
          'sessionId',
          ...(hasEvidenceVersion ? ['evidenceVersion'] : []),
          'source',
          'sourceSha256',
          'round',
          'feedbackFile',
          'anchors',
          'items',
        ]) ||
        !isRequestId(value.requestId) ||
        !isSessionId(value.sessionId) ||
        (hasEvidenceVersion && value.evidenceVersion !== 2) ||
        !isBoundedString(value.source, MAX_PATH_LENGTH) ||
        !isSha256(value.sourceSha256) ||
        !isRoundId(value.round) ||
        !isBoundedString(value.feedbackFile, MAX_PATH_LENGTH)
      ) {
        return null;
      }
      const anchors = parseFeedbackAnchors(value.anchors);
      const items = parseFeedbackItems(value.items);
      return anchors === null || items === null
        ? null
        : {
            type: value.type,
            requestId: value.requestId,
            sessionId: value.sessionId,
            ...(hasEvidenceVersion ? { evidenceVersion: 2 as const } : {}),
            source: value.source,
            sourceSha256: value.sourceSha256,
            round: value.round,
            feedbackFile: value.feedbackFile,
            anchors,
            items,
          };
    }

    case 'feedback.updated': {
      if (
        !hasExactKeys(value, ['type', 'requestId', 'sessionId', 'items']) ||
        !isRequestId(value.requestId) ||
        !isSessionId(value.sessionId)
      ) {
        return null;
      }
      const items = parseFeedbackItems(value.items);
      return items === null
        ? null
        : {
            type: value.type,
            requestId: value.requestId,
            sessionId: value.sessionId,
            items,
          };
    }

    case 'feedback.finished':
      return hasExactKeys(value, [
        'type',
        'requestId',
        'sessionId',
        'feedbackFile',
        'itemCount',
        'prompt',
        'promptCopied',
      ]) &&
        isRequestId(value.requestId) &&
        isSessionId(value.sessionId) &&
        isBoundedString(value.feedbackFile, MAX_PATH_LENGTH) &&
        isFeedbackItemCount(value.itemCount) &&
        isBoundedString(value.prompt, MAX_FOCUS_LENGTH) &&
        typeof value.promptCopied === 'boolean'
        ? {
            type: value.type,
            requestId: value.requestId,
            sessionId: value.sessionId,
            feedbackFile: value.feedbackFile,
            itemCount: value.itemCount,
            prompt: value.prompt,
            promptCopied: value.promptCopied,
          }
        : null;

    case 'feedback.discarded':
    case 'feedback.diagnosticsCopied':
      return hasExactKeys(value, ['type', 'requestId', 'sessionId']) &&
        isRequestId(value.requestId) &&
        isSessionId(value.sessionId)
        ? { type: value.type, requestId: value.requestId, sessionId: value.sessionId }
        : null;

    case 'feedback.close.sync':
      return hasExactKeys(value, ['type', 'requestId', 'sessionId', 'revision', 'content']) &&
        isRequestId(value.requestId) &&
        isSessionId(value.sessionId) &&
        isCloseRevision(value.revision) &&
        isDocumentContent(value.content)
        ? {
            type: value.type,
            requestId: value.requestId,
            sessionId: value.sessionId,
            revision: value.revision,
            content: value.content,
          }
        : null;

    case 'feedback.close.release':
      return hasExactKeys(value, ['type', 'requestId', 'sessionId', 'revision']) &&
        isRequestId(value.requestId) &&
        isSessionId(value.sessionId) &&
        isCloseRevision(value.revision)
        ? {
            type: value.type,
            requestId: value.requestId,
            sessionId: value.sessionId,
            revision: value.revision,
          }
        : null;

    case 'feedback.transition.sync':
      return hasExactKeys(value, ['type', 'requestId', 'lockId', 'revision', 'content']) &&
        isRequestId(value.requestId) &&
        isSessionId(value.lockId) &&
        isCloseRevision(value.revision) &&
        isDocumentContent(value.content)
        ? {
            type: value.type,
            requestId: value.requestId,
            lockId: value.lockId,
            revision: value.revision,
            content: value.content,
          }
        : null;

    case 'feedback.transition.locked':
      return hasExactKeys(value, ['type', 'requestId', 'lockId']) &&
        isRequestId(value.requestId) &&
        isSessionId(value.lockId)
        ? { type: value.type, requestId: value.requestId, lockId: value.lockId }
        : null;

    case 'feedback.draft.discarded':
      return hasExactKeys(value, ['type', 'requestId', 'round']) &&
        isRequestId(value.requestId) &&
        isRoundId(value.round)
        ? { type: value.type, requestId: value.requestId, round: value.round }
        : null;

    case 'feedback.invalidated':
      return hasExactKeys(value, ['type', 'sessionId', 'code', 'message']) &&
        isSessionId(value.sessionId) &&
        value.code === FEEDBACK_ERROR_CODES.sourceChanged &&
        isBoundedString(value.message, MAX_FEEDBACK_LENGTH)
        ? {
            type: value.type,
            sessionId: value.sessionId,
            code: value.code,
            message: value.message,
          }
        : null;

    case 'feedback.error': {
      const expectedKeys = [
        'type',
        'message',
        'recoverable',
        ...(hasOwn(value, 'requestId') ? ['requestId'] : []),
        ...(hasOwn(value, 'sessionId') ? ['sessionId'] : []),
        ...(hasOwn(value, 'code') ? ['code'] : []),
      ];
      if (
        !hasExactKeys(value, expectedKeys) ||
        (hasOwn(value, 'requestId') && !isRequestId(value.requestId)) ||
        (hasOwn(value, 'sessionId') && !isSessionId(value.sessionId)) ||
        (hasOwn(value, 'code') && !isFeedbackHostErrorCode(value.code)) ||
        !isBoundedString(value.message, MAX_FEEDBACK_LENGTH) ||
        typeof value.recoverable !== 'boolean'
      ) {
        return null;
      }
      return {
        type: value.type,
        ...(hasOwn(value, 'requestId') ? { requestId: value.requestId as string } : {}),
        ...(hasOwn(value, 'sessionId') ? { sessionId: value.sessionId as string } : {}),
        ...(hasOwn(value, 'code')
          ? {
              code: value.code as FeedbackErrorCode | 'MD4H-FB-STORE-001' | 'MD4H-FB-STORE-002',
            }
          : {}),
        message: value.message,
        recoverable: value.recoverable,
      };
    }

    case 'feedback.peer.locked':
      return hasExactKeys(value, ['type', 'lockId', 'message']) &&
        isSessionId(value.lockId) &&
        isBoundedString(value.message, MAX_FEEDBACK_LENGTH)
        ? { type: value.type, lockId: value.lockId, message: value.message }
        : null;

    case 'feedback.peer.lock.acquire':
      return hasExactKeys(value, [
        'type',
        'acquisitionId',
        'requestId',
        'lockId',
        'replacesLockId',
        'viewGeneration',
        'revision',
        'message',
      ]) &&
        isRequestId(value.acquisitionId) &&
        isRequestId(value.requestId) &&
        isSessionId(value.lockId) &&
        (value.replacesLockId === null || isSessionId(value.replacesLockId)) &&
        isSessionId(value.viewGeneration) &&
        isCloseRevision(value.revision) &&
        isBoundedString(value.message, MAX_FEEDBACK_LENGTH)
        ? {
            type: value.type,
            acquisitionId: value.acquisitionId,
            requestId: value.requestId,
            lockId: value.lockId,
            replacesLockId: value.replacesLockId,
            viewGeneration: value.viewGeneration,
            revision: value.revision,
            message: value.message,
          }
        : null;

    case 'feedback.peer.release':
      if (
        !isRequestId(value.releaseId) ||
        !isRequestId(value.requestId) ||
        !isSessionId(value.lockId) ||
        !isSessionId(value.viewGeneration) ||
        !isCloseRevision(value.revision) ||
        !isDocumentVersion(value.documentVersion) ||
        !isSha256(value.contentSha256)
      ) {
        return null;
      }
      if (value.phase === 'commit') {
        return hasExactKeys(value, [
          'type',
          'phase',
          'releaseId',
          'requestId',
          'lockId',
          'viewGeneration',
          'revision',
          'documentVersion',
          'contentSha256',
        ])
          ? {
              type: value.type,
              phase: value.phase,
              releaseId: value.releaseId,
              requestId: value.requestId,
              lockId: value.lockId,
              viewGeneration: value.viewGeneration,
              revision: value.revision,
              documentVersion: value.documentVersion,
              contentSha256: value.contentSha256,
            }
          : null;
      }
      return value.phase === 'apply' &&
        hasExactKeys(value, [
          'type',
          'phase',
          'releaseId',
          'requestId',
          'lockId',
          'viewGeneration',
          'revision',
          'documentVersion',
          'contentSha256',
          'content',
        ]) &&
        isDocumentContent(value.content)
        ? {
            type: value.type,
            phase: value.phase,
            releaseId: value.releaseId,
            requestId: value.requestId,
            lockId: value.lockId,
            viewGeneration: value.viewGeneration,
            revision: value.revision,
            documentVersion: value.documentVersion,
            contentSha256: value.contentSha256,
            content: value.content,
          }
        : null;

    case 'feedback.peer.unlocked':
      return hasExactKeys(value, ['type', 'lockId']) && isSessionId(value.lockId)
        ? { type: value.type, lockId: value.lockId }
        : null;

    case 'feedback.command':
      return hasExactKeys(value, ['type', 'command']) && isFeedbackCommand(value.command)
        ? { type: value.type, command: value.command }
        : null;

    default:
      return null;
  }
}
