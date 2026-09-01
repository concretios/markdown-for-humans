/**
 * Direct unit contract for scope-first Feedback evidence v2.
 *
 * These tests keep renderer input strictly poorer than host-owned persisted
 * state and bind the pure codec to the report fixtures before integration.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  FEEDBACK_GUIDE_VERSION_V2,
  FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2,
  FEEDBACK_MAX_METADATA_BYTES_V2,
  FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2,
  FEEDBACK_SCHEMA_V2,
  escapeFeedbackTsvCellV2,
  feedbackEmbeddedSourceBytesV2,
  feedbackEvidenceDescriptorV2,
  feedbackEvidenceEnvelopeDescriptorV2,
  feedbackEvidenceEnvelopeTextBytesV2,
  feedbackTextualEvidenceBytesV2,
  feedbackUtf8ByteLengthV2,
  isFeedbackEmbeddedSourceBudgetWithinLimitV2,
  isFeedbackRendererTargetEvidenceCompatibleV2,
  isFeedbackTargetEvidenceCompatibleV2,
  parseFeedbackEvidenceEnvelopeV2,
  parseFeedbackRendererEvidenceV2,
  parseFeedbackRendererTargetV2,
  parseFeedbackTargetV2,
  renderFeedbackFencedBlockV2,
  renderFeedbackTableCellsTsvV2,
  type FeedbackEvidenceEnvelopeV2,
} from '../../shared/feedbackEvidenceV2';

interface FixtureCase {
  name: string;
  item: {
    target: unknown;
    evidence: unknown;
  };
}

interface FixtureFile {
  version: 1;
  cases: FixtureCase[];
}

const FIXTURES = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures/feedback-evidence-v2/cases.json'), 'utf8')
) as FixtureFile;

const SHA256 = 'a'.repeat(64);
const TABLE_FINGERPRINT = 'md4h-table/v1:0123456789abcdef';

function renderedRangeInput() {
  return {
    version: 1,
    startOrdinal: 2,
    startOffset: 3,
    endOrdinal: 2,
    endOffset: 8,
  } as const;
}

function cellTargetInput() {
  return {
    version: 1,
    tableOrdinal: 4,
    rectangle: { top: 0, left: 0, bottom: 2, right: 2 },
    tableFingerprint: TABLE_FINGERPRINT,
  } as const;
}

function blockSpan(kind: 'paragraph' | 'table' = 'paragraph') {
  return {
    startOrdinal: kind === 'table' ? 4 : 2,
    endOrdinal: kind === 'table' ? 4 : 2,
    startKind: kind,
    endKind: kind,
    startBlockSha256: SHA256,
    endBlockSha256: SHA256,
  } as const;
}

function renderedTarget() {
  return {
    version: 2,
    requestedScope: 'rendered-text',
    effectiveScope: 'rendered-text',
    resolution: 'exact',
    blockSpan: blockSpan(),
    locator: {
      kind: 'rendered-range',
      value: {
        ...renderedRangeInput(),
        startBlockSha256: SHA256,
        endBlockSha256: SHA256,
      },
    },
  } as const;
}

function renderedEvidence(text = 'exact text', language?: string) {
  return {
    kind: 'rendered-text',
    fidelity: 'rendered-exact',
    text,
    complete: true,
    ...(language === undefined ? {} : { language }),
  } as const;
}

describe('Feedback evidence v2 constants', () => {
  it('locks the schema, guide, and byte budgets', () => {
    expect({
      schema: FEEDBACK_SCHEMA_V2,
      guide: FEEDBACK_GUIDE_VERSION_V2,
      itemBytes: FEEDBACK_MAX_TEXTUAL_EVIDENCE_BYTES_V2,
      sourceBytes: FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2,
      metadataBytes: FEEDBACK_MAX_METADATA_BYTES_V2,
    }).toEqual({
      schema: 'md4h-feedback/v2',
      guide: 2,
      itemBytes: 64 * 1024,
      sourceBytes: 1024 * 1024,
      metadataBytes: 2 * 1024,
    });
  });
});

describe('Feedback evidence v2 renderer trust boundary', () => {
  it('parses exact block, rendered-text, and table-cell requests', () => {
    const targets = [
      { version: 2, requestedScope: 'blocks' },
      {
        version: 2,
        requestedScope: 'rendered-text',
        locator: { kind: 'rendered-range', value: renderedRangeInput() },
      },
      {
        version: 2,
        requestedScope: 'table-cells',
        locator: { kind: 'table-cells', value: cellTargetInput() },
      },
    ];

    expect(targets.map(parseFeedbackRendererTargetV2)).toEqual(targets);
  });

  it('parses compatible renderer constraints without accepting host provenance', () => {
    const constrained = [
      {
        version: 2,
        requestedScope: 'rendered-text',
        constraint: { reason: 'unmappable-range' },
      },
      {
        version: 2,
        requestedScope: 'table-cells',
        constraint: { reason: 'merged-cells' },
      },
      {
        version: 2,
        requestedScope: 'visual-region',
        constraint: { reason: 'opaque-node' },
      },
    ];

    expect(constrained.map(parseFeedbackRendererTargetV2)).toEqual(constrained);
    expect(
      parseFeedbackRendererTargetV2({
        ...constrained[0],
        constraint: { reason: 'stale-locator', origin: 'host' },
      })
    ).toBeNull();
  });

  it('rejects host-owned, competing, oversized, and scope-incompatible target fields', () => {
    const base = {
      version: 2,
      requestedScope: 'rendered-text',
      locator: { kind: 'rendered-range', value: renderedRangeInput() },
    };
    const malformed = [
      { ...base, effectiveScope: 'rendered-text' },
      { ...base, resolution: 'exact' },
      { ...base, blockSpan: blockSpan() },
      {
        ...base,
        locator: {
          kind: 'rendered-range',
          value: { ...renderedRangeInput(), startBlockSha256: SHA256 },
        },
      },
      { ...base, constraint: { reason: 'unmappable-range' } },
      { ...base, requestedScope: 'blocks' },
      { version: 2, requestedScope: 'rendered-text' },
      {
        version: 2,
        requestedScope: 'table-cells',
        constraint: { reason: 'unmappable-range' },
      },
      { version: 2, requestedScope: 'legacy-unknown' },
      { version: 2, requestedScope: 'blocks', extra: true },
    ];

    expect(malformed.map(parseFeedbackRendererTargetV2)).toEqual(malformed.map(() => null));
  });

  it('parses bounded renderer evidence and omits unsafe optional languages', () => {
    const rendered = {
      kind: 'rendered-text',
      text: 'λ exact',
      complete: true,
      language: 'typescript',
    };
    const cells = {
      kind: 'table-cells',
      complete: false,
      rows: [
        [
          { role: 'header', text: 'Name', complete: true },
          { role: 'header', text: 'Notes', complete: true },
        ],
        [
          { role: 'data', text: 'A\\B', complete: true },
          { role: 'data', text: 'bounded', complete: false },
        ],
      ],
    };

    expect(parseFeedbackRendererEvidenceV2(rendered)).toEqual(rendered);
    expect(parseFeedbackRendererEvidenceV2(cells)).toEqual(cells);
    expect(parseFeedbackRendererEvidenceV2({ ...rendered, language: 'ts--unsafe\n' })).toEqual({
      kind: 'rendered-text',
      text: 'λ exact',
      complete: true,
    });
  });

  it('rejects source evidence, controls, ragged cells, false exactness, and UTF-8 overflow', () => {
    const malformed = [
      { kind: 'source', text: 'renderer source' },
      { kind: 'rendered-text', text: '\u0000unsafe', complete: true },
      { kind: 'rendered-text', text: 'not complete', complete: false },
      { kind: 'rendered-text', text: 'λ'.repeat(32_769), complete: true },
      {
        kind: 'table-cells',
        complete: true,
        rows: [
          [{ role: 'header', text: 'A', complete: true }],
          [
            { role: 'data', text: 'B', complete: true },
            { role: 'data', text: 'C', complete: true },
          ],
        ],
      },
      {
        kind: 'table-cells',
        complete: true,
        rows: [[{ role: 'column-header', text: 'A', complete: true }]],
      },
      {
        kind: 'table-cells',
        complete: true,
        rows: [[{ role: 'data', text: 'incomplete', complete: false }]],
      },
      { kind: 'semantic-text', text: 'fallback', complete: true, extra: true },
    ];

    expect(malformed.map(parseFeedbackRendererEvidenceV2)).toEqual(malformed.map(() => null));
  });

  it('cross-validates renderer target, locator, matrix, and evidence kinds', () => {
    const block = parseFeedbackRendererTargetV2({ version: 2, requestedScope: 'blocks' });
    const exactText = parseFeedbackRendererTargetV2({
      version: 2,
      requestedScope: 'rendered-text',
      locator: { kind: 'rendered-range', value: renderedRangeInput() },
    });
    const exactCells = parseFeedbackRendererTargetV2({
      version: 2,
      requestedScope: 'table-cells',
      locator: { kind: 'table-cells', value: cellTargetInput() },
    });
    const text = parseFeedbackRendererEvidenceV2({
      kind: 'rendered-text',
      text: 'exact',
      complete: true,
    });
    const cells = parseFeedbackRendererEvidenceV2({
      kind: 'table-cells',
      complete: true,
      rows: [
        [
          { role: 'header', text: 'A', complete: true },
          { role: 'header', text: 'B', complete: true },
        ],
        [
          { role: 'data', text: '1', complete: true },
          { role: 'data', text: '2', complete: true },
        ],
      ],
    });
    if (!block || !exactText || !exactCells || !text || !cells) {
      throw new Error('Expected valid renderer fixtures.');
    }

    expect([
      isFeedbackRendererTargetEvidenceCompatibleV2(block, undefined),
      isFeedbackRendererTargetEvidenceCompatibleV2(exactText, text),
      isFeedbackRendererTargetEvidenceCompatibleV2(exactCells, cells),
      isFeedbackRendererTargetEvidenceCompatibleV2(exactText, cells),
      isFeedbackRendererTargetEvidenceCompatibleV2(exactCells, text),
      isFeedbackRendererTargetEvidenceCompatibleV2(block, text),
    ]).toEqual([true, true, true, false, false, false]);
  });
});

describe('Feedback evidence v2 persisted contract', () => {
  it.each(FIXTURES.cases)('parses and canonically clones fixture target $name', contractCase => {
    const parsed = parseFeedbackTargetV2(contractCase.item.target);

    expect(parsed).not.toBeNull();
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(contractCase.item.target));
  });

  it.each(FIXTURES.cases)('parses and canonically clones fixture evidence $name', contractCase => {
    const parsed = parseFeedbackEvidenceEnvelopeV2(contractCase.item.evidence);

    expect(parsed).not.toBeNull();
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(contractCase.item.evidence));
  });

  it.each(FIXTURES.cases)('accepts the locked target/evidence pairing for $name', contractCase => {
    const target = parseFeedbackTargetV2(contractCase.item.target);
    const evidence = parseFeedbackEvidenceEnvelopeV2(contractCase.item.evidence);
    if (!target || !evidence) throw new Error(`Invalid locked fixture ${contractCase.name}.`);

    expect(isFeedbackTargetEvidenceCompatibleV2(target, evidence)).toBe(true);
  });

  it('retains an exact migrated cell locator only with explicitly tagged legacy evidence', () => {
    const target = parseFeedbackTargetV2({
      version: 2,
      requestedScope: 'table-cells',
      effectiveScope: 'table-cells',
      resolution: 'exact',
      blockSpan: blockSpan('table'),
      locator: {
        kind: 'table-cells',
        value: { ...cellTargetInput(), tableBlockSha256: SHA256 },
      },
    });
    const legacy = parseFeedbackEvidenceEnvelopeV2({
      effective: {
        kind: 'legacy-focus',
        fidelity: 'legacy-unclassified',
        text: 'Name\tNotes',
      },
    });
    const semantic = parseFeedbackEvidenceEnvelopeV2({
      effective: {
        kind: 'semantic-text',
        fidelity: 'semantic-context',
        text: 'Name Notes',
        complete: true,
        provenance: 'renderer-fallback',
      },
    });
    if (!target || !legacy || !semantic) throw new Error('Expected valid migration fixtures.');

    expect(isFeedbackTargetEvidenceCompatibleV2(target, legacy)).toBe(true);
    expect(isFeedbackTargetEvidenceCompatibleV2(target, semantic)).toBe(false);
    expect(
      parseFeedbackRendererEvidenceV2({
        kind: 'legacy-focus',
        fidelity: 'legacy-unclassified',
        text: 'Name\tNotes',
      })
    ).toBeNull();
  });

  it('rejects malformed target unions and locator/hash mismatches', () => {
    const base = renderedTarget();
    const malformed = [
      { ...base, requestedScope: 'blocks' },
      { ...base, effectiveScope: 'blocks' },
      { ...base, coarsening: { reason: 'stale-locator', origin: 'host' } },
      { ...base, unexpected: true },
      {
        ...base,
        blockSpan: { ...base.blockSpan, endOrdinal: 1 },
      },
      {
        ...base,
        locator: {
          ...base.locator,
          value: { ...base.locator.value, startBlockSha256: 'b'.repeat(64) },
        },
      },
      {
        version: 2,
        requestedScope: 'blocks',
        effectiveScope: 'blocks',
        resolution: 'degraded',
        coarsening: { reason: 'unsupported-block', origin: 'host' },
        blockSpan: blockSpan(),
      },
      {
        version: 2,
        effectiveScope: 'blocks',
        resolution: 'legacy-unknown',
        legacyOrigin: 'v1-no-locator',
        requestedScope: 'blocks',
        blockSpan: blockSpan(),
      },
    ];

    expect(malformed.map(parseFeedbackTargetV2)).toEqual(malformed.map(() => null));
  });

  it('rejects evidence descriptor/body mismatches, controls, extra keys, and shared overflow', () => {
    const exact = renderedEvidence('exact text');
    const malformed = [
      { effective: { ...exact, complete: false } },
      { effective: { ...exact, text: 'unsafe\rtext' } },
      { effective: { ...exact, extra: true } },
      { effective: renderedEvidence('λ'.repeat(32_769)) },
      {
        effective: renderedEvidence('x'.repeat(40_000)),
        original: {
          kind: 'legacy-focus',
          fidelity: 'legacy-unclassified',
          text: 'y'.repeat(30_000),
        },
      },
      {
        effective: {
          kind: 'source',
          fidelity: 'source-exact',
          relationship: 'selected-blocks',
          format: 'markdown',
          normalization: 'lf',
          sourceSliceSha256: SHA256,
          availability: 'embedded',
          text: 'λ',
          utf8Bytes: 1,
        },
      },
    ];

    expect(malformed.map(parseFeedbackEvidenceEnvelopeV2)).toEqual(malformed.map(() => null));
  });

  it('bounds visual evidence paths, hashes, dimensions, and total pixels', () => {
    const visual = {
      effective: {
        kind: 'visual',
        fidelity: 'visual-exact',
        assetRelativePath: 'assets/F14.png',
        assetSha256: SHA256,
        width: 4_000,
        height: 3_000,
        sourceReference: {
          relationship: 'containing-blocks',
          format: 'markdown',
          normalization: 'lf',
          sourceSliceSha256: SHA256,
        },
      },
    };

    expect(parseFeedbackEvidenceEnvelopeV2(visual)).toEqual(visual);
    expect(
      [
        { ...visual.effective, assetRelativePath: '../F14.png' },
        { ...visual.effective, assetSha256: 'a'.repeat(63) },
        { ...visual.effective, width: 0 },
        { ...visual.effective, width: 4_001 },
      ].map(effective => parseFeedbackEvidenceEnvelopeV2({ effective }))
    ).toEqual([null, null, null, null]);
  });

  it('sanitizes optional persisted language without weakening required evidence', () => {
    expect(
      parseFeedbackEvidenceEnvelopeV2({
        effective: renderedEvidence('exact', 'ts--unsafe'),
      })
    ).toEqual({ effective: renderedEvidence('exact') });
  });
});

describe('Feedback evidence v2 canonical helpers and budgets', () => {
  it('counts UTF-8 without relying on a TextEncoder webview global', () => {
    const globals = globalThis as typeof globalThis & { TextEncoder?: typeof TextEncoder };
    const descriptor = Object.getOwnPropertyDescriptor(globals, 'TextEncoder');
    Object.defineProperty(globals, 'TextEncoder', { configurable: true, value: undefined });
    try {
      expect([
        feedbackUtf8ByteLengthV2('ASCII'),
        feedbackUtf8ByteLengthV2('λ'),
        feedbackUtf8ByteLengthV2('😀'),
        feedbackUtf8ByteLengthV2('\ud800'),
        feedbackUtf8ByteLengthV2('\udc00'),
      ]).toEqual([5, 2, 4, 3, 3]);
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globals, 'TextEncoder');
      } else {
        Object.defineProperty(globals, 'TextEncoder', descriptor);
      }
    }
  });

  it('keeps user-controlled text out of evidence descriptors', () => {
    const envelope = parseFeedbackEvidenceEnvelopeV2({
      effective: renderedEvidence('Close --> and -- remain literal', 'typescript'),
      original: {
        kind: 'semantic-text',
        fidelity: 'semantic-context',
        text: 'original -- text',
        complete: true,
        provenance: 'renderer-fallback',
      },
    });
    if (!envelope) throw new Error('Expected valid evidence envelope.');

    expect(feedbackEvidenceDescriptorV2(envelope.effective)).toEqual({
      kind: 'rendered-text',
      fidelity: 'rendered-exact',
      complete: true,
      language: 'typescript',
    });
    const descriptor = feedbackEvidenceEnvelopeDescriptorV2(envelope);
    expect(JSON.stringify(descriptor)).not.toContain('Close -->');
    expect(feedbackUtf8ByteLengthV2(JSON.stringify(descriptor))).toBeLessThanOrEqual(
      FEEDBACK_MAX_METADATA_BYTES_V2
    );
  });

  it('counts UTF-8 textual evidence across effective and original bodies', () => {
    const envelope = parseFeedbackEvidenceEnvelopeV2({
      effective: renderedEvidence('λ'.repeat(100)),
      original: {
        kind: 'legacy-focus',
        fidelity: 'legacy-unclassified',
        text: 'abc',
      },
    });
    if (!envelope) throw new Error('Expected valid evidence envelope.');

    expect(feedbackUtf8ByteLengthV2('λ'.repeat(100))).toBe(200);
    expect(feedbackTextualEvidenceBytesV2(envelope.effective)).toBe(200);
    expect(feedbackEvidenceEnvelopeTextBytesV2(envelope)).toBe(203);
  });

  it('counts aggregate embedded source only and enforces the exact 1 MiB boundary', () => {
    const sourceEnvelope = (text: string): FeedbackEvidenceEnvelopeV2 => ({
      effective: {
        kind: 'source',
        fidelity: 'source-exact',
        relationship: 'selected-blocks',
        format: 'markdown',
        normalization: 'lf',
        sourceSliceSha256: SHA256,
        availability: 'embedded',
        text,
        utf8Bytes: feedbackUtf8ByteLengthV2(text),
      },
    });
    const envelopes = Array.from({ length: 16 }, () => sourceEnvelope('x'.repeat(64 * 1024)));

    expect(feedbackEmbeddedSourceBytesV2(envelopes)).toBe(
      FEEDBACK_MAX_EMBEDDED_SOURCE_BYTES_PER_SESSION_V2
    );
    expect(isFeedbackEmbeddedSourceBudgetWithinLimitV2(envelopes)).toBe(true);
    expect(isFeedbackEmbeddedSourceBudgetWithinLimitV2([...envelopes, sourceEnvelope('x')])).toBe(
      false
    );
  });

  it('renders adaptive fences that cannot close on their evidence body', () => {
    const body = '~~~~JavaScript\nconst fence = "```";\n~~~~';
    const rendered = renderFeedbackFencedBlockV2('markdown', body);
    const [opener, ...rest] = rendered.split('\n');
    const closer = rest.at(-1);

    expect(opener).toBe('````markdown');
    expect(closer).toBe('````');
    expect(rendered).toContain(body);
  });

  it('prefers conventional backticks for a one-character fence near-tie', () => {
    const body = '```mermaid\nflowchart LR\n  Start --> Finish\n```';

    expect(renderFeedbackFencedBlockV2('markdown', body)).toBe(
      `\`\`\`\`markdown\n${body}\n\`\`\`\``
    );
  });

  it('escapes table cells reversibly for a derived, non-authoritative TSV projection', () => {
    expect(escapeFeedbackTsvCellV2('A\\B\tline 1\nline 2\r')).toBe('A\\\\B\\tline 1\\nline 2\\r');
    expect(
      renderFeedbackTableCellsTsvV2([
        [
          { role: 'header', text: 'Name', complete: true },
          { role: 'header', text: 'Notes', complete: true },
        ],
        [
          { role: 'data', text: 'A\\B', complete: true },
          { role: 'data', text: 'Close -->', complete: true },
        ],
      ])
    ).toBe('Name\tNotes\nA\\\\B\tClose -->');
  });
});
