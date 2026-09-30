/**
 * Strict application-delivery envelope for correctness-critical Feedback messages.
 *
 * `Webview.postMessage()` confirms only that VS Code accepted a message for
 * delivery. This protocol binds the first critical renderer activation message
 * to an idempotency key and requires a correlated application acknowledgement.
 */

import { parseFeedbackHostMessage, type FeedbackHostMessage } from './feedbackProtocol';

export const FEEDBACK_DELIVERY_PROTOCOL_VERSION = 1 as const;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_REJECTION_CODE_LENGTH = 128;

type FeedbackStartedMessage = Extract<FeedbackHostMessage, { type: 'feedback.started' }>;

export interface FeedbackStartedDelivery {
  readonly type: 'feedback.delivery';
  readonly protocolVersion: typeof FEEDBACK_DELIVERY_PROTOCOL_VERSION;
  readonly messageId: string;
  readonly operationEpoch: string;
  readonly sessionEpoch: string;
  readonly stageRevision: number;
  readonly payload: FeedbackStartedMessage;
}

export type FeedbackDeliveryApplicationOutcome =
  | {
      readonly kind: 'applied';
      readonly value: { readonly messageType: 'feedback.started' };
    }
  | { readonly kind: 'rejected'; readonly code: string };

export interface FeedbackDeliveryAcknowledgement {
  readonly type: 'feedback.delivery.ack';
  readonly protocolVersion: typeof FEEDBACK_DELIVERY_PROTOCOL_VERSION;
  readonly messageId: string;
  readonly operationEpoch: string;
  readonly sessionEpoch: string;
  readonly stageRevision: number;
  readonly outcome: FeedbackDeliveryApplicationOutcome;
}

export interface FeedbackDeliveryIdentity {
  readonly messageId: string;
  readonly operationEpoch: string;
  readonly sessionEpoch: string;
  readonly stageRevision: number;
}

export interface FeedbackDeliveryStatusQuery extends FeedbackDeliveryIdentity {
  readonly type: 'feedback.delivery.status.query';
  readonly protocolVersion: typeof FEEDBACK_DELIVERY_PROTOCOL_VERSION;
}

export type FeedbackDeliveryApplicationStatus =
  | {
      readonly kind: 'applied';
      readonly value: { readonly messageType: 'feedback.started' };
    }
  | { readonly kind: 'inactive' }
  | { readonly kind: 'mismatch' };

export interface FeedbackDeliveryStatusResponse extends FeedbackDeliveryIdentity {
  readonly type: 'feedback.delivery.status.response';
  readonly protocolVersion: typeof FEEDBACK_DELIVERY_PROTOCOL_VERSION;
  readonly status: FeedbackDeliveryApplicationStatus;
}

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

function isBoundedText(value: unknown, maximumLength: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function isStageRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function hasDeliveryIdentity(record: Record<string, unknown>): boolean {
  return (
    isBoundedText(record.messageId, MAX_IDENTIFIER_LENGTH) &&
    isBoundedText(record.operationEpoch, MAX_IDENTIFIER_LENGTH) &&
    isBoundedText(record.sessionEpoch, MAX_IDENTIFIER_LENGTH) &&
    isStageRevision(record.stageRevision)
  );
}

/** Parse an untrusted host envelope and prove that its identity binds its payload. */
export function parseFeedbackStartedDelivery(value: unknown): FeedbackStartedDelivery | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'type',
      'protocolVersion',
      'messageId',
      'operationEpoch',
      'sessionEpoch',
      'stageRevision',
      'payload',
    ]) ||
    value.type !== 'feedback.delivery' ||
    value.protocolVersion !== FEEDBACK_DELIVERY_PROTOCOL_VERSION ||
    !isBoundedText(value.messageId, MAX_IDENTIFIER_LENGTH) ||
    !isBoundedText(value.operationEpoch, MAX_IDENTIFIER_LENGTH) ||
    !isBoundedText(value.sessionEpoch, MAX_IDENTIFIER_LENGTH) ||
    !isStageRevision(value.stageRevision)
  ) {
    return null;
  }

  const payload = parseFeedbackHostMessage(value.payload);
  if (
    payload?.type !== 'feedback.started' ||
    value.operationEpoch !== payload.requestId ||
    value.sessionEpoch !== payload.sessionId ||
    value.stageRevision !== 1
  ) {
    return null;
  }

  return {
    type: 'feedback.delivery',
    protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
    messageId: value.messageId,
    operationEpoch: value.operationEpoch,
    sessionEpoch: value.sessionEpoch,
    stageRevision: value.stageRevision,
    payload,
  };
}

