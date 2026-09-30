/** @jest-environment jsdom */

import { isHugeImage, showHugeImageDialog } from '../../webview/features/hugeImageDialog';

// Mock URL helpers used by showHugeImageDialog
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeAll(() => {
  URL.createObjectURL = jest.fn(() => 'blob://mock');
  URL.revokeObjectURL = jest.fn();
});

afterAll(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe('hugeImageDialog', () => {
  it('flags files over 2MB as huge', () => {
    const bigFile = new File([new Uint8Array(3 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    const smallFile = new File([new Uint8Array(1000)], 'small.png', { type: 'image/png' });

    expect(isHugeImage(bigFile)).toBe(true);
    expect(isHugeImage(smallFile)).toBe(false);
  });

  it('shows dialog and returns suggested resize when user chooses resize', async () => {
    // Mock Image to immediately provide dimensions
    const mockDimensions = { width: 4000, height: 3000 };
    class MockImage {
      width = mockDimensions.width;
      height = mockDimensions.height;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        // Immediately trigger load with preset dimensions
        this.width = mockDimensions.width;
        this.height = mockDimensions.height;
        this.onload?.();
      }
    }
    (global as typeof globalThis & { Image: typeof Image }).Image = MockImage as typeof Image;

    const file = new File([new Uint8Array(3 * 1024 * 1024)], 'big.png', { type: 'image/png' });

    const dialogPromise = showHugeImageDialog(file);

    // Wait for async dimension load to resolve and dialog to render
    await new Promise(resolve => setTimeout(resolve, 0));

    // Dialog renders synchronously after call
    const resizeButton = document.querySelector('#resize-suggested-btn') as HTMLButtonElement;
    expect(resizeButton).not.toBeNull();

    resizeButton.click();

    const result = await dialogPromise;
    expect(result).toEqual({
      action: 'resize-suggested',
      customWidth: 1120, // 80% of 1400px max editor width
      customHeight: 840,
    });

    expect(document.querySelector('.huge-image-overlay')).toBeNull();
  });
});

describe('large-image bypass and cleanup', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not offer raster optimization for a large SVG', async () => {
    const file = new File([new Uint8Array(3 * 1024 * 1024)], 'large.svg', {
      type: 'image/svg+xml',
    });
    expect(isHugeImage(file)).toBe(false);
    await expect(showHugeImageDialog(file)).resolves.toEqual({ action: 'use-original' });
    expect(document.querySelector('.huge-image-overlay')).toBeNull();
  });

  it('does not offer raster optimization for SVG with generic MIME and a literal hash in its filename', () => {
    const file = new File([new Uint8Array(3 * 1024 * 1024)], 'large#diagram.svg', { type: '' });
    expect(isHugeImage(file)).toBe(false);
  });

  it('distinguishes no dialog needed from cancellation', async () => {
    const small = new File(['small'], 'small.png', { type: 'image/png' });
    await expect(showHugeImageDialog(small)).resolves.toEqual({ action: 'use-original' });
  });

  it.each([false, true])(
    'preserves large-file raster images with small or unavailable dimensions (failed=%s)',
    async failed => {
      class MockImage {
        width = 1000;
        height = 800;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          if (failed) this.onerror?.();
          else this.onload?.();
        }
      }
      (global as typeof globalThis & { Image: typeof Image }).Image = MockImage as typeof Image;
      const file = new File([new Uint8Array(3 * 1024 * 1024)], 'big.png', { type: 'image/png' });
      await expect(showHugeImageDialog(file)).resolves.toEqual({ action: 'use-original' });
    }
  );

  it('removes Escape handling after a successful choice', async () => {
    class MockImage {
      width = 4000;
      height = 3000;
      onload: (() => void) | null = null;
      set src(_value: string) {
        this.onload?.();
      }
    }
    (global as typeof globalThis & { Image: typeof Image }).Image = MockImage as typeof Image;
    const removeListener = jest.spyOn(window, 'removeEventListener');
    const file = new File([new Uint8Array(3 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    const dialog = showHugeImageDialog(file);
    await new Promise(resolve => setTimeout(resolve, 0));
    (document.querySelector('#use-original-btn') as HTMLButtonElement).click();
    await expect(dialog).resolves.toEqual({ action: 'use-original' });
    expect(removeListener).toHaveBeenCalledWith('keydown', expect.any(Function));
    removeListener.mockRestore();
  });
});
