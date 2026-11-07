/**
 * @jest-environment node
 *
 * Host handling of the `addToCopilot` message: line resolution, one
 * differentiated chat context chip per press, context numbering, fallbacks,
 * and the GitHub Copilot availability report.
 */

import * as vscode from 'vscode';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';
import { toCopilotChatAttachRange } from '../../editor/copilotContext';

type Message = { type: string; [key: string]: unknown };

type ProviderInternals = {
  handleWebviewMessage: (
    message: Message,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ) => void;
  feedbackSessions: Map<string, unknown>;
  feedbackWebviews: Map<string, Set<unknown>>;
  unregisterFeedbackWebview: (documentKey: string, webview: vscode.Webview) => void;
};

const SOURCE = '# Title\n\nFirst\n\n| a |\n| - |\n| 1 |\n';
const BLOCKS = [
  { ordinal: 0, kind: 'heading', markdown: '# Title', contentSize: 7 },
  { ordinal: 1, kind: 'paragraph', markdown: 'First', contentSize: 5 },
  { ordinal: 2, kind: 'table', markdown: '| a |\n| - |\n| 1 |', contentSize: 12 },
];
const TABLE_ROW = { ordinal: 2, steps: [{ kind: 'row', index: 1, count: 2 }] };
const HEADING = { ordinal: 0, steps: [] };

function request(point: unknown = TABLE_ROW): Message {
  return { type: 'addToCopilot', selection: { start: point, end: point }, blocks: BLOCKS };
}

