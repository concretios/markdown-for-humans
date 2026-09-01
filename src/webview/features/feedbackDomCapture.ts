/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview DOM rasterization adapter for Feedback screenshots. It builds
 * a temporary, viewport-sized stage containing only intersecting top-level
 * blocks. Large tables and nested lists are reduced to geometry-preserving
 * row, cell, and item slices before cloning or resource inspection. The
 * adapter then waits for asynchronous Mermaid/resource lifecycle and delegates
 * PNG generation to modern-screenshot. Abort checkpoints and fixed node and
 * resource ceilings keep teardown and work bounded on constrained hosts.
 */

import type { Options as ModernScreenshotOptions } from 'modern-screenshot';
import {
  FeedbackCaptureError,
  rectanglesIntersect,
  throwIfFeedbackCaptureAborted,
  type CaptureRectangle,
  type DomRasterizer,
} from './feedbackCapture';

export type ModernScreenshotFunction = (
  node: Node,
  options?: ModernScreenshotOptions
) => Promise<string>;

const MAX_PIXELS = 12_000_000;
const MAX_DATA_URL_LENGTH = 14 * 1024 * 1024;
const MAX_CAPTURE_CLONE_NODES = 4_096;
const MAX_CAPTURE_RESOURCE_REFERENCES = 1_024;
const RESOURCE_TIMEOUT_MS = 5_000;
const MERMAID_WRAPPER_SELECTOR = '.mermaid-wrapper';
const MERMAID_RENDER_STATE_ATTRIBUTE = 'data-md4h-mermaid-state';
const CAPTURE_CHROME_SELECTOR = [
  '.feedback-annotation-layer',
  '.feedback-marker-layer',
  '.feedback-card-layer',
  '.feedback-connectors',
  '.feedback-annotation-spacer',
  '.feedback-selection-action',
  '.feedback-block-action',
  '.feedback-block-target-preview',
  '.feedback-comment-rail',
  '.feedback-frame-label',
  '.feedback-invalidated-alert',
  '.feedback-live-region',
  '.drag-block-handle',
  '.image-hover-overlay',
  '.image-menu-button',
  '.image-context-menu',
  '.image-metadata-footer',
  '.table-menu',
  '.column-resize-handle',
  '.code-block-copy-button',
  '.mermaid-tooltip',
  '.md4h-math-block-tooltip',
  '.ProseMirror-gapcursor',
].join(', ');
const TRANSIENT_CAPTURE_CLASSES = [
  'ProseMirror-selectednode',
  'highlighted',
  'image-caret-before',
  'image-caret-after',
  'image-caret-selected',
  'image-pending-delete',
  'search-match',
  'search-match-active',
  'validation-error-highlight',
  'feedback-pending-target',
  'feedback-active-target',
  'feedback-review-surface',
  'md4h-feedback-annotation',
  'md4h-feedback-annotation-inline',
  'md4h-feedback-annotation-node',
  'md4h-feedback-annotation-cell',
  'is-feedback-active',
  'md4h-feedback-highlight',
  'md4h-feedback-highlight-active',
  'md4h-feedback-block-target',
  'md4h-feedback-block-target-active',
] as const;
const TRANSIENT_CAPTURE_ATTRIBUTES = ['data-feedback-ids', 'data-feedback-active-ids'] as const;
let defaultScreenshotPromise: Promise<ModernScreenshotFunction> | null = null;

function loadDefaultScreenshot(): Promise<ModernScreenshotFunction> {
  defaultScreenshotPromise ??= import('modern-screenshot').then(module => module.domToPng);
  return defaultScreenshotPromise;
}

function domRectangle(rectangle: DOMRect): CaptureRectangle {
  return {
    left: rectangle.left,
    top: rectangle.top,
    width: rectangle.width,
    height: rectangle.height,
  };
}

function isAllowedResourceUrl(value: string): boolean {
  if (!value || value.startsWith('data:') || value.startsWith('blob:')) return true;
  try {
    const url = new URL(value, window.location.href);
    return (
      url.protocol === 'vscode-webview-resource:' ||
      url.hostname.endsWith('.vscode-resource.vscode-cdn.net') ||
      url.hostname === 'file+.vscode-resource.vscode-cdn.net'
    );
  } catch {
    return false;
  }
}

function captureComplexityError(limit: string): FeedbackCaptureError {
  return new FeedbackCaptureError(
    'MD4H-FB-CAPTURE-002',
    `The selected area exceeds the ${limit} feedback capture limit. Select a smaller area.`
  );
}

function appendResourceUrl(urls: string[], value: string): void {
  if (urls.length >= MAX_CAPTURE_RESOURCE_REFERENCES) {
    throw captureComplexityError(
      `${MAX_CAPTURE_RESOURCE_REFERENCES.toLocaleString()} resource-reference`
    );
  }
  urls.push(value);
}

