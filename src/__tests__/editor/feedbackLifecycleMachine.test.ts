import {
  createHostFeedbackLifecycleMachine,
  reduceHostFeedbackLifecycle,
  type HostFeedbackLifecycleEvent,
  type HostFeedbackLifecycleMachine,
} from '../../editor/feedbackLifecycleMachine';

function apply(
  machine: HostFeedbackLifecycleMachine,
  event: HostFeedbackLifecycleEvent
): HostFeedbackLifecycleMachine {
  const result = reduceHostFeedbackLifecycle(machine, event);
  if (result.disposition !== 'applied') {
    throw new Error(`Expected ${event.type} to apply, got ${result.disposition}`);
  }
  return result.machine;
}

const ACTIVATION_EPOCH = 'activation-epoch-1';
const SESSION_EPOCH = 'session-epoch-1';

const HAPPY_ACTIVATION: readonly HostFeedbackLifecycleEvent[] = [
  {
    type: 'startRequested',
    operationEpoch: ACTIVATION_EPOCH,
    sessionEpoch: null,
    stageRevision: 1,
  },
  {
    type: 'preparationCompleted',
    operationEpoch: ACTIVATION_EPOCH,
    sessionEpoch: null,
    stageRevision: 2,
  },
  {
    type: 'quiesceCompleted',
    operationEpoch: ACTIVATION_EPOCH,
    sessionEpoch: null,
    stageRevision: 3,
  },
  {
    type: 'reconciliationCompleted',
    operationEpoch: ACTIVATION_EPOCH,
    sessionEpoch: null,
    stageRevision: 4,
  },
  {
    type: 'saveCompleted',
    operationEpoch: ACTIVATION_EPOCH,
    sessionEpoch: null,
    stageRevision: 5,
  },
  {
    type: 'descriptionCompleted',
    operationEpoch: ACTIVATION_EPOCH,
    sessionEpoch: SESSION_EPOCH,
    stageRevision: 6,
  },
  {
    type: 'activationPrepared',
    operationEpoch: ACTIVATION_EPOCH,
    sessionEpoch: SESSION_EPOCH,
    stageRevision: 7,
  },
  {
    type: 'activationCommitted',
    operationEpoch: ACTIVATION_EPOCH,
    sessionEpoch: SESSION_EPOCH,
    stageRevision: 8,
  },
];

