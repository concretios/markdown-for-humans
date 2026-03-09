/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

// Import CSS files (esbuild will bundle these)
import './editor.css';
import './codicon.css';

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit, Table } from '@tiptap/extension-table';
import { ListKit } from '@tiptap/extension-list';
import Link from '@tiptap/extension-link';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Highlight from '@tiptap/extension-highlight';
import DragHandle from '@tiptap/extension-drag-handle';
import { marked as markedInstance } from 'marked';
import { CustomImage } from './extensions/customImage';
import { lowlight } from 'lowlight';
import { Mermaid } from './extensions/mermaid';
import { IndentedImageCodeBlock } from './extensions/indentedImageCodeBlock';
import { SpaceFriendlyImagePaths } from './extensions/spaceFriendlyImagePaths';
import { TabIndentation } from './extensions/tabIndentation';
import { GitHubAlerts } from './extensions/githubAlerts';
import { ImageEnterSpacing } from './extensions/imageEnterSpacing';
import { MarkdownParagraph } from './extensions/markdownParagraph';
import { OrderedListMarkdownFix } from './extensions/orderedListMarkdownFix';
import { TableCellEnterHandler } from './extensions/tableCellEnterHandler';
import { GenericHTMLInline, GenericHTMLBlock } from './extensions/htmlPreservation';
import { LivePreview } from './extensions/livePreview';
import { createFormattingToolbar, createTableMenu, updateToolbarStates } from './BubbleMenuView';
import { TextColorMark, CustomTextStyle } from './extensions/textColor';
import { getEditorMarkdownForSync } from './utils/markdownSerialization';
import {
  setupImageDragDrop,
  hasPendingImageSaves,
  getPendingImageCount,
} from './features/imageDragDrop';
import { renderTableToMarkdownWithBreaks } from './utils/tableMarkdownSerializer';
import { toggleTocOverlay } from './features/tocOverlay';
import { toggleSearchOverlay } from './features/searchOverlay';
import { showLinkDialog } from './features/linkDialog';
import { processPasteContent, parseFencedCode } from './utils/pasteHandler';
import { copySelectionAsMarkdown } from './utils/copyMarkdown';
import { shouldAutoLink } from './utils/linkValidation';
import { buildOutlineFromEditor } from './utils/outline';
import { scrollToHeading } from './utils/scrollToHeading';
import { isSaveShortcut } from './utils/shortcutKeys';
import { collectExportContent, getDocumentTitle } from './utils/exportContent';

/**
 * Tags that TipTap handles natively — never strip these.
 */
const KNOWN_HTML_TAGS = new Set([
  'br',
  'p',
  'div',
  'span',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'ins',
  'sub',
  'sup',
  'code',
  'pre',
  'blockquote',
  'a',
  'img',
  'mark',
]);

/**
 * Strip unknown HTML tags from a string, keeping text content.
 * Converts `<mark>` → `==` for native Highlight support.
 */
function stripUnknownHtml(raw: string): string {
  let result = raw.replace(/<mark>/gi, '==').replace(/<\/mark>/gi, '==');
  result = result.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*\/?>/g, (tag, tagName) => {
    return KNOWN_HTML_TAGS.has(tagName.toLowerCase()) ? tag : '';
  });
  return result;
}

/**
 * Pre-process markdown content using `marked`'s AST to safely strip unknown
 * HTML tags while NEVER touching content inside code blocks or inline code spans.
 *
 * The previous regex-based approach was fragile with nested backticks, escaped
 * characters, and indented code blocks. Using `marked.lexer()` leverages the
 * same parser TipTap uses, so code boundary detection is 100% accurate.
 */
function preprocessMarkdownContent(content: string): string {
  const tokens = markedInstance.lexer(content);
  return reconstructFromTokens(tokens);
}

/**
 * Recursively reconstruct markdown from a token tree, stripping unknown HTML
 * only from non-code tokens. Code tokens (`code`, `codespan`) are returned
 * verbatim via `token.raw`.
 */
function reconstructFromTokens(
  tokens: Array<{ type: string; raw: string; tokens?: unknown[]; items?: unknown[] }>
): string {
  return tokens
    .map(token => {
      // Code tokens: return raw content completely untouched
      if (token.type === 'code' || token.type === 'codespan') {
        return token.raw;
      }

      // HTML tokens (inline or block): strip unknown tags
      if (token.type === 'html') {
        return stripUnknownHtml(token.raw);
      }

      // Tokens with children: we must reconstruct from children to
      // preserve the tree walk, but keep the token's own raw prefix/suffix
      if (token.tokens && Array.isArray(token.tokens)) {
        const childrenOutput = reconstructFromTokens(
          token.tokens as Array<{ type: string; raw: string; tokens?: unknown[] }>
        );
        // For top-level block tokens (paragraph, heading, etc.) the raw includes
        // trailing newlines — we need to preserve those but swap inner content
        const rawInner = (token.tokens as Array<{ raw: string }>).map(t => t.raw).join('');
        return token.raw.replace(rawInner, childrenOutput);
      }

      // List items have `items` instead of `tokens`
      if (token.items && Array.isArray(token.items)) {
        const itemsOutput = reconstructFromTokens(
          token.items as Array<{ type: string; raw: string; tokens?: unknown[] }>
        );
        const rawInner = (token.items as Array<{ raw: string }>).map(i => i.raw).join('');
        return token.raw.replace(rawInner, itemsOutput);
      }

      // Leaf tokens (text, space, etc.): return raw
      return token.raw;
    })
    .join('');
}

