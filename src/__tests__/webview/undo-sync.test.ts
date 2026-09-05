/**
 * Regression tests for webview undo/redo guards.
 *
 * We avoid initializing TipTap by mocking document.readyState as "loading"
 * so initializeEditor is never invoked during module import.
 */

import { DOCUMENT_SYNC_PROTOCOL_VERSION } from '../../shared/documentSyncProtocol';
import { FEEDBACK_DELIVERY_PROTOCOL_VERSION } from '../../shared/feedbackDeliveryProtocol';
import { FEEDBACK_SNAPSHOT_PROTOCOL_VERSION } from '../../shared/feedbackSnapshotProtocol';

// Mock TipTap and related heavy dependencies to avoid DOM requirements
jest.mock('@tiptap/core', () => ({
  Editor: jest.fn(),
  Extension: { create: (config: unknown) => config },
  Node: { create: (config: unknown) => config },
  Mark: { create: (config: unknown) => config },
  mergeAttributes: (...args: unknown[]) => Object.assign({}, ...(args as object[])),
  InputRule: class {
    constructor(config: unknown) {
      Object.assign(this, config as object);
    }
  },
}));
jest.mock('katex', () => ({
  __esModule: true,
  default: { renderToString: jest.fn(() => ''), render: jest.fn() },
  renderToString: jest.fn(() => ''),
  render: jest.fn(),
}));
jest.mock('katex/dist/katex.min.css', () => ({}), { virtual: true });
jest.mock('@tiptap/pm/state', () => ({
  Plugin: class {},
  PluginKey: class {},
}));
jest.mock('@tiptap/pm/tables', () => ({
  CellSelection: class {},
  TableMap: { get: jest.fn() },
}));
jest.mock('@tiptap/pm/view', () => ({
  Decoration: { inline: jest.fn() },
  DecorationSet: { create: jest.fn(), empty: {} },
}));
jest.mock('@tiptap/starter-kit', () => ({ __esModule: true, default: { configure: () => ({}) } }));
jest.mock('@tiptap/markdown', () => ({ Markdown: { configure: () => ({}) } }));
jest.mock('lowlight', () => ({ __esModule: true, lowlight: { registerLanguage: jest.fn() } }));
jest.mock('@tiptap/extension-table', () => ({
  __esModule: true,
  Table: { extend: () => ({ configure: () => ({}) }) },
  TableRow: {},
  TableHeader: {},
  TableCell: {},
}));
jest.mock('@tiptap/extension-list', () => ({
  __esModule: true,
  ListKit: { configure: () => ({}) },
  OrderedList: { extend: (config: unknown) => config },
}));
jest.mock('@tiptap/extension-link', () => ({
  __esModule: true,
  default: { configure: () => ({}) },
}));
jest.mock('../../webview/extensions/markdownCompatibilityMarks', () => ({
  MarkdownCode: {},
  MarkdownLink: { configure: () => ({}) },
}));
jest.mock('@tiptap/extension-code-block-lowlight', () => ({
  __esModule: true,
  default: { configure: () => ({}) },
}));
jest.mock('./../../webview/extensions/codeBlockWithCopy', () => ({
  CodeBlockWithCopy: { configure: () => ({}) },
}));
jest.mock('./../../webview/extensions/customImage', () => ({
  CustomImage: { configure: () => ({}) },
}));
jest.mock('./../../webview/extensions/mermaid', () => ({ Mermaid: {} }));
jest.mock('./../../webview/extensions/inlineMath', () => ({ InlineMath: {} }));
jest.mock('./../../webview/extensions/mathBlock', () => ({ MathBlock: {} }));
jest.mock('./../../webview/extensions/mathSlashCommand', () => ({ MathSlashCommand: {} }));
jest.mock('./../../webview/extensions/tabIndentation', () => ({ TabIndentation: {} }));
jest.mock('./../../webview/extensions/imageEnterSpacing', () => ({ ImageEnterSpacing: {} }));
jest.mock('./../../webview/extensions/markdownParagraph', () => ({ MarkdownParagraph: {} }));
jest.mock('./../../webview/extensions/blankLinePreservation', () => ({
  BlankLinePreservation: {},
}));
jest.mock('./../../webview/extensions/githubAlerts', () => ({ GitHubAlerts: {} }));
jest.mock('./../../webview/BubbleMenuView', () => ({
  createFormattingToolbar: () => ({}),
  createTableMenu: () => ({}),
  updateToolbarStates: jest.fn(),
}));
jest.mock('./../../webview/features/imageDragDrop', () => ({
  setupImageDragDrop: jest.fn(),
  hasPendingImageSaves: jest.fn(() => false),
  waitForPendingImageSaves: jest.fn(async () => undefined),
  getPendingImageCount: jest.fn(() => 0),
}));
jest.mock('./../../webview/features/tocOverlay', () => ({ toggleTocOverlay: jest.fn() }));
jest.mock('./../../webview/features/searchOverlay', () => ({ showSearchOverlay: jest.fn() }));
jest.mock('./../../webview/utils/exportContent', () => ({
  collectExportContent: jest.fn(),
  getDocumentTitle: jest.fn(),
}));
jest.mock('./../../webview/utils/pasteHandler', () => ({
  processPasteContent: jest.fn(() => ({ isImage: false, wasConverted: false, content: '' })),
  parseFencedCode: jest.fn(() => null),
}));
jest.mock('./../../webview/utils/copyMarkdown', () => ({ copySelectionAsMarkdown: jest.fn() }));
jest.mock('./../../webview/utils/outline', () => ({ buildOutlineFromEditor: jest.fn(() => []) }));
jest.mock('./../../webview/utils/scrollToHeading', () => ({ scrollToHeading: jest.fn() }));