function createDocument(options: { scheme?: string; dirty?: boolean; text?: string } = {}) {
  const document = {
    getText: jest.fn(() => options.text ?? SOURCE),
    uri: {
      toString: (fragment?: string) =>
        `file:///work/proj/docs/guide.md${fragment ? `#${fragment}` : ''}`,
      scheme: options.scheme ?? 'file',
      fsPath: '/work/proj/docs/guide.md',
      path: '/work/proj/docs/guide.md',
      with: (change: { fragment?: string }) => createUri(change.fragment ?? ''),
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

function createUri(fragment: string) {
  return {
    toString: () => `file:///work/proj/docs/guide.md${fragment ? `#${fragment}` : ''}`,
    scheme: 'file',
    fsPath: '/work/proj/docs/guide.md',
    path: '/work/proj/docs/guide.md',
    fragment,
    with: (change: { fragment?: string }) => createUri(change.fragment ?? ''),
  };
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

async function send(
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
  return posted.find(message => message.type === 'addToCopilot.result');
}

function attachArgument(
  executeCommand: jest.Mock,
  callIndex = 0
): {
  isPartialQuery: boolean;
  attachFiles: Array<{ uri: { toString: () => string; fragment?: string }; range?: unknown }>;
} {
  return executeCommand.mock.calls[callIndex][1];
}

describe('addToCopilot on the host', () => {
  let executeCommand: jest.Mock;
  let writeText: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    executeCommand = vscode.commands.executeCommand as jest.Mock;
    executeCommand.mockResolvedValue(undefined);
    writeText = jest.fn(async () => undefined);
    (vscode.env as unknown as { clipboard: unknown }).clipboard = { writeText };
    (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue({
      uri: { fsPath: '/work/proj' },
    });
    (vscode.extensions.getExtension as jest.Mock).mockReturnValue({});
    (vscode.commands.getCommands as jest.Mock).mockResolvedValue(['workbench.action.chat.open']);
  });

  it('attaches the exact lines as one differentiated chat context', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument();
    const { webview, posted } = createWebview(provider, document);

    await send(provider, document, webview);

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand.mock.calls[0][0]).toBe('workbench.action.chat.open');
    const argument = attachArgument(executeCommand);
    expect(argument.isPartialQuery).toBe(true);
    expect(argument.attachFiles).toHaveLength(1);
    expect(argument.attachFiles[0].uri.toString()).toBe('file:///work/proj/docs/guide.md#L7-7');
    expect(argument.attachFiles[0].range).toEqual({
      startLineNumber: 7,
      startColumn: 1,
      endLineNumber: 7,
      endColumn: 6,
    });
    expect(document.save).not.toHaveBeenCalled();
    expect(result(posted)).toEqual({
      type: 'addToCopilot.result',
      ok: true,
      message: 'Added @docs/guide.md#L7 to GitHub Copilot (context 1)',
    });
  });

  it('keeps every press its own context with its own identity', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument();
    const { webview, posted } = createWebview(provider, document);

    await send(provider, document, webview);
    await send(provider, document, webview, request(HEADING));

    expect(executeCommand).toHaveBeenCalledTimes(2);
    const first = attachArgument(executeCommand, 0);
    const second = attachArgument(executeCommand, 1);
    // Distinct fragments give the chat two distinct attachment ids, so both
    // contexts survive side by side instead of collapsing into one chip.
    expect(first.attachFiles[0].uri.toString()).toBe('file:///work/proj/docs/guide.md#L7-7');
    expect(second.attachFiles[0].uri.toString()).toBe('file:///work/proj/docs/guide.md#L1-1');
    expect(second.attachFiles[0].range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 8,
    });
    expect(result(posted)?.message).toBe('Added @docs/guide.md#L7 to GitHub Copilot (context 1)');
    expect(posted.filter(message => message.type === 'addToCopilot.result').at(-1)?.message).toBe(
      'Added @docs/guide.md#L1 to GitHub Copilot (context 2)'
    );
  });

  it('keeps the number of a repeated context instead of counting it twice', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument();
    const { webview, posted } = createWebview(provider, document);

    await send(provider, document, webview);
    await send(provider, document, webview, request(HEADING));
    await send(provider, document, webview);

    const messages = posted
      .filter(message => message.type === 'addToCopilot.result')
      .map(message => message.message);
    expect(messages.at(-1)).toBe('Added @docs/guide.md#L7 to GitHub Copilot (context 1)');
  });

  it('forgets the numbering when the document is closed', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument();
    const { webview, posted } = createWebview(provider, document);
    const internals = provider as unknown as ProviderInternals;
    const documentKey = (document.uri as unknown as { toString: () => string }).toString();

    await send(provider, document, webview);
    await send(provider, document, webview, request(HEADING));
    // The last split of the document closes.
    internals.feedbackWebviews.set(documentKey, new Set([webview]));
    internals.unregisterFeedbackWebview(documentKey, webview as unknown as vscode.Webview);
    await send(provider, document, webview);

    expect(result(posted)?.message).toBe('Added @docs/guide.md#L7 to GitHub Copilot (context 1)');
    expect(posted.filter(message => message.type === 'addToCopilot.result').at(-1)?.message).toBe(
      'Added @docs/guide.md#L7 to GitHub Copilot (context 1)'
    );
  });

  it('saves unsaved changes first so the lines match the file on disk', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument({ dirty: true });
    const { webview, posted } = createWebview(provider, document);

    await send(provider, document, webview);

    expect(document.save).toHaveBeenCalledTimes(1);
    expect(result(posted)?.message).toBe(
      'Saved the file and added @docs/guide.md#L7 to GitHub Copilot (context 1)'
    );
  });

  it('attaches nothing when the save fails', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument({ dirty: true });
    document.save.mockResolvedValue(false);
    const { webview, posted } = createWebview(provider, document);

    await send(provider, document, webview);

    expect(executeCommand).not.toHaveBeenCalled();
    expect(result(posted)).toEqual({
      type: 'addToCopilot.result',
      ok: false,
      message: 'Not added: the file has changes that could not be saved.',
    });
  });

  it('refuses an untitled document, which has no path to attach', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument({ scheme: 'untitled' });
    const { webview, posted } = createWebview(provider, document);

    await send(provider, document, webview);

    expect(executeCommand).not.toHaveBeenCalled();
    expect(result(posted)).toEqual({
      type: 'addToCopilot.result',
      ok: false,
      message: 'Save this file first. An untitled document has no path to reference.',
    });
  });

  it('attaches the whole file when the spot cannot be matched to the saved text', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument();
    const { webview, posted } = createWebview(provider, document);
    const stale = request({
      ordinal: 0,
      steps: [],
    });
    stale.blocks = [
      { ordinal: 0, kind: 'paragraph', markdown: 'Rewritten elsewhere', contentSize: 18 },
    ];

    await send(provider, document, webview, stale);

    expect(executeCommand).toHaveBeenCalledTimes(1);
    const argument = attachArgument(executeCommand);
    expect(argument.attachFiles[0].uri.toString()).toBe('file:///work/proj/docs/guide.md');
    expect(argument.attachFiles[0].range).toBeUndefined();
    expect(result(posted)).toEqual({
      type: 'addToCopilot.result',
      ok: true,
      message:
        'Added @docs/guide.md to GitHub Copilot without line numbers: this spot could not be matched to the saved file.',
    });
  });

  it('copies the reference instead when GitHub Copilot is unavailable', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    (vscode.extensions.getExtension as jest.Mock).mockReturnValue(undefined);
    const document = createDocument();
    const { webview, posted } = createWebview(provider, document);

    await send(provider, document, webview);

    expect(executeCommand).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('@docs/guide.md#L7');
    expect(result(posted)).toEqual({
      type: 'addToCopilot.result',
      ok: false,
      message:
        'GitHub Copilot is not available. Copied @docs/guide.md#L7 to the clipboard instead.',
    });
  });

  it('rejects a malformed request without touching the chat', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument();
    const { webview, posted } = createWebview(provider, document);

    await send(provider, document, webview, { type: 'addToCopilot', blocks: BLOCKS });

    expect(executeCommand).not.toHaveBeenCalled();
    expect(result(posted)).toEqual({
      type: 'addToCopilot.result',
      ok: false,
      message: 'Could not add the selection to GitHub Copilot.',
    });
  });
});

