/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import mermaid from 'mermaid';

/**
 * Detect if VS Code is in dark mode by checking CSS variables
 */
function isDarkMode(): boolean {
  const bg = getComputedStyle(document.documentElement)
    .getPropertyValue('--vscode-editor-background')
    .trim();
  if (!bg) return false;

  // Parse the color and check luminance
  const hex = bg.replace('#', '');
  if (hex.length >= 6) {
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance < 0.5;
  }
  return false;
}

/**
 * Initialize mermaid with theme based on VS Code theme
 */
function initializeMermaid() {
  const theme = isDarkMode() ? 'dark' : 'default';
  mermaid.initialize({
    startOnLoad: false,
    theme,
    securityLevel: 'strict', // Safer for VS Code webview
    fontFamily: 'inherit',
  });
}

// Initialize on load
initializeMermaid();

export const Mermaid = Node.create({
  name: 'mermaid',

  // Higher priority than CodeBlockLowlight (default 100) to parse mermaid blocks first
  priority: 200,

  group: 'block',

  content: 'text*',

  marks: '',

  code: true,

  defining: true,

  isolating: true,

  addAttributes() {
    return {
      language: {
        default: 'mermaid',
        parseHTML: element => element.getAttribute('data-language'),
        renderHTML: attributes => ({
          'data-language': attributes.language,
        }),
      },
    };
  },

  parseHTML() {
    return [
      // Match our own rendered output
      {
        tag: 'pre[data-language="mermaid"]',
        preserveWhitespace: 'full',
      },
      // Match markdown-generated code blocks: <pre><code class="language-mermaid">
      {
        tag: 'pre',
        preserveWhitespace: 'full',
        getAttrs: (element: HTMLElement) => {
          const code = element.querySelector('code');
          if (!code) return false;
          // Check for language-mermaid class
          if (code.classList.contains('language-mermaid')) return {};
          // Check data-language attribute
          if (code.getAttribute('data-language') === 'mermaid') return {};
          return false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'pre',
      mergeAttributes(HTMLAttributes, { 'data-language': 'mermaid', class: 'mermaid-diagram' }),
      ['code', { class: 'language-mermaid' }, 0],
    ];
  },

  markdownTokenName: 'code',

  parseMarkdown: (token, helpers) => {
    const language = (token.lang || '').toLowerCase();
    // Note: marked.js 15.x only sets codeBlockStyle for indented blocks, not fenced
    const isMermaidFence =
      token.type === 'code' &&
      token.codeBlockStyle !== 'indented' &&
      (language === 'mermaid' || token.raw?.startsWith('```mermaid'));

    if (!isMermaidFence) {
      return [];
    }

    const text = token.text ?? '';
    const content = text ? [helpers.createTextNode(text)] : [];

    return helpers.createNode(
      'mermaid',
      {
        language: 'mermaid',
      },
      content
    );
  },

  renderMarkdown: (node, helpers) => {
    const language = (node.attrs?.language as string) || 'mermaid';
    const body = helpers.renderChildren(node.content || [], '\n').replace(/\s+$/, '');
    const content = body.length > 0 ? body : '';
    return `\`\`\`${language}\n${content}\n\`\`\``;
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const container = document.createElement('div');
      container.classList.add('mermaid-wrapper');

      const codeElement = document.createElement('pre');
      codeElement.classList.add('mermaid-source');
      codeElement.textContent = node.textContent;

      const renderElement = document.createElement('div');
      renderElement.classList.add('mermaid-render');

      const zoomButton = document.createElement('button');
      zoomButton.type = 'button';
      zoomButton.classList.add('mermaid-zoom-btn');
      zoomButton.title = 'Open diagram in full screen';
      zoomButton.setAttribute('aria-label', 'Open diagram in full screen');
      zoomButton.innerHTML = '<span class="codicon codicon-zoom-in"></span>';
      zoomButton.hidden = true;

      container.append(codeElement);
      container.appendChild(renderElement);
      container.appendChild(zoomButton);

      // Render mermaid diagram
      const renderDiagram = async () => {
        const content = codeElement.textContent?.trim() || '';
        if (!content) {
          renderElement.innerHTML =
            '<div class="mermaid-placeholder">Enter Mermaid diagram code</div>';
          zoomButton.hidden = true;
          return;
        }

        try {
          const theme = isDarkMode() ? 'dark' : 'default';
          mermaid.initialize({
            startOnLoad: false,
            theme,
            securityLevel: 'strict',
            fontFamily: 'inherit',
          });
          // Clear previous content to prevent duplicates
          renderElement.innerHTML = '';

          // Use timestamp to ensure truly unique IDs and prevent caching
          const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
          const { svg } = await mermaid.render(id, content);
          renderElement.innerHTML = svg;
          renderElement.classList.add('rendered');
          codeElement.classList.add('hidden');
          zoomButton.hidden = false;
        } catch (error) {
          console.error('Mermaid rendering error:', error);
          const errorMsg = error instanceof Error ? error.message : 'Invalid diagram syntax';
          renderElement.textContent = '';
          const errorDiv = document.createElement('div');
          errorDiv.className = 'mermaid-error';
          errorDiv.textContent = `Diagram Error: ${errorMsg}`;
          renderElement.appendChild(errorDiv);
          renderElement.classList.remove('rendered');
          codeElement.classList.remove('hidden');
          zoomButton.hidden = true;
        }
      };

      renderDiagram();

      // Create tooltip element
      const tooltip = document.createElement('div');
      tooltip.classList.add('mermaid-tooltip');
      tooltip.setAttribute('role', 'tooltip');
      tooltip.setAttribute('id', `mermaid-tooltip-${Math.random().toString(36).slice(2, 11)}`);
      tooltip.textContent = 'Double-click to edit';
      tooltip.style.display = 'none';
      container.appendChild(tooltip);

      // State management
      let isHighlighted = false;

      // Helper: Remove highlight state
      const removeHighlight = () => {
        container.classList.remove('highlighted');
        tooltip.style.display = 'none';
        isHighlighted = false;
      };

      // Helper: Show modal editor
      const showEditor = async () => {
        const { showMermaidEditor } = await import('../features/mermaidEditor');
        // Use codeElement.textContent to get the current (possibly edited) content
        const result = await showMermaidEditor(codeElement.textContent || '');

        if (result.wasSaved && getPos) {
          // Update the TipTap node via transaction
          const pos = getPos();
          if (typeof pos !== 'number') return; // Type guard

          const { tr } = editor.state;

          // Create new mermaid node with updated text content
          const newNode = node.type.create(node.attrs, editor.schema.text(result.code));

          // Replace the old node with the new one
          tr.replaceWith(pos, pos + node.nodeSize, newNode);

          editor.view.dispatch(tr);

          // Also update local DOM for immediate  visual feedback
          codeElement.textContent = result.code;
          renderDiagram();
        }
      };

      // The wrapper turns mousedown into a node selection and dblclick into the
      // code editor; the zoom button must trigger neither.
      zoomButton.addEventListener('mousedown', event => event.stopPropagation());
      zoomButton.addEventListener('dblclick', event => event.stopPropagation());
      zoomButton.addEventListener('click', async event => {
        event.stopPropagation();
        try {
          const { showMermaidLightbox } = await import('../features/mermaidLightbox');
          showMermaidLightbox(renderElement.innerHTML);
        } catch (error) {
          // Non-critical: the diagram stays readable inline, so log rather than interrupt.
          console.error('[MD4H] Failed to open mermaid lightbox:', error);
        }
      });

      // Helper: select this mermaid node in ProseMirror so copy / cut /
      // backspace / delete behave correctly. Without a NodeSelection on the
      // node, the editor's selection is empty when the user clicks the
      // diagram, which is why Cmd+C / Cmd+X / Delete were all no-ops.
      const selectNodeInEditor = () => {
        if (typeof getPos !== 'function') return;
        const pos = getPos();
        if (typeof pos !== 'number') return;
        try {
          editor.chain().setNodeSelection(pos).run();
        } catch (err) {
          console.warn('[MD4H] Failed to set mermaid node selection:', err);
        }
      };

      // Use mousedown — ProseMirror itself dispatches selections on
      // mousedown, so we want to run before any default click handling.
      // We do NOT preventDefault: let ProseMirror manage focus / caret as
      // usual, we just ensure the node is the active selection afterwards.
      container.addEventListener('mousedown', event => {
        // Don't hijack interaction with anchor links inside the rendered
        // SVG (mermaid click events on nodes/links).
        const target = event.target as HTMLElement | null;
        if (target?.closest('a[href]')) return;
        selectNodeInEditor();
      });

      // Single-click: visual highlight + tooltip. Selection has already
      // been set by mousedown above, so copy/cut/delete now work.
      container.addEventListener('click', () => {
        selectNodeInEditor();
        if (!isHighlighted) {
          container.classList.add('highlighted');
          tooltip.style.display = 'block';
          container.setAttribute('aria-describedby', tooltip.id);
          isHighlighted = true;
        }
      });

      // Double-click: Open modal editor
      container.addEventListener('dblclick', () => {
        removeHighlight();
        showEditor();
      });

      // Click outside: Remove highlight
      // Store reference for cleanup on destroy
      const handleDocumentClick = (e: MouseEvent) => {
        if (!container.contains(e.target as HTMLElement) && isHighlighted) {
          removeHighlight();
        }
      };
      document.addEventListener('click', handleDocumentClick);

      return {
        dom: container,
        update: updatedNode => {
          if (updatedNode.type.name !== 'mermaid') return false;
          codeElement.textContent = updatedNode.textContent;
          renderDiagram();
          return true;
        },
        destroy: () => {
          // Clean up document listener to prevent memory leaks
          document.removeEventListener('click', handleDocumentClick);
        },
      };
    };
  },
});
