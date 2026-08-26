/**
 * Real VS Code Extension Development Host smoke tests.
 *
 * Keep this suite narrow. Unit tests cover feature behavior; this boundary
 * proves the shipped bundle can activate and register its desktop custom editor.
 */

const assert = require('node:assert/strict');
const vscode = require('vscode');

const EXTENSION_ID = 'concretio.markdown-for-humans';
const CUSTOM_EDITOR_VIEW_TYPE = 'markdownForHumans.editor';

async function waitFor(predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function getCustomEditorTabs(resource) {
  return vscode.window.tabGroups.all
    .flatMap(group => group.tabs)
    .filter(
      tab =>
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === CUSTOM_EDITOR_VIEW_TYPE &&
        tab.input.uri.toString() === resource.toString()
    );
}

async function replaceDocumentText(document, content) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
    content
  );
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  assert.equal(await document.save(), true);
}

suite('Markdown for Humans Extension Development Host', () => {
  let extension;

  suiteSetup(async function () {
    this.timeout(60_000);
    extension = vscode.extensions.getExtension('concretio.markdown-for-humans');
    assert.ok(extension, `Expected ${EXTENSION_ID} to be installed as the development extension`);
    await extension.activate();
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('activates the bundled extension and registers its open command', async () => {
    assert.equal(extension.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    assert.equal(commands.includes('markdownForHumans.openFile'), true);
  });

  test('opens a Markdown fixture through the registered custom text editor', async function () {
    this.timeout(60_000);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'Expected the integration fixture workspace to be open');

    const smokeUri = vscode.Uri.joinPath(workspaceFolder.uri, 'smoke.md');
    await vscode.workspace.fs.stat(smokeUri);
    await vscode.commands.executeCommand('vscode.openWith', smokeUri, CUSTOM_EDITOR_VIEW_TYPE);

    const tab = await waitFor(() => {
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return activeTab?.input instanceof vscode.TabInputCustom &&
        activeTab.input.viewType === 'markdownForHumans.editor'
        ? activeTab
        : undefined;
    }, `${CUSTOM_EDITOR_VIEW_TYPE} to become the active custom editor`);

    assert.ok(tab.input instanceof vscode.TabInputCustom);
    assert.equal(tab.input.viewType, CUSTOM_EDITOR_VIEW_TYPE);
    assert.equal(tab.input.uri.toString(), smokeUri.toString());
  });

  test('keeps a shared document alive when one split closes, saves, and reopens', async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'Expected the integration fixture workspace to be open');
    const smokeUri = vscode.Uri.joinPath(workspaceFolder.uri, 'smoke.md');
    const originalContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(smokeUri));
    const persistedMarker = '\n\nExtension Host workspace edit persisted.\n';

    try {
      await vscode.commands.executeCommand('vscode.openWith', smokeUri, CUSTOM_EDITOR_VIEW_TYPE, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      await waitFor(
        () =>
          getCustomEditorTabs(smokeUri).length === 1 ? getCustomEditorTabs(smokeUri) : undefined,
        'the first custom editor tab'
      );

      await vscode.commands.executeCommand('vscode.openWith', smokeUri, CUSTOM_EDITOR_VIEW_TYPE, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
        preview: false,
      });
      const splitTabs = await waitFor(
        () =>
          getCustomEditorTabs(smokeUri).length === 2 ? getCustomEditorTabs(smokeUri) : undefined,
        'two custom editor tabs for one resource'
      );
      assert.equal(new Set(splitTabs.map(tab => tab.group.viewColumn)).size, 2);

      assert.equal(await vscode.window.tabGroups.close(splitTabs[0]), true);
      const survivingTab = await waitFor(
        () =>
          getCustomEditorTabs(smokeUri).length === 1 ? getCustomEditorTabs(smokeUri)[0] : undefined,
        'one surviving custom editor tab'
      );
      assert.equal(survivingTab.input.uri.toString(), smokeUri.toString());

      const sharedDocument = await vscode.workspace.openTextDocument(smokeUri);
      assert.equal(sharedDocument.isClosed, false);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(
        sharedDocument.uri,
        sharedDocument.positionAt(sharedDocument.getText().length),
        persistedMarker
      );
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.equal(sharedDocument.getText().endsWith(persistedMarker), true);
      assert.equal(await sharedDocument.save(), true);

      const savedContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(smokeUri));
      assert.equal(savedContent.endsWith(persistedMarker), true);

      assert.equal(await vscode.window.tabGroups.close(survivingTab), true);
      await waitFor(
        () => (getCustomEditorTabs(smokeUri).length === 0 ? true : undefined),
        'all custom editor tabs to close'
      );
      await vscode.commands.executeCommand('vscode.openWith', smokeUri, CUSTOM_EDITOR_VIEW_TYPE, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
      await waitFor(
        () => (getCustomEditorTabs(smokeUri).length === 1 ? true : undefined),
        'the saved document to reopen in the custom editor'
      );
      const reopenedDocument = await vscode.workspace.openTextDocument(smokeUri);
      assert.equal(reopenedDocument.getText().endsWith(persistedMarker), true);
    } finally {
      const documentToRestore = await vscode.workspace.openTextDocument(smokeUri);
      await replaceDocumentText(documentToRestore, originalContent);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
