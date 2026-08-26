/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Mark } from '@tiptap/core';
import { PRESERVED_MARKDOWN_LITERAL_TOKEN } from '../utils/markedLexerNormalizer';

/**
 * Internal, non-editing mark for empty link/image source that Marked recognizes
 * but ProseMirror cannot represent as a real link or image. `code: true` tells
 * TipTap's Markdown serializer not to escape the already-validated raw source;
 * the mark itself adds no Markdown delimiters.
 */
export const PreservedMarkdownLiteral = Mark.create({
  name: PRESERVED_MARKDOWN_LITERAL_TOKEN,

  code: true,

  inclusive: false,

  renderHTML() {
    return ['span', { 'data-mdh-preserved-markdown-literal': '' }, 0];
  },

  markdownTokenName: PRESERVED_MARKDOWN_LITERAL_TOKEN,

  parseMarkdown: (token, helpers) => {
    const text = typeof token.text === 'string' ? token.text : token.raw || '';
    return helpers.applyMark(PRESERVED_MARKDOWN_LITERAL_TOKEN, [helpers.createTextNode(text)]);
  },

  renderMarkdown: (node, helpers) => helpers.renderChildren(node.content || []),
});