// Helper function for slug generation (same as in linkDialog)
function generateHeadingSlug(text: string, existingSlugs: Set<string>): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  let finalSlug = slug;
  let counter = 1;
  while (existingSlugs.has(finalSlug)) {
    finalSlug = `${slug}-${counter}`;
    counter++;
  }

  existingSlugs.add(finalSlug);
  return finalSlug;
}

// Import common languages for syntax highlighting
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';

// Register languages with lowlight
lowlight.registerLanguage('javascript', javascript);
lowlight.registerLanguage('typescript', typescript);
lowlight.registerLanguage('python', python);
lowlight.registerLanguage('bash', bash);
lowlight.registerLanguage('json', json);
lowlight.registerLanguage('markdown', markdown);
lowlight.registerLanguage('css', css);
lowlight.registerLanguage('html', xml);
lowlight.registerLanguage('xml', xml);
lowlight.registerLanguage('sql', sql);
lowlight.registerLanguage('java', java);
lowlight.registerLanguage('go', go);
lowlight.registerLanguage('rust', rust);

// VS Code API type definitions
type VsCodeApi = {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

declare const acquireVsCodeApi: () => VsCodeApi;

// Extended window interface for MD4H globals
declare global {
  interface Window {
    vscode?: VsCodeApi;
    resolveImagePath?: (relativePath: string) => Promise<string>;
    getImageReferences?: (imagePath: string) => Promise<unknown>;
    checkImageRename?: (oldPath: string, newName: string) => Promise<unknown>;
    setupImageResize?: (
      img: HTMLImageElement,
      editorInstance?: Editor,
      vscodeApi?: VsCodeApi
    ) => void;
    skipResizeWarning?: boolean;
    imagePath?: string;
    imagePathBase?: string;
    _imageCacheBust?: Map<string, number>;
    _workspaceCheckCallbacks?: Map<string, (result: unknown) => void>;
    md4hDeveloperMode?: boolean;
  }
}

const vscode = acquireVsCodeApi();

// Make vscode API available globally for toolbar buttons
window.vscode = vscode;

/**
 * Mirror webview diagnostics into extension-host logs for easier alpha troubleshooting.
 */
function reportWebviewIssue(level: 'error' | 'warn' | 'info', message: string, details?: unknown) {
  try {
    vscode.postMessage({
      type: 'webviewLog',
      level,
      message,
      details,
    });
  } catch (error) {
    console.error('[MD4H] Failed to forward webview issue to extension host:', error);
  }
}

const userErrorCooldownMs = 5000;
const lastUserErrorAt = new Map<string, number>();

function isDeveloperModeEnabled(): boolean {
  return window.md4hDeveloperMode !== false;
}

function showRuntimeErrorToUser(code: string, baseMessage: string, error?: unknown) {
  const now = Date.now();
  const last = lastUserErrorAt.get(code) ?? 0;
  if (now - last < userErrorCooldownMs) {
    return;
  }
  lastUserErrorAt.set(code, now);

  const errorText =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error ?? '');
  const message =
    isDeveloperModeEnabled() && errorText ? `${baseMessage} (${errorText})` : baseMessage;

  vscode.postMessage({
    type: 'showError',
    message,
  });
}

let editor: Editor | null = null;
let isUpdating = false; // Prevent feedback loops
let formattingToolbar: HTMLElement;
let tableMenu: HTMLElement;
// Dirty state tracking — true when webview has unsaved edits
let docDirty = false;

function setDocDirty(dirty: boolean) {
  docDirty = dirty;
  (window as any).__docDirty = dirty;
  window.dispatchEvent(new CustomEvent('documentDirtyChange', { detail: { dirty } }));
  updateToolbarStates();
}
let updateTimeout: number | null = null;
let lastUserEditTime = 0; // Track when user last edited
let pendingInitialContent: string | null = null; // Content from host before editor is ready
let hasSentReadySignal = false;
let isDomReady = document.readyState !== 'loading';
let outlineUpdateTimeout: number | null = null;

// Hash-based sync deduplication (replaces unreliable ignoreNextUpdate boolean)
let lastSentContentHash: string | null = null;
let lastSentTimestamp = 0;

/**
 * Simple hash function (djb2 algorithm) for content deduplication
 */
function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
  }
  return hash.toString(36);
}

/**
 * Generate short request IDs used to correlate save logs between webview and extension host.
 */
function createRequestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const signalReady = () => {
  if (hasSentReadySignal) return;
  vscode.postMessage({ type: 'ready' });
  hasSentReadySignal = true;
};

/**
 * Explicitly request a fresh document/settings sync from extension host.
 * Used as a recovery path when webview is visible but editor DOM is blank.
 */
function requestHostResync(reason: string) {
  console.warn('[MD4H][RECOVERY] Requesting host resync:', reason);
  vscode.postMessage({ type: 'ready' });
}

function isEditorDomBlank(): boolean {
  const root = document.querySelector('#editor') as HTMLElement | null;
  if (!root) return true;
  if (!root.querySelector('.ProseMirror')) return true;
  if (editor && editor.state.doc.content.size > 0) return false;
  const proseMirrorText = root.textContent?.trim() || '';
  return proseMirrorText.length === 0;
}

