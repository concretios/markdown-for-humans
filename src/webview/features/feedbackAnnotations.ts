/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Feedback-only ProseMirror annotation decorations. The plugin is
 * dynamically registered for a frozen Feedback session and all state changes
 * use transaction metadata, leaving the Markdown document untouched.
 */

import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export type FeedbackAnnotationTarget =
  | { id: string; kind: 'inline'; from: number; to: number }
  | { id: string; kind: 'node'; from: number; to: number }
  | { id: string; kind: 'cell'; from: number; to: number };

export interface FeedbackAnnotationSegment {
  from: number;
  to: number;
  ids: readonly string[];
}

export interface FeedbackAnnotationState {
  readonly items: readonly FeedbackAnnotationTarget[];
  readonly activeIds: readonly string[];
  readonly suspended: boolean;
  readonly decorations: DecorationSet;
}

type FeedbackAnnotationMeta =
  | { type: 'items'; items: readonly FeedbackAnnotationTarget[] }
  | { type: 'active'; ids: readonly string[] }
  | { type: 'suspended'; suspended: boolean }
  | { type: 'clear' };

export interface FeedbackAnnotationController {
  register(): void;
  setItems(items: readonly FeedbackAnnotationTarget[]): void;
  setActiveIds(ids: readonly string[]): void;
  suspend(): void;
  restore(): void;
  clear(): void;
  unregister(): void;
  isRegistered(): boolean;
}

export const feedbackAnnotationsPluginKey = new PluginKey<FeedbackAnnotationState>(
  'md4hFeedbackAnnotations'
);

/** Reserved, session-local ID for an exact selection awaiting feedback text. */
export const PENDING_FEEDBACK_ANNOTATION_ID = '__pending__';

function compareFeedbackIds(left: string, right: string): number {
  const leftMatch = /^F([1-9]\d*)$/.exec(left);
  const rightMatch = /^F([1-9]\d*)$/.exec(right);
  if (leftMatch && rightMatch) {
    const numericDifference = Number(leftMatch[1]) - Number(rightMatch[1]);
    if (numericDifference !== 0) return numericDifference;
  }
  return left.localeCompare(right);
}

function validFeedbackId(value: string): boolean {
  return value === PENDING_FEEDBACK_ANNOTATION_ID || /^F[1-9]\d{0,8}$/.test(value);
}

