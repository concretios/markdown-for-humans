/** @jest-environment jsdom */
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
  Mark: { create: (config: unknown) => config },
  Node: { create: (config: unknown) => config },
  mergeAttributes: jest.fn(),
}));
jest.mock('@tiptap/starter-kit', () => ({ __esModule: true, default: { configure: () => ({}) } }));
jest.mock('@tiptap/markdown', () => ({ Markdown: { configure: () => ({}) } }));
jest.mock('lowlight', () => ({ __esModule: true, lowlight: { registerLanguage: jest.fn() } }));
jest.mock('@tiptap/extension-table', () => ({
  __esModule: true,
  TableKit: { configure: () => ({}) },
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
jest.mock('@tiptap/extension-highlight', () => ({
  __esModule: true,
  default: { configure: () => ({}) },
  Highlight: { configure: () => ({}) },
}));
jest.mock('@tiptap/extension-underline', () => ({
  __esModule: true,
  default: { configure: () => ({}) },
}));
jest.mock('./../../webview/extensions/customImage', () => ({
  CustomImage: { configure: () => ({}) },
}));
jest.mock('./../../webview/extensions/mermaid', () => ({ Mermaid: {} }));
jest.mock('./../../webview/extensions/tabIndentation', () => ({ TabIndentation: {} }));
jest.mock('./../../webview/extensions/imageEnterSpacing', () => ({ ImageEnterSpacing: {} }));
jest.mock('./../../webview/extensions/markdownParagraph', () => ({ MarkdownParagraph: {} }));
jest.mock('./../../webview/extensions/indentedImageCodeBlock', () => ({
  IndentedImageCodeBlock: {},
}));
jest.mock('./../../webview/extensions/spaceFriendlyImagePaths', () => ({
  SpaceFriendlyImagePaths: {},
}));
jest.mock('./../../webview/extensions/githubAlerts', () => ({ GitHubAlert: {} }));
jest.mock('./../../webview/extensions/htmlPreservation', () => ({
  GenericHTMLInline: {},
  GenericHTMLBlock: {},
}));
jest.mock('./../../webview/extensions/livePreview', () => ({ LivePreview: {} }));
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
jest.mock('./../../webview/features/searchOverlay', () => ({ toggleSearchOverlay: jest.fn() }));
jest.mock('./../../webview/utils/exportContent', () => ({
  collectExportContent: jest.fn(),
  getDocumentTitle: jest.fn(),
}));
jest.mock('./../../webview/utils/pasteHandler', () => ({
  processPasteContent: jest.fn(() => ({ isImage: false, wasConverted: false, content: '' })),
}));
jest.mock('./../../webview/utils/copyMarkdown', () => ({ copySelectionAsMarkdown: jest.fn() }));
jest.mock('./../../webview/utils/outline', () => ({ buildOutlineFromEditor: jest.fn(() => []) }));
jest.mock('./../../webview/utils/scrollToHeading', () => ({ scrollToHeading: jest.fn() }));
jest.mock('./../../webview/utils/linkValidation', () => ({ shouldAutoLink: jest.fn(() => false) }));
jest.mock('./../../webview/features/linkDialog', () => ({ showLinkDialog: jest.fn() }));
jest.mock('./../../webview/features/imageRenameDialog', () => ({}));

// Mock Tiptap extensions that have ESM/CJS resolution issues in Jest
jest.mock('@tiptap/extension-drag-handle', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Extension } = require('@tiptap/core');
  const mockExtension = Extension.create({ name: 'dragHandle' });
  return { __esModule: true, DragHandle: mockExtension, default: mockExtension };
});

jest.mock('@tiptap/extension-text-style', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Mark } = require('@tiptap/core');
  const mockMark = Mark.create({ name: 'textStyle' });
  return { __esModule: true, TextStyle: mockMark, default: mockMark };
});

type TestingModule = {
  resetSyncState: () => void;
  setMockEditor: (editor: unknown) => void;
  trackSentContentForTests: (content: string) => void;
  updateEditorContentForTests: (content: string) => void;
};

describe('webview undo/redo guards', () => {
  let testing: TestingModule;

  const setupModule = async () => {
    jest.resetModules();

    // Minimal globals to satisfy editor.ts on import without creating the editor
    const mockDocument = {
      readyState: 'loading',
      addEventListener: jest.fn(),
    };
    (global as any).document = mockDocument;

    // Mock VS Code API on global
    const mockAcquireVsCodeApi = jest.fn(() => ({
      postMessage: jest.fn(),
      getState: jest.fn(),
      setState: jest.fn(),
    }));
    (global as any).acquireVsCodeApi = mockAcquireVsCodeApi;
    (window as any).acquireVsCodeApi = mockAcquireVsCodeApi;

    try {
      const mod = await import('../../webview/editor');
      testing = mod.__testing;
    } catch (e) {
      console.error('IMPORT ERROR:', e);
      throw e;
    }
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
});
