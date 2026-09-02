/**
 * Pure renderer-side state machine for the Feedback lifecycle.
 *
 * DOM setup and teardown belong to an effect layer. The reducer only accepts
 * correlated, monotonic commands and records a fixed recovery destination.
 *
 * This reducer is specified in roadmap/pipeline/task-feedback-reliability-architecture.md's
 * "Remaining architecture and acceptance gaps" section as a target authority for lifecycle
 * state. However, it is not yet wired into production as that authority; that work remains
 * tracked and intended. Before wiring either this reducer or its sibling host reducer into
 * production, note that RendererRecoveryTarget ('Editing' | 'DraftAvailable') and HostRecoveryTarget
 * ('Idle' | 'DraftAvailable') must be reconciled. The two types share 'DraftAvailable' but
 * diverge on the other recovery target ('Editing' vs 'Idle'), and that gap must be resolved
 * before either reducer becomes the production lifecycle authority.
 */

export type RendererRecoveryTarget = 'Editing' | 'DraftAvailable';

interface RendererStateBase<TKind extends string> {
  readonly kind: TKind;
  readonly operationEpoch: string | null;
  readonly sessionEpoch: string | null;
  readonly stageRevision: number;
}

export type RendererFeedbackLifecycleState =
  | RendererStateBase<'Editing'>
  | RendererStateBase<'StartRequested'>
  | RendererStateBase<'Quiesced'>
  | RendererStateBase<'ApplyingSnapshot'>
  | RendererStateBase<'PreparingReview'>
  | RendererStateBase<'CommittingReview'>
  | RendererStateBase<'Reviewing'>
  | RendererStateBase<'Closing'>
  | (RendererStateBase<'ApplyingRecovery'> & {
      readonly recoveryTarget: RendererRecoveryTarget;
    })
  | RendererStateBase<'DraftAvailable'>;

interface RendererEventBase<TType extends string> {
  readonly type: TType;
  readonly operationEpoch: string;
  readonly sessionEpoch: string | null;
  readonly stageRevision: number;
}

export type RendererFeedbackLifecycleEvent =
  | RendererEventBase<'startRequested'>
  | RendererEventBase<'quiesceApplied'>
  | RendererEventBase<'snapshotApplyRequested'>
  | RendererEventBase<'snapshotAppliedForReview'>
  | RendererEventBase<'reviewPrepared'>
  | RendererEventBase<'reviewCommitted'>
  | RendererEventBase<'closeRequested'>
  | (RendererEventBase<'closeCompleted'> & {
      readonly recoveryTarget: RendererRecoveryTarget;
    })
  | (RendererEventBase<'operationFailed'> & {
      readonly recoveryTarget: RendererRecoveryTarget;
    })
  | RendererEventBase<'recoveryApplied'>;

interface AcceptedRendererStage {
  readonly type: RendererFeedbackLifecycleEvent['type'];
  readonly operationEpoch: string;
  readonly sessionEpoch: string | null;
  readonly stageRevision: number;
  readonly recoveryTarget: RendererRecoveryTarget | null;
}

export interface RendererFeedbackLifecycleMachine {
  readonly state: RendererFeedbackLifecycleState;
  /** Accepted stages for the current operation, retained for idempotent replay. */
  readonly acceptedStages: readonly AcceptedRendererStage[];
}

export type RendererLifecycleRejectionReason =
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

export type RendererFeedbackLifecycleReduction =
  | {
      readonly disposition: 'applied' | 'duplicate';
      readonly machine: RendererFeedbackLifecycleMachine;
    }
  | {
      readonly disposition: 'rejected';
      readonly reason: RendererLifecycleRejectionReason;
      readonly machine: RendererFeedbackLifecycleMachine;
    };

/** Creates the only valid initial renderer lifecycle state. */
export function createRendererFeedbackLifecycleMachine(): RendererFeedbackLifecycleMachine {
  return {
    state: {
      kind: 'Editing',
      operationEpoch: null,
      sessionEpoch: null,
      stageRevision: 0,
    },
    acceptedStages: [],
  };
}

function reject(
  machine: RendererFeedbackLifecycleMachine,
  reason: RendererLifecycleRejectionReason
): RendererFeedbackLifecycleReduction {
  return { disposition: 'rejected', reason, machine };
}

function eventRecoveryTarget(event: RendererFeedbackLifecycleEvent): RendererRecoveryTarget | null {
  return event.type === 'operationFailed' || event.type === 'closeCompleted'
    ? event.recoveryTarget
    : null;
}

function acceptedStage(event: RendererFeedbackLifecycleEvent): AcceptedRendererStage {
  return {
    type: event.type,
    operationEpoch: event.operationEpoch,
    sessionEpoch: event.sessionEpoch,
    stageRevision: event.stageRevision,
    recoveryTarget: eventRecoveryTarget(event),
  };
}

function isSameAcceptedStage(
  prior: AcceptedRendererStage,
  event: RendererFeedbackLifecycleEvent
): boolean {
  return (
    prior.type === event.type &&
    prior.operationEpoch === event.operationEpoch &&
    prior.sessionEpoch === event.sessionEpoch &&
    prior.stageRevision === event.stageRevision &&
    prior.recoveryTarget === eventRecoveryTarget(event)
  );
}

