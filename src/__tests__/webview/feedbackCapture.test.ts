/**
 * @jest-environment jsdom
 */

import {
  AnnotationHistory,
  FeedbackCaptureError,
  captureVisibleArea,
  clampRectangle,
  clientPointToBitmap,
  createFeedbackAnnotationModal,
  createShapeAnnotation,
  findIntersectingTopLevelBlocks,
  flattenAnnotationsToPng,
  mapRectangleToTopLevelBlockRange,
  normalizeAndClampRectangle,
  normalizeRectangle,
  rectanglesIntersect,
  type AnnotationCommand,
  type CanvasFactory,
  type CaptureBlock,
  type CaptureRectangle,
} from '../../webview/features/feedbackCapture';

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function captureRect(left: number, top: number, width: number, height: number): CaptureRectangle {
  return { left, top, width, height };
}

function captureBlock(index: number, rect: DOMRect): CaptureBlock {
  const element = document.createElement('section');
  const renderedContent = document.createElement('img');
  renderedContent.getBoundingClientRect = () => rect;
  element.append(renderedContent);
  element.getBoundingClientRect = () => rect;
  return { index, element };
}

function captureBlockWithContent(
  index: number,
  blockRect: DOMRect,
  contentRect: DOMRect
): CaptureBlock {
  const element = document.createElement('section');
  const renderedContent = document.createElement('img');
  renderedContent.getBoundingClientRect = () => contentRect;
  element.append(renderedContent);
  element.getBoundingClientRect = () => blockRect;
  return { index, element };
}

interface FakeCanvasResult {
  canvasFactory: jest.MockedFunction<CanvasFactory>;
  context: Record<string, jest.Mock>;
  canvas: HTMLCanvasElement;
  strokeStyles: string[];
}

function fakeCanvas(): FakeCanvasResult {
  const strokeStyles: string[] = [];
  const context = {
    drawImage: jest.fn(),
    beginPath: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    stroke: jest.fn(),
    strokeRect: jest.fn(),
    ellipse: jest.fn(),
    arc: jest.fn(),
  };
  Object.defineProperty(context, 'strokeStyle', {
    configurable: true,
    set: value => strokeStyles.push(String(value)),
  });
  const canvas = {
    width: 0,
    height: 0,
    getContext: jest.fn(() => context),
    toDataURL: jest.fn(() => 'data:image/png;base64,flattened'),
  } as unknown as HTMLCanvasElement;
  const canvasFactory = jest.fn(() => canvas);
  return { canvasFactory, context, canvas, strokeStyles };
}

