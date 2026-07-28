/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Preserve the spaces a user types between words in a math expression.
 *
 * KaTeX math mode collapses inter-token spaces, so prose like
 * "the area of circle is" renders run-together ("theareaofcircleis"). This
 * wraps top-level runs of words (letters separated by single spaces) in
 * `\text{…}`, where KaTeX keeps the spaces — while leaving the actual math
 * standard. The result:
 *
 *   "the area of circle is \pi r^2"  →  "\text{the area of circle is }\pi r^2"
 *   "x^2 + y^2"                       →  unchanged (pure math, standard spacing)
 *
 * Rules:
 * - Operates only at brace depth 0; command arguments (e.g. `\frac{a b}{c}`)
 *   are left as math.
 * - LaTeX commands (`\pi`, `\frac`, …) are consumed verbatim, so a command's
 *   letters are never mistaken for prose.
 * - Only runs containing an interior space (i.e. multiple words) are wrapped; a
 *   lone identifier like `x` stays math.
 * - Existing `\text{…}` is skipped (its braces increase depth), so the
 *   transform is idempotent and composes with the manual "Text" chip.
 *
 * This is a display-time helper — it does not mutate the stored source, so the
 * markdown the user typed is preserved verbatim.
 */
export function preserveProseSpaces(latex: string): string {
  if (!latex || latex.indexOf(' ') === -1) return latex;

  const isLetter = (ch: string): boolean => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');

  let out = '';
  let depth = 0;
  let i = 0;
  const n = latex.length;

  while (i < n) {
    const ch = latex[i];

    // Consume a LaTeX command verbatim: backslash + (letters | one char).
    if (ch === '\\') {
      out += ch;
      i++;
      if (i < n && isLetter(latex[i])) {
        while (i < n && isLetter(latex[i])) {
          out += latex[i];
          i++;
        }
      } else if (i < n) {
        out += latex[i];
        i++;
      }
      continue;
    }

    if (ch === '{') {
      depth++;
      out += ch;
      i++;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) depth--;
      out += ch;
      i++;
      continue;
    }

    // Prose only at the top level; inside braces everything stays math.
    if (depth === 0 && isLetter(ch)) {
      let run = '';
      while (i < n) {
        if (isLetter(latex[i])) {
          run += latex[i];
          i++;
        } else if (latex[i] === ' ' && i + 1 < n && isLetter(latex[i + 1])) {
          // Interior space between words — part of the prose run.
          run += ' ';
          i++;
        } else {
          break;
        }
      }

      if (run.includes(' ')) {
        // Pull an adjacent leading space (already emitted) and a trailing space
        // into the \text{} so the gaps to neighbouring math survive too.
        if (out.endsWith(' ')) {
          out = out.slice(0, -1);
          run = ' ' + run;
        }
        if (i < n && latex[i] === ' ') {
          run += ' ';
          i++;
        }
        out += `\\text{${run}}`;
      } else {
        // Lone identifier (e.g. a variable) — leave as standard math.
        out += run;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}
