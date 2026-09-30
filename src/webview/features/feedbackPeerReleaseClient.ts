/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Idempotent renderer application for host-authoritative
 * Feedback split releases. Applied identities are retained without Markdown so
 * a lost acknowledgement can be replayed without overwriting later user edits.
 */

import type { FeedbackHostMessage, FeedbackWebviewMessage } from '../../shared/feedbackProtocol';

type FeedbackPeerReleaseMessage = Extract<FeedbackHostMessage, { type: 'feedback.peer.release' }>;
type FeedbackPeerReleasedMessage = Extract<
  FeedbackWebviewMessage,
  { type: 'feedback.peer.released' }
>;

interface AppliedPeerReleaseIdentity {
  readonly requestId: string;
  readonly lockId: string;
  readonly viewGeneration: string;
  readonly revision: number;
  readonly documentVersion: number;
  readonly contentSha256: string;
  readonly kind: 'peer' | 'review';
  committed: boolean;
}

export type FeedbackPeerReleaseDisposition =
  'applied' | 'committed' | 'replayed' | 'stale' | 'failed' | 'conflict';

export interface FeedbackPeerReleaseClient {
  handle(message: FeedbackPeerReleaseMessage): FeedbackPeerReleaseDisposition;
}

export interface FeedbackPeerReleaseClientOptions {
  readonly viewGeneration: string;
  readonly getPeerLockId: () => string | null;
  readonly hasReviewReleaseLock: (lockId: string) => boolean;
  /** Apply content while the peer read-only guard remains installed. */
  readonly applyPeerContent: (content: string, documentVersion: number) => boolean;
  /** Apply content while a matching owner close or transition lock remains active. */
  readonly applyReviewRelease: (
    lockId: string,
    content: string,
    documentVersion: number
  ) => boolean;
  /** Complete the matching owner close or transition only during the commit phase. */
  readonly completeReviewRelease: (lockId: string) => boolean;
  readonly unlockPeer: (lockId: string) => void;
  readonly postMessage: (message: FeedbackPeerReleasedMessage) => void;
  readonly maxRetainedReleases?: number;
}

function sameIdentity(
  retained: AppliedPeerReleaseIdentity,
  message: FeedbackPeerReleaseMessage
): boolean {
  return (
    retained.requestId === message.requestId &&
    retained.lockId === message.lockId &&
    retained.viewGeneration === message.viewGeneration &&
    retained.revision === message.revision &&
    retained.documentVersion === message.documentVersion &&
    retained.contentSha256 === message.contentSha256
  );
}

function acknowledgement(message: FeedbackPeerReleaseMessage): FeedbackPeerReleasedMessage {
  return {
    type: 'feedback.peer.released',
    phase: message.phase,
    releaseId: message.releaseId,
    requestId: message.requestId,
    lockId: message.lockId,
    viewGeneration: message.viewGeneration,
    revision: message.revision,
    documentVersion: message.documentVersion,
    contentSha256: message.contentSha256,
  };
}

/** Create one release cache for a single renderer lifetime. */
export function createFeedbackPeerReleaseClient(
  options: FeedbackPeerReleaseClientOptions
): FeedbackPeerReleaseClient {
  const maximum = options.maxRetainedReleases ?? 128;
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new RangeError('maxRetainedReleases must be a positive integer');
  }
  const applied = new Map<string, AppliedPeerReleaseIdentity>();
  const latestAppliedByLock = new Map<
    string,
    { readonly releaseId: string; readonly revision: number }
  >();

  const lockKey = (message: FeedbackPeerReleaseMessage): string =>
    `${message.viewGeneration}\u0000${message.lockId}`;

  const retain = (message: FeedbackPeerReleaseMessage, kind: 'peer' | 'review'): void => {
    applied.delete(message.releaseId);
    applied.set(message.releaseId, {
      requestId: message.requestId,
      lockId: message.lockId,
      viewGeneration: message.viewGeneration,
      revision: message.revision,
      documentVersion: message.documentVersion,
      contentSha256: message.contentSha256,
      kind,
      committed: false,
    });
    while (applied.size > maximum) {
      const oldest = applied.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      applied.delete(oldest);
    }
    const key = lockKey(message);
    latestAppliedByLock.delete(key);
    latestAppliedByLock.set(key, {
      releaseId: message.releaseId,
      revision: message.revision,
    });
    while (latestAppliedByLock.size > maximum) {
      const oldest = latestAppliedByLock.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      latestAppliedByLock.delete(oldest);
    }
  };

  return {
    handle(message) {
      if (message.viewGeneration !== options.viewGeneration) return 'stale';
      const retained = applied.get(message.releaseId);
      if (retained) {
        if (!sameIdentity(retained, message)) return 'conflict';
        // Touch the entry so active retry identities win bounded LRU retention.
        applied.delete(message.releaseId);
        applied.set(message.releaseId, retained);
        if (message.phase === 'apply' || retained.committed) {
          options.postMessage(acknowledgement(message));
          return 'replayed';
        }

        let committed = false;
        try {
          if (retained.kind === 'review') {
            committed = options.completeReviewRelease(message.lockId);
          } else if (options.getPeerLockId() === message.lockId) {
            options.unlockPeer(message.lockId);
            committed = options.getPeerLockId() !== message.lockId;
          }
        } catch {
          return 'failed';
        }
        if (!committed) return 'failed';
        retained.committed = true;
        options.postMessage(acknowledgement(message));
        return 'committed';
      }

      if (message.phase === 'commit') return 'stale';
      const latestForLock = latestAppliedByLock.get(lockKey(message));
      if (latestForLock) {
        if (message.revision < latestForLock.revision) return 'stale';
        if (
          message.revision === latestForLock.revision &&
          message.releaseId !== latestForLock.releaseId
        ) {
          return 'conflict';
        }
      }

      let releaseApplied = false;
      let kind: 'peer' | 'review';
      if (options.hasReviewReleaseLock(message.lockId)) {
        kind = 'review';
        releaseApplied = options.applyReviewRelease(
          message.lockId,
          message.content,
          message.documentVersion
        );
      } else if (options.getPeerLockId() === message.lockId) {
        kind = 'peer';
        releaseApplied = options.applyPeerContent(message.content, message.documentVersion);
      } else {
        return 'stale';
      }
      if (!releaseApplied) return 'failed';

      // Retain before acknowledging. A lost apply ACK can then be replayed
      // without applying over edits, while the peer remains locked until commit.
      retain(message, kind);
      options.postMessage(acknowledgement(message));
      return 'applied';
    },
  };
}
