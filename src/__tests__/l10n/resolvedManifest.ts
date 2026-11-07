/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Reads `package.json` the way VS Code and the packaging tool present it in
 * English: every `%key%` placeholder replaced by its text from `package.nls.json`.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import { repoRoot } from './extraction';

/** Raw text of the manifest and of its English strings, for whole-text checks. */
export function readManifestSources(): { manifest: string; english: string } {
  return {
    manifest: readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    english: readFileSync(path.join(repoRoot, 'package.nls.json'), 'utf8'),
  };
}

/** The manifest with its English text filled in. */
export function readResolvedManifest<T>(): T {
  const sources = readManifestSources();
  const english = JSON.parse(sources.english) as Record<string, string>;
  return JSON.parse(sources.manifest, (_key, value: unknown) =>
    typeof value === 'string'
      ? value.replace(/^%([\w.]+)%$/, (whole, key: string) => english[key] ?? whole)
      : value
  ) as T;
}
