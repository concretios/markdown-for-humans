/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * @file documentExport.ts - PDF and Word document export
 * @description Handles exporting markdown documents to PDF (via local Chrome) and Word (via docx).
 * Applies export theme settings, embeds Mermaid diagrams as high-quality images,
 * and reads dimensions from a small, bounded set of explicitly supported formats.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';
import * as cheerio from 'cheerio';

type SafeDimensionImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'ico' | 'svg';

const SAFE_DIMENSION_IMAGE_EXTENSIONS: Readonly<Record<string, SafeDimensionImageFormat>> = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.gif': 'gif',
  '.webp': 'webp',
  '.bmp': 'bmp',
  '.ico': 'ico',
  '.svg': 'svg',
};

const SAFE_DIMENSION_IMAGE_MEDIA_TYPES: Readonly<Record<string, SafeDimensionImageFormat>> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/vnd.microsoft.icon': 'ico',
  'image/x-icon': 'ico',
  'image/svg+xml': 'svg',
};

/**
 * Resolve an allowlisted image format from a local path, URI, or data URL.
 *
 * Query strings and fragments are ignored for extension checks, and both
 * extensions and media types are matched case-insensitively.
 *
 * @param source - Original image source used by the Word export pipeline
 * @returns The allowlisted format, or undefined for an unsupported source
 */
function getSafeDimensionImageFormat(source: string): SafeDimensionImageFormat | undefined {
  const normalizedSource = source.trim();
  const dataUrlMatch = /^data:([^;,]+)/i.exec(normalizedSource);
  if (dataUrlMatch) {
    return SAFE_DIMENSION_IMAGE_MEDIA_TYPES[dataUrlMatch[1].toLowerCase()];
  }

  const pathWithoutQueryOrFragment = normalizedSource.split(/[?#]/, 1)[0];
  const extension = path.extname(pathWithoutQueryOrFragment).toLowerCase();
  return SAFE_DIMENSION_IMAGE_EXTENSIONS[extension];
}

/**
 * Identify one of the seven image signatures approved for synchronous sizing.
 *
 * @param data - Image bytes to inspect without parsing
 * @returns The detected allowlisted format, or undefined for any other signature
 */
function getSafeDimensionImageSignature(data: Uint8Array): SafeDimensionImageFormat | undefined {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return 'png';
  }

  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'jpeg';
  }

  if (
    data.length >= 6 &&
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38 &&
    (data[4] === 0x37 || data[4] === 0x39) &&
    data[5] === 0x61
  ) {
    return 'gif';
  }

  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'webp';
  }

  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
    return 'bmp';
  }

  // Reserved (LE16) = 0, type (LE16) = 1. Type 2 is the CUR cursor format,
  // which shares this exact header shape and must not be parsed as ICO.
  if (
    data.length >= 4 &&
    data[0] === 0x00 &&
    data[1] === 0x00 &&
    data[2] === 0x01 &&
    data[3] === 0x00
  ) {
    return 'ico';
  }

  if (getSvgSignatureSlice(data) !== undefined) {
    return 'svg';
  }

  return undefined;
}

/**
 * Check whether image bytes may be passed to the bounded dimension reader.
 *
 * The source must name an explicitly supported format and the bytes must carry
 * that format's signature. Checking both prevents a vulnerable ICNS, JXL, or
 * HEIF payload from reaching the parser after being renamed with a safe suffix.
 *
 * @param source - Original image source used by the Word export pipeline
 * @param data - Image bytes to inspect
 * @returns True only for matching PNG, JPEG, GIF, WebP, BMP, ICO, or SVG inputs
 */
export function isSafeForImageDimensionParsing(source: string, data: Uint8Array): boolean {
  const sourceFormat = getSafeDimensionImageFormat(source);
  return sourceFormat !== undefined && sourceFormat === getSafeDimensionImageSignature(data);
}

const MAX_JPEG_HEADER_SCAN_BYTES = 1024 * 1024;
const MAX_JPEG_MARKERS = 4096;
const MAX_EXPORT_IMAGE_DIMENSION = 0xffff;

interface ExportImageDimensions {
  width: number;
  height: number;
}

/**
 * Read an unsigned 16-bit big-endian integer from a validated offset.
 *
 * @param data - Source bytes
 * @param offset - Validated byte offset
 * @returns Decoded integer
 */
function readBigEndian16(data: Uint8Array, offset: number): number {
  return data[offset] * 0x100 + data[offset + 1];
}

/**
 * Read an unsigned 32-bit big-endian integer from a validated offset.
 *
 * @param data - Source bytes
 * @param offset - Validated byte offset
 * @returns Decoded integer
 */
function readBigEndian32(data: Uint8Array, offset: number): number {
  return (
    data[offset] * 0x1000000 +
    data[offset + 1] * 0x10000 +
    data[offset + 2] * 0x100 +
    data[offset + 3]
  );
}

/**
 * Read an unsigned 16-bit little-endian integer from a validated offset.
 *
 * @param data - Source bytes
 * @param offset - Validated byte offset
 * @returns Decoded integer
 */
function readLittleEndian16(data: Uint8Array, offset: number): number {
  return data[offset] + data[offset + 1] * 0x100;
}

/**
 * Read an unsigned 24-bit little-endian integer from a validated offset.
 *
 * @param data - Source bytes
 * @param offset - Validated byte offset
 * @returns Decoded integer
 */
function readLittleEndian24(data: Uint8Array, offset: number): number {
  return data[offset] + data[offset + 1] * 0x100 + data[offset + 2] * 0x10000;
}

/**
 * Read an unsigned 32-bit little-endian integer from a validated offset.
 *
 * @param data - Source bytes
 * @param offset - Validated byte offset
 * @returns Decoded integer
 */
function readLittleEndian32(data: Uint8Array, offset: number): number {
  return (
    data[offset] +
    data[offset + 1] * 0x100 +
    data[offset + 2] * 0x10000 +
    data[offset + 3] * 0x1000000
  );
}

/**
 * Return dimensions only when both values are non-zero and practical for DOCX.
 *
 * @param width - Parsed image width
 * @param height - Parsed image height
 * @returns Valid dimensions, or undefined for a malformed zero dimension
 */
function validDimensions(width: number, height: number): ExportImageDimensions | undefined {
  return width > 0 &&
    height > 0 &&
    width <= MAX_EXPORT_IMAGE_DIMENSION &&
    height <= MAX_EXPORT_IMAGE_DIMENSION
    ? { width, height }
    : undefined;
}

/**
 * Read PNG dimensions from the fixed IHDR location.
 *
 * @param data - Signature-validated PNG bytes
 * @returns Dimensions, or undefined for a truncated or malformed IHDR
 */
