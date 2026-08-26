import * as vscode from 'vscode';
import { WorkspaceEdit, Position, workspace } from 'vscode';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';
import { DOCUMENT_SYNC_PROTOCOL_VERSION } from '../../shared/documentSyncProtocol';
import { IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION } from '../../shared/pendingImageProtocol';

// Helper to create a minimal mock TextDocument
function createDocument(content: string, uri = 'file://test.md') {
  return {
    getText: jest.fn(() => content),
    uri: {
      toString: () => uri,
    },
    version: 1,
    positionAt: jest.fn((offset: number) => new Position(0, offset)),
    save: jest.fn(async () => true),
  };
}

function createFlushAcknowledgement(message: unknown, ok: boolean) {
  const barrier = message as {
    requestId: string;
    viewGeneration: string;
    documentVersion: number;
  };
  return {
    type: 'flushPendingEditAck',
    protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
    requestId: barrier.requestId,
    viewGeneration: barrier.viewGeneration,
    documentVersion: barrier.documentVersion,
    ok,
  };
}

describe('MarkdownEditorProvider undo/redo safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
    }));
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

  it('applies whitespace edits that raw HTML makes visually significant', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const original = '<span style="white-space: pre">a  b</span>\n';
    const edited = '<span style="white-space: pre">a b</span>\n';
    const document = createDocument(original, 'file://raw-html-whitespace.md');

    const result = await (
      provider as unknown as {
        applyEdit: (content: string, doc: vscode.TextDocument) => Promise<boolean>;
      }
    ).applyEdit(edited, document as unknown as vscode.TextDocument);

    expect(result).toBe(true);
    expect(workspace.applyEdit).toHaveBeenCalledTimes(1);
    const edit = (workspace.applyEdit as jest.Mock).mock.calls[0][0] as WorkspaceEdit;
    const replacements = (edit as unknown as { replaces: Array<{ text: string }> }).replaces;
    expect(replacements).toHaveLength(1);
    expect(replacements[0].text).toBe(edited);
  });

  it('uses one bounded replacement for a small change in a large document', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const middle = 20_000;
    const original = `${'x'.repeat(middle)}A${'x'.repeat(middle)}\n`;
    const target = `${'x'.repeat(middle)}B${'x'.repeat(middle)}\n`;
    const document = createDocument(original, 'file://large-minimal-edit.md');

    const result = await (
      provider as unknown as {
        applyEdit: (content: string, doc: vscode.TextDocument) => Promise<boolean>;
      }
    ).applyEdit(target, document as unknown as vscode.TextDocument);

    expect(result).toBe(true);
    const edit = (workspace.applyEdit as jest.Mock).mock.calls[0][0] as WorkspaceEdit;
    const replacement = (
      edit as unknown as {
        replaces: Array<{ range: { start: Position; end: Position }; text: string }>;
      }
    ).replaces[0];
    expect(replacement.text).toBe('B');
    expect(replacement.range.start.character).toBe(middle);
    expect(replacement.range.end.character).toBe(middle + 1);
  });

  it('serializes WorkspaceEdits accepted for the same document', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    let content = 'start\n';
    let releaseFirst: (() => void) | undefined;
    const document = {
      getText: jest.fn(() => content),
      uri: { toString: () => 'file://serialized.md' },
      positionAt: jest.fn((offset: number) => new Position(0, offset)),
    };

    (workspace.applyEdit as jest.Mock).mockImplementation((edit: WorkspaceEdit) => {
      const replacement = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces?.[0]
        ?.text;
      if ((workspace.applyEdit as jest.Mock).mock.calls.length === 1) {
        return new Promise<boolean>(resolve => {
          releaseFirst = () => {
            content = replacement ?? content;
            resolve(true);
          };
        });
      }
      content = replacement ?? content;
      return Promise.resolve(true);
    });

    const applyEdit = (
      provider as unknown as {
        applyEdit: (nextContent: string, doc: vscode.TextDocument) => Promise<boolean>;
      }
    ).applyEdit.bind(provider);

    const first = applyEdit('first', document as unknown as vscode.TextDocument);
    const second = applyEdit('second', document as unknown as vscode.TextDocument);
    await Promise.resolve();

    expect(workspace.applyEdit).toHaveBeenCalledTimes(1);
    expect(releaseFirst).toBeDefined();

    releaseFirst?.();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    expect(workspace.applyEdit).toHaveBeenCalledTimes(2);
    expect(content).toBe('second\n');
  });

  it('rechecks current document content when a queued edit begins', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    let content = 'start\n';
    const document = {
      getText: jest.fn(() => content),
      uri: { toString: () => 'file://queued-noop.md' },
      positionAt: jest.fn((offset: number) => new Position(0, offset)),
    };

    (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
      const replacement = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces?.[0]
        ?.text;
      content = replacement ?? content;
      return true;
    });

    const applyEdit = (
      provider as unknown as {
        applyEdit: (nextContent: string, doc: vscode.TextDocument) => Promise<boolean>;
      }
    ).applyEdit.bind(provider);

    await Promise.all([
      applyEdit('same result', document as unknown as vscode.TextDocument),
      applyEdit('same result', document as unknown as vscode.TextDocument),
    ]);

    expect(workspace.applyEdit).toHaveBeenCalledTimes(1);
    expect(content).toBe('same result\n');
  });

  it('coalesces only pending typing from the same renderer lineage', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    let content = 'start\n';
    let releaseFirst: (() => void) | undefined;
    const document = {
      getText: jest.fn(() => content),
      uri: { toString: () => 'file://coalesced-typing.md' },
      version: 7,
      positionAt: jest.fn((offset: number) => new Position(0, offset)),
    };
    const webview = {} as vscode.Webview;
    const appliedContent: string[] = [];

    (workspace.applyEdit as jest.Mock).mockImplementation((edit: WorkspaceEdit) => {
      const replacement = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces?.[0]
        ?.text;
      if ((workspace.applyEdit as jest.Mock).mock.calls.length === 1) {
        return new Promise<boolean>(resolve => {
          releaseFirst = () => {
            if (replacement) {
              content = replacement;
              appliedContent.push(replacement);
            }
            resolve(true);
          };
        });
      }
      if (replacement) {
        content = replacement;
        appliedContent.push(replacement);
      }
      return Promise.resolve(true);
    });

    const applyEdit = (
      provider as unknown as {
        applyEdit: (
          nextContent: string,
          doc: vscode.TextDocument,
          options: { editReason: 'typing'; sourceWebview: vscode.Webview }
        ) => Promise<boolean>;
      }
    ).applyEdit.bind(provider);
    const options = { editReason: 'typing' as const, sourceWebview: webview };

    const first = applyEdit('first', document as unknown as vscode.TextDocument, options);
    await Promise.resolve();
    const superseded = applyEdit('second', document as unknown as vscode.TextDocument, options);
    const latest = applyEdit('third', document as unknown as vscode.TextDocument, options);

    await expect(superseded).resolves.toBe(true);
    expect(workspace.applyEdit).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await expect(first).resolves.toBe(true);
    await expect(latest).resolves.toBe(true);

    expect(workspace.applyEdit).toHaveBeenCalledTimes(2);
    expect(appliedContent).toEqual(['first\n', 'third\n']);
  });

  it('drains the complete edit queue after a pending typing edit is coalesced', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    let content = 'start\n';
    let releaseFirst: (() => void) | undefined;
    const document = {
      getText: jest.fn(() => content),
      uri: { toString: () => 'file://drain-coalesced.md' },
      version: 9,
      positionAt: jest.fn((offset: number) => new Position(0, offset)),
    };
    const webview = {} as vscode.Webview;

    (workspace.applyEdit as jest.Mock).mockImplementation((edit: WorkspaceEdit) => {
      const replacement = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces?.[0]
        ?.text;
      if ((workspace.applyEdit as jest.Mock).mock.calls.length === 1) {
        return new Promise<boolean>(resolve => {
          releaseFirst = () => {
            content = replacement ?? content;
            resolve(true);
          };
        });
      }
      content = replacement ?? content;
      return Promise.resolve(true);
    });

    const internal = provider as unknown as {
      applyEdit: (
        nextContent: string,
        doc: vscode.TextDocument,
        options: { editReason: 'typing'; sourceWebview: vscode.Webview }
      ) => Promise<boolean>;
      drainDocumentEdits: (doc: vscode.TextDocument) => Promise<boolean>;
    };
    const options = { editReason: 'typing' as const, sourceWebview: webview };

    const first = internal.applyEdit('first', document as unknown as vscode.TextDocument, options);
    await Promise.resolve();
    const superseded = internal.applyEdit(
      'second',
      document as unknown as vscode.TextDocument,
      options
    );
    const latest = internal.applyEdit('third', document as unknown as vscode.TextDocument, options);
    const drain = internal.drainDocumentEdits(document as unknown as vscode.TextDocument);
    let drained = false;
    void drain.then(() => {
      drained = true;
    });

    await expect(superseded).resolves.toBe(true);
    expect(drained).toBe(false);
    expect(workspace.applyEdit).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await expect(Promise.all([first, latest, drain])).resolves.toEqual([true, true, true]);
    expect(content).toBe('third\n');
  });

  it('acknowledges correlated edits and rejects a stale renderer generation', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    let content = 'start\n';
    let version = 4;
    const document = {
      getText: jest.fn(() => content),
      uri: {
        toString: () => 'file://acked-edit.md',
        scheme: 'file',
        fsPath: '/tmp/acked-edit.md',
      },
      get version() {
        return version;
      },
      positionAt: jest.fn((offset: number) => new Position(0, offset)),
    };
    const webview = {
      postMessage: jest.fn(async () => true),
    } as unknown as vscode.Webview;
    const internal = provider as unknown as {
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
    };

    (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
      const replacement = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces?.[0]
        ?.text;
      content = replacement ?? content;
      version += 1;
      return true;
    });

    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'renderer-generation-1',
      },
      document as unknown as vscode.TextDocument,
      webview
    );
    (webview.postMessage as jest.Mock).mockClear();

    const correlatedEdit = {
      type: 'edit',
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      editId: 'renderer-generation-1:1:1',
      viewGeneration: 'renderer-generation-1',
      localRevision: 1,
      baseDocumentVersion: 4,
      content: 'accepted',
      editReason: 'typing',
    };
    internal.handleWebviewMessage(
      correlatedEdit,
      document as unknown as vscode.TextDocument,
      webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(workspace.applyEdit).toHaveBeenCalledTimes(1);
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: 'document.edit.ack',
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      editId: 'renderer-generation-1:1:1',
      viewGeneration: 'renderer-generation-1',
      localRevision: 1,
      accepted: true,
      documentVersion: 5,
    });

    (webview.postMessage as jest.Mock).mockClear();
    internal.handleWebviewMessage(
      correlatedEdit,
      document as unknown as vscode.TextDocument,
      webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(workspace.applyEdit).toHaveBeenCalledTimes(1);
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ editId: correlatedEdit.editId, accepted: true })
    );

    (webview.postMessage as jest.Mock).mockClear();
    internal.handleWebviewMessage(
      { ...correlatedEdit, content: 'conflicting reuse of an accepted identity' },
      document as unknown as vscode.TextDocument,
      webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(workspace.applyEdit).toHaveBeenCalledTimes(1);
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        editId: correlatedEdit.editId,
        accepted: false,
        documentVersion: 5,
      })
    );

    internal.handleWebviewMessage(
      {
        type: 'edit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: 'renderer-generation-0:2:1',
        viewGeneration: 'renderer-generation-0',
        localRevision: 2,
        baseDocumentVersion: 4,
        content: 'must not apply',
        editReason: 'typing',
      },
      document as unknown as vscode.TextDocument,
      webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(workspace.applyEdit).toHaveBeenCalledTimes(1);
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'document.edit.ack',
        editId: 'renderer-generation-0:2:1',
        accepted: false,
        documentVersion: 5,
      })
    );
  });

  it('rejects a queued correlated edit when its base document version becomes stale', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    let content = 'host version 4\n';
    let version = 4;
    let releaseBarrier: (() => void) | undefined;
    const document = {
      getText: jest.fn(() => content),
      uri: { toString: () => 'file://stale-base.md' },
      get version() {
        return version;
      },
      positionAt: jest.fn((offset: number) => new Position(0, offset)),
    };
    const webview = { postMessage: jest.fn(async () => true) } as unknown as vscode.Webview;
    const internal = provider as unknown as {
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
      documentEditCoordinator: import('../../editor/documentEditCoordinator').DocumentEditCoordinator<string>;
    };

    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'queued-view-1',
      },
      document as unknown as vscode.TextDocument,
      webview
    );
    (webview.postMessage as jest.Mock).mockClear();

    const barrier = internal.documentEditCoordinator.enqueue('file://stale-base.md', {
      kind: 'operation',
      execute: () => new Promise<void>(resolve => (releaseBarrier = resolve)),
    });
    await Promise.resolve();
    internal.handleWebviewMessage(
      {
        type: 'edit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: 'queued-view-1:1:1',
        viewGeneration: 'queued-view-1',
        localRevision: 1,
        baseDocumentVersion: 4,
        content: 'renderer content',
        editReason: 'typing',
      },
      document as unknown as vscode.TextDocument,
      webview
    );

    content = 'external version 5\n';
    version = 5;
    releaseBarrier?.();
    await barrier;
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(workspace.applyEdit).not.toHaveBeenCalled();
    expect(content).toBe('external version 5\n');
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'document.edit.ack',
        editId: 'queued-view-1:1:1',
        accepted: false,
        documentVersion: 5,
      })
    );
  });

  it('negatively acknowledges an identifiable edit whose payload is malformed', () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('host content\n', 'file://malformed-versioned-edit.md');
    const webview = { postMessage: jest.fn(async () => true) };
    const internal = provider as unknown as {
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
    };

    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'malformed-edit-view',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    webview.postMessage.mockClear();
    internal.handleWebviewMessage(
      {
        type: 'edit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: 'malformed-edit-view:1:1',
        viewGeneration: 'malformed-edit-view',
        localRevision: 1,
        baseDocumentVersion: 1,
        content: 42,
        editReason: 'typing',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    expect(workspace.applyEdit).not.toHaveBeenCalled();
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: 'document.edit.ack',
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      editId: 'malformed-edit-view:1:1',
      viewGeneration: 'malformed-edit-view',
      localRevision: 1,
      accepted: false,
      documentVersion: 1,
    });
  });

  it('rejects an old-generation edit received after renderer replacement', () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('unchanged\n', 'file://stale-generation.md');
    const webview = { postMessage: jest.fn(async () => true) } as unknown as vscode.Webview;
    const internal = provider as unknown as {
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
    };

    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'queued-generation-old',
      },
      document as unknown as vscode.TextDocument,
      webview
    );
    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'queued-generation-new',
      },
      document as unknown as vscode.TextDocument,
      webview
    );
    (webview.postMessage as jest.Mock).mockClear();
    internal.handleWebviewMessage(
      {
        type: 'edit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: 'queued-generation-old:1:1',
        viewGeneration: 'queued-generation-old',
        localRevision: 1,
        baseDocumentVersion: 1,
        content: 'must not apply',
        editReason: 'typing',
      },
      document as unknown as vscode.TextDocument,
      webview
    );

    expect(workspace.applyEdit).not.toHaveBeenCalled();
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'document.edit.ack',
        editId: 'queued-generation-old:1:1',
        viewGeneration: 'queued-generation-old',
        accepted: false,
      })
    );
  });

  it('does not cache a host update when posting it fails', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('external content\n', 'file://failed-host-delivery.md');
    const webview = { postMessage: jest.fn(async () => false) };
    const updateWebview = (
      provider as unknown as {
        updateWebview: (doc: vscode.TextDocument, target: vscode.Webview) => void;
      }
    ).updateWebview.bind(provider);

    updateWebview(document as unknown as vscode.TextDocument, webview as unknown as vscode.Webview);
    await Promise.resolve();
    updateWebview(document as unknown as vscode.TextDocument, webview as unknown as vscode.Webview);

    expect(webview.postMessage).toHaveBeenCalledTimes(2);
  });

  it('posts a corrective revert when a different host payload is still in flight', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    let content = 'A\n';
    const document = {
      ...createDocument(content, 'file://deferred-host-revert.md'),
      getText: jest.fn(() => content),
    };
    let resolveDeferredDelivery: ((delivered: boolean) => void) | undefined;
    const deferredDelivery = new Promise<boolean>(resolve => {
      resolveDeferredDelivery = resolve;
    });
    const webview = {
      postMessage: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockImplementationOnce(() => deferredDelivery)
        .mockResolvedValueOnce(true),
    };
    const updateWebview = (
      provider as unknown as {
        updateWebview: (doc: vscode.TextDocument, target: vscode.Webview) => void;
      }
    ).updateWebview.bind(provider);

    updateWebview(document as unknown as vscode.TextDocument, webview as unknown as vscode.Webview);
    await Promise.resolve();

    content = 'B\n';
    updateWebview(document as unknown as vscode.TextDocument, webview as unknown as vscode.Webview);
    content = 'A\n';
    updateWebview(document as unknown as vscode.TextDocument, webview as unknown as vscode.Webview);

    expect(webview.postMessage.mock.calls.map(call => call[0].content)).toEqual([
      'A\n',
      'B\n',
      'A\n',
    ]);

    resolveDeferredDelivery?.(true);
    await Promise.resolve();
    updateWebview(document as unknown as vscode.TextDocument, webview as unknown as vscode.Webview);

    expect(webview.postMessage).toHaveBeenCalledTimes(3);
  });

  it.each(['false', 'rejected'] as const)(
    'retries a corrective revert when its delivery is %s',
    async failureMode => {
      const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
      let content = 'A\n';
      const document = {
        ...createDocument(content, 'file://failed-corrective-revert.md'),
        getText: jest.fn(() => content),
      };
      let resolveDeferredDelivery: ((delivered: boolean) => void) | undefined;
      const deferredDelivery = new Promise<boolean>(resolve => {
        resolveDeferredDelivery = resolve;
      });
      const webview = {
        postMessage: jest
          .fn()
          .mockResolvedValueOnce(true)
          .mockImplementationOnce(() => deferredDelivery)
          .mockImplementationOnce(() =>
            failureMode === 'false'
              ? Promise.resolve(false)
              : Promise.reject(new Error('corrective delivery rejected'))
          )
          .mockResolvedValueOnce(true),
      };
      const updateWebview = (
        provider as unknown as {
          updateWebview: (doc: vscode.TextDocument, target: vscode.Webview) => void;
        }
      ).updateWebview.bind(provider);

      updateWebview(
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      await Promise.resolve();

      content = 'B\n';
      updateWebview(
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      content = 'A\n';
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        updateWebview(
          document as unknown as vscode.TextDocument,
          webview as unknown as vscode.Webview
        );
        await Promise.resolve();
        await Promise.resolve();
        updateWebview(
          document as unknown as vscode.TextDocument,
          webview as unknown as vscode.Webview
        );

        expect(webview.postMessage.mock.calls.map(call => call[0].content)).toEqual([
          'A\n',
          'B\n',
          'A\n',
          'A\n',
        ]);
      } finally {
        consoleError.mockRestore();
      }

      resolveDeferredDelivery?.(true);
      await Promise.resolve();
      updateWebview(
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );

      expect(webview.postMessage).toHaveBeenCalledTimes(4);
    }
  );

  it('applies a teardown revision only after its accepted predecessor', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    let content = 'base\n';
    let version = 4;
    let releasePredecessor: ((accepted: boolean) => void) | undefined;
    const document = {
      getText: jest.fn(() => content),
      uri: { toString: () => 'file://teardown-order.md', scheme: 'file' },
      get version() {
        return version;
      },
      positionAt: jest.fn((offset: number) => new Position(0, offset)),
      save: jest.fn(async () => true),
    };
    const internal = provider as unknown as {
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
    };
    const webview = { postMessage: jest.fn(async () => true) };
    (workspace.applyEdit as jest.Mock)
      .mockImplementationOnce(
        (edit: WorkspaceEdit) =>
          new Promise<boolean>(resolve => {
            releasePredecessor = accepted => {
              if (accepted) {
                content = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces?.[0]
                  ?.text as string;
                version += 1;
              }
              resolve(accepted);
            };
          })
      )
      .mockImplementationOnce(async (edit: WorkspaceEdit) => {
        content = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces?.[0]
          ?.text as string;
        version += 1;
        return true;
      });

    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'teardown-view',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    webview.postMessage.mockClear();
    internal.handleWebviewMessage(
      {
        type: 'edit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: 'teardown-view:1:1',
        viewGeneration: 'teardown-view',
        localRevision: 1,
        baseDocumentVersion: 4,
        content: 'first revision',
        editReason: 'typing',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await Promise.resolve();
    internal.handleWebviewMessage(
      {
        type: 'document.teardown.edit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: 'teardown-view:2:2',
        viewGeneration: 'teardown-view',
        localRevision: 2,
        baseDocumentVersion: 4,
        predecessorEditId: 'teardown-view:1:1',
        predecessorLocalRevision: 1,
        content: 'newest teardown revision',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await Promise.resolve();

    expect(workspace.applyEdit).toHaveBeenCalledTimes(1);
    releasePredecessor?.(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(workspace.applyEdit).toHaveBeenCalledTimes(2);
    expect(content).toBe('newest teardown revision\n');
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'document.edit.ack',
        editId: 'teardown-view:2:2',
        accepted: true,
        documentVersion: 6,
      })
    );
  });

  it('drains a teardown lineage before accepting a replacement renderer generation', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    let content = 'base\n';
    let version = 4;
    let releaseBarrier: (() => void) | undefined;
    const document = {
      getText: jest.fn(() => content),
      uri: { toString: () => 'file://teardown-rehydrate.md', scheme: 'file' },
      get version() {
        return version;
      },
      positionAt: jest.fn((offset: number) => new Position(0, offset)),
      save: jest.fn(async () => true),
    };
    const internal = provider as unknown as {
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
      editViewGenerations: WeakMap<vscode.Webview, string>;
      documentEditCoordinator: import('../../editor/documentEditCoordinator').DocumentEditCoordinator<string>;
    };
    const webview = { postMessage: jest.fn(async () => true) };
    (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
      content = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces?.[0]
        ?.text as string;
      version += 1;
      return true;
    });

    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'teardown-old-view',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const barrier = internal.documentEditCoordinator.enqueue(document.uri.toString(), {
      kind: 'operation',
      execute: () => new Promise<void>(resolve => (releaseBarrier = resolve)),
    });
    await Promise.resolve();
    internal.handleWebviewMessage(
      {
        type: 'edit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: 'teardown-old-view:1:1',
        viewGeneration: 'teardown-old-view',
        localRevision: 1,
        baseDocumentVersion: 4,
        content: 'first revision',
        editReason: 'typing',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    internal.handleWebviewMessage(
      {
        type: 'document.teardown.edit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: 'teardown-old-view:2:2',
        viewGeneration: 'teardown-old-view',
        localRevision: 2,
        baseDocumentVersion: 4,
        predecessorEditId: 'teardown-old-view:1:1',
        predecessorLocalRevision: 1,
        content: 'newest teardown revision',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'teardown-new-view',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    expect(internal.editViewGenerations.get(webview as unknown as vscode.Webview)).toBe(
      'teardown-old-view'
    );
    releaseBarrier?.();
    await barrier;
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(workspace.applyEdit).toHaveBeenCalledTimes(2);
    expect(content).toBe('newest teardown revision\n');
    expect(internal.editViewGenerations.get(webview as unknown as vscode.Webview)).toBe(
      'teardown-new-view'
    );
  });

  it('drains an in-flight edit before accepting a replacement renderer generation', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    let releaseBarrier: (() => void) | undefined;
    const document = createDocument('base\n', 'file://inflight-rehydrate.md');
    const webview = { postMessage: jest.fn(async () => true) };
    const internal = provider as unknown as {
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
      editViewGenerations: WeakMap<vscode.Webview, string>;
      documentEditCoordinator: import('../../editor/documentEditCoordinator').DocumentEditCoordinator<string>;
    };

    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'inflight-old-view',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    const barrier = internal.documentEditCoordinator.enqueue(document.uri.toString(), {
      kind: 'operation',
      execute: () => new Promise<void>(resolve => (releaseBarrier = resolve)),
    });
    await Promise.resolve();
    internal.handleWebviewMessage(
      {
        type: 'edit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: 'inflight-old-view:1:1',
        viewGeneration: 'inflight-old-view',
        localRevision: 1,
        baseDocumentVersion: 1,
        content: 'accepted before reload',
        editReason: 'typing',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'inflight-new-view',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    expect(internal.editViewGenerations.get(webview as unknown as vscode.Webview)).toBe(
      'inflight-old-view'
    );
    releaseBarrier?.();
    await barrier;
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(workspace.applyEdit).toHaveBeenCalledTimes(1);
    expect(internal.editViewGenerations.get(webview as unknown as vscode.Webview)).toBe(
      'inflight-new-view'
    );
  });

  it('resolves a pending image marker before applying a renderer edit', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('base\n', 'file://pending-image-edit.md');
    const webview = { postMessage: jest.fn(async () => true) };
    const internal = provider as unknown as {
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
      trackPendingImageSave: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
      persistImage: jest.Mock<Promise<{ kind: 'saved'; destination: string }>>;
      editViewGenerations: WeakMap<vscode.Webview, string>;
    };
    internal.persistImage = jest.fn(async () => ({
      kind: 'saved' as const,
      destination: './images/saved image.png',
    }));

    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'pending-image-view',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    internal.trackPendingImageSave(
      {
        type: 'saveImage',
        protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
        viewGeneration: 'pending-image-view',
        placeholderId: 'img-123',
        name: 'saved image.png',
        data: new Uint8Array([1, 2, 3]),
        mimeType: 'image/png',
        targetFolder: 'images',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    internal.handleWebviewMessage(
      {
        type: 'edit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: 'pending-image-view:1:1',
        viewGeneration: 'pending-image-view',
        localRevision: 1,
        baseDocumentVersion: 1,
        content: '![Pending](md4h-pending-image:img-123)',
        editReason: 'typing',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    const edit = (workspace.applyEdit as jest.Mock).mock.calls[0]?.[0] as
      (WorkspaceEdit & { replaces?: Array<{ text: string }> }) | undefined;
    expect(edit?.replaces?.[0]?.text).toBe('![Pending](<./images/saved image.png>)\n');
    expect(edit?.replaces?.[0]?.text).not.toMatch(/base64|md4h-pending-image/);
  });

  it('retains pending image bytes densely, then releases them after a successful save', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('base\n', 'file://pending-image-memory.md');
    const webview = { postMessage: jest.fn(async () => true) } as unknown as vscode.Webview;
    const internalViewGeneration = 'pending-image-memory-view';
    let resolvePersistence: ((result: { kind: 'saved'; destination: string }) => void) | undefined;
    const persistence = new Promise<{ kind: 'saved'; destination: string }>(resolve => {
      resolvePersistence = resolve;
    });
    const internal = provider as unknown as {
      trackPendingImageSave: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
      resolvePendingImageDestinations: (
        content: string,
        source: vscode.Webview,
        viewGeneration: string
      ) => Promise<string>;
      persistImage: jest.Mock<Promise<{ kind: 'saved'; destination: string }>>;
      pendingHostImageSaves: WeakMap<
        vscode.Webview,
        Map<string, { data?: Uint8Array; completion: Promise<string | null> }>
      >;
      editViewGenerations: WeakMap<vscode.Webview, string>;
    };
    internal.persistImage = jest.fn(() => persistence);
    internal.editViewGenerations.set(webview, internalViewGeneration);
    const payload = new Uint8Array([1, 2, 3, 4]);

    internal.trackPendingImageSave(
      {
        type: 'saveImage',
        protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
        viewGeneration: internalViewGeneration,
        placeholderId: 'memory-image',
        name: 'saved.png',
        data: payload,
        mimeType: 'image/png',
      },
      document as unknown as vscode.TextDocument,
      webview
    );

    const pending = internal.pendingHostImageSaves.get(webview);
    const retained = pending?.get('memory-image')?.data;
    expect(retained).toBeInstanceOf(Uint8Array);
    expect(retained).not.toBe(payload);
    expect(retained?.byteLength).toBe(4);
    expect(retained?.buffer.byteLength).toBe(4);
    expect([...((retained ?? new Uint8Array()) as Uint8Array)]).toEqual([1, 2, 3, 4]);
    payload.fill(9);
    expect([...((retained ?? new Uint8Array()) as Uint8Array)]).toEqual([1, 2, 3, 4]);

    resolvePersistence?.({ kind: 'saved', destination: './images/saved.png' });
    await pending?.get('memory-image')?.completion;

    expect(pending?.get('memory-image')?.data).toBeUndefined();

    await internal.resolvePendingImageDestinations(
      'No pending marker remains.\n',
      webview,
      internalViewGeneration
    );
    expect(pending?.size).toBe(0);
  });

  it('normalizes an accepted Uint8Array view once before retaining and writing it', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('base\n', 'file://pending-image-dense-view.md');
    const webview = {
      postMessage: jest.fn(async (_message: unknown) => true),
    } as unknown as vscode.Webview;
    const internal = provider as unknown as {
      trackPendingImageSave: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
      persistImage: jest.Mock<Promise<{ kind: 'saved'; destination: string }>>;
      pendingHostImageSaves: WeakMap<
        vscode.Webview,
        Map<string, { data?: Uint8Array; completion: Promise<string | null> }>
      >;
      editViewGenerations: WeakMap<vscode.Webview, string>;
    };
    let resolvePersistence: ((result: { kind: 'saved'; destination: string }) => void) | undefined;
    internal.persistImage = jest.fn(
      () =>
        new Promise(resolve => {
          resolvePersistence = resolve;
        })
    );
    internal.editViewGenerations.set(webview, 'dense-view');
    const transferredView = new Uint8Array(16).subarray(4, 8);
    transferredView.set([1, 2, 3, 4]);

    internal.trackPendingImageSave(
      {
        type: 'saveImage',
        protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
        viewGeneration: 'dense-view',
        placeholderId: 'dense-image',
        name: 'dense.png',
        data: transferredView,
        mimeType: 'image/png',
      },
      document as unknown as vscode.TextDocument,
      webview
    );

    const entry = internal.pendingHostImageSaves.get(webview)?.get('dense-image');
    expect(entry?.data).not.toBe(transferredView);
    expect(entry?.data?.byteOffset).toBe(0);
    expect(entry?.data?.byteLength).toBe(4);
    expect(entry?.data?.buffer.byteLength).toBe(4);
    await Promise.resolve();
    expect(internal.persistImage.mock.calls[0]?.[2]).toBe(entry?.data);

    resolvePersistence?.({ kind: 'saved', destination: './images/dense.png' });
    await entry?.completion;
    provider.dispose();
  });

  it('stops completion retry on ACK while retaining teardown resolution metadata', async () => {
    jest.useFakeTimers();
    try {
      const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
      const document = createDocument('base\n', 'file://pending-image-ack.md');
      const postMessage = jest.fn(async (_message: unknown) => true);
      const webview = { postMessage } as unknown as vscode.Webview;
      const internal = provider as unknown as {
        trackPendingImageSave: (
          message: { type: string; [key: string]: unknown },
          doc: vscode.TextDocument,
          source: vscode.Webview
        ) => void;
        handleWebviewMessage: (
          message: { type: string; [key: string]: unknown },
          doc: vscode.TextDocument,
          source: vscode.Webview
        ) => void;
        persistImage: jest.Mock<Promise<{ kind: 'saved'; destination: string }>>;
        editViewGenerations: WeakMap<vscode.Webview, string>;
        pendingHostImageSaves: WeakMap<
          vscode.Webview,
          Map<string, { completion: Promise<string | null> }>
        >;
      };
      internal.persistImage = jest.fn(
        async (): Promise<{ kind: 'saved'; destination: string }> => ({
          kind: 'saved',
          destination: './images/acked.png',
        })
      );
      internal.editViewGenerations.set(webview, 'image-view-1');

      internal.trackPendingImageSave(
        {
          type: 'saveImage',
          protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
          viewGeneration: 'image-view-1',
          placeholderId: 'acked-image',
          name: 'acked.png',
          data: new Uint8Array([1, 2, 3]),
          mimeType: 'image/png',
        },
        document as unknown as vscode.TextDocument,
        webview
      );
      await internal.pendingHostImageSaves.get(webview)?.get('acked-image')?.completion;

      const completion = postMessage.mock.calls[0]?.[0] as {
        type: string;
        protocolVersion: number;
        completionId: string;
        placeholderId: string;
        viewGeneration: string;
      };
      expect(completion).toEqual(
        expect.objectContaining({
          type: 'imageSaved',
          placeholderId: 'acked-image',
          viewGeneration: 'image-view-1',
          newSrc: './images/acked.png',
        })
      );

      internal.handleWebviewMessage(
        {
          type: 'imageSaveCompletionAck',
          protocolVersion: completion.protocolVersion,
          completionId: completion.completionId,
          placeholderId: completion.placeholderId,
          viewGeneration: completion.viewGeneration,
        },
        document as unknown as vscode.TextDocument,
        webview
      );
      await jest.advanceTimersByTimeAsync(10_000);

      expect(postMessage).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves a settled destination for teardown after renderer delivery retires', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('base\n', 'file://pending-image-teardown.md');
    const webview = { postMessage: jest.fn(async () => true) } as unknown as vscode.Webview;
    let resolvePersistence: ((result: { kind: 'saved'; destination: string }) => void) | undefined;
    const persistence = new Promise<{ kind: 'saved'; destination: string }>(resolve => {
      resolvePersistence = resolve;
    });
    const internal = provider as unknown as {
      trackPendingImageSave: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
      retirePendingImageCompletionDeliveries: (source: vscode.Webview) => void;
      resolvePendingImageDestinations: (
        content: string,
        source: vscode.Webview,
        viewGeneration: string
      ) => Promise<string>;
      persistImage: jest.Mock<Promise<{ kind: 'saved'; destination: string }>>;
      editViewGenerations: WeakMap<vscode.Webview, string>;
    };
    internal.persistImage = jest.fn(() => persistence);
    internal.editViewGenerations.set(webview, 'teardown-image-view');

    internal.trackPendingImageSave(
      {
        type: 'saveImage',
        protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
        viewGeneration: 'teardown-image-view',
        placeholderId: 'teardown-image',
        name: 'teardown.png',
        data: new Uint8Array([4, 5, 6]),
        mimeType: 'image/png',
      },
      document as unknown as vscode.TextDocument,
      webview
    );
    internal.retirePendingImageCompletionDeliveries(webview);
    resolvePersistence?.({ kind: 'saved', destination: './images/teardown.png' });
    await Promise.resolve();
    await Promise.resolve();

    expect(webview.postMessage).not.toHaveBeenCalled();
    await expect(
      internal.resolvePendingImageDestinations(
        '![Pending](md4h-pending-image:teardown-image)',
        webview,
        'teardown-image-view'
      )
    ).resolves.toBe('![Pending](./images/teardown.png)');
  });

  it('retries and ACKs a correlated capacity rejection without evicting unresolved markers', async () => {
    jest.useFakeTimers();
    try {
      const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
      const document = createDocument('base\n', 'file://pending-image-capacity.md');
      const postMessage = jest
        .fn((_message: unknown): Promise<boolean> => Promise.resolve(true))
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);
      const webview = { postMessage } as unknown as vscode.Webview;
      const internal = provider as unknown as {
        trackPendingImageSave: (
          message: { type: string; [key: string]: unknown },
          doc: vscode.TextDocument,
          source: vscode.Webview
        ) => void;
        handleWebviewMessage: (
          message: { type: string; [key: string]: unknown },
          doc: vscode.TextDocument,
          source: vscode.Webview
        ) => void;
        persistImage: jest.Mock<Promise<{ kind: 'saved'; destination: string }>>;
        editViewGenerations: WeakMap<vscode.Webview, string>;
        pendingHostImageSaves: WeakMap<
          vscode.Webview,
          Map<
            string,
            {
              placeholderId: string;
              data: Uint8Array;
              mimeType: string;
              completion: Promise<string | null>;
            }
          >
        >;
      };
      const unresolved = new Promise<string | null>(() => undefined);
      const pending = new Map<
        string,
        {
          placeholderId: string;
          data: Uint8Array;
          mimeType: string;
          completion: Promise<string | null>;
        }
      >();
      for (let index = 0; index < 128; index += 1) {
        const placeholderId = `existing-${index}`;
        pending.set(placeholderId, {
          placeholderId,
          data: new Uint8Array([index & 0xff]),
          mimeType: 'image/png',
          completion: unresolved,
        });
      }
      internal.pendingHostImageSaves.set(webview, pending);
      internal.editViewGenerations.set(webview, 'capacity-image-view');
      internal.persistImage = jest.fn(async () => ({
        kind: 'saved' as const,
        destination: './images/must-not-start.png',
      }));

      internal.trackPendingImageSave(
        {
          type: 'saveImage',
          protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
          viewGeneration: 'capacity-image-view',
          placeholderId: 'over-capacity',
          name: 'over-capacity.png',
          data: new Uint8Array([1, 2, 3]),
          mimeType: 'image/png',
        },
        document as unknown as vscode.TextDocument,
        webview
      );

      expect(internal.persistImage).not.toHaveBeenCalled();
      expect(pending.size).toBe(128);
      expect(pending.has('existing-0')).toBe(true);
      expect(pending.has('over-capacity')).toBe(false);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(250);
      expect(postMessage).toHaveBeenCalledTimes(2);
      const completion = postMessage.mock.calls[1]?.[0] as {
        protocolVersion: number;
        completionId: string;
        placeholderId: string;
        viewGeneration: string;
      };
      expect(completion).toEqual(
        expect.objectContaining({
          type: 'imageError',
          protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
          placeholderId: 'over-capacity',
          viewGeneration: 'capacity-image-view',
        })
      );
      internal.handleWebviewMessage(
        {
          type: 'imageSaveCompletionAck',
          protocolVersion: completion.protocolVersion,
          completionId: completion.completionId,
          placeholderId: completion.placeholderId,
          viewGeneration: completion.viewGeneration,
        },
        document as unknown as vscode.TextDocument,
        webview
      );
      await jest.advanceTimersByTimeAsync(10_000);
      expect(postMessage).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects an unknown pending marker before creating a WorkspaceEdit', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('base\n', 'file://unknown-pending-image.md');
    const webview = { postMessage: jest.fn(async () => true) } as unknown as vscode.Webview;
    const internal = provider as unknown as {
      applyEdit: (
        content: string,
        doc: vscode.TextDocument,
        options: {
          editReason: 'typing';
          sourceWebview: vscode.Webview;
          viewGeneration: string;
        }
      ) => Promise<boolean>;
      editViewGenerations: WeakMap<vscode.Webview, string>;
    };
    internal.editViewGenerations.set(webview, 'unknown-marker-view');

    await expect(
      internal.applyEdit(
        '![Pending](md4h-pending-image:unknown)',
        document as unknown as vscode.TextDocument,
        {
          editReason: 'typing',
          sourceWebview: webview,
          viewGeneration: 'unknown-marker-view',
        }
      )
    ).resolves.toBe(false);
    expect(workspace.applyEdit).not.toHaveBeenCalled();
  });

  it('rejects a teardown revision when its predecessor did not apply', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = {
      ...createDocument('base\n', 'file://teardown-rejected-predecessor.md'),
      version: 4,
    };
    const internal = provider as unknown as {
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
    };
    const webview = { postMessage: jest.fn(async () => true) };
    (workspace.applyEdit as jest.Mock).mockResolvedValue(false);

    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'teardown-reject-view',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    webview.postMessage.mockClear();
    internal.handleWebviewMessage(
      {
        type: 'edit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: 'teardown-reject-view:1:1',
        viewGeneration: 'teardown-reject-view',
        localRevision: 1,
        baseDocumentVersion: 4,
        content: 'first revision',
        editReason: 'typing',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    internal.handleWebviewMessage(
      {
        type: 'document.teardown.edit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: 'teardown-reject-view:2:2',
        viewGeneration: 'teardown-reject-view',
        localRevision: 2,
        baseDocumentVersion: 4,
        predecessorEditId: 'teardown-reject-view:1:1',
        predecessorLocalRevision: 1,
        content: 'must not apply',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(workspace.applyEdit).toHaveBeenCalledTimes(1);
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'document.edit.ack',
        editId: 'teardown-reject-view:2:2',
        accepted: false,
      })
    );
  });

  it('executes save only after the preceding coordinated document edit settles', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    let releaseEdit: ((accepted: boolean) => void) | undefined;
    const document = createDocument('before save\n', 'file://ordered-save.md');
    const internal = provider as unknown as {
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
    };
    const webview = {
      postMessage: jest.fn((message: { type?: string; requestId?: string }) => {
        if (message.type === 'flushPendingEdit') {
          queueMicrotask(() =>
            internal.handleWebviewMessage(
              createFlushAcknowledgement(message, true),
              document as unknown as vscode.TextDocument,
              webview as unknown as vscode.Webview
            )
          );
        }
        return Promise.resolve(true);
      }),
    };
    (workspace.applyEdit as jest.Mock).mockImplementation(
      () => new Promise<boolean>(resolve => (releaseEdit = resolve))
    );

    internal.handleWebviewMessage(
      { type: 'edit', content: 'pending save content', editReason: 'save-policy-enforce' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await Promise.resolve();
    internal.handleWebviewMessage(
      { type: 'save' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await Promise.resolve();

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    releaseEdit?.(true);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(document.save).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('flushes a newer renderer revision at the host version before explicit save', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    let content = 'host content\n';
    let version = 4;
    let releaseEdit: ((accepted: boolean) => void) | undefined;
    const document = {
      getText: jest.fn(() => content),
      uri: { toString: () => 'file://flush-before-save.md', scheme: 'file' },
      get version() {
        return version;
      },
      positionAt: jest.fn((offset: number) => new Position(0, offset)),
      save: jest.fn(async () => true),
    };
    const internal = provider as unknown as {
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
    };
    const webview = {
      postMessage: jest.fn((message: { type?: string; requestId?: string }) => {
        if (message.type === 'flushPendingEdit') {
          queueMicrotask(() => {
            internal.handleWebviewMessage(
              {
                type: 'edit',
                protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
                editId: 'save-view:2:1',
                viewGeneration: 'save-view',
                localRevision: 2,
                baseDocumentVersion: 4,
                content: 'newest renderer content',
                editReason: 'save-policy-enforce',
              },
              document as unknown as vscode.TextDocument,
              webview as unknown as vscode.Webview
            );
            internal.handleWebviewMessage(
              createFlushAcknowledgement(message, true),
              document as unknown as vscode.TextDocument,
              webview as unknown as vscode.Webview
            );
          });
        }
        return Promise.resolve(true);
      }),
    };
    (workspace.applyEdit as jest.Mock).mockImplementation(
      (edit: WorkspaceEdit) =>
        new Promise<boolean>(resolve => {
          releaseEdit = accepted => {
            if (accepted) {
              content = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces?.[0]
                ?.text as string;
              version += 1;
            }
            resolve(accepted);
          };
        })
    );

    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'save-view',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    webview.postMessage.mockClear();
    internal.handleWebviewMessage(
      { type: 'save' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'flushPendingEdit', documentVersion: 4 })
    );
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();

    releaseEdit?.(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(document.save).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('does not save when the revision emitted by the save barrier is rejected', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = {
      ...createDocument('host content\n', 'file://rejected-save-flush.md'),
      version: 4,
    };
    const internal = provider as unknown as {
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
    };
    const webview = {
      postMessage: jest.fn((message: { type?: string; requestId?: string }) => {
        if (message.type === 'flushPendingEdit') {
          queueMicrotask(() => {
            internal.handleWebviewMessage(
              {
                type: 'edit',
                protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
                editId: 'rejected-save-view:2:1',
                viewGeneration: 'rejected-save-view',
                localRevision: 2,
                baseDocumentVersion: 4,
                content: 'rejected renderer content',
                editReason: 'save-policy-enforce',
              },
              document as unknown as vscode.TextDocument,
              webview as unknown as vscode.Webview
            );
            internal.handleWebviewMessage(
              createFlushAcknowledgement(message, true),
              document as unknown as vscode.TextDocument,
              webview as unknown as vscode.Webview
            );
          });
        }
        return Promise.resolve(true);
      }),
    };
    (workspace.applyEdit as jest.Mock).mockResolvedValue(false);

    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'rejected-save-view',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    webview.postMessage.mockClear();
    internal.handleWebviewMessage(
      { type: 'save' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('uses a versioned renderer boundary before focus autosave', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = {
      ...createDocument('dirty\n', 'file://versioned-focus-autosave.md'),
      isDirty: true,
      version: 6,
    };
    const internal = provider as unknown as {
      flushAndSaveIfDirty: (doc: vscode.TextDocument, source: vscode.Webview) => Promise<void>;
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
    };
    const webview = {
      postMessage: jest.fn((message: { type?: string; requestId?: string }) => {
        queueMicrotask(() =>
          internal.handleWebviewMessage(
            createFlushAcknowledgement(message, true),
            document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          )
        );
        return Promise.resolve(true);
      }),
    };
    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'focus-autosave-view',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    webview.postMessage.mockClear();

    await internal.flushAndSaveIfDirty(
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'flushPendingEdit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'focus-autosave-view',
        documentVersion: 6,
      })
    );
    expect(document.save).toHaveBeenCalledTimes(1);
  });

  it('accepts a flush acknowledgement only from its exact renderer lineage', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = {
      ...createDocument('dirty\n', 'file://strict-flush-ack.md'),
      version: 6,
    };
    const internal = provider as unknown as {
      requestDocumentFlush: (
        doc: vscode.TextDocument,
        source: vscode.Webview,
        timeoutMs: number,
        requestPrefix: string
      ) => Promise<boolean>;
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
    };
    const webview = { postMessage: jest.fn((_message: unknown) => Promise.resolve(true)) };
    const foreignWebview = {
      postMessage: jest.fn((_message: unknown) => Promise.resolve(true)),
    };

    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'strict-flush-view',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    webview.postMessage.mockClear();

    let settled = false;
    const flush = internal
      .requestDocumentFlush(
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview,
        10_000,
        'strict-flush'
      )
      .finally(() => {
        settled = true;
      });
    await Promise.resolve();
    const barrier = webview.postMessage.mock.calls[0][0] as {
      requestId: string;
      viewGeneration: string;
      documentVersion: number;
    };
    const acknowledgement = {
      type: 'flushPendingEditAck',
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      requestId: barrier.requestId,
      viewGeneration: barrier.viewGeneration,
      documentVersion: barrier.documentVersion,
      ok: true,
    };

    internal.handleWebviewMessage(
      acknowledgement,
      document as unknown as vscode.TextDocument,
      foreignWebview as unknown as vscode.Webview
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    internal.handleWebviewMessage(
      { ...acknowledgement, viewGeneration: 'retired-view' },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    internal.handleWebviewMessage(
      acknowledgement,
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await expect(flush).resolves.toBe(true);
  });

  it('host-saves an accepted edit after its non-retained panel becomes inactive', async () => {
    const getConfiguration = jest.spyOn(vscode.workspace, 'getConfiguration').mockImplementation(
      (section?: string) =>
        ({
          get: jest.fn((key: string, defaultValue?: unknown) =>
            section === 'files' && key === 'autoSave' ? 'onFocusChange' : defaultValue
          ),
        }) as unknown as vscode.WorkspaceConfiguration
    );
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = {
      ...createDocument('before hide\n', 'file://inactive-host-save.md'),
      isDirty: true,
    };
    (workspace.applyEdit as jest.Mock).mockResolvedValue(true);
    const webview = { postMessage: jest.fn(async () => true) };
    const internal = provider as unknown as {
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
      inactiveAutoSaveWebviews: WeakSet<vscode.Webview>;
    };

    internal.handleWebviewMessage(
      {
        type: 'ready',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        viewGeneration: 'inactive-save-view',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    internal.inactiveAutoSaveWebviews.add(webview as unknown as vscode.Webview);
    internal.handleWebviewMessage(
      {
        type: 'edit',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        editId: 'inactive-save-view:1:1',
        viewGeneration: 'inactive-save-view',
        localRevision: 1,
        baseDocumentVersion: 1,
        content: 'newest hidden content',
        editReason: 'typing',
      },
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(document.save).toHaveBeenCalledTimes(1);
    getConfiguration.mockRestore();
  });

  it.each([
    ['negative flush acknowledgement', 'ack-false'],
    ['post rejection', 'post-rejection'],
    ['post returning false', 'post-false'],
    ['flush acknowledgement timeout', 'timeout'],
  ])('does not focus-autosave after %s', async (_label, failure) => {
    if (failure === 'timeout') jest.useFakeTimers();
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = {
      ...createDocument('dirty\n', `file://focus-autosave-${failure}.md`),
      isDirty: true,
      save: jest.fn(async () => true),
    };
    const internal = provider as unknown as {
      flushAndSaveIfDirty: (doc: vscode.TextDocument, source: vscode.Webview) => Promise<void>;
      handleWebviewMessage: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
    };
    const webview = {
      postMessage: jest.fn((message: { type?: string; requestId?: string }) => {
        if (failure === 'post-rejection') return Promise.reject(new Error('closed webview'));
        if (failure === 'post-false') return Promise.resolve(false);
        if (failure === 'ack-false') {
          queueMicrotask(() =>
            internal.handleWebviewMessage(
              createFlushAcknowledgement(message, false),
              document as unknown as vscode.TextDocument,
              webview as unknown as vscode.Webview
            )
          );
        }
        return Promise.resolve(true);
      }),
    };

    const saveAttempt = internal.flushAndSaveIfDirty(
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    if (failure === 'timeout') await jest.advanceTimersByTimeAsync(2_000);
    await saveAttempt;

    expect(document.save).not.toHaveBeenCalled();
    if (failure === 'timeout') jest.useRealTimers();
  });

  it('bounds focus autosave when webview delivery never settles', async () => {
    jest.useFakeTimers();
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = {
      ...createDocument('dirty\n', 'file://focus-autosave-never-settles.md'),
      isDirty: true,
      save: jest.fn(async () => true),
    };
    const internal = provider as unknown as {
      flushAndSaveIfDirty: (doc: vscode.TextDocument, source: vscode.Webview) => Promise<void>;
    };
    const webview = {
      postMessage: jest.fn(() => new Promise<boolean>(() => undefined)),
    };
    let settled = false;

    void internal
      .flushAndSaveIfDirty(
        document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      )
      .finally(() => {
        settled = true;
      });
    await jest.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();

    expect(settled).toBe(true);
    expect(document.save).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('cancels queued work and clears timers when the provider is disposed', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const internal = provider as unknown as {
      dispose: () => void;
      documentEditCoordinator: import('../../editor/documentEditCoordinator').DocumentEditCoordinator<string>;
      autoSaveTimers: Map<string, ReturnType<typeof setTimeout>>;
      flushAckResolvers: Map<
        string,
        {
          webview: vscode.Webview;
          viewGeneration: string;
          documentVersion: number;
          settled: Promise<void>;
          resolve: (ok: boolean) => void;
        }
      >;
    };
    const active = internal.documentEditCoordinator.enqueue('file://dispose.md', {
      kind: 'operation',
      execute: ({ signal }) =>
        new Promise<void>(resolve =>
          signal.addEventListener('abort', () => resolve(), { once: true })
        ),
    });
    await Promise.resolve();
    const timer = setTimeout(() => undefined, 60_000);
    const flushResolver = jest.fn();
    internal.autoSaveTimers.set('file://dispose.md', timer);
    internal.flushAckResolvers.set('flush-1', {
      webview: {} as vscode.Webview,
      viewGeneration: 'dispose-view',
      documentVersion: 1,
      settled: Promise.resolve(),
      resolve: flushResolver,
    });

    internal.dispose();

    await expect(active).resolves.toMatchObject({ status: 'cancelled' });
    expect(internal.autoSaveTimers.size).toBe(0);
    expect(internal.flushAckResolvers.size).toBe(0);
    expect(flushResolver).toHaveBeenCalledWith(false);
    await expect(
      internal.documentEditCoordinator.enqueue('file://dispose.md', {
        kind: 'operation',
        execute: () => undefined,
      })
    ).resolves.toMatchObject({ status: 'cancelled', queueRevision: null });
  });

  it('cancels pending image completion retry timers when the provider is disposed', async () => {
    jest.useFakeTimers();
    try {
      const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
      const document = createDocument('base\n', 'file://dispose-pending-image-delivery.md');
      const postMessage = jest.fn(async (_message: unknown) => true);
      const webview = { postMessage } as unknown as vscode.Webview;
      const internal = provider as unknown as {
        trackPendingImageSave: (
          message: { type: string; [key: string]: unknown },
          doc: vscode.TextDocument,
          source: vscode.Webview
        ) => void;
        persistImage: jest.Mock<Promise<{ kind: 'saved'; destination: string }>>;
        editViewGenerations: WeakMap<vscode.Webview, string>;
        activeImageCompletionDeliveries: Set<unknown>;
        pendingHostImageSaves: WeakMap<
          vscode.Webview,
          Map<string, { completion: Promise<string | null> }>
        >;
      };
      internal.persistImage = jest.fn(async () => ({
        kind: 'saved' as const,
        destination: './images/disposed.png',
      }));
      internal.editViewGenerations.set(webview, 'dispose-image-view');

      internal.trackPendingImageSave(
        {
          type: 'saveImage',
          protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
          viewGeneration: 'dispose-image-view',
          placeholderId: 'disposed-image',
          name: 'disposed.png',
          data: new Uint8Array([1, 2, 3]),
          mimeType: 'image/png',
        },
        document as unknown as vscode.TextDocument,
        webview
      );
      await internal.pendingHostImageSaves.get(webview)?.get('disposed-image')?.completion;

      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(internal.activeImageCompletionDeliveries.size).toBe(1);

      provider.dispose();
      await jest.advanceTimersByTimeAsync(10_000);

      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(internal.activeImageCompletionDeliveries.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not start image completion delivery when persistence settles after disposal', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('base\n', 'file://dispose-pending-image-write.md');
    const postMessage = jest.fn(async (_message: unknown) => true);
    const webview = { postMessage } as unknown as vscode.Webview;
    let resolvePersistence: ((result: { kind: 'saved'; destination: string }) => void) | undefined;
    const persistence = new Promise<{ kind: 'saved'; destination: string }>(resolve => {
      resolvePersistence = resolve;
    });
    const internal = provider as unknown as {
      trackPendingImageSave: (
        message: { type: string; [key: string]: unknown },
        doc: vscode.TextDocument,
        source: vscode.Webview
      ) => void;
      persistImage: jest.Mock<Promise<{ kind: 'saved'; destination: string }>>;
      editViewGenerations: WeakMap<vscode.Webview, string>;
      pendingHostImageSaves: WeakMap<
        vscode.Webview,
        Map<string, { completion: Promise<string | null> }>
      >;
    };
    internal.persistImage = jest.fn(() => persistence);
    internal.editViewGenerations.set(webview, 'dispose-write-view');

    internal.trackPendingImageSave(
      {
        type: 'saveImage',
        protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
        viewGeneration: 'dispose-write-view',
        placeholderId: 'disposed-write',
        name: 'disposed-write.png',
        data: new Uint8Array([1, 2, 3]),
        mimeType: 'image/png',
      },
      document as unknown as vscode.TextDocument,
      webview
    );
    provider.dispose();
    resolvePersistence?.({ kind: 'saved', destination: './images/disposed-write.png' });
    await internal.pendingHostImageSaves.get(webview)?.get('disposed-write')?.completion;

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('should skip an echo when content matches the payload sent by that webview', () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    const document = createDocument('same content');
    const webview = { postMessage: jest.fn() };

    (provider as unknown as { lastWebviewContent: Map<string, string> }).lastWebviewContent.set(
      document.uri.toString(),
      'same content'
    );
    (
      provider as unknown as {
        lastWebviewContentSource: Map<string, { postMessage: jest.Mock }>;
      }
    ).lastWebviewContentSource.set(document.uri.toString(), webview);

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
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      documentVersion: 1,
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
      enableMath: true,
      formattingShortcutsEnabled: true,
    });
  });

  it('should deliver an external revert to content last sent before a webview edit', async () => {
    const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
    let content = 'A\n';
    const document = {
      getText: jest.fn(() => content),
      uri: { toString: () => 'file://external-revert.md' },
      positionAt: jest.fn((offset: number) => new Position(0, offset)),
    };
    const webview = { postMessage: jest.fn() };

    (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
      const replaces = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces ?? [];
      content = replaces[0]?.text ?? content;
      return true;
    });

    const internal = provider as unknown as {
      applyEdit: (
        nextContent: string,
        doc: vscode.TextDocument,
        options: { sourceWebview: vscode.Webview }
      ) => Promise<boolean>;
      pendingEdits: Map<string, number>;
      updateWebview: (doc: vscode.TextDocument, target: vscode.Webview) => void;
    };

    internal.updateWebview(
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );
    await internal.applyEdit('B\n', document as unknown as vscode.TextDocument, {
      sourceWebview: webview as unknown as vscode.Webview,
    });

    content = 'A\n';
    internal.pendingEdits.delete(document.uri.toString());
    internal.updateWebview(
      document as unknown as vscode.TextDocument,
      webview as unknown as vscode.Webview
    );

    expect(webview.postMessage).toHaveBeenCalledTimes(2);
    expect(webview.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'update', content: 'A\n' })
    );
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
      protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
      documentVersion: 1,
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
      enableMath: true,
      formattingShortcutsEnabled: true,
    });

    getConfigurationSpy.mockRestore();
  });
});
