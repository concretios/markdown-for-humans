import {
  createRendererFeedbackLifecycleMachine,
  reduceRendererFeedbackLifecycle,
  type RendererFeedbackLifecycleEvent,
  type RendererFeedbackLifecycleMachine,
} from '../../webview/features/feedbackLifecycleMachine';

function apply(
  machine: RendererFeedbackLifecycleMachine,
  event: RendererFeedbackLifecycleEvent
): RendererFeedbackLifecycleMachine {
  const result = reduceRendererFeedbackLifecycle(machine, event);
  if (result.disposition !== 'applied') {
    throw new Error(`Expected ${event.type} to apply, got ${result.disposition}`);
  }
  return result.machine;
}

const ACTIVATION_EPOCH = 'renderer-operation-1';
const SESSION_EPOCH = 'renderer-session-1';

const HAPPY_REVIEW: readonly RendererFeedbackLifecycleEvent[] = [
  {
    type: 'startRequested',
    operationEpoch: ACTIVATION_EPOCH,
    sessionEpoch: null,
    stageRevision: 1,
  },
  {
    type: 'quiesceApplied',
    operationEpoch: ACTIVATION_EPOCH,
    sessionEpoch: null,
    stageRevision: 2,
  },
  {
    type: 'snapshotApplyRequested',
    operationEpoch: ACTIVATION_EPOCH,
    sessionEpoch: null,
    stageRevision: 3,
  },
  {
    type: 'snapshotAppliedForReview',
    operationEpoch: ACTIVATION_EPOCH,
    sessionEpoch: SESSION_EPOCH,
    stageRevision: 4,
  },
  {
    type: 'reviewPrepared',
    operationEpoch: ACTIVATION_EPOCH,
    sessionEpoch: SESSION_EPOCH,
    stageRevision: 5,
  },
  {
    type: 'reviewCommitted',
    operationEpoch: ACTIVATION_EPOCH,
    sessionEpoch: SESSION_EPOCH,
    stageRevision: 6,
  },
];

