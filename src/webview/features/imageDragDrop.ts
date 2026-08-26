/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Image Drag & Drop / Paste Handler
 *
 * Enables intuitive image insertion:
 * - Drag & drop images directly (no shift key required!)
 * - Paste images from clipboard
 * - Auto-saves to configurable folder
 *
 * NO shift key required for drag-drop
 */

import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode, Schema as ProseMirrorSchema } from '@tiptap/pm/model';
import { Fragment, Slice } from '@tiptap/pm/model';
import { dropPoint } from '@tiptap/pm/transform';
import {
  confirmImageDrop,
  getRememberedFolder,
  setRememberedFolder,
  getDefaultImagePath,
} from './imageConfirmation';
import { showHugeImageDialog, isHugeImage } from './hugeImageDialog';
import {
  IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
  MAX_PENDING_IMAGE_SAVES,
} from '../../shared/pendingImageProtocol';
import {
  createPendingImageCompletionClient,
  type PendingImageCompletionClient,
} from './pendingImageCompletionClient';

/**
 * Track images currently being saved to prevent document sync race conditions
 */
const pendingImageSaves = new Set<string>();
let pendingImageCapacityWarningShown = false;

/** Reserve one bounded renderer slot before any image conversion begins. */
export function tryReservePendingImageSave(placeholderId: string): boolean {
  if (pendingImageSaves.has(placeholderId) || pendingImageSaves.size >= MAX_PENDING_IMAGE_SAVES) {
    return false;
  }
  pendingImageSaves.add(placeholderId);
  return true;
}

/** Release one renderer slot after completion or failed insertion. */
export function releasePendingImageSave(placeholderId: string): void {
  pendingImageSaves.delete(placeholderId);
  if (pendingImageSaves.size < MAX_PENDING_IMAGE_SAVES) {
    pendingImageCapacityWarningShown = false;
  }
}

function showPendingImageCapacityWarning(vscodeApi: VsCodeApi): void {
  if (pendingImageCapacityWarningShown) return;
  pendingImageCapacityWarningShown = true;
  try {
    vscodeApi.postMessage({
      type: 'showError',
      message: `Up to ${MAX_PENDING_IMAGE_SAVES} images can be saved at once. Wait for current image saves to finish, then try again.`,
    });
  } catch (error) {
    console.error('[MD4H] Failed to show pending image capacity warning:', error);
  }
}

/**
 * Check if any images are currently being saved
 */
export function hasPendingImageSaves(): boolean {
  return pendingImageSaves.size > 0;
}

type EditorForInsertPosition = {
  state: {
    doc: ProseMirrorNode;
    schema: ProseMirrorSchema;
    selection: { from: number };
  };
};

