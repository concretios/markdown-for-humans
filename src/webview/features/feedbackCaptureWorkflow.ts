/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Pointer and keyboard orchestration around the pure Feedback
 * capture/annotation primitives.
 */

import type { Editor } from '@tiptap/core';
import {
  FEEDBACK_SESSION_ENDED_EVENT,
  FeedbackCaptureError,
  captureVisibleArea,
  createFeedbackAnnotationModal,
  type CaptureBlock,
  type CapturePoint,
  type CaptureRectangle,
  type DomRasterizer,
  type VisibleAreaCapture,
} from './feedbackCapture';
import {
  createFeedbackDraftSurfaceGate,
  getFeedbackSelectionTarget,
  type FeedbackDraftSurfaceGate,
  type FeedbackDraftSurfaceKind,
  type FeedbackDraftSurfaceLease,
  type FeedbackReviewController,
  type FeedbackSessionView,
} from './feedbackReview';

export interface FeedbackCaptureWorkflowOptions {
  editor: Editor;
  review: FeedbackReviewController;
  rasterize: DomRasterizer;
  initialFeedback?: string;
  replaceId?: string;
  /** Logical invoker retained across Retake and asynchronous rasterization. */
  returnFocus?: HTMLElement;
  /**
   * Removes Feedback-only document decorations while pixels are generated.
   * Calls are balanced for every capture attempt, including failures and
   * cancellation while rasterization is still in flight.
   */
  setAnnotationsSuspended?: (suspended: boolean) => void;
}

type CaptureWorkflowKind = Extract<
  FeedbackDraftSurfaceKind,
  'area-capture' | 'capture-block-selector' | 'capture-rasterizing' | 'capture-annotation'
>;

interface ActiveCaptureWorkflow {
  kind: CaptureWorkflowKind;
  element?: HTMLElement;
  focus: () => void;
  dispose?: () => void;
  lease?: FeedbackDraftSurfaceLease;
}

const fallbackDraftSurfaceGates = new WeakMap<object, FeedbackDraftSurfaceGate>();
const captureChromeOwners = new Set<symbol>();
const AREA_CAPTURE_READY_INSTRUCTION =
  'Capture area ready. Drag over the visible document area. Press Escape to cancel.';

function visibleEditorViewport(root: HTMLElement): CaptureRectangle | null {
  const bounds = root.getBoundingClientRect();
  const left = Math.max(0, bounds.left);
  const top = Math.max(0, bounds.top);
  const right = Math.min(window.innerWidth, bounds.right);
  const bottom = Math.min(window.innerHeight, bounds.bottom);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Builds source-authoritative block handles without forcing layout. Detailed
 * geometry is deferred to the crop-bounded search in `captureVisibleArea`.
 */
function mappedBlocks(root: HTMLElement, session: FeedbackSessionView): CaptureBlock[] {
  const blocks: CaptureBlock[] = [];
  for (const anchor of session.anchors ?? []) {
    const element = root.children.item(anchor.ordinal);
    if (element instanceof HTMLElement) blocks.push({ index: anchor.ordinal, element });
  }
  return blocks;
}

function showCaptureError(message: string): void {
  window.dispatchEvent(new CustomEvent('feedbackLocalError', { detail: { message } }));
}

function focusCaptureSurface(element: HTMLElement): void {
  const target =
    (element.matches('[tabindex]:not([tabindex="-1"])') ? element : null) ??
    element.querySelector<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
  if (!target) return;
  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }
}

function draftSurfaceGateFor(review: FeedbackReviewController): FeedbackDraftSurfaceGate {
  if (review.draftSurfaceGate) return review.draftSurfaceGate;
  let gate = fallbackDraftSurfaceGates.get(review);
  if (!gate) {
    gate = createFeedbackDraftSurfaceGate();
    fallbackDraftSurfaceGates.set(review, gate);
  }
  return gate;
}

function releaseCaptureWorkflow(workflow: ActiveCaptureWorkflow): void {
  const lease = workflow.lease;
  if (!lease) return;
  workflow.lease = undefined;
  lease.release();
  const dispose = workflow.dispose;
  workflow.dispose = undefined;
  dispose?.();
}

