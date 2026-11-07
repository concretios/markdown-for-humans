/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Mark } from '@tiptap/core';
import MarkdownIt from 'markdown-it';
import { PRESERVED_MARKDOWN_LITERAL_TOKEN } from '../utils/markedLexerNormalizer';

const entityParser = new MarkdownIt();
const ENTITY_AT_START = /^&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][\da-fA-F]{1,6});/;

/** Use Markdown's entity rule for invalid numeric references and complete named entities. */
function decodeEntity(raw: string): string {
  // The attribute-oriented unescapeAll helper accepts partial names and leaves
  // invalid numeric references untouched, unlike Markdown's inline text rule.
  return entityParser.parseInline(raw, {})[0]?.children?.[0]?.content ?? raw;
}

/**
 * Internal, non-editing mark for empty link/image source that Marked recognizes
 * but ProseMirror cannot represent as a real link or image. `code: true` tells
 * TipTap's Markdown serializer not to escape the already-validated raw source;
 * the mark itself adds no Markdown delimiters. Entities carry their actual
 * decoded text plus nonvisual source attributes, never placeholder characters.
 * The sync serializer retains that source only while the decoded text matches.
 */
export const PreservedMarkdownLiteral = Mark.create({
  name: PRESERVED_MARKDOWN_LITERAL_TOKEN,

  code: true,

  inclusive: false,

  addAttributes() {
    return {
      entitySource: { default: null, rendered: false },
      entityText: { default: null, rendered: false },
    };
  },

  renderHTML() {
    return ['span', { 'data-mdh-preserved-markdown-literal': '' }, 0];
  },

  markdownTokenName: PRESERVED_MARKDOWN_LITERAL_TOKEN,

  // An inline tokenizer runs only where entities have Markdown text meaning.
  // Marked consumes code, destinations and raw HTML through their own parsers.
  markdownTokenizer: {
    name: PRESERVED_MARKDOWN_LITERAL_TOKEN,
    level: 'inline',
    start: source => source.indexOf('&'),
    tokenize: source => {
      const raw = source.match(ENTITY_AT_START)?.[0];
      if (!raw) return undefined;
      const text = decodeEntity(raw);
      if (text === raw) return undefined;
      return { type: PRESERVED_MARKDOWN_LITERAL_TOKEN, raw, text, entitySource: raw };
    },
  },

  parseMarkdown: (token, helpers) => {
    const text = typeof token.text === 'string' ? token.text : token.raw || '';
    const attrs =
      typeof token.entitySource === 'string'
        ? { entitySource: token.entitySource, entityText: text }
        : undefined;
    return helpers.applyMark(
      PRESERVED_MARKDOWN_LITERAL_TOKEN,
      [helpers.createTextNode(text)],
      attrs
    );
  },

  renderMarkdown: (node, helpers) => helpers.renderChildren(node.content || []),
});
