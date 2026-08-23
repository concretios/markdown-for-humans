import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateAnnotationScenario,
  evaluateAnnotationStress,
  evaluateRealControllerScenario,
} from './verification.mjs';

function passingScenario(overrides = {}) {
  return {
    maxTargetPinDriftCssPx: 1,
    maxAsyncReflowDriftCssPx: 1,
    reviewActivationMaxElementShiftCssPx: 0,
    reviewActivationMaxTargetYShiftCssPx: 0,
    reviewActivationScrollTopShiftCssPx: 0,
    cardOverlapCount: 0,
    minimumCardGapCssPx: 8,
    maxConnectorEndpointErrorCssPx: 1,
    panelScrollTop: 0,
    panelOverflowY: 'visible',
    horizontalOverflowCssPx: 0,
    deactivationArtifactCount: 0,
    initialRenderMs: 120,
    interactionMs: 20,
    scrollLayoutPassDelta: 0,
    scrollGeometryReadDelta: 0,
    scrollScheduledFrameDelta: 0,
    scrollLongTaskDelta: 0,
    scrollListenerRegistrations: 0,
    expectedCardPlacementCount: 200,
    cardPlacementCount: 200,
    activeCardPlacementCount: 1,
    hiddenCardConnectorCount: 0,
    phantomEofOverflowCssPx: 0,
    composerSavedPlacementCount: 0,
    composerConnectorCount: 0,
    composerSpacerCssPx: 0,
    ...overrides,
  };
}

test('annotation scenario accepts every release budget at its inclusive boundary', () => {
  const result = evaluateAnnotationScenario(
    passingScenario({
      maxTargetPinDriftCssPx: 2,
      maxAsyncReflowDriftCssPx: 2,
      minimumCardGapCssPx: 8,
      maxConnectorEndpointErrorCssPx: 2,
      initialRenderMs: 300,
      interactionMs: 50,
    })
  );

  assert.deepEqual(result, { passed: true, failures: [] });
});

test('annotation scenario reports each failed invariant with its observed value', () => {
  const result = evaluateAnnotationScenario(
    passingScenario({
      maxTargetPinDriftCssPx: 2.25,
      reviewActivationMaxElementShiftCssPx: 0.5,
      reviewActivationMaxTargetYShiftCssPx: 0.25,
      reviewActivationScrollTopShiftCssPx: 3,
      minimumCardGapCssPx: 7.5,
      panelOverflowY: 'auto',
      interactionMs: 50.1,
      scrollGeometryReadDelta: 1,
      cardPlacementCount: 199,
      activeCardPlacementCount: 0,
      hiddenCardConnectorCount: 2,
      phantomEofOverflowCssPx: 6,
      composerSavedPlacementCount: 1,
      composerConnectorCount: 1,
      composerSpacerCssPx: 12,
    })
  );

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [
    'target-to-pin drift was 2.25 CSS px (maximum 2)',
    'review activation shifted editor, prose, or target geometry by 0.5 CSS px (expected 0)',
    'review activation shifted marker target Y by 0.25 CSS px (expected 0)',
    'review activation changed scrollTop by 3 CSS px (expected 0)',
    'minimum card gap was 7.5 CSS px (minimum 8)',
    'card layer overflow-y was auto (expected visible)',
    'compact/active interaction took 50.1 ms (maximum 50)',
    'scroll triggered 1 annotation geometry read(s) (expected 0)',
    'layout produced 199 card placements (expected 200)',
    'layout produced 0 active card placements (expected 1)',
    'hidden cards produced 2 connector(s) (expected 0)',
    'hidden cards produced 6 CSS px of EOF overflow (expected 0)',
    'composer-only layout retained 1 saved-card placement(s) (expected 0)',
    'composer-only layout retained 1 connector(s) (expected 0)',
    'composer-only layout produced 12 CSS px of phantom spacer (expected 0)',
  ]);
});

test('annotation scenario rejects missing or non-finite measurements', () => {
  const metrics = passingScenario();
  delete metrics.maxTargetPinDriftCssPx;
  metrics.interactionMs = Number.NaN;

  const result = evaluateAnnotationScenario(metrics);

  assert.equal(result.passed, false);
  assert.match(result.failures[0], /maxTargetPinDriftCssPx was not a finite number/);
  assert.match(result.failures[1], /interactionMs was not a finite number/);
});

test('stress evaluator bounds geometry to annotated targets and cards', () => {
  const result = evaluateAnnotationStress({
    sourceLines: 10_000,
    comments: 500,
    measuredTargets: 500,
    measuredCards: 500,
    geometryReads: 1_001,
    finalTargetReachable: true,
    layoutMs: 80,
  });

  assert.deepEqual(result, { passed: true, failures: [] });
});

test('stress evaluator reports document traversal and reachability regressions', () => {
  const result = evaluateAnnotationStress({
    sourceLines: 10_000,
    comments: 500,
    measuredTargets: 10_000,
    measuredCards: 500,
    geometryReads: 10_501,
    finalTargetReachable: false,
    layoutMs: 301,
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [
    'measured 10000 targets for 500 comments (expected at most 500)',
    'performed 10501 geometry reads for 500 comments (maximum 1005)',
    'final feedback target was not reachable after layout',
    '500-comment stress layout took 301 ms (maximum 300)',
  ]);
});

test('real-controller evaluator accepts same-scroll, narrow, focus, hidden HC, and teardown', () => {
  const result = evaluateRealControllerScenario({
    maxScrollDriftCssPx: 1,
    visibleCardCount: 1,
    activeCardCount: 1,
    connectorCount: 0,
    eofSpacerCssPx: 0,
    markerFocusMoved: true,
    hiddenHighContrastTargetSuppressed: true,
    teardownArtifactCount: 0,
  });

  assert.deepEqual(result, { passed: true, failures: [] });
});

test('real-controller evaluator explains controller integration failures', () => {
  const result = evaluateRealControllerScenario({
    maxScrollDriftCssPx: 3,
    visibleCardCount: 2,
    activeCardCount: 0,
    connectorCount: 1,
    eofSpacerCssPx: 20,
    markerFocusMoved: false,
    hiddenHighContrastTargetSuppressed: false,
    teardownArtifactCount: 4,
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [
    'real controller target-to-pin scroll drift was 3 CSS px (maximum 2)',
    'real controller showed 2 cards in narrow mode (expected 1)',
    'real controller showed 0 active cards in narrow mode (expected 1)',
    'real controller rendered 1 connector(s) for hidden narrow cards (expected 0)',
    'real controller produced 20 CSS px of phantom EOF spacer (expected 0)',
    'real controller marker roving focus did not move',
    'real controller hidden high-contrast target remained visible',
    'real controller teardown left 4 artifact(s) (expected 0)',
  ]);
});
