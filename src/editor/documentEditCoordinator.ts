/**
 * @file documentEditCoordinator.ts - Per-document asynchronous edit ordering
 * @description Serializes document work without depending on the VS Code API.
 *              Pending typing edits may be coalesced only within one renderer
 *              lineage, while barriers and explicit operations preserve order.
 *
 * Key responsibilities:
 * - Keep at most one edit in flight for each document key
 * - Assign monotonic queue revisions and preserve accepted execution order
 * - Coalesce safe pending typing updates without crossing queue boundaries
 * - Contain failures and cancellation so later work can continue
 */

/** Context provided when an accepted edit begins execution. */
export interface DocumentEditExecutionContext<TKey> {
  /** Document identity used to select this queue. */
  readonly key: TKey;
  /** Monotonic revision assigned when the edit was accepted. */
  readonly queueRevision: number;
  /** Aborted when the request, document queue, or coordinator is cancelled. */
  readonly signal: AbortSignal;
}

interface DocumentEditRequestBase<TKey, TValue> {
  /** Work to run once all earlier accepted entries have settled. */
  readonly execute: (context: DocumentEditExecutionContext<TKey>) => TValue | Promise<TValue>;
  /** Optional caller cancellation for this entry. */
  readonly signal?: AbortSignal;
}

/** A typing update that is safe to supersede within the same pending lineage. */
export interface TypingDocumentEditRequest<TKey, TValue> extends DocumentEditRequestBase<
  TKey,
  TValue
> {
  readonly kind: 'typing';
  /** Unique renderer lifetime. Reloaded webviews must use a new generation. */
  readonly viewGeneration: string;
  /** Document version from which this renderer produced the update. */
  readonly baseVersion: number;
}

/** Ordered work that must never be coalesced. */
export interface OperationDocumentEditRequest<TKey, TValue> extends DocumentEditRequestBase<
  TKey,
  TValue
> {
  readonly kind: 'operation';
}

/** Request accepted by {@link DocumentEditCoordinator.enqueue}. */
export type DocumentEditRequest<TKey, TValue> =
  TypingDocumentEditRequest<TKey, TValue> | OperationDocumentEditRequest<TKey, TValue>;

/** Result of work that ran successfully. */
export interface CompletedDocumentEditResult<TValue> {
  readonly status: 'completed';
  readonly success: true;
  readonly queueRevision: number;
  readonly value: TValue;
}

/** Result of work that ran but failed. The queue continues after this result. */
export interface FailedDocumentEditResult {
  readonly status: 'failed';
  readonly success: false;
  readonly queueRevision: number;
  readonly error: unknown;
}

/** Result of a pending typing update replaced by a newer compatible update. */
export interface CoalescedDocumentEditResult {
  readonly status: 'coalesced';
  readonly success: false;
  readonly queueRevision: number;
  readonly supersededByQueueRevision: number;
}

/** Result of work cancelled before it could complete. */
export interface CancelledDocumentEditResult {
  readonly status: 'cancelled';
  readonly success: false;
  /** Null means the coordinator declined the request after disposal. */
  readonly queueRevision: number | null;
  readonly reason: unknown;
}

/** Every terminal outcome returned by the coordinator. */
export type DocumentEditResult<TValue> =
  | CompletedDocumentEditResult<TValue>
  | FailedDocumentEditResult
  | CoalescedDocumentEditResult
  | CancelledDocumentEditResult;

type InternalDocumentEditResult = DocumentEditResult<unknown>;
type InternalEntryKind = 'typing' | 'operation' | 'barrier';

interface InternalQueueEntry<TKey> {
  readonly kind: InternalEntryKind;
  readonly queueRevision: number;
  readonly viewGeneration?: string;
  readonly baseVersion?: number;
  readonly execute: (context: DocumentEditExecutionContext<TKey>) => Promise<unknown>;
  readonly controller: AbortController;
  readonly resolve: (result: InternalDocumentEditResult) => void;
  readonly externalSignal?: AbortSignal;
  externalAbortListener?: () => void;
  cancelled: boolean;
  cancellationReason?: unknown;
  settled: boolean;
}

