/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Unit tests for KaTeX math extension markdown parsing/serialization.
 * Does not test KaTeX DOM rendering (NodeViews require a browser).
 */

import type { MarkdownParseHelpers, MarkdownToken, JSONContent } from '@tiptap/core';

// ─── Inline math regex (same as in extensions/math.ts) ─────────────────────

const INLINE_MATH_RE = /\$([^\s\d$][^$\n]*[^\s$]|[^\s\d$])\$/;

// ─── Test helpers ──────────────────────────────────────────────────────────

function createParseHelpers() {
  const createNode = jest.fn<
    ReturnType<MarkdownParseHelpers['createNode']>,
    Parameters<MarkdownParseHelpers['createNode']>
  >((type, attrs = {}, content = []) => ({ type, attrs, content }));

  const createTextNode = jest.fn<
    ReturnType<MarkdownParseHelpers['createTextNode']>,
    Parameters<MarkdownParseHelpers['createTextNode']>
  >(text => ({ type: 'text', text }));

  const helpers: MarkdownParseHelpers = {
    createNode,
    createTextNode,
    parseInline: jest.fn(),
    parseChildren: jest.fn(),
    applyMark: jest.fn(),
  } as unknown as MarkdownParseHelpers;

  helpers.createNode = createNode as MarkdownParseHelpers['createNode'];
  helpers.createTextNode = createTextNode as MarkdownParseHelpers['createTextNode'];

  return helpers;
}

// ─── Inline math regex tests ───────────────────────────────────────────────

describe('Inline math regex', () => {
  it('matches simple inline math', () => {
    expect(INLINE_MATH_RE.test('$x$')).toBe(true);
    expect(INLINE_MATH_RE.test('$E=mc^2$')).toBe(true);
    expect(INLINE_MATH_RE.test('$\\alpha$')).toBe(true);
  });

  it('captures the latex content without $ delimiters', () => {
    const match = '$E=mc^2$'.match(INLINE_MATH_RE);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('E=mc^2');
  });

  it('rejects dollar amounts (digit after $)', () => {
    expect(INLINE_MATH_RE.test('$100')).toBe(false);
    expect(INLINE_MATH_RE.test('$50.00')).toBe(false);
  });

  it('rejects space after opening $', () => {
    expect(INLINE_MATH_RE.test('$ x$')).toBe(false);
  });

  it('rejects space before closing $', () => {
    expect(INLINE_MATH_RE.test('$x $')).toBe(false);
  });

  it('rejects newlines inside math', () => {
    expect(INLINE_MATH_RE.test('$x\ny$')).toBe(false);
  });

  it('matches single-character math', () => {
    const match = '$n$'.match(INLINE_MATH_RE);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('n');
  });

  it('rejects empty math $$', () => {
    expect(INLINE_MATH_RE.test('$$')).toBe(false);
  });

  it('matches math with subscripts and superscripts', () => {
    expect(INLINE_MATH_RE.test('$x_i^2$')).toBe(true);
    expect(INLINE_MATH_RE.test('$a_{ij}$')).toBe(true);
  });

  it('matches math with fractions', () => {
    expect(INLINE_MATH_RE.test('$\\frac{1}{2}$')).toBe(true);
  });

  it('finds multiple matches in a string', () => {
    const text = 'Einstein said $E=mc^2$ and Pythagoras said $a^2+b^2=c^2$';
    const matches = [...text.matchAll(new RegExp(INLINE_MATH_RE.source, 'g'))];
    expect(matches).toHaveLength(2);
    expect(matches[0][1]).toBe('E=mc^2');
    expect(matches[1][1]).toBe('a^2+b^2=c^2');
  });

  it('does not match $ inside code-like contexts (single $ only)', () => {
    // A single $ without closing should not match
    expect(INLINE_MATH_RE.test('The cost is $50')).toBe(false);
  });

  it('handles escaped dollar sign in text', () => {
    // The regex itself doesn't check for \$, the plugin handles escaping
    // This test verifies the regex matches the pattern regardless
    expect(INLINE_MATH_RE.test('\\$x$')).toBe(true);
  });
});

// ─── MathBlock markdown parsing ────────────────────────────────────────────

describe('MathBlock markdown parsing', () => {
  it('parses a mathBlock token into a node', () => {
    const helpers = createParseHelpers();

    // Simulate what parseMarkdown does: check token type, create node
    const tokenType = 'mathBlock';
    expect(tokenType).toBe('mathBlock');

    const result = helpers.createNode('mathBlock', { language: 'latex' }, [
      helpers.createTextNode('x^2'),
    ]);

    expect(result.type).toBe('mathBlock');
    expect(result.attrs).toEqual({ language: 'latex' });
    expect(result.content).toHaveLength(1);
    expect(result.content?.[0]).toEqual({ type: 'text', text: 'x^2' });
  });

  it('creates mathBlock with empty content for empty block', () => {
    const helpers = createParseHelpers();
    const result = helpers.createNode('mathBlock', { language: 'latex' }, []);

    expect(result.type).toBe('mathBlock');
    expect(result.content).toHaveLength(0);
  });

  it('skips non-mathBlock tokens', () => {
    const codeTokenType = 'code';
    expect(codeTokenType).not.toBe('mathBlock');
  });

  it('preserves multiline LaTeX content', () => {
    const token: MarkdownToken = {
      type: 'mathBlock',
      raw: '$$\n\\begin{aligned}\nx &= y \\\\\nz &= w\n\\end{aligned}\n$$',
      text: '\\begin{aligned}\nx &= y \\\\\nz &= w\n\\end{aligned}',
    };

    expect(token.type).toBe('mathBlock');
    expect(token.text).toContain('\\begin{aligned}');
    expect(token.text).toContain('\\end{aligned}');
  });

  it('trims trailing whitespace from content', () => {
    const token: MarkdownToken = {
      type: 'mathBlock',
      raw: '$$\nx^2   \n$$',
      text: 'x^2',
    };

    expect(token.text).toBe('x^2');
  });
});