function resourceUrls(root: HTMLElement, signal?: AbortSignal): string[] {
  const urls: string[] = [];
  root.querySelectorAll<HTMLImageElement>('img').forEach(image => {
    throwIfFeedbackCaptureAborted(signal);
    appendResourceUrl(urls, image.currentSrc || image.src || image.getAttribute('src') || '');
  });
  root.querySelectorAll<SVGImageElement>('image').forEach(image => {
    throwIfFeedbackCaptureAborted(signal);
    appendResourceUrl(urls, image.getAttribute('href') || image.getAttribute('xlink:href') || '');
  });
  root.querySelectorAll<HTMLElement>('*').forEach(element => {
    throwIfFeedbackCaptureAborted(signal);
    const background = window.getComputedStyle(element).backgroundImage;
    for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      appendResourceUrl(urls, match[1]);
    }
  });
  return urls;
}

/** Fail closed when a rendered block references a non-webview resource. */
export function validateCaptureResources(root: HTMLElement, signal?: AbortSignal): void {
  throwIfFeedbackCaptureAborted(signal);
  const unavailable = resourceUrls(root, signal).find(url => !isAllowedResourceUrl(url));
  if (unavailable) {
    throw new FeedbackCaptureError(
      'MD4H-FB-CAPTURE-001',
      'A rendered image or background is not available through the VS Code webview resource boundary.'
    );
  }
  throwIfFeedbackCaptureAborted(signal);
}

async function withAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfFeedbackCaptureAborted(signal);
  if (!signal) return promise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const abort = (): void => {
      settle(() => {
        try {
          throwIfFeedbackCaptureAborted(signal);
        } catch (error) {
          reject(error);
        }
      });
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => settle(() => resolve(value)),
      error => settle(() => reject(error))
    );
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  signal?: AbortSignal
): Promise<T> {
  throwIfFeedbackCaptureAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const timeout = window.setTimeout(() => {
      settle(() => reject(new FeedbackCaptureError('MD4H-FB-CAPTURE-001', message)));
    }, RESOURCE_TIMEOUT_MS);
    const abort = (): void => {
      settle(() => {
        try {
          throwIfFeedbackCaptureAborted(signal);
        } catch (error) {
          reject(error);
        }
      });
    };
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(
      value => {
        settle(() => resolve(value));
      },
      error => {
        settle(() => reject(error));
      }
    );
  });
}

async function waitForTwoAnimationFrames(signal?: AbortSignal): Promise<void> {
  throwIfFeedbackCaptureAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let firstFrame = 0;
    let secondFrame = 0;
    let settled = false;
    const cleanup = (): void => {
      if (firstFrame) cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
      signal?.removeEventListener('abort', abort);
    };
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const abort = (): void => {
      settle(() => {
        try {
          throwIfFeedbackCaptureAborted(signal);
        } catch (error) {
          reject(error);
        }
      });
    };
    signal?.addEventListener('abort', abort, { once: true });
    firstFrame = requestAnimationFrame(() => {
      if (signal?.aborted) {
        abort();
        return;
      }
      secondFrame = requestAnimationFrame(() => {
        if (signal?.aborted) {
          abort();
          return;
        }
        settle(resolve);
      });
    });
  });
}

async function waitForRenderedResources(root: HTMLElement, signal?: AbortSignal): Promise<void> {
  throwIfFeedbackCaptureAborted(signal);
  if ('fonts' in document && document.fonts?.ready) {
    await withTimeout(
      document.fonts.ready.then(() => undefined),
      'The document fonts did not become ready for capture.',
      signal
    );
  }

  throwIfFeedbackCaptureAborted(signal);
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img'));
  await Promise.all(
    images.map(async image => {
      throwIfFeedbackCaptureAborted(signal);
      if (image.complete && image.naturalWidth > 0) return;
      if (typeof image.decode === 'function') {
        try {
          await withTimeout(
            image.decode(),
            'A rendered image did not become ready for capture.',
            signal
          );
          return;
        } catch (error) {
          throwIfFeedbackCaptureAborted(signal);
          throw new FeedbackCaptureError(
            'MD4H-FB-CAPTURE-001',
            'A rendered image could not be decoded for capture.',
            error
          );
        }
      }
      throw new FeedbackCaptureError(
        'MD4H-FB-CAPTURE-001',
        'A rendered image is not loaded and cannot be captured.'
      );
    })
  );

  throwIfFeedbackCaptureAborted(signal);
  await waitForTwoAnimationFrames(signal);
  throwIfFeedbackCaptureAborted(signal);
}

/** Remove capture-only UI while preserving prose wrapped by decorations. */
function sanitizeCaptureClone(root: HTMLElement, signal?: AbortSignal): void {
  root.querySelectorAll<HTMLElement>(CAPTURE_CHROME_SELECTOR).forEach(node => {
    throwIfFeedbackCaptureAborted(signal);
    node.remove();
  });
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  elements.forEach(element => {
    throwIfFeedbackCaptureAborted(signal);
    element.classList.remove(...TRANSIENT_CAPTURE_CLASSES);
    TRANSIENT_CAPTURE_ATTRIBUTES.forEach(attribute => element.removeAttribute(attribute));
  });
}

type CaptureChildRectangleReader = (element: HTMLElement) => DOMRect;

function cachedCaptureChildRectangleReader(): CaptureChildRectangleReader {
  const rectangles = new Map<HTMLElement, DOMRect>();
  return element => {
    const cached = rectangles.get(element);
    if (cached) return cached;
    const rectangle = element.getBoundingClientRect();
    rectangles.set(element, rectangle);
    return rectangle;
  };
}

