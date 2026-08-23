const SCENARIO_LIMITS = Object.freeze({
  driftCssPx: 2,
  cardGapCssPx: 8,
  connectorEndpointErrorCssPx: 2,
  initialRenderMs: 300,
  interactionMs: 50,
});

const STRESS_LIMITS = Object.freeze({
  sourceLines: 10_000,
  comments: 500,
  layoutMs: 300,
  geometryReadSlack: 5,
});

function finiteNumber(metrics, key, failures) {
  const value = metrics[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    failures.push(`${key} was not a finite number`);
    return undefined;
  }
  return value;
}

function expectMaximum(metrics, key, maximum, describeFailure, failures) {
  const value = finiteNumber(metrics, key, failures);
  if (value !== undefined && value > maximum) {
    failures.push(describeFailure(value, maximum));
  }
}

function expectZero(metrics, key, description, failures) {
  const value = finiteNumber(metrics, key, failures);
  if (value !== undefined && value !== 0) {
    failures.push(`${description} ${value} (expected 0)`);
  }
}

function expectZeroCssPixels(metrics, key, description, failures) {
  const value = finiteNumber(metrics, key, failures);
  if (value !== undefined && value !== 0) {
    failures.push(`${description} ${value} CSS px (expected 0)`);
  }
}

/** Evaluate the release gates for one real Electron theme/zoom scenario. */
export function evaluateAnnotationScenario(metrics) {
  const failures = [];

  expectMaximum(
    metrics,
    'maxTargetPinDriftCssPx',
    SCENARIO_LIMITS.driftCssPx,
    (value, maximum) => `target-to-pin drift was ${value} CSS px (maximum ${maximum})`,
    failures
  );
  expectMaximum(
    metrics,
    'maxAsyncReflowDriftCssPx',
    SCENARIO_LIMITS.driftCssPx,
    (value, maximum) =>
      `target-to-pin drift after async reflow was ${value} CSS px (maximum ${maximum})`,
    failures
  );
  expectZeroCssPixels(
    metrics,
    'reviewActivationMaxElementShiftCssPx',
    'review activation shifted editor, prose, or target geometry by',
    failures
  );
  expectZeroCssPixels(
    metrics,
    'reviewActivationMaxTargetYShiftCssPx',
    'review activation shifted marker target Y by',
    failures
  );
  expectZeroCssPixels(
    metrics,
    'reviewActivationScrollTopShiftCssPx',
    'review activation changed scrollTop by',
    failures
  );
  expectZero(metrics, 'cardOverlapCount', 'card overlap count was', failures);

  const minimumCardGap = finiteNumber(metrics, 'minimumCardGapCssPx', failures);
  if (minimumCardGap !== undefined && minimumCardGap < SCENARIO_LIMITS.cardGapCssPx) {
    failures.push(
      `minimum card gap was ${minimumCardGap} CSS px (minimum ${SCENARIO_LIMITS.cardGapCssPx})`
    );
  }

  expectMaximum(
    metrics,
    'maxConnectorEndpointErrorCssPx',
    SCENARIO_LIMITS.connectorEndpointErrorCssPx,
    (value, maximum) => `connector endpoint error was ${value} CSS px (maximum ${maximum})`,
    failures
  );
  expectZero(metrics, 'panelScrollTop', 'card layer scrollTop was', failures);
  if (metrics.panelOverflowY !== 'visible') {
    failures.push(`card layer overflow-y was ${String(metrics.panelOverflowY)} (expected visible)`);
  }
  expectMaximum(
    metrics,
    'horizontalOverflowCssPx',
    0,
    (value, maximum) => `horizontal overflow was ${value} CSS px (maximum ${maximum})`,
    failures
  );
  expectZero(metrics, 'deactivationArtifactCount', 'deactivation left artifact count', failures);
  expectMaximum(
    metrics,
    'initialRenderMs',
    SCENARIO_LIMITS.initialRenderMs,
    (value, maximum) => `200-comment initial render took ${value} ms (maximum ${maximum})`,
    failures
  );
  expectMaximum(
    metrics,
    'interactionMs',
    SCENARIO_LIMITS.interactionMs,
    (value, maximum) => `compact/active interaction took ${value} ms (maximum ${maximum})`,
    failures
  );
  expectZero(metrics, 'scrollLayoutPassDelta', 'scroll triggered layout pass count', failures);
  const scrollGeometryReads = finiteNumber(metrics, 'scrollGeometryReadDelta', failures);
  if (scrollGeometryReads !== undefined && scrollGeometryReads !== 0) {
    failures.push(
      `scroll triggered ${scrollGeometryReads} annotation geometry read(s) (expected 0)`
    );
  }
  expectZero(
    metrics,
    'scrollScheduledFrameDelta',
    'scroll scheduled annotation frame count',
    failures
  );
  expectZero(metrics, 'scrollLongTaskDelta', 'scroll produced long task count', failures);
  expectZero(
    metrics,
    'scrollListenerRegistrations',
    'annotation setup registered scroll listener count',
    failures
  );

  const expectedPlacements = finiteNumber(metrics, 'expectedCardPlacementCount', failures);
  const cardPlacements = finiteNumber(metrics, 'cardPlacementCount', failures);
  if (
    expectedPlacements !== undefined &&
    cardPlacements !== undefined &&
    cardPlacements !== expectedPlacements
  ) {
    failures.push(
      `layout produced ${cardPlacements} card placements (expected ${expectedPlacements})`
    );
  }
  const activePlacements = finiteNumber(metrics, 'activeCardPlacementCount', failures);
  if (activePlacements !== undefined && activePlacements !== 1) {
    failures.push(`layout produced ${activePlacements} active card placements (expected 1)`);
  }
  const hiddenConnectors = finiteNumber(metrics, 'hiddenCardConnectorCount', failures);
  if (hiddenConnectors !== undefined && hiddenConnectors !== 0) {
    failures.push(`hidden cards produced ${hiddenConnectors} connector(s) (expected 0)`);
  }
  const phantomEofOverflow = finiteNumber(metrics, 'phantomEofOverflowCssPx', failures);
  if (phantomEofOverflow !== undefined && phantomEofOverflow !== 0) {
    failures.push(
      `hidden cards produced ${phantomEofOverflow} CSS px of EOF overflow (expected 0)`
    );
  }
  const composerPlacements = finiteNumber(metrics, 'composerSavedPlacementCount', failures);
  if (composerPlacements !== undefined && composerPlacements !== 0) {
    failures.push(
      `composer-only layout retained ${composerPlacements} saved-card placement(s) (expected 0)`
    );
  }
  const composerConnectors = finiteNumber(metrics, 'composerConnectorCount', failures);
  if (composerConnectors !== undefined && composerConnectors !== 0) {
    failures.push(`composer-only layout retained ${composerConnectors} connector(s) (expected 0)`);
  }
  const composerSpacer = finiteNumber(metrics, 'composerSpacerCssPx', failures);
  if (composerSpacer !== undefined && composerSpacer !== 0) {
    failures.push(
      `composer-only layout produced ${composerSpacer} CSS px of phantom spacer (expected 0)`
    );
  }

  return { passed: failures.length === 0, failures };
}

