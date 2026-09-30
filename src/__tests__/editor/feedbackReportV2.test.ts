/**
 * Direct contract tests for the isolated Feedback report v2 codec.
 *
 * These tests keep the new writer and strict reader independent from the v1
 * session store until the v2 contract is ready for integration.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  FeedbackReportV2Error,
  parseFeedbackReportV2,
  renderFeedbackReportV2,
} from '../../editor/feedbackReportV2';
import {
  FEEDBACK_MAX_EXACT_CELLS_PER_ITEM_V2,
  FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2,
  FEEDBACK_MAX_TABLE_CELL_CHARACTERS_V2,
} from '../../shared/feedbackEvidenceV2';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const SNAPSHOT = {
  schema: 'md4h-feedback/v2',
  guideVersion: 2,
  state: 'sealed',
  round: '20260831T093000Z-v2r1',
  source: 'docs/guide.md',
  sourceSha256: SHA_A,
  createdAt: '2026-08-31T09:30:00.000Z',
  sealedAt: '2026-08-31T09:35:00.000Z',
} as const;

function paragraphSpan(ordinal = 0) {
  return {
    startOrdinal: ordinal,
    endOrdinal: ordinal,
    startKind: 'paragraph',
    endKind: 'paragraph',
    startBlockSha256: SHA_B,
    endBlockSha256: SHA_B,
  } as const;
}

function blockSourceItem(id = 'F1', sequence = 1) {
  const source = 'Paragraph **source**.';
  return {
    id,
    sequence,
    kind: 'text',
    startLine: 3,
    endLine: 3,
    feedback: 'Clarify this paragraph.',
    target: {
      version: 2,
      requestedScope: 'blocks',
      effectiveScope: 'blocks',
      resolution: 'exact',
      blockSpan: paragraphSpan(sequence - 1),
    },
    evidence: {
      effective: {
        kind: 'source',
        fidelity: 'source-exact',
        relationship: 'selected-blocks',
        format: 'markdown',
        normalization: 'lf',
        sourceSliceSha256: sha256(source),
        availability: 'embedded',
        text: source,
        utf8Bytes: Buffer.byteLength(source, 'utf8'),
      },
    },
  } as const;
}

function renderedItem() {
  const text = 'Close --> and -- remain evidence\n```inside```';
  return {
    id: 'F2',
    sequence: 2,
    kind: 'text',
    startLine: 7,
    endLine: 7,
    feedback: 'Keep ```feedback``` and ~~~~~ literal.',
    target: {
      version: 2,
      requestedScope: 'rendered-text',
      effectiveScope: 'rendered-text',
      resolution: 'exact',
      blockSpan: paragraphSpan(1),
      locator: {
        kind: 'rendered-range',
        value: {
          version: 1,
          startOrdinal: 1,
          startOffset: 2,
          endOrdinal: 1,
          endOffset: 48,
          startBlockSha256: SHA_B,
          endBlockSha256: SHA_B,
        },
      },
    },
    evidence: {
      effective: {
        kind: 'rendered-text',
        fidelity: 'rendered-exact',
        text,
        complete: true,
        language: 'typescript',
      },
    },
  } as const;
}

function tableCellsItem() {
  return {
    id: 'F3',
    sequence: 3,
    kind: 'text',
    startLine: 10,
    endLine: 13,
    feedback: 'Disambiguate these cells.',
    target: {
      version: 2,
      requestedScope: 'table-cells',
      effectiveScope: 'table-cells',
      resolution: 'exact',
      blockSpan: {
        ...paragraphSpan(2),
        startKind: 'table',
        endKind: 'table',
      },
      locator: {
        kind: 'table-cells',
        value: {
          version: 1,
          tableOrdinal: 2,
          rectangle: { top: 0, left: 0, bottom: 2, right: 3 },
          tableFingerprint: 'md4h-table/v1:0123456789abcdef',
          tableBlockSha256: SHA_B,
        },
      },
    },
    evidence: {
      effective: {
        kind: 'table-cells',
        fidelity: 'structured-semantic',
        complete: true,
        rows: [
          [
            { role: 'header', text: 'Name', complete: true },
            { role: 'header', text: 'Notes', complete: true },
            { role: 'header', text: '', complete: true },
          ],
          [
            { role: 'data', text: 'A\\B', complete: true },
            { role: 'data', text: 'left\tright\nnext', complete: true },
            { role: 'data', text: '', complete: true },
          ],
        ],
      },
    },
  } as const;
}

function maximalTableCellsItem(sequence: number) {
  const side = Math.sqrt(FEEDBACK_MAX_EXACT_CELLS_PER_ITEM_V2);
  if (!Number.isInteger(side)) {
    throw new Error('The exact-cell fixture requires a square item cap.');
  }
  const ordinal = sequence - 1;
  const rows = Array.from({ length: side }, (_, row) =>
    Array.from({ length: side }, (_, column) => ({
      role: row === 0 ? ('header' as const) : ('data' as const),
      text: `${row}:${column}`,
      complete: true as const,
    }))
  );
  return {
    id: `F${sequence}`,
    sequence,
    kind: 'text',
    startLine: 10,
    endLine: 13,
    feedback: 'Review this bounded cell region.',
    target: {
      version: 2,
      requestedScope: 'table-cells',
      effectiveScope: 'table-cells',
      resolution: 'exact',
      blockSpan: {
        ...paragraphSpan(ordinal),
        startKind: 'table',
        endKind: 'table',
      },
      locator: {
        kind: 'table-cells',
        value: {
          version: 1,
          tableOrdinal: ordinal,
          rectangle: { top: 0, left: 0, bottom: side, right: side },
          tableFingerprint: 'md4h-table/v1:0123456789abcdef',
          tableBlockSha256: SHA_B,
        },
      },
    },
    evidence: {
      effective: {
        kind: 'table-cells',
        fidelity: 'structured-semantic',
        complete: true,
        rows,
      },
    },
  } as const;
}

function migratedExactTableCellsItem() {
  const item = tableCellsItem();
  return {
    ...item,
    id: 'F7',
    sequence: 7,
    feedback: 'Preserve the migrated cell evidence honestly.',
    evidence: {
      effective: {
        kind: 'legacy-focus',
        fidelity: 'legacy-unclassified',
        text: 'Name\tNotes',
      },
    },
  } as const;
}

function degradedItem() {
  const source = '<table><tr><td colspan="2">Merged</td></tr></table>';
  return {
    id: 'F4',
    sequence: 4,
    kind: 'text',
    startLine: 20,
    endLine: 20,
    feedback: 'Make the merged region clearer.',
    target: {
      version: 2,
      requestedScope: 'table-cells',
      effectiveScope: 'blocks',
      resolution: 'degraded',
      coarsening: { reason: 'merged-cells', origin: 'renderer' },
      blockSpan: {
        ...paragraphSpan(3),
        startKind: 'table',
        endKind: 'table',
      },
    },
    evidence: {
      effective: {
        kind: 'source',
        fidelity: 'source-exact',
        relationship: 'containing-blocks',
        format: 'html',
        normalization: 'lf',
        sourceSliceSha256: sha256(source),
        availability: 'embedded',
        text: source,
        utf8Bytes: Buffer.byteLength(source, 'utf8'),
      },
      original: {
        kind: 'semantic-text',
        fidelity: 'semantic-context',
        text: 'Merged',
        complete: true,
        provenance: 'renderer-fallback',
      },
    },
  } as const;
}

function legacyUnknownItem() {
  const source = 'Legacy paragraph.';
  return {
    id: 'F5',
    sequence: 5,
    kind: 'text',
    startLine: 25,
    endLine: 25,
    feedback: 'Retain the old note honestly.',
    target: {
      version: 2,
      effectiveScope: 'blocks',
      resolution: 'legacy-unknown',
      legacyOrigin: 'v1-no-locator',
      blockSpan: paragraphSpan(4),
    },
    evidence: {
      effective: {
        kind: 'source',
        fidelity: 'source-exact',
        relationship: 'containing-blocks',
        format: 'markdown',
        normalization: 'lf',
        sourceSliceSha256: sha256(source),
        availability: 'embedded',
        text: source,
        utf8Bytes: Buffer.byteLength(source, 'utf8'),
      },
      original: {
        kind: 'legacy-focus',
        fidelity: 'legacy-unclassified',
        text: 'Legacy paragraph.',
      },
    },
  } as const;
}

function omittedSourceItem() {
  return {
    id: 'F6',
    sequence: 6,
    kind: 'text',
    startLine: 30,
    endLine: 40,
    feedback: 'Review the referenced source.',
    target: {
      version: 2,
      requestedScope: 'blocks',
      effectiveScope: 'blocks',
      resolution: 'exact',
      blockSpan: paragraphSpan(5),
    },
    evidence: {
      effective: {
        kind: 'source',
        fidelity: 'source-reference',
        relationship: 'selected-blocks',
        format: 'markdown',
        normalization: 'lf',
        sourceSliceSha256: SHA_C,
        availability: 'omitted',
        omittedReason: 'evidence-budget',
        omittedUtf8Bytes: 70_000,
      },
    },
  } as const;
}

function getMetadataLines(report: string): string[] {
  return report.split('\n').filter(line => line.startsWith('<!-- md4h-') && line.endsWith(' -->'));
}

function extractItemSection(report: string, id: string): string {
  const heading = `## ${id} ·`;
  const start = report.indexOf(heading);
  if (start < 0) throw new Error(`Missing report section ${id}.`);
  const next = report.indexOf('\n## F', start + heading.length);
  return `${report.slice(start, next < 0 ? report.length : next).trimEnd()}\n`;
}

describe('Feedback report v2 writer', () => {
  it('writes an exact header, canonical metadata, visible summaries, and round-trips', () => {
    const items = [
      blockSourceItem(),
      renderedItem(),
      tableCellsItem(),
      degradedItem(),
      legacyUnknownItem(),
      omittedSourceItem(),
    ];
    const report = renderFeedbackReportV2(SNAPSHOT, [...items].reverse(), 7);

    expect(report).toContain(
      [
        '---',
        'schema: md4h-feedback/v2',
        'guide_version: 2',
        'state: sealed',
        'round: 20260831T093000Z-v2r1',
        'source: "docs/guide.md"',
        'source_base: workspace',
        `source_sha256: ${SHA_A}`,
        'line_numbering: one-based-inclusive',
        'created_at: "2026-08-31T09:30:00.000Z"',
        'next_id: F7',
        'sealed_at: "2026-08-31T09:35:00.000Z"',
        '---',
      ].join('\n')
    );
    expect(report.indexOf('## F1 · text')).toBeLessThan(report.indexOf('## F6 · text'));
    expect(report).toContain('**Target:** Whole paragraph · exact · block 1');
    expect(report).toContain('**Fidelity:** Frozen source');
    expect(report).toContain('**Target:** Selected rendered text · exact');
    expect(report).toContain('**Language:** `typescript`');
    expect(report).toContain('### Cell matrix');
    expect(report).toContain('### Selected cells (escaped TSV)');
    expect(report).toContain('A\\\\B\tleft\\tright\\nnext\t');
    expect(report).toContain(
      '**Target:** Selected table cells to whole table · degraded · merged cells (renderer reported)'
    );
    expect(report).toContain('### Original selection');
    expect(report).toContain(
      '**Target:** Legacy unclassified selection · containing whole paragraph · block 5'
    );
    expect(report).toContain('**Fidelity:** Source omitted by evidence budget');
    expect(report).toContain(`**Source slice SHA-256:** \`${SHA_C}\``);
    expect(report).not.toContain('**Focus:**');

    const parsed = parseFeedbackReportV2(report);
    expect(parsed).toEqual({ snapshot: SNAPSHOT, items, nextSequence: 7 });
  });

  it('round-trips the persisted legacy-focus exception for an exact migrated cell target', () => {
    const item = migratedExactTableCellsItem();
    const report = renderFeedbackReportV2(SNAPSHOT, [item], 8);

    expect(report).toContain('**Target:** Selected table cells · exact');
    expect(report).toContain('**Fidelity:** Legacy Focus');
    expect(report).toContain('### Evidence\n\n```text\nName\tNotes\n```');
    expect(parseFeedbackReportV2(report).items[0]).toEqual(item);

    const nonMigrationEvidence = {
      ...item,
      evidence: {
        effective: {
          kind: 'semantic-text',
          fidelity: 'semantic-context',
          text: 'Name Notes',
          complete: true,
          provenance: 'renderer-fallback',
        },
      },
    } as const;
    expect(() => renderFeedbackReportV2(SNAPSHOT, [nonMigrationEvidence], 8)).toThrow(
      FeedbackReportV2Error
    );
  });

  it('keeps hostile evidence only in adaptive fenced bodies', () => {
    const item = renderedItem();
    const report = renderFeedbackReportV2(SNAPSHOT, [item], 3);
    const metadataLines = getMetadataLines(report);

    expect(metadataLines).toHaveLength(2);
    expect(metadataLines.every(line => Buffer.byteLength(line, 'utf8') <= 2 * 1024)).toBe(true);
    expect(metadataLines.every(line => !line.slice(4, -4).includes('--'))).toBe(true);
    expect(metadataLines.join('\n')).not.toContain(item.evidence.effective.text);
    expect(report).toContain('````text\nClose --> and -- remain evidence\n```inside```\n````');
    expect(report).toContain('````markdown\nKeep ```feedback``` and ~~~~~ literal.\n````');

    expect(parseFeedbackReportV2(report).items[0]).toEqual(item);
  });

  it('rejects invalid IDs, duplicate sequences, incompatible evidence, and unsafe metadata', () => {
    const invalidItems = [
      [{ ...blockSourceItem(), id: 'F01' }],
      [blockSourceItem(), { ...renderedItem(), id: 'F1' }],
      [blockSourceItem(), { ...renderedItem(), sequence: 1 }],
      [
        {
          ...blockSourceItem(),
          evidence: { effective: renderedItem().evidence.effective },
        },
      ],
      [
        {
          ...blockSourceItem(),
          target: { ...blockSourceItem().target, unexpected: true },
        },
      ],
    ];

    const failures = invalidItems.map(items => {
      try {
        renderFeedbackReportV2(SNAPSHOT, items, 7);
        return false;
      } catch (error) {
        return error instanceof FeedbackReportV2Error;
      }
    });
    expect(failures).toEqual(invalidItems.map(() => true));
  });

  it('omits an unsafe optional language token before writing metadata', () => {
    const item = renderedItem();
    const unsafe = {
      ...item,
      evidence: {
        effective: { ...item.evidence.effective, language: 'ts--unsafe' },
      },
    };

    const report = renderFeedbackReportV2(SNAPSHOT, [unsafe], 3);
    expect(report).not.toContain('ts--unsafe');
    expect(parseFeedbackReportV2(report).items[0].evidence.effective).not.toHaveProperty(
      'language'
    );
  });

  it('applies the shared textual-evidence budget to table cell text', () => {
    const rows = Array.from({ length: 16 }, () =>
      Array.from({ length: 16 }, () => ({
        role: 'data' as const,
        text: '😀'.repeat(70),
        complete: true as const,
      }))
    );
    const item = tableCellsItem();
    const oversized = {
      ...item,
      target: {
        ...item.target,
        locator: {
          ...item.target.locator,
          value: {
            ...item.target.locator.value,
            rectangle: { top: 0, left: 0, bottom: 16, right: 16 },
          },
        },
      },
      evidence: {
        effective: { ...item.evidence.effective, rows },
      },
    };

    expect(() => renderFeedbackReportV2(SNAPSHOT, [oversized], 4)).toThrow(FeedbackReportV2Error);
  });

  it('accepts the shared 240-code-point cell boundary including astral Unicode', () => {
    const text = '😀'.repeat(FEEDBACK_MAX_TABLE_CELL_CHARACTERS_V2);
    const item = tableCellsItem();
    const atLimit = {
      ...item,
      target: {
        ...item.target,
        locator: {
          ...item.target.locator,
          value: {
            ...item.target.locator.value,
            rectangle: { top: 0, left: 0, bottom: 1, right: 1 },
          },
        },
      },
      evidence: {
        effective: {
          ...item.evidence.effective,
          rows: [[{ role: 'data' as const, text, complete: true as const }]],
        },
      },
    };

    expect(Array.from(text)).toHaveLength(FEEDBACK_MAX_TABLE_CELL_CHARACTERS_V2);
    const report = renderFeedbackReportV2(SNAPSHOT, [atLimit], 4);
    expect(parseFeedbackReportV2(report).items[0]).toEqual(atLimit);

    const overLimit = {
      ...atLimit,
      evidence: {
        effective: {
          ...atLimit.evidence.effective,
          rows: [[{ role: 'data' as const, text: `${text}😀`, complete: true as const }]],
        },
      },
    };
    expect(() => renderFeedbackReportV2(SNAPSHOT, [overLimit], 4)).toThrow(FeedbackReportV2Error);
  });

  it('rejects reports whose serialized evidence exceeds the actual LF line limit', () => {
    const evidence = '\n'.repeat(64 * 1024);
    const items = Array.from({ length: 19 }, (_, index) => {
      const sequence = index + 1;
      const base = renderedItem();
      return {
        ...base,
        id: `F${sequence}`,
        sequence,
        target: {
          ...base.target,
          blockSpan: paragraphSpan(index),
          locator: {
            kind: 'rendered-range' as const,
            value: {
              ...base.target.locator.value,
              startOrdinal: index,
              startOffset: 0,
              endOrdinal: index,
              endOffset: 1,
            },
          },
        },
        evidence: {
          effective: {
            ...base.evidence.effective,
            text: evidence,
          },
        },
      };
    });

    expect(() => renderFeedbackReportV2(SNAPSHOT, items, 20)).toThrow(/line limit/i);
  });

  it('enforces the aggregate embedded-source budget across the report', () => {
    const source = 'x'.repeat(64 * 1024);
    const items = Array.from({ length: 17 }, (_, index) => {
      const sequence = index + 1;
      const base = blockSourceItem(`F${sequence}`, sequence);
      return {
        ...base,
        evidence: {
          effective: {
            ...base.evidence.effective,
            sourceSliceSha256: sha256(source),
            text: source,
            utf8Bytes: Buffer.byteLength(source, 'utf8'),
          },
        },
      };
    });

    expect(() => renderFeedbackReportV2(SNAPSHOT, items, 18)).toThrow(FeedbackReportV2Error);
  });

  it('enforces the aggregate exact-cell budget in both the writer and strict parser', () => {
    const itemCountAtLimit =
      FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2 / FEEDBACK_MAX_EXACT_CELLS_PER_ITEM_V2;
    expect(Number.isInteger(itemCountAtLimit)).toBe(true);
    const atLimitItems = Array.from({ length: itemCountAtLimit }, (_, index) =>
      maximalTableCellsItem(index + 1)
    );
    const nextSequence = itemCountAtLimit + 2;
    const atLimitReport = renderFeedbackReportV2(SNAPSHOT, atLimitItems, nextSequence);
    expect(parseFeedbackReportV2(atLimitReport).items).toHaveLength(itemCountAtLimit);

    const overLimitItem = maximalTableCellsItem(itemCountAtLimit + 1);
    expect(() =>
      renderFeedbackReportV2(SNAPSHOT, [...atLimitItems, overLimitItem], nextSequence)
    ).toThrow(/4,096|exact cell/i);

    const extraCanonicalSection = extractItemSection(atLimitReport, `F${itemCountAtLimit}`).replace(
      `## F${itemCountAtLimit} ·`,
      `## F${itemCountAtLimit + 1} ·`
    );
    const overLimitReport = `${atLimitReport.trimEnd()}\n\n${extraCanonicalSection}`;
    expect(() => parseFeedbackReportV2(overLimitReport)).toThrow(/4,096|exact cell/i);
  });

  it('matches every locked v2 golden item section, including screenshots', () => {
    const fixtureRoot = resolve(__dirname, '../fixtures/feedback-evidence-v2');
    const fixture = JSON.parse(readFileSync(resolve(fixtureRoot, 'cases.json'), 'utf8')) as {
      cases: Array<{
        name: string;
        expected: string;
        source:
          | { kind: 'fixture'; file: string }
          | { kind: 'generated-oversized-code'; character: string; repetitions: number };
        item: { id: string; sequence: number } & Record<string, unknown>;
      }>;
    };

    const mismatches: string[] = [];
    for (const contractCase of fixture.cases) {
      const source =
        contractCase.source.kind === 'fixture'
          ? readFileSync(resolve(fixtureRoot, contractCase.source.file), 'utf8')
          : `\`\`\`text\n${contractCase.source.character.repeat(
              contractCase.source.repetitions
            )}\n\`\`\``;
      const report = renderFeedbackReportV2(
        {
          ...SNAPSHOT,
          round: '20260831T093000Z-v2c1',
          source: `docs/${contractCase.name}.md`,
          sourceSha256: sha256(source),
        },
        [contractCase.item],
        contractCase.item.sequence + 1
      );
      const expected = readFileSync(resolve(fixtureRoot, contractCase.expected), 'utf8');
      if (extractItemSection(report, contractCase.item.id) !== expected) {
        mismatches.push(contractCase.name);
      }
      expect(parseFeedbackReportV2(report).items).toHaveLength(1);
    }
    expect(mismatches).toEqual([]);
  });
});

describe('Feedback report v2 strict parser', () => {
  const report = renderFeedbackReportV2(
    SNAPSHOT,
    [blockSourceItem(), renderedItem(), tableCellsItem(), degradedItem()],
    5
  );

  it.each([
    ['unknown schema', (value: string) => value.replace('md4h-feedback/v2', 'md4h-feedback/v3')],
    ['missing guide version', (value: string) => value.replace('guide_version: 2\n', '')],
    [
      'extra frontmatter key',
      (value: string) => value.replace('state: sealed\n', 'state: sealed\nunexpected: true\n'),
    ],
    [
      'non-canonical frontmatter order',
      (value: string) =>
        value.replace(
          'schema: md4h-feedback/v2\nguide_version: 2',
          'guide_version: 2\nschema: md4h-feedback/v2'
        ),
    ],
    [
      'unsafe metadata comment',
      (value: string) => value.replace('"requestedScope":"blocks"', '"requestedScope":"blo--cks"'),
    ],
    [
      'closed metadata comment',
      (value: string) => value.replace('"requestedScope":"blocks"', '"requestedScope":"blo-->cks"'),
    ],
    [
      'metadata newline',
      (value: string) => value.replace('"requestedScope":"blocks"', '"requestedScope":\n"blocks"'),
    ],
    [
      'extra target key',
      (value: string) =>
        value.replace('"version":2,"requestedScope"', '"version":2,"extra":true,"requestedScope"'),
    ],
    [
      'non-canonical target JSON',
      (value: string) =>
        value.replace('{"version":2,"requestedScope"', '{ "version":2,"requestedScope"'),
    ],
    [
      'visible target mismatch',
      (value: string) => value.replace('**Target:** Whole paragraph', '**Target:** Whole heading'),
    ],
    [
      'visible fidelity mismatch',
      (value: string) =>
        value.replace('**Fidelity:** Frozen source', '**Fidelity:** Exact rendered text'),
    ],
    [
      'source evidence body mismatch',
      (value: string) => value.replace('Paragraph **source**.', 'Paragraph **tampered**.'),
    ],
    [
      'matrix body mismatch',
      (value: string) => value.replace('"text": "Name"', '"text": "Changed"'),
    ],
    [
      'TSV projection mismatch',
      (value: string) => value.replace('Name\tNotes\t', 'Name\tChanged\t'),
    ],
    [
      'feedback body mismatch grammar',
      (value: string) => value.replace('### Feedback', '### Instruction'),
    ],
  ])('rejects %s', (_label, tamper) => {
    expect(() => parseFeedbackReportV2(tamper(report))).toThrow(FeedbackReportV2Error);
  });

  it('rejects metadata above 2 KiB before interpreting it', () => {
    const metadataLine = getMetadataLines(report)[0];
    const oversized = report.replace(
      metadataLine,
      metadataLine.replace(' -->', `${'x'.repeat(2_049)} -->`)
    );

    expect(() => parseFeedbackReportV2(oversized)).toThrow(FeedbackReportV2Error);
  });
});
