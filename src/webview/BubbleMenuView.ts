/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Toolbar and menu components for the WYSIWYG markdown editor.
 * Provides:
 * - Compact formatting toolbar with Codicon icons
 * - Table context menu for row/column operations
 * - Dropdown menus for headings, code blocks, and diagrams
 *
 * @module BubbleMenuView
 */

import { MERMAID_TEMPLATES } from './mermaidTemplates';
import { showTableInsertDialog } from './features/tableInsert';
import { showLinkDialog } from './features/linkDialog';
import { showImageInsertDialog } from './features/imageInsertDialog';
import type { Editor } from '@tiptap/core';
import { getSelectedTableLines } from './utils/tableSelectionUtils';

// Store reference to refresh function so it can be called externally
let toolbarRefreshFunction: (() => void) | null = null;

/**
 * Normalize selection and create a code block
 *
 * Strips all formatting (marks) from the selection, extracts plain text,
 * and replaces it with a single code block node.
 *
 * @param editor - TipTap editor instance
 * @param language - Programming language for syntax highlighting
 */
function setCodeBlockNormalized(editor: Editor, language: string): void {
  const { state } = editor;
  const { from, to, empty } = state.selection;

  // If already in a code block, just update the language
  if (editor.isActive('codeBlock')) {
    editor.chain().focus().updateAttributes('codeBlock', { language }).run();
    return;
  }

  // For empty selection, insert an empty code block and position cursor inside it
  if (empty) {
    // Use setCodeBlock which properly creates a code block and positions cursor inside
    // This ensures editor.isActive('codeBlock') returns true immediately after
    editor.chain().focus().setCodeBlock({ language }).run();
    return;
  }

  // Extract plain text from selection (strips all marks)
  // Use empty string as block separator to keep content on same line within selection
  const plainText = state.doc.textBetween(from, to, '\n');

  // Replace selection with a single code block containing the plain text
  editor
    .chain()
    .focus()
    .deleteRange({ from, to })
    .insertContent({
      type: 'codeBlock',
      attrs: { language },
      content: plainText
        ? [
            {
              type: 'text',
              text: plainText,
            },
          ]
        : undefined,
    })
    .run();
}

// Track editor focus state
let isEditorFocused = false;
let focusChangeListener: ((e: Event) => void) | null = null;

type ToolbarIcon = {
  name?: string;
  fallback: string;
  badge?: string;
};

type ToolbarActionButton = {
  type: 'button';
  label: string;
  title?: string;
  action: () => void;
  isActive?: () => boolean;
  isEnabled?: () => boolean;
  className?: string;
  icon: ToolbarIcon;
  requiresFocus?: boolean; // Whether this button requires editor focus to be enabled
};

type ToolbarDropdownItem = {
  label: string;
  action: () => void;
  icon?: ToolbarIcon;
  isEnabled?: () => boolean; // Function to check if item should be enabled
};

type ToolbarDropdown = {
  type: 'dropdown';
  label: string;
  title?: string;
  className?: string;
  icon: ToolbarIcon;
  items: ToolbarDropdownItem[];
  requiresFocus?: boolean; // Whether this dropdown requires editor focus to be enabled
  isActive?: () => boolean; // Function to determine if dropdown should appear active
  isEnabled?: () => boolean;
};

type ToolbarSeparator = { type: 'separator' };

type ToolbarItem = ToolbarActionButton | ToolbarDropdown | ToolbarSeparator;

let codiconCheckScheduled = false;

function ensureCodiconFont() {
  if (codiconCheckScheduled) return;
  codiconCheckScheduled = true;

  if (!('fonts' in document) || typeof document.fonts?.load !== 'function') {
    document.documentElement.classList.add('codicon-fallback');
    return;
  }

  document.fonts
    .load('16px "codicon"')
    .then(() => {
      const available = document.fonts.check('16px "codicon"');
      if (!available) {
        document.documentElement.classList.add('codicon-fallback');
      } else {
        document.documentElement.classList.remove('codicon-fallback');
      }
    })
    .catch(() => {
      document.documentElement.classList.add('codicon-fallback');
    });
}

