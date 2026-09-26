/**
 * Bounded, acknowledged transport for correctness-critical Feedback commands.
 *
 * A successful sender result means only that the host queued the message. The
 * returned delivery promise settles successfully only after a correlated
 * application acknowledgement or authoritative status reconciliation.
 */

export interface FeedbackMessageIdentity {
  readonly messageId: string;
  readonly operationEpoch: string;
  readonly sessionEpoch: string | null;
  readonly stageRevision: number;
}

export interface FeedbackTransportCommand<TPayload> extends FeedbackMessageIdentity {
  readonly payload: TPayload;
}

export type FeedbackApplicationOutcome<TResult> =
  | { readonly kind: 'applied'; readonly value: TResult }
  | { readonly kind: 'rejected'; readonly code: string };

export interface FeedbackApplicationAcknowledgement<TResult> extends FeedbackMessageIdentity {
  readonly outcome: FeedbackApplicationOutcome<TResult>;
}

export interface FeedbackTransportTimers {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface FeedbackTransportOptions<TOutgoingPayload, TIncomingResult, TStatus> {
  readonly sendCommand: (
    command: FeedbackTransportCommand<TOutgoingPayload>
  ) => boolean | PromiseLike<boolean>;
  readonly sendAcknowledgement: (
    acknowledgement: FeedbackApplicationAcknowledgement<TIncomingResult>
  ) => boolean | PromiseLike<boolean>;
  readonly queryStatus: (
    identity: FeedbackMessageIdentity,
    signal: AbortSignal
  ) => TStatus | PromiseLike<TStatus>;
  readonly timers: FeedbackTransportTimers;
  /** Total post attempts, including the first attempt. */
  readonly maxAttempts: number;
  readonly ackTimeoutMs: number;
  readonly retryDelayMs: number;
  /** Independent ceiling for pending, completed, and received command maps. */
  readonly maxRetainedEntries: number;
}

export type FeedbackDeliveryResult<TResult, TStatus> =
  | {
      readonly kind: 'acknowledged';
      readonly acknowledgement: FeedbackApplicationAcknowledgement<TResult>;
      readonly attempts: number;
    }
  | { readonly kind: 'status'; readonly status: TStatus; readonly attempts: number }
  | { readonly kind: 'status-unavailable'; readonly attempts: number }
  | { readonly kind: 'unavailable'; readonly attempts: number }
  | {
      readonly kind: 'cancelled';
      readonly reason: 'cancelled' | 'disposed';
      readonly attempts: number;
    }
  | {
      readonly kind: 'not-sent';
      readonly reason: 'capacity-exhausted' | 'message-id-conflict' | 'invalid-command';
      readonly attempts: 0;
    };

export type FeedbackAcknowledgementDisposition = 'accepted' | 'duplicate' | 'ignored';

export type FeedbackReceiveResult<TResult> =
  | {
      readonly disposition: 'processed' | 'replayed';
      readonly acknowledgement: FeedbackApplicationAcknowledgement<TResult>;
      readonly acknowledgementQueued: boolean;
    }
  | {
      readonly disposition:
        'conflict' | 'capacity-exhausted' | 'cancelled' | 'disposed' | 'invalid-command';
    };

export interface FeedbackTransportRetainedCounts {
  readonly pendingOutbound: number;
  readonly completedOutbound: number;
  readonly receivedCommands: number;
}

interface PendingTimer {
  readonly handle: unknown;
}

interface PendingOutbound<TPayload, TResult, TStatus> {
  readonly command: FeedbackTransportCommand<TPayload>;
  readonly promise: Promise<FeedbackDeliveryResult<TResult, TStatus>>;
  readonly resolve: (result: FeedbackDeliveryResult<TResult, TStatus>) => void;
  attempts: number;
  activeAttemptToken: symbol | null;
  timer: PendingTimer | null;
  statusController: AbortController | null;
  abortSignal: AbortSignal | null;
  abortListener: (() => void) | null;
  settled: boolean;
}

interface CompletedOutbound {
  readonly identity: FeedbackMessageIdentity;
  readonly acknowledgementAccepted: boolean;
}

interface ReceivedCommand<TResult> {
  readonly identity: FeedbackMessageIdentity;
  readonly acknowledgement: Promise<FeedbackApplicationAcknowledgement<TResult>>;
  readonly controller: AbortController;
  completed: boolean;
}

const MAX_TRANSPORT_IDENTIFIER_LENGTH = 256;

function isTransportIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > MAX_TRANSPORT_IDENTIFIER_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function hasValidIdentity(identity: FeedbackMessageIdentity): boolean {
  return (
    isTransportIdentifier(identity.messageId) &&
    isTransportIdentifier(identity.operationEpoch) &&
    (identity.sessionEpoch === null || isTransportIdentifier(identity.sessionEpoch)) &&
    Number.isInteger(identity.stageRevision) &&
    identity.stageRevision >= 1
  );
}

function sameIdentity(left: FeedbackMessageIdentity, right: FeedbackMessageIdentity): boolean {
  return (
    left.messageId === right.messageId &&
    left.operationEpoch === right.operationEpoch &&
    left.sessionEpoch === right.sessionEpoch &&
    left.stageRevision === right.stageRevision
  );
}

function copyIdentity(identity: FeedbackMessageIdentity): FeedbackMessageIdentity {
  return {
    messageId: identity.messageId,
    operationEpoch: identity.operationEpoch,
    sessionEpoch: identity.sessionEpoch,
    stageRevision: identity.stageRevision,
  };
}

/**
 * Coordinates outbound ACK/retry behavior and inbound command deduplication.
 * Payload values are opaque and are never logged, hashed, or inspected.
 */
export class FeedbackTransport<
  TOutgoingPayload,
  TOutgoingResult,
  TIncomingPayload,
  TIncomingResult,
  TStatus,
> {
  private readonly pendingOutbound = new Map<
    string,
    PendingOutbound<TOutgoingPayload, TOutgoingResult, TStatus>
  >();
  private readonly completedOutbound = new Map<string, CompletedOutbound>();
  private readonly receivedCommands = new Map<string, ReceivedCommand<TIncomingResult>>();
  private disposed = false;

  public constructor(
    private readonly options: FeedbackTransportOptions<TOutgoingPayload, TIncomingResult, TStatus>
  ) {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new RangeError('maxAttempts must be a positive integer');
    }
    if (!Number.isFinite(options.ackTimeoutMs) || options.ackTimeoutMs < 0) {
      throw new RangeError('ackTimeoutMs must be a non-negative finite number');
    }
    if (!Number.isFinite(options.retryDelayMs) || options.retryDelayMs < 0) {
      throw new RangeError('retryDelayMs must be a non-negative finite number');
    }
    if (!Number.isInteger(options.maxRetainedEntries) || options.maxRetainedEntries < 1) {
      throw new RangeError('maxRetainedEntries must be a positive integer');
    }
  }

