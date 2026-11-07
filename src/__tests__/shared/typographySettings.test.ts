/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Contract for the reader typography settings shared by the
 * extension host and the webview: defaults resolve to "no override", numbers
 * are clamped, and a font family from user settings can only ever become a
 * list of quoted CSS strings and generic keywords.
 */

import {
  normalizeFontFamily,
  normalizeTypographySettings,
  resolveTypographySettings,
} from '../../shared/typographySettings';

const NO_OVERRIDE = {
  fontFamily: null,
  fontWeight: null,
  fontSize: null,
  lineHeight: null,
  letterSpacing: null,
  wordSpacing: null,
};

/** One quoted CSS string, with only `\"` and `\\` escapes, or a bare keyword. */
const SAFE_FAMILY = String.raw`(?:"(?:[^"\\\u0000-\u001f\u007f]|\\["\\])*"|[a-z-]+)`;
const SAFE_FAMILY_LIST = new RegExp(`^${SAFE_FAMILY}(?:, ${SAFE_FAMILY})*$`);
const GENERIC_KEYWORDS = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

function bareTokens(list: string): string[] {
  return list.replace(/"(?:[^"\\]|\\.)*"/g, '').match(/[a-z-]+/g) ?? [];
}

describe('normalizeFontFamily', () => {
  it('quotes a single family name', () => {
    expect(normalizeFontFamily('Atkinson Hyperlegible')).toBe('"Atkinson Hyperlegible"');
  });

  it('keeps a list in order, quoting names and passing generic keywords through', () => {
    expect(normalizeFontFamily(`Lexend, 'Atkinson Hyperlegible', "Segoe UI", sans-serif`)).toBe(
      '"Lexend", "Atkinson Hyperlegible", "Segoe UI", sans-serif'
    );
  });

  it('treats a quoted generic keyword as a font name, as CSS does', () => {
    expect(normalizeFontFamily('"serif", SERIF')).toBe('"serif", serif');
  });

  it('accepts names in any script', () => {
    expect(normalizeFontFamily('游ゴシック, Noto Sans CJK JP')).toBe(
      '"游ゴシック", "Noto Sans CJK JP"'
    );
  });

  it('collapses whitespace and drops empty entries', () => {
    expect(normalizeFontFamily('  Helvetica   Neue ,, ,Arial  ')).toBe('"Helvetica Neue", "Arial"');
  });

  it('is idempotent, so the webview can validate what the host already normalized', () => {
    for (const value of [
      'Lexend, sans-serif',
      'A "quoted" name',
      String.raw`back\slash`,
      `Arial"; color: red; "`,
    ]) {
      const once = normalizeFontFamily(value);
      expect(once).not.toBeNull();
      expect(normalizeFontFamily(once)).toBe(once);
    }
  });

  it.each([[''], ['   '], [',,,'], [undefined], [null], [42], [true], [['Arial']], [{}]])(
    'returns null for %p',
    value => {
      expect(normalizeFontFamily(value)).toBeNull();
    }
  );

  it('ignores an oversized value instead of truncating it', () => {
    expect(normalizeFontFamily('A'.repeat(1025))).toBeNull();
    expect(normalizeFontFamily('A'.repeat(1024))).toBe(`"${'A'.repeat(1024)}"`);
  });

  it('keeps at most 16 families', () => {
    const many = Array.from({ length: 40 }, (_, index) => `Font ${index}`).join(', ');
    expect(normalizeFontFamily(many)?.split(', ')).toHaveLength(16);
  });

  it.each([
    ['Arial; } body { display: none } .x { color: red'],
    ['Arial; background: url(https://example.invalid/track)'],
    ['</style><script>alert(1)</script>'],
    ['Arial"; color: red; "'],
    ["Arial'; color: red; '"],
    ['"unterminated'],
    ['Arial\n} * { display: none }'],
    ['a\u0000b\u001fc\u007fd'],
    [String.raw`Arial\"; } html { display: none`],
    ['trailing\\'],
    ['Arial !important'],
    ['var(--vscode-editor-background)'],
    ['expression(alert(1)), @import "x"'],
  ])('reduces the hostile value %p to quoted names and generic keywords', value => {
    const normalized = normalizeFontFamily(value);
    expect(normalized).not.toBeNull();
    expect(normalized).toMatch(SAFE_FAMILY_LIST);
    for (const token of bareTokens(normalized as string)) {
      expect(GENERIC_KEYWORDS.has(token)).toBe(true);
    }
  });
});

