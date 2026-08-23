/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview DOM rasterization adapter for Feedback screenshots. It builds
 * a temporary, viewport-sized stage containing only intersecting top-level
 * blocks, waits for their asynchronous Mermaid/resource lifecycle, then
 * delegates PNG generation to modern-screenshot.
 */

import type { Options as ModernScreenshotOptions } from 'modern-screenshot';
import {
  FeedbackCaptureError,
  rectanglesIntersect,
  type CaptureRectangle,
  type DomRasterizer,
} from './feedbackCapture';

export type ModernScreenshotFunction = (
  node: Node,
  options?: ModernScreenshotOptions
) => Promise<string>;

const MAX_PIXELS = 12_000_000;
const MAX_DATA_URL_LENGTH = 14 * 1024 * 1024;
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

function resourceUrls(root: HTMLElement): string[] {
  const urls: string[] = [];
  root.querySelectorAll<HTMLImageElement>('img').forEach(image => {
    urls.push(image.currentSrc || image.src || image.getAttribute('src') || '');
  });
  root.querySelectorAll<SVGImageElement>('image').forEach(image => {
    urls.push(image.getAttribute('href') || image.getAttribute('xlink:href') || '');
  });
  root.querySelectorAll<HTMLElement>('*').forEach(element => {
    const background = window.getComputedStyle(element).backgroundImage;
    for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      urls.push(match[1]);
    }
  });
  return urls;
}

