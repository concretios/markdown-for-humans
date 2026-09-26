import {
  createFeedbackCaptureMachine,
  reduceFeedbackCapture,
  type FeedbackCaptureEvent,
  type FeedbackCaptureMachine,
  type FeedbackCaptureViewport,
} from '../../webview/features/feedbackCaptureMachine';

const VIEWPORT: FeedbackCaptureViewport = {
  generation: 7,
  left: 100,
  top: 200,
  width: 500,
  height: 300,
};

function apply(
  machine: FeedbackCaptureMachine,
  event: FeedbackCaptureEvent
): FeedbackCaptureMachine {
  const result = reduceFeedbackCapture(machine, event);
  if (result.disposition !== 'applied') {
    throw new Error(`Expected ${event.type} to apply, got ${result.disposition}`);
  }
  return result.machine;
}

function armedMachine(viewport = VIEWPORT): FeedbackCaptureMachine {
  return apply(createFeedbackCaptureMachine(), { type: 'armed', viewport });
}

function draggingMachine(pointerId = 11): FeedbackCaptureMachine {
  return apply(armedMachine(), {
    type: 'pointerDown',
    pointerId,
    viewportGeneration: VIEWPORT.generation,
    point: { x: 140, y: 230 },
  });
}

function readyToRasterMachine(): FeedbackCaptureMachine {
  let machine = draggingMachine();
  machine = apply(machine, {
    type: 'pointerUp',
    pointerId: 11,
    viewportGeneration: VIEWPORT.generation,
    point: { x: 440, y: 410 },
  });
  return machine;
}

function rasterizingMachine(captureId = 'capture-1'): FeedbackCaptureMachine {
  return apply(readyToRasterMachine(), {
    type: 'rasterStarted',
    captureId,
    viewportGeneration: VIEWPORT.generation,
  });
}

