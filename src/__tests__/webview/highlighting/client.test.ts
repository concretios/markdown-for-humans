/** @jest-environment jsdom */
import { createHighlightService } from '../../../webview/highlighting/client';
import { HIGHLIGHT_LIMITS, type HighlightService } from '../../../webview/highlighting/types';

type Request = {
  type: string;
  version: number;
  session: string;
  requestId: number;
  grammar: string;
  source: string;
};
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  postMessage = jest.fn<void, [Request]>();
  terminate = jest.fn();
  constructor(public url: string) {
    FakeWorker.instances.push(this);
  }
  reply(
    result: unknown = { spans: [{ from: 0, to: 5, classes: 'hljs-keyword' }] },
    overrides: Record<string, unknown> = {}
  ): void {
    const request = this.postMessage.mock.calls.at(-1)?.[0];
    if (!request) throw new Error('Worker has no request');
    this.onmessage?.({
      data: {
        type: 'md4h.highlight.result',
        version: 1,
        session: request.session,
        requestId: request.requestId,
        grammar: request.grammar,
        sourceLength: request.source.length,
        result,
        ...overrides,
      },
    } as MessageEvent);
  }
}
const flush = async (): Promise<void> => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  other!: FakePort;
  closed = false;
  postMessage(): void {
    if (!this.closed) FakeMessageChannel.queue.push(this.other);
  }
  close(): void {
    this.closed = true;
  }
}
/** Deterministic MessageChannel: messages are delivered only by deliver(). */
class FakeMessageChannel {
  static instances: FakeMessageChannel[] = [];
  static queue: FakePort[] = [];
  static posted = 0;
  port1 = new FakePort();
  port2 = new FakePort();
  constructor() {
    this.port1.other = this.port2;
    this.port2.other = this.port1;
    const post = this.port2.postMessage.bind(this.port2);
    this.port2.postMessage = () => {
      FakeMessageChannel.posted++;
      post();
    };
    FakeMessageChannel.instances.push(this);
  }
  static async deliver(): Promise<void> {
    const target = FakeMessageChannel.queue.shift();
    if (target && !target.closed) target.onmessage?.({ data: null } as MessageEvent);
    await flush();
  }
}

