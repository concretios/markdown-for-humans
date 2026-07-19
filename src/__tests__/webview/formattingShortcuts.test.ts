/**
 * Regression tests for the `markdownForHumans.formattingShortcuts.enabled` setting.
 *
 * We avoid initializing TipTap by mocking document.readyState as "loading"
 * so initializeEditor is never invoked during module import (same harness as
 * undo-sync.test.ts). The `keydownHandler` closure that calls
 * shouldInterceptFormattingShortcut() is only created inside initializeEditor(),
 * so this suite drives the underlying gate directly via the `__testing` hook
 * instead of dispatching real keydown events.
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
  isFormattingShortcutsEnabledForTests: () => boolean;
  shouldInterceptFormattingShortcutForTests: (key: string, isMod: boolean) => boolean;
  shouldSuppressFormattingShortcutForTests: (key: string, isMod: boolean) => boolean;
};

describe('formattingShortcuts.enabled setting', () => {
  let testing: TestingModule;
  let messageHandler: (event: MessageEvent) => void;

  const setupModule = async () => {
    jest.resetModules();

    (
      global as unknown as { document: { readyState: string; addEventListener: jest.Mock } }
    ).document = {
      readyState: 'loading',
      addEventListener: jest.fn(),
    };

    const windowListeners = new Map<string, (event: unknown) => void>();
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
      postMessage: jest.fn(),
      getState: jest.fn(),
      setState: jest.fn(),
    }));
    (global as unknown as { performance: { now: () => number } }).performance = {
      now: () => 0,
    };

    const mod = await import('../../webview/editor');
    testing = mod.__testing as unknown as TestingModule;

    messageHandler = windowListeners.get('message') as (event: MessageEvent) => void;
  };

  beforeEach(async () => {
    await setupModule();
  });

  it('defaults to enabled, so Cmd+B/I/U are intercepted', () => {
    expect(testing.isFormattingShortcutsEnabledForTests()).toBe(true);

    for (const key of ['b', 'i', 'u']) {
      expect(testing.shouldInterceptFormattingShortcutForTests(key, true)).toBe(true);
    }
  });

  it('does not intercept when the mod key is not held', () => {
    expect(testing.shouldInterceptFormattingShortcutForTests('b', false)).toBe(false);
  });

  it('does not intercept keys outside b/i/u', () => {
    expect(testing.shouldInterceptFormattingShortcutForTests('s', true)).toBe(false);
  });

  it('stops intercepting Cmd/Ctrl+B/I/U once disabled via a settingsUpdate message', () => {
    messageHandler({
      data: { type: 'settingsUpdate', formattingShortcutsEnabled: false },
    } as unknown as MessageEvent);

    expect(testing.isFormattingShortcutsEnabledForTests()).toBe(false);

    for (const key of ['b', 'i', 'u']) {
      expect(testing.shouldInterceptFormattingShortcutForTests(key, true)).toBe(false);
    }
  });

  it('resumes intercepting once re-enabled via a settingsUpdate message', () => {
    messageHandler({
      data: { type: 'settingsUpdate', formattingShortcutsEnabled: false },
    } as unknown as MessageEvent);
    messageHandler({
      data: { type: 'settingsUpdate', formattingShortcutsEnabled: true },
    } as unknown as MessageEvent);

    expect(testing.isFormattingShortcutsEnabledForTests()).toBe(true);
    expect(testing.shouldInterceptFormattingShortcutForTests('b', true)).toBe(true);
  });

  it('also updates via an update message (initial host payload)', () => {
    messageHandler({
      data: { type: 'update', content: '', formattingShortcutsEnabled: false },
    } as unknown as MessageEvent);

    expect(testing.isFormattingShortcutsEnabledForTests()).toBe(false);
  });

  describe('TipTap keymap suppression (handleKeyDown gate)', () => {
    it('does not suppress TipTap formatting while enabled (default)', () => {
      for (const key of ['b', 'i', 'u']) {
        expect(testing.shouldSuppressFormattingShortcutForTests(key, true)).toBe(false);
      }
    });

    it('suppresses TipTap Mod+B/I/U once disabled, so formatting is not applied', () => {
      messageHandler({
        data: { type: 'settingsUpdate', formattingShortcutsEnabled: false },
      } as unknown as MessageEvent);

      for (const key of ['b', 'i', 'u']) {
        expect(testing.shouldSuppressFormattingShortcutForTests(key, true)).toBe(true);
      }
    });

    it('never suppresses non-formatting keys or bare keypresses', () => {
      messageHandler({
        data: { type: 'settingsUpdate', formattingShortcutsEnabled: false },
      } as unknown as MessageEvent);

      expect(testing.shouldSuppressFormattingShortcutForTests('s', true)).toBe(false);
      expect(testing.shouldSuppressFormattingShortcutForTests('b', false)).toBe(false);
    });

    it('is mutually exclusive with interception: exactly one gate is active per state', () => {
      // Enabled: intercept (stopPropagation to VS Code), don't suppress TipTap.
      expect(testing.shouldInterceptFormattingShortcutForTests('b', true)).toBe(true);
      expect(testing.shouldSuppressFormattingShortcutForTests('b', true)).toBe(false);

      messageHandler({
        data: { type: 'settingsUpdate', formattingShortcutsEnabled: false },
      } as unknown as MessageEvent);

      // Disabled: let the chord reach VS Code, suppress TipTap formatting.
      expect(testing.shouldInterceptFormattingShortcutForTests('b', true)).toBe(false);
      expect(testing.shouldSuppressFormattingShortcutForTests('b', true)).toBe(true);
    });
  });
});
