/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import {
  FEEDBACK_ANCHOR_ERROR_CODE,
  FEEDBACK_TARGET_ERROR_CODE,
  buildFeedbackAnchorMap,
  mapFeedbackSelection,
  type CanonicalFeedbackBlock,
  type FeedbackAnchorMap,
} from '../../editor/feedbackAnchors';

function block(ordinal: number, kind: string, markdown: string): CanonicalFeedbackBlock {
  return { ordinal, kind, markdown };
}

function expectAnchorMap(
  rawMarkdown: string,
  canonicalBlocks: CanonicalFeedbackBlock[]
): FeedbackAnchorMap {
  const result = buildFeedbackAnchorMap(rawMarkdown, canonicalBlocks);
  if (!result.ok) {
    throw new Error(`${result.error.reason}: ${result.error.detail}`);
  }
  return result.map;
}

describe('buildFeedbackAnchorMap', () => {
  it('maps canonical blocks to exact raw lines across Setext headings and hard wraps', () => {
    const rawMarkdown = [
      'A source-preserved title',
      '========================',
      '',
      'A hard-wrapped paragraph',
      'spans two source lines.',
    ].join('\n');
    const canonicalBlocks = [
      block(0, 'heading', '# A source-preserved title'),
      block(1, 'paragraph', 'A hard-wrapped paragraph spans two source lines.'),
    ];

    expect(expectAnchorMap(rawMarkdown, canonicalBlocks).blocks).toEqual([
      { ordinal: 0, kind: 'heading', startLine: 1, endLine: 2 },
      { ordinal: 1, kind: 'paragraph', startLine: 4, endLine: 5 },
    ]);
  });

  it('preserves CRLF and Unicode line locations', () => {
    const rawMarkdown =
      'Caf\u00e9 \ud83d\ude00 is wrapped\r\nacross two lines.\r\n\r\n## R\u00e9sum\u00e9\r\n';
    const canonicalBlocks = [
      block(0, 'paragraph', 'Caf\u00e9 \ud83d\ude00 is wrapped across two lines.'),
      block(1, 'heading', '## R\u00e9sum\u00e9'),
    ];

    expect(expectAnchorMap(rawMarkdown, canonicalBlocks).blocks).toEqual([
      { ordinal: 0, kind: 'paragraph', startLine: 1, endLine: 2 },
      { ordinal: 1, kind: 'heading', startLine: 4, endLine: 4 },
    ]);
  });

  it('maps lists, tables, blockquotes, and fenced code as top-level blocks', () => {
    const rawMarkdown = [
      '- alpha',
      '- beta',
      '  - nested',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| one | two |',
      '',
      '> quoted line',
      '> continued',
      '',
      '```ts',
      'const answer = 42;',
      '```',
    ].join('\n');
    const canonicalBlocks = [
      block(0, 'bulletList', '* alpha\n* beta\n  * nested'),
      block(1, 'table', '| Name | Value |\n| --- | --- |\n| one | two |'),
      block(2, 'blockquote', '> quoted line continued'),
      block(3, 'codeBlock', '```typescript\nconst answer = 42;\n```'),
    ];

    expect(expectAnchorMap(rawMarkdown, canonicalBlocks).blocks).toEqual([
      { ordinal: 0, kind: 'list', startLine: 1, endLine: 3 },
      { ordinal: 1, kind: 'table', startLine: 5, endLine: 7 },
      { ordinal: 2, kind: 'blockquote', startLine: 9, endLine: 10 },
      { ordinal: 3, kind: 'code', startLine: 12, endLine: 14 },
    ]);
  });

  it('maps an HTML-preserved table as a table block', () => {
    const rawMarkdown = [
      '<table>',
      '  <tr><th>Name</th><th>Value</th></tr>',
      '  <tr><td colspan="2">one</td></tr>',
      '</table>',
    ].join('\n');

    expect(expectAnchorMap(rawMarkdown, [block(0, 'table', rawMarkdown)]).blocks).toEqual([
      { ordinal: 0, kind: 'table', startLine: 1, endLine: 4 },
    ]);
  });

  it('maps the webview math alias to its Markdown paragraph container', () => {
    const rawMarkdown = '$$\n\\int_0^1 x^2 dx\n$$';

    expect(expectAnchorMap(rawMarkdown, [block(0, 'math', rawMarkdown)]).blocks).toEqual([
      { ordinal: 0, kind: 'paragraph', startLine: 1, endLine: 3 },
    ]);
  });

  it('treats bullet, ordered, and task-list node kinds as equivalent list anchors', () => {
    const rawMarkdown = ['1. first', '2. second', '', '- [x] done'].join('\n');
    const canonicalBlocks = [
      block(4, 'bulletList', '- first\n- second'),
      block(7, 'taskList', '- [x] done'),
    ];

    expect(expectAnchorMap(rawMarkdown, canonicalBlocks).blocks).toEqual([
      { ordinal: 4, kind: 'list', startLine: 1, endLine: 2 },
      { ordinal: 7, kind: 'list', startLine: 4, endLine: 4 },
    ]);
  });

  it('maps wrapped YAML frontmatter as one synthetic source block', () => {
    const rawMarkdown = [
      '---',
      'title: Caf\u00e9',
      'tags: [docs, review]',
      '---',
      '',
      '# Introduction',
      '',
      'Body',
    ].join('\n');
    const canonicalBlocks = [
      block(0, 'codeBlock', '```yaml\n---\ntitle: Caf\u00e9\ntags: [docs, review]\n---\n```'),
      block(1, 'heading', '# Introduction'),
      block(2, 'paragraph', 'Body'),
    ];

    expect(expectAnchorMap(rawMarkdown, canonicalBlocks).blocks).toEqual([
      { ordinal: 0, kind: 'frontmatter', startLine: 1, endLine: 4 },
      { ordinal: 1, kind: 'heading', startLine: 6, endLine: 6 },
      { ordinal: 2, kind: 'paragraph', startLine: 8, endLine: 8 },
    ]);
  });

  it('maps leading JSON frontmatter when the canonical block identifies it', () => {
    const rawMarkdown = [
      '{',
      '  "title": "R\u00e9sum\u00e9",',
      '  "draft": true',
      '}',
      '',
      '# Introduction',
    ].join('\n');
    const canonicalBlocks = [
      block(
        0,
        'frontmatter',
        '```json\n{\n  "title": "R\u00e9sum\u00e9",\n  "draft": true\n}\n```'
      ),
      block(1, 'heading', '# Introduction'),
    ];

    expect(expectAnchorMap(rawMarkdown, canonicalBlocks).blocks).toEqual([
      { ordinal: 0, kind: 'frontmatter', startLine: 1, endLine: 4 },
      { ordinal: 1, kind: 'heading', startLine: 6, endLine: 6 },
    ]);
  });

  it('preserves non-contiguous ProseMirror ordinals in document order', () => {
    const anchorMap = expectAnchorMap('First\n\nSecond', [
      block(2, 'paragraph', 'First'),
      block(5, 'paragraph', 'Second'),
    ]);

    expect(anchorMap.blocks.map(anchor => anchor.ordinal)).toEqual([2, 5]);
  });

  it('returns the stable anchor error when block counts differ', () => {
    const result = buildFeedbackAnchorMap('# Heading\n\nBody', [block(0, 'heading', '# Heading')]);

    expect(result).toEqual({
      ok: false,
      error: {
        code: FEEDBACK_ANCHOR_ERROR_CODE,
        reason: 'block-count-mismatch',
        detail: 'Canonical block count 1 does not match raw block count 2.',
      },
    });
  });

  it('returns the stable anchor error when block kinds differ', () => {
    const result = buildFeedbackAnchorMap('# Heading', [block(0, 'paragraph', 'Plain paragraph')]);

    expect(result).toEqual({
      ok: false,
      error: {
        code: FEEDBACK_ANCHOR_ERROR_CODE,
        reason: 'block-kind-mismatch',
        detail:
          'Block ordinal 0 is paragraph in the canonical snapshot but heading in the raw source.',
      },
    });
  });

  it('rejects canonical blocks whose ordinals are duplicated or out of order', () => {
    const duplicate = buildFeedbackAnchorMap('One\n\nTwo', [
      block(1, 'paragraph', 'One'),
      block(1, 'paragraph', 'Two'),
    ]);
    const descending = buildFeedbackAnchorMap('One\n\nTwo', [
      block(2, 'paragraph', 'One'),
      block(1, 'paragraph', 'Two'),
    ]);

    expect(duplicate.ok).toBe(false);
    expect(descending.ok).toBe(false);
    if (!duplicate.ok && !descending.ok) {
      expect(duplicate.error.code).toBe(FEEDBACK_ANCHOR_ERROR_CODE);
      expect(duplicate.error.reason).toBe('invalid-canonical-order');
      expect(descending.error.reason).toBe('invalid-canonical-order');
    }
  });

  it('maps production mixed lists when two-space nested bullets split an ordered block', () => {
    const rawMarkdown = [
      '1. Ordered parent item',
      '  - Nested unordered child item one',
      '  - Nested unordered child item two',
      '    - Deeper unordered grandchild item',
      '',
      '- Unordered parent item',
      '  1. Nested ordered child one',
      '  2. Nested ordered child two',
      '    1. Deep nested ordered grandchild',
    ].join('\n');
    const canonicalBlocks = [
      block(
        58,
        'list',
        [
          '1. Ordered parent item',
          '  - Nested unordered child item one',
          '  - Nested unordered child item two',
          '    - Deeper unordered grandchild item',
        ].join('\n')
      ),
      block(
        59,
        'list',
        [
          '- Unordered parent item',
          '  1. Nested ordered child one',
          '  2. Nested ordered child two',
          '    1. Deep nested ordered grandchild',
        ].join('\n')
      ),
    ];

    expect(expectAnchorMap(rawMarkdown, canonicalBlocks).blocks).toEqual([
      { ordinal: 58, kind: 'list', startLine: 1, endLine: 4 },
      { ordinal: 59, kind: 'list', startLine: 6, endLine: 9 },
    ]);
  });

  it('rejects one canonical block that serializes as unrelated top-level blocks', () => {
    const result = buildFeedbackAnchorMap('# Heading\n\nBody', [
      block(0, 'heading', '# Heading\n\nBody'),
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(FEEDBACK_ANCHOR_ERROR_CODE);
      expect(result.error.reason).toBe('invalid-canonical-block');
      expect(result.error.detail).toBe('Block ordinal 0 produced 2 top-level Markdown blocks.');
    }
  });

  it('builds one exact map for a roughly 10,000-line snapshot', () => {
    const blockCount = 5_000;
    const sourceBlocks = Array.from({ length: blockCount }, (_, index) => `Block ${index + 1}`);
    const rawMarkdown = sourceBlocks.join('\n\n');
    const canonicalBlocks = sourceBlocks.map((markdown, ordinal) =>
      block(ordinal, 'paragraph', markdown)
    );

    const startedAt = Date.now();
    const anchorMap = expectAnchorMap(rawMarkdown, canonicalBlocks);

    expect(anchorMap.blocks).toHaveLength(blockCount);
    expect(anchorMap.blocks[0]).toEqual({
      ordinal: 0,
      kind: 'paragraph',
      startLine: 1,
      endLine: 1,
    });
    expect(anchorMap.blocks[blockCount - 1]).toEqual({
      ordinal: blockCount - 1,
      kind: 'paragraph',
      startLine: blockCount * 2 - 1,
      endLine: blockCount * 2 - 1,
    });
    // Mapping is a one-time session-start operation. This loose ceiling catches
    // accidental quadratic behavior without making the test sensitive to CI load.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe('mapFeedbackSelection', () => {
  const anchorMap = (): FeedbackAnchorMap =>
    expectAnchorMap('First\nline\n\n## Middle\n\nLast', [
      block(0, 'paragraph', 'First line'),
      block(2, 'heading', '## Middle'),
      block(5, 'paragraph', 'Last'),
    ]);

  it('returns the containing raw range for one selected block', () => {
    expect(mapFeedbackSelection(anchorMap(), 0, 0)).toEqual({
      ok: true,
      range: { startOrdinal: 0, endOrdinal: 0, startLine: 1, endLine: 2 },
    });
  });

  it('returns the exact first-to-last raw range for an ordinal span', () => {
    expect(mapFeedbackSelection(anchorMap(), 2, 5)).toEqual({
      ok: true,
      range: { startOrdinal: 2, endOrdinal: 5, startLine: 4, endLine: 6 },
    });
  });

  it('normalizes a reverse-direction ordinal selection', () => {
    expect(mapFeedbackSelection(anchorMap(), 5, 2)).toEqual({
      ok: true,
      range: { startOrdinal: 2, endOrdinal: 5, startLine: 4, endLine: 6 },
    });
  });

  it('maps a selection ending on the final block', () => {
    expect(mapFeedbackSelection(anchorMap(), 5, 5)).toEqual({
      ok: true,
      range: { startOrdinal: 5, endOrdinal: 5, startLine: 6, endLine: 6 },
    });
  });

  it('rejects ordinal endpoints that are not present in the frozen map', () => {
    const result = mapFeedbackSelection(anchorMap(), 0, 4);

    expect(result).toEqual({
      ok: false,
      error: {
        code: FEEDBACK_TARGET_ERROR_CODE,
        reason: 'selection-out-of-range',
        detail: 'Selection ordinals 0-4 do not both exist in the frozen anchor map.',
      },
    });
  });
});
