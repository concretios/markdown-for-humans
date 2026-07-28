/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';
import { isIP } from 'net';
import { outlineViewProvider, type OutlineEntry } from '../features/outlineView';
import { setActiveWebviewPanel, getActiveWebviewPanel } from '../activeWebview';
import { buildResizeBackupLocation, resolveBackupPathWithCollisionDetection } from './imageBackups';
import { hasSameBlankLineLayout, isMarkdownStructurallyEquivalent } from './markdownAstEquivalence';
import { applyBlankLinePolicy, type BlankLineMode } from '../shared/blankLinePolicy';

/**
 * Coerce text to end with exactly one `\n` (markdownlint MD047). An empty
 * string stays empty — we don't want to materialize a single-newline file from
 * an empty webview state.
 */
export function ensureSingleTrailingNewline(text: string): string {
  if (text === '') return text;
  return text.replace(/\n*$/, '\n');
}

/**
 * Parse an image filename to extract source prefix
 * Returns the source prefix (dropped_ or pasted_) if present, or null
 */
export function parseImageSourcePrefix(filename: string): string | null {
  // Check for source prefix: dropped_ or pasted_
  const sourcePattern = /^(dropped_|pasted_)/;
  const match = filename.match(sourcePattern);
  return match ? match[1] : null;
}

/**
 * Build an image filename from components, optionally including a dimensions suffix.
 *
 * Note: manual renames should use `buildImageFilenameForUserRename()` instead so we
 * don't auto-add dimensions or source prefixes based on config.
 *
 * @deprecated Use `buildImageFilenameForUserRename()` for rename and
 *             `updateFilenameDimensions()` for resize flows.
 */
export function buildImageFilenameForRename(
  sourcePrefix: string | null,
  name: string,
  dimensions: { width: number; height: number } | null,
  extension: string,
  includeDimensions: boolean
): string {
  const source = sourcePrefix || '';
  if (!includeDimensions || !dimensions) {
    return `${source}${name}.${extension}`;
  }
  return `${source}${name}_${dimensions.width}x${dimensions.height}px.${extension}`;
}

/**
 * Build an image filename for a user-initiated rename.
 *
 * Rules:
 * - Do not auto-add dimensions.
 * - Do not auto-add or preserve a `dropped_`/`pasted_` prefix.
 * - Treat the user-provided name as authoritative.
 *
 * @param userProvidedName - The new name from the rename dialog (without extension)
 * @param extension - File extension (with or without leading dot)
 */
export function buildImageFilenameForUserRename(
  userProvidedName: string,
  extension: string
): string {
  const normalizedExtension = extension.startsWith('.') ? extension.slice(1) : extension;
  const dot = normalizedExtension ? '.' : '';
  return `${userProvidedName}${dot}${normalizedExtension}`;
}

/**
 * Update dimensions in an image filename while preserving other components.
 *
 * When `includeDimensions` is enabled:
 * - Keep any existing `dropped_`/`pasted_` prefix.
 * - Add/update the `{width}x{height}px` suffix (and remove legacy timestamp formats).
 *
 * When `includeDimensions` is disabled:
 * - Strip BOTH the `dropped_`/`pasted_` prefix and the `{width}x{height}px` suffix.
 * - Keep the base name and extension.
 */
export function updateFilenameDimensions(
  filename: string,
  newWidth: number,
  newHeight: number,
  includeDimensions: boolean = true
): string {
  const extWithDot = path.extname(filename);
  const filenameWithoutExt = extWithDot ? filename.slice(0, -extWithDot.length) : filename;

  const sourcePrefix = parseImageSourcePrefix(filename) || '';
  const filenameWithoutPrefix = sourcePrefix
    ? filenameWithoutExt.slice(sourcePrefix.length)
    : filenameWithoutExt;

  // Old pattern with timestamp: {name}_{timestamp}_{width}x{height}px
  const oldTimestampMatch = filenameWithoutPrefix.match(/^(.+?)_\d{13}_(\d+)x(\d+)px$/);
  if (oldTimestampMatch) {
    const coreName = oldTimestampMatch[1];
    if (!includeDimensions) {
      return `${coreName}${extWithDot}`;
    }
    return `${sourcePrefix}${coreName}_${newWidth}x${newHeight}px${extWithDot}`;
  }

  // New pattern (no timestamp): {name}_{width}x{height}px
  const newPatternMatch = filenameWithoutPrefix.match(/^(.+?)_(\d+)x(\d+)px$/);
  if (newPatternMatch) {
    const coreName = newPatternMatch[1];
    if (!includeDimensions) {
      return `${coreName}${extWithDot}`;
    }
    return `${sourcePrefix}${coreName}_${newWidth}x${newHeight}px${extWithDot}`;
  }

  // Legacy format without dimensions: {name}-{timestamp}
  const legacyMatch = filenameWithoutPrefix.match(/^(.+?)-\d{13}$/);
  if (legacyMatch) {
    const coreName = legacyMatch[1];
    if (!includeDimensions) {
      return `${coreName}${extWithDot}`;
    }
    return `${sourcePrefix}${coreName}_${newWidth}x${newHeight}px${extWithDot}`;
  }

  // Unparseable filename.
  // If dimensions are disabled, still strip any existing source prefix and keep the name.
  if (!includeDimensions) {
    return `${filenameWithoutPrefix}${extWithDot}`;
  }

  // Append dimensions to filename when enabled.
  return `${sourcePrefix}${filenameWithoutPrefix}_${newWidth}x${newHeight}px${extWithDot}`;
}

