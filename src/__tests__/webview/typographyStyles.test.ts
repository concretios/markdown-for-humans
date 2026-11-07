/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview How reader typography settings reach the page: as CSS custom
 * properties on the root element, with today's values as stylesheet fallbacks.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import { applyTypographySettings } from '../../webview/utils/typographyStyles';

const css = readFileSync(path.resolve(__dirname, '../../webview/editor.css'), 'utf8');

const NO_OVERRIDE = {
  fontFamily: null,
  fontWeight: null,
  fontSize: null,
  lineHeight: null,
  letterSpacing: null,
  wordSpacing: null,
};
const TYPOGRAPHY_PROPERTIES = [
  '--md-font-family',
  '--md-font-weight',
  '--md-editor-font-size',
  '--md-line-height',
  '--md-letter-spacing',
  '--md-word-spacing',
  '--md-code-text-spacing',
];

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|})\\s*${escaped}\\s*{([^}]*)}`, 'm').exec(css);
  if (!match) throw new Error(`No rule found for ${selector}`);
  return match[1];
}

function declarations(body: string, property: string): string[] {
  return [...body.matchAll(new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`, 'g'))].map(match =>
    match[1].trim()
  );
}

describe('applyTypographySettings', () => {
  const root = document.documentElement;
  const value = (name: string) => root.style.getPropertyValue(name);

  beforeEach(() => {
    root.removeAttribute('style');
  });

  it('sets no custom property while every setting is at its default', () => {
    applyTypographySettings(root, NO_OVERRIDE);

    expect(root.style.length).toBe(0);
    for (const name of TYPOGRAPHY_PROPERTIES) expect(value(name)).toBe('');
  });

  it('sets the font family, falling back to the font the editor uses today', () => {
    applyTypographySettings(root, { ...NO_OVERRIDE, fontFamily: '"Atkinson Hyperlegible"' });

    expect(value('--md-font-family')).toBe('"Atkinson Hyperlegible", var(--vscode-font-family)');
    expect(root.style.length).toBe(1);
  });

  it('sets the font weight', () => {
    applyTypographySettings(root, { ...NO_OVERRIDE, fontWeight: 500 });

    expect(value('--md-font-weight')).toBe('500');
    expect(root.style.length).toBe(1);
  });

  it('sets the line height as a unitless multiple', () => {
    applyTypographySettings(root, { ...NO_OVERRIDE, lineHeight: 1.8 });

    expect(value('--md-line-height')).toBe('1.8');
    expect(root.style.length).toBe(1);
  });

  it('sets letter spacing in em and takes code and math out of it', () => {
    applyTypographySettings(root, { ...NO_OVERRIDE, letterSpacing: 0.05 });

    expect(value('--md-letter-spacing')).toBe('0.05em');
    expect(value('--md-code-text-spacing')).toBe('normal');
    expect(root.style.length).toBe(2);
  });

  it('sets word spacing in em and takes code and math out of it', () => {
    applyTypographySettings(root, { ...NO_OVERRIDE, wordSpacing: 0.16 });

    expect(value('--md-word-spacing')).toBe('0.16em');
    expect(value('--md-code-text-spacing')).toBe('normal');
    expect(root.style.length).toBe(2);
  });

  it('sets the editor font size in pixels', () => {
    applyTypographySettings(root, { ...NO_OVERRIDE, fontSize: 15 });

    expect(value('--md-editor-font-size')).toBe('15px');
    expect(root.style.length).toBe(1);
  });

  it('removes every override when the settings return to their defaults', () => {
    applyTypographySettings(root, {
      fontFamily: '"Lexend"',
      fontWeight: 500,
      fontSize: 15,
      lineHeight: 1.8,
      letterSpacing: 0.05,
      wordSpacing: 0.16,
    });
    expect(root.style.length).toBe(TYPOGRAPHY_PROPERTIES.length);

    applyTypographySettings(root, NO_OVERRIDE);

    expect(root.style.length).toBe(0);
  });

  it('leaves unrelated root properties such as zoom alone', () => {
    root.style.setProperty('--md-base-size-override', '21px');
    root.style.setProperty('--md-paragraph-spacing-after', '6pt');

    applyTypographySettings(root, { ...NO_OVERRIDE, fontWeight: 500 });
    applyTypographySettings(root, NO_OVERRIDE);

    expect(value('--md-base-size-override')).toBe('21px');
    expect(value('--md-paragraph-spacing-after')).toBe('6pt');
  });

  it('clamps out-of-range numbers from an untrusted message', () => {
    applyTypographySettings(root, {
      ...NO_OVERRIDE,
      fontWeight: 5000,
      lineHeight: 40,
      letterSpacing: 7,
      wordSpacing: 7,
    });

    expect(value('--md-font-weight')).toBe('900');
    expect(value('--md-line-height')).toBe('3');
    expect(value('--md-letter-spacing')).toBe('0.5em');
    expect(value('--md-word-spacing')).toBe('1em');
  });

  it.each([[undefined], [null], ['Lexend'], [42]])(
    'treats the malformed message value %p as no override',
    malformed => {
      applyTypographySettings(root, { ...NO_OVERRIDE, fontWeight: 500 });

      applyTypographySettings(root, malformed);

      expect(root.style.length).toBe(0);
    }
  );

  it('rejects non-number values instead of writing them into CSS', () => {
    applyTypographySettings(root, {
      ...NO_OVERRIDE,
      fontWeight: '900; color: red',
      lineHeight: 'calc(99)',
      letterSpacing: '1em; background: url(https://example.invalid/x)',
      wordSpacing: { toString: () => '1em' },
    });

    expect(root.style.length).toBe(0);
  });

  it.each([
    ['Arial; } body { display: none } .x { color: red'],
    ['Arial; background: url(https://example.invalid/track)'],
    ['</style><style>* { display: none }</style><script>alert(1)</script>'],
    ['Arial"; color: red; "'],
    ['Arial\n} html { display: none }'],
  ])('cannot inject styles through the hostile font family %p', hostile => {
    const stylesBefore = document.querySelectorAll('style, script, link').length;
    const markupBefore = document.body.innerHTML;

    applyTypographySettings(root, { ...NO_OVERRIDE, fontFamily: hostile });

    // The whole value lands in one custom property, as one quoted font name
    // followed by the fallback. No other declaration, element or rule appears.
    expect(root.style.length).toBe(1);
    expect(root.style.item(0)).toBe('--md-font-family');
    expect(value('--md-font-family')).toMatch(
      /^"(?:[^"\\\n]|\\["\\])*"(?:, "(?:[^"\\\n]|\\["\\])*")*, var\(--vscode-font-family\)$/
    );
    expect(root.style.getPropertyValue('color')).toBe('');
    expect(root.style.getPropertyValue('display')).toBe('');
    expect(root.style.getPropertyValue('background')).toBe('');
    expect(document.querySelectorAll('style, script, link').length).toBe(stylesBefore);
    expect(document.body.innerHTML).toBe(markupBefore);
    expect(document.styleSheets.length).toBe(0);
  });
});

