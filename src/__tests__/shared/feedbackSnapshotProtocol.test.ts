import {
  FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
  parseFeedbackSnapshotHostMessage,
  parseFeedbackSnapshotReport,
} from '../../shared/feedbackSnapshotProtocol';

const identity = {
  protocolVersion: FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
  requestId: 'snapshot-request-1',
  operationId: 'snapshot-operation-1',
  documentVersion: 7,
};

describe('feedback snapshot protocol', () => {
  it('accepts one strict split-inspection request', () => {
    expect(
      parseFeedbackSnapshotHostMessage({
        type: 'feedback.snapshot.inspect',
        ...identity,
      })
    ).toEqual({ type: 'feedback.snapshot.inspect', ...identity });
  });

  it('accepts an authoritative apply request with an explicit descriptor owner', () => {
    const message = {
      type: 'feedback.snapshot.apply',
      ...identity,
      content: '# Current source\n',
      descriptorRevision: 3,
      includeCanonicalBlocks: true,
    };

    expect(parseFeedbackSnapshotHostMessage(message)).toEqual(message);
  });

  it.each([
    { label: 'extra key', patch: { unexpected: true } },
    { label: 'old protocol', patch: { protocolVersion: 0 } },
    { label: 'empty request ID', patch: { requestId: '' } },
    { label: 'negative document version', patch: { documentVersion: -1 } },
  ])('rejects an inspect request with $label', ({ patch }) => {
    expect(
      parseFeedbackSnapshotHostMessage({
        type: 'feedback.snapshot.inspect',
        ...identity,
        ...patch,
      })
    ).toBeNull();
  });

  it('rejects oversized authoritative content before it reaches the editor', () => {
    expect(
      parseFeedbackSnapshotHostMessage({
        type: 'feedback.snapshot.apply',
        ...identity,
        content: 'x'.repeat(64 * 1024 * 1024 + 1),
        descriptorRevision: 1,
        includeCanonicalBlocks: false,
      })
    ).toBeNull();
  });

  it('accepts a strict inspection report containing the renderer-local source', () => {
    const message = {
      type: 'feedback.snapshot.report',
      ...identity,
      stage: 'inspect',
      viewGeneration: 'view-generation-1',
      localRevision: 11,
      dirty: true,
      content: '# Local source\n',
    };

    expect(parseFeedbackSnapshotReport(message)).toEqual(message);
  });

  it('accepts an applied owner report with canonical descriptors', () => {
    const message = {
      type: 'feedback.snapshot.report',
      ...identity,
      stage: 'applied',
      viewGeneration: 'view-generation-1',
      localRevision: 12,
      dirty: false,
      content: '# Current source\n',
      canonicalDescriptorRevision: 3,
      blocks: [{ ordinal: 0, kind: 'heading', markdown: '# Current source', contentSize: 14 }],
    };

    expect(parseFeedbackSnapshotReport(message)).toEqual(message);
  });

  it('accepts a bounded table fingerprint but preserves legacy fingerprint-free tables', () => {
    const report = {
      type: 'feedback.snapshot.report',
      ...identity,
      stage: 'applied',
      viewGeneration: 'view-generation-table',
      localRevision: 13,
      dirty: false,
      content: '| A |\n| - |\n| B |\n',
      canonicalDescriptorRevision: 4,
      blocks: [
        {
          ordinal: 0,
          kind: 'table',
          markdown: '| A |\n| - |\n| B |',
          contentSize: 12,
          tableFingerprint: 'md4h-table/v1:0123456789abcdef',
        },
      ],
    };

    expect(parseFeedbackSnapshotReport(report)).toEqual(report);
    expect(
      parseFeedbackSnapshotReport({
        ...report,
        blocks: [{ ordinal: 0, kind: 'table', markdown: '| A |', contentSize: 3 }],
      })
    ).not.toBeNull();
    expect(
      parseFeedbackSnapshotReport({
        ...report,
        blocks: [{ ...report.blocks[0], kind: 'paragraph' }],
      })
    ).toBeNull();
    expect(
      parseFeedbackSnapshotReport({
        ...report,
        blocks: [{ ...report.blocks[0], tableFingerprint: 'md4h-table/v1:bad' }],
      })
    ).toBeNull();
  });

  it('accepts an applied peer report without paying the descriptor cost', () => {
    const message = {
      type: 'feedback.snapshot.report',
      ...identity,
      stage: 'applied',
      viewGeneration: 'view-generation-2',
      localRevision: 4,
      dirty: false,
      content: '# Current source\n',
      canonicalDescriptorRevision: 3,
    };

    expect(parseFeedbackSnapshotReport(message)).toEqual(message);
  });

  it.each([
    {
      label: 'dirty applied report',
      patch: { dirty: true },
    },
    {
      label: 'missing applied content',
      patch: { content: undefined },
    },
    {
      label: 'unknown field',
      patch: { unexpected: true },
    },
  ])('rejects an applied report with $label', ({ patch }) => {
    expect(
      parseFeedbackSnapshotReport({
        type: 'feedback.snapshot.report',
        ...identity,
        stage: 'applied',
        viewGeneration: 'view-generation-1',
        localRevision: 12,
        dirty: false,
        content: '# Current source\n',
        canonicalDescriptorRevision: 3,
        ...patch,
      })
    ).toBeNull();
  });
});
