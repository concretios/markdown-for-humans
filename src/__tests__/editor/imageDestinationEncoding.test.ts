/** R3: generated destinations retain literal filesystem identity across image actions. */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { MarkdownEditorProvider, normalizeImagePath } from '../../editor/MarkdownEditorProvider';

type Handler = (
  message: Record<string, unknown>,
  document: vscode.TextDocument,
  webview: vscode.Webview
) => Promise<unknown> | unknown;
type Internals = Record<
  | 'handleWorkspaceImage'
  | 'handleSaveImage'
  | 'handleCopyLocalImageToWorkspace'
  | 'handleResolveImageUri'
  | 'handleGetImageMetadata'
  | 'handleRenameImage'
  | 'handleOpenImage'
  | 'handleAuditCheckFile'
  | 'handleAuditPickFile',
  Handler
>;

const ROOT = path.resolve('/workspace/docs');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>');
const cases = [
  ['assets', 'diagram#view.svg', './assets/diagram%23view.svg'],
  ['assets', 'diagram?rev.svg', './assets/diagram%3Frev.svg'],
  ['assets', 'diagram%23view.svg', './assets/diagram%2523view.svg'],
  [
    'assets#one/nested?two/percent%23',
    '图 表.svg',
    './assets%23one/nested%3Ftwo/percent%2523/%E5%9B%BE%20%E8%A1%A8.svg',
  ],
  ['assets', 'ordinary-name_2.svg', './assets/ordinary-name_2.svg'],
] as const;

