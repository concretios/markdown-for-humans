/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import {
  blankLineLayoutSignature,
  hasSameBlankLineLayout,
  isMarkdownRendererEquivalent,
  isMarkdownStructurallyEquivalent,
} from '../../editor/markdownAstEquivalence';

describe('isMarkdownStructurallyEquivalent', () => {
  describe('returns true for cosmetic-only differences (lint-style preferences)', () => {
    test('byte-identical strings', () => {
      const text = '# Hello\n\nWorld\n';
      expect(isMarkdownStructurallyEquivalent(text, text)).toBe(true);
    });

    test('bullet marker swap: - vs * vs +', () => {
      const dash = '- one\n- two\n- three\n';
      const star = '* one\n* two\n* three\n';
      const plus = '+ one\n+ two\n+ three\n';
      expect(isMarkdownStructurallyEquivalent(dash, star)).toBe(true);
      expect(isMarkdownStructurallyEquivalent(dash, plus)).toBe(true);
      expect(isMarkdownStructurallyEquivalent(star, plus)).toBe(true);
    });

    test('ordered list renumbering (1,2,3 vs 1,1,1)', () => {
      const sequential = '1. one\n2. two\n3. three\n';
      const allOnes = '1. one\n1. two\n1. three\n';
      expect(isMarkdownStructurallyEquivalent(sequential, allOnes)).toBe(true);
    });

    test('ATX vs Setext heading style', () => {
      const atx = '# Title\n\nbody\n';
      const setext = 'Title\n=====\n\nbody\n';
      expect(isMarkdownStructurallyEquivalent(atx, setext)).toBe(true);
    });

    test('emphasis marker swap: * vs _', () => {
      expect(isMarkdownStructurallyEquivalent('a *word* here', 'a _word_ here')).toBe(true);
      expect(isMarkdownStructurallyEquivalent('a **bold** here', 'a __bold__ here')).toBe(true);
    });

    test('extra blank lines between blocks', () => {
      const tight = 'para one\n\npara two\n';
      const loose = 'para one\n\n\n\npara two\n';
      expect(isMarkdownStructurallyEquivalent(tight, loose)).toBe(true);
    });

    test('hard-wrap vs unwrapped paragraph (soft breaks)', () => {
      const wrapped = 'A long sentence\nthat is split across\nseveral source lines.\n';
      const flat = 'A long sentence that is split across several source lines.\n';
      expect(isMarkdownStructurallyEquivalent(wrapped, flat)).toBe(true);
    });

    test('list item indentation: 2-space vs 4-space nesting', () => {
      const twoSpace = '- outer\n  - nested\n';
      const fourSpace = '- outer\n    - nested\n';
      expect(isMarkdownStructurallyEquivalent(twoSpace, fourSpace)).toBe(true);
    });

    test('trailing newline difference', () => {
      expect(isMarkdownStructurallyEquivalent('# Title\n', '# Title')).toBe(true);
    });
  });

  describe('returns false for real edits', () => {
    test('changed text content', () => {
      expect(isMarkdownStructurallyEquivalent('# Title\n\nold', '# Title\n\nnew')).toBe(false);
    });

    test('added paragraph', () => {
      expect(isMarkdownStructurallyEquivalent('# Title\n', '# Title\n\nbody\n')).toBe(false);
    });

    test('changed link target', () => {
      const a = 'See [docs](https://example.com/old).\n';
      const b = 'See [docs](https://example.com/new).\n';
      expect(isMarkdownStructurallyEquivalent(a, b)).toBe(false);
    });

    test('changed image src', () => {
      const a = '![alt](old.png)\n';
      const b = '![alt](new.png)\n';
      expect(isMarkdownStructurallyEquivalent(a, b)).toBe(false);
    });

    test('changed heading level', () => {
      expect(isMarkdownStructurallyEquivalent('# Title\n', '## Title\n')).toBe(false);
    });

    test('emphasis added', () => {
      expect(isMarkdownStructurallyEquivalent('plain text here', 'plain *text* here')).toBe(false);
    });

    test('whitespace inside fenced code block is preserved', () => {
      const a = '```\nfoo  bar\n```\n'; // two spaces
      const b = '```\nfoo bar\n```\n'; // one space
      expect(isMarkdownStructurallyEquivalent(a, b)).toBe(false);
    });

    test('whitespace inside inline code is preserved', () => {
      const a = 'use `foo  bar` here';
      const b = 'use `foo bar` here';
      expect(isMarkdownStructurallyEquivalent(a, b)).toBe(false);
    });

    test('whitespace rendered significant by raw HTML is preserved', () => {
      const twoSpaces = '<span style="white-space: pre">a  b</span>\n';
      const oneSpace = '<span style="white-space: pre">a b</span>\n';
      expect(isMarkdownStructurallyEquivalent(twoSpaces, oneSpace)).toBe(false);
    });

    test('list nesting depth change is a real edit', () => {
      const flat = '- one\n- two\n';
      const nested = '- one\n  - two\n';
      expect(isMarkdownStructurallyEquivalent(flat, nested)).toBe(false);
    });

    test('code fence language change is a real edit', () => {
      const ts = '```ts\nx;\n```\n';
      const js = '```js\nx;\n```\n';
      expect(isMarkdownStructurallyEquivalent(ts, js)).toBe(false);
    });
  });

  describe('lint-clean → canonical round-trip scenarios', () => {
    test('a typical markdownlint-friendly doc vs the editor canonical form is equivalent', () => {
      const lintFriendly = [
        '# Project',
        '',
        'Some intro paragraph that someone',
        'has hard-wrapped at around eighty',
        'columns, the way markdownlint MD013',
        'wants it.',
        '',
        '## Steps',
        '',
        '1. First',
        '1. Second',
        '1. Third',
        '',
        '* one',
        '* two',
        '    * nested',
        '* three',
        '',
      ].join('\n');

      const canonical = [
        '# Project',
        '',
        'Some intro paragraph that someone has hard-wrapped at around eighty columns, the way markdownlint MD013 wants it.',
        '',
        '## Steps',
        '',
        '1. First',
        '2. Second',
        '3. Third',
        '',
        '- one',
        '- two',
        '  - nested',
        '- three',
        '',
      ].join('\n');

      expect(isMarkdownStructurallyEquivalent(lintFriendly, canonical)).toBe(true);
    });

    test('unchanged raw HTML does not prevent cosmetic normalization elsewhere', () => {
      const star = '<span>fixed</span>\n\n* one\n* two\n';
      const dash = '<span>fixed</span>\n\n- one\n- two\n';
      expect(isMarkdownStructurallyEquivalent(star, dash)).toBe(true);
    });
  });
});

