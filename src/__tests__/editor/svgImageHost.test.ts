/** SVG file operations preserve bytes and distinguish URL suffixes from filenames. */
import * as path from 'path';
import * as vscode from 'vscode';
import { MarkdownEditorProvider, normalizeImagePath } from '../../editor/MarkdownEditorProvider';
import { DocumentEditCoordinator } from '../../editor/documentEditCoordinator';

type Handler = (
  message: Record<string, unknown>,
  document: vscode.TextDocument,
  webview: vscode.Webview
) => Promise<void> | void;
type ProviderInternals = Record<
  | 'handleResolveImageUri'
  | 'handleResizeImage'
  | 'handleRedoResize'
  | 'handleUndoResize'
  | 'handleGetImageMetadata'
  | 'handleRevealImageInOS'
  | 'handleRevealImageInExplorer'
  | 'handleGetImageReferences'
  | 'handleCheckImageRename'
  | 'handleRenameImage',
  Handler
>;

const ROOT = path.resolve('/workspace/docs');
const SVG = Buffer.from(
  '<?xml version="1.0"?>\n<!-- diagram --><svg viewBox="0 0 1280 560"><rect width="10" height="10"/></svg>'
);

function createDocument(content = '# SVG test'): vscode.TextDocument {
  return {
    uri: vscode.Uri.file(path.join(ROOT, 'doc.md')),
    getText: () => content,
    lineCount: content.split('\n').length,
  } as unknown as vscode.TextDocument;
}

