/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Extension } from '@tiptap/core';

/**
 * Map Enter inside table cells/headers to a hard break instead of a new paragraph.
 *
 * WHY: TipTap's default Enter runs `splitBlock`, which creates a second paragraph
 * inside the cell. GFM pipe tables serialize multi-paragraph cells as `<br>`, but
 * HTML-origin tables flatten via `collectText` and silently drop the break.
 * Hard breaks stay in one paragraph and round-trip as `<br>` (GFM) or `\n` (HTML).
 *
 * Tab / Shift-Tab row navigation remains owned by the Table extension.
 * Shift-Enter already inserts hardBreak via the HardBreak extension.
 */
export const TableCellEnterHardBreak = Extension.create({
  name: 'tableCellEnterHardBreak',

  // Run before Paragraph/StarterKit Enter (splitBlock) so table cells win.
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        if (!this.editor.isActive('tableCell') && !this.editor.isActive('tableHeader')) {
          return false;
        }
        return this.editor.commands.setHardBreak();
      },
    };
  },
});
