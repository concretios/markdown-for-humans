/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Pure, deterministic layout for document-synchronous Feedback
 * markers, cards, clusters, and connector paths. This module deliberately has
 * no DOM dependency so layout reads and writes can stay batched by its caller.
 */

const FEEDBACK_ID_PATTERN = /^F([1-9]\d*)$/;
const MINIMUM_CARD_GAP = 8;

/** Geometry and measured card sizes for one saved Feedback item. */
export interface FeedbackAnnotationLayoutItem {
  /** Stable, monotonic Feedback identifier in `F<n>` form. */
  id: string;
  /** Stable source order used when two targets share the same vertical position. */
  sourceOrder: number;
  /** Target attachment point in annotation-surface coordinates. */
  targetX: number;
  /** Target center in annotation-surface coordinates. */
  targetY: number;
  /** Inclusive visual start used to detect overlapping target ranges. */
  targetStart: number;
  /** Exclusive visual end used to detect overlapping target ranges. */
  targetEnd: number;
  /** Measured height of the compact card. */
  compactHeight: number;
  /** Measured height when this item is active. */
  expandedHeight: number;
  /** Whether this item's card participates in packing; markers always cluster. */
  cardVisible?: boolean;
  /** Optional caller-selected top, used when a card must avoid covering its target. */
  preferredCardTop?: number;
}

/** Complete numeric input for a single annotation layout pass. */
export interface FeedbackAnnotationLayoutInput {
  items: readonly FeedbackAnnotationLayoutItem[];
  activeId?: string;
  topBound: number;
  documentBottom: number;
  minimumGap: number;
  markerDiameter: number;
  connectorThreshold: number;
  cardLeft: number;
  cardWidth: number;
}

/** One point in the shared annotation-surface coordinate system. */
export interface FeedbackAnnotationPoint {
  x: number;
  y: number;
}

/** SVG-ready connector geometry for a displaced card. */
export interface FeedbackAnnotationConnector {
  start: FeedbackAnnotationPoint;
  attachment: FeedbackAnnotationPoint;
  path: string;
}

/** Positioned card data returned in deterministic document order. */
export interface FeedbackAnnotationPlacement {
  id: string;
  sourceOrder: number;
  clusterId: string;
  targetY: number;
  preferredTop: number;
  top: number;
  bottom: number;
  height: number;
  displacement: number;
  active: boolean;
  connector: FeedbackAnnotationConnector | null;
}

/** Deterministic marker cluster. Cards remain individual placements. */
export interface FeedbackAnnotationCluster {
  id: string;
  memberIds: string[];
  targetY: number;
  targetStart: number;
  targetEnd: number;
}

/** Result of one pure layout pass. */
export interface FeedbackAnnotationLayoutResult {
  placements: FeedbackAnnotationPlacement[];
  clusters: FeedbackAnnotationCluster[];
  /** Bottom edge required by the final packed card, or zero for no cards. */
  requiredBottom: number;
  /** Extra document height required below the current document bottom. */
  eofOverflow: number;
}

interface ValidatedItem extends FeedbackAnnotationLayoutItem {
  numericId: number;
}

interface PlacementDraft {
  item: ValidatedItem;
  height: number;
  preferredTop: number;
  top: number;
}

