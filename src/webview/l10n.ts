/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Translation lookup for webview UI text.
 *
 * Import as `import * as l10n from '../l10n'` and call `l10n.t('English text')`,
 * the same shape as `vscode.l10n.t` in the extension host. Without a bundle, or
 * without an entry for a message, the English text is returned.
 *
 * @module webview/l10n
 */

import {
  L10N_BUNDLE_ATTRIBUTE,
  escapeHtmlText,
  formatL10n,
  l10nKey,
  parseL10nBundle,
  type L10nArgument,
  type L10nBundle,
  type L10nMessageOptions,
} from '../shared/l10n';

let bundle: L10nBundle | undefined;

/**
 * Use the given translations instead of the ones rendered by the host.
 *
 * @param contents - Translated text keyed by its English source
 */
export function configureL10n(contents: L10nBundle): void {
  bundle = parseL10nBundle(JSON.stringify(contents));
}

/** Forget the loaded translations so the next lookup reads them from the host again. */
export function resetL10n(): void {
  bundle = undefined;
}

/**
 * Translate a UI message.
 *
 * @param message - English source text, or options carrying a translator comment.
 *   Must be a string literal so it can be extracted.
 * @param args - Values for `{0}`, `{1}` placeholders
 * @returns The translation for the display language, or the English text
 */
export function t(message: string, ...args: L10nArgument[]): string;
export function t(options: L10nMessageOptions): string;
export function t(message: string | L10nMessageOptions, ...args: L10nArgument[]): string {
  // Read lazily: the host renders the bundle on <body> before any UI is built.
  // A worker has no document; text produced there stays English.
  bundle ??= parseL10nBundle(
    typeof document === 'undefined' ? undefined : document.body?.getAttribute(L10N_BUNDLE_ATTRIBUTE)
  );
  if (typeof message === 'string') return formatL10n(bundle[message] || message, args);
  const translation = bundle[l10nKey(message.message, message.comment)];
  return formatL10n(translation || message.message, message.args ?? []);
}

/**
 * Translate a UI message for insertion into an HTML template.
 *
 * The whole result is escaped, arguments included, so neither a translation nor
 * a file name can add markup. To wrap part of a sentence in markup, leave its
 * placeholder without an argument and replace it afterwards:
 * `l10n.html('Add {0} to see the outline').replace('{0}', '<code># Heading</code>')`.
 *
 * @param message - English source text, or options carrying a translator comment
 * @param args - Values for `{0}`, `{1}` placeholders
 * @returns Escaped text, safe inside markup and quoted attributes
 */
export function html(message: string, ...args: L10nArgument[]): string;
export function html(options: L10nMessageOptions): string;
export function html(message: string | L10nMessageOptions, ...args: L10nArgument[]): string {
  return escapeHtmlText(typeof message === 'string' ? t(message, ...args) : t(message));
}

/**
 * Format a number for display in the display language.
 *
 * @param value - The number to show
 * @param fractionDigits - Digits after the decimal mark
 * @returns The number with that language's decimal mark and no digit grouping
 */
export function formatNumber(value: number, fractionDigits = 0): string {
  const language = (typeof document !== 'undefined' && document.documentElement.lang) || 'en-US';
  try {
    return value.toLocaleString(language, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
      useGrouping: false,
    });
  } catch {
    // The host passes VS Code's language id through; an id the runtime rejects must not break the UI.
    return value.toFixed(fractionDigits);
  }
}
