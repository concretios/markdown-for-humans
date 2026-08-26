/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Application-acknowledged delivery for immutable image-save
 * completions. Failed queueing and lost acknowledgements share one bounded,
 * cancellable retry lifecycle.
 */

import type {
  PendingImageSaveCompletion,
  PendingImageSaveCompletionAck,
} from '../shared/pendingImageProtocol';

/** Result of offering one renderer acknowledgement to a delivery. */
export type ImageSaveCompletionAckDisposition = 'accepted' | 'duplicate' | 'ignored';

/** Injectable timer boundary used by deterministic delivery tests. */
export interface ImageSaveCompletionDeliveryTimers {
  /** Schedule one callback after the requested delay. */
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  /** Cancel a handle returned by {@link setTimeout}. */
  readonly clearTimeout: (handle: unknown) => void;
}

/** Dependencies and retry policy for one immutable completion. */
export interface ImageSaveCompletionDeliveryOptions {
  /** Exact completion replayed until application acknowledgement. */
  readonly message: PendingImageSaveCompletion;
  /** Queue the completion to the owning renderer. */
  readonly postMessage: (
    message: PendingImageSaveCompletion
  ) => boolean | void | PromiseLike<boolean | void>;
  /** Time to wait for an application ACK after successful queueing. */
  readonly ackTimeoutMs: number;
  /** Initial retry delay after failed queueing or an ACK timeout. */
  readonly retryDelayMs: number;
  /** Upper bound for exponential retry delay. */
  readonly maxRetryDelayMs: number;
  /** Optional deterministic timer implementation. */
  readonly timers?: ImageSaveCompletionDeliveryTimers;
}

const defaultTimers: ImageSaveCompletionDeliveryTimers = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function sameIdentity(
  completion: PendingImageSaveCompletion,
  acknowledgement: PendingImageSaveCompletionAck
): boolean {
  return (
    completion.protocolVersion === acknowledgement.protocolVersion &&
    completion.completionId === acknowledgement.completionId &&
    completion.placeholderId === acknowledgement.placeholderId &&
    completion.viewGeneration === acknowledgement.viewGeneration
  );
}

/**
 * Retries one immutable image-save completion until its renderer applies it.
 *
 * Only one timer and one active attempt token are retained. Late settlement
 * from an expired post cannot schedule extra work or supersede a newer retry.
 */
export class ImageSaveCompletionDelivery {
  private readonly timers: ImageSaveCompletionDeliveryTimers;
  private timer: unknown;
  private activeAttemptToken: symbol | undefined;
  private attempts = 0;
  private started = false;
  private acknowledged = false;
  private disposed = false;

  public constructor(private readonly options: ImageSaveCompletionDeliveryOptions) {
    for (const [name, value] of [
      ['ackTimeoutMs', options.ackTimeoutMs],
      ['retryDelayMs', options.retryDelayMs],
      ['maxRetryDelayMs', options.maxRetryDelayMs],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative finite number`);
      }
    }
    if (options.maxRetryDelayMs < options.retryDelayMs) {
      throw new RangeError('maxRetryDelayMs must be at least retryDelayMs');
    }
    this.timers = options.timers ?? defaultTimers;
  }

  /** Start delivery once. Repeated calls share the same retry lifecycle. */
  public start(): void {
    if (this.started || this.disposed || this.acknowledged) return;
    this.started = true;
    this.postAttempt();
  }

  /** Accept only an ACK matching the exact retained completion identity. */
  public acceptAcknowledgement(
    acknowledgement: PendingImageSaveCompletionAck
  ): ImageSaveCompletionAckDisposition {
    if (this.disposed || !this.started || !sameIdentity(this.options.message, acknowledgement)) {
      return 'ignored';
    }
    if (this.acknowledged) return 'duplicate';

    this.acknowledged = true;
    this.activeAttemptToken = undefined;
    this.clearTimer();
    return 'accepted';
  }

  /** Permanently cancel retry work while allowing teardown metadata to survive. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeAttemptToken = undefined;
    this.clearTimer();
  }

  private postAttempt(): void {
    if (this.disposed || this.acknowledged) return;

    this.attempts += 1;
    const attemptToken = Symbol('image-save-completion-attempt');
    this.activeAttemptToken = attemptToken;
    this.clearTimer();
    this.timer = this.timers.setTimeout(
      () => this.scheduleRetry(attemptToken),
      this.options.ackTimeoutMs
    );

    let posted: boolean | void | PromiseLike<boolean | void>;
    try {
      posted = this.options.postMessage(this.options.message);
    } catch {
      this.scheduleRetry(attemptToken);
      return;
    }

    void Promise.resolve(posted).then(
      queued => {
        if (queued === false) this.scheduleRetry(attemptToken);
      },
      () => this.scheduleRetry(attemptToken)
    );
  }

  private scheduleRetry(attemptToken: symbol): void {
    if (this.disposed || this.acknowledged || this.activeAttemptToken !== attemptToken) {
      return;
    }

    this.activeAttemptToken = undefined;
    this.clearTimer();
    const exponent = Math.min(Math.max(this.attempts - 1, 0), 20);
    const retryDelay = Math.min(
      this.options.retryDelayMs * 2 ** exponent,
      this.options.maxRetryDelayMs
    );
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.postAttempt();
    }, retryDelay);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