export function resolveImageInsertPosition(editor: EditorForInsertPosition, pos?: number): number {
  const fallback = editor.state.selection.from;
  const requestedPos = pos ?? fallback;

  const maxPos = editor.state.doc.content.size;
  if (pos !== undefined && (requestedPos < 0 || requestedPos > maxPos)) {
    return fallback;
  }

  const boundedPos = Math.max(0, Math.min(requestedPos, maxPos));

  const imageType = editor.state.schema.nodes.image;
  if (!imageType) {
    return boundedPos;
  }

  const node = imageType.create({ src: 'x', alt: null });
  const slice = new Slice(Fragment.from(node), 0, 0);

  try {
    const safePos = dropPoint(editor.state.doc, boundedPos, slice);
    return safePos ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Get count of pending image saves (for debugging)
 */
export function getPendingImageCount(): number {
  return pendingImageSaves.size;
}

/**
 * VS Code API type
 */
interface VsCodeApi {
  readonly viewGeneration?: string;
  postMessage: (message: unknown) => void;
}

/**
 * Supported image MIME types
 */
const SUPPORTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
];

const IMAGE_PATH_REGEX = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

/**
 * Setup image drag & drop and paste handling for the editor
 */
export function setupImageDragDrop(
  editor: Editor,
  vscodeApi: VsCodeApi,
  viewGeneration: string
): void {
  const editorElement = document.querySelector('.ProseMirror');
  if (!editorElement) {
    console.warn('[MD4H] Editor element not found for image drag-drop setup');
    return;
  }

  const generationBoundApi: VsCodeApi = {
    viewGeneration,
    postMessage: message => vscodeApi.postMessage(message),
  };

  // Drag over styling
  editorElement.addEventListener('dragover', handleDragOver);
  editorElement.addEventListener('dragleave', handleDragLeave);
  editorElement.addEventListener('drop', e =>
    handleDrop(e as DragEvent, editor, generationBoundApi)
  );

  // Paste handling
  editorElement.addEventListener('paste', e =>
    handlePaste(e as ClipboardEvent, editor, generationBoundApi)
  );

  const completionClient = createPendingImageCompletionClient({
    viewGeneration,
    isPending: placeholderId => pendingImageSaves.has(placeholderId),
    applySaved: (placeholderId, newSrc) => {
      if (!applySavedImageCompletion(editor, placeholderId, newSrc)) return false;
      releasePendingImageSave(placeholderId);
      return true;
    },
    applyError: (placeholderId, error) => {
      console.error('[MD4H] Image save failed:', error);
      if (!applyFailedImageCompletion(editor, placeholderId)) return false;
      releasePendingImageSave(placeholderId);
      return true;
    },
    postAcknowledgement: acknowledgement => vscodeApi.postMessage(acknowledgement),
    maxRetainedCompletions: 128,
  });
  const handleWindowMessage = (event: MessageEvent): void =>
    handleImageMessage(event, editor, completionClient);

  // Listen for image save confirmations from extension.
  window.addEventListener('message', handleWindowMessage);

  // Guard against VS Code opening a new window when dropping images outside the editor
  const blockWindowDrop = (e: DragEvent) => {
    if (hasImageFiles(e.dataTransfer) || extractImagePathFromDataTransfer(e.dataTransfer)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none';
      }
    }
  };

  // Clear drag-over styling when leaving the window entirely
  const handleWindowDragLeave = (e: DragEvent) => {
    if (e.relatedTarget === null) {
      editorElement.classList.remove('drag-over');
    }
  };

  window.addEventListener('dragover', blockWindowDrop);
  window.addEventListener('drop', blockWindowDrop);
  window.addEventListener('dragleave', handleWindowDragLeave as EventListener);

  // Clean up window listeners when editor is destroyed to prevent memory leaks
  editor.on('destroy', () => {
    window.removeEventListener('dragover', blockWindowDrop);
    window.removeEventListener('drop', blockWindowDrop);
    window.removeEventListener('dragleave', handleWindowDragLeave as EventListener);
    window.removeEventListener('message', handleWindowMessage);
    completionClient.dispose();
  });
}

/**
 * Extract an image path (text/uri-list or text/plain) from a DataTransfer
 */
export function extractImagePathFromDataTransfer(dt: DataTransfer | null): string | null {
  if (!dt) return null;

  const uriList = dt.getData('text/uri-list') || '';
  const textPlain = dt.getData('text/plain') || '';

  const candidate = (uriList || textPlain).trim();
  if (!candidate) return null;

  const firstLine = candidate.split(/\r?\n/).find(Boolean) || '';
  return IMAGE_PATH_REGEX.test(firstLine) ? firstLine : null;
}

/**
 * Handle dragover event - show drop zone styling
 */
function handleDragOver(e: Event): void {
  const dragEvent = e as DragEvent;
  dragEvent.preventDefault();

  const hasFiles = hasImageFiles(dragEvent.dataTransfer);
  const hasImagePath = extractImagePathFromDataTransfer(dragEvent.dataTransfer);

  if (hasFiles || hasImagePath) {
    dragEvent.dataTransfer!.dropEffect = 'copy';
    (e.currentTarget as Element).classList.add('drag-over');
  }
}

/**
 * Handle dragleave event - remove drop zone styling
 */
function handleDragLeave(e: Event): void {
  const dragEvent = e as DragEvent;
  const target = e.currentTarget as Element;

  // Only remove if leaving the editor entirely
  if (!target.contains(dragEvent.relatedTarget as Node)) {
    target.classList.remove('drag-over');
  }
}

/**
 * Handle workspace image drop (from VS Code file explorer)
 * These come as file:// URIs or absolute paths, not File objects
 */