describe('editor stylesheet typography contract', () => {
  const root = ruleBody('.markdown-editor');

  it('falls back to exactly the values the editor used before the settings existed', () => {
    // VS Code's default webview stylesheet gives body text
    // `font-family: var(--vscode-font-family)` and
    // `font-weight: var(--vscode-font-weight)`; the editor inherited both.
    expect(declarations(root, 'font-family')).toEqual([
      'var(--md-font-family, var(--vscode-font-family))',
    ]);
    expect(declarations(root, 'font-weight')).toEqual([
      'var(--md-font-weight, var(--vscode-font-weight))',
    ]);
    expect(declarations(root, 'line-height')).toEqual(['var(--md-line-height, 1.58)']);
    expect(declarations(root, 'letter-spacing')).toEqual(['var(--md-letter-spacing, -0.003em)']);
    expect(declarations(root, 'word-spacing')).toEqual(['var(--md-word-spacing, normal)']);
    expect(declarations(root, '--md-base-size')).toEqual([
      'var(--md-base-size-override, var(--md-editor-font-size, var(--vscode-editor-font-size, 14px)))',
    ]);
  });

  it('routes every body line height through the setting, with 1.58 as the fallback', () => {
    expect(css.match(/line-height:\s*1\.58\s*;/g)).toBeNull();
    expect(css.match(/line-height:\s*var\(--md-line-height, 1\.58\);/g)).toHaveLength(5);
    for (const selector of [
      '.markdown-editor p',
      '.markdown-editor li',
      '.markdown-editor blockquote',
      '.markdown-editor .github-alert',
    ]) {
      expect(declarations(ruleBody(selector), 'line-height')).toEqual([
        'var(--md-line-height, 1.58)',
      ]);
    }
  });

  it('keeps headings on their own compact line height', () => {
    expect(
      declarations(
        ruleBody(
          '.markdown-editor h1,\n  .markdown-editor h2,\n  .markdown-editor h3,\n  .markdown-editor h4,\n  .markdown-editor h5,\n  .markdown-editor h6'
        ),
        'line-height'
      )
    ).toEqual(['1.25']);
  });

  it('keeps inline code and code blocks monospace when a body font is set', () => {
    // The body font is applied in exactly one place, the editor root. Code
    // declares its own family, which the root value can never override.
    expect(css.match(/var\(--md-font-family\b/g)).toHaveLength(1);
    expect(css.match(/var\(--md-font-weight\b/g)).toHaveLength(1);
    const code = ruleBody('.markdown-editor code');
    expect(declarations(code, 'font-family')).toEqual([
      'var(--vscode-editor-font-family, monospace)',
    ]);
    expect(declarations(code, 'font-weight')).toEqual(['var(--vscode-editor-font-weight, normal)']);
    expect(declarations(ruleBody('.markdown-editor pre'), 'line-height')).toEqual(['1.5']);
  });

  it('takes code and math out of reader letter and word spacing, inheriting as before by default', () => {
    const optOut = ruleBody('.markdown-editor :is(pre, code, .katex, .md4h-html-comment)');
    expect(declarations(optOut, 'letter-spacing')).toEqual([
      'var(--md-code-text-spacing, inherit)',
    ]);
    expect(declarations(optOut, 'word-spacing')).toEqual(['var(--md-code-text-spacing, inherit)']);
  });

  it('keeps monospace blocks that hold text directly at the standard weight', () => {
    // Mermaid source is a bare `pre` and comment markers are a `div`; neither has
    // a `code` child to restore the weight, so they would follow the body weight.
    expect(
      declarations(ruleBody('.markdown-editor :is(pre, .md4h-html-comment)'), 'font-weight')
    ).toEqual(['var(--vscode-font-weight)']);
  });

  it('pins Mermaid diagrams to the font their labels were measured in', () => {
    // Mermaid renders with `fontFamily: 'inherit'` and sizes its label boxes
    // before the SVG enters the editor, so a different body font would clip.
    const mermaid = ruleBody('.mermaid-render');
    expect(declarations(mermaid, 'font-family')).toEqual(['var(--vscode-font-family)']);
    expect(declarations(mermaid, 'font-weight')).toEqual(['var(--vscode-font-weight)']);
    expect(declarations(mermaid, 'line-height')).toEqual(['normal']);
    expect(declarations(mermaid, 'letter-spacing')).toEqual(['normal']);
    expect(declarations(mermaid, 'word-spacing')).toEqual(['normal']);
  });
});