describe('feedback capture geometry', () => {
  it('normalizes reverse drags without losing their bounds', () => {
    expect(normalizeRectangle({ x: 90, y: 80 }, { x: 20, y: 30 })).toEqual({
      left: 20,
      top: 30,
      width: 70,
      height: 50,
    });
  });

  it('clamps a rectangle to the visible viewport', () => {
    expect(clampRectangle(captureRect(-20, 80, 100, 80), captureRect(10, 20, 200, 100))).toEqual({
      left: 10,
      top: 80,
      width: 70,
      height: 40,
    });
  });

  it('rejects zero-area, non-finite, and sub-minimum captures', () => {
    const viewport = captureRect(0, 0, 100, 100);

    expect(normalizeAndClampRectangle({ x: 4, y: 4 }, { x: 4, y: 40 }, viewport)).toBeNull();
    expect(
      normalizeAndClampRectangle({ x: Number.NaN, y: 4 }, { x: 40, y: 40 }, viewport)
    ).toBeNull();
    expect(normalizeAndClampRectangle({ x: 4, y: 4 }, { x: 6, y: 6 }, viewport, 3)).toBeNull();
  });

  it('requires positive intersection area rather than edge contact', () => {
    const first = captureRect(0, 0, 20, 20);

    expect(rectanglesIntersect(first, captureRect(19, 19, 10, 10))).toBe(true);
    expect(rectanglesIntersect(first, captureRect(20, 0, 10, 10))).toBe(false);
  });

  it('maps actual top-level DOM intersections in sorted document order', () => {
    const blocks = [
      captureBlock(4, domRect(0, 100, 300, 50)),
      captureBlock(2, domRect(0, 0, 300, 50)),
      captureBlock(3, domRect(0, 50, 300, 50)),
      captureBlock(5, domRect(0, 150, 0, 40)),
    ];
    const rectangle = captureRect(20, 40, 100, 75);

    expect(findIntersectingTopLevelBlocks(rectangle, blocks)).toEqual([2, 3, 4]);
    expect(mapRectangleToTopLevelBlockRange(rectangle, blocks)).toEqual({
      firstBlock: 2,
      lastBlock: 4,
      blockIndices: [2, 3, 4],
    });
  });

  it('returns no block range for whitespace-only crops', () => {
    const blocks = [captureBlock(0, domRect(0, 0, 200, 30))];

    expect(mapRectangleToTopLevelBlockRange(captureRect(0, 40, 200, 20), blocks)).toBeNull();
  });

  it('does not map blank horizontal space inside a full-width text block', () => {
    const block = document.createElement('p');
    const text = document.createTextNode('Short line');
    block.append(text);
    block.getBoundingClientRect = () => domRect(0, 0, 400, 40);
    const createRange = jest.spyOn(document, 'createRange').mockImplementation(
      () =>
        ({
          selectNodeContents: jest.fn(),
          getClientRects: () => [domRect(0, 0, 72, 20)],
          detach: jest.fn(),
        }) as unknown as Range
    );

    try {
      expect(
        findIntersectingTopLevelBlocks(captureRect(260, 0, 80, 20), [{ index: 0, element: block }])
      ).toEqual([]);
      expect(
        findIntersectingTopLevelBlocks(captureRect(20, 0, 30, 20), [{ index: 0, element: block }])
      ).toEqual([0]);
    } finally {
      createRange.mockRestore();
    }
  });

  it('keeps exact rendered-content intersections for a crop spanning multiple blocks', () => {
    const blocks = [
      captureBlockWithContent(2, domRect(0, 60, 400, 30), domRect(0, 60, 100, 30)),
      captureBlockWithContent(0, domRect(0, 0, 400, 30), domRect(0, 0, 100, 30)),
      captureBlockWithContent(1, domRect(0, 30, 400, 30), domRect(220, 30, 100, 30)),
    ];
    const rectangle = captureRect(20, 10, 40, 70);

    expect(findIntersectingTopLevelBlocks(rectangle, blocks)).toEqual([0, 2]);
    expect(mapRectangleToTopLevelBlockRange(rectangle, blocks)).toEqual({
      firstBlock: 0,
      lastBlock: 2,
      blockIndices: [0, 2],
    });
  });

  it('bounds geometry reads to crop-adjacent candidates in a 10,000-block document', () => {
    let geometryReads = 0;
    const blocks = Array.from({ length: 10_000 }, (_, index): CaptureBlock => {
      const rectangle = domRect(0, index * 24, 400, 20);
      const element = document.createElement('section');
      const renderedContent = document.createElement('img');
      element.getBoundingClientRect = () => {
        geometryReads += 1;
        return rectangle;
      };
      renderedContent.getBoundingClientRect = () => {
        geometryReads += 1;
        return rectangle;
      };
      element.append(renderedContent);
      return { index, element };
    });

    expect(findIntersectingTopLevelBlocks(captureRect(20, 120_005, 60, 55), blocks)).toEqual([
      5000, 5001, 5002,
    ]);
    expect(geometryReads).toBeLessThanOrEqual(32);
  });
});

