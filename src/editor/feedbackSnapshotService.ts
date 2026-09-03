/**
 * @file feedbackSnapshotService.ts - Atomic Feedback snapshot verification
 * @description Proves that one saved source, document version, renderer state,
 *              split set, and canonical block set describe the same content.
 *              The service performs no I/O and has no VS Code dependency.
 *
 * Key responsibilities:
 * - Bind exact TextDocument text and saved bytes to separate SHA-256 digests
 * - Reject stale document, renderer, and split identities
 * - Fail closed when dirty splits have divergent content
 * - Verify canonical block content, not only block count, order, and kind
 */

import { createHash } from 'crypto';
import MarkdownIt from 'markdown-it';
import {
  buildFeedbackAnchorMap,
  type FeedbackAnchorKind,
  type FeedbackAnchorSpan,
} from './feedbackAnchors';
import type { CanonicalFeedbackBlock } from '../shared/feedbackProtocol';
import { isMarkdownRendererEquivalent } from './markdownAstEquivalence';

export const FEEDBACK_SNAPSHOT_ERROR_CODE = 'MD4H-FB-SNAPSHOT-001' as const;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_DOCUMENT_URI_LENGTH = 32 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_CANONICAL_BLOCKS = 100_000;
const MAX_SPLIT_REPORTS = 64;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const markdownParser = new MarkdownIt({
  html: true,
  breaks: false,
  linkify: false,
});

/** Exact source state captured after the edit queue drained and save completed. */
export interface FeedbackPreparedSourceSnapshot {
  readonly documentUri: string;
  readonly operationId: string;
  readonly documentVersion: number;
  /** Retained only until renderer verification and omitted from the final identity. */
  readonly sourceText: string;
  readonly sourceTextSha256: string;
  readonly savedBytesSha256: string;
  readonly sourceByteCount: number;
}

/** One quiesced rich-view report included in split convergence. */
export interface FeedbackSplitSnapshotReport {
  readonly viewId: string;
  readonly viewGeneration: string;
  readonly localRevision: number;
  readonly documentVersion: number;
  readonly dirty: boolean;
  readonly contentSha256: string;
}

/** Owner report produced after applying the authoritative source snapshot. */
export interface FeedbackRendererSnapshotReport {
  readonly viewId: string;
  readonly viewGeneration: string;
  readonly localRevision: number;
  readonly documentVersion: number;
  readonly contentSha256: string;
  readonly canonicalDescriptorRevision: number;
}

/** Canonical blocks tied to one renderer descriptor revision. */
export interface FeedbackCanonicalDescriptorSet {
  readonly revision: number;
  readonly blocks: readonly CanonicalFeedbackBlock[];
}

/** Content proof for one canonical rich-view block. */
export interface FeedbackBlockContentFingerprint {
  readonly ordinal: number;
  readonly kind: FeedbackAnchorKind;
  readonly contentSha256: string;
}

/** Immutable identity safe to retain for one active Feedback round. */
export interface FeedbackSnapshotIdentity {
  readonly documentUri: string;
  readonly operationId: string;
  readonly documentVersion: number;
  readonly sourceTextSha256: string;
  readonly savedBytesSha256: string;
  readonly sourceByteCount: number;
  readonly renderer: Readonly<{
    viewId: string;
    viewGeneration: string;
    localRevision: number;
    contentSha256: string;
  }>;
  readonly canonicalDescriptorRevision: number;
  readonly blockCount: number;
  readonly blocks: readonly FeedbackBlockContentFingerprint[];
  readonly anchorMap: Readonly<{ blocks: readonly FeedbackAnchorSpan[] }>;
}

/** Stable fail-closed reasons for snapshot preparation and finalization. */
export type FeedbackSnapshotFailureReason =
  | 'invalid-input'
  | 'stale-document-version'
  | 'saved-byte-mismatch'
  | 'dirty-split-divergence'
  | 'split-content-mismatch'
  | 'renderer-content-mismatch'
  | 'renderer-report-mismatch'
  | 'canonical-revision-mismatch'
  | 'block-map-mismatch'
  | 'block-content-mismatch';

/** Content-free structured error returned instead of accepting uncertain state. */
export interface FeedbackSnapshotError {
  readonly code: typeof FEEDBACK_SNAPSHOT_ERROR_CODE;
  readonly reason: FeedbackSnapshotFailureReason;
  readonly detail: string;
}