/**
 * Finds the normal-flow top-level block immediately before the first block that
 * starts at or below the crop top. Including one predecessor preserves a block
 * that begins above the crop while avoiding a full scan of block bottoms.
 */
function firstPotentialCaptureChild(
  children: readonly HTMLElement[],
  cropTop: number,
  readRectangle: CaptureChildRectangleReader
): number {
  let start = 0;
  let end = children.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    const rectangle = readRectangle(children[middle]);
    if (rectangle.top < cropTop) start = middle + 1;
    else end = middle;
  }
  return Math.max(0, start - 1);
}

/** Find the first normal-flow top-level block starting at or below the crop bottom. */
function firstCaptureChildAfterCrop(
  children: readonly HTMLElement[],
  cropBottom: number,
  readRectangle: CaptureChildRectangleReader
): number {
  let start = 0;
  let end = children.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (readRectangle(children[middle]).top < cropBottom) start = middle + 1;
    else end = middle;
  }
  return start;
}

interface IntersectingCaptureChild {
  element: HTMLElement;
  bounds: DOMRect;
}

function intersectingCaptureChildren(
  root: HTMLElement,
  rectangle: CaptureRectangle,
  signal?: AbortSignal
): IntersectingCaptureChild[] {
  throwIfFeedbackCaptureAborted(signal);
  // Filtering capture chrome does not force layout. Geometry remains bounded
  // even when a long document has thousands of top-level Markdown blocks.
  const children = Array.from(root.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !child.matches(CAPTURE_CHROME_SELECTOR)
  );
  const readRectangle = cachedCaptureChildRectangleReader();
  const candidateStart = firstPotentialCaptureChild(children, rectangle.top, readRectangle);
  const candidateEnd = firstCaptureChildAfterCrop(
    children,
    rectangle.top + rectangle.height,
    readRectangle
  );
  const intersections: IntersectingCaptureChild[] = [];
  for (let index = candidateStart; index < candidateEnd; index += 1) {
    throwIfFeedbackCaptureAborted(signal);
    const element = children[index];
    const bounds = readRectangle(element);
    if (rectanglesIntersect(rectangle, domRectangle(bounds))) {
      intersections.push({ element, bounds });
      if (intersections.length > MAX_CAPTURE_CLONE_NODES) {
        throw captureComplexityError(`${MAX_CAPTURE_CLONE_NODES.toLocaleString()} rendered-node`);
      }
    }
  }
  return intersections;
}

interface IndexedCaptureIntersection<TElement extends HTMLElement> {
  readonly element: TElement;
  readonly bounds: DOMRect;
  readonly index: number;
}

interface CaptureCloneBudget {
  nodeCount: number;
}

function isUsableDomRectangle(rectangle: DOMRect): boolean {
  return (
    Number.isFinite(rectangle.left) &&
    Number.isFinite(rectangle.top) &&
    Number.isFinite(rectangle.width) &&
    Number.isFinite(rectangle.height) &&
    rectangle.width > 0 &&
    rectangle.height > 0
  );
}

function rectangleRight(rectangle: DOMRect): number {
  return rectangle.left + rectangle.width;
}

function rectangleBottom(rectangle: DOMRect): number {
  return rectangle.top + rectangle.height;
}

function firstPotentialHorizontalChild(
  children: readonly HTMLElement[],
  cropLeft: number,
  readRectangle: CaptureChildRectangleReader
): number {
  let start = 0;
  let end = children.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (readRectangle(children[middle]).left < cropLeft) start = middle + 1;
    else end = middle;
  }
  return Math.max(0, start - 1);
}

function firstHorizontalChildAfterCrop(
  children: readonly HTMLElement[],
  cropRight: number,
  readRectangle: CaptureChildRectangleReader
): number {
  let start = 0;
  let end = children.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (readRectangle(children[middle]).left < cropRight) start = middle + 1;
    else end = middle;
  }
  return start;
}

function intersectingVerticalElements<TElement extends HTMLElement>(
  elements: readonly TElement[],
  containerBounds: DOMRect,
  rectangle: CaptureRectangle,
  signal?: AbortSignal
): IndexedCaptureIntersection<TElement>[] | null {
  if (elements.length === 0) return [];
  const readRectangle = cachedCaptureChildRectangleReader();
  const firstBounds = readRectangle(elements[0]);
  const lastBounds = readRectangle(elements[elements.length - 1]);
  if (
    !isUsableDomRectangle(containerBounds) ||
    !isUsableDomRectangle(firstBounds) ||
    !isUsableDomRectangle(lastBounds) ||
    lastBounds.top < firstBounds.top
  ) {
    return null;
  }
  const candidateStart = firstPotentialCaptureChild(elements, rectangle.top, readRectangle);
  const candidateEnd = firstCaptureChildAfterCrop(
    elements,
    rectangle.top + rectangle.height,
    readRectangle
  );
  const intersections: IndexedCaptureIntersection<TElement>[] = [];
  for (let index = candidateStart; index < candidateEnd; index += 1) {
    throwIfFeedbackCaptureAborted(signal);
    const bounds = readRectangle(elements[index]);
    if (!isUsableDomRectangle(bounds)) return null;
    if (rectanglesIntersect(rectangle, domRectangle(bounds))) {
      intersections.push({ element: elements[index], bounds, index });
    }
  }
  return intersections;
}

