/**
 * Copyright (c) 2025-2026 Concret.io
 * Licensed under the MIT License. See LICENSE in the project root.
 * One-worker transport and bounded relative-span cache. The editor plugin owns
 * scheduling; this service never accumulates a second pending-source queue.
 */
import { resolveGrammar } from './languageRegistry';
import {
  HIGHLIGHT_LIMITS,
  HIGHLIGHT_REQUEST,
  HIGHLIGHT_RESPONSE,
  createHighlightResultValidation,
  type HighlightRequest,
  type HighlightResponse,
  type HighlightResult,
  type HighlightService,
} from './types';

interface CachedResult {
  result: HighlightResult;
  bytes: number;
}
interface Failure {
  retried: boolean;
  reason?: string;
}
interface ActiveJob {
  grammar: string;
  source: string;
  key: string;
  failureKey: string;
  requestId: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Cancels the pending validation continuation, when one is scheduled. */
  continuation: (() => void) | null;
  validating: boolean;
  resolve: (result: HighlightResult) => void;
}
let sessionSequence = 0;

/** A cancellable yield to the event loop. */
export interface TaskYield {
  /** Schedule one task; the returned function cancels it if it has not run. */
  post(task: () => void): () => void;
  dispose(): void;
}

/**
 * Yield through a MessageChannel task where available. Chained setTimeout(0)
 * calls are clamped to 4 ms after five nested levels, which made a 40-chunk
 * validation wait ~150 ms. At most one message is in flight; a task posted
 * while one is queued replaces the pending task and reuses that message.
 * JSDOM has no MessageChannel and keeps the timer path.
 */
export function createTaskYield(): TaskYield {
  let channel: MessageChannel | null = null;
  let pending: (() => void) | null = null;
  let inFlight = false;
  let disposed = false;
  return {
    post(task) {
      if (disposed) return () => undefined;
      if (typeof MessageChannel !== 'function') {
        const timer = setTimeout(task, 0);
        return () => clearTimeout(timer);
      }
      if (!channel) {
        channel = new MessageChannel();
        channel.port1.onmessage = () => {
          // Clear state before running, so a re-post from the task sends a new message.
          inFlight = false;
          const next = pending;
          pending = null;
          next?.();
        };
      }
      pending = task;
      if (!inFlight) {
        inFlight = true;
        channel.port2.postMessage(null);
      }
      return () => {
        if (pending === task) pending = null;
      };
    },
    dispose() {
      disposed = true;
      pending = null;
      channel?.port1.close();
      channel?.port2.close();
      channel = null;
    },
  };
}

/** A bounded failure fingerprint. Collisions conservatively withhold a retry only. */
function failureFingerprint(grammar: string, source: string): string {
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second, 33) ^ code;
  }
  return `${grammar}:${source.length}:${first >>> 0}:${second >>> 0}`;
}

/**
 * Fetch the provider-supplied local packaged URL and create a Blob worker.
 * Returns plain fallback results for failure/disposal; it never rejects into typing.
 * @param workerUrl Trusted asWebviewUri asset URL supplied by the extension host.
 */