describe('renderer Feedback lifecycle machine', () => {
  it('advances through quiesce, snapshot, prepare, and commit without partial review state', () => {
    const expectedStates = [
      'StartRequested',
      'Quiesced',
      'ApplyingSnapshot',
      'PreparingReview',
      'CommittingReview',
      'Reviewing',
    ];
    let machine = createRendererFeedbackLifecycleMachine();

    HAPPY_REVIEW.forEach((event, index) => {
      machine = apply(machine, event);
      expect(machine.state.kind).toBe(expectedStates[index]);
      expect(machine.state.operationEpoch).toBe(ACTIVATION_EPOCH);
      expect(machine.state.stageRevision).toBe(index + 1);
    });

    expect(machine.state).toMatchObject({
      kind: 'Reviewing',
      sessionEpoch: SESSION_EPOCH,
    });
  });

  it('keeps duplicate commands idempotent after the renderer has advanced', () => {
    let machine = createRendererFeedbackLifecycleMachine();
    for (const event of HAPPY_REVIEW) machine = apply(machine, event);

    const result = reduceRendererFeedbackLifecycle(machine, HAPPY_REVIEW[3]);

    expect(result.disposition).toBe('duplicate');
    expect(result.machine).toBe(machine);
    expect(result.machine.state.kind).toBe('Reviewing');
  });

  it('rejects stale revisions, skipped stages, and foreign operation epochs', () => {
    let machine = createRendererFeedbackLifecycleMachine();
    machine = apply(machine, HAPPY_REVIEW[0]);
    machine = apply(machine, HAPPY_REVIEW[1]);

    const stale = reduceRendererFeedbackLifecycle(machine, {
      type: 'operationFailed',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: null,
      stageRevision: 1,
      recoveryTarget: 'Editing',
    });
    const skipped = reduceRendererFeedbackLifecycle(machine, {
      type: 'snapshotApplyRequested',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: null,
      stageRevision: 4,
    });
    const foreign = reduceRendererFeedbackLifecycle(machine, {
      type: 'snapshotApplyRequested',
      operationEpoch: 'renderer-operation-2',
      sessionEpoch: null,
      stageRevision: 3,
    });

    expect(stale).toMatchObject({ disposition: 'rejected', reason: 'stale-stage-revision' });
    expect(skipped).toMatchObject({ disposition: 'rejected', reason: 'out-of-order-stage' });
    expect(foreign).toMatchObject({ disposition: 'rejected', reason: 'operation-mismatch' });
    expect(stale.machine).toBe(machine);
    expect(skipped.machine).toBe(machine);
    expect(foreign.machine).toBe(machine);
  });

  it('requires one stable session epoch before preparing review', () => {
    let machine = createRendererFeedbackLifecycleMachine();
    for (const event of HAPPY_REVIEW.slice(0, 3)) machine = apply(machine, event);

    const missing = reduceRendererFeedbackLifecycle(machine, {
      type: 'snapshotAppliedForReview',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: null,
      stageRevision: 4,
    });
    expect(missing).toMatchObject({ disposition: 'rejected', reason: 'session-required' });

    machine = apply(machine, HAPPY_REVIEW[3]);
    const staleSession = reduceRendererFeedbackLifecycle(machine, {
      type: 'reviewPrepared',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: 'renderer-session-2',
      stageRevision: 5,
    });

    expect(staleSession).toMatchObject({ disposition: 'rejected', reason: 'session-mismatch' });
    expect(staleSession.machine).toBe(machine);
  });

  it('closes with a new operation and applies the recorded recovery target', () => {
    let machine = createRendererFeedbackLifecycleMachine();
    for (const event of HAPPY_REVIEW) machine = apply(machine, event);

    machine = apply(machine, {
      type: 'closeRequested',
      operationEpoch: 'renderer-close-1',
      sessionEpoch: SESSION_EPOCH,
      stageRevision: 1,
    });
    expect(machine.state.kind).toBe('Closing');

    machine = apply(machine, {
      type: 'closeCompleted',
      operationEpoch: 'renderer-close-1',
      sessionEpoch: SESSION_EPOCH,
      stageRevision: 2,
      recoveryTarget: 'Editing',
    });
    expect(machine.state).toMatchObject({
      kind: 'ApplyingRecovery',
      recoveryTarget: 'Editing',
    });

    const recovered: RendererFeedbackLifecycleEvent = {
      type: 'recoveryApplied',
      operationEpoch: 'renderer-close-1',
      sessionEpoch: SESSION_EPOCH,
      stageRevision: 3,
    };
    machine = apply(machine, recovered);
    expect(machine.state).toMatchObject({ kind: 'Editing', sessionEpoch: null });

    const duplicate = reduceRendererFeedbackLifecycle(machine, recovered);
    expect(duplicate.disposition).toBe('duplicate');
    expect(duplicate.machine).toBe(machine);
  });

  it('rolls back each pre-commit stage to Editing or a durable draft deterministically', () => {
    let withoutDraft = createRendererFeedbackLifecycleMachine();
    for (const event of HAPPY_REVIEW.slice(0, 2)) withoutDraft = apply(withoutDraft, event);
    withoutDraft = apply(withoutDraft, {
      type: 'operationFailed',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: null,
      stageRevision: 3,
      recoveryTarget: 'Editing',
    });
    expect(withoutDraft.state).toMatchObject({
      kind: 'ApplyingRecovery',
      recoveryTarget: 'Editing',
    });
    withoutDraft = apply(withoutDraft, {
      type: 'recoveryApplied',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: null,
      stageRevision: 4,
    });
    expect(withoutDraft.state.kind).toBe('Editing');

    let withDraft = createRendererFeedbackLifecycleMachine();
    for (const event of HAPPY_REVIEW.slice(0, 4)) withDraft = apply(withDraft, event);
    withDraft = apply(withDraft, {
      type: 'operationFailed',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: SESSION_EPOCH,
      stageRevision: 5,
      recoveryTarget: 'DraftAvailable',
    });
    withDraft = apply(withDraft, {
      type: 'recoveryApplied',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: SESSION_EPOCH,
      stageRevision: 6,
    });
    expect(withDraft.state).toMatchObject({
      kind: 'DraftAvailable',
      sessionEpoch: SESSION_EPOCH,
    });
  });

  it('rejects a draft recovery target until a session exists', () => {
    let machine = createRendererFeedbackLifecycleMachine();
    machine = apply(machine, HAPPY_REVIEW[0]);

    const result = reduceRendererFeedbackLifecycle(machine, {
      type: 'operationFailed',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: null,
      stageRevision: 2,
      recoveryTarget: 'DraftAvailable',
    });

    expect(result).toMatchObject({ disposition: 'rejected', reason: 'draft-requires-session' });
    expect(result.machine).toBe(machine);
  });
});
