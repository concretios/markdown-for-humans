/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import Paragraph from '@tiptap/extension-paragraph';
import type { JSONContent, MarkdownRendererHelpers, RenderContext } from '@tiptap/core';
import { parseHtmlImageAttributes } from './htmlImageSource';

function isMeaningfulTextNode(node: JSONContent): boolean {
  if (node.type !== 'text') return false;
  const text = typeof node.text === 'string' ? node.text : '';
  return text.trim().length > 0;
}

function isMeaningfulInlineNode(node: JSONContent): boolean {
  if (!node || typeof node.type !== 'string') return false;
  if (node.type === 'hardBreak' || node.type === 'hard_break') return false;
  if (node.type === 'text') return isMeaningfulTextNode(node);
  return true;
}

export const MarkdownParagraph = Paragraph.extend({
  parseMarkdown(token, helpers) {
    const tokens = token.tokens || [];
    // TipTap assumes its default block Image and unwraps an image-only paragraph.
    // Our image is inline, so keep this boundary to prevent schema repair from
    // merging adjacent SVG/raster paragraphs and changing the saved source.
    if (tokens.length === 1 && tokens[0].type === 'image') {
      return helpers.createNode('paragraph', undefined, helpers.parseInline(tokens));
    }
    return Paragraph.config.parseMarkdown?.call(this, token, helpers) || [];
  },
  renderMarkdown: renderMarkdownParagraph as unknown as (
    node: JSONContent,
    helpers: MarkdownRendererHelpers,
    ctx: RenderContext
  ) => string,
});

/** Serialize an inline paragraph without letting a sized image swallow later Markdown. */
export function renderMarkdownParagraph(
  node: JSONContent,
  helpers: MarkdownRendererHelpers,
  _context: RenderContext
): string | null {
  const children = node.content || [];
  let content = helpers.renderChildren(children);
  const firstBreak = children.findIndex(child => child.type === 'hardBreak');
  const indentedImages =
    children[0]?.type === 'image' &&
    /^(?: {4}|\t)/.test(String(children[0].attrs?.['indent-prefix'] || '')) &&
    children.every(child => child.type === 'image' || child.type === 'hardBreak');
  if (indentedImages && firstBreak > 0) {
    // IndentedImageCodeBlock already treats each physical image line as a break.
    // Adding two spaces would become preserved HTML source and grow on each save.
    content = children
      .map(child => (child.type === 'hardBreak' ? '\n' : helpers.renderChildren([child])))
      .join('');
  } else if (children[0]?.type === 'image' && firstBreak > 0) {
    const leading = helpers.renderChildren(children.slice(0, firstBreak));
    // A standalone HTML image followed by a two-space break opens a CommonMark
    // HTML block, making the rest of this paragraph literal on reopen (SVG R1).
    // The standard backslash break keeps inline Markdown parsing active. Authored
    // HTML blocks have no hardBreak node here and retain their exact source.
    if (parseHtmlImageAttributes(leading) && !/^(?: {4}|\t)/.test(leading)) {
      content = `${leading.replace(/[ \t]+$/, '')}\\\n${helpers.renderChildren(children.slice(firstBreak + 1))}`;
    }
  }

  const hasMeaningfulContent =
    Array.isArray(node.content) &&
    node.content.some((child: JSONContent) => isMeaningfulInlineNode(child));

  if (!hasMeaningfulContent && content.trim() === '') {
    return null;
  }

  return content;
}
