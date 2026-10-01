import { Schema, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { liftTarget, Step, StepResult } from '@tiptap/pm/transform';
import {
  codeHighlightingKey,
  createCodeHighlightingPlugin,
} from '../../webview/highlighting/plugin';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { group: 'block', content: 'text*' },
    blockquote: { group: 'block', content: 'block+' },
    codeBlock: {
      group: 'block',
      content: 'text*',
      code: true,
      attrs: { language: { default: 'ts' } },
    },
  },
});
const code = (text: string) => schema.nodes.codeBlock.create(null, schema.text(text));

/** A custom step can replace a node's type while preserving every position. */
class UnknownConversionStep extends Step {
  apply(doc: ProseMirrorNode): StepResult {
    const paragraph = schema.nodes.paragraph.create(null, doc.firstChild!.content);
    return StepResult.ok(doc.copy(doc.content.replaceChild(0, paragraph)));
  }
  invert(): Step {
    return this;
  }
  map(): Step {
    return this;
  }
  toJSON(): object {
    return { stepType: 'unknownConversion' };
  }
}

interface Occurrence {
  id: number;
  revision: number;
  node: ProseMirrorNode;
  grammar: string;
}

function open(): EditorState {
  return EditorState.create({
    schema,
    doc: schema.nodes.doc.create(null, [code('first'), code('second'), code('last')]),
    plugins: [createCodeHighlightingPlugin(() => ({ highlight: jest.fn(), dispose: jest.fn() }))],
  });
}

function publication(state: EditorState) {
  return codeHighlightingKey
    .getState(state)!
    .blocks.find()
    .map(item => {
      const record = item.spec.record as Occurrence;
      return {
        ...record,
        result: { spans: [{ from: 0, to: record.node.content.size, classes: 'hljs-keyword' }] },
      };
    });
}

function colors(state: EditorState): Array<[number, number]> {
  return codeHighlightingKey
    .getState(state)!
    .decorations.find()
    .map(item => [item.from, item.to] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

function index(state: EditorState): Array<{ pos: number; id: number }> {
  return codeHighlightingKey
    .getState(state)!
    .blocks.find()
    .map(item => ({ pos: item.from, id: (item.spec.record as Occurrence).id }))
    .sort((a, b) => a.pos - b.pos);
}

function expectCompleteIndex(state: EditorState): void {
  const expected: number[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') {
      expected.push(pos);
      return false;
    }
    return true;
  });
  expect(index(state).map(item => item.pos)).toEqual(expected);
}

function wrapFirstTwo(state: EditorState): EditorState {
  const end = state.doc.child(0).nodeSize + state.doc.child(1).nodeSize;
  const range = state.doc.resolve(0).blockRange(state.doc.resolve(end));
  if (!range) throw new Error('Expected two-block range');
  return state.apply(state.tr.wrap(range, [{ type: schema.nodes.blockquote }]));
}

describe('highlight occurrence index across structural gaps', () => {
  it('retains every wrapped occurrence and its colors, including interior blocks', () => {
    let state = open();
    const ids = index(state).map(item => item.id);
    state = state.apply(
      state.tr.setMeta(codeHighlightingKey, { publications: publication(state) })
    );
    const before = colors(state);

    state = wrapFirstTwo(state);

    expectCompleteIndex(state);
    expect(index(state).map(item => item.id)).toEqual(ids);
    expect(colors(state)).toEqual(
      before.map(([from, to], i) => [from + (i < 2 ? 1 : 2), to + (i < 2 ? 1 : 2)])
    );
  });

  it('removes colors when a previously wrapped code block becomes prose', () => {
    let state = open();
    state = state.apply(
      state.tr.setMeta(codeHighlightingKey, { publications: publication(state) })
    );
    state = wrapFirstTwo(state);
    const converted = 1 + state.doc.firstChild!.firstChild!.nodeSize;

    state = state.apply(state.tr.setNodeMarkup(converted, schema.nodes.paragraph));

    expectCompleteIndex(state);
    expect(colors(state)).toEqual([
      [2, 7],
      [18, 22],
    ]);
  });

  it('keeps in-flight occurrence identities valid when wrapping and lifting a group', () => {
    let state = open();
    const pending = publication(state);
    state = wrapFirstTwo(state);
    const range = state.doc
      .resolve(1)
      .blockRange(state.doc.resolve(state.doc.firstChild!.nodeSize - 1));
    if (!range) throw new Error('Expected wrapped range');
    const target = liftTarget(range);
    if (target === null) throw new Error('Expected lift target');
    state = state.apply(state.tr.lift(range, target));

    state = state.apply(state.tr.setMeta(codeHighlightingKey, { publications: pending }));

    expectCompleteIndex(state);
    expect(colors(state)).toEqual([
      [1, 6],
      [8, 14],
      [16, 20],
    ]);
  });

  it('rejects an in-flight result after wrapped code becomes prose', () => {
    let state = open();
    const pending = publication(state);
    state = wrapFirstTwo(state);
    state = state.apply(state.tr.setNodeMarkup(1, schema.nodes.paragraph));

    state = state.apply(state.tr.setMeta(codeHighlightingKey, { publications: pending }));

    expectCompleteIndex(state);
    expect(colors(state)).toEqual([
      [9, 15],
      [18, 22],
    ]);
  });

  it('clears untrusted mapped colors before rebuilding for an unknown empty-map step', () => {
    let state = open();
    const pending = publication(state);
    state = state.apply(state.tr.setMeta(codeHighlightingKey, { publications: pending }));

    state = state.apply(state.tr.step(new UnknownConversionStep()));
    state = state.apply(state.tr.setMeta(codeHighlightingKey, { publications: pending }));

    expectCompleteIndex(state);
    expect(colors(state)).toEqual([]);
    state = state.apply(
      state.tr.setMeta(codeHighlightingKey, { publications: publication(state) })
    );
    expect(colors(state)).toEqual([
      [8, 14],
      [16, 20],
    ]);
  });
});
