import {
  DocumentSyncController,
  type DocumentSyncControllerOptions,
} from '../../webview/documentSyncController';

function createController(
  overrides: Partial<DocumentSyncControllerOptions> = {}
): DocumentSyncController {
  return new DocumentSyncController({
    delayMs: 500,
    serialize: jest.fn(() => 'markdown'),
    send: jest.fn(),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
    ...overrides,
  });
}

describe('DocumentSyncController', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('serializes once after many updates and reads the latest editor state', () => {
    let latestMarkdown = 'revision 0';
    const serialize = jest.fn(() => latestMarkdown);
    const send = jest.fn();
    const controller = createController({ serialize, send });

    for (let revision = 1; revision <= 20; revision += 1) {
      latestMarkdown = `revision ${revision}`;
      controller.markDirty();
    }

    expect(serialize).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(499);
    expect(serialize).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);

    expect(serialize).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('revision 20', 'typing');
    expect(controller.hasPendingSync()).toBe(false);
  });

  it('defers for pending image saves without retaining stale serialized Markdown', () => {
    let imageSavePending = true;
    let latestMarkdown = 'before image save';
    const serialize = jest.fn(() => latestMarkdown);
    const send = jest.fn();
    const onDeferred = jest.fn();
    const controller = createController({
      serialize,
      send,
      shouldDefer: () => imageSavePending,
      onDeferred,
    });

    controller.markDirty();
    jest.advanceTimersByTime(500);

    expect(onDeferred).toHaveBeenCalledTimes(1);
    expect(serialize).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(controller.hasPendingSync()).toBe(true);
    expect(jest.getTimerCount()).toBe(1);

    latestMarkdown = 'after image save';
    imageSavePending = false;
    jest.advanceTimersByTime(500);

    expect(serialize).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('after image save', 'typing');
    expect(controller.hasPendingSync()).toBe(false);
  });

  it('sends an immediate save-policy update once and cancels pending debounce work', () => {
    const serialize = jest.fn(() => 'save content');
    const send = jest.fn();
    const controller = createController({ serialize, send });

    controller.markDirty();
    const result = controller.sendNow('save-policy-enforce');

    expect(result).toEqual({ status: 'sent', content: 'save content' });
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('save content', 'save-policy-enforce');
    expect(jest.getTimerCount()).toBe(0);

    jest.advanceTimersByTime(1_000);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('flushes a dirty editor once, cancels pending work, and stays idle on repeated flushes', () => {
    const serialize = jest.fn(() => 'flush content');
    const send = jest.fn();
    const controller = createController({ serialize, send });

    controller.markDirty();
    const first = controller.flush();
    const second = controller.flush();

    expect(first).toEqual({ status: 'sent', content: 'flush content' });
    expect(second).toEqual({ status: 'idle' });
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('flush content', 'typing');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('blocks save and host flush boundaries while image persistence is pending', () => {
    const serialize = jest.fn(() => 'unsafe base64 preview');
    const send = jest.fn();
    const controller = createController({
      serialize,
      send,
      shouldDefer: () => true,
    });

    controller.markDirty();
    expect(controller.sendNow('save-policy-enforce')).toEqual({ status: 'blocked' });
    expect(controller.flush()).toEqual({ status: 'blocked' });

    expect(serialize).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(controller.hasPendingSync()).toBe(true);
  });

  it('still emits a teardown revision for host-owned image completion', () => {
    const serialize = jest.fn(() => 'base64 preview before teardown');
    const send = jest.fn();
    const controller = createController({
      serialize,
      send,
      shouldDefer: () => true,
    });

    controller.markDirty();

    expect(controller.flushForTeardown()).toEqual({
      status: 'sent',
      content: 'base64 preview before teardown',
    });
    expect(send).toHaveBeenCalledWith('base64 preview before teardown', 'typing');
  });

  it('cancels pending work and can schedule a later clean generation', () => {
    const serialize = jest.fn(() => 'later content');
    const send = jest.fn();
    const controller = createController({ serialize, send });

    controller.markDirty();
    controller.cancel();

    expect(controller.hasPendingSync()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(500);
    expect(serialize).not.toHaveBeenCalled();

    controller.markDirty();
    jest.advanceTimersByTime(500);

    expect(serialize).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('later content', 'typing');
  });

  it('disposes idempotently, clears timers, and declines later boundaries', () => {
    const serialize = jest.fn(() => 'must not send');
    const send = jest.fn();
    const controller = createController({ serialize, send });

    controller.markDirty();
    controller.dispose();
    controller.dispose();

    expect(jest.getTimerCount()).toBe(0);
    expect(controller.hasPendingSync()).toBe(false);
    expect(controller.flush()).toEqual({ status: 'disposed' });
    expect(controller.sendNow('save-policy-enforce')).toEqual({ status: 'disposed' });

    controller.markDirty();
    jest.advanceTimersByTime(1_000);
    expect(serialize).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a scheduled serialization error, retains dirty work, and does not busy retry', () => {
    const expectedError = new Error('serialization failed');
    const onError = jest.fn();
    const serialize = jest
      .fn<string, []>()
      .mockImplementationOnce(() => {
        throw expectedError;
      })
      .mockReturnValue('recovered markdown');
    const send = jest.fn();
    const controller = createController({
      serialize,
      send,
      onError,
    });

    controller.markDirty();
    jest.advanceTimersByTime(500);

    expect(onError).toHaveBeenCalledWith(expectedError);
    expect(controller.hasPendingSync()).toBe(true);
    expect(jest.getTimerCount()).toBe(0);

    jest.advanceTimersByTime(5_000);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();

    expect(controller.flush()).toEqual({
      status: 'sent',
      content: 'recovered markdown',
    });
    expect(serialize).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith('recovered markdown', 'typing');
    expect(controller.hasPendingSync()).toBe(false);
  });

  it('retains dirty work after a scheduled send error until a new dirty event retries', () => {
    const expectedError = new Error('send failed');
    const onError = jest.fn();
    const send = jest
      .fn<void, [string, 'typing' | 'save-policy-enforce']>()
      .mockImplementationOnce(() => {
        throw expectedError;
      });
    const controller = createController({ send, onError });

    controller.markDirty();
    jest.advanceTimersByTime(500);

    expect(onError).toHaveBeenCalledWith(expectedError);
    expect(controller.hasPendingSync()).toBe(true);
    expect(jest.getTimerCount()).toBe(0);

    controller.markDirty();
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(500);

    expect(send).toHaveBeenCalledTimes(2);
    expect(controller.hasPendingSync()).toBe(false);
  });

  it.each([
    ['flush', (controller: DocumentSyncController) => controller.flush()],
    ['sendNow', (controller: DocumentSyncController) => controller.sendNow('save-policy-enforce')],
  ])('retains dirty work when explicit %s serialization throws', (_name, invoke) => {
    const expectedError = new Error('explicit serialization failed');
    const controller = createController({
      serialize: jest.fn(() => {
        throw expectedError;
      }),
    });

    controller.markDirty();

    expect(() => invoke(controller)).toThrow(expectedError);
    expect(controller.hasPendingSync()).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    ['flush', (controller: DocumentSyncController) => controller.flush()],
    ['sendNow', (controller: DocumentSyncController) => controller.sendNow('save-policy-enforce')],
  ])('retains dirty work when explicit %s delivery throws', (_name, invoke) => {
    const expectedError = new Error('explicit send failed');
    const controller = createController({
      send: jest.fn(() => {
        throw expectedError;
      }),
    });

    controller.markDirty();

    expect(() => invoke(controller)).toThrow(expectedError);
    expect(controller.hasPendingSync()).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['serialize', 'send'] as const)(
    'retains the newest dirty revision when teardown %s throws',
    failurePoint => {
      const expectedError = new Error(`teardown ${failurePoint} failed`);
      const send = jest.fn(() => ({ editId: 'view-1:1:1', localRevision: 1 }));
      const sendTeardown = jest.fn(() => ({ editId: 'view-1:2:2', localRevision: 2 }));
      const serialize = jest.fn(() => 'markdown');
      if (failurePoint === 'serialize') {
        serialize
          .mockImplementationOnce(() => 'markdown')
          .mockImplementationOnce(() => {
            throw expectedError;
          });
      } else {
        sendTeardown.mockImplementationOnce(() => {
          throw expectedError;
        });
      }
      const controller = createController({ serialize, send, sendTeardown });

      controller.markDirty();
      jest.advanceTimersByTime(500);
      controller.markDirty();

      expect(() => controller.flushForTeardown()).toThrow(expectedError);
      expect(controller.hasPendingSync()).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
      expect(sendTeardown).toHaveBeenCalledTimes(failurePoint === 'send' ? 1 : 0);

      expect(controller.flushForTeardown()).toEqual({ status: 'sent', content: 'markdown' });
      expect(sendTeardown).toHaveBeenLastCalledWith('markdown', {
        editId: 'view-1:1:1',
        localRevision: 1,
      });
    }
  );

  it('keeps sent edits dirty until the exact revision is acknowledged', () => {
    const controller = createController({
      send: jest.fn(() => ({ editId: 'view-1:4:1', localRevision: 4 })),
    });

    controller.markDirty();
    jest.advanceTimersByTime(500);

    expect(controller.hasPendingSync()).toBe(true);
    expect(controller.hasUnacknowledgedEdits()).toBe(true);
    expect(controller.acknowledge('view-1:4:1', 3)).toBe(false);
    expect(controller.acknowledge('unknown-edit', 4)).toBe(false);
    expect(controller.hasPendingSync()).toBe(true);

    expect(controller.acknowledge('view-1:4:1', 4)).toBe(true);
    expect(controller.hasUnacknowledgedEdits()).toBe(false);
    expect(controller.hasPendingSync()).toBe(false);
  });

  it('does not send a newer dirty revision while its base version is unacknowledged', () => {
    let sequence = 0;
    const send = jest.fn(() => {
      sequence += 1;
      return { editId: `view-1:${sequence}:1`, localRevision: sequence };
    });
    const controller = createController({ send });

    controller.markDirty();
    jest.advanceTimersByTime(500);
    controller.markDirty();
    jest.advanceTimersByTime(500);

    expect(send).toHaveBeenCalledTimes(1);
    expect(controller.flush()).toEqual({ status: 'blocked' });

    expect(controller.acknowledge('view-1:1:1', 1)).toBe(true);
    controller.resume();
    jest.advanceTimersByTime(0);

    expect(send).toHaveBeenCalledTimes(2);
    expect(controller.hasUnacknowledgedEdits()).toBe(true);
  });

  it('accepts an authoritative host barrier without discarding a newer dirty revision', () => {
    let sequence = 0;
    const send = jest.fn(() => {
      sequence += 1;
      return { editId: `view-1:${sequence}:1`, localRevision: sequence };
    });
    const controller = createController({ send });

    controller.markDirty();
    jest.advanceTimersByTime(500);
    controller.markDirty();

    expect(controller.flush()).toEqual({ status: 'blocked' });
    controller.acceptHostBarrier();

    expect(controller.hasUnacknowledgedEdits()).toBe(false);
    expect(controller.hasPendingSync()).toBe(true);
    expect(controller.flush()).toEqual({ status: 'sent', content: 'markdown' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('pipelines the newest dirty revision behind its in-flight edit at teardown', () => {
    const send = jest.fn(() => ({ editId: 'view-1:1:1', localRevision: 1 }));
    const sendTeardown = jest.fn(() => ({ editId: 'view-1:2:2', localRevision: 2 }));
    const controller = createController({ send, sendTeardown });

    controller.markDirty();
    jest.advanceTimersByTime(500);
    controller.markDirty();

    expect(controller.flush()).toEqual({ status: 'blocked' });
    expect(controller.flushForTeardown()).toEqual({ status: 'sent', content: 'markdown' });
    expect(sendTeardown).toHaveBeenCalledWith('markdown', {
      editId: 'view-1:1:1',
      localRevision: 1,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
