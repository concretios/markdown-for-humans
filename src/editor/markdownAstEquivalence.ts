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
 * Feedback additionally tolerates generated emphasis/strong spans split around
 * a line break. Ordinary document-write equivalence keeps its stricter contract.
 */

import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

const md = new MarkdownIt({
  html: true,
  // breaks:false makes single newlines render as soft breaks (a space-equivalent
  // in the rendered output), so hard-wrapping vs unwrapping a paragraph is
  // treated as cosmetic — which matches how readers see the document.
  breaks: false,
  linkify: false,
});

// The rich editor intentionally treats a single source newline as a visible
// break (`markedOptions.breaks: true`). TipTap then serializes that node with
// two trailing spaces. Feedback snapshot verification must compare the source
// using the same rendering contract or a byte-preserving authoritative apply
// can be rejected solely because of this canonical hard-break form.
const rendererMd = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: false,
});

const STANDALONE_IMAGE_LINE_WITH_SPACES_REGEX =
  /^([ \t]*)!\[([^\]\n]*)\]\(\s*([^\n)]*?\s+[^\n)]*?)\s*\)[ \t]*$/gm;

/**
 * Apply the same narrow space-containing image fallback as the rich editor.
 * TipTap emits the CommonMark angle-bracket form after parsing the convenient
 * bare form, so renderer verification must compare both under that contract.
 */
function normalizeSpaceFriendlyImagePaths(markdown: string): string {
  return markdown.replace(
    STANDALONE_IMAGE_LINE_WITH_SPACES_REGEX,
    (line, indent: string, alt: string, rawDestination: string) => {
      const destination = rawDestination.trim();
      if (
        destination.includes('"') ||
        destination.includes("'") ||
        (destination.startsWith('<') && destination.endsWith('>'))
      ) {
        return line;
      }
      return `${indent}![${alt}](<${destination}>)`;
    }
  );
}

/**
 * Collapse runs of whitespace to a single space, but leave content inside
 * `<pre>...</pre>` and inline `<code>...</code>` untouched. Raw HTML contexts
 * have already passed an exact comparison before normalization runs.
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
 * Hide only the source-format paragraph wrappers of single-paragraph list
 * items, optionally followed by nested lists or code. Using token levels keeps nested
 * items independent and lets Markdown-it omit generated boundary newlines.
 * Code is still compared verbatim. Multiple paragraphs and other block content
 * retain their full structure.
 * Mutates only the fresh comparison tokens, in one linear pass.
 */
function normalizeListParagraphs(tokens: Token[]): void {
  const items: Array<{
    level: number;
    paragraphCount: number;
    paragraphOpen?: Token;
    paragraphClose?: Token;
    hasOtherBlocks: boolean;
  }> = [];

  for (const token of tokens) {
    if (token.type === 'list_item_open') {
      items.push({ level: token.level, paragraphCount: 0, hasOtherBlocks: false });
      continue;
    }
    if (token.type === 'list_item_close') {
      const item = items.pop();
      if (
        item?.paragraphCount === 1 &&
        !item.hasOtherBlocks &&
        item.paragraphOpen &&
        item.paragraphClose
      ) {
        item.paragraphOpen.hidden = true;
        item.paragraphClose.hidden = true;
      }
      continue;
    }
    const item = items[items.length - 1];
    if (!item || token.level !== item.level + 1) continue;
    if (token.type === 'paragraph_open') {
      item.paragraphCount++;
      item.paragraphOpen = token;
    } else if (token.type === 'paragraph_close') {
      item.paragraphClose = token;
    } else if (
      token.nesting >= 0 &&
      token.type !== 'bullet_list_open' &&
      token.type !== 'ordered_list_open' &&
      token.type !== 'fence' &&
      token.type !== 'code_block'
    ) {
      item.hasOtherBlocks = true;
    }
  }
}

