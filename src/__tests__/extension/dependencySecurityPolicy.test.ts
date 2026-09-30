/**
 * @jest-environment node
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PackageLock {
  packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
}

const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(resolve(__dirname, `../../../${relativePath}`), 'utf8')) as T;

const parseVersion = (version: string): readonly [number, number, number] => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Expected a semantic version, received ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const isAtLeast = (actual: string, minimum: string): boolean => {
  const actualParts = parseVersion(actual);
  const minimumParts = parseVersion(minimum);
  for (let index = 0; index < actualParts.length; index += 1) {
    if (actualParts[index] !== minimumParts[index]) {
      return actualParts[index] > minimumParts[index];
    }
  }
  return true;
};

describe('dependency security policy', () => {
  const reviewedTiptapVersion = '3.30.5';
  const manifest = readJson<PackageManifest>('package.json');
  const lock = readJson<PackageLock>('package-lock.json');

  const lockedVersion = (packageName: string): string => {
    const version = lock.packages?.[`node_modules/${packageName}`]?.version;
    if (!version) throw new Error(`Missing ${packageName} from package-lock.json`);
    return version;
  };

  const allLockedVersions = (packageName: string): string[] =>
    Object.entries(lock.packages ?? {})
      .filter(
        ([packagePath]) =>
          packagePath === `node_modules/${packageName}` ||
          packagePath.endsWith(`/node_modules/${packageName}`)
      )
      .map(([, packageEntry]) => packageEntry.version)
      .filter((version): version is string => version !== undefined);

  it('uses the reviewed Mermaid security release', () => {
    expect(manifest.dependencies?.mermaid).toBe('^11.17.2');
    expect(lockedVersion('mermaid')).toBe('11.17.2');
  });

  it('pins every direct production TipTap package to the reviewed release', () => {
    const directTiptapDependencies = Object.entries(manifest.dependencies ?? {}).filter(
      ([packageName]) => packageName.startsWith('@tiptap/')
    );

    expect(directTiptapDependencies.length).toBeGreaterThan(0);
    expect(manifest.dependencies?.['@tiptap/extension-paragraph']).toBe(reviewedTiptapVersion);
    for (const [, declaredVersion] of directTiptapDependencies) {
      expect(declaredVersion).toBe(reviewedTiptapVersion);
    }
  });

  it('keeps the root lock declarations and every installed TipTap package synchronized', () => {
    const directTiptapDependencies = Object.entries(manifest.dependencies ?? {}).filter(
      ([packageName]) => packageName.startsWith('@tiptap/')
    );
    const rootLockDependencies = lock.packages?.['']?.dependencies ?? {};
    for (const [packageName, declaredVersion] of directTiptapDependencies) {
      expect(rootLockDependencies[packageName]).toBe(declaredVersion);
    }

    const installedTiptapEntries = Object.entries(lock.packages ?? {}).filter(([packagePath]) =>
      packagePath.includes('node_modules/@tiptap/')
    );
    expect(installedTiptapEntries.length).toBeGreaterThan(0);
    for (const [, packageEntry] of installedTiptapEntries) {
      expect(packageEntry.version).toBe(reviewedTiptapVersion);
    }
  });

  it.each(['@tiptap/core', '@tiptap/pm'])(
    'installs one reviewed %s version family',
    packageName => {
      expect([...new Set(allLockedVersions(packageName))]).toEqual([reviewedTiptapVersion]);
    }
  );

  it.each([
    ['dompurify', '3.4.13'],
    ['nanoid', '5.1.16'],
    ['undici', '7.29.0'],
  ])('keeps %s at or above its patched compatible version', (packageName, minimum) => {
    expect(isAtLeast(lockedVersion(packageName), minimum)).toBe(true);
  });

  it('uses the bounded export reader instead of image-size or obsolete declarations', () => {
    expect(manifest.dependencies?.['image-size']).toBeUndefined();
    expect(lock.packages?.['node_modules/image-size']).toBeUndefined();
    expect(manifest.devDependencies?.['@types/image-size']).toBeUndefined();
    expect(lock.packages?.['node_modules/@types/image-size']).toBeUndefined();
  });

  it('declares the reviewed lint and local process tooling directly', () => {
    expect(manifest.devDependencies?.['@eslint/js']).toBe('^9.39.5');
    expect(manifest.devDependencies?.['@typescript-eslint/eslint-plugin']).toBe('^8.68.0');
    expect(manifest.devDependencies?.['@typescript-eslint/parser']).toBe('^8.68.0');
    expect(manifest.devDependencies?.concurrently).toBe('^9.2.4');

    expect(lockedVersion('@eslint/js')).toBe('9.39.5');
    expect(lockedVersion('@typescript-eslint/eslint-plugin')).toBe('8.68.0');
    expect(lockedVersion('@typescript-eslint/parser')).toBe('8.68.0');
    expect(lockedVersion('concurrently')).toBe('9.2.4');
  });

  it('keeps every brace-expansion branch above its denial-of-service floor', () => {
    const minimumByMajor: Readonly<Record<number, string>> = {
      1: '1.1.18',
      2: '2.1.4',
      5: '5.0.9',
    };

    const versions = allLockedVersions('brace-expansion');
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      const minimum = minimumByMajor[parseVersion(version)[0]];
      expect(minimum).toBeDefined();
      expect(isAtLeast(version, minimum)).toBe(true);
    }
  });

  it.each([
    ['fast-uri', { 3: '3.1.5' }],
    ['js-yaml', { 3: '3.15.1', 4: '4.3.1' }],
  ] as const)('keeps every %s branch above its patched floor', (packageName, minimumByMajor) => {
    const versions = allLockedVersions(packageName);
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      const minimum = minimumByMajor[parseVersion(version)[0] as keyof typeof minimumByMajor];
      expect(minimum).toBeDefined();
      expect(isAtLeast(version, minimum)).toBe(true);
    }
  });
});