export type FeedbackPrepareSourceResult =
  | { readonly ok: true; readonly source: FeedbackPreparedSourceSnapshot }
  | { readonly ok: false; readonly error: FeedbackSnapshotError };

export type FeedbackFinalizeSnapshotResult =
  | { readonly ok: true; readonly snapshot: FeedbackSnapshotIdentity }
  | { readonly ok: false; readonly error: FeedbackSnapshotError };

/** Inputs captured immediately around the save boundary. */
export interface FeedbackPrepareSourceInput {
  readonly documentUri: string;
  readonly operationId: string;
  readonly capturedDocumentVersion: number;
  readonly currentDocumentVersion: number;
  readonly sourceText: string;
  readonly savedBytes: Uint8Array;
}

/** Inputs supplied after the owner enumerates canonical blocks. */
export interface FeedbackFinalizeSnapshotInput {
  readonly source: FeedbackPreparedSourceSnapshot;
  readonly currentDocumentVersion: number;
  readonly splitReports: readonly FeedbackSplitSnapshotReport[];
  readonly renderer: FeedbackRendererSnapshotReport;
  readonly descriptors: FeedbackCanonicalDescriptorSet;
}

/** Compute an exact UTF-8 SHA-256 for TextDocument text. */
export function computeFeedbackTextSha256(sourceText: string): string {
  return createHash('sha256').update(sourceText, 'utf8').digest('hex');
}

/** Compute an exact SHA-256 over bytes read back from storage. */
export function computeFeedbackBytesSha256(sourceBytes: Uint8Array): string {
  return createHash('sha256').update(sourceBytes).digest('hex');
}

function failure(
  reason: FeedbackSnapshotFailureReason,
  detail: string
): { readonly ok: false; readonly error: FeedbackSnapshotError } {
  return {
    ok: false,
    error: {
      code: FEEDBACK_SNAPSHOT_ERROR_CODE,
      reason,
      detail,
    },
  };
}

function isIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function isDocumentUri(value: string): boolean {
  if (value.length === 0 || value.length > MAX_DOCUMENT_URI_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function isRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

function decodeSavedUtf8(sourceBytes: Uint8Array): string | null {
  const hasUtf8Bom =
    sourceBytes.byteLength >= 3 &&
    sourceBytes[0] === 0xef &&
    sourceBytes[1] === 0xbb &&
    sourceBytes[2] === 0xbf;
  const payload = hasUtf8Bom ? sourceBytes.subarray(3) : sourceBytes;

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    return null;
  }
}

function normalizeRenderedHtml(html: string): string {
  const verbatimPattern = /<(pre|code)\b[\s\S]*?<\/\1>/gi;
  const parts: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = verbatimPattern.exec(html)) !== null) {
    parts.push(html.slice(cursor, match.index).replace(/\s+/g, ' '));
    parts.push(match[0]);
    cursor = match.index + match[0].length;
  }

  parts.push(html.slice(cursor).replace(/\s+/g, ' '));
  return parts.join('').trim();
}

function normalizeLineEndings(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
}

