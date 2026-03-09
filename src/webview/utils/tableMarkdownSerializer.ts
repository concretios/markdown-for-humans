/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Custom table markdown serializer that preserves hardBreak nodes inside table cells.
 *
 * The default @tiptap/extension-table renderTableToMarkdown calls `collapseWhitespace()`
 * on each cell's rendered text, which obliterates line breaks (hardBreaks render as "  \n"
 * which collapseWhitespace turns into a space). This custom serializer walks the cell's
 * JSON content directly, rendering text with marks and converting hardBreak nodes to `<br />`
 * before any whitespace normalization occurs.
 */

import type { JSONContent, MarkdownRendererHelpers } from '@tiptap/core';

/**
 * Recursively render a block node to HTML, allowing list items, headings, etc. inside tables.
 * Inline content converts hardBreak nodes to `<br />`.
 */
function renderBlockNode(node: JSONContent, h: MarkdownRendererHelpers): string {
  if (!node) return '';

  // Helper to render inline content and preserve `<br />`
  const renderInline = (nodes: JSONContent[] | undefined): string => {
    if (!nodes) return '';
    let text = '';
    for (const inline of nodes) {
      if (inline.type === 'hardBreak' || inline.type === 'hard_break') {
        text += '<br />';
      } else {
        text += h.renderChildren([inline] as unknown as JSONContent[]);
      }
    }
    return text;
  };

  switch (node.type) {
    case 'paragraph': {
      return renderInline(node.content);
    }
    case 'heading': {
      const level = node.attrs?.level || 1;
      const content = renderInline(node.content);
      return `<h${level}>${content}</h${level}>`;
    }
    case 'bulletList': {
      // For standard markdown tables, native HTML lists aren't universally supported and
      // can cause parsing issues. User preferred format: just separated text with "- " prefix.
      const items = (node.content || []).map(n => {
        return '- ' + renderBlockNode(n, h);
      });
      return items.join('<br />');
    }
    case 'orderedList': {
      // Ordered list inside table cell -> plain text with "1. ", "2. " prefix
      let index = node.attrs?.start || 1;
      const items = (node.content || []).map(n => {
        const itemHtml = renderBlockNode(n, h);
        const prefix = `${index}. `;
        index++;
        return prefix + itemHtml; // We don't prepend here because listItem doesn't know its index easily unless we pass it, so let's let listItem just return text and we prepend here
      });
      return items.join('<br />');
    }
    case 'listItem': {
      const content = (node.content || []).map(n => renderBlockNode(n, h)).join('');
      // If parent is bulletList, we need "- " prefix. If orderedList, parent will prepend index.
      // But we don't know the parent type here. A simple way:
      // We can just return the content. The only issue is bulletList needs "- " and orderedList needs "1. "
      // Let's refactor slightly to pass the prefix from the parent, or just check the parent somehow.
      // Since renderBlockNode doesn't take context, let's just do it directly.
      return content;
    }
    case 'blockquote': {
      const content = (node.content || []).map(n => renderBlockNode(n, h)).join('<br />');
      return `<blockquote>${content}</blockquote>`;
    }
    case 'githubAlert': {
      const alertType = node.attrs?.alertType || 'NOTE';
      const content = (node.content || []).map(n => renderBlockNode(n, h)).join('<br />');
      return `<blockquote>[!${alertType}]<br />${content}</blockquote>`;
    }
    default: {
      if (node.type === 'text') {
        return h.renderChildren([node] as unknown as JSONContent[]);
      }
      if (node.content) {
        // Fallback for unhandled blocks with content (like codeBlock inside a table, if allowed)
        return node.content.map(n => renderBlockNode(n, h)).join('<br />');
      }
      // Truly unhandled node, let the default renderer try
      return h.renderChildren([node] as unknown as JSONContent[]);
    }
  }
}

/**
 * Render a single cell's JSON content to a string, preserving hardBreak as `<br />`.
 * Also converts internal block nodes (Headings, Lists, Blockquotes) into HTML elements
 * because GFM tables don't support markdown block syntax.
 */
function renderCellContent(cellNode: JSONContent, h: MarkdownRendererHelpers): string {
  if (!cellNode.content || cellNode.content.length === 0) {
    return '';
  }

  const parts: string[] = [];

  for (const block of cellNode.content) {
    parts.push(renderBlockNode(block, h));
  }

  // Join multiple blocks with <br /> (e.g. multiple paragraphs in one cell)
  const raw = parts.join('<br />');

  // Only collapse spaces, NOT newlines — preserve <br /> markers
  // Use trimEnd so we don't accidentally collapse multiple spaces at the start of a logical line,
  // which might be acting as indentation (e.g. `  - list item`).
  return (raw || '').trimEnd();
}

export function renderTableToMarkdownWithBreaks(
  node: JSONContent,
  h: MarkdownRendererHelpers
): string {
  if (!node || !node.content || node.content.length === 0) {
    return '';
  }

  const rows: { text: string; isHeader: boolean }[][] = [];

  node.content.forEach(rowNode => {
    const cells: { text: string; isHeader: boolean }[] = [];
    if (rowNode.content) {
      rowNode.content.forEach(cellNode => {
        const text = renderCellContent(cellNode, h);
        const isHeader = cellNode.type === 'tableHeader';
        cells.push({ text, isHeader });
      });
    }
    rows.push(cells);
  });

  const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
  if (columnCount === 0) return '';

  // For column width computation, we need the display length (without <br /> tags)
  const displayLen = (text: string) => {
    // Split on <br /> to get the longest segment for column width
    const segments = text.split('<br />');
    return Math.max(...segments.map(s => s.length), 0);
  };

  const colWidths = new Array(columnCount).fill(0);
  rows.forEach(r => {
    for (let i = 0; i < columnCount; i += 1) {
      const len = displayLen(r[i]?.text || '');
      if (len > colWidths[i]) colWidths[i] = len;
      if (colWidths[i] < 3) colWidths[i] = 3;
    }
  });

  const pad = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - displayLen(s)));

  const headerRow = rows[0];
  const hasHeader = headerRow.some(c => c.isHeader);

  let out = '\n';

  const headerTexts = new Array(columnCount)
    .fill(0)
    .map((_, i) => (hasHeader ? (headerRow[i] && headerRow[i].text) || '' : ''));

  out += `| ${headerTexts.map((t, i) => pad(t, colWidths[i])).join(' | ')} |\n`;
  out += `| ${colWidths.map(w => '-'.repeat(Math.max(3, w))).join(' | ')} |\n`;

  const body = hasHeader ? rows.slice(1) : rows;
  body.forEach(r => {
    out += `| ${new Array(columnCount)
      .fill(0)
      .map((_, i) => pad((r[i] && r[i].text) || '', colWidths[i]))
      .join(' | ')} |\n`;
  });

  return out;
}
