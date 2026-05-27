/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * KaTeX Math Extension for TipTap
 *
 * Provides two node types:
 *   - mathBlock  (block) for display math $$...$$
 *   - mathInline (inline) for inline math $...$
 *
 * Markdown parsing via marked extensions (block math) and a ProseMirror plugin
 * (inline math). Rendering via KaTeX with double-click-to-edit.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import katex from 'katex';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MarkedToken {
  type?: string;
  raw?: string;
  text?: string;
  lang?: string;
  codeBlockStyle?: string;
  tokens?: MarkedToken[];
}

interface MarkedBlockExtension {
  name: string;
  level: 'block';
  start: (src: string) => number;
  tokenizer: (src: string) => MarkedToken | undefined;
}

// ─── Marked block extension for $$...$$ ─────────────────────────────────────

const mathBlockMarkedExtension: MarkedBlockExtension = {
  name: 'mathBlock',
  level: 'block',
  start(src: string) {
    return src.indexOf('$$');
  },
  tokenizer(src: string) {
    const match = src.match(/^\$\$\n?([\s\S]*?)\$\$/);
    if (!match) return undefined;
    return {
      type: 'mathBlock',
      raw: match[0],
      text: match[1].trimEnd(),
    };
  },
};

/**
 * Install the math-block marked extension. Idempotent.
 */
export function installMathMarkedExtensions(markedInstance: unknown): void {
  const inst = markedInstance as {
    use?: (options: { extensions: MarkedBlockExtension[] }) => void;
    __mdh_mathExtensionsInstalled?: boolean;
  };
  if (!inst || typeof inst.use !== 'function') return;
  if (inst.__mdh_mathExtensionsInstalled) return;

  inst.use({ extensions: [mathBlockMarkedExtension] });
  inst.__mdh_mathExtensionsInstalled = true;
}

// ─── Inline math regex ──────────────────────────────────────────────────────
//
// Matches $content$ where:
//   - content does not start with a space, digit, or $
//   - content does not contain a newline
//   - content does not end with a space or $
// This avoids matching dollar amounts ($100) while matching actual math.

const INLINE_MATH_RE = /\$([^\s\d$][^$\n]*[^\s$]|[^\s\d$])\$/;

// ─── KaTeX helpers ──────────────────────────────────────────────────────────

const KATEX_OPTIONS_INLINE: katex.KatexOptions = {
  throwOnError: false,
  displayMode: false,
  trust: false,
};

const KATEX_OPTIONS_DISPLAY: katex.KatexOptions = {
  throwOnError: false,
  displayMode: true,
  trust: false,
};

