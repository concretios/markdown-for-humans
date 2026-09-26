/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Session-scoped whole-block Feedback targeting and gutter action.
 */

import type { FeedbackStructureScope } from './feedbackStructureIndex';
import type { Editor } from '@tiptap/core';
import { createFeedbackSectionIndex } from './feedbackSectionIndex';
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
  /** Ephemeral UI intent; v2 persists an ordinary complete-block span. */
  sectionLabel?: string;
  structuralScope?: FeedbackStructureScope;
  scopePosition?: number;
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
 * Index frozen top-level document positions while allowing their live DOM to
 * change. ProseMirror may replace a pending target's DOM without changing the
 * document. Recover only through canonical positions and exact `nodeDOM`
 * identity, never by treating widgets as document children. Anchor availability
 * is enforced separately by the target resolver, while annotation geometry can
 * still resolve legacy sessions with sparse or absent anchors.
 */
export function createFeedbackBlockElementIndex(
  editor: Editor,
  anchors: readonly FeedbackBlockActionAnchor[]
): FeedbackBlockElementIndex {
  const root = editor.view.dom as HTMLElement;
  const frozenDocument = editor.state.doc;
  const ordinalsByElement = new WeakMap<HTMLElement, number>();
  const elementsByOrdinal = new Map<number, HTMLElement>();
  const offsetsByOrdinal = new Map<number, number>();

  frozenDocument.forEach((_node, offset, ordinal) => {
    offsetsByOrdinal.set(ordinal, offset);
  });

  const matchesFrozenDocument = (): boolean =>
    editor.state.doc === frozenDocument && editor.view.dom === root && root.isConnected;

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
    if (!matchesFrozenDocument()) return null;
    const cached = elementsByOrdinal.get(ordinal);
    if (cached?.isConnected && cached.parentElement === root) return cached;
    if (cached) {
      ordinalsByElement.delete(cached);
      elementsByOrdinal.delete(ordinal);
    }
    const offset = offsetsByOrdinal.get(ordinal);
    if (offset === undefined || typeof editor.view.nodeDOM !== 'function') {
      return null;
    }
    try {
      return remember(ordinal, editor.view.nodeDOM(offset));
    } catch {
      // A NodeView can be temporarily unavailable during reconciliation.
      return null;
    }
  };

  // Ambiguous custom DOM falls back only for actionable anchors and resolves
  // other annotation ordinals lazily. The normal dense path performs no
  // position lookup, including when all document blocks are actionable.
  if (!hasDenseCanonicalMap) {
    anchors.forEach(anchor => elementForOrdinal(anchor.ordinal));
  }

  return {
    resolve(node) {
      if (!matchesFrozenDocument()) return null;
      let element = node instanceof Element ? node : (node?.parentElement ?? null);
      while (element && element.parentElement !== root) {
        if (element === root) return null;
        element = element.parentElement;
      }
      if (!(element instanceof HTMLElement) || element.parentElement !== root) return null;
      const ordinal = ordinalsByElement.get(element);
      if (ordinal !== undefined) return { ordinal, element };
      if (
        typeof editor.view.posAtDOM !== 'function' ||
        typeof frozenDocument.resolve !== 'function'
      ) {
        return null;
      }
      try {
        const position = editor.view.posAtDOM(element, 0);
        if (!Number.isSafeInteger(position)) return null;
        const recoveredOrdinal = frozenDocument.resolve(position).index(0);
        // A foreign widget may map to a nearby position. Only the canonical
        // element itself may acquire that position's Feedback target.
        return elementForOrdinal(recoveredOrdinal) === element
          ? { ordinal: recoveredOrdinal, element }
          : null;
      } catch {
        return null;
      }
    },
    elementForOrdinal,
  };
}

export interface FeedbackBlockActionTargetResolver {
  resolve(ordinal: number): FeedbackBlockActionTarget | null;
  section(ordinal: number): FeedbackBlockActionTarget | null;
  sectionsContaining(ordinal: number): readonly FeedbackBlockActionTarget[];
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
  const sectionIndex = createFeedbackSectionIndex(editor.state.doc, anchors);
  const sectionTarget = (ordinal: number): FeedbackBlockActionTarget | null => {
    const section = sectionIndex.section(ordinal);
    if (!section) return null;
    const first = anchorsByOrdinal.get(section.startOrdinal);
    const last = anchorsByOrdinal.get(section.endOrdinal);
    if (!first || !last) return null;
    return {
      startOrdinal: section.startOrdinal,
      endOrdinal: section.endOrdinal,
      startLine: first.startLine,
      endLine: last.endLine,
      focus: section.label,
      sectionLabel: section.label,
      presentationReason: 'whole-block-action',
    };
  };
  return {
    section: sectionTarget,
    sectionsContaining: ordinal =>
      sectionIndex.ancestors(ordinal).flatMap(section => {
        const target = sectionTarget(section.startOrdinal);
        return target ? [target] : [];
      }),
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
  endElement?: HTMLElement;
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
  let previewEngaged = false;

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
    if (previewEngaged) {
      const endRect = visible.endElement?.getBoundingClientRect() ?? blockRect;
      positionPreview(
        visible.element,
        {
          ...blockRect,
          left: blockRect.left,
          top: blockRect.top,
          width: blockRect.width,
          height: Math.max(blockRect.height, endRect.bottom - blockRect.top),
        } as DOMRect,
        containerRect
      );
    } else hidePreview();
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
  button.addEventListener('pointerenter', () => {
    previewEngaged = true;
    position();
  });
  button.addEventListener('pointerleave', () => {
    previewEngaged = document.activeElement === button;
    if (!previewEngaged) hidePreview();
  });
  button.addEventListener('focus', () => {
    previewEngaged = true;
    position();
  });
  button.addEventListener('blur', () => {
    previewEngaged = false;
    hidePreview();
  });
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
        visible?.target.endOrdinal === input.target.endOrdinal &&
        visible?.target.structuralScope?.from === input.target.structuralScope?.from &&
        visible?.target.structuralScope?.to === input.target.structuralScope?.to &&
        visible.element === input.element &&
        visible.isTable === input.isTable;
      const needsPosition = !unchanged || button.hidden;
      visible = input;
      button.setAttribute(
        'aria-label',
        input.target.structuralScope
          ? `Add feedback to ${input.target.structuralScope.label}`
          : input.target.sectionLabel
            ? `Add feedback to section ${input.target.sectionLabel}, including subsections`
            : input.isTable
              ? 'Add feedback to this table'
              : 'Add feedback to this block'
      );
      if (needsPosition) position();
    },
    hide() {
      previewEngaged = false;
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
