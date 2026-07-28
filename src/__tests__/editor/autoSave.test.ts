import * as vscode from 'vscode';
import { Position } from 'vscode';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';

// Helper to create a minimal mock TextDocument backing an `applyEdit` call.
function createDocument(content: string, uri = 'file://test.md') {
  return {
    getText: jest.fn(() => content),
    uri: { toString: () => uri, scheme: 'file' },
    positionAt: jest.fn((offset: number) => new Position(0, offset)),
    isDirty: false,
    save: jest.fn(async () => true),
  };
}

function mockConfig(overrides: Record<string, unknown>) {
  return {
    get: jest.fn((key: string, defaultValue?: unknown) =>
      key in overrides ? overrides[key] : defaultValue
    ),
    update: jest.fn(),
  } as unknown as vscode.WorkspaceConfiguration;
}

type ProviderInternals = {
  handleWebviewMessage: (
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: { postMessage: jest.Mock }
  ) => void;
  autoSaveTimers: Map<string, unknown>;
};

describe('markdownForHumans.autoSave.enabled', () => {
  let getConfigurationSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    getConfigurationSpy?.mockRestore();
  });

  it('does not save automatically when the setting is off (default)', async () => {
    getConfigurationSpy = jest
      .spyOn(vscode.workspace, 'getConfiguration')
      .mockReturnValue(mockConfig({ 'markdownForHumans.autoSave.enabled': false }));

    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('hello world');
    document.isDirty = true;
    const webview = { postMessage: jest.fn() };

    workspaceApplyEdit().mockResolvedValue(true);

    (provider as unknown as ProviderInternals).handleWebviewMessage(
      { type: 'edit', content: 'hi world', editReason: 'typing' },
      document as unknown as vscode.TextDocument,
      webview
    );

    await flushMicrotasks();
    jest.advanceTimersByTime(5000);
    await flushMicrotasks();

    expect(document.save).not.toHaveBeenCalled();
  });

  it('saves a short delay after typing stops once enabled', async () => {
    getConfigurationSpy = jest
      .spyOn(vscode.workspace, 'getConfiguration')
      .mockReturnValue(mockConfig({ 'markdownForHumans.autoSave.enabled': true }));

    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('hello world');
    document.isDirty = true;
    const webview = { postMessage: jest.fn() };

    workspaceApplyEdit().mockResolvedValue(true);

    (provider as unknown as ProviderInternals).handleWebviewMessage(
      { type: 'edit', content: 'hi world', editReason: 'typing' },
      document as unknown as vscode.TextDocument,
      webview
    );

    await flushMicrotasks();
    expect(document.save).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1000);
    await flushMicrotasks();

    expect(document.save).toHaveBeenCalledTimes(1);
  });

  it('debounces repeated edits into a single save', async () => {
    getConfigurationSpy = jest
      .spyOn(vscode.workspace, 'getConfiguration')
      .mockReturnValue(mockConfig({ 'markdownForHumans.autoSave.enabled': true }));

    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('hello world');
    document.isDirty = true;
    const webview = { postMessage: jest.fn() };

    workspaceApplyEdit().mockResolvedValue(true);

    (provider as unknown as ProviderInternals).handleWebviewMessage(
      { type: 'edit', content: 'hi world', editReason: 'typing' },
      document as unknown as vscode.TextDocument,
      webview
    );
    await flushMicrotasks();
    jest.advanceTimersByTime(500);

    (provider as unknown as ProviderInternals).handleWebviewMessage(
      { type: 'edit', content: 'hi world again', editReason: 'typing' },
      document as unknown as vscode.TextDocument,
      webview
    );
    await flushMicrotasks();
    jest.advanceTimersByTime(500);
    expect(document.save).not.toHaveBeenCalled();

    jest.advanceTimersByTime(500);
    await flushMicrotasks();

    expect(document.save).toHaveBeenCalledTimes(1);
  });

  it('does not save when the document is already clean', async () => {
    getConfigurationSpy = jest
      .spyOn(vscode.workspace, 'getConfiguration')
      .mockReturnValue(mockConfig({ 'markdownForHumans.autoSave.enabled': true }));

    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('hi world');
    document.isDirty = false;
    const webview = { postMessage: jest.fn() };

    workspaceApplyEdit().mockResolvedValue(true);

    (provider as unknown as ProviderInternals).handleWebviewMessage(
      { type: 'edit', content: 'hi world', editReason: 'typing' },
      document as unknown as vscode.TextDocument,
      webview
    );
    await flushMicrotasks();
    jest.advanceTimersByTime(1000);
    await flushMicrotasks();

    expect(document.save).not.toHaveBeenCalled();
  });

  it('skips untitled documents even when enabled', async () => {
    getConfigurationSpy = jest
      .spyOn(vscode.workspace, 'getConfiguration')
      .mockReturnValue(mockConfig({ 'markdownForHumans.autoSave.enabled': true }));

    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('hello world', 'untitled:Untitled-1');
    document.uri.scheme = 'untitled';
    document.isDirty = true;
    const webview = { postMessage: jest.fn() };

    workspaceApplyEdit().mockResolvedValue(true);

    (provider as unknown as ProviderInternals).handleWebviewMessage(
      { type: 'edit', content: 'hi world', editReason: 'typing' },
      document as unknown as vscode.TextDocument,
      webview
    );
    await flushMicrotasks();
    jest.advanceTimersByTime(5000);
    await flushMicrotasks();

    expect(document.save).not.toHaveBeenCalled();
  });

  it('does not schedule a save for save-policy-enforce edits', async () => {
    getConfigurationSpy = jest
      .spyOn(vscode.workspace, 'getConfiguration')
      .mockReturnValue(mockConfig({ 'markdownForHumans.autoSave.enabled': true }));

    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('hello world');
    document.isDirty = true;
    const webview = { postMessage: jest.fn() };

    workspaceApplyEdit().mockResolvedValue(true);

    (provider as unknown as ProviderInternals).handleWebviewMessage(
      { type: 'edit', content: 'hi world', editReason: 'save-policy-enforce' },
      document as unknown as vscode.TextDocument,
      webview
    );
    await flushMicrotasks();
    jest.advanceTimersByTime(5000);
    await flushMicrotasks();

    expect(document.save).not.toHaveBeenCalled();
  });
});

function workspaceApplyEdit() {
  return vscode.workspace.applyEdit as jest.Mock;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
