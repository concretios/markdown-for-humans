/** @jest-environment jsdom */

import { CustomImage } from '../../webview/extensions/customImage';

describe('CustomImage indentation', () => {
  beforeEach(() => {
    delete (window as unknown as { resolveImagePath?: unknown }).resolveImagePath;
    delete (window as unknown as { _imageCacheBust?: unknown })._imageCacheBust;
    delete (window as unknown as { showImageHoverOverlay?: unknown }).showImageHoverOverlay;
  });

  it('applies indentation styles based on indent-prefix attr', () => {
    const extension = CustomImage.configure({
      allowBase64: true,
      HTMLAttributes: { class: 'markdown-image' },
    });

    const nodeViewFactoryRaw = (
      extension as unknown as {
        config?: {
          addNodeView?: () => (args: {
            node: unknown;
            HTMLAttributes: unknown;
            editor: unknown;
          }) => { dom: HTMLElement };
        };
      }
    ).config?.addNodeView?.();
    expect(typeof nodeViewFactoryRaw).toBe('function');
    if (!nodeViewFactoryRaw) throw new Error('nodeViewFactory is undefined');
    const nodeViewFactory: (args: {
      node: unknown;
      HTMLAttributes: unknown;
      editor: unknown;
      extension?: unknown;
    }) => { dom: HTMLElement } = nodeViewFactoryRaw;

    const node = {
      attrs: {
        src: './img.png',
        alt: 'alt',
        'indent-prefix': '    ', // 4 spaces
      },
    };

    const nodeView = nodeViewFactory({
      node,
      HTMLAttributes: { class: 'markdown-image' },
      editor: {},
      extension: {
        options: {
          getShowImageHoverOverlay: () => false,
        },
      },
    });

    const wrapper = nodeView.dom;
    expect(wrapper.style.marginLeft).toBe('30px');
    expect(wrapper.style.maxWidth).toBe('calc(100% - 30px)');
  });

  it('does not apply indentation styles when indent-prefix is missing', () => {
    const extension = CustomImage.configure({
      allowBase64: true,
      HTMLAttributes: { class: 'markdown-image' },
    });

    const nodeViewFactoryRaw = (
      extension as unknown as {
        config?: {
          addNodeView?: () => (args: {
            node: unknown;
            HTMLAttributes: unknown;
            editor: unknown;
          }) => { dom: HTMLElement };
        };
      }
    ).config?.addNodeView?.();
    expect(typeof nodeViewFactoryRaw).toBe('function');
    if (!nodeViewFactoryRaw) throw new Error('nodeViewFactory is undefined');
    const nodeViewFactory: (args: { node: unknown; HTMLAttributes: unknown; editor: unknown }) => {
      dom: HTMLElement;
    } = nodeViewFactoryRaw;

    const node = {
      attrs: {
        src: './img.png',
        alt: 'alt',
      },
    };

    const nodeView = nodeViewFactory({
      node,
      HTMLAttributes: { class: 'markdown-image' },
      editor: {},
    });

    const wrapper = nodeView.dom;
    expect(wrapper.style.marginLeft).toBe('');
    expect(wrapper.style.maxWidth).toBe('');
  });

  it('adds a cache-busting query param when a timestamp exists for the markdown path', async () => {
    (window as unknown as { _imageCacheBust?: Map<string, number> })._imageCacheBust = new Map([
      ['./img.png', 123],
    ]);
    (window as unknown as { resolveImagePath?: jest.Mock<Promise<string>> }).resolveImagePath = jest
      .fn()
      .mockResolvedValue('vscode-webview://test/img.png');

    const extension = CustomImage.configure({
      allowBase64: true,
      HTMLAttributes: { class: 'markdown-image' },
    });

    const nodeViewFactoryRaw = (
      extension as unknown as {
        config?: {
          addNodeView?: () => (args: {
            node: unknown;
            HTMLAttributes: unknown;
            editor: unknown;
          }) => { dom: HTMLElement };
        };
      }
    ).config?.addNodeView?.();
    expect(typeof nodeViewFactoryRaw).toBe('function');
    if (!nodeViewFactoryRaw) throw new Error('nodeViewFactory is undefined');
    const nodeViewFactory: (args: { node: unknown; HTMLAttributes: unknown; editor: unknown }) => {
      dom: HTMLElement;
    } = nodeViewFactoryRaw;

    const node = {
      attrs: {
        src: './img.png',
        alt: 'alt',
      },
    };

    const nodeView = nodeViewFactory({
      node,
      HTMLAttributes: { class: 'markdown-image' },
      editor: {},
    });

    const wrapper = nodeView.dom;
    const img = wrapper.querySelector('img') as HTMLImageElement | null;
    expect(img).not.toBeNull();

    // Flush the resolveImagePath promise microtask.
    await Promise.resolve();

    expect(img!.src).toContain('t=123');
  });

  it('keeps image menu hover class active when overlay is disabled', () => {
    (window as unknown as { showImageHoverOverlay?: boolean }).showImageHoverOverlay = false;

    const extension = CustomImage.configure({
      allowBase64: true,
      HTMLAttributes: { class: 'markdown-image' },
      getShowImageHoverOverlay: () =>
        (window as unknown as { showImageHoverOverlay?: boolean }).showImageHoverOverlay ?? true,
    } as any);

    const nodeViewFactoryRaw = (
      extension as unknown as {
        config?: {
          addNodeView?: () => (args: {
            node: unknown;
            HTMLAttributes: unknown;
            editor: unknown;
          }) => { dom: HTMLElement };
        };
      }
    ).config?.addNodeView?.();
    expect(typeof nodeViewFactoryRaw).toBe('function');
    if (!nodeViewFactoryRaw) throw new Error('nodeViewFactory is undefined');
    const nodeViewFactory: (args: { node: unknown; HTMLAttributes: unknown; editor: unknown }) => {
      dom: HTMLElement;
    } = nodeViewFactoryRaw;

    const node = {
      attrs: {
        src: './img.png',
        alt: 'alt',
      },
    };

    const nodeView = nodeViewFactory({
      node,
      HTMLAttributes: { class: 'markdown-image' },
      editor: {},
    });

    const wrapper = nodeView.dom;
    const image = wrapper.querySelector('.markdown-image') as HTMLImageElement | null;
    expect(image).not.toBeNull();
    if (!image) {
      throw new Error('image element is missing');
    }

    // Simulate loaded image to satisfy hover-activation guard.
    Object.defineProperty(image, 'complete', { value: true, configurable: true });
    image.dispatchEvent(new Event('load'));

    wrapper.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

    expect(wrapper.classList.contains('image-menu-active')).toBe(true);
  });

  it('serializes a pending image as a compact host-resolvable marker', () => {
    const renderMarkdown = (
      CustomImage as unknown as {
        config: {
          renderMarkdown: (
            node: { attrs: Record<string, unknown> },
            helpers: Record<string, never>,
            context: Record<string, never>
          ) => string;
        };
      }
    ).config.renderMarkdown;

    expect(
      renderMarkdown(
        {
          attrs: {
            src: 'data:image/png;base64,bytes-must-not-cross-the-sync-boundary',
            alt: 'Pending',
            'data-placeholder-id': 'img-123',
          },
        },
        {},
        {}
      )
    ).toBe('![Pending](md4h-pending-image:img-123)');
  });
});
