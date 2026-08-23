/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Extension-host integration contracts for frozen Feedback sessions.
 * These tests deliberately use real source and bundle files. VS Code UI calls
 * stay mocked so failures identify the provider boundary rather than Electron.
 */

import { createHash } from 'crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';
import {
  FeedbackSessionStore,
  type AddTextFeedbackInput,
  type TextFeedbackItem,
} from '../../editor/feedbackSessionStore';

interface FeedbackMessage {
  type: string;
  requestId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

interface ProviderInternals {
  handleWebviewMessage: (
    message: FeedbackMessage,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ) => void;
  announceMatchingFeedbackDrafts: (
    document: vscode.TextDocument,
    webview: vscode.Webview
  ) => Promise<void>;
  invalidateFeedbackSession: (documentKey: string, webview: vscode.Webview) => void;
  handleFeedbackDocumentChange: (
    documentKey: string,
    webview: vscode.Webview,
    currentText?: string
  ) => boolean;
  releaseFeedbackStateForWebview: (
    documentKey: string,
    webview: vscode.Webview,
    document?: vscode.TextDocument
  ) => void;
  registerFeedbackWebview: (documentKey: string, webview: vscode.Webview) => void;
  unregisterFeedbackWebview: (documentKey: string, webview: vscode.Webview) => void;
  updateWebview: (
    document: vscode.TextDocument,
    webview: vscode.Webview,
    options?: { force?: boolean }
  ) => void;
  feedbackItems: (session: unknown, webview: vscode.Webview) => FeedbackMessage[];
  feedbackSessions: Map<
    string,
    {
      store: FeedbackSessionStore;
      invalidated: boolean;
      ownerWebview: vscode.Webview;
      targets: Map<string, { startOrdinal: number; endOrdinal: number }>;
    }
  >;
  feedbackTransitions: Map<
    string,
    {
      invalidated: boolean;
      ownerWebview: vscode.Webview;
    }
  >;
  flushAckResolvers: Map<string, (ok: boolean) => void>;
  applyEdit: jest.Mock;
}

interface MockDocumentOptions {
  dirty?: boolean;
  save?: () => Promise<boolean>;
}

const SOURCE_TEXT = '# Guide\n\nParagraph.\n';
const SOURCE_BYTES = Buffer.from(SOURCE_TEXT, 'utf8');
const START_BLOCKS = [
  { ordinal: 0, kind: 'heading', markdown: '# Guide', contentSize: 'Guide'.length },
  { ordinal: 1, kind: 'paragraph', markdown: 'Paragraph.', contentSize: 'Paragraph.'.length },
];
const PARAGRAPH_RENDERED_RANGE_INPUT = {
  version: 1,
  startOrdinal: 1,
  startOffset: 0,
  endOrdinal: 1,
  endOffset: 'Paragraph.'.length,
};
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('MarkdownEditorProvider Feedback sessions', () => {
  let workspaceRoot: string;
  let sourcePath: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'md4h-feedback-provider-'));
    sourcePath = path.join(workspaceRoot, 'docs', 'guide.md');
    await writeFileEnsuringDirectory(sourcePath, SOURCE_BYTES);

