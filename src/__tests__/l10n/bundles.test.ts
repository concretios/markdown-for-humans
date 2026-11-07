/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Guards the translation bundles:
 * - every translation call uses a message that can be extracted
 * - `l10n/bundle.l10n.json` (English) lists exactly the messages used in the code
 * - no locale bundle keeps a message the code no longer uses
 * - a translation keeps the placeholders of its English source and adds no markup
 * - a locale in `l10n/` (shipped) is complete; `l10n/drafts/` may be partial
 *
 * `npm run l10n:extract` runs this file with L10N_WRITE=1 to rewrite the
 * English bundle from the code.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import {
  bundleRoot,
  extractMessages,
  placeholders,
  readSourceFiles,
  toEnglishBundle,
} from './extraction';

const englishPath = path.join(bundleRoot, 'bundle.l10n.json');
const draftRoot = path.join(bundleRoot, 'drafts');
const writing = process.env.L10N_WRITE === '1';

const extraction = extractMessages(readSourceFiles());
const expectedEnglish = toEnglishBundle(extraction.messages);
if (writing) writeFileSync(englishPath, `${JSON.stringify(expectedEnglish, null, 2)}\n`, 'utf8');

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function localeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => /^bundle\.l10n\..+\.json$/.test(name))
    .map(name => path.join(dir, name));
}

const english = readJson(englishPath);
const englishText = (key: string): string => {
  const value = english[key];
  return typeof value === 'string' ? value : (value as { message: string }).message;
};
const shipped = localeFiles(bundleRoot);
const drafts = localeFiles(draftRoot);
const label = (filePath: string): string => path.relative(bundleRoot, filePath);

describe('message extraction', () => {
  it('reads literals, plural choices and commented messages, and reports the rest', () => {
    const result = extractMessages([
      {
        name: 'sample.ts',
        text: [
          "vscode.l10n.t('Saved {0}', name);",
          "l10n.t('No results');",
          'l10n.html(`Plain template`);',
          "l10n.t(count === 1 ? '{0} comment' : '{0} comments', count);",
          "l10n.t({ message: 'Quote', comment: 'Block quote button' });",
          "vscode.l10n.t({ message: 'B', args: [], comment: ['Bold letter.', ' One character.'] });",
          'l10n.t(`Found ${count} results`);',
          "l10n.t('Count: ' + count);",
          'l10n.t(label);',
          "l10n.t({ message: 'No comment' });",
          "other.t('ignored');",
        ].join('\n'),
      },
    ]);
    expect([...result.messages.keys()].sort()).toEqual([
      'B/Bold letter. One character.',
      'No results',
      'Plain template',
      'Quote/Block quote button',
      'Saved {0}',
      '{0} comment',
      '{0} comments',
    ]);
    expect(result.messages.get('Quote/Block quote button')).toEqual({
      message: 'Quote',
      comment: ['Block quote button'],
    });
    expect(result.unextractable).toEqual([
      'sample.ts:7',
      'sample.ts:8',
      'sample.ts:9',
      'sample.ts:10',
    ]);
  });

  it('finds no unextractable message in the source tree', () => {
    expect(extraction.unextractable).toEqual([]);
  });
});

describe('English bundle', () => {
  it('lists exactly the messages used in the code (run `npm run l10n:extract`)', () => {
    expect(english).toEqual(expectedEnglish);
  });
});

const locales = [...shipped, ...drafts].map(file => [label(file), file]);
// Jest rejects an empty table, so the suites exist only while there is a locale to check.
(locales.length ? describe.each(locales) : describe.skip.each([['no locale', '']]))(
  '%s',
  (_name, file) => {
    // A skipped suite still runs this callback, with the empty placeholder path.
    const bundle = file ? readJson(file) : {};

    it('has no stale message', () => {
      expect(Object.keys(bundle).filter(key => !(key in english))).toEqual([]);
    });

    it('has only non-empty text', () => {
      for (const [key, value] of Object.entries(bundle)) {
        expect({ key, ok: typeof value === 'string' && value.trim() !== '' }).toEqual({
          key,
          ok: true,
        });
      }
    });

    it('keeps the placeholders of each English source', () => {
      for (const [key, value] of Object.entries(bundle)) {
        if (!(key in english)) continue;
        expect({ key, placeholders: placeholders(String(value)) }).toEqual({
          key,
          placeholders: placeholders(englishText(key)),
        });
      }
    });

    it('adds no markup characters the English source does not have', () => {
      for (const [key, value] of Object.entries(bundle)) {
        if (!(key in english)) continue;
        for (const character of ['<', '>']) {
          if (englishText(key).includes(character)) continue;
          expect({ key, character, found: String(value).includes(character) }).toEqual({
            key,
            character,
            found: false,
          });
        }
      }
    });
  }
);

describe('shipped locales', () => {
  it('translate every message', () => {
    const incomplete = shipped
      .map(file => ({
        locale: label(file),
        missing: Object.keys(english).filter(key => !(key in readJson(file))),
      }))
      .filter(entry => entry.missing.length > 0);
    expect(incomplete).toEqual([]);
  });

  it('keeps a locale in one place only', () => {
    const names = (files: string[]) => files.map(file => path.basename(file));
    expect(names(drafts).filter(name => names(shipped).includes(name))).toEqual([]);
  });
});
