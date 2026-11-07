import { describeUncaughtError } from '../../webview/utils/describeUncaughtError';

describe('describeUncaughtError', () => {
  it('returns the Error object when the event has one', () => {
    const error = new Error('boom');
    expect(describeUncaughtError({ error, message: 'Uncaught Error: boom' })).toBe(error);
  });

  it('falls back to the message and location when there is no error object', () => {
    expect(
      describeUncaughtError({
        error: null,
        message: 'ResizeObserver loop completed with undelivered notifications.',
        filename: 'https://example.test/webview.js',
        lineno: 12,
        colno: 7,
      })
    ).toBe(
      'ResizeObserver loop completed with undelivered notifications. (https://example.test/webview.js:12:7)'
    );
  });

  it('gives the message alone when there is no location', () => {
    expect(describeUncaughtError({ error: undefined, message: 'Script error.' })).toBe(
      'Script error.'
    );
  });

  it('never returns an empty value', () => {
    expect(describeUncaughtError({ error: null, message: '' })).toBe(
      'Unknown error (the browser gave no error object or message)'
    );
  });
});
