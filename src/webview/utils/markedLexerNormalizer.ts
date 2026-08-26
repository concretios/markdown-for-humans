/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Several marked block tokenizers (heading, lheading, table, code, hr, list,
 * blockquote, html) match trailing `\n+` greedily, swallowing any blank lines
 * that follow into their own raw field. As a result no separate "space" token
 * is emitted for those blank lines, and our BlankLinePreservation extension
 * cannot see them.
 *
 * `normalizeBlankLineGreedyTokens` walks a marked token stream and, for any
 * such block whose raw ends with two or more newlines, splits the trailing
 * newlines off into a synthetic "space" token. The block's raw is shortened
 * to the content (without trailing whitespace) and a `space` token with the
 * full run of newlines is inserted directly after — matching the shape marked
 * emits naturally for paragraphs.
 *
 * This makes `BlankLinePreservation` (which keys off "space" tokens) work
 * uniformly across all block types.
 */

type RawToken = { type?: string; raw?: string } & Record<string, unknown>;

export const PRESERVED_MARKDOWN_LITERAL_TOKEN = 'preservedMarkdownLiteral';

/**
 * Detect link/image inline tokens whose VISIBLE text is empty.
 *
 * A `link` or `image` with empty visible content (no inner tokens, or all
 * inner tokens render to nothing) parses through the @tiptap/markdown
 * pipeline as an empty inline node; ProseMirror schema validation then drops
 * it, silently erasing the original markdown source from the document. This
 * happens regardless of where the empty inline sits — alone in a paragraph
 * (`[]()`), next to a soft break (`Even deeper.\n[]()`), in the middle of
 * other text (`foo []() bar`), or inside a list item / blockquote.
 *
 * We catch each empty link/image at the lexer layer and rewrite it to a token
 * handled by PreservedMarkdownLiteral. The resulting text remains visible in
 * the editor, but TipTap does not escape its already-validated raw markdown on
 * save. Re-lexing routes through this same normaliser to keep the cycle stable.
 */
function isInlineRenderEmpty(tok: RawToken | undefined): boolean {
  if (!tok || typeof tok.type !== 'string') return true;
  if (tok.type === 'text' || tok.type === 'escape') {
    const text = typeof tok.text === 'string' ? tok.text : '';
    return text.trim().length === 0;
  }
  if (tok.type === 'image') {
    // An image with a valid src/href is visible regardless of alt text — `<img>`
    // does not need an alt to render. Only treat the token as render-empty when
    // BOTH alt and href are missing, so `![](url)` survives as a real image
    // node (and gets URL-checked by the audit) instead of being demoted to
    // literal text.
    const href =
      typeof (tok as { href?: string }).href === 'string'
        ? ((tok as { href?: string }).href as string)
        : '';
    if (href.trim().length > 0) return false;
    const text =
      typeof (tok as { text?: string }).text === 'string'
        ? ((tok as { text?: string }).text as string)
        : '';
    if (text.trim().length > 0) return false;
    const inner = Array.isArray((tok as { tokens?: RawToken[] }).tokens)
      ? ((tok as { tokens?: RawToken[] }).tokens as RawToken[])
      : [];
    return inner.every(isInlineRenderEmpty);
  }
  if (tok.type === 'link') {
    const text =
      typeof (tok as { text?: string }).text === 'string'
        ? ((tok as { text?: string }).text as string)
        : '';
    if (text.trim().length > 0) return false;
    const inner = Array.isArray((tok as { tokens?: RawToken[] }).tokens)
      ? ((tok as { tokens?: RawToken[] }).tokens as RawToken[])
      : [];
    return inner.every(isInlineRenderEmpty);
  }
  return false;
}

function isEmptyLinkLike(tok: RawToken): boolean {
  if (!tok || (tok.type !== 'link' && tok.type !== 'image')) return false;
  return isInlineRenderEmpty(tok);
}

