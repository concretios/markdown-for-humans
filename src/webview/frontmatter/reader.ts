/**
 * Copyright (c) 2025-2026 Concret.io
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import type { FrontmatterPresentation } from './presentation';

export const MAX_FRONTMATTER_LENGTH = 16_384;
export const FRONTMATTER_REQUEST = 'md4h.frontmatter.request';
export const FRONTMATTER_RESULT = 'md4h.frontmatter.result';

export type ReadFrontmatter = (
  source: string,
  signal: AbortSignal
) => Promise<FrontmatterPresentation | null>;

/** Read a bounded snapshot off the UI thread using the packaged webview worker. */
export function createFrontmatterReader(uri: string): ReadFrontmatter {
  let asset: Blob | undefined;

  return async (source, signal) => {
    if (!uri || source.length > MAX_FRONTMATTER_LENGTH || signal.aborted) return null;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
    let url: string | undefined;
    let worker: Worker | undefined;
    try {
      if (!asset) {
        const response = await fetch(uri, { signal: deadline });
        if (!response.ok) return null;
        asset = await response.blob();
      }
      if (deadline.aborted) return null;
      url = URL.createObjectURL(asset);
      const target = new Worker(url);
      worker = target;
      return await new Promise<FrontmatterPresentation | null>(resolve => {
        const finish = (result: FrontmatterPresentation | null): void => {
          deadline.removeEventListener('abort', abort);
          resolve(result);
        };
        const abort = (): void => finish(null);
        deadline.addEventListener('abort', abort, { once: true });
        target.onmessage = (
          event: MessageEvent<{
            type: string;
            presentation: FrontmatterPresentation | null;
          }>
        ) => finish(event.data?.type === FRONTMATTER_RESULT ? event.data.presentation : null);
        target.onerror = event => {
          event.preventDefault();
          finish(null);
        };
        target.onmessageerror = abort;
        try {
          target.postMessage({ type: FRONTMATTER_REQUEST, source });
        } catch {
          finish(null);
        }
      });
    } catch {
      return null;
    } finally {
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
    }
  };
}
