/**
 * Copyright (c) 2025-2026 Concret.io
 * Licensed under the MIT License. See LICENSE in the project root.
 * Extracts the visual scope from a validated, ancestor-first token class list.
 */

/**
 * Select the deepest semantic scope, retaining its modifier classes.
 *
 * Flattened token ranges contain both ancestor and descendant classes. CSS
 * cannot recover that nesting through selector specificity, so decorations
 * expose this scope separately while retaining their original token classes.
 *
 * @param classes - Validated classes ordered by their latest/deepest occurrence.
 * @returns Final hljs scope without its prefix, or an empty string for plain text.
 */
export function innermostScope(classes: string): string {
  const nested = classes.lastIndexOf(' hljs-');
  if (nested !== -1) return classes.slice(nested + 6);
  return classes.startsWith('hljs-') ? classes.slice(5) : '';
}
