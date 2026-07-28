/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { preserveProseSpaces } from '../../webview/utils/preserveProseSpaces';

describe('preserveProseSpaces', () => {
  it('wraps multi-word prose runs in \\text{} so spaces survive', () => {
    expect(preserveProseSpaces('the area of circle is \\pi r^2')).toBe(
      '\\text{the area of circle is }\\pi r^2'
    );
  });

  it('leaves pure math with operator spaces untouched', () => {
    expect(preserveProseSpaces('x + y')).toBe('x + y');
    expect(preserveProseSpaces('x^2 + y^2')).toBe('x^2 + y^2');
    expect(preserveProseSpaces('\\pi * r^2')).toBe('\\pi * r^2');
  });

  it('returns input unchanged when there are no spaces', () => {
    expect(preserveProseSpaces('E=mc^2')).toBe('E=mc^2');
    expect(preserveProseSpaces('\\frac{a}{b}')).toBe('\\frac{a}{b}');
  });

  it('does not treat command names as prose', () => {
    // "pi" belongs to the \pi command, and the lone "r" is a variable — neither
    // is wrapped, so the expression is unchanged.
    expect(preserveProseSpaces('\\pi r')).toBe('\\pi r');
  });

  it('leaves a lone identifier as math', () => {
    expect(preserveProseSpaces('x')).toBe('x');
    expect(preserveProseSpaces('abc')).toBe('abc');
  });

  it('does not wrap prose inside command arguments (brace depth > 0)', () => {
    expect(preserveProseSpaces('\\frac{a b}{c}')).toBe('\\frac{a b}{c}');
  });

  it('is idempotent and skips existing \\text{}', () => {
    const once = preserveProseSpaces('the area is \\pi r^2');
    expect(preserveProseSpaces(once)).toBe(once);
    expect(preserveProseSpaces('\\text{the area is} \\pi r^2')).toBe(
      '\\text{the area is} \\pi r^2'
    );
  });

  it('preserves the gap between trailing prose and preceding math', () => {
    // Leading space before the prose run is pulled into the \text{}.
    expect(preserveProseSpaces('x^2 is the area')).toBe('x^2\\text{ is the area}');
  });
});
