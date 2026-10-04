/**
 * Regression budget for foreground plugin work in one very large highlighted block.
 * ProseMirror removes inline decorations from one textblock with a linear scan per
 * removed decoration, so clearing tens of thousands of them must not use remove().
 */
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import {
  codeHighlightingKey,
  createCodeHighlightingPlugin,
} from '../../webview/highlighting/plugin';
import type {
  HighlightResult,
  HighlightService,
  TokenSpan,
} from '../../webview/highlighting/types';

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

const LINES = 10_000;
const line = 'const value: string = "hello";\n';
const source = line.repeat(LINES);
// Four tokens per line gives the native 10,000-line fixture's 40,000 spans.
const spans: TokenSpan[] = [];
for (let index = 0; index < LINES; index++) {
  const start = index * line.length;
  spans.push(
    { from: start, to: start + 5, classes: 'hljs-keyword' },
    { from: start + 6, to: start + 11, classes: 'hljs-variable' },
    { from: start + 13, to: start + 19, classes: 'hljs-built_in' },
    { from: start + 22, to: start + 29, classes: 'hljs-string' }
  );
}
const service: HighlightService = {
  highlight: () => new Promise<HighlightResult>(() => undefined),
  dispose: () => undefined,
};

function highlightedState(): EditorState {
  const state = EditorState.create({
    schema,
    doc: schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, schema.text('Before')),
      schema.nodes.codeBlock.create({ language: 'ts' }, schema.text(source)),
      schema.nodes.codeBlock.create({ language: 'ts' }, schema.text('let other = 1;')),
    ]),
    plugins: [createCodeHighlightingPlugin(() => service)],
  });
  return publishAll(state);
}

function publishAll(state: EditorState): EditorState {
  const plugin = codeHighlightingKey.getState(state)!;
  const publications = plugin.blocks.find().map(item => {
    const record = item.spec.record;
    return {
      id: record.id,
      revision: record.revision,
      node: record.node,
      grammar: record.grammar,
      result: {
        spans:
          record.node.textContent === source
            ? spans
            : [{ from: 0, to: 3, classes: 'hljs-keyword' }],
      },
    };
  });
  return state.apply(state.tr.setMeta(codeHighlightingKey, { publications }));
}

const decorations = (state: EditorState) => codeHighlightingKey.getState(state)!.decorations.find();
const largeBlockStart = (state: EditorState) => state.doc.child(0).nodeSize + 1;

describe('large code block foreground cost', () => {
  it('applies a keystroke deep inside a 40,000-token block within the typing budget', () => {
    const state = highlightedState();
    expect(decorations(state)).toHaveLength(spans.length + 1);
    const at = largeBlockStart(state) + Math.floor(source.length * 0.75);

    const started = performance.now();
    const next = state.apply(state.tr.insertText('x', at));
    const elapsed = performance.now() - started;

    // Before the fix this took ~21 s in Node. The generous ceiling absorbs CI noise.
    expect(elapsed).toBeLessThan(250);
    // The unrelated small block keeps its color while the edited block is pending.
    const otherStart = next.doc.child(0).nodeSize + next.doc.child(1).nodeSize + 1;
    expect(decorations(next).some(item => item.from === otherStart)).toBe(true);
  });

  it('replaces a published 40,000-token result within the interaction budget', () => {
    const state = highlightedState();
    const started = performance.now();
    const next = publishAll(state);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(250);
    expect(decorations(next)).toHaveLength(spans.length + 1);
  });
});
