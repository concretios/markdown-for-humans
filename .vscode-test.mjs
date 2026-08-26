/**
 * Desktop Extension Development Host smoke-test configuration.
 *
 * CI supplies either the declared minimum VS Code version or `stable`. Local
 * runs use stable by default, matching the official VS Code test CLI behavior.
 */

import { defineConfig } from '@vscode/test-cli';

const vscodeVersion = process.env.VSCODE_TEST_VERSION ?? 'stable';

export default defineConfig({
  label: `desktop-${vscodeVersion}`,
  files: 'test/integration/**/*.test.cjs',
  version: vscodeVersion,
  extensionDevelopmentPath: '.',
  workspaceFolder: './test/integration/workspace',
  launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  mocha: {
    ui: 'tdd',
    timeout: 60_000,
  },
});
