/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Markdown list items with marker-width continuation indentation. Inherits
 * TipTap's parser, schema, marker rendering, commands and keyboard behavior.
 */

import {
  renderNestedMarkdownContent,
  type JSONContent,
  type MarkdownRendererHelpers,
  type RenderContext,
} from '@tiptap/core';
import { getListMarker, ListItem } from '@tiptap/extension-list';

export const MarkdownListItem = ListItem.extend({
  /** Preserve nested blocks beneath the actual numbered marker, including 10+. */
  renderMarkdown(
    node: JSONContent,
    helpers: MarkdownRendererHelpers,
    context: RenderContext
  ): string {
    if (context.parentType !== 'orderedList') {
      return renderNestedMarkdownContent(node, helpers, '- ');
    }

    const start: number = context.meta?.parentAttrs?.start ?? 1;
    const type: string | undefined = context.meta?.parentAttrs?.type;
    const prefix = getListMarker(type, start - 1 + (context.index || 0), '. ');
    const indentation = ' '.repeat(prefix.length);

    // TipTap 3.30.5 uses the manager's fixed two-space indent for children.
    // CommonMark requires the full parent marker width, otherwise a child list
    // becomes a sibling and Feedback correctly rejects the changed structure.
    return renderNestedMarkdownContent(
      node,
      { ...helpers, indent: line => indentation + line },
      prefix
    );
  },
});
