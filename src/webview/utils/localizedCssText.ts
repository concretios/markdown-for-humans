/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Text the stylesheet shows through `content:`.
 *
 * CSS cannot call the translation functions, so the translated text is
 * published as custom properties. `editor.css` reads them and keeps the
 * English text as its fallback.
 *
 * @module webview/utils/localizedCssText
 */

import * as l10n from '../l10n';

/**
 * Quote text as a CSS string.
 *
 * @param text - Plain text
 * @returns A double-quoted CSS string that renders as the same text
 */
export function toCssString(text: string): string {
  return `"${text.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ')}"`;
}

/**
 * Publish the translated stylesheet text on the document root.
 *
 * @param root - Element that carries the custom properties
 */
export function applyLocalizedCssText(root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--md4h-text-start-writing', toCssString(l10n.t('Start writing...')));
  root.style.setProperty('--md4h-text-drop-image', toCssString(l10n.t('Drop image here')));
}
