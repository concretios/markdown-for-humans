/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/** The fields of a window `error` event this module reads. */
export interface UncaughtErrorLike {
  readonly error?: unknown;
  readonly message?: string;
  readonly filename?: string;
  readonly lineno?: number;
  readonly colno?: number;
}

/**
 * What to log for an uncaught window error.
 *
 * Some error events carry no error object (a script error from another origin, a
 * ResizeObserver notification), so logging `event.error` alone printed an empty
 * line. Fall back to the message and its location so the log is always useful.
 */
export function describeUncaughtError(event: UncaughtErrorLike): unknown {
  if (event.error !== undefined && event.error !== null) return event.error;
  const message = event.message?.trim() ?? '';
  if (message === '') return 'Unknown error (the browser gave no error object or message)';
  if (!event.filename) return message;
  return `${message} (${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0})`;
}
