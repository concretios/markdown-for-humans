/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Idempotent renderer half of a generation-bound Feedback
 * ownership handoff. Apply stages stay frozen. Commit changes ownership and
 * acknowledges only after the old peer guard is replaced atomically.
 */

import type { FeedbackHostMessage, FeedbackWebviewMessage } from '../../shared/feedbackProtocol';

type FeedbackSessionTransferMessage = Extract<
  FeedbackHostMessage,
  { type: 'feedback.session.transfer' }
>;
type FeedbackSessionTransferApply = Extract<FeedbackSessionTransferMessage, { phase: 'apply' }>;
type FeedbackSessionTransferCommit = Extract<FeedbackSessionTransferMessage, { phase: 'commit' }>;
type FeedbackSessionTransferAbort = Extract<FeedbackSessionTransferMessage, { phase: 'abort' }>;
type FeedbackSessionTransferAcknowledgement = Extract<
  FeedbackWebviewMessage,
  { type: 'feedback.session.transfer.ack' }
>;

interface AppliedSessionTransferIdentity {
  readonly role: FeedbackSessionTransferMessage['role'];
  readonly requestId: string;
  readonly oldSessionId: string;
  readonly newSessionId: string;
  readonly viewGeneration: string;
  readonly revision: number;
  readonly documentVersion: number;
  readonly sourceSha256: string;
  readonly peerLockMessage: string;
  readonly sessionJson: string;
  committed: boolean;
  aborted: boolean;
}

export type FeedbackSessionTransferDisposition =
  'applied' | 'committed' | 'aborted' | 'replayed' | 'stale' | 'failed' | 'conflict';

export interface FeedbackSessionTransferClient {
  handle(message: FeedbackSessionTransferMessage): FeedbackSessionTransferDisposition;
}

export interface FeedbackSessionTransferClientOptions {
  readonly viewGeneration: string;
  readonly getSessionId: () => string | null;
  readonly getPeerLockId: () => string | null;
  readonly prepareIncoming: (message: FeedbackSessionTransferApply) => boolean;
  readonly prepareOutgoing: (message: FeedbackSessionTransferApply) => boolean;
  readonly prepareSameOwner: (message: FeedbackSessionTransferApply) => boolean;
  readonly commitIncoming: (message: FeedbackSessionTransferCommit) => boolean;
  readonly commitOutgoing: (message: FeedbackSessionTransferCommit) => boolean;
  readonly commitSameOwner: (message: FeedbackSessionTransferCommit) => boolean;
  readonly abortIncoming?: (message: FeedbackSessionTransferAbort) => boolean;
  readonly abortOutgoing?: (message: FeedbackSessionTransferAbort) => boolean;
  readonly abortSameOwner?: (message: FeedbackSessionTransferAbort) => boolean;
  readonly lockPeer: (lockId: string, message: string) => void;
  readonly unlockPeer: (lockId: string) => void;
  readonly postMessage: (message: FeedbackSessionTransferAcknowledgement) => void;
  readonly maxRetainedTransfers?: number;
}

function sameIdentity(
  retained: AppliedSessionTransferIdentity,
  message: FeedbackSessionTransferMessage
): boolean {
  return (
    retained.role === message.role &&
    retained.requestId === message.requestId &&
    retained.oldSessionId === message.oldSessionId &&
    retained.newSessionId === message.newSessionId &&
    retained.viewGeneration === message.viewGeneration &&
    retained.revision === message.revision &&
    retained.documentVersion === message.documentVersion &&
    retained.sourceSha256 === message.sourceSha256 &&
    retained.peerLockMessage === message.peerLockMessage &&
    (message.phase !== 'apply' || retained.sessionJson === JSON.stringify(message.session))
  );
}

function acknowledgement(
  message: FeedbackSessionTransferMessage
): FeedbackSessionTransferAcknowledgement {
  return {
    type: 'feedback.session.transfer.ack',
    phase: message.phase,
    role: message.role,
    transferId: message.transferId,
    requestId: message.requestId,
    oldSessionId: message.oldSessionId,
    newSessionId: message.newSessionId,
    viewGeneration: message.viewGeneration,
    revision: message.revision,
    documentVersion: message.documentVersion,
    sourceSha256: message.sourceSha256,
    applied: true,
  };
}

