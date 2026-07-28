import * as vscode from 'vscode';
import { WorkspaceEdit, Position, workspace } from 'vscode';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';

// Helper to create a minimal mock TextDocument
function createDocument(content: string, uri = 'file://test.md') {
  return {
    getText: jest.fn(() => content),
    uri: {
      toString: () => uri,
    },
    positionAt: jest.fn((offset: number) => new Position(0, offset)),
  };
}

describe('MarkdownEditorProvider undo/redo safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should mark document clean when undo returns to original content', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    // applyEdit normalizes inbound content to one trailing newline (MD047),
    // so the original-on-disk content here is the post-normalization form
    // (which is what a file-backed VS Code document would actually contain).
    const originalContent = 'alpha\n';
    let content = originalContent;
    const document = {
      getText: jest.fn(() => content),
      uri: { toString: () => 'file://test.md' },
      positionAt: jest.fn((offset: number) => new Position(0, offset)),
      isDirty: false,
    };

    (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
      const replaces = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces || [];
      if (replaces.length > 0) {
        content = replaces[0].text;
        document.isDirty = content !== originalContent;
      }
      return true;
    });

    await (
      provider as unknown as {
        applyEdit: (content: string, doc: vscode.TextDocument) => Promise<boolean>;
      }
    ).applyEdit('alpha beta', document as unknown as vscode.TextDocument);
    expect(document.isDirty).toBe(true);

    await (
      provider as unknown as {
        applyEdit: (content: string, doc: vscode.TextDocument) => Promise<boolean>;
      }
    ).applyEdit(originalContent, document as unknown as vscode.TextDocument);
    expect(document.isDirty).toBe(false);
  });

  it('should return to clean state after multiple edits are fully undone', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    // Content carries the MD047 trailing newline so undo back to "original"
    // produces a byte-identical match.
    const originalContent = 'start\n';
    let content = originalContent;
    const document = {
      getText: jest.fn(() => content),
      uri: { toString: () => 'file://test.md' },
      positionAt: jest.fn((offset: number) => new Position(0, offset)),
      isDirty: false,
    };

    (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
      const replaces = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces || [];
      if (replaces.length > 0) {
        content = replaces[0].text;
        document.isDirty = content !== originalContent;
      }
      return true;
    });

    // Apply multiple edits — inbound text without a trailing newline is
    // normalized on write, so the document content gains one each time.
    await (
      provider as unknown as {
        applyEdit: (content: string, doc: vscode.TextDocument) => Promise<boolean>;
      }
    ).applyEdit('edit1', document as unknown as vscode.TextDocument);
    await (
      provider as unknown as {
        applyEdit: (content: string, doc: vscode.TextDocument) => Promise<boolean>;
      }
    ).applyEdit('edit2', document as unknown as vscode.TextDocument);
    await (
      provider as unknown as {
        applyEdit: (content: string, doc: vscode.TextDocument) => Promise<boolean>;
      }
    ).applyEdit('edit3', document as unknown as vscode.TextDocument);
    expect(document.isDirty).toBe(true);
    expect(content).toBe('edit3\n');

    // Undo sequence back to original
    await (
      provider as unknown as {
        applyEdit: (content: string, doc: vscode.TextDocument) => Promise<boolean>;
      }
    ).applyEdit('edit2', document as unknown as vscode.TextDocument);
    await (
      provider as unknown as {
        applyEdit: (content: string, doc: vscode.TextDocument) => Promise<boolean>;
      }
    ).applyEdit('edit1', document as unknown as vscode.TextDocument);
    await (
      provider as unknown as {
        applyEdit: (content: string, doc: vscode.TextDocument) => Promise<boolean>;
      }
    ).applyEdit(originalContent, document as unknown as vscode.TextDocument);

    expect(content).toBe(originalContent);
    expect(document.isDirty).toBe(false);
  });

  it('should skip applyEdit when content is unchanged', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('hello world');

    const result = await (
      provider as unknown as {
        applyEdit: (content: string, doc: vscode.TextDocument) => Promise<boolean>;
      }
    ).applyEdit('hello world', document as unknown as vscode.TextDocument);

    expect(result).toBe(true);
    expect(workspace.applyEdit).not.toHaveBeenCalled();
    expect((provider as unknown as { pendingEdits: Map<unknown, unknown> }).pendingEdits.size).toBe(
      0
    );
  });

  it('should apply edit and mark pending when content changes', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('hello world');

    const result = await (
      provider as unknown as {
        applyEdit: (content: string, doc: vscode.TextDocument) => Promise<boolean>;
      }
    ).applyEdit('hi world', document as unknown as vscode.TextDocument);

    expect(result).toBe(true);
    expect(workspace.applyEdit).toHaveBeenCalledTimes(1);

    const lastCall = (workspace.applyEdit as jest.Mock).mock.calls[0][0] as WorkspaceEdit;
    expect(lastCall).toBeInstanceOf(WorkspaceEdit);

    const replaces = (lastCall as unknown as { replaces?: Array<{ text: string }> }).replaces;
    expect(replaces).toHaveLength(1);
    // applyEdit adds an MD047 trailing newline before writing.
    expect(replaces?.[0]?.text).toBe('hi world\n');
    expect((provider as unknown as { pendingEdits: Map<unknown, unknown> }).pendingEdits.size).toBe(
      1
    );
  });

  it('should skip webview update when content matches last sent payload', () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('same content');
    const webview = { postMessage: jest.fn() };

    (provider as unknown as { lastWebviewContent: Map<string, string> }).lastWebviewContent.set(
      document.uri.toString(),
      'same content'
    );

    (
      provider as unknown as {
        updateWebview: (doc: vscode.TextDocument, wv: { postMessage: jest.Mock }) => void;
      }
    ).updateWebview(document as unknown as vscode.TextDocument, webview);

    expect(webview.postMessage).not.toHaveBeenCalled();
  });

  it('should send webview update when content differs from last sent payload', () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('fresh content');
    const webview = { postMessage: jest.fn() };

    (provider as unknown as { lastWebviewContent: Map<string, string> }).lastWebviewContent.set(
      document.uri.toString(),
      'old content'
    );

    (
      provider as unknown as {
        updateWebview: (doc: vscode.TextDocument, wv: { postMessage: jest.Mock }) => void;
      }
    ).updateWebview(document as unknown as vscode.TextDocument, webview);

    expect(webview.postMessage).toHaveBeenCalledTimes(1);
    const payload = (webview.postMessage as jest.Mock).mock.calls[0][0];
    expect(payload).toEqual({
      type: 'update',
      content: 'fresh content',
      blankLineMode: 'strip',
      skipResizeWarning: false,
      skipAiContextSaveWarning: false,
      imagePath: 'images',
      imagePathBase: 'relativeToDocument',
      showImageHoverOverlay: true,
      paragraphSpacingBefore: 0,
      paragraphSpacingAfter: 0,
      zoom: 100,
      editorTheme: 'vscode',
      vscodeIsDark: true,
    });
  });

  it('should respect showImageHoverOverlay config when disabled', () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('fresh content');
    const webview = { postMessage: jest.fn() };

    (provider as unknown as { lastWebviewContent: Map<string, string> }).lastWebviewContent.set(
      document.uri.toString(),
      'old content'
    );

    const getConfigurationSpy = jest.spyOn(vscode.workspace, 'getConfiguration');
    getConfigurationSpy.mockReturnValue({
      get: (key: string, defaultValue?: unknown) => {
        if (key === 'markdownForHumans.imagePreview.hover.enabled') {
          return false;
        }
        return defaultValue;
      },
    } as unknown as vscode.WorkspaceConfiguration);

    (
      provider as unknown as {
        updateWebview: (doc: vscode.TextDocument, wv: { postMessage: jest.Mock }) => void;
      }
    ).updateWebview(document as unknown as vscode.TextDocument, webview);

    expect(webview.postMessage).toHaveBeenCalledTimes(1);
    const payload = (webview.postMessage as jest.Mock).mock.calls[0][0];
    expect(payload).toEqual({
      type: 'update',
      content: 'fresh content',
      blankLineMode: 'strip',
      skipResizeWarning: false,
      skipAiContextSaveWarning: false,
      imagePath: 'images',
      imagePathBase: 'relativeToDocument',
      showImageHoverOverlay: false,
      paragraphSpacingBefore: 0,
      paragraphSpacingAfter: 0,
      zoom: 100,
      editorTheme: 'vscode',
      vscodeIsDark: true,
    });

    getConfigurationSpy.mockRestore();
  });
});
