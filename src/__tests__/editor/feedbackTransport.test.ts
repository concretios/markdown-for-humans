import {
  FeedbackTransport,
  type FeedbackApplicationAcknowledgement,
  type FeedbackApplicationOutcome,
  type FeedbackTransportCommand,
  type FeedbackTransportTimers,
} from '../../editor/feedbackTransport';

interface TestPayload {
  readonly stage: string;
}

interface TestResult {
  readonly acceptedRevision: number;
}

interface TestStatus {
  readonly state: string;
}

type TestCommand = FeedbackTransportCommand<TestPayload>;
type TestAcknowledgement = FeedbackApplicationAcknowledgement<TestResult>;

const timers: FeedbackTransportTimers = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function command(
  messageId = 'message-1',
  operationEpoch = 'operation-1',
  stageRevision = 1,
  stage = 'prepare'
): TestCommand {
  return {
    messageId,
    operationEpoch,
    sessionEpoch: 'session-1',
    stageRevision,
    payload: { stage },
  };
}

function acknowledgement(
  source: TestCommand,
  outcome: FeedbackApplicationOutcome<TestResult> = {
    kind: 'applied',
    value: { acceptedRevision: source.stageRevision },
  }
): TestAcknowledgement {
  return {
    messageId: source.messageId,
    operationEpoch: source.operationEpoch,
    sessionEpoch: source.sessionEpoch,
    stageRevision: source.stageRevision,
    outcome,
  };
}

function createTransport(overrides?: {
  sendCommand?: jest.Mock;
  sendAcknowledgement?: jest.Mock;
  queryStatus?: jest.Mock;
  maxAttempts?: number;
  ackTimeoutMs?: number;
  retryDelayMs?: number;
  maxRetainedEntries?: number;
}) {
  const sendCommand = overrides?.sendCommand ?? jest.fn().mockResolvedValue(true);
  const sendAcknowledgement = overrides?.sendAcknowledgement ?? jest.fn().mockResolvedValue(true);
  const queryStatus =
    overrides?.queryStatus ?? jest.fn().mockResolvedValue({ state: 'authoritative' });
  const transport = new FeedbackTransport<
    TestPayload,
    TestResult,
    TestPayload,
    TestResult,
    TestStatus
  >({
    sendCommand,
    sendAcknowledgement,
    queryStatus,
    timers,
    maxAttempts: overrides?.maxAttempts ?? 3,
    ackTimeoutMs: overrides?.ackTimeoutMs ?? 100,
    retryDelayMs: overrides?.retryDelayMs ?? 10,
    maxRetainedEntries: overrides?.maxRetainedEntries ?? 8,
  });
  return { transport, sendCommand, sendAcknowledgement, queryStatus };
}

