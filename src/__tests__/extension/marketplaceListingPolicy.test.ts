/**
 * Marketplace listing policy tests.
 *
 * VS Code Marketplace search ranks extensions whose display name contains the
 * query phrase first, so the display name and every contributed label share
 * one product name. vsce does not enforce the documented 30 keyword cap, so
 * this test does. See roadmap/pipeline/task-marketplace-discoverability.md.
 */

import fs from 'fs';
import path from 'path';

const rootDir = path.resolve(__dirname, '../../..');

interface PackageManifest {
  name: string;
  displayName: string;
  description: string;
  keywords: string[];
  contributes: {
    customEditors: Array<{ viewType: string; displayName: string }>;
    commands: Array<{ command: string; title: string }>;
    views: Record<string, Array<{ id: string; name: string }>>;
    configuration: { title: string };
  };
}

const manifestText = fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8');
const manifest = JSON.parse(manifestText) as PackageManifest;

const PRODUCT_NAME = 'Markdown Editor for Humans';

describe('marketplace listing policy', () => {
  test('uses a display name that contains the "Markdown Editor" search phrase', () => {
    expect(manifest.displayName).toBe(PRODUCT_NAME);
  });

  test('keeps the extension ID and editor view type stable across the rename', () => {
    expect(manifest.name).toBe('markdown-for-humans');
    expect(manifest.contributes.customEditors.map(editor => editor.viewType)).toEqual([
      'markdownForHumans.editor',
    ]);
  });

  test('labels every contributed surface with the product name', () => {
    expect(manifest.contributes.customEditors[0].displayName).toBe(PRODUCT_NAME);
    expect(manifest.contributes.configuration.title).toBe(PRODUCT_NAME);

    const openCommand = manifest.contributes.commands.find(
      command => command.command === 'markdownForHumans.openFile'
    );
    expect(openCommand?.title).toBe(`Open with ${PRODUCT_NAME}`);

    const viewNames = Object.values(manifest.contributes.views)
      .flat()
      .map(view => view.name);
    expect(viewNames).toContain(`${PRODUCT_NAME}: Outline`);

    expect(manifestText).not.toContain('Markdown for Humans');
  });

  test('keeps a short description that leads with the WYSIWYG editor and viewer phrases', () => {
    expect(manifest.description.startsWith('WYSIWYG Markdown editor and viewer')).toBe(true);
    // Search cards show about three lines; ranking listings use 30 to 110 characters.
    expect(manifest.description.length).toBeLessThanOrEqual(120);
    // The extension also ships to Open VSX editors such as Cursor and Windsurf.
    expect(manifest.description).not.toMatch(/VS Code/);
    expect(manifest.description).not.toContain('—');
  });

  test('stays within the documented 30 keyword cap with no duplicates', () => {
    expect(manifest.keywords.length).toBeLessThanOrEqual(30);
    const normalized = manifest.keywords.map(keyword => keyword.toLowerCase());
    expect(new Set(normalized).size).toBe(normalized.length);
    expect(normalized).toEqual(manifest.keywords);
  });

  test('includes the core and alternative search terms', () => {
    expect(manifest.keywords).toEqual(
      expect.arrayContaining([
        'markdown',
        'markdown-editor',
        'markdown-viewer',
        'wysiwyg',
        'viewer',
        'mermaid',
        'table',
        'typora',
        'obsidian',
        'katex',
      ])
    );
  });
});
