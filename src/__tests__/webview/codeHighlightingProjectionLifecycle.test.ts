/** @jest-environment jsdom */
/// <reference lib="es2021.weakref" />
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';
import {
  codeHighlightingKey,
  createCodeHighlightingPlugin,
} from '../../webview/highlighting/plugin';
import * as projection from '../../webview/highlighting/projection';
import type { ViewportRange } from '../../webview/highlighting/projection';
import type { HighlightResult, HighlightService } from '../../webview/highlighting/types';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    codeBlock: {
      group: 'block',
      content: 'text*',
      code: true,
      attrs: { language: { default: 'ts' } },
      toDOM: () => ['pre', ['code', 0]],
    },
  },
});
const text = 'x '.repeat(5000);
const canonical: HighlightResult = {
  spans: Array.from({ length: 5000 }, (_, index) => ({
    from: index * 2,
    to: index * 2 + 1,
    classes: 'hljs-keyword',
  })),
};
const code = (source: string) =>
  schema.nodes.codeBlock.create({ language: 'ts' }, schema.text(source));

class ControlledService implements HighlightService {
  requests: Array<{ source: string; resolve: (result: HighlightResult) => void }> = [];
  dispose = jest.fn();
  highlight = jest.fn(
    (_grammar: string, source: string): Promise<HighlightResult> =>
      new Promise(resolve => {
        this.requests.push({ source, resolve });
      })
  );
  complete(index: number, result: HighlightResult = canonical): void {
    this.requests[index].resolve(result);
  }
}
class ObservableResize {
  static instances: ObservableResize[] = [];
  observe = jest.fn();
  disconnect = jest.fn();
  constructor(private readonly callback: ResizeObserverCallback) {
    ObservableResize.instances.push(this);
  }
  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}
class CollectableWeakRef<T extends object> {
  static instances: Array<CollectableWeakRef<object>> = [];
  constructor(private target: T | undefined) {
    CollectableWeakRef.instances.push(this);
  }
  deref(): T | undefined {
    return this.target;
  }
  static collect(): void {
    for (const reference of this.instances) reference.target = undefined;
  }
}

