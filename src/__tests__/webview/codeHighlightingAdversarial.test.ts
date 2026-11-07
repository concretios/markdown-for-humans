/** @jest-environment jsdom */
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';
import {
  codeHighlightingKey,
  createCodeHighlightingPlugin,
} from '../../webview/highlighting/plugin';
import type { HighlightResult, HighlightService } from '../../webview/highlighting/types';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    blockquote: { group: 'block', content: 'block+', toDOM: () => ['blockquote', 0] },
    codeBlock: {
      group: 'block',
      content: 'text*',
      code: true,
      attrs: { language: { default: 'ts' } },
      toDOM: () => ['pre', ['code', 0]],
    },
  },
});
const code = (source: string) =>
  schema.nodes.codeBlock.create({ language: 'ts' }, schema.text(source));
const paragraph = (source: string) => schema.nodes.paragraph.create(null, schema.text(source));

class ControlledService implements HighlightService {
  requests: Array<{ source: string; resolve: (result: HighlightResult) => void }> = [];
  dispose = jest.fn();
  highlight = jest.fn(
    (_grammar: string, source: string): Promise<HighlightResult> =>
      new Promise(resolve => {
        this.requests.push({ source, resolve });
      })
  );
  complete(index: number): void {
    const request = this.requests[index];
    request.resolve({ spans: [{ from: 0, to: request.source.length, classes: 'hljs-string' }] });
  }
}

describe('code highlighting occurrence identity at structural boundaries', () => {
  let view: EditorView;
  let service: ControlledService;
  beforeEach(() => {
    jest.useFakeTimers();
    service = new ControlledService();
  });
  afterEach(() => {
    view?.destroy();
    jest.useRealTimers();
  });
  function open(content: ReturnType<typeof code>[]): void {
    view = new EditorView(document.createElement('div'), {
      state: EditorState.create({
        schema,
        doc: schema.nodes.doc.create(null, content),
        plugins: [createCodeHighlightingPlugin(() => service)],
      }),
    });
  }
  const tick = async () => {
    await jest.advanceTimersByTimeAsync(20);
  };
  const ranges = () =>
    codeHighlightingKey
      .getState(view.state)!
      .decorations.find()
      .map(item => [item.from, item.to]);

  it('rejects replacement results even when the replacement shares its immutable text fragment', async () => {
    const original = code('same text');
    open([original]);
    await tick();
    const replacement = original.copy(original.content);
    expect(replacement.content).toBe(original.content);
    view.dispatch(view.state.tr.replaceWith(0, original.nodeSize, replacement));
    service.complete(0);
    await tick();
    expect(ranges()).toEqual([]);
    expect(service.requests).toHaveLength(2);
    service.complete(1);
    await tick();
    expect(ranges()).toEqual([[1, 10]]);
  });

  it('removes surviving inline colors when a code block becomes prose', async () => {
    open([code('const text = "plain";')]);
    await tick();
    service.complete(0);
    await tick();
    expect(ranges()).toHaveLength(1);
    view.dispatch(view.state.tr.setNodeMarkup(0, schema.nodes.paragraph));
    await tick();
    expect(ranges()).toEqual([]);
    expect(view.dom.querySelector('.hljs-string')).toBeNull();
    expect(service.requests).toHaveLength(1);
  });

  it('drops in-flight nested occurrences when their containing block is removed', async () => {
    const nested = schema.nodes.blockquote.create(null, code('nested'));
    open([nested, paragraph('remaining')]);
    await tick();
    view.dispatch(view.state.tr.delete(0, nested.nodeSize));
    service.complete(0);
    await tick();
    expect(ranges()).toEqual([]);
    expect(service.requests).toHaveLength(1);
    expect(view.dom.textContent).toBe('remaining');
  });

  it('binds moved code to its new occurrence after a delete-and-insert transaction', async () => {
    const moving = code('moving');
    const prose = paragraph('prefix');
    open([moving, prose]);
    await tick();
    const transaction = view.state.tr.delete(0, moving.nodeSize);
    transaction.insert(transaction.doc.content.size, moving);
    view.dispatch(transaction);
    service.complete(0);
    await tick();
    expect(ranges()).toEqual([]);
    expect(service.requests).toHaveLength(2);
    service.complete(1);
    await tick();
    expect(ranges()).toEqual([[prose.nodeSize + 1, prose.nodeSize + 7]]);
  });

  it('rejects a completed nested result if an ancestor is replaced before publication', async () => {
    const nested = schema.nodes.blockquote.create(null, code('old'));
    open([nested]);
    await tick();
    service.complete(0);
    await Promise.resolve();
    await Promise.resolve();
    view.dispatch(
      view.state.tr.replaceWith(
        0,
        nested.nodeSize,
        schema.nodes.blockquote.create(null, code('new'))
      )
    );
    await tick();
    expect(ranges()).toEqual([]);
    service.complete(1);
    await tick();
    expect(view.dom.querySelector('.hljs-string')?.textContent).toBe('new');
    expect(ranges()).toEqual([[2, 5]]);
  });
});
