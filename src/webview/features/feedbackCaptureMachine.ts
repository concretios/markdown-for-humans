/**
 * Pure lifecycle reducer for Feedback area capture.
 *
 * The DOM adapter owns listeners, pointer-capture APIs, and AbortControllers.
 * This module owns the state and emits idempotent effects for that adapter.
 *
 * The 'Submitting' state and its submissionStarted/submissionSucceeded/
 * submissionFailed events are specified here but not yet dispatched from
 * production: the real screenshot-submission call in
 * feedbackCaptureWorkflow.ts's onAdd handler bypasses this machine entirely,
 * so a hanging save can't currently be cancelled via these primitives.
 * Wiring that up is a tracked, deliberately deferred follow-up, not an
 * oversight.
 */

export interface FeedbackCapturePoint {
  readonly x: number;
  readonly y: number;
}

export interface FeedbackCaptureViewport {
  readonly generation: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface FeedbackCaptureRectangle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface FeedbackCaptureSelection {
  readonly start: FeedbackCapturePoint;
  readonly end: FeedbackCapturePoint;
  readonly rectangle: FeedbackCaptureRectangle;
}

interface IdleCaptureState {
  readonly kind: 'Idle';
}

interface ArmedCaptureState {
  readonly kind: 'Armed';
  readonly viewport: FeedbackCaptureViewport;
  readonly selection: FeedbackCaptureSelection | null;
  readonly errorCode: string | null;
}

interface DraggingCaptureState {
  readonly kind: 'Dragging';
  readonly viewport: FeedbackCaptureViewport;
  readonly pointerId: number;
  readonly start: FeedbackCapturePoint;
  readonly current: FeedbackCapturePoint;
}

interface RasterizingCaptureState {
  readonly kind: 'Rasterizing';
  readonly viewport: FeedbackCaptureViewport;
  readonly selection: FeedbackCaptureSelection;
  readonly captureId: string;
}

interface AnnotatingCaptureState {
  readonly kind: 'Annotating';
  readonly viewport: FeedbackCaptureViewport;
  readonly selection: FeedbackCaptureSelection;
  readonly captureId: string;
  readonly errorCode: string | null;
}

interface SubmittingCaptureState {
  readonly kind: 'Submitting';
  readonly viewport: FeedbackCaptureViewport;
  readonly selection: FeedbackCaptureSelection;
  readonly captureId: string;
  readonly submissionId: string;
}

interface DisposedCaptureState {
  readonly kind: 'Disposed';
}

export type FeedbackCaptureState =
  | IdleCaptureState
  | ArmedCaptureState
  | DraggingCaptureState
  | RasterizingCaptureState
  | AnnotatingCaptureState
  | SubmittingCaptureState
  | DisposedCaptureState;

export interface FeedbackCaptureMachine {
  readonly state: FeedbackCaptureState;
}

export type FeedbackCaptureEvent =
  | { readonly type: 'armed'; readonly viewport: FeedbackCaptureViewport }
  | { readonly type: 'viewportMeasured'; readonly viewport: FeedbackCaptureViewport }
  | {
      readonly type: 'pointerDown' | 'pointerMove' | 'pointerUp';
      readonly pointerId: number;
      readonly viewportGeneration: number;
      readonly point: FeedbackCapturePoint;
    }
  | { readonly type: 'pointerCancelled' | 'pointerCaptureLost'; readonly pointerId: number }
  | { readonly type: 'windowBlurred' }
  | { readonly type: 'visibilityLost' }
  | { readonly type: 'escapePressed' }
  | { readonly type: 'cancelRequested' }
  | {
      readonly type: 'rasterStarted';
      readonly captureId: string;
      readonly viewportGeneration: number;
    }
  | { readonly type: 'rasterSucceeded'; readonly captureId: string }
  | { readonly type: 'rasterFailed'; readonly captureId: string; readonly errorCode: string }
  | {
      readonly type: 'phaseAborted';
      readonly phase: 'raster' | 'submission';
      readonly phaseId: string;
    }
  | { readonly type: 'submissionStarted'; readonly submissionId: string }
  | { readonly type: 'submissionSucceeded'; readonly submissionId: string }
  | { readonly type: 'submissionFailed'; readonly submissionId: string; readonly errorCode: string }
  | { readonly type: 'disposed' };

export type FeedbackCaptureCleanupReason =
  | 'pointer-cancelled'
  | 'pointer-capture-lost'
  | 'window-blur'
  | 'visibility-loss'
  | 'escape'
  | 'cancel-requested'
  | 'submitted'
  | 'disposed';

export type FeedbackCaptureEffect =
  | { readonly type: 'setPointerCapture'; readonly pointerId: number }
  | { readonly type: 'releasePointerCapture'; readonly pointerId: number }
  | {
      readonly type: 'abortPhase';
      readonly phase: 'raster' | 'submission';
      readonly phaseId: string;
    }
  | { readonly type: 'cleanup'; readonly reason: FeedbackCaptureCleanupReason };

export type FeedbackCaptureIgnoreReason =
  | 'disposed'
  | 'invalid-viewport'
  | 'invalid-pointer'
  | 'invalid-phase-id'
  | 'generation-conflict'
  | 'stale-viewport-generation'
  | 'pointer-owned'
  | 'wrong-pointer'
  | 'no-selection'
  | 'wrong-phase';

export type FeedbackCaptureReduction =
  | {
      readonly disposition: 'applied' | 'duplicate';
      readonly machine: FeedbackCaptureMachine;
      readonly effects: readonly FeedbackCaptureEffect[];
    }
  | {
      readonly disposition: 'ignored';
      readonly reason: FeedbackCaptureIgnoreReason;
      readonly machine: FeedbackCaptureMachine;
      readonly effects: readonly FeedbackCaptureEffect[];
    };

/** Creates an inactive, reusable capture lifecycle. */
export function createFeedbackCaptureMachine(): FeedbackCaptureMachine {
  return { state: { kind: 'Idle' } };
}

function apply(
  state: FeedbackCaptureState,
  effects: readonly FeedbackCaptureEffect[] = []
): FeedbackCaptureReduction {
  return { disposition: 'applied', machine: { state }, effects };
}

function duplicate(machine: FeedbackCaptureMachine): FeedbackCaptureReduction {
  return { disposition: 'duplicate', machine, effects: [] };
}

function ignore(
  machine: FeedbackCaptureMachine,
  reason: FeedbackCaptureIgnoreReason
): FeedbackCaptureReduction {
  return { disposition: 'ignored', reason, machine, effects: [] };
}

function validViewport(viewport: FeedbackCaptureViewport): boolean {
  return (
    Number.isInteger(viewport.generation) &&
    viewport.generation >= 1 &&
    Number.isFinite(viewport.left) &&
    Number.isFinite(viewport.top) &&
    Number.isFinite(viewport.width) &&
    Number.isFinite(viewport.height) &&
    viewport.width > 0 &&
    viewport.height > 0
  );
}

function sameViewport(left: FeedbackCaptureViewport, right: FeedbackCaptureViewport): boolean {
  return (
    left.generation === right.generation &&
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  );
}

function validPointer(pointerId: number, point: FeedbackCapturePoint): boolean {
  return (
    Number.isInteger(pointerId) &&
    pointerId >= 0 &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  );
}

function validPhaseId(phaseId: string): boolean {
  return phaseId.length > 0;
}

function clampPoint(
  point: FeedbackCapturePoint,
  viewport: FeedbackCaptureViewport
): FeedbackCapturePoint {
  return {
    x: Math.min(viewport.left + viewport.width, Math.max(viewport.left, point.x)),
    y: Math.min(viewport.top + viewport.height, Math.max(viewport.top, point.y)),
  };
}

function selectionBetween(
  start: FeedbackCapturePoint,
  end: FeedbackCapturePoint
): FeedbackCaptureSelection {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return {
    start,
    end,
    rectangle: {
      left,
      top,
      width: Math.max(start.x, end.x) - left,
      height: Math.max(start.y, end.y) - top,
    },
  };
}

function pointEquals(left: FeedbackCapturePoint, right: FeedbackCapturePoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function activeCleanupEffects(
  state: Exclude<FeedbackCaptureState, IdleCaptureState | DisposedCaptureState>,
  reason: FeedbackCaptureCleanupReason
): readonly FeedbackCaptureEffect[] {
  const effects: FeedbackCaptureEffect[] = [];
  if (state.kind === 'Dragging') {
    effects.push({ type: 'releasePointerCapture', pointerId: state.pointerId });
  } else if (state.kind === 'Rasterizing') {
    effects.push({ type: 'abortPhase', phase: 'raster', phaseId: state.captureId });
  } else if (state.kind === 'Submitting') {
    effects.push({ type: 'abortPhase', phase: 'submission', phaseId: state.submissionId });
  }
  effects.push({ type: 'cleanup', reason });
  return effects;
}

function terminateActive(
  machine: FeedbackCaptureMachine,
  reason: FeedbackCaptureCleanupReason,
  disposed: boolean
): FeedbackCaptureReduction {
  const { state } = machine;
  if (state.kind === 'Idle') {
    return disposed ? apply({ kind: 'Disposed' }) : duplicate(machine);
  }
  if (state.kind === 'Disposed') return duplicate(machine);
  return apply(
    disposed ? { kind: 'Disposed' } : { kind: 'Idle' },
    activeCleanupEffects(state, reason)
  );
}

function interruptionReason(event: FeedbackCaptureEvent): FeedbackCaptureCleanupReason | null {
  switch (event.type) {
    case 'windowBlurred':
      return 'window-blur';
    case 'visibilityLost':
      return 'visibility-loss';
    case 'escapePressed':
      return 'escape';
    case 'cancelRequested':
      return 'cancel-requested';
    default:
      return null;
  }
}

function updateViewport(
  machine: FeedbackCaptureMachine,
  viewport: FeedbackCaptureViewport
): FeedbackCaptureReduction {
  if (!validViewport(viewport)) return ignore(machine, 'invalid-viewport');
  const { state } = machine;
  if (state.kind !== 'Armed' && state.kind !== 'Dragging') {
    return ignore(machine, 'wrong-phase');
  }
  if (viewport.generation < state.viewport.generation) {
    return ignore(machine, 'stale-viewport-generation');
  }
  if (viewport.generation === state.viewport.generation) {
    return sameViewport(viewport, state.viewport)
      ? duplicate(machine)
      : ignore(machine, 'generation-conflict');
  }
  if (state.kind === 'Dragging') {
    return apply(
      {
        kind: 'Armed',
        viewport,
        selection: null,
        errorCode: 'viewport-changed',
      },
      [{ type: 'releasePointerCapture', pointerId: state.pointerId }]
    );
  }
  return apply({ kind: 'Armed', viewport, selection: null, errorCode: null });
}

function reducePointerEvent(
  machine: FeedbackCaptureMachine,
  event: Extract<FeedbackCaptureEvent, { type: 'pointerDown' | 'pointerMove' | 'pointerUp' }>
): FeedbackCaptureReduction {
  const { state } = machine;
  if (!validPointer(event.pointerId, event.point)) return ignore(machine, 'invalid-pointer');

  if (event.type === 'pointerDown') {
    if (state.kind === 'Dragging') {
      return event.pointerId === state.pointerId
        ? duplicate(machine)
        : ignore(machine, 'pointer-owned');
    }
    if (state.kind !== 'Armed') return ignore(machine, 'wrong-phase');
    if (event.viewportGeneration !== state.viewport.generation) {
      return ignore(machine, 'stale-viewport-generation');
    }
    const point = clampPoint(event.point, state.viewport);
    return apply(
      {
        kind: 'Dragging',
        viewport: state.viewport,
        pointerId: event.pointerId,
        start: point,
        current: point,
      },
      [{ type: 'setPointerCapture', pointerId: event.pointerId }]
    );
  }

  if (state.kind !== 'Dragging') return ignore(machine, 'wrong-phase');
  if (event.pointerId !== state.pointerId) return ignore(machine, 'wrong-pointer');
  if (event.viewportGeneration !== state.viewport.generation) {
    return apply(
      {
        kind: 'Armed',
        viewport: state.viewport,
        selection: null,
        errorCode: 'stale-viewport',
      },
      [{ type: 'releasePointerCapture', pointerId: state.pointerId }]
    );
  }

  const point = clampPoint(event.point, state.viewport);
  if (event.type === 'pointerMove') {
    return pointEquals(point, state.current)
      ? duplicate(machine)
      : apply({ ...state, current: point });
  }
  return apply(
    {
      kind: 'Armed',
      viewport: state.viewport,
      selection: selectionBetween(state.start, point),
      errorCode: null,
    },
    [{ type: 'releasePointerCapture', pointerId: state.pointerId }]
  );
}

function reduceRasterEvent(
  machine: FeedbackCaptureMachine,
  event: Extract<
    FeedbackCaptureEvent,
    { type: 'rasterStarted' | 'rasterSucceeded' | 'rasterFailed' }
  >
): FeedbackCaptureReduction {
  const { state } = machine;
  if (!validPhaseId(event.captureId)) return ignore(machine, 'invalid-phase-id');

  if (event.type === 'rasterStarted') {
    if (state.kind === 'Rasterizing') {
      return state.captureId === event.captureId &&
        state.viewport.generation === event.viewportGeneration
        ? duplicate(machine)
        : ignore(machine, 'wrong-phase');
    }
    if (state.kind !== 'Armed') return ignore(machine, 'wrong-phase');
    if (!state.selection) return ignore(machine, 'no-selection');
    if (event.viewportGeneration !== state.viewport.generation) {
      return ignore(machine, 'stale-viewport-generation');
    }
    return apply({
      kind: 'Rasterizing',
      viewport: state.viewport,
      selection: state.selection,
      captureId: event.captureId,
    });
  }

  if (event.type === 'rasterSucceeded') {
    if (state.kind === 'Annotating' && state.captureId === event.captureId) {
      return duplicate(machine);
    }
    if (state.kind !== 'Rasterizing' || state.captureId !== event.captureId) {
      return ignore(machine, 'wrong-phase');
    }
    return apply({
      kind: 'Annotating',
      viewport: state.viewport,
      selection: state.selection,
      captureId: state.captureId,
      errorCode: null,
    });
  }

  if (state.kind !== 'Rasterizing' || state.captureId !== event.captureId) {
    return ignore(machine, 'wrong-phase');
  }
  return apply({
    kind: 'Armed',
    viewport: state.viewport,
    selection: state.selection,
    errorCode: event.errorCode.length > 0 ? event.errorCode : 'raster-failed',
  });
}

function reduceSubmissionEvent(
  machine: FeedbackCaptureMachine,
  event: Extract<
    FeedbackCaptureEvent,
    { type: 'submissionStarted' | 'submissionSucceeded' | 'submissionFailed' }
  >
): FeedbackCaptureReduction {
  const { state } = machine;
  if (!validPhaseId(event.submissionId)) return ignore(machine, 'invalid-phase-id');

  if (event.type === 'submissionStarted') {
    if (state.kind === 'Submitting') {
      return state.submissionId === event.submissionId
        ? duplicate(machine)
        : ignore(machine, 'wrong-phase');
    }
    if (state.kind !== 'Annotating') return ignore(machine, 'wrong-phase');
    return apply({
      kind: 'Submitting',
      viewport: state.viewport,
      selection: state.selection,
      captureId: state.captureId,
      submissionId: event.submissionId,
    });
  }

  if (state.kind !== 'Submitting' || state.submissionId !== event.submissionId) {
    return state.kind === 'Idle' && event.type === 'submissionSucceeded'
      ? duplicate(machine)
      : ignore(machine, 'wrong-phase');
  }
  if (event.type === 'submissionSucceeded') {
    return apply({ kind: 'Idle' }, [{ type: 'cleanup', reason: 'submitted' }]);
  }
  return apply({
    kind: 'Annotating',
    viewport: state.viewport,
    selection: state.selection,
    captureId: state.captureId,
    errorCode: event.errorCode.length > 0 ? event.errorCode : 'submission-failed',
  });
}

function reducePhaseAbort(
  machine: FeedbackCaptureMachine,
  event: Extract<FeedbackCaptureEvent, { type: 'phaseAborted' }>
): FeedbackCaptureReduction {
  if (!validPhaseId(event.phaseId)) return ignore(machine, 'invalid-phase-id');
  const { state } = machine;
  if (
    event.phase === 'raster' &&
    state.kind === 'Rasterizing' &&
    state.captureId === event.phaseId
  ) {
    return apply({
      kind: 'Armed',
      viewport: state.viewport,
      selection: state.selection,
      errorCode: 'raster-aborted',
    });
  }
  if (
    event.phase === 'submission' &&
    state.kind === 'Submitting' &&
    state.submissionId === event.phaseId
  ) {
    return apply({
      kind: 'Annotating',
      viewport: state.viewport,
      selection: state.selection,
      captureId: state.captureId,
      errorCode: 'submission-aborted',
    });
  }
  return ignore(machine, 'wrong-phase');
}

/** Reduces one capture event without touching DOM or async resources. */
export function reduceFeedbackCapture(
  machine: FeedbackCaptureMachine,
  event: FeedbackCaptureEvent
): FeedbackCaptureReduction {
  if (machine.state.kind === 'Disposed') {
    return event.type === 'disposed' ? duplicate(machine) : ignore(machine, 'disposed');
  }

  if (event.type === 'disposed') return terminateActive(machine, 'disposed', true);

  const interruption = interruptionReason(event);
  if (interruption) return terminateActive(machine, interruption, false);

  if (event.type === 'pointerCancelled' || event.type === 'pointerCaptureLost') {
    if (machine.state.kind === 'Idle') return duplicate(machine);
    if (machine.state.kind !== 'Dragging') return ignore(machine, 'wrong-phase');
    if (event.pointerId !== machine.state.pointerId) return ignore(machine, 'wrong-pointer');
    return terminateActive(
      machine,
      event.type === 'pointerCancelled' ? 'pointer-cancelled' : 'pointer-capture-lost',
      false
    );
  }

  if (event.type === 'armed') {
    if (!validViewport(event.viewport)) return ignore(machine, 'invalid-viewport');
    if (machine.state.kind === 'Idle') {
      return apply({
        kind: 'Armed',
        viewport: event.viewport,
        selection: null,
        errorCode: null,
      });
    }
    return machine.state.kind === 'Armed' && sameViewport(machine.state.viewport, event.viewport)
      ? duplicate(machine)
      : ignore(machine, 'wrong-phase');
  }

  if (event.type === 'viewportMeasured') return updateViewport(machine, event.viewport);
  if (event.type === 'pointerDown' || event.type === 'pointerMove' || event.type === 'pointerUp') {
    return reducePointerEvent(machine, event);
  }
  if (
    event.type === 'rasterStarted' ||
    event.type === 'rasterSucceeded' ||
    event.type === 'rasterFailed'
  ) {
    return reduceRasterEvent(machine, event);
  }
  if (event.type === 'phaseAborted') return reducePhaseAbort(machine, event);
  if (
    event.type === 'submissionStarted' ||
    event.type === 'submissionSucceeded' ||
    event.type === 'submissionFailed'
  ) {
    return reduceSubmissionEvent(machine, event);
  }
  return ignore(machine, 'wrong-phase');
}