function intersectingHorizontalElements<TElement extends HTMLElement>(
  elements: readonly TElement[],
  containerBounds: DOMRect,
  rectangle: CaptureRectangle,
  signal?: AbortSignal
): IndexedCaptureIntersection<TElement>[] | null {
  if (elements.length === 0) return [];
  const readRectangle = cachedCaptureChildRectangleReader();
  const firstBounds = readRectangle(elements[0]);
  const lastBounds = readRectangle(elements[elements.length - 1]);
  if (
    !isUsableDomRectangle(containerBounds) ||
    !isUsableDomRectangle(firstBounds) ||
    !isUsableDomRectangle(lastBounds) ||
    lastBounds.left < firstBounds.left
  ) {
    return null;
  }
  const candidateStart = firstPotentialHorizontalChild(elements, rectangle.left, readRectangle);
  const candidateEnd = firstHorizontalChildAfterCrop(
    elements,
    rectangle.left + rectangle.width,
    readRectangle
  );
  const intersections: IndexedCaptureIntersection<TElement>[] = [];
  for (let index = candidateStart; index < candidateEnd; index += 1) {
    throwIfFeedbackCaptureAborted(signal);
    const bounds = readRectangle(elements[index]);
    if (!isUsableDomRectangle(bounds)) return null;
    if (rectanglesIntersect(rectangle, domRectangle(bounds))) {
      intersections.push({ element: elements[index], bounds, index });
    }
  }
  return intersections;
}

function consumeCaptureCloneNode(budget: CaptureCloneBudget): void {
  budget.nodeCount += 1;
  if (budget.nodeCount > MAX_CAPTURE_CLONE_NODES) {
    throw captureComplexityError(`${MAX_CAPTURE_CLONE_NODES.toLocaleString()} rendered-node`);
  }
}

function cloneCaptureNodeShallow<TNode extends Node>(
  source: TNode,
  budget: CaptureCloneBudget
): TNode {
  consumeCaptureCloneNode(budget);
  return source.cloneNode(false) as TNode;
}

function createCaptureElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  budget: CaptureCloneBudget
): HTMLElementTagNameMap[K] {
  consumeCaptureCloneNode(budget);
  return document.createElement(tagName);
}

function assertRetainedElementIsCloneable(
  element: HTMLElement,
  rectangle: CaptureRectangle,
  signal?: AbortSignal
): void {
  throwIfFeedbackCaptureAborted(signal);
  const isOpaque = element.tagName === 'CANVAS' || element.shadowRoot !== null;
  if (!isOpaque) return;
  const bounds = domRectangle(element.getBoundingClientRect());
  if (!rectanglesIntersect(rectangle, bounds)) return;
  throw new FeedbackCaptureError(
    'MD4H-FB-CAPTURE-001',
    element.tagName === 'CANVAS'
      ? 'The selected area contains a canvas that cannot be cloned faithfully for feedback capture.'
      : 'The selected area contains an opaque rendered component that cannot be cloned faithfully for feedback capture.'
  );
}

function tableHasRowSpan(table: HTMLTableElement): boolean {
  return Array.from(table.querySelectorAll<HTMLTableCellElement>('td[rowspan], th[rowspan]')).some(
    cell => cell.rowSpan !== 1
  );
}

function tableColumnSpan(cells: readonly HTMLTableCellElement[]): number {
  return Math.max(
    1,
    cells.reduce((total, cell) => total + Math.max(1, cell.colSpan), 0)
  );
}

function tableGapColumnSpan(
  cells: readonly HTMLTableCellElement[],
  start: number,
  end: number
): number {
  let span = 0;
  for (let index = start; index < end; index += 1) {
    span += Math.max(1, cells[index].colSpan);
  }
  return Math.max(1, span);
}

function appendTableCellSpacer(
  row: HTMLTableRowElement,
  kind: 'before' | 'between' | 'after',
  width: number,
  height: number,
  columnSpan: number,
  budget: CaptureCloneBudget
): void {
  if (width <= 0) return;
  const cell = createCaptureElement('td', budget);
  cell.setAttribute('data-feedback-capture-table-cell-spacer', kind);
  cell.setAttribute('aria-hidden', 'true');
  cell.colSpan = Math.max(1, columnSpan);
  cell.style.boxSizing = 'border-box';
  cell.style.width = `${width}px`;
  cell.style.minWidth = `${width}px`;
  cell.style.maxWidth = `${width}px`;
  cell.style.height = `${Math.max(0, height)}px`;
  cell.style.padding = '0';
  cell.style.visibility = 'hidden';
  row.append(cell);
}

function appendTableRowSpacer(
  parent: HTMLElement,
  kind: 'before' | 'between' | 'after' | 'only',
  width: number,
  height: number,
  columnSpan: number,
  budget: CaptureCloneBudget
): void {
  if (height <= 0) return;
  const row = createCaptureElement('tr', budget);
  row.setAttribute('data-feedback-capture-table-row-spacer', kind);
  row.setAttribute('aria-hidden', 'true');
  row.style.height = `${height}px`;
  row.style.visibility = 'hidden';
  appendTableCellSpacer(row, 'before', width, height, columnSpan, budget);
  parent.append(row);
}

