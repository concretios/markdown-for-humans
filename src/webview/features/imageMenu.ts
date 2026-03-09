/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Image Menu Component
 *
 * Provides a three-dots dropdown menu for image actions:
 * - Resize
 * - Rename
 * - Open In Finder/Explorer (local images only)
 * - Show In Workspace (local images only)
 */

import type { Editor } from '@tiptap/core';
import { showImageRenameDialog } from './imageRenameDialog';

// Track currently open menu to close on outside click
let currentOpenMenu: HTMLElement | null = null;

/**
 * Create the three-dots menu button
 */
export function createImageMenuButton(): HTMLButtonElement {
  const menuButton = document.createElement('button');
  menuButton.className = 'image-menu-button';
  menuButton.setAttribute('aria-label', 'Image options');
  menuButton.setAttribute('aria-haspopup', 'true');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.type = 'button';

  const iconSpan = document.createElement('span');
  iconSpan.className = 'codicon codicon-more toolbar-icon uses-codicon';
  iconSpan.setAttribute('aria-hidden', 'true');
  menuButton.appendChild(iconSpan);

  return menuButton;
}

/**
 * Create the dropdown menu element
 * @param isLocal - Whether the image is local (not external URL/data URI)
 */
export function createImageMenu(isLocal: boolean = true): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'image-context-menu';
  menu.setAttribute('role', 'menu');
  menu.style.display = 'none';

  // Build menu HTML
  let menuHTML = `
    <div class="menu-item" role="menuitem" tabindex="0" data-action="revert">
      <span class="codicon codicon-refresh menu-icon"></span>
      <span class="menu-label">Revert to original size</span>
    </div>
    <div class="menu-item" role="menuitem" tabindex="0" data-action="rename">
      <span class="codicon codicon-edit menu-icon"></span>
      <span class="menu-label">Rename</span>
    </div>
  `;

  // Only add file location options for local images
  if (isLocal) {
    menuHTML += `
      <div class="menu-separator"></div>
      <div class="menu-item" role="menuitem" tabindex="0" data-action="openInFinder">
        <span class="codicon codicon-folder-opened menu-icon"></span>
        <span class="menu-label">Open In Finder/Explorer</span>
      </div>
      <div class="menu-item" role="menuitem" tabindex="0" data-action="showInWorkspace">
        <span class="codicon codicon-list-tree menu-icon"></span>
        <span class="menu-label">Show In Workspace</span>
      </div>
    `;
  }

  menu.innerHTML = menuHTML;

  return menu;
}

/**
 * Position the menu relative to the button
 * Shows below button by default, above if near bottom of viewport
 */
function positionMenu(menu: HTMLElement, button: HTMLElement): void {
  const buttonRect = button.getBoundingClientRect();
  // Measure actual menu height (temporarily show it)
  const wasVisible = menu.style.display !== 'none';
  menu.style.display = 'block';
  menu.style.visibility = 'hidden';
  const menuHeight = menu.offsetHeight;
  menu.style.visibility = '';
  if (!wasVisible) {
    menu.style.display = 'none';
  }

  const viewportHeight = window.innerHeight;

  // Check if there's space below
  const spaceBelow = viewportHeight - buttonRect.bottom;

  if (spaceBelow < menuHeight + 8) {
    // Show above button
    menu.style.bottom = `${button.offsetHeight + 4}px`;
    menu.style.top = 'auto';
    menu.style.marginBottom = '0';
    menu.style.marginTop = '0';
  } else {
    // Show below button (default)
    menu.style.top = `${button.offsetHeight + 4}px`;
    menu.style.bottom = 'auto';
    menu.style.marginTop = '0';
    menu.style.marginBottom = '0';
  }
}

/**
 * Show the image menu dropdown
 */
