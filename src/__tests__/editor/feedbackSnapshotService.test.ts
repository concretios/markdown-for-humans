import {
  FeedbackSnapshotService,
  computeFeedbackBytesSha256,
  computeFeedbackTextSha256,
  type FeedbackPreparedSourceSnapshot,
  type FeedbackRendererSnapshotReport,
  type FeedbackSplitSnapshotReport,
} from '../../editor/feedbackSnapshotService';
import type { CanonicalFeedbackBlock } from '../../shared/feedbackProtocol';

const DOCUMENT_URI = 'file:///workspace/docs/guide.md';
const OPERATION_ID = 'feedback-operation-1';
const VIEW_ID = 'rich-view-1';
const VIEW_GENERATION = 'rich-view-1:g1';

function block(
  ordinal: number,
  kind: string,
  markdown: string,
  contentSize = markdown.length
): CanonicalFeedbackBlock {
  return { ordinal, kind, markdown, contentSize };
}

function requirePrepared(
  service: FeedbackSnapshotService,
  sourceText: string,
  overrides: Partial<Parameters<FeedbackSnapshotService['prepareSource']>[0]> = {}
): FeedbackPreparedSourceSnapshot {
  const result = service.prepareSource({
    documentUri: DOCUMENT_URI,
    operationId: OPERATION_ID,
    capturedDocumentVersion: 7,
    currentDocumentVersion: 7,
    sourceText,
    savedBytes: Buffer.from(sourceText, 'utf8'),
    ...overrides,
  });
  if (!result.ok) throw new Error(`${result.error.reason}: ${result.error.detail}`);
  return result.source;
}

function splitReport(
  sourceText: string,
  overrides: Partial<FeedbackSplitSnapshotReport> = {}
): FeedbackSplitSnapshotReport {
  return {
    viewId: VIEW_ID,
    viewGeneration: VIEW_GENERATION,
    localRevision: 12,
    documentVersion: 7,
    dirty: false,
    contentSha256: computeFeedbackTextSha256(sourceText),
    ...overrides,
  };
}

function rendererReport(
  sourceText: string,
  overrides: Partial<FeedbackRendererSnapshotReport> = {}
): FeedbackRendererSnapshotReport {
  return {
    viewId: VIEW_ID,
    viewGeneration: VIEW_GENERATION,
    localRevision: 12,
    documentVersion: 7,
    contentSha256: computeFeedbackTextSha256(sourceText),
    canonicalDescriptorRevision: 3,
    ...overrides,
  };
}