describe('visible-area rasterization boundary', () => {
  it('validates and maps before calling the injected DOM rasterizer', async () => {
    const root = document.createElement('main');
    const rasterize = jest.fn(async () => ({
      dataUrl: 'data:image/png;base64,capture',
      width: 140,
      height: 80,
    }));

    const result = await captureVisibleArea({
      root,
      start: { x: -10, y: 10 },
      end: { x: 150, y: 90 },
      viewport: captureRect(0, 0, 300, 200),
      blocks: [captureBlock(7, domRect(0, 0, 300, 100))],
      scale: 4,
      rasterize,
    });

    expect(result.rectangle).toEqual(captureRect(0, 10, 150, 80));
    expect(result.blockRange).toEqual({ firstBlock: 7, lastBlock: 7, blockIndices: [7] });
    expect(result.image.width).toBe(140);
    expect(rasterize).toHaveBeenCalledWith({
      root,
      rectangle: captureRect(0, 10, 150, 80),
      scale: 2,
    });
  });

  it('refuses unmappable captures without invoking the rasterizer', async () => {
    const rasterize = jest.fn();

    await expect(
      captureVisibleArea({
        root: document.createElement('main'),
        start: { x: 0, y: 50 },
        end: { x: 100, y: 80 },
        viewport: captureRect(0, 0, 200, 100),
        blocks: [captureBlock(0, domRect(0, 0, 200, 30))],
        rasterize,
      })
    ).rejects.toMatchObject<Partial<FeedbackCaptureError>>({ code: 'MD4H-FB-ANCHOR-001' });
    expect(rasterize).not.toHaveBeenCalled();
  });

  it('defaults to the capped device-pixel ratio and preserves typed resource failures', async () => {
    const originalRatio = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 1.5, configurable: true });
    const resourceError = new FeedbackCaptureError(
      'MD4H-FB-CAPTURE-001',
      'A rendered image is unavailable.'
    );
    const rasterize = jest.fn(async () => {
      throw resourceError;
    });

    try {
      await expect(
        captureVisibleArea({
          root: document.createElement('main'),
          start: { x: 0, y: 0 },
          end: { x: 100, y: 80 },
          viewport: captureRect(0, 0, 200, 100),
          blocks: [captureBlock(0, domRect(0, 0, 200, 100))],
          rasterize,
        })
      ).rejects.toBe(resourceError);
      expect(rasterize).toHaveBeenCalledWith(expect.objectContaining({ scale: 1.5 }));
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', {
        value: originalRatio,
        configurable: true,
      });
    }
  });
});

describe('bitmap-space annotation commands', () => {
  it('converts client coordinates independently of CSS preview size', () => {
    const bitmap = { width: 1200, height: 800 };

    expect(clientPointToBitmap({ x: 350, y: 225 }, domRect(50, 25, 600, 400), bitmap)).toEqual({
      x: 600,
      y: 400,
    });
    expect(clientPointToBitmap({ x: 200, y: 125 }, domRect(50, 25, 300, 200), bitmap)).toEqual({
      x: 600,
      y: 400,
    });
  });

  it('clamps converted points to bitmap edges', () => {
    expect(
      clientPointToBitmap({ x: -20, y: 500 }, domRect(0, 0, 200, 100), {
        width: 1000,
        height: 500,
      })
    ).toEqual({ x: 0, y: 500 });
  });

  it('creates normalized rectangle and ellipse commands', () => {
    expect(createShapeAnnotation('rectangle', { x: 80, y: 70 }, { x: 20, y: 10 })).toEqual({
      type: 'rectangle',
      x: 20,
      y: 10,
      width: 60,
      height: 60,
    });
    expect(createShapeAnnotation('ellipse', { x: 10, y: 20 }, { x: 50, y: 80 })).toEqual({
      type: 'ellipse',
      x: 10,
      y: 20,
      width: 40,
      height: 60,
    });
  });

  it('constrains shapes to squares or circles with Shift in either drag direction', () => {
    expect(createShapeAnnotation('rectangle', { x: 100, y: 100 }, { x: 40, y: 80 }, true)).toEqual({
      type: 'rectangle',
      x: 40,
      y: 40,
      width: 60,
      height: 60,
    });
    expect(createShapeAnnotation('ellipse', { x: 10, y: 10 }, { x: 30, y: 50 }, true)).toEqual({
      type: 'ellipse',
      x: 10,
      y: 10,
      width: 40,
      height: 40,
    });
  });

  it('keeps constrained shapes inside optional bitmap bounds', () => {
    expect(
      createShapeAnnotation('rectangle', { x: 90, y: 90 }, { x: 140, y: 120 }, true, {
        width: 100,
        height: 100,
      })
    ).toEqual({ type: 'rectangle', x: 90, y: 90, width: 10, height: 10 });
  });
});