describe('bounded highlighting worker service', () => {
  let service: HighlightService;
  let fetchMock: jest.Mock;
  beforeEach(() => {
    jest.useFakeTimers();
    FakeWorker.instances = [];
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      blob: jest.fn().mockResolvedValue(new Blob(['worker source'])),
    });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: jest.fn().mockReturnValue('blob:local-worker'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
    service = createHighlightService(
      'https://local.vscode-resource.vscode-cdn.net/highlighting-worker.js'
    );
  });
  afterEach(() => {
    service.dispose();
    jest.useRealTimers();
  });
  it('does not initialize a worker for unknown, plain or oversized input', async () => {
    expect((await service.highlight('unknown', 'const x = 1')).spans).toEqual([]);
    expect((await service.highlight('text', 'const x = 1')).spans).toEqual([]);
    expect(
      (await service.highlight('ts', 'x'.repeat(HIGHLIGHT_LIMITS.sourceUnits + 1))).reason
    ).toBe('source-limit');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('fetches a packaged asset once, returns correlated spans and caches canonical aliases', async () => {
    const pending = service.highlight('ts', 'const x = 1');
    await flush();
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.postMessage.mock.calls[0][0].grammar).toBe('typescript');
    worker.reply();
    const result = await pending;
    expect(result.spans).toEqual([{ from: 0, to: 5, classes: 'hljs-keyword' }]);
    expect(await service.highlight('typescript', 'const x = 1')).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });
  it('rejects overlapping uncached jobs instead of creating an unbounded queue', async () => {
    const first = service.highlight('ts', 'const a = 1');
    await flush();
    expect((await service.highlight('ts', 'const b = 2')).reason).toBe('busy');
    FakeWorker.instances[0].reply();
    await first;
  });
  it('ignores stale results, including A to B to A request identities', async () => {
    const first = service.highlight('ts', 'const a = 1');
    await flush();
    const worker = FakeWorker.instances[0];
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    worker.reply(undefined, { requestId: 999 });
    await flush();
    expect(settled).toBe(false);
    worker.reply(undefined, { session: 'previous-view' });
    await flush();
    expect(settled).toBe(false);
    worker.reply();
    await first;
    const second = service.highlight('ts', 'const b = 2');
    await flush();
    const latest = worker.postMessage.mock.calls.at(-1)?.[0].requestId;
    worker.reply(undefined, { requestId: (latest ?? 0) - 1 });
    await flush();
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    worker.reply();
    await second;
  });
  it.each([
    { spans: [], unexpected: 'extra-payload' },
    { spans: [{ from: 0, to: 1, classes: 'hljs-string', extra: 'payload' }] },
    { spans: [{ from: 0, to: 100, classes: 'hljs-string' }] },
    { spans: [{ from: 0, to: 1, classes: 'onclick=bad' }] },
    {
      spans: [
        { from: 2, to: 4, classes: 'hljs-string' },
        { from: 1, to: 3, classes: 'hljs-comment' },
      ],
    },
    { spans: [{ from: 0.5, to: 1, classes: 'hljs-string' }] },
  ])('bounds retries after malformed worker output %#', async malformed => {
    const pending = service.highlight('ts', 'const x = 1');
    await flush();
    FakeWorker.instances[0].reply(malformed);
    await flush();
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
    FakeWorker.instances[1].reply(malformed);
    expect((await pending).reason).toBe('invalid-worker-result');
    expect((await service.highlight('ts', 'const x = 1')).reason).toBe('invalid-worker-result');
    expect(FakeWorker.instances).toHaveLength(2);
  });
  it('terminates a timed-out worker, retries once and does not reset the budget on cache eviction', async () => {
    const pending = service.highlight('ts', 'const x = 1');
    await flush();
    jest.advanceTimersByTime(HIGHLIGHT_LIMITS.timeoutMs);
    await flush();
    expect(FakeWorker.instances).toHaveLength(2);
    jest.advanceTimersByTime(HIGHLIGHT_LIMITS.timeoutMs);
    await flush();
    expect((await pending).reason).toBe('worker-timeout');
    expect((await service.highlight('ts', 'const x = 1')).reason).toBe('worker-timeout');
    expect(FakeWorker.instances).toHaveLength(2);
  });
  it('evicts least recently used source-relative cache entries after its entry limit', async () => {
    for (let index = 0; index <= HIGHLIGHT_LIMITS.cacheEntries; index++) {
      const pending = service.highlight('ts', `const v${index} = 1`);
      await flush();
      FakeWorker.instances[0].reply();
      await pending;
    }
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledTimes(HIGHLIGHT_LIMITS.cacheEntries + 1);
    const again = service.highlight('ts', 'const v0 = 1');
    await flush();
    expect(worker.postMessage).toHaveBeenCalledTimes(HIGHLIGHT_LIMITS.cacheEntries + 2);
    worker.reply();
    await again;
  });
  it('settles pending work on disposal, cancels fetch and ignores late worker output', async () => {
    const pending = service.highlight('ts', 'const x = 1');
    await flush();
    const worker = FakeWorker.instances[0];
    service.dispose();
    expect((await pending).reason).toBe('disposed');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    worker.reply();
    expect((await service.highlight('ts', 'const x = 1')).reason).toBe('disposed');
  });
  it('survives fetch rejection with one bounded retry', async () => {
    fetchMock.mockRejectedValue(new Error('no asset'));
    const pending = service.highlight('ts', 'const x = 1');
    await flush();
    expect((await pending).reason).toBe('worker-unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('evicts by accounted source bytes before reaching the entry limit', async () => {
    for (let index = 0; index < 8; index++) {
      const pending = service.highlight('ts', `const ${index}` + 'x'.repeat(600_000));
      await flush();
      FakeWorker.instances[0].reply();
      await pending;
    }
    const worker = FakeWorker.instances[0];
    const pending = service.highlight('ts', 'const 0' + 'x'.repeat(600_000));
    await flush();
    expect(worker.postMessage).toHaveBeenCalledTimes(9);
    worker.reply();
    await pending;
  });
  it('evicts by total range count before the entry limit', async () => {
    const spans = Array.from({ length: 20_000 }, (_, i) => ({
      from: i,
      to: i + 1,
      classes: i % 2 ? 'c' : 'r',
    }));
    for (let index = 0; index < 6; index++) {
      const pending = service.highlight('ts', String(index) + 'x'.repeat(20_000));
      await flush();
      FakeWorker.instances[0].reply({ spans });
      await jest.runAllTimersAsync();
      await pending;
    }
    const pending = service.highlight('ts', '0' + 'x'.repeat(20_000));
    await flush();
    expect(FakeWorker.instances[0].postMessage).toHaveBeenCalledTimes(7);
    FakeWorker.instances[0].reply({ spans });
    await jest.runAllTimersAsync();
    await pending;
  });
  it('does not accept a range that splits an emoji surrogate pair', async () => {
    const pending = service.highlight('ts', '🌍');
    await flush();
    FakeWorker.instances[0].reply({ spans: [{ from: 0, to: 1, classes: 'hljs-string' }] });
    await flush();
    FakeWorker.instances[1].reply({ spans: [{ from: 0, to: 1, classes: 'hljs-string' }] });
    expect((await pending).reason).toBe('invalid-worker-result');
  });
  it('settles a crash through one replacement worker', async () => {
    const pending = service.highlight('ts', 'const x = 1');
    await flush();
    FakeWorker.instances[0].onerror?.(new Event('error', { cancelable: true }));
    await flush();
    FakeWorker.instances[1].reply();
    expect((await pending).spans).toHaveLength(1);
    expect(FakeWorker.instances).toHaveLength(2);
  });
  it.each(['error', 'messageerror'] as const)(
    'retires an idle worker after %s before sending another source',
    async kind => {
      const first = service.highlight('ts', 'const first = 1');
      await flush();
      const worker = FakeWorker.instances[0];
      worker.reply();
      const cached = await first;

      const event = new Event(kind, { cancelable: true });
      if (kind === 'error') worker.onerror?.(event);
      else worker.onmessageerror?.(new MessageEvent(kind));

      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await service.highlight('typescript', 'const first = 1')).toBe(cached);

      const second = service.highlight('ts', 'const second = 2');
      await flush();
      expect(FakeWorker.instances).toHaveLength(2);
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
      FakeWorker.instances[1].reply();
      expect((await second).spans).toHaveLength(1);
    }
  );
  it('aborts an in-progress fetch and never constructs a worker after disposal', async () => {
    let complete: ((value: unknown) => void) | undefined;
    fetchMock.mockReturnValue(
      new Promise(resolve => {
        complete = resolve;
      })
    );
    const pending = service.highlight('ts', 'const x = 1');
    service.dispose();
    expect((await pending).reason).toBe('disposed');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    complete?.({ ok: true, blob: () => Promise.resolve(new Blob(['worker'])) });
    await flush();
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it('opens a view-scoped circuit breaker when the bounded failure ledger is full', async () => {
    for (let index = 0; index < HIGHLIGHT_LIMITS.failureEntries; index++) {
      const pending = service.highlight('ts', `const value${index} = 1`);
      await flush();
      FakeWorker.instances[FakeWorker.instances.length - 1].reply({
        spans: [{ from: 0, to: 999, classes: 'hljs-string' }],
      });
      await flush();
      FakeWorker.instances[FakeWorker.instances.length - 1].reply({
        spans: [{ from: 0, to: 999, classes: 'hljs-string' }],
      });
      await pending;
    }
    const pending = service.highlight('ts', 'const overflow = 1');
    await flush();
    FakeWorker.instances[FakeWorker.instances.length - 1].reply({
      spans: [{ from: 0, to: 999, classes: 'hljs-string' }],
    });
    expect((await pending).reason).toBe('retry-limit');
    const count = FakeWorker.instances.length;
    expect((await service.highlight('ts', 'const next = 1')).reason).toBe('retry-limit');
    expect(FakeWorker.instances).toHaveLength(count);
  });
  it('yields between large-result chunks while small results stay synchronous', async () => {
    const pending = service.highlight('ts', 'x'.repeat(3000));
    await flush();
    const spans = Array.from({ length: 3000 }, (_, index) => ({
      from: index,
      to: index + 1,
      classes: index % 2 ? 'c' : 'r',
    }));
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    FakeWorker.instances[0].reply({ spans });
    await flush();
    expect(settled).toBe(false);
    expect(Object.isFrozen(spans[0])).toBe(true);
    expect(Object.isFrozen(spans[spans.length - 1])).toBe(false);
    expect((await service.highlight('ts', 'const next = 1')).reason).toBe('busy');
    let eventLoopTurn = false;
    setTimeout(() => {
      eventLoopTurn = true;
    }, 0);
    await jest.runAllTimersAsync();
    expect(eventLoopTurn).toBe(true);
    expect((await pending).spans).toHaveLength(3000);
    const small = service.highlight('ts', 'const small = 1');
    await flush();
    FakeWorker.instances[0].reply();
    expect((await small).spans).toHaveLength(1);
  });
  it('cancels remaining validation and cache work when disposed between chunks', async () => {
    const pending = service.highlight('ts', 'x'.repeat(3000));
    await flush();
    const spans = Array.from({ length: 3000 }, (_, index) => ({
      from: index,
      to: index + 1,
      classes: index % 2 ? 'c' : 'r',
    }));
    FakeWorker.instances[0].reply({ spans });
    await flush();
    expect(Object.isFrozen(spans[spans.length - 1])).toBe(false);
    service.dispose();
    expect((await pending).reason).toBe('disposed');
    await jest.runAllTimersAsync();
    expect(Object.isFrozen(spans[spans.length - 1])).toBe(false);
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });
  it('ignores duplicate and stale replies during yielded result validation', async () => {
    const pending = service.highlight('ts', 'x'.repeat(3000));
    await flush();
    const worker = FakeWorker.instances[0];
    const spans = Array.from({ length: 3000 }, (_, index) => ({
      from: index,
      to: index + 1,
      classes: index % 2 ? 'c' : 'r',
    }));
    worker.reply({ spans });
    await flush();
    worker.reply({ spans: [{ from: 0, to: 99999, classes: 'hljs-string' }] });
    worker.reply({ spans: [] }, { session: 'previous-view' });
    worker.reply({ spans: [] }, { requestId: 99999 });
    await jest.runAllTimersAsync();
    expect((await pending).spans).toHaveLength(3000);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker.terminate).not.toHaveBeenCalled();
  });
  it('cancels an old validation continuation if its worker crashes between chunks', async () => {
    const pending = service.highlight('ts', 'x'.repeat(3000));
    await flush();
    const spans = Array.from({ length: 3000 }, (_, index) => ({
      from: index,
      to: index + 1,
      classes: index % 2 ? 'c' : 'r',
    }));
    FakeWorker.instances[0].reply({ spans });
    await flush();
    FakeWorker.instances[0].onerror?.(new Event('error', { cancelable: true }));
    await flush();
    FakeWorker.instances[1].reply();
    expect((await pending).spans).toHaveLength(1);
    await jest.runAllTimersAsync();
    expect(Object.isFrozen(spans[spans.length - 1])).toBe(false);
  });
  it('retains ordering validation across yielded chunk boundaries', async () => {
    const pending = service.highlight('ts', 'x'.repeat(1001));
    await flush();
    const spans = Array.from({ length: 1001 }, (_, index) => ({
      from: index,
      to: index + 1,
      classes: index % 2 ? 'c' : 'r',
    }));
    spans[1000] = { from: 500, to: 501, classes: 'c' };
    FakeWorker.instances[0].reply({ spans });
    await flush();
    expect(FakeWorker.instances).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1].reply({ spans: [{ from: 0, to: 99999, classes: 'hljs-string' }] });
    expect((await pending).reason).toBe('invalid-worker-result');
  });
  it('retains serialized-byte accounting across yielded chunk boundaries', async () => {
    const pending = service.highlight('ts', 'x'.repeat(15000));
    await flush();
    const classes = Array.from(
      { length: 6 },
      (_, index) => 'hljs-' + String.fromCharCode(97 + index).repeat(35)
    ).join(' ');
    const spans = Array.from({ length: 15000 }, (_, index) => ({
      from: index,
      to: index + 1,
      classes,
    }));
    FakeWorker.instances[0].reply({ spans });
    await flush();
    expect(FakeWorker.instances).toHaveLength(1);
    for (let turn = 0; turn < 20 && FakeWorker.instances.length === 1; turn++) {
      jest.advanceTimersToNextTimer();
      await flush();
    }
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1].reply({ spans: [{ from: 0, to: 99999, classes: 'hljs-string' }] });
    expect((await pending).reason).toBe('invalid-worker-result');
  });

  describe('message-task yielding', () => {
    const spansOf = (length: number, classes = 'r') =>
      Array.from({ length }, (_, index) => ({ from: index, to: index + 1, classes }));
    beforeEach(() => {
      FakeMessageChannel.instances = [];
      FakeMessageChannel.queue = [];
      FakeMessageChannel.posted = 0;
      Object.defineProperty(globalThis, 'MessageChannel', {
        configurable: true,
        value: FakeMessageChannel,
      });
    });
    afterEach(() => {
      Reflect.deleteProperty(globalThis, 'MessageChannel');
    });

    it('validates large results through message tasks without timer hops', async () => {
      const pending = service.highlight('ts', 'x'.repeat(3000));
      await flush();
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      FakeWorker.instances[0].reply({ spans: spansOf(3000) });
      await flush();
      // The first chunk runs synchronously; the rest wait for a message, not a timer.
      expect(settled).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
      expect(FakeMessageChannel.queue).toHaveLength(1);
      for (let turn = 0; turn < 5 && !settled; turn++) {
        await FakeMessageChannel.deliver();
        expect(FakeMessageChannel.queue.length).toBeLessThanOrEqual(1);
      }
      expect(settled).toBe(true);
      // 3,000 spans in 1,000-span chunks: two continuations, each a fresh message.
      expect(FakeMessageChannel.posted).toBe(2);
      expect((await pending).spans).toHaveLength(3000);
      expect(FakeMessageChannel.instances).toHaveLength(1);
    });

    it('closes the channel and ignores an in-flight message after disposal', async () => {
      const pending = service.highlight('ts', 'x'.repeat(3000));
      await flush();
      const spans = spansOf(3000);
      FakeWorker.instances[0].reply({ spans });
      await flush();
      expect(FakeMessageChannel.queue).toHaveLength(1);
      service.dispose();
      expect((await pending).reason).toBe('disposed');
      const [channel] = FakeMessageChannel.instances;
      expect(channel.port1.closed).toBe(true);
      expect(channel.port2.closed).toBe(true);
      await FakeMessageChannel.deliver();
      expect(Object.isFrozen(spans[spans.length - 1])).toBe(false);
    });

    it('reuses one in-flight message for the replacement job after a worker crash', async () => {
      const pending = service.highlight('ts', 'x'.repeat(3000));
      await flush();
      const stale = spansOf(3000, 'c');
      FakeWorker.instances[0].reply({ spans: stale });
      await flush();
      expect(FakeMessageChannel.posted).toBe(1);
      FakeWorker.instances[0].onerror?.(new Event('error', { cancelable: true }));
      await flush();
      const replacement = spansOf(3000, 'r');
      FakeWorker.instances[1].reply({ spans: replacement });
      await flush();
      // The stale continuation was cancelled; its queued message now carries the
      // replacement's continuation instead of posting a second message.
      expect(FakeMessageChannel.posted).toBe(1);
      expect(FakeMessageChannel.queue).toHaveLength(1);
      await FakeMessageChannel.deliver();
      await FakeMessageChannel.deliver();
      const result = await pending;
      expect(result.spans).toBe(replacement);
      expect(Object.isFrozen(replacement[replacement.length - 1])).toBe(true);
      expect(Object.isFrozen(stale[stale.length - 1])).toBe(false);
    });
  });
});
