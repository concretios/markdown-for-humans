/**
 * @file documentSyncController.ts - Deferred rich-editor serialization
 * @description Keeps TipTap serialization off the keystroke path. Editor state
 *              is inspected only when a debounce or explicit boundary fires,
 *              so delayed image saves cannot retain stale Markdown snapshots.
 *
 * Key responsibilities:
 * - Coalesce rapid dirty notifications into one serialization
 * - Read the latest editor state only at an actual send boundary
 * - Defer ordinary sync while prerequisite work is pending
 * - Cancel timers deterministically on flush, cancellation, and disposal
 */

/** Host-visible reason attached to a rich-editor edit message. */
export type DocumentSyncReason = 'typing' | 'save-policy-enforce';

/** Terminal result of a synchronous flush or immediate send boundary. */
export type DocumentSyncResult =
  | { readonly status: 'sent'; readonly content: string }
  | { readonly status: 'idle' }
  | { readonly status: 'blocked' }
  | { readonly status: 'disposed' };

/** Correlation retained until the host acknowledges an emitted edit. */
export interface SentDocumentEdit {
  readonly editId: string;
  readonly localRevision: number;
}

/** Dependencies for {@link DocumentSyncController}. */
export interface DocumentSyncControllerOptions {
  /** Quiet period before an ordinary typing edit is serialized. */
  readonly delayMs: number;
  /** Reads the current editor state. It is never called by `markDirty`. */
  readonly serialize: () => string;
  /** Delivers one serialized edit to the host. */
  readonly send: (
    content: string,
    reason: DocumentSyncReason
  ) => SentDocumentEdit | undefined | void;
  /** Pipelines one final dirty revision behind the current in-flight edit. */
  readonly sendTeardown?: (
    content: string,
    predecessor: SentDocumentEdit
  ) => SentDocumentEdit | undefined | void;
  /** Returns true while ordinary sync must wait, such as during image saves. */
  readonly shouldDefer?: () => boolean;
  /** Optional diagnostic callback invoked whenever a timer is deferred. */
  readonly onDeferred?: () => void;
  /** Error boundary for work triggered by a timer. Explicit boundaries throw. */
  readonly onError?: (error: unknown) => void;
  /** Schedules work and returns an idempotent cancellation callback. */
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

/**
 * Coalesces editor updates while preserving explicit save and flush boundaries.
 *
 * The controller intentionally stores only a dirty bit, never serialized
 * Markdown. This ensures a delayed timer reads the newest TipTap document.
 */
export class DocumentSyncController {
  private readonly _options: DocumentSyncControllerOptions;
  private _cancelScheduled: (() => void) | undefined;
  private readonly _unacknowledgedEdits = new Map<string, number>();
  private _dirty = false;
  private _dirtyRevision = 0;
  private _disposed = false;

  constructor(options: DocumentSyncControllerOptions) {
    this._options = options;
  }

  /** Mark the editor dirty and restart its debounce period. */
  markDirty(): void {
    if (this._disposed) return;

    this._dirty = true;
    this._dirtyRevision += 1;
    this._schedule();
  }

  /** Whether unsent or sent-but-unacknowledged renderer work still exists. */
  hasPendingSync(): boolean {
    return this._dirty || this._unacknowledgedEdits.size > 0;
  }

  /** Whether at least one emitted edit is awaiting its exact host ACK. */
  hasUnacknowledgedEdits(): boolean {
    return this._unacknowledgedEdits.size > 0;
  }

  /** Consume an ACK only when both its id and local revision match. */
  acknowledge(editId: string, localRevision: number): boolean {
    if (this._unacknowledgedEdits.get(editId) !== localRevision) return false;
    this._unacknowledgedEdits.delete(editId);
    return true;
  }

  /** Resume a dirty generation after its base-version ACK has been accepted. */
  resume(): void {
    if (this._disposed || !this._dirty || this._unacknowledgedEdits.size > 0) return;
    this._schedule(0);
  }

  /** Replace all renderer-side pending state with authoritative host content. */
  acceptAuthoritativeState(): void {
    this.cancel();
    this._unacknowledgedEdits.clear();
  }

  /**
   * Retire edits that the host has already drained without discarding a newer
   * unsent renderer revision. The caller can then flush that revision against
   * the authoritative host version carried by the barrier.
   */
  acceptHostBarrier(): void {
    if (this._disposed) return;
    this._unacknowledgedEdits.clear();
  }