function parseOutcome(value: unknown): FeedbackDeliveryApplicationOutcome | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;

  if (value.kind === 'applied') {
    if (
      !hasExactKeys(value, ['kind', 'value']) ||
      !isRecord(value.value) ||
      !hasExactKeys(value.value, ['messageType']) ||
      value.value.messageType !== 'feedback.started'
    ) {
      return null;
    }
    return { kind: 'applied', value: { messageType: 'feedback.started' } };
  }

  return value.kind === 'rejected' &&
    hasExactKeys(value, ['kind', 'code']) &&
    isBoundedText(value.code, MAX_REJECTION_CODE_LENGTH)
    ? { kind: 'rejected', code: value.code }
    : null;
}

/** Parse an untrusted renderer acknowledgement for a delivered Feedback command. */
export function parseFeedbackDeliveryAcknowledgement(
  value: unknown
): FeedbackDeliveryAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'type',
      'protocolVersion',
      'messageId',
      'operationEpoch',
      'sessionEpoch',
      'stageRevision',
      'outcome',
    ]) ||
    value.type !== 'feedback.delivery.ack' ||
    value.protocolVersion !== FEEDBACK_DELIVERY_PROTOCOL_VERSION ||
    !isBoundedText(value.messageId, MAX_IDENTIFIER_LENGTH) ||
    !isBoundedText(value.operationEpoch, MAX_IDENTIFIER_LENGTH) ||
    !isBoundedText(value.sessionEpoch, MAX_IDENTIFIER_LENGTH) ||
    !isStageRevision(value.stageRevision)
  ) {
    return null;
  }

  const outcome = parseOutcome(value.outcome);
  return outcome
    ? {
        type: 'feedback.delivery.ack',
        protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        messageId: value.messageId,
        operationEpoch: value.operationEpoch,
        sessionEpoch: value.sessionEpoch,
        stageRevision: value.stageRevision,
        outcome,
      }
    : null;
}

/** Parse a host query for the actual renderer state of one delivered stage. */
export function parseFeedbackDeliveryStatusQuery(
  value: unknown
): FeedbackDeliveryStatusQuery | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'type',
      'protocolVersion',
      'messageId',
      'operationEpoch',
      'sessionEpoch',
      'stageRevision',
    ]) ||
    value.type !== 'feedback.delivery.status.query' ||
    value.protocolVersion !== FEEDBACK_DELIVERY_PROTOCOL_VERSION ||
    !hasDeliveryIdentity(value) ||
    value.stageRevision !== 1
  ) {
    return null;
  }

  return {
    type: 'feedback.delivery.status.query',
    protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
    messageId: value.messageId as string,
    operationEpoch: value.operationEpoch as string,
    sessionEpoch: value.sessionEpoch as string,
    stageRevision: value.stageRevision as number,
  };
}

function parseApplicationStatus(value: unknown): FeedbackDeliveryApplicationStatus | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'applied') {
    if (
      !hasExactKeys(value, ['kind', 'value']) ||
      !isRecord(value.value) ||
      !hasExactKeys(value.value, ['messageType']) ||
      value.value.messageType !== 'feedback.started'
    ) {
      return null;
    }
    return { kind: 'applied', value: { messageType: 'feedback.started' } };
  }
  if ((value.kind === 'inactive' || value.kind === 'mismatch') && hasExactKeys(value, ['kind'])) {
    return { kind: value.kind };
  }
  return null;
}

/** Parse a renderer status response before correlating it with a pending query. */
export function parseFeedbackDeliveryStatusResponse(
  value: unknown
): FeedbackDeliveryStatusResponse | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'type',
      'protocolVersion',
      'messageId',
      'operationEpoch',
      'sessionEpoch',
      'stageRevision',
      'status',
    ]) ||
    value.type !== 'feedback.delivery.status.response' ||
    value.protocolVersion !== FEEDBACK_DELIVERY_PROTOCOL_VERSION ||
    !hasDeliveryIdentity(value) ||
    value.stageRevision !== 1
  ) {
    return null;
  }

  const status = parseApplicationStatus(value.status);
  return status
    ? {
        type: 'feedback.delivery.status.response',
        protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        messageId: value.messageId as string,
        operationEpoch: value.operationEpoch as string,
        sessionEpoch: value.sessionEpoch as string,
        stageRevision: value.stageRevision as number,
        status,
      }
    : null;
}
