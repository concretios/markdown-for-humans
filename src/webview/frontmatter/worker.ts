/**
 * Copyright (c) 2025-2026 Concret.io
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { parseFrontmatter } from './presentation';
import { FRONTMATTER_REQUEST, FRONTMATTER_RESULT } from './reader';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (value: unknown) => void;
};

scope.onmessage = event => {
  const request = event.data as { type?: unknown; source?: unknown } | null;
  if (request?.type !== FRONTMATTER_REQUEST || typeof request.source !== 'string') return;
  scope.postMessage({ type: FRONTMATTER_RESULT, presentation: parseFrontmatter(request.source) });
};
