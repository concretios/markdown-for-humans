/** @jest-environment jsdom */
/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import {
  L10N_BUNDLE_ATTRIBUTE,
  escapeHtmlText,
  formatL10n,
  l10nKey,
  parseL10nBundle,
  renderL10nBundleAttribute,
} from '../../shared/l10n';

describe('formatL10n', () => {
  it('returns a message without placeholders unchanged', () => {
    expect(formatL10n('No results', [])).toBe('No results');
  });

  it('substitutes indexed placeholders', () => {
    expect(formatL10n('{0} of {1}', [3, 12])).toBe('3 of 12');
  });

  it('lets a translation reorder and repeat placeholders', () => {
    expect(formatL10n('{1} total, showing {0} ({0})', [3, 12])).toBe('12 total, showing 3 (3)');
  });

  it('stringifies numbers and booleans', () => {
    expect(formatL10n('{0}/{1}', [0, false])).toBe('0/false');
  });

  it('keeps a placeholder that has no argument', () => {
    expect(formatL10n('{0} of {1}', [3])).toBe('3 of {1}');
  });

  it('does not expand placeholders that arrive inside an argument', () => {
    expect(formatL10n('Open {0}', ['{1}.md', 'secret'])).toBe('Open {1}.md');
  });

  it('leaves Markdown and LaTeX braces alone', () => {
    expect(formatL10n('Wrap words in \\text{ } and {name}', ['x'])).toBe(
      'Wrap words in \\text{ } and {name}'
    );
  });
});

describe('parseL10nBundle', () => {
  it('parses a flat string map', () => {
    expect(parseL10nBundle('{"No results":"无结果"}')).toEqual({ 'No results': '无结果' });
  });

  it.each([undefined, null, '', 'not json', '[]', '"text"', 'null', '42'])(
    'returns an empty bundle for %p',
    input => {
      expect(parseL10nBundle(input)).toEqual({});
    }
  );

  it('drops entries whose value is not a string', () => {
    expect(parseL10nBundle('{"a":"A","b":1,"c":null,"d":{"message":"D"}}')).toEqual({ a: 'A' });
  });

  it('does not expose inherited object keys', () => {
    const bundle = parseL10nBundle('{"a":"A"}');
    expect(bundle.constructor).toBeUndefined();
    expect(bundle.toString).toBeUndefined();
  });
});

describe('l10nKey', () => {
  it('is the message itself without a comment', () => {
    expect(l10nKey('Quote')).toBe('Quote');
    expect(l10nKey('Quote', '')).toBe('Quote');
    expect(l10nKey('Quote', [])).toBe('Quote');
  });

  it('appends the comment the way VS Code does', () => {
    expect(l10nKey('Quote', 'Toolbar button that inserts a block quote')).toBe(
      'Quote/Toolbar button that inserts a block quote'
    );
    expect(l10nKey('B', ['Bold button letter', ' Keep it to one character'])).toBe(
      'B/Bold button letter Keep it to one character'
    );
  });
});

describe('escapeHtmlText', () => {
  it('escapes every character that can open markup or close an attribute', () => {
    expect(escapeHtmlText(`<img src=x onerror="a()"> & 'q'`)).toBe(
      '&lt;img src=x onerror=&quot;a()&quot;&gt; &amp; &#39;q&#39;'
    );
  });

  it('keeps text an entity could be read from as plain text', () => {
    const host = document.createElement('div');
    host.innerHTML = `<span title="${escapeHtmlText('Finish &copy "now"')}">${escapeHtmlText('Finish &copy <b>')}</span>`;
    expect(host.querySelector('span')?.title).toBe('Finish &copy "now"');
    expect(host.textContent).toBe('Finish &copy <b>');
    expect(host.querySelectorAll('*')).toHaveLength(1);
  });
});

describe('renderL10nBundleAttribute', () => {
  it('renders nothing when VS Code loaded no bundle (English)', () => {
    expect(renderL10nBundleAttribute(undefined)).toBe('');
    expect(renderL10nBundleAttribute({})).toBe('');
  });

  it('round-trips through real HTML parsing, including hostile characters', () => {
    const bundle = {
      'No results': '无结果',
      'Say "hi" & <b>go</b>': '"引号" & <script>alert(1)</script> \'单引号\'',
    };
    const attribute = renderL10nBundleAttribute(bundle);
    expect(attribute.startsWith(` ${L10N_BUNDLE_ATTRIBUTE}="`)).toBe(true);

    const host = document.createElement('div');
    host.innerHTML = `<section${attribute}></section>`;
    const section = host.querySelector('section');

    expect(host.querySelectorAll('*')).toHaveLength(1);
    expect(parseL10nBundle(section?.getAttribute(L10N_BUNDLE_ATTRIBUTE))).toEqual(bundle);
  });
});