async function handleWorkspaceImageDrop(
  uriOrPath: string,
  editor: Editor,
  vscodeApi: VsCodeApi,
  e?: DragEvent,
  insertPosOverride?: number
): Promise<void> {
  console.log('[MD4H] Handling workspace image drop:', uriOrPath);

  // Clean up the path - could be file:// URI or absolute path
  let filePath = uriOrPath.trim();

  // Handle file:// URI
  if (filePath.startsWith('file://')) {
    filePath = decodeURIComponent(filePath.replace('file://', ''));
  }

  // Extract filename from path
  const fileName = filePath.split('/').pop() || 'image.png';

  // Get drop position in editor
  const pos =
    insertPosOverride ??
    (e
      ? editor.view.posAtCoords({
          left: e.clientX,
          top: e.clientY,
        })?.pos
      : editor.state.selection.from);

  // For workspace images, we ask the extension to handle the copy/link
  // Send message to extension with the source path
  vscodeApi.postMessage({
    type: 'handleWorkspaceImage',
    sourcePath: filePath,
    fileName: fileName,
    insertPosition: pos,
  });
}

/**
 * Handle drop event - insert dropped images
 * NO SHIFT KEY REQUIRED for better user experience
 */
async function handleDrop(e: DragEvent, editor: Editor, vscodeApi: VsCodeApi): Promise<void> {
  e.preventDefault();
  (e.currentTarget as Element).classList.remove('drag-over');

  const dt = e.dataTransfer;
  if (!dt) return;

  // Case 1: Check for actual File objects (from desktop/finder)
  const files = getImageFiles(dt);
  console.log('[MD4H] Drop payload types:', {
    types: Array.from(dt.types || []),
    fileCount: dt.files?.length || 0,
    hasImageFiles: files.length > 0,
  });

  // Case 2: Check for VS Code file explorer drops (URI as text)
  if (files.length === 0) {
    const imagePath = extractImagePathFromDataTransfer(dt);
    if (imagePath) {
      // This is a workspace file path - handle it specially
      await handleWorkspaceImageDrop(imagePath, editor, vscodeApi, e);
      return;
    }
    console.log('[MD4H] Drop ignored: no image files or image paths detected');
    return; // No images to process
  }

  // Check if we have a remembered folder preference
  let targetFolder = getRememberedFolder();

  // If no remembered preference, show confirmation dialog
  if (!targetFolder) {
    const options = await confirmImageDrop(files.length, getDefaultImagePath());
    if (!options) {
      // User cancelled
      return;
    }

    targetFolder = options.targetFolder;

    // Remember choice if requested
    if (options.rememberChoice) {
      setRememberedFolder(targetFolder);
    }
  }

  // Get drop position in editor
  const pos = editor.view.posAtCoords({
    left: e.clientX,
    top: e.clientY,
  });

  // Insert all dropped images
  for (const file of files) {
    // Check if image is huge and show dialog
    let resizeOptions: { width: number; height: number } | undefined;
    if (isHugeImage(file)) {
      const hugeImageOptions = await showHugeImageDialog(file, {
        x: e.clientX,
        y: e.clientY,
      });

      if (!hugeImageOptions) {
        // User cancelled
        continue;
      }

      if (
        hugeImageOptions.action === 'resize-suggested' &&
        hugeImageOptions.customWidth &&
        hugeImageOptions.customHeight
      ) {
        resizeOptions = {
          width: hugeImageOptions.customWidth,
          height: hugeImageOptions.customHeight,
        };
      } else if (hugeImageOptions.action === 'use-original') {
        // Use original, no resize
        resizeOptions = undefined;
      }
    }

    await insertImage(editor, file, vscodeApi, targetFolder, 'dropped', pos?.pos, resizeOptions);
  }
}

/**
 * Handle paste event - insert pasted images from clipboard
 */
