/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Math slash-command extension.
 *
 * Lightweight, isolated input rules so users can type one of:
 *   `/math ` or `/equation `   → insert an empty display math block
 *   `/inline-math `             → insert an empty inline math node
 *
 * Implemented as TipTap input rules so it doesn't touch the rest of the
 * editor. If the math nodes aren't registered (for example because
 * `enableMath` is off) this extension is a no-op — but the wiring in
 * editor.ts only enables it alongside the math extensions, so it never
 * fires in the disabled state.
 */

import { Extension, InputRule } from '@tiptap/core';

export const MathSlashCommand = Extension.create({
  name: 'mathSlashCommand',

  addInputRules() {
    const editor = this.editor;
    const schema = editor.schema;

    const insertBlock = (range: { from: number; to: number }) => {
      const mathBlockType = schema.nodes.mathBlock;
      if (!mathBlockType) return false;

      const $from = editor.state.doc.resolve(range.from);
      const blockRange = $from.blockRange();

      const tr = editor.state.tr;
      // If the slash command is the only content in its block, replace the
      // whole block. Otherwise just delete the trigger text and insert.
      if (
        blockRange &&
        $from.parent.textContent === editor.state.doc.textBetween(blockRange.start, range.to, '\n')
      ) {
        tr.replaceWith(blockRange.start, blockRange.end, mathBlockType.create({ latex: '' }));
      } else {
        tr.delete(range.from, range.to);
        tr.insert(tr.mapping.map(range.from), mathBlockType.create({ latex: '' }));
      }

      editor.view.dispatch(tr);
      return true;
    };

    const insertInline = (range: { from: number; to: number }) => {
      const inlineMathType = schema.nodes.inlineMath;
      if (!inlineMathType) return false;

      const tr = editor.state.tr;
      tr.delete(range.from, range.to);
      tr.insert(tr.mapping.map(range.from), inlineMathType.create({ latex: '' }));
      editor.view.dispatch(tr);
      return true;
    };

    const openEditorForLastNode = async (mode: 'inline' | 'block') => {
      const { showMathEditor } = await import('../features/mathEditor');
      const result = await showMathEditor({
        initialLatex: '',
        displayMode: mode === 'block',
      });
      if (!result.wasSaved) return;

      const targetType = mode === 'block' ? 'mathBlock' : 'inlineMath';
      const { state, view } = editor;
      // Walk the document backwards to find the most recent empty math node.
      let pos = -1;
      state.doc.descendants((node, p) => {
        if (node.type.name === targetType && (!node.attrs.latex || node.attrs.latex === '')) {
          pos = p;
        }
        return true;
      });
      if (pos === -1) return;
      const node = state.doc.nodeAt(pos);
      if (!node) return;
      view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, latex: result.latex }));
    };

    return [
      new InputRule({
        find: /(?:^|\s)\/(?:math|equation)\s$/,
        handler: ({ range, match }) => {
          const matchedText = match[0];
          const adjustedFrom = range.from + (matchedText.startsWith(' ') ? 1 : 0);
          if (insertBlock({ from: adjustedFrom, to: range.to })) {
            void openEditorForLastNode('block');
          }
        },
      }),
      new InputRule({
        find: /(?:^|\s)\/inline-math\s$/,
        handler: ({ range, match }) => {
          const matchedText = match[0];
          const adjustedFrom = range.from + (matchedText.startsWith(' ') ? 1 : 0);
          if (insertInline({ from: adjustedFrom, to: range.to })) {
            void openEditorForLastNode('inline');
          }
        },
      }),
    ];
  },
});
