/**
 * Regression tests for webview undo/redo guards.
 *
 * We avoid initializing TipTap by mocking document.readyState as "loading"
 * so initializeEditor is never invoked during module import.
 */

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
  setFeedbackPeerLockControllerForTests: (controller: unknown) => void;
  trackSentContentForTests: (content: string) => void;
  updateEditorContentForTests: (content: string, force?: boolean) => void;
  isCodeContextForPasteForTests: (event: ClipboardEvent) => boolean;
  insertRawCodeTextForTests: (text: string) => void;
  queueDebouncedUpdateForTests: (markdown: string) => void;
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

    expect(postMessage).toHaveBeenCalledWith({
      type: 'edit',
      content: 'latest',
      editReason: 'typing',
    });
    expect(handleWindowMessage).toBeDefined();
    handleWindowMessage?.({
      data: { type: 'flushPendingEdit', requestId: 'flush-after-fired-debounce' },
    } as MessageEvent);

    expect(postMessage.mock.calls.filter(call => call[0]?.type === 'edit')).toHaveLength(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'flushPendingEditAck',
      requestId: 'flush-after-fired-debounce',
      ok: true,
    });
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