function scheduleBlankEditorRecovery(trigger: string) {
  setTimeout(() => {
    if (document.visibilityState !== 'visible') return;
    if (!isEditorDomBlank()) return;

    console.warn('[MD4H][RECOVERY] Blank editor detected after', trigger);
    requestHostResync(`blank-editor-${trigger}`);
  }, 120);
}

/**
 * Track content we're about to send to prevent echo updates
 */
const trackSentContent = (content: string) => {
  lastSentContentHash = hashString(content);
  lastSentTimestamp = Date.now();
};

const pushOutlineUpdate = () => {
  if (!editor) return;
  try {
    const outline = buildOutlineFromEditor(editor);
    vscode.postMessage({ type: 'outlineUpdated', outline });
  } catch (error) {
    console.warn('[MD4H] Failed to build outline:', error);
  }
};

const scheduleOutlineUpdate = () => {
  if (outlineUpdateTimeout) {
    clearTimeout(outlineUpdateTimeout);
  }
  outlineUpdateTimeout = window.setTimeout(() => {
    pushOutlineUpdate();
    outlineUpdateTimeout = null;
  }, 250);
};

/**
 * Immediately send update (used for save shortcuts)
 */
function immediateUpdate() {
  if (!editor) return;
  saveDocument();
}

/**
 * Explicitly save the document — sends content to extension and triggers VS Code save.
 * This is the ONLY path through which webview edits reach the file system.
 */
function saveDocument() {
  if (!editor) return;

  try {
    // Clear any pending debounced update
    if (updateTimeout) {
      clearTimeout(updateTimeout);
      updateTimeout = null;
    }

    const markdown = getEditorMarkdownForSync(editor);
    const plainTextLength = editor.getText().trim().length;
    const saveRequestId = createRequestId('save');
    const contentHash = hashString(markdown);

    if (markdown.length === 0 && plainTextLength > 0) {
      const details = {
        requestId: saveRequestId,
        plainTextLength,
        docSize: editor.state.doc.content.size,
      };
      console.error('[MD4H] Serialization produced empty markdown for non-empty document', details);
      reportWebviewIssue(
        'error',
        '[SAVE] Serialization produced empty markdown for non-empty document; save blocked to prevent data loss',
        details
      );
      showRuntimeErrorToUser(
        'save-serialization-empty',
        'Save blocked: serialization returned empty output for a non-empty document. Please share MD4H logs with support.'
      );
      return;
    }

    trackSentContent(markdown);

    console.log(
      `[MD4H][SAVE][${saveRequestId}] Dispatching saveAndEdit (len=${markdown.length}, hash=${contentHash})`
    );

    // Send combined edit and save to avoid race conditions
    vscode.postMessage({
      type: 'saveAndEdit',
      content: markdown,
      requestId: saveRequestId,
    });
    // Let the VS Code side send the 'saved' event to clear the dirty state
  } catch (error) {
    console.error('[MD4H] Error saving document:', error);
    reportWebviewIssue('error', '[SAVE] Exception while preparing save payload', {
      error: error instanceof Error ? error.message : String(error),
    });
    showRuntimeErrorToUser(
      'save-exception',
      'Save failed while preparing document content.',
      error
    );
  }
}

// Expose saveDocument globally for toolbar button
(window as any).saveDocument = saveDocument;

/**
 * Debounced update sending edits to VS Code
 * This ensures the VS Code TextDocument is marked dirty and can be saved naturally
 */
function debouncedUpdate(markdown: string) {
  if (updateTimeout) {
    clearTimeout(updateTimeout);
  }

  updateTimeout = window.setTimeout(() => {
    try {
      console.log(`[MD4H] debouncedUpdate firing for ${markdown.length} chars...`);
      if (editor && markdown.length === 0 && editor.getText().trim().length > 0) {
        const details = {
          plainTextLength: editor.getText().trim().length,
          docSize: editor.state.doc.content.size,
        };
        console.error(
          '[MD4H] Debounced sync produced empty markdown for non-empty document',
          details
        );
        reportWebviewIssue(
          'error',
          '[SYNC] Debounced sync produced empty markdown for non-empty document; sync skipped',
          details
        );
        showRuntimeErrorToUser(
          'sync-serialization-empty',
          'Auto-sync skipped because serialization returned empty output for non-empty content.'
        );
        updateTimeout = null;
        return;
      }
      // Check if any images are currently being saved
      if (hasPendingImageSaves()) {
        const count = getPendingImageCount();
        console.log(`[MD4H] Delaying document sync - ${count} image(s) still being saved`);
        // Re-queue the update
        debouncedUpdate(markdown);
        return;
      }

      vscode.postMessage({
        type: 'edit',
        content: markdown,
      });
      updateTimeout = null;
      trackSentContent(markdown);
    } catch (error) {
      console.error('[MD4H] Error in debounced update:', error);
    }
  }, 300);
}

// TODO: Re-implement code block language badges feature
// This feature was causing TipTap to not render due to DOM manipulation conflicts
// Need to find a way to add language badges without interfering with TipTap's rendering

/*
// Supported languages for code blocks
const CODE_BLOCK_LANGUAGES = [
  { value: 'plaintext', label: 'Plain Text' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'bash', label: 'Bash' },
  { value: 'json', label: 'JSON' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'css', label: 'CSS' },
  { value: 'html', label: 'HTML' },
  { value: 'sql', label: 'SQL' },
  { value: 'java', label: 'Java' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
];

function setupCodeBlockLanguageBadges(editorInstance: Editor) {
  // Implementation commented out - was interfering with TipTap rendering
}
*/