function frontmatterPayload(markdown: string): string {
  const normalized = normalizeLineEndings(markdown);
  const lines = normalized.split('\n');
  const opening = lines[0]?.match(/^(`{3,}|~{3,})[ \t]*(yaml|yml|json)[ \t]*$/i);

  if (opening && lines.length >= 3) {
    const fence = opening[1];
    const closingPattern =
      fence[0] === '`'
        ? new RegExp('^`{' + fence.length + ',}[ \\t]*$')
        : new RegExp(`^~{${fence.length},}[ \\t]*$`);
    if (closingPattern.test(lines[lines.length - 1])) {
      const format = opening[2].toLowerCase() === 'json' ? 'json' : 'yaml';
      return `${format}\0${lines.slice(1, -1).join('\n')}`;
    }
  }

  const format = normalized.startsWith('{') ? 'json' : 'yaml';
  return `${format}\0${normalized}`;
}

/** Link reference definitions collected from markdown-it's `env.references`. */
type MarkdownReferenceMap = Record<string, { readonly title: string; readonly href: string }>;

function semanticBlockPayload(
  kind: FeedbackAnchorKind,
  markdown: string,
  references?: MarkdownReferenceMap
): string | null {
  if (kind === 'frontmatter') return frontmatterPayload(markdown);

  try {
    // Seeding env.references lets a block rendered in isolation (e.g. a
    // "## [Unreleased]" heading) resolve a shortcut reference link whose
    // "[Unreleased]: https://..." definition lives in a different block,
    // matching how the rich editor resolves it against the whole document.
    return normalizeRenderedHtml(markdownParser.render(markdown, references && { references }));
  } catch {
    return null;
  }
}

function blockFingerprint(
  kind: FeedbackAnchorKind,
  markdown: string,
  references?: MarkdownReferenceMap
): string | null {
  const payload = semanticBlockPayload(kind, markdown, references);
  if (payload === null) return null;
  return computeFeedbackTextSha256(`${kind}\0${payload}`);
}

function extractSourceBlock(
  sourceLines: readonly string[],
  span: Pick<FeedbackAnchorSpan, 'startLine' | 'endLine'>
): string {
  return sourceLines.slice(span.startLine - 1, span.endLine).join('\n');
}

function validatePreparedSource(
  source: FeedbackPreparedSourceSnapshot
): FeedbackSnapshotError | null {
  if (
    !isDocumentUri(source.documentUri) ||
    !isIdentifier(source.operationId) ||
    !isRevision(source.documentVersion) ||
    typeof source.sourceText !== 'string' ||
    source.sourceText.length > MAX_SOURCE_BYTES ||
    Buffer.byteLength(source.sourceText, 'utf8') > MAX_SOURCE_BYTES ||
    !isSha256(source.sourceTextSha256) ||
    !isSha256(source.savedBytesSha256) ||
    !Number.isSafeInteger(source.sourceByteCount) ||
    source.sourceByteCount < 0 ||
    source.sourceByteCount > MAX_SOURCE_BYTES + 3 ||
    computeFeedbackTextSha256(source.sourceText) !== source.sourceTextSha256
  ) {
    return failure('invalid-input', 'The prepared source identity is invalid.').error;
  }
  return null;
}

function validateSplitReport(report: FeedbackSplitSnapshotReport): boolean {
  return (
    isIdentifier(report.viewId) &&
    isIdentifier(report.viewGeneration) &&
    isRevision(report.localRevision) &&
    isRevision(report.documentVersion) &&
    typeof report.dirty === 'boolean' &&
    isSha256(report.contentSha256)
  );
}

function validateRendererReport(report: FeedbackRendererSnapshotReport): boolean {
  return (
    isIdentifier(report.viewId) &&
    isIdentifier(report.viewGeneration) &&
    isRevision(report.localRevision) &&
    isRevision(report.documentVersion) &&
    isSha256(report.contentSha256) &&
    isRevision(report.canonicalDescriptorRevision)
  );
}

function validateDescriptors(descriptors: FeedbackCanonicalDescriptorSet): boolean {
  if (
    !isRevision(descriptors.revision) ||
    !Array.isArray(descriptors.blocks) ||
    descriptors.blocks.length > MAX_CANONICAL_BLOCKS
  ) {
    return false;
  }

  let totalMarkdownBytes = 0;
  for (const block of descriptors.blocks) {
    if (
      !Number.isSafeInteger(block.ordinal) ||
      block.ordinal < 0 ||
      typeof block.kind !== 'string' ||
      block.kind.length === 0 ||
      block.kind.length > 128 ||
      typeof block.markdown !== 'string' ||
      !Number.isSafeInteger(block.contentSize) ||
      block.contentSize < 0
    ) {
      return false;
    }
    totalMarkdownBytes += Buffer.byteLength(block.markdown, 'utf8');
    if (totalMarkdownBytes > MAX_SOURCE_BYTES) return false;
  }

  return true;
}

/**
 * Stateless verifier for the two atomic snapshot stages.
 *
 * The adapter owns queue draining, saving, byte reads, and renderer messaging.
 * This service accepts their immutable outputs and either returns a proven
 * identity or one stable failure reason.
 */
export class FeedbackSnapshotService {
  /**
   * Bind captured TextDocument text to the exact bytes read after save.
   * UTF-8 BOM bytes remain part of the byte digest but are omitted for text
   * parity because VS Code does not expose the BOM in TextDocument text.
   */
  prepareSource(input: FeedbackPrepareSourceInput): FeedbackPrepareSourceResult {
    if (
      !isDocumentUri(input.documentUri) ||
      !isIdentifier(input.operationId) ||
      !isRevision(input.capturedDocumentVersion) ||
      !isRevision(input.currentDocumentVersion) ||
      typeof input.sourceText !== 'string' ||
      !(input.savedBytes instanceof Uint8Array) ||
      input.sourceText.length > MAX_SOURCE_BYTES ||
      Buffer.byteLength(input.sourceText, 'utf8') > MAX_SOURCE_BYTES ||
      input.savedBytes.byteLength > MAX_SOURCE_BYTES + 3
    ) {
      return failure('invalid-input', 'The source snapshot input is invalid or too large.');
    }

    if (input.capturedDocumentVersion !== input.currentDocumentVersion) {
      return failure(
        'stale-document-version',
        'The document version changed before the saved source could be bound.'
      );
    }

    const savedText = decodeSavedUtf8(input.savedBytes);
    if (savedText === null || savedText !== input.sourceText) {
      return failure(
        'saved-byte-mismatch',
        'The bytes read after save do not reproduce the captured document text.'
      );
    }

    const source = Object.freeze({
      documentUri: input.documentUri,
      operationId: input.operationId,
      documentVersion: input.capturedDocumentVersion,
      sourceText: input.sourceText,
      sourceTextSha256: computeFeedbackTextSha256(input.sourceText),
      savedBytesSha256: computeFeedbackBytesSha256(input.savedBytes),
      sourceByteCount: input.savedBytes.byteLength,
    });
    return { ok: true, source };
  }

  /**
   * Verify split convergence, renderer identity, descriptor revision, block
   * shape, and block content before returning an immutable snapshot identity.
   */
  finalize(input: FeedbackFinalizeSnapshotInput): FeedbackFinalizeSnapshotResult {
    const sourceError = validatePreparedSource(input.source);
    if (sourceError) return { ok: false, error: sourceError };

    if (!isRevision(input.currentDocumentVersion)) {
      return failure('invalid-input', 'The current document version is invalid.');
    }
    if (input.currentDocumentVersion !== input.source.documentVersion) {
      return failure(
        'stale-document-version',
        'The document version changed after the source snapshot was saved.'
      );
    }

    if (
      !Array.isArray(input.splitReports) ||
      input.splitReports.length === 0 ||
      input.splitReports.length > MAX_SPLIT_REPORTS ||
      !input.splitReports.every(validateSplitReport) ||
      !validateRendererReport(input.renderer) ||
      !validateDescriptors(input.descriptors)
    ) {
      return failure('invalid-input', 'The renderer snapshot input is invalid or too large.');
    }

    const viewIds = new Set<string>();
    const viewGenerations = new Set<string>();
    for (const report of input.splitReports) {
      if (viewIds.has(report.viewId) || viewGenerations.has(report.viewGeneration)) {
        return failure('invalid-input', 'Split reports must identify unique renderer lifetimes.');
      }
      viewIds.add(report.viewId);
      viewGenerations.add(report.viewGeneration);

      if (report.documentVersion !== input.source.documentVersion) {
        return failure(
          'stale-document-version',
          'A split report belongs to a stale document version.'
        );
      }
    }

    if (input.renderer.documentVersion !== input.source.documentVersion) {
      return failure(
        'stale-document-version',
        'The renderer report belongs to a stale document version.'
      );
    }
    if (input.renderer.contentSha256 !== input.source.sourceTextSha256) {
      return failure(
        'renderer-content-mismatch',
        'The renderer content does not match the saved source snapshot.'
      );
    }

    const dirtyDigests = new Set(
      input.splitReports.filter(report => report.dirty).map(report => report.contentSha256)
    );
    if (
      dirtyDigests.size > 1 ||
      (dirtyDigests.size === 1 && !dirtyDigests.has(input.source.sourceTextSha256))
    ) {
      return failure(
        'dirty-split-divergence',
        'Dirty editor splits did not converge to one saved source snapshot.'
      );
    }

    if (input.splitReports.some(report => report.contentSha256 !== input.source.sourceTextSha256)) {
      return failure(
        'split-content-mismatch',
        'A quiesced editor split does not match the saved source snapshot.'
      );
    }

    const ownerReports = input.splitReports.filter(
      report => report.viewId === input.renderer.viewId
    );
    const ownerReport = ownerReports.length === 1 ? ownerReports[0] : undefined;
    if (
      !ownerReport ||
      ownerReport.viewGeneration !== input.renderer.viewGeneration ||
      input.renderer.localRevision < ownerReport.localRevision
    ) {
      return failure(
        'renderer-report-mismatch',
        'The canonical renderer does not match its quiesced split identity.'
      );
    }

    if (input.renderer.canonicalDescriptorRevision !== input.descriptors.revision) {
      return failure(
        'canonical-revision-mismatch',
        'Canonical blocks do not match the renderer-reported descriptor revision.'
      );
    }

    const anchorResult = buildFeedbackAnchorMap(input.source.sourceText, input.descriptors.blocks);
    if (!anchorResult.ok) {
      return failure(
        'block-map-mismatch',
        'Canonical block shape does not match the saved source snapshot.'
      );
    }

    // Build the line index once. Splitting the complete source inside this
    // block loop makes snapshot finalization quadratic on long documents.
    const sourceLines = input.source.sourceText.split(/\r?\n/);

    // Collect link reference definitions ("[label]: url") from the whole
    // document once. A block rendered in isolation (e.g. a lone
    // "## [Unreleased]" heading) can't otherwise resolve a shortcut reference
    // link whose definition lives in a different block, even though the rich
    // editor parses the full document and resolves it correctly.
    const sourceReferencesEnv: { references?: MarkdownReferenceMap } = {};
    markdownParser.render(input.source.sourceText, sourceReferencesEnv);
    const sourceReferences = sourceReferencesEnv.references;

    const fingerprints: FeedbackBlockContentFingerprint[] = [];
    for (let index = 0; index < anchorResult.map.blocks.length; index += 1) {
      const anchor = anchorResult.map.blocks[index];
      const descriptor = input.descriptors.blocks[index];
      const sourceMarkdown = extractSourceBlock(sourceLines, anchor);
      const sourceFingerprint = blockFingerprint(anchor.kind, sourceMarkdown, sourceReferences);
      const canonicalFingerprint = blockFingerprint(anchor.kind, descriptor.markdown);

      // Keep the historical soft-wrap fingerprint first. The rich renderer
      // may instead serialize its visible single-newline break as `  \n`, so
      // accept that second, explicit rendering contract for non-frontmatter
      // blocks without weakening frontmatter's source-derived comparison.
      if (
        sourceFingerprint === null ||
        canonicalFingerprint === null ||
        (sourceFingerprint !== canonicalFingerprint &&
          (anchor.kind === 'frontmatter' ||
            !isMarkdownRendererEquivalent(sourceMarkdown, descriptor.markdown)))
      ) {
        return failure(
          'block-content-mismatch',
          'Canonical block content does not match the saved source snapshot.'
        );
      }

      fingerprints.push(
        Object.freeze({
          ordinal: descriptor.ordinal,
          kind: anchor.kind,
          contentSha256: canonicalFingerprint,
        })
      );
    }

    const frozenAnchors = Object.freeze(
      anchorResult.map.blocks.map(anchor => Object.freeze({ ...anchor }))
    );
    const snapshot: FeedbackSnapshotIdentity = Object.freeze({
      documentUri: input.source.documentUri,
      operationId: input.source.operationId,
      documentVersion: input.source.documentVersion,
      sourceTextSha256: input.source.sourceTextSha256,
      savedBytesSha256: input.source.savedBytesSha256,
      sourceByteCount: input.source.sourceByteCount,
      renderer: Object.freeze({
        viewId: input.renderer.viewId,
        viewGeneration: input.renderer.viewGeneration,
        localRevision: input.renderer.localRevision,
        contentSha256: input.renderer.contentSha256,
      }),
      canonicalDescriptorRevision: input.descriptors.revision,
      blockCount: fingerprints.length,
      blocks: Object.freeze(fingerprints),
      anchorMap: Object.freeze({ blocks: frozenAnchors }),
    });

    return { ok: true, snapshot };
  }
}