/** Create one transfer replay cache for a single renderer lifetime. */
export function createFeedbackSessionTransferClient(
  options: FeedbackSessionTransferClientOptions
): FeedbackSessionTransferClient {
  const maximum = options.maxRetainedTransfers ?? 128;
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new RangeError('maxRetainedTransfers must be a positive integer');
  }
  const applied = new Map<string, AppliedSessionTransferIdentity>();
  const latestApplied = new Map<
    string,
    { readonly transferId: string; readonly revision: number }
  >();

  const lineageKey = (message: FeedbackSessionTransferMessage): string =>
    `${message.viewGeneration}\u0000${message.oldSessionId}\u0000${message.role}`;

  const retain = (message: FeedbackSessionTransferApply): void => {
    applied.delete(message.transferId);
    applied.set(message.transferId, {
      role: message.role,
      requestId: message.requestId,
      oldSessionId: message.oldSessionId,
      newSessionId: message.newSessionId,
      viewGeneration: message.viewGeneration,
      revision: message.revision,
      documentVersion: message.documentVersion,
      sourceSha256: message.sourceSha256,
      peerLockMessage: message.peerLockMessage,
      sessionJson: JSON.stringify(message.session),
      committed: false,
      aborted: false,
    });
    while (applied.size > maximum) {
      const oldest = applied.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      applied.delete(oldest);
    }
    const key = lineageKey(message);
    latestApplied.delete(key);
    latestApplied.set(key, { transferId: message.transferId, revision: message.revision });
    while (latestApplied.size > maximum) {
      const oldest = latestApplied.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      latestApplied.delete(oldest);
    }
  };

  return {
    handle(message) {
      if (message.viewGeneration !== options.viewGeneration) return 'stale';
      const retained = applied.get(message.transferId);
      if (retained) {
        if (!sameIdentity(retained, message)) return 'conflict';
        applied.delete(message.transferId);
        applied.set(message.transferId, retained);
        if (message.phase === 'apply') {
          if (retained.committed || retained.aborted) return 'stale';
          options.postMessage(acknowledgement(message));
          return 'replayed';
        }
        if (
          (message.phase === 'commit' && retained.committed) ||
          (message.phase === 'abort' && retained.aborted)
        ) {
          options.postMessage(acknowledgement(message));
          return 'replayed';
        }
        if (retained.committed || retained.aborted) return 'stale';

        if (message.phase === 'abort') {
          let aborted = false;
          try {
            if (message.role === 'new-owner') {
              aborted = options.abortIncoming?.(message) ?? false;
              aborted =
                aborted &&
                options.getSessionId() === null &&
                options.getPeerLockId() === message.oldSessionId;
            } else if (message.role === 'old-owner') {
              aborted = options.abortOutgoing?.(message) ?? false;
              aborted = aborted && options.getSessionId() === message.oldSessionId;
            } else {
              aborted = options.abortSameOwner?.(message) ?? false;
              if (aborted && options.getPeerLockId() === message.oldSessionId) {
                options.unlockPeer(message.oldSessionId);
              }
              aborted =
                aborted &&
                options.getSessionId() === message.oldSessionId &&
                options.getPeerLockId() !== message.oldSessionId;
            }
          } catch {
            return 'failed';
          }
          if (!aborted) return 'failed';
          retained.aborted = true;
          options.postMessage(acknowledgement(message));
          return 'aborted';
        }

        let committed = false;
        try {
          if (message.role === 'new-owner') {
            committed = options.commitIncoming(message);
            if (committed && options.getPeerLockId() === message.oldSessionId) {
              options.unlockPeer(message.oldSessionId);
            }
            committed =
              committed &&
              options.getSessionId() === message.newSessionId &&
              options.getPeerLockId() !== message.oldSessionId;
          } else if (message.role === 'old-owner') {
            committed = options.commitOutgoing(message);
            if (committed) options.lockPeer(message.newSessionId, message.peerLockMessage);
            committed =
              committed &&
              options.getSessionId() === null &&
              options.getPeerLockId() === message.newSessionId;
          } else {
            committed = options.commitSameOwner(message);
            if (committed && options.getPeerLockId() === message.oldSessionId) {
              options.unlockPeer(message.oldSessionId);
            }
            committed =
              committed &&
              options.getSessionId() === message.newSessionId &&
              options.getPeerLockId() !== message.oldSessionId;
          }
        } catch {
          return 'failed';
        }
        if (!committed) return 'failed';
        retained.committed = true;
        options.postMessage(acknowledgement(message));
        return 'committed';
      }

      if (message.phase !== 'apply') return 'stale';
      const latest = latestApplied.get(lineageKey(message));
      if (latest) {
        if (message.revision < latest.revision) return 'stale';
        if (message.revision === latest.revision && message.transferId !== latest.transferId) {
          return 'conflict';
        }
      }

      let prepared = false;
      try {
        if (message.role === 'new-owner') {
          if (options.getSessionId() !== null || options.getPeerLockId() !== message.oldSessionId) {
            return 'stale';
          }
          prepared = options.prepareIncoming(message);
        } else if (message.role === 'old-owner') {
          if (options.getSessionId() !== message.oldSessionId) return 'stale';
          prepared = options.prepareOutgoing(message);
        } else {
          const sessionMatches = options.getSessionId() === message.oldSessionId;
          const recreatedOwnerMatches =
            options.getSessionId() === null && options.getPeerLockId() === message.oldSessionId;
          if (!sessionMatches && !recreatedOwnerMatches) return 'stale';
          prepared = options.prepareSameOwner(message);
        }
      } catch {
        return 'failed';
      }
      if (!prepared) return 'failed';

      retain(message);
      options.postMessage(acknowledgement(message));
      return 'applied';
    },
  };
}