function suspendCaptureChrome(): () => void {
  const owner = Symbol('feedback-capture-chrome');
  captureChromeOwners.add(owner);
  document.body.classList.add('feedback-capture-active');
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    captureChromeOwners.delete(owner);
    if (captureChromeOwners.size === 0) {
      document.body.classList.remove('feedback-capture-active');
    }
  };
}

/**
 * Makes the full-viewport crop selector the only interactive body surface.
 * Existing inert state is restored exactly, including for body children added
 * while toolbar state rerenders during capture.
 */
function isolateAreaCaptureSurface(surface: HTMLElement): () => void {
  const priorInertState = new Map<HTMLElement, boolean>();
  const isolate = (element: HTMLElement): void => {
    if (element === surface || element.contains(surface) || priorInertState.has(element)) return;
    priorInertState.set(element, element.inert);
    element.inert = true;
  };
  const isolateBodyChildren = (): void => {
    for (const child of Array.from(document.body.children)) {
      if (child instanceof HTMLElement) isolate(child);
    }
  };

  isolateBodyChildren();
  const observer =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => isolateBodyChildren())
      : null;
  observer?.observe(document.body, { childList: true });

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    observer?.disconnect();
    for (const [element, wasInert] of priorInertState) element.inert = wasInert;
    priorInertState.clear();
  };
}

/**
 * Keeps Command Palette and toolbar invocations inside one capture lifecycle.
 * Visible surfaces are focused, while an in-flight rasterization is left alone
 * so annotation suspension remains balanced around exactly one pixel request.
 */
function focusActiveCaptureWorkflow(review: FeedbackReviewController): boolean {
  const gate = draftSurfaceGateFor(review);
  const kind = gate.activeKind();
  if (!kind) return false;
  gate.focusActive();
  const message =
    kind === 'text-composer'
      ? 'Finish or cancel this comment before capturing.'
      : kind === 'text-block-selector'
        ? 'Choose blocks or cancel this feedback action before capturing.'
        : kind === 'finish-checkpoint'
          ? 'Resume feedback or finish the current completion step before capturing.'
          : kind === 'area-capture'
            ? 'An area capture is already active. Drag to select an area or cancel it.'
            : kind === 'capture-rasterizing'
              ? 'A Feedback capture is already being prepared.'
              : 'Finish or cancel the current capture before starting another.';
  showCaptureError(message);
  return true;
}

function claimCaptureWorkflow(
  review: FeedbackReviewController,
  workflow: ActiveCaptureWorkflow
): boolean {
  const lease = draftSurfaceGateFor(review).claim({
    kind: workflow.kind,
    ...(workflow.element ? { element: workflow.element } : {}),
    focus: workflow.focus,
  });
  if (!lease) return false;
  workflow.lease = lease;
  return true;
}

function updateCaptureWorkflowSurface(workflow: ActiveCaptureWorkflow): void {
  workflow.lease?.update({
    kind: workflow.kind,
    ...(workflow.element ? { element: workflow.element } : {}),
    focus: workflow.focus,
  });
}

function reportCaptureError(review: FeedbackReviewController, error: unknown): void {
  if (error instanceof FeedbackCaptureError) {
    review.reportCaptureError(error.code);
  }
}

type WritableFeedbackReviewController = FeedbackReviewController & {
  isWritable?: () => boolean;
  setAnnotationsSuspended?: (suspended: boolean) => void;
};

function isReviewWritable(review: FeedbackReviewController): boolean {
  const writableReview = review as WritableFeedbackReviewController;
  if (typeof writableReview.isWritable === 'function') {
    // The controller owns snapshot validity. The toolbar mirrors capture state
    // and deliberately disables itself while rasterizing, so consulting both
    // would reject an otherwise valid capture after its first pointer release.
    return writableReview.isWritable();
  }
  const captureControl = document.querySelector<HTMLButtonElement>('[data-feedback-capture]');
  return captureControl?.disabled !== true;
}

