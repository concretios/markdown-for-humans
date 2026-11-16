/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import CodeBlock, { type CodeBlockOptions } from '@tiptap/extension-code-block';
import { mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import { parsePreservedCodeBlock, renderPreservedCodeBlock } from './preservedCodeBlock';
import { createCodeBlockCopyNodeView } from './codeBlockCopyNodeView';
import { createCodeHighlightingPlugin } from '../highlighting/plugin';
import { createHighlightService } from '../highlighting/client';
import { createFrontmatterPlugin, type FrontmatterStyle } from '../frontmatter/plugin';
import type { ReadFrontmatter } from '../frontmatter/reader';
import { getSingleLineEditorCopy } from '../utils/pasteHandler';
import { insertPlainText } from '../utils/plainTextPaste';

interface HighlightedCodeBlockOptions extends CodeBlockOptions {
  workerUri: string;
  frontmatterStyle: FrontmatterStyle;
  readFrontmatter: ReadFrontmatter;
}

/**
 * Syntax-highlighted code block with preserved Markdown indentation and a
 * ProseMirror-safe copy control.
 */
export const CodeBlockWithCopy = CodeBlock.extend<HighlightedCodeBlockOptions>({
  addOptions() {
    return {
      ...this.parent?.(),
      workerUri: '',
      frontmatterStyle: 'current',
    } as HighlightedCodeBlockOptions;
  },

  addProseMirrorPlugins() {
    return [
      // TipTap's own paste plugin (inherited just below) wraps anything copied
      // from a VS Code editor in a code block. For a single line, such as a
      // class name pasted into a sentence, that splits the paragraph (issue
      // 11), so it goes in as inline text. Several lines still become a block.
      new Plugin({
        key: new PluginKey('singleLineEditorPaste'),
        props: {
          handlePaste: (_view, event) => {
            if (this.editor.isActive(this.type.name)) return false;
            const line = getSingleLineEditorCopy(event.clipboardData);
            return line !== null && insertPlainText(this.editor, line);
          },
        },
      }),
      ...(this.parent?.() ?? []),
      createFrontmatterPlugin(this.options.frontmatterStyle, this.options.readFrontmatter),
      createCodeHighlightingPlugin(() => createHighlightService(this.options.workerUri)),
    ];
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      frontmatter: { default: false, rendered: false },
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
    return ({ node, HTMLAttributes, extension, decorations, editor, getPos }) =>
      createCodeBlockCopyNodeView(
        node,
        mergeAttributes(extension.options.HTMLAttributes, HTMLAttributes),
        extension.options.languageClassPrefix as string,
        {
          decorations,
          edit: () => {
            const pos = getPos();
            if (typeof pos === 'number' && editor.isEditable) {
              editor.commands.focus(pos + 1, { scrollIntoView: false });
            }
          },
          focusBody: () => {
            const pos = getPos();
            const block = typeof pos === 'number' ? editor.state.doc.nodeAt(pos) : null;
            if (typeof pos !== 'number' || !block || !editor.isEditable) return false;
            const next = Selection.findFrom(
              editor.state.doc.resolve(pos + block.nodeSize),
              1,
              true
            );
            if (!next) return false;
            editor.commands.focus(next.from, { scrollIntoView: false });
            return true;
          },
        }
      );
  },

  parseMarkdown: parsePreservedCodeBlock,
  renderMarkdown: renderPreservedCodeBlock,
});