describe('large-block projection interaction and lifecycle', () => {
  let view: EditorView;
  let service: ControlledService;
  let viewport: jest.SpyInstance<ViewportRange, [EditorView]>;
  let documentEdits: number;
  let dispatches: number;
  let container: HTMLElement;
  const weakRefDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WeakRef');
  const resizeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');

  beforeEach(() => {
    jest.useFakeTimers();
    ObservableResize.instances = [];
    CollectableWeakRef.instances = [];
    Object.defineProperty(globalThis, 'WeakRef', { configurable: true, value: CollectableWeakRef });
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: ObservableResize,
    });
    service = new ControlledService();
    documentEdits = 0;
    dispatches = 0;
    viewport = jest.spyOn(projection, 'readViewportRange').mockReturnValue({ from: 1, to: 101 });
  });
  afterEach(() => {
    view?.destroy();
    container?.remove();
    if (weakRefDescriptor) Object.defineProperty(globalThis, 'WeakRef', weakRefDescriptor);
    else Reflect.deleteProperty(globalThis, 'WeakRef');
    if (resizeDescriptor) Object.defineProperty(globalThis, 'ResizeObserver', resizeDescriptor);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  function open(source = text): void {
    container = document.createElement('div');
    document.body.append(container);
    view = new EditorView(container, {
      state: EditorState.create({
        schema,
        doc: schema.nodes.doc.create(null, [code(source)]),
        plugins: [createCodeHighlightingPlugin(() => service)],
      }),
      dispatchTransaction(transaction) {
        dispatches++;
        if (transaction.docChanged) documentEdits++;
        view.updateState(view.state.apply(transaction));
      },
    });
  }
  async function tick(): Promise<void> {
    await jest.advanceTimersByTimeAsync(25);
  }
  async function settleInitial(): Promise<void> {
    await tick();
    service.complete(0);
    await tick();
  }
  const ranges = () =>
    codeHighlightingKey
      .getState(view.state)!
      .decorations.find()
      .map(item => [item.from, item.to]);

  it('projects resize and descendant horizontal-scroll events without re-lexing valid source', async () => {
    open();
    await settleInitial();
    const initialCalls = service.highlight.mock.calls.length;
    viewport.mockReturnValue({ from: 2001, to: 2201 });
    ObservableResize.instances[0].trigger();
    await tick();
    expect(ranges()).toHaveLength(100);
    expect(ranges()[0]).toEqual([2001, 2002]);
    viewport.mockReturnValue({ from: 6001, to: 6101 });
    view.dom.querySelector('pre')!.dispatchEvent(new Event('scroll', { bubbles: false }));
    await tick();
    expect(ranges()).toHaveLength(50);
    expect(ranges()[0]).toEqual([6001, 6002]);
    expect(service.highlight).toHaveBeenCalledTimes(initialCalls);
    expect(service.requests[0].source).toBe(text);
    expect(documentEdits).toBe(0);
  });

  it('keeps the projection while scrolling inside its overscan, then re-centers it once', async () => {
    viewport.mockReturnValue({ from: 1, to: 2001, visible: [801, 1201] });
    open();
    await settleInitial();
    expect(ranges()).toHaveLength(1000);
    expect(ranges()[0]).toEqual([1, 2]);
    const before = dispatches;
    for (const offset of [100, 200, 300, 400, 500]) {
      viewport.mockReturnValue({
        from: 1 + offset,
        to: 2001 + offset,
        visible: [801 + offset, 1201 + offset],
      });
      window.dispatchEvent(new Event('scroll'));
      await tick();
    }
    expect(dispatches).toBe(before);
    viewport.mockReturnValue({ from: 1601, to: 3601, visible: [2401, 2801] });
    window.dispatchEvent(new Event('scroll'));
    await tick();
    expect(dispatches).toBe(before + 1);
    expect(ranges()[0]).toEqual([1601, 1602]);
    expect(service.highlight).toHaveBeenCalledTimes(1);
  });

  it('chooses the latest viewport after a job finishes, rather than the requested viewport', async () => {
    open();
    await tick();
    viewport.mockReturnValue({ from: 8001, to: 8101 });
    window.dispatchEvent(new Event('scroll'));
    await tick();
    service.complete(0);
    await tick();
    expect(ranges()).toHaveLength(50);
    expect(ranges()[0]).toEqual([8001, 8002]);
    expect(service.requests).toHaveLength(1);
    expect(service.requests[0].source).toBe(text);
  });

  it('restores missing projected tokens after GC with one complete-source job', async () => {
    open();
    await settleInitial();
    CollectableWeakRef.collect();
    viewport.mockReturnValue({ from: 4001, to: 4101 });
    window.dispatchEvent(new Event('scroll'));
    await tick();
    expect(service.requests).toHaveLength(2);
    expect(service.requests[1].source).toBe(text);
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('scroll'));
    await tick();
    expect(service.requests).toHaveLength(2);
    service.complete(1);
    await tick();
    expect(ranges()).toHaveLength(50);
    expect(ranges()[0]).toEqual([4001, 4002]);
    expect(documentEdits).toBe(0);
    expect(view.dom.textContent).toBe(text);
  });

  it('clears offscreen colors without work, then restores visibility from canonical tokens', async () => {
    open();
    await settleInitial();
    viewport.mockReturnValue({ from: 0, to: 0 });
    window.dispatchEvent(new Event('scroll'));
    await tick();
    expect(ranges()).toEqual([]);
    expect(service.requests).toHaveLength(1);
    viewport.mockReturnValue({ from: 101, to: 201 });
    window.dispatchEvent(new Event('scroll'));
    await tick();
    expect(ranges()).toHaveLength(50);
    expect(ranges()[0]).toEqual([101, 102]);
    expect(service.requests).toHaveLength(1);
  });

  it('preserves complete multiline token boundaries without lexing a visible fragment', async () => {
    const comment = '/*' + 'x'.repeat(998) + '*/';
    const source = comment + text;
    open(source);
    await tick();
    viewport.mockReturnValue({ from: 101, to: 201 });
    service.complete(0, {
      spans: [
        { from: 0, to: comment.length, classes: 'hljs-comment' },
        ...canonical.spans.map(span => ({
          ...span,
          from: span.from + comment.length,
          to: span.to + comment.length,
        })),
      ],
    });
    await tick();
    expect(ranges()).toEqual([[1, comment.length + 1]]);
    expect(view.dom.querySelector('.hljs-comment')?.textContent).toBe(comment);
    expect(service.requests[0].source).toBe(source);
    expect(view.dom.textContent).toBe(source);
  });

  it('disposes page-hidden views and cancels projection, resize and late-result callbacks', async () => {
    open();
    await tick();
    const before = dispatches;
    window.dispatchEvent(new Event('pagehide'));
    expect(service.dispose).toHaveBeenCalledTimes(1);
    expect(ObservableResize.instances[0].disconnect).toHaveBeenCalledTimes(1);
    viewport.mockClear();
    window.dispatchEvent(new Event('resize'));
    view.dom.querySelector('pre')!.dispatchEvent(new Event('scroll'));
    ObservableResize.instances[0].trigger();
    service.complete(0);
    await tick();
    expect(viewport).not.toHaveBeenCalled();
    expect(dispatches).toBe(before);
    expect(ranges()).toEqual([]);
    view.destroy();
    expect(service.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not apply a previous document result after a full replacement and viewport move', async () => {
    open();
    await tick();
    const replacement = 'y' + text.slice(1);
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, code(replacement)));
    viewport.mockReturnValue({ from: 2001, to: 2101 });
    service.complete(0);
    await tick();
    expect(ranges()).toEqual([]);
    expect(service.requests).toHaveLength(2);
    expect(service.requests[1].source).toBe(replacement);
    service.complete(1, {
      spans: canonical.spans.map(span => ({ ...span, classes: 'hljs-string' })),
    });
    await tick();
    expect(ranges()).toHaveLength(50);
    expect(ranges()[0]).toEqual([2001, 2002]);
    expect(view.dom.querySelector('.hljs-keyword')).toBeNull();
  });

  it('keeps no-layout detached test views usable with the documented full-range fallback', async () => {
    open();
    container.remove();
    viewport.mockRestore();
    await settleInitial();
    expect(ranges()).toHaveLength(canonical.spans.length);
    expect(view.dom.textContent).toBe(text);
    expect(service.requests).toHaveLength(1);
  });

  it('defers geometry reads until after a foreground typing transaction', async () => {
    open();
    await settleInitial();
    viewport.mockClear();
    view.dispatch(view.state.tr.insertText('z', 1));
    expect(viewport).not.toHaveBeenCalled();
    await tick();
    expect(viewport).toHaveBeenCalled();
    expect(service.requests[1].source).toBe('z' + text);
  });
});
