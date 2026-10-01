/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import CodeBlock, { type CodeBlockOptions } from '@tiptap/extension-code-block';
import { mergeAttributes } from '@tiptap/core';
import { parsePreservedCodeBlock, renderPreservedCodeBlock } from './preservedCodeBlock';
import { createCodeBlockCopyNodeView } from './codeBlockCopyNodeView';
import { createCodeHighlightingPlugin } from '../highlighting/plugin';
import { createHighlightService } from '../highlighting/client';

interface HighlightedCodeBlockOptions extends CodeBlockOptions {
  workerUri: string;
}

/**
 * Syntax-highlighted code block with preserved Markdown indentation and a
 * ProseMirror-safe copy control.
 */
export const CodeBlockWithCopy = CodeBlock.extend<HighlightedCodeBlockOptions>({
  addOptions() {
    return { ...this.parent?.(), workerUri: '' } as HighlightedCodeBlockOptions;
  },

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      createCodeHighlightingPlugin(() => createHighlightService(this.options.workerUri)),
    ];
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      'indent-prefix': {
        default: null,
        parseHTML: element => element.getAttribute('data-indent-prefix'),
        renderHTML: attributes => {
          const prefix = attributes['indent-prefix'];
          if (typeof prefix !== 'string' || prefix.length === 0) {
            return {};
          }
          return { 'data-indent-prefix': prefix };
        },
      },
      'fence-marker': {
        default: null,
        parseHTML: element => element.getAttribute('data-fence-marker'),
        renderHTML: attributes => {
          const marker = attributes['fence-marker'];
          return typeof marker === 'string' && /^(?:`{3,}|~{3,})$/.test(marker)
            ? { 'data-fence-marker': marker }
            : {};
        },
      },
    };
  },

  addNodeView() {
    return ({ node, HTMLAttributes, extension }) =>
      createCodeBlockCopyNodeView(
        node,
        mergeAttributes(extension.options.HTMLAttributes, HTMLAttributes),
        extension.options.languageClassPrefix as string
      );
  },

  parseMarkdown: parsePreservedCodeBlock,
  renderMarkdown: renderPreservedCodeBlock,
});