export function showImageMenu(
  menu: HTMLElement,
  button: HTMLElement,
  img: HTMLImageElement,
  editor: Editor,
  vscodeApi: unknown
): void {
  // Close any other open menu first
  if (currentOpenMenu && currentOpenMenu !== menu) {
    hideImageMenu(currentOpenMenu);
  }

  positionMenu(menu, button);
  menu.style.display = 'block';
  button.setAttribute('aria-expanded', 'true');
  currentOpenMenu = menu;

  // Handle menu item clicks
  const handleMenuClick = (e: Event) => {
    // Stop propagation to prevent button toggle
    e.preventDefault();
    e.stopPropagation();

    const target = e.target as HTMLElement;
    const menuItem = target.closest('.menu-item') as HTMLElement;

    if (menuItem) {
      const action = menuItem.getAttribute('data-action');

      if (action === 'revert') {
        hideImageMenu(menu);
        // Clear width and height attributes
        editor.commands.updateAttributes('image', { width: null, height: null });
      } else if (action === 'rename') {
        hideImageMenu(menu);
        // Open rename dialog
        showImageRenameDialog(img, vscodeApi as any);
      } else if (action === 'openInFinder') {
        hideImageMenu(menu);
        // Get image path from data-markdown-src or src attribute
        const imagePath = img.getAttribute('data-markdown-src') || img.getAttribute('src') || '';
        if (imagePath && vscodeApi && typeof (vscodeApi as any).postMessage === 'function') {
          (vscodeApi as any).postMessage({
            type: 'revealImageInOS',
            imagePath: imagePath,
          });
        }
      } else if (action === 'showInWorkspace') {
        hideImageMenu(menu);
        // Get image path from data-markdown-src or src attribute
        const imagePath = img.getAttribute('data-markdown-src') || img.getAttribute('src') || '';
        if (imagePath && vscodeApi && typeof (vscodeApi as any).postMessage === 'function') {
          (vscodeApi as any).postMessage({
            type: 'revealImageInExplorer',
            imagePath: imagePath,
          });
        }
      }
    }
  };

  // Handle keyboard navigation
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      hideImageMenu(menu);
      button.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = menu.querySelectorAll('.menu-item');
      const currentIndex = Array.from(items).findIndex(item => item === document.activeElement);
      let nextIndex: number;

      if (e.key === 'ArrowDown') {
        nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
      } else {
        nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
      }

      (items[nextIndex] as HTMLElement).focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const focused = document.activeElement as HTMLElement;
      if (focused.classList.contains('menu-item')) {
        focused.click();
      }
    }
  };

  // Handle click outside to close
  const handleClickOutside = (e: MouseEvent) => {
    const target = e.target as Node;
    const wrapper = menu.closest('.image-wrapper');
    // Close if click is outside the wrapper or menu
    // Don't close if clicking the button (it will toggle)
    if (wrapper) {
      const clickedButton = (target as HTMLElement)?.closest('.image-menu-button');
      if (!wrapper.contains(target) || (clickedButton && clickedButton !== button)) {
        hideImageMenu(menu);
        // Only remove hover state if click is truly outside wrapper
        if (!wrapper.contains(target)) {
          wrapper.classList.remove('image-hover-active');
        }
      }
    }
  };

  // Store handlers for cleanup
  (menu as any)._handlers = {
    menuClick: handleMenuClick,
    keyDown: handleKeyDown,
    clickOutside: handleClickOutside,
  };

  menu.addEventListener('click', handleMenuClick);
  menu.addEventListener('keydown', handleKeyDown);
  document.addEventListener('click', handleClickOutside, { capture: true });

  // Focus first menu item
  const firstItem = menu.querySelector('.menu-item') as HTMLElement;
  if (firstItem) {
    firstItem.focus();
  }
}

/**
 * Hide the image menu dropdown
 */
export function hideImageMenu(menu: HTMLElement): void {
  menu.style.display = 'none';

  // Find associated button and update aria
  const wrapper = menu.closest('.image-wrapper');
  const button = wrapper?.querySelector('.image-menu-button');
  if (button) {
    button.setAttribute('aria-expanded', 'false');
  }

  // Clean up event handlers
  const handlers = (menu as any)._handlers;
  if (handlers) {
    menu.removeEventListener('click', handlers.menuClick);
    menu.removeEventListener('keydown', handlers.keyDown);
    document.removeEventListener('click', handlers.clickOutside, { capture: true });
    delete (menu as any)._handlers;
  }

  if (currentOpenMenu === menu) {
    currentOpenMenu = null;
  }
}

/**
 * Check if an image is external (http/https/data URI)
 * External images should have limited menu options
 */
export function isExternalImage(src: string): boolean {
  return src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:');
}