    const workspaceFolder = {
      uri: fileUri(workspaceRoot),
      name: 'feedback-fixture',
      index: 0,
    } as vscode.WorkspaceFolder;
    (
      vscode.workspace as unknown as { workspaceFolders?: vscode.WorkspaceFolder[] }
    ).workspaceFolders = [workspaceFolder];
    (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(workspaceFolder);
  });

  afterEach(async () => {
    (
      vscode.workspace as unknown as { workspaceFolders?: vscode.WorkspaceFolder[] }
    ).workspaceFolders = undefined;
    delete (vscode.workspace as unknown as { fs?: unknown }).fs;
    delete (vscode.env as unknown as { clipboard?: unknown }).clipboard;
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it.each([
    {
      label: 'unknown feedback message',
      message: { type: 'feedback.not-a-command', requestId: 'bad-unknown' },
    },
    {
      label: 'malformed known feedback message',
      message: { type: 'feedback.start', requestId: 'bad-start', blocks: 'not-an-array' },
    },
    {
      label: 'feedback message with an unknown key',
      message: {
        type: 'feedback.start',
        requestId: 'bad-extra-key',
        blocks: [{ ordinal: 0, kind: 'paragraph', markdown: 'Body', contentSize: 4 }],
        documentText: 'must not cross the boundary',
      },
    },
  ])('rejects a $label at the host boundary with a structured error', async ({ message }) => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);

    internals(provider).handleWebviewMessage(
      message,
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const response = await waitForMessage(webview, 'feedback.error', message.requestId);
    expect(response).toEqual(
      expect.objectContaining({
        type: 'feedback.error',
        requestId: message.requestId,
        message: expect.any(String),
        recoverable: expect.any(Boolean),
      })
    );
    expect(internals(provider).feedbackSessions.size).toBe(0);
    await expect(pathExists(path.join(workspaceRoot, '.md4h', 'feedback'))).resolves.toBe(false);
  });

  it.each([
    { label: 'missing', acknowledgement: {} },
    { label: 'false', acknowledgement: { ok: false } },
    { label: 'string-valued', acknowledgement: { ok: 'true' } },
  ])('rejects a $label pending-edit flush acknowledgement', ({ acknowledgement }) => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);
    const resolve = jest.fn();
    internals(provider).flushAckResolvers.set('flush-malformed', resolve);

    internals(provider).handleWebviewMessage(
      {
        type: 'flushPendingEditAck',
        requestId: 'flush-malformed',
        ...acknowledgement,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    expect(resolve).toHaveBeenCalledWith(false);
    expect(internals(provider).flushAckResolvers.has('flush-malformed')).toBe(false);
  });

  it('accepts only a literal true pending-edit flush acknowledgement', () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);
    const resolve = jest.fn();
    internals(provider).flushAckResolvers.set('flush-valid', resolve);

    internals(provider).handleWebviewMessage(
      { type: 'flushPendingEditAck', requestId: 'flush-valid', ok: true },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    expect(resolve).toHaveBeenCalledWith(true);
    expect(internals(provider).flushAckResolvers.has('flush-valid')).toBe(false);
  });

  it('fails closed when the rich view does not acknowledge its pending edit flush', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);

    sendStart(provider, document, webview, 'start-without-flush');
    await new Promise(resolve => setTimeout(resolve, 2_100));

    const error = await waitForMessage(webview, 'feedback.error', 'start-without-flush');
    expect(error.message).toMatch(/flush|latest editor changes/i);
    expect(internals(provider).feedbackSessions.size).toBe(0);
    expect(internals(provider).feedbackTransitions.size).toBe(0);
    await expect(pathExists(path.join(workspaceRoot, '.md4h', 'feedback'))).resolves.toBe(false);
  });

  it('accepts a successful flush acknowledgement delayed by a busy rich view', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);
    webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        setTimeout(() => {
          internals(provider).handleWebviewMessage(
            { type: 'flushPendingEditAck', requestId: message.requestId, ok: true },
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        }, 500);
      }
      return Promise.resolve(true);
    });

    sendStart(provider, document, webview, 'start-delayed-flush');

    await expect(
      waitForMessage(webview, 'feedback.started', 'start-delayed-flush')
    ).resolves.toEqual(expect.objectContaining({ sourceSha256: expect.any(String) }));
    expect(messagesOfType(webview, 'feedback.error')).toHaveLength(0);
  });

  it('recovers an accepted owner edit when its flush acknowledgement times out', async () => {
    const pendingContent = '# Guide\n\nPending owner paragraph.\n';
    let documentContent = SOURCE_TEXT;
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    document.getText.mockImplementation(() => documentContent);
    internals(provider).applyEdit = jest.fn(async (content: string) => {
      documentContent = content;
      return true;
    });
    const webview = createWebview(provider, document, false);
    webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit') {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            { type: 'edit', content: pendingContent, editReason: 'typing' },
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      return Promise.resolve(true);
    });

    sendStart(provider, document, webview, 'start-owner-edit-without-ack');

    const sync = await waitForMessage(
      webview,
      'feedback.transition.sync',
      'start-owner-edit-without-ack'
    );
    await expect(
      waitForMessage(webview, 'feedback.error', 'start-owner-edit-without-ack')
    ).resolves.toEqual(expect.objectContaining({ message: expect.stringMatching(/flush/i) }));
    expect(sync).toEqual(
      expect.objectContaining({ revision: 1, content: pendingContent, lockId: expect.any(String) })
    );
    expect(internals(provider).feedbackTransitions.size).toBe(1);
    expect(messagesOfType(webview, 'feedback.started')).toHaveLength(0);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.transition.applied',
        requestId: 'start-owner-edit-without-ack',
        lockId: sync.lockId,
        revision: sync.revision,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await waitUntil(() => internals(provider).feedbackTransitions.size === 0);
  });

  it('cancels start when an unrecognized document change arrives during the flush window', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);

    sendStart(provider, document, webview, 'start-change-during-flush');
    const flush = await waitForMessage(webview, 'flushPendingEdit');
    expect(
      internals(provider).handleFeedbackDocumentChange(
        document.uri.toString(),
        webview as unknown as vscode.Webview
      )
    ).toBe(true);
    internals(provider).handleWebviewMessage(
      { type: 'flushPendingEditAck', requestId: flush.requestId, ok: true },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const error = await waitForMessage(webview, 'feedback.error', 'start-change-during-flush');
    expect(error).toEqual(
      expect.objectContaining({
        code: 'MD4H-FB-SNAPSHOT-001',
        message: expect.stringMatching(/source changed/i),
      })
    );
    expect(messagesOfType(webview, 'feedback.started')).toHaveLength(0);
    expect(internals(provider).feedbackSessions.size).toBe(0);
  });

  it('accepts only the exact document change produced by the requested flush edit', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);

    sendStart(provider, document, webview, 'start-exact-flush-edit');
    const flush = await waitForMessage(webview, 'flushPendingEdit');
    internals(provider).handleWebviewMessage(
      { type: 'edit', content: SOURCE_TEXT, editReason: 'typing' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    expect(
      internals(provider).handleFeedbackDocumentChange(
        document.uri.toString(),
        webview as unknown as vscode.Webview,
        SOURCE_TEXT
      )
    ).toBe(true);
    internals(provider).handleWebviewMessage(
      { type: 'flushPendingEditAck', requestId: flush.requestId, ok: true },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await expect(
      waitForMessage(webview, 'feedback.started', 'start-exact-flush-edit')
    ).resolves.toEqual(expect.objectContaining({ sourceSha256: expect.any(String) }));
    expect(messagesOfType(webview, 'feedback.error')).toHaveLength(0);
  });

  it('accepts the exact normalized flush edit across CRLF, blank-line, and trailing-newline policy', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);

    sendStart(provider, document, webview, 'start-normalized-flush-edit');
    const flush = await waitForMessage(webview, 'flushPendingEdit');
    internals(provider).handleWebviewMessage(
      {
        type: 'edit',
        content: '# Guide\r\n\r\n\r\nParagraph.\r\n\r\n',
        editReason: 'typing',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    expect(
      internals(provider).handleFeedbackDocumentChange(
        document.uri.toString(),
        webview as unknown as vscode.Webview,
        SOURCE_TEXT
      )
    ).toBe(true);
    expect(internals(provider).feedbackTransitions.get(document.uri.toString())?.invalidated).toBe(
      false
    );
    internals(provider).handleWebviewMessage(
      { type: 'flushPendingEditAck', requestId: flush.requestId, ok: true },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await expect(
      waitForMessage(webview, 'feedback.started', 'start-normalized-flush-edit')
    ).resolves.toEqual(expect.objectContaining({ sourceSha256: expect.any(String) }));
  });

  it('accepts the exact unwrapped frontmatter content produced by a requested flush', async () => {
    const source = ['---', 'title: Guide', '---', '', '# Guide', '', 'Paragraph.', ''].join('\n');
    const wrapped = [
      '```yaml',
      '---',
      'title: Guide',
      '---',
      '```',
      '',
      '',
      '# Guide',
      '',
      'Paragraph.',
      '',
    ].join('\r\n');
    const blocks = [
      {
        ordinal: 0,
        kind: 'codeBlock',
        markdown: '```yaml\n---\ntitle: Guide\n---\n```',
        contentSize: 22,
      },
      { ordinal: 1, kind: 'heading', markdown: '# Guide', contentSize: 5 },
      { ordinal: 2, kind: 'paragraph', markdown: 'Paragraph.', contentSize: 10 },
    ];
    await writeFile(sourcePath, source);
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, source);
    const webview = createWebview(provider, document, false);

    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'start-frontmatter-flush', blocks },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const flush = await waitForMessage(webview, 'flushPendingEdit');
    internals(provider).handleWebviewMessage(
      { type: 'edit', content: wrapped, editReason: 'typing' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    expect(
      internals(provider).handleFeedbackDocumentChange(
        document.uri.toString(),
        webview as unknown as vscode.Webview,
        source
      )
    ).toBe(true);
    expect(internals(provider).feedbackTransitions.get(document.uri.toString())?.invalidated).toBe(
      false
    );
    internals(provider).handleWebviewMessage(
      { type: 'flushPendingEditAck', requestId: flush.requestId, ok: true },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await expect(
      waitForMessage(webview, 'feedback.started', 'start-frontmatter-flush')
    ).resolves.toEqual(expect.objectContaining({ sourceSha256: expect.any(String) }));
  });

  it('clears a failed transition so a later start can succeed', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT, {
      dirty: true,
      save: jest
        .fn<Promise<boolean>, []>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });
    const firstWebview = createWebview(provider, document);

    sendStart(provider, document, firstWebview, 'start-transition-fails');
    await waitForMessage(firstWebview, 'feedback.error', 'start-transition-fails');
    expect(internals(provider).feedbackTransitions.size).toBe(0);

    const retryWebview = createWebview(provider, document);
    sendStart(provider, document, retryWebview, 'start-transition-retry');
    await waitForMessage(retryWebview, 'feedback.started', 'start-transition-retry');

    expect(internals(provider).feedbackTransitions.size).toBe(0);
    expect(internals(provider).feedbackSessions.size).toBe(1);
  });

  it('does not echo an oversized malformed request identifier', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);

    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'x'.repeat(257), blocks: 'invalid' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const response = await waitForMessage(webview, 'feedback.error');
    expect(response.requestId).toBeUndefined();
  });

  it('flushes a clean saved file, freezes exact bytes, and returns exact anchors', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);

    sendStart(provider, document, webview, 'start-exact');

    const started = await waitForMessage(webview, 'feedback.started', 'start-exact');
    expect(started).toEqual(
      expect.objectContaining({
        type: 'feedback.started',
        requestId: 'start-exact',
        sessionId: expect.any(String),
        source: 'docs/guide.md',
        sourceSha256: createHash('sha256').update(SOURCE_BYTES).digest('hex'),
        round: expect.stringMatching(/^\d{8}T\d{6}Z-[a-z0-9]{4}$/),
        feedbackFile: expect.stringMatching(
          /^\.md4h\/feedback\/docs\/guide\.md--\d{8}T\d{6}Z-[a-z0-9]{4}\/feedback\.md$/
        ),
        anchors: [
          { ordinal: 0, startLine: 1, endLine: 1 },
          { ordinal: 1, startLine: 3, endLine: 3 },
        ],
        items: [],
      })
    );
    expect(started.sessionId).not.toBe(started.round);
    expect(internals(provider).feedbackSessions.size).toBe(1);

    const report = await readFile(path.join(workspaceRoot, started.feedbackFile as string), 'utf8');
    expect(report).toContain('schema: md4h-feedback/v1');
    expect(report).toContain('state: draft');
    expect(report).toMatch(/source: ["']?docs\/guide\.md["']?/);
  });

  it('routes split-view invalidation to the owning Feedback webview only', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document);
    const duplicateWebview = createWebview(provider, document);
    sendStart(provider, document, ownerWebview, 'start-split-owner');
    await waitForMessage(ownerWebview, 'feedback.started', 'start-split-owner');

    expect(
      internals(provider).handleFeedbackDocumentChange(
        document.uri.toString(),
        duplicateWebview as unknown as vscode.Webview,
        '# Changed in the duplicate split\n'
      )
    ).toBe(false);
    expect(messagesOfType(duplicateWebview, 'feedback.invalidated')).toHaveLength(0);

    expect(
      internals(provider).handleFeedbackDocumentChange(
        document.uri.toString(),
        ownerWebview as unknown as vscode.Webview,
        '# Changed in the duplicate split\n'
      )
    ).toBe(true);
    await waitForMessage(ownerWebview, 'feedback.invalidated');
    expect(messagesOfType(ownerWebview, 'feedback.invalidated')).toHaveLength(1);
  });

  it('locks every registered duplicate split while the owner starts Feedback', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document, false);
    const duplicateWebview = createWebview(provider, document);
    const documentKey = document.uri.toString();
    internals(provider).registerFeedbackWebview(
      documentKey,
      ownerWebview as unknown as vscode.Webview
    );
    internals(provider).registerFeedbackWebview(
      documentKey,
      duplicateWebview as unknown as vscode.Webview
    );

    sendStart(provider, document, ownerWebview, 'start-locks-split');
    const lock = await waitForMessage(duplicateWebview, 'feedback.peer.locked');

    expect(lock).toEqual(
      expect.objectContaining({
        lockId: expect.any(String),
        message: expect.stringMatching(/another editor split/i),
      })
    );
    expect(messagesOfType(ownerWebview, 'feedback.peer.locked')).toHaveLength(0);
  });

  it('installs the session lock before retiring the transition lock', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document);
    const duplicateWebview = createWebview(provider, document);
    const documentKey = document.uri.toString();
    internals(provider).registerFeedbackWebview(
      documentKey,
      ownerWebview as unknown as vscode.Webview
    );
    internals(provider).registerFeedbackWebview(
      documentKey,
      duplicateWebview as unknown as vscode.Webview
    );

    sendStart(provider, document, ownerWebview, 'start-replaces-peer-lock');
    const started = await waitForMessage(
      ownerWebview,
      'feedback.started',
      'start-replaces-peer-lock'
    );
    const lifecycle = duplicateWebview.postMessage.mock.calls
      .map(call => call[0] as FeedbackMessage)
      .filter(
        message =>
          message.type === 'feedback.peer.locked' || message.type === 'feedback.peer.unlocked'
      );
    const transitionLockIndex = lifecycle.findIndex(
      message => message.type === 'feedback.peer.locked' && message.lockId !== started.sessionId
    );
    const sessionLockIndex = lifecycle.findIndex(
      message => message.type === 'feedback.peer.locked' && message.lockId === started.sessionId
    );
    const transitionLock = lifecycle[transitionLockIndex];
    const transitionUnlockIndex = lifecycle.findIndex(
      message =>
        message.type === 'feedback.peer.unlocked' && message.lockId === transitionLock?.lockId
    );

    expect(transitionLockIndex).toBeGreaterThanOrEqual(0);
    expect(sessionLockIndex).toBeGreaterThan(transitionLockIndex);
    expect(transitionUnlockIndex).toBeGreaterThan(sessionLockIndex);

    const ownerLifecycle = ownerWebview.postMessage.mock.calls.map(
      call => call[0] as FeedbackMessage
    );
    const ownerTransitionLock = ownerLifecycle.find(
      message => message.type === 'feedback.transition.locked'
    );
    const ownerStartedIndex = ownerLifecycle.findIndex(
      message => message.type === 'feedback.started' && message.sessionId === started.sessionId
    );
    const ownerTransitionUnlockIndex = ownerLifecycle.findIndex(
      message =>
        message.type === 'feedback.peer.unlocked' && message.lockId === ownerTransitionLock?.lockId
    );
    expect(ownerTransitionLock).toEqual(
      expect.objectContaining({ requestId: 'start-replaces-peer-lock' })
    );
    expect(ownerStartedIndex).toBeGreaterThanOrEqual(0);
    expect(ownerTransitionUnlockIndex).toBeGreaterThan(ownerStartedIndex);
  });

  it('never accepts an edit from a peer after the Feedback session lock is active', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document);
    const duplicateWebview = createWebview(provider, document);
    const documentKey = document.uri.toString();
    internals(provider).registerFeedbackWebview(
      documentKey,
      ownerWebview as unknown as vscode.Webview
    );
    internals(provider).registerFeedbackWebview(
      documentKey,
      duplicateWebview as unknown as vscode.Webview
    );
    const applyEdit = jest
      .spyOn(provider as never, 'applyEdit' as never)
      .mockResolvedValue(true as never);

    sendStart(provider, document, ownerWebview, 'start-peer-edit-block');
    const started = await waitForMessage(ownerWebview, 'feedback.started', 'start-peer-edit-block');
    await waitUntil(() =>
      messagesOfType(duplicateWebview, 'feedback.peer.locked').some(
        message => message.lockId === started.sessionId
      )
    );
    expect(messagesOfType(duplicateWebview, 'feedback.peer.locked')).toContainEqual(
      expect.objectContaining({ lockId: started.sessionId })
    );
    internals(provider).handleWebviewMessage(
      { type: 'edit', content: '# Peer must not write\n' },
      document as unknown as vscode.TextDocument,
      duplicateWebview as unknown as vscode.Webview
    );

    expect(applyEdit).not.toHaveBeenCalled();
    expect(messagesOfType(duplicateWebview, 'feedback.peer.locked')).not.toHaveLength(0);
  });

  it('preserves a peer edit queued before its transition lock and aborts Start safely', async () => {
    const provider = createProvider(workspaceRoot);
    const peerContent = '# Local mutation before lock\n';
    const document = createDocument(sourcePath, SOURCE_TEXT, {
      dirty: true,
      save: async () => {
        await writeFile(sourcePath, peerContent, 'utf8');
        return true;
      },
    });
    const ownerWebview = createWebview(provider, document);
    const racingPeer = createWebview(provider, document);
    const documentKey = document.uri.toString();
    internals(provider).registerFeedbackWebview(
      documentKey,
      ownerWebview as unknown as vscode.Webview
    );
    internals(provider).registerFeedbackWebview(
      documentKey,
      racingPeer as unknown as vscode.Webview
    );
    const applyEdit = jest.fn(async () => {
      document.getText.mockReturnValue(peerContent);
      return true;
    });
    internals(provider).applyEdit = applyEdit;

    sendStart(provider, document, ownerWebview, 'start-peer-pre-lock-race');
    // postMessage delivery is asynchronous in a real webview. The peer can
    // mutate locally and emit this stale edit before its lock handler runs.
    internals(provider).handleWebviewMessage(
      { type: 'edit', content: peerContent },
      document as unknown as vscode.TextDocument,
      racingPeer as unknown as vscode.Webview
    );
    expect(applyEdit).toHaveBeenCalledWith(
      peerContent,
      document,
      expect.objectContaining({ sourceWebview: racingPeer })
    );
    expect(internals(provider).feedbackTransitions.get(documentKey)?.invalidated).toBe(true);

    await expect(
      waitForMessage(ownerWebview, 'feedback.error', 'start-peer-pre-lock-race')
    ).resolves.toEqual(
      expect.objectContaining({
        code: 'MD4H-FB-SNAPSHOT-001',
        message: expect.stringMatching(/source changed/i),
      })
    );
    expect(messagesOfType(ownerWebview, 'feedback.started')).toHaveLength(0);
    const transitionLock = await waitForMessage(racingPeer, 'feedback.peer.locked');
    await expectTransitionSyncThenUnlock(
      provider,
      document,
      ownerWebview,
      racingPeer,
      'start-peer-pre-lock-race',
      transitionLock.lockId as string,
      peerContent
    );
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe(peerContent);
  });

  it('unlocks duplicate splits when the owning volatile session is released', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document);
    const duplicateWebview = createWebview(provider, document);
    const documentKey = document.uri.toString();
    internals(provider).registerFeedbackWebview(
      documentKey,
      ownerWebview as unknown as vscode.Webview
    );
    internals(provider).registerFeedbackWebview(
      documentKey,
      duplicateWebview as unknown as vscode.Webview
    );
    sendStart(provider, document, ownerWebview, 'start-peer-unlock');
    const started = await waitForMessage(ownerWebview, 'feedback.started', 'start-peer-unlock');
    const priorUnlockCount = messagesOfType(duplicateWebview, 'feedback.peer.unlocked').length;

    internals(provider).releaseFeedbackStateForWebview(
      documentKey,
      ownerWebview as unknown as vscode.Webview,
      document as unknown as vscode.TextDocument
    );
    const releaseUnlocks = messagesOfType(duplicateWebview, 'feedback.peer.unlocked').slice(
      priorUnlockCount
    );

    expect(releaseUnlocks).toEqual([expect.objectContaining({ lockId: started.sessionId })]);
    expectPeerUpdateBeforeUnlock(duplicateWebview, started.sessionId as string, SOURCE_TEXT);
  });

  it('locks a duplicate split that opens after Feedback is already active', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document);
    const documentKey = document.uri.toString();
    internals(provider).registerFeedbackWebview(
      documentKey,
      ownerWebview as unknown as vscode.Webview
    );
    sendStart(provider, document, ownerWebview, 'start-before-late-split');
    const started = await waitForMessage(
      ownerWebview,
      'feedback.started',
      'start-before-late-split'
    );
    const duplicateWebview = createWebview(provider, document);

    internals(provider).registerFeedbackWebview(
      documentKey,
      duplicateWebview as unknown as vscode.Webview
    );

    await expect(waitForMessage(duplicateWebview, 'feedback.peer.locked')).resolves.toEqual(
      expect.objectContaining({ lockId: started.sessionId })
    );
  });

  it('delivers current Markdown and the active lock to a late peer independently', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document);
    const documentKey = document.uri.toString();
    internals(provider).registerFeedbackWebview(
      documentKey,
      ownerWebview as unknown as vscode.Webview
    );
    internals(provider).updateWebview(
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    const lateWebview = createWebview(provider, document);
    internals(provider).registerFeedbackWebview(
      documentKey,
      lateWebview as unknown as vscode.Webview
    );
    internals(provider).updateWebview(
      document as unknown as vscode.TextDocument,
      lateWebview as unknown as vscode.Webview
    );
    internals(provider).updateWebview(
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    internals(provider).updateWebview(
      document as unknown as vscode.TextDocument,
      lateWebview as unknown as vscode.Webview
    );

    expect(messagesOfType(ownerWebview, 'update')).toHaveLength(1);
    expect(messagesOfType(lateWebview, 'update')).toHaveLength(1);

    sendStart(provider, document, ownerWebview, 'start-before-late-content-split');
    const started = await waitForMessage(
      ownerWebview,
      'feedback.started',
      'start-before-late-content-split'
    );

    expect(messagesOfType(lateWebview, 'feedback.peer.locked')).toContainEqual(
      expect.objectContaining({ lockId: started.sessionId })
    );
    expect(messagesOfType(lateWebview, 'update')).toContainEqual(
      expect.objectContaining({ content: SOURCE_TEXT })
    );
  });

  it('updates every locked peer with external Markdown before releasing its lock', async () => {
    (vscode.window.showWarningMessage as jest.Mock).mockReset();
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Discard draft');
    (vscode.workspace as unknown as { fs: { delete: jest.Mock } }).fs = {
      delete: jest.fn(async () => undefined),
    };
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document);
    const firstPeer = createWebview(provider, document);
    const secondPeer = createWebview(provider, document);
    const documentKey = document.uri.toString();
    internals(provider).registerFeedbackWebview(
      documentKey,
      ownerWebview as unknown as vscode.Webview
    );
    internals(provider).registerFeedbackWebview(
      documentKey,
      firstPeer as unknown as vscode.Webview
    );
    internals(provider).registerFeedbackWebview(
      documentKey,
      secondPeer as unknown as vscode.Webview
    );
    internals(provider).updateWebview(
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    const started = await startAndAddTextFeedback(provider, document, ownerWebview);
    await expect(waitForMessage(firstPeer, 'feedback.peer.locked')).resolves.toEqual(
      expect.objectContaining({ lockId: expect.any(String) })
    );
    await expect(waitForMessage(secondPeer, 'feedback.peer.locked')).resolves.toEqual(
      expect.objectContaining({ lockId: expect.any(String) })
    );

    const externalContent = '# External source\n\nEvery split must receive this.\n';
    await writeFile(sourcePath, externalContent, 'utf8');
    document.getText.mockReturnValue(externalContent);
    expect(
      internals(provider).handleFeedbackDocumentChange(
        documentKey,
        ownerWebview as unknown as vscode.Webview,
        externalContent
      )
    ).toBe(true);
    await waitForMessage(ownerWebview, 'feedback.invalidated');
    internals(provider).updateWebview(
      document as unknown as vscode.TextDocument,
      firstPeer as unknown as vscode.Webview
    );
    internals(provider).updateWebview(
      document as unknown as vscode.TextDocument,
      secondPeer as unknown as vscode.Webview
    );

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.discard',
        requestId: 'discard-after-peer-sync',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    await waitForMessage(ownerWebview, 'feedback.discarded', 'discard-after-peer-sync');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.ready',
        requestId: 'discard-after-peer-sync',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    await waitForMessage(ownerWebview, 'feedback.close.sync', 'discard-after-peer-sync');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.applied',
        requestId: 'discard-after-peer-sync',
        sessionId: started.sessionId,
        revision: 1,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    await expect(
      waitForMessage(ownerWebview, 'feedback.close.release', 'discard-after-peer-sync')
    ).resolves.toEqual(expect.objectContaining({ revision: 1, sessionId: started.sessionId }));
    expect(internals(provider).feedbackSessions.size).toBe(1);
    for (const peer of [firstPeer, secondPeer]) {
      expect(
        messagesOfType(peer, 'feedback.peer.unlocked').some(
          candidate => candidate.lockId === started.sessionId
        )
      ).toBe(false);
    }

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.released',
        requestId: 'discard-after-peer-sync',
        sessionId: started.sessionId,
        revision: 1,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(internals(provider).feedbackSessions.size).toBe(0);
    expectPeerUpdateBeforeUnlock(firstPeer, started.sessionId as string, externalContent);
    expectPeerUpdateBeforeUnlock(secondPeer, started.sessionId as string, externalContent);
  });

  it('unlocks duplicate splits when Feedback start fails', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document, false);
    const duplicateWebview = createWebview(provider, document);
    const documentKey = document.uri.toString();
    internals(provider).registerFeedbackWebview(
      documentKey,
      ownerWebview as unknown as vscode.Webview
    );
    internals(provider).registerFeedbackWebview(
      documentKey,
      duplicateWebview as unknown as vscode.Webview
    );

    sendStart(provider, document, ownerWebview, 'start-peer-unlock-on-error');
    const locked = await waitForMessage(duplicateWebview, 'feedback.peer.locked');
    await waitForMessage(ownerWebview, 'feedback.error', 'start-peer-unlock-on-error');
    const unlocked = await waitForMessage(duplicateWebview, 'feedback.peer.unlocked');

    expect(unlocked.lockId).toBe(locked.lockId);
  });

  it('keeps ordinary split editing available when Feedback is inactive', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const applyEdit = jest
      .spyOn(provider as never, 'applyEdit' as never)
      .mockResolvedValue(true as never);

    internals(provider).handleWebviewMessage(
      { type: 'edit', content: '# Normal split edit\n' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    expect(applyEdit).toHaveBeenCalledTimes(1);
  });

  it('does not release an owned Feedback session when a duplicate split view closes', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document);
    const duplicateWebview = createWebview(provider, document);
    sendStart(provider, document, ownerWebview, 'start-split-disposal');
    await waitForMessage(ownerWebview, 'feedback.started', 'start-split-disposal');

    internals(provider).releaseFeedbackStateForWebview(
      document.uri.toString(),
      duplicateWebview as unknown as vscode.Webview
    );
    expect(internals(provider).feedbackSessions.size).toBe(1);

    internals(provider).releaseFeedbackStateForWebview(
      document.uri.toString(),
      ownerWebview as unknown as vscode.Webview,
      document as unknown as vscode.TextDocument
    );
    expect(internals(provider).feedbackSessions.size).toBe(0);
  });

  it('bounds an exact rendered range against frozen blocks and adds host-owned hashes', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    sendStart(provider, document, webview, 'start-exact-range');
    const started = await waitForMessage(webview, 'feedback.started', 'start-exact-range');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-exact-range',
        sessionId: started.sessionId,
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Paragraph.',
        feedback: 'Make this precise.',
        renderedRange: PARAGRAPH_RENDERED_RANGE_INPUT,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const updated = await waitForMessage(webview, 'feedback.updated', 'add-exact-range');
    expect(updated.sessionId).toBe(started.sessionId);
    const paragraphHash = createHash('sha256').update('Paragraph.').digest('hex');
    expect(updated.items).toEqual([
      expect.objectContaining({
        id: 'F1',
        renderedRange: {
          ...PARAGRAPH_RENDERED_RANGE_INPUT,
          startBlockSha256: paragraphHash,
          endBlockSha256: paragraphHash,
        },
      }),
    ]);

    const report = await readFile(path.join(workspaceRoot, started.feedbackFile as string), 'utf8');
    expect(report).toContain(`"startBlockSha256":"${paragraphHash}"`);
    expect(report).toContain(`"endBlockSha256":"${paragraphHash}"`);
  });

  it.each([
    [
      'out-of-bounds end offset',
      { ...PARAGRAPH_RENDERED_RANGE_INPUT, endOffset: 'Paragraph.'.length + 1 },
    ],
    [
      'range ordinals that disagree with the mapped target',
      {
        version: 1,
        startOrdinal: 0,
        startOffset: 0,
        endOrdinal: 0,
        endOffset: 'Guide'.length,
      },
    ],
  ])('rejects %s without persisting or fuzzily re-anchoring', async (_label, renderedRange) => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    sendStart(provider, document, webview, 'start-invalid-exact-range');
    const started = await waitForMessage(webview, 'feedback.started', 'start-invalid-exact-range');
    const session = internals(provider).feedbackSessions.get(document.uri.toString())!;
    const reportBefore = await readFile(session.store.feedbackFilePath);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-invalid-exact-range',
        sessionId: started.sessionId,
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Paragraph.',
        feedback: 'Must not be stored.',
        renderedRange,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const error = await waitForMessage(webview, 'feedback.error', 'add-invalid-exact-range');
    expect(error.code).toBe('MD4H-FB-ANCHOR-001');
    expect(session.store.items).toEqual([]);
    await expect(readFile(session.store.feedbackFilePath)).resolves.toEqual(reportBefore);
  });

  it('fails closed instead of substituting block zero when a stored target invariant is missing', () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const brokenSession = {
      store: {
        items: [
          {
            id: 'F9',
            kind: 'text',
            startLine: 99,
            endLine: 100,
            focus: 'Unmappable focus',
            feedback: 'Must not appear on block zero.',
          },
        ],
      },
      anchorMap: {
        blocks: [
          { ordinal: 0, kind: 'heading', startLine: 1, endLine: 1 },
          { ordinal: 1, kind: 'paragraph', startLine: 3, endLine: 3 },
        ],
      },
      targets: new Map(),
      degradedRenderedRangeIds: new Set(),
    };

    let thrown: unknown;
    try {
      internals(provider).feedbackItems(brokenSession, webview as unknown as vscode.Webview);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(
      expect.objectContaining({
        code: 'MD4H-FB-ANCHOR-001',
        message: expect.stringMatching(/F9|map/i),
      })
    );
  });

  it('returns a scoped capture preview URI and changes it after replacement', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);

    sendStart(provider, document, webview, 'start-screenshot-preview');
    const started = await waitForMessage(webview, 'feedback.started', 'start-screenshot-preview');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.screenshot.add',
        requestId: 'add-screenshot-preview',
        sessionId: started.sessionId,
        startOrdinal: 1,
        endOrdinal: 1,
        imageDataUrl: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`,
        feedback: 'Keep this visual evidence.',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const added = await waitForMessage(webview, 'feedback.updated', 'add-screenshot-preview');
    const firstItem = (added.items as Array<Record<string, unknown>>)[0];
    expect(firstItem).toEqual(
      expect.objectContaining({
        id: 'F1',
        kind: 'screenshot',
        imageUri: expect.stringMatching(/^vscode-webview:\/\/feedback\//),
      })
    );
    expect(firstItem).not.toHaveProperty('imagePath');
    expect(JSON.stringify(firstItem)).not.toContain(workspaceRoot);
    expect(webview.asWebviewUri).toHaveBeenCalledWith(
      expect.objectContaining({
        fsPath: path.join(
          workspaceRoot,
          '.md4h',
          'feedback',
          'docs',
          `guide.md--${started.round as string}`,
          'assets',
          'F1.png'
        ),
      })
    );

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.item.edit',
        requestId: 'edit-screenshot-feedback',
        sessionId: started.sessionId,
        id: 'F1',
        feedback: 'Keep this visual evidence, with a clearer explanation.',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const edited = await waitForMessage(webview, 'feedback.updated', 'edit-screenshot-feedback');
    expect((edited.items as Array<Record<string, unknown>>)[0].imageUri).toBe(firstItem.imageUri);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.screenshot.replace',
        requestId: 'replace-screenshot-preview',
        sessionId: started.sessionId,
        id: 'F1',
        startOrdinal: 1,
        endOrdinal: 1,
        imageDataUrl: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`,
        feedback: 'Use the replacement evidence.',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const replaced = await waitForMessage(
      webview,
      'feedback.updated',
      'replace-screenshot-preview'
    );
    const replacementItem = (replaced.items as Array<Record<string, unknown>>)[0];
    expect(replacementItem.imageUri).toEqual(expect.any(String));
    expect(replacementItem.imageUri).not.toBe(firstItem.imageUri);
  });

  it('returns a scoped capture preview URI when resuming a saved screenshot draft', async () => {
    const firstProvider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const firstWebview = createWebview(firstProvider, document);
    sendStart(firstProvider, document, firstWebview, 'start-resumable-screenshot');
    const started = await waitForMessage(
      firstWebview,
      'feedback.started',
      'start-resumable-screenshot'
    );
    internals(firstProvider).handleWebviewMessage(
      {
        type: 'feedback.screenshot.add',
        requestId: 'add-resumable-screenshot',
        sessionId: started.sessionId,
        startOrdinal: 0,
        endOrdinal: 0,
        imageDataUrl: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`,
        feedback: 'Persist this capture.',
      },
      document as unknown as vscode.TextDocument,
      firstWebview as unknown as vscode.Webview
    );
    await waitForMessage(firstWebview, 'feedback.updated', 'add-resumable-screenshot');

    const resumedProvider = createProvider(workspaceRoot);
    const resumedWebview = createWebview(resumedProvider, document);
    internals(resumedProvider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-screenshot-preview',
        round: started.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      resumedWebview as unknown as vscode.Webview
    );

    const resumed = await waitForMessage(
      resumedWebview,
      'feedback.started',
      'resume-screenshot-preview'
    );
    expect(resumed.items).toEqual([
      expect.objectContaining({
        id: 'F1',
        kind: 'screenshot',
        imageUri: expect.stringMatching(/^vscode-webview:\/\/feedback\//),
      }),
    ]);
    expect(resumedWebview.asWebviewUri).toHaveBeenCalledWith(
      expect.objectContaining({
        fsPath: expect.stringMatching(/[/\\]assets[/\\]F1\.png$/),
      })
    );
  });

  it('records a content-free capture code for Copy diagnostics', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const writeText = jest.fn<Promise<void>, [string]>(async () => undefined);
    (vscode.env as unknown as { clipboard: { writeText: typeof writeText } }).clipboard = {
      writeText,
    };
    sendStart(provider, document, webview, 'start-capture-diagnostics');
    const started = await waitForMessage(webview, 'feedback.started', 'start-capture-diagnostics');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.capture.error',
        requestId: 'capture-error',
        sessionId: started.sessionId,
        code: 'MD4H-FB-CAPTURE-002',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.copyDiagnostics',
        requestId: 'copy-capture-diagnostics',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await waitForMessage(webview, 'feedback.diagnosticsCopied', 'copy-capture-diagnostics');
    expect(writeText).toHaveBeenCalledTimes(1);
    const diagnostics = writeText.mock.calls[0][0];
    expect(diagnostics).toContain('code: MD4H-FB-CAPTURE-002');
    expect(diagnostics).not.toContain(SOURCE_TEXT);
  });

  it('creates the bundle only in the workspace root containing the Markdown source', async () => {
    const secondWorkspaceRoot = await mkdtemp(path.join(tmpdir(), 'md4h-feedback-provider-root2-'));
    try {
      const secondSourcePath = path.join(secondWorkspaceRoot, 'docs', 'guide.md');
      await writeFileEnsuringDirectory(secondSourcePath, SOURCE_BYTES);
      const firstFolder = {
        uri: fileUri(workspaceRoot),
        name: 'first-root',
        index: 0,
      } as vscode.WorkspaceFolder;
      const secondFolder = {
        uri: fileUri(secondWorkspaceRoot),
        name: 'second-root',
        index: 1,
      } as vscode.WorkspaceFolder;
      (
        vscode.workspace as unknown as { workspaceFolders?: vscode.WorkspaceFolder[] }
      ).workspaceFolders = [firstFolder, secondFolder];
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockImplementation((uri: vscode.Uri) =>
        uri.fsPath.startsWith(secondWorkspaceRoot + path.sep) ? secondFolder : firstFolder
      );

      const provider = createProvider(workspaceRoot);
      const document = createDocument(secondSourcePath, SOURCE_TEXT);
      const webview = createWebview(provider, document);
      sendStart(provider, document, webview, 'start-second-root');

      const started = await waitForMessage(webview, 'feedback.started', 'start-second-root');
      const relativeFeedbackFile = started.feedbackFile as string;
      expect(relativeFeedbackFile).toMatch(
        /^\.md4h\/feedback\/docs\/guide\.md--\d{8}T\d{6}Z-[a-z0-9]{4}\/feedback\.md$/
      );
      await expect(pathExists(path.join(secondWorkspaceRoot, relativeFeedbackFile))).resolves.toBe(
        true
      );
      await expect(pathExists(path.join(workspaceRoot, relativeFeedbackFile))).resolves.toBe(false);
    } finally {
      await rm(secondWorkspaceRoot, { recursive: true, force: true });
    }
  });

  it('serializes rapid start requests so only one draft can be created', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);

    sendStart(provider, document, webview, 'start-first');
    sendStart(provider, document, webview, 'start-second');

    await waitForMessage(webview, 'feedback.started', 'start-first');
    const error = await waitForMessage(webview, 'feedback.error', 'start-second');
    expect(error.message).toMatch(/already|starting/i);
    const sourceFeedbackDirectory = path.join(workspaceRoot, '.md4h', 'feedback', 'docs');
    expect(await readdir(sourceFeedbackDirectory)).toHaveLength(1);
  });

  it('cleans a cancelled transition after bundle creation without activating an orphan session', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const originalCreate = FeedbackSessionStore.create.bind(FeedbackSessionStore);
    let releaseCreate!: () => void;
    const createGate = new Promise<void>(resolve => {
      releaseCreate = resolve;
    });
    let reportCreated!: (store: FeedbackSessionStore) => void;
    const created = new Promise<FeedbackSessionStore>(resolve => {
      reportCreated = resolve;
    });
    const createSpy = jest
      .spyOn(FeedbackSessionStore, 'create')
      .mockImplementation(async options => {
        const store = await originalCreate(options);
        reportCreated(store);
        await createGate;
        return store;
      });

    try {
      sendStart(provider, document, webview, 'start-cancelled-after-create');
      const store = await created;
      internals(provider).feedbackTransitions.delete(document.uri.toString());
      releaseCreate();

      const error = await waitForMessage(webview, 'feedback.error', 'start-cancelled-after-create');
      expect(error.message).toMatch(/cancelled|closed|changed state/i);
      expect(internals(provider).feedbackTransitions.size).toBe(0);
      expect(internals(provider).feedbackSessions.size).toBe(0);
      await expect(pathExists(store.feedbackFilePath)).resolves.toBe(true);
    } finally {
      releaseCreate();
      createSpy.mockRestore();
    }
  });

  it('cancels a locked start transition when the source changes before activation', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document);
    const duplicateWebview = createWebview(provider, document);
    const documentKey = document.uri.toString();
    internals(provider).registerFeedbackWebview(
      documentKey,
      ownerWebview as unknown as vscode.Webview
    );
    internals(provider).registerFeedbackWebview(
      documentKey,
      duplicateWebview as unknown as vscode.Webview
    );
    const originalCreate = FeedbackSessionStore.create.bind(FeedbackSessionStore);
    let releaseCreate!: () => void;
    const createGate = new Promise<void>(resolve => {
      releaseCreate = resolve;
    });
    let reportCreated!: (store: FeedbackSessionStore) => void;
    const created = new Promise<FeedbackSessionStore>(resolve => {
      reportCreated = resolve;
    });
    const createSpy = jest
      .spyOn(FeedbackSessionStore, 'create')
      .mockImplementation(async options => {
        const store = await originalCreate(options);
        reportCreated(store);
        await createGate;
        return store;
      });

    try {
      sendStart(provider, document, ownerWebview, 'start-source-race');
      const transitionLock = await waitForMessage(duplicateWebview, 'feedback.peer.locked');
      const store = await created;
      const externalContent = '# Changed while Feedback starts\n\nUse this source.\n';
      await writeFile(sourcePath, externalContent, 'utf8');
      document.getText.mockReturnValue(externalContent);
      expect(
        internals(provider).handleFeedbackDocumentChange(
          documentKey,
          ownerWebview as unknown as vscode.Webview,
          externalContent
        )
      ).toBe(true);
      releaseCreate();

      const error = await waitForMessage(ownerWebview, 'feedback.error', 'start-source-race');
      expect(error).toEqual(
        expect.objectContaining({
          code: 'MD4H-FB-SNAPSHOT-001',
          message: expect.stringMatching(/source changed/i),
        })
      );
      expect(internals(provider).feedbackTransitions.size).toBe(1);
      expect(internals(provider).feedbackSessions.size).toBe(0);
      await expect(pathExists(store.feedbackFilePath)).resolves.toBe(true);
      await expectTransitionSyncThenUnlock(
        provider,
        document,
        ownerWebview,
        duplicateWebview,
        'start-source-race',
        transitionLock.lockId as string,
        externalContent
      );
    } finally {
      releaseCreate();
      createSpy.mockRestore();
    }
  });

  it('resynchronizes a failed resume owner before unlocking its peer', async () => {
    const draft = await FeedbackSessionStore.create({
      workspaceRoot,
      sourcePath,
      sourceBytes: SOURCE_BYTES,
      now: new Date('2026-08-21T09:30:00.000Z'),
      roundSuffix: 'rs01',
    });
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document);
    const duplicateWebview = createWebview(provider, document);
    const documentKey = document.uri.toString();
    internals(provider).registerFeedbackWebview(
      documentKey,
      ownerWebview as unknown as vscode.Webview
    );
    internals(provider).registerFeedbackWebview(
      documentKey,
      duplicateWebview as unknown as vscode.Webview
    );
    const originalResume = FeedbackSessionStore.resume.bind(FeedbackSessionStore);
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>(resolve => {
      releaseResume = resolve;
    });
    let reportResumed!: () => void;
    const resumedStoreLoaded = new Promise<void>(resolve => {
      reportResumed = resolve;
    });
    const resumeSpy = jest
      .spyOn(FeedbackSessionStore, 'resume')
      .mockImplementation(async options => {
        const store = await originalResume(options);
        reportResumed();
        await resumeGate;
        return store;
      });

    try {
      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.draft.resume',
          requestId: 'resume-source-race',
          round: draft.snapshot.round,
          blocks: START_BLOCKS,
        },
        document as unknown as vscode.TextDocument,
        ownerWebview as unknown as vscode.Webview
      );
      const transitionLock = await waitForMessage(duplicateWebview, 'feedback.peer.locked');
      await resumedStoreLoaded;
      const externalContent = '# Changed while Feedback resumes\n\nKeep the new source.\n';
      await writeFile(sourcePath, externalContent, 'utf8');
      document.getText.mockReturnValue(externalContent);
      expect(
        internals(provider).handleFeedbackDocumentChange(
          documentKey,
          ownerWebview as unknown as vscode.Webview,
          externalContent
        )
      ).toBe(true);
      releaseResume();

      await expect(
        waitForMessage(ownerWebview, 'feedback.error', 'resume-source-race')
      ).resolves.toEqual(
        expect.objectContaining({
          code: 'MD4H-FB-SNAPSHOT-001',
          message: expect.stringMatching(/source changed/i),
        })
      );
      expect(internals(provider).feedbackSessions.size).toBe(0);
      expect(internals(provider).feedbackTransitions.size).toBe(1);
      await expect(
        waitForMessage(ownerWebview, 'feedback.transition.sync', 'resume-source-race')
      ).resolves.toEqual({
        type: 'feedback.transition.sync',
        requestId: 'resume-source-race',
        lockId: transitionLock.lockId,
        revision: 1,
        content: externalContent,
      });
      expect(
        messagesOfType(duplicateWebview, 'feedback.peer.unlocked').some(
          candidate => candidate.lockId === transitionLock.lockId
        )
      ).toBe(false);

      const newerExternalContent =
        '# Changed again before resume unlock\n\nUse the newest source.\n';
      await writeFile(sourcePath, newerExternalContent, 'utf8');
      document.getText.mockReturnValue(newerExternalContent);
      expect(
        internals(provider).handleFeedbackDocumentChange(
          documentKey,
          ownerWebview as unknown as vscode.Webview,
          newerExternalContent
        )
      ).toBe(true);
      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.transition.applied',
          requestId: 'resume-source-race',
          lockId: transitionLock.lockId,
          revision: 1,
        },
        document as unknown as vscode.TextDocument,
        ownerWebview as unknown as vscode.Webview
      );
      await expect(
        waitForNthMessage(ownerWebview, 'feedback.transition.sync', 2, 'resume-source-race')
      ).resolves.toEqual({
        type: 'feedback.transition.sync',
        requestId: 'resume-source-race',
        lockId: transitionLock.lockId,
        revision: 2,
        content: newerExternalContent,
      });
      expect(internals(provider).feedbackTransitions.size).toBe(1);
      expect(
        messagesOfType(duplicateWebview, 'feedback.peer.unlocked').some(
          candidate => candidate.lockId === transitionLock.lockId
        )
      ).toBe(false);

      const errorsBeforeStaleApplied = messagesOfType(ownerWebview, 'feedback.error').length;
      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.transition.applied',
          requestId: 'resume-source-race',
          lockId: transitionLock.lockId,
          revision: 1,
        },
        document as unknown as vscode.TextDocument,
        ownerWebview as unknown as vscode.Webview
      );
      await expect(
        waitForNthMessage(
          ownerWebview,
          'feedback.error',
          errorsBeforeStaleApplied + 1,
          'resume-source-race'
        )
      ).resolves.toEqual(
        expect.objectContaining({
          code: 'MD4H-FB-STORE-001',
          message: expect.stringMatching(/stale|premature/i),
        })
      );
      expect(internals(provider).feedbackTransitions.size).toBe(1);
      expect(
        messagesOfType(duplicateWebview, 'feedback.peer.unlocked').some(
          candidate => candidate.lockId === transitionLock.lockId
        )
      ).toBe(false);

      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.transition.applied',
          requestId: 'resume-source-race',
          lockId: transitionLock.lockId,
          revision: 2,
        },
        document as unknown as vscode.TextDocument,
        ownerWebview as unknown as vscode.Webview
      );
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(internals(provider).feedbackTransitions.size).toBe(0);
      expect(messagesOfType(duplicateWebview, 'feedback.peer.unlocked')).toContainEqual(
        expect.objectContaining({ lockId: transitionLock.lockId })
      );
    } finally {
      releaseResume();
      resumeSpy.mockRestore();
    }
  });

  it('rechecks exact source bytes before activating a newly created session', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const originalCreate = FeedbackSessionStore.create.bind(FeedbackSessionStore);
    let releaseCreate!: () => void;
    const createGate = new Promise<void>(resolve => {
      releaseCreate = resolve;
    });
    let reportCreated!: (store: FeedbackSessionStore) => void;
    const created = new Promise<FeedbackSessionStore>(resolve => {
      reportCreated = resolve;
    });
    const createSpy = jest
      .spyOn(FeedbackSessionStore, 'create')
      .mockImplementation(async options => {
        const store = await originalCreate(options);
        reportCreated(store);
        await createGate;
        return store;
      });

    try {
      sendStart(provider, document, webview, 'start-source-recheck');
      const store = await created;
      await writeFile(sourcePath, Buffer.from('# Changed during start\n', 'utf8'));
      releaseCreate();

      const error = await waitForMessage(webview, 'feedback.error', 'start-source-recheck');
      expect(error).toEqual(
        expect.objectContaining({
          code: 'MD4H-FB-SNAPSHOT-001',
          message: expect.stringMatching(/source changed/i),
        })
      );
      expect(internals(provider).feedbackSessions.size).toBe(0);
      await expect(pathExists(store.feedbackFilePath)).resolves.toBe(true);
    } finally {
      releaseCreate();
      createSpy.mockRestore();
    }
  });

  it('rejects legacy document mutation and source-split messages while frozen', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    sendStart(provider, document, webview, 'start-lock-host');
    await waitForMessage(webview, 'feedback.started', 'start-lock-host');
    (vscode.workspace.applyEdit as jest.Mock).mockClear();
    (vscode.commands.executeCommand as jest.Mock).mockClear();

    internals(provider).handleWebviewMessage(
      { type: 'edit', content: '# Mutated\n' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    internals(provider).handleWebviewMessage(
      { type: 'openSourceView' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['save returns false', jest.fn(async () => false)],
    ['save rejects', jest.fn(async () => Promise.reject(new Error('disk is read-only')))],
  ])('does not create or retain a session when %s', async (_label, save) => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT, { dirty: true, save });
    const webview = createWebview(provider, document);

    sendStart(provider, document, webview, 'start-save-failure');

    const error = await waitForMessage(webview, 'feedback.error', 'start-save-failure');
    expect(error).toEqual(
      expect.objectContaining({
        type: 'feedback.error',
        requestId: 'start-save-failure',
        message: expect.stringMatching(/save/i),
        recoverable: true,
      })
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(internals(provider).feedbackSessions.size).toBe(0);
    await expect(pathExists(path.join(workspaceRoot, '.md4h', 'feedback'))).resolves.toBe(false);
  });

  it('invalidates a changed source, blocks finish, and preserves the draft bundle', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);
    const feedbackFile = path.join(workspaceRoot, started.feedbackFile as string);

    await writeFile(sourcePath, Buffer.from('# Guide changed externally\n', 'utf8'));
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.finish',
        requestId: 'finish-stale',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const invalidated = await waitForMessage(webview, 'feedback.invalidated');
    expect(invalidated).toEqual(
      expect.objectContaining({
        type: 'feedback.invalidated',
        sessionId: started.sessionId,
        code: 'MD4H-FB-SNAPSHOT-001',
        message: expect.any(String),
      })
    );
    expect(messagesOfType(webview, 'feedback.finished')).toHaveLength(0);
    expect(internals(provider).feedbackSessions.size).toBe(1);
    await expect(readFile(feedbackFile, 'utf8')).resolves.toEqual(
      expect.stringContaining('state: draft')
    );
    await expect(pathExists(feedbackFile)).resolves.toBe(true);
  });

  it('rolls back a text add when the document invalidates during its report commit', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    sendStart(provider, document, webview, 'start-add-race');
    const started = await waitForMessage(webview, 'feedback.started', 'start-add-race');
    const documentKey = document.uri.toString();
    const session = internals(provider).feedbackSessions.get(documentKey);
    expect(session).toBeDefined();
    const store = session!.store;
    const reportBefore = await readFile(store.feedbackFilePath);
    const originalAdd = store.addTextFeedback.bind(store);
    const originalAddWithGuard = originalAdd as unknown as (
      input: AddTextFeedbackInput,
      beforeCommit?: () => void | Promise<void>
    ) => Promise<TextFeedbackItem>;
    store.addTextFeedback = (async (
      input: AddTextFeedbackInput,
      beforeCommit?: () => void | Promise<void>
    ) => {
      expect(beforeCommit).toEqual(expect.any(Function));
      let guardCalls = 0;
      return originalAddWithGuard(input, async () => {
        await beforeCommit?.();
        guardCalls += 1;
        if (guardCalls === 1) {
          internals(provider).invalidateFeedbackSession(
            documentKey,
            webview as unknown as vscode.Webview
          );
        }
      });
    }) as typeof store.addTextFeedback;

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-during-invalidation',
        sessionId: started.sessionId,
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Paragraph.',
        feedback: 'This must not survive invalidation.',
        renderedRange: PARAGRAPH_RENDERED_RANGE_INPUT,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await waitForMessage(webview, 'feedback.invalidated');
    const error = await waitForMessage(webview, 'feedback.error', 'add-during-invalidation');
    expect(error.code).toBe('MD4H-FB-SNAPSHOT-001');
    expect(messagesOfType(webview, 'feedback.updated')).toHaveLength(0);
    expect(store.items).toEqual([]);
    await expect(readFile(store.feedbackFilePath)).resolves.toEqual(reportBefore);
    await expect(pathExists(`${store.feedbackFilePath}.lock`)).resolves.toBe(false);
  });

  it('rechecks the exact source bytes before a report mutation without relying on a VS Code change event', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    sendStart(provider, document, webview, 'start-source-guard');
    const started = await waitForMessage(webview, 'feedback.started', 'start-source-guard');
    const session = internals(provider).feedbackSessions.get(document.uri.toString());
    expect(session).toBeDefined();
    const reportBefore = await readFile(session!.store.feedbackFilePath);

    await writeFile(sourcePath, '# Changed without a document event\n');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-after-silent-source-change',
        sessionId: started.sessionId,
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Paragraph.',
        feedback: 'This write must be rejected.',
        renderedRange: PARAGRAPH_RENDERED_RANGE_INPUT,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const invalidated = await waitForMessage(webview, 'feedback.invalidated');
    const error = await waitForMessage(webview, 'feedback.error', 'add-after-silent-source-change');
    expect(invalidated.code).toBe('MD4H-FB-SNAPSHOT-001');
    expect(error.code).toBe('MD4H-FB-SNAPSHOT-001');
    expect(session!.store.items).toEqual([]);
    await expect(readFile(session!.store.feedbackFilePath)).resolves.toEqual(reportBefore);
  });

  it('keeps the draft active when invalidation lands during the seal commit', async () => {
    const writeText = jest.fn(async () => undefined);
    (vscode.env as unknown as { clipboard: { writeText: typeof writeText } }).clipboard = {
      writeText,
    };
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);
    const documentKey = document.uri.toString();
    const session = internals(provider).feedbackSessions.get(documentKey);
    expect(session).toBeDefined();
    const store = session!.store;
    const reportBefore = await readFile(store.feedbackFilePath);
    const originalSeal = store.seal.bind(store);
    store.seal = (async (bytes, sealedAt, beforeCommit) => {
      expect(beforeCommit).toEqual(expect.any(Function));
      let guardCalls = 0;
      return originalSeal(bytes, sealedAt, async () => {
        await beforeCommit?.();
        guardCalls += 1;
        if (guardCalls === 1) {
          internals(provider).invalidateFeedbackSession(
            documentKey,
            webview as unknown as vscode.Webview
          );
        }
      });
    }) as typeof store.seal;

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.finish',
        requestId: 'finish-during-invalidation',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await waitForMessage(webview, 'feedback.invalidated');
    const error = await waitForMessage(webview, 'feedback.error', 'finish-during-invalidation');
    expect(error.code).toBe('MD4H-FB-SNAPSHOT-001');
    expect(messagesOfType(webview, 'feedback.finished')).toHaveLength(0);
    expect(writeText).not.toHaveBeenCalled();
    expect(internals(provider).feedbackSessions.get(documentKey)).toBe(session);
    expect(store.snapshot.state).toBe('draft');
    await expect(readFile(store.feedbackFilePath)).resolves.toEqual(reportBefore);
    await expect(pathExists(`${store.feedbackFilePath}.lock`)).resolves.toBe(false);
  });

  it('seals a valid draft and copies the exact agent handoff prompt', async () => {
    const writeText = jest.fn(async () => undefined);
    (vscode.env as unknown as { clipboard: { writeText: typeof writeText } }).clipboard = {
      writeText,
    };
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      webview as unknown as vscode.Webview
    );
    const started = await startAndAddTextFeedback(provider, document, webview);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.finish',
        requestId: 'finish-valid',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const finished = await waitForMessage(webview, 'feedback.finished', 'finish-valid');
    expect(finished).toEqual({
      type: 'feedback.finished',
      requestId: 'finish-valid',
      sessionId: started.sessionId,
      feedbackFile: started.feedbackFile,
      itemCount: 1,
      prompt:
        `Implement the sealed feedback bundle at \`${started.feedbackFile as string}\`. ` +
        'First verify the source SHA-256. Inspect every referenced image. ' +
        'Edit the workspace files required by the feedback, but do not modify or delete the feedback bundle. ' +
        'Address every feedback ID, run appropriate checks, report the outcome per ID, ' +
        'and stop if the source hash differs.',
      promptCopied: true,
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(
      `Implement the sealed feedback bundle at \`${started.feedbackFile as string}\`. ` +
        'First verify the source SHA-256. Inspect every referenced image. ' +
        'Edit the workspace files required by the feedback, but do not modify or delete the feedback bundle. ' +
        'Address every feedback ID, run appropriate checks, report the outcome per ID, ' +
        'and stop if the source hash differs.'
    );
    await expect(
      readFile(path.join(workspaceRoot, started.feedbackFile as string), 'utf8')
    ).resolves.toEqual(expect.stringContaining('state: sealed'));
    expect(internals(provider).feedbackSessions.size).toBe(1);

    // The owner must not be able to unlock itself before the host has sent an
    // authoritative source payload and the webview has applied it.
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.applied',
        requestId: 'finish-valid',
        sessionId: started.sessionId,
        revision: 1,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(waitForMessage(webview, 'feedback.error', 'finish-valid')).resolves.toEqual(
      expect.objectContaining({ code: 'MD4H-FB-STORE-001', recoverable: true })
    );
    expect(internals(provider).feedbackSessions.size).toBe(1);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.ready',
        requestId: 'finish-valid',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await expect(waitForMessage(webview, 'feedback.close.sync', 'finish-valid')).resolves.toEqual({
      type: 'feedback.close.sync',
      requestId: 'finish-valid',
      sessionId: started.sessionId,
      revision: 1,
      content: SOURCE_TEXT,
    });
    expect(internals(provider).feedbackSessions.size).toBe(1);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.applied',
        requestId: 'finish-valid',
        sessionId: started.sessionId,
        revision: 1,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(messagesOfType(webview, 'feedback.close.release')).toContainEqual({
      type: 'feedback.close.release',
      requestId: 'finish-valid',
      sessionId: started.sessionId,
      revision: 1,
    });
    expect(internals(provider).feedbackSessions.size).toBe(1);
    expect(
      messagesOfType(webview, 'feedback.peer.unlocked').some(
        candidate => candidate.lockId === started.sessionId
      )
    ).toBe(false);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.released',
        requestId: 'finish-valid',
        sessionId: started.sessionId,
        revision: 1,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(internals(provider).feedbackSessions.size).toBe(0);
    expect(messagesOfType(webview, 'feedback.peer.unlocked')).toContainEqual(
      expect.objectContaining({ lockId: started.sessionId })
    );
  });

  it('keeps a sealed bundle immutable and delegates clipboard recovery to the webview', async () => {
    const writeText = jest.fn(async () => Promise.reject(new Error('clipboard unavailable')));
    (vscode.env as unknown as { clipboard: { writeText: typeof writeText } }).clipboard = {
      writeText,
    };
    const showWarningMessage = vscode.window.showWarningMessage as jest.Mock;
    showWarningMessage.mockResolvedValueOnce('Discard draft');
    const deleteFromWorkspace = jest.fn(async () => undefined);
    (vscode.workspace as unknown as { fs: { delete: typeof deleteFromWorkspace } }).fs = {
      delete: deleteFromWorkspace,
    };

    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);
    const documentKey = document.uri.toString();
    const duplicateWebview = createWebview(provider, document);
    internals(provider).registerFeedbackWebview(
      documentKey,
      duplicateWebview as unknown as vscode.Webview
    );
    await expect(waitForMessage(duplicateWebview, 'feedback.peer.locked')).resolves.toEqual(
      expect.objectContaining({ lockId: started.sessionId })
    );
    const feedbackFile = path.join(workspaceRoot, started.feedbackFile as string);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.finish',
        requestId: 'finish-clipboard-wait',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const finished = await waitForMessage(webview, 'feedback.finished', 'finish-clipboard-wait');
    expect(internals(provider).feedbackSessions.get(documentKey)).toEqual(
      expect.objectContaining({ phase: 'finishing' })
    );
    expect(finished).toEqual(
      expect.objectContaining({
        feedbackFile: started.feedbackFile,
        itemCount: 1,
        prompt: expect.stringContaining(`\`${started.feedbackFile as string}\``),
        promptCopied: false,
      })
    );
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(
      messagesOfType(duplicateWebview, 'feedback.peer.unlocked').some(
        candidate => candidate.lockId === started.sessionId
      )
    ).toBe(false);
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.discard',
        requestId: 'discard-during-finish',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(deleteFromWorkspace).not.toHaveBeenCalled();
    expect(messagesOfType(webview, 'feedback.discarded')).toHaveLength(0);
    await expect(readFile(feedbackFile, 'utf8')).resolves.toContain('state: sealed');
    expect(internals(provider).feedbackSessions.size).toBe(1);
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.ready',
        requestId: 'finish-clipboard-wait',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await waitForMessage(webview, 'feedback.close.sync', 'finish-clipboard-wait');
    expect(internals(provider).feedbackSessions.size).toBe(1);
    expect(
      messagesOfType(duplicateWebview, 'feedback.peer.unlocked').some(
        candidate => candidate.lockId === started.sessionId
      )
    ).toBe(false);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.applied',
        requestId: 'finish-clipboard-wait',
        sessionId: started.sessionId,
        revision: 1,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    await waitForMessage(webview, 'feedback.close.release', 'finish-clipboard-wait');
    expect(internals(provider).feedbackSessions.size).toBe(1);
    expect(
      messagesOfType(duplicateWebview, 'feedback.peer.unlocked').some(
        candidate => candidate.lockId === started.sessionId
      )
    ).toBe(false);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.released',
        requestId: 'finish-clipboard-wait',
        sessionId: started.sessionId,
        revision: 1,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(internals(provider).feedbackSessions.size).toBe(0);
    expect(messagesOfType(duplicateWebview, 'feedback.peer.unlocked')).toContainEqual(
      expect.objectContaining({ lockId: started.sessionId })
    );
  });

  it('cannot discard the draft while its finish transaction is still sealing', async () => {
    const writeText = jest.fn(async () => undefined);
    (vscode.env as unknown as { clipboard: { writeText: typeof writeText } }).clipboard = {
      writeText,
    };
    const showWarningMessage = vscode.window.showWarningMessage as jest.Mock;
    showWarningMessage.mockResolvedValueOnce('Discard draft');
    const deleteFromWorkspace = jest.fn(async () => undefined);
    (vscode.workspace as unknown as { fs: { delete: typeof deleteFromWorkspace } }).fs = {
      delete: deleteFromWorkspace,
    };

    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);
    const session = internals(provider).feedbackSessions.get(document.uri.toString());
    expect(session).toBeDefined();
    const store = session!.store;
    const originalSeal = store.seal.bind(store);
    let releaseSeal!: () => void;
    const sealGate = new Promise<void>(resolve => {
      releaseSeal = resolve;
    });
    let announceSealStarted!: () => void;
    const sealStarted = new Promise<void>(resolve => {
      announceSealStarted = resolve;
    });
    store.seal = (async (...args: Parameters<typeof originalSeal>) => {
      announceSealStarted();
      await sealGate;
      return originalSeal(...args);
    }) as typeof store.seal;

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.finish',
        requestId: 'finish-seal-wait',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await sealStarted;
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.discard',
        requestId: 'discard-during-seal',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const discardOutcome = await waitForOneOfMessages(
      webview,
      ['feedback.error', 'feedback.discarded'],
      'discard-during-seal'
    );
    releaseSeal();
    showWarningMessage.mockReset();

    expect(discardOutcome.type).toBe('feedback.error');
    expect(deleteFromWorkspace).not.toHaveBeenCalled();
    expect(messagesOfType(webview, 'feedback.discarded')).toHaveLength(0);

    await expect(waitForMessage(webview, 'feedback.finished', 'finish-seal-wait')).resolves.toEqual(
      expect.objectContaining({ promptCopied: true })
    );
  });

  it('waits for an in-flight item mutation before discarding the draft', async () => {
    const showWarningMessage = vscode.window.showWarningMessage as jest.Mock;
    showWarningMessage.mockReset();
    showWarningMessage.mockResolvedValueOnce('Discard draft');
    const deleteFromWorkspace = jest.fn(async () => undefined);
    (vscode.workspace as unknown as { fs: { delete: typeof deleteFromWorkspace } }).fs = {
      delete: deleteFromWorkspace,
    };
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    sendStart(provider, document, webview, 'start-discard-mutation-race');
    const started = await waitForMessage(
      webview,
      'feedback.started',
      'start-discard-mutation-race'
    );
    const session = internals(provider).feedbackSessions.get(document.uri.toString());
    expect(session).toBeDefined();
    const store = session!.store;
    const originalAdd = store.addTextFeedback.bind(store);
    let releaseAdd!: () => void;
    const addGate = new Promise<void>(resolve => {
      releaseAdd = resolve;
    });
    let announceAddStarted!: () => void;
    const addStarted = new Promise<void>(resolve => {
      announceAddStarted = resolve;
    });
    store.addTextFeedback = (async (...args: Parameters<typeof originalAdd>) => {
      announceAddStarted();
      await addGate;
      return originalAdd(...args);
    }) as typeof store.addTextFeedback;

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-before-discard',
        sessionId: started.sessionId,
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Paragraph.',
        feedback: 'Finish this durable write before deleting the bundle.',
        renderedRange: PARAGRAPH_RENDERED_RANGE_INPUT,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await addStarted;
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.discard',
        requestId: 'discard-after-pending-add',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(deleteFromWorkspace).not.toHaveBeenCalled();
    expect(messagesOfType(webview, 'feedback.discarded')).toHaveLength(0);

    releaseAdd();
    await waitForMessage(webview, 'feedback.updated', 'add-before-discard');
    await expect(
      waitForMessage(webview, 'feedback.discarded', 'discard-after-pending-add')
    ).resolves.toEqual(
      expect.objectContaining({
        type: 'feedback.discarded',
        requestId: 'discard-after-pending-add',
      })
    );
    expect(deleteFromWorkspace).toHaveBeenCalledTimes(1);
    expect(internals(provider).feedbackSessions.size).toBe(1);
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.ready',
        requestId: 'discard-after-pending-add',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await waitForMessage(webview, 'feedback.close.sync', 'discard-after-pending-add');
    expect(internals(provider).feedbackSessions.size).toBe(1);
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.applied',
        requestId: 'discard-after-pending-add',
        sessionId: started.sessionId,
        revision: 1,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    await waitForMessage(webview, 'feedback.close.release', 'discard-after-pending-add');
    expect(internals(provider).feedbackSessions.size).toBe(1);
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.released',
        requestId: 'discard-after-pending-add',
        sessionId: started.sessionId,
        revision: 1,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(internals(provider).feedbackSessions.size).toBe(0);
    showWarningMessage.mockReset();
  });

  it('resynchronizes an invalidated owner before unlocking its peer after discard', async () => {
    const showWarningMessage = vscode.window.showWarningMessage as jest.Mock;
    showWarningMessage.mockReset();
    showWarningMessage.mockResolvedValueOnce('Discard draft');
    (vscode.workspace as unknown as { fs: { delete: jest.Mock } }).fs = {
      delete: jest.fn(async () => undefined),
    };
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, ownerWebview);
    const documentKey = document.uri.toString();
    internals(provider).registerFeedbackWebview(
      documentKey,
      ownerWebview as unknown as vscode.Webview
    );
    const duplicateWebview = createWebview(provider, document);
    internals(provider).registerFeedbackWebview(
      documentKey,
      duplicateWebview as unknown as vscode.Webview
    );
    await waitForMessage(duplicateWebview, 'feedback.peer.locked');
    const externalContent = '# Guide changed externally\n\nDo not overwrite this.\n';
    await writeFile(sourcePath, externalContent, 'utf8');
    document.getText.mockReturnValue(externalContent);

    expect(
      internals(provider).handleFeedbackDocumentChange(
        documentKey,
        ownerWebview as unknown as vscode.Webview,
        externalContent
      )
    ).toBe(true);
    await waitForMessage(ownerWebview, 'feedback.invalidated');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.discard',
        requestId: 'discard-invalidated',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    await waitForMessage(ownerWebview, 'feedback.discarded', 'discard-invalidated');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.ready',
        requestId: 'discard-invalidated',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    const closeSync = await waitForMessage(
      ownerWebview,
      'feedback.close.sync',
      'discard-invalidated'
    );
    expect(closeSync).toEqual({
      type: 'feedback.close.sync',
      requestId: 'discard-invalidated',
      sessionId: started.sessionId,
      revision: 1,
      content: externalContent,
    });
    expect(internals(provider).feedbackSessions.size).toBe(1);
    expect(
      messagesOfType(duplicateWebview, 'feedback.peer.unlocked').some(
        candidate => candidate.lockId === started.sessionId
      )
    ).toBe(false);

    const newerExternalContent = '# Guide changed again\n\nApply the newest source.\n';
    await writeFile(sourcePath, newerExternalContent, 'utf8');
    document.getText.mockReturnValue(newerExternalContent);
    expect(
      internals(provider).handleFeedbackDocumentChange(
        documentKey,
        ownerWebview as unknown as vscode.Webview,
        newerExternalContent
      )
    ).toBe(true);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.applied',
        requestId: 'discard-invalidated',
        sessionId: started.sessionId,
        revision: 1,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    const closeSyncMessages = messagesOfType(ownerWebview, 'feedback.close.sync');
    expect(closeSyncMessages).toContainEqual({
      type: 'feedback.close.sync',
      requestId: 'discard-invalidated',
      sessionId: started.sessionId,
      revision: 2,
      content: newerExternalContent,
    });
    expect(internals(provider).feedbackSessions.size).toBe(1);
    expect(
      messagesOfType(duplicateWebview, 'feedback.peer.unlocked').some(
        candidate => candidate.lockId === started.sessionId
      )
    ).toBe(false);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.applied',
        requestId: 'discard-invalidated',
        sessionId: started.sessionId,
        revision: 2,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(
      waitForMessage(ownerWebview, 'feedback.close.release', 'discard-invalidated')
    ).resolves.toEqual(expect.objectContaining({ revision: 2, sessionId: started.sessionId }));
    expect(internals(provider).feedbackSessions.size).toBe(1);
    expect(
      messagesOfType(duplicateWebview, 'feedback.peer.unlocked').some(
        candidate => candidate.lockId === started.sessionId
      )
    ).toBe(false);

    const finalExternalContent = '# Guide changed after release\n\nRevalidate this source too.\n';
    await writeFile(sourcePath, finalExternalContent, 'utf8');
    document.getText.mockReturnValue(finalExternalContent);
    expect(
      internals(provider).handleFeedbackDocumentChange(
        documentKey,
        ownerWebview as unknown as vscode.Webview,
        finalExternalContent
      )
    ).toBe(true);
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.released',
        requestId: 'discard-invalidated',
        sessionId: started.sessionId,
        revision: 2,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    await expect(
      waitForNthMessage(ownerWebview, 'feedback.close.sync', 3, 'discard-invalidated')
    ).resolves.toEqual({
      type: 'feedback.close.sync',
      requestId: 'discard-invalidated',
      sessionId: started.sessionId,
      revision: 3,
      content: finalExternalContent,
    });
    expect(internals(provider).feedbackSessions.size).toBe(1);
    expect(
      messagesOfType(duplicateWebview, 'feedback.peer.unlocked').some(
        candidate => candidate.lockId === started.sessionId
      )
    ).toBe(false);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.applied',
        requestId: 'discard-invalidated',
        sessionId: started.sessionId,
        revision: 3,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    await expect(
      waitForNthMessage(ownerWebview, 'feedback.close.release', 2, 'discard-invalidated')
    ).resolves.toEqual(expect.objectContaining({ revision: 3, sessionId: started.sessionId }));
    expect(internals(provider).feedbackSessions.size).toBe(1);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.released',
        requestId: 'discard-invalidated',
        sessionId: started.sessionId,
        revision: 2,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    await expect(
      waitForMessage(ownerWebview, 'feedback.error', 'discard-invalidated')
    ).resolves.toEqual(expect.objectContaining({ code: 'MD4H-FB-STORE-001' }));
    expect(internals(provider).feedbackSessions.size).toBe(1);
    expect(
      messagesOfType(duplicateWebview, 'feedback.peer.unlocked').some(
        candidate => candidate.lockId === started.sessionId
      )
    ).toBe(false);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.released',
        requestId: 'discard-invalidated',
        sessionId: started.sessionId,
        revision: 3,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    const ownerReleaseIndex = ownerWebview.postMessage.mock.calls.findIndex(
      call => call[0].type === 'feedback.close.release' && call[0].revision === 3
    );
    const peerUnlockIndex = duplicateWebview.postMessage.mock.calls.findIndex(
      call => call[0].type === 'feedback.peer.unlocked' && call[0].lockId === started.sessionId
    );
    expect(ownerReleaseIndex).toBeGreaterThanOrEqual(0);
    expect(peerUnlockIndex).toBeGreaterThanOrEqual(0);
    expect(ownerWebview.postMessage.mock.invocationCallOrder[ownerReleaseIndex]).toBeLessThan(
      duplicateWebview.postMessage.mock.invocationCallOrder[peerUnlockIndex]
    );
    expect(internals(provider).feedbackSessions.size).toBe(0);
    expect(messagesOfType(ownerWebview, 'feedback.peer.unlocked')).toContainEqual(
      expect.objectContaining({ lockId: started.sessionId })
    );
  });

  it('announces a matching draft without freezing and strictly resumes its items and ID sequence', async () => {
    const firstProvider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const firstWebview = createWebview(firstProvider, document);
    const firstStarted = await startAndAddTextFeedback(firstProvider, document, firstWebview);

    const resumedProvider = createProvider(workspaceRoot);
    const resumedWebview = createWebview(resumedProvider, document);
    await internals(resumedProvider).announceMatchingFeedbackDrafts(
      document as unknown as vscode.TextDocument,
      resumedWebview as unknown as vscode.Webview
    );

    const available = await waitForMessage(resumedWebview, 'feedback.drafts.available');
    expect(available.drafts).toEqual([
      expect.objectContaining({
        round: firstStarted.round,
        itemCount: 1,
        feedbackFile: firstStarted.feedbackFile,
      }),
    ]);
    expect(JSON.stringify(available)).not.toContain('Make this explanation more concrete.');
    expect(internals(resumedProvider).feedbackSessions.size).toBe(0);

    internals(resumedProvider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-draft',
        round: firstStarted.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      resumedWebview as unknown as vscode.Webview
    );
    const resumed = await waitForMessage(resumedWebview, 'feedback.started', 'resume-draft');
    expect(resumed).toEqual(
      expect.objectContaining({
        sessionId: expect.any(String),
        round: firstStarted.round,
        items: [
          expect.objectContaining({
            id: 'F1',
            startOrdinal: 1,
            endOrdinal: 1,
            focus: 'Paragraph.',
            renderedRange: expect.objectContaining(PARAGRAPH_RENDERED_RANGE_INPUT),
          }),
        ],
      })
    );
    expect(resumed.sessionId).not.toBe(firstStarted.sessionId);
    expect(resumed.sessionId).not.toBe(resumed.round);

    internals(resumedProvider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-after-resume',
        sessionId: resumed.sessionId,
        startOrdinal: 0,
        endOrdinal: 0,
        focus: 'Guide',
        feedback: 'Use a more specific title.',
        renderedRange: {
          version: 1,
          startOrdinal: 0,
          startOffset: 0,
          endOrdinal: 0,
          endOffset: 'Guide'.length,
        },
      },
      document as unknown as vscode.TextDocument,
      resumedWebview as unknown as vscode.Webview
    );
    const updated = await waitForMessage(resumedWebview, 'feedback.updated', 'add-after-resume');
    expect((updated.items as Array<{ id: string }>).map(item => item.id)).toEqual(['F1', 'F2']);
  });

  it('resumes a legacy draft without exact metadata as an honest block-level fallback', async () => {
    const legacy = await FeedbackSessionStore.create({
      workspaceRoot,
      sourcePath,
      sourceBytes: SOURCE_BYTES,
      now: new Date('2026-08-21T09:30:00.000Z'),
      roundSuffix: 'lg01',
    });
    await legacy.addTextFeedback({
      startLine: 3,
      endLine: 3,
      focus: 'Paragraph.',
      feedback: 'Legacy block-level note.',
    });

    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-legacy-range',
        round: legacy.snapshot.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const resumed = await waitForMessage(webview, 'feedback.started', 'resume-legacy-range');
    const item = (resumed.items as Array<Record<string, unknown>>)[0];
    expect(item).toEqual(expect.objectContaining({ id: 'F1', startOrdinal: 1, endOrdinal: 1 }));
    expect(item).not.toHaveProperty('renderedRange');
  });

  it.each([
    [
      'an out-of-bounds persisted offset',
      (line: string) => line.replace('"endOffset":10', '"endOffset":11'),
    ],
    [
      'a persisted canonical-block hash mismatch',
      (line: string) =>
        line.replace(/"startBlockSha256":"[a-f0-9]{64}"/, `"startBlockSha256":"${'b'.repeat(64)}"`),
    ],
  ])(
    'resumes with a block fallback and safe diagnostic for %s without searching Focus text',
    async (_label, tamper) => {
      const paragraphHash = createHash('sha256').update('Paragraph.').digest('hex');
      const draft = await FeedbackSessionStore.create({
        workspaceRoot,
        sourcePath,
        sourceBytes: SOURCE_BYTES,
        now: new Date('2026-08-21T09:30:00.000Z'),
        roundSuffix: 'tm01',
      });
      await draft.addTextFeedback({
        startLine: 3,
        endLine: 3,
        focus: 'Paragraph.',
        feedback: 'Do not fuzzy match this.',
        renderedRange: {
          ...PARAGRAPH_RENDERED_RANGE_INPUT,
          version: 1,
          startBlockSha256: paragraphHash,
          endBlockSha256: paragraphHash,
        },
      });
      const report = await readFile(draft.feedbackFilePath, 'utf8');
      const metadataLine = report
        .split('\n')
        .find(line => line.startsWith('<!-- md4h-rendered-range:'))!;
      await writeFile(draft.feedbackFilePath, report.replace(metadataLine, tamper(metadataLine)));

      const provider = createProvider(workspaceRoot);
      const document = createDocument(sourcePath, SOURCE_TEXT);
      const webview = createWebview(provider, document);
      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.draft.resume',
          requestId: 'resume-tampered-rendered-range',
          round: draft.snapshot.round,
          blocks: START_BLOCKS,
        },
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );

      const resumed = await waitForMessage(
        webview,
        'feedback.started',
        'resume-tampered-rendered-range'
      );
      const item = (resumed.items as Array<Record<string, unknown>>)[0];
      expect(item).toEqual(expect.objectContaining({ id: 'F1', startOrdinal: 1, endOrdinal: 1 }));
      expect(item).not.toHaveProperty('renderedRange');

      const error = await waitForMessage(webview, 'feedback.error');
      expect(error).toEqual(
        expect.objectContaining({
          code: 'MD4H-FB-ANCHOR-001',
          recoverable: true,
        })
      );
      expect(error.message).toContain('F1');
      expect(internals(provider).feedbackSessions.size).toBe(1);
    }
  );

  it('refuses to resume a report whose line range is not an exact frozen block range', async () => {
    const firstProvider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const firstWebview = createWebview(firstProvider, document);
    const started = await startAndAddTextFeedback(firstProvider, document, firstWebview);
    const feedbackFile = path.join(workspaceRoot, started.feedbackFile as string);
    const report = await readFile(feedbackFile, 'utf8');
    await writeFile(feedbackFile, report.replace('docs/guide.md:3`', 'docs/guide.md:3-999`'));

    const recoveryProvider = createProvider(workspaceRoot);
    const recoveryWebview = createWebview(recoveryProvider, document);
    internals(recoveryProvider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-bad-range',
        round: started.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      recoveryWebview as unknown as vscode.Webview
    );

    const error = await waitForMessage(recoveryWebview, 'feedback.error', 'resume-bad-range');
    expect(error.code).toBe('MD4H-FB-ANCHOR-001');
    expect(internals(recoveryProvider).feedbackSessions.size).toBe(0);
  });

  it('moves an inactive matching draft to Trash only after confirmation', async () => {
    const firstProvider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const firstWebview = createWebview(firstProvider, document);
    const started = await startAndAddTextFeedback(firstProvider, document, firstWebview);
    const bundleDirectory = path.dirname(path.join(workspaceRoot, started.feedbackFile as string));
    const deleteFromWorkspace = jest.fn(
      async (uri: vscode.Uri, options: { recursive: boolean; useTrash: boolean }) => {
        expect(options).toEqual({ recursive: true, useTrash: true });
        await rm(uri.fsPath, { recursive: true, force: true });
      }
    );
    (vscode.workspace as unknown as { fs: { delete: typeof deleteFromWorkspace } }).fs = {
      delete: deleteFromWorkspace,
    };
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Discard draft');

    const recoveryProvider = createProvider(workspaceRoot);
    const recoveryWebview = createWebview(recoveryProvider, document);
    internals(recoveryProvider).handleWebviewMessage(
      {
        type: 'feedback.draft.discard',
        requestId: 'discard-recovered-draft',
        round: started.round,
      },
      document as unknown as vscode.TextDocument,
      recoveryWebview as unknown as vscode.Webview
    );

    const discarded = await waitForMessage(
      recoveryWebview,
      'feedback.draft.discarded',
      'discard-recovered-draft'
    );
    expect(discarded.round).toBe(started.round);
    expect(deleteFromWorkspace).toHaveBeenCalledTimes(1);
    await expect(pathExists(bundleDirectory)).resolves.toBe(false);
  });

  it.each([
    {
      outcome: 'cancel',
      draftSource: '# Guide\n\nPending owner edit.\n',
      roundSuffix: 'pd01',
      expectsError: false,
    },
    {
      outcome: 'error',
      draftSource: SOURCE_TEXT,
      roundSuffix: 'pd02',
      expectsError: true,
    },
  ] as const)(
    'flushes an owner debounce before inactive-draft discard locks and recovers before $outcome unlock',
    async ({ outcome, draftSource, roundSuffix, expectsError }) => {
      const pendingOwnerContent = '# Guide\n\nPending owner edit.\n';
      const draft = await FeedbackSessionStore.create({
        workspaceRoot,
        sourcePath,
        sourceBytes: Buffer.from(draftSource, 'utf8'),
        now: new Date('2026-08-21T09:30:00.000Z'),
        roundSuffix,
      });
      let documentContent = SOURCE_TEXT;
      const document = createDocument(sourcePath, SOURCE_TEXT, {
        dirty: true,
        save: async () => {
          await writeFile(sourcePath, documentContent, 'utf8');
          return true;
        },
      });
      document.getText.mockImplementation(() => documentContent);
      const provider = createProvider(workspaceRoot);
      const ownerWebview = createWebview(provider, document, false);
      const peerWebview = createWebview(provider, document);
      const documentKey = document.uri.toString();
      internals(provider).registerFeedbackWebview(
        documentKey,
        ownerWebview as unknown as vscode.Webview
      );
      internals(provider).registerFeedbackWebview(
        documentKey,
        peerWebview as unknown as vscode.Webview
      );
      const applyEdit = jest.fn(async () => {
        documentContent = pendingOwnerContent;
        return true;
      });
      internals(provider).applyEdit = applyEdit;
      ownerWebview.postMessage.mockImplementation((message: FeedbackMessage) => {
        if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
          queueMicrotask(() => {
            internals(provider).handleWebviewMessage(
              { type: 'edit', content: pendingOwnerContent, editReason: 'typing' },
              document as unknown as vscode.TextDocument,
              ownerWebview as unknown as vscode.Webview
            );
            internals(provider).handleWebviewMessage(
              { type: 'flushPendingEditAck', requestId: message.requestId, ok: true },
              document as unknown as vscode.TextDocument,
              ownerWebview as unknown as vscode.Webview
            );
          });
        }
        return Promise.resolve(true);
      });
      const showWarningMessage = vscode.window.showWarningMessage as jest.Mock;
      showWarningMessage.mockReset();
      showWarningMessage.mockResolvedValueOnce(undefined);
      const deleteFromWorkspace = jest.fn(async () => undefined);
      (vscode.workspace as unknown as { fs: { delete: typeof deleteFromWorkspace } }).fs = {
        delete: deleteFromWorkspace,
      };
      const requestId = `discard-pending-owner-${outcome}`;

      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.draft.discard',
          requestId,
          round: draft.snapshot.round,
        },
        document as unknown as vscode.TextDocument,
        ownerWebview as unknown as vscode.Webview
      );

      await waitForMessage(ownerWebview, 'flushPendingEdit');
      const ownerLock = await waitForMessage(ownerWebview, 'feedback.transition.locked', requestId);
      await waitForMessage(peerWebview, 'feedback.peer.locked');
      if (expectsError) {
        await expect(waitForMessage(ownerWebview, 'feedback.error', requestId)).resolves.toEqual(
          expect.objectContaining({ recoverable: true })
        );
        expect(showWarningMessage).not.toHaveBeenCalled();
      } else {
        await waitUntil(() => showWarningMessage.mock.calls.length === 1);
      }

      const flushIndex = ownerWebview.postMessage.mock.calls.findIndex(
        call => call[0].type === 'flushPendingEdit'
      );
      const ownerLockIndex = ownerWebview.postMessage.mock.calls.findIndex(
        call => call[0].type === 'feedback.transition.locked' && call[0].requestId === requestId
      );
      expect(flushIndex).toBeGreaterThanOrEqual(0);
      expect(ownerLockIndex).toBeGreaterThan(flushIndex);
      expect(applyEdit).toHaveBeenCalledWith(
        pendingOwnerContent,
        document,
        expect.objectContaining({ sourceWebview: ownerWebview })
      );
      expect(document.save).toHaveBeenCalledTimes(1);
      expect(document.save.mock.invocationCallOrder[0]).toBeLessThan(
        ownerWebview.postMessage.mock.invocationCallOrder[ownerLockIndex]
      );
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe(pendingOwnerContent);
      expect(deleteFromWorkspace).not.toHaveBeenCalled();
      await expect(pathExists(draft.bundleDirectory)).resolves.toBe(true);
      expect(messagesOfType(ownerWebview, 'feedback.peer.unlocked')).toHaveLength(0);
      expect(messagesOfType(peerWebview, 'feedback.peer.unlocked')).toHaveLength(0);

      await expectTransitionSyncThenUnlock(
        provider,
        document,
        ownerWebview,
        peerWebview,
        requestId,
        ownerLock.lockId as string,
        pendingOwnerContent
      );
    }
  );

  it.each([
    {
      outcome: 'cancel',
      choice: undefined,
      deleteFails: false,
      responseType: undefined,
      roundSuffix: 'dl01',
    },
    {
      outcome: 'success',
      choice: 'Discard draft',
      deleteFails: false,
      responseType: 'feedback.draft.discarded',
      roundSuffix: 'dl02',
    },
    {
      outcome: 'error',
      choice: 'Discard draft',
      deleteFails: true,
      responseType: 'feedback.error',
      roundSuffix: 'dl03',
    },
  ] as const)(
    'correlates and unlocks the inactive-draft discard owner on $outcome',
    async ({ outcome, choice, deleteFails, responseType, roundSuffix }) => {
      const draft = await FeedbackSessionStore.create({
        workspaceRoot,
        sourcePath,
        sourceBytes: SOURCE_BYTES,
        now: new Date('2026-08-21T09:30:00.000Z'),
        roundSuffix,
      });
      const provider = createProvider(workspaceRoot);
      const document = createDocument(sourcePath, SOURCE_TEXT);
      const ownerWebview = createWebview(provider, document);
      const peerWebview = createWebview(provider, document);
      const documentKey = document.uri.toString();
      internals(provider).registerFeedbackWebview(
        documentKey,
        ownerWebview as unknown as vscode.Webview
      );
      internals(provider).registerFeedbackWebview(
        documentKey,
        peerWebview as unknown as vscode.Webview
      );
      let resolveConfirmation!: (result: string | undefined) => void;
      const confirmation = new Promise<string | undefined>(resolve => {
        resolveConfirmation = resolve;
      });
      let announceConfirmation!: () => void;
      const confirmationShown = new Promise<void>(resolve => {
        announceConfirmation = resolve;
      });
      const showWarningMessage = vscode.window.showWarningMessage as jest.Mock;
      showWarningMessage.mockReset();
      showWarningMessage.mockImplementationOnce(async () => {
        announceConfirmation();
        return confirmation;
      });
      const deleteFromWorkspace = jest.fn(async () => {
        if (deleteFails) throw new Error('Trash is unavailable');
      });
      (vscode.workspace as unknown as { fs: { delete: typeof deleteFromWorkspace } }).fs = {
        delete: deleteFromWorkspace,
      };
      const requestId = `discard-owner-lock-${outcome}`;

      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.draft.discard',
          requestId,
          round: draft.snapshot.round,
        },
        document as unknown as vscode.TextDocument,
        ownerWebview as unknown as vscode.Webview
      );

      const ownerLock = await waitForMessage(ownerWebview, 'feedback.transition.locked', requestId);
      const peerLock = await waitForMessage(peerWebview, 'feedback.peer.locked');
      await confirmationShown;
      expect(ownerLock).toEqual({
        type: 'feedback.transition.locked',
        requestId,
        lockId: expect.any(String),
      });
      expect(peerLock).toEqual(
        expect.objectContaining({ type: 'feedback.peer.locked', lockId: ownerLock.lockId })
      );
      const ownerLockIndex = ownerWebview.postMessage.mock.calls.findIndex(
        call => call[0].type === 'feedback.transition.locked'
      );
      expect(ownerWebview.postMessage.mock.invocationCallOrder[ownerLockIndex]).toBeLessThan(
        showWarningMessage.mock.invocationCallOrder[0]
      );
      expect(internals(provider).feedbackTransitions.size).toBe(1);
      expect(messagesOfType(ownerWebview, 'feedback.peer.unlocked')).toHaveLength(0);
      expect(messagesOfType(peerWebview, 'feedback.peer.unlocked')).toHaveLength(0);

      resolveConfirmation(choice);
      if (responseType) {
        await waitForMessage(ownerWebview, responseType, requestId);
      }
      const ownerUnlock = await waitForMessage(ownerWebview, 'feedback.peer.unlocked');
      const peerUnlock = await waitForMessage(peerWebview, 'feedback.peer.unlocked');

      expect(ownerUnlock).toEqual({
        type: 'feedback.peer.unlocked',
        lockId: ownerLock.lockId,
      });
      expect(peerUnlock).toEqual(ownerUnlock);
      expect(internals(provider).feedbackTransitions.size).toBe(0);
      expect(deleteFromWorkspace).toHaveBeenCalledTimes(outcome === 'cancel' ? 0 : 1);
      expect(messagesOfType(ownerWebview, 'feedback.draft.discarded')).toHaveLength(
        outcome === 'success' ? 1 : 0
      );
      expect(messagesOfType(ownerWebview, 'feedback.error')).toHaveLength(
        outcome === 'error' ? 1 : 0
      );
    }
  );

  it.each([
    { outcome: 'cancel', choice: undefined, expectsError: false },
    { outcome: 'confirm after invalidation', choice: 'Discard draft', expectsError: true },
  ])(
    'resynchronizes an invalidated inactive-draft discard owner before peer unlock on $outcome',
    async ({ outcome, choice, expectsError }) => {
      const draft = await FeedbackSessionStore.create({
        workspaceRoot,
        sourcePath,
        sourceBytes: SOURCE_BYTES,
        now: new Date('2026-08-21T09:30:00.000Z'),
        roundSuffix: outcome === 'cancel' ? 'dc01' : 'dc02',
      });
      const provider = createProvider(workspaceRoot);
      const document = createDocument(sourcePath, SOURCE_TEXT);
      const ownerWebview = createWebview(provider, document);
      const duplicateWebview = createWebview(provider, document);
      const documentKey = document.uri.toString();
      internals(provider).registerFeedbackWebview(
        documentKey,
        ownerWebview as unknown as vscode.Webview
      );
      internals(provider).registerFeedbackWebview(
        documentKey,
        duplicateWebview as unknown as vscode.Webview
      );
      let resolveConfirmation!: (result: string | undefined) => void;
      const confirmation = new Promise<string | undefined>(resolve => {
        resolveConfirmation = resolve;
      });
      let reportConfirmation!: () => void;
      const confirmationShown = new Promise<void>(resolve => {
        reportConfirmation = resolve;
      });
      (vscode.window.showWarningMessage as jest.Mock).mockReset();
      (vscode.window.showWarningMessage as jest.Mock).mockImplementationOnce(async () => {
        reportConfirmation();
        return confirmation;
      });
      const deleteFromWorkspace = jest.fn(async () => undefined);
      (vscode.workspace as unknown as { fs: { delete: typeof deleteFromWorkspace } }).fs = {
        delete: deleteFromWorkspace,
      };
      const requestId = expectsError ? 'discard-invalidated-confirm' : 'discard-invalidated-cancel';

      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.draft.discard',
          requestId,
          round: draft.snapshot.round,
        },
        document as unknown as vscode.TextDocument,
        ownerWebview as unknown as vscode.Webview
      );
      const ownerTransitionLock = await waitForMessage(
        ownerWebview,
        'feedback.transition.locked',
        requestId
      );
      const transitionLock = await waitForMessage(duplicateWebview, 'feedback.peer.locked');
      expect(ownerTransitionLock).toEqual({
        type: 'feedback.transition.locked',
        requestId,
        lockId: transitionLock.lockId,
      });
      await confirmationShown;
      const externalContent = `# Changed during discard ${outcome}\n\nKeep this source.\n`;
      await writeFile(sourcePath, externalContent, 'utf8');
      document.getText.mockReturnValue(externalContent);
      expect(
        internals(provider).handleFeedbackDocumentChange(
          documentKey,
          ownerWebview as unknown as vscode.Webview,
          externalContent
        )
      ).toBe(true);
      resolveConfirmation(choice);

      if (expectsError) {
        await expect(waitForMessage(ownerWebview, 'feedback.error', requestId)).resolves.toEqual(
          expect.objectContaining({ code: 'MD4H-FB-SNAPSHOT-001' })
        );
      }
      expect(deleteFromWorkspace).not.toHaveBeenCalled();
      expect(internals(provider).feedbackTransitions.size).toBe(1);
      await expectTransitionSyncThenUnlock(
        provider,
        document,
        ownerWebview,
        duplicateWebview,
        requestId,
        transitionLock.lockId as string,
        externalContent
      );
    }
  );

  it('reserves the document while an inactive-draft discard awaits confirmation', async () => {
    const firstProvider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const firstWebview = createWebview(firstProvider, document);
    const started = await startAndAddTextFeedback(firstProvider, document, firstWebview);
    let resolveDiscardConfirmation!: (choice: string | undefined) => void;
    const discardConfirmation = new Promise<string | undefined>(resolve => {
      resolveDiscardConfirmation = resolve;
    });
    let announceDiscardConfirmation!: () => void;
    const discardConfirmationShown = new Promise<void>(resolve => {
      announceDiscardConfirmation = resolve;
    });
    (vscode.window.showWarningMessage as jest.Mock).mockImplementationOnce(async () => {
      announceDiscardConfirmation();
      return discardConfirmation;
    });
    const deleteFromWorkspace = jest.fn(async () => undefined);
    (vscode.workspace as unknown as { fs: { delete: typeof deleteFromWorkspace } }).fs = {
      delete: deleteFromWorkspace,
    };

    const recoveryProvider = createProvider(workspaceRoot);
    const recoveryWebview = createWebview(recoveryProvider, document);
    internals(recoveryProvider).handleWebviewMessage(
      {
        type: 'feedback.draft.discard',
        requestId: 'discard-awaiting-confirmation',
        round: started.round,
      },
      document as unknown as vscode.TextDocument,
      recoveryWebview as unknown as vscode.Webview
    );
    await discardConfirmationShown;

    internals(recoveryProvider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-during-discard',
        round: started.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      recoveryWebview as unknown as vscode.Webview
    );
    const resumeError = await waitForMessage(
      recoveryWebview,
      'feedback.error',
      'resume-during-discard'
    );
    expect(resumeError.message).toMatch(/active|starting/i);
    expect(internals(recoveryProvider).feedbackSessions.size).toBe(0);

    resolveDiscardConfirmation('Discard draft');
    await waitForMessage(
      recoveryWebview,
      'feedback.draft.discarded',
      'discard-awaiting-confirmation'
    );
    expect(deleteFromWorkspace).toHaveBeenCalledTimes(1);
    expect(internals(recoveryProvider).feedbackTransitions.size).toBe(0);
  });

  it('rejects the inactive-draft discard route while that round is active', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);
    const deleteFromWorkspace = jest.fn(async () => undefined);
    (vscode.workspace as unknown as { fs: { delete: typeof deleteFromWorkspace } }).fs = {
      delete: deleteFromWorkspace,
    };

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.draft.discard',
        requestId: 'discard-active-through-draft-route',
        round: started.round,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const error = await waitForMessage(
      webview,
      'feedback.error',
      'discard-active-through-draft-route'
    );
    expect(error.message).toMatch(/active|starting/i);
    expect(deleteFromWorkspace).not.toHaveBeenCalled();
    expect(internals(provider).feedbackSessions.size).toBe(1);
  });

  it('revalidates an inactive draft after confirmation before moving it to Trash', async () => {
    const firstProvider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const firstWebview = createWebview(firstProvider, document);
    const started = await startAndAddTextFeedback(firstProvider, document, firstWebview);
    const bundleDirectory = path.dirname(path.join(workspaceRoot, started.feedbackFile as string));
    const assetsDirectory = path.join(bundleDirectory, 'assets');
    const outsideDirectory = path.join(workspaceRoot, 'outside-assets');
    await mkdir(outsideDirectory);
    const deleteFromWorkspace = jest.fn(async () => undefined);
    (vscode.workspace as unknown as { fs: { delete: typeof deleteFromWorkspace } }).fs = {
      delete: deleteFromWorkspace,
    };
    (vscode.window.showWarningMessage as jest.Mock).mockImplementationOnce(async () => {
      await rm(assetsDirectory, { recursive: true, force: true });
      await symlink(outsideDirectory, assetsDirectory);
      return 'Discard draft';
    });

    const recoveryProvider = createProvider(workspaceRoot);
    const recoveryWebview = createWebview(recoveryProvider, document);
    internals(recoveryProvider).handleWebviewMessage(
      {
        type: 'feedback.draft.discard',
        requestId: 'discard-revalidate-after-confirm',
        round: started.round,
      },
      document as unknown as vscode.TextDocument,
      recoveryWebview as unknown as vscode.Webview
    );

    const error = await waitForMessage(
      recoveryWebview,
      'feedback.error',
      'discard-revalidate-after-confirm'
    );
    expect(error.message).toMatch(/symbolic-link|safe|storage/i);
    expect(deleteFromWorkspace).not.toHaveBeenCalled();
    await expect(pathExists(bundleDirectory)).resolves.toBe(true);
  });

  async function startAndAddTextFeedback(
    provider: MarkdownEditorProvider,
    document: ReturnType<typeof createDocument>,
    webview: ReturnType<typeof createWebview>
  ): Promise<FeedbackMessage> {
    sendStart(provider, document, webview, 'start-with-item');
    const started = await waitForMessage(webview, 'feedback.started', 'start-with-item');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-text',
        sessionId: started.sessionId,
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Paragraph.',
        feedback: 'Make this explanation more concrete.',
        renderedRange: PARAGRAPH_RENDERED_RANGE_INPUT,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const updated = await waitForMessage(webview, 'feedback.updated', 'add-text');
    expect(updated.items).toEqual([
      expect.objectContaining({
        id: 'F1',
        kind: 'text',
        startOrdinal: 1,
        endOrdinal: 1,
        startLine: 3,
        endLine: 3,
        focus: 'Paragraph.',
      }),
    ]);
    return started;
  }
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

