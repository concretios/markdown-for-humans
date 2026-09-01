/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Session-scoped whole-block Feedback targeting and gutter action.
 */

import type { Editor } from '@tiptap/core';
import { feedbackFocusForMappedBlock } from './feedbackRenderedRange';
import type { FeedbackTargetPresentationReason } from './feedbackTargetPresentation';

export interface FeedbackBlockActionAnchor {
  ordinal: number;
  startLine: number;
  endLine: number;
}

export interface FeedbackBlockActionTarget {
  startOrdinal: number;
  endOrdinal: number;
  focus: string;
  startLine: number;
  endLine: number;
  presentationReason?: FeedbackTargetPresentationReason;
}

export interface FeedbackBlockElementTarget {
  ordinal: number;
  element: HTMLElement;
}

export interface FeedbackBlockElementIndex {
  resolve(node: Node | null): FeedbackBlockElementTarget | null;
  elementForOrdinal(ordinal: number): HTMLElement | null;
}

/**
 * Index every frozen top-level document node once. ProseMirror widgets such as
 * GapCursor can be direct DOM children, so document offsets and `nodeDOM`
 * remain authoritative instead of raw child indexes. Anchor availability is
 * enforced separately by the target resolver, while annotation geometry can
 * still resolve legacy sessions with sparse or absent anchors.
 */
export function createFeedbackBlockElementIndex(
  editor: Editor,
  anchors: readonly FeedbackBlockActionAnchor[]
): FeedbackBlockElementIndex {
  const root = editor.view.dom as HTMLElement;
  const ordinalsByElement = new WeakMap<HTMLElement, number>();
  const elementsByOrdinal = new Map<number, HTMLElement>();
  const offsetsByOrdinal = new Map<number, number>();

  editor.state.doc.forEach((_node, offset, ordinal) => {
    offsetsByOrdinal.set(ordinal, offset);
  });

  const remember = (ordinal: number, nodeDom: Node | null): HTMLElement | null => {
    const element = nodeDom instanceof HTMLElement ? nodeDom : null;
    if (!element || element.parentElement !== root) return null;
    ordinalsByElement.set(element, ordinal);
    elementsByOrdinal.set(ordinal, element);
    return element;
  };

  // ProseMirror marks non-raw WidgetViewDesc DOM nodes, including GapCursor,
  // with this class. Removing those direct children from one snapshot gives a
  // linear document-order map without nodeDOM's repeated child scans.
  const directBlocks = Array.from(root.children).filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && !element.classList.contains('ProseMirror-widget')
  );
  const hasDenseCanonicalMap = directBlocks.length === offsetsByOrdinal.size;
  if (hasDenseCanonicalMap) {
    directBlocks.forEach((element, ordinal) => remember(ordinal, element));
  }

  const elementForOrdinal = (ordinal: number): HTMLElement | null => {
    const cached = elementsByOrdinal.get(ordinal);
    if (cached) return cached;
    const offset = offsetsByOrdinal.get(ordinal);
    if (offset === undefined || hasDenseCanonicalMap || typeof editor.view.nodeDOM !== 'function') {
      return null;
    }
    return remember(ordinal, editor.view.nodeDOM(offset));
  };

  // Ambiguous custom DOM falls back only for actionable anchors and resolves
  // other annotation ordinals lazily. The normal dense path performs no
  // position lookup, including when all document blocks are actionable.
  if (!hasDenseCanonicalMap) {
    anchors.forEach(anchor => elementForOrdinal(anchor.ordinal));
  }

  return {
    resolve(node) {
      let element = node instanceof Element ? node : (node?.parentElement ?? null);
      while (element && element.parentElement !== root) {
        if (element === root) return null;
        element = element.parentElement;
      }
      if (!(element instanceof HTMLElement) || element.parentElement !== root) return null;
      const ordinal = ordinalsByElement.get(element);
      return ordinal === undefined ? null : { ordinal, element };
    },
    elementForOrdinal,
  };
}

export interface FeedbackBlockActionTargetResolver {
  resolve(ordinal: number): FeedbackBlockActionTarget | null;
}

/** Index anchors once and build honest block-only targets on demand. */
export function createFeedbackBlockActionTargetResolver(
  editor: Editor,
  anchors: readonly FeedbackBlockActionAnchor[],
  elementIndex: FeedbackBlockElementIndex = createFeedbackBlockElementIndex(editor, anchors)
): FeedbackBlockActionTargetResolver {
  const anchorsByOrdinal = new Map(anchors.map(anchor => [anchor.ordinal, anchor]));
  const cachedTargets = new Map<
    number,
    { document: object; target: FeedbackBlockActionTarget | null }
  >();
  return {
    resolve(ordinal) {
      const anchor = anchorsByOrdinal.get(ordinal);
      const document = editor.state.doc;
      if (!anchor || !document.maybeChild(ordinal)) return null;
      const cached = cachedTargets.get(ordinal);
      if (cached?.document === document) return cached.target;
      const focus = feedbackFocusForMappedBlock(
        editor,
        ordinal,
        elementIndex.elementForOrdinal(ordinal)
      );
      const target =
        focus.trim().length === 0
          ? null
          : {
              startOrdinal: ordinal,
              endOrdinal: ordinal,
              focus,
              startLine: anchor.startLine,
              endLine: anchor.endLine,
              presentationReason: 'whole-block-action' as const,
            };
      cachedTargets.set(ordinal, { document, target });
      return target;
    },
  };
}

