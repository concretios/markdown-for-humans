/**
 * Host-side regressions for document sync and save recovery (post-merge 03).
 *
 * Y1: every document version change reaches the renderer, either as content
 *     or as a version-only update, so a save participant or a blank-line-only
 *     change cannot strand the renderer on a stale base version.
 * Y1: a renderer that kept its typing over a concurrent change can recover the
 *     replaced file version.
 * Y2: a renderer that stops reconciling gets a visible reload action.
 * Y3: Ctrl+S never fails silently when the renderer flush fails or times out.
 */

import * as vscode from 'vscode';
import { Position, WorkspaceEdit, window, workspace } from 'vscode';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';
import { DOCUMENT_SYNC_PROTOCOL_VERSION } from '../../shared/documentSyncProtocol';

type HostMessage = { type: string; [key: string]: unknown };

interface ProviderInternals {
  handleWebviewMessage: (
    message: HostMessage,
    document: vscode.TextDocument,
    webview: vscode.Webview
  ) => void;
  updateWebview: (document: vscode.TextDocument, webview: vscode.Webview) => void;
  getHtmlForWebview: (webview: vscode.Webview) => string;
}

interface MutableDocument {
  getText: jest.Mock;
  uri: { toString: () => string; scheme: string };
  readonly version: number;
  isDirty: boolean;
  positionAt: jest.Mock;
  save: jest.Mock;
}

function createMutableDocument(initialText: string, initialVersion: number, uri: string) {
  let text = initialText;
  let version = initialVersion;
  const document: MutableDocument = {
    getText: jest.fn(() => text),
    uri: { toString: () => uri, scheme: 'file' },
    get version() {
      return version;
    },
    isDirty: true,
    positionAt: jest.fn((offset: number) => new Position(0, offset)),
    save: jest.fn(async () => true),
  };
  return {
    document,
    /** Simulate any document change (participant, source split, external writer). */
    setText(next: string) {
      text = next;
      version += 1;
    },
    getText: () => text,
  };
}

