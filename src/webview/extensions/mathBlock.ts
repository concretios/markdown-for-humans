/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Block / display math (KaTeX) extension.
 *
 * Round-trip:
 * - parse: `$$\n\\int_0^\\infty x^2 dx\n$$` → mathBlock node with attrs.latex
 * - serialize: mathBlock node → `$$\n<latex>\n$$`
 *
 * Block delimiters must sit at the beginning and end of the block. The
 * tokenizer accepts both single-line `$$ ... $$` and multi-line forms.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import type { JSONContent, MarkdownRendererHelpers, MarkdownToken } from '@tiptap/core';
import katex from 'katex';

interface MathBlockToken {
  type: string;
  raw: string;
  latex: string;
  text?: string;
}

const BLOCK_MATH_RE = /^\$\$[ \t]*\n([\s\S]+?)\n[ \t]*\$\$(?:[ \t]*\n|[ \t]*$)/;
const BLOCK_MATH_INLINE_RE = /^\$\$[ \t]*([^\n$][\s\S]*?[^\n$])[ \t]*\$\$(?:[ \t]*\n|[ \t]*$)/;

export const MathBlock = Node.create({
  name: 'mathBlock',

  group: 'block',
  atom: true,
  defining: true,
  isolating: true,
  selectable: true,
  draggable: true,

  // Run before generic block parsers (paragraph priority is 1000 by default).
  // Higher than mermaid (200) so $$ is recognised before code-block fallbacks.
  priority: 250,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: element => {
          const attr = element.getAttribute('data-latex');
          if (typeof attr === 'string') return attr;
          const child = element.querySelector('pre, code, script[type="math/tex"]');
          return child ? child.textContent || '' : element.textContent || '';
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
        tag: 'div[data-math-block]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-math-block': '',
        class: 'md4h-math-block',
      }),
    ];
  },

  markdownTokenName: 'mathBlock',

  markdownTokenizer: {
    name: 'mathBlock',
    level: 'block' as const,
    start(src: string): number {
      const idx = src.indexOf('$$');
      return idx === -1 ? -1 : idx;
    },
    tokenize(src: string): MathBlockToken | undefined {
      let match = BLOCK_MATH_RE.exec(src);
      if (!match) {
        match = BLOCK_MATH_INLINE_RE.exec(src);
      }
      if (!match) return undefined;
      const latex = match[1].replace(/^\n+|\n+$/g, '').trim();
      if (!latex) return undefined;
      return {
        type: 'mathBlock',
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
    return helpers.createNode('mathBlock', { latex }, []);
  },

  renderMarkdown: ((node: JSONContent, _helpers: MarkdownRendererHelpers) => {
    const latex = ((node.attrs?.latex as string) ?? '').replace(/\s+$/, '');
    return `$$\n${latex}\n$$`;
  }) as unknown as never,

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const container = document.createElement('div');
      container.className = 'md4h-math-block';
      container.setAttribute('data-math-block', '');
      container.contentEditable = 'false';
      container.setAttribute('role', 'math');

      const render = document.createElement('div');
      render.className = 'md4h-math-block-render';
      container.appendChild(render);

      const tooltip = document.createElement('div');
      tooltip.className = 'md4h-math-block-tooltip';
      tooltip.textContent = 'Double-click to edit';
      tooltip.style.display = 'none';
      container.appendChild(tooltip);

      let currentLatex: string = (node.attrs?.latex as string) || '';

      const draw = () => {
        container.setAttribute('data-latex', currentLatex);
        container.classList.remove('md4h-math-error');
        render.classList.remove('md4h-math-error-body');

        if (!currentLatex.trim()) {
          render.innerHTML =
            '<div class="md4h-math-block-placeholder">Empty equation. Double-click to edit.</div>';
          return;
        }

        try {
          render.innerHTML = katex.renderToString(currentLatex, {
            throwOnError: false,
            displayMode: true,
            output: 'html',
            strict: 'ignore',
          });
        } catch (err) {
          container.classList.add('md4h-math-error');
          render.classList.add('md4h-math-error-body');
          const message = err instanceof Error ? err.message : 'KaTeX render error';
          render.innerHTML = '';
          const errorBox = document.createElement('div');
          errorBox.className = 'md4h-math-error-message';
          errorBox.textContent = `LaTeX error: ${message}`;
          const sourceBox = document.createElement('pre');
          sourceBox.className = 'md4h-math-error-source';
          sourceBox.textContent = currentLatex;
          render.appendChild(errorBox);
          render.appendChild(sourceBox);
        }
      };

      draw();

      let isHighlighted = false;
      const removeHighlight = () => {
        container.classList.remove('highlighted');
        tooltip.style.display = 'none';
        isHighlighted = false;
      };

      const openEditor = async () => {
        const { showMathEditor } = await import('../features/mathEditor');
        const result = await showMathEditor({
          initialLatex: currentLatex,
          displayMode: true,
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

      container.addEventListener('click', () => {
        if (!isHighlighted) {
          container.classList.add('highlighted');
          tooltip.style.display = 'block';
          isHighlighted = true;
        }
      });

      container.addEventListener('dblclick', event => {
        event.preventDefault();
        event.stopPropagation();
        removeHighlight();
        void openEditor();
      });

      const handleDocumentClick = (e: MouseEvent) => {
        if (!container.contains(e.target as HTMLElement) && isHighlighted) {
          removeHighlight();
        }
      };
      document.addEventListener('click', handleDocumentClick);

      return {
        dom: container,
        update: updatedNode => {
          if (updatedNode.type.name !== 'mathBlock') return false;
          const nextLatex = (updatedNode.attrs?.latex as string) || '';
          if (nextLatex !== currentLatex) {
            currentLatex = nextLatex;
            draw();
          }
          return true;
        },
        destroy: () => {
          document.removeEventListener('click', handleDocumentClick);
        },
      };
    };
  },
});
