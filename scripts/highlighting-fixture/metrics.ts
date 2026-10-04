/** Build-time fixture instrumentation. Never imported by production bundles. */
import type { HighlightService } from '../../src/webview/highlighting/types';
import type { Editor } from '@tiptap/core';

export const metrics = {
  operation: 'initialization',
  serviceRequests: 0,
  workerJobs: 0,
  workerCharacters: 0,
  workerResults: 0,
  activeServices: 0,
  fallbacks: {} as Record<string, number>,
  workerRoundTrips: [] as number[],
  dispatches: [] as number[],
  documentDispatches: [] as number[],
  colorDispatches: [] as number[],
  otherDispatches: [] as number[],
  documentStateApply: [] as number[],
  documentDomUpdate: [] as number[],
  documentEvents: [] as number[],
  phaseDetails: {} as Record<string, number[]>,
  beforeinputToNextFrame: [] as number[],
  longTasks: [] as number[],
  resetAt: 0,
};

/** Reset measurements without changing the running production worker or cache. */
export function resetMetrics(operation: string): void {
  Object.assign(metrics, {
    operation,
    serviceRequests: 0,
    workerJobs: 0,
    workerCharacters: 0,
    workerResults: 0,
    fallbacks: {},
    workerRoundTrips: [],
    dispatches: [],
    documentDispatches: [],
    colorDispatches: [],
    otherDispatches: [],
    documentStateApply: [],
    documentDomUpdate: [],
    documentEvents: [],
    phaseDetails: {},
    beforeinputToNextFrame: [],
    longTasks: [],
    resetAt: performance.now(),
  });
}

/** Attribute synchronous document dispatches without changing production code. */
export function instrumentEditorPhases(editor: Editor): void {
  let documentDispatch = false;
  let eventTime = 0;
  const record = (name: string, elapsed: number): void => {
    (metrics.phaseDetails[name] ??= []).push(elapsed);
  };
  const fieldObjects = new WeakSet<object>();
  const pluginObjects = new WeakSet<object>();
  const installStateFields = (): void => {
    const internal = editor.state as unknown as {
      config: {
        fields: Array<{ name: string; apply: (...args: unknown[]) => unknown }>;
        plugins: Array<{
          key: string;
          spec: { appendTransaction?: (...args: unknown[]) => unknown };
        }>;
      };
    };
    for (const field of internal.config.fields) {
      if (fieldObjects.has(field)) continue;
      fieldObjects.add(field);
      const original = field.apply;
      field.apply = function (...args) {
        if (!documentDispatch) return original.apply(this, args);
        const started = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          record(`state:${field.name}`, performance.now() - started);
        }
      };
    }
    for (const plugin of internal.config.plugins) {
      if (pluginObjects.has(plugin) || !plugin.spec.appendTransaction) continue;
      pluginObjects.add(plugin);
      const original = plugin.spec.appendTransaction;
      plugin.spec.appendTransaction = function (...args) {
        if (!documentDispatch) return original.apply(this, args);
        const started = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          record(`append:${plugin.key}`, performance.now() - started);
        }
      };
    }
  };
  const updateState = editor.view.updateState;
  editor.view.updateState = function (state) {
    if (!documentDispatch) return updateState.call(this, state);
    const started = performance.now();
    try {
      return updateState.call(this, state);
    } finally {
      metrics.documentDomUpdate.push(performance.now() - started);
    }
  };
  const emit = editor.emit;
  editor.emit = function (event, ...args) {
    if (!documentDispatch) return emit.call(this, event, ...args);
    const started = performance.now();
    try {
      return emit.call(this, event, ...args);
    } finally {
      const elapsed = performance.now() - started;
      eventTime += elapsed;
      record(`event:${event}`, elapsed);
    }
  };
  const dispatch = editor.view.dispatch;
  editor.view.dispatch = function (transaction) {
    const previousDocumentDispatch = documentDispatch;
    const previousEventTime = eventTime;
    documentDispatch = transaction.docChanged;
    eventTime = 0;
    installStateFields();
    const state = editor.state;
    const applyTransaction = state.applyTransaction;
    state.applyTransaction = function (tr) {
      if (!documentDispatch) return applyTransaction.call(this, tr);
      const started = performance.now();
      try {
        return applyTransaction.call(this, tr);
      } finally {
        metrics.documentStateApply.push(performance.now() - started);
      }
    };
    try {
      return dispatch.call(this, transaction);
    } finally {
      state.applyTransaction = applyTransaction;
      if (documentDispatch) metrics.documentEvents.push(eventTime);
      documentDispatch = previousDocumentDispatch;
      eventTime = previousEventTime;
    }
  };
}

/** Wrap only this fixture's Worker calls; the shipped client is unchanged. */
function instrumentWorkerTransport(): void {
  const original = Worker.prototype.postMessage;
  const listeners = new WeakSet<Worker>();
  const starts = new Map<string, number>();
  Worker.prototype.postMessage = function (message: unknown, transfer: Transferable[]): void {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'md4h.highlight.request'
    ) {
      const request = message as { session: string; requestId: number; source: string };
      const key = `${request.session}:${request.requestId}`;
      starts.set(key, performance.now());
      metrics.workerJobs++;
      metrics.workerCharacters += request.source.length;
      if (!listeners.has(this)) {
        listeners.add(this);
        this.addEventListener('message', event => {
          if (event.data?.type !== 'md4h.highlight.result') return;
          const resultKey = `${event.data.session}:${event.data.requestId}`;
          const started = starts.get(resultKey);
          if (started !== undefined) {
            starts.delete(resultKey);
            metrics.workerResults++;
            metrics.workerRoundTrips.push(performance.now() - started);
          }
        });
      }
    }
    original.call(this, message, transfer || []);
  };
}

if (typeof Worker !== 'undefined') instrumentWorkerTransport();

/** Count client requests and fallbacks without replacing queue or cache behavior. */
export function measureService(service: HighlightService): HighlightService {
  metrics.activeServices++;
  return {
    ...service,
    async highlight(grammar: string, source: string) {
      metrics.serviceRequests++;
      try {
        const result = await service.highlight(grammar, source);
        if (result.reason)
          metrics.fallbacks[result.reason] = (metrics.fallbacks[result.reason] || 0) + 1;
        return result;
      } catch (error) {
        metrics.fallbacks['unexpected-rejection'] =
          (metrics.fallbacks['unexpected-rejection'] || 0) + 1;
        throw error;
      }
    },
    dispose() {
      metrics.activeServices--;
      service.dispose();
    },
  };
}
