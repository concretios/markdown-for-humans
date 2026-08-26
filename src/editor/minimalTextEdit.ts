/**
 * @file minimalTextEdit.ts - Safe single-range text replacement
 * @description Computes one UTF-16 replacement while preserving CRLF and
 *              surrogate-pair boundaries for VS Code WorkspaceEdits.
 */

/** One UTF-16 offset replacement that transforms a source string into a target. */
export interface MinimalTextReplacement {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function splitsSurrogatePair(value: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < value.length &&
    isHighSurrogate(value.charCodeAt(offset - 1)) &&
    isLowSurrogate(value.charCodeAt(offset))
  );
}

function splitsCrLf(value: string, offset: number): boolean {
  return (
    offset > 0 && offset < value.length && value[offset - 1] === '\r' && value[offset] === '\n'
  );
}

function isSafeBoundary(value: string, offset: number): boolean {
  return !splitsSurrogatePair(value, offset) && !splitsCrLf(value, offset);
}

/**
 * Compute the smallest single replacement bounded by shared prefix and suffix.
 *
 * JavaScript and VS Code offsets are both UTF-16 based, but a Range cannot
 * safely begin inside a surrogate pair or CRLF delimiter. Boundaries expand by
 * at most one code unit when necessary, preserving exact target bytes while
 * retaining the largest safe unchanged prefix and suffix.
 */
export function computeMinimalTextReplacement(
  source: string,
  target: string
): MinimalTextReplacement | null {
  if (source === target) return null;

  const sharedLimit = Math.min(source.length, target.length);
  let startOffset = 0;
  while (startOffset < sharedLimit && source[startOffset] === target[startOffset]) {
    startOffset += 1;
  }
  while (
    startOffset > 0 &&
    (!isSafeBoundary(source, startOffset) || !isSafeBoundary(target, startOffset))
  ) {
    startOffset -= 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < source.length - startOffset &&
    suffixLength < target.length - startOffset &&
    source[source.length - suffixLength - 1] === target[target.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }
  while (
    suffixLength > 0 &&
    (!isSafeBoundary(source, source.length - suffixLength) ||
      !isSafeBoundary(target, target.length - suffixLength))
  ) {
    suffixLength -= 1;
  }

  return {
    startOffset,
    endOffset: source.length - suffixLength,
    text: target.slice(startOffset, target.length - suffixLength),
  };
}