interface DocumentQueue<TKey> {
  readonly key: TKey;
  nextRevision: number;
  readonly pending: InternalQueueEntry<TKey>[];
  active?: InternalQueueEntry<TKey>;
  pumpScheduled: boolean;
  releaseWhenIdle: boolean;
}

interface InternalQueueRequest<TKey, TValue> extends DocumentEditRequestBase<TKey, TValue> {
  readonly kind: InternalEntryKind;
  readonly viewGeneration?: string;
  readonly baseVersion?: number;
}

/** Error used when one document queue is explicitly cancelled. */
export class DocumentEditCancellationError extends Error {
  constructor(message = 'Document edit work was cancelled.') {
    super(message);
    this.name = 'DocumentEditCancellationError';
  }
}

/** Error used when work is submitted after coordinator disposal. */
export class DocumentEditCoordinatorDisposedError extends Error {
  constructor() {
    super('The document edit coordinator has been disposed.');
    this.name = 'DocumentEditCoordinatorDisposedError';
  }
}

/**
 * Serializes asynchronous edits independently for each document key.
 *
 * Revisions are scoped to a key and coordinator lifetime. `cancel` invalidates
 * accepted work but preserves the revision lineage so later recovery work can
 * be ordered unambiguously. `dispose` permanently declines new work.
 */
export class DocumentEditCoordinator<TKey> {
  private readonly _queues = new Map<TKey, DocumentQueue<TKey>>();
  private _disposed = false;
  private _disposalReason: unknown;

  /**
   * Accept an edit for ordered execution.
   *
   * Adjacent pending typing entries coalesce only when both their view
   * generation and base version match. An entry that has started is immutable.
   *
   * @param key - Stable document identity, normally a URI string in the adapter.
   * @param request - Typed or explicit operation to execute.
   * @returns A terminal result. Execution failures are values, not rejections.
   */
  enqueue<TValue>(
    key: TKey,
    request: DocumentEditRequest<TKey, TValue>
  ): Promise<DocumentEditResult<TValue>> {
    return this._enqueueInternal(key, request);
  }

  /**
   * Insert a non-coalescing boundary and resolve after all prior work settles.
   * Work accepted after the barrier may begin before its caller observes the
   * resolved promise, but it can never execute before the barrier itself.
   *
   * @param key - Document queue to drain.
   * @returns The barrier's queue result and revision.
   */
  barrier(key: TKey): Promise<DocumentEditResult<void>> {
    return this._enqueueInternal(key, {
      kind: 'barrier',
      execute: () => undefined,
    });
  }

  /**
   * Report whether a document has accepted work that has not settled yet.
   *
   * This reads the coordinator's complete queue, unlike adapter-level
   * "latest promise" tracking which can become empty when a coalesced request
   * settles while an older edit is still active.
   *
   * @param key - Document queue to inspect.
   * @returns True while an active or pending entry exists.
   */
  hasPending(key: TKey): boolean {
    const queue = this._queues.get(key);
    return queue !== undefined && (queue.active !== undefined || queue.pending.length > 0);
  }

  /**
   * Forget a document queue after its already accepted work settles.
   *
   * This never cancels active work. A new enqueue before the queue becomes
   * idle clears the release marker and continues the same ordering lineage.
   *
   * @param key - Document queue whose adapter lifetime has ended.
   */
  release(key: TKey): void {
    const queue = this._queues.get(key);
    if (!queue) return;
    queue.releaseWhenIdle = true;
    this._deleteQueueIfReleasable(queue);
  }