/**
 * Marked emits a few empty-link-shaped forms as plain text rather than link or
 * image tokens. Preserve only the exact forms the editor historically kept;
 * ordinary text remains subject to TipTap 3.30's Markdown escaping.
 */
function isPlainEmptyLinkLike(tok: RawToken): boolean {
  if (tok.type !== 'text' || typeof tok.raw !== 'string') return false;
  return /^(?:\[\]|\[\]\[\]|!\[\]\(\s*\))$/.test(tok.raw);
}

/**
 * Walk a paragraph's inline-token array and replace every empty link/image
 * with an internal raw-literal token. Mutates the array in place. Returns
 * whether any rewrite happened.
 */
function rewriteEmptyInlines(inlines: RawToken[]): boolean {
  let changed = false;
  for (let i = 0; i < inlines.length; i++) {
    const tok = inlines[i];
    if (!tok) continue;
    if (isEmptyLinkLike(tok) || isPlainEmptyLinkLike(tok)) {
      const raw = typeof tok.raw === 'string' ? tok.raw : '';
      if (raw.length > 0) {
        inlines[i] = { type: PRESERVED_MARKDOWN_LITERAL_TOKEN, raw, text: raw } as RawToken;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Recursively walk the token tree, applying inline rewriting to every
 * paragraph node we find — including paragraphs nested inside list items
 * and blockquotes. Marked's tree shape:
 *   - `paragraph`: inline tokens in `tokens`
 *   - `blockquote`: child blocks in `tokens`
 *   - `list`: child items in `items`
 *   - `list_item`: child blocks in `tokens`
 */
function normalizeEmptyInlinesDeep(tokens: RawToken[] | undefined): void {
  if (!Array.isArray(tokens)) return;
  for (const token of tokens) {
    if (!token || typeof token.type !== 'string') continue;
    // `paragraph` (block-level) and `text` (the block-level text token marked
    // emits for tight list items) both carry their inline tokens in `.tokens`.
    if (token.type === 'paragraph' || token.type === 'text') {
      const inlines = (token as { tokens?: RawToken[] }).tokens;
      if (Array.isArray(inlines)) rewriteEmptyInlines(inlines);
      continue;
    }
    if (token.type === 'list') {
      normalizeEmptyInlinesDeep((token as { items?: RawToken[] }).items);
      continue;
    }
    if (token.type === 'list_item' || token.type === 'blockquote' || token.type === 'table') {
      normalizeEmptyInlinesDeep((token as { tokens?: RawToken[] }).tokens);
      continue;
    }
  }
}

/**
 * Container tags whose fragments are destroyed, not merely unwrapped, when an
 * HTML block is parsed in isolation.
 *
 * Marked ends an HTML block at the first blank line, so a pretty-printed table
 * like
 *
 *     <table>
 *       <thead>…</thead>
 *
 *       <tbody>…</tbody>
 *     </table>
 *
 * arrives as several separate `html` tokens. Each is handed to the DOM parser
 * on its own, and the HTML parsing spec drops table-scoped elements that are
 * not inside a `<table>` — so the `<tbody>` fragment collapses to bare text and
 * the table is flattened into a run of paragraphs. Merging the fragments back
 * into one token before parsing is what keeps the grid intact.
 */
const MERGEABLE_CONTAINER_TAGS = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'colgroup',
  'ul',
  'ol',
  'li',
  'dl',
  'details',
  'blockquote',
  'figure',
  'div',
]);

/** Elements that never have a closing tag, so they must not open a scope. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;

/**
 * Track unclosed container tags across a run of HTML text.
 *
 * Returns the updated stack. A non-empty stack means the HTML so far opens a
 * container it never closes, i.e. the block was cut short.
 */
function trackOpenContainers(html: string, stack: string[]): string[] {
  // Comments and raw-text elements can contain angle brackets that are not
  // markup; strip them so they cannot skew the balance.
  const scannable = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|textarea)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '');

  TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_PATTERN.exec(scannable)) !== null) {
    const isClosing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    const isSelfClosing = match[3] === '/';

    if (!MERGEABLE_CONTAINER_TAGS.has(tagName) || VOID_TAGS.has(tagName) || isSelfClosing) {
      continue;
    }

    if (isClosing) {
      // Pop to the matching open tag. Unmatched closers (the tail half of a
      // split block) are ignored rather than underflowing the stack.
      const openIndex = stack.lastIndexOf(tagName);
      if (openIndex !== -1) {
        stack.length = openIndex;
      }
    } else {
      stack.push(tagName);
    }
  }

  return stack;
}