function cloneCaptureNodeWithoutOwnPruning(
  source: Node,
  rectangle: CaptureRectangle,
  budget: CaptureCloneBudget,
  signal?: AbortSignal
): Node {
  if (source instanceof HTMLElement) {
    assertRetainedElementIsCloneable(source, rectangle, signal);
  }
  const clone = cloneCaptureNodeShallow(source, budget);
  source.childNodes.forEach(child => {
    throwIfFeedbackCaptureAborted(signal);
    clone.appendChild(cloneCaptureNode(child, rectangle, budget, signal));
  });
  return clone;
}

function cloneCaptureTableRow(
  source: HTMLTableRowElement,
  bounds: DOMRect,
  rectangle: CaptureRectangle,
  budget: CaptureCloneBudget,
  signal?: AbortSignal
): HTMLTableRowElement {
  const cells = Array.from(source.cells);
  const intersections = intersectingHorizontalElements(cells, bounds, rectangle, signal);
  if (intersections === null) {
    return cloneCaptureNodeWithoutOwnPruning(
      source,
      rectangle,
      budget,
      signal
    ) as HTMLTableRowElement;
  }
  const clone = cloneCaptureNodeShallow(source, budget);
  clone.style.height = `${bounds.height}px`;
  if (intersections.length === 0) {
    appendTableCellSpacer(
      clone,
      'before',
      bounds.width,
      bounds.height,
      tableColumnSpan(cells),
      budget
    );
    return clone;
  }

  let previousIndex = 0;
  let previousRight = cells[0]?.getBoundingClientRect().left ?? bounds.left;
  intersections.forEach((intersection, intersectionIndex) => {
    throwIfFeedbackCaptureAborted(signal);
    appendTableCellSpacer(
      clone,
      intersectionIndex === 0 ? 'before' : 'between',
      intersection.bounds.left - previousRight,
      bounds.height,
      tableGapColumnSpan(cells, previousIndex, intersection.index),
      budget
    );
    const cellClone = cloneCaptureNode(
      intersection.element,
      rectangle,
      budget,
      signal
    ) as HTMLTableCellElement;
    cellClone.style.boxSizing = 'border-box';
    cellClone.style.width = `${intersection.bounds.width}px`;
    cellClone.style.minWidth = `${intersection.bounds.width}px`;
    cellClone.style.maxWidth = `${intersection.bounds.width}px`;
    cellClone.style.height = `${intersection.bounds.height}px`;
    clone.append(cellClone);
    previousIndex = intersection.index + 1;
    previousRight = rectangleRight(intersection.bounds);
  });
  appendTableCellSpacer(
    clone,
    'after',
    rectangleRight(cells[cells.length - 1]?.getBoundingClientRect() ?? bounds) - previousRight,
    bounds.height,
    tableGapColumnSpan(cells, previousIndex, cells.length),
    budget
  );
  return clone;
}

function appendPrunedTableRows(
  source: HTMLElement,
  clone: HTMLElement,
  rows: readonly HTMLTableRowElement[],
  rectangle: CaptureRectangle,
  budget: CaptureCloneBudget,
  signal?: AbortSignal
): boolean {
  if (rows.length === 0) return true;
  const sourceBounds = source.getBoundingClientRect();
  const intersections = intersectingVerticalElements(rows, sourceBounds, rectangle, signal);
  if (intersections === null) return false;
  const columnSpan = tableColumnSpan(Array.from((intersections[0]?.element ?? rows[0]).cells));
  if (intersections.length === 0) {
    appendTableRowSpacer(
      clone,
      'only',
      sourceBounds.width,
      sourceBounds.height,
      columnSpan,
      budget
    );
    return true;
  }

  let previousBottom = sourceBounds.top;
  intersections.forEach((intersection, index) => {
    throwIfFeedbackCaptureAborted(signal);
    appendTableRowSpacer(
      clone,
      index === 0 ? 'before' : 'between',
      sourceBounds.width,
      intersection.bounds.top - previousBottom,
      columnSpan,
      budget
    );
    clone.append(
      cloneCaptureTableRow(intersection.element, intersection.bounds, rectangle, budget, signal)
    );
    previousBottom = rectangleBottom(intersection.bounds);
  });
  appendTableRowSpacer(
    clone,
    'after',
    sourceBounds.width,
    rectangleBottom(sourceBounds) - previousBottom,
    columnSpan,
    budget
  );
  return true;
}

function cloneCaptureTableSection(
  source: HTMLTableSectionElement,
  rectangle: CaptureRectangle,
  budget: CaptureCloneBudget,
  signal?: AbortSignal
): HTMLTableSectionElement {
  const clone = cloneCaptureNodeShallow(source, budget);
  if (!appendPrunedTableRows(source, clone, Array.from(source.rows), rectangle, budget, signal)) {
    source.childNodes.forEach(child => {
      clone.append(cloneCaptureNode(child, rectangle, budget, signal));
    });
  }
  return clone;
}