/** Evaluate the non-screenshot 10,000-line, 500-comment stress gates. */
export function evaluateAnnotationStress(metrics) {
  const failures = [];
  const sourceLines = finiteNumber(metrics, 'sourceLines', failures);
  const comments = finiteNumber(metrics, 'comments', failures);

  if (sourceLines !== undefined && sourceLines < STRESS_LIMITS.sourceLines) {
    failures.push(
      `stress document contained ${sourceLines} source lines (minimum ${STRESS_LIMITS.sourceLines})`
    );
  }
  if (comments !== undefined && comments < STRESS_LIMITS.comments) {
    failures.push(`stress run contained ${comments} comments (minimum ${STRESS_LIMITS.comments})`);
  }

  const measuredTargets = finiteNumber(metrics, 'measuredTargets', failures);
  if (measuredTargets !== undefined && comments !== undefined && measuredTargets > comments) {
    failures.push(
      `measured ${measuredTargets} targets for ${comments} comments (expected at most ${comments})`
    );
  }

  const measuredCards = finiteNumber(metrics, 'measuredCards', failures);
  if (measuredCards !== undefined && comments !== undefined && measuredCards > comments) {
    failures.push(
      `measured ${measuredCards} cards for ${comments} comments (expected at most ${comments})`
    );
  }

  const geometryReads = finiteNumber(metrics, 'geometryReads', failures);
  if (geometryReads !== undefined && comments !== undefined) {
    const maximum = comments * 2 + STRESS_LIMITS.geometryReadSlack;
    if (geometryReads > maximum) {
      failures.push(
        `performed ${geometryReads} geometry reads for ${comments} comments (maximum ${maximum})`
      );
    }
  }

  if (metrics.finalTargetReachable !== true) {
    failures.push('final feedback target was not reachable after layout');
  }
  expectMaximum(
    metrics,
    'layoutMs',
    STRESS_LIMITS.layoutMs,
    (value, maximum) => `500-comment stress layout took ${value} ms (maximum ${maximum})`,
    failures
  );

  return { passed: failures.length === 0, failures };
}

/** Evaluate a browser run that mounts the production Feedback controller. */
export function evaluateRealControllerScenario(metrics) {
  const failures = [];
  expectMaximum(
    metrics,
    'maxScrollDriftCssPx',
    SCENARIO_LIMITS.driftCssPx,
    (value, maximum) =>
      `real controller target-to-pin scroll drift was ${value} CSS px (maximum ${maximum})`,
    failures
  );

  const visibleCards = finiteNumber(metrics, 'visibleCardCount', failures);
  if (visibleCards !== undefined && visibleCards !== 1) {
    failures.push(`real controller showed ${visibleCards} cards in narrow mode (expected 1)`);
  }
  const activeCards = finiteNumber(metrics, 'activeCardCount', failures);
  if (activeCards !== undefined && activeCards !== 1) {
    failures.push(`real controller showed ${activeCards} active cards in narrow mode (expected 1)`);
  }
  const connectors = finiteNumber(metrics, 'connectorCount', failures);
  if (connectors !== undefined && connectors !== 0) {
    failures.push(
      `real controller rendered ${connectors} connector(s) for hidden narrow cards (expected 0)`
    );
  }
  const eofSpacer = finiteNumber(metrics, 'eofSpacerCssPx', failures);
  if (eofSpacer !== undefined && eofSpacer !== 0) {
    failures.push(
      `real controller produced ${eofSpacer} CSS px of phantom EOF spacer (expected 0)`
    );
  }
  if (metrics.markerFocusMoved !== true) {
    failures.push('real controller marker roving focus did not move');
  }
  if (metrics.hiddenHighContrastTargetSuppressed !== true) {
    failures.push('real controller hidden high-contrast target remained visible');
  }
  const teardownArtifacts = finiteNumber(metrics, 'teardownArtifactCount', failures);
  if (teardownArtifacts !== undefined && teardownArtifacts !== 0) {
    failures.push(`real controller teardown left ${teardownArtifacts} artifact(s) (expected 0)`);
  }

  return { passed: failures.length === 0, failures };
}

export const annotationFixtureLimits = Object.freeze({
  scenario: SCENARIO_LIMITS,
  stress: STRESS_LIMITS,
});