function snapshotChangedError(): FeedbackCaptureError {
  return new FeedbackCaptureError(
    'MD4H-FB-SNAPSHOT-001',
    'The Markdown source changed. Start a new Feedback snapshot before capturing.'
  );
}

function suspendAnnotations(options: FeedbackCaptureWorkflowOptions): () => void {
  const writableReview = options.review as WritableFeedbackReviewController;
  const setSuspended =
    options.setAnnotationsSuspended ?? writableReview.setAnnotationsSuspended?.bind(options.review);
  if (!setSuspended) return () => undefined;

  let restored = false;
  setSuspended(true);
  return () => {
    if (restored) return;
    restored = true;
    try {
      setSuspended(false);
    } catch (error) {
      // Restoration must not replace the capture error or leave cleanup half
      // complete. The controller can rebuild decorations on its next update.
      console.error('[MD4H] Feedback annotation restoration failed:', error);
    }
  };
}

function openAnnotation(
  options: FeedbackCaptureWorkflowOptions,
  capture: VisibleAreaCapture,
  draftFeedback: string,
  returnFocus: HTMLElement | undefined
): void {
  let controller: ReturnType<typeof createFeedbackAnnotationModal> | null = null;
  const handleFeedbackLifecycleEnd = (): void => releaseCaptureWorkflow(workflow);
  const workflow: ActiveCaptureWorkflow = {
    kind: 'capture-annotation',
    focus: () => {
      if (controller) focusCaptureSurface(controller.element);
    },
    dispose: () => {
      window.removeEventListener('feedbackInvalidated', handleFeedbackLifecycleEnd);
      window.removeEventListener(FEEDBACK_SESSION_ENDED_EVENT, handleFeedbackLifecycleEnd);
    },
  };
  if (!claimCaptureWorkflow(options.review, workflow)) return;
  window.addEventListener('feedbackInvalidated', handleFeedbackLifecycleEnd);
  window.addEventListener(FEEDBACK_SESSION_ENDED_EVENT, handleFeedbackLifecycleEnd);

  try {
    controller = createFeedbackAnnotationModal({
      image: capture.image,
      initialFeedback: draftFeedback,
      returnFocus,
      fallbackFocus: options.editor.view.dom as HTMLElement,
      onAdd: async submission => {
        if (!isReviewWritable(options.review)) throw snapshotChangedError();
        await options.review.addScreenshotFeedback({
          startOrdinal: capture.blockRange.firstBlock,
          endOrdinal: capture.blockRange.lastBlock,
          imageDataUrl: submission.pngDataUrl,
          feedback: submission.feedback,
          ...(options.replaceId ? { replaceId: options.replaceId } : {}),
        });
        releaseCaptureWorkflow(workflow);
      },
      onRetake: feedback => {
        if (!isReviewWritable(options.review)) throw snapshotChangedError();
        releaseCaptureWorkflow(workflow);
        startFeedbackAreaCapture({ ...options, initialFeedback: feedback, returnFocus });
      },
      onCancel: () => releaseCaptureWorkflow(workflow),
      onError: error => {
        reportCaptureError(options.review, error);
        console.error('[MD4H] Feedback annotation failed:', error);
      },
    });
    workflow.element = controller.element;
    updateCaptureWorkflowSurface(workflow);
  } catch (error) {
    releaseCaptureWorkflow(workflow);
    throw error;
  }
}

async function captureRectangle(
  options: FeedbackCaptureWorkflowOptions,
  start: CapturePoint,
  end: CapturePoint
): Promise<VisibleAreaCapture> {
  const session = options.review.getSession();
  const root = options.editor.view.dom as HTMLElement;
  const viewport = visibleEditorViewport(root);
  if (!session || !viewport) {
    throw new Error('The frozen editor is not visible for capture.');
  }
  if (!isReviewWritable(options.review)) throw snapshotChangedError();
  return captureVisibleArea({
    root,
    start,
    end,
    viewport,
    blocks: mappedBlocks(root, session),
    rasterize: options.rasterize,
    minimumSize: 8,
  });
}

