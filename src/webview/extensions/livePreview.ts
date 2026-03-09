/**
 * Live Preview Extension — Obsidian-style formatting mark visibility
 *
 * When the cursor is inside formatted text (bold, italic, etc.), this plugin
 * adds inline decorations that reveal the markdown syntax characters around
 * the formatted region. When the cursor moves out, the decorations disappear.
 *
 * Phase 1: Bold (**), Italic (*), Strikethrough (~~), Highlight (==),
 *          Inline Code (`)
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorState } from '@tiptap/pm/state';

const LIVE_PREVIEW_KEY = new PluginKey('livePreview');

/**
 * Maps TipTap mark type names to their markdown opening/closing syntax.
 */
const MARK_SYNTAX: Record<string, { open: string; close: string }> = {
  bold: { open: '**', close: '**' },
  italic: { open: '*', close: '*' },
  strike: { open: '~~', close: '~~' },
  highlight: { open: '==', close: '==' },
  code: { open: '`', close: '`' },
};

/**
 * Build decorations that reveal formatting marks around the cursor position.
 *
 * For each mark active at the cursor, we find the exact range of that mark
 * in the document and add widget decorations at the boundaries to show
 * the markdown syntax.
 */
function buildDecorations(state: EditorState): DecorationSet {
  const { selection } = state;
  const { $from } = selection;
  const decorations: Decoration[] = [];

  // Don't show decorations if there's a multi-character selection
  // (only for cursor position / collapsed selection)
  if (!selection.empty) {
    return DecorationSet.empty;
  }

  // Get all marks at the cursor position
  const marks = $from.marks();

  for (const mark of marks) {
    const syntax = MARK_SYNTAX[mark.type.name];
    if (!syntax) continue;

    // Find the range of this mark around the cursor by scanning backwards
    // and forwards from the cursor position
    const markRange = findMarkRange($from, mark.type);
    if (!markRange) continue;

    const { from, to } = markRange;

    // Add opening syntax widget before the mark starts
    const openWidget = Decoration.widget(
      from,
      () => {
        const span = document.createElement('span');
        span.className = 'live-preview-syntax';
        span.textContent = syntax.open;
        return span;
      },
      { side: -1, key: `lp-open-${mark.type.name}-${from}` }
    );

    // Add closing syntax widget after the mark ends
    const closeWidget = Decoration.widget(
      to,
      () => {
        const span = document.createElement('span');
        span.className = 'live-preview-syntax';
        span.textContent = syntax.close;
        return span;
      },
      { side: 1, key: `lp-close-${mark.type.name}-${to}` }
    );

    decorations.push(openWidget, closeWidget);
  }

  // Phase 2: Block Elements (Headings, Blockquotes)
  // Traverse up the document tree from the cursor position to find block parent nodes
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    let prefix = '';

    if (node.type.name === 'heading') {
      const level = node.attrs.level as number;
      prefix = '#'.repeat(level) + ' ';
    } else if (node.type.name === 'blockquote') {
      prefix = '> ';
    }

    if (prefix) {
      const startPos = $from.start(depth);
      const prefixWidget = Decoration.widget(
        startPos,
        () => {
          const span = document.createElement('span');
          span.className = 'live-preview-syntax live-preview-syntax-block';
          span.textContent = prefix;
          return span;
        },
        { side: -1, key: `lp-block-${node.type.name}-${startPos}` }
      );
      decorations.push(prefixWidget);
    }
  }

  // Phase 3: HTML Tags (GenericHTMLInline)
  // These are atom nodes, meaning they don't wrap their content. We must find the opening
  // tag before the cursor and the closing tag after the cursor within the current block.
  const parent = $from.parent;
  let openHtmlNodeIndex = -1;
  let openHtmlNodePos = -1;
  let closeHtmlNodeIndex = -1;
  let closeHtmlNodePos = -1;
  let currentPos = $from.start();

  // Find the nearest opening HTML tag before the cursor
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    const childStart = currentPos;
    currentPos += child.nodeSize;

    if (childStart >= $from.pos) break; // Passed cursor

    if (child.type.name === 'genericHtmlInline') {
      const rawHtml = child.attrs.rawHtml as string;
      if (!rawHtml.startsWith('</')) {
        openHtmlNodeIndex = i;
        openHtmlNodePos = childStart;
      } else if (rawHtml.startsWith('</')) {
        // If we see a close tag before cursor, it closes a previous open tag.
        // Reset the open tag tracker.
        openHtmlNodeIndex = -1;
        openHtmlNodePos = -1;
      }
    }
  }

  // If we found an open tag before the cursor, look for the closing tag after
  if (openHtmlNodeIndex !== -1) {
    currentPos = $from.start();
    // Fast forward to cursor
    let i = 0;
    for (; i < parent.childCount; i++) {
      const child = parent.child(i);
      if (currentPos >= $from.pos) break;
      currentPos += child.nodeSize;
    }

    for (; i < parent.childCount; i++) {
      const child = parent.child(i);
      const childStart = currentPos;
      currentPos += child.nodeSize;

      if (child.type.name === 'genericHtmlInline') {
        const rawHtml = child.attrs.rawHtml as string;
        if (rawHtml.startsWith('</')) {
          closeHtmlNodeIndex = i;
          closeHtmlNodePos = childStart;
          break;
        } else {
          // Encountered another open tag before finding a close tag
          break;
        }
      }
    }
  }

  if (openHtmlNodeIndex !== -1 && closeHtmlNodeIndex !== -1) {
    // We are between an open and close HTML tag! Add decorations to make them visible.
    const openNode = parent.child(openHtmlNodeIndex);
    const closeNode = parent.child(closeHtmlNodeIndex);

    const openWidget = Decoration.widget(
      openHtmlNodePos,
      () => {
        const span = document.createElement('span');
        span.className = 'live-preview-syntax';
        span.textContent = openNode.attrs.rawHtml;
        return span;
      },
      { side: -1, key: `lp-html-open-${openHtmlNodePos}` }
    );

    const closeWidget = Decoration.widget(
      closeHtmlNodePos + closeNode.nodeSize,
      () => {
        const span = document.createElement('span');
        span.className = 'live-preview-syntax';
        span.textContent = closeNode.attrs.rawHtml;
        return span;
      },
      { side: 1, key: `lp-html-close-${closeHtmlNodePos}` }
    );

    decorations.push(openWidget, closeWidget);
  }

  return DecorationSet.create(state.doc, decorations);
}

