/**
 * JavaScript runtime floors for the extension's two execution environments.
 *
 * VS Code 1.98 embeds Node.js 20.18.2 in the extension host and Chromium 132
 * in webviews. Keep these targets aligned with package.json#engines.vscode.
 */
module.exports = Object.freeze({
  extension: 'node20',
  webview: 'chrome132',
});
