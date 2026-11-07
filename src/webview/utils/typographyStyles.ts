/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Applies reader typography settings to the page as CSS custom
 * properties. `editor.css` reads each one with today's value as its fallback,
 * so a removed property restores the built-in look.
 */

import { normalizeTypographySettings } from '../../shared/typographySettings';

/** The part of an element this module writes to. */
interface StyleTarget {
  readonly style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>;
}

/**
 * Sets or removes the `--md-*` typography properties on `target`.
 *
 * `value` is an untrusted host message field and is validated here. Each
 * setting becomes the value of exactly one custom property through
 * `style.setProperty`; nothing is ever written into a stylesheet or markup.
 *
 * @param target Element that carries the properties (the document root).
 * @param value The `typography` field of an `update` or `settingsUpdate` message.
 */
export function applyTypographySettings(target: StyleTarget, value: unknown): void {
  const settings = normalizeTypographySettings(value);
  const withUnit = (amount: number | null, unit: string) =>
    amount === null ? null : `${amount}${unit}`;
  const readerSpacing = settings.letterSpacing !== null || settings.wordSpacing !== null;

  const properties: Array<[name: string, value: string | null]> = [
    [
      '--md-font-family',
      // A font that is not installed falls back to the font the editor uses today.
      settings.fontFamily === null ? null : `${settings.fontFamily}, var(--vscode-font-family)`,
    ],
    ['--md-font-weight', withUnit(settings.fontWeight, '')],
    ['--md-editor-font-size', withUnit(settings.fontSize, 'px')],
    ['--md-line-height', withUnit(settings.lineHeight, '')],
    ['--md-letter-spacing', withUnit(settings.letterSpacing, 'em')],
    ['--md-word-spacing', withUnit(settings.wordSpacing, 'em')],
    // Code and math inherit spacing as before until the reader changes it, then keep their own.
    ['--md-code-text-spacing', readerSpacing ? 'normal' : null],
  ];

  for (const [name, propertyValue] of properties) {
    if (propertyValue === null) target.style.removeProperty(name);
    else target.style.setProperty(name, propertyValue);
  }
}