/**
 * Find the contiguous range of a given mark type around a resolved position.
 * Scans backwards from the position to find where the mark starts,
 * and forwards to find where it ends.
 */
function findMarkRange(
  $pos: ReturnType<EditorState['doc']['resolve']>,
  markType: any
): { from: number; to: number } | null {
  const { parent, parentOffset } = $pos;

  // Find the text node at cursor position
  let startIndex = -1;
  let offset = 0;

  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (offset + child.nodeSize > parentOffset) {
      startIndex = i;
      break;
    }
    offset += child.nodeSize;
  }

  if (startIndex < 0) return null;

  // Verify the mark exists on this node
  const startNode = parent.child(startIndex);
  if (!markType.isInSet(startNode.marks)) return null;

  // Scan backwards — find the first child node that has this mark
  let from = offset;
  for (let i = startIndex - 1; i >= 0; i--) {
    const child = parent.child(i);
    if (!markType.isInSet(child.marks)) break;
    from -= child.nodeSize;
  }

  // Scan forwards — find the last child node that has this mark
  let to = offset + startNode.nodeSize;
  for (let i = startIndex + 1; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (!markType.isInSet(child.marks)) break;
    to += child.nodeSize;
  }

  // Convert from parent-relative offsets to absolute positions
  const parentStart = $pos.start();
  return { from: parentStart + from, to: parentStart + to };
}

/**
 * TipTap Extension that provides Obsidian-style live preview.
 */
export const LivePreview = Extension.create({
  name: 'livePreview',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: LIVE_PREVIEW_KEY,
        state: {
          init(_, state) {
            return buildDecorations(state);
          },
          apply(tr, decorations, _oldState, newState) {
            // Only rebuild when selection changes or document changes
            if (tr.selectionSet || tr.docChanged) {
              return buildDecorations(newState);
            }
            return decorations;
          },
        },
        props: {
          decorations(state) {
            return LIVE_PREVIEW_KEY.getState(state) as DecorationSet;
          },
        },
      }),
    ];
  },
});