async function handlePaste(e: ClipboardEvent, editor: Editor, vscodeApi: VsCodeApi): Promise<void> {
  const clipboardData = e.clipboardData as DataTransfer | null;
  const imagePath = extractImagePathFromDataTransfer(clipboardData);
  const files = getImageFiles(clipboardData);
  const items = Array.from(clipboardData?.items || []);
  const imageItem = items.find(item => item.type.startsWith('image/'));

  // Priority order for paste handling:
  // 1. Image path (workspace files) - highest priority
  // 2. File objects (screenshots, copied files) - high priority
  // 3. Binary clipboard image (data URL) - lowest priority

  // Workspace-aware paste: if text payload contains an image path, insert via relative path
  if (imagePath) {
    e.preventDefault();
    await handleWorkspaceImageDrop(
      imagePath,
      editor,
      vscodeApi,
      undefined,
      editor.state.selection.from
    );
    return;
  }

  // Pasted files (e.g., screenshots provided as File)
  // IMPORTANT: Check this BEFORE imageItem to prevent double insertion
  // When copying images from browser, clipboard has BOTH File and data URL
  if (files.length > 0) {
    e.preventDefault();

    let targetFolder = getRememberedFolder();
    if (!targetFolder) {
      const options = await confirmImageDrop(files.length, getDefaultImagePath());
      if (!options) {
        return;
      }
      targetFolder = options.targetFolder;
      if (options.rememberChoice) {
        setRememberedFolder(targetFolder);
      }
    }

    const pos = editor.state.selection.from;
    for (const file of files) {
      // Check if image is huge and show dialog
      let resizeOptions: { width: number; height: number } | undefined;
      if (isHugeImage(file)) {
        const hugeImageOptions = await showHugeImageDialog(file);

        if (!hugeImageOptions) {
          // User cancelled
          continue;
        }

        if (
          hugeImageOptions.action === 'resize-suggested' &&
          hugeImageOptions.customWidth &&
          hugeImageOptions.customHeight
        ) {
          resizeOptions = {
            width: hugeImageOptions.customWidth,
            height: hugeImageOptions.customHeight,
          };
        } else if (hugeImageOptions.action === 'use-original') {
          // Use original, no resize
          resizeOptions = undefined;
        }
      }

      await insertImage(editor, file, vscodeApi, targetFolder, 'pasted', pos, resizeOptions);
    }
    return;
  }

  // Binary clipboard image (no file path)
  if (imageItem) {
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (file) {
      let targetFolder = getRememberedFolder();

      if (!targetFolder) {
        const options = await confirmImageDrop(1, getDefaultImagePath());
        if (!options) {
          return;
        }

        targetFolder = options.targetFolder;

        if (options.rememberChoice) {
          setRememberedFolder(targetFolder);
        }
      }

      // Check if image is huge and show dialog
      let resizeOptions: { width: number; height: number } | undefined;
      if (isHugeImage(file)) {
        const hugeImageOptions = await showHugeImageDialog(file);

        if (!hugeImageOptions) {
          // User cancelled
          return;
        }

        if (
          hugeImageOptions.action === 'resize-suggested' &&
          hugeImageOptions.customWidth &&
          hugeImageOptions.customHeight
        ) {
          resizeOptions = {
            width: hugeImageOptions.customWidth,
            height: hugeImageOptions.customHeight,
          };
        } else if (hugeImageOptions.action === 'use-original') {
          // Use original, no resize
          resizeOptions = undefined;
        }
      }

      await insertImage(editor, file, vscodeApi, targetFolder, 'pasted', undefined, resizeOptions);
    }
  }
}

/**
 * Handle messages from extension (image save confirmations)
 */
function handleImageMessage(
  event: MessageEvent,
  editor: Editor,
  completionClient: PendingImageCompletionClient
): void {
  const message = event.data;

  const completionDisposition = completionClient.handle(message);
  if (
    completionDisposition !== 'ignored' ||
    (typeof message === 'object' &&
      message !== null &&
      ('completionId' in message || 'protocolVersion' in message))
  ) {
    return;
  }

  // Only log our messages
  if (
    message.type === 'imageSaved' ||
    message.type === 'imageError' ||
    message.type === 'insertWorkspaceImage'
  ) {
    console.log('[MD4H] Received message from extension:', message.type, message);
  }

  switch (message.type) {
    case 'imageSaved': {
      // Update placeholder with final path
      console.log(
        `[MD4H] Processing imageSaved: placeholderId=${message.placeholderId}, newSrc=${message.newSrc}`
      );
      applySavedImageCompletion(editor, message.placeholderId, message.newSrc);
      // Remove from pending saves
      releasePendingImageSave(message.placeholderId);
      console.log(`[MD4H] Removed from pending saves. Remaining: ${pendingImageSaves.size}`);
      break;
    }
    case 'imageError': {
      // Remove placeholder on error
      console.error('[MD4H] Image save failed:', message.error);
      applyFailedImageCompletion(editor, message.placeholderId);
      // Remove from pending saves
      releasePendingImageSave(message.placeholderId);
      console.log(
        `[MD4H] Removed from pending saves (error). Remaining: ${pendingImageSaves.size}`
      );
      break;
    }
    case 'insertWorkspaceImage': {
      // Insert image from workspace with relative path
      console.log(
        `[MD4H] Inserting workspace image: ${message.relativePath}, alt: ${message.altText}`
      );
      insertWorkspaceImage(editor, message.relativePath, message.altText, message.insertPosition);
      break;
    }
  }
}

