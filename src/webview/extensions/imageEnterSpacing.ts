/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Extension } from '@tiptap/core';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { NodeSelection, Plugin, PluginKey, TextSelection, EditorState } from '@tiptap/pm/state';
import { Fragment, Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const IMAGE_ENTER_SPACING_PLUGIN = new PluginKey('imageEnterSpacing');

interface PluginState {
  decorations: DecorationSet;
  pendingDeleteImagePos: number | null;
}

function isImageNode(selection: unknown, imageTypeName: string): selection is NodeSelection {
  // Check for NodeSelection (handle both instanceof and duck-typing for test environments)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sel = selection as any;
  if (sel && typeof sel.node === 'object' && sel.node !== null) {
    const typeName = sel.node?.type?.name;
    return typeName === imageTypeName;
  }
  return false;
}

function isGapCursorSelection(selection: unknown): selection is GapCursor {
  if (selection instanceof GapCursor) return true;
  // Duck-typing for test environments where instanceof might fail
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sel = selection as any;
  return sel?.type === 'gapcursor' || sel?.constructor?.name === 'GapCursor';
}

function isTextSelection(selection: unknown): selection is TextSelection {
  if (selection instanceof TextSelection) return true;
  // Duck-typing for test environments where instanceof might fail
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sel = selection as any;
  return (
    sel?.type === 'text' ||
    sel?.constructor?.name === 'TextSelection' ||
    (sel?.$from && sel?.$to && !sel?.node && sel?.empty !== undefined)
  );
}

function isMenuButtonTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('.image-menu-button') || target.closest('.image-context-menu'));
}

/**
 * Calculate the document-level position after a given block index.
 * This is the position where we can insert a new block.
 */
function getPositionAfterBlock(state: EditorState, blockIndex: number): number {
  let pos = 0;
  const maxIndex = Math.min(blockIndex, state.doc.childCount - 1);
  for (let i = 0; i <= maxIndex; i++) {
    pos += state.doc.child(i).nodeSize;
  }
  return pos;
}

function canInsertParagraphAtDocPos(state: EditorState, docPos: number): boolean {
  if (docPos < 0 || docPos > state.doc.content.size) {
    return false;
  }

  const paragraphType = state.schema.nodes.paragraph;
  if (!paragraphType) {
    return false;
  }

  const paragraph = paragraphType.createAndFill();
  if (!paragraph) {
    return false;
  }

  try {
    const child = state.doc.childAfter(docPos);
    if (child.offset !== docPos) {
      return false;
    }
    return state.doc.canReplaceWith(child.index, child.index, paragraphType);
  } catch {
    return false;
  }
}

