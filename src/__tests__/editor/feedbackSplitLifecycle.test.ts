/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Regression contracts for document-scoped Feedback lifecycle state.
 * Split disposal must not erase work owned by another live rich view.
 */

import { createHash } from 'crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getActiveWebviewPanel, setActiveWebviewPanel } from '../../activeWebview';
import { DocumentEditCoordinator } from '../../editor/documentEditCoordinator';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';
import { DOCUMENT_SYNC_PROTOCOL_VERSION } from '../../shared/documentSyncProtocol';

interface FeedbackMessage {
  type: string;
  requestId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

interface ProviderLifecycleInternals {
  handleWebviewMessage: (
    message: FeedbackMessage,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ) => void;
  feedbackSessions: Map<
    string,
    {
      ownerWebview: vscode.Webview;
      sessionId: string;
      phase: 'active' | 'finishing' | 'discarding';
      pendingClose?: {
        requestId: string;
        revision: number;
        contentSha256?: string;
        releaseRevision?: number;
      };
    }
  >;
  feedbackWebviews: Map<string, Set<vscode.Webview>>;
  pendingEdits: Map<string, number>;
  documentEditCoordinator: DocumentEditCoordinator<string>;
  hasPendingDocumentEdits: (documentKey: string) => boolean;
  autoSaveTimers: Map<string, ReturnType<typeof setTimeout>>;
}

interface MockRichView {
  panel: vscode.WebviewPanel;
  webview: vscode.Webview & { postMessage: jest.Mock };
  receive(message: FeedbackMessage): void;
  invalidateWebviewGetter(): void;
  dispose(): void;
}

const ORIGINAL_SOURCE = '# Guide\n\nOriginal paragraph.\n';
const LATEST_SOURCE = '# Guide\n\nLatest owner edit.\n';
const ORIGINAL_BLOCKS = [
  { ordinal: 0, kind: 'heading', markdown: '# Guide', contentSize: 'Guide'.length },
  {
    ordinal: 1,
    kind: 'paragraph',
    markdown: 'Original paragraph.',
    contentSize: 'Original paragraph.'.length,
  },
];
const LATEST_BLOCKS = [
  { ordinal: 0, kind: 'heading', markdown: '# Guide', contentSize: 'Guide'.length },
  {
    ordinal: 1,
    kind: 'paragraph',
    markdown: 'Latest owner edit.',
    contentSize: 'Latest owner edit.'.length,
  },
];

function createFlushAcknowledgement(message: unknown, ok: boolean): FeedbackMessage {
  const barrier = message as {
    requestId: string;
    viewGeneration: string;
    documentVersion: number;
  };
  return {
    type: 'flushPendingEditAck',
    protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
    requestId: barrier.requestId,
    viewGeneration: barrier.viewGeneration,
    documentVersion: barrier.documentVersion,
    ok,
  };
}

function acknowledgeFeedbackPeerCoordination(view: MockRichView, message: FeedbackMessage): void {
  if (message.type === 'feedback.peer.lock.acquire') {
    queueMicrotask(() => {
      view.receive({
        type: 'feedback.peer.lock.acquired',
        acquisitionId: message.acquisitionId,
        requestId: message.requestId,
        lockId: message.lockId,
        replacesLockId: message.replacesLockId,
        viewGeneration: message.viewGeneration,
        revision: message.revision,
      });
    });
  }
  if (message.type === 'feedback.peer.release') {
    queueMicrotask(() => {
      view.receive({
        type: 'feedback.peer.released',
        phase: message.phase,
        releaseId: message.releaseId,
        requestId: message.requestId,
        lockId: message.lockId,
        viewGeneration: message.viewGeneration,
        revision: message.revision,
        documentVersion: message.documentVersion,
        contentSha256: message.contentSha256,
      });
    });
  }
  if (message.type === 'feedback.session.transfer') {
    queueMicrotask(() => {
      view.receive({
        type: 'feedback.session.transfer.ack',
        phase: message.phase,
        role: message.role,
        transferId: message.transferId,
        requestId: message.requestId,
        oldSessionId: message.oldSessionId,
        newSessionId: message.newSessionId,
        viewGeneration: message.viewGeneration,
        revision: message.revision,
        documentVersion: message.documentVersion,
        sourceSha256: message.sourceSha256,
        applied: true,
      });
    });
  }
}

describe('MarkdownEditorProvider split lifecycle ownership', () => {
  let workspaceRoot: string;
  let sourcePath: string;
  let restoreJoinPath: unknown;
  let restoreConfigurationListener: unknown;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'md4h-feedback-split-lifecycle-'));
    sourcePath = path.join(workspaceRoot, 'docs', 'guide.md');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, ORIGINAL_SOURCE, 'utf8');

    const workspaceFolder = {
      uri: fileUri(workspaceRoot),
      name: 'feedback-split-fixture',
      index: 0,
    } as vscode.WorkspaceFolder;
    (
      vscode.workspace as unknown as { workspaceFolders?: vscode.WorkspaceFolder[] }
    ).workspaceFolders = [workspaceFolder];
    (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(workspaceFolder);

    const mutableUri = vscode.Uri as unknown as {
      joinPath?: (base: vscode.Uri, ...segments: string[]) => vscode.Uri;
    };
    restoreJoinPath = mutableUri.joinPath;
    mutableUri.joinPath = (base, ...segments) => fileUri(path.join(base.fsPath, ...segments));

    const mutableWorkspace = vscode.workspace as unknown as {
      onDidChangeConfiguration?: (
        listener: (event: { affectsConfiguration(section: string): boolean }) => void
      ) => vscode.Disposable;
    };
    restoreConfigurationListener = mutableWorkspace.onDidChangeConfiguration;
    mutableWorkspace.onDidChangeConfiguration = jest.fn(() => ({ dispose: jest.fn() }));
  });

  afterEach(async () => {
    const mutableUri = vscode.Uri as unknown as { joinPath?: unknown };
    if (restoreJoinPath === undefined) delete mutableUri.joinPath;
    else mutableUri.joinPath = restoreJoinPath;

    const mutableWorkspace = vscode.workspace as unknown as {
      workspaceFolders?: vscode.WorkspaceFolder[];
      onDidChangeConfiguration?: unknown;
    };
    mutableWorkspace.workspaceFolders = undefined;
    if (restoreConfigurationListener === undefined)
      delete mutableWorkspace.onDidChangeConfiguration;
    else mutableWorkspace.onDidChangeConfiguration = restoreConfigurationListener;

    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('does not let an inactive background split replace the active command target', async () => {
    setActiveWebviewPanel(undefined);
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, () => ORIGINAL_SOURCE);
    const activeView = createRichView({ active: true });
    const backgroundView = createRichView({ active: false });

    try {
      await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        activeView.panel,
        {} as vscode.CancellationToken
      );
      expect(getActiveWebviewPanel()).toBe(activeView.panel);

      await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        backgroundView.panel,
        {} as vscode.CancellationToken
      );

      expect(getActiveWebviewPanel()).toBe(activeView.panel);
    } finally {
      backgroundView.dispose();
      activeView.dispose();
      provider.dispose();
      setActiveWebviewPanel(undefined);
    }
  });

  it('keeps the owner flush, pending marker, and autosave timer when a peer split closes', async () => {
    const provider = createProvider(workspaceRoot);
    const providerInternals = internals(provider);
    let documentText = ORIGINAL_SOURCE;
    let dirty = false;
    const document = createDocument(sourcePath, () => documentText, {
      isDirty: () => dirty,
      save: async () => {
        await writeFile(sourcePath, documentText, 'utf8');
        dirty = false;
        return true;
      },
    });
    const owner = createRichView();
    const peer = createRichView();

    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      owner.panel,
      {} as vscode.CancellationToken
    );
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      peer.panel,
      {} as vscode.CancellationToken
    );

    let releaseOwnerEdit: (() => void) | undefined;
    (vscode.workspace.applyEdit as jest.Mock).mockImplementation(
      (edit: { replaces?: Array<{ text: string }> }) =>
        new Promise<boolean>(resolve => {
          releaseOwnerEdit = () => {
            documentText = edit.replaces?.[0]?.text ?? documentText;
            dirty = true;
            resolve(true);
          };
        })
    );

    const documentKey = document.uri.toString();
    const existingAutoSave = setTimeout(() => undefined, 60_000);
    providerInternals.autoSaveTimers.set(documentKey, existingAutoSave);
    let peerDisposedDuringFlush = false;
    peer.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          peer.receive(createFlushAcknowledgement(message, true));
        });
      }
      return Promise.resolve(true);
    });
    owner.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          owner.receive({ type: 'edit', content: LATEST_SOURCE, editReason: 'typing' });
          peer.dispose();
          peerDisposedDuringFlush = true;
          owner.receive(createFlushAcknowledgement(message, true));
        });
      }
      return Promise.resolve(true);
    });

    owner.receive({
      type: 'feedback.start',
      requestId: 'start-after-peer-dispose',
      blocks: LATEST_BLOCKS,
    });

    await waitUntil(() => peerDisposedDuringFlush && releaseOwnerEdit !== undefined);
    const stateImmediatelyAfterPeerDispose = {
      pendingOwnerEdit: providerInternals.pendingEdits.has(documentKey),
      inFlightOwnerEdit: providerInternals.hasPendingDocumentEdits(documentKey),
      sameAutoSaveTimer: providerInternals.autoSaveTimers.get(documentKey) === existingAutoSave,
    };

    // The fixed implementation is still waiting here. The regression used to
    // snapshot the old bytes as soon as the unrelated peer erased the promise.
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    releaseOwnerEdit?.();

    const outcome = await waitForOneOf(
      owner,
      ['feedback.started', 'feedback.error'],
      'start-after-peer-dispose'
    );
    clearTimeout(existingAutoSave);
    providerInternals.autoSaveTimers.delete(documentKey);

    expect(stateImmediatelyAfterPeerDispose).toEqual({
      pendingOwnerEdit: true,
      inFlightOwnerEdit: true,
      sameAutoSaveTimer: true,
    });
    expect(outcome).toEqual(
      expect.objectContaining({
        type: 'feedback.started',
        sourceSha256: createHash('sha256').update(LATEST_SOURCE, 'utf8').digest('hex'),
      })
    );
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe(LATEST_SOURCE);
  });

  it('releases an active session when its only tab closes and offers its draft on Start', async () => {
    const provider = createProvider(workspaceRoot);
    const providerInternals = internals(provider);
    const document = createDocument(sourcePath, () => ORIGINAL_SOURCE);
    const firstView = createRichView();
    firstView.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          firstView.receive(createFlushAcknowledgement(message, true));
        });
      }
      return Promise.resolve(true);
    });

    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      firstView.panel,
      {} as vscode.CancellationToken
    );
    firstView.receive({
      type: 'feedback.start',
      requestId: 'start-before-only-tab-closes',
      blocks: ORIGINAL_BLOCKS,
    });
    await waitForOneOf(firstView, ['feedback.started'], 'start-before-only-tab-closes');
    expect(providerInternals.feedbackSessions.size).toBe(1);

    firstView.dispose();
    expect(providerInternals.feedbackSessions.size).toBe(0);

    const reopenedView = createRichView();
    reopenedView.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      acknowledgeFeedbackPeerCoordination(reopenedView, message);
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          reopenedView.receive(createFlushAcknowledgement(message, true));
        });
      }
      return Promise.resolve(true);
    });
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      reopenedView.panel,
      {} as vscode.CancellationToken
    );
    reopenedView.receive({ type: 'ready' });
    await waitUntil(() =>
      reopenedView.webview.postMessage.mock.calls.some(
        call => call[0].type === 'feedback.drafts.available'
      )
    );
    const draftNotice = reopenedView.webview.postMessage.mock.calls
      .map(call => call[0] as FeedbackMessage)
      .find(message => message.type === 'feedback.drafts.available');
    expect(draftNotice?.drafts).toEqual([
      expect.objectContaining({
        itemCount: 0,
        feedbackFile: expect.stringMatching(/feedback\.md$/),
      }),
    ]);
    reopenedView.receive({
      type: 'feedback.start',
      requestId: 'start-after-only-tab-reopens',
      blocks: ORIGINAL_BLOCKS,
    });

    const offer = await waitForOneOf(
      reopenedView,
      ['feedback.resume.available', 'feedback.error'],
      'start-after-only-tab-reopens'
    );
    expect(offer).toEqual(
      expect.objectContaining({ kind: 'saved-draft', drafts: draftNotice?.drafts })
    );
    const round = (offer.drafts as Array<{ round: string }>)[0]?.round;
    reopenedView.receive({
      type: 'feedback.draft.resume',
      requestId: 'resume-after-only-tab-reopens',
      round,
      blocks: ORIGINAL_BLOCKS,
    });
    const resumed = await waitForOneOf(
      reopenedView,
      ['feedback.started', 'feedback.error'],
      'resume-after-only-tab-reopens'
    );
    expect(resumed.type).toBe('feedback.started');
    reopenedView.dispose();
  });

  it('reclaims an orphaned session when a replacement rich view registers', async () => {
    const provider = createProvider(workspaceRoot);
    const providerInternals = internals(provider);
    const document = createDocument(sourcePath, () => ORIGINAL_SOURCE);
    const orphanedOwner = createRichView();
    orphanedOwner.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          orphanedOwner.receive(createFlushAcknowledgement(message, true));
        });
      }
      return Promise.resolve(true);
    });
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      orphanedOwner.panel,
      {} as vscode.CancellationToken
    );
    orphanedOwner.receive({
      type: 'feedback.start',
      requestId: 'start-before-owner-is-orphaned',
      blocks: ORIGINAL_BLOCKS,
    });
    await waitForOneOf(orphanedOwner, ['feedback.started'], 'start-before-owner-is-orphaned');

    const documentKey = document.uri.toString();
    providerInternals.feedbackWebviews.get(documentKey)?.delete(orphanedOwner.webview);
    expect(providerInternals.feedbackSessions.size).toBe(1);

    const replacement = createRichView();
    replacement.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      acknowledgeFeedbackPeerCoordination(replacement, message);
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          replacement.receive(createFlushAcknowledgement(message, true));
        });
      }
      return Promise.resolve(true);
    });
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      replacement.panel,
      {} as vscode.CancellationToken
    );

    expect(providerInternals.feedbackSessions.size).toBe(0);
    expect(
      replacement.webview.postMessage.mock.calls.some(
        call => call[0].type === 'feedback.peer.locked'
      )
    ).toBe(false);

    replacement.receive({
      type: 'feedback.start',
      requestId: 'start-after-orphan-reclaimed',
      blocks: ORIGINAL_BLOCKS,
    });
    const offer = await waitForOneOf(
      replacement,
      ['feedback.resume.available', 'feedback.error'],
      'start-after-orphan-reclaimed'
    );
    expect(offer).toEqual(expect.objectContaining({ kind: 'saved-draft' }));
    replacement.receive({
      type: 'feedback.draft.resume',
      requestId: 'resume-after-orphan-reclaimed',
      round: (offer.drafts as Array<{ round: string }>)[0]?.round,
      blocks: ORIGINAL_BLOCKS,
    });
    const resumed = await waitForOneOf(
      replacement,
      ['feedback.started', 'feedback.error'],
      'resume-after-orphan-reclaimed'
    );
    expect(resumed.type).toBe('feedback.started');

    replacement.dispose();
    orphanedOwner.dispose();
  });

  it('keeps an orphan lock until its pending edit settles, then reclaims it on Start', async () => {
    const provider = createProvider(workspaceRoot);
    const providerInternals = internals(provider);
    const document = createDocument(sourcePath, () => ORIGINAL_SOURCE);
    const orphanedOwner = createRichView();
    orphanedOwner.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          orphanedOwner.receive(createFlushAcknowledgement(message, true));
        });
      }
      return Promise.resolve(true);
    });
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      orphanedOwner.panel,
      {} as vscode.CancellationToken
    );
    orphanedOwner.receive({
      type: 'feedback.start',
      requestId: 'start-before-pending-orphan',
      blocks: ORIGINAL_BLOCKS,
    });
    await waitForOneOf(orphanedOwner, ['feedback.started'], 'start-before-pending-orphan');

    const documentKey = document.uri.toString();
    providerInternals.feedbackWebviews.get(documentKey)?.delete(orphanedOwner.webview);
    let settleOwnerEdit: (() => void) | undefined;
    const pendingOwnerWork = new Promise<boolean>(resolve => {
      settleOwnerEdit = () => resolve(true);
    });
    const pendingOwnerEdit = providerInternals.documentEditCoordinator.enqueue(documentKey, {
      kind: 'operation',
      execute: () => pendingOwnerWork,
    });

    const replacement = createRichView();
    replacement.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      acknowledgeFeedbackPeerCoordination(replacement, message);
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          replacement.receive(createFlushAcknowledgement(message, true));
        });
      }
      return Promise.resolve(true);
    });
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      replacement.panel,
      {} as vscode.CancellationToken
    );

    expect(providerInternals.feedbackSessions.size).toBe(1);
    expect(
      replacement.webview.postMessage.mock.calls.some(
        call => call[0].type === 'feedback.peer.locked'
      )
    ).toBe(true);

    settleOwnerEdit?.();
    await pendingOwnerEdit;
    replacement.receive({
      type: 'feedback.start',
      requestId: 'start-after-pending-orphan-settles',
      blocks: ORIGINAL_BLOCKS,
    });
    const offer = await waitForOneOf(
      replacement,
      ['feedback.resume.available', 'feedback.error'],
      'start-after-pending-orphan-settles'
    );
    expect(offer).toEqual(expect.objectContaining({ kind: 'saved-draft' }));
    replacement.receive({
      type: 'feedback.draft.resume',
      requestId: 'resume-after-pending-orphan-settles',
      round: (offer.drafts as Array<{ round: string }>)[0]?.round,
      blocks: ORIGINAL_BLOCKS,
    });
    const resumed = await waitForOneOf(
      replacement,
      ['feedback.started', 'feedback.error'],
      'resume-after-pending-orphan-settles'
    );
    expect(resumed.type).toBe('feedback.started');

    replacement.dispose();
    orphanedOwner.dispose();
  });

  it("unregisters a disposed rich view without re-reading VS Code's invalid panel getter", async () => {
    const provider = createProvider(workspaceRoot);
    const providerInternals = internals(provider);
    const document = createDocument(sourcePath, () => ORIGINAL_SOURCE);
    const view = createRichView({ invalidateWebviewGetterOnDispose: true });

    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      view.panel,
      {} as vscode.CancellationToken
    );

    const documentKey = document.uri.toString();
    expect(providerInternals.feedbackWebviews.get(documentKey)?.has(view.webview)).toBe(true);

    expect(() => view.dispose()).not.toThrow();
    expect(providerInternals.feedbackWebviews.has(documentKey)).toBe(false);
  });

  it('prunes an unavailable stale peer and still flushes the live owner', async () => {
    const provider = createProvider(workspaceRoot);
    const providerInternals = internals(provider);
    const document = createDocument(sourcePath, () => ORIGINAL_SOURCE);
    const owner = createRichView();
    const stalePeer = createRichView();

    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      owner.panel,
      {} as vscode.CancellationToken
    );
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      stalePeer.panel,
      {} as vscode.CancellationToken
    );

    stalePeer.webview.postMessage.mockImplementation((message: FeedbackMessage) =>
      Promise.resolve(message.type !== 'flushPendingEdit')
    );
    owner.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          owner.receive(createFlushAcknowledgement(message, true));
        });
      }
      return Promise.resolve(true);
    });

    owner.receive({
      type: 'feedback.start',
      requestId: 'start-after-stale-peer',
      blocks: [
        { ordinal: 0, kind: 'heading', markdown: '# Guide', contentSize: 'Guide'.length },
        {
          ordinal: 1,
          kind: 'paragraph',
          markdown: 'Original paragraph.',
          contentSize: 'Original paragraph.'.length,
        },
      ],
    });

    const outcome = await waitForOneOf(
      owner,
      ['feedback.started', 'feedback.error'],
      'start-after-stale-peer'
    );
    expect(outcome.type).toBe('feedback.started');
    expect(providerInternals.feedbackWebviews.get(document.uri.toString())).toEqual(
      new Set([owner.webview])
    );
  });

  it('fails closed when the initiating rich view is unavailable', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, () => ORIGINAL_SOURCE);
    const owner = createRichView();

    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      owner.panel,
      {} as vscode.CancellationToken
    );
    owner.webview.postMessage.mockImplementation((message: FeedbackMessage) =>
      Promise.resolve(message.type !== 'flushPendingEdit')
    );

    owner.receive({
      type: 'feedback.start',
      requestId: 'start-owner-unavailable',
      blocks: [
        { ordinal: 0, kind: 'heading', markdown: '# Guide', contentSize: 'Guide'.length },
        {
          ordinal: 1,
          kind: 'paragraph',
          markdown: 'Original paragraph.',
          contentSize: 'Original paragraph.'.length,
        },
      ],
    });

    await expect(
      waitForOneOf(owner, ['feedback.started', 'feedback.error'], 'start-owner-unavailable')
    ).resolves.toEqual(
      expect.objectContaining({
        type: 'feedback.error',
        message: 'The active rich editor is no longer available, so feedback did not start.',
      })
    );
  });

  it('continues when a peer disposes after accepting the flush but before acknowledging', async () => {
    const provider = createProvider(workspaceRoot);
    const providerInternals = internals(provider);
    const document = createDocument(sourcePath, () => ORIGINAL_SOURCE);
    const owner = createRichView();
    const closingPeer = createRichView({ invalidateWebviewGetterOnDispose: true });

    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      owner.panel,
      {} as vscode.CancellationToken
    );
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      closingPeer.panel,
      {} as vscode.CancellationToken
    );

    closingPeer.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit') queueMicrotask(() => closingPeer.dispose());
      return Promise.resolve(true);
    });
    owner.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          owner.receive(createFlushAcknowledgement(message, true));
        });
      }
      return Promise.resolve(true);
    });

    owner.receive({
      type: 'feedback.start',
      requestId: 'start-after-peer-closes-before-ack',
      blocks: [
        { ordinal: 0, kind: 'heading', markdown: '# Guide', contentSize: 'Guide'.length },
        {
          ordinal: 1,
          kind: 'paragraph',
          markdown: 'Original paragraph.',
          contentSize: 'Original paragraph.'.length,
        },
      ],
    });

    const outcome = await waitForOneOf(
      owner,
      ['feedback.started', 'feedback.error'],
      'start-after-peer-closes-before-ack'
    );
    expect(outcome.type).toBe('feedback.started');
    expect(providerInternals.feedbackWebviews.get(document.uri.toString())).toEqual(
      new Set([owner.webview])
    );
  });

  it('keeps a surviving peer locked until an owner disposal flush settles and resynchronizes', async () => {
    const provider = createProvider(workspaceRoot);
    const providerInternals = internals(provider);
    let documentText = ORIGINAL_SOURCE;
    let dirty = false;
    const document = createDocument(sourcePath, () => documentText, {
      isDirty: () => dirty,
      save: async () => {
        await writeFile(sourcePath, documentText, 'utf8');
        dirty = false;
        return true;
      },
    });
    const owner = createRichView();
    const peer = createRichView();

    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      owner.panel,
      {} as vscode.CancellationToken
    );
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      peer.panel,
      {} as vscode.CancellationToken
    );

    let releaseOwnerEdit: (() => void) | undefined;
    (vscode.workspace.applyEdit as jest.Mock).mockImplementation(
      (edit: { replaces?: Array<{ text: string }> }) =>
        new Promise<boolean>(resolve => {
          releaseOwnerEdit = () => {
            documentText = edit.replaces?.[0]?.text ?? documentText;
            dirty = true;
            resolve(true);
          };
        })
    );
    peer.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      acknowledgeFeedbackPeerCoordination(peer, message);
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          peer.receive(createFlushAcknowledgement(message, true));
        });
      }
      return Promise.resolve(true);
    });
    owner.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          owner.receive({ type: 'edit', content: LATEST_SOURCE, editReason: 'typing' });
          owner.receive(createFlushAcknowledgement(message, true));
        });
      }
      return Promise.resolve(true);
    });

    owner.receive({
      type: 'feedback.start',
      requestId: 'start-owner-disposes-mid-flush',
      blocks: LATEST_BLOCKS,
    });
    await waitUntil(() => releaseOwnerEdit !== undefined);
    owner.dispose();

    expect(
      peer.webview.postMessage.mock.calls.some(call => call[0].type === 'feedback.peer.release')
    ).toBe(false);

    releaseOwnerEdit?.();
    await waitUntil(() =>
      peer.webview.postMessage.mock.calls.some(
        call => call[0].type === 'feedback.peer.release' && call[0].phase === 'commit'
      )
    );

    const acquireIndex = peer.webview.postMessage.mock.calls.findIndex(
      call => call[0].type === 'feedback.peer.lock.acquire'
    );
    const applyIndex = peer.webview.postMessage.mock.calls.findIndex(
      call =>
        call[0].type === 'feedback.peer.release' &&
        call[0].phase === 'apply' &&
        call[0].content === LATEST_SOURCE
    );
    const commitIndex = peer.webview.postMessage.mock.calls.findIndex(
      call => call[0].type === 'feedback.peer.release' && call[0].phase === 'commit'
    );
    expect(acquireIndex).toBeGreaterThanOrEqual(0);
    expect(applyIndex).toBeGreaterThan(acquireIndex);
    expect(commitIndex).toBeGreaterThan(applyIndex);

    peer.dispose();
    providerInternals.autoSaveTimers.forEach(timer => clearTimeout(timer));
    providerInternals.autoSaveTimers.clear();
  });

  it('retires an active disposed owner only after every surviving peer applies and commits', async () => {
    const provider = createProvider(workspaceRoot);
    const providerInternals = internals(provider);
    const document = createDocument(sourcePath, () => ORIGINAL_SOURCE);
    const owner = createRichView();
    const peer = createRichView();

    owner.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => owner.receive(createFlushAcknowledgement(message, true)));
      }
      return Promise.resolve(true);
    });
    peer.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      acknowledgeFeedbackPeerCoordination(peer, message);
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => peer.receive(createFlushAcknowledgement(message, true)));
      }
      return Promise.resolve(true);
    });

    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      owner.panel,
      {} as vscode.CancellationToken
    );
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      peer.panel,
      {} as vscode.CancellationToken
    );
    owner.receive({
      type: 'feedback.start',
      requestId: 'start-before-active-owner-disposes',
      blocks: ORIGINAL_BLOCKS,
    });
    const started = await waitForOneOf(
      owner,
      ['feedback.started'],
      'start-before-active-owner-disposes'
    );

    owner.dispose();
    await waitUntil(() =>
      peer.webview.postMessage.mock.calls.some(
        call => call[0].type === 'feedback.peer.release' && call[0].phase === 'commit'
      )
    );
    await waitUntil(() => providerInternals.feedbackSessions.size === 0);

    const applyIndex = peer.webview.postMessage.mock.calls.findIndex(
      call =>
        call[0].type === 'feedback.peer.release' &&
        call[0].phase === 'apply' &&
        call[0].lockId === started.sessionId &&
        call[0].content === ORIGINAL_SOURCE
    );
    const commitIndex = peer.webview.postMessage.mock.calls.findIndex(
      call =>
        call[0].type === 'feedback.peer.release' &&
        call[0].phase === 'commit' &&
        call[0].lockId === started.sessionId
    );
    expect(applyIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(applyIndex);

    peer.dispose();
  });

  it('does not let a definitively unavailable peer generation block Feedback activation', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, () => ORIGINAL_SOURCE);
    const owner = createRichView();
    const peer = createRichView();
    let peerGenerationUnavailable = true;

    owner.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => owner.receive(createFlushAcknowledgement(message, true)));
      }
      return Promise.resolve(true);
    });
    peer.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => peer.receive(createFlushAcknowledgement(message, true)));
      }
      if (message.type === 'feedback.peer.lock.acquire' && peerGenerationUnavailable) {
        return Promise.resolve(false);
      }
      acknowledgeFeedbackPeerCoordination(peer, message);
      return Promise.resolve(true);
    });

    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      owner.panel,
      {} as vscode.CancellationToken
    );
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      peer.panel,
      {} as vscode.CancellationToken
    );
    owner.receive({
      type: 'feedback.start',
      requestId: 'start-with-hidden-peer-generation',
      blocks: ORIGINAL_BLOCKS,
    });
    const started = await waitForOneOf(
      owner,
      ['feedback.started'],
      'start-with-hidden-peer-generation'
    );
    const unavailableAcquire = peer.webview.postMessage.mock.calls
      .map(call => call[0] as FeedbackMessage)
      .find(message => message.type === 'feedback.peer.lock.acquire');
    expect(unavailableAcquire?.viewGeneration).toEqual(expect.any(String));

    peerGenerationUnavailable = false;
    peer.receive({ type: 'ready' });
    await waitUntil(
      () =>
        peer.webview.postMessage.mock.calls.filter(
          call => call[0].type === 'feedback.peer.lock.acquire'
        ).length === 2
    );
    const replacementAcquire = peer.webview.postMessage.mock.calls
      .map(call => call[0] as FeedbackMessage)
      .filter(message => message.type === 'feedback.peer.lock.acquire')[1];
    expect(replacementAcquire).toEqual(expect.objectContaining({ lockId: started.sessionId }));
    expect(replacementAcquire?.viewGeneration).not.toBe(unavailableAcquire?.viewGeneration);
    expect(
      peer.webview.postMessage.mock.calls.some(
        call => call[0].type === 'update' && call[0].content === ORIGINAL_SOURCE
      )
    ).toBe(true);

    owner.dispose();
    await waitUntil(() =>
      peer.webview.postMessage.mock.calls.some(
        call => call[0].type === 'feedback.peer.release' && call[0].phase === 'commit'
      )
    );
    peer.dispose();
  });

  it('retires a definitively unavailable release target and rehydrates its next generation', async () => {
    const provider = createProvider(workspaceRoot);
    const providerInternals = internals(provider);
    const document = createDocument(sourcePath, () => ORIGINAL_SOURCE);
    const owner = createRichView();
    const peer = createRichView();
    let releaseGenerationUnavailable = false;

    owner.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => owner.receive(createFlushAcknowledgement(message, true)));
      }
      return Promise.resolve(true);
    });
    peer.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => peer.receive(createFlushAcknowledgement(message, true)));
      }
      if (message.type === 'feedback.peer.release' && releaseGenerationUnavailable) {
        return Promise.resolve(false);
      }
      acknowledgeFeedbackPeerCoordination(peer, message);
      return Promise.resolve(true);
    });

    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      owner.panel,
      {} as vscode.CancellationToken
    );
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      peer.panel,
      {} as vscode.CancellationToken
    );
    owner.receive({
      type: 'feedback.start',
      requestId: 'start-before-release-target-hides',
      blocks: ORIGINAL_BLOCKS,
    });
    await waitForOneOf(owner, ['feedback.started'], 'start-before-release-target-hides');

    releaseGenerationUnavailable = true;
    owner.dispose();
    await waitUntil(() => providerInternals.feedbackSessions.size === 0);
    const unavailableReleases = peer.webview.postMessage.mock.calls
      .map(call => call[0] as FeedbackMessage)
      .filter(message => message.type === 'feedback.peer.release');
    expect(unavailableReleases).toEqual([
      expect.objectContaining({ phase: 'apply', content: ORIGINAL_SOURCE }),
    ]);

    releaseGenerationUnavailable = false;
    const updatesBeforeReady = peer.webview.postMessage.mock.calls.filter(
      call => call[0].type === 'update'
    ).length;
    peer.receive({ type: 'ready' });
    await waitUntil(
      () =>
        peer.webview.postMessage.mock.calls.filter(call => call[0].type === 'update').length >
        updatesBeforeReady
    );
    const latestUpdate = peer.webview.postMessage.mock.calls
      .map(call => call[0] as FeedbackMessage)
      .filter(message => message.type === 'update')
      .at(-1);
    expect(latestUpdate).toEqual(expect.objectContaining({ content: ORIGINAL_SOURCE }));

    peer.dispose();
  });

  it('keeps the surviving split registered for window-change autosave when the newest peer closes', async () => {
    let windowStateListener: ((state: { focused: boolean }) => void) | undefined;
    const mutableWindow = vscode.window as unknown as {
      onDidChangeWindowState?: (
        listener: (state: { focused: boolean }) => void
      ) => vscode.Disposable;
    };
    const originalWindowStateEvent = mutableWindow.onDidChangeWindowState;
    mutableWindow.onDidChangeWindowState = jest.fn(listener => {
      windowStateListener = listener;
      return { dispose: jest.fn() };
    });
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation((section?: string) => ({
      get: jest.fn((key: string, defaultValue?: unknown) =>
        section === 'files' && key === 'autoSave' ? 'onWindowChange' : defaultValue
      ),
      update: jest.fn(async () => undefined),
    }));

    try {
      const provider = createProvider(workspaceRoot);
      let dirty = true;
      const save = jest.fn(async () => {
        dirty = false;
        return true;
      });
      const document = createDocument(sourcePath, () => ORIGINAL_SOURCE, {
        isDirty: () => dirty,
        save,
      });
      const survivingView = createRichView();
      const newestPeer = createRichView();

      survivingView.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
        if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
          queueMicrotask(() => {
            survivingView.receive(createFlushAcknowledgement(message, true));
          });
        }
        return Promise.resolve(true);
      });

      await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        survivingView.panel,
        {} as vscode.CancellationToken
      );
      await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        newestPeer.panel,
        {} as vscode.CancellationToken
      );
      expect(windowStateListener).toBeDefined();

      newestPeer.dispose();
      windowStateListener?.({ focused: false });
      await settleAsyncWork();

      const survivingFlushes = survivingView.webview.postMessage.mock.calls
        .map(call => call[0] as FeedbackMessage)
        .filter(message => message.type === 'flushPendingEdit');
      const disposedPeerFlushes = newestPeer.webview.postMessage.mock.calls
        .map(call => call[0] as FeedbackMessage)
        .filter(message => message.type === 'flushPendingEdit');

      expect(survivingFlushes).toHaveLength(1);
      expect(disposedPeerFlushes).toHaveLength(0);
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      if (originalWindowStateEvent === undefined) delete mutableWindow.onDidChangeWindowState;
      else mutableWindow.onDidChangeWindowState = originalWindowStateEvent;
    }
  });

  it('uses the captured webview when window autosave races panel disposal', async () => {
    let windowStateListener: ((state: { focused: boolean }) => void) | undefined;
    const mutableWindow = vscode.window as unknown as {
      onDidChangeWindowState?: (
        listener: (state: { focused: boolean }) => void
      ) => vscode.Disposable;
    };
    const originalWindowStateEvent = mutableWindow.onDidChangeWindowState;
    mutableWindow.onDidChangeWindowState = jest.fn(listener => {
      windowStateListener = listener;
      return { dispose: jest.fn() };
    });
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation((section?: string) => ({
      get: jest.fn((key: string, defaultValue?: unknown) =>
        section === 'files' && key === 'autoSave' ? 'onWindowChange' : defaultValue
      ),
      update: jest.fn(async () => undefined),
    }));

    try {
      const provider = createProvider(workspaceRoot);
      let dirty = true;
      const save = jest.fn(async () => {
        dirty = false;
        return true;
      });
      const document = createDocument(sourcePath, () => ORIGINAL_SOURCE, {
        isDirty: () => dirty,
        save,
      });
      const view = createRichView({ invalidateWebviewGetterOnDispose: true });
      view.webview.postMessage.mockImplementation((message: FeedbackMessage) => {
        if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
          queueMicrotask(() => {
            view.receive(createFlushAcknowledgement(message, true));
          });
        }
        return Promise.resolve(true);
      });

      await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        view.panel,
        {} as vscode.CancellationToken
      );
      view.invalidateWebviewGetter();

      expect(() => windowStateListener?.({ focused: false })).not.toThrow();
      await settleAsyncWork();
      expect(save).toHaveBeenCalledTimes(1);
      view.dispose();
    } finally {
      if (originalWindowStateEvent === undefined) delete mutableWindow.onDidChangeWindowState;
      else mutableWindow.onDidChangeWindowState = originalWindowStateEvent;
    }
  });

  it('resends the latest authoritative close content for a correlated failed revision', async () => {
    const provider = createProvider(workspaceRoot);
    const providerInternals = internals(provider);
    const documentKey = fileUri(sourcePath).toString();
    const webview = createRichView().webview;
    const latestCloseContent = '# Externally refreshed source\n';
    const document = createDocument(sourcePath, () => latestCloseContent);
    const sessionId = '0123456789abcdef0123456789abcdef';

    providerInternals.feedbackSessions.set(documentKey, {
      ownerWebview: webview,
      sessionId,
      phase: 'discarding',
      pendingClose: {
        requestId: 'discard-close',
        revision: 1,
        contentSha256: createHash('sha256').update('# stale payload\n').digest('hex'),
      },
    });

    providerInternals.handleWebviewMessage(
      {
        type: 'feedback.close.retry',
        requestId: 'discard-close',
        sessionId,
        revision: 1,
      },
      document as unknown as vscode.TextDocument,
      webview
    );

    const resent = await waitForPostedMessage(webview, 'feedback.close.sync', 'discard-close');
    expect(resent).toEqual({
      type: 'feedback.close.sync',
      requestId: 'discard-close',
      sessionId,
      revision: 2,
      content: latestCloseContent,
    });
    expect(providerInternals.feedbackSessions.get(documentKey)).toEqual(
      expect.objectContaining({
        ownerWebview: webview,
        phase: 'discarding',
        pendingClose: expect.objectContaining({ revision: 2 }),
      })
    );
  });
});

