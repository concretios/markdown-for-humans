/**
 * Webview side of paste as plain text (issue 11).
 *
 * The `markdownForHumans.pastePlainText` command reads the clipboard on the
 * host and posts `pastePlainText` to the active editor. The webview inserts
 * the text into the document unless something else owns the keyboard.
 *
 * Same harness as pasteTargetRouting.test.ts: document.readyState is mocked as
 * "loading" so initializeEditor never runs, and the real window message
 * listener is driven directly.
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
jest.mock('./../../webview/utils/plainTextPaste', () => ({
  insertPlainText: jest.fn(() => true),
  readsAsMarkdown: jest.fn(() => false),
}));
jest.mock('./../../webview/utils/copyMarkdown', () => ({ copySelectionAsMarkdown: jest.fn() }));
jest.mock('./../../webview/utils/outline', () => ({ buildOutlineFromEditor: jest.fn(() => []) }));
jest.mock('./../../webview/utils/scrollToHeading', () => ({ scrollToHeading: jest.fn() }));

// editor.ts is loaded via dynamic import(), so mark this file as a module to
// keep the TestingModule alias out of the global scope.
export {};

type TestingModule = {
  setMockEditor: (editor: unknown) => void;
  setFeedbackReviewControllerForTests: (controller: unknown) => void;
};

type FakeNode = { nodeType: number; closest: (selector: string) => unknown };

type FakeDocument = {
  readyState: string;
  addEventListener: jest.Mock;
  activeElement?: FakeNode | null;
};

/** A focused element that matches `closest()` only for selectors containing `match`. */
function focused(match: string | null): FakeNode {
  return {
    nodeType: 1,
    closest: (selector: string) => (match !== null && selector.includes(match) ? {} : null),
  };
}

describe('pastePlainText host message', () => {
  let testing: TestingModule;
  let messageHandler: (event: { data: unknown }) => Promise<void>;
  let insertPlainText: jest.Mock;
  let readsAsMarkdown: jest.Mock;
  let postToHost: jest.Mock;
  let fakeDocument: FakeDocument;
  let insideEditor: FakeNode | null;
  const mockEditor = { view: { dom: { contains: (node: unknown) => node === insideEditor } } };

  beforeEach(async () => {
    jest.resetModules();
    insideEditor = null;

    fakeDocument = { readyState: 'loading', addEventListener: jest.fn() };
    (global as unknown as { document: FakeDocument }).document = fakeDocument;
    const windowListeners = new Map<string, (event: { data: unknown }) => Promise<void>>();
    (global as unknown as { window: unknown }).window = {
      setTimeout,
      clearTimeout,
      addEventListener: jest.fn(
        (type: string, handler: (event: { data: unknown }) => Promise<void>) => {
          windowListeners.set(type, handler);
        }
      ),
    };
    postToHost = jest.fn();
    (global as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = jest.fn(() => ({
      postMessage: postToHost,
      getState: jest.fn(),
      setState: jest.fn(),
    }));
    (global as unknown as { performance: { now: () => number } }).performance = {
      now: () => 0,
    };

    const mod = await import('../../webview/editor');
    testing = mod.__testing as unknown as TestingModule;
    const pasteMod = await import('./../../webview/utils/plainTextPaste');
    insertPlainText = pasteMod.insertPlainText as jest.Mock;
    readsAsMarkdown = pasteMod.readsAsMarkdown as jest.Mock;

    const handler = windowListeners.get('message');
    if (!handler) throw new Error('editor.ts did not register a message listener');
    messageHandler = handler;
    testing.setMockEditor(mockEditor);
  });

  const paste = () => messageHandler({ data: { type: 'pastePlainText', text: 'plain text' } });

  it('inserts the text into the document', async () => {
    await paste();

    expect(insertPlainText).toHaveBeenCalledWith(mockEditor, 'plain text');
  });

  it('inserts while focus is in the document text', async () => {
    insideEditor = focused(null);
    fakeDocument.activeElement = insideEditor;

    await paste();

    expect(insertPlainText).toHaveBeenCalledWith(mockEditor, 'plain text');
  });

  it('inserts while focus is on a control inside the document, such as a task checkbox', async () => {
    insideEditor = focused('input');
    fakeDocument.activeElement = insideEditor;

    await paste();

    expect(insertPlainText).toHaveBeenCalledWith(mockEditor, 'plain text');
  });

  it('inserts while focus rests on a toolbar button', async () => {
    fakeDocument.activeElement = focused(null);

    await paste();

    expect(insertPlainText).toHaveBeenCalledWith(mockEditor, 'plain text');
  });

  it.each([
    ['the search box or link dialog', 'input'],
    ['a textarea', 'textarea'],
    ['the math editor', '.math-editor-overlay'],
    ['a modal', '[data-md4h-modal]'],
    ['the Feedback comment dialog', '.feedback-annotation-dialog'],
  ])('leaves the document alone while focus is in %s', async (_where, match) => {
    fakeDocument.activeElement = focused(match);

    await paste();

    expect(insertPlainText).not.toHaveBeenCalled();
  });

  it('leaves the document alone while Feedback has it locked', async () => {
    testing.setFeedbackReviewControllerForTests({
      isEditingLocked: () => true,
      getSession: () => null,
    });

    await paste();

    expect(insertPlainText).not.toHaveBeenCalled();
  });

  it('ignores a message without text', async () => {
    await messageHandler({ data: { type: 'pastePlainText' } });
    await messageHandler({ data: { type: 'pastePlainText', text: 42 } });

    expect(insertPlainText).not.toHaveBeenCalled();
  });

  it('does nothing before the editor exists', async () => {
    testing.setMockEditor(null);

    await paste();

    expect(insertPlainText).not.toHaveBeenCalled();
  });

  describe('text that would be read as Markdown when the file is reopened', () => {
    const asksHost = () =>
      postToHost.mock.calls.filter(([message]) => message?.type === 'pastePlainText.choose');

    beforeEach(() => readsAsMarkdown.mockReturnValue(true));

    it('is not inserted; the host is asked how to paste it', async () => {
      await paste();

      expect(readsAsMarkdown).toHaveBeenCalledWith(mockEditor, 'plain text');
      expect(insertPlainText).not.toHaveBeenCalled();
      expect(asksHost()).toEqual([[{ type: 'pastePlainText.choose', text: 'plain text' }]]);
    });

    it.each(['plain', 'code', 'markdown'])(
      'is inserted as %s once the host says so',
      async mode => {
        await messageHandler({ data: { type: 'pastePlainText', text: 'plain text', mode } });

        expect(insertPlainText).toHaveBeenCalledWith(mockEditor, 'plain text', mode);
        expect(readsAsMarkdown).not.toHaveBeenCalled();
        expect(asksHost()).toEqual([]);
      }
    );

    it('ignores a mode it does not know', async () => {
      await messageHandler({ data: { type: 'pastePlainText', text: 'plain text', mode: 'html' } });

      expect(insertPlainText).not.toHaveBeenCalled();
      expect(asksHost()).toEqual([]);
    });

    it('does not ask while focus is in the search box', async () => {
      fakeDocument.activeElement = focused('input');

      await paste();

      expect(asksHost()).toEqual([]);
    });
  });
});
