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

const DARK_ACTION_MINIMUM_WARNING_LUMINANCE_RATIO = 0.9;
const DARK_ACTION_MINIMUM_ADJACENT_CONTRAST = 3;
const DARK_ACTION_MINIMUM_TEXT_CONTRAST = 4.5;

function relativeLuminance(color) {
  const serializedColor = String(color);
  const rgb = serializedColor.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  const srgb = serializedColor.match(/^color\(srgb\s+([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  const channels = rgb
    ? rgb.slice(1, 4).map(channel => Number(channel) / 255)
    : srgb?.slice(1, 4).map(Number);
  if (!channels || channels.some(channel => !Number.isFinite(channel))) return undefined;
  const [red, green, blue] = channels.map(channel =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(firstColor, secondColor) {
  const first = relativeLuminance(firstColor);
  const second = relativeLuminance(secondColor);
  if (first === undefined || second === undefined) return undefined;
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

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

function evaluateFeedbackPalette(metrics, failures) {
  const palette = metrics.feedbackPalette;
  if (!palette || typeof palette !== 'object' || Array.isArray(palette)) {
    failures.push('feedbackPalette was not measured');
    return;
  }

  if (palette.theme === 'light' || palette.theme === 'dark') {
    if (palette.accentColor !== palette.warningColor) {
      failures.push(
        `Feedback accent was ${String(palette.accentColor)} (expected warning-derived ${String(palette.warningColor)})`
      );
    }
    if (palette.savedHighlightColor !== palette.savedTokenColor) {
      failures.push(
        `saved Feedback highlight was ${String(palette.savedHighlightColor)} (expected ${String(palette.savedTokenColor)})`
      );
    }
    if (palette.activeMarkerColor !== palette.actionSurfaceColor) {
      failures.push(
        `active Feedback marker was ${String(palette.activeMarkerColor)} (expected ${String(palette.actionSurfaceColor)})`
      );
    }
    if (palette.primaryActionColor !== palette.actionSurfaceColor) {
      failures.push(
        `primary Feedback action was ${String(palette.primaryActionColor)} (expected ${String(palette.actionSurfaceColor)})`
      );
    }
    if (palette.theme === 'dark') {
      const warningLuminance = relativeLuminance(palette.warningColor);
      const actionLuminance = relativeLuminance(palette.primaryActionColor);
      if (
        warningLuminance === undefined ||
        actionLuminance === undefined ||
        warningLuminance === 0
      ) {
        failures.push('dark Feedback action colors were not measurable RGB values');
      } else {
        const retainedLuminance = actionLuminance / warningLuminance;
        if (retainedLuminance < DARK_ACTION_MINIMUM_WARNING_LUMINANCE_RATIO) {
          failures.push(
            `dark primary Feedback action retained ${Math.round(retainedLuminance * 100)}% of its warning-accent luminance (minimum ${Math.round(DARK_ACTION_MINIMUM_WARNING_LUMINANCE_RATIO * 100)}%)`
          );
        }
      }

      const adjacentContrast = contrastRatio(
        palette.primaryActionColor,
        palette.widgetBackgroundColor
      );
      if (
        adjacentContrast === undefined ||
        adjacentContrast < DARK_ACTION_MINIMUM_ADJACENT_CONTRAST
      ) {
        failures.push(
          `dark primary Feedback action contrast against its widget was ${adjacentContrast?.toFixed(2) ?? 'unmeasurable'}:1 (minimum ${DARK_ACTION_MINIMUM_ADJACENT_CONTRAST}:1)`
        );
      }

      const textContrast = contrastRatio(
        palette.primaryActionColor,
        palette.primaryActionTextColor
      );
      if (textContrast === undefined || textContrast < DARK_ACTION_MINIMUM_TEXT_CONTRAST) {
        failures.push(
          `dark primary Feedback action text contrast was ${textContrast?.toFixed(2) ?? 'unmeasurable'}:1 (minimum ${DARK_ACTION_MINIMUM_TEXT_CONTRAST}:1)`
        );
      }
    }
    return;
  }

  if (palette.theme !== 'high-contrast') {
    failures.push(`feedbackPalette theme was ${String(palette.theme)}`);
    return;
  }

  if (
    palette.savedHighlightEdge === 'none' ||
    !String(palette.savedHighlightEdge).includes(String(palette.contrastBorderColor))
  ) {
    failures.push('high-contrast saved Feedback highlight did not retain the contrast edge');
  }
  if (
    palette.activeMarkerBorderColor !== palette.contrastBorderColor ||
    palette.activeMarkerBorderWidthCssPx < 2
  ) {
    failures.push(
      `high-contrast active Feedback marker border was ${String(palette.activeMarkerBorderColor)} at ${String(palette.activeMarkerBorderWidthCssPx)} CSS px (expected ${String(palette.contrastBorderColor)} at least 2 CSS px)`
    );
  }
  if (
    palette.primaryActionBorderColor !== palette.contrastBorderColor ||
    palette.primaryActionBorderWidthCssPx < 2
  ) {
    failures.push(
      `high-contrast primary Feedback action border was ${String(palette.primaryActionBorderColor)} at ${String(palette.primaryActionBorderWidthCssPx)} CSS px (expected ${String(palette.contrastBorderColor)} at least 2 CSS px)`
    );
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
  evaluateFeedbackPalette(metrics, failures);

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