/**
 * Insert a workspace image with relative path (no copying needed)
 */
function insertWorkspaceImage(
  editor: Editor,
  relativePath: string,
  altText: string,
  pos?: number
): void {
  console.log(`[MD4H] insertWorkspaceImage called with:`, {
    relativePath,
    altText,
    pos,
    currentSelection: editor.state.selection.from,
  });

  try {
    const safePos = resolveImageInsertPosition(editor, pos);
    const result = editor
      .chain()
      .focus()
      .insertContentAt(safePos, {
        type: 'image',
        attrs: {
          src: relativePath,
          alt: altText,
        },
      })
      .run();

    console.log(`[MD4H] Inserted workspace image: ${relativePath}, success: ${result}`);

    // Verify the image was actually inserted
    setTimeout(() => {
      const images = document.querySelectorAll(`img[src="${relativePath}"]`);
      console.log(`[MD4H] Verification: Found ${images.length} images with src="${relativePath}"`);
    }, 100);
  } catch (error) {
    console.error(`[MD4H] Failed to insert workspace image:`, error);
  }
}

/**
 * Check if DataTransfer contains image files
 */
export function hasImageFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types).includes('Files') && Array.from(dt.files).some(f => isImageFile(f));
}

/**
 * Get image files from DataTransfer
 */
export function getImageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.files).filter(f => isImageFile(f));
}

/**
 * Check if a file is a supported image type
 */
export function isImageFile(file: File): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(file.type);
}

/**
 * Resize image using canvas API
 */
async function resizeImage(file: File, targetWidth: number, targetHeight: number): Promise<File> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      // Create canvas
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      // Draw resized image
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

      // Convert to blob
      canvas.toBlob(
        blob => {
          if (!blob) {
            reject(new Error('Failed to create blob from canvas'));
            return;
          }

          // Create new File with same name and type
          const resizedFile = new File([blob], file.name, { type: file.type });
          resolve(resizedFile);
        },
        file.type || 'image/png',
        0.92 // Quality for JPEG (ignored for PNG)
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image for resizing'));
    };

    img.src = url;
  });
}

/**
 * Insert an image into the editor
 *
 * @param editor - TipTap editor instance
 * @param file - Image file to insert
 * @param vscodeApi - VS Code API for messaging
 * @param targetFolder - Target folder for saving
 * @param source - How the image was added ('dropped' or 'pasted')
 * @param pos - Optional insertion position
 * @param resizeOptions - Optional resize dimensions (from huge image dialog)
 */
