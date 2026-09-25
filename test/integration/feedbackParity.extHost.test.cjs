/**
 * Ext Host: Feedback start must accept TipTap mark-outside-link round-trips.
 * Reproduces the "rendered Markdown differs from the saved file" gate on a
 * fixture that mirrors the What Is Jev? blog failure mode.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const CUSTOM_EDITOR_VIEW_TYPE = 'markdownForHumans.editor';

async function waitFor(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

suite('Feedback snapshot parity (Ext Host)', () => {
  suiteSetup(async function () {
    this.timeout(60_000);
    const extension = vscode.extensions.getExtension('concretio.markdown-for-humans');
    assert.ok(extension, 'Expected concretio.markdown-for-humans');
    await extension.activate();
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('starts Feedback on a mark-inside-link + compact-table fixture', async function () {
    this.timeout(90_000);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'Expected integration fixture workspace');
    const fixtureUri = vscode.Uri.joinPath(workspaceFolder.uri, 'parity-mark-link.md');
    await vscode.workspace.fs.stat(fixtureUri);

    const feedbackRoot = path.join(workspaceFolder.uri.fsPath, '.md4h', 'feedback');
    fs.rmSync(feedbackRoot, { recursive: true, force: true });

    const errors = [];
    const warnings = [];
    const originalError = vscode.window.showErrorMessage;
    const originalWarning = vscode.window.showWarningMessage;
    vscode.window.showErrorMessage = async (message, ...items) => {
      errors.push(String(message));
      return originalError.call(vscode.window, message, ...items);
    };
    vscode.window.showWarningMessage = async (message, ...items) => {
      warnings.push(String(message));
      return originalWarning.call(vscode.window, message, ...items);
    };

    try {
      await vscode.commands.executeCommand('vscode.openWith', fixtureUri, CUSTOM_EDITOR_VIEW_TYPE, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });

      await waitFor(() => {
        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        return activeTab?.input instanceof vscode.TabInputCustom &&
          activeTab.input.viewType === CUSTOM_EDITOR_VIEW_TYPE
          ? activeTab
          : undefined;
      }, 'custom editor tab');

      // Allow the rich editor webview to finish initializing and mark snapshot capability.
      await new Promise(resolve => setTimeout(resolve, 2500));

      await vscode.commands.executeCommand('markdownForHumans.feedback.start');

      const draftDir = await waitFor(() => {
        if (!fs.existsSync(feedbackRoot)) return undefined;
        const entries = fs.readdirSync(feedbackRoot);
        return entries.length > 0 ? path.join(feedbackRoot, entries[0]) : undefined;
      }, 'Feedback draft under .md4h/feedback');

      assert.ok(fs.existsSync(draftDir), 'Expected a Feedback draft directory');
      assert.equal(
        errors.some(message => message.includes('rendered Markdown differs from the saved file')),
        false,
        `Feedback start raised parity error: ${errors.join(' | ') || '(none)'}`
      );
      assert.equal(
        errors.length,
        0,
        `Unexpected Feedback errors: ${errors.join(' | ') || '(none)'}`
      );
    } finally {
      vscode.window.showErrorMessage = originalError;
      vscode.window.showWarningMessage = originalWarning;
      fs.rmSync(feedbackRoot, { recursive: true, force: true });
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
