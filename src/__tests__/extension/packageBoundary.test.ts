/**
 * @jest-environment node
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('VSIX package boundary', () => {
  const ignoreRules = readFileSync(resolve(__dirname, '../../../.vscodeignore'), 'utf8');

  it('ships third-party notices and excludes repository-local metadata', () => {
    expect(ignoreRules).toMatch(/^!THIRD_PARTY_LICENSES\.md$/m);
    expect(ignoreRules).toMatch(/^\.chetana\/\*\*$/m);
    expect(ignoreRules).toMatch(/^\.concret\.io\/\*\*$/m);
    expect(ignoreRules).toMatch(/^\.gitmodules$/m);
  });
});
