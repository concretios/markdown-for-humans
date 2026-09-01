/** @jest-environment jsdom */

/**
 * Scope-first Feedback evidence v2 contract fixtures.
 *
 * This suite is intentionally RED until the v2 schema, writer, and protocol
 * boundary exist. It imports only current public production functions and casts
 * proposed v2 values at those boundaries, so a failure means missing runtime
 * behavior rather than a missing test-only module.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Editor } from '@tiptap/core';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { renderFeedbackReport } from '../../editor/feedbackSessionStore';
import { parseFeedbackWebviewMessage } from '../../shared/feedbackProtocol';
import { HtmlPreservingTable } from '../../webview/extensions/htmlPreservingTable';
import { Mermaid } from '../../webview/extensions/mermaid';
import { enumerateCanonicalFeedbackBlocks } from '../../webview/features/feedbackReview';
import { fingerprintFeedbackTable } from '../../webview/features/feedbackSelectionMapping';

type FeedbackScopeV2 = 'rendered-text' | 'table-cells' | 'blocks' | 'visual-region';
type FeedbackBlockKindV2 =
  | 'paragraph'
  | 'heading'
  | 'code'
  | 'table'
  | 'mermaid'
  | 'math'
  | 'image'
  | 'list'
  | 'blockquote'
  | 'alert'
  | 'horizontal-rule'
  | 'frontmatter'
  | 'html'
  | 'other';
type FeedbackCoarsenedReasonV2 =
  | 'opaque-node'
  | 'unmappable-range'
  | 'merged-cells'
  | 'irregular-table'
  | 'item-cell-limit'
  | 'session-cell-budget'
  | 'stale-locator'
  | 'unsupported-block';

interface FeedbackBlockSpanV2 {
  startOrdinal: number;
  endOrdinal: number;
  startKind: FeedbackBlockKindV2;
  endKind: FeedbackBlockKindV2;
  startBlockSha256: string;
  endBlockSha256: string;
}

interface FeedbackRenderedRangeV1 {
  version: 1;
  startOrdinal: number;
  startOffset: number;
  endOrdinal: number;
  endOffset: number;
  startBlockSha256: string;
  endBlockSha256: string;
}

interface FeedbackCellTargetV1 {
  version: 1;
  tableOrdinal: number;
  rectangle: { top: number; left: number; bottom: number; right: number };
  tableFingerprint: string;
  tableBlockSha256: string;
}

interface FeedbackResolvedTargetBaseV2 {
  version: 2;
  requestedScope: FeedbackScopeV2;
  effectiveScope: FeedbackScopeV2;
  blockSpan: FeedbackBlockSpanV2;
  locator?:
    | { kind: 'rendered-range'; value: FeedbackRenderedRangeV1 }
    | { kind: 'table-cells'; value: FeedbackCellTargetV1 };
}

type FeedbackResolvedTargetV2 = FeedbackResolvedTargetBaseV2 &
  (
    | { resolution: 'exact'; coarsening?: never }
    | {
        resolution: 'degraded';
        coarsening: {
          reason: FeedbackCoarsenedReasonV2;
          origin: 'renderer' | 'host';
        };
      }
  );

interface FeedbackLegacyUnknownTargetV2 {
  version: 2;
  effectiveScope: 'blocks';
  resolution: 'legacy-unknown';
  legacyOrigin: 'v1-no-locator';
  blockSpan: FeedbackBlockSpanV2;
}

type FeedbackTargetV2 = FeedbackResolvedTargetV2 | FeedbackLegacyUnknownTargetV2;

interface FeedbackSourceEvidenceBaseV2 {
  kind: 'source';
  relationship: 'selected-blocks' | 'containing-blocks';
  format: 'markdown' | 'html' | 'text';
  normalization: 'lf';
  sourceSliceSha256: string;
}

type FeedbackSourceEvidenceV2 = FeedbackSourceEvidenceBaseV2 &
  (
    | {
        fidelity: 'source-exact';
        availability: 'embedded';
        text: string;
        utf8Bytes: number;
      }
    | {
        fidelity: 'source-reference';
        availability: 'omitted';
        omittedReason: 'evidence-budget' | 'unsafe-control';
        omittedUtf8Bytes: number;
      }
  );

interface FeedbackRenderedTextEvidenceV2 {
  kind: 'rendered-text';
  fidelity: 'rendered-exact';
  text: string;
  complete: true;
  language?: string;
}

interface FeedbackTableCellV2 {
  role: 'header' | 'data';
  text: string;
  complete: boolean;
}

interface FeedbackTableCellsEvidenceV2 {
  kind: 'table-cells';
  fidelity: 'structured-semantic';
  complete: boolean;
  rows: FeedbackTableCellV2[][];
}

interface FeedbackSemanticTextEvidenceV2 {
  kind: 'semantic-text';
  fidelity: 'semantic-context';
  text: string;
  complete: boolean;
  provenance: 'renderer-fallback';
}

interface FeedbackLegacyFocusEvidenceV2 {
  kind: 'legacy-focus';
  fidelity: 'legacy-unclassified';
  text: string;
}

interface FeedbackVisualEvidenceV2 {
  kind: 'visual';
  fidelity: 'visual-exact';
  assetRelativePath: string;
  assetSha256: string;
  width: number;
  height: number;
  sourceReference: {
    relationship: 'containing-blocks';
    format: 'markdown' | 'html' | 'text';
    normalization: 'lf';
    sourceSliceSha256: string;
  };
}

type FeedbackEvidenceV2 =
  | FeedbackSourceEvidenceV2
  | FeedbackRenderedTextEvidenceV2
  | FeedbackTableCellsEvidenceV2
  | FeedbackSemanticTextEvidenceV2
  | FeedbackLegacyFocusEvidenceV2
  | FeedbackVisualEvidenceV2;

interface FeedbackContractItemBaseV2 {
  id: string;
  sequence: number;
  startLine: number;
  endLine: number;
  feedback: string;
  target: FeedbackTargetV2;
  evidence: {
    effective: FeedbackEvidenceV2;
    original?: FeedbackEvidenceV2;
  };
}

interface FeedbackContractTextItemV2 extends FeedbackContractItemBaseV2 {
  kind: 'text';
  /** V1 compatibility input used only to exercise the current writer. */
  focus: string;
}

