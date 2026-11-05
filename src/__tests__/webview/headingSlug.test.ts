import {
  buildHeadingAnchors,
  generateHeadingSlug,
  resolveHeadingAnchor,
} from '../../webview/utils/headingSlug';

describe('generateHeadingSlug', () => {
  // Expected values are the ids GitHub's own renderer gave these headings
  // (POST /markdown, mode=markdown, 2026-11-04).
  it.each([
    ['Über uns', 'über-uns'],
    ['Größe und Maße', 'größe-und-maße'],
    ['Änderungen', 'änderungen'],
    ['Setup & Config', 'setup--config'],
    ['Tools & Tips', 'tools--tips'],
    ["What's new?", 'whats-new'],
    ['1. Introduction', '1-introduction'],
    ['The foo option', 'the-foo-option'],
    ['snake_case name', 'snake_case-name'],
    ['🚀 Launch', '-launch'],
    ['⚠\uFE0F Warning', '\uFE0F-warning'],
    ['Foo — bar', 'foo--bar'],
    ['日本語 見出し', '日本語-見出し'],
    ['Mixed Case Anchor', 'mixed-case-anchor'],
    ['C++ & C#', 'c--c'],
    ['Trailing dash -', 'trailing-dash--'],
    ['a.b/c:d', 'abcd'],
    ['Version 2', 'version2'],
    ['日本語　見出し', '日本語見出し'],
    ['Foo\tBar', 'foobar'],
    ['می‌خواهم', 'می‌خواهم'],
    ['👨‍👩‍👧 Family', '‍‍-family'],
    ['Area in m²', 'area-in-m'],
    ['① First step', '-first-step'],
    ['½ cup', '-cup'],
    ['Ⓐ Option', 'ⓐ-option'],
    ['ΟΔΟΣ', 'οδοσ'],
    ['Über uns'.normalize('NFD'), 'über uns'.normalize('NFD').replace(' ', '-')],
    // The text a heading has when an inline image or comment leaves a space at its edge.
    ['My Project ', 'my-project-'],
    [' My Project', '-my-project'],
  ])('%s -> %s', (text, slug) => {
    expect(generateHeadingSlug(text, new Set())).toBe(slug);
  });

  it('numbers repeated headings the way GitHub does', () => {
    const seen = new Set<string>();
    expect(['Notes', 'Notes', 'Notes'].map(text => generateHeadingSlug(text, seen))).toEqual([
      'notes',
      'notes-1',
      'notes-2',
    ]);
  });
});

describe('resolveHeadingAnchor', () => {
  const headings = [
    'Getting Started',
    'Über uns',
    'Größe und Maße',
    'Setup & Config',
    'Mixed Case Anchor',
    'Notes',
    'Notes',
  ];
  const anchors = buildHeadingAnchors(headings);

  it.each([
    ['getting-started', 0],
    ['über-uns', 1],
    ['gr%C3%B6%C3%9Fe-und-ma%C3%9Fe', 2],
    ['größe-und-maße', 2],
    ['setup--config', 3],
    ['Mixed-Case-Anchor', 4],
    ['notes', 5],
    ['notes-1', 6],
  ])('finds #%s', (fragment, index) => {
    expect(resolveHeadingAnchor(anchors, fragment)).toBe(index);
  });

  it('finds a fragment typed in decomposed Unicode, as macOS file names produce', () => {
    expect(resolveHeadingAnchor(anchors, 'über-uns'.normalize('NFD'))).toBe(1);
  });

  it.each([
    ['ber-uns', 1],
    ['gre-und-mae', 2],
    ['setup-config', 3],
  ])('still finds #%s, the form the link dialog wrote before', (fragment, index) => {
    expect(resolveHeadingAnchor(anchors, fragment)).toBe(index);
  });

  it('prefers a heading whose real slug matches over an older form of another heading', () => {
    const clash = buildHeadingAnchors(['Setup & Config', 'Setup Config']);
    expect(resolveHeadingAnchor(clash, 'setup-config')).toBe(1);
    expect(resolveHeadingAnchor(clash, 'setup--config')).toBe(0);
  });

  it('still finds a bare # the link dialog wrote for a heading with no ASCII letters', () => {
    expect(resolveHeadingAnchor(buildHeadingAnchors(['Intro', '日本語']), '')).toBe(1);
  });

  it('finds the GitHub anchor of a heading once a heading before it has no anchor', () => {
    const noAnchor = buildHeadingAnchors(['🚀', '🚀', 'Foo']);
    expect(resolveHeadingAnchor(noAnchor, '-1')).toBe(1);
    expect(resolveHeadingAnchor(noAnchor, 'foo')).toBe(2);
  });

  it.each<[string, string[], string, number | undefined]>([
    ['a badge in the title', ['Project ', 'Project'], 'project', 1],
    ['a badge in the title, its own anchor', ['Project ', 'Project'], 'project-', 0],
    ['a repeat after a badge', ['Foo', 'Foo ', 'Foo'], 'foo-1', 2],
    ['a superscript', ['Area in m²', 'Area in m'], 'area-in-m', 0],
    ['a non-breaking space', ['Version\u00A02', 'Version 2'], 'version-2', 1],
    [
      'an ideographic space',
      ['日本語\u3000見出し', '日本語 見出し', '日本語見出し'],
      '日本語見出し',
      0,
    ],
    [
      'an ideographic space',
      ['日本語\u3000見出し', '日本語 見出し', '日本語見出し'],
      '日本語-見出し',
      1,
    ],
    ['a final sigma', ['ΟΔΟΣ'], 'οδοσ', 0],
    ['a final sigma in capitals', ['ΟΔΟΣ'], 'ΟΔΟΣ', 0],
    ['a decomposed heading', ['Über uns'.normalize('NFD')], 'über-uns', 0],
  ])('goes where GitHub goes with %s', (_name, headingTexts, fragment, index) => {
    expect(resolveHeadingAnchor(buildHeadingAnchors(headingTexts), fragment)).toBe(index);
  });

  it.each(['no-such-heading', '%E0%A4%A', ''])('returns undefined for #%s', fragment => {
    expect(resolveHeadingAnchor(anchors, fragment)).toBeUndefined();
  });
});