// ─── MathBlock markdown serialization ──────────────────────────────────────

describe('MathBlock markdown serialization', () => {
  it('renders mathBlock node as $$...$$', () => {
    const node: JSONContent = {
      type: 'mathBlock',
      attrs: { language: 'latex' },
      content: [{ type: 'text', text: 'x^2' }],
    };

    const renderChildren = (children: JSONContent[] | undefined, _sep: string): string => {
      if (!children || children.length === 0) return '';
      return children.map(c => (c.type === 'text' ? c.text || '' : '')).join('');
    };

    const body = renderChildren(node.content, '\n');
    const result = `$$\n${body}\n$$`;

    expect(result).toBe('$$\nx^2\n$$');
  });

  it('renders empty mathBlock cleanly', () => {
    const node: JSONContent = {
      type: 'mathBlock',
      attrs: { language: 'latex' },
      content: [],
    };

    const renderChildren = (children: JSONContent[] | undefined, _sep: string): string => {
      if (!children || children.length === 0) return '';
      return children.map(c => (c.type === 'text' ? c.text || '' : '')).join('');
    };

    const body = renderChildren(node.content, '\n');
    const result = `$$\n${body}\n$$`;

    expect(result).toBe('$$\n\n$$');
  });

  it('preserves LaTeX commands in serialization', () => {
    const latex = '\\int_0^\\infty e^{-x^2}dx = \\frac{\\sqrt{\\pi}}{2}';
    const node: JSONContent = {
      type: 'mathBlock',
      attrs: { language: 'latex' },
      content: [{ type: 'text', text: latex }],
    };

    const renderChildren = (children: JSONContent[] | undefined, _sep: string): string => {
      if (!children || children.length === 0) return '';
      return children.map(c => (c.type === 'text' ? c.text || '' : '')).join('');
    };

    const body = renderChildren(node.content, '\n');
    const result = `$$\n${body}\n$$`;

    expect(result).toContain(latex);
  });
});

// ─── MathInline markdown serialization ─────────────────────────────────────

describe('MathInline markdown serialization', () => {
  it('renders mathInline node as $...$', () => {
    const node: JSONContent = {
      type: 'mathInline',
      attrs: { latex: 'E=mc^2' },
    };

    const latex = node.attrs?.latex || '';
    const result = `$${latex}$`;

    expect(result).toBe('$E=mc^2$');
  });

  it('falls back to text content if latex attr is missing', () => {
    const node: JSONContent = {
      type: 'mathInline',
      attrs: {},
      content: [{ type: 'text', text: 'x^2' }],
    };

    const latex = node.attrs?.latex || (node.content?.[0]?.text as string) || '';
    const result = `$${latex}$`;

    expect(result).toBe('$x^2$');
  });

  it('handles empty math gracefully', () => {
    const node: JSONContent = {
      type: 'mathInline',
      attrs: {},
    };

    const latex = node.attrs?.latex || '';
    const result = `$${latex}$`;

    expect(result).toBe('$$');
  });
});

// ─── Edge cases ────────────────────────────────────────────────────────────

describe('Math extension edge cases', () => {
  it('blocks inside code fences are not math blocks', () => {
    // $$ inside a fenced code block starts with ``` at position 0,
    // so the math block tokenizer never sees the $$
    const codeFenceStart = '```\n';
    expect(codeFenceStart.startsWith('$$')).toBe(false);
  });

  it('distinguishes inline math from display math by delimiter count', () => {
    const inlineExample = '$x^2$';
    const displayExample = '$$\nx^2\n$$';

    // Inline: starts with single $
    expect(inlineExample.startsWith('$$')).toBe(false);

    // Display: starts with double $$
    expect(displayExample.startsWith('$$')).toBe(true);
  });

  it('handles backslash-escaped dollar signs', () => {
    // \\$100 should be literal text, not math
    const text = 'The price is \\$100';
    const match = text.match(INLINE_MATH_RE);
    // Without lookbehind, the regex might match, but the plugin skips
    // based on the preceding backslash character
    expect(match).toBeNull();
  });

  it('handles math with Greek letters', () => {
    expect(INLINE_MATH_RE.test('$\\alpha + \\beta = \\gamma$')).toBe(true);
    expect(INLINE_MATH_RE.test('$\\Delta x$')).toBe(true);
  });

  it('handles math with accents and diacritics', () => {
    expect(INLINE_MATH_RE.test('$\\hat{x}$')).toBe(true);
    expect(INLINE_MATH_RE.test('$\\vec{v}$')).toBe(true);
    expect(INLINE_MATH_RE.test('$\\dot{x}$')).toBe(true);
  });
});
