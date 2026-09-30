/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Exact rendered-range conversion for frozen Feedback sessions.
 * Native and ProseMirror selections are converted to canonical, block-relative
 * half-open offsets. Resolution validates the same visible text and never
 * searches for, clamps, or guesses a target.
 */

import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import type { FeedbackRenderedRangeInputV1 as ProtocolFeedbackRenderedRangeInputV1 } from '../../shared/feedbackProtocol';

/** Webview-produced range before the host enriches it with block hashes. */
export type FeedbackRenderedRangeInputV1 = ProtocolFeedbackRenderedRangeInputV1;

export interface ResolvedFeedbackRenderedRange {
  from: number;
  to: number;
  focus: string;
  range: FeedbackRenderedRangeInputV1;
}

export type FeedbackRenderedTarget =
  | ({ kind: 'inline' } & ResolvedFeedbackRenderedRange)
  | {
      kind: 'block';
      startOrdinal: number;
      endOrdinal: number;
      focus: string;
      reason: 'opaque-node' | 'unmappable-dom' | 'block-selection';
    };

type BlockFallbackReason = Extract<FeedbackRenderedTarget, { kind: 'block' }>['reason'];

interface TopLevelBlockPosition {
  ordinal: number;
  node: ProseMirrorNode;
  contentFrom: number;
  contentTo: number;
}

const topLevelBlockCache = new WeakMap<ProseMirrorNode, readonly TopLevelBlockPosition[]>();

// Keep hover and whole-block target creation responsive well below the shared
// protocol boundary. The sentinel is included in this 64 KiB limit so a huge
// block cannot create a multi-megabyte intermediate Focus value.
const FEEDBACK_WHOLE_BLOCK_FOCUS_MAX_LENGTH = 64 * 1024;
const FEEDBACK_WHOLE_BLOCK_FOCUS_TRUNCATION_SENTINEL = '\n[Focus truncated]';

interface BoundedWholeBlockFocus {
  focus: string;
  truncated: boolean;
}

function topLevelBlocks(doc: ProseMirrorNode): readonly TopLevelBlockPosition[] {
  const cached = topLevelBlockCache.get(doc);
  if (cached) return cached;
  const blocks: TopLevelBlockPosition[] = [];
  doc.forEach((node, offset, ordinal) => {
    const contentFrom = offset + 1;
    blocks.push({
      ordinal,
      node,
      contentFrom,
      contentTo: contentFrom + node.content.size,
    });
  });
  const immutable = Object.freeze(blocks.map(block => Object.freeze(block)));
  topLevelBlockCache.set(doc, immutable);
  return immutable;
}