function readPngDimensions(data: Uint8Array): ExportImageDimensions | undefined {
  const minimumPngHeaderLength = 33;
  if (
    data.length < minimumPngHeaderLength ||
    readBigEndian32(data, 8) !== 13 ||
    data[12] !== 0x49 ||
    data[13] !== 0x48 ||
    data[14] !== 0x44 ||
    data[15] !== 0x52
  ) {
    return undefined;
  }

  return validDimensions(readBigEndian32(data, 16), readBigEndian32(data, 20));
}

/**
 * Read GIF logical-screen dimensions from the fixed header.
 *
 * @param data - Signature-validated GIF bytes
 * @returns Dimensions, or undefined for a truncated header
 */
function readGifDimensions(data: Uint8Array): ExportImageDimensions | undefined {
  if (data.length < 13) {
    return undefined;
  }

  return validDimensions(readLittleEndian16(data, 6), readLittleEndian16(data, 8));
}

/**
 * Check whether a JPEG marker carries a start-of-frame segment.
 *
 * @param marker - JPEG marker byte
 * @returns True for baseline, progressive, differential, or lossless frame markers
 */
function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Read JPEG dimensions with explicit byte and marker limits.
 *
 * Every loop either advances the cursor or consumes one of the fixed marker
 * budget entries. Segment lengths below two and out-of-bounds jumps terminate
 * immediately, preventing zero-length segment loops.
 *
 * @param data - Signature-validated JPEG bytes
 * @returns Dimensions, or undefined for a malformed or over-budget header
 */
function readJpegDimensions(data: Uint8Array): ExportImageDimensions | undefined {
  if (data.length < 4) {
    return undefined;
  }

  const scanLimit = Math.min(data.length, MAX_JPEG_HEADER_SCAN_BYTES);
  let offset = 2;

  for (let markerCount = 0; markerCount < MAX_JPEG_MARKERS && offset < scanLimit; markerCount++) {
    if (data[offset] !== 0xff) {
      return undefined;
    }

    while (offset < scanLimit && data[offset] === 0xff) {
      offset++;
    }
    if (offset >= scanLimit) {
      return undefined;
    }

    const marker = data[offset++];
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) {
      return undefined;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (offset + 2 > scanLimit) {
      return undefined;
    }

    const segmentLength = readBigEndian16(data, offset);
    if (segmentLength < 2) {
      return undefined;
    }

    const segmentEnd = offset + segmentLength;
    if (segmentEnd > scanLimit || segmentEnd > data.length) {
      return undefined;
    }

    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 11) {
        return undefined;
      }
      return validDimensions(readBigEndian16(data, offset + 5), readBigEndian16(data, offset + 3));
    }

    offset = segmentEnd;
  }

  return undefined;
}

/**
 * Check four bytes against an ASCII chunk identifier.
 *
 * @param data - Source bytes
 * @param offset - Validated byte offset
 * @param value - Four-character ASCII identifier
 * @returns True when the bytes match
 */
function hasAsciiFourCc(data: Uint8Array, offset: number, value: string): boolean {
  return (
    data[offset] === value.charCodeAt(0) &&
    data[offset + 1] === value.charCodeAt(1) &&
    data[offset + 2] === value.charCodeAt(2) &&
    data[offset + 3] === value.charCodeAt(3)
  );
}

/**
 * Read dimensions from the first VP8, VP8L, or VP8X WebP header.
 *
 * @param data - Signature-validated WebP bytes
 * @returns Dimensions, or undefined for invalid RIFF/chunk bounds or payloads
 */
function readWebpDimensions(data: Uint8Array): ExportImageDimensions | undefined {
  if (data.length < 20) {
    return undefined;
  }

  const declaredFileEnd = readLittleEndian32(data, 4) + 8;
  const chunkLength = readLittleEndian32(data, 16);
  const chunkEnd = 20 + chunkLength;
  if (declaredFileEnd < 20 || declaredFileEnd > data.length || chunkEnd > declaredFileEnd) {
    return undefined;
  }

  if (hasAsciiFourCc(data, 12, 'VP8 ')) {
    if (
      chunkLength < 10 ||
      (data[20] & 0x01) !== 0 ||
      data[23] !== 0x9d ||
      data[24] !== 0x01 ||
      data[25] !== 0x2a
    ) {
      return undefined;
    }
    return validDimensions(
      readLittleEndian16(data, 26) & 0x3fff,
      readLittleEndian16(data, 28) & 0x3fff
    );
  }

  if (hasAsciiFourCc(data, 12, 'VP8L')) {
    if (chunkLength < 5 || data[20] !== 0x2f || (data[24] & 0xe0) !== 0) {
      return undefined;
    }
    const width = 1 + data[21] + ((data[22] & 0x3f) << 8);
    const height = 1 + ((data[22] & 0xc0) >> 6) + (data[23] << 2) + ((data[24] & 0x0f) << 10);
    return validDimensions(width, height);
  }

  if (hasAsciiFourCc(data, 12, 'VP8X')) {
    if (chunkLength < 10) {
      return undefined;
    }
    return validDimensions(readLittleEndian24(data, 24) + 1, readLittleEndian24(data, 27) + 1);
  }

  return undefined;
}

/**
 * Read BMP dimensions using the DIB header size to select a layout.
 *
 * BITMAPCOREHEADER (size 12) stores unsigned LE16 width/height. BITMAPINFOHEADER
 * and later (size >= 40, e.g. V4/V5) store signed LE32 width/height, where a
 * negative height is purely a top-down storage-order flag rather than a real
 * negative size. Any other DIB header size is rejected rather than guessed.
 *
 * @param data - Signature-validated BMP bytes
 * @returns Dimensions, or undefined for a truncated header, an unrecognized DIB
 *   header size, or a declared DIB header size that doesn't fit within `data`
 */
function readBmpDimensions(data: Uint8Array): ExportImageDimensions | undefined {
  const dibHeaderSizeFieldEnd = 18; // DIB header size is a LE32 at offset 14
  if (data.length < dibHeaderSizeFieldEnd) {
    return undefined;
  }

  const dibHeaderSize = readLittleEndian32(data, 14);
  if (data.length < 14 + dibHeaderSize) {
    return undefined;
  }

  if (dibHeaderSize === 12) {
    return validDimensions(readLittleEndian16(data, 18), readLittleEndian16(data, 20));
  }

  if (dibHeaderSize >= 40) {
    const rawWidth = readLittleEndian32(data, 18);
    const width = rawWidth >= 0x80000000 ? rawWidth - 0x100000000 : rawWidth;
    const rawHeight = readLittleEndian32(data, 22);
    const height = rawHeight >= 0x80000000 ? rawHeight - 0x100000000 : rawHeight;
    return validDimensions(width, Math.abs(height));
  }

  return undefined;
}

