import type { FeedbackHostMessage } from '../../shared/feedbackProtocol';
import { createFeedbackPeerReleaseClient } from '../../webview/features/feedbackPeerReleaseClient';

type PeerReleaseMessage = Extract<FeedbackHostMessage, { type: 'feedback.peer.release' }>;

const release: PeerReleaseMessage = {
  type: 'feedback.peer.release',
  phase: 'apply',
  releaseId: 'peer-release-1',
  requestId: 'finish-1',
  lockId: 'session-1',
  viewGeneration: 'view-current',
  revision: 1,
  documentVersion: 7,
  contentSha256: 'a'.repeat(64),
  content: '# Authoritative\n',
};
const commit: PeerReleaseMessage = {
  type: 'feedback.peer.release',
  phase: 'commit',
  releaseId: release.releaseId,
  requestId: release.requestId,
  lockId: release.lockId,
  viewGeneration: release.viewGeneration,
  revision: release.revision,
  documentVersion: release.documentVersion,
  contentSha256: release.contentSha256,
};

describe('Feedback peer release client', () => {
  it('applies under lock, then unlocks only after the correlated commit', () => {
    const order: string[] = [];
    let lockId: string | null = 'session-1';
    const postMessage = jest.fn(message => order.push(`ack:${message.phase}`));
    const client = createFeedbackPeerReleaseClient({
      viewGeneration: 'view-current',
      getPeerLockId: () => lockId,
      hasReviewReleaseLock: () => false,
      applyPeerContent: content => {
        order.push(`apply:${content}`);
        return true;
      },
      applyReviewRelease: () => false,
      completeReviewRelease: () => false,
      unlockPeer: () => {
        order.push('unlock');
        lockId = null;
      },
      postMessage,
    });

    expect(client.handle(release)).toBe('applied');
    expect(lockId).toBe('session-1');
    expect(order).toEqual(['apply:# Authoritative\n', 'ack:apply']);

    expect(client.handle(commit)).toBe('committed');
    expect(lockId).toBeNull();
    expect(order).toEqual(['apply:# Authoritative\n', 'ack:apply', 'unlock', 'ack:commit']);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'feedback.peer.released',
      phase: 'commit',
      releaseId: release.releaseId,
      requestId: release.requestId,
      lockId: release.lockId,
      viewGeneration: release.viewGeneration,
      revision: release.revision,
      documentVersion: release.documentVersion,
      contentSha256: release.contentSha256,
    });
  });

  it.each(['close', 'transition'] as const)(
    'completes a matching %s review lock only during commit',
    lifecycle => {
      const order: string[] = [];
      let reviewLocked = true;
      const client = createFeedbackPeerReleaseClient({
        viewGeneration: 'view-current',
        getPeerLockId: () => null,
        hasReviewReleaseLock: lockId => reviewLocked && lockId === `${lifecycle}-lock`,
        applyPeerContent: () => false,
        applyReviewRelease: (_lockId, content) => {
          order.push(`apply:${content}`);
          return true;
        },
        completeReviewRelease: () => {
          order.push(`complete:${lifecycle}`);
          reviewLocked = false;
          return true;
        },
        unlockPeer: () => order.push('peer-unlock'),
        postMessage: message => order.push(`ack:${message.phase}`),
      });
      const applyMessage = {
        ...release,
        releaseId: `${lifecycle}-release`,
        lockId: `${lifecycle}-lock`,
      };

      expect(client.handle(applyMessage)).toBe('applied');
      expect(reviewLocked).toBe(true);
      expect(order).toEqual(['apply:# Authoritative\n', 'ack:apply']);
      expect(
        client.handle({
          ...commit,
          releaseId: applyMessage.releaseId,
          lockId: applyMessage.lockId,
        })
      ).toBe('committed');
      expect(order).toEqual([
        'apply:# Authoritative\n',
        'ack:apply',
        `complete:${lifecycle}`,
        'ack:commit',
      ]);
    }
  );

  it('re-ACKs exact apply and commit retries without reapplying or re-unlocking', () => {
    let lockId: string | null = 'session-1';
    const applyPeerContent = jest.fn(() => true);
    const unlockPeer = jest.fn(() => {
      lockId = null;
    });
    const postMessage = jest.fn();
    const client = createFeedbackPeerReleaseClient({
      viewGeneration: 'view-current',
      getPeerLockId: () => lockId,
      hasReviewReleaseLock: () => false,
      applyPeerContent,
      applyReviewRelease: () => false,
      completeReviewRelease: () => false,
      unlockPeer,
      postMessage,
    });

    expect(client.handle(release)).toBe('applied');
    expect(client.handle(release)).toBe('replayed');
    expect(client.handle(commit)).toBe('committed');
    expect(client.handle(commit)).toBe('replayed');

    expect(applyPeerContent).toHaveBeenCalledTimes(1);
    expect(unlockPeer).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(4);
  });

  it('rejects stale locks, apply failures, and commits without a completed apply', () => {
    const unlockPeer = jest.fn();
    const postMessage = jest.fn();
    const staleClient = createFeedbackPeerReleaseClient({
      viewGeneration: 'view-current',
      getPeerLockId: () => 'newer-lock',
      hasReviewReleaseLock: () => false,
      applyPeerContent: jest.fn(() => true),
      applyReviewRelease: jest.fn(() => true),
      completeReviewRelease: jest.fn(() => true),
      unlockPeer,
      postMessage,
    });

    expect(staleClient.handle(release)).toBe('stale');
    expect(staleClient.handle({ ...release, viewGeneration: 'view-stale' })).toBe('stale');
    expect(staleClient.handle(commit)).toBe('stale');

    const failedClient = createFeedbackPeerReleaseClient({
      viewGeneration: 'view-current',
      getPeerLockId: () => 'session-1',
      hasReviewReleaseLock: () => false,
      applyPeerContent: jest.fn(() => false),
      applyReviewRelease: jest.fn(() => false),
      completeReviewRelease: jest.fn(() => false),
      unlockPeer,
      postMessage,
    });
    expect(failedClient.handle(release)).toBe('failed');
    expect(failedClient.handle(commit)).toBe('stale');
    expect(unlockPeer).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('rejects conflicting reuse of an applied release ID without reapplying', () => {
    const applyPeerContent = jest.fn(() => true);
    const postMessage = jest.fn();
    const client = createFeedbackPeerReleaseClient({
      viewGeneration: 'view-current',
      getPeerLockId: () => 'session-1',
      hasReviewReleaseLock: () => false,
      applyPeerContent,
      applyReviewRelease: () => false,
      completeReviewRelease: () => false,
      unlockPeer: jest.fn(),
      postMessage,
    });

    expect(client.handle(release)).toBe('applied');
    expect(
      client.handle({ ...release, contentSha256: 'b'.repeat(64), content: '# Different\n' })
    ).toBe('conflict');
    expect(applyPeerContent).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects an evicted older apply identity after a newer revision was applied', () => {
    const applyPeerContent = jest.fn(() => true);
    const client = createFeedbackPeerReleaseClient({
      viewGeneration: 'view-current',
      getPeerLockId: () => 'session-1',
      hasReviewReleaseLock: () => false,
      applyPeerContent,
      applyReviewRelease: () => false,
      completeReviewRelease: () => false,
      unlockPeer: jest.fn(),
      postMessage: jest.fn(),
      maxRetainedReleases: 1,
    });
    const newer = {
      ...release,
      releaseId: 'peer-release-2',
      revision: 2,
      documentVersion: 8,
      contentSha256: 'b'.repeat(64),
      content: '# Newer authoritative source\n',
    };

    expect(client.handle(release)).toBe('applied');
    expect(client.handle(newer)).toBe('applied');
    expect(client.handle(release)).toBe('stale');
    expect(applyPeerContent).toHaveBeenCalledTimes(2);
  });
});
