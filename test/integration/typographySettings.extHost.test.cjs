/**
 * Real VS Code checks for the reader typography settings.
 *
 * Jest covers how the settings are resolved and applied. This boundary proves
 * what only a real host can: the manifest contributes the settings with
 * defaults that change nothing, and a `"[markdown]"` override of `editor.*`
 * reaches the extension through a language-scoped configuration read (it never
 * reaches the webview's `--vscode-editor-font-*` CSS variables).
 *
 * The override lives in the fixture workspace's `.vscode/settings.json`, so the
 * suite only reads configuration and leaves the host's settings as it found
 * them for the suites that follow.
 */

const assert = require('node:assert/strict');
const vscode = require('vscode');

const MARKDOWN_SCOPE = { languageId: 'markdown' };
const PROBE_FONT = 'MD4H Integration Probe';

suite('Reader typography settings in the Extension Development Host', () => {
  test('contributes the font settings with defaults that change nothing', () => {
    const config = vscode.workspace.getConfiguration('markdownForHumans.font');

    assert.deepEqual(
      Object.fromEntries(
        ['family', 'weight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'useEditorFont'].map(
          name => [name, config.inspect(name)?.defaultValue]
        )
      ),
      {
        family: '',
        weight: 400,
        lineHeight: 1.58,
        letterSpacing: 0,
        wordSpacing: 0,
        useEditorFont: false,
      }
    );
    assert.equal(config.get('family'), '');
    assert.equal(config.get('useEditorFont'), false);
  });

  test('reads a "[markdown]" editor font override only through the language scope', () => {
    // What the provider reads when `markdownForHumans.font.useEditorFont` is on.
    assert.equal(
      vscode.workspace.getConfiguration('editor', MARKDOWN_SCOPE).get('fontFamily'),
      PROBE_FONT
    );
    // An unscoped read, which is what webview CSS variables are built from,
    // does not see the language override.
    assert.notEqual(vscode.workspace.getConfiguration('editor').get('fontFamily'), PROBE_FONT);
  });
});
