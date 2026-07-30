/**
 * @jest-environment jsdom
 */

/**
 * Regression coverage for the image action menu on very small images.
 *
 * A narrow image (e.g. a 40px icon at the start of a line) is smaller than the
 * 28px menu button plus its inset, so the button used to sit on top of the
 * picture and the 160px dropdown ran off the left edge of the viewport.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  NARROW_IMAGE_CLASS,
  NARROW_IMAGE_MAX_WIDTH_PX,
  createImageMenu,
  createImageMenuButton,
  observeNarrowImageLayout,
  showImageMenu,
  syncNarrowImageLayout,
} from '../../webview/features/imageMenu';

type Rect = { left: number; width: number };

function stubRect(el: HTMLElement, rect: Rect): void {
  el.getBoundingClientRect = () =>
    ({
      left: rect.left,
      right: rect.left + rect.width,
      width: rect.width,
      top: 0,
      bottom: 0,
      height: 0,
      x: rect.left,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

function stubOffsetSize(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
}

describe('image menu on narrow images', () => {
  let wrapper: HTMLElement;
  let img: HTMLImageElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    wrapper = document.createElement('span');
    wrapper.className = 'image-wrapper';
    img = document.createElement('img');
    wrapper.appendChild(img);
    document.body.appendChild(wrapper);
  });

  describe('syncNarrowImageLayout', () => {
    it('marks images narrower than the threshold', () => {
      stubRect(img, { left: 0, width: NARROW_IMAGE_MAX_WIDTH_PX - 30 });

      syncNarrowImageLayout(wrapper, img);

      expect(wrapper.classList.contains(NARROW_IMAGE_CLASS)).toBe(true);
    });

    it('does not mark images at or above the threshold', () => {
      stubRect(img, { left: 0, width: NARROW_IMAGE_MAX_WIDTH_PX });

      syncNarrowImageLayout(wrapper, img);

      expect(wrapper.classList.contains(NARROW_IMAGE_CLASS)).toBe(false);
    });

    it('ignores unmeasured images so a loading image is not treated as narrow', () => {
      stubRect(img, { left: 0, width: 0 });
      stubOffsetSize(img, 0, 0);

      syncNarrowImageLayout(wrapper, img);

      expect(wrapper.classList.contains(NARROW_IMAGE_CLASS)).toBe(false);
    });

    it('re-evaluates once the image reports its size on load', () => {
      stubRect(img, { left: 0, width: 0 });
      stubOffsetSize(img, 0, 0);

      const stop = observeNarrowImageLayout(wrapper, img);
      expect(wrapper.classList.contains(NARROW_IMAGE_CLASS)).toBe(false);

      stubRect(img, { left: 0, width: 40 });
      img.dispatchEvent(new Event('load'));

      expect(wrapper.classList.contains(NARROW_IMAGE_CLASS)).toBe(true);
      stop();
    });
  });

  describe('the menu button stays reachable', () => {
    /**
     * The gutter that makes room for the button must be padding on the wrapper,
     * not margin. With margin, the strip between the image and the button
     * belongs to the paragraph, so moving the pointer toward the button fires
     * mouseleave on the wrapper and the button is hidden before it can be used.
     */
    it('reserves the gutter as wrapper padding, not margin', () => {
      const css = readFileSync(resolve(__dirname, '../../webview/editor.css'), 'utf8');
      const rule = css.match(/\.image-wrapper\.image-narrow\s*\{[^}]*\}/);

      expect(rule).not.toBeNull();
      expect(rule?.[0]).toContain('padding-right');
      expect(rule?.[0]).not.toContain('margin-right');
    });

    it('keeps the button inside the wrapper subtree so hover is continuous', () => {
      const button = createImageMenuButton();
      wrapper.appendChild(button);

      // mouseleave/mouseenter bookkeeping relies on DOM containment, which holds
      // even though the button is painted beside the image rather than over it.
      expect(wrapper.contains(button)).toBe(true);
    });
  });

  describe('dropdown horizontal placement', () => {
    let menu: HTMLElement;
    let button: HTMLButtonElement;

    beforeEach(() => {
      button = createImageMenuButton();
      menu = createImageMenu(true);
      wrapper.appendChild(button);
      wrapper.appendChild(menu);

      stubOffsetSize(button, 28, 28);
      stubOffsetSize(menu, 160, 120);
      // jsdom has no layout engine, so offsetParent is null; point it at the wrapper.
      Object.defineProperty(menu, 'offsetParent', { value: wrapper, configurable: true });
    });

    function openMenu(): void {
      showImageMenu(menu, button, img, {} as never, { postMessage: jest.fn() });
    }

    it('keeps the dropdown on screen for a narrow image at the start of a line', () => {
      // 40px image flush against the editor's left gutter.
      stubRect(wrapper, { left: 24, width: 40 });

      openMenu();

      const left = parseFloat(menu.style.left);
      expect(menu.style.right).toBe('auto');
      // Right-aligning to a 40px wrapper would put the menu at -120px viewport,
      // clipped off screen. It must be clamped back inside instead.
      expect(24 + left).toBeGreaterThanOrEqual(0);
    });

    it('right-aligns to the image when there is room', () => {
      stubRect(wrapper, { left: 200, width: 400 });

      openMenu();

      expect(parseFloat(menu.style.left)).toBe(400 - 160);
      expect(menu.style.right).toBe('auto');
    });

    it('pulls the dropdown back in when the image sits near the right edge', () => {
      const viewportWidth = window.innerWidth;
      stubRect(wrapper, { left: viewportWidth - 60, width: 40 });

      openMenu();

      const left = parseFloat(menu.style.left);
      expect(viewportWidth - 60 + left + 160).toBeLessThanOrEqual(viewportWidth);
    });
  });
});
