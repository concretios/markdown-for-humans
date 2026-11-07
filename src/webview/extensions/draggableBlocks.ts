/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import { type EditorView } from '@tiptap/pm/view';
import { Node as ProsemirrorNode } from '@tiptap/pm/model';
import * as l10n from '../l10n';

// ─── Type augmentation ────────────────────────────────────────────────────────

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    draggableBlocks: {
      moveBlockUp: () => ReturnType;
      moveBlockDown: () => ReturnType;
    };
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const draggableBlocksPluginKey = new PluginKey<null>('draggableBlocks');
const AUTO_SCROLL_THRESHOLD = 80;
const AUTO_SCROLL_MAX_SPEED = 14;
const DRAG_START_DISTANCE = 4;
const GHOST_DROP_DURATION_MS = 260;
// Ghost is anchored to the drop indicator, not the cursor — so it can't
// follow the pointer off-screen. These are the offsets from the indicator's
// left/top edge (right + below the blue line).
const GHOST_INDICATOR_OFFSET_X = 16;
const GHOST_INDICATOR_OFFSET_Y = 12;

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'codeBlock',
  'blockquote',
  'table',
  'horizontalRule',
  'image',
  'mermaid',
  'mathBlock',
  'githubAlert',
  'indentedImageCodeBlock',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function isDraggableBlock(node: ProsemirrorNode): boolean {
  if (!BLOCK_TYPES.has(node.type.name)) return false;
  // Skip empty paragraphs — including the trailing-node placeholder that TipTap
  // auto-appends when the document ends in a non-paragraph block.
  if (node.type.name === 'paragraph' && node.content.size === 0) return false;
  return true;
}

/**
 * Position immediately after the last non-empty top-level block — i.e. the
 * highest doc position that is not inside (or after) a trailing empty
 * paragraph. `getEditorMarkdownForSync` strips trailing empty paragraphs at
 * serialization time, so anything dropped past this position lands AFTER the
 * empties; on save those empties no longer trail and survive as a phantom
 * blank line in the middle of the markdown.
 */
function lastInsertablePos(doc: ProsemirrorNode): number {
  let pos = doc.content.size;
  for (let i = doc.childCount - 1; i >= 0; i--) {
    const child = doc.child(i);
    if (child.type.name === 'paragraph' && child.content.size === 0) {
      pos -= child.nodeSize;
    } else {
      break;
    }
  }
  return pos;
}

function topLevelBlockAt(
  view: EditorView,
  pos: number
): { node: ProsemirrorNode; pos: number; index: number } | null {
  const $pos = view.state.doc.resolve(Math.max(0, Math.min(pos, view.state.doc.content.size - 1)));
  for (let d = $pos.depth; d >= 1; d--) {
    if ($pos.node(d - 1).type.name === 'doc' && $pos.node(d).isBlock) {
      return {
        node: $pos.node(d),
        pos: $pos.before(d),
        index: $pos.index(d - 1),
      };
    }
  }
  return null;
}

/**
 * Y-axis-based top-level block lookup. Walks the doc's top-level children,
 * inspecting each one's DOM bounding rect. Returns the block whose vertical
 * range contains clientY (a "hit"), otherwise the nearest block by Y distance.
 *
 * Needed because posAtCoords() returns null when the cursor is over NodeView
 * content the editor treats as opaque (e.g. Mermaid SVGs, or the gap between
 * two stacked NodeViews) — so both the drag handle and the drop indicator
 * lose their reference block.
 */
function findBlockByClientY(
  view: EditorView,
  clientY: number
): { node: ProsemirrorNode; pos: number; dom: HTMLElement; hit: boolean } | null {
  const doc = view.state.doc;
  let pos = 0;
  let closest: {
    node: ProsemirrorNode;
    pos: number;
    dom: HTMLElement;
    dist: number;
  } | null = null;

  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i);
    const blockPos = pos;
    pos += node.nodeSize;
    const dom = view.nodeDOM(blockPos) as HTMLElement | null;
    if (!dom || typeof dom.getBoundingClientRect !== 'function') continue;
    const rect = dom.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (clientY >= rect.top && clientY <= rect.bottom) {
      return { node, pos: blockPos, dom, hit: true };
    }
    const dist = clientY < rect.top ? rect.top - clientY : clientY - rect.bottom;
    if (!closest || dist < closest.dist) {
      closest = { node, pos: blockPos, dom, dist };
    }
  }

  return closest ? { ...closest, hit: false } : null;
}

