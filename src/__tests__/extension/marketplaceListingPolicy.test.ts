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

  test('names the custom editor by type, since VS Code prefixes the extension name in the editor picker', () => {
    expect(manifest.contributes.customEditors[0].displayName).toBe('Visual Editor');
  });

  test('labels every contributed surface with the product name', () => {
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

  test('keeps the previous product name out of shipped source', () => {
    const sourceDir = path.join(rootDir, 'src');
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Tests and mocks do not ship, and this file names the old product on purpose.
          if (entry.name !== '__tests__' && entry.name !== '__mocks__') visit(entryPath);
        } else if (/\.(ts|css|html)$/.test(entry.name)) {
          if (fs.readFileSync(entryPath, 'utf8').includes('Markdown for Humans')) {
            offenders.push(path.relative(rootDir, entryPath));
          }
        }
      }
    };
    visit(sourceDir);
    expect(offenders).toEqual([]);
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
