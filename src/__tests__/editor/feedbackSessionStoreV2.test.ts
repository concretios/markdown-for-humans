/**
 * Persistence integration contract for Feedback evidence v2.
 *
 * The store owns schema dispatch, exact source bytes, atomic migration, and
 * screenshot assets. Target resolution remains a host responsibility.
 */

import { createHash } from 'crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { deflateSync } from 'zlib';
import {
  FeedbackSessionStore,
  computeFeedbackSourceSha256,
  type FeedbackV2MutationOptions,
} from '../../editor/feedbackSessionStore';
import { renderFeedbackReportV2 } from '../../editor/feedbackReportV2';
import type {
  FeedbackEvidenceEnvelopeV2,
  FeedbackItemV2,
  FeedbackTargetV2,
} from '../../shared/feedbackEvidenceV2';

const NOW = new Date('2026-08-31T09:30:00.000Z');
const SEALED_AT = new Date('2026-08-31T09:35:00.000Z');
const SOURCE_TEXT = '# Guide\n\nFirst paragraph.\n\nSecond paragraph.\n';
const SOURCE_BYTES = Buffer.from(SOURCE_TEXT, 'utf8');
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.byteLength);
  return chunk;
}

function makeRgbaPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows: number[] = [];
  for (let row = 0; row < height; row += 1) {
    rows.push(0);
    for (let column = 0; column < width; column += 1) rows.push(40, 80, 120, 255);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.from(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function paragraphSpan(ordinal: number, text: string) {
  const hash = sha256(text);
  return {
    startOrdinal: ordinal,
    endOrdinal: ordinal,
    startKind: 'paragraph',
    endKind: 'paragraph',
    startBlockSha256: hash,
    endBlockSha256: hash,
  } as const;
}

function sourceEvidence(
  text: string,
  relationship: 'selected-blocks' | 'containing-blocks'
): FeedbackEvidenceEnvelopeV2 {
  return {
    effective: {
      kind: 'source',
      fidelity: 'source-exact',
      relationship,
      format: 'markdown',
      normalization: 'lf',
      sourceSliceSha256: sha256(text),
      availability: 'embedded',
      text,
      utf8Bytes: Buffer.byteLength(text, 'utf8'),
    },
  };
}

function exactBlockTarget(ordinal: number, text: string): FeedbackTargetV2 {
  return {
    version: 2,
    requestedScope: 'blocks',
    effectiveScope: 'blocks',
    resolution: 'exact',
    blockSpan: paragraphSpan(ordinal, text),
  };
}

function exactTableCellTarget(
  ordinal: number,
  blockText: string
): Extract<FeedbackTargetV2, { resolution: 'exact' }> {
  const blockHash = sha256(blockText);
  return {
    version: 2,
    requestedScope: 'table-cells',
    effectiveScope: 'table-cells',
    resolution: 'exact',
    blockSpan: {
      startOrdinal: ordinal,
      endOrdinal: ordinal,
      startKind: 'table',
      endKind: 'table',
      startBlockSha256: blockHash,
      endBlockSha256: blockHash,
    },
    locator: {
      kind: 'table-cells',
      value: {
        version: 1,
        tableOrdinal: ordinal,
        rectangle: { top: 0, left: 0, bottom: 1, right: 1 },
        tableFingerprint: 'md4h-table/v1:0123456789abcdef',
        tableBlockSha256: blockHash,
      },
    },
  };
}

function addBlockInput(
  text = 'First paragraph.',
  startLine = 3,
  ordinal = 1,
  feedback = 'Clarify this paragraph.'
) {
  return {
    startLine,
    endLine: startLine,
    feedback,
    target: exactBlockTarget(ordinal, text),
    evidence: sourceEvidence(text, 'selected-blocks'),
  } as const;
}

function migratedLegacyItem(feedback = 'Preserve this old note.'): FeedbackItemV2 {
  return {
    id: 'F1',
    sequence: 1,
    kind: 'text',
    startLine: 3,
    endLine: 3,
    feedback,
    target: {
      version: 2,
      effectiveScope: 'blocks',
      resolution: 'legacy-unknown',
      legacyOrigin: 'v1-no-locator',
      blockSpan: paragraphSpan(1, 'First paragraph.'),
    },
    evidence: {
      effective: sourceEvidence('First paragraph.', 'containing-blocks').effective,
      original: {
        kind: 'legacy-focus',
        fidelity: 'legacy-unclassified',
        text: 'First paragraph.',
      },
    },
  };
}

describe('FeedbackSessionStore v2 persistence', () => {
  let workspaceRoot: string;
  let sourcePath: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'md4h-feedback-store-v2-'));
    sourcePath = path.join(workspaceRoot, 'docs', 'guide.md');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, SOURCE_BYTES);
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  async function createV2(roundSuffix: string): Promise<FeedbackSessionStore> {
    return FeedbackSessionStore.create({
      workspaceRoot,
      sourcePath,
      sourceBytes: SOURCE_BYTES,
      schemaVersion: 2,
      now: NOW,
      roundSuffix,
    });
  }

  async function createV1(roundSuffix: string): Promise<FeedbackSessionStore> {
    return FeedbackSessionStore.create({
      workspaceRoot,
      sourcePath,
      sourceBytes: SOURCE_BYTES,
      now: NOW,
      roundSuffix,
    });
  }

  it('keeps v1 as the creation default and dispatches explicit v2 writes exactly', async () => {
    const v1 = await createV1('sv01');
    const v2 = await createV2('sv02');

    expect(v1.schemaVersion).toBe(1);
    expect(v2.schemaVersion).toBe(2);
    expect(v1.snapshot).toMatchObject({ schema: 'md4h-feedback/v1', state: 'draft' });
    expect(v2.snapshot).toMatchObject({
      schema: 'md4h-feedback/v2',
      guideVersion: 2,
      state: 'draft',
    });
    await expect(readFile(v1.feedbackFilePath, 'utf8')).resolves.toContain(
      'schema: md4h-feedback/v1'
    );
    await expect(readFile(v2.feedbackFilePath, 'utf8')).resolves.toContain(
      'schema: md4h-feedback/v2\nguide_version: 2'
    );
  });

  it('stores, updates, deletes, restores, and strictly resumes canonical v2 text items', async () => {
    const store = await createV2('tx01');
    const added = await store.addTextFeedbackV2(addBlockInput());

    expect(added).toMatchObject({ id: 'F1', sequence: 1, kind: 'text' });
    expect(store.items).toEqual([added]);
    await store.updateFeedbackV2('F1', 'Use a concrete opening sentence.');
    const deleted = await store.deleteFeedbackV2('F1');
    expect(deleted.feedback).toBe('Use a concrete opening sentence.');
    expect(store.items).toEqual([]);
    await store.restoreFeedbackV2('F1');
    expect(store.items).toEqual([
      expect.objectContaining({ id: 'F1', feedback: 'Use a concrete opening sentence.' }),
    ]);

    const resumed = await FeedbackSessionStore.resume({
      workspaceRoot,
      sourcePath,
      sourceBytes: SOURCE_BYTES,
      round: store.snapshot.round,
    });
    expect(resumed.schemaVersion).toBe(2);
    expect(resumed.snapshot).toEqual(store.snapshot);
    expect(resumed.items).toEqual(store.items);
    expect(await readFile(store.feedbackFilePath, 'utf8')).not.toContain('**Focus:**');
  });

  it('rejects legacy Focus for a brand-new exact-cell item but retains the migration exception', async () => {
    const tableText = '| Name |\n| --- |\n| Alice |';
    const target = exactTableCellTarget(1, tableText);
    const legacyEvidence = {
      effective: {
        kind: 'legacy-focus',
        fidelity: 'legacy-unclassified',
        text: 'Alice',
      },
    } as const;
    const v2 = await createV2('lc01');

    await expect(
      v2.addTextFeedbackV2({
        startLine: 3,
        endLine: 3,
        feedback: 'Use a typed cell matrix.',
        target,
        evidence: legacyEvidence,
      })
    ).rejects.toThrow(/typed.*matrix|migration/i);
    expect(v2.items).toEqual([]);

    const v1 = await createV1('lc02');
    const cellTarget = target.locator?.kind === 'table-cells' ? target.locator.value : undefined;
    expect(cellTarget).toBeDefined();
    await v1.addTextFeedback({
      startLine: 3,
      endLine: 3,
      focus: 'Alice',
      feedback: 'Preserve this migrated cell note.',
      cellTarget,
    });
    const migratedItem: FeedbackItemV2 = {
      id: 'F1',
      sequence: 1,
      kind: 'text',
      startLine: 3,
      endLine: 3,
      feedback: 'Preserve this migrated cell note.',
      target,
      evidence: legacyEvidence,
    };

    const added = await v1.addTextFeedbackV2(addBlockInput('Second paragraph.', 5, 2), {
      migrationItems: [migratedItem],
    });
    expect(added.id).toBe('F2');
    expect(v1.schemaVersion).toBe(2);
    expect(v1.items[0]).toEqual(migratedItem);
  });

  it('defensively retains source bytes for canonical source evidence', async () => {
    const mutableBytes = Uint8Array.from(SOURCE_BYTES);
    const store = await FeedbackSessionStore.create({
      workspaceRoot,
      sourcePath,
      sourceBytes: mutableBytes,
      schemaVersion: 2,
      now: NOW,
      roundSuffix: 'cp01',
    });
    mutableBytes.fill(0x78);

    const item = await store.addTextFeedbackV2({
      ...addBlockInput(),
      evidence: sourceEvidence('wrong caller text', 'selected-blocks'),
    });
    expect(item.evidence.effective).toMatchObject({
      kind: 'source',
      availability: 'embedded',
      text: 'First paragraph.',
      sourceSliceSha256: sha256('First paragraph.'),
    });
    expect(store.snapshot.sourceSha256).toBe(computeFeedbackSourceSha256(SOURCE_BYTES));

    const internallyCanonicalButWrong = renderFeedbackReportV2(
      store.snapshot,
      [{ ...item, evidence: sourceEvidence('Second paragraph.', 'selected-blocks') }],
      2
    );
    await writeFile(store.feedbackFilePath, internallyCanonicalButWrong);
    await expect(
      FeedbackSessionStore.resume({
        workspaceRoot,
        sourcePath,
        sourceBytes: SOURCE_BYTES,
        round: store.snapshot.round,
      })
    ).rejects.toThrow(/frozen source bytes/i);
  });

  it('persists screenshot dimensions, visual evidence, and strict asset bindings', async () => {
    const store = await createV2('im01');
    const item = await store.addScreenshotFeedbackV2({
      startLine: 3,
      endLine: 3,
      feedback: 'Clarify this captured region.',
      pngData: ONE_PIXEL_PNG_BASE64,
      target: {
        version: 2,
        requestedScope: 'visual-region',
        effectiveScope: 'visual-region',
        resolution: 'exact',
        blockSpan: paragraphSpan(1, 'First paragraph.'),
      },
      sourceReference: {
        relationship: 'containing-blocks',
        format: 'markdown',
        normalization: 'lf',
        sourceSliceSha256: sha256('First paragraph.'),
      },
    });

    expect(item).toMatchObject({
      id: 'F1',
      kind: 'screenshot',
      width: 1,
      height: 1,
      assetRelativePath: 'assets/F1.png',
      assetSha256: sha256(Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64')),
      evidence: {
        effective: {
          kind: 'visual',
          fidelity: 'visual-exact',
          width: 1,
          height: 1,
          sourceReference: {
            relationship: 'containing-blocks',
            sourceSliceSha256: sha256('First paragraph.'),
          },
        },
      },
    });
    await expect(store.getValidatedScreenshotMetadata('F1')).resolves.toEqual({
      width: 1,
      height: 1,
    });
    const resumed = await FeedbackSessionStore.resume({
      workspaceRoot,
      sourcePath,
      sourceBytes: SOURCE_BYTES,
      round: store.snapshot.round,
    });
    expect(resumed.items).toEqual([item]);
  });

  it('revalidates the assets directory immediately before restoring a v2 screenshot', async () => {
    const store = await createV2('im03');
    await store.addScreenshotFeedbackV2({
      startLine: 3,
      endLine: 3,
      feedback: 'Restore only inside the bundle.',
      pngData: ONE_PIXEL_PNG_BASE64,
      target: {
        version: 2,
        requestedScope: 'visual-region',
        effectiveScope: 'visual-region',
        resolution: 'exact',
        blockSpan: paragraphSpan(1, 'First paragraph.'),
      },
      sourceReference: {
        relationship: 'containing-blocks',
        format: 'markdown',
        normalization: 'lf',
        sourceSliceSha256: sha256('First paragraph.'),
      },
    });
    await store.deleteFeedbackV2('F1');
    const assetsDirectory = path.join(store.bundleDirectory, 'assets');
    await rename(assetsDirectory, `${assetsDirectory}-original`);
    const outside = await mkdtemp(path.join(tmpdir(), 'md4h-feedback-v2-restore-outside-'));
    await symlink(outside, assetsDirectory);

    try {
      await expect(store.restoreFeedbackV2('F1')).rejects.toThrow(/symbolic.?link|unsafe|storage/i);
      await expect(stat(path.join(outside, 'F1.png'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(store.items).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('atomically replaces a v2 screenshot and rolls back both files when the guard rejects', async () => {
    const store = await createV2('im02');
    const original = await store.addScreenshotFeedbackV2({
      startLine: 3,
      endLine: 3,
      feedback: 'Clarify this captured region.',
      pngData: makeRgbaPng(1, 1),
      target: {
        version: 2,
        requestedScope: 'visual-region',
        effectiveScope: 'visual-region',
        resolution: 'exact',
        blockSpan: paragraphSpan(1, 'First paragraph.'),
      },
      sourceReference: {
        relationship: 'containing-blocks',
        format: 'markdown',
        normalization: 'lf',
        sourceSliceSha256: sha256('First paragraph.'),
      },
    });
    const assetPath = path.join(path.dirname(store.feedbackFilePath), original.assetRelativePath);
    const originalReport = await readFile(store.feedbackFilePath);
    const originalAsset = await readFile(assetPath);
    let guardCalls = 0;

    await expect(
      store.replaceScreenshotFeedbackV2(
        'F1',
        {
          startLine: 5,
          endLine: 5,
          feedback: 'Use this larger captured region.',
          pngData: makeRgbaPng(2, 1),
          target: {
            version: 2,
            requestedScope: 'visual-region',
            effectiveScope: 'visual-region',
            resolution: 'exact',
            blockSpan: paragraphSpan(2, 'Second paragraph.'),
          },
          sourceReference: {
            relationship: 'containing-blocks',
            format: 'markdown',
            normalization: 'lf',
            sourceSliceSha256: sha256('Second paragraph.'),
          },
        },
        {
          beforeCommit: () => {
            guardCalls += 1;
            if (guardCalls === 2) throw new Error('reject replacement');
          },
        }
      )
    ).rejects.toThrow('reject replacement');
    await expect(readFile(store.feedbackFilePath)).resolves.toEqual(originalReport);
    await expect(readFile(assetPath)).resolves.toEqual(originalAsset);
    expect(store.items).toEqual([original]);

    const replaced = await store.replaceScreenshotFeedbackV2('F1', {
      startLine: 5,
      endLine: 5,
      feedback: 'Use this larger captured region.',
      pngData: makeRgbaPng(2, 1),
      target: {
        version: 2,
        requestedScope: 'visual-region',
        effectiveScope: 'visual-region',
        resolution: 'exact',
        blockSpan: paragraphSpan(2, 'Second paragraph.'),
      },
      sourceReference: {
        relationship: 'containing-blocks',
        format: 'markdown',
        normalization: 'lf',
        sourceSliceSha256: sha256('Second paragraph.'),
      },
    });
    expect(replaced).toMatchObject({ id: 'F1', sequence: 1, width: 2, height: 1 });
    expect(replaced.evidence.effective).toMatchObject({ kind: 'visual', width: 2, height: 1 });
  });

  it('does not rewrite a resumed v1 draft until a v2 mutation commits', async () => {
    const original = await createV1('mg01');
    await original.addTextFeedback({
      startLine: 3,
      endLine: 3,
      focus: 'First paragraph.',
      feedback: 'Preserve this old note.',
    });
    const bytesBeforeResume = await readFile(original.feedbackFilePath);
    const resumed = await FeedbackSessionStore.resume({
      workspaceRoot,
      sourcePath,
      sourceBytes: SOURCE_BYTES,
      round: original.snapshot.round,
    });

    await expect(readFile(original.feedbackFilePath)).resolves.toEqual(bytesBeforeResume);
    await expect(
      resumed.addTextFeedbackV2(addBlockInput('Second paragraph.', 5, 2))
    ).rejects.toThrow(/migration/i);
    await expect(readFile(original.feedbackFilePath)).resolves.toEqual(bytesBeforeResume);
  });

  it('atomically combines v1 migration with the triggering v2 mutation and rolls back exactly', async () => {
    const original = await createV1('mg02');
    await original.addTextFeedback({
      startLine: 3,
      endLine: 3,
      focus: 'First paragraph.',
      feedback: 'Preserve this old note.',
    });
    const v1Bytes = await readFile(original.feedbackFilePath);
    const observedReports: string[] = [];
    const migrationItems = [migratedLegacyItem()];
    const options: FeedbackV2MutationOptions = {
      migrationItems,
      beforeCommit: async () => {
        observedReports.push(await readFile(original.feedbackFilePath, 'utf8'));
        if (observedReports.length === 2) throw new Error('guard rejected final state');
      },
    };

    await expect(
      original.addTextFeedbackV2(addBlockInput('Second paragraph.', 5, 2), options)
    ).rejects.toThrow('guard rejected final state');
    expect(observedReports[0]).toContain('schema: md4h-feedback/v1');
    expect(observedReports[1]).toContain('schema: md4h-feedback/v2');
    expect(observedReports[1]).toContain('## F1 · text');
    expect(observedReports[1]).toContain('## F2 · text');
    await expect(readFile(original.feedbackFilePath)).resolves.toEqual(v1Bytes);
    expect(original.schemaVersion).toBe(1);

    const added = await original.addTextFeedbackV2(addBlockInput('Second paragraph.', 5, 2), {
      migrationItems,
    });
    expect(added.id).toBe('F2');
    expect(original.schemaVersion).toBe(2);
    expect(original.items).toHaveLength(2);
    expect(await readFile(original.feedbackFilePath, 'utf8')).toContain('schema: md4h-feedback/v2');
  });

  it('revalidates store-owned screenshot dimensions before a v1 draft migrates', async () => {
    const original = await createV1('mg04');
    const legacy = await original.addScreenshotFeedback({
      startLine: 3,
      endLine: 3,
      feedback: 'Preserve this captured note.',
      pngData: makeRgbaPng(1, 1),
    });
    const reportBeforeMigration = await readFile(original.feedbackFilePath);
    const dimensions = await original.getValidatedScreenshotMetadata('F1');
    const migrationItem = {
      id: legacy.id,
      sequence: legacy.sequence,
      kind: 'screenshot',
      startLine: legacy.startLine,
      endLine: legacy.endLine,
      feedback: legacy.feedback,
      target: {
        version: 2,
        requestedScope: 'visual-region',
        effectiveScope: 'visual-region',
        resolution: 'exact',
        blockSpan: paragraphSpan(1, 'First paragraph.'),
      },
      evidence: {
        effective: {
          kind: 'visual',
          fidelity: 'visual-exact',
          assetRelativePath: legacy.assetRelativePath,
          assetSha256: legacy.assetSha256,
          width: dimensions.width,
          height: dimensions.height,
          sourceReference: {
            relationship: 'containing-blocks',
            format: 'markdown',
            normalization: 'lf',
            sourceSliceSha256: sha256('First paragraph.'),
          },
        },
      },
      assetRelativePath: legacy.assetRelativePath,
      assetSha256: legacy.assetSha256,
      width: dimensions.width,
      height: dimensions.height,
    } as const;

    await expect(
      original.updateFeedbackV2('F1', 'Update this captured note.', {
        migrationItems: [
          {
            ...migrationItem,
            width: 2,
            evidence: {
              effective: { ...migrationItem.evidence.effective, width: 2 },
            },
          },
        ],
      })
    ).rejects.toThrow(/screenshot asset/i);
    await expect(readFile(original.feedbackFilePath)).resolves.toEqual(reportBeforeMigration);
    expect(original.schemaVersion).toBe(1);

    await original.updateFeedbackV2('F1', 'Update this captured note.', {
      migrationItems: [migrationItem],
    });
    expect(original.schemaVersion).toBe(2);
    expect(original.items).toEqual([
      expect.objectContaining({ kind: 'screenshot', width: 1, height: 1 }),
    ]);
  });

  it('allows a stale v1 locator to migrate onto host-rederived containing blocks', async () => {
    const original = await createV1('mg05');
    const staleHash = sha256('stale paragraph');
    await original.addTextFeedback({
      startLine: 3,
      endLine: 3,
      focus: 'First paragraph.',
      feedback: 'Preserve this stale selection.',
      renderedRange: {
        version: 1,
        startOrdinal: 1,
        startOffset: 0,
        endOrdinal: 1,
        endOffset: 'First paragraph.'.length,
        startBlockSha256: staleHash,
        endBlockSha256: staleHash,
      },
    });

    await original.seal(SOURCE_BYTES, SEALED_AT, {
      migrationItems: [
        {
          id: 'F1',
          sequence: 1,
          kind: 'text',
          startLine: 3,
          endLine: 3,
          feedback: 'Preserve this stale selection.',
          target: {
            version: 2,
            requestedScope: 'rendered-text',
            effectiveScope: 'blocks',
            resolution: 'degraded',
            coarsening: { reason: 'stale-locator', origin: 'host' },
            blockSpan: paragraphSpan(1, 'First paragraph.'),
          },
          evidence: {
            effective: sourceEvidence('First paragraph.', 'containing-blocks').effective,
            original: {
              kind: 'rendered-text',
              fidelity: 'rendered-exact',
              text: 'First paragraph.',
              complete: true,
            },
          },
        },
      ],
    });
    expect(original.items).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({
          resolution: 'degraded',
          blockSpan: expect.objectContaining({
            startBlockSha256: sha256('First paragraph.'),
          }),
        }),
      }),
    ]);
  });

  it('atomically migrates a v1 draft during seal without an intermediate draft rewrite', async () => {
    const original = await createV1('mg03');
    await original.addTextFeedback({
      startLine: 3,
      endLine: 3,
      focus: 'First paragraph.',
      feedback: 'Preserve this old note.',
    });
    const observedReports: string[] = [];
    const result = await original.seal(SOURCE_BYTES, SEALED_AT, {
      migrationItems: [migratedLegacyItem()],
      beforeCommit: async () => {
        observedReports.push(await readFile(original.feedbackFilePath, 'utf8'));
      },
    });

    expect(observedReports).toHaveLength(2);
    expect(observedReports[0]).toContain('schema: md4h-feedback/v1');
    expect(observedReports[1]).toContain('schema: md4h-feedback/v2');
    expect(observedReports[1]).toContain('state: sealed');
    expect(original.schemaVersion).toBe(2);
    expect(original.snapshot).toMatchObject({ state: 'sealed', sealedAt: SEALED_AT.toISOString() });
    expect(result.itemCount).toBe(1);
  });

  it('accepts only target and evidence resolution changes in host-resolved v2 seal items', async () => {
    const store = await createV2('sl01');
    const renderedText = 'First paragraph.';
    const exact = await store.addTextFeedbackV2({
      startLine: 3,
      endLine: 3,
      feedback: 'Tighten this sentence.',
      target: {
        version: 2,
        requestedScope: 'rendered-text',
        effectiveScope: 'rendered-text',
        resolution: 'exact',
        blockSpan: paragraphSpan(1, renderedText),
        locator: {
          kind: 'rendered-range',
          value: {
            version: 1,
            startOrdinal: 1,
            startOffset: 0,
            endOrdinal: 1,
            endOffset: renderedText.length,
            startBlockSha256: sha256(renderedText),
            endBlockSha256: sha256(renderedText),
          },
        },
      },
      evidence: {
        effective: {
          kind: 'rendered-text',
          fidelity: 'rendered-exact',
          text: renderedText,
          complete: true,
        },
      },
    });
    const resolved: FeedbackItemV2 = {
      ...exact,
      target: {
        version: 2,
        requestedScope: 'rendered-text',
        effectiveScope: 'blocks',
        resolution: 'degraded',
        coarsening: { reason: 'stale-locator', origin: 'host' },
        blockSpan: {
          ...paragraphSpan(1, renderedText),
          startBlockSha256: sha256('Host-rederived paragraph hash.'),
          endBlockSha256: sha256('Host-rederived paragraph hash.'),
        },
      },
      evidence: {
        effective: sourceEvidence(renderedText, 'containing-blocks').effective,
        original: exact.evidence.effective,
      },
    };

    await expect(
      store.seal(SOURCE_BYTES, SEALED_AT, {
        resolvedItemsV2: [{ ...resolved, feedback: 'Changed during sealing.' }],
      })
    ).rejects.toThrow(/preserve|changed/i);
    expect(store.snapshot.state).toBe('draft');

    await expect(
      store.seal(SOURCE_BYTES, SEALED_AT, {
        resolvedItemsV2: [
          {
            ...exact,
            target: exactBlockTarget(1, renderedText),
            evidence: sourceEvidence(renderedText, 'selected-blocks'),
          },
        ],
      })
    ).rejects.toThrow(/preserve|transition|changed/i);
    expect(store.snapshot.state).toBe('draft');

    await expect(
      store.seal(SOURCE_BYTES, SEALED_AT, {
        resolvedItemsV2: [
          {
            ...resolved,
            target: {
              ...resolved.target,
              blockSpan: {
                ...resolved.target.blockSpan,
                startOrdinal: 2,
                endOrdinal: 2,
              },
            },
          },
        ],
      })
    ).rejects.toThrow(/block span|preserve|transition|changed/i);
    expect(store.snapshot.state).toBe('draft');

    await expect(
      store.seal(SOURCE_BYTES, SEALED_AT, {
        resolvedItemsV2: [
          {
            ...resolved,
            target: {
              ...resolved.target,
              blockSpan: {
                ...resolved.target.blockSpan,
                startKind: 'heading',
                endKind: 'heading',
              },
            },
          },
        ],
      })
    ).rejects.toThrow(/block span|preserve|transition|changed/i);
    expect(store.snapshot.state).toBe('draft');

    await store.seal(SOURCE_BYTES, SEALED_AT, { resolvedItemsV2: [resolved] });
    expect(store.snapshot.state).toBe('sealed');
    expect(store.items).toEqual([
      expect.objectContaining({
        id: 'F1',
        target: expect.objectContaining({ resolution: 'degraded' }),
        evidence: expect.objectContaining({
          original: expect.objectContaining({ kind: 'rendered-text' }),
        }),
      }),
    ]);
  });

  it('allows byte-equivalent v2 target and evidence through explicit seal resolution', async () => {
    const store = await createV2('sl02');
    const item = await store.addTextFeedbackV2(addBlockInput());

    await store.seal(SOURCE_BYTES, SEALED_AT, { resolvedItemsV2: [item] });

    expect(store.snapshot.state).toBe('sealed');
    expect(store.items).toEqual([item]);
  });

  it('rejects unknown schemas without falling through either strict reader', async () => {
    const store = await createV2('rd01');
    const report = await readFile(store.feedbackFilePath, 'utf8');
    await writeFile(store.feedbackFilePath, report.replace('md4h-feedback/v2', 'md4h-feedback/v3'));

    const discovery = await FeedbackSessionStore.findMatchingDrafts({
      workspaceRoot,
      sourcePath,
      sourceBytes: SOURCE_BYTES,
    });
    expect(discovery.invalidCandidates).toEqual([
      expect.objectContaining({ round: store.snapshot.round, reason: 'schema-mismatch' }),
    ]);
    await expect(
      FeedbackSessionStore.resume({
        workspaceRoot,
        sourcePath,
        sourceBytes: SOURCE_BYTES,
        round: store.snapshot.round,
      })
    ).rejects.toThrow(/schema.*supported/i);
  });
});