function tryRenderKatex(latex: string, displayMode: boolean): { html: string; error?: string } {
  try {
    const html = katex.renderToString(
      latex,
      displayMode ? KATEX_OPTIONS_DISPLAY : KATEX_OPTIONS_INLINE
    );
    return { html };
  } catch (e) {
    return { html: '', error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── MathBlock ──────────────────────────────────────────────────────────────

export const MathBlock = Node.create({
  name: 'mathBlock',

  group: 'block',

  content: 'text*',

  marks: '',

  code: true,

  defining: true,

  isolating: true,

  addAttributes() {
    return {
      language: {
        default: 'latex',
        parseHTML: (element) => element.getAttribute('data-language'),
        renderHTML: (attributes) => ({
          'data-language': attributes.language,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="mathBlock"]',
        preserveWhitespace: 'full',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'mathBlock', class: 'math-block' }),
      ['code', {}, 0],
    ];
  },

  markdownTokenName: 'mathBlock',

  parseMarkdown(token, helpers) {
    if (token.type !== 'mathBlock') return [];
    const text = (token as MarkedToken).text ?? '';
    const content = text ? [helpers.createTextNode(text)] : [];
    return helpers.createNode('mathBlock', { language: 'latex' }, content);
  },

  renderMarkdown(node, helpers, _ctx) {
    const body = helpers.renderChildren(node.content || [], '\n');
    const content = body.trimEnd();
    return `$$\n${content}\n$$`;
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const container = document.createElement('div');
      container.className = 'math-block-container';

      const renderedEl = document.createElement('div');
      renderedEl.className = 'math-block-rendered';

      // Track source on DOM so update() can see the current value
      let source = node.textContent || '';
      container.setAttribute('data-latex', source);

      const doRender = (latex: string) => {
        if (!latex.trim()) {
          renderedEl.innerHTML = '<div class="math-placeholder">Enter LaTeX formula</div>';
          renderedEl.classList.remove('rendered', 'katex-error');
          return;
        }
        const { html, error } = tryRenderKatex(latex, true);
        if (error) {
          renderedEl.innerHTML = `<div class="math-error-icon">⚠️</div><div class="math-error-msg">${escapeHtml(error)}</div>`;
          renderedEl.classList.add('katex-error');
          renderedEl.classList.remove('rendered');
        } else {
          renderedEl.innerHTML = html;
          renderedEl.classList.add('rendered');
          renderedEl.classList.remove('katex-error');
        }
      };

      doRender(source);

      const tooltip = document.createElement('div');
      tooltip.className = 'math-block-tooltip';
      tooltip.textContent = 'Double-click to edit';
      tooltip.style.display = 'none';
      tooltip.setAttribute('role', 'tooltip');

      container.append(renderedEl, tooltip);

      const selectNode = () => {
        if (typeof getPos !== 'function') return;
        const pos = getPos();
        if (typeof pos !== 'number') return;
        try {
          editor.chain().setNodeSelection(pos).run();
        } catch {
          // ignore
        }
      };

      let highlighted = false;
      container.addEventListener('mousedown', selectNode);
      container.addEventListener('click', () => {
        selectNode();
        if (!highlighted) {
          container.classList.add('highlighted');
          tooltip.style.display = 'block';
          highlighted = true;
        }
      });

      container.addEventListener('dblclick', () => {
        highlighted = false;
        container.classList.remove('highlighted');
        tooltip.style.display = 'none';

        renderedEl.style.display = 'none';

        const textarea = document.createElement('textarea');
        textarea.className = 'math-block-editor';
        textarea.value = source;
        textarea.rows = Math.min(10, Math.max(2, source.split('\n').length));
        textarea.spellcheck = false;

        container.insertBefore(textarea, tooltip);
        textarea.focus();
        textarea.select();

        const finish = (save: boolean) => {
          const newSource = save ? textarea.value : source;
          textarea.remove();
          renderedEl.style.display = '';

          if (save && newSource !== source) {
            const pos = getPos?.();
            if (typeof pos === 'number') {
              const newNode = node.type.create(node.attrs, editor.schema.text(newSource));
              editor.view.dispatch(
                editor.state.tr.replaceWith(pos, pos + node.nodeSize, newNode)
              );
            }
          }
        };

        textarea.addEventListener('blur', () => finish(true));
        textarea.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            finish(true);
          }
        });
      });

      const handleDocClick = (e: MouseEvent) => {
        if (!container.contains(e.target as HTMLElement) && highlighted) {
          container.classList.remove('highlighted');
          tooltip.style.display = 'none';
          highlighted = false;
        }
      };
      document.addEventListener('click', handleDocClick);

      return {
        dom: container,
        update: (updatedNode) => {
          if (updatedNode.type.name !== 'mathBlock') return false;
          const newSource = updatedNode.textContent || '';
          if (newSource !== source) {
            source = newSource;
            container.setAttribute('data-latex', source);
            doRender(source);
          }
          return true;
        },
        destroy: () => {
          document.removeEventListener('click', handleDocClick);
        },
      };
    };
  },
});

// ─── MathInline ─────────────────────────────────────────────────────────────

