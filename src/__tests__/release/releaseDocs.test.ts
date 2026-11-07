/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Release docs guard. The release checklist asks for these by hand; this test
 * fails the pull request instead, so a release cannot ship with a stale
 * KNOWN_ISSUES version line, an undated CHANGELOG section, a setting missing
 * from the README table or a translation missing from its status table.
 */

import { readFileSync, readdirSync } from 'fs';
import * as path from 'path';
import { repoRoot } from '../l10n/extraction';
import {
  changelogHasDatedSection,
  knownIssuesHeaderVersions,
  localesFromBundleFiles,
  settingsMissingFromReadme,
  shippedLocalesInL10nReadme,
} from './releaseDocs';

const read = (relativePath: string): string =>
  readFileSync(path.join(repoRoot, relativePath), 'utf8');

interface Manifest {
  version: string;
  contributes: { configuration: { properties: Record<string, unknown> } };
}

const manifest = JSON.parse(read('package.json')) as Manifest;

describe('release docs checks', () => {
  test('finds a setting the README table leaves out', () => {
    const readme = [
      '## Configuration',
      '| `markdownForHumans.zoom` | `100` | Size |',
      '| `markdownForHumans.paragraph.spacingBefore`, `.spacingAfter` | `0`, `0` | Space |',
      '## Documentation',
      '`markdownForHumans.enableMath` is mentioned here, outside the table',
    ].join('\n');
    const keys = [
      'markdownForHumans.zoom',
      'markdownForHumans.paragraph.spacingBefore',
      'markdownForHumans.paragraph.spacingAfter',
      'markdownForHumans.enableMath',
    ];
    expect(settingsMissingFromReadme(keys, `# Title\n${readme}`)).toEqual([
      'markdownForHumans.enableMath',
    ]);
  });

  test('reads every version in the KNOWN_ISSUES header and stops at the first rule', () => {
    const text = [
      '# Known Issues',
      'Living list for **Markdown Editor for Humans 0.4.6**.',
      '**Status:** 0.4.6 (2026-11-07)',
      '---',
      'Fixed in 0.4.4.',
    ].join('\n');
    expect(knownIssuesHeaderVersions(text)).toEqual(['0.4.6', '0.4.6']);
  });

  test('accepts only a dated CHANGELOG section for the version', () => {
    expect(changelogHasDatedSection('## [Unreleased]\n## [0.4.6] - 2026-11-07\n', '0.4.6')).toBe(
      true
    );
    expect(changelogHasDatedSection('## [Unreleased]\n## [0.4.6]\n', '0.4.6')).toBe(false);
    expect(changelogHasDatedSection('## [0.4.5] - 2026-10-14\n', '0.4.6')).toBe(false);
  });

  test('pairs shipped locales in the translations README with bundle files', () => {
    const readme = [
      '| Locale  | Language | Where  | State |',
      '| `zh-cn` | Chinese  | `l10n` | Shipped. AI translated |',
      '| `ja`    | Japanese | `l10n` | Shipped. AI translated |',
      '| `ko`    | Korean   | `l10n/drafts` | Draft |',
    ].join('\n');
    expect(shippedLocalesInL10nReadme(readme)).toEqual(['zh-cn', 'ja']);
    expect(
      localesFromBundleFiles(['bundle.l10n.json', 'bundle.l10n.ja.json', 'README.md'])
    ).toEqual(['ja']);
  });
});

describe('release docs match package.json', () => {
  test('README Configuration table lists every setting', () => {
    const keys = Object.keys(manifest.contributes.configuration.properties);
    expect(settingsMissingFromReadme(keys, read('README.md'))).toEqual([]);
  });

  test('KNOWN_ISSUES header names the current version only', () => {
    const versions = knownIssuesHeaderVersions(read('KNOWN_ISSUES.md'));
    expect(versions.length).toBeGreaterThan(0);
    expect(new Set(versions)).toEqual(new Set([manifest.version]));
  });

  test('CHANGELOG has a dated section for the current version', () => {
    expect(changelogHasDatedSection(read('CHANGELOG.md'), manifest.version)).toBe(true);
  });

  test('translations README status table matches the shipped bundles', () => {
    const shipped = shippedLocalesInL10nReadme(read('l10n/README.md')).sort();
    const bundles = localesFromBundleFiles(readdirSync(path.join(repoRoot, 'l10n'))).sort();
    expect(shipped).toEqual(bundles);
    for (const locale of bundles) {
      expect(() => read(`package.nls.${locale}.json`)).not.toThrow();
    }
  });
});
