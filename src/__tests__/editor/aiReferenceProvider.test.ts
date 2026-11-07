/**
 * @jest-environment node
 *
 * Host handling of the `copyReferenceForAi` message: save rule, clipboard and
 * the result the rich view shows.
 */

import * as vscode from 'vscode';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';

type Message = { type: string; [key: string]: unknown };

type ProviderInternals = {
  handleWebviewMessage: (
    message: Message,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ) => void;
  feedbackSessions: Map<string, unknown>;
};

const SOURCE = '# Title\n\nFirst\n\n| a |\n| - |\n| 1 |\n';
const BLOCKS = [
  { ordinal: 0, kind: 'heading', markdown: '# Title', contentSize: 5 },
  { ordinal: 1, kind: 'paragraph', markdown: 'First', contentSize: 5 },
  { ordinal: 2, kind: 'table', markdown: '| a |\n| - |\n| 1 |', contentSize: 12 },
];
const TABLE_ROW = { ordinal: 2, steps: [{ kind: 'row', index: 1, count: 2 }] };

function request(point: unknown = TABLE_ROW): Message {
  return { type: 'copyReferenceForAi', selection: { start: point, end: point }, blocks: BLOCKS };
}

function createDocument(options: { scheme?: string; dirty?: boolean; text?: string } = {}) {
  const document = {
    getText: jest.fn(() => options.text ?? SOURCE),
    uri: {
      toString: () => 'file:///work/proj/docs/guide.md',
      scheme: options.scheme ?? 'file',
      fsPath: '/work/proj/docs/guide.md',
    },
    version: 3,
    isDirty: options.dirty ?? false,
    save: jest.fn(async () => {
      document.isDirty = false;
      return true;
    }),
  };
  return document;
}

/** A rich view that acknowledges the host's flush request, as the real one does. */
function createWebview(provider: MarkdownEditorProvider, document: unknown) {
  const posted: Message[] = [];
  const webview = {
    postMessage: jest.fn((message: Message) => {
      posted.push(message);
      if (message.type === 'flushPendingEdit') {
        (provider as unknown as ProviderInternals).handleWebviewMessage(
          { ...message, type: 'flushPendingEditAck', ok: true },
          document as vscode.TextDocument,
          webview as unknown as vscode.Webview
        );
      }
      return Promise.resolve(true);
    }),
  };
  return { webview, posted };
}

async function copy(
  provider: MarkdownEditorProvider,
  document: unknown,
  webview: unknown,
  message: Message = request()
): Promise<void> {
  (provider as unknown as ProviderInternals).handleWebviewMessage(
    message,
    document as vscode.TextDocument,
    webview as vscode.Webview
  );
  for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setImmediate(resolve));
}

function result(posted: Message[]): Message | undefined {
  return posted.find(message => message.type === 'copyReferenceForAi.result');
}

describe('copyReferenceForAi on the host', () => {
  let writeText: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    writeText = jest.fn(async () => undefined);
    (vscode.env as unknown as { clipboard: unknown }).clipboard = { writeText };
    (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue({
      uri: { fsPath: '/work/proj' },
    });
  });

  it('copies the workspace-relative path and exact line, and tells the view', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument();
    const { webview, posted } = createWebview(provider, document);

    await copy(provider, document, webview);

    expect(writeText).toHaveBeenCalledWith('@docs/guide.md#L7');
    expect(document.save).not.toHaveBeenCalled();
    expect(result(posted)).toEqual({
      type: 'copyReferenceForAi.result',
      ok: true,
      message: 'Copied @docs/guide.md#L7',
    });
  });

  it('saves unsaved changes first so the lines match the file on disk', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument({ dirty: true });
    const { webview, posted } = createWebview(provider, document);

    await copy(provider, document, webview);

    expect(document.save).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('@docs/guide.md#L7');
    expect(result(posted)?.message).toBe('Saved the file and copied @docs/guide.md#L7');
  });

  it('copies nothing when the save fails', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument({ dirty: true });
    document.save.mockResolvedValue(false);
    const { webview, posted } = createWebview(provider, document);

    await copy(provider, document, webview);

    expect(writeText).not.toHaveBeenCalled();
    expect(result(posted)).toEqual(expect.objectContaining({ ok: false }));
  });

  it('refuses an untitled document, which has no path to reference', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument({ scheme: 'untitled' });
    const { webview, posted } = createWebview(provider, document);

    await copy(provider, document, webview);

    expect(writeText).not.toHaveBeenCalled();
    expect(document.save).not.toHaveBeenCalled();
    expect(result(posted)).toEqual({
      type: 'copyReferenceForAi.result',
      ok: false,
      message: 'Save this file first. An untitled document has no path to reference.',
    });
  });

  it('copies the path alone when the selection cannot be matched to the file', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument({ text: '# Title\n\nSomething else entirely\n' });
    const { webview, posted } = createWebview(provider, document);

    await copy(provider, document, webview);

    expect(writeText).toHaveBeenCalledWith('@docs/guide.md');
    expect(result(posted)).toEqual({
      type: 'copyReferenceForAi.result',
      ok: true,
      message:
        'Copied @docs/guide.md without line numbers: this spot could not be matched to the saved file.',
    });
  });

  it('uses the absolute path for a file outside every workspace folder', async () => {
    (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(undefined);
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument();
    const { webview } = createWebview(provider, document);

    await copy(provider, document, webview);

    expect(writeText).toHaveBeenCalledWith('@/work/proj/docs/guide.md#L7');
  });

  it('stays read only while Feedback has the document frozen', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument();
    const { webview, posted } = createWebview(provider, document);
    (provider as unknown as ProviderInternals).feedbackSessions.set(document.uri.toString(), {
      ownerWebview: webview,
    });

    await copy(provider, document, webview);

    expect(posted.some(message => message.type === 'flushPendingEdit')).toBe(false);
    expect(document.save).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('@docs/guide.md#L7');
  });

  it('rejects a malformed request without touching the clipboard', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument();
    const { webview, posted } = createWebview(provider, document);

    await copy(provider, document, webview, { type: 'copyReferenceForAi', selection: {} });

    expect(writeText).not.toHaveBeenCalled();
    expect(result(posted)).toEqual(expect.objectContaining({ ok: false }));
  });
});