describe('SVG host boundaries', () => {
  let provider: ProviderInternals;
  let webview: vscode.Webview & { postMessage: jest.Mock; asWebviewUri: jest.Mock };
  let fs: { [key: string]: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(undefined);
    fs = {
      stat: jest.fn(async (uri: vscode.Uri) => {
        if (uri.fsPath.includes('image-backups') || uri.fsPath.endsWith('renamed.svg')) {
          throw new Error('Not found');
        }
        return { type: 1, size: SVG.length, mtime: 123, ctime: 123 };
      }),
      readFile: jest.fn(async () => SVG),
      writeFile: jest.fn(async () => undefined),
      createDirectory: jest.fn(async () => undefined),
      rename: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };
    Object.assign(vscode.workspace, {
      fs,
      findFiles: jest.fn(async () => []),
      openTextDocument: jest.fn(),
    });
    provider = new MarkdownEditorProvider({
      extensionUri: vscode.Uri.file('/extension'),
      subscriptions: [],
    } as unknown as vscode.ExtensionContext) as unknown as ProviderInternals;
    webview = {
      postMessage: jest.fn(async () => true),
      asWebviewUri: jest.fn((uri: vscode.Uri) => ({
        toString: () =>
          `https://file+.vscode-resource.vscode-cdn.net${uri.fsPath.split(path.sep).map(encodeURIComponent).join('/')}`,
      })),
    } as unknown as typeof webview;
  });

  it.each([
    ['diagram.svg?rev=2#overview', 'diagram.svg', '?rev=2#overview'],
    ['diagram%23view.svg#overview', 'diagram#view.svg', '#overview'],
    ['diagram%3Fview.svg?rev=2', 'diagram?view.svg', '?rev=2'],
    [
      'images/图%20表.svg#svgView(viewBox(0,0,10,10))',
      'images/图 表.svg',
      '#svgView(viewBox(0,0,10,10))',
    ],
  ])(
    'resolves %s using the file path and preserves the display suffix',
    async (source, filename, suffix) => {
      expect(normalizeImagePath(source)).toBe(filename);
      await provider.handleResolveImageUri(
        { relativePath: source, requestId: 'svg-uri' },
        createDocument(),
        webview
      );
      expect(webview.asWebviewUri).toHaveBeenCalledWith(
        expect.objectContaining({ fsPath: path.resolve(ROOT, filename) })
      );
      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          relativePath: source,
          webviewUri: expect.stringContaining(suffix),
        })
      );
    }
  );

  it.each(['handleResizeImage', 'handleRedoResize'] as const)(
    '%s rejects SVG before any backup or write, even with a misleading filename',
    async handler => {
      for (const imagePath of ['diagram.svg#overview', 'diagram.SVG', 'diagram.png']) {
        await provider[handler](
          {
            imagePath,
            newWidth: 400,
            newHeight: 175,
            imageData: 'data:image/png;base64,AAAA',
          },
          createDocument(),
          webview
        );
        expect(webview.postMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({
            success: false,
            error: expect.stringMatching(/SVG.*display size/i),
          })
        );
      }
      expect(fs.createDirectory).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
    }
  );

  it('continues to restore original SVG bytes from an existing resize backup', async () => {
    fs.stat.mockResolvedValue({ type: 1 });
    await provider.handleUndoResize(
      {
        imagePath: 'diagram.svg#overview',
        backupPath: '.md4h/image-backups/original.svg',
      },
      createDocument(),
      webview
    );
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: path.join(ROOT, 'diagram.svg') }),
      SVG
    );
    expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it.each([
    'handleGetImageMetadata',
    'handleRevealImageInOS',
    'handleRevealImageInExplorer',
  ] as const)('%s addresses the SVG file without its query or view fragment', async handler => {
    await provider[handler](
      { imagePath: 'diagram%23v.svg?rev=2#overview', requestId: 'metadata' },
      createDocument(),
      webview
    );
    expect(fs.stat).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: path.join(ROOT, 'diagram#v.svg') })
    );
  });

  it('counts Markdown and sized HTML references by full file identity, independent of suffix', async () => {
    const document = createDocument(
      [
        '![View](diagram.svg#overview)',
        '<img src="./diagram.svg?rev=2#detail" alt="Diagram" width="480" />',
        '![Different](other/diagram.svg)',
        '![Hash in filename](diagram%23overview.svg)',
      ].join('\n')
    );
    await provider.handleGetImageReferences(
      { imagePath: 'diagram.svg', requestId: 'references' },
      document,
      webview
    );
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ currentFileCount: 2 })
    );
  });

  it('renames only matching image sources, preserving SVG suffixes, titles and HTML dimensions', async () => {
    const document = createDocument(
      [
        '<img src="diagram.svg#overview" alt="Diagram" width="480" />',
        '![View](./diagram.svg?rev=2#overview "A title") ![Other](other/diagram.svg)',
        '[Link](diagram.svg) and prose (diagram.svg)',
        '![Encoded](./diagram%23view.svg)',
      ].join('\n')
    );
    await provider.handleRenameImage(
      { oldPath: 'diagram.svg#overview', newName: 'renamed', updateAllReferences: false },
      document,
      webview
    );
    expect(fs.rename).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: path.join(ROOT, 'diagram.svg') }),
      expect.objectContaining({ fsPath: path.join(ROOT, 'renamed.svg') })
    );
    const edit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[0]?.[0] as {
      replaces: Array<{ text: string }>;
    };
    expect(edit?.replaces[0].text).toBe(
      [
        '<img src="renamed.svg#overview" alt="Diagram" width="480" />',
        '![View](./renamed.svg?rev=2#overview "A title") ![Other](other/diagram.svg)',
        '[Link](diagram.svg) and prose (diagram.svg)',
        '![Encoded](./diagram%23view.svg)',
      ].join('\n')
    );
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        newPath: './renamed.svg#overview',
      })
    );
  });

  it('counts and renames supported space-containing destinations without rewriting prose or examples', async () => {
    const source = [
      '![Diagram](assets/My Diagram.svg)',
      '',
      '> ![View](assets/My Diagram.svg#detail)',
      '',
      '    ![Indented](assets/My Diagram.svg "A title")',
      '',
      '![Angle](<assets/My Diagram.svg> "Title")',
      '',
      '![Encoded](assets/My%20Diagram.svg)',
      '',
      'Prose ![not rendered](assets/My Diagram.svg)',
      '',
      '```md',
      '![Example](assets/My Diagram.svg)',
      '```',
    ].join('\n');
    const document = createDocument(source);
    await provider.handleGetImageReferences(
      { imagePath: 'assets/My Diagram.svg', requestId: 'space-references' },
      document,
      webview
    );
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ currentFileCount: 5 })
    );
    await provider.handleRenameImage(
      { oldPath: 'assets/My Diagram.svg', newName: 'renamed', updateAllReferences: false },
      document,
      webview
    );
    expect(fs.rename).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: path.join(ROOT, 'assets/My Diagram.svg') }),
      expect.objectContaining({ fsPath: path.join(ROOT, 'assets/renamed.svg') })
    );
    const edit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[0]?.[0] as {
      replaces: Array<{ text: string }>;
    };
    expect(edit?.replaces[0].text).toBe(
      source
        .replace('![Diagram](assets/My Diagram.svg)', '![Diagram](assets/renamed.svg)')
        .replace('![View](assets/My Diagram.svg#detail)', '![View](assets/renamed.svg#detail)')
        .replace(
          '![Indented](assets/My Diagram.svg "A title")',
          '![Indented](assets/renamed.svg "A title")'
        )
        .replace('<assets/My Diagram.svg>', '<assets/renamed.svg>')
        .replace('assets/My%20Diagram.svg', 'assets/renamed.svg')
    );
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, filesUpdated: 1 })
    );
  });

  it('renames image-only indented references without modifying fenced or mixed code examples', async () => {
    const source =
      '    ![Diagram](diagram.svg#view)\n    <img src="diagram.svg" width="480">\n\n```markdown\n![example](diagram.svg)\n```\n\n    ![example](diagram.svg)\n    const code = true;';
    const document = createDocument(source);
    await provider.handleRenameImage(
      { oldPath: 'diagram.svg', newName: 'renamed', updateAllReferences: false },
      document,
      webview
    );
    const edit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[0]?.[0] as {
      replaces: Array<{ text: string }>;
    };
    expect(edit?.replaces[0].text).toBe(
      '    ![Diagram](renamed.svg#view)\n    <img src="renamed.svg" width="480">\n\n```markdown\n![example](diagram.svg)\n```\n\n    ![example](diagram.svg)\n    const code = true;'
    );
  });

  it('preserves entity-encoded SVG suffixes and escaped Markdown filename characters on rename', async () => {
    const document = createDocument(
      '<img src="diagram.svg&#35;detail" width="300" />\n![escaped](diagram\\(1\\).svg)'
    );
    await provider.handleRenameImage(
      { oldPath: 'diagram.svg', newName: 'renamed', updateAllReferences: false },
      document,
      webview
    );
    const edit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[0]?.[0] as {
      replaces: Array<{ text: string }>;
    };
    expect(edit?.replaces[0].text).toBe(
      '<img src="renamed.svg&#35;detail" width="300" />\n![escaped](diagram\\(1\\).svg)'
    );
    (vscode.workspace.applyEdit as jest.Mock).mockClear();
    await provider.handleRenameImage(
      { oldPath: 'diagram(1).svg', newName: 'renamed', updateAllReferences: false },
      document,
      webview
    );
    const nextEdit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[0]?.[0] as {
      replaces: Array<{ text: string }>;
    };
    expect(nextEdit?.replaces[0].text).toContain('![escaped](renamed.svg)');
  });

  it('preserves raster redo and resolves URL suffixes before writing', async () => {
    fs.readFile.mockResolvedValue(Buffer.from([137, 80, 78, 71]));
    await provider.handleRedoResize(
      {
        imagePath: 'photo.png?rev=2',
        newWidth: 100,
        newHeight: 50,
        imageData: 'data:image/png;base64,AQID',
      },
      createDocument(),
      webview
    );
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: path.join(ROOT, 'photo.png') }),
      Buffer.from([1, 2, 3])
    );
    expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('rejects a rename preview outside the allowed roots before disclosing file existence', async () => {
    await provider.handleCheckImageRename(
      { oldPath: '../../private.svg#view', newName: 'renamed', requestId: 'rename-preview' },
      createDocument(),
      webview
    );
    expect(fs.stat).not.toHaveBeenCalled();
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'imageRenameCheck',
        error: expect.stringMatching(/outside/i),
      })
    );
  });

  it('rejects an undo backup outside the allowed roots before reading or writing bytes', async () => {
    await provider.handleUndoResize(
      { imagePath: 'diagram.svg', backupPath: '../../private.svg' },
      createDocument(),
      webview
    );
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.stringMatching(/outside/i) })
    );
  });

  it('encodes renamed filenames safely in quoted HTML and the renderer completion URI', async () => {
    fs.stat.mockImplementation(async (uri: vscode.Uri) => {
      if (uri.fsPath === path.join(ROOT, 'diagram.svg')) return { type: 1 };
      throw new Error('Not found');
    });
    const document = createDocument('<img src=\'diagram.svg#detail\' width="480">');
    await provider.handleRenameImage(
      { oldPath: 'diagram.svg#detail', newName: "renamed's (view)#1", updateAllReferences: false },
      document,
      webview
    );
    const edit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[0]?.[0] as {
      replaces: Array<{ text: string }>;
    };
    expect(edit?.replaces[0].text).toBe(
      '<img src=\'renamed%27s%20%28view%29%231.svg#detail\' width="480">'
    );
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ newPath: './renamed%27s%20%28view%29%231.svg#detail' })
    );
  });

  it('updates the latest document version when a rename waits behind an accepted edit', async () => {
    let text = '![image](diagram.svg)';
    const document = { ...createDocument(), getText: () => text } as vscode.TextDocument;
    let release!: () => void;
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    const coordinator = (
      provider as unknown as { documentEditCoordinator: DocumentEditCoordinator<string> }
    ).documentEditCoordinator;
    const earlier = coordinator.enqueue(document.uri.toString(), {
      kind: 'operation',
      execute: async () => {
        await pending;
        text += '\nNew accepted paragraph';
      },
    });
    const rename = provider.handleRenameImage(
      { oldPath: 'diagram.svg', newName: 'renamed', updateAllReferences: false },
      document,
      webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
    release();
    await earlier;
    await rename;
    const edit = (vscode.workspace.applyEdit as jest.Mock).mock.calls[0]?.[0] as {
      replaces: Array<{ text: string }>;
    };
    expect(edit?.replaces[0].text).toBe('![image](renamed.svg)\nNew accepted paragraph');
  });

  it('updates HTML and Markdown references in other documents without matching neighboring filenames', async () => {
    const document = createDocument('![current](diagram.svg#main)');
    const other = {
      ...createDocument(),
      uri: vscode.Uri.file(path.join(ROOT, 'other.markdown')),
      getText: () => '<img src="diagram.svg#detail" width="480"> ![other](elsewhere/diagram.svg)',
    } as vscode.TextDocument;
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([document.uri, other.uri]);
    (vscode.workspace.openTextDocument as jest.Mock).mockImplementation(async (uri: vscode.Uri) =>
      uri === document.uri ? document : other
    );
    await provider.handleRenameImage(
      { oldPath: 'diagram.svg', newName: 'renamed', updateAllReferences: true },
      document,
      webview
    );
    const edits = (vscode.workspace.applyEdit as jest.Mock).mock.calls.map(
      call => (call[0] as { replaces: Array<{ text: string }> }).replaces[0].text
    );
    expect(edits).toEqual([
      '![current](renamed.svg#main)',
      '<img src="renamed.svg#detail" width="480"> ![other](elsewhere/diagram.svg)',
    ]);
    expect(vscode.workspace.findFiles).toHaveBeenCalledWith('**/*.{md,markdown}', null, 1000);
  });
});