function createIconElement(icon: ToolbarIcon | undefined, baseClass: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = baseClass;
  span.setAttribute('aria-hidden', 'true');

  if (!icon) return span;

  if (icon.name) {
    span.classList.add('codicon', `codicon-${icon.name}`, 'uses-codicon');
  } else if (icon.fallback) {
    span.textContent = icon.fallback;
  }

  if (icon.fallback) {
    span.setAttribute('data-fallback', icon.fallback);
    if (!icon.name) {
      span.textContent = icon.fallback;
    }
  }

  if (icon.badge) {
    span.classList.add('heading-icon');
    span.setAttribute('data-badge', icon.badge);
  }

  return span;
}

function closeAllDropdowns() {
  document.querySelectorAll('.toolbar-dropdown-menu').forEach(menu => {
    (menu as HTMLElement).style.display = 'none';
  });

  document.querySelectorAll('.toolbar-dropdown button[aria-expanded="true"]').forEach(btn => {
    (btn as HTMLElement).setAttribute('aria-expanded', 'false');
  });
}

/**
 * Update toolbar active states (can be called from outside)
 */
export function updateToolbarStates() {
  if (toolbarRefreshFunction) {
    toolbarRefreshFunction();
  }
}

/**
 * Custom table bullet toggler that adds "- " after every hardBreak in the cell.
 */
function toggleTableBullet(editor: Editor) {
  const { state, dispatch } = editor.view;
  const result = getSelectedTableLines(state, state.selection);
  if (!result) return;
  const { selectedLines, tr } = result;

  const lineStarts = selectedLines.map(l => l.start);

  let allHaveBullet = true;
  for (const pos of lineStarts) {
    const nextNode = tr.doc.nodeAt(pos);
    if (nextNode && nextNode.isText) {
      if (!nextNode.text?.startsWith('- ')) {
        allHaveBullet = false;
        break;
      }
    } else {
      allHaveBullet = false;
      break;
    }
  }

  if (lineStarts.length === 1) {
    const nextNode = tr.doc.nodeAt(lineStarts[0]);
    if (!nextNode) {
      allHaveBullet = false;
    }
  }

  const originalFrom = state.selection.from;
  const originalTo = state.selection.to;
  const isEmpty = state.selection.empty;

  for (let i = lineStarts.length - 1; i >= 0; i--) {
    const pos = lineStarts[i];
    if (allHaveBullet) {
      const nextNode = tr.doc.nodeAt(pos);
      if (nextNode && nextNode.isText && nextNode.text?.startsWith('- ')) {
        tr.delete(pos, pos + 2);
      }
    } else {
      const nextNode = tr.doc.nodeAt(pos);
      if (!nextNode || (nextNode.isText && !nextNode.text?.startsWith('- '))) {
        tr.insertText('- ', pos);
      } else if (nextNode && !nextNode.isText) {
        tr.insertText('- ', pos);
      }
    }
  }

  dispatch(tr);

  // Remap original selection to keep exactly what the user selected, shifted by the bullet insertions
  if (!isEmpty) {
    const newFrom = tr.mapping.map(originalFrom, -1);
    const newTo = tr.mapping.map(originalTo, 1);

    // Check if newTo is valid
    if (newTo > newFrom) {
      editor.chain().setTextSelection({ from: newFrom, to: newTo }).focus().run();
    } else {
      editor.chain().focus().run();
    }
  } else {
    editor.chain().focus().run();
  }
}

function isTableBulletActive(editor: Editor): boolean {
  if (!editor.isActive('table')) return false;

  const { state } = editor;
  const result = getSelectedTableLines(state, state.selection);
  if (!result) return false;
  const { selectedLines, tr } = result;

  const lineStarts = selectedLines.map(l => l.start);

  if (lineStarts.length === 1 && !tr.doc.nodeAt(lineStarts[0])) {
    return false; // Empty cell
  }

  for (const pos of lineStarts) {
    const nextNode = tr.doc.nodeAt(pos);
    if (!nextNode || !nextNode.isText || !nextNode.text?.startsWith('- ')) {
      return false;
    }
  }

  return true;
}