  /**
   * Cancel active and pending work currently accepted for one document.
   *
   * Active work receives an aborted signal and remains the in-flight entry
   * until its promise settles. New work stays ordered behind it.
   *
   * @param key - Document queue to invalidate.
   * @param reason - Diagnostic reason retained in cancelled results.
   */
  cancel(key: TKey, reason: unknown = new DocumentEditCancellationError()): void {
    const queue = this._queues.get(key);
    if (!queue) return;

    this._cancelQueue(queue, reason);
  }

  /**
   * Permanently stop the coordinator and cancel every accepted entry.
   * Later requests resolve as declined cancellations with no queue revision.
   */
  dispose(): void {
    if (this._disposed) return;

    this._disposed = true;
    this._disposalReason = new DocumentEditCoordinatorDisposedError();

    for (const queue of this._queues.values()) {
      this._cancelQueue(queue, this._disposalReason);
    }

    this._deleteSettledQueuesAfterDisposal();
  }

  private _enqueueInternal<TValue>(
    key: TKey,
    request: InternalQueueRequest<TKey, TValue>
  ): Promise<DocumentEditResult<TValue>> {
    if (this._disposed) {
      return Promise.resolve({
        status: 'cancelled',
        success: false,
        queueRevision: null,
        reason: this._disposalReason,
      });
    }

    const queue = this._getOrCreateQueue(key);
    const queueRevision = queue.nextRevision;
    queue.nextRevision += 1;

    let resolveResult: ((result: DocumentEditResult<TValue>) => void) | undefined;
    const resultPromise = new Promise<DocumentEditResult<TValue>>(resolve => {
      resolveResult = resolve;
    });

    const entry: InternalQueueEntry<TKey> = {
      kind: request.kind,
      queueRevision,
      viewGeneration: request.viewGeneration,
      baseVersion: request.baseVersion,
      execute: context => Promise.resolve(request.execute(context)),
      controller: new AbortController(),
      resolve: result => {
        if (!resolveResult) throw new Error('Queue result promise was not initialized.');
        resolveResult(result as DocumentEditResult<TValue>);
      },
      externalSignal: request.signal,
      cancelled: false,
      settled: false,
    };

    this._registerExternalCancellation(queue, entry);

    if (entry.cancelled) {
      return resultPromise;
    }

    this._coalesceCompatibleTail(queue, entry);
    queue.pending.push(entry);
    this._schedulePump(queue);
    return resultPromise;
  }

  private _getOrCreateQueue(key: TKey): DocumentQueue<TKey> {
    const existing = this._queues.get(key);
    if (existing) {
      existing.releaseWhenIdle = false;
      return existing;
    }

    const queue: DocumentQueue<TKey> = {
      key,
      nextRevision: 1,
      pending: [],
      pumpScheduled: false,
      releaseWhenIdle: false,
    };
    this._queues.set(key, queue);
    return queue;
  }

  private _registerExternalCancellation(
    queue: DocumentQueue<TKey>,
    entry: InternalQueueEntry<TKey>
  ): void {
    const externalSignal = entry.externalSignal;
    if (!externalSignal) return;

    const abortListener = (): void => {
      this._cancelEntry(queue, entry, new DocumentEditCancellationError());
    };
    entry.externalAbortListener = abortListener;
    externalSignal.addEventListener('abort', abortListener, { once: true });

    if (externalSignal.aborted) {
      this._cancelEntry(queue, entry, new DocumentEditCancellationError());
    }
  }

  private _coalesceCompatibleTail(
    queue: DocumentQueue<TKey>,
    replacement: InternalQueueEntry<TKey>
  ): void {
    if (replacement.kind !== 'typing') return;

    const candidate = queue.pending[queue.pending.length - 1];
    if (
      !candidate ||
      candidate.kind !== 'typing' ||
      candidate.viewGeneration !== replacement.viewGeneration ||
      candidate.baseVersion !== replacement.baseVersion
    ) {
      return;
    }

    queue.pending.pop();
    this._settleEntry(candidate, {
      status: 'coalesced',
      success: false,
      queueRevision: candidate.queueRevision,
      supersededByQueueRevision: replacement.queueRevision,
    });
  }

