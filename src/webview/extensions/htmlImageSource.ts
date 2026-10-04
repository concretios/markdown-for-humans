/**
 * Copyright (c) 2026 Concret.io
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Preserve supported HTML image source while its semantic attributes are unchanged.
 * Explicit display dimensions require HTML because Markdown has no size attribute.
 */
import { Extension, type MarkdownToken, type MarkdownParseHelpers } from '@tiptap/core';

/** Return a finite positive HTML image dimension, or null for an absent/invalid value. */
export function imageDimension(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const dimension = Number(value);
  return Number.isFinite(dimension) && dimension > 0 && dimension <= 100_000 ? dimension : null;
}

/** Semantic key prevents stale authored HTML from hiding an intentional image edit. */
export function imageSourceKey(attrs: Record<string, unknown>): string {
  return JSON.stringify([
    attrs['markdown-src'] || attrs.src || '',
    attrs.alt || '',
    attrs.title || '',
    imageDimension(attrs.width),
    imageDimension(attrs.height),
    typeof attrs['indent-prefix'] === 'string' ? attrs['indent-prefix'] : '',
  ]);
}

/** Escape an attribute, including pipes which would otherwise split Markdown table cells. */
export function escapeImageAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;');
}

/**
 * Parse one standalone HTML image without attaching authored markup to the live
 * DOM. Preserve exact source and indentation until its semantic attributes change.
 * Returns null for wrappers, multiple tags, or an image without a source.
 */
export function parseHtmlImageAttributes(rawSource: string): Record<string, unknown> | null {
  const raw = rawSource.replace(/(?:\r?\n)+$/, '');
  if (!/^\s*<img\b(?:[^>"']|"[^"]*"|'[^']*')*>\s*$/i.test(raw)) return null;
  const template = document.createElement('template');
  template.innerHTML = raw;
  const image = template.content.firstElementChild;
  if (!image || image.tagName !== 'IMG' || !image.hasAttribute('src')) return null;
  const attrs: Record<string, unknown> = {
    src: image.getAttribute('src'),
    'markdown-src': image.getAttribute('src'),
    alt: image.getAttribute('alt') || '',
    title: image.getAttribute('title'),
    width: imageDimension(image.getAttribute('width')),
    height: imageDimension(image.getAttribute('height')),
    'indent-prefix': raw.match(/^[ \t]*/)?.[0] || '',
    'html-source': raw,
  };
  attrs['html-source-key'] = imageSourceKey(attrs);
  return attrs;
}

function parseHtmlImage(token: MarkdownToken, helpers: MarkdownParseHelpers) {
  const raw = (token.raw || token.text || '').replace(/(?:\r?\n)+$/, '');
  const attrs = parseHtmlImageAttributes(raw);
  const images: Record<string, unknown>[] = [];
  if (attrs) images.push(attrs);
  else if (token.block) {
    // CommonMark groups consecutive HTML image lines into one html_block. Keep
    // only image tags plus whitespace here; unrelated HTML stays with the fallback.
    let remaining = raw;
    while (remaining.trim().length > 0) {
      const image = /^(\s*)(<img\b(?:[^>"']|"[^"]*"|'[^']*')*>)/i.exec(remaining);
      if (!image) return [];
      const attributes = parseHtmlImageAttributes(images.length === 0 ? image[0] : image[2]);
      if (!attributes) return [];
      if (images.length > 0) attributes['html-source-prefix'] = image[1];
      images.push(attributes);
      remaining = remaining.slice(image[0].length);
    }
    if (remaining && images.length > 0) {
      images[images.length - 1]['html-source'] += remaining;
    }
  }
  if (images.length === 0) return [];
  const nodes = images.map(attributes => helpers.createNode('image', attributes));
  // A block HTML token must retain its paragraph boundary. Returning an inline
  // image here merges it with adjacent image paragraphs during schema repair.
  return token.block ? helpers.createNode('paragraph', {}, nodes) : nodes[0];
}

// TipTap bypasses registered `html` handlers for inline tokens. A dedicated
// tokenizer retains source spelling in prose, lists, tables and multiline tags.
const InlineHtmlImageSource = Extension.create({
  name: 'inlineHtmlImageSource',
  markdownTokenName: 'inlineHtmlImageSource',
  markdownTokenizer: {
    name: 'inlineHtmlImageSource',
    level: 'inline',
    start: source => source.search(/<img\b/i),
    tokenize: source => {
      const raw = source.match(/^<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/i)?.[0];
      return raw ? { type: 'inlineHtmlImageSource', raw, block: false } : undefined;
    },
  },
  parseMarkdown: parseHtmlImage,
});

/** Preserve block and inline HTML image tokens without changing unrelated HTML. */
export const HtmlImageSource = Extension.create({
  name: 'htmlImageSource',
  priority: 1100,
  markdownTokenName: 'html',
  addExtensions: () => [InlineHtmlImageSource],
  parseMarkdown: parseHtmlImage,
});