/**
 * Decide where the dragged block would land. `valid` is false when the
 * insertion point would land inside an opaque block (codeBlock, mathBlock)
 * instead of between top-level blocks, or when the drop is a self-drop
 * no-op — callers use this to render the indicator red and abort on release.
 */
function computeDropTarget(
  view: EditorView,
  clientX: number,
  clientY: number,
  draggedPos: number
): { insertPos: number; valid: boolean } {
  const editorRect = view.dom.getBoundingClientRect();
  const doc = view.state.doc;

  // Drops past the last non-empty block would survive serialization as a
  // phantom blank line — clamp to the position before any trailing empties.
  const maxInsertable = lastInsertablePos(doc);
  const validate = (insertPos: number): { insertPos: number; valid: boolean } => {
    const clamped = Math.max(0, Math.min(insertPos, maxInsertable));
    const $insert = doc.resolve(clamped);
    // Top-level insertion only — parent must be the doc node. Guards against
    // accidentally landing inside a codeBlock/mathBlock.
    const atDocLevel = $insert.parent.type.name === 'doc';
    // No-op self-drop: dropping on a block's own boundary leaves it in place.
    const draggedNode = draggedPos >= 0 ? doc.resolve(draggedPos).nodeAfter : null;
    const draggedSize = draggedNode ? draggedNode.nodeSize : 0;
    const isSelfDrop =
      draggedPos >= 0 && (clamped === draggedPos || clamped === draggedPos + draggedSize);
    return { insertPos: clamped, valid: atDocLevel && !isSelfDrop };
  };

  // Primary path: posAtCoords → top-level block. Works reliably for regular
  // text/heading/list content.
  const coords = view.posAtCoords({ left: clientX, top: clientY });
  if (coords) {
    const block = topLevelBlockAt(view, coords.pos);
    if (block) {
      const domNode = view.nodeDOM(block.pos) as HTMLElement | null;
      if (domNode) {
        const rect = domNode.getBoundingClientRect();
        const insertPos =
          clientY < rect.top + rect.height / 2 ? block.pos : block.pos + block.node.nodeSize;
        return validate(insertPos);
      }
    }
  }

  // Fallback: Y-based block lookup — used when posAtCoords returns null over
  // NodeView content (Mermaid SVGs) or in the gap between two stacked NodeViews.
  const hit = findBlockByClientY(view, clientY);
  if (hit) {
    const rect = hit.dom.getBoundingClientRect();
    const insertPos = clientY < rect.top + rect.height / 2 ? hit.pos : hit.pos + hit.node.nodeSize;
    return validate(insertPos);
  }

  if (clientY <= editorRect.top) return validate(0);
  if (clientY >= editorRect.bottom) return validate(doc.content.size);
  return { insertPos: draggedPos, valid: false };
}

// ─── Drag-handle overlay controller ──────────────────────────────────────────

/**
 * Manages the floating drag handle, drop indicator, and ghost-clone overlay
 * elements for block reordering, plus all pointer-event lifecycle for the
 * drag itself (arm → start → update → finish/cancel).
 *
 * The overlays live in `document.body` rather than inside ProseMirror's DOM
 * so they don't interact with editor decorations or interfere with NodeView
 * mounting; positions are computed from `view.nodeDOM` bounding rects.
 */
class DragHandleController {
  private readonly view: EditorView;
  private readonly handle: HTMLElement;
  private readonly indicator: HTMLElement;