describe('GitHub Copilot availability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is available only when the Copilot Chat extension and command are present', async () => {
    (vscode.extensions.getExtension as jest.Mock).mockReturnValue({});
    (vscode.commands.getCommands as jest.Mock).mockResolvedValue(['workbench.action.chat.open']);
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const webview = { postMessage: jest.fn(async () => true) };

    await provider.postCopilotChatAvailability(webview as unknown as vscode.Webview);

    expect(webview.postMessage).toHaveBeenCalledWith({
      type: 'copilotChatAvailability',
      available: true,
    });

    (vscode.extensions.getExtension as jest.Mock).mockReturnValue(undefined);
    await provider.postCopilotChatAvailability(webview as unknown as vscode.Webview);
    expect(webview.postMessage).toHaveBeenLastCalledWith({
      type: 'copilotChatAvailability',
      available: false,
    });
  });

  it('refreshes every live rich view when extensions change', async () => {
    (vscode.extensions.getExtension as jest.Mock).mockReturnValue({});
    (vscode.commands.getCommands as jest.Mock).mockResolvedValue(['workbench.action.chat.open']);
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const first = { postMessage: jest.fn(async () => true) };
    const second = { postMessage: jest.fn(async () => true) };
    const internals = provider as unknown as ProviderInternals;
    internals.feedbackWebviews.set('file:///work/proj/a.md', new Set([first]));
    internals.feedbackWebviews.set('file:///work/proj/b.md', new Set([second]));

    await provider.broadcastCopilotChatAvailability();

    expect(first.postMessage).toHaveBeenCalledWith({
      type: 'copilotChatAvailability',
      available: true,
    });
    expect(second.postMessage).toHaveBeenCalledWith({
      type: 'copilotChatAvailability',
      available: true,
    });
  });
});

describe('toCopilotChatAttachRange', () => {
  it('spans the whole end line, one past its final character', () => {
    expect(toCopilotChatAttachRange('abc\nde\n\nf', { startLine: 2, endLine: 4 })).toEqual({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 2,
    });
  });

  it('clamps out-of-range lines to the document', () => {
    expect(toCopilotChatAttachRange('abc\nde', { startLine: 0, endLine: 99 })).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 3,
    });
  });
});
