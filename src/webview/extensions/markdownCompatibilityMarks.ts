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
    const isExplicitLinkSyntax = typeof token.raw === 'string' && token.raw.startsWith('[');
    if (!isExplicitLinkSyntax) {
      return helpers.parseInline(token.tokens || []);
    }
    return helpers.applyMark('link', helpers.parseInline(token.tokens || []), {
      href: token.href,
      title: token.title || null,
    });
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
