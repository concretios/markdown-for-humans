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
  ListItem: { extend: (config: unknown) => config },
  ListKit: { configure: () => ({}) },
  OrderedList: { extend: (config: unknown) => config },
  TaskList: { extend: (config: unknown) => config, config: {} },
}));
jest.mock('@tiptap/extension-link', () => ({
  __esModule: true,
  default: { configure: () => ({}) },
}));
jest.mock('../../webview/extensions/markdownCompatibilityMarks', () => ({
  MarkdownCode: {},
  MarkdownLink: { configure: () => ({}) },
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
jest.mock('./../../webview/features/outOfSyncBanner', () => ({
  showOutOfSyncBanner: jest.fn(),
  hideOutOfSyncBanner: jest.fn(),
}));
jest.mock('./../../webview/features/tocOverlay', () => ({
  toggleTocOverlay: jest.fn(),
  isTocVisible: jest.fn(() => false),
}));
jest.mock('./../../webview/features/searchOverlay', () => ({
  showSearchOverlay: jest.fn(),
  hideSearchOverlay: jest.fn(),
  isSearchVisible: jest.fn(() => true),
}));
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

  it.each(['feedbackStartRequested', 'feedbackResumeRequested', 'command'])(
    'closes search without focus restoration when entering Feedback via %s',
    async entry => {
      const search = await import('../../webview/features/searchOverlay');
      const mockEditor = { isDestroyed: true };
      testing.setMockEditor(mockEditor);
      testing.setFeedbackReviewControllerForTests({
        start: jest.fn(),
        handleHostMessage: jest.fn(),
      });
      Object.assign(document, {
        querySelector: jest.fn(() => null),
        querySelectorAll: jest.fn(() => []),
      });
      if (entry === 'command') {
        handleWindowMessage?.({
          data: { type: 'feedback.command', command: 'start' },
        } as MessageEvent);
      } else {
        const registrations = (window.addEventListener as jest.Mock).mock.calls;
        const listener = registrations.find(([name]) => name === entry)?.[1];
        expect(listener).toBeDefined();
        listener({});
      }
      expect(search.hideSearchOverlay).toHaveBeenCalledWith(mockEditor, false);
    }
  );

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

  describe('host replay recovery (post-merge 03)', () => {
    const useWindowFakeTimers = () => {
      jest.useFakeTimers();
      window.setTimeout = setTimeout;
      window.clearTimeout = clearTimeout;
    };
    const createReplayEditor = (getMarkdown: () => string) => ({
      getMarkdown: jest.fn(getMarkdown),
      state: { selection: { from: 1, to: 1 }, doc: { content: { size: 80 } } },
      commands: { setContent: jest.fn(() => true), setTextSelection: jest.fn() },
    });
    const postedOfType = (type: string) =>
      postMessage.mock.calls.map(call => call[0]).filter(message => message?.type === type);
    const ackEdit = (
      edit: { editId: string; localRevision: number },
      version: number,
      accepted: boolean
    ) => {
      handleWindowMessage?.({
        data: {
          type: 'document.edit.ack',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          editId: edit.editId,
          viewGeneration: testing.getDocumentSyncIdentityForTests().viewGeneration,
          localRevision: edit.localRevision,
          accepted,
          documentVersion: version,
        },
      } as MessageEvent);
    };
    const rejectEdit = (edit: { editId: string; localRevision: number }, version: number) =>
      ackEdit(edit, version, false);
    const acceptEdit = (edit: { editId: string; localRevision: number }, version: number) =>
      ackEdit(edit, version, true);
    const hostVersion = (documentVersion: number) => {
      handleWindowMessage?.({
        data: {
          type: 'document.version',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          documentVersion,
        },
      } as MessageEvent);
    };
    const hostUpdate = (
      content: string,
      documentVersion: number,
      force = false,
      savePolicyEcho = false
    ) => {
      handleWindowMessage?.({
        data: {
          type: 'update',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          documentVersion,
          content,
          ...(force ? { force: true } : {}),
          ...(savePolicyEcho ? { savePolicyEcho: true } : {}),
        },
      } as MessageEvent);
    };

    it('Y1: adopts a version-only host update as the base of the next edit', () => {
      useWindowFakeTimers();
      testing.setMockEditor(createReplayEditor(() => 'typed after a hidden source change'));

      handleWindowMessage?.({
        data: {
          type: 'document.version',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          documentVersion: 7,
        },
      } as MessageEvent);
      expect(testing.getDocumentSyncIdentityForTests().acceptedDocumentVersion).toBe(7);

      testing.queueDebouncedUpdateForTests('ignored');
      jest.advanceTimersByTime(500);
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'edit',
          baseDocumentVersion: 7,
          content: 'typed after a hidden source change',
        })
      );
    });

    it('Y1: ignores a version-only update while a visible host change is deferred', () => {
      const mockEditor = createReplayEditor(() => 'local edit');
      testing.setMockEditor(mockEditor);
      testing.markRecentUserEditForTests();

      hostUpdate('external host edit', 3);
      expect(mockEditor.commands.setContent).not.toHaveBeenCalled();
      handleWindowMessage?.({
        data: {
          type: 'document.version',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          documentVersion: 4,
        },
      } as MessageEvent);

      expect(testing.getDocumentSyncIdentityForTests().acceptedDocumentVersion).toBe(0);
    });

    it('Y1: keeps typing made during a forced replay and resends it on the replayed version', () => {
      useWindowFakeTimers();
      let localMarkdown = 'first keystrokes';
      const mockEditor = createReplayEditor(() => localMarkdown);
      testing.setMockEditor(mockEditor);
      testing.queueDebouncedUpdateForTests('ignored');
      jest.advanceTimersByTime(500);
      const edit = postedOfType('edit')[0] as { editId: string; localRevision: number };

      // An invisible host change (blank lines in strip mode, a save participant
      // racing the edit) made the base stale. The host rejects and replays.
      rejectEdit(edit, 2);
      expect(postedOfType('document.sync.request')).toHaveLength(1);
      localMarkdown = 'first keystrokes and more typed during the replay';
      testing.queueDebouncedUpdateForTests('ignored');
      postMessage.mockClear();

      hostUpdate('host content at version 2', 2, true);
      jest.advanceTimersByTime(500);

      expect(mockEditor.commands.setContent).not.toHaveBeenCalled();
      expect(testing.getDocumentSyncIdentityForTests().acceptedDocumentVersion).toBe(2);
      expect(postedOfType('edit')).toEqual([
        expect.objectContaining({
          baseDocumentVersion: 2,
          content: 'first keystrokes and more typed during the replay',
        }),
      ]);
      expect(postedOfType('document.sync.conflict')).toHaveLength(0);
    });

    it.each([
      ['', false],
      [' even after a keystroke before the replay', true],
    ])(
      'Y1: applies the replay when the host rejected an edit without a version change%s',
      (_description, typeBeforeReplay) => {
        useWindowFakeTimers();
        let localMarkdown = 'edit the host cannot apply';
        const mockEditor = createReplayEditor(() => localMarkdown);
        testing.setMockEditor(mockEditor);
        // A real document version, so the base-version bookkeeping is exercised.
        hostVersion(5);
        testing.queueDebouncedUpdateForTests('ignored');
        jest.advanceTimersByTime(500);
        const edit = postedOfType('edit')[0] as { editId: string; localRevision: number };
        expect(edit).toEqual(expect.objectContaining({ baseDocumentVersion: 5 }));

        // Not a stale base (read-only file, unknown image marker): resending the
        // same content would only be rejected again, so the replay is applied.
        rejectEdit(edit, 5);
        if (typeBeforeReplay) {
          localMarkdown = 'edit the host cannot apply, plus one more keystroke';
          testing.queueDebouncedUpdateForTests('ignored');
        }
        postMessage.mockClear();
        hostUpdate('host content', 5, true);
        jest.advanceTimersByTime(500);

        expect(mockEditor.commands.setContent).toHaveBeenCalledWith('host content', {
          contentType: 'markdown',
        });
        expect(postedOfType('edit')).toHaveLength(0);
      }
    );

    it('Y1: rebases later typing once the replay after a hard rejection was applied', () => {
      useWindowFakeTimers();
      let localMarkdown = 'edit the host cannot apply';
      const mockEditor = createReplayEditor(() => localMarkdown);
      testing.setMockEditor(mockEditor);
      hostVersion(5);
      testing.queueDebouncedUpdateForTests('ignored');
      jest.advanceTimersByTime(500);
      rejectEdit(postedOfType('edit')[0] as { editId: string; localRevision: number }, 5);
      // The replay is applied over a keystroke made after the hard rejection.
      testing.markRecentUserEditForTests();
      testing.queueDebouncedUpdateForTests('ignored');
      hostUpdate('host content', 5, true);
      expect(mockEditor.commands.setContent).toHaveBeenCalledTimes(1);

      // Still within the typing window, a visible external change is deferred.
      // Nothing is pending, so its replay request goes out at once.
      localMarkdown = 'host content';
      hostUpdate('agent content', 6);
      expect(postedOfType('document.sync.request')).toHaveLength(2);
      // The user types before that replay arrives (Scenario C).
      localMarkdown = 'host content plus new typing';
      testing.queueDebouncedUpdateForTests('ignored');
      postMessage.mockClear();
      hostUpdate('agent content', 6, true);

      // The earlier hard rejection was settled by the applied replay.
      expect(mockEditor.commands.setContent).toHaveBeenCalledTimes(1);
      expect(postedOfType('document.sync.conflict')).toHaveLength(1);
      expect(postedOfType('edit')).toEqual([
        expect.objectContaining({
          baseDocumentVersion: 6,
          content: 'host content plus new typing',
        }),
      ]);
    });

    it('Y1: rebases typing when an accepted edit settled a hard rejection before the delayed replay', () => {
      useWindowFakeTimers();
      let localMarkdown = 'A';
      const mockEditor = createReplayEditor(() => localMarkdown);
      testing.setMockEditor(mockEditor);
      hostVersion(5);
      testing.queueDebouncedUpdateForTests('ignored');
      jest.advanceTimersByTime(500);
      // A stale rejection: the immediate replay rebases and resends at once.
      rejectEdit(postedOfType('edit')[0] as { editId: string; localRevision: number }, 6);
      hostUpdate('host content', 6, true);
      const resend = postedOfType('edit')[1] as { editId: string; localRevision: number };
      expect(resend).toEqual(expect.objectContaining({ baseDocumentVersion: 6, content: 'A' }));

      // The user keeps typing. The resend is rejected without a version change
      // (for example a failed image save), so the next request waits 250 ms.
      localMarkdown = 'A B';
      testing.queueDebouncedUpdateForTests('ignored');
      jest.advanceTimersByTime(300);
      rejectEdit(resend, 6);
      expect(postedOfType('document.sync.request')).toHaveLength(1);

      // Within that wait the debounced typing is sent and accepted.
      jest.advanceTimersByTime(200);
      const typingEdit = postedOfType('edit')[2] as { editId: string; localRevision: number };
      expect(typingEdit).toEqual(
        expect.objectContaining({ baseDocumentVersion: 6, content: 'A B' })
      );
      acceptEdit(typingEdit, 7);

      // More typing, then the delayed request and its replay.
      localMarkdown = 'A B C';
      testing.queueDebouncedUpdateForTests('ignored');
      jest.advanceTimersByTime(50);
      expect(postedOfType('document.sync.request')).toHaveLength(2);
      postMessage.mockClear();
      hostUpdate('A B', 7, true);

      expect(mockEditor.commands.setContent).not.toHaveBeenCalled();
      expect(postedOfType('edit')).toEqual([
        expect.objectContaining({ baseDocumentVersion: 7, content: 'A B C' }),
      ]);
    });

    it('Y1: surfaces a conflict when a visible host change raced local typing', () => {
      useWindowFakeTimers();
      const mockEditor = createReplayEditor(() => 'my typing');
      testing.setMockEditor(mockEditor);
      testing.markRecentUserEditForTests();
      testing.queueDebouncedUpdateForTests('ignored');

      // A visible external change arrives while the user is typing.
      hostUpdate('agent content', 1);
      jest.advanceTimersByTime(500);
      const edit = postedOfType('edit')[0] as { editId: string; localRevision: number };
      rejectEdit(edit, 1);
      postMessage.mockClear();

      hostUpdate('agent content', 1, true);
      jest.advanceTimersByTime(500);

      expect(mockEditor.commands.setContent).not.toHaveBeenCalled();
      expect(postedOfType('document.sync.conflict')).toEqual([
        {
          type: 'document.sync.conflict',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          viewGeneration: testing.getDocumentSyncIdentityForTests().viewGeneration,
          documentVersion: 1,
        },
      ]);
      expect(postedOfType('edit')).toEqual([
        expect.objectContaining({ baseDocumentVersion: 1, content: 'my typing' }),
      ]);
    });

    it('Y1: keeps typing made during the replay round trip when no edit was rejected', () => {
      useWindowFakeTimers();
      let localMarkdown = 'my typing';
      const mockEditor = createReplayEditor(() => localMarkdown);
      testing.setMockEditor(mockEditor);
      testing.queueDebouncedUpdateForTests('ignored');
      jest.advanceTimersByTime(500);
      acceptEdit(postedOfType('edit')[0] as { editId: string; localRevision: number }, 1);

      // A visible external change arrives right after typing. Nothing is
      // pending, so the replay request goes out at once.
      testing.markRecentUserEditForTests();
      hostUpdate('agent content', 2);
      expect(postedOfType('document.sync.request')).toHaveLength(1);

      // Scenario C: the user types before the forced replay arrives.
      localMarkdown = 'my typing and more during the round trip';
      testing.queueDebouncedUpdateForTests('ignored');
      postMessage.mockClear();
      hostUpdate('agent content', 2, true);

      expect(mockEditor.commands.setContent).not.toHaveBeenCalled();
      expect(postedOfType('document.sync.conflict')).toHaveLength(1);
      expect(postedOfType('edit')).toEqual([
        expect.objectContaining({
          baseDocumentVersion: 2,
          content: 'my typing and more during the round trip',
        }),
      ]);
    });

    it('Y1: defers a save participant change that races typing after a version-only Ctrl+S echo', () => {
      useWindowFakeTimers();
      let localMarkdown = 'hello  ';
      const mockEditor = createReplayEditor(() => localMarkdown);
      testing.setMockEditor(mockEditor);

      // Ctrl+S: the save-policy edit only gains the trailing newline, so the
      // host echoes it as document.version and then acknowledges it.
      testing.immediateUpdateForTests();
      const savePolicyEdit = postedOfType('edit')[0] as { editId: string; localRevision: number };
      expect(savePolicyEdit).toEqual(
        expect.objectContaining({ editReason: 'save-policy-enforce' })
      );
      hostVersion(1);
      acceptEdit(savePolicyEdit, 1);

      // The user keeps typing while VS Code runs a save participant.
      localMarkdown = 'hello  world';
      testing.markRecentUserEditForTests();
      testing.queueDebouncedUpdateForTests('ignored');
      postMessage.mockClear();
      hostUpdate('hello\n', 2);

      // The participant change is not the save-policy echo: it must not bypass
      // the recent-typing guard and replace unsent typing.
      expect(mockEditor.commands.setContent).not.toHaveBeenCalled();
      jest.advanceTimersByTime(500);
      expect(postedOfType('edit')).toEqual([expect.objectContaining({ content: 'hello  world' })]);
    });

    it('Y1: still applies the host-tagged Ctrl+S save-policy echo over recent typing', () => {
      useWindowFakeTimers();
      const mockEditor = createReplayEditor(() => 'Saved\n\n\n\ntext');
      testing.setMockEditor(mockEditor);
      testing.markRecentUserEditForTests();

      testing.immediateUpdateForTests();
      const savePolicyEdit = postedOfType('edit')[0] as { editId: string; localRevision: number };
      hostUpdate('Saved\n\ntext\n', 1, false, true);
      acceptEdit(savePolicyEdit, 1);

      expect(mockEditor.commands.setContent).toHaveBeenCalledWith('Saved\n\ntext\n', {
        contentType: 'markdown',
      });
    });

    it('Y1: keeps the typing guard after a replay rebase retires an in-flight Ctrl+S edit', () => {
      useWindowFakeTimers();
      let localMarkdown = 'my typing';
      const mockEditor = createReplayEditor(() => localMarkdown);
      testing.setMockEditor(mockEditor);
      testing.queueDebouncedUpdateForTests('ignored');
      jest.advanceTimersByTime(500);
      rejectEdit(postedOfType('edit')[0] as { editId: string; localRevision: number }, 1);
      expect(postedOfType('document.sync.request')).toHaveLength(1);

      // Ctrl+S before the replay arrives. The host answers the request first,
      // so the rebase retires the Ctrl+S edit and its stale rejection is dropped.
      testing.immediateUpdateForTests();
      const savePolicyEdit = postedOfType('edit')[1] as { editId: string; localRevision: number };
      expect(savePolicyEdit).toEqual(
        expect.objectContaining({ editReason: 'save-policy-enforce' })
      );
      hostUpdate('host content', 1, true);
      const resend = postedOfType('edit')[2] as { editId: string; localRevision: number };
      rejectEdit(savePolicyEdit, 1);
      acceptEdit(resend, 2);

      // Later the user types while a save participant or an agent rewrites the file.
      localMarkdown = 'my typing and more';
      testing.markRecentUserEditForTests();
      testing.queueDebouncedUpdateForTests('ignored');
      hostUpdate('participant rewrite', 3);

      expect(mockEditor.commands.setContent).not.toHaveBeenCalled();
    });

    it('Y1: keeps the typing guard for an external change that lands before the Ctrl+S edit', () => {
      useWindowFakeTimers();
      const mockEditor = createReplayEditor(() => 'my saved typing');
      testing.setMockEditor(mockEditor);
      hostVersion(1);
      testing.markRecentUserEditForTests();
      testing.immediateUpdateForTests();
      const savePolicyEdit = postedOfType('edit')[0] as { editId: string; localRevision: number };

      // An agent writes the file before the host applies the Ctrl+S edit. This
      // update is not the save-policy echo, so it must not replace the typing.
      hostUpdate('agent content', 2);
      expect(mockEditor.commands.setContent).not.toHaveBeenCalled();
      rejectEdit(savePolicyEdit, 2);
      expect(postedOfType('document.sync.request')).toHaveLength(1);
      postMessage.mockClear();
      hostUpdate('agent content', 2, true);

      expect(mockEditor.commands.setContent).not.toHaveBeenCalled();
      expect(postedOfType('document.sync.conflict')).toHaveLength(1);
      expect(postedOfType('edit')).toEqual([
        expect.objectContaining({ baseDocumentVersion: 2, content: 'my saved typing' }),
      ]);
    });

    it('Y2: stops requesting forced replays after repeated failures and reports out of sync', () => {
      useWindowFakeTimers();
      const mockEditor = createReplayEditor(() => 'stable local content');
      mockEditor.commands.setContent.mockImplementation(() => {
        throw new Error('parseMarkdown failed');
      });
      testing.setMockEditor(mockEditor);

      hostUpdate('# Broken external content', 3);
      let answered = 0;
      for (let round = 0; round < 12; round += 1) {
        const requested = postedOfType('document.sync.request').length;
        if (requested > answered) {
          answered = requested;
          hostUpdate('# Broken external content', 3, true);
        }
        jest.advanceTimersByTime(10_000);
      }

      expect(postedOfType('document.sync.request').length).toBeLessThanOrEqual(4);
      expect(postedOfType('document.sync.failed')).toEqual([
        {
          type: 'document.sync.failed',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          viewGeneration: testing.getDocumentSyncIdentityForTests().viewGeneration,
        },
      ]);
    });

    describe('Y2: out-of-sync banner (decision #2)', () => {
      const outOfSyncBanner = () =>
        jest.requireMock('../../webview/features/outOfSyncBanner') as {
          showOutOfSyncBanner: jest.Mock;
          hideOutOfSyncBanner: jest.Mock;
        };
      const createBrokenReplayEditor = () => {
        const mockEditor = createReplayEditor(() => 'stable local content');
        mockEditor.commands.setContent.mockImplementation(() => {
          throw new Error('parseMarkdown failed');
        });
        testing.setMockEditor(mockEditor);
        return mockEditor;
      };
      const failEveryReplay = (onRetry: () => void = () => undefined) => {
        hostUpdate('# Broken external content', 3);
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          jest.advanceTimersByTime(10_000);
          expect(postedOfType('document.sync.request')).toHaveLength(attempt);
          onRetry();
          hostUpdate('# Broken external content', 3, true);
        }
        expect(postedOfType('document.sync.failed')).toHaveLength(1);
      };

      it('Y2: shows the banner only once replays are exhausted, and its action asks the host to reload', () => {
        useWindowFakeTimers();
        const banner = outOfSyncBanner();
        createBrokenReplayEditor();

        // Retries still in progress are transient: no banner.
        failEveryReplay(() => expect(banner.showOutOfSyncBanner).not.toHaveBeenCalled());

        expect(banner.showOutOfSyncBanner).toHaveBeenCalledTimes(1);
        const reload = banner.showOutOfSyncBanner.mock.calls[0][0] as () => void;
        postMessage.mockClear();
        reload();
        expect(postMessage.mock.calls.map(call => call[0])).toEqual([
          {
            type: 'document.sync.reload',
            protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
            viewGeneration: testing.getDocumentSyncIdentityForTests().viewGeneration,
          },
        ]);
      });

      it('Y2: removes the banner when a later replay is applied', () => {
        useWindowFakeTimers();
        const banner = outOfSyncBanner();
        const mockEditor = createBrokenReplayEditor();
        failEveryReplay();
        banner.hideOutOfSyncBanner.mockClear();

        mockEditor.commands.setContent.mockImplementation(() => true);
        hostUpdate('# Fixed externally', 4, true);

        expect(banner.hideOutOfSyncBanner).toHaveBeenCalled();
      });

      it('Y2: removes the banner when the host accepts a later edit', () => {
        useWindowFakeTimers();
        const banner = outOfSyncBanner();
        createBrokenReplayEditor();
        failEveryReplay();
        banner.hideOutOfSyncBanner.mockClear();

        testing.queueDebouncedUpdateForTests('ignored');
        jest.advanceTimersByTime(500);
        acceptEdit(postedOfType('edit')[0] as { editId: string; localRevision: number }, 4);

        expect(banner.hideOutOfSyncBanner).toHaveBeenCalled();
      });
    });

    it('Y2: backs off before retrying a failed forced replay', () => {
      useWindowFakeTimers();
      const mockEditor = createReplayEditor(() => 'stable local content');
      mockEditor.commands.setContent.mockImplementation(() => {
        throw new Error('parseMarkdown failed');
      });
      testing.setMockEditor(mockEditor);

      hostUpdate('# Broken external content', 3);
      expect(postedOfType('document.sync.request')).toHaveLength(1);
      hostUpdate('# Broken external content', 3, true);
      expect(postedOfType('document.sync.request')).toHaveLength(1);
      jest.advanceTimersByTime(249);
      expect(postedOfType('document.sync.request')).toHaveLength(1);
      jest.advanceTimersByTime(1);
      expect(postedOfType('document.sync.request')).toHaveLength(2);
    });

    it('Y2: does not schedule a second retry while one is already waiting', () => {
      useWindowFakeTimers();
      const mockEditor = createReplayEditor(() => 'stable local content');
      mockEditor.commands.setContent.mockImplementation(() => {
        throw new Error('parseMarkdown failed');
      });
      testing.setMockEditor(mockEditor);

      hostUpdate('# Broken external content', 3);
      hostUpdate('# Broken external content', 3, true);
      // Another failing external change while the 250 ms retry is waiting.
      hostUpdate('# Broken again', 4);
      jest.advanceTimersByTime(1_000);

      expect(postedOfType('document.sync.request')).toHaveLength(2);
    });

    it('Y2: drops a waiting retry once a replay rebased local edits', () => {
      useWindowFakeTimers();
      const mockEditor = createReplayEditor(() => 'my typing');
      testing.setMockEditor(mockEditor);
      testing.queueDebouncedUpdateForTests('ignored');
      jest.advanceTimersByTime(500);
      rejectEdit(postedOfType('edit')[0] as { editId: string; localRevision: number }, 1);
      expect(postedOfType('document.sync.request')).toHaveLength(1);

      // A visible change deferred by typing schedules a retry behind the
      // request already in flight.
      testing.markRecentUserEditForTests();
      hostUpdate('agent content', 1);
      hostUpdate('agent content', 1, true);
      expect(mockEditor.commands.setContent).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1_000);

      // The rebase settled reconciliation; a late replay would overwrite the resend.
      expect(postedOfType('document.sync.request')).toHaveLength(1);
    });

    it('Y2: gives each stale rejection a fresh retry budget after an accepted edit', () => {
      useWindowFakeTimers();
      testing.setMockEditor(createReplayEditor(() => 'my typing'));
      testing.queueDebouncedUpdateForTests('ignored');
      jest.advanceTimersByTime(500);
      rejectEdit(postedOfType('edit')[0] as { editId: string; localRevision: number }, 1);
      hostUpdate('host content', 1, true);
      const resend = postedOfType('edit')[1] as { editId: string; localRevision: number };
      expect(resend).toEqual(expect.objectContaining({ baseDocumentVersion: 1 }));
      acceptEdit(resend, 2);

      // A later, unrelated stale rejection is a first attempt again.
      testing.queueDebouncedUpdateForTests('ignored');
      jest.advanceTimersByTime(500);
      rejectEdit(postedOfType('edit')[2] as { editId: string; localRevision: number }, 3);

      expect(postedOfType('document.sync.request')).toHaveLength(2);
    });

    it('Y1: applies a forced update this view did not request, even while it is dirty', () => {
      useWindowFakeTimers();
      const mockEditor = createReplayEditor(() => 'unsent typing');
      testing.setMockEditor(mockEditor);
      testing.queueDebouncedUpdateForTests('ignored');

      // For example, authoritative restoration after a Feedback owner closed.
      hostUpdate('authoritative content', 3, true);
      jest.advanceTimersByTime(500);

      expect(mockEditor.commands.setContent).toHaveBeenCalledWith('authoritative content', {
        contentType: 'markdown',
      });
      expect(postedOfType('edit')).toHaveLength(0);
    });

    it('Y1: applies a requested replay over local edits while Feedback editing is locked', () => {
      useWindowFakeTimers();
      const mockEditor = createReplayEditor(() => 'my typing');
      testing.setMockEditor(mockEditor);
      testing.queueDebouncedUpdateForTests('ignored');
      jest.advanceTimersByTime(500);
      rejectEdit(postedOfType('edit')[0] as { editId: string; localRevision: number }, 2);
      testing.setFeedbackReviewControllerForTests({
        getSession: () => null,
        isEditingLocked: () => true,
      });
      postMessage.mockClear();

      hostUpdate('host content', 2, true);
      jest.advanceTimersByTime(500);

      expect(mockEditor.commands.setContent).toHaveBeenCalledWith('host content', {
        contentType: 'markdown',
      });
      expect(postedOfType('edit')).toHaveLength(0);
    });

    it('Y1: adopts a version-only update again once a later host update was applied', () => {
      useWindowFakeTimers();
      const mockEditor = createReplayEditor(() => 'local edit');
      testing.setMockEditor(mockEditor);
      testing.markRecentUserEditForTests();
      hostUpdate('external host edit', 3);
      expect(mockEditor.commands.setContent).not.toHaveBeenCalled();

      // The user pauses; the next external change is applied in full.
      jest.advanceTimersByTime(2_500);
      hostUpdate('newer external edit', 4);
      expect(mockEditor.commands.setContent).toHaveBeenCalledTimes(1);
      hostVersion(5);

      expect(testing.getDocumentSyncIdentityForTests().acceptedDocumentVersion).toBe(5);
    });

    it.each([
      ['rejects', () => false],
      [
        'throws on',
        () => {
          throw new Error('parseMarkdown failed');
        },
      ],
    ])(
      'Y1: ignores a version-only update after the editor %s host content',
      (_description, setContent) => {
        const mockEditor = createReplayEditor(() => 'local content');
        mockEditor.commands.setContent.mockImplementation(setContent);
        testing.setMockEditor(mockEditor);

        hostUpdate('external host edit', 3);
        hostVersion(4);

        expect(testing.getDocumentSyncIdentityForTests().acceptedDocumentVersion).toBe(0);
      }
    );

    it('Y4: settles a flush barrier when an image save never completes and sends no late ACK', async () => {
      useWindowFakeTimers();
      const imageDragDrop = jest.requireMock('../../webview/features/imageDragDrop') as {
        hasPendingImageSaves: jest.Mock;
        waitForPendingImageSaves: jest.Mock;
      };
      let completeLateImage: (() => void) | undefined;
      imageDragDrop.hasPendingImageSaves.mockReturnValue(true);
      imageDragDrop.waitForPendingImageSaves.mockImplementation(
        (timeoutMs?: number) =>
          new Promise<boolean>(resolve => {
            completeLateImage = () => resolve(true);
            if (timeoutMs !== undefined) setTimeout(() => resolve(false), timeoutMs);
          })
      );
      testing.setMockEditor({ getMarkdown: jest.fn(() => 'pending image marker') });
      testing.queueDebouncedUpdateForTests('ignored');
      const identity = testing.getDocumentSyncIdentityForTests();
      postMessage.mockClear();

      handleWindowMessage?.({
        data: {
          type: 'flushPendingEdit',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          requestId: 'flush-never-completing-image',
          viewGeneration: identity.viewGeneration,
          documentVersion: 9,
        },
      } as MessageEvent);
      await jest.advanceTimersByTimeAsync(2_000);

      expect(postMessage.mock.calls.map(call => call[0])).toEqual([
        expect.objectContaining({
          type: 'flushPendingEditAck',
          requestId: 'flush-never-completing-image',
          ok: false,
        }),
      ]);
      expect(testing.getDocumentSyncIdentityForTests().acceptedDocumentVersion).toBe(0);

      postMessage.mockClear();
      imageDragDrop.hasPendingImageSaves.mockReturnValue(false);
      completeLateImage?.();
      await jest.advanceTimersByTimeAsync(0);
      expect(postMessage).not.toHaveBeenCalled();
    });
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
