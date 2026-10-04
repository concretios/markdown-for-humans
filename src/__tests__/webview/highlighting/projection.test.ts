/** @jest-environment jsdom */
import type { EditorView } from '@tiptap/pm/view';
import { projectTokenSpans, readViewportRange } from '../../../webview/highlighting/projection';
import type { TokenSpan } from '../../../webview/highlighting/types';

const span = (from: number, to: number): TokenSpan => ({ from, to, classes: 'hljs-string' });

describe('source-relative token projection', () => {
  it('keeps complete intersecting canonical spans with half-open boundaries', () => {
    const spans = [span(0, 5), span(8, 14), span(17, 22), span(24, 30)];
    const result = projectTokenSpans(spans, 5, 24);
    expect(result).toEqual([spans[1], spans[2]]);
    expect(result[0]).toBe(spans[1]);
    expect(projectTokenSpans(spans, 10, 12)).toEqual([spans[1]]);
    expect(projectTokenSpans(spans, 20, 20)).toEqual([]);
    expect(projectTokenSpans(spans, 50, 60)).toEqual([]);
    expect(projectTokenSpans([], 0, 10)).toEqual([]);
  });

  it('finds a late viewport without examining the preceding 100,000 tokens', () => {
    let reads = 0;
    const source = Array.from({ length: 100000 }, (_, index) => span(index * 4, index * 4 + 2));
    const spans = new Proxy(source, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(projectTokenSpans(spans, 399960, 399970)).toEqual(source.slice(99990, 99993));
    expect(reads).toBeLessThan(50);
  });

  it('handles invalid ranges without producing invalid decorations', () => {
    const source = [span(0, 5)];
    expect(projectTokenSpans(source, NaN, 5)).toEqual([]);
    expect(projectTokenSpans(source, 0, NaN)).toEqual([]);
    expect(projectTokenSpans(source, 10, 1)).toEqual([]);
    expect(projectTokenSpans(source, -10, 2)).toEqual(source);
  });
});

describe('deferred viewport geometry', () => {
  const documentSize = 40000;
  function fakeView(
    rect: Partial<DOMRect>,
    position: (coordinates: { left: number; top: number }) => number | null
  ) {
    const dom = document.createElement('div');
    jest.spyOn(dom, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      width: 0,
      height: 0,
      toJSON() {
        return {};
      },
      ...rect,
    } as DOMRect);
    const posAtCoords = jest.fn(coordinates => {
      const pos = position(coordinates);
      return pos === null ? null : { pos, inside: -1 };
    });
    return {
      dom,
      posAtCoords,
      state: { doc: { content: { size: documentSize } } },
    } as unknown as EditorView;
  }

  it('uses visual corner positions and overscan, accounting for wrapped lines and horizontal scroll', () => {
    const view = fakeView(
      { top: -1000, bottom: 9000, left: 40, right: 840, width: 800, height: 10000 },
      ({ top, left }) => {
        if (top < 10) return left < 400 ? 10000 : 10100;
        return left < 400 ? 19900 : 20000;
      }
    );
    expect(readViewportRange(view)).toEqual({ from: 6000, to: 24000, visible: [10000, 20000] });
    expect(view.posAtCoords).toHaveBeenCalledTimes(4);
    for (const [coordinates] of (view.posAtCoords as jest.Mock).mock.calls) {
      expect(coordinates.top).toBeGreaterThanOrEqual(0);
      expect(coordinates.top).toBeLessThan(window.innerHeight);
      expect(coordinates.left).toBeGreaterThanOrEqual(40);
      expect(coordinates.left).toBeLessThan(840);
    }
  });

  it('clamps overscan to the document and uses all corners regardless of text direction', () => {
    const view = fakeView(
      { top: 0, bottom: 300, left: 0, right: 700, width: 700, height: 300 },
      ({ left }) => (left < 300 ? 39999 : 3)
    );
    expect(readViewportRange(view)).toEqual({ from: 0, to: documentSize, visible: [3, 39999] });
  });

  function withHitTesting<T>(
    view: EditorView,
    hit: (x: number, y: number) => Element | null,
    run: () => T
  ): T {
    const owner = view.dom.ownerDocument;
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'elementFromPoint');
    Object.defineProperty(owner, 'elementFromPoint', { configurable: true, value: jest.fn(hit) });
    owner.body.append(view.dom);
    try {
      return run();
    } finally {
      view.dom.remove();
      if (descriptor) Object.defineProperty(owner, 'elementFromPoint', descriptor);
      else Reflect.deleteProperty(owner, 'elementFromPoint');
    }
  }

  it('measures the visible range below a sticky toolbar that covers the editor edge', () => {
    // A scrolled editor extends above the webview; its formatting toolbar is fixed
    // over the top 40 px. ProseMirror maps covered points to the code block start.
    const view = fakeView(
      { top: -50000, bottom: 50000, left: 0, right: 800, width: 800, height: 100000 },
      ({ top }) => (top < 40 ? 13 : 20000 + Math.round(top))
    );
    const toolbar = document.createElement('div');
    const line = document.createElement('span');
    view.dom.append(line);
    const range = withHitTesting(
      view,
      (_x, y) => (y < 40 ? toolbar : line),
      () => readViewportRange(view)
    );
    expect(range.visible![0]).toBeGreaterThanOrEqual(20040);
    expect(range.from).toBeGreaterThanOrEqual(16040);
    expect(range.to - range.from).toBeLessThan(10000);
  });

  it('measures the visible range above an overlay that covers the editor bottom edge', () => {
    const view = fakeView(
      { top: -50000, bottom: 50000, left: 0, right: 800, width: 800, height: 100000 },
      ({ top }) => (top > window.innerHeight - 60 ? 0 : 20000 + Math.round(top))
    );
    const panel = document.createElement('aside');
    const line = document.createElement('span');
    view.dom.append(line);
    const range = withHitTesting(
      view,
      (_x, y) => (y > window.innerHeight - 60 ? panel : line),
      () => readViewportRange(view)
    );
    expect(range.visible![1]).toBeLessThanOrEqual(20000 + window.innerHeight - 60);
    expect(range.visible![0]).toBeGreaterThanOrEqual(20000);
  });

  it('returns the full range when layout is unavailable in deterministic tests', () => {
    const view = fakeView({}, () => null);
    expect(readViewportRange(view)).toEqual({ from: 0, to: documentSize });
    expect(view.posAtCoords).not.toHaveBeenCalled();
  });

  it.each([
    { width: 0, height: 10000 },
    { width: 800, height: 0 },
    { width: 0, height: 0 },
  ])('does not project invisible tokens for a connected zero-size editor: %o', rect => {
    const view = fakeView(rect, () => null);
    const owner = view.dom.ownerDocument;
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'elementFromPoint');
    Object.defineProperty(owner, 'elementFromPoint', {
      configurable: true,
      value: jest.fn(() => null),
    });
    owner.body.append(view.dom);
    try {
      expect(readViewportRange(view)).toEqual({ from: 0, to: 0, visible: [0, 0] });
      expect(view.posAtCoords).not.toHaveBeenCalled();
    } finally {
      view.dom.remove();
      if (descriptor) Object.defineProperty(owner, 'elementFromPoint', descriptor);
      else Reflect.deleteProperty(owner, 'elementFromPoint');
    }
  });

  it('preserves the full fallback for connected environments without browser hit testing', () => {
    const view = fakeView({}, () => null);
    view.dom.ownerDocument.body.append(view.dom);
    try {
      expect(readViewportRange(view)).toEqual({ from: 0, to: documentSize });
    } finally {
      view.dom.remove();
    }
  });

  it('fails safely when hit testing cannot produce document positions', () => {
    const view = fakeView(
      { top: 0, bottom: 300, left: 0, right: 700, width: 700, height: 300 },
      () => null
    );
    expect(readViewportRange(view)).toEqual({ from: 0, to: documentSize });
  });
});