/** Start the pointer-enhanced, visible-viewport rectangle selector. */
export function startFeedbackAreaCapture(options: FeedbackCaptureWorkflowOptions): void {
  const session = options.review.getSession();
  const root = options.editor.view.dom as HTMLElement;
  const viewport = visibleEditorViewport(root);
  if (!session || !viewport) {
    showCaptureError('Start Feedback and keep the rendered document visible before capturing.');
    return;
  }
  if (!isReviewWritable(options.review)) {
    showCaptureError(snapshotChangedError().message);
    return;
  }
  if (focusActiveCaptureWorkflow(options.review)) return;
  const returnFocus =
    options.returnFocus ??
    (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const returnFocusControl = returnFocus?.getAttribute('data-feedback-control');
  const resolveReturnFocus = (): HTMLElement | undefined => {
    if (returnFocus?.isConnected) return returnFocus;
    if (returnFocusControl) {
      return (
        document.querySelector<HTMLElement>(`[data-feedback-control="${returnFocusControl}"]`) ??
        undefined
      );
    }
    if (returnFocus?.hasAttribute('data-feedback-capture')) {
      return document.querySelector<HTMLElement>('[data-feedback-capture]') ?? undefined;
    }
    return undefined;
  };
  const overlay = document.createElement('div');
  overlay.className = 'feedback-area-capture';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Capture area for feedback');
  overlay.setAttribute('data-md4h-modal', '');
  overlay.setAttribute('aria-busy', 'false');
  overlay.tabIndex = 0;
  const instruction = document.createElement('div');
  instruction.className = 'feedback-capture-instruction';
  instruction.id = 'feedback-area-capture-instruction';
  instruction.textContent = AREA_CAPTURE_READY_INSTRUCTION;
  overlay.setAttribute('aria-describedby', instruction.id);
  const selection = document.createElement('div');
  selection.className = 'feedback-capture-selection';
  selection.hidden = true;
  const error = document.createElement('div');
  error.className = 'feedback-capture-error';
  error.setAttribute('role', 'status');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Retry';
  retry.hidden = true;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'feedback-capture-cancel';
  cancel.textContent = 'Cancel';
  overlay.append(instruction, selection, error, retry, cancel);
  let start: CapturePoint | null = null;
  let end: CapturePoint | null = null;
  let busy = false;
  let closed = false;
  let restoreAnnotations: (() => void) | null = null;
  let restoreChrome: (() => void) | null = null;
  let restoreBackground: (() => void) | null = null;

  const restoreCaptureAnnotations = (): void => {
    restoreAnnotations?.();
    restoreAnnotations = null;
  };
  const restoreCaptureChrome = (): void => {
    restoreChrome?.();
    restoreChrome = null;
  };
  const restoreCaptureBackground = (): void => {
    restoreBackground?.();
    restoreBackground = null;
  };

  const renderSelection = (): void => {
    if (!start || !end) return;
    const left = Math.max(viewport.left, Math.min(start.x, end.x));
    const top = Math.max(viewport.top, Math.min(start.y, end.y));
    const right = Math.min(viewport.left + viewport.width, Math.max(start.x, end.x));
    const bottom = Math.min(viewport.top + viewport.height, Math.max(start.y, end.y));
    selection.hidden = false;
    selection.style.left = `${left}px`;
    selection.style.top = `${top}px`;
    selection.style.width = `${Math.max(0, right - left)}px`;
    selection.style.height = `${Math.max(0, bottom - top)}px`;
  };

  const cleanup = (restoreFocus = true): void => {
    if (closed) return;
    closed = true;
    window.removeEventListener('feedbackInvalidated', handleFeedbackLifecycleEnd);
    window.removeEventListener(FEEDBACK_SESSION_ENDED_EVENT, handleFeedbackLifecycleEnd);
    window.removeEventListener('feedbackCaptureCancelRequested', handleToolbarCancel);
    document.removeEventListener('keydown', handleCaptureKeyDown, true);
    document.removeEventListener('focusin', handleCaptureFocus, true);
    restoreCaptureAnnotations();
    restoreCaptureChrome();
    restoreCaptureBackground();
    overlay.remove();
    releaseCaptureWorkflow(workflow);
    document.body.removeAttribute('data-feedback-capture-state');
    options.review.setCaptureState?.('idle');
    const focusTarget = resolveReturnFocus();
    if (restoreFocus && focusTarget) {
      try {
        focusTarget.focus({ preventScroll: true });
      } catch {
        focusTarget.focus();
      }
    }
  };
  const cancelCapture = (): void => cleanup(true);
  const handleFeedbackLifecycleEnd = (): void => cancelCapture();
  const handleToolbarCancel = (): void => cancelCapture();
  const handleCaptureKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelCapture();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable: HTMLElement[] = [overlay, retry, cancel].filter(
      element => !element.hidden && !element.hasAttribute('disabled')
    );
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
    event.stopPropagation();
    focusable[nextIndex].focus();
  };
  const handleCaptureFocus = (event: FocusEvent): void => {
    if (event.target instanceof Node && overlay.contains(event.target)) return;
    focusCaptureSurface(overlay);
  };
  const workflow: ActiveCaptureWorkflow = {
    kind: 'area-capture',
    element: overlay,
    focus: () => focusCaptureSurface(overlay),
  };
  if (!claimCaptureWorkflow(options.review, workflow)) return;
  document.body.append(overlay);
  restoreBackground = isolateAreaCaptureSurface(overlay);
  restoreChrome = suspendCaptureChrome();
  document.body.setAttribute('data-feedback-capture-state', 'armed');
  options.review.setCaptureState?.('armed');
  window.addEventListener('feedbackInvalidated', handleFeedbackLifecycleEnd);
  window.addEventListener(FEEDBACK_SESSION_ENDED_EVENT, handleFeedbackLifecycleEnd);
  window.addEventListener('feedbackCaptureCancelRequested', handleToolbarCancel);
  document.addEventListener('keydown', handleCaptureKeyDown, true);
  document.addEventListener('focusin', handleCaptureFocus, true);

  const complete = async (): Promise<void> => {
    if (!start || !end || busy || closed) return;
    busy = true;
    workflow.kind = 'capture-rasterizing';
    updateCaptureWorkflowSurface(workflow);
    retry.hidden = true;
    error.textContent = '';
    overlay.classList.add('rasterizing');
    overlay.setAttribute('aria-busy', 'true');
    instruction.textContent = 'Preparing capture…';
    document.body.setAttribute('data-feedback-capture-state', 'rasterizing');
    options.review.setCaptureState?.('rasterizing');
    try {
      restoreCaptureAnnotations();
      restoreAnnotations = suspendAnnotations(options);
      const capture = await captureRectangle(options, start, end);
      if (closed || !isReviewWritable(options.review)) return;
      cleanup(false);
      openAnnotation(options, capture, options.initialFeedback ?? '', resolveReturnFocus());
    } catch (captureError) {
      if (closed) return;
      reportCaptureError(options.review, captureError);
      busy = false;
      workflow.kind = 'area-capture';
      updateCaptureWorkflowSurface(workflow);
      overlay.classList.remove('rasterizing');
      overlay.setAttribute('aria-busy', 'false');
      instruction.textContent = AREA_CAPTURE_READY_INSTRUCTION;
      document.body.setAttribute('data-feedback-capture-state', 'armed');
      options.review.setCaptureState?.('armed');
      const message =
        captureError instanceof Error
          ? captureError.message
          : 'The selected area could not be captured.';
      error.textContent = message;
      retry.hidden = false;
    } finally {
      restoreCaptureAnnotations();
    }
  };

  overlay.addEventListener('pointerdown', event => {
    if (busy || event.button !== 0 || event.target instanceof HTMLButtonElement) return;
    if (
      event.clientX < viewport.left ||
      event.clientX > viewport.left + viewport.width ||
      event.clientY < viewport.top ||
      event.clientY > viewport.top + viewport.height
    ) {
      return;
    }
    event.preventDefault();
    start = { x: event.clientX, y: event.clientY };
    end = { ...start };
    overlay.setPointerCapture?.(event.pointerId);
    renderSelection();
  });
  overlay.addEventListener('pointermove', event => {
    if (!start || busy) return;
    event.preventDefault();
    end = { x: event.clientX, y: event.clientY };
    renderSelection();
  });
  overlay.addEventListener('pointerup', event => {
    if (!start || busy) return;
    event.preventDefault();
    end = { x: event.clientX, y: event.clientY };
    renderSelection();
    void complete();
  });
  overlay.addEventListener('wheel', event => event.preventDefault(), { passive: false });
  retry.addEventListener('click', () => void complete());
  cancel.addEventListener('click', cancelCapture);
  overlay.focus();
}

