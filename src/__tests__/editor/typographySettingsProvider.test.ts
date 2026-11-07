/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Host side of the reader typography settings: what the provider
 * reads from configuration, what it posts to each rich editor, and that a
 * configuration change reaches every open editor without reopening the file.
 */

import * as vscode from 'vscode';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';

type ConfigurationListener = (event: {
  affectsConfiguration(section: string, scope?: unknown): boolean;
}) => void;

interface PostedMessage {
  type: string;
  typography?: unknown;
  [key: string]: unknown;
}

interface MockRichView {
  panel: vscode.WebviewPanel;
  webview: vscode.Webview & { postMessage: jest.Mock };
  receive(message: { type: string }): void;
  dispose(): void;
}

const NO_OVERRIDE = {
  fontFamily: null,
  fontWeight: null,
  fontSize: null,
  lineHeight: null,
  letterSpacing: null,
  wordSpacing: null,
};

describe('MarkdownEditorProvider reader typography settings', () => {
  /** User settings, keyed by full name. */
  let settings: Record<string, unknown>;
  /** `editor.*` values as seen through the `"[markdown]"` language scope. */
  let markdownEditorSettings: Record<string, unknown>;
  let configurationListeners: ConfigurationListener[];
  let restoreGetConfiguration: unknown;
  let restoreConfigurationListener: unknown;
  let restoreJoinPath: unknown;

  beforeEach(() => {
    settings = {};
    markdownEditorSettings = {};
    configurationListeners = [];

    const workspace = vscode.workspace as unknown as {
      getConfiguration: jest.Mock;
      onDidChangeConfiguration?: unknown;
    };
    restoreGetConfiguration = workspace.getConfiguration.getMockImplementation();
    workspace.getConfiguration.mockImplementation(
      (section?: string, scope?: { languageId?: string }) => ({
        get: jest.fn((key: string, defaultValue?: unknown) => {
          const fullKey = section ? `${section}.${key}` : key;
          const source =
            scope?.languageId === 'markdown' && fullKey in markdownEditorSettings
              ? markdownEditorSettings
              : settings;
          return fullKey in source ? source[fullKey] : defaultValue;
        }),
        update: jest.fn(),
      })
    );
    restoreConfigurationListener = workspace.onDidChangeConfiguration;
    workspace.onDidChangeConfiguration = jest.fn((listener: ConfigurationListener) => {
      configurationListeners.push(listener);
      return {
        dispose: () => {
          configurationListeners = configurationListeners.filter(entry => entry !== listener);
        },
      };
    });

    const mutableUri = vscode.Uri as unknown as { joinPath?: unknown };
    restoreJoinPath = mutableUri.joinPath;
    mutableUri.joinPath = (base: vscode.Uri, ...segments: string[]) =>
      fileUri([base.fsPath, ...segments].join('/'));
  });

  afterEach(() => {
    const workspace = vscode.workspace as unknown as {
      getConfiguration: jest.Mock;
      onDidChangeConfiguration?: unknown;
    };
    workspace.getConfiguration.mockImplementation(
      restoreGetConfiguration as (...args: unknown[]) => unknown
    );
    if (restoreConfigurationListener === undefined) delete workspace.onDidChangeConfiguration;
    else workspace.onDidChangeConfiguration = restoreConfigurationListener;

    const mutableUri = vscode.Uri as unknown as { joinPath?: unknown };
    if (restoreJoinPath === undefined) delete mutableUri.joinPath;
    else mutableUri.joinPath = restoreJoinPath;
  });

  function changeConfiguration(changed: Record<string, unknown>, scoped = false): void {
    Object.assign(scoped ? markdownEditorSettings : settings, changed);
    const keys = Object.keys(changed);
    for (const listener of [...configurationListeners]) {
      listener({
        affectsConfiguration: (section: string) =>
          keys.some(key => key === section || key.startsWith(`${section}.`)),
      });
    }
  }

  async function openEditors(
    provider: MarkdownEditorProvider,
    documents: Array<ReturnType<typeof createDocument>>
  ): Promise<MockRichView[]> {
    const views: MockRichView[] = [];
    for (const document of documents) {
      const view = createRichView();
      await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        view.panel,
        {} as vscode.CancellationToken
      );
      views.push(view);
    }
    return views;
  }

  const lastMessage = (view: MockRichView, type: string): PostedMessage | undefined =>
    (view.webview.postMessage.mock.calls as Array<[PostedMessage]>)
      .map(([message]) => message)
      .filter(message => message.type === type)
      .pop();

  it('posts no typography override while every setting is at its default', async () => {
    const provider = createProvider();
    const [view] = await openEditors(provider, [createDocument('/docs/guide.md', '# Guide\n')]);

    try {
      expect(lastMessage(view, 'update')?.typography).toEqual(NO_OVERRIDE);

      view.receive({ type: 'ready' });

      expect(lastMessage(view, 'settingsUpdate')?.typography).toEqual(NO_OVERRIDE);
    } finally {
      view.dispose();
      provider.dispose();
    }
  });

  it('sends the configured typography with the first document update', async () => {
    Object.assign(settings, {
      'markdownForHumans.font.family': 'Atkinson Hyperlegible, sans-serif',
      'markdownForHumans.font.weight': 500,
      'markdownForHumans.font.lineHeight': 1.8,
      'markdownForHumans.font.letterSpacing': 0.05,
      'markdownForHumans.font.wordSpacing': 0.16,
    });
    const provider = createProvider();
    const [view] = await openEditors(provider, [createDocument('/docs/guide.md', '# Guide\n')]);

    try {
      expect(lastMessage(view, 'update')?.typography).toEqual({
        fontFamily: '"Atkinson Hyperlegible", sans-serif',
        fontWeight: 500,
        fontSize: null,
        lineHeight: 1.8,
        letterSpacing: 0.05,
        wordSpacing: 0.16,
      });
    } finally {
      view.dispose();
      provider.dispose();
    }
  });

  it('clamps out-of-range values and neutralizes a hostile font family before posting', async () => {
    Object.assign(settings, {
      'markdownForHumans.font.family': 'Arial; } body { display: none',
      'markdownForHumans.font.weight': 5000,
      'markdownForHumans.font.lineHeight': 'tall',
      'markdownForHumans.font.letterSpacing': 9,
    });
    const provider = createProvider();
    const [view] = await openEditors(provider, [createDocument('/docs/guide.md', '# Guide\n')]);

    try {
      expect(lastMessage(view, 'update')?.typography).toEqual({
        ...NO_OVERRIDE,
        fontFamily: '"Arial; } body { display: none"',
        fontWeight: 900,
        letterSpacing: 0.5,
      });
    } finally {
      view.dispose();
      provider.dispose();
    }
  });

  it('applies a font change live to every open editor, including a second file and a split', async () => {
    const provider = createProvider();
    const first = createDocument('/docs/first.md', '# First\n');
    const second = createDocument('/docs/second.md', '# Second\n');
    const views = await openEditors(provider, [first, second, first]);
    for (const view of views) view.webview.postMessage.mockClear();

    try {
      changeConfiguration({
        'markdownForHumans.font.family': 'Lexend',
        'markdownForHumans.font.lineHeight': 2,
      });

      for (const view of views) {
        expect(view.webview.postMessage).toHaveBeenCalledTimes(1);
        expect(lastMessage(view, 'settingsUpdate')?.typography).toEqual({
          ...NO_OVERRIDE,
          fontFamily: '"Lexend"',
          lineHeight: 2,
        });
      }

      changeConfiguration({
        'markdownForHumans.font.family': '',
        'markdownForHumans.font.lineHeight': 1.58,
      });

      for (const view of views) {
        expect(lastMessage(view, 'settingsUpdate')?.typography).toEqual(NO_OVERRIDE);
      }
    } finally {
      for (const view of views) view.dispose();
      provider.dispose();
    }
  });

  it('does not post settings for an unrelated configuration change', async () => {
    const provider = createProvider();
    const [view] = await openEditors(provider, [createDocument('/docs/guide.md', '# Guide\n')]);
    view.webview.postMessage.mockClear();

    try {
      changeConfiguration({ 'files.autoSave': 'afterDelay' });

      expect(view.webview.postMessage).not.toHaveBeenCalled();
    } finally {
      view.dispose();
      provider.dispose();
    }
  });

  it('stops posting to an editor after it is closed', async () => {
    const provider = createProvider();
    const [closed, open] = await openEditors(provider, [
      createDocument('/docs/first.md', '# First\n'),
      createDocument('/docs/second.md', '# Second\n'),
    ]);
    closed.dispose();
    closed.webview.postMessage.mockClear();
    open.webview.postMessage.mockClear();

    try {
      changeConfiguration({ 'markdownForHumans.font.weight': 600 });

      expect(closed.webview.postMessage).not.toHaveBeenCalled();
      expect(lastMessage(open, 'settingsUpdate')?.typography).toEqual({
        ...NO_OVERRIDE,
        fontWeight: 600,
      });
    } finally {
      open.dispose();
      provider.dispose();
    }
  });

  describe('VS Code editor font opt-in', () => {
    beforeEach(() => {
      settings['editor.fontFamily'] = "Menlo, Monaco, 'Courier New', monospace";
      settings['editor.fontWeight'] = 'normal';
      settings['editor.fontSize'] = 12;
      Object.assign(markdownEditorSettings, {
        'editor.fontFamily': 'Aptos',
        'editor.fontWeight': '500',
        'editor.fontSize': 14,
      });
    });

    it('ignores editor font settings while the opt-in is off', async () => {
      const provider = createProvider();
      const [view] = await openEditors(provider, [createDocument('/docs/guide.md', '# Guide\n')]);

      try {
        expect(lastMessage(view, 'update')?.typography).toEqual(NO_OVERRIDE);
      } finally {
        view.dispose();
        provider.dispose();
      }
    });

    it('uses the "[markdown]" editor font for body text once opted in', async () => {
      settings['markdownForHumans.font.useEditorFont'] = true;
      const provider = createProvider();
      const [view] = await openEditors(provider, [createDocument('/docs/guide.md', '# Guide\n')]);

      try {
        expect(lastMessage(view, 'update')?.typography).toEqual({
          ...NO_OVERRIDE,
          fontFamily: '"Aptos"',
          fontWeight: 500,
          fontSize: 14,
        });
      } finally {
        view.dispose();
        provider.dispose();
      }
    });

    it('follows a later change to the "[markdown]" editor font live', async () => {
      settings['markdownForHumans.font.useEditorFont'] = true;
      const provider = createProvider();
      const [view] = await openEditors(provider, [createDocument('/docs/guide.md', '# Guide\n')]);
      view.webview.postMessage.mockClear();

      try {
        changeConfiguration({ 'editor.fontFamily': 'Lexend', 'editor.fontSize': 16 }, true);

        expect(lastMessage(view, 'settingsUpdate')?.typography).toEqual({
          ...NO_OVERRIDE,
          fontFamily: '"Lexend"',
          fontWeight: 500,
          fontSize: 16,
        });
      } finally {
        view.dispose();
        provider.dispose();
      }
    });

    it('turns on and off live', async () => {
      const provider = createProvider();
      const [view] = await openEditors(provider, [createDocument('/docs/guide.md', '# Guide\n')]);

      try {
        changeConfiguration({ 'markdownForHumans.font.useEditorFont': true });
        expect(lastMessage(view, 'settingsUpdate')?.typography).toEqual({
          ...NO_OVERRIDE,
          fontFamily: '"Aptos"',
          fontWeight: 500,
          fontSize: 14,
        });

        changeConfiguration({ 'markdownForHumans.font.useEditorFont': false });
        expect(lastMessage(view, 'settingsUpdate')?.typography).toEqual(NO_OVERRIDE);
      } finally {
        view.dispose();
        provider.dispose();
      }
    });
  });
});

