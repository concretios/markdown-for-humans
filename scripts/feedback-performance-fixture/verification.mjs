const REQUIRED_FEATURES = Object.freeze([
  'frontmatter',
  'table',
  'list',
  'image',
  'mermaid',
  'math',
  'rawHtml',
  'code',
]);

export const feedbackPerformanceBudgets = Object.freeze({
  fixture: Object.freeze({
    readingWords: 3_000,
    stressLines: 10_000,
    feedbackItems: 500,
    typingTransactions: 10_000,
  }),
  typing: Object.freeze({
    hotPathSerializations: 0,
    maxPendingTimers: 1,
    drainSerializations: 1,
    drainSends: 1,
  }),
  annotations: Object.freeze({
    geometryReadsPerItem: 2,
    geometryReadSlack: 5,
  }),
});

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nonNegativeInteger(container, key, path, failures) {
  const value = container[key];
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    failures.push(`${path}.${key} was not a non-negative finite integer`);
    return undefined;
  }
  return value;
}

function expectMaximum(value, maximum, describeFailure, failures) {
  if (value !== undefined && value > maximum) failures.push(describeFailure(value, maximum));
}

function expectZero(value, describeFailure, failures) {
  if (value !== undefined && value !== 0) failures.push(describeFailure(value));
}

function expectExact(value, expected, describeFailure, failures) {
  if (value !== undefined && value !== expected) failures.push(describeFailure(value, expected));
}

/**
 * Evaluate deterministic work counts. Millisecond timings deliberately do not
 * participate because shared CI runners cannot represent the reference i5.
 */