function createDocument(sourcePath: string, content: string, options: MockDocumentOptions = {}) {
  let dirty = options.dirty ?? false;
  const uri = fileUri(sourcePath);
  const saveImplementation = options.save ?? (async () => true);
  const save = jest.fn(async () => {
    const saved = await saveImplementation();
    if (saved) dirty = false;
    return saved;
  });

  return {
    uri,
    fileName: sourcePath,
    languageId: 'markdown',
    version: 1,
    get isDirty() {
      return dirty;
    },
    getText: jest.fn(() => content),
    lineCount: content.split('\n').length,
    save,
  };
}

function createWebview(
  provider: MarkdownEditorProvider,
  document: ReturnType<typeof createDocument>,
  acknowledgeFlush = true
) {
  const webview = {
    asWebviewUri: jest.fn((uri: vscode.Uri) => ({
      toString: () =>
        `vscode-webview://feedback/${path.basename(uri.fsPath)}?asset=${encodeURIComponent(
          path.basename(uri.fsPath)
        )}`,
    })),
    postMessage: jest.fn((message: FeedbackMessage) => {
      if (
        acknowledgeFlush &&
        message.type === 'flushPendingEdit' &&
        typeof message.requestId === 'string'
      ) {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            { type: 'flushPendingEditAck', requestId: message.requestId, ok: true },
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      return Promise.resolve(true);
    }),
  };
  return webview;
}

function sendStart(
  provider: MarkdownEditorProvider,
  document: ReturnType<typeof createDocument>,
  webview: ReturnType<typeof createWebview>,
  requestId: string
): void {
  internals(provider).handleWebviewMessage(
    { type: 'feedback.start', requestId, blocks: START_BLOCKS },
    document as unknown as vscode.TextDocument,
    webview as unknown as vscode.Webview
  );
}

function internals(provider: MarkdownEditorProvider): ProviderInternals {
  return provider as unknown as ProviderInternals;
}

function fileUri(fsPath: string): vscode.Uri {
  return {
    fsPath,
    path: fsPath,
    scheme: 'file',
    toString: () => `file://${fsPath}`,
  } as vscode.Uri;
}

async function waitForMessage(
  webview: ReturnType<typeof createWebview>,
  type: string,
  requestId?: string
): Promise<FeedbackMessage> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const message = messagesOfType(webview, type).find(
      candidate => requestId === undefined || candidate.requestId === requestId
    );
    if (message) return message;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }

  throw new Error(
    `Timed out waiting for ${type}${requestId ? ` (${requestId})` : ''}. Received: ${JSON.stringify(
      webview.postMessage.mock.calls.map(call => call[0])
    )}`
  );
}

