/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Ratchet: the amount of English UI text written straight into a UI sink may
 * only go down. A file not listed in the baseline must have none.
 *
 * `npm run l10n:extract` rewrites the baseline after text was converted.
 */

import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { readSourceFiles } from './extraction';
import { findHardcodedText, looksLikeProse, type HardcodedText } from './hardcodedText';

const baselinePath = path.join(__dirname, 'hardcoded-baseline.json');
const found = findHardcodedText(readSourceFiles());
const byFile = new Map<string, HardcodedText[]>();
for (const entry of found) byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);

if (process.env.L10N_WRITE === '1') {
  const counts = Object.fromEntries(
    [...byFile.keys()].sort().map(file => [file, (byFile.get(file) as HardcodedText[]).length])
  );
  writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`, 'utf8');
}
// L10N_LIST=<output file> writes every finding as `file:line<TAB>text`, to plan a conversion.
if (process.env.L10N_LIST) {
  writeFileSync(
    process.env.L10N_LIST,
    found.map(entry => `${entry.file}:${entry.line}\t${entry.text}`).join('\n'),
    'utf8'
  );
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, number>;

describe('hardcoded UI text finder', () => {
  const find = (text: string) =>
    findHardcodedText([{ name: 'src/sample.ts', text }]).map(entry => entry.text);

  it('reports text written into UI sinks', () => {
    expect(
      find(
        [
          "vscode.window.showErrorMessage('Failed to save image');",
          "button.title = 'Copy code block';",
          "input.setAttribute('aria-label', 'Search query');",
          "const item = { label: 'Insert Table', icon: 'add' };",
          'dialog.innerHTML = `<h3>Rename Image</h3><p class="x">${name}</p>`;',
          'announce(`Feedback ${id} updated.`);',
        ].join('\n')
      )
    ).toEqual([
      'Failed to save image',
      'Copy code block',
      'Search query',
      'Insert Table',
      '<h3>Rename Image</h3><p class="x">{0}</p>',
      'Feedback {0} updated.',
    ]);
  });

  it('accepts translated, technical and explicitly ignored text', () => {
    expect(
      find(
        [
          "vscode.window.showErrorMessage(vscode.l10n.t('Failed to save image'));",
          "button.title = l10n.t('Copy code block');",
          "toggle.textContent = l10n.t({ message: 'Compact', comment: 'Composer size' });",
          "const item = { label: vscode.l10n.t({ message: 'Open file', comment: 'Verb' }) };",
          "dialog.innerHTML = `<h3>${l10n.html('Rename Image')}</h3>`;",
          "button.className = 'toolbar-button primary';",
          "input.setAttribute('aria-hidden', 'true');",
          "console.log('[MD4H] Content updated');",
          "throw new Error('Editor is not ready');",
          "if (choice === 'Discard draft') return;",
          "const item = { label: 'Mermaid' }; // l10n-ignore: product name",
          "const state = { kind: 'Idle' };",
        ].join('\n')
      )
    ).toEqual([]);
  });

  it('tells prose from identifiers', () => {
    for (const prose of ['Bold', 'No results', '{0} of {1}', 'Line {0}', '$(pencil) {0} words']) {
      expect({ prose, result: looksLikeProse(prose) }).toEqual({ prose, result: true });
    }
    for (const technical of ['bold', 'list-unordered', 'codicon codicon-add', '.toolbar', 'H1']) {
      expect({ technical, result: looksLikeProse(technical) }).toEqual({
        technical,
        result: false,
      });
    }
  });
});

describe('hardcoded UI text ratchet', () => {
  it('adds no new hardcoded UI text', () => {
    const added = [...byFile.entries()]
      .filter(([file, entries]) => entries.length > (baseline[file] ?? 0))
      .map(([file, entries]) => ({
        file,
        allowed: baseline[file] ?? 0,
        found: entries.map(entry => `${entry.line}: ${entry.text.slice(0, 80)}`),
      }));
    expect(added).toEqual([]);
  });

  it('keeps the baseline as low as the code (run `npm run l10n:extract`)', () => {
    const stale = Object.entries(baseline)
      .filter(([file, allowed]) => (byFile.get(file)?.length ?? 0) < allowed)
      .map(([file, allowed]) => ({ file, allowed, found: byFile.get(file)?.length ?? 0 }));
    expect(stale).toEqual([]);
  });
});
