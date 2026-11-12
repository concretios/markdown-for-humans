/** @jest-environment jsdom */

/**
 * Resize keeps the picture's proportions
 *
 * The editor column clamps an image's width (`max-width: 100%`) but never its
 * height. The Resize modal's live preview wrote both as px, and the resize
 * handler left them on the image, so a wide picture resized past the column
 * width kept its px height and showed stretched. jsdom has no layout, so these
 * tests pin the contract that prevents it: no definite px height is ever left
 * on the image, the aspect ratio does the work, and the saved Markdown (which
 * never carries these styles) is untouched.
 */

import {
  handleImageResized,
  hideImageResizeModal,
  redoImageResize,
  showResizeModalAfterDownload,
  undoImageResize,
} from '../../webview/features/imageResizeModal';
import { Editor } from '@tiptap/core';

const NATURAL_WIDTH = 3000;
const NATURAL_HEIGHT = 600;

function createWideImage(): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'markdown-image';
  img.setAttribute('data-markdown-src', './images/wide.png');
  Object.defineProperty(img, 'naturalWidth', { value: NATURAL_WIDTH });
  Object.defineProperty(img, 'naturalHeight', { value: NATURAL_HEIGHT });
  document.body.appendChild(img);
  return img;
}

function typeWidth(value: string): void {
  const widthInput = document.querySelector('#resize-width-input') as HTMLInputElement;
  widthInput.value = value;
  widthInput.dispatchEvent(new Event('input'));
}

function typeHeight(value: string): void {
  // The aspect ratio is always locked, so the width field follows.
  const heightInput = document.querySelector('#resize-height-input') as HTMLInputElement;
  heightInput.value = value;
  heightInput.dispatchEvent(new Event('input'));
}

describe('resize keeps the aspect ratio under the column clamp', () => {
  afterEach(() => {
    hideImageResizeModal();
    document.body.innerHTML = '';
  });

  describe('live preview in the modal', () => {
    it('sizes the preview by width and aspect ratio, never by a px height', () => {
      const img = createWideImage();
      showResizeModalAfterDownload(img, {} as Editor, { postMessage: jest.fn() });

      typeWidth('1000');

      expect(img.style.width).toBe('1000px');
      // A px height would survive the column clamp and distort the picture.
      expect(img.style.height).toBe('');
      expect(img.style.aspectRatio.replace(/\s/g, '')).toBe('1000/200');
    });

    it('sizes the preview the same way when the height field is edited', () => {
      const img = createWideImage();
      showResizeModalAfterDownload(img, {} as Editor, { postMessage: jest.fn() });

      typeHeight('300');

      expect(img.style.width).toBe('1500px');
      expect(img.style.height).toBe('');
      expect(img.style.aspectRatio.replace(/\s/g, '')).toBe('1500/300');
    });

    it('leaves no inline size behind when the modal is cancelled', () => {
      const img = createWideImage();
      showResizeModalAfterDownload(img, {} as Editor, { postMessage: jest.fn() });
      typeWidth('1000');

      (document.querySelector('#cancel-resize') as HTMLElement).click();

      expect(img.style.width).toBe('');
      expect(img.style.height).toBe('');
      expect(img.style.aspectRatio).toBe('');
    });
  });

  describe('after the resized file lands', () => {
    it('clears every inline size so the new file lays out at its own proportions', () => {
      const img = createWideImage();
      showResizeModalAfterDownload(img, {} as Editor, { postMessage: jest.fn() });
      typeWidth('1000');

      handleImageResized('backup-1.png', img);

      expect(img.style.width).toBe('');
      expect(img.style.height).toBe('');
      expect(img.style.aspectRatio).toBe('');
    });

    it('clears px sizes written by older code paths too', () => {
      const img = createWideImage();
      img.style.width = '1000px';
      img.style.height = '200px';

      handleImageResized('backup-1.png', img);

      expect(img.style.width).toBe('');
      expect(img.style.height).toBe('');
    });

    it('still records the resized dimensions for redo', () => {
      const img = createWideImage();
      img.setAttribute('src', './images/wide.png');
      showResizeModalAfterDownload(img, {} as Editor, { postMessage: jest.fn() });
      typeWidth('1000');
      (img as unknown as { _pendingResizeDataUrl?: string })._pendingResizeDataUrl =
        'data:image/png;base64,AAA=';

      handleImageResized('backup-1.png', img);

      const postMessage = jest.fn();
      undoImageResize(img, { postMessage });
      postMessage.mockClear();
      redoImageResize(img, { postMessage });

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'redoResize', newWidth: 1000, newHeight: 200 })
      );
    });
  });
});
