/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Frozen rich-view Feedback session UI and selection mapping.
 * This module owns only webview state. Snapshot validation, raw line anchoring,
 * and persistence remain authoritative in the extension host.
 */

import type { Editor, JSONContent } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type {
  CanonicalFeedbackBlock,
  FeedbackDraftSummary,
  FeedbackErrorCode,
  FeedbackHostMessage,
  FeedbackItemSummary,
  FeedbackRenderedRangeInputV1,
  FeedbackWebviewMessage,
} from '../../shared/feedbackProtocol';
import { FEEDBACK_ERROR_CODES } from '../../shared/feedbackProtocol';
import {
  reorderMarksForSerialization,
  serializeBlockMarkdown,
} from '../utils/markdownSerialization';
import {
  FEEDBACK_COMMENTS_PANEL_ID,
  FEEDBACK_COMMENTS_RAIL_ID,
  setFeedbackToolbarState,
  type FeedbackCaptureUiState,
  type FeedbackCommentsState,
} from '../BubbleMenuView';
import {
  layoutFeedbackAnnotations,
  type FeedbackAnnotationLayoutResult,
} from './feedbackAnnotationLayout';
import {
  createFeedbackAnnotationController,
  PENDING_FEEDBACK_ANNOTATION_ID,
  type FeedbackAnnotationController,
  type FeedbackAnnotationTarget,
} from './feedbackAnnotations';
import { FEEDBACK_SESSION_ENDED_EVENT } from './feedbackCapture';
import {
  feedbackFocusForBlockRange,
  getFeedbackTargetFromDomRange,
  getFeedbackTargetFromProseMirrorSelection,
  resolveFeedbackRenderedRange,
} from './feedbackRenderedRange';

type FeedbackMarkdownSerializer = {
  serialize?: (json: JSONContent) => string;
};

type ReviewEditor = Editor & {
  markdown?: FeedbackMarkdownSerializer;
  storage: Editor['storage'] & {
    markdown?: FeedbackMarkdownSerializer & {
      manager?: FeedbackMarkdownSerializer;
      serializer?: FeedbackMarkdownSerializer;
    };
  };
};

export interface FeedbackReviewHost {
  postMessage(message: FeedbackWebviewMessage): void;
}

export interface FeedbackNodeViewInteractionGuards {
  setActive(active: boolean): void;
  dispose(): void;
  isActive(): boolean;
}

export interface FeedbackAnchorView {
  ordinal: number;
  startLine: number;
  endLine: number;
}

export interface FeedbackSessionView {
  sessionId: string;
  source: string;
  sourceSha256: string;
  round: string;
  feedbackFile?: string;
  anchors?: FeedbackAnchorView[];
  items: FeedbackItemSummary[];
}

export interface FeedbackTextTarget {
  startOrdinal: number;
  endOrdinal: number;
  focus: string;
  startLine: number;
  endLine: number;
  renderedRange?: FeedbackRenderedRangeInputV1;
}

export type FeedbackDraftSurfaceKind =
  | 'text-composer'
  | 'text-block-selector'
  | 'finish-checkpoint'
  | 'area-capture'
  | 'capture-block-selector'
  | 'capture-rasterizing'
  | 'capture-annotation';

export interface FeedbackDraftSurface {
  readonly kind: FeedbackDraftSurfaceKind;
  readonly element?: HTMLElement;
  readonly focus: () => void;
}

export interface FeedbackDraftSurfaceLease {
  update(surface: FeedbackDraftSurface): void;
  release(): void;
}

export interface FeedbackDraftSurfaceGate {
  claim(surface: FeedbackDraftSurface): FeedbackDraftSurfaceLease | null;
  focusActive(): boolean;
  hasActive(): boolean;
  activeKind(): FeedbackDraftSurfaceKind | null;
  clear(): void;
}

/**
 * Creates one session-scoped owner for all incomplete Feedback surfaces. A
 * blocked action focuses the current owner instead of replacing its draft.
 */
export function createFeedbackDraftSurfaceGate(): FeedbackDraftSurfaceGate {
  let active: { token: symbol; surface: FeedbackDraftSurface } | null = null;

  const current = (): typeof active => {
    if (active?.surface.element && !active.surface.element.isConnected) active = null;
    return active;
  };
  const focusActive = (): boolean => {
    const owner = current();
    if (!owner) return false;
    owner.surface.focus();
    return true;
  };

  return {
    claim(surface) {
      if (focusActive()) return null;
      const token = Symbol(surface.kind);
      active = { token, surface };
      let released = false;
      return {
        update(nextSurface) {
          if (!released && active?.token === token) active = { token, surface: nextSurface };
        },
        release() {
          if (released) return;
          released = true;
          if (active?.token === token) active = null;
        },
      };
    },
    focusActive,
    hasActive: () => current() !== null,
    activeKind: () => current()?.surface.kind ?? null,
    clear: () => {
      active = null;
    },
  };
}

export interface FeedbackReviewController {
  readonly draftSurfaceGate: FeedbackDraftSurfaceGate;
  start(): void;
  activate(session: FeedbackSessionView): void;
  deactivate(): void;
  invalidate(code: FeedbackErrorCode): void;
  updateItems(items: FeedbackItemSummary[]): void;
  openTextComposer(target: FeedbackTextTarget): void;
  commentOnSelection(): boolean;
  toggleComments(force?: boolean): void;
  navigateFeedback(direction: 'next' | 'previous'): void;
  finish(): void;
  reveal(): void;
  discard(): void;
  copyDiagnostics(): void;
  reportCaptureError(code: FeedbackErrorCode): void;
  /** Reflect the local crop lifecycle in the Feedback toolbar and live region. */
  setCaptureState(state: FeedbackCaptureUiState): void;
  setAnnotationsSuspended(suspended: boolean): void;
  addScreenshotFeedback(input: {
    startOrdinal: number;
    endOrdinal: number;
    imageDataUrl: string;
    feedback: string;
    replaceId?: string;
  }): Promise<void>;
  /** Apply the correlated authoritative source while all DOM guards remain active. */
  applyCloseSync(
    message: Extract<FeedbackHostMessage, { type: 'feedback.close.sync' }>,
    applyContent: (content: string) => boolean
  ): boolean;
  /** Apply a failed Start/Resume recovery while its pre-session lock remains active. */
  applyTransitionSync(
    message: Extract<FeedbackHostMessage, { type: 'feedback.transition.sync' }>,
    applyContent: (content: string) => boolean
  ): boolean;
  /** Release the owner only after the host broadcasts its correlated peer unlock. */
  completeClose(lockId: string): boolean;
  /** Release a failed transition only after its correlated host unlock. */
  completeTransition(lockId: string): boolean;
  handleHostMessage(message: FeedbackHostMessage): void;
  /** True whenever local Feedback lifecycle guards have frozen editor mutations. */
  isEditingLocked(): boolean;
  isWritable(): boolean;
  isInvalidated(): boolean;
  getSession(): FeedbackSessionView | null;
}

type PendingFeedbackMutation =
  | {
      kind: 'screenshot';
      resolve: () => void;
      reject: (error: Error) => void;
    }
  | {
      kind: 'text-add';
      form: HTMLElement;
      field: HTMLTextAreaElement;
      submit: HTMLButtonElement;
      settle: () => void;
    }
  | {
      kind: 'delete';
      item: FeedbackItemSummary;
      button: HTMLButtonElement;
    }
  | {
      kind: 'restore';
      id: string;
      button: HTMLButtonElement;
    };

interface FeedbackCompletionSummary {
  feedbackFile: string;
  itemCount: number;
  prompt: string;
  promptCopied: boolean;
}

/** The Feedback-only document lock is absent from ordinary editor state. */
export const feedbackReadOnlyPluginKey = new PluginKey('md4hFeedbackReadOnly');

/** Create one session-scoped transaction filter that preserves selection changes. */
export function createFeedbackReadOnlyPlugin(): Plugin {
  return new Plugin({
    key: feedbackReadOnlyPluginKey,
    filterTransaction: transaction => !transaction.docChanged,
  });
}

const FEEDBACK_NODE_VIEW_CONTROL_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  '.drag-block-handle',
  '.column-resize-handle',
  '.image-menu-button',
].join(',');

const FEEDBACK_INTERACTIVE_NODE_SELECTOR = [
  FEEDBACK_NODE_VIEW_CONTROL_SELECTOR,
  '.image-wrapper',
  '.mermaid-wrapper',
  '.md4h-inline-math',
  '.md4h-math-block',
].join(',');

const FEEDBACK_NODE_VIEW_EVENTS = [
  'pointerdown',
  'click',
  'dblclick',
  'change',
  'dragstart',
] as const;

/**
 * Creates capture guards for mutable NodeView controls. The returned owner
 * installs no DOM listeners until Feedback starts and removes all five when it
 * ends, keeping ordinary rich-view interaction free of Feedback overhead.
 */
