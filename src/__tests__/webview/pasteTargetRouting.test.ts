/**
 * Regression tests for paste-target routing in the document-level paste handler.
 *
 * Bug: the capture-phase `document` paste listener intercepted EVERY paste in
 * the webview — including pastes aimed at the Cmd/Ctrl+F search input. When
 * clipboard content was rich HTML or looked like markdown, the handler
 * preventDefault()ed the paste into the input and inserted the content into
 * the TipTap document instead.
 *
 * Same harness as undo-sync.test.ts: document.readyState is mocked as
 * "loading" so initializeEditor never runs, and the paste listener registered
 * at module import is captured from the mocked document.addEventListener.
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
jest.mock('./../../webview/features/searchOverlay', () => ({ toggleSearchOverlay: jest.fn() }));
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
  setMockEditor: (editor: unknown) => void;
  isPasteTargetedAtEditorForTests: (target: EventTarget | null) => boolean;
};

type FakeNode = {
  nodeType: number;
  closest: () => null;
};

function makeNode(): FakeNode {
  return { nodeType: 1, closest: () => null };
}

describe('document paste handler target routing', () => {
  let testing: TestingModule;
  let pasteHandler: (event: unknown) => void;
  let processPasteContent: jest.Mock;
  let editorDom: FakeNode & { contains: (n: unknown) => boolean };
  let insideNode: FakeNode;
  let outsideNode: FakeNode;
  let mockEditor: {
    view: { dom: unknown };
    commands: { insertContent: jest.Mock };
    isActive: jest.Mock;
    state: { selection: Record<string, never> };
  };

  const setupModule = async () => {
    jest.resetModules();

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
    // isCodeContextForPaste references HTMLElement, which the node test env lacks
    (global as unknown as { HTMLElement: unknown }).HTMLElement = class {};

    const mod = await import('../../webview/editor');
    testing = mod.__testing as unknown as TestingModule;

    // Re-import after resetModules so we hold the same mock instance editor.ts uses
    const pasteMod = await import('./../../webview/utils/pasteHandler');
    processPasteContent = pasteMod.processPasteContent as jest.Mock;

    const addEventListener = (global as unknown as { document: { addEventListener: jest.Mock } })
      .document.addEventListener;
    const pasteRegistration = addEventListener.mock.calls.find(
      ([type]: [string]) => type === 'paste'
    );
    expect(pasteRegistration).toBeDefined();
    pasteHandler = pasteRegistration[1];
  };

  const makeEvent = (target: unknown) => ({
    target,
    clipboardData: {
      getData: jest.fn(() => ''),
      types: [],
      files: [],
    },
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
  });

  beforeEach(async () => {
    await setupModule();

    insideNode = makeNode();
    outsideNode = makeNode(); // e.g. the search overlay input
    editorDom = {
      ...makeNode(),
      contains: (n: unknown) => n === insideNode || n === editorDom,
    };
    mockEditor = {
      view: { dom: editorDom },
      commands: { insertContent: jest.fn() },
      isActive: jest.fn(() => false),
      state: { selection: {} },
    };
    testing.setMockEditor(mockEditor);

    // Simulate clipboard content that "needs conversion" (rich HTML/markdown),
    // the case that used to hijack pastes aimed at the search input.
    processPasteContent.mockReturnValue({
      isImage: false,
      wasConverted: true,
      isHtml: true,
      content: '<p>converted</p>',
    });
  });

  it('leaves pastes aimed at inputs outside the editor alone (search overlay)', () => {
    const event = makeEvent(outsideNode);

    pasteHandler(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(mockEditor.commands.insertContent).not.toHaveBeenCalled();
  });

  it('still converts and inserts pastes aimed at the editor content', () => {
    const event = makeEvent(insideNode);

    pasteHandler(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(mockEditor.commands.insertContent).toHaveBeenCalledWith('<p>converted</p>');
  });

  it('treats a missing target as editor-bound (synthetic events)', () => {
    const event = makeEvent(null);

    pasteHandler(event);

    expect(mockEditor.commands.insertContent).toHaveBeenCalledWith('<p>converted</p>');
  });

  it('exposes the predicate: editor children in, overlay nodes out', () => {
    expect(testing.isPasteTargetedAtEditorForTests(insideNode as unknown as EventTarget)).toBe(
      true
    );
    expect(testing.isPasteTargetedAtEditorForTests(outsideNode as unknown as EventTarget)).toBe(
      false
    );
    expect(testing.isPasteTargetedAtEditorForTests(null)).toBe(true);
  });
});
