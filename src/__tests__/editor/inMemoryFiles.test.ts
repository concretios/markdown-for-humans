/**
 * In-Memory File Support Tests
 *
 * Tests for untitled (unsaved) file support in Markdown Editor.
 * Verifies that untitled files work correctly with and without workspace folders,
 * including image resolution, warning dialogs, and all image operations.
 */

import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';
import * as vscode from 'vscode';
import * as os from 'os';

type UriLike = { fsPath: string; scheme: string };
type MockTextDocument = {
  getText: jest.Mock<string, []>;
  languageId: string;
  uri: vscode.Uri;
  fileName: string;
};

function getUriFsPath(uri: unknown): string {
  if (typeof uri !== 'object' || uri === null) return '';
  const value = (uri as Partial<UriLike>).fsPath;
  return typeof value === 'string' ? value : '';
}

function getUriScheme(uri: unknown): string {
  if (typeof uri !== 'object' || uri === null) return 'file';
  const value = (uri as Partial<UriLike>).scheme;
  return typeof value === 'string' ? value : 'file';
}

// Mock vscode module
jest.mock('vscode', () => ({
  commands: {
    executeCommand: jest.fn(),
    registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
  },
  window: {
    showInformationMessage: jest.fn(),
    showErrorMessage: jest.fn(),
  },
  workspace: {
    getWorkspaceFolder: jest.fn(),
    workspaceFolders: undefined,
    getConfiguration: jest.fn(() => ({
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: jest.fn(),
    })),
    applyEdit: jest.fn(),
    onDidChangeTextDocument: jest.fn(),
    onDidChangeConfiguration: jest.fn(),
    fs: {
      createDirectory: jest.fn(),
      writeFile: jest.fn(),
      readFile: jest.fn(),
      stat: jest.fn(),
    },
  },
  Uri: {
    file: jest.fn((path: string) => ({ fsPath: path, scheme: 'file' })),
    joinPath: jest.fn((base: unknown, ...paths: string[]) => {
      const basePath = getUriFsPath(base);
      const joined = [basePath, ...paths].filter(Boolean).join('/');
      return { fsPath: joined, scheme: getUriScheme(base) };
    }),
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
  Range: jest.fn(),
  Position: jest.fn(),
  WorkspaceEdit: jest.fn(),
  ConfigurationTarget: {
    Global: 1,
  },
}));

function createMockTextDocument(content: string, languageId = 'markdown'): MockTextDocument {
  return {
    getText: jest.fn(() => content),
    languageId,
    uri: {
      scheme: 'file',
      fsPath: '/test/document.md',
      toString: () => 'file:/test/document.md',
    } as unknown as vscode.Uri,
    fileName: '/test/document.md',
  };
}

describe('MarkdownEditorProvider - In-Memory File Support', () => {
  let provider: MarkdownEditorProvider;
  let mockContext: vscode.ExtensionContext;
  let mockWebview: {
    postMessage: jest.Mock;
    asWebviewUri: jest.Mock;
    onDidReceiveMessage: jest.Mock;
    options: Record<string, unknown>;
  };

  const getProviderInternals = () =>
    provider as unknown as {
      getDocumentDirectory: (doc: vscode.TextDocument) => string | null;
      getImageBasePath: (doc: vscode.TextDocument) => string | null;
      resolveCustomTextEditor: (
        doc: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        token: vscode.CancellationToken
      ) => Promise<void>;
      handleResolveImageUri: (
        message: { type: string; relativePath: string; requestId: string },
        doc: vscode.TextDocument,
        webview: { postMessage: jest.Mock; asWebviewUri: jest.Mock }
      ) => void;
      handleSaveImage: (
        message: {
          type: string;
          placeholderId: string;
          name: string;
          data: number[];
          targetFolder?: string;
        },
        doc: vscode.TextDocument,
        webview: { postMessage: jest.Mock }
      ) => Promise<void>;
      handleCopyLocalImageToWorkspace: (
        message: {
          type: string;
          absolutePath: string;
          placeholderId: string;
          targetFolder?: string;
        },
        doc: vscode.TextDocument,
        webview: { postMessage: jest.Mock }
      ) => Promise<void>;
      handleWorkspaceImage: (
        message: { type: string; sourcePath: string; fileName: string; insertPosition: number },
        doc: vscode.TextDocument,
        webview: { postMessage: jest.Mock }
      ) => void;
      handleCheckImageInWorkspace: (
        message: { type: string; imagePath: string; requestId: string },
        doc: vscode.TextDocument,
        webview: { postMessage: jest.Mock }
      ) => Promise<void>;
    };

  beforeEach(() => {
    jest.clearAllMocks();
    mockContext = {
      extensionUri: { fsPath: '/extension' } as vscode.Uri,
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    mockWebview = {
      postMessage: jest.fn(),
      asWebviewUri: jest.fn((uri: unknown) => ({
        toString: () => `vscode-webview://${getUriFsPath(uri)}`,
      })),
      onDidReceiveMessage: jest.fn(() => ({ dispose: jest.fn() })),
      options: {},
    };

    provider = new MarkdownEditorProvider(mockContext);
  });

  describe('getDocumentDirectory', () => {
    it('should return document directory for file scheme', () => {
      const document = createMockTextDocument('content');
      document.uri = { scheme: 'file', fsPath: '/workspace/test.md' } as unknown as vscode.Uri;
      const docDir = getProviderInternals().getDocumentDirectory(
        document as unknown as vscode.TextDocument
      );
      expect(docDir).toBe('/workspace');
    });

    it('should return workspace folder for untitled file in workspace', () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) = [
        { uri: { fsPath: '/workspace' } as vscode.Uri } as vscode.WorkspaceFolder,
      ];
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(null);

      const docDir = getProviderInternals().getDocumentDirectory(
        document as unknown as vscode.TextDocument
      );
      expect(docDir).toBe('/workspace');
    });

    it('should return null for untitled file without workspace', () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) =
        undefined;
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(null);

      const docDir = getProviderInternals().getDocumentDirectory(
        document as unknown as vscode.TextDocument
      );
      expect(docDir).toBeNull();
    });

    it('should prioritize workspaceFolders over getWorkspaceFolder for untitled files', () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) = [
        { uri: { fsPath: '/workspace' } as vscode.Uri } as vscode.WorkspaceFolder,
      ];
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue({
        uri: { fsPath: '/wrong-workspace' },
      });

      const docDir = getProviderInternals().getDocumentDirectory(
        document as unknown as vscode.TextDocument
      );
      // Should use workspaceFolders[0], not getWorkspaceFolder result
      expect(docDir).toBe('/workspace');
    });
  });

  describe('getImageBasePath', () => {
    it('should return document directory for file scheme', () => {
      const document = createMockTextDocument('content');
      document.uri = { scheme: 'file', fsPath: '/workspace/test.md' } as unknown as vscode.Uri;
      const basePath = getProviderInternals().getImageBasePath(
        document as unknown as vscode.TextDocument
      );
      expect(basePath).toBe('/workspace');
    });

    it('should return workspace folder for untitled file in workspace', () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) = [
        { uri: { fsPath: '/workspace' } as vscode.Uri } as vscode.WorkspaceFolder,
      ];
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(null);

      const basePath = getProviderInternals().getImageBasePath(
        document as unknown as vscode.TextDocument
      );
      expect(basePath).toBe('/workspace');
    });

    it('should return temp directory for untitled file without workspace', () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) =
        undefined;
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(null);

      const basePath = getProviderInternals().getImageBasePath(
        document as unknown as vscode.TextDocument
      );
      expect(basePath).toBe(os.tmpdir());
    });
  });

  describe('resolveCustomTextEditor - localResourceRoots', () => {
    it('should include workspace folder for untitled file in workspace', async () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      const webviewPanel = {
        webview: mockWebview as unknown as vscode.Webview,
        onDidChangeViewState: jest.fn(),
        onDidDispose: jest.fn(),
      } as unknown as vscode.WebviewPanel;

      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) = [
        { uri: { fsPath: '/workspace' } as vscode.Uri } as vscode.WorkspaceFolder,
      ];
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(null);

      await getProviderInternals().resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        webviewPanel,
        {} as unknown as vscode.CancellationToken
      );

      expect(webviewPanel.webview.options.localResourceRoots).toContainEqual(
        expect.objectContaining({ fsPath: '/workspace' })
      );
    });

    it('should include temp directory for untitled file without workspace', async () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      const webviewPanel = {
        webview: mockWebview as unknown as vscode.Webview,
        onDidChangeViewState: jest.fn(),
        onDidDispose: jest.fn(),
      } as unknown as vscode.WebviewPanel;

      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) =
        undefined;
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(null);

      await getProviderInternals().resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        webviewPanel,
        {} as unknown as vscode.CancellationToken
      );

      const tempDir = os.tmpdir();
      expect(webviewPanel.webview.options.localResourceRoots).toContainEqual(
        expect.objectContaining({ fsPath: tempDir })
      );
    });

    it('should show warning dialog for untitled file without workspace', async () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      const webviewPanel = {
        webview: mockWebview as unknown as vscode.Webview,
        onDidChangeViewState: jest.fn(),
        onDidDispose: jest.fn(),
      } as unknown as vscode.WebviewPanel;

      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) =
        undefined;
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(null);

      await getProviderInternals().resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        webviewPanel,
        {} as unknown as vscode.CancellationToken
      );

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('You are working without a workspace')
      );
    });

    it('should not show warning dialog for untitled file with workspace', async () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      const webviewPanel = {
        webview: mockWebview as unknown as vscode.Webview,
        onDidChangeViewState: jest.fn(),
        onDidDispose: jest.fn(),
      } as unknown as vscode.WebviewPanel;

      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) = [
        { uri: { fsPath: '/workspace' } as vscode.Uri } as vscode.WorkspaceFolder,
      ];
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(null);

      await getProviderInternals().resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        webviewPanel,
        {} as unknown as vscode.CancellationToken
      );

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });

  describe('handleResolveImageUri', () => {
    it('should resolve relative image path using workspace folder for untitled file in workspace', () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) = [
        { uri: { fsPath: '/workspace' } as vscode.Uri } as vscode.WorkspaceFolder,
      ];
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(null);

      const message = {
        type: 'resolveImageUri',
        relativePath: './images/test.jpg',
        requestId: 'test-123',
      };

      getProviderInternals().handleResolveImageUri(
        message,
        document as unknown as vscode.TextDocument,
        mockWebview
      );

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'imageUriResolved',
          requestId: 'test-123',
          webviewUri: expect.stringContaining('vscode-webview://'),
        })
      );
    });

    it('should resolve relative image path using temp directory for untitled file without workspace', () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) =
        undefined;
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(null);

      const message = {
        type: 'resolveImageUri',
        relativePath: './images/test.jpg',
        requestId: 'test-123',
      };

      getProviderInternals().handleResolveImageUri(
        message,
        document as unknown as vscode.TextDocument,
        mockWebview
      );

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'imageUriResolved',
          requestId: 'test-123',
        })
      );
    });

    it('should handle error when no base path available', () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      // Mock getImageBasePath to return null
      jest.spyOn(getProviderInternals(), 'getImageBasePath').mockReturnValue(null);

      const message = {
        type: 'resolveImageUri',
        relativePath: './images/test.jpg',
        requestId: 'test-123',
      };

      getProviderInternals().handleResolveImageUri(
        message,
        document as unknown as vscode.TextDocument,
        mockWebview
      );

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'imageUriResolved',
          requestId: 'test-123',
          webviewUri: '',
          error: 'Cannot resolve image path: no base directory available',
        })
      );
    });
  });

  describe('handleSaveImage', () => {
    it('should save image relative to the document folder when imagePathBase=relativeToDocument', async () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'file',
        fsPath: '/workspace/docs/document.md',
        toString: () => 'file:/workspace/docs/document.md',
      } as unknown as vscode.Uri;

      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) = [
        { uri: { fsPath: '/workspace' } as vscode.Uri } as vscode.WorkspaceFolder,
      ];
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue({
        uri: { fsPath: '/workspace' },
      });
      (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn((key: string, defaultValue?: unknown) => {
          if (key === 'markdownForHumans.imagePathBase') return 'relativeToDocument';
          return defaultValue;
        }),
        update: jest.fn(),
      });

      (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
      (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('ENOENT'));
      (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const message = {
        type: 'saveImage',
        placeholderId: 'placeholder-1',
        name: 'test.jpg',
        data: [1, 2, 3],
        targetFolder: 'images',
      };

      await getProviderInternals().handleSaveImage(
        message,
        document as unknown as vscode.TextDocument,
        mockWebview
      );

      expect(vscode.workspace.fs.createDirectory).toHaveBeenCalledWith(
        expect.objectContaining({
          fsPath: expect.stringMatching(/([A-Za-z]:)?[/\\]workspace[/\\]docs[/\\]images/),
        })
      );
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'imageSaved',
          newSrc: './images/test.jpg',
        })
      );
    });

    it('should save image under workspace folder when imagePathBase=workspaceFolder and return a relative markdown link', async () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'file',
        fsPath: '/workspace/docs/document.md',
        toString: () => 'file:/workspace/docs/document.md',
      } as unknown as vscode.Uri;

      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) = [
        { uri: { fsPath: '/workspace' } as vscode.Uri } as vscode.WorkspaceFolder,
      ];
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue({
        uri: { fsPath: '/workspace' },
      });
      (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn((key: string, defaultValue?: unknown) => {
          if (key === 'markdownForHumans.imagePathBase') return 'workspaceFolder';
          return defaultValue;
        }),
        update: jest.fn(),
      });

      (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
      (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('ENOENT'));
      (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const message = {
        type: 'saveImage',
        placeholderId: 'placeholder-1',
        name: 'test.jpg',
        data: [1, 2, 3],
        targetFolder: 'images',
      };

      await getProviderInternals().handleSaveImage(
        message,
        document as unknown as vscode.TextDocument,
        mockWebview
      );

      expect(vscode.workspace.fs.createDirectory).toHaveBeenCalledWith(
        expect.objectContaining({
          fsPath: expect.stringMatching(/([A-Za-z]:)?[/\\]workspace[/\\]images/),
        })
      );
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'imageSaved',
          newSrc: '../images/test.jpg',
        })
      );
    });

    it('should save image to workspace folder for untitled file in workspace', async () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) = [
        { uri: { fsPath: '/workspace' } as vscode.Uri } as vscode.WorkspaceFolder,
      ];
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(null);
      (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
      (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('ENOENT'));
      (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const message = {
        type: 'saveImage',
        placeholderId: 'placeholder-1',
        name: 'test.jpg',
        data: [1, 2, 3],
        targetFolder: 'images',
      };

      await getProviderInternals().handleSaveImage(
        message,
        document as unknown as vscode.TextDocument,
        mockWebview
      );

      expect(vscode.workspace.fs.createDirectory).toHaveBeenCalledWith(
        expect.objectContaining({
          fsPath: expect.stringMatching(/([A-Za-z]:)?[/\\]workspace[/\\]images/),
        })
      );
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'imageSaved',
          newSrc: './images/test.jpg',
        })
      );
    });

    it('should avoid overwriting an existing image by suffixing the filename', async () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) = [
        { uri: { fsPath: '/workspace' } as vscode.Uri } as vscode.WorkspaceFolder,
      ];
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(null);
      (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
      (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (vscode.workspace.fs.stat as jest.Mock).mockImplementation((uri: unknown) => {
        const fsPath = getUriFsPath(uri);
        // Normalize path for cross-platform comparison (remove drive letter, normalize separators)
        const normalizedPath = fsPath.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
        if (
          normalizedPath === '/workspace/images/test.jpg' ||
          normalizedPath.endsWith('/workspace/images/test.jpg')
        ) {
          return Promise.resolve({} as unknown as vscode.FileStat);
        }
        if (
          normalizedPath === '/workspace/images/test-2.jpg' ||
          normalizedPath.endsWith('/workspace/images/test-2.jpg')
        ) {
          return Promise.reject(new Error('ENOENT'));
        }
        return Promise.reject(new Error(`Unexpected path: ${fsPath}`));
      });

      const message = {
        type: 'saveImage',
        placeholderId: 'placeholder-1',
        name: 'test.jpg',
        data: [1, 2, 3],
        targetFolder: 'images',
      };

      await getProviderInternals().handleSaveImage(
        message,
        document as unknown as vscode.TextDocument,
        mockWebview
      );

      expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          fsPath: expect.stringMatching(/([A-Za-z]:)?[/\\]workspace[/\\]images[/\\]test-2\.jpg$/),
        }),
        expect.any(Uint8Array)
      );
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'imageSaved',
          newSrc: './images/test-2.jpg',
        })
      );
    });

    it('should save image to temp directory for untitled file without workspace', async () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) =
        undefined;
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(null);
      (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
      (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('ENOENT'));
      (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const message = {
        type: 'saveImage',
        placeholderId: 'placeholder-1',
        name: 'test.jpg',
        data: [1, 2, 3],
        targetFolder: 'images',
      };

      await getProviderInternals().handleSaveImage(
        message,
        document as unknown as vscode.TextDocument,
        mockWebview
      );

      const tempDir = os.tmpdir();
      expect(vscode.workspace.fs.createDirectory).toHaveBeenCalledWith(
        expect.objectContaining({ fsPath: expect.stringContaining(tempDir) })
      );
    });

    it('should show error when no base path available', async () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      jest.spyOn(getProviderInternals(), 'getImageBasePath').mockReturnValue(null);

      const message = {
        type: 'saveImage',
        placeholderId: 'placeholder-1',
        name: 'test.jpg',
        data: [1, 2, 3],
      };

      await getProviderInternals().handleSaveImage(
        message,
        document as unknown as vscode.TextDocument,
        mockWebview
      );

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Cannot save image')
      );
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'imageError',
          error: expect.stringContaining('no base directory'),
        })
      );
    });
  });

  describe('handleCopyLocalImageToWorkspace', () => {
    it('should copy image under workspace folder when imagePathBase=workspaceFolder and return a relative markdown link', async () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'file',
        fsPath: '/workspace/docs/document.md',
        toString: () => 'file:/workspace/docs/document.md',
      } as unknown as vscode.Uri;

      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) = [
        { uri: { fsPath: '/workspace' } as vscode.Uri } as vscode.WorkspaceFolder,
      ];
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue({
        uri: { fsPath: '/workspace' },
      });
      (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
        get: jest.fn((key: string, defaultValue?: unknown) => {
          if (key === 'markdownForHumans.imagePathBase') return 'workspaceFolder';
          return defaultValue;
        }),
        update: jest.fn(),
      });

      (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(new Uint8Array([1, 2, 3]));
      (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
      (vscode.workspace.fs.stat as jest.Mock).mockRejectedValue(new Error('ENOENT'));
      (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      const message = {
        type: 'copyLocalImageToWorkspace',
        absolutePath: '/external/pic.png',
        placeholderId: 'placeholder-1',
        targetFolder: 'images',
      };

      await getProviderInternals().handleCopyLocalImageToWorkspace(
        message,
        document as unknown as vscode.TextDocument,
        mockWebview
      );

      expect(vscode.workspace.fs.createDirectory).toHaveBeenCalledWith(
        expect.objectContaining({
          fsPath: expect.stringMatching(/([A-Za-z]:)?[/\\]workspace[/\\]images/),
        })
      );
      expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          fsPath: expect.stringMatching(/[/\\]workspace[/\\]images[/\\]pic\.png$/),
        }),
        expect.any(Uint8Array)
      );
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'localImageCopied',
          relativePath: '../images/pic.png',
          originalPath: '/external/pic.png',
        })
      );
    });
  });

  describe('handleWorkspaceImage', () => {
    it('should compute relative path from workspace folder for untitled file', () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) = [
        { uri: { fsPath: '/workspace' } as vscode.Uri } as vscode.WorkspaceFolder,
      ];
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(null);

      const message = {
        type: 'handleWorkspaceImage',
        sourcePath: '/workspace/images/photo.jpg',
        fileName: 'photo.jpg',
        insertPosition: 0,
      };

      getProviderInternals().handleWorkspaceImage(
        message,
        document as unknown as vscode.TextDocument,
        mockWebview
      );

      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'insertWorkspaceImage',
          relativePath: expect.stringContaining('images/photo.jpg'),
        })
      );
    });
  });

  describe('Integration - Full workflow', () => {
    it('should handle complete image workflow for untitled file in workspace', async () => {
      const document = createMockTextDocument('content');
      document.uri = {
        scheme: 'untitled',
        toString: () => 'untitled:Untitled-1',
      } as unknown as vscode.Uri;
      (vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[] | undefined) = [
        { uri: { fsPath: '/workspace' } as vscode.Uri } as vscode.WorkspaceFolder,
      ];
      (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(null);
      (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
      (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      // First stat call during save should treat file as non-existent,
      // subsequent calls (e.g. workspace image check) should succeed.
      (vscode.workspace.fs.stat as jest.Mock)
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValue({} as unknown as vscode.FileStat);

      // 1. Resolve image URI
      const resolveMessage = {
        type: 'resolveImageUri',
        relativePath: './images/test.jpg',
        requestId: 'resolve-1',
      };
      getProviderInternals().handleResolveImageUri(
        resolveMessage,
        document as unknown as vscode.TextDocument,
        mockWebview
      );
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'imageUriResolved' })
      );

      // 2. Save image
      const saveMessage = {
        type: 'saveImage',
        placeholderId: 'placeholder-1',
        name: 'test.jpg',
        data: [1, 2, 3],
        targetFolder: 'images',
      };
      await getProviderInternals().handleSaveImage(
        saveMessage,
        document as unknown as vscode.TextDocument,
        mockWebview
      );
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'imageSaved' })
      );

      // 3. Check image in workspace
      const checkMessage = {
        type: 'checkImageInWorkspace',
        imagePath: './images/test.jpg',
        requestId: 'check-1',
      };
      await getProviderInternals().handleCheckImageInWorkspace(
        checkMessage,
        document as unknown as vscode.TextDocument,
        mockWebview
      );
      expect(mockWebview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'imageWorkspaceCheck' })
      );
    });
  });
});
