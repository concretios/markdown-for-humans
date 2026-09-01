/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';
import { isIP } from 'net';
import { readFile } from 'fs/promises';
import { outlineViewProvider, type OutlineEntry } from '../features/outlineView';
import { setActiveWebviewPanel, getActiveWebviewPanel } from '../activeWebview';
import { buildResizeBackupLocation, resolveBackupPathWithCollisionDetection } from './imageBackups';
import {
  hasSameBlankLineLayout,
  isMarkdownRendererEquivalent,
  isMarkdownStructurallyEquivalent,
} from './markdownAstEquivalence';
import { computeMinimalTextReplacement } from './minimalTextEdit';
import { ImageSaveCompletionDelivery } from './imageSaveCompletionDelivery';
import { applyBlankLinePolicy, type BlankLineMode } from '../shared/blankLinePolicy';
import {
  FeedbackSessionError,
  FeedbackSessionStore,
  type FeedbackItem,
  type ScreenshotFeedbackItem,
} from './feedbackSessionStore';
import { projectFeedbackTextItemSummaryV2 } from './feedbackItemSummaryV2';
import {
  createFeedbackSourceIndex,
  projectFeedbackSourceEvidence,
  type FeedbackSourceEvidenceFormat,
  type FeedbackSourceIndex,
} from './feedbackSourceEvidence';
import {
  degradeFeedbackItemV2ForStaleLocator,
  migrateFeedbackItemV1ToV2,
  type FeedbackMigrationItemV1,
} from './feedbackMigrationV2';
import {
  normalizeFeedbackBlockKindV2,
  resolveFeedbackTargetEvidenceV2,
  type FeedbackCanonicalEndpointStateV2,
} from './feedbackTargetEvidenceV2';
import { renderFeedbackHandoffPrompt } from './feedbackHandoffPrompt';
import {
  buildFeedbackAnchorMap,
  findFeedbackOrdinalsForLines,
  mapFeedbackSelection,
  type FeedbackAnchorMap,
} from './feedbackAnchors';
import {
  FEEDBACK_ERROR_CODES,
  FEEDBACK_MAX_EXACT_CELL_COUNT_PER_SESSION,
  isFeedbackCellRectangleWithinExactLimit,
  parseFeedbackWebviewMessage,
  type CanonicalFeedbackBlock,
  type FeedbackDraftSummary,
  type FeedbackHostMessage,
  type FeedbackItemSummary,
  type FeedbackCellTargetInputV1,
  type FeedbackCellTargetV1,
  type FeedbackRenderedRangeInputV1,
  type FeedbackRenderedRangeV1,
  type FeedbackWebviewMessage,
} from '../shared/feedbackProtocol';
import {
  FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2,
  feedbackEmbeddedSourceBytesV2,
  type FeedbackEvidenceEnvelopeV2,
  type FeedbackItemV2,
  type FeedbackScreenshotItemV2,
  type FeedbackTargetV2,
  type FeedbackTextItemV2,
  type FeedbackVisualSourceReferenceV2,
} from '../shared/feedbackEvidenceV2';
import { DocumentEditCoordinator } from './documentEditCoordinator';
import {
  FeedbackSnapshotService,
  computeFeedbackTextSha256,
  type FeedbackPreparedSourceSnapshot,
  type FeedbackSnapshotIdentity,
  type FeedbackSplitSnapshotReport,
} from './feedbackSnapshotService';
import {
  FeedbackTransport,
  type FeedbackAcknowledgementDisposition,
  type FeedbackDeliveryResult,
} from './feedbackTransport';
import {
  DOCUMENT_SYNC_PROTOCOL_VERSION,
  parseDocumentEditIdentity,
  parseDocumentEditMessage,
  parseDocumentFlushAck,
  parseDocumentSyncReady,
  parseDocumentTeardownEditMessage,
  type DocumentEditAck,
  type DocumentEditMessage,
  type DocumentTeardownEditMessage,
} from '../shared/documentSyncProtocol';
import {
  IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
  MAX_PENDING_IMAGE_SAVES,
  PENDING_IMAGE_DESTINATION_PREFIX,
  createPendingImageDestination,
  parsePendingImageSaveCompletionAck,
  replacePendingImageDestination,
  type PendingImageSaveCompletion,
} from '../shared/pendingImageProtocol';
import {
  FEEDBACK_DELIVERY_PROTOCOL_VERSION,
  parseFeedbackDeliveryAcknowledgement,
  parseFeedbackDeliveryStatusResponse,
  type FeedbackDeliveryApplicationStatus,
  type FeedbackDeliveryAcknowledgement,
  type FeedbackDeliveryIdentity,
  type FeedbackDeliveryStatusResponse,
  type FeedbackStartedDelivery,
} from '../shared/feedbackDeliveryProtocol';
import {
  FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
  parseFeedbackSnapshotReport,
  type FeedbackSnapshotAppliedReport,
  type FeedbackSnapshotHostMessage,
  type FeedbackSnapshotReport,
} from '../shared/feedbackSnapshotProtocol';

interface FeedbackCanonicalBlockState {
  kind: string;
  contentSize: number;
  sha256: string;
  /** Frozen renderer-computed structural identity for canonical table blocks only. */
  tableFingerprint?: string;
}

type FeedbackStartedApplicationResult = { readonly messageType: 'feedback.started' };
type FeedbackStartedTransport = FeedbackTransport<
  FeedbackStartedDelivery,
  FeedbackStartedApplicationResult,
  never,
  never,
  FeedbackDeliveryApplicationStatus
>;

type FeedbackCriticalHostMessage = Extract<
  FeedbackHostMessage,
  {
    type:
      | 'feedback.finished'
      | 'feedback.discarded'
      | 'feedback.close.sync'
      | 'feedback.close.release'
      | 'feedback.transition.sync'
      | 'feedback.peer.lock.acquire'
      | 'feedback.peer.release'
      | 'feedback.session.transfer';
  }
>;
type FeedbackCriticalMessageType = FeedbackCriticalHostMessage['type'];
type FeedbackCriticalApplicationResult = { readonly messageType: FeedbackCriticalMessageType };
type FeedbackCriticalTransport = FeedbackTransport<
  FeedbackCriticalHostMessage,
  FeedbackCriticalApplicationResult,
  never,
  never,
  never
>;

interface PendingFeedbackStatusQuery {
  readonly identity: FeedbackDeliveryIdentity;
  readonly resolve: (status: FeedbackDeliveryApplicationStatus) => void;
  readonly reject: (error: Error) => void;
}

interface PendingFeedbackControllerRestore {
  readonly documentKey: string;
  readonly sessionId: string;
  readonly viewGeneration: string;
  controllerRequestId?: string;
}

interface PendingFeedbackSnapshotReport {
  readonly webview: vscode.Webview;
  readonly operationId: string;
  readonly stage: FeedbackSnapshotReport['stage'];
  readonly documentVersion: number;
  readonly resolve: (report: FeedbackSnapshotReport | null) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface PendingFeedbackPeerReleaseTarget {
  message: Extract<FeedbackHostMessage, { type: 'feedback.peer.release' }>;
  applied: boolean;
  committed: boolean;
  deliveryAbortController?: AbortController;
}

interface PendingFeedbackPeerRelease {
  readonly kind: 'session' | 'transition';
  readonly document: vscode.TextDocument;
  readonly requestId: string;
  readonly lockId: string;
  /** Revision owned by the close or transition controller. */
  readonly lifecycleRevision: number;
  /** Monotonic authoritative-content revision, including apply restarts. */
  revision: number;
  documentVersion: number;
  contentSha256: string;
  content: string;
  phase: 'applying' | 'committing';
  readonly targets: Map<vscode.Webview, PendingFeedbackPeerReleaseTarget>;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
}

interface PendingFeedbackSessionTransferTarget {
  readonly role: Extract<FeedbackHostMessage, { type: 'feedback.session.transfer' }>['role'];
  message: Extract<FeedbackHostMessage, { type: 'feedback.session.transfer' }>;
  applied: boolean;
  committed: boolean;
  aborted: boolean;
  abortAcknowledged: boolean;
  rendererUnavailable: boolean;
  applyPosted: boolean;
  deliveryAbortController?: AbortController;
}

type FeedbackSessionTransferCompletion =
  'committed' | 'rolled-back' | 'unavailable' | 'failed-closed';

interface PendingFeedbackSessionTransfer {
  readonly document: vscode.TextDocument;
  readonly transferId: string;
  readonly requestId: string;
  readonly oldSession: ActiveFeedbackSession;
  readonly nextSession: ActiveFeedbackSession;
  readonly oldOwner: vscode.Webview;
  readonly newOwner: vscode.Webview;
  readonly sourceSha256: string;
  readonly documentVersion: number;
  readonly revision: number;
  phase: 'applying-new' | 'applying-old' | 'committing' | 'aborting';
  readonly targets: Map<vscode.Webview, PendingFeedbackSessionTransferTarget>;
  peerLocksStarted: boolean;
  peerLocksComplete: boolean;
  commitValidationPending: boolean;
  completionSettled: boolean;
  readonly completion: Promise<FeedbackSessionTransferCompletion>;
  readonly resolveCompletion: (result: FeedbackSessionTransferCompletion) => void;
  finalizationSettled: boolean;
  readonly finalization: Promise<void>;
  readonly resolveFinalization: () => void;
  readonly deferredReleaseWebviews: Set<vscode.Webview>;
  oldOwnerRecoveryGeneration?: string;
  newOwnerRecoveryGeneration?: string;
}

interface PendingHostImageSave {
  readonly placeholderId: string;
  readonly viewGeneration: string;
  readonly completionId: string;
  data: Uint8Array | undefined;
  readonly mimeType: string;
  readonly completion: Promise<string | null>;
  fallbackDataUri?: string;
  settled: boolean;
  deliveryRetired: boolean;
  retireAfterSettlement: boolean;
  completionDelivery?: ImageSaveCompletionDelivery;
}

interface PendingHostImageSaveRejection {
  readonly placeholderId: string;
  readonly viewGeneration: string;
  readonly completionId: string;
  readonly completionDelivery: ImageSaveCompletionDelivery;
}

type ImagePersistenceResult =
  | { readonly kind: 'saved'; readonly destination: string }
  | { readonly kind: 'error'; readonly error: string };

/** One host flush boundary authorized for one exact renderer generation. */
interface PendingDocumentFlush {
  readonly webview: vscode.Webview;
  readonly viewGeneration: string;
  readonly documentVersion: number;
  readonly resolve: (ok: boolean) => void;
  readonly settled: Promise<void>;
}

interface FlushedFeedbackSnapshot {
  readonly sourceBytes: Buffer;
  readonly source: FeedbackPreparedSourceSnapshot;
}

interface FinalizedFeedbackRendererSnapshot {
  readonly identity: FeedbackSnapshotIdentity;
  readonly blocks: readonly CanonicalFeedbackBlock[];
  readonly anchorMap: FeedbackAnchorMap;
}

interface ActiveFeedbackSession {
  /** The rich-view webview that owns this frozen session in split-view scenarios. */
  ownerWebview: vscode.Webview;
  /** Fresh runtime token. It is intentionally distinct from the resumable bundle round. */
  sessionId: string;
  store: FeedbackSessionStore;
  /** Exact saved bytes retained for host-only source classification and migration. */
  sourceBytes: Buffer;
  /** Reusable logical-line index bound to {@link sourceBytes}. */
  sourceIndex: FeedbackSourceIndex;
  anchorMap: FeedbackAnchorMap;
  canonicalBlocks: Map<number, FeedbackCanonicalBlockState>;
  targets: Map<string, { startOrdinal: number; endOrdinal: number }>;
  previewNonce: string;
  previewRevisions: Map<string, number>;
  /** Exact draft ranges that were structurally valid but no longer resolve. */
  degradedRenderedRangeIds: Set<string>;
  /** Draft table-cell targets whose containing table identity no longer validates. */
  degradedCellTargetIds: Set<string>;
  phase: 'active' | 'resuming' | 'finishing' | 'discarding';
  pendingMutationCount: number;
  /** Serializes host-side migration and budget planning before store mutations. */
  mutationPlanningQueue: Promise<void>;
  mutationIdleWaiters: Set<() => void>;
  /** Durable Finish/Discard work that must settle before controller demotion. */
  closeOperation?: Promise<void>;
  /** Correlated close handshake retained until an applied revision is still current. */
  pendingClose?: {
    requestId: string;
    terminalType: 'feedback.finished' | 'feedback.discarded';
    revision: number;
    contentSha256?: string;
    releaseRevision?: number;
    deliveryAbortController?: AbortController;
  };
  invalidated: boolean;
  /** The owning panel retired while peers still require a fail-closed release. */
  ownerDisposed?: boolean;
  lastErrorCode?: string;
}

interface FeedbackTransition {
  token: symbol;
  /** Runtime token used to correlate peer split lock and unlock messages. */
  lockId: string;
  requestId: string;
  /** Only this webview may complete or release the transition. */
  ownerWebview: vscode.Webview;
  acceptingFlushEdit: boolean;
  invalidated: boolean;
  /** An accepted pre-lock edit must be reflected back before this lock retires. */
  recoveryRequired: boolean;
  expectedFlushContentSha256?: string;
  recoveryRevision: number;
  recoveryContentSha256?: string;
  deliveryAbortController?: AbortController;
  /** The owner has installed the host-correlated transition lock locally. */
  ownerLockPosted: boolean;
  /** The initiating panel retired before this transition could finish. */
  ownerDisposed?: boolean;
}

const FEEDBACK_BLOCKED_LEGACY_MESSAGES = new Set([
  'edit',
  'saveImage',
  'handleWorkspaceImage',
  'openSourceView',
  'resizeImage',
  'undoResize',
  'redoResize',
  'copyLocalImageToWorkspace',
  'renameImage',
]);

const FEEDBACK_DURABLE_MUTATION_MESSAGES = new Set<FeedbackWebviewMessage['type']>([
  'feedback.text.add',
  'feedback.screenshot.add',
  'feedback.screenshot.replace',
  'feedback.item.edit',
  'feedback.item.delete',
  'feedback.item.restore',
]);

type FeedbackHostErrorCode = NonNullable<
  Extract<FeedbackHostMessage, { type: 'feedback.error' }>['code']
>;

const FEEDBACK_HOST_ERROR_CODES = new Set<string>([
  ...Object.values(FEEDBACK_ERROR_CODES),
  'MD4H-FB-STORE-001',
  'MD4H-FB-STORE-002',
]);

// Session start may need to serialize a busy long-form document before the
// webview can acknowledge its flush. Keep this bounded, but do not reuse the
// 250 ms best-effort autosave bridge deadline for a fail-closed user action.
const FEEDBACK_FLUSH_ACK_TIMEOUT_MS = 2_000;

function isFeedbackHostErrorCode(value: unknown): value is FeedbackHostErrorCode {
  return typeof value === 'string' && FEEDBACK_HOST_ERROR_CODES.has(value);
}

/**
 * Coerce text to end with exactly one `\n` (markdownlint MD047). An empty
 * string stays empty — we don't want to materialize a single-newline file from
 * an empty webview state.
 */
export function ensureSingleTrailingNewline(text: string): string {
  if (text === '') return text;
  return text.replace(/\n*$/, '\n');
}

/**
 * Parse an image filename to extract source prefix
 * Returns the source prefix (dropped_ or pasted_) if present, or null
 */
export function parseImageSourcePrefix(filename: string): string | null {
  // Check for source prefix: dropped_ or pasted_
  const sourcePattern = /^(dropped_|pasted_)/;
  const match = filename.match(sourcePattern);
  return match ? match[1] : null;
}

/**
 * Build an image filename from components, optionally including a dimensions suffix.
 *
 * Note: manual renames should use `buildImageFilenameForUserRename()` instead so we
 * don't auto-add dimensions or source prefixes based on config.
 *
 * @deprecated Use `buildImageFilenameForUserRename()` for rename and
 *             `updateFilenameDimensions()` for resize flows.
 */
export function buildImageFilenameForRename(
  sourcePrefix: string | null,
  name: string,
  dimensions: { width: number; height: number } | null,
  extension: string,
  includeDimensions: boolean
): string {
  const source = sourcePrefix || '';
  if (!includeDimensions || !dimensions) {
    return `${source}${name}.${extension}`;
  }
  return `${source}${name}_${dimensions.width}x${dimensions.height}px.${extension}`;
}

/**
 * Build an image filename for a user-initiated rename.
 *
 * Rules:
 * - Do not auto-add dimensions.
 * - Do not auto-add or preserve a `dropped_`/`pasted_` prefix.
 * - Treat the user-provided name as authoritative.
 *
 * @param userProvidedName - The new name from the rename dialog (without extension)
 * @param extension - File extension (with or without leading dot)
 */
export function buildImageFilenameForUserRename(
  userProvidedName: string,
  extension: string
): string {
  const normalizedExtension = extension.startsWith('.') ? extension.slice(1) : extension;
  const dot = normalizedExtension ? '.' : '';
  return `${userProvidedName}${dot}${normalizedExtension}`;
}

/**
 * Update dimensions in an image filename while preserving other components.
 *
 * When `includeDimensions` is enabled:
 * - Keep any existing `dropped_`/`pasted_` prefix.
 * - Add/update the `{width}x{height}px` suffix (and remove legacy timestamp formats).
 *
 * When `includeDimensions` is disabled:
 * - Strip BOTH the `dropped_`/`pasted_` prefix and the `{width}x{height}px` suffix.
 * - Keep the base name and extension.
 */
export function updateFilenameDimensions(
  filename: string,
  newWidth: number,
  newHeight: number,
  includeDimensions: boolean = true
): string {
  const extWithDot = path.extname(filename);
  const filenameWithoutExt = extWithDot ? filename.slice(0, -extWithDot.length) : filename;

  const sourcePrefix = parseImageSourcePrefix(filename) || '';
  const filenameWithoutPrefix = sourcePrefix
    ? filenameWithoutExt.slice(sourcePrefix.length)
    : filenameWithoutExt;

  // Old pattern with timestamp: {name}_{timestamp}_{width}x{height}px
  const oldTimestampMatch = filenameWithoutPrefix.match(/^(.+?)_\d{13}_(\d+)x(\d+)px$/);
  if (oldTimestampMatch) {
    const coreName = oldTimestampMatch[1];
    if (!includeDimensions) {
      return `${coreName}${extWithDot}`;
    }
    return `${sourcePrefix}${coreName}_${newWidth}x${newHeight}px${extWithDot}`;
  }

  // New pattern (no timestamp): {name}_{width}x{height}px
  const newPatternMatch = filenameWithoutPrefix.match(/^(.+?)_(\d+)x(\d+)px$/);
  if (newPatternMatch) {
    const coreName = newPatternMatch[1];
    if (!includeDimensions) {
      return `${coreName}${extWithDot}`;
    }
    return `${sourcePrefix}${coreName}_${newWidth}x${newHeight}px${extWithDot}`;
  }

  // Legacy format without dimensions: {name}-{timestamp}
  const legacyMatch = filenameWithoutPrefix.match(/^(.+?)-\d{13}$/);
  if (legacyMatch) {
    const coreName = legacyMatch[1];
    if (!includeDimensions) {
      return `${coreName}${extWithDot}`;
    }
    return `${sourcePrefix}${coreName}_${newWidth}x${newHeight}px${extWithDot}`;
  }

  // Unparseable filename.
  // If dimensions are disabled, still strip any existing source prefix and keep the name.
  if (!includeDimensions) {
    return `${filenameWithoutPrefix}${extWithDot}`;
  }

  // Append dimensions to filename when enabled.
  return `${sourcePrefix}${filenameWithoutPrefix}_${newWidth}x${newHeight}px${extWithDot}`;
}

/**
 * Custom Text Editor Provider for Markdown files
 * Provides WYSIWYG editing using TipTap in a webview
 */
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  private static readonly MD012_MANAGED_STATE_KEY = 'markdownForHumans.blankLines.managedMd012';

  // Dedup the "Save the file to see the changes." prompt across panels.
  // A single blank-line-mode change fires `onDidChangeConfiguration` for every
  // open custom editor; without this we'd stack one toast per open .md file.
  private static lastBlankLineSavePromptAt = 0;

  private getBlankLineMode(): BlankLineMode {
    const config = vscode.workspace.getConfiguration();
    const value = config.get<string>('markdownForHumans.blankLines.mode', 'strip');
    return value === 'preserve' ? 'preserve' : 'strip';
  }

  private async syncMarkdownlintMd012(mode: BlankLineMode): Promise<void> {
    const markdownlintConfig = vscode.workspace.getConfiguration('markdownlint');
    const existing =
      (markdownlintConfig.get<Record<string, unknown>>('config') as Record<string, unknown>) ?? {};
    const managed = this.context.globalState.get<boolean>(
      MarkdownEditorProvider.MD012_MANAGED_STATE_KEY,
      false
    );

    if (mode === 'preserve') {
      if (existing.MD012 !== false) {
        await markdownlintConfig.update(
          'config',
          {
            ...existing,
            MD012: false,
          },
          vscode.ConfigurationTarget.Workspace
        );
        await this.context.globalState.update(MarkdownEditorProvider.MD012_MANAGED_STATE_KEY, true);
      }
      return;
    }

    if (!managed) return;

    if (existing.MD012 === false) {
      const next = { ...existing };
      delete next.MD012;
      await markdownlintConfig.update('config', next, vscode.ConfigurationTarget.Workspace);
    }
    await this.context.globalState.update(MarkdownEditorProvider.MD012_MANAGED_STATE_KEY, false);
  }

  /**
   * Re-apply the current blank-line policy to the backing `TextDocument`.
   *
   * When switching from preserve to strip, `updateWebview` can show stripped
   * markdown while the document buffer still holds extra blank lines; the next
   * save would persist the unstripped buffer. Pushing the policy through
   * `applyEdit` keeps buffer, webview, and the following save aligned.
   */
  private async syncTextDocumentBlankLinePolicy(document: vscode.TextDocument): Promise<void> {
    const raw = document.getText();
    await this.applyEdit(raw, document, { editReason: 'save-policy-enforce' });
  }

  private static readonly URL_CHECK_TIMEOUT_MS = 2000;
  private static readonly MAX_FILE_SEARCH_RESULTS = 2000;

  // Track pending edits to avoid feedback loops
  // Key: document URI, Value: timestamp of last edit from webview
  private pendingEdits = new Map<string, number>();
  // Remember the latest content received from a rich view and which split sent
  // it. Echo suppression is source-specific so sibling splits still update.
  private lastWebviewContent = new Map<string, string>();
  private lastWebviewContentSource = new Map<string, vscode.Webview>();
  // Host delivery is also split-specific. A shared URI cache can leave later
  // splits empty or stale after the first split consumes an update.
  private lastHostContentByWebview = new WeakMap<vscode.Webview, string>();
  // A queued `postMessage` is not delivered merely because it was invoked.
  // Keep in-flight payloads separate and promote only the latest successful
  // delivery into the deduplication cache.
  private pendingHostContentByWebview = new WeakMap<vscode.Webview, { readonly content: string }>();
  // Every mutation of one TextDocument passes through this coordinator. VS Code
  // applies WorkspaceEdits asynchronously, so fire-and-forget webview messages
  // must be serialized explicitly to prevent an older completion from landing
  // after newer content.
  private readonly documentEditCoordinator = new DocumentEditCoordinator<string>();
  private readonly feedbackSnapshotService = new FeedbackSnapshotService();
  private readonly feedbackDeliveryCapableWebviews = new WeakSet<vscode.Webview>();
  private readonly feedbackSnapshotCapableWebviews = new WeakSet<vscode.Webview>();
  private readonly pendingFeedbackSnapshotReports = new Map<
    string,
    PendingFeedbackSnapshotReport
  >();
  private readonly feedbackStartedTransports = new Map<vscode.Webview, FeedbackStartedTransport>();
  private readonly feedbackCriticalTransports = new Map<
    vscode.Webview,
    FeedbackCriticalTransport
  >();
  /** One fail-closed authoritative unlock barrier per document. */
  private readonly pendingFeedbackPeerReleases = new Map<string, PendingFeedbackPeerRelease>();
  /** One generation-bound, two-sided active-session handoff per document. */
  private readonly pendingFeedbackSessionTransfers = new Map<
    string,
    PendingFeedbackSessionTransfer
  >();
  /** Last application-ACKed lock for each exact renderer generation. */
  private readonly appliedFeedbackPeerLocks = new WeakMap<
    vscode.Webview,
    { readonly viewGeneration: string; readonly lockId: string }
  >();
  private readonly pendingFeedbackPeerLockAcquisitions = new WeakMap<
    vscode.Webview,
    Extract<FeedbackHostMessage, { type: 'feedback.peer.lock.acquire' }>
  >();
  /** Serialize lock replacement per renderer so reassertions share one identity. */
  private readonly inFlightFeedbackPeerLockAcquisitions = new WeakMap<
    vscode.Webview,
    { readonly lockId: string; readonly promise: Promise<void> }
  >();
  private readonly pendingFeedbackStatusQueries = new Map<
    vscode.Webview,
    Map<string, PendingFeedbackStatusQuery>
  >();
  /** One automatic active-session restore per renderer generation. */
  private readonly pendingFeedbackControllerRestores = new WeakMap<
    vscode.Webview,
    PendingFeedbackControllerRestore
  >();
  /** First controller-ready request accepted for each renderer generation. */
  private readonly feedbackControllerReadyRequests = new WeakMap<
    vscode.Webview,
    { readonly viewGeneration: string; readonly requestId: string }
  >();
  private nextFeedbackDeliveryId = 1;
  // A webview object survives a script reload. Rotate this lineage on each
  // `ready` message so pending typing from an earlier renderer cannot coalesce
  // with work produced by the replacement controller.
  private readonly editViewGenerations = new WeakMap<vscode.Webview, string>();
  /** Generations for which VS Code definitively rejected postMessage queueing. */
  private readonly unavailableFeedbackViewGenerations = new WeakMap<vscode.Webview, string>();
  private nextEditViewGeneration = 1;
  private readonly pendingDocumentEditAcks = new WeakMap<
    vscode.Webview,
    Map<string, Promise<DocumentEditAck>>
  >();
  private readonly documentEditAckHistory = new WeakMap<
    vscode.Webview,
    Map<string, DocumentEditAck>
  >();
  /** Immutable request envelope retained beside each pending or replayable edit ACK. */
  private readonly documentEditEnvelopeHashes = new WeakMap<vscode.Webview, Map<string, string>>();
  /** Latest renderer-ready signal held behind edits from its predecessor. */
  private readonly deferredReadyAfterDocumentEdits = new WeakMap<
    vscode.Webview,
    {
      readonly message: { type: string; [key: string]: unknown };
      readonly document: vscode.TextDocument;
    }
  >();
  /** One drain waiter per panel while an old renderer generation still owns edits. */
  private readonly pendingReadyDocumentEditDrains = new WeakMap<vscode.Webview, Promise<void>>();
  /** Host-owned file writes used to resolve compact pending-image markers. */
  private readonly pendingHostImageSaves = new WeakMap<
    vscode.Webview,
    Map<string, PendingHostImageSave>
  >();
  /** Capacity failures awaiting an exact renderer application ACK. */
  private readonly pendingHostImageSaveRejections = new WeakMap<
    vscode.Webview,
    Map<string, PendingHostImageSaveRejection>
  >();
  /** Iterable ownership lets extension shutdown cancel timers that capture webviews. */
  private readonly activeImageCompletionDeliveries = new Set<ImageSaveCompletionDelivery>();
  private static readonly PENDING_HOST_IMAGE_SAVE_LIMIT = MAX_PENDING_IMAGE_SAVES;
  private static readonly PENDING_HOST_IMAGE_SAVE_REJECTION_LIMIT = 128;
  private static readonly PENDING_HOST_IMAGE_SAVE_BYTE_LIMIT = 64 * 1024 * 1024;
  private static readonly IMAGE_SAVE_COMPLETION_ACK_TIMEOUT_MS = 1_000;
  private static readonly IMAGE_SAVE_COMPLETION_RETRY_DELAY_MS = 250;
  private static readonly IMAGE_SAVE_COMPLETION_MAX_RETRY_DELAY_MS = 4_000;
  private static readonly DOCUMENT_EDIT_ACK_HISTORY_LIMIT = 128;
  private static readonly FEEDBACK_SNAPSHOT_REPORT_TIMEOUT_MS = 2_000;
  /** Avoid whole-buffer WorkspaceEdits once their undo/diff cost becomes material. */
  private static readonly MINIMAL_EDIT_DOCUMENT_THRESHOLD = 32 * 1024;
  // Flush acknowledgements are authorized against both the request identity
  // and the exact renderer generation that received the host barrier.
  private flushAckResolvers = new Map<string, PendingDocumentFlush>();
  // Panels grouped by document URI. Every split remains registered so closing
  // the newest split cannot orphan a surviving view from window autosave.
  private openPanels = new Map<
    string,
    Map<vscode.WebviewPanel, { document: vscode.TextDocument; webview: vscode.Webview }>
  >();
  // One-shot subscription for `window.onDidChangeWindowState`. Registered the
  // first time a custom editor opens so tests that never call `resolveCustomTextEditor`
  // don't need this VS Code API on their mock.
  private windowStateListener: vscode.Disposable | undefined;
  // Debounce timers for `markdownForHumans.autoSave.enabled`, keyed by document
  // URI. This setting is independent of VS Code's own `files.autoSave` — it's
  // MFH saving on the user's behalf a short delay after typing stops, separate
  // from the `flushAndSaveIfDirty` bridge (which only fires on focus/window
  // changes and depends on `files.autoSave` being set to onFocusChange/onWindowChange).
  private autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Panels whose focus-loss autosave must survive renderer destruction. */
  private readonly inactiveAutoSaveWebviews = new WeakSet<vscode.Webview>();
  // Frozen feedback sessions are intentionally host-owned. The webview keeps
  // presentation state, while this map retains the source map and durable
  // bundle handle needed to validate every mutation.
  private feedbackSessions = new Map<string, ActiveFeedbackSession>();
  private feedbackTransitions = new Map<string, FeedbackTransition>();
  /** Serialize Start/Resume entry operations per document so retries become idempotent. */
  private feedbackEntryOperations = new Map<string, Promise<void>>();
  /** One-shot authorization for transferring or rehydrating a live runtime session. */
  private feedbackActiveResumeOffers = new WeakMap<
    vscode.Webview,
    { documentKey: string; round: string; sessionId: string }
  >();
  /** Every live rich-view webview, including duplicate split views. */
  private feedbackWebviews = new Map<string, Set<vscode.Webview>>();
  /** Last lock broadcast for each document, retained until peers are unlocked. */
  private feedbackPeerLockIds = new Map<string, string>();
  private static readonly AUTO_SAVE_DEBOUNCE_MS = 1000;
  private disposed = false;
  // --- Audit Search Tuning ---
  /**
   * Minimum length required to attempt ANY file suggestions.
   * Rationale: Filenames under 3 characters (e.g., "a.png", "1.md") are too generic.
   * Searching for them yields too many false positives and creates noisy, unhelpful UI suggestions.
   */
  private readonly MIN_BASENAME_LENGTH_FOR_SUGGESTION = 5;
  /**
   * Minimum length required to trigger broad fuzzy searching (name.).
   * Rationale: Glob fuzzy searches are highly CPU-intensive across large workspaces.
   * Requiring at least 4 characters prevents UI freezes and massive memory spikes
   * that would be caused by generating thousands of matches for short strings like "ab".
   */

  private readonly MIN_BASENAME_LENGTH_FOR_FUZZY = 6;

  private isOutlineEntry(value: unknown): value is OutlineEntry {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as Partial<OutlineEntry>;
    return (
      typeof candidate.level === 'number' &&
      typeof candidate.text === 'string' &&
      typeof candidate.pos === 'number' &&
      typeof candidate.sectionEnd === 'number'
    );
  }

  private parseOutlineEntries(value: unknown): OutlineEntry[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(entry => this.isOutlineEntry(entry));
  }

  private isExportMermaidImage(
    value: unknown
  ): value is { id: string; pngDataUrl: string; originalCode: string; originalSvg: string } {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.id === 'string' &&
      typeof candidate.pngDataUrl === 'string' &&
      typeof candidate.originalCode === 'string' &&
      typeof candidate.originalSvg === 'string'
    );
  }

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new MarkdownEditorProvider(context);
    const providerRegistration = vscode.window.registerCustomEditorProvider(
      'markdownForHumans.editor',
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: false,
          enableFindWidget: true,
        },
        supportsMultipleEditorsPerDocument: true,
      }
    );
    return {
      dispose: () => {
        providerRegistration.dispose();
        provider.dispose();
      },
    };
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Release document queues, timers, and pending local waiters on extension shutdown. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.documentEditCoordinator.dispose();
    for (const delivery of this.activeImageCompletionDeliveries) delivery.dispose();
    this.activeImageCompletionDeliveries.clear();
    for (const transport of this.feedbackStartedTransports.values()) transport.dispose();
    this.feedbackStartedTransports.clear();
    for (const transport of this.feedbackCriticalTransports.values()) transport.dispose();
    this.feedbackCriticalTransports.clear();
    for (const pending of this.pendingFeedbackPeerReleases.values()) {
      for (const target of pending.targets.values()) target.deliveryAbortController?.abort();
      pending.resolveCompletion();
    }
    this.pendingFeedbackPeerReleases.clear();
    for (const pending of this.pendingFeedbackSessionTransfers.values()) {
      for (const target of pending.targets.values()) target.deliveryAbortController?.abort();
      this.settleFeedbackSessionTransfer(pending, 'failed-closed');
      this.settleFeedbackSessionTransferFinalization(pending);
    }
    this.pendingFeedbackSessionTransfers.clear();
    for (const webview of [...this.pendingFeedbackStatusQueries.keys()]) {
      this.cancelFeedbackStatusQueries(webview, 'Feedback provider disposed.');
    }
    for (const pending of this.pendingFeedbackSnapshotReports.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(null);
    }
    this.pendingFeedbackSnapshotReports.clear();
    for (const timer of this.autoSaveTimers.values()) clearTimeout(timer);
    this.autoSaveTimers.clear();
    for (const pending of this.flushAckResolvers.values()) pending.resolve(false);
    this.flushAckResolvers.clear();
    this.windowStateListener?.dispose();
    this.windowStateListener = undefined;

    for (const session of this.feedbackSessions.values()) {
      session.mutationIdleWaiters.forEach(resolve => resolve());
      session.mutationIdleWaiters.clear();
    }
    this.feedbackSessions.clear();
    this.feedbackTransitions.clear();
    this.feedbackEntryOperations.clear();
    this.feedbackWebviews.clear();
    this.feedbackPeerLockIds.clear();
    this.openPanels.clear();
  }

  /**
   * Get the document directory for file-based documents, or workspace folder for untitled files
   * Returns null if document is untitled and has no workspace
   */
  private getDocumentDirectory(document: vscode.TextDocument): string | null {
    if (document.uri.scheme === 'file') {
      return path.dirname(document.uri.fsPath);
    }
    // For untitled files, getWorkspaceFolder may not work reliably
    // So we check workspaceFolders first, then fall back to getWorkspaceFolder
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      // For untitled files, use the first workspace folder if available
      return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    // Fallback: try getWorkspaceFolder (might work in some cases)
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (workspaceFolder) {
      return workspaceFolder.uri.fsPath;
    }
    return null;
  }

  /**
   * Get the workspace folder path that contains the document, when available.
   *
   * For untitled documents, falls back to the first workspace folder.
   */
  private getWorkspaceFolderPath(document: vscode.TextDocument): string | null {
    const direct = vscode.workspace.getWorkspaceFolder(document.uri);
    if (direct) {
      return direct.uri.fsPath;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return null;
    }

    if (document.uri.scheme === 'untitled') {
      return folders[0].uri.fsPath;
    }

    if (document.uri.scheme === 'file') {
      const docPath = document.uri.fsPath;
      const containing = [...folders]
        .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)
        .find(
          folder =>
            docPath === folder.uri.fsPath || docPath.startsWith(folder.uri.fsPath + path.sep)
        );
      return containing?.uri.fsPath ?? null;
    }

    return null;
  }

  /**
   * Get base path for image operations
   * Returns workspace folder or document directory if available, otherwise OS temp directory.
   * This keeps untitled/no-workspace access more restrictive than using the home directory.
   */
  private getImageBasePath(document: vscode.TextDocument): string | null {
    const docDir = this.getDocumentDirectory(document);
    if (docDir) {
      return docDir;
    }
    // For untitled files without workspace, use temp directory to reduce file system exposure.
    return os.tmpdir();
  }

  /**
   * Get the base directory where new images should be saved.
   *
   * This is separate from `getImageBasePath()` (which is used to resolve
   * existing markdown image links relative to the markdown file).
   */
  private getImageStorageBasePath(document: vscode.TextDocument): string | null {
    const config = vscode.workspace.getConfiguration();
    const imagePathBase = config.get<string>(
      'markdownForHumans.imagePathBase',
      'relativeToDocument'
    );

    // Untitled docs: default to workspace-level saves when possible (we don't know
    // the final markdown file directory yet).
    if (document.uri.scheme === 'untitled') {
      return this.getWorkspaceFolderPath(document) ?? this.getImageBasePath(document);
    }

    if (imagePathBase === 'workspaceFolder') {
      return this.getWorkspaceFolderPath(document) ?? this.getImageBasePath(document);
    }

    // Default: relativeToDocument
    return (
      this.getDocumentDirectory(document) ?? this.getWorkspaceFolderPath(document) ?? os.tmpdir()
    );
  }

  /**
   * Called when our custom editor is opened
   */
  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (token.isCancellationRequested) return;
    // VS Code invalidates `webviewPanel.webview` before invoking onDidDispose.
    // Capture the live object once so disposal cleanup never re-reads that getter.
    const panelWebview = webviewPanel.webview;
    // Setup webview options
    // Allow loading resources from extension and the workspace folder containing the document
    let workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    // For untitled files, getWorkspaceFolder may not work, so check workspaceFolders
    if (
      !workspaceFolder &&
      document.uri.scheme === 'untitled' &&
      vscode.workspace.workspaceFolders &&
      vscode.workspace.workspaceFolders.length > 0
    ) {
      workspaceFolder = vscode.workspace.workspaceFolders[0];
    }
    const localResourceRoots = [this.context.extensionUri];

    if (workspaceFolder) {
      localResourceRoots.push(workspaceFolder.uri);
    } else if (document.uri.scheme === 'file') {
      // If not in a workspace but is a file, allow the document's directory
      localResourceRoots.push(vscode.Uri.file(path.dirname(document.uri.fsPath)));
    } else {
      // For untitled files without workspace, allow the OS temp directory as a restrictive fallback.
      localResourceRoots.push(vscode.Uri.file(os.tmpdir()));
    }

    panelWebview.options = {
      enableScripts: true,
      localResourceRoots,
    };

    // Show warning dialog for untitled files without workspace
    // Re-check workspaceFolder here since we may have updated it above
    const finalWorkspaceFolder =
      workspaceFolder ||
      (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0]
        : undefined);
    if (document.uri.scheme === 'untitled' && !finalWorkspaceFolder) {
      const imageBasePath = this.getImageBasePath(document);
      if (imageBasePath) {
        vscode.window.showInformationMessage(
          `You are working without a workspace. Images will be saved to: ${imageBasePath}`
        );
      }
    }

    // Set webview HTML
    panelWebview.html = this.getHtmlForWebview(panelWebview);
    void this.syncMarkdownlintMd012(this.getBlankLineMode()).catch(error => {
      console.warn('[MD4H] Failed syncing markdownlint MD012 rule:', error);
    });

    // Register this panel for the autosave bridge. The window-state listener
    // iterates this map on focus changes; the view-state handler below reads
    // its own panel/document from closure but registering here keeps lifetimes
    // consistent.
    const panelKey = document.uri.toString();
    let documentPanels = this.openPanels.get(panelKey);
    if (!documentPanels) {
      documentPanels = new Map();
      this.openPanels.set(panelKey, documentPanels);
    }
    documentPanels.set(webviewPanel, { document, webview: panelWebview });
    this.registerFeedbackWebview(panelKey, panelWebview);
    this.ensureWindowStateListener();

    // Update webview when document changes
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString()) {
        if (e.contentChanges.length === 0) return;
        if (this.handleFeedbackDocumentChange(panelKey, panelWebview, e.document.getText())) {
          return;
        }
        this.updateWebview(document, panelWebview);
      }
    });

    // Handle messages from webview
    panelWebview.onDidReceiveMessage(
      e => this.handleWebviewMessage(e, document, panelWebview),
      null,
      this.context.subscriptions
    );

    // A background/restored split may resolve without becoming the active editor.
    // Do not let it steal command routing from the panel the user is already using.
    if (webviewPanel.active) setActiveWebviewPanel(webviewPanel, document);

    // Send initial content to webview
    this.updateWebview(document, panelWebview);

    // Listen for configuration changes and update webview
    const configChangeSubscription = vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('markdownForHumans.imageResize.skipWarning') ||
        e.affectsConfiguration('markdownForHumans.copyAiContextRef.skipSaveWarning') ||
        e.affectsConfiguration('markdownForHumans.imagePath') ||
        e.affectsConfiguration('markdownForHumans.imagePathBase') ||
        e.affectsConfiguration('markdownForHumans.imagePreview.hover.enabled') ||
        e.affectsConfiguration('markdownForHumans.blankLines.mode') ||
        e.affectsConfiguration('markdownForHumans.paragraph.spacingBefore') ||
        e.affectsConfiguration('markdownForHumans.paragraph.spacingAfter') ||
        e.affectsConfiguration('markdownForHumans.zoom') ||
        e.affectsConfiguration('markdownForHumans.enableMath') ||
        e.affectsConfiguration('markdownForHumans.formattingShortcuts.enabled')
      ) {
        const config = vscode.workspace.getConfiguration();
        const skipWarning = config.get<boolean>('markdownForHumans.imageResize.skipWarning', false);
        const skipAiContextSaveWarning = config.get<boolean>(
          'markdownForHumans.copyAiContextRef.skipSaveWarning',
          false
        );
        const imagePath = config.get<string>('markdownForHumans.imagePath', 'images');
        const imagePathBase = config.get<string>(
          'markdownForHumans.imagePathBase',
          'relativeToDocument'
        );
        const showImageHoverOverlay = config.get<boolean>(
          'markdownForHumans.imagePreview.hover.enabled',
          true
        );
        const paragraphSpacingBefore = config.get<number>(
          'markdownForHumans.paragraph.spacingBefore',
          0
        );
        const paragraphSpacingAfter = config.get<number>(
          'markdownForHumans.paragraph.spacingAfter',
          0
        );
        const zoom = config.get<number>('markdownForHumans.zoom', 100);
        const formattingShortcutsEnabled = config.get<boolean>(
          'markdownForHumans.formattingShortcuts.enabled',
          true
        );
        const blankLineMode = this.getBlankLineMode();
        const enableMath = config.get<boolean>('markdownForHumans.enableMath', true);
        if (e.affectsConfiguration('markdownForHumans.blankLines.mode')) {
          void this.syncMarkdownlintMd012(blankLineMode).catch(error => {
            console.warn('[MD4H] Failed syncing markdownlint MD012 rule:', error);
          });
          // After the policy rewrites the buffer, either persist the change
          // (autosave on) or tell the user it's pending (autosave off). The
          // policy sync is what made the doc dirty, so this branch is the
          // right moment to act.
          void this.syncTextDocumentBlankLinePolicy(document)
            .then(() => this.handleBlankLineModeSavePolicy(document, panelWebview))
            .catch(error => {
              console.error('[MD4H] Failed to sync blank-line policy to document buffer:', error);
            });
        }
        panelWebview.postMessage({
          type: 'settingsUpdate',
          skipResizeWarning: skipWarning,
          skipAiContextSaveWarning: skipAiContextSaveWarning,
          imagePath: imagePath,
          imagePathBase: imagePathBase,
          showImageHoverOverlay: showImageHoverOverlay,
          paragraphSpacingBefore: paragraphSpacingBefore,
          paragraphSpacingAfter: paragraphSpacingAfter,
          zoom: zoom,
          formattingShortcutsEnabled,
          blankLineMode,
          enableMath: enableMath,
        });
      }
    });

    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        setActiveWebviewPanel(webviewPanel, document);
        this.inactiveAutoSaveWebviews.delete(panelWebview);
      } else if (getActiveWebviewPanel() === webviewPanel) {
        setActiveWebviewPanel(undefined);
      }
      // Autosave bridge: VS Code's built-in `onFocusChange` /
      // `onWindowChange` autosave keys off `TextEditor` focus events, and a
      // custom-editor webview never raises those. When the panel goes
      // inactive (user switched tab, focused another pane, etc.) we save
      // ourselves so the user's writing isn't held in an in-memory dirty
      // buffer indefinitely.
      if (!webviewPanel.active) {
        const autoSave = vscode.workspace.getConfiguration('files').get<string>('autoSave', 'off');
        if (autoSave === 'onFocusChange' || autoSave === 'onWindowChange') {
          this.inactiveAutoSaveWebviews.add(panelWebview);
          void this.flushAndSaveIfDirty(document, panelWebview)
            .then(async rendererBoundarySaved => {
              if (!rendererBoundarySaved) {
                await this.saveInactiveDocumentAfterDrain(document, panelWebview);
              }
            })
            .catch(error => {
              console.error('[MD4H] Autosave on view-state change failed:', error);
            });
        }
      }
    });

    // Cleanup
    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      configChangeSubscription.dispose();
      const docUri = document.uri.toString();
      // Remove panel-scoped state first, then clear document-scoped work only
      // after the final split closes. A peer disposal must not erase the
      // owner's in-flight flush or cancel its autosave timer.
      this.unregisterFeedbackWebview(docUri, panelWebview);
      this.inactiveAutoSaveWebviews.delete(panelWebview);
      const hasRemainingWebviews = (this.feedbackWebviews.get(docUri)?.size ?? 0) > 0;
      if (this.lastWebviewContentSource.get(docUri) === panelWebview) {
        this.lastWebviewContentSource.delete(docUri);
        if (!hasRemainingWebviews) this.lastWebviewContent.delete(docUri);
      }
      this.lastHostContentByWebview.delete(panelWebview);
      this.pendingHostContentByWebview.delete(panelWebview);
      if (!hasRemainingWebviews) {
        this.pendingEdits.delete(docUri);
        this.lastWebviewContent.delete(docUri);
        this.lastWebviewContentSource.delete(docUri);
        this.preservePendingAutoSaveOnFinalPanelDispose(document);
      }
      // The draft itself remains on disk when a panel closes. Only volatile
      // controller state is released; sealed/draft bundles are never silently
      // deleted as part of editor disposal.
      this.releaseFeedbackStateForWebview(docUri, panelWebview, document);
      if (!hasRemainingWebviews) this.documentEditCoordinator.release(docUri);
      const documentPanels = this.openPanels.get(docUri);
      documentPanels?.delete(webviewPanel);
      if (documentPanels?.size === 0) this.openPanels.delete(docUri);
      if (getActiveWebviewPanel() === webviewPanel) {
        setActiveWebviewPanel(undefined);
      }
    });
  }

  /**
   * Send document content to webview
   * Skips recent echoes by default. A forced update is reserved for restoring
   * authoritative source after a frozen Feedback owner has closed locally.
   */
  private updateWebview(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    options: { force?: boolean } = {}
  ) {
    const docUri = document.uri.toString();
    const force = options.force === true;
    if (!force && this.feedbackSessions.get(docUri)?.ownerWebview === webview) {
      return;
    }
    const lastEditTime = this.pendingEdits.get(docUri);
    const mode = this.getBlankLineMode();
    const rawContent = document.getText();
    const currentContent = applyBlankLinePolicy(rawContent, mode);

    // Skip only content already delivered to this exact split when no different
    // payload is still in flight. Otherwise A -> B -> A can suppress the final
    // corrective A while B is still able to arrive and leave the renderer stale.
    const pendingHostContent = this.pendingHostContentByWebview.get(webview);
    if (!force && pendingHostContent?.content === currentContent) return;
    const lastHostContent = this.lastHostContentByWebview.get(webview);
    if (
      !force &&
      pendingHostContent === undefined &&
      lastHostContent !== undefined &&
      lastHostContent === currentContent
    ) {
      return;
    }

    // Suppress an immediate echo only for the split that originated it.
    const lastSentContent = this.lastWebviewContent.get(docUri);
    if (
      !force &&
      this.lastWebviewContentSource.get(docUri) === webview &&
      lastSentContent !== undefined &&
      lastSentContent === currentContent
    ) {
      return;
    }

    // Skip update if this change came from webview within last 100ms
    // This prevents feedback loops while allowing external Git changes to sync
    if (
      !force &&
      this.lastWebviewContentSource.get(docUri) === webview &&
      lastEditTime &&
      Date.now() - lastEditTime < 100
    ) {
      return;
    }

    // Transform content for webview (wrap frontmatter in code block)
    const transformedContent = this.wrapFrontmatterForWebview(currentContent);

    // Get skip warning setting
    const config = vscode.workspace.getConfiguration();
    const skipWarning = config.get<boolean>('markdownForHumans.imageResize.skipWarning', false);
    const skipAiContextSaveWarning = config.get<boolean>(
      'markdownForHumans.copyAiContextRef.skipSaveWarning',
      false
    );
    const imagePath = config.get<string>('markdownForHumans.imagePath', 'images');
    const imagePathBase = config.get<string>(
      'markdownForHumans.imagePathBase',
      'relativeToDocument'
    );
    const showImageHoverOverlay = config.get<boolean>(
      'markdownForHumans.imagePreview.hover.enabled',
      true
    );
    const paragraphSpacingBefore = config.get<number>(
      'markdownForHumans.paragraph.spacingBefore',
      0
    );
    const paragraphSpacingAfter = config.get<number>('markdownForHumans.paragraph.spacingAfter', 0);
    const zoom = config.get<number>('markdownForHumans.zoom', 100);
    const formattingShortcutsEnabled = config.get<boolean>(
      'markdownForHumans.formattingShortcuts.enabled',
      true
    );
    const blankLineMode = this.getBlankLineMode();
    const enableMath = config.get<boolean>('markdownForHumans.enableMath', true);

    const payload = {
      type: 'update',
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      documentVersion: this.getDocumentVersion(document),
      content: transformedContent,
      ...(force ? { force: true } : {}),
      skipResizeWarning: skipWarning,
      skipAiContextSaveWarning: skipAiContextSaveWarning,
      imagePath: imagePath,
      imagePathBase: imagePathBase,
      showImageHoverOverlay: showImageHoverOverlay,
      paragraphSpacingBefore: paragraphSpacingBefore,
      paragraphSpacingAfter: paragraphSpacingAfter,
      zoom: zoom,
      formattingShortcutsEnabled,
      blankLineMode,
      enableMath: enableMath,
    };
    const pendingDelivery = { content: currentContent };
    // Once a new post is attempted, an older delivery is no longer proof of the
    // renderer's final state. Clearing it also makes false/rejected corrective
    // deliveries retryable on the next update boundary.
    this.lastHostContentByWebview.delete(webview);
    this.pendingHostContentByWebview.set(webview, pendingDelivery);
    try {
      const posted = webview.postMessage(payload);
      void Promise.resolve(posted)
        .then(delivered => {
          if (this.pendingHostContentByWebview.get(webview) !== pendingDelivery) return;
          this.pendingHostContentByWebview.delete(webview);
          if (delivered !== false) this.lastHostContentByWebview.set(webview, currentContent);
        })
        .catch(error => {
          if (this.pendingHostContentByWebview.get(webview) === pendingDelivery) {
            this.pendingHostContentByWebview.delete(webview);
          }
          console.error('[MD4H] Failed posting document update:', error);
        });
    } catch (error) {
      if (this.pendingHostContentByWebview.get(webview) === pendingDelivery) {
        this.pendingHostContentByWebview.delete(webview);
      }
      console.error('[MD4H] Failed posting document update:', error);
    }
  }

  /**
   * Return the current host-authoritative document in the same Markdown form
   * consumed by TipTap. This is sent only while the Feedback owner remains
   * read-only, immediately before the host releases the session reservation.
   */
  private feedbackCloseSyncContent(document: vscode.TextDocument): string {
    const currentContent = applyBlankLinePolicy(document.getText(), this.getBlankLineMode());
    return this.wrapFrontmatterForWebview(currentContent);
  }

  /** Send the next monotonic close revision and remember its exact payload. */
  private postFeedbackCloseSync(
    document: vscode.TextDocument,
    session: ActiveFeedbackSession,
    webview: vscode.Webview,
    content = this.feedbackCloseSyncContent(document)
  ): void {
    const pendingClose = session.pendingClose;
    if (!pendingClose) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-001',
        'This feedback session has no pending close operation.'
      );
    }
    pendingClose.revision += 1;
    pendingClose.releaseRevision = undefined;
    pendingClose.contentSha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    this.lastHostContentByWebview.set(
      webview,
      applyBlankLinePolicy(document.getText(), this.getBlankLineMode())
    );
    const message: Extract<FeedbackCriticalHostMessage, { type: 'feedback.close.sync' }> = {
      type: 'feedback.close.sync',
      requestId: pendingClose.requestId,
      sessionId: session.sessionId,
      revision: pendingClose.revision,
      content,
    };
    pendingClose.deliveryAbortController = this.postFeedbackCriticalStage(
      webview,
      message,
      session.sessionId,
      pendingClose.revision,
      pendingClose.deliveryAbortController
    );
  }

  /**
   * Handle messages from webview
   */
  private handleWebviewMessage(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ) {
    if (message?.type === 'feedback.snapshot.report') {
      const report = parseFeedbackSnapshotReport(message);
      if (!report) {
        console.warn('[MD4H] Rejected malformed Feedback snapshot report');
        return;
      }
      this.acceptFeedbackSnapshotReport(webview, report);
      return;
    }

    if (message?.type === 'feedback.delivery.status.response') {
      const response = parseFeedbackDeliveryStatusResponse(message);
      if (!response) {
        console.warn('[MD4H] Rejected malformed Feedback delivery status response');
        return;
      }
      this.acceptFeedbackDeliveryStatus(webview, response);
      return;
    }

    if (message?.type === 'feedback.delivery.ack') {
      const acknowledgement = parseFeedbackDeliveryAcknowledgement(message);
      if (!acknowledgement) {
        console.warn('[MD4H] Rejected malformed Feedback delivery acknowledgement');
        return;
      }
      this.feedbackStartedTransports
        .get(webview)
        ?.acceptAcknowledgement(this.feedbackTransportAcknowledgement(acknowledgement));
      return;
    }

    if (typeof message?.type === 'string' && message.type.startsWith('feedback.')) {
      const parsed = parseFeedbackWebviewMessage(message);
      if (parsed === null) {
        const requestId =
          typeof message.requestId === 'string' &&
          message.requestId.trim().length > 0 &&
          message.requestId.length <= 256
            ? message.requestId
            : undefined;
        const activeSession = this.feedbackSessions.get(document.uri.toString());
        const sessionId =
          activeSession?.ownerWebview === webview && message.sessionId === activeSession.sessionId
            ? activeSession.sessionId
            : undefined;
        this.postFeedbackMessage(webview, {
          type: 'feedback.error',
          ...(requestId ? { requestId } : {}),
          ...(sessionId ? { sessionId } : {}),
          message: 'The feedback request was malformed or unsupported.',
          recoverable: false,
        });
        return;
      }
      void this.handleFeedbackWebviewMessage(parsed, document, webview);
      return;
    }

    const feedbackDocumentKey = document.uri.toString();
    const feedbackSession = this.feedbackSessions.get(feedbackDocumentKey);
    const feedbackTransition = this.feedbackTransitions.get(feedbackDocumentKey);
    if (message.type === 'document.teardown.edit') {
      const teardownEdit = parseDocumentTeardownEditMessage(message);
      if (!teardownEdit) {
        const identity = parseDocumentEditIdentity(message, 'document.teardown.edit');
        if (identity) {
          this.postDocumentEditAck(webview, {
            type: 'document.edit.ack',
            protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
            ...identity,
            accepted: false,
            documentVersion: this.getDocumentVersion(document),
          });
        }
        console.warn('[MD4H] Rejected malformed teardown document edit');
        return;
      }

      const rejectTeardownEdit = (): void => {
        this.postDocumentEditAck(webview, {
          type: 'document.edit.ack',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          editId: teardownEdit.editId,
          viewGeneration: teardownEdit.viewGeneration,
          localRevision: teardownEdit.localRevision,
          accepted: false,
          documentVersion: this.getDocumentVersion(document),
        });
      };
      if (this.editViewGenerations.get(webview) !== teardownEdit.viewGeneration) {
        rejectTeardownEdit();
        return;
      }
      if (this.isConflictingDocumentEditEnvelope(webview, teardownEdit)) {
        rejectTeardownEdit();
        return;
      }

      const completedAck = this.documentEditAckHistory.get(webview)?.get(teardownEdit.editId);
      if (completedAck) {
        this.postDocumentEditAck(webview, completedAck);
        return;
      }
      const pendingAck = this.pendingDocumentEditAcks.get(webview)?.get(teardownEdit.editId);
      if (pendingAck) {
        void pendingAck.then(ack => this.postDocumentEditAck(webview, ack));
        return;
      }

      if (feedbackSession || feedbackTransition) {
        rejectTeardownEdit();
        this.postCurrentFeedbackPeerLock(feedbackDocumentKey, webview);
        this.updateWebview(document, webview, { force: true });
        return;
      }

      const predecessorCompleted = this.documentEditAckHistory
        .get(webview)
        ?.get(teardownEdit.predecessorEditId);
      const predecessorPending = this.pendingDocumentEditAcks
        .get(webview)
        ?.get(teardownEdit.predecessorEditId);
      const predecessor =
        predecessorPending ??
        (predecessorCompleted ? Promise.resolve(predecessorCompleted) : undefined);
      if (
        !predecessor ||
        teardownEdit.editId === teardownEdit.predecessorEditId ||
        (predecessorCompleted &&
          (predecessorCompleted.viewGeneration !== teardownEdit.viewGeneration ||
            predecessorCompleted.localRevision !== teardownEdit.predecessorLocalRevision))
      ) {
        rejectTeardownEdit();
        return;
      }

      const result = this.applyDocumentTeardownEdit(teardownEdit, predecessor, document, webview);
      this.trackDocumentEditAck(webview, document, teardownEdit, result);
      return;
    }

    const transitionMayFlush =
      feedbackTransition !== undefined &&
      message.type === 'edit' &&
      feedbackTransition.acceptingFlushEdit &&
      (feedbackTransition.ownerWebview === webview ||
        this.feedbackWebviews.get(feedbackDocumentKey)?.has(webview) === true);
    if (
      FEEDBACK_BLOCKED_LEGACY_MESSAGES.has(message.type) &&
      (feedbackSession !== undefined || (feedbackTransition !== undefined && !transitionMayFlush))
    ) {
      const blockedEdit = message.type === 'edit' ? parseDocumentEditMessage(message) : null;
      if (blockedEdit) {
        this.postDocumentEditAck(webview, {
          type: 'document.edit.ack',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          editId: blockedEdit.editId,
          viewGeneration: blockedEdit.viewGeneration,
          localRevision: blockedEdit.localRevision,
          accepted: false,
          documentVersion: this.getDocumentVersion(document),
        });
      } else if (message.type === 'edit' && message.protocolVersion !== undefined) {
        console.warn('[MD4H] Rejected malformed versioned document edit while Feedback was locked');
      }
      if (
        (feedbackSession && feedbackSession.ownerWebview !== webview) ||
        (feedbackTransition && feedbackTransition.ownerWebview !== webview)
      ) {
        this.postCurrentFeedbackPeerLock(feedbackDocumentKey, webview);
        // This edit may have raced ahead of the peer lock message. Restore the
        // authoritative TextDocument before any later unlock exposes stale DOM.
        this.updateWebview(document, webview, { force: true });
      } else if (feedbackTransition && message.type === 'edit') {
        // Never silently discard an owner debounce that lands after its flush
        // window. Abort into exact transition recovery instead.
        feedbackTransition.invalidated = true;
      }
      return;
    }

    switch (message.type) {
      case 'edit': {
        const correlatedEdit = parseDocumentEditMessage(message);
        if (correlatedEdit) {
          const expectedGeneration = this.editViewGenerations.get(webview);
          if (expectedGeneration !== correlatedEdit.viewGeneration) {
            this.postDocumentEditAck(webview, {
              type: 'document.edit.ack',
              protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
              editId: correlatedEdit.editId,
              viewGeneration: correlatedEdit.viewGeneration,
              localRevision: correlatedEdit.localRevision,
              accepted: false,
              documentVersion: this.getDocumentVersion(document),
            });
            break;
          }
          if (this.isConflictingDocumentEditEnvelope(webview, correlatedEdit)) {
            this.postDocumentEditAck(webview, {
              type: 'document.edit.ack',
              protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
              editId: correlatedEdit.editId,
              viewGeneration: correlatedEdit.viewGeneration,
              localRevision: correlatedEdit.localRevision,
              accepted: false,
              documentVersion: this.getDocumentVersion(document),
            });
            break;
          }

          const completedAck = this.documentEditAckHistory.get(webview)?.get(correlatedEdit.editId);
          if (completedAck) {
            this.postDocumentEditAck(webview, completedAck);
            break;
          }
          const pendingAck = this.pendingDocumentEditAcks.get(webview)?.get(correlatedEdit.editId);
          if (pendingAck) {
            void pendingAck.then(ack => this.postDocumentEditAck(webview, ack));
            break;
          }
        } else if (message.protocolVersion !== undefined) {
          const identity = parseDocumentEditIdentity(message, 'edit');
          if (identity) {
            this.postDocumentEditAck(webview, {
              type: 'document.edit.ack',
              protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
              ...identity,
              accepted: false,
              documentVersion: this.getDocumentVersion(document),
            });
          }
          console.warn('[MD4H] Rejected malformed versioned document edit');
          break;
        }

        // Fire-and-forget: errors are handled inside applyEdit and shown to user.
        // applyEdit only updates the in-memory TextDocument (via WorkspaceEdit) —
        // it never writes to disk. The file is only persisted to disk on an
        // explicit `save` message (Ctrl+S), when `copyAiContextRef` saves after
        // user confirmation, or when the autosave bridge fires `document.save()`.
        if (transitionMayFlush && feedbackTransition && typeof message.content === 'string') {
          // The normal host-to-webview echo is suppressed while a transition
          // owns the document. If any later transition step fails, keep the
          // lock until this accepted content is reflected back exactly.
          feedbackTransition.recoveryRequired = true;
          feedbackTransition.expectedFlushContentSha256 = crypto
            .createHash('sha256')
            .update(this.normalizeWebviewEditContent(message.content), 'utf8')
            .digest('hex');
          if (feedbackTransition.ownerWebview !== webview) {
            // Preserve the peer's edit, then cancel this start. The owner's
            // precomputed block map predates the peer content and cannot be
            // reused without guessing.
            feedbackTransition.invalidated = true;
          }
        }
        const editReason = correlatedEdit
          ? correlatedEdit.editReason
          : ((message.editReason as 'typing' | 'save-policy-enforce' | undefined) ?? 'typing');
        const editContent = correlatedEdit?.content ?? (message.content as string);
        const editPromise = this.applyEdit(editContent, document, {
          editReason,
          sourceWebview: webview,
          ...(correlatedEdit
            ? {
                viewGeneration: correlatedEdit.viewGeneration,
                baseDocumentVersion: correlatedEdit.baseDocumentVersion,
                localRevision: correlatedEdit.localRevision,
              }
            : {}),
        });
        // `markdownForHumans.autoSave.enabled` debounced save — only for
        // ordinary typing edits. Save-policy-enforce edits are already saved
        // (or prompted for) by `handleBlankLineModeSavePolicy`.
        if (editReason === 'typing') {
          this.scheduleAutoSave(document, editPromise);
        }
        if (correlatedEdit) {
          this.trackDocumentEditAck(webview, document, correlatedEdit, editPromise);
        }
        break;
      }
      case 'save':
        // Drain work already accepted by the host, then ask this exact
        // renderer generation to flush any newer dirty revision before save.
        void this.executeSaveAfterDocumentEdits(document, webview);
        break;
      case 'flushPendingEditAck': {
        const acknowledgement = parseDocumentFlushAck(message);
        if (!acknowledgement) break;
        const pending = this.flushAckResolvers.get(acknowledgement.requestId);
        if (
          !pending ||
          pending.webview !== webview ||
          pending.viewGeneration !== acknowledgement.viewGeneration ||
          this.editViewGenerations.get(webview) !== acknowledgement.viewGeneration ||
          (acknowledgement.ok && pending.documentVersion !== acknowledgement.documentVersion)
        ) {
          break;
        }
        this.flushAckResolvers.delete(acknowledgement.requestId);
        pending.resolve(acknowledgement.ok);
        break;
      }
      case 'document.sync.request': {
        if (
          message.protocolVersion === DOCUMENT_SYNC_PROTOCOL_VERSION &&
          message.viewGeneration === this.editViewGenerations.get(webview)
        ) {
          this.updateWebview(document, webview, { force: true });
        }
        break;
      }
      case 'ready': {
        if (this.deferReadyUntilPendingDocumentBoundaries(message, document, webview)) {
          // retainContextWhenHidden=false can recreate this renderer before
          // its predecessor edits reach the shared TextDocument. Keep the old
          // generation authoritative until they settle.
          break;
        }
        // Webview is ready, send initial content and settings
        this.pendingHostContentByWebview.delete(webview);
        this.lastHostContentByWebview.delete(webview);
        this.cancelFeedbackStatusQueries(webview, 'Feedback renderer reloaded.');
        this.cancelFeedbackSnapshotReports(webview);
        this.feedbackStartedTransports.get(webview)?.dispose();
        this.feedbackStartedTransports.delete(webview);
        this.feedbackCriticalTransports.get(webview)?.dispose();
        this.feedbackCriticalTransports.delete(webview);
        this.pendingFeedbackControllerRestores.delete(webview);
        this.feedbackControllerReadyRequests.delete(webview);
        if (message.feedbackDeliveryProtocolVersion === FEEDBACK_DELIVERY_PROTOCOL_VERSION) {
          this.feedbackDeliveryCapableWebviews.add(webview);
        } else {
          this.feedbackDeliveryCapableWebviews.delete(webview);
        }
        if (message.feedbackSnapshotProtocolVersion === FEEDBACK_SNAPSHOT_PROTOCOL_VERSION) {
          this.feedbackSnapshotCapableWebviews.add(webview);
        } else {
          this.feedbackSnapshotCapableWebviews.delete(webview);
        }
        const syncReady = parseDocumentSyncReady(message);
        if (syncReady) {
          this.setEditViewGeneration(webview, syncReady.viewGeneration);
        } else {
          this.rotateEditViewGeneration(webview);
        }
        this.registerFeedbackWebview(document.uri.toString(), webview);
        if (!this.recoverFeedbackControllerOnReady(document, webview)) {
          this.updateWebview(document, webview);
          void this.announceMatchingFeedbackDrafts(document, webview);
        }
        // Also send settings separately
        const config = vscode.workspace.getConfiguration();
        const skipWarning = config.get<boolean>('markdownForHumans.imageResize.skipWarning', false);
        const skipAiContextSaveWarning = config.get<boolean>(
          'markdownForHumans.copyAiContextRef.skipSaveWarning',
          false
        );
        const imagePath = config.get<string>('markdownForHumans.imagePath', 'images');
        const imagePathBase = config.get<string>(
          'markdownForHumans.imagePathBase',
          'relativeToDocument'
        );
        const showImageHoverOverlay = config.get<boolean>(
          'markdownForHumans.imagePreview.hover.enabled',
          true
        );
        const paragraphSpacingBefore = config.get<number>(
          'markdownForHumans.paragraph.spacingBefore',
          0
        );
        const paragraphSpacingAfter = config.get<number>(
          'markdownForHumans.paragraph.spacingAfter',
          0
        );
        const zoom = config.get<number>('markdownForHumans.zoom', 100);
        const formattingShortcutsEnabled = config.get<boolean>(
          'markdownForHumans.formattingShortcuts.enabled',
          true
        );
        const blankLineMode = this.getBlankLineMode();
        const enableMath = config.get<boolean>('markdownForHumans.enableMath', true);
        webview.postMessage({
          type: 'settingsUpdate',
          skipResizeWarning: skipWarning,
          skipAiContextSaveWarning: skipAiContextSaveWarning,
          imagePath: imagePath,
          imagePathBase: imagePathBase,
          showImageHoverOverlay: showImageHoverOverlay,
          paragraphSpacingBefore: paragraphSpacingBefore,
          paragraphSpacingAfter: paragraphSpacingAfter,
          zoom: zoom,
          formattingShortcutsEnabled,
          blankLineMode,
          enableMath: enableMath,
        });
        break;
      }
      case 'outlineUpdated': {
        const outline = this.parseOutlineEntries(message.outline);
        outlineViewProvider.setOutline(outline);
        break;
      }
      case 'selectionChange': {
        const pos = message.pos as number | undefined;
        outlineViewProvider.setActiveSelection(typeof pos === 'number' ? pos : null);
        break;
      }
      case 'saveImage':
        this.trackPendingImageSave(message, document, webview);
        break;
      case 'imageSaveCompletionAck':
        this.acceptPendingImageSaveCompletionAck(message, webview);
        break;
      case 'handleWorkspaceImage':
        void this.handleWorkspaceImage(message, document, webview);
        break;
      case 'resolveImageUri':
        this.handleResolveImageUri(message, document, webview);
        break;
      case 'openSourceView':
        // Open the source file in a split view with VS Code's default text editor
        vscode.commands.executeCommand(
          'vscode.openWith',
          document.uri,
          'default',
          vscode.ViewColumn.Beside
        );
        break;
      case 'openExtensionSettings':
        vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:concretio.markdown-for-humans'
        );
        break;
      case 'exportDocument':
        this.handleExportDocument(message, document);
        break;
      case 'showError':
        vscode.window.showErrorMessage(message.message as string);
        break;
      case 'resizeImage':
        this.handleResizeImage(message, document, webview);
        break;
      case 'undoResize':
        this.handleUndoResize(message, document, webview);
        break;
      case 'redoResize':
        this.handleRedoResize(message, document, webview);
        break;
      case 'updateSetting':
        this.handleUpdateSetting(message, webview);
        break;
      case 'checkImageInWorkspace':
        this.handleCheckImageInWorkspace(message, document, webview);
        break;
      case 'copyLocalImageToWorkspace':
        this.handleCopyLocalImageToWorkspace(message, document, webview);
        break;
      case 'renameImage':
        this.handleRenameImage(message, document, webview);
        break;
      case 'checkImageRename':
        void this.handleCheckImageRename(message, document, webview);
        break;
      case 'getImageReferences':
        void this.handleGetImageReferences(message, document, webview);
        break;
      case 'openFileAtLocation':
        void this.handleOpenFileAtLocation(message);
        break;
      case 'getImageMetadata':
        this.handleGetImageMetadata(message, document, webview);
        break;
      case 'revealImageInOS':
        this.handleRevealImageInOS(message, document);
        break;
      case 'revealImageInExplorer':
        this.handleRevealImageInExplorer(message, document);
        break;
      case 'searchFiles':
        void this.handleSearchFiles(message, webview);
        break;
      case 'openExternalLink':
        void this.handleOpenExternalLink(message);
        break;
      case 'openFileLink':
        void this.handleOpenFileLink(message, document);
        break;
      case 'openImage':
        void this.handleOpenImage(message, document);
        break;
      case 'auditCheckFile':
        void this.handleAuditCheckFile(message, document, webview);
        break;
      case 'auditCheckUrl':
        void this.handleAuditCheckUrl(message, document, webview);
        break;
      case 'auditPickFile':
        void this.handleAuditPickFile(message, document, webview);
        break;
      case 'getAiContextRef':
        void this.handleGetAiContextRef(message, document, webview);
        break;
      case 'queryDocumentDirty': {
        // The webview's pending edits land in the TextDocument via WorkspaceEdit
        // (see `applyEdit`), so `document.isDirty` is the authoritative answer
        // even when the user has typed but not yet saved.
        const requestId = message.requestId as string;
        if (typeof requestId === 'string') {
          webview.postMessage({
            type: 'documentDirtyResponse',
            requestId,
            isDirty: document.isDirty,
          });
        }
        break;
      }
    }
  }

  private postFeedbackMessage(webview: vscode.Webview, message: FeedbackHostMessage): void {
    void webview.postMessage(message);
  }

  /** Resolve only a report bound to the exact renderer lifetime and snapshot stage. */
  private acceptFeedbackSnapshotReport(
    webview: vscode.Webview,
    report: FeedbackSnapshotReport
  ): void {
    const pending = this.pendingFeedbackSnapshotReports.get(report.requestId);
    if (
      !pending ||
      pending.webview !== webview ||
      pending.operationId !== report.operationId ||
      pending.stage !== report.stage ||
      pending.documentVersion !== report.documentVersion ||
      this.editViewGenerations.get(webview) !== report.viewGeneration
    ) {
      return;
    }
    this.pendingFeedbackSnapshotReports.delete(report.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(report);
  }

  /** Cancel report waiters owned by one renderer without affecting sibling splits. */
  private cancelFeedbackSnapshotReports(webview: vscode.Webview): void {
    for (const [requestId, pending] of this.pendingFeedbackSnapshotReports) {
      if (pending.webview !== webview) continue;
      this.pendingFeedbackSnapshotReports.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve(null);
    }
  }

  /** Post one strict snapshot stage and wait for its application-level report. */
  private async requestFeedbackSnapshotReport(
    webview: vscode.Webview,
    message: FeedbackSnapshotHostMessage
  ): Promise<FeedbackSnapshotReport> {
    const stage: FeedbackSnapshotReport['stage'] =
      message.type === 'feedback.snapshot.inspect' ? 'inspect' : 'applied';
    const reportPromise = new Promise<FeedbackSnapshotReport | null>(resolve => {
      const timeout = setTimeout(() => {
        const pending = this.pendingFeedbackSnapshotReports.get(message.requestId);
        if (!pending) return;
        this.pendingFeedbackSnapshotReports.delete(message.requestId);
        pending.resolve(null);
      }, MarkdownEditorProvider.FEEDBACK_SNAPSHOT_REPORT_TIMEOUT_MS);
      this.pendingFeedbackSnapshotReports.set(message.requestId, {
        webview,
        operationId: message.operationId,
        stage,
        documentVersion: message.documentVersion,
        resolve,
        timeout,
      });
    });

    let posted = false;
    try {
      posted = (await webview.postMessage(message)) !== false;
    } catch {
      posted = false;
    }
    if (!posted) {
      const pending = this.pendingFeedbackSnapshotReports.get(message.requestId);
      if (pending) {
        this.pendingFeedbackSnapshotReports.delete(message.requestId);
        clearTimeout(pending.timeout);
        pending.resolve(null);
      }
    }

    const report = await reportPromise;
    if (!report) {
      throw new FeedbackSessionError(
        'MD4H-FB-SNAPSHOT-001',
        `A rich editor split did not confirm the ${stage} snapshot stage.`
      );
    }
    return report;
  }

  /** Remove protocol-only fields before passing a validated ACK to the transport. */
  private feedbackTransportAcknowledgement(
    acknowledgement: FeedbackDeliveryAcknowledgement
  ): Omit<FeedbackDeliveryAcknowledgement, 'type' | 'protocolVersion'> {
    return {
      messageId: acknowledgement.messageId,
      operationEpoch: acknowledgement.operationEpoch,
      sessionEpoch: acknowledgement.sessionEpoch,
      stageRevision: acknowledgement.stageRevision,
      outcome: acknowledgement.outcome,
    };
  }

  /** Create one bounded transport per renderer lifetime. */
  private getFeedbackStartedTransport(webview: vscode.Webview): FeedbackStartedTransport {
    const existing = this.feedbackStartedTransports.get(webview);
    if (existing) return existing;

    const transport = new FeedbackTransport<
      FeedbackStartedDelivery,
      FeedbackStartedApplicationResult,
      never,
      never,
      FeedbackDeliveryApplicationStatus
    >({
      sendCommand: command => webview.postMessage(command.payload),
      sendAcknowledgement: () => false,
      queryStatus: (identity, signal) => {
        if (identity.sessionEpoch === null) {
          return Promise.reject(new Error('Feedback start status requires a session identity.'));
        }
        return this.queryFeedbackStartedStatus(
          webview,
          {
            messageId: identity.messageId,
            operationEpoch: identity.operationEpoch,
            sessionEpoch: identity.sessionEpoch,
            stageRevision: identity.stageRevision,
          },
          signal
        );
      },
      timers: {
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      maxAttempts: 3,
      ackTimeoutMs: 750,
      retryDelayMs: 100,
      maxRetainedEntries: 128,
    });
    this.feedbackStartedTransports.set(webview, transport);
    return transport;
  }

  /** Create one retry transport for the close and transition stages of a renderer lifetime. */
  private getFeedbackCriticalTransport(webview: vscode.Webview): FeedbackCriticalTransport {
    const existing = this.feedbackCriticalTransports.get(webview);
    if (existing) return existing;

    const transport = new FeedbackTransport<
      FeedbackCriticalHostMessage,
      FeedbackCriticalApplicationResult,
      never,
      never,
      never
    >({
      sendCommand: command => webview.postMessage(command.payload),
      sendAcknowledgement: () => false,
      // These stages are fail-closed. If all bounded posts go unanswered, the
      // host retains the session or transition lock until renderer reload
      // recovery can restore the durable draft and authoritative document.
      queryStatus: () => Promise.reject(new Error('Critical Feedback stage remained unconfirmed.')),
      timers: {
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      maxAttempts: 4,
      ackTimeoutMs: 750,
      retryDelayMs: 100,
      maxRetainedEntries: 128,
    });
    this.feedbackCriticalTransports.set(webview, transport);
    return transport;
  }

  /** Retire completed identities before intentionally replaying one revision. */
  private resetFeedbackCriticalTransport(webview: vscode.Webview): void {
    this.feedbackCriticalTransports.get(webview)?.dispose();
    this.feedbackCriticalTransports.delete(webview);
  }

  /** Bind one raw semantic stage to a deterministic transport identity. */
  private feedbackCriticalIdentity(
    messageType: FeedbackCriticalMessageType,
    requestId: string,
    sessionEpoch: string,
    stageRevision: number
  ): {
    messageId: string;
    operationEpoch: string;
    sessionEpoch: string;
    stageRevision: number;
  } {
    const digest = crypto
      .createHash('sha256')
      .update(`${messageType}\u0000${requestId}\u0000${sessionEpoch}\u0000${stageRevision}`)
      .digest('hex');
    return {
      messageId: `feedback-critical-${digest}`,
      operationEpoch: requestId,
      sessionEpoch,
      stageRevision,
    };
  }

  /** Post a critical stage with bounded retries and cancel its predecessor. */
  private postFeedbackCriticalStage(
    webview: vscode.Webview,
    message: FeedbackCriticalHostMessage,
    sessionEpoch: string,
    stageRevision: number,
    previous?: AbortController
  ): AbortController | undefined {
    previous?.abort();
    if (!this.feedbackDeliveryCapableWebviews.has(webview)) {
      this.postFeedbackMessage(webview, message);
      return undefined;
    }

    const controller = new AbortController();
    const identity = this.feedbackCriticalIdentity(
      message.type,
      message.requestId,
      sessionEpoch,
      stageRevision
    );
    const command = Object.freeze({
      ...identity,
      payload: Object.freeze(message),
    });
    void this.getFeedbackCriticalTransport(webview)
      .send(command, { signal: controller.signal })
      .then(result => {
        if (result.kind === 'acknowledged') return;
        if (result.kind !== 'cancelled') {
          console.warn(
            `[MD4H] Feedback renderer did not confirm ${message.type}; the document remains locked.`
          );
        }
      });
    return controller;
  }

  /** Translate a semantic renderer response into an application ACK. */
  private acknowledgeFeedbackCriticalStage(
    webview: vscode.Webview,
    messageType: FeedbackCriticalMessageType,
    requestId: string,
    sessionEpoch: string,
    stageRevision: number,
    applied: boolean
  ): FeedbackAcknowledgementDisposition {
    const identity = this.feedbackCriticalIdentity(
      messageType,
      requestId,
      sessionEpoch,
      stageRevision
    );
    return this.getFeedbackCriticalTransport(webview).acceptAcknowledgement({
      ...identity,
      outcome: applied
        ? { kind: 'applied', value: { messageType } }
        : { kind: 'rejected', code: 'renderer-requested-retry' },
    });
  }

  /** Stable semantic identity for one peer lock in one renderer generation. */
  private feedbackPeerLockAcquisitionId(
    requestId: string,
    lockId: string,
    viewGeneration: string
  ): string {
    const digest = crypto
      .createHash('sha256')
      .update(`${requestId}\u0000${lockId}\u0000${viewGeneration}`)
      .digest('hex');
    return `feedback-peer-lock-${digest}`;
  }

  /** Coalesce reassertions and serialize replacement locks for one renderer. */
  private async acquireFeedbackPeerLockForWebview(
    documentKey: string,
    ownerWebview: vscode.Webview,
    webview: vscode.Webview,
    requestId: string,
    lockId: string,
    allowOwner = false
  ): Promise<void> {
    while (
      this.feedbackWebviews.get(documentKey)?.has(webview) &&
      (allowOwner || webview !== ownerWebview) &&
      !this.isFeedbackViewGenerationUnavailable(webview)
    ) {
      const existing = this.inFlightFeedbackPeerLockAcquisitions.get(webview);
      if (existing) {
        if (existing.lockId === lockId) return existing.promise;
        await existing.promise.catch(() => undefined);
        continue;
      }

      const promise = this.performFeedbackPeerLockAcquisition(
        documentKey,
        ownerWebview,
        webview,
        requestId,
        lockId,
        allowOwner
      );
      const entry = { lockId, promise };
      this.inFlightFeedbackPeerLockAcquisitions.set(webview, entry);
      try {
        return await promise;
      } finally {
        if (this.inFlightFeedbackPeerLockAcquisitions.get(webview) === entry) {
          this.inFlightFeedbackPeerLockAcquisitions.delete(webview);
        }
      }
    }
  }

  /** Reliably install one lock, restarting only when that renderer generation changes. */
  private async performFeedbackPeerLockAcquisition(
    documentKey: string,
    ownerWebview: vscode.Webview,
    webview: vscode.Webview,
    requestId: string,
    lockId: string,
    allowOwner: boolean
  ): Promise<void> {
    while (
      this.feedbackWebviews.get(documentKey)?.has(webview) &&
      (allowOwner || webview !== ownerWebview)
    ) {
      const viewGeneration = this.getEditViewGeneration(webview);
      const installed = this.appliedFeedbackPeerLocks.get(webview);
      if (installed?.viewGeneration === viewGeneration && installed.lockId === lockId) return;
      const replacesLockId = installed?.viewGeneration === viewGeneration ? installed.lockId : null;
      const acquisitionId = this.feedbackPeerLockAcquisitionId(requestId, lockId, viewGeneration);
      const message: Extract<FeedbackHostMessage, { type: 'feedback.peer.lock.acquire' }> =
        Object.freeze({
          type: 'feedback.peer.lock.acquire',
          acquisitionId,
          requestId,
          lockId,
          replacesLockId,
          viewGeneration,
          revision: 1,
          message:
            'Feedback is active in another editor split. This view is read-only until it ends.',
        });
      this.pendingFeedbackPeerLockAcquisitions.set(webview, message);

      // Pre-protocol renderers still receive the old presentation message, but
      // host progression always waits for the strict application ACK above.
      if (!this.feedbackDeliveryCapableWebviews.has(webview)) {
        this.postFeedbackMessage(webview, {
          type: 'feedback.peer.locked',
          lockId,
          message: message.message,
        });
      }

      const controller = new AbortController();
      const identity = this.feedbackCriticalIdentity(
        message.type,
        acquisitionId,
        lockId,
        message.revision
      );
      const command = Object.freeze({ ...identity, payload: message });
      const result = await this.getFeedbackCriticalTransport(webview).send(command, {
        signal: controller.signal,
      });
      if (!this.feedbackWebviews.get(documentKey)?.has(webview)) {
        if (this.pendingFeedbackPeerLockAcquisitions.get(webview) === message) {
          this.pendingFeedbackPeerLockAcquisitions.delete(webview);
        }
        return;
      }
      if (this.editViewGenerations.get(webview) !== viewGeneration) {
        if (this.pendingFeedbackPeerLockAcquisitions.get(webview) === message) {
          this.pendingFeedbackPeerLockAcquisitions.delete(webview);
        }
        continue;
      }
      const installedAfterDelivery = this.appliedFeedbackPeerLocks.get(webview);
      if (
        installedAfterDelivery?.viewGeneration === viewGeneration &&
        installedAfterDelivery.lockId === lockId
      ) {
        if (this.pendingFeedbackPeerLockAcquisitions.get(webview) === message) {
          this.pendingFeedbackPeerLockAcquisitions.delete(webview);
        }
        return;
      }
      if (result.kind === 'acknowledged') {
        if (this.pendingFeedbackPeerLockAcquisitions.get(webview) === message) {
          this.pendingFeedbackPeerLockAcquisitions.delete(webview);
        }
        this.appliedFeedbackPeerLocks.set(webview, { viewGeneration, lockId });
        return;
      }
      if (result.kind === 'unavailable') {
        if (this.pendingFeedbackPeerLockAcquisitions.get(webview) === message) {
          this.pendingFeedbackPeerLockAcquisitions.delete(webview);
        }
        this.markFeedbackViewGenerationUnavailable(webview, viewGeneration);
        return;
      }
      // Keep the exact identity pending after bounded delivery exhaustion. A
      // renderer may have applied the lock while its ACK was delayed; that
      // late application ACK must still establish the fail-closed barrier.
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-002',
        'A rich editor split did not confirm its Feedback read-only lock.'
      );
    }
  }

  /** Do not freeze or commit until every live non-owner split is guarded. */
  private async acquireFeedbackPeerLocks(
    documentKey: string,
    ownerWebview: vscode.Webview,
    requestId: string,
    lockId: string,
    includeOwner = false
  ): Promise<void> {
    while (true) {
      const peers = [...(this.feedbackWebviews.get(documentKey) ?? [])].filter(
        candidate =>
          (includeOwner || candidate !== ownerWebview) &&
          !this.isFeedbackViewGenerationUnavailable(candidate)
      );
      await Promise.all(
        peers.map(peer =>
          this.acquireFeedbackPeerLockForWebview(
            documentKey,
            ownerWebview,
            peer,
            requestId,
            lockId,
            includeOwner
          )
        )
      );
      const missing = [...(this.feedbackWebviews.get(documentKey) ?? [])].some(candidate => {
        if (!includeOwner && candidate === ownerWebview) return false;
        if (this.isFeedbackViewGenerationUnavailable(candidate)) return false;
        const generation = this.editViewGenerations.get(candidate);
        const installed = this.appliedFeedbackPeerLocks.get(candidate);
        return (
          !generation || installed?.viewGeneration !== generation || installed.lockId !== lockId
        );
      });
      if (!missing) return;
    }
  }

  /** Build the exact active-session payload staged by a transfer target. */
  private feedbackSessionTransferPayload(
    session: ActiveFeedbackSession,
    workspaceRoot: string,
    webview: vscode.Webview
  ): Extract<
    FeedbackHostMessage,
    { type: 'feedback.session.transfer'; phase: 'apply' }
  >['session'] {
    const snapshot = session.store.snapshot;
    return {
      sessionId: session.sessionId,
      evidenceVersion: 2,
      source: snapshot.source,
      sourceSha256: snapshot.sourceSha256,
      round: snapshot.round,
      feedbackFile: path
        .relative(workspaceRoot, session.store.feedbackFilePath)
        .split(path.sep)
        .join('/'),
      anchors: session.anchorMap.blocks.map(block => ({
        ordinal: block.ordinal,
        startLine: block.startLine,
        endLine: block.endLine,
      })),
      items: this.feedbackItems(session, webview),
    };
  }

  /** Construct one semantic transfer stage for one exact renderer lifetime. */
  private createFeedbackSessionTransferTarget(
    pending: PendingFeedbackSessionTransfer,
    webview: vscode.Webview,
    role: PendingFeedbackSessionTransferTarget['role'],
    phase: 'apply' | 'commit' | 'abort'
  ): PendingFeedbackSessionTransferTarget {
    const workspaceRoot = this.getWorkspaceFolderPath(pending.document);
    if (!workspaceRoot) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-001',
        'Open this saved Markdown file inside a workspace before transferring Feedback.'
      );
    }
    const identity = {
      type: 'feedback.session.transfer' as const,
      phase,
      role,
      transferId: pending.transferId,
      requestId: pending.requestId,
      oldSessionId: pending.oldSession.sessionId,
      newSessionId: pending.nextSession.sessionId,
      viewGeneration: this.getEditViewGeneration(webview),
      revision: pending.revision,
      documentVersion: pending.documentVersion,
      sourceSha256: pending.sourceSha256,
      peerLockMessage: 'Feedback resumed in another rich view. This view is now read-only.',
    };
    const message: Extract<FeedbackHostMessage, { type: 'feedback.session.transfer' }> =
      phase === 'apply'
        ? {
            ...identity,
            phase: 'apply',
            session: this.feedbackSessionTransferPayload(
              pending.nextSession,
              workspaceRoot,
              webview
            ),
          }
        : { ...identity, phase };
    return {
      role,
      message: Object.freeze(message),
      applied: false,
      committed: false,
      aborted: false,
      abortAcknowledged: false,
      rendererUnavailable: false,
      applyPosted: false,
    };
  }

  /** Deliver one transfer stage through bounded application-level retries. */
  private postFeedbackSessionTransferTarget(
    documentKey: string,
    pending: PendingFeedbackSessionTransfer,
    webview: vscode.Webview,
    target: PendingFeedbackSessionTransferTarget
  ): void {
    if (target.deliveryAbortController && !target.deliveryAbortController.signal.aborted) return;
    const controller = new AbortController();
    target.deliveryAbortController = controller;
    const message = target.message;
    if (message.phase === 'apply') target.applyPosted = true;
    const identity = this.feedbackCriticalIdentity(
      message.type,
      `${message.transferId}:${message.role}:${message.phase}`,
      message.newSessionId,
      message.revision
    );
    const command = Object.freeze({ ...identity, payload: message });
    void this.getFeedbackCriticalTransport(webview)
      .send(command, { signal: controller.signal })
      .then(result => {
        if (target.deliveryAbortController === controller) {
          target.deliveryAbortController = undefined;
        }
        if (result.kind === 'acknowledged' || result.kind === 'cancelled') return;
        if (
          result.kind === 'unavailable' &&
          this.pendingFeedbackSessionTransfers.get(documentKey) === pending &&
          pending.targets.get(webview) === target &&
          this.editViewGenerations.get(webview) === message.viewGeneration
        ) {
          this.markFeedbackViewGenerationUnavailable(webview, message.viewGeneration);
          this.handleUnavailableFeedbackSessionTransferTarget(documentKey, pending, target);
          return;
        }
        if (
          this.pendingFeedbackSessionTransfers.get(documentKey) === pending &&
          pending.targets.get(webview) === target
        ) {
          this.settleFeedbackSessionTransfer(pending, 'failed-closed');
        }
        console.warn(
          `[MD4H] A live rich editor split did not confirm Feedback transfer ${message.phase}/${message.role}; ownership remains fail-closed.`
        );
      });
  }

  /** Resolve the public Resume operation exactly once while late ACK recovery remains possible. */
  private settleFeedbackSessionTransfer(
    pending: PendingFeedbackSessionTransfer,
    result: FeedbackSessionTransferCompletion
  ): void {
    if (pending.completionSettled) return;
    pending.completionSettled = true;
    pending.resolveCompletion(result);
  }

  /** Wake disposal/reload cleanup only after the coordinator leaves its map. */
  private settleFeedbackSessionTransferFinalization(pending: PendingFeedbackSessionTransfer): void {
    if (pending.finalizationSettled) return;
    pending.finalizationSettled = true;
    pending.resolveFinalization();
  }

  /** Complete a two-sided rollback only after every staged renderer has ACKed it. */
  private finalizeFeedbackSessionTransferRollback(
    documentKey: string,
    pending: PendingFeedbackSessionTransfer
  ): void {
    if (this.pendingFeedbackSessionTransfers.get(documentKey) !== pending) return;
    this.pendingFeedbackSessionTransfers.delete(documentKey);
    for (const target of pending.targets.values()) target.deliveryAbortController?.abort();
    if (this.feedbackSessions.get(documentKey) === pending.oldSession) {
      pending.oldSession.phase = 'active';
    }
    this.settleFeedbackSessionTransferFinalization(pending);
    const sameOwnerTarget =
      pending.oldOwner === pending.newOwner ? pending.targets.get(pending.oldOwner) : undefined;
    this.settleFeedbackSessionTransfer(
      pending,
      sameOwnerTarget && !sameOwnerTarget.abortAcknowledged ? 'unavailable' : 'rolled-back'
    );
  }

  /** Roll back every renderer that staged the proposed owner before host commit. */
  private beginFeedbackSessionTransferRollback(
    documentKey: string,
    pending: PendingFeedbackSessionTransfer
  ): void {
    if (
      this.pendingFeedbackSessionTransfers.get(documentKey) !== pending ||
      pending.phase === 'committing' ||
      pending.phase === 'aborting'
    ) {
      return;
    }
    pending.phase = 'aborting';
    for (const [webview, target] of pending.targets) {
      target.deliveryAbortController?.abort();
      target.deliveryAbortController = undefined;
      if (
        !target.applyPosted ||
        target.rendererUnavailable ||
        this.isFeedbackViewGenerationUnavailable(webview) ||
        this.editViewGenerations.get(webview) !== target.message.viewGeneration
      ) {
        target.aborted = true;
        continue;
      }
      const abortTarget = this.createFeedbackSessionTransferTarget(
        pending,
        webview,
        target.role,
        'abort'
      );
      target.message = abortTarget.message;
      target.aborted = false;
      this.postFeedbackSessionTransferTarget(documentKey, pending, webview, target);
    }
    this.advanceFeedbackSessionTransfer(documentKey, pending);
  }

  /** Distinguish a definitively absent renderer from an ambiguous lost ACK. */
  private handleUnavailableFeedbackSessionTransferTarget(
    documentKey: string,
    pending: PendingFeedbackSessionTransfer,
    target: PendingFeedbackSessionTransferTarget
  ): void {
    target.rendererUnavailable = true;
    if (pending.phase === 'aborting') {
      target.aborted = true;
      this.advanceFeedbackSessionTransfer(documentKey, pending);
      return;
    }
    if (pending.phase === 'committing') {
      target.committed = true;
    } else if (target.role !== 'old-owner') {
      target.aborted = true;
      this.beginFeedbackSessionTransferRollback(documentKey, pending);
      return;
    } else {
      target.applied = true;
    }
    this.advanceFeedbackSessionTransfer(documentKey, pending);
  }

  /** Accept only an exact application ACK from the target renderer generation. */
  private acceptFeedbackSessionTransferAcknowledgement(
    message: Extract<FeedbackWebviewMessage, { type: 'feedback.session.transfer.ack' }>,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): void {
    const documentKey = document.uri.toString();
    const pending = this.pendingFeedbackSessionTransfers.get(documentKey);
    const target = pending?.targets.get(webview);
    if (
      !pending ||
      !target ||
      target.message.phase !== message.phase ||
      target.message.role !== message.role ||
      target.message.transferId !== message.transferId ||
      target.message.requestId !== message.requestId ||
      target.message.oldSessionId !== message.oldSessionId ||
      target.message.newSessionId !== message.newSessionId ||
      target.message.viewGeneration !== message.viewGeneration ||
      target.message.revision !== message.revision ||
      target.message.documentVersion !== message.documentVersion ||
      target.message.sourceSha256 !== message.sourceSha256 ||
      this.editViewGenerations.get(webview) !== message.viewGeneration
    ) {
      return;
    }
    this.acknowledgeFeedbackCriticalStage(
      webview,
      target.message.type,
      `${target.message.transferId}:${target.message.role}:${target.message.phase}`,
      target.message.newSessionId,
      target.message.revision,
      message.applied
    );
    if (!message.applied) return;

    if (message.phase === 'apply') {
      target.applied = true;
    } else if (message.phase === 'commit') {
      target.committed = true;
      if (target.role === 'old-owner') {
        this.appliedFeedbackPeerLocks.set(webview, {
          viewGeneration: message.viewGeneration,
          lockId: message.newSessionId,
        });
      } else {
        this.appliedFeedbackPeerLocks.delete(webview);
      }
    } else {
      target.aborted = true;
      target.abortAcknowledged = true;
    }
    this.advanceFeedbackSessionTransfer(documentKey, pending);
  }

  /** Start the old-owner apply only after the new owner staged exact state. */
  private advanceFeedbackSessionTransfer(
    documentKey: string,
    pending: PendingFeedbackSessionTransfer
  ): void {
    if (this.pendingFeedbackSessionTransfers.get(documentKey) !== pending) return;
    if (pending.phase === 'aborting') {
      if ([...pending.targets.values()].some(target => !target.aborted)) return;
      this.finalizeFeedbackSessionTransferRollback(documentKey, pending);
      return;
    }
    if (pending.phase === 'applying-new') {
      const first = pending.targets.get(pending.newOwner);
      if (!first?.applied) return;
      if (pending.oldOwner === pending.newOwner) {
        void this.commitFeedbackSessionTransferAfterRevalidation(documentKey, pending);
        return;
      }
      pending.phase = 'applying-old';
      const oldTarget = pending.targets.get(pending.oldOwner);
      if (oldTarget) {
        this.postFeedbackSessionTransferTarget(documentKey, pending, pending.oldOwner, oldTarget);
      }
      return;
    }
    if (pending.phase === 'applying-old') {
      const oldTarget = pending.targets.get(pending.oldOwner);
      if (!oldTarget?.applied) return;
      void this.commitFeedbackSessionTransferAfterRevalidation(documentKey, pending);
      return;
    }
    if (
      [...pending.targets.values()].some(target => !target.committed) ||
      !pending.peerLocksComplete
    ) {
      return;
    }
    this.pendingFeedbackSessionTransfers.delete(documentKey);
    for (const target of pending.targets.values()) target.deliveryAbortController?.abort();
    pending.nextSession.phase = 'active';
    this.settleFeedbackSessionTransferFinalization(pending);
    this.postDegradedFeedbackRangeWarning(pending.nextSession, pending.newOwner);
    this.settleFeedbackSessionTransfer(pending, 'committed');
  }

  /** Re-read the frozen source immediately before the host changes ownership. */
  private async commitFeedbackSessionTransferAfterRevalidation(
    documentKey: string,
    pending: PendingFeedbackSessionTransfer
  ): Promise<void> {
    if (
      this.pendingFeedbackSessionTransfers.get(documentKey) !== pending ||
      pending.commitValidationPending ||
      (pending.phase !== 'applying-new' && pending.phase !== 'applying-old')
    ) {
      return;
    }
    pending.commitValidationPending = true;
    try {
      const current = this.feedbackSessions.get(documentKey);
      const documentSha256 = crypto
        .createHash('sha256')
        .update(pending.document.getText(), 'utf8')
        .digest('hex');
      if (
        current !== pending.oldSession ||
        current.phase !== 'resuming' ||
        current.invalidated ||
        this.getDocumentVersion(pending.document) !== pending.documentVersion ||
        documentSha256 !== pending.sourceSha256
      ) {
        this.beginFeedbackSessionTransferRollback(documentKey, pending);
        return;
      }
      await this.assertFeedbackSourceSha256(pending.document, pending.sourceSha256);
      if (
        this.pendingFeedbackSessionTransfers.get(documentKey) !== pending ||
        (pending.phase !== 'applying-new' && pending.phase !== 'applying-old') ||
        this.feedbackSessions.get(documentKey) !== pending.oldSession ||
        pending.oldSession.phase !== 'resuming' ||
        pending.oldSession.invalidated ||
        this.getDocumentVersion(pending.document) !== pending.documentVersion ||
        crypto.createHash('sha256').update(pending.document.getText(), 'utf8').digest('hex') !==
          pending.sourceSha256
      ) {
        this.beginFeedbackSessionTransferRollback(documentKey, pending);
        return;
      }

      pending.phase = 'committing';
      this.feedbackSessions.set(documentKey, pending.nextSession);
      this.feedbackPeerLockIds.set(documentKey, pending.nextSession.sessionId);
      pending.oldSession.mutationIdleWaiters.forEach(resolve => resolve());
      pending.oldSession.mutationIdleWaiters.clear();

      for (const [webview, target] of pending.targets) {
        target.deliveryAbortController?.abort();
        target.deliveryAbortController = undefined;
        if (
          target.rendererUnavailable ||
          this.isFeedbackViewGenerationUnavailable(webview) ||
          this.editViewGenerations.get(webview) !== target.message.viewGeneration
        ) {
          target.committed = true;
          continue;
        }
        const commitTarget = this.createFeedbackSessionTransferTarget(
          pending,
          webview,
          target.role,
          'commit'
        );
        target.message = commitTarget.message;
        this.postFeedbackSessionTransferTarget(documentKey, pending, webview, target);
      }

      pending.peerLocksStarted = true;
      const otherPeers = [...(this.feedbackWebviews.get(documentKey) ?? [])].filter(
        webview => webview !== pending.newOwner && webview !== pending.oldOwner
      );
      void Promise.all(
        otherPeers.map(webview =>
          this.acquireFeedbackPeerLockForWebview(
            documentKey,
            pending.newOwner,
            webview,
            pending.requestId,
            pending.nextSession.sessionId
          )
        )
      )
        .then(() => {
          if (this.pendingFeedbackSessionTransfers.get(documentKey) !== pending) return;
          pending.peerLocksComplete = true;
          this.advanceFeedbackSessionTransfer(documentKey, pending);
        })
        .catch(() => {
          console.warn(
            '[MD4H] A peer did not confirm the transferred Feedback lock; ownership remains read-only.'
          );
        });
      this.advanceFeedbackSessionTransfer(documentKey, pending);
    } catch (error) {
      this.beginFeedbackSessionTransferRollback(documentKey, pending);
      console.warn(
        `[MD4H] Feedback transfer revalidation failed; the staged handoff is rolling back: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      pending.commitValidationPending = false;
    }
  }

  /** Begin one two-sided transfer without changing host ownership. */
  private beginFeedbackSessionTransfer(
    document: vscode.TextDocument,
    requestId: string,
    oldSession: ActiveFeedbackSession,
    nextSession: ActiveFeedbackSession
  ): Promise<FeedbackSessionTransferCompletion> {
    const documentKey = document.uri.toString();
    if (this.pendingFeedbackSessionTransfers.has(documentKey)) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-001',
        'A different Feedback ownership transfer is already pending.'
      );
    }
    let resolveCompletion: (result: FeedbackSessionTransferCompletion) => void = () => undefined;
    const completion = new Promise<FeedbackSessionTransferCompletion>(resolve => {
      resolveCompletion = resolve;
    });
    let resolveFinalization = (): void => undefined;
    const finalization = new Promise<void>(resolve => {
      resolveFinalization = resolve;
    });
    const pending: PendingFeedbackSessionTransfer = {
      document,
      transferId: `feedback-transfer-${crypto.randomBytes(16).toString('hex')}`,
      requestId,
      oldSession,
      nextSession,
      oldOwner: oldSession.ownerWebview,
      newOwner: nextSession.ownerWebview,
      sourceSha256: oldSession.store.snapshot.sourceSha256,
      documentVersion: this.getDocumentVersion(document),
      revision: 1,
      phase: 'applying-new',
      targets: new Map(),
      peerLocksStarted: false,
      peerLocksComplete: false,
      commitValidationPending: false,
      completionSettled: false,
      completion,
      resolveCompletion,
      finalizationSettled: false,
      finalization,
      resolveFinalization,
      deferredReleaseWebviews: new Set(),
    };
    const sameOwner = pending.oldOwner === pending.newOwner;
    const newTarget = this.createFeedbackSessionTransferTarget(
      pending,
      pending.newOwner,
      sameOwner ? 'same-owner' : 'new-owner',
      'apply'
    );
    pending.targets.set(pending.newOwner, newTarget);
    if (!sameOwner) {
      pending.targets.set(
        pending.oldOwner,
        this.createFeedbackSessionTransferTarget(pending, pending.oldOwner, 'old-owner', 'apply')
      );
    }
    this.pendingFeedbackSessionTransfers.set(documentKey, pending);
    this.postFeedbackSessionTransferTarget(documentKey, pending, pending.newOwner, newTarget);
    return completion;
  }

  /** Post one generation-bound peer release through the bounded critical transport. */
  private postFeedbackPeerReleaseTarget(
    documentKey: string,
    pending: PendingFeedbackPeerRelease,
    targetWebview: vscode.Webview,
    target: PendingFeedbackPeerReleaseTarget
  ): void {
    if (target.deliveryAbortController && !target.deliveryAbortController.signal.aborted) return;
    // A prior bounded cycle for this exact semantic identity may have retired
    // as unacknowledged. Start a fresh transport lifetime before reasserting.
    this.resetFeedbackCriticalTransport(targetWebview);
    const controller = new AbortController();
    target.deliveryAbortController = controller;
    const message = target.message;
    const identity = this.feedbackCriticalIdentity(
      message.type,
      `${message.releaseId}:${message.phase}`,
      message.lockId,
      message.revision
    );
    const command = Object.freeze({ ...identity, payload: message });
    void this.getFeedbackCriticalTransport(targetWebview)
      .send(command, { signal: controller.signal })
      .then(result => {
        if (target.deliveryAbortController === controller) {
          target.deliveryAbortController = undefined;
        }
        if (result.kind === 'acknowledged' || result.kind === 'cancelled') return;
        if (result.kind === 'unavailable') {
          if (
            this.pendingFeedbackPeerReleases.get(documentKey) === pending &&
            pending.targets.get(targetWebview) === target &&
            this.editViewGenerations.get(targetWebview) === message.viewGeneration
          ) {
            this.markFeedbackViewGenerationUnavailable(targetWebview, message.viewGeneration);
            pending.targets.delete(targetWebview);
            this.finalizeFeedbackPeerReleaseIfComplete(documentKey, pending);
          }
          return;
        }
        console.warn(
          message.phase === 'apply'
            ? `[MD4H] A live rich editor split did not confirm Feedback apply ${message.requestId}; Feedback ownership remains reserved.`
            : `[MD4H] A live rich editor split did not confirm Feedback commit ${message.requestId}; that split remains read-only.`
        );
      });
  }

  /** Build one target identity for the renderer generation that will apply it. */
  private createFeedbackPeerReleaseTarget(
    pending: PendingFeedbackPeerRelease,
    webview: vscode.Webview
  ): PendingFeedbackPeerReleaseTarget {
    const viewGeneration = this.getEditViewGeneration(webview);
    const digest = crypto
      .createHash('sha256')
      .update(
        `${pending.kind}\u0000${pending.requestId}\u0000${pending.lockId}\u0000${pending.revision}\u0000${viewGeneration}`
      )
      .digest('hex');
    return {
      message: Object.freeze({
        type: 'feedback.peer.release',
        phase: 'apply',
        releaseId: `feedback-peer-release-${digest}`,
        requestId: pending.requestId,
        lockId: pending.lockId,
        viewGeneration,
        revision: pending.revision,
        documentVersion: pending.documentVersion,
        contentSha256: pending.contentSha256,
        content: pending.content,
      }),
      applied: false,
      committed: false,
    };
  }

  /** Capture the exact renderer-facing document identity used by a peer release. */
  private feedbackPeerReleaseSnapshot(document: vscode.TextDocument): {
    readonly content: string;
    readonly contentSha256: string;
    readonly documentVersion: number;
  } {
    const content = this.feedbackCloseSyncContent(document);
    return {
      content,
      contentSha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
      documentVersion: this.getDocumentVersion(document),
    };
  }

  /** Populate current renderer generations for one apply-under-lock revision. */
  private populateFeedbackPeerReleaseTargets(
    documentKey: string,
    pending: PendingFeedbackPeerRelease
  ): void {
    const transition =
      pending.kind === 'transition' ? this.feedbackTransitions.get(documentKey) : undefined;
    for (const webview of this.feedbackWebviews.get(documentKey) ?? []) {
      if (this.isFeedbackViewGenerationUnavailable(webview)) continue;
      // A failed pre-capture transition can end before the host has correlated
      // the owner's local starting state. The owner handles that error locally;
      // only renderers that received a host lock participate in this barrier.
      if (
        pending.kind === 'transition' &&
        transition?.ownerWebview === webview &&
        !transition.ownerLockPosted
      ) {
        continue;
      }
      pending.targets.set(webview, this.createFeedbackPeerReleaseTarget(pending, webview));
    }
  }

  /** Start one authoritative apply-under-lock barrier for every registered split. */
  private beginFeedbackPeerRelease(
    kind: PendingFeedbackPeerRelease['kind'],
    document: vscode.TextDocument,
    requestId: string,
    lockId: string,
    revision: number
  ): Promise<void> {
    const documentKey = document.uri.toString();
    const existing = this.pendingFeedbackPeerReleases.get(documentKey);
    if (existing) {
      if (
        existing.kind === kind &&
        existing.requestId === requestId &&
        existing.lockId === lockId &&
        existing.lifecycleRevision === revision
      ) {
        return existing.completion;
      }
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-001',
        'A different Feedback peer release is already pending.'
      );
    }

    const snapshot = this.feedbackPeerReleaseSnapshot(document);
    let resolveCompletion: () => void = () => undefined;
    const completion = new Promise<void>(resolve => {
      resolveCompletion = resolve;
    });
    const pending: PendingFeedbackPeerRelease = {
      kind,
      document,
      requestId,
      lockId,
      lifecycleRevision: revision,
      revision,
      documentVersion: snapshot.documentVersion,
      contentSha256: snapshot.contentSha256,
      content: snapshot.content,
      phase: 'applying',
      targets: new Map(),
      completion,
      resolveCompletion,
    };
    this.populateFeedbackPeerReleaseTargets(documentKey, pending);
    this.pendingFeedbackPeerReleases.set(documentKey, pending);
    for (const [webview, target] of pending.targets) {
      this.postFeedbackPeerReleaseTarget(documentKey, pending, webview, target);
    }
    this.finalizeFeedbackPeerReleaseIfComplete(documentKey, pending);
    return completion;
  }

  /** Restart apply with a fresh identity if the TextDocument changed in flight. */
  private restartFeedbackPeerReleaseIfDocumentChanged(
    documentKey: string,
    pending: PendingFeedbackPeerRelease
  ): boolean {
    if (
      this.pendingFeedbackPeerReleases.get(documentKey) !== pending ||
      pending.phase !== 'applying'
    ) {
      return false;
    }
    const snapshot = this.feedbackPeerReleaseSnapshot(pending.document);
    if (
      snapshot.documentVersion === pending.documentVersion &&
      snapshot.contentSha256 === pending.contentSha256
    ) {
      return false;
    }

    for (const target of pending.targets.values()) target.deliveryAbortController?.abort();
    pending.targets.clear();
    pending.revision += 1;
    pending.documentVersion = snapshot.documentVersion;
    pending.contentSha256 = snapshot.contentSha256;
    pending.content = snapshot.content;
    this.populateFeedbackPeerReleaseTargets(documentKey, pending);
    for (const [webview, target] of pending.targets) {
      this.postFeedbackPeerReleaseTarget(documentKey, pending, webview, target);
    }
    this.finalizeFeedbackPeerReleaseIfComplete(documentKey, pending);
    return true;
  }

  /** Accept only the exact target identity for the current renderer generation. */
  private acceptFeedbackPeerRelease(
    message: Extract<FeedbackWebviewMessage, { type: 'feedback.peer.released' }>,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): void {
    const documentKey = document.uri.toString();
    const pending = this.pendingFeedbackPeerReleases.get(documentKey);
    const target = pending?.targets.get(webview);
    if (
      !pending ||
      !target ||
      target.message.releaseId !== message.releaseId ||
      target.message.requestId !== message.requestId ||
      target.message.lockId !== message.lockId ||
      target.message.viewGeneration !== message.viewGeneration ||
      target.message.revision !== message.revision ||
      target.message.phase !== message.phase ||
      target.message.documentVersion !== message.documentVersion ||
      target.message.contentSha256 !== message.contentSha256 ||
      this.editViewGenerations.get(webview) !== message.viewGeneration
    ) {
      return;
    }
    if (
      message.phase === 'apply' &&
      this.restartFeedbackPeerReleaseIfDocumentChanged(documentKey, pending)
    ) {
      return;
    }
    this.acknowledgeFeedbackCriticalStage(
      webview,
      target.message.type,
      `${target.message.releaseId}:${target.message.phase}`,
      target.message.lockId,
      target.message.revision,
      true
    );
    // Bounded delivery may already have exhausted. Exact current semantic
    // identity still makes a late application ACK authoritative.
    if (message.phase === 'apply') {
      target.applied = true;
    } else {
      target.committed = true;
      // This exact renderer has unlocked. A subsequent Feedback session must
      // acquire from its real null predecessor, even if another split's commit
      // ACK is still outstanding.
      this.appliedFeedbackPeerLocks.delete(webview);
    }
    this.finalizeFeedbackPeerReleaseIfComplete(documentKey, pending);
  }

  /** Retire ownership after all apply ACKs, then ask each applied split to unlock. */
  private commitFeedbackPeerRelease(
    documentKey: string,
    pending: PendingFeedbackPeerRelease
  ): void {
    if (
      this.pendingFeedbackPeerReleases.get(documentKey) !== pending ||
      pending.phase !== 'applying'
    ) {
      return;
    }

    if (pending.kind === 'session') {
      const session = this.feedbackSessions.get(documentKey);
      if (
        !session ||
        session.sessionId !== pending.lockId ||
        session.pendingClose?.requestId !== pending.requestId ||
        session.pendingClose.releaseRevision !== pending.lifecycleRevision
      ) {
        return;
      }
      session.pendingClose.deliveryAbortController?.abort();
      this.feedbackSessions.delete(documentKey);
      session.mutationIdleWaiters.forEach(resolve => resolve());
      session.mutationIdleWaiters.clear();
    } else {
      const transition = this.feedbackTransitions.get(documentKey);
      if (
        !transition ||
        transition.requestId !== pending.requestId ||
        transition.lockId !== pending.lockId ||
        transition.recoveryRevision !== pending.lifecycleRevision
      ) {
        return;
      }
      transition.deliveryAbortController?.abort();
      this.feedbackTransitions.delete(documentKey);
    }

    // Ownership is now retired because every live renderer holds the exact
    // same applied baseline. Each target remains locally locked until commit.
    pending.phase = 'committing';
    if (this.feedbackPeerLockIds.get(documentKey) === pending.lockId) {
      this.feedbackPeerLockIds.delete(documentKey);
    }
    for (const [webview, target] of pending.targets) {
      target.deliveryAbortController?.abort();
      target.deliveryAbortController = undefined;
      const applyMessage = target.message;
      if (applyMessage.phase !== 'apply') continue;
      target.message = Object.freeze({
        type: applyMessage.type,
        phase: 'commit',
        releaseId: applyMessage.releaseId,
        requestId: applyMessage.requestId,
        lockId: applyMessage.lockId,
        viewGeneration: applyMessage.viewGeneration,
        revision: applyMessage.revision,
        documentVersion: applyMessage.documentVersion,
        contentSha256: applyMessage.contentSha256,
      });
      this.postFeedbackPeerReleaseTarget(documentKey, pending, webview, target);
    }
    this.finalizeFeedbackPeerReleaseIfComplete(documentKey, pending);
  }

  /** Advance the two-phase barrier only when every still-live target ACKed. */
  private finalizeFeedbackPeerReleaseIfComplete(
    documentKey: string,
    pending: PendingFeedbackPeerRelease
  ): void {
    if (this.pendingFeedbackPeerReleases.get(documentKey) !== pending) return;
    if (pending.phase === 'applying') {
      if ([...pending.targets.values()].some(target => !target.applied)) return;
      if (this.restartFeedbackPeerReleaseIfDocumentChanged(documentKey, pending)) return;
      this.commitFeedbackPeerRelease(documentKey, pending);
      return;
    }
    if ([...pending.targets.values()].some(target => !target.committed)) return;

    this.pendingFeedbackPeerReleases.delete(documentKey);
    for (const [webview, target] of pending.targets) {
      target.deliveryAbortController?.abort();
      this.appliedFeedbackPeerLocks.delete(webview);
      if (!this.feedbackDeliveryCapableWebviews.has(webview)) {
        // Compatibility-only presentation for pre-protocol test adapters.
        this.updateWebview(pending.document, webview, { force: true });
        this.postFeedbackMessage(webview, {
          type: 'feedback.peer.unlocked',
          lockId: pending.lockId,
        });
      }
    }
    pending.resolveCompletion();
  }

  private static readonly MAX_PENDING_FEEDBACK_STATUS_QUERIES = 128;
  private static readonly FEEDBACK_STATUS_QUERY_TIMEOUT_MS = 750;

  /** Ask one renderer for its actual state after application ACK retries expire. */
  private queryFeedbackStartedStatus(
    webview: vscode.Webview,
    identity: FeedbackDeliveryIdentity,
    signal: AbortSignal
  ): Promise<FeedbackDeliveryApplicationStatus> {
    if (this.disposed) return Promise.reject(new Error('Feedback provider disposed.'));
    if (signal.aborted) return Promise.reject(new Error('Feedback status query cancelled.'));

    let waiters = this.pendingFeedbackStatusQueries.get(webview);
    if (!waiters) {
      waiters = new Map();
      this.pendingFeedbackStatusQueries.set(webview, waiters);
    }
    if (
      waiters.has(identity.messageId) ||
      waiters.size >= MarkdownEditorProvider.MAX_PENDING_FEEDBACK_STATUS_QUERIES
    ) {
      if (waiters.size === 0) this.pendingFeedbackStatusQueries.delete(webview);
      return Promise.reject(new Error('Feedback status query capacity is unavailable.'));
    }

    return new Promise<FeedbackDeliveryApplicationStatus>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abortListener);
        const current = this.pendingFeedbackStatusQueries.get(webview);
        if (current?.get(identity.messageId) === waiter) current.delete(identity.messageId);
        if (current?.size === 0) this.pendingFeedbackStatusQueries.delete(webview);
      };
      const resolveStatus = (status: FeedbackDeliveryApplicationStatus): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(status);
      };
      const rejectStatus = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const abortListener = (): void => rejectStatus(new Error('Feedback status query cancelled.'));
      const waiter: PendingFeedbackStatusQuery = {
        identity: { ...identity },
        resolve: resolveStatus,
        reject: rejectStatus,
      };

      waiters.set(identity.messageId, waiter);
      signal.addEventListener('abort', abortListener, { once: true });
      const timer = setTimeout(
        () => rejectStatus(new Error('Feedback renderer status query timed out.')),
        MarkdownEditorProvider.FEEDBACK_STATUS_QUERY_TIMEOUT_MS
      );

      const query = {
        type: 'feedback.delivery.status.query' as const,
        protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        ...identity,
      };
      let queued: Thenable<boolean>;
      try {
        queued = webview.postMessage(query);
      } catch {
        rejectStatus(new Error('Feedback renderer status query failed.'));
        return;
      }
      void Promise.resolve(queued).then(
        queued => {
          if (!queued) rejectStatus(new Error('Feedback renderer status query was not queued.'));
        },
        () => rejectStatus(new Error('Feedback renderer status query failed.'))
      );
    });
  }

  /** Consume only a status response matching every field of the pending identity. */
  private acceptFeedbackDeliveryStatus(
    webview: vscode.Webview,
    response: FeedbackDeliveryStatusResponse
  ): void {
    const waiter = this.pendingFeedbackStatusQueries.get(webview)?.get(response.messageId);
    if (
      !waiter ||
      waiter.identity.operationEpoch !== response.operationEpoch ||
      waiter.identity.sessionEpoch !== response.sessionEpoch ||
      waiter.identity.stageRevision !== response.stageRevision
    ) {
      return;
    }
    waiter.resolve(response.status);
  }

  /** Reject and forget every status waiter owned by one renderer lifetime. */
  private cancelFeedbackStatusQueries(webview: vscode.Webview, reason: string): void {
    const waiters = this.pendingFeedbackStatusQueries.get(webview);
    if (!waiters) return;
    for (const waiter of [...waiters.values()]) waiter.reject(new Error(reason));
    this.pendingFeedbackStatusQueries.delete(webview);
  }

  /** Restore editability while retaining the durable draft after delivery failure. */
  private recoverFailedFeedbackStartedDelivery(
    requestId: string,
    session: ActiveFeedbackSession,
    document: vscode.TextDocument,
    webview: vscode.Webview,
    result: FeedbackDeliveryResult<
      FeedbackStartedApplicationResult,
      FeedbackDeliveryApplicationStatus
    >
  ): void {
    if (result.kind === 'cancelled') return;
    if (result.kind === 'acknowledged' && result.acknowledgement.outcome.kind === 'applied') {
      this.completeFeedbackControllerRestore(requestId, session, webview);
      return;
    }
    if (result.kind === 'status' && result.status.kind === 'applied') {
      this.completeFeedbackControllerRestore(requestId, session, webview);
      return;
    }
    if (result.kind === 'unavailable') {
      const generation = this.editViewGenerations.get(webview);
      if (generation) this.markFeedbackViewGenerationUnavailable(webview, generation);
    }

    console.warn('[MD4H] Feedback renderer did not apply the acknowledged start stage.');
    this.demoteFeedbackSessionAfterRendererFailure(
      requestId,
      session,
      document,
      webview,
      'MD4H-FB-STORE-002',
      'The rich editor did not confirm Feedback activation. The draft was saved and editing was restored.'
    );
  }

  /** Forget a completed automatic restore without affecting ordinary Start. */
  private completeFeedbackControllerRestore(
    requestId: string,
    session: ActiveFeedbackSession,
    webview: vscode.Webview
  ): void {
    const pending = this.pendingFeedbackControllerRestores.get(webview);
    if (pending?.controllerRequestId === requestId && pending.sessionId === session.sessionId) {
      this.pendingFeedbackControllerRestores.delete(webview);
    }
  }

  /** Retire failed activation only after every available renderer applies it. */
  private demoteFeedbackSessionAfterRendererFailure(
    requestId: string,
    session: ActiveFeedbackSession | undefined,
    document: vscode.TextDocument,
    webview: vscode.Webview,
    code: FeedbackHostErrorCode,
    message: string
  ): void {
    const pending = this.pendingFeedbackControllerRestores.get(webview);
    if (!session || pending?.sessionId === session.sessionId) {
      this.pendingFeedbackControllerRestores.delete(webview);
    }

    const documentKey = document.uri.toString();
    if (
      !session ||
      this.feedbackSessions.get(documentKey) !== session ||
      session.ownerWebview !== webview
    ) {
      return;
    }

    this.feedbackActiveResumeOffers.delete(webview);
    this.postFeedbackMessage(webview, {
      type: 'feedback.error',
      requestId,
      code,
      message,
      recoverable: true,
    });
    void this.retireFeedbackSessionThroughPeerRelease(
      documentKey,
      session,
      document,
      requestId,
      true
    )
      .then(() => this.announceMatchingFeedbackDrafts(document, webview))
      .catch(error => {
        console.warn(
          `[MD4H] Could not safely demote failed Feedback activation: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
  }

  /**
   * Builds webview summaries without exposing raw file URIs or image bytes.
   * Screenshot URLs are derived only from store-validated bundle assets and
   * include a host-owned revision token so capture replacement cannot reuse a
   * stale Chromium cache entry.
   */
  private feedbackItems(
    session: ActiveFeedbackSession,
    webview: vscode.Webview
  ): FeedbackItemSummary[] {
    return session.store.items.map(item => {
      const ordinals =
        session.targets.get(item.id) ??
        findFeedbackOrdinalsForLines(session.anchorMap, item.startLine, item.endLine);
      if (!ordinals) {
        session.lastErrorCode = FEEDBACK_ERROR_CODES.targetDoesNotMap;
        throw Object.assign(
          new Error(`Feedback item ${item.id} no longer maps to the frozen Markdown blocks.`),
          { code: FEEDBACK_ERROR_CODES.targetDoesNotMap }
        );
      }
      const summary = {
        id: item.id,
        startOrdinal: ordinals.startOrdinal,
        endOrdinal: ordinals.endOrdinal,
        startLine: item.startLine,
        endLine: item.endLine,
        feedback: item.feedback,
      };
      if (item.kind === 'text') {
        const projection =
          'target' in item
            ? projectFeedbackTextItemSummaryV2(item)
            : {
                focus: item.focus,
                ...(item.renderedRange === undefined ? {} : { renderedRange: item.renderedRange }),
                ...(item.cellTarget === undefined ? {} : { cellTarget: item.cellTarget }),
              };
        return {
          ...summary,
          kind: 'text' as const,
          focus: projection.focus,
          ...(projection.renderedRange === undefined ||
          session.degradedRenderedRangeIds.has(item.id)
            ? {}
            : { renderedRange: projection.renderedRange }),
          ...(projection.cellTarget === undefined || session.degradedCellTargetIds.has(item.id)
            ? {}
            : { cellTarget: projection.cellTarget }),
        };
      }
      return {
        ...summary,
        kind: 'screenshot' as const,
        imageUri: this.feedbackScreenshotPreviewUri(session, item, webview),
      };
    });
  }

  /** Resolve one exact store-owned screenshot to a webview-scoped preview URI. */
  private feedbackScreenshotPreviewUri(
    session: ActiveFeedbackSession,
    item: ScreenshotFeedbackItem | FeedbackScreenshotItemV2,
    webview: vscode.Webview
  ): string {
    const expectedRelativePath = `assets/${item.id}.png`;
    if (item.assetRelativePath !== expectedRelativePath) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-001',
        `Feedback screenshot ${item.id} has an invalid asset path.`
      );
    }

    const assetsDirectory = path.resolve(session.store.bundleDirectory, 'assets');
    const assetPath = path.resolve(
      session.store.bundleDirectory,
      ...item.assetRelativePath.split('/')
    );
    const relativeToAssets = path.relative(assetsDirectory, assetPath);
    if (
      !relativeToAssets ||
      path.isAbsolute(relativeToAssets) ||
      relativeToAssets === '..' ||
      relativeToAssets.startsWith(`..${path.sep}`)
    ) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-001',
        `Feedback screenshot ${item.id} is outside its bundle assets directory.`
      );
    }

    const scopedUri = webview.asWebviewUri(vscode.Uri.file(assetPath)).toString();
    const revision = session.previewRevisions.get(item.id) ?? 1;
    const separator = scopedUri.includes('?') ? '&' : '?';
    return `${scopedUri}${separator}md4hFeedback=${encodeURIComponent(
      `${session.previewNonce}-${item.id}-${revision}`
    )}`;
  }

  /**
   * Announces exact source/hash-matching drafts without changing editor state.
   * The webview must wait for an explicit Resume action before becoming read-only.
   */
  private async announceMatchingFeedbackDrafts(
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    if (
      document.uri.scheme !== 'file' ||
      document.isDirty ||
      this.feedbackSessions.has(document.uri.toString())
    ) {
      return;
    }
    const workspaceRoot = this.getWorkspaceFolderPath(document);
    if (!workspaceRoot) return;

    try {
      const sourceBytes = await readFile(document.uri.fsPath);
      const drafts = await this.findFeedbackDraftSummaries(
        workspaceRoot,
        document.uri.fsPath,
        sourceBytes
      );
      if (drafts.length === 0) return;
      this.postFeedbackMessage(webview, {
        type: 'feedback.drafts.available',
        drafts,
      });
    } catch (error) {
      console.error('[MD4H] Could not discover matching feedback drafts:', error);
    }
  }

  /** Discover safe, exact-hash draft summaries without exposing feedback content. */
  private async findFeedbackDraftSummaries(
    workspaceRoot: string,
    sourcePath: string,
    sourceBytes: Uint8Array
  ): Promise<FeedbackDraftSummary[]> {
    const discovery = await FeedbackSessionStore.findMatchingDrafts({
      workspaceRoot,
      sourcePath,
      sourceBytes,
    });
    if (discovery.invalidCandidates.length > 0) {
      console.warn(
        `[MD4H] Ignored ${discovery.invalidCandidates.length} invalid feedback draft candidate(s).`
      );
    }
    return discovery.drafts.map(draft => ({
      round: draft.round,
      createdAt: draft.createdAt,
      itemCount: draft.itemCount,
      feedbackFile: path.relative(workspaceRoot, draft.feedbackFilePath).split(path.sep).join('/'),
    }));
  }

  private invalidateFeedbackSession(documentKey: string, _webview?: vscode.Webview): void {
    const session = this.feedbackSessions.get(documentKey);
    if (!session || session.invalidated) return;
    session.invalidated = true;
    session.lastErrorCode = FEEDBACK_ERROR_CODES.sourceChanged;
    this.postFeedbackMessage(session.ownerWebview, {
      type: 'feedback.invalidated',
      sessionId: session.sessionId,
      code: FEEDBACK_ERROR_CODES.sourceChanged,
      message: 'The Markdown source changed outside the frozen feedback snapshot.',
    });
  }

  /** Flush one rich view's pending debounce and await its WorkspaceEdit. */
  private async flushFeedbackWebview(
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<boolean> {
    if (!(await this.drainDocumentEdits(document))) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-002',
        'Could not apply pending editor changes before starting feedback.'
      );
    }

    const requestId = `feedback-flush-${crypto.randomBytes(8).toString('hex')}`;
    const documentKey = document.uri.toString();
    const viewGeneration = this.getEditViewGeneration(webview);
    const documentVersion = this.getDocumentVersion(document);
    const registeredBeforeFlush = this.feedbackWebviews.get(documentKey)?.has(webview) === true;
    const completedBefore = new Set(this.documentEditAckHistory.get(webview)?.keys() ?? []);
    let acknowledgementTimeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let markFlushSettled: () => void = () => undefined;
    const flushSettled = new Promise<void>(resolve => {
      markFlushSettled = resolve;
    });
    let settleBoundary: (
      outcome: 'acknowledged' | 'rejected' | 'unavailable' | 'timeout'
    ) => void = () => undefined;
    const boundary = new Promise<'acknowledged' | 'rejected' | 'unavailable' | 'timeout'>(
      resolve => {
        settleBoundary = outcome => {
          if (settled) return;
          settled = true;
          this.flushAckResolvers.delete(requestId);
          if (acknowledgementTimeout) clearTimeout(acknowledgementTimeout);
          markFlushSettled();
          resolve(outcome);
        };
        this.flushAckResolvers.set(requestId, {
          webview,
          viewGeneration,
          documentVersion,
          settled: flushSettled,
          resolve: ok => {
            settleBoundary(ok ? 'acknowledged' : 'rejected');
          },
        });
        acknowledgementTimeout = setTimeout(() => {
          settleBoundary('timeout');
        }, FEEDBACK_FLUSH_ACK_TIMEOUT_MS);
      }
    );
    try {
      const delivery = webview.postMessage({
        type: 'flushPendingEdit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        requestId,
        viewGeneration,
        documentVersion,
      });
      void Promise.resolve(delivery).then(
        posted => {
          if (posted === false) settleBoundary('unavailable');
        },
        () => {
          settleBoundary('unavailable');
        }
      );
    } catch {
      // Replaced panels can become unavailable just before their disposal
      // callbacks finish. The caller may prune peers, but never the owner.
      settleBoundary('unavailable');
    }

    const outcome = await boundary;
    if (outcome === 'unavailable') return false;
    if (outcome === 'timeout') {
      if (registeredBeforeFlush && !this.feedbackWebviews.get(documentKey)?.has(webview)) {
        return false;
      }
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-002',
        'Could not flush the latest editor changes, so feedback did not start.'
      );
    }
    if (outcome === 'rejected') {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-002',
        'Could not flush the latest editor changes, so feedback did not start.'
      );
    }

    const acknowledgements = [...(this.pendingDocumentEditAcks.get(webview)?.values() ?? [])];
    const results = await Promise.all(acknowledgements);

    if (!(await this.drainDocumentEdits(document))) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-002',
        'Could not apply pending editor changes before starting feedback.'
      );
    }
    const completedAfter = this.documentEditAckHistory.get(webview);
    const rejected =
      results.some(result => !result.accepted) ||
      [...(completedAfter?.entries() ?? [])].some(
        ([editId, result]) => !completedBefore.has(editId) && !result.accepted
      );
    if (rejected) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-002',
        'Could not apply the latest editor changes, so feedback did not start.'
      );
    }
    return true;
  }

  /**
   * Flush every registered split before freezing the shared TextDocument.
   * Peers run first and the initiating view runs last so the active split has
   * deterministic precedence if two debounces are exceptionally pending.
   */
  private async flushFeedbackWebviews(
    document: vscode.TextDocument,
    ownerWebview: vscode.Webview
  ): Promise<void> {
    const registered = [...(this.feedbackWebviews.get(document.uri.toString()) ?? [])];
    const targets = [...registered.filter(candidate => candidate !== ownerWebview), ownerWebview];
    const seen = new Set<vscode.Webview>();
    for (const target of targets) {
      if (seen.has(target)) continue;
      seen.add(target);
      const available = await this.flushFeedbackWebview(document, target);
      if (available) continue;

      const documentKey = document.uri.toString();
      this.unregisterFeedbackWebview(documentKey, target);
      this.lastHostContentByWebview.delete(target);
      this.pendingHostContentByWebview.delete(target);
      if (this.lastWebviewContentSource.get(documentKey) === target) {
        this.lastWebviewContentSource.delete(documentKey);
      }
      if (target === ownerWebview) {
        throw new FeedbackSessionError(
          'MD4H-FB-STORE-002',
          'The active rich editor is no longer available, so feedback did not start.'
        );
      }
    }
  }

  /** Return every currently registered split exactly once, with the owner last. */
  private feedbackSnapshotWebviews(
    document: vscode.TextDocument,
    ownerWebview: vscode.Webview
  ): vscode.Webview[] {
    const registered = [...(this.feedbackWebviews.get(document.uri.toString()) ?? [])];
    return [
      ...new Set([...registered.filter(candidate => candidate !== ownerWebview), ownerWebview]),
    ];
  }

  /** Fail before any flush can choose a winner when dirty split contents diverge. */
  private async inspectFeedbackSnapshotSplits(
    document: vscode.TextDocument,
    ownerWebview: vscode.Webview,
    operationId: string
  ): Promise<void> {
    const webviews = this.feedbackSnapshotWebviews(document, ownerWebview);
    if (webviews.some(webview => !this.feedbackSnapshotCapableWebviews.has(webview))) {
      throw new FeedbackSessionError(
        'MD4H-FB-SNAPSHOT-001',
        'Reload every open rich editor split before starting Feedback so their snapshots can be verified.'
      );
    }
    const documentVersion = this.getDocumentVersion(document);
    const reports = await Promise.all(
      webviews.map((webview, index) =>
        this.requestFeedbackSnapshotReport(webview, {
          type: 'feedback.snapshot.inspect',
          protocolVersion: FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
          requestId: `${operationId}-inspect-${index + 1}`,
          operationId,
          documentVersion,
        })
      )
    );
    const dirtyDigests = new Set(
      reports
        .filter(
          (report): report is Extract<FeedbackSnapshotReport, { stage: 'inspect' }> =>
            report.stage === 'inspect' && report.dirty
        )
        .map(report => computeFeedbackTextSha256(report.content))
    );
    if (dirtyDigests.size > 1) {
      throw new FeedbackSessionError(
        'MD4H-FB-SNAPSHOT-001',
        'Two dirty rich editor splits contain divergent Markdown. Save or reconcile the splits before starting Feedback.'
      );
    }
  }

  private async flushFeedbackSnapshot(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    beforeCapture?: () => Promise<void>
  ): Promise<FlushedFeedbackSnapshot> {
    if (document.uri.scheme !== 'file') {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-001',
        'Save this Markdown file inside the workspace before starting feedback.'
      );
    }

    const operationId = crypto.randomBytes(16).toString('hex');
    if (this.feedbackSnapshotCapableWebviews.has(webview)) {
      await this.inspectFeedbackSnapshotSplits(document, webview, operationId);
    }
    await this.flushFeedbackWebviews(document, webview);
    await beforeCapture?.();
    if (!(await this.drainDocumentEdits(document))) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-002',
        'Could not settle editor changes after installing the Feedback split locks.'
      );
    }

    const capturedDocumentVersion = this.getDocumentVersion(document);
    const capturedSourceText = document.getText();

    if (document.isDirty) {
      let saved = false;
      try {
        saved = await document.save();
      } catch (error) {
        throw new FeedbackSessionError(
          'MD4H-FB-STORE-002',
          `Could not save the Markdown snapshot: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (!saved || document.isDirty) {
        throw new FeedbackSessionError(
          'MD4H-FB-STORE-002',
          'The Markdown file could not be saved, so feedback did not start.'
        );
      }
    }

    const sourceBytes = await readFile(document.uri.fsPath);
    const prepared = this.feedbackSnapshotService.prepareSource({
      documentUri: document.uri.toString(),
      operationId,
      capturedDocumentVersion,
      currentDocumentVersion: this.getDocumentVersion(document),
      sourceText: capturedSourceText,
      savedBytes: sourceBytes,
    });
    if (!prepared.ok) {
      throw new FeedbackSessionError(prepared.error.code, prepared.error.detail);
    }
    return { sourceBytes, source: prepared.source };
  }

  /** Apply one saved source to every split and verify the owner's fresh block map. */
  private async finalizeFeedbackRendererSnapshot(
    document: vscode.TextDocument,
    ownerWebview: vscode.Webview,
    source: FeedbackPreparedSourceSnapshot
  ): Promise<FinalizedFeedbackRendererSnapshot> {
    const webviews = this.feedbackSnapshotWebviews(document, ownerWebview);
    if (webviews.some(webview => !this.feedbackSnapshotCapableWebviews.has(webview))) {
      throw new FeedbackSessionError(
        'MD4H-FB-SNAPSHOT-001',
        'A rich editor split cannot verify the saved Feedback snapshot. Reload every split and try again.'
      );
    }

    const descriptorRevision = 1;
    const reports = await Promise.all(
      webviews.map((webview, index) =>
        this.requestFeedbackSnapshotReport(webview, {
          type: 'feedback.snapshot.apply',
          protocolVersion: FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
          requestId: `${source.operationId}-apply-${index + 1}`,
          operationId: source.operationId,
          documentVersion: source.documentVersion,
          content: this.wrapFrontmatterForWebview(source.sourceText),
          descriptorRevision,
          includeCanonicalBlocks: webview === ownerWebview,
        })
      )
    );
    if (reports.some(report => report.stage !== 'applied')) {
      throw new FeedbackSessionError(
        'MD4H-FB-SNAPSHOT-001',
        'A rich editor split returned the wrong Feedback snapshot stage.'
      );
    }
    const appliedReports = reports as FeedbackSnapshotAppliedReport[];
    if (
      appliedReports.some(
        report =>
          report.canonicalDescriptorRevision !== descriptorRevision ||
          !this.feedbackRendererContentMatchesSource(report.content, source.sourceText)
      )
    ) {
      throw new FeedbackSessionError(
        'MD4H-FB-SNAPSHOT-001',
        'A rich editor split applied a different Feedback snapshot revision.'
      );
    }
    const ownerIndex = webviews.indexOf(ownerWebview);
    const ownerReport = appliedReports[ownerIndex];
    if (!ownerReport?.blocks || ownerReport.blocks.length === 0) {
      throw new FeedbackSessionError(
        'MD4H-FB-SNAPSHOT-001',
        'The active rich editor did not return canonical blocks for the saved snapshot.'
      );
    }

    const splitReports: FeedbackSplitSnapshotReport[] = appliedReports.map(report => ({
      viewId: report.viewGeneration,
      viewGeneration: report.viewGeneration,
      localRevision: report.localRevision,
      documentVersion: report.documentVersion,
      dirty: false,
      // The renderer's actual serialization was independently validated just
      // above. The snapshot identity remains bound to the exact saved source.
      contentSha256: source.sourceTextSha256,
    }));
    const finalized = this.feedbackSnapshotService.finalize({
      source,
      currentDocumentVersion: this.getDocumentVersion(document),
      splitReports,
      renderer: {
        viewId: ownerReport.viewGeneration,
        viewGeneration: ownerReport.viewGeneration,
        localRevision: ownerReport.localRevision,
        documentVersion: ownerReport.documentVersion,
        contentSha256: source.sourceTextSha256,
        canonicalDescriptorRevision: ownerReport.canonicalDescriptorRevision,
      },
      descriptors: {
        revision: ownerReport.canonicalDescriptorRevision,
        blocks: ownerReport.blocks,
      },
    });
    if (!finalized.ok) {
      throw new FeedbackSessionError(finalized.error.code, finalized.error.detail);
    }

    for (const webview of webviews) {
      this.pendingHostContentByWebview.delete(webview);
      this.lastHostContentByWebview.set(webview, source.sourceText);
    }
    return {
      identity: finalized.snapshot,
      blocks: ownerReport.blocks,
      anchorMap: {
        blocks: finalized.snapshot.anchorMap.blocks.map(block => ({ ...block })),
      },
    };
  }

  private requireFeedbackSession(
    message: Extract<FeedbackWebviewMessage, { sessionId: string }>,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): ActiveFeedbackSession {
    const session = this.feedbackSessions.get(document.uri.toString());
    if (!session || session.ownerWebview !== webview || session.sessionId !== message.sessionId) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-001',
        'This feedback session is no longer active.'
      );
    }
    return session;
  }

  private mapFeedbackTarget(
    session: ActiveFeedbackSession,
    startOrdinal: number,
    endOrdinal: number
  ): { startOrdinal: number; endOrdinal: number; startLine: number; endLine: number } {
    const result = mapFeedbackSelection(session.anchorMap, startOrdinal, endOrdinal);
    if (!result.ok) {
      session.lastErrorCode = result.error.code;
      throw Object.assign(
        new Error('The rendered target no longer maps to the frozen Markdown snapshot.'),
        { code: result.error.code }
      );
    }
    return result.range;
  }

  /** Resolve one trusted canonical endpoint or fail without searching content. */
  private feedbackCanonicalEndpointV2(
    session: ActiveFeedbackSession,
    ordinal: number
  ): FeedbackCanonicalEndpointStateV2 {
    const block = session.canonicalBlocks.get(ordinal);
    if (block === undefined) {
      session.lastErrorCode = FEEDBACK_ERROR_CODES.targetDoesNotMap;
      throw Object.assign(new Error('The Feedback target endpoint is no longer available.'), {
        code: FEEDBACK_ERROR_CODES.targetDoesNotMap,
      });
    }
    return { ordinal, ...block };
  }

  /**
   * Bind one persisted v2 span to the exact canonical endpoints selected by
   * its retained source lines. The report is untrusted input on Resume, so a
   * stale or forged ordinal, normalized kind, or block hash must fail closed
   * instead of being repaired from the line map.
   */
  private assertPersistedFeedbackBlockSpanV2(
    session: ActiveFeedbackSession,
    itemId: string,
    target: { startOrdinal: number; endOrdinal: number },
    blockSpan: FeedbackTargetV2['blockSpan']
  ): void {
    const startBlock = this.feedbackCanonicalEndpointV2(session, target.startOrdinal);
    const endBlock = this.feedbackCanonicalEndpointV2(session, target.endOrdinal);
    const startKind = normalizeFeedbackBlockKindV2(startBlock.kind);
    const endKind = normalizeFeedbackBlockKindV2(endBlock.kind);
    const matchesCanonicalSpan =
      startKind !== null &&
      endKind !== null &&
      blockSpan.startOrdinal === target.startOrdinal &&
      blockSpan.endOrdinal === target.endOrdinal &&
      blockSpan.startKind === startKind &&
      blockSpan.endKind === endKind &&
      blockSpan.startBlockSha256 === startBlock.sha256 &&
      blockSpan.endBlockSha256 === endBlock.sha256;
    if (matchesCanonicalSpan) return;

    session.lastErrorCode = FEEDBACK_ERROR_CODES.targetDoesNotMap;
    throw Object.assign(
      new Error(
        `Feedback item ${itemId} block span does not match its frozen Markdown block identity.`
      ),
      { code: FEEDBACK_ERROR_CODES.targetDoesNotMap }
    );
  }

  /** Classify authored source without accepting a renderer-supplied format. */
  private feedbackSourceFormatV2(
    session: ActiveFeedbackSession,
    target: { startOrdinal: number; endOrdinal: number; startLine: number }
  ): FeedbackSourceEvidenceFormat {
    const formats = new Set<FeedbackSourceEvidenceFormat>();
    for (let ordinal = target.startOrdinal; ordinal <= target.endOrdinal; ordinal += 1) {
      const block = this.feedbackCanonicalEndpointV2(session, ordinal);
      const kind = normalizeFeedbackBlockKindV2(block.kind);
      if (kind === null || kind === 'other') {
        formats.add('text');
        continue;
      }
      if (kind === 'html') {
        formats.add('html');
        continue;
      }
      const anchor = session.anchorMap.blocks.find(candidate => candidate.ordinal === ordinal);
      const firstLine =
        anchor === undefined ? undefined : session.sourceIndex.lines[anchor.startLine - 1];
      if (firstLine !== undefined && kind === 'table') {
        const prefix = session.sourceBytes
          .subarray(firstLine.startByteOffset, firstLine.endByteOffset)
          .toString('utf8')
          .trimStart();
        if (/^<(?:table|thead|tbody|tfoot|tr|th|td)\b/i.test(prefix)) {
          formats.add('html');
          continue;
        }
      }
      formats.add('markdown');
    }
    if (formats.size === 1) return formats.values().next().value ?? 'text';
    return 'text';
  }

  /** Recompute stable v2 aggregate budgets from durable items only. */
  private feedbackV2BudgetState(items: readonly FeedbackItemV2[]): {
    embeddedSourceBytes: number;
    exactCellCount: number;
  } {
    const embeddedSourceBytes = feedbackEmbeddedSourceBytesV2(items.map(item => item.evidence));
    const exactCellCount = items.reduce((total, item) => {
      if (
        item.kind !== 'text' ||
        item.target.resolution !== 'exact' ||
        item.target.locator?.kind !== 'table-cells'
      ) {
        return total;
      }
      const rectangle = item.target.locator.value.rectangle;
      return total + (rectangle.bottom - rectangle.top) * (rectangle.right - rectangle.left);
    }, 0);
    if (exactCellCount > FEEDBACK_MAX_EXACT_CELLS_PER_SESSION_V2) {
      throw Object.assign(new Error('The exact Feedback cell budget is inconsistent.'), {
        code: FEEDBACK_ERROR_CODES.targetDoesNotMap,
      });
    }
    return { embeddedSourceBytes, exactCellCount };
  }

  /** Resolve an untrusted renderer v2 request against frozen host state. */
  private resolveFeedbackTextTargetV2(
    session: ActiveFeedbackSession,
    target: { startOrdinal: number; endOrdinal: number; startLine: number; endLine: number },
    rendererTarget: unknown,
    rendererEvidence: unknown,
    budgetItems: readonly FeedbackItemV2[]
  ): { target: FeedbackTextItemV2['target']; evidence: FeedbackEvidenceEnvelopeV2 } {
    const budget = this.feedbackV2BudgetState(budgetItems);
    try {
      const resolved = resolveFeedbackTargetEvidenceV2({
        sourceIndex: session.sourceIndex,
        sourceLines: { startLine: target.startLine, endLine: target.endLine },
        startBlock: this.feedbackCanonicalEndpointV2(session, target.startOrdinal),
        endBlock: this.feedbackCanonicalEndpointV2(session, target.endOrdinal),
        rendererTarget,
        ...(rendererEvidence === undefined ? {} : { rendererEvidence }),
        sourceFormat: this.feedbackSourceFormatV2(session, target),
        currentAggregateEmbeddedSourceBytes: budget.embeddedSourceBytes,
        currentExactCellCount: budget.exactCellCount,
      });
      if (resolved.sourceBytesSha256 !== session.store.snapshot.sourceSha256) {
        throw new Error('The retained source index does not match the active Feedback round.');
      }
      return { target: resolved.target, evidence: resolved.evidence };
    } catch (error) {
      session.lastErrorCode = FEEDBACK_ERROR_CODES.targetDoesNotMap;
      throw Object.assign(
        new Error(
          error instanceof Error
            ? error.message
            : 'The Feedback target could not be resolved against the frozen source.'
        ),
        { code: FEEDBACK_ERROR_CODES.targetDoesNotMap }
      );
    }
  }

  /** Derive an exact visual target and containing-source reference for a PNG. */
  private resolveFeedbackVisualTargetV2(
    session: ActiveFeedbackSession,
    target: { startOrdinal: number; endOrdinal: number; startLine: number; endLine: number }
  ): { target: FeedbackTargetV2; sourceReference: FeedbackVisualSourceReferenceV2 } {
    const startBlock = this.feedbackCanonicalEndpointV2(session, target.startOrdinal);
    const endBlock = this.feedbackCanonicalEndpointV2(session, target.endOrdinal);
    const startKind = normalizeFeedbackBlockKindV2(startBlock.kind);
    const endKind = normalizeFeedbackBlockKindV2(endBlock.kind);
    if (startKind === null || endKind === null) {
      throw Object.assign(new Error('The visual Feedback block kind is unsupported.'), {
        code: FEEDBACK_ERROR_CODES.targetDoesNotMap,
      });
    }
    const format = this.feedbackSourceFormatV2(session, target);
    const source = projectFeedbackSourceEvidence(session.sourceIndex, {
      startLine: target.startLine,
      endLine: target.endLine,
      relationship: 'containing-blocks',
      format,
      itemUtf8Budget: 0,
      remainingAggregateUtf8Budget: 0,
    });
    return {
      target: {
        version: 2,
        requestedScope: 'visual-region',
        effectiveScope: 'visual-region',
        resolution: 'exact',
        blockSpan: {
          startOrdinal: startBlock.ordinal,
          endOrdinal: endBlock.ordinal,
          startKind,
          endKind,
          startBlockSha256: startBlock.sha256,
          endBlockSha256: endBlock.sha256,
        },
      },
      sourceReference: {
        relationship: 'containing-blocks',
        format,
        normalization: 'lf',
        sourceSliceSha256: source.sourceSliceSha256,
      },
    };
  }

  /** Return a fully v2 item set or fail on mixed in-memory schema state. */
  private feedbackItemsV2(session: ActiveFeedbackSession): FeedbackItemV2[] {
    const items = session.store.items;
    if (items.some(item => !('target' in item) || !('evidence' in item))) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-001',
        'The Feedback draft has not been migrated to evidence v2.'
      );
    }
    return items as FeedbackItemV2[];
  }

  /**
   * Resolve every v1 item in stable ID order without rewriting the draft.
   * The store validates this one-to-one set and combines it with the triggering
   * mutation or seal in one guarded atomic report replacement.
   */
  private async feedbackMigrationItemsV2(
    session: ActiveFeedbackSession
  ): Promise<FeedbackItemV2[] | undefined> {
    if (session.store.schemaVersion === 2) return undefined;
    const migrated: FeedbackItemV2[] = [];
    let embeddedSourceBytes = 0;
    let exactCellCount = 0;
    const legacyItems = session.store.items as readonly FeedbackItem[];
    for (const item of [...legacyItems].sort((left, right) => left.sequence - right.sequence)) {
      const target =
        session.targets.get(item.id) ??
        findFeedbackOrdinalsForLines(session.anchorMap, item.startLine, item.endLine);
      if (target === undefined || target === null) {
        throw Object.assign(
          new Error(`Feedback item ${item.id} no longer maps to the frozen Markdown blocks.`),
          { code: FEEDBACK_ERROR_CODES.targetDoesNotMap }
        );
      }
      const migrationItem: FeedbackMigrationItemV1 = { ...item };
      const screenshotDimensions =
        item.kind === 'screenshot'
          ? await session.store.getValidatedScreenshotMetadata(item.id)
          : undefined;
      const result = migrateFeedbackItemV1ToV2({
        sourceIndex: session.sourceIndex,
        sourceLines: { startLine: item.startLine, endLine: item.endLine },
        startBlock: this.feedbackCanonicalEndpointV2(session, target.startOrdinal),
        endBlock: this.feedbackCanonicalEndpointV2(session, target.endOrdinal),
        item: migrationItem,
        locatorValidity: {
          renderedRange:
            item.kind === 'text' &&
            item.renderedRange !== undefined &&
            !session.degradedRenderedRangeIds.has(item.id) &&
            this.validatePersistedFeedbackRenderedRange(session, target, item.renderedRange),
          cellTarget:
            item.kind === 'text' &&
            item.cellTarget !== undefined &&
            !session.degradedCellTargetIds.has(item.id) &&
            this.validatePersistedFeedbackCellTarget(session, target, item.cellTarget),
        },
        sourceFormat: this.feedbackSourceFormatV2(session, {
          ...target,
          startLine: item.startLine,
        }),
        ...(screenshotDimensions === undefined ? {} : { screenshotDimensions }),
        currentAggregateEmbeddedSourceBytes: embeddedSourceBytes,
        currentExactCellCount: exactCellCount,
      });
      migrated.push(result.item);
      embeddedSourceBytes += result.aggregateEmbeddedSourceBytesConsumed;
      exactCellCount += result.exactCellCountConsumed;
    }
    return migrated;
  }

  /** Convert one legacy renderer add request without reclassifying its Focus. */
  private resolveLegacyFeedbackTextTargetV2(
    session: ActiveFeedbackSession,
    target: { startOrdinal: number; endOrdinal: number; startLine: number; endLine: number },
    input: {
      focus: string;
      feedback: string;
      renderedRange?: FeedbackRenderedRangeInputV1;
      cellTarget?: FeedbackCellTargetInputV1;
    },
    budgetItems: readonly FeedbackItemV2[]
  ): { target: FeedbackTargetV2; evidence: FeedbackEvidenceEnvelopeV2 } {
    if (input.renderedRange === undefined || input.cellTarget !== undefined) {
      session.lastErrorCode = FEEDBACK_ERROR_CODES.targetDoesNotMap;
      throw Object.assign(
        new Error(
          'This Feedback selection predates structured evidence. Reload the rich editor and select it again.'
        ),
        { code: FEEDBACK_ERROR_CODES.targetDoesNotMap }
      );
    }
    return this.resolveFeedbackTextTargetV2(
      session,
      target,
      {
        version: 2,
        requestedScope: 'rendered-text',
        locator: { kind: 'rendered-range', value: input.renderedRange },
      },
      { kind: 'rendered-text', text: input.focus, complete: true },
      budgetItems
    );
  }

  /** Rebuild only stale v2 locator items for the irreversible seal boundary. */
  private feedbackItemsResolvedForSealV2(session: ActiveFeedbackSession): FeedbackItemV2[] {
    const resolved: FeedbackItemV2[] = [];
    let embeddedSourceBytes = 0;
    let exactCellCount = 0;
    for (const item of [...this.feedbackItemsV2(session)].sort(
      (left, right) => left.sequence - right.sequence
    )) {
      const isStale =
        session.degradedRenderedRangeIds.has(item.id) || session.degradedCellTargetIds.has(item.id);
      if (!isStale) {
        resolved.push(item);
        const itemBudget = this.feedbackV2BudgetState([item]);
        embeddedSourceBytes += itemBudget.embeddedSourceBytes;
        exactCellCount += itemBudget.exactCellCount;
        continue;
      }
      const target =
        session.targets.get(item.id) ??
        findFeedbackOrdinalsForLines(session.anchorMap, item.startLine, item.endLine);
      if (target === undefined || target === null) {
        throw Object.assign(
          new Error(`Feedback item ${item.id} no longer maps to the frozen Markdown blocks.`),
          { code: FEEDBACK_ERROR_CODES.targetDoesNotMap }
        );
      }
      const result = degradeFeedbackItemV2ForStaleLocator({
        sourceIndex: session.sourceIndex,
        sourceLines: { startLine: item.startLine, endLine: item.endLine },
        startBlock: this.feedbackCanonicalEndpointV2(session, target.startOrdinal),
        endBlock: this.feedbackCanonicalEndpointV2(session, target.endOrdinal),
        item,
        sourceFormat: this.feedbackSourceFormatV2(session, {
          ...target,
          startLine: item.startLine,
        }),
        currentAggregateEmbeddedSourceBytes: embeddedSourceBytes,
        currentExactCellCount: exactCellCount,
      });
      resolved.push(result.item);
      embeddedSourceBytes += result.aggregateEmbeddedSourceBytesConsumed;
      exactCellCount += result.exactCellCountConsumed;
    }
    return resolved;
  }

  /** Build immutable host-owned metadata for strict block-relative rendered ranges. */
  private buildFeedbackCanonicalBlocks(
    blocks: readonly CanonicalFeedbackBlock[]
  ): Map<number, FeedbackCanonicalBlockState> {
    return new Map(
      blocks.map(block => [
        block.ordinal,
        {
          kind: block.kind,
          contentSize: block.contentSize,
          sha256: crypto.createHash('sha256').update(block.markdown, 'utf8').digest('hex'),
          ...(block.tableFingerprint === undefined
            ? {}
            : { tableFingerprint: block.tableFingerprint }),
        },
      ])
    );
  }

  /**
   * Bounds an untrusted rectangular cell selection to one frozen table block
   * and adds the host-owned hash used to validate draft restoration.
   */
  private enrichFeedbackCellTarget(
    session: ActiveFeedbackSession,
    target: { startOrdinal: number; endOrdinal: number },
    input: FeedbackCellTargetInputV1
  ): FeedbackCellTargetV1 {
    const tableBlock = session.canonicalBlocks.get(input.tableOrdinal);
    const rectangle = input.rectangle;
    if (
      input.version !== 1 ||
      target.startOrdinal !== target.endOrdinal ||
      input.tableOrdinal !== target.startOrdinal ||
      tableBlock?.kind !== 'table' ||
      tableBlock.tableFingerprint === undefined ||
      input.tableFingerprint !== tableBlock.tableFingerprint ||
      !Number.isSafeInteger(rectangle.top) ||
      !Number.isSafeInteger(rectangle.left) ||
      !Number.isSafeInteger(rectangle.bottom) ||
      !Number.isSafeInteger(rectangle.right) ||
      rectangle.top < 0 ||
      rectangle.left < 0 ||
      rectangle.bottom <= rectangle.top ||
      rectangle.right <= rectangle.left ||
      !isFeedbackCellRectangleWithinExactLimit(rectangle)
    ) {
      session.lastErrorCode = FEEDBACK_ERROR_CODES.targetDoesNotMap;
      throw Object.assign(
        new Error('The selected table cells do not map to the frozen Markdown table block.'),
        { code: FEEDBACK_ERROR_CODES.targetDoesNotMap }
      );
    }

    return {
      version: 1,
      tableOrdinal: input.tableOrdinal,
      rectangle: { ...rectangle },
      tableFingerprint: input.tableFingerprint,
      tableBlockSha256: tableBlock.sha256,
    };
  }

  /**
   * Bounds an untrusted rendered range against the frozen ProseMirror blocks
   * and adds hashes that the webview is never allowed to supply.
   */
  private enrichFeedbackRenderedRange(
    session: ActiveFeedbackSession,
    target: { startOrdinal: number; endOrdinal: number },
    input: FeedbackRenderedRangeInputV1
  ): FeedbackRenderedRangeV1 {
    const startBlock = session.canonicalBlocks.get(input.startOrdinal);
    const endBlock = session.canonicalBlocks.get(input.endOrdinal);
    if (
      input.version !== 1 ||
      input.startOrdinal !== target.startOrdinal ||
      input.endOrdinal !== target.endOrdinal ||
      startBlock === undefined ||
      endBlock === undefined ||
      input.startOffset < 0 ||
      input.startOffset >= startBlock.contentSize ||
      input.endOffset <= 0 ||
      input.endOffset > endBlock.contentSize ||
      input.startOrdinal > input.endOrdinal ||
      (input.startOrdinal === input.endOrdinal && input.startOffset >= input.endOffset)
    ) {
      session.lastErrorCode = FEEDBACK_ERROR_CODES.targetDoesNotMap;
      throw Object.assign(
        new Error('The exact rendered range does not map to the frozen Markdown blocks.'),
        { code: FEEDBACK_ERROR_CODES.targetDoesNotMap }
      );
    }

    return {
      version: 1,
      startOrdinal: input.startOrdinal,
      startOffset: input.startOffset,
      endOrdinal: input.endOrdinal,
      endOffset: input.endOffset,
      startBlockSha256: startBlock.sha256,
      endBlockSha256: endBlock.sha256,
    };
  }

  /**
   * Revalidate persisted machine metadata without searching visible Focus.
   * Structurally valid metadata that cannot resolve is a per-item degradation,
   * not a reason to discard an otherwise valid draft.
   */
  private validatePersistedFeedbackRenderedRange(
    session: ActiveFeedbackSession,
    target: { startOrdinal: number; endOrdinal: number },
    persisted: FeedbackRenderedRangeV1
  ): boolean {
    let expected: FeedbackRenderedRangeV1;
    try {
      expected = this.enrichFeedbackRenderedRange(session, target, persisted);
    } catch {
      session.lastErrorCode = FEEDBACK_ERROR_CODES.targetDoesNotMap;
      return false;
    }
    if (
      expected.startBlockSha256 !== persisted.startBlockSha256 ||
      expected.endBlockSha256 !== persisted.endBlockSha256
    ) {
      session.lastErrorCode = FEEDBACK_ERROR_CODES.targetDoesNotMap;
      return false;
    }
    return true;
  }

  /** Revalidate the host-owned containing-table identity for a persisted locator. */
  private validatePersistedFeedbackCellTarget(
    session: ActiveFeedbackSession,
    target: { startOrdinal: number; endOrdinal: number },
    persisted: FeedbackCellTargetV1
  ): boolean {
    let expected: FeedbackCellTargetV1;
    try {
      expected = this.enrichFeedbackCellTarget(session, target, persisted);
    } catch {
      session.lastErrorCode = FEEDBACK_ERROR_CODES.targetDoesNotMap;
      return false;
    }
    if (expected.tableBlockSha256 !== persisted.tableBlockSha256) {
      session.lastErrorCode = FEEDBACK_ERROR_CODES.targetDoesNotMap;
      return false;
    }
    return true;
  }

  /**
   * Revalidates every persisted exact locator against the frozen host snapshot
   * at the final mutation boundary. Renderer resolution is useful evidence,
   * but only the extension host can verify canonical block hashes and bounds.
   */
  private revalidateFeedbackLocatorsForSeal(session: ActiveFeedbackSession): void {
    let retainedExactCellCount = 0;
    for (const item of session.store.items) {
      if (item.kind !== 'text') continue;
      const renderedRange =
        'target' in item && item.target.resolution === 'exact'
          ? item.target.locator?.kind === 'rendered-range'
            ? item.target.locator.value
            : undefined
          : 'renderedRange' in item
            ? item.renderedRange
            : undefined;
      const cellTarget =
        'target' in item && item.target.resolution === 'exact'
          ? item.target.locator?.kind === 'table-cells'
            ? item.target.locator.value
            : undefined
          : 'cellTarget' in item
            ? item.cellTarget
            : undefined;
      if (renderedRange === undefined && cellTarget === undefined) continue;
      const target = findFeedbackOrdinalsForLines(session.anchorMap, item.startLine, item.endLine);
      if (!target) {
        session.lastErrorCode = FEEDBACK_ERROR_CODES.targetDoesNotMap;
        throw Object.assign(
          new Error(`Feedback item ${item.id} no longer maps to the frozen Markdown blocks.`),
          { code: FEEDBACK_ERROR_CODES.targetDoesNotMap }
        );
      }
      session.targets.set(item.id, target);
      if (
        renderedRange !== undefined &&
        !this.validatePersistedFeedbackRenderedRange(session, target, renderedRange)
      ) {
        session.degradedRenderedRangeIds.add(item.id);
      }
      if (cellTarget !== undefined) {
        const rectangle = cellTarget.rectangle;
        const exactCellCount =
          (rectangle.bottom - rectangle.top) * (rectangle.right - rectangle.left);
        const locatorValid = this.validatePersistedFeedbackCellTarget(session, target, cellTarget);
        if (
          !locatorValid ||
          session.degradedCellTargetIds.has(item.id) ||
          retainedExactCellCount + exactCellCount > FEEDBACK_MAX_EXACT_CELL_COUNT_PER_SESSION
        ) {
          session.degradedCellTargetIds.add(item.id);
        } else {
          retainedExactCellCount += exactCellCount;
        }
      }
    }
  }

  /**
   * Verifies that the saved source still matches a frozen snapshot hash.
   * This filesystem check remains authoritative when a VS Code change event
   * is delayed or never reaches the extension host.
   */
  private async assertFeedbackSourceSha256(
    document: vscode.TextDocument,
    expectedSha256: string
  ): Promise<void> {
    let sourceBytes: Buffer;
    try {
      sourceBytes = await readFile(document.uri.fsPath);
    } catch {
      throw new FeedbackSessionError(
        'MD4H-FB-SNAPSHOT-001',
        'The Markdown source could not be re-read. The feedback draft was preserved.'
      );
    }
    const sourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
    if (sourceSha256 !== expectedSha256) {
      throw new FeedbackSessionError(
        'MD4H-FB-SNAPSHOT-001',
        'The Markdown source changed outside the frozen feedback snapshot.'
      );
    }
  }

  /**
   * Returns a commit guard that re-reads the exact source before and after an
   * atomic report write. VS Code change events improve responsiveness, but the
   * filesystem hash remains authoritative across external tools and races.
   */
  private feedbackCommitGuard(
    session: ActiveFeedbackSession,
    document: vscode.TextDocument
  ): () => Promise<void> {
    return async () => {
      if (session.invalidated) {
        throw new FeedbackSessionError(
          'MD4H-FB-SNAPSHOT-001',
          'The Markdown source changed during the feedback write. The draft was preserved.'
        );
      }
      await this.assertFeedbackSourceSha256(document, session.store.snapshot.sourceSha256);
    };
  }

  /** Track a complete host mutation through its correlated UI response. */
  private beginFeedbackMutation(session: ActiveFeedbackSession): void {
    session.pendingMutationCount += 1;
  }

  /** Release waiters only after the mutation response has been posted. */
  private endFeedbackMutation(session: ActiveFeedbackSession): void {
    session.pendingMutationCount = Math.max(0, session.pendingMutationCount - 1);
    if (session.pendingMutationCount !== 0) return;
    session.mutationIdleWaiters.forEach(resolve => resolve());
    session.mutationIdleWaiters.clear();
  }

  /** Wait until every mutation accepted before Finish or Discard has settled. */
  private async waitForFeedbackMutations(session: ActiveFeedbackSession): Promise<void> {
    if (session.pendingMutationCount === 0) return;
    await new Promise<void>(resolve => session.mutationIdleWaiters.add(resolve));
  }

  private async handleFeedbackWebviewMessage(
    message: FeedbackWebviewMessage,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    let trackedMutationSession: ActiveFeedbackSession | undefined;
    let releaseMutationPlanning: (() => void) | undefined;
    let requestSession: ActiveFeedbackSession | undefined;
    let closeOperation:
      | {
          session: ActiveFeedbackSession;
          promise: Promise<void>;
          resolve: () => void;
        }
      | undefined;
    try {
      if (message.type === 'feedback.controller.ready') {
        this.handleFeedbackControllerReady(message, document, webview);
        return;
      }

      if (message.type === 'feedback.start' || message.type === 'feedback.start.new') {
        await this.runFeedbackEntryOperation(document.uri.toString(), () =>
          this.startFeedbackSession(message, document, webview)
        );
        return;
      }

      if (message.type === 'feedback.draft.resume') {
        await this.runFeedbackEntryOperation(document.uri.toString(), () =>
          this.resumeFeedbackSession(message, document, webview)
        );
        return;
      }

      if (message.type === 'feedback.draft.reveal') {
        this.assertNoActiveFeedbackOperation(document.uri.toString());
        const workspaceRoot = this.getWorkspaceFolderPath(document);
        if (!workspaceRoot || document.uri.scheme !== 'file') {
          throw new FeedbackSessionError(
            'MD4H-FB-STORE-001',
            'Open this saved Markdown file inside a workspace to reveal its feedback draft.'
          );
        }
        const store = await FeedbackSessionStore.resume({
          workspaceRoot,
          sourcePath: document.uri.fsPath,
          sourceBytes: await readFile(document.uri.fsPath),
          round: message.round,
        });
        await store.validateContainedPaths();
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(store.getRevealPath()));
        return;
      }

      if (message.type === 'feedback.draft.discard') {
        this.assertNoActiveFeedbackOperation(document.uri.toString());
        await this.discardInactiveFeedbackDraft(message, document, webview);
        return;
      }

      if (message.type === 'feedback.peer.lock.acquired') {
        const pending = this.pendingFeedbackPeerLockAcquisitions.get(webview);
        if (
          !pending ||
          pending.acquisitionId !== message.acquisitionId ||
          pending.requestId !== message.requestId ||
          pending.lockId !== message.lockId ||
          pending.replacesLockId !== message.replacesLockId ||
          pending.viewGeneration !== message.viewGeneration ||
          pending.revision !== message.revision ||
          this.editViewGenerations.get(webview) !== message.viewGeneration
        ) {
          return;
        }
        this.acknowledgeFeedbackCriticalStage(
          webview,
          pending.type,
          pending.acquisitionId,
          pending.lockId,
          pending.revision,
          true
        );
        // The transport may have already exhausted its bounded attempts. The
        // exact pending semantic identity still makes a late ACK authoritative.
        this.appliedFeedbackPeerLocks.set(webview, {
          viewGeneration: pending.viewGeneration,
          lockId: pending.lockId,
        });
        this.pendingFeedbackPeerLockAcquisitions.delete(webview);
        return;
      }

      // Peer release ACKs are correlated outside the owner-session union.
      if (message.type === 'feedback.peer.released') {
        this.acceptFeedbackPeerRelease(message, document, webview);
        return;
      }

      if (message.type === 'feedback.session.transfer.ack') {
        this.acceptFeedbackSessionTransferAcknowledgement(message, document, webview);
        return;
      }

      if (
        message.type === 'feedback.transition.applied' ||
        message.type === 'feedback.transition.retry'
      ) {
        const documentKey = document.uri.toString();
        const acknowledgement = this.acknowledgeFeedbackCriticalStage(
          webview,
          'feedback.transition.sync',
          message.requestId,
          message.lockId,
          message.revision,
          message.type === 'feedback.transition.applied'
        );
        const transition = this.feedbackTransitions.get(documentKey);
        if (!transition && acknowledgement === 'duplicate') return;
        if (
          !transition ||
          transition.ownerWebview !== webview ||
          transition.requestId !== message.requestId ||
          transition.lockId !== message.lockId ||
          transition.recoveryRevision !== message.revision ||
          transition.recoveryContentSha256 === undefined
        ) {
          throw new FeedbackSessionError(
            'MD4H-FB-STORE-001',
            'This feedback transition recovery is stale or premature.'
          );
        }

        const currentContent = this.feedbackCloseSyncContent(document);
        const currentSha256 = crypto
          .createHash('sha256')
          .update(currentContent, 'utf8')
          .digest('hex');
        if (message.type === 'feedback.transition.retry') {
          const contentChanged = currentSha256 !== transition.recoveryContentSha256;
          if (!contentChanged && this.feedbackDeliveryCapableWebviews.has(webview)) {
            // The semantic revision is unchanged, but this is a new bounded
            // delivery cycle requested by the renderer after a failed apply.
            this.resetFeedbackCriticalTransport(webview);
          }
          this.postFeedbackTransitionSync(document, transition, currentContent, contentChanged);
          return;
        }
        await this.acquireFeedbackPeerLocks(
          documentKey,
          transition.ownerWebview,
          transition.requestId,
          transition.lockId
        );
        if (this.feedbackTransitions.get(documentKey) !== transition) return;
        const releaseContent = this.feedbackCloseSyncContent(document);
        const releaseSha256 = crypto
          .createHash('sha256')
          .update(releaseContent, 'utf8')
          .digest('hex');
        if (releaseSha256 !== transition.recoveryContentSha256) {
          this.postFeedbackTransitionSync(document, transition, releaseContent);
          return;
        }

        transition.deliveryAbortController?.abort();
        this.beginFeedbackPeerRelease(
          'transition',
          document,
          transition.requestId,
          transition.lockId,
          transition.recoveryRevision
        );
        return;
      }

      let criticalCloseAcknowledgement: FeedbackAcknowledgementDisposition = 'ignored';
      if (message.type === 'feedback.close.ready') {
        const currentSession = this.feedbackSessions.get(document.uri.toString());
        const terminalTypes: Array<'feedback.finished' | 'feedback.discarded'> =
          currentSession?.pendingClose?.requestId === message.requestId &&
          currentSession.sessionId === message.sessionId
            ? [currentSession.pendingClose.terminalType]
            : ['feedback.finished', 'feedback.discarded'];
        for (const terminalType of terminalTypes) {
          const disposition = this.acknowledgeFeedbackCriticalStage(
            webview,
            terminalType,
            message.requestId,
            message.sessionId,
            1,
            true
          );
          if (disposition !== 'ignored') criticalCloseAcknowledgement = disposition;
        }
      } else if (
        message.type === 'feedback.close.applied' ||
        message.type === 'feedback.close.retry'
      ) {
        criticalCloseAcknowledgement = this.acknowledgeFeedbackCriticalStage(
          webview,
          'feedback.close.sync',
          message.requestId,
          message.sessionId,
          message.revision,
          message.type === 'feedback.close.applied'
        );
      } else if (message.type === 'feedback.close.released') {
        criticalCloseAcknowledgement = this.acknowledgeFeedbackCriticalStage(
          webview,
          'feedback.close.release',
          message.requestId,
          message.sessionId,
          message.revision,
          true
        );
      }
      if (
        criticalCloseAcknowledgement === 'duplicate' &&
        !this.feedbackSessions.has(document.uri.toString())
      ) {
        return;
      }

      const session = this.requireFeedbackSession(message, document, webview);
      requestSession = session;
      if (message.type === 'feedback.close.retry') {
        if (
          session.pendingClose?.requestId !== message.requestId ||
          session.pendingClose.revision !== message.revision ||
          session.pendingClose.contentSha256 === undefined ||
          session.pendingClose.releaseRevision !== undefined ||
          (session.phase !== 'finishing' && session.phase !== 'discarding')
        ) {
          throw new FeedbackSessionError(
            'MD4H-FB-STORE-001',
            'This feedback close retry is stale or premature.'
          );
        }
        // A failed TipTap replacement is not an acknowledgement. Send a new
        // monotonic revision so delayed messages from the failed attempt can
        // never complete the close handshake.
        this.postFeedbackCloseSync(document, session, webview);
        return;
      }
      if (message.type === 'feedback.close.ready') {
        if (
          session.pendingClose?.requestId === message.requestId &&
          session.pendingClose.revision > 0 &&
          (session.phase === 'finishing' || session.phase === 'discarding')
        ) {
          return;
        }
        if (
          session.pendingClose?.requestId !== message.requestId ||
          session.pendingClose.revision !== 0 ||
          (session.phase !== 'finishing' && session.phase !== 'discarding')
        ) {
          throw new FeedbackSessionError(
            'MD4H-FB-STORE-001',
            'This feedback close readiness message is stale or premature.'
          );
        }
        // Keep the owner and every sibling split locked while sending the
        // current TextDocument content. The webview removes its transaction
        // filter only for the synchronous content replacement.
        this.postFeedbackCloseSync(document, session, webview);
        return;
      }
      if (message.type === 'feedback.close.applied') {
        if (
          session.pendingClose?.requestId === message.requestId &&
          session.pendingClose.revision === message.revision &&
          session.pendingClose.releaseRevision === message.revision &&
          (session.phase === 'finishing' || session.phase === 'discarding')
        ) {
          return;
        }
        if (
          session.pendingClose?.requestId !== message.requestId ||
          session.pendingClose.revision !== message.revision ||
          session.pendingClose.contentSha256 === undefined ||
          session.pendingClose.releaseRevision !== undefined ||
          (session.phase !== 'finishing' && session.phase !== 'discarding')
        ) {
          throw new FeedbackSessionError(
            'MD4H-FB-STORE-001',
            'This feedback close completion is stale or premature.'
          );
        }

        const currentContent = this.feedbackCloseSyncContent(document);
        const currentSha256 = crypto
          .createHash('sha256')
          .update(currentContent, 'utf8')
          .digest('hex');
        if (currentSha256 !== session.pendingClose.contentSha256) {
          this.postFeedbackCloseSync(document, session, webview, currentContent);
          return;
        }

        session.pendingClose.releaseRevision = session.pendingClose.revision;
        const releaseMessage: Extract<
          FeedbackCriticalHostMessage,
          { type: 'feedback.close.release' }
        > = {
          type: 'feedback.close.release',
          requestId: message.requestId,
          sessionId: session.sessionId,
          revision: session.pendingClose.revision,
        };
        session.pendingClose.deliveryAbortController = this.postFeedbackCriticalStage(
          webview,
          releaseMessage,
          session.sessionId,
          session.pendingClose.revision,
          session.pendingClose.deliveryAbortController
        );
        return;
      }
      if (message.type === 'feedback.close.released') {
        if (
          session.pendingClose?.requestId !== message.requestId ||
          session.pendingClose.releaseRevision !== message.revision ||
          session.pendingClose.contentSha256 === undefined ||
          (session.phase !== 'finishing' && session.phase !== 'discarding')
        ) {
          throw new FeedbackSessionError(
            'MD4H-FB-STORE-001',
            'This feedback close release is stale or premature.'
          );
        }

        await this.acquireFeedbackPeerLocks(
          document.uri.toString(),
          session.ownerWebview,
          session.pendingClose.requestId,
          session.sessionId
        );
        if (this.feedbackSessions.get(document.uri.toString()) !== session) return;
        const currentContent = this.feedbackCloseSyncContent(document);
        const currentSha256 = crypto
          .createHash('sha256')
          .update(currentContent, 'utf8')
          .digest('hex');
        if (currentSha256 !== session.pendingClose.contentSha256) {
          session.pendingClose.releaseRevision = undefined;
          this.postFeedbackCloseSync(document, session, webview, currentContent);
          return;
        }

        session.pendingClose.deliveryAbortController?.abort();
        this.beginFeedbackPeerRelease(
          'session',
          document,
          session.pendingClose.requestId,
          session.sessionId,
          session.pendingClose.releaseRevision
        );
        return;
      }
      if (session.phase !== 'active' || session.closeOperation !== undefined) {
        const closeState = session.phase === 'active' ? 'closing' : session.phase;
        throw new FeedbackSessionError(
          'MD4H-FB-STORE-001',
          `This feedback session is already ${closeState}. Wait for that operation to finish.`
        );
      }
      if (
        session.invalidated &&
        message.type !== 'feedback.reveal' &&
        message.type !== 'feedback.discard' &&
        message.type !== 'feedback.copyDiagnostics' &&
        message.type !== 'feedback.capture.error'
      ) {
        throw new FeedbackSessionError(
          'MD4H-FB-SNAPSHOT-001',
          'The source changed. The draft is preserved, but new feedback and finishing are disabled.'
        );
      }
      if (message.type === 'feedback.finish' || message.type === 'feedback.discard') {
        let resolveCloseOperation = (): void => undefined;
        const promise = new Promise<void>(resolve => {
          resolveCloseOperation = resolve;
        });
        // A rejected duplicate must never replace the reservation that reload recovery awaits.
        session.closeOperation = promise;
        closeOperation = { session, promise, resolve: resolveCloseOperation };
      }
      if (FEEDBACK_DURABLE_MUTATION_MESSAGES.has(message.type)) {
        this.beginFeedbackMutation(session);
        trackedMutationSession = session;
        const previousPlanning = session.mutationPlanningQueue;
        session.mutationPlanningQueue = new Promise<void>(resolve => {
          releaseMutationPlanning = resolve;
        });
        await previousPlanning;
      }

      switch (message.type) {
        case 'feedback.capture.error':
          session.lastErrorCode = message.code;
          return;

        case 'feedback.text.add': {
          const target = this.mapFeedbackTarget(session, message.startOrdinal, message.endOrdinal);
          const migrationItems = await this.feedbackMigrationItemsV2(session);
          const budgetItems = migrationItems ?? this.feedbackItemsV2(session);
          const resolved =
            'target' in message
              ? this.resolveFeedbackTextTargetV2(
                  session,
                  target,
                  message.target,
                  message.evidence,
                  budgetItems
                )
              : this.resolveLegacyFeedbackTextTargetV2(
                  session,
                  target,
                  {
                    focus: message.focus,
                    feedback: message.feedback,
                    ...(message.renderedRange === undefined
                      ? {}
                      : { renderedRange: message.renderedRange }),
                    ...(message.cellTarget === undefined ? {} : { cellTarget: message.cellTarget }),
                  },
                  budgetItems
                );
          const item = await session.store.addTextFeedbackV2(
            {
              startLine: target.startLine,
              endLine: target.endLine,
              feedback: message.feedback,
              target: resolved.target,
              evidence: resolved.evidence,
            },
            {
              beforeCommit: this.feedbackCommitGuard(session, document),
              ...(migrationItems === undefined ? {} : { migrationItems }),
            }
          );
          session.targets.set(item.id, {
            startOrdinal: target.startOrdinal,
            endOrdinal: target.endOrdinal,
          });
          this.postFeedbackMessage(webview, {
            type: 'feedback.updated',
            requestId: message.requestId,
            sessionId: session.sessionId,
            items: this.feedbackItems(session, webview),
          });
          return;
        }

        case 'feedback.screenshot.add': {
          const target = this.mapFeedbackTarget(session, message.startOrdinal, message.endOrdinal);
          const migrationItems = await this.feedbackMigrationItemsV2(session);
          const item = await session.store.addScreenshotFeedbackV2(
            {
              startLine: target.startLine,
              endLine: target.endLine,
              feedback: message.feedback,
              pngData: message.imageDataUrl,
              ...this.resolveFeedbackVisualTargetV2(session, target),
            },
            {
              beforeCommit: this.feedbackCommitGuard(session, document),
              ...(migrationItems === undefined ? {} : { migrationItems }),
            }
          );
          session.targets.set(item.id, {
            startOrdinal: target.startOrdinal,
            endOrdinal: target.endOrdinal,
          });
          session.previewRevisions.set(item.id, 1);
          this.postFeedbackMessage(webview, {
            type: 'feedback.updated',
            requestId: message.requestId,
            sessionId: session.sessionId,
            items: this.feedbackItems(session, webview),
          });
          return;
        }

        case 'feedback.screenshot.replace': {
          const target = this.mapFeedbackTarget(session, message.startOrdinal, message.endOrdinal);
          const migrationItems = await this.feedbackMigrationItemsV2(session);
          await session.store.replaceScreenshotFeedbackV2(
            message.id,
            {
              startLine: target.startLine,
              endLine: target.endLine,
              feedback: message.feedback,
              pngData: message.imageDataUrl,
              ...this.resolveFeedbackVisualTargetV2(session, target),
            },
            {
              beforeCommit: this.feedbackCommitGuard(session, document),
              ...(migrationItems === undefined ? {} : { migrationItems }),
            }
          );
          session.targets.set(message.id, {
            startOrdinal: target.startOrdinal,
            endOrdinal: target.endOrdinal,
          });
          session.previewRevisions.set(
            message.id,
            (session.previewRevisions.get(message.id) ?? 1) + 1
          );
          this.postFeedbackMessage(webview, {
            type: 'feedback.updated',
            requestId: message.requestId,
            sessionId: session.sessionId,
            items: this.feedbackItems(session, webview),
          });
          return;
        }

        case 'feedback.item.edit': {
          const migrationItems = await this.feedbackMigrationItemsV2(session);
          await session.store.updateFeedbackV2(message.id, message.feedback, {
            beforeCommit: this.feedbackCommitGuard(session, document),
            ...(migrationItems === undefined ? {} : { migrationItems }),
          });
          break;
        }
        case 'feedback.item.delete': {
          const migrationItems = await this.feedbackMigrationItemsV2(session);
          await session.store.deleteFeedbackV2(message.id, {
            beforeCommit: this.feedbackCommitGuard(session, document),
            ...(migrationItems === undefined ? {} : { migrationItems }),
          });
          break;
        }
        case 'feedback.item.restore':
          if (session.store.schemaVersion === 2) {
            await session.store.restoreFeedbackV2(message.id, {
              beforeCommit: this.feedbackCommitGuard(session, document),
            });
          } else {
            await session.store.restoreFeedback(
              message.id,
              this.feedbackCommitGuard(session, document)
            );
          }
          break;

        case 'feedback.finish': {
          try {
            session.phase = 'finishing';
            session.pendingClose = undefined;
            await this.waitForFeedbackMutations(session);
            this.revalidateFeedbackLocatorsForSeal(session);
            const bytes = await readFile(document.uri.fsPath);
            const locatorIds = new Set(
              session.store.items
                .filter(
                  item =>
                    item.kind === 'text' &&
                    ('target' in item
                      ? item.target.resolution === 'exact' && item.target.locator !== undefined
                      : item.renderedRange !== undefined || item.cellTarget !== undefined)
                )
                .map(item => item.id)
            );
            for (const id of message.degradedTargetIds ?? []) {
              if (!locatorIds.has(id)) {
                throw Object.assign(
                  new Error(
                    `Feedback item ${id} cannot be degraded because it has no exact locator.`
                  ),
                  { code: FEEDBACK_ERROR_CODES.targetDoesNotMap }
                );
              }
              const item = session.store.items.find(candidate => candidate.id === id);
              const locatorKind =
                item?.kind === 'text' && 'target' in item
                  ? item.target.resolution === 'exact'
                    ? item.target.locator?.kind
                    : undefined
                  : item?.kind === 'text' && item.renderedRange !== undefined
                    ? 'rendered-range'
                    : item?.kind === 'text' && item.cellTarget !== undefined
                      ? 'table-cells'
                      : undefined;
              if (locatorKind === 'rendered-range') session.degradedRenderedRangeIds.add(id);
              if (locatorKind === 'table-cells') session.degradedCellTargetIds.add(id);
            }
            const migrationItems = await this.feedbackMigrationItemsV2(session);
            const resolvedItemsV2 =
              migrationItems === undefined
                ? this.feedbackItemsResolvedForSealV2(session)
                : undefined;
            const result = await session.store.seal(bytes, new Date(), {
              beforeCommit: this.feedbackCommitGuard(session, document),
              ...(migrationItems === undefined ? {} : { migrationItems }),
              ...(resolvedItemsV2 === undefined ? {} : { resolvedItemsV2 }),
            });
            const configuredPromptTemplate = vscode.workspace
              .getConfiguration('markdownForHumans.feedback', document.uri)
              .get<unknown>('handoffPromptTemplate');
            const handoff = renderFeedbackHandoffPrompt(configuredPromptTemplate, {
              feedbackFile: result.feedbackFileRelativePath,
              source: result.source,
              sourceSha256: result.sourceSha256,
              itemCount: result.itemCount,
              round: result.round,
            });
            if (handoff.warning !== undefined) {
              const warningMessage =
                'The feedback handoff prompt template is invalid. ' + handoff.warning.message;
              try {
                void Promise.resolve(vscode.window.showWarningMessage(warningMessage)).catch(
                  warningError => {
                    console.error('[MD4H] Feedback template warning failed:', warningError);
                  }
                );
              } catch (warningError) {
                console.error('[MD4H] Feedback template warning failed:', warningError);
              }
            }
            let promptCopied = false;
            try {
              if (!vscode.env.clipboard) {
                throw new Error('Clipboard API is unavailable');
              }
              await vscode.env.clipboard.writeText(handoff.prompt);
              promptCopied = true;
            } catch (clipboardError) {
              console.error('[MD4H] Feedback clipboard write failed:', clipboardError);
            }
            session.pendingClose = {
              requestId: message.requestId,
              terminalType: 'feedback.finished',
              revision: 0,
            };
            const finishedMessage: Extract<
              FeedbackCriticalHostMessage,
              { type: 'feedback.finished' }
            > = {
              type: 'feedback.finished',
              requestId: message.requestId,
              sessionId: session.sessionId,
              feedbackFile: result.feedbackFileRelativePath,
              itemCount: result.itemCount,
              prompt: handoff.prompt,
              promptCopied,
            };
            session.pendingClose.deliveryAbortController = this.postFeedbackCriticalStage(
              webview,
              finishedMessage,
              session.sessionId,
              1
            );
            return;
          } catch (error) {
            if (this.feedbackSessions.get(document.uri.toString()) === session) {
              if (session.store.snapshot.state === 'draft') {
                session.phase = 'active';
              } else {
                // A sealed bundle must remain reserved if delivery fails. The
                // owner can close the panel to release peers without risking a
                // stale editable split.
                session.phase = 'finishing';
              }
            }
            throw error;
          }
        }

        case 'feedback.reveal':
          await session.store.validateContainedPaths();
          await vscode.commands.executeCommand(
            'vscode.open',
            vscode.Uri.file(session.store.getRevealPath())
          );
          return;

        case 'feedback.copyDiagnostics': {
          const version =
            (this.context.extension?.packageJSON as { version?: string } | undefined)?.version ??
            'unknown';
          const theme = vscode.window.activeColorTheme?.kind ?? 'unknown';
          const zoom = vscode.workspace
            .getConfiguration()
            .get<number>('markdownForHumans.zoom', 100);
          const diagnostics = [
            `code: ${session.lastErrorCode ?? 'none'}`,
            `extension: ${version}`,
            `platform: ${process.platform}-${process.arch}`,
            `theme: ${theme}`,
            `zoom: ${zoom}%`,
            `round: ${session.store.snapshot.round}`,
            `state: ${session.store.snapshot.state}`,
          ].join('\n');
          if (!vscode.env.clipboard) {
            throw new FeedbackSessionError('MD4H-FB-STORE-002', 'The clipboard is unavailable.');
          }
          await vscode.env.clipboard.writeText(diagnostics);
          this.postFeedbackMessage(webview, {
            type: 'feedback.diagnosticsCopied',
            requestId: message.requestId,
            sessionId: session.sessionId,
          });
          return;
        }

        case 'feedback.discard': {
          try {
            session.phase = 'discarding';
            session.pendingClose = undefined;
            await this.waitForFeedbackMutations(session);
            await session.store.validateContainedPaths();
            const itemCount = session.store.items.length;
            const itemLabel = `${itemCount} saved feedback ${itemCount === 1 ? 'item' : 'items'}`;
            const choice = await vscode.window.showWarningMessage(
              'Discard this Feedback draft?',
              {
                modal: true,
                detail: `This draft contains ${itemLabel}. Its bundle will be moved to Trash, and Feedback mode will end.`,
              },
              'Discard draft'
            );
            if (choice !== 'Discard draft') {
              session.phase = 'active';
              return;
            }
            if (!vscode.workspace.fs) {
              throw new FeedbackSessionError(
                'MD4H-FB-STORE-002',
                'The workspace filesystem is unavailable.'
              );
            }
            if (this.feedbackSessions.get(document.uri.toString()) !== session) {
              throw new FeedbackSessionError(
                'MD4H-FB-STORE-001',
                'This feedback session is no longer active.'
              );
            }
            await session.store.validateContainedPaths();
            await vscode.workspace.fs.delete(vscode.Uri.file(session.store.getDiscardPath()), {
              recursive: true,
              useTrash: true,
            });
            session.store.finalizeDiscard();
            session.pendingClose = {
              requestId: message.requestId,
              terminalType: 'feedback.discarded',
              revision: 0,
            };
            const discardedMessage: Extract<
              FeedbackCriticalHostMessage,
              { type: 'feedback.discarded' }
            > = {
              type: 'feedback.discarded',
              requestId: message.requestId,
              sessionId: session.sessionId,
            };
            session.pendingClose.deliveryAbortController = this.postFeedbackCriticalStage(
              webview,
              discardedMessage,
              session.sessionId,
              1
            );
            return;
          } catch (error) {
            if (
              this.feedbackSessions.get(document.uri.toString()) === session &&
              session.store.snapshot.state === 'draft'
            ) {
              session.phase = 'active';
            }
            throw error;
          }
        }

        default:
          break;
      }

      this.postFeedbackMessage(webview, {
        type: 'feedback.updated',
        requestId: message.requestId,
        sessionId: session.sessionId,
        items: this.feedbackItems(session, webview),
      });
    } catch (error) {
      const candidateCode =
        error instanceof FeedbackSessionError
          ? error.code
          : error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : undefined;
      const code = isFeedbackHostErrorCode(candidateCode) ? candidateCode : undefined;
      const active =
        requestSession && this.feedbackSessions.get(document.uri.toString()) === requestSession
          ? requestSession
          : undefined;
      if (active && code) active.lastErrorCode = code;
      if (active && code === FEEDBACK_ERROR_CODES.sourceChanged && !active.invalidated) {
        active.invalidated = true;
        this.postFeedbackMessage(active.ownerWebview, {
          type: 'feedback.invalidated',
          sessionId: active.sessionId,
          code: FEEDBACK_ERROR_CODES.sourceChanged,
          message: 'The Markdown source changed outside the frozen feedback snapshot.',
        });
      }
      this.postFeedbackMessage(webview, {
        type: 'feedback.error',
        requestId: message.requestId,
        ...(requestSession ? { sessionId: requestSession.sessionId } : {}),
        ...(code ? { code } : {}),
        message: error instanceof Error ? error.message : 'The feedback request failed.',
        recoverable: true,
      });
    } finally {
      releaseMutationPlanning?.();
      if (trackedMutationSession) {
        this.endFeedbackMutation(trackedMutationSession);
      }
      if (closeOperation) {
        closeOperation.resolve();
        if (closeOperation.session.closeOperation === closeOperation.promise) {
          closeOperation.session.closeOperation = undefined;
        }
      }
    }
  }

  /**
   * Serialize Feedback entry points without swallowing their structured errors.
   * A second Start waits for the first one to either activate a session or
   * finish recovery, then observes that authoritative state instead of racing
   * into the generic "already active" guard.
   */
  private async runFeedbackEntryOperation(
    documentKey: string,
    operation: () => Promise<void>
  ): Promise<void> {
    const previous = this.feedbackEntryOperations.get(documentKey);
    const current = previous ? previous.catch(() => undefined).then(operation) : operation();
    this.feedbackEntryOperations.set(documentKey, current);
    try {
      await current;
    } finally {
      if (this.feedbackEntryOperations.get(documentKey) === current) {
        this.feedbackEntryOperations.delete(documentKey);
      }
    }
  }

  /**
   * Retire state that a same-view controller can no longer complete. Durable
   * drafts remain untouched and are discovered again from exact source bytes.
   */
  private async prepareFeedbackStartRetry(
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const documentKey = document.uri.toString();
    if (this.hasPendingDocumentEdits(documentKey)) {
      await this.drainDocumentEdits(document);
    }

    let released = false;
    const session = this.feedbackSessions.get(documentKey);
    if (session?.ownerWebview === webview && session.invalidated) {
      await this.retireFeedbackSessionThroughPeerRelease(
        documentKey,
        session,
        document,
        `feedback-start-retry-${session.sessionId}`,
        false
      );
      released = this.feedbackSessions.get(documentKey) !== session;
    }

    const transition = this.feedbackTransitions.get(documentKey);
    if (transition?.ownerWebview === webview) {
      await this.retireFeedbackTransitionThroughPeerRelease(
        documentKey,
        transition,
        document,
        !transition.ownerLockPosted
      );
      released = released || this.feedbackTransitions.get(documentKey) !== transition;
    }

    if (released) {
      this.feedbackActiveResumeOffers.delete(webview);
    }
  }

  private async startFeedbackSession(
    message: Extract<FeedbackWebviewMessage, { type: 'feedback.start' | 'feedback.start.new' }>,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const documentKey = document.uri.toString();
    const retrySession = this.feedbackSessions.get(documentKey);
    const retryTransition = this.feedbackTransitions.get(documentKey);
    if (
      this.hasPendingDocumentEdits(documentKey) ||
      (retrySession?.ownerWebview === webview && retrySession.invalidated) ||
      retryTransition?.ownerWebview === webview
    ) {
      await this.prepareFeedbackStartRetry(document, webview);
    }
    const orphanRetirement = this.retireOrphanedFeedbackStateForStart(
      document,
      webview,
      message.requestId
    );
    if (orphanRetirement) await orphanRetirement;
    if (
      message.type === 'feedback.start' &&
      this.offerActiveFeedbackResume(message, document, webview)
    ) {
      return;
    }
    const transitionToken = this.beginFeedbackTransition(documentKey, webview, message.requestId);
    const transitionLockId = this.feedbackTransitions.get(documentKey)?.lockId;
    if (!transitionLockId) throw new Error('Feedback transition lock was not created.');
    try {
      const workspaceRoot = this.getWorkspaceFolderPath(document);
      if (!workspaceRoot) {
        throw new FeedbackSessionError(
          'MD4H-FB-STORE-001',
          'Open this saved Markdown file inside a workspace before starting feedback.'
        );
      }

      const flushedSnapshot = await this.flushFeedbackSnapshot(document, webview, async () => {
        await this.acquireFeedbackPeerLocks(
          documentKey,
          webview,
          message.requestId,
          transitionLockId
        );
      });
      const { sourceBytes } = flushedSnapshot;
      const transition = this.assertFeedbackTransition(documentKey, transitionToken);
      this.postFeedbackTransitionOwnerLock(transition);
      this.lockFeedbackTransition(documentKey, transitionToken);
      if (message.type === 'feedback.start') {
        const drafts = await this.findFeedbackDraftSummaries(
          workspaceRoot,
          document.uri.fsPath,
          sourceBytes
        );
        this.assertFeedbackTransition(documentKey, transitionToken);
        if (drafts.length > 0) {
          this.postFeedbackMessage(webview, {
            type: 'feedback.resume.available',
            requestId: message.requestId,
            kind: 'saved-draft',
            drafts,
          });
          return;
        }
      }
      let anchorMap: FeedbackAnchorMap;
      let canonicalBlocks: readonly CanonicalFeedbackBlock[] | undefined = message.blocks;
      if (this.feedbackSnapshotCapableWebviews.has(webview)) {
        const finalized = await this.finalizeFeedbackRendererSnapshot(
          document,
          webview,
          flushedSnapshot.source
        );
        anchorMap = finalized.anchorMap;
        canonicalBlocks = finalized.blocks;
      } else {
        if (!message.blocks) {
          throw new FeedbackSessionError(
            'MD4H-FB-SNAPSHOT-001',
            'Reload the rich editor before starting Feedback so the saved snapshot can be verified.'
          );
        }
        const anchorResult = buildFeedbackAnchorMap(sourceBytes.toString('utf8'), message.blocks);
        if (!anchorResult.ok) {
          throw Object.assign(new Error(anchorResult.error.detail), {
            code: anchorResult.error.code,
          });
        }
        anchorMap = anchorResult.map;
      }
      if (!canonicalBlocks) {
        throw new FeedbackSessionError(
          'MD4H-FB-SNAPSHOT-001',
          'The rich editor did not provide canonical blocks for the saved snapshot.'
        );
      }
      const store = await FeedbackSessionStore.create({
        workspaceRoot,
        sourcePath: document.uri.fsPath,
        sourceBytes,
        schemaVersion: 2,
      });
      this.assertFeedbackTransition(documentKey, transitionToken);
      await this.assertFeedbackSourceSha256(document, store.snapshot.sourceSha256);
      this.assertFeedbackTransition(documentKey, transitionToken);
      const session: ActiveFeedbackSession = {
        ownerWebview: webview,
        sessionId: crypto.randomBytes(16).toString('hex'),
        store,
        sourceBytes: Buffer.from(sourceBytes),
        sourceIndex: createFeedbackSourceIndex(sourceBytes),
        anchorMap,
        canonicalBlocks: this.buildFeedbackCanonicalBlocks(canonicalBlocks),
        targets: new Map(),
        previewNonce: crypto.randomBytes(8).toString('hex'),
        previewRevisions: new Map(),
        degradedRenderedRangeIds: new Set(),
        degradedCellTargetIds: new Set(),
        phase: 'active',
        pendingMutationCount: 0,
        mutationPlanningQueue: Promise.resolve(),
        mutationIdleWaiters: new Set(),
        invalidated: false,
      };
      transition.recoveryRequired = false;
      await this.acquireFeedbackPeerLocks(
        documentKey,
        webview,
        message.requestId,
        session.sessionId
      );
      this.assertFeedbackTransition(documentKey, transitionToken);
      this.feedbackSessions.set(documentKey, session);
      // Activate the owner before retiring its transition token. Otherwise a
      // queued transition unlock can briefly make the rich view editable.
      this.postFeedbackSessionStarted(message.requestId, workspaceRoot, session, document, webview);
      this.refreshFeedbackPeerLocks(documentKey);
    } finally {
      await this.endFeedbackTransition(documentKey, transitionToken, document);
    }
  }

  /** Reclaim an absent owner through the authoritative peer-release barrier before Start. */
  private retireOrphanedFeedbackStateForStart(
    document: vscode.TextDocument,
    incomingWebview: vscode.Webview,
    requestId: string
  ): Promise<void> | null {
    const documentKey = document.uri.toString();
    if (
      this.hasPendingDocumentEdits(documentKey) ||
      this.pendingFeedbackSessionTransfers.has(documentKey) ||
      this.pendingFeedbackPeerReleases.has(documentKey)
    ) {
      return null;
    }
    const registered = this.feedbackWebviews.get(documentKey);
    const ownerIsAvailable = (owner: vscode.Webview): boolean =>
      owner === incomingWebview || registered?.has(owner) === true;
    const candidateSession = this.feedbackSessions.get(documentKey);
    const session =
      candidateSession && !ownerIsAvailable(candidateSession.ownerWebview)
        ? candidateSession
        : undefined;
    const candidateTransition = this.feedbackTransitions.get(documentKey);
    const transition =
      candidateTransition && !ownerIsAvailable(candidateTransition.ownerWebview)
        ? candidateTransition
        : undefined;
    if (!session && !transition) return null;
    return (async () => {
      if (session) {
        session.ownerDisposed = true;
        await this.retireFeedbackSessionThroughPeerRelease(
          documentKey,
          session,
          document,
          `feedback-orphan-${requestId}`,
          false
        );
      }
      if (transition) {
        transition.ownerDisposed = true;
        await this.retireFeedbackTransitionThroughPeerRelease(
          documentKey,
          transition,
          document,
          false
        );
      }
    })();
  }

  /**
   * Convert a repeated Start from a desynchronized rich view into an explicit
   * Resume choice. Start alone never changes the existing owner or runtime token.
   */
  private offerActiveFeedbackResume(
    message: { requestId: string },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): boolean {
    const session = this.feedbackSessions.get(document.uri.toString());
    if (!session || session.phase !== 'active' || session.invalidated) return false;
    const workspaceRoot = this.getWorkspaceFolderPath(document);
    if (!workspaceRoot) return false;
    const snapshot = session.store.snapshot;
    this.feedbackActiveResumeOffers.set(webview, {
      documentKey: document.uri.toString(),
      round: snapshot.round,
      sessionId: session.sessionId,
    });
    this.postFeedbackMessage(webview, {
      type: 'feedback.resume.available',
      requestId: message.requestId,
      kind: session.ownerWebview === webview ? 'active-owner' : 'active-peer',
      drafts: [
        {
          round: snapshot.round,
          createdAt: snapshot.createdAt,
          itemCount: session.store.items.length,
          feedbackFile: path
            .relative(workspaceRoot, session.store.feedbackFilePath)
            .split(path.sep)
            .join('/'),
        },
      ],
    });
    return true;
  }

  private beginFeedbackTransition(
    documentKey: string,
    webview: vscode.Webview,
    requestId: string
  ): symbol {
    this.reclaimOrphanedFeedbackState(documentKey, webview);
    if (
      this.feedbackSessions.has(documentKey) ||
      this.feedbackTransitions.has(documentKey) ||
      this.pendingFeedbackPeerReleases.has(documentKey) ||
      this.pendingFeedbackSessionTransfers.has(documentKey)
    ) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-001',
        'Feedback state changed while Start was being prepared. Select Start feedback again to Resume or recover the draft.'
      );
    }
    const token = Symbol('feedback-transition');
    const transition: FeedbackTransition = {
      token,
      lockId: crypto.randomBytes(16).toString('hex'),
      requestId,
      ownerWebview: webview,
      acceptingFlushEdit: true,
      invalidated: false,
      recoveryRequired: false,
      recoveryRevision: 0,
      ownerLockPosted: false,
    };
    this.feedbackTransitions.set(documentKey, transition);
    this.feedbackPeerLockIds.set(documentKey, transition.lockId);
    return token;
  }

  /** Bind the initiating view to the host transition after all debounces drain. */
  private postFeedbackTransitionOwnerLock(transition: FeedbackTransition): void {
    transition.ownerLockPosted = true;
    this.postFeedbackMessage(transition.ownerWebview, {
      type: 'feedback.transition.locked',
      requestId: transition.requestId,
      lockId: transition.lockId,
    });
  }

  /** Prepare a recreated owner for automatic host-authoritative restoration. */
  private recoverFeedbackControllerOnReady(
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): boolean {
    const documentKey = document.uri.toString();
    // A recreated finalizing owner has no review controller state to restore.
    // Treat that generation as a peer: strict acquisition applies its lock,
    // then the pending authoritative release initializes and unlocks it.
    if (this.pendingFeedbackPeerReleases.get(documentKey)?.phase === 'applying') return false;
    const pendingTransfer = this.pendingFeedbackSessionTransfers.get(documentKey);
    const viewGeneration = this.editViewGenerations.get(webview);
    const recoveringOldOwner =
      pendingTransfer?.oldOwner === webview &&
      this.feedbackSessions.get(documentKey) === pendingTransfer.oldSession;
    const recoveringNewOwner =
      pendingTransfer?.phase === 'committing' && pendingTransfer.newOwner === webview;
    if (pendingTransfer && viewGeneration && (recoveringOldOwner || recoveringNewOwner)) {
      const recoveryLockId = recoveringNewOwner
        ? pendingTransfer.nextSession.sessionId
        : pendingTransfer.oldSession.sessionId;
      this.postFeedbackMessage(webview, {
        type: 'feedback.peer.locked',
        lockId: recoveryLockId,
        message: 'Restoring Feedback after the rich view reloaded. This view is read-only.',
      });
      this.updateWebview(document, webview, { force: true });
      const recoveryField = recoveringNewOwner
        ? 'newOwnerRecoveryGeneration'
        : 'oldOwnerRecoveryGeneration';
      if (pendingTransfer[recoveryField] !== viewGeneration) {
        pendingTransfer[recoveryField] = viewGeneration;
        void pendingTransfer.finalization.then(() => {
          if (
            this.editViewGenerations.get(webview) !== viewGeneration ||
            this.feedbackWebviews.get(documentKey)?.has(webview) !== true
          ) {
            return;
          }
          if (!this.recoverFeedbackControllerOnReady(document, webview)) {
            this.updateWebview(document, webview, { force: true });
            this.postCurrentFeedbackPeerLock(documentKey, webview);
          }
        });
      }
      return true;
    }
    const session = this.feedbackSessions.get(documentKey);
    const transition = this.feedbackTransitions.get(documentKey);
    const ownedSession = session?.ownerWebview === webview ? session : undefined;
    const ownedTransition = transition?.ownerWebview === webview ? transition : undefined;
    if (!ownedSession && !ownedTransition) return false;

    const canRestoreActiveSession =
      ownedSession !== undefined &&
      ownedSession.phase === 'active' &&
      !ownedSession.invalidated &&
      viewGeneration !== undefined &&
      this.feedbackDeliveryCapableWebviews.has(webview);
    if (canRestoreActiveSession) {
      this.pendingFeedbackControllerRestores.set(webview, {
        documentKey,
        sessionId: ownedSession.sessionId,
        viewGeneration,
      });
      this.postFeedbackMessage(webview, {
        type: 'feedback.peer.locked',
        lockId: ownedSession.sessionId,
        message: 'Restoring active Feedback. This view is temporarily read-only.',
      });
      // This payload initializes TipTap before it can create and announce the
      // replacement Feedback controller. The later acknowledged activation is
      // therefore causally ordered after authoritative Markdown application.
      this.updateWebview(document, webview, { force: true });
      return true;
    }

    const lockId = ownedSession?.sessionId ?? ownedTransition?.lockId;
    if (lockId) {
      this.postFeedbackMessage(webview, {
        type: 'feedback.peer.locked',
        lockId,
        message: 'Restoring the previous Feedback draft. This view is temporarily read-only.',
      });
    }
    void this.demoteFeedbackOwnerAfterReady(document, webview).catch(error => {
      console.error('[MD4H] Failed recovering Feedback after webview reload:', error);
      this.postFeedbackMessage(webview, {
        type: 'feedback.error',
        message: 'The previous Feedback draft could not be restored. Try Start feedback again.',
        recoverable: true,
      });
    });
    return true;
  }

  /** Accept only the first controller-ready request from the current generation. */
  private handleFeedbackControllerReady(
    message: Extract<FeedbackWebviewMessage, { type: 'feedback.controller.ready' }>,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): void {
    if (this.editViewGenerations.get(webview) !== message.viewGeneration) return;

    const acceptedReady = this.feedbackControllerReadyRequests.get(webview);
    if (
      acceptedReady &&
      (acceptedReady.viewGeneration !== message.viewGeneration ||
        acceptedReady.requestId !== message.requestId)
    ) {
      return;
    }
    if (!acceptedReady) {
      this.feedbackControllerReadyRequests.set(webview, {
        viewGeneration: message.viewGeneration,
        requestId: message.requestId,
      });
    }

    const pending = this.pendingFeedbackControllerRestores.get(webview);
    if (
      !pending ||
      pending.documentKey !== document.uri.toString() ||
      pending.viewGeneration !== message.viewGeneration ||
      pending.controllerRequestId !== undefined
    ) {
      return;
    }
    pending.controllerRequestId = message.requestId;
    void this.restoreActiveFeedbackController(message.requestId, pending, document, webview);
  }

  /** Revalidate the frozen source, then replay the exact active session by ACKed delivery. */
  private async restoreActiveFeedbackController(
    requestId: string,
    pending: PendingFeedbackControllerRestore,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const documentKey = document.uri.toString();
    const session = this.feedbackSessions.get(documentKey);
    try {
      if (
        !session ||
        session.ownerWebview !== webview ||
        session.sessionId !== pending.sessionId ||
        session.phase !== 'active'
      ) {
        throw new FeedbackSessionError(
          'MD4H-FB-STORE-001',
          'The active Feedback session changed while its renderer was being restored.'
        );
      }
      if (session.invalidated) {
        throw new FeedbackSessionError(
          'MD4H-FB-SNAPSHOT-001',
          'The Markdown source changed outside the frozen feedback snapshot.'
        );
      }

      await this.waitForFeedbackMutations(session);
      if (
        this.feedbackSessions.get(documentKey) !== session ||
        this.editViewGenerations.get(webview) !== pending.viewGeneration ||
        this.feedbackControllerReadyRequests.get(webview)?.requestId !== requestId
      ) {
        return;
      }

      const documentSha256 = crypto
        .createHash('sha256')
        .update(document.getText(), 'utf8')
        .digest('hex');
      if (documentSha256 !== session.store.snapshot.sourceSha256) {
        throw new FeedbackSessionError(
          'MD4H-FB-SNAPSHOT-001',
          'The Markdown source changed outside the frozen feedback snapshot.'
        );
      }
      await this.assertFeedbackSourceSha256(document, session.store.snapshot.sourceSha256);
      if (
        this.feedbackSessions.get(documentKey) !== session ||
        this.editViewGenerations.get(webview) !== pending.viewGeneration ||
        this.feedbackControllerReadyRequests.get(webview)?.requestId !== requestId
      ) {
        return;
      }

      const workspaceRoot = this.getWorkspaceFolderPath(document);
      if (!workspaceRoot || document.uri.scheme !== 'file') {
        throw new FeedbackSessionError(
          'MD4H-FB-STORE-001',
          'Open this saved Markdown file inside a workspace before restoring Feedback.'
        );
      }
      this.postFeedbackSessionStarted(requestId, workspaceRoot, session, document, webview);
      this.postDegradedFeedbackRangeWarning(session, webview);
    } catch (error) {
      const code =
        error instanceof FeedbackSessionError && isFeedbackHostErrorCode(error.code)
          ? error.code
          : 'MD4H-FB-STORE-002';
      this.demoteFeedbackSessionAfterRendererFailure(
        requestId,
        session,
        document,
        webview,
        code,
        error instanceof Error
          ? error.message
          : 'The active Feedback session could not be restored.'
      );
    }
  }

  /** Finish in-flight writes before releasing a controller that no longer exists. */
  private async demoteFeedbackOwnerAfterReady(
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const documentKey = document.uri.toString();
    const entryOperation = this.feedbackEntryOperations.get(documentKey);
    if (entryOperation) await entryOperation.catch(() => undefined);
    if (this.hasPendingDocumentEdits(documentKey)) {
      await this.drainDocumentEdits(document);
    }

    const session = this.feedbackSessions.get(documentKey);
    if (session?.ownerWebview === webview) {
      const closeOperation = session.closeOperation;
      if (closeOperation) await closeOperation.catch(() => undefined);
      await this.waitForFeedbackMutations(session);
    }
    if (this.feedbackWebviews.get(documentKey)?.has(webview) !== true) return;

    const latestSession = this.feedbackSessions.get(documentKey);
    const latestTransition = this.feedbackTransitions.get(documentKey);
    const stateMovedToPeer =
      (latestSession && latestSession.ownerWebview !== webview) ||
      (latestTransition && latestTransition.ownerWebview !== webview);
    if (stateMovedToPeer) {
      this.updateWebview(document, webview, { force: true });
      this.postCurrentFeedbackPeerLock(documentKey, webview);
      return;
    }

    if (latestSession?.ownerWebview === webview) {
      await this.retireFeedbackSessionThroughPeerRelease(
        documentKey,
        latestSession,
        document,
        `feedback-ready-demote-${latestSession.sessionId}`,
        true
      );
    } else if (latestTransition?.ownerWebview === webview) {
      await this.retireFeedbackTransitionThroughPeerRelease(
        documentKey,
        latestTransition,
        document,
        true
      );
    }
    this.feedbackActiveResumeOffers.delete(webview);
    await this.announceMatchingFeedbackDrafts(document, webview);
  }

  /** Track every split so Feedback ownership can be reflected in sibling UI. */
  private registerFeedbackWebview(documentKey: string, webview: vscode.Webview): void {
    this.reclaimOrphanedFeedbackState(documentKey, webview);
    let webviews = this.feedbackWebviews.get(documentKey);
    if (!webviews) {
      webviews = new Set();
      this.feedbackWebviews.set(documentKey, webviews);
    }
    webviews.add(webview);
    if (this.isFeedbackViewGenerationUnavailable(webview)) return;
    const pendingTransfer = this.pendingFeedbackSessionTransfers.get(documentKey);
    const transferTarget = pendingTransfer?.targets.get(webview);
    if (pendingTransfer && transferTarget) {
      const currentGeneration = this.getEditViewGeneration(webview);
      transferTarget.deliveryAbortController?.abort();
      transferTarget.deliveryAbortController = undefined;
      if (transferTarget.message.viewGeneration === currentGeneration) {
        const stageComplete =
          transferTarget.message.phase === 'apply'
            ? transferTarget.applied
            : transferTarget.message.phase === 'commit'
              ? transferTarget.committed
              : transferTarget.aborted;
        if (!stageComplete) {
          this.resetFeedbackCriticalTransport(webview);
          this.postFeedbackSessionTransferTarget(
            documentKey,
            pendingTransfer,
            webview,
            transferTarget
          );
        }
        return;
      }

      // A new script lifetime cannot contain state staged in the retired
      // generation. Before host commit, cancel the handoff and roll every
      // still-live participant back. During commit, the replacement renderer
      // is restored authoritatively after the remaining ACK barrier settles.
      transferTarget.rendererUnavailable = true;
      if (pendingTransfer.phase === 'committing') {
        transferTarget.committed = true;
      } else if (pendingTransfer.phase === 'aborting') {
        transferTarget.aborted = true;
      } else {
        transferTarget.aborted = true;
        this.beginFeedbackSessionTransferRollback(documentKey, pendingTransfer);
      }
      this.advanceFeedbackSessionTransfer(documentKey, pendingTransfer);
    }
    const pendingRelease = this.pendingFeedbackPeerReleases.get(documentKey);
    if (pendingRelease?.phase === 'committing') {
      const obsoleteTarget = pendingRelease.targets.get(webview);
      const currentGeneration = this.getEditViewGeneration(webview);
      if (obsoleteTarget?.message.viewGeneration === currentGeneration) {
        // Duplicate readiness in the same renderer lifetime cannot dispose its
        // still-installed lock. Reassert commit until its exact ACK arrives.
        if (!obsoleteTarget.committed) {
          this.postFeedbackPeerReleaseTarget(documentKey, pendingRelease, webview, obsoleteTarget);
        }
        return;
      }
      // A new renderer lifetime did not participate in the retired ownership
      // barrier and therefore has no old local lock to commit. Treat only the
      // previous generation as disposed and initialize this one normally.
      obsoleteTarget?.deliveryAbortController?.abort();
      if (obsoleteTarget) {
        pendingRelease.targets.delete(webview);
        this.appliedFeedbackPeerLocks.delete(webview);
        this.finalizeFeedbackPeerReleaseIfComplete(documentKey, pendingRelease);
      }
    } else if (pendingRelease) {
      const currentGeneration = this.getEditViewGeneration(webview);
      const existingTarget = pendingRelease.targets.get(webview);
      if (existingTarget?.message.viewGeneration === currentGeneration) {
        if (!existingTarget.applied) {
          this.postFeedbackPeerReleaseTarget(documentKey, pendingRelease, webview, existingTarget);
        }
        return;
      }
      existingTarget?.deliveryAbortController?.abort();
      const target = this.createFeedbackPeerReleaseTarget(pendingRelease, webview);
      pendingRelease.targets.set(webview, target);
      const current = this.currentFeedbackPeerLock(documentKey);
      const acquire = current
        ? this.acquireFeedbackPeerLockForWebview(
            documentKey,
            current.ownerWebview,
            webview,
            pendingRelease.requestId,
            pendingRelease.lockId,
            true
          )
        : Promise.reject(new Error('Feedback release ownership disappeared.'));
      void acquire
        .then(() => {
          if (this.isFeedbackViewGenerationUnavailable(webview)) {
            if (
              this.pendingFeedbackPeerReleases.get(documentKey) === pendingRelease &&
              pendingRelease.targets.get(webview) === target
            ) {
              pendingRelease.targets.delete(webview);
              this.finalizeFeedbackPeerReleaseIfComplete(documentKey, pendingRelease);
            }
            return;
          }
          if (
            this.pendingFeedbackPeerReleases.get(documentKey) === pendingRelease &&
            pendingRelease.targets.get(webview) === target &&
            this.editViewGenerations.get(webview) === target.message.viewGeneration
          ) {
            this.postFeedbackPeerReleaseTarget(documentKey, pendingRelease, webview, target);
          }
        })
        .catch(() => undefined);
      return;
    }
    this.postCurrentFeedbackPeerLock(documentKey, webview);
  }

  /**
   * Reclaim volatile ownership left behind by a panel whose disposal cleanup
   * did not complete. The draft bundle stays on disk and can be resumed; only
   * an owner absent from both the registered set and the incoming view is
   * considered orphaned.
   */
  private reclaimOrphanedFeedbackState(documentKey: string, incomingWebview: vscode.Webview): void {
    // Keep sibling views locked until a departing owner's accepted edit has
    // settled. A later Start retries reconciliation after the edit pipeline
    // removes this marker.
    if (
      this.hasPendingDocumentEdits(documentKey) ||
      this.pendingFeedbackSessionTransfers.has(documentKey)
    ) {
      return;
    }
    const registered = this.feedbackWebviews.get(documentKey);
    const ownerIsAvailable = (owner: vscode.Webview): boolean =>
      owner === incomingWebview || registered?.has(owner) === true;
    const session = this.feedbackSessions.get(documentKey);
    const transition = this.feedbackTransitions.get(documentKey);
    let reclaimed = false;

    if (session && !session.ownerDisposed && !ownerIsAvailable(session.ownerWebview)) {
      session.pendingClose?.deliveryAbortController?.abort();
      this.feedbackSessions.delete(documentKey);
      session.mutationIdleWaiters.forEach(resolve => resolve());
      session.mutationIdleWaiters.clear();
      reclaimed = true;
    }
    if (transition && !transition.ownerDisposed && !ownerIsAvailable(transition.ownerWebview)) {
      transition.deliveryAbortController?.abort();
      this.feedbackTransitions.delete(documentKey);
      reclaimed = true;
    }
    if (reclaimed) this.refreshFeedbackPeerLocks(documentKey);
  }

  /** Remove one disposed split without disturbing the document owner's session. */
  private unregisterFeedbackWebview(documentKey: string, webview: vscode.Webview): void {
    this.cancelFeedbackStatusQueries(webview, 'Feedback renderer disposed.');
    this.cancelFeedbackSnapshotReports(webview);
    this.feedbackStartedTransports.get(webview)?.dispose();
    this.feedbackStartedTransports.delete(webview);
    this.feedbackCriticalTransports.get(webview)?.dispose();
    this.feedbackCriticalTransports.delete(webview);
    this.feedbackDeliveryCapableWebviews.delete(webview);
    this.feedbackSnapshotCapableWebviews.delete(webview);
    this.pendingFeedbackControllerRestores.delete(webview);
    this.feedbackControllerReadyRequests.delete(webview);
    this.deferredReadyAfterDocumentEdits.delete(webview);
    this.pendingReadyDocumentEditDrains.delete(webview);
    this.retirePendingImageCompletionDeliveries(webview);
    this.pendingFeedbackPeerLockAcquisitions.delete(webview);
    this.inFlightFeedbackPeerLockAcquisitions.delete(webview);
    this.appliedFeedbackPeerLocks.delete(webview);
    this.unavailableFeedbackViewGenerations.delete(webview);
    const webviews = this.feedbackWebviews.get(documentKey);
    if (!webviews) return;
    webviews.delete(webview);
    if (webviews.size === 0) this.feedbackWebviews.delete(documentKey);
    const pendingRelease = this.pendingFeedbackPeerReleases.get(documentKey);
    const releaseTarget = pendingRelease?.targets.get(webview);
    releaseTarget?.deliveryAbortController?.abort();
    if (pendingRelease && releaseTarget) {
      pendingRelease.targets.delete(webview);
      this.finalizeFeedbackPeerReleaseIfComplete(documentKey, pendingRelease);
    }
    const pendingTransfer = this.pendingFeedbackSessionTransfers.get(documentKey);
    const transferTarget = pendingTransfer?.targets.get(webview);
    transferTarget?.deliveryAbortController?.abort();
    if (pendingTransfer && transferTarget) {
      this.handleUnavailableFeedbackSessionTransferTarget(
        documentKey,
        pendingTransfer,
        transferTarget
      );
    }
  }

  /** Return the current owner and correlated UI lock token, if one exists. */
  private currentFeedbackPeerLock(
    documentKey: string
  ): { ownerWebview: vscode.Webview; lockId: string } | null {
    const session = this.feedbackSessions.get(documentKey);
    if (session) return { ownerWebview: session.ownerWebview, lockId: session.sessionId };
    const transition = this.feedbackTransitions.get(documentKey);
    return transition ? { ownerWebview: transition.ownerWebview, lockId: transition.lockId } : null;
  }

  /** Reassert the current lock for a peer that attempted a blocked mutation. */
  private postCurrentFeedbackPeerLock(documentKey: string, webview: vscode.Webview): void {
    const current = this.currentFeedbackPeerLock(documentKey);
    if (!current || current.ownerWebview === webview) return;
    void this.acquireFeedbackPeerLockForWebview(
      documentKey,
      current.ownerWebview,
      webview,
      `feedback-peer-current-${current.lockId}`,
      current.lockId
    ).catch(() => {
      console.warn(
        '[MD4H] A rich editor split did not confirm its Feedback lock; the document remains reserved.'
      );
    });
  }

  /** Push current Markdown to every locked sibling before any correlated unlock. */
  private syncFeedbackPeerContent(
    document: vscode.TextDocument,
    ownerWebview: vscode.Webview
  ): void {
    this.feedbackWebviews.get(document.uri.toString())?.forEach(webview => {
      if (webview !== ownerWebview) this.updateWebview(document, webview, { force: true });
    });
  }

  /**
   * Synchronize duplicate split locks whenever a transition or session changes.
   * Replacements install the new token before retiring the old one so a peer is
   * never briefly editable between two host-owned read-only states.
   */
  private refreshFeedbackPeerLocks(documentKey: string): void {
    const webviews = this.feedbackWebviews.get(documentKey);
    const current = this.currentFeedbackPeerLock(documentKey);
    const previousLockId = this.feedbackPeerLockIds.get(documentKey);

    if (!current) {
      if (previousLockId) {
        webviews?.forEach(webview => {
          this.postFeedbackMessage(webview, {
            type: 'feedback.peer.unlocked',
            lockId: previousLockId,
          });
        });
      }
      this.feedbackPeerLockIds.delete(documentKey);
      return;
    }

    if (previousLockId === current.lockId) return;

    this.feedbackPeerLockIds.set(documentKey, current.lockId);
    webviews?.forEach(webview => {
      if (webview === current.ownerWebview) return;
      this.postCurrentFeedbackPeerLock(documentKey, webview);
    });

    if (previousLockId) {
      webviews?.forEach(webview => {
        this.postFeedbackMessage(webview, {
          type: 'feedback.peer.unlocked',
          lockId: previousLockId,
        });
      });
    }
  }

  /** Release volatile Feedback state only when the disposed split owns it. */
  private releaseFeedbackStateForWebview(
    documentKey: string,
    webview: vscode.Webview,
    document?: vscode.TextDocument,
    editsDrained = false
  ): void {
    this.feedbackActiveResumeOffers.delete(webview);
    const pendingTransfer = this.pendingFeedbackSessionTransfers.get(documentKey);
    if (
      pendingTransfer &&
      (pendingTransfer.oldOwner === webview || pendingTransfer.newOwner === webview)
    ) {
      if (!pendingTransfer.deferredReleaseWebviews.has(webview)) {
        pendingTransfer.deferredReleaseWebviews.add(webview);
        void pendingTransfer.finalization.then(() => {
          pendingTransfer.deferredReleaseWebviews.delete(webview);
          this.releaseFeedbackStateForWebview(documentKey, webview, document, editsDrained);
        });
      }
      return;
    }
    const session = this.feedbackSessions.get(documentKey);
    const transition = this.feedbackTransitions.get(documentKey);
    const ownsFeedbackState =
      session?.ownerWebview === webview || transition?.ownerWebview === webview;
    const registeredWebviews = this.feedbackWebviews.get(documentKey);
    const requiresPeerRelease =
      document !== undefined &&
      ownsFeedbackState &&
      registeredWebviews?.has(webview) !== true &&
      (registeredWebviews?.size ?? 0) > 0;
    if (requiresPeerRelease) {
      if (session?.ownerWebview === webview) session.ownerDisposed = true;
      if (transition?.ownerWebview === webview) transition.ownerDisposed = true;
    }
    if (ownsFeedbackState && !editsDrained && this.hasPendingDocumentEdits(documentKey)) {
      // Disposing the owner must not expose a sibling's stale DOM while the
      // owner's final edit queue is still pending. Retain the document lock,
      // then force-sync the settled TextDocument before broadcasting unlock.
      void this.drainDocumentEditsByKey(documentKey).then(() =>
        this.releaseFeedbackStateForWebview(documentKey, webview, document, true)
      );
      return;
    }
    if (requiresPeerRelease && document) {
      void this.releaseFeedbackOwnerAfterDisposal(documentKey, webview, document).catch(error => {
        console.warn(
          `[MD4H] Could not safely release Feedback after its owner closed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
      return;
    }
    if (document && ownsFeedbackState) {
      this.syncFeedbackPeerContent(document, webview);
    }
    if (session?.ownerWebview === webview) {
      session.pendingClose?.deliveryAbortController?.abort();
      this.feedbackSessions.delete(documentKey);
      session.mutationIdleWaiters.forEach(resolve => resolve());
      session.mutationIdleWaiters.clear();
    }
    if (transition?.ownerWebview === webview) {
      transition.deliveryAbortController?.abort();
      this.feedbackTransitions.delete(documentKey);
    }
    this.refreshFeedbackPeerLocks(documentKey);
  }

  /**
   * Keep every surviving split locked until it applies one authoritative
   * TextDocument revision after the owner panel disappears.
   */
  private async releaseFeedbackOwnerAfterDisposal(
    documentKey: string,
    ownerWebview: vscode.Webview,
    document: vscode.TextDocument
  ): Promise<void> {
    const session = this.feedbackSessions.get(documentKey);
    if (session?.ownerWebview === ownerWebview && session.ownerDisposed) {
      await this.retireFeedbackSessionThroughPeerRelease(
        documentKey,
        session,
        document,
        `feedback-owner-disposed-${session.sessionId}`,
        false
      );
      return;
    }

    const transition = this.feedbackTransitions.get(documentKey);
    if (transition?.ownerWebview !== ownerWebview || !transition.ownerDisposed) return;
    await this.retireFeedbackTransitionThroughPeerRelease(documentKey, transition, document, false);
  }

  /** Retire one session only after every available generation applies and unlocks. */
  private async retireFeedbackSessionThroughPeerRelease(
    documentKey: string,
    session: ActiveFeedbackSession,
    document: vscode.TextDocument,
    fallbackRequestId: string,
    includeOwner: boolean
  ): Promise<void> {
    const existingRelease = this.pendingFeedbackPeerReleases.get(documentKey);
    if (existingRelease?.kind === 'session' && existingRelease.lockId === session.sessionId) {
      await existingRelease.completion;
      return;
    }
    await this.waitForFeedbackMutations(session);
    if (this.feedbackSessions.get(documentKey) !== session) {
      const pending = this.pendingFeedbackPeerReleases.get(documentKey);
      if (pending?.kind === 'session' && pending.lockId === session.sessionId) {
        await pending.completion;
      }
      return;
    }
    const requestId = session.pendingClose?.requestId ?? fallbackRequestId;
    await this.acquireFeedbackPeerLocks(
      documentKey,
      session.ownerWebview,
      requestId,
      session.sessionId,
      includeOwner
    );
    if (this.feedbackSessions.get(documentKey) !== session) {
      const pending = this.pendingFeedbackPeerReleases.get(documentKey);
      if (pending?.kind === 'session' && pending.lockId === session.sessionId) {
        await pending.completion;
      }
      return;
    }
    if (!(await this.drainDocumentEdits(document))) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-002',
        'Could not settle editor changes before releasing Feedback ownership.'
      );
    }
    await this.acquireFeedbackPeerLocks(
      documentKey,
      session.ownerWebview,
      requestId,
      session.sessionId,
      includeOwner
    );
    if (this.feedbackSessions.get(documentKey) !== session) {
      const pending = this.pendingFeedbackPeerReleases.get(documentKey);
      if (pending?.kind === 'session' && pending.lockId === session.sessionId) {
        await pending.completion;
      }
      return;
    }

    const revision = Math.max(
      session.pendingClose?.releaseRevision ?? session.pendingClose?.revision ?? 1,
      1
    );
    const contentSha256 = crypto
      .createHash('sha256')
      .update(this.feedbackCloseSyncContent(document), 'utf8')
      .digest('hex');
    session.pendingClose?.deliveryAbortController?.abort();
    session.phase =
      session.phase === 'finishing' || session.phase === 'discarding'
        ? session.phase
        : 'discarding';
    session.pendingClose = {
      requestId,
      terminalType: session.pendingClose?.terminalType ?? 'feedback.discarded',
      revision,
      contentSha256,
      releaseRevision: revision,
    };
    await this.beginFeedbackPeerRelease(
      'session',
      document,
      requestId,
      session.sessionId,
      revision
    );
  }

  /** Retire one transition through the same apply-before-unlock barrier. */
  private async retireFeedbackTransitionThroughPeerRelease(
    documentKey: string,
    transition: FeedbackTransition,
    document: vscode.TextDocument,
    includeOwner: boolean
  ): Promise<void> {
    const existingRelease = this.pendingFeedbackPeerReleases.get(documentKey);
    if (existingRelease?.kind === 'transition' && existingRelease.lockId === transition.lockId) {
      await existingRelease.completion;
      return;
    }
    await this.acquireFeedbackPeerLocks(
      documentKey,
      transition.ownerWebview,
      transition.requestId,
      transition.lockId,
      includeOwner
    );
    if (this.feedbackTransitions.get(documentKey) !== transition) {
      const pending = this.pendingFeedbackPeerReleases.get(documentKey);
      if (pending?.kind === 'transition' && pending.lockId === transition.lockId) {
        await pending.completion;
      }
      return;
    }
    transition.acceptingFlushEdit = false;
    if (!(await this.drainDocumentEdits(document))) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-002',
        'Could not settle editor changes before releasing Feedback transition ownership.'
      );
    }
    await this.acquireFeedbackPeerLocks(
      documentKey,
      transition.ownerWebview,
      transition.requestId,
      transition.lockId,
      includeOwner
    );
    if (this.feedbackTransitions.get(documentKey) !== transition) {
      const pending = this.pendingFeedbackPeerReleases.get(documentKey);
      if (pending?.kind === 'transition' && pending.lockId === transition.lockId) {
        await pending.completion;
      }
      return;
    }
    if (includeOwner) transition.ownerLockPosted = true;
    transition.recoveryRevision = Math.max(transition.recoveryRevision, 1);
    await this.beginFeedbackPeerRelease(
      'transition',
      document,
      transition.requestId,
      transition.lockId,
      transition.recoveryRevision
    );
  }

  /** Prevent stale recovery-banner actions from racing an active or starting session. */
  private assertNoActiveFeedbackOperation(documentKey: string): void {
    if (
      this.feedbackSessions.has(documentKey) ||
      this.feedbackTransitions.has(documentKey) ||
      this.pendingFeedbackPeerReleases.has(documentKey) ||
      this.pendingFeedbackSessionTransfers.has(documentKey)
    ) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-001',
        'Feedback changed since this draft action was shown. Select Start feedback to Resume or recover the current session.'
      );
    }
  }

  private assertFeedbackTransition(documentKey: string, token: symbol): FeedbackTransition {
    const transition = this.feedbackTransitions.get(documentKey);
    if (transition?.token !== token) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-001',
        'The feedback start was cancelled because its editor closed or changed state.'
      );
    }
    if (transition.invalidated) {
      throw new FeedbackSessionError(
        'MD4H-FB-SNAPSHOT-001',
        'The Markdown source changed while the feedback snapshot was starting.'
      );
    }
    if (transition.ownerDisposed) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-001',
        'The feedback start was cancelled because its editor closed.'
      );
    }
    return transition;
  }

  private lockFeedbackTransition(documentKey: string, token: symbol): void {
    this.assertFeedbackTransition(documentKey, token).acceptingFlushEdit = false;
  }

  private async endFeedbackTransition(
    documentKey: string,
    token: symbol,
    document: vscode.TextDocument
  ): Promise<void> {
    let transition = this.feedbackTransitions.get(documentKey);
    if (transition?.token !== token) return;
    if (this.feedbackSessions.has(documentKey)) {
      // Successful Start/Resume replaces the transition lock with a session
      // lock that every peer already acknowledged before activation.
      this.feedbackTransitions.delete(documentKey);
      this.refreshFeedbackPeerLocks(documentKey);
      return;
    }

    // A transition may fail before the normal pre-capture lock barrier. Install
    // the exact lock now, then drain edits accepted before its application ACK.
    // No renderer can interleave a new edit between the final acquisition and
    // the authoritative release snapshot.
    await this.acquireFeedbackPeerLocks(
      documentKey,
      transition.ownerWebview,
      transition.requestId,
      transition.lockId
    );
    transition = this.feedbackTransitions.get(documentKey);
    if (transition?.token !== token) return;
    transition.acceptingFlushEdit = false;
    if (!(await this.drainDocumentEdits(document))) {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-002',
        'Could not settle editor changes before releasing the Feedback transition.'
      );
    }
    transition = this.feedbackTransitions.get(documentKey);
    if (transition?.token !== token) return;
    await this.acquireFeedbackPeerLocks(
      documentKey,
      transition.ownerWebview,
      transition.requestId,
      transition.lockId
    );
    transition = this.feedbackTransitions.get(documentKey);
    if (transition?.token !== token) return;
    if (transition.invalidated || transition.recoveryRequired) {
      // A change consumed while the transition owned the document never
      // reached the owner. Keep every lock until the owner applies and
      // acknowledges an exact correlated recovery revision.
      this.postFeedbackTransitionSync(document, transition);
      return;
    }

    // Cancellation and ordinary failures still need an authoritative apply
    // before any installed transition lock is retired. Revision 1 identifies
    // this terminal transition even when no recovery sync was necessary.
    transition.recoveryRevision = Math.max(transition.recoveryRevision, 1);
    this.beginFeedbackPeerRelease(
      'transition',
      document,
      transition.requestId,
      transition.lockId,
      transition.recoveryRevision
    );
  }

  /** Send the next authoritative transition recovery revision. */
  private postFeedbackTransitionSync(
    document: vscode.TextDocument,
    transition: FeedbackTransition,
    content = this.feedbackCloseSyncContent(document),
    incrementRevision = true
  ): void {
    // Applying a recovery sync also establishes the owner's correlated lock,
    // even when the ordinary transition.locked presentation was never reached.
    transition.ownerLockPosted = true;
    if (incrementRevision) transition.recoveryRevision += 1;
    transition.recoveryContentSha256 = crypto
      .createHash('sha256')
      .update(content, 'utf8')
      .digest('hex');
    this.lastHostContentByWebview.set(
      transition.ownerWebview,
      applyBlankLinePolicy(document.getText(), this.getBlankLineMode())
    );
    const message: Extract<FeedbackCriticalHostMessage, { type: 'feedback.transition.sync' }> = {
      type: 'feedback.transition.sync',
      requestId: transition.requestId,
      lockId: transition.lockId,
      revision: transition.recoveryRevision,
      content,
    };
    transition.deliveryAbortController = this.postFeedbackCriticalStage(
      transition.ownerWebview,
      message,
      transition.lockId,
      transition.recoveryRevision,
      transition.deliveryAbortController
    );
  }

  /**
   * Consumes document changes that occur while Feedback owns the document.
   * Flush-generated edits remain allowed until the snapshot is locked. Any
   * later change cancels an in-progress transition or invalidates the session.
   */
  private handleFeedbackDocumentChange(
    documentKey: string,
    webview: vscode.Webview,
    currentText?: string
  ): boolean {
    const session = this.feedbackSessions.get(documentKey);
    if (session) {
      if (session.ownerWebview !== webview) return false;
      this.invalidateFeedbackSession(documentKey);
      return true;
    }
    const transition = this.feedbackTransitions.get(documentKey);
    if (transition === undefined) {
      return false;
    }
    if (transition.acceptingFlushEdit) {
      const currentSha256 =
        currentText === undefined
          ? undefined
          : crypto.createHash('sha256').update(currentText, 'utf8').digest('hex');
      if (
        transition.expectedFlushContentSha256 !== undefined &&
        transition.expectedFlushContentSha256 === currentSha256
      ) {
        return true;
      }
    }
    transition.invalidated = true;
    return true;
  }

  private async resumeFeedbackSession(
    message: Extract<FeedbackWebviewMessage, { type: 'feedback.draft.resume' }>,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const documentKey = document.uri.toString();
    if (await this.resumeActiveFeedbackSession(message, document, webview)) return;
    const transitionToken = this.beginFeedbackTransition(documentKey, webview, message.requestId);
    const transitionLockId = this.feedbackTransitions.get(documentKey)?.lockId;
    if (!transitionLockId) throw new Error('Feedback transition lock was not created.');
    try {
      const workspaceRoot = this.getWorkspaceFolderPath(document);
      if (!workspaceRoot) {
        throw new FeedbackSessionError(
          'MD4H-FB-STORE-001',
          'Open this saved Markdown file inside a workspace before resuming feedback.'
        );
      }

      const flushedSnapshot = await this.flushFeedbackSnapshot(document, webview, async () => {
        await this.acquireFeedbackPeerLocks(
          documentKey,
          webview,
          message.requestId,
          transitionLockId
        );
      });
      const { sourceBytes } = flushedSnapshot;
      const transition = this.assertFeedbackTransition(documentKey, transitionToken);
      this.postFeedbackTransitionOwnerLock(transition);
      this.lockFeedbackTransition(documentKey, transitionToken);
      let anchorMap: FeedbackAnchorMap;
      let snapshotBlocks: readonly CanonicalFeedbackBlock[] | undefined = message.blocks;
      if (this.feedbackSnapshotCapableWebviews.has(webview)) {
        const finalized = await this.finalizeFeedbackRendererSnapshot(
          document,
          webview,
          flushedSnapshot.source
        );
        anchorMap = finalized.anchorMap;
        snapshotBlocks = finalized.blocks;
      } else {
        if (!message.blocks) {
          throw new FeedbackSessionError(
            'MD4H-FB-SNAPSHOT-001',
            'Reload the rich editor before resuming Feedback so the saved snapshot can be verified.'
          );
        }
        const anchorResult = buildFeedbackAnchorMap(sourceBytes.toString('utf8'), message.blocks);
        if (!anchorResult.ok) {
          throw Object.assign(new Error(anchorResult.error.detail), {
            code: anchorResult.error.code,
          });
        }
        anchorMap = anchorResult.map;
      }
      if (!snapshotBlocks) {
        throw new FeedbackSessionError(
          'MD4H-FB-SNAPSHOT-001',
          'The rich editor did not provide canonical blocks for the saved snapshot.'
        );
      }
      const store = await FeedbackSessionStore.resume({
        workspaceRoot,
        sourcePath: document.uri.fsPath,
        sourceBytes,
        round: message.round,
      });
      this.assertFeedbackTransition(documentKey, transitionToken);
      await this.assertFeedbackSourceSha256(document, store.snapshot.sourceSha256);
      this.assertFeedbackTransition(documentKey, transitionToken);
      const canonicalBlocks = this.buildFeedbackCanonicalBlocks(snapshotBlocks);
      const targets = new Map<string, { startOrdinal: number; endOrdinal: number }>();
      const session: ActiveFeedbackSession = {
        ownerWebview: webview,
        sessionId: crypto.randomBytes(16).toString('hex'),
        store,
        sourceBytes: Buffer.from(sourceBytes),
        sourceIndex: createFeedbackSourceIndex(sourceBytes),
        anchorMap,
        canonicalBlocks,
        targets,
        previewNonce: crypto.randomBytes(8).toString('hex'),
        previewRevisions: new Map(
          store.items
            .filter((item): item is ScreenshotFeedbackItem => item.kind === 'screenshot')
            .map(item => [item.id, 1])
        ),
        degradedRenderedRangeIds: new Set(),
        degradedCellTargetIds: new Set(),
        phase: 'active',
        pendingMutationCount: 0,
        mutationPlanningQueue: Promise.resolve(),
        mutationIdleWaiters: new Set(),
        invalidated: false,
      };
      this.restoreFeedbackTargets(session);
      transition.recoveryRequired = false;
      await this.acquireFeedbackPeerLocks(
        documentKey,
        webview,
        message.requestId,
        session.sessionId
      );
      this.assertFeedbackTransition(documentKey, transitionToken);
      this.feedbackSessions.set(documentKey, session);
      this.postFeedbackSessionStarted(message.requestId, workspaceRoot, session, document, webview);
      this.refreshFeedbackPeerLocks(documentKey);
      this.postDegradedFeedbackRangeWarning(session, webview);
    } finally {
      await this.endFeedbackTransition(documentKey, transitionToken, document);
    }
  }

  /**
   * Rehydrate or explicitly transfer an already-active durable round after a
   * rich-view controller lost its local session state.
   */
  private async resumeActiveFeedbackSession(
    message: Extract<FeedbackWebviewMessage, { type: 'feedback.draft.resume' }>,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<boolean> {
    const documentKey = document.uri.toString();
    const current = this.feedbackSessions.get(documentKey);
    let transferCompletion: FeedbackSessionTransferCompletion | undefined;
    if (!current || current.store.snapshot.round !== message.round) return false;
    const resumeOffer = this.feedbackActiveResumeOffers.get(webview);
    const isAuthorizedOffer =
      resumeOffer?.documentKey === documentKey &&
      resumeOffer.round === message.round &&
      resumeOffer.sessionId === current.sessionId;
    if (current.invalidated) {
      if (current.ownerWebview !== webview) {
        throw new FeedbackSessionError(
          'MD4H-FB-SNAPSHOT-001',
          'The source changed while Feedback was active in another rich view.'
        );
      }
      await this.waitForFeedbackMutations(current);
      if (this.feedbackSessions.get(documentKey) === current) {
        await this.retireFeedbackSessionThroughPeerRelease(
          documentKey,
          current,
          document,
          message.requestId,
          false
        );
      }
      return false;
    }
    if (!isAuthorizedOffer) {
      // A saved-draft banner may have become stale after another split resumed
      // this round. Convert that click into a fresh, explicit transfer offer.
      return this.offerActiveFeedbackResume(message, document, webview);
    }
    this.feedbackActiveResumeOffers.delete(webview);
    if (current.phase !== 'active') {
      throw new FeedbackSessionError(
        'MD4H-FB-STORE-001',
        `This feedback session is already ${current.phase}. Wait for that operation to finish.`
      );
    }
    current.phase = 'resuming';
    try {
      await this.waitForFeedbackMutations(current);
      if (this.feedbackSessions.get(documentKey) !== current) {
        throw new FeedbackSessionError(
          'MD4H-FB-STORE-001',
          'The feedback session changed while Resume was being confirmed.'
        );
      }
      const workspaceRoot = this.getWorkspaceFolderPath(document);
      if (!workspaceRoot || document.uri.scheme !== 'file') {
        throw new FeedbackSessionError(
          'MD4H-FB-STORE-001',
          'Open this saved Markdown file inside a workspace before resuming feedback.'
        );
      }
      const sourceBytes = await readFile(document.uri.fsPath);
      await this.assertFeedbackSourceSha256(document, current.store.snapshot.sourceSha256);
      if (
        this.feedbackSessions.get(documentKey) !== current ||
        current.phase !== 'resuming' ||
        current.invalidated
      ) {
        throw new FeedbackSessionError(
          'MD4H-FB-STORE-001',
          'The feedback session changed while Resume was being confirmed.'
        );
      }
      let nextAnchorMap = current.anchorMap;
      let nextCanonicalBlocks = current.canonicalBlocks;
      if (this.feedbackSnapshotCapableWebviews.has(webview)) {
        const sourceText = document.getText();
        const report = await this.requestFeedbackSnapshotReport(webview, {
          type: 'feedback.snapshot.apply',
          protocolVersion: FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
          requestId: `feedback-transfer-${crypto.randomBytes(8).toString('hex')}`,
          operationId: `feedback-transfer-${current.sessionId}`,
          documentVersion: this.getDocumentVersion(document),
          content: this.wrapFrontmatterForWebview(sourceText),
          descriptorRevision: 1,
          includeCanonicalBlocks: false,
        });
        if (
          report.stage !== 'applied' ||
          !this.feedbackRendererContentMatchesSource(report.content, sourceText)
        ) {
          throw new FeedbackSessionError(
            'MD4H-FB-SNAPSHOT-001',
            'The rich editor did not apply the active Feedback snapshot.'
          );
        }
      } else {
        if (!message.blocks) {
          throw new FeedbackSessionError(
            'MD4H-FB-SNAPSHOT-001',
            'Reload the rich editor before moving this Feedback session.'
          );
        }
        const anchorResult = buildFeedbackAnchorMap(sourceBytes.toString('utf8'), message.blocks);
        if (!anchorResult.ok) {
          throw Object.assign(new Error(anchorResult.error.detail), {
            code: anchorResult.error.code,
          });
        }
        nextAnchorMap = anchorResult.map;
        nextCanonicalBlocks = this.buildFeedbackCanonicalBlocks(message.blocks);
      }

      const nextSession: ActiveFeedbackSession = {
        ...current,
        ownerWebview: webview,
        sessionId: crypto.randomBytes(16).toString('hex'),
        sourceBytes: Buffer.from(sourceBytes),
        sourceIndex: createFeedbackSourceIndex(sourceBytes),
        anchorMap: nextAnchorMap,
        canonicalBlocks: nextCanonicalBlocks,
        targets: new Map(),
        previewNonce: crypto.randomBytes(8).toString('hex'),
        previewRevisions: new Map(
          current.store.items
            .filter((item): item is ScreenshotFeedbackItem => item.kind === 'screenshot')
            .map(item => [item.id, 1])
        ),
        degradedRenderedRangeIds: new Set(),
        degradedCellTargetIds: new Set(),
        phase: 'resuming',
        pendingMutationCount: 0,
        mutationPlanningQueue: Promise.resolve(),
        mutationIdleWaiters: new Set(),
        pendingClose: undefined,
        lastErrorCode: undefined,
      };
      this.restoreFeedbackTargets(nextSession);
      transferCompletion = await this.beginFeedbackSessionTransfer(
        document,
        message.requestId,
        current,
        nextSession
      );
      if (transferCompletion !== 'committed') {
        throw new FeedbackSessionError(
          'MD4H-FB-STORE-002',
          transferCompletion === 'rolled-back'
            ? 'The Feedback handoff was cancelled because the source changed during transfer.'
            : 'The target rich editor was unavailable. Feedback remains reserved in its previous view.'
        );
      }
      return true;
    } catch (error) {
      if (this.feedbackSessions.get(documentKey) === current) {
        const candidateCode =
          error instanceof FeedbackSessionError
            ? error.code
            : error instanceof Error && 'code' in error && typeof error.code === 'string'
              ? error.code
              : undefined;
        if (transferCompletion === 'failed-closed') {
          // The host request has terminated, but an ambiguous renderer may
          // still hold staged state. Keep the durable owner fail-closed until
          // late exact abort ACKs complete the rollback.
        } else if (transferCompletion === 'rolled-back') {
          current.phase = 'active';
          const currentSha256 = crypto
            .createHash('sha256')
            .update(document.getText(), 'utf8')
            .digest('hex');
          if (currentSha256 !== current.store.snapshot.sourceSha256 && !current.invalidated) {
            current.invalidated = true;
            this.postFeedbackMessage(current.ownerWebview, {
              type: 'feedback.invalidated',
              sessionId: current.sessionId,
              code: FEEDBACK_ERROR_CODES.sourceChanged,
              message: 'The Markdown source changed outside the frozen feedback snapshot.',
            });
          }
        } else if (current.ownerWebview === webview) {
          // The controller asking to rehydrate has no usable active UI. Keep
          // the durable bundle, but retire the volatile runtime so Start can
          // perform a fresh exact-hash preflight instead of looping forever.
          await this.retireFeedbackSessionThroughPeerRelease(
            documentKey,
            current,
            document,
            message.requestId,
            false
          );
        } else {
          current.phase = 'active';
          if (candidateCode === FEEDBACK_ERROR_CODES.sourceChanged && !current.invalidated) {
            current.invalidated = true;
            this.postFeedbackMessage(current.ownerWebview, {
              type: 'feedback.invalidated',
              sessionId: current.sessionId,
              code: FEEDBACK_ERROR_CODES.sourceChanged,
              message: 'The Markdown source changed outside the frozen feedback snapshot.',
            });
          }
        }
      }
      throw error;
    }
  }

  /** Restore exact item-to-block targets from persisted inclusive source lines. */
  private restoreFeedbackTargets(session: ActiveFeedbackSession): void {
    let retainedExactCellCount = 0;
    for (const item of session.store.items) {
      const target = findFeedbackOrdinalsForLines(session.anchorMap, item.startLine, item.endLine);
      if (!target) {
        throw Object.assign(
          new Error(`Feedback item ${item.id} no longer maps to the frozen Markdown blocks.`),
          { code: FEEDBACK_ERROR_CODES.targetDoesNotMap }
        );
      }
      if ('target' in item) {
        this.assertPersistedFeedbackBlockSpanV2(session, item.id, target, item.target.blockSpan);
      }
      const renderedRange =
        item.kind === 'text' && 'target' in item && item.target.resolution === 'exact'
          ? item.target.locator?.kind === 'rendered-range'
            ? item.target.locator.value
            : undefined
          : item.kind === 'text' && 'renderedRange' in item
            ? item.renderedRange
            : undefined;
      const cellTarget =
        item.kind === 'text' && 'target' in item && item.target.resolution === 'exact'
          ? item.target.locator?.kind === 'table-cells'
            ? item.target.locator.value
            : undefined
          : item.kind === 'text' && 'cellTarget' in item
            ? item.cellTarget
            : undefined;
      if (
        renderedRange !== undefined &&
        !this.validatePersistedFeedbackRenderedRange(session, target, renderedRange)
      ) {
        session.degradedRenderedRangeIds.add(item.id);
      }
      if (cellTarget !== undefined) {
        const rectangle = cellTarget.rectangle;
        const exactCellCount =
          (rectangle.bottom - rectangle.top) * (rectangle.right - rectangle.left);
        if (
          !this.validatePersistedFeedbackCellTarget(session, target, cellTarget) ||
          retainedExactCellCount + exactCellCount > FEEDBACK_MAX_EXACT_CELL_COUNT_PER_SESSION
        ) {
          session.degradedCellTargetIds.add(item.id);
        } else {
          retainedExactCellCount += exactCellCount;
        }
      }
      session.targets.set(item.id, target);
    }
  }

  /** Report restored exact-range degradation without blocking line-anchored work. */
  private postDegradedFeedbackRangeWarning(
    session: ActiveFeedbackSession,
    webview: vscode.Webview
  ): void {
    const degradedIds = [
      ...new Set([...session.degradedRenderedRangeIds, ...session.degradedCellTargetIds]),
    ].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
    if (degradedIds.length === 0) return;
    const visibleIds = degradedIds.slice(0, 5).join(', ');
    const remaining = degradedIds.length - Math.min(degradedIds.length, 5);
    this.postFeedbackMessage(webview, {
      type: 'feedback.error',
      sessionId: session.sessionId,
      code: FEEDBACK_ERROR_CODES.targetDoesNotMap,
      message: `Exact highlighting could not be restored for ${visibleIds}${
        remaining > 0 ? ` and ${remaining} more` : ''
      }. Their source-line anchors are preserved and block markers are shown.`,
      recoverable: true,
    });
  }

  private postFeedbackSessionStarted(
    requestId: string,
    workspaceRoot: string,
    session: ActiveFeedbackSession,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): void {
    const snapshot = session.store.snapshot;
    const startedMessage: Extract<FeedbackHostMessage, { type: 'feedback.started' }> = {
      type: 'feedback.started',
      requestId,
      sessionId: session.sessionId,
      evidenceVersion: 2,
      source: snapshot.source,
      sourceSha256: snapshot.sourceSha256,
      round: snapshot.round,
      feedbackFile: path
        .relative(workspaceRoot, session.store.feedbackFilePath)
        .split(path.sep)
        .join('/'),
      anchors: session.anchorMap.blocks.map(block => ({
        ordinal: block.ordinal,
        startLine: block.startLine,
        endLine: block.endLine,
      })),
      items: this.feedbackItems(session, webview),
    };

    if (!this.feedbackDeliveryCapableWebviews.has(webview)) {
      this.postFeedbackMessage(webview, startedMessage);
      return;
    }

    const messageId = `feedback-start-${this.nextFeedbackDeliveryId.toString(36)}-${crypto
      .randomBytes(8)
      .toString('hex')}`;
    this.nextFeedbackDeliveryId += 1;
    const delivery: FeedbackStartedDelivery = Object.freeze({
      type: 'feedback.delivery',
      protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
      messageId,
      operationEpoch: requestId,
      sessionEpoch: session.sessionId,
      stageRevision: 1,
      payload: startedMessage,
    });
    const command = Object.freeze({
      messageId,
      operationEpoch: requestId,
      sessionEpoch: session.sessionId,
      stageRevision: 1,
      payload: delivery,
    });
    void this.getFeedbackStartedTransport(webview)
      .send(command)
      .then(result =>
        this.recoverFailedFeedbackStartedDelivery(requestId, session, document, webview, result)
      );
  }

  private async discardInactiveFeedbackDraft(
    message: Extract<FeedbackWebviewMessage, { type: 'feedback.draft.discard' }>,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const documentKey = document.uri.toString();
    const transitionToken = this.beginFeedbackTransition(documentKey, webview, message.requestId);
    const transitionLockId = this.feedbackTransitions.get(documentKey)?.lockId;
    if (!transitionLockId) throw new Error('Feedback transition lock was not created.');
    try {
      // Preserve and save an edit that was already queued when the recovery
      // banner was clicked. The local UI is frozen before the request is
      // posted, so this drains the last legitimate debounce before the host
      // binds that freeze to a correlated transition lock.
      const { sourceBytes } = await this.flushFeedbackSnapshot(document, webview, async () => {
        await this.acquireFeedbackPeerLocks(
          documentKey,
          webview,
          message.requestId,
          transitionLockId
        );
      });
      const transition = this.assertFeedbackTransition(documentKey, transitionToken);
      transition.recoveryRequired =
        transition.recoveryRequired || transition.expectedFlushContentSha256 !== undefined;
      this.postFeedbackTransitionOwnerLock(transition);
      this.lockFeedbackTransition(documentKey, transitionToken);
      const workspaceRoot = this.getWorkspaceFolderPath(document);
      if (!workspaceRoot || document.uri.scheme !== 'file') {
        throw new FeedbackSessionError(
          'MD4H-FB-STORE-001',
          'Open this saved Markdown file inside a workspace before discarding feedback.'
        );
      }
      const store = await FeedbackSessionStore.resume({
        workspaceRoot,
        sourcePath: document.uri.fsPath,
        sourceBytes,
        round: message.round,
      });
      this.assertFeedbackTransition(documentKey, transitionToken);
      await store.validateContainedPaths();
      const choice = await vscode.window.showWarningMessage(
        'Move this feedback draft to Trash?',
        { modal: true },
        'Discard draft'
      );
      if (choice !== 'Discard draft') return;
      this.assertFeedbackTransition(documentKey, transitionToken);
      if (!vscode.workspace.fs) {
        throw new FeedbackSessionError(
          'MD4H-FB-STORE-002',
          'The workspace filesystem is unavailable.'
        );
      }
      await store.validateContainedPaths();
      this.assertFeedbackTransition(documentKey, transitionToken);
      await vscode.workspace.fs.delete(vscode.Uri.file(store.getDiscardPath()), {
        recursive: true,
        useTrash: true,
      });
      store.finalizeDiscard();
      this.postFeedbackMessage(webview, {
        type: 'feedback.draft.discarded',
        requestId: message.requestId,
        round: message.round,
      });
    } finally {
      await this.endFeedbackTransition(documentKey, transitionToken, document);
    }
  }

  /**
   * Build a Claude-Code-style `@file#startLine-endLine` reference for the active
   * document. Saves the document first so the line numbers the webview just
   * computed match the bytes on disk that an AI tool will read.
   *
   * Path is workspace-relative (POSIX separators) when the file is inside an
   * open workspace folder. Files outside any workspace fall back to the absolute
   * fsPath, also normalized to forward slashes.
   */
  private async handleGetAiContextRef(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const requestId = message.requestId as string;
    const rawStart = message.startLine;
    const rawEnd = message.endLine;
    // Both line numbers are optional: when the webview couldn't map the
    // selection to any block (empty doc, all-blank paragraphs, out-of-range
    // cursor) it omits them and we return the bare `@path`.
    const hasRange = typeof rawStart === 'number' && typeof rawEnd === 'number';

    const reply = (payload: { ref?: string; relPath?: string; error?: string }) => {
      webview.postMessage({
        type: 'aiContextRefResponse',
        requestId,
        ...payload,
      });
    };

    if (typeof requestId !== 'string') return;
    if (!hasRange && (rawStart !== undefined || rawEnd !== undefined)) {
      // Partial line info is always a webview bug — fail loudly rather than
      // silently dropping it.
      reply({ error: 'Invalid line range' });
      return;
    }

    try {
      if (document.isDirty) {
        const saved = await document.save();
        if (!saved) {
          reply({ error: 'Could not save document before copying reference' });
          return;
        }
      }

      const filePath = document.uri.fsPath;
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      const relRaw = workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, filePath)
        : filePath;
      const relPath = relRaw.replace(/\\/g, '/');
      if (!hasRange) {
        reply({ ref: `@${relPath}`, relPath });
        return;
      }
      const startLine = rawStart as number;
      const endLine = rawEnd as number;
      const suffix = startLine === endLine ? `#${startLine}` : `#${startLine}-${endLine}`;
      reply({ ref: `@${relPath}${suffix}`, relPath });
    } catch (error) {
      reply({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Handle document export request from webview
   */
  private async handleExportDocument(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument
  ): Promise<void> {
    const format = message.format as string;
    const html = message.html as string;
    const mermaidImages = Array.isArray(message.mermaidImages)
      ? message.mermaidImages.filter(image => this.isExportMermaidImage(image))
      : [];
    const title = message.title as string;

    // Import dynamically to avoid loading heavy dependencies on startup
    const { exportDocument } = await import('../features/documentExport');

    await exportDocument(format, html, mermaidImages, title, document);
  }

  /**
   * Check if a file exists (used by Document Audit)
   */
  private async handleAuditCheckFile(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const rawRelativePath = message.relativePath as string;
    const requestId = message.requestId as string;
    const basePath = this.getImageBasePath(document);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

    if (!basePath) {
      webview.postMessage({
        type: 'auditCheckFileResult',
        requestId,
        exists: false,
      });
      return;
    }

    try {
      // Basic normalization logic similar to handleResolveImageUri
      const normalizedPath = rawRelativePath.replace(/%20/g, ' ');
      const absolutePath = path.resolve(basePath, normalizedPath);
      const fileUri = vscode.Uri.file(absolutePath);

      await vscode.workspace.fs.stat(fileUri);
      webview.postMessage({
        type: 'auditCheckFileResult',
        requestId,
        exists: true,
      });
    } catch {
      const suggestions: string[] = [];
      try {
        // Enhanced fuzzy matching suggestions
        const normalizedPath = rawRelativePath.replace(/%20/g, ' ');
        const basename = path.basename(normalizedPath, path.extname(normalizedPath));
        const extension = path.extname(normalizedPath).toLowerCase();

        if (basename.length >= this.MIN_BASENAME_LENGTH_FOR_SUGGESTION) {
          const searchExclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**}';
          const exactPattern = workspaceFolder
            ? new vscode.RelativePattern(workspaceFolder, `**/${basename}.*`)
            : `**/${basename}.*`;
          const fuzzyPattern = workspaceFolder
            ? new vscode.RelativePattern(workspaceFolder, `**/*${basename}*.*`)
            : `**/*${basename}*.*`;
          const shouldRunFuzzySearch = basename.length >= this.MIN_BASENAME_LENGTH_FOR_FUZZY;
          const extensionPattern =
            extension && workspaceFolder
              ? new vscode.RelativePattern(workspaceFolder, `**/*${extension}`)
              : extension
                ? `**/*${extension}`
                : null;

          // Strategy 1: Exact basename match with any extension
          const exactBasenameFiles = await vscode.workspace.findFiles(
            exactPattern,
            searchExclude,
            8
          );

          // Strategy 2: Fuzzy basename matching for sufficiently specific names.
          // Very short basenames create broad scans and low-quality suggestions.
          const fuzzyFiles = shouldRunFuzzySearch
            ? await vscode.workspace.findFiles(fuzzyPattern, searchExclude, 6)
            : [];

          // Strategy 3: Find some files with the same extension as fallback
          let extensionFiles: vscode.Uri[] = [];
          if (extensionPattern) {
            try {
              extensionFiles = await vscode.workspace.findFiles(extensionPattern, searchExclude, 3);
            } catch (e) {
              console.warn('[MD4H] Error finding extension files for audit suggestions:', e);
            }
          }

          // 1. Combine all raw results
          const allFiles = [...exactBasenameFiles, ...fuzzyFiles, ...extensionFiles];
          // 2. Convert all absolute paths to relative, web-safe paths
          const rawSuggestions = allFiles.map(f => {
            const rel = path.relative(basePath, f.fsPath).replace(/\\/g, '/');
            return rel.startsWith('.') ? rel : `./${rel}`;
          });

          // 3. Deduplicate
          const uniqueSuggestions = Array.from(new Set(rawSuggestions));

          // 4. Sort based on clear priority rules
          uniqueSuggestions.sort((a, b) => {
            // Priority 1: Does the extension match the original?
            const aHasExactExt = extension && path.extname(a).toLowerCase() === extension;
            const bHasExactExt = extension && path.extname(b).toLowerCase() === extension;
            if (aHasExactExt && !bHasExactExt) return -1;
            if (!aHasExactExt && bHasExactExt) return 1;

            // Priority 2: Does the basename match exactly?
            const aBase = path.basename(a, path.extname(a));
            const bBase = path.basename(b, path.extname(b));
            const aExactBase = aBase === basename;
            const bExactBase = bBase === basename;
            if (aExactBase && !bExactBase) return -1;
            if (!aExactBase && bExactBase) return 1;

            // Priority 3: Shorter paths are usually closer to the current directory
            return a.length - b.length;
          });

          // 5. Apply the top 5 sorted results to the suggestions array
          suggestions.push(...uniqueSuggestions.slice(0, 5));
        }
      } catch (e) {
        console.warn('[MD4H] Error finding audit file suggestions:', e);
      }

      webview.postMessage({
        type: 'auditCheckFileResult',
        requestId,
        exists: false,
        suggestions: suggestions.slice(0, 5), // Limit to 5 for UI
      });
    }
  }

  /**
   * Open a VS Code file picker dialog for the Document Audit feature.
   *
   * Sends back an 'auditPickFileResult' message with the relative path of the
   * file selected by the user, or null if the user cancelled.
   *
   * @param message - Webview message containing requestId and fileType ('image' | 'any').
   * @param document - Active text document (used to derive the relative path base).
   * @param webview - Target webview to post the result back to.
   */
  private async handleAuditPickFile(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const requestId = message.requestId as string;
    const fileType = message.fileType as string;
    const basePath = this.getImageBasePath(document);

    // Build file-type filter
    const imageFilters: { [name: string]: string[] } = {
      Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'tif'],
    };
    const allFilters: { [name: string]: string[] } = {
      'All Files': ['*'],
      Markdown: ['md', 'mdx'],
      Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'],
    };
    const filters = fileType === 'image' ? imageFilters : allFilters;

    try {
      const defaultUri = basePath ? vscode.Uri.file(basePath) : undefined;
      const selected = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFolders: false,
        canSelectFiles: true,
        openLabel: 'Select File',
        defaultUri,
        filters,
      });

      if (!selected || selected.length === 0) {
        // User cancelled
        webview.postMessage({ type: 'auditPickFileResult', requestId, selectedPath: null });
        return;
      }

      const absoluteSelected = selected[0].fsPath;

      // Compute path relative to the document's base directory
      let relativePath: string | null = null;
      if (basePath) {
        const rel = path.relative(basePath, absoluteSelected);
        // Only use relative path if the file is within or near the base directory
        if (!path.isAbsolute(rel)) {
          // Normalize to forward-slashes for markdown compatibility
          relativePath = rel.replace(/\\/g, '/');
          if (!relativePath.startsWith('.')) {
            relativePath = './' + relativePath;
          }
        }
      }

      // Fall back to the absolute path when file is outside the document root
      // Fall back to the absolute path when file is outside the document root
      if (!relativePath) {
        relativePath = absoluteSelected.replace(/\\/g, '/');
        // Warn the user about document portability issues
        vscode.window.showWarningMessage(
          'You selected a file outside the current workspace. An absolute path was used, which may break if you share this document.'
        );
      }
      webview.postMessage({ type: 'auditPickFileResult', requestId, selectedPath: relativePath });
    } catch (e) {
      console.error('[MD4H] handleAuditPickFile error:', e);
      webview.postMessage({ type: 'auditPickFileResult', requestId, selectedPath: null });
    }
  }

  private isPrivateAddress(ip: string): boolean {
    // Handle IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1)
    // These can be returned by dns.lookup on dual-stack systems and would bypass
    // the IPv4 regex checks below without this normalization.
    const ipv4MappedMatch = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (ipv4MappedMatch) {
      return this.isPrivateAddress(ipv4MappedMatch[1]);
    }

    const PRIVATE_IP_RANGES = [
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^0\./,
    ];
    if (ip === '::1' || ip === '::' || ip === '0.0.0.0') return true;
    if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
    return PRIVATE_IP_RANGES.some(range => range.test(ip));
  }

  private async isSafeUrl(hostname: string): Promise<boolean> {
    if (hostname.toLowerCase() === 'localhost') {
      return false;
    }
    if (isIP(hostname)) {
      return !this.isPrivateAddress(hostname);
    }
    try {
      const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
      return !addresses.some(ip => this.isPrivateAddress(ip.address));
    } catch {
      return false;
    }
  }

  private async resolveSafeAddress(hostname: string): Promise<string | null> {
    if (hostname.toLowerCase() === 'localhost') {
      return null;
    }
    if (isIP(hostname)) {
      return this.isPrivateAddress(hostname) ? null : hostname;
    }
    try {
      const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
      const publicAddress = addresses.find(address => !this.isPrivateAddress(address.address));
      return publicAddress?.address ?? null;
    } catch {
      return null;
    }
  }

  private async handleAuditCheckUrl(
    message: { type: string; [key: string]: unknown },
    _document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const url = message.url as string;
    const requestId = message.requestId as string;

    if (!url) {
      webview.postMessage({
        type: 'auditCheckUrlResult',
        requestId,
        reachable: false,
      });
      return;
    }

    try {
      const parsed = new URL(url);
      if (!(await this.isSafeUrl(parsed.hostname))) {
        webview.postMessage({
          type: 'auditCheckUrlResult',
          requestId,
          reachable: false,
        });
        return;
      }
      const safeAddress = await this.resolveSafeAddress(parsed.hostname);
      if (!safeAddress) {
        webview.postMessage({
          type: 'auditCheckUrlResult',
          requestId,
          reachable: false,
        });
        return;
      }

      // Use Node's native http/https modules for guaranteed cross-version consistency.
      // Try HEAD first; fall back to GET if the server rejects HEAD (405/403/404).
      const requestOpts = {
        hostname: safeAddress,
        headers: {
          Host: parsed.host,
          'User-Agent': 'MarkdownForHumans-LinkChecker/1.0',
        } as Record<string, string>,
        servername: parsed.hostname,
        path: parsed.pathname + parsed.search,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        timeout: MarkdownEditorProvider.URL_CHECK_TIMEOUT_MS,
      };
      const httpModule = parsed.protocol === 'https:' ? https : http;

      const tryRequest = (method: string): Promise<number> =>
        new Promise<number>(resolve => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const req = httpModule.request({ ...requestOpts, method }, (res: any) => {
              // Consume body so the socket is released
              res.resume();
              resolve(res.statusCode as number);
            });
            req.on('error', () => resolve(0));
            req.on('timeout', () => {
              req.destroy();
              resolve(0);
            });
            req.end();
          } catch {
            resolve(0);
          }
        });

      let status = await tryRequest('HEAD');

      // Many servers block HEAD or return misleading codes; retry with GET
      if (status === 403 || status === 404 || status === 405) {
        status = await tryRequest('GET');
      }

      const reachable = status >= 200 && status < 400;

      webview.postMessage({
        type: 'auditCheckUrlResult',
        requestId,
        reachable,
      });
    } catch (e) {
      console.warn('[MD4H] URL check failed', e);
      webview.postMessage({
        type: 'auditCheckUrlResult',
        requestId,
        reachable: false,
      });
    }
  }

  /**
   * Resolve a relative image path to a webview URI
   *
   * Normalizes URL-encoded paths (e.g. `Hero%20Image.png`) before resolving
   * so that images with spaces or special characters in filenames work correctly.
   */
  private handleResolveImageUri(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): void {
    const rawRelativePath = message.relativePath;
    const requestId = message.requestId as string;

    if (typeof rawRelativePath !== 'string' || rawRelativePath.length === 0) {
      webview.postMessage({
        type: 'imageUriResolved',
        requestId,
        webviewUri: '',
        relativePath: typeof rawRelativePath === 'string' ? rawRelativePath : '',
        error: 'Cannot resolve image path: the path is missing or invalid',
      });
      return;
    }

    // Normalize the path (decode URL-encoded segments like %20 → space)
    const relativePath = normalizeImagePath(rawRelativePath);

    // Resolve relative to document base path
    const basePath = this.getImageBasePath(document);
    if (!basePath) {
      webview.postMessage({
        type: 'imageUriResolved',
        requestId,
        webviewUri: '',
        relativePath: rawRelativePath,
        error: 'Cannot resolve image path: no base directory available',
      });
      return;
    }
    const absolutePath = path.resolve(basePath, relativePath);
    const allowedRoots = this.getAllowedFileRoots(document);
    if (!allowedRoots.some(root => isPathContainedWithin(absolutePath, path.resolve(root)))) {
      webview.postMessage({
        type: 'imageUriResolved',
        requestId,
        webviewUri: '',
        relativePath: rawRelativePath,
        error: 'Cannot resolve image path: the file is outside the allowed document roots',
      });
      return;
    }
    const fileUri = vscode.Uri.file(absolutePath);

    // Convert to webview URI
    const webviewUri = webview.asWebviewUri(fileUri);

    webview.postMessage({
      type: 'imageUriResolved',
      requestId,
      webviewUri: webviewUri.toString(),
      relativePath: rawRelativePath, // Return original path for consistency
    });
  }

  /**
   * Check if relative path is valid (doesn't contain absolute path)
   * Works on both Windows and Mac/Linux
   */
  private isValidRelativePath(relativePath: string): boolean {
    // On Windows, path.relative() can produce paths like "../../../../c:/Users/..."
    // when paths don't share a common root. Check for drive letters.
    const windowsAbsolutePattern = /[a-zA-Z]:/;

    // On Unix/Mac, path.relative() can produce paths starting with "/"
    // when paths don't share a common root. Check for leading slash.
    const unixAbsolutePattern = /^\/[^/]/;

    // Also check if path.isAbsolute() returns true (Node.js built-in, cross-platform)
    return (
      !windowsAbsolutePattern.test(relativePath) &&
      !unixAbsolutePattern.test(relativePath) &&
      !path.isAbsolute(relativePath)
    );
  }

  /**
   * Check if source is within workspace/document directory (cross-platform).
   * Thin wrapper over the exported `isPathContainedWithin` helper.
   */
  private isWithinWorkspace(sourcePath: string, basePath: string): boolean {
    return isPathContainedWithin(sourcePath, basePath);
  }

  /**
   * Build the list of allowed roots a file-mutating handler may write to,
   * for the given document. Used by handleRenameImage / handleResizeImage
   * to reject paths that escape via `../` from a hostile markdown image
   * src (see SECURITY review §H1, §H2).
   */
  private getAllowedFileRoots(document: vscode.TextDocument): string[] {
    const roots: string[] = [];
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (workspaceFolder) {
      roots.push(workspaceFolder.uri.fsPath);
    }
    if (document.uri.scheme === 'file') {
      roots.push(path.dirname(document.uri.fsPath));
    }
    const imageBase = this.getImageBasePath(document);
    if (imageBase) {
      roots.push(imageBase);
    }
    // De-dupe
    return Array.from(new Set(roots));
  }

  /**
   * Handle workspace image drop (from VS Code file explorer)
   * Computes relative path from document to the image, or copies image if outside workspace
   */
  private async handleWorkspaceImage(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const sourcePath = message.sourcePath as string;
    const fileName = message.fileName as string;
    const insertPosition = message.insertPosition as number | undefined;

    console.warn(`[MD4H] Handling workspace image: ${sourcePath}`);

    // Get the document base path
    const basePath = this.getImageBasePath(document);
    if (!basePath) {
      console.error(`[MD4H] Cannot compute relative path: no base directory available`);
      return;
    }

    // Normalize paths for comparison
    const normalizedSource = path.normalize(sourcePath);
    const normalizedBase = path.normalize(basePath);

    // Check if image is within workspace/document directory
    const withinWorkspace = this.isWithinWorkspace(normalizedSource, normalizedBase);

    // Compute relative path from document base to image
    let relativePath = path.relative(normalizedBase, normalizedSource);

    // Ensure forward slashes for markdown compatibility
    relativePath = relativePath.replace(/\\/g, '/');

    // Validate the relative path
    const isValidPath = this.isValidRelativePath(relativePath);

    // If path is invalid or image is outside workspace, copy it to workspace
    if (!isValidPath || !withinWorkspace) {
      console.warn(
        `[MD4H] Image is outside workspace or has invalid path, copying to workspace...`
      );

      try {
        // Read the source image
        const sourceUri = vscode.Uri.file(normalizedSource);
        const imageData = await vscode.workspace.fs.readFile(sourceUri);

        // Get save location
        const saveBasePath = this.getImageStorageBasePath(document);
        if (!saveBasePath) {
          const errorMessage = 'Cannot copy image: no base directory available';
          vscode.window.showErrorMessage(errorMessage);
          return;
        }

        const config = vscode.workspace.getConfiguration();
        const imageFolderName = config.get<string>('markdownForHumans.imagePath', 'images');
        const imagesDir = path.join(saveBasePath, imageFolderName);

        // Create folder if needed
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(imagesDir));

        // Generate filename from source
        const sourceFilename = path.basename(normalizedSource);
        const parsedName = path.parse(sourceFilename);
        const baseFilename = parsedName.name || 'image';
        const extension = parsedName.ext || '';

        let finalFilename = sourceFilename;
        let targetPath = path.join(imagesDir, finalFilename);
        let targetUri = vscode.Uri.file(targetPath);

        const fileExists = async (uri: vscode.Uri): Promise<boolean> => {
          try {
            await vscode.workspace.fs.stat(uri);
            return true;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('ENOENT') || message.includes('FileNotFound')) {
              return false;
            }
            throw error;
          }
        };

        // Handle filename collisions
        if (await fileExists(targetUri)) {
          let foundAvailableName = false;
          for (let suffix = 2; suffix < 1000; suffix += 1) {
            finalFilename = `${baseFilename}-${suffix}${extension}`;
            targetPath = path.join(imagesDir, finalFilename);
            targetUri = vscode.Uri.file(targetPath);
            if (!(await fileExists(targetUri))) {
              foundAvailableName = true;
              break;
            }
          }
          if (!foundAvailableName) {
            throw new Error(
              `Cannot copy image: too many existing files matching "${baseFilename}-N${extension}"`
            );
          }
        }

        // Copy file to workspace
        await vscode.workspace.fs.writeFile(targetUri, imageData);

        // Calculate relative path for markdown
        const markdownDir =
          document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : saveBasePath;
        let copiedRelativePath = path.relative(markdownDir, targetPath).replace(/\\/g, '/');
        if (!copiedRelativePath.startsWith('..') && !copiedRelativePath.startsWith('./')) {
          copiedRelativePath = './' + copiedRelativePath;
        }

        console.warn(`[MD4H] Image copied to workspace. Path: ${copiedRelativePath}`);

        // Extract alt text from filename (remove extension)
        const altText = fileName.replace(/\.[^.]+$/, '');

        // Send message to webview to insert the image with relative path
        // Use insertWorkspaceImage message type for consistency
        webview.postMessage({
          type: 'insertWorkspaceImage',
          relativePath: copiedRelativePath,
          altText,
          insertPosition,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[MD4H] Failed to copy workspace image: ${errorMessage}`);
        vscode.window.showErrorMessage(`Failed to copy image: ${errorMessage}`);
      }
      return;
    }

    // Image is within workspace and path is valid - use relative path directly
    // Add ./ prefix if it doesn't start with .. (going up directories)
    if (!relativePath.startsWith('..') && !relativePath.startsWith('./')) {
      relativePath = './' + relativePath;
    }

    console.warn(`[MD4H] Computed relative path: ${relativePath}`);

    // Extract alt text from filename (remove extension)
    const altText = fileName.replace(/\.[^.]+$/, '');

    // Send the markdown image syntax back to webview
    webview.postMessage({
      type: 'insertWorkspaceImage',
      relativePath,
      altText,
      insertPosition,
    });
  }

  /**
   * Start one host-owned image write before any pending marker can be applied.
   * The renderer may be destroyed while the file is saving, so the completion
   * stays correlated to its webview and placeholder until document sync uses it.
   */
  private trackPendingImageSave(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): void {
    const placeholderId = message.placeholderId;
    const data = message.data;
    const mimeType = message.mimeType;
    const viewGeneration = message.viewGeneration;
    if (message.protocolVersion === undefined && Array.isArray(data)) {
      // Compatibility for a pre-versioned renderer already alive during an
      // extension-host restart. New renderers send Uint8Array plus generation.
      void this.handleSaveImage(message, document, webview);
      return;
    }
    if (
      message.protocolVersion !== IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION ||
      typeof placeholderId !== 'string' ||
      placeholderId.length === 0 ||
      placeholderId.length > 256 ||
      typeof viewGeneration !== 'string' ||
      viewGeneration !== this.editViewGenerations.get(webview) ||
      !(data instanceof Uint8Array) ||
      typeof mimeType !== 'string' ||
      !mimeType.startsWith('image/')
    ) {
      console.warn('[MD4H] Rejected malformed or stale pending image save');
      return;
    }
    // Copy the accepted view exactly once. This prevents a tiny subview from
    // retaining a large backing buffer and isolates the file write from any
    // later mutation of a direct adapter's message object.
    const denseData = data.slice();

    let pending = this.pendingHostImageSaves.get(webview);
    if (!pending) {
      pending = new Map();
      this.pendingHostImageSaves.set(webview, pending);
    }
    const existing = pending.get(placeholderId);
    if (existing) {
      // The renderer may replay saveImage while waiting for its terminal result.
      // Reuse the original file write and immutable completion identity.
      if (existing.viewGeneration === viewGeneration) return;
      console.warn('[MD4H] Rejected a pending image id reused across renderer generations');
      return;
    }

    const retainedBytes = [...pending.values()].reduce(
      (total, entry) => total + (entry.data?.byteLength ?? 0),
      0
    );
    if (
      pending.size >= MarkdownEditorProvider.PENDING_HOST_IMAGE_SAVE_LIMIT ||
      denseData.byteLength > MarkdownEditorProvider.PENDING_HOST_IMAGE_SAVE_BYTE_LIMIT ||
      retainedBytes + denseData.byteLength >
        MarkdownEditorProvider.PENDING_HOST_IMAGE_SAVE_BYTE_LIMIT
    ) {
      const error =
        'Too many images are still being saved. Wait for the current image saves to finish and try again.';
      vscode.window.showErrorMessage(error);
      this.startPendingImageSaveRejectionDelivery(webview, placeholderId, viewGeneration, error);
      return;
    }

    // Assigned before the persistence microtask settles; its callbacks mutate
    // the same entry later retained in pendingHostImageSaves.
    // eslint-disable-next-line prefer-const
    let entry: PendingHostImageSave;
    const completionId = crypto.randomBytes(16).toString('hex');
    const persistence = Promise.resolve().then(() =>
      this.persistImage(message, document, denseData)
    );
    const completion = persistence.then(
      result => {
        entry.settled = true;
        if (result.kind === 'error' && entry.data) {
          // Failure is the only path that needs a durable preview fallback for
          // an accepted teardown marker. Encode without another binary copy,
          // then release the dense transfer buffer at settlement.
          entry.fallbackDataUri = `data:${entry.mimeType};base64,${Buffer.from(
            entry.data.buffer,
            entry.data.byteOffset,
            entry.data.byteLength
          ).toString('base64')}`;
        }
        entry.data = undefined;
        this.startPendingImageCompletionDelivery(webview, entry, result);
        return result.kind === 'saved' ? result.destination : null;
      },
      error => {
        entry.settled = true;
        if (entry.data) {
          entry.fallbackDataUri = `data:${entry.mimeType};base64,${Buffer.from(
            entry.data.buffer,
            entry.data.byteOffset,
            entry.data.byteLength
          ).toString('base64')}`;
        }
        entry.data = undefined;
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[MD4H] Unexpected pending image save rejection:', errorMessage);
        this.startPendingImageCompletionDelivery(webview, entry, {
          kind: 'error',
          error: errorMessage || 'Image save failed unexpectedly.',
        });
        return null;
      }
    );
    entry = {
      placeholderId,
      viewGeneration,
      completionId,
      data: denseData,
      mimeType,
      completion,
      settled: false,
      deliveryRetired: false,
      retireAfterSettlement: false,
    };
    pending.set(placeholderId, entry);
  }

  /** Deliver one bounded capacity rejection until its exact renderer ACKs it. */
  private startPendingImageSaveRejectionDelivery(
    webview: vscode.Webview,
    placeholderId: string,
    viewGeneration: string,
    error: string
  ): void {
    if (this.disposed) return;
    let rejections = this.pendingHostImageSaveRejections.get(webview);
    if (!rejections) {
      rejections = new Map();
      this.pendingHostImageSaveRejections.set(webview, rejections);
    }
    const existing = rejections.get(placeholderId);
    if (existing?.viewGeneration === viewGeneration) return;
    if (
      existing ||
      rejections.size >= MarkdownEditorProvider.PENDING_HOST_IMAGE_SAVE_REJECTION_LIMIT
    ) {
      console.error('[MD4H] Pending-image rejection delivery capacity exhausted');
      return;
    }

    const completionId = crypto.randomBytes(16).toString('hex');
    const completion: PendingImageSaveCompletion = {
      type: 'imageError',
      protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
      completionId,
      placeholderId,
      viewGeneration,
      error: error.slice(0, 32 * 1024),
    };
    const completionDelivery = this.createImageCompletionDelivery(webview, completion);
    rejections.set(placeholderId, {
      placeholderId,
      viewGeneration,
      completionId,
      completionDelivery,
    });
    this.activateImageCompletionDelivery(completionDelivery);
  }

  /** Create one retry transport without starting it before its owner is recorded. */
  private createImageCompletionDelivery(
    webview: vscode.Webview,
    completion: PendingImageSaveCompletion
  ): ImageSaveCompletionDelivery {
    return new ImageSaveCompletionDelivery({
      message: completion,
      postMessage: message => webview.postMessage(message),
      ackTimeoutMs: MarkdownEditorProvider.IMAGE_SAVE_COMPLETION_ACK_TIMEOUT_MS,
      retryDelayMs: MarkdownEditorProvider.IMAGE_SAVE_COMPLETION_RETRY_DELAY_MS,
      maxRetryDelayMs: MarkdownEditorProvider.IMAGE_SAVE_COMPLETION_MAX_RETRY_DELAY_MS,
    });
  }

  /** Retain and start a delivery so provider disposal can cancel its timer. */
  private activateImageCompletionDelivery(delivery: ImageSaveCompletionDelivery): void {
    if (this.disposed) {
      delivery.dispose();
      return;
    }
    this.activeImageCompletionDeliveries.add(delivery);
    delivery.start();
  }

  /** Cancel a delivery and release provider-wide iterable ownership. */
  private disposeImageCompletionDelivery(delivery: ImageSaveCompletionDelivery | undefined): void {
    if (!delivery) return;
    delivery.dispose();
    this.activeImageCompletionDeliveries.delete(delivery);
  }

  /** Start or replay one immutable completion until its renderer ACKs application. */
  private startPendingImageCompletionDelivery(
    webview: vscode.Webview,
    entry: PendingHostImageSave,
    result: ImagePersistenceResult
  ): void {
    if (this.disposed || entry.deliveryRetired) return;

    const completion: PendingImageSaveCompletion =
      result.kind === 'saved'
        ? {
            type: 'imageSaved',
            protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
            completionId: entry.completionId,
            placeholderId: entry.placeholderId,
            viewGeneration: entry.viewGeneration,
            newSrc: result.destination,
          }
        : {
            type: 'imageError',
            protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
            completionId: entry.completionId,
            placeholderId: entry.placeholderId,
            viewGeneration: entry.viewGeneration,
            error: (result.error || 'Image save failed.').slice(0, 32 * 1024),
          };
    this.disposeImageCompletionDelivery(entry.completionDelivery);
    entry.completionDelivery = this.createImageCompletionDelivery(webview, completion);
    this.activateImageCompletionDelivery(entry.completionDelivery);
  }

  /** Stop retry only after an exact, generation-bound renderer application ACK. */
  private acceptPendingImageSaveCompletionAck(message: unknown, webview: vscode.Webview): void {
    const acknowledgement = parsePendingImageSaveCompletionAck(message);
    if (!acknowledgement) return;
    const entry = this.pendingHostImageSaves.get(webview)?.get(acknowledgement.placeholderId);
    if (
      entry &&
      entry.completionId === acknowledgement.completionId &&
      entry.viewGeneration === acknowledgement.viewGeneration
    ) {
      const delivery = entry.completionDelivery;
      if (delivery?.acceptAcknowledgement(acknowledgement) === 'accepted') {
        this.activeImageCompletionDeliveries.delete(delivery);
      }
      return;
    }

    const rejections = this.pendingHostImageSaveRejections.get(webview);
    const rejection = rejections?.get(acknowledgement.placeholderId);
    if (
      !rejection ||
      rejection.completionId !== acknowledgement.completionId ||
      rejection.viewGeneration !== acknowledgement.viewGeneration
    ) {
      return;
    }
    if (rejection.completionDelivery.acceptAcknowledgement(acknowledgement) === 'accepted') {
      this.activeImageCompletionDeliveries.delete(rejection.completionDelivery);
      rejections?.delete(rejection.placeholderId);
      if (rejections?.size === 0) this.pendingHostImageSaveRejections.delete(webview);
    }
  }

  /** Cancel panel-bound retry timers but preserve teardown marker resolution. */
  private retirePendingImageCompletionDeliveries(
    webview: vscode.Webview,
    options: { readonly discardAfterSettlement?: boolean } = {}
  ): void {
    const rejections = this.pendingHostImageSaveRejections.get(webview);
    if (rejections) {
      for (const rejection of rejections.values()) {
        this.disposeImageCompletionDelivery(rejection.completionDelivery);
      }
      this.pendingHostImageSaveRejections.delete(webview);
    }
    const pending = this.pendingHostImageSaves.get(webview);
    if (!pending) return;
    for (const entry of pending.values()) {
      entry.deliveryRetired = true;
      this.disposeImageCompletionDelivery(entry.completionDelivery);
      entry.completionDelivery = undefined;
      if (!options.discardAfterSettlement) continue;
      entry.retireAfterSettlement = true;
      void entry.completion.finally(() => {
        if (
          entry.retireAfterSettlement &&
          this.pendingHostImageSaves.get(webview)?.get(entry.placeholderId) === entry
        ) {
          this.disposeImageCompletionDelivery(entry.completionDelivery);
          pending.delete(entry.placeholderId);
          if (pending.size === 0) this.pendingHostImageSaves.delete(webview);
        }
      });
    }
  }

  /** Resolve only markers present in this exact renderer revision. */
  private async resolvePendingImageDestinations(
    content: string,
    webview: vscode.Webview,
    viewGeneration: string
  ): Promise<string> {
    const pending = this.pendingHostImageSaves.get(webview);
    if (!pending) {
      if (content.includes(PENDING_IMAGE_DESTINATION_PREFIX)) {
        throw new Error('Cannot resolve a pending image marker without its host file operation.');
      }
      return content;
    }

    let resolvedContent = content;
    for (const entry of [...pending.values()]) {
      if (entry.viewGeneration !== viewGeneration) continue;
      const marker = createPendingImageDestination(entry.placeholderId);
      if (!resolvedContent.includes(marker)) {
        // A serialized renderer revision without this marker proves that its
        // placeholder was replaced or removed. Completed metadata is no longer
        // needed for teardown recovery.
        if (entry.settled) {
          this.disposeImageCompletionDelivery(entry.completionDelivery);
          pending.delete(entry.placeholderId);
        }
        continue;
      }
      const savedDestination = await entry.completion;
      resolvedContent = replacePendingImageDestination(
        resolvedContent,
        entry.placeholderId,
        savedDestination ?? entry.fallbackDataUri ?? ''
      );
      this.disposeImageCompletionDelivery(entry.completionDelivery);
      pending.delete(entry.placeholderId);
      entry.data = undefined;
      entry.fallbackDataUri = undefined;
    }
    if (resolvedContent.includes(PENDING_IMAGE_DESTINATION_PREFIX)) {
      throw new Error('Cannot apply a document edit containing an unknown pending image marker.');
    }
    if (pending.size === 0) this.pendingHostImageSaves.delete(webview);
    return resolvedContent;
  }

  /**
   * Compatibility wrapper for direct adapters. Production saveImage messages
   * use trackPendingImageSave so terminal delivery is ACKed and retried.
   */
  private async handleSaveImage(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<string | null> {
    const rawData = message.data;
    const bytes =
      rawData instanceof Uint8Array
        ? rawData
        : new Uint8Array(Array.isArray(rawData) ? rawData : []);
    const result = await this.persistImage(message, document, bytes);
    const placeholderId = message.placeholderId as string;
    if (result.kind === 'saved') {
      await webview.postMessage({
        type: 'imageSaved',
        placeholderId,
        newSrc: result.destination,
      });
      return result.destination;
    }
    await webview.postMessage({
      type: 'imageError',
      placeholderId,
      error: result.error,
    });
    return null;
  }

  /** Persist one validated dense image buffer without owning renderer delivery. */
  private async persistImage(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    data: Uint8Array
  ): Promise<ImagePersistenceResult> {
    const name = message.name as string;
    const mimeType = message.mimeType as string;

    // Use user-selected folder from confirmation dialog
    const imageFolderName = (message.targetFolder as string) || 'images';

    // Resolve where to save new images (may be doc-relative or workspace-level).
    const saveBasePath = this.getImageStorageBasePath(document);
    if (!saveBasePath) {
      const errorMessage = 'Cannot save image: no base directory available';
      vscode.window.showErrorMessage(errorMessage);
      return { kind: 'error', error: errorMessage };
    }
    const imagesDir = path.join(saveBasePath, imageFolderName);
    if (!isPathContainedWithin(imagesDir, saveBasePath)) {
      const errorMessage = `Refusing to save image outside the base directory: ${imageFolderName}`;
      vscode.window.showErrorMessage(errorMessage);
      return { kind: 'error', error: errorMessage };
    }

    console.warn(`[MD4H] Saving image "${name}" to folder: ${imagesDir}`);

    try {
      // Create folder if needed
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(imagesDir));

      // Save image (collision-safe: never overwrite silently)
      const safeName = path.basename(name) || 'image';
      const parsedName = path.parse(safeName);
      const baseFilename = parsedName.name || 'image';
      const extension = parsedName.ext || '';

      let finalFilename = safeName;
      let imagePath = path.join(imagesDir, finalFilename);
      let imageUri = vscode.Uri.file(imagePath);

      const fileExists = async (uri: vscode.Uri): Promise<boolean> => {
        try {
          await vscode.workspace.fs.stat(uri);
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Treat not-found as available; unknown errors should abort to avoid accidental overwrites.
          if (message.includes('ENOENT') || message.includes('FileNotFound')) {
            return false;
          }
          throw error;
        }
      };

      if (await fileExists(imageUri)) {
        let foundAvailableName = false;
        for (let suffix = 2; suffix < 1000; suffix += 1) {
          finalFilename = `${baseFilename}-${suffix}${extension}`;
          imagePath = path.join(imagesDir, finalFilename);
          imageUri = vscode.Uri.file(imagePath);
          if (!(await fileExists(imageUri))) {
            foundAvailableName = true;
            break;
          }
        }
        if (!foundAvailableName) {
          throw new Error(
            `Cannot save image: too many existing files matching "${baseFilename}-N${extension}"`
          );
        }
      }

      await vscode.workspace.fs.writeFile(imageUri, data);

      // Markdown link should always be relative to the markdown file directory (portable in git).
      const markdownDir =
        document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : saveBasePath;
      let relativePath = path.relative(markdownDir, imagePath).replace(/\\/g, '/');

      if (!relativePath.startsWith('..') && !relativePath.startsWith('./')) {
        relativePath = './' + relativePath;
      }

      console.warn(`[MD4H] Image saved successfully. Path: ${relativePath}`);

      // Log success (mimeType used for potential future validation)
      if (mimeType) {
        // Image type validation could be added here
      }
      return { kind: 'saved', destination: relativePath };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to save image: ${errorMessage}`);
      return { kind: 'error', error: errorMessage };
    }
  }

  /**
   * Handle image resize request from webview
   * Backs up the original image, then overwrites the original file in-place.
   */
  private async handleResizeImage(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const imagePath = message.imagePath as string;
    const absolutePathFromMessage = message.absolutePath as string | undefined;
    const newWidth = message.newWidth as number;
    const newHeight = message.newHeight as number;
    const originalWidth = message.originalWidth as number | undefined;
    const originalHeight = message.originalHeight as number | undefined;
    const imageData = message.imageData as string; // base64 data URL

    console.warn(`[MD4H] Resizing image: ${imagePath} to ${newWidth}x${newHeight}`);

    try {
      // If absolute path provided (edit in place), use it directly
      // Otherwise resolve relative to document
      let absolutePath: string;
      let imageUri: vscode.Uri;

      if (absolutePathFromMessage) {
        // Editing in place (image outside workspace)
        absolutePath = absolutePathFromMessage;
        imageUri = vscode.Uri.file(absolutePath);
      } else {
        // Normal case: resolve relative to document base path
        const basePath = this.getImageBasePath(document);
        if (!basePath) {
          throw new Error('Cannot resolve image path: no base directory available');
        }
        const normalizedPath = normalizeImagePath(imagePath);
        absolutePath = path.resolve(basePath, normalizedPath);
        imageUri = vscode.Uri.file(absolutePath);
      }

      // SECURITY: gate the write target.
      // - "Normal" path (no absolutePathFromMessage): must stay inside the
      //   document/workspace roots. Defends against `<img src="../../etc/x">`.
      // - "Edit in place" path (absolutePathFromMessage): if the file is
      //   outside every allowed root, require explicit user confirmation
      //   showing the resolved path before we write. The webview is the
      //   only legitimate source of this message, but any extension or
      //   misbehaving page could send it; a one-click confirm makes the
      //   destination visible.
      // See SECURITY review §H2.
      const allowedRoots = this.getAllowedFileRoots(document);
      const insideAllowedRoot = allowedRoots.some(root =>
        isPathContainedWithin(absolutePath, root)
      );
      if (!insideAllowedRoot) {
        if (!absolutePathFromMessage) {
          throw new Error(`Refusing to resize image outside the document/workspace: ${imagePath}`);
        }
        const choice = await vscode.window.showWarningMessage(
          `Resize will overwrite a file outside this workspace:\n\n${absolutePath}\n\nProceed?`,
          { modal: true },
          'Overwrite'
        );
        if (choice !== 'Overwrite') {
          throw new Error('Resize cancelled by user.');
        }
      }

      // Check if image exists
      try {
        await vscode.workspace.fs.stat(imageUri);
      } catch {
        throw new Error(`Image not found: ${imagePath}`);
      }

      // Copy original to backup (workspace-scoped; never write backups next to external files)
      const originalData = await vscode.workspace.fs.readFile(imageUri);
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        throw new Error('Cannot compute backup path: no base directory available');
      }

      const backupWorkspaceRoot = this.getWorkspaceFolderPath(document) ?? basePath;
      const backupLocation = buildResizeBackupLocation({
        backupWorkspaceRoot,
        imageAbsolutePath: absolutePath,
        oldWidth: typeof originalWidth === 'number' && originalWidth > 0 ? originalWidth : newWidth,
        oldHeight:
          typeof originalHeight === 'number' && originalHeight > 0 ? originalHeight : newHeight,
        now: new Date(),
      });

      // Ensure backup root directory exists (flat structure - single directory)
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(backupLocation.backupDir));

      // Resolve backup path with collision detection
      const finalBackupPath = await resolveBackupPathWithCollisionDetection(
        backupLocation.backupFilePath
      );

      await vscode.workspace.fs.writeFile(vscode.Uri.file(finalBackupPath), originalData);
      console.warn(`[MD4H] Backup created: ${finalBackupPath}`);

      // Convert base64 data URL to buffer
      const base64Data = imageData.split(',')[1]; // Remove data:image/png;base64, prefix
      const buffer = Buffer.from(base64Data, 'base64');

      // Overwrite the original file in place (path remains unchanged).
      await vscode.workspace.fs.writeFile(imageUri, buffer);
      console.warn(`[MD4H] Image resized in-place: ${absolutePath}`);

      const relativeBackupPath = path.relative(basePath, finalBackupPath).replace(/\\/g, '/');
      const normalizedBackupPath =
        relativeBackupPath.startsWith('..') || relativeBackupPath.startsWith('./')
          ? relativeBackupPath
          : `./${relativeBackupPath}`;

      webview.postMessage({
        type: 'imageResized',
        success: true,
        imagePath,
        backupPath: normalizedBackupPath,
        newWidth, // Pass new dimensions so metadata can be updated immediately
        newHeight,
        timestamp: Date.now(), // Cache-busting
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to resize image: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to resize image: ${errorMessage}`);
      webview.postMessage({
        type: 'imageResized',
        success: false,
        error: errorMessage,
      });
    }
  }

  /**
   * Handle undo resize request from webview
   * Restores image from backup
   */
  private async handleUndoResize(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const imagePath = message.imagePath as string;
    const backupPath = message.backupPath as string;

    console.warn(`[MD4H] Undoing resize: restoring ${imagePath} from ${backupPath}`);

    try {
      // Resolve paths using base path
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        throw new Error('Cannot resolve image path: no base directory available');
      }
      const normalizedImagePath = normalizeImagePath(imagePath);
      const normalizedBackupPath = normalizeImagePath(backupPath);
      const absoluteImagePath = path.resolve(basePath, normalizedImagePath);
      const absoluteBackupPath = path.resolve(basePath, normalizedBackupPath);

      const allowedRoots = this.getAllowedFileRoots(document);
      if (!allowedRoots.some(root => isPathContainedWithin(absoluteImagePath, root))) {
        throw new Error(
          `Refusing to undo resize for image outside the document/workspace: ${imagePath}`
        );
      }

      const imageUri = vscode.Uri.file(absoluteImagePath);
      const backupUri = vscode.Uri.file(absoluteBackupPath);

      // Check if backup exists
      try {
        await vscode.workspace.fs.stat(backupUri);
      } catch {
        throw new Error(`Backup not found: ${backupPath}`);
      }

      // Restore from backup
      const backupData = await vscode.workspace.fs.readFile(backupUri);
      await vscode.workspace.fs.writeFile(imageUri, backupData);
      console.warn(`[MD4H] Image restored from backup`);

      webview.postMessage({
        type: 'imageUndoResized',
        success: true,
        imagePath,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to undo resize: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to undo resize: ${errorMessage}`);
      webview.postMessage({
        type: 'imageUndoResized',
        success: false,
        error: errorMessage,
      });
    }
  }

  /**
   * Handle redo resize request from webview
   * Reapplies resize operation
   */
  private async handleRedoResize(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const imagePath = message.imagePath as string;
    const newWidth = message.newWidth as number;
    const newHeight = message.newHeight as number;
    const imageData = message.imageData as string;

    console.warn(`[MD4H] Redoing resize: ${imagePath} to ${newWidth}x${newHeight}`);

    try {
      // Resolve image path using base path
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        throw new Error('Cannot resolve image path: no base directory available');
      }
      const normalizedPath = normalizeImagePath(imagePath);
      const absolutePath = path.resolve(basePath, normalizedPath);

      const allowedRoots = this.getAllowedFileRoots(document);
      if (!allowedRoots.some(root => isPathContainedWithin(absolutePath, root))) {
        throw new Error(
          `Refusing to redo resize for image outside the document/workspace: ${imagePath}`
        );
      }

      const imageUri = vscode.Uri.file(absolutePath);

      // Convert base64 to buffer
      const base64Data = imageData.split(',')[1];
      const buffer = Buffer.from(base64Data, 'base64');

      // Save resized image
      await vscode.workspace.fs.writeFile(imageUri, buffer);
      console.warn(`[MD4H] Image resize redone successfully`);

      webview.postMessage({
        type: 'imageRedoResized',
        success: true,
        imagePath,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to redo resize: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to redo resize: ${errorMessage}`);
      webview.postMessage({
        type: 'imageRedoResized',
        success: false,
        error: errorMessage,
      });
    }
  }

  /**
   * Compute image reference counts across the workspace for UI previews.
   *
   * Returns:
   * - currentFileCount: number of occurrences in the current document
   * - otherFiles: list of other markdown files referencing the same image (with line numbers)
   */
  private async handleGetImageReferences(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const requestId = message.requestId as string;
    const imagePath = message.imagePath as string;

    try {
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        throw new Error('Cannot resolve image base path');
      }

      const normalizedTargetPath = normalizeImagePath(imagePath);
      const absoluteTargetPath = path.resolve(basePath, normalizedTargetPath);
      const normalizedAbsoluteTarget = path.normalize(absoluteTargetPath);

      const fileDir = document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : basePath;

      const imageRefRegex = /!\[([^\]]*)\]\(([^)]+)\)|<img[^>]+src=["']([^"']+)["']/g;
      const currentFileMatches: Array<{ line: number; text: string }> = [];
      const lines = document.getText().split('\n');

      lines.forEach((line, index) => {
        imageRefRegex.lastIndex = 0;
        let match;
        while ((match = imageRefRegex.exec(line)) !== null) {
          const ref = match[2] || match[3];
          if (!ref) continue;

          const normalizedRefPath = normalizeImagePath(ref);
          const absoluteRefPath = path.isAbsolute(normalizedRefPath)
            ? normalizedRefPath
            : path.resolve(fileDir, normalizedRefPath);
          if (path.normalize(absoluteRefPath) === normalizedAbsoluteTarget) {
            currentFileMatches.push({ line: index, text: line });
          }
        }
      });

      const allReferences = await this.findImageReferences(imagePath, basePath);
      const otherFiles =
        document.uri.scheme === 'file'
          ? allReferences.filter(ref => ref.file.fsPath !== document.uri.fsPath)
          : allReferences;

      webview.postMessage({
        type: 'imageReferences',
        requestId,
        imagePath,
        currentFileCount: currentFileMatches.length,
        otherFiles: otherFiles.map(ref => ({
          fsPath: ref.file.fsPath,
          matches: ref.matches,
        })),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to compute image references: ${errorMessage}`);
      webview.postMessage({
        type: 'imageReferences',
        requestId,
        imagePath,
        currentFileCount: 0,
        otherFiles: [],
        error: errorMessage,
      });
    }
  }

  private async handleOpenFileAtLocation(message: {
    type: string;
    [key: string]: unknown;
  }): Promise<void> {
    const fsPath = message.fsPath as string;
    const line = message.line as number | undefined;
    const openToSide = (message.openToSide as boolean) ?? false;

    try {
      if (!fsPath) {
        throw new Error('Missing fsPath');
      }

      const uri = vscode.Uri.file(fsPath);
      const doc = await vscode.workspace.openTextDocument(uri);

      const zeroBasedLine = typeof line === 'number' && line > 0 ? line - 1 : 0;
      const position = new vscode.Position(zeroBasedLine, 0);
      const selection = new vscode.Range(position, position);

      await vscode.window.showTextDocument(doc, {
        viewColumn: openToSide ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
        selection,
        preserveFocus: false,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to open file: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to open file: ${errorMessage}`);
    }
  }

  /**
   * Find all markdown files that reference an image
   */
  private async findImageReferences(
    oldImagePath: string,
    basePath: string
  ): Promise<Array<{ file: vscode.Uri; matches: Array<{ line: number; text: string }> }>> {
    // Find all markdown files
    const markdownFiles = await vscode.workspace.findFiles('**/*.md', null, 1000);

    const results: Array<{ file: vscode.Uri; matches: Array<{ line: number; text: string }> }> = [];

    // Normalize the old path for comparison
    const normalizedOldPath = normalizeImagePath(oldImagePath);
    const absoluteOldPath = path.resolve(basePath, normalizedOldPath);

    for (const file of markdownFiles) {
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        const lines = text.split('\n');

        // Match markdown image syntax: ![alt](path) and <img src="path">
        const imageRefRegex = /!\[([^\]]*)\]\(([^)]+)\)|<img[^>]+src=["']([^"']+)["']/g;
        const matches: Array<{ line: number; text: string }> = [];

        lines.forEach((line, index) => {
          let match;
          // Reset regex lastIndex for each line
          imageRefRegex.lastIndex = 0;
          while ((match = imageRefRegex.exec(line)) !== null) {
            const imagePath = match[2] || match[3]; // Markdown or HTML syntax
            if (!imagePath) continue;

            // Normalize the path from the markdown file
            const fileDir = path.dirname(file.fsPath);
            const normalizedRefPath = normalizeImagePath(imagePath);
            let absoluteRefPath: string;

            // Handle different path formats
            if (path.isAbsolute(normalizedRefPath)) {
              absoluteRefPath = normalizedRefPath;
            } else if (normalizedRefPath.startsWith('./') || normalizedRefPath.startsWith('../')) {
              absoluteRefPath = path.resolve(fileDir, normalizedRefPath);
            } else {
              // Relative path without ./ prefix
              absoluteRefPath = path.resolve(fileDir, normalizedRefPath);
            }

            // Normalize paths for comparison (handle different separators)
            const normalizedAbsoluteOld = path.normalize(absoluteOldPath);
            const normalizedAbsoluteRef = path.normalize(absoluteRefPath);

            // Check if paths match (same file)
            if (normalizedAbsoluteOld === normalizedAbsoluteRef) {
              matches.push({ line: index, text: line });
            }
          }
        });

        if (matches.length > 0) {
          results.push({ file, matches });
        }
      } catch (error) {
        // Skip files that can't be read
        console.warn(`[MD4H] Failed to read file ${file.fsPath}: ${error}`);
      }
    }

    return results;
  }

  /**
   * Update image references in markdown files
   */
  private async updateImageReferences(
    references: Array<{ file: vscode.Uri; matches: Array<{ line: number; text: string }> }>,
    oldFilename: string,
    newFilename: string
  ): Promise<number> {
    const edit = new vscode.WorkspaceEdit();
    let filesUpdated = 0;

    for (const { file, matches } of references) {
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        const lines = text.split('\n');

        // Escape filename for regex
        const escapedOldFilename = oldFilename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Match the filename when preceded by / or ( and followed by ) or " or '
        // This ensures we only replace in path contexts, not random text
        const imagePathRegex = new RegExp(`([(/])${escapedOldFilename}([)"'])`, 'g');

        let updated = false;
        const updatedLines = lines.map((line, index) => {
          // Only update lines that have matches
          if (matches.some(m => m.line === index)) {
            const updatedLine = line.replace(imagePathRegex, `$1${newFilename}$2`);
            if (updatedLine !== line) {
              updated = true;
              return updatedLine;
            }
          }
          return line;
        });

        if (updated) {
          const updatedText = updatedLines.join('\n');
          edit.replace(file, new vscode.Range(0, 0, doc.lineCount, 0), updatedText);
          filesUpdated++;
        }
      } catch (error) {
        console.warn(`[MD4H] Failed to update file ${file.fsPath}: ${error}`);
      }
    }

    if (filesUpdated > 0) {
      await vscode.workspace.applyEdit(edit);
    }

    return filesUpdated;
  }

  private async handleCheckImageRename(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const requestId = message.requestId as string;
    const oldPath = message.oldPath as string;
    const newName = message.newName as string;

    try {
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        throw new Error('Cannot resolve image path: no base directory available');
      }

      const normalizedOldPath = normalizeImagePath(oldPath);
      const absoluteOldPath = path.resolve(basePath, normalizedOldPath);
      const oldUri = vscode.Uri.file(absoluteOldPath);

      // Ensure the source exists
      await vscode.workspace.fs.stat(oldUri);

      const oldExt = path.extname(absoluteOldPath);
      const newFilename = buildImageFilenameForUserRename(newName, oldExt);

      const oldDir = path.dirname(absoluteOldPath);
      const absoluteNewPath = path.join(oldDir, newFilename);
      const newUri = vscode.Uri.file(absoluteNewPath);

      let exists = false;
      try {
        await vscode.workspace.fs.stat(newUri);
        exists = true;
      } catch {
        exists = false;
      }

      const relativeNewPath = path.relative(basePath, absoluteNewPath).replace(/\\/g, '/');
      const normalizedNewPath = relativeNewPath.startsWith('.')
        ? relativeNewPath
        : `./${relativeNewPath}`;

      webview.postMessage({
        type: 'imageRenameCheck',
        requestId,
        exists,
        newFilename,
        newPath: normalizedNewPath,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to check rename target: ${errorMessage}`);
      webview.postMessage({
        type: 'imageRenameCheck',
        requestId,
        exists: false,
        newFilename: '',
        newPath: '',
        error: errorMessage,
      });
    }
  }

  /**
   * Handle image rename request from webview
   * Renames the file and updates references in markdown files across workspace
   */
  private async handleRenameImage(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const oldPath = message.oldPath as string;
    const newName = message.newName as string;
    const updateAllReferences = (message.updateAllReferences as boolean) ?? true;
    const allowOverwrite = (message.allowOverwrite as boolean) ?? false;

    console.warn(`[MD4H] Renaming image: ${oldPath} to ${newName}`);

    try {
      // Resolve the old path
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        throw new Error('Cannot resolve image path: no base directory available');
      }

      const normalizedOldPath = normalizeImagePath(oldPath);
      const absoluteOldPath = path.resolve(basePath, normalizedOldPath);
      const oldUri = vscode.Uri.file(absoluteOldPath);

      // SECURITY: reject paths that escape the document/workspace roots.
      // Without this, a hostile markdown file could rename arbitrary files
      // on disk (e.g. ![](../../../../etc/hosts)) on a single user click.
      const allowedRoots = this.getAllowedFileRoots(document);
      if (!allowedRoots.some(root => isPathContainedWithin(absoluteOldPath, root))) {
        throw new Error(`Refusing to rename image outside the document/workspace: ${oldPath}`);
      }

      // Check if old file exists
      try {
        await vscode.workspace.fs.stat(oldUri);
      } catch {
        throw new Error(`Image not found: ${oldPath}`);
      }

      // Get old filename (used for reference updates)
      const oldFilename = path.basename(absoluteOldPath);

      // Build new filename for manual rename:
      // - Respect the user's chosen name (no auto-dimensions, no auto prefix)
      const oldExt = path.extname(absoluteOldPath);
      const newFilename = buildImageFilenameForUserRename(newName, oldExt);

      const oldDir = path.dirname(absoluteOldPath);
      const absoluteNewPath = path.join(oldDir, newFilename);
      const newUri = vscode.Uri.file(absoluteNewPath);

      // SECURITY: also confirm the destination is contained. Defends against
      // a maliciously crafted `newName` (e.g. `../../../etc/passwd`) that
      // would otherwise escape via the dirname join above.
      if (!allowedRoots.some(root => isPathContainedWithin(absoluteNewPath, root))) {
        throw new Error(
          `Refusing to rename image to a path outside the document/workspace: ${newFilename}`
        );
      }

      // Check if new file already exists
      let targetExists = false;
      try {
        await vscode.workspace.fs.stat(newUri);
        targetExists = true;
      } catch {
        targetExists = false;
      }

      if (targetExists && !allowOverwrite) {
        throw new Error(`File already exists: ${newFilename}`);
      }

      // Find all references if updating all files
      let references: Array<{ file: vscode.Uri; matches: Array<{ line: number; text: string }> }> =
        [];
      if (updateAllReferences) {
        references = await this.findImageReferences(oldPath, basePath);
      }

      if (targetExists && allowOverwrite) {
        try {
          await vscode.workspace.fs.delete(newUri, { useTrash: true });
        } catch (error) {
          console.warn(`[MD4H] Could not move existing file to trash, deleting directly: ${error}`);
          await vscode.workspace.fs.delete(newUri);
        }
      }

      // Rename the file
      await vscode.workspace.fs.rename(oldUri, newUri);
      console.warn(`[MD4H] File renamed to: ${newFilename}`);

      // Calculate new relative path for markdown
      const newRelativePath = path.relative(basePath, absoluteNewPath).replace(/\\/g, '/');
      const normalizedNewPath = newRelativePath.startsWith('.')
        ? newRelativePath
        : `./${newRelativePath}`;

      // Update references
      let filesUpdated = 0;
      if (updateAllReferences && references.length > 0) {
        filesUpdated = await this.updateImageReferences(references, oldFilename, newFilename);
      } else {
        // Update only current document
        const docText = document.getText();
        const escapedOldFilename = oldFilename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const imagePathRegex = new RegExp(`([(/])${escapedOldFilename}([)"'])`, 'g');
        const updatedText = docText.replace(imagePathRegex, `$1${newFilename}$2`);

        if (updatedText !== docText) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), updatedText);
          await vscode.workspace.applyEdit(edit);
          filesUpdated = 1;
        }
      }

      // Notify webview of success
      webview.postMessage({
        type: 'imageRenamed',
        success: true,
        oldPath,
        newPath: normalizedNewPath,
        filesUpdated,
      });

      if (filesUpdated > 1) {
        vscode.window.showInformationMessage(
          `Image renamed to ${newFilename} (updated ${filesUpdated} files)`
        );
      } else {
        vscode.window.showInformationMessage(`Image renamed to ${newFilename}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to rename image: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to rename image: ${errorMessage}`);
      webview.postMessage({
        type: 'imageRenamed',
        success: false,
        error: errorMessage,
      });
    }
  }

  /**
   * Check if image is in workspace
   */
  private async handleCheckImageInWorkspace(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const imagePath = message.imagePath as string;
    const requestId = message.requestId as string;

    try {
      // Resolve image path relative to document base path
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        webview.postMessage({
          type: 'imageWorkspaceCheck',
          requestId,
          inWorkspace: false,
          absolutePath: undefined,
        });
        return;
      }
      const normalizedPath = normalizeImagePath(imagePath);
      const absolutePath = path.resolve(basePath, normalizedPath);

      // Check if file exists
      const imageUri = vscode.Uri.file(absolutePath);
      let fileExists = false;
      try {
        await vscode.workspace.fs.stat(imageUri);
        fileExists = true;
      } catch {
        fileExists = false;
      }

      // Check if path is within workspace
      // For untitled files, getWorkspaceFolder may not work, so check workspaceFolders first
      let workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (
        !workspaceFolder &&
        document.uri.scheme === 'untitled' &&
        vscode.workspace.workspaceFolders &&
        vscode.workspace.workspaceFolders.length > 0
      ) {
        workspaceFolder = vscode.workspace.workspaceFolders[0];
      }

      let inWorkspace = false;

      if (workspaceFolder && fileExists) {
        const workspacePath = workspaceFolder.uri.fsPath;
        // Check if absolute path is within workspace
        inWorkspace =
          absolutePath.startsWith(workspacePath + path.sep) || absolutePath === workspacePath;
      }

      webview.postMessage({
        type: 'imageWorkspaceCheck',
        requestId,
        inWorkspace,
        absolutePath: fileExists ? absolutePath : undefined,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to check image in workspace: ${errorMessage}`);
      webview.postMessage({
        type: 'imageWorkspaceCheck',
        requestId,
        inWorkspace: false,
        absolutePath: undefined,
      });
    }
  }

  /**
   * Get image metadata (file size, dimensions, last modified, etc.)
   */
  private async handleGetImageMetadata(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const imagePath = message.imagePath as string;
    const requestId = message.requestId as string;

    try {
      // Resolve image path relative to document base path
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        webview.postMessage({
          type: 'imageMetadata',
          requestId,
          metadata: null,
        });
        return;
      }

      const normalizedPath = normalizeImagePath(imagePath);
      const absolutePath = path.resolve(basePath, normalizedPath);
      const imageUri = vscode.Uri.file(absolutePath);

      // Check if file exists
      let fileStat: vscode.FileStat;
      try {
        fileStat = await vscode.workspace.fs.stat(imageUri);
      } catch {
        webview.postMessage({
          type: 'imageMetadata',
          requestId,
          metadata: null,
        });
        return;
      }

      // Get image dimensions (requires reading the file)
      // For now, we'll use file size and last modified
      // Dimensions would require image decoding which is expensive
      // We can get dimensions from the img element in the webview instead
      const filename = path.basename(absolutePath);
      const relativePath = path.relative(basePath, absolutePath).replace(/\\/g, '/');
      const normalizedRelativePath = relativePath.startsWith('.')
        ? relativePath
        : `./${relativePath}`;

      webview.postMessage({
        type: 'imageMetadata',
        requestId,
        metadata: {
          filename,
          size: fileStat.size,
          dimensions: { width: 0, height: 0 }, // Will be filled by webview from img element
          lastModified: fileStat.mtime,
          path: normalizedRelativePath,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to get image metadata: ${errorMessage}`);
      webview.postMessage({
        type: 'imageMetadata',
        requestId,
        metadata: null,
      });
    }
  }

  /**
   * Handle reveal image in OS file manager (Finder/Explorer)
   */
  private async handleRevealImageInOS(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument
  ): Promise<void> {
    const imagePath = message.imagePath as string;

    try {
      // Check if image is external (http/https/data URI)
      if (
        imagePath.startsWith('http://') ||
        imagePath.startsWith('https://') ||
        imagePath.startsWith('data:')
      ) {
        vscode.window.showErrorMessage('Cannot reveal external images in file manager');
        return;
      }

      // Resolve image path relative to document base path
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        vscode.window.showErrorMessage('Cannot reveal image: no base directory available');
        return;
      }

      const normalizedPath = normalizeImagePath(imagePath);
      const absolutePath = path.resolve(basePath, normalizedPath);
      const fileUri = vscode.Uri.file(absolutePath);

      // Check if file exists
      try {
        await vscode.workspace.fs.stat(fileUri);
      } catch {
        vscode.window.showErrorMessage(`Image not found: ${imagePath}`);
        return;
      }

      // Reveal file in OS file manager
      await vscode.commands.executeCommand('revealFileInOS', fileUri);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to reveal image in OS: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to reveal image: ${errorMessage}`);
    }
  }

  /**
   * Handle reveal image in VS Code Explorer
   */
  private async handleRevealImageInExplorer(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument
  ): Promise<void> {
    const imagePath = message.imagePath as string;

    try {
      // Check if image is external (http/https/data URI)
      if (
        imagePath.startsWith('http://') ||
        imagePath.startsWith('https://') ||
        imagePath.startsWith('data:')
      ) {
        vscode.window.showErrorMessage('Cannot reveal external images in Explorer');
        return;
      }

      // Resolve image path relative to document base path
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        vscode.window.showErrorMessage('Cannot reveal image: no base directory available');
        return;
      }

      const normalizedPath = normalizeImagePath(imagePath);
      const absolutePath = path.resolve(basePath, normalizedPath);
      const fileUri = vscode.Uri.file(absolutePath);

      // Check if file exists
      try {
        await vscode.workspace.fs.stat(fileUri);
      } catch {
        vscode.window.showErrorMessage(`Image not found: ${imagePath}`);
        return;
      }

      // Reveal file in VS Code Explorer
      await vscode.commands.executeCommand('revealInExplorer', fileUri);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to reveal image in Explorer: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to reveal image: ${errorMessage}`);
    }
  }

  /**
   * File extension categories for filtering
   */
  private readonly FILE_CATEGORIES = {
    md: ['.md', '.markdown'],
    images: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'],
    code: [
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.py',
      '.java',
      '.cpp',
      '.c',
      '.h',
      '.go',
      '.rs',
      '.rb',
      '.php',
      '.swift',
      '.kt',
      '.cs',
      '.sh',
      '.bash',
      '.zsh',
      '.fish',
    ],
    config: ['.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf', '.config', '.properties'],
  };

  /**
   * Handle file search request from webview
   */
  private async handleSearchFiles(
    message: { type: string; [key: string]: unknown },
    webview: vscode.Webview
  ): Promise<void> {
    try {
      const query = (message.query as string) || '';
      const filters = (message.filters as {
        all?: boolean;
        md?: boolean;
        images?: boolean;
        code?: boolean;
        config?: boolean;
      }) || { all: true };
      const requestId = (message.requestId as number) || 0;

      console.warn('[MD4H] File search request:', { query, filters, requestId });

      if (!query || query.trim().length < 1) {
        console.warn('[MD4H] Empty query, returning empty results');
        webview.postMessage({
          type: 'fileSearchResults',
          results: [],
          requestId,
        });
        return;
      }

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        console.warn('[MD4H] No workspace folders found');
        webview.postMessage({
          type: 'fileSearchResults',
          results: [],
          requestId,
        });
        return;
      }

      // More permissive exclude pattern - only exclude truly unnecessary directories
      const excludePattern =
        '{**/node_modules/**,**/.git/**,**/.vscode/**,**/dist/**,**/build/**,**/.next/**,**/coverage/**}';
      console.warn('[MD4H] Searching files with pattern:', excludePattern);

      // Use a more conservative limit (2000) to prevent memory pressure in massive repositories
      // while still providing enough results for most users.
      const allFiles = await vscode.workspace.findFiles(
        '**/*',
        excludePattern,
        MarkdownEditorProvider.MAX_FILE_SEARCH_RESULTS
      );
      console.warn('[MD4H] Found', allFiles.length, 'files total');

      let filteredFiles = allFiles;
      if (!filters.all) {
        const allowedExtensions = new Set<string>();
        if (filters.md) {
          this.FILE_CATEGORIES.md.forEach(ext => allowedExtensions.add(ext));
        }
        if (filters.images) {
          this.FILE_CATEGORIES.images.forEach(ext => allowedExtensions.add(ext));
        }
        if (filters.code) {
          this.FILE_CATEGORIES.code.forEach(ext => allowedExtensions.add(ext));
        }
        if (filters.config) {
          this.FILE_CATEGORIES.config.forEach(ext => allowedExtensions.add(ext));
        }

        filteredFiles = allFiles.filter(uri => {
          const ext = path.extname(uri.fsPath).toLowerCase();
          return allowedExtensions.has(ext);
        });
        console.warn('[MD4H] After filter:', filteredFiles.length, 'files');
      }

      const queryLower = query.toLowerCase().trim();
      const queryParts = queryLower.split(/\s+/).filter(p => p.length > 0);

      // Enhanced matching: search by filename, path, and individual query parts
      const matchingFiles = filteredFiles.filter(uri => {
        const filename = path.basename(uri.fsPath);
        const filenameLower = filename.toLowerCase();
        const relativePath = this.getRelativePath(uri, workspaceFolders[0].uri);
        const pathLower = relativePath.toLowerCase();

        // Primary match: filename contains query
        if (filenameLower.includes(queryLower)) {
          return true;
        }

        // Secondary match: path contains query
        if (pathLower.includes(queryLower)) {
          return true;
        }

        // Tertiary match: all query parts appear in filename or path
        if (queryParts.length > 1) {
          const allPartsMatch = queryParts.every(
            part => filenameLower.includes(part) || pathLower.includes(part)
          );
          if (allPartsMatch) {
            return true;
          }
        }

        // Match filename without extension
        const filenameWithoutExt = path.parse(filename).name.toLowerCase();
        if (filenameWithoutExt.includes(queryLower)) {
          return true;
        }

        return false;
      });

      console.warn('[MD4H] Found', matchingFiles.length, 'matching files');

      // Sort results: exact filename matches first, then path matches, then partial matches
      const sortedFiles = matchingFiles.sort((a, b) => {
        const aFilename = path.basename(a.fsPath).toLowerCase();
        const bFilename = path.basename(b.fsPath).toLowerCase();
        const aPath = this.getRelativePath(a, workspaceFolders[0].uri).toLowerCase();
        const bPath = this.getRelativePath(b, workspaceFolders[0].uri).toLowerCase();

        // Exact filename match gets highest priority
        const aExactMatch = aFilename === queryLower;
        const bExactMatch = bFilename === queryLower;
        if (aExactMatch && !bExactMatch) return -1;
        if (!aExactMatch && bExactMatch) return 1;

        // Filename starts with query gets second priority
        const aStartsWith = aFilename.startsWith(queryLower);
        const bStartsWith = bFilename.startsWith(queryLower);
        if (aStartsWith && !bStartsWith) return -1;
        if (!aStartsWith && bStartsWith) return 1;

        // Filename contains query gets third priority
        const aFilenameContains = aFilename.includes(queryLower);
        const bFilenameContains = bFilename.includes(queryLower);
        if (aFilenameContains && !bFilenameContains) return -1;
        if (!aFilenameContains && bFilenameContains) return 1;

        // Path contains query gets fourth priority
        const aPathContains = aPath.includes(queryLower);
        const bPathContains = bPath.includes(queryLower);
        if (aPathContains && !bPathContains) return -1;
        if (!aPathContains && bPathContains) return 1;

        // Alphabetical by filename
        return aFilename.localeCompare(bFilename);
      });

      const results = sortedFiles.slice(0, 20).map(uri => {
        const filename = path.basename(uri.fsPath);
        const relativePath = this.getRelativePath(uri, workspaceFolders[0].uri);
        return {
          filename,
          path: relativePath,
        };
      });

      console.warn('[MD4H] Sending', results.length, 'results to webview');
      webview.postMessage({
        type: 'fileSearchResults',
        results,
        requestId,
      });
    } catch (error) {
      console.error('[MD4H] Error searching files:', error);
      const requestId = (message.requestId as number) || 0;
      webview.postMessage({
        type: 'fileSearchResults',
        results: [],
        requestId,
        error: 'Failed to search files',
      });
    }
  }

  /**
   * Get relative path from workspace root
   */
  private getRelativePath(fileUri: vscode.Uri, workspaceUri: vscode.Uri): string {
    const filePath = fileUri.fsPath;
    const workspacePath = workspaceUri.fsPath;

    if (filePath.startsWith(workspacePath)) {
      let relative = path.relative(workspacePath, filePath);
      relative = relative.replace(/\\/g, '/');
      return relative;
    }

    return path.basename(filePath);
  }

  /**
   * Handle external link navigation (open in browser)
   */
  private async handleOpenExternalLink(message: {
    type: string;
    [key: string]: unknown;
  }): Promise<void> {
    try {
      const url = (message.url as string) || '';
      console.warn('[MD4H] handleOpenExternalLink called with URL:', url);

      if (!url) {
        console.warn('[MD4H] No URL provided for external link');
        return;
      }

      // Validate URL format
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('mailto:')) {
        console.warn('[MD4H] Invalid external URL format:', url);
        return;
      }

      console.warn('[MD4H] Opening external link:', url);
      await vscode.env.openExternal(vscode.Uri.parse(url));
      console.warn('[MD4H] Successfully opened external link');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[MD4H] Failed to open external link:', errorMessage, error);
      vscode.window.showErrorMessage(`Failed to open link: ${errorMessage}`);
    }
  }

  /**
   * Handle image link navigation (open image in VS Code preview)
   */
  private async handleOpenImage(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument
  ): Promise<void> {
    const imagePath = String(message.path || '');
    if (!imagePath) {
      console.warn('[MD4H] No image path provided');
      return;
    }

    console.warn('[MD4H] handleOpenImage called with path:', imagePath);

    // Normalize path: remove ./ prefix if present for path resolution
    const normalizedPath = imagePath.startsWith('./') ? imagePath.slice(2) : imagePath;

    // Try document-relative first
    let baseDir: string | undefined;
    if (document.uri.scheme === 'file') {
      baseDir = path.dirname(document.uri.fsPath);
    } else {
      baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    if (!baseDir) {
      console.error('[MD4H] Cannot resolve image path: no base directory');
      vscode.window.showWarningMessage('Cannot resolve image path');
      return;
    }

    let imageFullPath = path.resolve(baseDir, normalizedPath);
    let imageUri = vscode.Uri.file(imageFullPath);
    console.warn('[MD4H] Trying document-relative path:', imageFullPath);

    // Check if file exists at document-relative path
    let fileExists = false;
    try {
      await vscode.workspace.fs.stat(imageUri);
      fileExists = true;
      console.warn('[MD4H] Image found at document-relative path');
    } catch {
      console.warn('[MD4H] Image not found at document-relative path, trying workspace root');

      // Fallback: try workspace root
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const workspacePath = workspaceFolder.uri.fsPath;
        imageFullPath = path.resolve(workspacePath, normalizedPath);
        imageUri = vscode.Uri.file(imageFullPath);
        console.warn('[MD4H] Trying workspace-relative path:', imageFullPath);

        try {
          await vscode.workspace.fs.stat(imageUri);
          fileExists = true;
          console.warn('[MD4H] Image found at workspace-relative path');
        } catch {
          console.warn('[MD4H] Image not found at workspace-relative path either');
        }
      }
    }

    if (!fileExists) {
      const errorMsg = `Image not found: ${imagePath}`;
      console.error('[MD4H]', errorMsg);
      vscode.window.showErrorMessage(errorMsg);
      return;
    }

    try {
      console.warn('[MD4H] Opening image:', imageUri.fsPath);
      await vscode.commands.executeCommand('vscode.open', imageUri);
      console.warn('[MD4H] Successfully opened image');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('[MD4H] Failed to open image:', errorMessage, err);
      vscode.window.showErrorMessage(`Failed to open image: ${errorMessage}`);
    }
  }

  /**
   * Handle file link navigation (open file in VS Code)
   */
  private async handleOpenFileLink(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument
  ): Promise<void> {
    try {
      const filePath = (message.path as string) || '';
      console.warn('[MD4H] handleOpenFileLink called with path:', filePath);

      if (!filePath) {
        console.warn('[MD4H] No path provided for file link');
        return;
      }

      // Resolve relative path from current document
      const basePath = path.dirname(document.uri.fsPath);

      // Normalize path: remove ./ prefix if present for path resolution
      const normalizedFilePath = filePath.startsWith('./') ? filePath.slice(2) : filePath;
      const absolutePath = path.resolve(basePath, normalizedFilePath);
      let fileUri = vscode.Uri.file(absolutePath);
      console.warn('[MD4H] Resolved file URI (document-relative):', fileUri.fsPath);

      // Check if file exists
      let fileExists = false;
      try {
        await vscode.workspace.fs.stat(fileUri);
        fileExists = true;
        console.warn('[MD4H] File exists (document-relative):', fileUri.fsPath);
      } catch {
        // File doesn't exist, try to find it in workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          // Try relative to workspace root
          const workspacePath = workspaceFolders[0].uri.fsPath;
          // Use normalized path (already normalized above)
          const workspaceFileUri = vscode.Uri.file(path.resolve(workspacePath, normalizedFilePath));
          console.warn('[MD4H] Trying workspace-relative path:', workspaceFileUri.fsPath);
          try {
            await vscode.workspace.fs.stat(workspaceFileUri);
            fileUri = workspaceFileUri;
            fileExists = true;
            console.warn('[MD4H] File exists (workspace-relative):', fileUri.fsPath);
          } catch {
            // Not found in workspace either
            console.warn('[MD4H] File not found in workspace-relative path');
          }
        }
      }

      if (!fileExists) {
        // File not found, show error
        vscode.window.showWarningMessage(`File not found: ${filePath}`);
        console.warn('[MD4H] File not found:', filePath);
        return;
      }

      // Check if file is an image
      const imageExtensions = [
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.svg',
        '.webp',
        '.bmp',
        '.ico',
        '.tiff',
        '.tif',
      ];
      const fileExtension = path.extname(fileUri.fsPath).toLowerCase();
      const isImage = imageExtensions.includes(fileExtension);
      console.warn('[MD4H] File extension:', fileExtension, '| Is image:', isImage);

      if (isImage) {
        // For image files, use vscode.open command directly
        // This automatically opens images in VS Code's image preview
        console.warn('[MD4H] Attempting to open image file with vscode.open command');
        try {
          await vscode.commands.executeCommand('vscode.open', fileUri);
          console.warn('[MD4H] Successfully opened image file:', fileUri.fsPath);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error('[MD4H] Failed to open image file:', errorMessage, error);
          vscode.window.showErrorMessage(`Failed to open image file: ${errorMessage}`);
        }
      } else {
        // For text files, use openTextDocument
        console.warn('[MD4H] Attempting to open text file with openTextDocument');
        try {
          const doc = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(doc);
          console.warn('[MD4H] Successfully opened file link:', fileUri.fsPath);
        } catch (error) {
          // If it's not a text file, try vscode.open command as fallback
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.warn('[MD4H] openTextDocument failed, error:', errorMessage);
          if (errorMessage.includes('Binary') || errorMessage.includes('binary')) {
            console.warn('[MD4H] File is binary, trying vscode.open command as fallback');
            try {
              await vscode.commands.executeCommand('vscode.open', fileUri);
              console.warn('[MD4H] Opened binary file using vscode.open command');
            } catch (fallbackError) {
              console.error('[MD4H] Failed to open file:', fallbackError);
              vscode.window.showErrorMessage(`Failed to open file: ${errorMessage}`);
            }
          } else {
            throw error;
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[MD4H] Failed to open file link:', errorMessage, error);
      vscode.window.showErrorMessage(`Failed to open file: ${errorMessage}`);
    }
  }

  /**
   * Copy local image (outside workspace) to workspace
   */
  private async handleCopyLocalImageToWorkspace(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const absolutePath = message.absolutePath as string;
    const placeholderId = message.placeholderId as string;
    const targetFolder = (message.targetFolder as string) || 'images';

    console.warn(`[MD4H] Copying local image to workspace: ${absolutePath}`);

    try {
      // Read the source image
      const sourceUri = vscode.Uri.file(absolutePath);
      const imageData = await vscode.workspace.fs.readFile(sourceUri);

      const saveBasePath = this.getImageStorageBasePath(document);
      if (!saveBasePath) {
        const errorMessage = 'Cannot copy image: no base directory available';
        vscode.window.showErrorMessage(errorMessage);
        webview.postMessage({
          type: 'localImageCopyError',
          placeholderId,
          error: errorMessage,
        });
        return;
      }
      const imagesDir = path.join(saveBasePath, targetFolder);
      if (!isPathContainedWithin(imagesDir, saveBasePath)) {
        const errorMessage = `Refusing to copy image outside the base directory: ${targetFolder}`;
        vscode.window.showErrorMessage(errorMessage);
        webview.postMessage({ type: 'localImageCopyError', placeholderId, error: errorMessage });
        return;
      }

      // Create folder if needed
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(imagesDir));

      // Generate filename from source
      const sourceFilename = path.basename(absolutePath);
      const parsedName = path.parse(sourceFilename);
      const baseFilename = parsedName.name || 'image';
      const extension = parsedName.ext || '';

      let finalFilename = sourceFilename;
      let targetPath = path.join(imagesDir, finalFilename);
      let targetUri = vscode.Uri.file(targetPath);

      const fileExists = async (uri: vscode.Uri): Promise<boolean> => {
        try {
          await vscode.workspace.fs.stat(uri);
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('ENOENT') || message.includes('FileNotFound')) {
            return false;
          }
          throw error;
        }
      };

      if (await fileExists(targetUri)) {
        let foundAvailableName = false;
        for (let suffix = 2; suffix < 1000; suffix += 1) {
          finalFilename = `${baseFilename}-${suffix}${extension}`;
          targetPath = path.join(imagesDir, finalFilename);
          targetUri = vscode.Uri.file(targetPath);
          if (!(await fileExists(targetUri))) {
            foundAvailableName = true;
            break;
          }
        }
        if (!foundAvailableName) {
          throw new Error(
            `Cannot copy image: too many existing files matching "${baseFilename}-N${extension}"`
          );
        }
      }

      // Copy file to workspace
      await vscode.workspace.fs.writeFile(targetUri, imageData);

      // Calculate relative path for markdown
      const markdownDir =
        document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : saveBasePath;
      let relativePath = path.relative(markdownDir, targetPath).replace(/\\/g, '/');
      if (!relativePath.startsWith('..') && !relativePath.startsWith('./')) {
        relativePath = './' + relativePath;
      }

      console.warn(`[MD4H] Local image copied successfully. Path: ${relativePath}`);

      webview.postMessage({
        type: 'localImageCopied',
        placeholderId,
        relativePath,
        originalPath: absolutePath, // For finding the image node
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to copy local image: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to copy image: ${errorMessage}`);
      webview.postMessage({
        type: 'localImageCopyError',
        placeholderId,
        error: errorMessage,
      });
    }
  }

  /**
   * Handle setting update request from webview
   */
  private async handleUpdateSetting(
    message: { type: string; [key: string]: unknown },
    webview: vscode.Webview
  ): Promise<void> {
    const key = message.key as string;
    const value = message.value as unknown;

    try {
      const config = vscode.workspace.getConfiguration();
      await config.update(key, value, vscode.ConfigurationTarget.Global);
      console.warn(`[MD4H] Setting updated: ${key} = ${value}`);

      // Immediately notify webview of the setting change
      // This ensures the setting takes effect right away without waiting for next update
      const skipWarning = config.get<boolean>('markdownForHumans.imageResize.skipWarning', false);
      const imagePath = config.get<string>('markdownForHumans.imagePath', 'images');
      const imagePathBase = config.get<string>(
        'markdownForHumans.imagePathBase',
        'relativeToDocument'
      );
      webview.postMessage({
        type: 'settingsUpdate',
        skipResizeWarning: skipWarning,
        imagePath: imagePath,
        imagePathBase: imagePathBase,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to update setting: ${errorMessage}`);
    }
  }

  /**
   * After a Preserve↔Strip switch rewrites the document buffer, either save
   * the file automatically (if VS Code's `files.autoSave` is enabled) or tell
   * the user why their on-disk file doesn't yet reflect the new mode.
   *
   * Untitled documents are skipped — saving them would open a Save As dialog,
   * which isn't the behavior the setting change implies.
   */
  private async handleBlankLineModeSavePolicy(
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    if (document.uri.scheme === 'untitled') return;
    if (!document.isDirty) return;

    const autoSave = vscode.workspace.getConfiguration('files').get<string>('autoSave', 'off');

    if (autoSave !== 'off') {
      // Autosave is on in any mode — VS Code may or may not actually fire it
      // for a custom-editor focus change, so persist it ourselves to be sure.
      await this.flushAndSaveIfDirty(document, webview);
      return;
    }

    // Autosave is off. Show the prompt once globally, not once per open panel.
    const now = Date.now();
    if (now - MarkdownEditorProvider.lastBlankLineSavePromptAt < 1000) return;
    MarkdownEditorProvider.lastBlankLineSavePromptAt = now;
    void vscode.window.showInformationMessage('Save the file to see the changes.');
  }

  /**
   * Flush any pending webview-side debounce, await in-flight edits, then save
   * the document if it's dirty. Called by the autosave bridge whenever VS Code
   * would normally fire autosave but can't see the custom editor's focus/state
   * transitions (the webview is an iframe, not a `TextEditor`).
   *
   * No-ops for untitled documents — saving those would pop a "Save As" dialog,
   * which isn't autosave behavior.
   */
  private async flushAndSaveIfDirty(
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<boolean> {
    if (document.uri.scheme === 'untitled') return false;

    if (
      !(await this.flushRendererAtDocumentBoundary(
        document,
        webview,
        FEEDBACK_FLUSH_ACK_TIMEOUT_MS,
        'autosave-flush'
      ))
    ) {
      return false;
    }

    if (!document.isDirty) return true;

    try {
      return await document.save();
    } catch (error) {
      console.error('[MD4H] Autosave document.save() failed:', error);
      return false;
    }
  }

  /**
   * Persist host-accepted edits after VS Code has discarded an inactive
   * renderer. Every later accepted teardown tail calls this again, so saving
   * an earlier revision cannot leave the final hidden revision only in memory.
   */
  private async saveInactiveDocumentAfterDrain(
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<boolean> {
    if (!this.inactiveAutoSaveWebviews.has(webview) || document.uri.scheme === 'untitled') {
      return false;
    }
    const autoSave = vscode.workspace.getConfiguration('files').get<string>('autoSave', 'off');
    if (autoSave !== 'onFocusChange' && autoSave !== 'onWindowChange') return false;
    if (!(await this.drainDocumentEdits(document))) return false;
    if (!document.isDirty) return true;
    try {
      return await document.save();
    } catch (error) {
      console.error('[MD4H] Inactive renderer autosave failed:', error);
      return false;
    }
  }

  /**
   * Debounced save for `markdownForHumans.autoSave.enabled`. Unlike
   * `flushAndSaveIfDirty` (which bridges VS Code's own `files.autoSave` focus
   * events), this setting is MFH-specific: it saves a short delay after the
   * user stops typing, regardless of focus and regardless of `files.autoSave`.
   * Off by default, so the original explicit-save behavior is unchanged unless
   * a user opts in.
   *
   * No-ops for untitled documents — saving those would pop a "Save As" dialog.
   *
   * @param document - Document whose accepted typing edit should be persisted
   * @param editCompletion - Result of the coordinated edit that armed this debounce
   */
  private scheduleAutoSave(document: vscode.TextDocument, editCompletion: Promise<boolean>): void {
    if (document.uri.scheme === 'untitled') return;

    const config = vscode.workspace.getConfiguration();
    const enabled = config.get<boolean>('markdownForHumans.autoSave.enabled', false);
    if (!enabled) return;

    const docUri = document.uri.toString();
    const existing = this.autoSaveTimers.get(docUri);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      // Start the debounce when typing is accepted, not when its queued
      // WorkspaceEdit finishes. At the deadline, wait for that edit and the
      // full queue so slow edits cannot save stale bytes or restart the delay.
      const stillOwnsDebounce = (): boolean => this.autoSaveTimers.get(docUri) === timer;
      void editCompletion.then(
        async success => {
          if (!stillOwnsDebounce()) return;
          if (!success) {
            this.autoSaveTimers.delete(docUri);
            return;
          }
          const drained = await this.drainDocumentEdits(document);
          // A newer edit may have reset the debounce while this callback was
          // waiting for the queue. Only the newest timer may initiate a save.
          if (!stillOwnsDebounce()) return;
          this.autoSaveTimers.delete(docUri);
          if (!drained || !document.isDirty) return;
          try {
            await document.save();
          } catch (error) {
            console.error('[MD4H] Auto-save document.save() failed:', error);
          }
        },
        error => {
          if (stillOwnsDebounce()) this.autoSaveTimers.delete(docUri);
          console.error('[MD4H] Auto-save edit completion failed:', error);
        }
      );
    }, MarkdownEditorProvider.AUTO_SAVE_DEBOUNCE_MS);
    this.autoSaveTimers.set(docUri, timer);
  }

  /**
   * Convert an armed custom-autosave debounce into a host-owned drain when its
   * last renderer closes. Cancelling the timer alone can leave an accepted
   * WorkspaceEdit dirty forever when VS Code's own files.autoSave is disabled.
   */
  private preservePendingAutoSaveOnFinalPanelDispose(document: vscode.TextDocument): void {
    const documentKey = document.uri.toString();
    const timer = this.autoSaveTimers.get(documentKey);
    if (!timer) return;

    clearTimeout(timer);
    this.autoSaveTimers.delete(documentKey);
    void this.drainDocumentEdits(document)
      .then(async drained => {
        if (!drained || !document.isDirty) return;
        try {
          const saved = await document.save();
          if (!saved) console.error('[MD4H] Final-panel custom autosave was rejected.');
        } catch (error) {
          console.error('[MD4H] Final-panel custom autosave failed:', error);
        }
      })
      .catch(error => {
        console.error('[MD4H] Could not drain edits for final-panel custom autosave:', error);
      });
  }

  /**
   * Lazily register the global `window.onDidChangeWindowState` listener that
   * drives `onWindowChange` autosave. Guarded with a `typeof` check so unit-test
   * mocks of `vscode.window` that don't include this API don't crash.
   */
  private ensureWindowStateListener(): void {
    if (this.windowStateListener) return;
    const onWindowStateChange = vscode.window.onDidChangeWindowState;
    if (typeof onWindowStateChange !== 'function') return;
    this.windowStateListener = onWindowStateChange(state => {
      if (state.focused) return;
      const autoSave = vscode.workspace.getConfiguration('files').get<string>('autoSave', 'off');
      if (autoSave !== 'onWindowChange') return;
      for (const documentPanels of this.openPanels.values()) {
        // One flush per document is enough. Prefer its active split because it
        // is the view most likely to own a not-yet-debounced edit.
        const selected =
          [...documentPanels.entries()].find(([panel]) => panel.active) ??
          documentPanels.entries().next().value;
        if (!selected) continue;
        const [, entry] = selected;
        void this.flushAndSaveIfDirty(entry.document, entry.webview).catch(error => {
          console.error('[MD4H] Autosave on window-state change failed:', error);
        });
      }
    });
    if (this.context.subscriptions && Array.isArray(this.context.subscriptions)) {
      this.context.subscriptions.push(this.windowStateListener);
    }
  }

  /**
   * Convert webview Markdown into the exact text that `applyEdit` would write.
   * Feedback transition hashes must use this normalized form because the
   * resulting TextDocument change event observes unwrapped frontmatter,
   * blank-line policy, newline normalization, not the raw serializer payload.
   */
  private normalizeWebviewEditContent(content: string): string {
    const unwrappedContent = this.unwrapFrontmatterFromWebview(content);
    const policyContent = applyBlankLinePolicy(unwrappedContent, this.getBlankLineMode());
    return ensureSingleTrailingNewline(policyContent);
  }

  /**
   * Verify the renderer's real post-apply serialization against saved source.
   * TipTap may canonicalize equivalent Markdown syntax, so exact normalized
   * text wins first and structural equivalence is accepted only when the
   * configured blank-line contract is also preserved.
   */
  private feedbackRendererContentMatchesSource(
    rendererContent: string,
    sourceText: string
  ): boolean {
    const normalizedRenderer = this.normalizeWebviewEditContent(rendererContent);
    const normalizedSource = this.normalizeWebviewEditContent(sourceText);
    if (normalizedRenderer === normalizedSource) return true;
    if (!isMarkdownRendererEquivalent(normalizedRenderer, normalizedSource)) return false;
    return (
      this.getBlankLineMode() !== 'preserve' ||
      hasSameBlankLineLayout(normalizedRenderer, normalizedSource)
    );
  }

  /** Return a stable non-negative version for protocol messages and test adapters. */
  private getDocumentVersion(document: vscode.TextDocument): number {
    return typeof document.version === 'number' && Number.isSafeInteger(document.version)
      ? Math.max(0, document.version)
      : 0;
  }

  /**
   * Hold a replacement renderer behind every edit or flush boundary accepted
   * from its previous generation. Rotating early would reject a queued exact
   * ACK and could discard the final hidden-view revision.
   */
  private deferReadyUntilPendingDocumentBoundaries(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): boolean {
    const pending: Promise<unknown>[] = [
      ...(this.pendingDocumentEditAcks.get(webview)?.values() ?? []),
      ...[...this.flushAckResolvers.values()]
        .filter(boundary => boundary.webview === webview)
        .map(boundary => boundary.settled),
    ];
    if (pending.length === 0) return false;

    this.deferredReadyAfterDocumentEdits.set(webview, { message, document });
    if (this.pendingReadyDocumentEditDrains.has(webview)) return true;

    const drain = Promise.allSettled(pending).then(() => undefined);
    this.pendingReadyDocumentEditDrains.set(webview, drain);
    void drain.then(() => {
      if (this.pendingReadyDocumentEditDrains.get(webview) !== drain) return;
      this.pendingReadyDocumentEditDrains.delete(webview);
      const deferred = this.deferredReadyAfterDocumentEdits.get(webview);
      if (!deferred || this.disposed) return;
      this.deferredReadyAfterDocumentEdits.delete(webview);
      this.handleWebviewMessage(deferred.message, deferred.document, webview);
    });
    return true;
  }

  /** Assign a fresh renderer lineage after a webview script starts or reloads. */
  private rotateEditViewGeneration(webview: vscode.Webview): string {
    const generation = `view-${this.nextEditViewGeneration}`;
    this.nextEditViewGeneration += 1;
    this.setEditViewGeneration(webview, generation);
    return generation;
  }

  /** Install one renderer lineage and retire ACK caches from its predecessor. */
  private setEditViewGeneration(webview: vscode.Webview, generation: string): void {
    const unavailableGeneration = this.unavailableFeedbackViewGenerations.get(webview);
    this.retirePendingImageCompletionDeliveries(webview, { discardAfterSettlement: true });
    this.editViewGenerations.set(webview, generation);
    if (unavailableGeneration !== generation) {
      this.unavailableFeedbackViewGenerations.delete(webview);
    }
    this.appliedFeedbackPeerLocks.delete(webview);
    this.pendingDocumentEditAcks.delete(webview);
    this.documentEditAckHistory.delete(webview);
    this.documentEditEnvelopeHashes.delete(webview);
  }

  /** Return the current renderer lineage, creating one for pre-ready test/adaptor calls. */
  private getEditViewGeneration(webview?: vscode.Webview): string {
    if (!webview) return 'unattributed-view';
    return this.editViewGenerations.get(webview) ?? this.rotateEditViewGeneration(webview);
  }

  /** True only for the exact renderer lineage whose queueing was rejected. */
  private isFeedbackViewGenerationUnavailable(webview: vscode.Webview): boolean {
    const generation = this.editViewGenerations.get(webview);
    return (
      generation !== undefined &&
      this.unavailableFeedbackViewGenerations.get(webview) === generation
    );
  }

  /** Retire one destroyed renderer lineage without unregistering its panel. */
  private markFeedbackViewGenerationUnavailable(webview: vscode.Webview, generation: string): void {
    if (this.editViewGenerations.get(webview) !== generation) return;
    this.unavailableFeedbackViewGenerations.set(webview, generation);
    this.appliedFeedbackPeerLocks.delete(webview);
    this.pendingFeedbackPeerLockAcquisitions.delete(webview);
  }

  /** Post an application-level edit result without treating queueing as delivery. */
  private postDocumentEditAck(webview: vscode.Webview, ack: DocumentEditAck): void {
    void Promise.resolve(webview.postMessage(ack)).catch(error => {
      console.error('[MD4H] Failed posting document edit acknowledgement:', error);
    });
  }

  /** Retain and replay a bounded idempotent acknowledgement for one renderer edit. */
  private trackDocumentEditAck(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    edit: DocumentEditMessage | DocumentTeardownEditMessage,
    result: Promise<boolean>
  ): void {
    let pending = this.pendingDocumentEditAcks.get(webview);
    if (!pending) {
      pending = new Map();
      this.pendingDocumentEditAcks.set(webview, pending);
    }
    let envelopes = this.documentEditEnvelopeHashes.get(webview);
    if (!envelopes) {
      envelopes = new Map();
      this.documentEditEnvelopeHashes.set(webview, envelopes);
    }
    envelopes.set(edit.editId, this.hashDocumentEditEnvelope(edit));

    const acknowledgement = result.then(accepted => ({
      type: 'document.edit.ack' as const,
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      editId: edit.editId,
      viewGeneration: edit.viewGeneration,
      localRevision: edit.localRevision,
      accepted,
      documentVersion: this.getDocumentVersion(document),
    }));
    pending.set(edit.editId, acknowledgement);

    void acknowledgement.then(ack => {
      pending?.delete(edit.editId);
      if (this.editViewGenerations.get(webview) === edit.viewGeneration) {
        let completed = this.documentEditAckHistory.get(webview);
        if (!completed) {
          completed = new Map();
          this.documentEditAckHistory.set(webview, completed);
        }
        completed.set(edit.editId, ack);
        while (completed.size > MarkdownEditorProvider.DOCUMENT_EDIT_ACK_HISTORY_LIMIT) {
          const oldest = completed.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          completed.delete(oldest);
          envelopes?.delete(oldest);
        }
      }
      this.postDocumentEditAck(webview, ack);
      if (ack.accepted && this.inactiveAutoSaveWebviews.has(webview)) {
        void this.saveInactiveDocumentAfterDrain(document, webview).catch(error => {
          console.error('[MD4H] Post-edit inactive autosave failed:', error);
        });
      }
    });
  }

  /**
   * Reject reuse of one idempotency key with different immutable request data.
   * Replaying the earlier ACK for a conflicting payload would falsely claim
   * that content the host never applied had been accepted.
   */
  private isConflictingDocumentEditEnvelope(
    webview: vscode.Webview,
    edit: DocumentEditMessage | DocumentTeardownEditMessage
  ): boolean {
    const known = this.documentEditEnvelopeHashes.get(webview)?.get(edit.editId);
    return known !== undefined && known !== this.hashDocumentEditEnvelope(edit);
  }

  /** Hash one parsed edit without retaining another potentially large Markdown string. */
  private hashDocumentEditEnvelope(
    edit: DocumentEditMessage | DocumentTeardownEditMessage
  ): string {
    const hash = crypto.createHash('sha256');
    const fields = [
      edit.type,
      String(edit.protocolVersion),
      edit.editId,
      edit.viewGeneration,
      String(edit.localRevision),
      String(edit.baseDocumentVersion),
      ...(edit.type === 'edit'
        ? [edit.editReason]
        : [edit.predecessorEditId, String(edit.predecessorLocalRevision)]),
    ];
    for (const field of fields) hash.update(field, 'utf8').update('\0');
    return hash.update(edit.content, 'utf8').digest('hex');
  }

  /**
   * Queue one final renderer revision behind the exact edit it was derived
   * from. The webview may be destroyed before either ACK arrives, so execution
   * is authorized at receipt and later guarded by the predecessor result and
   * resulting document version rather than the disposed panel lifetime.
   */
  private applyDocumentTeardownEdit(
    edit: DocumentTeardownEditMessage,
    predecessor: Promise<DocumentEditAck>,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<boolean> {
    const documentKey = document.uri.toString();
    return this.documentEditCoordinator
      .enqueue(documentKey, {
        kind: 'operation',
        execute: async () => {
          const predecessorAck = await predecessor;
          if (
            !predecessorAck.accepted ||
            predecessorAck.editId !== edit.predecessorEditId ||
            predecessorAck.viewGeneration !== edit.viewGeneration ||
            predecessorAck.localRevision !== edit.predecessorLocalRevision ||
            this.getDocumentVersion(document) !== predecessorAck.documentVersion
          ) {
            return false;
          }
          return this.applyEditNow(edit.content, document, {
            editReason: 'typing',
            sourceWebview: webview,
            pendingImageViewGeneration: edit.viewGeneration,
          });
        },
      })
      .then(result => {
        if (result.status === 'completed') return result.value;
        if (result.status === 'failed') {
          console.error('[MD4H] Teardown document edit failed:', result.error);
        }
        return false;
      });
  }

  /** Return true while the coordinator owns active or queued work for a document. */
  private hasPendingDocumentEdits(documentKey: string): boolean {
    return this.documentEditCoordinator.hasPending(documentKey);
  }

  /**
   * Wait for every document edit accepted before this call to settle.
   *
   * The barrier belongs to the same per-document queue as WorkspaceEdits, so
   * coalesced promises cannot make a still-active older edit appear idle.
   */
  private async drainDocumentEdits(document: vscode.TextDocument): Promise<boolean> {
    return this.drainDocumentEditsByKey(document.uri.toString());
  }

  /** Queue-key adapter used by Feedback cleanup paths that may outlive a panel. */
  private async drainDocumentEditsByKey(documentKey: string): Promise<boolean> {
    if (!this.documentEditCoordinator.hasPending(documentKey)) return true;

    const result = await this.documentEditCoordinator.barrier(documentKey);
    if (result.status === 'completed') return true;
    if (result.status === 'failed') {
      console.error('[MD4H] Document edit barrier failed:', result.error);
    }
    return false;
  }

  /**
   * Ask one renderer generation to flush against the host's drained document
   * version. The acknowledgement is an ordering boundary, not proof that a
   * newly emitted WorkspaceEdit has completed, so callers must drain again.
   */
  private async requestDocumentFlush(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    timeoutMs: number,
    requestPrefix: string
  ): Promise<boolean> {
    const requestId = `${requestPrefix}-${crypto.randomBytes(8).toString('hex')}`;
    const viewGeneration = this.getEditViewGeneration(webview);
    const documentVersion = this.getDocumentVersion(document);
    let acknowledgementTimeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let markFlushSettled: () => void = () => undefined;
    const flushSettled = new Promise<void>(resolve => {
      markFlushSettled = resolve;
    });
    let settleBoundary: (ok: boolean) => void = () => undefined;
    const acknowledgement = new Promise<boolean>(resolve => {
      settleBoundary = ok => {
        if (settled) return;
        settled = true;
        this.flushAckResolvers.delete(requestId);
        if (acknowledgementTimeout) clearTimeout(acknowledgementTimeout);
        markFlushSettled();
        resolve(ok);
      };
      this.flushAckResolvers.set(requestId, {
        webview,
        viewGeneration,
        documentVersion,
        resolve: settleBoundary,
        settled: flushSettled,
      });
      acknowledgementTimeout = setTimeout(() => {
        settleBoundary(false);
      }, timeoutMs);
    });

    try {
      const delivery = webview.postMessage({
        type: 'flushPendingEdit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        requestId,
        viewGeneration,
        documentVersion,
      });
      void Promise.resolve(delivery).then(
        posted => {
          if (posted === false) settleBoundary(false);
        },
        error => {
          console.error('[MD4H] Document flush post failed:', error);
          settleBoundary(false);
        }
      );
    } catch (error) {
      console.error('[MD4H] Document flush post failed:', error);
      settleBoundary(false);
    }
    return acknowledgement;
  }

  /**
   * Establish a two-sided document boundary with one renderer. Any edit that
   * the barrier emits must receive an accepted application result before the
   * caller may save, snapshot, or otherwise consume the TextDocument.
   */
  private async flushRendererAtDocumentBoundary(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    timeoutMs: number,
    requestPrefix: string
  ): Promise<boolean> {
    if (!(await this.drainDocumentEdits(document))) return false;

    const completedBefore = new Set(this.documentEditAckHistory.get(webview)?.keys() ?? []);
    if (!(await this.requestDocumentFlush(document, webview, timeoutMs, requestPrefix))) {
      return false;
    }

    // The renderer posts its edit before the flush acknowledgement. Capture
    // exact application promises now, including a fast result that may move to
    // bounded history before the coordinator barrier below resolves.
    const acknowledgements = [...(this.pendingDocumentEditAcks.get(webview)?.values() ?? [])];
    const results = await Promise.all(acknowledgements);
    if (!(await this.drainDocumentEdits(document))) return false;
    if (results.some(result => !result.accepted)) return false;

    const completedAfter = this.documentEditAckHistory.get(webview);
    if (!completedAfter) return true;
    for (const [editId, result] of completedAfter) {
      if (!completedBefore.has(editId) && !result.accepted) return false;
    }
    return true;
  }

  /** Invoke VS Code save only after the renderer and document edit queue agree. */
  private async executeSaveAfterDocumentEdits(
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    if (
      !(await this.flushRendererAtDocumentBoundary(
        document,
        webview,
        FEEDBACK_FLUSH_ACK_TIMEOUT_MS,
        'save-flush'
      ))
    ) {
      return;
    }
    try {
      if (!(await document.save())) {
        void vscode.window.showErrorMessage('VS Code could not save this Markdown document.');
      }
    } catch (error) {
      console.error('[MD4H] Document save failed:', error);
    }
  }

  /**
   * Queue an edit from a webview for ordered application to its TextDocument.
   * Typing may coalesce only while pending in the same renderer/version lineage;
   * policy enforcement and every edit that has started remain strict barriers.
   *
   * @param content - Markdown content from webview (may include wrapped frontmatter)
   * @param document - Target VS Code document to update
   * @param options - Edit reason and the originating rich-view split, when known
   * @returns Promise resolving to true if edit succeeded, false otherwise
   * @throws Never - errors are caught and shown to user
   */
  private async applyEdit(
    content: string,
    document: vscode.TextDocument,
    options?: {
      editReason?: 'typing' | 'save-policy-enforce';
      sourceWebview?: vscode.Webview;
      viewGeneration?: string;
      baseDocumentVersion?: number;
      localRevision?: number;
      pendingImageViewGeneration?: string;
    }
  ): Promise<boolean> {
    const documentKey = document.uri.toString();
    const executionOptions =
      options?.editReason === 'typing'
        ? {
            ...options,
            viewGeneration:
              options.viewGeneration ?? this.getEditViewGeneration(options.sourceWebview),
            baseDocumentVersion: options.baseDocumentVersion ?? this.getDocumentVersion(document),
          }
        : options;
    const execute = (): Promise<boolean> => this.applyEditNow(content, document, executionOptions);
    const result =
      options?.editReason === 'typing'
        ? await this.documentEditCoordinator.enqueue(documentKey, {
            kind: 'typing',
            viewGeneration: executionOptions?.viewGeneration ?? 'unattributed-view',
            baseVersion: executionOptions?.baseDocumentVersion ?? this.getDocumentVersion(document),
            execute,
          })
        : await this.documentEditCoordinator.enqueue(documentKey, {
            kind: 'operation',
            execute,
          });

    if (result.status === 'completed') return result.value;
    if (result.status === 'coalesced') return true;
    if (result.status === 'failed') {
      vscode.window.showErrorMessage('Failed to apply editor changes. Please try again.');
      console.error('[MD4H] Coordinated applyEdit exception:', result.error);
    }
    return false;
  }

  /** Execute one already ordered edit against the latest TextDocument version. */
  private async applyEditNow(
    content: string,
    document: vscode.TextDocument,
    options?: {
      editReason?: 'typing' | 'save-policy-enforce';
      sourceWebview?: vscode.Webview;
      viewGeneration?: string;
      baseDocumentVersion?: number;
      localRevision?: number;
      pendingImageViewGeneration?: string;
    }
  ): Promise<boolean> {
    // Authorization at message receipt is insufficient because this work may
    // wait behind another WorkspaceEdit. Revalidate both identities at the
    // exact queue execution boundary before reading or replacing any bytes.
    if (
      options?.sourceWebview &&
      options.viewGeneration !== undefined &&
      this.editViewGenerations.get(options.sourceWebview) !== options.viewGeneration
    ) {
      return false;
    }
    if (
      options?.baseDocumentVersion !== undefined &&
      this.getDocumentVersion(document) !== options.baseDocumentVersion
    ) {
      return false;
    }

    // A hidden renderer can serialize a compact marker while its image file
    // is still being written. Resolve that marker on the host before any
    // equality, Markdown analysis, or WorkspaceEdit sees the payload.
    const effectiveContent = options?.sourceWebview
      ? await this.resolvePendingImageDestinations(
          content,
          options.sourceWebview,
          options.pendingImageViewGeneration ??
            options.viewGeneration ??
            this.getEditViewGeneration(options.sourceWebview)
        )
      : content;

    // Skip if content unchanged (avoid redundant edits)
    const unwrappedContent = this.unwrapFrontmatterFromWebview(effectiveContent);
    const blankLineMode = this.getBlankLineMode();
    // Normalize the inbound text to exactly one trailing newline (markdownlint
    // MD047). Done up-front so the equality and AST checks below compare the
    // form we'd actually write — a doc on disk that already ends with `\n`
    // matches a no-newline serialization and is short-circuited as a no-op.
    const normalizedContent = this.normalizeWebviewEditContent(effectiveContent);
    const currentText = document.getText();
    if (normalizedContent === currentText) {
      return true;
    }

    // A host delivery cached before this rich-view edit is no longer evidence
    // that the same bytes are present in the DOM. Without invalidating it, an
    // external A -> B -> A revert can be mistaken for an already delivered A
    // and leave the rich view stale at B.
    if (options?.sourceWebview) {
      this.lastHostContentByWebview.delete(options.sourceWebview);
      this.pendingHostContentByWebview.delete(options.sourceWebview);
    }

    // Suppress writes whose only difference is the WYSIWYG serializer's house
    // style — bullet marker swaps, ordered-list renumbering, blank-line
    // collapsing, soft-wrap reflow, etc. When the inbound text renders to the
    // same document as what's already on disk, leave the original bytes alone
    // so files authored against `markdownlint` stay lint-clean across opens.
    // Real edits (any change to rendered content) are detected and fall through.
    //
    // In `preserve` mode, blank-line layout is part of the document the user
    // is editing — markdown-it renders identical HTML regardless of how many
    // blank lines sit between blocks, so we additionally require the blank-line
    // signatures to match. Without this, adding or removing blank lines in the
    // WYSIWYG would never reach the TextDocument and the file would stay clean.
    const shouldEnforcePolicy = options?.editReason === 'save-policy-enforce';
    const renderEquivalent =
      !shouldEnforcePolicy && isMarkdownStructurallyEquivalent(normalizedContent, currentText);
    const blankLineLayoutMatters = blankLineMode === 'preserve';
    const blankLineLayoutMatches =
      !blankLineLayoutMatters || hasSameBlankLineLayout(normalizedContent, currentText);
    if (renderEquivalent && blankLineLayoutMatches) {
      // Update the cache so updateWebview() doesn't loop the canonical form
      // back to the webview as if it were an external change.
      this.lastWebviewContent.set(document.uri.toString(), currentText);
      if (options?.sourceWebview) {
        this.lastWebviewContentSource.set(document.uri.toString(), options.sourceWebview);
      } else {
        this.lastWebviewContentSource.delete(document.uri.toString());
      }
      return true;
    }

    // Mark this edit to prevent feedback loop
    const docUri = document.uri.toString();
    this.pendingEdits.set(docUri, Date.now());
    // When policy enforcement modifies the content (e.g., stripping blank lines),
    // set lastWebviewContent to the ORIGINAL content so that updateWebview()
    // will detect a mismatch and refresh the webview with the stripped content.
    // Otherwise, the webview would never refresh to show the policy-enforced state.
    const contentWasModified = normalizedContent !== unwrappedContent;
    if (shouldEnforcePolicy && contentWasModified) {
      this.lastWebviewContent.set(docUri, unwrappedContent);
    } else {
      this.lastWebviewContent.set(docUri, normalizedContent);
    }
    if (options?.sourceWebview) {
      this.lastWebviewContentSource.set(docUri, options.sourceWebview);
    } else {
      this.lastWebviewContentSource.delete(docUri);
    }

    const edit = new vscode.WorkspaceEdit();
    const useMinimalReplacement =
      Math.max(currentText.length, normalizedContent.length) >=
      MarkdownEditorProvider.MINIMAL_EDIT_DOCUMENT_THRESHOLD;
    const replacement = useMinimalReplacement
      ? computeMinimalTextReplacement(currentText, normalizedContent)
      : null;
    const startOffset = replacement?.startOffset ?? 0;
    const endOffset = replacement?.endOffset ?? currentText.length;
    edit.replace(
      document.uri,
      new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset)),
      replacement?.text ?? normalizedContent
    );

    try {
      const success = await vscode.workspace.applyEdit(edit);
      if (!success) {
        const errorMsg = 'Failed to save changes. The file may be read-only or locked.';
        vscode.window.showErrorMessage(errorMsg);
        console.error('[MD4H] applyEdit failed:', { uri: docUri });
      }
      return success;
    } catch (error) {
      const errorMsg =
        error instanceof Error
          ? `Failed to save changes: ${error.message}`
          : 'Failed to save changes: Unknown error';
      vscode.window.showErrorMessage(errorMsg);
      console.error('[MD4H] applyEdit exception:', error);
      return false;
    }
  }

  /**
   * Wrap YAML frontmatter in a fenced code block for webview rendering.
   * Returns original content when no frontmatter is present.
   */
  private wrapFrontmatterForWebview(content: string): string {
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    if (!match) return content;

    const usesCrLf = match[0].includes('\r\n');
    const newline = usesCrLf ? '\r\n' : '\n';
    const frontmatterBlock = match[0].replace(/\s+$/, ''); // keep delimiters
    const body = content.slice(match[0].length);

    // Choose a fence longer than the longest backtick run inside the
    // frontmatter. If a YAML value contains a ``` (e.g. a fenced code sample in
    // a multiline scalar), a plain 3-backtick fence would be closed early by the
    // webview's markdown parser, fragmenting the frontmatter and losing fields
    // on save. CommonMark requires the closing fence to be at least as long as
    // the opening one, so a longer fence keeps the whole block intact. Mirrors
    // prosemirror-markdown's own code_block fence logic so a re-serialized block
    // round-trips through unwrapFrontmatterFromWebview.
    const backtickRuns = frontmatterBlock.match(/`{3,}/g);
    const fence = backtickRuns
      ? '`'.repeat(Math.max(...backtickRuns.map(run => run.length)) + 1)
      : '```';

    const pieces = [`${fence}yaml`, frontmatterBlock, fence];
    if (body.length > 0) {
      // Ensure exactly one blank line between fenced block and body
      const trimmedBody =
        body.startsWith('\n') || body.startsWith('\r\n') ? body.replace(/^\r?\n/, '') : body;
      pieces.push('', trimmedBody);
    }

    return pieces.join(newline);
  }

  /**
   * Unwrap a fenced frontmatter code block back to YAML delimiters.
   * If no wrapped frontmatter is detected, returns the original content.
   */
  private unwrapFrontmatterFromWebview(content: string): string {
    if (!content.startsWith('```')) return content;

    const usesCrLf = content.includes('\r\n');
    const newline = usesCrLf ? '\r\n' : '\n';
    const lines = content.split(newline);

    // Accept a fence of 3+ backticks: wrapFrontmatterForWebview lengthens it when
    // the frontmatter contains an embedded ``` run, and prosemirror-markdown does
    // the same on re-serialize. The closing fence must match the opener's length.
    const fenceMatch = lines[0]
      .trim()
      .toLowerCase()
      .match(/^(`{3,})(yaml|yml|json)$/);
    if (!fenceMatch) {
      return content;
    }
    const fence = fenceMatch[1];

    const closingIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === fence);
    if (closingIndex === -1) return content;

    const insideLines = lines.slice(1, closingIndex);
    // Expect inside to start with '---'
    if (insideLines.length === 0 || insideLines[0].trim() !== '---') {
      return content;
    }

    const frontmatterSection = insideLines.join(newline);
    const bodyLines = lines.slice(closingIndex + 1);
    const body = bodyLines.join(newline);

    const separator = body.length > 0 ? newline : '';
    return frontmatterSection + separator + body;
  }

  /**
   * Generate HTML for webview
   */
  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css')
    );

    // Use a nonce for security
    const nonce = getNonce();

    return /* html */ `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy"
              content="default-src 'none';
                       style-src ${webview.cspSource} 'unsafe-inline';
                       script-src 'nonce-${nonce}';
                       font-src ${webview.cspSource};
                       connect-src ${webview.cspSource};
                       img-src ${webview.cspSource} https: data: blob:;">
        
        <link href="${styleUri}" rel="stylesheet">
        <title>Markdown for Humans</title>
      </head>
      <body>
        <div id="editor"></div>
        <script nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>
    `;
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Normalize an image path by URL-decoding each path segment.
 *
 * Handles paths like:
 * - `images/Hero%20Image.png` → `images/Hero Image.png`
 * - `../assets/My%20Diagram%201.png` → `../assets/My Diagram 1.png`
 * - `./screenshots/test.png` → `./screenshots/test.png` (unchanged)
 *
 * This makes the editor tolerant of URL-encoded paths commonly found in
 * markdown imported from web tools, GitHub, or static site generators.
 *
 * @param imagePath - The raw image path from markdown src attribute
 * @returns Normalized path with URL-encoded segments decoded
 */
export function normalizeImagePath(imagePath: string): string {
  // Don't touch remote URLs, data URIs, or already-resolved webview URIs
  if (
    imagePath.startsWith('http://') ||
    imagePath.startsWith('https://') ||
    imagePath.startsWith('data:') ||
    imagePath.startsWith('vscode-webview://')
  ) {
    return imagePath;
  }

  // Handle file:// URIs by stripping the scheme and decoding
  if (imagePath.startsWith('file://')) {
    try {
      return decodeURIComponent(imagePath.replace('file://', ''));
    } catch {
      return imagePath.replace('file://', '');
    }
  }

  // Split on forward slashes, decode each segment, rejoin
  // This preserves directory structure while decoding %20, %23, etc.
  return imagePath
    .split('/')
    .map(segment => {
      if (segment === '' || segment === '.' || segment === '..') {
        return segment;
      }
      try {
        return decodeURIComponent(segment);
      } catch {
        // If decoding fails (malformed %), return segment as-is
        return segment;
      }
    })
    .join('/');
}

/**
 * Path-traversal defense.
 *
 * Returns true iff `targetAbsolutePath` is `rootAbsolutePath` itself or a
 * descendant of it. Used by the file-mutating message handlers (rename,
 * resize) to reject attacker-supplied paths from a hostile markdown
 * document — e.g. `<img src="../../../../etc/passwd">`.
 *
 * Both inputs MUST already be absolute. Caller is responsible for
 * `path.resolve()` first.
 *
 * Notable defense: this is NOT a naive `target.startsWith(root)` check —
 * that bug would mis-classify `/tmp/workspace-evil` as inside `/tmp/workspace`.
 * We require either equality or `root + path.sep` as a prefix.
 */
export function isPathContainedWithin(
  targetAbsolutePath: string,
  rootAbsolutePath: string
): boolean {
  if (!targetAbsolutePath || !rootAbsolutePath) {
    return false;
  }
  // path.resolve canonicalizes drive letters on Windows (e.g. turns the
  // drive-relative "/workspace/docs" into "C:\workspace\docs"), so both
  // target and root end up on the same drive before comparison.
  const normalizedTarget = path.resolve(targetAbsolutePath);
  const normalizedRoot = path.resolve(rootAbsolutePath);

  // Strip trailing separator from root (path.normalize keeps "/" for "/")
  const rootNoSep =
    normalizedRoot.length > 1 && normalizedRoot.endsWith(path.sep)
      ? normalizedRoot.slice(0, -1)
      : normalizedRoot;

  // Case-insensitive on Windows; case-sensitive on macOS / Linux
  const target = process.platform === 'win32' ? normalizedTarget.toLowerCase() : normalizedTarget;
  const root = process.platform === 'win32' ? rootNoSep.toLowerCase() : rootNoSep;

  return target === root || target.startsWith(root + path.sep);
}
