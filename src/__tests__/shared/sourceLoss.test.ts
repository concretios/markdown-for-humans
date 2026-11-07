/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { describeSourceLoss, lostTokenNames, silentSourceTokens } from '../../shared/sourceLoss';

describe('silentSourceTokens', () => {
  it('lists HTML tags, comments and link definitions in source order', () => {
    expect(
      silentSourceTokens(
        'A <mark>word</mark> here.\n\n<!-- note -->\n\n  [a]: https://a.example "T"  \n'
      )
    ).toEqual(['<mark>', '</mark>', '<!-- note -->', '[a]: https://a.example "T"']);
  });

  it('keeps a multi-line comment as one token', () => {
    expect(silentSourceTokens('<!--\nline one\nline two\n-->')).toEqual([
      '<!--\nline one\nline two\n-->',
    ]);
  });

  it('finds nothing in plain Markdown', () => {
    expect(silentSourceTokens('# Title\n\nSome **bold** and a [link](https://x.example).')).toEqual(
      []
    );
  });

  it('does not take a comparison or an arrow for a tag', () => {
    expect(silentSourceTokens('If a < b and c > d then x <- y, 1 <2.')).toEqual([]);
  });
});

describe('describeSourceLoss', () => {
  it('reports nothing for identical text', () => {
    expect(describeSourceLoss('Some <mark>x</mark>.', 'Some <mark>x</mark>.')).toBeNull();
  });

  it('names the tags the saved text no longer has', () => {
    expect(describeSourceLoss('Some <mark>marked</mark> text.', 'Some marked text.')).toEqual({
      lost: ['<mark>', '</mark>'],
      rendersDifferently: false,
    });
  });

  it('counts each occurrence, so one of two equal tags can be lost', () => {
    expect(describeSourceLoss('A<br>B<br>C', 'A<br>B  \nC')).toEqual({
      lost: ['<br>'],
      rendersDifferently: false,
    });
  });

  it('reports a dropped comment and a dropped definition', () => {
    expect(
      describeSourceLoss(
        '<!-- note --> text\n\n[a]: https://one.example\n[a]: https://two.example',
        'text\n\n[a]: https://one.example'
      )
    ).toEqual({
      lost: ['<!-- note -->', '[a]: https://two.example'],
      rendersDifferently: false,
    });
  });

  it('accepts a rewrite that keeps every tag when no renderer is given', () => {
    expect(describeSourceLoss('* one\n* two', '- one\n- two')).toBeNull();
  });

  it('asks the renderer only when no tag was lost, and reports a different rendering', () => {
    const render = jest.fn((markdown: string) => markdown.replace(/\\/g, ''));
    expect(
      describeSourceLoss('* one', '- one', markdown => markdown.replace(/^[*-]/, ''))
    ).toBeNull();
    expect(describeSourceLoss('Not \\*italic\\*', 'Not *italic*', markdown => markdown)).toEqual({
      lost: [],
      rendersDifferently: true,
    });
    expect(describeSourceLoss('A <u>b</u>', 'A b', render)).toEqual({
      lost: ['<u>', '</u>'],
      rendersDifferently: false,
    });
    expect(render).not.toHaveBeenCalled();
  });
});

describe('lostTokenNames', () => {
  it('names each kind of tag once, without attributes or closing tags', () => {
    expect(
      lostTokenNames([
        '<video src="a.mp4" controls>',
        '</video>',
        '<mark>',
        '</mark>',
        '<mark>',
        '<br/>',
      ])
    ).toEqual(['<video>', '<mark>', '<br>']);
  });

  it('names a closing tag that has no opening tag in the list', () => {
    expect(lostTokenNames(['</details>'])).toEqual(['<details>']);
  });

  it('names comments and link definitions by their form', () => {
    expect(
      lostTokenNames(['<!-- a long note -->', '<!--\nx\n-->', '[Docs Site]: https://a.example "T"'])
    ).toEqual(['<!-- -->', '[Docs Site]:']);
  });

  it('returns nothing for an empty list', () => {
    expect(lostTokenNames([])).toEqual([]);
  });
});
