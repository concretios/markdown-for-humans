/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * HTML comment block.
 *
 * A comment-only HTML block (`<!-- medium: export as image -->`) has nothing to
 * render, but it is part of the file. The lexer normalizer turns it into an
 * `htmlComment` token; this node shows it as a muted marker and saves the raw
 * source unchanged. `tightAfter` records that no blank line followed it, so a
 * comment written directly above a table keeps that layout on save.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import type { JSONContent, MarkdownToken } from '@tiptap/core';
import { HTML_COMMENT_TOKEN } from '../utils/markedLexerNormalizer';

export const HtmlComment = Node.create({
  name: HTML_COMMENT_TOKEN,

  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      raw: { default: '', rendered: false },
      tightAfter: { default: false, rendered: false },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-html-comment]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-html-comment': '',
        class: 'md4h-html-comment',
        contenteditable: 'false',
      }),
      String(node.attrs.raw),
    ];
  },

  markdownTokenName: HTML_COMMENT_TOKEN,

  parseMarkdown: (token: MarkdownToken, helpers) => {
    const { raw, tightAfter } = token as unknown as { raw: string; tightAfter?: boolean };
    return helpers.createNode(
      HTML_COMMENT_TOKEN,
      { raw: raw.replace(/\s+$/, ''), tightAfter: tightAfter === true },
      []
    );
  },

  renderMarkdown: ((node: JSONContent) => String(node.attrs?.raw ?? '')) as unknown as never,
});