function apply(
  machine: RendererFeedbackLifecycleMachine,
  event: RendererFeedbackLifecycleEvent,
  state: RendererFeedbackLifecycleState,
  startsNewOperation = false
): RendererFeedbackLifecycleReduction {
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

function operationState<TKind extends RendererFeedbackLifecycleState['kind']>(
  kind: TKind,
  event: RendererFeedbackLifecycleEvent
): Extract<RendererFeedbackLifecycleState, { kind: TKind }> {
  return {
    kind,
    operationEpoch: event.operationEpoch,
    sessionEpoch: event.sessionEpoch,
    stageRevision: event.stageRevision,
  } as Extract<RendererFeedbackLifecycleState, { kind: TKind }>;
}

function validateEventIdentity(
  machine: RendererFeedbackLifecycleMachine,
  event: RendererFeedbackLifecycleEvent
): RendererFeedbackLifecycleReduction | null {
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
  machine: RendererFeedbackLifecycleMachine,
  event: RendererFeedbackLifecycleEvent
): RendererFeedbackLifecycleReduction | null {
  const { state } = machine;
  if (event.type !== 'startRequested') return reject(machine, 'unexpected-event');
  if (event.stageRevision !== 1) return reject(machine, 'out-of-order-stage');
  if (event.operationEpoch === state.operationEpoch) {
    return reject(machine, 'operation-epoch-reused');
  }
  if (state.kind === 'Editing' && event.sessionEpoch !== null) {
    return reject(machine, 'session-mismatch');
  }
  if (state.kind === 'DraftAvailable' && event.sessionEpoch !== state.sessionEpoch) {
    return reject(machine, 'session-mismatch');
  }
  return null;
}

function validateCloseStart(
  machine: RendererFeedbackLifecycleMachine,
  event: RendererFeedbackLifecycleEvent
): RendererFeedbackLifecycleReduction | null {
  const { state } = machine;
  if (event.stageRevision !== 1) return reject(machine, 'out-of-order-stage');
  if (event.operationEpoch === state.operationEpoch) {
    return reject(machine, 'operation-epoch-reused');
  }
  if (event.sessionEpoch !== state.sessionEpoch) return reject(machine, 'session-mismatch');
  return null;
}

function validateCurrentOperationStage(
  machine: RendererFeedbackLifecycleMachine,
  event: RendererFeedbackLifecycleEvent
): RendererFeedbackLifecycleReduction | null {
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

  if (event.type === 'snapshotAppliedForReview') {
    if (event.sessionEpoch === null) return reject(machine, 'session-required');
    if (state.sessionEpoch !== null && event.sessionEpoch !== state.sessionEpoch) {
      return reject(machine, 'session-mismatch');
    }
  } else if (event.sessionEpoch !== state.sessionEpoch) {
    return reject(machine, 'session-mismatch');
  }

  if (
    (event.type === 'operationFailed' || event.type === 'closeCompleted') &&
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
 * Rejected and duplicate events return the original machine object. Effects
 * therefore run at most once for every accepted operation stage.
 */
export function reduceRendererFeedbackLifecycle(
  machine: RendererFeedbackLifecycleMachine,
  event: RendererFeedbackLifecycleEvent
): RendererFeedbackLifecycleReduction {
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
  if (state.kind === 'Editing' || state.kind === 'DraftAvailable') {
    const invalidStart = validateStart(machine, event);
    if (invalidStart) return invalidStart;
    return apply(machine, event, operationState('StartRequested', event), true);
  }

  if (state.kind === 'Reviewing' && event.type === 'closeRequested') {
    const invalidClose = validateCloseStart(machine, event);
    if (invalidClose) return invalidClose;
    return apply(machine, event, operationState('Closing', event), true);
  }

  const invalidStage = validateCurrentOperationStage(machine, event);
  if (invalidStage) return invalidStage;

  if (event.type === 'operationFailed') {
    if (state.kind === 'ApplyingRecovery' && event.recoveryTarget !== state.recoveryTarget) {
      return reject(machine, 'recovery-target-mismatch');
    }
    return apply(machine, event, {
      ...operationState('ApplyingRecovery', event),
      recoveryTarget:
        state.kind === 'ApplyingRecovery' ? state.recoveryTarget : event.recoveryTarget,
    });
  }

  switch (state.kind) {
    case 'StartRequested':
      return event.type === 'quiesceApplied'
        ? apply(machine, event, operationState('Quiesced', event))
        : reject(machine, 'unexpected-event');
    case 'Quiesced':
      return event.type === 'snapshotApplyRequested'
        ? apply(machine, event, operationState('ApplyingSnapshot', event))
        : reject(machine, 'unexpected-event');
    case 'ApplyingSnapshot':
      return event.type === 'snapshotAppliedForReview'
        ? apply(machine, event, operationState('PreparingReview', event))
        : reject(machine, 'unexpected-event');
    case 'PreparingReview':
      return event.type === 'reviewPrepared'
        ? apply(machine, event, operationState('CommittingReview', event))
        : reject(machine, 'unexpected-event');
    case 'CommittingReview':
      return event.type === 'reviewCommitted'
        ? apply(machine, event, operationState('Reviewing', event))
        : reject(machine, 'unexpected-event');
    case 'Reviewing':
      return reject(machine, 'unexpected-event');
    case 'Closing':
      return event.type === 'closeCompleted'
        ? apply(machine, event, {
            ...operationState('ApplyingRecovery', event),
            recoveryTarget: event.recoveryTarget,
          })
        : reject(machine, 'unexpected-event');
    case 'ApplyingRecovery':
      if (event.type !== 'recoveryApplied') return reject(machine, 'unexpected-event');
      return state.recoveryTarget === 'DraftAvailable'
        ? apply(machine, event, operationState('DraftAvailable', event))
        : apply(machine, event, {
            ...operationState('Editing', event),
            sessionEpoch: null,
          });
  }
}