/**
 * Insert a paragraph at the specified document-level position.
 * The position must be between blocks (not inside a block).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function insertParagraphAtDocPos(view: any, state: EditorState, docPos: number): boolean {
  // Validate docPos is within bounds
  if (docPos < 0 || docPos > state.doc.content.size) {
    console.warn('[ImageEnterSpacing] docPos out of bounds', {
      docPos,
      docSize: state.doc.content.size,
    });
    return false;
  }

  const paragraphType = state.schema.nodes.paragraph;
  if (!paragraphType) {
    return false;
  }

  const paragraph = paragraphType.createAndFill();
  if (!paragraph) {
    return false;
  }

  try {
    const child = state.doc.childAfter(docPos);
    if (child.offset !== docPos) {
      console.warn('[ImageEnterSpacing] Cannot insert paragraph at non-boundary position', {
        docPos,
        offset: child.offset,
        index: child.index,
      });
      return false;
    }

    if (!state.doc.canReplaceWith(child.index, child.index, paragraphType)) {
      console.warn('[ImageEnterSpacing] Cannot insert paragraph at position', {
        docPos,
        index: child.index,
      });
      return false;
    }

    let tr = state.tr.insert(docPos, paragraph);

    // Set cursor inside the new paragraph
    try {
      const cursorPos = docPos + 1; // Inside the paragraph
      if (tr.doc && typeof tr.doc.resolve === 'function') {
        const $cursor = tr.doc.resolve(cursorPos);
        if ($cursor.parent && $cursor.parent.inlineContent) {
          tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
        }
      }
    } catch {
      // Cursor positioning failed, but insertion succeeded
    }

    view.dispatch(tr.scrollIntoView());
    return true;
  } catch (error) {
    console.warn('[ImageEnterSpacing] Failed to insert paragraph', error);
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getImageTypeName(state: any): string | undefined {
  return state?.schema?.nodes?.image?.name;
}

/**
 * Delete a selected image node by rebuilding the parent paragraph content.
 * This approach avoids schema validation errors that occur with tr.delete().
 *
 * Strategy:
 * - If image is not in a paragraph, delete directly
 * - If paragraph has only this one image, delete the entire paragraph
 * - Otherwise, rebuild paragraph content without the image (and clean up hardBreaks)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deleteSelectedImage(view: any, state: EditorState, selection: NodeSelection): boolean {
  try {
    const { from, to } = selection;
    const $from = state.doc.resolve(from);
    const parent = $from.parent;

    console.log('[ImageEnterSpacing] Deleting image', {
      from,
      to,
      depth: $from.depth,
      parentType: parent.type.name,
      parentChildCount: parent.childCount,
    });

    // If image is not inside a paragraph, simple delete
    if (parent.type.name !== 'paragraph') {
      const tr = state.tr.delete(from, to);
      if (tr.docChanged) {
        view.dispatch(tr);
        return true;
      }
      return false;
    }

    // Image is inside a paragraph - need to rebuild content
    // Find the index of the image in the paragraph
    const imageIndexInParagraph = $from.index();

    // Collect all children except the image, with proper hardBreak handling
    const children: ProseMirrorNode[] = [];
    let imageCount = 0;
    let hasTextContent = false;

    // First pass: count images and check for text
    parent.forEach(node => {
      if (node.type.name === 'image') {
        imageCount++;
      } else if (node.type.name !== 'hardBreak' && node.isText) {
        hasTextContent = true;
      }
    });

    console.log('[ImageEnterSpacing] Paragraph analysis', {
      imageCount,
      hasTextContent,
      imageIndex: imageIndexInParagraph,
    });

    // If this is the only image and no text content, delete the whole paragraph
    if (imageCount === 1 && !hasTextContent) {
      // Delete the entire paragraph block
      const paragraphStart = $from.before($from.depth);
      const paragraphEnd = $from.after($from.depth);

      console.log('[ImageEnterSpacing] Deleting entire paragraph', {
        paragraphStart,
        paragraphEnd,
      });

      const tr = state.tr.delete(paragraphStart, paragraphEnd);
      if (tr.docChanged) {
        view.dispatch(tr);
        return true;
      }
      return false;
    }

    // Multiple images or has text - rebuild paragraph without this image
    // Skip the image and one adjacent hardBreak to avoid double breaks
    let skipNextHardBreak = false;
    let lastWasHardBreak = false;

    parent.forEach((node, _offset, index) => {
      if (index === imageIndexInParagraph) {
        // Skip this image
        // If previous node was hardBreak and next will be hardBreak, we need to skip one
        if (lastWasHardBreak) {
          // Remove the last hardBreak we added to avoid double breaks
          if (children.length > 0 && children[children.length - 1].type.name === 'hardBreak') {
            children.pop();
          }
        } else {
          // Skip the next hardBreak instead
          skipNextHardBreak = true;
        }
      } else if (node.type.name === 'hardBreak' && skipNextHardBreak) {
        // Skip this hardBreak (it was after the deleted image)
        skipNextHardBreak = false;
        lastWasHardBreak = true;
      } else {
        children.push(node);
        lastWasHardBreak = node.type.name === 'hardBreak';
      }
    });

    // Clean up leading hardBreaks
    while (children.length > 0 && children[0].type.name === 'hardBreak') {
      children.shift();
    }

    // Clean up trailing hardBreaks
    while (children.length > 0 && children[children.length - 1].type.name === 'hardBreak') {
      children.pop();
    }

    // Remove consecutive hardBreaks (keep only one)
    const cleanedChildren: ProseMirrorNode[] = [];
    let prevWasHardBreak = false;
    for (const node of children) {
      if (node.type.name === 'hardBreak') {
        if (!prevWasHardBreak) {
          cleanedChildren.push(node);
          prevWasHardBreak = true;
        }
        // Skip consecutive hardBreaks
      } else {
        cleanedChildren.push(node);
        prevWasHardBreak = false;
      }
    }

    console.log('[ImageEnterSpacing] Rebuilt children', {
      originalChildCount: parent.childCount,
      newChildCount: cleanedChildren.length,
    });

    // If no children remain, delete the paragraph
    if (cleanedChildren.length === 0) {
      const paragraphStart = $from.before($from.depth);
      const paragraphEnd = $from.after($from.depth);
      const tr = state.tr.delete(paragraphStart, paragraphEnd);
      if (tr.docChanged) {
        view.dispatch(tr);
        return true;
      }
      return false;
    }

    // Replace the paragraph's content with cleaned up children
    const newContent = Fragment.from(cleanedChildren);
    const contentStart = $from.start(); // Start of paragraph content
    const contentEnd = $from.end(); // End of paragraph content

    console.log('[ImageEnterSpacing] Replacing paragraph content', {
      contentStart,
      contentEnd,
    });

    const tr = state.tr.replaceWith(contentStart, contentEnd, newContent);
    if (tr.docChanged) {
      view.dispatch(tr);
      return true;
    }
    return false;
  } catch (error) {
    console.warn('[ImageEnterSpacing] Failed to delete image', error);
    return false;
  }
}

/**
 * Build decorations for images based on selection and pending deletion state.
 */
