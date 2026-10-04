/**
 * Desktop Extension Development Host smoke-test configuration.
 *
 * CI supplies either the declared minimum VS Code version or `stable`. Local
 * runs use stable by default, matching the official VS Code test CLI behavior.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

const vscodeVersion = process.env.VSCODE_TEST_VERSION ?? 'stable';

// Fresh profile per run. A reused profile restores windows that earlier runs
// opened (untitled multi-root workspaces), and every restored window runs the
// whole suite in its own extension host, racing on the shared workspace.
const userDataDir = mkdtempSync(join(tmpdir(), 'md4h-vt-'));
process.on('exit', () => rmSync(userDataDir, { recursive: true, force: true }));

export default defineConfig({
  label: `desktop-${vscodeVersion}`,
  files: 'test/integration/**/*.test.cjs',
  version: vscodeVersion,
  extensionDevelopmentPath: '.',
  workspaceFolder: './test/integration/workspace',
  launchArgs: [
    '--disable-extensions',
    '--disable-workspace-trust',
    `--user-data-dir=${userDataDir}`,
  ],
  mocha: {
    ui: 'tdd',
    timeout: 60_000,
  },
});
