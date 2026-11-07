/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import {
  Extension,
  type JSONContent,
  type MarkdownParseHelpers,
  type MarkdownToken,
} from '@tiptap/core';
import { parseHtmlImageAttributes } from './htmlImageSource';

type ParsedImageLine = {
  indentPrefix: string;
  alt: string;
  src: string;
  title: string | null;
  htmlAttributes?: Record<string, unknown>;
};

const INDENTED_IMAGE_LINE_REGEX =
  /^([ \t]*)!\[([^\]]*)\]\(\s*(<[^>]+>|[^)]+?)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)\s*$/;

function parseIndentedImageLine(rawLine: string): ParsedImageLine | null {
  const match = rawLine.match(INDENTED_IMAGE_LINE_REGEX);
  if (!match) {
    const htmlAttributes = parseHtmlImageAttributes(rawLine);
    if (!htmlAttributes) return null;
    return {
      indentPrefix: String(htmlAttributes['indent-prefix'] || ''),
      alt: String(htmlAttributes.alt || ''),
      src: String(htmlAttributes.src || ''),
      title: typeof htmlAttributes.title === 'string' ? htmlAttributes.title : null,
      htmlAttributes,
    };
  }

  const indentPrefix = match[1] ?? '';
  const alt = match[2] ?? '';
  const rawSrc = (match[3] ?? '').trim();
  const title = match[4] ?? match[5] ?? null;

  const src =
    rawSrc.startsWith('<') && rawSrc.endsWith('>') ? rawSrc.slice(1, rawSrc.length - 1) : rawSrc;

  return {
    indentPrefix,
    alt,
    src,
    title,
  };
}

function isWhitespaceOnly(line: string): boolean {
  return line.trim().length === 0;
}

function buildIndentedImagesParagraph(
  lines: ParsedImageLine[],
  helpers: MarkdownParseHelpers
): JSONContent {
  const content: JSONContent[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (content.length > 0) {
      content.push(helpers.createNode('hardBreak'));
    }

    if (line.htmlAttributes) {
      content.push(helpers.createNode('image', line.htmlAttributes));
      continue;
    }

    const imageAttrs: {
      src: string;
      alt: string;
      title?: string;
      'indent-prefix': string;
    } = {
      src: line.src,
      alt: line.alt,
      'indent-prefix': line.indentPrefix,
    };

    if (line.title) {
      imageAttrs.title = line.title;
    }

    content.push(helpers.createNode('image', imageAttrs));
  }

  return helpers.createNode('paragraph', {}, content);
}

/**
 * Converts indented code blocks containing only standalone Markdown or supported
 * HTML images into real image nodes. Sized SVG images use the HTML representation.
 *
 * marked.js treats lines indented with 4+ spaces or tabs as code blocks. That breaks
 * common copy/paste flows where images are accidentally indented (or intentionally
 * aligned), making images render as `<pre><code>`.
 *
 * We only intercept *indented* code blocks (not fenced) and only when every non-empty
 * line is a standalone image. Mixed HTML/code and fenced examples remain code.
 */
export const IndentedImageCodeBlock = Extension.create({
  name: 'indentedImageCodeBlock',

  markdownTokenName: 'code',

  parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
    if (token.type !== 'code' || token.codeBlockStyle !== 'indented') {
      return [];
    }

    if (typeof token.raw !== 'string' || token.raw.length === 0) {
      return [];
    }

    const raw = token.raw.replace(/\n+$/, '');
    const rawLines = raw.split('\n');

    const imageLines: ParsedImageLine[] = [];

    for (const rawLine of rawLines) {
      if (isWhitespaceOnly(rawLine)) {
        continue;
      }

      const parsed = parseIndentedImageLine(rawLine);
      if (!parsed) {
        return [];
      }

      imageLines.push(parsed);
    }

    if (imageLines.length === 0) {
      return [];
    }

    return buildIndentedImagesParagraph(imageLines, helpers);
  },
});