function createProvider(): MarkdownEditorProvider {
  return new MarkdownEditorProvider({
    extensionUri: fileUri('/extension'),
    subscriptions: [],
    globalState: {
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: jest.fn(async () => undefined),
    },
    extension: { packageJSON: { version: '0.0.0-test' } },
  } as unknown as vscode.ExtensionContext);
}

function createDocument(fsPath: string, content: string) {
  return {
    uri: fileUri(fsPath),
    fileName: fsPath,
    languageId: 'markdown',
    version: 1,
    isDirty: false,
    getText: jest.fn(() => content),
    lineCount: content.split('\n').length,
    positionAt: jest.fn((offset: number) => new vscode.Position(0, offset)),
    save: jest.fn(async () => true),
  };
}

function createRichView(): MockRichView {
  let receiveMessage: ((message: { type: string }) => void) | undefined;
  let disposePanel: (() => void) | undefined;
  const webview = {
    cspSource: 'vscode-webview://typography',
    html: '',
    options: {},
    asWebviewUri: jest.fn((uri: vscode.Uri) => uri),
    postMessage: jest.fn(() => Promise.resolve(true)),
    onDidReceiveMessage: jest.fn((listener: (message: { type: string }) => void) => {
      receiveMessage = listener;
      return { dispose: jest.fn() };
    }),
  } as unknown as vscode.Webview & { postMessage: jest.Mock };
  const panel = {
    webview,
    active: true,
    visible: true,
    onDidChangeViewState: jest.fn(() => ({ dispose: jest.fn() })),
    onDidDispose: jest.fn((listener: () => void) => {
      disposePanel = listener;
      return { dispose: jest.fn() };
    }),
  } as unknown as vscode.WebviewPanel;

  return {
    panel,
    webview,
    receive(message) {
      if (!receiveMessage) throw new Error('The panel message listener is not registered.');
      receiveMessage(message);
    },
    dispose() {
      if (!disposePanel) throw new Error('The panel disposal listener is not registered.');
      disposePanel();
    },
  };
}

function fileUri(fsPath: string): vscode.Uri {
  return {
    fsPath,
    path: fsPath,
    scheme: 'file',
    toString: () => `file://${fsPath}`,
  } as vscode.Uri;
}