/**
 * Read dimensions from the first ICONDIRENTRY of an ICO file.
 *
 * The 6-byte ICONDIR header is followed by one or more 16-byte ICONDIRENTRY
 * records; the first record's width and height are single bytes at offsets 6
 * and 7. A raw byte value of 0 in either field means 256, since a single byte
 * cannot otherwise represent that value.
 *
 * @param data - Signature-validated ICO bytes
 * @returns Dimensions, or undefined for a truncated header or zero icon entries
 */
function readIcoDimensions(data: Uint8Array): ExportImageDimensions | undefined {
  const minimumIcoHeaderLength = 22; // 6-byte ICONDIR + first 16-byte ICONDIRENTRY
  if (data.length < minimumIcoHeaderLength) {
    return undefined;
  }

  const entryCount = readLittleEndian16(data, 4);
  if (entryCount === 0) {
    return undefined;
  }

  const rawWidth = data[6];
  const rawHeight = data[7];
  return validDimensions(rawWidth === 0 ? 256 : rawWidth, rawHeight === 0 ? 256 : rawHeight);
}

const MAX_SVG_SIGNATURE_SCAN_BYTES = 4096;
const SVG_ROOT_TAG_PATTERN_ANCHORED = /^<svg[\s>]/i;

/**
 * Advance an index past an optional UTF-8 BOM, whitespace, an `<?xml ... ?>`
 * declaration, XML comments, and a `<!DOCTYPE ...>` declaration (in any
 * order/repetition), so the caller can check what tag comes next. Each step
 * either returns or strictly advances the index, so this always terminates
 * within the scanned slice with no backtracking-prone patterns.
 *
 * @param slice - Bounded decoded text to scan
 * @returns The index of the next real tag, or -1 if a prolog element never closes
 */
function skipSvgProlog(slice: string): number {
  let index = slice.startsWith('\ufeff') ? 1 : 0;

  for (;;) {
    while (index < slice.length && /\s/.test(slice[index])) {
      index++;
    }

    if (slice.startsWith('<?', index)) {
      const end = slice.indexOf('?>', index + 2);
      if (end === -1) {
        return -1;
      }
      index = end + 2;
      continue;
    }

    if (slice.startsWith('<!--', index)) {
      const end = slice.indexOf('-->', index + 4);
      if (end === -1) {
        return -1;
      }
      index = end + 3;
      continue;
    }

    if (/^<!doctype/i.test(slice.slice(index, index + 9))) {
      // Bounded bracket-depth scan so an internal subset (`<!DOCTYPE svg [ ... ]>`)
      // doesn't end the declaration at a `>` inside its `[...]` block.
      let cursor = index + 9;
      let bracketDepth = 0;
      let closed = false;
      while (cursor < slice.length) {
        const char = slice[cursor];
        if (char === '[') {
          bracketDepth++;
        } else if (char === ']') {
          bracketDepth = Math.max(0, bracketDepth - 1);
        } else if (char === '>' && bracketDepth === 0) {
          closed = true;
          break;
        }
        cursor++;
      }
      if (!closed) {
        return -1;
      }
      index = cursor + 1;
      continue;
    }

    return index;
  }
}

/**
 * Decode the first 4,096 bytes of a candidate image and check that, after
 * skipping the document prolog (BOM, whitespace, XML declaration, comments,
 * DOCTYPE), the next tag is a root `<svg>`. Used identically by the
 * signature gate and the dimension reader so the two can never disagree on
 * whether a payload is SVG, and so an `<svg>` nested in an HTML body doesn't
 * pass as a root element.
 *
 * @param data - Image bytes to inspect
 * @returns The bounded decoded text starting at the root `<svg` tag (prolog
 *   removed), or undefined when no root `<svg` tag is found
 */
function getSvgSignatureSlice(data: Uint8Array): string | undefined {
  const slice = Buffer.from(data.subarray(0, MAX_SVG_SIGNATURE_SCAN_BYTES)).toString('utf8');
  const prologEnd = skipSvgProlog(slice);
  if (prologEnd === -1) {
    return undefined;
  }
  const rootSlice = slice.slice(prologEnd);
  return SVG_ROOT_TAG_PATTERN_ANCHORED.test(rootSlice) ? rootSlice : undefined;
}

/**
 * Extract the root `<svg ...>` opening tag's text from an SVG signature slice.
 *
 * @param slice - Prolog-skipped text returned by getSvgSignatureSlice, which
 *   already starts exactly at the root `<svg` tag
 * @returns The tag's text, or undefined if it isn't closed within the scanned slice
 */
function extractSvgRootTag(slice: string): string | undefined {
  const match = SVG_ROOT_TAG_PATTERN_ANCHORED.exec(slice);
  if (!match) {
    return undefined;
  }
  const tagEnd = slice.indexOf('>', match.index);
  return tagEnd === -1 ? undefined : slice.slice(match.index, tagEnd);
}

/**
 * Read one attribute's raw string value from an SVG root tag's text.
 *
 * @param tag - Bounded root tag text
 * @param name - Attribute name
 * @returns The attribute value, or undefined if absent
 */
function extractSvgAttribute(tag: string, name: string): string | undefined {
  // Anchored to the tag boundary or whitespace (not `\b`, which also matches
  // after a hyphen) so `data-width="7"` can't be mistaken for `width="7"`.
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = pattern.exec(tag);
  return match ? (match[1] ?? match[2]) : undefined;
}

// Anchored so hex literals (0x10) and other non-SVG-numeric syntax that
// bare Number() would silently accept are rejected instead.
const SVG_STRICT_NUMBER_PATTERN = /^\d+(?:\.\d+)?$/;
// Same, but allowing an optional leading sign: viewBox's min-x/min-y may
// legitimately be negative, unlike width/height.
const SVG_STRICT_SIGNED_NUMBER_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * Parse an SVG width/height attribute value, accepting only unitless numbers
 * or explicit px values. Any other unit (%, cm, in, pt, em, ...) is rejected.
 *
 * @param value - Raw attribute value
 * @returns The parsed length, or undefined for a missing value or disallowed unit
 */
function parseSvgLength(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(\d+(?:\.\d+)?)(px)?$/i.exec(value.trim());
  return match ? Number(match[1]) : undefined;
}

/**
 * Parse an SVG viewBox attribute's width and height (its 3rd and 4th values).
 *
 * @param value - Raw viewBox attribute value ("min-x min-y width height")
 * @returns The parsed dimensions, or undefined for a malformed viewBox
 */
function parseSvgViewBox(value: string | undefined): ExportImageDimensions | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parts = value.trim().split(/[\s,]+/);
  if (
    parts.length < 4 ||
    !parts.slice(0, 2).every(part => SVG_STRICT_SIGNED_NUMBER_PATTERN.test(part)) ||
    !parts.slice(2, 4).every(part => SVG_STRICT_NUMBER_PATTERN.test(part))
  ) {
    return undefined;
  }
  return { width: Number(parts[2]), height: Number(parts[3]) };
}