function tokenRawText(token: RawToken): string {
  return typeof token.raw === 'string' ? token.raw : '';
}

/**
 * Document-level scaffolding that carries no content of its own.
 *
 * These appear whenever a whole HTML page is dropped into a markdown file.
 * `<title>` is included with its text because the title belongs to the document
 * head, not the body — left alone it surfaces as a stray paragraph at the top
 * of the editor.
 */
const STRUCTURAL_MARKUP =
  /<!--[\s\S]*?(?:-->|$)|<!doctype[^>]*>|<\/?(?:html|head|body)\b[^>]*>|<title\b[^>]*>[\s\S]*?<\/title\s*>|<(?:meta|link|base)\b[^>]*>/gi;

/** A run made up only of closing tags can never contribute content. */
const CLOSING_TAGS_ONLY = /^(?:\s*<\/[a-zA-Z][a-zA-Z0-9-]*\s*>\s*)+$/;

/**
 * Detect `html` tokens that parse to nothing renderable.
 *
 * `@tiptap/markdown` runs each HTML token through `generateJSON`, and a
 * fragment with no renderable content still yields a doc holding one empty
 * paragraph — which lands in the document as a blank line. So `<!DOCTYPE html>`,
 * the `<html><head>…<body>` wrapper, `</body></html>`, an HTML comment, or a
 * stray `</p>` each inserted a visible gap. Dropping the token removes the gap
 * without disturbing the blocks either side, which keep their own separators.
 */
function isContentFreeHtmlToken(token: RawToken): boolean {
  if (token.type !== 'html') return false;

  const remainder = tokenRawText(token).replace(STRUCTURAL_MARKUP, '').trim();
  if (remainder.length === 0) return true;

  return CLOSING_TAGS_ONLY.test(remainder);
}

/**
 * Re-join `html` tokens that marked split apart at a blank line.
 *
 * Only `space` and `html` tokens are absorbed, and only while the accumulated
 * HTML still has an unclosed container. If the run never balances, the original
 * tokens are emitted untouched so this can never make a document worse than
 * marked's own output.
 */
export function mergeSplitHtmlBlocks(tokens: RawToken[]): RawToken[] {
  const out: RawToken[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (!token || token.type !== 'html') {
      out.push(token);
      continue;
    }

    const stack = trackOpenContainers(tokenRawText(token), []);
    if (stack.length === 0) {
      out.push(token);
      continue;
    }

    // Look ahead for the rest of the block.
    let combined = tokenRawText(token);
    let cursor = i + 1;
    let balancedAt = -1;

    while (cursor < tokens.length) {
      const next = tokens[cursor];
      if (!next || (next.type !== 'html' && next.type !== 'space')) {
        break;
      }

      combined += tokenRawText(next);
      if (next.type === 'html') {
        trackOpenContainers(tokenRawText(next), stack);
        if (stack.length === 0) {
          balancedAt = cursor;
          break;
        }
      }
      cursor++;
    }

    if (balancedAt === -1) {
      // Never closed — leave marked's tokens alone.
      out.push(token);
      continue;
    }

    out.push({
      ...token,
      raw: combined,
      text: combined,
    } as RawToken);
    i = balancedAt;
  }

  return out;
}

