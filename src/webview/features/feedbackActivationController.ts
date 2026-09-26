/**
 * @file feedbackActivationController.ts - Transactional renderer activation
 * @description Stages Feedback renderer side effects behind a cleanup stack,
 *              exposes active state only after a successful commit, and rolls
 *              every provisional effect back when preparation cannot finish.
 *
 * Key responsibilities:
 * - Register a cleanup for each provisional renderer side effect
 * - Run cleanup in reverse order exactly once
 * - Make prepare, commit, recovery, and disposal idempotent
 * - Keep the transaction independent of TipTap and browser DOM types
 */

/** One idempotency-scoped renderer activation state. */
export type FeedbackActivationState =
  'idle' | 'preparing' | 'prepared' | 'committing' | 'active' | 'rolled-back' | 'disposed';

/** Cleanup for one installed listener, observer, plugin, or DOM effect. */
export type FeedbackActivationCleanup = () => void;

/** Registrar available only while the prepare callback is running. */
export interface FeedbackActivationPreparation {
  /**
   * Run one side-effect setup and retain its cleanup before another setup runs.
   * Setups should perform one atomic effect so a later failure is reversible.
   */
  install(setup: () => FeedbackActivationCleanup): void;
  /** Register cleanup for an effect the caller has already created. */
  registerCleanup(cleanup: FeedbackActivationCleanup): void;
}

/** Optional diagnostics for cleanup failures. Cleanup always continues. */
export interface FeedbackActivationTransactionOptions {
  readonly onCleanupError?: (error: unknown) => void;
}

export type FeedbackActivationRejectionReason = 'disposed' | 'not-prepared' | 'not-idle';

/** Stable result returned by every protocol-driven transaction stage. */
export type FeedbackActivationResult =
  | {
      readonly disposition: 'applied' | 'duplicate';
      readonly state: FeedbackActivationState;
    }
  | {
      readonly disposition: 'rejected';
      readonly state: FeedbackActivationState;
      readonly reason: FeedbackActivationRejectionReason;
    }
  | {
      readonly disposition: 'failed';
      readonly state: FeedbackActivationState;
      readonly error: unknown;
    };

class ActivationPreparationRegistrar implements FeedbackActivationPreparation {
  private _open = true;
  private readonly _register: (cleanup: FeedbackActivationCleanup) => void;

  constructor(register: (cleanup: FeedbackActivationCleanup) => void) {
    this._register = register;
  }

  public install(setup: () => FeedbackActivationCleanup): void {
    this._assertOpen();
    if (typeof setup !== 'function') {
      throw new TypeError('Feedback activation setup must be a function.');
    }

    const cleanup = setup();
    if (typeof cleanup !== 'function') {
      throw new TypeError('Every Feedback activation effect must return cleanup.');
    }
    this._register(cleanup);
  }

  public registerCleanup(cleanup: FeedbackActivationCleanup): void {
    this._assertOpen();
    if (typeof cleanup !== 'function') {
      throw new TypeError('Feedback activation cleanup must be a function.');
    }
    this._register(cleanup);
  }

  public close(): void {
    this._open = false;
  }

  private _assertOpen(): void {
    if (!this._open) {
      throw new Error('Feedback activation preparation is closed.');
    }
  }
}

/**
 * Owns all renderer effects for one activation operation.
 *
 * A transaction is single-use. Retries for the same protocol operation replay
 * cached terminal state instead of rerunning effects. A new operation creates
 * a new transaction.
 */
export class FeedbackActivationTransaction {
  private readonly _cleanups: FeedbackActivationCleanup[] = [];
  private readonly _onCleanupError?: (error: unknown) => void;
  private _state: FeedbackActivationState = 'idle';
  private _prepareAttempted = false;
  private _commitAttempted = false;

  constructor(options: FeedbackActivationTransactionOptions = {}) {
    this._onCleanupError = options.onCleanupError;
  }

  /** Current transaction state. `active` is reachable only through commit. */
  public get state(): FeedbackActivationState {
    return this._state;
  }