// These tests load editor.ts via dynamic import(), so the file has no top-level
// import/export and TypeScript would treat it as a global script -- leaking the
// TestingModule alias below into the global scope, where it collides with the
// identically-named alias in the sibling webview tests. Mark it as a module.
export {};

type TestingModule = {
  resetSyncState: () => void;
  setMockEditor: (editor: unknown) => void;
  setFeedbackReviewControllerForTests: (controller: unknown) => void;
  setFeedbackPeerLockControllerForTests: (controller: unknown) => void;
  setFeedbackControllerReadyRequestForTests: (requestId: string | null) => void;
  signalFeedbackControllerReadyForTests: () => void;
  trackSentContentForTests: (content: string) => void;
  updateEditorContentForTests: (content: string, force?: boolean) => void;
  isCodeContextForPasteForTests: (event: ClipboardEvent) => boolean;
  insertRawCodeTextForTests: (text: string) => void;
  queueDebouncedUpdateForTests: (markdown: string) => void;
  immediateUpdateForTests: () => void;
  flushRichViewBeforeTeardownForTests: () => void;
  getDocumentSyncIdentityForTests: () => {
    viewGeneration: string;
    localRevision: number;
    acceptedDocumentVersion: number;
  };
  markRecentUserEditForTests: () => void;
  isPlainFindShortcutForTests: (event: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  }) => boolean;
};

