/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * @file aiReferenceSelection.ts - Describe the selection for Copy Reference for AI
 * @description Says where the caret or selection sits in the document tree:
 *              top-level block, child at each level, and rendered line inside
 *              the innermost text block. The host turns that into source lines.
 *
 * The description is read from ProseMirror state, which keeps the selection
 * while the editor is blurred, so the Command Palette and the toolbar agree.
 */

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection, type EditorState } from '@tiptap/pm/state';
import {
  aiReferenceNodeKind,
  type AiReferenceLine,
  type AiReferencePoint,
  type AiReferenceSelection,
  type AiReferenceStep,
} from '../../shared/aiReferenceProtocol';

/** `start` reads forward from a position, `end` reads back from it. */
type Side = 'start' | 'end';

/** An empty text block below the top level (an empty cell or list item) still has a source line. */
function isEmptyNestedTextblock(parent: ProseMirrorNode, depth: number): boolean {
  return parent.isTextblock && parent.content.size === 0 && depth > 1;
}

/**
 * First position at or after `from` that has selected content after it, so a
 * selection starting at the end of one block begins in the next.
 */
function firstContentPosition(doc: ProseMirrorNode, from: number, to: number): number | null {
  let position = from;
  while (position < to) {
    const $position = doc.resolve(position);
    const after = $position.nodeAfter;
    if ($position.parent.isTextblock) {
      if (after || isEmptyNestedTextblock($position.parent, $position.depth)) return position;
      position = $position.after();
    } else if (!after) {
      if ($position.depth === 0) return null;
      position = $position.after();
    } else if (after.isLeaf || after.isAtom) {
      return position;
    } else {
      position += 1;
    }
  }
  return null;
}

/**
 * Last position at or before `to` that has selected content before it, so a
 * selection ending at the very start of a block does not include that block.
 */
function lastContentPosition(doc: ProseMirrorNode, to: number, from: number): number | null {
  let position = to;
  while (position > from) {
    const $position = doc.resolve(position);
    const before = $position.nodeBefore;
    if ($position.parent.isTextblock) {
      if (before || isEmptyNestedTextblock($position.parent, $position.depth)) return position;
      position = $position.before();
    } else if (!before) {
      if ($position.depth === 0) return null;
      position = $position.before();
    } else if (before.isLeaf || before.isAtom) {
      return position;
    } else {
      position -= 1;
    }
  }
  return null;
}

/**
 * The rendered line of an offset inside a text block. Lines are separated by
 * hard breaks, or by newline characters in a code block. For the end of a
 * selection the line is that of the last selected character, so ending right
 * after a break stays on the line the break closes.
 */
function lineAt(parent: ProseMirrorNode, offset: number, side: Side): AiReferenceLine {
  const limit = side === 'end' ? Math.max(0, offset - 1) : offset;
  let index = 0;
  let count = 1;

  parent.forEach((child, childOffset) => {
    if (child.type.name === 'hardBreak') {
      count += 1;
      if (childOffset + child.nodeSize <= limit) index += 1;
      return;
    }
    const text = child.isText ? (child.text ?? '') : '';
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) {
      count += 1;
      if (childOffset + at < limit) index += 1;
    }
  });

  return { index, count };
}

function pointAt(doc: ProseMirrorNode, position: number, side: Side): AiReferencePoint {
  const $position = doc.resolve(position);
  const steps: AiReferenceStep[] = [];
  for (let depth = 2; depth <= $position.depth; depth += 1) {
    steps.push({
      kind: aiReferenceNodeKind($position.node(depth).type.name),
      index: $position.index(depth - 1),
      count: $position.node(depth - 1).childCount,
    });
  }

  const parent = $position.parent;
  // Between blocks: the block after the position at a start, before it at an end.
  const childIndex = Math.min(
    Math.max(0, side === 'start' ? $position.index() : $position.index() - 1),
    Math.max(0, parent.childCount - 1)
  );
  if ($position.depth === 0) return { ordinal: childIndex, steps };

  const point: AiReferencePoint = { ordinal: $position.index(0), steps };
  if (parent.isTextblock) {
    point.line = lineAt(parent, $position.parentOffset, side);
  } else if (parent.childCount > 0) {
    steps.push({
      kind: aiReferenceNodeKind(parent.child(childIndex).type.name),
      index: childIndex,
      count: parent.childCount,
    });
  }
  return point;
}

/**
 * Describe the current caret or selection for the host.
 *
 * - Caret: the block and rendered line it is in.
 * - Selection: from the first to the last selected content.
 * - A node selected as a whole (a code block, an image): that node itself.
 *
 * @param state - Editor state to read; never modified
 */
export function describeAiReferenceSelection(state: EditorState): AiReferenceSelection {
  const { doc, selection } = state;
  const caret = (): AiReferenceSelection => {
    const point = pointAt(doc, selection.from, 'start');
    return { start: point, end: point };
  };
  if (selection.empty || selection instanceof NodeSelection) return caret();

  const first = firstContentPosition(doc, selection.from, selection.to);
  const last = first === null ? null : lastContentPosition(doc, selection.to, selection.from);
  if (first === null || last === null) return caret();

  return { start: pointAt(doc, first, 'start'), end: pointAt(doc, last, 'end') };
}
