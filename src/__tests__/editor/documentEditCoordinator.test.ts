import {
  DocumentEditCoordinator,
  type DocumentEditExecutionContext,
} from '../../editor/documentEditCoordinator';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: value => {
      if (!resolvePromise) throw new Error('Deferred promise was not initialized.');
      resolvePromise(value);
    },
  };
}

async function nextMicrotask(): Promise<void> {
  await Promise.resolve();
}

describe('DocumentEditCoordinator', () => {
  it('runs one edit at a time per document while allowing different documents to progress', async () => {
    const coordinator = new DocumentEditCoordinator<string>();
    const firstRelease = deferred<string>();
    const secondRelease = deferred<string>();
    const otherRelease = deferred<string>();
    const started: string[] = [];
    let activeForDocument = 0;
    let maximumActiveForDocument = 0;

    const executeForDocument =
      (label: string, release: Deferred<string>) => async (): Promise<string> => {
        started.push(label);
        activeForDocument += 1;
        maximumActiveForDocument = Math.max(maximumActiveForDocument, activeForDocument);
        const value = await release.promise;
        activeForDocument -= 1;
        return value;
      };

    const first = coordinator.enqueue('file:///document.md', {
      kind: 'operation',
      execute: executeForDocument('first', firstRelease),
    });
    const second = coordinator.enqueue('file:///document.md', {
      kind: 'operation',
      execute: executeForDocument('second', secondRelease),
    });
    const other = coordinator.enqueue('file:///other.md', {
      kind: 'operation',
      execute: async () => {
        started.push('other');
        return otherRelease.promise;
      },
    });

    await nextMicrotask();

    expect(started).toEqual(['first', 'other']);
    expect(maximumActiveForDocument).toBe(1);

    otherRelease.resolve('other value');
    firstRelease.resolve('first value');
    await first;
    await nextMicrotask();

    expect(started).toEqual(['first', 'other', 'second']);
    expect(maximumActiveForDocument).toBe(1);

    secondRelease.resolve('second value');

    await expect(first).resolves.toEqual({
      status: 'completed',
      success: true,
      queueRevision: 1,
      value: 'first value',
    });
    await expect(second).resolves.toEqual({
      status: 'completed',
      success: true,
      queueRevision: 2,
      value: 'second value',
    });
    await expect(other).resolves.toEqual({
      status: 'completed',
      success: true,
      queueRevision: 1,
      value: 'other value',
    });
  });

  it('executes accepted non-typing work in strict queue revision order', async () => {
    const coordinator = new DocumentEditCoordinator<string>();
    const executionOrder: number[] = [];

    const results = [1, 2, 3, 4].map(value =>
      coordinator.enqueue('file:///document.md', {
        kind: 'operation',
        execute: async ({ queueRevision }): Promise<number> => {
          executionOrder.push(queueRevision);
          await Promise.resolve();
          return value;
        },
      })
    );

    await expect(Promise.all(results)).resolves.toEqual([
      { status: 'completed', success: true, queueRevision: 1, value: 1 },
      { status: 'completed', success: true, queueRevision: 2, value: 2 },
      { status: 'completed', success: true, queueRevision: 3, value: 3 },
      { status: 'completed', success: true, queueRevision: 4, value: 4 },
    ]);
    expect(executionOrder).toEqual([1, 2, 3, 4]);
  });

  it('coalesces only a pending adjacent typing edit from the same view lineage', async () => {
    const coordinator = new DocumentEditCoordinator<string>();
    const blockerRelease = deferred<void>();
    const executed: string[] = [];

    const blocker = coordinator.enqueue('file:///document.md', {
      kind: 'operation',
      execute: () => blockerRelease.promise,
    });
    await nextMicrotask();

    const superseded = coordinator.enqueue('file:///document.md', {
      kind: 'typing',
      viewGeneration: 'view-a:1',
      baseVersion: 7,
      execute: () => {
        executed.push('superseded');
        return 'old content';
      },
    });
    const latest = coordinator.enqueue('file:///document.md', {
      kind: 'typing',
      viewGeneration: 'view-a:1',
      baseVersion: 7,
      execute: () => {
        executed.push('latest');
        return 'latest content';
      },
    });

    await expect(superseded).resolves.toEqual({
      status: 'coalesced',
      success: false,
      queueRevision: 2,
      supersededByQueueRevision: 3,
    });

    blockerRelease.resolve();

    await expect(blocker).resolves.toEqual({
      status: 'completed',
      success: true,
      queueRevision: 1,
      value: undefined,
    });
    await expect(latest).resolves.toEqual({
      status: 'completed',
      success: true,
      queueRevision: 3,
      value: 'latest content',
    });
    expect(executed).toEqual(['latest']);
  });

  it('does not coalesce typing edits with a different view generation or base version', async () => {
    const coordinator = new DocumentEditCoordinator<string>();
    const blockerRelease = deferred<void>();
    const executed: string[] = [];

    const blocker = coordinator.enqueue('file:///document.md', {
      kind: 'operation',
      execute: () => blockerRelease.promise,
    });
    await nextMicrotask();

    const requests = [
      coordinator.enqueue('file:///document.md', {
        kind: 'typing',
        viewGeneration: 'view-a:1',
        baseVersion: 7,
        execute: () => executed.push('generation-one'),
      }),
      coordinator.enqueue('file:///document.md', {
        kind: 'typing',
        viewGeneration: 'view-a:2',
        baseVersion: 7,
        execute: () => executed.push('generation-two'),
      }),
      coordinator.enqueue('file:///document.md', {
        kind: 'typing',
        viewGeneration: 'view-a:2',
        baseVersion: 8,
        execute: () => executed.push('base-eight'),
      }),
    ];

    blockerRelease.resolve();
    await blocker;
    await Promise.all(requests);

    expect(executed).toEqual(['generation-one', 'generation-two', 'base-eight']);
    await expect(Promise.all(requests)).resolves.toEqual([
      { status: 'completed', success: true, queueRevision: 2, value: 1 },
      { status: 'completed', success: true, queueRevision: 3, value: 2 },
      { status: 'completed', success: true, queueRevision: 4, value: 3 },
    ]);
  });

  it('does not replace a typing edit that has already started', async () => {
    const coordinator = new DocumentEditCoordinator<string>();
    const firstRelease = deferred<string>();
    const executed: string[] = [];

    const first = coordinator.enqueue('file:///document.md', {
      kind: 'typing',
      viewGeneration: 'view-a:1',
      baseVersion: 7,
      execute: async () => {
        executed.push('first');
        return firstRelease.promise;
      },
    });
    await nextMicrotask();

    const second = coordinator.enqueue('file:///document.md', {
      kind: 'typing',
      viewGeneration: 'view-a:1',
      baseVersion: 7,
      execute: () => {
        executed.push('second');
        return 'second content';
      },
    });

    firstRelease.resolve('first content');

    await expect(first).resolves.toMatchObject({
      status: 'completed',
      queueRevision: 1,
      value: 'first content',
    });
    await expect(second).resolves.toMatchObject({
      status: 'completed',
      queueRevision: 2,
      value: 'second content',
    });
    expect(executed).toEqual(['first', 'second']);
  });

  it('uses barriers to drain prior work without coalescing across the boundary', async () => {
    const coordinator = new DocumentEditCoordinator<string>();
    const blockerRelease = deferred<void>();
    const afterBarrierRelease = deferred<string>();
    const executionOrder: string[] = [];

    const blocker = coordinator.enqueue('file:///document.md', {
      kind: 'operation',
      execute: () => blockerRelease.promise,
    });
    await nextMicrotask();

    const beforeBarrier = coordinator.enqueue('file:///document.md', {
      kind: 'typing',
      viewGeneration: 'view-a:1',
      baseVersion: 7,
      execute: () => {
        executionOrder.push('before barrier');
        return 'before';
      },
    });
    const barrier = coordinator.barrier('file:///document.md');
    const afterBarrier = coordinator.enqueue('file:///document.md', {
      kind: 'typing',
      viewGeneration: 'view-a:1',
      baseVersion: 7,
      execute: async () => {
        executionOrder.push('after barrier');
        return afterBarrierRelease.promise;
      },
    });

    blockerRelease.resolve();
    await blocker;

    await expect(beforeBarrier).resolves.toEqual({
      status: 'completed',
      success: true,
      queueRevision: 2,
      value: 'before',
    });
    await expect(barrier).resolves.toEqual({
      status: 'completed',
      success: true,
      queueRevision: 3,
      value: undefined,
    });
    expect(executionOrder).toEqual(['before barrier', 'after barrier']);

    afterBarrierRelease.resolve('after');
    await expect(afterBarrier).resolves.toEqual({
      status: 'completed',
      success: true,
      queueRevision: 4,
      value: 'after',
    });
  });

  it('reports pending work until the active edit and its barrier both settle', async () => {
    const coordinator = new DocumentEditCoordinator<string>();
    const release = deferred<void>();
    const key = 'file:///pending.md';

    expect(coordinator.hasPending(key)).toBe(false);

    const edit = coordinator.enqueue(key, {
      kind: 'operation',
      execute: () => release.promise,
    });
    const barrier = coordinator.barrier(key);

    expect(coordinator.hasPending(key)).toBe(true);
    await nextMicrotask();
    expect(coordinator.hasPending(key)).toBe(true);

    release.resolve();
    await edit;
    expect(coordinator.hasPending(key)).toBe(true);

    await barrier;
    expect(coordinator.hasPending(key)).toBe(false);
  });

  it('releases an idle document queue and does not interrupt accepted work', async () => {
    const coordinator = new DocumentEditCoordinator<string>();
    const key = 'file:///released.md';
    const release = deferred<string>();
    const active = coordinator.enqueue(key, {
      kind: 'operation',
      execute: () => release.promise,
    });
    await nextMicrotask();

    coordinator.release(key);
    expect(coordinator.hasPending(key)).toBe(true);

    release.resolve('saved');
    await expect(active).resolves.toMatchObject({ status: 'completed', value: 'saved' });
    expect(coordinator.hasPending(key)).toBe(false);

    const reopened = await coordinator.enqueue(key, {
      kind: 'operation',
      execute: () => 'reopened',
    });
    expect(reopened).toEqual({
      status: 'completed',
      success: true,
      queueRevision: 1,
      value: 'reopened',
    });
  });

  it('reports an execution failure and continues with later accepted work', async () => {
    const coordinator = new DocumentEditCoordinator<string>();
    const expectedError = new Error('apply failed');

    const failed = coordinator.enqueue('file:///document.md', {
      kind: 'operation',
      execute: () => {
        throw expectedError;
      },
    });
    const next = coordinator.enqueue('file:///document.md', {
      kind: 'operation',
      execute: () => false,
    });

    await expect(failed).resolves.toEqual({
      status: 'failed',
      success: false,
      queueRevision: 1,
      error: expectedError,
    });
    await expect(next).resolves.toEqual({
      status: 'completed',
      success: true,
      queueRevision: 2,
      value: false,
    });
  });

  it('removes an externally cancelled pending edit without stalling its queue', async () => {
    const coordinator = new DocumentEditCoordinator<string>();
    const blockerRelease = deferred<void>();
    const cancellation = new AbortController();
    const cancelledExecute = jest.fn();

    const blocker = coordinator.enqueue('file:///document.md', {
      kind: 'operation',
      execute: () => blockerRelease.promise,
    });
    await nextMicrotask();

    const cancelled = coordinator.enqueue('file:///document.md', {
      kind: 'operation',
      signal: cancellation.signal,
      execute: cancelledExecute,
    });
    const next = coordinator.enqueue('file:///document.md', {
      kind: 'operation',
      execute: () => 'continued',
    });

    cancellation.abort();

    await expect(cancelled).resolves.toMatchObject({
      status: 'cancelled',
      queueRevision: 2,
    });
    expect(cancelledExecute).not.toHaveBeenCalled();

    blockerRelease.resolve();
    await blocker;
    await expect(next).resolves.toEqual({
      status: 'completed',
      success: true,
      queueRevision: 3,
      value: 'continued',
    });
  });

  it('cancels active and pending work for one document and remains reusable', async () => {
    const coordinator = new DocumentEditCoordinator<string>();
    const activeStarted = deferred<DocumentEditExecutionContext<string>>();
    const pendingExecute = jest.fn();

    const active = coordinator.enqueue('file:///document.md', {
      kind: 'operation',
      execute: context => {
        activeStarted.resolve(context);
        return new Promise<string>(resolve => {
          context.signal.addEventListener('abort', () => resolve('stopped'), { once: true });
        });
      },
    });
    const pending = coordinator.enqueue('file:///document.md', {
      kind: 'operation',
      execute: pendingExecute,
    });

    const context = await activeStarted.promise;
    coordinator.cancel('file:///document.md', new Error('document invalidated'));

    expect(context.signal.aborted).toBe(true);
    await expect(active).resolves.toMatchObject({
      status: 'cancelled',
      queueRevision: 1,
    });
    await expect(pending).resolves.toMatchObject({
      status: 'cancelled',
      queueRevision: 2,
    });
    expect(pendingExecute).not.toHaveBeenCalled();

    const recovered = coordinator.enqueue('file:///document.md', {
      kind: 'operation',
      execute: () => 'recovered',
    });

    await expect(recovered).resolves.toEqual({
      status: 'completed',
      success: true,
      queueRevision: 3,
      value: 'recovered',
    });
  });

  it('disposes all queues, aborts active work, and declines later requests', async () => {
    const coordinator = new DocumentEditCoordinator<string>();
    const activeStarted = deferred<DocumentEditExecutionContext<string>>();
    const pendingExecute = jest.fn();

    const active = coordinator.enqueue('file:///document.md', {
      kind: 'operation',
      execute: context => {
        activeStarted.resolve(context);
        return new Promise<void>(resolve => {
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
    const pending = coordinator.enqueue('file:///document.md', {
      kind: 'operation',
      execute: pendingExecute,
    });

    const context = await activeStarted.promise;
    coordinator.dispose();

    expect(context.signal.aborted).toBe(true);
    await expect(active).resolves.toMatchObject({ status: 'cancelled', queueRevision: 1 });
    await expect(pending).resolves.toMatchObject({ status: 'cancelled', queueRevision: 2 });
    expect(pendingExecute).not.toHaveBeenCalled();

    await expect(
      coordinator.enqueue('file:///document.md', {
        kind: 'operation',
        execute: () => 'must not run',
      })
    ).resolves.toMatchObject({
      status: 'cancelled',
      queueRevision: null,
    });
  });
});
