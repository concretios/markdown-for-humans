/** @jest-environment jsdom */

import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';
import { history, undo, redo } from '@tiptap/pm/history';
import {
  codeHighlightingKey,
  createCodeHighlightingPlugin,
} from '../../webview/highlighting/plugin';
import {
  explainHighlightFailure,
  type HighlightResult,
  type HighlightService,
} from '../../webview/highlighting/types';
import * as projection from '../../webview/highlighting/projection';

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
const code = (text: string, language = 'ts') =>
  schema.nodes.codeBlock.create({ language }, text ? schema.text(text) : undefined);
const prose = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));

class ControlledService implements HighlightService {
  requests: Array<{
    language: string;
    source: string;
    resolve: (result: HighlightResult) => void;
  }> = [];
  dispose = jest.fn();
  highlight = jest.fn(
    (language: string, source: string): Promise<HighlightResult> =>
      new Promise(resolve => {
        this.requests.push({ language, source, resolve });
      })
  );
  complete(index: number, result?: HighlightResult) {
    const request = this.requests[index];
    request.resolve(
      result ?? {
        spans: request.source
          ? [{ from: 0, to: request.source.length, classes: 'hljs-keyword' }]
          : [],
      }
    );
  }
}

describe('incremental background code highlighting', () => {
  let view: EditorView;
  let service: ControlledService;
  let documentUpdates: number;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new ControlledService();
    documentUpdates = 0;
  });
  afterEach(() => {
    view?.destroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function open(content = [code('const first = 1;'), prose('hello'), code('const second = 2;')]) {
    view = new EditorView(document.createElement('div'), {
      state: EditorState.create({
        schema,
        doc: schema.nodes.doc.create(null, content),
        plugins: [history(), createCodeHighlightingPlugin(() => service)],
      }),
      dispatchTransaction: tr => {
        if (tr.docChanged) documentUpdates++;
        view.updateState(view.state.apply(tr));
      },
    });
  }
  async function tick() {
    await jest.advanceTimersByTimeAsync(20);
  }
  async function settle() {
    let finished = 0;
    for (let turns = 0; turns < 3000; turns++) {
      await tick();
      if (finished === service.requests.length) break;
      service.complete(finished++);
    }
    await tick();
  }
  const decorations = () => codeHighlightingKey.getState(view.state)!.decorations.find();

  it('does no lexical work while applying a typing transaction and publishes without a document edit', async () => {
    open([code('const value = 1;')]);
    expect(service.highlight).not.toHaveBeenCalled();
    await tick();
    expect(service.highlight).toHaveBeenCalledTimes(1);
    service.complete(0);
    await tick();
    expect(decorations()).toHaveLength(1);
    expect(documentUpdates).toBe(0);
    expect(undo(view.state, view.dispatch)).toBe(false);
  });

  it('maps unaffected decorations and only schedules the changed block', async () => {
    open();
    await settle();
    const calls = service.highlight.mock.calls.length;
    view.dispatch(view.state.tr.insertText('X', 2));
    expect(service.highlight).toHaveBeenCalledTimes(calls);
    await tick();
    expect(service.highlight).toHaveBeenCalledTimes(calls + 1);
    expect(service.requests[calls].source).toBe('cXonst first = 1;');
    expect(decorations()).toHaveLength(1);
    service.complete(calls);
    await tick();
    expect(decorations()).toHaveLength(2);
  });

  it('does not tokenize prose, selection or unrelated metadata and does not enumerate the document', async () => {
    open();
    await settle();
    const calls = service.highlight.mock.calls.length;
    const scan = jest.spyOn(view.state.doc, 'descendants');
    const paragraphStart = view.state.doc.firstChild!.nodeSize;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, paragraphStart + 1))
    );
    view.dispatch(view.state.tr.insertText('!', paragraphStart + 2));
    view.dispatch(view.state.tr.setMeta('unrelated', true));
    await tick();
    expect(service.highlight).toHaveBeenCalledTimes(calls);
    expect(scan).not.toHaveBeenCalled();
  });

  it('handles an empty-map language AttrStep, metadata-only suffix edit and plain text', async () => {
    open([code('const x = 1;', 'ts title="old"')]);
    await settle();
    view.dispatch(view.state.tr.setNodeAttribute(0, 'language', 'typescript title="new"'));
    await tick();
    expect(service.highlight).toHaveBeenCalledTimes(1);
    view.dispatch(view.state.tr.setNodeAttribute(0, 'language', 'sql title="new"'));
    await tick();
    expect(service.requests[1].language).toBe('sql');
    service.complete(1);
    await tick();
    view.dispatch(view.state.tr.setNodeAttribute(0, 'language', 'unknown-language'));
    await tick();
    expect(decorations()).toHaveLength(0);
    expect(service.highlight).toHaveBeenCalledTimes(2);
  });

  it('rejects results for earlier revisions, including A to B to A', async () => {
    open([code('A')]);
    await tick();
    view.dispatch(view.state.tr.insertText('B', 1, 2));
    view.dispatch(view.state.tr.insertText('A', 1, 2));
    service.complete(0);
    await tick();
    expect(decorations()).toHaveLength(0);
    expect(service.highlight).toHaveBeenCalledTimes(2);
    service.complete(1);
    await tick();
    expect(decorations()).toHaveLength(1);
  });

  it('accepts an in-flight result after unrelated prose moves its block', async () => {
    open([prose('hello'), code('const value = 1;')]);
    await tick();
    view.dispatch(view.state.tr.insertText('!!!', 2));
    service.complete(0);
    await tick();
    expect(decorations()[0].from).toBe(view.state.doc.firstChild!.nodeSize + 1);
    expect(service.highlight).toHaveBeenCalledTimes(1);
  });

  it('drops deleted occurrences even when an identical replacement takes their position', async () => {
    open([code('A')]);
    await tick();
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, code('A')));
    service.complete(0);
    await tick();
    expect(decorations()).toHaveLength(0);
    expect(service.highlight).toHaveBeenCalledTimes(2);
    service.complete(1);
    await tick();
    expect(decorations()).toHaveLength(1);
  });

  it('coalesces multiple steps in one block and respects history', async () => {
    open([code('abc')]);
    await settle();
    view.dispatch(view.state.tr.insertText('1', 1).insertText('2', 2));
    await tick();
    expect(service.highlight).toHaveBeenCalledTimes(2);
    service.complete(1);
    await tick();
    expect(undo(view.state, view.dispatch)).toBe(true);
    await tick();
    service.complete(2);
    await tick();
    expect(view.state.doc.textContent).toBe('abc');
    expect(redo(view.state, view.dispatch)).toBe(true);
    await tick();
    service.complete(3);
    await tick();
    expect(view.state.doc.textContent).toBe('12abc');
  });

  it('keeps source editable and exposes a local explanation when highlighting is unavailable', async () => {
    open([code('const a = 1;')]);
    await tick();
    service.complete(0, { spans: [], reason: 'source-limit' });
    await tick();
    expect(view.dom.textContent).toContain('const a = 1;');
    expect(
      view.dom.querySelector('[data-highlight-status]')?.getAttribute('data-highlight-status')
    ).toBe(explainHighlightFailure('source-limit'));
    expect(documentUpdates).toBe(0);
  });

  it('cancels queued work and ignores results after view disposal', async () => {
    open();
    await tick();
    view.destroy();
    service.complete(0);
    await tick();
    expect(service.dispose).toHaveBeenCalledTimes(1);
    expect(service.highlight).toHaveBeenCalledTimes(1);
  });

  it('revalidates after receipt when an edit precedes the publication frame', async () => {
    open([code('old')]);
    await tick();
    service.complete(0);
    await Promise.resolve();
    await Promise.resolve();
    view.dispatch(view.state.tr.insertText('new', 1, 4));
    await tick();
    expect(decorations()).toHaveLength(0);
    service.complete(1);
    await tick();
    expect(view.dom.querySelector('.hljs-keyword')?.textContent).toBe('new');
  });

  it('handles splits, joins and a full host replacement without misplaced colors', async () => {
    open([code('abcdef')]);
    await settle();
    view.dispatch(view.state.tr.split(4));
    await tick();
    service.complete(1);
    await tick();
    service.complete(2);
    await tick();
    expect(decorations().map(item => [item.from, item.to])).toEqual([
      [1, 4],
      [6, 9],
    ]);
    view.dispatch(view.state.tr.join(5));
    await tick();
    service.complete(3);
    await tick();
    expect(decorations().map(item => [item.from, item.to])).toEqual([[1, 7]]);
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, [
        prose('prefix'),
        code('replacement', 'sql'),
      ])
    );
    await tick();
    service.complete(4);
    await tick();
    const pos = view.state.doc.firstChild!.nodeSize;
    expect(decorations().map(item => [item.from, item.to])).toEqual([[pos + 1, pos + 12]]);
  });

  it('retains neighboring fallback explanations when one block changes', async () => {
    open([code('a'), code('b')]);
    await tick();
    service.complete(0, { spans: [], reason: 'worker-error' });
    await tick();
    service.complete(1, { spans: [], reason: 'source-limit' });
    await tick();
    view.dispatch(view.state.tr.insertText('x', 2));
    expect(view.dom.querySelectorAll('[data-highlight-status]')).toHaveLength(1);
    expect(
      view.dom.querySelector('[data-highlight-status]')?.getAttribute('data-highlight-status')
    ).toBe(explainHighlightFailure('source-limit'));
  });

  it('bounds the typing path to changed ranges in a 1,000-block document', () => {
    let state = EditorState.create({
      schema,
      doc: schema.nodes.doc.create(
        null,
        Array.from({ length: 1000 }, (_, index) => code(`const n${index} = 1;`))
      ),
      plugins: [createCodeHighlightingPlugin(() => service)],
    });
    for (let index = 0; index < 100; index++) {
      const scan = jest.spyOn(state.doc, 'descendants');
      state = state.apply(state.tr.insertText('x', 2));
      expect(scan).not.toHaveBeenCalled();
    }
    expect(codeHighlightingKey.getState(state)?.blocks.find().length).toBe(1000);
    expect(service.highlight).not.toHaveBeenCalled();
  });

  it('does no highlighting work during 10,000 unrelated metadata transactions', () => {
    let state = EditorState.create({
      schema,
      doc: schema.nodes.doc.create(null, [code('const x = 1;')]),
      plugins: [createCodeHighlightingPlugin(() => service)],
    });
    const initial = codeHighlightingKey.getState(state);
    for (let index = 0; index < 10000; index++)
      state = state.apply(state.tr.setMeta('unrelated', index));
    expect(codeHighlightingKey.getState(state)).toBe(initial);
    expect(service.highlight).not.toHaveBeenCalled();
  });

  it('projects a large canonical result around the viewport and reuses it on scroll', async () => {
    const viewport = jest
      .spyOn(projection, 'readViewportRange')
      .mockReturnValue({ from: 1, to: 101 });
    const text = 'x '.repeat(5000);
    open([code(text)]);
    await tick();
    service.complete(0, {
      spans: Array.from({ length: 5000 }, (_, index) => ({
        from: index * 2,
        to: index * 2 + 1,
        classes: 'hljs-keyword',
      })),
    });
    await tick();
    expect(decorations()).toHaveLength(50);
    expect(view.dom.textContent).toBe(text);
    viewport.mockReturnValue({ from: 2001, to: 2101 });
    window.dispatchEvent(new Event('scroll'));
    await tick();
    expect(decorations()).toHaveLength(50);
    expect(decorations()[0].from).toBe(2001);
    expect(service.highlight).toHaveBeenCalledTimes(1);
    expect(documentUpdates).toBe(0);
  });
});
