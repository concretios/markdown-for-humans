/**
 * Copyright (c) 2025-2026 Concret.io
 * Licensed under the MIT License. See LICENSE in the project root.
 * Select canonical token spans by source position and measure deferred viewport
 * bounds. This module performs no lexing, document edits or global DOM queries.
 */
import type { EditorView } from '@tiptap/pm/view';
import type { TokenSpan } from './types';

const VIEWPORT_OVERSCAN_UNITS = 4000;

/**
 * Return complete canonical spans intersecting the half-open relative range.
 * Input spans must already be validated, sorted and non-overlapping. Binary
 * search avoids scanning a long block's invisible prefix; returned objects are
 * shared with the canonical result, and no additional canonical store is made.
 */
export function projectTokenSpans(
  spans: readonly TokenSpan[],
  from: number,
  to: number
): TokenSpan[] {
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from || spans.length === 0) return [];
  let lower = 0;
  let upper = spans.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (spans[middle].to <= from) lower = middle + 1;
    else upper = middle;
  }
  const start = lower;
  while (lower < spans.length && spans[lower].from < to) lower++;
  return spans.slice(start, lower);
}

/**
 * Read absolute document positions around the visible editor plus source-unit
 * overscan. Call only from deferred rendering or scroll/resize work, never from
 * a foreground typing transaction. Browser hit-testing accounts for wrapping,
 * zoom and horizontal scroll; probing all corners also handles text direction.
 * Detached/no-layout environments use a full-document fallback. A connected
 * browser editor with no visible dimensions projects no tokens while hidden.
 */
export function readViewportRange(view: EditorView): { from: number; to: number } {
  const documentSize = view.state.doc.content.size;
  const fullRange = { from: 0, to: documentSize };
  if (documentSize === 0) return fullRange;

  const browser = view.dom.ownerDocument.defaultView;
  if (!browser) return fullRange;
  const rect = view.dom.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    // JSDOM has neither layout nor browser hit testing, even when connected.
    // In a real webview, hidden editor geometry must not expand into thousands
    // of invisible decorations. Resize observation retries after it is shown.
    const hasBrowserHitTesting = typeof view.dom.ownerDocument.elementFromPoint === 'function';
    return view.dom.isConnected && hasBrowserHitTesting ? { from: 0, to: 0 } : fullRange;
  }
  const left = Math.max(0, rect.left);
  const right = Math.min(browser.innerWidth, rect.right);
  const top = Math.max(0, rect.top);
  const bottom = Math.min(browser.innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return { from: 0, to: 0 };

  // Stay inside hit-testable edges. Small visible slivers use their midpoint.
  const insetX = Math.min(1, (right - left) / 2);
  const insetY = Math.min(1, (bottom - top) / 2);
  const positions: number[] = [];
  try {
    for (const y of [top + insetY, bottom - insetY]) {
      for (const x of [left + insetX, right - insetX]) {
        const hit = view.posAtCoords({ left: x, top: y });
        if (hit && Number.isFinite(hit.pos)) positions.push(hit.pos);
      }
    }
  } catch {
    // Hidden/detached layout can disappear between geometry and hit testing.
    // Keep source visible and let the next deferred viewport read retry.
    return fullRange;
  }
  if (positions.length === 0) return fullRange;
  return {
    from: Math.max(0, Math.min(documentSize, Math.min(...positions) - VIEWPORT_OVERSCAN_UNITS)),
    to: Math.max(0, Math.min(documentSize, Math.max(...positions) + VIEWPORT_OVERSCAN_UNITS)),
  };
}
