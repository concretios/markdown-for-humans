/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Editor } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import StarterKit from '@tiptap/starter-kit';
import { MAX_PENDING_IMAGE_SAVES } from '../../shared/pendingImageProtocol';
import {
  getPendingImageCount,
  insertImage,
  releasePendingImageSave,
  tryReservePendingImageSave,
  waitForPendingImageSaves,
} from '../../webview/features/imageDragDrop';

const PendingImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      'data-placeholder-id': {
        default: null,
        parseHTML: element => element.getAttribute('data-placeholder-id'),
      },
    };
  },
});

function createEditor(): Editor {
  return new Editor({
    extensions: [StarterKit, PendingImage.configure({ allowBase64: true })],
    content: '<p>before</p>',
  });
}

function createImageFile(arrayBuffer: () => Promise<ArrayBuffer>): File {
  const file = new File([new Uint8Array([1, 2, 3])], 'image.png', {
    type: 'image/png',
  });
  Object.defineProperty(file, 'arrayBuffer', { value: jest.fn(arrayBuffer) });
  return file;
}

describe('pending image renderer capacity', () => {
  const reservedIds: string[] = [];

  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: jest.fn(() => 'blob://image'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: jest.fn(),
    });
    class MockImage {
      public width = 10;
      public height = 10;
      public onload: (() => void) | null = null;
      public onerror: (() => void) | null = null;

      public set src(_value: string) {
        this.onload?.();
      }
    }
    Object.defineProperty(globalThis, 'Image', {
      configurable: true,
      value: MockImage,
    });
  });

  afterEach(() => {
    for (const placeholderId of reservedIds.splice(0)) {
      releasePendingImageSave(placeholderId);
    }
    jest.restoreAllMocks();
  });

  it('refuses the next image visibly before conversion or placeholder insertion', async () => {
    for (let index = 0; index < MAX_PENDING_IMAGE_SAVES; index += 1) {
      const placeholderId = `reserved-${index}`;
      reservedIds.push(placeholderId);
      expect(tryReservePendingImageSave(placeholderId)).toBe(true);
    }
    const editor = { chain: jest.fn() } as unknown as Editor;
    const file = createImageFile(async () => new ArrayBuffer(3));
    const postMessage = jest.fn();

    await insertImage(
      editor,
      file,
      { viewGeneration: 'capacity-view', postMessage },
      'images',
      'dropped'
    );
    await insertImage(
      editor,
      file,
      { viewGeneration: 'capacity-view', postMessage },
      'images',
      'dropped'
    );

    expect(editor.chain).not.toHaveBeenCalled();
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'showError',
      message: `Up to ${MAX_PENDING_IMAGE_SAVES} images can be saved at once. Wait for current image saves to finish, then try again.`,
    });
    expect(getPendingImageCount()).toBe(MAX_PENDING_IMAGE_SAVES);
  });

  it('releases its reservation when conversion fails before posting', async () => {
    const editor = createEditor();
    const file = createImageFile(async () => {
      throw new Error('buffer conversion failed');
    });
    const postMessage = jest.fn();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await insertImage(
      editor,
      file,
      { viewGeneration: 'conversion-failure-view', postMessage },
      'images',
      'dropped'
    );

    expect(getPendingImageCount()).toBe(0);
    expect(postMessage).not.toHaveBeenCalled();
    editor.destroy();
  });

  it('settles explicit-action waiters only after the final pending image completes', async () => {
    const first = 'wait-first';
    const second = 'wait-second';
    reservedIds.push(first, second);
    expect(tryReservePendingImageSave(first)).toBe(true);
    expect(tryReservePendingImageSave(second)).toBe(true);
    let settled = false;
    const drained = waitForPendingImageSaves().then(() => {
      settled = true;
    });

    releasePendingImageSave(first);
    await Promise.resolve();
    expect(settled).toBe(false);

    releasePendingImageSave(second);
    await drained;
    expect(settled).toBe(true);
  });

  it('registers the host image write before publishing its pending document marker', async () => {
    const order: string[] = [];
    const editor = new Editor({
      extensions: [StarterKit, PendingImage.configure({ allowBase64: true })],
      content: '<p>before</p>',
      onUpdate: () => order.push('edit'),
    });
    const file = createImageFile(async () => new Uint8Array([1, 2, 3]).buffer);
    const postMessage = jest.fn((message: unknown) => {
      order.push((message as { type?: string }).type ?? 'unknown');
    });

    await insertImage(
      editor,
      file,
      { viewGeneration: 'ordering-view', postMessage },
      'images',
      'dropped'
    );

    expect(order).toEqual(['saveImage', 'edit']);
    const saveMessage = postMessage.mock.calls[0]?.[0] as { placeholderId?: string } | undefined;
    expect(saveMessage?.placeholderId).toEqual(expect.any(String));
    if (saveMessage?.placeholderId) releasePendingImageSave(saveMessage.placeholderId);
    editor.destroy();
  });

  it('removes its inserted placeholder and reservation when postMessage throws', async () => {
    const editor = createEditor();
    const file = createImageFile(async () => new Uint8Array([1, 2, 3]).buffer);
    const postMessage = jest.fn(() => {
      throw new Error('webview bridge unavailable');
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await insertImage(
      editor,
      file,
      { viewGeneration: 'post-failure-view', postMessage },
      'images',
      'dropped'
    );

    let pendingPlaceholders = 0;
    editor.state.doc.descendants(node => {
      if (node.type.name === 'image' && node.attrs['data-placeholder-id']) {
        pendingPlaceholders += 1;
      }
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(pendingPlaceholders).toBe(0);
    expect(getPendingImageCount()).toBe(0);
    editor.destroy();
  });
});
