import type { FeedbackHostMessage } from '../../shared/feedbackProtocol';
import { createFeedbackSessionTransferClient } from '../../webview/features/feedbackSessionTransferClient';

type SessionTransferMessage = Extract<FeedbackHostMessage, { type: 'feedback.session.transfer' }>;

const session = {
  sessionId: 'session-new',
  source: 'docs/guide.md',
  sourceSha256: 'a'.repeat(64),
  round: '20260821T093000Z-k4p9',
  feedbackFile: '.md4h/feedback/docs/guide/feedback.md',
  anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
  items: [],
};

const incomingApply: SessionTransferMessage = {
  type: 'feedback.session.transfer',
  phase: 'apply',
  role: 'new-owner',
  transferId: 'transfer-1',
  requestId: 'resume-1',
  oldSessionId: 'session-old',
  newSessionId: 'session-new',
  viewGeneration: 'view-new',
  revision: 1,
  documentVersion: 7,
  sourceSha256: 'a'.repeat(64),
  peerLockMessage: 'Feedback is active in another editor split.',
  session,
};

const incomingCommit: SessionTransferMessage = {
  type: 'feedback.session.transfer',
  phase: 'commit',
  role: 'new-owner',
  transferId: incomingApply.transferId,
  requestId: incomingApply.requestId,
  oldSessionId: incomingApply.oldSessionId,
  newSessionId: incomingApply.newSessionId,
  viewGeneration: incomingApply.viewGeneration,
  revision: incomingApply.revision,
  documentVersion: incomingApply.documentVersion,
  sourceSha256: incomingApply.sourceSha256,
  peerLockMessage: incomingApply.peerLockMessage,
};

