/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Inline Math (KaTeX) Extension
 *
 * Renders `$...$` LaTeX math inline with surrounding text.
 *
 * Round-trip:
 * - parse: `$E = mc^2$` → inlineMath node with attrs.latex = 'E = mc^2'
 * - serialize: inlineMath node → `$E = mc^2$`
 *
 * Inline ambiguity rule (pandoc-style, conservative):
 * - The opening `$` must NOT be followed by whitespace or another `$`.
 * - The closing `$` must NOT be preceded by whitespace.
 * - The closing `$` must NOT be followed by a digit (avoids `$5$200` cases).
 * - `\$` is treated as a literal dollar inside the math.
 * - Content may not span newlines.
 *
 * This rule keeps `$100 and $200` as plain text while still recognising
 * `$E = mc^2$` and similar math expressions.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import type { JSONContent, MarkdownRendererHelpers, MarkdownToken } from '@tiptap/core';
import katex from 'katex';
import { preserveProseSpaces } from '../utils/preserveProseSpaces';

interface InlineMathToken {
  type: string;
  raw: string;
  latex: string;
  text?: string;
}

const INLINE_MATH_RE = /^\$(?![\s$])((?:\\.|[^$\n])+?)(?<!\s)\$(?!\d)/;

function escapeLatexForMarkdown(latex: string): string {
  return latex.replace(/\$/g, '\\$');
}

function unescapeLatex(latex: string): string {
  return latex.replace(/\\\$/g, '$');
}

export const InlineMath = Node.create({
  name: 'inlineMath',

  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  draggable: false,

  // Higher priority than default link/text rules so the marked tokenizer
  // gets a chance before generic inline parsing.
  priority: 200,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: element => {
          const attr = element.getAttribute('data-latex');
          if (typeof attr === 'string') return attr;
          return element.textContent || '';
        },
        renderHTML: attributes => ({
          'data-latex': attributes.latex ?? '',
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-inline-math]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-inline-math': '',
        class: 'md4h-inline-math',
      }),
    ];
  },

  // The custom token type emitted by markdownTokenizer below.
  markdownTokenName: 'inlineMath',

  // Register a marked extension so `$...$` is tokenised at parse time.
  // @tiptap/markdown picks this up via getExtensionField.
  markdownTokenizer: {
    name: 'inlineMath',
    level: 'inline' as const,
    start(src: string): number {
      const idx = src.indexOf('$');
      return idx === -1 ? -1 : idx;
    },
    tokenize(src: string): InlineMathToken | undefined {
      const match = INLINE_MATH_RE.exec(src);
      if (!match) return undefined;
      const latex = unescapeLatex(match[1]).trim();
      if (!latex) return undefined;
      return {
        type: 'inlineMath',
        raw: match[0],
        latex,
        text: latex,
      };
    },
  },

  parseMarkdown: (token: MarkdownToken, helpers) => {
    const latex =
      typeof (token as unknown as { latex?: unknown }).latex === 'string'
        ? ((token as unknown as { latex: string }).latex as string)
        : (token.text ?? '');
    return helpers.createNode('inlineMath', { latex }, []);
  },

  renderMarkdown: ((node: JSONContent, _helpers: MarkdownRendererHelpers) => {
    const latex = (node.attrs?.latex as string) ?? '';
    return `$${escapeLatexForMarkdown(latex)}$`;
  }) as unknown as never,

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const span = document.createElement('span');
      span.className = 'md4h-inline-math';
      span.setAttribute('data-inline-math', '');
      span.contentEditable = 'false';
      span.setAttribute('role', 'math');

      let currentLatex: string = (node.attrs?.latex as string) || '';

      const render = () => {
        span.setAttribute('data-latex', currentLatex);
        span.title = currentLatex
          ? `${currentLatex} (double-click to edit)`
          : 'Empty math (double-click to edit)';
        span.classList.remove('md4h-math-error');

        if (!currentLatex.trim()) {
          span.textContent = '∅';
          span.classList.add('md4h-math-empty');
          return;
        }

        span.classList.remove('md4h-math-empty');

        try {
          span.innerHTML = katex.renderToString(preserveProseSpaces(currentLatex), {
            throwOnError: false,
            displayMode: false,
            output: 'html',
            strict: 'ignore',
          });
        } catch (err) {
          span.classList.add('md4h-math-error');
          span.textContent = `$${currentLatex}$`;
          span.title = err instanceof Error ? err.message : 'KaTeX render error';
        }
      };

      render();

      const openEditor = async () => {
        const { showMathEditor } = await import('../features/mathEditor');
        const result = await showMathEditor({
          initialLatex: currentLatex,
          displayMode: false,
        });
        if (!result.wasSaved || typeof getPos !== 'function') return;
        const pos = getPos();
        if (typeof pos !== 'number') return;

        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            latex: result.latex,
          })
        );
      };

      span.addEventListener('dblclick', event => {
        event.preventDefault();
        event.stopPropagation();
        void openEditor();
      });

      span.addEventListener('click', event => {
        if (!(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        event.stopPropagation();
        void openEditor();
      });

      return {
        dom: span,
        update: updatedNode => {
          if (updatedNode.type.name !== 'inlineMath') return false;
          const nextLatex = (updatedNode.attrs?.latex as string) || '';
          if (nextLatex !== currentLatex) {
            currentLatex = nextLatex;
            render();
          }
          return true;
        },
      };
    };
  },
});
