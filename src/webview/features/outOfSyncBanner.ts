/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Persistent in-webview notice for a rich editor that stopped
 * reconciling with its document (post-merge 03, Y2). The VS Code notification
 * can be dismissed or missed; this banner stays until sync recovers or the user
 * reloads the editor. It never takes focus, so typing cannot trigger the reload.
 */

let banner: HTMLElement | null = null;

/**
 * Show the out-of-sync banner. Repeated calls keep the single existing banner.
 *
 * @param onReload - Asks the host for a fresh renderer (same path as the
 *   notification's Reload Editor action)
 */
export function showOutOfSyncBanner(onReload: () => void): void {
  if (banner) return;
  banner = document.createElement('section');
  banner.className = 'out-of-sync-banner';
  banner.setAttribute('role', 'alert');
  const message = document.createElement('span');
  message.className = 'out-of-sync-banner-message';
  message.textContent =
    'This editor is out of sync with the file, and its edits are not being saved.';
  const reloadButton = document.createElement('button');
  reloadButton.type = 'button';
  reloadButton.className = 'out-of-sync-banner-action';
  reloadButton.textContent = 'Reload editor';
  reloadButton.addEventListener('click', onReload);
  banner.append(message, reloadButton);
  document.body.append(banner);
}

/** Remove the banner once this renderer is back in sync. Safe when none is shown. */
export function hideOutOfSyncBanner(): void {
  banner?.remove();
  banner = null;
}