  private hoveredBlock: { node: ProsemirrorNode; pos: number; index: number } | null = null;
  private _handleBlock: { node: ProsemirrorNode; pos: number; index: number } | null = null;
  private _hideTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // Pointer-drag state — pendingDrag is "armed but not yet past threshold".
  private pendingDrag: {
    block: { node: ProsemirrorNode; pos: number; index: number };
    pointerX: number;
    pointerY: number;
    pointerId: number;
  } | null = null;

  private isDragging = false;
  private draggedPos = -1;
  private dropInsertPos = -1;
  private dropValid = false;
  private ghost: HTMLElement | null = null;
  private scrollRafId: number | null = null;
  private _autoScrollSpeed = 0;
  // Last pointer coords seen while dragging — used by the auto-scroll RAF to
  // re-evaluate the drop target after each scroll step (the cursor's clientY
  // is constant while the page moves under it, so dropInsertPos otherwise
  // becomes stale and the element lands at the pre-scroll position).
  private _lastPointerX = 0;
  private _lastPointerY = 0;

  private readonly _onMouseMove: (e: MouseEvent) => void;
  private readonly _onMouseLeave: (e: MouseEvent) => void;
  private readonly _onHandleMouseEnter: (e: MouseEvent) => void;
  private readonly _onHandleMouseLeave: (e: MouseEvent) => void;
  private readonly _onPointerDown: (e: PointerEvent) => void;
  private readonly _onPointerMove: (e: PointerEvent) => void;
  private readonly _onPointerUp: (e: PointerEvent) => void;
  private readonly _onPointerCancel: (e: PointerEvent) => void;
  private readonly _onKeyDown: (e: KeyboardEvent) => void;

  constructor(_editor: Editor, view: EditorView) {
    this.view = view;

    this.handle = document.createElement('div');
    this.handle.className = 'drag-block-handle';
    this.handle.setAttribute('role', 'button');
    this.handle.setAttribute('aria-label', l10n.t('Drag to move block'));
    this.handle.setAttribute('title', l10n.t('Drag to move block'));
    this.handle.innerHTML = `<svg width="12" height="18" viewBox="0 0 12 18" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.8"/><circle cx="9" cy="3" r="1.8"/><circle cx="3" cy="9" r="1.8"/><circle cx="9" cy="9" r="1.8"/><circle cx="3" cy="15" r="1.8"/><circle cx="9" cy="15" r="1.8"/></svg>`;
    document.body.appendChild(this.handle);

    this.indicator = document.createElement('div');
    this.indicator.className = 'drag-block-indicator';
    document.body.appendChild(this.indicator);

    this._onMouseMove = this.onMouseMove.bind(this);
    this._onMouseLeave = this.onMouseLeave.bind(this);
    this._onHandleMouseEnter = this.onHandleMouseEnter.bind(this);
    this._onHandleMouseLeave = this.onHandleMouseLeave.bind(this);
    this._onPointerDown = this.onPointerDown.bind(this);
    this._onPointerMove = this.onPointerMove.bind(this);
    this._onPointerUp = this.onPointerUp.bind(this);
    this._onPointerCancel = this.onPointerCancel.bind(this);
    this._onKeyDown = this.onKeyDown.bind(this);

    view.dom.addEventListener('mousemove', this._onMouseMove);
    view.dom.addEventListener('mouseleave', this._onMouseLeave);
    this.handle.addEventListener('mouseenter', this._onHandleMouseEnter);
    this.handle.addEventListener('mouseleave', this._onHandleMouseLeave);
    this.handle.addEventListener('pointerdown', this._onPointerDown);
    this.handle.addEventListener('pointermove', this._onPointerMove);
    this.handle.addEventListener('pointerup', this._onPointerUp);
    this.handle.addEventListener('pointercancel', this._onPointerCancel);
    window.addEventListener('keydown', this._onKeyDown);
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.isDragging || this.pendingDrag) return;
    if (this._hideTimeoutId !== null) {
      clearTimeout(this._hideTimeoutId);
      this._hideTimeoutId = null;
    }

