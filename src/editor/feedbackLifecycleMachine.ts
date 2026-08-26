/**
 * Pure extension-host state machine for the Feedback lifecycle.
 *
 * The reducer has no I/O. Callers execute effects only after an event returns
 * `applied`. Every operation uses a fresh epoch and monotonically increasing
 * stage revisions so delayed webview messages cannot mutate newer work.
 */

export type HostRecoveryTarget = 'Idle' | 'DraftAvailable';

interface HostStateBase<TKind extends string> {
  readonly kind: TKind;
  readonly operationEpoch: string | null;
  readonly sessionEpoch: string | null;
  readonly stageRevision: number;
}

export type HostFeedbackLifecycleState =
  | HostStateBase<'Idle'>
  | HostStateBase<'Preparing'>
  | HostStateBase<'Quiescing'>
  | HostStateBase<'Reconciling'>
  | HostStateBase<'Saving'>
  | HostStateBase<'Describing'>
  | HostStateBase<'PreparingActivation'>
  | HostStateBase<'CommittingActivation'>
  | HostStateBase<'Active'>
  | HostStateBase<'Closing'>
  | HostStateBase<'Restoring'>
  | (HostStateBase<'Recovering'> & { readonly recoveryTarget: HostRecoveryTarget })
  | HostStateBase<'DraftAvailable'>;

interface HostEventBase<TType extends string> {
  readonly type: TType;
  readonly operationEpoch: string;
  readonly sessionEpoch: string | null;
  readonly stageRevision: number;
}

export type HostFeedbackLifecycleEvent =
  | HostEventBase<'startRequested'>
  | HostEventBase<'preparationCompleted'>
  | HostEventBase<'quiesceCompleted'>
  | HostEventBase<'reconciliationCompleted'>
  | HostEventBase<'saveCompleted'>
  | HostEventBase<'descriptionCompleted'>
  | HostEventBase<'activationPrepared'>
  | HostEventBase<'activationCommitted'>
  | HostEventBase<'closeRequested'>
  | HostEventBase<'closeCompleted'>
  | HostEventBase<'restoreCompleted'>
  | (HostEventBase<'operationFailed'> & { readonly recoveryTarget: HostRecoveryTarget })
  | HostEventBase<'recoveryCompleted'>;

interface AcceptedHostStage {
  readonly type: HostFeedbackLifecycleEvent['type'];
  readonly operationEpoch: string;
  readonly sessionEpoch: string | null;
  readonly stageRevision: number;
  readonly recoveryTarget: HostRecoveryTarget | null;
}

export interface HostFeedbackLifecycleMachine {
  readonly state: HostFeedbackLifecycleState;
  /** Accepted stages for the current operation, retained for idempotent replay. */
  readonly acceptedStages: readonly AcceptedHostStage[];
}

export type HostLifecycleRejectionReason =
  | 'invalid-operation-epoch'
  | 'invalid-session-epoch'
  | 'invalid-stage-revision'
  | 'operation-epoch-reused'
  | 'operation-mismatch'
  | 'session-required'
  | 'session-mismatch'
  | 'stale-stage-revision'
  | 'stage-conflict'
  | 'out-of-order-stage'
  | 'draft-requires-session'
  | 'recovery-target-mismatch'
  | 'unexpected-event';

export type HostFeedbackLifecycleReduction =
  | {
      readonly disposition: 'applied' | 'duplicate';
      readonly machine: HostFeedbackLifecycleMachine;
    }
  | {
      readonly disposition: 'rejected';
      readonly reason: HostLifecycleRejectionReason;
      readonly machine: HostFeedbackLifecycleMachine;
    };

/** Creates the only valid initial host lifecycle state. */
export function createHostFeedbackLifecycleMachine(): HostFeedbackLifecycleMachine {
  return {
    state: {
      kind: 'Idle',
      operationEpoch: null,
      sessionEpoch: null,
      stageRevision: 0,
    },
    acceptedStages: [],
  };
}

function reject(
  machine: HostFeedbackLifecycleMachine,
  reason: HostLifecycleRejectionReason
): HostFeedbackLifecycleReduction {
  return { disposition: 'rejected', reason, machine };
}

function eventRecoveryTarget(event: HostFeedbackLifecycleEvent): HostRecoveryTarget | null {
  return event.type === 'operationFailed' ? event.recoveryTarget : null;
}

