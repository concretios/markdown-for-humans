/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Soft Break Extension
 *
 * A CommonMark soft line break (spec §6.8): a single newline inside a
 * paragraph that is NOT preceded by two spaces or a backslash. Used when
 * `markdownForHumans.render.singleLineBreaks` is false.
 *
 * marked with `breaks: false` leaves that newline as a literal "\n" inside the
 * inline text token. ProseMirror renders the editing surface with
 * `white-space: break-spaces`, so a raw "\n" in a text node still DISPLAYS as
 * a line break even though no <br>/hardBreak exists. This node gives the soft
 * break its own identity so the two halves of the contract can differ:
 *
 * - on screen it reads as a single space, so a hard-wrapped paragraph flows
 *   into one line (matching VS Code's built-in preview);
 * - on save it serialises back to "\n", so an untouched paragraph round-trips
 *   with its original wrapping byte for byte (no trailing-two-space churn).
 *
 * Round-trip:
 * - parse: `softbreak` token (emitted by emitSoftBreakTokens) → softBreak node
 * - serialize: softBreak node → "\n"
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { SOFT_BREAK_TOKEN } from '../utils/markedLexerNormalizer';

export const SoftBreak = Node.create({
  name: 'softBreak',

  inline: true,
  group: 'inline',
  atom: true,
  // Not selectable: a click should land the caret beside it like a space,
  // not turn it into a node selection.
  selectable: false,
  draggable: false,

  parseHTML() {
    return [{ tag: 'span[data-soft-break]' }];
  },

  renderHTML({ HTMLAttributes }) {
    // contenteditable=false keeps the caret outside the leaf span. Otherwise a
    // click could land inside it and typed text would be discarded when
    // ProseMirror reparses the span back into a content-less softBreak node.
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-soft-break': '',
        class: 'md4h-soft-break',
        contenteditable: 'false',
      }),
      ' ',
    ];
  },

  // getText / clipboard text: a soft break reads as a space.
  renderText() {
    return ' ';
  },

  markdownTokenName: SOFT_BREAK_TOKEN,

  parseMarkdown: (_token, helpers) => helpers.createNode('softBreak', {}, []),

  renderMarkdown: (() => '\n') as unknown as never,
});
