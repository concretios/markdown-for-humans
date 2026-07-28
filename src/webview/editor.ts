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
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { ListKit } from '@tiptap/extension-list';
import Link from '@tiptap/extension-link';
import { CustomImage } from './extensions/customImage';
import { lowlight } from 'lowlight';
import { Mermaid } from './extensions/mermaid';
import { IndentedImageCodeBlock } from './extensions/indentedImageCodeBlock';
import { CodeBlockWithCopy } from './extensions/codeBlockWithCopy';
import { SpaceFriendlyImagePaths } from './extensions/spaceFriendlyImagePaths';
import { TabIndentation } from './extensions/tabIndentation';
import { GitHubAlerts } from './extensions/githubAlerts';
import { ImageEnterSpacing } from './extensions/imageEnterSpacing';
import { MarkdownParagraph } from './extensions/markdownParagraph';
import { BlankLinePreservation } from './extensions/blankLinePreservation';
import { OrderedListMarkdownFix } from './extensions/orderedListMarkdownFix';
import { HtmlPreservingTable } from './extensions/htmlPreservingTable';
import { DraggableBlocks } from './extensions/draggableBlocks';
import { DocumentAuditExtension } from './features/auditDocument';
import { createFormattingToolbar, createTableMenu, updateToolbarStates } from './BubbleMenuView';
import { getEditorMarkdownForSync } from './utils/markdownSerialization';
import type { BlankLineMode } from '../shared/blankLinePolicy';
import { overrideClassFor, type EditorThemeSetting } from '../shared/editorTheme';
import { installBlankLineLexerNormalizer } from './utils/markedLexerNormalizer';
import {
  setupImageDragDrop,
  hasPendingImageSaves,
  getPendingImageCount,
} from './features/imageDragDrop';
import { toggleTocOverlay } from './features/tocOverlay';
import { showSearchOverlay } from './features/searchOverlay';
import { showLinkDialog } from './features/linkDialog';
import { processPasteContent, parseFencedCode } from './utils/pasteHandler';
import { copySelectionAsMarkdown } from './utils/copyMarkdown';
import { copyAiContextReference, type SelectionBlockRange } from './utils/aiContextReference';
import { shouldAutoLink } from './utils/linkValidation';
import { buildOutlineFromEditor } from './utils/outline';
import { scrollToHeading } from './utils/scrollToHeading';
import { collectExportContent, getDocumentTitle } from './utils/exportContent';

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
import {
  handleImageResized,
  showResizeModalAfterDownload,
  showImageResizeModal,
} from './features/imageResizeModal';
import {
  clearImageMetadataCache,
  updateImageMetadataDimensions,
  getCachedImageMetadata,
} from './features/imageMetadata';
// Import rename dialog to register global function
import './features/imageRenameDialog';

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

// Message type for communication between extension and webview
interface WebviewMessage {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

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
  }
}

const vscode = acquireVsCodeApi();

// Make vscode API available globally for toolbar buttons
window.vscode = vscode;

let editor: Editor | null = null;
let isUpdating = false; // Prevent feedback loops
let formattingToolbar: HTMLElement;
let tableMenu: HTMLElement;
let updateTimeout: number | null = null;
let lastUserEditTime = 0; // Track when user last edited
let pendingInitialContent: string | null = null; // Content from host before editor is ready
let hasSentReadySignal = false;
let isDomReady = document.readyState !== 'loading';
let outlineUpdateTimeout: number | null = null;
let allowNextHostSyncDespiteRecentEdit = false;
let allowNextHostSyncDespiteEchoHash = false;

// Hash-based sync deduplication (replaces unreliable ignoreNextUpdate boolean)
let lastSentContentHash: string | null = null;
let lastSentTimestamp = 0;

// Performance and Sync constants (m3)
const DEBOUNCE_SYNC_MS = 500;
const SYNC_ECHO_TIMEOUT_MS = 2000;
const RECENT_EDIT_THRESHOLD_MS = 2000;
const OUTLINE_UPDATE_DEBOUNCE_MS = 250;

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
const signalReady = () => {
  if (hasSentReadySignal) return;
  vscode.postMessage({ type: 'ready' });
  hasSentReadySignal = true;
};

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
  if (outlineUpdateTimeout) window.clearTimeout(outlineUpdateTimeout);
  outlineUpdateTimeout = window.setTimeout(() => {
    pushOutlineUpdate();
    outlineUpdateTimeout = null;
  }, OUTLINE_UPDATE_DEBOUNCE_MS);
};

function isPlainFindShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>
): boolean {
  const hasPrimaryModifier = Boolean(event.metaKey) !== Boolean(event.ctrlKey);
  return hasPrimaryModifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f';
}
// Pending AI context reference requests, keyed by requestId. The host saves the
// document and replies with `aiContextRefResponse`; we look up the resolver here.
const aiContextRefCallbacks = new Map<
  string,
  (response: { ref?: string; relPath?: string; error?: string }) => void
>();

// Webview-only "remember choice for this session" preference for the
// copy-AI-context save dialog. Cleared whenever the webview is reloaded.
let aiContextSessionSkipSave = false;
// Mirrors the user setting `markdownForHumans.copyAiContextRef.skipSaveWarning`,
// kept in sync via `update` and `settingsUpdate` messages from the host.
let aiContextSkipSaveWarningSetting = false;
let blankLineMode: BlankLineMode = 'strip';

// Pending document-dirty queries, keyed by requestId. The host replies with
// `documentDirtyResponse`; we look up the resolver here.
const documentDirtyCallbacks = new Map<string, (isDirty: boolean) => void>();

