/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import {
  layoutFeedbackAnnotations,
  type FeedbackAnnotationLayoutInput,
  type FeedbackAnnotationLayoutItem,
} from '../../webview/features/feedbackAnnotationLayout';

const BASE_LAYOUT: Omit<FeedbackAnnotationLayoutInput, 'items'> = {
  topBound: 0,
  documentBottom: 600,
  minimumGap: 8,
  markerDiameter: 24,
  connectorThreshold: 4,
  cardLeft: 700,
  cardWidth: 280,
};

function item(
  id: string,
  sourceOrder: number,
  targetY: number,
  overrides: Partial<FeedbackAnnotationLayoutItem> = {}
): FeedbackAnnotationLayoutItem {
  return {
    id,
    sourceOrder,
    targetX: 660,
    targetY,
    targetStart: targetY - 6,
    targetEnd: targetY + 6,
    compactHeight: 36,
    expandedHeight: 96,
    ...overrides,
  };
}

function layout(
  items: readonly FeedbackAnnotationLayoutItem[],
  overrides: Partial<Omit<FeedbackAnnotationLayoutInput, 'items'>> = {}
) {
  return layoutFeedbackAnnotations({ ...BASE_LAYOUT, ...overrides, items });
}

describe('layoutFeedbackAnnotations', () => {
  it('sorts reverse input by target, source order, and then numeric Feedback ID', () => {
    const items = [
      item('F10', 2, 200),
      item('F12', 5, 100),
      item('F2', 2, 200),
      item('F3', 1, 200),
    ];

    const result = layout(items);

    expect(result.placements.map(placement => placement.id)).toEqual(['F12', 'F3', 'F2', 'F10']);
    expect(items.map(candidate => candidate.id)).toEqual(['F10', 'F12', 'F2', 'F3']);
  });

  it('forms deterministic transitive clusters from overlapping ranges or nearby centers', () => {
    const result = layout(
      [
        item('F4', 4, 171, { targetStart: 166, targetEnd: 176 }),
        item('F2', 2, 124, { targetStart: 118, targetEnd: 130 }),
        item('F3', 3, 147, { targetStart: 144, targetEnd: 150 }),
        item('F1', 1, 110, { targetStart: 100, targetEnd: 120 }),
      ],
      { markerDiameter: 24 }
    );

    expect(result.clusters).toEqual([
      {
        id: 'F1+F2+F3',
        memberIds: ['F1', 'F2', 'F3'],
        targetY: 127,
        targetStart: 100,
        targetEnd: 150,
      },
      {
        id: 'F4',
        memberIds: ['F4'],
        targetY: 171,
        targetStart: 166,
        targetEnd: 176,
      },
    ]);
  });

  it('keeps hidden cards in marker clusters without packing or EOF space', () => {
    const result = layout(
      [
        item('F1', 1, 100, { cardVisible: false }),
        item('F2', 2, 110, { compactHeight: 24, expandedHeight: 80 }),
        item('F3', 3, 120, { cardVisible: false }),
      ],
      { activeId: 'F2', documentBottom: 200 }
    );

    expect(result.clusters.map(cluster => cluster.memberIds)).toEqual([['F1', 'F2', 'F3']]);
    expect(result.placements.map(placement => placement.id)).toEqual(['F2']);
    expect(result.requiredBottom).toBe(150);
    expect(result.eofOverflow).toBe(0);
  });

  it('clusters overlapping rendered ranges even when their centers are farther than a marker', () => {
    const result = layout(
      [
        item('F2', 2, 200, { targetStart: 140, targetEnd: 250 }),
        item('F1', 1, 100, { targetStart: 0, targetEnd: 150 }),
      ],
      { markerDiameter: 24 }
    );

    expect(result.clusters.map(cluster => cluster.memberIds)).toEqual([['F1', 'F2']]);
  });

  it('splits and merges clusters without making membership depend on input order', () => {
    const separated = [item('F3', 3, 180), item('F1', 1, 100), item('F2', 2, 130)];
    const merged = [item('F2', 2, 121), item('F3', 3, 142), item('F1', 1, 100)];

    expect(
      layout(separated, { markerDiameter: 24 }).clusters.map(cluster => cluster.memberIds)
    ).toEqual([['F1'], ['F2'], ['F3']]);
    expect(
      layout(merged, { markerDiameter: 24 }).clusters.map(cluster => cluster.memberIds)
    ).toEqual([['F1', 'F2', 'F3']]);
    expect(
      layout([...merged].reverse(), { markerDiameter: 24 }).clusters.map(
        cluster => cluster.memberIds
      )
    ).toEqual([['F1', 'F2', 'F3']]);
  });

  it('keeps the active expanded card at its preferred target when surrounding cards fit', () => {
    const result = layout(
      [
        item('F1', 1, 100, { compactHeight: 20 }),
        item('F2', 2, 160, { compactHeight: 20, expandedHeight: 80 }),
        item('F3', 3, 220, { compactHeight: 20 }),
      ],
      { activeId: 'F2' }
    );

    expect(
      result.placements.map(placement => [placement.id, placement.top, placement.height])
    ).toEqual([
      ['F1', 90, 20],
      ['F2', 120, 80],
      ['F3', 210, 20],
    ]);
    expect(result.placements[1]?.displacement).toBe(0);
  });

  it('honors an explicit card top so narrow active details can sit below the target', () => {
    const result = layout(
      [
        item('F1', 1, 110, {
          targetStart: 100,
          targetEnd: 120,
          expandedHeight: 96,
          preferredCardTop: 132,
        }),
      ],
      { activeId: 'F1' }
    );

    expect(result.placements[0]).toEqual(
      expect.objectContaining({ preferredTop: 132, top: 132, bottom: 228 })
    );
    expect(result.placements[0]!.top).toBeGreaterThan(result.placements[0]!.targetY);
  });

  it('keeps a pinned active edit at its viewport-safe top and overflows preceding cards upward', () => {
    const crowded = [
      item('F1', 1, 100),
      item('F2', 2, 101),
      item('F3', 3, 102),
      item('F4', 4, 103),
      {
        ...item('F5', 5, 104, { expandedHeight: 96, preferredCardTop: 100 }),
        pinPreferredCardTop: true,
      } as FeedbackAnnotationLayoutItem,
      item('F6', 6, 105),
    ];

    const unpinned = layout(
      crowded.map(candidate =>
        candidate.id === 'F5' ? { ...candidate, pinPreferredCardTop: undefined } : candidate
      ),
      { activeId: 'F5', topBound: 40 }
    );
    const pinned = layout(crowded, { activeId: 'F5', topBound: 40 });
    const activeUnpinned = unpinned.placements.find(placement => placement.id === 'F5');
    const activePinned = pinned.placements.find(placement => placement.id === 'F5');

    expect(activeUnpinned?.top).toBeGreaterThan(100);
    expect(activePinned).toEqual(
      expect.objectContaining({ preferredTop: 100, top: 100, bottom: 196, displacement: 0 })
    );
    expect(pinned.placements[0]!.top).toBeLessThan(40);
    for (let index = 1; index < pinned.placements.length; index += 1) {
      expect(
        pinned.placements[index]!.top - pinned.placements[index - 1]!.bottom
      ).toBeGreaterThanOrEqual(8);
    }
  });

  it('repacks both sides of an active pivot when its expanded height changes', () => {
    const items = [
      item('F1', 1, 100, { compactHeight: 30 }),
      item('F2', 2, 130, { compactHeight: 30, expandedHeight: 100 }),
      item('F3', 3, 160, { compactHeight: 30 }),
    ];

    const compact = layout(items);
    const expanded = layout(items, { activeId: 'F2' });

    expect(compact.placements.map(placement => placement.height)).toEqual([30, 30, 30]);
    expect(expanded.placements.map(placement => placement.height)).toEqual([30, 100, 30]);
    expect(expanded.placements[0]!.bottom + 8).toBeLessThanOrEqual(expanded.placements[1]!.top);
    expect(expanded.placements[1]!.bottom + 8).toBeLessThanOrEqual(expanded.placements[2]!.top);
    expect(expanded.placements[0]!.top).toBeLessThan(compact.placements[0]!.top);
    expect(expanded.placements[2]!.top).toBeGreaterThan(compact.placements[2]!.top);
  });

  it('honors a nonzero top bound, minimum gaps, and reports only required EOF overflow', () => {
    const result = layout(
      [item('F1', 1, 0, { compactHeight: 30 }), item('F2', 2, 1, { compactHeight: 30 })],
      { topBound: 10, documentBottom: 70 }
    );

    expect(result.placements.map(placement => placement.top)).toEqual([10, 48]);
    expect(result.requiredBottom).toBe(78);
    expect(result.eofOverflow).toBe(8);
  });

  it('preserves fractional geometry without rounding away spacing', () => {
    const result = layout(
      [item('F1', 1, 10.25, { compactHeight: 5.5 }), item('F2', 2, 11.75, { compactHeight: 7.25 })],
      { topBound: 2.125, minimumGap: 8.25 }
    );

    expect(result.placements[0]?.top).toBe(7.5);
    expect(result.placements[1]?.top).toBe(21.25);
    expect(result.placements[1]!.top - result.placements[0]!.bottom).toBe(8.25);
  });

  it('emits a clamped connector only after displacement exceeds the threshold', () => {
    const atThreshold = layout([item('F1', 1, 100, { compactHeight: 20 })], {
      topBound: 94,
    });
    const displaced = layout([item('F1', 1, 100, { targetX: 600, compactHeight: 20 })], {
      topBound: 130,
    });

    expect(atThreshold.placements[0]?.displacement).toBe(4);
    expect(atThreshold.placements[0]?.connector).toBeNull();
    expect(displaced.placements[0]?.connector).toEqual({
      start: { x: 600, y: 100 },
      attachment: { x: 700, y: 130 },
      path: 'M 600 100 C 650 100 650 130 700 130',
    });
  });

  it('attaches connectors to the nearest horizontal card edge', () => {
    const result = layout([item('F1', 1, 200, { targetX: 1_020, compactHeight: 20 })], {
      topBound: 240,
    });

    expect(result.placements[0]?.connector?.attachment).toEqual({ x: 980, y: 240 });
  });

  it.each([
    ['NaN target', [item('F1', 1, Number.NaN)]],
    ['infinite target', [item('F1', 1, Number.POSITIVE_INFINITY)]],
    ['negative height', [item('F1', 1, 10, { compactHeight: -1 })]],
    ['collapsed target interval', [item('F1', 1, 10, { targetStart: 10, targetEnd: 10 })]],
    ['unsafe source order', [item('F1', Number.MAX_SAFE_INTEGER + 1, 10)]],
    [
      'derived packed geometry overflow',
      [
        item('F1', 1, Number.MAX_VALUE / 2, {
          targetStart: 0,
          targetEnd: Number.MAX_VALUE,
          compactHeight: Number.MAX_VALUE,
          expandedHeight: Number.MAX_VALUE,
        }),
        item('F2', 2, Number.MAX_VALUE / 2, {
          targetStart: 0,
          targetEnd: Number.MAX_VALUE,
          compactHeight: Number.MAX_VALUE,
          expandedHeight: Number.MAX_VALUE,
        }),
      ],
    ],
  ])('rejects invalid item geometry: %s', (_label, items) => {
    expect(() => layout(items)).toThrow(RangeError);
  });

  it('rejects finite inputs whose derived displacement overflows', () => {
    const extreme = item('F1', 1, -Number.MAX_VALUE / 2, {
      targetStart: -Number.MAX_VALUE,
      targetEnd: 0,
      compactHeight: Number.MAX_VALUE,
      expandedHeight: Number.MAX_VALUE,
    });

    expect(() =>
      layout([extreme], { topBound: Number.MAX_VALUE / 2, documentBottom: Number.MAX_VALUE })
    ).toThrow(RangeError);
  });

  it.each([
    ['invalid Feedback ID', [item('comment-1', 1, 10)]],
    ['duplicate Feedback ID', [item('F1', 1, 10), item('F1', 2, 20)]],
  ])('rejects invalid identity: %s', (_label, items) => {
    expect(() => layout(items)).toThrow(TypeError);
  });

  it('rejects a preferred-top pin without a preferred top or active ownership', () => {
    const missingTop = {
      ...item('F1', 1, 100),
      pinPreferredCardTop: true,
    } as FeedbackAnnotationLayoutItem;
    const inactivePin = {
      ...item('F1', 1, 100, { preferredCardTop: 80 }),
      pinPreferredCardTop: true,
    } as FeedbackAnnotationLayoutItem;

    expect(() => layout([missingTop], { activeId: 'F1' })).toThrow(TypeError);
    expect(() => layout([inactivePin, item('F2', 2, 200)], { activeId: 'F2' })).toThrow(TypeError);
  });

  it.each([
    ['negative gap', { minimumGap: -1 }],
    ['gap below the eight-pixel readability floor', { minimumGap: 7.99 }],
    ['negative marker diameter', { markerDiameter: -1 }],
    ['negative connector threshold', { connectorThreshold: -1 }],
    ['zero card width', { cardWidth: 0 }],
    ['overflowing card edge', { cardLeft: Number.MAX_VALUE, cardWidth: Number.MAX_VALUE }],
    ['bottom before top', { topBound: 20, documentBottom: 19 }],
    ['unknown active ID', { activeId: 'F99' }],
  ] as const)('rejects invalid layout options: %s', (_label, overrides) => {
    expect(() => layout([item('F1', 1, 10)], overrides)).toThrow();
  });

  it('returns an empty bounded layout without inventing EOF space', () => {
    expect(layout([])).toEqual({
      placements: [],
      clusters: [],
      requiredBottom: 0,
      eofOverflow: 0,
    });
  });

  it('lays out 200 comments within an interaction-frame-sized warm-run budget', () => {
    const items = Array.from({ length: 200 }, (_, index) =>
      item(`F${index + 1}`, index, index * 7)
    );
    layout(items);

    const startedAt = performance.now();
    const result = layout(items);
    const elapsed = performance.now() - startedAt;

    expect(result.placements).toHaveLength(200);
    expect(elapsed).toBeLessThan(16);
  });

  it('keeps a 5,000-comment stress layout within a loose non-quadratic ceiling', () => {
    const items = Array.from({ length: 5_000 }, (_, index) =>
      item(`F${index + 1}`, index, index * 2.25)
    ).reverse();
    layout(items.slice(0, 100));

    const startedAt = performance.now();
    const result = layout(items, { documentBottom: 50_000 });
    const elapsed = performance.now() - startedAt;

    expect(result.placements).toHaveLength(5_000);
    expect(result.clusters.length).toBeGreaterThan(0);
    for (let index = 1; index < result.placements.length; index += 1) {
      expect(
        result.placements[index]!.top - result.placements[index - 1]!.bottom
      ).toBeGreaterThanOrEqual(8);
    }
    expect(elapsed).toBeLessThan(100);
  });
});
