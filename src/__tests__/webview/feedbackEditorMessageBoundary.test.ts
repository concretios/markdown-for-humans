/**
 * Regression coverage for the extension-host to Feedback UI trust boundary.
 * The editor module is loaded without initializing TipTap, then its real
 * window message listener is driven with untrusted payloads.
 */

const mockRunAudit = jest.fn();
const mockShowAuditOverlay = jest.fn();
const mockShowAuditToast = jest.fn(() => 'audit-loading');
const mockDismissAuditToast = jest.fn();

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
jest.mock('@tiptap/pm/state', () => ({ Plugin: class {}, PluginKey: class {} }));
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
jest.mock('../../webview/extensions/codeBlockWithCopy', () => ({
  CodeBlockWithCopy: { configure: () => ({}) },
}));
jest.mock('../../webview/extensions/customImage', () => ({
  CustomImage: { configure: () => ({}) },
}));
jest.mock('../../webview/extensions/mermaid', () => ({ Mermaid: {} }));
jest.mock('../../webview/extensions/tabIndentation', () => ({ TabIndentation: {} }));
jest.mock('../../webview/extensions/imageEnterSpacing', () => ({ ImageEnterSpacing: {} }));
jest.mock('../../webview/extensions/markdownParagraph', () => ({ MarkdownParagraph: {} }));
jest.mock('../../webview/extensions/blankLinePreservation', () => ({
  BlankLinePreservation: {},
}));
jest.mock('../../webview/extensions/githubAlerts', () => ({ GitHubAlerts: {} }));
jest.mock('../../webview/BubbleMenuView', () => ({
  createFormattingToolbar: () => ({}),
  createTableMenu: () => ({}),
  updateToolbarStates: jest.fn(),
}));
jest.mock('../../webview/features/imageDragDrop', () => ({
  setupImageDragDrop: jest.fn(),
  hasPendingImageSaves: jest.fn(() => false),
  getPendingImageCount: jest.fn(() => 0),
}));
jest.mock('../../webview/features/tocOverlay', () => ({ toggleTocOverlay: jest.fn() }));
jest.mock('../../webview/features/searchOverlay', () => ({ toggleSearchOverlay: jest.fn() }));
jest.mock('../../webview/features/linkDialog', () => ({ showLinkDialog: jest.fn() }));
jest.mock('../../webview/features/auditDocument', () => ({
  DocumentAuditExtension: {},
  auditPluginKey: { key: 'audit' },
  runAudit: mockRunAudit,
}));
jest.mock('../../webview/features/auditOverlay', () => ({
  showAuditOverlay: mockShowAuditOverlay,
  showToast: mockShowAuditToast,
  dismissToast: mockDismissAuditToast,
}));
jest.mock('../../webview/utils/exportContent', () => ({
  collectExportContent: jest.fn(),
  getDocumentTitle: jest.fn(),
}));
jest.mock('../../webview/utils/pasteHandler', () => ({
  processPasteContent: jest.fn(() => ({ isImage: false, wasConverted: false, content: '' })),
  parseFencedCode: jest.fn(() => null),
}));
jest.mock('../../webview/utils/copyMarkdown', () => ({ copySelectionAsMarkdown: jest.fn() }));
jest.mock('../../webview/utils/outline', () => ({ buildOutlineFromEditor: jest.fn(() => []) }));
jest.mock('../../webview/utils/scrollToHeading', () => ({ scrollToHeading: jest.fn() }));

export {};

type TestingModule = {
  setFeedbackReviewControllerForTests(controller: unknown): void;
  setFeedbackPeerLockControllerForTests(controller: unknown): void;
  setMockEditor(editor: unknown): void;
  signalFeedbackControllerReadyForTests(): void;
  getDocumentSyncIdentityForTests(): { acceptedDocumentVersion: number };
  openLinkDialogForTests(editor: unknown): boolean;
  insertAndEditMathForTests(editor: unknown, mode: 'inline' | 'block'): Promise<void>;
};

