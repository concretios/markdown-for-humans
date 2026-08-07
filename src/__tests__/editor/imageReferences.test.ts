import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';
import * as vscode from 'vscode';

jest.mock('vscode', () => ({
  window: {
    showErrorMessage: jest.fn(),
    showInformationMessage: jest.fn(),
  },
  workspace: {
    getWorkspaceFolder: jest.fn(),
    workspaceFolders: undefined,
    getConfiguration: jest.fn(() => ({
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: jest.fn(),
    })),
    onDidChangeTextDocument: jest.fn(),
    onDidChangeConfiguration: jest.fn(),
    applyEdit: jest.fn(),
    findFiles: jest.fn(),
    openTextDocument: jest.fn(),
    fs: {
      stat: jest.fn(),
      readFile: jest.fn(),
      writeFile: jest.fn(),
      createDirectory: jest.fn(),
      delete: jest.fn(),
      rename: jest.fn(),
    },
  },
  Uri: {
    file: jest.fn((p: string) => ({ fsPath: p, scheme: 'file' })),
  },
  TreeItem: class TreeItem {
    public iconPath:
      | vscode.Uri
      | { light: vscode.Uri; dark: vscode.Uri }
      | vscode.ThemeIcon
      | undefined;
    public description?: string;
    public command?: vscode.Command;
    public contextValue?: string;
    constructor(
      public label: string | vscode.TreeItemLabel,
      public collapsibleState?: vscode.TreeItemCollapsibleState
    ) {}
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
  ThemeIcon: class ThemeIcon {
    constructor(
      public id: string,
      public color?: vscode.ThemeColor
    ) {}
  },
  ThemeColor: class ThemeColor {
    constructor(public id: string) {}
  },
  EventEmitter: class EventEmitter<T> {
    public event = jest.fn();
    fire = jest.fn((_data?: T) => {});
    dispose = jest.fn();
  },
  ViewColumn: {
    Beside: 2,
  },
  commands: {
    executeCommand: jest.fn(),
    registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
  },
  WorkspaceEdit: jest.fn(),
  Range: jest.fn(),
  Position: jest.fn(),
}));

function createMockTextDocument(content: string): Partial<vscode.TextDocument> {
  return {
    getText: jest.fn(() => content),
    uri: {
      scheme: 'file',
      fsPath: '/workspace/docs/doc.md',
      toString: () => 'file:/workspace/docs/doc.md',
    } as vscode.Uri,
    fileName: '/workspace/docs/doc.md',
    lineCount: content.split('\n').length,
  };
}

describe('MarkdownEditorProvider - Image reference lookup', () => {
  let provider: MarkdownEditorProvider;
  let mockWebview: { postMessage: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new MarkdownEditorProvider({
      extensionUri: { fsPath: '/extension' } as vscode.Uri,
      subscriptions: [],
    } as unknown as vscode.ExtensionContext);
    mockWebview = { postMessage: jest.fn() };
  });

  it('returns current file count and other-file references for an image', async () => {
    const document = createMockTextDocument(
      ['# Doc', '![A](./images/cat.png)', '', '![B](./images/cat.png)'].join('\n')
    );

    const files = [
      { fsPath: '/workspace/docs/doc.md', scheme: 'file' },
      { fsPath: '/workspace/docs/other.md', scheme: 'file' },
      { fsPath: '/workspace/README.md', scheme: 'file' },
    ];

    const fileContents = new Map<string, string>([
      ['/workspace/docs/doc.md', (document.getText as jest.Mock)?.() ?? ''],
      ['/workspace/docs/other.md', '![X](./images/cat.png)'],
      ['/workspace/README.md', '![X](docs/images/cat.png)'],
    ]);

    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue(files);
    (vscode.workspace.openTextDocument as jest.Mock).mockImplementation(async (uri: vscode.Uri) => {
      const text = fileContents.get(uri.fsPath) ?? '';
      return {
        uri,
        getText: () => text,
        lineCount: text.split('\n').length,
      };
    });

    (
      provider as unknown as {
        handleWebviewMessage: (
          message: { type: string; [key: string]: unknown },
          doc: vscode.TextDocument,
          webview: vscode.Webview
        ) => void;
      }
    ).handleWebviewMessage(
      { type: 'getImageReferences', requestId: 'req-1', imagePath: './images/cat.png' },
      document as vscode.TextDocument,
      mockWebview as unknown as vscode.Webview
    );

    // Let the async handler run
    await new Promise<void>(resolve => setImmediate(() => resolve()));

    const response = mockWebview.postMessage.mock.calls.find(
      (call: unknown[]) =>
        (call[0] as { type?: string; requestId?: string })?.type === 'imageReferences' &&
        (call[0] as { type?: string; requestId?: string })?.requestId === 'req-1'
    )?.[0];

    expect(response).toBeDefined();
    expect(response.currentFileCount).toBe(2);
    expect(response.otherFiles).toHaveLength(2);
  });
});
