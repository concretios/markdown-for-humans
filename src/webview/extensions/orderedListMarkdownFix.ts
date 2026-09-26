/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import type { JSONContent, MarkdownParseHelpers, MarkdownToken } from '@tiptap/core';
import { OrderedList } from '@tiptap/extension-list';

type OrderedListToken = MarkdownToken & {
  type: 'list';
  ordered?: boolean;
  start?: number;
  items?: MarkdownToken[];
};

type OrderedListItemToken = MarkdownToken & {
  type: 'list_item';
  task?: boolean;
  checked?: boolean;
  text?: string;
  tokens?: MarkdownToken[];
};

/**
 * Marked's GFM list tokenizer lifts `[ ]`/`[x]` into `task`/`checked` (and a
 * leading `checkbox` child) for numbered items. TipTap's `isTaskItem` only
 * recognizes `- [ ]` bullet tasks, and ListItem.parseMarkdown drops the
 * checkbox token — so `1. [x] done` silently became `1. done`. Re-prefix the
 * marker into the item text before ListItem parses, keeping a plain ordered
 * list (taskItem cannot nest under orderedList in the schema).
 */
function restoreOrderedTaskCheckboxPrefix(item: MarkdownToken): MarkdownToken {
  if (item.type !== 'list_item') return item;
  const listItem = item as OrderedListItemToken;
  if (!listItem.task) return item;

  const checked = Boolean(listItem.checked);
  const prefix = checked ? '[x] ' : '[ ] ';
  const withoutCheckbox = Array.isArray(listItem.tokens)
    ? listItem.tokens.filter(child => child.type !== 'checkbox')
    : [];
  const bodyText = typeof listItem.text === 'string' ? listItem.text : '';
  const text = `${prefix}${bodyText}`;

  const first = withoutCheckbox[0] as
    (MarkdownToken & { text?: string; raw?: string; tokens?: MarkdownToken[] }) | undefined;
  if (first && first.type === 'text') {
    const mergedRaw = `${prefix}${first.raw || first.text || ''}`;
    const mergedText = `${prefix}${first.text || ''}`;
    const mergedInline: MarkdownToken[] = [
      { type: 'text', raw: prefix, text: prefix, escaped: false },
      ...(Array.isArray(first.tokens) ? first.tokens : []),
    ];
    return {
      ...listItem,
      task: false,
      checked: undefined,
      text,
      tokens: [
        { ...first, raw: mergedRaw, text: mergedText, tokens: mergedInline },
        ...withoutCheckbox.slice(1),
      ],
    };
  }

  return {
    ...listItem,
    task: false,
    checked: undefined,
    text,
    tokens: [
      {
        type: 'text',
        raw: text,
        text,
        tokens: [{ type: 'text', raw: text, text, escaped: false }],
      },
      ...withoutCheckbox,
    ],
  };
}

/**
 * OrderedList markdown parsing fix.
 *
 * `@tiptap/extension-list` includes a custom markdown tokenizer for ordered lists that matches
 * the `1.` style. When the markdown uses the CommonMark-valid `1)` style, marked.js produces
 * list item tokens where the first child is a `text` token containing inline tokens.
 *
 * The default OrderedList markdown parser path in `@tiptap/extension-list` drops inline tokens
 * for those `text` blocks, causing raw markdown like `**bold**` to render literally on first load.
 *
 * Fix: delegate list item parsing to the ListItem extension via `helpers.parseChildren(items)`,
 * which correctly parses inline marks for both `1.` and `1)` list styles.
 * Numeric lists use marked's built-in tokenizer: TipTap 3.30.5's custom
 * tokenizer strips too little continuation indentation and detaches ordered
 * grandchildren from intervening bullet items. Keep its nonnumeric handling.
 */
export const OrderedListMarkdownFix = OrderedList.extend({
  markdownTokenizer: {
    name: 'orderedList',
    level: 'block',
    start: () => -1,
    tokenize: (source, tokens, lexer) => {
      // Returning undefined lets marked's CommonMark list tokenizer retain the
      // entire nested structure, fenced code whitespace and task item tokens.
      if (/^[ \t]*\d+[.)](?:[ \t\n]|$)/.test(source)) return undefined;
      return OrderedList.config.markdownTokenizer?.tokenize(source, tokens, lexer);
    },
  },
  parseMarkdown: (
    token: MarkdownToken,
    helpers: MarkdownParseHelpers
  ): JSONContent | JSONContent[] => {
    if (token.type !== 'list') {
      return [];
    }

    const listToken = token as OrderedListToken;
    if (!listToken.ordered) {
      return [];
    }

    const start =
      typeof listToken.start === 'number' && Number.isFinite(listToken.start) ? listToken.start : 1;
    const items = Array.isArray(listToken.items)
      ? listToken.items.map(restoreOrderedTaskCheckboxPrefix)
      : [];
    const content =
      items.length > 0 && typeof helpers.parseChildren === 'function'
        ? helpers.parseChildren(items)
        : [];

    if (start !== 1) {
      return {
        type: 'orderedList',
        attrs: { start },
        content,
      };
    }

    return {
      type: 'orderedList',
      content,
    };
  },
});