describe('host Feedback lifecycle machine', () => {
  it('advances through every activation stage with correlated revisions', () => {
    const expectedStates = [
      'Preparing',
      'Quiescing',
      'Reconciling',
      'Saving',
      'Describing',
      'PreparingActivation',
      'CommittingActivation',
      'Active',
    ];
    let machine = createHostFeedbackLifecycleMachine();

    HAPPY_ACTIVATION.forEach((event, index) => {
      machine = apply(machine, event);
      expect(machine.state.kind).toBe(expectedStates[index]);
      expect(machine.state.operationEpoch).toBe(ACTIVATION_EPOCH);
      expect(machine.state.stageRevision).toBe(index + 1);
    });

    expect(machine.state).toMatchObject({
      kind: 'Active',
      sessionEpoch: SESSION_EPOCH,
    });
  });

  it('treats an accepted event replay as idempotent even after later stages', () => {
    let machine = createHostFeedbackLifecycleMachine();
    for (const event of HAPPY_ACTIVATION.slice(0, 4)) machine = apply(machine, event);

    const result = reduceHostFeedbackLifecycle(machine, HAPPY_ACTIVATION[1]);

    expect(result.disposition).toBe('duplicate');
    expect(result.machine).toBe(machine);
    expect(result.machine.state.kind).toBe('Saving');
  });

  it('rejects stale, skipped, conflicting, and foreign operation stages without mutation', () => {
    let machine = createHostFeedbackLifecycleMachine();
    machine = apply(machine, HAPPY_ACTIVATION[0]);
    machine = apply(machine, HAPPY_ACTIVATION[1]);

    const stale = reduceHostFeedbackLifecycle(machine, {
      type: 'operationFailed',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: null,
      stageRevision: 1,
      recoveryTarget: 'Idle',
    });
    const skipped = reduceHostFeedbackLifecycle(machine, {
      type: 'quiesceCompleted',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: null,
      stageRevision: 4,
    });
    const conflict = reduceHostFeedbackLifecycle(machine, {
      type: 'operationFailed',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: null,
      stageRevision: 2,
      recoveryTarget: 'Idle',
    });
    const foreign = reduceHostFeedbackLifecycle(machine, {
      type: 'quiesceCompleted',
      operationEpoch: 'activation-epoch-2',
      sessionEpoch: null,
      stageRevision: 3,
    });

    expect(stale).toMatchObject({ disposition: 'rejected', reason: 'stale-stage-revision' });
    expect(skipped).toMatchObject({ disposition: 'rejected', reason: 'out-of-order-stage' });
    expect(conflict).toMatchObject({ disposition: 'rejected', reason: 'stage-conflict' });
    expect(foreign).toMatchObject({ disposition: 'rejected', reason: 'operation-mismatch' });
    expect(stale.machine).toBe(machine);
    expect(skipped.machine).toBe(machine);
    expect(conflict.machine).toBe(machine);
    expect(foreign.machine).toBe(machine);
  });

  it('introduces one session epoch and rejects missing or replacement epochs', () => {
    let machine = createHostFeedbackLifecycleMachine();
    for (const event of HAPPY_ACTIVATION.slice(0, 5)) machine = apply(machine, event);

    const missing = reduceHostFeedbackLifecycle(machine, {
      type: 'descriptionCompleted',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: null,
      stageRevision: 6,
    });
    expect(missing).toMatchObject({ disposition: 'rejected', reason: 'session-required' });

    machine = apply(machine, HAPPY_ACTIVATION[5]);
    const replacement = reduceHostFeedbackLifecycle(machine, {
      type: 'activationPrepared',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: 'replacement-session',
      stageRevision: 7,
    });

    expect(replacement).toMatchObject({ disposition: 'rejected', reason: 'session-mismatch' });
    expect(replacement.machine).toBe(machine);
  });

  it('uses a new operation epoch to close and restore the active session', () => {
    let machine = createHostFeedbackLifecycleMachine();
    for (const event of HAPPY_ACTIVATION) machine = apply(machine, event);

    machine = apply(machine, {
      type: 'closeRequested',
      operationEpoch: 'close-epoch-1',
      sessionEpoch: SESSION_EPOCH,
      stageRevision: 1,
    });
    expect(machine.state.kind).toBe('Closing');

    machine = apply(machine, {
      type: 'closeCompleted',
      operationEpoch: 'close-epoch-1',
      sessionEpoch: SESSION_EPOCH,
      stageRevision: 2,
    });
    expect(machine.state.kind).toBe('Restoring');

    const restoredEvent: HostFeedbackLifecycleEvent = {
      type: 'restoreCompleted',
      operationEpoch: 'close-epoch-1',
      sessionEpoch: SESSION_EPOCH,
      stageRevision: 3,
    };
    machine = apply(machine, restoredEvent);
    expect(machine.state).toMatchObject({ kind: 'Idle', sessionEpoch: null });

    const duplicate = reduceHostFeedbackLifecycle(machine, restoredEvent);
    expect(duplicate.disposition).toBe('duplicate');
    expect(duplicate.machine).toBe(machine);
  });

  it('records the recovery target and completes recovery deterministically', () => {
    let beforeDraft = createHostFeedbackLifecycleMachine();
    for (const event of HAPPY_ACTIVATION.slice(0, 4)) beforeDraft = apply(beforeDraft, event);

    beforeDraft = apply(beforeDraft, {
      type: 'operationFailed',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: null,
      stageRevision: 5,
      recoveryTarget: 'Idle',
    });
    expect(beforeDraft.state).toMatchObject({ kind: 'Recovering', recoveryTarget: 'Idle' });
    beforeDraft = apply(beforeDraft, {
      type: 'recoveryCompleted',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: null,
      stageRevision: 6,
    });
    expect(beforeDraft.state.kind).toBe('Idle');

    let withDraft = createHostFeedbackLifecycleMachine();
    for (const event of HAPPY_ACTIVATION.slice(0, 6)) withDraft = apply(withDraft, event);
    withDraft = apply(withDraft, {
      type: 'operationFailed',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: SESSION_EPOCH,
      stageRevision: 7,
      recoveryTarget: 'DraftAvailable',
    });
    expect(withDraft.state).toMatchObject({
      kind: 'Recovering',
      recoveryTarget: 'DraftAvailable',
    });
    withDraft = apply(withDraft, {
      type: 'recoveryCompleted',
      operationEpoch: ACTIVATION_EPOCH,
      sessionEpoch: SESSION_EPOCH,
      stageRevision: 8,
    });
    expect(withDraft.state).toMatchObject({
      kind: 'DraftAvailable',
      sessionEpoch: SESSION_EPOCH,
    });
  });

  it('cannot recover to a draft before a session epoch exists', () => {
    let machine = createHostFeedbackLifecycleMachine();
    machine = apply(machine, HAPPY_ACTIVATION[0]);

    const result = reduceHostFeedbackLifecycle(machine, {
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