function createProvider(workspaceRoot: string): MarkdownEditorProvider {
  return new MarkdownEditorProvider({
    extensionUri: fileUri(workspaceRoot),
    subscriptions: [],
    globalState: {
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: jest.fn(async () => undefined),
    },
    extension: { packageJSON: { version: '0.3.0-test' } },
  } as unknown as vscode.ExtensionContext);
}

function createDocument(
  sourcePath: string,
  getContent: () => string,
  options: {
    isDirty?: () => boolean;
    save?: () => Promise<boolean>;
  } = {}
) {
  const uri = fileUri(sourcePath);
  return {
    uri,
    fileName: sourcePath,
    languageId: 'markdown',
    version: 1,
    get isDirty() {
      return options.isDirty?.() ?? false;
    },
    getText: jest.fn(() => getContent()),
    get lineCount() {
      return getContent().split('\n').length;
    },
    positionAt: jest.fn((offset: number) => new vscode.Position(0, offset)),
    save: jest.fn(options.save ?? (async () => true)),
  };
}

function createRichView(
  options: { active?: boolean; invalidateWebviewGetterOnDispose?: boolean } = {}
): MockRichView {
  let receiveMessage: ((message: FeedbackMessage) => void) | undefined;
  let disposePanel: (() => void) | undefined;
  let disposed = false;
  const webview = {
    cspSource: 'vscode-webview://feedback-lifecycle',
    html: '',
    options: {},
    asWebviewUri: jest.fn((uri: vscode.Uri) => uri),
    postMessage: jest.fn(() => Promise.resolve(true)),
    onDidReceiveMessage: jest.fn((listener: (message: FeedbackMessage) => void) => {
      receiveMessage = listener;
      return { dispose: jest.fn() };
    }),
  } as unknown as vscode.Webview & { postMessage: jest.Mock };
  const panel = {
    get webview() {
      if (disposed && options.invalidateWebviewGetterOnDispose) {
        throw new Error('Webview is disposed');
      }
      return webview;
    },
    active: options.active ?? true,
    onDidChangeViewState: jest.fn(() => ({ dispose: jest.fn() })),
    onDidDispose: jest.fn((listener: () => void) => {
      disposePanel = listener;
      return { dispose: jest.fn() };
    }),
  } as unknown as vscode.WebviewPanel;

  return {
    panel,
    webview,
    receive(message) {
      if (!receiveMessage) throw new Error('The panel message listener is not registered.');
      receiveMessage(message);
    },
    invalidateWebviewGetter() {
      disposed = true;
    },
    dispose() {
      if (!disposePanel) throw new Error('The panel disposal listener is not registered.');
      disposed = true;
      disposePanel();
    },
  };
}

function internals(provider: MarkdownEditorProvider): ProviderLifecycleInternals {
  return provider as unknown as ProviderLifecycleInternals;
}

function fileUri(fsPath: string): vscode.Uri {
  return {
    fsPath,
    path: fsPath,
    scheme: 'file',
    toString: () => `file://${fsPath}`,
  } as vscode.Uri;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the split lifecycle checkpoint.');
}

async function settleAsyncWork(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

async function waitForOneOf(
  view: MockRichView,
  types: readonly string[],
  requestId: string
): Promise<FeedbackMessage> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const message = view.webview.postMessage.mock.calls
      .map(call => call[0] as FeedbackMessage)
      .find(candidate => types.includes(candidate.type) && candidate.requestId === requestId);
    if (message) return message;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${types.join(' or ')} (${requestId}).`);
}

async function waitForPostedMessage(
  webview: vscode.Webview & { postMessage: jest.Mock },
  type: string,
  requestId: string
): Promise<FeedbackMessage> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const message = webview.postMessage.mock.calls
      .map(call => call[0] as FeedbackMessage)
      .find(candidate => candidate.type === type && candidate.requestId === requestId);
    if (message) return message;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${type} (${requestId}).`);
}