/**
 * Initialize TipTap editor with error handling
 */
function initializeEditor(initialContent: string) {
  try {
    if (editor) {
      console.warn('[MD4H] Editor already initialized, skipping re-init');
      return;
    }

    const editorElement = document.querySelector('#editor') as HTMLElement;
    if (!editorElement) {
      console.error('[MD4H] Editor element not found');
      return;
    }

    console.log('[MD4H] Initializing editor...');

    const editorInstance = new Editor({
      element: editorElement,
      extensions: [
        // Mermaid must be before CodeBlockLowlight to intercept mermaid code blocks
        Mermaid,
        // Must be before CodeBlockLowlight to intercept indented "code" tokens containing images
        IndentedImageCodeBlock,
        // Fallback: treat standalone image lines with spaces in the path as images.
        SpaceFriendlyImagePaths,
        // GitHubAlerts must be before StarterKit to intercept alert blockquotes
        GitHubAlerts,
        Highlight.configure({
          HTMLAttributes: {
            class: 'highlight',
          },
        }),
        GenericHTMLInline,
        GenericHTMLBlock,
        LivePreview,
        DragHandle.configure({
          render() {
            const element = document.createElement('div');
            element.classList.add('custom-drag-handle');
            element.innerHTML =
              '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/></svg>';
            return element;
          },
        }),
        CustomTextStyle,
        TextColorMark,
        StarterKit.configure({
          heading: {
            levels: [1, 2, 3, 4, 5, 6],
          },
          paragraph: false, // Disable default paragraph, using MarkdownParagraph instead
          codeBlock: false, // Disable default CodeBlock, using CodeBlockLowlight instead
          // ListKit is registered separately to support task lists; disable StarterKit's list
          // extensions to avoid duplicate names (which can break markdown parsing, e.g. `1)` lists).
          bulletList: false,
          orderedList: false,
          listItem: false,
          listKeymap: false,
          // Disable StarterKit's Link - we configure our own with shouldAutoLink validation
          link: false,
          // In Tiptap v3, 'history' was renamed to 'undoRedo'
          undoRedo: {
            depth: 100,
          },
        }),
        MarkdownParagraph, // Custom paragraph with empty-paragraph filtering in renderMarkdown
        CodeBlockLowlight.configure({
          lowlight,
          HTMLAttributes: {
            class: 'code-block-highlighted',
          },
          defaultLanguage: 'plaintext',
          enableTabIndentation: true, // Enable Tab key for indentation
          tabSize: 2, // 2 spaces per tab (cleaner for markdown code blocks)
        }),
        Markdown.configure({
          markedOptions: {
            gfm: true, // GitHub Flavored Markdown for tables, task lists
            breaks: true, // Preserve single newlines as <br>
          },
        }),
        // Custom Table extension that handles <br /> correctly
        Table.extend({
          renderMarkdown(node, h) {
            return renderTableToMarkdownWithBreaks(node, h);
          },
        }).configure({
          resizable: true,
          HTMLAttributes: {
            class: 'markdown-table',
          },
        }),
        // Still use TableKit for rows and cells, but disable its internal table
        // to avoid duplicate registration of the 'table' node
        TableKit.configure({
          table: false,
        }),
        ListKit.configure({
          orderedList: false,
          taskItem: {
            nested: true,
          },
        }),
        OrderedListMarkdownFix,
        TabIndentation, // Enable Tab/Shift+Tab for list indentation
        ImageEnterSpacing, // Handle Enter key around images and gap cursor
        TableCellEnterHandler, // Make Enter in table cells insert <br /> instead of new paragraph
        Link.configure({
          openOnClick: false,
          HTMLAttributes: {
            class: 'markdown-link',
          },
          shouldAutoLink,
        }),
        CustomImage.configure({
          allowBase64: true, // Allow base64 for preview
          HTMLAttributes: {
            class: 'markdown-image',
          },
        }),
      ],
      // Don't pass content here - we'll set it after init with contentType: 'markdown'
      editorProps: {
        attributes: {
          class: 'markdown-editor',
          spellcheck: 'true',
        },
        // Prevent default image drop handling - let our custom handler manage it
        handleDrop: (_view, event, slice, moved) => {
          const dt = event.dataTransfer;

          // Disable dragging tables - it causes erroneous rows/cols or duplication in Tiptap
          if (moved && slice.content.childCount > 0) {
            let hasTable = false;
            slice.content.forEach(node => {
              if (
                node.type.name === 'table' ||
                node.type.name === 'tableRow' ||
                node.type.name === 'tableCell' ||
                node.type.name === 'tableHeader'
              ) {
                hasTable = true;
              }
            });

            if (hasTable) {
              console.log('[MD4H] Prevented table drag to avoid structure corruption');
              return true; // Prevent default
            }
          }

          if (!dt) return false;

          // Case 1: Actual image files (from desktop/finder)
          if (dt.files && dt.files.length > 0) {
            const hasImages = Array.from(dt.files).some(f => f.type.startsWith('image/'));
            if (hasImages) {
              return true; // Prevent default, our DOM handler will manage it
            }
          }

          // Case 2: VS Code file explorer drops (passes URI as text)
          // Check for text/uri-list or text/plain containing image paths
          const uriList = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
          if (uriList) {
            const isImagePath = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(uriList);
            if (isImagePath) {
              // This is a file path drop from VS Code - prevent TipTap's default
              // Our DOM handler will process it
              return true;
            }
          }

          return false; // Allow default for non-image drops
        },
      },
      onUpdate: ({ editor: _editor }) => {
        if (isUpdating) return;

        try {
          // Track when user last edited
          lastUserEditTime = Date.now();

          // Mark document dirty (don't auto-send to extension)
          if (!docDirty) {
            setDocDirty(true);
          }

          scheduleOutlineUpdate();

          const markdown = getEditorMarkdownForSync(_editor);
          console.log(`[MD4H] onUpdate: markdown serialized (len=${markdown.length})`);
          debouncedUpdate(markdown);
        } catch (error) {
          console.error('[MD4H] Error in onUpdate:', error);
        }
      },
      onSelectionUpdate: ({ editor }) => {
        try {
          const { from } = editor.state.selection;
          vscode.postMessage({ type: 'selectionChange', pos: from });
        } catch (error) {
          console.warn('[MD4H] Selection update failed:', error);
        }
      },
      onFocus: () => {
        // Signal focus to enable focus-requiring toolbar buttons
        window.dispatchEvent(new CustomEvent('editorFocusChange', { detail: { focused: true } }));
      },
      onBlur: () => {
        // Focus change is handled via relatedTarget in editorDom listener to allow toolbar interaction
      },
      onCreate: () => {
        console.log('[MD4H] Editor created successfully');
      },
      onDestroy: () => {
        console.log('[MD4H] Editor destroyed');
      },
    });

    editor = editorInstance;

    // Set initial content as markdown (Tiptap v3 requires explicit contentType)
    if (initialContent) {
      // Prevent onUpdate from firing during initialization - this was causing
      // documents with frontmatter to be marked dirty even without user edits
      isUpdating = true;
      editor.commands.setContent(preprocessMarkdownContent(initialContent), {
        contentType: 'markdown',
      });
      isUpdating = false;
    }

    // Create and insert formatting toolbar at top
    formattingToolbar = createFormattingToolbar(editorInstance);
    const editorContainer = document.querySelector('#editor') as HTMLElement;
    if (editorContainer && editorContainer.parentElement) {
      editorContainer.parentElement.insertBefore(formattingToolbar, editorContainer);
    }

    // Track editor focus state for toolbar and keep toolbar enabled while interacting with it
    const editorDom = editorInstance.view.dom;
    editorDom.addEventListener('focus', () => {
      window.dispatchEvent(new CustomEvent('editorFocusChange', { detail: { focused: true } }));
    });
    editorDom.addEventListener('blur', (event: FocusEvent) => {
      const relatedTarget = event.relatedTarget as HTMLElement | null;
      const stayingInToolbar = Boolean(relatedTarget && formattingToolbar?.contains(relatedTarget));

      if (stayingInToolbar) {
        return;
      }

      // relatedTarget can be null; wait a tick to see where focus actually lands
      setTimeout(() => {
        const activeElement = document.activeElement as HTMLElement | null;
        if (activeElement && formattingToolbar?.contains(activeElement)) {
          return;
        }
        window.dispatchEvent(new CustomEvent('editorFocusChange', { detail: { focused: false } }));
      }, 0);
    });

    // Create table menu
    tableMenu = createTableMenu(editorInstance);

    // Setup image drag & drop handling
    setupImageDragDrop(editorInstance, vscode);

    // Initial outline push
    pushOutlineUpdate();
    try {
      const { from } = editorInstance.state.selection;
      vscode.postMessage({ type: 'selectionChange', pos: from });
    } catch (error) {
      console.warn('[MD4H] Initial selection sync failed:', error);
    }

    // Setup code block language badges
    // TODO: Re-implement this feature without interfering with TipTap's DOM
    // setupCodeBlockLanguageBadges(editor);

    // Store handler references for cleanup on editor destroy
    const contextMenuHandler = (e: MouseEvent) => {
      try {
        const target = e.target as HTMLElement;
        const tableCell = target.closest('td, th');

        if (tableCell && editorInstance.isActive('table')) {
          e.preventDefault();
          tableMenu.style.display = 'block';
          tableMenu.style.position = 'fixed';
          tableMenu.style.left = `${e.clientX}px`;
          tableMenu.style.top = `${e.clientY}px`;
        } else {
          tableMenu.style.display = 'none';
        }
      } catch (error) {
        console.error('[MD4H] Error in context menu:', error);
      }
    };

    const documentClickHandler = () => {
      tableMenu.style.display = 'none';
    };

    // Handle keyboard shortcuts
    const keydownHandler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey; // Cmd on Mac, Ctrl on Windows/Linux

      // Log ALL modifier key presses for debugging
      if (isMod) {
        console.log(`[MD4H] Key pressed: ${e.key}, metaKey: ${e.metaKey}, ctrlKey: ${e.ctrlKey}`);
      }

      // Save shortcut - immediate save
      if (isSaveShortcut(e)) {
        console.log('[MD4H] *** SAVE SHORTCUT TRIGGERED ***');
        e.preventDefault();
        e.stopPropagation();
        immediateUpdate();

        // Visual feedback - flash the document briefly
        document.body.style.opacity = '0.7';
        setTimeout(() => {
          document.body.style.opacity = '1';
        }, 100);

        return;
      }

      // Prevent VS Code from handling markdown formatting shortcuts
      // TipTap will handle these natively
      const formattingShortcuts = [
        'b', // Bold
        'i', // Italic
        'u', // Underline (some editors)
      ];

      if (isMod && formattingShortcuts.includes(e.key.toLowerCase())) {
        e.stopPropagation(); // Stop event from reaching VS Code
        console.log(`[MD4H] Intercepted Cmd+${e.key.toUpperCase()} for editor`);
        // TipTap will handle the formatting
        return;
      }

      // Intercept Cmd+K for link in markdown context
      if (isMod && e.key === 'k') {
        e.preventDefault();
        e.stopPropagation();
        console.log('[MD4H] Link shortcut');
        if (editor) {
          showLinkDialog(editor);
        }
        return;
      }

      // Intercept Cmd/Ctrl+F for in-document search
      if (isMod && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        console.log('[MD4H] Search shortcut');
        if (editor) {
          toggleSearchOverlay(editor);
        }
        return;
      }
    };

    // Register handlers
    document.addEventListener('contextmenu', contextMenuHandler);
    document.addEventListener('click', documentClickHandler);
    document.addEventListener('keydown', keydownHandler);

    // Add link click handler for navigation
    const handleLinkClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest('.markdown-link') as HTMLAnchorElement;
      if (!link) return;

      const href = link.getAttribute('href');
      console.log('[MD4H Webview] Link clicked:', href);

      if (!href) {
        console.warn('[MD4H Webview] Link has no href attribute');
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      // External URLs
      if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
        console.log('[MD4H Webview] Sending openExternalLink message');
        const vscode = (window as any).vscode;
        if (vscode && typeof vscode.postMessage === 'function') {
          vscode.postMessage({
            type: 'openExternalLink',
            url: href,
          });
        } else {
          console.warn('[MD4H Webview] vscode.postMessage not available');
        }
        return;
      }

      // Anchor links (heading links)
      if (href.startsWith('#')) {
        console.log('[MD4H Webview] Handling anchor link:', href);
        const slug = href.slice(1);
        if (editorInstance) {
          // Find heading by slug
          const outline = buildOutlineFromEditor(editorInstance);
          const existingSlugs = new Set<string>();
          const headingMap = new Map<string, number>();

          outline.forEach(entry => {
            const headingSlug = generateHeadingSlug(entry.text, existingSlugs);
            headingMap.set(headingSlug, entry.pos);
          });

          const headingPos = headingMap.get(slug);
          if (headingPos !== undefined) {
            console.log('[MD4H Webview] Scrolling to heading at position:', headingPos);
            scrollToHeading(editorInstance, headingPos);
          } else {
            console.warn('[MD4H Webview] Heading not found for slug:', slug);
          }
        }
        return;
      }

      // Detect image files - handle separately
      if (/\.(png|jpe?g|gif|svg|webp|bmp|ico|tiff?)$/i.test(href)) {
        e.preventDefault();
        e.stopPropagation();

        console.log('[MD4H Webview] Image link clicked, sending openImage message');
        const vscode = (window as any).vscode;
        if (vscode && typeof vscode.postMessage === 'function') {
          vscode.postMessage({
            type: 'openImage',
            path: href,
          });
        } else {
          console.warn('[MD4H Webview] vscode.postMessage not available');
        }
        return;
      }

      // Local file links (non-image)
      console.log('[MD4H Webview] Sending openFileLink message');
      const vscode = (window as any).vscode;
      if (vscode && typeof vscode.postMessage === 'function') {
        vscode.postMessage({
          type: 'openFileLink',
          path: href,
        });
      } else {
        console.warn('[MD4H Webview] vscode.postMessage not available');
      }
    };

    // Add click handler to editor DOM
    editorInstance.view.dom.addEventListener('click', handleLinkClick);

    // Also handle links added dynamically by listening to editor updates
    const updateLinkHandlers = () => {
      const links = editorInstance.view.dom.querySelectorAll('.markdown-link');
      links.forEach(link => {
        if (!(link as any)._linkHandlerAdded) {
          (link as any)._linkHandlerAdded = true;
          // Handler is on parent, so this is just for marking
        }
      });
    };

    editorInstance.on('update', updateLinkHandlers);
    updateLinkHandlers(); // Initial call

    // Clean up listeners when editor is destroyed to prevent memory leaks
    editorInstance.on('destroy', () => {
      document.removeEventListener('contextmenu', contextMenuHandler);
      document.removeEventListener('click', documentClickHandler);
      document.removeEventListener('keydown', keydownHandler);
      editorInstance.view.dom.removeEventListener('click', handleLinkClick);
      console.log('[MD4H] Editor destroyed, global listeners cleaned up');
    });

    console.log('[MD4H] Editor initialization complete');
  } catch (error) {
    console.error('[MD4H] Fatal error initializing editor:', error);
    showRuntimeErrorToUser('editor-init-fatal', 'Editor failed to initialize.', error);
    const editorElement = document.querySelector('#editor') as HTMLElement;
    if (editorElement) {
      editorElement.innerHTML = `
        <div style="color: red; padding: 20px; font-family: monospace;">
          <h3>Error Loading Editor</h3>
          <p>${error instanceof Error ? error.message : 'Unknown error'}</p>
          <p>Please check the Debug Console for details.</p>
        </div>
      `;
    }
  }
}

