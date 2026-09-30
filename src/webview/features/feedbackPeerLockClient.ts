/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Idempotent, renderer-generation-bound Feedback peer lock
 * acquisition. Exact retries only re-ACK and can never replace a newer lock.
 */

import type { FeedbackHostMessage, FeedbackWebviewMessage } from '../../shared/feedbackProtocol';

type FeedbackPeerLockAcquisition = Extract<
  FeedbackHostMessage,
  { type: 'feedback.peer.lock.acquire' }
>;
type FeedbackPeerLockAcknowledgement = Extract<
  FeedbackWebviewMessage,
  { type: 'feedback.peer.lock.acquired' }
>;

interface AppliedPeerLockIdentity {
  readonly requestId: string;
  readonly lockId: string;
  readonly replacesLockId: string | null;
  readonly viewGeneration: string;
  readonly revision: number;
}

export type FeedbackPeerLockDisposition = 'applied' | 'replayed' | 'stale' | 'failed' | 'conflict';

export interface FeedbackPeerLockClient {
  handle(message: FeedbackPeerLockAcquisition): FeedbackPeerLockDisposition;
}

export interface FeedbackPeerLockClientOptions {
  readonly viewGeneration: string;
  readonly hasReviewSession: () => boolean;
  readonly isRetiredLock: (lockId: string) => boolean;
  readonly getLockId: () => string | null;
  readonly lock: (lockId: string, message: string) => void;
  readonly postMessage: (message: FeedbackPeerLockAcknowledgement) => void;
  readonly maxRetainedAcquisitions?: number;
}

function sameIdentity(
  retained: AppliedPeerLockIdentity,
  message: FeedbackPeerLockAcquisition
): boolean {
  return (
    retained.requestId === message.requestId &&
    retained.lockId === message.lockId &&
    retained.replacesLockId === message.replacesLockId &&
    retained.viewGeneration === message.viewGeneration &&
    retained.revision === message.revision
  );
}

function acknowledgement(message: FeedbackPeerLockAcquisition): FeedbackPeerLockAcknowledgement {
  return {
    type: 'feedback.peer.lock.acquired',
    acquisitionId: message.acquisitionId,
    requestId: message.requestId,
    lockId: message.lockId,
    replacesLockId: message.replacesLockId,
    viewGeneration: message.viewGeneration,
    revision: message.revision,
  };
}

/** Create one acquisition replay cache for a single renderer lifetime. */
export function createFeedbackPeerLockClient(
  options: FeedbackPeerLockClientOptions
): FeedbackPeerLockClient {
  const maximum = options.maxRetainedAcquisitions ?? 128;
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new RangeError('maxRetainedAcquisitions must be a positive integer');
  }
  const applied = new Map<string, AppliedPeerLockIdentity>();

  const retain = (message: FeedbackPeerLockAcquisition): void => {
    applied.delete(message.acquisitionId);
    applied.set(message.acquisitionId, {
      requestId: message.requestId,
      lockId: message.lockId,
      replacesLockId: message.replacesLockId,
      viewGeneration: message.viewGeneration,
      revision: message.revision,
    });
    while (applied.size > maximum) {
      const oldest = applied.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      applied.delete(oldest);
    }
  };

  return {
    handle(message) {
      if (
        message.viewGeneration !== options.viewGeneration ||
        options.isRetiredLock(message.lockId)
      ) {
        return 'stale';
      }

      const retained = applied.get(message.acquisitionId);
      if (retained) {
        if (!sameIdentity(retained, message)) return 'conflict';
        applied.delete(message.acquisitionId);
        applied.set(message.acquisitionId, retained);
        options.postMessage(acknowledgement(message));
        return 'replayed';
      }
      if (options.hasReviewSession()) return 'stale';

      const currentLockId = options.getLockId();
      if (currentLockId !== message.lockId) {
        if (currentLockId !== message.replacesLockId) return 'stale';
        options.lock(message.lockId, message.message);
        if (options.getLockId() !== message.lockId) return 'failed';
      }

      retain(message);
      options.postMessage(acknowledgement(message));
      return 'applied';
    },
  };
}