describe('generated image destination encoding', () => {
  let provider: Internals;
  let webview: vscode.Webview & { postMessage: jest.Mock; asWebviewUri: jest.Mock };
  let document: vscode.TextDocument;
  let source: string;
  let files: Map<string, Uint8Array>;
  let imageFolder: string;

  const reply = (type: string): Record<string, unknown> =>
    webview.postMessage.mock.calls
      .map(call => call[0])
      .filter(message => message.type === type)
      .at(-1);

  beforeEach(() => {
    jest.clearAllMocks();
    source = '# Images\n';
    imageFolder = 'images';
    files = new Map();
    document = {
      uri: vscode.Uri.file(path.join(ROOT, 'guide.md')),
      getText: () => source,
      get lineCount() {
        return source.split('\n').length;
      },
    } as unknown as vscode.TextDocument;
    (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue({
      uri: vscode.Uri.file(ROOT),
    });
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: (key: string, fallback: unknown) =>
        key === 'markdownForHumans.imagePath' ? imageFolder : fallback,
    });
    Object.assign(vscode.workspace, {
      fs: {
        stat: jest.fn(async (uri: vscode.Uri) => {
          const bytes = files.get(uri.fsPath);
          if (!bytes) throw new Error('ENOENT');
          return { type: 1, size: bytes.length, mtime: 123, ctime: 123 };
        }),
        readFile: jest.fn(async (uri: vscode.Uri) => {
          const bytes = files.get(uri.fsPath);
          if (!bytes) throw new Error('ENOENT');
          return bytes;
        }),
        writeFile: jest.fn(async (uri: vscode.Uri, bytes: Uint8Array) => {
          files.set(uri.fsPath, bytes);
        }),
        createDirectory: jest.fn(async () => undefined),
        rename: jest.fn(async (from: vscode.Uri, to: vscode.Uri) => {
          const bytes = files.get(from.fsPath);
          if (!bytes) throw new Error('ENOENT');
          files.set(to.fsPath, bytes);
          files.delete(from.fsPath);
        }),
      },
      findFiles: jest.fn(async () => []),
    });
    (vscode.workspace.applyEdit as jest.Mock).mockImplementation(
      async (edit: { replaces: Array<{ text: string }> }) => {
        source = edit.replaces[0].text;
        return true;
      }
    );
    provider = new MarkdownEditorProvider({
      extensionUri: vscode.Uri.file('/extension'),
      subscriptions: [],
    } as unknown as vscode.ExtensionContext) as unknown as Internals;
    webview = {
      postMessage: jest.fn(async () => true),
      asWebviewUri: jest.fn((uri: vscode.Uri) => ({
        toString: () => `https://resource.test/${encodeURIComponent(uri.fsPath)}`,
      })),
    } as unknown as typeof webview;
  });

  async function expectFileIdentity(destination: string, absoluteFile: string): Promise<void> {
    expect(path.resolve(ROOT, normalizeImagePath(destination))).toBe(absoluteFile);
    await provider.handleResolveImageUri(
      { relativePath: destination, requestId: 'resolve' },
      document,
      webview
    );
    expect(webview.asWebviewUri).toHaveBeenLastCalledWith(
      expect.objectContaining({ fsPath: absoluteFile })
    );
    await provider.handleGetImageMetadata(
      { imagePath: destination, requestId: 'metadata' },
      document,
      webview
    );
    expect(reply('imageMetadata').metadata).toMatchObject({
      filename: path.basename(absoluteFile),
      size: SVG.length,
    });
  }

  it.each(cases)(
    'inserts workspace file %s/%s as one encoded destination',
    async (folder, filename, expected) => {
      const absoluteFile = path.join(ROOT, folder, filename);
      files.set(absoluteFile, SVG);
      await provider.handleWorkspaceImage(
        { sourcePath: absoluteFile, fileName: filename },
        document,
        webview
      );
      const destination = reply('insertWorkspaceImage').relativePath as string;
      expect(destination).toBe(expected);
      await expectFileIdentity(destination, absoluteFile);
      expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    }
  );

  it.each(['workspace copy', 'explicit copy', 'saved import'] as const)(
    'encodes parent segments and literal percent on %s',
    async route => {
      imageFolder = 'assets#one/nested?two/percent%23';
      const filename = '图 表%23#view.svg';
      const externalFile = path.resolve('/external', filename);
      const target = path.join(ROOT, imageFolder, filename);
      files.set(externalFile, SVG);
      if (route === 'workspace copy') {
        await provider.handleWorkspaceImage(
          { sourcePath: externalFile, fileName: filename },
          document,
          webview
        );
      } else if (route === 'explicit copy') {
        await provider.handleCopyLocalImageToWorkspace(
          { absolutePath: externalFile, targetFolder: imageFolder, placeholderId: 'copy' },
          document,
          webview
        );
      } else {
        await provider.handleSaveImage(
          {
            name: filename,
            targetFolder: imageFolder,
            mimeType: 'image/svg+xml',
            data: SVG,
            placeholderId: 'save',
          },
          document,
          webview
        );
      }
      const message = reply(
        route === 'workspace copy'
          ? 'insertWorkspaceImage'
          : route === 'explicit copy'
            ? 'localImageCopied'
            : 'imageSaved'
      );
      const destination = (message.relativePath ?? message.newSrc) as string;
      expect(destination).toBe(
        './assets%23one/nested%3Ftwo/percent%2523/%E5%9B%BE%20%E8%A1%A8%2523%23view.svg'
      );
      expect(files.get(target)).toEqual(SVG);
      await expectFileIdentity(destination, target);
    }
  );

  it('renames an inserted literal-delimiter file without encoding its authored suffix twice', async () => {
    const folder = 'assets#one/percent%23';
    const filename = 'diagram%23#view.svg';
    const originalFile = path.join(ROOT, folder, filename);
    files.set(originalFile, SVG);
    await provider.handleWorkspaceImage(
      { sourcePath: originalFile, fileName: filename },
      document,
      webview
    );
    const destination = `${reply('insertWorkspaceImage').relativePath}?rev=2#detail`;
    source = `![Diagram](${destination})\n`;
    await provider.handleRenameImage(
      { oldPath: destination, newName: 'renamed', updateAllReferences: false },
      document,
      webview
    );
    expect(source).toBe('![Diagram](./assets%23one/percent%2523/renamed.svg?rev=2#detail)\n');
    expect(reply('imageRenamed').newPath).toBe(
      './assets%23one/percent%2523/renamed.svg?rev=2#detail'
    );
    await expectFileIdentity(
      reply('imageRenamed').newPath as string,
      path.join(ROOT, folder, 'renamed.svg')
    );
  });

  it('retains collision-safe save names without changing existing bytes or double encoding', async () => {
    const existing = path.join(ROOT, 'assets#one', 'diagram%23.svg');
    files.set(existing, Buffer.from('existing asset'));
    await provider.handleSaveImage(
      {
        name: 'diagram%23.svg',
        targetFolder: 'assets#one',
        mimeType: 'image/svg+xml',
        data: SVG,
        placeholderId: 'save',
      },
      document,
      webview
    );
    expect(reply('imageSaved').newSrc).toBe('./assets%23one/diagram%2523-2.svg');
    expect(files.get(existing)).toEqual(Buffer.from('existing asset'));
    await expectFileIdentity(
      reply('imageSaved').newSrc as string,
      path.join(ROOT, 'assets#one', 'diagram%23-2.svg')
    );
  });

  it('resolves a generated destination to an actual file with literal encoded-looking characters', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'md4h-image-destination-'));
    try {
      const folder = path.join(directory, 'assets#one');
      const actualFile = path.join(folder, '图 表%23.svg');
      await fs.mkdir(folder);
      await fs.writeFile(actualFile, SVG);
      const actualDocument = {
        ...document,
        uri: vscode.Uri.file(path.join(directory, 'guide.md')),
      };
      (vscode.workspace.fs.stat as jest.Mock).mockImplementation((uri: vscode.Uri) =>
        fs.stat(uri.fsPath)
      );
      await provider.handleWorkspaceImage(
        { sourcePath: actualFile, fileName: '图 表%23.svg' },
        actualDocument,
        webview
      );
      const destination = reply('insertWorkspaceImage').relativePath as string;
      expect(destination).toBe('./assets%23one/%E5%9B%BE%20%E8%A1%A8%2523.svg');
      await provider.handleResolveImageUri(
        { relativePath: destination, requestId: 'real' },
        actualDocument,
        webview
      );
      const resolvedFile = webview.asWebviewUri.mock.calls.at(-1)?.[0] as vscode.Uri;
      expect(resolvedFile.fsPath).toBe(actualFile);
      expect(await fs.readFile(resolvedFile.fsPath)).toEqual(SVG);
      await provider.handleGetImageMetadata(
        { imagePath: destination, requestId: 'real-metadata' },
        actualDocument,
        webview
      );
      expect(reply('imageMetadata').metadata).toMatchObject({
        filename: '图 表%23.svg',
        size: SVG.length,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('opens the exact encoded image file in the existing preview action', async () => {
    const absoluteFile = path.join(ROOT, 'assets#one', 'diagram%23.svg');
    files.set(absoluteFile, SVG);
    await provider.handleOpenImage(
      { path: './assets%23one/diagram%2523.svg?rev=2#view' },
      document,
      webview
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.open',
      expect.objectContaining({ fsPath: absoluteFile })
    );
  });

  it('recognizes an encoded image during Document Audit', async () => {
    files.set(path.join(ROOT, 'assets#one', 'diagram%23.svg'), SVG);
    await provider.handleAuditCheckFile(
      { relativePath: './assets%23one/diagram%2523.svg?rev=2#view', requestId: 'audit' },
      document,
      webview
    );
    expect(reply('auditCheckFileResult')).toMatchObject({ exists: true });
  });

  it('encodes an image selected by the Document Audit picker', async () => {
    const absoluteFile = path.join(ROOT, 'assets#one', 'diagram%23.svg');
    files.set(absoluteFile, SVG);
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([vscode.Uri.file(absoluteFile)]);
    await provider.handleAuditPickFile({ fileType: 'image', requestId: 'pick' }, document, webview);
    expect(reply('auditPickFileResult').selectedPath).toBe('./assets%23one/diagram%2523.svg');
  });

  it('encodes image repair suggestions while retaining ordinary file-link semantics', async () => {
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([
      vscode.Uri.file(path.join(ROOT, 'assets#one', 'diagram%23.svg')),
      vscode.Uri.file(path.join(ROOT, 'notes#one.txt')),
    ]);
    (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(undefined);
    await provider.handleAuditCheckFile(
      { relativePath: './diagram.svg', requestId: 'audit' },
      document,
      webview
    );
    expect(reply('auditCheckFileResult').suggestions).toEqual(
      expect.arrayContaining(['./assets%23one/diagram%2523.svg', './notes#one.txt'])
    );
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([
      vscode.Uri.file(path.join(ROOT, 'notes#one.txt')),
    ]);
    await provider.handleAuditPickFile({ fileType: 'any', requestId: 'pick' }, document, webview);
    expect(reply('auditPickFileResult').selectedPath).toBe('./notes#one.txt');
    files.set(path.join(ROOT, 'notes#one.txt'), Buffer.from('notes'));
    await provider.handleAuditCheckFile(
      { relativePath: './notes#one.txt', requestId: 'note' },
      document,
      webview
    );
    expect(reply('auditCheckFileResult')).toMatchObject({ exists: true });
  });
});
