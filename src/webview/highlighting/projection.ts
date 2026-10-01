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

/** Absolute document range to project, plus its visible part before overscan. */
export interface ViewportRange {
  from: number;
  to: number;
  /** Visible positions before overscan. Absent for the full-document fallback. */
  visible?: readonly [number, number];
}

const OVERLAY_PROBE_STEP_PX = 24;

/**
 * Move an edge probe inward until it reaches editor content. Sticky toolbars and
 * floating panels cover the editor edges; ProseMirror maps a covered point to a
 * nearby block boundary, which pinned long-block windows to the block start.
 */
function uncoveredY(view: EditorView, x: number, from: number, to: number): number {
  const owner = view.dom.ownerDocument;
  if (typeof owner.elementFromPoint !== 'function') return from;
  const step = to >= from ? OVERLAY_PROBE_STEP_PX : -OVERLAY_PROBE_STEP_PX;
  for (let y = from; step > 0 ? y <= to : y >= to; y += step) {
    const element = owner.elementFromPoint(x, y);
    if (element && view.dom.contains(element)) return y;
  }
  return from;
}

/**
 * Read absolute document positions around the visible editor plus source-unit
 * overscan. Call only from deferred rendering or scroll/resize work, never from
 * a foreground typing transaction. Browser hit-testing accounts for wrapping,
 * zoom and horizontal scroll; probing all corners also handles text direction.
 * Edge probes skip overlays such as the sticky formatting toolbar.
 * Detached/no-layout environments use a full-document fallback. A connected
 * browser editor with no visible dimensions projects no tokens while hidden.
 */
export function readViewportRange(view: EditorView): ViewportRange {
  const documentSize = view.state.doc.content.size;
  const fullRange = { from: 0, to: documentSize };
  const hidden: ViewportRange = { from: 0, to: 0, visible: [0, 0] };
  if (documentSize === 0) return fullRange;

  const browser = view.dom.ownerDocument.defaultView;
  if (!browser) return fullRange;
  const rect = view.dom.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    // JSDOM has neither layout nor browser hit testing, even when connected.
    // In a real webview, hidden editor geometry must not expand into thousands
    // of invisible decorations. Resize observation retries after it is shown.
    const hasBrowserHitTesting = typeof view.dom.ownerDocument.elementFromPoint === 'function';
    return view.dom.isConnected && hasBrowserHitTesting ? hidden : fullRange;
  }
  const left = Math.max(0, rect.left);
  const right = Math.min(browser.innerWidth, rect.right);
  const top = Math.max(0, rect.top);
  const bottom = Math.min(browser.innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return hidden;

  // Stay inside hit-testable edges. Small visible slivers use their midpoint.
  const insetX = Math.min(1, (right - left) / 2);
  const insetY = Math.min(1, (bottom - top) / 2);
  const centerX = (left + right) / 2;
  const firstY = uncoveredY(view, centerX, top + insetY, bottom - insetY);
  const lastY = uncoveredY(view, centerX, bottom - insetY, firstY);
  const positions: number[] = [];
  try {
    for (const y of [firstY, lastY]) {
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
  const first = Math.min(...positions);
  const last = Math.max(...positions);
  return {
    from: Math.max(0, Math.min(documentSize, first - VIEWPORT_OVERSCAN_UNITS)),
    to: Math.max(0, Math.min(documentSize, last + VIEWPORT_OVERSCAN_UNITS)),
    visible: [first, last],
  };
}