/**
 * Helper to apply all webview configuration settings from extension messages.
 */
function applyWebviewSettings(message: any) {
  if (typeof message.skipResizeWarning === 'boolean') {
    (window as any).skipResizeWarning = message.skipResizeWarning;
  }
  if (typeof message.imagePath === 'string') {
    (window as any).imagePath = message.imagePath;
  }
  if (typeof message.mediaPath === 'string') {
    (window as any).mediaPath = message.mediaPath;
  }
  if (typeof message.mediaPathBase === 'string') {
    (window as any).mediaPathBase = message.mediaPathBase;
  }
  if (typeof message.imagePathBase === 'string') {
    (window as any).imagePathBase = message.imagePathBase;
  }
  if (typeof message.developerMode === 'boolean') {
    window.md4hDeveloperMode = message.developerMode;
  }

  // Apply spacing variables
  const root = document.documentElement;
  if (typeof message.lineSpacing === 'number') {
    root.style.setProperty('--md4h-line-spacing', message.lineSpacing.toString());
  }
  if (typeof message.paragraphSpacing === 'number') {
    root.style.setProperty('--md4h-paragraph-spacing', `${message.paragraphSpacing}em`);
  }
  if (typeof message.tableCellSpacing === 'number') {
    root.style.setProperty('--md4h-table-cell-spacing', `${message.tableCellSpacing}em`);
  }
  if (typeof message.tableCellHorizontalSpacing === 'number') {
    root.style.setProperty(
      '--md4h-table-cell-horizontal-spacing',
      `${message.tableCellHorizontalSpacing}em`
    );
  }

  if (message.themeOverride) {
    (window as any).md4hCurrentThemeOverride = message.themeOverride;
    console.warn('[MD4H][THEME] settingsUpdate received', { themeOverride: message.themeOverride });
    if (typeof (window as any).md4hApplyTheme === 'function') {
      (window as any).md4hApplyTheme(message.themeOverride);
    }
    window.dispatchEvent(new CustomEvent('themeChange'));
  }
}