    let block: { node: ProsemirrorNode; pos: number; index: number } | null = null;
    const coords = this.view.posAtCoords({ left: e.clientX, top: e.clientY });
    if (coords) {
      block = topLevelBlockAt(this.view, coords.pos);
    }
    // Fallback for NodeViews (Mermaid, etc.) where posAtCoords may fail over
    // opaque content — so the handle still works when hovering a diagram.
    if (!block) {
      const hit = findBlockByClientY(this.view, e.clientY);
      if (hit && hit.hit) {
        block = { node: hit.node, pos: hit.pos, index: -1 };
      }
    }

    if (!block || !isDraggableBlock(block.node)) {
      this.hideHandle();
      return;
    }
    this.hoveredBlock = block;
    this._handleBlock = block;
    this.positionHandle(block.pos);
  }

  private onMouseLeave(e: MouseEvent): void {
    if (this.isDragging || this.pendingDrag) return;
    if (e.relatedTarget instanceof Node && this.handle.contains(e.relatedTarget)) return;
    if (this._hideTimeoutId !== null) clearTimeout(this._hideTimeoutId);
    this._hideTimeoutId = setTimeout(() => {
      this._hideTimeoutId = null;
      if (!this.isDragging && !this.pendingDrag) this.hideHandle();
    }, 150);
  }

  private onHandleMouseEnter(): void {
    if (this._hideTimeoutId !== null) {
      clearTimeout(this._hideTimeoutId);
      this._hideTimeoutId = null;
    }
    if (!this.hoveredBlock && this._handleBlock) {
      this.hoveredBlock = this._handleBlock;
    }
  }

  private onHandleMouseLeave(e: MouseEvent): void {
    if (this.isDragging || this.pendingDrag || e.buttons !== 0) return;
    if (e.relatedTarget instanceof Node && this.view.dom.contains(e.relatedTarget)) return;
    this.hideHandle();
  }

  private positionHandle(blockPos: number): void {
    const domNode = this.view.nodeDOM(blockPos) as HTMLElement | null;
    if (!domNode) {
      this.hideHandle();
      return;
    }
    const editorRect = this.view.dom.getBoundingClientRect();
    const nodeRect = domNode.getBoundingClientRect();
    const centreY = Math.min(
      Math.max(nodeRect.top + nodeRect.height / 2, editorRect.top),
      editorRect.bottom
    );
    const left = editorRect.left - 32;
    const top = centreY - 16;
    this.handle.style.left = `${left}px`;
    this.handle.style.top = `${top}px`;
    this.handle.style.display = 'flex';
  }

  private hideHandle(): void {
    this.handle.style.display = 'none';
    this.hoveredBlock = null;
  }

  /**
   * Lower bound (in viewport coordinates) for the ghost and drop indicator —
   * the bottom edge of the sticky formatting toolbar. Without this, dragging
   * upward lets both elements slip behind the toolbar (which sits at z-index
   * 100, above them).
   */
  private getViewportClampTop(): number {
    const toolbar = document.querySelector('.formatting-toolbar') as HTMLElement | null;
    if (toolbar) {
      const rect = toolbar.getBoundingClientRect();
      if (rect.bottom > 0) return rect.bottom;
    }
    return 0;
  }

  // ── Pointer drag lifecycle ─────────────────────────────────────────────────

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const block = this.hoveredBlock ?? this._handleBlock;
    if (!block) return;
    const blockDom = this.view.nodeDOM(block.pos) as HTMLElement | null;
    if (!blockDom) return;
    e.preventDefault();
    this.pendingDrag = {
      block,
      pointerX: e.clientX,
      pointerY: e.clientY,
      pointerId: e.pointerId,
    };
    this.handle.setPointerCapture(e.pointerId);
    this.handle.classList.add('drag-block-handle--active');
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.pendingDrag && !this.isDragging) {
      const dx = e.clientX - this.pendingDrag.pointerX;
      const dy = e.clientY - this.pendingDrag.pointerY;
      if (dx * dx + dy * dy >= DRAG_START_DISTANCE * DRAG_START_DISTANCE) {
        this.startDrag();
      }
    }
    if (this.isDragging) {
      this.updateDrag(e.clientX, e.clientY);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.handle.hasPointerCapture(e.pointerId)) {
      this.handle.releasePointerCapture(e.pointerId);
    }
    if (this.isDragging) {
      this.finishDrag();
    } else if (this.pendingDrag) {
      this.pendingDrag = null;
      this.handle.classList.remove('drag-block-handle--active');
    }
  }

  private onPointerCancel(e: PointerEvent): void {
    if (this.handle.hasPointerCapture(e.pointerId)) {
      this.handle.releasePointerCapture(e.pointerId);
    }
    if (this.isDragging) {
      this.cancelDrag();
    } else {
      this.pendingDrag = null;
      this.handle.classList.remove('drag-block-handle--active');
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.isDragging) {
      this.cancelDrag();
    }
  }

  private startDrag(): void {
    if (!this.pendingDrag) return;
    const { block } = this.pendingDrag;
    const blockDom = this.view.nodeDOM(block.pos) as HTMLElement | null;
    if (!blockDom) {
      this.pendingDrag = null;
      this.handle.classList.remove('drag-block-handle--active');
      return;
    }

    this.isDragging = true;
    this.draggedPos = block.pos;
    this.pendingDrag = null;

    const rect = blockDom.getBoundingClientRect();
    const ghost = blockDom.cloneNode(true) as HTMLElement;
    ghost.classList.add('drag-block-ghost');
    // Strip stray drag classes so the ghost looks like the live block.
    ghost.classList.remove('drag-block-dragging', 'drag-block-just-dropped');
    ghost.style.width = `${rect.width}px`;
    document.body.appendChild(ghost);
    this.ghost = ghost;

    blockDom.classList.add('drag-block-dragging');
    document.body.classList.add('is-dragging-block');
    this.hideHandle();
  }

  private updateDrag(clientX: number, clientY: number): void {
    this._lastPointerX = clientX;
    this._lastPointerY = clientY;
    // Recompute auto-scroll first so its direction is current when we decide
    // which side of the indicator to render the ghost on.
    this.maybeAutoScroll(clientY);
    this.refreshDropTarget();
  }

  /**
   * Recompute drop position, indicator, and ghost placement using the last
   * known pointer coords. Called from `updateDrag` (on every pointer move)
   * and from the auto-scroll RAF (so the drop target tracks the content as
   * it scrolls under a stationary cursor).
   */
  private refreshDropTarget(): void {
    if (!this.isDragging) return;
    const clientX = this._lastPointerX;
    const clientY = this._lastPointerY;
    const { insertPos, valid } = computeDropTarget(this.view, clientX, clientY, this.draggedPos);
    this.dropInsertPos = insertPos;
    this.dropValid = valid;
    const indicatorPos = this.positionIndicator(clientY, insertPos, valid);
    if (this.ghost && indicatorPos) {
      // Ghost is pinned to the blue indicator (not the cursor) — so the
      // cursor leaving the window can't drag the ghost off-screen with it.
      // When auto-scroll is pulling the page DOWN (cursor near the bottom
      // of the viewport), flip the ghost above the indicator so it stays
      // visible. Otherwise sit below, the default.
      const x = indicatorPos.left + GHOST_INDICATOR_OFFSET_X;
      let y: number;
      if (this._autoScrollSpeed > 0) {
        const ghostHeight = this.ghost.getBoundingClientRect().height;
        y = indicatorPos.top - GHOST_INDICATOR_OFFSET_Y - ghostHeight;
      } else {
        y = indicatorPos.top + GHOST_INDICATOR_OFFSET_Y;
      }
      this.ghost.style.setProperty('--gx', `${x}px`);
      this.ghost.style.setProperty('--gy', `${y}px`);
    }
  }

  private positionIndicator(
    clientY: number,
    insertPos: number,
    valid: boolean
  ): { left: number; top: number } | null {
    if (insertPos === -1) {
      this.indicator.style.display = 'none';
      return null;
    }
    const editorRect = this.view.dom.getBoundingClientRect();
    let indicatorY = clientY;
    const block = topLevelBlockAt(this.view, Math.max(0, insertPos - 1));
    if (block) {
      const blockDom = this.view.nodeDOM(block.pos) as HTMLElement | null;
      if (blockDom) {
        const rect = blockDom.getBoundingClientRect();
        indicatorY = insertPos <= block.pos + 1 ? rect.top : rect.bottom;
      }
    }
    indicatorY = Math.max(this.getViewportClampTop(), indicatorY);
    const left = editorRect.left;
    this.indicator.style.left = `${left}px`;
    this.indicator.style.width = `${editorRect.width}px`;
    this.indicator.style.top = `${indicatorY}px`;
    this.indicator.style.display = 'block';
    this.indicator.classList.toggle('drag-block-indicator--invalid', !valid);
    return { left, top: indicatorY };
  }

  private maybeAutoScroll(clientY: number): void {
    const vh = window.innerHeight;
    const distTop = clientY;
    const distBottom = vh - clientY;
    let speed = 0;
    if (distTop < AUTO_SCROLL_THRESHOLD) {
      speed = -Math.round(AUTO_SCROLL_MAX_SPEED * (1 - distTop / AUTO_SCROLL_THRESHOLD));
    } else if (distBottom < AUTO_SCROLL_THRESHOLD) {
      speed = Math.round(AUTO_SCROLL_MAX_SPEED * (1 - distBottom / AUTO_SCROLL_THRESHOLD));
    }
    this._autoScrollSpeed = speed;
    if (speed !== 0 && this.scrollRafId === null) {
      const scroll = () => {
        if (this._autoScrollSpeed === 0) {
          this.scrollRafId = null;
          return;
        }
        window.scrollBy(0, this._autoScrollSpeed);
        // Cursor's clientY hasn't moved but the doc has — recompute against
        // the newly-visible content so the indicator and dropInsertPos
        // track what the user sees under the cursor.
        this.refreshDropTarget();
        this.scrollRafId = requestAnimationFrame(scroll);
      };
      this.scrollRafId = requestAnimationFrame(scroll);
    } else if (speed === 0) {
      this.stopAutoScroll();
    }
  }

  private stopAutoScroll(): void {
    if (this.scrollRafId !== null) {
      cancelAnimationFrame(this.scrollRafId);
      this.scrollRafId = null;
    }
    this._autoScrollSpeed = 0;
  }

  /**
   * Apply the ProseMirror reorder transaction, then animate the floating ghost
   * into the landed block's position and clean up.
   */
  private finishDrag(): void {
    this.stopAutoScroll();
    this.indicator.style.display = 'none';
    this.indicator.classList.remove('drag-block-indicator--invalid');
    this.handle.classList.remove('drag-block-handle--active');

    const { state } = this.view;
    const draggedNode = state.doc.resolve(this.draggedPos).nodeAfter;
    let landedAtPos: number | null = null;
    if (draggedNode && this.dropInsertPos !== -1 && this.dropValid) {
      const draggedSize = draggedNode.nodeSize;
      if (
        this.dropInsertPos !== this.draggedPos &&
        this.dropInsertPos !== this.draggedPos + draggedSize
      ) {
        const tr = state.tr;
        const content = state.doc.slice(this.draggedPos, this.draggedPos + draggedSize);
        tr.insert(this.dropInsertPos, content.content);
        const mappedDragPos = tr.mapping.map(this.draggedPos);
        tr.delete(mappedDragPos, mappedDragPos + draggedSize);
        // Final resting position of the dropped block, after the delete maps it.
        landedAtPos =
          this.dropInsertPos > this.draggedPos
            ? this.dropInsertPos - draggedSize
            : this.dropInsertPos;
        this.view.dispatch(tr);
      }
    }

    // After dispatch, the dragged block's DOM at `restingPos` is the freshly
    // mounted version (or the unchanged original if the drop was a no-op).
    const restingPos = landedAtPos !== null ? landedAtPos : this.draggedPos;
    const restingDom = this.view.nodeDOM(restingPos) as HTMLElement | null;
    const ghost = this.ghost;
    this.ghost = null;

    const finalize = (): void => {
      if (ghost && ghost.parentNode) ghost.remove();
      if (restingDom) restingDom.classList.remove('drag-block-dragging');
      this.endDrag();
      if (landedAtPos !== null) this.flashDropConfirmation(landedAtPos);
    };

    if (ghost && restingDom) {
      const targetRect = restingDom.getBoundingClientRect();
      ghost.classList.add('is-dropping');
      ghost.style.setProperty('--gx', `${targetRect.left}px`);
      ghost.style.setProperty('--gy', `${targetRect.top}px`);
      let done = false;
      const onEnd = (): void => {
        if (done) return;
        done = true;
        ghost.removeEventListener('transitionend', onEnd);
        finalize();
      };
      ghost.addEventListener('transitionend', onEnd);
      // Fallback for reduced-motion or when transitions are otherwise skipped.
      setTimeout(onEnd, GHOST_DROP_DURATION_MS + 80);
    } else {
      finalize();
    }
  }

  private cancelDrag(): void {
    this.stopAutoScroll();
    this.indicator.style.display = 'none';
    this.indicator.classList.remove('drag-block-indicator--invalid');
    this.handle.classList.remove('drag-block-handle--active');
    if (this.ghost && this.ghost.parentNode) this.ghost.remove();
    this.ghost = null;
    const blockDom = this.view.nodeDOM(this.draggedPos) as HTMLElement | null;
    if (blockDom) blockDom.classList.remove('drag-block-dragging');
    this.endDrag();
  }

  /**
   * Briefly outlines the just-dropped block so the user sees where it landed.
   * Pure visual confirmation — uses the .drag-block-just-dropped CSS class,
   * which fades itself out via animation. Skipped if the DOM node can't be
   * resolved (e.g. NodeView not yet mounted).
   */
  private flashDropConfirmation(blockPos: number): void {
    requestAnimationFrame(() => {
      const dom = this.view.nodeDOM(blockPos) as HTMLElement | null;
      if (!dom || typeof dom.classList === 'undefined') return;
      dom.classList.add('drag-block-just-dropped');
      const cleanup = (): void => {
        dom.classList.remove('drag-block-just-dropped');
        dom.removeEventListener('animationend', cleanup);
      };
      dom.addEventListener('animationend', cleanup);
      // Fallback in case animation never fires (reduced-motion users).
      setTimeout(cleanup, 600);
    });
  }

  private endDrag(): void {
    this.isDragging = false;
    if (this._hideTimeoutId !== null) {
      clearTimeout(this._hideTimeoutId);
      this._hideTimeoutId = null;
    }
    this.draggedPos = -1;
    this.dropInsertPos = -1;
    this.dropValid = false;
    this._handleBlock = null;
    this.hoveredBlock = null;
    this.pendingDrag = null;
    document.body.classList.remove('is-dragging-block');
  }

  destroy(): void {
    this.stopAutoScroll();
    if (this._hideTimeoutId !== null) clearTimeout(this._hideTimeoutId);
    this.view.dom.removeEventListener('mousemove', this._onMouseMove);
    this.view.dom.removeEventListener('mouseleave', this._onMouseLeave);
    window.removeEventListener('keydown', this._onKeyDown);
    if (this.ghost && this.ghost.parentNode) this.ghost.remove();
    this.handle.remove();
    this.indicator.remove();
    document.body.classList.remove('is-dragging-block');
  }
}

