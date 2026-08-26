/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Detects when two markdown strings are structurally equivalent — i.e. they
 * render to the same document, even if the source bytes differ.
 *
 * The webview's WYSIWYG round-trip (parse → ProseMirror → re-serialize) often
 * rewrites lint-clean source into the serializer's canonical style: bullet
 * markers `*`/`+` collapse to `-`, ordered lists renumber, soft-wrapped lines
 * fold, blank-line counts normalize, etc. None of these change the rendered
 * document; they just create noisy diffs that break `markdownlint`-enforced
 * conventions.
 *
 * This guard is consulted before the extension writes the webview's serialized
 * markdown back to the TextDocument: if the incoming text is structurally
 * equivalent to what's already on disk, the write is suppressed and the
 * original bytes are preserved.
 *
 * Equivalence is "renders to the same HTML" — the strictest check that still
 * tolerates the cosmetic-only round-trip differences listed above. Whitespace
 * inside `<pre>` and inline `<code>` is preserved during normalization. Raw
 * HTML-bearing token contexts are compared source-exactly before normalization
 * because HTML and CSS can make otherwise collapsible whitespace significant.
 */

import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: true,
  // breaks:false makes single newlines render as soft breaks (a space-equivalent
  // in the rendered output), so hard-wrapping vs unwrapping a paragraph is
  // treated as cosmetic — which matches how readers see the document.
  breaks: false,
  linkify: false,
});

/**
 * Collapse runs of whitespace to a single space, but leave content inside
 * `<pre>...</pre>` and inline `<code>...</code>` untouched. Raw HTML contexts
 * have already passed an exact comparison before this normalization runs.
 */
function normalizeRenderedHtml(html: string): string {
  const verbatimRegex = /<(pre|code)\b[\s\S]*?<\/\1>/gi;
  const parts: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = verbatimRegex.exec(html)) !== null) {
    parts.push(html.slice(cursor, match.index).replace(/\s+/g, ' '));
    parts.push(match[0]);
    cursor = match.index + match[0].length;
  }
  parts.push(html.slice(cursor).replace(/\s+/g, ' '));
  return parts.join('').trim();
}

/**
 * Return source-exact contexts containing raw HTML tokens.
 *
 * Markdown-it keeps an HTML block in one token, but splits inline HTML tags
 * from the text they affect. Preserve the whole parent inline token so CSS such
 * as `white-space: pre` cannot make a collapsed text edit disappear.
 */
function rawHtmlContexts(markdown: string): string[] {
  if (!markdown.includes('<')) return [];

  const contexts: string[] = [];
  for (const token of md.parse(markdown, {})) {
    if (token.type === 'html_block') {
      contexts.push(token.content);
      continue;
    }
    if (token.type === 'inline' && token.children?.some(child => child.type === 'html_inline')) {
      contexts.push(token.content);
    }
  }
  return contexts;
}

/** Raw HTML must match exactly even when normalized rendered HTML would not. */
function hasSameRawHtmlContexts(a: string, b: string): boolean {
  const aContexts = rawHtmlContexts(a);
  const bContexts = rawHtmlContexts(b);
  return (
    aContexts.length === bContexts.length &&
    aContexts.every((context, index) => context === bContexts[index])
  );
}

/**
 * Returns true when `a` and `b` are different source strings that represent
 * the same document. Returns false when they differ in any way a reader would
 * notice (added/removed text, changed link target, edited code, etc.).
 */
export function isMarkdownStructurallyEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    if (!hasSameRawHtmlContexts(a, b)) return false;
    return normalizeRenderedHtml(md.render(a)) === normalizeRenderedHtml(md.render(b));
  } catch {
    // If either side fails to render, fall back to "not equivalent" so the
    // caller takes the safe path of writing the change through.
    return false;
  }
}

/**
 * Signature of a markdown source's blank-line layout: the sequence of
 * newline-run lengths in document order, joined as `"len1,len2,..."`. Two
 * strings with the same signature have identical blank-line spacing.
 *
 * In preserve mode the user explicitly opted in to keeping blank-line counts,
 * so `isMarkdownStructurallyEquivalent` alone is too loose — it renders both
 * sides through markdown-it and HTML doesn't encode blank-line counts. Pair it
 * with this signature comparison to detect blank-line-only edits as real
 * changes (so they hit disk) without losing the "ignore bullet-marker swaps"
 * behaviour for cosmetic round-trips.
 */
export function blankLineLayoutSignature(source: string): string {
  return (source.match(/\n+/g) ?? []).map(run => run.length).join(',');
}

/**
 * True when two markdown strings have the same blank-line layout. Strip-mode
 * callers don't need this — policy normalization makes layouts converge.
 */
export function hasSameBlankLineLayout(a: string, b: string): boolean {
  return blankLineLayoutSignature(a) === blankLineLayoutSignature(b);
}
