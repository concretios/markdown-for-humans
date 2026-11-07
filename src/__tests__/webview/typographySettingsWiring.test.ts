/**
 * Wiring test for reader typography settings in the webview entry point.
 *
 * `update` and `settingsUpdate` messages must both apply the `typography`
 * field to the document root, so a configuration change takes effect in an
 * open editor without reopening the file.
 *
 * We avoid initializing TipTap by mocking document.readyState as "loading"
 * so initializeEditor is never invoked during module import (same harness as
 * formattingShortcuts.test.ts).
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
jest.mock('./../../webview/utils/copyMarkdown', () => ({ copySelectionAsMarkdown: jest.fn() }));
jest.mock('./../../webview/utils/outline', () => ({ buildOutlineFromEditor: jest.fn(() => []) }));
jest.mock('./../../webview/utils/scrollToHeading', () => ({ scrollToHeading: jest.fn() }));

// These tests load editor.ts via dynamic import(), so the file has no top-level
// import/export and TypeScript would treat it as a global script. Mark it as a
// module so its declarations stay out of the sibling webview tests' scope.
export {};

describe('reader typography settings in the webview', () => {
  let messageHandler: (event: MessageEvent) => void;
  let rootStyle: Map<string, string>;

  const post = (data: Record<string, unknown>) =>
    messageHandler({ data } as unknown as MessageEvent);

  beforeEach(async () => {
    jest.resetModules();

    rootStyle = new Map();
    (global as unknown as { document: unknown }).document = {
      readyState: 'loading',
      addEventListener: jest.fn(),
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => rootStyle.set(name, value),
          removeProperty: (name: string) => rootStyle.delete(name),
        },
      },
    };

    const windowListeners = new Map<string, (event: unknown) => void>();
    (global as unknown as { window: unknown }).window = {
      setTimeout,
      clearTimeout,
      addEventListener: jest.fn((type: string, handler: (event: unknown) => void) => {
        windowListeners.set(type, handler);
      }),
    };
    (global as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = jest.fn(() => ({
      postMessage: jest.fn(),
      getState: jest.fn(),
      setState: jest.fn(),
    }));
    (global as unknown as { performance: { now: () => number } }).performance = {
      now: () => 0,
    };

    await import('../../webview/editor');
    messageHandler = windowListeners.get('message') as (event: MessageEvent) => void;
  });

  it('applies typography from a settingsUpdate message without reopening the file', () => {
    post({
      type: 'settingsUpdate',
      typography: {
        fontFamily: '"Lexend"',
        fontWeight: 500,
        fontSize: null,
        lineHeight: 1.8,
        letterSpacing: 0.05,
        wordSpacing: 0.16,
      },
    });

    expect(Object.fromEntries(rootStyle)).toEqual({
      '--md-font-family': '"Lexend", var(--vscode-font-family)',
      '--md-font-weight': '500',
      '--md-line-height': '1.8',
      '--md-letter-spacing': '0.05em',
      '--md-word-spacing': '0.16em',
      '--md-code-text-spacing': 'normal',
    });
  });

  it('removes the overrides when a later settingsUpdate returns to the defaults', () => {
    post({
      type: 'settingsUpdate',
      typography: { fontFamily: '"Lexend"', fontWeight: 500, lineHeight: 1.8 },
    });
    expect(rootStyle.size).toBe(3);

    post({ type: 'settingsUpdate', typography: {} });

    expect(rootStyle.size).toBe(0);
  });

  it('keeps the current typography when a message carries no typography field', () => {
    post({ type: 'settingsUpdate', typography: { fontWeight: 500 } });

    post({ type: 'settingsUpdate', skipResizeWarning: true });

    expect(rootStyle.get('--md-font-weight')).toBe('500');
  });

  it('scales the editor font size from the VS Code editor font opt-in with zoom', () => {
    post({
      type: 'settingsUpdate',
      zoom: 150,
      typography: { fontSize: 16 },
    });

    expect(rootStyle.get('--md-editor-font-size')).toBe('16px');
    expect(rootStyle.get('--md-base-size-override')).toBe(
      'calc(var(--md-editor-font-size, var(--vscode-editor-font-size, 14px)) * 1.5)'
    );
  });

  it('leaves the page untouched at the default settings', () => {
    post({
      type: 'settingsUpdate',
      zoom: 100,
      typography: {
        fontFamily: null,
        fontWeight: null,
        fontSize: null,
        lineHeight: null,
        letterSpacing: null,
        wordSpacing: null,
      },
    });

    expect(rootStyle.size).toBe(0);
  });
});
