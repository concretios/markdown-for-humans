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
import { FEEDBACK_DELIVERY_PROTOCOL_VERSION } from '../../shared/feedbackDeliveryProtocol';
import { DOCUMENT_SYNC_PROTOCOL_VERSION } from '../../shared/documentSyncProtocol';
import { FEEDBACK_SNAPSHOT_PROTOCOL_VERSION } from '../../shared/feedbackSnapshotProtocol';
import { FeedbackSessionStore } from '../../editor/feedbackSessionStore';
import type {
  FeedbackBlockKindV2,
  FeedbackBlockSpanV2,
  FeedbackEvidenceEnvelopeV2,
  FeedbackTargetV2,
} from '../../shared/feedbackEvidenceV2';

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
  flushFeedbackWebview: (
    document: vscode.TextDocument,
    webview: vscode.Webview
  ) => Promise<boolean>;
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
  postCurrentFeedbackPeerLock: (documentKey: string, webview: vscode.Webview) => void;
  queryFeedbackStartedStatus: (
    webview: vscode.Webview,
    identity: {
      messageId: string;
      operationEpoch: string;
      sessionEpoch: string;
      stageRevision: number;
    },
    signal: AbortSignal
  ) => Promise<unknown>;
  postFeedbackCriticalStage: (
    webview: vscode.Webview,
    message: FeedbackMessage,
    sessionEpoch: string,
    stageRevision: number,
    previous?: AbortController
  ) => AbortController | undefined;
  acknowledgeFeedbackCriticalStage: (
    webview: vscode.Webview,
    messageType: string,
    requestId: string,
    sessionEpoch: string,
    stageRevision: number,
    applied: boolean
  ) => 'accepted' | 'duplicate' | 'ignored';
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
      sessionId: string;
      invalidated: boolean;
      ownerWebview: vscode.Webview;
      phase: 'active' | 'resuming' | 'finishing' | 'discarding';
      closeOperation?: Promise<void>;
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
  flushAckResolvers: Map<
    string,
    {
      webview: vscode.Webview;
      viewGeneration: string;
      documentVersion: number;
      settled: Promise<void>;
      resolve: (ok: boolean) => void;
    }
  >;
  setEditViewGeneration: (webview: vscode.Webview, generation: string) => void;
  pendingFeedbackStatusQueries: Map<vscode.Webview, Map<string, unknown>>;
  feedbackDeliveryCapableWebviews: Set<vscode.Webview>;
  feedbackSnapshotCapableWebviews: Set<vscode.Webview>;
  feedbackCriticalTransports: Map<vscode.Webview, { dispose(): void }>;
  pendingFeedbackSessionTransfers: Map<string, unknown>;
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
const TABLE_SOURCE_TEXT = '| A | B |\n| --- | --- |\n| 1 | 2 |\n';
const TABLE_BLOCKS = [
  {
    ordinal: 0,
    kind: 'table',
    markdown: TABLE_SOURCE_TEXT.trimEnd(),
    contentSize: 12,
    tableFingerprint: 'md4h-table/v1:0123456789abcdef',
  },
];
const TABLE_CELL_TARGET_INPUT = {
  version: 1,
  tableOrdinal: 0,
  rectangle: { top: 0, left: 0, bottom: 2, right: 2 },
  tableFingerprint: 'md4h-table/v1:0123456789abcdef',
};

