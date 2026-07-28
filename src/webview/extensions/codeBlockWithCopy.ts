/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { parsePreservedCodeBlock, renderPreservedCodeBlock } from './preservedCodeBlock';
import { createCodeBlockCopyNodeView } from './codeBlockCopyNodeView';

/**
 * Syntax-highlighted code block with preserved Markdown indentation and a
 * ProseMirror-safe copy control.
 */
export const CodeBlockWithCopy = CodeBlockLowlight.extend({
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
    };
  },

  addNodeView() {
    return ({ node, HTMLAttributes, extension }) =>
      createCodeBlockCopyNodeView(
        node,
        HTMLAttributes,
        extension.options.languageClassPrefix as string
      );
  },

  parseMarkdown: parsePreservedCodeBlock,
  renderMarkdown: renderPreservedCodeBlock,
});
