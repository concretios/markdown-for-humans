/** @jest-environment jsdom */

/**
 * "Copy to Workspace & Edit" for an image outside the workspace.
 *
 * The host copies the file and replies with `localImageCopied`. The webview must
 * point that image node at the copy and open the resize modal on the live image.
 * Regression: the dialog closed and nothing happened, because the reply could not
 * be mapped back to the image node.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { CustomImage } from '../../webview/extensions/customImage';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import {
  handleLocalImageCopied,
  hideImageResizeModal,
} from '../../webview/features/imageResizeModal';

const PLACEHOLDER = 'copy-img-1';
const ORIGINAL = '/Users/me/Desktop/shot.png';
const COPIED = './images/shot-2.png';

let editor: Editor;
const restore: Array<() => void> = [];

function stubImageSize(width: number, height: number): void {
  for (const [prop, value] of [
    ['naturalWidth', width],
    ['naturalHeight', height],
  ] as const) {
    const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, prop);
    Object.defineProperty(HTMLImageElement.prototype, prop, {
      configurable: true,
      get: () => value,
    });
    restore.push(() => {
      if (original) Object.defineProperty(HTMLImageElement.prototype, prop, original);
    });
  }
}

function createEditor(markdown: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const created = new Editor({
    element,
    // MarkdownParagraph, as in editor.ts, keeps standalone images inside paragraphs.
    extensions: [
      StarterKit.configure({ paragraph: false }),
      MarkdownParagraph,
      CustomImage,
      Markdown,
    ],
    content: markdown,
    contentType: 'markdown',
  });
  created.state.doc.check();
  return created;
}

/** Mark the rendered image the way showImageResizeModal does before posting the copy. */
function markPendingCopy(): HTMLImageElement {
  const img = editor.view.dom.querySelector('.markdown-image') as HTMLImageElement;
  const pending = img as unknown as Record<string, unknown>;
  pending._pendingDownloadPlaceholderId = PLACEHOLDER;
  pending._pendingResizeAfterDownload = true;
  return img;
}

function liveImage(): HTMLImageElement {
  return editor.view.dom.querySelector('.markdown-image') as HTMLImageElement;
}

beforeEach(() => {
  stubImageSize(200, 100);
});

afterEach(() => {
  hideImageResizeModal();
  editor?.destroy();
  restore.splice(0).forEach(undo => undo());
  document.body.innerHTML = '';
});

describe('handleLocalImageCopied', () => {
  it.each([
    ['an absolute path', `![shot](${ORIGINAL})`],
    ['a dot-relative path', '![shot](./shot.png)'],
    ['a parent-relative path', '![shot](../Desktop/shot.png)'],
  ])('points the image at the copy when the source is %s', (_name, markdown) => {
    editor = createEditor(markdown);
    markPendingCopy();

    handleLocalImageCopied(
      editor,
      { placeholderId: PLACEHOLDER, relativePath: COPIED, originalPath: ORIGINAL },
      { postMessage: jest.fn() }
    );

    expect(editor.getMarkdown().trim()).toBe(`![shot](${COPIED})`);
  });

  it('opens the resize modal bound to the live image once the copy loads', () => {
    editor = createEditor(`![shot](${ORIGINAL})`);
    markPendingCopy();

    handleLocalImageCopied(
      editor,
      { placeholderId: PLACEHOLDER, relativePath: COPIED, originalPath: ORIGINAL },
      { postMessage: jest.fn() }
    );

    // Before the copy has loaded, its size is unknown, so the modal waits.
    expect(document.querySelector('.image-resize-modal-overlay')).toBeNull();
    liveImage().dispatchEvent(new Event('load'));
    expect(document.querySelector('.image-resize-modal-overlay')).not.toBeNull();
    const widthInput = document.querySelector('#resize-width-input') as HTMLInputElement;
    widthInput.value = '100';
    widthInput.dispatchEvent(new Event('input'));

    expect(liveImage().isConnected).toBe(true);
    expect(liveImage().style.width).toBe('100px');
  });

  it('updates only the image that started the copy', () => {
    editor = createEditor(`![other](./other.png)\n\n![shot](${ORIGINAL})`);
    const images = editor.view.dom.querySelectorAll('.markdown-image');
    const pending = images[1] as unknown as Record<string, unknown>;
    pending._pendingDownloadPlaceholderId = PLACEHOLDER;

    handleLocalImageCopied(
      editor,
      { placeholderId: PLACEHOLDER, relativePath: COPIED, originalPath: ORIGINAL },
      { postMessage: jest.fn() }
    );

    expect(editor.getMarkdown().trim()).toBe(`![other](./other.png)\n\n![shot](${COPIED})`);
    expect(document.querySelector('.image-resize-modal-overlay')).toBeNull();
  });

  it('ignores a reply whose placeholder matches no image', () => {
    editor = createEditor(`![shot](${ORIGINAL})`);

    handleLocalImageCopied(
      editor,
      { placeholderId: 'unknown', relativePath: COPIED, originalPath: ORIGINAL },
      { postMessage: jest.fn() }
    );

    expect(editor.getMarkdown().trim()).toBe(`![shot](${ORIGINAL})`);
  });
});