describe('annotation history', () => {
  const rectangle: AnnotationCommand = {
    type: 'rectangle',
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  };
  const ellipse: AnnotationCommand = {
    type: 'ellipse',
    x: 5,
    y: 6,
    width: 7,
    height: 8,
  };

  it('supports undo, redo, and a redo branch reset', () => {
    const history = new AnnotationHistory();
    history.add(rectangle);
    history.add(ellipse);

    expect(history.undo()).toBe(true);
    expect(history.commands).toEqual([rectangle]);
    expect(history.redo()).toBe(true);
    expect(history.commands).toEqual([rectangle, ellipse]);
    expect(history.undo()).toBe(true);
    history.add({ type: 'pen', points: [{ x: 3, y: 3 }] });
    expect(history.redo()).toBe(false);
  });

  it('makes Clear undoable without adding empty no-op history entries', () => {
    const history = new AnnotationHistory();
    expect(history.clear()).toBe(false);
    history.add(rectangle);
    history.add(ellipse);

    expect(history.clear()).toBe(true);
    expect(history.commands).toEqual([]);
    expect(history.undo()).toBe(true);
    expect(history.commands).toEqual([rectangle, ellipse]);
  });
});

describe('PNG flattening', () => {
  it('draws the base image and every typed annotation into one bitmap', () => {
    const { canvasFactory, context, canvas } = fakeCanvas();
    const image = document.createElement('img');

    const png = flattenAnnotationsToPng(
      image,
      { width: 800, height: 600 },
      [
        {
          type: 'pen',
          points: [
            { x: 1, y: 2 },
            { x: 3, y: 4 },
          ],
        },
        { type: 'rectangle', x: 10, y: 20, width: 30, height: 40 },
        { type: 'ellipse', x: 100, y: 120, width: 80, height: 60 },
      ],
      canvasFactory
    );

    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(context.drawImage).toHaveBeenCalledWith(image, 0, 0, 800, 600);
    expect(context.strokeRect).toHaveBeenCalled();
    expect(context.ellipse).toHaveBeenCalled();
    expect(png).toBe('data:image/png;base64,flattened');
  });

  it('flattens each annotation with the color chosen when it was drawn', () => {
    const { canvasFactory, strokeStyles } = fakeCanvas();

    flattenAnnotationsToPng(
      document.createElement('img'),
      { width: 320, height: 180 },
      [
        { type: 'rectangle', x: 10, y: 10, width: 40, height: 30, color: 'yellow' },
        { type: 'ellipse', x: 70, y: 20, width: 50, height: 40, color: 'blue' },
      ],
      canvasFactory
    );

    expect(strokeStyles).toEqual(['#1f2328', '#f5c400', '#ffffff', '#2f81f7']);
  });
});