function validBoundary(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeBasicItems(
  items: readonly FeedbackAnnotationTarget[]
): FeedbackAnnotationTarget[] {
  const sorted = items
    .filter(
      item =>
        validFeedbackId(item.id) &&
        validBoundary(item.from) &&
        validBoundary(item.to) &&
        item.from < item.to &&
        (item.kind === 'inline' || item.kind === 'node' || item.kind === 'cell')
    )
    .map(item => ({ ...item }))
    .sort(
      (left, right) =>
        compareFeedbackIds(left.id, right.id) ||
        left.from - right.from ||
        left.to - right.to ||
        left.kind.localeCompare(right.kind)
    );

  const seenTargets = new Set<string>();
  return sorted.filter(item => {
    const key = `${item.id}:${item.kind}:${item.from}:${item.to}`;
    if (seenTargets.has(key)) return false;
    seenTargets.add(key);
    return true;
  });
}

function contentBoundsAtPosition(
  doc: ProseMirrorNode,
  position: number,
  endpoint: 'start' | 'end'
): { contentFrom: number; contentTo: number } | null {
  try {
    const resolved = doc.resolve(position);
    let ordinal: number;
    let before: number;
    if (resolved.depth > 0) {
      ordinal = resolved.index(0);
      before = resolved.before(1);
    } else {
      const rootIndex = resolved.index(0);
      ordinal = endpoint === 'end' ? rootIndex - 1 : rootIndex;
      if (ordinal < 0 || ordinal >= doc.childCount) return null;
      const node = doc.child(ordinal);
      before = endpoint === 'end' ? position - node.nodeSize : position;
    }
    const node = doc.maybeChild(ordinal);
    if (!node) return null;
    const contentFrom = before + 1;
    return { contentFrom, contentTo: contentFrom + node.content.size };
  } catch {
    return null;
  }
}

function isCanonicalInlineRange(doc: ProseMirrorNode, from: number, to: number): boolean {
  const start = contentBoundsAtPosition(doc, from, 'start');
  const end = contentBoundsAtPosition(doc, to, 'end');
  return Boolean(
    start &&
    end &&
    from >= start.contentFrom &&
    from < start.contentTo &&
    to > end.contentFrom &&
    to <= end.contentTo
  );
}

function normalizeItemsForDoc(
  doc: ProseMirrorNode,
  items: readonly FeedbackAnnotationTarget[]
): FeedbackAnnotationTarget[] {
  if (items.length === 0) return [];
  const topLevelNodeBoundaries = new Map<number, number>();
  doc.forEach((node, offset) => {
    topLevelNodeBoundaries.set(offset, offset + node.nodeSize);
  });
  return normalizeBasicItems(items).filter(item => {
    if (item.to > doc.content.size) return false;
    if (item.kind === 'inline') return isCanonicalInlineRange(doc, item.from, item.to);
    if (item.kind === 'cell') {
      const cell = doc.nodeAt(item.from);
      return Boolean(
        cell &&
        item.to === item.from + cell.nodeSize &&
        (cell.type.spec.tableRole === 'cell' || cell.type.spec.tableRole === 'header_cell')
      );
    }
    return topLevelNodeBoundaries.get(item.from) === item.to;
  });
}

interface SweepEvent {
  starts: string[];
  ends: string[];
}

/**
 * Produces disjoint inline intervals. An interval shared by several feedback
 * items is represented once, preventing translucent highlight stacking.
 */
export function buildFeedbackAnnotationSegments(
  items: readonly FeedbackAnnotationTarget[]
): FeedbackAnnotationSegment[] {
  const inlineItems = normalizeBasicItems(items).filter(
    (item): item is Extract<FeedbackAnnotationTarget, { kind: 'inline' }> => item.kind === 'inline'
  );
  return buildSegmentsFromNormalized(inlineItems);
}

function buildSegmentsFromNormalized(
  inlineItems: readonly Extract<FeedbackAnnotationTarget, { kind: 'inline' }>[]
): FeedbackAnnotationSegment[] {
  const events = new Map<number, SweepEvent>();
  const eventAt = (position: number): SweepEvent => {
    const existing = events.get(position);
    if (existing) return existing;
    const created = { starts: [], ends: [] };
    events.set(position, created);
    return created;
  };
  for (const item of inlineItems) {
    eventAt(item.from).starts.push(item.id);
    eventAt(item.to).ends.push(item.id);
  }

  const boundaries = [...events.keys()].sort((left, right) => left - right);
  const activeCounts = new Map<string, number>();
  const segments: FeedbackAnnotationSegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const position = boundaries[index];
    const next = boundaries[index + 1];
    const event = events.get(position);
    event?.ends.forEach(id => {
      const nextCount = (activeCounts.get(id) ?? 0) - 1;
      if (nextCount > 0) activeCounts.set(id, nextCount);
      else activeCounts.delete(id);
    });
    event?.starts.forEach(id => activeCounts.set(id, (activeCounts.get(id) ?? 0) + 1));
    if (activeCounts.size > 0 && next > position) {
      segments.push({
        from: position,
        to: next,
        ids: [...activeCounts.keys()].sort(compareFeedbackIds),
      });
    }
  }
  return segments;
}

interface FeedbackNodeDecorationGroup {
  readonly kind: 'node' | 'cell';
  readonly from: number;
  readonly to: number;
  readonly ids: readonly string[];
}

interface PreparedFeedbackAnnotations {
  readonly items: readonly FeedbackAnnotationTarget[];
  readonly segments: readonly FeedbackAnnotationSegment[];
  readonly nodeGroups: readonly FeedbackNodeDecorationGroup[];
}

const preparedAnnotationsByState = new WeakMap<
  FeedbackAnnotationState,
  PreparedFeedbackAnnotations
>();