interface FeedbackContractScreenshotItemV2 extends FeedbackContractItemBaseV2 {
  kind: 'screenshot';
  assetRelativePath: string;
  assetSha256: string;
  width: number;
  height: number;
}

type FeedbackContractItemV2 = FeedbackContractTextItemV2 | FeedbackContractScreenshotItemV2;

interface FeedbackContractCaseV2 {
  name: string;
  expected: string;
  source:
    | { kind: 'fixture'; file: string }
    | { kind: 'generated-oversized-code'; character: string; repetitions: number };
  item: FeedbackContractItemV2;
}

interface FeedbackContractFixtureV2 {
  version: 1;
  cases: FeedbackContractCaseV2[];
}

const FIXTURE_ROOT = resolve(__dirname, '../fixtures/feedback-evidence-v2');
const FIXTURE = JSON.parse(
  readFileSync(resolve(FIXTURE_ROOT, 'cases.json'), 'utf8')
) as FeedbackContractFixtureV2;

function extractItemSection(report: string, id: string): string {
  const heading = `## ${id} ·`;
  const start = report.indexOf(heading);
  if (start < 0) throw new Error(`Missing report section ${id}.`);
  const next = report.indexOf('\n## F', start + heading.length);
  return `${report.slice(start, next < 0 ? report.length : next).trimEnd()}\n`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function evidenceDescriptor(evidence: FeedbackEvidenceV2): Record<string, unknown> {
  const descriptor = { ...evidence } as Record<string, unknown>;
  delete descriptor.text;
  delete descriptor.rows;
  if (evidence.kind === 'table-cells') {
    descriptor.rowCount = evidence.rows.length;
    descriptor.columnCount = evidence.rows[0]?.length ?? 0;
  }
  return descriptor;
}

function sourceForCase(contractCase: FeedbackContractCaseV2): string {
  if (contractCase.source.kind === 'fixture') {
    return readFileSync(resolve(FIXTURE_ROOT, contractCase.source.file), 'utf8');
  }
  return `\`\`\`text\n${contractCase.source.character.repeat(
    contractCase.source.repetitions
  )}\n\`\`\``;
}

function renderContractCase(contractCase: FeedbackContractCaseV2): string {
  const source = sourceForCase(contractCase);
  return renderFeedbackReport(
    {
      schema: 'md4h-feedback/v2',
      guideVersion: 2,
      state: 'sealed',
      round: '20260831T093000Z-v2c1',
      source: `docs/${contractCase.name}.md`,
      sourceSha256: sha256(source),
      createdAt: '2026-08-31T09:30:00.000Z',
      sealedAt: '2026-08-31T09:35:00.000Z',
    } as unknown as Parameters<typeof renderFeedbackReport>[0],
    [contractCase.item as unknown as Parameters<typeof renderFeedbackReport>[1][number]],
    contractCase.item.sequence + 1
  );
}

function createFixtureEditor(source: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [
      StarterKit,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      Mermaid,
      HtmlPreservingTable,
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: source,
    contentType: 'markdown',
  });
}

