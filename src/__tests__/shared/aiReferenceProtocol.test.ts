/** @jest-environment node */

import { aiReferenceNodeKind, parseAiReferenceRequest } from '../../shared/aiReferenceProtocol';

const validPoint = {
  ordinal: 2,
  steps: [{ kind: 'row', index: 1, count: 3 }],
  line: { index: 0, count: 1 },
};

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'copyReferenceForAi',
    selection: { start: validPoint, end: validPoint },
    blocks: [{ ordinal: 2, kind: 'table', markdown: '| a |\n| - |', contentSize: 12 }],
    ...overrides,
  };
}

describe('parseAiReferenceRequest', () => {
  it('accepts a well-formed request and an empty document', () => {
    expect(parseAiReferenceRequest(request())).toEqual(request());

    const emptyPoint = { ordinal: 0, steps: [] };
    expect(
      parseAiReferenceRequest(
        request({ blocks: [], selection: { start: emptyPoint, end: emptyPoint } })
      )
    ).toEqual(request({ blocks: [], selection: { start: emptyPoint, end: emptyPoint } }));
  });

  it.each([
    ['a missing selection', request({ selection: undefined })],
    ['a missing end point', request({ selection: { start: validPoint } })],
    [
      'a negative ordinal',
      request({ selection: { start: { ...validPoint, ordinal: -1 }, end: validPoint } }),
    ],
    [
      'an unknown step kind',
      request({
        selection: {
          start: { ...validPoint, steps: [{ kind: 'section', index: 0, count: 1 }] },
          end: validPoint,
        },
      }),
    ],
    [
      'a step index outside its count',
      request({
        selection: {
          start: { ...validPoint, steps: [{ kind: 'row', index: 3, count: 3 }] },
          end: validPoint,
        },
      }),
    ],
    [
      'a line index outside its count',
      request({
        selection: { start: { ...validPoint, line: { index: 1, count: 1 } }, end: validPoint },
      }),
    ],
    ['blocks that are not canonical descriptors', request({ blocks: [{ ordinal: 0 }] })],
    ['blocks that are not an array', request({ blocks: 'none' })],
    ['another message type', request({ type: 'copyAsMarkdown' })],
  ])('rejects %s', (_name, value) => {
    expect(parseAiReferenceRequest(value)).toBeNull();
  });
});

describe('aiReferenceNodeKind', () => {
  it('names the editor nodes the host can follow into the source', () => {
    expect(aiReferenceNodeKind('paragraph')).toBe('paragraph');
    expect(aiReferenceNodeKind('heading')).toBe('heading');
    expect(aiReferenceNodeKind('bulletList')).toBe('list');
    expect(aiReferenceNodeKind('orderedList')).toBe('list');
    expect(aiReferenceNodeKind('taskList')).toBe('list');
    expect(aiReferenceNodeKind('listItem')).toBe('item');
    expect(aiReferenceNodeKind('taskItem')).toBe('item');
    expect(aiReferenceNodeKind('blockquote')).toBe('blockquote');
    expect(aiReferenceNodeKind('githubAlert')).toBe('alert');
    expect(aiReferenceNodeKind('codeBlock')).toBe('code');
    expect(aiReferenceNodeKind('table')).toBe('table');
    expect(aiReferenceNodeKind('tableRow')).toBe('row');
    expect(aiReferenceNodeKind('tableCell')).toBe('other');
    expect(aiReferenceNodeKind('mermaid')).toBe('other');
  });
});
