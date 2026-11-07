/** @jest-environment jsdom */

import { CustomImage } from '../../webview/extensions/customImage';
import * as l10n from '../../webview/l10n';

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

const sampleBundle: Record<string, string> = {
  'Unable to load image: {0}': '无法加载图片：{0}',
  'Image options': '图片选项',
};

describe('Image node view localization', () => {
  afterEach(() => {
    document.body.replaceChildren();
    l10n.resetL10n();
  });

  it('shows English when no bundle is loaded', () => {
    const view = createView({ src: './broken.png' });

    view.dom.querySelector('img')!.dispatchEvent(new Event('error'));

    expect(view.dom.querySelector('.image-load-error')?.textContent).toBe(
      'Unable to load image: ./broken.png'
    );
    expect(view.dom.querySelector('.image-menu-button')?.getAttribute('title')).toBe(
      'Image options'
    );
    view.destroy();
  });

  it('translates the load error and keeps the image path as written', () => {
    l10n.configureL10n(sampleBundle);
    const view = createView({ src: './broken.png' });

    view.dom.querySelector('img')!.dispatchEvent(new Event('error'));

    expect(view.dom.querySelector('.image-load-error')?.textContent).toBe(
      '无法加载图片：./broken.png'
    );
    view.destroy();
  });

  it('translates the tooltip of the image options button', () => {
    l10n.configureL10n(sampleBundle);
    const view = createView({ src: './photo.png' });

    expect(view.dom.querySelector('.image-menu-button')?.getAttribute('title')).toBe('图片选项');
    view.destroy();
  });
});