function acceptedStage(event: HostFeedbackLifecycleEvent): AcceptedHostStage {
  return {
    type: event.type,
    operationEpoch: event.operationEpoch,
    sessionEpoch: event.sessionEpoch,
    stageRevision: event.stageRevision,
    recoveryTarget: eventRecoveryTarget(event),
  };
}

function isSameAcceptedStage(prior: AcceptedHostStage, event: HostFeedbackLifecycleEvent): boolean {
  return (
    prior.type === event.type &&
    prior.operationEpoch === event.operationEpoch &&
    prior.sessionEpoch === event.sessionEpoch &&
    prior.stageRevision === event.stageRevision &&
    prior.recoveryTarget === eventRecoveryTarget(event)
  );
}

function apply(
  machine: HostFeedbackLifecycleMachine,
  event: HostFeedbackLifecycleEvent,
  state: HostFeedbackLifecycleState,
  startsNewOperation = false
): HostFeedbackLifecycleReduction {
  return {
    disposition: 'applied',
    machine: {
      state,
      acceptedStages: startsNewOperation
        ? [acceptedStage(event)]
        : [...machine.acceptedStages, acceptedStage(event)],
    },
  };
}

function operationState<TKind extends HostFeedbackLifecycleState['kind']>(
  kind: TKind,
  event: HostFeedbackLifecycleEvent
): Extract<HostFeedbackLifecycleState, { kind: TKind }> {
  return {
    kind,
    operationEpoch: event.operationEpoch,
    sessionEpoch: event.sessionEpoch,
    stageRevision: event.stageRevision,
  } as Extract<HostFeedbackLifecycleState, { kind: TKind }>;
}

function validateEventIdentity(
  machine: HostFeedbackLifecycleMachine,
  event: HostFeedbackLifecycleEvent
): HostFeedbackLifecycleReduction | null {
  if (event.operationEpoch.length === 0) return reject(machine, 'invalid-operation-epoch');
  if (event.sessionEpoch !== null && event.sessionEpoch.length === 0) {
    return reject(machine, 'invalid-session-epoch');
  }
  if (!Number.isInteger(event.stageRevision) || event.stageRevision < 1) {
    return reject(machine, 'invalid-stage-revision');
  }
  return null;
}

function validateStart(
  machine: HostFeedbackLifecycleMachine,
  event: HostFeedbackLifecycleEvent
): HostFeedbackLifecycleReduction | null {
  const { state } = machine;
  if (event.type !== 'startRequested') return reject(machine, 'unexpected-event');
  if (event.stageRevision !== 1) return reject(machine, 'out-of-order-stage');
  if (event.operationEpoch === state.operationEpoch) {
    return reject(machine, 'operation-epoch-reused');
  }
  if (state.kind === 'Idle' && event.sessionEpoch !== null) {
    return reject(machine, 'session-mismatch');
  }
  if (state.kind === 'DraftAvailable' && event.sessionEpoch !== state.sessionEpoch) {
    return reject(machine, 'session-mismatch');
  }
  return null;
}

function validateCloseStart(
  machine: HostFeedbackLifecycleMachine,
  event: HostFeedbackLifecycleEvent
): HostFeedbackLifecycleReduction | null {
  const { state } = machine;
  if (event.stageRevision !== 1) return reject(machine, 'out-of-order-stage');
  if (event.operationEpoch === state.operationEpoch) {
    return reject(machine, 'operation-epoch-reused');
  }
  if (event.sessionEpoch !== state.sessionEpoch) return reject(machine, 'session-mismatch');
  return null;
}

function validateCurrentOperationStage(
  machine: HostFeedbackLifecycleMachine,
  event: HostFeedbackLifecycleEvent
): HostFeedbackLifecycleReduction | null {
  const { state } = machine;
  if (event.operationEpoch !== state.operationEpoch) {
    return reject(machine, 'operation-mismatch');
  }
  if (event.stageRevision < state.stageRevision) {
    return reject(machine, 'stale-stage-revision');
  }
  if (event.stageRevision === state.stageRevision) {
    return reject(machine, 'stage-conflict');
  }
  if (event.stageRevision > state.stageRevision + 1) {
    return reject(machine, 'out-of-order-stage');
  }

  if (event.type === 'descriptionCompleted') {
    if (event.sessionEpoch === null) return reject(machine, 'session-required');
    if (state.sessionEpoch !== null && event.sessionEpoch !== state.sessionEpoch) {
      return reject(machine, 'session-mismatch');
    }
  } else if (event.sessionEpoch !== state.sessionEpoch) {
    return reject(machine, 'session-mismatch');
  }

  if (
    event.type === 'operationFailed' &&
    event.recoveryTarget === 'DraftAvailable' &&
    event.sessionEpoch === null
  ) {
    return reject(machine, 'draft-requires-session');
  }
  return null;
}