/** Build one block-only target without retaining a resolver. */
export function resolveFeedbackBlockActionTarget(
  editor: Editor,
  anchors: readonly FeedbackBlockActionAnchor[],
  ordinal: number
): FeedbackBlockActionTarget | null {
  const elementIndex = createFeedbackBlockElementIndex(editor, anchors);
  return createFeedbackBlockActionTargetResolver(editor, anchors, elementIndex).resolve(ordinal);
}

interface VisibleFeedbackBlockAction {
  target: FeedbackBlockActionTarget;
  element: HTMLElement;
  isTable: boolean;
}

export interface FeedbackBlockActionView {
  readonly element: HTMLButtonElement;
  show(input: VisibleFeedbackBlockAction): void;
  hide(): void;
  reposition(): void;
  contains(node: Node | null): boolean;
  destroy(): void;
}

/** Create one reusable, document-positioned block action for a Feedback session. */
export function createFeedbackBlockActionView(options: {
  container: HTMLElement;
  before?: Element | null;
  onActivate: (target: FeedbackBlockActionTarget) => void;
}): FeedbackBlockActionView {
  const { container, before, onActivate } = options;
  const button = container.ownerDocument.createElement('button');
  button.className = 'feedback-block-action';
  button.type = 'button';
  button.title = 'Add feedback';
  button.hidden = true;
  button.setAttribute('data-feedback-block-action', '');
  const icon = container.ownerDocument.createElement('span');
  icon.className = 'codicon codicon-comment-discussion-sparkle';
  icon.setAttribute('aria-hidden', 'true');
  button.append(icon);
  const preview = container.ownerDocument.createElement('div');
  preview.className = 'feedback-block-target-preview';
  preview.hidden = true;
  preview.setAttribute('aria-hidden', 'true');
  preview.setAttribute('data-feedback-block-target-preview', '');
  if (before?.parentElement === container) {
    container.insertBefore(preview, before);
    container.insertBefore(button, before);
  } else {
    container.append(preview, button);
  }

  let visible: VisibleFeedbackBlockAction | null = null;
  let previewTarget: HTMLElement | null = null;
  let alternatePreviewAnimation = false;

  const hidePreview = (): void => {
    preview.hidden = true;
    previewTarget = null;
  };
  const positionPreview = (
    element: HTMLElement,
    blockRect: DOMRect,
    containerRect: DOMRect
  ): void => {
    if (previewTarget !== element) {
      alternatePreviewAnimation = !alternatePreviewAnimation;
      preview.classList.toggle('alternate', alternatePreviewAnimation);
    }
    previewTarget = element;
    preview.style.left = `${blockRect.left - containerRect.left}px`;
    preview.style.top = `${blockRect.top - containerRect.top}px`;
    preview.style.width = `${blockRect.width}px`;
    preview.style.height = `${blockRect.height}px`;
    preview.hidden = false;
  };

  const position = (): void => {
    if (!visible || !visible.element.isConnected) {
      button.hidden = true;
      hidePreview();
      return;
    }
    const blockRect = visible.element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const actionWidth = button.offsetWidth || 36;
    const actionHeight = button.offsetHeight || 36;
    const viewport = container.ownerDocument.defaultView;
    const viewportWidth =
      viewport?.innerWidth || container.ownerDocument.documentElement.clientWidth;
    const viewportHeight =
      viewport?.innerHeight || container.ownerDocument.documentElement.clientHeight;
    const toolbarBottom =
      container.ownerDocument
        .querySelector<HTMLElement>('.formatting-toolbar')
        ?.getBoundingClientRect().bottom ?? 0;
    if (
      blockRect.bottom <= toolbarBottom ||
      blockRect.top >= viewportHeight ||
      blockRect.right <= 0 ||
      blockRect.left >= viewportWidth
    ) {
      button.hidden = true;
      hidePreview();
      return;
    }
    button.hidden = false;
    positionPreview(visible.element, blockRect, containerRect);
    const unclampedLeft = blockRect.left - containerRect.left - actionWidth - 8;
    const maxLeft = Math.max(0, containerRect.width - actionWidth);
    button.style.left = `${Math.max(0, Math.min(unclampedLeft, maxLeft))}px`;
    const preferredTop = Math.max(blockRect.top + 2, toolbarBottom + 4);
    const viewportTop = Math.min(preferredTop, viewportHeight - actionHeight - 4);
    button.style.top = `${viewportTop - containerRect.top}px`;
  };
  const preserveDocumentSelection = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  button.addEventListener('pointerdown', preserveDocumentSelection);
  button.addEventListener('mousedown', preserveDocumentSelection);
  button.addEventListener('click', () => {
    if (!button.hidden && visible?.element.isConnected && button.isConnected) {
      onActivate(visible.target);
    } else {
      visible = null;
      button.hidden = true;
      hidePreview();
    }
  });

  return {
    element: button,
    show(input) {
      const unchanged =
        visible?.target.startOrdinal === input.target.startOrdinal &&
        visible.element === input.element &&
        visible.isTable === input.isTable;
      const needsPosition = !unchanged || button.hidden;
      visible = input;
      button.setAttribute(
        'aria-label',
        input.isTable ? 'Add feedback to this table' : 'Add feedback to this block'
      );
      if (needsPosition) position();
    },
    hide() {
      visible = null;
      button.hidden = true;
      hidePreview();
    },
    reposition: position,
    contains: node => Boolean(node && button.contains(node)),
    destroy() {
      visible = null;
      hidePreview();
      preview.remove();
      button.remove();
    },
  };
}