  private _schedulePump(queue: DocumentQueue<TKey>): void {
    if (queue.active || queue.pumpScheduled || queue.pending.length === 0) return;

    queue.pumpScheduled = true;
    queueMicrotask(() => {
      queue.pumpScheduled = false;
      this._startNext(queue);
    });
  }

  private _startNext(queue: DocumentQueue<TKey>): void {
    if (queue.active) return;

    const entry = queue.pending.shift();
    if (!entry) {
      this._deleteQueueIfReleasable(queue);
      return;
    }

    queue.active = entry;
    void this._executeEntry(queue, entry);
  }

  private async _executeEntry(
    queue: DocumentQueue<TKey>,
    entry: InternalQueueEntry<TKey>
  ): Promise<void> {
    let result: InternalDocumentEditResult;

    try {
      const value = await entry.execute({
        key: queue.key,
        queueRevision: entry.queueRevision,
        signal: entry.controller.signal,
      });

      result = entry.cancelled
        ? this._cancelledResult(entry)
        : {
            status: 'completed',
            success: true,
            queueRevision: entry.queueRevision,
            value,
          };
    } catch (error) {
      result = entry.cancelled
        ? this._cancelledResult(entry)
        : {
            status: 'failed',
            success: false,
            queueRevision: entry.queueRevision,
            error,
          };
    }

    if (queue.active === entry) queue.active = undefined;
    this._settleEntry(entry, result);
    this._schedulePump(queue);
    this._deleteQueueIfReleasable(queue);
  }

  private _cancelQueue(queue: DocumentQueue<TKey>, reason: unknown): void {
    if (queue.active) this._cancelEntry(queue, queue.active, reason);

    for (const entry of [...queue.pending]) {
      this._cancelEntry(queue, entry, reason);
    }
  }

  private _cancelEntry(
    queue: DocumentQueue<TKey>,
    entry: InternalQueueEntry<TKey>,
    reason: unknown
  ): void {
    if (entry.settled || entry.cancelled) return;

    entry.cancelled = true;
    entry.cancellationReason = reason;
    entry.controller.abort();

    if (queue.active === entry) return;

    const pendingIndex = queue.pending.indexOf(entry);
    if (pendingIndex >= 0) queue.pending.splice(pendingIndex, 1);

    this._settleEntry(entry, this._cancelledResult(entry));
    this._schedulePump(queue);
    this._deleteQueueIfReleasable(queue);
  }

  private _cancelledResult(entry: InternalQueueEntry<TKey>): CancelledDocumentEditResult {
    return {
      status: 'cancelled',
      success: false,
      queueRevision: entry.queueRevision,
      reason: entry.cancellationReason,
    };
  }

  private _settleEntry(entry: InternalQueueEntry<TKey>, result: InternalDocumentEditResult): void {
    if (entry.settled) return;

    entry.settled = true;
    this._removeExternalCancellation(entry);
    entry.resolve(result);
  }

  private _removeExternalCancellation(entry: InternalQueueEntry<TKey>): void {
    if (!entry.externalSignal || !entry.externalAbortListener) return;

    entry.externalSignal.removeEventListener('abort', entry.externalAbortListener);
    entry.externalAbortListener = undefined;
  }

  private _deleteSettledQueuesAfterDisposal(): void {
    for (const queue of this._queues.values()) {
      this._deleteQueueIfReleasable(queue);
    }
  }

  private _deleteQueueIfReleasable(queue: DocumentQueue<TKey>): void {
    if ((!this._disposed && !queue.releaseWhenIdle) || queue.active || queue.pending.length > 0) {
      return;
    }
    if (this._queues.get(queue.key) === queue) this._queues.delete(queue.key);
  }
}