export function createFeedbackNodeViewInteractionGuards(
  editorDom: HTMLElement
): FeedbackNodeViewInteractionGuards {
  let active = false;
  const guard = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    const selector =
      event.type === 'pointerdown'
        ? FEEDBACK_NODE_VIEW_CONTROL_SELECTOR
        : FEEDBACK_INTERACTIVE_NODE_SELECTOR;
    if (event.type !== 'dragstart' && event.type !== 'change' && !target?.closest(selector)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const setActive = (nextActive: boolean): void => {
    if (active === nextActive) return;
    active = nextActive;
    for (const eventName of FEEDBACK_NODE_VIEW_EVENTS) {
      if (nextActive) editorDom.addEventListener(eventName, guard, true);
      else editorDom.removeEventListener(eventName, guard, true);
    }
  };

  return {
    setActive,
    dispose: () => setActive(false),
    isActive: () => active,
  };
}

function normalizeFeedbackBlockKind(kind: string): string {
  switch (kind) {
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return 'list';
    case 'codeBlock':
    case 'mermaid':
      return 'code';
    case 'mathBlock':
      return 'paragraph';
    case 'blockquote':
    case 'githubAlert':
      return 'blockquote';
    case 'table':
      return 'table';
    case 'image':
      return 'image';
    default:
      return kind.toLowerCase();
  }
}

/** Enumerate canonical top-level blocks exactly once when a session starts. */
export function enumerateCanonicalFeedbackBlocks(editor: Editor): CanonicalFeedbackBlock[] {
  const reviewEditor = editor as ReviewEditor;
  const markdownStorage = reviewEditor.storage?.markdown;
  // TipTap v3 exposes MarkdownManager on `editor.markdown` and mirrors it at
  // `storage.markdown.manager`. Keep the legacy storage shapes for older test
  // fixtures and extension versions, but always bind to the object that owns
  // `serialize` because MarkdownManager reads private instance state.
  const markdownManager = reviewEditor.markdown ?? markdownStorage?.manager;
  const serializerOwner =
    markdownManager ??
    (typeof markdownStorage?.serialize === 'function'
      ? markdownStorage
      : markdownStorage?.serializer);
  const rawSerialize = serializerOwner?.serialize;
  if (typeof rawSerialize !== 'function') {
    throw new Error('Markdown serializer is unavailable');
  }

  const serialize = (json: JSONContent): string =>
    rawSerialize.call(serializerOwner, reorderMarksForSerialization(json));
  const blocks: CanonicalFeedbackBlock[] = [];
  const doc = editor.state.doc;

  for (let ordinal = 0; ordinal < doc.childCount; ordinal += 1) {
    const node = doc.child(ordinal) as unknown as {
      type: { name: string };
      content?: { size: number };
      nodeSize?: number;
      toJSON?: () => JSONContent;
    };
    const json = node.toJSON ? node.toJSON() : ({ type: node.type.name } as JSONContent);
    const markdown = serializeBlockMarkdown(json, serialize);
    if (markdown === '') {
      continue;
    }
    blocks.push({
      ordinal,
      kind: normalizeFeedbackBlockKind(node.type.name),
      markdown,
      contentSize:
        typeof node.content?.size === 'number'
          ? node.content.size
          : Math.max(0, (node.nodeSize ?? 2) - 2),
    });
  }

  return blocks;
}

let requestSequence = 0;

function nextRequestId(): string {
  requestSequence += 1;
  return `feedback-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function compareFeedbackIds(left: string, right: string): number {
  return Number(left.slice(1)) - Number(right.slice(1));
}

function canonicalClusterKey(ids: readonly string[]): string {
  return [...ids].sort(compareFeedbackIds).join(',');
}

function topLevelOrdinalForNode(root: HTMLElement, node: Node | null): number | null {
  let element =
    node instanceof HTMLElement
      ? node
      : node?.parentElement instanceof HTMLElement
        ? node.parentElement
        : null;
  while (element && element.parentElement !== root) {
    element = element.parentElement;
  }
  if (!element || element.parentElement !== root) return null;
  return Array.prototype.indexOf.call(root.children, element) as number;
}

export function getFeedbackSelectionTarget(
  editor: Editor,
  anchors: FeedbackAnchorView[]
): FeedbackTextTarget | null {
  const { from, to, empty } = editor.state.selection;
  const editorDom = editor.view.dom as HTMLElement;
  let startOrdinal = -1;
  let endOrdinal = -1;
  const mappedOrdinals = new Set(anchors.map(anchor => anchor.ordinal));
  const nativeSelection = window.getSelection();
  const nativeSelectionInside = Boolean(
    nativeSelection?.anchorNode &&
    nativeSelection.focusNode &&
    editorDom.contains(nativeSelection.anchorNode) &&
    editorDom.contains(nativeSelection.focusNode)
  );
  const nativeFocus = nativeSelectionInside ? (nativeSelection?.toString() ?? '') : '';
  const hasNativeSelection =
    nativeSelectionInside && nativeSelection?.isCollapsed !== true && nativeFocus.trim().length > 0;
  let renderedRange: FeedbackRenderedRangeInputV1 | undefined;
  let renderedFocus: string | undefined;

  if (hasNativeSelection && nativeSelection) {
    if (nativeSelection.rangeCount > 0 && typeof nativeSelection.getRangeAt === 'function') {
      try {
        const renderedTarget = getFeedbackTargetFromDomRange(editor, nativeSelection.getRangeAt(0));
        if (renderedTarget?.kind === 'inline') {
          renderedRange = renderedTarget.range;
          renderedFocus = renderedTarget.focus;
          if (
            mappedOrdinals.has(renderedTarget.range.startOrdinal) &&
            mappedOrdinals.has(renderedTarget.range.endOrdinal)
          ) {
            startOrdinal = renderedTarget.range.startOrdinal;
            endOrdinal = renderedTarget.range.endOrdinal;
          }
        } else if (
          renderedTarget?.kind === 'block' &&
          mappedOrdinals.has(renderedTarget.startOrdinal) &&
          mappedOrdinals.has(renderedTarget.endOrdinal)
        ) {
          renderedFocus = renderedTarget.focus;
          startOrdinal = renderedTarget.startOrdinal;
          endOrdinal = renderedTarget.endOrdinal;
        }
      } catch {
        // Legacy NodeViews and lightweight fixtures can expose a native
        // Selection without a mappable DOM Range. The containing block remains
        // the honest fallback and is still host-validated.
      }
    }
    if (startOrdinal < 0) {
      const anchorOrdinal = topLevelOrdinalForNode(editorDom, nativeSelection.anchorNode);
      const focusOrdinal = topLevelOrdinalForNode(editorDom, nativeSelection.focusNode);
      if (
        anchorOrdinal !== null &&
        focusOrdinal !== null &&
        mappedOrdinals.has(anchorOrdinal) &&
        mappedOrdinals.has(focusOrdinal)
      ) {
        startOrdinal = Math.min(anchorOrdinal, focusOrdinal);
        endOrdinal = Math.max(anchorOrdinal, focusOrdinal);
      }
    }
  } else if (nativeSelectionInside) {
    // A click inside the frozen document can leave ProseMirror's last range in
    // state. Do not turn that stale range, or a native caret, into feedback.
    return null;
  } else if (!empty && to > from) {
    try {
      const renderedTarget = getFeedbackTargetFromProseMirrorSelection(editor);
      if (renderedTarget?.kind === 'inline') {
        renderedRange = renderedTarget.range;
        renderedFocus = renderedTarget.focus;
      }
    } catch {
      // Fall through to the existing containing-block mapping when a custom
      // NodeView cannot expose exact rendered positions.
    }
    editor.state.doc.forEach((node, offset, ordinal) => {
      const blockEnd = offset + node.nodeSize;
      if (mappedOrdinals.has(ordinal) && blockEnd > from && offset < to) {
        if (startOrdinal < 0) startOrdinal = ordinal;
        endOrdinal = ordinal;
      }
    });
  }
  if (startOrdinal < 0 || endOrdinal < startOrdinal) return null;

  let focus = renderedFocus ?? (hasNativeSelection ? nativeFocus : '');
  if (focus.trim().length === 0 && !empty && to > from) {
    focus = editor.state.doc.textBetween(from, to, '\n');
  }
  if (focus.trim().length === 0) {
    focus = feedbackFocusForBlockRange(editor, startOrdinal, endOrdinal);
  }
  if (focus.trim().length === 0) return null;

  const startAnchor = anchors.find(anchor => anchor.ordinal === startOrdinal);
  const endAnchor = anchors.find(anchor => anchor.ordinal === endOrdinal);
  return {
    startOrdinal,
    endOrdinal,
    focus,
    startLine: startAnchor?.startLine ?? 0,
    endLine: endAnchor?.endLine ?? 0,
    ...(renderedRange ? { renderedRange } : {}),
  };
}

/** Create one document-scoped review controller. */
export function createFeedbackReviewController(options: {
  editor: Editor;
  host: FeedbackReviewHost;
  onReadOnlyChange?: (active: boolean) => void;
}): FeedbackReviewController {
  const { editor, host, onReadOnlyChange } = options;
  const editorDom = editor.view.dom as HTMLElement;
  const editorContainer = editorDom.closest<HTMLElement>('#editor') ?? editorDom.parentElement;
  const draftSurfaceGate = createFeedbackDraftSurfaceGate();
  let session: FeedbackSessionView | null = null;
  let invalidated = false;
  let commentsState: FeedbackCommentsState = 'collapsed';
  let frameLabel: HTMLElement | null = null;
  let rail: HTMLElement | null = null;
  let markerLayer: HTMLElement | null = null;
  let targetBracketLayer: HTMLElement | null = null;
  let panel: HTMLElement | null = null;
  let connectorLayer: SVGSVGElement | null = null;
  let annotationSpacer: HTMLElement | null = null;
  let liveRegion: HTMLElement | null = null;
  let alertElement: HTMLElement | null = null;
  let syncRetryAlert: HTMLElement | null = null;
  let annotationAnchorAlert: HTMLElement | null = null;
  let annotationAnchorAlertSignature = '';
  let annotationLayoutAlert: HTMLElement | null = null;
  let annotationLayoutAlertSignature = '';
  let draftBanner: HTMLElement | null = null;
  let availableDrafts: FeedbackDraftSummary[] = [];
  let pendingButton: HTMLButtonElement | null = null;
  let pendingButtonTarget: FeedbackTextTarget | null = null;
  let pendingSelectionRange: Range | null = null;
  let composer: HTMLElement | null = null;
  let composerTarget: FeedbackTextTarget | null = null;
  let composerDraftSurface: FeedbackDraftSurfaceLease | null = null;
  let blockSelector: HTMLFormElement | null = null;
  let blockSelectorReturnFocus: HTMLElement | null = null;
  let blockSelectorDraftSurface: FeedbackDraftSurfaceLease | null = null;
  let pendingTargetElements: HTMLElement[] = [];
  let activeTargetElements: HTMLElement[] = [];
  let activeItemIds: string[] | null = null;
  let activeItemId: string | null = null;
  let originalAriaReadonly: string | null = null;
  let originalTabIndex: string | null = null;
  let readOnlyApplied = false;
  let reviewListenersBound = false;
  let startRequestId: string | null = null;
  let pendingClose: {
    requestId: string;
    sessionId: string;
    appliedRevision: number;
    latestRevision: number;
    releaseRevision?: number;
  } | null = null;
  let completionDialog: HTMLElement | null = null;
  let completionReturnFocus: HTMLElement | null = null;
  let completionReturnSelector: string | null = null;
  let completionDraftSurface: FeedbackDraftSurfaceLease | null = null;
  let completionResumeButton: HTMLButtonElement | null = null;
  let completionRevealButton: HTMLButtonElement | null = null;
  let completionConfirmButton: HTMLButtonElement | null = null;
  let pendingFinishRequestId: string | null = null;
  let sealedCompletionSummary: FeedbackCompletionSummary | null = null;
  let restoreEditorFocusAfterClose = false;
  let pendingTransitionRecovery: {
    requestId: string;
    lockId: string;
    appliedRevision: number;
    latestRevision: number;
  } | null = null;
  let transitionReturnFocus: HTMLElement | null = null;
  let restoreFocusTo: HTMLElement | null = null;
  let annotationLayoutFrame: number | null = null;
  let annotationResizeObserver: ResizeObserver | null = null;
  let annotationController: FeedbackAnnotationController | null = null;
  let currentAnnotationLayout: FeedbackAnnotationLayoutResult | null = null;
  let annotationsSuspended = false;
  let captureState: FeedbackCaptureUiState = 'idle';
  let unresolvedRenderedRangeIds = new Set<string>();
  let blockFallbackBracketIds = new Set<string>();
  let feedbackBlockPositions: Array<{ from: number; to: number }> = [];
  let requestedUndoFocusId: string | null = null;
  const lastValidTargetGeometry = new Map<string, MeasuredFeedbackTarget>();
  const lastValidCardHeights = new Map<string, number>();
  const deletedItems = new Map<string, FeedbackItemSummary>();
  const pendingMutations = new Map<string, PendingFeedbackMutation>();

  const clusterIdsForItem = (id: string): string[] => {
    const ids = currentAnnotationLayout?.clusters.find(cluster =>
      cluster.memberIds.includes(id)
    )?.memberIds;
    return ids ? [...ids].sort(compareFeedbackIds) : [id];
  };

  const post = (message: FeedbackWebviewMessage): void => host.postMessage(message);
  const hasWritableSession = (): boolean =>
    session !== null && !invalidated && pendingFinishRequestId === null && pendingClose === null;

  const refreshFeedbackBlockPositions = (): void => {
    feedbackBlockPositions = [];
    editor.state.doc.forEach((node, offset, ordinal) => {
      feedbackBlockPositions[ordinal] = { from: offset, to: offset + node.nodeSize };
    });
  };

  const buildAnnotationTargets = (): FeedbackAnnotationTarget[] => {
    if (!session) {
      unresolvedRenderedRangeIds = new Set();
      blockFallbackBracketIds = new Set();
      return [];
    }
    const targets: FeedbackAnnotationTarget[] = [];
    const nextUnresolvedRenderedRangeIds = new Set<string>();
    const nextBlockFallbackBracketIds = new Set<string>();
    for (const item of session.items) {
      if (item.kind === 'text' && item.renderedRange) {
        let resolved = null;
        try {
          resolved = resolveFeedbackRenderedRange(editor, item.renderedRange, item.focus);
        } catch {
          // A temporarily unavailable NodeView/DOM mapping is a recoverable
          // exact-anchor failure. The frozen containing blocks remain safe.
        }
        if (resolved) {
          targets.push({ id: item.id, kind: 'inline', from: resolved.from, to: resolved.to });
          continue;
        }
        nextUnresolvedRenderedRangeIds.add(item.id);
      }
      if (item.startOrdinal < item.endOrdinal) {
        nextBlockFallbackBracketIds.add(item.id);
      }
      for (let ordinal = item.startOrdinal; ordinal <= item.endOrdinal; ordinal += 1) {
        const position = feedbackBlockPositions[ordinal];
        if (position) {
          targets.push({ id: item.id, kind: 'node', from: position.from, to: position.to });
        }
      }
    }
    if (composerTarget?.renderedRange) {
      let pending = null;
      try {
        pending = resolveFeedbackRenderedRange(
          editor,
          composerTarget.renderedRange,
          composerTarget.focus
        );
      } catch {
        // Pending text already has a safe containing-block decoration.
      }
      if (pending) {
        targets.push({
          id: PENDING_FEEDBACK_ANNOTATION_ID,
          kind: 'inline',
          from: pending.from,
          to: pending.to,
        });
      }
    }
    unresolvedRenderedRangeIds = nextUnresolvedRenderedRangeIds;
    blockFallbackBracketIds = nextBlockFallbackBracketIds;
    return targets;
  };

  const syncAnnotationDecorations = (): void => {
    const targets = buildAnnotationTargets();
    renderAnnotationAnchorAlert(unresolvedRenderedRangeIds);
    if (!annotationController?.isRegistered()) return;
    annotationController.setItems(targets);
    annotationController.setActiveIds(activeItemId ? [activeItemId] : []);
    if (annotationsSuspended) annotationController.suspend();
    else annotationController.restore();
  };

  const announce = (message: string): void => {
    if (!liveRegion) return;
    liveRegion.textContent = '';
    window.setTimeout(() => {
      if (liveRegion) liveRegion.textContent = message;
    }, 0);
  };

  const removeSyncRetryAlert = (): boolean => {
    const containedFocus = Boolean(
      syncRetryAlert &&
      document.activeElement instanceof HTMLElement &&
      syncRetryAlert.contains(document.activeElement)
    );
    syncRetryAlert?.remove();
    syncRetryAlert = null;
    return containedFocus;
  };

  const resetSyncRetryButton = (): void => {
    const button = syncRetryAlert?.querySelector<HTMLButtonElement>(
      '[data-feedback-close-retry], [data-feedback-transition-retry]'
    );
    if (!button) return;
    button.disabled = false;
    button.textContent = 'Retry';
    button.focus({ preventScroll: true });
  };

  const renderSyncRetryAlert = (
    kind: 'close' | 'transition',
    message: string,
    retry: () => void
  ): void => {
    removeSyncRetryAlert();
    syncRetryAlert = createElement('section', 'feedback-sync-retry-alert');
    syncRetryAlert.setAttribute('role', 'alert');
    syncRetryAlert.setAttribute('aria-label', 'Feedback source restore failed');
    const status = createElement('span', 'feedback-sync-retry-message', message);
    const button = createElement('button', 'feedback-secondary-button', 'Retry');
    button.type = 'button';
    button.setAttribute(`data-feedback-${kind}-retry`, '');
    button.setAttribute('aria-label', 'Retry restoring the latest Markdown source');
    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Retrying…';
      retry();
    });
    syncRetryAlert.append(status, button);
    document.body.append(syncRetryAlert);
    button.focus({ preventScroll: true });
  };

  const registerReadOnlyPlugin = (): void => {
    const dynamicEditor = editor as Editor & {
      registerPlugin?: Editor['registerPlugin'];
      unregisterPlugin?: Editor['unregisterPlugin'];
    };
    if (
      editor.isDestroyed === true ||
      typeof dynamicEditor.registerPlugin !== 'function' ||
      typeof dynamicEditor.unregisterPlugin !== 'function' ||
      feedbackReadOnlyPluginKey.get(editor.state)
    ) {
      return;
    }
    dynamicEditor.registerPlugin(createFeedbackReadOnlyPlugin());
  };

  const unregisterReadOnlyPlugin = (): void => {
    const dynamicEditor = editor as Editor & {
      unregisterPlugin?: Editor['unregisterPlugin'];
    };
    if (
      editor.isDestroyed === true ||
      typeof dynamicEditor.unregisterPlugin !== 'function' ||
      !feedbackReadOnlyPluginKey.get(editor.state)
    ) {
      return;
    }
    dynamicEditor.unregisterPlugin(feedbackReadOnlyPluginKey);
  };

  const setReadOnly = (active: boolean): void => {
    if (active) {
      if (readOnlyApplied) return;
      originalAriaReadonly = editorDom.getAttribute('aria-readonly');
      originalTabIndex = editorDom.getAttribute('tabindex');
      registerReadOnlyPlugin();
      // Keep Chromium's native selection surface intact, including custom code
      // block NodeViews. The transaction filter and DOM guards below enforce
      // immutability while aria-readonly communicates the frozen state.
      editorDom.setAttribute('aria-readonly', 'true');
      editorDom.setAttribute('tabindex', '0');
      readOnlyApplied = true;
      bindReviewListeners();
      onReadOnlyChange?.(true);
      return;
    }

    if (!readOnlyApplied) {
      unbindReviewListeners();
      unregisterReadOnlyPlugin();
      return;
    }

    readOnlyApplied = false;
    unbindReviewListeners();
    unregisterReadOnlyPlugin();
    onReadOnlyChange?.(false);
    if (originalAriaReadonly === null) editorDom.removeAttribute('aria-readonly');
    else editorDom.setAttribute('aria-readonly', originalAriaReadonly);
    if (originalTabIndex === null) editorDom.removeAttribute('tabindex');
    else editorDom.setAttribute('tabindex', originalTabIndex);
    originalAriaReadonly = null;
    originalTabIndex = null;
  };

  const removeDraftBanner = (): void => {
    draftBanner?.remove();
    draftBanner = null;
  };

  const setDraftBannerBusy = (busy: boolean): void => {
    if (!draftBanner) return;
    if (busy) draftBanner.setAttribute('aria-busy', 'true');
    else draftBanner.removeAttribute('aria-busy');
    draftBanner
      .querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select')
      .forEach(control => {
        control.disabled = busy;
      });
  };

  const rememberTransitionFocus = (): void => {
    transitionReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : editorDom;
  };

  const restoreTransitionFocus = (): void => {
    const preferred = transitionReturnFocus;
    transitionReturnFocus = null;
    if (
      preferred?.isConnected &&
      (!(preferred instanceof HTMLButtonElement) || !preferred.disabled)
    ) {
      preferred.focus({ preventScroll: true });
      return;
    }
    const draftAction = draftBanner?.querySelector<HTMLElement>(
      'button:not(:disabled), select:not(:disabled)'
    );
    (draftAction ?? editorDom).focus({ preventScroll: true });
  };

  const renderDraftBanner = (drafts: FeedbackDraftSummary[]): void => {
    availableDrafts = drafts.map(draft => ({ ...draft }));
    const renderedDrafts = availableDrafts;
    removeDraftBanner();
    if (session || renderedDrafts.length === 0) return;

    let selectedDraft = renderedDrafts[0];
    draftBanner = createElement('section', 'feedback-draft-banner');
    draftBanner.setAttribute('data-feedback-draft-banner', '');
    draftBanner.setAttribute('role', 'region');
    draftBanner.setAttribute('aria-label', 'Available Feedback drafts');
    const copy = createElement('div', 'feedback-draft-copy');
    const title = createElement('strong', 'feedback-draft-title', 'Feedback draft available');
    const detail = createElement('span', 'feedback-draft-detail');
    detail.setAttribute('aria-live', 'polite');
    const updateDetail = (): void => {
      const countLabel = `${selectedDraft.itemCount} ${
        selectedDraft.itemCount === 1 ? 'comment' : 'comments'
      }`;
      detail.textContent =
        renderedDrafts.length === 1
          ? `${countLabel} can be resumed from the saved snapshot.`
          : `${renderedDrafts.length} matching drafts found. Selected draft has ${countLabel}.`;
    };
    updateDetail();
    copy.append(title);
    if (renderedDrafts.length > 1) {
      const picker = document.createElement('select');
      picker.className = 'feedback-draft-picker';
      picker.setAttribute('data-feedback-draft-picker', '');
      picker.setAttribute('aria-label', 'Choose a Feedback draft');
      for (const draft of renderedDrafts) {
        const countLabel = `${draft.itemCount} ${draft.itemCount === 1 ? 'comment' : 'comments'}`;
        picker.add(new Option(`${draft.round} · ${countLabel}`, draft.round));
      }
      picker.addEventListener('change', () => {
        selectedDraft =
          renderedDrafts.find(draft => draft.round === picker.value) ?? renderedDrafts[0];
        updateDetail();
      });
      copy.append(picker);
    }
    copy.append(detail);

    const actions = createElement('div', 'feedback-draft-actions');
    const resume = createElement('button', 'feedback-primary-button', 'Resume');
    resume.type = 'button';
    resume.setAttribute('data-feedback-draft-resume', '');
    resume.addEventListener('click', () => {
      if (session || startRequestId) return;
      rememberTransitionFocus();
      setDraftBannerBusy(true);
      window.dispatchEvent(new CustomEvent('feedbackResumeRequested'));
      let blocks: CanonicalFeedbackBlock[];
      try {
        blocks = enumerateCanonicalFeedbackBlocks(editor);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Cannot enumerate rendered blocks';
        window.dispatchEvent(new CustomEvent('feedbackLocalError', { detail: { message } }));
        setDraftBannerBusy(false);
        restoreTransitionFocus();
        return;
      }
      startRequestId = nextRequestId();
      setReadOnly(true);
      document.body.classList.add('feedback-review-starting');
      setFeedbackToolbarState({ active: false, starting: true });
      post({
        type: 'feedback.draft.resume',
        requestId: startRequestId,
        round: selectedDraft.round,
        blocks,
      });
    });
    const reveal = createElement('button', 'feedback-secondary-button', 'Reveal');
    reveal.type = 'button';
    reveal.addEventListener('click', () => {
      post({
        type: 'feedback.draft.reveal',
        requestId: nextRequestId(),
        round: selectedDraft.round,
      });
    });
    const discard = createElement('button', 'feedback-secondary-button', 'Discard');
    discard.type = 'button';
    discard.addEventListener('click', () => {
      if (session || startRequestId) return;
      rememberTransitionFocus();
      startRequestId = nextRequestId();
      setDraftBannerBusy(true);
      setReadOnly(true);
      document.body.classList.add('feedback-review-starting');
      setFeedbackToolbarState({ active: false, starting: true });
      post({
        type: 'feedback.draft.discard',
        requestId: startRequestId,
        round: selectedDraft.round,
      });
    });
    const dismiss = createElement('button', 'feedback-secondary-button', 'Not now');
    dismiss.type = 'button';
    dismiss.addEventListener('click', () => {
      removeDraftBanner();
    });
    actions.append(resume, reveal, discard, dismiss);
    draftBanner.append(copy, actions);

    const shell = editorDom.closest('#editor')?.parentElement ?? editorDom.parentElement;
    shell?.append(draftBanner);
  };

  const clearPendingTarget = (): void => {
    pendingTargetElements.forEach(element => element.classList.remove('feedback-pending-target'));
    pendingTargetElements = [];
  };

  const clearActiveTarget = (): void => {
    activeTargetElements.forEach(element => element.classList.remove('feedback-active-target'));
    activeTargetElements = [];
  };

  const removePendingButton = (): void => {
    pendingButton?.remove();
    pendingButton = null;
    pendingButtonTarget = null;
    pendingSelectionRange = null;
  };

  const markActiveItems = (ids: string[]): void => {
    clearActiveTarget();
    annotationController?.setActiveIds(ids);
    if (!session) return;
    const items = session.items.filter(item => ids.includes(item.id));
    for (const item of items) {
      let hasExactRenderedTarget = false;
      if (item.kind === 'text' && item.renderedRange) {
        try {
          hasExactRenderedTarget = Boolean(
            resolveFeedbackRenderedRange(editor, item.renderedRange, item.focus)
          );
        } catch {
          hasExactRenderedTarget = false;
        }
      }
      if (hasExactRenderedTarget) continue;
      for (let ordinal = item.startOrdinal; ordinal <= item.endOrdinal; ordinal += 1) {
        const element = editorDom.children.item(ordinal);
        if (element instanceof HTMLElement) {
          element.classList.add('feedback-active-target');
          activeTargetElements.push(element);
        }
      }
    }
  };

  const pendingSelectionRect = (): DOMRect | null => {
    try {
      if (pendingSelectionRange) {
        const rects =
          typeof pendingSelectionRange.getClientRects === 'function'
            ? Array.from(pendingSelectionRange.getClientRects())
            : [];
        const visibleRects = rects.filter(rect => rect.width > 0 || rect.height > 0);
        const rect = visibleRects[visibleRects.length - 1];
        if (rect) return rect;
        if (typeof pendingSelectionRange.getBoundingClientRect === 'function') {
          const bounds = pendingSelectionRange.getBoundingClientRect();
          if (bounds.width > 0 || bounds.height > 0) return bounds;
        }
      }
    } catch {
      // The native range can become detached while the document is rerendered.
    }

    const target = pendingButtonTarget;
    if (!target) return null;
    const block = editorDom.children.item(target.endOrdinal) as HTMLElement | null;
    return block?.getBoundingClientRect() ?? null;
  };

  const positionPendingButton = (): void => {
    if (!pendingButton) return;
    const rect = pendingSelectionRect();
    if (!rect || !editorContainer) {
      pendingButton.hidden = true;
      return;
    }
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    if (
      rect.bottom < 0 ||
      rect.top > viewportHeight ||
      rect.right < 0 ||
      rect.left > viewportWidth
    ) {
      pendingButton.hidden = true;
      return;
    }

    const actionWidth = pendingButton.offsetWidth || 36;
    const actionHeight = pendingButton.offsetHeight || 36;
    const containerRect = editorContainer.getBoundingClientRect();
    const containerWidth = containerRect.width || viewportWidth;
    const edgeGap = 8;
    const rightInset = commentsState !== 'hidden' && rail && !rail.hidden ? 44 : edgeGap;
    let left = rect.right - containerRect.left + edgeGap;
    if (left + actionWidth > containerWidth - rightInset) {
      left = rect.left - containerRect.left - actionWidth - edgeGap;
    }
    let top = rect.bottom - containerRect.top + edgeGap;
    if (rect.bottom + actionHeight + edgeGap > viewportHeight) {
      top = rect.top - containerRect.top - actionHeight - edgeGap;
    }
    pendingButton.hidden = false;
    pendingButton.style.left = `${Math.round(Math.max(edgeGap, left))}px`;
    pendingButton.style.top = `${Math.round(Math.max(edgeGap, top))}px`;
  };

  const syncCommentsUi = (): void => {
    const commentsVisible = commentsState !== 'hidden';
    const commentsExpanded = commentsState === 'expanded';
    if (rail) {
      rail.hidden = !commentsVisible;
      rail.classList.toggle('expanded', commentsExpanded);
      rail.setAttribute('aria-hidden', String(!commentsVisible));
      rail.setAttribute('data-feedback-comments-state', commentsState);
    }
    if (targetBracketLayer) {
      targetBracketLayer.hidden = !commentsVisible || annotationsSuspended;
    }
    markerLayer?.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]').forEach(marker => {
      const markerIds = marker.getAttribute('data-feedback-ids');
      const activeIds = activeItemIds?.join(',') ?? '';
      marker.setAttribute(
        'aria-expanded',
        String(commentsExpanded && markerIds !== null && markerIds === activeIds)
      );
    });
    document.body.setAttribute('data-feedback-comments-state', commentsState);
    if (session) {
      setFeedbackToolbarState({
        active: true,
        count: session.items.length,
        commentsState,
        commentsLocked: composer !== null,
        invalidated,
        closing: pendingFinishRequestId !== null || pendingClose !== null,
        captureState,
      });
    }
    positionPendingButton();
  };

  const setCommentsState = (nextState: FeedbackCommentsState): void => {
    commentsState = nextState;
    syncCommentsUi();
  };

  const feedbackCompletionCount = (count: number, locked: boolean): string => {
    if (count === 0) return 'No feedback logged yet';
    const noun = count === 1 ? 'feedback item' : 'feedback items';
    return `${count} ${noun} ${locked ? 'locked' : 'ready to lock'}`;
  };

  const completionFocusableElements = (dialog: HTMLElement): HTMLElement[] =>
    Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
          'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );

  const focusElementWithoutScroll = (element: HTMLElement | null): boolean => {
    if (
      !element?.isConnected ||
      element.getAttribute('aria-disabled') === 'true' ||
      element.matches(':disabled, [inert]') ||
      element.closest('[inert], [hidden], [aria-hidden="true"], [aria-disabled="true"]')
    ) {
      return false;
    }
    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }
    return document.activeElement === element || element.contains(document.activeElement);
  };

  const removeCompletionDialog = (restoreFocus: boolean): void => {
    const returnFocus =
      (completionReturnSelector
        ? document.querySelector<HTMLElement>(completionReturnSelector)
        : null) ?? completionReturnFocus;
    completionDraftSurface?.release();
    completionDraftSurface = null;
    completionDialog?.remove();
    completionDialog = null;
    completionReturnFocus = null;
    completionReturnSelector = null;
    completionResumeButton = null;
    completionRevealButton = null;
    completionConfirmButton = null;
    document.body.classList.remove('feedback-completion-open');
    if (restoreFocus) {
      if (!focusElementWithoutScroll(returnFocus)) focusElementWithoutScroll(editorDom);
    }
  };

  const trapCompletionFocus = (
    dialog: HTMLElement,
    event: KeyboardEvent,
    onEscape: () => void
  ): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
      return;
    }
    if (['PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const surface = dialog.querySelector<HTMLElement>('.feedback-completion-panel');
      if (!surface) return;
      const maximum = Math.max(0, surface.scrollHeight - surface.clientHeight);
      if (event.key === 'Home') surface.scrollTop = 0;
      else if (event.key === 'End') surface.scrollTop = maximum;
      else {
        const direction = event.key === 'PageUp' ? -1 : 1;
        surface.scrollTop = Math.max(
          0,
          Math.min(maximum, surface.scrollTop + direction * Math.max(1, surface.clientHeight * 0.8))
        );
      }
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = completionFocusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && currentIndex <= 0) {
      event.preventDefault();
      focusable[focusable.length - 1]?.focus({ preventScroll: true });
    } else if (!event.shiftKey && (currentIndex < 0 || currentIndex === focusable.length - 1)) {
      event.preventDefault();
      focusable[0]?.focus({ preventScroll: true });
    }
  };

  const containCompletionPointerScroll = (dialog: HTMLElement, surface: HTMLElement): void => {
    const preventBackgroundScroll = (event: Event): void => {
      if (event.target instanceof Node && surface.contains(event.target)) return;
      event.preventDefault();
    };
    dialog.addEventListener('wheel', preventBackgroundScroll, { passive: false });
    dialog.addEventListener('touchmove', preventBackgroundScroll, { passive: false });
  };

  const updateCompletionCheckpoint = (message?: string): void => {
    if (!completionDialog || !session) return;
    const isFinishing = pendingFinishRequestId !== null || pendingClose !== null;
    completionDialog.setAttribute(
      'data-feedback-completion-state',
      isFinishing ? 'finishing' : 'confirm'
    );
    completionDialog.toggleAttribute('aria-busy', isFinishing);
    const count = session.items.length;
    const countElement = completionDialog.querySelector<HTMLElement>(
      '[data-feedback-completion-count]'
    );
    const status = completionDialog.querySelector<HTMLElement>('[data-feedback-completion-status]');
    const actions = completionDialog.querySelector<HTMLElement>('.feedback-completion-actions');
    const resume = completionResumeButton;
    const reveal = completionRevealButton;
    const confirm = completionConfirmButton;
    if (countElement) countElement.textContent = feedbackCompletionCount(count, false);
    if (status) status.textContent = message ?? '';
    if (!isFinishing && actions && confirm) {
      if (resume && !resume.isConnected) actions.insertBefore(resume, confirm);
      if (reveal && !reveal.isConnected) actions.insertBefore(reveal, confirm);
    }
    if (resume) resume.disabled = isFinishing;
    if (reveal) reveal.disabled = isFinishing;
    if (confirm) {
      confirm.textContent = isFinishing ? 'Finishing…' : 'Finish & copy';
      confirm.disabled = isFinishing || invalidated || count === 0;
    }
  };

  const openCompletionCheckpoint = (): void => {
    if (!session) return;
    if (completionDialog?.isConnected) {
      focusElementWithoutScroll(
        completionDialog.querySelector<HTMLElement>('[data-feedback-completion-resume]') ??
          completionDialog
      );
      return;
    }

    completionReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : editorDom;
    completionReturnSelector = completionReturnFocus.matches('[data-feedback-finish]')
      ? '[data-feedback-finish]'
      : null;
    const dialog = createElement(
      'section',
      'feedback-annotation-dialog feedback-completion-dialog'
    );
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'feedback-completion-title');
    dialog.setAttribute(
      'aria-describedby',
      'feedback-completion-description feedback-completion-count feedback-completion-path feedback-completion-status'
    );
    dialog.setAttribute('data-md4h-modal', '');
    dialog.setAttribute('data-feedback-completion-dialog', '');
    dialog.setAttribute('data-feedback-completion-state', 'confirm');
    dialog.tabIndex = -1;

    const surface = createElement('div', 'feedback-annotation-panel feedback-completion-panel');
    const title = createElement('h2', 'feedback-completion-title', 'Finish feedback?');
    title.id = 'feedback-completion-title';
    const explanation = createElement(
      'p',
      'feedback-completion-description',
      'This locks the saved feedback bundle, restores editing, and prepares the agent handoff.'
    );
    explanation.id = 'feedback-completion-description';
    const count = createElement(
      'p',
      'feedback-completion-count',
      feedbackCompletionCount(session.items.length, false)
    );
    count.id = 'feedback-completion-count';
    count.setAttribute('data-feedback-completion-count', '');
    const pathLabel = createElement('p', 'feedback-completion-path-label', 'Feedback file');
    pathLabel.id = 'feedback-completion-path-label';
    const path = createElement(
      'code',
      'feedback-composer-focus feedback-completion-path',
      session.feedbackFile ?? 'Feedback file path unavailable'
    );
    path.id = 'feedback-completion-path';
    path.tabIndex = 0;
    path.setAttribute('aria-labelledby', pathLabel.id);
    path.setAttribute('data-feedback-completion-path', '');
    const status = createElement('p', 'feedback-completion-status');
    status.id = 'feedback-completion-status';
    status.setAttribute('data-feedback-completion-status', '');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');

    const actions = createElement('div', 'feedback-annotation-actions feedback-completion-actions');
    const resume = createElement('button', 'feedback-secondary-button', 'Resume feedback');
    resume.type = 'button';
    resume.setAttribute('data-feedback-completion-resume', '');
    const reveal = createElement('button', 'feedback-secondary-button', 'Reveal feedback file');
    reveal.type = 'button';
    reveal.setAttribute('data-feedback-completion-reveal', '');
    const confirm = createElement('button', 'feedback-primary-button', 'Finish & copy');
    confirm.type = 'button';
    confirm.setAttribute('data-feedback-action', 'add');
    confirm.setAttribute('data-feedback-completion-confirm', '');
    confirm.disabled = session.items.length === 0;
    completionResumeButton = resume;
    completionRevealButton = reveal;
    completionConfirmButton = confirm;
    actions.append(resume, reveal, confirm);
    surface.append(title, explanation, count, pathLabel, path, status, actions);
    dialog.append(surface);
    containCompletionPointerScroll(dialog, surface);

    const resumeFeedback = (): void => {
      if (pendingFinishRequestId !== null || pendingClose !== null) return;
      removeCompletionDialog(true);
    };
    resume.addEventListener('click', resumeFeedback);
    reveal.addEventListener('click', () => {
      if (!session || pendingFinishRequestId !== null) return;
      post({
        type: 'feedback.reveal',
        requestId: nextRequestId(),
        sessionId: session.sessionId,
      });
    });
    confirm.addEventListener('click', () => {
      if (
        !session ||
        pendingFinishRequestId !== null ||
        invalidated ||
        session.items.length === 0
      ) {
        return;
      }
      const requestId = nextRequestId();
      pendingFinishRequestId = requestId;
      dialog.setAttribute('data-feedback-completion-state', 'finishing');
      dialog.setAttribute('aria-busy', 'true');
      resume.remove();
      reveal.remove();
      confirm.textContent = 'Finishing…';
      confirm.disabled = true;
      status.textContent = 'Locking feedback and copying the agent handoff…';
      dialog.focus({ preventScroll: true });
      syncCommentsUi();
      post({ type: 'feedback.finish', requestId, sessionId: session.sessionId });
    });
    dialog.addEventListener('keydown', event => {
      trapCompletionFocus(dialog, event, resumeFeedback);
    });

    completionDialog = dialog;
    document.body.classList.add('feedback-completion-open');
    document.body.append(dialog);
    completionDraftSurface = draftSurfaceGate.claim({
      kind: 'finish-checkpoint',
      element: dialog,
      focus: () => {
        focusElementWithoutScroll(
          completionResumeButton?.isConnected ? completionResumeButton : completionDialog
        );
      },
    });
    resume.focus({ preventScroll: true });
  };

  const showSealedCompletion = (summary: FeedbackCompletionSummary): void => {
    removeCompletionDialog(false);
    sealedCompletionSummary = summary;
    completionReturnFocus = editorDom;
    const dialog = createElement(
      'section',
      'feedback-annotation-dialog feedback-completion-dialog'
    );
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'feedback-completion-title');
    dialog.setAttribute(
      'aria-describedby',
      'feedback-completion-description feedback-completion-count feedback-completion-path feedback-completion-status'
    );
    dialog.setAttribute('data-md4h-modal', '');
    dialog.setAttribute('data-feedback-completion-dialog', '');
    dialog.setAttribute('data-feedback-completion-state', 'sealed');
    dialog.tabIndex = -1;

    const surface = createElement('div', 'feedback-annotation-panel feedback-completion-panel');
    const title = createElement('h2', 'feedback-completion-title', 'Feedback locked');
    title.id = 'feedback-completion-title';
    const explanation = createElement(
      'p',
      'feedback-completion-description',
      'The sealed bundle is ready to share with an agent.'
    );
    explanation.id = 'feedback-completion-description';
    const count = createElement(
      'p',
      'feedback-completion-count',
      feedbackCompletionCount(summary.itemCount, true)
    );
    count.id = 'feedback-completion-count';
    count.setAttribute('data-feedback-completion-count', '');
    const pathLabel = createElement('p', 'feedback-completion-path-label', 'Share this file');
    pathLabel.id = 'feedback-completion-path-label';
    const path = createElement(
      'code',
      'feedback-composer-focus feedback-completion-path',
      summary.feedbackFile
    );
    path.id = 'feedback-completion-path';
    path.tabIndex = 0;
    path.setAttribute('aria-labelledby', pathLabel.id);
    path.setAttribute('data-feedback-completion-path', '');
    const status = createElement(
      'p',
      'feedback-completion-status',
      summary.promptCopied
        ? 'Agent handoff copied'
        : 'The bundle is safe, but the agent handoff was not copied.'
    );
    status.id = 'feedback-completion-status';
    status.setAttribute('data-feedback-completion-status', '');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    const actions = createElement('div', 'feedback-annotation-actions feedback-completion-actions');
    const done = createElement('button', 'feedback-primary-button', 'Done');
    done.type = 'button';
    done.setAttribute('data-feedback-action', 'add');
    done.setAttribute('data-feedback-completion-done', '');
    const dismiss = (): void => {
      sealedCompletionSummary = null;
      removeCompletionDialog(true);
    };
    done.addEventListener('click', dismiss);
    if (!summary.promptCopied) {
      const copyAgain = createElement('button', 'feedback-secondary-button', 'Copy again');
      copyAgain.type = 'button';
      copyAgain.setAttribute('data-feedback-completion-copy-again', '');
      copyAgain.addEventListener('click', () => {
        if (copyAgain.disabled) return;
        copyAgain.disabled = true;
        status.textContent = 'Copying agent handoff…';
        void (async () => {
          try {
            if (!navigator.clipboard) throw new Error('Clipboard API is unavailable');
            await navigator.clipboard.writeText(summary.prompt);
            summary.promptCopied = true;
            status.textContent = 'Agent handoff copied';
            copyAgain.remove();
          } catch (error) {
            console.error('[MD4H] Feedback clipboard retry failed:', error);
            status.textContent = 'Could not copy the agent handoff. Try again.';
            copyAgain.disabled = false;
            copyAgain.focus({ preventScroll: true });
          }
        })();
      });
      actions.append(copyAgain);
    }
    actions.append(done);
    surface.append(title, explanation, count, pathLabel, path, status, actions);
    dialog.append(surface);
    containCompletionPointerScroll(dialog, surface);
    dialog.addEventListener('keydown', event => {
      trapCompletionFocus(dialog, event, dismiss);
    });

    completionDialog = dialog;
    document.body.classList.add('feedback-completion-open');
    document.body.append(dialog);
    done.focus({ preventScroll: true });
  };

  const clearActiveComment = (): void => {
    activeItemIds = null;
    activeItemId = null;
    markerLayer?.querySelectorAll('.feedback-marker.active').forEach(marker => {
      marker.classList.remove('active');
    });
    targetBracketLayer?.querySelectorAll('.feedback-target-bracket.active').forEach(bracket => {
      bracket.classList.remove('active');
    });
    clearActiveTarget();
    annotationController?.setActiveIds([]);
  };

  const collapseRail = (restoreToolbarFocus = false): void => {
    clearActiveComment();
    const hasOnlyDeletedItems =
      composer === null && session?.items.length === 0 && deletedItems.size > 0;
    setCommentsState(commentsState === 'hidden' || hasOnlyDeletedItems ? 'hidden' : 'collapsed');
    if (restoreToolbarFocus) {
      document.querySelector<HTMLButtonElement>('[data-feedback-comments]')?.focus();
    }
  };

  const markPendingTarget = (target: FeedbackTextTarget): void => {
    clearPendingTarget();
    clearActiveTarget();
    if (target.renderedRange) {
      try {
        if (resolveFeedbackRenderedRange(editor, target.renderedRange, target.focus)) return;
      } catch {
        // Honest block fallback below.
      }
    }
    for (let ordinal = target.startOrdinal; ordinal <= target.endOrdinal; ordinal += 1) {
      const element = editorDom.children.item(ordinal);
      if (element instanceof HTMLElement) {
        element.classList.add('feedback-pending-target');
        pendingTargetElements.push(element);
      }
    }
  };

  const closeComposer = (restoreFocus = true): void => {
    if (composer) annotationResizeObserver?.unobserve(composer);
    composerDraftSurface?.release();
    composerDraftSurface = null;
    composer?.remove();
    composer = null;
    composerTarget = null;
    removePendingButton();
    clearPendingTarget();
    syncAnnotationDecorations();
    collapseRail();
    if (restoreFocus && restoreFocusTo?.isConnected) {
      restoreFocusTo.focus({ preventScroll: true });
    }
    restoreFocusTo = null;
  };

  const activateFeedbackItem = (
    preferredId: string,
    authoritativeCluster?: readonly string[]
  ): void => {
    if (!session || composer || !session.items.some(item => item.id === preferredId)) return;
    activeItemIds = authoritativeCluster
      ? [...authoritativeCluster].sort(compareFeedbackIds)
      : clusterIdsForItem(preferredId);
    activeItemId = preferredId;
    markActiveItems([preferredId]);
    setCommentsState('expanded');
    markerLayer?.querySelectorAll<HTMLElement>('[data-feedback-marker]').forEach(marker => {
      const markerIds = marker.dataset.feedbackIds?.split(',') ?? [];
      const active = markerIds.includes(preferredId);
      marker.classList.toggle('active', active);
      marker.setAttribute('aria-expanded', String(active));
    });
    renderCards();
    syncAnnotationDecorations();
    applyMarkerPositions(calculateAnnotationLayout());
    panel
      ?.querySelector<HTMLElement>(`[data-feedback-card="${preferredId}"]`)
      ?.focus({ preventScroll: true });
  };

  const renderCards = (): void => {
    if (!panel || !session) return;
    const activeComposer = composer?.isConnected ? composer : null;
    // The composer is the panel's only child while a draft is open. Keeping the
    // same node attached preserves its value, selection, and focus when an
    // unrelated host update refreshes saved items.
    if (activeComposer && panel.contains(activeComposer)) return;
    panel.replaceChildren();
    if (activeComposer) {
      panel.append(activeComposer);
      return;
    }
    const header = createElement('div', 'feedback-panel-header');
    const heading = createElement(
      'h2',
      'feedback-panel-title',
      `Comments · ${session.items.length}`
    );
    const collapse = createElement('button', 'feedback-panel-collapse', '×');
    collapse.type = 'button';
    collapse.title = 'Collapse comment details';
    collapse.setAttribute('aria-label', 'Collapse comment details');
    collapse.setAttribute('data-feedback-panel-collapse', '');
    collapse.addEventListener('click', () => collapseRail(true));
    header.append(heading, collapse);
    panel.append(header);

    const undoStack = createElement('div', 'feedback-undo-stack');
    for (const deleted of deletedItems.values()) {
      const undo = createElement('button', 'feedback-undo-delete', `Undo delete ${deleted.id}`);
      undo.type = 'button';
      undo.disabled = !hasWritableSession();
      undo.setAttribute('data-feedback-undo-id', deleted.id);
      undo.addEventListener('click', () => {
        if (!hasWritableSession() || !session) return;
        undo.disabled = true;
        const requestId = nextRequestId();
        pendingMutations.set(requestId, { kind: 'restore', id: deleted.id, button: undo });
        post({
          type: 'feedback.item.restore',
          requestId,
          sessionId: session.sessionId,
          id: deleted.id,
        });
      });
      undoStack.append(undo);
    }
    if (undoStack.childElementCount > 0) panel.append(undoStack);

    const ordered = [...session.items].sort(
      (left, right) =>
        left.startOrdinal - right.startOrdinal || compareFeedbackIds(left.id, right.id)
    );
    for (const item of ordered) {
      const card = createElement('article', 'feedback-comment-card');
      card.setAttribute('data-feedback-card', item.id);
      const isActive = activeItemId === item.id;
      card.setAttribute('data-feedback-card-state', isActive ? 'active' : 'compact');
      const title = createElement('h3', 'feedback-card-title', item.id);
      if (!isActive) {
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', `Open feedback ${item.id}`);
        const preview = createElement(
          'p',
          'feedback-card-preview',
          item.feedback?.trim() ||
            (item.kind === 'text' && item.focus?.trim()
              ? item.focus
              : item.kind === 'screenshot'
                ? 'Annotated screenshot'
                : 'Feedback saved')
        );
        const activateCompactCard = (): void => {
          activateFeedbackItem(item.id);
        };
        card.addEventListener('click', activateCompactCard);
        card.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          activateCompactCard();
        });
        card.append(title, preview);
        panel.append(card);
        continue;
      }
      card.tabIndex = -1;
      card.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        const matchingMarker = Array.from(
          markerLayer?.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]') ?? []
        ).find(marker => marker.dataset.feedbackIds?.split(',').includes(item.id));
        collapseRail();
        matchingMarker?.focus({ preventScroll: true });
      });
      const location = createElement(
        'div',
        'feedback-card-location',
        `${session.source}:${item.startLine}-${item.endLine}`
      );
      const focusLabel =
        item.kind === 'text' && item.focus?.trim()
          ? createElement('div', 'feedback-card-focus-label', 'Selected text')
          : null;
      const focus =
        item.kind === 'text' && item.focus?.trim()
          ? createElement('blockquote', 'feedback-card-focus', item.focus)
          : null;
      focus?.setAttribute('data-feedback-card-focus', '');
      const body = createElement('p', 'feedback-card-body', item.feedback ?? 'Feedback saved');
      const actions = createElement('div', 'feedback-card-actions');
      let capturePreview: HTMLElement | null = null;
      if (item.kind === 'screenshot') {
        capturePreview = createElement('figure', 'feedback-card-capture');
        capturePreview.setAttribute('aria-label', `Annotated capture for ${item.id}`);
        const unavailable = createElement(
          'p',
          'feedback-card-capture-error',
          'Capture preview unavailable. The saved PNG remains in the feedback bundle.'
        );
        unavailable.setAttribute('data-feedback-card-image-error', '');

        if (item.imageUri) {
          const image = createElement('img', 'feedback-card-capture-image');
          image.setAttribute('data-feedback-card-image', '');
          image.src = item.imageUri;
          image.alt = `Annotated capture for feedback ${item.id}`;
          image.setAttribute('loading', 'lazy');
          image.setAttribute('decoding', 'async');
          image.draggable = false;
          unavailable.hidden = true;
          image.addEventListener('load', () => {
            image.hidden = false;
            unavailable.hidden = true;
            scheduleAnnotationLayout();
          });
          image.addEventListener('error', () => {
            image.hidden = true;
            unavailable.hidden = false;
            announce(`Capture preview unavailable for ${item.id}.`);
          });
          capturePreview.append(image, unavailable);
        } else {
          capturePreview.append(unavailable);
        }
      }
      const showTarget = createElement('button', 'feedback-card-action', 'Show target');
      showTarget.type = 'button';
      showTarget.addEventListener('click', () => {
        const exactTarget = Array.from(
          editorDom.querySelectorAll<HTMLElement>('[data-feedback-ids]')
        ).find(element => element.dataset.feedbackIds?.split(',').includes(item.id));
        const target =
          exactTarget ?? (editorDom.children.item(item.startOrdinal) as HTMLElement | null);
        target?.scrollIntoView({ behavior: 'auto', block: 'center' });
      });
      const edit = createElement('button', 'feedback-card-action', 'Edit');
      edit.type = 'button';
      edit.disabled = !hasWritableSession();
      edit.addEventListener('click', () => {
        if (!hasWritableSession()) return;
        const updated = window.prompt('Update feedback', item.feedback ?? '');
        if (updated?.trim()) {
          post({
            type: 'feedback.item.edit',
            requestId: nextRequestId(),
            sessionId: session?.sessionId ?? '',
            id: item.id,
            feedback: updated.trim(),
          });
        }
      });
      const remove = createElement('button', 'feedback-card-action', 'Delete');
      remove.type = 'button';
      remove.disabled = !hasWritableSession();
      remove.addEventListener('click', () => {
        if (!hasWritableSession() || !session || remove.disabled) return;
        const requestId = nextRequestId();
        remove.disabled = true;
        pendingMutations.set(requestId, { kind: 'delete', item, button: remove });
        post({
          type: 'feedback.item.delete',
          requestId,
          sessionId: session.sessionId,
          id: item.id,
        });
      });
      if (item.kind === 'screenshot') {
        const replace = createElement('button', 'feedback-card-action', 'Replace capture');
        replace.type = 'button';
        replace.disabled = !hasWritableSession();
        replace.addEventListener('click', () => {
          if (!hasWritableSession()) return;
          window.dispatchEvent(
            new CustomEvent('feedbackReplaceScreenshotRequested', {
              detail: { id: item.id, feedback: item.feedback ?? '' },
            })
          );
        });
        actions.append(replace);
      }
      actions.prepend(showTarget);
      actions.append(edit, remove);
      card.append(title);
      if (focusLabel && focus) {
        card.append(focusLabel, focus);
      }
      card.append(location);
      if (capturePreview) card.append(capturePreview);
      card.append(body, actions);
      panel.append(card);
    }
  };

  interface MeasuredFeedbackTarget {
    targetX: number;
    targetY: number;
    targetStart: number;
    targetEnd: number;
    proseLeft: number;
  }

  interface FeedbackTargetGeometryInput {
    id: string;
    startOrdinal: number;
    endOrdinal: number;
  }

  interface FeedbackGeometryMeasurement<T> {
    value: T | null;
    fresh: boolean;
  }

  type FeedbackLayoutIssueState = 'stale' | 'unavailable';

  function clearAnnotationAnchorAlert(): void {
    annotationAnchorAlert?.remove();
    annotationAnchorAlert = null;
    annotationAnchorAlertSignature = '';
  }

  function renderAnnotationAnchorAlert(ids: ReadonlySet<string>): void {
    if (ids.size === 0 || invalidated) {
      clearAnnotationAnchorAlert();
      return;
    }

    const sourceOrderById = new Map(
      [...(session?.items ?? [])]
        .sort(
          (left, right) =>
            left.startOrdinal - right.startOrdinal || compareFeedbackIds(left.id, right.id)
        )
        .map((item, index) => [item.id, index])
    );
    const orderedIds = [...ids].sort(
      (left, right) =>
        (sourceOrderById.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (sourceOrderById.get(right) ?? Number.MAX_SAFE_INTEGER) || compareFeedbackIds(left, right)
    );
    const signature = orderedIds.join('|');
    if (annotationAnchorAlert?.isConnected && annotationAnchorAlertSignature === signature) return;

    annotationAnchorAlert?.remove();
    annotationAnchorAlertSignature = signature;
    controller.reportCaptureError(FEEDBACK_ERROR_CODES.targetDoesNotMap);
    annotationAnchorAlert = createElement(
      'section',
      'feedback-invalidated-alert feedback-anchor-alert'
    );
    annotationAnchorAlert.setAttribute('data-feedback-anchor-alert', '');
    annotationAnchorAlert.setAttribute('role', 'alert');
    annotationAnchorAlert.setAttribute('aria-label', 'Feedback target needs attention');

    const itemWord = orderedIds.length === 1 ? 'target' : 'targets';
    const status = createElement('span', 'feedback-anchor-alert-message');
    status.textContent = `${FEEDBACK_ERROR_CODES.targetDoesNotMap}: Exact rendered ${itemWord} for ${orderedIds.join(', ')} could not be resolved. Safe block-level fallback is shown.`;

    const retry = createElement('button', 'feedback-secondary-button', 'Retry');
    retry.type = 'button';
    retry.setAttribute('data-feedback-anchor-retry', '');
    retry.setAttribute('aria-label', 'Retry exact Feedback target mapping');
    retry.addEventListener('click', () => {
      const preferredId = orderedIds[0];
      renderMarkers();
      if (annotationAnchorAlert) {
        annotationAnchorAlert
          .querySelector<HTMLButtonElement>('[data-feedback-anchor-retry]')
          ?.focus({ preventScroll: true });
        announce(
          `${FEEDBACK_ERROR_CODES.targetDoesNotMap}: Exact Feedback target is still unavailable.`
        );
        return;
      }
      const restoredMarker = Array.from(
        markerLayer?.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]') ?? []
      ).find(marker => marker.dataset.feedbackIds?.split(',').includes(preferredId ?? ''));
      restoredMarker?.focus({ preventScroll: true });
      announce('Exact Feedback target restored.');
    });
    annotationAnchorAlert.append(status, retry);
    frameLabel?.after(annotationAnchorAlert);
  }

  const clearAnnotationLayoutAlert = (): void => {
    annotationLayoutAlert?.remove();
    annotationLayoutAlert = null;
    annotationLayoutAlertSignature = '';
  };

  const renderAnnotationLayoutAlert = (
    issues: ReadonlyMap<string, FeedbackLayoutIssueState>
  ): void => {
    if (issues.size === 0 || invalidated) {
      clearAnnotationLayoutAlert();
      return;
    }

    const sourceOrderById = new Map(
      [...(session?.items ?? [])]
        .sort(
          (left, right) =>
            left.startOrdinal - right.startOrdinal || compareFeedbackIds(left.id, right.id)
        )
        .map((item, index) => [item.id, index])
    );
    const orderedIssues = [...issues.entries()].sort(([left], [right]) => {
      if (left === '__composer__') return 1;
      if (right === '__composer__') return -1;
      return (
        (sourceOrderById.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (sourceOrderById.get(right) ?? Number.MAX_SAFE_INTEGER) || compareFeedbackIds(left, right)
      );
    });
    const signature = orderedIssues.map(([id, state]) => `${id}:${state}`).join('|');
    if (annotationLayoutAlert?.isConnected && annotationLayoutAlertSignature === signature) return;

    annotationLayoutAlert?.remove();
    annotationLayoutAlertSignature = signature;
    annotationLayoutAlert = createElement('section', 'feedback-invalidated-alert');
    annotationLayoutAlert.setAttribute('data-feedback-layout-alert', '');
    annotationLayoutAlert.setAttribute('role', 'alert');
    annotationLayoutAlert.setAttribute('aria-label', 'Feedback layout needs attention');

    const staleIds = orderedIssues
      .filter(([, state]) => state === 'stale')
      .map(([id]) => (id === '__composer__' ? 'the feedback draft' : id));
    const unavailableIds = orderedIssues
      .filter(([, state]) => state === 'unavailable')
      .map(([id]) => (id === '__composer__' ? 'the feedback draft' : id));
    const status = createElement('span', 'feedback-layout-alert-message');
    const parts: string[] = [];
    if (staleIds.length > 0) {
      parts.push(
        `${staleIds.join(', ')} ${staleIds.length === 1 ? 'is' : 'are'} shown at the last measured position`
      );
    }
    if (unavailableIds.length > 0) {
      parts.push(
        `${unavailableIds.join(', ')} ${unavailableIds.length === 1 ? 'is' : 'are'} not currently measurable`
      );
    }
    status.textContent = `${parts.join('. ')}. No approximate positions were used.`;

    const actions = createElement('div', 'feedback-draft-actions');
    for (const [id, state] of orderedIssues) {
      if (state !== 'unavailable' || id === '__composer__') continue;
      const open = createElement('button', 'feedback-secondary-button', `Open ${id}`);
      open.type = 'button';
      open.setAttribute('data-feedback-layout-open', id);
      open.setAttribute('aria-label', `Open feedback ${id} without a positioned marker`);
      open.addEventListener('click', () => activateFeedbackItem(id));
      actions.append(open);
    }
    const retry = createElement('button', 'feedback-secondary-button', 'Retry');
    retry.type = 'button';
    retry.setAttribute('data-feedback-layout-retry', '');
    retry.setAttribute('aria-label', 'Retry Feedback annotation layout');
    retry.addEventListener('click', () => {
      const preferredFocusId = orderedIssues.find(([id]) => id !== '__composer__')?.[0];
      renderMarkers();
      if (annotationLayoutAlert) {
        annotationLayoutAlert
          .querySelector<HTMLButtonElement>('[data-feedback-layout-retry]')
          ?.focus({ preventScroll: true });
        announce('Feedback positions are still unavailable.');
        return;
      }
      const restoredMarker = Array.from(
        markerLayer?.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]') ?? []
      ).find(marker => marker.dataset.feedbackIds?.split(',').includes(preferredFocusId ?? ''));
      (
        restoredMarker ?? markerLayer?.querySelector<HTMLButtonElement>('[data-feedback-marker]')
      )?.focus({ preventScroll: true });
      announce('Feedback annotation positions restored.');
    });
    actions.append(retry);
    annotationLayoutAlert.append(status, actions);
    frameLabel?.after(annotationLayoutAlert);
  };

  const isUsableGeometryRect = (rect: DOMRect): boolean =>
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.bottom) &&
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.right) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    (rect.height > 0 || rect.width > 0 || rect.top !== 0 || rect.bottom !== 0);

  const measureFeedbackTarget = (
    item: FeedbackTargetGeometryInput,
    containerBounds: DOMRect,
    containerWidth: number,
    exactElements: readonly HTMLElement[] = []
  ): FeedbackGeometryMeasurement<MeasuredFeedbackTarget> => {
    const cached = lastValidTargetGeometry.get(item.id) ?? null;
    const startBlock = editorDom.children.item(item.startOrdinal) as HTMLElement | null;
    const endBlock = editorDom.children.item(item.endOrdinal) as HTMLElement | null;
    const blockElements = Array.from(
      new Set([startBlock, endBlock].filter(element => element !== null))
    );
    const containerMeasurementFailed =
      !Number.isFinite(containerBounds.top) ||
      !Number.isFinite(containerBounds.left) ||
      !Number.isFinite(containerWidth) ||
      containerWidth <= 0;
    const readRects = (elements: readonly HTMLElement[]): DOMRect[] | null => {
      if (containerMeasurementFailed || elements.length === 0) return null;
      const rects: DOMRect[] = [];
      for (const element of elements) {
        if (!(element instanceof HTMLElement)) return null;
        try {
          const rect = element.getBoundingClientRect();
          if (!isUsableGeometryRect(rect)) return null;
          rects.push(rect);
        } catch {
          return null;
        }
      }
      return rects;
    };
    // An inline decoration can be temporarily unmeasurable while its NodeView
    // settles. Its host-validated containing blocks remain an exact, safe
    // geometry source. If those blocks also fail, use only session-local cache.
    const blockRects = readRects(blockElements);
    const measuredRects =
      (exactElements.length > 0 ? readRects(exactElements) : null) ?? blockRects;

    if (!measuredRects) {
      return { value: cached, fresh: false };
    }

    const targetStart = Math.min(...measuredRects.map(rect => rect.top - containerBounds.top));
    const targetEnd = Math.max(
      targetStart + 1,
      ...measuredRects.map(rect => rect.bottom - containerBounds.top)
    );
    const firstRect = measuredRects[0];
    const geometry = {
      targetX: Math.min(
        Math.max(0, containerWidth - 44),
        Math.max(0, firstRect.right - containerBounds.left)
      ),
      targetY: targetStart + (targetEnd - targetStart) / 2,
      targetStart,
      targetEnd,
      proseLeft: Math.max(
        0,
        Math.min(...(blockRects ?? measuredRects).map(rect => rect.left)) - containerBounds.left
      ),
    };
    lastValidTargetGeometry.set(item.id, geometry);
    return { value: geometry, fresh: true };
  };

  const measureFeedbackCardHeight = (
    itemId: string,
    state: 'compact' | 'active',
    card: HTMLElement | undefined
  ): FeedbackGeometryMeasurement<number> => {
    const cacheKey = `${itemId}:${state}`;
    const cached = lastValidCardHeights.get(cacheKey) ?? null;
    if (!card) return { value: cached, fresh: false };
    try {
      const rect = card.getBoundingClientRect();
      const height = rect.height > 0 ? rect.height : card.offsetHeight;
      if (!Number.isFinite(height) || height <= 0) return { value: cached, fresh: false };
      lastValidCardHeights.set(cacheKey, height);
      return { value: height, fresh: true };
    } catch {
      return { value: cached, fresh: false };
    }
  };

  const renderFallbackBrackets = (
    items: readonly FeedbackItemSummary[],
    geometryById: ReadonlyMap<string, MeasuredFeedbackTarget>
  ): void => {
    if (!targetBracketLayer) return;
    const existingById = new Map(
      Array.from(
        targetBracketLayer.querySelectorAll<HTMLElement>('[data-feedback-target-bracket]')
      ).map(bracket => [bracket.dataset.feedbackTargetBracket ?? '', bracket])
    );
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      if (!blockFallbackBracketIds.has(item.id)) continue;
      const geometry = geometryById.get(item.id);
      if (!geometry) continue;
      const bracket = existingById.get(item.id) ?? createElement('div', 'feedback-target-bracket');
      bracket.setAttribute('data-feedback-target-bracket', item.id);
      bracket.setAttribute('aria-hidden', 'true');
      bracket.style.top = `${geometry.targetStart}px`;
      bracket.style.left = `${Math.max(0, geometry.proseLeft - 12)}px`;
      bracket.style.height = `${Math.max(1, geometry.targetEnd - geometry.targetStart)}px`;
      bracket.classList.toggle('active', activeItemId === item.id);
      fragment.append(bracket);
    }
    targetBracketLayer.replaceChildren(fragment);
    targetBracketLayer.hidden = commentsState === 'hidden' || annotationsSuspended;
  };

  const calculateAnnotationLayout = (): FeedbackAnnotationLayoutResult => {
    if (!session || !editorContainer || !panel) {
      return { placements: [], clusters: [], requiredBottom: 0, eofOverflow: 0 };
    }
    const containerBounds = editorContainer.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const containerWidth = containerBounds.width || viewportWidth;
    const narrow = containerWidth <= 840;
    const cardLeft = narrow ? 12 : Math.max(12, containerWidth - 364);
    const cardWidth = narrow
      ? Math.max(1, containerWidth - 56)
      : Math.min(320, containerWidth - 56);
    const ordered = [...session.items].sort(
      (left, right) =>
        left.startOrdinal - right.startOrdinal || compareFeedbackIds(left.id, right.id)
    );
    const exactElementsById = new Map<string, HTMLElement[]>();
    Array.from(editorDom.getElementsByClassName('md4h-feedback-annotation')).forEach(element => {
      if (!(element instanceof HTMLElement)) return;
      for (const id of element.dataset.feedbackIds?.split(',') ?? []) {
        const elements = exactElementsById.get(id) ?? [];
        elements.push(element);
        exactElementsById.set(id, elements);
      }
    });
    const cardsById = new Map(
      Array.from(panel.querySelectorAll<HTMLElement>('[data-feedback-card]')).map(card => [
        card.dataset.feedbackCard ?? '',
        card,
      ])
    );
    const layoutIssues = new Map<string, FeedbackLayoutIssueState>();
    const geometryById = new Map<string, MeasuredFeedbackTarget>();
    const items = ordered.flatMap((item, sourceOrder) => {
      const targetMeasurement = measureFeedbackTarget(
        item,
        containerBounds,
        containerWidth,
        exactElementsById.get(item.id)
      );
      const geometry = targetMeasurement.value;
      if (!geometry) {
        layoutIssues.set(item.id, 'unavailable');
        return [];
      }
      if (!targetMeasurement.fresh) layoutIssues.set(item.id, 'stale');
      geometryById.set(item.id, geometry);

      const card = cardsById.get(item.id);
      const isActive = activeItemId === item.id;
      const wantsVisibleCard = !composer && commentsState === 'expanded' && (!narrow || isActive);
      let compactHeight = lastValidCardHeights.get(`${item.id}:compact`) ?? 1;
      let expandedHeight = lastValidCardHeights.get(`${item.id}:active`) ?? 1;
      let cardVisible = wantsVisibleCard;
      if (wantsVisibleCard) {
        const cardMeasurement = measureFeedbackCardHeight(
          item.id,
          isActive ? 'active' : 'compact',
          card
        );
        if (cardMeasurement.value === null) {
          layoutIssues.set(item.id, 'unavailable');
          cardVisible = false;
        } else {
          if (isActive) expandedHeight = cardMeasurement.value;
          else compactHeight = cardMeasurement.value;
          if (!cardMeasurement.fresh && layoutIssues.get(item.id) !== 'unavailable') {
            layoutIssues.set(item.id, 'stale');
          }
        }
      }
      return {
        id: item.id,
        sourceOrder,
        ...geometry,
        compactHeight,
        expandedHeight,
        cardVisible,
        ...(narrow && isActive ? { preferredCardTop: geometry.targetEnd + 12 } : {}),
      };
    });
    const editorBounds = editorDom.getBoundingClientRect();
    const targetBottom = Math.max(0, ...items.map(item => item.targetEnd));
    const documentBottom = Math.max(
      8,
      editorDom.scrollHeight,
      editorBounds.bottom - containerBounds.top,
      targetBottom
    );
    const undoStack = panel.querySelector<HTMLElement>('.feedback-undo-stack');
    const topBound = undoStack
      ? 8 + (undoStack.getBoundingClientRect().height || deletedItems.size * 36) + 8
      : 8;
    const measuredActiveId =
      activeItemId && items.some(item => item.id === activeItemId) ? activeItemId : undefined;
    const result = layoutFeedbackAnnotations({
      items,
      ...(measuredActiveId ? { activeId: measuredActiveId } : {}),
      topBound,
      documentBottom: Math.max(documentBottom, topBound),
      minimumGap: 8,
      markerDiameter: 27,
      connectorThreshold: 4,
      cardLeft,
      cardWidth,
    });
    currentAnnotationLayout = result;
    renderFallbackBrackets(ordered, geometryById);

    for (const placement of result.placements) {
      const card = cardsById.get(placement.id);
      if (!card) continue;
      card.style.top = `${placement.top}px`;
      card.style.left = `${cardLeft}px`;
      card.style.right = 'auto';
      card.style.width = `${cardWidth}px`;
    }
    const panelHeader = panel.querySelector<HTMLElement>('.feedback-panel-header');
    if (panelHeader) {
      const activePlacement = result.placements.find(placement => placement.id === activeItemId);
      panelHeader.style.top = `${activePlacement?.top ?? 8}px`;
      panelHeader.style.left = `${cardLeft + cardWidth + 4}px`;
      panelHeader.style.right = 'auto';
    }
    connectorLayer?.replaceChildren();
    if (connectorLayer) {
      connectorLayer.setAttribute('width', String(containerWidth));
      connectorLayer.setAttribute(
        'height',
        String(Math.max(documentBottom, result.requiredBottom))
      );
      if (commentsState === 'expanded' && !composer) {
        for (const placement of result.placements) {
          if (!placement.connector) continue;
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', placement.connector.path);
          path.setAttribute('data-feedback-connector', placement.id);
          connectorLayer.append(path);
        }
      }
    }
    let requiredBottom = result.requiredBottom;

    if (composer && composerTarget) {
      const targetMeasurement = measureFeedbackTarget(
        {
          id: '__composer__',
          startOrdinal: composerTarget.startOrdinal,
          endOrdinal: composerTarget.endOrdinal,
        },
        containerBounds,
        containerWidth
      );
      const geometry = targetMeasurement.value;
      if (!geometry) {
        layoutIssues.set('__composer__', 'unavailable');
      } else {
        if (!targetMeasurement.fresh) layoutIssues.set('__composer__', 'stale');
        const composerHeight = measureFeedbackCardHeight('__composer__', 'active', composer);
        if (composerHeight.value === null) {
          layoutIssues.set('__composer__', 'unavailable');
        } else {
          if (!composerHeight.fresh) layoutIssues.set('__composer__', 'stale');
          const composerTop = Math.max(8, geometry.targetY - 24);
          composer.style.top = `${composerTop}px`;
          composer.style.left = `${cardLeft}px`;
          composer.style.right = 'auto';
          composer.style.width = `${cardWidth}px`;
          requiredBottom = Math.max(requiredBottom, composerTop + composerHeight.value);
        }
      }
    }
    if (rail) rail.style.height = `${Math.max(documentBottom, requiredBottom)}px`;
    if (annotationSpacer) {
      annotationSpacer.style.height = `${Math.max(0, requiredBottom - documentBottom)}px`;
    }
    renderAnnotationLayoutAlert(layoutIssues);
    return result;
  };

  const applyMarkerPositions = (layout: FeedbackAnnotationLayoutResult): void => {
    if (!markerLayer) return;
    const clusterByMembers = new Map(
      layout.clusters.map(cluster => [canonicalClusterKey(cluster.memberIds), cluster])
    );
    markerLayer.querySelectorAll<HTMLElement>('[data-feedback-marker]').forEach(marker => {
      const ids = canonicalClusterKey(marker.dataset.feedbackIds?.split(',') ?? []);
      const cluster = clusterByMembers.get(ids);
      if (cluster) marker.style.top = `${cluster.targetY}px`;
    });
  };

  const layoutAnnotations = (): void => {
    annotationLayoutFrame = null;
    positionPendingButton();
    if (!session || annotationsSuspended) return;
    try {
      const layout = calculateAnnotationLayout();
      const renderedClusterSignature = Array.from(
        markerLayer?.querySelectorAll<HTMLElement>('[data-feedback-marker]') ?? []
      )
        .map(marker => canonicalClusterKey(marker.dataset.feedbackIds?.split(',') ?? []))
        .join('|');
      const measuredClusterSignature = layout.clusters
        .map(cluster => canonicalClusterKey(cluster.memberIds))
        .join('|');
      if (renderedClusterSignature !== measuredClusterSignature) {
        renderMarkers();
        return;
      }
      applyMarkerPositions(layout);
    } catch (error) {
      announce(
        error instanceof Error ? error.message : 'Feedback annotations could not be laid out.'
      );
    }
  };

  const scheduleAnnotationLayout = (): void => {
    if (!session || annotationsSuspended || annotationLayoutFrame !== null) return;
    annotationLayoutFrame = requestAnimationFrame(layoutAnnotations);
  };

  const scheduleLayoutAfterFontsReady = (): void => {
    const ready = document.fonts?.ready;
    if (!ready) return;
    void ready.then(
      () => scheduleAnnotationLayout(),
      () => undefined
    );
  };

  const markerAccessibleLabel = (
    ids: string[],
    itemById: ReadonlyMap<string, FeedbackItemSummary>
  ): string => {
    const items = ids
      .map(id => itemById.get(id))
      .filter((item): item is FeedbackItemSummary => item !== undefined);
    const itemSummary = (item: FeedbackItemSummary): string => {
      const focus =
        item.kind === 'text'
          ? item.focus?.trim().replace(/\s+/g, ' ') || 'text feedback'
          : 'screenshot';
      return `${item.id}, lines ${item.startLine}-${item.endLine}, ${focus.slice(0, 80)}`;
    };
    if (items.length > 1) {
      return `${items.length} comments: ${items.map(itemSummary).join('; ')}`;
    }
    const item = items[0];
    if (!item) return `Comment ${ids[0]}`;
    return `Comment ${itemSummary(item)}`;
  };

  const renderMarkers = (): void => {
    if (!markerLayer || !rail || !session) return;
    const focusedElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusedMarkerIds = focusedElement
      ?.closest<HTMLElement>('[data-feedback-marker]')
      ?.getAttribute('data-feedback-ids');
    const focusedCardId = focusedElement
      ?.closest<HTMLElement>('[data-feedback-card]')
      ?.getAttribute('data-feedback-card');
    const focusedCardAction =
      focusedCardId && focusedElement instanceof HTMLButtonElement
        ? focusedElement.textContent
        : null;
    const focusedUndoId = focusedElement
      ?.closest<HTMLElement>('[data-feedback-undo-id]')
      ?.getAttribute('data-feedback-undo-id');
    renderCards();
    // Decoration transactions are synchronous. Install the exact rendered
    // targets before measuring so the initial layout does not need a second
    // full geometry pass merely to discover their DOM.
    syncAnnotationDecorations();
    const layout = calculateAnnotationLayout();
    if (activeItemId) activeItemIds = clusterIdsForItem(activeItemId);
    const itemById = new Map(session.items.map(item => [item.id, item]));
    markerLayer.replaceChildren();
    for (const cluster of layout.clusters) {
      const ids = [...cluster.memberIds].sort(compareFeedbackIds);
      const marker = createElement(
        'button',
        'feedback-marker',
        ids.length > 1 ? String(ids.length) : ''
      );
      marker.type = 'button';
      marker.tabIndex =
        focusedMarkerIds === ids.join(',') || markerLayer.childElementCount === 0 ? 0 : -1;
      marker.setAttribute('data-feedback-marker', '');
      marker.setAttribute('data-feedback-ids', ids.join(','));
      marker.setAttribute('aria-controls', FEEDBACK_COMMENTS_PANEL_ID);
      marker.setAttribute(
        'aria-expanded',
        String(commentsState === 'expanded' && Boolean(activeItemId && ids.includes(activeItemId)))
      );
      marker.setAttribute('aria-label', markerAccessibleLabel(ids, itemById));
      if (activeItemId && ids.includes(activeItemId)) marker.classList.add('active');
      marker.style.top = `${cluster.targetY}px`;
      marker.addEventListener('keydown', event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const markers = Array.from(
          markerLayer?.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]') ?? []
        );
        const current = markers.indexOf(marker);
        const nextIndex =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? markers.length - 1
              : event.key === 'ArrowUp'
                ? Math.max(0, current - 1)
                : Math.min(markers.length - 1, current + 1);
        event.preventDefault();
        markers.forEach(
          candidate => (candidate.tabIndex = candidate === markers[nextIndex] ? 0 : -1)
        );
        markers[nextIndex]?.focus({ preventScroll: true });
      });
      marker.addEventListener('click', () => {
        if (composer) return;
        removePendingButton();
        if (commentsState === 'expanded' && activeItemId && ids.includes(activeItemId)) {
          collapseRail();
          marker.focus({ preventScroll: true });
          return;
        }
        const preferredId = ids[0];
        if (preferredId) activateFeedbackItem(preferredId, ids);
      });
      markerLayer.append(marker);
    }
    applyMarkerPositions(layout);
    syncCommentsUi();
    let restoredFocus: HTMLElement | null = null;
    if (focusedUndoId) {
      restoredFocus =
        panel?.querySelector<HTMLElement>(`[data-feedback-undo-id="${focusedUndoId}"]`) ?? null;
      restoredFocus ??=
        panel?.querySelector<HTMLElement>(`[data-feedback-card="${focusedUndoId}"]`) ?? null;
    } else if (focusedCardId) {
      const card = panel?.querySelector<HTMLElement>(`[data-feedback-card="${focusedCardId}"]`);
      restoredFocus =
        (focusedCardAction
          ? (Array.from(card?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
              button => button.textContent === focusedCardAction
            ) ?? null)
          : null) ??
        card ??
        null;
    } else if (focusedMarkerIds) {
      restoredFocus = markerLayer.querySelector<HTMLElement>(
        `[data-feedback-ids="${focusedMarkerIds}"]`
      );
      if (!restoredFocus) {
        const refreshedMarkers = Array.from(
          markerLayer.querySelectorAll<HTMLElement>('[data-feedback-ids]')
        );
        for (const priorId of focusedMarkerIds.split(',')) {
          restoredFocus =
            refreshedMarkers.find(marker =>
              marker.getAttribute('data-feedback-ids')?.split(',').includes(priorId)
            ) ?? null;
          if (restoredFocus) break;
        }
      }
    }
    restoredFocus?.focus({ preventScroll: true });
  };

  const createReviewChrome = (): void => {
    frameLabel = createElement('div', 'feedback-frame-label', 'Feedback review · snapshot saved');
    frameLabel.setAttribute('data-feedback-frame-label', '');
    frameLabel.setAttribute('role', 'status');

    rail = createElement('aside', 'feedback-comment-rail feedback-annotation-layer');
    rail.id = FEEDBACK_COMMENTS_RAIL_ID;
    rail.setAttribute('data-feedback-annotation-layer', '');
    rail.setAttribute('aria-label', 'Feedback comments');
    rail.setAttribute('aria-hidden', 'false');
    rail.setAttribute('data-feedback-comments-state', commentsState);
    markerLayer = createElement('div', 'feedback-marker-layer');
    targetBracketLayer = createElement('div', 'feedback-target-bracket-layer');
    targetBracketLayer.setAttribute('data-feedback-target-bracket-layer', '');
    targetBracketLayer.setAttribute('aria-hidden', 'true');
    connectorLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    connectorLayer.classList.add('feedback-connectors');
    connectorLayer.setAttribute('aria-hidden', 'true');
    connectorLayer.setAttribute('focusable', 'false');
    panel = createElement('section', 'feedback-comments-panel feedback-card-layer');
    panel.id = FEEDBACK_COMMENTS_PANEL_ID;
    panel.setAttribute('data-feedback-card-layer', '');
    panel.setAttribute('aria-label', 'Feedback details');
    rail.append(targetBracketLayer, connectorLayer, markerLayer, panel);

    annotationSpacer = createElement('div', 'feedback-annotation-spacer');
    annotationSpacer.setAttribute('data-feedback-annotation-spacer', '');
    annotationSpacer.setAttribute('aria-hidden', 'true');

    liveRegion = createElement('div', 'feedback-live-region');
    liveRegion.setAttribute('aria-live', 'polite');
    liveRegion.setAttribute('aria-atomic', 'true');

    const shell = editorContainer?.parentElement ?? editorDom.parentElement;
    editorContainer?.classList.add('feedback-review-surface');
    editorContainer?.append(rail, annotationSpacer);
    shell?.append(frameLabel, liveRegion);
  };

  const handleSelectionChange = (): void => {
    removePendingButton();
    if (!hasWritableSession() || !session || composer) return;
    const target = getFeedbackSelectionTarget(editor, session.anchors ?? []);
    if (!target) return;

    const nativeSelection = window.getSelection();
    if (nativeSelection && nativeSelection.rangeCount > 0) {
      try {
        const range = nativeSelection.getRangeAt(0);
        pendingSelectionRange = typeof range.cloneRange === 'function' ? range.cloneRange() : range;
      } catch {
        pendingSelectionRange = null;
      }
    }
    pendingButtonTarget = target;
    pendingButton = createElement('button', 'feedback-selection-action') as HTMLButtonElement;
    pendingButton.type = 'button';
    pendingButton.title = 'Add feedback';
    pendingButton.setAttribute('aria-label', 'Add feedback to selected text');
    pendingButton.setAttribute('data-feedback-selection-action', '');
    const icon = createElement('span', 'codicon codicon-comment-discussion-sparkle');
    icon.setAttribute('aria-hidden', 'true');
    pendingButton.append(icon);
    const preserveSelection = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    pendingButton.addEventListener('pointerdown', preserveSelection);
    pendingButton.addEventListener('mousedown', preserveSelection);
    pendingButton.addEventListener('click', () => {
      controller.openTextComposer(target);
    });
    editorContainer?.append(pendingButton);
    positionPendingButton();
  };

  const guardMutation = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const closeTextBlockSelector = (restoreFocus = true): void => {
    const focusTarget = blockSelectorReturnFocus;
    blockSelectorDraftSurface?.release();
    blockSelectorDraftSurface = null;
    blockSelector?.remove();
    blockSelector = null;
    blockSelectorReturnFocus = null;
    if (restoreFocus && focusTarget?.isConnected) {
      focusTarget.focus({ preventScroll: true });
    }
  };

  const openTextBlockSelector = (): boolean => {
    if (!hasWritableSession() || !session?.anchors?.length) return false;
    if (draftSurfaceGate.focusActive()) return true;
    if (blockSelector?.isConnected) {
      blockSelector.querySelector<HTMLElement>('select, button')?.focus({
        preventScroll: true,
      });
      return true;
    }
    const anchors = session.anchors;
    blockSelectorReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = createElement('form', 'feedback-block-selector');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('data-md4h-modal', '');
    dialog.setAttribute('data-feedback-text-block-selector', '');
    const title = createElement('h2', '', 'Choose blocks for feedback');
    title.id = 'feedback-text-block-selector-title';
    dialog.setAttribute('aria-labelledby', title.id);
    const start = document.createElement('select');
    const end = document.createElement('select');
    const startLabel = createElement('label', '', 'First block');
    const endLabel = createElement('label', '', 'Last block');
    startLabel.append(start);
    endLabel.append(end);
    for (const anchor of anchors) {
      const label = `Block ${anchor.ordinal + 1}, lines ${anchor.startLine}-${anchor.endLine}`;
      start.add(new Option(label, String(anchor.ordinal)));
      end.add(new Option(label, String(anchor.ordinal)));
    }
    end.selectedIndex = end.options.length - 1;
    const actions = createElement('div', 'feedback-composer-actions');
    const cancel = createElement('button', 'feedback-secondary-button', 'Cancel');
    cancel.type = 'button';
    const submit = createElement('button', 'feedback-primary-button', 'Add feedback');
    submit.type = 'submit';
    actions.append(cancel, submit);
    dialog.append(title, startLabel, endLabel, actions);
    const lease = draftSurfaceGate.claim({
      kind: 'text-block-selector',
      element: dialog,
      focus: () =>
        dialog.querySelector<HTMLElement>('select, button')?.focus({ preventScroll: true }),
    });
    if (!lease) {
      blockSelectorReturnFocus = null;
      return true;
    }
    blockSelector = dialog;
    blockSelectorDraftSurface = lease;

    const close = (): void => {
      if (blockSelector === dialog) closeTextBlockSelector();
      else dialog.remove();
    };
    cancel.addEventListener('click', close);
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('select, button'));
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && currentIndex <= 0) {
        event.preventDefault();
        focusable[focusable.length - 1]?.focus();
      } else if (!event.shiftKey && currentIndex === focusable.length - 1) {
        event.preventDefault();
        focusable[0]?.focus();
      }
    });
    dialog.addEventListener('submit', event => {
      event.preventDefault();
      const first = Math.min(Number(start.value), Number(end.value));
      const last = Math.max(Number(start.value), Number(end.value));
      const firstAnchor = anchors.find(anchor => anchor.ordinal === first);
      const lastAnchor = anchors.find(anchor => anchor.ordinal === last);
      const focus = feedbackFocusForBlockRange(editor, first, last);
      if (!firstAnchor || !lastAnchor || focus.trim().length === 0) return;
      close();
      controller.openTextComposer({
        startOrdinal: first,
        endOrdinal: last,
        focus,
        startLine: firstAnchor.startLine,
        endLine: lastAnchor.endLine,
      });
    });
    document.body.append(dialog);
    start.focus();
    return true;
  };

  const handleSavedAnnotationClick = (event: MouseEvent): void => {
    if (!session || composer || commentsState === 'hidden') return;
    const target =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('.md4h-feedback-annotation')
        : null;
    if (!target || !editorDom.contains(target)) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) return;
    const ids = target.dataset.feedbackIds?.split(',').filter(Boolean) ?? [];
    if (ids.length === 0) return;
    const marker = Array.from(
      markerLayer?.querySelectorAll<HTMLButtonElement>('[data-feedback-marker]') ?? []
    ).find(candidate => candidate.dataset.feedbackIds?.split(',').some(id => ids.includes(id)));
    const preferredId = ids[0];
    if (!marker || !preferredId) return;
    activateFeedbackItem(preferredId, marker.dataset.feedbackIds?.split(',').filter(Boolean));
  };

  const focusDraftSurfaceBefore = (action: string): boolean => {
    const kind = draftSurfaceGate.activeKind();
    if (!kind || !draftSurfaceGate.focusActive()) return false;
    const instruction =
      kind === 'finish-checkpoint'
        ? 'Resume feedback or finish the current completion step'
        : kind === 'text-composer'
          ? 'Add or cancel the current feedback'
          : kind === 'text-block-selector'
            ? 'Choose a text block range or cancel'
            : 'Complete or cancel the current capture';
    announce(`${instruction} before ${action}.`);
    return true;
  };

  const focusModalSurfaceBefore = (action: string): boolean => {
    const activeModal = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-md4h-modal], [role="dialog"][aria-modal="true"], .math-editor-overlay'
      )
    )
      .filter(
        candidate =>
          candidate.isConnected &&
          !candidate.hidden &&
          candidate.getAttribute('aria-hidden') !== 'true'
      )
      .at(-1);
    if (!activeModal) return false;

    const currentFocus =
      document.activeElement instanceof HTMLElement && activeModal.contains(document.activeElement)
        ? document.activeElement
        : null;
    if (!focusElementWithoutScroll(currentFocus)) {
      const focusable = completionFocusableElements(activeModal);
      const focusedControl = focusable.some(candidate => focusElementWithoutScroll(candidate));
      if (!focusedControl) focusElementWithoutScroll(activeModal);
    }
    announce(`Complete or close the active dialog before ${action}.`);
    return true;
  };

  const controller: FeedbackReviewController = {
    draftSurfaceGate,

    start() {
      if (completionDialog?.isConnected) {
        focusElementWithoutScroll(
          completionDialog.querySelector<HTMLElement>('[data-feedback-completion-done]') ??
            completionDialog
        );
        return;
      }
      if (session || startRequestId) return;
      let blocks: CanonicalFeedbackBlock[];
      try {
        blocks = enumerateCanonicalFeedbackBlocks(editor);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Cannot enumerate rendered blocks';
        window.dispatchEvent(new CustomEvent('feedbackLocalError', { detail: { message } }));
        return;
      }
      rememberTransitionFocus();
      startRequestId = nextRequestId();
      setReadOnly(true);
      document.body.classList.add('feedback-review-starting');
      setFeedbackToolbarState({ active: false, starting: true });
      post({ type: 'feedback.start', requestId: startRequestId, blocks });
    },

    activate(nextSession) {
      if (session) controller.deactivate();
      removeCompletionDialog(false);
      pendingFinishRequestId = null;
      sealedCompletionSummary = null;
      draftSurfaceGate.clear();
      const resumeHadFocus = Boolean(
        draftBanner?.contains(document.activeElement) &&
        document.activeElement instanceof HTMLElement &&
        document.activeElement.matches('[data-feedback-draft-resume]')
      );
      availableDrafts = [];
      removeDraftBanner();
      deletedItems.clear();
      requestedUndoFocusId = null;
      lastValidTargetGeometry.clear();
      lastValidCardHeights.clear();
      clearAnnotationLayoutAlert();
      session = { ...nextSession, items: [...nextSession.items] };
      startRequestId = null;
      pendingClose = null;
      restoreEditorFocusAfterClose = false;
      pendingTransitionRecovery = null;
      transitionReturnFocus = null;
      document.body.classList.remove('feedback-review-starting');
      invalidated = false;
      commentsState = 'collapsed';
      activeItemIds = null;
      activeItemId = null;
      annotationsSuspended = false;
      captureState = 'idle';
      refreshFeedbackBlockPositions();
      setReadOnly(true);
      document.body.classList.add('feedback-review-active');
      const dynamicEditor = editor as Editor & {
        registerPlugin?: Editor['registerPlugin'];
        unregisterPlugin?: Editor['unregisterPlugin'];
      };
      if (
        typeof dynamicEditor.registerPlugin === 'function' &&
        typeof dynamicEditor.unregisterPlugin === 'function'
      ) {
        annotationController = createFeedbackAnnotationController(editor);
        annotationController.register();
      }
      createReviewChrome();
      editorDom.addEventListener('click', handleSavedAnnotationClick);
      renderMarkers();
      scheduleLayoutAfterFontsReady();
      annotationResizeObserver?.observe(editorDom);
      if (panel) annotationResizeObserver?.observe(panel);
      if (resumeHadFocus) {
        document.querySelector<HTMLButtonElement>('[data-feedback-finish]')?.focus({
          preventScroll: true,
        });
      }
      announce('Feedback review started. Snapshot saved.');
    },

    deactivate() {
      if (!session && !readOnlyApplied) {
        removeCompletionDialog(false);
        pendingFinishRequestId = null;
        sealedCompletionSummary = null;
        draftSurfaceGate.clear();
        deletedItems.clear();
        setReadOnly(false);
        document.body.removeAttribute('data-feedback-comments-state');
        return;
      }
      window.dispatchEvent(new CustomEvent(FEEDBACK_SESSION_ENDED_EVENT));
      const focusWasInReviewChrome = Boolean(
        document.activeElement instanceof HTMLElement &&
        (rail?.contains(document.activeElement) ||
          blockSelector?.contains(document.activeElement) ||
          completionDialog?.contains(document.activeElement) ||
          document.activeElement.matches('[data-feedback-action]'))
      );
      for (const pending of pendingMutations.values()) {
        if (pending.kind === 'screenshot') {
          pending.reject(new Error('The feedback session ended before the write completed.'));
        }
      }
      pendingMutations.clear();
      closeTextBlockSelector(false);
      closeComposer(false);
      removeCompletionDialog(false);
      draftSurfaceGate.clear();
      deletedItems.clear();
      requestedUndoFocusId = null;
      editorDom.removeEventListener('click', handleSavedAnnotationClick);
      removePendingButton();
      alertElement?.remove();
      alertElement = null;
      removeSyncRetryAlert();
      clearAnnotationAnchorAlert();
      clearAnnotationLayoutAlert();
      frameLabel?.remove();
      rail?.remove();
      annotationSpacer?.remove();
      liveRegion?.remove();
      editorContainer?.classList.remove('feedback-review-surface');
      frameLabel = null;
      rail = null;
      markerLayer = null;
      targetBracketLayer = null;
      panel = null;
      connectorLayer = null;
      annotationSpacer = null;
      liveRegion = null;
      if (annotationLayoutFrame !== null) {
        cancelAnimationFrame(annotationLayoutFrame);
        annotationLayoutFrame = null;
      }
      annotationController?.clear();
      annotationController?.unregister();
      annotationController = null;
      currentAnnotationLayout = null;
      lastValidTargetGeometry.clear();
      lastValidCardHeights.clear();
      feedbackBlockPositions = [];
      annotationsSuspended = false;
      captureState = 'idle';
      unresolvedRenderedRangeIds = new Set();
      blockFallbackBracketIds = new Set();
      setReadOnly(false);
      session = null;
      startRequestId = null;
      pendingClose = null;
      pendingFinishRequestId = null;
      sealedCompletionSummary = null;
      restoreEditorFocusAfterClose = false;
      pendingTransitionRecovery = null;
      transitionReturnFocus = null;
      invalidated = false;
      document.body.classList.remove(
        'feedback-review-active',
        'feedback-review-starting',
        'feedback-capture-active'
      );
      document.body.removeAttribute('data-feedback-comments-state');
      document.body.removeAttribute('data-feedback-capture-state');
      commentsState = 'collapsed';
      activeItemIds = null;
      activeItemId = null;
      setFeedbackToolbarState({ active: false });
      if (focusWasInReviewChrome && editorDom.isConnected) {
        editorDom.focus({ preventScroll: true });
      }
    },

    invalidate(code) {
      if (!session) return;
      invalidated = true;
      clearAnnotationAnchorAlert();
      clearAnnotationLayoutAlert();
      window.dispatchEvent(new CustomEvent('feedbackInvalidated', { detail: { code } }));
      if (composer) {
        const field = composer.querySelector<HTMLTextAreaElement>('[data-feedback-input]');
        const submit = composer.querySelector<HTMLButtonElement>('[data-feedback-submit]');
        if (field) field.readOnly = true;
        if (submit) submit.disabled = true;
        setCommentsState('expanded');
      } else {
        collapseRail();
      }
      closeTextBlockSelector(false);
      removePendingButton();
      alertElement?.remove();
      alertElement = createElement(
        'div',
        'feedback-invalidated-alert',
        `The source changed outside this feedback snapshot (${code}). The draft is preserved. Reveal or discard it, then start a new session.`
      );
      alertElement.setAttribute('role', 'alert');
      alertElement.tabIndex = -1;
      frameLabel?.after(alertElement);
      renderCards();
      syncCommentsUi();
      updateCompletionCheckpoint(
        pendingFinishRequestId === null && pendingClose === null
          ? 'The source changed outside this snapshot. Resume to reveal or discard the preserved draft.'
          : 'The source changed while finishing. Waiting for the locked operation to stop safely.'
      );
      if (completionDialog) {
        focusElementWithoutScroll(
          completionResumeButton?.isConnected ? completionResumeButton : completionDialog
        );
      } else {
        alertElement.focus({ preventScroll: true });
      }
    },

    updateItems(items) {
      if (!session) return;
      session.items = [...items];
      const liveIds = new Set(items.map(item => item.id));
      for (const id of lastValidTargetGeometry.keys()) {
        if (id !== '__composer__' && !liveIds.has(id)) lastValidTargetGeometry.delete(id);
      }
      for (const key of lastValidCardHeights.keys()) {
        const id = key.slice(0, key.lastIndexOf(':'));
        if (id !== '__composer__' && !liveIds.has(id)) lastValidCardHeights.delete(key);
      }
      let focusUndoAfterRender = requestedUndoFocusId;
      requestedUndoFocusId = null;
      if (activeItemIds) {
        const clusterAnchorId =
          (activeItemId && items.some(item => item.id === activeItemId)
            ? activeItemId
            : activeItemIds.find(id => items.some(item => item.id === id))) ?? null;
        if (!composer && !clusterAnchorId) {
          clearActiveComment();
          if (deletedItems.size > 0) {
            setCommentsState('expanded');
            focusUndoAfterRender ??= Array.from(deletedItems.keys()).at(-1) ?? null;
          } else {
            collapseRail();
          }
        } else if (clusterAnchorId) {
          // The next render recomputes visual proximity/overlap clusters from
          // fresh geometry. Preserve only a surviving anchor until then.
          activeItemId = clusterAnchorId;
          activeItemIds = [clusterAnchorId];
          if (commentsState === 'expanded') markActiveItems(activeItemId ? [activeItemId] : []);
        }
      } else if (!composer && items.length === 0 && deletedItems.size > 0) {
        setCommentsState('expanded');
        focusUndoAfterRender ??= Array.from(deletedItems.keys()).at(-1) ?? null;
      }
      for (const item of items) {
        deletedItems.delete(item.id);
      }
      if (
        completionDialog?.getAttribute('data-feedback-completion-state') === 'confirm' &&
        pendingFinishRequestId === null
      ) {
        updateCompletionCheckpoint();
      }
      renderMarkers();
      if (focusUndoAfterRender) {
        panel
          ?.querySelector<HTMLButtonElement>(`[data-feedback-undo-id="${focusUndoAfterRender}"]`)
          ?.focus({ preventScroll: true });
      }
      announce(`${items.length} feedback ${items.length === 1 ? 'comment' : 'comments'} saved.`);
    },

    openTextComposer(target) {
      if (!hasWritableSession() || !session || !rail || !panel) return;
      if (draftSurfaceGate.focusActive()) {
        announce('Finish or cancel the current feedback action before opening another.');
        return;
      }
      if (composer) {
        setCommentsState('expanded');
        composer.querySelector<HTMLTextAreaElement>('[data-feedback-input]')?.focus({
          preventScroll: true,
        });
        announce('Add or cancel the current feedback before choosing another target.');
        return;
      }
      const invokingElement =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const durableReturnTarget = invokingElement?.matches('[data-feedback-selection-action]')
        ? editorDom
        : invokingElement;
      closeComposer(false);
      lastValidTargetGeometry.delete('__composer__');
      lastValidCardHeights.delete('__composer__:active');
      composerTarget = target;
      markPendingTarget(target);
      restoreFocusTo = durableReturnTarget?.isConnected ? durableReturnTarget : editorDom;
      const composerElement = createElement('form', 'feedback-composer');
      const field = createElement('textarea', 'feedback-composer-input') as HTMLTextAreaElement;
      const draftSurface = draftSurfaceGate.claim({
        kind: 'text-composer',
        element: composerElement,
        focus: () => {
          setCommentsState('expanded');
          field.focus({ preventScroll: true });
        },
      });
      if (!draftSurface) return;
      composerDraftSurface = draftSurface;
      const composerSessionId = session.sessionId;
      let pendingRequestId: string | null = null;
      composer = composerElement;
      syncAnnotationDecorations();
      setCommentsState('expanded');
      composerElement.setAttribute('aria-label', 'Add feedback');

      const heading = createElement('h2', 'feedback-composer-title', 'What should change?');
      const focusLabel = createElement('div', 'feedback-composer-label', 'Exact visible focus');
      const focus = createElement('blockquote', 'feedback-composer-focus', target.focus);
      focus.setAttribute('data-feedback-focus', '');
      const lines = createElement(
        'div',
        'feedback-composer-lines',
        target.startLine > 0
          ? `Source lines ${target.startLine}-${target.endLine}`
          : 'Source lines validated when saved'
      );
      lines.setAttribute('data-feedback-lines', '');
      const label = createElement('label', 'feedback-composer-label', 'Feedback');
      field.required = true;
      field.rows = 5;
      field.setAttribute('data-feedback-input', '');
      label.append(field);
      const actions = createElement('div', 'feedback-composer-actions');
      const cancel = createElement('button', 'feedback-secondary-button', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => closeComposer());
      const submit = createElement('button', 'feedback-primary-button', 'Add feedback');
      submit.type = 'submit';
      submit.disabled = true;
      submit.setAttribute('data-feedback-submit', '');
      field.addEventListener('input', () => {
        submit.disabled =
          field.value.trim().length === 0 || pendingRequestId !== null || !hasWritableSession();
      });
      composerElement.addEventListener('submit', event => {
        event.preventDefault();
        const feedback = field.value.trim();
        if (
          !hasWritableSession() ||
          !session ||
          !feedback ||
          pendingRequestId !== null ||
          composer !== composerElement ||
          session.sessionId !== composerSessionId
        ) {
          return;
        }
        const requestId = nextRequestId();
        pendingRequestId = requestId;
        submit.disabled = true;
        pendingMutations.set(requestId, {
          kind: 'text-add',
          form: composerElement,
          field,
          submit,
          settle: () => {
            pendingRequestId = null;
          },
        });
        post({
          type: 'feedback.text.add',
          requestId,
          sessionId: session.sessionId,
          startOrdinal: target.startOrdinal,
          endOrdinal: target.endOrdinal,
          focus: target.focus,
          feedback,
          ...(target.renderedRange ? { renderedRange: target.renderedRange } : {}),
        });
      });
      actions.append(cancel, submit);
      composerElement.append(heading, focusLabel, focus, lines, label, actions);
      panel.replaceChildren(composerElement);
      annotationResizeObserver?.observe(composerElement);
      scheduleAnnotationLayout();
      // The composer is absolutely positioned on the next animation frame.
      // Native focus scrolling before that layout can treat it as a top-of-
      // document element and jump a deeply scrolled review back to the start.
      field.focus({ preventScroll: true });
    },

    commentOnSelection() {
      if (!hasWritableSession() || !session) return false;
      const target = getFeedbackSelectionTarget(editor, session.anchors ?? []);
      if (!target) return openTextBlockSelector();
      controller.openTextComposer(target);
      return true;
    },

    toggleComments(force) {
      if (!session || !rail) return;
      if (focusDraftSurfaceBefore('changing comment visibility')) return;
      const wantsVisible = force ?? commentsState === 'hidden';
      if (composer && !wantsVisible) {
        setCommentsState('expanded');
        composer.querySelector<HTMLTextAreaElement>('[data-feedback-input]')?.focus({
          preventScroll: true,
        });
        announce('Add or cancel this feedback before hiding comments.');
        return;
      }
      if (!wantsVisible) {
        const focusWasInsideRail =
          document.activeElement instanceof HTMLElement && rail.contains(document.activeElement);
        clearActiveComment();
        setCommentsState('hidden');
        if (focusWasInsideRail) {
          const commentsControl = document.querySelector<HTMLButtonElement>(
            '[data-feedback-comments]'
          );
          (commentsControl ?? editorDom).focus({ preventScroll: true });
        }
        return;
      }
      const revealState =
        commentsState === 'hidden' && deletedItems.size > 0 && session.items.length === 0
          ? 'expanded'
          : commentsState === 'hidden'
            ? 'collapsed'
            : commentsState;
      setCommentsState(revealState);
      scheduleAnnotationLayout();
    },

    navigateFeedback(direction) {
      if (!session || session.items.length === 0) return;
      if (focusDraftSurfaceBefore('navigating comments')) return;
      if (focusModalSurfaceBefore('navigating comments')) return;
      const ordered = [...session.items].sort(
        (left, right) =>
          left.startOrdinal - right.startOrdinal || compareFeedbackIds(left.id, right.id)
      );
      const currentIndex = activeItemId ? ordered.findIndex(item => item.id === activeItemId) : -1;
      const nextIndex =
        direction === 'next'
          ? currentIndex < 0
            ? 0
            : (currentIndex + 1) % ordered.length
          : currentIndex < 0
            ? ordered.length - 1
            : (currentIndex - 1 + ordered.length) % ordered.length;
      const item = ordered[nextIndex];
      if (!item) return;
      activateFeedbackItem(item.id);
      const exactTarget = Array.from(
        editorDom.querySelectorAll<HTMLElement>('[data-feedback-ids]')
      ).find(element => element.dataset.feedbackIds?.split(',').includes(item.id));
      const target =
        exactTarget ?? (editorDom.children.item(item.startOrdinal) as HTMLElement | null);
      target?.scrollIntoView({ behavior: 'auto', block: 'center' });
      panel
        ?.querySelector<HTMLElement>(`[data-feedback-card="${item.id}"]`)
        ?.focus({ preventScroll: true });
    },

    finish() {
      if (completionDialog?.isConnected) {
        focusElementWithoutScroll(
          completionDialog.querySelector<HTMLElement>('[data-feedback-completion-resume]') ??
            completionDialog.querySelector<HTMLElement>('[data-feedback-completion-done]') ??
            completionDialog
        );
        return;
      }
      if (!hasWritableSession() || !session) return;
      if (draftSurfaceGate.focusActive()) {
        announce('Add or cancel the current feedback before finishing.');
        return;
      }
      if (blockSelector) {
        blockSelector.querySelector<HTMLElement>('select, button')?.focus({
          preventScroll: true,
        });
        announce('Choose blocks or cancel before finishing.');
        return;
      }
      if (composer) {
        setCommentsState('expanded');
        composer.querySelector<HTMLTextAreaElement>('[data-feedback-input]')?.focus({
          preventScroll: true,
        });
        announce('Add or cancel the current feedback before finishing.');
        return;
      }
      openCompletionCheckpoint();
    },

    reveal() {
      if (!session) return;
      post({
        type: 'feedback.reveal',
        requestId: nextRequestId(),
        sessionId: session.sessionId,
      });
    },

    discard() {
      if (!hasWritableSession() || !session) return;
      if (draftSurfaceGate.focusActive()) {
        announce('Add or cancel the current feedback before discarding this draft.');
        return;
      }
      post({
        type: 'feedback.discard',
        requestId: nextRequestId(),
        sessionId: session.sessionId,
      });
    },

    copyDiagnostics() {
      if (!session) return;
      post({
        type: 'feedback.copyDiagnostics',
        requestId: nextRequestId(),
        sessionId: session.sessionId,
      });
    },

    reportCaptureError(code) {
      if (!session) return;
      post({
        type: 'feedback.capture.error',
        requestId: nextRequestId(),
        sessionId: session.sessionId,
        code,
      });
    },

    setCaptureState(nextState) {
      if (captureState === nextState) return;
      captureState = nextState;
      if (session) syncCommentsUi();
      if (nextState === 'armed') {
        announce('Capture area ready. Drag over the visible document. Press Escape to cancel.');
      }
    },

    setAnnotationsSuspended(suspended) {
      if (!session || annotationsSuspended === suspended) return;
      annotationsSuspended = suspended;
      rail?.toggleAttribute('data-feedback-annotations-suspended', suspended);
      if (targetBracketLayer) {
        targetBracketLayer.hidden = suspended || commentsState === 'hidden';
      }
      if (suspended) {
        if (annotationLayoutFrame !== null) {
          cancelAnimationFrame(annotationLayoutFrame);
          annotationLayoutFrame = null;
        }
        annotationController?.suspend();
        return;
      }
      syncAnnotationDecorations();
      scheduleAnnotationLayout();
    },

    addScreenshotFeedback(input) {
      if (!hasWritableSession() || !session) {
        return Promise.reject(new Error('The feedback session is not writable.'));
      }
      const requestId = nextRequestId();
      const completion = new Promise<void>((resolve, reject) => {
        pendingMutations.set(requestId, { kind: 'screenshot', resolve, reject });
      });
      if (input.replaceId) {
        post({
          type: 'feedback.screenshot.replace',
          requestId,
          sessionId: session.sessionId,
          id: input.replaceId,
          startOrdinal: input.startOrdinal,
          endOrdinal: input.endOrdinal,
          imageDataUrl: input.imageDataUrl,
          feedback: input.feedback,
        });
        return completion;
      }
      post({
        type: 'feedback.screenshot.add',
        requestId,
        sessionId: session.sessionId,
        startOrdinal: input.startOrdinal,
        endOrdinal: input.endOrdinal,
        imageDataUrl: input.imageDataUrl,
        feedback: input.feedback,
      });
      return completion;
    },

    applyTransitionSync(message, applyContent) {
      if (session) return false;
      if (!pendingTransitionRecovery) {
        if (startRequestId !== null && startRequestId !== message.requestId) return false;
        pendingTransitionRecovery = {
          requestId: message.requestId,
          lockId: message.lockId,
          appliedRevision: 0,
          latestRevision: 0,
        };
        if (!readOnlyApplied) setReadOnly(true);
      }
      if (
        pendingTransitionRecovery.requestId !== message.requestId ||
        pendingTransitionRecovery.lockId !== message.lockId ||
        message.revision <= pendingTransitionRecovery.appliedRevision ||
        (message.revision !== pendingTransitionRecovery.latestRevision &&
          message.revision !== pendingTransitionRecovery.latestRevision + 1)
      ) {
        return false;
      }
      pendingTransitionRecovery.latestRevision = message.revision;
      const retryHadFocus = removeSyncRetryAlert();
      unregisterReadOnlyPlugin();
      let applied = false;
      try {
        applied = applyContent(message.content) === true;
      } catch (error) {
        console.error('[MD4H] Feedback transition synchronization failed:', error);
      }
      registerReadOnlyPlugin();
      if (!applied) {
        renderSyncRetryAlert(
          'transition',
          'The latest Markdown source could not be restored. Feedback remains read-only.',
          () => {
            if (!pendingTransitionRecovery) return;
            post({
              type: 'feedback.transition.retry',
              requestId: pendingTransitionRecovery.requestId,
              lockId: pendingTransitionRecovery.lockId,
              revision: pendingTransitionRecovery.latestRevision,
            });
          }
        );
        return false;
      }
      if (retryHadFocus) editorDom.focus({ preventScroll: true });
      pendingTransitionRecovery.appliedRevision = message.revision;
      post({
        type: 'feedback.transition.applied',
        requestId: message.requestId,
        lockId: message.lockId,
        revision: message.revision,
      });
      return true;
    },

    applyCloseSync(message, applyContent) {
      if (
        !session ||
        !pendingClose ||
        pendingClose.requestId !== message.requestId ||
        pendingClose.sessionId !== message.sessionId ||
        session.sessionId !== message.sessionId ||
        message.revision <= pendingClose.appliedRevision ||
        message.revision !== pendingClose.latestRevision + 1
      ) {
        return false;
      }

      pendingClose.latestRevision = message.revision;
      pendingClose.releaseRevision = undefined;
      const retryHadFocus = removeSyncRetryAlert();

      // TipTap's transaction filter must stand down for the one host-owned
      // replacement. Keep aria-readonly, beforeinput/drop/cut/paste guards,
      // NodeView guards, and the review toolbar active until it succeeds.
      unregisterReadOnlyPlugin();
      let applied = false;
      try {
        applied = applyContent(message.content) === true;
      } catch (error) {
        console.error('[MD4H] Feedback close synchronization failed:', error);
      }
      if (!applied) {
        if (sealedCompletionSummary && completionDialog) {
          // The existing close-retry alert must own focus while synchronization
          // is blocked. Preserve the sealed summary so the result can return
          // after a later correlated release.
          removeCompletionDialog(false);
        }
        registerReadOnlyPlugin();
        renderSyncRetryAlert(
          'close',
          'The latest Markdown source could not be restored. Feedback remains read-only.',
          () => {
            if (!pendingClose) return;
            post({
              type: 'feedback.close.retry',
              requestId: pendingClose.requestId,
              sessionId: pendingClose.sessionId,
              revision: pendingClose.latestRevision,
            });
          }
        );
        return false;
      }

      registerReadOnlyPlugin();
      if (retryHadFocus) editorDom.focus({ preventScroll: true });
      pendingClose.appliedRevision = message.revision;
      pendingClose.releaseRevision = undefined;
      post({
        type: 'feedback.close.applied',
        requestId: pendingClose.requestId,
        sessionId: pendingClose.sessionId,
        revision: message.revision,
      });
      return true;
    },

    completeClose(lockId) {
      if (
        !session ||
        !pendingClose ||
        pendingClose.sessionId !== lockId ||
        pendingClose.releaseRevision === undefined ||
        pendingClose.releaseRevision !== pendingClose.appliedRevision
      ) {
        return false;
      }
      const shouldRestoreEditorFocus = restoreEditorFocusAfterClose;
      const completion = sealedCompletionSummary;
      controller.deactivate();
      if (completion) {
        showSealedCompletion(completion);
      } else if (shouldRestoreEditorFocus && editorDom.isConnected) {
        editorDom.focus({ preventScroll: true });
      }
      return true;
    },

    completeTransition(lockId) {
      if (session || !pendingTransitionRecovery || pendingTransitionRecovery.lockId !== lockId) {
        return false;
      }
      pendingTransitionRecovery = null;
      const retryHadFocus = removeSyncRetryAlert();
      startRequestId = null;
      setReadOnly(false);
      document.body.classList.remove('feedback-review-starting');
      setFeedbackToolbarState({ active: false, starting: false });
      setDraftBannerBusy(false);
      if (retryHadFocus) {
        transitionReturnFocus = null;
        editorDom.focus({ preventScroll: true });
      } else {
        restoreTransitionFocus();
      }
      return true;
    },

    handleHostMessage(message) {
      const requiresActiveSession =
        message.type === 'feedback.updated' ||
        message.type === 'feedback.invalidated' ||
        message.type === 'feedback.finished' ||
        message.type === 'feedback.discarded' ||
        message.type === 'feedback.close.release' ||
        message.type === 'feedback.diagnosticsCopied';
      if (requiresActiveSession && (!session || message.sessionId !== session.sessionId)) return;
      if (
        message.type === 'feedback.error' &&
        ((session !== null && message.sessionId !== session.sessionId) ||
          (session === null && message.sessionId !== undefined))
      ) {
        return;
      }

      switch (message.type) {
        case 'feedback.drafts.available':
          if (!session && !startRequestId && !completionDialog) renderDraftBanner(message.drafts);
          break;
        case 'feedback.started':
          if (session || message.requestId !== startRequestId) break;
          controller.activate({
            sessionId: message.sessionId,
            source: message.source,
            sourceSha256: message.sourceSha256,
            round: message.round,
            feedbackFile: message.feedbackFile,
            anchors: message.anchors,
            items: message.items,
          });
          break;
        case 'feedback.transition.locked':
          if (
            session ||
            startRequestId !== message.requestId ||
            (pendingTransitionRecovery !== null &&
              (pendingTransitionRecovery.requestId !== message.requestId ||
                pendingTransitionRecovery.lockId !== message.lockId))
          ) {
            break;
          }
          pendingTransitionRecovery = {
            requestId: message.requestId,
            lockId: message.lockId,
            appliedRevision: pendingTransitionRecovery?.appliedRevision ?? 0,
            latestRevision: pendingTransitionRecovery?.latestRevision ?? 0,
          };
          setReadOnly(true);
          document.body.classList.add('feedback-review-starting');
          break;
        case 'feedback.updated':
          {
            const pending = pendingMutations.get(message.requestId);
            if (pending?.kind === 'screenshot') {
              pending.resolve();
            } else if (pending?.kind === 'text-add') {
              pending.settle();
              if (composer === pending.form) closeComposer();
            } else if (
              pending?.kind === 'delete' &&
              !message.items.some(item => item.id === pending.item.id)
            ) {
              deletedItems.set(pending.item.id, pending.item);
              requestedUndoFocusId = pending.item.id;
            } else if (
              pending?.kind === 'restore' &&
              message.items.some(item => item.id === pending.id)
            ) {
              activeItemIds = [pending.id];
              activeItemId = pending.id;
              commentsState = 'expanded';
            }
          }
          pendingMutations.delete(message.requestId);
          controller.updateItems(message.items);
          break;
        case 'feedback.invalidated':
          controller.invalidate(message.code);
          break;
        case 'feedback.finished': {
          if (pendingClose) break;
          if (pendingFinishRequestId === null || message.requestId !== pendingFinishRequestId) {
            break;
          }
          sealedCompletionSummary = {
            feedbackFile: message.feedbackFile,
            itemCount: message.itemCount,
            prompt: message.prompt,
            promptCopied: message.promptCopied,
          };
          pendingFinishRequestId = null;
          completionDialog?.setAttribute('data-feedback-completion-state', 'finishing');
          completionDialog?.setAttribute('aria-busy', 'true');
          const completionStatus = completionDialog?.querySelector<HTMLElement>(
            '[data-feedback-completion-status]'
          );
          if (completionStatus) {
            completionStatus.textContent = 'Feedback locked. Restoring the latest source…';
          }
          restoreEditorFocusAfterClose = Boolean(
            document.activeElement instanceof HTMLElement &&
            (rail?.contains(document.activeElement) ||
              document.activeElement.matches('[data-feedback-action]'))
          );
          pendingClose = {
            requestId: message.requestId,
            sessionId: message.sessionId,
            appliedRevision: 0,
            latestRevision: 0,
          };
          renderCards();
          syncCommentsUi();
          announce('Feedback bundle sealed. Restoring the latest source before editing resumes.');
          post({
            type: 'feedback.close.ready',
            requestId: message.requestId,
            sessionId: message.sessionId,
          });
          break;
        }
        case 'feedback.discarded':
          removeDraftBanner();
          if (pendingClose) break;
          restoreEditorFocusAfterClose = Boolean(
            document.activeElement instanceof HTMLElement &&
            (rail?.contains(document.activeElement) ||
              document.activeElement.matches('[data-feedback-action]'))
          );
          pendingClose = {
            requestId: message.requestId,
            sessionId: message.sessionId,
            appliedRevision: 0,
            latestRevision: 0,
          };
          renderCards();
          syncCommentsUi();
          announce('Feedback draft discarded. Restoring the latest source before editing resumes.');
          post({
            type: 'feedback.close.ready',
            requestId: message.requestId,
            sessionId: message.sessionId,
          });
          break;
        case 'feedback.close.release':
          if (
            !pendingClose ||
            pendingClose.requestId !== message.requestId ||
            pendingClose.sessionId !== message.sessionId ||
            pendingClose.appliedRevision !== message.revision ||
            pendingClose.releaseRevision !== undefined
          ) {
            break;
          }
          pendingClose.releaseRevision = message.revision;
          post({
            type: 'feedback.close.released',
            requestId: message.requestId,
            sessionId: message.sessionId,
            revision: message.revision,
          });
          break;
        case 'feedback.draft.discarded':
          renderDraftBanner(availableDrafts.filter(draft => draft.round !== message.round));
          if (message.requestId === startRequestId) setDraftBannerBusy(true);
          announce('Feedback draft discarded.');
          break;
        case 'feedback.diagnosticsCopied':
          announce('Feedback diagnostics copied.');
          break;
        case 'feedback.error':
          if (message.requestId !== undefined && message.requestId === pendingFinishRequestId) {
            pendingFinishRequestId = null;
            updateCompletionCheckpoint(message.message);
            syncCommentsUi();
            focusElementWithoutScroll(
              completionDialog?.querySelector<HTMLButtonElement>(
                '[data-feedback-completion-confirm]:not([disabled])'
              ) ??
                completionDialog?.querySelector<HTMLButtonElement>(
                  '[data-feedback-completion-resume]'
                ) ??
                null
            );
          }
          if (
            message.requestId !== undefined &&
            (message.requestId === pendingClose?.requestId ||
              message.requestId === pendingTransitionRecovery?.requestId)
          ) {
            resetSyncRetryButton();
          }
          if (message.requestId) {
            const pending = pendingMutations.get(message.requestId);
            if (pending?.kind === 'screenshot') {
              pending.reject(new Error(message.message));
            } else if (pending?.kind === 'text-add') {
              pending.settle();
              if (composer === pending.form && pending.form.isConnected && !invalidated) {
                pending.submit.disabled = pending.field.value.trim().length === 0;
                pending.field.focus({ preventScroll: true });
              }
            } else if (pending?.kind === 'delete' && pending.button.isConnected) {
              pending.button.disabled = invalidated;
            } else if (pending?.kind === 'restore' && pending.button.isConnected) {
              pending.button.disabled = invalidated;
            }
            pendingMutations.delete(message.requestId);
          }
          announce(message.message);
          // Review chrome, including its live region, does not exist until a
          // session starts. Surface pre-session failures through the editor's
          // normal toast channel so a rejected start or draft action cannot
          // appear as a momentary toolbar flicker with no explanation.
          if (!session) {
            window.dispatchEvent(
              new CustomEvent('feedbackLocalError', {
                detail: { message: message.message },
              })
            );
          }
          if (
            !session &&
            message.requestId === startRequestId &&
            pendingTransitionRecovery?.requestId !== message.requestId
          ) {
            startRequestId = null;
            setReadOnly(false);
            document.body.classList.remove('feedback-review-starting');
            setFeedbackToolbarState({ active: false, starting: false });
            setDraftBannerBusy(false);
            restoreTransitionFocus();
          }
          break;
        case 'feedback.command':
          if (message.command === 'start') controller.start();
          else if (message.command === 'commentSelection') controller.commentOnSelection();
          else if (message.command === 'toggleComments') controller.toggleComments();
          else if (message.command === 'nextFeedback') controller.navigateFeedback('next');
          else if (message.command === 'previousFeedback') controller.navigateFeedback('previous');
          else if (message.command === 'finish') controller.finish();
          else if (message.command === 'reveal') controller.reveal();
          else if (message.command === 'discard') controller.discard();
          break;
        default:
          break;
      }
    },

    isEditingLocked() {
      return readOnlyApplied;
    },

    isWritable() {
      return hasWritableSession();
    },

    isInvalidated() {
      return invalidated;
    },

    getSession() {
      return session ? { ...session, items: [...session.items] } : null;
    },
  };

  const handleNativeSelectionChange = (): void => {
    if (hasWritableSession()) handleSelectionChange();
  };

  function bindReviewListeners(): void {
    if (reviewListenersBound) return;
    reviewListenersBound = true;
    editor.on('selectionUpdate', handleSelectionChange);
    document.addEventListener('selectionchange', handleNativeSelectionChange);
    window.addEventListener('resize', scheduleAnnotationLayout);
    editorDom.addEventListener('beforeinput', guardMutation, true);
    editorDom.addEventListener('cut', guardMutation, true);
    editorDom.addEventListener('paste', guardMutation, true);
    editorDom.addEventListener('drop', guardMutation, true);
    if (typeof ResizeObserver === 'function') {
      annotationResizeObserver = new ResizeObserver(() => scheduleAnnotationLayout());
    }
  }

  function unbindReviewListeners(): void {
    if (!reviewListenersBound) return;
    reviewListenersBound = false;
    editor.off('selectionUpdate', handleSelectionChange);
    document.removeEventListener('selectionchange', handleNativeSelectionChange);
    window.removeEventListener('resize', scheduleAnnotationLayout);
    editorDom.removeEventListener('beforeinput', guardMutation, true);
    editorDom.removeEventListener('cut', guardMutation, true);
    editorDom.removeEventListener('paste', guardMutation, true);
    editorDom.removeEventListener('drop', guardMutation, true);
    annotationResizeObserver?.disconnect();
    annotationResizeObserver = null;
  }

  editor.on('destroy', () => {
    controller.deactivate();
    removeDraftBanner();
    setReadOnly(false);
  });

  return controller;
}