/**
 * Join matching generated italic/bold spans separated only by one line break.
 * QA-001: TipTap closes and reopens marks around hardBreak nodes even when the
 * source span is continuous. Cancel only matching boundary pairs, preserving
 * nesting, the break itself, and all content. Links, code and other tokens are
 * barriers. Runs linearly on fresh inline tokens after raw-HTML validation.
 */
function normalizeInlineMarksAtBreaks(tokens: Token[]): void {
  for (const token of tokens) {
    if (token.type !== 'inline' || !token.children) continue;
    // Markdown-it emits empty text tokens at some nested emphasis boundaries.
    // They render nothing but would otherwise hide adjacent matching marks.
    const children = token.children.filter(child => child.type !== 'text' || child.content !== '');
    const normalized: Token[] = [];
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (child.type === 'softbreak' || child.type === 'hardbreak') {
        while (index + 1 < children.length) {
          const closing = normalized[normalized.length - 1];
          const opening = children[index + 1];
          if (!(
            (closing?.type === 'em_close' && opening.type === 'em_open') ||
            (closing?.type === 'strong_close' && opening.type === 'strong_open')
          )) {
            break;
          }
          normalized.pop();
          index++;
        }
      }
      normalized.push(child);
    }
    token.children = normalized;
  }
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
  return isEquivalentWhenRendered(a, b, md, false);
}

/**
 * Return true when both strings render identically under the rich editor's
 * single-newline-as-break contract. This is narrower than source equality but
 * intentionally accepts TipTap's `  \n` serialization of a source soft wrap
 * and matching italic/bold spans split at that break, plus single-paragraph
 * list tightness, without losing content, formatting or real block structure.
 */
export function isMarkdownRendererEquivalent(a: string, b: string): boolean {
  return isEquivalentWhenRendered(
    normalizeSpaceFriendlyImagePaths(a),
    normalizeSpaceFriendlyImagePaths(b),
    rendererMd,
    true
  );
}

/** Compare two Markdown strings with one explicit rendering contract. */
function isEquivalentWhenRendered(
  a: string,
  b: string,
  renderer: MarkdownIt,
  useRendererNormalization: boolean
): boolean {
  if (a === b) return true;
  try {
    const tokensA = renderer.parse(a, {});
    const tokensB = renderer.parse(b, {});
    const renderedA = renderer.renderer.render(tokensA, renderer.options, {});
    const renderedB = renderer.renderer.render(tokensB, renderer.options, {});
    // An exact match before any whitespace normalization is the strongest
    // possible proof of equivalence: nothing was collapsed away, so a tag
    // TipTap converts to equivalent native syntax (e.g. <strong> -> **bold**)
    // can't be mistaken for a real edit just because its raw-HTML token count
    // changed on one side.
    if (renderedA === renderedB) return true;
    if (!hasSameRawHtmlContexts(a, b)) return false;
    if (useRendererNormalization) {
      normalizeListParagraphs(tokensA);
      normalizeListParagraphs(tokensB);
      normalizeInlineMarksAtBreaks(tokensA);
      normalizeInlineMarksAtBreaks(tokensB);
      return (
        normalizeRenderedHtml(renderer.renderer.render(tokensA, renderer.options, {})) ===
        normalizeRenderedHtml(renderer.renderer.render(tokensB, renderer.options, {}))
      );
    }
    return normalizeRenderedHtml(renderedA) === normalizeRenderedHtml(renderedB);
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
  // Normalize CRLF to LF first: a CRLF blank line ("\r\n\r\n") has its two \n
  // characters separated by \r, so the bare regex would count it as two runs
  // of length 1 instead of one run of length 2 - a line-ending artifact, not
  // an actual blank-line-count difference.
  return (source.replace(/\r\n/g, '\n').match(/\n+/g) ?? []).map(run => run.length).join(',');
}

/**
 * True when two markdown strings have the same blank-line layout. Strip-mode
 * callers don't need this — policy normalization makes layouts converge.
 */
export function hasSameBlankLineLayout(a: string, b: string): boolean {
  return blankLineLayoutSignature(a) === blankLineLayoutSignature(b);
}