function prepareAnnotations(
  doc: ProseMirrorNode,
  items: readonly FeedbackAnnotationTarget[]
): PreparedFeedbackAnnotations {
  const immutableItems = normalizeItemsForDoc(doc, items).map(item => Object.freeze(item));
  const inlineItems = immutableItems.filter(
    (item): item is Readonly<Extract<FeedbackAnnotationTarget, { kind: 'inline' }>> =>
      item.kind === 'inline'
  );
  const segments = buildSegmentsFromNormalized(inlineItems).map(segment =>
    Object.freeze({ ...segment, ids: Object.freeze(segment.ids) })
  );
  const groupedNodes = new Map<
    string,
    { kind: 'node' | 'cell'; from: number; to: number; ids: string[] }
  >();
  for (const item of immutableItems) {
    if (item.kind !== 'node' && item.kind !== 'cell') continue;
    const key = `${item.kind}:${item.from}:${item.to}`;
    const group = groupedNodes.get(key) ?? {
      kind: item.kind,
      from: item.from,
      to: item.to,
      ids: [],
    };
    group.ids.push(item.id);
    groupedNodes.set(key, group);
  }
  const nodeGroups = [...groupedNodes.values()].map(group =>
    Object.freeze({
      kind: group.kind,
      from: group.from,
      to: group.to,
      ids: Object.freeze(group.ids.sort(compareFeedbackIds)),
    })
  );
  return Object.freeze({
    items: Object.freeze(immutableItems),
    segments: Object.freeze(segments),
    nodeGroups: Object.freeze(nodeGroups),
  });
}

function decorationAttributes(
  ids: readonly string[],
  activeIds: ReadonlySet<string>,
  kind: string
) {
  const associatedActiveIds = ids.filter(id => activeIds.has(id));
  return {
    class: [
      'md4h-feedback-annotation',
      `md4h-feedback-annotation-${kind}`,
      associatedActiveIds.length > 0 ? 'is-feedback-active' : '',
    ]
      .filter(Boolean)
      .join(' '),
    'data-feedback-ids': ids.join(','),
    ...(associatedActiveIds.length > 0
      ? { 'data-feedback-active-ids': associatedActiveIds.join(',') }
      : {}),
  };
}

