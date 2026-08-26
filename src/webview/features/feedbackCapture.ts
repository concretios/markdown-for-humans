/**
 * @file feedbackCapture.ts - Visible-area capture and screenshot annotation primitives
 * @description Provides geometry validation, top-level DOM hit mapping, an injected
 *              rasterization boundary, bitmap-stable annotation commands, and the
 *              accessible modal used to review and flatten screenshot feedback.
 *
 * Key responsibilities:
 * - Normalize visible crop rectangles and map them to rendered top-level blocks
 * - Carry lifecycle cancellation through the injected rasterization boundary
 * - Keep all drawing commands in source bitmap coordinates
 * - Manage undoable annotation state without touching Markdown editor history
 * - Flatten the base capture and optional markup only when feedback is submitted
 */

import {
  createFeedbackDiscardDialog,
  type FeedbackDiscardDialogController,
} from './feedbackDiscardDialog';

/** A point in client or bitmap coordinates, as documented by the accepting API. */
export interface CapturePoint {
  x: number;
  y: number;
}

/** An axis-aligned rectangle expressed in CSS client coordinates. */
export interface CaptureRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Pixel dimensions of a captured bitmap. */
export interface BitmapSize {
  width: number;
  height: number;
}

/** A rendered top-level editor block and its stable ordinal in the frozen document. */
export interface CaptureBlock {
  index: number;
  element: HTMLElement;
}

/** The rendered block ordinals intersected by one capture rectangle. */
export interface CaptureBlockRange {
  firstBlock: number;
  lastBlock: number;
  blockIndices: readonly number[];
}

/** A PNG returned by the caller-provided DOM rasterizer. */
export interface RasterizedCapture {
  dataUrl: string;
  width: number;
  height: number;
}

/** Input passed to the injected DOM rasterization implementation. */
export interface DomRasterizeRequest {
  root: HTMLElement;
  rectangle: CaptureRectangle;
  scale: number;
  /** Cancels asynchronous capture work when the snapshot/session is invalidated. */
  signal?: AbortSignal;
}

/** A dependency-injected DOM rasterizer, keeping this module library-neutral. */
export type DomRasterizer = (request: DomRasterizeRequest) => Promise<RasterizedCapture>;

/** Stable capture error codes shared with the feedback-session protocol. */
export type FeedbackCaptureErrorCode =
  'MD4H-FB-ANCHOR-001' | 'MD4H-FB-CAPTURE-001' | 'MD4H-FB-CAPTURE-002' | 'MD4H-FB-SNAPSHOT-001';

/** Global lifecycle event emitted whenever the active Feedback session is torn down. */
export const FEEDBACK_SESSION_ENDED_EVENT = 'feedbackSessionEnded';

/** A recoverable capture failure suitable for translation into session UI. */
export class FeedbackCaptureError extends Error {
  readonly code: FeedbackCaptureErrorCode;
  readonly cause?: unknown;

  constructor(code: FeedbackCaptureErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'FeedbackCaptureError';
    this.code = code;
    this.cause = cause;
  }
}

/** Fail a capture checkpoint with the same typed, recoverable cancellation error. */
export function throwIfFeedbackCaptureAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new FeedbackCaptureError(
    'MD4H-FB-CAPTURE-002',
    'Feedback capture was cancelled before it could finish.',
    signal.reason
  );
}

/** Options for validating, mapping, and rasterizing a pointer-defined visible crop. */
export interface CaptureVisibleAreaOptions {
  root: HTMLElement;
  start: CapturePoint;
  end: CapturePoint;
  viewport: CaptureRectangle;
  blocks: readonly CaptureBlock[];
  rasterize: DomRasterizer;
  scale?: number;
  minimumSize?: number;
  /** Cancels mapping/rasterization when the owning capture lifecycle ends. */
  signal?: AbortSignal;
}

/** Validated visible-area output ready for the annotation modal. */
export interface VisibleAreaCapture {
  rectangle: CaptureRectangle;
  blockRange: CaptureBlockRange;
  image: RasterizedCapture;
}

/** Curated colors remain stable when vector markup is flattened into a PNG. */
export type AnnotationColor = 'coral' | 'yellow' | 'blue' | 'green';

interface AnnotationCommandStyle {
  /** Omitted by legacy callers to preserve the original coral default. */
  color?: AnnotationColor;
}

/** A freehand annotation stored in captured-bitmap coordinates. */
export interface PenAnnotationCommand extends AnnotationCommandStyle {
  type: 'pen';
  points: readonly CapturePoint[];
}

