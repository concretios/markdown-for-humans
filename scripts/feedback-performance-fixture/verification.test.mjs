import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFeedbackReadingFixture,
  createFeedbackStressFixture,
  inspectFeedbackFixture,
} from './fixtures.mjs';
import { runFeedbackPerformanceHarness } from './harness.mjs';
import { evaluateFeedbackPerformanceReport, feedbackPerformanceBudgets } from './verification.mjs';

function passingReport(overrides = {}) {
  return {
    version: 1,
    fixture: {
      readingWords: 3_000,
      stressLines: 10_000,
      feedbackItems: 500,
      typingTransactions: 10_000,
      features: {
        frontmatter: true,
        table: true,
        list: true,
        image: true,
        mermaid: true,
        math: true,
        rawHtml: true,
        code: true,
      },
    },
    typing: {
      hotPathSerializations: 0,
      maxPendingTimers: 1,
      drainSerializations: 1,
      drainSends: 1,
      pendingTimersAfterDrain: 0,
      pendingTimersAfterDispose: 0,
      serializationsAfterDispose: 0,
    },
    annotations: {
      indexBuildVisits: 10_000,
      targetIndexLookups: 500,
      cardIndexLookups: 500,
      geometryReads: 1_005,
      unannotatedGeometryReads: 0,
      sourceLineScansDuringLayout: 0,
      placements: 500,
      finalTargetReachable: true,
    },
    ...overrides,
  };
}

test('generated reading and stress fixtures meet the exact deterministic corpus contract', () => {
  const reading = createFeedbackReadingFixture();
  const stress = createFeedbackStressFixture();
  const stressInspection = inspectFeedbackFixture(stress);

  assert.equal(inspectFeedbackFixture(reading).words, 3_000);
  assert.equal(stressInspection.lines, 10_000);
  assert.ok(stressInspection.words > 10_000);
  assert.deepEqual(stressInspection.features, {
    frontmatter: true,
    table: true,
    list: true,
    image: true,
    mermaid: true,
    math: true,
    rawHtml: true,
    code: true,
  });
});

test('budget evaluator accepts every deterministic limit at its inclusive boundary', () => {
  assert.deepEqual(evaluateFeedbackPerformanceReport(passingReport()), {
    passed: true,
    failures: [],
  });
});

test('budget evaluator does not turn shared-runner elapsed time into a CI gate', () => {
  const report = passingReport({
    observations: {
      typingBurstMs: 60_000,
      annotationLayoutMs: 60_000,
    },
  });

  assert.deepEqual(evaluateFeedbackPerformanceReport(report), {
    passed: true,
    failures: [],
  });
});

test('budget evaluator rejects serialization and timer work on the typing hot path', () => {
  const report = passingReport({
    typing: {
      ...passingReport().typing,
      hotPathSerializations: 1,
      maxPendingTimers: 2,
      drainSerializations: 2,
      drainSends: 2,
      pendingTimersAfterDrain: 1,
      pendingTimersAfterDispose: 1,
      serializationsAfterDispose: 1,
    },
  });

  assert.deepEqual(evaluateFeedbackPerformanceReport(report).failures, [
    'typing hot path serialized 1 time(s) (maximum 0)',
    'typing retained 2 concurrent timer(s) (maximum 1)',
    'typing drain serialized 2 time(s) (expected 1)',
    'typing drain sent 2 edit(s) (expected 1)',
    'typing drain retained 1 timer(s) (expected 0)',
    'disposed sync retained 1 timer(s) (expected 0)',
    'disposed sync serialized 1 time(s) (expected 0)',
  ]);
});

test('budget evaluator rejects document-wide and superlinear annotation work', () => {
  const report = passingReport({
    annotations: {
      ...passingReport().annotations,
      indexBuildVisits: 10_001,
      targetIndexLookups: 501,
      cardIndexLookups: 501,
      geometryReads: 1_006,
      unannotatedGeometryReads: 1,
      sourceLineScansDuringLayout: 10_000,
      placements: 499,
      finalTargetReachable: false,
    },
  });

  assert.deepEqual(evaluateFeedbackPerformanceReport(report).failures, [
    'annotation index visited 10001 source line(s) (maximum 10000)',
    'annotation layout performed 501 target lookup(s) for 500 item(s) (maximum 500)',
    'annotation layout performed 501 card lookup(s) for 500 item(s) (maximum 500)',
    'annotation layout performed 1006 geometry read(s) for 500 item(s) (maximum 1005)',
    'annotation layout produced 499 placement(s) (expected 500)',
    'annotation layout measured 1 unannotated target(s) (expected 0)',
    'annotation layout rescanned 10000 source line(s) (expected 0)',
    'final feedback target was not reachable after layout',
  ]);
});

test('budget evaluator fails closed for undersized or malformed reports', () => {
  const report = passingReport({
    version: 2,
    fixture: {
      ...passingReport().fixture,
      readingWords: 2_999,
      stressLines: Number.NaN,
      features: { ...passingReport().fixture.features, mermaid: false },
    },
  });

  const result = evaluateFeedbackPerformanceReport(report);

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [
    'performance report version was 2 (expected 1)',
    'fixture.stressLines was not a non-negative finite integer',
    'reading fixture contained 2999 word(s) (minimum 3000)',
    'stress fixture did not include mermaid content',
  ]);
});

test('real harness is repeatable and passes the committed operation-count budgets', async () => {
  const first = await runFeedbackPerformanceHarness();
  const second = await runFeedbackPerformanceHarness();

  assert.deepEqual(second, first);
  assert.deepEqual(evaluateFeedbackPerformanceReport(first), {
    passed: true,
    failures: [],
  });
  assert.equal(first.fixture.stressLines, feedbackPerformanceBudgets.fixture.stressLines);
  assert.equal(first.annotations.placements, feedbackPerformanceBudgets.fixture.feedbackItems);
});