/**
 * Read SVG dimensions from the root tag's width/height, falling back to
 * viewBox when width/height are missing or use a disallowed unit.
 *
 * @param data - Signature-validated SVG bytes
 * @returns Dimensions, or undefined when no usable width/height or viewBox is found
 */
function readSvgDimensions(data: Uint8Array): ExportImageDimensions | undefined {
  const slice = getSvgSignatureSlice(data);
  if (!slice) {
    return undefined;
  }
  const rootTag = extractSvgRootTag(slice);
  if (!rootTag) {
    return undefined;
  }

  const width = parseSvgLength(extractSvgAttribute(rootTag, 'width'));
  const height = parseSvgLength(extractSvgAttribute(rootTag, 'height'));
  if (width !== undefined && height !== undefined) {
    return validDimensions(width, height);
  }

  const viewBoxDimensions = parseSvgViewBox(extractSvgAttribute(rootTag, 'viewBox'));
  return viewBoxDimensions
    ? validDimensions(viewBoxDimensions.width, viewBoxDimensions.height)
    : undefined;
}

/**
 * Read export image dimensions without invoking a general-purpose parser.
 *
 * The strict source/signature gate prevents format confusion. PNG, GIF, WebP,
 * BMP, and ICO use fixed-offset reads. JPEG traversal is capped at 1 MiB and
 * 4,096 markers, and rejects non-advancing or truncated segments. SVG uses a
 * bounded regex scan over the first 4,096 bytes only.
 *
 * @param source - Original image source used by the Word export pipeline
 * @param data - Image bytes to inspect
 * @returns Dimensions for a supported well-formed header, otherwise undefined
 */
export function readExportImageDimensions(
  source: string,
  data: Uint8Array
): ExportImageDimensions | undefined {
  const sourceFormat = getSafeDimensionImageFormat(source);
  if (!sourceFormat || sourceFormat !== getSafeDimensionImageSignature(data)) {
    return undefined;
  }

  switch (sourceFormat) {
    case 'png':
      return readPngDimensions(data);
    case 'jpeg':
      return readJpegDimensions(data);
    case 'gif':
      return readGifDimensions(data);
    case 'webp':
      return readWebpDimensions(data);
    case 'bmp':
      return readBmpDimensions(data);
    case 'ico':
      return readIcoDimensions(data);
    case 'svg':
      return readSvgDimensions(data);
  }
}

/**
 * Strip active content from HTML before passing it to Chrome for PDF rendering.
 *
 * The PDF export pipeline takes the editor's HTML and renders it via headless
 * Chrome with no Content-Security-Policy. Combined with markdown's
 * permissive `html: true` parser, ANY active content authored in a markdown
 * file would otherwise execute during export — script tags, event handlers,
 * iframes pointing at file:// URIs, javascript: hrefs.
 *
 * Removing the Chrome flag `--allow-file-access-from-files` (done in this
 * change) blocks file:// fetches from the rendered page, but defense in
 * depth still requires us to strip active content so a malicious markdown
 * file cannot embed credential prompts, fetch external resources, or run
 * Chrome zero-days against the user during export.
 *
 * Implementation uses `cheerio` (already a runtime dep) for parser-level
 * sanitization. We allow nothing implicitly; instead we deny-list the
 * specific dangerous tags / attributes / URI schemes. Benign markup
 * (paragraphs, tables, code, images with relative or data: src, anchors,
 * style/class) passes through untouched.
 *
 * See SECURITY review §H3.
 */
export function sanitizeExportHtml(html: string): string {
  if (!html) {
    return '';
  }
  // Wrap in a sentinel so we can extract just the body fragment back out
  // without cheerio injecting <html><head><body> wrappers.
  const $ = cheerio.load(`<div data-md4h-sanitize-root>${html}</div>`);

  // 1) Remove dangerous tags entirely (including their contents).
  $(
    'script, iframe, object, embed, link, meta, base, form, input, button, ' +
      'textarea, frame, frameset, applet, audio, video, source, track, portal'
  ).remove();

  // 2) Strip every on* event handler and any URL-bearing attribute whose
  //    value uses a script-bearing scheme.
  const URL_LIKE_ATTRS = new Set([
    'href',
    'src',
    'srcset',
    'action',
    'formaction',
    'background',
    'poster',
    'data',
    'cite',
    'longdesc',
    'usemap',
    'profile',
    'manifest',
    'codebase',
    'classid',
    'icon',
    'xlink:href',
  ]);
  // Match javascript:/file:/vbscript: (with optional whitespace before the colon,
  // since HTML parsers tolerate it) OR any data: URI that isn't an image.
  // Note: data: URIs don't have a second colon, so they must be handled as a
  // separate branch rather than grouped with the scheme-colon pattern.
  const DANGEROUS_SCHEME = /^\s*(?:(?:javascript|file|vbscript)\s*:|data:(?!image\/))/i;

  $('*').each((_, el) => {
    const tagEl = el as { attribs?: Record<string, string> };
    if (!tagEl.attribs) {
      return;
    }
    for (const attrName of Object.keys(tagEl.attribs)) {
      const lower = attrName.toLowerCase();
      if (lower.startsWith('on')) {
        $(el).removeAttr(attrName);
        continue;
      }
      if (URL_LIKE_ATTRS.has(lower)) {
        const value = tagEl.attribs[attrName];
        if (typeof value === 'string' && DANGEROUS_SCHEME.test(value)) {
          $(el).removeAttr(attrName);
        }
      }
    }
  });

  return $('[data-md4h-sanitize-root]').html() || '';
}

/**
 * Mermaid image data
 */
interface MermaidImage {
  id: string;
  pngDataUrl: string;
  originalSvg: string;
}

/**
 * Get the document directory for file-based documents, or workspace folder/home directory for untitled files
 * Returns home directory if document is untitled and has no workspace
 */
function getDocumentBasePath(document: vscode.TextDocument): string {
  if (document.uri.scheme === 'file') {
    return path.dirname(document.uri.fsPath);
  }
  // For untitled files, use workspace folder as fallback
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (workspaceFolder) {
    return workspaceFolder.uri.fsPath;
  }
  // Fallback to home directory for untitled files without workspace
  return os.homedir();
}

/**
 * Show export warning dialog and wait for user confirmation
 *
 * @param format - Export format ('pdf' or 'docx')
 * @returns true if user confirmed, false if cancelled
 */
