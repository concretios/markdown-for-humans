/**
 * Copyright (c) 2025-2026 Concret.io
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Fence-info helpers that separate language lookup from authored metadata.
 */

/**
 * Read the first fence token without normalizing its metadata suffix.
 *
 * The document attribute remains the original info string. This lowercase token is
 * only for grammar lookup and menu state; aliases are resolved by languageRegistry.
 *
 * @param info - Persisted code-block language attribute, including optional metadata.
 * @returns Lowercase first token and the exact whitespace/metadata following it.
 */
export function parseFenceInfo(info: unknown): { language: string; suffix: string } {
  if (typeof info !== 'string') return { language: '', suffix: '' };
  const match = /^\s*(\S+)([\s\S]*)$/.exec(info);
  return match
    ? { language: match[1].toLowerCase(), suffix: match[2] }
    : { language: '', suffix: '' };
}

/**
 * Replace only the language token when the user explicitly chooses a language.
 *
 * @param info - Current fence info, including authored metadata.
 * @param newLanguage - Language selected by the menu.
 * @returns New language token followed by the unchanged metadata suffix.
 */
export function replaceFenceLanguage(info: unknown, newLanguage: string): string {
  return newLanguage + parseFenceInfo(info).suffix;
}
