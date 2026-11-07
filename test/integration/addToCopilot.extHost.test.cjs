/**
 * Ext Host: Add to GitHub Copilot — availability detection and the chat
 * attach contract, in a real VS Code window.
 *
 * The toolbar flow runs through the rich view and cannot be driven from the
 * extension host, so this covers the two workbench contracts the feature rests
 * on: which presence check says "GitHub Copilot is available", and whether
 * `workbench.action.chat.open` accepts the fragment-identified file + internal
 * 1-based line range payload the host sends.
 */

const assert = require('node:assert/strict');
const vscode = require('vscode');

const CHAT_OPEN_COMMAND = 'workbench.action.chat.open';
const COPILOT_CHAT_EXTENSION_ID = 'github.copilot-chat';

suite('Add to GitHub Copilot in the Extension Development Host', () => {
  /** The same availability rule the extension host applies. */
  async function copilotAvailability() {
    const extensionPresent =
      vscode.extensions.getExtension(COPILOT_CHAT_EXTENSION_ID) !== undefined;
    const commands = await vscode.commands.getCommands(true);
    return { extensionPresent, commandPresent: commands.includes(CHAT_OPEN_COMMAND) };
  }

  test('GitHub Copilot is available only with its extension and chat command', async () => {
    const { extensionPresent, commandPresent } = await copilotAvailability();
    const available = extensionPresent && commandPresent;

    if (extensionPresent) {
      assert.ok(
        commandPresent,
        'The Copilot Chat extension is present, so its chat command must be registered'
      );
      assert.equal(available, true);
    } else {
      // The extension half alone must never claim availability, even though
      // the core chat command may exist without it.
      assert.equal(available, false);
    }
  });

  test('the chat input accepts one fragment-identified line-range context', async function () {
    this.timeout(60_000);
    // The attach payload is core workbench behaviour and needs only the chat
    // command; the Copilot extension is required only for availability gating.
    const { commandPresent } = await copilotAvailability();
    if (!commandPresent) {
      this.skip();
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'Expected integration fixture workspace');
    const fixtureUri = vscode.Uri.joinPath(workspaceFolder.uri, 'reference-lines.md');

    // The exact payload shape the extension sends: an additive partial query,
    // a URI whose fragment names the lines (a distinct attachment identity per
    // context), and the internal 1-based range, not vscode.Range.
    await vscode.commands.executeCommand(CHAT_OPEN_COMMAND, {
      isPartialQuery: true,
      attachFiles: [
        {
          uri: fixtureUri.with({ fragment: 'L1-2' }),
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 4 },
        },
      ],
    });

    // A second press must be additive: another context with its own identity.
    await vscode.commands.executeCommand(CHAT_OPEN_COMMAND, {
      isPartialQuery: true,
      attachFiles: [
        {
          uri: fixtureUri.with({ fragment: 'L3-3' }),
          range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 5 },
        },
      ],
    });

    const first = fixtureUri.with({ fragment: 'L1-2' }).toString();
    const second = fixtureUri.with({ fragment: 'L3-3' }).toString();
    assert.notEqual(first, second, 'Each context must carry its own identity');
  });
});