  /** Whether review UI has been committed and may be exposed to the user. */
  public isActive(): boolean {
    return this._state === 'active';
  }

  /**
   * Install provisional renderer effects.
   *
   * Any throw closes the registrar, runs all registered cleanup in reverse,
   * and leaves the transaction terminal and inactive.
   */
  public prepare(
    prepareEffects: (preparation: FeedbackActivationPreparation) => void
  ): FeedbackActivationResult {
    if (this._state === 'disposed') return this._rejected('disposed');
    if (this._prepareAttempted) return this._duplicate();
    if (this._state !== 'idle') return this._rejected('not-idle');

    this._prepareAttempted = true;
    this._state = 'preparing';
    const registrar = new ActivationPreparationRegistrar(cleanup => {
      if (this._state !== 'preparing') {
        throw new Error('Feedback activation preparation is no longer active.');
      }
      this._cleanups.push(cleanup);
    });

    try {
      prepareEffects(registrar);
      registrar.close();
      if (this._state !== 'preparing') {
        const error = new Error('Feedback activation preparation was interrupted.');
        this._rollbackAfterFailure();
        return { disposition: 'failed', state: this._state, error };
      }

      this._state = 'prepared';
      return { disposition: 'applied', state: this._state };
    } catch (error) {
      registrar.close();
      this._rollbackAfterFailure();
      return { disposition: 'failed', state: this._state, error };
    }
  }

  /**
   * Reveal the prepared review UI atomically.
   *
   * The reveal callback must return cleanup. Active state is published only
   * after that callback succeeds and its cleanup is safely registered.
   */
  public commit(revealReview: () => FeedbackActivationCleanup): FeedbackActivationResult {
    if (this._state === 'disposed') return this._rejected('disposed');
    if (this._commitAttempted) return this._duplicate();
    if (this._state !== 'prepared') return this._rejected('not-prepared');

    this._commitAttempted = true;
    this._state = 'committing';

    try {
      const cleanup = revealReview();
      if (typeof cleanup !== 'function') {
        throw new TypeError('Feedback activation commit must return cleanup.');
      }

      if (this._state !== 'committing') {
        this._runCleanup(cleanup);
        const error = new Error('Feedback activation commit was interrupted.');
        this._rollbackAfterFailure();
        return { disposition: 'failed', state: this._state, error };
      }

      this._cleanups.push(cleanup);
      this._state = 'active';
      return { disposition: 'applied', state: this._state };
    } catch (error) {
      this._rollbackAfterFailure();
      return { disposition: 'failed', state: this._state, error };
    }
  }

  /** Roll back provisional or active effects. Repeated recovery is a no-op. */
  public rollback(): FeedbackActivationResult {
    if (this._state === 'rolled-back' || this._state === 'disposed') {
      return this._duplicate();
    }

    this._state = 'rolled-back';
    this._drainCleanups();
    return { disposition: 'applied', state: this._state };
  }

  /** Protocol-facing recovery alias for {@link rollback}. */
  public recover(): FeedbackActivationResult {
    return this.rollback();
  }

  /** Permanently release all effects. Repeated disposal is safe. */
  public dispose(): void {
    if (this._state === 'disposed') return;

    this._state = 'disposed';
    this._drainCleanups();
  }

  private _rollbackAfterFailure(): void {
    if (this._state !== 'disposed') this._state = 'rolled-back';
    this._drainCleanups();
  }

  private _drainCleanups(): void {
    const cleanups = this._cleanups.splice(0).reverse();
    for (const cleanup of cleanups) this._runCleanup(cleanup);
  }

  private _runCleanup(cleanup: FeedbackActivationCleanup): void {
    try {
      cleanup();
    } catch (error) {
      try {
        this._onCleanupError?.(error);
      } catch {
        // Diagnostics must never interrupt the remainder of rollback.
      }
    }
  }

  private _duplicate(): FeedbackActivationResult {
    return { disposition: 'duplicate', state: this._state };
  }

  private _rejected(reason: FeedbackActivationRejectionReason): FeedbackActivationResult {
    return { disposition: 'rejected', state: this._state, reason };
  }
}
