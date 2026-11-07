import { createFeedbackPeerLockClient } from '../../webview/features/feedbackPeerLockClient';

const acquisition = {
  type: 'feedback.peer.lock.acquire' as const,
  acquisitionId: 'acquire-1',
  requestId: 'start-1',
  lockId: 'transition-1',
  replacesLockId: null,
  viewGeneration: 'view-current',
  revision: 1,
  message: 'Feedback is active in another editor split.',
};

describe('Feedback peer lock acquisition client', () => {
  it('locks the current renderer generation before acknowledging', () => {
    const order: string[] = [];
    let lockId: string | null = null;
    const postMessage = jest.fn(() => order.push('ack'));
    const client = createFeedbackPeerLockClient({
      viewGeneration: 'view-current',
      hasReviewSession: () => false,
      isRetiredLock: () => false,
      getLockId: () => lockId,
      lock: nextLockId => {
        order.push('lock');
        lockId = nextLockId;
      },
      postMessage,
    });

    expect(client.handle(acquisition)).toBe('applied');
    expect(order).toEqual(['lock', 'ack']);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'feedback.peer.lock.acquired',
      acquisitionId: acquisition.acquisitionId,
      requestId: acquisition.requestId,
      lockId: acquisition.lockId,
      replacesLockId: acquisition.replacesLockId,
      viewGeneration: acquisition.viewGeneration,
      revision: acquisition.revision,
    });
  });

  it('re-ACKs an exact retry without replacing a newer lock', () => {
    let lockId: string | null = null;
    const lock = jest.fn((nextLockId: string) => {
      lockId = nextLockId;
    });
    const postMessage = jest.fn();
    const client = createFeedbackPeerLockClient({
      viewGeneration: 'view-current',
      hasReviewSession: () => false,
      isRetiredLock: () => false,
      getLockId: () => lockId,
      lock,
      postMessage,
    });

    expect(client.handle(acquisition)).toBe('applied');
    lockId = 'newer-session-lock';
    expect(client.handle(acquisition)).toBe('replayed');
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lockId).toBe('newer-session-lock');
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('rejects stale generations, review owners, failed locks, and conflicting identities', () => {
    let lockId: string | null = null;
    let hasReviewSession = false;
    const lock = jest.fn((nextLockId: string) => {
      lockId = nextLockId;
    });
    const postMessage = jest.fn();
    const client = createFeedbackPeerLockClient({
      viewGeneration: 'view-current',
      hasReviewSession: () => hasReviewSession,
      isRetiredLock: lockId => lockId === 'retired-lock',
      getLockId: () => lockId,
      lock,
      postMessage,
    });

    expect(client.handle({ ...acquisition, viewGeneration: 'view-stale' })).toBe('stale');
    expect(client.handle({ ...acquisition, lockId: 'retired-lock' })).toBe('stale');
    hasReviewSession = true;
    expect(client.handle(acquisition)).toBe('stale');
    hasReviewSession = false;
    lock.mockImplementationOnce(() => undefined);
    expect(client.handle(acquisition)).toBe('failed');
    expect(postMessage).not.toHaveBeenCalled();

    expect(client.handle(acquisition)).toBe('applied');
    expect(client.handle({ ...acquisition, lockId: 'conflicting-lock' })).toBe('conflict');
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('replaces only the exact predecessor lock', () => {
    let lockId: string | null = 'transition-1';
    const lock = jest.fn((nextLockId: string) => {
      lockId = nextLockId;
    });
    const postMessage = jest.fn();
    const client = createFeedbackPeerLockClient({
      viewGeneration: 'view-current',
      hasReviewSession: () => false,
      isRetiredLock: () => false,
      getLockId: () => lockId,
      lock,
      postMessage,
    });
    const replacement = {
      ...acquisition,
      acquisitionId: 'acquire-session',
      lockId: 'session-1',
      replacesLockId: 'transition-1',
    };

    expect(client.handle({ ...replacement, replacesLockId: 'other-lock' })).toBe('stale');
    expect(client.handle(replacement)).toBe('applied');
    expect(lockId).toBe('session-1');
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
