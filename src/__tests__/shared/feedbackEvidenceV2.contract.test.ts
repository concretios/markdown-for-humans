/**
 * Feedback evidence v2 contract tests.
 *
 * This file is intentionally RED until the v2 writer and strict webview
 * request grammar exist. Future contract shapes stay local so the suite
 * compiles against today's public production boundaries.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { renderFeedbackReport } from '../../editor/feedbackSessionStore';
import { parseFeedbackWebviewMessage } from '../../shared/feedbackProtocol';

interface ContractFixtures {
  version: 1;
  sources: {
    partialFormatted: string;
    adaptiveCode: string;
    adaptiveCodeCanonical: string;
    structural: string;
    mermaid: string;
    normalizationRaw: string;
    normalizationSlice: string;
    unsafeControlRaw: string;
    legacy: string;
  };
}

interface FutureEvidence extends Record<string, unknown> {
  kind: string;
  text?: string;
  rows?: Array<Array<Record<string, unknown>>>;
}

interface FutureFeedbackItem {
  id: string;
  sequence: number;
  kind: 'text';
  startLine: number;
  endLine: number;
  /** Current-writer compatibility only. V2 must never serialize Focus. */
  focus: string;
  feedback: string;
  target: Record<string, unknown>;
  evidence: {
    effective: FutureEvidence;
    original?: FutureEvidence;
  };
}

interface ReportContractCase {
  name: string;
  rawSource: string;
  item: FutureFeedbackItem;
  expectedFragments: string[];
  forbiddenFragments?: string[];
  exactEvidence?: {
    heading: string;
    language: string;
    body: string;
  };
}

const FIXTURES = JSON.parse(
  readFileSync(resolve(__dirname, 'feedback-evidence-v2/fixtures.json'), 'utf8')
) as ContractFixtures;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ONE_MIB = 1024 * 1024;
const AGGREGATE_ITEM_BYTES = 64 * 1024;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function withoutFinalTerminator(value: string): string {
  return value.replace(/(?:\r\n|\r|\n)$/, '');
}

function blockSpan(
  startOrdinal: number,
  endOrdinal: number,
  startKind: string,
  endKind: string,
  startMarkdown: string,
  endMarkdown = startMarkdown
): Record<string, unknown> {
  return {
    startOrdinal,
    endOrdinal,
    startKind,
    endKind,
    startBlockSha256: sha256(startMarkdown),
    endBlockSha256: sha256(endMarkdown),
  };
}

function exactBlockTarget(
  span: Record<string, unknown>,
  requestedScope: 'blocks' | 'rendered-text' = 'blocks'
): Record<string, unknown> {
  return {
    version: 2,
    requestedScope,
    effectiveScope: 'blocks',
    resolution: requestedScope === 'blocks' ? 'exact' : 'degraded',
    ...(requestedScope === 'blocks'
      ? {}
      : { coarsening: { reason: 'opaque-node', origin: 'renderer' } }),
    blockSpan: span,
  };
}

function exactRenderedTarget(
  span: Record<string, unknown>,
  range: {
    startOrdinal: number;
    startOffset: number;
    endOrdinal: number;
    endOffset: number;
  }
): Record<string, unknown> {
  const startBlockSha256 = String(span.startBlockSha256);
  const endBlockSha256 = String(span.endBlockSha256);
  return {
    version: 2,
    requestedScope: 'rendered-text',
    effectiveScope: 'rendered-text',
    resolution: 'exact',
    blockSpan: span,
    locator: {
      kind: 'rendered-range',
      value: {
        version: 1,
        ...range,
        startBlockSha256,
        endBlockSha256,
      },
    },
  };
}

function embeddedSourceEvidence(
  text: string,
  relationship: 'selected-blocks' | 'containing-blocks' = 'selected-blocks',
  format: 'markdown' | 'html' | 'text' = 'markdown'
): FutureEvidence {
  return {
    kind: 'source',
    fidelity: 'source-exact',
    relationship,
    format,
    normalization: 'lf',
    sourceSliceSha256: sha256(text),
    availability: 'embedded',
    text,
    utf8Bytes: Buffer.byteLength(text, 'utf8'),
  };
}

function renderedEvidence(text: string, language?: string): FutureEvidence {
  return {
    kind: 'rendered-text',
    fidelity: 'rendered-exact',
    text,
    complete: true,
    ...(language === undefined ? {} : { language }),
  };
}

function semanticEvidence(text: string): FutureEvidence {
  return {
    kind: 'semantic-text',
    fidelity: 'semantic-context',
    text,
    complete: true,
    provenance: 'renderer-fallback',
  };
}

