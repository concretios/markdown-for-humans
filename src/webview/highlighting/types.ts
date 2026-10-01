/**
 * Copyright (c) 2025-2026 Concret.io
 * Licensed under the MIT License. See LICENSE in the project root.
 * Shared, grammar-free worker contracts and resource limits for code highlighting.
 */

import { SUPPORTED_GRAMMARS } from './languageRegistry';

export interface TokenSpan {
  from: number;
  to: number;
  classes: string;
}
export interface HighlightResult {
  spans: TokenSpan[];
  reason?: string;
}
export interface HighlightService {
  highlight(language: string, source: string): Promise<HighlightResult>;
  dispose(): void;
}
export const HIGHLIGHT_LIMITS = Object.freeze({
  sourceUnits: 1_048_576,
  resultRanges: 100_000,
  resultBytes: 4 * 1024 * 1024,
  cacheEntries: 128,
  cacheBytes: 8 * 1024 * 1024,
  cacheRanges: 100_000,
  failureEntries: 256,
  timeoutMs: 2000,
  validationChunkRanges: 1000,
  validationSliceMs: 4,
});
export const HIGHLIGHT_REQUEST = 'md4h.highlight.request';
export const HIGHLIGHT_RESPONSE = 'md4h.highlight.result';
export interface HighlightRequest {
  type: typeof HIGHLIGHT_REQUEST;
  version: 1;
  session: string;
  requestId: number;
  grammar: string;
  source: string;
}
export interface HighlightResponse {
  type: typeof HIGHLIGHT_RESPONSE;
  version: 1;
  session: string;
  requestId: number;
  grammar: string;
  sourceLength: number;
  result: HighlightResult;
}

/** Accept only highlight.js token namespaces and its nested-scope suffix classes. */
export function approvedTokenClasses(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false;
  const classes = value.split(' ');
  return (
    classes.length <= 8 &&
    classes.every(
      name =>
        /^(?:hljs-[a-z][a-z0-9_-]{0,40}|language-[a-z][a-z0-9_-]{0,40}|[a-z][a-z0-9_]{0,24}_)$/.test(
          name
        ) ||
        SUPPORTED_GRAMMARS.includes(name) ||
        name === 'html'
    )
  );
}

/** Serialized token properties are ASCII, so character count is its UTF-8 byte count. */
export function serializedSpanBytes(span: TokenSpan): number {
  return JSON.stringify(span).length + 1;
}

export interface HighlightResultValidation {
  readonly result: HighlightResult;
  /** Visit at most maxSpans, checking the optional deadline every 64 spans. */
  advance(
    maxSpans: number,
    onSpan?: (span: TokenSpan) => void,
    deadline?: number
  ): 'pending' | 'valid' | 'invalid';
}

/** Start strict result validation without traversing the potentially large span array. */
export function createHighlightResultValidation(
  value: unknown,
  source: string
): HighlightResultValidation | null {
  if (!value || typeof value !== 'object') return null;
  if (Object.keys(value).some(key => key !== 'spans' && key !== 'reason')) return null;
  const candidate = value as Partial<HighlightResult>;
  if (!Array.isArray(candidate.spans) || candidate.spans.length > HIGHLIGHT_LIMITS.resultRanges)
    return null;
  if (
    candidate.reason !== undefined &&
    (typeof candidate.reason !== 'string' ||
      !/^[a-z-]{1,48}$/.test(candidate.reason) ||
      candidate.spans.length !== 0)
  )
    return null;
  const spans = candidate.spans;
  const count = spans.length;
  let next = 0;
  let previousEnd = 0;
  let bytes = 80;
  let invalid = false;
  const classNames = new Set<string>();
  const splitsSurrogatePair = (position: number): boolean => {
    if (position <= 0 || position >= source.length) return false;
    const before = source.charCodeAt(position - 1);
    const after = source.charCodeAt(position);
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  };
  return {
    result: candidate as HighlightResult,
    advance(maxSpans, onSpan, deadline) {
      if (invalid || candidate.spans !== spans || spans.length !== count) return 'invalid';
      let processed = 0;
      while (next < count && processed < maxSpans) {
        if (
          deadline !== undefined &&
          processed > 0 &&
          processed % 64 === 0 &&
          performance.now() >= deadline
        )
          break;
        const item = spans[next];
        if (!item || typeof item !== 'object') {
          invalid = true;
          return 'invalid';
        }
        const keys = Object.keys(item);
        if (
          keys.length !== 3 ||
          keys.some(key => key !== 'from' && key !== 'to' && key !== 'classes') ||
          !Number.isSafeInteger(item.from) ||
          !Number.isSafeInteger(item.to) ||
          item.from < previousEnd ||
          item.to <= item.from ||
          item.to > source.length
        ) {
          invalid = true;
          return 'invalid';
        }
        if (!classNames.has(item.classes)) {
          if (!approvedTokenClasses(item.classes)) {
            invalid = true;
            return 'invalid';
          }
          // Keep validation acceleration bounded even for an adversarial variety
          // of otherwise legal class combinations.
          if (classNames.size < 256) classNames.add(item.classes);
        }
        if (splitsSurrogatePair(item.from) || splitsSurrogatePair(item.to)) {
          invalid = true;
          return 'invalid';
        }
        previousEnd = item.to;
        bytes += serializedSpanBytes(item);
        if (bytes > HIGHLIGHT_LIMITS.resultBytes) {
          invalid = true;
          return 'invalid';
        }
        onSpan?.(item);
        next++;
        processed++;
      }
      return next === count ? 'valid' : 'pending';
    },
  };
}

/** Synchronous validation for worker-side callers; the client uses bounded advances. */
export function validHighlightResult(value: unknown, source: string): value is HighlightResult {
  const validation = createHighlightResultValidation(value, source);
  return validation !== null && validation.advance(HIGHLIGHT_LIMITS.resultRanges) === 'valid';
}

/** Explain a plain-text fallback without exposing worker implementation details. */
export function explainHighlightFailure(reason: string): string {
  switch (reason) {
    case 'plain':
    case 'disposed':
      return '';
    case 'source-limit':
      return 'This code block is too large to highlight. Its text remains editable.';
    case 'range-limit':
    case 'result-limit':
      return 'This code block has too many tokens to highlight. Its text remains editable.';
    case 'worker-timeout':
      return 'Highlighting took too long. The code remains editable.';
    case 'busy':
      return 'Highlighting is waiting for another code block.';
    default:
      return 'Highlighting is unavailable for this code block. Its text remains editable.';
  }
}
