/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import { Editor } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import StarterKit from '@tiptap/starter-kit';
import {
  applyFailedImageCompletion,
  applySavedImageCompletion,
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
    content: [
      '<p><img src="data:image/png;base64,AA==" data-placeholder-id="shared"></p>',
      '<p><img src="data:image/png;base64,AA==" data-placeholder-id="shared"></p>',
    ].join(''),
  });
}

function matchingImages(editor: Editor, placeholderId: string) {
  const matches: Array<{ src: string; placeholderId: unknown }> = [];
  editor.state.doc.descendants(node => {
    if (node.type.name === 'image' && node.attrs['data-placeholder-id'] === placeholderId) {
      matches.push({
        src: node.attrs.src as string,
        placeholderId: node.attrs['data-placeholder-id'],
      });
    }
  });
  return matches;
}

describe('pending image completion ProseMirror mutations', () => {
  it('updates every duplicate placeholder atomically and verifies none remain', () => {
    const editor = createEditor();

    expect(applySavedImageCompletion(editor, 'shared', './images/final.png')).toBe(true);

    expect(matchingImages(editor, 'shared')).toHaveLength(0);
    const sources: string[] = [];
    editor.state.doc.descendants(node => {
      if (node.type.name === 'image') sources.push(node.attrs.src as string);
    });
    expect(sources).toEqual(['./images/final.png', './images/final.png']);
    editor.destroy();
  });

  it('deletes every duplicate error placeholder in descending positions', () => {
    const editor = createEditor();

    expect(applyFailedImageCompletion(editor, 'shared')).toBe(true);

    expect(matchingImages(editor, 'shared')).toHaveLength(0);
    editor.destroy();
  });

  it('reports mutation failure so the renderer withholds its ACK', () => {
    const editor = createEditor();
    jest.spyOn(editor.view, 'dispatch').mockImplementation(() => {
      throw new Error('dispatch failed');
    });

    expect(applySavedImageCompletion(editor, 'shared', './images/final.png')).toBe(false);
    expect(matchingImages(editor, 'shared')).toHaveLength(2);
    editor.destroy();
  });
});