describe('FeedbackTransport', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not treat a queued postMessage as an application acknowledgement', async () => {
    const { transport, sendCommand } = createTransport();
    const outgoing = command();
    let settled = false;

    const delivery = transport.send(outgoing).then(result => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand.mock.calls[0][0]).toBe(outgoing);
    expect(settled).toBe(false);

    const ack = acknowledgement(outgoing);
    expect(transport.acceptAcknowledgement(ack)).toBe('accepted');
    await expect(delivery).resolves.toEqual({
      kind: 'acknowledged',
      acknowledgement: ack,
      attempts: 1,
    });
  });

  it.each([
    'feedback.finished',
    'feedback.discarded',
    'feedback.close.sync',
    'feedback.close.release',
    'feedback.transition.sync',
  ])('recovers %s from rejected and queued-but-unreceived posts', async stage => {
    const sendCommand = jest
      .fn()
      .mockRejectedValueOnce(new Error('renderer disposed while posting'))
      .mockResolvedValue(true);
    const { transport } = createTransport({
      sendCommand,
      maxAttempts: 3,
      ackTimeoutMs: 20,
      retryDelayMs: 5,
    });
    const outgoing = command(`critical-${stage}`, `operation-${stage}`, 1, stage);
    const delivery = transport.send(outgoing);

    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5);
    expect(sendCommand).toHaveBeenCalledTimes(2);

    // The second post was queued, but no renderer application response arrived.
    await jest.advanceTimersByTimeAsync(20);
    await jest.advanceTimersByTimeAsync(5);
    expect(sendCommand).toHaveBeenCalledTimes(3);

    transport.acceptAcknowledgement(acknowledgement(outgoing));
    await expect(delivery).resolves.toMatchObject({ kind: 'acknowledged', attempts: 3 });
    expect(sendCommand.mock.calls.every(([posted]) => posted === outgoing)).toBe(true);
  });

  it('reports a definitively unavailable renderer without retrying or querying status', async () => {
    const sendCommand = jest.fn().mockResolvedValue(false);
    const { transport, queryStatus } = createTransport({
      sendCommand,
      maxAttempts: 4,
      ackTimeoutMs: 20,
      retryDelayMs: 5,
    });

    await expect(transport.send(command('unavailable-renderer'))).resolves.toEqual({
      kind: 'unavailable',
      attempts: 1,
    });
    await jest.advanceTimersByTimeAsync(1_000);

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(queryStatus).not.toHaveBeenCalled();
    expect(transport.getRetainedCounts().pendingOutbound).toBe(0);
  });

  it('rejects oversized or control-character transport identities before retaining them', async () => {
    const { transport, sendCommand } = createTransport();

    await expect(transport.send(command('x'.repeat(257)))).resolves.toEqual({
      kind: 'not-sent',
      reason: 'invalid-command',
      attempts: 0,
    });
    await expect(transport.send(command('valid-id', 'operation\u0000epoch'))).resolves.toEqual({
      kind: 'not-sent',
      reason: 'invalid-command',
      attempts: 0,
    });

    expect(sendCommand).not.toHaveBeenCalled();
    expect(transport.getRetainedCounts()).toEqual({
      pendingOutbound: 0,
      completedOutbound: 0,
      receivedCommands: 0,
    });
  });

  it('resends the exact command after a rejected or failed post', async () => {
    const sendCommand = jest
      .fn()
      .mockRejectedValueOnce(new Error('webview disposed during post'))
      .mockResolvedValueOnce(true);
    const { transport } = createTransport({ sendCommand });
    const outgoing = command();
    const delivery = transport.send(outgoing);

    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(10);

    expect(sendCommand).toHaveBeenCalledTimes(2);
    for (const call of sendCommand.mock.calls) expect(call[0]).toBe(outgoing);

    transport.acceptAcknowledgement(acknowledgement(outgoing));
    await expect(delivery).resolves.toMatchObject({ kind: 'acknowledged', attempts: 2 });
  });

  it('resends the exact command after an ACK timeout', async () => {
    const { transport, sendCommand } = createTransport({ maxAttempts: 2 });
    const outgoing = command();
    const delivery = transport.send(outgoing);
    await Promise.resolve();
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(10);

    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(sendCommand.mock.calls[0][0]).toBe(outgoing);
    expect(sendCommand.mock.calls[1][0]).toBe(outgoing);

    transport.acceptAcknowledgement(acknowledgement(outgoing));
    await expect(delivery).resolves.toMatchObject({ kind: 'acknowledged', attempts: 2 });
  });

  it('times out a sendCommand Thenable that never settles and retries within maxAttempts', async () => {
    let resolveFirstPost: ((queued: boolean) => void) | undefined;
    const sendCommand = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>(resolve => {
            resolveFirstPost = resolve;
          })
      )
      .mockResolvedValue(true);
    const { transport, queryStatus } = createTransport({
      sendCommand,
      maxAttempts: 2,
      ackTimeoutMs: 20,
      retryDelayMs: 5,
    });
    const outgoing = command('hung-first-post');
    const delivery = transport.send(outgoing);

    await jest.advanceTimersByTimeAsync(20);
    await jest.advanceTimersByTimeAsync(5);
    expect(sendCommand).toHaveBeenCalledTimes(2);

    // A completion from the expired first attempt must not replace the active
    // second attempt's ACK timer or trigger another retry.
    resolveFirstPost?.(false);
    await Promise.resolve();
    transport.acceptAcknowledgement(acknowledgement(outgoing));

    await expect(delivery).resolves.toMatchObject({ kind: 'acknowledged', attempts: 2 });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(queryStatus).not.toHaveBeenCalled();
  });

  it.each(['abort', 'dispose'] as const)(
    'cleans the active attempt deadline when a hung send is cancelled by %s',
    async cancellation => {
      const sendCommand = jest.fn(() => new Promise<boolean>(() => undefined));
      const { transport, queryStatus } = createTransport({
        sendCommand,
        maxAttempts: 2,
        ackTimeoutMs: 20,
        retryDelayMs: 5,
      });
      const controller = new AbortController();
      const delivery = transport.send(command(`hung-${cancellation}`), {
        signal: controller.signal,
      });

      if (cancellation === 'abort') controller.abort();
      else transport.dispose();

      await expect(delivery).resolves.toEqual({
        kind: 'cancelled',
        reason: cancellation === 'abort' ? 'cancelled' : 'disposed',
        attempts: 1,
      });
      await jest.advanceTimersByTimeAsync(1_000);

      expect(sendCommand).toHaveBeenCalledTimes(1);
      expect(queryStatus).not.toHaveBeenCalled();
      expect(transport.getRetainedCounts().pendingOutbound).toBe(0);
    }
  );

  it('accepts one fully correlated ACK and ignores foreign or stale ACKs', async () => {
    const { transport } = createTransport();
    const outgoing = command();
    const delivery = transport.send(outgoing);
    await Promise.resolve();

    expect(
      transport.acceptAcknowledgement({
        ...acknowledgement(outgoing),
        operationEpoch: 'foreign-operation',
      })
    ).toBe('ignored');
    expect(
      transport.acceptAcknowledgement({
        ...acknowledgement(outgoing),
        sessionEpoch: 'stale-session',
      })
    ).toBe('ignored');
    expect(
      transport.acceptAcknowledgement({
        ...acknowledgement(outgoing),
        stageRevision: outgoing.stageRevision - 1,
      })
    ).toBe('ignored');

    const ack = acknowledgement(outgoing);
    expect(transport.acceptAcknowledgement(ack)).toBe('accepted');
    expect(transport.acceptAcknowledgement(ack)).toBe('duplicate');
    await expect(delivery).resolves.toMatchObject({ kind: 'acknowledged', attempts: 1 });
  });

  it('queries authoritative status once after bounded retry exhaustion', async () => {
    let querySignal: AbortSignal | undefined;
    const queryStatus = jest.fn((_query, signal: AbortSignal) => {
      querySignal = signal;
      return Promise.resolve<TestStatus>({ state: 'PreparingActivation' });
    });
    const { transport, sendCommand } = createTransport({
      maxAttempts: 2,
      ackTimeoutMs: 20,
      retryDelayMs: 5,
      queryStatus,
    });
    const outgoing = command();
    const delivery = transport.send(outgoing);
    await Promise.resolve();
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(20);
    await jest.advanceTimersByTimeAsync(5);
    await jest.advanceTimersByTimeAsync(20);
    const result = await delivery;

    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(queryStatus).toHaveBeenCalledTimes(1);
    expect(queryStatus.mock.calls[0][0]).toEqual({
      messageId: outgoing.messageId,
      operationEpoch: outgoing.operationEpoch,
      sessionEpoch: outgoing.sessionEpoch,
      stageRevision: outgoing.stageRevision,
    });
    expect(querySignal?.aborted).toBe(false);
    expect(result).toEqual({
      kind: 'status',
      status: { state: 'PreparingActivation' },
      attempts: 2,
    });
    expect(transport.acceptAcknowledgement(acknowledgement(outgoing))).toBe('ignored');
  });

  it('deduplicates concurrent received commands and replays the prior result', async () => {
    const { transport, sendAcknowledgement } = createTransport();
    const incoming = command('incoming-1');
    let releaseEffect: ((outcome: FeedbackApplicationOutcome<TestResult>) => void) | undefined;
    const effect = jest.fn(
      () =>
        new Promise<FeedbackApplicationOutcome<TestResult>>(resolve => {
          releaseEffect = resolve;
        })
    );

    const first = transport.receive(incoming, effect);
    const replay = transport.receive(incoming, effect);
    await Promise.resolve();
    expect(effect).toHaveBeenCalledTimes(1);

    releaseEffect?.({ kind: 'applied', value: { acceptedRevision: 4 } });
    const [firstResult, replayResult] = await Promise.all([first, replay]);

    expect(firstResult.disposition).toBe('processed');
    expect(replayResult.disposition).toBe('replayed');
    if (firstResult.disposition === 'processed' && replayResult.disposition === 'replayed') {
      expect(replayResult.acknowledgement).toBe(firstResult.acknowledgement);
    }
    expect(sendAcknowledgement).toHaveBeenCalledTimes(2);
    expect(sendAcknowledgement.mock.calls[1][0]).toBe(sendAcknowledgement.mock.calls[0][0]);
  });

  it('replays an ACK after its first post was dropped without rerunning the effect', async () => {
    const sendAcknowledgement = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { transport } = createTransport({ sendAcknowledgement });
    const incoming = command('incoming-dropped-ack');
    const effect = jest.fn().mockResolvedValue({
      kind: 'applied',
      value: { acceptedRevision: 9 },
    });

    const first = await transport.receive(incoming, effect);
    const replay = await transport.receive(incoming, effect);

    expect(first).toMatchObject({ disposition: 'processed', acknowledgementQueued: false });
    expect(replay).toMatchObject({ disposition: 'replayed', acknowledgementQueued: true });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(sendAcknowledgement.mock.calls[1][0]).toBe(sendAcknowledgement.mock.calls[0][0]);
  });

  it('rejects a conflicting command that reuses a retained message ID', async () => {
    const { transport, sendAcknowledgement } = createTransport();
    const incoming = command('incoming-conflict');
    const effect = jest.fn().mockResolvedValue({
      kind: 'applied',
      value: { acceptedRevision: 1 },
    });
    await transport.receive(incoming, effect);

    const conflict = await transport.receive(
      { ...incoming, operationEpoch: 'different-operation' },
      effect
    );

    expect(conflict.disposition).toBe('conflict');
    expect(effect).toHaveBeenCalledTimes(1);
    expect(sendAcknowledgement).toHaveBeenCalledTimes(1);
  });

  it('bounds retained inbound results with completed-entry LRU eviction', async () => {
    const { transport } = createTransport({ maxRetainedEntries: 2 });
    const effect = jest.fn((incoming: TestCommand) =>
      Promise.resolve<FeedbackApplicationOutcome<TestResult>>({
        kind: 'applied',
        value: { acceptedRevision: incoming.stageRevision },
      })
    );
    const first = command('incoming-lru-1', 'operation-lru-1', 1);
    const second = command('incoming-lru-2', 'operation-lru-2', 2);
    const third = command('incoming-lru-3', 'operation-lru-3', 3);

    await transport.receive(first, effect);
    await transport.receive(second, effect);
    await transport.receive(first, effect);
    await transport.receive(third, effect);

    expect(effect).toHaveBeenCalledTimes(3);
    expect(transport.getRetainedCounts().receivedCommands).toBe(2);

    await transport.receive(second, effect);
    expect(effect).toHaveBeenCalledTimes(4);
    expect(transport.getRetainedCounts().receivedCommands).toBe(2);
  });

  it('bounds retained outbound completion identities', async () => {
    const { transport } = createTransport({ maxRetainedEntries: 2 });
    const commands = [
      command('outbound-bound-1', 'bound-operation-1'),
      command('outbound-bound-2', 'bound-operation-2'),
      command('outbound-bound-3', 'bound-operation-3'),
    ];

    for (const outgoing of commands) {
      const delivery = transport.send(outgoing);
      await Promise.resolve();
      transport.acceptAcknowledgement(acknowledgement(outgoing));
      await delivery;
    }

    expect(transport.getRetainedCounts().completedOutbound).toBe(2);
    expect(transport.acceptAcknowledgement(acknowledgement(commands[0]))).toBe('ignored');
    expect(transport.acceptAcknowledgement(acknowledgement(commands[2]))).toBe('duplicate');
  });

  it('cancels a pending delivery without retrying or querying status', async () => {
    const { transport, sendCommand, queryStatus } = createTransport();
    const controller = new AbortController();
    const outgoing = command('cancelled-outgoing');
    const delivery = transport.send(outgoing, { signal: controller.signal });
    await Promise.resolve();

    controller.abort();
    await expect(delivery).resolves.toEqual({
      kind: 'cancelled',
      reason: 'cancelled',
      attempts: 1,
    });
    await jest.advanceTimersByTimeAsync(1_000);

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(queryStatus).not.toHaveBeenCalled();
    expect(transport.acceptAcknowledgement(acknowledgement(outgoing))).toBe('ignored');
  });

  it('disposal aborts status reconciliation and rejects further work', async () => {
    let statusSignal: AbortSignal | undefined;
    const queryStatus = jest.fn(
      (_query, signal: AbortSignal) =>
        new Promise<TestStatus>(() => {
          statusSignal = signal;
        })
    );
    const { transport, sendAcknowledgement } = createTransport({
      maxAttempts: 1,
      ackTimeoutMs: 20,
      queryStatus,
    });
    const outgoing = command('disposed-outgoing');
    const delivery = transport.send(outgoing);
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(20);
    expect(queryStatus).toHaveBeenCalledTimes(1);

    transport.dispose();

    await expect(delivery).resolves.toEqual({
      kind: 'cancelled',
      reason: 'disposed',
      attempts: 1,
    });
    expect(statusSignal?.aborted).toBe(true);
    await expect(transport.receive(command('after-dispose'), jest.fn())).resolves.toEqual({
      disposition: 'disposed',
    });
    expect(sendAcknowledgement).not.toHaveBeenCalled();
  });
});