/** A rectangle annotation stored in captured-bitmap coordinates. */
export interface RectangleAnnotationCommand extends AnnotationCommandStyle {
  type: 'rectangle';
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An ellipse annotation stored in captured-bitmap coordinates. */
export interface EllipseAnnotationCommand extends AnnotationCommandStyle {
  type: 'ellipse';
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Portable vector markup flattened into the final PNG on submission. */
export type AnnotationCommand =
  PenAnnotationCommand | RectangleAnnotationCommand | EllipseAnnotationCommand;

/** Selectable annotation tools in the screenshot dialog. */
export type AnnotationTool = AnnotationCommand['type'];

/** Canvas allocation seam used to verify that flattening happens only on Add. */
export type CanvasFactory = () => HTMLCanvasElement;

/** Data emitted only after feedback validation and PNG flattening succeed. */
export interface SubmittedScreenshotFeedback {
  feedback: string;
  pngDataUrl: string;
  commands: readonly AnnotationCommand[];
}

/** Hooks and dependencies for one screenshot annotation dialog. */
export interface FeedbackAnnotationModalOptions {
  image: RasterizedCapture;
  onAdd: (submission: SubmittedScreenshotFeedback) => void | Promise<void>;
  onRetake: (draftFeedback: string) => void | Promise<void>;
  onCancel: () => void;
  onError?: (error: unknown) => void;
  mount?: HTMLElement;
  returnFocus?: HTMLElement;
  fallbackFocus?: HTMLElement;
  initialFeedback?: string;
  canvasFactory?: CanvasFactory;
}

/** Imperative surface used by the feedback rail and unit tests. */
export interface FeedbackAnnotationModalController {
  readonly element: HTMLElement;
  readonly tool: AnnotationTool;
  readonly color: AnnotationColor;
  readonly commands: readonly AnnotationCommand[];
  focus(): void;
  setTool(tool: AnnotationTool): void;
  setColor(color: AnnotationColor): void;
  addCommand(command: AnnotationCommand): void;
  undo(): boolean;
  redo(): boolean;
  clear(): boolean;
  submit(): Promise<boolean>;
  retake(): Promise<boolean>;
  cancel(): void;
  destroy(): void;
}

const MAX_CAPTURE_SCALE = 2;
const DEFAULT_MINIMUM_CAPTURE_SIZE = 1;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const ANNOTATION_PALETTE: readonly {
  color: AnnotationColor;
  label: string;
  stroke: string;
  halo: string;
}[] = [
  { color: 'coral', label: 'Coral', stroke: '#e75d4f', halo: '#ffffff' },
  { color: 'yellow', label: 'Yellow', stroke: '#f5c400', halo: '#1f2328' },
  { color: 'blue', label: 'Blue', stroke: '#2f81f7', halo: '#ffffff' },
  { color: 'green', label: 'Green', stroke: '#2da44e', halo: '#ffffff' },
];
const DEFAULT_ANNOTATION_COLOR: AnnotationColor = 'coral';
const ANNOTATION_STROKE_WIDTH = 3;
const ANNOTATION_HALO_WIDTH = 7;

let modalSequence = 0;

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function isFinitePoint(point: CapturePoint): boolean {
  return isFiniteNumber(point.x) && isFiniteNumber(point.y);
}

function isUsableRectangle(rectangle: CaptureRectangle): boolean {
  return (
    isFiniteNumber(rectangle.left) &&
    isFiniteNumber(rectangle.top) &&
    isFiniteNumber(rectangle.width) &&
    isFiniteNumber(rectangle.height) &&
    rectangle.width > 0 &&
    rectangle.height > 0
  );
}

function isUsableBitmap(size: BitmapSize): boolean {
  return (
    isFiniteNumber(size.width) && isFiniteNumber(size.height) && size.width > 0 && size.height > 0
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function clonePoint(point: CapturePoint): CapturePoint {
  return { x: point.x, y: point.y };
}

function cloneCommand(command: AnnotationCommand): AnnotationCommand {
  if (command.type === 'pen') {
    return {
      type: 'pen',
      points: command.points.map(clonePoint),
      ...(command.color ? { color: command.color } : {}),
    };
  }
  return { ...command };
}

function annotationPaletteEntry(color: AnnotationColor | undefined) {
  return (
    ANNOTATION_PALETTE.find(entry => entry.color === color) ??
    ANNOTATION_PALETTE.find(entry => entry.color === DEFAULT_ANNOTATION_COLOR)!
  );
}

/**
 * Normalizes a drag in any direction into a positive-size rectangle.
 *
 * @param start - Drag origin in client coordinates
 * @param end - Current or final pointer position in client coordinates
 * @returns Rectangle enclosing both points
 */
export function normalizeRectangle(start: CapturePoint, end: CapturePoint): CaptureRectangle {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return {
    left,
    top,
    width: Math.max(start.x, end.x) - left,
    height: Math.max(start.y, end.y) - top,
  };
}

/**
 * Intersects a rectangle with an allowed viewport.
 *
 * @param rectangle - Requested client-coordinate rectangle
 * @param bounds - Visible client-coordinate bounds
 * @returns The positive-area intersection, or null when none exists
 */
export function clampRectangle(
  rectangle: CaptureRectangle,
  bounds: CaptureRectangle
): CaptureRectangle | null {
  if (!isUsableRectangle(rectangle) || !isUsableRectangle(bounds)) return null;

  const left = Math.max(rectangle.left, bounds.left);
  const top = Math.max(rectangle.top, bounds.top);
  const right = Math.min(rectangle.left + rectangle.width, bounds.left + bounds.width);
  const bottom = Math.min(rectangle.top + rectangle.height, bounds.top + bounds.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Normalizes a pointer drag, clamps it to the viewport, and enforces a usable size.
 *
 * @param start - Drag origin
 * @param end - Drag endpoint
 * @param bounds - Allowed visible viewport
 * @param minimumSize - Minimum width and height in CSS pixels
 * @returns Valid capture rectangle, or null for invalid/too-small input
 */
export function normalizeAndClampRectangle(
  start: CapturePoint,
  end: CapturePoint,
  bounds: CaptureRectangle,
  minimumSize = DEFAULT_MINIMUM_CAPTURE_SIZE
): CaptureRectangle | null {
  if (!isFinitePoint(start) || !isFinitePoint(end) || !isUsableRectangle(bounds)) return null;
  if (!isFiniteNumber(minimumSize) || minimumSize <= 0) return null;
  const clamped = clampRectangle(normalizeRectangle(start, end), bounds);
  if (!clamped || clamped.width < minimumSize || clamped.height < minimumSize) return null;
  return clamped;
}

/**
 * Tests whether two rectangles overlap with positive area.
 * Edge-only contact deliberately does not count as a rendered-content hit.
 */
export function rectanglesIntersect(first: CaptureRectangle, second: CaptureRectangle): boolean {
  if (!isUsableRectangle(first) || !isUsableRectangle(second)) return false;
  return (
    first.left < second.left + second.width &&
    first.left + first.width > second.left &&
    first.top < second.top + second.height &&
    first.top + first.height > second.top
  );
}

function fromDomRect(rectangle: DOMRect): CaptureRectangle {
  return {
    left: rectangle.left,
    top: rectangle.top,
    width: rectangle.width,
    height: rectangle.height,
  };
}

const BOX_RENDERING_TAGS = new Set([
  'CANVAS',
  'HR',
  'IFRAME',
  'IMG',
  'PRE',
  'SVG',
  'TABLE',
  'VIDEO',
]);

function hasVisibleBoxStyle(element: HTMLElement | SVGElement): boolean {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return false;
  try {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const backgroundColor = style.backgroundColor.replace(/ /g, '').toLowerCase();
    const hasBackgroundColor =
      backgroundColor !== '' &&
      backgroundColor !== 'transparent' &&
      backgroundColor !== 'rgba(0,0,0,0)';
    const hasBackgroundImage = style.backgroundImage !== '' && style.backgroundImage !== 'none';
    const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some(side => {
      const width = Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`));
      const borderStyle = style.getPropertyValue(`border-${side.toLowerCase()}-style`);
      return Number.isFinite(width) && width > 0 && borderStyle !== '' && borderStyle !== 'none';
    });
    return (
      hasBackgroundColor ||
      hasBackgroundImage ||
      hasBorder ||
      (style.boxShadow !== '' && style.boxShadow !== 'none') ||
      (style.outlineStyle !== '' && style.outlineStyle !== 'none')
    );
  } catch {
    return false;
  }
}

function textClientRectangles(root: HTMLElement): CaptureRectangle[] {
  if (typeof document === 'undefined' || typeof document.createTreeWalker !== 'function') return [];
  const rectangles: CaptureRectangle[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (current.textContent?.trim()) {
      const range = document.createRange();
      try {
        range.selectNodeContents(current);
        for (const rectangle of Array.from(range.getClientRects())) {
          const captureRectangle = fromDomRect(rectangle);
          if (isUsableRectangle(captureRectangle)) rectangles.push(captureRectangle);
        }
      } catch {
        // Range geometry is authoritative. Fail closed if the browser cannot
        // expose it rather than widening the target to the containing block.
      } finally {
        range.detach?.();
      }
    }
    current = walker.nextNode();
  }
  return rectangles;
}

function renderedElementRectangles(
  root: HTMLElement,
  rootRectangle?: CaptureRectangle
): CaptureRectangle[] {
  const rectangles: CaptureRectangle[] = [];
  const candidates: Array<HTMLElement | SVGElement> = [
    root,
    ...Array.from(root.querySelectorAll<HTMLElement | SVGElement>('*')),
  ];
  for (const element of candidates) {
    if (!BOX_RENDERING_TAGS.has(element.tagName) && !hasVisibleBoxStyle(element)) continue;
    const rectangle =
      element === root && rootRectangle
        ? rootRectangle
        : fromDomRect(element.getBoundingClientRect());
    if (isUsableRectangle(rectangle)) rectangles.push(rectangle);
  }
  return rectangles;
}

function rectangleHitsRenderedBlockContent(
  rectangle: CaptureRectangle,
  block: HTMLElement,
  blockRectangle: CaptureRectangle
): boolean {
  const renderedRectangles = [
    ...textClientRectangles(block),
    ...renderedElementRectangles(block, blockRectangle),
  ];
  return renderedRectangles.some(rendered => rectanglesIntersect(rectangle, rendered));
}

function orderedCaptureBlocks(blocks: readonly CaptureBlock[]): CaptureBlock[] {
  const validBlocks = blocks.filter(block => Number.isInteger(block.index) && block.index >= 0);
  const alreadyOrdered = validBlocks.every(
    (block, index) => index === 0 || validBlocks[index - 1].index <= block.index
  );
  return alreadyOrdered
    ? validBlocks
    : validBlocks.sort((first, second) => first.index - second.index);
}

type CaptureBlockRectangleReader = (block: CaptureBlock) => CaptureRectangle;

function cachedBlockRectangleReader(): CaptureBlockRectangleReader {
  const rectangles = new Map<CaptureBlock, CaptureRectangle>();
  return block => {
    const cached = rectangles.get(block);
    if (cached) return cached;
    const rectangle = fromDomRect(block.element.getBoundingClientRect());
    rectangles.set(block, rectangle);
    return rectangle;
  };
}

/**
 * Finds the first normal-flow top-level block whose bottom can cross the crop top.
 * Top-level ProseMirror children are vertically ordered, so binary search bounds
 * layout reads without changing the later exact rendered-content hit test.
 */
function firstPotentialBlockIndex(
  blocks: readonly CaptureBlock[],
  cropTop: number,
  readRectangle: CaptureBlockRectangleReader
): number {
  let start = 0;
  let end = blocks.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    const rectangle = readRectangle(blocks[middle]);
    if (rectangle.top + rectangle.height <= cropTop) start = middle + 1;
    else end = middle;
  }
  return start;
}

/** Find the first normal-flow top-level block starting at or below the crop bottom. */
function firstBlockAfterCropIndex(
  blocks: readonly CaptureBlock[],
  cropBottom: number,
  readRectangle: CaptureBlockRectangleReader
): number {
  let start = 0;
  let end = blocks.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (readRectangle(blocks[middle]).top < cropBottom) start = middle + 1;
    else end = middle;
  }
  return start;
}

/**
 * Finds rendered top-level blocks whose actual DOM boxes intersect a crop.
 *
 * Frozen anchors are ordered top-level ProseMirror children in normal document
 * flow. Two binary searches therefore narrow detailed DOM inspection to the
 * vertical crop candidates. Candidate blocks still pass the same exact block,
 * text-range, and rendered-element intersections, so whitespace is never mapped
 * merely because it lies between the first and last candidate.
 *
 * @returns Sorted, unique block ordinals. Zero-area/unmeasured blocks are ignored.
 */
export function findIntersectingTopLevelBlocks(
  rectangle: CaptureRectangle,
  blocks: readonly CaptureBlock[]
): number[] {
  if (!isUsableRectangle(rectangle)) return [];
  const orderedBlocks = orderedCaptureBlocks(blocks);
  const readRectangle = cachedBlockRectangleReader();
  const candidateStart = firstPotentialBlockIndex(orderedBlocks, rectangle.top, readRectangle);
  const candidateEnd = firstBlockAfterCropIndex(
    orderedBlocks,
    rectangle.top + rectangle.height,
    readRectangle
  );
  const indices = new Set<number>();
  for (let index = candidateStart; index < candidateEnd; index += 1) {
    const block = orderedBlocks[index];
    const blockRectangle = readRectangle(block);
    if (
      rectanglesIntersect(rectangle, blockRectangle) &&
      rectangleHitsRenderedBlockContent(rectangle, block.element, blockRectangle)
    ) {
      indices.add(block.index);
    }
  }
  return Array.from(indices).sort((first, second) => first - second);
}

/**
 * Converts DOM intersections to one containing top-level block range.
 * Gaps between intersected ordinals are intentionally contained by first/last.
 */
export function mapRectangleToTopLevelBlockRange(
  rectangle: CaptureRectangle,
  blocks: readonly CaptureBlock[]
): CaptureBlockRange | null {
  const blockIndices = findIntersectingTopLevelBlocks(rectangle, blocks);
  if (blockIndices.length === 0) return null;
  return {
    firstBlock: blockIndices[0],
    lastBlock: blockIndices[blockIndices.length - 1],
    blockIndices,
  };
}

function normalizeCaptureScale(scale: number | undefined): number {
  const deviceScale =
    typeof window === 'undefined' || !isFiniteNumber(window.devicePixelRatio)
      ? 1
      : window.devicePixelRatio;
  const requestedScale = scale ?? deviceScale;
  if (!isFiniteNumber(requestedScale) || requestedScale <= 0) return 1;
  return Math.min(Math.max(requestedScale, 1), MAX_CAPTURE_SCALE);
}

function validateRasterizedCapture(image: RasterizedCapture): void {
  if (
    !image.dataUrl.startsWith('data:image/png;base64,') ||
    !isUsableBitmap({ width: image.width, height: image.height })
  ) {
    throw new FeedbackCaptureError(
      'MD4H-FB-CAPTURE-002',
      'The screenshot renderer returned an invalid PNG.'
    );
  }
}

/**
 * Validates and maps a visible crop before invoking the injected rasterizer.
 *
 * @throws FeedbackCaptureError when the crop is invalid/unmapped or rasterization fails
 */
export async function captureVisibleArea(
  options: CaptureVisibleAreaOptions
): Promise<VisibleAreaCapture> {
  throwIfFeedbackCaptureAborted(options.signal);
  const rectangle = normalizeAndClampRectangle(
    options.start,
    options.end,
    options.viewport,
    options.minimumSize
  );
  if (!rectangle) {
    throw new FeedbackCaptureError(
      'MD4H-FB-ANCHOR-001',
      'Select a visible part of the rendered Markdown.'
    );
  }

  throwIfFeedbackCaptureAborted(options.signal);
  const blockRange = mapRectangleToTopLevelBlockRange(rectangle, options.blocks);
  throwIfFeedbackCaptureAborted(options.signal);
  if (!blockRange) {
    throw new FeedbackCaptureError(
      'MD4H-FB-ANCHOR-001',
      'The selected area does not contain rendered Markdown.'
    );
  }

  try {
    throwIfFeedbackCaptureAborted(options.signal);
    const rasterizeRequest: DomRasterizeRequest = {
      root: options.root,
      rectangle,
      scale: normalizeCaptureScale(options.scale),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const image = await options.rasterize(rasterizeRequest);
    throwIfFeedbackCaptureAborted(options.signal);
    validateRasterizedCapture(image);
    throwIfFeedbackCaptureAborted(options.signal);
    return { rectangle, blockRange, image };
  } catch (error) {
    throwIfFeedbackCaptureAborted(options.signal);
    if (error instanceof FeedbackCaptureError) throw error;
    throw new FeedbackCaptureError(
      'MD4H-FB-CAPTURE-002',
      'The selected area could not be rendered as a screenshot.',
      error
    );
  }
}

/**
 * Converts a client coordinate over a resized preview into bitmap coordinates.
 * Values are clamped so edge drags remain valid at every CSS zoom/size.
 *
 * @throws RangeError when the preview or bitmap dimensions are unusable
 */
export function clientPointToBitmap(
  clientPoint: CapturePoint,
  previewRectangle: DOMRect | CaptureRectangle,
  bitmap: BitmapSize
): CapturePoint {
  const preview = fromDomRect(previewRectangle as DOMRect);
  if (!isFinitePoint(clientPoint) || !isUsableRectangle(preview) || !isUsableBitmap(bitmap)) {
    throw new RangeError('Cannot map annotation coordinates with invalid dimensions.');
  }
  const relativeX = clamp((clientPoint.x - preview.left) / preview.width, 0, 1);
  const relativeY = clamp((clientPoint.y - preview.top) / preview.height, 0, 1);
  return { x: relativeX * bitmap.width, y: relativeY * bitmap.height };
}

function clampBitmapPoint(point: CapturePoint, bitmap: BitmapSize): CapturePoint {
  return {
    x: clamp(point.x, 0, bitmap.width),
    y: clamp(point.y, 0, bitmap.height),
  };
}

function constrainEndPoint(
  start: CapturePoint,
  end: CapturePoint,
  bitmap?: BitmapSize
): CapturePoint {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const directionX = deltaX < 0 ? -1 : 1;
  const directionY = deltaY < 0 ? -1 : 1;
  let side = Math.max(Math.abs(deltaX), Math.abs(deltaY));

  if (bitmap) {
    const availableX = directionX < 0 ? start.x : bitmap.width - start.x;
    const availableY = directionY < 0 ? start.y : bitmap.height - start.y;
    side = Math.min(side, Math.max(availableX, 0), Math.max(availableY, 0));
  }
  return { x: start.x + directionX * side, y: start.y + directionY * side };
}

/**
 * Builds a normalized rectangle/ellipse command from a bitmap-space drag.
 * Shift constrains both dimensions to the same size. Optional bounds keep the
 * constrained result inside the captured bitmap.
 */
export function createShapeAnnotation(
  tool: 'rectangle' | 'ellipse',
  start: CapturePoint,
  end: CapturePoint,
  constrain = false,
  bitmap?: BitmapSize
): RectangleAnnotationCommand | EllipseAnnotationCommand {
  if (!isFinitePoint(start) || !isFinitePoint(end)) {
    throw new RangeError('Annotation points must be finite.');
  }
  if (bitmap && !isUsableBitmap(bitmap)) {
    throw new RangeError('Annotation bounds must have positive dimensions.');
  }

  const boundedStart = bitmap ? clampBitmapPoint(start, bitmap) : clonePoint(start);
  const boundedEnd = bitmap ? clampBitmapPoint(end, bitmap) : clonePoint(end);
  const finalEnd = constrain ? constrainEndPoint(boundedStart, boundedEnd, bitmap) : boundedEnd;
  const rectangle = normalizeRectangle(boundedStart, finalEnd);
  return {
    type: tool,
    x: rectangle.left,
    y: rectangle.top,
    width: rectangle.width,
    height: rectangle.height,
  };
}

/**
 * Snapshot-based command history. Clear creates a normal history state, making
 * it undoable without introducing a special persisted command type.
 */
export class AnnotationHistory {
  private _states: AnnotationCommand[][] = [[]];
  private _index = 0;

  get commands(): readonly AnnotationCommand[] {
    return this._states[this._index].map(cloneCommand);
  }

  get canUndo(): boolean {
    return this._index > 0;
  }

  get canRedo(): boolean {
    return this._index < this._states.length - 1;
  }

  /** Appends one immutable command state and drops any abandoned redo branch. */
  add(command: AnnotationCommand): void {
    const next = [...this._states[this._index].map(cloneCommand), cloneCommand(command)];
    this._states = [...this._states.slice(0, this._index + 1), next];
    this._index += 1;
  }

  /** Clears current annotations as an undoable state transition. */
  clear(): boolean {
    if (this._states[this._index].length === 0) return false;
    this._states = [...this._states.slice(0, this._index + 1), []];
    this._index += 1;
    return true;
  }

  /** Moves to the previous annotation snapshot when available. */
  undo(): boolean {
    if (!this.canUndo) return false;
    this._index -= 1;
    return true;
  }

  /** Reapplies the next annotation snapshot when available. */
  redo(): boolean {
    if (!this.canRedo) return false;
    this._index += 1;
    return true;
  }
}

function configureStrokeContext(
  context: CanvasRenderingContext2D,
  color: string,
  width: number
): void {
  context.strokeStyle = color;
  context.lineWidth = width;
  context.lineCap = 'round';
  context.lineJoin = 'round';
}

function tracePen(context: CanvasRenderingContext2D, command: PenAnnotationCommand): void {
  if (command.points.length === 0) return;
  context.beginPath();
  context.moveTo(command.points[0].x, command.points[0].y);
  for (const point of command.points.slice(1)) context.lineTo(point.x, point.y);
  if (command.points.length === 1) {
    context.lineTo(command.points[0].x, command.points[0].y);
  }
  context.stroke();
}

function traceShape(context: CanvasRenderingContext2D, command: AnnotationCommand): void {
  if (command.type === 'pen') {
    tracePen(context, command);
    return;
  }
  if (command.type === 'rectangle') {
    context.strokeRect(command.x, command.y, command.width, command.height);
    return;
  }
  context.beginPath();
  context.ellipse(
    command.x + command.width / 2,
    command.y + command.height / 2,
    command.width / 2,
    command.height / 2,
    0,
    0,
    Math.PI * 2
  );
  context.stroke();
}

/**
 * Flattens one base image and all vector commands to a metadata-free PNG data URL.
 * The canvas factory is invoked exactly once and only by callers choosing to Add.
 *
 * @throws Error when a 2D context or PNG output is unavailable
 */
export function flattenAnnotationsToPng(
  baseImage: CanvasImageSource,
  bitmap: BitmapSize,
  commands: readonly AnnotationCommand[],
  canvasFactory: CanvasFactory = () => document.createElement('canvas')
): string {
  if (!isUsableBitmap(bitmap)) throw new RangeError('Screenshot dimensions must be positive.');
  const canvas = canvasFactory();
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  try {
    if (!context) throw new Error('Could not create the screenshot annotation canvas.');

    context.drawImage(baseImage, 0, 0, bitmap.width, bitmap.height);
    for (const command of commands) {
      const palette = annotationPaletteEntry(command.color);
      configureStrokeContext(context, palette.halo, ANNOTATION_HALO_WIDTH);
      traceShape(context, command);
      configureStrokeContext(context, palette.stroke, ANNOTATION_STROKE_WIDTH);
      traceShape(context, command);
    }

    const pngDataUrl = canvas.toDataURL('image/png');
    if (!pngDataUrl.startsWith('data:image/png;base64,')) {
      throw new Error('Could not encode the annotated screenshot as PNG.');
    }
    return pngDataUrl;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, name);
}

function createSvgGeometry(command: AnnotationCommand): SVGElement {
  if (command.type === 'pen') {
    const polyline = createSvgElement('polyline');
    const points =
      command.points.length === 1 ? [command.points[0], command.points[0]] : command.points;
    polyline.setAttribute('points', points.map(point => `${point.x},${point.y}`).join(' '));
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke-linecap', 'round');
    polyline.setAttribute('stroke-linejoin', 'round');
    return polyline;
  }
  if (command.type === 'rectangle') {
    const rectangle = createSvgElement('rect');
    rectangle.setAttribute('x', String(command.x));
    rectangle.setAttribute('y', String(command.y));
    rectangle.setAttribute('width', String(command.width));
    rectangle.setAttribute('height', String(command.height));
    rectangle.setAttribute('fill', 'none');
    return rectangle;
  }
  const ellipse = createSvgElement('ellipse');
  ellipse.setAttribute('cx', String(command.x + command.width / 2));
  ellipse.setAttribute('cy', String(command.y + command.height / 2));
  ellipse.setAttribute('rx', String(command.width / 2));
  ellipse.setAttribute('ry', String(command.height / 2));
  ellipse.setAttribute('fill', 'none');
  return ellipse;
}

function appendSvgCommand(overlay: SVGSVGElement, command: AnnotationCommand): void {
  const group = createSvgElement('g');
  group.setAttribute('data-annotation-type', command.type);
  group.setAttribute('aria-hidden', 'true');
  const palette = annotationPaletteEntry(command.color);

  const halo = createSvgGeometry(command);
  halo.setAttribute('stroke', palette.halo);
  halo.setAttribute('stroke-width', String(ANNOTATION_HALO_WIDTH));
  const stroke = createSvgGeometry(command);
  stroke.setAttribute('data-annotation-stroke', '');
  stroke.setAttribute('stroke', palette.stroke);
  stroke.setAttribute('stroke-width', String(ANNOTATION_STROKE_WIDTH));
  group.append(halo, stroke);
  overlay.appendChild(group);
}

function renderSvgCommands(
  overlay: SVGSVGElement,
  commands: readonly AnnotationCommand[],
  draft: AnnotationCommand | null
): void {
  overlay.replaceChildren();
  for (const command of commands) appendSvgCommand(overlay, command);
  if (draft) appendSvgCommand(overlay, draft);
}

function createButton(label: string, text: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.textContent = text;
  return button;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter(element => !element.hasAttribute('hidden'));
}

/**
 * Creates and opens the accessible screenshot annotation dialog.
 * All pointer and keyboard listeners are scoped to the dialog subtree; this
 * feature deliberately registers no global shortcut.
 */
export function createFeedbackAnnotationModal(
  options: FeedbackAnnotationModalOptions
): FeedbackAnnotationModalController {
  if (!isUsableBitmap(options.image)) {
    throw new RangeError('Screenshot dimensions must be positive.');
  }

  const sequence = ++modalSequence;
  const titleId = `md4h-feedback-annotation-title-${sequence}`;
  const descriptionId = `md4h-feedback-annotation-description-${sequence}`;
  const inputId = `md4h-feedback-annotation-input-${sequence}`;
  const errorId = `md4h-feedback-annotation-error-${sequence}`;
  const mount = options.mount ?? document.body;
  const activeBeforeOpen =
    options.returnFocus ??
    (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const returnFocusControl = activeBeforeOpen?.getAttribute('data-feedback-control');
  const returnFocusIsCapture = activeBeforeOpen?.hasAttribute('data-feedback-capture') ?? false;
  const returnFocusCardId = activeBeforeOpen
    ?.closest<HTMLElement>('[data-feedback-card]')
    ?.getAttribute('data-feedback-card');
  const returnFocusCardAction =
    returnFocusCardId && activeBeforeOpen instanceof HTMLButtonElement
      ? activeBeforeOpen.textContent
      : null;
  const history = new AnnotationHistory();
  const bitmap = { width: options.image.width, height: options.image.height };
  let activeTool: AnnotationTool = 'rectangle';
  let activeColor: AnnotationColor = DEFAULT_ANNOTATION_COLOR;
  let draftCommand: AnnotationCommand | null = null;
  let dragStart: CapturePoint | null = null;
  let dragColor: AnnotationColor | null = null;
  let penPoints: CapturePoint[] = [];
  let activePointerId: number | null = null;
  let discardDialog: FeedbackDiscardDialogController | null = null;
  let destroyed = false;
  let busy = false;

  const dialog = document.createElement('section');
  dialog.className = 'feedback-annotation-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('data-md4h-modal', '');
  dialog.setAttribute('aria-labelledby', titleId);
  dialog.setAttribute('aria-describedby', descriptionId);

  const panel = document.createElement('div');
  panel.className = 'feedback-annotation-panel';
  const title = document.createElement('h2');
  title.id = titleId;
  title.textContent = 'Annotate screenshot';
  const description = document.createElement('p');
  description.id = descriptionId;
  description.textContent = 'Mark the screenshot if useful, then describe what should change.';

  const toolbar = document.createElement('div');
  toolbar.className = 'feedback-annotation-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Screenshot annotation tools');

  const toolButtons = new Map<AnnotationTool, HTMLButtonElement>();
  const toolDefinitions: readonly [AnnotationTool, string, string][] = [
    ['pen', 'Pen tool', 'Pen'],
    ['rectangle', 'Rectangle tool', 'Rectangle'],
    ['ellipse', 'Ellipse tool', 'Ellipse'],
  ];
  for (const [tool, label, text] of toolDefinitions) {
    const button = createButton(label, text);
    button.dataset.feedbackTool = tool;
    button.setAttribute('aria-pressed', String(tool === activeTool));
    toolButtons.set(tool, button);
    toolbar.appendChild(button);
  }

  const undoButton = createButton('Undo annotation', 'Undo');
  const redoButton = createButton('Redo annotation', 'Redo');
  const clearButton = createButton('Clear annotations', 'Clear');
  const colorGroup = document.createElement('div');
  colorGroup.className = 'feedback-annotation-colors';
  colorGroup.setAttribute('role', 'group');
  colorGroup.setAttribute('aria-label', 'Annotation color');
  const colorLabel = document.createElement('span');
  colorLabel.className = 'feedback-annotation-color-label';
  colorLabel.textContent = 'Color';
  colorLabel.setAttribute('aria-hidden', 'true');
  colorGroup.append(colorLabel);
  const colorButtons = new Map<AnnotationColor, HTMLButtonElement>();
  for (const palette of ANNOTATION_PALETTE) {
    const button = createButton(`${palette.label} annotation color`, '');
    button.className = 'feedback-annotation-color';
    button.dataset.feedbackColor = palette.color;
    button.title = palette.label;
    button.style.setProperty('--md4h-annotation-swatch', palette.stroke);
    button.setAttribute('aria-pressed', String(palette.color === activeColor));
    colorButtons.set(palette.color, button);
    colorGroup.append(button);
  }
  toolbar.append(colorGroup, undoButton, redoButton, clearButton);

  const preview = document.createElement('div');
  preview.className = 'feedback-annotation-preview';
  const surface = document.createElement('div');
  surface.className = 'feedback-annotation-surface';
  surface.style.width = `min(100%, ${bitmap.width}px, calc(52vh * ${bitmap.width / bitmap.height}))`;
  surface.style.aspectRatio = `${bitmap.width} / ${bitmap.height}`;
  const image = document.createElement('img');
  image.className = 'feedback-annotation-image';
  image.src = options.image.dataUrl;
  image.alt = 'Captured document area';
  image.draggable = false;
  const overlay = createSvgElement('svg');
  overlay.classList.add('feedback-annotation-overlay');
  overlay.setAttribute('viewBox', `0 0 ${bitmap.width} ${bitmap.height}`);
  overlay.setAttribute('preserveAspectRatio', 'none');
  overlay.setAttribute('role', 'img');
  overlay.setAttribute('aria-label', 'Screenshot annotation drawing surface');
  overlay.setAttribute('tabindex', '0');
  surface.append(image, overlay);
  preview.append(surface);

  const inputLabel = document.createElement('label');
  inputLabel.htmlFor = inputId;
  inputLabel.textContent = 'What should change?';
  const feedbackInput = document.createElement('textarea');
  feedbackInput.id = inputId;
  feedbackInput.value = options.initialFeedback ?? '';
  feedbackInput.required = true;
  feedbackInput.setAttribute('aria-describedby', errorId);
  const validation = document.createElement('div');
  validation.id = errorId;
  validation.className = 'feedback-annotation-validation';
  validation.setAttribute('aria-live', 'polite');

  const actions = document.createElement('div');
  actions.className = 'feedback-annotation-actions';
  const retakeButton = createButton('Retake screenshot', 'Retake');
  retakeButton.dataset.feedbackAction = 'retake';
  const cancelButton = createButton('Cancel screenshot feedback', 'Cancel');
  cancelButton.dataset.feedbackAction = 'cancel';
  const addButton = createButton('Add screenshot feedback', 'Add feedback');
  addButton.dataset.feedbackAction = 'add';
  actions.append(retakeButton, cancelButton, addButton);

  panel.append(
    title,
    description,
    toolbar,
    preview,
    inputLabel,
    feedbackInput,
    validation,
    actions
  );
  dialog.appendChild(panel);

  function updateHistoryButtons(): void {
    undoButton.disabled = busy || !history.canUndo;
    redoButton.disabled = busy || !history.canRedo;
    clearButton.disabled = busy || history.commands.length === 0;
  }

  function updateCancelState(): void {
    const dirty = feedbackInput.value.trim().length > 0 || history.commands.length > 0;
    cancelButton.textContent = dirty ? 'Discard' : 'Cancel';
    cancelButton.setAttribute(
      'aria-label',
      dirty ? 'Discard screenshot feedback' : 'Cancel screenshot feedback'
    );
  }

  function updateSubmissionState(): void {
    addButton.disabled = busy || feedbackInput.value.trim().length === 0;
    feedbackInput.readOnly = busy;
    retakeButton.disabled = busy;
    cancelButton.disabled = busy;
    for (const button of toolButtons.values()) button.disabled = busy;
    for (const button of colorButtons.values()) button.disabled = busy;
    updateHistoryButtons();
    updateCancelState();
    if (feedbackInput.value.trim().length > 0) {
      feedbackInput.removeAttribute('aria-invalid');
      validation.textContent = '';
    }
  }

  function render(): void {
    renderSvgCommands(overlay, history.commands, draftCommand);
    updateHistoryButtons();
    updateCancelState();
  }

  function reportError(error: unknown, userMessage: string): void {
    validation.textContent = userMessage;
    feedbackInput.setAttribute('aria-invalid', 'true');
    options.onError?.(error);
  }

  function restoreFocus(): void {
    const replacementCard = returnFocusCardId
      ? Array.from(document.querySelectorAll<HTMLElement>('[data-feedback-card]')).find(
          element => element.getAttribute('data-feedback-card') === returnFocusCardId
        )
      : undefined;
    const replacementCardTarget =
      (returnFocusCardAction
        ? Array.from(replacementCard?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
            button => button.textContent === returnFocusCardAction
          )
        : undefined) ?? replacementCard;
    const focusTarget =
      (activeBeforeOpen?.isConnected ? activeBeforeOpen : undefined) ??
      (returnFocusControl
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-feedback-control]')).find(
            element => element.getAttribute('data-feedback-control') === returnFocusControl
          )
        : undefined) ??
      (returnFocusIsCapture
        ? (document.querySelector<HTMLElement>('[data-feedback-capture]') ?? undefined)
        : undefined) ??
      replacementCardTarget ??
      (options.fallbackFocus?.isConnected ? options.fallbackFocus : undefined);
    if (!focusTarget) return;
    try {
      focusTarget.focus({ preventScroll: true });
    } catch {
      focusTarget.focus();
    }
  }

  function focus(): void {
    if (destroyed) return;
    if (discardDialog?.element.isConnected) {
      discardDialog.focus();
      return;
    }
    const target =
      toolButtons.get(activeTool) ??
      dialog.querySelector<HTMLElement>('button:not([disabled]), textarea:not([disabled])');
    if (!target) return;
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }
  }

  function close(shouldRestoreFocus = true): void {
    if (destroyed) return;
    destroyed = true;
    const activeDiscardDialog = discardDialog;
    discardDialog = null;
    activeDiscardDialog?.destroy();
    dialog.removeEventListener('keydown', handleDialogKeyDown);
    overlay.removeEventListener('pointerdown', handlePointerDown);
    overlay.removeEventListener('pointermove', handlePointerMove);
    overlay.removeEventListener('pointerup', handlePointerUp);
    overlay.removeEventListener('pointercancel', handlePointerCancel);
    window.removeEventListener('feedbackInvalidated', handleFeedbackLifecycleEnd);
    window.removeEventListener(FEEDBACK_SESSION_ENDED_EVENT, handleFeedbackLifecycleEnd);
    dialog.remove();
    if (shouldRestoreFocus) restoreFocus();
  }

  function handleFeedbackLifecycleEnd(): void {
    document.body.classList.remove('feedback-capture-active');
    close();
  }

  function setTool(tool: AnnotationTool): void {
    if (busy) return;
    activeTool = tool;
    draftCommand = null;
    dragStart = null;
    penPoints = [];
    for (const [candidate, button] of toolButtons) {
      button.setAttribute('aria-pressed', String(candidate === tool));
    }
    render();
  }

  function setColor(color: AnnotationColor): void {
    if (busy || !colorButtons.has(color)) return;
    activeColor = color;
    for (const [candidate, button] of colorButtons) {
      button.setAttribute('aria-pressed', String(candidate === color));
    }
  }

  function addCommand(command: AnnotationCommand): void {
    history.add(command);
    render();
  }

  function clientEventPoint(event: MouseEvent): CapturePoint {
    return clientPointToBitmap(
      { x: event.clientX, y: event.clientY },
      overlay.getBoundingClientRect(),
      bitmap
    );
  }

  function handlePointerDown(event: PointerEvent): void {
    if (destroyed || busy || event.button !== 0) return;
    event.preventDefault();
    activePointerId = Number.isInteger(event.pointerId) ? event.pointerId : null;
    if (activePointerId !== null && typeof overlay.setPointerCapture === 'function') {
      overlay.setPointerCapture(activePointerId);
    }
    dragStart = clientEventPoint(event);
    dragColor = activeColor;
    penPoints = [dragStart];
    draftCommand =
      activeTool === 'pen'
        ? { type: 'pen', points: penPoints.map(clonePoint), color: dragColor }
        : {
            ...createShapeAnnotation(activeTool, dragStart, dragStart, event.shiftKey, bitmap),
            color: dragColor,
          };
    render();
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!dragStart || destroyed || busy) return;
    const current = clientEventPoint(event);
    if (activeTool === 'pen') {
      const previous = penPoints[penPoints.length - 1];
      if (current.x !== previous.x || current.y !== previous.y) penPoints.push(current);
      draftCommand = {
        type: 'pen',
        points: penPoints.map(clonePoint),
        color: dragColor ?? activeColor,
      };
    } else {
      draftCommand = {
        ...createShapeAnnotation(activeTool, dragStart, current, event.shiftKey, bitmap),
        color: dragColor ?? activeColor,
      };
    }
    render();
  }

  function finishPointer(event: PointerEvent): void {
    if (!dragStart || destroyed || busy) return;
    handlePointerMove(event);
    if (draftCommand) {
      const hasArea =
        draftCommand.type === 'pen' || (draftCommand.width > 0 && draftCommand.height > 0);
      if (hasArea) history.add(draftCommand);
    }
    draftCommand = null;
    dragStart = null;
    dragColor = null;
    penPoints = [];
    if (
      activePointerId !== null &&
      typeof overlay.hasPointerCapture === 'function' &&
      overlay.hasPointerCapture(activePointerId)
    ) {
      overlay.releasePointerCapture(activePointerId);
    }
    activePointerId = null;
    render();
  }

  function handlePointerUp(event: PointerEvent): void {
    finishPointer(event);
  }

  function handlePointerCancel(): void {
    draftCommand = null;
    dragStart = null;
    dragColor = null;
    penPoints = [];
    activePointerId = null;
    render();
  }

  function undo(): boolean {
    const changed = history.undo();
    if (changed) render();
    return changed;
  }

  function redo(): boolean {
    const changed = history.redo();
    if (changed) render();
    return changed;
  }

  function clear(): boolean {
    const changed = history.clear();
    if (changed) render();
    return changed;
  }

  async function submit(): Promise<boolean> {
    if (destroyed || busy) return false;
    const feedback = feedbackInput.value.trim();
    if (!feedback) {
      reportError(new Error('Feedback is required.'), 'Describe what should change.');
      feedbackInput.focus();
      updateSubmissionState();
      return false;
    }

    busy = true;
    updateSubmissionState();
    try {
      const commands = history.commands;
      const pngDataUrl = flattenAnnotationsToPng(image, bitmap, commands, options.canvasFactory);
      await options.onAdd({ feedback, pngDataUrl, commands });
      close();
      return true;
    } catch (error) {
      busy = false;
      reportError(error, 'Could not add this screenshot. Your feedback is still here.');
      updateSubmissionState();
      return false;
    }
  }

  async function retake(): Promise<boolean> {
    if (destroyed || busy) return false;
    busy = true;
    updateSubmissionState();
    try {
      // Restore the logical invoker before the callback creates and focuses the
      // next crop surface. Closing afterwards must not steal that new focus.
      restoreFocus();
      await options.onRetake(feedbackInput.value);
      close(false);
      return true;
    } catch (error) {
      busy = false;
      reportError(error, 'Could not restart capture. Try again.');
      updateSubmissionState();
      feedbackInput.focus();
      return false;
    }
  }

  function finishCancel(): void {
    if (destroyed || busy) return;
    try {
      options.onCancel();
    } catch (error) {
      options.onError?.(error);
    } finally {
      close();
    }
  }

  function cancel(): void {
    if (destroyed || busy) return;
    if (discardDialog?.element.isConnected) {
      discardDialog.focus();
      return;
    }
    const dirty = feedbackInput.value.trim().length > 0 || history.commands.length > 0;
    if (!dirty) {
      finishCancel();
      return;
    }
    const confirmation = createFeedbackDiscardDialog({
      description:
        'Your unfinished comment and annotations will be lost. Saved feedback and the Feedback session will remain.',
      confirmLabel: 'Discard capture',
      returnFocus: feedbackInput,
      suspendedSurface: dialog,
    });
    discardDialog = confirmation;
    void confirmation.result.then(discard => {
      if (discardDialog !== confirmation) return;
      discardDialog = null;
      if (discard && !destroyed && !busy) finishCancel();
    });
  }

  function handleDialogKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = getFocusableElements(dialog);
    if (focusable.length === 0) return;
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? currentIndex <= 0
        ? focusable.length - 1
        : currentIndex - 1
      : currentIndex < 0 || currentIndex === focusable.length - 1
        ? 0
        : currentIndex + 1;
    event.preventDefault();
    focusable[nextIndex].focus();
  }

  for (const [tool, button] of toolButtons) {
    button.addEventListener('click', () => setTool(tool));
  }
  for (const [color, button] of colorButtons) {
    button.addEventListener('click', () => setColor(color));
  }
  undoButton.addEventListener('click', undo);
  redoButton.addEventListener('click', redo);
  clearButton.addEventListener('click', clear);
  feedbackInput.addEventListener('input', updateSubmissionState);
  retakeButton.addEventListener('click', () => void retake());
  cancelButton.addEventListener('click', cancel);
  addButton.addEventListener('click', () => void submit());
  dialog.addEventListener('keydown', handleDialogKeyDown);
  overlay.addEventListener('pointerdown', handlePointerDown);
  overlay.addEventListener('pointermove', handlePointerMove);
  overlay.addEventListener('pointerup', handlePointerUp);
  overlay.addEventListener('pointercancel', handlePointerCancel);
  window.addEventListener('feedbackInvalidated', handleFeedbackLifecycleEnd);
  window.addEventListener(FEEDBACK_SESSION_ENDED_EVENT, handleFeedbackLifecycleEnd);

  mount.appendChild(dialog);
  updateSubmissionState();
  render();
  focus();

  return {
    element: dialog,
    get tool(): AnnotationTool {
      return activeTool;
    },
    get color(): AnnotationColor {
      return activeColor;
    },
    get commands(): readonly AnnotationCommand[] {
      return history.commands;
    },
    focus,
    setTool,
    setColor,
    addCommand,
    undo,
    redo,
    clear,
    submit,
    retake,
    cancel,
    destroy: close,
  };
}
