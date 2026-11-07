/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * @fileoverview Reader typography settings (`markdownForHumans.font.*`) shared
 * by the extension host and the webview.
 *
 * The host resolves user settings into a {@link TypographySettings} value and
 * posts it; the webview validates it again before applying it as CSS custom
 * properties. `null` always means "no override": the stylesheet keeps the value
 * it had before these settings existed.
 */

/** Resolved reader typography. Every field is `null` when it is not overridden. */
export interface TypographySettings {
  /** CSS font-family list made only of quoted names and generic keywords. */
  readonly fontFamily: string | null;
  /** CSS font weight, 100 to 900. */
  readonly fontWeight: number | null;
  /** Base font size in pixels, set only by the VS Code editor font opt-in. */
  readonly fontSize: number | null;
  /** Line height as a multiple of the font size. */
  readonly lineHeight: number | null;
  /** Letter spacing in em. */
  readonly letterSpacing: number | null;
  /** Word spacing in em. */
  readonly wordSpacing: number | null;
}

/** Setting values as read from configuration, before validation. */
export interface RawTypographyConfig {
  readonly family?: unknown;
  readonly weight?: unknown;
  readonly lineHeight?: unknown;
  readonly letterSpacing?: unknown;
  readonly wordSpacing?: unknown;
  /** `editor.font*` values for Markdown; present only when the reader opted in. */
  readonly editorFont?: {
    readonly family?: unknown;
    readonly weight?: unknown;
    readonly size?: unknown;
  };
}

/** Built-in values. A setting equal to its default resolves to `null`. */
const DEFAULT_FONT_WEIGHT = 400;
const DEFAULT_LINE_HEIGHT = 1.58;

const MAX_FONT_FAMILY_LENGTH = 1024;
const MAX_FONT_FAMILIES = 16;

/** CSS generic font families. Only these may appear unquoted. */
const GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

/**
 * Turns a user-supplied CSS font-family list into one that contains only
 * double-quoted family names and generic keywords.
 *
 * The value comes from user settings and ends up in CSS, so it is parsed and
 * written back rather than filtered: whatever the input holds (`;`, `}`,
 * `url(`, markup), each entry can only become the text of one quoted string.
 * The function is idempotent, so the webview can run it on a value the host
 * already normalized.
 *
 * @returns The safe list, or `null` when the value is not a usable string.
 */
export function normalizeFontFamily(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_FONT_FAMILY_LENGTH) return null;

  const families: string[] = [];
  let name = '';
  let quote: string | null = null;
  let wasQuoted = false;

  const finishFamily = () => {
    // eslint-disable-next-line no-control-regex
    const cleaned = name.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
    const keyword = cleaned.toLowerCase();
    if (cleaned && !wasQuoted && GENERIC_FONT_FAMILIES.has(keyword)) {
      families.push(keyword);
    } else if (cleaned) {
      families.push(`"${cleaned.replace(/[\\"]/g, '\\$&')}"`);
    }
    name = '';
    wasQuoted = false;
  };

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\') {
      // A backslash keeps the next character as plain text, inside or outside quotes.
      index += 1;
      if (index < value.length) name += value[index];
    } else if (quote) {
      if (char === quote) quote = null;
      else name += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      wasQuoted = true;
    } else if (char === ',') {
      finishFamily();
    } else {
      name += char;
    }
  }
  finishFamily();

  return families.length > 0 ? families.slice(0, MAX_FONT_FAMILIES).join(', ') : null;
}

/** A finite number clamped to `[minimum, maximum]`, or `null` for anything else. */
function clampNumber(value: unknown, minimum: number, maximum: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(maximum, Math.max(minimum, Math.round(value * 1000) / 1000));
}

const clampFontWeight = (value: unknown): number | null => {
  const weight = clampNumber(value, 100, 900);
  return weight === null ? null : Math.round(weight);
};
const clampFontSize = (value: unknown) => clampNumber(value, 6, 100);
const clampLineHeight = (value: unknown) => clampNumber(value, 1, 3);
const clampLetterSpacing = (value: unknown) => clampNumber(value, 0, 0.5);
const clampWordSpacing = (value: unknown) => clampNumber(value, 0, 1);

/** `editor.fontWeight` is "normal", "bold" or a number that may be a string. */
function parseEditorFontWeight(value: unknown): number | null {
  if (value === 'normal') return DEFAULT_FONT_WEIGHT;
  if (value === 'bold') return 700;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return clampFontWeight(+value);
  return clampFontWeight(value);
}

const unlessDefault = (value: number | null, defaultValue: number) =>
  value === defaultValue ? null : value;

/**
 * Validates a typography value at a trust boundary (the webview receiving a
 * host message). Numbers are clamped to their allowed ranges, anything of the
 * wrong type becomes `null`, and the font family is normalized again.
 */
export function normalizeTypographySettings(value: unknown): TypographySettings {
  const fields = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    fontFamily: normalizeFontFamily(fields.fontFamily),
    fontWeight: clampFontWeight(fields.fontWeight),
    fontSize: clampFontSize(fields.fontSize),
    lineHeight: clampLineHeight(fields.lineHeight),
    letterSpacing: clampLetterSpacing(fields.letterSpacing),
    wordSpacing: clampWordSpacing(fields.wordSpacing),
  };
}

/**
 * Resolves configuration into the typography to apply.
 *
 * A setting left at its default resolves to `null`, so an untouched
 * installation overrides nothing. When the reader opted into the VS Code editor
 * font, `markdownForHumans.font.family` and `.weight` still win once they are
 * changed from their defaults.
 */
export function resolveTypographySettings(config: RawTypographyConfig): TypographySettings {
  const editorFont = config.editorFont;
  return {
    fontFamily: normalizeFontFamily(config.family) ?? normalizeFontFamily(editorFont?.family),
    fontWeight:
      unlessDefault(clampFontWeight(config.weight), DEFAULT_FONT_WEIGHT) ??
      unlessDefault(parseEditorFontWeight(editorFont?.weight), DEFAULT_FONT_WEIGHT),
    fontSize: clampFontSize(editorFont?.size),
    lineHeight: unlessDefault(clampLineHeight(config.lineHeight), DEFAULT_LINE_HEIGHT),
    letterSpacing: unlessDefault(clampLetterSpacing(config.letterSpacing), 0),
    wordSpacing: unlessDefault(clampWordSpacing(config.wordSpacing), 0),
  };
}
