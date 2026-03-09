import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';
import { getCachedImageMetadata } from '../features/imageMetadata';

type ImageReferenceMatch = { line: number; text: string };
type ImageReferencesPayload = {
  requestId: string;
  imagePath: string;
  currentFileCount: number;
  otherFiles: Array<{ fsPath: string; matches: ImageReferenceMatch[] }>;
  error?: string;
};

type ImageRenameCheckPayload = {
  requestId: string;
  exists: boolean;
  newFilename: string;
  newPath: string;
  error?: string;
};

export function createCustomImageMessagePlugin(editor: Editor) {
  const uriResolveCallbacks = new Map<string, (uri: string) => void>();
  const imageReferencesCallbacks = new Map<string, (payload: ImageReferencesPayload) => void>();
  const imageRenameCheckCallbacks = new Map<string, (payload: ImageRenameCheckPayload) => void>();

  return new Plugin({
    key: new PluginKey('customImageMessages'),
    view() {
      const vscode = (window as any).vscode;

      // Register window globals for backward compatibility with dialogs
      window.resolveImagePath = function (relativePath: string): Promise<string> {
        return new Promise(resolve => {
          const requestId = `resolve-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          uriResolveCallbacks.set(requestId, resolve);
          vscode.postMessage({ type: 'resolveImageUri', requestId, relativePath });
        });
      };

      window.getImageReferences = function (imagePath: string): Promise<unknown> {
        return new Promise(resolve => {
          const requestId = `refs-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          imageReferencesCallbacks.set(requestId, resolve as any);
          vscode.postMessage({ type: 'getImageReferences', requestId, imagePath });
        });
      };

      window.checkImageRename = function (oldPath: string, newName: string): Promise<unknown> {
        return new Promise(resolve => {
          const requestId = `renamecheck-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          imageRenameCheckCallbacks.set(requestId, resolve as any);
          vscode.postMessage({ type: 'checkImageRename', requestId, oldPath, newName });
        });
      };

      const handleMessage = (event: MessageEvent) => {
        const message = event.data;
        if (!message || !message.type) return;

        switch (message.type) {
          case 'imageWorkspaceCheck': {
            const requestId = message.requestId as string;
            const callbacks = (window as any)._workspaceCheckCallbacks;
            if (callbacks && callbacks.has(requestId)) {
              callbacks.get(requestId)({
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
              callback(message as ImageReferencesPayload);
              imageReferencesCallbacks.delete(requestId);
            }
            break;
          }
          case 'imageRenameCheck': {
            const requestId = message.requestId as string;
            const callback = imageRenameCheckCallbacks.get(requestId);
            if (callback) {
              callback(message as ImageRenameCheckPayload);
              imageRenameCheckCallbacks.delete(requestId);
            }
            break;
          }
          case 'imageMetadata': {
            const requestId = message.requestId as string;
            const metadata = message.metadata;
            const callbacks = (window as any)._metadataCallbacks;
            if (callbacks && callbacks.has(requestId)) {
              const callback = callbacks.get(requestId);
              const imagePath = metadata?.path;
              const cachedMetadata = imagePath ? getCachedImageMetadata(imagePath) : null;
              const preservedDimensions =
                cachedMetadata &&
                cachedMetadata.dimensions.width > 0 &&
                cachedMetadata.dimensions.height > 0
                  ? cachedMetadata.dimensions
                  : null;

              if (metadata && metadata.dimensions && metadata.dimensions.width === 0) {
                if (preservedDimensions) {
                  metadata.dimensions = preservedDimensions;
                } else {
                  const images = document.querySelectorAll('.markdown-image');
                  for (const img of images) {
                    const imgElement = img as HTMLImageElement;
                    const imgPath =
                      imgElement.getAttribute('data-markdown-src') ||
                      imgElement.getAttribute('src') ||
                      '';
                    if (
                      imgPath === imagePath ||
                      imgPath.endsWith(imagePath) ||
                      imagePath.endsWith(imgPath)
                    ) {
                      const width = imgElement.naturalWidth || imgElement.width || 0;
                      const height = imgElement.naturalHeight || imgElement.height || 0;
                      if (width > 0 && height > 0) metadata.dimensions = { width, height };
                      break;
                    }
                  }
                }
              } else if (preservedDimensions && metadata) {
                metadata.dimensions = preservedDimensions;
              }
              callback(metadata);
              callbacks.delete(requestId);
            }
            break;
          }
          case 'localImageCopied': {
            if (!editor) break;
            const relativePath = message.relativePath as string;
            const originalPath = message.originalPath as string;
            const images = document.querySelectorAll('.markdown-image');
            let imgElement: HTMLImageElement | null = null;
            for (const img of images) {
              const element = img as HTMLImageElement;
              const imgSrc =
                element.getAttribute('data-markdown-src') || element.getAttribute('src') || '';
              if (
                imgSrc === originalPath ||
                imgSrc.includes(originalPath) ||
                originalPath.includes(imgSrc)
              ) {
                imgElement = element;
                break;
              }
            }
            if (!imgElement) break;
            const pos = editor.view.posAtDOM(imgElement, 0);
            if (pos === undefined || pos === null) break;
            const node = editor.state.doc.nodeAt(pos);
            if (!node || node.type.name !== 'image') break;
            try {
              editor
                .chain()
                .setNodeSelection(pos)
                .updateAttributes('image', { src: relativePath, 'markdown-src': relativePath })
                .run();
              imgElement.setAttribute('data-markdown-src', relativePath);
              imgElement.setAttribute('src', relativePath);
              delete (imgElement as any)._pendingDownloadPlaceholderId;
            } catch (error) {
              console.error('[MD4H] Failed to update image node after copy:', error);
            }
            break;
          }
          case 'localImageCopyError': {
            const images = document.querySelectorAll('.markdown-image');
            for (const img of images) {
              const imgElement = img as HTMLImageElement;
              if ((imgElement as any)._pendingDownloadPlaceholderId === message.placeholderId) {
                delete (imgElement as any)._pendingDownloadPlaceholderId;
              }
            }
            break;
          }
          case 'imageUriResolved': {
            const callback = uriResolveCallbacks.get(message.requestId);
            if (callback) {
              callback(message.webviewUri);
              uriResolveCallbacks.delete(message.requestId);
            }
            break;
          }
        }
      };

      window.addEventListener('message', handleMessage);
      return {
        destroy() {
          window.removeEventListener('message', handleMessage);
        },
      };
    },
  });
}
