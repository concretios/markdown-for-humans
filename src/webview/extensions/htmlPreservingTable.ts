/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import type { JSONContent, MarkdownRendererHelpers, RenderContext } from '@tiptap/core';
import { Table } from '@tiptap/extension-table';

type RenderMarkdownFn = (
  node: JSONContent,
  helpers: MarkdownRendererHelpers,
  ctx: RenderContext
) => string;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collectText(node: JSONContent): string {
  if (!node || typeof node !== 'object') {
    return '';
  }

  if (node.type === 'text') {
    return typeof node.text === 'string' ? node.text : '';
  }

  if (node.type === 'hardBreak' || node.type === 'hard_break') {
    return '\n';
  }

  if (!Array.isArray(node.content)) {
    return '';
  }

  return node.content.map(collectText).join('');
}

/** Keep literal cell pipes from becoming GFM column delimiters on the next parse. */
function escapeUnescapedTablePipes(value: string): string {
  let escaped = '';

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '|') {
      escaped += character;
      continue;
    }

    let precedingBackslashes = 0;
    for (
      let precedingIndex = index - 1;
      precedingIndex >= 0 && value[precedingIndex] === '\\';
      precedingIndex -= 1
    ) {
      precedingBackslashes += 1;
    }
    escaped += precedingBackslashes % 2 === 0 ? '\\|' : '|';
  }

  return escaped;
}

function renderTableCellSpanAttributes(cell: JSONContent): string {
  const attributes: string[] = [];
  const colspan = cell.attrs?.colspan;
  const rowspan = cell.attrs?.rowspan;

  if (Number.isSafeInteger(colspan) && (colspan as number) > 1) {
    attributes.push(`colspan="${colspan as number}"`);
  }
  if (Number.isSafeInteger(rowspan) && (rowspan as number) > 1) {
    attributes.push(`rowspan="${rowspan as number}"`);
  }

  return attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
}

function renderTableCell(cell: JSONContent, tagName: 'th' | 'td'): string {
  const rawText = collectText(cell).trim();
  const escapedText = escapeHtml(rawText);
  const spanAttributes = renderTableCellSpanAttributes(cell);
  return `<${tagName}${spanAttributes}>${escapedText}</${tagName}>`;
}

export const HtmlPreservingTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      htmlClass: {
        default: null,
        rendered: false,
        parseHTML: element => element.getAttribute('class'),
      },
      htmlOrigin: {
        default: false,
        rendered: false,
        // Any table built from DOM came from HTML — except one markdown-it
        // rendered from pipe syntax, which the paste pipeline tags. Without
        // that exemption a pasted markdown table (or one converted from HTML
        // at the user's request) would be saved back as `<table>` markup.
        parseHTML: element => element.getAttribute('data-markdown-table') !== 'true',
      },
    };
  },

  // Must be a regular function (not an arrow function) so that TipTap's
  // getExtensionField correctly binds `this.parent` to the base Table extension's
  // GFM renderMarkdown. Arrow functions ignore .bind(), so this.parent would be
  // undefined and GFM tables would be silently dropped on serialization.
  renderMarkdown: function (
    this: { parent: RenderMarkdownFn | null },
    node: JSONContent,
    helpers: MarkdownRendererHelpers,
    context: RenderContext
  ): string {
    const htmlOrigin = Boolean(node.attrs?.htmlOrigin);
    if (!htmlOrigin) {
      // TipTap 3.30.5 does not escape literal pipes returned by renderChildren,
      // so its otherwise-canonical table output can create extra columns.
      const pipeSafeHelpers: MarkdownRendererHelpers = {
        ...helpers,
        renderChildren: (children, separator) =>
          escapeUnescapedTablePipes(helpers.renderChildren(children, separator)),
      };
      return this.parent ? this.parent.call(this, node, pipeSafeHelpers, context) : '';
    }

    const className =
      typeof node.attrs?.htmlClass === 'string' && node.attrs.htmlClass.trim().length > 0
        ? node.attrs.htmlClass.trim()
        : null;

    const rows = Array.isArray(node.content) ? node.content : [];
    const rowHtml = rows
      .map(row => {
        const cells = Array.isArray(row.content) ? row.content : [];
        const cellsHtml = cells
          .map(cell => renderTableCell(cell, cell.type === 'tableHeader' ? 'th' : 'td'))
          .join('');
        return `  <tr>${cellsHtml}</tr>`;
      })
      .join('\n');

    const tableOpenTag = className ? `<table class="${escapeHtml(className)}">` : '<table>';

    return `${tableOpenTag}\n${rowHtml}\n</table>`;
  },
});
