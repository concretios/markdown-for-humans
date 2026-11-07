/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Pure checks behind the release docs guard. Each takes file text and returns
 * what is wrong, so the guard can be exercised with fixtures as well as with
 * the real files.
 */

/** Settings keys that the README Configuration section does not mention. */
export function settingsMissingFromReadme(settingKeys: string[], readme: string): string[] {
  const start = readme.indexOf('\n## Configuration');
  if (start === -1) {
    return settingKeys;
  }
  const rest = readme.slice(start + 1);
  const end = rest.indexOf('\n## ');
  const lines = (end === -1 ? rest : rest.slice(0, end)).split('\n');

  return settingKeys.filter(key => {
    const dot = key.lastIndexOf('.');
    const parent = key.slice(0, dot);
    const last = key.slice(dot + 1);
    // A row may list siblings as `markdownForHumans.paragraph.spacingBefore`, `.spacingAfter`.
    return !lines.some(
      line =>
        line.includes(`\`${key}\``) ||
        (line.includes(`\`.${last}\``) && line.includes(`\`${parent}.`))
    );
  });
}

/** Every x.y.z version written in the KNOWN_ISSUES header, before its first rule. */
export function knownIssuesHeaderVersions(knownIssues: string): string[] {
  const header = knownIssues.split('\n---')[0];
  return [...header.matchAll(/\b(\d+\.\d+\.\d+)\b/g)].map(match => match[1]);
}

/** Whether CHANGELOG has a dated section for the version. */
export function changelogHasDatedSection(changelog: string, version: string): boolean {
  const heading = new RegExp(
    `^## \\[${version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`,
    'm'
  );
  return heading.test(changelog);
}

/** Locales the translations README lists as shipped. */
export function shippedLocalesInL10nReadme(readme: string): string[] {
  return [...readme.matchAll(/^\| `([a-z]{2}(?:-[a-z]{2})?)`\s*\|[^|]*\|[^|]*\|\s*Shipped/gm)].map(
    match => match[1]
  );
}

/** Locales that have a translated bundle file. */
export function localesFromBundleFiles(fileNames: string[]): string[] {
  return fileNames
    .map(name => /^bundle\.l10n\.([a-z]{2}(?:-[a-z]{2})?)\.json$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => match[1]);
}
