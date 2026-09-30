import { findImageSourceReferences } from '../../editor/imageSourceReferences';

describe('image source spans for rename and lookup', () => {
  it.each([
    ['![Diagram](assets/My Diagram.svg)', 'assets/My Diagram.svg'],
    ['  ![Diagram](  assets/图 表.svg  )  ', 'assets/图 表.svg'],
    ['![Diagram](assets/My Diagram.svg?rev=2#detail)', 'assets/My Diagram.svg?rev=2#detail'],
    ['> ![Diagram](assets/My Diagram.svg)', 'assets/My Diagram.svg'],
    ['    ![Diagram](assets/My Diagram.svg "A title")', 'assets/My Diagram.svg'],
  ])('finds renderer-supported space-containing destinations in %s', (source, destination) => {
    const references = findImageSourceReferences(source);
    expect(references).toHaveLength(1);
    expect(references[0].source).toBe(destination);
    expect(source.slice(references[0].start, references[0].end)).toBe(destination);
    expect(source.slice(references[0].filenameStart, references[0].pathEnd)).toBe(
      destination.slice(destination.lastIndexOf('/') + 1).split(/[?#]/)[0]
    );
  });

  it.each([
    'Prose ![Diagram](assets/My Diagram.svg)',
    '- ![Diagram](assets/My Diagram.svg)',
    '![Diagram](assets/My Diagram.svg) and prose',
    '![Diagram](assets/My Diagram.svg)\nfollowing prose',
    '![Diagram](assets/My Diagram.svg)\n![Second](assets/Other Diagram.svg)',
    '![Diagram](assets/My Diagram.svg "A title")',
    '`![Diagram](assets/My Diagram.svg)`',
    '\\![Diagram](assets/My Diagram.svg)',
    '```md\n![Diagram](assets/My Diagram.svg)\n```',
    '    ![Diagram](assets/My Diagram.svg)\n    const code = true;',
    '<!--\n![Diagram](assets/My Diagram.svg)\n-->',
  ])('does not reinterpret unsupported space-containing syntax in %s', source => {
    expect(findImageSourceReferences(source)).toEqual([]);
  });

  it('preserves complete SVG view fragments, titles, angle paths and HTML attributes', () => {
    const markdown = [
      '![view](a.svg#svgView(viewBox(0,0,1280,560)) "Overview")',
      '![space](<My Images/a.svg#detail> "More")',
      '<img\n alt="vector" width="480" src = \'a.svg?x=1&amp;y=2#view\' height="210" />',
    ].join('\n');
    const references = findImageSourceReferences(markdown);
    expect(references.map(reference => reference.source)).toEqual([
      'a.svg#svgView(viewBox(0,0,1280,560))',
      'My Images/a.svg#detail',
      'a.svg?x=1&y=2#view',
    ]);
    expect(references.map(reference => markdown.slice(reference.start, reference.end))).toEqual([
      'a.svg#svgView(viewBox(0,0,1280,560))',
      'My Images/a.svg#detail',
      'a.svg?x=1&amp;y=2#view',
    ]);
  });

  it('ignores fenced, mixed indented, inline and escaped code examples and comments', () => {
    const markdown = [
      '```markdown',
      '![fence](a.svg)',
      '<img src="a.svg">',
      '```',
      '',
      '    ![indented](a.svg)',
      '    const example = true;',
      '',
      '`![inline](a.svg)` and ``<img src="a.svg">``',
      '\\![escaped](a.svg)',
      '<!-- <img src="a.svg"> -->',
      '![real](a.svg)',
    ].join('\n');
    expect(findImageSourceReferences(markdown).map(reference => reference.source)).toEqual([
      'a.svg',
    ]);
  });

  it('includes image-only indented Markdown and sized HTML that the rich editor renders as images', () => {
    const markdown =
      '    ![Diagram](diagram.svg#view)\n    <img src="second.svg" width="480">\n\n\t<img src="third.svg" width="240">';
    expect(findImageSourceReferences(markdown).map(reference => reference.source)).toEqual([
      'diagram.svg#view',
      'second.svg',
      'third.svg',
    ]);
  });

  it('reads actual src attributes, not lookalikes inside attribute values or data-src', () => {
    const markdown =
      '<img alt=\' src="wrong.svg"\' data-src="ignored.svg" src="actual.svg" width="480">';
    expect(findImageSourceReferences(markdown).map(reference => reference.source)).toEqual([
      'actual.svg',
    ]);
  });

  it('ignores image-like text inside raw HTML script, style and textarea elements', () => {
    const markdown =
      '<script>const example = `<img src="a.svg">`;</script>\n<style>/* ![](b.svg) */</style>\n<textarea><img src="c.svg"></textarea>\n<img src="actual.svg">';
    expect(findImageSourceReferences(markdown).map(reference => reference.source)).toEqual([
      'actual.svg',
    ]);
  });
});
