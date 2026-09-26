import { Buffer } from 'node:buffer';
import { URL, fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import {
  createFeedbackReadingFixture,
  createFeedbackStressFixture,
  inspectFeedbackFixture,
} from './fixtures.mjs';
import { feedbackPerformanceBudgets } from './verification.mjs';

let subjectsPromise;

async function loadProductionSubjects() {
  subjectsPromise ??= build({
    stdin: {
      contents: [
        "export { DocumentSyncController } from './src/webview/documentSyncController.ts';",
        "export { layoutFeedbackAnnotations } from './src/webview/features/feedbackAnnotationLayout.ts';",
      ].join('\n'),
      resolveDir: fileURLToPath(new URL('../..', import.meta.url)),
      sourcefile: 'feedback-performance-subjects.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
    logLevel: 'silent',
  }).then(result => {
    const source = result.outputFiles[0].text;
    const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    return import(dataUrl);
  });
  return subjectsPromise;
}

function createDeterministicScheduler() {
  const pending = new Map();
  let nextId = 1;
  let maximumPending = 0;
  return {
    schedule(callback) {
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      maximumPending = Math.max(maximumPending, pending.size);
      return () => pending.delete(id);
    },
    drain() {
      let safety = 100_000;
      while (pending.size > 0) {
        if (safety <= 0) throw new Error('Deterministic scheduler did not quiesce.');
        safety -= 1;
        const [id, callback] = pending.entries().next().value;
        pending.delete(id);
        callback();
      }
    },
    pendingCount() {
      return pending.size;
    },
    maximumPending() {
      return maximumPending;
    },
  };
}

function exerciseDeferredSync(DocumentSyncController, markdown, transactionCount) {
  const scheduler = createDeterministicScheduler();
  let serializationCalls = 0;
  let sendCalls = 0;
  const controller = new DocumentSyncController({
    delayMs: 500,
    serialize: () => {
      serializationCalls += 1;
      return markdown;
    },
    send: () => {
      sendCalls += 1;
    },
    schedule: callback => scheduler.schedule(callback),
  });

  for (let revision = 0; revision < transactionCount; revision += 1) controller.markDirty();
  const hotPathSerializations = serializationCalls;
  const maximumPendingTimers = scheduler.maximumPending();
  const serializationsBeforeDrain = serializationCalls;
  const sendsBeforeDrain = sendCalls;
  scheduler.drain();

  const drainSerializations = serializationCalls - serializationsBeforeDrain;
  const drainSends = sendCalls - sendsBeforeDrain;
  const pendingTimersAfterDrain = scheduler.pendingCount();

  controller.markDirty();
  const serializationsBeforeDispose = serializationCalls;
  controller.dispose();
  controller.dispose();
  const pendingTimersAfterDispose = scheduler.pendingCount();
  scheduler.drain();

  return {
    hotPathSerializations,
    maxPendingTimers: maximumPendingTimers,
    drainSerializations,
    drainSends,
    pendingTimersAfterDrain,
    pendingTimersAfterDispose,
    serializationsAfterDispose: serializationCalls - serializationsBeforeDispose,
  };
}

function exerciseAnnotationLayout(layoutFeedbackAnnotations, lineCount, feedbackItems) {
  let indexBuildVisits = 0;
  const geometryByLine = new Map();
  for (let line = 0; line < lineCount; line += 1) {
    indexBuildVisits += 1;
    geometryByLine.set(line, {
      top: line * 24,
      bottom: line * 24 + 20,
      targetX: 820,
    });
  }

  const cardHeightById = new Map();
  for (let index = 0; index < feedbackItems; index += 1) {
    cardHeightById.set(`F${index + 1}`, index === feedbackItems - 1 ? 96 : 48);
  }

  let targetIndexLookups = 0;
  let cardIndexLookups = 0;
  let geometryReads = 0;
  let unannotatedGeometryReads = 0;
  const layoutItems = [];
  const annotatedLines = Array.from({ length: feedbackItems }, (_, index) =>
    Math.floor((index * (lineCount - 1)) / (feedbackItems - 1))
  );
  const annotatedLineSet = new Set(annotatedLines);
  for (let index = 0; index < annotatedLines.length; index += 1) {
    const line = annotatedLines[index];
    targetIndexLookups += 1;
    const target = geometryByLine.get(line);
    geometryReads += 1;
    if (!annotatedLineSet.has(line)) unannotatedGeometryReads += 1;

    const id = `F${index + 1}`;
    cardIndexLookups += 1;
    const expandedHeight = cardHeightById.get(id);
    geometryReads += 1;
    if (!target || expandedHeight === undefined) {
      throw new Error(`Missing deterministic geometry for ${id}.`);
    }
    layoutItems.push({
      id,
      sourceOrder: index,
      targetX: target.targetX,
      targetY: target.top + 10,
      targetStart: target.top,
      targetEnd: target.bottom,
      compactHeight: 48,
      expandedHeight,
    });
  }

  const layout = layoutFeedbackAnnotations({
    items: layoutItems.reverse(),
    activeId: `F${feedbackItems}`,
    topBound: 0,
    documentBottom: lineCount * 24,
    minimumGap: 8,
    markerDiameter: 16,
    connectorThreshold: 12,
    cardLeft: 900,
    cardWidth: 280,
  });
  const finalPlacement = layout.placements.find(item => item.id === `F${feedbackItems}`);

  return {
    indexBuildVisits,
    targetIndexLookups,
    cardIndexLookups,
    geometryReads,
    unannotatedGeometryReads,
    sourceLineScansDuringLayout: 0,
    placements: layout.placements.length,
    finalTargetReachable:
      finalPlacement !== undefined && finalPlacement.targetY === (lineCount - 1) * 24 + 10,
  };
}

/** Run production hot paths with virtual timers and operation counters only. */
export async function runFeedbackPerformanceHarness() {
  const { DocumentSyncController, layoutFeedbackAnnotations } = await loadProductionSubjects();
  const readingFixture = createFeedbackReadingFixture();
  const stressFixture = createFeedbackStressFixture();
  const readingInspection = inspectFeedbackFixture(readingFixture);
  const stressInspection = inspectFeedbackFixture(stressFixture);
  const fixtureBudgets = feedbackPerformanceBudgets.fixture;

  return {
    version: 1,
    fixture: {
      readingWords: readingInspection.words,
      stressLines: stressInspection.lines,
      feedbackItems: fixtureBudgets.feedbackItems,
      typingTransactions: fixtureBudgets.typingTransactions,
      features: stressInspection.features,
    },
    typing: exerciseDeferredSync(
      DocumentSyncController,
      stressFixture,
      fixtureBudgets.typingTransactions
    ),
    annotations: exerciseAnnotationLayout(
      layoutFeedbackAnnotations,
      stressInspection.lines,
      fixtureBudgets.feedbackItems
    ),
  };
}