/**
 * Handle messages from extension
 */
window.addEventListener('message', (event: MessageEvent) => {
  try {
    const message = event.data;

    switch (message.type) {
      case 'update':
        applyWebviewSettings(message);

        // Initialize editor with first payload to seed undo history correctly
        if (!editor) {
          if (isDomReady) {
            initializeEditor(message.content);
          } else {
            pendingInitialContent = message.content;
            (window as any)._pendingThemeOverride = message.themeOverride;
          }
          return;
        }
        updateEditorContent(message.content);
        break;
      case 'settingsUpdate': {
        applyWebviewSettings(message);
        break;
      }

      case 'navigateToHeading': {
        if (!editor) return;
        const pos = message.pos as number;
        scrollToHeading(editor, pos);
        break;
      }
      case 'fileSearchResults': {
        import('./features/linkDialog').then(({ handleFileSearchResults }) => {
          const results = message.results as Array<{ filename: string; path: string }>;
          const requestId = message.requestId as number;
          handleFileSearchResults(results, requestId);
        });
        break;
      }
      case 'exportResult':
        if (message.success) {
          vscode.postMessage({ type: 'showInfo', message: 'Document exported successfully!' });
        } else {
          vscode.postMessage({ type: 'showError', message: `Export failed: ${message.error}` });
        }
        break;
      case 'saved':
        if (typeof message.requestId === 'string') {
          console.log(`[MD4H][SAVE][${message.requestId}] Received "saved" signal from extension`);
        } else {
          console.log('[MD4H] Received "saved" signal from extension');
        }
        setDocDirty(false);
        break;
      case 'imageUriResolved':
        // Handled by the custom image message plugin; ignore here to avoid log noise.
        break;
      default:
        console.warn('[MD4H] Unknown message type:', message.type);
    }
  } catch (error) {
    console.error('[MD4H] Error handling message:', error);
  }
});