async function waitForNthMessage(
  webview: ReturnType<typeof createWebview>,
  type: string,
  ordinal: number,
  requestId?: string
): Promise<FeedbackMessage> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const matches = messagesOfType(webview, type).filter(
      candidate => requestId === undefined || candidate.requestId === requestId
    );
    const message = matches[ordinal - 1];
    if (message) return message;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }

  throw new Error(
    `Timed out waiting for ${type} message ${ordinal}${
      requestId ? ` (${requestId})` : ''
    }. Received: ${JSON.stringify(webview.postMessage.mock.calls.map(call => call[0]))}`
  );
}

async function waitForOneOfMessages(
  webview: ReturnType<typeof createWebview>,
  types: readonly string[],
  requestId: string
): Promise<FeedbackMessage> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    for (const type of types) {
      const message = messagesOfType(webview, type).find(
        candidate => candidate.requestId === requestId
      );
      if (message) return message;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${types.join(' or ')} (${requestId}).`);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the expected provider lifecycle state.');
}

function messagesOfType(
  webview: ReturnType<typeof createWebview>,
  type: string
): FeedbackMessage[] {
  return webview.postMessage.mock.calls
    .map(call => call[0] as FeedbackMessage)
    .filter(message => message.type === type);
}

async function expectTransitionSyncThenUnlock(
  provider: MarkdownEditorProvider,
  document: ReturnType<typeof createDocument>,
  ownerWebview: ReturnType<typeof createWebview>,
  peerWebview: ReturnType<typeof createWebview>,
  requestId: string,
  lockId: string,
  content: string
): Promise<void> {
  const sync = await waitForMessage(ownerWebview, 'feedback.transition.sync', requestId);
  expect(sync).toEqual({
    type: 'feedback.transition.sync',
    requestId,
    lockId,
    revision: 1,
    content,
  });
  expect(internals(provider).feedbackTransitions.size).toBe(1);
  expect(
    messagesOfType(peerWebview, 'feedback.peer.unlocked').some(
      candidate => candidate.lockId === lockId
    )
  ).toBe(false);

  const syncIndex = ownerWebview.postMessage.mock.calls.findIndex(
    call =>
      call[0].type === 'feedback.transition.sync' &&
      call[0].requestId === requestId &&
      call[0].lockId === lockId &&
      call[0].revision === 1
  );
  const errorIndex = ownerWebview.postMessage.mock.calls.findIndex(
    call => call[0].type === 'feedback.error' && call[0].requestId === requestId
  );
  if (errorIndex >= 0) {
    expect(ownerWebview.postMessage.mock.invocationCallOrder[syncIndex]).toBeLessThan(
      ownerWebview.postMessage.mock.invocationCallOrder[errorIndex]
    );
  }

  internals(provider).handleWebviewMessage(
    {
      type: 'feedback.transition.retry',
      requestId,
      lockId,
      revision: 1,
    },
    document as unknown as vscode.TextDocument,
    ownerWebview as unknown as vscode.Webview
  );
  await expect(
    waitForNthMessage(ownerWebview, 'feedback.transition.sync', 2, requestId)
  ).resolves.toEqual(sync);
  expect(internals(provider).feedbackTransitions.size).toBe(1);
  expect(
    messagesOfType(peerWebview, 'feedback.peer.unlocked').some(
      candidate => candidate.lockId === lockId
    )
  ).toBe(false);

  internals(provider).handleWebviewMessage(
    {
      type: 'feedback.transition.applied',
      requestId,
      lockId,
      revision: 1,
    },
    document as unknown as vscode.TextDocument,
    ownerWebview as unknown as vscode.Webview
  );
  await new Promise<void>(resolve => setImmediate(resolve));

  expect(internals(provider).feedbackTransitions.size).toBe(0);
  const peerUnlockIndex = peerWebview.postMessage.mock.calls.findIndex(
    call => call[0].type === 'feedback.peer.unlocked' && call[0].lockId === lockId
  );
  expect(peerUnlockIndex).toBeGreaterThanOrEqual(0);
  expect(ownerWebview.postMessage.mock.invocationCallOrder[syncIndex]).toBeLessThan(
    peerWebview.postMessage.mock.invocationCallOrder[peerUnlockIndex]
  );
}

function expectPeerUpdateBeforeUnlock(
  peerWebview: ReturnType<typeof createWebview>,
  lockId: string,
  content: string
): void {
  const updateIndex = peerWebview.postMessage.mock.calls.findIndex(
    call => call[0].type === 'update' && call[0].content === content
  );
  const unlockIndex = peerWebview.postMessage.mock.calls.findIndex(
    call => call[0].type === 'feedback.peer.unlocked' && call[0].lockId === lockId
  );

  expect(updateIndex).toBeGreaterThanOrEqual(0);
  expect(unlockIndex).toBeGreaterThanOrEqual(0);
  expect(updateIndex).toBeLessThan(unlockIndex);
}

async function writeFileEnsuringDirectory(filePath: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}
