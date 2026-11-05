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

  it('does not let a heading with no ASCII letters claim the empty fragment', () => {
    expect(resolveHeadingAnchor(buildHeadingAnchors(['日本語']), '')).toBeUndefined();
  });

  it.each(['no-such-heading', '%E0%A4%A', ''])('returns undefined for #%s', fragment => {
    expect(resolveHeadingAnchor(anchors, fragment)).toBeUndefined();
  });
});