interface MutableCluster extends FeedbackAnnotationCluster {
  memberIds: string[];
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite.`);
  }
}

function assertNonNegative(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0) throw new RangeError(`${name} must not be negative.`);
}

function assertPositive(name: string, value: number): void {
  assertFinite(name, value);
  if (value <= 0) throw new RangeError(`${name} must be greater than zero.`);
}

function numericFeedbackId(id: string): number {
  const match = FEEDBACK_ID_PATTERN.exec(id);
  const numericId = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(numericId)) {
    throw new TypeError(`Feedback annotation ID must use a safe positive F<n> value: ${id}`);
  }
  return numericId;
}

function validateInput(input: FeedbackAnnotationLayoutInput): ValidatedItem[] {
  assertNonNegative('topBound', input.topBound);
  assertFinite('documentBottom', input.documentBottom);
  if (input.documentBottom < input.topBound) {
    throw new RangeError('documentBottom must not precede topBound.');
  }
  assertNonNegative('minimumGap', input.minimumGap);
  if (input.minimumGap < MINIMUM_CARD_GAP) {
    throw new RangeError(`minimumGap must be at least ${MINIMUM_CARD_GAP}px.`);
  }
  assertNonNegative('markerDiameter', input.markerDiameter);
  assertNonNegative('connectorThreshold', input.connectorThreshold);
  assertFinite('cardLeft', input.cardLeft);
  assertPositive('cardWidth', input.cardWidth);
  assertFinite('cardRight', input.cardLeft + input.cardWidth);

  const identifiers = new Set<string>();
  const validated = input.items.map((item, index): ValidatedItem => {
    const numericId = numericFeedbackId(item.id);
    if (identifiers.has(item.id)) {
      throw new TypeError(`Duplicate Feedback annotation ID: ${item.id}`);
    }
    identifiers.add(item.id);

    if (!Number.isSafeInteger(item.sourceOrder) || item.sourceOrder < 0) {
      throw new RangeError(`items[${index}].sourceOrder must be a non-negative safe integer.`);
    }
    assertFinite(`items[${index}].targetX`, item.targetX);
    assertFinite(`items[${index}].targetY`, item.targetY);
    assertFinite(`items[${index}].targetStart`, item.targetStart);
    assertFinite(`items[${index}].targetEnd`, item.targetEnd);
    if (item.targetStart >= item.targetEnd) {
      throw new RangeError(`items[${index}] target range must not be empty or reversed.`);
    }
    if (item.targetY < item.targetStart || item.targetY > item.targetEnd) {
      throw new RangeError(`items[${index}].targetY must lie within its target range.`);
    }
    assertPositive(`items[${index}].compactHeight`, item.compactHeight);
    assertPositive(`items[${index}].expandedHeight`, item.expandedHeight);
    if (item.preferredCardTop !== undefined) {
      assertFinite(`items[${index}].preferredCardTop`, item.preferredCardTop);
    }
    return { ...item, numericId };
  });

  if (input.activeId !== undefined && !identifiers.has(input.activeId)) {
    throw new TypeError(`Active Feedback annotation does not exist: ${input.activeId}`);
  }
  return validated;
}

function compareItems(left: ValidatedItem, right: ValidatedItem): number {
  if (left.targetY !== right.targetY) return left.targetY < right.targetY ? -1 : 1;
  if (left.sourceOrder !== right.sourceOrder) return left.sourceOrder - right.sourceOrder;
  return left.numericId - right.numericId;
}

function buildClusters(
  items: readonly ValidatedItem[],
  markerDiameter: number
): FeedbackAnnotationCluster[] {
  const clusters: MutableCluster[] = [];
  let lastTargetY = 0;

  for (const item of items) {
    const current = clusters.at(-1);
    const overlaps = current !== undefined && item.targetStart < current.targetEnd;
    const isNear = current !== undefined && item.targetY - lastTargetY < markerDiameter;
    if (!current || (!overlaps && !isNear)) {
      clusters.push({
        id: item.id,
        memberIds: [item.id],
        targetY: item.targetY,
        targetStart: item.targetStart,
        targetEnd: item.targetEnd,
      });
    } else {
      current.memberIds.push(item.id);
      current.targetStart = Math.min(current.targetStart, item.targetStart);
      current.targetEnd = Math.max(current.targetEnd, item.targetEnd);
      const count = current.memberIds.length;
      current.targetY = finitePlacement(
        `${current.id}.clusterTargetY`,
        current.targetY * ((count - 1) / count) + item.targetY / count
      );
    }
    lastTargetY = item.targetY;
  }

  for (const cluster of clusters) cluster.id = cluster.memberIds.join('+');
  return clusters;
}

function finitePlacement(name: string, value: number): number {
  assertFinite(name, value);
  return value;
}

function packCards(
  items: readonly ValidatedItem[],
  activeId: string | undefined,
  topBound: number,
  minimumGap: number
): PlacementDraft[] {
  const drafts: PlacementDraft[] = items
    .filter(item => item.cardVisible !== false)
    .map(item => {
      const height = item.id === activeId ? item.expandedHeight : item.compactHeight;
      const preferredTop = finitePlacement(
        `${item.id}.preferredTop`,
        item.preferredCardTop ?? item.targetY - height / 2
      );
      return { item, height, preferredTop, top: preferredTop };
    });
  if (drafts.length === 0) return drafts;

  const activeIndex = activeId ? drafts.findIndex(candidate => candidate.item.id === activeId) : -1;
  const pivotIndex = activeIndex >= 0 ? activeIndex : 0;

  for (let index = pivotIndex - 1; index >= 0; index -= 1) {
    const current = drafts[index]!;
    const next = drafts[index + 1]!;
    const packedTop = finitePlacement(
      `${current.item.id}.packedTop`,
      next.top - minimumGap - current.height
    );
    current.top = Math.min(current.preferredTop, packedTop);
  }
  for (let index = pivotIndex + 1; index < drafts.length; index += 1) {
    const previous = drafts[index - 1]!;
    const current = drafts[index]!;
    const packedTop = finitePlacement(
      `${current.item.id}.packedTop`,
      previous.top + previous.height + minimumGap
    );
    current.top = Math.max(current.preferredTop, packedTop);
  }

  drafts[0]!.top = Math.max(topBound, drafts[0]!.top);
  for (let index = 1; index < drafts.length; index += 1) {
    const previous = drafts[index - 1]!;
    const current = drafts[index]!;
    const packedTop = finitePlacement(
      `${current.item.id}.boundedTop`,
      previous.top + previous.height + minimumGap
    );
    current.top = Math.max(current.top, packedTop);
  }
  return drafts;
}

function normalized(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function pathNumber(value: number): string {
  return String(normalized(value));
}

function buildConnector(
  draft: PlacementDraft,
  displacement: number,
  input: FeedbackAnnotationLayoutInput
): FeedbackAnnotationConnector | null {
  if (Math.abs(displacement) <= input.connectorThreshold) return null;

  const cardRight = input.cardLeft + input.cardWidth;
  const cardCenterX = input.cardLeft / 2 + (input.cardLeft + input.cardWidth) / 2;
  const attachmentX = draft.item.targetX <= cardCenterX ? input.cardLeft : cardRight;
  const attachmentY = Math.min(draft.top + draft.height, Math.max(draft.top, draft.item.targetY));
  const controlX = draft.item.targetX / 2 + attachmentX / 2;
  const start = {
    x: normalized(draft.item.targetX),
    y: normalized(draft.item.targetY),
  };
  const attachment = {
    x: normalized(attachmentX),
    y: normalized(attachmentY),
  };
  return {
    start,
    attachment,
    path: `M ${pathNumber(start.x)} ${pathNumber(start.y)} C ${pathNumber(controlX)} ${pathNumber(
      start.y
    )} ${pathNumber(controlX)} ${pathNumber(attachment.y)} ${pathNumber(
      attachment.x
    )} ${pathNumber(attachment.y)}`,
  };
}

/**
 * Lay out Feedback annotations with one `O(c log c)` sort followed by linear
 * clustering, active-pivot packing, and connector construction.
 *
 * @throws {TypeError} When stable identities are malformed or duplicated.
 * @throws {RangeError} When any measured geometry is invalid or non-finite.
 */
export function layoutFeedbackAnnotations(
  input: FeedbackAnnotationLayoutInput
): FeedbackAnnotationLayoutResult {
  const sortedItems = validateInput(input).sort(compareItems);
  if (sortedItems.length === 0) {
    return { placements: [], clusters: [], requiredBottom: 0, eofOverflow: 0 };
  }

  const clusters = buildClusters(sortedItems, input.markerDiameter);
  const clusterByItem = new Map<string, string>();
  for (const cluster of clusters) {
    for (const id of cluster.memberIds) clusterByItem.set(id, cluster.id);
  }

  const drafts = packCards(sortedItems, input.activeId, input.topBound, input.minimumGap);
  const placements = drafts.map((draft): FeedbackAnnotationPlacement => {
    const top = normalized(draft.top);
    const bottom = normalized(finitePlacement(`${draft.item.id}.bottom`, top + draft.height));
    const displacement = normalized(
      finitePlacement(`${draft.item.id}.displacement`, top - draft.preferredTop)
    );
    return {
      id: draft.item.id,
      sourceOrder: draft.item.sourceOrder,
      clusterId: clusterByItem.get(draft.item.id)!,
      targetY: draft.item.targetY,
      preferredTop: normalized(draft.preferredTop),
      top,
      bottom,
      height: draft.height,
      displacement,
      active: draft.item.id === input.activeId,
      connector: buildConnector({ ...draft, top }, displacement, input),
    };
  });
  const requiredBottom = placements.at(-1)?.bottom ?? 0;
  return {
    placements,
    clusters,
    requiredBottom,
    eofOverflow: Math.max(0, requiredBottom - input.documentBottom),
  };
}
