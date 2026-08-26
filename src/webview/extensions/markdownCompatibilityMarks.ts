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
});

/**
 * Inline code must be the innermost Markdown mark. Markdown inside a code span
 * is literal, so placing code outside italic, strike, or link syntax changes
 * the document meaning on the next parse.
 */
export const MarkdownCode = Code.extend({
  priority: 80,
});