interface PreparedBlockCaptureRectangle {
  start: CapturePoint;
  end: CapturePoint;
}

function rectangleIsFullyVisible(rectangle: DOMRect, viewport: CaptureRectangle): boolean {
  const viewportRight = viewport.left + viewport.width;
  const viewportBottom = viewport.top + viewport.height;
  return (
    Number.isFinite(rectangle.left) &&
    Number.isFinite(rectangle.top) &&
    Number.isFinite(rectangle.right) &&
    Number.isFinite(rectangle.bottom) &&
    rectangle.width > 0 &&
    rectangle.height > 0 &&
    rectangle.left >= viewport.left &&
    rectangle.top >= viewport.top &&
    rectangle.right <= viewportRight &&
    rectangle.bottom <= viewportBottom
  );
}

/**
 * Resolves one keyboard-selected range without relying on the later crop clamp.
 * Every mapped block must be rendered and fully visible so the resulting image
 * cannot silently omit evidence above, below, or beside the editor viewport.
 */
function prepareBlockCaptureRectangle(
  options: FeedbackCaptureWorkflowOptions,
  startOrdinal: number,
  endOrdinal: number
): PreparedBlockCaptureRectangle {
  const session = options.review.getSession();
  const root = options.editor.view.dom as HTMLElement;
  const viewport = visibleEditorViewport(root);
  if (!session || !viewport) {
    throw new FeedbackCaptureError(
      'MD4H-FB-ANCHOR-001',
      'The selected Markdown blocks are not visible for capture.'
    );
  }
  if (!isReviewWritable(options.review)) throw snapshotChangedError();

  const first = Math.min(startOrdinal, endOrdinal);
  const last = Math.max(startOrdinal, endOrdinal);
  const selectedOrdinals = [...new Set((session.anchors ?? []).map(anchor => anchor.ordinal))]
    .filter(ordinal => ordinal >= first && ordinal <= last)
    .sort((left, right) => left - right);
  const rectangles: DOMRect[] = [];
  if (
    selectedOrdinals.length === 0 ||
    selectedOrdinals[0] !== first ||
    selectedOrdinals[selectedOrdinals.length - 1] !== last
  ) {
    throw new FeedbackCaptureError(
      'MD4H-FB-ANCHOR-001',
      'The selected Markdown blocks are not rendered.'
    );
  }
  for (const ordinal of selectedOrdinals) {
    const element = root.children.item(ordinal);
    if (!(element instanceof HTMLElement)) {
      throw new FeedbackCaptureError(
        'MD4H-FB-ANCHOR-001',
        'The selected Markdown blocks are not rendered.'
      );
    }
    const rectangle = element.getBoundingClientRect();
    if (!rectangleIsFullyVisible(rectangle, viewport)) {
      throw new FeedbackCaptureError(
        'MD4H-FB-ANCHOR-001',
        'The selected blocks are not fully visible. Scroll until the entire range is visible, then retry.'
      );
    }
    rectangles.push(rectangle);
  }
  if (rectangles.length === 0) {
    throw new FeedbackCaptureError(
      'MD4H-FB-ANCHOR-001',
      'The selected Markdown blocks are not rendered.'
    );
  }
  return {
    start: {
      x: Math.min(...rectangles.map(rectangle => rectangle.left)),
      y: Math.min(...rectangles.map(rectangle => rectangle.top)),
    },
    end: {
      x: Math.max(...rectangles.map(rectangle => rectangle.right)),
      y: Math.max(...rectangles.map(rectangle => rectangle.bottom)),
    },
  };
}

