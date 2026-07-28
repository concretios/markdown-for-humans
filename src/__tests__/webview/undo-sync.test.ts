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
}));
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

type TestingModule = {
  resetSyncState: () => void;
  setMockEditor: (editor: unknown) => void;
  trackSentContentForTests: (content: string) => void;
  updateEditorContentForTests: (content: string) => void;
  isCodeContextForPasteForTests: (event: ClipboardEvent) => boolean;
  insertRawCodeTextForTests: (text: string) => void;
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

  const setupModule = async () => {
    jest.resetModules();

    // Minimal globals to satisfy editor.ts on import without creating the editor
    (
      global as unknown as { document: { readyState: string; addEventListener: jest.Mock } }
    ).document = {
      readyState: 'loading',
      addEventListener: jest.fn(),
    };
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
      addEventListener: jest.fn(),
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
      postMessage: jest.fn(),
      getState: jest.fn(),
      setState: jest.fn(),
    }));
    (global as unknown as { performance: { now: () => number } }).performance = {
      now: () => 0,
    };

    const mod = await import('../../webview/editor');
    testing = mod.__testing;
  };

  beforeEach(async () => {
    await setupModule();
    testing.resetSyncState();
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
