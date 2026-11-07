/**
 * Image source URL boundaries, filesystem destinations and SVG capabilities.
 * SVG signature sniffing is a bounded corruption guard, not XML validation.
 */

/** Split URL suffixes before decoding so `%23` and `%3F` remain filename characters. */
export function splitImageSource(source: string): { path: string; suffix: string } {
  const suffixIndex = source.search(/[?#]/);
  return suffixIndex < 0
    ? { path: source, suffix: '' }
    : { path: source.slice(0, suffixIndex), suffix: source.slice(suffixIndex) };
}

/** Encode one literal filename segment for Markdown destinations and quoted HTML. */
export function encodeImagePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Create a URL destination from a raw filesystem path, preserving separators and
 * Windows drive roots. Call only at filesystem-to-source boundaries, never on
 * an authored URL: literal `%23` filenames must become `%2523`, not a fragment.
 */
export function encodeImageFilePath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment, index) =>
      index === 0 && /^[a-z]:$/i.test(segment) ? segment : encodeImagePathSegment(segment)
    )
    .join('/');
}

/** Identify SVG from a source pathname, SVG data URI, or the supplied MIME type. */
export function isSvgImageSource(source: string, mimeType = ''): boolean {
  if (/^image\/svg\+xml(?:\s*;|\s*$)/i.test(mimeType.trim())) return true;
  if (/^data:image\/svg\+xml(?:[;,])/i.test(source)) return true;
  if (/^data:/i.test(source)) return false;
  const pathname = splitImageSource(source).path;
  try {
    return /\.svg$/i.test(decodeURIComponent(pathname));
  } catch {
    return /\.svg$/i.test(pathname);
  }
}

/**
 * Detect a root SVG after XML declarations, comments and a DOCTYPE. Work is
 * capped at 4,096 characters; callers reading bytes should bound decoding too.
 * This does not validate XML or make SVG safe to inject as live markup.
 */
export function hasSvgRootSignature(content: string): boolean {
  const text = content.slice(0, 4096);
  let index = text.startsWith('\ufeff') ? 1 : 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index++;
    if (text.startsWith('<?', index) || text.startsWith('<!--', index)) {
      const isComment = text.startsWith('<!--', index);
      const ending = isComment ? '-->' : '?>';
      const end = text.indexOf(ending, index + (isComment ? 4 : 2));
      if (end < 0) return false;
      index = end + ending.length;
      continue;
    }
    if (/^<!doctype\s/i.test(text.slice(index, index + 10))) {
      let depth = 0;
      let quote = '';
      let cursor = index + 9;
      for (; cursor < text.length; cursor++) {
        const char = text[cursor];
        if (quote) {
          if (char === quote) quote = '';
        } else if (char === '"' || char === "'") quote = char;
        else if (char === '[') depth++;
        else if (char === ']') depth = Math.max(0, depth - 1);
        else if (char === '>' && depth === 0) break;
      }
      if (cursor === text.length) return false;
      index = cursor + 1;
      continue;
    }
    return /^<svg(?:\s|\/?>)/i.test(text.slice(index));
  }
  return false;
}