function isSafePosition(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function compareRelativeEndpoints(
  startOrdinal: number,
  startOffset: number,
  endOrdinal: number,
  endOffset: number
): number {
  return startOrdinal - endOrdinal || startOffset - endOffset;
}

/**
 * Converts an absolute half-open ProseMirror range to canonical top-level
 * block-relative offsets. Structural positions at block edges are removed so
 * the first and final blocks both contain selected rendered content.
 */
export function blockRelativeRangeFromPositions(
  doc: ProseMirrorNode,
  from: number,
  to: number
): FeedbackRenderedRangeInputV1 | null {
  if (!isSafePosition(from) || !isSafePosition(to) || from >= to || to > doc.content.size) {
    return null;
  }

  const blocks = topLevelBlocks(doc);
  let startOrdinal = rootOrdinalAtPosition(doc, from, 'start');
  let endOrdinal = rootOrdinalAtPosition(doc, to, 'end');
  while (startOrdinal !== null && startOrdinal < blocks.length) {
    const block = blocks[startOrdinal];
    if (block.contentTo > block.contentFrom && to > block.contentFrom && from < block.contentTo) {
      break;
    }
    startOrdinal += 1;
  }
  while (endOrdinal !== null && endOrdinal >= 0) {
    const block = blocks[endOrdinal];
    if (block.contentTo > block.contentFrom && to > block.contentFrom && from < block.contentTo) {
      break;
    }
    endOrdinal -= 1;
  }
  const first = startOrdinal === null ? undefined : blocks[startOrdinal];
  const last = endOrdinal === null ? undefined : blocks[endOrdinal];
  if (!first || !last) return null;

  const normalizedFrom = Math.max(from, first.contentFrom);
  const normalizedTo = Math.min(to, last.contentTo);
  const startOffset = normalizedFrom - first.contentFrom;
  const endOffset = normalizedTo - last.contentFrom;
  if (
    compareRelativeEndpoints(first.ordinal, startOffset, last.ordinal, endOffset) >= 0 ||
    (first.ordinal !== last.ordinal && (startOffset >= first.node.content.size || endOffset <= 0))
  ) {
    return null;
  }

  return {
    version: 1,
    startOrdinal: first.ordinal,
    startOffset,
    endOrdinal: last.ordinal,
    endOffset,
  };
}

function rootOrdinalAtPosition(
  doc: ProseMirrorNode,
  position: number,
  endpoint: 'start' | 'end'
): number | null {
  try {
    const resolved = doc.resolve(position);
    if (resolved.depth > 0) return resolved.index(0);
    const rootIndex = resolved.index(0);
    const ordinal = endpoint === 'end' ? rootIndex - 1 : rootIndex;
    return ordinal >= 0 && ordinal < doc.childCount ? ordinal : null;
  } catch {
    return null;
  }
}

function normalizedVisibleText(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function focusWithTruncationSentinel(value: string, maximumLength: number): string {
  const prefixLength = Math.max(
    0,
    maximumLength - FEEDBACK_WHOLE_BLOCK_FOCUS_TRUNCATION_SENTINEL.length
  );
  return `${value.slice(0, prefixLength)}${FEEDBACK_WHOLE_BLOCK_FOCUS_TRUNCATION_SENTINEL}`;
}

function boundedWholeBlockFocus(
  value: string,
  maximumLength = FEEDBACK_WHOLE_BLOCK_FOCUS_MAX_LENGTH,
  forceTruncation = false
): BoundedWholeBlockFocus {
  if (!forceTruncation && value.length <= maximumLength) {
    return { focus: value, truncated: false };
  }
  return {
    focus: focusWithTruncationSentinel(value, maximumLength),
    truncated: true,
  };
}

function domRangeForPositions(editor: Editor, from: number, to: number): Range | null {
  try {
    const start = editor.view.domAtPos(from);
    const end = editor.view.domAtPos(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  } catch {
    return null;
  }
}

function absolutePositionsForRange(
  doc: ProseMirrorNode,
  range: FeedbackRenderedRangeInputV1
): { from: number; to: number } | null {
  if (
    range.version !== 1 ||
    !isSafePosition(range.startOrdinal) ||
    !isSafePosition(range.endOrdinal) ||
    !isSafePosition(range.startOffset) ||
    !isSafePosition(range.endOffset) ||
    compareRelativeEndpoints(
      range.startOrdinal,
      range.startOffset,
      range.endOrdinal,
      range.endOffset
    ) >= 0
  ) {
    return null;
  }

  const blocks = topLevelBlocks(doc);
  const start = blocks[range.startOrdinal];
  const end = blocks[range.endOrdinal];
  if (
    !start ||
    !end ||
    range.startOffset > start.node.content.size ||
    range.endOffset > end.node.content.size ||
    (start.ordinal !== end.ordinal &&
      (range.startOffset >= start.node.content.size || range.endOffset <= 0))
  ) {
    return null;
  }

  const from = start.contentFrom + range.startOffset;
  const to = end.contentFrom + range.endOffset;
  if (from >= to || to > doc.content.size) return null;

  // Re-encoding is an inexpensive canonicality check. It rejects endpoints
  // that point only at ProseMirror's structural block boundary positions.
  const canonical = blockRelativeRangeFromPositions(doc, from, to);
  if (
    !canonical ||
    canonical.startOrdinal !== range.startOrdinal ||
    canonical.startOffset !== range.startOffset ||
    canonical.endOrdinal !== range.endOrdinal ||
    canonical.endOffset !== range.endOffset
  ) {
    return null;
  }
  return { from, to };
}

/**
 * Resolves persisted block-relative offsets against the current frozen editor.
 * If `expectedFocus` is supplied, it must exactly match the reconstructed DOM
 * Range text after CRLF normalization. A mismatch returns null without search.
 */
export function resolveFeedbackRenderedRange(
  editor: Editor,
  range: FeedbackRenderedRangeInputV1,
  expectedFocus?: string
): ResolvedFeedbackRenderedRange | null {
  const positions = absolutePositionsForRange(editor.state.doc, range);
  if (!positions) return null;
  const domRange = domRangeForPositions(editor, positions.from, positions.to);
  if (!domRange) return null;

  const focus = normalizedVisibleText(domRange.toString());
  if (focus.length === 0) return null;
  if (expectedFocus !== undefined && normalizedVisibleText(expectedFocus) !== focus) {
    return null;
  }
  return { ...positions, focus, range: { ...range } };
}

interface TopLevelDomIndex {
  root: HTMLElement;
  ordinalsByElement: WeakMap<HTMLElement, number>;
  elementsByOrdinal: Array<HTMLElement | null>;
}

const topLevelDomCache = new WeakMap<ProseMirrorNode, TopLevelDomIndex>();

function isProseMirrorWidget(element: HTMLElement): boolean {
  return (
    element.classList.contains('ProseMirror-widget') ||
    element.classList.contains('ProseMirror-gapcursor')
  );
}

function createTopLevelDomIndex(editor: Editor): TopLevelDomIndex {
  const doc = editor.state.doc;
  const root = editor.view.dom as HTMLElement;
  const ordinalsByElement = new WeakMap<HTMLElement, number>();
  const elementsByOrdinal: Array<HTMLElement | null> = [];
  const directBlocks = Array.from(root.children).filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && !isProseMirrorWidget(element)
  );
  const expectedBlockCount = Number.isSafeInteger(doc.childCount) ? doc.childCount : undefined;

  const remember = (ordinal: number, nodeDom: Node | null): void => {
    const element = nodeDom instanceof HTMLElement ? nodeDom : null;
    if (!element || element.parentElement !== root) return;
    ordinalsByElement.set(element, ordinal);
    elementsByOrdinal[ordinal] = element;
  };

  if (expectedBlockCount === undefined || directBlocks.length === expectedBlockCount) {
    directBlocks.forEach((element, ordinal) => remember(ordinal, element));
  } else if (typeof editor.view.nodeDOM === 'function') {
    try {
      doc.forEach((_node, offset, ordinal) => remember(ordinal, editor.view.nodeDOM(offset)));
    } catch {
      // Ambiguous custom DOM without a stable position map stays unmapped. A
      // caller can then omit exact targeting instead of borrowing a neighbour.
    }
  }

  const index = { root, ordinalsByElement, elementsByOrdinal };
  topLevelDomCache.set(doc, index);
  return index;
}

function topLevelDomIndex(editor: Editor, forceRefresh = false): TopLevelDomIndex {
  const cached = topLevelDomCache.get(editor.state.doc);
  if (!forceRefresh && cached?.root === editor.view.dom) return cached;
  return createTopLevelDomIndex(editor);
}

function directChildElement(root: HTMLElement, node: Node | null): HTMLElement | null {
  let current = node instanceof HTMLElement ? node : node?.parentElement;
  while (current && current.parentElement !== root) {
    current = current.parentElement;
  }
  return current?.parentElement === root ? current : null;
}

/** Resolve a DOM endpoint through canonical document blocks, excluding direct widgets. */
export function feedbackTopLevelOrdinalForDomNode(
  editor: Editor,
  node: Node | null
): number | null {
  const root = editor.view.dom as HTMLElement;
  const element = directChildElement(root, node);
  if (!element) return null;
  let index = topLevelDomIndex(editor);
  let ordinal = index.ordinalsByElement.get(element);
  if (ordinal === undefined && element.parentElement === root && !isProseMirrorWidget(element)) {
    index = topLevelDomIndex(editor, true);
    ordinal = index.ordinalsByElement.get(element);
  }
  return ordinal ?? null;
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function domOrdinalsForRange(editor: Editor, range: Range): number[] {
  const root = editor.view.dom as HTMLElement;
  const index = topLevelDomIndex(editor);
  const ordinalForEndpoint = (
    container: Node,
    offset: number,
    endpoint: 'start' | 'end'
  ): number | null => {
    const nestedOrdinal = feedbackTopLevelOrdinalForDomNode(editor, container);
    if (nestedOrdinal !== null) return nestedOrdinal;
    if (container !== root || root.childNodes.length === 0) return null;
    const step = endpoint === 'end' ? -1 : 1;
    let childIndex = endpoint === 'end' ? offset - 1 : offset;
    while (childIndex >= 0 && childIndex < root.childNodes.length) {
      const child = root.childNodes.item(childIndex);
      const element = child instanceof HTMLElement ? child : null;
      const ordinal = element ? index.ordinalsByElement.get(element) : undefined;
      if (ordinal !== undefined) return ordinal;
      childIndex += step;
    }
    return null;
  };

  const start = ordinalForEndpoint(range.startContainer, range.startOffset, 'start');
  const end = ordinalForEndpoint(range.endContainer, range.endOffset, 'end');
  if (start === null || end === null) return [];
  const first = Math.min(start, end);
  const last = Math.max(start, end);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function hasOpaqueContent(
  editor: Editor,
  ordinals: readonly number[],
  nativeRange?: Range
): boolean {
  const root = editor.view.dom as HTMLElement;
  let index = topLevelDomIndex(editor);
  return ordinals.some(ordinal => {
    const node = editor.state.doc.maybeChild(ordinal);
    if (!node || node.isAtom || (node.isLeaf && !node.isText)) return true;
    let block = index.elementsByOrdinal[ordinal];
    if (!block || block.parentElement !== root) {
      index = topLevelDomIndex(editor, true);
      block = index.elementsByOrdinal[ordinal];
    }
    if (!(block instanceof HTMLElement)) return true;
    if (block.getAttribute('contenteditable') === 'false') return true;
    if (!nativeRange) return false;
    return Array.from(block.querySelectorAll('[contenteditable="false"]')).some(element =>
      rangeIntersectsNode(nativeRange, element)
    );
  });
}

function pmRangeContainsOpaqueNode(doc: ProseMirrorNode, from: number, to: number): boolean {
  let opaque = false;
  doc.nodesBetween(from, to, node => {
    if (node.isText || node.type.name === 'hardBreak') return false;
    if (
      node.isAtom ||
      (node.isLeaf && !node.isText) ||
      node.type.name === 'mermaid' ||
      node.type.name === 'mathBlock' ||
      node.type.name === 'inlineMath' ||
      node.type.name === 'image'
    ) {
      opaque = true;
      return false;
    }
    return !opaque;
  });
  return opaque;
}

function blockFallback(
  editor: Editor,
  ordinals: readonly number[],
  focus: string,
  reason: BlockFallbackReason
): FeedbackRenderedTarget | null {
  const valid = ordinals.filter(ordinal => Boolean(editor.state.doc.maybeChild(ordinal)));
  if (valid.length === 0) return null;
  const boundedFocus = boundedWholeBlockFocus(normalizedVisibleText(focus));
  return {
    kind: 'block',
    startOrdinal: Math.min(...valid),
    endOrdinal: Math.max(...valid),
    focus: boundedFocus.focus,
    reason,
  };
}

const FEEDBACK_CHROME_SELECTOR = [
  '[contenteditable="false"]',
  '[aria-hidden="true"]',
  'button',
  'input',
  'select',
  'textarea',
  '.code-block-copy-tooltip',
].join(',');

function semanticLabelForNode(node: ProseMirrorNode): string | undefined {
  return ['alt', 'label', 'title', 'src', 'latex']
    .map(attribute => node.attrs[attribute])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function chromeFreeRenderedText(block: HTMLElement): string {
  const clone = block.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(FEEDBACK_CHROME_SELECTOR).forEach(element => element.remove());
  return typeof clone.innerText === 'string' ? clone.innerText : (clone.textContent ?? '');
}

function focusForTopLevelBlock(
  node: ProseMirrorNode,
  renderedBlock: HTMLElement | null,
  maximumLength = FEEDBACK_WHOLE_BLOCK_FOCUS_MAX_LENGTH
): BoundedWholeBlockFocus {
  if (!node.isAtom && node.content.size > 0) {
    // Bound the ProseMirror walk itself. Calling textBetween across the full
    // node would first materialize an invalid multi-megabyte string and only
    // then give the caller a chance to reject it.
    const traversalEnd = Math.min(node.content.size, maximumLength);
    const semanticText = node.textBetween(0, traversalEnd, '\n', '\n');
    const bounded = boundedWholeBlockFocus(
      semanticText,
      maximumLength,
      traversalEnd < node.content.size
    );
    if (semanticText.trim().length > 0 || bounded.truncated) return bounded;
  }

  const semanticLabel = semanticLabelForNode(node);
  if (semanticLabel !== undefined) return boundedWholeBlockFocus(semanticLabel, maximumLength);

  if (renderedBlock) {
    const renderedText = chromeFreeRenderedText(renderedBlock);
    if (renderedText.trim().length > 0) {
      return boundedWholeBlockFocus(renderedText, maximumLength);
    }
  }
  return boundedWholeBlockFocus(`[${node.type.name}]`, maximumLength);
}

/**
 * Return Focus for one already-indexed top-level block without traversing the
 * document. The caller supplies the canonical mapped DOM element so direct
 * ProseMirror widgets cannot shift opaque-node rendering to a neighbour.
 * Focus is capped at 64 KiB with an explicit truncation sentinel.
 */
export function feedbackFocusForMappedBlock(
  editor: Editor,
  ordinal: number,
  element: HTMLElement | null
): string {
  const node = editor.state.doc.maybeChild(ordinal);
  if (!node) return '';
  const root = editor.view.dom as HTMLElement;
  const renderedBlock = element?.parentElement === root ? element : null;
  return focusForTopLevelBlock(node, renderedBlock).focus;
}

/**
 * Returns the visible semantic Focus for a top-level block range without
 * leaking transient NodeView controls such as copy buttons or status labels.
 * ProseMirror content is authoritative for editable nodes so code indentation
 * and hard breaks are preserved. Opaque nodes use semantic attributes before a
 * chrome-stripped rendered fallback. Aggregate Focus is capped at 64 KiB with
 * an explicit truncation sentinel.
 */
export function feedbackFocusForBlockRange(
  editor: Editor,
  startOrdinal: number,
  endOrdinal: number
): string {
  const root = editor.view.dom as HTMLElement;
  const blocks = topLevelBlocks(editor.state.doc);
  let domIndex = topLevelDomIndex(editor);
  const ordinals = Array.from(
    { length: Math.max(0, endOrdinal - startOrdinal + 1) },
    (_, index) => startOrdinal + index
  );
  let focus = '';
  let hasIncludedBlock = false;
  for (const ordinal of ordinals) {
    const blockPosition = blocks[ordinal];
    const node = blockPosition?.node;
    if (!node) continue;

    // Reuse the canonical widget-filtered map. If custom DOM is ambiguous
    // and nodeDOM is unavailable, omit rendered text instead of borrowing a
    // neighbouring block's content.
    let renderedBlock = domIndex.elementsByOrdinal[ordinal];
    if (!renderedBlock || renderedBlock.parentElement !== root) {
      domIndex = topLevelDomIndex(editor, true);
      renderedBlock = domIndex.elementsByOrdinal[ordinal];
    }

    const separatorLength = hasIncludedBlock ? 1 : 0;
    const remainingLength = FEEDBACK_WHOLE_BLOCK_FOCUS_MAX_LENGTH - focus.length - separatorLength;
    if (remainingLength <= FEEDBACK_WHOLE_BLOCK_FOCUS_TRUNCATION_SENTINEL.length) {
      return focusWithTruncationSentinel(focus, FEEDBACK_WHOLE_BLOCK_FOCUS_MAX_LENGTH);
    }

    const blockFocus = focusForTopLevelBlock(node, renderedBlock, remainingLength);
    if (blockFocus.focus.length === 0) continue;
    if (hasIncludedBlock) focus += '\n';
    focus += blockFocus.focus;
    hasIncludedBlock = true;
    if (blockFocus.truncated) return focus;
  }
  return focus;
}

/** Convert one ordered native DOM Range into an exact or honest block target. */
export function getFeedbackTargetFromDomRange(
  editor: Editor,
  nativeRange: Range
): FeedbackRenderedTarget | null {
  const root = editor.view.dom as HTMLElement;
  if (
    nativeRange.collapsed ||
    !root.contains(nativeRange.startContainer) ||
    !root.contains(nativeRange.endContainer)
  ) {
    return null;
  }

  const ordinals = domOrdinalsForRange(editor, nativeRange);
  const nativeFocus = normalizedVisibleText(nativeRange.toString());
  if (hasOpaqueContent(editor, ordinals, nativeRange)) {
    return blockFallback(editor, ordinals, nativeFocus, 'opaque-node');
  }

  let from: number;
  let to: number;
  try {
    from = editor.view.posAtDOM(nativeRange.startContainer, nativeRange.startOffset, 1);
    to = editor.view.posAtDOM(nativeRange.endContainer, nativeRange.endOffset, -1);
  } catch {
    return blockFallback(editor, ordinals, nativeFocus, 'unmappable-dom');
  }

  if (pmRangeContainsOpaqueNode(editor.state.doc, from, to)) {
    return blockFallback(editor, ordinals, nativeFocus, 'opaque-node');
  }

  const relative = blockRelativeRangeFromPositions(editor.state.doc, from, to);
  if (!relative) return blockFallback(editor, ordinals, nativeFocus, 'unmappable-dom');
  const resolved = resolveFeedbackRenderedRange(editor, relative, nativeFocus);
  if (!resolved) return blockFallback(editor, ordinals, nativeFocus, 'unmappable-dom');
  return { kind: 'inline', ...resolved };
}

function pmOrdinalsForRange(doc: ProseMirrorNode, from: number, to: number): number[] {
  const start = rootOrdinalAtPosition(doc, from, 'start');
  const end = rootOrdinalAtPosition(doc, to, 'end');
  if (start === null || end === null) return [];
  const first = Math.min(start, end);
  const last = Math.max(start, end);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/** Convert the editor's current non-empty ProseMirror selection. */
export function getFeedbackTargetFromProseMirrorSelection(
  editor: Editor
): FeedbackRenderedTarget | null {
  const { selection, doc } = editor.state;
  if (selection.empty || selection.from >= selection.to) return null;
  const ordinals = pmOrdinalsForRange(doc, selection.from, selection.to);
  const focus = feedbackFocusForBlockRange(editor, Math.min(...ordinals), Math.max(...ordinals));

  if (
    hasOpaqueContent(editor, ordinals) ||
    pmRangeContainsOpaqueNode(doc, selection.from, selection.to)
  ) {
    return blockFallback(editor, ordinals, focus, 'opaque-node');
  }
  if (selection instanceof NodeSelection) {
    return blockFallback(editor, ordinals, focus, 'block-selection');
  }

  const relative = blockRelativeRangeFromPositions(doc, selection.from, selection.to);
  if (!relative) return blockFallback(editor, ordinals, focus, 'block-selection');
  const resolved = resolveFeedbackRenderedRange(editor, relative);
  if (!resolved) return blockFallback(editor, ordinals, focus, 'block-selection');
  return { kind: 'inline', ...resolved };
}
