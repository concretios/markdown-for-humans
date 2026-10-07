/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import Code from '@tiptap/extension-code';
import Link from '@tiptap/extension-link';

/**
 * TipTap 3.30 nests Markdown marks by extension priority. Keep transparent
 * formatting marks outside links, matching the editor's established canonical
 * Markdown (`**[text](url)**` rather than `[**text**](url)`).
 */
export const MarkdownLink = Link.extend({
  priority: 90,

  /**
   * `marked`'s GFM autolink extension emits the same `type: 'link'` token for
   * an explicit `[text](url)` link and a bare autolink (`user@host`,
   * `https://…`, `www.…`) — the only signal distinguishing them is
   * `token.raw`, which keeps the leading `[` for explicit syntax but is just
   * the bare text for an autolink. The base extension's `parseMarkdown`
   * always wraps the token in a Link mark, so re-serializing always emits
   * the fully bracketed form, corrupting every bare autolink in the source
   * on save (e.g. `support@concret.io` becomes
   * `[support@concret.io](mailto:support@concret.io)`). Keep bare autolinks
   * as plain, unmarked text so they round-trip unchanged.
   */
  parseMarkdown: (token, helpers) => {
    const raw = typeof token.raw === 'string' ? token.raw : '';
    // Explicit CommonMark links use `[…](…)` or `<…>` autolink syntax. Bare
    // GFM autolinks (`user@host`, `https://…`) share the same token type but
    // their `raw` is just the bare text — keep those unmarked so they do not
    // re-serialize as bracketed links.
    const isExplicitLinkSyntax = raw.startsWith('[') || raw.startsWith('<');
    if (!isExplicitLinkSyntax) {
      return helpers.parseInline(token.tokens || []);
    }
    return helpers.applyMark('link', helpers.parseInline(token.tokens || []), {
      href: token.href,
      title: token.title || null,
      autolink: raw.startsWith('<'),
    });
  },

  /** Remembers `<https://…>` syntax so an edited paragraph writes it back unchanged. */
  addAttributes() {
    return {
      ...this.parent?.(),
      autolink: { default: false, rendered: false },
    };
  },

  /**
   * TipTap's inherited renderer wraps titles in double quotes without escaping.
   * Titles that contain `"` (or come from single-quoted source) must round-trip
   * as valid Markdown or the hyperlink is destroyed on the next open (R07).
   */
  renderMarkdown: (node, helpers, ctx) => {
    const href =
      typeof node.attrs?.href === 'string' ? node.attrs.href : ((node.attrs?.href as string) ?? '');
    const title =
      typeof node.attrs?.title === 'string' && node.attrs.title.length > 0 ? node.attrs.title : '';
    const text = helpers.renderChildren(node);
    // An autolink stays an autolink only while its text is still the address. The
    // children render as a placeholder, so compare the span's real text instead.
    const spanText: unknown = ctx?.meta?.markText;
    if (
      node.attrs?.autolink === true &&
      !title &&
      typeof spanText === 'string' &&
      (spanText === href || `mailto:${spanText}` === href)
    ) {
      return `<${text}>`;
    }
    if (!title) {
      return `[${text}](${href})`;
    }
    if (title.includes('"') && !title.includes("'")) {
      return `[${text}](${href} '${title.replace(/\\/g, '\\\\')}')`;
    }
    const escapedTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `[${text}](${href} "${escapedTitle}")`;
  },
});

/**
 * Inline code must be the innermost Markdown mark. Markdown inside a code span
 * is literal, so placing code outside italic, strike, or link syntax changes
 * the document meaning on the next parse.
 */
export const MarkdownCode = Code.extend({
  priority: 80,
});
