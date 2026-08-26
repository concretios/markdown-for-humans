/** @jest-environment jsdom */

import { FEEDBACK_SNAPSHOT_PROTOCOL_VERSION } from '../../shared/feedbackSnapshotProtocol';
import { handleFeedbackSnapshotMessage } from '../../webview/features/feedbackSnapshotClient';

function createHarness() {
  const postMessage = jest.fn();
  const serialize = jest.fn(() => '# Local source\n');
  const applyAuthoritativeContent = jest.fn(() => true);
  const enumerateCanonicalBlocks = jest.fn(() => [
    { ordinal: 0, kind: 'heading', markdown: '# Current source', contentSize: 14 },
  ]);
  return {
    postMessage,
    serialize,
    applyAuthoritativeContent,
    enumerateCanonicalBlocks,
    options: {
      viewGeneration: 'view-generation-1',
      getLocalRevision: () => 8,
      isDirty: () => true,
      serialize,
      applyAuthoritativeContent,
      enumerateCanonicalBlocks,
      postMessage,
    },
  };
}

const identity = {
  protocolVersion: FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
  requestId: 'snapshot-request-1',
  operationId: 'snapshot-operation-1',
  documentVersion: 7,
};

describe('feedback snapshot renderer client', () => {
  it('reports the current renderer text and dirty state during inspection', () => {
    const harness = createHarness();

    expect(
      handleFeedbackSnapshotMessage(
        { type: 'feedback.snapshot.inspect', ...identity },
        harness.options
      )
    ).toBe('handled');

    expect(harness.serialize).toHaveBeenCalledTimes(1);
    expect(harness.postMessage).toHaveBeenCalledWith({
      type: 'feedback.snapshot.report',
      ...identity,
      stage: 'inspect',
      viewGeneration: 'view-generation-1',
      localRevision: 8,
      dirty: true,
      content: '# Local source\n',
    });
  });

  it('reports sent but unacknowledged document edits as dirty during inspection', () => {
    const harness = createHarness();
    const unacknowledgedEditIds = new Set(['view-generation-1:8:1']);
    harness.options.isDirty = () => unacknowledgedEditIds.size > 0;

    handleFeedbackSnapshotMessage(
      { type: 'feedback.snapshot.inspect', ...identity },
      harness.options
    );

    expect(harness.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'inspect', dirty: true })
    );
  });

  it('applies authoritative content before enumerating owner descriptors', () => {
    const harness = createHarness();
    harness.serialize.mockReturnValue('# Current source\n');
    const request = {
      type: 'feedback.snapshot.apply',
      ...identity,
      content: '# Current source\n',
      descriptorRevision: 3,
      includeCanonicalBlocks: true,
    };

    expect(handleFeedbackSnapshotMessage(request, harness.options)).toBe('handled');

    expect(harness.applyAuthoritativeContent).toHaveBeenCalledWith('# Current source\n', 7);
    expect(harness.serialize).toHaveBeenCalledTimes(1);
    expect(harness.enumerateCanonicalBlocks).toHaveBeenCalledTimes(1);
    expect(harness.applyAuthoritativeContent.mock.invocationCallOrder[0]).toBeLessThan(
      harness.serialize.mock.invocationCallOrder[0]
    );
    expect(harness.serialize.mock.invocationCallOrder[0]).toBeLessThan(
      harness.enumerateCanonicalBlocks.mock.invocationCallOrder[0]
    );
    expect(harness.postMessage).toHaveBeenCalledWith({
      type: 'feedback.snapshot.report',
      ...identity,
      stage: 'applied',
      viewGeneration: 'view-generation-1',
      localRevision: 8,
      dirty: false,
      content: '# Current source\n',
      canonicalDescriptorRevision: 3,
      blocks: [{ ordinal: 0, kind: 'heading', markdown: '# Current source', contentSize: 14 }],
    });
  });

  it('does not enumerate canonical blocks for an applied peer split', () => {
    const harness = createHarness();
    harness.serialize.mockReturnValue('# Current source\n');

    handleFeedbackSnapshotMessage(
      {
        type: 'feedback.snapshot.apply',
        ...identity,
        content: '# Current source\n',
        descriptorRevision: 3,
        includeCanonicalBlocks: false,
      },
      harness.options
    );

    expect(harness.enumerateCanonicalBlocks).not.toHaveBeenCalled();
    expect(harness.serialize).toHaveBeenCalledTimes(1);
    expect(harness.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '# Current source\n' })
    );
  });

  it('withholds the applied report when authoritative content is rejected', () => {
    const harness = createHarness();
    harness.applyAuthoritativeContent.mockReturnValue(false);

    expect(
      handleFeedbackSnapshotMessage(
        {
          type: 'feedback.snapshot.apply',
          ...identity,
          content: '# Current source\n',
          descriptorRevision: 3,
          includeCanonicalBlocks: true,
        },
        harness.options
      )
    ).toBe('rejected');
    expect(harness.enumerateCanonicalBlocks).not.toHaveBeenCalled();
    expect(harness.postMessage).not.toHaveBeenCalled();
  });

  it('rejects malformed snapshot messages and ignores unrelated traffic', () => {
    const harness = createHarness();

    expect(
      handleFeedbackSnapshotMessage(
        { type: 'feedback.snapshot.inspect', ...identity, extra: true },
        harness.options
      )
    ).toBe('rejected');
    expect(handleFeedbackSnapshotMessage({ type: 'update' }, harness.options)).toBe('ignored');
    expect(harness.postMessage).not.toHaveBeenCalled();
  });
});