/** Fail closed when a rendered block references a non-webview resource. */
export function validateCaptureResources(root: HTMLElement): void {
  const unavailable = resourceUrls(root).find(url => !isAllowedResourceUrl(url));
  if (unavailable) {
    throw new FeedbackCaptureError(
      'MD4H-FB-CAPTURE-001',
      'A rendered image or background is not available through the VS Code webview resource boundary.'
    );
  }
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new FeedbackCaptureError('MD4H-FB-CAPTURE-001', message));
    }, RESOURCE_TIMEOUT_MS);
    promise.then(
      value => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      error => {
        window.clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

async function waitForRenderedResources(root: HTMLElement): Promise<void> {
  if ('fonts' in document && document.fonts?.ready) {
    await withTimeout(
      document.fonts.ready.then(() => undefined),
      'The document fonts did not become ready for capture.'
    );
  }

  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img'));
  await Promise.all(
    images.map(async image => {
      if (image.complete && image.naturalWidth > 0) return;
      if (typeof image.decode === 'function') {
        try {
          await withTimeout(image.decode(), 'A rendered image did not become ready for capture.');
          return;
        } catch (error) {
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

  await new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** Remove capture-only UI while preserving prose wrapped by decorations. */
function sanitizeCaptureClone(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(CAPTURE_CHROME_SELECTOR).forEach(node => node.remove());
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  elements.forEach(element => {
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
  rectangle: CaptureRectangle
): IntersectingCaptureChild[] {
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
    const element = children[index];
    const bounds = readRectangle(element);
    if (rectanglesIntersect(rectangle, domRectangle(bounds))) {
      intersections.push({ element, bounds });
    }
  }
  return intersections;
}

function intersectingMermaidWrappers(
  intersections: readonly IntersectingCaptureChild[],
  rectangle: CaptureRectangle
): HTMLElement[] {
  const wrappers = new Set<HTMLElement>();
  intersections.forEach(({ element, bounds }) => {
    const candidates = [
      ...(element.matches(MERMAID_WRAPPER_SELECTOR) ? [element] : []),
      ...Array.from(element.querySelectorAll<HTMLElement>(MERMAID_WRAPPER_SELECTOR)),
    ];
    candidates.forEach(wrapper => {
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

async function waitForPendingMermaid(wrapper: HTMLElement): Promise<void> {
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
      'A Mermaid diagram did not become ready before the capture timeout.'
    );
  } finally {
    observer?.disconnect();
  }
}

async function waitForIntersectingMermaid(
  intersections: readonly IntersectingCaptureChild[],
  rectangle: CaptureRectangle
): Promise<boolean> {
  const wrappers = intersectingMermaidWrappers(intersections, rectangle);
  const pending: HTMLElement[] = [];
  for (const wrapper of wrappers) {
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
  await Promise.all(pending.map(waitForPendingMermaid));
  return pending.length > 0;
}

function buildCaptureStage(
  root: HTMLElement,
  rectangle: CaptureRectangle,
  intersections: readonly IntersectingCaptureChild[]
): HTMLElement {
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
  sanitizeCaptureClone(content);
  content.style.position = 'absolute';
  content.style.left = `${rootBounds.left - rectangle.left}px`;
  content.style.top = `${rootBounds.top - rectangle.top}px`;
  content.style.width = `${rootBounds.width}px`;
  content.style.height = `${rootBounds.height}px`;
  content.style.margin = '0';
  content.style.boxSizing = 'border-box';

  intersections.forEach(({ element, bounds }) => {
    assertIntersectingBlockIsCloneable(element, rectangle);
    const clone = element.cloneNode(true) as HTMLElement;
    clone.setAttribute('data-feedback-captured-block', '');
    clone.style.position = 'absolute';
    clone.style.left = `${bounds.left - rootBounds.left}px`;
    clone.style.top = `${bounds.top - rootBounds.top}px`;
    clone.style.width = `${bounds.width}px`;
    clone.style.height = `${bounds.height}px`;
    clone.style.margin = '0';
    clone.style.boxSizing = 'border-box';
    sanitizeCaptureClone(clone);
    content.append(clone);
  });

  stage.append(content);
  document.body.append(stage);
  return stage;
}

function assertIntersectingBlockIsCloneable(block: HTMLElement, rectangle: CaptureRectangle): void {
  const elements = [block, ...Array.from(block.querySelectorAll<HTMLElement>('*'))];
  for (const element of elements) {
    const isOpaque = element.tagName === 'CANVAS' || element.shadowRoot !== null;
    if (!isOpaque) continue;
    const bounds = domRectangle(element.getBoundingClientRect());
    if (!rectanglesIntersect(rectangle, bounds)) continue;
    throw new FeedbackCaptureError(
      'MD4H-FB-CAPTURE-001',
      element.tagName === 'CANVAS'
        ? 'The selected area contains a canvas that cannot be cloned faithfully for feedback capture.'
        : 'The selected area contains an opaque rendered component that cannot be cloned faithfully for feedback capture.'
    );
  }
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
    const scale = captureScale(request.rectangle, request.scale);
    let stage: HTMLElement | null = null;
    try {
      let intersections = intersectingCaptureChildren(request.root, request.rectangle);
      const waitedForMermaid = await waitForIntersectingMermaid(intersections, request.rectangle);
      if (waitedForMermaid) {
        // Mermaid SVG layout can change block geometry. Re-run the same bounded
        // binary-search discovery only when an intersecting render completed.
        intersections = intersectingCaptureChildren(request.root, request.rectangle);
      }
      stage = buildCaptureStage(request.root, request.rectangle, intersections);
      validateCaptureResources(stage);
      await waitForRenderedResources(stage);
      const rasterize = screenshot ?? (await loadDefaultScreenshot());
      const dataUrl = await rasterize(stage, {
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
          requestInit: { cache: 'force-cache', credentials: 'omit', mode: 'cors' },
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
      });
      if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > MAX_DATA_URL_LENGTH) {
        throw new FeedbackCaptureError(
          'MD4H-FB-CAPTURE-002',
          'The screenshot could not be encoded within the 10 MiB feedback limit.'
        );
      }
      return {
        dataUrl,
        width: Math.floor(request.rectangle.width * scale),
        height: Math.floor(request.rectangle.height * scale),
      };
    } catch (error) {
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
