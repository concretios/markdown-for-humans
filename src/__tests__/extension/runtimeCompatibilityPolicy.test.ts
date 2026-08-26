/**
 * Runtime compatibility policy tests.
 *
 * Keep the manifest, compile-time API surface, and emitted JavaScript aligned
 * with the oldest VS Code runtime that the extension claims to support.
 */

import fs from 'fs';
import path from 'path';

const rootDir = path.resolve(__dirname, '../../..');

interface PackageManifest {
  engines?: Record<string, string>;
  devDependencies?: Record<string, string>;
  extensionKind?: string[];
  capabilities?: {
    virtualWorkspaces?: { supported?: boolean | 'limited'; description?: string };
    untrustedWorkspaces?: { supported?: boolean | 'limited'; description?: string };
  };
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')
) as PackageManifest;

describe('extension runtime compatibility policy', () => {
  test('declares VS Code 1.98 as the runtime floor without a misleading Node engine', () => {
    expect(manifest.engines?.vscode).toBe('^1.98.0');
    expect(manifest.engines).not.toHaveProperty('node');
  });

  test('pins API and Node types to the oldest supported extension host', () => {
    expect(manifest.devDependencies?.['@types/vscode']).toBe('1.98.0');
    // DefinitelyTyped does not publish a 20.18.x line. Pin the newest 20.17
    // declaration set so compile-time APIs do not exceed VS Code's Node 20.18 host.
    expect(manifest.devDependencies?.['@types/node']).toBe('20.17.58');
  });

  test('runs with the workspace host and declares unsupported workspace modes explicitly', () => {
    expect(manifest.extensionKind).toEqual(['workspace']);
    expect(manifest.capabilities?.virtualWorkspaces?.supported).toBe(false);
    expect(manifest.capabilities?.virtualWorkspaces?.description).toEqual(expect.any(String));
    expect(manifest.capabilities?.untrustedWorkspaces?.supported).toBe(false);
    expect(manifest.capabilities?.untrustedWorkspaces?.description).toEqual(expect.any(String));
  });

  test('uses explicit esbuild targets for the extension host and webview', () => {
    const runtimeTargets = jest.requireActual<{
      extension: string;
      webview: string;
    }>(path.join(rootDir, 'scripts/runtime-targets'));

    expect(runtimeTargets).toEqual({
      extension: 'node20',
      webview: 'chrome132',
    });

    const extensionBuild = fs.readFileSync(
      path.join(rootDir, 'scripts/build-extension.js'),
      'utf8'
    );
    const webviewBuild = fs.readFileSync(path.join(rootDir, 'scripts/build-webview.js'), 'utf8');

    expect(extensionBuild).toContain("const runtimeTargets = require('./runtime-targets');");
    expect(extensionBuild).toContain('target: runtimeTargets.extension');
    expect(webviewBuild).toContain("const runtimeTargets = require('./runtime-targets');");
    expect(webviewBuild).toContain('target: runtimeTargets.webview');
  });
});