function cloneCaptureTable(
  source: HTMLTableElement,
  rectangle: CaptureRectangle,
  budget: CaptureCloneBudget,
  signal?: AbortSignal
): HTMLTableElement {
  const bounds = source.getBoundingClientRect();
  if (!isUsableDomRectangle(bounds) || tableHasRowSpan(source)) {
    return cloneCaptureNodeWithoutOwnPruning(source, rectangle, budget, signal) as HTMLTableElement;
  }
  const clone = cloneCaptureNodeShallow(source, budget);
  clone.style.boxSizing = 'border-box';
  clone.style.tableLayout = 'fixed';
  clone.style.borderSpacing = '0';
  clone.style.width = `${bounds.width}px`;
  clone.style.height = `${bounds.height}px`;
  const directRows = Array.from(source.children).filter(
    (child): child is HTMLTableRowElement => child instanceof HTMLTableRowElement
  );
  let appendedDirectRows = false;
  source.childNodes.forEach(child => {
    throwIfFeedbackCaptureAborted(signal);
    if (child instanceof HTMLTableSectionElement) {
      clone.append(cloneCaptureTableSection(child, rectangle, budget, signal));
      return;
    }
    if (child instanceof HTMLTableRowElement) {
      if (!appendedDirectRows) {
        if (!appendPrunedTableRows(source, clone, directRows, rectangle, budget, signal)) {
          directRows.forEach(row => {
            clone.append(cloneCaptureNode(row, rectangle, budget, signal));
          });
        }
        appendedDirectRows = true;
      }
      return;
    }
    if (child instanceof HTMLTableColElement || child.nodeName === 'COLGROUP') return;
    if (child instanceof HTMLTableCaptionElement) {
      const captionBounds = child.getBoundingClientRect();
      if (rectanglesIntersect(rectangle, domRectangle(captionBounds))) {
        clone.append(cloneCaptureNode(child, rectangle, budget, signal));
      } else {
        const captionClone = cloneCaptureNodeShallow(child, budget);
        captionClone.style.height = `${Math.max(0, captionBounds.height)}px`;
        captionClone.style.visibility = 'hidden';
        clone.append(captionClone);
      }
      return;
    }
    if (child.nodeType !== Node.TEXT_NODE || child.textContent?.trim()) {
      clone.append(cloneCaptureNode(child, rectangle, budget, signal));
    }
  });
  return clone;
}

function orderedListItemValue(
  list: HTMLOListElement,
  item: HTMLLIElement,
  index: number,
  itemCount: number
): number {
  if (item.hasAttribute('value')) return item.value;
  const start = list.hasAttribute('start') ? list.start : list.reversed ? itemCount : 1;
  return start + (list.reversed ? -index : index);
}

function appendListSpacer(
  list: HTMLOListElement | HTMLUListElement,
  kind: 'before' | 'between' | 'after' | 'only',
  height: number,
  budget: CaptureCloneBudget
): void {
  if (height <= 0) return;
  const item = createCaptureElement('li', budget);
  item.setAttribute('data-feedback-capture-list-spacer', kind);
  item.setAttribute('aria-hidden', 'true');
  item.style.boxSizing = 'border-box';
  item.style.height = `${height}px`;
  item.style.margin = '0';
  item.style.padding = '0';
  item.style.listStyle = 'none';
  item.style.visibility = 'hidden';
  list.append(item);
}

function cloneCaptureList(
  source: HTMLOListElement | HTMLUListElement,
  rectangle: CaptureRectangle,
  budget: CaptureCloneBudget,
  signal?: AbortSignal
): HTMLOListElement | HTMLUListElement {
  const bounds = source.getBoundingClientRect();
  const items = Array.from(source.children).filter(
    (child): child is HTMLLIElement => child instanceof HTMLLIElement
  );
  const intersections = intersectingVerticalElements(items, bounds, rectangle, signal);
  if (intersections === null) {
    return cloneCaptureNodeWithoutOwnPruning(source, rectangle, budget, signal) as
      HTMLOListElement | HTMLUListElement;
  }
  const clone = cloneCaptureNodeShallow(source, budget);
  clone.style.boxSizing = 'border-box';
  clone.style.width = `${bounds.width}px`;
  clone.style.height = `${bounds.height}px`;
  if (intersections.length === 0) {
    return clone;
  }

  let previousBottom = items[0]?.getBoundingClientRect().top ?? bounds.top;
  intersections.forEach((intersection, intersectionIndex) => {
    throwIfFeedbackCaptureAborted(signal);
    appendListSpacer(
      clone,
      intersectionIndex === 0 ? 'before' : 'between',
      intersection.bounds.top - previousBottom,
      budget
    );
    const itemClone = cloneCaptureNode(
      intersection.element,
      rectangle,
      budget,
      signal
    ) as HTMLLIElement;
    itemClone.style.height = `${intersection.bounds.height}px`;
    if (source instanceof HTMLOListElement) {
      itemClone.value = orderedListItemValue(
        source,
        intersection.element,
        intersection.index,
        items.length
      );
    }
    clone.append(itemClone);
    previousBottom = rectangleBottom(intersection.bounds);
  });
  return clone;
}

