/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Extension } from '@tiptap/core';
import { getSelectedTableLines } from '../utils/tableSelectionUtils';

/**
 * When the cursor is inside a table cell, intercept the plain Enter key
 * and insert a hardBreak (<br />) instead of creating a new paragraph.
 *
 * This ensures that:
 * 1. Enter and Shift+Enter behave identically inside table cells
 * 2. The serialized markdown always uses <br /> for line breaks within cells
 * 3. Table structure is never broken by paragraph-level newlines
 *
 * Outside of table cells, Enter behaves normally (creates a new paragraph).
 */
export const TableCellEnterHandler = Extension.create({
  name: 'tableCellEnterHandler',

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        // Only intercept when the cursor is inside a table cell
        if (!editor.isActive('tableCell') && !editor.isActive('tableHeader')) {
          return false; // Let the default handler run
        }

        // Insert a hard break (same as Shift+Enter) instead of a new paragraph
        editor.commands.setHardBreak();
        return true; // Prevent default paragraph creation
      },
      Tab: ({ editor }) => {
        if (!editor.isActive('tableCell') && !editor.isActive('tableHeader')) {
          return false;
        }

        const { state, dispatch } = editor.view;
        const result = getSelectedTableLines(state, state.selection);
        if (!result) return false;
        const { selectedLines, tr } = result;

        const lineStarts = selectedLines.map(l => l.start);
        const originalFrom = state.selection.from;
        const originalTo = state.selection.to;
        const isEmpty = state.selection.empty;

        const cycleMap: Record<string, string> = { '-': '+', '+': '*', '*': '-' };

        for (let i = lineStarts.length - 1; i >= 0; i--) {
          const pos = lineStarts[i];
          const nextNode = tr.doc.nodeAt(pos);

          if (nextNode && nextNode.isText && nextNode.text) {
            const text = nextNode.text;
            const match = text.match(/^([\s]*)([-+*])\s/);
            if (match) {
              // Cycle bullet and add spaces
              const spaces = match[1];
              const bullet = match[2];
              const newSpaces = spaces + '  ';
              const newBullet = cycleMap[bullet];
              const matchLen = match[0].length;

              tr.delete(pos, pos + matchLen);
              tr.insertText(`${newSpaces}${newBullet} `, pos);
            } else {
              // Just add spaces
              tr.insertText('  ', pos);
            }
          } else if (!nextNode || !nextNode.isText) {
            // Empty line
            tr.insertText('  ', pos);
          }
        }

        dispatch(tr);

        if (!isEmpty) {
          const newFrom = tr.mapping.map(originalFrom, -1);
          const newTo = tr.mapping.map(originalTo, 1);
          if (newTo >= newFrom) {
            editor.chain().setTextSelection({ from: newFrom, to: newTo }).focus().run();
          } else {
            editor.chain().focus().run();
          }
        } else {
          editor.chain().focus().run();
        }

        return true;
      },
      'Shift-Tab': ({ editor }) => {
        if (!editor.isActive('tableCell') && !editor.isActive('tableHeader')) {
          return false;
        }

        const { state, dispatch } = editor.view;
        const result = getSelectedTableLines(state, state.selection);
        if (!result) return false;
        const { selectedLines, tr } = result;

        const lineStarts = selectedLines.map(l => l.start);
        const originalFrom = state.selection.from;
        const originalTo = state.selection.to;
        const isEmpty = state.selection.empty;

        const reverseCycleMap: Record<string, string> = { '+': '-', '*': '+', '-': '*' };

        for (let i = lineStarts.length - 1; i >= 0; i--) {
          const pos = lineStarts[i];
          const nextNode = tr.doc.nodeAt(pos);

          if (nextNode && nextNode.isText && nextNode.text) {
            const text = nextNode.text;

            // Check for bullets
            const match = text.match(/^([\s]+)([-+*])\s/);
            if (match) {
              const spaces = match[1];
              const bullet = match[2];

              // Remove up to 2 spaces
              const newSpaces = spaces.length > 2 ? spaces.slice(0, spaces.length - 2) : '';
              const newBullet = reverseCycleMap[bullet];
              const matchLen = match[0].length;

              tr.delete(pos, pos + matchLen);
              tr.insertText(`${newSpaces}${newBullet} `, pos);
            } else {
              // No bullets, just remove spaces
              const spaceMatch = text.match(/^([\s]+)/);
              if (spaceMatch) {
                const spaces = spaceMatch[1];
                const removeCount = Math.min(2, spaces.length);
                tr.delete(pos, pos + removeCount);
              }
            }
          }
        }

        dispatch(tr);

        if (!isEmpty) {
          const newFrom = tr.mapping.map(originalFrom, -1);
          const newTo = tr.mapping.map(originalTo, 1);
          if (newTo >= newFrom) {
            editor.chain().setTextSelection({ from: newFrom, to: newTo }).focus().run();
          } else {
            editor.chain().focus().run();
          }
        } else {
          editor.chain().focus().run();
        }

        return true;
      },
    };
  },
});
