/**
 * Copyright (c) 2025-2026 Concret.io
 * Licensed under the MIT License. See LICENSE in the project root.
 * Self-contained worker entry: one bounded explicit-grammar job per message.
 */
import { tokenizeCode } from './tokenize';
import {
  HIGHLIGHT_REQUEST,
  HIGHLIGHT_RESPONSE,
  type HighlightRequest,
  type HighlightResponse,
} from './types';

/** Validate a request and return only correlated spans, without echoing its source. */
export function processHighlightRequest(value: unknown): HighlightResponse | null {
  if (!value || typeof value !== 'object') return null;
  const request = value as Partial<HighlightRequest>;
  if (
    request.type !== HIGHLIGHT_REQUEST ||
    request.version !== 1 ||
    typeof request.session !== 'string' ||
    request.session.length > 100 ||
    !Number.isSafeInteger(request.requestId) ||
    (request.requestId ?? -1) < 0 ||
    typeof request.grammar !== 'string' ||
    request.grammar.length > 64 ||
    typeof request.source !== 'string'
  )
    return null;
  return {
    type: HIGHLIGHT_RESPONSE,
    version: 1,
    session: request.session,
    requestId: request.requestId as number,
    grammar: request.grammar,
    sourceLength: request.source.length,
    result: tokenizeCode(request.grammar, request.source),
  };
}

// The guard also lets Node tests import the pure protocol handler. A webview
// window must never attach this worker handler to its own message boundary.
const scope = globalThis as unknown as {
  document?: unknown;
  postMessage?: (value: HighlightResponse) => void;
  onmessage?: (event: { data: unknown }) => void;
};
if (scope.document === undefined && typeof scope.postMessage === 'function') {
  scope.onmessage = event => {
    const response = processHighlightRequest(event.data);
    if (response) scope.postMessage?.(response);
  };
}
