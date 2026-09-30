/**
 * Extension Development Host harness policy tests.
 *
 * These fast checks keep the real VS Code smoke-test boundary wired into the
 * package and both supported CI operating-system families.
 */

import fs from 'fs';
import path from 'path';

const rootDir = path.resolve(__dirname, '../../..');

interface PackageManifest {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')
) as PackageManifest;

describe('Extension Development Host harness policy', () => {
  test('pins the official desktop test runner and exposes one build-and-run command', () => {
    expect(manifest.devDependencies?.['@vscode/test-cli']).toBe('0.0.15');
    expect(manifest.devDependencies?.['@vscode/test-electron']).toBe('3.1.0');
    expect(manifest.scripts?.['test:integration']).toBe('npm run build:release && vscode-test');
  });

  test('targets the minimum API floor or stable from one deterministic config', () => {
    const config = fs.readFileSync(path.join(rootDir, '.vscode-test.mjs'), 'utf8');

    expect(config).toContain("process.env.VSCODE_TEST_VERSION ?? 'stable'");
    expect(config).toContain("files: 'test/integration/**/*.test.cjs'");
    expect(config).toContain("workspaceFolder: './test/integration/workspace'");
    expect(config).toContain("'--disable-extensions'");
    expect(config).toContain("'--disable-workspace-trust'");
  });

  test('runs the real host suite on Ubuntu and Windows at minimum and stable', () => {
    const workflow = fs.readFileSync(path.join(rootDir, '.github/workflows/ci.yml'), 'utf8');

    expect(workflow).toContain('extension-host:');
    expect(workflow).toContain('os: [ubuntu-latest, windows-latest]');
    expect(workflow).toContain("vscode-version: ['1.98.0', stable]");
    expect(workflow).toContain('VSCODE_TEST_VERSION: ${{ matrix.vscode-version }}');
    expect(workflow).toContain('xvfb-run -a npm run test:integration');
  });

  test('contains activation, command, and custom-editor assertions', () => {
    const suite = fs.readFileSync(
      path.join(rootDir, 'test/integration/extensionHost.test.cjs'),
      'utf8'
    );

    expect(suite).toContain("vscode.extensions.getExtension('concretio.markdown-for-humans')");
    expect(suite).toContain("commands.includes('markdownForHumans.openFile')");
    expect(suite).toContain('tab.input instanceof vscode.TabInputCustom');
    expect(suite).toContain("activeTab.input.viewType === 'markdownForHumans.editor'");
    expect(suite).toContain('vscode.ViewColumn.Beside');
    expect(suite).toContain('vscode.window.tabGroups.close(splitTabs[0])');
    expect(suite).toContain('await vscode.workspace.applyEdit(edit)');
  });

  test('advertises the split-view capability exercised by the real host suite', () => {
    const providerSource = fs.readFileSync(
      path.join(rootDir, 'src/editor/MarkdownEditorProvider.ts'),
      'utf8'
    );

    expect(providerSource).toContain('supportsMultipleEditorsPerDocument: true');
    expect(providerSource).not.toContain('supportsMultipleEditorsPerDocument: false');
  });

  test('keeps the harness, downloaded hosts, and nested build artifacts outside the VSIX', () => {
    const ignoreRules = fs.readFileSync(path.join(rootDir, '.vscodeignore'), 'utf8');

    expect(ignoreRules).toMatch(/^test\/\*\*$/m);
    expect(ignoreRules).toMatch(/^\.vscode-test\.\*$/m);
    expect(ignoreRules).toMatch(/^dist\/\*\*\/\*\.map$/m);
    expect(ignoreRules).toMatch(/^\*\.vsix$/m);
    expect(ignoreRules).not.toMatch(/^!dist\/\*\*$/m);
  });
});