describe('Feedback session transfer client', () => {
  it('stages the new owner under its old peer lock and unlocks only after commit', () => {
    const order: string[] = [];
    let sessionId: string | null = null;
    let peerLockId: string | null = 'session-old';
    const prepareIncoming = jest.fn(() => {
      order.push('prepare-incoming');
      sessionId = 'session-new';
      return true;
    });
    const commitIncoming = jest.fn(() => {
      order.push('commit-incoming');
      return true;
    });
    const postMessage = jest.fn(message => order.push(`ack:${message.phase}`));
    const client = createFeedbackSessionTransferClient({
      viewGeneration: 'view-new',
      getSessionId: () => sessionId,
      getPeerLockId: () => peerLockId,
      prepareIncoming,
      prepareOutgoing: () => false,
      prepareSameOwner: () => false,
      commitIncoming,
      commitOutgoing: () => false,
      commitSameOwner: () => false,
      lockPeer: jest.fn(),
      unlockPeer: lockId => {
        order.push(`unlock:${lockId}`);
        if (peerLockId === lockId) peerLockId = null;
      },
      postMessage,
    });

    expect(client.handle(incomingApply)).toBe('applied');
    expect(sessionId).toBe('session-new');
    expect(peerLockId).toBe('session-old');
    expect(order).toEqual(['prepare-incoming', 'ack:apply']);

    expect(client.handle(incomingCommit)).toBe('committed');
    expect(peerLockId).toBeNull();
    expect(order).toEqual([
      'prepare-incoming',
      'ack:apply',
      'commit-incoming',
      'unlock:session-old',
      'ack:commit',
    ]);
  });

  it('freezes the old owner during apply and atomically retires it into the new peer lock', () => {
    const order: string[] = [];
    let sessionId: string | null = 'session-old';
    let peerLockId: string | null = null;
    const outgoingApply: SessionTransferMessage = {
      ...incomingApply,
      role: 'old-owner',
      viewGeneration: 'view-old',
    };
    const outgoingCommit: SessionTransferMessage = {
      ...incomingCommit,
      role: 'old-owner',
      viewGeneration: 'view-old',
    };
    const client = createFeedbackSessionTransferClient({
      viewGeneration: 'view-old',
      getSessionId: () => sessionId,
      getPeerLockId: () => peerLockId,
      prepareIncoming: () => false,
      prepareOutgoing: () => {
        order.push('freeze-outgoing');
        return true;
      },
      prepareSameOwner: () => false,
      commitIncoming: () => false,
      commitOutgoing: () => {
        order.push('retire-outgoing');
        sessionId = null;
        return true;
      },
      commitSameOwner: () => false,
      lockPeer: (lockId, message) => {
        order.push(`lock:${lockId}:${message}`);
        peerLockId = lockId;
      },
      unlockPeer: jest.fn(),
      postMessage: message => order.push(`ack:${message.phase}`),
    });

    expect(client.handle(outgoingApply)).toBe('applied');
    expect(sessionId).toBe('session-old');
    expect(peerLockId).toBeNull();
    expect(order).toEqual(['freeze-outgoing', 'ack:apply']);

    expect(client.handle(outgoingCommit)).toBe('committed');
    expect(sessionId).toBeNull();
    expect(peerLockId).toBe('session-new');
    expect(order).toEqual([
      'freeze-outgoing',
      'ack:apply',
      'retire-outgoing',
      `lock:session-new:${incomingApply.peerLockMessage}`,
      'ack:commit',
    ]);
  });

  it('re-ACKs exact retries without restaging, retiring, or unlocking twice', () => {
    let sessionId: string | null = null;
    let peerLockId: string | null = 'session-old';
    const prepareIncoming = jest.fn(() => {
      sessionId = 'session-new';
      return true;
    });
    const commitIncoming = jest.fn(() => true);
    const unlockPeer = jest.fn(() => {
      peerLockId = null;
    });
    const postMessage = jest.fn();
    const client = createFeedbackSessionTransferClient({
      viewGeneration: 'view-new',
      getSessionId: () => sessionId,
      getPeerLockId: () => peerLockId,
      prepareIncoming,
      prepareOutgoing: () => false,
      prepareSameOwner: () => false,
      commitIncoming,
      commitOutgoing: () => false,
      commitSameOwner: () => false,
      lockPeer: jest.fn(),
      unlockPeer,
      postMessage,
    });

    expect(client.handle(incomingApply)).toBe('applied');
    expect(client.handle(incomingApply)).toBe('replayed');
    expect(client.handle(incomingCommit)).toBe('committed');
    expect(client.handle(incomingCommit)).toBe('replayed');

    expect(prepareIncoming).toHaveBeenCalledTimes(1);
    expect(commitIncoming).toHaveBeenCalledTimes(1);
    expect(unlockPeer).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(4);
  });

  it('rolls back a staged incoming owner exactly once without removing its old peer lock', () => {
    let sessionId: string | null = null;
    let peerLockId: string | null = 'session-old';
    const prepareIncoming = jest.fn(() => {
      sessionId = 'session-new';
      return true;
    });
    const abortIncoming = jest.fn(() => {
      sessionId = null;
      return true;
    });
    const unlockPeer = jest.fn(() => {
      peerLockId = null;
    });
    const postMessage = jest.fn();
    const client = createFeedbackSessionTransferClient({
      viewGeneration: 'view-new',
      getSessionId: () => sessionId,
      getPeerLockId: () => peerLockId,
      prepareIncoming,
      prepareOutgoing: () => false,
      prepareSameOwner: () => false,
      commitIncoming: () => false,
      commitOutgoing: () => false,
      commitSameOwner: () => false,
      abortIncoming,
      abortOutgoing: () => false,
      abortSameOwner: () => false,
      lockPeer: jest.fn(),
      unlockPeer,
      postMessage,
    });
    const abort = { ...incomingCommit, phase: 'abort' as const };

    expect(client.handle(incomingApply)).toBe('applied');
    expect(client.handle(abort)).toBe('aborted');
    expect(client.handle(abort)).toBe('replayed');
    expect(client.handle(incomingCommit)).toBe('stale');

    expect(abortIncoming).toHaveBeenCalledTimes(1);
    expect(sessionId).toBeNull();
    expect(peerLockId).toBe('session-old');
    expect(unlockPeer).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(3);
  });

  it('rejects stale generations, stale sessions, apply failures, and commit before apply', () => {
    const postMessage = jest.fn();
    const prepareIncoming = jest.fn(() => true);
    const createClient = (peerLockId: string | null) =>
      createFeedbackSessionTransferClient({
        viewGeneration: 'view-new',
        getSessionId: () => null,
        getPeerLockId: () => peerLockId,
        prepareIncoming,
        prepareOutgoing: () => false,
        prepareSameOwner: () => false,
        commitIncoming: () => true,
        commitOutgoing: () => false,
        commitSameOwner: () => false,
        lockPeer: jest.fn(),
        unlockPeer: jest.fn(),
        postMessage,
      });

    expect(createClient('session-old').handle({ ...incomingApply, viewGeneration: 'stale' })).toBe(
      'stale'
    );
    expect(createClient('different-lock').handle(incomingApply)).toBe('stale');
    expect(createClient('session-old').handle(incomingCommit)).toBe('stale');

    const failed = createFeedbackSessionTransferClient({
      viewGeneration: 'view-new',
      getSessionId: () => null,
      getPeerLockId: () => 'session-old',
      prepareIncoming: () => false,
      prepareOutgoing: () => false,
      prepareSameOwner: () => false,
      commitIncoming: () => false,
      commitOutgoing: () => false,
      commitSameOwner: () => false,
      lockPeer: jest.fn(),
      unlockPeer: jest.fn(),
      postMessage,
    });
    expect(failed.handle(incomingApply)).toBe('failed');
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('rejects conflicting transfer reuse and evicted stale revisions', () => {
    let sessionId: string | null = null;
    const prepareIncoming = jest.fn(() => {
      sessionId = 'session-new';
      return true;
    });
    const client = createFeedbackSessionTransferClient({
      viewGeneration: 'view-new',
      getSessionId: () => sessionId,
      getPeerLockId: () => 'session-old',
      prepareIncoming,
      prepareOutgoing: () => false,
      prepareSameOwner: () => false,
      commitIncoming: () => true,
      commitOutgoing: () => false,
      commitSameOwner: () => false,
      lockPeer: jest.fn(),
      unlockPeer: jest.fn(),
      postMessage: jest.fn(),
      maxRetainedTransfers: 1,
    });

    expect(client.handle(incomingApply)).toBe('applied');
    expect(
      client.handle({
        ...incomingApply,
        sourceSha256: 'b'.repeat(64),
        session: { ...session, sourceSha256: 'b'.repeat(64) },
      })
    ).toBe('conflict');

    sessionId = null;
    const newer = {
      ...incomingApply,
      transferId: 'transfer-2',
      revision: 2,
    };
    expect(client.handle(newer)).toBe('applied');
    expect(client.handle(incomingApply)).toBe('stale');
    expect(prepareIncoming).toHaveBeenCalledTimes(2);
  });
});