/**
 * Reduces one already schema-validated lifecycle event.
 *
 * Rejected and duplicate events return the original machine object. This lets
 * callers safely acknowledge replays without re-running their effects.
 */
export function reduceHostFeedbackLifecycle(
  machine: HostFeedbackLifecycleMachine,
  event: HostFeedbackLifecycleEvent
): HostFeedbackLifecycleReduction {
  const invalidIdentity = validateEventIdentity(machine, event);
  if (invalidIdentity) return invalidIdentity;

  const priorAtRevision = machine.acceptedStages.find(
    prior =>
      prior.operationEpoch === event.operationEpoch && prior.stageRevision === event.stageRevision
  );
  if (priorAtRevision && isSameAcceptedStage(priorAtRevision, event)) {
    return { disposition: 'duplicate', machine };
  }

  const { state } = machine;
  if (state.kind === 'Idle' || state.kind === 'DraftAvailable') {
    const invalidStart = validateStart(machine, event);
    if (invalidStart) return invalidStart;
    return apply(machine, event, operationState('Preparing', event), true);
  }

  if (state.kind === 'Active' && event.type === 'closeRequested') {
    const invalidClose = validateCloseStart(machine, event);
    if (invalidClose) return invalidClose;
    return apply(machine, event, operationState('Closing', event), true);
  }

  const invalidStage = validateCurrentOperationStage(machine, event);
  if (invalidStage) return invalidStage;

  if (event.type === 'operationFailed') {
    if (state.kind === 'Recovering' && event.recoveryTarget !== state.recoveryTarget) {
      return reject(machine, 'recovery-target-mismatch');
    }
    return apply(machine, event, {
      ...operationState('Recovering', event),
      recoveryTarget: state.kind === 'Recovering' ? state.recoveryTarget : event.recoveryTarget,
    });
  }

  switch (state.kind) {
    case 'Preparing':
      return event.type === 'preparationCompleted'
        ? apply(machine, event, operationState('Quiescing', event))
        : reject(machine, 'unexpected-event');
    case 'Quiescing':
      return event.type === 'quiesceCompleted'
        ? apply(machine, event, operationState('Reconciling', event))
        : reject(machine, 'unexpected-event');
    case 'Reconciling':
      return event.type === 'reconciliationCompleted'
        ? apply(machine, event, operationState('Saving', event))
        : reject(machine, 'unexpected-event');
    case 'Saving':
      return event.type === 'saveCompleted'
        ? apply(machine, event, operationState('Describing', event))
        : reject(machine, 'unexpected-event');
    case 'Describing':
      return event.type === 'descriptionCompleted'
        ? apply(machine, event, operationState('PreparingActivation', event))
        : reject(machine, 'unexpected-event');
    case 'PreparingActivation':
      return event.type === 'activationPrepared'
        ? apply(machine, event, operationState('CommittingActivation', event))
        : reject(machine, 'unexpected-event');
    case 'CommittingActivation':
      return event.type === 'activationCommitted'
        ? apply(machine, event, operationState('Active', event))
        : reject(machine, 'unexpected-event');
    case 'Active':
      return reject(machine, 'unexpected-event');
    case 'Closing':
      return event.type === 'closeCompleted'
        ? apply(machine, event, operationState('Restoring', event))
        : reject(machine, 'unexpected-event');
    case 'Restoring':
      return event.type === 'restoreCompleted'
        ? apply(machine, event, {
            ...operationState('Idle', event),
            sessionEpoch: null,
          })
        : reject(machine, 'unexpected-event');
    case 'Recovering':
      if (event.type !== 'recoveryCompleted') return reject(machine, 'unexpected-event');
      return state.recoveryTarget === 'DraftAvailable'
        ? apply(machine, event, operationState('DraftAvailable', event))
        : apply(machine, event, {
            ...operationState('Idle', event),
            sessionEpoch: null,
          });
  }
}