function buildDecorations(
  state: EditorState,
  imageTypeName: string | undefined,
  pendingDeleteImagePos: number | null
): DecorationSet {
  if (!imageTypeName) {
    return DecorationSet.empty;
  }

  const doc = state.doc;
  if (!doc || typeof doc.resolve !== 'function') {
    return DecorationSet.empty;
  }

  const decorations: Decoration[] = [];
  const selection = state.selection;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addDecoration = (pos: number, node: any | null, className: string) => {
    if (typeof pos !== 'number') return;
    if (!node) return;

    const nodeSize = typeof node.nodeSize === 'number' ? node.nodeSize : 1;
    const end = pos + nodeSize;
    if (pos < 0 || end > doc.content.size) return;

    decorations.push(Decoration.node(pos, end, { class: className }));
  };

  // Check for pending deletion first (highest priority)
  if (pendingDeleteImagePos !== null && isImageNode(selection, imageTypeName)) {
    const imageNode = (selection as NodeSelection).node;
    const imagePos = (selection as NodeSelection).from;
    if (imagePos === pendingDeleteImagePos) {
      addDecoration(imagePos, imageNode, 'image-pending-delete');
      return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
    }
  }

  // Full highlight when image is selected (but not pending delete)
  if (isImageNode(selection, imageTypeName)) {
    const imageNode = (selection as NodeSelection).node;
    const imagePos = (selection as NodeSelection).from;
    if (imagePos !== pendingDeleteImagePos) {
      addDecoration(imagePos, imageNode, 'image-caret-selected');
      return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
    }
  }

  // Gap cursor beside image
  if (isGapCursorSelection(selection)) {
    const imageBefore = selection.$from.nodeBefore?.type.name === imageTypeName;
    const imageAfter = selection.$from.nodeAfter?.type.name === imageTypeName;

    if (imageBefore) {
      const pos = selection.$from.pos - selection.$from.nodeBefore!.nodeSize;
      addDecoration(pos, selection.$from.nodeBefore, 'image-caret-after');
    } else if (imageAfter) {
      const pos = selection.$from.pos;
      addDecoration(pos, selection.$from.nodeAfter, 'image-caret-before');
    }
  }

  // Text cursor hugging an inline image
  if (isTextSelection(selection) && selection.empty) {
    const imageBefore = selection.$from.nodeBefore?.type.name === imageTypeName;
    const imageAfter = selection.$from.nodeAfter?.type.name === imageTypeName;

    if (imageBefore) {
      const pos = selection.$from.pos - selection.$from.nodeBefore!.nodeSize;
      addDecoration(pos, selection.$from.nodeBefore, 'image-caret-after');
    } else if (imageAfter) {
      const pos = selection.$from.pos;
      addDecoration(pos, selection.$from.nodeAfter, 'image-caret-before');
    }
  }

  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

export const ImageEnterSpacing = Extension.create({
  name: 'imageEnterSpacing',

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: IMAGE_ENTER_SPACING_PLUGIN,
        state: {
          init: (_, state): PluginState => {
            const imageTypeName = getImageTypeName(state);
            return {
              decorations: buildDecorations(state, imageTypeName, null),
              pendingDeleteImagePos: null,
            };
          },
          apply: (tr, prev: PluginState, _oldState, newState): PluginState => {
            const imageTypeName = getImageTypeName(newState);

            // Check meta flag first (for explicit clearing)
            const meta = tr.getMeta(IMAGE_ENTER_SPACING_PLUGIN);
            let pendingDeleteImagePos = prev.pendingDeleteImagePos;

            if (meta?.clearPendingDelete) {
              pendingDeleteImagePos = null;
            } else if (meta?.setPendingDelete !== undefined) {
              pendingDeleteImagePos = meta.setPendingDelete;
            } else if (tr.selectionSet) {
              // Selection changed - clear pending deletion if selection is different
              // But don't clear if we just set it via meta (handled above)
              const newSelection = newState.selection;
              if (
                !isImageNode(newSelection, imageTypeName || '') ||
                (pendingDeleteImagePos !== null &&
                  (newSelection as NodeSelection).from !== pendingDeleteImagePos)
              ) {
                pendingDeleteImagePos = null;
              }
            } else if (tr.docChanged && pendingDeleteImagePos !== null) {
              // Document changed - likely the image was deleted, clear pending state
              // Check if image still exists at that position
              try {
                const $pos = newState.doc.resolve(pendingDeleteImagePos);
                const node = $pos.nodeAfter || $pos.nodeBefore;
                if (!node || node.type.name !== imageTypeName) {
                  // Image no longer exists - it was deleted
                  pendingDeleteImagePos = null;
                }
              } catch {
                // Position invalid (image was deleted), clear pending state
                pendingDeleteImagePos = null;
              }
            }

            // Only rebuild decorations if something changed
            if (
              !tr.selectionSet &&
              !tr.docChanged &&
              pendingDeleteImagePos === prev.pendingDeleteImagePos
            ) {
              return prev;
            }

            return {
              decorations: buildDecorations(newState, imageTypeName, pendingDeleteImagePos),
              pendingDeleteImagePos,
            };
          },
        },
        props: {
          decorations: state => {
            const pluginState = IMAGE_ENTER_SPACING_PLUGIN.getState(state) as PluginState;
            return pluginState?.decorations || DecorationSet.empty;
          },
          handleKeyDown: (view, event) => {
            if (!editor) return false;
            if (isMenuButtonTarget(event.target)) return false;

            const { state } = view;
            const { selection, schema } = state;
            const imageType = schema.nodes.image;

            if (!imageType) {
              return false;
            }

            const pluginState = IMAGE_ENTER_SPACING_PLUGIN.getState(state) as PluginState;
            const pendingDeleteImagePos = pluginState?.pendingDeleteImagePos ?? null;

            // Clear pending deletion on navigation/typing keys (check FIRST)
            const clearKeys = [
              'ArrowUp',
              'ArrowDown',
              'ArrowLeft',
              'ArrowRight',
              'Escape',
              'Tab',
              'Home',
              'End',
              'PageUp',
              'PageDown',
            ];
            if (
              clearKeys.includes(event.key) ||
              (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)
            ) {
              if (pendingDeleteImagePos !== null) {
                const tr = state.tr.setMeta(IMAGE_ENTER_SPACING_PLUGIN, {
                  clearPendingDelete: true,
                });
                view.dispatch(tr);
              }
              // Don't return true - let default behavior proceed
            }

            const moveGapCursor = (pos: number) => {
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const $pos = (state as any).doc?.resolve?.(pos);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const gapCursorCtor: any = GapCursor as any;
                const isValidGap =
                  $pos && typeof gapCursorCtor.valid === 'function' && gapCursorCtor.valid($pos);
                if (isValidGap) {
                  const tr = state.tr.setSelection(new GapCursor($pos)).scrollIntoView();
                  view.dispatch?.(tr);
                  return true;
                }
              } catch {
                // Fallback below
              }

              if (editor.commands?.setTextSelection) {
                return editor.commands.setTextSelection(pos);
              }
              return false;
            };

            // Arrow navigation: move caret to explicit gap before/after selected image
            if (
              isImageNode(selection, imageType.name) &&
              (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
            ) {
              event.preventDefault();
              event.stopPropagation();
              const targetPos = event.key === 'ArrowLeft' ? selection.from : selection.to;
              return moveGapCursor(targetPos);
            }

            // Backspace/Delete handling: two-step delete (select → delete)
            if (event.key === 'Backspace' || event.key === 'Delete') {
              // Step 2: Image is selected and pending deletion - delete it
              if (isImageNode(selection, imageType.name) && pendingDeleteImagePos !== null) {
                const selectionFrom = (selection as NodeSelection).from;
                console.log('[ImageEnterSpacing] Delete on pending image', {
                  selectionFrom,
                  pendingDeleteImagePos,
                  match: selectionFrom === pendingDeleteImagePos,
                });

                if (selectionFrom === pendingDeleteImagePos) {
                  event.preventDefault();
                  event.stopPropagation();
                  // Delete the selected image
                  const deleted = deleteSelectedImage(view, state, selection as NodeSelection);
                  console.log('[ImageEnterSpacing] Delete result:', deleted);
                  if (deleted) {
                    // Clear pending state - the deletion transaction will trigger apply
                    // We'll clear it in the apply function when docChanged
                    return true;
                  }
                  // If deletion failed, clear pending state anyway
                  const tr = state.tr.setMeta(IMAGE_ENTER_SPACING_PLUGIN, {
                    clearPendingDelete: true,
                  });
                  view.dispatch(tr);
                  return true;
                }
              }

              // Step 1: Text cursor adjacent to image - select it and set pending deletion
              if (isTextSelection(selection) && selection.empty) {
                const imageBefore = selection.$from.nodeBefore?.type.name === imageType.name;
                const imageAfter = selection.$from.nodeAfter?.type.name === imageType.name;

                let targetPos: number | null = null;

                if (event.key === 'Backspace' && imageBefore) {
                  // Backspace before image: select the image node
                  // Position is at the start of the image node (before it)
                  const imageNode = selection.$from.nodeBefore;
                  if (imageNode) {
                    targetPos = selection.$from.pos - imageNode.nodeSize;
                  }
                } else if (
                  event.key === 'Backspace' &&
                  imageAfter &&
                  // Only treat Backspace as a forward delete when the caret is at the start of the line.
                  // This avoids hijacking normal Backspace behavior when there is text before the caret.
                  (selection.$from.parentOffset === 0 ||
                    selection.$from.nodeBefore?.type.name === 'hardBreak')
                ) {
                  targetPos = selection.$from.pos;
                } else if (event.key === 'Delete' && imageAfter) {
                  // Delete after image: select the image node that's after the cursor
                  // Position is at the start of the image node (current cursor position)
                  targetPos = selection.$from.pos;
                }

                if (typeof targetPos === 'number' && Number.isFinite(targetPos)) {
                  // Select the image and set pending deletion state
                  try {
                    // Verify the position is valid and points to an image
                    const $targetPos = state.doc.resolve(targetPos);
                    const nodeAtPos = $targetPos.nodeAfter || $targetPos.nodeBefore;

                    if (nodeAtPos && nodeAtPos.type.name === imageType.name) {
                      // Create node selection and set pending deletion in one transaction
                      const nodeSelection = NodeSelection.create(state.doc, targetPos);
                      console.log('[ImageEnterSpacing] Setting pending deletion', {
                        targetPos,
                        nodeSize: nodeAtPos.nodeSize,
                        selectionFrom: nodeSelection.from,
                      });
                      const tr = state.tr
                        .setSelection(nodeSelection)
                        .setMeta(IMAGE_ENTER_SPACING_PLUGIN, { setPendingDelete: targetPos });
                      view.dispatch(tr);
                      event.preventDefault();
                      event.stopPropagation();
                      return true;
                    } else {
                      console.warn('[ImageEnterSpacing] Node at position is not an image', {
                        targetPos,
                        nodeType: nodeAtPos?.type?.name,
                        nodeAtPos: !!nodeAtPos,
                      });
                    }
                  } catch (error) {
                    console.warn('[ImageEnterSpacing] Failed to select image for deletion', {
                      error,
                      targetPos,
                    });
                    // Position invalid, fall through
                  }
                }
              }
            }

            // Early exit if not handling Enter
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
              return false;
            }

            // Image-adjacent Enter should insert a paragraph and stop propagation
            if (event.key === 'Enter') {
              // Clear pending deletion when Enter is pressed
              if (pendingDeleteImagePos !== null) {
                const tr = state.tr.setMeta(IMAGE_ENTER_SPACING_PLUGIN, {
                  clearPendingDelete: true,
                });
                view.dispatch(tr);
              }

              // Get selection position info
              const { $from } = selection;

              // 0) Handle Enter at the end of ANY block type (heading, blockquote, etc.) when followed by images
              // This prevents empty paragraphs from being created, which serialize with extra blank lines
              const parent = $from.parent;
              const isAtEndOfBlock = $from.parentOffset === parent.content.size;

              if (isAtEndOfBlock && parent.type.name !== 'paragraph') {
                // Check if the next sibling block starts with an image
                const blockDepth = $from.depth;
                const indexInDoc = $from.index(blockDepth - 1);
                const parentNode = $from.node(blockDepth - 1);

                if (indexInDoc + 1 < parentNode.childCount) {
                  const nextBlock = parentNode.child(indexInDoc + 1);

                  // Check if next block is a paragraph starting with an image
                  if (nextBlock.type.name === 'paragraph' && nextBlock.childCount > 0) {
                    const firstChild = nextBlock.child(0);
                    if (firstChild.type.name === imageType.name) {
                      // Insert a single paragraph after current block
                      event.preventDefault();
                      event.stopPropagation();

                      const paragraphType = state.schema.nodes.paragraph;
                      const newParagraph = paragraphType.create();
                      const insertPos = $from.after(blockDepth);

                      const tr = state.tr.insert(insertPos, newParagraph);
                      const cursorPos = insertPos + 1;
                      try {
                        tr.setSelection(TextSelection.create(tr.doc, cursorPos));
                      } catch {
                        // Cursor positioning failed
                      }
                      view.dispatch(tr.scrollIntoView());
                      return true;
                    }
                  }
                }
              }

              // 1) Image is selected (node selection) – insert paragraph after the containing block
              if (isImageNode(selection, imageType.name)) {
                const $pos = selection.$from;
                const blockIndex = $pos.index(0);
                const insertPos = getPositionAfterBlock(state, blockIndex);

                if (!canInsertParagraphAtDocPos(state, insertPos)) {
                  return false;
                }

                event.preventDefault();
                event.stopPropagation();

                return insertParagraphAtDocPos(view, state, insertPos);
              }

              // 2) Gap cursor beside an image – insert paragraph at document level
              if (isGapCursorSelection(selection)) {
                const imageBefore = selection.$from.nodeBefore?.type.name === imageType.name;
                const imageAfter = selection.$from.nodeAfter?.type.name === imageType.name;

                if (imageBefore || imageAfter) {
                  const insertPos = selection.head;

                  if (!canInsertParagraphAtDocPos(state, insertPos)) {
                    return false;
                  }

                  event.preventDefault();
                  event.stopPropagation();

                  console.log('[ImageEnterSpacing] Enter at gap cursor', {
                    gapPos: selection.head,
                    imageBefore,
                    imageAfter,
                    insertPos,
                  });

                  const inserted = insertParagraphAtDocPos(view, state, insertPos);
                  console.log('[ImageEnterSpacing] Insert result:', inserted);
                  return inserted;
                }
              }

              // 3) Text cursor directly before/after an image – split paragraph at cursor position
              if (isTextSelection(selection) && selection.empty) {
                const $from = selection.$from;
                const parent = $from.parent;

                // Only handle if we're in a paragraph (not heading, blockquote, etc.)
                if (parent.type.name !== 'paragraph') {
                  return false;
                }

                const imageBefore = $from.nodeBefore?.type.name === imageType.name;
                const imageAfter = $from.nodeAfter?.type.name === imageType.name;

                // Check for hardBreak next to image
                const hardBreakBefore = $from.nodeBefore?.type.name === 'hardBreak';
                const hardBreakAfter = $from.nodeAfter?.type.name === 'hardBreak';

                // Determine if we're near an image
                let imageNearby = imageBefore || imageAfter;

                // Also check if hardBreak is next to an image
                if (!imageNearby && $from.parent && $from.parent.type.name === 'paragraph') {
                  try {
                    const indexInParent = $from.index();
                    const parent = $from.parent;
                    if (hardBreakBefore && indexInParent > 1) {
                      const prevPrevNode = parent.maybeChild(indexInParent - 2);
                      if (prevPrevNode?.type.name === 'image') imageNearby = true;
                    }
                    if (hardBreakAfter && indexInParent + 1 < parent.childCount) {
                      const nextNextNode = parent.maybeChild(indexInParent + 1);
                      if (nextNextNode?.type.name === 'image') imageNearby = true;
                    }
                  } catch {
                    // Index access failed, ignore
                  }
                }

                if (imageBefore || imageAfter || imageNearby) {
                  event.preventDefault();
                  event.stopPropagation();

                  const parent = $from.parent;

                  // Check if we're inside a paragraph and should split it
                  if (parent && parent.type.name === 'paragraph' && parent.childCount > 1) {
                    try {
                      // Use index-based splitting for more reliable behavior
                      const indexInParent = $from.index();
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const beforeContent: any[] = [];
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const afterContent: any[] = [];

                      // Split at the index - everything before goes to beforeContent,
                      // everything at and after goes to afterContent
                      for (let i = 0; i < parent.childCount; i++) {
                        const node = parent.child(i);
                        if (i < indexInParent) {
                          beforeContent.push(node);
                        } else {
                          afterContent.push(node);
                        }
                      }

                      // Clean up hardBreaks at boundaries
                      while (
                        beforeContent.length > 0 &&
                        beforeContent[beforeContent.length - 1].type.name === 'hardBreak'
                      ) {
                        beforeContent.pop();
                      }
                      while (afterContent.length > 0 && afterContent[0].type.name === 'hardBreak') {
                        afterContent.shift();
                      }

                      // Only split if we have content on both sides
                      if (beforeContent.length > 0 && afterContent.length > 0) {
                        const paragraphType = state.schema.nodes.paragraph;
                        const paragraphStart = $from.before($from.depth);
                        const paragraphEnd = $from.after($from.depth);

                        const newNodes = [
                          paragraphType.create(null, Fragment.from(beforeContent)),
                          paragraphType.create(), // Empty paragraph for cursor
                          paragraphType.create(null, Fragment.from(afterContent)),
                        ];

                        const tr = state.tr.replaceWith(paragraphStart, paragraphEnd, newNodes);

                        // Position cursor in the empty paragraph
                        const cursorPos = paragraphStart + newNodes[0].nodeSize + 1;
                        try {
                          tr.setSelection(TextSelection.create(tr.doc, cursorPos));
                        } catch {
                          // Cursor positioning failed
                        }

                        view.dispatch(tr.scrollIntoView());
                        return true;
                      }
                    } catch (error) {
                      console.warn('[ImageEnterSpacing] Failed to split paragraph', error);
                    }
                  }

                  // Fallback: insert paragraph after the current paragraph block
                  // Use $from.after($from.depth) to get position immediately after paragraph
                  // (not after paragraph + subsequent blocks like GitHub alerts)
                  const paragraphType = state.schema.nodes.paragraph;
                  const newParagraph = paragraphType.create();
                  const insertAfterPos = $from.after($from.depth);

                  const tr = state.tr.insert(insertAfterPos, newParagraph);
                  const cursorPos = insertAfterPos + 1; // Inside new paragraph
                  try {
                    tr.setSelection(TextSelection.create(tr.doc, cursorPos));
                  } catch {
                    // Cursor positioning failed
                  }
                  view.dispatch(tr.scrollIntoView());
                  return true;
                }
              }
            }

            return false;
          },
        },
      }),
    ];
  },
});