describe('Feedback editor host-message boundary', () => {
  let messageHandler: (event: MessageEvent) => void;
  let testing: TestingModule;
  let handleHostMessage: jest.Mock;
  let applyCloseSync: jest.Mock;
  let applyTransitionSync: jest.Mock;
  let completeClose: jest.Mock;
  let completeTransition: jest.Mock;
  let lockPeer: jest.Mock;
  let unlockPeer: jest.Mock;
  let isPeerLocked: jest.Mock;
  let getPeerLockId: jest.Mock;
  let postHostMessage: jest.Mock;
  let warn: jest.SpyInstance;
  let windowListeners: Map<string, (event: unknown) => unknown>;

  beforeEach(async () => {
    jest.resetModules();
    (
      global as unknown as { document: { readyState: string; addEventListener: jest.Mock } }
    ).document = { readyState: 'loading', addEventListener: jest.fn() };

    windowListeners = new Map<string, (event: unknown) => unknown>();
    postHostMessage = jest.fn();
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
      addEventListener: jest.fn((type: string, handler: (event: unknown) => void) => {
        windowListeners.set(type, handler);
      }),
    };
    (
      global as unknown as {
        acquireVsCodeApi: () => {
          postMessage: jest.Mock;
          getState: jest.Mock;
          setState: jest.Mock;
        };
      }
    ).acquireVsCodeApi = jest.fn(() => ({
      postMessage: postHostMessage,
      getState: jest.fn(),
      setState: jest.fn(),
    }));
    (global as unknown as { performance: { now: () => number } }).performance = { now: () => 0 };

    const module = await import('../../webview/editor');
    testing = module.__testing as unknown as TestingModule;
    messageHandler = windowListeners.get('message') as (event: MessageEvent) => void;
    handleHostMessage = jest.fn();
    applyCloseSync = jest.fn();
    applyTransitionSync = jest.fn();
    completeClose = jest.fn(() => false);
    completeTransition = jest.fn(() => false);
    lockPeer = jest.fn();
    unlockPeer = jest.fn();
    isPeerLocked = jest.fn(() => false);
    getPeerLockId = jest.fn(() => null);
    mockRunAudit.mockReset();
    mockShowAuditOverlay.mockReset();
    mockShowAuditToast.mockReset().mockReturnValue('audit-loading');
    mockDismissAuditToast.mockReset();
    testing.setFeedbackReviewControllerForTests({
      handleHostMessage,
      applyCloseSync,
      applyTransitionSync,
      completeClose,
      completeTransition,
      hasPeerReleaseLock: jest.fn(() => false),
      applyPeerRelease: jest.fn(() => false),
      getSession: () => null,
    });
    testing.setFeedbackPeerLockControllerForTests({
      lock: lockPeer,
      unlock: unlockPeer,
      isLocked: isPeerLocked,
      getLockId: getPeerLockId,
      runHostUpdate: (update: () => unknown) => update(),
    });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('dispatches a valid exact Feedback host message', () => {
    const message = { type: 'feedback.command', command: 'nextFeedback' };

    messageHandler({ data: message } as MessageEvent);

    expect(handleHostMessage).toHaveBeenCalledWith(message);
  });

  it('routes the host-owned transition lock to the review controller', () => {
    const message = {
      type: 'feedback.transition.locked',
      requestId: 'discard-1',
      lockId: 'transition-lock-1',
    };

    messageHandler({ data: message } as MessageEvent);

    expect(handleHostMessage).toHaveBeenCalledWith(message);
  });

  it('routes inactive-draft discard completion to clear the recovery UI', () => {
    const message = {
      type: 'feedback.draft.discarded',
      requestId: 'discard-draft-1',
      round: '20260822T120000Z-abcd',
    };

    messageHandler({ data: message } as MessageEvent);

    expect(handleHostMessage).toHaveBeenCalledWith(message);
  });

  it('routes authoritative close sync through the review lock before applying content', () => {
    const setContent = jest.fn();
    testing.setMockEditor({
      getMarkdown: jest.fn(() => '# Frozen source\n'),
      state: {
        selection: { from: 1, to: 1 },
        doc: { content: { size: 16 } },
      },
      commands: {
        setContent,
        setTextSelection: jest.fn(),
      },
    });
    applyCloseSync.mockImplementation(
      (message: { content: string }, applyContent: (content: string) => boolean): boolean =>
        applyContent(message.content)
    );
    const message = {
      type: 'feedback.close.sync',
      requestId: 'finish-1',
      sessionId: 'session-1',
      revision: 1,
      content: '# Authoritative source\n',
    };

    messageHandler({ data: message } as MessageEvent);

    expect(applyCloseSync).toHaveBeenCalledWith(message, expect.any(Function));
    expect(applyCloseSync.mock.results[0]?.value).toBe(true);
    expect(setContent).toHaveBeenCalledWith('# Authoritative source\n', {
      contentType: 'markdown',
    });
    expect(handleHostMessage).not.toHaveBeenCalled();
  });

  it('routes correlated transition sync through the pre-session review lock', () => {
    const setContent = jest.fn();
    testing.setMockEditor({
      getMarkdown: jest.fn(() => '# Frozen source\n'),
      state: {
        selection: { from: 1, to: 1 },
        doc: { content: { size: 16 } },
      },
      commands: {
        setContent,
        setTextSelection: jest.fn(),
      },
    });
    applyTransitionSync.mockImplementation(
      (message: { content: string }, applyContent: (content: string) => boolean): boolean =>
        applyContent(message.content)
    );
    const message = {
      type: 'feedback.transition.sync',
      requestId: 'start-1',
      lockId: 'transition-lock-1',
      revision: 1,
      content: '# Changed during start\n',
    };

    messageHandler({ data: message } as MessageEvent);

    expect(applyTransitionSync).toHaveBeenCalledWith(message, expect.any(Function));
    expect(applyTransitionSync.mock.results[0]?.value).toBe(true);
    expect(setContent).toHaveBeenCalledWith('# Changed during start\n', {
      contentType: 'markdown',
    });
  });

  it('routes correlated peer lock lifecycle messages outside the review controller', () => {
    messageHandler({
      data: {
        type: 'feedback.peer.locked',
        lockId: 'peer-lock-1',
        message: 'Feedback is active in another editor split.',
      },
    } as MessageEvent);
    messageHandler({
      data: { type: 'feedback.peer.unlocked', lockId: 'peer-lock-1' },
    } as MessageEvent);

    expect(lockPeer).toHaveBeenCalledWith(
      'peer-lock-1',
      'Feedback is active in another editor split.'
    );
    expect(unlockPeer).toHaveBeenCalledWith('peer-lock-1');
    expect(completeClose).toHaveBeenCalledWith('peer-lock-1');
    expect(completeTransition).toHaveBeenCalledWith('peer-lock-1');
    expect(handleHostMessage).not.toHaveBeenCalled();
  });

  it('ACKs an exact-generation peer lock only after installing it', () => {
    testing.signalFeedbackControllerReadyForTests();
    const controllerReady = postHostMessage.mock.calls
      .map(call => call[0] as { type?: string; viewGeneration?: string })
      .find(message => message.type === 'feedback.controller.ready');
    expect(controllerReady?.viewGeneration).toEqual(expect.any(String));

    let currentLockId: string | null = null;
    getPeerLockId.mockImplementation(() => currentLockId);
    lockPeer.mockImplementation((lockId: string) => {
      currentLockId = lockId;
    });
    const acquire = {
      type: 'feedback.peer.lock.acquire',
      acquisitionId: 'acquire-1',
      requestId: 'start-1',
      lockId: 'transition-1',
      replacesLockId: null,
      viewGeneration: controllerReady?.viewGeneration,
      revision: 1,
      message: 'Feedback is active in another editor split.',
    };

    messageHandler({ data: acquire } as MessageEvent);

    expect(lockPeer).toHaveBeenCalledWith(acquire.lockId, acquire.message);
    expect(postHostMessage).toHaveBeenCalledWith({
      type: 'feedback.peer.lock.acquired',
      acquisitionId: acquire.acquisitionId,
      requestId: acquire.requestId,
      lockId: acquire.lockId,
      replacesLockId: acquire.replacesLockId,
      viewGeneration: acquire.viewGeneration,
      revision: acquire.revision,
    });
    expect(lockPeer.mock.invocationCallOrder[0]).toBeLessThan(
      postHostMessage.mock.invocationCallOrder.at(-1) as number
    );

    currentLockId = 'newer-lock';
    messageHandler({ data: acquire } as MessageEvent);
    expect(lockPeer).toHaveBeenCalledTimes(1);
  });

  it('applies an authoritative peer release under its lock, then unlocks on commit', () => {
    testing.signalFeedbackControllerReadyForTests();
    const viewGeneration = postHostMessage.mock.calls
      .map(call => call[0] as { type?: string; viewGeneration?: string })
      .find(message => message.type === 'feedback.controller.ready')?.viewGeneration;
    const setContent = jest.fn(() => true);
    testing.setMockEditor({
      getMarkdown: jest.fn(() => '# Frozen source\n'),
      state: {
        selection: { from: 1, to: 1 },
        doc: { content: { size: 16 } },
      },
      commands: {
        setContent,
        setTextSelection: jest.fn(),
      },
    });
    let currentLockId: string | null = 'peer-lock-release';
    isPeerLocked.mockImplementation(() => currentLockId !== null);
    getPeerLockId.mockImplementation(() => currentLockId);
    unlockPeer.mockImplementation(() => {
      currentLockId = null;
    });
    messageHandler({
      data: {
        type: 'feedback.peer.locked',
        lockId: 'peer-lock-release',
        message: 'Feedback is active in another editor split.',
      },
    } as MessageEvent);

    const release = {
      type: 'feedback.peer.release',
      phase: 'apply',
      releaseId: 'release-1',
      requestId: 'finish-1',
      lockId: 'peer-lock-release',
      viewGeneration,
      revision: 2,
      documentVersion: 7,
      contentSha256: 'a'.repeat(64),
      content: '# Authoritative source\n',
    } as const;
    messageHandler({ data: release } as MessageEvent);

    expect(setContent).toHaveBeenCalledWith(release.content, { contentType: 'markdown' });
    expect(unlockPeer).not.toHaveBeenCalled();
    expect(postHostMessage).toHaveBeenCalledWith({
      type: 'feedback.peer.released',
      phase: 'apply',
      releaseId: release.releaseId,
      requestId: release.requestId,
      lockId: release.lockId,
      viewGeneration: release.viewGeneration,
      revision: release.revision,
      documentVersion: release.documentVersion,
      contentSha256: release.contentSha256,
    });
    const applyAckOrder = postHostMessage.mock.calls.findIndex(
      call => call[0]?.type === 'feedback.peer.released' && call[0]?.phase === 'apply'
    );
    expect(setContent.mock.invocationCallOrder[0]).toBeLessThan(
      postHostMessage.mock.invocationCallOrder[applyAckOrder]
    );

    messageHandler({
      data: {
        type: release.type,
        phase: 'commit',
        releaseId: release.releaseId,
        requestId: release.requestId,
        lockId: release.lockId,
        viewGeneration: release.viewGeneration,
        revision: release.revision,
        documentVersion: release.documentVersion,
        contentSha256: release.contentSha256,
      },
    } as MessageEvent);

    expect(unlockPeer).toHaveBeenCalledWith(release.lockId);
    expect(postHostMessage).toHaveBeenCalledWith({
      type: 'feedback.peer.released',
      phase: 'commit',
      releaseId: release.releaseId,
      requestId: release.requestId,
      lockId: release.lockId,
      viewGeneration: release.viewGeneration,
      revision: release.revision,
      documentVersion: release.documentVersion,
      contentSha256: release.contentSha256,
    });
    expect(unlockPeer.mock.invocationCallOrder[0]).toBeLessThan(
      postHostMessage.mock.invocationCallOrder.at(-1) as number
    );
    expect(testing.getDocumentSyncIdentityForTests().acceptedDocumentVersion).toBe(7);
  });

  it('atomically replaces a transferred review session with its new peer lock', () => {
    testing.setFeedbackReviewControllerForTests({
      handleHostMessage,
      getSession: () => ({ sessionId: 'old-session' }),
    });
    const message = {
      type: 'feedback.session.transferred',
      oldSessionId: 'old-session',
      lockId: 'new-session',
      message: 'Feedback resumed in another rich view. This view is now read-only.',
    };

    messageHandler({ data: message } as MessageEvent);

    expect(handleHostMessage).toHaveBeenCalledWith(message);
    expect(lockPeer).toHaveBeenCalledWith('new-session', message.message);
    expect(handleHostMessage.mock.invocationCallOrder[0]).toBeLessThan(
      lockPeer.mock.invocationCallOrder[0]
    );
  });

  it('stages and commits an exact-generation session transfer without an editable gap', () => {
    testing.signalFeedbackControllerReadyForTests();
    const currentGeneration = postHostMessage.mock.calls
      .map(call => call[0] as { type?: string; viewGeneration?: string })
      .find(message => message.type === 'feedback.controller.ready')?.viewGeneration;
    if (!currentGeneration) throw new Error('Expected a renderer generation.');

    let sessionId: string | null = null;
    let peerLockId: string | null = 'session-old';
    const prepareSessionTransfer = jest.fn(() => {
      sessionId = 'session-new';
      return true;
    });
    const commitSessionTransfer = jest.fn(() => true);
    testing.setFeedbackReviewControllerForTests({
      handleHostMessage,
      prepareSessionTransfer,
      commitSessionTransfer,
      getSession: () => (sessionId ? { sessionId } : null),
    });
    getPeerLockId.mockImplementation(() => peerLockId);
    unlockPeer.mockImplementation((lockId: string) => {
      if (peerLockId === lockId) peerLockId = null;
    });
    const apply = {
      type: 'feedback.session.transfer',
      phase: 'apply',
      role: 'new-owner',
      transferId: 'transfer-1',
      requestId: 'resume-1',
      oldSessionId: 'session-old',
      newSessionId: 'session-new',
      viewGeneration: currentGeneration,
      revision: 1,
      documentVersion: 7,
      sourceSha256: 'a'.repeat(64),
      peerLockMessage: 'Feedback is active in another editor split.',
      session: {
        sessionId: 'session-new',
        source: 'docs/guide.md',
        sourceSha256: 'a'.repeat(64),
        round: '20260821T093000Z-k4p9',
        feedbackFile: '.md4h/feedback/docs/guide/feedback.md',
        anchors: [],
        items: [],
      },
    };

    messageHandler({ data: apply } as MessageEvent);
    messageHandler({ data: apply } as MessageEvent);

    expect(prepareSessionTransfer).toHaveBeenCalledTimes(1);
    expect(peerLockId).toBe('session-old');
    expect(postHostMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'feedback.session.transfer.ack',
        phase: 'apply',
        transferId: apply.transferId,
        applied: true,
      })
    );

    const { session: transferredSession, ...identity } = apply;
    expect(transferredSession.sessionId).toBe('session-new');
    messageHandler({ data: { ...identity, phase: 'commit' } } as MessageEvent);

    expect(commitSessionTransfer).toHaveBeenCalledTimes(1);
    expect(unlockPeer).toHaveBeenCalledWith('session-old');
    expect(peerLockId).toBeNull();
    expect(commitSessionTransfer.mock.invocationCallOrder[0]).toBeLessThan(
      unlockPeer.mock.invocationCallOrder[0]
    );
    expect(unlockPeer.mock.invocationCallOrder[0]).toBeLessThan(
      postHostMessage.mock.invocationCallOrder.at(-1) as number
    );
  });

  it('does not ACK a transfer from a stale renderer generation', () => {
    const prepareSessionTransfer = jest.fn(() => true);
    testing.setFeedbackReviewControllerForTests({
      handleHostMessage,
      prepareSessionTransfer,
      commitSessionTransfer: jest.fn(() => true),
      getSession: () => null,
    });
    getPeerLockId.mockReturnValue('session-old');

    messageHandler({
      data: {
        type: 'feedback.session.transfer',
        phase: 'apply',
        role: 'new-owner',
        transferId: 'transfer-stale',
        requestId: 'resume-stale',
        oldSessionId: 'session-old',
        newSessionId: 'session-new',
        viewGeneration: 'view-stale',
        revision: 1,
        documentVersion: 7,
        sourceSha256: 'a'.repeat(64),
        peerLockMessage: 'Feedback is active in another editor split.',
        session: {
          sessionId: 'session-new',
          source: 'docs/guide.md',
          sourceSha256: 'a'.repeat(64),
          round: '20260821T093000Z-k4p9',
          feedbackFile: '.md4h/feedback/docs/guide/feedback.md',
          anchors: [],
          items: [],
        },
      },
    } as MessageEvent);

    expect(prepareSessionTransfer).not.toHaveBeenCalled();
    expect(
      postHostMessage.mock.calls.some(
        call => (call[0] as { type?: string }).type === 'feedback.session.transfer.ack'
      )
    ).toBe(false);
  });

  it('does not invoke Feedback commands from a read-only peer split', () => {
    isPeerLocked.mockReturnValue(true);

    messageHandler({
      data: { type: 'feedback.command', command: 'start' },
    } as MessageEvent);

    expect(handleHostMessage).not.toHaveBeenCalled();
  });

  it('blocks the link editor while a frozen Feedback session is active', async () => {
    const { showLinkDialog } = await import('../../webview/features/linkDialog');
    const editor = {};
    testing.setFeedbackReviewControllerForTests({
      handleHostMessage,
      getSession: () => ({ sessionId: 'session-1' }),
    });

    expect(testing.openLinkDialogForTests(editor)).toBe(false);
    expect(showLinkDialog).not.toHaveBeenCalled();
  });

  it('blocks math insertion before touching the document while Feedback is active', async () => {
    const schemaRead = jest.fn();
    const editor = {
      get schema() {
        schemaRead();
        return { nodes: {} };
      },
    };
    testing.setFeedbackReviewControllerForTests({
      handleHostMessage,
      getSession: () => ({ sessionId: 'session-1' }),
    });

    await testing.insertAndEditMathForTests(editor, 'block');

    expect(schemaRead).not.toHaveBeenCalled();
    expect(document.querySelector?.('.math-editor-overlay')).toBeUndefined();
  });

  it('blocks math insertion during a local pre-session Feedback transition lock', async () => {
    const schemaRead = jest.fn();
    const editor = {
      get schema() {
        schemaRead();
        return { nodes: {} };
      },
    };
    testing.setFeedbackReviewControllerForTests({
      handleHostMessage,
      getSession: () => null,
      isEditingLocked: () => true,
    });

    await testing.insertAndEditMathForTests(editor, 'block');

    expect(schemaRead).not.toHaveBeenCalled();
    expect(document.querySelector?.('.math-editor-overlay')).toBeUndefined();
  });

  it('does not reopen Audit after Feedback locks locally while runAudit is pending', async () => {
    let resolveAudit!: (issues: Array<{ id: string }>) => void;
    mockRunAudit.mockReturnValue(
      new Promise<Array<{ id: string }>>(resolve => {
        resolveAudit = resolve;
      })
    );
    const dispatch = jest.fn();
    const setMeta = jest.fn((_key: unknown, value: unknown) => ({ value }));
    testing.setMockEditor({
      isDestroyed: false,
      state: { tr: { setMeta } },
      view: { dispatch },
    });
    testing.setFeedbackReviewControllerForTests({
      handleHostMessage,
      getSession: () => null,
      isEditingLocked: () => false,
    });
    const runAuditFromToolbar = windowListeners.get('auditDocument');
    const pendingAudit = runAuditFromToolbar?.(new Event('auditDocument')) as Promise<void>;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockRunAudit).toHaveBeenCalledTimes(1);

    testing.setFeedbackReviewControllerForTests({
      handleHostMessage,
      getSession: () => null,
      isEditingLocked: () => true,
    });
    resolveAudit([{ id: 'late-issue' }]);
    await pendingAudit;

    expect(mockDismissAuditToast).toHaveBeenCalledWith('audit-loading');
    expect(mockShowAuditOverlay).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('dismisses the Audit loading toast when the async audit rejects', async () => {
    let rejectAudit!: (error: Error) => void;
    mockRunAudit.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectAudit = reject;
      })
    );
    const dispatch = jest.fn();
    const setMeta = jest.fn((_key: unknown, value: unknown) => ({ value }));
    testing.setMockEditor({
      isDestroyed: false,
      state: { tr: { setMeta } },
      view: { dispatch },
    });
    testing.setFeedbackReviewControllerForTests({
      handleHostMessage,
      getSession: () => null,
      isEditingLocked: () => false,
    });
    const runAuditFromToolbar = windowListeners.get('auditDocument');
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const pendingAudit = runAuditFromToolbar?.(new Event('auditDocument')) as Promise<void>;
      await new Promise(resolve => setTimeout(resolve, 0));
      rejectAudit(new Error('audit failed'));
      await pendingAudit;

      expect(mockDismissAuditToast).toHaveBeenCalledWith('audit-loading');
      expect(mockShowAuditOverlay).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('routes repeated local Feedback errors through one keyed toast channel', async () => {
    const showFeedbackError = windowListeners.get('feedbackLocalError');

    showFeedbackError?.(
      new CustomEvent('feedbackLocalError', {
        detail: { message: 'Could not map the rendered document.' },
      })
    );
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockShowAuditToast).toHaveBeenCalledWith(
      'Could not map the rendered document.',
      'info',
      { dedupeKey: 'feedback-local-error' }
    );
  });

  it('blocks document commands while another split owns Feedback', async () => {
    const { showLinkDialog } = await import('../../webview/features/linkDialog');
    const schemaRead = jest.fn();
    const editor = {
      get schema() {
        schemaRead();
        return { nodes: {} };
      },
    };
    isPeerLocked.mockReturnValue(true);

    expect(testing.openLinkDialogForTests(editor)).toBe(false);
    await testing.insertAndEditMathForTests(editor, 'block');

    expect(showLinkDialog).not.toHaveBeenCalled();
    expect(schemaRead).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'feedback.command', command: 'nextFeedback', leaked: true },
    { type: 'feedback.command', command: 'unknown-command' },
    {
      type: 'feedback.updated',
      requestId: 'update-1',
      items: [
        {
          id: 'F1',
          kind: 'text',
          startOrdinal: 0,
          endOrdinal: 0,
          startLine: 1,
          endLine: 1,
          focus: 'Visible text',
          feedback: 'Clarify this.',
          leaked: 'must reject',
        },
      ],
    },
    {
      type: 'feedback.transition.sync',
      requestId: 'start-1',
      lockId: 'transition-lock-1',
      revision: 1,
      content: '# Authoritative source\n',
      force: true,
    },
    { type: 'feedback.future-message', requestId: 'unknown-1' },
  ])('rejects malformed Feedback host data before controller dispatch %#', message => {
    messageHandler({ data: message } as MessageEvent);

    expect(handleHostMessage).not.toHaveBeenCalled();
    expect(applyCloseSync).not.toHaveBeenCalled();
    expect(applyTransitionSync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[MD4H] Rejected malformed Feedback host message');
  });
});
