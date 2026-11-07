/**
 * Links to other files, clicked in the rich editor (issue #23).
 *
 * A link to another Markdown file opened in VS Code's text editor even when
 * the reader was in this editor. The host now opens Markdown targets in this
 * editor, and resolves the file part of links that carry a `#fragment` or
 * percent-encoded characters, which used to report "File not found".
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';

type Internals = {
  handleOpenFileLink: (
    message: Record<string, unknown>,
    document: vscode.TextDocument
  ) => Promise<void>;
};

const DOC_DIR = '/tmp/mdws/docs';
const DOC_PATH = `${DOC_DIR}/guide.md`;
const VIEW_TYPE = 'markdownForHumans.editor';

function createProvider(): Internals {
  return new MarkdownEditorProvider({
    extensionUri: vscode.Uri.file('/tmp/mdws'),
    subscriptions: [],
    globalState: {
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: jest.fn(async () => undefined),
    },
    extension: { packageJSON: { version: '0.0.0-test' } },
  } as unknown as vscode.ExtensionContext) as unknown as Internals;
}

function createDocument(): vscode.TextDocument {
  return {
    uri: vscode.Uri.file(DOC_PATH),
    fileName: DOC_PATH,
    languageId: 'markdown',
    version: 1,
    isDirty: false,
    getText: jest.fn(() => '# Guide\n'),
    lineCount: 1,
  } as unknown as vscode.TextDocument;
}

describe('opening a file link from the rich editor', () => {
  let existing: Set<string>;
  let openTextDocument: jest.Mock;
  let showTextDocument: jest.Mock;
  let executeCommand: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    existing = new Set<string>();
    const stat = jest.fn(async (uri: vscode.Uri) => {
      if (!existing.has(uri.fsPath)) {
        throw new Error('ENOENT');
      }
      return { type: 1, size: 10, ctime: 0, mtime: 0 };
    });
    openTextDocument = jest.fn(async (uri: vscode.Uri) => ({ uri }));
    showTextDocument = jest.fn(async () => undefined);
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    workspace.fs = { stat };
    workspace.openTextDocument = openTextDocument;
    workspace.workspaceFolders = undefined;
    (vscode.window as unknown as Record<string, unknown>).showTextDocument = showTextDocument;
    executeCommand = vscode.commands.executeCommand as jest.Mock;
  });

  it.each([
    ['other.md', 'other.md'],
    ['./other.md', 'other.md'],
    ['../README.MD', '../README.MD'],
    ['notes/setup.markdown', 'notes/setup.markdown'],
  ])('opens the Markdown link %s in this editor', async (href, relative) => {
    const target = path.resolve(DOC_DIR, relative);
    existing.add(target);

    await createProvider().handleOpenFileLink(
      { type: 'openFileLink', path: href },
      createDocument()
    );

    expect(executeCommand).toHaveBeenCalledWith(
      'vscode.openWith',
      expect.objectContaining({ fsPath: target }),
      VIEW_TYPE
    );
    expect(showTextDocument).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('keeps opening other text files in the text editor', async () => {
    const target = path.resolve(DOC_DIR, 'src/bar.ts');
    existing.add(target);

    await createProvider().handleOpenFileLink(
      { type: 'openFileLink', path: 'src/bar.ts' },
      createDocument()
    );

    expect(openTextDocument).toHaveBeenCalledWith(expect.objectContaining({ fsPath: target }));
    expect(showTextDocument).toHaveBeenCalledTimes(1);
    expect(executeCommand).not.toHaveBeenCalledWith(
      'vscode.openWith',
      expect.anything(),
      VIEW_TYPE
    );
  });

  it.each([
    ['other.md#installation', 'other.md'],
    ['other.md?plain=1', 'other.md'],
    ['my%20notes.md', 'my notes.md'],
    ['my%20notes.md#top', 'my notes.md'],
  ])('resolves the file part of %s', async (href, relative) => {
    const target = path.resolve(DOC_DIR, relative);
    existing.add(target);

    await createProvider().handleOpenFileLink(
      { type: 'openFileLink', path: href },
      createDocument()
    );

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledWith(
      'vscode.openWith',
      expect.objectContaining({ fsPath: target }),
      VIEW_TYPE
    );
  });

  it('prefers a file whose name really contains a percent sequence or a hash', async () => {
    const literal = path.resolve(DOC_DIR, 'report%20v2#draft.md');
    existing.add(literal);

    await createProvider().handleOpenFileLink(
      { type: 'openFileLink', path: 'report%20v2#draft.md' },
      createDocument()
    );

    expect(executeCommand).toHaveBeenCalledWith(
      'vscode.openWith',
      expect.objectContaining({ fsPath: literal }),
      VIEW_TYPE
    );
  });

  it('warns and opens nothing when the file does not exist', async () => {
    await createProvider().handleOpenFileLink(
      { type: 'openFileLink', path: 'missing.md#part' },
      createDocument()
    );

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'File not found: missing.md#part'
    );
    expect(executeCommand).not.toHaveBeenCalled();
    expect(showTextDocument).not.toHaveBeenCalled();
  });

  it('survives a malformed percent sequence', async () => {
    const target = path.resolve(DOC_DIR, '100%.md');
    existing.add(target);

    await createProvider().handleOpenFileLink(
      { type: 'openFileLink', path: '100%.md' },
      createDocument()
    );

    expect(executeCommand).toHaveBeenCalledWith(
      'vscode.openWith',
      expect.objectContaining({ fsPath: target }),
      VIEW_TYPE
    );
  });
});
