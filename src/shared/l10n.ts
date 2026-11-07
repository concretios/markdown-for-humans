/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Translation helpers shared by the extension host and the webview.
 *
 * Messages use the `vscode.l10n` convention: the English text is the lookup key
 * and `{0}`, `{1}` mark arguments. The host hands the bundle VS Code loaded for
 * the display language to the webview as one attribute on `<body>`.
 *
 * @module shared/l10n
 */

/** Translated text keyed by its English source. */
export type L10nBundle = Readonly<Record<string, string>>;

/** A value that can replace a `{n}` placeholder. */
export type L10nArgument = string | number | boolean;

/** A message that needs a note for translators, same shape as `vscode.l10n.t` options. */
export interface L10nMessageOptions {
  message: string;
  args?: readonly L10nArgument[];
  /** Context for translators. Also separates identical English words with different meanings. */
  comment: string | readonly string[];
}

/** `<body>` attribute carrying the bundle from the extension host to the webview. */
export const L10N_BUNDLE_ATTRIBUTE = 'data-l10n-bundle';

/**
 * Replace `{0}`, `{1}` placeholders with their arguments.
 *
 * A placeholder without an argument is kept as written. Text inserted from an
 * argument is never scanned again.
 *
 * @param message - English source or its translation
 * @param args - Values for the indexed placeholders
 * @returns The message with its arguments filled in
 */
export function formatL10n(message: string, args: readonly L10nArgument[]): string {
  if (args.length === 0) return message;
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? placeholder : String(value);
  });
}

/**
 * Bundle key of a message, matching the key VS Code builds for `vscode.l10n.t`.
 *
 * @param message - English source text
 * @param comment - Translator note; part of the key when present
 * @returns `message`, or `message/comment` when a comment is given
 */
export function l10nKey(message: string, comment?: string | readonly string[]): string {
  const note = typeof comment === 'string' ? comment : (comment ?? []).join('');
  return note ? `${message}/${note}` : message;
}

/**
 * Escape text for use inside HTML markup or a quoted attribute.
 *
 * @param text - Plain text, for example a translated message
 * @returns Text that an HTML parser reads back as the same characters
 */
export function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Parse a serialized bundle, keeping only string translations.
 *
 * @param serialized - JSON text of a flat message map
 * @returns The bundle, or an empty one when the input is missing or malformed
 */
export function parseL10nBundle(serialized: string | null | undefined): L10nBundle {
  const bundle: Record<string, string> = Object.create(null);
  if (!serialized) return bundle;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return bundle;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return bundle;
  for (const [message, translation] of Object.entries(parsed)) {
    if (typeof translation === 'string') bundle[message] = translation;
  }
  return bundle;
}

/**
 * Render the bundle as an HTML attribute for the webview `<body>`.
 *
 * @param bundle - `vscode.l10n.bundle`; undefined when VS Code runs in English
 * @returns The attribute with a leading space, or an empty string without translations
 */
export function renderL10nBundleAttribute(bundle: L10nBundle | undefined): string {
  if (!bundle || Object.keys(bundle).length === 0) return '';
  return ` ${L10N_BUNDLE_ATTRIBUTE}="${escapeHtmlText(JSON.stringify(bundle))}"`;
}