function evidenceDescriptor(evidence: FutureEvidence): Record<string, unknown> {
  const descriptor = { ...evidence };
  delete descriptor.text;
  delete descriptor.rows;
  if (evidence.kind === 'table-cells') {
    descriptor.rowCount = evidence.rows?.length ?? 0;
    descriptor.columnCount = evidence.rows?.[0]?.length ?? 0;
  }
  return descriptor;
}

function expectedTargetComment(item: FutureFeedbackItem): string {
  return `<!-- md4h-target-v2:${JSON.stringify(item.target)} -->`;
}

function expectedEvidenceComment(item: FutureFeedbackItem): string {
  return `<!-- md4h-evidence-v2:${JSON.stringify({
    effective: evidenceDescriptor(item.evidence.effective),
    ...(item.evidence.original === undefined
      ? {}
      : { original: evidenceDescriptor(item.evidence.original) }),
  })} -->`;
}

function renderContractReport(
  name: string,
  rawSource: string,
  items: readonly FutureFeedbackItem[]
): string {
  const snapshot = {
    schema: 'md4h-feedback/v2',
    guideVersion: 2,
    state: 'sealed',
    round: '20260831T093000Z-c0de',
    source: `docs/${name}.md`,
    sourceSha256: sha256(Buffer.from(rawSource, 'utf8')),
    createdAt: '2026-08-31T09:30:00.000Z',
    sealedAt: '2026-08-31T09:35:00.000Z',
  };
  const nextSequence = Math.max(...items.map(item => item.sequence)) + 1;
  return renderFeedbackReport(
    snapshot as unknown as Parameters<typeof renderFeedbackReport>[0],
    items as unknown as Parameters<typeof renderFeedbackReport>[1],
    nextSequence
  );
}