  /**
   * Serialize and send pending work immediately as a typing edit.
   * Unsafe prerequisites such as image persistence still block this boundary.
   */
  flush(): DocumentSyncResult {
    return this._send('typing', true);
  }

  /**
   * Flush before a non-retained renderer is destroyed. A newer dirty revision
   * may depend on exactly one in-flight edit, so it uses an explicit dependent
   * delivery instead of waiting for an ACK that the renderer will not survive.
   */
  flushForTeardown(): DocumentSyncResult {
    if (this._disposed) return { status: 'disposed' };
    if (!this._dirty) return { status: 'idle' };
    if (this._unacknowledgedEdits.size === 0) return this._send('typing', true, true);
    if (this._unacknowledgedEdits.size !== 1 || !this._options.sendTeardown) {
      return { status: 'blocked' };
    }

    const predecessorEntry = this._unacknowledgedEdits.entries().next().value as
      [string, number] | undefined;
    if (!predecessorEntry) return { status: 'blocked' };

    const dirtyRevision = this._dirtyRevision;
    this._clearTimer();
    const content = this._options.serialize();
    const sentEdit = this._options.sendTeardown(content, {
      editId: predecessorEntry[0],
      localRevision: predecessorEntry[1],
    });
    if (sentEdit) {
      this._unacknowledgedEdits.set(sentEdit.editId, sentEdit.localRevision);
    }
    this._clearSentDirtyRevision(dirtyRevision);
    return { status: 'sent', content };
  }

  /**
   * Serialize immediately even when no ordinary debounce is pending.
   * Used by explicit user actions such as the save shortcut.
   */
  sendNow(reason: DocumentSyncReason): DocumentSyncResult {
    return this._send(reason, false);
  }

  /** Cancel one pending generation while keeping the controller reusable. */
  cancel(): void {
    this._dirty = false;
    this._clearTimer();
  }

  /** Permanently cancel pending work and decline future sync boundaries. */
  dispose(): void {
    if (this._disposed) return;

    this._disposed = true;
    this.cancel();
    this._unacknowledgedEdits.clear();
  }

  private _schedule(delayMs = this._options.delayMs): void {
    this._clearTimer();
    this._cancelScheduled = this._options.schedule(() => {
      this._cancelScheduled = undefined;
      this._runScheduledSync();
    }, delayMs);
  }

  private _runScheduledSync(): void {
    if (this._disposed || !this._dirty) return;

    try {
      // A newer renderer revision still derives from the last accepted host
      // version. Keep it dirty until that base version is acknowledged.
      if (this._unacknowledgedEdits.size > 0) return;

      if (this._options.shouldDefer?.()) {
        this._options.onDeferred?.();
        this._schedule();
        return;
      }

      this._send('typing', true);
    } catch (error) {
      // Retain the unsent revision, but do not reschedule it automatically.
      // A new edit or explicit boundary can retry without a failure loop.
      this._clearTimer();
      this._options.onError?.(error);
    }
  }

  private _send(
    reason: DocumentSyncReason,
    requireDirty: boolean,
    bypassDeferral = false
  ): DocumentSyncResult {
    if (this._disposed) return { status: 'disposed' };
    if (requireDirty && !this._dirty) return { status: 'idle' };
    if (this._unacknowledgedEdits.size > 0) return { status: 'blocked' };
    if (!bypassDeferral && this._options.shouldDefer?.()) {
      this._options.onDeferred?.();
      return { status: 'blocked' };
    }

    const dirtyRevision = this._dirtyRevision;
    this._clearTimer();
    const content = this._options.serialize();
    const sentEdit = this._options.send(content, reason);
    if (sentEdit) {
      this._unacknowledgedEdits.set(sentEdit.editId, sentEdit.localRevision);
    }
    this._clearSentDirtyRevision(dirtyRevision);
    return { status: 'sent', content };
  }

  /** Clear only the dirty revision completed by this synchronous send. */
  private _clearSentDirtyRevision(dirtyRevision: number): void {
    if (this._dirtyRevision === dirtyRevision) {
      this._dirty = false;
    }
  }

  private _clearTimer(): void {
    const cancelScheduled = this._cancelScheduled;
    this._cancelScheduled = undefined;
    cancelScheduled?.();
  }
}
