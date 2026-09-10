import { Schema } from '@tiptap/pm/model';
import { createFeedbackSectionIndex } from '../../webview/features/feedbackSectionIndex';

const schema = new Schema({
  nodes: {
    doc: { content: 'block*' },
    text: { group: 'inline' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 2 } } },
    blockquote: { group: 'block', content: 'block+' },
  },
});
const p = (text = '') => schema.node('paragraph', null, text ? schema.text(text) : undefined);
const h = (level: number, text = 'Title') => schema.node('heading', { level }, schema.text(text));
function index(nodes: ReturnType<typeof p>[], missing: number[] = []) {
  return createFeedbackSectionIndex(
    schema.node('doc', null, nodes),
    nodes.flatMap((_, ordinal) =>
      missing.includes(ordinal)
        ? []
        : [{ ordinal, startLine: ordinal * 2 + 1, endLine: ordinal * 2 + 1 }]
    )
  );
}

describe('Feedback section boundaries', () => {
  it('includes deeper headings and stops before the next peer', () => {
    const sections = index([
      p('intro'),
      h(2, 'Mocks'),
      p('body'),
      h(4, 'Details'),
      p('nested'),
      h(2, 'Delivery'),
      p('end'),
    ]);
    expect(sections.section(1)).toMatchObject({ startOrdinal: 1, endOrdinal: 4, label: 'Mocks' });
    expect(sections.section(3)).toMatchObject({ startOrdinal: 3, endOrdinal: 4 });
    expect(sections.section(5)).toMatchObject({ endOrdinal: 6 });
    expect(sections.ancestors(4).map(scope => scope.startOrdinal)).toEqual([3, 1]);
    expect(sections.ancestors(0)).toEqual([]);
  });
  it('does not let a nested quote heading terminate the outer section', () => {
    const sections = index([
      h(2),
      schema.node('blockquote', null, [h(1), p('quote')]),
      p('body'),
      h(1),
    ]);
    expect(sections.section(0)?.endOrdinal).toBe(2);
    expect(sections.section(1)).toBeNull();
  });
  it('handles empty sections, duplicate labels and higher-rank boundaries', () => {
    const sections = index([h(3), h(3), p('body'), h(1)]);
    expect(sections.section(0)?.endOrdinal).toBe(0);
    expect(sections.section(1)?.endOrdinal).toBe(2);
    expect(sections.section(3)?.endOrdinal).toBe(3);
  });
  it('skips unanchored empty paragraphs but rejects gaps containing content', () => {
    expect(index([h(2), p(), p('body'), p()], [1, 3]).section(0)?.endOrdinal).toBe(2);
    expect(index([h(2), p('unmapped'), p('body')], [1]).section(0)).toBeNull();
  });
  it('does not rewalk the document when resolving scopes', () => {
    const doc = schema.node('doc', null, [h(2), p('body'), h(3), p('more')]);
    const forEach = jest.spyOn(doc, 'forEach');
    const sections = createFeedbackSectionIndex(
      doc,
      [0, 1, 2, 3].map(ordinal => ({ ordinal, startLine: ordinal + 1, endLine: ordinal + 1 }))
    );
    const calls = forEach.mock.calls.length;
    for (let i = 0; i < 100; i++) {
      sections.section(0);
      sections.ancestors(3);
    }
    expect(forEach).toHaveBeenCalledTimes(calls);
  });
});
