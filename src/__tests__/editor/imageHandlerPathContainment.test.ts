/**
 * Security regression: the image reveal/metadata message handlers resolve a
 * webview/document-supplied `imagePath` against the document directory. Unlike
 * the file-mutating handlers (rename/resize), they did not apply the
 * `isPathContainedWithin` guard, and `normalizeImagePath` deliberately keeps
 * `..` segments — so a hostile markdown image src like `../../secret.txt` could
 * make the host reveal or stat arbitrary files outside the document/workspace.
 * These tests pin the containment guard on all four read handlers.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';
import { exportDocument } from '../../features/documentExport';

jest.mock('../../features/documentExport', () => ({ exportDocument: jest.fn() }));

type Internals = {
  handleExportDocument: (
    message: Record<string, unknown>,
    document: vscode.TextDocument
  ) => Promise<void>;
  handleRevealImageInOS: (
    message: Record<string, unknown>,
    document: vscode.TextDocument
  ) => Promise<void>;
  handleRevealImageInExplorer: (
    message: Record<string, unknown>,
    document: vscode.TextDocument
  ) => Promise<void>;
  handleCheckImageInWorkspace: (
    message: Record<string, unknown>,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ) => Promise<void>;
  handleGetImageMetadata: (
    message: Record<string, unknown>,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ) => Promise<void>;
};

function createProvider(): MarkdownEditorProvider {
  return new MarkdownEditorProvider({
    extensionUri: vscode.Uri.file('/tmp/mdws'),
    subscriptions: [],
    globalState: {
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: jest.fn(async () => undefined),
    },
    extension: { packageJSON: { version: '0.3.0-test' } },
  } as unknown as vscode.ExtensionContext);
}

const DOC_PATH = '/tmp/mdws/docs/guide.md';

function createDocument(): vscode.TextDocument {
  return {
    uri: vscode.Uri.file(DOC_PATH),
    fileName: DOC_PATH,
    languageId: 'markdown',
    version: 1,
    isDirty: false,
    getText: jest.fn(() => '# Guide\n'),
    lineCount: 1,
    save: jest.fn(async () => true),
  } as unknown as vscode.TextDocument;
}

function createWebview(): vscode.Webview & { postMessage: jest.Mock } {
  return {
    asWebviewUri: jest.fn((uri: vscode.Uri) => uri),
    postMessage: jest.fn(() => Promise.resolve(true)),
  } as unknown as vscode.Webview & { postMessage: jest.Mock };
}

const TRAVERSAL = '../../secret.txt';
const LEGIT = 'pic.png';

describe('image read handlers enforce path containment', () => {
  let statMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    // Make stat always succeed so a missing file cannot mask the containment
    // decision: the discriminator is the guard, not file existence.
    statMock = jest.fn(async () => ({ type: 1, size: 10, ctime: 0, mtime: 0 }));
    (vscode.workspace as unknown as { fs: { stat: jest.Mock } }).fs = { stat: statMock };
    (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(undefined);
  });

  it('handleRevealImageInOS reveals a contained image but refuses a traversal path', async () => {
    const provider = createProvider() as unknown as Internals;
    const document = createDocument();

    await provider.handleRevealImageInOS({ type: 'revealImageInOS', imagePath: LEGIT }, document);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'revealFileInOS',
      expect.anything()
    );

    (vscode.commands.executeCommand as jest.Mock).mockClear();
    await provider.handleRevealImageInOS(
      { type: 'revealImageInOS', imagePath: TRAVERSAL },
      document
    );
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });

  it('handleRevealImageInExplorer refuses a traversal path', async () => {
    const provider = createProvider() as unknown as Internals;
    const document = createDocument();

    await provider.handleRevealImageInExplorer(
      { type: 'revealImageInExplorer', imagePath: TRAVERSAL },
      document
    );
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      'revealInExplorer',
      expect.anything()
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });

  it('handleCheckImageInWorkspace does not leak an out-of-root absolute path', async () => {
    const provider = createProvider() as unknown as Internals;
    const document = createDocument();
    const webview = createWebview();

    await provider.handleCheckImageInWorkspace(
      { type: 'checkImageInWorkspace', imagePath: TRAVERSAL, requestId: 'r1' },
      document,
      webview
    );

    const reply = webview.postMessage.mock.calls.at(-1)?.[0];
    expect(reply).toMatchObject({ type: 'imageWorkspaceCheck', inWorkspace: false });
    expect(reply.absolutePath).toBeUndefined();
  });

  it('handleGetImageMetadata returns null metadata for a traversal path', async () => {
    const provider = createProvider() as unknown as Internals;
    const document = createDocument();
    const webview = createWebview();

    await provider.handleGetImageMetadata(
      { type: 'getImageMetadata', imagePath: TRAVERSAL, requestId: 'r2' },
      document,
      webview
    );

    const reply = webview.postMessage.mock.calls.at(-1)?.[0];
    expect(reply).toMatchObject({ type: 'imageMetadata', requestId: 'r2', metadata: null });
  });

  it('handleExportDocument gives export the same containment resolver as the preview', async () => {
    const provider = createProvider() as unknown as Internals;
    const document = createDocument();

    await provider.handleExportDocument(
      { type: 'exportDocument', format: 'pdf', html: '<p></p>', title: 'Guide' },
      document
    );

    const resolveImage = (exportDocument as jest.Mock).mock.calls.at(-1)?.[5];
    expect(typeof resolveImage).toBe('function');
    expect(resolveImage(LEGIT)).toEqual({
      absolutePath: path.resolve('/tmp/mdws/docs', LEGIT),
      suffix: '',
    });
    expect(resolveImage(TRAVERSAL)).toBeUndefined();
    expect(resolveImage('/etc/passwd.png')).toBeUndefined();
    expect(resolveImage('//host/share/x.png')).toBeUndefined();
    expect(resolveImage('%2E%2E/%2E%2E/secret.png')).toBeUndefined();
  });
});
