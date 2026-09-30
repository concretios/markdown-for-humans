/** @jest-environment jsdom */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { CustomImage } from '../../webview/extensions/customImage';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { isMarkdownRendererEquivalent } from '../../editor/markdownAstEquivalence';
import {
  showImageResizeModal,
  hideImageResizeModal,
} from '../../webview/features/imageResizeModal';

type ImageView = { dom: HTMLElement; destroy: () => void };
const createView = (attrs: Record<string, unknown>): ImageView => {
  const factory = (
    CustomImage.config.addNodeView as unknown as () => (args: {
      node: { attrs: Record<string, unknown> };
      HTMLAttributes: Record<string, string>;
      editor: object;
    }) => ImageView
  )();
  const view = factory({ node: { attrs }, HTMLAttributes: {}, editor: {} });
  document.body.appendChild(view.dom);
  return view;
};
const load = (img: HTMLImageElement, width: number, height: number) => {
  Object.defineProperties(img, {
    complete: { value: true, configurable: true },
    naturalWidth: { value: width, configurable: true },
    naturalHeight: { value: height, configurable: true },
  });
  img.dispatchEvent(new Event('load'));
};

describe('SVG image rendering and source integrity', () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete window.resolveImagePath;
    hideImageResizeModal();
    jest.useRealTimers();
  });

  it('gives a decoded ratio-only image a definite width without modifying its source', () => {
    const view = createView({ src: './diagram.svg', alt: 'w:1000' });
    const img = view.dom.querySelector('img')!;
    load(img, 300, 131);
    expect(img.width).toBe(300);
    expect(img.alt).toBe('w:1000');
    expect(img.getAttribute('data-markdown-src')).toBe('./diagram.svg');
    expect(img.hasAttribute('data-loading')).toBe(false);
    view.destroy();
  });

  it('preserves authored display width and small raster intrinsic width', () => {
    const svg = createView({ src: './diagram.svg', width: 480 });
    const svgImg = svg.dom.querySelector('img')!;
    load(svgImg, 300, 131);
    expect(svgImg.width).toBe(480);
    const raster = createView({ src: './icon.png' });
    const rasterImg = raster.dom.querySelector('img')!;
    load(rasterImg, 24, 24);
    expect(rasterImg.width).toBe(24);
    svg.destroy();
    raster.destroy();
  });

  it('shows a visible load error while keeping the authored image reference', () => {
    const view = createView({ src: './broken.svg', alt: 'Diagram' });
    view.dom.querySelector('img')!.dispatchEvent(new Event('error'));
    expect(view.dom.querySelector('.image-load-error')?.textContent).toContain(
      'Unable to load image'
    );
    expect(view.dom.querySelector('.image-load-error')?.textContent).toContain('./broken.svg');
    expect(view.dom.querySelector('img')!.hasAttribute('data-loading')).toBe(false);
    view.destroy();
  });

  it('handles failed resolution and ignores a completion after destruction', async () => {
    window.resolveImagePath = jest.fn().mockRejectedValue(new Error('Outside allowed roots'));
    const failed = createView({ src: './missing.svg' });
    await Promise.resolve();
    await Promise.resolve();
    expect(failed.dom.querySelector('.image-load-error')?.textContent).toContain(
      'Unable to load image'
    );
    failed.destroy();
    let resolvePath!: (uri: string) => void;
    window.resolveImagePath = () =>
      new Promise(resolve => {
        resolvePath = resolve;
      });
    const stale = createView({ src: './pending.svg' });
    stale.destroy();
    resolvePath('https://example.com/should-not-be-loaded.svg');
    await Promise.resolve();
    expect(stale.dom.querySelector('img')!.getAttribute('src')).toBeNull();
  });

  it.each([
    '<img src="diagram.svg" alt="Diagram" width="320" />',
    "<img width='480' src='images/a&amp;b.svg' alt='A &quot;diagram&quot;' title='Details'>",
    'Before <img src="diagram.svg" width="320" height="140"> after',
  ])('keeps sized image attributes through repeated round trips: %s', source => {
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ paragraph: false }),
        MarkdownParagraph,
        Markdown,
        CustomImage,
      ],
      content: source,
      contentType: 'markdown',
    });
    try {
      for (let iteration = 0; iteration < 3; iteration += 1) {
        const serialized = editor.getMarkdown();
        expect(isMarkdownRendererEquivalent(serialized, source)).toBe(true);
        expect(editor.getHTML()).toContain('width=');
        editor.commands.setContent(serialized, { contentType: 'markdown' });
      }
    } finally {
      editor.destroy();
    }
  });

  it('serializes a deliberate size change as escaped HTML and keeps undo in the document', () => {
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ paragraph: false }),
        MarkdownParagraph,
        Markdown,
        CustomImage,
      ],
      content: '![Diagram](diagram.svg)',
      contentType: 'markdown',
    });
    try {
      let imagePosition = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'image') imagePosition = pos;
      });
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(imagePosition, undefined, {
          ...editor.state.doc.nodeAt(imagePosition)!.attrs,
          width: 480,
          alt: 'A "diagram" <safe>',
        })
      );
      const serialized = editor.getMarkdown();
      expect(serialized).toContain('width="480"');
      expect(serialized).toContain('alt="A &quot;diagram&quot; &lt;safe&gt;"');
      expect(isMarkdownRendererEquivalent(serialized, '![Diagram](diagram.svg)')).toBe(false);
      editor.commands.setContent(serialized, { contentType: 'markdown' });
      expect(editor.getMarkdown()).toBe(serialized);
    } finally {
      editor.destroy();
    }
  });

  it('rejects the raster resize entry point for SVG before any host file request', async () => {
    jest.useFakeTimers();
    const img = document.createElement('img');
    img.setAttribute('data-markdown-src', './diagram.SVG#view');
    load(img, 300, 131);
    const api = { postMessage: jest.fn() };
    const pending = showImageResizeModal(img, {} as Editor, api);
    jest.advanceTimersByTime(2500);
    await pending;
    expect(api.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'showError',
        message: expect.stringContaining('Display size'),
      })
    );
    expect(api.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'checkImageInWorkspace' })
    );
    expect(document.querySelector('.image-resize-modal-overlay')).toBeNull();
  });
});
