#!/usr/bin/env node
/**
 * Regenerates l10n/bundle.l10n.json and the hardcoded-text baseline from the
 * source by running the l10n guard tests in write mode.
 *
 * Jest runs as a child process: calling jest.run() in-process does not exit.
 */
const { spawnSync } = require('child_process');

const result = spawnSync(
  process.execPath,
  [require.resolve('jest/bin/jest'), 'src/__tests__/l10n'],
  { stdio: 'inherit', env: { ...process.env, L10N_WRITE: '1' } }
);
process.exit(result.status ?? 1);
