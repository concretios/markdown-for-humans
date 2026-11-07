/**
 * Global setup: install VS Code's webview runtime before any suite runs.
 *
 * Each run starts from a fresh profile, so the first rich editor also installs
 * the service worker that every VS Code webview boots through. On VS Code 1.98
 * a webview that starts loading while that worker is still activating can miss
 * its `controllerchange` event. Its bootstrap page then waits forever, the
 * editor script never runs, and only recreating the webview recovers it. The
 * suites open and close editors within milliseconds of each other, which hit
 * that window in about one cold run in five and surfaced as a Feedback command
 * that never became ready.
 *
 * A real profile installs the worker once, with its first editor. Reproduce
 * that here: open one editor and keep it open until its renderer has answered.
 * Later webviews are controlled by the installed worker from their first load.
 */
const assert = require('node:assert/strict');
const vscode = require('vscode');

const EXTENSION_ID = 'concretio.markdown-for-humans';
const CUSTOM_EDITOR_VIEW_TYPE = 'markdownForHumans.editor';

async function waitFor(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function mochaGlobalSetup() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Expected ${EXTENSION_ID} to be installed as the development extension`);
  await extension.activate();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, 'Expected the integration fixture workspace to be open');
  const smokeUri = vscode.Uri.joinPath(workspaceFolder.uri, 'smoke.md');

  try {
    await vscode.commands.executeCommand('vscode.openWith', smokeUri, CUSTOM_EDITOR_VIEW_TYPE, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
    await waitFor(() => {
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return (
        activeTab?.input instanceof vscode.TabInputCustom &&
        activeTab.input.viewType === CUSTOM_EDITOR_VIEW_TYPE
      );
    }, 'the first rich editor tab');
    // Feedback commands resolve true only after the renderer's controller-ready
    // signal. Reveal does nothing without a session, so it reads readiness
    // without creating a draft.
    assert.equal(
      await vscode.commands.executeCommand('markdownForHumans.feedback.reveal'),
      true,
      'The first rich editor of a fresh profile must finish loading'
    );
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}

module.exports = { mochaGlobalSetup };
