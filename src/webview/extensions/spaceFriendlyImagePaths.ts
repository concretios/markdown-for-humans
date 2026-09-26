/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import type { JSONContent, MarkdownRendererHelpers, RenderContext } from '@tiptap/core';
import { Extension, type MarkdownParseHelpers, type MarkdownToken } from '@tiptap/core';

const STANDALONE_IMAGE_LINE_WITH_SPACES_REGEX =
  /^([ \t]*)!\[([^\]]*)\]\(\s*([^)]*?\s+[^)]*?)\s*\)\s*$/;

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

function stripAngleBrackets(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, trimmed.length - 1);
  }
  return trimmed;
}

/**
 * marked/CommonMark treat `![alt](./path with spaces.png)` as invalid unless the
 * destination is wrapped in `<...>` or URL-encoded. This extension provides a
 * narrow, low-risk fallback so common “workspace image with spaces” cases still
 * render as images in the editor.
 *
 * Scope: only intercept paragraphs that are *exactly* a single image line and
 * only when the destination contains whitespace and no quotes (to avoid
 * mis-parsing titles).
 */
export const SpaceFriendlyImagePaths = Extension.create({
  name: 'spaceFriendlyImagePaths',

  // TipTap 3.30's Paragraph has priority 1000. This fallback must run first
  // for the shared `paragraph` token or the generic handler consumes it.
  priority: 1100,

  markdownTokenName: 'paragraph',

  parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
    if (token.type !== 'paragraph') {
      return [];
    }

    const raw =
      typeof token.raw === 'string' ? token.raw : typeof token.text === 'string' ? token.text : '';
    const candidate = raw.replace(/\s+$/, '');
    if (!candidate) {
      return [];
    }

    // Avoid interfering with multi-line paragraphs (e.g., soft-wrapped prose).
    const lines = candidate.split('\n').filter(Boolean);
    if (lines.length !== 1) {
      return [];
    }

    const line = lines[0];
    const match = line.match(STANDALONE_IMAGE_LINE_WITH_SPACES_REGEX);
    if (!match) {
      return [];
    }

    const indentPrefix = match[1] ?? '';
    const alt = match[2] ?? '';
    const rawDestination = match[3] ?? '';

    // If quotes are present, we might be looking at a title; let the normal parser handle it.
    if (rawDestination.includes('"') || rawDestination.includes("'")) {
      return [];
    }

    const src = stripAngleBrackets(rawDestination);
    if (!/\s/.test(src)) {
      return [];
    }

    return helpers.createNode('paragraph', {}, [
      helpers.createNode('image', {
        src,
        alt,
        'indent-prefix': indentPrefix,
      }),
    ]);
  },

  renderMarkdown: ((
    node: JSONContent,
    helpers: MarkdownRendererHelpers,
    _context: RenderContext
  ) => {
    const content = helpers.renderChildren(node.content || []);

    const hasMeaningfulContent =
      Array.isArray(node.content) &&
      node.content.some((child: JSONContent) => isMeaningfulInlineNode(child));

    if (!hasMeaningfulContent && content.trim() === '') {
      return null;
    }

    return content;
  }) as unknown as (
    node: JSONContent,
    helpers: MarkdownRendererHelpers,
    ctx: RenderContext
  ) => string,
});
