import {
  FeedbackActivationTransaction,
  type FeedbackActivationPreparation,
} from '../../webview/features/feedbackActivationController';

describe('FeedbackActivationTransaction', () => {
  it('keeps preparation provisional, commits atomically, and cleans up in reverse once', () => {
    const transaction = new FeedbackActivationTransaction();
    const events: string[] = [];

    const prepared = transaction.prepare(preparation => {
      preparation.install(() => {
        events.push('install read-only');
        return () => events.push('remove read-only');
      });
      preparation.install(() => {
        events.push('install plugin');
        return () => events.push('remove plugin');
      });
      preparation.install(() => {
        events.push('start observer');
        return () => events.push('stop observer');
      });
    });

    expect(prepared).toEqual({ disposition: 'applied', state: 'prepared' });
    expect(transaction.state).toBe('prepared');
    expect(transaction.isActive()).toBe(false);
    expect(events).toEqual(['install read-only', 'install plugin', 'start observer']);

    const committed = transaction.commit(() => {
      expect(transaction.state).toBe('committing');
      expect(transaction.isActive()).toBe(false);
      events.push('reveal review');
      return () => events.push('hide review');
    });

    expect(committed).toEqual({ disposition: 'applied', state: 'active' });
    expect(transaction.state).toBe('active');
    expect(transaction.isActive()).toBe(true);

    expect(transaction.rollback()).toEqual({ disposition: 'applied', state: 'rolled-back' });
    expect(transaction.rollback()).toEqual({ disposition: 'duplicate', state: 'rolled-back' });
    expect(transaction.isActive()).toBe(false);
    expect(events).toEqual([
      'install read-only',
      'install plugin',
      'start observer',
      'reveal review',
      'hide review',
      'stop observer',
      'remove plugin',
      'remove read-only',
    ]);
  });

  it('makes duplicate prepare and commit commands idempotent', () => {
    const transaction = new FeedbackActivationTransaction();
    const prepareEffect = jest.fn((preparation: FeedbackActivationPreparation) => {
      preparation.install(() => jest.fn());
    });
    const commitEffect = jest.fn(() => jest.fn());

    expect(transaction.prepare(prepareEffect)).toEqual({
      disposition: 'applied',
      state: 'prepared',
    });
    expect(transaction.prepare(prepareEffect)).toEqual({
      disposition: 'duplicate',
      state: 'prepared',
    });
    expect(transaction.commit(commitEffect)).toEqual({
      disposition: 'applied',
      state: 'active',
    });
    expect(transaction.commit(commitEffect)).toEqual({
      disposition: 'duplicate',
      state: 'active',
    });

    expect(prepareEffect).toHaveBeenCalledTimes(1);
    expect(commitEffect).toHaveBeenCalledTimes(1);
  });

  it('fails closed and reverses prior effects if any preparation effect throws', () => {
    const transaction = new FeedbackActivationTransaction();
    const expectedError = new Error('plugin setup failed');
    const events: string[] = [];
    const prepareEffect = jest.fn((preparation: FeedbackActivationPreparation) => {
      preparation.install(() => {
        events.push('install read-only');
        return () => events.push('remove read-only');
      });
      preparation.install(() => {
        events.push('install plugin');
        throw expectedError;
      });
      events.push('must not continue');
    });

    const result = transaction.prepare(prepareEffect);

    expect(result).toEqual({
      disposition: 'failed',
      state: 'rolled-back',
      error: expectedError,
    });
    expect(transaction.state).toBe('rolled-back');
    expect(transaction.isActive()).toBe(false);
    expect(events).toEqual(['install read-only', 'install plugin', 'remove read-only']);

    expect(transaction.prepare(prepareEffect)).toEqual({
      disposition: 'duplicate',
      state: 'rolled-back',
    });
    expect(transaction.commit(jest.fn(() => jest.fn()))).toEqual({
      disposition: 'rejected',
      state: 'rolled-back',
      reason: 'not-prepared',
    });
    expect(transaction.recover()).toEqual({
      disposition: 'duplicate',
      state: 'rolled-back',
    });
    expect(prepareEffect).toHaveBeenCalledTimes(1);
  });

  it('fails closed if commit throws and never exposes active state', () => {
    const transaction = new FeedbackActivationTransaction();
    const expectedError = new Error('review reveal failed');
    const cleanup = jest.fn();
    const commitEffect = jest.fn(() => {
      expect(transaction.isActive()).toBe(false);
      throw expectedError;
    });

    transaction.prepare(preparation => {
      preparation.registerCleanup(cleanup);
    });
    const result = transaction.commit(commitEffect);

    expect(result).toEqual({
      disposition: 'failed',
      state: 'rolled-back',
      error: expectedError,
    });
    expect(transaction.isActive()).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);

    expect(transaction.commit(commitEffect)).toEqual({
      disposition: 'duplicate',
      state: 'rolled-back',
    });
    expect(commitEffect).toHaveBeenCalledTimes(1);
  });

  it('continues reverse cleanup when one cleanup throws', () => {
    const cleanupError = new Error('observer cleanup failed');
    const onCleanupError = jest.fn();
    const transaction = new FeedbackActivationTransaction({ onCleanupError });
    const events: string[] = [];

    transaction.prepare(preparation => {
      preparation.registerCleanup(() => events.push('first cleanup'));
      preparation.registerCleanup(() => {
        events.push('throwing cleanup');
        throw cleanupError;
      });
      preparation.registerCleanup(() => events.push('last cleanup'));
    });

    expect(transaction.rollback()).toEqual({ disposition: 'applied', state: 'rolled-back' });
    expect(events).toEqual(['last cleanup', 'throwing cleanup', 'first cleanup']);
    expect(onCleanupError).toHaveBeenCalledTimes(1);
    expect(onCleanupError).toHaveBeenCalledWith(cleanupError);

    transaction.dispose();
    expect(events).toEqual(['last cleanup', 'throwing cleanup', 'first cleanup']);
  });

  it('disposes prepared effects in reverse and remains terminal', () => {
    const transaction = new FeedbackActivationTransaction();
    const events: string[] = [];

    transaction.prepare(preparation => {
      preparation.registerCleanup(() => events.push('first'));
      preparation.registerCleanup(() => events.push('second'));
    });

    transaction.dispose();
    transaction.dispose();

    expect(transaction.state).toBe('disposed');
    expect(transaction.isActive()).toBe(false);
    expect(events).toEqual(['second', 'first']);
    expect(transaction.prepare(jest.fn())).toEqual({
      disposition: 'rejected',
      state: 'disposed',
      reason: 'disposed',
    });
    expect(transaction.commit(jest.fn(() => jest.fn()))).toEqual({
      disposition: 'rejected',
      state: 'disposed',
      reason: 'disposed',
    });
  });

  it('disposes active review chrome before provisional effects', () => {
    const transaction = new FeedbackActivationTransaction();
    const events: string[] = [];

    transaction.prepare(preparation => {
      preparation.registerCleanup(() => events.push('remove read-only'));
    });
    transaction.commit(() => {
      events.push('reveal review');
      return () => events.push('hide review');
    });

    transaction.dispose();

    expect(transaction.state).toBe('disposed');
    expect(events).toEqual(['reveal review', 'hide review', 'remove read-only']);
  });

  it('rejects commit before preparation and makes duplicate recovery idempotent', () => {
    const transaction = new FeedbackActivationTransaction();
    const commitEffect = jest.fn(() => jest.fn());

    expect(transaction.commit(commitEffect)).toEqual({
      disposition: 'rejected',
      state: 'idle',
      reason: 'not-prepared',
    });
    expect(transaction.recover()).toEqual({
      disposition: 'applied',
      state: 'rolled-back',
    });
    expect(transaction.recover()).toEqual({
      disposition: 'duplicate',
      state: 'rolled-back',
    });
    expect(commitEffect).not.toHaveBeenCalled();
  });

  it('fails preparation when an installed effect does not return cleanup', () => {
    const transaction = new FeedbackActivationTransaction();
    const priorCleanup = jest.fn();

    const result = transaction.prepare(preparation => {
      preparation.registerCleanup(priorCleanup);
      preparation.install((() => undefined) as unknown as () => () => void);
    });

    expect(result).toMatchObject({
      disposition: 'failed',
      state: 'rolled-back',
      error: expect.any(Error),
    });
    expect(priorCleanup).toHaveBeenCalledTimes(1);
    expect(transaction.isActive()).toBe(false);
  });

  it('closes the preparation registrar after prepare returns', () => {
    const transaction = new FeedbackActivationTransaction();
    let retainedPreparation: FeedbackActivationPreparation | undefined;

    transaction.prepare(preparation => {
      retainedPreparation = preparation;
    });

    expect(() => retainedPreparation?.registerCleanup(jest.fn())).toThrow(/preparation.*closed/i);
    transaction.rollback();
  });
});
