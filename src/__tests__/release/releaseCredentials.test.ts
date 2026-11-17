/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Release credentials guard. `scripts/release-publish.sh` is the only way the
 * release checklist publishes, so an agent never has to remember which store
 * uses which credential. These tests run it against stub `az`, `security`,
 * `npx` and `unzip` commands and check that it refuses a wrong sign-in, a
 * stored Marketplace PAT or a stale vsix, and never prints the Open VSX token.
 */

import { spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { repoRoot } from '../l10n/extraction';

const SCRIPT = path.join(repoRoot, 'scripts', 'release-publish.sh');
const SECRET = 'SECRET-OVSX-TOKEN-0123456789';
const TENANT = '9620b1de-bb79-421a-9a24-2d5e7a184d10';
const VERSION = (
  JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

const STUBS: Record<string, string> = {
  az: `#!/bin/bash
echo "az $*" >> "$STUB_LOG"
case "$*" in
  *"account show"*) echo "$STUB_TENANT" ;;
  *"get-access-token"*) echo "2026-12-31 00:00:00.000000" ;;
esac`,
  security: `#!/bin/bash
echo "security $*" >> "$STUB_LOG"
[ -n "$STUB_KEYCHAIN_MISSING" ] && exit 44
echo "${SECRET}"`,
  unzip: `#!/bin/bash
echo "{\\"version\\":\\"$STUB_VSIX_VERSION\\"}"`,
  npx: `#!/bin/bash
echo "npx $* OVSX_PAT=\${OVSX_PAT:+set}" >> "$STUB_LOG"
case "$*" in
  "vsce ls-publishers") echo "$STUB_VSCE_PUBLISHERS" ;;
  "ovsx verify-pat concretio") [ "$OVSX_PAT" = "${SECRET}" ] && echo "PAT valid to publish at concretio" ;;
esac`,
};

interface Run {
  status: number | null;
  output: string;
  log: string;
}

describe('release-publish.sh', () => {
  let dir: string;
  let vsix: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'md4h-release-'));
    for (const [name, body] of Object.entries(STUBS)) {
      const file = path.join(dir, name);
      writeFileSync(file, body);
      chmodSync(file, 0o755);
    }
    vsix = path.join(dir, `markdown-for-humans-${VERSION}.vsix`);
    writeFileSync(vsix, 'stub vsix');
    writeFileSync(path.join(dir, 'log'), '');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[], env: Record<string, string> = {}): Run => {
    const result = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: dir,
        USER: 'tester',
        STUB_LOG: path.join(dir, 'log'),
        STUB_TENANT: TENANT,
        STUB_VSCE_PUBLISHERS: '',
        STUB_VSIX_VERSION: VERSION,
        ...env,
      },
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      log: readFileSync(path.join(dir, 'log'), 'utf8'),
    };
  };

  test('check passes when both credentials are ready, without printing the token', () => {
    const { status, output } = run(['check']);
    expect(output).not.toContain(SECRET);
    expect(status).toBe(0);
    expect(output).toContain('Marketplace');
    expect(output).toContain('Open VSX');
  });

  test('check refuses an az sign-in to another tenant', () => {
    const { status, output } = run(['check'], { STUB_TENANT: 'some-other-tenant' });
    expect(status).not.toBe(0);
    expect(output).toContain('az login --tenant concret.io --allow-no-subscriptions');
  });

  test('check refuses a Marketplace PAT stored by vsce login', () => {
    const { status, output } = run(['check'], { STUB_VSCE_PUBLISHERS: 'concretio' });
    expect(status).not.toBe(0);
    expect(output).toContain('npx vsce logout concretio');
  });

  test('check refuses when the Open VSX token is not in the Keychain', () => {
    const { status, output } = run(['check'], { STUB_KEYCHAIN_MISSING: '1' });
    expect(status).not.toBe(0);
    expect(output).toContain('security add-generic-password -a "$USER" -s ovsx-pat-concretio -w');
  });

  test('marketplace publishes with Entra only, never a PAT', () => {
    const { status, output, log } = run(['marketplace', vsix]);
    expect(status).toBe(0);
    expect(output).not.toContain(SECRET);
    expect(log).toContain(`npx vsce publish --azure-credential --packagePath ${vsix} OVSX_PAT=`);
    expect(log).not.toMatch(/vsce publish (?!--azure-credential)/);
    expect(log).not.toContain('ovsx-pat-concretio');
  });

  test('openvsx publishes with the Keychain token and never prints it', () => {
    const { status, output, log } = run(['openvsx', vsix]);
    expect(status).toBe(0);
    expect(output).not.toContain(SECRET);
    expect(log).not.toContain(SECRET);
    expect(log).toContain(`npx ovsx publish ${vsix} OVSX_PAT=set`);
  });

  test('refuses a vsix whose version is not the repo version', () => {
    const marketplace = run(['marketplace', vsix], { STUB_VSIX_VERSION: '0.0.1' });
    const openvsx = run(['openvsx', vsix], { STUB_VSIX_VERSION: '0.0.1' });
    for (const { status, log } of [marketplace, openvsx]) {
      expect(status).not.toBe(0);
      expect(log).not.toContain('publish');
    }
  });

  test('prints usage for an unknown command', () => {
    const { status, output } = run(['publish-everything']);
    expect(status).toBe(2);
    expect(output).toContain('Usage');
  });
});