export function evaluateFeedbackPerformanceReport(input) {
  const failures = [];
  const report = record(input);
  if (report.version !== 1) {
    failures.push(`performance report version was ${String(report.version)} (expected 1)`);
  }

  const fixture = record(report.fixture);
  const readingWords = nonNegativeInteger(fixture, 'readingWords', 'fixture', failures);
  const stressLines = nonNegativeInteger(fixture, 'stressLines', 'fixture', failures);
  const feedbackItems = nonNegativeInteger(fixture, 'feedbackItems', 'fixture', failures);
  const typingTransactions = nonNegativeInteger(fixture, 'typingTransactions', 'fixture', failures);

  if (
    readingWords !== undefined &&
    readingWords < feedbackPerformanceBudgets.fixture.readingWords
  ) {
    failures.push(
      `reading fixture contained ${readingWords} word(s) (minimum ${feedbackPerformanceBudgets.fixture.readingWords})`
    );
  }
  if (stressLines !== undefined && stressLines < feedbackPerformanceBudgets.fixture.stressLines) {
    failures.push(
      `stress fixture contained ${stressLines} line(s) (minimum ${feedbackPerformanceBudgets.fixture.stressLines})`
    );
  }
  if (
    feedbackItems !== undefined &&
    feedbackItems < feedbackPerformanceBudgets.fixture.feedbackItems
  ) {
    failures.push(
      `stress fixture contained ${feedbackItems} feedback item(s) (minimum ${feedbackPerformanceBudgets.fixture.feedbackItems})`
    );
  }
  if (
    typingTransactions !== undefined &&
    typingTransactions < feedbackPerformanceBudgets.fixture.typingTransactions
  ) {
    failures.push(
      `typing fixture contained ${typingTransactions} transaction(s) (minimum ${feedbackPerformanceBudgets.fixture.typingTransactions})`
    );
  }

  const features = record(fixture.features);
  for (const feature of REQUIRED_FEATURES) {
    if (features[feature] !== true) {
      failures.push(`stress fixture did not include ${feature} content`);
    }
  }

  const typing = record(report.typing);
  const hotPathSerializations = nonNegativeInteger(
    typing,
    'hotPathSerializations',
    'typing',
    failures
  );
  const maxPendingTimers = nonNegativeInteger(typing, 'maxPendingTimers', 'typing', failures);
  const drainSerializations = nonNegativeInteger(typing, 'drainSerializations', 'typing', failures);
  const drainSends = nonNegativeInteger(typing, 'drainSends', 'typing', failures);
  const pendingTimersAfterDrain = nonNegativeInteger(
    typing,
    'pendingTimersAfterDrain',
    'typing',
    failures
  );
  const pendingTimersAfterDispose = nonNegativeInteger(
    typing,
    'pendingTimersAfterDispose',
    'typing',
    failures
  );
  const serializationsAfterDispose = nonNegativeInteger(
    typing,
    'serializationsAfterDispose',
    'typing',
    failures
  );

  expectMaximum(
    hotPathSerializations,
    feedbackPerformanceBudgets.typing.hotPathSerializations,
    value => `typing hot path serialized ${value} time(s) (maximum 0)`,
    failures
  );
  expectMaximum(
    maxPendingTimers,
    feedbackPerformanceBudgets.typing.maxPendingTimers,
    value => `typing retained ${value} concurrent timer(s) (maximum 1)`,
    failures
  );
  expectExact(
    drainSerializations,
    feedbackPerformanceBudgets.typing.drainSerializations,
    value => `typing drain serialized ${value} time(s) (expected 1)`,
    failures
  );
  expectExact(
    drainSends,
    feedbackPerformanceBudgets.typing.drainSends,
    value => `typing drain sent ${value} edit(s) (expected 1)`,
    failures
  );
  expectZero(
    pendingTimersAfterDrain,
    value => `typing drain retained ${value} timer(s) (expected 0)`,
    failures
  );
  expectZero(
    pendingTimersAfterDispose,
    value => `disposed sync retained ${value} timer(s) (expected 0)`,
    failures
  );
  expectZero(
    serializationsAfterDispose,
    value => `disposed sync serialized ${value} time(s) (expected 0)`,
    failures
  );

  const annotations = record(report.annotations);
  const indexBuildVisits = nonNegativeInteger(
    annotations,
    'indexBuildVisits',
    'annotations',
    failures
  );
  const targetIndexLookups = nonNegativeInteger(
    annotations,
    'targetIndexLookups',
    'annotations',
    failures
  );
  const cardIndexLookups = nonNegativeInteger(
    annotations,
    'cardIndexLookups',
    'annotations',
    failures
  );
  const geometryReads = nonNegativeInteger(annotations, 'geometryReads', 'annotations', failures);
  const unannotatedGeometryReads = nonNegativeInteger(
    annotations,
    'unannotatedGeometryReads',
    'annotations',
    failures
  );
  const sourceLineScansDuringLayout = nonNegativeInteger(
    annotations,
    'sourceLineScansDuringLayout',
    'annotations',
    failures
  );
  const placements = nonNegativeInteger(annotations, 'placements', 'annotations', failures);

  if (stressLines !== undefined) {
    expectMaximum(
      indexBuildVisits,
      stressLines,
      value => `annotation index visited ${value} source line(s) (maximum ${stressLines})`,
      failures
    );
  }
  if (feedbackItems !== undefined) {
    expectMaximum(
      targetIndexLookups,
      feedbackItems,
      value =>
        `annotation layout performed ${value} target lookup(s) for ${feedbackItems} item(s) (maximum ${feedbackItems})`,
      failures
    );
    expectMaximum(
      cardIndexLookups,
      feedbackItems,
      value =>
        `annotation layout performed ${value} card lookup(s) for ${feedbackItems} item(s) (maximum ${feedbackItems})`,
      failures
    );
    const maximumGeometryReads =
      feedbackItems * feedbackPerformanceBudgets.annotations.geometryReadsPerItem +
      feedbackPerformanceBudgets.annotations.geometryReadSlack;
    expectMaximum(
      geometryReads,
      maximumGeometryReads,
      value =>
        `annotation layout performed ${value} geometry read(s) for ${feedbackItems} item(s) (maximum ${maximumGeometryReads})`,
      failures
    );
    if (placements !== undefined && placements !== feedbackItems) {
      failures.push(
        `annotation layout produced ${placements} placement(s) (expected ${feedbackItems})`
      );
    }
  }
  expectZero(
    unannotatedGeometryReads,
    value => `annotation layout measured ${value} unannotated target(s) (expected 0)`,
    failures
  );
  expectZero(
    sourceLineScansDuringLayout,
    value => `annotation layout rescanned ${value} source line(s) (expected 0)`,
    failures
  );
  if (annotations.finalTargetReachable !== true) {
    failures.push('final feedback target was not reachable after layout');
  }

  return { passed: failures.length === 0, failures };
}