export const MathInline = Node.create({
  name: 'mathInline',

  group: 'inline',

  inline: true,

  atom: true,

  selectable: true,

  marks: '',

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-latex') || element.textContent || '',
        renderHTML: (attributes) => ({
          'data-latex': attributes.latex,
        }),
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'math-inline' },
      { tag: 'span[data-type="mathInline"]' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-type': 'mathInline', class: 'math-inline-container' }),
      0,
    ];
  },

  renderMarkdown(node, _helpers, _ctx) {
    const latex = node.attrs?.latex || (node.content?.[0]?.text as string) || '';
    return `$${latex}$`;
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const container = document.createElement('span');
      container.className = 'math-inline-container';

      const renderedEl = document.createElement('span');
      renderedEl.className = 'math-inline-rendered';

      let source = (node.attrs.latex as string) || node.textContent || '';

      const doRender = (latex: string) => {
        if (!latex.trim()) {
          renderedEl.innerHTML = '';
          return;
        }
        const { html, error } = tryRenderKatex(latex, false);
        if (error) {
          renderedEl.innerHTML = `<span class="math-inline-error" title="${escapeAttr(error)}">⚠️</span>`;
        } else {
          renderedEl.innerHTML = html;
        }
      };

      doRender(source);

      container.appendChild(renderedEl);

      container.addEventListener('dblclick', () => {
        const currentSource = (node.attrs.latex as string) || node.textContent || '';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'math-inline-editor';
        input.value = currentSource;
        input.spellcheck = false;

        renderedEl.style.display = 'none';
        container.appendChild(input);
        input.focus();
        input.select();

        const finish = (save: boolean) => {
          const newSource = save ? input.value : currentSource;
          input.remove();
          renderedEl.style.display = '';

          if (save && newSource !== currentSource) {
            const pos = getPos?.();
            if (typeof pos === 'number') {
              const newNode = node.type.create({ latex: newSource }, editor.schema.text(newSource));
              editor.view.dispatch(
                editor.state.tr.replaceWith(pos, pos + node.nodeSize, newNode)
              );
            }
          }
        };

        input.addEventListener('blur', () => finish(true));
        input.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        });
      });

      return {
        dom: container,
        update: (updatedNode) => {
          if (updatedNode.type.name !== 'mathInline') return false;
          const newSource =
            (updatedNode.attrs.latex as string) || updatedNode.textContent || '';
          if (newSource !== source) {
            source = newSource;
            doRender(source);
          }
          return true;
        },
      };
    };
  },

  /**
   * ProseMirror plugin: after every transaction, scan text nodes for $...$
   * patterns and replace them with mathInline nodes.
   */
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('mathInlineDetection'),
        appendTransaction: (_transactions, _oldState, newState) => {
          const { doc, schema } = newState;
          const mathInlineType = schema.nodes.mathInline;
          if (!mathInlineType) return;

          const replacements: { from: number; to: number; latex: string }[] = [];

          doc.descendants((child, pos) => {
            if (!child.isText) return;
            const text = child.text || '';
            if (text.indexOf('$') === -1) return;

            // Skip text with marks (links, bold, etc.) to avoid breaking
            // link text like [$formula$](url). Use LaTeX commands for
            // formatting inside math instead.
            if (child.marks.length > 0) return;

            const parent = doc.resolve(pos).parent;
            const parentType = parent.type.name;
            if (
              parentType === 'codeBlock' ||
              parentType === 'mathBlock' ||
              parentType === 'mathInline'
            ) {
              return;
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let match: any;
            const regex = new RegExp(INLINE_MATH_RE.source, 'g');
            while ((match = regex.exec(text)) !== null) {
              if (match.index > 0 && text[match.index - 1] === '\\') continue;
              replacements.push({
                from: pos + match.index,
                to: pos + match.index + match[0].length,
                latex: match[1],
              });
            }
          });

          if (replacements.length === 0) return;

          const tr = newState.tr;
          for (let i = replacements.length - 1; i >= 0; i--) {
            const r = replacements[i];
            const mathNode = mathInlineType.create({ latex: r.latex }, schema.text(r.latex));
            tr.replaceWith(r.from, r.to, mathNode);
          }
          return tr;
        },
      }),
    ];
  },
});

// ─── Utility ────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(text: string): string {
  return text.replace(/"/g, '&quot;');
}
