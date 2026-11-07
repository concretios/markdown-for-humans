/**
 * Ext Host: Copy Reference for AI end to end in a real VS Code window.
 * The command asks the rich view for its selection, the host reads the line
 * from the saved file, and the reference lands on the clipboard.
 */

const assert = require('node:assert/strict');
const vscode = require('vscode');

const CUSTOM_EDITOR_VIEW_TYPE = 'markdownForHumans.editor';
const COMMAND = 'markdownForHumans.copyReferenceForAi';

suite('Copy Reference for AI in the Extension Development Host', () => {
  let originalClipboard = '';

  suiteSetup(async () => {
    originalClipboard = await vscode.env.clipboard.readText();
  });

  suiteTeardown(async () => {
    await vscode.env.clipboard.writeText(originalClipboard);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('registers the command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes(COMMAND));
  });

  /**
   * Put the caret at a document position through the outline's own command,
   * run the copy, and wait for the expected reference. The rich view may still
   * be loading or applying a host update, so ask again until it answers.
   */
  async function copyAt(position, expected) {
    let copied = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && copied !== expected) {
      await vscode.env.clipboard.writeText('');
      await vscode.commands.executeCommand('markdownForHumans.navigateToHeading', position);
      await vscode.commands.executeCommand(COMMAND);
      await new Promise(resolve => setTimeout(resolve, 500));
      copied = await vscode.env.clipboard.readText();
    }
    return copied;
  }

  test('copies the workspace-relative path and the caret line of the saved file', async function () {
    this.timeout(120_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'Expected integration fixture workspace');
    const fixtureUri = vscode.Uri.joinPath(workspaceFolder.uri, 'reference-lines.md');
    const document = await vscode.workspace.openTextDocument(fixtureUri);
    const original = document.getText();
    await vscode.commands.executeCommand('vscode.openWith', fixtureUri, CUSTOM_EDITOR_VIEW_TYPE, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });

    try {
      // Position 1 is inside the first block: a heading that two leading blank
      // lines put on line 3 of the file.
      assert.equal(await copyAt(1, '@reference-lines.md#L3'), '@reference-lines.md#L3');

      // Unsaved changes are saved first, and the line is read from the saved text.
      const edit = new vscode.WorkspaceEdit();
      edit.insert(fixtureUri, new vscode.Position(0, 0), 'Inserted first line\n');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.equal(document.isDirty, true);

      assert.equal(await copyAt(1, '@reference-lines.md#L1'), '@reference-lines.md#L1');
      assert.equal(document.isDirty, false);
    } finally {
      const restore = new vscode.WorkspaceEdit();
      restore.replace(
        fixtureUri,
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        original
      );
      await vscode.workspace.applyEdit(restore);
      await document.save();
    }
  });
});