function cloneCaptureNode(
  source: Node,
  rectangle: CaptureRectangle,
  budget: CaptureCloneBudget,
  signal?: AbortSignal
): Node {
  throwIfFeedbackCaptureAborted(signal);
  if (source instanceof HTMLTableElement) {
    return cloneCaptureTable(source, rectangle, budget, signal);
  }
  if (source instanceof HTMLOListElement || source instanceof HTMLUListElement) {
    return cloneCaptureList(source, rectangle, budget, signal);
  }
  return cloneCaptureNodeWithoutOwnPruning(source, rectangle, budget, signal);
}

function intersectingMermaidWrappers(
  intersections: readonly IntersectingCaptureChild[],
  rectangle: CaptureRectangle,
  signal?: AbortSignal
): HTMLElement[] {
  const wrappers = new Set<HTMLElement>();
  intersections.forEach(({ element, bounds }) => {
    throwIfFeedbackCaptureAborted(signal);
    const candidates = [
      ...(element.matches(MERMAID_WRAPPER_SELECTOR) ? [element] : []),
      ...Array.from(element.querySelectorAll<HTMLElement>(MERMAID_WRAPPER_SELECTOR)),
    ];
    candidates.forEach(wrapper => {
      throwIfFeedbackCaptureAborted(signal);
      const wrapperBounds = wrapper === element ? bounds : wrapper.getBoundingClientRect();
      if (rectanglesIntersect(rectangle, domRectangle(wrapperBounds))) {
        wrappers.add(wrapper);
      }
    });
  });
  return [...wrappers];
}

function mermaidRenderError(): FeedbackCaptureError {
  return new FeedbackCaptureError(
    'MD4H-FB-CAPTURE-001',
    'A Mermaid diagram failed to render and cannot be captured.'
  );
}

async function waitForPendingMermaid(wrapper: HTMLElement, signal?: AbortSignal): Promise<void> {
  throwIfFeedbackCaptureAborted(signal);
  let observer: MutationObserver | undefined;
  const readiness = new Promise<void>((resolve, reject) => {
    const checkState = (): void => {
      const state = wrapper.getAttribute(MERMAID_RENDER_STATE_ATTRIBUTE);
      if (state === 'pending') return;
      if (state === 'ready') {
        resolve();
        return;
      }
      if (state === 'error') {
        reject(mermaidRenderError());
        return;
      }
      reject(
        new FeedbackCaptureError(
          'MD4H-FB-CAPTURE-001',
          'A Mermaid diagram does not expose a valid capture readiness state.'
        )
      );
    };
    observer = new MutationObserver(checkState);
    observer.observe(wrapper, {
      attributes: true,
      attributeFilter: [MERMAID_RENDER_STATE_ATTRIBUTE],
    });
    checkState();
  });

  try {
    await withTimeout(
      readiness,
      'A Mermaid diagram did not become ready before the capture timeout.',
      signal
    );
  } finally {
    observer?.disconnect();
  }
}

async function waitForIntersectingMermaid(
  intersections: readonly IntersectingCaptureChild[],
  rectangle: CaptureRectangle,
  signal?: AbortSignal
): Promise<boolean> {
  throwIfFeedbackCaptureAborted(signal);
  const wrappers = intersectingMermaidWrappers(intersections, rectangle, signal);
  const pending: HTMLElement[] = [];
  for (const wrapper of wrappers) {
    throwIfFeedbackCaptureAborted(signal);
    const state = wrapper.getAttribute(MERMAID_RENDER_STATE_ATTRIBUTE);
    if (state === 'ready') continue;
    if (state === 'error') throw mermaidRenderError();
    if (state === 'pending') {
      pending.push(wrapper);
      continue;
    }
    throw new FeedbackCaptureError(
      'MD4H-FB-CAPTURE-001',
      'A Mermaid diagram does not expose a valid capture readiness state.'
    );
  }
  await Promise.all(pending.map(wrapper => waitForPendingMermaid(wrapper, signal)));
  throwIfFeedbackCaptureAborted(signal);
  return pending.length > 0;
}