function queryDocumentDirty(): Promise<boolean> {
  return new Promise(resolve => {
    const requestId = `is-dirty-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    documentDirtyCallbacks.set(requestId, resolve);
    vscode.postMessage({ type: 'queryDocumentDirty', requestId });
    // Defensive timeout so a missing host reply can't wedge the toolbar.
    setTimeout(() => {
      if (documentDirtyCallbacks.delete(requestId)) {
        // Treat unknown state as "needs confirmation" — safer than silently saving.
        resolve(true);
      }
    }, 2000);
  });
}

async function runCopyAiContextRef(): Promise<void> {
  if (!editor) return;

  // Snapshot focus synchronously, before any await. ProseMirror keeps a stale
  // selection in place after the editor blurs, so if the user clicked outside
  // the editor (another panel, the toolbar) we'd otherwise copy `#N` pointing
  // at whatever line was last touched. The toolbar's AI-Ref button uses
  // `mousedown` preventDefault so clicking it doesn't blur the editor — meaning
  // `isFocused` here accurately answers "is the user currently engaged with
  // the document?". When false, we copy `@file` without a line range.
  const selectionIsActive = editor.isFocused;

  const { showToast } = await import('./features/auditOverlay');

  // The reference encodes line numbers from the on-disk file, so a dirty buffer
  // forces a save before the copy. Ask the user before saving on their behalf —
  // unless they've already opted out for this session or via the setting.
  const isDirty = await queryDocumentDirty();
  const needsConfirmation =
    isDirty && !aiContextSessionSkipSave && !aiContextSkipSaveWarningSetting;

  if (needsConfirmation) {
    const { showAiContextSaveWarning } = await import('./features/aiContextSaveWarning');
    const choice = await showAiContextSaveWarning();
    if (!choice.confirmed) {
      showToast('AI reference copy cancelled — file not saved', 'info');
      return;
    }
    if (choice.rememberForSession) {
      aiContextSessionSkipSave = true;
    }
  }

  const result = await copyAiContextReference(
    editor,
    blankLineMode,
    (range: SelectionBlockRange | null) => {
      return new Promise(resolve => {
        const requestId = `ai-ref-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        aiContextRefCallbacks.set(requestId, resolve);
        // A null range means we couldn't map the cursor to any block; the host
        // replies with the bare workspace-relative path and we paste `@path`
        // (no `#N`).
        vscode.postMessage({
          type: 'getAiContextRef',
          requestId,
          startLine: range?.startLine,
          endLine: range?.endLine,
        });
      });
    },
    { selectionIsActive }
  );
  if (result.success) {
    showToast(`Copied AI reference: ${result.ref}`, 'success');
  } else {
    showToast(result.error || 'Could not copy AI reference', 'info');
  }
}

// Global function for resolving image paths (used by CustomImage extension)
const uriResolveCallbacks = new Map<string, (uri: string) => void>();
window.resolveImagePath = function (relativePath: string): Promise<string> {
  return new Promise(resolve => {
    const requestId = `resolve-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    uriResolveCallbacks.set(requestId, resolve);
    vscode.postMessage({
      type: 'resolveImageUri',
      requestId,
      relativePath,
    });
  });
};

type ImageReferenceMatch = { line: number; text: string };
type ImageReferencesPayload = {
  requestId: string;
  imagePath: string;
  currentFileCount: number;
  otherFiles: Array<{ fsPath: string; matches: ImageReferenceMatch[] }>;
  error?: string;
};

const imageReferencesCallbacks = new Map<string, (payload: ImageReferencesPayload) => void>();
window.getImageReferences = function (imagePath: string): Promise<unknown> {
  return new Promise(resolve => {
    const requestId = `refs-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    imageReferencesCallbacks.set(requestId, resolve as (payload: ImageReferencesPayload) => void);
    vscode.postMessage({
      type: 'getImageReferences',
      requestId,
      imagePath,
    });
  });
};

type ImageRenameCheckPayload = {
  requestId: string;
  exists: boolean;
  newFilename: string;
  newPath: string;
  error?: string;
};

const imageRenameCheckCallbacks = new Map<string, (payload: ImageRenameCheckPayload) => void>();
window.checkImageRename = function (oldPath: string, newName: string): Promise<unknown> {
  return new Promise(resolve => {
    const requestId = `renamecheck-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    imageRenameCheckCallbacks.set(requestId, resolve as (payload: ImageRenameCheckPayload) => void);
    vscode.postMessage({
      type: 'checkImageRename',
      requestId,
      oldPath,
      newName,
    });
  });
};

// Global function for setting up image resize (used by CustomImage extension)
window.setupImageResize = function (
  img: HTMLImageElement,
  editorInstance?: Editor,
  vscodeApi?: VsCodeApi
): void {
  const editorToUse = editorInstance || editor;
  if (!editorToUse) {
    console.warn('[MD4H] setupImageResize called before editor is ready');
    return;
  }

  const apiToUse = vscodeApi || vscode;
  void showImageResizeModal(img, editorToUse, apiToUse).catch(error => {
    console.error('[MD4H] Failed to open image resize modal:', error);
    apiToUse.postMessage({
      type: 'showError',
      message: 'Failed to open the image resize dialog. Please reload the editor and try again.',
    });
  });
};

/**
 * Immediately send update (used for save shortcuts)
 */
function immediateUpdate() {
  if (!editor) return;

  try {
    // Clear any pending debounced update
    if (updateTimeout) {
      clearTimeout(updateTimeout);
      updateTimeout = null;
    }

    const markdown = getEditorMarkdownForSync(editor, blankLineMode);
    trackSentContent(markdown);
    // Save-time policy enforcement (e.g. strip blank lines) should be reflected
    // immediately in the editor UI even if the user just typed.
    allowNextHostSyncDespiteRecentEdit = true;
    allowNextHostSyncDespiteEchoHash = true;

    console.log('[MD4H] Immediate save triggered');

    // Send edit first
    vscode.postMessage({
      type: 'edit',
      content: markdown,
      editReason: 'save-policy-enforce',
    });

    // Then tell VS Code to save the file
    setTimeout(() => {
      vscode.postMessage({
        type: 'save',
      });
    }, 50); // Small delay to ensure edit is processed first
  } catch (error) {
    console.error('[MD4H] Error in immediate save:', error);
  }
}

/**
 * Debounced update with error handling
 * Prevents sync while images are being saved to avoid race conditions
 */
function debouncedUpdate(markdown: string) {
  if (updateTimeout) window.clearTimeout(updateTimeout);
  updateTimeout = window.setTimeout(() => {
    try {
      // Check if any images are currently being saved
      if (hasPendingImageSaves()) {
        const count = getPendingImageCount();
        console.log(`[MD4H] Delaying document sync - ${count} image(s) still being saved`);
        // Reschedule the update to check again
        debouncedUpdate(markdown);
        return;
      }

      // Track content hash to detect and ignore echo updates
      trackSentContent(markdown);

      vscode.postMessage({
        type: 'edit',
        content: markdown,
        editReason: 'typing',
      });
    } catch (error) {
      console.error('[MD4H] Error sending update:', error);
    }
  }, DEBOUNCE_SYNC_MS);
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
        CodeBlockWithCopy.configure({
          lowlight,
          HTMLAttributes: {
            class: 'code-block-highlighted',
          },
          defaultLanguage: 'plaintext',
          enableTabIndentation: true, // Enable Tab key for indentation
          tabSize: 2, // 2 spaces per tab (cleaner for markdown code blocks)
        }),
        BlankLinePreservation, // Converts extra blank lines (space tokens) to empty paragraphs on parse
        Markdown.configure({
          markedOptions: {
            gfm: true, // GitHub Flavored Markdown for tables, task lists
            breaks: true, // Preserve single newlines as <br>
          },
        }),
        HtmlPreservingTable.configure({
          resizable: true,
          HTMLAttributes: {
            class: 'markdown-table',
          },
        }),
        TableRow,
        TableHeader,
        TableCell,
        ListKit.configure({
          orderedList: false,
          taskItem: {
            nested: true,
          },
        }),
        OrderedListMarkdownFix,
        TabIndentation, // Enable Tab/Shift+Tab for list indentation
        ImageEnterSpacing, // Handle Enter key around images and gap cursor
        Link.configure({
          openOnClick: false,
          HTMLAttributes: {
            class: 'markdown-link',
          },
          shouldAutoLink,
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (CustomImage as any).configure({
          allowBase64: true, // Allow base64 for preview
          HTMLAttributes: {
            class: 'markdown-image',
          },
          // Inject the global setting here.
          // The extension will call this function whenever it needs to check the state.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getShowImageHoverOverlay: () => (window as any).showImageHoverOverlay,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
        DraggableBlocks,
        DocumentAuditExtension,
      ],
      // Don't pass content here - we'll set it after init with contentType: 'markdown'
      editorProps: {
        attributes: {
          class: 'markdown-editor',
          spellcheck: 'true',
        },
        // Prevent default image drop handling - let our custom handler manage it
        handleDrop: (_view, event, _slice, _moved) => {
          const dt = event.dataTransfer;
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
      onUpdate: ({ editor }) => {
        if (isUpdating) return;

        try {
          // Track when user last edited
          lastUserEditTime = Date.now();

          const markdown = getEditorMarkdownForSync(editor, blankLineMode);
          debouncedUpdate(markdown);
          scheduleOutlineUpdate();
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
      onCreate: () => {
        console.log('[MD4H] Editor created successfully');
      },
      onDestroy: () => {
        console.log('[MD4H] Editor destroyed');
      },
    });

    editor = editorInstance;

    // Patch the marked lexer used by @tiptap/markdown so blank lines that
    // marked greedily absorbs into heading/table/code/hr tokens get split
    // back out as "space" tokens. Without this, BlankLinePreservation only
    // works for paragraph-followed-by-blank-lines cases.
    try {
      const markdownStorage = editorInstance as unknown as {
        markdown?: { instance?: unknown };
        storage?: { markdown?: { instance?: unknown } };
      };
      const markedInstance =
        markdownStorage.markdown?.instance ?? markdownStorage.storage?.markdown?.instance;
      if (markedInstance) {
        installBlankLineLexerNormalizer(markedInstance);
      }
    } catch (error) {
      console.warn('[MD4H] Failed to install blank-line lexer normalizer:', error);
    }

    // Set initial content as markdown (Tiptap v3 requires explicit contentType)
    if (initialContent) {
      // Prevent onUpdate from firing during initialization - this was causing
      // documents with frontmatter to be marked dirty even without user edits
      isUpdating = true;
      editor.commands.setContent(initialContent, { contentType: 'markdown' });
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
    let ctrlKPressed = false;
    let ctrlKTimer: number | null = null;

    const keydownHandler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey; // Cmd on Mac, Ctrl on Windows/Linux

      // Save shortcut - immediate save
      // Save shortcut - immediate save
      if (isMod && e.key === 's') {
        e.preventDefault();
        e.stopPropagation();
        immediateUpdate();

        document.body.classList.add('saving-feedback');
        setTimeout(() => {
          document.body.classList.remove('saving-feedback');
        }, 150);

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
        // TipTap will handle the formatting
        return;
      }

      // Handle Ctrl+K chord for link insertion
      if (isMod && e.key === 'k') {
        // Start chord detection - set flag and timer
        ctrlKPressed = true;
        if (ctrlKTimer) {
          clearTimeout(ctrlKTimer);
        }
        ctrlKTimer = window.setTimeout(() => {
          ctrlKPressed = false;
          ctrlKTimer = null;
        }, 1000); // 1 second timeout for chord completion
        return;
      }

      // Check for Cmd/Ctrl+K Cmd/Ctrl+L chord completion
      if (ctrlKPressed && isMod && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        e.stopPropagation();
        if (editor) {
          showLinkDialog(editor);
        }
        // Reset chord state
        ctrlKPressed = false;
        if (ctrlKTimer) {
          clearTimeout(ctrlKTimer);
          ctrlKTimer = null;
        }
        return;
      }

      // Reset chord state on any other key press
      if (ctrlKPressed && (!isMod || e.key !== 'l')) {
        ctrlKPressed = false;
        if (ctrlKTimer) {
          clearTimeout(ctrlKTimer);
          ctrlKTimer = null;
        }
      }

      // Intercept Cmd/Ctrl+F for in-document search
      if (isPlainFindShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (editor) {
          showSearchOverlay(editor);
        }
        return;
      }

      // Cmd/Ctrl+Alt+C — Copy current selection as @file#lines AI context reference.
      // VS Code keybindings declared in package.json don't fire while focus is
      // inside a webview iframe, so we have to detect the chord here ourselves.
      // Match e.code instead of e.key because Ctrl+Alt on Windows is the AltGr
      // modifier on some layouts and can rewrite e.key to a non-letter glyph.
      if (isMod && e.altKey && (e.code === 'KeyC' || e.key.toLowerCase() === 'c')) {
        e.preventDefault();
        e.stopPropagation();
        void runCopyAiContextRef();
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (!(link as any)._linkHandlerAdded) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
 * Handle messages from extension
 */
window.addEventListener('message', (event: MessageEvent) => {
  try {
    const message = event.data as WebviewMessage;

    switch (message.type) {
      case 'update':
        // Store skipResizeWarning setting if present
        if (typeof message.skipResizeWarning === 'boolean') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).skipResizeWarning = message.skipResizeWarning;
        }
        if (typeof message.skipAiContextSaveWarning === 'boolean') {
          aiContextSkipSaveWarningSetting = message.skipAiContextSaveWarning;
        }
        if (message.blankLineMode === 'preserve' || message.blankLineMode === 'strip') {
          blankLineMode = message.blankLineMode;
        }
        // Store imagePath setting if present
        if (typeof message.imagePath === 'string') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).imagePath = message.imagePath;
        }
        if (typeof message.imagePathBase === 'string') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).imagePathBase = message.imagePathBase;
        }
        applyEditorSettings(message);
        // Initialize editor with first payload to seed undo history correctly
        if (!editor) {
          if (isDomReady) {
            initializeEditor(message.content);
          } else {
            pendingInitialContent = message.content;
          }
          return;
        }
        updateEditorContent(message.content);
        break;
      case 'settingsUpdate':
        // Update skipResizeWarning setting
        if (typeof message.skipResizeWarning === 'boolean') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).skipResizeWarning = message.skipResizeWarning;
        }
        if (typeof message.skipAiContextSaveWarning === 'boolean') {
          aiContextSkipSaveWarningSetting = message.skipAiContextSaveWarning;
        }
        if (message.blankLineMode === 'preserve' || message.blankLineMode === 'strip') {
          blankLineMode = message.blankLineMode;
        }
        // Update imagePath setting
        if (typeof message.imagePath === 'string') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).imagePath = message.imagePath;
        }
        if (typeof message.imagePathBase === 'string') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).imagePathBase = message.imagePathBase;
        }
        // Update showImageHoverOverlay setting
        if (typeof message.showImageHoverOverlay === 'boolean') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).showImageHoverOverlay = message.showImageHoverOverlay;
        }
        applyEditorSettings(message);
        break;
      case 'imageResized': {
        // Handle image resize completion
        if (message.success && message.imagePath && message.backupPath) {
          const timestamp = (message.timestamp as number) || Date.now();
          const newImagePath = message.newImagePath as string | undefined;
          const newWidth = message.newWidth as number | undefined;
          const newHeight = message.newHeight as number | undefined;

          // Cache-bust image reloads (especially important when the NodeView is recreated).
          const cacheBustMap =
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ((window as any)._imageCacheBust as Map<string, number> | undefined) ??
            new Map<string, number>();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any)._imageCacheBust = cacheBustMap;
          if (typeof message.imagePath === 'string') {
            cacheBustMap.set(message.imagePath, timestamp);
          }
          if (typeof newImagePath === 'string') {
            cacheBustMap.set(newImagePath, timestamp);
          }

          // Find the image element by path
          const images = document.querySelectorAll('.markdown-image');
          for (const img of images) {
            const imgElement = img as HTMLImageElement;
            const imgPath =
              imgElement.getAttribute('data-markdown-src') || imgElement.getAttribute('src') || '';
            if (imgPath === message.imagePath || imgPath.endsWith(message.imagePath)) {
              // Get old metadata before clearing cache
              const oldMetadata = getCachedImageMetadata(imgPath);

              // Clear metadata cache for both old and new paths
              clearImageMetadataCache(imgPath);
              if (newImagePath && newImagePath !== imgPath) {
                clearImageMetadataCache(newImagePath);
              }

              // Immediately update metadata cache with new dimensions if provided
              // This ensures correct dimensions are shown even before image fully loads
              if (newWidth !== undefined && newHeight !== undefined) {
                const metadataPath =
                  newImagePath && newImagePath !== imgPath ? newImagePath : imgPath;
                updateImageMetadataDimensions(
                  metadataPath,
                  { width: newWidth, height: newHeight },
                  oldMetadata
                );
              }

              handleImageResized(message.backupPath, imgElement);

              // Update TipTap node attributes if new path is provided (includes dimensions)
              if (newImagePath && editor) {
                // Find the wrapper and get position from it (imgElement is inside wrapper)
                const wrapper = imgElement.closest('.image-wrapper');
                if (wrapper) {
                  // Get position from wrapper (the actual ProseMirror node)
                  const pos = editor.view.posAtDOM(wrapper, 0);
                  if (pos !== undefined && pos !== null) {
                    // Get the node at this position
                    const node = editor.state.doc.nodeAt(pos);
                    if (node && node.type.name === 'image') {
                      // Update image node attributes with new path (includes dimensions)
                      // This will trigger onUpdate automatically, which syncs markdown
                      editor
                        .chain()
                        .setNodeSelection(pos)
                        .updateAttributes('image', {
                          src: newImagePath,
                          'markdown-src': newImagePath,
                        })
                        .run();
                    }
                  }
                }
              }

              // Update DOM attributes
              if (newImagePath) {
                imgElement.setAttribute('data-markdown-src', newImagePath);
              }

              // Force image reload with cache-busting to show resized version
              // The image file has been overwritten, but browser may have cached the old version
              const currentSrc = imgElement.src;
              if (currentSrc && !currentSrc.includes('?t=')) {
                // Add timestamp query parameter to force reload
                const separator = currentSrc.includes('?') ? '&' : '?';
                imgElement.src = `${currentSrc}${separator}t=${timestamp}`;
              } else {
                // Already has timestamp, replace it
                imgElement.src = currentSrc.replace(/[?&]t=\d+/, `?t=${timestamp}`);
              }
              break;
            }
          }
        }
        break;
      }
      case 'imageUndoResized':
      case 'imageRedoResized':
        // Image undo/redo completed - image file already updated by extension
        // Just refresh the image src to show updated version
        if (message.success && message.imagePath) {
          const timestamp = Date.now();
          const images = document.querySelectorAll('.markdown-image');
          for (const img of images) {
            const imgElement = img as HTMLImageElement;
            const imgPath =
              imgElement.getAttribute('data-markdown-src') || imgElement.getAttribute('src') || '';
            if (imgPath === message.imagePath || imgPath.endsWith(message.imagePath)) {
              // Clear metadata cache to force fresh fetch with updated dimensions
              clearImageMetadataCache(imgPath);

              // Force image reload with cache-busting
              const currentSrc = imgElement.src;
              if (currentSrc) {
                const separator = currentSrc.includes('?') ? '&' : '?';
                imgElement.src = currentSrc.split(/[?&]t=/)[0] + `${separator}t=${timestamp}`;
              }
              break;
            }
          }
        }
        break;
      case 'imageWorkspaceCheck': {
        // Response to checkImageInWorkspace request
        const requestId = message.requestId as string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const callbacks = (window as any)._workspaceCheckCallbacks;
        if (callbacks && callbacks.has(requestId)) {
          const callback = callbacks.get(requestId);
          callback({
            inWorkspace: message.inWorkspace as boolean,
            absolutePath: message.absolutePath as string | undefined,
          });
          callbacks.delete(requestId);
        }
        break;
      }
      case 'imageReferences': {
        const requestId = message.requestId as string;
        const callback = imageReferencesCallbacks.get(requestId);
        if (callback) {
          callback(message as unknown as ImageReferencesPayload);
          imageReferencesCallbacks.delete(requestId);
        }
        break;
      }
      case 'imageRenameCheck': {
        const requestId = message.requestId as string;
        const callback = imageRenameCheckCallbacks.get(requestId);
        if (callback) {
          callback(message as unknown as ImageRenameCheckPayload);
          imageRenameCheckCallbacks.delete(requestId);
        }
        break;
      }
      case 'auditCheckFileResult': {
        import('./features/auditDocument').then(({ handleAuditCheckResult }) => {
          handleAuditCheckResult(
            message.requestId as string,
            message.exists as boolean,
            message.suggestions as string[] | undefined
          );
        });
        break;
      }
      case 'auditCheckUrlResult': {
        import('./features/auditDocument').then(({ handleAuditUrlCheckResult }) => {
          handleAuditUrlCheckResult(message.requestId as string, message.reachable as boolean);
        });
        break;
      }
      case 'auditPickFileResult': {
        import('./features/auditDocument').then(({ handleAuditPickFileResult }) => {
          handleAuditPickFileResult(
            message.requestId as string,
            (message.selectedPath as string | null) ?? null
          );
        });
        break;
      }
      case 'imageMetadata': {
        // Response to getImageMetadata request
        const requestId = message.requestId as string;
        const metadata = message.metadata;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const callbacks = (window as any)._metadataCallbacks;
        if (callbacks && callbacks.has(requestId)) {
          const callback = callbacks.get(requestId);

          // Check if we already have cached metadata with dimensions (e.g., from resize)
          const imagePath = metadata?.path;
          const cachedMetadata = imagePath ? getCachedImageMetadata(imagePath) : null;
          const preservedDimensions =
            cachedMetadata &&
            cachedMetadata.dimensions.width > 0 &&
            cachedMetadata.dimensions.height > 0
              ? cachedMetadata.dimensions
              : null;

          // If metadata has dimensions 0x0, try to get from img element or use preserved dimensions
          if (metadata && metadata.dimensions && metadata.dimensions.width === 0) {
            // First, try to use preserved dimensions from cache (set during resize)
            if (preservedDimensions) {
              metadata.dimensions = preservedDimensions;
            } else {
              // Fall back to getting dimensions from img element
              const images = document.querySelectorAll('.markdown-image');
              for (const img of images) {
                const imgElement = img as HTMLImageElement;
                const imgPath =
                  imgElement.getAttribute('data-markdown-src') ||
                  imgElement.getAttribute('src') ||
                  '';
                // Match by exact path or if one ends with the other (handles relative path variations)
                if (
                  imgPath === imagePath ||
                  imgPath.endsWith(imagePath) ||
                  imagePath.endsWith(imgPath)
                ) {
                  // Prefer naturalWidth/naturalHeight (actual image file dimensions)
                  // These reflect the actual resized image dimensions after resize
                  const width = imgElement.naturalWidth || imgElement.width || 0;
                  const height = imgElement.naturalHeight || imgElement.height || 0;

                  if (width > 0 && height > 0) {
                    metadata.dimensions = {
                      width,
                      height,
                    };
                  }
                  break;
                }
              }
            }
          } else if (preservedDimensions && metadata) {
            // If we have preserved dimensions and metadata already has dimensions, prefer preserved (more recent)
            metadata.dimensions = preservedDimensions;
          }

          callback(metadata);
          callbacks.delete(requestId);
        }
        break;
      }
      case 'localImageCopied': {
        // Local image copied to workspace - update TipTap node and show resize modal
        if (!editor) break;

        const relativePath = message.relativePath as string;
        const originalPath = message.originalPath as string;

        // Find the image element in DOM first (more reliable than searching doc)
        const images = document.querySelectorAll('.markdown-image');
        let imgElement: HTMLImageElement | null = null;

        for (const img of images) {
          const element = img as HTMLImageElement;
          const imgSrc =
            element.getAttribute('data-markdown-src') || element.getAttribute('src') || '';
          // Check if this matches the original path (could be relative or absolute)
          if (
            imgSrc === originalPath ||
            imgSrc.includes(originalPath) ||
            originalPath.includes(imgSrc)
          ) {
            imgElement = element;
            break;
          }
        }

        if (!imgElement) {
          console.warn('[MD4H] Could not find image element for local image copy');
          break;
        }

        // Get position from DOM element
        const pos = editor.view.posAtDOM(imgElement, 0);

        if (pos === undefined || pos === null) {
          console.warn('[MD4H] Could not find position for image in editor');
          break;
        }

        // Get the node at this position
        const node = editor.state.doc.nodeAt(pos);

        if (!node || node.type.name !== 'image') {
          console.warn(`[MD4H] Node at position ${pos} is not an image: ${node?.type.name}`);
          break;
        }

        // Update image node attributes using updateAttributes (safer than setNodeMarkup)
        try {
          editor
            .chain()
            .setNodeSelection(pos)
            .updateAttributes('image', {
              src: relativePath,
              'markdown-src': relativePath,
            })
            .run();

          // Update DOM attributes
          imgElement.setAttribute('data-markdown-src', relativePath);
          imgElement.setAttribute('src', relativePath);

          // Clear pending copy flags
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          delete (imgElement as any)._pendingDownloadPlaceholderId;

          // If this image was pending resize after copy, show resize modal now
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((imgElement as any)._pendingResizeAfterDownload) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            delete (imgElement as any)._pendingResizeAfterDownload;

            // Wait for image to load, then show resize modal
            const showModalAfterLoad = () => {
              if (editor && imgElement) {
                showResizeModalAfterDownload(imgElement, editor, vscode);
              }
            };

            if (imgElement.complete) {
              showModalAfterLoad();
            } else {
              imgElement.addEventListener('load', showModalAfterLoad, { once: true });

              // Request resolution for the new local path
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if ((window as any).resolveImagePath) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (window as any).resolveImagePath(relativePath).then((webviewUri: string) => {
                  if (imgElement) {
                    imgElement.src = webviewUri;
                    imgElement.setAttribute('data-markdown-src', relativePath);
                  }
                });
              } else {
                const newSrc = relativePath.startsWith('./') ? relativePath : `./${relativePath}`;
                imgElement.src = newSrc;
                imgElement.setAttribute('data-markdown-src', relativePath);
              }
            }
          }
        } catch (error) {
          console.error('[MD4H] Failed to update image node after copy:', error);
        }
        break;
      }
      case 'localImageCopyError': {
        // Local image copy failed
        const error = message.error as string;
        console.error('[MD4H] Local image copy failed:', error);
        // Error already shown by extension, just clean up any pending state
        const images = document.querySelectorAll('.markdown-image');
        for (const img of images) {
          const imgElement = img as HTMLImageElement;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((imgElement as any)._pendingDownloadPlaceholderId === message.placeholderId) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            delete (imgElement as any)._pendingDownloadPlaceholderId;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            delete (imgElement as any)._pendingResizeAfterDownload;
          }
        }
        break;
      }
      case 'imageUriResolved': {
        // Handle image URI resolution response
        const callback = uriResolveCallbacks.get(message.requestId);
        if (callback) {
          callback(message.webviewUri);
          uriResolveCallbacks.delete(message.requestId);
        }
        break;
      }
      case 'aiContextRefResponse': {
        const requestId = message.requestId as string;
        const callback = aiContextRefCallbacks.get(requestId);
        if (callback) {
          callback({
            ref: message.ref as string | undefined,
            relPath: message.relPath as string | undefined,
            error: message.error as string | undefined,
          });
          aiContextRefCallbacks.delete(requestId);
        }
        break;
      }
      case 'documentDirtyResponse': {
        const requestId = message.requestId as string;
        const callback = documentDirtyCallbacks.get(requestId);
        if (callback) {
          callback(message.isDirty === true);
          documentDirtyCallbacks.delete(requestId);
        }
        break;
      }
      case 'flushPendingEdit': {
        // Host needs the latest content NOW (autosave on focus/window change).
        // If a debounced edit is queued, fire it synchronously so the `edit`
        // message arrives at the host before the ack we send immediately
        // after — guaranteeing the host can rely on the buffer being current.
        const requestId = message.requestId as string;
        try {
          if (editor && updateTimeout !== null) {
            window.clearTimeout(updateTimeout);
            updateTimeout = null;
            const markdown = getEditorMarkdownForSync(editor, blankLineMode);
            trackSentContent(markdown);
            vscode.postMessage({
              type: 'edit',
              content: markdown,
              editReason: 'typing',
            });
          }
        } catch (error) {
          console.error('[MD4H] flushPendingEdit failed:', error);
        }
        vscode.postMessage({ type: 'flushPendingEditAck', requestId });
        break;
      }
      case 'triggerCopyAiContextRef': {
        void runCopyAiContextRef();
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
    if (incomingHash === lastSentContentHash && !allowNextHostSyncDespiteEchoHash) {
      // Also check timestamp to allow legitimate identical content after a delay
      const timeSinceLastSend = Date.now() - lastSentTimestamp;
      if (timeSinceLastSend < SYNC_ECHO_TIMEOUT_MS) {
        console.log('[MD4H] Ignoring update (matches content we just sent)');
        return;
      }
    }
    allowNextHostSyncDespiteEchoHash = false;

    // Don't update if user edited recently to prevent cursor jumping (m3)
    const timeSinceLastEdit = Date.now() - lastUserEditTime;
    if (timeSinceLastEdit < RECENT_EDIT_THRESHOLD_MS && !allowNextHostSyncDespiteRecentEdit) {
      console.log(`[MD4H] Skipping update - user recently edited (${timeSinceLastEdit}ms ago)`);
      return;
    }
    allowNextHostSyncDespiteRecentEdit = false;

    isUpdating = true;

    const startTime = performance.now();
    const docSize = markdown.length;

    console.log(`[MD4H] Updating content (${docSize} chars)...`);

    // Skip if content is already in sync
    const currentMarkdown = getEditorMarkdownForSync(editor, blankLineMode);
    if (currentMarkdown === markdown) {
      console.log('[MD4H] Update skipped (content unchanged)');
      return;
    }

    // Save cursor position
    const { from, to } = editor.state.selection;
    console.log(`[MD4H] Saving cursor position: ${from}-${to}`);

    // Set content
    editor.commands.setContent(markdown, { contentType: 'markdown' });

    // Restore cursor position
    try {
      editor.commands.setTextSelection({ from, to });
      console.log(`[MD4H] Restored cursor position: ${from}-${to}`);
    } catch {
      console.warn('[MD4H] Could not restore exact cursor position, using safe position');
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

/**
 * Detect whether paste is happening inside a code-oriented context.
 * `editor.isActive('codeBlock')` can be false in some node-selection/focus states
 * even though the visible target is a code block (e.g., HTML block UI).
 */
function isCodeContextForPaste(editorInstance: Editor, event: ClipboardEvent): boolean {
  if (editorInstance.isActive('codeBlock')) {
    return true;
  }

  const selection = editorInstance.state.selection as {
    node?: { type?: { name?: string } };
    $from?: { parent?: { type?: { name?: string } } };
    $anchor?: { parent?: { type?: { name?: string } } };
  };

  if (selection?.node?.type?.name === 'codeBlock') {
    return true;
  }

  if (selection?.$from?.parent?.type?.name === 'codeBlock') {
    return true;
  }

  if (selection?.$anchor?.parent?.type?.name === 'codeBlock') {
    return true;
  }

  const target = event.target as HTMLElement | null;
  if (target?.closest('pre.code-block-highlighted')) {
    return true;
  }

  const domSelection = window.getSelection?.();
  const anchorNode = domSelection?.anchorNode;
  const anchorElement =
    anchorNode instanceof HTMLElement ? anchorNode : (anchorNode?.parentElement ?? null);
  if (anchorElement?.closest('pre.code-block-highlighted')) {
    return true;
  }

  return false;
}

function insertRawCodeText(editorInstance: Editor, text: string): void {
  editorInstance.commands.insertContent({
    type: 'text',
    text,
  });
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

// Handle custom event for TOC toggle from toolbar button
window.addEventListener('toggleTocOutline', () => {
  if (editor) {
    toggleTocOverlay(editor);
    updateToolbarStates();
  }
});

// Handle custom event for document audit from toolbar button
window.addEventListener('auditDocument', async () => {
  if (!editor) return;
  console.log('[MD4H] Running document audit...');
  try {
    const { runAudit, auditPluginKey } = await import('./features/auditDocument');
    const { showAuditOverlay, showToast, dismissToast } = await import('./features/auditOverlay');

    // Clear old decorations
    editor.view.dispatch(editor.state.tr.setMeta(auditPluginKey, []));

    // Show loading toast
    const loadingToastId = showToast('Auditing document...', 'loading');

    const issues = await runAudit(editor);
    console.log('[MD4H] Audit complete, issues found:', issues.length);

    // Dismiss loading toast
    dismissToast(loadingToastId);

    showAuditOverlay(editor, issues);

    // Apply decorations
    if (issues.length > 0) {
      editor.view.dispatch(editor.state.tr.setMeta(auditPluginKey, issues));
    }
  } catch (error) {
    console.error('[MD4H] Audit failed:', error);
  }
});

// Handle copy as markdown from toolbar button
window.addEventListener('copyAsMarkdown', () => {
  if (!editor) return;
  copySelectionAsMarkdown(editor);
});

// Handle copy AI context reference from toolbar button
window.addEventListener('copyAiContextRef', () => {
  void runCopyAiContextRef();
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

// Handle theme toggle button from toolbar -> flip the global editorTheme setting.
// The extension computes the opposite of the currently effective theme and
// writes it back, which re-themes every open editor via settingsUpdate.
window.addEventListener('toggleTheme', () => {
  vscode.postMessage({ type: 'toggleTheme' });
});

// Zoom: applies zoom level from markdownForHumans.zoom setting (percentage, 100 = default).
// We use a CSS calc() expression so the override stays live — if the user later changes
// their VS Code editor font size, --md-base-size-override recomputes automatically
// instead of being locked to the pixel value captured at call time.
function applyZoomLevel(percent: number) {
  const clamped = Math.max(50, Math.min(200, percent));
  if (clamped === 100) {
    document.documentElement.style.removeProperty('--md-base-size-override');
  } else {
    document.documentElement.style.setProperty(
      '--md-base-size-override',
      `calc(var(--vscode-editor-font-size, 14px) * ${clamped / 100})`
    );
  }
}
// Editor theme override.
//
// When the requested direction already matches VS Code's active appearance, no
// class is added and the editor inherits the real live theme (so "Always dark"
// on a dark VS Code looks exactly like the user's actual dark theme); the
// synthetic palette is applied only when forcing the opposite direction.
// 'vscode' always inherits.
//
// The class goes on BOTH <html> and <body>:
//  - <body> carries the --vscode-* variable overrides (they win there via
//    inheritance; VS Code sets those vars inline on <html>, so a class rule on
//    <html> could not override them) and satisfies the syntax-highlight guards
//    (.vscode-dark:not(.mdfh-force-light)) that key off the body class.
//  - <html> paints the overscroll/page background with a literal color so the
//    area around the editor matches (see editor.css).
//
// Self-healing: VS Code reassigns body.className (not classList.add) during its
// theme handshake, which can wipe our class right after the first apply. A
// MutationObserver re-asserts the desired state whenever the class attribute
// changes. reconcile only mutates when out of sync, so it settles in one pass
// and cannot loop.
let lastThemeSetting: EditorThemeSetting = 'vscode';
let lastVscodeIsDark = false;
let themeClassObserver: MutationObserver | null = null;

function reconcileThemeClasses() {
  const forced = overrideClassFor(lastThemeSetting, lastVscodeIsDark);
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    const wantLight = forced === 'mdfh-force-light';
    const wantDark = forced === 'mdfh-force-dark';
    if (el.classList.contains('mdfh-force-light') !== wantLight) {
      el.classList.toggle('mdfh-force-light', wantLight);
    }
    if (el.classList.contains('mdfh-force-dark') !== wantDark) {
      el.classList.toggle('mdfh-force-dark', wantDark);
    }
  }
}

function ensureThemeClassObserver() {
  if (themeClassObserver) return;
  themeClassObserver = new MutationObserver(() => reconcileThemeClasses());
  const opts: MutationObserverInit = { attributes: true, attributeFilter: ['class'] };
  themeClassObserver.observe(document.documentElement, opts);
  themeClassObserver.observe(document.body, opts);
}

function applyThemeOverride(setting: EditorThemeSetting, vscodeIsDark: boolean) {
  lastThemeSetting = setting;
  lastVscodeIsDark = vscodeIsDark;
  reconcileThemeClasses();
  ensureThemeClassObserver();
}

/**
 * Applies paragraph spacing, zoom, and theme-override settings from an incoming
 * message. Called from both the `update` and `settingsUpdate` handlers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyEditorSettings(message: Record<string, any>) {
  if (typeof message.paragraphSpacingBefore === 'number') {
    document.documentElement.style.setProperty(
      '--md-paragraph-spacing-before',
      `${message.paragraphSpacingBefore}pt`
    );
  }
  if (typeof message.paragraphSpacingAfter === 'number') {
    document.documentElement.style.setProperty(
      '--md-paragraph-spacing-after',
      `${message.paragraphSpacingAfter}pt`
    );
  }
  if (typeof message.zoom === 'number') {
    applyZoomLevel(message.zoom);
  }
  if (
    message.editorTheme === 'vscode' ||
    message.editorTheme === 'defaultLight' ||
    message.editorTheme === 'defaultDark'
  ) {
    // The extension reports VS Code's current appearance; fall back to the body
    // class if an older message omits it.
    const vscodeIsDark =
      typeof message.vscodeIsDark === 'boolean'
        ? message.vscodeIsDark
        : document.body.classList.contains('vscode-dark') ||
          document.body.classList.contains('vscode-high-contrast');
    applyThemeOverride(message.editorTheme, vscodeIsDark);
  }
}

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
    if (isCodeContextForPaste(editor, event)) {
      event.preventDefault();
      event.stopPropagation();

      const plainText = clipboardData.getData('text/plain') || '';

      // Check if pasted content is a fenced code block
      const fenced = parseFencedCode(plainText);
      const codeToInsert = fenced ? fenced.content : plainText;

      // Insert as a text node to prevent TipTap from parsing HTML/markdown inside code blocks.
      insertRawCodeText(editor, codeToInsert);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  isCodeContextForPasteForTests(event: ClipboardEvent) {
    if (!editor) return false;
    return isCodeContextForPaste(editor, event);
  },
  insertRawCodeTextForTests(text: string) {
    if (!editor) return;
    insertRawCodeText(editor, text);
  },
  isPlainFindShortcutForTests(event: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  }) {
    return isPlainFindShortcut({
      key: event.key,
      ctrlKey: Boolean(event.ctrlKey),
      metaKey: Boolean(event.metaKey),
      shiftKey: Boolean(event.shiftKey),
      altKey: Boolean(event.altKey),
    });
  },
};