export function createHighlightService(workerUrl: string): HighlightService {
  const session = `highlight-${Date.now()}-${++sessionSequence}`;
  let disposed = false;
  let exhausted = false;
  let nextRequestId = 0;
  let worker: Worker | null = null;
  let objectUrl: string | null = null;
  let fetchController: AbortController | null = null;
  let active: ActiveJob | null = null;
  let cacheBytes = 0;
  let cacheRanges = 0;
  const yielder = createTaskYield();
  const cache = new Map<string, CachedResult>();
  // Kept outside the evictable token cache: eviction cannot reset a failed job's
  // retry allowance. Exhaustion fails closed until the webview is reopened.
  const failures = new Map<string, Failure>();

  const stopWorker = (): void => {
    fetchController?.abort();
    fetchController = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      worker = null;
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  };
  const finish = (job: ActiveJob, result: HighlightResult): void => {
    if (active !== job) return;
    if (job.timer !== null) clearTimeout(job.timer);
    job.continuation?.();
    job.continuation = null;
    active = null;
    job.resolve(result);
  };
  const store = (key: string, result: HighlightResult, bytes: number): void => {
    // Source/range accounting and per-span freezing happened in bounded chunks.
    // Only the small LRU map and the final array/object seals remain here.
    if (bytes > HIGHLIGHT_LIMITS.cacheBytes || result.spans.length > HIGHLIGHT_LIMITS.cacheRanges)
      return;
    while (
      cache.size >= HIGHLIGHT_LIMITS.cacheEntries ||
      cacheBytes + bytes > HIGHLIGHT_LIMITS.cacheBytes ||
      cacheRanges + result.spans.length > HIGHLIGHT_LIMITS.cacheRanges
    ) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const entry = cache.get(oldest);
      if (entry) {
        cacheBytes -= entry.bytes;
        cacheRanges -= entry.result.spans.length;
      }
      cache.delete(oldest);
    }
    Object.freeze(result.spans);
    Object.freeze(result);
    cache.set(key, { result, bytes });
    cacheBytes += bytes;
    cacheRanges += result.spans.length;
  };
  const fail = (job: ActiveJob, requestId: number, reason: string): void => {
    if (disposed || active !== job || job.requestId !== requestId) return;
    if (job.timer !== null) clearTimeout(job.timer);
    job.continuation?.();
    job.continuation = null;
    stopWorker();
    let failure = failures.get(job.failureKey);
    if (!failure) {
      if (failures.size >= HIGHLIGHT_LIMITS.failureEntries) {
        exhausted = true;
        finish(job, { spans: [], reason: 'retry-limit' });
        return;
      }
      failure = { retried: false };
      failures.set(job.failureKey, failure);
    }
    if (failure.retried) {
      failure.reason = reason;
      finish(job, { spans: [], reason });
      return;
    }
    failure.retried = true;
    start(job);
  };
  const receive = (event: MessageEvent<unknown>, sender: Worker): void => {
    const job = active;
    if (disposed || worker !== sender || !job || !event.data || typeof event.data !== 'object')
      return;
    const response = event.data as Partial<HighlightResponse>;
    // A previous request/view cannot settle or fail the current request. Once a
    // reply is being validated, duplicate replies cannot start another traversal.
    if (response.session !== session || response.requestId !== job.requestId || job.validating)
      return;
    if (
      response.type !== HIGHLIGHT_RESPONSE ||
      response.version !== 1 ||
      response.grammar !== job.grammar ||
      response.sourceLength !== job.source.length
    ) {
      fail(job, job.requestId, 'invalid-worker-result');
      return;
    }
    const validation = createHighlightResultValidation(response.result, job.source);
    if (!validation) {
      fail(job, job.requestId, 'invalid-worker-result');
      return;
    }
    job.validating = true;
    const requestId = job.requestId;
    // The worker has finished. Main-thread validation yields to input, so its
    // scheduling delay must not be counted as a tokenizer timeout/retry.
    if (job.timer !== null) clearTimeout(job.timer);
    job.timer = null;
    let bytes = job.key.length * 2 + 128;
    const processChunk = (): void => {
      if (disposed || active !== job || job.requestId !== requestId || worker !== sender) return;
      job.continuation = null;
      try {
        const status = validation.advance(
          HIGHLIGHT_LIMITS.validationChunkRanges,
          span => {
            bytes += 64 + span.classes.length * 2;
            Object.freeze(span);
          },
          performance.now() + HIGHLIGHT_LIMITS.validationSliceMs
        );
        if (status === 'invalid') {
          fail(job, requestId, 'invalid-worker-result');
          return;
        }
        if (status === 'pending') {
          job.continuation = yielder.post(processChunk);
          return;
        }
        // Recheck after the final chunk before retaining or publishing any data.
        if (disposed || active !== job || job.requestId !== requestId || worker !== sender) return;
        store(job.key, validation.result, bytes);
        finish(job, validation.result);
      } catch {
        fail(job, requestId, 'invalid-worker-result');
      }
    };
    processChunk();
  };
  const start = (job: ActiveJob): void => {
    const requestId = ++nextRequestId;
    job.requestId = requestId;
    job.continuation?.();
    job.continuation = null;
    job.validating = false;
    job.timer = setTimeout(
      () => fail(job, requestId, 'worker-timeout'),
      HIGHLIGHT_LIMITS.timeoutMs
    );
    const send = (target: Worker): void => {
      if (disposed || active !== job || job.requestId !== requestId) return;
      const request: HighlightRequest = {
        type: HIGHLIGHT_REQUEST,
        version: 1,
        session,
        requestId,
        grammar: job.grammar,
        source: job.source,
      };
      try {
        target.postMessage(request);
      } catch {
        fail(job, requestId, 'worker-error');
      }
    };
    if (worker) {
      send(worker);
      return;
    }
    const controller = new AbortController();
    fetchController = controller;
    // Loading is lazy. Unknown/plain blocks never fetch the grammar bundle.
    void (async (): Promise<void> => {
      try {
        const response = await fetch(workerUrl, { signal: controller.signal });
        if (!response.ok) throw new Error('Highlight worker asset unavailable');
        const blob = await response.blob();
        if (disposed || active !== job || job.requestId !== requestId) return;
        const url = URL.createObjectURL(blob);
        objectUrl = url;
        const target = new Worker(url);
        worker = target;
        fetchController = null;
        target.onmessage = event => receive(event, target);
        target.onerror = event => {
          event.preventDefault();
          if (worker !== target) return;
          if (active) fail(active, active.requestId, 'worker-error');
          // An idle failure must not spend the next source's timeout/retry on a
          // worker already known to have failed. Reload stays lazy until needed.
          else stopWorker();
        };
        target.onmessageerror = () => {
          if (worker !== target) return;
          if (active) fail(active, active.requestId, 'invalid-worker-result');
          else stopWorker();
        };
        send(target);
      } catch {
        fail(job, requestId, 'worker-unavailable');
      }
    })();
  };

  return {
    highlight(language, source) {
      if (disposed) return Promise.resolve({ spans: [], reason: 'disposed' });
      const grammar = resolveGrammar(language);
      if (!grammar || !source)
        return Promise.resolve({ spans: [], reason: grammar ? undefined : 'plain' });
      if (source.length > HIGHLIGHT_LIMITS.sourceUnits)
        return Promise.resolve({ spans: [], reason: 'source-limit' });
      const key = `${grammar}\0${source}`;
      const cached = cache.get(key);
      if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        return Promise.resolve(cached.result);
      }
      if (exhausted) return Promise.resolve({ spans: [], reason: 'retry-limit' });
      if (active) return Promise.resolve({ spans: [], reason: 'busy' });
      const failureKey = failureFingerprint(grammar, source);
      const failure = failures.get(failureKey);
      if (failure?.reason) return Promise.resolve({ spans: [], reason: failure.reason });
      return new Promise<HighlightResult>(resolve => {
        const job: ActiveJob = {
          grammar,
          source,
          key,
          failureKey,
          requestId: 0,
          timer: null,
          continuation: null,
          validating: false,
          resolve,
        };
        active = job;
        start(job);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopWorker();
      if (active) finish(active, { spans: [], reason: 'disposed' });
      yielder.dispose();
      cache.clear();
      failures.clear();
      cacheBytes = 0;
      cacheRanges = 0;
    },
  };
}
