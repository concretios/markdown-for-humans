/** @jest-environment jsdom */
import {
  clearImageMetadataCache,
  clearPendingImageMetadataRequests,
  getCachedImageMetadata,
  refreshImageMetadata,
  showImageMetadataFooter,
  updateImageMetadataDimensions,
  type ImageMetadata,
} from '../../webview/features/imageMetadata';

describe('image details after a resize', () => {
  const before: ImageMetadata = {
    filename: 'photo.png',
    size: 12800,
    dimensions: { width: 2400, height: 1350 },
    lastModified: 1,
    path: './photo.png',
  };
  const after: ImageMetadata = {
    ...before,
    size: 18700,
    dimensions: { width: 0, height: 0 },
    lastModified: 2,
  };

  // Answers every getImageMetadata request the way the extension host does.
  const vscodeApi = {
    postMessage: jest.fn((message: { requestId: string }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callbacks = (window as any)._metadataCallbacks as Map<
        string,
        (m: ImageMetadata) => void
      >;
      callbacks.get(message.requestId)?.({ ...after, dimensions: { ...after.dimensions } });
    }),
  };

  function hoveredImage(): { img: HTMLImageElement; wrapper: HTMLElement } {
    const wrapper = document.createElement('span');
    wrapper.className = 'image-wrapper';
    const img = document.createElement('img');
    img.setAttribute('data-markdown-src', './photo.png');
    Object.defineProperty(img, 'naturalWidth', { value: 1200 });
    wrapper.appendChild(img);
    document.body.appendChild(wrapper);
    showImageMetadataFooter(img, wrapper, vscodeApi);
    return { img, wrapper };
  }

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).showImageHoverOverlay = true;
    document.body.innerHTML = '';
    clearImageMetadataCache();
    clearPendingImageMetadataRequests();
    vscodeApi.postMessage.mockClear();
    updateImageMetadataDimensions('./photo.png', before.dimensions, { ...before });
  });

  it('asks the host again and redraws the visible footer with the new size and dimensions', async () => {
    const { img, wrapper } = hoveredImage();
    expect(wrapper.textContent).toContain('2400×1350');

    updateImageMetadataDimensions('./photo.png', { width: 1200, height: 675 });
    await refreshImageMetadata(img, vscodeApi);

    expect(vscodeApi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'getImageMetadata', imagePath: './photo.png' })
    );
    const text = wrapper.querySelector('.image-metadata-footer')?.textContent ?? '';
    expect(text).toContain('1200×675');
    expect(text).toContain('18.3 KB');
    expect(text).not.toContain('12.5 KB');
  });

  it('refreshes the cache even when no footer is showing, so the next hover is right', async () => {
    const wrapper = document.createElement('span');
    wrapper.className = 'image-wrapper';
    const img = document.createElement('img');
    img.setAttribute('data-markdown-src', './photo.png');
    wrapper.appendChild(img);
    document.body.appendChild(wrapper);

    updateImageMetadataDimensions('./photo.png', { width: 1200, height: 675 });
    await refreshImageMetadata(img, vscodeApi);

    expect(wrapper.querySelector('.image-metadata-footer')).toBeNull();
    expect(getCachedImageMetadata('./photo.png')).toMatchObject({
      size: 18700,
      lastModified: 2,
      dimensions: { width: 1200, height: 675 },
    });
  });

  it('leaves a hidden footer hidden', async () => {
    const { img, wrapper } = hoveredImage();
    (wrapper.querySelector('.image-metadata-footer') as HTMLElement).style.display = 'none';

    await refreshImageMetadata(img, vscodeApi);

    expect((wrapper.querySelector('.image-metadata-footer') as HTMLElement).style.display).toBe(
      'none'
    );
  });
});
