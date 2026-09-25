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
  test.each([
    ['italic soft wrap', '*One\ntwo*\n', '*One*  \n*two*\n'],
    ['bold soft wrap', '**One\ntwo**\n', '**One**  \n**two**\n'],
    ['italic hard break', '*One  \ntwo*\n', '*One*  \n*two*\n'],
    ['nested marks', '***One\ntwo***\n', '***One***  \n***two***\n'],
    ['partial nesting', '*One\n**two***\n', '*One*  \n***two***\n'],
    ['three lines', '*One\ntwo\nthree*\n', '*One*  \n*two*  \n*three*\n'],
    [
      'marked link label',
      '[*One\ntwo*](https://example.com)\n',
      '[*One*  \n*two*](https://example.com)\n',
    ],
  ])('accepts equivalent %s only for Feedback', (_name, source, renderer) => {
    expect(isMarkdownRendererEquivalent(renderer, source)).toBe(true);
    expect(isMarkdownRendererEquivalent(source, renderer)).toBe(true);
    expect(isMarkdownStructurallyEquivalent(renderer, source)).toBe(false);
  });

  test.each([
    ['text', '*One\ntwo*\n', '*One*  \n*changed*\n'],
    ['removed italic', '*One\ntwo*\n', '*One*  \ntwo\n'],
    ['changed mark', '*One\ntwo*\n', '*One*  \n**two**\n'],
    ['removed nested mark', '***One\ntwo***\n', '***One***  \n*two*\n'],
    ['removed break', '*One\ntwo*\n', '*One two*\n'],
    ['paragraph boundary', '*One\ntwo*\n', '*One*\n\n*two*\n'],
    ['literal markers', '\\*One\ntwo\\*\n', '*One*  \n*two*\n'],
    [
      'link target',
      '*[One](https://old.example)\ntwo*\n',
      '*[One](https://new.example)*  \n*two*\n',
    ],
    [
      'link title',
      '[*One\ntwo*](https://example.com "Old")\n',
      '[*One*  \n*two*](https://example.com "New")\n',
    ],
    ['code whitespace', '*One\n`a  b`*\n', '*One*  \n*`a b`*\n'],
    ['fenced code', '```\n*One\ntwo*\n```\n', '```\n*One*  \n*two*\n```\n'],
    ['raw HTML context', '<span>*One\ntwo*</span>\n', '<span>*One*  \n*two*</span>\n'],
  ])('rejects changed %s while comparing marks across breaks', (_name, source, renderer) => {
    expect(isMarkdownRendererEquivalent(renderer, source)).toBe(false);
    expect(isMarkdownRendererEquivalent(source, renderer)).toBe(false);
  });

  test('accepts the angle-bracket form of a standalone image path containing spaces', () => {
    const source = '![Diagram](assets/local image ünicode.png)\n';
    const renderer = '![Diagram](<assets/local image ünicode.png>)\n';

    expect(isMarkdownRendererEquivalent(renderer, source)).toBe(true);
  });

  test('does not reinterpret quoted image destinations that may contain a title', () => {
    const source = '![Diagram](assets/local.png "Original title")\n';
    const renderer = '![Diagram](<assets/local.png Changed title>)\n';

    expect(isMarkdownRendererEquivalent(renderer, source)).toBe(false);
  });

  test('does not reinterpret an image embedded inside a prose line', () => {
    const source = 'Before ![Diagram](assets/local image.png) after.\n';
    const renderer = 'Before ![Diagram](<assets/local image.png>) changed.\n';

    expect(isMarkdownRendererEquivalent(renderer, source)).toBe(false);
  });

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

  test.each([
    ['numbered', '1. Alpha\n\n2. Beta\n', '1. Alpha\n2. Beta\n'],
    ['bulleted', '- Alpha\n\n- Beta\n', '- Alpha\n- Beta\n'],
    ['nested', '1. Parent\n\n   - Child\n\n2. Next\n', '1. Parent\n   - Child\n2. Next\n'],
    [
      'fenced code',
      '10. Example\n\n    ```js\n    const value = "a  b";\n    ```\n',
      '10. Example\n    ```js\n    const value = "a  b";\n    ```\n',
    ],
  ])('accepts %s loose/tight lists only for Feedback', (_name, source, renderer) => {
    expect(isMarkdownRendererEquivalent(renderer, source)).toBe(true);
    expect(isMarkdownRendererEquivalent(source, renderer)).toBe(true);
    expect(isMarkdownStructurallyEquivalent(renderer, source)).toBe(false);
  });

  test.each([
    ['nesting', '1. Parent\n   - Child\n', '1. Parent\n  - Child\n'],
    ['text', '1. Alpha\n\n2. Beta\n', '1. Alpha\n2. Changed\n'],
    ['link', '- [Text](https://a.example)\n\n- Next\n', '- [Text](https://b.example)\n- Next\n'],
    ['code whitespace', '- `a  b`\n\n- Next\n', '- `a b`\n- Next\n'],
    [
      'raw HTML whitespace',
      '- <span style="white-space: pre">a  b</span>\n\n- Next\n',
      '- <span style="white-space: pre">a b</span>\n- Next\n',
    ],
    ['multiple paragraphs', '- First\n\n  Second\n\n- Next\n', '- First Second\n- Next\n'],
    ['code block', '1. Code\n\n   ```\n   a  b\n   ```\n', '1. Code\n\n   ```\n   a b\n   ```\n'],
  ])('rejects changed %s while normalizing list tightness', (_name, source, renderer) => {
    expect(isMarkdownRendererEquivalent(renderer, source)).toBe(false);
    expect(isMarkdownRendererEquivalent(source, renderer)).toBe(false);
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

  test.each([
    [
      'italic inside link label',
      'See [*Thinking, Fast and Slow*](https://en.wikipedia.org/wiki/Thinking,_Fast_and_Slow).\n',
      'See *[Thinking, Fast and Slow](https://en.wikipedia.org/wiki/Thinking,_Fast_and_Slow)*.\n',
    ],
    [
      'bold inside link label',
      'Uses [**RLCD**](https://docs.typesafe.ai/introduction/machine-learning-primer).\n',
      'Uses **[RLCD](https://docs.typesafe.ai/introduction/machine-learning-primer)**.\n',
    ],
    [
      'bold+italic inside link label',
      '[***text***](https://example.com/x)\n',
      '***[text](https://example.com/x)***\n',
    ],
  ])('accepts TipTap mark-outside-link canonicalization for %s', (_name, source, renderer) => {
    expect(isMarkdownRendererEquivalent(renderer, source)).toBe(true);
    expect(isMarkdownRendererEquivalent(source, renderer)).toBe(true);
    // Document-write equivalence stays strict: nesting order is a real HTML difference.
    expect(isMarkdownStructurallyEquivalent(renderer, source)).toBe(false);
  });

  test('still rejects a changed link target when marks wrap the link', () => {
    const source = 'See [*Thinking*](https://old.example).\n';
    const renderer = 'See *[Thinking](https://new.example)*.\n';

    expect(isMarkdownRendererEquivalent(renderer, source)).toBe(false);
  });

  test('still rejects when only part of the emphasized span is the link', () => {
    const source = '*See [Thinking](https://example.com) now*\n';
    const renderer = 'See *[Thinking](https://example.com)* now\n';

    expect(isMarkdownRendererEquivalent(renderer, source)).toBe(false);
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