function buildCaptureStage(
  root: HTMLElement,
  rectangle: CaptureRectangle,
  intersections: readonly IntersectingCaptureChild[],
  signal?: AbortSignal
): HTMLElement {
  throwIfFeedbackCaptureAborted(signal);
  const cloneBudget: CaptureCloneBudget = { nodeCount: 0 };
  const rootBounds = root.getBoundingClientRect();
  const stage = document.createElement('div');
  stage.setAttribute('data-feedback-capture-stage', '');
  stage.style.position = 'fixed';
  stage.style.left = '-100000px';
  stage.style.top = '0';
  stage.style.width = `${rectangle.width}px`;
  stage.style.height = `${rectangle.height}px`;
  stage.style.overflow = 'hidden';
  stage.style.pointerEvents = 'none';
  stage.style.boxSizing = 'border-box';
  stage.style.background = getComputedStyle(root).backgroundColor || 'transparent';

  const content = root.cloneNode(false) as HTMLElement;
  content.removeAttribute('id');
  content.removeAttribute('contenteditable');
  content.setAttribute('aria-hidden', 'true');
  content.setAttribute('data-feedback-capture-content', '');
  sanitizeCaptureClone(content, signal);
  content.style.position = 'absolute';
  content.style.left = `${rootBounds.left - rectangle.left}px`;
  content.style.top = `${rootBounds.top - rectangle.top}px`;
  content.style.width = `${rootBounds.width}px`;
  content.style.height = `${rootBounds.height}px`;
  content.style.margin = '0';
  content.style.boxSizing = 'border-box';

  intersections.forEach(({ element, bounds }) => {
    throwIfFeedbackCaptureAborted(signal);
    const clone = cloneCaptureNode(element, rectangle, cloneBudget, signal) as HTMLElement;
    throwIfFeedbackCaptureAborted(signal);
    clone.setAttribute('data-feedback-captured-block', '');
    clone.style.position = 'absolute';
    clone.style.left = `${bounds.left - rootBounds.left}px`;
    clone.style.top = `${bounds.top - rootBounds.top}px`;
    clone.style.width = `${bounds.width}px`;
    clone.style.height = `${bounds.height}px`;
    clone.style.margin = '0';
    clone.style.boxSizing = 'border-box';
    sanitizeCaptureClone(clone, signal);
    content.append(clone);
  });

  throwIfFeedbackCaptureAborted(signal);
  stage.append(content);
  document.body.append(stage);
  return stage;
}

function captureScale(rectangle: CaptureRectangle, requested: number): number {
  const basePixels = rectangle.width * rectangle.height;
  if (basePixels <= 0 || basePixels > MAX_PIXELS) {
    throw new FeedbackCaptureError(
      'MD4H-FB-CAPTURE-002',
      'The selected area exceeds the 12 megapixels feedback limit.'
    );
  }
  const maximumScale = Math.sqrt(MAX_PIXELS / basePixels);
  return Math.max(1, Math.min(requested, maximumScale, 2));
}

/** Create the production `modern-screenshot@4.7.0` rasterizer adapter. */
export function createModernScreenshotRasterizer(
  screenshot?: ModernScreenshotFunction
): DomRasterizer {
  return async request => {
    throwIfFeedbackCaptureAborted(request.signal);
    const scale = captureScale(request.rectangle, request.scale);
    let stage: HTMLElement | null = null;
    try {
      let intersections = intersectingCaptureChildren(
        request.root,
        request.rectangle,
        request.signal
      );
      throwIfFeedbackCaptureAborted(request.signal);
      const waitedForMermaid = await waitForIntersectingMermaid(
        intersections,
        request.rectangle,
        request.signal
      );
      throwIfFeedbackCaptureAborted(request.signal);
      if (waitedForMermaid) {
        // Mermaid SVG layout can change block geometry. Re-run the same bounded
        // binary-search discovery only when an intersecting render completed.
        intersections = intersectingCaptureChildren(
          request.root,
          request.rectangle,
          request.signal
        );
      }
      throwIfFeedbackCaptureAborted(request.signal);
      stage = buildCaptureStage(request.root, request.rectangle, intersections, request.signal);
      throwIfFeedbackCaptureAborted(request.signal);
      validateCaptureResources(stage, request.signal);
      await waitForRenderedResources(stage, request.signal);
      throwIfFeedbackCaptureAborted(request.signal);
      const rasterize =
        screenshot ?? (await withAbortSignal(loadDefaultScreenshot(), request.signal));
      throwIfFeedbackCaptureAborted(request.signal);
      const dataUrl = await withAbortSignal(
        rasterize(stage, {
          width: request.rectangle.width,
          height: request.rectangle.height,
          scale,
          backgroundColor:
            getComputedStyle(request.root).backgroundColor ||
            getComputedStyle(document.body).backgroundColor ||
            null,
          maximumCanvasSize: MAX_PIXELS,
          timeout: RESOURCE_TIMEOUT_MS,
          fetch: {
            requestInit: {
              cache: 'force-cache',
              credentials: 'omit',
              mode: 'cors',
              ...(request.signal ? { signal: request.signal } : {}),
            },
            placeholderImage: () => {
              throw new FeedbackCaptureError(
                'MD4H-FB-CAPTURE-001',
                'A rendered resource could not be loaded for capture.'
              );
            },
          },
          filter: node => {
            if (!(node instanceof Element)) return true;
            return !node.matches(CAPTURE_CHROME_SELECTOR);
          },
        }),
        request.signal
      );
      throwIfFeedbackCaptureAborted(request.signal);
      if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > MAX_DATA_URL_LENGTH) {
        throw new FeedbackCaptureError(
          'MD4H-FB-CAPTURE-002',
          'The screenshot could not be encoded within the 10 MiB feedback limit.'
        );
      }
      throwIfFeedbackCaptureAborted(request.signal);
      return {
        dataUrl,
        width: Math.floor(request.rectangle.width * scale),
        height: Math.floor(request.rectangle.height * scale),
      };
    } catch (error) {
      throwIfFeedbackCaptureAborted(request.signal);
      if (error instanceof FeedbackCaptureError) throw error;
      throw new FeedbackCaptureError(
        'MD4H-FB-CAPTURE-002',
        'The selected area could not be rasterized as PNG.',
        error
      );
    } finally {
      stage?.remove();
    }
  };
}