async function showExportWarning(format: string): Promise<boolean> {
  const formatName = format === 'pdf' ? 'PDF' : 'Word';
  const message = `Export to ${formatName} works best with simple markdown files.\n\nKnown limitations:\n• Images (especially remote URLs)\n• Mermaid diagrams\n• Complex markdown structures\n\nSome content may not render correctly in the exported document.`;

  const action = await vscode.window.showWarningMessage(message, { modal: true }, 'I Understand');

  return action === 'I Understand';
}

/**
 * Export document to PDF or Word format
 *
 * @param format - Export format ('pdf' or 'docx')
 * @param html - HTML content from editor
 * @param mermaidImages - Mermaid diagrams as PNG data URLs
 * @param title - Document title
 * @param document - Source VS Code document
 */
export async function exportDocument(
  format: string,
  html: string,
  mermaidImages: MermaidImage[],
  title: string,
  document: vscode.TextDocument
): Promise<void> {
  // Show warning dialog and wait for user confirmation
  const userConfirmed = await showExportWarning(format);
  if (!userConfirmed) {
    return; // User cancelled
  }

  // Convert all images (local and remote) to data URLs for embedding
  // html = await convertImagesToDataUrls(html, document);

  // Export theme is always light
  const exportTheme = 'light';

  // Show file save dialog
  const defaultFilename = title.replace(/[<>:"/\\|?*]/g, '-') || 'document';
  const extension = format === 'pdf' ? 'pdf' : 'docx';
  const filters: Record<string, string[]> = {};
  filters[format === 'pdf' ? 'PDF Document' : 'Word Document'] = [extension];

  const docBasePath = getDocumentBasePath(document);
  const saveUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(docBasePath, `${defaultFilename}.${extension}`)),
    filters,
  });

  if (!saveUri) {
    return; // User cancelled
  }

  const uri = saveUri;

  // Show progress
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Exporting to ${format.toUpperCase()}...`,
      cancellable: true,
    },
    async (progress, token) => {
      try {
        let exportSucceeded = false;

        if (format === 'pdf') {
          exportSucceeded = await exportToPDF(
            html,
            mermaidImages,
            exportTheme,
            uri.fsPath,
            progress,
            document,
            token
          );
        } else if (format === 'docx') {
          exportSucceeded = await exportToWord(
            html,
            mermaidImages,
            exportTheme,
            uri.fsPath,
            progress,
            document
          );
        }

        // Only show success message if export actually completed
        if (exportSucceeded) {
          vscode.window.showInformationMessage(
            `Document exported successfully to ${path.basename(uri.fsPath)}`
          );

          // Auto-open PDF in default viewer (only for PDF format)
          if (format === 'pdf') {
            try {
              // Verify file exists before opening
              if (fs.existsSync(uri.fsPath)) {
                await vscode.env.openExternal(vscode.Uri.file(uri.fsPath));
              }
            } catch (error) {
              // Log error but don't fail export - opening is a convenience feature
              console.warn('[MD4H] Failed to open PDF:', error);
            }
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Export failed: ${errorMessage}`);
        console.error('[MD4H] Export error:', error);
      }
    }
  );
}

/**
 * Chrome path validation result
 */
export interface ChromeValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Minimal modal flow: validate existing Chrome path, auto-detect, or prompt user to supply one.
 * Returns a validated executable path or null if the user cancels.
 */
async function ensureChromePath(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken
): Promise<string | null> {
  const config = vscode.workspace.getConfiguration('markdownForHumans');
  const report = (message: string, increment?: number) => {
    if (token.isCancellationRequested) {
      return;
    }
    progress.report({ message, increment });
  };

  // 1) Use configured path if valid
  const configuredRaw = config.get<string>('chromePath');
  if (configuredRaw) {
    const configuredPath = resolveChromeExecutable(configuredRaw);
    report('Validating configured Chrome path…', 20);
    const validation = await validateChromePath(configuredPath);
    if (validation.valid) {
      return configuredPath;
    }
  }

  // 2) Auto-detect common paths
  report('Detecting Chrome on this system…', 20);
  const detected = await findChromeExecutable();
  if (detected.path) {
    const detectedPath = resolveChromeExecutable(detected.path);
    const validation = await validateChromePath(detectedPath);
    if (validation.valid) {
      // Save for future runs
      await config.update('chromePath', detectedPath, vscode.ConfigurationTarget.Global);
      return detectedPath;
    }
  }

  // 3) Inline resolver: ask user to provide a path and validate it
  return await promptForChromePathInlineResolver(progress, token);
}

/**
 * Normalize platform-specific Chrome paths (e.g. macOS .app bundles → inner executable)
 */
function resolveChromeExecutable(rawPath: string): string {
  if (process.platform === 'darwin' && rawPath.endsWith('.app')) {
    const candidate = path.join(rawPath, 'Contents', 'MacOS', 'Google Chrome');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const chromiumCandidate = path.join(rawPath, 'Contents', 'MacOS', 'Chromium');
    if (fs.existsSync(chromiumCandidate)) {
      return chromiumCandidate;
    }
  }
  return rawPath;
}

/**
 * Validate that a path points to a valid Chrome/Chromium executable
 *
 * @param chromePath - Path to validate
 * @returns Validation result with error message if invalid
 */
