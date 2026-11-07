/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * @file sourceLoss.ts - What a saved text no longer has of its source
 * @description Compares Markdown as authored with Markdown as the editor would
 *              write it, and names what went missing. Pure and dependency-free,
 *              so the webview and the extension host can both use it.
 *
 * Key responsibilities:
 * - List source text that renders nothing visible: HTML tags, comments, link definitions
 * - Report which of those a saved text lost, counting repeated ones
 * - Report a different rendering when the caller supplies a renderer
 */

/** What a saved text lost compared with its source. */
export interface SourceLoss {
  /** HTML tags, comments and link definitions of the source that the saved text lacks. */
  lost: string[];
  /**
   * The saved text renders differently although nothing in `lost` explains it,
   * for example a dropped backslash escape. Only checked when `lost` is empty
   * and a renderer was given.
   */
  rendersDifferently: boolean;
}

/**
 * A comment, a tag, or a link reference definition line.
 * A tag name must be followed by a space, `/` or `>`, so an autolink
 * (`<https://example.com>`) and a comparison (`a < b`) are not tags.
 */
const SILENT_TOKEN =
  /<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>|^ {0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gm;

/**
 * List the parts of a Markdown text that no renderer shows as text, so their
 * loss cannot be seen in the rich view: HTML tags, comments and link reference
 * definitions.
 *
 * @param markdown - Markdown text
 * @returns The tokens in source order; definition lines are trimmed
 */
export function silentSourceTokens(markdown: string): string[] {
  return (markdown.match(SILENT_TOKEN) ?? []).map(token =>
    token.startsWith('<') ? token : token.trim()
  );
}

/**
 * Name what `saved` lost of `source`.
 *
 * @param source - Markdown as authored
 * @param saved - Markdown as it would be written
 * @param render - Optional renderer to HTML; two texts that render to the same
 *                 string are treated as the same content
 * @returns The loss, or `null` when nothing was lost
 */
export function describeSourceLoss(
  source: string,
  saved: string,
  render?: (markdown: string) => string
): SourceLoss | null {
  if (source === saved) return null;

  const remaining = new Map<string, number>();
  for (const token of silentSourceTokens(saved)) {
    remaining.set(token, (remaining.get(token) ?? 0) + 1);
  }
  const lost = silentSourceTokens(source).filter(token => {
    const count = remaining.get(token) ?? 0;
    if (count === 0) return true;
    remaining.set(token, count - 1);
    return false;
  });
  if (lost.length > 0) return { lost, rendersDifferently: false };

  if (render && render(source) !== render(saved)) return { lost: [], rendersDifferently: true };
  return null;
}

/**
 * Short names for lost tokens, to show to a user: `<video>` for any tag of
 * that name, `<!-- -->` for a comment, `[label]:` for a link definition.
 *
 * @param lost - Tokens from {@link SourceLoss.lost}
 * @returns Each distinct name once, in order of first appearance
 */
export function lostTokenNames(lost: readonly string[]): string[] {
  const names = new Set<string>();
  for (const token of lost) {
    if (token.startsWith('<!--')) {
      names.add('<!-- -->');
    } else if (token.startsWith('<')) {
      names.add(`<${/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(token)?.[1] ?? ''}>`);
    } else {
      names.add(`${token.slice(0, token.indexOf(']:') + 1)}:`);
    }
  }
  return [...names];
}