const GREEDY_BLOCK_TYPES = new Set([
  'heading',
  'table',
  'code',
  'hr',
  'lheading',
  'list',
  'blockquote',
  'html',
]);

function splitTrailingNewlines(token: RawToken): RawToken[] {
  const raw = typeof token.raw === 'string' ? token.raw : '';
  const match = raw.match(/\n+$/);
  if (!match || match[0].length < 2) {
    return [token];
  }

  const trailing = match[0];
  const trimmedRaw = raw.slice(0, raw.length - trailing.length);

  // Mutate raw on the original token. Other fields (text, depth, tokens, …)
  // were derived from a regex capture that doesn't include trailing
  // whitespace anyway, so they remain valid.
  token.raw = trimmedRaw;

  return [token, { type: 'space', raw: trailing } as RawToken];
}

/**
 * Walk a token array (as produced by `marked.lexer(src)`) and split blank-line
 * runs that were greedily absorbed by block tokens into synthetic space
 * tokens. Preserves the array's `links` property (marked attaches reference
 * link definitions to the tokens array as a non-index property).
 */
export function normalizeBlankLineGreedyTokens<T extends RawToken[]>(tokens: T): T {
  // Rewrite empty link/image inlines at every depth before the greedy-newline
  // split runs — that way both whole-empty paragraphs (`[]()`) and mixed
  // paragraphs (`Even deeper.\n[]()`) carry the original markdown forward as
  // preserved text instead of letting the inline get stripped on parse.
  normalizeEmptyInlinesDeep(tokens);

  // Re-join HTML blocks marked cut at a blank line before the greedy-newline
  // split runs, so a merged block still gets its own trailing space token.
  // Then drop scaffolding-only fragments, which would each render as a blank
  // line. Merging first means a fragment is only judged once it is whole.
  const merged = mergeSplitHtmlBlocks(tokens).filter(token => !isContentFreeHtmlToken(token));

  const out: RawToken[] = [];
  for (const token of merged) {
    if (token && typeof token.type === 'string' && GREEDY_BLOCK_TYPES.has(token.type)) {
      out.push(...splitTrailingNewlines(token));
    } else {
      out.push(token);
    }
  }

  // Preserve the `links` side-channel that marked attaches to the tokens array.
  const links = (tokens as unknown as { links?: unknown }).links;
  if (links !== undefined) {
    (out as unknown as { links?: unknown }).links = links;
  }

  return out as T;
}

/**
 * Wrap a marked instance's lexer entry points so every parse pass routes
 * through `normalizeBlankLineGreedyTokens`. TipTap 3.30 constructs `Lexer`
 * directly for top-level parsing and calls `lexer()` for nested reparses, so
 * both public paths are covered. Idempotent on the same marked instance.
 */
export function installBlankLineLexerNormalizer(markedInstance: unknown): void {
  interface LexerInstance {
    lex(src: string): RawToken[];
  }
  type LexerConstructor = new (options?: unknown) => LexerInstance;

  const inst = markedInstance as {
    Lexer?: LexerConstructor;
    lexer?: (src: string, options?: unknown) => RawToken[];
    __mdh_blankLineNormalizerInstalled?: boolean;
  };
  if (!inst) return;
  if (inst.__mdh_blankLineNormalizerInstalled) return;

  let installed = false;

  if (typeof inst.Lexer === 'function') {
    const OriginalLexer = inst.Lexer;
    inst.Lexer = class NormalizingLexer extends OriginalLexer {
      lex(src: string): RawToken[] {
        return normalizeBlankLineGreedyTokens(super.lex(src));
      }
    };
    installed = true;
  }

  if (typeof inst.lexer === 'function') {
    const original = inst.lexer.bind(inst);
    inst.lexer = function patchedLexer(src: string, options?: unknown): RawToken[] {
      return normalizeBlankLineGreedyTokens(original(src, options));
    };
    installed = true;
  }

  if (installed) {
    inst.__mdh_blankLineNormalizerInstalled = true;
  }
}
