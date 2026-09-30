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

/** Token type consumed by the SoftBreak node extension. */
export const SOFT_BREAK_TOKEN = 'softbreak';

const NEWLINE = '\n';

function softBreakToken(): RawToken {
  return { type: SOFT_BREAK_TOKEN, raw: NEWLINE };
}

function isBareNewlineBreak(token: RawToken): boolean {
  return token.type === 'br' && token.raw === NEWLINE;
}

/**
 * Split an inline `text` token on bare newlines, interleaving `softbreak`
 * tokens. `raw` on each piece is set to that piece's text: the tiptap text
 * handler reads `text`, and nothing downstream reads `raw` on inline text.
 */
function splitTextTokenOnNewlines(token: RawToken): RawToken[] {
  const text = token.text as string;
  if (!text.includes(NEWLINE)) return [token];
  return text.split(NEWLINE).flatMap((piece, index) => {
    const pieces: RawToken[] = index > 0 ? [softBreakToken()] : [];
    if (piece.length > 0) pieces.push({ ...token, raw: piece, text: piece });
    return pieces;
  });
}

type TokenMapper = (tokens: RawToken[]) => RawToken[];

function mapCellTokens(cell: RawToken, map: TokenMapper): RawToken {
  return Array.isArray(cell.tokens) ? { ...cell, tokens: map(cell.tokens as RawToken[]) } : cell;
}

function hasChildTokens(token: RawToken): boolean {
  return (
    Array.isArray(token.tokens) ||
    Array.isArray(token.items) ||
    Array.isArray(token.header) ||
    Array.isArray(token.rows)
  );
}

/**
 * Return a copy of `token` with `map` applied to every child token array:
 * `tokens` (paragraph/heading/blockquote/list_item inlines), `items` (lists),
 * and table cells (`header` is a cell array, `rows` an array of cell arrays).
 */
function mapChildTokens(token: RawToken, map: TokenMapper): RawToken {
  const next: RawToken = { ...token };
  if (Array.isArray(token.tokens)) next.tokens = map(token.tokens as RawToken[]);
  if (Array.isArray(token.items)) next.items = map(token.items as RawToken[]);
  if (Array.isArray(token.header)) {
    next.header = (token.header as RawToken[]).map(cell => mapCellTokens(cell, map));
  }
  if (Array.isArray(token.rows)) {
    next.rows = (token.rows as RawToken[][]).map(row =>
      Array.isArray(row) ? row.map(cell => mapCellTokens(cell, map)) : row
    );
  }
  return next;
}

/**
 * Give CommonMark soft line breaks (spec §6.8) their own token so the
 * SoftBreak node can render them as a space on screen while serialising them
 * back to "\n" on save.
 *
 * With the marked `breaks` option off, a single source newline stays as a
 * literal `\n` inside the inline `text` token. That `\n` would flow into the
 * ProseMirror text node unchanged and, because prosemirror-view renders the
 * editable surface with `white-space: break-spaces`, still display as a line
 * break. This pass:
 *
 * - splits inline `text` tokens on `\n`, inserting a `softbreak` token at
 *   each newline;
 * - demotes `br` tokens whose raw is exactly a bare newline to `softbreak`.
 *   Explicit hard breaks (trailing two spaces `"  \n"` or a backslash
 *   `"\\\n"`) have a different raw and are preserved, matching CommonMark;
 * - never touches `code`/`codespan` tokens (distinct types; newlines there
 *   are content); recurses through `tokens`/`items`/table cells.
 *
 * Pure: returns a new token array and never mutates the input.
 */
export function emitSoftBreakTokens<T extends RawToken[]>(tokens: T): T {
  const out = tokens.flatMap((token): RawToken[] => {
    if (!token || typeof token.type !== 'string') return [token];
    if (isBareNewlineBreak(token)) return [softBreakToken()];
    if (hasChildTokens(token)) return [mapChildTokens(token, emitSoftBreakTokens)];
    if (token.type === 'text' && typeof token.text === 'string') {
      return splitTextTokenOnNewlines(token);
    }
    return [token];
  });
  return out as T;
}

/**
 * Wrap a marked instance's lexer entry points so every parse pass routes
 * through `normalizeBlankLineGreedyTokens`, and, while `shouldEmitSoftBreaks`
 * returns true (`markdownForHumans.render.singleLineBreaks` off), through
 * `emitSoftBreakTokens`.
 *
 * TipTap 3.30 constructs `Lexer` directly for top-level parsing and calls
 * `lexer()` for nested reparses, so both public paths are covered. The wrapper
 * is installed once per instance; re-installing only swaps in the latest
 * predicate. marked is a module-level singleton, so a predicate frozen from
 * the first install would pin the setting for the life of the webview.
 */
export function installBlankLineLexerNormalizer(
  markedInstance: unknown,
  shouldEmitSoftBreaks?: () => boolean
): void {
  interface LexerInstance {
    lex(src: string): RawToken[];
  }
  type LexerConstructor = new (options?: unknown) => LexerInstance;

  const inst = markedInstance as {
    Lexer?: LexerConstructor;
    lexer?: (src: string, options?: unknown) => RawToken[];
    __mdh_blankLineNormalizerInstalled?: boolean;
    __mdh_shouldEmitSoftBreaks?: () => boolean;
  };
  if (!inst) return;
  inst.__mdh_shouldEmitSoftBreaks = shouldEmitSoftBreaks;
  if (inst.__mdh_blankLineNormalizerInstalled) return;

  const normalize = (tokens: RawToken[]): RawToken[] => {
    const blankNormalized = normalizeBlankLineGreedyTokens(tokens);
    return inst.__mdh_shouldEmitSoftBreaks?.()
      ? emitSoftBreakTokens(blankNormalized)
      : blankNormalized;
  };

  let installed = false;

  if (typeof inst.Lexer === 'function') {
    const OriginalLexer = inst.Lexer;
    inst.Lexer = class NormalizingLexer extends OriginalLexer {
      lex(src: string): RawToken[] {
        return normalize(super.lex(src));
      }
    };
    installed = true;
  }

  if (typeof inst.lexer === 'function') {
    const original = inst.lexer.bind(inst);
    inst.lexer = function patchedLexer(src: string, options?: unknown): RawToken[] {
      return normalize(original(src, options));
    };
    installed = true;
  }

  if (installed) {
    inst.__mdh_blankLineNormalizerInstalled = true;
  }
}