describe('Feedback evidence v2 golden contract', () => {
  afterEach(() => document.body.replaceChildren());

  it('keeps embedded source fixtures bound to exact inclusive line spans', () => {
    const embeddedSourceCases = FIXTURE.cases.filter(
      contractCase =>
        contractCase.item.evidence.effective.kind === 'source' &&
        contractCase.item.evidence.effective.availability === 'embedded'
    );

    expect(embeddedSourceCases.length).toBeGreaterThan(0);
    for (const contractCase of embeddedSourceCases) {
      const evidence = contractCase.item.evidence.effective;
      if (evidence.kind !== 'source' || evidence.availability !== 'embedded') {
        throw new Error('Expected embedded source evidence.');
      }
      const expectedSlice = sourceForCase(contractCase)
        .split('\n')
        .slice(contractCase.item.startLine - 1, contractCase.item.endLine)
        .join('\n');
      expect(evidence.text).toBe(expectedSlice);
      expect(evidence.utf8Bytes).toBe(Buffer.byteLength(expectedSlice, 'utf8'));
      expect(evidence.sourceSliceSha256).toBe(sha256(expectedSlice));
    }
  });

  it('binds omitted source evidence to a real complete over-budget slice', () => {
    const contractCase = FIXTURE.cases.find(({ name }) => name === 'source-over-budget');
    if (contractCase === undefined) throw new Error('Missing source-over-budget fixture.');
    const evidence = contractCase.item.evidence.effective;
    if (evidence.kind !== 'source' || evidence.availability !== 'omitted') {
      throw new Error('Expected omitted source evidence.');
    }
    const sourceSlice = sourceForCase(contractCase)
      .split('\n')
      .slice(contractCase.item.startLine - 1, contractCase.item.endLine)
      .join('\n');

    expect(evidence.omittedUtf8Bytes).toBe(Buffer.byteLength(sourceSlice, 'utf8'));
    expect(evidence.sourceSliceSha256).toBe(sha256(sourceSlice));
    expect(evidence.omittedUtf8Bytes).toBeGreaterThan(64 * 1024);
  });

  it('binds persisted block hashes and cell evidence to the canonical rich model', () => {
    const sharedCases = FIXTURE.cases.filter(({ source }) => source.kind === 'fixture');
    const editor = createFixtureEditor(sourceForCase(sharedCases[0]));
    try {
      const canonicalBlocks = enumerateCanonicalFeedbackBlocks(editor);
      for (const contractCase of sharedCases) {
        const block = canonicalBlocks.find(
          candidate => candidate.ordinal === contractCase.item.target.blockSpan.startOrdinal
        );
        expect(block).toBeDefined();
        expect(block?.kind).toBe(contractCase.item.target.blockSpan.startKind);
        expect(sha256(block?.markdown ?? '')).toBe(
          contractCase.item.target.blockSpan.startBlockSha256
        );
      }

      const cellCase = sharedCases.find(({ name }) => name === 'selected-table-cells');
      if (cellCase === undefined) throw new Error('Missing selected-table-cells fixture.');
      const evidence = cellCase.item.evidence.effective;
      if (evidence.kind !== 'table-cells') throw new Error('Expected table-cell evidence.');
      const table = editor.state.doc.child(cellCase.item.target.blockSpan.startOrdinal);
      const target = cellCase.item.target;
      if (!('requestedScope' in target) || target.locator?.kind !== 'table-cells') {
        throw new Error('Expected resolved table-cell target.');
      }
      expect(target.locator.value.tableFingerprint).toBe(
        fingerprintFeedbackTable({
          version: 1,
          tableOrdinal: target.locator.value.tableOrdinal,
          table,
        }).fingerprint
      );
      expect(target.locator.value.tableBlockSha256).toBe(target.blockSpan.startBlockSha256);
      const rows: FeedbackTableCellV2[][] = [];
      table.forEach(row => {
        const cells: FeedbackTableCellV2[] = [];
        row.forEach(cell => {
          cells.push({
            role: cell.type.name === 'tableHeader' ? 'header' : 'data',
            text: cell.textBetween(0, cell.content.size, '\n', '\n'),
            complete: true,
          });
        });
        rows.push(cells);
      });
      expect(rows).toEqual(evidence.rows);
    } finally {
      editor.destroy();
    }
  });

  it('binds the omitted oversized source target to a canonical code block', () => {
    const contractCase = FIXTURE.cases.find(({ name }) => name === 'source-over-budget');
    if (contractCase === undefined) throw new Error('Missing source-over-budget fixture.');
    const editor = createFixtureEditor(sourceForCase(contractCase));
    try {
      const blocks = enumerateCanonicalFeedbackBlocks(editor);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe(contractCase.item.target.blockSpan.startKind);
      expect(sha256(blocks[0].markdown)).toBe(contractCase.item.target.blockSpan.startBlockSha256);
    } finally {
      editor.destroy();
    }
  });

  it('keeps the typed cell matrix rectangular and aligned with its locator', () => {
    const contractCase = FIXTURE.cases.find(({ name }) => name === 'selected-table-cells');
    if (contractCase === undefined) throw new Error('Missing selected-table-cells fixture.');
    const evidence = contractCase.item.evidence.effective;
    if (evidence.kind !== 'table-cells') throw new Error('Expected table-cell evidence.');
    const target = contractCase.item.target;
    if (!('requestedScope' in target)) throw new Error('Expected resolved v2 target.');
    if (target.locator?.kind !== 'table-cells') {
      throw new Error('Expected table-cell locator.');
    }
    const rectangle = target.locator.value.rectangle;

    expect(evidence.rows).toHaveLength(rectangle.bottom - rectangle.top);
    expect(evidence.rows.every(row => row.length === rectangle.right - rectangle.left)).toBe(true);
  });

  it('keeps machine comments content-free with valid canonical JSON', () => {
    for (const contractCase of FIXTURE.cases) {
      const expected = readFileSync(resolve(FIXTURE_ROOT, contractCase.expected), 'utf8');
      const metadataLines = expected
        .split('\n')
        .filter(line => line.startsWith('<!-- md4h-') && line.endsWith(' -->'));

      expect(metadataLines).toHaveLength(2);
      for (const line of metadataLines) {
        expect(line.indexOf('-->')).toBe(line.length - 3);
        const payloadStart = line.indexOf(':') + 1;
        expect(() => JSON.parse(line.slice(payloadStart, -4))).not.toThrow();
      }
      const targetPayload = metadataLines[0].slice(metadataLines[0].indexOf(':') + 1, -4);
      const evidencePayload = metadataLines[1].slice(metadataLines[1].indexOf(':') + 1, -4);
      expect(targetPayload).toBe(JSON.stringify(contractCase.item.target));
      expect(evidencePayload).toBe(
        JSON.stringify({
          effective: evidenceDescriptor(contractCase.item.evidence.effective),
          ...(contractCase.item.evidence.original === undefined
            ? {}
            : { original: evidenceDescriptor(contractCase.item.evidence.original) }),
        })
      );
    }
  });

  it('writes explicit v2 frontmatter independent of guide wording', () => {
    const report = renderContractCase(FIXTURE.cases[0]);
    expect(report).toContain('schema: md4h-feedback/v2');
    expect(report).toContain('guide_version: 2');
  });

  it.each(FIXTURE.cases)('renders $name with the locked evidence grammar', contractCase => {
    const expected = readFileSync(resolve(FIXTURE_ROOT, contractCase.expected), 'utf8');
    expect(extractItemSection(renderContractCase(contractCase), contractCase.item.id)).toBe(
      expected
    );
  });

  it('accepts a bounded v2 cell-selection request without host-owned source fields', () => {
    const message = {
      type: 'feedback.text.add',
      requestId: 'add-v2-table-cells',
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
            rectangle: { top: 0, left: 0, bottom: 2, right: 2 },
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
            { role: 'header', text: 'Notes', complete: true },
          ],
          [
            { role: 'data', text: 'Alpha', complete: true },
            { role: 'data', text: 'Review', complete: true },
          ],
        ],
      },
    };

    expect(parseFeedbackWebviewMessage(message)).toEqual(message);
  });

  it('rejects webview-supplied source evidence', () => {
    expect(
      parseFeedbackWebviewMessage({
        type: 'feedback.text.add',
        requestId: 'reject-v2-source',
        sessionId: 'session-1',
        startOrdinal: 2,
        endOrdinal: 2,
        feedback: 'Clarify this block.',
        target: { version: 2, requestedScope: 'blocks' },
        evidence: {
          kind: 'source',
          text: '| untrusted | source |',
          sourceSliceSha256: 'f'.repeat(64),
        },
      })
    ).toBeNull();
  });
});