/**
 * Create compact formatting toolbar with clean, minimal design.
 *
 * @param editor - TipTap editor instance
 * @returns HTMLElement containing the toolbar
 */
export function createFormattingToolbar(editor: Editor): HTMLElement {
  ensureCodiconFont();

  const toolbar = document.createElement('div');
  toolbar.className = 'formatting-toolbar';

  const isMac = navigator.platform.toLowerCase().includes('mac');
  const modKeyLabel = isMac ? 'Cmd' : 'Ctrl';

  const buttons: ToolbarItem[] = [
    {
      type: 'button',
      label: 'Save',
      title: `Save document (${modKeyLabel}+S)`,
      icon: { name: 'save', fallback: 'Save' },
      action: () => {
        if ((window as any).saveDocument) {
          (window as any).saveDocument();
        }
      },
      isActive: () => false,
      isEnabled: () => !!(window as any).__docDirty,
      className: 'save-button',
      requiresFocus: false, // Can save even if editor lost focus
    },
    {
      type: 'separator',
    },
    {
      type: 'button',
      label: 'Bold',
      title: `Toggle bold (${modKeyLabel}+B)`,
      icon: { name: 'bold', fallback: 'B' },
      action: () => editor.chain().focus().toggleBold().run(),
      isActive: () => editor.isActive('bold'),
      className: 'bold',
      requiresFocus: true,
    },
    {
      type: 'button',
      label: 'Italic',
      title: `Toggle italic (${modKeyLabel}+I)`,
      icon: { name: 'italic', fallback: 'I' },
      action: () => editor.chain().focus().toggleItalic().run(),
      isActive: () => editor.isActive('italic'),
      className: 'italic',
      requiresFocus: true,
    },
    {
      type: 'button',
      label: 'Highlight',
      title: 'Toggle highlight',
      icon: { name: 'paintcan', fallback: 'Hl' },
      action: () => editor.chain().focus().toggleHighlight().run(),
      isActive: () => editor.isActive('highlight'),
      className: 'highlight-icon',
      requiresFocus: true,
    },
    {
      type: 'dropdown',
      label: 'Text Color',
      title: 'Choose text color',
      icon: { name: 'symbol-color', fallback: 'A' },
      requiresFocus: true,
      items: [
        { label: 'Default', action: () => editor.chain().focus().unsetColor().run() },
        { label: 'Red', action: () => editor.chain().focus().setColor('#e81123').run() },
        { label: 'Orange', action: () => editor.chain().focus().setColor('#ea5a00').run() },
        { label: 'Yellow', action: () => editor.chain().focus().setColor('#fce100').run() },
        { label: 'Green', action: () => editor.chain().focus().setColor('#107c10').run() },
        { label: 'Blue', action: () => editor.chain().focus().setColor('#0078d4').run() },
        { label: 'Purple', action: () => editor.chain().focus().setColor('#8e562e').run() },
        { label: 'Pink', action: () => editor.chain().focus().setColor('#c239b3').run() },
      ],
    },
    {
      type: 'button',
      label: 'Strikethrough',
      title: 'Toggle strikethrough',
      icon: { name: 'strikethrough', fallback: 'S' },
      action: () => editor.chain().focus().toggleStrike().run(),
      isActive: () => editor.isActive('strike'),
      className: 'strike',
      requiresFocus: true,
    },
    {
      type: 'button',
      label: 'Inline code',
      title: 'Toggle inline code',
      icon: { name: 'code', fallback: '<>' },
      action: () => editor.chain().focus().toggleCode().run(),
      isActive: () => editor.isActive('code'),
      className: 'code-icon',
      requiresFocus: true,
    },
    {
      type: 'button',
      label: 'Heading 1',
      title: 'Toggle Heading 1',
      icon: { fallback: 'H1' },
      action: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
      isActive: () => editor.isActive('heading', { level: 1 }),
      isEnabled: () => !editor.isActive('table'),
      requiresFocus: true,
    },
    {
      type: 'button',
      label: 'Heading 2',
      title: 'Toggle Heading 2',
      icon: { fallback: 'H2' },
      action: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
      isActive: () => editor.isActive('heading', { level: 2 }),
      isEnabled: () => !editor.isActive('table'),
      requiresFocus: true,
    },
    {
      type: 'button',
      label: 'Heading 3',
      title: 'Toggle Heading 3',
      icon: { fallback: 'H3' },
      action: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
      isActive: () => editor.isActive('heading', { level: 3 }),
      isEnabled: () => !editor.isActive('table'),
      requiresFocus: true,
    },
    {
      type: 'dropdown',
      label: 'More headings',
      title: 'More heading levels',
      icon: { name: 'text-size', fallback: 'H+' },
      requiresFocus: true,
      isEnabled: () => !editor.isActive('table'),
      items: [
        {
          label: 'Heading 4 (H4)',
          action: () => editor.chain().focus().toggleHeading({ level: 4 }).run(),
        },
        {
          label: 'Heading 5 (H5)',
          action: () => editor.chain().focus().toggleHeading({ level: 5 }).run(),
        },
        {
          label: 'Heading 6 (H6)',
          action: () => editor.chain().focus().toggleHeading({ level: 6 }).run(),
        },
      ],
    },
    { type: 'separator' },
    {
      type: 'button',
      label: 'Bullet list',
      title: 'Toggle bullet list',
      icon: { name: 'list-unordered', fallback: '•' },
      action: () => editor.chain().focus().toggleBulletList().run(),
      isActive: () => editor.isActive('bulletList'),
      isEnabled: () => !editor.isActive('table'),
      requiresFocus: true,
    },
    {
      type: 'button',
      label: 'Table Bullet',
      title: 'Toggle text bullet list in table cell',
      icon: { name: 'list-unordered', fallback: '•' },
      action: () => toggleTableBullet(editor),
      isActive: () => isTableBulletActive(editor),
      // This is a special button that ONLY shows up when inside a table
      isEnabled: () => editor.isActive('table'),
      requiresFocus: true,
    },
    {
      type: 'button',
      label: 'Numbered list',
      title: 'Toggle numbered list',
      icon: { name: 'list-ordered', fallback: '1.' },
      action: () => editor.chain().focus().toggleOrderedList().run(),
      isActive: () => editor.isActive('orderedList'),
      isEnabled: () => !editor.isActive('table'),
      requiresFocus: true,
    },
    {
      type: 'button',
      label: 'Task list',
      title: 'Toggle task list (checkboxes)',
      icon: { name: 'tasklist', fallback: '☐' },
      action: () => editor.chain().focus().toggleTaskList().run(),
      isActive: () => editor.isActive('taskList'),
      isEnabled: () => !editor.isActive('table'),
      requiresFocus: true,
    },
    { type: 'separator' },
    {
      type: 'dropdown',
      label: 'Table',
      title: 'Insert and edit table',
      icon: { name: 'table', fallback: 'Tbl' },
      requiresFocus: true,
      isActive: () => editor.isActive('table'),
      items: [
        {
          label: 'Insert Table',
          icon: { name: 'add', fallback: '+' },
          action: () => showTableInsertDialog(editor),
          isEnabled: () => !editor.isActive('table'), // Only enabled when NOT in a table
        },
        {
          label: 'Add Column Before',
          icon: { name: 'arrow-left', fallback: '←' },
          action: () => editor.chain().focus().addColumnBefore().run(),
          isEnabled: () => editor.isActive('table'), // Only enabled when in a table
        },
        {
          label: 'Add Column After',
          icon: { name: 'arrow-right', fallback: '→' },
          action: () => editor.chain().focus().addColumnAfter().run(),
          isEnabled: () => editor.isActive('table'),
        },
        {
          label: 'Delete Column',
          icon: { name: 'remove', fallback: '×' },
          action: () => editor.chain().focus().deleteColumn().run(),
          isEnabled: () => editor.isActive('table'),
        },
        {
          label: 'Add Row Before',
          icon: { name: 'arrow-up', fallback: '↑' },
          action: () => editor.chain().focus().addRowBefore().run(),
          isEnabled: () => editor.isActive('table'),
        },
        {
          label: 'Add Row After',
          icon: { name: 'arrow-down', fallback: '↓' },
          action: () => editor.chain().focus().addRowAfter().run(),
          isEnabled: () => editor.isActive('table'),
        },
        {
          label: 'Delete Row',
          icon: { name: 'trash', fallback: '–' },
          action: () => editor.chain().focus().deleteRow().run(),
          isEnabled: () => editor.isActive('table'),
        },
        {
          label: 'Delete Table',
          icon: { name: 'trash', fallback: '✕' },
          action: () => editor.chain().focus().deleteTable().run(),
          isEnabled: () => editor.isActive('table'),
        },
      ],
    },
    {
      type: 'button',
      label: 'Quote',
      title: 'Toggle block quote',
      icon: { name: 'quote', fallback: '"' },
      action: () => editor.chain().focus().toggleBlockquote().run(),
      isActive: () => editor.isActive('blockquote'),
      isEnabled: () => !editor.isActive('table'),
      requiresFocus: true,
    },
    {
      type: 'dropdown',
      label: 'Alert',
      title: 'Insert GitHub alert',
      icon: { name: 'info', fallback: '!' },
      requiresFocus: true,
      isActive: () => editor.isActive('githubAlert'),
      isEnabled: () => !editor.isActive('table'),
      items: [
        {
          label: ' Note',
          icon: { name: 'info', fallback: 'ℹ' },
          action: () => {
            editor.chain().focus().toggleAlert('NOTE').run();
          },
        },
        {
          label: ' Tip',
          icon: { name: 'lightbulb', fallback: '💡' },
          action: () => {
            editor.chain().focus().toggleAlert('TIP').run();
          },
        },
        {
          label: ' Important',
          icon: { name: 'megaphone', fallback: '📢' },
          action: () => {
            editor.chain().focus().toggleAlert('IMPORTANT').run();
          },
        },
        {
          label: ' Warning',
          icon: { name: 'warning', fallback: '⚠' },
          action: () => {
            editor.chain().focus().toggleAlert('WARNING').run();
          },
        },
        {
          label: ' Caution',
          icon: { name: 'error', fallback: '🛑' },
          action: () => {
            editor.chain().focus().toggleAlert('CAUTION').run();
          },
        },
        {
          label: ' No Alert',
          icon: { name: 'close', fallback: '×' },
          action: () => {
            editor.chain().focus().lift('githubAlert').run();
          },
        },
      ],
    },
    {
      type: 'dropdown',
      label: 'Code block',
      title: 'Insert code block',
      icon: { name: 'code', fallback: '{}' },
      requiresFocus: true,
      isActive: () => editor.isActive('codeBlock'),
      isEnabled: () => !editor.isActive('table'),
      items: [
        {
          label: 'Plain Text',
          action: () => setCodeBlockNormalized(editor, 'plaintext'),
        },
        {
          label: 'JavaScript',
          action: () => setCodeBlockNormalized(editor, 'javascript'),
        },
        {
          label: 'TypeScript',
          action: () => setCodeBlockNormalized(editor, 'typescript'),
        },
        {
          label: 'Python',
          action: () => setCodeBlockNormalized(editor, 'python'),
        },
        {
          label: 'Bash',
          action: () => setCodeBlockNormalized(editor, 'bash'),
        },
        {
          label: 'JSON',
          action: () => setCodeBlockNormalized(editor, 'json'),
        },
        {
          label: 'Markdown',
          action: () => setCodeBlockNormalized(editor, 'markdown'),
        },
        {
          label: 'CSS',
          action: () => setCodeBlockNormalized(editor, 'css'),
        },
        {
          label: 'HTML',
          action: () => setCodeBlockNormalized(editor, 'html'),
        },
        {
          label: 'SQL',
          action: () => setCodeBlockNormalized(editor, 'sql'),
        },
        {
          label: 'Java',
          action: () => setCodeBlockNormalized(editor, 'java'),
        },
        {
          label: 'Go',
          action: () => setCodeBlockNormalized(editor, 'go'),
        },
        {
          label: 'Rust',
          action: () => setCodeBlockNormalized(editor, 'rust'),
        },
      ],
    },
    {
      type: 'button',
      label: 'Link',
      title: `Insert/edit link (${modKeyLabel}+K)`,
      icon: { name: 'link', fallback: '🔗' },
      action: () => showLinkDialog(editor),
      isActive: () => editor.isActive('link'),
      requiresFocus: true,
    },
    {
      type: 'button',
      label: 'Image',
      title: 'Insert image',
      icon: { name: 'file-media', fallback: '📷' },
      action: () => {
        // Get vscode API from window (set in editor.ts)
        const vscodeApi = window.vscode;
        if (vscodeApi && editor) {
          showImageInsertDialog(editor, vscodeApi).catch(error => {
            console.error('[MD4H] Failed to show image insert dialog:', error);
          });
        } else {
          console.warn(
            '[MD4H] Cannot show image insert dialog: vscode API or editor not available'
          );
        }
      },
      requiresFocus: false, // Can insert images even when not focused
    },
    {
      type: 'dropdown',
      label: 'Mermaid',
      title: 'Insert Mermaid diagram',
      icon: { name: 'pie-chart', fallback: 'Mer' },
      requiresFocus: true,
      isEnabled: () => !editor.isActive('table'),
      items: MERMAID_TEMPLATES.map(template => ({
        label: template.label,
        action: () => {
          editor
            .chain()
            .focus()
            .insertContent(`\`\`\`mermaid\n${template.diagram}\n\`\`\``, {
              contentType: 'markdown',
            })
            .run();
        },
      })),
    },
    { type: 'separator' },
    {
      type: 'button',
      label: 'Outline',
      title: 'Toggle Document Outline (TOC)',
      icon: { name: 'list-tree', fallback: 'TOC' },
      action: () => {
        window.dispatchEvent(new CustomEvent('toggleTocOutline'));
      },
      isActive: () => false,
      className: 'toc-button',
    },
    {
      type: 'button',
      label: 'Source',
      title: 'Open source view (split)',
      icon: { name: 'split-horizontal', fallback: '</>' },
      action: () => {
        window.dispatchEvent(new CustomEvent('openSourceView'));
      },
      isActive: () => false,
      className: 'source-button',
    },
    { type: 'separator' },
    {
      type: 'button',
      label: 'Copy MD',
      title: 'Copy selection as Markdown',
      icon: { name: 'copy', fallback: 'Copy' },
      action: () => {
        window.dispatchEvent(new CustomEvent('copyAsMarkdown'));
      },
      isActive: () => false,
      className: 'copy-button',
    },
    {
      type: 'dropdown',
      label: 'Export',
      title: 'Export document',
      icon: { name: 'export', fallback: 'Export' },
      items: [
        {
          label: 'Export as PDF',
          action: () => {
            window.dispatchEvent(new CustomEvent('exportDocument', { detail: { format: 'pdf' } }));
          },
        },
        {
          label: 'Export as Word',
          action: () => {
            window.dispatchEvent(new CustomEvent('exportDocument', { detail: { format: 'docx' } }));
          },
        },
      ],
    },
    { type: 'separator' },
    {
      type: 'button',
      label: 'Export settings',
      title: 'Export settings',
      icon: { name: 'gear', fallback: '⚙' },
      action: () => {
        window.dispatchEvent(new CustomEvent('openExtensionSettings'));
      },
      isActive: () => false,
      className: 'settings-button',
    },
  ];

  const actionButtons: Array<{ config: ToolbarActionButton; element: HTMLButtonElement }> = [];
  const dropdownButtons: Array<{ config: ToolbarDropdown; element: HTMLButtonElement }> = [];
  const dropdownItems: Array<{ config: ToolbarDropdownItem; element: HTMLButtonElement }> = [];

  const refreshActiveStates = () => {
    // Update action buttons active and enabled states
    actionButtons.forEach(({ config, element }) => {
      const active = config.isActive ? config.isActive() : false;
      element.classList.toggle('active', Boolean(active));
      element.setAttribute('aria-pressed', String(Boolean(active)));

      // Check if button requires focus
      let enabled = config.requiresFocus ? isEditorFocused : true;
      if (enabled && config.isEnabled) {
        enabled = config.isEnabled();
      }
      element.disabled = !enabled;
      element.classList.toggle('disabled', !enabled);
      element.setAttribute('aria-disabled', String(!enabled));

      // Update title to explain why disabled
      if (!enabled && config.requiresFocus && !isEditorFocused) {
        element.title = (config.title || config.label) + ' (Click in document to edit)';
      } else if (!enabled) {
        element.title = (config.title || config.label) + ' (Not available here)';
      } else {
        element.title = config.title || config.label;
      }
    });

    // Update dropdown buttons enabled states
    dropdownButtons.forEach(({ config, element }) => {
      const active = config.isActive ? config.isActive() : false;
      element.classList.toggle('active', Boolean(active));
      element.setAttribute('aria-pressed', String(Boolean(active)));

      let enabled = config.requiresFocus ? isEditorFocused : true;
      if (enabled && config.isEnabled) {
        enabled = config.isEnabled();
      }
      element.disabled = !enabled;
      element.classList.toggle('disabled', !enabled);
      element.setAttribute('aria-disabled', String(!enabled));

      // Update title to explain why disabled
      if (!enabled && config.requiresFocus && !isEditorFocused) {
        element.title = (config.title || config.label) + ' (Click in document to edit)';
      } else if (!enabled) {
        element.title = (config.title || config.label) + ' (Not available here)';
      } else {
        element.title = config.title || config.label;
      }
    });

    // Update dropdown item disabled states
    dropdownItems.forEach(({ config, element }) => {
      const enabled = config.isEnabled ? config.isEnabled() : true;
      element.disabled = !enabled;
      element.classList.toggle('disabled', !enabled);
      element.setAttribute('aria-disabled', String(!enabled));
    });
  };

  buttons.forEach(btn => {
    if (btn.type === 'separator') {
      const separator = document.createElement('div');
      separator.className = 'toolbar-separator';
      toolbar.appendChild(separator);
      return;
    }

    if (btn.type === 'dropdown') {
      const container = document.createElement('div');
      container.className = 'toolbar-dropdown';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toolbar-button' + (btn.className ? ` ${btn.className}` : '');
      button.title = btn.title || btn.label;
      button.setAttribute('aria-label', btn.title || btn.label);
      button.setAttribute('aria-haspopup', 'true');
      button.setAttribute('aria-expanded', 'false');

      const icon = createIconElement(btn.icon, 'toolbar-icon');

      const menu = document.createElement('div');
      menu.className = 'toolbar-dropdown-menu';

      btn.items.forEach(item => {
        const menuItem = document.createElement('button');
        menuItem.type = 'button';
        menuItem.className = 'toolbar-dropdown-item';
        menuItem.title = item.label;
        menuItem.setAttribute('aria-label', item.label);

        const text = document.createElement('span');
        text.textContent = item.label;

        if (item.icon) {
          const menuIcon = createIconElement(item.icon, 'toolbar-dropdown-icon');
          menuItem.append(menuIcon, text);
        } else {
          menuItem.append(text);
        }

        menuItem.onclick = e => {
          e.preventDefault();
          e.stopPropagation();

          // Don't execute action if disabled
          if (menuItem.disabled) {
            return;
          }

          item.action();
          menu.style.display = 'none';
          button.setAttribute('aria-expanded', 'false');
          refreshActiveStates();
        };

        // Store reference to dropdown item for state updates
        dropdownItems.push({ config: item, element: menuItem });

        menu.appendChild(menuItem);
      });

      button.onclick = e => {
        e.preventDefault();
        e.stopPropagation();

        // Don't open dropdown if button is disabled
        if (button.disabled) {
          return;
        }

        const isVisible = menu.style.display === 'block';
        closeAllDropdowns();

        if (!isVisible) {
          // Refresh enabled states before showing menu
          refreshActiveStates();
        }

        menu.style.display = isVisible ? 'none' : 'block';
        button.setAttribute('aria-expanded', isVisible ? 'false' : 'true');
      };

      button.append(icon);
      container.append(button, menu);

      // Store dropdown button for state updates
      dropdownButtons.push({ config: btn, element: button });

      toolbar.appendChild(container);
      return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toolbar-button' + (btn.className ? ` ${btn.className}` : '');
    button.title = btn.title || btn.label;
    button.setAttribute('aria-label', btn.title || btn.label);

    const icon = createIconElement(btn.icon, 'toolbar-icon');

    button.append(icon);

    button.onclick = e => {
      e.preventDefault();

      btn.action();
      refreshActiveStates();
    };

    actionButtons.push({ config: btn, element: button });
    toolbar.appendChild(button);
  });

  toolbarRefreshFunction = refreshActiveStates;

  editor.on('selectionUpdate', refreshActiveStates);

  // Listen for editor focus changes
  const handleEditorFocusChange = (e: Event) => {
    const customEvent = e as CustomEvent<{ focused: boolean }>;
    isEditorFocused = customEvent.detail.focused;
    refreshActiveStates();
  };

  // Ensure we don't accumulate multiple listeners if toolbar is recreated
  if (focusChangeListener) {
    window.removeEventListener('editorFocusChange', focusChangeListener);
  }
  focusChangeListener = handleEditorFocusChange;
  window.addEventListener('editorFocusChange', handleEditorFocusChange);

  // Clean up listeners when editor is destroyed
  editor.on('destroy', () => {
    if (focusChangeListener) {
      window.removeEventListener('editorFocusChange', focusChangeListener);
      focusChangeListener = null;
    }

    if (typeof editor.off === 'function') {
      editor.off('selectionUpdate', refreshActiveStates);
    }
  });

  refreshActiveStates();

  document.addEventListener('click', () => {
    closeAllDropdowns();
  });

  return toolbar;
}

/**
 * Position bubble menu near selection
 */
export function positionBubbleMenu(menu: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    menu.style.display = 'none';
    return;
  }

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  if (rect.width === 0 && rect.height === 0) {
    menu.style.display = 'none';
    return;
  }

  menu.style.display = 'flex';
  menu.style.position = 'fixed'; // Use fixed instead of absolute
  menu.style.left = `${rect.left + rect.width / 2}px`;
  menu.style.top = `${rect.top - 45}px`; // Position above selection
  menu.style.transform = 'translateX(-50%)'; // Center horizontally
}