// ─── Extension ────────────────────────────────────────────────────────────────

export const DraggableBlocks = Extension.create({
  name: 'draggableBlocks',

  addCommands() {
    return {
      moveBlockUp:
        () =>
        ({ state, dispatch }) => {
          const { $from } = state.selection;
          let startNode: ProsemirrorNode | null = null;
          let startPos = -1;
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).isBlock && d === 1) {
              startNode = $from.node(d);
              startPos = $from.before(d);
              break;
            }
          }
          if (!startNode || startPos === -1) return false;

          const $sp = state.doc.resolve(startPos);
          const index = $sp.index();
          if (index === 0) return false;

          const prevNode = $sp.parent.child(index - 1);
          // Treat empty paragraphs (including TipTap's trailing-node placeholder)
          // as non-movable neighbors — otherwise Alt+↑ can drift past the boundary.
          if (!isDraggableBlock(prevNode)) return false;
          const prevPos = startPos - prevNode.nodeSize;

          if (dispatch) {
            const tr = state.tr;
            const fromOffset = state.selection.from - startPos;
            const toOffset = state.selection.to - startPos;
            const content = state.doc.slice(startPos, startPos + startNode.nodeSize);

            tr.delete(startPos, startPos + startNode.nodeSize);
            tr.insert(prevPos, content.content);

            // Use the runtime constructor (TextSelection / NodeSelection) instead
            // of the imported Selection class — `instanceof` against the imported
            // symbol can fail in tests where TipTap loads a separate ProseMirror
            // copy. See vibe-coding-rules/image-and-dom-handling.md.
            const SelectionClass = state.selection.constructor as typeof Selection & {
              create: (doc: ProsemirrorNode, from: number, to: number) => Selection;
            };

            tr.setSelection(
              SelectionClass.create(tr.doc, prevPos + fromOffset, prevPos + toOffset)
            );
            dispatch(tr.scrollIntoView());
          }
          return true;
        },

      moveBlockDown:
        () =>
        ({ state, dispatch }) => {
          const { $from } = state.selection;
          let startNode: ProsemirrorNode | null = null;
          let startPos = -1;
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).isBlock && d === 1) {
              startNode = $from.node(d);
              startPos = $from.before(d);
              break;
            }
          }
          if (!startNode || startPos === -1) return false;

          const $sp = state.doc.resolve(startPos);
          const index = $sp.index();
          if (index === $sp.parent.childCount - 1) return false;

          const nextNode = $sp.parent.child(index + 1);
          // Treat empty paragraphs (including TipTap's trailing-node placeholder)
          // as non-movable neighbors — otherwise Alt+↓ would keep moving past
          // the visible end of the document as new trailing nodes are appended.
          if (!isDraggableBlock(nextNode)) return false;

          if (dispatch) {
            const tr = state.tr;
            const fromOffset = state.selection.from - startPos;
            const toOffset = state.selection.to - startPos;
            const content = state.doc.slice(startPos, startPos + startNode.nodeSize);

            tr.delete(startPos, startPos + startNode.nodeSize);
            const insertPos = startPos + nextNode.nodeSize;
            tr.insert(insertPos, content.content);

            // Use the runtime constructor (TextSelection / NodeSelection) instead
            // of the imported Selection class — `instanceof` against the imported
            // symbol can fail in tests where TipTap loads a separate ProseMirror
            // copy. See vibe-coding-rules/image-and-dom-handling.md.
            const SelectionClass = state.selection.constructor as typeof Selection & {
              create: (doc: ProsemirrorNode, from: number, to: number) => Selection;
            };

            tr.setSelection(
              SelectionClass.create(tr.doc, insertPos + fromOffset, insertPos + toOffset)
            );
            dispatch(tr.scrollIntoView());
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Alt-ArrowUp': () => this.editor.commands.moveBlockUp(),
      'Alt-ArrowDown': () => this.editor.commands.moveBlockDown(),
    };
  },

  addProseMirrorPlugins() {
    const editorRef = this.editor;
    return [
      new Plugin({
        key: draggableBlocksPluginKey,
        view(editorView) {
          const controller = new DragHandleController(editorRef, editorView);
          return {
            destroy() {
              controller.destroy();
            },
          };
        },
      }),
    ];
  },
});
