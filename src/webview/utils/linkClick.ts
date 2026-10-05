/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Whether a click on a link should follow it.
 *
 * A link in the editor is also text the user edits, so a plain click only places
 * the caret. Cmd+click (macOS) or Ctrl+click (Windows, Linux) follows the link,
 * the same convention VS Code uses for links in source files.
 */
export function shouldOpenLinkFromClick(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>): boolean {
  return event.metaKey || event.ctrlKey;
}