async function captureBlockRange(
  options: FeedbackCaptureWorkflowOptions,
  startOrdinal: number,
  endOrdinal: number,
  returnFocus: HTMLElement | undefined,
  preparedRectangle?: PreparedBlockCaptureRectangle
): Promise<void> {
  const session = options.review.getSession();
  if (!session) return;
  if (!isReviewWritable(options.review)) throw snapshotChangedError();
  const root = options.editor.view.dom as HTMLElement;
  const rectangle =
    preparedRectangle ?? prepareBlockCaptureRectangle(options, startOrdinal, endOrdinal);

  const workflow: ActiveCaptureWorkflow = {
    kind: 'capture-rasterizing',
    focus: () => {
      const target = returnFocus?.isConnected ? returnFocus : root;
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
      }
    },
  };
  if (!claimCaptureWorkflow(options.review, workflow)) return;

  let aborted = false;
  let restoreAnnotations: (() => void) | null = null;
  let restoreChrome: (() => void) | null = suspendCaptureChrome();
  let captureStateActive = true;
  document.body.setAttribute('data-feedback-capture-state', 'rasterizing');
  options.review.setCaptureState?.('rasterizing');
  const restoreCaptureAnnotations = (): void => {
    restoreAnnotations?.();
    restoreAnnotations = null;
  };
  const restoreCaptureChrome = (): void => {
    restoreChrome?.();
    restoreChrome = null;
  };
  const restoreCaptureState = (): void => {
    if (!captureStateActive) return;
    captureStateActive = false;
    document.body.removeAttribute('data-feedback-capture-state');
    options.review.setCaptureState?.('idle');
  };
  const removeAbortListeners = (): void => {
    window.removeEventListener('feedbackInvalidated', abortCapture);
    window.removeEventListener(FEEDBACK_SESSION_ENDED_EVENT, abortCapture);
  };
  const abortCapture = (): void => {
    if (aborted) return;
    aborted = true;
    removeAbortListeners();
    restoreCaptureAnnotations();
    restoreCaptureChrome();
    restoreCaptureState();
    releaseCaptureWorkflow(workflow);
  };
  window.addEventListener('feedbackInvalidated', abortCapture);
  window.addEventListener(FEEDBACK_SESSION_ENDED_EVENT, abortCapture);

  let capture: VisibleAreaCapture | null = null;
  try {
    restoreAnnotations = suspendAnnotations(options);
    capture = await captureRectangle(options, rectangle.start, rectangle.end);
  } catch (error) {
    if (!aborted) throw error;
  } finally {
    restoreCaptureAnnotations();
    restoreCaptureChrome();
    restoreCaptureState();
    removeAbortListeners();
    releaseCaptureWorkflow(workflow);
  }
  if (aborted || !capture) return;
  if (!isReviewWritable(options.review)) throw snapshotChangedError();
  openAnnotation(options, capture, options.initialFeedback ?? '', returnFocus);
}