  /** Sends an idempotent command and waits for application-level confirmation. */
  public send(
    command: FeedbackTransportCommand<TOutgoingPayload>,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<FeedbackDeliveryResult<TOutgoingResult, TStatus>> {
    if (this.disposed) {
      return Promise.resolve({
        kind: 'cancelled',
        reason: 'disposed',
        attempts: 0,
      });
    }
    if (!hasValidIdentity(command)) {
      return Promise.resolve({ kind: 'not-sent', reason: 'invalid-command', attempts: 0 });
    }
    if (options.signal?.aborted) {
      return Promise.resolve({ kind: 'cancelled', reason: 'cancelled', attempts: 0 });
    }

    const existing = this.pendingOutbound.get(command.messageId);
    if (existing) {
      return existing.command === command
        ? existing.promise
        : Promise.resolve({ kind: 'not-sent', reason: 'message-id-conflict', attempts: 0 });
    }
    if (this.completedOutbound.has(command.messageId)) {
      return Promise.resolve({ kind: 'not-sent', reason: 'message-id-conflict', attempts: 0 });
    }
    if (this.pendingOutbound.size >= this.options.maxRetainedEntries) {
      return Promise.resolve({ kind: 'not-sent', reason: 'capacity-exhausted', attempts: 0 });
    }

    let resolveDelivery: (result: FeedbackDeliveryResult<TOutgoingResult, TStatus>) => void = () =>
      undefined;
    const promise = new Promise<FeedbackDeliveryResult<TOutgoingResult, TStatus>>(resolve => {
      resolveDelivery = resolve;
    });
    const pending: PendingOutbound<TOutgoingPayload, TOutgoingResult, TStatus> = {
      command,
      promise,
      resolve: resolveDelivery,
      attempts: 0,
      activeAttemptToken: null,
      timer: null,
      statusController: null,
      abortSignal: options.signal ?? null,
      abortListener: null,
      settled: false,
    };
    if (options.signal) {
      pending.abortListener = () => this.cancelPending(pending, 'cancelled');
      options.signal.addEventListener('abort', pending.abortListener, { once: true });
    }

    this.pendingOutbound.set(command.messageId, pending);
    this.startAttempt(pending);
    return promise;
  }

  /** Accepts only the first ACK that matches every command identity field. */
  public acceptAcknowledgement(
    acknowledgement: FeedbackApplicationAcknowledgement<TOutgoingResult>
  ): FeedbackAcknowledgementDisposition {
    if (this.disposed || !hasValidIdentity(acknowledgement)) return 'ignored';

    const pending = this.pendingOutbound.get(acknowledgement.messageId);
    if (pending) {
      if (!sameIdentity(pending.command, acknowledgement)) return 'ignored';
      this.settlePending(
        pending,
        {
          kind: 'acknowledged',
          acknowledgement,
          attempts: pending.attempts,
        },
        true,
        true
      );
      return 'accepted';
    }

    const completed = this.completedOutbound.get(acknowledgement.messageId);
    return completed?.acknowledgementAccepted && sameIdentity(completed.identity, acknowledgement)
      ? 'duplicate'
      : 'ignored';
  }

  /**
   * Applies a received command once. Replays post the exact retained ACK and
   * never invoke the application effect a second time.
   */
  public async receive(
    command: FeedbackTransportCommand<TIncomingPayload>,
    effect: (
      command: FeedbackTransportCommand<TIncomingPayload>,
      signal: AbortSignal
    ) =>
      | FeedbackApplicationOutcome<TIncomingResult>
      | PromiseLike<FeedbackApplicationOutcome<TIncomingResult>>,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<FeedbackReceiveResult<TIncomingResult>> {
    if (this.disposed) return { disposition: 'disposed' };
    if (!hasValidIdentity(command)) return { disposition: 'invalid-command' };
    if (options.signal?.aborted) return { disposition: 'cancelled' };

    const retained = this.receivedCommands.get(command.messageId);
    if (retained) {
      if (!sameIdentity(retained.identity, command)) return { disposition: 'conflict' };
      const acknowledgement = await retained.acknowledgement;
      if (this.disposed) return { disposition: 'disposed' };
      if (options.signal?.aborted) return { disposition: 'cancelled' };
      this.touchReceived(command.messageId, retained);
      return {
        disposition: 'replayed',
        acknowledgement,
        acknowledgementQueued: await this.postAcknowledgement(acknowledgement),
      };
    }

    if (!this.makeReceivedCapacity()) return { disposition: 'capacity-exhausted' };

    const controller = new AbortController();
    const abortListener = options.signal ? () => controller.abort() : null;
    if (options.signal && abortListener) {
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    const acknowledgement = Promise.resolve()
      .then(async (): Promise<FeedbackApplicationAcknowledgement<TIncomingResult>> => {
        let outcome: FeedbackApplicationOutcome<TIncomingResult>;
        if (controller.signal.aborted) {
          outcome = { kind: 'rejected', code: 'transport-cancelled' };
        } else {
          try {
            outcome = await effect(command, controller.signal);
          } catch {
            outcome = { kind: 'rejected', code: 'effect-threw' };
          }
        }
        return { ...copyIdentity(command), outcome };
      })
      .finally(() => {
        if (options.signal && abortListener) {
          options.signal.removeEventListener('abort', abortListener);
        }
      });

    const entry: ReceivedCommand<TIncomingResult> = {
      identity: copyIdentity(command),
      acknowledgement,
      controller,
      completed: false,
    };
    this.receivedCommands.set(command.messageId, entry);

    const result = await acknowledgement;
    entry.completed = true;
    this.touchReceived(command.messageId, entry);
    if (this.disposed) return { disposition: 'disposed' };
    if (options.signal?.aborted) return { disposition: 'cancelled' };
    return {
      disposition: 'processed',
      acknowledgement: result,
      acknowledgementQueued: await this.postAcknowledgement(result),
    };
  }

  /** Returns content-free sizes for assertions and local diagnostics. */
  public getRetainedCounts(): FeedbackTransportRetainedCounts {
    return {
      pendingOutbound: this.pendingOutbound.size,
      completedOutbound: this.completedOutbound.size,
      receivedCommands: this.receivedCommands.size,
    };
  }

  /** Cancels pending operations and prevents all future posts or effects. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of [...this.pendingOutbound.values()]) {
      this.cancelPending(pending, 'disposed');
    }
    for (const received of this.receivedCommands.values()) received.controller.abort();
    this.receivedCommands.clear();
    this.completedOutbound.clear();
  }

  private startAttempt(pending: PendingOutbound<TOutgoingPayload, TOutgoingResult, TStatus>): void {
    if (!this.isCurrentPending(pending)) return;
    this.clearPendingTimer(pending);
    pending.attempts += 1;
    const attemptToken = Symbol('feedback-transport-attempt');
    pending.activeAttemptToken = attemptToken;
    // Bound the whole posting attempt, including a sender Thenable that never
    // settles. A queued result does not restart this deadline.
    this.setPendingTimer(pending, this.options.ackTimeoutMs, () => {
      this.retryOrQueryStatus(pending, attemptToken);
    });

    let queued: boolean | PromiseLike<boolean>;
    try {
      queued = this.options.sendCommand(pending.command);
    } catch {
      this.handlePostFailure(pending, attemptToken);
      return;
    }
    void Promise.resolve(queued).then(
      result => this.handlePostResult(pending, attemptToken, result),
      () => this.handlePostFailure(pending, attemptToken)
    );
  }

  private handlePostResult(
    pending: PendingOutbound<TOutgoingPayload, TOutgoingResult, TStatus>,
    attemptToken: symbol,
    queued: boolean
  ): void {
    if (!this.isCurrentPending(pending) || pending.activeAttemptToken !== attemptToken) return;
    if (!queued) {
      // VS Code defines false as a definitive failure to enqueue for this
      // webview generation. Retrying the destroyed renderer can only delay a
      // barrier that should instead rehydrate its next ready generation.
      this.settlePending(pending, { kind: 'unavailable', attempts: pending.attempts }, false, true);
    }
  }

  /** A thrown/rejected sender is ambiguous, so preserve bounded retry semantics. */
  private handlePostFailure(
    pending: PendingOutbound<TOutgoingPayload, TOutgoingResult, TStatus>,
    attemptToken: symbol
  ): void {
    this.retryOrQueryStatus(pending, attemptToken);
  }

  private retryOrQueryStatus(
    pending: PendingOutbound<TOutgoingPayload, TOutgoingResult, TStatus>,
    attemptToken: symbol
  ): void {
    if (!this.isCurrentPending(pending) || pending.activeAttemptToken !== attemptToken) return;
    // Invalidate this attempt before the retry delay. Its sender may resolve
    // late while the next attempt is pending and must not replace that timer.
    pending.activeAttemptToken = null;
    this.clearPendingTimer(pending);
    if (pending.attempts >= this.options.maxAttempts) {
      this.queryAuthoritativeStatus(pending);
      return;
    }
    this.setPendingTimer(pending, this.options.retryDelayMs, () => this.startAttempt(pending));
  }

  private queryAuthoritativeStatus(
    pending: PendingOutbound<TOutgoingPayload, TOutgoingResult, TStatus>
  ): void {
    if (!this.isCurrentPending(pending) || pending.statusController) return;
    const controller = new AbortController();
    pending.statusController = controller;

    let status: TStatus | PromiseLike<TStatus>;
    try {
      status = this.options.queryStatus(copyIdentity(pending.command), controller.signal);
    } catch {
      this.finishUnavailableStatus(pending);
      return;
    }
    void Promise.resolve(status).then(
      result => {
        if (!this.isCurrentPending(pending)) return;
        this.settlePending(
          pending,
          { kind: 'status', status: result, attempts: pending.attempts },
          false,
          false
        );
      },
      () => this.finishUnavailableStatus(pending)
    );
  }

  private finishUnavailableStatus(
    pending: PendingOutbound<TOutgoingPayload, TOutgoingResult, TStatus>
  ): void {
    if (!this.isCurrentPending(pending)) return;
    this.settlePending(
      pending,
      { kind: 'status-unavailable', attempts: pending.attempts },
      false,
      false
    );
  }

  private cancelPending(
    pending: PendingOutbound<TOutgoingPayload, TOutgoingResult, TStatus>,
    reason: 'cancelled' | 'disposed'
  ): void {
    if (!this.isCurrentPending(pending)) return;
    this.settlePending(
      pending,
      { kind: 'cancelled', reason, attempts: pending.attempts },
      false,
      true
    );
  }

  private settlePending(
    pending: PendingOutbound<TOutgoingPayload, TOutgoingResult, TStatus>,
    result: FeedbackDeliveryResult<TOutgoingResult, TStatus>,
    acknowledgementAccepted: boolean,
    abortStatusQuery: boolean
  ): void {
    if (!this.isCurrentPending(pending)) return;
    pending.settled = true;
    pending.activeAttemptToken = null;
    this.clearPendingTimer(pending);
    if (abortStatusQuery) pending.statusController?.abort();
    if (pending.abortSignal && pending.abortListener) {
      pending.abortSignal.removeEventListener('abort', pending.abortListener);
    }
    this.pendingOutbound.delete(pending.command.messageId);
    this.retainCompletedOutbound(pending.command, acknowledgementAccepted);
    pending.resolve(result);
  }

  private isCurrentPending(
    pending: PendingOutbound<TOutgoingPayload, TOutgoingResult, TStatus>
  ): boolean {
    return !pending.settled && this.pendingOutbound.get(pending.command.messageId) === pending;
  }

  private setPendingTimer(
    pending: PendingOutbound<TOutgoingPayload, TOutgoingResult, TStatus>,
    delayMs: number,
    callback: () => void
  ): void {
    this.clearPendingTimer(pending);
    pending.timer = {
      handle: this.options.timers.setTimeout(() => {
        pending.timer = null;
        callback();
      }, delayMs),
    };
  }

  private clearPendingTimer(
    pending: PendingOutbound<TOutgoingPayload, TOutgoingResult, TStatus>
  ): void {
    if (!pending.timer) return;
    this.options.timers.clearTimeout(pending.timer.handle);
    pending.timer = null;
  }

  private retainCompletedOutbound(
    identity: FeedbackMessageIdentity,
    acknowledgementAccepted: boolean
  ): void {
    this.completedOutbound.delete(identity.messageId);
    this.completedOutbound.set(identity.messageId, {
      identity: copyIdentity(identity),
      acknowledgementAccepted,
    });
    while (this.completedOutbound.size > this.options.maxRetainedEntries) {
      const oldest = this.completedOutbound.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completedOutbound.delete(oldest);
    }
  }

  private makeReceivedCapacity(): boolean {
    while (this.receivedCommands.size >= this.options.maxRetainedEntries) {
      const completed = [...this.receivedCommands.entries()].find(([, entry]) => entry.completed);
      if (!completed) return false;
      this.receivedCommands.delete(completed[0]);
    }
    return true;
  }

  private touchReceived(messageId: string, entry: ReceivedCommand<TIncomingResult>): void {
    if (this.receivedCommands.get(messageId) !== entry) return;
    this.receivedCommands.delete(messageId);
    this.receivedCommands.set(messageId, entry);
  }

  private async postAcknowledgement(
    acknowledgement: FeedbackApplicationAcknowledgement<TIncomingResult>
  ): Promise<boolean> {
    if (this.disposed) return false;
    try {
      return await this.options.sendAcknowledgement(acknowledgement);
    } catch {
      return false;
    }
  }
}