export async function insertImage(
  editor: Editor,
  file: File,
  vscodeApi: VsCodeApi,
  targetFolder: string,
  source: ImageSourceType,
  pos?: number,
  resizeOptions?: { width: number; height: number }
): Promise<void> {
  // Generate unique placeholder ID
  const placeholderId = `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  if (!tryReservePendingImageSave(placeholderId)) {
    showPendingImageCapacityWarning(vscodeApi);
    return;
  }
  let placeholderInserted = false;

  try {
    // Resize image if requested (from huge image dialog)
    let imageFile = file;
    if (resizeOptions) {
      imageFile = await resizeImage(file, resizeOptions.width, resizeOptions.height);
    }

    // Extract dimensions from the FINAL image (after resize if applicable)
    // This ensures the filename reflects the actual saved dimensions
    const dimensions = await getImageDimensions(imageFile);
    const finalDimensions: ImageDimensions = dimensions || { width: 0, height: 0 };

    // Convert to base64 for immediate preview
    const base64 = await fileToBase64(imageFile);
    // Read the host payload before mutating TipTap. Once the placeholder is in
    // the document there must be no async gap before saveImage is posted,
    // otherwise a hidden non-retained webview can disappear with no host copy.
    const buffer = await imageFile.arrayBuffer();

    const safePos = resolveImageInsertPosition(editor, pos);

    // Insert image with base64 preview
    const inserted = editor
      .chain()
      .focus()
      .insertContentAt(safePos, {
        type: 'image',
        attrs: {
          src: base64,
          alt: file.name.replace(/\.[^.]+$/, ''),
          'data-placeholder-id': placeholderId,
        },
      })
      .run();
    if (!inserted) throw new Error('TipTap rejected the pending image placeholder.');
    placeholderInserted = true;

    // The slot was reserved before conversion so concurrent multi-file loops
    // cannot create more placeholders than the host can own.
    console.log(`[MD4H] Added to pending saves. Total pending: ${pendingImageSaves.size}`);

    // Generate filename with source type and dimensions
    const imageName = generateImageName(file.name, source, finalDimensions);

    // Send to extension to save to workspace
    console.log(
      `[MD4H] Sending saveImage message: placeholderId=${placeholderId}, name=${imageName}, targetFolder=${targetFolder}`
    );

    vscodeApi.postMessage({
      type: 'saveImage',
      protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION,
      viewGeneration: vscodeApi.viewGeneration,
      placeholderId,
      name: imageName,
      data: new Uint8Array(buffer),
      mimeType: file.type,
      targetFolder, // User-selected folder
    });
  } catch (error) {
    if (placeholderInserted) {
      applyFailedImageCompletion(editor, placeholderId);
    }
    releasePendingImageSave(placeholderId);
    console.error('[MD4H] Failed to insert image:', error);
  }
}

interface PendingImageNodeMatch {
  readonly pos: number;
  readonly node: ProseMirrorNode;
}

function findPendingImageNodes(editor: Editor, placeholderId: string): PendingImageNodeMatch[] {
  const matches: PendingImageNodeMatch[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && node.attrs['data-placeholder-id'] === placeholderId) {
      matches.push({ pos, node });
    }
  });
  return matches;
}

/** Atomically replace every matching preview and verify no placeholder remains. */
export function applySavedImageCompletion(
  editor: Editor,
  placeholderId: string,
  newSrc: string
): boolean {
  const matches = findPendingImageNodes(editor, placeholderId);
  if (matches.length === 0) return true;

  try {
    let transaction = editor.state.tr;
    for (const { pos, node } of matches) {
      transaction = transaction.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        src: newSrc,
        'data-placeholder-id': null,
      });
    }
    editor.view.dispatch(transaction);
    return findPendingImageNodes(editor, placeholderId).length === 0;
  } catch (error) {
    console.error('[MD4H] Failed applying saved image completion:', error);
    return false;
  }
}

/** Atomically delete every failed preview and verify no placeholder remains. */
export function applyFailedImageCompletion(editor: Editor, placeholderId: string): boolean {
  const matches = findPendingImageNodes(editor, placeholderId);
  if (matches.length === 0) return true;

  try {
    let transaction = editor.state.tr;
    for (const { pos, node } of [...matches].sort((left, right) => right.pos - left.pos)) {
      transaction = transaction.delete(pos, pos + node.nodeSize);
    }
    editor.view.dispatch(transaction);
    return findPendingImageNodes(editor, placeholderId).length === 0;
  } catch (error) {
    console.error('[MD4H] Failed applying image error completion:', error);
    return false;
  }
}

/**
 * Convert file to base64 data URL for preview
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Image source type for naming context
 */
export type ImageSourceType = 'dropped' | 'pasted';

/**
 * Image dimensions
 */
export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Parsed image filename components
 */
export interface ParsedImageFilename {
  source: ImageSourceType | null;
  name: string;
  dimensions: ImageDimensions | null;
  extension: string;
}

/**
 * Get image dimensions from a File object
 * Returns dimensions or null if they can't be determined
 */
export function getImageDimensions(file: File): Promise<ImageDimensions | null> {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.width, height: img.height });
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };

    img.src = url;
  });
}

/**
 * Parse an image filename to extract components
 * Pattern: {source}_{name}_{width}x{height}px.{ext}
 * Also handles old format with timestamps for backward compatibility
 */
export function parseImageFilename(filename: string): ParsedImageFilename {
  // Check old pattern WITH timestamp FIRST (more specific)
  // Pattern: (dropped_|pasted_)?(.+?)_(\d{13})_(\d+)x(\d+)px\.(\w+)$
  const oldTimestampPattern = /^(dropped_|pasted_)?(.+?)_\d{13}_(\d+)x(\d+)px\.(\w+)$/;
  const oldTimestampMatch = filename.match(oldTimestampPattern);

  if (oldTimestampMatch) {
    const [, sourcePrefix, name, width, height, extension] = oldTimestampMatch;
    return {
      source: sourcePrefix ? (sourcePrefix.replace('_', '') as ImageSourceType) : null,
      name,
      dimensions: { width: parseInt(width, 10), height: parseInt(height, 10) },
      extension,
    };
  }

  // New pattern (no timestamp): (dropped_|pasted_)?(.+?)_(\d+)x(\d+)px\.(\w+)$
  const newPattern = /^(dropped_|pasted_)?(.+?)_(\d+)x(\d+)px\.(\w+)$/;
  const newMatch = filename.match(newPattern);

  if (newMatch) {
    const [, sourcePrefix, name, width, height, extension] = newMatch;
    return {
      source: sourcePrefix ? (sourcePrefix.replace('_', '') as ImageSourceType) : null,
      name,
      dimensions: { width: parseInt(width, 10), height: parseInt(height, 10) },
      extension,
    };
  }

  // Legacy format: {name}-{timestamp}.{ext}
  const legacyPattern = /^(.+?)-\d{13}\.(\w+)$/;
  const legacyMatch = filename.match(legacyPattern);

  if (legacyMatch) {
    const [, name, extension] = legacyMatch;
    return {
      source: null,
      name,
      dimensions: null,
      extension,
    };
  }

  // Can't parse - return basic info
  const ext = filename.split('.').pop()?.toLowerCase() || 'png';
  const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
  return {
    source: null,
    name: nameWithoutExt,
    dimensions: null,
    extension: ext,
  };
}

/**
 * Generate a safe image filename for saving into the workspace.
 *
 * Rules:
 * - Keep primary filenames clean (no dimensions).
 * - Only add `dropped_` / `pasted_` when the original name is missing or generic.
 * - Generic names use a timestamp (UTC, up to seconds) to reduce collisions.
 *
 * @param originalName - Original filename
 * @param source - How the image was added ('dropped' or 'pasted')
 * @param dimensions - Image dimensions (width x height)
 */
export function generateImageName(
  originalName: string,
  source: ImageSourceType,
  _dimensions: ImageDimensions
): string {
  const trimmedName = (originalName || '').trim();
  const dotIndex = trimmedName.lastIndexOf('.');
  const hasExtension = dotIndex > 0 && dotIndex < trimmedName.length - 1;

  const isExtensionOnly =
    dotIndex === 0 && trimmedName.length > 1 && /^[.][a-zA-Z0-9]+$/.test(trimmedName);

  const rawStem = isExtensionOnly
    ? ''
    : hasExtension
      ? trimmedName.slice(0, dotIndex)
      : trimmedName;
  const rawExt = isExtensionOnly
    ? trimmedName.slice(1)
    : hasExtension
      ? trimmedName.slice(dotIndex + 1)
      : '';
  const extension = rawExt ? rawExt.toLowerCase() : 'png';

  const stem = rawStem
    .replace(/[^a-zA-Z0-9-_]/g, '-') // Replace unsafe chars with hyphen
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, '') // Trim leading/trailing hyphens
    .slice(0, 50); // Limit length

  const safeStem = stem || 'image';

  const genericImageStems = new Set(['image', 'screenshot', 'clipboard-image', 'clipboard_image']);
  const isGeneric = genericImageStems.has(safeStem.toLowerCase());

  const timestamp = (() => {
    const iso = new Date().toISOString(); // e.g. 2025-12-15T12:34:56.000Z
    const yyyymmdd = iso.slice(0, 10).replace(/-/g, '');
    const hhmmss = iso.slice(11, 19).replace(/:/g, '');
    return `${yyyymmdd}-${hhmmss}`;
  })();

  if (isGeneric) {
    return `${source}_${timestamp}.${extension}`;
  }

  return `${safeStem}.${extension}`;
}