function openKeyboardBlockSelector(options: FeedbackCaptureWorkflowOptions): void {
  const session = options.review.getSession();
  if (!session?.anchors?.length) {
    showCaptureError('No mappable Markdown blocks are available to capture.');
    return;
  }
  if (!isReviewWritable(options.review)) {
    showCaptureError(snapshotChangedError().message);
    return;
  }
  const dialog = document.createElement('form');
  dialog.className = 'feedback-block-selector';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('data-md4h-modal', '');
  const title = document.createElement('h2');
  title.id = 'feedback-block-selector-title';
  title.textContent = 'Capture block range';
  dialog.setAttribute('aria-labelledby', title.id);
  const start = document.createElement('select');
  const end = document.createElement('select');
  const startLabel = document.createElement('label');
  startLabel.textContent = 'First block';
  startLabel.append(start);
  const endLabel = document.createElement('label');
  endLabel.textContent = 'Last block';
  endLabel.append(end);
  for (const anchor of session.anchors) {
    const label = `Block ${anchor.ordinal + 1}, lines ${anchor.startLine}-${anchor.endLine}`;
    start.add(new Option(label, String(anchor.ordinal)));
    end.add(new Option(label, String(anchor.ordinal)));
  }
  end.selectedIndex = end.options.length - 1;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Capture blocks';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const validation = document.createElement('p');
  validation.id = 'feedback-block-selector-error';
  validation.className = 'feedback-annotation-validation';
  validation.setAttribute('role', 'status');
  validation.setAttribute('aria-live', 'polite');
  start.setAttribute('aria-describedby', validation.id);
  end.setAttribute('aria-describedby', validation.id);
  dialog.append(title, startLabel, endLabel, validation, submit, cancel);
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const close = (): void => {
    window.removeEventListener('feedbackInvalidated', close);
    window.removeEventListener(FEEDBACK_SESSION_ENDED_EVENT, close);
    dialog.remove();
    releaseCaptureWorkflow(workflow);
    if (returnFocus?.isConnected) returnFocus.focus();
  };
  const workflow: ActiveCaptureWorkflow = {
    kind: 'capture-block-selector',
    element: dialog,
    focus: () => focusCaptureSurface(dialog),
  };
  if (!claimCaptureWorkflow(options.review, workflow)) return;
  document.body.append(dialog);
  window.addEventListener('feedbackInvalidated', close);
  window.addEventListener(FEEDBACK_SESSION_ENDED_EVENT, close);
  cancel.addEventListener('click', close);
  const clearValidation = (): void => {
    validation.textContent = '';
    start.removeAttribute('aria-invalid');
    end.removeAttribute('aria-invalid');
  };
  start.addEventListener('change', clearValidation);
  end.addEventListener('change', clearValidation);
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>('select, button:not([disabled])')
    );
    if (focusable.length === 0) return;
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && currentIndex <= 0) {
      event.preventDefault();
      focusable[focusable.length - 1].focus();
    } else if (!event.shiftKey && currentIndex === focusable.length - 1) {
      event.preventDefault();
      focusable[0].focus();
    }
  });
  dialog.addEventListener('submit', event => {
    event.preventDefault();
    const first = Math.min(Number(start.value), Number(end.value));
    const last = Math.max(Number(start.value), Number(end.value));
    let rectangle: PreparedBlockCaptureRectangle;
    try {
      rectangle = prepareBlockCaptureRectangle(options, first, last);
    } catch (error) {
      reportCaptureError(options.review, error);
      validation.textContent =
        error instanceof Error ? error.message : 'Could not capture those blocks.';
      start.setAttribute('aria-invalid', 'true');
      end.setAttribute('aria-invalid', 'true');
      return;
    }
    clearValidation();
    close();
    void captureBlockRange(options, first, last, returnFocus ?? undefined, rectangle).catch(
      error => {
        reportCaptureError(options.review, error);
        showCaptureError(
          error instanceof Error ? error.message : 'Could not capture those blocks.'
        );
      }
    );
  });
  start.focus();
}

/** Keyboard-accessible capture using the current selection or a block picker. */
export function captureSelectedFeedbackBlocks(options: FeedbackCaptureWorkflowOptions): void {
  const session = options.review.getSession();
  if (!session) return;
  if (!isReviewWritable(options.review)) {
    showCaptureError(snapshotChangedError().message);
    return;
  }
  if (focusActiveCaptureWorkflow(options.review)) return;
  const returnFocus =
    options.returnFocus ??
    (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const target = getFeedbackSelectionTarget(options.editor, session.anchors ?? []);
  if (!target) {
    openKeyboardBlockSelector(options);
    return;
  }
  void captureBlockRange(options, target.startOrdinal, target.endOrdinal, returnFocus).catch(
    error => {
      reportCaptureError(options.review, error);
      showCaptureError(error instanceof Error ? error.message : 'Could not capture the selection.');
    }
  );
}
