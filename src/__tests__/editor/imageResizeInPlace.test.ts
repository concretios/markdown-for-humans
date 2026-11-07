import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';
import * as vscode from 'vscode';

jest.mock('vscode', () => ({
  l10n: {
    t: (message: string, ...args: unknown[]) =>
      message.replace(/\{(\d+)\}/g, (m, i) =>
        args[Number(i)] === undefined ? m : String(args[Number(i)])
      ),
    bundle: undefined,
  },
  window: {
    showErrorMessage: jest.fn(),
    showInformationMessage: jest.fn(),
    showWarningMessage: jest.fn(),
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
    fs: {
      createDirectory: jest.fn(),
      writeFile: jest.fn(),
      readFile: jest.fn(),
      stat: jest.fn(),
      delete: jest.fn(),
      rename: jest.fn(),
    },
    findFiles: jest.fn(),
    openTextDocument: jest.fn(),
  },
  Uri: {
    file: jest.fn((p: string) => ({ fsPath: p, scheme: 'file' })),
  },
  TreeItem: class TreeItem {
    public iconPath: unknown;
    public description?: string;
    public command?: unknown;
    public contextValue?: string;
    constructor(
      public label: unknown,
      public collapsibleState?: unknown
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
      public color?: unknown
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
  ConfigurationTarget: {
    Global: 1,
  },
  WorkspaceEdit: jest.fn(),
  Range: jest.fn(),
  Position: jest.fn(),
}));

function createMockTextDocument(content: string): vscode.TextDocument {
  return {
    getText: jest.fn(() => content),
    uri: vscode.Uri.file('/workspace/docs/doc.md'),
    fileName: '/workspace/docs/doc.md',
    lineCount: content.split('\n').length,
  } as unknown as vscode.TextDocument;
}

describe('MarkdownEditorProvider - Resize (in-place + workspace backups)', () => {
  let provider: MarkdownEditorProvider;
  let mockContext: vscode.ExtensionContext;
  let mockWebview: { postMessage: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-12-15T12:34:56.000Z'));

    mockContext = {
      extensionUri: { fsPath: '/extension' } as vscode.Uri,
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    mockWebview = {
      postMessage: jest.fn(),
    };

    provider = new MarkdownEditorProvider(mockContext);
    (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) = [
      { uri: { fsPath: '/workspace' } as vscode.Uri } as vscode.WorkspaceFolder,
    ];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates a backup under .md4h/image-backups and overwrites the original image file', async () => {
    const document = createMockTextDocument('# test');

    // Image exists
    (vscode.workspace.fs.stat as jest.Mock).mockImplementation((uri: vscode.Uri) => {
      // For image file check, resolve (file exists)
      if (uri.fsPath.includes('cat.png') && !uri.fsPath.includes('image-backups')) {
        return Promise.resolve({} as vscode.FileStat);
      }
      // For backup collision detection, reject (file doesn't exist - no collision)
      return Promise.reject(new Error('File not found'));
    });
    // Original bytes
    (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(new Uint8Array([9, 9, 9]));
    (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
    (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);

    const message = {
      type: 'resizeImage',
      imagePath: './images/cat.png',
      newWidth: 400,
      newHeight: 300,
      originalWidth: 800,
      originalHeight: 600,
      imageData: 'data:image/png;base64,AAAA',
    };

    await (
      provider as unknown as {
        handleResizeImage: (
          message: unknown,
          doc: vscode.TextDocument,
          webview: { postMessage: jest.Mock }
        ) => Promise<void>;
      }
    ).handleResizeImage(message, document, mockWebview);

    // Backup write - flat structure (single directory)
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fsPath: expect.stringMatching(
          /([A-Za-z]:)?[/\\]workspace[/\\](docs[/\\])?\.md4h[/\\]image-backups[/\\]original_cat_800x600px_\d{8}-\d{6}\.png$/
        ),
      }),
      new Uint8Array([9, 9, 9])
    );

    // Verify backup directory is created (single level, not nested)
    expect(vscode.workspace.fs.createDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        fsPath: expect.stringMatching(
          /([A-Za-z]:)?[/\\]workspace[/\\](docs[/\\])?\.md4h[/\\]image-backups$/
        ),
      })
    );

    // Original overwrite write
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fsPath: expect.stringMatching(
          /([A-Za-z]:)?[/\\]workspace[/\\]docs[/\\]images[/\\]cat\.png$/
        ),
      }),
      expect.any(Uint8Array)
    );

    expect(vscode.workspace.fs.delete).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.rename).not.toHaveBeenCalled();

    const resizedMessage = mockWebview.postMessage.mock.calls.find(
      (call: unknown[]) => (call[0] as { type?: string })?.type === 'imageResized'
    )?.[0];
    expect(resizedMessage).toBeDefined();
    expect(resizedMessage.success).toBe(true);
    expect(resizedMessage.imagePath).toBe('./images/cat.png');
    // Backup path can be relative (../) or same-level (./) depending on path structure
    expect(resizedMessage.backupPath).toMatch(/\.md4h[/\\]image-backups[/\\]/);
    expect(resizedMessage.newImagePath).toBeUndefined();
  });

  it('handles collision detection when backup file already exists', async () => {
    const document = createMockTextDocument('# test');

    // Image exists
    (vscode.workspace.fs.stat as jest.Mock).mockImplementation((uri: vscode.Uri) => {
      const path = uri.fsPath;
      // Image file exists
      if (path.includes('cat.png') && !path.includes('image-backups')) {
        return Promise.resolve({} as vscode.FileStat);
      }
      // First backup path exists (collision)
      if (path.includes('original_cat_800x600px_20251215-123456.png') && !path.includes('-2')) {
        return Promise.resolve({} as vscode.FileStat);
      }
      // -2 version doesn't exist (available)
      return Promise.reject(new Error('File not found'));
    });
    (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(new Uint8Array([9, 9, 9]));
    (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
    (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);

    const message = {
      type: 'resizeImage',
      imagePath: './images/cat.png',
      newWidth: 400,
      newHeight: 300,
      originalWidth: 800,
      originalHeight: 600,
      imageData: 'data:image/png;base64,AAAA',
    };

    await (
      provider as unknown as {
        handleResizeImage: (
          message: unknown,
          doc: vscode.TextDocument,
          webview: { postMessage: jest.Mock }
        ) => Promise<void>;
      }
    ).handleResizeImage(message, document, mockWebview);

    // Should write to -2 version due to collision
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fsPath: expect.stringMatching(
          /([A-Za-z]:)?[/\\]workspace[/\\](docs[/\\])?\.md4h[/\\]image-backups[/\\]original_cat_800x600px_\d{8}-\d{6}-2\.png$/
        ),
      }),
      new Uint8Array([9, 9, 9])
    );
  });

  it('creates backup for external image with _external suffix (after user confirms)', async () => {
    const document = createMockTextDocument('# test');

    (vscode.workspace.fs.stat as jest.Mock).mockImplementation((uri: vscode.Uri) => {
      const path = uri.fsPath;
      // External image file exists
      if (path === '/Users/external/image.png') {
        return Promise.resolve({} as vscode.FileStat);
      }
      // Backup doesn't exist
      return Promise.reject(new Error('File not found'));
    });
    (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(new Uint8Array([9, 9, 9]));
    (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
    (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    // SECURITY contract: writes outside the workspace are gated by a modal
    // confirm. Simulate the user clicking "Overwrite".
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Overwrite');

    const message = {
      type: 'resizeImage',
      imagePath: '/Users/external/image.png',
      absolutePath: '/Users/external/image.png',
      newWidth: 400,
      newHeight: 300,
      originalWidth: 800,
      originalHeight: 600,
      imageData: 'data:image/png;base64,AAAA',
    };

    await (
      provider as unknown as {
        handleResizeImage: (
          message: unknown,
          doc: vscode.TextDocument,
          webview: { postMessage: jest.Mock }
        ) => Promise<void>;
      }
    ).handleResizeImage(message, document, mockWebview);

    // The user must have been shown the resolved external path before write.
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('/Users/external/image.png'),
      expect.objectContaining({ modal: true }),
      'Overwrite'
    );

    // After confirmation, backup is created in workspace with _external suffix.
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fsPath: expect.stringMatching(
          /([A-Za-z]:)?[/\\]workspace[/\\](docs[/\\])?\.md4h[/\\]image-backups[/\\]original_image_800x600px_\d{8}-\d{6}_external\.png$/
        ),
      }),
      new Uint8Array([9, 9, 9])
    );
  });

  it('does NOT write when user cancels the external-resize confirm prompt (security)', async () => {
    const document = createMockTextDocument('# test');

    (vscode.workspace.fs.stat as jest.Mock).mockImplementation((uri: vscode.Uri) => {
      if (uri.fsPath === '/etc/passwd') {
        return Promise.resolve({} as vscode.FileStat);
      }
      return Promise.reject(new Error('File not found'));
    });
    (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(new Uint8Array([1, 2, 3]));
    (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    // User dismisses the dialog (returns undefined).
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    const message = {
      type: 'resizeImage',
      imagePath: '/etc/passwd',
      absolutePath: '/etc/passwd',
      newWidth: 1,
      newHeight: 1,
      imageData: 'data:image/png;base64,AAAA',
    };

    await (
      provider as unknown as {
        handleResizeImage: (
          message: unknown,
          doc: vscode.TextDocument,
          webview: { postMessage: jest.Mock }
        ) => Promise<void>;
      }
    ).handleResizeImage(message, document, mockWebview);

    // The prompt MUST have been shown (defense-in-depth UX).
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    // No write to /etc/passwd or anywhere else.
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('handles multiple rapid resizes with collision detection', async () => {
    const document = createMockTextDocument('# test');

    let callCount = 0;
    (vscode.workspace.fs.stat as jest.Mock).mockImplementation((uri: vscode.Uri) => {
      const path = uri.fsPath;
      // Image file exists
      if (path.includes('cat.png') && !path.includes('image-backups')) {
        return Promise.resolve({} as vscode.FileStat);
      }
      // Simulate multiple backups already existing
      if (path.includes('image-backups')) {
        callCount++;
        // First 3 backup paths exist, 4th is available
        if (callCount <= 3) {
          return Promise.resolve({} as vscode.FileStat);
        }
      }
      return Promise.reject(new Error('File not found'));
    });
    (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(new Uint8Array([9, 9, 9]));
    (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
    (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);

    const message = {
      type: 'resizeImage',
      imagePath: './images/cat.png',
      newWidth: 400,
      newHeight: 300,
      originalWidth: 800,
      originalHeight: 600,
      imageData: 'data:image/png;base64,AAAA',
    };

    await (
      provider as unknown as {
        handleResizeImage: (
          message: unknown,
          doc: vscode.TextDocument,
          webview: { postMessage: jest.Mock }
        ) => Promise<void>;
      }
    ).handleResizeImage(message, document, mockWebview);

    // Should write to -4 version (after checking -1, -2, -3)
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fsPath: expect.stringMatching(
          /([A-Za-z]:)?[/\\]workspace[/\\](docs[/\\])?\.md4h[/\\]image-backups[/\\]original_cat_800x600px_\d{8}-\d{6}-4\.png$/
        ),
      }),
      new Uint8Array([9, 9, 9])
    );
  });

  it('creates only single backup directory (not nested)', async () => {
    const document = createMockTextDocument('# test');

    (vscode.workspace.fs.stat as jest.Mock).mockImplementation((uri: vscode.Uri) => {
      const path = uri.fsPath;
      if (path.includes('cat.png') && !path.includes('image-backups')) {
        return Promise.resolve({} as vscode.FileStat);
      }
      return Promise.reject(new Error('File not found'));
    });
    (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(new Uint8Array([9, 9, 9]));
    (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
    (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);

    const message = {
      type: 'resizeImage',
      imagePath: './images/cat.png',
      newWidth: 400,
      newHeight: 300,
      originalWidth: 800,
      originalHeight: 600,
      imageData: 'data:image/png;base64,AAAA',
    };

    await (
      provider as unknown as {
        handleResizeImage: (
          message: unknown,
          doc: vscode.TextDocument,
          webview: { postMessage: jest.Mock }
        ) => Promise<void>;
      }
    ).handleResizeImage(message, document, mockWebview);

    // Should only create the single backup root directory
    expect(vscode.workspace.fs.createDirectory).toHaveBeenCalledTimes(1);
    expect(vscode.workspace.fs.createDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        fsPath: expect.stringMatching(
          /([A-Za-z]:)?[/\\]workspace[/\\](docs[/\\])?\.md4h[/\\]image-backups$/
        ),
      })
    );
  });
});