describe('feedback annotation modal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('uses a base image plus SVG overlay with accessible tool state', () => {
    const previousFocus = document.createElement('button');
    document.body.appendChild(previousFocus);
    previousFocus.focus();
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      onAdd: jest.fn(),
      onRetake: jest.fn(),
      onCancel: jest.fn(),
    });

    expect(controller.element.getAttribute('role')).toBe('dialog');
    expect(controller.element.getAttribute('aria-modal')).toBe('true');
    expect(controller.element.querySelector('img')?.getAttribute('alt')).toBe(
      'Captured document area'
    );
    expect(controller.element.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 800 600');
    expect(controller.element.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe(
      'Screenshot annotation tools'
    );
    expect(
      controller.element
        .querySelector('[aria-label="Rectangle tool"]')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
    expect(document.activeElement).toBe(
      controller.element.querySelector('[aria-label="Rectangle tool"]')
    );
  });

  it('changes tools without installing document-level shortcuts', () => {
    const documentListener = jest.spyOn(document, 'addEventListener');
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      onAdd: jest.fn(),
      onRetake: jest.fn(),
      onCancel: jest.fn(),
    });

    const pen = controller.element.querySelector<HTMLButtonElement>('[aria-label="Pen tool"]');
    pen?.click();

    expect(pen?.getAttribute('aria-pressed')).toBe('true');
    expect(controller.tool).toBe('pen');
    expect(documentListener).not.toHaveBeenCalled();
    documentListener.mockRestore();
  });

  it('records pointer annotations in bitmap coordinates despite CSS resizing', () => {
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 1000, height: 500 },
      onAdd: jest.fn(),
      onRetake: jest.fn(),
      onCancel: jest.fn(),
    });
    const overlay = controller.element.querySelector<SVGSVGElement>('svg');
    if (!overlay) throw new Error('Missing annotation overlay');
    overlay.getBoundingClientRect = () => domRect(100, 50, 500, 250);

    overlay.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 150, clientY: 100, bubbles: true })
    );
    overlay.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 350, clientY: 200, bubbles: true, shiftKey: true })
    );
    overlay.dispatchEvent(
      new MouseEvent('pointerup', { clientX: 350, clientY: 200, bubbles: true, shiftKey: true })
    );

    expect(controller.commands).toEqual([
      { type: 'rectangle', x: 100, y: 100, width: 400, height: 400, color: 'coral' },
    ]);
  });

  it('supports undo, redo, and undoable clear through labelled controls', () => {
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      onAdd: jest.fn(),
      onRetake: jest.fn(),
      onCancel: jest.fn(),
    });
    controller.addCommand({ type: 'rectangle', x: 1, y: 2, width: 30, height: 40 });

    controller.element
      .querySelector<HTMLButtonElement>('[aria-label="Clear annotations"]')
      ?.click();
    expect(controller.commands).toEqual([]);
    controller.element.querySelector<HTMLButtonElement>('[aria-label="Undo annotation"]')?.click();
    expect(controller.commands).toHaveLength(1);
    controller.element.querySelector<HTMLButtonElement>('[aria-label="Redo annotation"]')?.click();
    expect(controller.commands).toEqual([]);
  });

  it('offers a compact labelled color palette and keeps colors on individual drawings', () => {
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      onAdd: jest.fn(),
      onRetake: jest.fn(),
      onCancel: jest.fn(),
    });
    const colorGroup = controller.element.querySelector<HTMLElement>(
      '[role="group"][aria-label="Annotation color"]'
    );
    const swatches = Array.from(
      colorGroup?.querySelectorAll<HTMLButtonElement>('[data-feedback-color]') ?? []
    );

    expect(swatches).toHaveLength(4);
    expect(colorGroup?.querySelector('.feedback-annotation-color-label')?.textContent).toBe(
      'Color'
    );
    expect(swatches.map(button => button.getAttribute('aria-label'))).toEqual([
      'Coral annotation color',
      'Yellow annotation color',
      'Blue annotation color',
      'Green annotation color',
    ]);
    expect(swatches[0]?.getAttribute('aria-pressed')).toBe('true');

    const overlay = controller.element.querySelector<SVGSVGElement>('svg')!;
    overlay.getBoundingClientRect = () => domRect(0, 0, 800, 600);
    swatches[1]?.click();
    overlay.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 10, clientY: 20, bubbles: true })
    );
    overlay.dispatchEvent(new MouseEvent('pointerup', { clientX: 40, clientY: 60, bubbles: true }));
    controller.setTool('ellipse');
    swatches[2]?.click();
    overlay.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 50, clientY: 60, bubbles: true })
    );
    overlay.dispatchEvent(
      new MouseEvent('pointerup', { clientX: 120, clientY: 140, bubbles: true })
    );

    expect(controller.color).toBe('blue');
    expect(swatches[1]?.getAttribute('aria-pressed')).toBe('false');
    expect(swatches[2]?.getAttribute('aria-pressed')).toBe('true');
    expect(controller.commands.map(command => command.color)).toEqual(['yellow', 'blue']);
    expect(
      Array.from(controller.element.querySelectorAll('[data-annotation-type]')).map(group =>
        group.querySelector('[data-annotation-stroke]')?.getAttribute('stroke')
      )
    ).toEqual(['#f5c400', '#2f81f7']);

    controller.undo();
    controller.redo();
    expect(controller.commands.map(command => command.color)).toEqual(['yellow', 'blue']);
  });

  it('changes an empty Cancel action to an in-webview Discard checkpoint after drawing', async () => {
    const onCancel = jest.fn();
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      onAdd: jest.fn(),
      onRetake: jest.fn(),
      onCancel,
    });
    const cancel = controller.element.querySelector<HTMLButtonElement>(
      '[data-feedback-action="cancel"]'
    );

    expect(cancel?.textContent).toBe('Cancel');
    controller.addCommand({ type: 'rectangle', x: 1, y: 2, width: 30, height: 40 });
    expect(cancel?.textContent).toBe('Discard');

    cancel?.click();
    const checkpoint = document.querySelector<HTMLElement>('[data-feedback-discard-dialog]');
    expect(checkpoint?.getAttribute('role')).toBe('dialog');
    expect(checkpoint?.textContent).toContain(
      'Your unfinished comment and annotations will be lost.'
    );
    document.body.tabIndex = -1;
    document.body.focus();
    controller.focus();
    expect(document.activeElement).toBe(
      checkpoint?.querySelector<HTMLElement>('[data-feedback-discard-keep]')
    );
    expect(onCancel).not.toHaveBeenCalled();
    expect(controller.element.isConnected).toBe(true);

    checkpoint?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Promise.resolve();
    expect(controller.element.isConnected).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      controller.element.querySelector<HTMLTextAreaElement>('textarea')
    );

    cancel?.click();
    document
      .querySelector<HTMLElement>('[data-feedback-discard-dialog]')
      ?.querySelector<HTMLButtonElement>('[data-feedback-discard-confirm]')
      ?.click();
    await Promise.resolve();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(controller.element.isConnected).toBe(false);
  });

  it('requires nonblank feedback and allocates no canvas before Add', async () => {
    const onAdd = jest.fn();
    const { canvasFactory } = fakeCanvas();
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      canvasFactory,
      onAdd,
      onRetake: jest.fn(),
      onCancel: jest.fn(),
    });
    const input = controller.element.querySelector<HTMLTextAreaElement>('textarea');
    const addButton = controller.element.querySelector<HTMLButtonElement>(
      '[data-feedback-action="add"]'
    );

    expect(canvasFactory).not.toHaveBeenCalled();
    expect(addButton?.disabled).toBe(true);
    expect(await controller.submit()).toBe(false);
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(canvasFactory).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();

    if (!input) throw new Error('Missing feedback input');
    input.value = '  Make this hierarchy clearer.  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(addButton?.disabled).toBe(false);
    expect(await controller.submit()).toBe(true);
    expect(canvasFactory).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        feedback: 'Make this hierarchy clearer.',
        pngDataUrl: 'data:image/png;base64,flattened',
      })
    );
  });

  it('locks annotation controls during Add and restores the draft after a failed write', async () => {
    let rejectWrite: ((error: Error) => void) | undefined;
    const onAdd = jest.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        })
    );
    const { canvasFactory } = fakeCanvas();
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      canvasFactory,
      onAdd,
      onRetake: jest.fn(),
      onCancel: jest.fn(),
    });
    const input = controller.element.querySelector<HTMLTextAreaElement>('textarea')!;
    const cancel = controller.element.querySelector<HTMLButtonElement>(
      '[data-feedback-action="cancel"]'
    )!;
    const retake = controller.element.querySelector<HTMLButtonElement>(
      '[data-feedback-action="retake"]'
    )!;
    const tool = controller.element.querySelector<HTMLButtonElement>(
      '[aria-label="Rectangle tool"]'
    )!;
    const color = controller.element.querySelector<HTMLButtonElement>('[data-feedback-color]')!;
    input.value = 'Keep this draft after failure';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const submission = controller.submit();
    await Promise.resolve();

    expect(input.readOnly).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(retake.disabled).toBe(true);
    expect(tool.disabled).toBe(true);
    expect(color.disabled).toBe(true);

    rejectWrite?.(new Error('Write failed'));
    await expect(submission).resolves.toBe(false);
    expect(input.value).toBe('Keep this draft after failure');
    expect(input.readOnly).toBe(false);
    expect(cancel.disabled).toBe(false);
    expect(retake.disabled).toBe(false);
    expect(tool.disabled).toBe(false);
    expect(color.disabled).toBe(false);
  });

  it('restores focus to the logical toolbar control after Add rerenders it', async () => {
    const previousControl = document.createElement('button');
    previousControl.setAttribute('data-feedback-control', 'capture');
    previousControl.setAttribute('data-feedback-capture', '');
    document.body.append(previousControl);
    previousControl.focus();
    let replacementControl: HTMLButtonElement | null = null;
    const { canvasFactory } = fakeCanvas();
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      canvasFactory,
      returnFocus: previousControl,
      onAdd: () => {
        replacementControl = document.createElement('button');
        replacementControl.setAttribute('data-feedback-control', 'capture');
        replacementControl.setAttribute('data-feedback-capture', '');
        previousControl.replaceWith(replacementControl);
      },
      onRetake: jest.fn(),
      onCancel: jest.fn(),
    });
    const input = controller.element.querySelector<HTMLTextAreaElement>('textarea')!;
    input.value = 'Keep focus on the capture workflow';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(await controller.submit()).toBe(true);
    expect(replacementControl).not.toBeNull();
    expect(document.activeElement).toBe(replacementControl);
  });

  it('restores focus to the logical card action after Add rerenders its card', async () => {
    const previousCard = document.createElement('article');
    previousCard.setAttribute('data-feedback-card', 'F7');
    const previousAction = document.createElement('button');
    previousAction.textContent = 'Replace capture';
    previousCard.append(previousAction);
    const editorFallback = document.createElement('div');
    editorFallback.tabIndex = 0;
    document.body.append(previousCard, editorFallback);
    previousAction.focus();
    let replacementAction: HTMLButtonElement | null = null;
    const { canvasFactory } = fakeCanvas();
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      canvasFactory,
      returnFocus: previousAction,
      fallbackFocus: editorFallback,
      onAdd: () => {
        const replacementCard = document.createElement('article');
        replacementCard.setAttribute('data-feedback-card', 'F7');
        replacementAction = document.createElement('button');
        replacementAction.textContent = 'Replace capture';
        replacementCard.append(replacementAction);
        previousCard.replaceWith(replacementCard);
      },
      onRetake: jest.fn(),
      onCancel: jest.fn(),
    });
    const input = controller.element.querySelector<HTMLTextAreaElement>('textarea')!;
    input.value = 'Keep focus on this screenshot comment';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(await controller.submit()).toBe(true);
    expect(replacementAction).not.toBeNull();
    expect(document.activeElement).toBe(replacementAction);
  });

  it('falls back to the editor when the logical capture control disappears', async () => {
    const previousControl = document.createElement('button');
    previousControl.setAttribute('data-feedback-control', 'capture');
    const editorFallback = document.createElement('div');
    editorFallback.tabIndex = 0;
    document.body.append(previousControl, editorFallback);
    previousControl.focus();
    const { canvasFactory } = fakeCanvas();
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      canvasFactory,
      returnFocus: previousControl,
      fallbackFocus: editorFallback,
      onAdd: () => previousControl.remove(),
      onRetake: jest.fn(),
      onCancel: jest.fn(),
    });
    const input = controller.element.querySelector<HTMLTextAreaElement>('textarea')!;
    input.value = 'Restore focus safely';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(await controller.submit()).toBe(true);
    expect(document.activeElement).toBe(editorFallback);
  });

  it('passes draft feedback to Retake without flattening and restores focus', async () => {
    const previousFocus = document.createElement('button');
    document.body.appendChild(previousFocus);
    previousFocus.focus();
    const onRetake = jest.fn();
    const { canvasFactory } = fakeCanvas();
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      canvasFactory,
      onAdd: jest.fn(),
      onRetake,
      onCancel: jest.fn(),
    });
    const input = controller.element.querySelector<HTMLTextAreaElement>('textarea');
    if (!input) throw new Error('Missing feedback input');
    input.value = 'Keep this note for the next crop';

    expect(await controller.retake()).toBe(true);
    expect(onRetake).toHaveBeenCalledWith('Keep this note for the next crop');
    expect(canvasFactory).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(previousFocus);
  });

  it('restores logical focus before Retake opens its replacement surface', async () => {
    const previousFocus = document.createElement('button');
    const replacementSurface = document.createElement('button');
    document.body.append(previousFocus, replacementSurface);
    previousFocus.focus();
    const focusSeenByRetake: Element[] = [];
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      onAdd: jest.fn(),
      onRetake: () => {
        if (document.activeElement) focusSeenByRetake.push(document.activeElement);
        replacementSurface.focus();
      },
      onCancel: jest.fn(),
    });

    expect(await controller.retake()).toBe(true);
    expect(focusSeenByRetake).toEqual([previousFocus]);
    expect(document.activeElement).toBe(replacementSurface);
  });

  it('cancels without flattening or adding and restores focus', () => {
    const previousFocus = document.createElement('button');
    document.body.appendChild(previousFocus);
    previousFocus.focus();
    const onAdd = jest.fn();
    const onCancel = jest.fn();
    const { canvasFactory } = fakeCanvas();
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      canvasFactory,
      onAdd,
      onRetake: jest.fn(),
      onCancel,
    });

    controller.cancel();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAdd).not.toHaveBeenCalled();
    expect(canvasFactory).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(previousFocus);
  });

  it('confirms inside the webview before cancelling typed screenshot feedback', async () => {
    const onCancel = jest.fn();
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      onAdd: jest.fn(),
      onRetake: jest.fn(),
      onCancel,
    });
    const input = controller.element.querySelector<HTMLTextAreaElement>('textarea');
    if (!input) throw new Error('Missing feedback input');
    input.value = 'Keep this draft';

    controller.cancel();
    const checkpoint = document.querySelector<HTMLElement>('[data-feedback-discard-dialog]');
    expect(checkpoint?.getAttribute('aria-modal')).toBe('true');
    expect(onCancel).not.toHaveBeenCalled();
    expect(controller.element.isConnected).toBe(true);

    checkpoint?.querySelector<HTMLButtonElement>('[data-feedback-discard-confirm]')?.click();
    await Promise.resolve();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(controller.element.isConnected).toBe(false);
  });

  it('closes annotation and discard dialogs immediately on snapshot invalidation', () => {
    const previousFocus = document.createElement('button');
    document.body.append(previousFocus);
    previousFocus.focus();
    const onAdd = jest.fn();
    const onCancel = jest.fn();
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      onAdd,
      onRetake: jest.fn(),
      onCancel,
    });
    const input = controller.element.querySelector<HTMLTextAreaElement>('textarea')!;
    input.value = 'Unsaved screenshot feedback';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    controller.cancel();
    expect(document.querySelector('[data-feedback-discard-dialog]')).not.toBeNull();
    document.body.classList.add('feedback-capture-active');

    window.dispatchEvent(new CustomEvent('feedbackInvalidated'));

    expect(controller.element.isConnected).toBe(false);
    expect(document.querySelector('[data-feedback-discard-dialog]')).toBeNull();
    expect(document.body.classList.contains('feedback-capture-active')).toBe(false);
    expect(document.activeElement).toBe(previousFocus);
    expect(onAdd).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('closes once on Feedback session end and rejects later submissions', async () => {
    const previousFocus = document.createElement('button');
    document.body.append(previousFocus);
    previousFocus.focus();
    const onAdd = jest.fn();
    const onCancel = jest.fn();
    const controller = createFeedbackAnnotationModal({
      image: { dataUrl: 'data:image/png;base64,base', width: 800, height: 600 },
      onAdd,
      onRetake: jest.fn(),
      onCancel,
    });
    const input = controller.element.querySelector<HTMLTextAreaElement>('textarea')!;
    input.value = 'This must not be written';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.body.classList.add('feedback-capture-active');

    window.dispatchEvent(new CustomEvent('feedbackSessionEnded'));
    window.dispatchEvent(new CustomEvent('feedbackSessionEnded'));

    expect(controller.element.isConnected).toBe(false);
    expect(document.body.classList.contains('feedback-capture-active')).toBe(false);
    expect(document.activeElement).toBe(previousFocus);
    expect(await controller.submit()).toBe(false);
    expect(onAdd).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
