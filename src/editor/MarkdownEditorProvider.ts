/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { outlineViewProvider } from '../features/outlineView';
import { setActiveWebviewPanel, getActiveWebviewPanel } from '../activeWebview';

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
  // Track pending edits to avoid feedback loops
  // Key: document URI, Value: timestamp of last edit from webview
  private pendingEdits = new Map<string, number>();
  // Remember last content sent from the webview so we can skip redundant updates
  private lastWebviewContent = new Map<string, string>();

  // Use a promise queue per document to ensure edits are processed sequentially
  private editQueue = new Map<string, Promise<void>>();

  /**
   * Helper to retrieve all webview-related configuration settings.
   */
  private getWebviewSettings(config: vscode.WorkspaceConfiguration) {
    return {
      skipResizeWarning: config.get<boolean>('markdownForHumans.imageResize.skipWarning', false),
      mediaPath: config.get<string>('markdownForHumans.mediaPath', 'media'),
      mediaPathBase: config.get<string>('markdownForHumans.mediaPathBase', 'sameNameFolder'),
      lineSpacing: config.get<number>('markdownForHumans.lineSpacing', 1),
      paragraphSpacing: config.get<number>('markdownForHumans.paragraphSpacing', 1),
      tableCellSpacing: config.get<number>('markdownForHumans.tableCellSpacing', 0.1),
      tableCellHorizontalSpacing: config.get<number>(
        'markdownForHumans.tableCellHorizontalSpacing',
        0.5
      ),
      themeOverride: config.get<string>('markdownForHumans.themeOverride', 'system'),
      developerMode: config.get<boolean>('markdownForHumans.developerMode', true),
    };
  }

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new MarkdownEditorProvider(context);
    const providerRegistration = vscode.window.registerCustomEditorProvider(
      'markdownForHumans.editor',
      provider,
      {
        webviewOptions: {
          enableFindWidget: true,
          retainContextWhenHidden: true,
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
   * Returns workspace folder or document directory if available, otherwise home directory
   * This enables absolute paths to work even without workspace
   */
  private getImageBasePath(document: vscode.TextDocument): string | null {
    const docDir = this.getDocumentDirectory(document);
    if (docDir) {
      return docDir;
    }
    // For untitled files without workspace, use user's home directory
    // This allows absolute paths to work
    return os.homedir();
  }

  /**
   * Get the base directory where new images should be saved.
   *
   * This is separate from `getImageBasePath()` (which is used to resolve
   * existing markdown image links relative to the markdown file).
   */
  private getImageStorageBasePath(document: vscode.TextDocument): string | null {
    const config = vscode.workspace.getConfiguration();
    const mediaPathBase = config.get<string>('markdownForHumans.mediaPathBase', 'sameNameFolder');

    // Untitled docs: default to workspace-level saves when possible (we don't know
    // the final markdown file directory yet).
    if (document.uri.scheme === 'untitled') {
      return this.getWorkspaceFolderPath(document) ?? this.getImageBasePath(document);
    }

    if (mediaPathBase === 'sameNameFolder') {
      const docPath = document.uri.fsPath;
      const docDir = path.dirname(docPath);
      const ext = path.extname(docPath);
      const baseName = path.basename(docPath, ext);
      return path.join(docDir, baseName);
    }

    if (mediaPathBase === 'workspaceFolder') {
      return this.getWorkspaceFolderPath(document) ?? this.getImageBasePath(document);
    }

    // Default: relativeToDocument
    return (
      this.getDocumentDirectory(document) ?? this.getWorkspaceFolderPath(document) ?? os.homedir()
    );
  }

  /**
   * Get the resolved target folder for saving media
   * Returns the absolute *folder* path where the media file will be placed.
   */
  private resolveMediaTargetFolder(
    document: vscode.TextDocument,
    requestedFolder: string
  ): string | null {
    const config = vscode.workspace.getConfiguration();
    const mediaPathBase = config.get<string>('markdownForHumans.mediaPathBase', 'sameNameFolder');

    if (mediaPathBase === 'sameNameFolder' || requestedFolder === '__sameNameFolder__') {
      const docPath = document.uri.fsPath;
      if (document.uri.scheme !== 'file') {
        return path.join(os.homedir(), 'media');
      }
      const docDir = path.dirname(docPath);
      const ext = path.extname(docPath);
      const baseName = path.basename(docPath, ext);
      return path.join(docDir, baseName);
    }

    const saveBasePath = this.getImageStorageBasePath(document);
    if (!saveBasePath) return null;
    return path.join(saveBasePath, requestedFolder);
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
      // For untitled files without workspace, include home directory to allow absolute path image resolution
      localResourceRoots.push(vscode.Uri.file(os.homedir()));
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
    // Update webview when document changes
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString()) {
        this.updateWebview(document, webviewPanel.webview);
      }
    });

    // Notify webview when document is successfully saved to disk
    const saveDocumentSubscription = vscode.workspace.onDidSaveTextDocument(e => {
      if (e.uri.toString() === document.uri.toString()) {
        webviewPanel.webview.postMessage({ type: 'saved' });
      }
    });

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage(
      e => this.handleWebviewMessage(e, document, webviewPanel.webview),
      null,
      this.context.subscriptions
    );

    // Track active panel
    setActiveWebviewPanel(webviewPanel);

    // Send initial content to webview
    this.updateWebview(document, webviewPanel.webview);

    // Listen for configuration changes and update webview
    const configChangeSubscription = vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('markdownForHumans.imageResize.skipWarning') ||
        e.affectsConfiguration('markdownForHumans.imagePath') ||
        e.affectsConfiguration('markdownForHumans.mediaPathBase') ||
        e.affectsConfiguration('markdownForHumans.themeOverride') ||
        e.affectsConfiguration('markdownForHumans.developerMode')
      ) {
        const config = vscode.workspace.getConfiguration();
        const settings = this.getWebviewSettings(config);

        webviewPanel.webview.postMessage({
          type: 'settingsUpdate',
          ...settings,
        });
      }
    });

    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        setActiveWebviewPanel(webviewPanel);
      } else if (getActiveWebviewPanel() === webviewPanel) {
        setActiveWebviewPanel(undefined);
      }
    });

    // Cleanup
    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      saveDocumentSubscription.dispose();
      configChangeSubscription.dispose();
      // Clean up pending edits tracking for this document
      this.pendingEdits.delete(document.uri.toString());
      this.lastWebviewContent.delete(document.uri.toString());
      if (getActiveWebviewPanel() === webviewPanel) {
        setActiveWebviewPanel(undefined);
      }
    });
  }

  /**
   * Send document content to webview
   * Skips update if it's from a recent webview edit (avoid feedback loop)
   */
  private updateWebview(document: vscode.TextDocument, webview: vscode.Webview, force = false) {
    const docUri = document.uri.toString();
    const lastEditTime = this.pendingEdits.get(docUri);
    const currentContent = document.getText();

    // Skip update if content matches what we already sent from the webview
    const lastSentContent = this.lastWebviewContent.get(docUri);
    if (!force && lastSentContent !== undefined && lastSentContent === currentContent) {
      return;
    }

    // Skip update if this change came from webview within last 100ms
    // This prevents feedback loops while allowing external Git changes to sync
    if (!force && lastEditTime && Date.now() - lastEditTime < 100) {
      return;
    }

    // Transform content for webview (wrap frontmatter in code block)
    const transformedContent = this.wrapFrontmatterForWebview(currentContent);

    // Remember the ORIGINAL content (what we expect back from webview after unwrapping)
    // This prevents false dirty state when webview sends back unwrapped frontmatter
    this.lastWebviewContent.set(docUri, currentContent);

    // Get skip warning setting
    const config = vscode.workspace.getConfiguration();
    const settings = this.getWebviewSettings(config);

    webview.postMessage({
      type: 'update',
      content: transformedContent,
      ...settings,
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
      case 'updateThemeOverride': {
        const theme = message.theme as string;
        // Save to VS Code settings for persistence
        vscode.workspace
          .getConfiguration()
          .update('markdownForHumans.themeOverride', theme, vscode.ConfigurationTarget.Global);
        // Immediately apply to the webview so it takes effect right away
        webview.postMessage({
          type: 'settingsUpdate',
          themeOverride: theme,
        });
        break;
      }
      case 'edit':
        // Enqueue edit to ensure we don't apply overlapping edits which can confuse VS Code
        void this.enqueueEdit(document.uri.toString(), () =>
          this.applyEdit(message.content as string, document)
        );
        break;
      case 'saveAndEdit': {
        const contentStr = (message.content as string) || '';
        const requestId =
          typeof message.requestId === 'string' && message.requestId.trim().length > 0
            ? message.requestId
            : 'save-unknown';
        const docUri = document.uri.toString();
        console.log(
          `[MD4H][SAVE][${requestId}] Received saveAndEdit (content len: ${contentStr.length}, uri: ${docUri})`
        );
        void this.enqueueEdit(document.uri.toString(), async () => {
          try {
            const success = await this.applyEdit(contentStr, document);
            console.log(`[MD4H][SAVE][${requestId}] applyEdit result: ${success}`);

            const saved = await document.save();
            console.log(`[MD4H][SAVE][${requestId}] document.save() result: ${saved}`);

            // Send signal back. We send it for 'success' (content matches) OR 'saved' (disk write).
            // This ensures the toolbar can gray out if the document state is now congruent.
            webview.postMessage({ type: 'saved', requestId });

            // Proactive visible signal to user
            if (saved) {
              vscode.window.setStatusBarMessage('$(check) Markdown saved', 2000);
            } else {
              vscode.window.setStatusBarMessage('$(circle-slash) Markdown already saved', 2000);
            }
          } catch (err) {
            console.error(`[MD4H][SAVE][${requestId}] Critical error in saveAndEdit:`, err);
            vscode.window.showErrorMessage(
              `Save failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        });
        break;
      }
      case 'save':
        console.log('[MD4H] Received save message');
        void this.enqueueEdit(document.uri.toString(), async () => {
          try {
            const saved = await document.save();
            console.log(`[MD4H] document.save() result: ${saved}`);
            webview.postMessage({ type: 'saved' });

            if (saved) {
              vscode.window.setStatusBarMessage('$(check) Markdown saved', 2000);
            }
          } catch (err) {
            console.error('[MD4H] Critical error in save:', err);
          }
        });
        break;
      case 'ready': {
        // Webview is ready, send initial content and settings
        // Force resync to ensure editor is populated even if host thinks it's in sync
        this.updateWebview(document, webview, true);
        // Also send settings separately
        const config = vscode.workspace.getConfiguration();
        const settings = this.getWebviewSettings(config);

        webview.postMessage({
          type: 'settingsUpdate',
          ...settings,
        });
        break;
      }
      case 'outlineUpdated': {
        const outline = (message.outline || []) as any[];
        outlineViewProvider.setOutline(outline as any);
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
      case 'webviewLog': {
        const level = typeof message.level === 'string' ? message.level : 'info';
        const text = typeof message.message === 'string' ? message.message : 'Unknown webview log';
        const details = message.details;
        if (level === 'error') {
          console.error(`[MD4H][WEBVIEW] ${text}`, details);
        } else if (level === 'warn') {
          console.warn(`[MD4H][WEBVIEW] ${text}`, details);
        } else {
          console.log(`[MD4H][WEBVIEW] ${text}`, details);
        }
        break;
      }
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
      case 'openAttachmentsFolder':
        void this.handleOpenAttachmentsFolder(document);
        break;
      case 'browseLocalFile':
        void this.handleBrowseLocalFile(document, webview);
        break;
    }
  }

  /**
   * Handle opening the attachments folder from the toolbar
   */
  private async handleOpenAttachmentsFolder(document: vscode.TextDocument): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const mediaFolderName = config.get<string>('markdownForHumans.mediaPath', 'media');

    // Resolve absolute path using same logic as saving images
    const targetDir = this.resolveMediaTargetFolder(document, mediaFolderName);
    if (!targetDir) {
      vscode.window.showErrorMessage('Cannot determine attachments folder location.');
      return;
    }

    try {
      // Create folder if it doesn't exist yet
      const dirUri = vscode.Uri.file(targetDir);
      try {
        await vscode.workspace.fs.stat(dirUri);
      } catch {
        // Folder doesn't exist, create it so we can open it
        await vscode.workspace.fs.createDirectory(dirUri);
      }

      // Reveal in OS completely
      await vscode.commands.executeCommand('revealFileInOS', dirUri);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to open attachments folder: ${errorMessage}`);
    }
  }

  /**
   * Handle browsing for a local file to link
   */
  private async handleBrowseLocalFile(
    document: vscode.TextDocument,
    webview: vscode.Webview
  ): Promise<void> {
    const documentDir = vscode.Uri.joinPath(document.uri, '..');
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const workspacePath = workspaceFolder?.uri.fsPath;

    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Select File',
      defaultUri: documentDir,
    });

    if (uris && uris.length > 0) {
      const selectedUri = uris[0];
      const selectedPath = selectedUri.fsPath;
      const pathModule = await import('path');

      let finalUri = selectedUri;
      let isOutsideWorkspace = false;

      if (workspacePath) {
        // Check if selected file is inside the workspace
        isOutsideWorkspace =
          !selectedPath.startsWith(workspacePath + pathModule.sep) &&
          selectedPath !== workspacePath;
      } else {
        // No workspace open, consider it "outside" for the purpose of copying to a local folder
        isOutsideWorkspace = true;
      }

      if (isOutsideWorkspace) {
        // Copy file to workspace media folder
        const config = vscode.workspace.getConfiguration();
        const mediaFolderName = config.get<string>('markdownForHumans.mediaPath', 'media');
        const targetDir = this.resolveMediaTargetFolder(document, mediaFolderName);

        if (targetDir) {
          try {
            // Ensure target directory exists
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(targetDir));

            const fileName = pathModule.basename(selectedPath);
            const targetPath = pathModule.join(targetDir, fileName);
            const targetUri = vscode.Uri.file(targetPath);

            // Copy the file
            await vscode.workspace.fs.copy(selectedUri, targetUri, { overwrite: true });
            finalUri = targetUri;

            vscode.window.showInformationMessage(`Copied file to: ${mediaFolderName}/${fileName}`);
          } catch (error) {
            vscode.window.showErrorMessage(
              `Failed to copy file: ${error instanceof Error ? error.message : String(error)}`
            );
            // Continue with original path if copy fails
          }
        }
      }

      // Calculate relative path from document directory to final file
      const docDirPath = documentDir.fsPath;
      const finalFsPath = finalUri.fsPath;

      let relativePath = pathModule.relative(docDirPath, finalFsPath);
      // Ensure forward slashes
      relativePath = relativePath.replace(/\\/g, '/');

      webview.postMessage({
        type: 'localFileSelected',
        filename: pathModule.basename(finalFsPath),
        path: relativePath,
      });
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
    const mermaidImages = message.mermaidImages as any[];
    const title = message.title as string;

    // Import dynamically to avoid loading heavy dependencies on startup
    const { exportDocument } = await import('../features/documentExport');

    await exportDocument(format, html, mermaidImages, title, document);
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
   * Check if source is within workspace/document directory (cross-platform)
   */
  private isWithinWorkspace(sourcePath: string, basePath: string): boolean {
    const normalizedSource = path.normalize(sourcePath);
    const normalizedBase = path.normalize(basePath);

    // On Windows, ensure case-insensitive comparison
    // On Mac/Linux, case-sensitive comparison
    const sourceLower =
      process.platform === 'win32' ? normalizedSource.toLowerCase() : normalizedSource;
    const baseLower = process.platform === 'win32' ? normalizedBase.toLowerCase() : normalizedBase;

    return sourceLower.startsWith(baseLower + path.sep) || sourceLower === baseLower;
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

    console.log(`[MD4H] Handling workspace image: ${sourcePath}`);

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
      console.log(`[MD4H] Image is outside workspace or has invalid path, copying to workspace...`);

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
        const imageFolderName = config.get<string>('markdownForHumans.mediaPath', 'media');
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

        console.log(`[MD4H] Image copied to workspace. Path: ${copiedRelativePath}`);

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

    console.log(`[MD4H] Computed relative path: ${relativePath}`);

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

    // Resolve where to save new images (may be doc-relative, workspace-level, or sameNameFolder).
    const imagesDir = this.resolveMediaTargetFolder(document, imageFolderName);
    if (!imagesDir) {
      const errorMessage = 'Cannot save image: no base directory available';
      vscode.window.showErrorMessage(errorMessage);
      webview.postMessage({
        type: 'imageError',
        placeholderId,
        error: errorMessage,
      });
      return;
    }

    console.log(`[MD4H] Saving image "${name}" to folder: ${imagesDir}`);

    try {
      // Create folder if needed
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(imagesDir));

      // Save image (collision-safe: never overwrite silently)
      const parsedName = path.parse(name);
      const baseFilename = parsedName.name || 'image';
      const extension = parsedName.ext || '';

      let finalFilename = name;
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
      const docDir = this.getDocumentDirectory(document);
      const markdownDir =
        docDir ??
        (document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : os.homedir());
      let relativePath = path.relative(markdownDir, imagePath).replace(/\\/g, '/');

      if (!relativePath.startsWith('..') && !relativePath.startsWith('./')) {
        relativePath = './' + relativePath;
      }

      console.log(`[MD4H] Image saved successfully. Path: ${relativePath}`);

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

    console.log(`[MD4H] Renaming image: ${oldPath} to ${newName}`);

    try {
      // Resolve the old path
      const basePath = this.getImageBasePath(document);
      if (!basePath) {
        throw new Error('Cannot resolve image path: no base directory available');
      }

      const normalizedOldPath = normalizeImagePath(oldPath);
      const absoluteOldPath = path.resolve(basePath, normalizedOldPath);
      const oldUri = vscode.Uri.file(absoluteOldPath);

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
      console.log(`[MD4H] File renamed to: ${newFilename}`);

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
   * Handle file search request from webview
   */
  private async handleSearchFiles(
    message: { type: string; [key: string]: unknown },
    webview: vscode.Webview
  ): Promise<void> {
    try {
      const query = (message.query as string) || '';
      const requestId = (message.requestId as number) || 0;

      console.log('[MD4H] File search request:', { query, requestId });

      if (!query || query.trim().length < 1) {
        console.log('[MD4H] Empty query, returning empty results');
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
      console.log('[MD4H] Searching files with pattern:', excludePattern);

      // Increase max results to ensure we have enough files to search through
      const allFiles = await vscode.workspace.findFiles('**/*', excludePattern, 10000);
      console.log('[MD4H] Found', allFiles.length, 'files total');

      const filteredFiles = allFiles;

      const queryLower = query.toLowerCase().trim();
      const queryParts = queryLower.split(/\s+/).filter((p: string) => p.length > 0);

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
            (part: string) => filenameLower.includes(part) || pathLower.includes(part)
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

      console.log('[MD4H] Found', matchingFiles.length, 'matching files');

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

      console.log('[MD4H] Sending', results.length, 'results to webview');
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
      console.log('[MD4H] handleOpenExternalLink called with URL:', url);

      if (!url) {
        console.warn('[MD4H] No URL provided for external link');
        return;
      }

      // Validate URL format
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('mailto:')) {
        console.warn('[MD4H] Invalid external URL format:', url);
        return;
      }

      console.log('[MD4H] Opening external link:', url);
      await vscode.env.openExternal(vscode.Uri.parse(url));
      console.log('[MD4H] Successfully opened external link');
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

    console.log('[MD4H] handleOpenImage called with path:', imagePath);

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
    console.log('[MD4H] Trying document-relative path:', imageFullPath);

    // Check if file exists at document-relative path
    let fileExists = false;
    try {
      await vscode.workspace.fs.stat(imageUri);
      fileExists = true;
      console.log('[MD4H] Image found at document-relative path');
    } catch {
      console.log('[MD4H] Image not found at document-relative path, trying workspace root');

      // Fallback: try workspace root
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const workspacePath = workspaceFolder.uri.fsPath;
        imageFullPath = path.resolve(workspacePath, normalizedPath);
        imageUri = vscode.Uri.file(imageFullPath);
        console.log('[MD4H] Trying workspace-relative path:', imageFullPath);

        try {
          await vscode.workspace.fs.stat(imageUri);
          fileExists = true;
          console.log('[MD4H] Image found at workspace-relative path');
        } catch {
          console.log('[MD4H] Image not found at workspace-relative path either');
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
      console.log('[MD4H] Opening image:', imageUri.fsPath);
      await vscode.commands.executeCommand('vscode.open', imageUri);
      console.log('[MD4H] Successfully opened image');
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
      console.log('[MD4H] handleOpenFileLink called with path:', filePath);

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
      console.log('[MD4H] Resolved file URI (document-relative):', fileUri.fsPath);

      // Check if file exists
      let fileExists = false;
      try {
        await vscode.workspace.fs.stat(fileUri);
        fileExists = true;
        console.log('[MD4H] File exists (document-relative):', fileUri.fsPath);
      } catch {
        // File doesn't exist, try to find it in workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          // Try relative to workspace root
          const workspacePath = workspaceFolders[0].uri.fsPath;
          // Use normalized path (already normalized above)
          const workspaceFileUri = vscode.Uri.file(path.resolve(workspacePath, normalizedFilePath));
          console.log('[MD4H] Trying workspace-relative path:', workspaceFileUri.fsPath);
          try {
            await vscode.workspace.fs.stat(workspaceFileUri);
            fileUri = workspaceFileUri;
            fileExists = true;
            console.log('[MD4H] File exists (workspace-relative):', fileUri.fsPath);
          } catch {
            // Not found in workspace either
            console.log('[MD4H] File not found in workspace-relative path');
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
      console.log('[MD4H] File extension:', fileExtension, '| Is image:', isImage);

      if (isImage) {
        // For image files, use vscode.open command directly
        // This automatically opens images in VS Code's image preview
        console.log('[MD4H] Attempting to open image file with vscode.open command');
        try {
          await vscode.commands.executeCommand('vscode.open', fileUri);
          console.log('[MD4H] Successfully opened image file:', fileUri.fsPath);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error('[MD4H] Failed to open image file:', errorMessage, error);
          vscode.window.showErrorMessage(`Failed to open image file: ${errorMessage}`);
        }
      } else {
        // For text files, use openTextDocument
        console.log('[MD4H] Attempting to open text file with openTextDocument');
        try {
          const doc = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(doc);
          console.log('[MD4H] Successfully opened file link:', fileUri.fsPath);
        } catch (error) {
          // If it's not a text file, try vscode.open command as fallback
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.log('[MD4H] openTextDocument failed, error:', errorMessage);
          if (errorMessage.includes('Binary') || errorMessage.includes('binary')) {
            console.log('[MD4H] File is binary, trying vscode.open command as fallback');
            try {
              await vscode.commands.executeCommand('vscode.open', fileUri);
              console.log('[MD4H] Opened binary file using vscode.open command');
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

    console.log(`[MD4H] Copying local image to workspace: ${absolutePath}`);

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

      console.log(`[MD4H] Local image copied successfully. Path: ${relativePath}`);

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
      console.log(`[MD4H] Setting updated: ${key} = ${value}`);

      // Immediately notify webview of the setting change
      // This ensures the setting takes effect right away without waiting for next update
      const settings = this.getWebviewSettings(config);

      webview.postMessage({
        type: 'settingsUpdate',
        ...settings,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[MD4H] Failed to update setting: ${errorMessage}`);
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
  private async applyEdit(content: string, document: vscode.TextDocument): Promise<boolean> {
    const unwrappedContent = this.unwrapFrontmatterFromWebview(content);
    console.log(
      `[MD4H] applyEdit: rawLen=${content.length}, unwrappedLen=${unwrappedContent.length}`
    );

    // Normalize newlines of both strings before comparison to avoid phantom dirty states
    // caused by different line ending flavors (\r\n vs \n)
    const normalizedNew = unwrappedContent.replace(/\r\n/g, '\n');
    const normalizedOld = document.getText().replace(/\r\n/g, '\n');

    if (normalizedNew === normalizedOld) {
      console.log(`[MD4H] applyEdit: content already matches (length=${normalizedNew.length})`);
      return true;
    }

    console.log(
      `[MD4H] applyEdit: content mismatch. New=${normalizedNew.length} chars, Old=${normalizedOld.length} chars`
    );

    // Mark this edit to prevent feedback loop
    const docUri = document.uri.toString();
    this.pendingEdits.set(docUri, Date.now());
    this.lastWebviewContent.set(docUri, unwrappedContent);

    const edit = new vscode.WorkspaceEdit();

    // Use a robust full-document range to ensure everything is replaced
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );

    edit.replace(document.uri, fullRange, unwrappedContent);

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

    const pieces = ['```yaml', frontmatterBlock, '```'];
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
    // If it's a code block, unwrap it. Trim leading whitespace to be resilient to serializer quirks.
    const trimmed = content.trimStart();
    if (!trimmed.startsWith('```')) return content;

    const usesCrLf = content.includes('\r\n');
    const newline = usesCrLf ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);

    const firstLine = lines[0].trim().toLowerCase();
    if (firstLine !== '```yaml' && firstLine !== '```yml' && firstLine !== '```json') {
      return content;
    }

    const closingIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === '```');
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
   * Helper to enqueue an operation for a specific document URI.
   */
  private async enqueueEdit(docUri: string, editFn: () => Promise<any>): Promise<any> {
    const lastEdit = this.editQueue.get(docUri) || Promise.resolve();
    const nextEdit = lastEdit.then(async () => {
      try {
        await editFn();
      } catch (err) {
        console.error(`[MD4H] Error in enqueued edit:`, err);
      }
    });

    this.editQueue.set(docUri, nextEdit);
    return nextEdit;
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

    const lightStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'editor-light.css')
    );

    const darkStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'editor-dark.css')
    );

    // Read the current theme from config
    const config = vscode.workspace.getConfiguration();
    const themeOverride = config.get<string>('markdownForHumans.themeOverride', 'system');

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
                 connect-src ${webview.cspSource};
                       font-src ${webview.cspSource};
                       img-src ${webview.cspSource} https: data: blob:;">
        
        <link href="${styleUri}" rel="stylesheet">
        <link id="theme-style-link" href="" rel="stylesheet">
        
        <script nonce="${nonce}">
          window.md4hThemeLightUri = "${lightStyleUri}";
          window.md4hThemeDarkUri = "${darkStyleUri}";
          window.md4hLastResolvedTheme = 'dark';

          window.md4hResolveVsCodeTheme = function() {
            try {
              const htmlCls = document.documentElement.classList;
              const bodyCls = document.body ? document.body.classList : null;
              const hasClass = function(name) {
                return htmlCls.contains(name) || (bodyCls ? bodyCls.contains(name) : false);
              };

              if (hasClass('vscode-light') || hasClass('vscode-high-contrast-light')) {
                return 'light';
              }
              if (hasClass('vscode-dark') || hasClass('vscode-high-contrast')) {
                return 'dark';
              }
            } catch (err) {
              console.error('[MD4H][THEME] Failed to resolve VS Code theme classes:', err);
            }

            return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
              ? 'dark'
              : 'light';
          };

          window.md4hSetThemeStylesheet = function(mode) {
            const link = document.getElementById('theme-style-link');
            if (!link) return;

            if (mode === 'light') {
              link.disabled = false;
              link.href = window.md4hThemeLightUri;
              return;
            }

            if (mode === 'dark') {
              link.disabled = false;
              link.href = window.md4hThemeDarkUri;
              return;
            }

            // System mode: rely on VS Code-provided CSS variables from base stylesheet.
            link.disabled = true;
            link.removeAttribute('href');
          };
          
          window.md4hApplyTheme = function(theme) {
            try {
              const body = document.body || document.documentElement;
              const requested = theme === 'light' || theme === 'dark' || theme === 'system'
                ? theme
                : 'system';

              const resolvedTheme = requested === 'system'
                ? window.md4hResolveVsCodeTheme()
                : requested;

              if (requested === 'system') {
                body.removeAttribute('data-theme-override');
              } else {
                body.setAttribute('data-theme-override', requested);
              }

              window.md4hSetThemeStylesheet(requested);
              window.md4hLastResolvedTheme = resolvedTheme;
              console.warn('[MD4H][THEME] Applied', { requested, resolvedTheme });

              window.dispatchEvent(
                new CustomEvent('md4hThemeChanged', { detail: { theme: resolvedTheme } })
              );
            } catch (err) {
              console.error('[MD4H][THEME] Failed to apply theme:', err, { theme });
            }
          };

          // Initial apply only. Re-apply later only via explicit settingsUpdate messages.
          document.addEventListener('DOMContentLoaded', () => {
            window.md4hCurrentThemeOverride = '${themeOverride}';
            console.warn('[MD4H][THEME] Bootstrap ready', { override: window.md4hCurrentThemeOverride });
            window.md4hApplyTheme('${themeOverride}');
          });
        </script>
        
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

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
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
