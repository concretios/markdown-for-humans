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
  preservePendingAutoSaveOnFinalPanelDispose: (document: vscode.TextDocument) => void;
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

  it('starts the debounce at typing time but waits for the queued edit before saving', async () => {
    getConfigurationSpy = jest
      .spyOn(vscode.workspace, 'getConfiguration')
      .mockReturnValue(mockConfig({ 'markdownForHumans.autoSave.enabled': true }));

    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('hello world');
    document.isDirty = true;
    const webview = { postMessage: jest.fn() };
    let finishEdit: ((success: boolean) => void) | undefined;

    workspaceApplyEdit().mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          finishEdit = resolve;
        })
    );

    (provider as unknown as ProviderInternals).handleWebviewMessage(
      { type: 'edit', content: 'hi world', editReason: 'typing' },
      document as unknown as vscode.TextDocument,
      webview
    );

    await flushMicrotasks();
    expect(finishEdit).toBeDefined();

    jest.advanceTimersByTime(1000);
    await flushMicrotasks();
    expect(document.save).not.toHaveBeenCalled();

    finishEdit?.(true);
    await jest.advanceTimersByTimeAsync(0);

    expect(document.save).toHaveBeenCalledTimes(1);
  });

  it('does not let an expired slow edit bypass the debounce for newer typing', async () => {
    getConfigurationSpy = jest
      .spyOn(vscode.workspace, 'getConfiguration')
      .mockReturnValue(mockConfig({ 'markdownForHumans.autoSave.enabled': true }));

    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('hello world');
    document.isDirty = true;
    const webview = { postMessage: jest.fn() };
    let finishFirstEdit: ((success: boolean) => void) | undefined;

    workspaceApplyEdit()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>(resolve => {
            finishFirstEdit = resolve;
          })
      )
      .mockResolvedValue(true);

    (provider as unknown as ProviderInternals).handleWebviewMessage(
      { type: 'edit', content: 'first edit', editReason: 'typing' },
      document as unknown as vscode.TextDocument,
      webview
    );
    await flushMicrotasks();

    await jest.advanceTimersByTimeAsync(1000);
    expect(document.save).not.toHaveBeenCalled();

    (provider as unknown as ProviderInternals).handleWebviewMessage(
      { type: 'edit', content: 'newer edit', editReason: 'typing' },
      document as unknown as vscode.TextDocument,
      webview
    );
    await flushMicrotasks();

    finishFirstEdit?.(true);
    await flushMicrotasks();
    expect(document.save).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(999);
    expect(document.save).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

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

  it('persists an armed custom autosave when the final panel closes before its edit settles', async () => {
    getConfigurationSpy = jest
      .spyOn(vscode.workspace, 'getConfiguration')
      .mockReturnValue(mockConfig({ 'markdownForHumans.autoSave.enabled': true }));

    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('before close');
    const webview = { postMessage: jest.fn() };
    let finishEdit: ((accepted: boolean) => void) | undefined;
    workspaceApplyEdit().mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          finishEdit = resolve;
        })
    );
    const internal = provider as unknown as ProviderInternals;

    internal.handleWebviewMessage(
      { type: 'edit', content: 'accepted after close', editReason: 'typing' },
      document as unknown as vscode.TextDocument,
      webview
    );
    await flushMicrotasks();
    expect(internal.autoSaveTimers.size).toBe(1);

    internal.preservePendingAutoSaveOnFinalPanelDispose(document as unknown as vscode.TextDocument);
    document.isDirty = true;
    finishEdit?.(true);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(document.save).toHaveBeenCalledTimes(1);
    expect(internal.autoSaveTimers.size).toBe(0);
  });
});

function workspaceApplyEdit() {
  return vscode.workspace.applyEdit as jest.Mock;
}

async function flushMicrotasks() {
  // Modern fake timers virtualize queueMicrotask, which the document edit
  // coordinator uses to keep same-turn typing eligible for coalescing.
  await jest.advanceTimersByTimeAsync(0);
}