function v2TableCellSelection(
  cellTarget: typeof TABLE_CELL_TARGET_INPUT,
  label = 'Cell'
): Record<string, unknown> {
  const { top, left, bottom, right } = cellTarget.rectangle;
  return {
    target: {
      version: 2,
      requestedScope: 'table-cells',
      locator: { kind: 'table-cells', value: cellTarget },
    },
    evidence: {
      kind: 'table-cells',
      complete: true,
      rows: Array.from({ length: bottom - top }, (_, row) =>
        Array.from({ length: right - left }, (_, column) => ({
          role: row === 0 ? 'header' : 'data',
          text: `${label} ${top + row + 1}:${left + column + 1}`,
          complete: true,
        }))
      ),
    },
  };
}
const CODE_SOURCE_TEXT = '```typescript\nconst role = "admin";\n```\n';
const CODE_BLOCKS = [
  {
    ordinal: 0,
    kind: 'code',
    markdown: CODE_SOURCE_TEXT.trimEnd(),
    contentSize: 'const role = "admin";'.length,
  },
];
const MERMAID_SOURCE_TEXT = '# Diagram\n\n```mermaid\nflowchart LR\n  Draft --> Review\n```\n';
const MERMAID_BLOCKS = [
  { ordinal: 0, kind: 'heading', markdown: '# Diagram', contentSize: 'Diagram'.length },
  {
    ordinal: 1,
    kind: 'mermaid',
    markdown: '```mermaid\nflowchart LR\n  Draft --> Review\n```',
    contentSize: 'flowchart LR\n  Draft --> Review'.length,
  },
];
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
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: jest.fn(),
    }));
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
    { label: 'legacy', acknowledgement: { ok: false } },
    {
      label: 'wrong-protocol',
      acknowledgement: {
        protocolVersion: 1,
        viewGeneration: 'flush-test-view',
        documentVersion: 1,
        ok: true,
      },
    },
    {
      label: 'string-valued',
      acknowledgement: {
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'flush-test-view',
        documentVersion: 1,
        ok: 'true',
      },
    },
  ])('ignores a malformed $label pending-edit flush acknowledgement', ({ acknowledgement }) => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);
    const resolve = jest.fn();
    internals(provider).flushAckResolvers.set('flush-malformed', {
      webview: webview as unknown as vscode.Webview,
      viewGeneration: 'flush-test-view',
      documentVersion: 1,
      settled: Promise.resolve(),
      resolve,
    });

    internals(provider).handleWebviewMessage(
      {
        type: 'flushPendingEditAck',
        requestId: 'flush-malformed',
        ...acknowledgement,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(internals(provider).flushAckResolvers.has('flush-malformed')).toBe(true);
    internals(provider).flushAckResolvers.delete('flush-malformed');
  });

  it.each([true, false])(
    'accepts an exact generation-bound pending-edit flush acknowledgement (%s)',
    ok => {
      const provider = createProvider(workspaceRoot);
      const document = createDocument(sourcePath, SOURCE_TEXT);
      const webview = createWebview(provider, document, false);
      const resolve = jest.fn();
      internals(provider).handleWebviewMessage(
        {
          type: 'ready',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          viewGeneration: 'flush-test-view',
        },
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      internals(provider).flushAckResolvers.set('flush-valid', {
        webview: webview as unknown as vscode.Webview,
        viewGeneration: 'flush-test-view',
        documentVersion: 1,
        settled: Promise.resolve(),
        resolve,
      });

      internals(provider).handleWebviewMessage(
        {
          type: 'flushPendingEditAck',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          requestId: 'flush-valid',
          viewGeneration: 'flush-test-view',
          documentVersion: 1,
          ok,
        },
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );

      expect(resolve).toHaveBeenCalledWith(ok);
      expect(internals(provider).flushAckResolvers.has('flush-valid')).toBe(false);
    }
  );

  it('ignores an exact acknowledgement after that renderer generation retires', () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);
    const resolve = jest.fn();
    internals(provider).handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'flush-retired-view',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    internals(provider).flushAckResolvers.set('flush-retired', {
      webview: webview as unknown as vscode.Webview,
      viewGeneration: 'flush-retired-view',
      documentVersion: 1,
      settled: Promise.resolve(),
      resolve,
    });
    internals(provider).setEditViewGeneration(
      webview as unknown as vscode.Webview,
      'flush-current-view'
    );

    internals(provider).handleWebviewMessage(
      {
        type: 'flushPendingEditAck',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        requestId: 'flush-retired',
        viewGeneration: 'flush-retired-view',
        documentVersion: 1,
        ok: true,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(internals(provider).flushAckResolvers.has('flush-retired')).toBe(true);
    internals(provider).flushAckResolvers.delete('flush-retired');
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

  it('bounds Feedback flush when webview delivery never settles', async () => {
    jest.useFakeTimers();
    try {
      const provider = createProvider(workspaceRoot);
      const document = createDocument(sourcePath, SOURCE_TEXT);
      const webview = createWebview(provider, document, false);
      webview.postMessage.mockImplementation(() => new Promise<boolean>(() => undefined));
      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';

      void internals(provider)
        .flushFeedbackWebview(
          document as unknown as vscode.TextDocument,
          webview as unknown as vscode.Webview
        )
        .then(
          () => {
            outcome = 'resolved';
          },
          () => {
            outcome = 'rejected';
          }
        );
      await jest.advanceTimersByTimeAsync(2_000);
      await Promise.resolve();

      expect(outcome).toBe('rejected');
    } finally {
      jest.useRealTimers();
    }
  });

  it('accepts a successful flush acknowledgement delayed by a busy rich view', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);
    webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        setTimeout(() => {
          internals(provider).handleWebviewMessage(
            createFlushAcknowledgement(message, true),
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

  it('uses an application-acknowledged feedback.started delivery for capable renderers', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);

    internals(provider).handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: 2,
        feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        viewGeneration: 'feedback-delivery-view-1',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    webview.postMessage.mockClear();
    const automaticPostMessage = webview.postMessage.getMockImplementation();
    webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      const automaticResult = automaticPostMessage?.(message) ?? Promise.resolve(true);
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            createFlushAcknowledgement(message, true),
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      if (message.type === 'feedback.delivery') {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            {
              type: 'feedback.delivery.ack',
              protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
              messageId: message.messageId,
              operationEpoch: message.operationEpoch,
              sessionEpoch: message.sessionEpoch,
              stageRevision: message.stageRevision,
              outcome: { kind: 'applied', value: { messageType: 'feedback.started' } },
            },
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      return automaticResult;
    });

    sendStart(provider, document, webview, 'start-acknowledged-delivery');
    const delivered = await waitForMessage(webview, 'feedback.delivery');
    await waitUntil(() => internals(provider).feedbackSessions.size === 1);

    expect(delivered).toEqual(
      expect.objectContaining({
        protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        operationEpoch: 'start-acknowledged-delivery',
        stageRevision: 1,
        payload: expect.objectContaining({
          type: 'feedback.started',
          requestId: 'start-acknowledged-delivery',
        }),
      })
    );
    expect(messagesOfType(webview, 'feedback.started')).toHaveLength(0);
    expect(messagesOfType(webview, 'feedback.error')).toHaveLength(0);
  });

  it('keeps the session active when authoritative status confirms a lost start ACK', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);

    internals(provider).handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: 2,
        feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        viewGeneration: 'feedback-delivery-view-status-applied',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    webview.postMessage.mockClear();
    let deliveryAttempts = 0;
    webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            createFlushAcknowledgement(message, true),
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      if (message.type === 'feedback.delivery') {
        deliveryAttempts += 1;
        return Promise.resolve(true);
      }
      if (message.type === 'feedback.delivery.status.query') {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            {
              ...message,
              type: 'feedback.delivery.status.response',
              status: { kind: 'applied', value: { messageType: 'feedback.started' } },
            },
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      return Promise.resolve(true);
    });

    sendStart(provider, document, webview, 'start-status-applied');
    const query = await waitForMessage(webview, 'feedback.delivery.status.query');
    await new Promise<void>(resolve => setTimeout(resolve, 20));

    expect(query).toEqual(
      expect.objectContaining({
        operationEpoch: 'start-status-applied',
        stageRevision: 1,
      })
    );
    expect(deliveryAttempts).toBe(3);
    expect(internals(provider).feedbackSessions.size).toBe(1);
    expect(messagesOfType(webview, 'feedback.error')).toHaveLength(0);
  });

  it('restores editing when authoritative status reports an inactive renderer', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);

    internals(provider).handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: 2,
        feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        viewGeneration: 'feedback-delivery-view-status-inactive',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    webview.postMessage.mockClear();
    const automaticPostMessage = webview.postMessage.getMockImplementation();
    webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      const automaticResult = automaticPostMessage?.(message) ?? Promise.resolve(true);
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            createFlushAcknowledgement(message, true),
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      if (message.type === 'feedback.delivery') return Promise.resolve(true);
      if (message.type === 'feedback.delivery.status.query') {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            {
              ...message,
              type: 'feedback.delivery.status.response',
              status: { kind: 'inactive' },
            },
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      return automaticResult;
    });

    sendStart(provider, document, webview, 'start-status-inactive');
    const error = await waitForMessage(webview, 'feedback.error', 'start-status-inactive');
    await waitUntil(() => internals(provider).feedbackSessions.size === 0);

    expect(error.message).toMatch(/did not confirm|draft was saved/i);
    expect(messagesOfType(webview, 'feedback.delivery')).toHaveLength(3);
    expect(messagesOfType(webview, 'feedback.delivery.status.query')).toHaveLength(1);
    expect(messagesOfType(webview, 'feedback.peer.release').map(message => message.phase)).toEqual([
      'apply',
      'commit',
    ]);
  });

  it.each(['ready', 'unregister', 'dispose'] as const)(
    'cancels pending renderer status waiters on %s',
    async cleanup => {
      const provider = createProvider(workspaceRoot);
      const document = createDocument(sourcePath, SOURCE_TEXT);
      const webview = createWebview(provider, document, false);
      internals(provider).registerFeedbackWebview(
        document.uri.toString(),
        webview as unknown as vscode.Webview
      );
      const pending = internals(provider).queryFeedbackStartedStatus(
        webview as unknown as vscode.Webview,
        {
          messageId: `status-cleanup-${cleanup}`,
          operationEpoch: `operation-cleanup-${cleanup}`,
          sessionEpoch: `session-cleanup-${cleanup}`,
          stageRevision: 1,
        },
        new AbortController().signal
      );
      await waitForMessage(webview, 'feedback.delivery.status.query');

      if (cleanup === 'ready') {
        internals(provider).handleWebviewMessage(
          {
            type: 'ready',
            protocolVersion: 2,
            feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
            viewGeneration: 'feedback-status-cleanup-ready',
          },
          document as unknown as vscode.TextDocument,
          webview as unknown as vscode.Webview
        );
      } else if (cleanup === 'unregister') {
        internals(provider).unregisterFeedbackWebview(
          document.uri.toString(),
          webview as unknown as vscode.Webview
        );
      } else {
        provider.dispose();
      }

      await expect(pending).rejects.toThrow(/cancelled|disposed|reloaded/i);
      expect(
        internals(provider).pendingFeedbackStatusQueries.has(webview as unknown as vscode.Webview)
      ).toBe(false);
    }
  );

  it('ignores a renderer status response from a different operation identity', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);
    const identity = {
      messageId: 'status-correlated-message',
      operationEpoch: 'status-correlated-operation',
      sessionEpoch: 'status-correlated-session',
      stageRevision: 1,
    };
    const pending = internals(provider).queryFeedbackStartedStatus(
      webview as unknown as vscode.Webview,
      identity,
      new AbortController().signal
    );
    await waitForMessage(webview, 'feedback.delivery.status.query');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.delivery.status.response',
        protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        ...identity,
        operationEpoch: 'another-operation',
        status: { kind: 'applied', value: { messageType: 'feedback.started' } },
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    expect(
      internals(provider)
        .pendingFeedbackStatusQueries.get(webview as unknown as vscode.Webview)
        ?.has(identity.messageId)
    ).toBe(true);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.delivery.status.response',
        protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        ...identity,
        status: { kind: 'applied', value: { messageType: 'feedback.started' } },
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await expect(pending).resolves.toEqual({
      kind: 'applied',
      value: { messageType: 'feedback.started' },
    });
    expect(
      internals(provider).pendingFeedbackStatusQueries.has(webview as unknown as vscode.Webview)
    ).toBe(false);
  });

  it('restores editing and retains the draft when renderer activation is rejected', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);

    internals(provider).handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: 2,
        feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        viewGeneration: 'feedback-delivery-view-rejected',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    webview.postMessage.mockClear();
    const automaticPostMessage = webview.postMessage.getMockImplementation();
    webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      const automaticResult = automaticPostMessage?.(message) ?? Promise.resolve(true);
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            createFlushAcknowledgement(message, true),
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      if (message.type === 'feedback.delivery') {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            {
              type: 'feedback.delivery.ack',
              protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
              messageId: message.messageId,
              operationEpoch: message.operationEpoch,
              sessionEpoch: message.sessionEpoch,
              stageRevision: message.stageRevision,
              outcome: { kind: 'rejected', code: 'renderer-apply-failed' },
            },
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      return automaticResult;
    });

    sendStart(provider, document, webview, 'start-rejected-delivery');
    const error = await waitForMessage(webview, 'feedback.error', 'start-rejected-delivery');
    await waitUntil(() => internals(provider).feedbackSessions.size === 0);

    expect(error.message).toMatch(/did not confirm|draft was saved/i);
    expect(messagesOfType(webview, 'feedback.peer.release')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'apply', content: SOURCE_TEXT }),
        expect.objectContaining({ phase: 'commit' }),
      ])
    );
    await expect(pathExists(path.join(workspaceRoot, '.md4h', 'feedback'))).resolves.toBe(true);
  });

  it('keeps failed activation ownership locked until its authoritative release is applied', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false, { release: false });

    internals(provider).handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        viewGeneration: 'feedback-delivery-failed-release-barrier',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const automaticPostMessage = webview.postMessage.getMockImplementation();
    webview.postMessage.mockClear();
    webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      const automaticResult = automaticPostMessage?.(message) ?? Promise.resolve(true);
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            createFlushAcknowledgement(message, true),
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      if (message.type === 'feedback.delivery') {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            {
              type: 'feedback.delivery.ack',
              protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
              messageId: message.messageId,
              operationEpoch: message.operationEpoch,
              sessionEpoch: message.sessionEpoch,
              stageRevision: message.stageRevision,
              outcome: { kind: 'rejected', code: 'renderer-apply-failed' },
            },
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      return automaticResult;
    });

    sendStart(provider, document, webview, 'start-failed-release-barrier');
    await waitForMessage(webview, 'feedback.error', 'start-failed-release-barrier');
    const applyRelease = await waitForFeedbackPeerReleasePhase(
      webview,
      'apply',
      'start-failed-release-barrier'
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(internals(provider).feedbackSessions.size).toBe(1);
    expect(messagesOfType(webview, 'feedback.peer.release')).toHaveLength(1);
    expect(
      messagesOfType(webview, 'feedback.peer.unlocked').filter(
        message => message.lockId === applyRelease.lockId
      )
    ).toHaveLength(0);

    acknowledgeFeedbackPeerRelease(provider, document, webview, applyRelease);
    const commitRelease = await waitForFeedbackPeerReleasePhase(
      webview,
      'commit',
      'start-failed-release-barrier'
    );
    acknowledgeFeedbackPeerRelease(provider, document, webview, commitRelease);
    await waitUntil(() => internals(provider).feedbackSessions.size === 0);
  });

  it.each([
    {
      message: {
        type: 'feedback.finished',
        requestId: 'critical-finished',
        sessionId: 'critical-session',
        feedbackFile: '.md4h/feedback/feedback.md',
        itemCount: 1,
        prompt: 'Implement the sealed feedback bundle.',
        promptCopied: true,
      },
      sessionEpoch: 'critical-session',
      revision: 1,
    },
    {
      message: {
        type: 'feedback.discarded',
        requestId: 'critical-discarded',
        sessionId: 'critical-session',
      },
      sessionEpoch: 'critical-session',
      revision: 1,
    },
    {
      message: {
        type: 'feedback.close.sync',
        requestId: 'critical-close-sync',
        sessionId: 'critical-session',
        revision: 3,
        content: '# Authoritative\n',
      },
      sessionEpoch: 'critical-session',
      revision: 3,
    },
    {
      message: {
        type: 'feedback.close.release',
        requestId: 'critical-close-release',
        sessionId: 'critical-session',
        revision: 3,
      },
      sessionEpoch: 'critical-session',
      revision: 3,
    },
    {
      message: {
        type: 'feedback.transition.sync',
        requestId: 'critical-transition-sync',
        lockId: 'critical-transition',
        revision: 3,
        content: '# Authoritative\n',
      },
      sessionEpoch: 'critical-transition',
      revision: 3,
    },
  ])(
    'retries $message.type after rejection and queued-but-unreceived delivery',
    async ({ message, sessionEpoch, revision }) => {
      jest.useFakeTimers();
      const provider = createProvider(workspaceRoot);
      const document = createDocument(sourcePath, SOURCE_TEXT);
      const webview = createWebview(provider, document, false);
      try {
        internals(provider).handleWebviewMessage(
          {
            type: 'ready',
            protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
            feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
            viewGeneration: `critical-${message.type}`,
          },
          document as unknown as vscode.TextDocument,
          webview as unknown as vscode.Webview
        );
        webview.postMessage.mockClear();
        let stageAttempts = 0;
        webview.postMessage.mockImplementation((posted: FeedbackMessage) => {
          if (posted.type !== message.type) return Promise.resolve(true);
          stageAttempts += 1;
          if (stageAttempts === 1) return Promise.reject(new Error('post rejected'));
          return Promise.resolve(true);
        });

        const controller = internals(provider).postFeedbackCriticalStage(
          webview as unknown as vscode.Webview,
          message,
          sessionEpoch,
          revision
        );
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(100);
        expect(stageAttempts).toBe(2);

        await jest.advanceTimersByTimeAsync(750);
        await jest.advanceTimersByTimeAsync(100);
        expect(stageAttempts).toBe(3);
        await jest.advanceTimersByTimeAsync(750);
        await jest.advanceTimersByTimeAsync(100);
        expect(stageAttempts).toBe(4);
        expect(
          internals(provider).acknowledgeFeedbackCriticalStage(
            webview as unknown as vscode.Webview,
            message.type,
            message.requestId as string,
            sessionEpoch,
            revision,
            true
          )
        ).toBe('accepted');
        controller?.abort();
        await jest.advanceTimersByTimeAsync(2_000);
        expect(stageAttempts).toBe(4);
      } finally {
        provider.dispose();
        jest.useRealTimers();
      }
    }
  );

  it('cancels critical-stage retry timers on stage advance and provider disposal', async () => {
    jest.useFakeTimers();
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);
    try {
      internals(provider).handleWebviewMessage(
        {
          type: 'ready',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
          viewGeneration: 'critical-cleanup',
        },
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      webview.postMessage.mockClear();
      webview.postMessage.mockResolvedValue(true);

      const first = internals(provider).postFeedbackCriticalStage(
        webview as unknown as vscode.Webview,
        {
          type: 'feedback.close.sync',
          requestId: 'critical-cleanup',
          sessionId: 'critical-session',
          revision: 1,
          content: '# First\n',
        },
        'critical-session',
        1
      );
      await Promise.resolve();
      internals(provider).postFeedbackCriticalStage(
        webview as unknown as vscode.Webview,
        {
          type: 'feedback.close.release',
          requestId: 'critical-cleanup',
          sessionId: 'critical-session',
          revision: 1,
        },
        'critical-session',
        1,
        first
      );
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(850);

      expect(messagesOfType(webview, 'feedback.close.sync')).toHaveLength(1);
      expect(messagesOfType(webview, 'feedback.close.release')).toHaveLength(2);

      provider.dispose();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(messagesOfType(webview, 'feedback.close.release')).toHaveLength(2);
    } finally {
      provider.dispose();
      jest.useRealTimers();
    }
  });

  it.each([
    { terminalType: 'feedback.finished' as const, requestType: 'feedback.finish' as const },
    { terminalType: 'feedback.discarded' as const, requestType: 'feedback.discard' as const },
  ])(
    'advances the acknowledged $terminalType, close.sync, and close.release stages end to end',
    async ({ terminalType, requestType }) => {
      const provider = createProvider(workspaceRoot);
      const document = createDocument(sourcePath, SOURCE_TEXT);
      const webview = createWebview(provider, document);
      const started = await startAndAddTextFeedback(provider, document, webview);
      internals(provider).feedbackDeliveryCapableWebviews.add(webview as unknown as vscode.Webview);
      if (requestType === 'feedback.finish') {
        (vscode.env as unknown as { clipboard: { writeText: jest.Mock } }).clipboard = {
          writeText: jest.fn(async () => undefined),
        };
      } else {
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Discard draft');
        (vscode.workspace as unknown as { fs: { delete: jest.Mock } }).fs = {
          delete: jest.fn(async () => undefined),
        };
      }

      webview.postMessage.mockImplementation((message: FeedbackMessage) => {
        if (message.type === terminalType) {
          queueMicrotask(() => {
            internals(provider).handleWebviewMessage(
              {
                type: 'feedback.close.ready',
                requestId: message.requestId,
                sessionId: message.sessionId,
              },
              document as unknown as vscode.TextDocument,
              webview as unknown as vscode.Webview
            );
          });
        } else if (message.type === 'feedback.close.sync') {
          queueMicrotask(() => {
            internals(provider).handleWebviewMessage(
              {
                type: 'feedback.close.applied',
                requestId: message.requestId,
                sessionId: message.sessionId,
                revision: message.revision,
              },
              document as unknown as vscode.TextDocument,
              webview as unknown as vscode.Webview
            );
          });
        } else if (message.type === 'feedback.close.release') {
          queueMicrotask(() => {
            internals(provider).handleWebviewMessage(
              {
                type: 'feedback.close.released',
                requestId: message.requestId,
                sessionId: message.sessionId,
                revision: message.revision,
              },
              document as unknown as vscode.TextDocument,
              webview as unknown as vscode.Webview
            );
          });
        } else if (message.type === 'feedback.peer.release') {
          queueMicrotask(() => {
            internals(provider).handleWebviewMessage(
              {
                type: 'feedback.peer.released',
                phase: message.phase,
                releaseId: message.releaseId,
                requestId: message.requestId,
                lockId: message.lockId,
                viewGeneration: message.viewGeneration,
                revision: message.revision,
                documentVersion: message.documentVersion,
                contentSha256: message.contentSha256,
              },
              document as unknown as vscode.TextDocument,
              webview as unknown as vscode.Webview
            );
          });
        }
        return Promise.resolve(true);
      });

      internals(provider).handleWebviewMessage(
        {
          type: requestType,
          requestId: `critical-${requestType}`,
          sessionId: started.sessionId,
        },
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );

      await waitUntil(() => internals(provider).feedbackSessions.size === 0);
      expect(messagesOfType(webview, terminalType)).toHaveLength(1);
      expect(messagesOfType(webview, 'feedback.close.sync')).toHaveLength(1);
      expect(messagesOfType(webview, 'feedback.close.release')).toHaveLength(1);
    }
  );

  it('restarts a changed close snapshot and retires only after every live split applies it', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document, true, { release: false });
    const peerWebview = createWebview(provider, document, true, { release: false });
    const disposedPeerWebview = createWebview(provider, document, true, { release: false });
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      peerWebview as unknown as vscode.Webview
    );
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      disposedPeerWebview as unknown as vscode.Webview
    );
    const started = await startAndAddTextFeedback(provider, document, ownerWebview);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Discard draft');
    (vscode.workspace as unknown as { fs: { delete: jest.Mock } }).fs = {
      delete: jest.fn(async () => undefined),
    };

    internals(provider).handleWebviewMessage(
      { type: 'feedback.discard', requestId: 'close-all-splits', sessionId: started.sessionId },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    await waitForMessage(ownerWebview, 'feedback.discarded', 'close-all-splits');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.ready',
        requestId: 'close-all-splits',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    const sync = await waitForMessage(ownerWebview, 'feedback.close.sync', 'close-all-splits');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.applied',
        requestId: 'close-all-splits',
        sessionId: started.sessionId,
        revision: sync.revision,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    await waitForMessage(ownerWebview, 'feedback.close.release', 'close-all-splits');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.released',
        requestId: 'close-all-splits',
        sessionId: started.sessionId,
        revision: sync.revision,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );

    const ownerRelease = await waitForMessage(
      ownerWebview,
      'feedback.peer.release',
      'close-all-splits'
    );
    const peerRelease = await waitForMessage(
      peerWebview,
      'feedback.peer.release',
      'close-all-splits'
    );
    const disposedPeerRelease = await waitForMessage(
      disposedPeerWebview,
      'feedback.peer.release',
      'close-all-splits'
    );
    expect(ownerRelease).toEqual(
      expect.objectContaining({
        phase: 'apply',
        lockId: started.sessionId,
        documentVersion: 1,
        content: SOURCE_TEXT,
      })
    );
    expect(peerRelease).toEqual(
      expect.objectContaining({ lockId: started.sessionId, content: SOURCE_TEXT })
    );
    expect(disposedPeerRelease).toEqual(
      expect.objectContaining({ lockId: started.sessionId, content: SOURCE_TEXT })
    );
    expect(ownerRelease.viewGeneration).not.toBe(peerRelease.viewGeneration);

    const acknowledge = (
      webview: ReturnType<typeof createWebview>,
      release: FeedbackMessage,
      viewGeneration = release.viewGeneration
    ): void => {
      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.peer.released',
          phase: release.phase,
          releaseId: release.releaseId,
          requestId: release.requestId,
          lockId: release.lockId,
          viewGeneration,
          revision: release.revision,
          documentVersion: release.documentVersion,
          contentSha256: release.contentSha256,
        },
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
    };
    acknowledge(ownerWebview, ownerRelease);
    expect(internals(provider).feedbackSessions.size).toBe(1);
    acknowledge(peerWebview, peerRelease, 'stale-generation');
    expect(internals(provider).feedbackSessions.size).toBe(1);

    const latestContent = '# Guide\n\nChanged while peers were applying.\n';
    document.getText.mockReturnValue(latestContent);
    Object.defineProperty(document, 'version', { configurable: true, value: 2 });
    acknowledge(peerWebview, peerRelease);
    expect(internals(provider).feedbackSessions.size).toBe(1);
    const latestRevision = (ownerRelease.revision as number) + 1;
    const latestOwnerRelease = await waitForFeedbackPeerReleaseRevision(
      ownerWebview,
      latestRevision,
      'close-all-splits'
    );
    const latestPeerRelease = await waitForFeedbackPeerReleaseRevision(
      peerWebview,
      latestRevision,
      'close-all-splits'
    );
    const latestDisposedRelease = await waitForFeedbackPeerReleaseRevision(
      disposedPeerWebview,
      latestRevision,
      'close-all-splits'
    );
    expect(latestOwnerRelease).toEqual(
      expect.objectContaining({
        phase: 'apply',
        documentVersion: 2,
        content: latestContent,
      })
    );
    expect(latestPeerRelease.releaseId).not.toBe(peerRelease.releaseId);
    expect(latestDisposedRelease.releaseId).not.toBe(disposedPeerRelease.releaseId);
    acknowledge(ownerWebview, latestOwnerRelease);
    acknowledge(peerWebview, latestPeerRelease);
    expect(
      messagesOfType(ownerWebview, 'feedback.peer.release').filter(
        message => message.phase === 'commit'
      )
    ).toHaveLength(0);
    internals(provider).unregisterFeedbackWebview(
      document.uri.toString(),
      disposedPeerWebview as unknown as vscode.Webview
    );
    await waitUntil(() => internals(provider).feedbackSessions.size === 0);
    const ownerCommit = await waitForFeedbackPeerReleasePhase(
      ownerWebview,
      'commit',
      'close-all-splits'
    );
    const peerCommit = await waitForFeedbackPeerReleasePhase(
      peerWebview,
      'commit',
      'close-all-splits'
    );
    expect(
      messagesOfType(disposedPeerWebview, 'feedback.peer.release').filter(
        message => message.phase === 'commit'
      )
    ).toHaveLength(0);
    acknowledge(ownerWebview, ownerCommit);
    acknowledge(peerWebview, peerCommit);
    await waitForMessage(ownerWebview, 'feedback.peer.unlocked');
    await waitForMessage(peerWebview, 'feedback.peer.unlocked');
  });

  it('relocks a recreated close owner before replacing its pending release target', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document, true, { release: false });
    const peerWebview = createWebview(provider, document, true, { release: false });
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      peerWebview as unknown as vscode.Webview
    );
    const started = await startAndAddTextFeedback(provider, document, ownerWebview);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Discard draft');
    (vscode.workspace as unknown as { fs: { delete: jest.Mock } }).fs = {
      delete: jest.fn(async () => undefined),
    };

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.discard',
        requestId: 'close-owner-reloads',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    await waitForMessage(ownerWebview, 'feedback.discarded', 'close-owner-reloads');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.ready',
        requestId: 'close-owner-reloads',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    const sync = await waitForMessage(ownerWebview, 'feedback.close.sync', 'close-owner-reloads');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.applied',
        requestId: 'close-owner-reloads',
        sessionId: started.sessionId,
        revision: sync.revision,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    await waitForMessage(ownerWebview, 'feedback.close.release', 'close-owner-reloads');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.close.released',
        requestId: 'close-owner-reloads',
        sessionId: started.sessionId,
        revision: sync.revision,
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );
    const peerRelease = await waitForMessage(
      peerWebview,
      'feedback.peer.release',
      'close-owner-reloads'
    );
    acknowledgeFeedbackPeerRelease(provider, document, peerWebview, peerRelease);
    await waitForMessage(ownerWebview, 'feedback.peer.release', 'close-owner-reloads');

    internals(provider).handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        viewGeneration: 'close-owner-recreated',
      },
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );

    const reacquire = await waitForMessage(
      ownerWebview,
      'feedback.peer.lock.acquire',
      'close-owner-reloads'
    );
    const recreatedRelease = await waitForNthMessage(
      ownerWebview,
      'feedback.peer.release',
      2,
      'close-owner-reloads'
    );
    expect(reacquire).toEqual(
      expect.objectContaining({
        lockId: started.sessionId,
        viewGeneration: 'close-owner-recreated',
      })
    );
    expect(recreatedRelease).toEqual(
      expect.objectContaining({
        lockId: started.sessionId,
        viewGeneration: 'close-owner-recreated',
      })
    );
    expect(internals(provider).feedbackSessions.size).toBe(1);
    expect(messagesOfType(ownerWebview, 'feedback.delivery')).toHaveLength(0);

    const exhaustedOwnerTransport = internals(provider).feedbackCriticalTransports.get(
      ownerWebview as unknown as vscode.Webview
    );
    exhaustedOwnerTransport?.dispose();
    internals(provider).feedbackCriticalTransports.delete(
      ownerWebview as unknown as vscode.Webview
    );
    // The exact semantic ACK remains authoritative even after its bounded
    // transport identity has been retired as exhausted.
    acknowledgeFeedbackPeerRelease(provider, document, ownerWebview, recreatedRelease);
    await waitUntil(() => internals(provider).feedbackSessions.size === 0);
    const ownerCommit = await waitForFeedbackPeerReleasePhase(
      ownerWebview,
      'commit',
      'close-owner-reloads'
    );
    const peerCommit = await waitForFeedbackPeerReleasePhase(
      peerWebview,
      'commit',
      'close-owner-reloads'
    );
    acknowledgeFeedbackPeerRelease(provider, document, ownerWebview, ownerCommit);
    acknowledgeFeedbackPeerRelease(provider, document, peerWebview, peerCommit);
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
      if (message.type === 'feedback.peer.release') {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            {
              type: 'feedback.peer.released',
              phase: message.phase,
              releaseId: message.releaseId,
              requestId: message.requestId,
              lockId: message.lockId,
              viewGeneration: message.viewGeneration,
              revision: message.revision,
              documentVersion: message.documentVersion,
              contentSha256: message.contentSha256,
            },
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
      createFlushAcknowledgement(flush, true),
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

  it('rejects same-shape saved bytes that no longer match the captured TextDocument', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);

    sendStart(provider, document, webview, 'start-same-shape-disk-change');
    const flush = await waitForMessage(webview, 'flushPendingEdit');
    await writeFile(sourcePath, '# Guide\n\nDifferent paragraph.\n', 'utf8');
    internals(provider).handleWebviewMessage(
      createFlushAcknowledgement(flush, true),
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await expect(
      waitForMessage(webview, 'feedback.error', 'start-same-shape-disk-change')
    ).resolves.toEqual(
      expect.objectContaining({
        code: 'MD4H-FB-SNAPSHOT-001',
        message: expect.stringMatching(/snapshot|source|saved|bytes/i),
      })
    );
    expect(messagesOfType(webview, 'feedback.started')).toHaveLength(0);
    expect(internals(provider).feedbackSessions.size).toBe(0);
  });

  it('applies saved source before accepting owner canonical blocks', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    enableSnapshotProtocol(provider, document, webview, {
      viewGeneration: 'snapshot-owner-generation',
      inspectContent: SOURCE_TEXT,
      dirty: false,
      blocks: START_BLOCKS,
    });

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.start',
        requestId: 'start-authoritative-snapshot',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await waitForMessage(webview, 'feedback.started', 'start-authoritative-snapshot');
    const apply = await waitForMessage(webview, 'feedback.snapshot.apply');
    expect(apply).toEqual(
      expect.objectContaining({
        content: SOURCE_TEXT,
        includeCanonicalBlocks: true,
      })
    );
    const session = internals(provider).feedbackSessions.get(document.uri.toString()) as
      { canonicalBlocks: Map<number, { sha256: string }> } | undefined;
    expect(session?.canonicalBlocks.get(0)?.sha256).toBe(
      createHash('sha256').update(START_BLOCKS[0].markdown).digest('hex')
    );
  });

  it('rejects an applied snapshot report whose serialized renderer content differs', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    enableSnapshotProtocol(provider, document, webview, {
      viewGeneration: 'snapshot-mismatch-generation',
      inspectContent: SOURCE_TEXT,
      appliedContent: '# Different renderer source\n',
      dirty: false,
      blocks: START_BLOCKS,
    });

    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'start-mismatched-applied-content' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await expect(
      waitForMessage(webview, 'feedback.error', 'start-mismatched-applied-content')
    ).resolves.toEqual(
      expect.objectContaining({
        code: 'MD4H-FB-SNAPSHOT-001',
        message: expect.stringMatching(/snapshot|renderer|content/i),
      })
    );
    expect(internals(provider).feedbackSessions.size).toBe(0);
  });

  it('accepts equivalent TipTap list canonicalization reported after snapshot apply', async () => {
    const source = '# Guide\n\n* Alpha\n* Beta\n';
    const canonical = '# Guide\n\n- Alpha\n- Beta\n';
    const blocks = [
      { ordinal: 0, kind: 'heading', markdown: '# Guide', contentSize: 5 },
      { ordinal: 1, kind: 'bulletList', markdown: '- Alpha\n- Beta', contentSize: 9 },
    ];
    await writeFile(sourcePath, source, 'utf8');
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, source);
    const webview = createWebview(provider, document);
    enableSnapshotProtocol(provider, document, webview, {
      viewGeneration: 'snapshot-canonical-list-generation',
      inspectContent: source,
      appliedContent: canonical,
      dirty: false,
      blocks,
    });

    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'start-canonical-list-snapshot' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await expect(
      waitForMessage(webview, 'feedback.started', 'start-canonical-list-snapshot')
    ).resolves.toEqual(expect.objectContaining({ sourceSha256: expect.any(String) }));
    expect(messagesOfType(webview, 'feedback.error')).toHaveLength(0);
  });

  it('accepts TipTap hard-break serialization reported after snapshot apply', async () => {
    const source = '# Guide\n\nCompatible VS Code hosts\nmust provide webview APIs.\n';
    const canonical = '# Guide\n\nCompatible VS Code hosts  \nmust provide webview APIs.\n';
    const blocks = [
      { ordinal: 0, kind: 'heading', markdown: '# Guide', contentSize: 5 },
      {
        ordinal: 1,
        kind: 'paragraph',
        markdown: 'Compatible VS Code hosts  \nmust provide webview APIs.',
        contentSize: 52,
      },
    ];
    await writeFile(sourcePath, source, 'utf8');
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, source);
    const webview = createWebview(provider, document);
    enableSnapshotProtocol(provider, document, webview, {
      viewGeneration: 'snapshot-canonical-hard-break-generation',
      inspectContent: source,
      appliedContent: canonical,
      dirty: false,
      blocks,
    });

    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'start-canonical-hard-break-snapshot' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await expect(
      waitForMessage(webview, 'feedback.started', 'start-canonical-hard-break-snapshot')
    ).resolves.toEqual(expect.objectContaining({ sourceSha256: expect.any(String) }));
    expect(messagesOfType(webview, 'feedback.error')).toHaveLength(0);
  });

  it('wraps frontmatter for apply and verifies the renderer serialization after unwrapping', async () => {
    const source = ['---', 'title: Guide', '---', '', '# Guide', ''].join('\n');
    const wrapped = ['```yaml', '---', 'title: Guide', '---', '```', '', '# Guide', ''].join('\n');
    const blocks = [
      {
        ordinal: 0,
        kind: 'codeBlock',
        markdown: '```yaml\n---\ntitle: Guide\n---\n```',
        contentSize: 22,
      },
      { ordinal: 1, kind: 'heading', markdown: '# Guide', contentSize: 5 },
    ];
    await writeFile(sourcePath, source, 'utf8');
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, source);
    const webview = createWebview(provider, document);
    enableSnapshotProtocol(provider, document, webview, {
      viewGeneration: 'snapshot-frontmatter-generation',
      inspectContent: source,
      appliedContent: wrapped,
      dirty: false,
      blocks,
    });

    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'start-frontmatter-snapshot' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await waitForMessage(webview, 'feedback.started', 'start-frontmatter-snapshot');
    await expect(waitForMessage(webview, 'feedback.snapshot.apply')).resolves.toEqual(
      expect.objectContaining({ content: wrapped })
    );
    expect(messagesOfType(webview, 'feedback.error')).toHaveLength(0);
  });

  it('fails before flushing when two dirty splits report divergent content', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const owner = createWebview(provider, document);
    const peer = createWebview(provider, document);
    enableSnapshotProtocol(provider, document, owner, {
      viewGeneration: 'snapshot-owner-generation',
      inspectContent: '# Owner edit\n',
      dirty: true,
      blocks: START_BLOCKS,
    });
    enableSnapshotProtocol(provider, document, peer, {
      viewGeneration: 'snapshot-peer-generation',
      inspectContent: '# Peer edit\n',
      dirty: true,
      blocks: START_BLOCKS,
    });

    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'start-divergent-dirty-splits', blocks: START_BLOCKS },
      document as unknown as vscode.TextDocument,
      owner as unknown as vscode.Webview
    );

    const error = await waitForMessage(owner, 'feedback.error', 'start-divergent-dirty-splits');
    expect(error).toEqual(
      expect.objectContaining({
        code: 'MD4H-FB-SNAPSHOT-001',
        message: expect.stringMatching(/split|diverg/i),
      })
    );
    expect(messagesOfType(owner, 'flushPendingEdit')).toHaveLength(0);
    expect(messagesOfType(peer, 'flushPendingEdit')).toHaveLength(0);
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
      createFlushAcknowledgement(flush, true),
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
      createFlushAcknowledgement(flush, true),
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
      createFlushAcknowledgement(flush, true),
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
    expect(report).toContain('schema: md4h-feedback/v2');
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
    const ownerWebview = createWebview(provider, document);
    const automaticPeerAcknowledgements = { lock: false };
    const duplicateWebview = createWebview(provider, document, true, automaticPeerAcknowledgements);
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
    const lock = await waitForMessage(duplicateWebview, 'feedback.peer.lock.acquire');

    expect(lock).toEqual(
      expect.objectContaining({
        lockId: expect.any(String),
        message: expect.stringMatching(/another editor split/i),
      })
    );
    expect(messagesOfType(ownerWebview, 'feedback.started')).toHaveLength(0);
    expect(messagesOfType(ownerWebview, 'feedback.peer.lock.acquire')).toHaveLength(0);

    automaticPeerAcknowledgements.lock = true;
    const exhaustedLockTransport = internals(provider).feedbackCriticalTransports.get(
      duplicateWebview as unknown as vscode.Webview
    );
    exhaustedLockTransport?.dispose();
    internals(provider).feedbackCriticalTransports.delete(
      duplicateWebview as unknown as vscode.Webview
    );
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.peer.lock.acquired',
        acquisitionId: lock.acquisitionId,
        requestId: lock.requestId,
        lockId: lock.lockId,
        replacesLockId: lock.replacesLockId,
        viewGeneration: lock.viewGeneration,
        revision: lock.revision,
      },
      document as unknown as vscode.TextDocument,
      duplicateWebview as unknown as vscode.Webview
    );

    await expect(
      waitForMessage(ownerWebview, 'feedback.started', 'start-locks-split')
    ).resolves.toEqual(expect.objectContaining({ sessionId: expect.any(String) }));
  });

  it('coalesces concurrent reassertions of the same peer lock acquisition', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const ownerWebview = createWebview(provider, document);
    const automaticPeerAcknowledgements = { lock: false };
    const peerWebview = createWebview(provider, document, true, automaticPeerAcknowledgements);
    const documentKey = document.uri.toString();
    internals(provider).registerFeedbackWebview(
      documentKey,
      ownerWebview as unknown as vscode.Webview
    );
    internals(provider).registerFeedbackWebview(
      documentKey,
      peerWebview as unknown as vscode.Webview
    );

    try {
      sendStart(provider, document, ownerWebview, 'start-coalesced-peer-lock');
      const acquisition = await waitForMessage(peerWebview, 'feedback.peer.lock.acquire');
      internals(provider).postCurrentFeedbackPeerLock(
        documentKey,
        peerWebview as unknown as vscode.Webview
      );
      internals(provider).postCurrentFeedbackPeerLock(
        documentKey,
        peerWebview as unknown as vscode.Webview
      );
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(
        messagesOfType(peerWebview, 'feedback.peer.lock.acquire').filter(
          message => message.lockId === acquisition.lockId
        )
      ).toHaveLength(1);

      automaticPeerAcknowledgements.lock = true;
      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.peer.lock.acquired',
          acquisitionId: acquisition.acquisitionId,
          requestId: acquisition.requestId,
          lockId: acquisition.lockId,
          replacesLockId: acquisition.replacesLockId,
          viewGeneration: acquisition.viewGeneration,
          revision: acquisition.revision,
        },
        document as unknown as vscode.TextDocument,
        peerWebview as unknown as vscode.Webview
      );
      await waitForMessage(ownerWebview, 'feedback.started', 'start-coalesced-peer-lock');
    } finally {
      provider.dispose();
    }
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
    internals(provider).handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        feedbackDeliveryProtocolVersion: 0,
        viewGeneration: 'peer-edit-rejection-generation',
      },
      document as unknown as vscode.TextDocument,
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
      {
        type: 'edit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: 'peer-edit-rejected',
        viewGeneration: 'peer-edit-rejection-generation',
        localRevision: 7,
        baseDocumentVersion: 1,
        content: '# Peer must not write\n',
        editReason: 'typing',
      },
      document as unknown as vscode.TextDocument,
      duplicateWebview as unknown as vscode.Webview
    );

    expect(applyEdit).not.toHaveBeenCalled();
    expect(messagesOfType(duplicateWebview, 'document.edit.ack')).toContainEqual({
      type: 'document.edit.ack',
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      editId: 'peer-edit-rejected',
      viewGeneration: 'peer-edit-rejection-generation',
      localRevision: 7,
      accepted: false,
      documentVersion: 1,
    });
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
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Discard this Feedback draft?',
      {
        modal: true,
        detail:
          'This draft contains 1 saved feedback item. Its bundle will be moved to Trash, and Feedback mode will end.',
      },
      'Discard draft'
    );
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
    const document = createDocument(sourcePath, SOURCE_TEXT, {
      dirty: true,
      save: jest.fn(async () => false),
    });
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

    sendStart(provider, document, ownerWebview, 'start-peer-unlock-on-error');
    const locked = await waitForMessage(duplicateWebview, 'feedback.peer.lock.acquire');
    await waitForMessage(ownerWebview, 'feedback.error', 'start-peer-unlock-on-error');
    const unlocked = await waitForMessage(duplicateWebview, 'feedback.peer.unlocked');

    expect(unlocked.lockId).toBe(locked.lockId);
  });

  it('acquires a peer lock before releasing a transition that failed before capture', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
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

    sendStart(provider, document, ownerWebview, 'start-fails-before-peer-lock');
    const flush = await waitForMessage(ownerWebview, 'flushPendingEdit');
    internals(provider).handleWebviewMessage(
      createFlushAcknowledgement(flush, false),
      document as unknown as vscode.TextDocument,
      ownerWebview as unknown as vscode.Webview
    );

    await waitForMessage(ownerWebview, 'feedback.error', 'start-fails-before-peer-lock');
    const lock = await waitForMessage(peerWebview, 'feedback.peer.lock.acquire');
    const release = await waitForMessage(
      peerWebview,
      'feedback.peer.release',
      'start-fails-before-peer-lock'
    );
    const peerMessages = peerWebview.postMessage.mock.calls.map(call => call[0] as FeedbackMessage);
    expect(peerMessages.indexOf(lock)).toBeLessThan(peerMessages.indexOf(release));
    expect(release.lockId).toBe(lock.lockId);
    await waitUntil(() => internals(provider).feedbackTransitions.size === 0);
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

  it('starts new host-owned rounds with the v2 report schema', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);

    sendStart(provider, document, webview, 'start-v2-schema');
    const started = await waitForMessage(webview, 'feedback.started', 'start-v2-schema');

    expect(started.evidenceVersion).toBe(2);
    const report = await readFile(path.join(workspaceRoot, started.feedbackFile as string), 'utf8');
    expect(report).toContain('schema: md4h-feedback/v2\n');
    expect(report).toContain('guide_version: 2\n');
    expect(report).not.toContain('**Focus:**');
  });

  it('persists an explicit whole-table action as frozen authored source, never TSV', async () => {
    await writeFile(sourcePath, TABLE_SOURCE_TEXT);
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, TABLE_SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'start-v2-whole-table', blocks: TABLE_BLOCKS },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const started = await waitForMessage(webview, 'feedback.started', 'start-v2-whole-table');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-v2-whole-table',
        sessionId: started.sessionId,
        startOrdinal: 0,
        endOrdinal: 0,
        feedback: 'Clarify this decision table.',
        target: { version: 2, requestedScope: 'blocks' },
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await waitForMessage(webview, 'feedback.updated', 'add-v2-whole-table');
    const report = await readFile(path.join(workspaceRoot, started.feedbackFile as string), 'utf8');
    expect(report).toContain('**Target:** Whole table · exact · block 1');
    expect(report).toContain('### Selected source');
    expect(report).toContain(TABLE_SOURCE_TEXT.trimEnd());
    expect(report).not.toContain('### Selected cells');
    expect(report).not.toContain('**Focus:**');
  });

  it('persists a v2 rectangular cell selection as a typed matrix with derived TSV', async () => {
    await writeFile(sourcePath, TABLE_SOURCE_TEXT);
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, TABLE_SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'start-v2-table-cells', blocks: TABLE_BLOCKS },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const started = await waitForMessage(webview, 'feedback.started', 'start-v2-table-cells');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-v2-table-cells',
        sessionId: started.sessionId,
        startOrdinal: 0,
        endOrdinal: 0,
        feedback: 'Review these cells.',
        target: {
          version: 2,
          requestedScope: 'table-cells',
          locator: { kind: 'table-cells', value: TABLE_CELL_TARGET_INPUT },
        },
        evidence: {
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
        },
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await waitForMessage(webview, 'feedback.updated', 'add-v2-table-cells');
    const report = await readFile(path.join(workspaceRoot, started.feedbackFile as string), 'utf8');
    expect(report).toContain('**Fidelity:** Typed table-cell matrix');
    expect(report).toContain('### Cell matrix');
    expect(report).toContain('### Selected cells (escaped TSV)');
    expect(report).toContain('"role": "header"');
    expect(report).toContain('"text": "A"');
    expect(report).toContain('A\tB\n1\t2');
    expect(report).not.toContain('**Focus:**');
  });

  it('keeps v2 partial code as exact rendered text without synthesizing Markdown', async () => {
    await writeFile(sourcePath, CODE_SOURCE_TEXT);
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, CODE_SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'start-v2-rendered-text', blocks: CODE_BLOCKS },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const started = await waitForMessage(webview, 'feedback.started', 'start-v2-rendered-text');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-v2-rendered-text',
        sessionId: started.sessionId,
        startOrdinal: 0,
        endOrdinal: 0,
        feedback: 'Make this precise.',
        target: {
          version: 2,
          requestedScope: 'rendered-text',
          locator: {
            kind: 'rendered-range',
            value: {
              version: 1,
              startOrdinal: 0,
              startOffset: 0,
              endOrdinal: 0,
              endOffset: 'const role'.length,
            },
          },
        },
        evidence: {
          kind: 'rendered-text',
          text: 'const role',
          complete: true,
          language: 'typescript',
        },
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await waitForMessage(webview, 'feedback.updated', 'add-v2-rendered-text');
    const report = await readFile(path.join(workspaceRoot, started.feedbackFile as string), 'utf8');
    expect(report).toContain('**Fidelity:** Exact rendered text');
    expect(report).toContain('### Selected content');
    expect(report).toContain('const role');
    expect(report).toContain('**Language:** `typescript`');
    expect(report).not.toContain(CODE_SOURCE_TEXT.trimEnd());
    expect(report).not.toContain('**Focus:**');
  });

  it('classifies normalized HTML blocks as HTML source evidence', async () => {
    const htmlSource = '<div><strong>Decision</strong></div>\n';
    const htmlBlocks = [
      {
        ordinal: 0,
        kind: 'htmlBlock',
        markdown: htmlSource.trimEnd(),
        contentSize: htmlSource.trimEnd().length,
      },
    ];
    await writeFile(sourcePath, htmlSource);
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, htmlSource);
    const webview = createWebview(provider, document);
    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'start-v2-html', blocks: htmlBlocks },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const started = await waitForMessage(webview, 'feedback.started', 'start-v2-html');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-v2-html',
        sessionId: started.sessionId,
        startOrdinal: 0,
        endOrdinal: 0,
        feedback: 'Preserve the authored HTML.',
        target: { version: 2, requestedScope: 'blocks' },
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await waitForMessage(webview, 'feedback.updated', 'add-v2-html');
    const report = await readFile(path.join(workspaceRoot, started.feedbackFile as string), 'utf8');
    expect(report).toContain('"format":"html"');
    expect(report).toContain(htmlSource.trimEnd());
  });

  it('rejects a table-cell locator whose fingerprint differs from frozen table state', async () => {
    await writeFile(sourcePath, TABLE_SOURCE_TEXT);
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, TABLE_SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'start-v2-fingerprint', blocks: TABLE_BLOCKS },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const started = await waitForMessage(webview, 'feedback.started', 'start-v2-fingerprint');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-v2-forged-fingerprint',
        sessionId: started.sessionId,
        startOrdinal: 0,
        endOrdinal: 0,
        feedback: 'This must fail closed.',
        ...v2TableCellSelection({
          ...TABLE_CELL_TARGET_INPUT,
          rectangle: { top: 0, left: 0, bottom: 1, right: 1 },
          tableFingerprint: 'md4h-table/v1:fedcba9876543210',
        }),
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const error = await waitForMessage(webview, 'feedback.error', 'add-v2-forged-fingerprint');
    expect(error.code).toBe('MD4H-FB-ANCHOR-001');
    expect(internals(provider).feedbackSessions.get(document.uri.toString())!.store.items).toEqual(
      []
    );
  });

  it('rejects locator-free legacy adds after advertising structured evidence v2', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    sendStart(provider, document, webview, 'start-v2-legacy-policy');
    const started = await waitForMessage(webview, 'feedback.started', 'start-v2-legacy-policy');
    expect(started.evidenceVersion).toBe(2);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-v2-legacy-without-locator',
        sessionId: started.sessionId,
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Paragraph.',
        feedback: 'Do not create migration-only evidence for a new item.',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const error = await waitForMessage(webview, 'feedback.error', 'add-v2-legacy-without-locator');
    expect(error).toEqual(
      expect.objectContaining({
        code: 'MD4H-FB-ANCHOR-001',
        message: expect.stringMatching(/predates structured evidence/i),
      })
    );
    expect(internals(provider).feedbackSessions.get(document.uri.toString())!.store.items).toEqual(
      []
    );
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

  it('enriches a typed table-cell target with the canonical table hash before persistence', async () => {
    await writeFile(sourcePath, TABLE_SOURCE_TEXT);
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, TABLE_SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      webview as unknown as vscode.Webview
    );
    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'start-table-cell', blocks: TABLE_BLOCKS },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const started = await waitForMessage(webview, 'feedback.started', 'start-table-cell');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-table-cell',
        sessionId: started.sessionId,
        startOrdinal: 0,
        endOrdinal: 0,
        feedback: 'Review these cells.',
        ...v2TableCellSelection(TABLE_CELL_TARGET_INPUT),
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const updated = await waitForMessage(webview, 'feedback.updated', 'add-table-cell');
    const tableHash = createHash('sha256').update(TABLE_BLOCKS[0].markdown).digest('hex');
    expect(updated.items).toEqual([
      expect.objectContaining({
        id: 'F1',
        cellTarget: { ...TABLE_CELL_TARGET_INPUT, tableBlockSha256: tableHash },
      }),
    ]);
    const report = await readFile(path.join(workspaceRoot, started.feedbackFile as string), 'utf8');
    expect(report).toContain(`"tableBlockSha256":"${tableHash}"`);
    expect(report).toContain('**Fidelity:** Typed table-cell matrix');
  });

  it('rejects a forged table-cell target above the exact-cell budget before persistence', async () => {
    await writeFile(sourcePath, TABLE_SOURCE_TEXT);
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, TABLE_SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'start-oversized-table-cell', blocks: TABLE_BLOCKS },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const started = await waitForMessage(webview, 'feedback.started', 'start-oversized-table-cell');
    const session = internals(provider).feedbackSessions.get(document.uri.toString())!;
    const reportBefore = await readFile(session.store.feedbackFilePath);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-oversized-table-cell',
        sessionId: started.sessionId,
        startOrdinal: 0,
        endOrdinal: 0,
        feedback: 'Must not be stored.',
        target: {
          version: 2,
          requestedScope: 'table-cells',
          constraint: { reason: 'item-cell-limit' },
        },
        evidence: { kind: 'semantic-text', text: 'Oversized table selection', complete: false },
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await waitForMessage(webview, 'feedback.updated', 'add-oversized-table-cell');
    expect(session.store.items).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({
          requestedScope: 'table-cells',
          effectiveScope: 'blocks',
          resolution: 'degraded',
          coarsening: { reason: 'item-cell-limit', origin: 'renderer' },
        }),
      }),
    ]);
    await expect(readFile(session.store.feedbackFilePath)).resolves.not.toEqual(reportBefore);
  });

  it('bounds aggregate exact table-cell geometry at the host boundary', async () => {
    await writeFile(sourcePath, TABLE_SOURCE_TEXT);
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, TABLE_SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'start-cell-session-budget', blocks: TABLE_BLOCKS },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const started = await waitForMessage(webview, 'feedback.started', 'start-cell-session-budget');
    const maximumItemTarget = {
      ...TABLE_CELL_TARGET_INPUT,
      rectangle: { top: 0, left: 0, bottom: 16, right: 16 },
    };
    for (let index = 0; index < 16; index += 1) {
      const requestId = `add-cell-session-budget-${index + 1}`;
      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.text.add',
          requestId,
          sessionId: started.sessionId,
          startOrdinal: 0,
          endOrdinal: 0,
          feedback: 'Keep this exact target.',
          ...v2TableCellSelection(maximumItemTarget, `Selection ${index + 1}`),
        },
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      await waitForMessage(webview, 'feedback.updated', requestId);
    }

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-cell-session-budget-overflow',
        sessionId: started.sessionId,
        startOrdinal: 0,
        endOrdinal: 0,
        feedback: 'Must fall back before reaching this boundary.',
        ...v2TableCellSelection({
          ...TABLE_CELL_TARGET_INPUT,
          rectangle: { top: 0, left: 0, bottom: 1, right: 1 },
        }),
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await waitForMessage(webview, 'feedback.updated', 'add-cell-session-budget-overflow');
    const items = internals(provider).feedbackSessions.get(document.uri.toString())!.store.items;
    expect(items).toHaveLength(17);
    expect(items[16]).toEqual(
      expect.objectContaining({
        target: expect.objectContaining({
          resolution: 'degraded',
          coarsening: { reason: 'session-cell-budget', origin: 'host' },
        }),
      })
    );
  });

  it('atomically migrates restored stale v1 cell locators before accepting a new exact cell', async () => {
    await writeFile(sourcePath, TABLE_SOURCE_TEXT);
    const tableHash = createHash('sha256').update(TABLE_BLOCKS[0].markdown).digest('hex');
    const legacy = await FeedbackSessionStore.create({
      workspaceRoot,
      sourcePath,
      sourceBytes: Buffer.from(TABLE_SOURCE_TEXT, 'utf8'),
      now: new Date('2026-08-21T09:30:00.000Z'),
      roundSuffix: 'cl01',
    });
    const maximumItemTarget = {
      ...TABLE_CELL_TARGET_INPUT,
      version: 1 as const,
      rectangle: { top: 0, left: 0, bottom: 16, right: 16 },
      tableBlockSha256: tableHash,
    };
    for (let index = 0; index < 16; index += 1) {
      await legacy.addTextFeedback({
        startLine: 1,
        endLine: 3,
        focus: `Restored cell selection ${index + 1}`,
        feedback: 'Keep this legacy target and degrade it honestly if stale.',
        cellTarget: maximumItemTarget,
      });
    }

    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, TABLE_SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-restored-cell-budget',
        round: legacy.snapshot.round,
        blocks: TABLE_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const started = await waitForMessage(
      webview,
      'feedback.started',
      'resume-restored-cell-budget'
    );
    const session = internals(provider).feedbackSessions.get(
      document.uri.toString()
    ) as unknown as {
      sessionId: string;
      store: FeedbackSessionStore;
      canonicalBlocks: Map<number, { sha256: string; tableFingerprint?: string }>;
      targets: Map<string, { startOrdinal: number; endOrdinal: number }>;
      degradedCellTargetIds: Set<string>;
    };
    session.canonicalBlocks.get(0)!.sha256 = 'c'.repeat(64);
    session.canonicalBlocks.get(0)!.tableFingerprint = 'md4h-table/v1:fedcba9876543210';
    session.targets.clear();
    (
      provider as unknown as { restoreFeedbackTargets(value: unknown): void }
    ).restoreFeedbackTargets(session);
    expect(session.degradedCellTargetIds).toEqual(
      new Set(Array.from({ length: 16 }, (_, index) => `F${index + 1}`))
    );
    const v1Report = await readFile(session.store.feedbackFilePath);
    expect(v1Report.toString('utf8')).toContain('schema: md4h-feedback/v1');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-after-restored-cell-degradation',
        sessionId: started.sessionId,
        startOrdinal: 0,
        endOrdinal: 0,
        feedback: 'This new exact target should fit after stale migration.',
        ...v2TableCellSelection({
          ...TABLE_CELL_TARGET_INPUT,
          rectangle: { top: 0, left: 0, bottom: 1, right: 1 },
          tableFingerprint: 'md4h-table/v1:fedcba9876543210',
        }),
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await waitForMessage(webview, 'feedback.updated', 'add-after-restored-cell-degradation');
    expect(session.store.schemaVersion).toBe(2);
    expect(session.store.items).toHaveLength(17);
    expect(session.store.items.slice(0, 16)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({
            resolution: 'degraded',
            coarsening: { reason: 'stale-locator', origin: 'host' },
          }),
        }),
      ])
    );
    expect(session.store.items[16]).toEqual(
      expect.objectContaining({ target: expect.objectContaining({ resolution: 'exact' }) })
    );
    await expect(readFile(session.store.feedbackFilePath)).resolves.not.toEqual(v1Report);
  });

  it('revalidates every rendered range at Finish and preserves unrelated valid locators', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    sendStart(provider, document, webview, 'start-finish-range-revalidation');
    const started = await waitForMessage(
      webview,
      'feedback.started',
      'start-finish-range-revalidation'
    );

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-finish-range-paragraph',
        sessionId: started.sessionId,
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Paragraph.',
        feedback: 'This locator will become stale.',
        renderedRange: PARAGRAPH_RENDERED_RANGE_INPUT,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await waitForMessage(webview, 'feedback.updated', 'add-finish-range-paragraph');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-finish-range-heading',
        sessionId: started.sessionId,
        startOrdinal: 0,
        endOrdinal: 0,
        focus: 'Guide',
        feedback: 'This locator must remain exact.',
        renderedRange: {
          version: 1,
          startOrdinal: 0,
          startOffset: 0,
          endOrdinal: 0,
          endOffset: 'Guide'.length,
        },
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await waitForMessage(webview, 'feedback.updated', 'add-finish-range-heading');

    const session = internals(provider).feedbackSessions.get(
      document.uri.toString()
    ) as unknown as {
      canonicalBlocks: Map<number, { sha256: string }>;
    };
    session.canonicalBlocks.get(1)!.sha256 = 'd'.repeat(64);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.finish',
        requestId: 'finish-range-revalidation',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await waitForMessage(webview, 'feedback.finished', 'finish-range-revalidation');

    const report = await readFile(path.join(workspaceRoot, started.feedbackFile as string), 'utf8');
    const staleSection = feedbackItemSection(report, 'F1');
    const validSection = feedbackItemSection(report, 'F2');
    expect(staleSection).toContain('"resolution":"degraded"');
    expect(staleSection).toContain('"reason":"stale-locator"');
    expect(staleSection).not.toContain('"kind":"rendered-range","value"');
    expect(validSection).toContain('"kind":"rendered-range"');
    expect(validSection).toContain('**Target:** Selected rendered text · exact');
  });

  it('revalidates every table-cell locator at Finish', async () => {
    await writeFile(sourcePath, TABLE_SOURCE_TEXT);
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, TABLE_SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.start',
        requestId: 'start-finish-cell-revalidation',
        blocks: TABLE_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const started = await waitForMessage(
      webview,
      'feedback.started',
      'start-finish-cell-revalidation'
    );
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-finish-cell-revalidation',
        sessionId: started.sessionId,
        startOrdinal: 0,
        endOrdinal: 0,
        feedback: 'This cell locator will become stale.',
        ...v2TableCellSelection(TABLE_CELL_TARGET_INPUT),
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await waitForMessage(webview, 'feedback.updated', 'add-finish-cell-revalidation');

    const session = internals(provider).feedbackSessions.get(
      document.uri.toString()
    ) as unknown as {
      canonicalBlocks: Map<number, { sha256: string }>;
    };
    session.canonicalBlocks.get(0)!.sha256 = 'e'.repeat(64);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.finish',
        requestId: 'finish-cell-revalidation',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await waitForMessage(webview, 'feedback.finished', 'finish-cell-revalidation');

    const report = await readFile(path.join(workspaceRoot, started.feedbackFile as string), 'utf8');
    const section = feedbackItemSection(report, 'F1');
    expect(section).toContain('"resolution":"degraded"');
    expect(section).toContain('"reason":"stale-locator"');
    expect(section).not.toContain('"kind":"table-cells","value"');
    expect(section).toContain('**Source lines:** 1-3');
  });

  it('degrades a restored exact cell locator after its enclosing block span is proven', async () => {
    await writeFile(sourcePath, TABLE_SOURCE_TEXT);
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, TABLE_SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      webview as unknown as vscode.Webview
    );
    internals(provider).handleWebviewMessage(
      { type: 'feedback.start', requestId: 'start-table-degrade', blocks: TABLE_BLOCKS },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const started = await waitForMessage(webview, 'feedback.started', 'start-table-degrade');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-table-degrade',
        sessionId: started.sessionId,
        startOrdinal: 0,
        endOrdinal: 0,
        feedback: 'Keep the line anchor.',
        ...v2TableCellSelection({
          ...TABLE_CELL_TARGET_INPUT,
          rectangle: { top: 0, left: 0, bottom: 1, right: 1 },
        }),
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await waitForMessage(webview, 'feedback.updated', 'add-table-degrade');

    const session = internals(provider).feedbackSessions.get(
      document.uri.toString()
    ) as unknown as {
      canonicalBlocks: Map<number, { sha256: string; tableFingerprint?: string }>;
      targets: Map<string, { startOrdinal: number; endOrdinal: number }>;
      degradedCellTargetIds: Set<string>;
    };
    session.canonicalBlocks.get(0)!.tableFingerprint = 'md4h-table/v1:fedcba9876543210';
    session.targets.clear();
    session.degradedCellTargetIds.clear();
    (
      provider as unknown as { restoreFeedbackTargets(value: unknown): void }
    ).restoreFeedbackTargets(session);

    expect(session.degradedCellTargetIds).toEqual(new Set(['F1']));
    expect(
      internals(provider).feedbackItems(session, webview as unknown as vscode.Webview)
    ).toEqual([expect.not.objectContaining({ cellTarget: expect.anything() })]);
    (
      provider as unknown as {
        postDegradedFeedbackRangeWarning(value: unknown, target: vscode.Webview): void;
      }
    ).postDegradedFeedbackRangeWarning(session, webview as unknown as vscode.Webview);
    expect(messagesOfType(webview, 'feedback.error').at(-1)).toEqual(
      expect.objectContaining({
        code: 'MD4H-FB-ANCHOR-001',
        message: expect.stringMatching(/F1.*block markers/i),
        recoverable: true,
      })
    );
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

  it("uses the containing workspace root and that source resource's handoff template", async () => {
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
      (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(
        (section: string, resource?: vscode.Uri) => ({
          get: jest.fn((key: string, defaultValue?: unknown) => {
            if (section !== 'markdownForHumans.feedback' || key !== 'handoffPromptTemplate') {
              return defaultValue;
            }
            return resource?.fsPath.startsWith(secondWorkspaceRoot + path.sep)
              ? 'Second root: {{feedbackFile}} for {{source}}.'
              : 'First root: {{feedbackFile}}.';
          }),
          update: jest.fn(),
        })
      );
      const writeText = jest.fn(async () => undefined);
      (vscode.env as unknown as { clipboard: { writeText: typeof writeText } }).clipboard = {
        writeText,
      };

      const provider = createProvider(workspaceRoot);
      const document = createDocument(secondSourcePath, SOURCE_TEXT);
      const webview = createWebview(provider, document);
      const started = await startAndAddTextFeedback(provider, document, webview);
      const relativeFeedbackFile = started.feedbackFile as string;
      expect(relativeFeedbackFile).toMatch(
        /^\.md4h\/feedback\/docs\/guide\.md--\d{8}T\d{6}Z-[a-z0-9]{4}\/feedback\.md$/
      );
      await expect(pathExists(path.join(secondWorkspaceRoot, relativeFeedbackFile))).resolves.toBe(
        true
      );
      await expect(pathExists(path.join(workspaceRoot, relativeFeedbackFile))).resolves.toBe(false);

      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.finish',
          requestId: 'finish-second-root',
          sessionId: started.sessionId,
        },
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      const finished = await waitForMessage(webview, 'feedback.finished', 'finish-second-root');
      const expectedPrompt = `Second root: \`${relativeFeedbackFile}\` for \`docs/guide.md\`.`;
      expect(finished).toEqual(
        expect.objectContaining({ prompt: expectedPrompt, promptCopied: true })
      );
      expect(writeText).toHaveBeenCalledWith(expectedPrompt);
      expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith(
        'markdownForHumans.feedback',
        document.uri
      );
    } finally {
      await rm(secondWorkspaceRoot, { recursive: true, force: true });
    }
  });

  it('serializes rapid Start requests and turns the second request into Resume', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);

    sendStart(provider, document, webview, 'start-first');
    sendStart(provider, document, webview, 'start-second');

    await waitForMessage(webview, 'feedback.started', 'start-first');
    await expect(
      waitForMessage(webview, 'feedback.resume.available', 'start-second')
    ).resolves.toEqual(
      expect.objectContaining({
        kind: 'active-owner',
        drafts: [expect.objectContaining({ itemCount: 0 })],
      })
    );
    expect(messagesOfType(webview, 'feedback.error')).toHaveLength(0);
    const sourceFeedbackDirectory = path.join(workspaceRoot, '.md4h', 'feedback', 'docs');
    expect(await readdir(sourceFeedbackDirectory)).toHaveLength(1);
  });

  it('offers and rehydrates a same-owner session when Start is retried after UI state loss', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);
    const originalSession = internals(provider).feedbackSessions.get(document.uri.toString());

    sendStart(provider, document, webview, 'start-after-ui-reset');

    const offer = await waitForMessage(
      webview,
      'feedback.resume.available',
      'start-after-ui-reset'
    );
    expect(offer).toEqual({
      type: 'feedback.resume.available',
      requestId: 'start-after-ui-reset',
      kind: 'active-owner',
      drafts: [
        expect.objectContaining({
          round: started.round,
          itemCount: 1,
          feedbackFile: started.feedbackFile,
        }),
      ],
    });
    expect(JSON.stringify(offer)).not.toContain('Make this explanation more concrete.');
    expect(messagesOfType(webview, 'feedback.error')).toHaveLength(0);
    expect(internals(provider).feedbackSessions.get(document.uri.toString())).toBe(originalSession);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-after-ui-reset',
        round: started.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const apply = await waitForSessionTransferPhase(
      webview,
      'apply',
      'same-owner',
      'resume-after-ui-reset'
    );
    await waitForSessionTransferPhase(webview, 'commit', 'same-owner', 'resume-after-ui-reset');
    await waitUntil(
      () => internals(provider).feedbackSessions.get(document.uri.toString())?.phase === 'active'
    );
    expect(apply.session).toEqual(
      expect.objectContaining({
        round: started.round,
        items: [expect.objectContaining({ id: 'F1' })],
      })
    );
    const resumedSessionId = apply.newSessionId as string;
    expect(resumedSessionId).not.toBe(started.sessionId);
    expect(internals(provider).feedbackSessions.size).toBe(1);
    expect(await readdir(path.join(workspaceRoot, '.md4h', 'feedback', 'docs'))).toHaveLength(1);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-with-retired-runtime',
        sessionId: started.sessionId,
        startOrdinal: 1,
        endOrdinal: 1,
        focus: 'Paragraph.',
        feedback: 'This stale write must fail.',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await expect(
      waitForMessage(webview, 'feedback.error', 'add-with-retired-runtime')
    ).resolves.toEqual(
      expect.objectContaining({ message: expect.stringMatching(/no longer active/i) })
    );

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-with-rehydrated-runtime',
        sessionId: resumedSessionId,
        startOrdinal: 1,
        endOrdinal: 1,
        feedback: 'Keep the recovered session writable.',
        target: { version: 2, requestedScope: 'blocks' },
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await expect(
      waitForMessage(webview, 'feedback.updated', 'add-with-rehydrated-runtime')
    ).resolves.toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ id: 'F1' }), expect.objectContaining({ id: 'F2' })],
      })
    );
  });

  it('offers an exact saved draft from Start and creates a new round only on explicit bypass', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);
    internals(provider).releaseFeedbackStateForWebview(
      document.uri.toString(),
      webview as unknown as vscode.Webview,
      document as unknown as vscode.TextDocument
    );

    sendStart(provider, document, webview, 'start-with-saved-draft');
    const offer = await waitForMessage(
      webview,
      'feedback.resume.available',
      'start-with-saved-draft'
    );
    expect(offer).toEqual(
      expect.objectContaining({
        kind: 'saved-draft',
        drafts: [expect.objectContaining({ round: started.round, itemCount: 1 })],
      })
    );
    expect(messagesOfType(webview, 'feedback.started')).toHaveLength(1);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.start.new',
        requestId: 'start-explicit-new-round',
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const newRound = await waitForMessage(webview, 'feedback.started', 'start-explicit-new-round');
    expect(newRound.round).not.toBe(started.round);
    expect(await readdir(path.join(workspaceRoot, '.md4h', 'feedback', 'docs'))).toHaveLength(2);
  });

  it('does not transfer a live peer session until Resume is explicitly confirmed', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const owner = createWebview(provider, document);
    const peer = createWebview(provider, document);
    sendStart(provider, document, owner, 'start-owner-before-peer-recovery');
    const started = await waitForMessage(
      owner,
      'feedback.started',
      'start-owner-before-peer-recovery'
    );
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      peer as unknown as vscode.Webview
    );

    sendStart(provider, document, peer, 'start-from-live-peer');
    await expect(
      waitForMessage(peer, 'feedback.resume.available', 'start-from-live-peer')
    ).resolves.toEqual(expect.objectContaining({ kind: 'active-peer' }));
    const beforeResume = internals(provider).feedbackSessions.get(document.uri.toString());
    expect(beforeResume?.ownerWebview).toBe(owner);
    expect(beforeResume?.sessionId).toBe(started.sessionId);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-in-peer',
        round: started.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      peer as unknown as vscode.Webview
    );
    const incomingApply = await waitForSessionTransferPhase(
      peer,
      'apply',
      'new-owner',
      'resume-in-peer'
    );
    const outgoingApply = await waitForSessionTransferPhase(
      owner,
      'apply',
      'old-owner',
      'resume-in-peer'
    );
    const incomingCommit = await waitForSessionTransferPhase(
      peer,
      'commit',
      'new-owner',
      'resume-in-peer'
    );
    const outgoingCommit = await waitForSessionTransferPhase(
      owner,
      'commit',
      'old-owner',
      'resume-in-peer'
    );
    expect(internals(provider).feedbackSessions.get(document.uri.toString())?.ownerWebview).toBe(
      peer
    );
    const resumedSessionId = internals(provider).feedbackSessions.get(
      document.uri.toString()
    )?.sessionId;
    expect(resumedSessionId).toEqual(expect.any(String));
    expect(resumedSessionId).not.toBe(started.sessionId);
    expect(incomingApply).toEqual(
      expect.objectContaining({
        oldSessionId: started.sessionId,
        newSessionId: resumedSessionId,
        session: expect.objectContaining({ sessionId: resumedSessionId, round: started.round }),
      })
    );
    expect(outgoingApply.transferId).toBe(incomingApply.transferId);
    expect(incomingCommit.transferId).toBe(incomingApply.transferId);
    expect(outgoingCommit.transferId).toBe(incomingApply.transferId);
    const peerMessages = peer.postMessage.mock.calls.map(call => call[0] as FeedbackMessage);
    const applyIndex = peerMessages.findIndex(
      message =>
        message.type === 'feedback.session.transfer' &&
        message.requestId === 'resume-in-peer' &&
        message.phase === 'apply'
    );
    const commitIndex = peerMessages.findIndex(
      message =>
        message.type === 'feedback.session.transfer' &&
        message.requestId === 'resume-in-peer' &&
        message.phase === 'commit'
    );
    expect(applyIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(applyIndex);
    expect(messagesOfType(owner, 'feedback.session.transferred')).toHaveLength(0);
    expect(messagesOfType(peer, 'feedback.started')).toHaveLength(0);
  });

  it('keeps old ownership through rejected, stale, and dropped transfer ACKs, then accepts a delayed exact ACK once', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const owner = createWebview(provider, document, true, { transfer: false });
    const peer = createWebview(provider, document, true, { transfer: false });
    sendStart(provider, document, owner, 'start-before-delayed-transfer');
    const started = await waitForMessage(
      owner,
      'feedback.started',
      'start-before-delayed-transfer'
    );
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      peer as unknown as vscode.Webview
    );
    sendStart(provider, document, peer, 'offer-delayed-transfer');
    await waitForMessage(peer, 'feedback.resume.available', 'offer-delayed-transfer');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-delayed-transfer',
        round: started.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      peer as unknown as vscode.Webview
    );
    const incomingApply = await waitForSessionTransferPhase(
      peer,
      'apply',
      'new-owner',
      'resume-delayed-transfer'
    );
    expect(internals(provider).feedbackSessions.get(document.uri.toString())).toEqual(
      expect.objectContaining({
        ownerWebview: owner,
        sessionId: started.sessionId,
        phase: 'resuming',
      })
    );
    expect(messagesOfType(owner, 'feedback.session.transfer')).toHaveLength(0);

    acknowledgeFeedbackSessionTransfer(provider, document, peer, incomingApply, false);
    acknowledgeFeedbackSessionTransfer(provider, document, peer, {
      ...incomingApply,
      revision: (incomingApply.revision as number) + 1,
    });
    acknowledgeFeedbackSessionTransfer(provider, document, peer, {
      ...incomingApply,
      viewGeneration: 'view-stale',
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(messagesOfType(owner, 'feedback.session.transfer')).toHaveLength(0);
    expect(internals(provider).feedbackSessions.get(document.uri.toString())?.ownerWebview).toBe(
      owner
    );

    acknowledgeFeedbackSessionTransfer(provider, document, peer, incomingApply);
    acknowledgeFeedbackSessionTransfer(provider, document, peer, incomingApply);
    const outgoingApply = await waitForSessionTransferPhase(
      owner,
      'apply',
      'old-owner',
      'resume-delayed-transfer'
    );
    expect(internals(provider).feedbackSessions.get(document.uri.toString())?.ownerWebview).toBe(
      owner
    );

    acknowledgeFeedbackSessionTransfer(provider, document, owner, outgoingApply);
    const incomingCommit = await waitForSessionTransferPhase(
      peer,
      'commit',
      'new-owner',
      'resume-delayed-transfer'
    );
    const outgoingCommit = await waitForSessionTransferPhase(
      owner,
      'commit',
      'old-owner',
      'resume-delayed-transfer'
    );
    expect(internals(provider).feedbackSessions.get(document.uri.toString())).toEqual(
      expect.objectContaining({ ownerWebview: peer, phase: 'resuming' })
    );

    acknowledgeFeedbackSessionTransfer(provider, document, peer, incomingCommit);
    acknowledgeFeedbackSessionTransfer(provider, document, peer, incomingCommit);
    acknowledgeFeedbackSessionTransfer(provider, document, owner, outgoingCommit);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(internals(provider).feedbackSessions.get(document.uri.toString())).toEqual(
      expect.objectContaining({ ownerWebview: peer, phase: 'active' })
    );
    expect(messagesOfType(owner, 'feedback.session.transferred')).toHaveLength(0);
  });

  it.each(['apply', 'commit'] as const)(
    'terminates the Resume request fail-closed after bounded %s delivery exhaustion',
    async failedPhase => {
      const provider = createProvider(workspaceRoot);
      const document = createDocument(sourcePath, SOURCE_TEXT);
      const owner = createWebview(provider, document, true, { transfer: false });
      const peer = createWebview(provider, document, true, { transfer: false });
      sendStart(provider, document, owner, `start-before-dropped-${failedPhase}`);
      const started = await waitForMessage(
        owner,
        'feedback.started',
        `start-before-dropped-${failedPhase}`
      );
      internals(provider).registerFeedbackWebview(
        document.uri.toString(),
        peer as unknown as vscode.Webview
      );
      sendStart(provider, document, peer, `offer-before-dropped-${failedPhase}`);
      await waitForMessage(
        peer,
        'feedback.resume.available',
        `offer-before-dropped-${failedPhase}`
      );
      if (failedPhase === 'apply') {
        installImmediateCriticalTransportFailure(provider, peer);
      }

      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.draft.resume',
          requestId: `resume-dropped-${failedPhase}`,
          round: started.round,
          blocks: START_BLOCKS,
        },
        document as unknown as vscode.TextDocument,
        peer as unknown as vscode.Webview
      );
      const incomingApply = await waitForSessionTransferPhase(
        peer,
        'apply',
        'new-owner',
        `resume-dropped-${failedPhase}`
      );
      if (failedPhase === 'commit') {
        acknowledgeFeedbackSessionTransfer(provider, document, peer, incomingApply);
        const outgoingApply = await waitForSessionTransferPhase(
          owner,
          'apply',
          'old-owner',
          `resume-dropped-${failedPhase}`
        );
        installImmediateCriticalTransportFailure(provider, peer);
        acknowledgeFeedbackSessionTransfer(provider, document, owner, outgoingApply);
        await waitForSessionTransferPhase(
          peer,
          'commit',
          'new-owner',
          `resume-dropped-${failedPhase}`
        );
      }

      await expect(
        waitForMessage(peer, 'feedback.error', `resume-dropped-${failedPhase}`)
      ).resolves.toEqual(expect.objectContaining({ recoverable: true }));
      expect(internals(provider).pendingFeedbackSessionTransfers.has(document.uri.toString())).toBe(
        true
      );
      expect(internals(provider).feedbackSessions.get(document.uri.toString())).toEqual(
        failedPhase === 'apply'
          ? expect.objectContaining({
              ownerWebview: owner,
              sessionId: started.sessionId,
              phase: 'resuming',
            })
          : expect.objectContaining({ ownerWebview: peer, phase: 'resuming' })
      );
      expect(messagesOfType(peer, 'feedback.peer.release')).toHaveLength(0);
      provider.dispose();
    }
  );

  it.each(['changed-source', 'revalidation-error'] as const)(
    'terminally rolls back a staged transfer after %s before commit',
    async failure => {
      const provider = createProvider(workspaceRoot);
      const document = createDocument(sourcePath, SOURCE_TEXT);
      const owner = createWebview(provider, document, true, { transfer: false });
      const peer = createWebview(provider, document, true, { transfer: false });
      sendStart(provider, document, owner, `start-before-${failure}`);
      const started = await waitForMessage(owner, 'feedback.started', `start-before-${failure}`);
      internals(provider).registerFeedbackWebview(
        document.uri.toString(),
        peer as unknown as vscode.Webview
      );
      sendStart(provider, document, peer, `offer-${failure}`);
      await waitForMessage(peer, 'feedback.resume.available', `offer-${failure}`);

      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.draft.resume',
          requestId: `resume-${failure}`,
          round: started.round,
          blocks: START_BLOCKS,
        },
        document as unknown as vscode.TextDocument,
        peer as unknown as vscode.Webview
      );
      const incomingApply = await waitForSessionTransferPhase(
        peer,
        'apply',
        'new-owner',
        `resume-${failure}`
      );
      acknowledgeFeedbackSessionTransfer(provider, document, peer, incomingApply);
      const outgoingApply = await waitForSessionTransferPhase(
        owner,
        'apply',
        'old-owner',
        `resume-${failure}`
      );
      if (failure === 'changed-source') {
        document.getText.mockReturnValue('# Changed while transferring\n');
      } else {
        jest
          .spyOn(
            provider as unknown as {
              assertFeedbackSourceSha256: (
                document: vscode.TextDocument,
                sourceSha256: string
              ) => Promise<void>;
            },
            'assertFeedbackSourceSha256'
          )
          .mockRejectedValueOnce(new Error('Injected transfer revalidation failure.'));
      }
      acknowledgeFeedbackSessionTransfer(provider, document, owner, outgoingApply);
      const incomingAbort = await waitForSessionTransferPhase(
        peer,
        'abort',
        'new-owner',
        `resume-${failure}`
      );
      const outgoingAbort = await waitForSessionTransferPhase(
        owner,
        'abort',
        'old-owner',
        `resume-${failure}`
      );
      acknowledgeFeedbackSessionTransfer(provider, document, peer, incomingAbort);
      acknowledgeFeedbackSessionTransfer(provider, document, owner, outgoingAbort);
      await waitUntil(
        () => !internals(provider).pendingFeedbackSessionTransfers.has(document.uri.toString())
      );

      expect(internals(provider).pendingFeedbackSessionTransfers.has(document.uri.toString())).toBe(
        false
      );
      expect(internals(provider).feedbackSessions.get(document.uri.toString())).toEqual(
        expect.objectContaining({
          ownerWebview: owner,
          sessionId: started.sessionId,
          phase: 'active',
        })
      );
      expect(messagesOfType(peer, 'feedback.session.transfer')).toHaveLength(2);
      expect(messagesOfType(owner, 'feedback.session.transfer')).toHaveLength(2);
    }
  );

  it('abandons a transfer to a definitively unavailable or disposed new owner without retiring the old owner', async () => {
    for (const outcome of ['unavailable', 'disposed'] as const) {
      const provider = createProvider(workspaceRoot);
      const document = createDocument(sourcePath, SOURCE_TEXT);
      const owner = createWebview(provider, document);
      const peer = createWebview(provider, document, true, { transfer: false });
      const basePeerPost = peer.postMessage.getMockImplementation();
      if (outcome === 'unavailable') {
        peer.postMessage.mockImplementation((message: FeedbackMessage) => {
          const result = basePeerPost?.(message) ?? Promise.resolve(true);
          return message.type === 'feedback.session.transfer' && message.phase === 'apply'
            ? Promise.resolve(false)
            : result;
        });
      }
      sendStart(provider, document, owner, `start-before-${outcome}-target`);
      const started = await waitForMessage(
        owner,
        'feedback.started',
        `start-before-${outcome}-target`
      );
      internals(provider).registerFeedbackWebview(
        document.uri.toString(),
        peer as unknown as vscode.Webview
      );
      sendStart(provider, document, peer, `offer-${outcome}-target`);
      await waitForMessage(peer, 'feedback.resume.available', `offer-${outcome}-target`);

      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.draft.resume',
          requestId: `resume-${outcome}-target`,
          round: started.round,
          blocks: START_BLOCKS,
        },
        document as unknown as vscode.TextDocument,
        peer as unknown as vscode.Webview
      );
      await waitForSessionTransferPhase(peer, 'apply', 'new-owner', `resume-${outcome}-target`);
      if (outcome === 'disposed') {
        internals(provider).unregisterFeedbackWebview(
          document.uri.toString(),
          peer as unknown as vscode.Webview
        );
      }

      await waitUntil(
        () => internals(provider).feedbackSessions.get(document.uri.toString())?.phase === 'active'
      );
      expect(internals(provider).feedbackSessions.get(document.uri.toString())).toEqual(
        expect.objectContaining({ ownerWebview: owner, sessionId: started.sessionId })
      );
      expect(messagesOfType(owner, 'feedback.session.transfer')).toHaveLength(0);
      expect(messagesOfType(owner, 'feedback.session.transferred')).toHaveLength(0);
      await rm(path.join(workspaceRoot, '.md4h'), { recursive: true, force: true });
    }
  });

  it('commits when the old renderer is definitively unavailable and rehydrates its next generation as a locked peer', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const owner = createWebview(provider, document, true, { transfer: false });
    const peer = createWebview(provider, document);
    const baseOwnerPost = owner.postMessage.getMockImplementation();
    owner.postMessage.mockImplementation((message: FeedbackMessage) => {
      const result = baseOwnerPost?.(message) ?? Promise.resolve(true);
      return message.type === 'feedback.session.transfer' &&
        message.phase === 'apply' &&
        message.role === 'old-owner'
        ? Promise.resolve(false)
        : result;
    });
    sendStart(provider, document, owner, 'start-before-hidden-old-owner');
    const started = await waitForMessage(
      owner,
      'feedback.started',
      'start-before-hidden-old-owner'
    );
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      peer as unknown as vscode.Webview
    );
    sendStart(provider, document, peer, 'offer-hidden-old-owner');
    await waitForMessage(peer, 'feedback.resume.available', 'offer-hidden-old-owner');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-hidden-old-owner',
        round: started.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      peer as unknown as vscode.Webview
    );
    await waitForSessionTransferPhase(owner, 'apply', 'old-owner', 'resume-hidden-old-owner');
    await waitUntil(
      () =>
        internals(provider).feedbackSessions.get(document.uri.toString())?.ownerWebview ===
          (peer as unknown as vscode.Webview) &&
        internals(provider).feedbackSessions.get(document.uri.toString())?.phase === 'active'
    );
    const transferred = internals(provider).feedbackSessions.get(document.uri.toString());
    expect(transferred?.sessionId).not.toBe(started.sessionId);
    expect(messagesOfType(owner, 'feedback.session.transferred')).toHaveLength(0);

    internals(provider).handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        feedbackSnapshotProtocolVersion: 0,
        viewGeneration: 'owner-recreated-after-transfer',
      },
      document as unknown as vscode.TextDocument,
      owner as unknown as vscode.Webview
    );
    await expect(
      waitForMessage(
        owner,
        'feedback.peer.lock.acquire',
        'feedback-peer-current-' + transferred?.sessionId
      )
    ).resolves.toEqual(
      expect.objectContaining({
        lockId: transferred?.sessionId,
        viewGeneration: 'owner-recreated-after-transfer',
      })
    );
    expect(messagesOfType(owner, 'update')).toContainEqual(
      expect.objectContaining({ content: SOURCE_TEXT })
    );
  });

  it('rolls back when the proposed owner renderer is replaced after staging apply', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const owner = createWebview(provider, document, true, { transfer: false });
    const peer = createWebview(provider, document, true, { transfer: false });
    sendStart(provider, document, owner, 'start-before-target-reload');
    const started = await waitForMessage(owner, 'feedback.started', 'start-before-target-reload');
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      peer as unknown as vscode.Webview
    );
    sendStart(provider, document, peer, 'offer-before-target-reload');
    await waitForMessage(peer, 'feedback.resume.available', 'offer-before-target-reload');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-before-target-reload',
        round: started.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      peer as unknown as vscode.Webview
    );
    const incomingApply = await waitForSessionTransferPhase(
      peer,
      'apply',
      'new-owner',
      'resume-before-target-reload'
    );
    acknowledgeFeedbackSessionTransfer(provider, document, peer, incomingApply);
    await waitForSessionTransferPhase(owner, 'apply', 'old-owner', 'resume-before-target-reload');

    internals(provider).handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        feedbackSnapshotProtocolVersion: 0,
        viewGeneration: 'peer-recreated-during-transfer',
      },
      document as unknown as vscode.TextDocument,
      peer as unknown as vscode.Webview
    );
    const outgoingAbort = await waitForSessionTransferPhase(
      owner,
      'abort',
      'old-owner',
      'resume-before-target-reload'
    );
    acknowledgeFeedbackSessionTransfer(provider, document, owner, outgoingAbort);
    await waitUntil(
      () => !internals(provider).pendingFeedbackSessionTransfers.has(document.uri.toString())
    );

    expect(internals(provider).feedbackSessions.get(document.uri.toString())).toEqual(
      expect.objectContaining({
        ownerWebview: owner,
        sessionId: started.sessionId,
        phase: 'active',
      })
    );
    await waitUntil(() =>
      messagesOfType(peer, 'feedback.peer.lock.acquire').some(
        message => message.viewGeneration === 'peer-recreated-during-transfer'
      )
    );
    expect(messagesOfType(peer, 'feedback.peer.lock.acquire')).toContainEqual(
      expect.objectContaining({
        lockId: started.sessionId,
        viewGeneration: 'peer-recreated-during-transfer',
      })
    );
  });

  it('does not start a competing owner release when the old owner is disposed mid-transfer', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const owner = createWebview(provider, document, true, { transfer: false });
    const peer = createWebview(provider, document, true, { transfer: false });
    sendStart(provider, document, owner, 'start-before-old-owner-disposal');
    const started = await waitForMessage(
      owner,
      'feedback.started',
      'start-before-old-owner-disposal'
    );
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      peer as unknown as vscode.Webview
    );
    sendStart(provider, document, peer, 'offer-before-old-owner-disposal');
    await waitForMessage(peer, 'feedback.resume.available', 'offer-before-old-owner-disposal');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-before-old-owner-disposal',
        round: started.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      peer as unknown as vscode.Webview
    );
    const incomingApply = await waitForSessionTransferPhase(
      peer,
      'apply',
      'new-owner',
      'resume-before-old-owner-disposal'
    );
    acknowledgeFeedbackSessionTransfer(provider, document, peer, incomingApply);
    await waitForSessionTransferPhase(
      owner,
      'apply',
      'old-owner',
      'resume-before-old-owner-disposal'
    );

    internals(provider).unregisterFeedbackWebview(
      document.uri.toString(),
      owner as unknown as vscode.Webview
    );
    internals(provider).releaseFeedbackStateForWebview(
      document.uri.toString(),
      owner as unknown as vscode.Webview,
      document as unknown as vscode.TextDocument
    );
    const incomingCommit = await waitForSessionTransferPhase(
      peer,
      'commit',
      'new-owner',
      'resume-before-old-owner-disposal'
    );
    acknowledgeFeedbackSessionTransfer(provider, document, peer, incomingCommit);
    await waitUntil(
      () =>
        internals(provider).feedbackSessions.get(document.uri.toString())?.ownerWebview ===
          (peer as unknown as vscode.Webview) &&
        internals(provider).feedbackSessions.get(document.uri.toString())?.phase === 'active'
    );

    expect(messagesOfType(peer, 'feedback.peer.release')).toHaveLength(0);
  });

  it('requires a fresh active-peer offer before a stale draft action can transfer ownership', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const owner = createWebview(provider, document);
    const peer = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, owner);
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      peer as unknown as vscode.Webview
    );

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-from-stale-saved-banner',
        round: started.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      peer as unknown as vscode.Webview
    );

    await expect(
      waitForMessage(peer, 'feedback.resume.available', 'resume-from-stale-saved-banner')
    ).resolves.toEqual(expect.objectContaining({ kind: 'active-peer' }));
    expect(internals(provider).feedbackSessions.get(document.uri.toString())?.ownerWebview).toBe(
      owner
    );
    expect(messagesOfType(peer, 'feedback.started')).toHaveLength(0);
    expect(messagesOfType(owner, 'feedback.session.transferred')).toHaveLength(0);
  });

  it('releases a non-resumable same-owner session before handling Start again', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);
    const session = internals(provider).feedbackSessions.get(document.uri.toString());
    if (!session) throw new Error('Expected an active feedback session.');
    session.invalidated = true;

    sendStart(provider, document, webview, 'start-after-invalidated-ui-loss');

    await expect(
      waitForMessage(webview, 'feedback.resume.available', 'start-after-invalidated-ui-loss')
    ).resolves.toEqual(
      expect.objectContaining({
        kind: 'saved-draft',
        drafts: [expect.objectContaining({ round: started.round, itemCount: 1 })],
      })
    );
    expect(internals(provider).feedbackSessions.size).toBe(0);
    expect(messagesOfType(webview, 'feedback.error')).toHaveLength(0);
  });

  it('does not resurrect active ownership when the session changes during rehydration', async () => {
    const provider = createProvider(workspaceRoot);
    const providerState = internals(provider) as ProviderInternals & {
      assertFeedbackSourceSha256: (
        document: vscode.TextDocument,
        expectedSha256: string
      ) => Promise<void>;
    };
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);
    sendStart(provider, document, webview, 'offer-before-session-race');
    await waitForMessage(webview, 'feedback.resume.available', 'offer-before-session-race');

    const originalAssert = providerState.assertFeedbackSourceSha256.bind(provider);
    providerState.assertFeedbackSourceSha256 = async (targetDocument, expectedSha256) => {
      await originalAssert(targetDocument, expectedSha256);
      providerState.feedbackSessions.delete(document.uri.toString());
    };
    providerState.handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-after-session-race',
        round: started.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await expect(
      waitForMessage(webview, 'feedback.error', 'resume-after-session-race')
    ).resolves.toEqual(expect.objectContaining({ message: expect.stringMatching(/changed/i) }));
    expect(providerState.feedbackSessions.size).toBe(0);
    expect(
      messagesOfType(webview, 'feedback.started').filter(
        message => message.requestId === 'resume-after-session-race'
      )
    ).toHaveLength(0);
  });

  it('releases same-owner runtime state when Resume discovers a delayed source change', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);
    sendStart(provider, document, webview, 'offer-before-delayed-source-change');
    await waitForMessage(
      webview,
      'feedback.resume.available',
      'offer-before-delayed-source-change'
    );
    await writeFile(sourcePath, '# Guide\n\nChanged outside VS Code.\n', 'utf8');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-after-delayed-source-change',
        round: started.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await expect(
      waitForMessage(webview, 'feedback.error', 'resume-after-delayed-source-change')
    ).resolves.toEqual(
      expect.objectContaining({
        code: 'MD4H-FB-SNAPSHOT-001',
        message: expect.stringMatching(/source changed/i),
      })
    );
    expect(internals(provider).feedbackSessions.size).toBe(0);
    expect(messagesOfType(webview, 'update')).toContainEqual(
      expect.objectContaining({ type: 'update', force: true })
    );
  });

  it('restores an active owner after authoritative content reaches its recreated controller', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const peer = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);
    const activeSession = internals(provider).feedbackSessions.get(document.uri.toString());
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      webview as unknown as vscode.Webview
    );
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      peer as unknown as vscode.Webview
    );
    webview.postMessage.mockClear();
    peer.postMessage.mockClear();
    const automaticPostMessage = webview.postMessage.getMockImplementation();

    internals(provider).handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        viewGeneration: 'restored-owner-generation',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      const automaticResult = automaticPostMessage?.(message) ?? Promise.resolve(true);
      if (message.type === 'feedback.delivery') {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            {
              type: 'feedback.delivery.ack',
              protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
              messageId: message.messageId,
              operationEpoch: message.operationEpoch,
              sessionEpoch: message.sessionEpoch,
              stageRevision: message.stageRevision,
              outcome: { kind: 'applied', value: { messageType: 'feedback.started' } },
            },
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      return automaticResult;
    });
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.controller.ready',
        requestId: 'feedback-controller-restored-owner',
        viewGeneration: 'restored-owner-generation',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const delivery = await waitForMessage(webview, 'feedback.delivery');
    await waitUntil(
      () => internals(provider).feedbackSessions.get(document.uri.toString()) === activeSession
    );
    expect(delivery).toEqual(
      expect.objectContaining({
        operationEpoch: 'feedback-controller-restored-owner',
        sessionEpoch: started.sessionId,
        payload: expect.objectContaining({
          type: 'feedback.started',
          requestId: 'feedback-controller-restored-owner',
          sessionId: started.sessionId,
          items: [expect.objectContaining({ id: 'F1' })],
        }),
      })
    );
    expect(messagesOfType(webview, 'feedback.peer.locked')).toContainEqual(
      expect.objectContaining({
        lockId: started.sessionId,
        message: expect.stringMatching(/restor/i),
      })
    );
    expect(messagesOfType(webview, 'feedback.peer.unlocked')).toHaveLength(0);
    expect(messagesOfType(webview, 'feedback.drafts.available')).toHaveLength(0);
    const ownerMessages = webview.postMessage.mock.calls.map(call => call[0] as FeedbackMessage);
    const ownerLockIndex = ownerMessages.findIndex(
      message => message.type === 'feedback.peer.locked' && message.lockId === started.sessionId
    );
    const ownerUpdateIndex = ownerMessages.findIndex(
      message => message.type === 'update' && message.force === true
    );
    const ownerDeliveryIndex = ownerMessages.findIndex(
      message => message.type === 'feedback.delivery'
    );
    expect(ownerLockIndex).toBeGreaterThanOrEqual(0);
    expect(ownerUpdateIndex).toBeGreaterThan(ownerLockIndex);
    expect(ownerDeliveryIndex).toBeGreaterThan(ownerUpdateIndex);
    expect(messagesOfType(peer, 'feedback.peer.unlocked')).toHaveLength(0);
  });

  it('ignores a stale controller generation without reactivating or demoting the owner', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    await startAndAddTextFeedback(provider, document, webview);
    const activeSession = internals(provider).feedbackSessions.get(document.uri.toString());
    webview.postMessage.mockClear();

    internals(provider).handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        viewGeneration: 'current-owner-generation',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.controller.ready',
        requestId: 'feedback-controller-stale-owner',
        viewGeneration: 'stale-owner-generation',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(internals(provider).feedbackSessions.get(document.uri.toString())).toBe(activeSession);
    expect(messagesOfType(webview, 'feedback.delivery')).toHaveLength(0);
    expect(messagesOfType(webview, 'feedback.error')).toHaveLength(0);
    expect(messagesOfType(webview, 'feedback.peer.unlocked')).toHaveLength(0);
  });

  it('demotes safely when the recreated controller rejects active restoration', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);
    const automaticPostMessage = webview.postMessage.getMockImplementation();
    webview.postMessage.mockClear();

    internals(provider).handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        viewGeneration: 'rejected-restore-generation',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      const automaticResult = automaticPostMessage?.(message) ?? Promise.resolve(true);
      if (message.type === 'feedback.delivery') {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            {
              type: 'feedback.delivery.ack',
              protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
              messageId: message.messageId,
              operationEpoch: message.operationEpoch,
              sessionEpoch: message.sessionEpoch,
              stageRevision: message.stageRevision,
              outcome: { kind: 'rejected', code: 'renderer-apply-failed' },
            },
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      return automaticResult;
    });
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.controller.ready',
        requestId: 'feedback-controller-rejected-restore',
        viewGeneration: 'rejected-restore-generation',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const error = await waitForMessage(
      webview,
      'feedback.error',
      'feedback-controller-rejected-restore'
    );
    await waitUntil(() => internals(provider).feedbackSessions.size === 0);
    expect(error.message).toMatch(/did not confirm|draft was saved/i);
    const messages = webview.postMessage.mock.calls.map(call => call[0] as FeedbackMessage);
    const applyIndex = messages.findIndex(
      message =>
        message.type === 'feedback.peer.release' &&
        message.phase === 'apply' &&
        message.lockId === started.sessionId
    );
    const commitIndex = messages.findIndex(
      message =>
        message.type === 'feedback.peer.release' &&
        message.phase === 'commit' &&
        message.lockId === started.sessionId
    );
    expect(applyIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(applyIndex);
    await expect(pathExists(path.join(workspaceRoot, '.md4h', 'feedback'))).resolves.toBe(true);
  });

  it('demotes to the durable draft if active restoration detects a changed source', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const peer = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      peer as unknown as vscode.Webview
    );
    webview.postMessage.mockClear();
    peer.postMessage.mockClear();

    internals(provider).handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        viewGeneration: 'changed-source-generation',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await writeFile(sourcePath, '# Guide\n\nChanged externally.\n', 'utf8');
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.controller.ready',
        requestId: 'feedback-controller-changed-source',
        viewGeneration: 'changed-source-generation',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const error = await waitForMessage(
      webview,
      'feedback.error',
      'feedback-controller-changed-source'
    );
    await waitUntil(() => internals(provider).feedbackSessions.size === 0);
    expect(error).toEqual(
      expect.objectContaining({
        code: 'MD4H-FB-SNAPSHOT-001',
        message: expect.stringMatching(/source changed/i),
        recoverable: true,
      })
    );
    expect(messagesOfType(webview, 'feedback.delivery')).toHaveLength(0);
    expect(messagesOfType(webview, 'feedback.peer.release')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'apply', lockId: started.sessionId }),
        expect.objectContaining({ phase: 'commit', lockId: started.sessionId }),
      ])
    );
    expectPeerUpdateBeforeUnlock(peer, started.sessionId as string, SOURCE_TEXT);
    await expect(pathExists(path.join(workspaceRoot, '.md4h', 'feedback'))).resolves.toBe(true);
  });

  it('does not start restoration on ordinary controller startup without an active session', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);

    internals(provider).handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        feedbackDeliveryProtocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        viewGeneration: 'ordinary-controller-generation',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.controller.ready',
        requestId: 'feedback-controller-ordinary',
        viewGeneration: 'ordinary-controller-generation',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(internals(provider).feedbackSessions.size).toBe(0);
    expect(messagesOfType(webview, 'feedback.delivery')).toHaveLength(0);
    expect(messagesOfType(webview, 'feedback.peer.locked')).toHaveLength(0);
    expect(messagesOfType(webview, 'feedback.error')).toHaveLength(0);
  });

  it('finishes an in-flight Start as a resumable draft when its controller reloads', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document, false);
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      webview as unknown as vscode.Webview
    );

    sendStart(provider, document, webview, 'start-before-controller-reload');
    await waitUntil(() => internals(provider).feedbackTransitions.size === 1);
    const flush = await waitForMessage(webview, 'flushPendingEdit');
    if (!flush || typeof flush.requestId !== 'string') {
      throw new Error('Expected the pending Feedback flush request.');
    }

    internals(provider).handleWebviewMessage(
      { type: 'ready' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    internals(provider).handleWebviewMessage(
      createFlushAcknowledgement(flush, true),
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    await waitUntil(() => messagesOfType(webview, 'feedback.drafts.available').length > 0);
    expect(internals(provider).feedbackSessions.size).toBe(0);
    expect(internals(provider).feedbackTransitions.size).toBe(0);
    webview.postMessage.mockImplementation((message: FeedbackMessage) => {
      if (message.type === 'flushPendingEdit' && typeof message.requestId === 'string') {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            createFlushAcknowledgement(message, true),
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      if (message.type === 'feedback.peer.release') {
        queueMicrotask(() => acknowledgeFeedbackPeerRelease(provider, document, webview, message));
      }
      return Promise.resolve(true);
    });

    sendStart(provider, document, webview, 'start-after-controller-reload');
    await expect(
      waitForMessage(webview, 'feedback.resume.available', 'start-after-controller-reload')
    ).resolves.toEqual(expect.objectContaining({ kind: 'saved-draft' }));
    expect(
      messagesOfType(webview, 'feedback.error').filter(
        message => message.requestId === 'start-after-controller-reload'
      )
    ).toHaveLength(0);
  });

  it('keeps a closing session reserved until its durable operation settles on reload', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    await startAndAddTextFeedback(provider, document, webview);
    internals(provider).registerFeedbackWebview(
      document.uri.toString(),
      webview as unknown as vscode.Webview
    );
    const session = internals(provider).feedbackSessions.get(document.uri.toString());
    if (!session) throw new Error('Expected an active feedback session.');
    let settleClose!: () => void;
    session.phase = 'finishing';
    session.closeOperation = new Promise<void>(resolve => {
      settleClose = resolve;
    });

    internals(provider).handleWebviewMessage(
      { type: 'ready' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await Promise.resolve();
    expect(internals(provider).feedbackSessions.get(document.uri.toString())).toBe(session);

    settleClose();
    await waitUntil(() => internals(provider).feedbackSessions.size === 0);
    expect(messagesOfType(webview, 'update')).toContainEqual(
      expect.objectContaining({ type: 'update', force: true })
    );
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
    const originalAdd = store.addTextFeedbackV2.bind(store);
    store.addTextFeedbackV2 = (async (...args: Parameters<typeof originalAdd>) => {
      const [input, options] = args;
      expect(options?.beforeCommit).toEqual(expect.any(Function));
      let guardCalls = 0;
      return originalAdd(input, {
        ...options,
        beforeCommit: async () => {
          await options?.beforeCommit?.();
          guardCalls += 1;
          if (guardCalls === 1) {
            internals(provider).invalidateFeedbackSession(
              documentKey,
              webview as unknown as vscode.Webview
            );
          }
        },
      });
    }) as typeof store.addTextFeedbackV2;

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

  it('restores the exact locator-bearing draft when the second seal guard fails', async () => {
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
    const itemsBefore = store.items;
    const reportBefore = await readFile(store.feedbackFilePath);
    const originalSeal = store.seal.bind(store);
    store.seal = (async (bytes, sealedAt, optionsOrBeforeCommit) => {
      const options =
        typeof optionsOrBeforeCommit === 'function'
          ? { beforeCommit: optionsOrBeforeCommit }
          : optionsOrBeforeCommit;
      expect(options?.beforeCommit).toEqual(expect.any(Function));
      let guardCalls = 0;
      return originalSeal(bytes, sealedAt, {
        ...options,
        beforeCommit: async () => {
          await options?.beforeCommit?.();
          guardCalls += 1;
          if (guardCalls === 1) {
            internals(provider).invalidateFeedbackSession(
              documentKey,
              webview as unknown as vscode.Webview
            );
          }
        },
      });
    }) as typeof store.seal;

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.finish',
        requestId: 'finish-during-invalidation',
        sessionId: started.sessionId,
        degradedTargetIds: ['F1'],
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
    expect(store.items).toEqual(itemsBefore);
    expect(store.items[0]).toEqual(
      expect.objectContaining({
        target: expect.objectContaining({
          locator: expect.objectContaining({
            kind: 'rendered-range',
            value: expect.objectContaining(PARAGRAPH_RENDERED_RANGE_INPUT),
          }),
        }),
      })
    );
    await expect(readFile(store.feedbackFilePath)).resolves.toEqual(reportBefore);
    await expect(pathExists(`${store.feedbackFilePath}.lock`)).resolves.toBe(false);
  });

  it('strips only a renderer-reported rendered-range locator at the provider boundary', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-renderer-valid-range',
        sessionId: started.sessionId,
        startOrdinal: 0,
        endOrdinal: 0,
        focus: 'Guide',
        feedback: 'Keep this exact locator.',
        renderedRange: {
          version: 1,
          startOrdinal: 0,
          startOffset: 0,
          endOrdinal: 0,
          endOffset: 'Guide'.length,
        },
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await waitForMessage(webview, 'feedback.updated', 'add-renderer-valid-range');

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.finish',
        requestId: 'finish-renderer-range-degradation',
        sessionId: started.sessionId,
        degradedTargetIds: ['F1'],
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await waitForMessage(webview, 'feedback.finished', 'finish-renderer-range-degradation');

    const report = await readFile(path.join(workspaceRoot, started.feedbackFile as string), 'utf8');
    expect(feedbackItemSection(report, 'F1')).toContain('"resolution":"degraded"');
    expect(feedbackItemSection(report, 'F1')).toContain('"reason":"stale-locator"');
    expect(feedbackItemSection(report, 'F2')).toContain('"kind":"rendered-range"');
    expect(feedbackItemSection(report, 'F2')).toContain(
      '**Target:** Selected rendered text · exact'
    );
  });

  it('strips only a renderer-reported table-cell locator at the provider boundary', async () => {
    await writeFile(sourcePath, TABLE_SOURCE_TEXT);
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, TABLE_SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.start',
        requestId: 'start-renderer-cell-degradation',
        blocks: TABLE_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const started = await waitForMessage(
      webview,
      'feedback.started',
      'start-renderer-cell-degradation'
    );
    for (const [requestId, feedback] of [
      ['add-renderer-degraded-cell', 'Strip this exact cell locator.'],
      ['add-renderer-valid-cell', 'Keep this exact cell locator.'],
    ] as const) {
      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.text.add',
          requestId,
          sessionId: started.sessionId,
          startOrdinal: 0,
          endOrdinal: 0,
          feedback,
          ...v2TableCellSelection(TABLE_CELL_TARGET_INPUT),
        },
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      await waitForMessage(webview, 'feedback.updated', requestId);
    }

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.finish',
        requestId: 'finish-renderer-cell-degradation',
        sessionId: started.sessionId,
        degradedTargetIds: ['F1'],
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await waitForMessage(webview, 'feedback.finished', 'finish-renderer-cell-degradation');

    const report = await readFile(path.join(workspaceRoot, started.feedbackFile as string), 'utf8');
    expect(feedbackItemSection(report, 'F1')).toContain('"resolution":"degraded"');
    expect(feedbackItemSection(report, 'F1')).toContain('"reason":"stale-locator"');
    expect(feedbackItemSection(report, 'F2')).toContain('"kind":"table-cells"');
    expect(feedbackItemSection(report, 'F2')).toContain('**Target:** Selected table cells · exact');
  });

  it('rejects a renderer degradation claim for a locator-free item and preserves the draft', async () => {
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    sendStart(provider, document, webview, 'start-no-locator-degradation');
    const started = await waitForMessage(
      webview,
      'feedback.started',
      'start-no-locator-degradation'
    );
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.text.add',
        requestId: 'add-no-locator-degradation',
        sessionId: started.sessionId,
        startOrdinal: 1,
        endOrdinal: 1,
        feedback: 'Keep this whole-block feedback.',
        target: { version: 2, requestedScope: 'blocks' },
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await waitForMessage(webview, 'feedback.updated', 'add-no-locator-degradation');
    const session = internals(provider).feedbackSessions.get(document.uri.toString())!;
    const itemsBefore = session.store.items;
    const reportBefore = await readFile(session.store.feedbackFilePath);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.finish',
        requestId: 'finish-no-locator-degradation',
        sessionId: started.sessionId,
        degradedTargetIds: ['F1'],
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const error = await waitForMessage(webview, 'feedback.error', 'finish-no-locator-degradation');
    expect(error).toEqual(
      expect.objectContaining({
        code: 'MD4H-FB-ANCHOR-001',
        recoverable: true,
      })
    );
    expect(messagesOfType(webview, 'feedback.finished')).toHaveLength(0);
    expect(session.phase).toBe('active');
    expect(session.store.snapshot.state).toBe('draft');
    expect(session.store.items).toEqual(itemsBefore);
    await expect(readFile(session.store.feedbackFilePath)).resolves.toEqual(reportBefore);
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

  it('expands the resource-scoped handoff template with authoritative sealed metadata', async () => {
    const writeText = jest.fn(async () => undefined);
    (vscode.env as unknown as { clipboard: { writeText: typeof writeText } }).clipboard = {
      writeText,
    };
    const template =
      'Handle {{itemCount}} item from {{feedbackFile}} for {{source}}. Hash {{sourceSha256}}. Round {{round}}.';
    const getConfiguration = vscode.workspace.getConfiguration as jest.Mock;
    getConfiguration.mockImplementation((section: string, resource?: vscode.Uri) => ({
      get: jest.fn((key: string, defaultValue?: unknown) =>
        section === 'markdownForHumans.feedback' &&
        key === 'handoffPromptTemplate' &&
        resource?.toString() === fileUri(sourcePath).toString()
          ? template
          : defaultValue
      ),
      update: jest.fn(),
    }));
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.finish',
        requestId: 'finish-custom-template',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const finished = await waitForMessage(webview, 'feedback.finished', 'finish-custom-template');
    const expectedPrompt =
      `Handle 1 item from \`${started.feedbackFile as string}\` for \`docs/guide.md\`. ` +
      `Hash ${createHash('sha256').update(SOURCE_BYTES).digest('hex')}. Round ${started.round as string}.`;
    expect(finished).toEqual(
      expect.objectContaining({ prompt: expectedPrompt, promptCopied: true })
    );
    expect(writeText).toHaveBeenCalledWith(expectedPrompt);
    expect(getConfiguration).toHaveBeenCalledWith('markdownForHumans.feedback', document.uri);
  });

  it('falls back visibly to the built-in prompt when a custom template is invalid', async () => {
    const writeText = jest.fn(async () => undefined);
    (vscode.env as unknown as { clipboard: { writeText: typeof writeText } }).clipboard = {
      writeText,
    };
    (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(
      (section: string, resource?: vscode.Uri) => ({
        get: jest.fn((key: string, defaultValue?: unknown) =>
          section === 'markdownForHumans.feedback' &&
          key === 'handoffPromptTemplate' &&
          resource?.toString() === fileUri(sourcePath).toString()
            ? 'Handle {{source}} without locating the bundle.'
            : defaultValue
        ),
        update: jest.fn(),
      })
    );
    const showWarningMessage = vscode.window.showWarningMessage as jest.Mock;
    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    const started = await startAndAddTextFeedback(provider, document, webview);

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.finish',
        requestId: 'finish-invalid-template',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const finished = await waitForMessage(webview, 'feedback.finished', 'finish-invalid-template');
    const expectedDefault =
      `Implement the sealed feedback bundle at \`${started.feedbackFile as string}\`. ` +
      'First verify the source SHA-256. Inspect every referenced image. ' +
      'Edit the workspace files required by the feedback, but do not modify or delete the feedback bundle. ' +
      'Address every feedback ID, run appropriate checks, report the outcome per ID, ' +
      'and stop if the source hash differs.';
    expect(finished).toEqual(
      expect.objectContaining({ prompt: expectedDefault, promptCopied: true })
    );
    expect(writeText).toHaveBeenCalledWith(expectedDefault);
    await waitUntil(() => showWarningMessage.mock.calls.length > 0);
    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/prompt template.*invalid.*default prompt/i)
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

  it('keeps the original close reservation through a duplicate close and renderer reload', async () => {
    const writeText = jest.fn(async () => undefined);
    (vscode.env as unknown as { clipboard: { writeText: typeof writeText } }).clipboard = {
      writeText,
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
        requestId: 'finish-close-reservation',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await sealStarted;
    const originalCloseOperation = session!.closeOperation;
    expect(originalCloseOperation).toBeDefined();

    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.discard',
        requestId: 'duplicate-close-reservation',
        sessionId: started.sessionId,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await expect(
      waitForMessage(webview, 'feedback.error', 'duplicate-close-reservation')
    ).resolves.toEqual(expect.objectContaining({ recoverable: true }));
    expect(session!.closeOperation).toBe(originalCloseOperation);

    internals(provider).handleWebviewMessage(
      { type: 'ready' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(internals(provider).feedbackSessions.get(document.uri.toString())).toBe(session);
    expect(messagesOfType(webview, 'feedback.peer.release')).toHaveLength(0);

    releaseSeal();
    await expect(
      waitForMessage(webview, 'feedback.finished', 'finish-close-reservation')
    ).resolves.toEqual(expect.objectContaining({ promptCopied: true }));
    await waitUntil(() => internals(provider).feedbackSessions.size === 0);
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
    const originalAdd = store.addTextFeedbackV2.bind(store);
    let releaseAdd!: () => void;
    const addGate = new Promise<void>(resolve => {
      releaseAdd = resolve;
    });
    let announceAddStarted!: () => void;
    const addStarted = new Promise<void>(resolve => {
      announceAddStarted = resolve;
    });
    store.addTextFeedbackV2 = (async (...args: Parameters<typeof originalAdd>) => {
      announceAddStarted();
      await addGate;
      return originalAdd(...args);
    }) as typeof store.addTextFeedbackV2;

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

  it('resumes a v2 whole-block draft whose block span matches the line-mapped canonical block', async () => {
    const paragraphSpan = feedbackBlockSpanV2(1, 'paragraph', 'Paragraph.');
    const draft = await FeedbackSessionStore.create({
      workspaceRoot,
      sourcePath,
      sourceBytes: SOURCE_BYTES,
      schemaVersion: 2,
      now: new Date('2026-08-31T09:30:00.000Z'),
      roundSuffix: 'bv01',
    });
    await draft.addTextFeedbackV2({
      startLine: 3,
      endLine: 3,
      feedback: 'Keep this valid whole-block target.',
      target: {
        version: 2,
        requestedScope: 'blocks',
        effectiveScope: 'blocks',
        resolution: 'exact',
        blockSpan: paragraphSpan,
      },
      evidence: feedbackSourceEvidenceV2('Paragraph.', 'selected-blocks'),
    });

    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-valid-v2-block-span',
        round: draft.snapshot.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const resumed = await waitForOneOfMessages(
      webview,
      ['feedback.started', 'feedback.error'],
      'resume-valid-v2-block-span'
    );
    expect(resumed).toEqual(
      expect.objectContaining({
        type: 'feedback.started',
        items: [
          expect.objectContaining({ id: 'F1', startOrdinal: 1, endOrdinal: 1, kind: 'text' }),
        ],
      })
    );
    expect(messagesOfType(webview, 'feedback.error')).toHaveLength(0);
  });

  it('degrades a stale v2 rendered locator only after its enclosing block span is proven', async () => {
    const paragraphSpan = feedbackBlockSpanV2(1, 'paragraph', 'Paragraph.');
    const draft = await FeedbackSessionStore.create({
      workspaceRoot,
      sourcePath,
      sourceBytes: SOURCE_BYTES,
      schemaVersion: 2,
      now: new Date('2026-08-31T09:30:00.000Z'),
      roundSuffix: 'rv01',
    });
    await draft.addTextFeedbackV2({
      startLine: 3,
      endLine: 3,
      feedback: 'Preserve a safe block fallback for this stale locator.',
      target: {
        version: 2,
        requestedScope: 'rendered-text',
        effectiveScope: 'rendered-text',
        resolution: 'exact',
        blockSpan: paragraphSpan,
        locator: {
          kind: 'rendered-range',
          value: {
            version: 1,
            startOrdinal: 1,
            startOffset: 0,
            endOrdinal: 1,
            endOffset: 'Paragraph.'.length + 1,
            startBlockSha256: paragraphSpan.startBlockSha256,
            endBlockSha256: paragraphSpan.endBlockSha256,
          },
        },
      },
      evidence: {
        effective: {
          kind: 'rendered-text',
          fidelity: 'rendered-exact',
          text: 'Paragraph.',
          complete: true,
        },
      },
    });

    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-v2-stale-rendered-locator',
        round: draft.snapshot.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    const resumed = await waitForMessage(
      webview,
      'feedback.started',
      'resume-v2-stale-rendered-locator'
    );
    expect((resumed.items as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      'renderedRange'
    );
    await expect(waitForMessage(webview, 'feedback.error')).resolves.toEqual(
      expect.objectContaining({
        code: 'MD4H-FB-ANCHOR-001',
        message: expect.stringMatching(/F1.*block markers/i),
      })
    );
  });

  it.each([
    {
      label: 'whole-block SHA-256',
      fixture: 'whole-block',
      roundSuffix: 'bh01',
      mutate: (target: FeedbackTargetV2) => {
        target.blockSpan.startBlockSha256 = 'b'.repeat(64);
        target.blockSpan.endBlockSha256 = 'b'.repeat(64);
      },
    },
    {
      label: 'degraded Mermaid ordinal',
      fixture: 'degraded',
      roundSuffix: 'do01',
      mutate: (target: FeedbackTargetV2) => {
        target.blockSpan.startOrdinal = 0;
        target.blockSpan.endOrdinal = 0;
      },
    },
    {
      label: 'legacy-unknown SHA-256',
      fixture: 'legacy-unknown',
      roundSuffix: 'lh01',
      mutate: (target: FeedbackTargetV2) => {
        target.blockSpan.startBlockSha256 = 'c'.repeat(64);
        target.blockSpan.endBlockSha256 = 'c'.repeat(64);
      },
    },
    {
      label: 'visual block kind',
      fixture: 'visual',
      roundSuffix: 'vk01',
      mutate: (target: FeedbackTargetV2) => {
        target.blockSpan.startKind = 'heading';
        target.blockSpan.endKind = 'heading';
      },
      rewriteSummary: (summary: string) => summary.replace('Mermaid block 2', 'heading 2'),
    },
  ] as const)(
    'fails closed when a restored v2 item has a mismatched $label binding',
    async ({ fixture, roundSuffix, mutate, rewriteSummary }) => {
      const usesMermaidSource = fixture === 'degraded' || fixture === 'visual';
      const sourceText = usesMermaidSource ? MERMAID_SOURCE_TEXT : SOURCE_TEXT;
      const sourceBytes = Buffer.from(sourceText, 'utf8');
      const blocks = usesMermaidSource ? MERMAID_BLOCKS : START_BLOCKS;
      await writeFile(sourcePath, sourceBytes);
      const draft = await FeedbackSessionStore.create({
        workspaceRoot,
        sourcePath,
        sourceBytes,
        schemaVersion: 2,
        now: new Date('2026-08-31T09:30:00.000Z'),
        roundSuffix,
      });

      if (fixture === 'whole-block') {
        const blockSpan = feedbackBlockSpanV2(1, 'paragraph', 'Paragraph.');
        await draft.addTextFeedbackV2({
          startLine: 3,
          endLine: 3,
          feedback: 'Reject a forged whole-block binding.',
          target: {
            version: 2,
            requestedScope: 'blocks',
            effectiveScope: 'blocks',
            resolution: 'exact',
            blockSpan,
          },
          evidence: feedbackSourceEvidenceV2('Paragraph.', 'selected-blocks'),
        });
      } else if (fixture === 'degraded') {
        const mermaidMarkdown = MERMAID_BLOCKS[1].markdown;
        const blockSpan = feedbackBlockSpanV2(1, 'mermaid', mermaidMarkdown);
        await draft.addTextFeedbackV2({
          startLine: 3,
          endLine: 6,
          feedback: 'Reject a forged degraded binding.',
          target: {
            version: 2,
            requestedScope: 'visual-region',
            effectiveScope: 'blocks',
            resolution: 'degraded',
            coarsening: { reason: 'opaque-node', origin: 'renderer' },
            blockSpan,
          },
          evidence: {
            ...feedbackSourceEvidenceV2(mermaidMarkdown, 'containing-blocks'),
            original: {
              kind: 'semantic-text',
              fidelity: 'semantic-context',
              text: 'Draft to Review',
              complete: true,
              provenance: 'renderer-fallback',
            },
          },
        });
      } else if (fixture === 'legacy-unknown') {
        const blockSpan = feedbackBlockSpanV2(1, 'paragraph', 'Paragraph.');
        await draft.addTextFeedbackV2({
          startLine: 3,
          endLine: 3,
          feedback: 'Reject a forged migrated binding.',
          target: {
            version: 2,
            effectiveScope: 'blocks',
            resolution: 'legacy-unknown',
            legacyOrigin: 'v1-no-locator',
            blockSpan,
          },
          evidence: {
            ...feedbackSourceEvidenceV2('Paragraph.', 'containing-blocks'),
            original: {
              kind: 'legacy-focus',
              fidelity: 'legacy-unclassified',
              text: 'Paragraph.',
            },
          },
        });
      } else {
        const mermaidMarkdown = MERMAID_BLOCKS[1].markdown;
        const blockSpan = feedbackBlockSpanV2(1, 'mermaid', mermaidMarkdown);
        await draft.addScreenshotFeedbackV2({
          startLine: 3,
          endLine: 6,
          feedback: 'Reject a forged visual binding.',
          pngData: ONE_PIXEL_PNG_BASE64,
          target: {
            version: 2,
            requestedScope: 'visual-region',
            effectiveScope: 'visual-region',
            resolution: 'exact',
            blockSpan,
          },
          sourceReference: {
            relationship: 'containing-blocks',
            format: 'markdown',
            normalization: 'lf',
            sourceSliceSha256: createHash('sha256').update(mermaidMarkdown).digest('hex'),
          },
        });
      }

      const originalReport = await readFile(draft.feedbackFilePath, 'utf8');
      const tamperedReport = mutateFeedbackTargetV2(originalReport, 'F1', mutate, rewriteSummary);
      await writeFile(draft.feedbackFilePath, tamperedReport);

      const provider = createProvider(workspaceRoot);
      const document = createDocument(sourcePath, sourceText);
      const webview = createWebview(provider, document);
      const requestId = `resume-forged-${fixture}`;
      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.draft.resume',
          requestId,
          round: draft.snapshot.round,
          blocks,
        },
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );

      const outcome = await waitForOneOfMessages(
        webview,
        ['feedback.error', 'feedback.started'],
        requestId
      );
      expect(outcome).toEqual(
        expect.objectContaining({
          type: 'feedback.error',
          code: 'MD4H-FB-ANCHOR-001',
          message: expect.stringMatching(/F1.*block/i),
        })
      );
      expect(internals(provider).feedbackSessions.size).toBe(0);
      await expect(readFile(draft.feedbackFilePath, 'utf8')).resolves.toBe(tamperedReport);
    }
  );

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

  it('serializes simultaneous first mutations while atomically migrating one v1 draft', async () => {
    const paragraphHash = createHash('sha256').update('Paragraph.').digest('hex');
    const legacy = await FeedbackSessionStore.create({
      workspaceRoot,
      sourcePath,
      sourceBytes: SOURCE_BYTES,
      now: new Date('2026-08-21T09:30:00.000Z'),
      roundSuffix: 'cq01',
    });
    await legacy.addTextFeedback({
      startLine: 3,
      endLine: 3,
      focus: 'Paragraph.',
      feedback: 'Preserve this v1 item through the first concurrent writes.',
      renderedRange: {
        ...PARAGRAPH_RENDERED_RANGE_INPUT,
        version: 1,
        startBlockSha256: paragraphHash,
        endBlockSha256: paragraphHash,
      },
    });
    const v1Bytes = await readFile(legacy.feedbackFilePath);

    const provider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const webview = createWebview(provider, document);
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.draft.resume',
        requestId: 'resume-concurrent-v1',
        round: legacy.snapshot.round,
        blocks: START_BLOCKS,
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const resumed = await waitForMessage(webview, 'feedback.started', 'resume-concurrent-v1');
    await expect(readFile(legacy.feedbackFilePath)).resolves.toEqual(v1Bytes);

    for (const [requestId, ordinal, feedback] of [
      ['concurrent-v2-first', 0, 'Clarify the title.'],
      ['concurrent-v2-second', 1, 'Clarify the paragraph.'],
    ] as const) {
      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.text.add',
          requestId,
          sessionId: resumed.sessionId,
          startOrdinal: ordinal,
          endOrdinal: ordinal,
          feedback,
          target: { version: 2, requestedScope: 'blocks' },
        },
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
    }

    await Promise.all([
      waitForMessage(webview, 'feedback.updated', 'concurrent-v2-first'),
      waitForMessage(webview, 'feedback.updated', 'concurrent-v2-second'),
    ]);
    expect(messagesOfType(webview, 'feedback.error')).toHaveLength(0);
    const session = internals(provider).feedbackSessions.get(document.uri.toString())!;
    expect(session.store.schemaVersion).toBe(2);
    expect(session.store.items.map(item => item.id)).toEqual(['F1', 'F2', 'F3']);
    const report = await readFile(session.store.feedbackFilePath, 'utf8');
    expect(report).toContain('schema: md4h-feedback/v2');
    expect(report).toContain('next_id: F4');
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
      const tamperedReport = report.replace(metadataLine, tamper(metadataLine));
      await writeFile(
        draft.feedbackFilePath,
        _label === 'an out-of-bounds persisted offset'
          ? tamperedReport.replace(
              '**Target:** Exact rendered text · block 2 offsets 0-10',
              '**Target:** Exact rendered text · block 2 offsets 0-11'
            )
          : tamperedReport
      );

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

      internals(provider).handleWebviewMessage(
        {
          type: 'feedback.finish',
          requestId: 'finish-degraded-rendered-range',
          sessionId: resumed.sessionId,
        },
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      await waitForMessage(webview, 'feedback.finished', 'finish-degraded-rendered-range');
      const sealedReport = await readFile(draft.feedbackFilePath, 'utf8');
      expect(sealedReport).toContain('state: sealed');
      expect(sealedReport).not.toContain('md4h-rendered-range');
      expect(sealedReport).not.toContain('**Target:** Exact rendered text');
      expect(sealedReport).toContain('**Source lines:** 3');
      expect(sealedReport).toContain('Do not fuzzy match this.');
    }
  );

  it('refuses to resume a report whose line range is not an exact frozen block range', async () => {
    const firstProvider = createProvider(workspaceRoot);
    const document = createDocument(sourcePath, SOURCE_TEXT);
    const firstWebview = createWebview(firstProvider, document);
    const started = await startAndAddTextFeedback(firstProvider, document, firstWebview);
    const feedbackFile = path.join(workspaceRoot, started.feedbackFile as string);
    const report = await readFile(feedbackFile, 'utf8');
    await writeFile(feedbackFile, report.replace('**Source lines:** 3', '**Source lines:** 3-999'));

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
    expect(error.code).toBe('MD4H-FB-STORE-001');
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
              createFlushAcknowledgement(message, true),
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
      const ownerWebview = createWebview(provider, document, true, { release: false });
      const peerWebview = createWebview(provider, document, true, { release: false });
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
      const ownerRelease = await waitForMessage(ownerWebview, 'feedback.peer.release', requestId);
      const peerRelease = await waitForMessage(peerWebview, 'feedback.peer.release', requestId);
      expect(ownerRelease).toEqual(
        expect.objectContaining({ lockId: ownerLock.lockId, content: SOURCE_TEXT, revision: 1 })
      );
      expect(peerRelease).toEqual(
        expect.objectContaining({ lockId: ownerLock.lockId, content: SOURCE_TEXT, revision: 1 })
      );
      acknowledgeFeedbackPeerRelease(provider, document, ownerWebview, ownerRelease);
      expect(internals(provider).feedbackTransitions.size).toBe(1);
      expect(messagesOfType(peerWebview, 'feedback.peer.unlocked')).toHaveLength(0);
      acknowledgeFeedbackPeerRelease(provider, document, peerWebview, peerRelease);
      expect(internals(provider).feedbackTransitions.size).toBe(0);
      const ownerCommit = await waitForFeedbackPeerReleasePhase(ownerWebview, 'commit', requestId);
      const peerCommit = await waitForFeedbackPeerReleasePhase(peerWebview, 'commit', requestId);
      acknowledgeFeedbackPeerRelease(provider, document, ownerWebview, ownerCommit);
      acknowledgeFeedbackPeerRelease(provider, document, peerWebview, peerCommit);
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
    expect(resumeError.message).toMatch(/Start feedback again to Resume or recover the draft/i);
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
    expect(error.message).toMatch(/Start feedback to Resume or recover the current session/i);
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

function feedbackBlockSpanV2(
  ordinal: number,
  kind: FeedbackBlockKindV2,
  markdown: string
): FeedbackBlockSpanV2 {
  const sha256 = createHash('sha256').update(markdown).digest('hex');
  return {
    startOrdinal: ordinal,
    endOrdinal: ordinal,
    startKind: kind,
    endKind: kind,
    startBlockSha256: sha256,
    endBlockSha256: sha256,
  };
}

function feedbackSourceEvidenceV2(
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
      sourceSliceSha256: createHash('sha256').update(text).digest('hex'),
      availability: 'embedded',
      text,
      utf8Bytes: Buffer.byteLength(text, 'utf8'),
    },
  };
}

function mutateFeedbackTargetV2(
  report: string,
  id: string,
  mutate: (target: FeedbackTargetV2) => void,
  rewriteSummary?: (summary: string) => string
): string {
  const section = feedbackItemSection(report, id);
  const metadataLine = section.split('\n').find(line => line.startsWith('<!-- md4h-target-v2:'));
  if (metadataLine === undefined) throw new Error(`Missing v2 target metadata for ${id}.`);
  const payload = metadataLine.slice('<!-- md4h-target-v2:'.length, -' -->'.length);
  const target = JSON.parse(payload) as FeedbackTargetV2;
  mutate(target);
  let nextSection = section.replace(
    metadataLine,
    `<!-- md4h-target-v2:${JSON.stringify(target)} -->`
  );
  if (rewriteSummary !== undefined) {
    const summaryLine = nextSection.split('\n').find(line => line.startsWith('**Target:** '));
    if (summaryLine === undefined) throw new Error(`Missing visible target summary for ${id}.`);
    nextSection = nextSection.replace(summaryLine, rewriteSummary(summaryLine));
  }
  return report.replace(section, nextSection);
}

function feedbackItemSection(report: string, id: string): string {
  const marker = `## ${id} ·`;
  const start = report.indexOf(marker);
  if (start < 0) return '';
  const next = report.indexOf('\n## F', start + marker.length);
  return report.slice(start, next < 0 ? report.length : next);
}

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

function createWebview(
  provider: MarkdownEditorProvider,
  document: ReturnType<typeof createDocument>,
  acknowledgeFlush = true,
  automaticPeerAcknowledgements: {
    lock?: boolean;
    release?: boolean;
    transfer?: boolean;
  } = {}
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
            createFlushAcknowledgement(message, true),
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      if (
        automaticPeerAcknowledgements.lock !== false &&
        message.type === 'feedback.peer.lock.acquire'
      ) {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            {
              type: 'feedback.peer.lock.acquired',
              acquisitionId: message.acquisitionId,
              requestId: message.requestId,
              lockId: message.lockId,
              replacesLockId: message.replacesLockId,
              viewGeneration: message.viewGeneration,
              revision: message.revision,
            },
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      if (
        automaticPeerAcknowledgements.release !== false &&
        message.type === 'feedback.peer.release'
      ) {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            {
              type: 'feedback.peer.released',
              phase: message.phase,
              releaseId: message.releaseId,
              requestId: message.requestId,
              lockId: message.lockId,
              viewGeneration: message.viewGeneration,
              revision: message.revision,
              documentVersion: message.documentVersion,
              contentSha256: message.contentSha256,
            },
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        });
      }
      if (
        automaticPeerAcknowledgements.transfer !== false &&
        message.type === 'feedback.session.transfer'
      ) {
        queueMicrotask(() => {
          internals(provider).handleWebviewMessage(
            {
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
            },
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

function installImmediateCriticalTransportFailure(
  provider: MarkdownEditorProvider,
  webview: ReturnType<typeof createWebview>
): void {
  const transports = internals(provider).feedbackCriticalTransports;
  transports.get(webview as unknown as vscode.Webview)?.dispose();
  transports.set(
    webview as unknown as vscode.Webview,
    {
      dispose: jest.fn(),
      send: jest.fn(async (command: { payload: FeedbackMessage }) => {
        await webview.postMessage(command.payload);
        return { kind: 'status-unavailable' as const, attempts: 4 };
      }),
      acceptAcknowledgement: jest.fn(() => 'accepted'),
    } as unknown as { dispose(): void }
  );
}

function enableSnapshotProtocol(
  provider: MarkdownEditorProvider,
  document: ReturnType<typeof createDocument>,
  webview: ReturnType<typeof createWebview>,
  options: {
    viewGeneration: string;
    inspectContent: string;
    appliedContent?: string;
    dirty: boolean;
    blocks: Array<{ ordinal: number; kind: string; markdown: string; contentSize: number }>;
  }
): void {
  const basePostMessage = webview.postMessage.getMockImplementation();
  webview.postMessage.mockImplementation((message: FeedbackMessage) => {
    const result = basePostMessage?.(message) ?? Promise.resolve(true);
    if (
      (message.type === 'feedback.snapshot.inspect' ||
        message.type === 'feedback.snapshot.apply') &&
      typeof message.requestId === 'string' &&
      typeof message.operationId === 'string' &&
      typeof message.documentVersion === 'number'
    ) {
      queueMicrotask(() => {
        internals(provider).handleWebviewMessage(
          message.type === 'feedback.snapshot.inspect'
            ? {
                type: 'feedback.snapshot.report',
                protocolVersion: FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
                requestId: message.requestId,
                operationId: message.operationId,
                documentVersion: message.documentVersion,
                stage: 'inspect',
                viewGeneration: options.viewGeneration,
                localRevision: 4,
                dirty: options.dirty,
                content: options.inspectContent,
              }
            : {
                type: 'feedback.snapshot.report',
                protocolVersion: FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
                requestId: message.requestId,
                operationId: message.operationId,
                documentVersion: message.documentVersion,
                stage: 'applied',
                viewGeneration: options.viewGeneration,
                localRevision: 5,
                dirty: false,
                content:
                  options.appliedContent ??
                  (typeof message.content === 'string' ? message.content : ''),
                canonicalDescriptorRevision: message.descriptorRevision,
                ...(message.includeCanonicalBlocks === true ? { blocks: options.blocks } : {}),
              },
          document as unknown as vscode.TextDocument,
          webview as unknown as vscode.Webview
        );
      });
    }
    return result;
  });

  internals(provider).handleWebviewMessage(
    {
      type: 'ready',
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      feedbackDeliveryProtocolVersion: 0,
      feedbackSnapshotProtocolVersion: FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
      viewGeneration: options.viewGeneration,
    },
    document as unknown as vscode.TextDocument,
    webview as unknown as vscode.Webview
  );
}

function sendStart(
  provider: MarkdownEditorProvider,
  document: ReturnType<typeof createDocument>,
  webview: ReturnType<typeof createWebview>,
  requestId: string
): void {
  internals(provider).registerFeedbackWebview(
    document.uri.toString(),
    webview as unknown as vscode.Webview
  );
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

function acknowledgeFeedbackPeerRelease(
  provider: MarkdownEditorProvider,
  document: ReturnType<typeof createDocument>,
  webview: ReturnType<typeof createWebview>,
  release: FeedbackMessage
): void {
  internals(provider).handleWebviewMessage(
    {
      type: 'feedback.peer.released',
      phase: release.phase,
      releaseId: release.releaseId,
      requestId: release.requestId,
      lockId: release.lockId,
      viewGeneration: release.viewGeneration,
      revision: release.revision,
      documentVersion: release.documentVersion,
      contentSha256: release.contentSha256,
    },
    document as unknown as vscode.TextDocument,
    webview as unknown as vscode.Webview
  );
}

function acknowledgeFeedbackSessionTransfer(
  provider: MarkdownEditorProvider,
  document: ReturnType<typeof createDocument>,
  webview: ReturnType<typeof createWebview>,
  transfer: FeedbackMessage,
  applied = true
): void {
  internals(provider).handleWebviewMessage(
    {
      type: 'feedback.session.transfer.ack',
      phase: transfer.phase,
      role: transfer.role,
      transferId: transfer.transferId,
      requestId: transfer.requestId,
      oldSessionId: transfer.oldSessionId,
      newSessionId: transfer.newSessionId,
      viewGeneration: transfer.viewGeneration,
      revision: transfer.revision,
      documentVersion: transfer.documentVersion,
      sourceSha256: transfer.sourceSha256,
      applied,
    },
    document as unknown as vscode.TextDocument,
    webview as unknown as vscode.Webview
  );
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

async function waitForFeedbackPeerReleasePhase(
  webview: ReturnType<typeof createWebview>,
  phase: 'apply' | 'commit',
  requestId: string
): Promise<FeedbackMessage> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const message = messagesOfType(webview, 'feedback.peer.release').find(
      candidate => candidate.requestId === requestId && candidate.phase === phase
    );
    if (message) return message;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for feedback.peer.release ${phase} (${requestId}).`);
}

async function waitForSessionTransferPhase(
  webview: ReturnType<typeof createWebview>,
  phase: 'apply' | 'commit' | 'abort',
  role: 'new-owner' | 'old-owner' | 'same-owner',
  requestId: string
): Promise<FeedbackMessage> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const message = messagesOfType(webview, 'feedback.session.transfer').find(
      candidate =>
        candidate.requestId === requestId && candidate.phase === phase && candidate.role === role
    );
    if (message) return message;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error(
    `Timed out waiting for feedback.session.transfer ${phase}/${role} (${requestId}).`
  );
}

async function waitForFeedbackPeerReleaseRevision(
  webview: ReturnType<typeof createWebview>,
  revision: number,
  requestId: string
): Promise<FeedbackMessage> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const message = messagesOfType(webview, 'feedback.peer.release').find(
      candidate =>
        candidate.requestId === requestId &&
        candidate.phase === 'apply' &&
        candidate.revision === revision
    );
    if (message) return message;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error(
    `Timed out waiting for feedback.peer.release revision ${revision} (${requestId}).`
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
  const ownerRelease = await waitForMessage(ownerWebview, 'feedback.peer.release', requestId);
  const peerRelease = await waitForMessage(peerWebview, 'feedback.peer.release', requestId);
  for (const [targetWebview, release] of [
    [ownerWebview, ownerRelease],
    [peerWebview, peerRelease],
  ] as const) {
    internals(provider).handleWebviewMessage(
      {
        type: 'feedback.peer.released',
        phase: release.phase,
        releaseId: release.releaseId,
        requestId: release.requestId,
        lockId: release.lockId,
        viewGeneration: release.viewGeneration,
        revision: release.revision,
        documentVersion: release.documentVersion,
        contentSha256: release.contentSha256,
      },
      document as unknown as vscode.TextDocument,
      targetWebview as unknown as vscode.Webview
    );
  }
  expect(internals(provider).feedbackTransitions.size).toBe(0);
  const ownerCommit = await waitForFeedbackPeerReleasePhase(ownerWebview, 'commit', requestId);
  const peerCommit = await waitForFeedbackPeerReleasePhase(peerWebview, 'commit', requestId);
  acknowledgeFeedbackPeerRelease(provider, document, ownerWebview, ownerCommit);
  acknowledgeFeedbackPeerRelease(provider, document, peerWebview, peerCommit);
  await new Promise<void>(resolve => setImmediate(resolve));

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
