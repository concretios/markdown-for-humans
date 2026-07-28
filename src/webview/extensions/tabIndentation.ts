/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Extension } from '@tiptap/core';
import { NodeSelection } from 'prosemirror-state';

function outdentIndentPrefix(indentPrefix: unknown): string | null {
  if (typeof indentPrefix !== 'string' || indentPrefix.length === 0) {
    return null;
  }

  if (indentPrefix.startsWith('\t')) {
    const next = indentPrefix.slice(1);
    return next.length > 0 ? next : null;
  }

  const leadingSpaces = indentPrefix.match(/^ {1,4}/);
  if (leadingSpaces) {
    const next = indentPrefix.slice(leadingSpaces[0].length);
    return next.length > 0 ? next : null;
  }

  // Unexpected value (indentPrefix should be only spaces/tabs) — keep as-is.
  return indentPrefix;
}

/**
 * TabIndentation Extension - Revised Behavior
 *
 * Tab behavior:
 * - Tables: Next cell (let Table extension handle)
 * - Code blocks: Indent code (let CodeBlockLowlight handle)
 * - Lists (can indent): Indent under previous item
 * - Lists (first item): Add \t
 * - Paragraphs/Headings/Blockquotes/Images: Add \t
 *
 * Shift+Tab behavior:
 * - Tables: Previous cell (let Table extension handle)
 * - Code blocks: Unindent (let CodeBlockLowlight handle)
 * - Lists (nested): Outdent
 * - Lists (top level): Convert to paragraph
 * - Everything else: Remove leading \t or spaces, else do nothing
 */
export const TabIndentation = Extension.create({
  name: 'tabIndentation',

  addKeyboardShortcuts() {
    return {
      Tab: () => {
        const { state } = this.editor.view;
        const { selection } = state;

        // 1. Handle Node Selection (e.g., Image selected)
        // Add \t before the image
        if (selection instanceof NodeSelection) {
          this.editor.commands.insertContent('\t');
          return true;
        }

        // 2. Check for Table - Let Table extension handle it (Next Cell)
        if (this.editor.isActive('table')) {
          return false;
        }

        // 3. Check for Code Block - Let CodeBlockLowlight handle it
        if (this.editor.isActive('codeBlock')) {
          return false;
        }

        // 4. Check for List - Try to indent, don't insert tab if it fails
        if (this.editor.isActive('listItem') || this.editor.isActive('taskItem')) {
          this.editor.commands.sinkListItem('listItem');
          this.editor.commands.sinkListItem('taskItem');
          // Always return true to prevent focus loss, even if indent failed
          // Don't insert \t in list content - that creates malformed markdown
          return true;
        }

        // 5. All other contexts (Paragraphs, Headings, Blockquotes, etc.) - Add \t
        this.editor.commands.insertContent('\t');
        return true;
      },

      'Shift-Tab': () => {
        const { state, dispatch } = this.editor.view;
        const { selection } = state;

        // 1. Check for Table - Let Table extension handle it (Prev Cell)
        if (this.editor.isActive('table')) {
          return false;
        }

        // 2. Check for Code Block - Let CodeBlockLowlight handle it
        if (this.editor.isActive('codeBlock')) {
          return false;
        }

        // 3. Check for List - Lift (Outdent or convert to paragraph)
        if (this.editor.isActive('listItem') || this.editor.isActive('taskItem')) {
          this.editor.commands.liftListItem('listItem');
          this.editor.commands.liftListItem('taskItem');
          return true; // Always capture Shift+Tab in lists
        }

        // 4. Images - Outdent stored indentation instead of deleting invisible whitespace.
        if (selection instanceof NodeSelection && selection.node?.type?.name === 'image') {
          const currentPrefix = selection.node.attrs?.['indent-prefix'];
          const nextPrefix = outdentIndentPrefix(currentPrefix);

          if (nextPrefix !== (typeof currentPrefix === 'string' ? currentPrefix : null)) {
            this.editor.commands.updateAttributes('image', { 'indent-prefix': nextPrefix });
          }

          return true;
        }

        // When the caret is directly before an image (line start), outdent that image too.
        const selectionFrom = state.selection as unknown as {
          $from?: {
            pos: number;
            parentOffset: number;
            parent: { textContent: string };
            nodeBefore?: { type?: { name?: string } } | null;
            nodeAfter?: { type?: { name?: string }; attrs?: Record<string, unknown> } | null;
          };
        };
        const $from = selectionFrom.$from;
        if (!$from) {
          return true;
        }

        const atLineStart =
          $from.parentOffset === 0 || $from.nodeBefore?.type?.name === 'hardBreak';
        const nodeAfter = $from.nodeAfter;

        if (atLineStart && nodeAfter?.type?.name === 'image') {
          const currentPrefix = nodeAfter.attrs?.['indent-prefix'];
          const nextPrefix = outdentIndentPrefix(currentPrefix);

          if (nextPrefix !== (typeof currentPrefix === 'string' ? currentPrefix : null)) {
            this.editor.commands.setNodeSelection($from.pos);
            this.editor.commands.updateAttributes('image', { 'indent-prefix': nextPrefix });
          }

          return true;
        }

        // 5. All other contexts - Smart removal of leading indentation
        const textBefore = $from.parent.textContent;
        const posInParent = $from.parentOffset;

        const lineStart = textBefore.lastIndexOf('\n', posInParent - 1) + 1;
        const textFromLineStart = textBefore.substring(lineStart, posInParent);

        // Remove leading \t or spaces (up to 4)
        const leadingWhitespace = textFromLineStart.match(/^(\t| {1,4})/);

        if (leadingWhitespace) {
          const removeLength = leadingWhitespace[0].length;
          const from = $from.pos - posInParent + lineStart;
          const to = from + removeLength;

          const tr = state.tr.delete(from, to);
          dispatch(tr);
          return true;
        }

        return true; // Capture anyway to prevent focus loss
      },
    };
  },
});