describe('webview undo/redo guards', () => {
  let testing: TestingModule;
  let postMessage: jest.Mock;
  let handleWindowMessage: ((event: MessageEvent) => void) | undefined;

  const setupModule = async () => {
    jest.resetModules();

    // Minimal globals to satisfy editor.ts on import without creating the editor
    (
      global as unknown as { document: { readyState: string; addEventListener: jest.Mock } }
    ).document = {
      readyState: 'loading',
      addEventListener: jest.fn(),
    };
    const addWindowEventListener = jest.fn(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'message' && typeof listener === 'function') {
          handleWindowMessage = listener as (event: MessageEvent) => void;
        }
      }
    );
    (
      global as unknown as {
        window: {
          setTimeout: typeof setTimeout;
          clearTimeout: typeof clearTimeout;
          addEventListener: jest.Mock;
        };
      }
    ).window = {
      setTimeout,
      clearTimeout,
      addEventListener: addWindowEventListener,
    };
    postMessage = jest.fn();
    (
      global as unknown as {
        acquireVsCodeApi: () => {
          postMessage: jest.Mock;
          getState: jest.Mock;
          setState: jest.Mock;
        };
      }
    ).acquireVsCodeApi = jest.fn(() => ({
      postMessage,
      getState: jest.fn(),
      setState: jest.fn(),
    }));
    (global as unknown as { performance: { now: () => number } }).performance = {
      now: () => 0,
    };

    const mod = await import('../../webview/editor');
    testing = mod.__testing as unknown as TestingModule;
  };

  beforeEach(async () => {
    await setupModule();
    testing.resetSyncState();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('exposes the renderer generation to toolbar image operations', () => {
    const toolbarApi = (global as unknown as { window: { vscode?: { viewGeneration?: string } } })
      .window.vscode;

    expect(toolbarApi?.viewGeneration).toBe(
      testing.getDocumentSyncIdentityForTests().viewGeneration
    );
  });

  it('does not resend an already-delivered debounce when a later flush arrives', () => {
    jest.useFakeTimers();
    (
      global as unknown as {
        window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
      }
    ).window.setTimeout = setTimeout;
    (
      global as unknown as {
        window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
      }
    ).window.clearTimeout = clearTimeout;
    testing.setMockEditor({ getMarkdown: jest.fn(() => 'latest') });

    testing.queueDebouncedUpdateForTests('latest');
    jest.advanceTimersByTime(500);

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'edit',
        content: 'latest',
        editReason: 'typing',
      })
    );
    expect(handleWindowMessage).toBeDefined();
    handleWindowMessage?.({
      data: { type: 'flushPendingEdit', requestId: 'flush-after-fired-debounce' },
    } as MessageEvent);

    expect(postMessage.mock.calls.filter(call => call[0]?.type === 'edit')).toHaveLength(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'flushPendingEditAck',
        requestId: 'flush-after-fired-debounce',
        ok: true,
      })
    );
  });

  it('flushes a newer dirty revision against a correlated host save barrier', () => {
    jest.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    const getMarkdown = jest.fn(() => 'newest revision');
    testing.setMockEditor({ getMarkdown });

    testing.queueDebouncedUpdateForTests('first revision');
    jest.advanceTimersByTime(500);
    const firstEdit = postMessage.mock.calls.find(call => call[0]?.type === 'edit')?.[0] as {
      editId: string;
      viewGeneration: string;
    };
    testing.queueDebouncedUpdateForTests('newest revision');
    postMessage.mockClear();

    handleWindowMessage?.({
      data: {
        type: 'flushPendingEdit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        requestId: 'save-barrier-1',
        viewGeneration: firstEdit.viewGeneration,
        documentVersion: 7,
      },
    } as MessageEvent);

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'edit',
        baseDocumentVersion: 7,
        content: 'newest revision',
      })
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: 'flushPendingEditAck',
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      requestId: 'save-barrier-1',
      viewGeneration: firstEdit.viewGeneration,
      documentVersion: 7,
      ok: true,
    });
  });

  it('rejects a save barrier from another renderer generation without flushing', () => {
    jest.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    testing.setMockEditor({ getMarkdown: jest.fn(() => 'must stay pending') });
    testing.queueDebouncedUpdateForTests('must stay pending');
    postMessage.mockClear();

    handleWindowMessage?.({
      data: {
        type: 'flushPendingEdit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        requestId: 'stale-save-barrier',
        viewGeneration: 'another-generation',
        documentVersion: 7,
      },
    } as MessageEvent);

    expect(postMessage.mock.calls.some(call => call[0]?.type === 'edit')).toBe(false);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'flushPendingEditAck',
        requestId: 'stale-save-barrier',
        ok: false,
      })
    );
  });

  it('signals Feedback readiness only after both renderer controllers exist', () => {
    expect(postMessage.mock.calls.some(call => call[0]?.type === 'feedback.controller.ready')).toBe(
      false
    );
    testing.setFeedbackReviewControllerForTests({ getSession: () => null });
    testing.signalFeedbackControllerReadyForTests();
    expect(postMessage.mock.calls.some(call => call[0]?.type === 'feedback.controller.ready')).toBe(
      false
    );

    testing.setFeedbackPeerLockControllerForTests({ isLocked: () => false });
    testing.signalFeedbackControllerReadyForTests();
    testing.signalFeedbackControllerReadyForTests();

    const readyMessages = postMessage.mock.calls
      .map(call => call[0])
      .filter(message => message?.type === 'feedback.controller.ready');
    expect(readyMessages).toEqual([
      {
        type: 'feedback.controller.ready',
        requestId: `feedback-controller-${testing.getDocumentSyncIdentityForTests().viewGeneration}`,
        viewGeneration: testing.getDocumentSyncIdentityForTests().viewGeneration,
      },
    ]);
  });

  it('acknowledges feedback.started only after the renderer session is applied', () => {
    let session: { sessionId: string } | null = null;
    const handleHostMessage = jest.fn((message: { sessionId: string }) => {
      session = { sessionId: message.sessionId };
    });
    testing.setFeedbackReviewControllerForTests({
      handleHostMessage,
      getSession: () => session,
    });
    const payload = {
      type: 'feedback.started',
      requestId: 'feedback-request-1',
      sessionId: 'session-1',
      source: 'docs/guide.md',
      sourceSha256: 'a'.repeat(64),
      round: '20260826T120000Z-ab12',
      feedbackFile: '.md4h/feedback/guide/feedback.md',
      anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
      items: [],
    };

    handleWindowMessage?.({
      data: {
        type: 'feedback.delivery',
        protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        messageId: 'delivery-1',
        operationEpoch: payload.requestId,
        sessionEpoch: payload.sessionId,
        stageRevision: 1,
        payload,
      },
    } as MessageEvent);

    expect(handleHostMessage).toHaveBeenCalledWith(payload);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'feedback.delivery.ack',
      protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
      messageId: 'delivery-1',
      operationEpoch: payload.requestId,
      sessionEpoch: payload.sessionId,
      stageRevision: 1,
      outcome: { kind: 'applied', value: { messageType: 'feedback.started' } },
    });
  });

  it('restores an active session only for the current controller request and then releases its lock', () => {
    let session: { sessionId: string } | null = null;
    const restoreActiveSession = jest.fn((message: { sessionId: string }) => {
      session = { sessionId: message.sessionId };
      return true;
    });
    const unlock = jest.fn();
    testing.setFeedbackReviewControllerForTests({
      handleHostMessage: jest.fn(),
      restoreActiveSession,
      getSession: () => session,
    });
    testing.setFeedbackPeerLockControllerForTests({
      lock: jest.fn(),
      unlock,
      isLocked: () => true,
      runHostUpdate: (update: () => unknown) => update(),
    });
    const requestId = 'feedback-controller-view-current';
    testing.setFeedbackControllerReadyRequestForTests(requestId);
    const payload = {
      type: 'feedback.started',
      requestId,
      sessionId: 'restored-session-1',
      source: 'docs/guide.md',
      sourceSha256: 'c'.repeat(64),
      round: '20260826T120002Z-ef56',
      feedbackFile: '.md4h/feedback/guide/feedback.md',
      anchors: [{ ordinal: 0, startLine: 1, endLine: 1 }],
      items: [],
    };
    handleWindowMessage?.({
      data: {
        type: 'feedback.peer.locked',
        lockId: payload.sessionId,
        message: 'Restoring active Feedback.',
      },
    } as MessageEvent);

    handleWindowMessage?.({
      data: {
        type: 'feedback.delivery',
        protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        messageId: 'restore-delivery-1',
        operationEpoch: payload.requestId,
        sessionEpoch: payload.sessionId,
        stageRevision: 1,
        payload,
      },
    } as MessageEvent);

    expect(restoreActiveSession).toHaveBeenCalledWith({
      sessionId: payload.sessionId,
      source: payload.source,
      sourceSha256: payload.sourceSha256,
      round: payload.round,
      feedbackFile: payload.feedbackFile,
      anchors: payload.anchors,
      items: payload.items,
    });
    expect(unlock).toHaveBeenCalledWith(payload.sessionId);
    expect(restoreActiveSession.mock.invocationCallOrder[0]).toBeLessThan(
      unlock.mock.invocationCallOrder[0]
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'feedback.delivery.ack',
        messageId: 'restore-delivery-1',
        outcome: { kind: 'applied', value: { messageType: 'feedback.started' } },
      })
    );
  });

  it('rejects a stale controller restoration without releasing the fail-closed lock', () => {
    const restoreActiveSession = jest.fn(() => true);
    const unlock = jest.fn();
    testing.setFeedbackReviewControllerForTests({
      handleHostMessage: jest.fn(),
      restoreActiveSession,
      getSession: () => null,
    });
    testing.setFeedbackPeerLockControllerForTests({
      lock: jest.fn(),
      unlock,
      isLocked: () => true,
      runHostUpdate: (update: () => unknown) => update(),
    });
    testing.setFeedbackControllerReadyRequestForTests('feedback-controller-view-current');
    const payload = {
      type: 'feedback.started',
      requestId: 'feedback-controller-view-stale',
      sessionId: 'stale-session',
      source: 'docs/guide.md',
      sourceSha256: 'd'.repeat(64),
      round: '20260826T120003Z-gh78',
      feedbackFile: '.md4h/feedback/guide/feedback.md',
      anchors: [],
      items: [],
    };

    handleWindowMessage?.({
      data: {
        type: 'feedback.delivery',
        protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        messageId: 'restore-delivery-stale',
        operationEpoch: payload.requestId,
        sessionEpoch: payload.sessionId,
        stageRevision: 1,
        payload,
      },
    } as MessageEvent);

    expect(restoreActiveSession).not.toHaveBeenCalled();
    expect(unlock).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'feedback.delivery.ack',
        messageId: 'restore-delivery-stale',
        outcome: { kind: 'rejected', code: 'renderer-not-ready' },
      })
    );
  });

  it('keeps the temporary lock when the current controller cannot apply restoration', () => {
    const restoreActiveSession = jest.fn(() => false);
    const unlock = jest.fn();
    const requestId = 'feedback-controller-view-failed';
    const sessionId = 'failed-session';
    testing.setFeedbackReviewControllerForTests({
      handleHostMessage: jest.fn(),
      restoreActiveSession,
      getSession: () => null,
    });
    testing.setFeedbackPeerLockControllerForTests({
      lock: jest.fn(),
      unlock,
      isLocked: () => true,
      runHostUpdate: (update: () => unknown) => update(),
    });
    testing.setFeedbackControllerReadyRequestForTests(requestId);
    handleWindowMessage?.({
      data: {
        type: 'feedback.peer.locked',
        lockId: sessionId,
        message: 'Restoring active Feedback.',
      },
    } as MessageEvent);
    const payload = {
      type: 'feedback.started',
      requestId,
      sessionId,
      source: 'docs/guide.md',
      sourceSha256: 'e'.repeat(64),
      round: '20260826T120004Z-ij90',
      feedbackFile: '.md4h/feedback/guide/feedback.md',
      anchors: [],
      items: [],
    };

    handleWindowMessage?.({
      data: {
        type: 'feedback.delivery',
        protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        messageId: 'restore-delivery-failed',
        operationEpoch: requestId,
        sessionEpoch: sessionId,
        stageRevision: 1,
        payload,
      },
    } as MessageEvent);

    expect(restoreActiveSession).toHaveBeenCalledTimes(1);
    expect(unlock).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'feedback.delivery.ack',
        messageId: 'restore-delivery-failed',
        outcome: { kind: 'rejected', code: 'renderer-not-ready' },
      })
    );
  });

  it('rejects a feedback.started delivery when no renderer controller can apply it', () => {
    const payload = {
      type: 'feedback.started',
      requestId: 'feedback-request-2',
      sessionId: 'session-2',
      source: 'docs/guide.md',
      sourceSha256: 'b'.repeat(64),
      round: '20260826T120001Z-cd34',
      feedbackFile: '.md4h/feedback/guide/feedback.md',
      anchors: [],
      items: [],
    };

    handleWindowMessage?.({
      data: {
        type: 'feedback.delivery',
        protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        messageId: 'delivery-2',
        operationEpoch: payload.requestId,
        sessionEpoch: payload.sessionId,
        stageRevision: 1,
        payload,
      },
    } as MessageEvent);

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'feedback.delivery.ack',
        messageId: 'delivery-2',
        outcome: { kind: 'rejected', code: 'renderer-not-ready' },
      })
    );
  });

  it.each([
    {
      label: 'applied',
      controllerSession: { sessionId: 'session-status' },
      status: { kind: 'applied', value: { messageType: 'feedback.started' } },
    },
    { label: 'inactive', controllerSession: null, status: { kind: 'inactive' } },
    {
      label: 'mismatched',
      controllerSession: { sessionId: 'another-session' },
      status: { kind: 'mismatch' },
    },
  ])('reports the actual $label renderer activation status', ({ controllerSession, status }) => {
    testing.setFeedbackReviewControllerForTests({
      handleHostMessage: jest.fn(),
      getSession: () => controllerSession,
    });

    handleWindowMessage?.({
      data: {
        type: 'feedback.delivery.status.query',
        protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
        messageId: 'delivery-status-1',
        operationEpoch: 'feedback-request-status',
        sessionEpoch: 'session-status',
        stageRevision: 1,
      },
    } as MessageEvent);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'feedback.delivery.status.response',
      protocolVersion: FEEDBACK_DELIVERY_PROTOCOL_VERSION,
      messageId: 'delivery-status-1',
      operationEpoch: 'feedback-request-status',
      sessionEpoch: 'session-status',
      stageRevision: 1,
      status,
    });
  });

  it('serializes the latest editor state once after many queued updates', () => {
    jest.useFakeTimers();
    (
      global as unknown as {
        window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
      }
    ).window.setTimeout = setTimeout;
    (
      global as unknown as {
        window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
      }
    ).window.clearTimeout = clearTimeout;

    let latestMarkdown = 'revision 0';
    const getMarkdown = jest.fn(() => latestMarkdown);
    testing.setMockEditor({ getMarkdown });

    for (let revision = 1; revision <= 20; revision += 1) {
      latestMarkdown = `revision ${revision}`;
      testing.queueDebouncedUpdateForTests('ignored captured value');
    }

    expect(getMarkdown).not.toHaveBeenCalled();
    jest.advanceTimersByTime(500);

    expect(getMarkdown).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'edit',
        content: 'revision 20',
        editReason: 'typing',
      })
    );
  });

  it('correlates edits with renderer revisions and consumes only matching ACKs', () => {
    jest.useFakeTimers();
    (
      global as unknown as {
        window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
      }
    ).window.setTimeout = setTimeout;
    (
      global as unknown as {
        window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
      }
    ).window.clearTimeout = clearTimeout;
    const getMarkdown = jest.fn(() => 'correlated content');
    testing.setMockEditor({ getMarkdown });

    testing.queueDebouncedUpdateForTests('ignored captured value');
    jest.advanceTimersByTime(500);

    const edit = postMessage.mock.calls.find(call => call[0]?.type === 'edit')?.[0] as
      Record<string, unknown> | undefined;
    const identity = testing.getDocumentSyncIdentityForTests();
    expect(edit).toEqual(
      expect.objectContaining({
        type: 'edit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: expect.any(String),
        viewGeneration: identity.viewGeneration,
        localRevision: 1,
        baseDocumentVersion: 0,
        content: 'correlated content',
        editReason: 'typing',
      })
    );

    handleWindowMessage?.({
      data: {
        type: 'document.edit.ack',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: edit?.editId,
        viewGeneration: identity.viewGeneration,
        localRevision: 1,
        accepted: true,
        documentVersion: 9,
      },
    } as MessageEvent);
    expect(testing.getDocumentSyncIdentityForTests().acceptedDocumentVersion).toBe(9);

    handleWindowMessage?.({
      data: {
        type: 'document.edit.ack',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: 'foreign:2:1',
        viewGeneration: 'foreign-generation',
        localRevision: 2,
        accepted: true,
        documentVersion: 10,
      },
    } as MessageEvent);
    expect(testing.getDocumentSyncIdentityForTests().acceptedDocumentVersion).toBe(9);
  });

  it('keeps a sent edit dirty for snapshot inspection until its exact ACK arrives', () => {
    jest.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    const getMarkdown = jest.fn(() => 'awaiting host acknowledgement');
    testing.setMockEditor({ getMarkdown });
    testing.queueDebouncedUpdateForTests('ignored');
    jest.advanceTimersByTime(500);

    const edit = postMessage.mock.calls.find(call => call[0]?.type === 'edit')?.[0] as {
      editId: string;
      viewGeneration: string;
      localRevision: number;
    };
    postMessage.mockClear();
    handleWindowMessage?.({
      data: {
        type: 'feedback.snapshot.inspect',
        protocolVersion: FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
        requestId: 'inspect-unacknowledged-1',
        operationId: 'snapshot-unacknowledged-1',
        documentVersion: 0,
      },
    } as MessageEvent);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'feedback.snapshot.report', stage: 'inspect', dirty: true })
    );

    handleWindowMessage?.({
      data: {
        type: 'document.edit.ack',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: edit.editId,
        viewGeneration: edit.viewGeneration,
        localRevision: edit.localRevision,
        accepted: true,
        documentVersion: 1,
      },
    } as MessageEvent);
    postMessage.mockClear();
    handleWindowMessage?.({
      data: {
        type: 'feedback.snapshot.inspect',
        protocolVersion: FEEDBACK_SNAPSHOT_PROTOCOL_VERSION,
        requestId: 'inspect-unacknowledged-2',
        operationId: 'snapshot-unacknowledged-2',
        documentVersion: 1,
      },
    } as MessageEvent);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'feedback.snapshot.report', stage: 'inspect', dirty: false })
    );
  });

  it('requests authoritative reconciliation after rejecting a matching edit ACK', () => {
    jest.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    testing.setMockEditor({ getMarkdown: jest.fn(() => 'locally newer') });
    testing.queueDebouncedUpdateForTests('ignored');
    jest.advanceTimersByTime(500);
    const edit = postMessage.mock.calls.find(call => call[0]?.type === 'edit')?.[0] as {
      editId: string;
      viewGeneration: string;
      localRevision: number;
    };
    postMessage.mockClear();

    handleWindowMessage?.({
      data: {
        type: 'document.edit.ack',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: edit.editId,
        viewGeneration: edit.viewGeneration,
        localRevision: edit.localRevision,
        accepted: false,
        documentVersion: 2,
      },
    } as MessageEvent);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'document.sync.request',
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      viewGeneration: edit.viewGeneration,
    });
  });

  it('rejects a host flush barrier until a rejected edit lineage is reconciled', () => {
    jest.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    testing.setMockEditor({ getMarkdown: jest.fn(() => 'stale edit plus newer typing') });
    testing.queueDebouncedUpdateForTests('ignored');
    jest.advanceTimersByTime(500);
    const edit = postMessage.mock.calls.find(call => call[0]?.type === 'edit')?.[0] as {
      editId: string;
      viewGeneration: string;
      localRevision: number;
    };
    testing.queueDebouncedUpdateForTests('ignored newer typing');

    handleWindowMessage?.({
      data: {
        type: 'document.edit.ack',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: edit.editId,
        viewGeneration: edit.viewGeneration,
        localRevision: edit.localRevision,
        accepted: false,
        documentVersion: 2,
      },
    } as MessageEvent);
    postMessage.mockClear();

    handleWindowMessage?.({
      data: {
        type: 'flushPendingEdit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        requestId: 'flush-rejected-lineage',
        viewGeneration: edit.viewGeneration,
        documentVersion: 2,
      },
    } as MessageEvent);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'flushPendingEditAck',
        requestId: 'flush-rejected-lineage',
        ok: false,
      })
    );
  });

  it('requests reconciliation when an ordinary host update is deferred after recent typing', () => {
    const mockEditor = {
      getMarkdown: jest.fn(() => 'local edit'),
      state: { selection: { from: 1, to: 1 }, doc: { content: { size: 10 } } },
      commands: { setContent: jest.fn(), setTextSelection: jest.fn() },
    };
    testing.setMockEditor(mockEditor);
    testing.markRecentUserEditForTests();

    expect(testing.updateEditorContentForTests('external host edit')).toBe(false);

    expect(mockEditor.commands.setContent).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'document.sync.request',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      })
    );
  });

  it('serializes one pending generation before acknowledging a host flush', () => {
    jest.useFakeTimers();
    (
      global as unknown as {
        window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
      }
    ).window.setTimeout = setTimeout;
    (
      global as unknown as {
        window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
      }
    ).window.clearTimeout = clearTimeout;

    const getMarkdown = jest.fn(() => 'flush boundary content');
    testing.setMockEditor({ getMarkdown });
    testing.queueDebouncedUpdateForTests('ignored captured value');

    handleWindowMessage?.({
      data: { type: 'flushPendingEdit', requestId: 'flush-pending-generation' },
    } as MessageEvent);

    expect(getMarkdown).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({
        type: 'edit',
        content: 'flush boundary content',
        editReason: 'typing',
      }),
      expect.objectContaining({
        type: 'flushPendingEditAck',
        requestId: 'flush-pending-generation',
        ok: true,
      }),
    ]);

    jest.advanceTimersByTime(500);
    expect(getMarkdown).toHaveBeenCalledTimes(1);
  });

  it('waits for a pending image save before adopting a host flush barrier', async () => {
    jest.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    const imageDragDrop = jest.requireMock('../../webview/features/imageDragDrop') as {
      hasPendingImageSaves: jest.Mock;
      waitForPendingImageSaves: jest.Mock;
    };
    imageDragDrop.hasPendingImageSaves.mockReturnValue(true);
    imageDragDrop.waitForPendingImageSaves.mockImplementation(async () => {
      imageDragDrop.hasPendingImageSaves.mockReturnValue(false);
    });
    testing.setMockEditor({ getMarkdown: jest.fn(() => 'pending image marker') });
    testing.queueDebouncedUpdateForTests('ignored');
    const identity = testing.getDocumentSyncIdentityForTests();
    postMessage.mockClear();

    handleWindowMessage?.({
      data: {
        type: 'flushPendingEdit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        requestId: 'flush-pending-image',
        viewGeneration: identity.viewGeneration,
        documentVersion: 9,
      },
    } as MessageEvent);

    await Promise.resolve();
    await Promise.resolve();

    expect(imageDragDrop.waitForPendingImageSaves).toHaveBeenCalledTimes(1);
    expect(testing.getDocumentSyncIdentityForTests().acceptedDocumentVersion).toBe(9);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'flushPendingEditAck',
        requestId: 'flush-pending-image',
        ok: true,
      })
    );
  });

  it('posts save immediately after its ordered save-policy edit without a fixed delay', () => {
    jest.useFakeTimers();
    (
      global as unknown as {
        window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
      }
    ).window.setTimeout = setTimeout;
    (
      global as unknown as {
        window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
      }
    ).window.clearTimeout = clearTimeout;

    const getMarkdown = jest.fn(() => 'save boundary content');
    testing.setMockEditor({ getMarkdown });
    testing.queueDebouncedUpdateForTests('ignored captured value');

    testing.immediateUpdateForTests();

    expect(getMarkdown).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({
        type: 'edit',
        content: 'save boundary content',
        editReason: 'save-policy-enforce',
      }),
      { type: 'save' },
    ]);

    jest.advanceTimersByTime(500);
    expect(getMarkdown).toHaveBeenCalledTimes(1);
  });

  it('still requests an ordered host save when a prior edit is awaiting acknowledgement', () => {
    jest.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    const getMarkdown = jest.fn(() => 'newest local content');
    testing.setMockEditor({ getMarkdown });

    testing.queueDebouncedUpdateForTests('first edit');
    jest.advanceTimersByTime(500);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'edit' }));

    testing.queueDebouncedUpdateForTests('newer edit');
    postMessage.mockClear();
    testing.immediateUpdateForTests();

    // The provider will drain the first edit, ask this renderer to flush the
    // newer dirty revision, drain again, and only then invoke VS Code save.
    expect(postMessage).toHaveBeenCalledWith({ type: 'save' });
    expect(getMarkdown).toHaveBeenCalledTimes(1);
  });

  it('pipelines the newest dirty revision before a hidden webview is destroyed', () => {
    jest.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    const getMarkdown = jest.fn(() => 'newest teardown content');
    testing.setMockEditor({
      getMarkdown,
      state: {
        selection: { from: 1, to: 1 },
        doc: { content: { size: 10 } },
      },
    });

    testing.queueDebouncedUpdateForTests('first edit');
    jest.advanceTimersByTime(500);
    const firstEdit = postMessage.mock.calls.find(call => call[0]?.type === 'edit')?.[0] as {
      editId: string;
      localRevision: number;
      viewGeneration: string;
    };
    testing.queueDebouncedUpdateForTests('newest edit');
    postMessage.mockClear();

    testing.flushRichViewBeforeTeardownForTests();

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'document.teardown.edit',
        predecessorEditId: firstEdit.editId,
        predecessorLocalRevision: firstEdit.localRevision,
        viewGeneration: firstEdit.viewGeneration,
        content: 'newest teardown content',
      })
    );
  });

  it('logs when teardown flush is blocked by more than one outstanding predecessor', () => {
    jest.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    const getMarkdown = jest.fn(() => 'content');
    testing.setMockEditor({
      getMarkdown,
      state: {
        selection: { from: 1, to: 1 },
        doc: { content: { size: 10 } },
      },
    });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    testing.queueDebouncedUpdateForTests('first edit');
    jest.advanceTimersByTime(500);

    // The first teardown flush pipelines a second, still-unacknowledged edit
    // behind the first, leaving two outstanding predecessors.
    testing.queueDebouncedUpdateForTests('second edit');
    testing.flushRichViewBeforeTeardownForTests();

    testing.queueDebouncedUpdateForTests('third edit');
    testing.flushRichViewBeforeTeardownForTests();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Flush blocked before webview teardown')
    );

    consoleErrorSpy.mockRestore();
  });

  it('keeps immediate save inert while a Feedback peer lock owns editing', () => {
    jest.useFakeTimers();
    const getMarkdown = jest.fn(() => 'locked content');
    testing.setMockEditor({ getMarkdown });
    testing.setFeedbackPeerLockControllerForTests({ isLocked: () => true });

    testing.immediateUpdateForTests();
    jest.advanceTimersByTime(1_000);

    expect(getMarkdown).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('skips update when content matches recently sent hash', () => {
    const mockEditor = {
      getMarkdown: jest.fn().mockReturnValue('old'),
      state: { selection: { from: 0, to: 0 }, doc: { content: { size: 0 } } },
      commands: { setContent: jest.fn(), setTextSelection: jest.fn() },
    };

    testing.setMockEditor(mockEditor);
    // Track content we "sent" - this should cause the update to be skipped
    testing.trackSentContentForTests('new');

    testing.updateEditorContentForTests('new');

    expect(mockEditor.commands.setContent).not.toHaveBeenCalled();
  });

  it('skips update when content is unchanged', () => {
    const mockEditor = {
      getMarkdown: jest.fn().mockReturnValue('same'),
      state: { selection: { from: 1, to: 1 }, doc: { content: { size: 10 } } },
      commands: { setContent: jest.fn(), setTextSelection: jest.fn() },
    };

    testing.setMockEditor(mockEditor);

    testing.updateEditorContentForTests('same');

    expect(mockEditor.commands.setContent).not.toHaveBeenCalled();
  });

  it('applies update when content changes', () => {
    const mockEditor = {
      getMarkdown: jest.fn().mockReturnValue('old'),
      state: { selection: { from: 2, to: 4 }, doc: { content: { size: 5 } } },
      commands: { setContent: jest.fn(), setTextSelection: jest.fn() },
    };

    testing.setMockEditor(mockEditor);

    testing.updateEditorContentForTests('new content');

    // @tiptap/markdown v3 requires contentType option
    expect(mockEditor.commands.setContent).toHaveBeenCalledWith('new content', {
      contentType: 'markdown',
    });
    expect(mockEditor.commands.setTextSelection).toHaveBeenCalledWith({ from: 2, to: 4 });
  });

  it('applies authoritative host content to a locked peer despite echo suppression', () => {
    const mockEditor = {
      getMarkdown: jest.fn().mockReturnValue('old'),
      state: { selection: { from: 1, to: 1 }, doc: { content: { size: 10 } } },
      commands: { setContent: jest.fn(), setTextSelection: jest.fn() },
    };
    const runHostUpdate = jest.fn((update: () => unknown) => update());
    testing.setMockEditor(mockEditor);
    testing.setFeedbackPeerLockControllerForTests({
      isLocked: () => true,
      runHostUpdate,
    });
    testing.trackSentContentForTests('authoritative');

    testing.updateEditorContentForTests('authoritative');

    expect(runHostUpdate).toHaveBeenCalledTimes(1);
    expect(mockEditor.commands.setContent).toHaveBeenCalledWith('authoritative', {
      contentType: 'markdown',
    });
  });

  it('forces post-review owner resynchronization despite echo suppression', () => {
    const mockEditor = {
      getMarkdown: jest.fn().mockReturnValue('frozen snapshot'),
      state: { selection: { from: 1, to: 1 }, doc: { content: { size: 15 } } },
      commands: { setContent: jest.fn(), setTextSelection: jest.fn() },
    };
    testing.setMockEditor(mockEditor);
    testing.setFeedbackPeerLockControllerForTests(null);
    testing.trackSentContentForTests('externally changed source');

    testing.updateEditorContentForTests('externally changed source', true);

    expect(mockEditor.commands.setContent).toHaveBeenCalledWith('externally changed source', {
      contentType: 'markdown',
    });
  });

  it('detects code context paste when selection is a codeBlock node', () => {
    const mockEditor = {
      isActive: jest.fn(() => false),
      state: {
        selection: {
          node: { type: { name: 'codeBlock' } },
        },
      },
    };

    testing.setMockEditor(mockEditor);

    const fakeEvent = { target: null } as unknown as ClipboardEvent;
    expect(testing.isCodeContextForPasteForTests(fakeEvent)).toBe(true);
  });

  it('inserts pasted code as plain text node (no HTML parsing)', () => {
    const insertContent = jest.fn();
    const mockEditor = {
      commands: {
        insertContent,
      },
    };

    testing.setMockEditor(mockEditor);

    testing.insertRawCodeTextForTests('<table class="sq-table"><tr><td>Alice</td></tr></table>');

    expect(insertContent).toHaveBeenCalledWith({
      type: 'text',
      text: '<table class="sq-table"><tr><td>Alice</td></tr></table>',
    });
  });

  it('handles only the plain find shortcut inside the webview', () => {
    expect(testing.isPlainFindShortcutForTests({ key: 'f', ctrlKey: true })).toBe(true);
    expect(testing.isPlainFindShortcutForTests({ key: 'F', metaKey: true })).toBe(true);
    expect(testing.isPlainFindShortcutForTests({ key: 'F', ctrlKey: true, shiftKey: true })).toBe(
      false
    );
    expect(testing.isPlainFindShortcutForTests({ key: 'f', ctrlKey: true, altKey: true })).toBe(
      false
    );
  });
});