describe('resolveTypographySettings', () => {
  it('resolves every setting at its default to no override', () => {
    expect(
      resolveTypographySettings({
        family: '',
        weight: 400,
        lineHeight: 1.58,
        letterSpacing: 0,
        wordSpacing: 0,
      })
    ).toEqual(NO_OVERRIDE);
    expect(resolveTypographySettings({})).toEqual(NO_OVERRIDE);
  });

  it('resolves each setting independently', () => {
    expect(resolveTypographySettings({ family: 'Lexend' })).toEqual({
      ...NO_OVERRIDE,
      fontFamily: '"Lexend"',
    });
    expect(resolveTypographySettings({ weight: 500 })).toEqual({ ...NO_OVERRIDE, fontWeight: 500 });
    expect(resolveTypographySettings({ lineHeight: 1.8 })).toEqual({
      ...NO_OVERRIDE,
      lineHeight: 1.8,
    });
    expect(resolveTypographySettings({ letterSpacing: 0.05 })).toEqual({
      ...NO_OVERRIDE,
      letterSpacing: 0.05,
    });
    expect(resolveTypographySettings({ wordSpacing: 0.16 })).toEqual({
      ...NO_OVERRIDE,
      wordSpacing: 0.16,
    });
  });

  it('clamps out-of-range numbers to the allowed range', () => {
    expect(
      resolveTypographySettings({
        weight: 5000,
        lineHeight: 12,
        letterSpacing: 9,
        wordSpacing: 9,
      })
    ).toEqual({
      ...NO_OVERRIDE,
      fontWeight: 900,
      lineHeight: 3,
      letterSpacing: 0.5,
      wordSpacing: 1,
    });
    expect(
      resolveTypographySettings({
        weight: 1,
        lineHeight: 0.2,
        letterSpacing: -4,
        wordSpacing: -4,
      })
    ).toEqual({ ...NO_OVERRIDE, fontWeight: 100, lineHeight: 1 });
  });

  it('rounds the weight to a whole number', () => {
    expect(resolveTypographySettings({ weight: 449.6 }).fontWeight).toBe(450);
  });

  it.each([['500'], [NaN], [Infinity], [null], [undefined], [{}], [[500]], [true]])(
    'ignores the non-number %p for every numeric setting',
    value => {
      expect(
        resolveTypographySettings({
          weight: value,
          lineHeight: value,
          letterSpacing: value,
          wordSpacing: value,
        })
      ).toEqual(NO_OVERRIDE);
    }
  );

  it('ignores a non-string font family', () => {
    expect(resolveTypographySettings({ family: 42 })).toEqual(NO_OVERRIDE);
    expect(resolveTypographySettings({ family: ['Arial'] })).toEqual(NO_OVERRIDE);
  });

  describe('with the VS Code editor font opted in', () => {
    it('takes family, weight and size from the editor font', () => {
      expect(
        resolveTypographySettings({
          editorFont: { family: "Aptos, 'Segoe UI', sans-serif", weight: '500', size: 14 },
        })
      ).toEqual({
        ...NO_OVERRIDE,
        fontFamily: '"Aptos", "Segoe UI", sans-serif',
        fontWeight: 500,
        fontSize: 14,
      });
    });

    it('understands the keyword and numeric forms of editor.fontWeight', () => {
      const weightOf = (weight: unknown) =>
        resolveTypographySettings({ editorFont: { weight } }).fontWeight;
      expect(weightOf('normal')).toBeNull();
      expect(weightOf('bold')).toBe(700);
      expect(weightOf('350')).toBe(350);
      expect(weightOf(600)).toBe(600);
      expect(weightOf('heavy')).toBeNull();
      expect(weightOf('1000')).toBe(900);
    });

    it('lets the explicit family and weight settings win', () => {
      expect(
        resolveTypographySettings({
          family: 'Lexend',
          weight: 300,
          editorFont: { family: 'Menlo, monospace', weight: 'bold', size: 13 },
        })
      ).toEqual({ ...NO_OVERRIDE, fontFamily: '"Lexend"', fontWeight: 300, fontSize: 13 });
    });

    it('clamps the editor font size and ignores a non-number', () => {
      expect(resolveTypographySettings({ editorFont: { size: 400 } }).fontSize).toBe(100);
      expect(resolveTypographySettings({ editorFont: { size: 1 } }).fontSize).toBe(6);
      expect(resolveTypographySettings({ editorFont: { size: '14' } }).fontSize).toBeNull();
    });

    it('sanitizes a hostile editor font family the same way', () => {
      const resolved = resolveTypographySettings({
        editorFont: { family: 'Menlo; } body { display: none' },
      });
      expect(resolved.fontFamily).toMatch(SAFE_FAMILY_LIST);
    });
  });
});

describe('normalizeTypographySettings', () => {
  it('passes a resolved value through unchanged', () => {
    const resolved = resolveTypographySettings({
      family: 'Lexend, sans-serif',
      weight: 500,
      lineHeight: 1.8,
      letterSpacing: 0.05,
      wordSpacing: 0.16,
      editorFont: { size: 15 },
    });
    expect(normalizeTypographySettings(resolved)).toEqual(resolved);
  });

  it.each([[undefined], [null], ['Lexend'], [42], [[]]])(
    'treats the non-object message value %p as no override',
    value => {
      expect(normalizeTypographySettings(value)).toEqual(NO_OVERRIDE);
    }
  );

  it('re-validates every field of an untrusted message', () => {
    expect(
      normalizeTypographySettings({
        fontFamily: 'Arial; } body { display: none',
        fontWeight: '900; color: red',
        fontSize: 99999,
        lineHeight: 'calc(1 * 99)',
        letterSpacing: 44,
        wordSpacing: { toString: () => '1em; color: red' },
        extra: 'ignored',
      })
    ).toEqual({
      fontFamily: '"Arial; } body { display: none"',
      fontWeight: null,
      fontSize: 100,
      lineHeight: null,
      letterSpacing: 0.5,
      wordSpacing: null,
    });
  });
});
