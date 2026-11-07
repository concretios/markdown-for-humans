/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import type { MarkdownTokenizer } from '@tiptap/core';
import { TaskList } from '@tiptap/extension-list';

const stockTokenizer = TaskList.config.markdownTokenizer as MarkdownTokenizer;

/** The item pattern the stock tokenizer passes to parseIndentedBlocks. */
const TASK_ITEM_LINE = /^(\s*)([-+*])\s+\[([ xX])\]\s+(.*)$/;

/**
 * True when the first non-blank line of `src` is a task item. parseIndentedBlocks
 * skips blank lines and returns undefined at the first other non-matching line,
 * so the stock tokenizer can only produce a token when this holds.
 */
function startsWithTaskItem(src: string): boolean {
  let lineStart = 0;
  for (;;) {
    const lineEnd = src.indexOf('\n', lineStart);
    const line = lineEnd === -1 ? src.slice(lineStart) : src.slice(lineStart, lineEnd);
    if (line.trim() !== '') return TASK_ITEM_LINE.test(line);
    if (lineEnd === -1) return false;
    lineStart = lineEnd + 1;
  }
}

/**
 * TaskList with a cheap first-line check before the stock Markdown tokenizer.
 *
 * marked calls block tokenizers at every block position, and the stock one
 * calls parseIndentedBlocks, which splits the whole remaining document into
 * lines before looking at the first one. Loading was O(n^2) in block count
 * (TipTap 3.30.5 and 3.31.4). Parsing is otherwise unchanged.
 */
export const MarkdownTaskList = TaskList.extend({
  markdownTokenizer: {
    ...stockTokenizer,
    tokenize: (src, tokens, lexer) =>
      startsWithTaskItem(src) ? stockTokenizer.tokenize(src, tokens, lexer) : undefined,
  },
});
