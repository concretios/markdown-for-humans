/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Guards the translatable text of the extension manifest:
 * - every command title, setting description, view name and similar text in
 *   `package.json` is a `%key%` placeholder with its English in `package.nls.json`
 * - the Marketplace listing fields stay literal
 * - a locale file keeps the links, code spans and placeholders of the English
 * - a shipped locale (file in the repo root) is complete and has its bundle in
 *   `l10n/`; a draft (in `l10n/drafts/`) may be partial
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import * as path from 'path';
import { bundleRoot, repoRoot } from './extraction';

type Json = Record<string, unknown>;

const readJson = (filePath: string): Json => JSON.parse(readFileSync(filePath, 'utf8')) as Json;
const manifest = readJson(path.join(repoRoot, 'package.json'));
const english = readJson(path.join(repoRoot, 'package.nls.json'));
const draftRoot = path.join(bundleRoot, 'drafts');

const TEXT_KEYS = new Set([
  'title',
  'shortTitle',
  'category',
  'displayName',
  'name',
  'contextualTitle',
  'label',
  'description',
  'markdownDescription',
  'deprecationMessage',
  'markdownDeprecationMessage',
  'enumDescriptions',
  'markdownEnumDescriptions',
  'enumItemLabels',
]);

interface ManifestText {
  where: string;
  value: string;
}

/** Every user-facing string under `contributes`, with the path it was found at. */
function contributedText(node: unknown, where: string, found: ManifestText[] = []): ManifestText[] {
  if (Array.isArray(node)) {
    node.forEach((item, index) => contributedText(item, `${where}[${index}]`, found));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const here = `${where}.${key}`;
      if (TEXT_KEYS.has(key) && typeof value === 'string') {
        found.push({ where: here, value });
      } else if (TEXT_KEYS.has(key) && Array.isArray(value)) {
        value.forEach((item, index) => found.push({ where: `${here}[${index}]`, value: item }));
      } else if (key !== 'default' && key !== 'enum' && key !== 'keybindings' && key !== 'menus') {
        contributedText(value, here, found);
      }
    }
  }
  return found;
}

const placeholder = /^%([\w.]+)%$/;
const texts = contributedText(manifest.contributes, 'contributes');
const usedKeys = texts.map(text => placeholder.exec(text.value)?.[1]).filter(Boolean) as string[];

/** Parts of a description a translator must carry over unchanged. */
function fixedTokens(text: string): string[] {
  return [
    ...(text.match(/\{\{\w+\}\}/g) ?? []),
    ...(text.match(/`[^`]+`/g) ?? []),
    ...(text.match(/\]\([^)]+\)/g) ?? []),
    ...(text.match(/#[\w.]+#/g) ?? []),
  ].sort();
}

function localeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => /^package\.nls\..+\.json$/.test(name))
    .map(name => path.join(dir, name));
}

const shipped = localeFiles(repoRoot);
const drafts = localeFiles(draftRoot);
const localeOf = (filePath: string): string =>
  path.basename(filePath).replace(/^package\.nls\.(.+)\.json$/, '$1');
const label = (filePath: string): string => path.relative(repoRoot, filePath);

describe('manifest text', () => {
  it('finds the contributed text', () => {
    expect(texts.length).toBeGreaterThan(30);
  });

  it('is a %key% placeholder everywhere under contributes', () => {
    expect(texts.filter(text => !placeholder.test(text.value))).toEqual([]);
  });

  it('keeps the Marketplace listing fields literal', () => {
    expect(placeholder.test(String(manifest.displayName))).toBe(false);
    expect(placeholder.test(String(manifest.description))).toBe(false);
  });

  it('has English text for every placeholder and no unused entry', () => {
    expect(usedKeys.filter(key => !(key in english))).toEqual([]);
    expect(Object.keys(english).filter(key => !usedKeys.includes(key))).toEqual([]);
  });

  it('stores English as plain non-empty strings', () => {
    // The Marketplace renders the { message, comment } form as "[object Object]".
    for (const [key, value] of Object.entries(english)) {
      expect({ key, ok: typeof value === 'string' && value.trim() !== '' }).toEqual({
        key,
        ok: true,
      });
    }
  });
});

const locales = [...shipped, ...drafts].map(file => [label(file), file]);
// Jest rejects an empty table, so the suites exist only while there is a locale to check.
(locales.length ? describe.each(locales) : describe.skip.each([['no locale', '']]))(
  '%s',
  (_name, file) => {
    // A skipped suite still runs this callback, with the empty placeholder path.
    const translated = file ? readJson(file) : {};

    it('has no stale entry and only non-empty text', () => {
      expect(Object.keys(translated).filter(key => !(key in english))).toEqual([]);
      for (const [key, value] of Object.entries(translated)) {
        expect({ key, ok: typeof value === 'string' && value.trim() !== '' }).toEqual({
          key,
          ok: true,
        });
      }
    });

    it('keeps the links, code spans and placeholders of the English text', () => {
      for (const [key, value] of Object.entries(translated)) {
        if (!(key in english)) continue;
        expect({ key, tokens: fixedTokens(String(value)) }).toEqual({
          key,
          tokens: fixedTokens(String(english[key])),
        });
      }
    });
  }
);

describe('shipped manifest locales', () => {
  it('translate every entry', () => {
    const incomplete = shipped
      .map(file => ({
        locale: label(file),
        missing: Object.keys(english).filter(key => !(key in readJson(file))),
      }))
      .filter(entry => entry.missing.length > 0);
    expect(incomplete).toEqual([]);
  });

  it('ship together with their message bundle', () => {
    const bundles = existsSync(bundleRoot)
      ? readdirSync(bundleRoot)
          .map(name => /^bundle\.l10n\.(.+)\.json$/.exec(name)?.[1])
          .filter(Boolean)
      : [];
    expect(shipped.map(localeOf).sort()).toEqual([...bundles].sort());
  });
});