/**
 * Custom Text Editor Provider for Markdown files
 * Provides WYSIWYG editing using TipTap in a webview
 */
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  private static readonly MD012_MANAGED_STATE_KEY = 'markdownForHumans.blankLines.managedMd012';

  // Dedup the "Save the file to see the changes." prompt across panels.
  // A single blank-line-mode change fires `onDidChangeConfiguration` for every
  // open custom editor; without this we'd stack one toast per open .md file.
  private static lastBlankLineSavePromptAt = 0;

  private getBlankLineMode(): BlankLineMode {
    const config = vscode.workspace.getConfiguration();
    const value = config.get<string>('markdownForHumans.blankLines.mode', 'strip');
    return value === 'preserve' ? 'preserve' : 'strip';
  }

  private async syncMarkdownlintMd012(mode: BlankLineMode): Promise<void> {
    const markdownlintConfig = vscode.workspace.getConfiguration('markdownlint');
    const existing =
      (markdownlintConfig.get<Record<string, unknown>>('config') as Record<string, unknown>) ?? {};
    const managed = this.context.globalState.get<boolean>(
      MarkdownEditorProvider.MD012_MANAGED_STATE_KEY,
      false
    );

    if (mode === 'preserve') {
      if (existing.MD012 !== false) {
        await markdownlintConfig.update(
          'config',
          {
            ...existing,
            MD012: false,
          },
          vscode.ConfigurationTarget.Workspace
        );
        await this.context.globalState.update(MarkdownEditorProvider.MD012_MANAGED_STATE_KEY, true);
      }
      return;
    }

    if (!managed) return;

    if (existing.MD012 === false) {
      const next = { ...existing };
      delete next.MD012;
      await markdownlintConfig.update('config', next, vscode.ConfigurationTarget.Workspace);
    }
    await this.context.globalState.update(MarkdownEditorProvider.MD012_MANAGED_STATE_KEY, false);
  }

  /**
   * Re-apply the current blank-line policy to the backing `TextDocument`.
   *
   * When switching from preserve to strip, `updateWebview` can show stripped
   * markdown while the document buffer still holds extra blank lines; the next
   * save would persist the unstripped buffer. Pushing the policy through
   * `applyEdit` keeps buffer, webview, and the following save aligned.
   */
  private async syncTextDocumentBlankLinePolicy(document: vscode.TextDocument): Promise<void> {
    const raw = document.getText();
    await this.applyEdit(raw, document, { editReason: 'save-policy-enforce' });
  }

  private static readonly URL_CHECK_TIMEOUT_MS = 2000;
  private static readonly MAX_FILE_SEARCH_RESULTS = 2000;

  // Track pending edits to avoid feedback loops
  // Key: document URI, Value: timestamp of last edit from webview
  private pendingEdits = new Map<string, number>();
  // Remember last content sent from the webview so we can skip redundant updates
  private lastWebviewContent = new Map<string, string>();
  // Most recent in-flight `applyEdit` per document. The autosave bridge awaits
  // these before calling `document.save()` so VS Code doesn't persist a stale
  // buffer when the user types and immediately switches focus.
  // Key: document URI, Value: the latest applyEdit promise for that doc.
  private inFlightApplyEdits = new Map<string, Promise<boolean>>();
  // Resolvers for `flushPendingEdit` requests. Keyed by requestId. The webview
  // replies with `flushPendingEditAck` and we resolve the matching promise.
  private flushAckResolvers = new Map<string, () => void>();
  // Panels keyed by document URI so the window-state listener can iterate
  // every open custom editor instead of relying on the single active panel.
  private openPanels = new Map<
    string,
    { panel: vscode.WebviewPanel; document: vscode.TextDocument }
  >();
  // One-shot subscription for `window.onDidChangeWindowState`. Registered the
  // first time a custom editor opens so tests that never call `resolveCustomTextEditor`
  // don't need this VS Code API on their mock.
  private windowStateListener: vscode.Disposable | undefined;
  // --- Audit Search Tuning ---
  /**
   * Minimum length required to attempt ANY file suggestions.
   * Rationale: Filenames under 3 characters (e.g., "a.png", "1.md") are too generic.
   * Searching for them yields too many false positives and creates noisy, unhelpful UI suggestions.
   */
  private readonly MIN_BASENAME_LENGTH_FOR_SUGGESTION = 5;
  /**
   * Minimum length required to trigger broad fuzzy searching (name.).
   * Rationale: Glob fuzzy searches are highly CPU-intensive across large workspaces.
   * Requiring at least 4 characters prevents UI freezes and massive memory spikes
   * that would be caused by generating thousands of matches for short strings like "ab".
   */

  private readonly MIN_BASENAME_LENGTH_FOR_FUZZY = 6;

  private isOutlineEntry(value: unknown): value is OutlineEntry {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as Partial<OutlineEntry>;
    return (
      typeof candidate.level === 'number' &&
      typeof candidate.text === 'string' &&
      typeof candidate.pos === 'number' &&
      typeof candidate.sectionEnd === 'number'
    );
  }

  private parseOutlineEntries(value: unknown): OutlineEntry[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(entry => this.isOutlineEntry(entry));
  }

  private isExportMermaidImage(
    value: unknown
  ): value is { id: string; pngDataUrl: string; originalCode: string; originalSvg: string } {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.id === 'string' &&
      typeof candidate.pngDataUrl === 'string' &&
      typeof candidate.originalCode === 'string' &&
      typeof candidate.originalSvg === 'string'
    );
  }

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new MarkdownEditorProvider(context);
    const providerRegistration = vscode.window.registerCustomEditorProvider(
      'markdownForHumans.editor',
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
          enableFindWidget: true,
        },
        supportsMultipleEditorsPerDocument: false,
      }
    );
    return providerRegistration;
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Get the document directory for file-based documents, or workspace folder for untitled files
   * Returns null if document is untitled and has no workspace
   */
  private getDocumentDirectory(document: vscode.TextDocument): string | null {
    if (document.uri.scheme === 'file') {
      return path.dirname(document.uri.fsPath);
    }
    // For untitled files, getWorkspaceFolder may not work reliably
    // So we check workspaceFolders first, then fall back to getWorkspaceFolder
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      // For untitled files, use the first workspace folder if available
      return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    // Fallback: try getWorkspaceFolder (might work in some cases)
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (workspaceFolder) {
      return workspaceFolder.uri.fsPath;
    }
    return null;
  }

  /**
   * Get the workspace folder path that contains the document, when available.
   *
   * For untitled documents, falls back to the first workspace folder.
   */
  private getWorkspaceFolderPath(document: vscode.TextDocument): string | null {
    const direct = vscode.workspace.getWorkspaceFolder(document.uri);
    if (direct) {
      return direct.uri.fsPath;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return null;
    }

    if (document.uri.scheme === 'untitled') {
      return folders[0].uri.fsPath;
    }

    if (document.uri.scheme === 'file') {
      const docPath = document.uri.fsPath;
      const containing = [...folders]
        .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)
        .find(
          folder =>
            docPath === folder.uri.fsPath || docPath.startsWith(folder.uri.fsPath + path.sep)
        );
      return containing?.uri.fsPath ?? null;
    }

    return null;
  }

  /**
   * Get base path for image operations
   * Returns workspace folder or document directory if available, otherwise OS temp directory.
   * This keeps untitled/no-workspace access more restrictive than using the home directory.
   */
  private getImageBasePath(document: vscode.TextDocument): string | null {
    const docDir = this.getDocumentDirectory(document);
    if (docDir) {
      return docDir;
    }
    // For untitled files without workspace, use temp directory to reduce file system exposure.
    return os.tmpdir();
  }

  /**
   * Get the base directory where new images should be saved.
   *
   * This is separate from `getImageBasePath()` (which is used to resolve
   * existing markdown image links relative to the markdown file).
   */
  private getImageStorageBasePath(document: vscode.TextDocument): string | null {
    const config = vscode.workspace.getConfiguration();
    const imagePathBase = config.get<string>(
      'markdownForHumans.imagePathBase',
      'relativeToDocument'
    );

    // Untitled docs: default to workspace-level saves when possible (we don't know
    // the final markdown file directory yet).
    if (document.uri.scheme === 'untitled') {
      return this.getWorkspaceFolderPath(document) ?? this.getImageBasePath(document);
    }

    if (imagePathBase === 'workspaceFolder') {
      return this.getWorkspaceFolderPath(document) ?? this.getImageBasePath(document);
    }

    // Default: relativeToDocument
    return (
      this.getDocumentDirectory(document) ?? this.getWorkspaceFolderPath(document) ?? os.tmpdir()
    );
  }

  /**
   * Called when our custom editor is opened
   */
  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // Setup webview options
    // Allow loading resources from extension and the workspace folder containing the document
    let workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    // For untitled files, getWorkspaceFolder may not work, so check workspaceFolders
    if (
      !workspaceFolder &&
      document.uri.scheme === 'untitled' &&
      vscode.workspace.workspaceFolders &&
      vscode.workspace.workspaceFolders.length > 0
    ) {
      workspaceFolder = vscode.workspace.workspaceFolders[0];
    }
    const localResourceRoots = [this.context.extensionUri];

    if (workspaceFolder) {
      localResourceRoots.push(workspaceFolder.uri);
      // Also include parent directory to allow access to sibling directories
      // This enables markdown files to reference images in ../sibling-folder/
      const workspaceParent = path.dirname(workspaceFolder.uri.fsPath);
      if (workspaceParent && workspaceParent !== workspaceFolder.uri.fsPath) {
        localResourceRoots.push(vscode.Uri.file(workspaceParent));
      }
    } else if (document.uri.scheme === 'file') {
      // If not in a workspace but is a file, allow the document's directory
      localResourceRoots.push(vscode.Uri.file(path.dirname(document.uri.fsPath)));
    } else {
      // For untitled files without workspace, allow the OS temp directory as a restrictive fallback.
      localResourceRoots.push(vscode.Uri.file(os.tmpdir()));
    }

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots,
    };

    // Show warning dialog for untitled files without workspace
    // Re-check workspaceFolder here since we may have updated it above
    const finalWorkspaceFolder =
      workspaceFolder ||
      (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0]
        : undefined);
    if (document.uri.scheme === 'untitled' && !finalWorkspaceFolder) {
      const imageBasePath = this.getImageBasePath(document);
      if (imageBasePath) {
        vscode.window.showInformationMessage(
          `You are working without a workspace. Images will be saved to: ${imageBasePath}`
        );
      }
    }

    // Set webview HTML
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);
    void this.syncMarkdownlintMd012(this.getBlankLineMode()).catch(error => {
      console.warn('[MD4H] Failed syncing markdownlint MD012 rule:', error);
    });

    // Register this panel for the autosave bridge. The window-state listener
    // iterates this map on focus changes; the view-state handler below reads
    // its own panel/document from closure but registering here keeps lifetimes
    // consistent.
    const panelKey = document.uri.toString();
    this.openPanels.set(panelKey, { panel: webviewPanel, document });
    this.ensureWindowStateListener();

    // Update webview when document changes
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString()) {
        this.updateWebview(document, webviewPanel.webview);
      }
    });

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage(
      e => this.handleWebviewMessage(e, document, webviewPanel.webview),
      null,
      this.context.subscriptions
    );

    // Track active panel
    setActiveWebviewPanel(webviewPanel, document);

    // Send initial content to webview
    this.updateWebview(document, webviewPanel.webview);

    // Listen for configuration changes and update webview
    const configChangeSubscription = vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('markdownForHumans.imageResize.skipWarning') ||
        e.affectsConfiguration('markdownForHumans.copyAiContextRef.skipSaveWarning') ||
        e.affectsConfiguration('markdownForHumans.imagePath') ||
        e.affectsConfiguration('markdownForHumans.imagePathBase') ||
        e.affectsConfiguration('markdownForHumans.imagePreview.hover.enabled') ||
        e.affectsConfiguration('markdownForHumans.blankLines.mode') ||
        e.affectsConfiguration('markdownForHumans.paragraph.spacingBefore') ||
        e.affectsConfiguration('markdownForHumans.paragraph.spacingAfter') ||
        e.affectsConfiguration('markdownForHumans.zoom') ||
        e.affectsConfiguration('markdownForHumans.enableMath')
      ) {
        const config = vscode.workspace.getConfiguration();
        const skipWarning = config.get<boolean>('markdownForHumans.imageResize.skipWarning', false);
        const skipAiContextSaveWarning = config.get<boolean>(
          'markdownForHumans.copyAiContextRef.skipSaveWarning',
          false
        );
        const imagePath = config.get<string>('markdownForHumans.imagePath', 'images');
        const imagePathBase = config.get<string>(
          'markdownForHumans.imagePathBase',
          'relativeToDocument'
        );
        const showImageHoverOverlay = config.get<boolean>(
          'markdownForHumans.imagePreview.hover.enabled',
          true
        );
        const paragraphSpacingBefore = config.get<number>(
          'markdownForHumans.paragraph.spacingBefore',
          0
        );
        const paragraphSpacingAfter = config.get<number>(
          'markdownForHumans.paragraph.spacingAfter',
          0
        );
        const zoom = config.get<number>('markdownForHumans.zoom', 100);
        const blankLineMode = this.getBlankLineMode();
        const enableMath = config.get<boolean>('markdownForHumans.enableMath', true);
        if (e.affectsConfiguration('markdownForHumans.blankLines.mode')) {
          void this.syncMarkdownlintMd012(blankLineMode).catch(error => {
            console.warn('[MD4H] Failed syncing markdownlint MD012 rule:', error);
          });
          // After the policy rewrites the buffer, either persist the change
          // (autosave on) or tell the user it's pending (autosave off). The
          // policy sync is what made the doc dirty, so this branch is the
          // right moment to act.
          void this.syncTextDocumentBlankLinePolicy(document)
            .then(() => this.handleBlankLineModeSavePolicy(document, webviewPanel))
            .catch(error => {
              console.error('[MD4H] Failed to sync blank-line policy to document buffer:', error);
            });
        }
        webviewPanel.webview.postMessage({
          type: 'settingsUpdate',
          skipResizeWarning: skipWarning,
          skipAiContextSaveWarning: skipAiContextSaveWarning,
          imagePath: imagePath,
          imagePathBase: imagePathBase,
          showImageHoverOverlay: showImageHoverOverlay,
          paragraphSpacingBefore: paragraphSpacingBefore,
          paragraphSpacingAfter: paragraphSpacingAfter,
          zoom: zoom,
          blankLineMode,
          enableMath: enableMath,
        });
      }
    });

    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        setActiveWebviewPanel(webviewPanel, document);
      } else if (getActiveWebviewPanel() === webviewPanel) {
        setActiveWebviewPanel(undefined);
      }
      // Autosave bridge: VS Code's built-in `onFocusChange` /
      // `onWindowChange` autosave keys off `TextEditor` focus events, and a
      // custom-editor webview never raises those. When the panel goes
      // inactive (user switched tab, focused another pane, etc.) we save
      // ourselves so the user's writing isn't held in an in-memory dirty
      // buffer indefinitely.
      if (!webviewPanel.active) {
        const autoSave = vscode.workspace.getConfiguration('files').get<string>('autoSave', 'off');
        if (autoSave === 'onFocusChange' || autoSave === 'onWindowChange') {
          void this.flushAndSaveIfDirty(document, webviewPanel.webview).catch(error => {
            console.error('[MD4H] Autosave on view-state change failed:', error);
          });
        }
      }
    });

    // Cleanup
    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      configChangeSubscription.dispose();
      // Clean up pending edits tracking for this document
      const docUri = document.uri.toString();
      this.pendingEdits.delete(docUri);
      this.lastWebviewContent.delete(docUri);
      this.inFlightApplyEdits.delete(docUri);
      if (this.openPanels.get(docUri)?.panel === webviewPanel) {
        this.openPanels.delete(docUri);
      }
      if (getActiveWebviewPanel() === webviewPanel) {
        setActiveWebviewPanel(undefined);
      }
    });
  }

  /**
   * Send document content to webview
   * Skips update if it's from a recent webview edit (avoid feedback loop)
   */
  private updateWebview(document: vscode.TextDocument, webview: vscode.Webview) {
    const docUri = document.uri.toString();
    const lastEditTime = this.pendingEdits.get(docUri);
    const mode = this.getBlankLineMode();
    const rawContent = document.getText();
    const currentContent = applyBlankLinePolicy(rawContent, mode);

    // Skip update if content matches what we already sent from the webview
    const lastSentContent = this.lastWebviewContent.get(docUri);
    if (lastSentContent !== undefined && lastSentContent === currentContent) {
      return;
    }

    // Skip update if this change came from webview within last 100ms
    // This prevents feedback loops while allowing external Git changes to sync
    if (lastEditTime && Date.now() - lastEditTime < 100) {
      return;
    }

    // Transform content for webview (wrap frontmatter in code block)
    const transformedContent = this.wrapFrontmatterForWebview(currentContent);

    // Remember the ORIGINAL content (what we expect back from webview after unwrapping)
    // This prevents false dirty state when webview sends back unwrapped frontmatter
    this.lastWebviewContent.set(docUri, currentContent);

    // Get skip warning setting
    const config = vscode.workspace.getConfiguration();
    const skipWarning = config.get<boolean>('markdownForHumans.imageResize.skipWarning', false);
    const skipAiContextSaveWarning = config.get<boolean>(
      'markdownForHumans.copyAiContextRef.skipSaveWarning',
      false
    );
    const imagePath = config.get<string>('markdownForHumans.imagePath', 'images');
    const imagePathBase = config.get<string>(
      'markdownForHumans.imagePathBase',
      'relativeToDocument'
    );
    const showImageHoverOverlay = config.get<boolean>(
      'markdownForHumans.imagePreview.hover.enabled',
      true
    );
    const paragraphSpacingBefore = config.get<number>(
      'markdownForHumans.paragraph.spacingBefore',
      0
    );
    const paragraphSpacingAfter = config.get<number>('markdownForHumans.paragraph.spacingAfter', 0);
    const zoom = config.get<number>('markdownForHumans.zoom', 100);
    const blankLineMode = this.getBlankLineMode();
    const enableMath = config.get<boolean>('markdownForHumans.enableMath', true);

    webview.postMessage({
      type: 'update',
      content: transformedContent,
      skipResizeWarning: skipWarning,
      skipAiContextSaveWarning: skipAiContextSaveWarning,
      imagePath: imagePath,
      imagePathBase: imagePathBase,
      showImageHoverOverlay: showImageHoverOverlay,
      paragraphSpacingBefore: paragraphSpacingBefore,
      paragraphSpacingAfter: paragraphSpacingAfter,
      zoom: zoom,
      blankLineMode,
      enableMath: enableMath,
    });
  }

  /**
   * Handle messages from webview
   */
  private handleWebviewMessage(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ) {
    switch (message.type) {
      case 'edit': {
        // Fire-and-forget: errors are handled inside applyEdit and shown to user.
        // applyEdit only updates the in-memory TextDocument (via WorkspaceEdit) —
        // it never writes to disk. The file is only persisted to disk on an
        // explicit `save` message (Ctrl+S), when `copyAiContextRef` saves after
        // user confirmation, or when the autosave bridge fires `document.save()`.
        const docUri = document.uri.toString();
        const editPromise = this.applyEdit(message.content as string, document, {
          editReason:
            (message.editReason as 'typing' | 'save-policy-enforce' | undefined) ?? 'typing',
        });
        // Track the latest in-flight edit so `flushAndSaveIfDirty` can await
        // it before persisting; otherwise an in-flight WorkspaceEdit could
        // land after save() and the saved bytes would be stale.
        this.inFlightApplyEdits.set(docUri, editPromise);
        void editPromise.finally(() => {
          if (this.inFlightApplyEdits.get(docUri) === editPromise) {
            this.inFlightApplyEdits.delete(docUri);
          }
        });
        break;
      }
      case 'save':
        // Trigger VS Code's save command — only fired by Ctrl+S in the webview.
        vscode.commands.executeCommand('workbench.action.files.save');
        break;
      case 'flushPendingEditAck': {
        const requestId = message.requestId as string;
        const resolve = this.flushAckResolvers.get(requestId);
        if (resolve) {
          this.flushAckResolvers.delete(requestId);
          resolve();
        }
        break;
      }
      case 'ready': {
        // Webview is ready, send initial content and settings
        this.updateWebview(document, webview);
        // Also send settings separately
        const config = vscode.workspace.getConfiguration();
        const skipWarning = config.get<boolean>('markdownForHumans.imageResize.skipWarning', false);
        const skipAiContextSaveWarning = config.get<boolean>(
          'markdownForHumans.copyAiContextRef.skipSaveWarning',
          false
        );
        const imagePath = config.get<string>('markdownForHumans.imagePath', 'images');
        const imagePathBase = config.get<string>(
          'markdownForHumans.imagePathBase',
          'relativeToDocument'
        );
        const showImageHoverOverlay = config.get<boolean>(
          'markdownForHumans.imagePreview.hover.enabled',
          true
        );
        const paragraphSpacingBefore = config.get<number>(
          'markdownForHumans.paragraph.spacingBefore',
          0
        );
        const paragraphSpacingAfter = config.get<number>(
          'markdownForHumans.paragraph.spacingAfter',
          0
        );
        const zoom = config.get<number>('markdownForHumans.zoom', 100);
        const blankLineMode = this.getBlankLineMode();
        const enableMath = config.get<boolean>('markdownForHumans.enableMath', true);
        webview.postMessage({
          type: 'settingsUpdate',
          skipResizeWarning: skipWarning,
          skipAiContextSaveWarning: skipAiContextSaveWarning,
          imagePath: imagePath,
          imagePathBase: imagePathBase,
          showImageHoverOverlay: showImageHoverOverlay,
          paragraphSpacingBefore: paragraphSpacingBefore,
          paragraphSpacingAfter: paragraphSpacingAfter,
          zoom: zoom,
          blankLineMode,
          enableMath: enableMath,
        });
        break;
      }
      case 'outlineUpdated': {
        const outline = this.parseOutlineEntries(message.outline);
        outlineViewProvider.setOutline(outline);
        break;
      }
      case 'selectionChange': {
        const pos = message.pos as number | undefined;
        outlineViewProvider.setActiveSelection(typeof pos === 'number' ? pos : null);
        break;
      }
      case 'saveImage':
        this.handleSaveImage(message, document, webview);
        break;
      case 'handleWorkspaceImage':
        void this.handleWorkspaceImage(message, document, webview);
        break;
      case 'resolveImageUri':
        this.handleResolveImageUri(message, document, webview);
        break;
      case 'openSourceView':
        // Open the source file in a split view with VS Code's default text editor
        vscode.commands.executeCommand(
          'vscode.openWith',
          document.uri,
          'default',
          vscode.ViewColumn.Beside
        );
        break;
      case 'openExtensionSettings':
        vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:concretio.markdown-for-humans'
        );
        break;
      case 'exportDocument':
        this.handleExportDocument(message, document);
        break;
      case 'showError':
        vscode.window.showErrorMessage(message.message as string);
        break;
      case 'resizeImage':
        this.handleResizeImage(message, document, webview);
        break;
      case 'undoResize':
        this.handleUndoResize(message, document, webview);
        break;
      case 'redoResize':
        this.handleRedoResize(message, document, webview);
        break;
      case 'updateSetting':
        this.handleUpdateSetting(message, webview);
        break;
      case 'checkImageInWorkspace':
        this.handleCheckImageInWorkspace(message, document, webview);
        break;
      case 'copyLocalImageToWorkspace':
        this.handleCopyLocalImageToWorkspace(message, document, webview);
        break;
      case 'renameImage':
        this.handleRenameImage(message, document, webview);
        break;
      case 'checkImageRename':
        void this.handleCheckImageRename(message, document, webview);
        break;
      case 'getImageReferences':
        void this.handleGetImageReferences(message, document, webview);
        break;
      case 'openFileAtLocation':
        void this.handleOpenFileAtLocation(message);
        break;
      case 'getImageMetadata':
        this.handleGetImageMetadata(message, document, webview);
        break;
      case 'revealImageInOS':
        this.handleRevealImageInOS(message, document);
        break;
      case 'revealImageInExplorer':
        this.handleRevealImageInExplorer(message, document);
        break;
      case 'searchFiles':
        void this.handleSearchFiles(message, webview);
        break;
      case 'openExternalLink':
        void this.handleOpenExternalLink(message);
        break;
      case 'openFileLink':
        void this.handleOpenFileLink(message, document);
        break;
      case 'openImage':
        void this.handleOpenImage(message, document);
        break;
      case 'auditCheckFile':
        void this.handleAuditCheckFile(message, document, webview);
        break;
      case 'auditCheckUrl':
        void this.handleAuditCheckUrl(message, document, webview);
        break;
      case 'auditPickFile':
        void this.handleAuditPickFile(message, document, webview);
        break;
      case 'getAiContextRef':
        void this.handleGetAiContextRef(message, document, webview);
        break;
      case 'queryDocumentDirty': {
        // The webview's pending edits land in the TextDocument via WorkspaceEdit
        // (see `applyEdit`), so `document.isDirty` is the authoritative answer
        // even when the user has typed but not yet saved.
        const requestId = message.requestId as string;
        if (typeof requestId === 'string') {
          webview.postMessage({
            type: 'documentDirtyResponse',
            requestId,
            isDirty: document.isDirty,
          });
        }
        break;
      }
    }
  }

  /**
   * Build a Claude-Code-style `@file#startLine-endLine` reference for the active
   * document. Saves the document first so the line numbers the webview just
   * computed match the bytes on disk that an AI tool will read.
   *
   * Path is workspace-relative (POSIX separators) when the file is inside an
   * open workspace folder. Files outside any workspace fall back to the absolute
   * fsPath, also normalized to forward slashes.
   */
  private async handleGetAiContextRef(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const requestId = message.requestId as string;
    const rawStart = message.startLine;
    const rawEnd = message.endLine;
    // Both line numbers are optional: when the webview couldn't map the
    // selection to any block (empty doc, all-blank paragraphs, out-of-range
    // cursor) it omits them and we return the bare `@path`.
    const hasRange = typeof rawStart === 'number' && typeof rawEnd === 'number';

    const reply = (payload: { ref?: string; relPath?: string; error?: string }) => {
      webview.postMessage({
        type: 'aiContextRefResponse',
        requestId,
        ...payload,
      });
    };

    if (typeof requestId !== 'string') return;
    if (!hasRange && (rawStart !== undefined || rawEnd !== undefined)) {
      // Partial line info is always a webview bug — fail loudly rather than
      // silently dropping it.
      reply({ error: 'Invalid line range' });
      return;
    }

    try {
      if (document.isDirty) {
        const saved = await document.save();
        if (!saved) {
          reply({ error: 'Could not save document before copying reference' });
          return;
        }
      }

      const filePath = document.uri.fsPath;
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      const relRaw = workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, filePath)
        : filePath;
      const relPath = relRaw.replace(/\\/g, '/');
      if (!hasRange) {
        reply({ ref: `@${relPath}`, relPath });
        return;
      }
      const startLine = rawStart as number;
      const endLine = rawEnd as number;
      const suffix = startLine === endLine ? `#${startLine}` : `#${startLine}-${endLine}`;
      reply({ ref: `@${relPath}${suffix}`, relPath });
    } catch (error) {
      reply({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Handle document export request from webview
   */
  private async handleExportDocument(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument
  ): Promise<void> {
    const format = message.format as string;
    const html = message.html as string;
    const mermaidImages = Array.isArray(message.mermaidImages)
      ? message.mermaidImages.filter(image => this.isExportMermaidImage(image))
      : [];
    const title = message.title as string;

    // Import dynamically to avoid loading heavy dependencies on startup
    const { exportDocument } = await import('../features/documentExport');

    await exportDocument(format, html, mermaidImages, title, document);
  }

  /**
   * Check if a file exists (used by Document Audit)
   */
  private async handleAuditCheckFile(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const rawRelativePath = message.relativePath as string;
    const requestId = message.requestId as string;
    const basePath = this.getImageBasePath(document);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

    if (!basePath) {
      webview.postMessage({
        type: 'auditCheckFileResult',
        requestId,
        exists: false,
      });
      return;
    }

    try {
      // Basic normalization logic similar to handleResolveImageUri
      const normalizedPath = rawRelativePath.replace(/%20/g, ' ');
      const absolutePath = path.resolve(basePath, normalizedPath);
      const fileUri = vscode.Uri.file(absolutePath);

      await vscode.workspace.fs.stat(fileUri);
      webview.postMessage({
        type: 'auditCheckFileResult',
        requestId,
        exists: true,
      });
    } catch {
      const suggestions: string[] = [];
      try {
        // Enhanced fuzzy matching suggestions
        const normalizedPath = rawRelativePath.replace(/%20/g, ' ');
        const basename = path.basename(normalizedPath, path.extname(normalizedPath));
        const extension = path.extname(normalizedPath).toLowerCase();

        if (basename.length >= this.MIN_BASENAME_LENGTH_FOR_SUGGESTION) {
          const searchExclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.next/**}';
          const exactPattern = workspaceFolder
            ? new vscode.RelativePattern(workspaceFolder, `**/${basename}.*`)
            : `**/${basename}.*`;
          const fuzzyPattern = workspaceFolder
            ? new vscode.RelativePattern(workspaceFolder, `**/*${basename}*.*`)
            : `**/*${basename}*.*`;
          const shouldRunFuzzySearch = basename.length >= this.MIN_BASENAME_LENGTH_FOR_FUZZY;
          const extensionPattern =
            extension && workspaceFolder
              ? new vscode.RelativePattern(workspaceFolder, `**/*${extension}`)
              : extension
                ? `**/*${extension}`
                : null;

          // Strategy 1: Exact basename match with any extension
          const exactBasenameFiles = await vscode.workspace.findFiles(
            exactPattern,
            searchExclude,
            8
          );

          // Strategy 2: Fuzzy basename matching for sufficiently specific names.
          // Very short basenames create broad scans and low-quality suggestions.
          const fuzzyFiles = shouldRunFuzzySearch
            ? await vscode.workspace.findFiles(fuzzyPattern, searchExclude, 6)
            : [];

          // Strategy 3: Find some files with the same extension as fallback
          let extensionFiles: vscode.Uri[] = [];
          if (extensionPattern) {
            try {
              extensionFiles = await vscode.workspace.findFiles(extensionPattern, searchExclude, 3);
            } catch (e) {
              console.warn('[MD4H] Error finding extension files for audit suggestions:', e);
            }
          }

          // 1. Combine all raw results
          const allFiles = [...exactBasenameFiles, ...fuzzyFiles, ...extensionFiles];
          // 2. Convert all absolute paths to relative, web-safe paths
          const rawSuggestions = allFiles.map(f => {
            const rel = path.relative(basePath, f.fsPath).replace(/\\/g, '/');
            return rel.startsWith('.') ? rel : `./${rel}`;
          });

          // 3. Deduplicate
          const uniqueSuggestions = Array.from(new Set(rawSuggestions));

          // 4. Sort based on clear priority rules
          uniqueSuggestions.sort((a, b) => {
            // Priority 1: Does the extension match the original?
            const aHasExactExt = extension && path.extname(a).toLowerCase() === extension;
            const bHasExactExt = extension && path.extname(b).toLowerCase() === extension;
            if (aHasExactExt && !bHasExactExt) return -1;
            if (!aHasExactExt && bHasExactExt) return 1;

            // Priority 2: Does the basename match exactly?
            const aBase = path.basename(a, path.extname(a));
            const bBase = path.basename(b, path.extname(b));
            const aExactBase = aBase === basename;
            const bExactBase = bBase === basename;
            if (aExactBase && !bExactBase) return -1;
            if (!aExactBase && bExactBase) return 1;

            // Priority 3: Shorter paths are usually closer to the current directory
            return a.length - b.length;
          });

          // 5. Apply the top 5 sorted results to the suggestions array
          suggestions.push(...uniqueSuggestions.slice(0, 5));
        }
      } catch (e) {
        console.warn('[MD4H] Error finding audit file suggestions:', e);
      }

      webview.postMessage({
        type: 'auditCheckFileResult',
        requestId,
        exists: false,
        suggestions: suggestions.slice(0, 5), // Limit to 5 for UI
      });
    }
  }

  /**
   * Open a VS Code file picker dialog for the Document Audit feature.
   *
   * Sends back an 'auditPickFileResult' message with the relative path of the
   * file selected by the user, or null if the user cancelled.
   *
   * @param message - Webview message containing requestId and fileType ('image' | 'any').
   * @param document - Active text document (used to derive the relative path base).
   * @param webview - Target webview to post the result back to.
   */
  private async handleAuditPickFile(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const requestId = message.requestId as string;
    const fileType = message.fileType as string;
    const basePath = this.getImageBasePath(document);

    // Build file-type filter
    const imageFilters: { [name: string]: string[] } = {
      Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'tif'],
    };
    const allFilters: { [name: string]: string[] } = {
      'All Files': ['*'],
      Markdown: ['md', 'mdx'],
      Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'],
    };
    const filters = fileType === 'image' ? imageFilters : allFilters;

    try {
      const defaultUri = basePath ? vscode.Uri.file(basePath) : undefined;
      const selected = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFolders: false,
        canSelectFiles: true,
        openLabel: 'Select File',
        defaultUri,
        filters,
      });

      if (!selected || selected.length === 0) {
        // User cancelled
        webview.postMessage({ type: 'auditPickFileResult', requestId, selectedPath: null });
        return;
      }

      const absoluteSelected = selected[0].fsPath;

      // Compute path relative to the document's base directory
      let relativePath: string | null = null;
      if (basePath) {
        const rel = path.relative(basePath, absoluteSelected);
        // Only use relative path if the file is within or near the base directory
        if (!path.isAbsolute(rel)) {
          // Normalize to forward-slashes for markdown compatibility
          relativePath = rel.replace(/\\/g, '/');
          if (!relativePath.startsWith('.')) {
            relativePath = './' + relativePath;
          }
        }
      }

      // Fall back to the absolute path when file is outside the document root
      // Fall back to the absolute path when file is outside the document root
      if (!relativePath) {
        relativePath = absoluteSelected.replace(/\\/g, '/');
        // Warn the user about document portability issues
        vscode.window.showWarningMessage(
          'You selected a file outside the current workspace. An absolute path was used, which may break if you share this document.'
        );
      }
      webview.postMessage({ type: 'auditPickFileResult', requestId, selectedPath: relativePath });
    } catch (e) {
      console.error('[MD4H] handleAuditPickFile error:', e);
      webview.postMessage({ type: 'auditPickFileResult', requestId, selectedPath: null });
    }
  }

  private isPrivateAddress(ip: string): boolean {
    // Handle IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1)
    // These can be returned by dns.lookup on dual-stack systems and would bypass
    // the IPv4 regex checks below without this normalization.
    const ipv4MappedMatch = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (ipv4MappedMatch) {
      return this.isPrivateAddress(ipv4MappedMatch[1]);
    }

    const PRIVATE_IP_RANGES = [
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^0\./,
    ];
    if (ip === '::1' || ip === '::' || ip === '0.0.0.0') return true;
    if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
    return PRIVATE_IP_RANGES.some(range => range.test(ip));
  }

  private async isSafeUrl(hostname: string): Promise<boolean> {
    if (hostname.toLowerCase() === 'localhost') {
      return false;
    }
    if (isIP(hostname)) {
      return !this.isPrivateAddress(hostname);
    }
    try {
      const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
      return !addresses.some(ip => this.isPrivateAddress(ip.address));
    } catch {
      return false;
    }
  }

  private async resolveSafeAddress(hostname: string): Promise<string | null> {
    if (hostname.toLowerCase() === 'localhost') {
      return null;
    }
    if (isIP(hostname)) {
      return this.isPrivateAddress(hostname) ? null : hostname;
    }
    try {
      const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
      const publicAddress = addresses.find(address => !this.isPrivateAddress(address.address));
      return publicAddress?.address ?? null;
    } catch {
      return null;
    }
  }

  private async handleAuditCheckUrl(
    message: { type: string; [key: string]: unknown },
    _document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const url = message.url as string;
    const requestId = message.requestId as string;

    if (!url) {
      webview.postMessage({
        type: 'auditCheckUrlResult',
        requestId,
        reachable: false,
      });
      return;
    }

    try {
      const parsed = new URL(url);
      if (!(await this.isSafeUrl(parsed.hostname))) {
        webview.postMessage({
          type: 'auditCheckUrlResult',
          requestId,
          reachable: false,
        });
        return;
      }
      const safeAddress = await this.resolveSafeAddress(parsed.hostname);
      if (!safeAddress) {
        webview.postMessage({
          type: 'auditCheckUrlResult',
          requestId,
          reachable: false,
        });
        return;
      }

      // Use Node's native http/https modules for guaranteed cross-version consistency.
      // Try HEAD first; fall back to GET if the server rejects HEAD (405/403/404).
      const requestOpts = {
        hostname: safeAddress,
        headers: {
          Host: parsed.host,
          'User-Agent': 'MarkdownForHumans-LinkChecker/1.0',
        } as Record<string, string>,
        servername: parsed.hostname,
        path: parsed.pathname + parsed.search,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        timeout: MarkdownEditorProvider.URL_CHECK_TIMEOUT_MS,
      };
      const httpModule = parsed.protocol === 'https:' ? https : http;

      const tryRequest = (method: string): Promise<number> =>
        new Promise<number>(resolve => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const req = httpModule.request({ ...requestOpts, method }, (res: any) => {
              // Consume body so the socket is released
              res.resume();
              resolve(res.statusCode as number);
            });
            req.on('error', () => resolve(0));
            req.on('timeout', () => {
              req.destroy();
              resolve(0);
            });
            req.end();
          } catch {
            resolve(0);
          }
        });

      let status = await tryRequest('HEAD');

      // Many servers block HEAD or return misleading codes; retry with GET
      if (status === 403 || status === 404 || status === 405) {
        status = await tryRequest('GET');
      }

      const reachable = status >= 200 && status < 400;

      webview.postMessage({
        type: 'auditCheckUrlResult',
        requestId,
        reachable,
      });
    } catch (e) {
      console.warn('[MD4H] URL check failed', e);
      webview.postMessage({
        type: 'auditCheckUrlResult',
        requestId,
        reachable: false,
      });
    }
  }

  /**
   * Resolve a relative image path to a webview URI
   *
   * Normalizes URL-encoded paths (e.g. `Hero%20Image.png`) before resolving
   * so that images with spaces or special characters in filenames work correctly.
   */
  private handleResolveImageUri(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): void {
    const rawRelativePath = message.relativePath as string;
    const requestId = message.requestId as string;

    // Normalize the path (decode URL-encoded segments like %20 → space)
    const relativePath = normalizeImagePath(rawRelativePath);

    // Resolve relative to document base path
    const basePath = this.getImageBasePath(document);
    if (!basePath) {
      webview.postMessage({
        type: 'imageUriResolved',
        requestId,
        webviewUri: '',
        relativePath: rawRelativePath,
        error: 'Cannot resolve image path: no base directory available',
      });
      return;
    }
    const absolutePath = path.resolve(basePath, relativePath);
    const fileUri = vscode.Uri.file(absolutePath);

    // Convert to webview URI
    const webviewUri = webview.asWebviewUri(fileUri);

    webview.postMessage({
      type: 'imageUriResolved',
      requestId,
      webviewUri: webviewUri.toString(),
      relativePath: rawRelativePath, // Return original path for consistency
    });
  }

  /**
   * Check if relative path is valid (doesn't contain absolute path)
   * Works on both Windows and Mac/Linux
   */
  private isValidRelativePath(relativePath: string): boolean {
    // On Windows, path.relative() can produce paths like "../../../../c:/Users/..."
    // when paths don't share a common root. Check for drive letters.
    const windowsAbsolutePattern = /[a-zA-Z]:/;

    // On Unix/Mac, path.relative() can produce paths starting with "/"
    // when paths don't share a common root. Check for leading slash.
    const unixAbsolutePattern = /^\/[^/]/;

    // Also check if path.isAbsolute() returns true (Node.js built-in, cross-platform)
    return (
      !windowsAbsolutePattern.test(relativePath) &&
      !unixAbsolutePattern.test(relativePath) &&
      !path.isAbsolute(relativePath)
    );
  }

  /**
   * Check if source is within workspace/document directory (cross-platform).
   * Thin wrapper over the exported `isPathContainedWithin` helper.
   */
  private isWithinWorkspace(sourcePath: string, basePath: string): boolean {
    return isPathContainedWithin(sourcePath, basePath);
  }

  /**
   * Build the list of allowed roots a file-mutating handler may write to,
   * for the given document. Used by handleRenameImage / handleResizeImage
   * to reject paths that escape via `../` from a hostile markdown image
   * src (see SECURITY review §H1, §H2).
   */
  private getAllowedFileRoots(document: vscode.TextDocument): string[] {
    const roots: string[] = [];
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (workspaceFolder) {
      roots.push(workspaceFolder.uri.fsPath);
    }
    if (document.uri.scheme === 'file') {
      roots.push(path.dirname(document.uri.fsPath));
    }
    const imageBase = this.getImageBasePath(document);
    if (imageBase) {
      roots.push(imageBase);
    }
    // De-dupe
    return Array.from(new Set(roots));
  }

  /**
   * Handle workspace image drop (from VS Code file explorer)
   * Computes relative path from document to the image, or copies image if outside workspace
   */
  private async handleWorkspaceImage(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const sourcePath = message.sourcePath as string;
    const fileName = message.fileName as string;
    const insertPosition = message.insertPosition as number | undefined;

    console.warn(`[MD4H] Handling workspace image: ${sourcePath}`);

    // Get the document base path
    const basePath = this.getImageBasePath(document);
    if (!basePath) {
      console.error(`[MD4H] Cannot compute relative path: no base directory available`);
      return;
    }

    // Normalize paths for comparison
    const normalizedSource = path.normalize(sourcePath);
    const normalizedBase = path.normalize(basePath);

    // Check if image is within workspace/document directory
    const withinWorkspace = this.isWithinWorkspace(normalizedSource, normalizedBase);

    // Compute relative path from document base to image
    let relativePath = path.relative(normalizedBase, normalizedSource);

    // Ensure forward slashes for markdown compatibility
    relativePath = relativePath.replace(/\\/g, '/');

    // Validate the relative path
    const isValidPath = this.isValidRelativePath(relativePath);

    // If path is invalid or image is outside workspace, copy it to workspace
    if (!isValidPath || !withinWorkspace) {
      console.warn(
        `[MD4H] Image is outside workspace or has invalid path, copying to workspace...`
      );

      try {
        // Read the source image
        const sourceUri = vscode.Uri.file(normalizedSource);
        const imageData = await vscode.workspace.fs.readFile(sourceUri);

        // Get save location
        const saveBasePath = this.getImageStorageBasePath(document);
        if (!saveBasePath) {
          const errorMessage = 'Cannot copy image: no base directory available';
          vscode.window.showErrorMessage(errorMessage);
          return;
        }

        const config = vscode.workspace.getConfiguration();
        const imageFolderName = config.get<string>('markdownForHumans.imagePath', 'images');
        const imagesDir = path.join(saveBasePath, imageFolderName);

        // Create folder if needed
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(imagesDir));

        // Generate filename from source
        const sourceFilename = path.basename(normalizedSource);
        const parsedName = path.parse(sourceFilename);
        const baseFilename = parsedName.name || 'image';
        const extension = parsedName.ext || '';

        let finalFilename = sourceFilename;
        let targetPath = path.join(imagesDir, finalFilename);
        let targetUri = vscode.Uri.file(targetPath);

        const fileExists = async (uri: vscode.Uri): Promise<boolean> => {
          try {
            await vscode.workspace.fs.stat(uri);
            return true;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('ENOENT') || message.includes('FileNotFound')) {
              return false;
            }
            throw error;
          }
        };

        // Handle filename collisions
        if (await fileExists(targetUri)) {
          let foundAvailableName = false;
          for (let suffix = 2; suffix < 1000; suffix += 1) {
            finalFilename = `${baseFilename}-${suffix}${extension}`;
            targetPath = path.join(imagesDir, finalFilename);
            targetUri = vscode.Uri.file(targetPath);
            if (!(await fileExists(targetUri))) {
              foundAvailableName = true;
              break;
            }
          }
          if (!foundAvailableName) {
            throw new Error(
              `Cannot copy image: too many existing files matching "${baseFilename}-N${extension}"`
            );
          }
        }

        // Copy file to workspace
        await vscode.workspace.fs.writeFile(targetUri, imageData);

        // Calculate relative path for markdown
        const markdownDir =
          document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : saveBasePath;
        let copiedRelativePath = path.relative(markdownDir, targetPath).replace(/\\/g, '/');
        if (!copiedRelativePath.startsWith('..') && !copiedRelativePath.startsWith('./')) {
          copiedRelativePath = './' + copiedRelativePath;
        }

        console.warn(`[MD4H] Image copied to workspace. Path: ${copiedRelativePath}`);

        // Extract alt text from filename (remove extension)
        const altText = fileName.replace(/\.[^.]+$/, '');

        // Send message to webview to insert the image with relative path
        // Use insertWorkspaceImage message type for consistency
        webview.postMessage({
          type: 'insertWorkspaceImage',
          relativePath: copiedRelativePath,
          altText,
          insertPosition,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[MD4H] Failed to copy workspace image: ${errorMessage}`);
        vscode.window.showErrorMessage(`Failed to copy image: ${errorMessage}`);
      }
      return;
    }

    // Image is within workspace and path is valid - use relative path directly
    // Add ./ prefix if it doesn't start with .. (going up directories)
    if (!relativePath.startsWith('..') && !relativePath.startsWith('./')) {
      relativePath = './' + relativePath;
    }

    console.warn(`[MD4H] Computed relative path: ${relativePath}`);

    // Extract alt text from filename (remove extension)
    const altText = fileName.replace(/\.[^.]+$/, '');

    // Send the markdown image syntax back to webview
    webview.postMessage({
      type: 'insertWorkspaceImage',
      relativePath,
      altText,
      insertPosition,
    });
  }

  /**
   * Handle image save from webview
   * Saves the image to the workspace and returns the relative path
   */
  private async handleSaveImage(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const placeholderId = message.placeholderId as string;
    const name = message.name as string;
    const data = message.data as number[];
    const mimeType = message.mimeType as string;

    // Use user-selected folder from confirmation dialog
    const imageFolderName = (message.targetFolder as string) || 'images';

    // Resolve where to save new images (may be doc-relative or workspace-level).
    const saveBasePath = this.getImageStorageBasePath(document);
    if (!saveBasePath) {
      const errorMessage = 'Cannot save image: no base directory available';
      vscode.window.showErrorMessage(errorMessage);
      webview.postMessage({
        type: 'imageError',
        placeholderId,
        error: errorMessage,
      });
      return;
    }
    const imagesDir = path.join(saveBasePath, imageFolderName);
    if (!isPathContainedWithin(imagesDir, saveBasePath)) {
      const errorMessage = `Refusing to save image outside the base directory: ${imageFolderName}`;
      vscode.window.showErrorMessage(errorMessage);
      webview.postMessage({ type: 'imageError', placeholderId, error: errorMessage });
      return;
    }

    console.warn(`[MD4H] Saving image "${name}" to folder: ${imagesDir}`);

    try {
      // Create folder if needed
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(imagesDir));

      // Save image (collision-safe: never overwrite silently)
      const safeName = path.basename(name) || 'image';
      const parsedName = path.parse(safeName);
      const baseFilename = parsedName.name || 'image';
      const extension = parsedName.ext || '';

      let finalFilename = safeName;
      let imagePath = path.join(imagesDir, finalFilename);
      let imageUri = vscode.Uri.file(imagePath);

      const fileExists = async (uri: vscode.Uri): Promise<boolean> => {
        try {
          await vscode.workspace.fs.stat(uri);
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // Treat not-found as available; unknown errors should abort to avoid accidental overwrites.
          if (message.includes('ENOENT') || message.includes('FileNotFound')) {
            return false;
          }
          throw error;
        }
      };

      if (await fileExists(imageUri)) {
        let foundAvailableName = false;
        for (let suffix = 2; suffix < 1000; suffix += 1) {
          finalFilename = `${baseFilename}-${suffix}${extension}`;
          imagePath = path.join(imagesDir, finalFilename);
          imageUri = vscode.Uri.file(imagePath);
          if (!(await fileExists(imageUri))) {
            foundAvailableName = true;
            break;
          }
        }
        if (!foundAvailableName) {
          throw new Error(
            `Cannot save image: too many existing files matching "${baseFilename}-N${extension}"`
          );
        }
      }

      await vscode.workspace.fs.writeFile(imageUri, new Uint8Array(data));

      // Markdown link should always be relative to the markdown file directory (portable in git).
      const markdownDir =
        document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : saveBasePath;
      let relativePath = path.relative(markdownDir, imagePath).replace(/\\/g, '/');

      if (!relativePath.startsWith('..') && !relativePath.startsWith('./')) {
        relativePath = './' + relativePath;
      }

      console.warn(`[MD4H] Image saved successfully. Path: ${relativePath}`);

      webview.postMessage({
        type: 'imageSaved',
        placeholderId,
        newSrc: relativePath, // Use relative path (markdown-friendly)
      });

      // Log success (mimeType used for potential future validation)
      if (mimeType) {
        // Image type validation could be added here
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to save image: ${errorMessage}`);
      webview.postMessage({
        type: 'imageError',
        placeholderId,
        error: errorMessage,
      });
    }
  }

  /**
   * Handle image resize request from webview
   * Backs up the original image, then overwrites the original file in-place.
   */
  private async handleResizeImage(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const imagePath = message.imagePath as string;
    const absolutePathFromMessage = message.absolutePath as string | undefined;
    const newWidth = message.newWidth as number;
    const newHeight = message.newHeight as number;
    const originalWidth = message.originalWidth as number | undefined;
    const originalHeight = message.originalHeight as number | undefined;
    const imageData = message.imageData as string; // base64 data URL

    console.warn(`[MD4H] Resizing image: ${imagePath} to ${newWidth}x${newHeight}`);

    try {
      // If absolute path provided (edit in place), use it directly
      // Otherwise resolve relative to document
      let absolutePath: string;
      let imageUri: vscode.Uri;

      if (absolutePathFromMessage) {
        // Editing in place (image outside workspace)
        absolutePath = absolutePathFromMessage;
        imageUri = vscode.Uri.file(absolutePath);
      } else {
        // Normal case: resolve relative to document base path
        const basePath = this.getImageBasePath(document);
        if (!basePath) {
          throw new Error('Cannot resolve image path: no base directory available');
        }
        const normalizedPath = normalizeImagePath(imagePath);
        absolutePath = path.resolve(basePath, normalizedPath);
        imageUri = vscode.Uri.file(absolutePath);
      }

      // SECURITY: gate the write target.
      // - "Normal" path (no absolutePathFromMessage): must stay inside the
      //   document/workspace roots. Defends against `<img src="../../etc/x">`.
      // - "Edit in place" path (absolutePathFromMessage): if the file is
      //   outside every allowed root, require explicit user confirmation
      //   showing the resolved path before we write. The webview is the
      //   only legitimate source of this message, but any extension or
      //   misbehaving page could send it; a one-click confirm makes the
      //   destination visible.
      // See SECURITY review §H2.
      const allowedRoots = this.getAllowedFileRoots(document);
      const insideAllowedRoot = allowedRoots.some(root =>
        isPathContainedWithin(absolutePath, root)
      );
      if (!insideAllowedRoot) {
        if (!absolutePathFromMessage) {
          throw new Error(`Refusing to resize image outside the document/workspace: ${imagePath}`);
        }
        const choice = await vscode.window.showWarningMessage(
          `Resize will overwrite a file outside this workspace:\n\n${absolutePath}\n\nProceed?`,
          { modal: true },
          'Overwrite'
        );
        if (choice !== 'Overwrite') {
          throw new Error('Resize cancelled by user.');
        }
      }

      // Check if image exists
      try {
        await vscode.workspace.fs.stat(imageUri);
      } catch {
        throw new Error(`Image not found: ${imagePath}`);
      }

      // Copy original to backup (workspace-scoped; never write backups next to external files)
      const originalData = await vscode.workspace.fs.readFile(imageUri);
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        throw new Error('Cannot compute backup path: no base directory available');
      }

      const backupWorkspaceRoot = this.getWorkspaceFolderPath(document) ?? basePath;
      const backupLocation = buildResizeBackupLocation({
        backupWorkspaceRoot,
        imageAbsolutePath: absolutePath,
        oldWidth: typeof originalWidth === 'number' && originalWidth > 0 ? originalWidth : newWidth,
        oldHeight:
          typeof originalHeight === 'number' && originalHeight > 0 ? originalHeight : newHeight,
        now: new Date(),
      });

      // Ensure backup root directory exists (flat structure - single directory)
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(backupLocation.backupDir));

      // Resolve backup path with collision detection
      const finalBackupPath = await resolveBackupPathWithCollisionDetection(
        backupLocation.backupFilePath
      );

      await vscode.workspace.fs.writeFile(vscode.Uri.file(finalBackupPath), originalData);
      console.warn(`[MD4H] Backup created: ${finalBackupPath}`);

      // Convert base64 data URL to buffer
      const base64Data = imageData.split(',')[1]; // Remove data:image/png;base64, prefix
      const buffer = Buffer.from(base64Data, 'base64');

      // Overwrite the original file in place (path remains unchanged).
      await vscode.workspace.fs.writeFile(imageUri, buffer);
      console.warn(`[MD4H] Image resized in-place: ${absolutePath}`);

      const relativeBackupPath = path.relative(basePath, finalBackupPath).replace(/\\/g, '/');
      const normalizedBackupPath =
        relativeBackupPath.startsWith('..') || relativeBackupPath.startsWith('./')
          ? relativeBackupPath
          : `./${relativeBackupPath}`;

      webview.postMessage({
        type: 'imageResized',
        success: true,
        imagePath,
        backupPath: normalizedBackupPath,
        newWidth, // Pass new dimensions so metadata can be updated immediately
        newHeight,
        timestamp: Date.now(), // Cache-busting
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to resize image: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to resize image: ${errorMessage}`);
      webview.postMessage({
        type: 'imageResized',
        success: false,
        error: errorMessage,
      });
    }
  }

  /**
   * Handle undo resize request from webview
   * Restores image from backup
   */
  private async handleUndoResize(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const imagePath = message.imagePath as string;
    const backupPath = message.backupPath as string;

    console.warn(`[MD4H] Undoing resize: restoring ${imagePath} from ${backupPath}`);

    try {
      // Resolve paths using base path
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        throw new Error('Cannot resolve image path: no base directory available');
      }
      const normalizedImagePath = normalizeImagePath(imagePath);
      const normalizedBackupPath = normalizeImagePath(backupPath);
      const absoluteImagePath = path.resolve(basePath, normalizedImagePath);
      const absoluteBackupPath = path.resolve(basePath, normalizedBackupPath);

      const allowedRoots = this.getAllowedFileRoots(document);
      if (!allowedRoots.some(root => isPathContainedWithin(absoluteImagePath, root))) {
        throw new Error(
          `Refusing to undo resize for image outside the document/workspace: ${imagePath}`
        );
      }

      const imageUri = vscode.Uri.file(absoluteImagePath);
      const backupUri = vscode.Uri.file(absoluteBackupPath);

      // Check if backup exists
      try {
        await vscode.workspace.fs.stat(backupUri);
      } catch {
        throw new Error(`Backup not found: ${backupPath}`);
      }

      // Restore from backup
      const backupData = await vscode.workspace.fs.readFile(backupUri);
      await vscode.workspace.fs.writeFile(imageUri, backupData);
      console.warn(`[MD4H] Image restored from backup`);

      webview.postMessage({
        type: 'imageUndoResized',
        success: true,
        imagePath,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to undo resize: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to undo resize: ${errorMessage}`);
      webview.postMessage({
        type: 'imageUndoResized',
        success: false,
        error: errorMessage,
      });
    }
  }

  /**
   * Handle redo resize request from webview
   * Reapplies resize operation
   */
  private async handleRedoResize(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const imagePath = message.imagePath as string;
    const newWidth = message.newWidth as number;
    const newHeight = message.newHeight as number;
    const imageData = message.imageData as string;

    console.warn(`[MD4H] Redoing resize: ${imagePath} to ${newWidth}x${newHeight}`);

    try {
      // Resolve image path using base path
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        throw new Error('Cannot resolve image path: no base directory available');
      }
      const normalizedPath = normalizeImagePath(imagePath);
      const absolutePath = path.resolve(basePath, normalizedPath);

      const allowedRoots = this.getAllowedFileRoots(document);
      if (!allowedRoots.some(root => isPathContainedWithin(absolutePath, root))) {
        throw new Error(
          `Refusing to redo resize for image outside the document/workspace: ${imagePath}`
        );
      }

      const imageUri = vscode.Uri.file(absolutePath);

      // Convert base64 to buffer
      const base64Data = imageData.split(',')[1];
      const buffer = Buffer.from(base64Data, 'base64');

      // Save resized image
      await vscode.workspace.fs.writeFile(imageUri, buffer);
      console.warn(`[MD4H] Image resize redone successfully`);

      webview.postMessage({
        type: 'imageRedoResized',
        success: true,
        imagePath,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to redo resize: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to redo resize: ${errorMessage}`);
      webview.postMessage({
        type: 'imageRedoResized',
        success: false,
        error: errorMessage,
      });
    }
  }

  /**
   * Compute image reference counts across the workspace for UI previews.
   *
   * Returns:
   * - currentFileCount: number of occurrences in the current document
   * - otherFiles: list of other markdown files referencing the same image (with line numbers)
   */
  private async handleGetImageReferences(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const requestId = message.requestId as string;
    const imagePath = message.imagePath as string;

    try {
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        throw new Error('Cannot resolve image base path');
      }

      const normalizedTargetPath = normalizeImagePath(imagePath);
      const absoluteTargetPath = path.resolve(basePath, normalizedTargetPath);
      const normalizedAbsoluteTarget = path.normalize(absoluteTargetPath);

      const fileDir = document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : basePath;

      const imageRefRegex = /!\[([^\]]*)\]\(([^)]+)\)|<img[^>]+src=["']([^"']+)["']/g;
      const currentFileMatches: Array<{ line: number; text: string }> = [];
      const lines = document.getText().split('\n');

      lines.forEach((line, index) => {
        imageRefRegex.lastIndex = 0;
        let match;
        while ((match = imageRefRegex.exec(line)) !== null) {
          const ref = match[2] || match[3];
          if (!ref) continue;

          const normalizedRefPath = normalizeImagePath(ref);
          const absoluteRefPath = path.isAbsolute(normalizedRefPath)
            ? normalizedRefPath
            : path.resolve(fileDir, normalizedRefPath);
          if (path.normalize(absoluteRefPath) === normalizedAbsoluteTarget) {
            currentFileMatches.push({ line: index, text: line });
          }
        }
      });

      const allReferences = await this.findImageReferences(imagePath, basePath);
      const otherFiles =
        document.uri.scheme === 'file'
          ? allReferences.filter(ref => ref.file.fsPath !== document.uri.fsPath)
          : allReferences;

      webview.postMessage({
        type: 'imageReferences',
        requestId,
        imagePath,
        currentFileCount: currentFileMatches.length,
        otherFiles: otherFiles.map(ref => ({
          fsPath: ref.file.fsPath,
          matches: ref.matches,
        })),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to compute image references: ${errorMessage}`);
      webview.postMessage({
        type: 'imageReferences',
        requestId,
        imagePath,
        currentFileCount: 0,
        otherFiles: [],
        error: errorMessage,
      });
    }
  }

  private async handleOpenFileAtLocation(message: {
    type: string;
    [key: string]: unknown;
  }): Promise<void> {
    const fsPath = message.fsPath as string;
    const line = message.line as number | undefined;
    const openToSide = (message.openToSide as boolean) ?? false;

    try {
      if (!fsPath) {
        throw new Error('Missing fsPath');
      }

      const uri = vscode.Uri.file(fsPath);
      const doc = await vscode.workspace.openTextDocument(uri);

      const zeroBasedLine = typeof line === 'number' && line > 0 ? line - 1 : 0;
      const position = new vscode.Position(zeroBasedLine, 0);
      const selection = new vscode.Range(position, position);

      await vscode.window.showTextDocument(doc, {
        viewColumn: openToSide ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
        selection,
        preserveFocus: false,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to open file: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to open file: ${errorMessage}`);
    }
  }

  /**
   * Find all markdown files that reference an image
   */
  private async findImageReferences(
    oldImagePath: string,
    basePath: string
  ): Promise<Array<{ file: vscode.Uri; matches: Array<{ line: number; text: string }> }>> {
    // Find all markdown files
    const markdownFiles = await vscode.workspace.findFiles('**/*.md', null, 1000);

    const results: Array<{ file: vscode.Uri; matches: Array<{ line: number; text: string }> }> = [];

    // Normalize the old path for comparison
    const normalizedOldPath = normalizeImagePath(oldImagePath);
    const absoluteOldPath = path.resolve(basePath, normalizedOldPath);

    for (const file of markdownFiles) {
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        const lines = text.split('\n');

        // Match markdown image syntax: ![alt](path) and <img src="path">
        const imageRefRegex = /!\[([^\]]*)\]\(([^)]+)\)|<img[^>]+src=["']([^"']+)["']/g;
        const matches: Array<{ line: number; text: string }> = [];

        lines.forEach((line, index) => {
          let match;
          // Reset regex lastIndex for each line
          imageRefRegex.lastIndex = 0;
          while ((match = imageRefRegex.exec(line)) !== null) {
            const imagePath = match[2] || match[3]; // Markdown or HTML syntax
            if (!imagePath) continue;

            // Normalize the path from the markdown file
            const fileDir = path.dirname(file.fsPath);
            const normalizedRefPath = normalizeImagePath(imagePath);
            let absoluteRefPath: string;

            // Handle different path formats
            if (path.isAbsolute(normalizedRefPath)) {
              absoluteRefPath = normalizedRefPath;
            } else if (normalizedRefPath.startsWith('./') || normalizedRefPath.startsWith('../')) {
              absoluteRefPath = path.resolve(fileDir, normalizedRefPath);
            } else {
              // Relative path without ./ prefix
              absoluteRefPath = path.resolve(fileDir, normalizedRefPath);
            }

            // Normalize paths for comparison (handle different separators)
            const normalizedAbsoluteOld = path.normalize(absoluteOldPath);
            const normalizedAbsoluteRef = path.normalize(absoluteRefPath);

            // Check if paths match (same file)
            if (normalizedAbsoluteOld === normalizedAbsoluteRef) {
              matches.push({ line: index, text: line });
            }
          }
        });

        if (matches.length > 0) {
          results.push({ file, matches });
        }
      } catch (error) {
        // Skip files that can't be read
        console.warn(`[MD4H] Failed to read file ${file.fsPath}: ${error}`);
      }
    }

    return results;
  }

  /**
   * Update image references in markdown files
   */
  private async updateImageReferences(
    references: Array<{ file: vscode.Uri; matches: Array<{ line: number; text: string }> }>,
    oldFilename: string,
    newFilename: string
  ): Promise<number> {
    const edit = new vscode.WorkspaceEdit();
    let filesUpdated = 0;

    for (const { file, matches } of references) {
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        const lines = text.split('\n');

        // Escape filename for regex
        const escapedOldFilename = oldFilename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Match the filename when preceded by / or ( and followed by ) or " or '
        // This ensures we only replace in path contexts, not random text
        const imagePathRegex = new RegExp(`([(/])${escapedOldFilename}([)"'])`, 'g');

        let updated = false;
        const updatedLines = lines.map((line, index) => {
          // Only update lines that have matches
          if (matches.some(m => m.line === index)) {
            const updatedLine = line.replace(imagePathRegex, `$1${newFilename}$2`);
            if (updatedLine !== line) {
              updated = true;
              return updatedLine;
            }
          }
          return line;
        });

        if (updated) {
          const updatedText = updatedLines.join('\n');
          edit.replace(file, new vscode.Range(0, 0, doc.lineCount, 0), updatedText);
          filesUpdated++;
        }
      } catch (error) {
        console.warn(`[MD4H] Failed to update file ${file.fsPath}: ${error}`);
      }
    }

    if (filesUpdated > 0) {
      await vscode.workspace.applyEdit(edit);
    }

    return filesUpdated;
  }

  private async handleCheckImageRename(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const requestId = message.requestId as string;
    const oldPath = message.oldPath as string;
    const newName = message.newName as string;

    try {
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        throw new Error('Cannot resolve image path: no base directory available');
      }

      const normalizedOldPath = normalizeImagePath(oldPath);
      const absoluteOldPath = path.resolve(basePath, normalizedOldPath);
      const oldUri = vscode.Uri.file(absoluteOldPath);

      // Ensure the source exists
      await vscode.workspace.fs.stat(oldUri);

      const oldExt = path.extname(absoluteOldPath);
      const newFilename = buildImageFilenameForUserRename(newName, oldExt);

      const oldDir = path.dirname(absoluteOldPath);
      const absoluteNewPath = path.join(oldDir, newFilename);
      const newUri = vscode.Uri.file(absoluteNewPath);

      let exists = false;
      try {
        await vscode.workspace.fs.stat(newUri);
        exists = true;
      } catch {
        exists = false;
      }

      const relativeNewPath = path.relative(basePath, absoluteNewPath).replace(/\\/g, '/');
      const normalizedNewPath = relativeNewPath.startsWith('.')
        ? relativeNewPath
        : `./${relativeNewPath}`;

      webview.postMessage({
        type: 'imageRenameCheck',
        requestId,
        exists,
        newFilename,
        newPath: normalizedNewPath,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to check rename target: ${errorMessage}`);
      webview.postMessage({
        type: 'imageRenameCheck',
        requestId,
        exists: false,
        newFilename: '',
        newPath: '',
        error: errorMessage,
      });
    }
  }

  /**
   * Handle image rename request from webview
   * Renames the file and updates references in markdown files across workspace
   */
  private async handleRenameImage(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const oldPath = message.oldPath as string;
    const newName = message.newName as string;
    const updateAllReferences = (message.updateAllReferences as boolean) ?? true;
    const allowOverwrite = (message.allowOverwrite as boolean) ?? false;

    console.warn(`[MD4H] Renaming image: ${oldPath} to ${newName}`);

    try {
      // Resolve the old path
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        throw new Error('Cannot resolve image path: no base directory available');
      }

      const normalizedOldPath = normalizeImagePath(oldPath);
      const absoluteOldPath = path.resolve(basePath, normalizedOldPath);
      const oldUri = vscode.Uri.file(absoluteOldPath);

      // SECURITY: reject paths that escape the document/workspace roots.
      // Without this, a hostile markdown file could rename arbitrary files
      // on disk (e.g. ![](../../../../etc/hosts)) on a single user click.
      const allowedRoots = this.getAllowedFileRoots(document);
      if (!allowedRoots.some(root => isPathContainedWithin(absoluteOldPath, root))) {
        throw new Error(`Refusing to rename image outside the document/workspace: ${oldPath}`);
      }

      // Check if old file exists
      try {
        await vscode.workspace.fs.stat(oldUri);
      } catch {
        throw new Error(`Image not found: ${oldPath}`);
      }

      // Get old filename (used for reference updates)
      const oldFilename = path.basename(absoluteOldPath);

      // Build new filename for manual rename:
      // - Respect the user's chosen name (no auto-dimensions, no auto prefix)
      const oldExt = path.extname(absoluteOldPath);
      const newFilename = buildImageFilenameForUserRename(newName, oldExt);

      const oldDir = path.dirname(absoluteOldPath);
      const absoluteNewPath = path.join(oldDir, newFilename);
      const newUri = vscode.Uri.file(absoluteNewPath);

      // SECURITY: also confirm the destination is contained. Defends against
      // a maliciously crafted `newName` (e.g. `../../../etc/passwd`) that
      // would otherwise escape via the dirname join above.
      if (!allowedRoots.some(root => isPathContainedWithin(absoluteNewPath, root))) {
        throw new Error(
          `Refusing to rename image to a path outside the document/workspace: ${newFilename}`
        );
      }

      // Check if new file already exists
      let targetExists = false;
      try {
        await vscode.workspace.fs.stat(newUri);
        targetExists = true;
      } catch {
        targetExists = false;
      }

      if (targetExists && !allowOverwrite) {
        throw new Error(`File already exists: ${newFilename}`);
      }

      // Find all references if updating all files
      let references: Array<{ file: vscode.Uri; matches: Array<{ line: number; text: string }> }> =
        [];
      if (updateAllReferences) {
        references = await this.findImageReferences(oldPath, basePath);
      }

      if (targetExists && allowOverwrite) {
        try {
          await vscode.workspace.fs.delete(newUri, { useTrash: true });
        } catch (error) {
          console.warn(`[MD4H] Could not move existing file to trash, deleting directly: ${error}`);
          await vscode.workspace.fs.delete(newUri);
        }
      }

      // Rename the file
      await vscode.workspace.fs.rename(oldUri, newUri);
      console.warn(`[MD4H] File renamed to: ${newFilename}`);

      // Calculate new relative path for markdown
      const newRelativePath = path.relative(basePath, absoluteNewPath).replace(/\\/g, '/');
      const normalizedNewPath = newRelativePath.startsWith('.')
        ? newRelativePath
        : `./${newRelativePath}`;

      // Update references
      let filesUpdated = 0;
      if (updateAllReferences && references.length > 0) {
        filesUpdated = await this.updateImageReferences(references, oldFilename, newFilename);
      } else {
        // Update only current document
        const docText = document.getText();
        const escapedOldFilename = oldFilename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const imagePathRegex = new RegExp(`([(/])${escapedOldFilename}([)"'])`, 'g');
        const updatedText = docText.replace(imagePathRegex, `$1${newFilename}$2`);

        if (updatedText !== docText) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), updatedText);
          await vscode.workspace.applyEdit(edit);
          filesUpdated = 1;
        }
      }

      // Notify webview of success
      webview.postMessage({
        type: 'imageRenamed',
        success: true,
        oldPath,
        newPath: normalizedNewPath,
        filesUpdated,
      });

      if (filesUpdated > 1) {
        vscode.window.showInformationMessage(
          `Image renamed to ${newFilename} (updated ${filesUpdated} files)`
        );
      } else {
        vscode.window.showInformationMessage(`Image renamed to ${newFilename}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to rename image: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to rename image: ${errorMessage}`);
      webview.postMessage({
        type: 'imageRenamed',
        success: false,
        error: errorMessage,
      });
    }
  }

  /**
   * Check if image is in workspace
   */
  private async handleCheckImageInWorkspace(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const imagePath = message.imagePath as string;
    const requestId = message.requestId as string;

    try {
      // Resolve image path relative to document base path
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        webview.postMessage({
          type: 'imageWorkspaceCheck',
          requestId,
          inWorkspace: false,
          absolutePath: undefined,
        });
        return;
      }
      const normalizedPath = normalizeImagePath(imagePath);
      const absolutePath = path.resolve(basePath, normalizedPath);

      // Check if file exists
      const imageUri = vscode.Uri.file(absolutePath);
      let fileExists = false;
      try {
        await vscode.workspace.fs.stat(imageUri);
        fileExists = true;
      } catch {
        fileExists = false;
      }

      // Check if path is within workspace
      // For untitled files, getWorkspaceFolder may not work, so check workspaceFolders first
      let workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (
        !workspaceFolder &&
        document.uri.scheme === 'untitled' &&
        vscode.workspace.workspaceFolders &&
        vscode.workspace.workspaceFolders.length > 0
      ) {
        workspaceFolder = vscode.workspace.workspaceFolders[0];
      }

      let inWorkspace = false;

      if (workspaceFolder && fileExists) {
        const workspacePath = workspaceFolder.uri.fsPath;
        // Check if absolute path is within workspace
        inWorkspace =
          absolutePath.startsWith(workspacePath + path.sep) || absolutePath === workspacePath;
      }

      webview.postMessage({
        type: 'imageWorkspaceCheck',
        requestId,
        inWorkspace,
        absolutePath: fileExists ? absolutePath : undefined,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to check image in workspace: ${errorMessage}`);
      webview.postMessage({
        type: 'imageWorkspaceCheck',
        requestId,
        inWorkspace: false,
        absolutePath: undefined,
      });
    }
  }

  /**
   * Get image metadata (file size, dimensions, last modified, etc.)
   */
  private async handleGetImageMetadata(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const imagePath = message.imagePath as string;
    const requestId = message.requestId as string;

    try {
      // Resolve image path relative to document base path
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        webview.postMessage({
          type: 'imageMetadata',
          requestId,
          metadata: null,
        });
        return;
      }

      const normalizedPath = normalizeImagePath(imagePath);
      const absolutePath = path.resolve(basePath, normalizedPath);
      const imageUri = vscode.Uri.file(absolutePath);

      // Check if file exists
      let fileStat: vscode.FileStat;
      try {
        fileStat = await vscode.workspace.fs.stat(imageUri);
      } catch {
        webview.postMessage({
          type: 'imageMetadata',
          requestId,
          metadata: null,
        });
        return;
      }

      // Get image dimensions (requires reading the file)
      // For now, we'll use file size and last modified
      // Dimensions would require image decoding which is expensive
      // We can get dimensions from the img element in the webview instead
      const filename = path.basename(absolutePath);
      const relativePath = path.relative(basePath, absolutePath).replace(/\\/g, '/');
      const normalizedRelativePath = relativePath.startsWith('.')
        ? relativePath
        : `./${relativePath}`;

      webview.postMessage({
        type: 'imageMetadata',
        requestId,
        metadata: {
          filename,
          size: fileStat.size,
          dimensions: { width: 0, height: 0 }, // Will be filled by webview from img element
          lastModified: fileStat.mtime,
          path: normalizedRelativePath,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to get image metadata: ${errorMessage}`);
      webview.postMessage({
        type: 'imageMetadata',
        requestId,
        metadata: null,
      });
    }
  }

  /**
   * Handle reveal image in OS file manager (Finder/Explorer)
   */
  private async handleRevealImageInOS(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument
  ): Promise<void> {
    const imagePath = message.imagePath as string;

    try {
      // Check if image is external (http/https/data URI)
      if (
        imagePath.startsWith('http://') ||
        imagePath.startsWith('https://') ||
        imagePath.startsWith('data:')
      ) {
        vscode.window.showErrorMessage('Cannot reveal external images in file manager');
        return;
      }

      // Resolve image path relative to document base path
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        vscode.window.showErrorMessage('Cannot reveal image: no base directory available');
        return;
      }

      const normalizedPath = normalizeImagePath(imagePath);
      const absolutePath = path.resolve(basePath, normalizedPath);
      const fileUri = vscode.Uri.file(absolutePath);

      // Check if file exists
      try {
        await vscode.workspace.fs.stat(fileUri);
      } catch {
        vscode.window.showErrorMessage(`Image not found: ${imagePath}`);
        return;
      }

      // Reveal file in OS file manager
      await vscode.commands.executeCommand('revealFileInOS', fileUri);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to reveal image in OS: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to reveal image: ${errorMessage}`);
    }
  }

  /**
   * Handle reveal image in VS Code Explorer
   */
  private async handleRevealImageInExplorer(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument
  ): Promise<void> {
    const imagePath = message.imagePath as string;

    try {
      // Check if image is external (http/https/data URI)
      if (
        imagePath.startsWith('http://') ||
        imagePath.startsWith('https://') ||
        imagePath.startsWith('data:')
      ) {
        vscode.window.showErrorMessage('Cannot reveal external images in Explorer');
        return;
      }

      // Resolve image path relative to document base path
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        vscode.window.showErrorMessage('Cannot reveal image: no base directory available');
        return;
      }

      const normalizedPath = normalizeImagePath(imagePath);
      const absolutePath = path.resolve(basePath, normalizedPath);
      const fileUri = vscode.Uri.file(absolutePath);

      // Check if file exists
      try {
        await vscode.workspace.fs.stat(fileUri);
      } catch {
        vscode.window.showErrorMessage(`Image not found: ${imagePath}`);
        return;
      }

      // Reveal file in VS Code Explorer
      await vscode.commands.executeCommand('revealInExplorer', fileUri);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to reveal image in Explorer: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to reveal image: ${errorMessage}`);
    }
  }

  /**
   * File extension categories for filtering
   */
  private readonly FILE_CATEGORIES = {
    md: ['.md', '.markdown'],
    images: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'],
    code: [
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.py',
      '.java',
      '.cpp',
      '.c',
      '.h',
      '.go',
      '.rs',
      '.rb',
      '.php',
      '.swift',
      '.kt',
      '.cs',
      '.sh',
      '.bash',
      '.zsh',
      '.fish',
    ],
    config: ['.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf', '.config', '.properties'],
  };

  /**
   * Handle file search request from webview
   */
  private async handleSearchFiles(
    message: { type: string; [key: string]: unknown },
    webview: vscode.Webview
  ): Promise<void> {
    try {
      const query = (message.query as string) || '';
      const filters = (message.filters as {
        all?: boolean;
        md?: boolean;
        images?: boolean;
        code?: boolean;
        config?: boolean;
      }) || { all: true };
      const requestId = (message.requestId as number) || 0;

      console.warn('[MD4H] File search request:', { query, filters, requestId });

      if (!query || query.trim().length < 1) {
        console.warn('[MD4H] Empty query, returning empty results');
        webview.postMessage({
          type: 'fileSearchResults',
          results: [],
          requestId,
        });
        return;
      }

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        console.warn('[MD4H] No workspace folders found');
        webview.postMessage({
          type: 'fileSearchResults',
          results: [],
          requestId,
        });
        return;
      }

      // More permissive exclude pattern - only exclude truly unnecessary directories
      const excludePattern =
        '{**/node_modules/**,**/.git/**,**/.vscode/**,**/dist/**,**/build/**,**/.next/**,**/coverage/**}';
      console.warn('[MD4H] Searching files with pattern:', excludePattern);

      // Use a more conservative limit (2000) to prevent memory pressure in massive repositories
      // while still providing enough results for most users.
      const allFiles = await vscode.workspace.findFiles(
        '**/*',
        excludePattern,
        MarkdownEditorProvider.MAX_FILE_SEARCH_RESULTS
      );
      console.warn('[MD4H] Found', allFiles.length, 'files total');

      let filteredFiles = allFiles;
      if (!filters.all) {
        const allowedExtensions = new Set<string>();
        if (filters.md) {
          this.FILE_CATEGORIES.md.forEach(ext => allowedExtensions.add(ext));
        }
        if (filters.images) {
          this.FILE_CATEGORIES.images.forEach(ext => allowedExtensions.add(ext));
        }
        if (filters.code) {
          this.FILE_CATEGORIES.code.forEach(ext => allowedExtensions.add(ext));
        }
        if (filters.config) {
          this.FILE_CATEGORIES.config.forEach(ext => allowedExtensions.add(ext));
        }

        filteredFiles = allFiles.filter(uri => {
          const ext = path.extname(uri.fsPath).toLowerCase();
          return allowedExtensions.has(ext);
        });
        console.warn('[MD4H] After filter:', filteredFiles.length, 'files');
      }

      const queryLower = query.toLowerCase().trim();
      const queryParts = queryLower.split(/\s+/).filter(p => p.length > 0);

      // Enhanced matching: search by filename, path, and individual query parts
      const matchingFiles = filteredFiles.filter(uri => {
        const filename = path.basename(uri.fsPath);
        const filenameLower = filename.toLowerCase();
        const relativePath = this.getRelativePath(uri, workspaceFolders[0].uri);
        const pathLower = relativePath.toLowerCase();

        // Primary match: filename contains query
        if (filenameLower.includes(queryLower)) {
          return true;
        }

        // Secondary match: path contains query
        if (pathLower.includes(queryLower)) {
          return true;
        }

        // Tertiary match: all query parts appear in filename or path
        if (queryParts.length > 1) {
          const allPartsMatch = queryParts.every(
            part => filenameLower.includes(part) || pathLower.includes(part)
          );
          if (allPartsMatch) {
            return true;
          }
        }

        // Match filename without extension
        const filenameWithoutExt = path.parse(filename).name.toLowerCase();
        if (filenameWithoutExt.includes(queryLower)) {
          return true;
        }

        return false;
      });

      console.warn('[MD4H] Found', matchingFiles.length, 'matching files');

      // Sort results: exact filename matches first, then path matches, then partial matches
      const sortedFiles = matchingFiles.sort((a, b) => {
        const aFilename = path.basename(a.fsPath).toLowerCase();
        const bFilename = path.basename(b.fsPath).toLowerCase();
        const aPath = this.getRelativePath(a, workspaceFolders[0].uri).toLowerCase();
        const bPath = this.getRelativePath(b, workspaceFolders[0].uri).toLowerCase();

        // Exact filename match gets highest priority
        const aExactMatch = aFilename === queryLower;
        const bExactMatch = bFilename === queryLower;
        if (aExactMatch && !bExactMatch) return -1;
        if (!aExactMatch && bExactMatch) return 1;

        // Filename starts with query gets second priority
        const aStartsWith = aFilename.startsWith(queryLower);
        const bStartsWith = bFilename.startsWith(queryLower);
        if (aStartsWith && !bStartsWith) return -1;
        if (!aStartsWith && bStartsWith) return 1;

        // Filename contains query gets third priority
        const aFilenameContains = aFilename.includes(queryLower);
        const bFilenameContains = bFilename.includes(queryLower);
        if (aFilenameContains && !bFilenameContains) return -1;
        if (!aFilenameContains && bFilenameContains) return 1;

        // Path contains query gets fourth priority
        const aPathContains = aPath.includes(queryLower);
        const bPathContains = bPath.includes(queryLower);
        if (aPathContains && !bPathContains) return -1;
        if (!aPathContains && bPathContains) return 1;

        // Alphabetical by filename
        return aFilename.localeCompare(bFilename);
      });

      const results = sortedFiles.slice(0, 20).map(uri => {
        const filename = path.basename(uri.fsPath);
        const relativePath = this.getRelativePath(uri, workspaceFolders[0].uri);
        return {
          filename,
          path: relativePath,
        };
      });

      console.warn('[MD4H] Sending', results.length, 'results to webview');
      webview.postMessage({
        type: 'fileSearchResults',
        results,
        requestId,
      });
    } catch (error) {
      console.error('[MD4H] Error searching files:', error);
      const requestId = (message.requestId as number) || 0;
      webview.postMessage({
        type: 'fileSearchResults',
        results: [],
        requestId,
        error: 'Failed to search files',
      });
    }
  }

  /**
   * Get relative path from workspace root
   */
  private getRelativePath(fileUri: vscode.Uri, workspaceUri: vscode.Uri): string {
    const filePath = fileUri.fsPath;
    const workspacePath = workspaceUri.fsPath;

    if (filePath.startsWith(workspacePath)) {
      let relative = path.relative(workspacePath, filePath);
      relative = relative.replace(/\\/g, '/');
      return relative;
    }

    return path.basename(filePath);
  }

  /**
   * Handle external link navigation (open in browser)
   */
  private async handleOpenExternalLink(message: {
    type: string;
    [key: string]: unknown;
  }): Promise<void> {
    try {
      const url = (message.url as string) || '';
      console.warn('[MD4H] handleOpenExternalLink called with URL:', url);

      if (!url) {
        console.warn('[MD4H] No URL provided for external link');
        return;
      }

      // Validate URL format
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('mailto:')) {
        console.warn('[MD4H] Invalid external URL format:', url);
        return;
      }

      console.warn('[MD4H] Opening external link:', url);
      await vscode.env.openExternal(vscode.Uri.parse(url));
      console.warn('[MD4H] Successfully opened external link');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[MD4H] Failed to open external link:', errorMessage, error);
      vscode.window.showErrorMessage(`Failed to open link: ${errorMessage}`);
    }
  }

  /**
   * Handle image link navigation (open image in VS Code preview)
   */
  private async handleOpenImage(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument
  ): Promise<void> {
    const imagePath = String(message.path || '');
    if (!imagePath) {
      console.warn('[MD4H] No image path provided');
      return;
    }

    console.warn('[MD4H] handleOpenImage called with path:', imagePath);

    // Normalize path: remove ./ prefix if present for path resolution
    const normalizedPath = imagePath.startsWith('./') ? imagePath.slice(2) : imagePath;

    // Try document-relative first
    let baseDir: string | undefined;
    if (document.uri.scheme === 'file') {
      baseDir = path.dirname(document.uri.fsPath);
    } else {
      baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    if (!baseDir) {
      console.error('[MD4H] Cannot resolve image path: no base directory');
      vscode.window.showWarningMessage('Cannot resolve image path');
      return;
    }

    let imageFullPath = path.resolve(baseDir, normalizedPath);
    let imageUri = vscode.Uri.file(imageFullPath);
    console.warn('[MD4H] Trying document-relative path:', imageFullPath);

    // Check if file exists at document-relative path
    let fileExists = false;
    try {
      await vscode.workspace.fs.stat(imageUri);
      fileExists = true;
      console.warn('[MD4H] Image found at document-relative path');
    } catch {
      console.warn('[MD4H] Image not found at document-relative path, trying workspace root');

      // Fallback: try workspace root
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const workspacePath = workspaceFolder.uri.fsPath;
        imageFullPath = path.resolve(workspacePath, normalizedPath);
        imageUri = vscode.Uri.file(imageFullPath);
        console.warn('[MD4H] Trying workspace-relative path:', imageFullPath);

        try {
          await vscode.workspace.fs.stat(imageUri);
          fileExists = true;
          console.warn('[MD4H] Image found at workspace-relative path');
        } catch {
          console.warn('[MD4H] Image not found at workspace-relative path either');
        }
      }
    }

    if (!fileExists) {
      const errorMsg = `Image not found: ${imagePath}`;
      console.error('[MD4H]', errorMsg);
      vscode.window.showErrorMessage(errorMsg);
      return;
    }

    try {
      console.warn('[MD4H] Opening image:', imageUri.fsPath);
      await vscode.commands.executeCommand('vscode.open', imageUri);
      console.warn('[MD4H] Successfully opened image');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('[MD4H] Failed to open image:', errorMessage, err);
      vscode.window.showErrorMessage(`Failed to open image: ${errorMessage}`);
    }
  }

  /**
   * Handle file link navigation (open file in VS Code)
   */
  private async handleOpenFileLink(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument
  ): Promise<void> {
    try {
      const filePath = (message.path as string) || '';
      console.warn('[MD4H] handleOpenFileLink called with path:', filePath);

      if (!filePath) {
        console.warn('[MD4H] No path provided for file link');
        return;
      }

      // Resolve relative path from current document
      const basePath = path.dirname(document.uri.fsPath);

      // Normalize path: remove ./ prefix if present for path resolution
      const normalizedFilePath = filePath.startsWith('./') ? filePath.slice(2) : filePath;
      const absolutePath = path.resolve(basePath, normalizedFilePath);
      let fileUri = vscode.Uri.file(absolutePath);
      console.warn('[MD4H] Resolved file URI (document-relative):', fileUri.fsPath);

      // Check if file exists
      let fileExists = false;
      try {
        await vscode.workspace.fs.stat(fileUri);
        fileExists = true;
        console.warn('[MD4H] File exists (document-relative):', fileUri.fsPath);
      } catch {
        // File doesn't exist, try to find it in workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          // Try relative to workspace root
          const workspacePath = workspaceFolders[0].uri.fsPath;
          // Use normalized path (already normalized above)
          const workspaceFileUri = vscode.Uri.file(path.resolve(workspacePath, normalizedFilePath));
          console.warn('[MD4H] Trying workspace-relative path:', workspaceFileUri.fsPath);
          try {
            await vscode.workspace.fs.stat(workspaceFileUri);
            fileUri = workspaceFileUri;
            fileExists = true;
            console.warn('[MD4H] File exists (workspace-relative):', fileUri.fsPath);
          } catch {
            // Not found in workspace either
            console.warn('[MD4H] File not found in workspace-relative path');
          }
        }
      }

      if (!fileExists) {
        // File not found, show error
        vscode.window.showWarningMessage(`File not found: ${filePath}`);
        console.warn('[MD4H] File not found:', filePath);
        return;
      }

      // Check if file is an image
      const imageExtensions = [
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.svg',
        '.webp',
        '.bmp',
        '.ico',
        '.tiff',
        '.tif',
      ];
      const fileExtension = path.extname(fileUri.fsPath).toLowerCase();
      const isImage = imageExtensions.includes(fileExtension);
      console.warn('[MD4H] File extension:', fileExtension, '| Is image:', isImage);

      if (isImage) {
        // For image files, use vscode.open command directly
        // This automatically opens images in VS Code's image preview
        console.warn('[MD4H] Attempting to open image file with vscode.open command');
        try {
          await vscode.commands.executeCommand('vscode.open', fileUri);
          console.warn('[MD4H] Successfully opened image file:', fileUri.fsPath);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error('[MD4H] Failed to open image file:', errorMessage, error);
          vscode.window.showErrorMessage(`Failed to open image file: ${errorMessage}`);
        }
      } else {
        // For text files, use openTextDocument
        console.warn('[MD4H] Attempting to open text file with openTextDocument');
        try {
          const doc = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(doc);
          console.warn('[MD4H] Successfully opened file link:', fileUri.fsPath);
        } catch (error) {
          // If it's not a text file, try vscode.open command as fallback
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.warn('[MD4H] openTextDocument failed, error:', errorMessage);
          if (errorMessage.includes('Binary') || errorMessage.includes('binary')) {
            console.warn('[MD4H] File is binary, trying vscode.open command as fallback');
            try {
              await vscode.commands.executeCommand('vscode.open', fileUri);
              console.warn('[MD4H] Opened binary file using vscode.open command');
            } catch (fallbackError) {
              console.error('[MD4H] Failed to open file:', fallbackError);
              vscode.window.showErrorMessage(`Failed to open file: ${errorMessage}`);
            }
          } else {
            throw error;
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[MD4H] Failed to open file link:', errorMessage, error);
      vscode.window.showErrorMessage(`Failed to open file: ${errorMessage}`);
    }
  }

  /**
   * Copy local image (outside workspace) to workspace
   */
  private async handleCopyLocalImageToWorkspace(
    message: { type: string; [key: string]: unknown },
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const absolutePath = message.absolutePath as string;
    const placeholderId = message.placeholderId as string;
    const targetFolder = (message.targetFolder as string) || 'images';

    console.warn(`[MD4H] Copying local image to workspace: ${absolutePath}`);

    try {
      // Read the source image
      const sourceUri = vscode.Uri.file(absolutePath);
      const imageData = await vscode.workspace.fs.readFile(sourceUri);

      const saveBasePath = this.getImageStorageBasePath(document);
      if (!saveBasePath) {
        const errorMessage = 'Cannot copy image: no base directory available';
        vscode.window.showErrorMessage(errorMessage);
        webview.postMessage({
          type: 'localImageCopyError',
          placeholderId,
          error: errorMessage,
        });
        return;
      }
      const imagesDir = path.join(saveBasePath, targetFolder);
      if (!isPathContainedWithin(imagesDir, saveBasePath)) {
        const errorMessage = `Refusing to copy image outside the base directory: ${targetFolder}`;
        vscode.window.showErrorMessage(errorMessage);
        webview.postMessage({ type: 'localImageCopyError', placeholderId, error: errorMessage });
        return;
      }

      // Create folder if needed
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(imagesDir));

      // Generate filename from source
      const sourceFilename = path.basename(absolutePath);
      const parsedName = path.parse(sourceFilename);
      const baseFilename = parsedName.name || 'image';
      const extension = parsedName.ext || '';

      let finalFilename = sourceFilename;
      let targetPath = path.join(imagesDir, finalFilename);
      let targetUri = vscode.Uri.file(targetPath);

      const fileExists = async (uri: vscode.Uri): Promise<boolean> => {
        try {
          await vscode.workspace.fs.stat(uri);
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('ENOENT') || message.includes('FileNotFound')) {
            return false;
          }
          throw error;
        }
      };

      if (await fileExists(targetUri)) {
        let foundAvailableName = false;
        for (let suffix = 2; suffix < 1000; suffix += 1) {
          finalFilename = `${baseFilename}-${suffix}${extension}`;
          targetPath = path.join(imagesDir, finalFilename);
          targetUri = vscode.Uri.file(targetPath);
          if (!(await fileExists(targetUri))) {
            foundAvailableName = true;
            break;
          }
        }
        if (!foundAvailableName) {
          throw new Error(
            `Cannot copy image: too many existing files matching "${baseFilename}-N${extension}"`
          );
        }
      }

      // Copy file to workspace
      await vscode.workspace.fs.writeFile(targetUri, imageData);

      // Calculate relative path for markdown
      const markdownDir =
        document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : saveBasePath;
      let relativePath = path.relative(markdownDir, targetPath).replace(/\\/g, '/');
      if (!relativePath.startsWith('..') && !relativePath.startsWith('./')) {
        relativePath = './' + relativePath;
      }

      console.warn(`[MD4H] Local image copied successfully. Path: ${relativePath}`);

      webview.postMessage({
        type: 'localImageCopied',
        placeholderId,
        relativePath,
        originalPath: absolutePath, // For finding the image node
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to copy local image: ${errorMessage}`);
      vscode.window.showErrorMessage(`Failed to copy image: ${errorMessage}`);
      webview.postMessage({
        type: 'localImageCopyError',
        placeholderId,
        error: errorMessage,
      });
    }
  }

  /**
   * Handle setting update request from webview
   */
  private async handleUpdateSetting(
    message: { type: string; [key: string]: unknown },
    webview: vscode.Webview
  ): Promise<void> {
    const key = message.key as string;
    const value = message.value as unknown;

    try {
      const config = vscode.workspace.getConfiguration();
      await config.update(key, value, vscode.ConfigurationTarget.Global);
      console.warn(`[MD4H] Setting updated: ${key} = ${value}`);

      // Immediately notify webview of the setting change
      // This ensures the setting takes effect right away without waiting for next update
      const skipWarning = config.get<boolean>('markdownForHumans.imageResize.skipWarning', false);
      const imagePath = config.get<string>('markdownForHumans.imagePath', 'images');
      const imagePathBase = config.get<string>(
        'markdownForHumans.imagePathBase',
        'relativeToDocument'
      );
      webview.postMessage({
        type: 'settingsUpdate',
        skipResizeWarning: skipWarning,
        imagePath: imagePath,
        imagePathBase: imagePathBase,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to update setting: ${errorMessage}`);
    }
  }

  /**
   * After a Preserve↔Strip switch rewrites the document buffer, either save
   * the file automatically (if VS Code's `files.autoSave` is enabled) or tell
   * the user why their on-disk file doesn't yet reflect the new mode.
   *
   * Untitled documents are skipped — saving them would open a Save As dialog,
   * which isn't the behavior the setting change implies.
   */
  private async handleBlankLineModeSavePolicy(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    if (document.uri.scheme === 'untitled') return;
    if (!document.isDirty) return;

    const autoSave = vscode.workspace.getConfiguration('files').get<string>('autoSave', 'off');

    if (autoSave !== 'off') {
      // Autosave is on in any mode — VS Code may or may not actually fire it
      // for a custom-editor focus change, so persist it ourselves to be sure.
      await this.flushAndSaveIfDirty(document, webviewPanel.webview);
      return;
    }

    // Autosave is off. Show the prompt once globally, not once per open panel.
    const now = Date.now();
    if (now - MarkdownEditorProvider.lastBlankLineSavePromptAt < 1000) return;
    MarkdownEditorProvider.lastBlankLineSavePromptAt = now;
    void vscode.window.showInformationMessage('Save the file to see the changes.');
  }

  /**
   * Flush any pending webview-side debounce, await in-flight edits, then save
   * the document if it's dirty. Called by the autosave bridge whenever VS Code
   * would normally fire autosave but can't see the custom editor's focus/state
   * transitions (the webview is an iframe, not a `TextEditor`).
   *
   * No-ops for untitled documents — saving those would pop a "Save As" dialog,
   * which isn't autosave behavior.
   */
  private async flushAndSaveIfDirty(
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    if (document.uri.scheme === 'untitled') return;

    // 1. Ask the webview to fire any debounced edit synchronously so the
    //    latest content lands in our message queue *before* we save.
    const requestId = `flush-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const ack = new Promise<void>(resolve => {
      this.flushAckResolvers.set(requestId, resolve);
      // Defensive: don't block save forever if the ack never arrives
      // (webview unloading, message channel torn down, etc.).
      setTimeout(() => {
        if (this.flushAckResolvers.delete(requestId)) resolve();
      }, 250);
    });
    webview.postMessage({ type: 'flushPendingEdit', requestId });
    await ack;

    // 2. The `edit` message (if the webview sent one) reaches `handleWebviewMessage`
    //    before the ack, so by now its applyEdit Promise is in-flight. Await it
    //    so save() sees the post-edit buffer.
    const inFlight = this.inFlightApplyEdits.get(document.uri.toString());
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // applyEdit handles its own errors; ignore here.
      }
    }

    if (!document.isDirty) return;

    try {
      await document.save();
    } catch (error) {
      console.error('[MD4H] Autosave document.save() failed:', error);
    }
  }

  /**
   * Lazily register the global `window.onDidChangeWindowState` listener that
   * drives `onWindowChange` autosave. Guarded with a `typeof` check so unit-test
   * mocks of `vscode.window` that don't include this API don't crash.
   */
  private ensureWindowStateListener(): void {
    if (this.windowStateListener) return;
    const onWindowStateChange = vscode.window.onDidChangeWindowState;
    if (typeof onWindowStateChange !== 'function') return;
    this.windowStateListener = onWindowStateChange(state => {
      if (state.focused) return;
      const autoSave = vscode.workspace.getConfiguration('files').get<string>('autoSave', 'off');
      if (autoSave !== 'onWindowChange') return;
      for (const { panel, document } of this.openPanels.values()) {
        void this.flushAndSaveIfDirty(document, panel.webview).catch(error => {
          console.error('[MD4H] Autosave on window-state change failed:', error);
        });
      }
    });
    if (this.context.subscriptions && Array.isArray(this.context.subscriptions)) {
      this.context.subscriptions.push(this.windowStateListener);
    }
  }

  /**
   * Apply edits from webview to TextDocument
   * Marks the edit with a timestamp to prevent feedback loops
   *
   * @param content - Markdown content from webview (may include wrapped frontmatter)
   * @param document - Target VS Code document to update
   * @returns Promise resolving to true if edit succeeded, false otherwise
   * @throws Never - errors are caught and shown to user
   */
  private async applyEdit(
    content: string,
    document: vscode.TextDocument,
    options?: { editReason?: 'typing' | 'save-policy-enforce' }
  ): Promise<boolean> {
    // Skip if content unchanged (avoid redundant edits)
    const unwrappedContent = this.unwrapFrontmatterFromWebview(content);
    const blankLineMode = this.getBlankLineMode();
    const policyContent = applyBlankLinePolicy(unwrappedContent, blankLineMode);
    // Normalize the inbound text to exactly one trailing newline (markdownlint
    // MD047). Done up-front so the equality and AST checks below compare the
    // form we'd actually write — a doc on disk that already ends with `\n`
    // matches a no-newline serialization and is short-circuited as a no-op.
    const normalizedContent = ensureSingleTrailingNewline(policyContent);
    const currentText = document.getText();
    if (normalizedContent === currentText) {
      return true;
    }

    // Suppress writes whose only difference is the WYSIWYG serializer's house
    // style — bullet marker swaps, ordered-list renumbering, blank-line
    // collapsing, soft-wrap reflow, etc. When the inbound text renders to the
    // same document as what's already on disk, leave the original bytes alone
    // so files authored against `markdownlint` stay lint-clean across opens.
    // Real edits (any change to rendered content) are detected and fall through.
    //
    // In `preserve` mode, blank-line layout is part of the document the user
    // is editing — markdown-it renders identical HTML regardless of how many
    // blank lines sit between blocks, so we additionally require the blank-line
    // signatures to match. Without this, adding or removing blank lines in the
    // WYSIWYG would never reach the TextDocument and the file would stay clean.
    const shouldEnforcePolicy = options?.editReason === 'save-policy-enforce';
    const renderEquivalent =
      !shouldEnforcePolicy && isMarkdownStructurallyEquivalent(normalizedContent, currentText);
    const blankLineLayoutMatters = blankLineMode === 'preserve';
    const blankLineLayoutMatches =
      !blankLineLayoutMatters || hasSameBlankLineLayout(normalizedContent, currentText);
    if (renderEquivalent && blankLineLayoutMatches) {
      // Update the cache so updateWebview() doesn't loop the canonical form
      // back to the webview as if it were an external change.
      this.lastWebviewContent.set(document.uri.toString(), currentText);
      return true;
    }

    // Mark this edit to prevent feedback loop
    const docUri = document.uri.toString();
    this.pendingEdits.set(docUri, Date.now());
    // When policy enforcement modifies the content (e.g., stripping blank lines),
    // set lastWebviewContent to the ORIGINAL content so that updateWebview()
    // will detect a mismatch and refresh the webview with the stripped content.
    // Otherwise, the webview would never refresh to show the policy-enforced state.
    const contentWasModified = normalizedContent !== unwrappedContent;
    if (shouldEnforcePolicy && contentWasModified) {
      this.lastWebviewContent.set(docUri, unwrappedContent);
    } else {
      this.lastWebviewContent.set(docUri, normalizedContent);
    }

    const edit = new vscode.WorkspaceEdit();

    // Replace entire document content
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );

    edit.replace(document.uri, fullRange, normalizedContent);

    try {
      const success = await vscode.workspace.applyEdit(edit);
      if (!success) {
        const errorMsg = 'Failed to save changes. The file may be read-only or locked.';
        vscode.window.showErrorMessage(errorMsg);
        console.error('[MD4H] applyEdit failed:', { uri: docUri });
      }
      return success;
    } catch (error) {
      const errorMsg =
        error instanceof Error
          ? `Failed to save changes: ${error.message}`
          : 'Failed to save changes: Unknown error';
      vscode.window.showErrorMessage(errorMsg);
      console.error('[MD4H] applyEdit exception:', error);
      return false;
    }
  }

  /**
   * Wrap YAML frontmatter in a fenced code block for webview rendering.
   * Returns original content when no frontmatter is present.
   */
  private wrapFrontmatterForWebview(content: string): string {
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    if (!match) return content;

    const usesCrLf = match[0].includes('\r\n');
    const newline = usesCrLf ? '\r\n' : '\n';
    const frontmatterBlock = match[0].replace(/\s+$/, ''); // keep delimiters
    const body = content.slice(match[0].length);

    // Choose a fence longer than the longest backtick run inside the
    // frontmatter. If a YAML value contains a ``` (e.g. a fenced code sample in
    // a multiline scalar), a plain 3-backtick fence would be closed early by the
    // webview's markdown parser, fragmenting the frontmatter and losing fields
    // on save. CommonMark requires the closing fence to be at least as long as
    // the opening one, so a longer fence keeps the whole block intact. Mirrors
    // prosemirror-markdown's own code_block fence logic so a re-serialized block
    // round-trips through unwrapFrontmatterFromWebview.
    const backtickRuns = frontmatterBlock.match(/`{3,}/g);
    const fence = backtickRuns
      ? '`'.repeat(Math.max(...backtickRuns.map(run => run.length)) + 1)
      : '```';

    const pieces = [`${fence}yaml`, frontmatterBlock, fence];
    if (body.length > 0) {
      // Ensure exactly one blank line between fenced block and body
      const trimmedBody =
        body.startsWith('\n') || body.startsWith('\r\n') ? body.replace(/^\r?\n/, '') : body;
      pieces.push('', trimmedBody);
    }

    return pieces.join(newline);
  }

  /**
   * Unwrap a fenced frontmatter code block back to YAML delimiters.
   * If no wrapped frontmatter is detected, returns the original content.
   */
  private unwrapFrontmatterFromWebview(content: string): string {
    if (!content.startsWith('```')) return content;

    const usesCrLf = content.includes('\r\n');
    const newline = usesCrLf ? '\r\n' : '\n';
    const lines = content.split(newline);

    // Accept a fence of 3+ backticks: wrapFrontmatterForWebview lengthens it when
    // the frontmatter contains an embedded ``` run, and prosemirror-markdown does
    // the same on re-serialize. The closing fence must match the opener's length.
    const fenceMatch = lines[0]
      .trim()
      .toLowerCase()
      .match(/^(`{3,})(yaml|yml|json)$/);
    if (!fenceMatch) {
      return content;
    }
    const fence = fenceMatch[1];

    const closingIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === fence);
    if (closingIndex === -1) return content;

    const insideLines = lines.slice(1, closingIndex);
    // Expect inside to start with '---'
    if (insideLines.length === 0 || insideLines[0].trim() !== '---') {
      return content;
    }

    const frontmatterSection = insideLines.join(newline);
    const bodyLines = lines.slice(closingIndex + 1);
    const body = bodyLines.join(newline);

    const separator = body.length > 0 ? newline : '';
    return frontmatterSection + separator + body;
  }

  /**
   * Generate HTML for webview
   */
  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css')
    );

    // Use a nonce for security
    const nonce = getNonce();

    return /* html */ `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy"
              content="default-src 'none';
                       style-src ${webview.cspSource} 'unsafe-inline';
                       script-src 'nonce-${nonce}';
                       font-src ${webview.cspSource};
                       img-src ${webview.cspSource} https: data: blob:;">
        
        <link href="${styleUri}" rel="stylesheet">
        <title>Markdown for Humans</title>
      </head>
      <body>
        <div id="editor"></div>
        <script nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>
    `;
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Normalize an image path by URL-decoding each path segment.
 *
 * Handles paths like:
 * - `images/Hero%20Image.png` → `images/Hero Image.png`
 * - `../assets/My%20Diagram%201.png` → `../assets/My Diagram 1.png`
 * - `./screenshots/test.png` → `./screenshots/test.png` (unchanged)
 *
 * This makes the editor tolerant of URL-encoded paths commonly found in
 * markdown imported from web tools, GitHub, or static site generators.
 *
 * @param imagePath - The raw image path from markdown src attribute
 * @returns Normalized path with URL-encoded segments decoded
 */
export function normalizeImagePath(imagePath: string): string {
  // Don't touch remote URLs, data URIs, or already-resolved webview URIs
  if (
    imagePath.startsWith('http://') ||
    imagePath.startsWith('https://') ||
    imagePath.startsWith('data:') ||
    imagePath.startsWith('vscode-webview://')
  ) {
    return imagePath;
  }

  // Handle file:// URIs by stripping the scheme and decoding
  if (imagePath.startsWith('file://')) {
    try {
      return decodeURIComponent(imagePath.replace('file://', ''));
    } catch {
      return imagePath.replace('file://', '');
    }
  }

  // Split on forward slashes, decode each segment, rejoin
  // This preserves directory structure while decoding %20, %23, etc.
  return imagePath
    .split('/')
    .map(segment => {
      if (segment === '' || segment === '.' || segment === '..') {
        return segment;
      }
      try {
        return decodeURIComponent(segment);
      } catch {
        // If decoding fails (malformed %), return segment as-is
        return segment;
      }
    })
    .join('/');
}

/**
 * Path-traversal defense.
 *
 * Returns true iff `targetAbsolutePath` is `rootAbsolutePath` itself or a
 * descendant of it. Used by the file-mutating message handlers (rename,
 * resize) to reject attacker-supplied paths from a hostile markdown
 * document — e.g. `<img src="../../../../etc/passwd">`.
 *
 * Both inputs MUST already be absolute. Caller is responsible for
 * `path.resolve()` first.
 *
 * Notable defense: this is NOT a naive `target.startsWith(root)` check —
 * that bug would mis-classify `/tmp/workspace-evil` as inside `/tmp/workspace`.
 * We require either equality or `root + path.sep` as a prefix.
 */
export function isPathContainedWithin(
  targetAbsolutePath: string,
  rootAbsolutePath: string
): boolean {
  if (!targetAbsolutePath || !rootAbsolutePath) {
    return false;
  }
  // path.resolve canonicalizes drive letters on Windows (e.g. turns the
  // drive-relative "/workspace/docs" into "C:\workspace\docs"), so both
  // target and root end up on the same drive before comparison.
  const normalizedTarget = path.resolve(targetAbsolutePath);
  const normalizedRoot = path.resolve(rootAbsolutePath);

  // Strip trailing separator from root (path.normalize keeps "/" for "/")
  const rootNoSep =
    normalizedRoot.length > 1 && normalizedRoot.endsWith(path.sep)
      ? normalizedRoot.slice(0, -1)
      : normalizedRoot;

  // Case-insensitive on Windows; case-sensitive on macOS / Linux
  const target = process.platform === 'win32' ? normalizedTarget.toLowerCase() : normalizedTarget;
  const root = process.platform === 'win32' ? rootNoSep.toLowerCase() : rootNoSep;

  return target === root || target.startsWith(root + path.sep);
}