function buildDecorations(
  doc: ProseMirrorNode,
  prepared: PreparedFeedbackAnnotations,
  activeIds: readonly string[],
  suspended: boolean
): DecorationSet {
  if (suspended || prepared.items.length === 0) return DecorationSet.empty;
  const active = new Set(activeIds);
  const decorations: Decoration[] = prepared.segments.map(segment =>
    Decoration.inline(
      segment.from,
      segment.to,
      decorationAttributes(segment.ids, active, 'inline'),
      { feedbackIds: segment.ids }
    )
  );

  for (const group of prepared.nodeGroups) {
    decorations.push(
      Decoration.node(group.from, group.to, decorationAttributes(group.ids, active, group.kind), {
        feedbackIds: group.ids,
      })
    );
  }
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

function annotationState(
  doc: ProseMirrorNode,
  prepared: PreparedFeedbackAnnotations,
  activeIds: readonly string[],
  suspended: boolean
): FeedbackAnnotationState {
  const itemIds = new Set(prepared.items.map(item => item.id));
  const normalizedActiveIds = [...new Set(activeIds)]
    .filter(id => itemIds.has(id))
    .sort(compareFeedbackIds);
  const state = Object.freeze({
    items: prepared.items,
    activeIds: Object.freeze(normalizedActiveIds),
    suspended,
    decorations: buildDecorations(doc, prepared, normalizedActiveIds, suspended),
  });
  preparedAnnotationsByState.set(state, prepared);
  return state;
}

/** Create a fresh plugin instance for one editor registration lifecycle. */
export function createFeedbackAnnotationsPlugin(): Plugin<FeedbackAnnotationState> {
  return new Plugin<FeedbackAnnotationState>({
    key: feedbackAnnotationsPluginKey,
    state: {
      init: (_, state) => annotationState(state.doc, prepareAnnotations(state.doc, []), [], false),
      apply: (transaction, previous) => {
        const meta = transaction.getMeta(feedbackAnnotationsPluginKey) as
          FeedbackAnnotationMeta | undefined;
        if (!meta) {
          // Frozen Feedback sessions block document changes. If another owner
          // replaces the document anyway, discard rather than silently map an
          // exact target to different content.
          return transaction.docChanged
            ? annotationState(transaction.doc, prepareAnnotations(transaction.doc, []), [], false)
            : previous;
        }
        const prepared =
          preparedAnnotationsByState.get(previous) ??
          prepareAnnotations(transaction.doc, previous.items);
        switch (meta.type) {
          case 'items':
            return annotationState(
              transaction.doc,
              prepareAnnotations(transaction.doc, meta.items),
              previous.activeIds,
              previous.suspended
            );
          case 'active':
            return annotationState(transaction.doc, prepared, meta.ids, previous.suspended);
          case 'suspended':
            return annotationState(transaction.doc, prepared, previous.activeIds, meta.suspended);
          case 'clear':
            return annotationState(
              transaction.doc,
              prepareAnnotations(transaction.doc, []),
              [],
              false
            );
        }
      },
    },
    props: {
      decorations: state =>
        feedbackAnnotationsPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
    },
  });
}

/** Read the immutable annotation state if Feedback mode registered the plugin. */
export function getFeedbackAnnotationState(editor: Editor): FeedbackAnnotationState | undefined {
  return feedbackAnnotationsPluginKey.getState(editor.state);
}

/**
 * Create a dynamic lifecycle controller. Mutators are deliberate no-ops until
 * `register`, ensuring ordinary rich-view editing has no annotation plugin or
 * transaction overhead.
 */
export function createFeedbackAnnotationController(editor: Editor): FeedbackAnnotationController {
  const isRegistered = (): boolean => Boolean(feedbackAnnotationsPluginKey.get(editor.state));
  const arraysEqual = <T>(left: readonly T[], right: readonly T[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  const targetsEqual = (
    left: readonly FeedbackAnnotationTarget[],
    right: readonly FeedbackAnnotationTarget[]
  ): boolean =>
    left.length === right.length &&
    left.every((target, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        target.id === candidate.id &&
        target.kind === candidate.kind &&
        target.from === candidate.from &&
        target.to === candidate.to
      );
    });
  const dispatch = (meta: FeedbackAnnotationMeta): void => {
    if (!isRegistered() || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(feedbackAnnotationsPluginKey, meta));
  };

  return {
    register(): void {
      if (editor.isDestroyed || isRegistered()) return;
      editor.registerPlugin(createFeedbackAnnotationsPlugin());
    },
    setItems(items): void {
      const current = getFeedbackAnnotationState(editor);
      if (current && targetsEqual(current.items, items)) return;
      dispatch({ type: 'items', items });
    },
    setActiveIds(ids): void {
      const current = getFeedbackAnnotationState(editor);
      if (!current) return;
      const itemIds = new Set(current.items.map(item => item.id));
      const normalizedIds = [...new Set(ids)]
        .filter(id => itemIds.has(id))
        .sort(compareFeedbackIds);
      if (arraysEqual(current.activeIds, normalizedIds)) return;
      dispatch({ type: 'active', ids: normalizedIds });
    },
    suspend(): void {
      if (getFeedbackAnnotationState(editor)?.suspended) return;
      dispatch({ type: 'suspended', suspended: true });
    },
    restore(): void {
      const current = getFeedbackAnnotationState(editor);
      if (!current || !current.suspended) return;
      dispatch({ type: 'suspended', suspended: false });
    },
    clear(): void {
      const current = getFeedbackAnnotationState(editor);
      if (
        !current ||
        (current.items.length === 0 && current.activeIds.length === 0 && !current.suspended)
      ) {
        return;
      }
      dispatch({ type: 'clear' });
    },
    unregister(): void {
      if (editor.isDestroyed || !isRegistered()) return;
      editor.unregisterPlugin(feedbackAnnotationsPluginKey);
    },
    isRegistered,
  };
}
