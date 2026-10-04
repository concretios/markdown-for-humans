import {
  FEEDBACK_DELIVERY_PROTOCOL_VERSION,
  parseFeedbackDeliveryAcknowledgement,
  parseFeedbackDeliveryStatusQuery,
  parseFeedbackDeliveryStatusResponse,
  parseFeedbackStartedDelivery,
} from '../../shared/feedbackDeliveryProtocol';

const started = {
  type: 'feedback.started' as const,
  requestId: 'feedback-request-1',
  sessionId: 'session-1',
  source: 'docs/guide.md',
  sourceSha256: 'a'.repeat(64),
  round: '20260826T120000Z-ab12',
  feedbackFile: '.md4h/feedback/guide/feedback.md',
  anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
  items: [],
};

const delivery = {
  type: 'feedback.delivery' as const,
  protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
  messageId: 'delivery-1',
  operationEpoch: started.requestId,
  sessionEpoch: started.sessionId,
  stageRevision: 1,
  payload: started,
};

describe('Feedback delivery protocol', () => {
  it('parses a fully correlated Feedback started delivery', () => {
    expect(parseFeedbackStartedDelivery(delivery)).toEqual(delivery);
  });

  it.each([
    { ...delivery, extra: true },
    { ...delivery, protocolVersion: 0 },
    { ...delivery, messageId: 'x'.repeat(257) },
    { ...delivery, operationEpoch: 'another-request' },
    { ...delivery, sessionEpoch: 'another-session' },
    { ...delivery, stageRevision: 0 },
    { ...delivery, payload: { ...started, type: 'feedback.updated' } },
  ])('rejects malformed or unbound deliveries', candidate => {
    expect(parseFeedbackStartedDelivery(candidate)).toBeNull();
  });

  it('parses applied and rejected application acknowledgements', () => {
    const identity = {
      type: 'feedback.delivery.ack' as const,
      protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
      messageId: delivery.messageId,
      operationEpoch: delivery.operationEpoch,
      sessionEpoch: delivery.sessionEpoch,
      stageRevision: delivery.stageRevision,
    };

    expect(
      parseFeedbackDeliveryAcknowledgement({
        ...identity,
        outcome: { kind: 'applied', value: { messageType: 'feedback.started' } },
      })
    ).toEqual({
      ...identity,
      outcome: { kind: 'applied', value: { messageType: 'feedback.started' } },
    });
    expect(
      parseFeedbackDeliveryAcknowledgement({
        ...identity,
        outcome: { kind: 'rejected', code: 'renderer-not-ready' },
      })
    ).toEqual({
      ...identity,
      outcome: { kind: 'rejected', code: 'renderer-not-ready' },
    });
  });

  it.each([
    {
      type: 'feedback.delivery.ack',
      protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
      messageId: 'delivery-1',
      operationEpoch: 'feedback-request-1',
      sessionEpoch: 'session-1',
      stageRevision: 1,
      outcome: { kind: 'applied', value: { messageType: 'feedback.updated' } },
    },
    {
      type: 'feedback.delivery.ack',
      protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
      messageId: 'delivery-1',
      operationEpoch: 'feedback-request-1',
      sessionEpoch: 'session-1',
      stageRevision: 1,
      outcome: { kind: 'rejected', code: '' },
    },
  ])('rejects malformed application acknowledgements', candidate => {
    expect(parseFeedbackDeliveryAcknowledgement(candidate)).toBeNull();
  });

  it('parses a fully bound application-status query', () => {
    const query = {
      type: 'feedback.delivery.status.query',
      protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
      messageId: delivery.messageId,
      operationEpoch: delivery.operationEpoch,
      sessionEpoch: delivery.sessionEpoch,
      stageRevision: delivery.stageRevision,
    };

    expect(parseFeedbackDeliveryStatusQuery(query)).toEqual(query);
  });

  it.each([
    { extra: true },
    { messageId: 'x'.repeat(257) },
    { operationEpoch: 'bad\nrequest' },
    { sessionEpoch: '' },
    { stageRevision: 0 },
    { stageRevision: 2 },
    { protocolVersion: 0 },
  ])('rejects a malformed application-status query', override => {
    expect(
      parseFeedbackDeliveryStatusQuery({
        type: 'feedback.delivery.status.query',
        protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        messageId: delivery.messageId,
        operationEpoch: delivery.operationEpoch,
        sessionEpoch: delivery.sessionEpoch,
        stageRevision: delivery.stageRevision,
        ...override,
      })
    ).toBeNull();
  });

  it.each([
    { kind: 'applied', value: { messageType: 'feedback.started' } },
    { kind: 'inactive' },
    { kind: 'mismatch' },
  ])('parses a fully bound $kind application-status response', status => {
    const response = {
      type: 'feedback.delivery.status.response',
      protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
      messageId: delivery.messageId,
      operationEpoch: delivery.operationEpoch,
      sessionEpoch: delivery.sessionEpoch,
      stageRevision: delivery.stageRevision,
      status,
    };

    expect(parseFeedbackDeliveryStatusResponse(response)).toEqual(response);
  });

  it.each([
    { kind: 'applied' },
    { kind: 'applied', value: { messageType: 'feedback.updated' } },
    { kind: 'inactive', extra: true },
    { kind: 'mismatch', activeSessionEpoch: 'another-session' },
    { kind: 'unknown' },
  ])('rejects a malformed application-status response', status => {
    expect(
      parseFeedbackDeliveryStatusResponse({
        type: 'feedback.delivery.status.response',
        protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        messageId: delivery.messageId,
        operationEpoch: delivery.operationEpoch,
        sessionEpoch: delivery.sessionEpoch,
        stageRevision: delivery.stageRevision,
        status,
      })
    ).toBeNull();
  });
});
