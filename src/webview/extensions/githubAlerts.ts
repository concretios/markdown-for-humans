/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import type {
  JSONContent,
  MarkdownRendererHelpers,
  RenderContext,
  MarkdownToken,
  MarkdownParseHelpers,
} from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Fragment } from '@tiptap/pm/model';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    githubAlerts: {
      /**
       * Toggle a GitHub alert
       */
      toggleAlert: (type: AlertType) => ReturnType;
    };
  }
}

export type AlertType = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION';

export const GitHubAlerts = Node.create({
  name: 'githubAlert',

  priority: 110, // Higher than blockquote (100)

  group: 'block',

  content: 'block+',

  defining: true,

  isolating: false,

  atom: false,

  addAttributes() {
    return {
      alertType: {
        default: null,
        parseHTML: element => {
          const type = element.getAttribute('data-alert-type');
          const validTypes: AlertType[] = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'];
          return validTypes.includes(type as AlertType) ? type : null;
        },
        renderHTML: attributes => ({
          'data-alert-type': attributes.alertType,
        }),
      },
    };
  },

  addCommands() {
    return {
      toggleAlert:
        (alertType: AlertType) =>
        ({ commands, editor }) => {
          if (editor.isActive('githubAlert', { alertType })) {
            return commands.lift('githubAlert');
          }

          if (editor.isActive('githubAlert')) {
            return commands.updateAttributes('githubAlert', { alertType });
          }

          return commands.wrapIn('githubAlert', { alertType });
        },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'blockquote[data-alert-type]',
        priority: 100,
        getAttrs: (element: HTMLElement) => {
          const alertType = element.getAttribute('data-alert-type');
          const validTypes: AlertType[] = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'];
          if (alertType && validTypes.includes(alertType as AlertType)) {
            return { alertType };
          }
          return false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    const alertType = node.attrs.alertType as string | null;
    if (!alertType) {
      return ['blockquote', HTMLAttributes, 0];
    }
    return [
      'blockquote',
      mergeAttributes(HTMLAttributes, {
        'data-alert-type': alertType,
        class: `github-alert github-alert-${alertType.toLowerCase()}`,
      }),
      0,
    ];
  },

  markdownTokenName: 'blockquote',

  parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
    if (token.type !== 'blockquote') {
      return [];
    }

    // Check if first line contains [!TYPE] pattern
    const text = token.text ?? '';
    const lines = text.split('\n');
    const firstLine = lines[0]?.trim() || '';

    // Match [!TYPE] pattern (case insensitive)
    const alertMatch = firstLine.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i);
    if (!alertMatch) {
      return []; // Not an alert, let default blockquote handle it
    }

    const alertType = alertMatch[1].toUpperCase() as AlertType;
    const validTypes: AlertType[] = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'];
    if (!validTypes.includes(alertType)) {
      return [];
    }

    // Get child tokens (paragraphs, etc.)
    const childTokens = Array.isArray((token as any).tokens)
      ? JSON.parse(JSON.stringify((token as any).tokens))
      : [];

    // Remove the alert marker from the first paragraph if present
    if (
      childTokens.length > 0 &&
      childTokens[0].type === 'paragraph' &&
      Array.isArray((childTokens[0] as any).tokens)
    ) {
      const paragraphTokens = (childTokens[0] as any).tokens as any[];
      const firstInline = paragraphTokens[0];
      if (firstInline && firstInline.type === 'text') {
        const trimmed = (firstInline.text ?? '').trim();
        const markerMatch = trimmed.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i);
        if (markerMatch) {
          // Remove the marker from the text
          const remainingText = trimmed.replace(/^\[![^\]]+\]\s*/, '').trim();
          if (remainingText) {
            paragraphTokens[0] = { ...firstInline, text: remainingText };
          } else {
            // Remove the text node if empty after marker removal
            paragraphTokens.shift();
            // Clean up leading newline if present
            if (
              paragraphTokens[0]?.type === 'text' &&
              typeof paragraphTokens[0].text === 'string'
            ) {
              paragraphTokens[0].text = paragraphTokens[0].text.replace(/^\n/, '');
            }
          }
        }
      }
    }

    // Parse children tokens
    const parsedChildren =
      typeof helpers.parseChildren === 'function' ? helpers.parseChildren(childTokens) : [];

    // Clean up empty paragraphs and leading whitespace
    const contentNodes = parsedChildren
      .map(child => {
        if (child.type !== 'paragraph' || !Array.isArray(child.content)) {
          return child;
        }

        // Remove leading hard breaks and empty text
        const trimmedContent = [...child.content];
        while (trimmedContent.length > 0) {
          const first = trimmedContent[0];
          const isHardBreak = first.type === 'hardBreak' || first.type === 'hard_break';
          const isEmptyText =
            first.type === 'text' && typeof first.text === 'string' && first.text.trim() === '';
          if (isHardBreak || isEmptyText) {
            trimmedContent.shift();
            continue;
          }
          break;
        }

        return {
          ...child,
          content: trimmedContent,
        };
      })
      .filter(child => {
        if (child.type !== 'paragraph') {
          return true;
        }
        // Keep paragraph only if it has meaningful content
        const hasMeaningfulText =
          Array.isArray(child.content) &&
          child.content.some(
            n => n.type !== 'text' || (typeof n.text === 'string' && n.text.trim() !== '')
          );
        return hasMeaningfulText;
      });

    // Ensure we have at least one paragraph
    const children =
      contentNodes.length > 0 ? contentNodes : [helpers.createNode('paragraph', {}, [])];

    // Create githubAlert node
    return helpers.createNode('githubAlert', { alertType }, children);
  },

  renderMarkdown: ((
    node: JSONContent,
    helpers: MarkdownRendererHelpers,
    _context: RenderContext
  ) => {
    // Handle githubAlert nodes
    if (node.type === 'githubAlert') {
      const alertType = (node.attrs?.alertType as string) || 'NOTE';
      const body = helpers.renderChildren(node.content || [], '\n').trim();

      if (body) {
        const lines = body.split('\n');
        const formattedLines = lines.map(line => `> ${line}`).join('\n');
        return `> [!${alertType}]\n${formattedLines}`;
      }

      return `> [!${alertType}]\n> `;
    }

    // Handle regular blockquote nodes - delegate to default blockquote rendering
    if (node.type === 'blockquote') {
      const body = helpers.renderChildren(node.content || [], '\n').trim();
      if (body) {
        const lines = body.split('\n');
        const formattedLines = lines.map(line => `> ${line}`).join('\n');
        return formattedLines;
      }
      return '> ';
    }

    // Return null for other node types to let other extensions handle them
    return null;
  }) as unknown as (
    node: JSONContent,
    helpers: MarkdownRendererHelpers,
    ctx: RenderContext
  ) => string,

  addProseMirrorPlugins() {
    const githubAlertType = this.type;
    const blockquoteType = this.editor.schema.nodes.blockquote;

    return [
      new Plugin({
        key: new PluginKey('githubAlertsConverter'),
        appendTransaction: (transactions, _oldState, newState) => {
          const hasContentChanges = transactions.some(tr => tr.steps.length > 0 && tr.docChanged);

          if (!hasContentChanges) {
            return null;
          }

          // Skip during active user typing
          const isUserTyping = transactions.some(tr => {
            const uiEvent = tr.getMeta('uiEvent');
            return uiEvent === 'input' || uiEvent === 'delete';
          });

          if (isUserTyping) {
            return null;
          }

          const tr = newState.tr;

          let modified = false;

          // CRITICAL FIX: Process nodes in REVERSE order (from end to start)
          // This ensures position offsets remain valid after each replacement
          const nodesToConvert: Array<{ pos: number; node: any; alertType: AlertType }> = [];

          newState.doc.descendants((node, pos) => {
            if (node.type === githubAlertType) {
              return true; // Skip existing alerts
            }

            if (node.type === blockquoteType) {
              const text = node.textContent;

              if (!text || !text.includes('[!')) {
                return true;
              }

              const firstLine = text.split('\n')[0]?.trim() || '';
              const alertMatch = firstLine.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i);

              if (!alertMatch) {
                return true;
              }

              const alertType = alertMatch[1].toUpperCase() as AlertType;
              const validTypes: AlertType[] = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'];

              if (!validTypes.includes(alertType)) {
                return true;
              }

              nodesToConvert.push({ pos, node, alertType });
            }

            return true;
          });

          // CRITICAL: Process in reverse order to maintain valid positions
          nodesToConvert.reverse().forEach(({ pos, node, alertType }) => {
            const content = node.content;

            let newContent = content;

            if (content.childCount > 0 && content.firstChild?.type.name === 'paragraph') {
              const firstParagraph = content.firstChild;
              const firstParagraphText = firstParagraph.textContent;
              const markerRemoved = firstParagraphText.replace(/^\[![^\]]+\]\s*\n?/, '').trim();

              const paragraphType = this.editor.schema.nodes.paragraph;
              const textType = this.editor.schema.text;

              const newNodes = [];

              if (markerRemoved) {
                const newParagraph = paragraphType.create(
                  firstParagraph.attrs,
                  textType(markerRemoved)
                );
                newNodes.push(newParagraph);
              }

              for (let i = 1; i < content.childCount; i++) {
                newNodes.push(content.child(i));
              }

              if (newNodes.length === 0) {
                newNodes.push(paragraphType.create());
              }

              newContent = Fragment.from(newNodes);
            }

            const githubAlertNode = githubAlertType.create({ alertType }, newContent);

            tr.replaceWith(pos, pos + node.nodeSize, githubAlertNode);
            modified = true;
          });

          return modified ? tr : null;
        },
      }),
    ];
  },

  addNodeView() {
    return ({ node, HTMLAttributes: _HTMLAttributes }) => {
      const alertType = node.attrs.alertType as string | null;

      if (!alertType) {
        const container = document.createElement('blockquote');
        const content = document.createElement('div');
        container.appendChild(content);
        return {
          dom: container,
          contentDOM: content,
        };
      }

      const alertTypeLower = alertType.toLowerCase();

      const container = document.createElement('blockquote');
      container.className = `github-alert github-alert-${alertTypeLower}`;
      container.setAttribute('data-alert-type', alertType);

      const header = document.createElement('div');
      header.className = 'github-alert-header';
      header.contentEditable = 'false';

      const icon = document.createElement('span');
      icon.className = 'github-alert-icon';
      icon.setAttribute('aria-hidden', 'true');

      const label = document.createElement('strong');
      label.className = 'github-alert-label';
      label.textContent = alertType;

      header.appendChild(icon);
      header.appendChild(label);

      const content = document.createElement('div');
      content.className = 'github-alert-content';

      container.appendChild(header);
      container.appendChild(content);

      return {
        dom: container,
        contentDOM: content,
        update: updatedNode => {
          if (updatedNode.type.name !== 'githubAlert') {
            return false;
          }

          const newAlertType = updatedNode.attrs.alertType as string | null;
          if (!newAlertType) {
            return false;
          }

          const newAlertTypeLower = newAlertType.toLowerCase();

          if (newAlertType !== alertType) {
            container.className = `github-alert github-alert-${newAlertTypeLower}`;
            container.setAttribute('data-alert-type', newAlertType);
            label.textContent = newAlertType;
          }

          return true;
        },
        ignoreMutation: mutation => {
          if (!content.contains(mutation.target) && mutation.target !== content) {
            return true;
          }
          return false;
        },
      };
    };
  },
});