function createWebview() {
  return { postMessage: jest.fn(async (_message: HostMessage) => true), html: '' };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

function sendReady(
  internal: ProviderInternals,
  document: MutableDocument,
  webview: ReturnType<typeof createWebview>,
  viewGeneration: string
): void {
  internal.handleWebviewMessage(
    { type: 'ready', protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION, viewGeneration },
    document as unknown as vscode.TextDocument,
    webview as unknown as vscode.Webview
  );
}

function postedOfType(webview: ReturnType<typeof createWebview>, type: string): HostMessage[] {
  return webview.postMessage.mock.calls
    .map(call => call[0] as HostMessage)
    .filter(message => message.type === type);
}

describe('document sync and save recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
      get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
    }));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Y1: renderer base version tracking', () => {
    it('delivers a save participant change made right after a rich-editor edit', async () => {
      const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
      const internal = provider as unknown as ProviderInternals;
      const doc = createMutableDocument('Line one\n', 4, 'file://save-participant.md');
      const webview = createWebview();
      (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
        const replaces = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces;
        doc.setText(replaces?.[0]?.text ?? doc.getText());
        return true;
      });
      sendReady(internal, doc.document, webview, 'participant-view');

      internal.handleWebviewMessage(
        {
          type: 'edit',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          editId: 'participant-view:1:1',
          viewGeneration: 'participant-view',
          localRevision: 1,
          baseDocumentVersion: 4,
          content: 'Line one  \nLine two',
          editReason: 'save-policy-enforce',
        },
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      await settle();
      expect(doc.document.version).toBe(5);
      // The change event for the renderer's own edit is an echo.
      internal.updateWebview(
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      webview.postMessage.mockClear();

      // A save participant (trimTrailingWhitespace, markdownlint fixAll,
      // formatOnSave) rewrites the buffer well inside the old 100 ms window.
      doc.setText('Line one\nLine two\n');
      internal.updateWebview(
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );

      expect(webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'update',
          content: 'Line one\nLine two\n',
          documentVersion: 6,
        })
      );
    });

    it('sends a version-only update for the echo of a rich-editor edit', async () => {
      const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
      const internal = provider as unknown as ProviderInternals;
      const doc = createMutableDocument('Before\n', 2, 'file://echo-version.md');
      const webview = createWebview();
      (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
        const replaces = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces;
        doc.setText(replaces?.[0]?.text ?? doc.getText());
        return true;
      });
      sendReady(internal, doc.document, webview, 'echo-view');

      internal.handleWebviewMessage(
        {
          type: 'edit',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          editId: 'echo-view:1:1',
          viewGeneration: 'echo-view',
          localRevision: 1,
          baseDocumentVersion: 2,
          content: 'After',
          editReason: 'typing',
        },
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      await settle();
      webview.postMessage.mockClear();
      internal.updateWebview(
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );

      expect(postedOfType(webview, 'update')).toHaveLength(0);
      expect(webview.postMessage).toHaveBeenCalledWith({
        type: 'document.version',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        documentVersion: 3,
      });
    });

    it('sends a version-only update for the echo of an edit to a CRLF file in preserve mode', async () => {
      (workspace.getConfiguration as jest.Mock).mockImplementation(() => ({
        get: jest.fn((key: string, defaultValue?: unknown) =>
          key === 'markdownForHumans.blankLines.mode' ? 'preserve' : defaultValue
        ),
      }));
      const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
      const internal = provider as unknown as ProviderInternals;
      const doc = createMutableDocument('Start\r\n', 2, 'file://crlf-preserve.md');
      const webview = createWebview();
      // VS Code stores inserted text with the document's EOL.
      (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
        const replaces = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces;
        doc.setText((replaces?.[0]?.text ?? doc.getText()).replace(/\r?\n/g, '\r\n'));
        return true;
      });
      sendReady(internal, doc.document, webview, 'crlf-view');
      await settle();

      internal.handleWebviewMessage(
        {
          type: 'edit',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          editId: 'crlf-view:1:1',
          viewGeneration: 'crlf-view',
          localRevision: 1,
          baseDocumentVersion: 2,
          content: 'Start\n\nTyped paragraph',
          editReason: 'typing',
        },
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      await settle();
      expect(doc.getText()).toBe('Start\r\n\r\nTyped paragraph\r\n');
      webview.postMessage.mockClear();
      internal.updateWebview(
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );

      // A full update would make the renderer defer and replay its own typing.
      expect(postedOfType(webview, 'update')).toHaveLength(0);
      expect(webview.postMessage).toHaveBeenCalledWith({
        type: 'document.version',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        documentVersion: 3,
      });
    });

    it.each([
      ['after the intermediate update was delivered', true],
      ['while the intermediate update is still in flight', false],
    ])(
      'resends reverted content to a split that was shown a newer version, %s',
      async (_description, deliverIntermediate) => {
        const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
        const internal = provider as unknown as ProviderInternals;
        const doc = createMutableDocument('Start\n', 4, 'file://revert-after-update.md');
        const webview = createWebview();
        (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
          const replaces = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces;
          doc.setText(replaces?.[0]?.text ?? doc.getText());
          return true;
        });
        sendReady(internal, doc.document, webview, 'revert-view');
        await settle();

        // A: the rich view's own typing is accepted, and its echo is version-only.
        internal.handleWebviewMessage(
          {
            type: 'edit',
            protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
            editId: 'revert-view:1:1',
            viewGeneration: 'revert-view',
            localRevision: 1,
            baseDocumentVersion: 4,
            content: 'Typed in rich view',
            editReason: 'typing',
          },
          doc.document as unknown as vscode.TextDocument,
          webview as unknown as vscode.Webview
        );
        await settle();
        internal.updateWebview(
          doc.document as unknown as vscode.TextDocument,
          webview as unknown as vscode.Webview
        );
        expect(doc.document.version).toBe(5);

        // B: an agent rewrites the file and the split is sent that content.
        if (!deliverIntermediate) {
          webview.postMessage.mockImplementationOnce(() => new Promise<boolean>(() => undefined));
        }
        doc.setText('Agent rewrite\n');
        internal.updateWebview(
          doc.document as unknown as vscode.TextDocument,
          webview as unknown as vscode.Webview
        );
        if (deliverIntermediate) await settle();
        webview.postMessage.mockClear();

        // A again: the agent change is undone. The split shows (or will show)
        // B, so a version-only update would let its next edit overwrite A.
        doc.setText('Typed in rich view\n');
        internal.updateWebview(
          doc.document as unknown as vscode.TextDocument,
          webview as unknown as vscode.Webview
        );

        expect(postedOfType(webview, 'document.version')).toHaveLength(0);
        expect(postedOfType(webview, 'update')).toEqual([
          expect.objectContaining({ content: 'Typed in rich view\n', documentVersion: 7 }),
        ]);
      }
    );

    it.each([
      ['only gains the trailing newline', 'document.version', 'Saved text'],
      ['has blank lines stripped by policy', 'update', 'Saved\n\n\n\ntext'],
    ])(
      'echoes a Ctrl+S save-policy edit that %s as %s',
      async (_description, expectedType, renderedMarkdown) => {
        const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
        const internal = provider as unknown as ProviderInternals;
        const doc = createMutableDocument('Before\n', 2, 'file://save-policy-echo.md');
        const webview = createWebview();
        (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
          const replaces = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces;
          doc.setText(replaces?.[0]?.text ?? doc.getText());
          return true;
        });
        sendReady(internal, doc.document, webview, 'policy-view');

        internal.handleWebviewMessage(
          {
            type: 'edit',
            protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
            editId: 'policy-view:1:1',
            viewGeneration: 'policy-view',
            localRevision: 1,
            baseDocumentVersion: 2,
            content: renderedMarkdown,
            editReason: 'save-policy-enforce',
          },
          doc.document as unknown as vscode.TextDocument,
          webview as unknown as vscode.Webview
        );
        await settle();
        webview.postMessage.mockClear();
        internal.updateWebview(
          doc.document as unknown as vscode.TextDocument,
          webview as unknown as vscode.Webview
        );

        // Without the old 100 ms echo skip, a trailing newline alone must not
        // make every Ctrl+S replace the rich editor's content.
        expect(webview.postMessage.mock.calls.map(call => call[0].type)).toEqual([expectedType]);
      }
    );

    it.each([
      ['', undefined],
      [' and leaves an external change during the save untagged', 'Agent text\n'],
    ])(
      'tags the update that carries a Ctrl+S edit with its save-policy result%s',
      async (_description, externalChangeDuringSave) => {
        const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
        const internal = provider as unknown as ProviderInternals;
        const doc = createMutableDocument('Before\n', 2, 'file://save-policy-tag.md');
        const webview = createWebview();
        const fireChange = () =>
          internal.updateWebview(
            doc.document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
          if (externalChangeDuringSave !== undefined) {
            doc.setText(externalChangeDuringSave);
            fireChange();
          }
          const replaces = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces;
          doc.setText(replaces?.[0]?.text ?? doc.getText());
          // VS Code fires onDidChangeTextDocument before applyEdit resolves.
          fireChange();
          return true;
        });
        sendReady(internal, doc.document, webview, 'tag-view');
        await settle();
        webview.postMessage.mockClear();

        internal.handleWebviewMessage(
          {
            type: 'edit',
            protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
            editId: 'tag-view:1:1',
            viewGeneration: 'tag-view',
            localRevision: 1,
            baseDocumentVersion: 2,
            content: 'Saved\n\n\n\ntext',
            editReason: 'save-policy-enforce',
          },
          doc.document as unknown as vscode.TextDocument,
          webview as unknown as vscode.Webview
        );
        await settle();

        // Only the policy result may replace the renderer's recent typing.
        expect(
          postedOfType(webview, 'update').map(update => [update.content, update.savePolicyEcho])
        ).toEqual([
          ...(externalChangeDuringSave !== undefined
            ? [[externalChangeDuringSave, undefined]]
            : []),
          ['Saved\n\ntext\n', true],
        ]);

        // A later rewrite, and its revert to the saved text, are not that echo.
        webview.postMessage.mockClear();
        doc.setText('Agent rewrite\n');
        fireChange();
        doc.setText('Saved\n\ntext\n');
        fireChange();
        expect(
          postedOfType(webview, 'update').map(update => [update.content, update.savePolicyEcho])
        ).toEqual([
          ['Agent rewrite\n', undefined],
          ['Saved\n\ntext\n', undefined],
        ]);
      }
    );

    it.each([
      [
        'a Ctrl+S edit the save-time policy left unchanged',
        'save-policy-enforce',
        'Saved text',
        'Saved text\n',
      ],
      [
        'a typing edit whose blank lines the strip policy removed',
        'typing',
        'Saved\n\n\n\ntext',
        'Saved\n\ntext\n',
      ],
    ])(
      'leaves the update carrying %s untagged',
      async (_description, editReason, renderedMarkdown, appliedContent) => {
        const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
        const internal = provider as unknown as ProviderInternals;
        const doc = createMutableDocument('Before\n', 2, 'file://save-policy-untagged.md');
        const webview = createWebview();
        const fireChange = () =>
          internal.updateWebview(
            doc.document as unknown as vscode.TextDocument,
            webview as unknown as vscode.Webview
          );
        (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
          // An external write during the edit leaves a delivery in flight, so
          // the edit's own change is sent as a full update, not version-only.
          doc.setText('Agent text\n');
          fireChange();
          const replaces = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces;
          doc.setText(replaces?.[0]?.text ?? doc.getText());
          fireChange();
          return true;
        });
        sendReady(internal, doc.document, webview, 'untagged-view');
        await settle();
        webview.postMessage.mockClear();

        internal.handleWebviewMessage(
          {
            type: 'edit',
            protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
            editId: 'untagged-view:1:1',
            viewGeneration: 'untagged-view',
            localRevision: 1,
            baseDocumentVersion: 2,
            content: renderedMarkdown,
            editReason,
          },
          doc.document as unknown as vscode.TextDocument,
          webview as unknown as vscode.Webview
        );
        await settle();

        // Only a Ctrl+S edit that the save-time policy changed may bypass the
        // renderer's typing guard; a tag here would let this update replace
        // typing made after the edit.
        expect(
          postedOfType(webview, 'update').map(update => [update.content, update.savePolicyEcho])
        ).toEqual([
          ['Agent text\n', undefined],
          [appliedContent, undefined],
        ]);
      }
    );

    it('sends a version-only update when a blank-line-only change keeps the strip view identical', async () => {
      const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
      const internal = provider as unknown as ProviderInternals;
      const doc = createMutableDocument('# Title\n\nBody\n', 3, 'file://strip-blank-lines.md');
      const webview = createWebview();
      (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
        const replaces = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces;
        doc.setText(replaces?.[0]?.text ?? doc.getText());
        return true;
      });
      sendReady(internal, doc.document, webview, 'strip-view');
      await settle();
      webview.postMessage.mockClear();

      // Default strip mode: the source split adds blank lines the rich view
      // never shows. The version still advances.
      doc.setText('# Title\n\n\n\nBody\n');
      internal.updateWebview(
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );

      expect(postedOfType(webview, 'update')).toHaveLength(0);
      expect(webview.postMessage).toHaveBeenCalledWith({
        type: 'document.version',
        protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
        documentVersion: 4,
      });

      // Typing based on the announced version is accepted, so nothing is lost.
      internal.handleWebviewMessage(
        {
          type: 'edit',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          editId: 'strip-view:1:1',
          viewGeneration: 'strip-view',
          localRevision: 1,
          baseDocumentVersion: 4,
          content: '# Title\n\nBody typed',
          editReason: 'typing',
        },
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      await settle();
      expect(postedOfType(webview, 'document.edit.ack')).toEqual([
        expect.objectContaining({ editId: 'strip-view:1:1', accepted: true }),
      ]);
      expect(doc.getText()).toBe('# Title\n\nBody typed\n');
    });

    it('sends a version-only update when a blank-line-only change matches an update still being delivered', async () => {
      const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
      const internal = provider as unknown as ProviderInternals;
      const doc = createMutableDocument('# Title\n\nBody\n', 3, 'file://strip-pending.md');
      const webview = createWebview();
      sendReady(internal, doc.document, webview, 'pending-view');
      await settle();

      // An external change is posted, and VS Code has not resolved its delivery yet.
      webview.postMessage.mockImplementationOnce(() => new Promise<boolean>(() => undefined));
      doc.setText('# Title\n\nAgent body\n');
      internal.updateWebview(
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      webview.postMessage.mockClear();

      // Default strip mode: a blank-line-only change keeps the in-flight content.
      doc.setText('# Title\n\n\n\nAgent body\n');
      internal.updateWebview(
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );

      expect(webview.postMessage.mock.calls.map(call => call[0])).toEqual([
        {
          type: 'document.version',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          documentVersion: 5,
        },
      ]);
    });

    it('offers the replaced file version after the renderer keeps typing over a concurrent change', async () => {
      const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
      const internal = provider as unknown as ProviderInternals;
      const doc = createMutableDocument('Agent wrote this.\n', 7, 'file://conflict.md');
      const webview = createWebview();
      const openTextDocument = jest.fn(async (options: unknown) => ({ options }));
      const showTextDocument = jest.fn(async () => undefined);
      Object.assign(workspace, { openTextDocument });
      Object.assign(window, { showTextDocument });
      (window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Open Replaced Version');
      sendReady(internal, doc.document, webview, 'conflict-view');

      internal.handleWebviewMessage(
        {
          type: 'document.sync.conflict',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          viewGeneration: 'other-view',
          documentVersion: 7,
        },
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      await settle();
      expect(window.showWarningMessage).not.toHaveBeenCalled();

      internal.handleWebviewMessage(
        {
          type: 'document.sync.conflict',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          viewGeneration: 'conflict-view',
          documentVersion: 7,
        },
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      // The renderer's own content replaces this version next; the notice must
      // keep the version it is about to replace.
      doc.setText('Typing kept by the rich editor.\n');
      await settle();

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('changed outside the rich editor'),
        'Open Replaced Version'
      );
      expect(openTextDocument).toHaveBeenCalledWith({
        language: 'markdown',
        content: 'Agent wrote this.\n',
      });
      expect(showTextDocument).toHaveBeenCalledTimes(1);
    });
  });

  describe('Y2: bounded renderer reconciliation', () => {
    it('shows an out-of-sync error with a reload action when the renderer stops reconciling', async () => {
      const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
      const internal = provider as unknown as ProviderInternals;
      const doc = createMutableDocument('# Stuck\n', 2, 'file://out-of-sync.md');
      const webview = createWebview();
      internal.getHtmlForWebview = jest.fn(() => '<html>reloaded</html>');
      (window.showErrorMessage as jest.Mock).mockResolvedValueOnce('Reload Editor');
      sendReady(internal, doc.document, webview, 'stuck-view');

      // A retired renderer generation cannot reload the current one.
      internal.handleWebviewMessage(
        {
          type: 'document.sync.failed',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          viewGeneration: 'other-view',
        },
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      await settle();
      expect(window.showErrorMessage).not.toHaveBeenCalled();

      internal.handleWebviewMessage(
        {
          type: 'document.sync.failed',
          protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
          viewGeneration: 'stuck-view',
        },
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      await settle();

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('out of sync'),
        'Reload Editor'
      );
      expect(webview.html).toBe('<html>reloaded</html>');
    });

    it("reloads the editor from the out-of-sync banner's Reload editor action", async () => {
      const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
      const internal = provider as unknown as ProviderInternals;
      const doc = createMutableDocument('# Stuck\n', 2, 'file://out-of-sync-banner.md');
      const webview = createWebview();
      internal.getHtmlForWebview = jest.fn(() => '<html>reloaded</html>');
      sendReady(internal, doc.document, webview, 'banner-view');
      const sendReload = (viewGeneration: string) =>
        internal.handleWebviewMessage(
          {
            type: 'document.sync.reload',
            protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
            viewGeneration,
          },
          doc.document as unknown as vscode.TextDocument,
          webview as unknown as vscode.Webview
        );

      // A retired renderer generation cannot reload the current one.
      sendReload('other-view');
      expect(webview.html).toBe('');

      sendReload('banner-view');
      expect(webview.html).toBe('<html>reloaded</html>');
    });
  });

  describe('Y3: explicit save never fails silently', () => {
    function createSaveHarness(flushResults: Array<boolean | 'never'>) {
      const provider = new MarkdownEditorProvider({} as unknown as vscode.ExtensionContext);
      const internal = provider as unknown as ProviderInternals;
      const doc = createMutableDocument('# Draft\n', 5, 'file://save-flush.md');
      const webview = createWebview();
      webview.postMessage.mockImplementation(async (message: HostMessage) => {
        if (message.type === 'flushPendingEdit') {
          const result = flushResults.shift() ?? true;
          if (result !== 'never') {
            queueMicrotask(() =>
              internal.handleWebviewMessage(
                {
                  type: 'flushPendingEditAck',
                  protocolVersion: DOCUMENT_SYNC_PROTOCOL_VERSION,
                  requestId: message.requestId,
                  viewGeneration: message.viewGeneration,
                  documentVersion: message.documentVersion,
                  ok: result,
                },
                doc.document as unknown as vscode.TextDocument,
                webview as unknown as vscode.Webview
              )
            );
          }
        }
        return true;
      });
      sendReady(internal, doc.document, webview, 'save-view');
      return { internal, doc, webview };
    }

    it('shows a retryable error when the renderer cannot flush, and retries the save', async () => {
      const { internal, doc, webview } = createSaveHarness([false, true]);
      (window.showErrorMessage as jest.Mock).mockResolvedValueOnce('Retry');

      internal.handleWebviewMessage(
        { type: 'save' },
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      await settle();

      expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
      expect(window.showErrorMessage).toHaveBeenCalledWith(expect.any(String), 'Retry');
      expect(postedOfType(webview, 'flushPendingEdit')).toHaveLength(2);
      expect(doc.document.save).toHaveBeenCalledTimes(1);
    });

    it('never saves stale document content when the error is dismissed', async () => {
      const { internal, doc, webview } = createSaveHarness([false]);
      (window.showErrorMessage as jest.Mock).mockResolvedValueOnce(undefined);

      internal.handleWebviewMessage(
        { type: 'save' },
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      await settle();

      expect(window.showErrorMessage).toHaveBeenCalledWith(expect.any(String), 'Retry');
      expect(doc.document.save).not.toHaveBeenCalled();
    });

    it('shows a retryable error when the renderer flush times out', async () => {
      jest.useFakeTimers();
      const { internal, doc, webview } = createSaveHarness(['never']);

      internal.handleWebviewMessage(
        { type: 'save' },
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      await jest.advanceTimersByTimeAsync(1_999);
      expect(window.showErrorMessage).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);

      expect(window.showErrorMessage).toHaveBeenCalledWith(expect.any(String), 'Retry');
      expect(doc.document.save).not.toHaveBeenCalled();
    });

    it('reports a VS Code save that throws', async () => {
      const { internal, doc, webview } = createSaveHarness([true]);
      doc.document.save.mockRejectedValueOnce(new Error('EACCES'));

      internal.handleWebviewMessage(
        { type: 'save' },
        doc.document as unknown as vscode.TextDocument,
        webview as unknown as vscode.Webview
      );
      await settle();

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'VS Code could not save this Markdown document.'
      );
    });
  });
});
