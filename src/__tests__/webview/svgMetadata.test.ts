/** @jest-environment jsdom */
import { createMetadataFooter, type ImageMetadata } from '../../webview/features/imageMetadata';

describe('SVG hover metadata', () => {
  const metadata: ImageMetadata = {
    filename: 'diagram.svg',
    size: 1200,
    dimensions: { width: 300, height: 131 },
    lastModified: 1,
    path: './diagram.svg',
  };
  it('labels vector display dimensions for this occurrence instead of cached raster resolution', () => {
    const image = document.createElement('img');
    image.setAttribute('data-markdown-src', './diagram.svg#view');
    image.width = 480;
    image.height = 210;
    const footer = createMetadataFooter(image, metadata);
    expect(footer.textContent).toContain('Vector');
    expect(footer.textContent).toContain('480×210');
    expect(footer.textContent).not.toContain('300×131');
  });
  it('renders image filenames and paths as text even when they contain markup', () => {
    const image = document.createElement('img');
    image.width = 800;
    const footer = createMetadataFooter(image, {
      ...metadata,
      filename: '<img src=x onerror="bad()">.svg',
      path: '<svg onload="bad()">',
    });
    expect(footer.querySelector('img, svg')).toBeNull();
    expect(footer.textContent).toContain('<img src=x onerror="bad()">.svg');
  });
});