describe('FeedbackSnapshotService', () => {
  it('builds one immutable identity from converged source, saved bytes, renderer, and blocks', () => {
    const service = new FeedbackSnapshotService();
    const sourceText = [
      'Source-preserved title',
      '======================',
      '',
      'A hard-wrapped paragraph',
      'continues on this line.',
    ].join('\n');
    const source = requirePrepared(service, sourceText);
    const blocks = [
      block(0, 'heading', '# Source-preserved title'),
      block(2, 'paragraph', 'A hard-wrapped paragraph continues on this line.'),
    ];

    const result = service.finalize({
      source,
      currentDocumentVersion: 7,
      splitReports: [splitReport(sourceText)],
      renderer: rendererReport(sourceText),
      descriptors: { revision: 3, blocks },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot).toMatchObject({
      documentUri: DOCUMENT_URI,
      operationId: OPERATION_ID,
      documentVersion: 7,
      sourceTextSha256: computeFeedbackTextSha256(sourceText),
      savedBytesSha256: computeFeedbackBytesSha256(Buffer.from(sourceText, 'utf8')),
      sourceByteCount: Buffer.byteLength(sourceText, 'utf8'),
      renderer: {
        viewId: VIEW_ID,
        viewGeneration: VIEW_GENERATION,
        localRevision: 12,
        contentSha256: computeFeedbackTextSha256(sourceText),
      },
      canonicalDescriptorRevision: 3,
      blockCount: 2,
      anchorMap: {
        blocks: [
          { ordinal: 0, kind: 'heading', startLine: 1, endLine: 2 },
          { ordinal: 2, kind: 'paragraph', startLine: 4, endLine: 5 },
        ],
      },
    });
    expect(result.snapshot.blocks).toHaveLength(2);
    expect(result.snapshot.blocks[0]).toMatchObject({ ordinal: 0, kind: 'heading' });
    expect(result.snapshot.blocks[0].contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshot.blocks[1].contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshot.blocks[0].contentSha256).not.toBe(
      result.snapshot.blocks[1].contentSha256
    );
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.blocks)).toBe(true);
    expect(Object.isFrozen(result.snapshot.anchorMap.blocks)).toBe(true);
    expect('sourceText' in result.snapshot).toBe(false);
  });

  it('keeps exact text and saved-byte digests distinct when a UTF-8 BOM is present', () => {
    const service = new FeedbackSnapshotService();
    const sourceText = '# Heading\n';
    const savedBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(sourceText, 'utf8'),
    ]);

    const result = service.prepareSource({
      documentUri: DOCUMENT_URI,
      operationId: OPERATION_ID,
      capturedDocumentVersion: 4,
      currentDocumentVersion: 4,
      sourceText,
      savedBytes,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.sourceTextSha256).toBe(computeFeedbackTextSha256(sourceText));
    expect(result.source.savedBytesSha256).toBe(computeFeedbackBytesSha256(savedBytes));
    expect(result.source.sourceTextSha256).not.toBe(result.source.savedBytesSha256);
    expect(result.source.sourceByteCount).toBe(savedBytes.byteLength);
  });

  it('rejects a source capture when the document version changed before preparation', () => {
    const service = new FeedbackSnapshotService();
    const result = service.prepareSource({
      documentUri: DOCUMENT_URI,
      operationId: OPERATION_ID,
      capturedDocumentVersion: 7,
      currentDocumentVersion: 8,
      sourceText: 'Current source',
      savedBytes: Buffer.from('Current source'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('stale-document-version');
  });

  it('rejects saved bytes that do not reproduce the captured document text', () => {
    const service = new FeedbackSnapshotService();
    const result = service.prepareSource({
      documentUri: DOCUMENT_URI,
      operationId: OPERATION_ID,
      capturedDocumentVersion: 7,
      currentDocumentVersion: 7,
      sourceText: '# Current source\n',
      savedBytes: Buffer.from('# Stale source\n'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('saved-byte-mismatch');
  });

  it('rejects finalization when the live document version changed after saving', () => {
    const service = new FeedbackSnapshotService();
    const sourceText = '# Current source';
    const source = requirePrepared(service, sourceText);
    const result = service.finalize({
      source,
      currentDocumentVersion: 8,
      splitReports: [splitReport(sourceText)],
      renderer: rendererReport(sourceText),
      descriptors: { revision: 3, blocks: [block(0, 'heading', sourceText)] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('stale-document-version');
  });

  it('rejects stale renderer document versions and renderer content digests', () => {
    const service = new FeedbackSnapshotService();
    const sourceText = '# Current source';
    const source = requirePrepared(service, sourceText);
    const common = {
      source,
      currentDocumentVersion: 7,
      splitReports: [splitReport(sourceText)],
      descriptors: { revision: 3, blocks: [block(0, 'heading', sourceText)] },
    };

    const staleVersion = service.finalize({
      ...common,
      renderer: rendererReport(sourceText, { documentVersion: 6 }),
    });
    const staleContent = service.finalize({
      ...common,
      renderer: rendererReport(sourceText, {
        contentSha256: computeFeedbackTextSha256('# Old source'),
      }),
    });

    expect(staleVersion.ok).toBe(false);
    expect(staleContent.ok).toBe(false);
    if (!staleVersion.ok) expect(staleVersion.error.reason).toBe('stale-document-version');
    if (!staleContent.ok) expect(staleContent.error.reason).toBe('renderer-content-mismatch');
  });

  it('rejects old canonical blocks with the same count, order, and kinds as current source', () => {
    const service = new FeedbackSnapshotService();
    const sourceText = '# Current title\n\nCurrent paragraph.';
    const source = requirePrepared(service, sourceText);
    const result = service.finalize({
      source,
      currentDocumentVersion: 7,
      splitReports: [splitReport(sourceText)],
      renderer: rendererReport(sourceText),
      descriptors: {
        revision: 3,
        blocks: [block(0, 'heading', '# Old title'), block(1, 'paragraph', 'Old paragraph.')],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('block-content-mismatch');
  });

  it('rejects divergent dirty split reports even when one split matches the source', () => {
    const service = new FeedbackSnapshotService();
    const sourceText = '# Current source';
    const source = requirePrepared(service, sourceText);
    const result = service.finalize({
      source,
      currentDocumentVersion: 7,
      splitReports: [
        splitReport(sourceText, { dirty: true }),
        splitReport(sourceText, {
          viewId: 'rich-view-2',
          viewGeneration: 'rich-view-2:g1',
          dirty: true,
          contentSha256: computeFeedbackTextSha256('# Divergent local source'),
        }),
      ],
      renderer: rendererReport(sourceText),
      descriptors: { revision: 3, blocks: [block(0, 'heading', sourceText)] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('dirty-split-divergence');
  });

  it('rejects one dirty split whose content was not converged into the source', () => {
    const service = new FeedbackSnapshotService();
    const sourceText = '# Current source';
    const source = requirePrepared(service, sourceText);
    const result = service.finalize({
      source,
      currentDocumentVersion: 7,
      splitReports: [
        splitReport(sourceText, {
          dirty: true,
          contentSha256: computeFeedbackTextSha256('# Unflushed local source'),
        }),
      ],
      renderer: rendererReport(sourceText),
      descriptors: { revision: 3, blocks: [block(0, 'heading', sourceText)] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('dirty-split-divergence');
  });

  it('rejects a clean split that reports stale rendered content', () => {
    const service = new FeedbackSnapshotService();
    const sourceText = '# Current source';
    const source = requirePrepared(service, sourceText);
    const result = service.finalize({
      source,
      currentDocumentVersion: 7,
      splitReports: [
        splitReport(sourceText),
        splitReport(sourceText, {
          viewId: 'rich-view-2',
          viewGeneration: 'rich-view-2:g1',
          contentSha256: computeFeedbackTextSha256('# Stale rendered source'),
        }),
      ],
      renderer: rendererReport(sourceText),
      descriptors: { revision: 3, blocks: [block(0, 'heading', sourceText)] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('split-content-mismatch');
  });

  it('rejects split and renderer reports tied to stale generations or revisions', () => {
    const service = new FeedbackSnapshotService();
    const sourceText = '# Current source';
    const source = requirePrepared(service, sourceText);
    const result = service.finalize({
      source,
      currentDocumentVersion: 7,
      splitReports: [splitReport(sourceText, { viewGeneration: 'rich-view-1:old' })],
      renderer: rendererReport(sourceText),
      descriptors: { revision: 3, blocks: [block(0, 'heading', sourceText)] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('renderer-report-mismatch');
  });

  it('rejects canonical descriptors not bound to the renderer-reported revision', () => {
    const service = new FeedbackSnapshotService();
    const sourceText = '# Current source';
    const source = requirePrepared(service, sourceText);
    const result = service.finalize({
      source,
      currentDocumentVersion: 7,
      splitReports: [splitReport(sourceText)],
      renderer: rendererReport(sourceText, { canonicalDescriptorRevision: 2 }),
      descriptors: { revision: 3, blocks: [block(0, 'heading', sourceText)] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('canonical-revision-mismatch');
  });

  it('bounds the number of split reports accepted by one snapshot operation', () => {
    const service = new FeedbackSnapshotService();
    const sourceText = '# Current source';
    const source = requirePrepared(service, sourceText);
    const splitReports = Array.from({ length: 65 }, (_, index) =>
      splitReport(sourceText, {
        viewId: `rich-view-${index + 1}`,
        viewGeneration: `rich-view-${index + 1}:g1`,
      })
    );
    const result = service.finalize({
      source,
      currentDocumentVersion: 7,
      splitReports,
      renderer: rendererReport(sourceText),
      descriptors: { revision: 3, blocks: [block(0, 'heading', sourceText)] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('invalid-input');
  });

  it('indexes source lines once instead of splitting the full document per canonical block', () => {
    const service = new FeedbackSnapshotService();
    const blockCount = 500;
    const sourceText = Array.from(
      { length: blockCount },
      (_, index) => `Paragraph ${index + 1}.`
    ).join('\n\n');
    const source = requirePrepared(service, sourceText);
    const descriptors = Array.from({ length: blockCount }, (_, index) =>
      block(index, 'paragraph', `Paragraph ${index + 1}.`)
    );
    const splitSpy = jest.spyOn(String.prototype, 'split');

    try {
      const result = service.finalize({
        source,
        currentDocumentVersion: 7,
        splitReports: [splitReport(sourceText)],
        renderer: rendererReport(sourceText),
        descriptors: { revision: 3, blocks: descriptors },
      });

      expect(result.ok).toBe(true);
      const fullSourceSplitCount = splitSpy.mock.contexts.filter(
        context => String(context) === sourceText
      ).length;
      expect(fullSourceSplitCount).toBeLessThanOrEqual(8);
    } finally {
      splitSpy.mockRestore();
    }
  });

  it.each([
    {
      label: 'fenced code',
      sourceText: '```ts\nconst value = 2;\n```',
      descriptor: block(0, 'codeBlock', '```ts\nconst value = 1;\n```'),
    },
    {
      label: 'table cells',
      sourceText: '| Name | Value |\n| --- | --- |\n| current | 2 |',
      descriptor: block(0, 'table', '| Name | Value |\n| --- | --- |\n| old | 1 |'),
    },
    {
      label: 'raw HTML',
      sourceText: '<section><strong>Current</strong></section>',
      descriptor: block(0, 'html', '<section><strong>Old</strong></section>'),
    },
    {
      label: 'frontmatter',
      sourceText: '---\ntitle: Current\n---',
      descriptor: block(0, 'codeBlock', '```yaml\n---\ntitle: Old\n---\n```'),
    },
  ])('uses content fingerprints for strict $label parity', ({ sourceText, descriptor }) => {
    const service = new FeedbackSnapshotService();
    const source = requirePrepared(service, sourceText);
    const result = service.finalize({
      source,
      currentDocumentVersion: 7,
      splitReports: [splitReport(sourceText)],
      renderer: rendererReport(sourceText),
      descriptors: { revision: 3, blocks: [descriptor] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('block-content-mismatch');
  });

  it('resolves a shortcut reference link against the whole document when fingerprinting a block', () => {
    const service = new FeedbackSnapshotService();
    const sourceText = [
      '## [Unreleased]',
      '',
      '[Unreleased]: https://github.com/example/repo/compare/v1.0.0...HEAD',
    ].join('\n');
    const source = requirePrepared(service, sourceText);
    const result = service.finalize({
      source,
      currentDocumentVersion: 7,
      splitReports: [splitReport(sourceText)],
      renderer: rendererReport(sourceText),
      descriptors: {
        revision: 3,
        blocks: [
          block(
            0,
            'heading',
            '## [Unreleased](https://github.com/example/repo/compare/v1.0.0...HEAD)'
          ),
        ],
      },
    });

    expect(result.ok).toBe(true);
  });

  it('still rejects a canonical link that does not match the resolved reference target', () => {
    const service = new FeedbackSnapshotService();
    const sourceText = [
      '## [Unreleased]',
      '',
      '[Unreleased]: https://github.com/example/repo/compare/v1.0.0...HEAD',
    ].join('\n');
    const source = requirePrepared(service, sourceText);
    const result = service.finalize({
      source,
      currentDocumentVersion: 7,
      splitReports: [splitReport(sourceText)],
      renderer: rendererReport(sourceText),
      descriptors: {
        revision: 3,
        blocks: [block(0, 'heading', '## [Unreleased](https://evil.example.com)')],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('block-content-mismatch');
  });
});