describe('Feedback capture lifecycle machine', () => {
  it.each([
    { label: 'outside the top-left margin', point: { x: 75, y: 175 }, clamped: { x: 100, y: 200 } },
    { label: 'on the top-left edge', point: { x: 100, y: 200 }, clamped: { x: 100, y: 200 } },
    {
      label: 'outside the bottom-right margin',
      point: { x: 650, y: 540 },
      clamped: { x: 600, y: 500 },
    },
  ])('accepts and clamps a pointer start $label', ({ point, clamped }) => {
    const machine = armedMachine();

    const result = reduceFeedbackCapture(machine, {
      type: 'pointerDown',
      pointerId: 21,
      viewportGeneration: VIEWPORT.generation,
      point,
    });

    expect(result.disposition).toBe('applied');
    expect(result.machine.state).toMatchObject({
      kind: 'Dragging',
      pointerId: 21,
      start: clamped,
      current: clamped,
    });
    expect(result.effects).toEqual([{ type: 'setPointerCapture', pointerId: 21 }]);
  });

  it('gives one pointer exclusive ownership until its terminal event', () => {
    const machine = draggingMachine(31);

    const secondPointer = reduceFeedbackCapture(machine, {
      type: 'pointerDown',
      pointerId: 32,
      viewportGeneration: VIEWPORT.generation,
      point: { x: 300, y: 300 },
    });
    const wrongMove = reduceFeedbackCapture(machine, {
      type: 'pointerMove',
      pointerId: 32,
      viewportGeneration: VIEWPORT.generation,
      point: { x: 350, y: 350 },
    });

    expect(secondPointer).toMatchObject({ disposition: 'ignored', reason: 'pointer-owned' });
    expect(wrongMove).toMatchObject({ disposition: 'ignored', reason: 'wrong-pointer' });
    expect(secondPointer.machine).toBe(machine);
    expect(wrongMove.machine).toBe(machine);
    expect(secondPointer.effects).toEqual([]);
    expect(wrongMove.effects).toEqual([]);
  });

  it('releases only the owning pointer on pointerup and records a clamped selection', () => {
    const machine = draggingMachine(41);
    const wrongPointer = reduceFeedbackCapture(machine, {
      type: 'pointerUp',
      pointerId: 42,
      viewportGeneration: VIEWPORT.generation,
      point: { x: 450, y: 450 },
    });
    expect(wrongPointer).toMatchObject({ disposition: 'ignored', reason: 'wrong-pointer' });
    expect(wrongPointer.machine).toBe(machine);

    const result = reduceFeedbackCapture(machine, {
      type: 'pointerUp',
      pointerId: 41,
      viewportGeneration: VIEWPORT.generation,
      point: { x: 900, y: 800 },
    });

    expect(result.machine.state).toMatchObject({
      kind: 'Armed',
      selection: {
        start: { x: 140, y: 230 },
        end: { x: 600, y: 500 },
        rectangle: { left: 140, top: 230, width: 460, height: 270 },
      },
    });
    expect(result.effects).toEqual([{ type: 'releasePointerCapture', pointerId: 41 }]);
  });

  it.each<{
    label: string;
    event: FeedbackCaptureEvent;
    cleanupReason: string;
  }>([
    {
      label: 'pointercancel',
      event: { type: 'pointerCancelled', pointerId: 51 },
      cleanupReason: 'pointer-cancelled',
    },
    {
      label: 'lostpointercapture',
      event: { type: 'pointerCaptureLost', pointerId: 51 },
      cleanupReason: 'pointer-capture-lost',
    },
    {
      label: 'window blur',
      event: { type: 'windowBlurred' },
      cleanupReason: 'window-blur',
    },
    {
      label: 'visibility loss',
      event: { type: 'visibilityLost' },
      cleanupReason: 'visibility-loss',
    },
    {
      label: 'Escape',
      event: { type: 'escapePressed' },
      cleanupReason: 'escape',
    },
  ])('terminates and cleans an owned drag on $label', ({ event, cleanupReason }) => {
    const machine = draggingMachine(51);

    const result = reduceFeedbackCapture(machine, event);

    expect(result.disposition).toBe('applied');
    expect(result.machine.state.kind).toBe('Idle');
    expect(result.effects).toEqual([
      { type: 'releasePointerCapture', pointerId: 51 },
      { type: 'cleanup', reason: cleanupReason },
    ]);

    const duplicate = reduceFeedbackCapture(result.machine, event);
    expect(duplicate.disposition).toBe('duplicate');
    expect(duplicate.machine).toBe(result.machine);
    expect(duplicate.effects).toEqual([]);
  });

  it('ignores pointercancel and lostpointercapture from a non-owner', () => {
    const machine = draggingMachine(61);

    for (const event of [
      { type: 'pointerCancelled', pointerId: 62 },
      { type: 'pointerCaptureLost', pointerId: 62 },
    ] as const) {
      const result = reduceFeedbackCapture(machine, event);
      expect(result).toMatchObject({ disposition: 'ignored', reason: 'wrong-pointer' });
      expect(result.machine).toBe(machine);
      expect(result.effects).toEqual([]);
    }
  });

  it('releases a drag when a newer viewport arrives and rejects stale raster starts', () => {
    const dragging = draggingMachine(71);
    const viewportChanged = reduceFeedbackCapture(dragging, {
      type: 'viewportMeasured',
      viewport: { ...VIEWPORT, generation: 8, left: 120 },
    });

    expect(viewportChanged.machine.state).toMatchObject({
      kind: 'Armed',
      viewport: { generation: 8, left: 120 },
      errorCode: 'viewport-changed',
      selection: null,
    });
    expect(viewportChanged.effects).toEqual([{ type: 'releasePointerCapture', pointerId: 71 }]);

    const ready = readyToRasterMachine();
    const stale = reduceFeedbackCapture(ready, {
      type: 'rasterStarted',
      captureId: 'capture-stale',
      viewportGeneration: VIEWPORT.generation - 1,
    });
    expect(stale).toMatchObject({
      disposition: 'ignored',
      reason: 'stale-viewport-generation',
    });
    expect(stale.machine).toBe(ready);
    expect(stale.effects).toEqual([]);
  });

  it('starts rasterization once and accepts only the matching success', () => {
    const ready = readyToRasterMachine();
    const started = reduceFeedbackCapture(ready, {
      type: 'rasterStarted',
      captureId: 'capture-success',
      viewportGeneration: VIEWPORT.generation,
    });

    expect(started.machine.state).toMatchObject({
      kind: 'Rasterizing',
      captureId: 'capture-success',
    });
    const duplicateStart = reduceFeedbackCapture(started.machine, {
      type: 'rasterStarted',
      captureId: 'capture-success',
      viewportGeneration: VIEWPORT.generation,
    });
    expect(duplicateStart.disposition).toBe('duplicate');

    const staleSuccess = reduceFeedbackCapture(started.machine, {
      type: 'rasterSucceeded',
      captureId: 'capture-old',
    });
    expect(staleSuccess).toMatchObject({ disposition: 'ignored', reason: 'wrong-phase' });

    const success = reduceFeedbackCapture(started.machine, {
      type: 'rasterSucceeded',
      captureId: 'capture-success',
    });
    expect(success.machine.state).toMatchObject({
      kind: 'Annotating',
      captureId: 'capture-success',
      errorCode: null,
    });
  });

  it('returns a failed raster to the armed selection for an explicit retry', () => {
    const machine = rasterizingMachine('capture-failure');

    const result = reduceFeedbackCapture(machine, {
      type: 'rasterFailed',
      captureId: 'capture-failure',
      errorCode: 'MD4H-FB-CAPTURE-RASTER',
    });

    expect(result.machine.state).toMatchObject({
      kind: 'Armed',
      errorCode: 'MD4H-FB-CAPTURE-RASTER',
      selection: {
        rectangle: { left: 140, top: 230, width: 300, height: 180 },
      },
    });
    expect(result.effects).toEqual([]);

    const retried = reduceFeedbackCapture(result.machine, {
      type: 'rasterStarted',
      captureId: 'capture-retry',
      viewportGeneration: VIEWPORT.generation,
    });
    expect(retried.machine.state).toMatchObject({
      kind: 'Rasterizing',
      captureId: 'capture-retry',
    });
  });

  it('handles phase aborts without accepting late phase results', () => {
    const rasterizing = rasterizingMachine('capture-abort');
    const rasterAborted = reduceFeedbackCapture(rasterizing, {
      type: 'phaseAborted',
      phase: 'raster',
      phaseId: 'capture-abort',
    });
    expect(rasterAborted.machine.state).toMatchObject({
      kind: 'Armed',
      errorCode: 'raster-aborted',
    });

    const lateSuccess = reduceFeedbackCapture(rasterAborted.machine, {
      type: 'rasterSucceeded',
      captureId: 'capture-abort',
    });
    expect(lateSuccess).toMatchObject({ disposition: 'ignored', reason: 'wrong-phase' });

    let submitting = apply(rasterizingMachine('capture-submit'), {
      type: 'rasterSucceeded',
      captureId: 'capture-submit',
    });
    submitting = apply(submitting, {
      type: 'submissionStarted',
      submissionId: 'submission-1',
    });
    const submissionAborted = reduceFeedbackCapture(submitting, {
      type: 'phaseAborted',
      phase: 'submission',
      phaseId: 'submission-1',
    });
    expect(submissionAborted.machine.state).toMatchObject({
      kind: 'Annotating',
      errorCode: 'submission-aborted',
    });
  });

  it('aborts the active asynchronous phase when capture is cancelled', () => {
    const rasterizing = rasterizingMachine('capture-cancel');

    const result = reduceFeedbackCapture(rasterizing, { type: 'cancelRequested' });

    expect(result.machine.state.kind).toBe('Idle');
    expect(result.effects).toEqual([
      { type: 'abortPhase', phase: 'raster', phaseId: 'capture-cancel' },
      { type: 'cleanup', reason: 'cancel-requested' },
    ]);
    const duplicate = reduceFeedbackCapture(result.machine, { type: 'cancelRequested' });
    expect(duplicate.disposition).toBe('duplicate');
    expect(duplicate.effects).toEqual([]);
  });

  it('completes annotation submission and cleans up exactly once', () => {
    let machine = apply(rasterizingMachine('capture-submit-success'), {
      type: 'rasterSucceeded',
      captureId: 'capture-submit-success',
    });
    machine = apply(machine, {
      type: 'submissionStarted',
      submissionId: 'submission-success',
    });

    const submitted = reduceFeedbackCapture(machine, {
      type: 'submissionSucceeded',
      submissionId: 'submission-success',
    });

    expect(submitted.machine.state.kind).toBe('Idle');
    expect(submitted.effects).toEqual([{ type: 'cleanup', reason: 'submitted' }]);
    const lateResult = reduceFeedbackCapture(submitted.machine, {
      type: 'submissionSucceeded',
      submissionId: 'submission-success',
    });
    expect(lateResult.disposition).toBe('duplicate');
    expect(lateResult.effects).toEqual([]);
  });

  it('disposes active work once, aborts its phase, and becomes terminal', () => {
    const rasterizing = rasterizingMachine('capture-dispose');

    const disposed = reduceFeedbackCapture(rasterizing, { type: 'disposed' });

    expect(disposed.machine.state.kind).toBe('Disposed');
    expect(disposed.effects).toEqual([
      { type: 'abortPhase', phase: 'raster', phaseId: 'capture-dispose' },
      { type: 'cleanup', reason: 'disposed' },
    ]);

    const duplicateDispose = reduceFeedbackCapture(disposed.machine, { type: 'disposed' });
    expect(duplicateDispose.disposition).toBe('duplicate');
    expect(duplicateDispose.effects).toEqual([]);

    const cannotRearm = reduceFeedbackCapture(disposed.machine, {
      type: 'armed',
      viewport: VIEWPORT,
    });
    expect(cannotRearm).toMatchObject({ disposition: 'ignored', reason: 'disposed' });
    expect(cannotRearm.machine).toBe(disposed.machine);
  });
});