function longestRun(value: string, marker: '`' | '~'): number {
  let longest = 0;
  let current = 0;
  for (const character of value) {
    if (character === marker) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function extractAdaptiveFence(
  report: string,
  heading: string,
  language: string
): { body: string; fence: string } | null {
  const headingOffset = report.indexOf(`${heading}\n\n`);
  if (headingOffset < 0) return null;
  const afterHeading = report.slice(headingOffset + heading.length + 2);
  const opener = afterHeading.match(/^([`~]{3,})([A-Za-z0-9_+.#-]*)\n/);
  if (!opener || opener[2] !== language) return null;
  const fence = opener[1];
  const bodyStart = opener[0].length;
  const bodyEnd = afterHeading.indexOf(`\n${fence}`, bodyStart);
  if (bodyEnd < 0) return null;
  return { body: afterHeading.slice(bodyStart, bodyEnd), fence };
}

function makeReportCases(): ReportContractCase[] {
  const partialSource = withoutFinalTerminator(FIXTURES.sources.partialFormatted);
  const partialSpan = blockSpan(0, 0, 'paragraph', 'paragraph', partialSource);
  const partialItem: FutureFeedbackItem = {
    id: 'F1',
    sequence: 1,
    kind: 'text',
    startLine: 1,
    endLine: 1,
    focus: 'the safety guide',
    feedback: 'Keep the link wording direct.',
    target: exactRenderedTarget(partialSpan, {
      startOrdinal: 0,
      startOffset: 5,
      endOrdinal: 0,
      endOffset: 21,
    }),
    evidence: { effective: renderedEvidence('the safety guide') },
  };

  const adaptiveSource = withoutFinalTerminator(FIXTURES.sources.adaptiveCode);
  const adaptiveItem: FutureFeedbackItem = {
    id: 'F1',
    sequence: 1,
    kind: 'text',
    startLine: 1,
    endLine: 4,
    focus: adaptiveSource,
    feedback: 'Keep ``` and ~~~~~ exact.',
    target: exactBlockTarget(
      blockSpan(0, 0, 'code', 'code', FIXTURES.sources.adaptiveCodeCanonical)
    ),
    evidence: { effective: embeddedSourceEvidence(adaptiveSource) },
  };

  const structuralSource = withoutFinalTerminator(FIXTURES.sources.structural);
  const structuralSpan = blockSpan(
    0,
    1,
    'paragraph',
    'blockquote',
    'Intro **bold**.',
    '> Quoted [link](./quoted.md).'
  );
  const structuralItem: FutureFeedbackItem = {
    id: 'F1',
    sequence: 1,
    kind: 'text',
    startLine: 1,
    endLine: 3,
    focus: 'Intro bold.\nQuoted link.',
    feedback: 'Review both complete blocks.',
    target: exactBlockTarget(structuralSpan),
    evidence: { effective: embeddedSourceEvidence(structuralSource) },
  };
  const crossBlockItem: FutureFeedbackItem = {
    id: 'F1',
    sequence: 1,
    kind: 'text',
    startLine: 1,
    endLine: 3,
    focus: 'bold.\nQuoted link',
    feedback: 'Make this transition smoother.',
    target: exactRenderedTarget(structuralSpan, {
      startOrdinal: 0,
      startOffset: 6,
      endOrdinal: 1,
      endOffset: 11,
    }),
    evidence: { effective: renderedEvidence('bold.\nQuoted link') },
  };

  const mermaidSource = withoutFinalTerminator(FIXTURES.sources.mermaid);
  const mermaidSpan = blockSpan(0, 0, 'mermaid', 'mermaid', mermaidSource);
  const wholeMermaidItem: FutureFeedbackItem = {
    id: 'F1',
    sequence: 1,
    kind: 'text',
    startLine: 1,
    endLine: 4,
    focus: 'flowchart LR\nDraft --> Review',
    feedback: 'Clarify the complete diagram.',
    target: exactBlockTarget(mermaidSpan),
    evidence: { effective: embeddedSourceEvidence(mermaidSource) },
  };
  const degradedMermaidItem: FutureFeedbackItem = {
    id: 'F1',
    sequence: 1,
    kind: 'text',
    startLine: 1,
    endLine: 4,
    focus: 'Draft\nReview',
    feedback: 'Clarify this attempted visual selection.',
    target: exactBlockTarget(mermaidSpan, 'rendered-text'),
    evidence: {
      effective: embeddedSourceEvidence(mermaidSource, 'containing-blocks'),
      original: semanticEvidence('Draft\nReview'),
    },
  };

  const normalizationSource = FIXTURES.sources.normalizationSlice;
  const normalizationSpan = blockSpan(0, 2, 'heading', 'paragraph', '# Ω', 'Last λ');
  const normalizationItem: FutureFeedbackItem = {
    id: 'F1',
    sequence: 1,
    kind: 'text',
    startLine: 1,
    endLine: 5,
    focus: normalizationSource,
    feedback: 'Preserve the selected source exactly.',
    target: exactBlockTarget(normalizationSpan),
    evidence: { effective: embeddedSourceEvidence(normalizationSource) },
  };

  const unsafeSlice = withoutFinalTerminator(FIXTURES.sources.unsafeControlRaw);
  const unsafeItem: FutureFeedbackItem = {
    id: 'F1',
    sequence: 1,
    kind: 'text',
    startLine: 1,
    endLine: 1,
    focus: 'Complete source omitted because it contains an unsafe control.',
    feedback: 'Review this block without embedding unsafe bytes.',
    target: exactBlockTarget(blockSpan(0, 0, 'paragraph', 'paragraph', unsafeSlice)),
    evidence: {
      effective: {
        kind: 'source',
        fidelity: 'source-reference',
        relationship: 'selected-blocks',
        format: 'markdown',
        normalization: 'lf',
        sourceSliceSha256: sha256(unsafeSlice),
        availability: 'omitted',
        omittedReason: 'unsafe-control',
        omittedUtf8Bytes: Buffer.byteLength(unsafeSlice, 'utf8'),
      },
    },
  };

  const legacyParagraph = 'First paragraph.';
  const legacySpan = blockSpan(1, 1, 'paragraph', 'paragraph', legacyParagraph);
  const migratedLocatorItem: FutureFeedbackItem = {
    id: 'F1',
    sequence: 1,
    kind: 'text',
    startLine: 3,
    endLine: 3,
    focus: 'First',
    feedback: 'Make this opening specific.',
    target: exactRenderedTarget(legacySpan, {
      startOrdinal: 1,
      startOffset: 0,
      endOrdinal: 1,
      endOffset: 5,
    }),
    evidence: { effective: renderedEvidence('First') },
  };
  const legacyUnknownTarget = {
    version: 2,
    effectiveScope: 'blocks',
    resolution: 'legacy-unknown',
    legacyOrigin: 'v1-no-locator',
    blockSpan: legacySpan,
  };
  const migratedUnknownItem: FutureFeedbackItem = {
    id: 'F1',
    sequence: 1,
    kind: 'text',
    startLine: 3,
    endLine: 3,
    focus: legacyParagraph,
    feedback: 'Clarify this legacy note.',
    target: legacyUnknownTarget,
    evidence: {
      effective: embeddedSourceEvidence(legacyParagraph, 'containing-blocks'),
      original: {
        kind: 'legacy-focus',
        fidelity: 'legacy-unclassified',
        text: legacyParagraph,
      },
    },
  };
  const staleLocatorItem: FutureFeedbackItem = {
    id: 'F1',
    sequence: 1,
    kind: 'text',
    startLine: 3,
    endLine: 3,
    focus: 'First',
    feedback: 'Retain the original selection after seal validation.',
    target: {
      version: 2,
      requestedScope: 'rendered-text',
      effectiveScope: 'blocks',
      resolution: 'degraded',
      coarsening: { reason: 'stale-locator', origin: 'host' },
      blockSpan: legacySpan,
    },
    evidence: {
      effective: embeddedSourceEvidence(legacyParagraph, 'containing-blocks'),
      original: renderedEvidence('First'),
    },
  };

  const cases: ReportContractCase[] = [
    {
      name: 'partial-formatted-link',
      rawSource: FIXTURES.sources.partialFormatted,
      item: partialItem,
      expectedFragments: [
        '**Target:** Selected rendered text · exact · paragraph block 1 offsets 5-21',
        '**Fidelity:** Exact rendered text',
      ],
      forbiddenFragments: ['**Focus:**', '[safety guide](https://example.test/safe)'],
      exactEvidence: {
        heading: '### Selected content',
        language: 'text',
        body: 'the safety guide',
      },
    },
    {
      name: 'whole-authored-fence',
      rawSource: FIXTURES.sources.adaptiveCode,
      item: adaptiveItem,
      expectedFragments: [
        '**Target:** Whole code block · exact · block 1',
        '**Fidelity:** Frozen source',
      ],
      forbiddenFragments: ['**Focus:**'],
      exactEvidence: {
        heading: '### Selected source',
        language: 'markdown',
        body: adaptiveSource,
      },
    },
    {
      name: 'structural-multi-block-source',
      rawSource: FIXTURES.sources.structural,
      item: structuralItem,
      expectedFragments: [
        '**Target:** Selected blocks · exact · blocks 1-2 · paragraph to blockquote',
        '**Fidelity:** Frozen source',
      ],
      forbiddenFragments: ['**Focus:**'],
      exactEvidence: {
        heading: '### Selected source',
        language: 'markdown',
        body: structuralSource,
      },
    },
    {
      name: 'cross-block-rendered-text',
      rawSource: FIXTURES.sources.structural,
      item: crossBlockItem,
      expectedFragments: [
        '**Target:** Selected rendered text · exact · block 1 offset 6 to block 2 offset 11',
        '**Fidelity:** Exact rendered text',
      ],
      forbiddenFragments: ['**Focus:**', '> Quoted [link](./quoted.md).'],
      exactEvidence: {
        heading: '### Selected content',
        language: 'text',
        body: 'bold.\nQuoted link',
      },
    },
    {
      name: 'whole-mermaid',
      rawSource: FIXTURES.sources.mermaid,
      item: wholeMermaidItem,
      expectedFragments: [
        '**Target:** Whole Mermaid diagram · exact · block 1',
        '**Fidelity:** Frozen source',
      ],
      forbiddenFragments: ['**Focus:**'],
      exactEvidence: {
        heading: '### Selected source',
        language: 'markdown',
        body: mermaidSource,
      },
    },
    {
      name: 'mermaid-selection-degraded',
      rawSource: FIXTURES.sources.mermaid,
      item: degradedMermaidItem,
      expectedFragments: [
        '**Target:** Selected rendered text to whole Mermaid diagram · degraded · opaque node (renderer reported)',
        '**Fidelity:** Effective frozen source · original semantic context',
        '### Original selection',
      ],
      forbiddenFragments: ['**Focus:**', '"locator"'],
      exactEvidence: {
        heading: '### Effective source',
        language: 'markdown',
        body: mermaidSource,
      },
    },
    {
      name: 'source-normalization',
      rawSource: FIXTURES.sources.normalizationRaw,
      item: normalizationItem,
      expectedFragments: [
        '**Target:** Selected blocks · exact · blocks 1-3 · heading to paragraph',
        '**Fidelity:** Frozen source',
      ],
      forbiddenFragments: ['**Focus:**', '\ufeff', '\r'],
      exactEvidence: {
        heading: '### Selected source',
        language: 'markdown',
        body: normalizationSource,
      },
    },
    {
      name: 'unsafe-control-source-omission',
      rawSource: FIXTURES.sources.unsafeControlRaw,
      item: unsafeItem,
      expectedFragments: [
        '**Target:** Whole paragraph · exact · block 1',
        '**Fidelity:** Source omitted due to unsafe control',
        '**Source slice SHA-256:**',
      ],
      forbiddenFragments: ['**Focus:**', '\u0000'],
    },
    {
      name: 'migrated-valid-rendered-locator',
      rawSource: FIXTURES.sources.legacy,
      item: migratedLocatorItem,
      expectedFragments: [
        '**Target:** Selected rendered text · exact · paragraph block 2 offsets 0-5',
        '**Fidelity:** Exact rendered text',
      ],
      forbiddenFragments: ['**Focus:**', 'md4h-rendered-range:'],
      exactEvidence: {
        heading: '### Selected content',
        language: 'text',
        body: 'First',
      },
    },
    {
      name: 'migrated-locator-free-legacy-unknown',
      rawSource: FIXTURES.sources.legacy,
      item: migratedUnknownItem,
      expectedFragments: [
        '**Target:** Legacy unclassified selection · containing whole paragraph · block 2',
        '**Fidelity:** Effective frozen source · original legacy Focus',
        '### Original selection',
      ],
      forbiddenFragments: ['**Focus:**', '"requestedScope"', '"locator"'],
      exactEvidence: {
        heading: '### Effective source',
        language: 'markdown',
        body: legacyParagraph,
      },
    },
    {
      name: 'seal-time-stale-locator',
      rawSource: FIXTURES.sources.legacy,
      item: staleLocatorItem,
      expectedFragments: [
        '**Target:** Selected rendered text to whole paragraph · degraded · stale locator (host validated)',
        '**Fidelity:** Effective frozen source · original exact rendered text',
        '### Original selection',
      ],
      forbiddenFragments: ['**Focus:**', '"locator"'],
      exactEvidence: {
        heading: '### Effective source',
        language: 'markdown',
        body: legacyParagraph,
      },
    },
  ];

  return cases.map(contractCase => ({
    ...contractCase,
    expectedFragments: [
      'schema: md4h-feedback/v2',
      'guide_version: 2',
      expectedTargetComment(contractCase.item),
      expectedEvidenceComment(contractCase.item),
      ...contractCase.expectedFragments,
    ],
  }));
}

function aggregateSourceText(id: string): string {
  const prefix = `${id}:`;
  return `${prefix}${'x'.repeat(AGGREGATE_ITEM_BYTES - prefix.length)}`;
}

function makeAggregateFixture(): {
  rawSource: string;
  items: FutureFeedbackItem[];
} {
  const sourceSlices = Array.from({ length: 17 }, (_, index) =>
    aggregateSourceText(`F${index + 1}`)
  );
  const items = sourceSlices.map((text, index): FutureFeedbackItem => {
    const id = `F${index + 1}`;
    const embedded = index < 16;
    return {
      id,
      sequence: index + 1,
      kind: 'text',
      startLine: index * 2 + 1,
      endLine: index * 2 + 1,
      focus: 'Aggregate source evidence.',
      feedback: `Review ${id}.`,
      target: exactBlockTarget(blockSpan(index, index, 'paragraph', 'paragraph', text)),
      evidence: {
        effective: embedded
          ? embeddedSourceEvidence(text)
          : {
              kind: 'source',
              fidelity: 'source-reference',
              relationship: 'selected-blocks',
              format: 'markdown',
              normalization: 'lf',
              sourceSliceSha256: sha256(text),
              availability: 'omitted',
              omittedReason: 'evidence-budget',
              omittedUtf8Bytes: Buffer.byteLength(text, 'utf8'),
            },
      },
    };
  });
  return { rawSource: `${sourceSlices.join('\n\n')}\n`, items };
}

describe('Feedback evidence v2 report contract', () => {
  const cases = makeReportCases();

  it('keeps the byte-level normalization fixture internally coherent', () => {
    const raw = FIXTURES.sources.normalizationRaw;
    const logicalLines = raw
      .replace(/^\ufeff/, '')
      .split(/\r\n|\r|\n/)
      .slice(0, 5)
      .join('\n');

    expect(logicalLines).toBe(FIXTURES.sources.normalizationSlice);
    expect(sha256(Buffer.from(raw, 'utf8'))).toMatch(SHA256_PATTERN);
    expect(sha256(Buffer.from(raw, 'utf8'))).not.toBe(sha256(logicalLines));
    expect(FIXTURES.sources.normalizationSlice).not.toMatch(/[\r\ufeff]/);
  });

  it('keeps paired structural and cross-block selections on the same physical source span', () => {
    const structural = cases.find(({ name }) => name === 'structural-multi-block-source');
    const rendered = cases.find(({ name }) => name === 'cross-block-rendered-text');
    if (!structural || !rendered) throw new Error('Missing paired multi-block fixtures.');

    expect(rendered.rawSource).toBe(structural.rawSource);
    expect(rendered.item.startLine).toBe(structural.item.startLine);
    expect(rendered.item.endLine).toBe(structural.item.endLine);
    expect(rendered.item.target.blockSpan).toEqual(structural.item.target.blockSpan);
  });

  it.each(cases)('renders $name with explicit v2 target and evidence grammar', contractCase => {
    const report = renderContractReport(contractCase.name, contractCase.rawSource, [
      contractCase.item,
    ]);
    const missing = contractCase.expectedFragments.filter(fragment => !report.includes(fragment));
    const forbiddenPresent = (contractCase.forbiddenFragments ?? []).filter(fragment =>
      report.includes(fragment)
    );
    const evidence = contractCase.exactEvidence
      ? extractAdaptiveFence(
          report,
          contractCase.exactEvidence.heading,
          contractCase.exactEvidence.language
        )
      : undefined;

    expect({
      missing,
      forbiddenPresent,
      exactEvidenceBody: evidence?.body,
    }).toEqual({
      missing: [],
      forbiddenPresent: [],
      exactEvidenceBody: contractCase.exactEvidence?.body,
    });
  });

  it('uses a safe adaptive fence for authored source and human Feedback', () => {
    const contractCase = cases.find(({ name }) => name === 'whole-authored-fence');
    if (!contractCase) throw new Error('Missing adaptive-fence fixture.');
    const report = renderContractReport(contractCase.name, contractCase.rawSource, [
      contractCase.item,
    ]);
    const source = extractAdaptiveFence(report, '### Selected source', 'markdown');
    const feedback = extractAdaptiveFence(report, '### Feedback', 'markdown');

    const checks = [
      { extracted: source, expected: withoutFinalTerminator(FIXTURES.sources.adaptiveCode) },
      { extracted: feedback, expected: contractCase.item.feedback },
    ].map(({ extracted, expected }) => ({
      body: extracted?.body,
      safe:
        extracted !== null &&
        extracted.fence.length >= 3 &&
        extracted.fence.length > longestRun(expected, extracted.fence[0] as unknown as '`' | '~'),
    }));

    expect(checks).toEqual([
      { body: withoutFinalTerminator(FIXTURES.sources.adaptiveCode), safe: true },
      { body: contractCase.item.feedback, safe: true },
    ]);
  });

  it('allocates exactly 1 MiB of complete source before omitting the next stable ID', () => {
    const fixture = makeAggregateFixture();
    const embeddedItems = fixture.items.filter(
      item => item.evidence.effective.availability === 'embedded'
    );
    const omittedItem = fixture.items.find(
      item => item.evidence.effective.availability === 'omitted'
    );
    const embeddedBytes = embeddedItems.reduce(
      (total, item) => total + Number(item.evidence.effective.utf8Bytes),
      0
    );
    expect(embeddedBytes).toBe(ONE_MIB);
    expect(omittedItem?.id).toBe('F17');

    const report = renderContractReport(
      'aggregate-source-budget',
      fixture.rawSource,
      [...fixture.items].reverse()
    );
    const requiredFragments = [
      'guide_version: 2',
      expectedEvidenceComment(fixture.items[0]),
      expectedEvidenceComment(fixture.items[15]),
      expectedEvidenceComment(fixture.items[16]),
      '**Fidelity:** Source omitted by evidence budget',
    ];
    const sourceEvidenceSectionCount = (report.match(/^### Selected source$/gm) ?? []).length;

    expect({
      missing: requiredFragments.filter(fragment => !report.includes(fragment)),
      sourceEvidenceSectionCount,
      reportWithinGlobalLimit: Buffer.byteLength(report, 'utf8') < 64 * ONE_MIB,
    }).toEqual({
      missing: [],
      sourceEvidenceSectionCount: fixture.items.length,
      reportWithinGlobalLimit: true,
    });
  });
});

describe('Feedback evidence v2 webview request contract', () => {
  const renderedMessage = {
    type: 'feedback.text.add',
    requestId: 'v2-rendered',
    sessionId: 'session-1',
    startOrdinal: 0,
    endOrdinal: 0,
    feedback: 'Clarify the selected words.',
    target: {
      version: 2,
      requestedScope: 'rendered-text',
      locator: {
        kind: 'rendered-range',
        value: {
          version: 1,
          startOrdinal: 0,
          startOffset: 5,
          endOrdinal: 0,
          endOffset: 21,
        },
      },
    },
    evidence: {
      kind: 'rendered-text',
      text: 'the safety guide',
      complete: true,
    },
  };
  const cellMessage = {
    type: 'feedback.text.add',
    requestId: 'v2-cells',
    sessionId: 'session-1',
    startOrdinal: 2,
    endOrdinal: 2,
    feedback: 'Clarify these cells.',
    target: {
      version: 2,
      requestedScope: 'table-cells',
      locator: {
        kind: 'table-cells',
        value: {
          version: 1,
          tableOrdinal: 2,
          rectangle: { top: 0, left: 0, bottom: 3, right: 4 },
          tableFingerprint: 'md4h-table/v1:0123456789abcdef',
        },
      },
    },
    evidence: {
      kind: 'table-cells',
      complete: true,
      rows: [
        [
          { role: 'header', text: 'Name', complete: true },
          { role: 'header', text: 'Tab', complete: true },
          { role: 'header', text: 'Lines', complete: true },
          { role: 'header', text: 'Empty', complete: true },
        ],
        [
          { role: 'data', text: 'A\\B', complete: true },
          { role: 'data', text: 'left\tright', complete: true },
          { role: 'data', text: 'line 1\nline 2', complete: true },
          { role: 'data', text: '', complete: true },
        ],
        [
          { role: 'data', text: 'Close -->', complete: true },
          { role: 'data', text: '', complete: true },
          { role: 'data', text: 'tail', complete: true },
          { role: 'data', text: '', complete: true },
        ],
      ],
    },
  };
  const blockMessage = {
    type: 'feedback.text.add',
    requestId: 'v2-block',
    sessionId: 'session-1',
    startOrdinal: 1,
    endOrdinal: 1,
    feedback: 'Review this whole block.',
    target: { version: 2, requestedScope: 'blocks' },
  };

  it('accepts exact block, rendered-text, and typed-cell requests without v1 Focus', () => {
    const messages = [blockMessage, renderedMessage, cellMessage];
    expect(messages.map(message => parseFeedbackWebviewMessage(message))).toEqual(messages);
  });

  it('rejects malformed scope, locator, evidence, matrix, and budget combinations', () => {
    const malformed = [
      {
        ...renderedMessage,
        target: { version: 2, requestedScope: 'rendered-text' },
      },
      {
        ...renderedMessage,
        target: { ...renderedMessage.target, requestedScope: 'blocks' },
      },
      { ...renderedMessage, evidence: cellMessage.evidence },
      {
        ...cellMessage,
        target: { version: 2, requestedScope: 'table-cells' },
      },
      {
        ...cellMessage,
        evidence: {
          ...cellMessage.evidence,
          rows: [cellMessage.evidence.rows[0], cellMessage.evidence.rows[1].slice(0, 3)],
        },
      },
      {
        ...cellMessage,
        evidence: {
          ...cellMessage.evidence,
          rows: [
            [
              { role: 'header', text: 'Name', complete: true },
              { role: 'column-header', text: 'Wrong role', complete: true },
            ],
          ],
        },
      },
      {
        ...cellMessage,
        evidence: { ...cellMessage.evidence, unexpected: true },
      },
      {
        ...renderedMessage,
        evidence: {
          ...renderedMessage.evidence,
          text: '\u0000unsafe',
        },
      },
      {
        ...renderedMessage,
        evidence: {
          ...renderedMessage.evidence,
          text: 'λ'.repeat(32_769),
        },
      },
      {
        ...renderedMessage,
        target: { ...renderedMessage.target, requestedScope: 'legacy-unknown' },
      },
    ];

    expect(malformed.map(candidate => parseFeedbackWebviewMessage(candidate))).toEqual(
      malformed.map(() => null)
    );
  });

  it('rejects every host-owned field at the renderer trust boundary', () => {
    const forbidden = [
      { ...blockMessage, target: { ...blockMessage.target, effectiveScope: 'blocks' } },
      { ...blockMessage, target: { ...blockMessage.target, resolution: 'exact' } },
      {
        ...blockMessage,
        target: {
          ...blockMessage.target,
          blockSpan: {
            startOrdinal: 1,
            endOrdinal: 1,
            startKind: 'paragraph',
            endKind: 'paragraph',
            startBlockSha256: 'a'.repeat(64),
            endBlockSha256: 'a'.repeat(64),
          },
        },
      },
      {
        ...renderedMessage,
        target: {
          ...renderedMessage.target,
          locator: {
            ...renderedMessage.target.locator,
            value: {
              ...renderedMessage.target.locator.value,
              startBlockSha256: 'a'.repeat(64),
              endBlockSha256: 'a'.repeat(64),
            },
          },
        },
      },
      {
        ...blockMessage,
        evidence: {
          kind: 'source',
          text: 'Untrusted source.',
          sourceSliceSha256: 'a'.repeat(64),
        },
      },
      {
        ...blockMessage,
        target: {
          ...blockMessage.target,
          coarsening: { reason: 'stale-locator', origin: 'host' },
        },
      },
    ];

    expect(forbidden.map(candidate => parseFeedbackWebviewMessage(candidate))).toEqual(
      forbidden.map(() => null)
    );
  });
});

describe('Feedback evidence v2 metadata safety contract', () => {
  const source = withoutFinalTerminator(FIXTURES.sources.partialFormatted);
  const span = blockSpan(0, 0, 'paragraph', 'paragraph', source);
  const baseItem: FutureFeedbackItem = {
    id: 'F1',
    sequence: 1,
    kind: 'text',
    startLine: 1,
    endLine: 1,
    focus: 'the safety guide',
    feedback: 'Clarify this.',
    target: exactRenderedTarget(span, {
      startOrdinal: 0,
      startOffset: 5,
      endOrdinal: 0,
      endOffset: 21,
    }),
    evidence: { effective: renderedEvidence('the safety guide') },
  };

  it('rejects unknown enums, extra keys, unsafe tokens, and oversized metadata', () => {
    const candidates: FutureFeedbackItem[] = [
      {
        ...baseItem,
        target: { ...baseItem.target, requestedScope: 'blocks--unsafe' },
      },
      {
        ...baseItem,
        target: { ...baseItem.target, unexpected: true },
      },
      {
        ...baseItem,
        target: {
          ...baseItem.target,
          blockSpan: { ...(baseItem.target.blockSpan as object), startKind: 'paragraph\nhtml' },
        },
      },
      {
        ...baseItem,
        evidence: {
          effective: { ...baseItem.evidence.effective, unexpected: true },
        },
      },
      {
        ...baseItem,
        target: { ...baseItem.target, oversized: 'x'.repeat(2_049) },
      },
      {
        ...baseItem,
        target: {
          ...baseItem.target,
          requestedScope: 'rendered-text--><script>',
        },
      },
    ];
    const rejected = candidates.map(candidate => {
      try {
        renderContractReport('invalid-metadata', FIXTURES.sources.partialFormatted, [candidate]);
        return false;
      } catch {
        return true;
      }
    });

    expect(rejected).toEqual(candidates.map(() => true));
  });

  it('canonicalizes metadata order and keeps hostile evidence text outside comments', () => {
    const hostileText = 'Close --> and -- remain literal';
    const canonicalTarget = exactRenderedTarget(span, {
      startOrdinal: 0,
      startOffset: 5,
      endOrdinal: 0,
      endOffset: 21,
    });
    const reorderedTarget = {
      blockSpan: canonicalTarget.blockSpan,
      locator: canonicalTarget.locator,
      resolution: canonicalTarget.resolution,
      effectiveScope: canonicalTarget.effectiveScope,
      requestedScope: canonicalTarget.requestedScope,
      version: canonicalTarget.version,
    };
    const item: FutureFeedbackItem = {
      ...baseItem,
      focus: hostileText,
      target: reorderedTarget,
      evidence: { effective: renderedEvidence(hostileText) },
    };
    const canonicalItem = { ...item, target: canonicalTarget };
    const report = renderContractReport(
      'canonical-hostile-metadata',
      FIXTURES.sources.partialFormatted,
      [item]
    );
    const metadataLines = report
      .split('\n')
      .filter(line => line.startsWith('<!-- md4h-') && line.endsWith(' -->'));
    const selected = extractAdaptiveFence(report, '### Selected content', 'text');

    expect({
      hasCanonicalTarget: report.includes(expectedTargetComment(canonicalItem)),
      metadataLineCount: metadataLines.length,
      metadataContainsEvidence: metadataLines.some(line => line.includes(hostileText)),
      selectedBody: selected?.body,
      hasFocus: report.includes('**Focus:**'),
    }).toEqual({
      hasCanonicalTarget: true,
      metadataLineCount: 2,
      metadataContainsEvidence: false,
      selectedBody: hostileText,
      hasFocus: false,
    });
  });

  it('omits invalid optional language tokens instead of placing them in metadata', () => {
    const invalidTokens = ['ts--unsafe', 'line\nbreak', 'x'.repeat(33)];
    const outcomes = invalidTokens.map(language => {
      const item: FutureFeedbackItem = {
        ...baseItem,
        evidence: { effective: renderedEvidence('the safety guide', language) },
      };
      const report = renderContractReport(
        'invalid-optional-language',
        FIXTURES.sources.partialFormatted,
        [item]
      );
      return {
        hasV2Descriptor: report.includes('<!-- md4h-evidence-v2:'),
        leaksToken: report.includes(language),
      };
    });

    expect(outcomes).toEqual(
      invalidTokens.map(() => ({ hasV2Descriptor: true, leaksToken: false }))
    );
  });
});