/**
 * Create table context menu for row/column operations.
 *
 * @param editor - TipTap editor instance
 * @returns HTMLElement containing the context menu
 */
export function createTableMenu(editor: Editor): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'table-menu';
  menu.style.display = 'none';

  const items: Array<
    | { separator: true }
    | {
        label: string;
        action: () => void;
      }
  > = [
    {
      label: 'Add Row Before',
      action: () => editor.chain().focus().addRowBefore().run(),
    },
    {
      label: 'Add Row After',
      action: () => editor.chain().focus().addRowAfter().run(),
    },
    {
      label: 'Delete Row',
      action: () => editor.chain().focus().deleteRow().run(),
    },
    { separator: true },
    {
      label: 'Add Column Before',
      action: () => editor.chain().focus().addColumnBefore().run(),
    },
    {
      label: 'Add Column After',
      action: () => editor.chain().focus().addColumnAfter().run(),
    },
    {
      label: 'Delete Column',
      action: () => editor.chain().focus().deleteColumn().run(),
    },
    { separator: true },
    {
      label: 'Delete Table',
      action: () => editor.chain().focus().deleteTable().run(),
    },
  ];

  items.forEach(item => {
    if ('separator' in item) {
      const separator = document.createElement('div');
      separator.className = 'table-menu-separator';
      menu.appendChild(separator);
    } else {
      const menuItem = document.createElement('div');
      menuItem.className = 'table-menu-item';
      menuItem.textContent = item.label;
      menuItem.title = item.label;
      menuItem.setAttribute('aria-label', item.label);
      menuItem.onclick = () => {
        item.action();
        menu.style.display = 'none';
      };
      menu.appendChild(menuItem);
    }
  });

  document.body.appendChild(menu);
  return menu;
}