/**
 * Update editor content from document with cursor preservation
 */
function updateEditorContent(markdown: string) {
  if (!editor) {
    console.error('[MD4H] Editor not initialized');
    return;
  }

  try {
    // Hash-based deduplication: skip if this is content we just sent
    const incomingHash = hashString(markdown);
    if (incomingHash === lastSentContentHash) {
      // Also check timestamp to allow legitimate identical content after a delay
      const timeSinceLastSend = Date.now() - lastSentTimestamp;
      if (timeSinceLastSend < 2000) {
        console.log('[MD4H] Ignoring update (matches content we just sent)');
        return;
      }
    }

    // Don't update if user edited recently (within 2 seconds)
    const timeSinceLastEdit = Date.now() - lastUserEditTime;
    if (timeSinceLastEdit < 2000) {
      console.log(`[MD4H] Skipping update - user recently edited (${timeSinceLastEdit}ms ago)`);
      return;
    }

    isUpdating = true;

    const startTime = performance.now();
    const docSize = markdown.length;

    console.log(`[MD4H] Updating content (${docSize} chars)...`);

    // Skip if content is already in sync
    const currentMarkdown = getEditorMarkdownForSync(editor);
    if (currentMarkdown === markdown) {
      console.log('[MD4H] Update skipped (content unchanged)');
      return;
    }

    // Save cursor position
    const { from, to } = editor.state.selection;
    console.log(`[MD4H] Saving cursor position: ${from}-${to}`);

    // Set content
    editor.commands.setContent(preprocessMarkdownContent(markdown), { contentType: 'markdown' });

    // Restore cursor position
    try {
      editor.commands.setTextSelection({ from, to });
      console.log(`[MD4H] Restored cursor position: ${from}-${to}`);
    } catch {
      console.log('[MD4H] Could not restore cursor position (document too short)');
      // If exact position fails, move to end of document
      const endPos = editor.state.doc.content.size;
      editor.commands.setTextSelection(Math.min(from, endPos));
    }

    pushOutlineUpdate();

    const duration = performance.now() - startTime;
    console.log(`[MD4H] Content updated in ${duration.toFixed(2)}ms`);

    if (duration > 1000) {
      console.warn(`[MD4H] Slow update: ${duration.toFixed(2)}ms for ${docSize} chars`);
    }
  } catch (error) {
    console.error('[MD4H] Error updating content:', error);
    console.error('[MD4H] Document size:', markdown.length, 'chars');
  } finally {
    isUpdating = false;
  }
}

