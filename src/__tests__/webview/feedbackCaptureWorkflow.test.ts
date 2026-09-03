/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import type { Editor } from '@tiptap/core';
import {
  captureSelectedFeedbackBlocks,
  startFeedbackAreaCapture,
} from '../../webview/features/feedbackCaptureWorkflow';
import * as feedbackCaptureModule from '../../webview/features/feedbackCapture';
import {
  FeedbackCaptureError,
  type DomRasterizeRequest,
} from '../../webview/features/feedbackCapture';
import {
  createFeedbackDraftSurfaceGate,
  type FeedbackReviewController,
} from '../../webview/features/feedbackReview';

describe('keyboard Feedback block selector', () => {
  function domRectangle(left: number, top: number, right: number, bottom: number): DOMRect {
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    } as DOMRect;
  }

  function openGeometricBlockSelector(options: {
    blockRectangles: DOMRect[];
    rootRectangle?: DOMRect;
    anchorOrdinals?: number[];
  }): {
    dialog: HTMLFormElement;
    blockRectangles: DOMRect[];
    rasterize: jest.Mock;
    addScreenshotFeedback: jest.Mock;
    reportCaptureError: jest.Mock;
    setAnnotationsSuspended: jest.Mock;
  } {
    const blockRectangles = [...options.blockRectangles];
    const editorDom = document.createElement('div');
    const anchorOrdinals = options.anchorOrdinals ?? blockRectangles.map((_, ordinal) => ordinal);
    const anchors = blockRectangles.map((_, index) => ({
      ordinal: anchorOrdinals[index],
      startLine: index * 2 + 1,
      endLine: index * 2 + 2,
    }));
    const rectangleIndexByOrdinal = new Map(
      anchorOrdinals.map((ordinal, index) => [ordinal, index] as const)
    );
    const lastOrdinal = Math.max(...anchorOrdinals);
    for (let ordinal = 0; ordinal <= lastOrdinal; ordinal += 1) {
      const rectangleIndex = rectangleIndexByOrdinal.get(ordinal);
      const block = document.createElement('p');
      if (rectangleIndex !== undefined) {
        const renderedContent = document.createElement('img');
        block.append(renderedContent);
        block.getBoundingClientRect = () => blockRectangles[rectangleIndex];
        renderedContent.getBoundingClientRect = () => blockRectangles[rectangleIndex];
      }
      editorDom.append(block);
    }
    editorDom.getBoundingClientRect = () =>
      options.rootRectangle ?? domRectangle(0, -300, 700, 1000);
    document.body.append(editorDom);
    const editor = {
      state: { selection: { empty: true, from: 1, to: 1 } },
      view: { dom: editorDom },
    } as unknown as Editor;
    const addScreenshotFeedback = jest.fn();
    const reportCaptureError = jest.fn();
    const setAnnotationsSuspended = jest.fn();
    const draftSurfaceGate = createFeedbackDraftSurfaceGate();
    const review = {
      draftSurfaceGate,
      getSession: () => ({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        anchors,
        items: [],
      }),
      isWritable: () => true,
      addScreenshotFeedback,
      reportCaptureError,
      setAnnotationsSuspended,
    } as unknown as FeedbackReviewController;
    const rasterize = jest.fn(async () => ({
      dataUrl: 'data:image/png;base64,AAAA',
      width: 100,
      height: 60,
    }));

    captureSelectedFeedbackBlocks({ editor, review, rasterize });
    return {
      dialog: document.querySelector<HTMLFormElement>('.feedback-block-selector')!,
      blockRectangles,
      rasterize,
      addScreenshotFeedback,
      reportCaptureError,
      setAnnotationsSuspended,
    };
  }

  function openSelector(): HTMLFormElement {
    const editorDom = document.createElement('div');
    document.body.append(editorDom);
    const editor = {
      state: { selection: { empty: true, from: 1, to: 1 } },
      view: { dom: editorDom },
    } as unknown as Editor;
    const review = {
      getSession: () => ({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        anchors: [
          { ordinal: 0, startLine: 1, endLine: 2 },
          { ordinal: 1, startLine: 3, endLine: 4 },
        ],
        items: [],
      }),
    } as unknown as FeedbackReviewController;

    captureSelectedFeedbackBlocks({ editor, review, rasterize: jest.fn() });
    return document.querySelector<HTMLFormElement>('.feedback-block-selector')!;
  }

  afterEach(() => {
    window.dispatchEvent(new CustomEvent('feedbackSessionEnded'));
    document.body.removeAttribute('data-feedback-capture-state');
    document.body.replaceChildren();
    jest.restoreAllMocks();
  });

  it('does not open either capture surface when the review is not writable', () => {
    const editorDom = document.createElement('div');
    editorDom.append(document.createElement('p'));
    editorDom.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 }) as DOMRect;
    document.body.append(editorDom);
    const editor = {
      state: { selection: { empty: true, from: 1, to: 1 } },
      view: { dom: editorDom },
    } as unknown as Editor;
    const review = {
      getSession: () => ({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 2 }],
        items: [],
      }),
      isWritable: () => false,
    } as unknown as FeedbackReviewController;

    startFeedbackAreaCapture({ editor, review, rasterize: jest.fn() });
    captureSelectedFeedbackBlocks({ editor, review, rasterize: jest.fn() });

    expect(document.querySelector('.feedback-area-capture')).toBeNull();
    expect(document.querySelector('.feedback-block-selector')).toBeNull();
  });

  it.each([
    {
      edge: 'above',
      rectangles: [domRectangle(50, -24, 650, 72), domRectangle(50, 96, 650, 176)],
    },
    {
      edge: 'below',
      rectangles: [domRectangle(50, 620, 650, 700), domRectangle(50, 724, 650, 804)],
    },
  ])(
    'keeps a partially $edge viewport range in the picker with a recoverable error',
    ({ rectangles }) => {
      const harness = openGeometricBlockSelector({ blockRectangles: rectangles });
      const [start, end] = harness.dialog.querySelectorAll('select');
      start.value = '0';
      end.value = '1';

      harness.dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      expect(document.querySelector('.feedback-block-selector')).toBe(harness.dialog);
      expect(start.value).toBe('0');
      expect(end.value).toBe('1');
      expect(harness.dialog.querySelector('[role="status"]')?.textContent).toBe(
        'The selected blocks are not fully visible. Scroll until the entire range is visible, then retry.'
      );
      expect(start.getAttribute('aria-invalid')).toBe('true');
      expect(end.getAttribute('aria-invalid')).toBe('true');
      expect(harness.reportCaptureError).toHaveBeenCalledWith('MD4H-FB-ANCHOR-001');
      expect(harness.rasterize).not.toHaveBeenCalled();
      expect(harness.addScreenshotFeedback).not.toHaveBeenCalled();
      expect(harness.setAnnotationsSuspended).not.toHaveBeenCalled();
      expect(document.body.classList).not.toContain('feedback-capture-active');
      expect(document.querySelector('.feedback-annotation-dialog')).toBeNull();
    }
  );

  it('captures a fully visible block range without clipping its rectangle', async () => {
    const harness = openGeometricBlockSelector({
      blockRectangles: [domRectangle(80, 120, 680, 200), domRectangle(80, 230, 680, 310)],
    });

    harness.dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));

    expect(harness.rasterize).toHaveBeenCalledWith(
      expect.objectContaining({
        rectangle: { left: 80, top: 120, width: 600, height: 190 },
      })
    );
    expect(document.querySelector('.feedback-block-selector')).toBeNull();
    expect(document.querySelector('.feedback-annotation-dialog')).not.toBeNull();
    document
      .querySelector<HTMLButtonElement>(
        '.feedback-annotation-dialog [data-feedback-action="cancel"]'
      )
      ?.click();
  });

  it('captures non-contiguous mapped ordinals without treating omitted empty blocks as errors', async () => {
    const harness = openGeometricBlockSelector({
      anchorOrdinals: [2, 5],
      blockRectangles: [domRectangle(80, 120, 680, 200), domRectangle(80, 230, 680, 310)],
    });

    harness.dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));

    expect(harness.rasterize).toHaveBeenCalledWith(
      expect.objectContaining({
        rectangle: { left: 80, top: 120, width: 600, height: 190 },
      })
    );
    expect(document.querySelector('.feedback-block-selector')).toBeNull();
    document
      .querySelector<HTMLButtonElement>(
        '.feedback-annotation-dialog [data-feedback-action="cancel"]'
      )
      ?.click();
  });

  it('normalizes a reverse range using fractional zoom geometry', async () => {
    const harness = openGeometricBlockSelector({
      rootRectangle: domRectangle(112.5, -250.25, 812.5, 980.75),
      blockRectangles: [
        domRectangle(137.5, 48.25, 650, 112.5),
        domRectangle(137.5, 136.75, 650, 224.5),
        domRectangle(137.5, 249.25, 650, 353.75),
      ],
    });
    const [start, end] = harness.dialog.querySelectorAll('select');
    start.value = '2';
    end.value = '0';

    harness.dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));

    expect(harness.rasterize).toHaveBeenCalledWith(
      expect.objectContaining({
        rectangle: { left: 137.5, top: 48.25, width: 512.5, height: 305.5 },
      })
    );
    expect(document.querySelector('.feedback-block-selector')).toBeNull();
    expect(document.querySelector('.feedback-annotation-dialog')).not.toBeNull();
    document
      .querySelector<HTMLButtonElement>(
        '.feedback-annotation-dialog [data-feedback-action="cancel"]'
      )
      ?.click();
  });

  it('retries the same preserved block choice after it is scrolled fully into view', async () => {
    const harness = openGeometricBlockSelector({
      blockRectangles: [domRectangle(50, 640, 650, 716), domRectangle(50, 744, 650, 824)],
    });
    const [start, end] = harness.dialog.querySelectorAll('select');
    start.value = '0';
    end.value = '1';

    harness.dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.feedback-block-selector')).toBe(harness.dialog);
    expect(harness.rasterize).not.toHaveBeenCalled();

    harness.blockRectangles[0] = domRectangle(50, 420, 650, 496);
    harness.blockRectangles[1] = domRectangle(50, 524, 650, 604);
    harness.dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));

    expect(start.value).toBe('0');
    expect(end.value).toBe('1');
    expect(harness.rasterize).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.feedback-block-selector')).toBeNull();
    expect(document.querySelector('.feedback-annotation-dialog')).not.toBeNull();
    document
      .querySelector<HTMLButtonElement>(
        '.feedback-annotation-dialog [data-feedback-action="cancel"]'
      )
      ?.click();
  });

  it('cancels an active crop and restores focus when the snapshot is invalidated', () => {
    const invoker = document.createElement('button');
    const editorDom = document.createElement('div');
    editorDom.append(document.createElement('p'));
    document.body.append(invoker, editorDom);
    invoker.focus();
    editorDom.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 }) as DOMRect;
    const editor = {
      state: { selection: { empty: true, from: 1, to: 1 } },
      view: { dom: editorDom },
    } as unknown as Editor;
    const review = {
      getSession: () => ({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 2 }],
        items: [],
      }),
      isWritable: () => true,
    } as unknown as FeedbackReviewController;

    startFeedbackAreaCapture({ editor, review, rasterize: jest.fn() });
    expect(document.body.classList.contains('feedback-capture-active')).toBe(true);
    window.dispatchEvent(new CustomEvent('feedbackInvalidated'));

    expect(document.querySelector('.feedback-area-capture')).toBeNull();
    expect(document.body.classList.contains('feedback-capture-active')).toBe(false);
    expect(document.activeElement).toBe(invoker);
  });

  it('cancels an active crop once when the Feedback session ends', () => {
    const invoker = document.createElement('button');
    const editorDom = document.createElement('div');
    editorDom.append(document.createElement('p'));
    document.body.append(invoker, editorDom);
    invoker.focus();
    editorDom.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 }) as DOMRect;
    const editor = {
      state: { selection: { empty: true, from: 1, to: 1 } },
      view: { dom: editorDom },
    } as unknown as Editor;
    const review = {
      getSession: () => ({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 2 }],
        items: [],
      }),
      isWritable: () => true,
    } as unknown as FeedbackReviewController;

    startFeedbackAreaCapture({ editor, review, rasterize: jest.fn() });
    window.dispatchEvent(new CustomEvent('feedbackSessionEnded'));
    window.dispatchEvent(new CustomEvent('feedbackSessionEnded'));

    expect(document.querySelector('.feedback-area-capture')).toBeNull();
    expect(document.body.classList.contains('feedback-capture-active')).toBe(false);
    expect(document.activeElement).toBe(invoker);
  });

  it('restores focus to the actual invoking control after annotation cancellation', async () => {
    const toolbarCapture = document.createElement('button');
    toolbarCapture.setAttribute('data-feedback-capture', '');
    const actualInvoker = document.createElement('button');
    const editorDom = document.createElement('div');
    const block = document.createElement('p');
    block.textContent = 'Visible Markdown';
    const renderedImage = document.createElement('img');
    block.append(renderedImage);
    editorDom.append(block);
    document.body.append(toolbarCapture, actualInvoker, editorDom);
    actualInvoker.focus();
    editorDom.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 }) as DOMRect;
    block.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 100, width: 500, height: 100 }) as DOMRect;
    renderedImage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
    const editor = {
      state: { selection: { empty: true, from: 1, to: 1 } },
      view: { dom: editorDom },
    } as unknown as Editor;
    const setAnnotationsSuspended = jest.fn();
    const draftSurfaceGate = createFeedbackDraftSurfaceGate();
    const review = {
      draftSurfaceGate,
      getSession: () => ({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 2 }],
        items: [],
      }),
      isWritable: () => true,
    } as unknown as FeedbackReviewController;
    const rasterize = jest.fn(async () => {
      expect(setAnnotationsSuspended).toHaveBeenLastCalledWith(true);
      return {
        dataUrl: 'data:image/png;base64,AAAA',
        width: 100,
        height: 60,
      };
    });

    startFeedbackAreaCapture({ editor, review, rasterize, setAnnotationsSuspended });
    const overlay = document.querySelector<HTMLElement>('.feedback-area-capture')!;
    overlay.dispatchEvent(
      new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true })
    );
    overlay.dispatchEvent(
      new MouseEvent('pointerup', { button: 0, clientX: 110, clientY: 70, bubbles: true })
    );
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));

    const cancel = document.querySelector<HTMLButtonElement>(
      '.feedback-annotation-dialog [data-feedback-action="cancel"]'
    );
    expect(cancel).not.toBeNull();
    expect(setAnnotationsSuspended.mock.calls).toEqual([[true], [false]]);
    cancel?.click();
    expect(document.activeElement).toBe(actualInvoker);
    expect(setAnnotationsSuspended.mock.calls).toEqual([[true], [false]]);
  });

  it('reports only the stable code when rasterization fails', async () => {
    const editorDom = document.createElement('div');
    const block = document.createElement('p');
    const renderedImage = document.createElement('img');
    block.textContent = 'Visible Markdown';
    block.append(renderedImage);
    editorDom.append(block);
    document.body.append(editorDom);
    editorDom.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 }) as DOMRect;
    block.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 100, width: 500, height: 100 }) as DOMRect;
    renderedImage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
    const editor = {
      state: { selection: { empty: true, from: 1, to: 1 } },
      view: { dom: editorDom },
    } as unknown as Editor;
    const reportCaptureError = jest.fn();
    const review = {
      getSession: () => ({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 2 }],
        items: [],
      }),
      isWritable: () => true,
      reportCaptureError,
    } as unknown as FeedbackReviewController;
    const setAnnotationsSuspended = jest.fn();
    const rasterize = jest.fn(async () => {
      expect(setAnnotationsSuspended).toHaveBeenLastCalledWith(true);
      throw new FeedbackCaptureError('MD4H-FB-CAPTURE-002', 'Rasterization failed.');
    });

    startFeedbackAreaCapture({ editor, review, rasterize, setAnnotationsSuspended });
    const overlay = document.querySelector<HTMLElement>('.feedback-area-capture')!;
    overlay.dispatchEvent(
      new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true })
    );
    overlay.dispatchEvent(
      new MouseEvent('pointerup', { button: 0, clientX: 110, clientY: 70, bubbles: true })
    );
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));

    expect(reportCaptureError).toHaveBeenCalledWith('MD4H-FB-CAPTURE-002');
    expect(document.querySelector('.feedback-capture-error')?.textContent).toBe(
      'Rasterization failed.'
    );
    expect(setAnnotationsSuspended.mock.calls).toEqual([[true], [false]]);
  });

  it('restores annotations immediately when an in-flight area capture is invalidated', async () => {
    const editorDom = document.createElement('div');
    const block = document.createElement('p');
    const renderedImage = document.createElement('img');
    block.append(renderedImage);
    editorDom.append(block);
    document.body.append(editorDom);
    editorDom.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 }) as DOMRect;
    block.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 100, width: 500, height: 100 }) as DOMRect;
    renderedImage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
    const editor = {
      state: { selection: { empty: true, from: 1, to: 1 } },
      view: { dom: editorDom },
    } as unknown as Editor;
    const setAnnotationsSuspended = jest.fn();
    const review = {
      getSession: () => ({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 2 }],
        items: [],
      }),
      isWritable: () => true,
    } as unknown as FeedbackReviewController;
    let resolveRasterize!: (capture: { dataUrl: string; width: number; height: number }) => void;
    const rasterize = jest.fn<
      Promise<{ dataUrl: string; width: number; height: number }>,
      [DomRasterizeRequest]
    >(
      _request =>
        new Promise<{ dataUrl: string; width: number; height: number }>(resolve => {
          resolveRasterize = resolve;
        })
    );

    startFeedbackAreaCapture({ editor, review, rasterize, setAnnotationsSuspended });
    const overlay = document.querySelector<HTMLElement>('.feedback-area-capture')!;
    overlay.dispatchEvent(
      new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true })
    );
    overlay.dispatchEvent(
      new MouseEvent('pointerup', { button: 0, clientX: 110, clientY: 70, bubbles: true })
    );
    await Promise.resolve();

    expect(setAnnotationsSuspended.mock.calls).toEqual([[true]]);
    const rasterSignal = rasterize.mock.calls[0]?.[0]?.signal as AbortSignal | undefined;
    expect(rasterSignal).toBeInstanceOf(AbortSignal);
    expect(rasterSignal?.aborted).toBe(false);
    window.dispatchEvent(new CustomEvent('feedbackInvalidated'));
    expect(rasterSignal?.aborted).toBe(true);
    expect(setAnnotationsSuspended.mock.calls).toEqual([[true], [false]]);

    resolveRasterize({ dataUrl: 'data:image/png;base64,AAAA', width: 100, height: 60 });
    await Promise.resolve();
    await Promise.resolve();
    expect(setAnnotationsSuspended.mock.calls).toEqual([[true], [false]]);
    expect(document.querySelector('.feedback-annotation-dialog')).toBeNull();
  });

  it('abandons an in-flight area capture when the Feedback session ends', async () => {
    const editorDom = document.createElement('div');
    const block = document.createElement('p');
    const renderedImage = document.createElement('img');
    block.append(renderedImage);
    editorDom.append(block);
    document.body.append(editorDom);
    editorDom.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 }) as DOMRect;
    block.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 100, width: 500, height: 100 }) as DOMRect;
    renderedImage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
    const editor = {
      state: { selection: { empty: true, from: 1, to: 1 } },
      view: { dom: editorDom },
    } as unknown as Editor;
    const setAnnotationsSuspended = jest.fn();
    const review = {
      getSession: () => ({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 2 }],
        items: [],
      }),
      isWritable: () => true,
    } as unknown as FeedbackReviewController;
    let resolveRasterize!: (capture: { dataUrl: string; width: number; height: number }) => void;
    const rasterize = jest.fn(
      () =>
        new Promise<{ dataUrl: string; width: number; height: number }>(resolve => {
          resolveRasterize = resolve;
        })
    );

    startFeedbackAreaCapture({ editor, review, rasterize, setAnnotationsSuspended });
    const overlay = document.querySelector<HTMLElement>('.feedback-area-capture')!;
    overlay.dispatchEvent(
      new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true })
    );
    overlay.dispatchEvent(
      new MouseEvent('pointerup', { button: 0, clientX: 110, clientY: 70, bubbles: true })
    );
    await Promise.resolve();

    expect(setAnnotationsSuspended.mock.calls).toEqual([[true]]);
    window.dispatchEvent(new CustomEvent('feedbackSessionEnded'));
    window.dispatchEvent(new CustomEvent('feedbackSessionEnded'));
    expect(setAnnotationsSuspended.mock.calls).toEqual([[true], [false]]);

    resolveRasterize({ dataUrl: 'data:image/png;base64,AAAA', width: 100, height: 60 });
    await Promise.resolve();
    await Promise.resolve();
    expect(setAnnotationsSuspended.mock.calls).toEqual([[true], [false]]);
    expect(document.querySelector('.feedback-annotation-dialog')).toBeNull();
  });

  it('suspends and restores annotations around keyboard block capture', async () => {
    const editorDom = document.createElement('div');
    const firstBlock = document.createElement('p');
    const secondBlock = document.createElement('p');
    const firstImage = document.createElement('img');
    const secondImage = document.createElement('img');
    firstBlock.append(firstImage);
    secondBlock.append(secondImage);
    editorDom.append(firstBlock, secondBlock);
    document.body.append(editorDom);
    editorDom.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 }) as DOMRect;
    firstBlock.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 100, width: 500, height: 100 }) as DOMRect;
    secondBlock.getBoundingClientRect = () =>
      ({ left: 0, top: 100, right: 500, bottom: 200, width: 500, height: 100 }) as DOMRect;
    firstImage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
    secondImage.getBoundingClientRect = () =>
      ({ left: 0, top: 100, right: 200, bottom: 200, width: 200, height: 100 }) as DOMRect;
    const editor = {
      state: { selection: { empty: true, from: 1, to: 1 } },
      view: { dom: editorDom },
    } as unknown as Editor;
    const setAnnotationsSuspended = jest.fn();
    const setCaptureState = jest.fn();
    const review = {
      getSession: () => ({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        anchors: [
          { ordinal: 0, startLine: 1, endLine: 2 },
          { ordinal: 1, startLine: 3, endLine: 4 },
        ],
        items: [],
      }),
      isWritable: () => true,
      setAnnotationsSuspended,
      setCaptureState,
      reportCaptureError: jest.fn(),
    } as unknown as FeedbackReviewController;
    const rasterize = jest.fn(async () => {
      expect(setAnnotationsSuspended).toHaveBeenLastCalledWith(true);
      expect(document.body.classList).toContain('feedback-capture-active');
      expect(document.body.getAttribute('data-feedback-capture-state')).toBe('rasterizing');
      expect(setCaptureState).toHaveBeenLastCalledWith('rasterizing');
      return { dataUrl: 'data:image/png;base64,AAAA', width: 100, height: 60 };
    });

    captureSelectedFeedbackBlocks({ editor, review, rasterize });
    document
      .querySelector<HTMLFormElement>('.feedback-block-selector')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));

    expect(setAnnotationsSuspended.mock.calls).toEqual([[true], [false]]);
    expect(setCaptureState.mock.calls).toEqual([['rasterizing'], ['idle']]);
    expect(document.body.hasAttribute('data-feedback-capture-state')).toBe(false);
    expect(document.body.classList).not.toContain('feedback-capture-active');
    expect(document.querySelector('.feedback-annotation-dialog')).not.toBeNull();
    document
      .querySelector<HTMLButtonElement>(
        '.feedback-annotation-dialog [data-feedback-action="cancel"]'
      )
      ?.click();

    setAnnotationsSuspended.mockClear();
    setCaptureState.mockClear();
    const failedRasterize = jest.fn(async () => {
      expect(setAnnotationsSuspended).toHaveBeenLastCalledWith(true);
      expect(document.body.classList).toContain('feedback-capture-active');
      expect(document.body.getAttribute('data-feedback-capture-state')).toBe('rasterizing');
      expect(setCaptureState).toHaveBeenLastCalledWith('rasterizing');
      throw new FeedbackCaptureError('MD4H-FB-CAPTURE-002', 'Block capture failed.');
    });
    captureSelectedFeedbackBlocks({ editor, review, rasterize: failedRasterize });
    document
      .querySelector<HTMLFormElement>('.feedback-block-selector')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));

    expect(setAnnotationsSuspended.mock.calls).toEqual([[true], [false]]);
    expect(setCaptureState.mock.calls).toEqual([['rasterizing'], ['idle']]);
    expect(document.body.hasAttribute('data-feedback-capture-state')).toBe(false);
    expect(document.body.classList).not.toContain('feedback-capture-active');
    expect(document.querySelector('.feedback-annotation-dialog')).toBeNull();
  });

  it('owns one selected-block capture while rasterization is in flight', async () => {
    const invoker = document.createElement('button');
    const editorDom = document.createElement('div');
    const block = document.createElement('p');
    const renderedImage = document.createElement('img');
    block.append(renderedImage);
    editorDom.append(block);
    document.body.append(invoker, editorDom);
    invoker.focus();
    editorDom.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 }) as DOMRect;
    block.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 100, width: 500, height: 100 }) as DOMRect;
    renderedImage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
    const editor = {
      state: { selection: { empty: true, from: 1, to: 1 } },
      view: { dom: editorDom },
    } as unknown as Editor;
    const setAnnotationsSuspended = jest.fn();
    const review = {
      getSession: () => ({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 2 }],
        items: [],
      }),
      isWritable: () => true,
      setAnnotationsSuspended,
      reportCaptureError: jest.fn(),
    } as unknown as FeedbackReviewController;
    let resolveFirstRasterizer!: (capture: {
      dataUrl: string;
      width: number;
      height: number;
    }) => void;
    const firstRasterizer = jest.fn(
      () =>
        new Promise<{ dataUrl: string; width: number; height: number }>(resolve => {
          resolveFirstRasterizer = resolve;
        })
    );
    const secondRasterizer = jest.fn(
      () => new Promise<{ dataUrl: string; width: number; height: number }>(() => undefined)
    );

    captureSelectedFeedbackBlocks({ editor, review, rasterize: firstRasterizer });
    document
      .querySelector<HTMLFormElement>('.feedback-block-selector')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(firstRasterizer).toHaveBeenCalledTimes(1);
    expect(setAnnotationsSuspended.mock.calls).toEqual([[true]]);
    expect(document.body.classList).toContain('feedback-capture-active');

    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();

    captureSelectedFeedbackBlocks({ editor, review, rasterize: secondRasterizer });

    expect(document.querySelectorAll('.feedback-block-selector')).toHaveLength(0);
    expect(secondRasterizer).not.toHaveBeenCalled();
    expect(setAnnotationsSuspended.mock.calls).toEqual([[true]]);
    expect(document.activeElement).toBe(invoker);

    resolveFirstRasterizer({ dataUrl: 'data:image/png;base64,AAAA', width: 100, height: 60 });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));

    expect(document.querySelectorAll('.feedback-annotation-dialog')).toHaveLength(1);
    expect(setAnnotationsSuspended.mock.calls).toEqual([[true], [false]]);
    expect(document.body.classList).not.toContain('feedback-capture-active');
    document
      .querySelector<HTMLButtonElement>(
        '.feedback-annotation-dialog [data-feedback-action="cancel"]'
      )
      ?.click();
    expect(document.querySelector('.feedback-annotation-dialog')).toBeNull();
  });

  it('focuses the existing annotation instead of opening an area capture', async () => {
    const editorDom = document.createElement('div');
    const block = document.createElement('p');
    const renderedImage = document.createElement('img');
    block.append(renderedImage);
    editorDom.append(block);
    document.body.append(editorDom);
    editorDom.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 }) as DOMRect;
    block.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 500, bottom: 100, width: 500, height: 100 }) as DOMRect;
    renderedImage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
    const editor = {
      state: { selection: { empty: true, from: 1, to: 1 } },
      view: { dom: editorDom },
    } as unknown as Editor;
    const setAnnotationsSuspended = jest.fn();
    const draftSurfaceGate = createFeedbackDraftSurfaceGate();
    const review = {
      draftSurfaceGate,
      getSession: () => ({
        sessionId: 'session-1',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        anchors: [{ ordinal: 0, startLine: 1, endLine: 2 }],
        items: [],
      }),
      isWritable: () => true,
      setAnnotationsSuspended,
      reportCaptureError: jest.fn(),
    } as unknown as FeedbackReviewController;
    const rasterize = jest.fn(async () => ({
      dataUrl: 'data:image/png;base64,AAAA',
      width: 100,
      height: 60,
    }));

    captureSelectedFeedbackBlocks({ editor, review, rasterize });
    document
      .querySelector<HTMLFormElement>('.feedback-block-selector')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));

    const annotation = document.querySelector<HTMLElement>('.feedback-annotation-dialog');
    expect(annotation).not.toBeNull();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();

    startFeedbackAreaCapture({ editor, review, rasterize, setAnnotationsSuspended });

    expect(document.querySelectorAll('.feedback-annotation-dialog')).toHaveLength(1);
    expect(document.querySelector('.feedback-area-capture')).toBeNull();
    expect(annotation?.contains(document.activeElement)).toBe(true);
    expect(rasterize).toHaveBeenCalledTimes(1);
    expect(setAnnotationsSuspended.mock.calls).toEqual([[true], [false]]);

    const feedbackInput = annotation?.querySelector<HTMLTextAreaElement>('textarea');
    const cancel = annotation?.querySelector<HTMLButtonElement>('[data-feedback-action="cancel"]');
    if (!feedbackInput || !cancel) throw new Error('Missing annotation controls');
    feedbackInput.value = 'Keep this unfinished capture';
    feedbackInput.dispatchEvent(new Event('input', { bubbles: true }));
    cancel.click();
    const discardCheckpoint = document.querySelector<HTMLElement>('[data-feedback-discard-dialog]');
    expect(discardCheckpoint).not.toBeNull();
    expect(draftSurfaceGate.activeKind()).toBe('capture-annotation');

    document.body.tabIndex = -1;
    document.body.focus();
    startFeedbackAreaCapture({ editor, review, rasterize, setAnnotationsSuspended });

    expect(document.activeElement).toBe(
      discardCheckpoint?.querySelector<HTMLElement>('[data-feedback-discard-keep]')
    );
    expect(draftSurfaceGate.activeKind()).toBe('capture-annotation');
    expect(document.querySelector('.feedback-area-capture')).toBeNull();
    discardCheckpoint?.querySelector<HTMLButtonElement>('[data-feedback-discard-keep]')?.click();
    await Promise.resolve();
    feedbackInput.value = '';
    feedbackInput.dispatchEvent(new Event('input', { bubbles: true }));
    cancel.click();
    expect(document.querySelector('.feedback-annotation-dialog')).toBeNull();
    expect(draftSurfaceGate.activeKind()).toBeNull();
  });

  it('contains Tab focus within the modal', () => {
    const dialog = openSelector();
    const start = dialog.querySelector<HTMLSelectElement>('select')!;
    const cancel = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(
      button => button.textContent === 'Cancel'
    )!;

    expect(document.activeElement).toBe(start);
    start.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
    );

    expect(document.activeElement).toBe(cancel);
  });

  it('closes the block picker once when the Feedback session ends', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    openSelector();

    window.dispatchEvent(new CustomEvent('feedbackSessionEnded'));
    window.dispatchEvent(new CustomEvent('feedbackSessionEnded'));

    expect(document.querySelector('.feedback-block-selector')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it.each([
    ['invalidation', 'feedbackInvalidated'],
    ['session disposal', 'feedbackSessionEnded'],
  ] as const)(
    'aborts the selected-block rasterizer on %s and ignores late completion',
    async (_reason, lifecycleEvent) => {
      const editorDom = document.createElement('div');
      const block = document.createElement('p');
      const renderedImage = document.createElement('img');
      block.append(renderedImage);
      editorDom.append(block);
      document.body.append(editorDom);
      editorDom.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 }) as DOMRect;
      block.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 500, bottom: 100, width: 500, height: 100 }) as DOMRect;
      renderedImage.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 }) as DOMRect;
      const editor = {
        state: { selection: { empty: true, from: 1, to: 1 } },
        view: { dom: editorDom },
      } as unknown as Editor;
      const setAnnotationsSuspended = jest.fn();
      const setCaptureState = jest.fn();
      const review = {
        getSession: () => ({
          sessionId: 'session-1',
          source: 'docs/guide.md',
          sourceSha256: 'a'.repeat(64),
          round: '20260821T093000Z-k4p9',
          anchors: [{ ordinal: 0, startLine: 1, endLine: 2 }],
          items: [],
        }),
        isWritable: () => true,
        setAnnotationsSuspended,
        setCaptureState,
        reportCaptureError: jest.fn(),
      } as unknown as FeedbackReviewController;
      let resolveRasterize!: (capture: { dataUrl: string; width: number; height: number }) => void;
      const rasterize = jest.fn<
        Promise<{ dataUrl: string; width: number; height: number }>,
        [DomRasterizeRequest]
      >(
        _request =>
          new Promise<{ dataUrl: string; width: number; height: number }>(resolve => {
            resolveRasterize = resolve;
          })
      );

      captureSelectedFeedbackBlocks({ editor, review, rasterize });
      document
        .querySelector<HTMLFormElement>('.feedback-block-selector')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      expect(setAnnotationsSuspended.mock.calls).toEqual([[true]]);
      expect(document.body.classList).toContain('feedback-capture-active');
      expect(document.body.getAttribute('data-feedback-capture-state')).toBe('rasterizing');
      expect(setCaptureState.mock.calls).toEqual([['rasterizing']]);
      const rasterSignal = rasterize.mock.calls[0]?.[0]?.signal;
      expect(rasterSignal).toBeInstanceOf(AbortSignal);
      expect(rasterSignal?.aborted).toBe(false);

      window.dispatchEvent(new CustomEvent(lifecycleEvent));
      window.dispatchEvent(new CustomEvent(lifecycleEvent));
      expect(rasterSignal?.aborted).toBe(true);
      expect(setAnnotationsSuspended.mock.calls).toEqual([[true], [false]]);
      expect(document.body.classList).not.toContain('feedback-capture-active');
      expect(document.body.hasAttribute('data-feedback-capture-state')).toBe(false);
      expect(setCaptureState.mock.calls).toEqual([['rasterizing'], ['idle']]);

      resolveRasterize({ dataUrl: 'data:image/png;base64,AAAA', width: 100, height: 60 });
      await Promise.resolve();
      await Promise.resolve();
      expect(setAnnotationsSuspended.mock.calls).toEqual([[true], [false]]);
      expect(setCaptureState.mock.calls).toEqual([['rasterizing'], ['idle']]);
      expect(document.querySelector('.feedback-annotation-dialog')).toBeNull();
    }
  );

  it('closes on Escape and restores focus to the invoking control', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const dialog = openSelector();

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.querySelector('.feedback-block-selector')).toBeNull();
    expect(document.body.classList).not.toContain('feedback-capture-active');
    expect(document.activeElement).toBe(trigger);
  });

  describe('explicit area capture state', () => {
    function createAreaHarness(
      options: {
        draftSurfaceGate?: ReturnType<typeof createFeedbackDraftSurfaceGate>;
        isWritable?: () => boolean;
      } = {}
    ) {
      const trigger = document.createElement('button');
      trigger.setAttribute('data-feedback-capture', '');
      const editorDom = document.createElement('div');
      const block = document.createElement('p');
      block.textContent = 'Visible Markdown';
      const renderedImage = document.createElement('img');
      block.append(renderedImage);
      editorDom.append(block);
      document.body.append(trigger, editorDom);
      trigger.focus();
      editorDom.getBoundingClientRect = () => domRectangle(0, 0, 500, 300);
      block.getBoundingClientRect = () => domRectangle(0, 0, 500, 100);
      renderedImage.getBoundingClientRect = () => domRectangle(0, 0, 200, 100);
      const editor = {
        state: { selection: { empty: true, from: 1, to: 1 } },
        view: { dom: editorDom },
      } as unknown as Editor;
      const setCaptureState = jest.fn((state: 'idle' | 'armed' | 'rasterizing') => {
        // Mirrors the real toolbar rerender: rasterizing makes its Capture
        // control disabled even though the frozen review remains writable.
        trigger.disabled = state === 'rasterizing';
      });
      const review = {
        ...(options.draftSurfaceGate ? { draftSurfaceGate: options.draftSurfaceGate } : {}),
        getSession: () => ({
          sessionId: 'session-1',
          source: 'docs/guide.md',
          sourceSha256: 'a'.repeat(64),
          round: '20260821T093000Z-k4p9',
          anchors: [{ ordinal: 0, startLine: 1, endLine: 2 }],
          items: [],
        }),
        isWritable: options.isWritable ?? (() => true),
        setCaptureState,
        reportCaptureError: jest.fn(),
      } as unknown as FeedbackReviewController;
      const rasterize = jest.fn();
      return { trigger, editor, review, rasterize, setCaptureState };
    }

    it('visibly arms the crop overlay on the first synchronous invocation', () => {
      const harness = createAreaHarness();

      startFeedbackAreaCapture(harness);

      const overlay = document.querySelector<HTMLElement>('.feedback-area-capture');
      const instruction = overlay?.querySelector<HTMLElement>('.feedback-capture-instruction');
      expect(overlay).not.toBeNull();
      expect(overlay?.getAttribute('role')).toBe('dialog');
      expect(overlay?.getAttribute('aria-modal')).toBe('true');
      expect(overlay?.getAttribute('aria-label')).toBe('Capture area for feedback');
      expect(overlay?.hasAttribute('data-md4h-modal')).toBe(true);
      expect(document.activeElement).toBe(overlay);
      expect(harness.setCaptureState).toHaveBeenCalledWith('armed');
      expect(document.body.getAttribute('data-feedback-capture-state')).toBe('armed');
      expect(instruction?.id).not.toBe('');
      expect(overlay?.getAttribute('aria-describedby')).toBe(instruction?.id);
      expect(instruction?.textContent).toBe(
        'Capture area ready. Drag over the visible document area. Press Escape to cancel.'
      );
      expect(harness.rasterize).not.toHaveBeenCalled();
    });

    it('contains keyboard focus and cancels on Escape after toolbar rerender', () => {
      const harness = createAreaHarness();
      harness.trigger.setAttribute('data-feedback-control', 'capture');
      const preInertBackground = document.createElement('aside');
      preInertBackground.inert = true;
      document.body.append(preInertBackground);
      startFeedbackAreaCapture(harness);
      const overlay = document.querySelector<HTMLElement>('.feedback-area-capture')!;
      const cancel = overlay.querySelector<HTMLButtonElement>('.feedback-capture-cancel')!;

      expect(harness.trigger.inert).toBe(true);
      expect((harness.editor.view.dom as HTMLElement).inert).toBe(true);
      expect(preInertBackground.inert).toBe(true);
      expect(overlay.inert).not.toBe(true);

      overlay.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
      );
      expect(document.activeElement).toBe(cancel);

      cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      expect(document.activeElement).toBe(overlay);

      const replacement = document.createElement('button');
      replacement.setAttribute('data-feedback-capture', '');
      replacement.setAttribute('data-feedback-control', 'capture');
      harness.trigger.replaceWith(replacement);
      replacement.focus();
      replacement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      expect(document.activeElement).toBe(cancel);

      replacement.focus();
      replacement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(document.querySelector('.feedback-area-capture')).toBeNull();
      expect(harness.setCaptureState).toHaveBeenLastCalledWith('idle');
      expect(document.activeElement).toBe(replacement);
      expect(replacement.inert).not.toBe(true);
      expect((harness.editor.view.dom as HTMLElement).inert).not.toBe(true);
      expect(preInertBackground.inert).toBe(true);
    });

    it('logs the cleanup reason when Escape cancels the armed capture', () => {
      const consoleDebug = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
      const harness = createAreaHarness();
      startFeedbackAreaCapture(harness);
      const overlay = document.querySelector<HTMLElement>('.feedback-area-capture')!;

      overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(document.querySelector('.feedback-area-capture')).toBeNull();
      expect(consoleDebug).toHaveBeenCalledWith('[MD4H] Feedback capture cleanup:', 'escape');
    });

    it('finishes rasterization when toolbar state disables Capture but review stays writable', async () => {
      const harness = createAreaHarness();
      harness.rasterize.mockImplementation(async () => {
        expect(harness.trigger.disabled).toBe(true);
        return {
          dataUrl: 'data:image/png;base64,AAAA',
          width: 100,
          height: 60,
        };
      });
      startFeedbackAreaCapture(harness);
      const overlay = document.querySelector<HTMLElement>('.feedback-area-capture')!;

      overlay.dispatchEvent(
        new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true })
      );
      overlay.dispatchEvent(
        new MouseEvent('pointerup', { button: 0, clientX: 110, clientY: 70, bubbles: true })
      );
      await Promise.resolve();
      await Promise.resolve();
      await new Promise(resolve => window.setTimeout(resolve, 0));

      expect(harness.setCaptureState).toHaveBeenCalledWith('rasterizing');
      expect(harness.rasterize).toHaveBeenCalledTimes(1);
      expect(document.querySelector('.feedback-area-capture')).toBeNull();
      expect(document.body.hasAttribute('data-feedback-capture-state')).toBe(false);
      expect(harness.trigger.disabled).toBe(false);
      expect(document.querySelector('.feedback-annotation-dialog')).not.toBeNull();

      document
        .querySelector<HTMLButtonElement>(
          '.feedback-annotation-dialog [data-feedback-action="cancel"]'
        )
        ?.click();
    });

    it('announces preparation on the crop overlay and removes it after success', async () => {
      const gate = createFeedbackDraftSurfaceGate();
      const harness = createAreaHarness({ draftSurfaceGate: gate });
      let resolveRasterize!: (capture: { dataUrl: string; width: number; height: number }) => void;
      harness.rasterize.mockImplementation(
        () =>
          new Promise(resolve => {
            resolveRasterize = resolve;
          })
      );
      startFeedbackAreaCapture(harness);
      const overlay = document.querySelector<HTMLElement>('.feedback-area-capture')!;
      const instruction = overlay.querySelector<HTMLElement>('.feedback-capture-instruction')!;

      overlay.dispatchEvent(
        new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true })
      );
      overlay.dispatchEvent(
        new MouseEvent('pointerup', { button: 0, clientX: 110, clientY: 70, bubbles: true })
      );
      await Promise.resolve();

      expect(overlay.getAttribute('aria-busy')).toBe('true');
      expect(instruction.textContent).toBe('Preparing capture…');
      expect(overlay.getAttribute('aria-describedby')).toBe(instruction.id);
      expect(gate.activeKind()).toBe('capture-rasterizing');

      const onLocalError = jest.fn();
      window.addEventListener('feedbackLocalError', onLocalError);
      try {
        startFeedbackAreaCapture(harness);
        expect(onLocalError).toHaveBeenCalledTimes(1);
        expect((onLocalError.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
          message: 'A Feedback capture is already being prepared.',
        });
      } finally {
        window.removeEventListener('feedbackLocalError', onLocalError);
      }

      resolveRasterize({ dataUrl: 'data:image/png;base64,AAAA', width: 100, height: 60 });
      await Promise.resolve();
      await Promise.resolve();
      await new Promise(resolve => window.setTimeout(resolve, 0));

      expect(document.querySelector('.feedback-area-capture')).toBeNull();
      expect(document.body.hasAttribute('data-feedback-capture-state')).toBe(false);
      expect(document.querySelector('.feedback-annotation-dialog')).not.toBeNull();
      document
        .querySelector<HTMLButtonElement>(
          '.feedback-annotation-dialog [data-feedback-action="cancel"]'
        )
        ?.click();
    });

    it('restores armed overlay guidance after a recoverable rasterization failure', async () => {
      const gate = createFeedbackDraftSurfaceGate();
      const harness = createAreaHarness({ draftSurfaceGate: gate });
      harness.rasterize.mockRejectedValue(
        new FeedbackCaptureError('MD4H-FB-CAPTURE-002', 'Rasterization failed.')
      );
      startFeedbackAreaCapture(harness);
      const overlay = document.querySelector<HTMLElement>('.feedback-area-capture')!;
      const instruction = overlay.querySelector<HTMLElement>('.feedback-capture-instruction')!;

      overlay.dispatchEvent(
        new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true })
      );
      overlay.dispatchEvent(
        new MouseEvent('pointerup', { button: 0, clientX: 110, clientY: 70, bubbles: true })
      );
      await Promise.resolve();
      await Promise.resolve();
      await new Promise(resolve => window.setTimeout(resolve, 0));

      expect(document.querySelector('.feedback-area-capture')).toBe(overlay);
      expect(overlay.getAttribute('aria-busy')).toBe('false');
      expect(instruction.textContent).toBe(
        'Capture area ready. Drag over the visible document area. Press Escape to cancel.'
      );
      expect(document.body.getAttribute('data-feedback-capture-state')).toBe('armed');
      expect(gate.activeKind()).toBe('area-capture');
      const retry = Array.from(overlay.querySelectorAll<HTMLButtonElement>('button')).find(
        button => button.textContent === 'Retry'
      );
      expect(retry?.hidden).toBe(false);

      overlay.querySelector<HTMLButtonElement>('.feedback-capture-cancel')?.click();
      expect(document.querySelector('.feedback-area-capture')).toBeNull();
    });

    it('cancels the armed crop from the toolbar event and restores idle state', () => {
      const harness = createAreaHarness();
      startFeedbackAreaCapture(harness);

      window.dispatchEvent(new CustomEvent('feedbackCaptureCancelRequested'));

      expect(document.querySelector('.feedback-area-capture')).toBeNull();
      expect(harness.setCaptureState).toHaveBeenLastCalledWith('idle');
      expect(document.body.hasAttribute('data-feedback-capture-state')).toBe(false);
      expect(document.body.classList).not.toContain('feedback-capture-active');
      expect(document.activeElement).toBe(harness.trigger);
      expect(harness.rasterize).not.toHaveBeenCalled();
    });

    it.each(['pointercancel', 'lostpointercapture'] as const)(
      'terminates the owned drag on %s and restores the capture surface once',
      eventType => {
        const harness = createAreaHarness();
        startFeedbackAreaCapture(harness);
        const overlay = document.querySelector<HTMLElement>('.feedback-area-capture')!;
        const pointerDown = new MouseEvent('pointerdown', {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        });
        Object.defineProperty(pointerDown, 'pointerId', { value: 17 });
        overlay.dispatchEvent(pointerDown);
        const terminal = new MouseEvent(eventType, { bubbles: true });
        Object.defineProperty(terminal, 'pointerId', { value: 17 });

        overlay.dispatchEvent(terminal);
        overlay.dispatchEvent(terminal);

        expect(document.querySelector('.feedback-area-capture')).toBeNull();
        expect(harness.setCaptureState.mock.calls).toEqual([['armed'], ['idle']]);
        expect(document.body.hasAttribute('data-feedback-capture-state')).toBe(false);
        expect(harness.rasterize).not.toHaveBeenCalled();
      }
    );

    it('logs the ignore reason when a second pointer tries to steal an owned drag', () => {
      const consoleDebug = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
      const harness = createAreaHarness();
      startFeedbackAreaCapture(harness);
      const overlay = document.querySelector<HTMLElement>('.feedback-area-capture')!;
      const firstPointerDown = new MouseEvent('pointerdown', {
        button: 0,
        clientX: 10,
        clientY: 10,
        bubbles: true,
      });
      Object.defineProperty(firstPointerDown, 'pointerId', { value: 17 });
      overlay.dispatchEvent(firstPointerDown);

      const secondPointerDown = new MouseEvent('pointerdown', {
        button: 0,
        clientX: 20,
        clientY: 20,
        bubbles: true,
      });
      Object.defineProperty(secondPointerDown, 'pointerId', { value: 23 });
      overlay.dispatchEvent(secondPointerDown);

      expect(consoleDebug).toHaveBeenCalledWith(
        '[MD4H] Feedback capture event ignored:',
        'pointer-owned'
      );
    });

    it.each(['blur', 'visibilitychange'] as const)(
      'terminates an owned drag when the document receives %s',
      eventType => {
        const harness = createAreaHarness();
        startFeedbackAreaCapture(harness);
        const overlay = document.querySelector<HTMLElement>('.feedback-area-capture')!;
        const pointerDown = new MouseEvent('pointerdown', {
          button: 0,
          clientX: 10,
          clientY: 10,
          bubbles: true,
        });
        Object.defineProperty(pointerDown, 'pointerId', { value: 23 });
        overlay.dispatchEvent(pointerDown);
        if (eventType === 'visibilitychange') {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
          });
          document.dispatchEvent(new Event('visibilitychange'));
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
          });
        } else {
          window.dispatchEvent(new Event('blur'));
        }

        expect(document.querySelector('.feedback-area-capture')).toBeNull();
        expect(harness.setCaptureState).toHaveBeenLastCalledWith('idle');
        expect(harness.rasterize).not.toHaveBeenCalled();
      }
    );

    it('restores idle state exactly once when invalidation aborts an armed crop', () => {
      const harness = createAreaHarness();
      startFeedbackAreaCapture(harness);

      window.dispatchEvent(new CustomEvent('feedbackInvalidated'));
      window.dispatchEvent(new CustomEvent('feedbackInvalidated'));

      expect(document.querySelector('.feedback-area-capture')).toBeNull();
      expect(harness.setCaptureState.mock.calls).toEqual([['armed'], ['idle']]);
      expect(document.body.hasAttribute('data-feedback-capture-state')).toBe(false);
    });

    it('focuses and preserves a text draft while explaining why capture is blocked', () => {
      const gate = createFeedbackDraftSurfaceGate();
      const draft = document.createElement('textarea');
      draft.value = 'Keep this unfinished feedback.';
      document.body.append(draft);
      const focusDraft = jest.fn(() => draft.focus());
      const lease = gate.claim({ kind: 'text-composer', element: draft, focus: focusDraft });
      const harness = createAreaHarness({ draftSurfaceGate: gate });
      const onLocalError = jest.fn();
      window.addEventListener('feedbackLocalError', onLocalError);

      try {
        startFeedbackAreaCapture(harness);

        expect(document.querySelector('.feedback-area-capture')).toBeNull();
        expect(focusDraft).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(draft);
        expect(draft.value).toBe('Keep this unfinished feedback.');
        expect(harness.setCaptureState).not.toHaveBeenCalled();
        expect(onLocalError).toHaveBeenCalledTimes(1);
        expect((onLocalError.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
          message: 'Finish or cancel this comment before capturing.',
        });
      } finally {
        window.removeEventListener('feedbackLocalError', onLocalError);
        lease?.release();
      }
    });

    it('focuses the completion checkpoint and explains how to leave it before capturing', () => {
      const gate = createFeedbackDraftSurfaceGate();
      const checkpoint = document.createElement('section');
      checkpoint.setAttribute('role', 'dialog');
      checkpoint.tabIndex = -1;
      document.body.append(checkpoint);
      const focusCheckpoint = jest.fn(() => checkpoint.focus());
      const lease = gate.claim({
        kind: 'finish-checkpoint',
        element: checkpoint,
        focus: focusCheckpoint,
      });
      const harness = createAreaHarness({ draftSurfaceGate: gate });
      const onLocalError = jest.fn();
      window.addEventListener('feedbackLocalError', onLocalError);

      try {
        startFeedbackAreaCapture(harness);

        expect(document.querySelector('.feedback-area-capture')).toBeNull();
        expect(focusCheckpoint).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(checkpoint);
        expect(harness.setCaptureState).not.toHaveBeenCalled();
        expect(onLocalError).toHaveBeenCalledTimes(1);
        expect((onLocalError.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
          message: 'Resume feedback or finish the current completion step before capturing.',
        });
      } finally {
        window.removeEventListener('feedbackLocalError', onLocalError);
        lease?.release();
      }
    });

    it('releases the workflow lease and restores idle state when the review turns read-only mid-capture', async () => {
      let writable = true;
      const harness = createAreaHarness({ isWritable: () => writable });
      harness.rasterize.mockImplementation(async () => {
        writable = false;
        return {
          dataUrl: 'data:image/png;base64,AAAA',
          width: 100,
          height: 60,
        };
      });
      startFeedbackAreaCapture(harness);
      const overlay = document.querySelector<HTMLElement>('.feedback-area-capture')!;

      overlay.dispatchEvent(
        new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true })
      );
      overlay.dispatchEvent(
        new MouseEvent('pointerup', { button: 0, clientX: 110, clientY: 70, bubbles: true })
      );
      await Promise.resolve();
      await Promise.resolve();
      await new Promise(resolve => window.setTimeout(resolve, 0));

      expect(document.querySelector('.feedback-area-capture')).toBeNull();
      expect(document.querySelector('.feedback-annotation-dialog')).toBeNull();
      expect(document.body.hasAttribute('data-feedback-capture-state')).toBe(false);
      expect(harness.setCaptureState).toHaveBeenLastCalledWith('idle');
      expect(harness.review.reportCaptureError).toHaveBeenCalledWith('MD4H-FB-SNAPSHOT-001');
      expect(document.activeElement).toBe(harness.trigger);

      writable = true;
      const onLocalError = jest.fn();
      window.addEventListener('feedbackLocalError', onLocalError);
      try {
        startFeedbackAreaCapture(harness);
        expect(onLocalError).not.toHaveBeenCalled();
        expect(document.querySelector('.feedback-area-capture')).not.toBeNull();
      } finally {
        window.removeEventListener('feedbackLocalError', onLocalError);
      }
    });

    it('reports the error when opening the annotation dialog throws synchronously', async () => {
      const harness = createAreaHarness();
      harness.rasterize.mockImplementation(async () => ({
        dataUrl: 'data:image/png;base64,AAAA',
        width: 100,
        height: 60,
      }));
      // createFeedbackAnnotationModal throws a RangeError for a degenerate
      // bitmap in real usage, but validateRasterizedCapture already rejects
      // that shape earlier in the pipeline, so it can never reach
      // openAnnotation. Mock the module to exercise the same synchronous
      // throw-right-after-cleanup path with an error the reportCaptureError
      // helper forwards, so the fix is observable end to end.
      const modalSpy = jest
        .spyOn(feedbackCaptureModule, 'createFeedbackAnnotationModal')
        .mockImplementation(() => {
          throw new FeedbackCaptureError('MD4H-FB-CAPTURE-002', 'boom');
        });
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      startFeedbackAreaCapture(harness);
      const overlay = document.querySelector<HTMLElement>('.feedback-area-capture')!;

      overlay.dispatchEvent(
        new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true })
      );
      overlay.dispatchEvent(
        new MouseEvent('pointerup', { button: 0, clientX: 110, clientY: 70, bubbles: true })
      );
      await Promise.resolve();
      await Promise.resolve();
      await new Promise(resolve => window.setTimeout(resolve, 0));

      expect(modalSpy).toHaveBeenCalled();
      expect(harness.review.reportCaptureError).toHaveBeenCalledWith('MD4H-FB-CAPTURE-002');
      expect(document.querySelector('.feedback-annotation-dialog')).toBeNull();
      expect(consoleError).toHaveBeenCalledWith(
        '[MD4H] Feedback annotation failed:',
        expect.any(FeedbackCaptureError)
      );
    });

    it('logs the raw error when opening the annotation dialog throws a plain RangeError', async () => {
      // createFeedbackAnnotationModal throws a plain RangeError (not a
      // FeedbackCaptureError) for a degenerate bitmap in real usage.
      // reportCaptureError silently no-ops for non-FeedbackCaptureError
      // instances, so console.error is the only surfaced signal for this
      // failure mode.
      const harness = createAreaHarness();
      harness.rasterize.mockImplementation(async () => ({
        dataUrl: 'data:image/png;base64,AAAA',
        width: 100,
        height: 60,
      }));
      const modalSpy = jest
        .spyOn(feedbackCaptureModule, 'createFeedbackAnnotationModal')
        .mockImplementation(() => {
          throw new RangeError('Screenshot dimensions must be positive.');
        });
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      startFeedbackAreaCapture(harness);
      const overlay = document.querySelector<HTMLElement>('.feedback-area-capture')!;

      overlay.dispatchEvent(
        new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true })
      );
      overlay.dispatchEvent(
        new MouseEvent('pointerup', { button: 0, clientX: 110, clientY: 70, bubbles: true })
      );
      await Promise.resolve();
      await Promise.resolve();
      await new Promise(resolve => window.setTimeout(resolve, 0));

      expect(modalSpy).toHaveBeenCalled();
      expect(harness.review.reportCaptureError).not.toHaveBeenCalled();
      expect(document.querySelector('.feedback-annotation-dialog')).toBeNull();
      expect(consoleError).toHaveBeenCalledWith(
        '[MD4H] Feedback annotation failed:',
        expect.any(RangeError)
      );
    });
  });
});
