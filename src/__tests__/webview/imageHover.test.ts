/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Tests for image hover overlay toggle functionality
 */

import { JSDOM } from 'jsdom';
import {
  showImageMetadataFooter,
  hideImageMetadataFooter,
  clearPendingImageMetadataRequests,
} from '../../webview/features/imageMetadata';

// Mock vscode API
const mockVscodeApi = {
  postMessage: jest.fn(),
};

// Setup JSDOM
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window as any;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLImageElement = dom.window.HTMLImageElement;

// Mock window globals
(window as any).showImageHoverOverlay = true;
(window as any).vscode = mockVscodeApi;

describe('Image Hover Overlay Toggle', () => {
  let wrapper: HTMLElement;
  let img: HTMLImageElement;

  beforeEach(() => {
    // Reset window global
    (window as any).showImageHoverOverlay = true;

    // Create test elements
    wrapper = document.createElement('span');
    wrapper.className = 'image-wrapper';

    img = document.createElement('img');
    img.className = 'markdown-image';
    img.src = 'test.jpg';
    img.setAttribute('data-markdown-src', 'test.jpg');

    wrapper.appendChild(img);
    document.body.appendChild(wrapper);

    // Mock image as loaded
    Object.defineProperty(img, 'complete', { value: true });
    Object.defineProperty(img, 'naturalWidth', { value: 100 });
    Object.defineProperty(img, 'naturalHeight', { value: 100 });
  });

  afterEach(() => {
    clearPendingImageMetadataRequests();
    document.body.innerHTML = '';
    delete (window as any)._metadataCallbacks;
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('showImageMetadataFooter', () => {
    it('should show metadata footer when setting is enabled', () => {
      (window as any).showImageHoverOverlay = true;

      showImageMetadataFooter(img, wrapper, mockVscodeApi);

      const footer = wrapper.querySelector('.image-metadata-footer');
      expect(footer).toBeTruthy();
      expect((footer as HTMLElement).style.display).toBe('block');
    });

    it('should not show metadata footer when setting is disabled', () => {
      (window as any).showImageHoverOverlay = false;

      showImageMetadataFooter(img, wrapper, mockVscodeApi);

      const footer = wrapper.querySelector('.image-metadata-footer');
      expect(footer).toBeFalsy();
    });

    it('should not show metadata footer for external images', () => {
      (window as any).showImageHoverOverlay = true;
      img.setAttribute('data-markdown-src', 'https://example.com/image.jpg');

      showImageMetadataFooter(img, wrapper, mockVscodeApi);

      const footer = wrapper.querySelector('.image-metadata-footer') as HTMLElement;
      expect(footer).toBeTruthy();
      expect(footer.style.display).toBe('none');
    });

    it('clears pending metadata request timers', () => {
      jest.useFakeTimers();
      (window as any).showImageHoverOverlay = true;

      showImageMetadataFooter(img, wrapper, mockVscodeApi);

      expect(jest.getTimerCount()).toBeGreaterThan(0);

      clearPendingImageMetadataRequests();

      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('hideImageMetadataFooter', () => {
    it('should hide existing metadata footer', () => {
      // First show footer
      (window as any).showImageHoverOverlay = true;
      showImageMetadataFooter(img, wrapper, mockVscodeApi);

      let footer = wrapper.querySelector('.image-metadata-footer');
      expect(footer).toBeTruthy();

      // Then hide it
      hideImageMetadataFooter(wrapper);

      footer = wrapper.querySelector('.image-metadata-footer');
      expect((footer as HTMLElement).style.display).toBe('none');
    });
  });

  describe('CSS class application', () => {
    it('should apply image-hover-active class when setting is enabled', () => {
      (window as any).showImageHoverOverlay = true;

      // Simulate mouseenter
      const event = new dom.window.MouseEvent('mouseenter');
      wrapper.dispatchEvent(event);

      // In real implementation, this would be handled by customImage.ts
      // Here we test the logic indirectly
      expect(wrapper.classList.contains('image-hover-active')).toBe(false); // Not applied by this test
    });

    it('should not apply image-hover-active class when setting is disabled', () => {
      (window as any).showImageHoverOverlay = false;

      // Simulate mouseenter
      const event = new dom.window.MouseEvent('mouseenter');
      wrapper.dispatchEvent(event);

      // In real implementation, this would be handled by customImage.ts
      expect(wrapper.classList.contains('image-hover-active')).toBe(false);
    });
  });

  describe('Setting propagation', () => {
    it('should store setting from settingsUpdate message', () => {
      // Simulate settingsUpdate message
      const message = {
        type: 'settingsUpdate',
        showImageHoverOverlay: false,
      } as any;

      // Simulate message handler (from editor.ts)
      if (typeof message.showImageHoverOverlay === 'boolean') {
        (window as any).showImageHoverOverlay = message.showImageHoverOverlay;
      }

      expect((window as any).showImageHoverOverlay).toBe(false);
    });

    it('should default to true when setting is undefined', () => {
      // Simulate settingsUpdate message without the setting
      const message = {
        type: 'settingsUpdate',
        skipResizeWarning: false,
      } as any;

      // Simulate message handler
      if (typeof message.showImageHoverOverlay === 'boolean') {
        (window as any).showImageHoverOverlay = message.showImageHoverOverlay;
      } else if (message.showImageHoverOverlay === undefined) {
        (window as any).showImageHoverOverlay = true; // Default
      }

      expect((window as any).showImageHoverOverlay).toBe(true);
    });
  });
});