export async function validateChromePath(chromePath: string): Promise<ChromeValidationResult> {
  const executablePath = resolveChromeExecutable(chromePath);

  // Check if file exists
  if (!fs.existsSync(executablePath)) {
    return { valid: false, error: 'Chrome executable not found at the specified path' };
  }

  // Try running Chrome with --version to verify it's actually Chrome/Chromium
  try {
    await new Promise<void>((resolve, reject) => {
      const chromeProcess = spawn(executablePath, ['--version'], { stdio: 'ignore' });

      chromeProcess.once('error', error => {
        reject(new Error(`Failed to execute Chrome: ${error.message}`));
      });

      chromeProcess.once('exit', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Chrome exited with code ${code}`));
        }
      });
    });

    return { valid: true };
  } catch {
    return {
      valid: false,
      error: 'The specified file is not a valid Chrome/Chromium executable',
    };
  }
}

/**
 * Prompt user to configure Chrome path
 * Shows different dialogs based on whether Chrome was auto-detected
 *
 * @param detectedPath - Auto-detected Chrome path, or null if not found
 * @returns User-selected Chrome path, or null if cancelled
 */
export async function promptForChromePath(detectedPath: string | null): Promise<string | null> {
  if (detectedPath) {
    // Chrome was detected - offer to use it or choose different
    const choice = await vscode.window.showInformationMessage(
      `Chrome detected at:\n${detectedPath}\n\nWould you like to use this for PDF export?`,
      { modal: true },
      'Use This Path',
      'Choose Different Path',
      'Cancel'
    );

    if (choice === 'Use This Path') {
      return detectedPath;
    } else if (choice === 'Choose Different Path') {
      return await showChromeFilePicker();
    } else {
      return null; // Cancelled
    }
  } else {
    // Chrome not detected - offer to choose path or download
    const choice = await vscode.window.showInformationMessage(
      'Chrome/Chromium is required for PDF export but was not found on your system.\n\nYou can download Chrome or select an existing installation.',
      { modal: true },
      'Download Chrome',
      'Choose Chrome Path',
      'Cancel'
    );

    if (choice === 'Download Chrome') {
      // Open Chrome download page
      await vscode.env.openExternal(vscode.Uri.parse('https://www.google.com/chrome/'));
      return null; // User needs to install and try again
    } else if (choice === 'Choose Chrome Path') {
      return await showChromeFilePicker();
    } else {
      return null; // Cancelled
    }
  }
}

/**
 * Show file picker for selecting Chrome executable
 */
async function showChromeFilePicker(): Promise<string | null> {
  const platform = process.platform;
  const filters: Record<string, string[]> = {};

  if (platform === 'win32') {
    filters['Chrome/Chromium'] = ['exe'];
  } else if (platform === 'darwin') {
    filters['Chrome/Chromium'] = ['app'];
  } else {
    filters['Chrome/Chromium'] = ['*'];
  }

  const result = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: platform === 'darwin', // allow picking .app bundles
    canSelectMany: false,
    filters,
    title: 'Select Chrome/Chromium Executable',
  });

  if (result && result.length > 0) {
    return result[0].fsPath;
  }

  return null;
}

/**
 * Inline resolver used by the minimal modal flow.
 * Re-prompts until a valid Chrome path is provided or the user cancels.
 */
async function promptForChromePathInlineResolver(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken
): Promise<string | null> {
  let lastError: string | undefined;
  let lastValue: string | undefined;

  while (!token.isCancellationRequested) {
    const choice = await vscode.window.showInformationMessage(
      lastError
        ? `Chrome is required for PDF export.\nLast check failed: ${lastError}`
        : 'Chrome is required for PDF export. Provide a path to Chrome/Chromium.',
      { modal: true },
      'Browse…',
      'Enter Path',
      'Download Chrome',
      'Cancel'
    );

    if (!choice || choice === 'Cancel') {
      return null;
    }

    if (choice === 'Download Chrome') {
      await vscode.env.openExternal(vscode.Uri.parse('https://www.google.com/chrome/'));
      continue;
    }

    let candidate: string | null = null;

    if (choice === 'Browse…') {
      const picked = await showChromeFilePicker();
      candidate = picked ?? null;
    } else if (choice === 'Enter Path') {
      const input = await vscode.window.showInputBox({
        title: 'Enter Chrome/Chromium executable path',
        value: lastValue,
        prompt:
          'Examples:\n- /Applications/Google Chrome.app/Contents/MacOS/Google Chrome (macOS)\n- C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe (Windows)\n- /usr/bin/google-chrome (Linux)',
        ignoreFocusOut: true,
      });
      candidate = input ?? null;
      lastValue = input ?? lastValue;
    }

    if (!candidate) {
      lastError = 'No path selected';
      continue;
    }

    // Validate with progress feedback
    if (token.isCancellationRequested) {
      return null;
    }
    progress.report({ message: 'Validating Chrome path…' });
    const validation = await validateChromePath(candidate);
    if (validation.valid) {
      const resolved = resolveChromeExecutable(candidate);
      const config = vscode.workspace.getConfiguration('markdownForHumans');
      await config.update('chromePath', resolved, vscode.ConfigurationTarget.Global);
      return resolved;
    }

    lastError = validation.error || 'Invalid Chrome path';
    await vscode.window.showErrorMessage(
      `Chrome not ready: ${lastError}. Please choose a valid Chrome/Chromium executable.`
    );
  }

  return null;
}

/**
 * Export to PDF using the user's local Chrome/Chromium installation
 *
 * @returns true if export succeeded, false if user cancelled
 */
async function exportToPDF(
  html: string,
  _mermaidImages: MermaidImage[],
  theme: string,
  outputPath: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  document: vscode.TextDocument,
  token: vscode.CancellationToken
): Promise<boolean> {
  progress.report({ message: 'Preparing PDF export…', increment: 20 });

  const chromePath = await ensureChromePath(progress, token);
  if (!chromePath) {
    return false;
  }

  // Build complete HTML document
  const completeHtml = buildExportHTML(html, theme, 'pdf');

  // Set content with the document's directory as the base URL
  // This allows relative paths (src="./foo.png") to be resolved correctly by Chrome
  const docDir = getDocumentBasePath(document);

  // Inject base tag to ensure relative paths are resolved correctly
  const htmlWithBase = completeHtml.replace('<head>', `<head><base href="file://${docDir}/">`);

  // Write the HTML to a temp file for Chrome to print
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'md4h-export-'));
  const tempHtmlPath = path.join(tempDir, 'export.html');

  try {
    await fs.promises.writeFile(tempHtmlPath, htmlWithBase, 'utf8');
  } catch (error) {
    throw new Error(`Failed to write temporary HTML for export: ${error}`);
  }

  try {
    progress.report({ message: 'Launching Chrome...', increment: 20 });

    // SECURITY: `--allow-file-access-from-files` was REMOVED here. Chromium
    // documents that flag as "intended for testing only — do not use it on
    // builds distributed to end users." Combined with markdown's `html: true`
    // parser, it allowed a hostile .md file to embed
    //   <script>fetch('file:///Users/<u>/.ssh/id_ed25519').then(...)</script>
    // and exfiltrate the contents into the PDF the user just saved.
    // See SECURITY review §H3.
    const chromeArgs = [
      '--headless=chrome',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-software-rasterizer',
      '--disable-dev-shm-usage',
      '--print-to-pdf=' + outputPath,
      `file://${tempHtmlPath}`,
    ];

    progress.report({ message: 'Rendering PDF...', increment: 30 });
    await runChrome(chromePath, chromeArgs);
    progress.report({ increment: 20 });
    return true; // Export succeeded
  } catch (error) {
    // Surface a user-friendly error
    const errMessage =
      error instanceof Error ? error.message : 'Unknown error while exporting to PDF';
    throw new Error(errMessage);
  } finally {
    // Clean up temp files
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn('[MD4H] Failed to clean up temporary export directory:', cleanupError);
    }
  }
}

async function runChrome(executablePath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // On Windows, use CREATE_NO_WINDOW flag to prevent any window from showing
    const spawnOptions: {
      stdio: 'ignore';
      windowsHide?: boolean;
      detached?: boolean;
      shell?: boolean;
    } = {
      stdio: 'ignore',
    };

    if (process.platform === 'win32') {
      // Prevent any window from appearing on Windows
      spawnOptions.windowsHide = true;
      spawnOptions.detached = false;
      spawnOptions.shell = false;
    }

    const chromeProcess = spawn(executablePath, args, spawnOptions);

    chromeProcess.once('error', error => {
      reject(
        new Error(`Failed to launch Chrome: ${error instanceof Error ? error.message : error}`)
      );
    });

    chromeProcess.once('exit', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Chrome exited with code ${code}. Install or point to a working Chrome/Chromium via "markdownForHumans.chromePath".`
          )
        );
      }
    });
  });
}

/**
 * Chrome detection result
 */
export interface ChromeDetectionResult {
  path: string | null;
  detected: boolean; // true if auto-detected, false if user-configured or not found
}

/**
 * Find Chrome executable path
 * Returns result object instead of throwing to allow graceful handling
 *
 * @returns Chrome path and whether it was auto-detected
 */
export async function findChromeExecutable(): Promise<ChromeDetectionResult> {
  // User-configured path takes precedence
  const config = vscode.workspace.getConfiguration('markdownForHumans');
  const customChromePathRaw = config.get<string>('chromePath');
  const customChromePath = customChromePathRaw
    ? resolveChromeExecutable(customChromePathRaw)
    : undefined;
  if (customChromePath && fs.existsSync(customChromePath)) {
    return { path: customChromePath, detected: false };
  }

  // Common environment variable hints
  const envCandidates = [process.env.CHROME_PATH, process.env.CHROMIUM_PATH].filter(
    Boolean
  ) as string[];
  for (const candidate of envCandidates) {
    if (fs.existsSync(candidate)) {
      return { path: candidate, detected: true };
    }
  }

  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else if (platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Chromium\\Application\\chrome.exe'
    );
  } else if (platform === 'linux') {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    );
  }

  // Add PATH-based lookup for common binary names
  const pathExecutables =
    platform === 'win32'
      ? ['chrome.exe', 'msedge.exe', 'chromium.exe']
      : ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];

  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const binary of pathExecutables) {
      candidates.push(path.join(dir, binary));
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { path: candidate, detected: true };
    }
  }

  return { path: null, detected: false };
}

/**
 * Export to Word using docx library
 *
 * @returns true if export succeeded
 */
async function exportToWord(
  html: string,
  _mermaidImages: MermaidImage[],
  theme: string,
  outputPath: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  document: vscode.TextDocument
): Promise<boolean> {
  progress.report({ message: 'Converting to Word format...', increment: 30 });

  try {
    const docxModule = await import('docx');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docx = (docxModule as any).default ?? docxModule;

    progress.report({ message: 'Building document...', increment: 30 });

    // Parse HTML and convert to docx elements
    const children = await htmlToDocx(html, docx, theme, document);

    const doc = new docx.Document({
      sections: [
        {
          properties: {},
          children,
        },
      ],
    });

    progress.report({ message: 'Saving Word document...', increment: 20 });

    // Generate buffer and write to file
    const buffer = await docx.Packer.toBuffer(doc);
    fs.writeFileSync(outputPath, buffer);

    progress.report({ increment: 20 });
    return true; // Export succeeded
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (error && (error as any).code === 'MODULE_NOT_FOUND') {
      throw new Error('Word export requires docx library. Install with: npm install docx');
    }
    throw error;
  }
}

/**
 * Build complete HTML document for PDF export with styling
 */
function buildExportHTML(contentHtml: string, theme: string, _format: 'pdf' | 'html'): string {
  const styles = getExportStyles(theme);
  // SECURITY: strip script tags, on* handlers, and javascript:/file: URIs
  // before rendering with Chrome. See sanitizeExportHtml() docstring above
  // and SECURITY review §H3.
  const safeContent = sanitizeExportHtml(contentHtml);

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        ${styles}
      </style>
    </head>
    <body>
      <div class="content">
        ${safeContent}
      </div>
    </body>
    </html>
  `;
}

/**
 * Get CSS styles for exported documents
 */
function getExportStyles(theme: string): string {
  const baseStyles = `
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Charter', 'Georgia', 'Cambria', 'Times New Roman', serif;
      font-size: 16px;
      line-height: 1.6;
      color: ${theme === 'light' ? '#1a1a1a' : '#e0e0e0'};
      background: ${theme === 'light' ? '#ffffff' : '#1e1e1e'};
    }

    .content {
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 20px;
    }

    h1, h2, h3, h4, h5, h6 {
      font-weight: 600;
      margin-top: 1.5em;
      margin-bottom: 0.5em;
      line-height: 1.3;
    }

    h1 { font-size: 2.5em; margin-top: 0; }
    h2 { font-size: 2em; }
    h3 { font-size: 1.5em; }
    h4 { font-size: 1.25em; }
    h5 { font-size: 1.1em; }
    h6 { font-size: 1em; }

    p {
      margin-bottom: 1em;
    }

    code {
      font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
      background: ${theme === 'light' ? '#f5f5f5' : '#2d2d2d'};
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.9em;
    }

    pre {
      background: ${theme === 'light' ? '#f5f5f5' : '#2d2d2d'};
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
      margin-bottom: 1em;
    }

    pre code {
      background: none;
      padding: 0;
    }

    blockquote {
      border-left: 4px solid ${theme === 'light' ? '#ddd' : '#444'};
      padding-left: 16px;
      margin: 1em 0;
      color: ${theme === 'light' ? '#666' : '#aaa'};
    }

    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1em 0;
    }

    th, td {
      border: 1px solid ${theme === 'light' ? '#ddd' : '#444'};
      padding: 8px 12px;
      text-align: left;
    }

    th {
      background: ${theme === 'light' ? '#f5f5f5' : '#2d2d2d'};
      font-weight: 600;
    }

    ul, ol {
      margin-left: 2em;
      margin-bottom: 1em;
    }

    li {
      margin-bottom: 0.5em;
    }

    img, .mermaid-export-image {
      max-width: 100%;
      height: auto;
      margin: 1em 0;
    }

    a {
      color: ${theme === 'light' ? '#0066cc' : '#4dabf7'};
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }
  `;

  return baseStyles;
}

/**
 * Convert HTML to docx elements using Cheerio for reliable parsing
 * Handles headings, paragraphs, lists, tables, and images with nested tags
 */
async function htmlToDocx(
  html: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  docx: any,
  theme: string,
  document: vscode.TextDocument
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const children: any[] = [];

  // Parse HTML with Cheerio (proper DOM parser, handles nested tags)
  // Lazy-load to keep module init and test transforms lightweight.
  const cheerioModule = await import('cheerio');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cheerio = (cheerioModule as any).default ?? cheerioModule;
  const $ = cheerio.load(html);

  // Select all block-level elements we care about, maintaining document order
  // Cheerio traverses in document order automatically
  // Select all block-level elements we care about
  // We need to use a loop that supports await
  const elements = $('h1, h2, h3, h4, h5, h6, p, li, blockquote, table').toArray();

  for (const element of elements) {
    const $el = $(element);
    const tagName = element.tagName.toLowerCase();

    // Skip elements inside other processed elements (e.g. p inside blockquote handled by blockquote)
    if ($el.parents('blockquote, li').length > 0) {
      continue;
    }

    if (tagName.match(/^h[1-6]$/)) {
      // Heading
      const textContent = $el.text().trim();
      if (textContent) {
        children.push(
          new docx.Paragraph({
            text: textContent,
            heading: getHeadingLevel(tagName, docx),
            spacing: { before: 400, after: 200 },
          })
        );
      }
    } else if (tagName === 'p') {
      // Paragraph - handle mixed content (text, images, links)
      const paragraphChildren = await parseParagraphChildren($, element, docx, document);
      if (paragraphChildren.length > 0) {
        children.push(
          new docx.Paragraph({
            children: paragraphChildren,
            spacing: { after: 200 },
          })
        );
      }
    } else if (tagName === 'li') {
      // List item
      const paragraphChildren = await parseParagraphChildren($, element, docx, document);
      if (paragraphChildren.length > 0) {
        children.push(
          new docx.Paragraph({
            children: paragraphChildren,
            bullet: { level: 0 },
            spacing: { after: 100 },
          })
        );
      }
    } else if (tagName === 'blockquote') {
      // Blockquote
      const textContent = $el.text().trim();
      if (textContent) {
        children.push(
          new docx.Paragraph({
            text: textContent,
            italics: true,
            spacing: { before: 200, after: 200, left: 400 },
            border: {
              left: {
                color: theme === 'editor' ? '444444' : 'DDDDDD',
                space: 1,
                value: 'single',
                size: 24,
              },
            },
          })
        );
      }
    }
  }

  return children;
}

/**
 * Helper to get heading level
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getHeadingLevel(tagName: string, docx: any): any {
  switch (tagName) {
    case 'h1':
      return docx.HeadingLevel.HEADING_1;
    case 'h2':
      return docx.HeadingLevel.HEADING_2;
    case 'h3':
      return docx.HeadingLevel.HEADING_3;
    case 'h4':
      return docx.HeadingLevel.HEADING_4;
    case 'h5':
      return docx.HeadingLevel.HEADING_5;
    case 'h6':
      return docx.HeadingLevel.HEADING_6;
    default:
      return docx.HeadingLevel.HEADING_1;
  }
}

/**
 * Parse children of a paragraph-like element (p, li) into docx Runs
 */
async function parseParagraphChildren(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  element: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  docx: any,
  document: vscode.TextDocument
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runs: any[] = [];
  const contents = $(element).contents();

  // Process nodes sequentially to handle async image loading
  for (let i = 0; i < contents.length; i++) {
    const node = contents[i];

    if (node.type === 'text') {
      // Text node
      const text = $(node).text();
      if (text) {
        runs.push(new docx.TextRun({ text }));
      }
    } else if (node.type === 'tag') {
      const tagName = $(node).prop('tagName').toLowerCase();
      if (tagName === 'img') {
        // Image
        const src = $(node).attr('src');
        const markdownSrc = $(node).attr('data-markdown-src');
        const resolvableSrc = markdownSrc || src;

        if (resolvableSrc) {
          try {
            let buffer: Buffer | undefined;

            if (resolvableSrc.startsWith('data:')) {
              // Data URL
              const matches = resolvableSrc.match(/^data:([A-Za-z+/-]+);base64,(.+)$/);
              if (matches && matches.length === 3) {
                buffer = Buffer.from(matches[2], 'base64');
              }
            } else if (
              resolvableSrc.startsWith('http://') ||
              resolvableSrc.startsWith('https://')
            ) {
              // KNOWN LIMITATION: Remote images (HTTP/HTTPS URLs) are not embedded in Word exports.
              // This is intentional to avoid network dependencies during export and potential
              // security concerns with fetching arbitrary remote resources.
              // Workaround: Download images locally before exporting to Word.
              // TODO: Consider adding a user-facing warning when document contains remote images.
              console.warn(`[MD4H] Word export: Skipping remote image: ${resolvableSrc}`);
            } else {
              // Local file or vscode-webview://
              let absolutePath = resolvableSrc;

              if (resolvableSrc.startsWith('vscode-webview://')) {
                // const docDir = path.dirname(document.uri.fsPath);
                // const decodedSrc = decodeURIComponent(resolvableSrc);
                // This is a simplification. Real webview resolution is complex.
                // But if we have data-markdown-src (which we prioritize), it usually has the original path
                // If resolvableSrc is still webview://, it means we didn't have data-markdown-src
                // In that case, we might fail to resolve.
              } else if (!path.isAbsolute(resolvableSrc)) {
                const docDir = getDocumentBasePath(document);
                absolutePath = path.resolve(docDir, decodeURIComponent(resolvableSrc));
              }

              if (fs.existsSync(absolutePath)) {
                buffer = fs.readFileSync(absolutePath);
              }
            }

            if (buffer) {
              // Get dimensions
              let width = 400;
              let height = 300;

              try {
                const dimensions = readExportImageDimensions(resolvableSrc, buffer);
                if (dimensions?.width && dimensions.height) {
                  // Scale down if too large (e.g. max width 600px)
                  const maxWidth = 600;
                  if (dimensions.width > maxWidth) {
                    const ratio = maxWidth / dimensions.width;
                    width = maxWidth;
                    height = Math.round(dimensions.height * ratio);
                  } else {
                    width = dimensions.width;
                    height = dimensions.height;
                  }
                }
              } catch (e) {
                console.warn('[MD4H] Failed to get image dimensions:', e);
              }

              runs.push(
                new docx.ImageRun({
                  data: buffer,
                  transformation: { width, height },
                })
              );
            }
          } catch (e) {
            console.error('[MD4H] Failed to process image in paragraph:', e);
          }
        }
      } else if (tagName === 'strong' || tagName === 'b') {
        // Bold
        runs.push(
          new docx.TextRun({
            text: $(node).text(),
            bold: true,
          })
        );
      } else if (tagName === 'em' || tagName === 'i') {
        // Italic
        runs.push(
          new docx.TextRun({
            text: $(node).text(),
            italics: true,
          })
        );
      } else if (tagName === 'code') {
        // Inline code
        runs.push(
          new docx.TextRun({
            text: $(node).text(),
            font: 'Courier New',
            color: 'C7254E', // Red-ish color for code
          })
        );
      } else {
        // Other tags - just treat as text for now
        runs.push(new docx.TextRun({ text: $(node).text() }));
      }
    }
  }

  return runs;
}
