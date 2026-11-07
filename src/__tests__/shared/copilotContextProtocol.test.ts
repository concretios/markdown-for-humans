/** @jest-environment node */

import {
  parseCopilotChatAvailability,
  parseCopilotContextRequest,
} from '../../shared/copilotContextProtocol';

const validPoint = {
  ordinal: 1,
  steps: [{ kind: 'item', index: 0, count: 2 }],
  line: { index: 1, count: 2 },
};

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'addToCopilot',
    selection: { start: validPoint, end: validPoint },
    blocks: [
      { ordinal: 0, kind: 'heading', markdown: '# Title', contentSize: 7 },
      { ordinal: 1, kind: 'list', markdown: '- one\n- two', contentSize: 10 },
    ],
    ...overrides,
  };
}

describe('parseCopilotContextRequest', () => {
  it('accepts a well-formed request and an empty document', () => {
    expect(parseCopilotContextRequest(request())).toEqual(request());

    const emptyPoint = { ordinal: 0, steps: [] };
    expect(
      parseCopilotContextRequest(
        request({ blocks: [], selection: { start: emptyPoint, end: emptyPoint } })
      )
    ).toEqual(request({ blocks: [], selection: { start: emptyPoint, end: emptyPoint } }));
  });

  it('keeps distinct selections distinct so each press stays its own context', () => {
    const first = parseCopilotContextRequest(request());
    const secondPoint = { ordinal: 0, steps: [] };
    const second = parseCopilotContextRequest(
      request({ selection: { start: secondPoint, end: secondPoint } })
    );

    expect(first?.selection.start).toEqual(validPoint);
    expect(second?.selection.start).toEqual(secondPoint);
    expect(first?.selection).not.toEqual(second?.selection);
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
          start: { ...validPoint, steps: [{ kind: 'cell', index: 0, count: 1 }] },
          end: validPoint,
        },
      }),
    ],
    [
      'a step index outside its count',
      request({
        selection: {
          start: { ...validPoint, steps: [{ kind: 'item', index: 2, count: 2 }] },
          end: validPoint,
        },
      }),
    ],
    [
      'a line index outside its count',
      request({
        selection: { start: { ...validPoint, line: { index: 2, count: 2 } }, end: validPoint },
      }),
    ],
    ['blocks that are not canonical descriptors', request({ blocks: [{ ordinal: 0 }] })],
    ['blocks that are not an array', request({ blocks: 'none' })],
    ['another message type', request({ type: 'copyReferenceForAi' })],
  ])('rejects %s', (_name, value) => {
    expect(parseCopilotContextRequest(value)).toBeNull();
  });
});

describe('parseCopilotChatAvailability', () => {
  it('accepts both availability answers', () => {
    expect(
      parseCopilotChatAvailability({ type: 'copilotChatAvailability', available: true })
    ).toEqual({ type: 'copilotChatAvailability', available: true });
    expect(
      parseCopilotChatAvailability({ type: 'copilotChatAvailability', available: false })
    ).toEqual({ type: 'copilotChatAvailability', available: false });
  });

  it.each([
    ['another message type', { type: 'addToCopilot.result', available: true }],
    ['a missing flag', { type: 'copilotChatAvailability' }],
    ['a non-boolean flag', { type: 'copilotChatAvailability', available: 'yes' }],
    ['a non-object', 'copilotChatAvailability'],
  ])('rejects %s', (_name, value) => {
    expect(parseCopilotChatAvailability(value)).toBeNull();
  });
});