describe('isMarkdownRendererEquivalent', () => {
  test('accepts the renderer hard-break form of a source soft wrap', () => {
    const source = 'Compatible VS Code hosts\nmust provide webview APIs.\n';
    const renderer = 'Compatible VS Code hosts  \nmust provide webview APIs.\n';

    expect(isMarkdownStructurallyEquivalent(renderer, source)).toBe(false);
    expect(isMarkdownRendererEquivalent(renderer, source)).toBe(true);
  });

  test('still rejects changed text across a wrapped line', () => {
    const source = 'Compatible VS Code hosts\nmust provide webview APIs.\n';
    const renderer = 'Compatible VS Code hosts  \nmust provide browser APIs.\n';

    expect(isMarkdownRendererEquivalent(renderer, source)).toBe(false);
  });

  test('accepts TipTap list-tightness canonicalization around a nested list', () => {
    const source = '- **Setting**\n\n  - First choice\n  - Second choice\n';
    const renderer = '- **Setting**\n  - First choice\n  - Second choice\n';

    expect(isMarkdownRendererEquivalent(renderer, source)).toBe(true);
  });

  test('does not collapse two real list-item paragraphs into one', () => {
    const source = '- First paragraph.\n\n  Second paragraph.\n';
    const renderer = '- First paragraph. Second paragraph.\n';

    expect(isMarkdownRendererEquivalent(renderer, source)).toBe(false);
  });

  test('accepts a recognized raw HTML tag round-tripped to native Markdown', () => {
    const source = 'Some text with <strong>bold</strong> in the middle.\n';
    const renderer = 'Some text with **bold** in the middle.\n';

    expect(isMarkdownRendererEquivalent(renderer, source)).toBe(true);
  });

  test('still rejects whitespace changes inside raw HTML that survives on both sides', () => {
    const twoSpaces = '<span style="white-space: pre">a  b</span>\n';
    const oneSpace = '<span style="white-space: pre">a b</span>\n';

    expect(isMarkdownRendererEquivalent(twoSpaces, oneSpace)).toBe(false);
  });
});

describe('hasSameBlankLineLayout', () => {
  test('treats a CRLF blank line the same as its LF equivalent', () => {
    const crlf = '# Title\r\n\r\nSome paragraph text.\r\n\r\nAnother paragraph.\r\n';
    const lf = '# Title\n\nSome paragraph text.\n\nAnother paragraph.\n';

    expect(blankLineLayoutSignature(crlf)).toBe(blankLineLayoutSignature(lf));
    expect(hasSameBlankLineLayout(crlf, lf)).toBe(true);
  });

  test('still detects a real blank-line-count difference under CRLF', () => {
    const oneBlank = '# Title\r\n\r\nBody.\r\n';
    const twoBlanks = '# Title\r\n\r\n\r\nBody.\r\n';

    expect(hasSameBlankLineLayout(oneBlank, twoBlanks)).toBe(false);
  });
});
