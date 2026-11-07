/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Marks for inline HTML that documentation uses where Markdown has no syntax:
 * `<kbd>` for keys, `<sub>` and `<sup>` for scripts.
 *
 * With no mark claiming the tag, the HTML parser kept only the text inside it, so
 * editing a paragraph turned `<kbd>Ctrl</kbd>` into `Ctrl`. Each mark parses its
 * element and writes the same tags back.
 *
 * The priority sits between link (90) and inline code (80): a link or bold span
 * wraps the tag, and code stays innermost, matching the other Markdown marks.
 */

import { Mark } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';

function inlineHtmlMark(name: string, tag: string) {
  return Mark.create({
    name,
    priority: 85,
    inclusive: false,

    parseHTML() {
      return [{ tag }];
    },

    renderHTML() {
      return [tag, 0];
    },

    renderMarkdown: ((
      node: JSONContent,
      helpers: { renderChildren: (node: JSONContent) => string }
    ) => `<${tag}>${helpers.renderChildren(node)}</${tag}>`) as unknown as never,
  });
}

export const HtmlKbd = inlineHtmlMark('htmlKbd', 'kbd');
export const HtmlSub = inlineHtmlMark('htmlSub', 'sub');
export const HtmlSup = inlineHtmlMark('htmlSup', 'sup');