// Initialize when DOM is ready and content is available
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    isDomReady = true;
    signalReady();

    if (!editor && pendingInitialContent !== null) {
      initializeEditor(pendingInitialContent);
      pendingInitialContent = null;
    }
  });
} else {
  isDomReady = true;
  signalReady();
  if (!editor && pendingInitialContent !== null) {
    initializeEditor(pendingInitialContent);
    pendingInitialContent = null;
  }
}

// Recovery hooks: if the webview is reclaimed from hidden state and appears blank,
// request host re-sync rather than leaving user with an empty editor.
window.addEventListener('focus', () => {
  scheduleBlankEditorRecovery('focus');
});
window.addEventListener('pageshow', () => {
  scheduleBlankEditorRecovery('pageshow');
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    scheduleBlankEditorRecovery('visible');
  }
});

// Handle custom event for TOC toggle from toolbar button
window.addEventListener('toggleTocOutline', () => {
  if (editor) {
    toggleTocOverlay(editor);
    updateToolbarStates();
  }
});

// Handle copy as markdown from toolbar button
window.addEventListener('copyAsMarkdown', () => {
  if (!editor) return;
  copySelectionAsMarkdown(editor);
});

// Handle open source view from toolbar button
window.addEventListener('openSourceView', () => {
  console.log('[MD4H] Opening source view...');
  vscode.postMessage({ type: 'openSourceView' });
});

// Handle settings button from toolbar -> open VS Code settings UI
window.addEventListener('openExtensionSettings', () => {
  vscode.postMessage({ type: 'openExtensionSettings' });
});

// Handle attachments button from toolbar -> open attachments folder in OS explorer
window.addEventListener('openAttachmentsFolder', () => {
  vscode.postMessage({ type: 'openAttachmentsFolder' });
});

// Handle export document from toolbar button
window.addEventListener('exportDocument', async (event: Event) => {
  if (!editor) return;

  const customEvent = event as CustomEvent;
  const format = customEvent.detail?.format || 'pdf';

  console.log(`[MD4H] Exporting document as ${format}...`);

  try {
    // Collect content and convert Mermaid to PNG
    const exportData = await collectExportContent(editor);
    const title = getDocumentTitle(editor);

    // Send to extension for export
    vscode.postMessage({
      type: 'exportDocument',
      format,
      html: exportData.html,
      mermaidImages: exportData.mermaidImages,
      title,
    });
  } catch (error) {
    console.error('[MD4H] Export failed:', error);
    vscode.postMessage({
      type: 'showError',
      message: 'Failed to prepare document for export. See console for details.',
    });
  }
});

// Handle paste - convert markdown to HTML for proper TipTap rendering
// Must use capture phase to intercept BEFORE TipTap's default handling
document.addEventListener(
  'paste',
  (event: ClipboardEvent) => {
    if (!editor) return;

    const clipboardData = event.clipboardData;
    if (!clipboardData) return;

    // If cursor is inside a code block, handle specially
    if (editor.isActive('codeBlock')) {
      event.preventDefault();
      event.stopPropagation();

      const plainText = clipboardData.getData('text/plain') || '';

      // Check if pasted content is a fenced code block
      const fenced = parseFencedCode(plainText);
      const codeToInsert = fenced ? fenced.content : plainText;

      // Insert as plain text (TipTap will handle it correctly in code block)
      editor.commands.insertContent(codeToInsert);
      return;
    }

    const result = processPasteContent(clipboardData);

    // Images handled by imageDragDrop - don't interfere
    if (result.isImage) {
      return;
    }

    // If we need to convert content (rich HTML or markdown), intercept early
    if (result.wasConverted && result.content && result.isHtml) {
      event.preventDefault();
      event.stopPropagation();
      // Insert HTML - TipTap parses it into proper nodes (tables, lists, etc.)
      editor.commands.insertContent(result.content);
    }
    // Otherwise: default paste behavior for plain text
  },
  true // Capture phase - runs BEFORE TipTap's handlers
);

// Global error handler
window.addEventListener('error', event => {
  console.error('[MD4H] Uncaught error:', event.error);
});

window.addEventListener('unhandledrejection', event => {
  console.error('[MD4H] Unhandled promise rejection:', event.reason);
});

// Testing hooks (not used in production UI)
export const __testing = {
  setMockEditor(mockEditor: any) {
    editor = mockEditor;
  },
  updateEditorContentForTests(markdown: string) {
    return updateEditorContent(markdown);
  },
  trackSentContentForTests(content: string) {
    trackSentContent(content);
  },
  getLastSentContentHash() {
    return lastSentContentHash;
  },
  resetSyncState() {
    lastSentContentHash = null;
    lastSentTimestamp = 0;
  },
};
