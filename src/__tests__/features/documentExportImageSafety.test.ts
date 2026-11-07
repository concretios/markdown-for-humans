/**
 * Word export image-dimension safety tests.
 *
 * Dimension reads run on the extension host, so this boundary must stay
 * dependency-free, synchronous, and structurally bounded. Only PNG, JPEG,
 * GIF, WebP, BMP, ICO, and SVG sources with matching signatures are inspected.
 */

import {
  isSafeForImageDimensionParsing,
  readExportImageDimensions,
} from '../../features/documentExport';

function ascii(value: string): number[] {
  return Array.from(value, character => character.charCodeAt(0));
}

function bigEndian16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function bigEndian32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function littleEndian16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function littleEndian32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function pngWithDimensions(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    ...ascii('PNG\r\n\u001a\n'),
    ...bigEndian32(13),
    ...ascii('IHDR'),
    ...bigEndian32(width),
    ...bigEndian32(height),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}

function gifWithDimensions(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...ascii('GIF89a'),
    ...littleEndian16(width),
    ...littleEndian16(height),
    0,
    0,
    0,
  ]);
}

function jpegStartOfFrame(width: number, height: number): number[] {
  return [
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    ...bigEndian16(height),
    ...bigEndian16(width),
    0x01,
    0x01,
    0x11,
    0x00,
  ];
}

function jpegWithDimensions(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    ...jpegStartOfFrame(width, height),
  ]);
}

function webpChunk(type: 'VP8 ' | 'VP8L' | 'VP8X', payload: number[]): Uint8Array {
  const paddedPayloadLength = payload.length + (payload.length % 2);
  const riffSize = 4 + 8 + paddedPayloadLength;
  return Uint8Array.from([
    ...ascii('RIFF'),
    ...littleEndian32(riffSize),
    ...ascii('WEBP'),
    ...ascii(type),
    ...littleEndian32(payload.length),
    ...payload,
    ...(payload.length % 2 === 0 ? [] : [0]),
  ]);
}

function vp8WithDimensions(width: number, height: number): Uint8Array {
  return webpChunk('VP8 ', [
    0x00,
    0x00,
    0x00,
    0x9d,
    0x01,
    0x2a,
    ...littleEndian16(width),
    ...littleEndian16(height),
  ]);
}

function vp8lWithDimensions(width: number, height: number): Uint8Array {
  const widthBits = width - 1;
  const heightBits = height - 1;
  return webpChunk('VP8L', [
    0x2f,
    widthBits & 0xff,
    ((widthBits >>> 8) & 0x3f) | ((heightBits & 0x03) << 6),
    (heightBits >>> 2) & 0xff,
    (heightBits >>> 10) & 0x0f,
  ]);
}

function vp8xWithDimensions(width: number, height: number): Uint8Array {
  const widthBits = width - 1;
  const heightBits = height - 1;
  return webpChunk('VP8X', [
    0,
    0,
    0,
    0,
    widthBits & 0xff,
    (widthBits >>> 8) & 0xff,
    (widthBits >>> 16) & 0xff,
    heightBits & 0xff,
    (heightBits >>> 8) & 0xff,
    (heightBits >>> 16) & 0xff,
  ]);
}

// BITMAPFILEHEADER: 'BM' + bfSize(LE32) + bfReserved1/2(LE16 each) + bfOffBits(LE32).
function bmpFileHeader(totalSize: number, pixelDataOffset: number): number[] {
  return [
    ...ascii('BM'),
    ...littleEndian32(totalSize),
    0,
    0,
    0,
    0, // reserved1, reserved2
    ...littleEndian32(pixelDataOffset),
  ];
}

// One padded 24-bit-per-pixel row, so every BMP fixture carries real pixel
// data after its header rather than ending at the header boundary.
function bmpPixelRow(width: number): number[] {
  const rowBytes = Math.ceil((Math.abs(width) * 3) / 4) * 4;
  return new Array(rowBytes).fill(0);
}

// Full 14-byte BITMAPFILEHEADER + full 12-byte BITMAPCOREHEADER (size,
// width, height, biPlanes, biBitCount) + one row of pixel data, with
// bfSize/bfOffBits set consistently with the real total length and offset.
function bmpCoreHeaderWithDimensions(width: number, height: number): Uint8Array {
  const dibHeader = [
    ...littleEndian32(12), // DIB header size: BITMAPCOREHEADER
    ...littleEndian16(width),
    ...littleEndian16(height),
    ...littleEndian16(1), // biPlanes
    ...littleEndian16(24), // biBitCount
  ];
  const pixelData = bmpPixelRow(width);
  const pixelDataOffset = 14 + dibHeader.length;
  const fileHeader = bmpFileHeader(pixelDataOffset + pixelData.length, pixelDataOffset);
  return Uint8Array.from([...fileHeader, ...dibHeader, ...pixelData]);
}

// Full 14-byte BITMAPFILEHEADER + full 40-byte BITMAPINFOHEADER (size,
// width, height, biPlanes, biBitCount, biCompression, biSizeImage,
// biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant) + one row of
// pixel data, with bfSize/bfOffBits set consistently with the real total
// length and offset.
function bmpInfoHeaderWithDimensions(width: number, height: number): Uint8Array {
  const dibHeader = [
    ...littleEndian32(40), // DIB header size: BITMAPINFOHEADER
    ...littleEndian32(width),
    ...littleEndian32(height),
    ...littleEndian16(1), // biPlanes
    ...littleEndian16(24), // biBitCount
    ...littleEndian32(0), // biCompression
    ...littleEndian32(0), // biSizeImage
    ...littleEndian32(0), // biXPelsPerMeter
    ...littleEndian32(0), // biYPelsPerMeter
    ...littleEndian32(0), // biClrUsed
    ...littleEndian32(0), // biClrImportant
  ];
  const pixelData = bmpPixelRow(width);
  const pixelDataOffset = 14 + dibHeader.length;
  const fileHeader = bmpFileHeader(pixelDataOffset + pixelData.length, pixelDataOffset);
  return Uint8Array.from([...fileHeader, ...dibHeader, ...pixelData]);
}

// A BMP whose declared DIB header size is `dibHeaderSize`, backed by exactly
// `totalLength` bytes: neither the size 12 nor size >=40 layout, and often
// deliberately shorter than the header it claims.
function bmpWithDeclaredDibHeaderSize(dibHeaderSize: number, totalLength: number): Uint8Array {
  const bytes = new Array(totalLength).fill(0);
  const header = [...ascii('BM'), ...littleEndian32(0), 0, 0, 0, 0, ...littleEndian32(0)];
  header.forEach((byte, index) => {
    bytes[index] = byte;
  });
  const dibHeaderSizeBytes = littleEndian32(dibHeaderSize);
  dibHeaderSizeBytes.forEach((byte, index) => {
    bytes[header.length + index] = byte;
  });
  return Uint8Array.from(bytes);
}

// Claims a BITMAPINFOHEADER (size >= 40) with plausible width/height bytes
// at the expected offsets, but declares a DIB header size far larger than
// the actual data: the reader must not trust the two fixed-offset reads
// just because they happen to be in bounds.
function bmpWithOversizedDibHeaderClaim(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...ascii('BM'),
    ...littleEndian32(0),
    0,
    0,
    0,
    0,
    ...littleEndian32(0),
    ...littleEndian32(0xffffffff), // declared DIB header size far exceeds actual data
    ...littleEndian32(width),
    ...littleEndian32(height),
  ]);
}

function icoWithEntryDimensions(rawWidth: number, rawHeight: number): Uint8Array {
  return Uint8Array.from([
    0x00,
    0x00, // reserved
    0x01,
    0x00, // type = 1 (ICO; type 2 would be CUR)
    ...littleEndian16(1), // one ICONDIRENTRY
    rawWidth,
    rawHeight,
    0x00, // color count
    0x00, // reserved
    ...littleEndian16(1), // color planes
    ...littleEndian16(32), // bits per pixel
    ...littleEndian32(0), // size of image data (unused by reader)
    ...littleEndian32(22), // offset of image data (unused by reader)
  ]);
}

function curWithEntryDimensions(rawWidth: number, rawHeight: number): Uint8Array {
  return Uint8Array.from([
    0x00,
    0x00, // reserved
    0x02,
    0x00, // type = 2 (CUR cursor format, not ICO)
    ...littleEndian16(1), // one ICONDIRENTRY
    rawWidth,
    rawHeight,
    0x00, // color count
    0x00, // reserved
    ...littleEndian16(1), // color planes
    ...littleEndian16(32), // bits per pixel
    ...littleEndian32(0), // size of image data (unused by reader)
    ...littleEndian32(22), // offset of image data (unused by reader)
  ]);
}

function svgWithMarkup(rootAttributes: string): Uint8Array {
  return Uint8Array.from(ascii(`<svg xmlns="http://www.w3.org/2000/svg" ${rootAttributes}></svg>`));
}

const png = pngWithDimensions(640, 480);
const jpeg = jpegWithDimensions(1024, 768);
const gif = gifWithDimensions(320, 200);
const vp8 = vp8WithDimensions(800, 600);
const vp8l = vp8lWithDimensions(511, 257);
const vp8x = vp8xWithDimensions(1920, 1080);
const bmpCore = bmpCoreHeaderWithDimensions(32, 48);
const bmpInfo = bmpInfoHeaderWithDimensions(320, 240);
const bmpInfoNegativeHeight = bmpInfoHeaderWithDimensions(320, -240);
const bmpUnrecognizedDibHeaderSize = bmpWithDeclaredDibHeaderSize(16, 30);
const bmpOversizedDibHeaderClaim = bmpWithOversizedDibHeaderClaim(320, 240);
const ico = icoWithEntryDimensions(32, 48);
const icoZeroMeans256 = icoWithEntryDimensions(0, 64);
const cur = curWithEntryDimensions(32, 48);
const svgPx = svgWithMarkup('width="640px" height="480px"');
const svgUnitless = svgWithMarkup('width="640" height="480"');
const svgViewBoxOnly = svgWithMarkup('viewBox="0 0 640 480"');
const svgPercentWidth = svgWithMarkup('width="50%" height="50%"');
const svgDecoyAttributesWithRealViewBox = svgWithMarkup(
  'data-width="7" data-height="9" data-viewBox="1 1 1 1" viewBox="0 0 640 480"'
);
const svgHexViewBox = svgWithMarkup('viewBox="0 0 0x10 0x20"');
const svgNegativeViewBoxOrigin = svgWithMarkup('viewBox="-10 -10 640 480"');
const htmlWithNestedSvg = Uint8Array.from(
  ascii(
    '<!DOCTYPE html><html><body><p>not an svg root</p><svg width="1" height="1"></svg></body></html>'
  )
);
const svgCommentDecoyBeforeRealRoot = Uint8Array.from(
  ascii(
    '<!-- <svg width="1" height="1"></svg> --><svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"></svg>'
  )
);

const icns = Uint8Array.from([...ascii('icns'), 0x00, 0x00, 0x00, 0x08]);
const jxl = Uint8Array.from([0xff, 0x0a, 0x00, 0x00]);
const heif = Uint8Array.from([0x00, 0x00, 0x00, 0x18, ...ascii('ftypheic')]);

describe('Word export image dimension reader', () => {
  it.each([
    ['ICNS', 'icon.icns', icns],
    ['JXL', 'photo.jxl', jxl],
    ['HEIF', 'photo.heif', heif],
    ['HEIC', 'photo.heic', heif],
    ['ICNS data URL', 'data:image/icns;base64,aWNucw==', icns],
    ['JXL data URL', 'data:image/jxl;base64,/woAAA==', jxl],
    ['HEIF data URL', 'data:image/heif;base64,AAAA', heif],
    ['HEIC data URL', 'data:image/heic;base64,AAAA', heif],
  ])('returns the fallback signal for unsupported %s input', (_, source, data) => {
    expect(isSafeForImageDimensionParsing(source, data)).toBe(false);
    expect(readExportImageDimensions(source, data)).toBeUndefined();
  });

  it.each([
    ['ICNS', 'renamed.png', icns],
    ['JXL', 'renamed.jpg', jxl],
    ['HEIF', 'renamed.webp', heif],
    ['ICNS', 'renamed.bmp', icns],
    ['JXL', 'renamed.ico', jxl],
    ['HEIF', 'renamed.svg', heif],
    ['CUR', 'renamed.ico', cur],
  ])('rejects a %s payload disguised with an allowlisted extension', (_, source, data) => {
    expect(isSafeForImageDimensionParsing(source, data)).toBe(false);
    expect(readExportImageDimensions(source, data)).toBeUndefined();
  });

  it.each([
    ['PNG', 'diagram.png', png, { width: 640, height: 480 }],
    ['JPEG (.jpg)', 'photo.jpg', jpeg, { width: 1024, height: 768 }],
    ['JPEG (.jpeg)', 'photo.jpeg', jpeg, { width: 1024, height: 768 }],
    ['GIF', 'animation.gif', gif, { width: 320, height: 200 }],
    ['WebP VP8', 'photo.webp', vp8, { width: 800, height: 600 }],
    ['WebP VP8L', 'photo.webp', vp8l, { width: 511, height: 257 }],
    ['WebP VP8X', 'photo.webp', vp8x, { width: 1920, height: 1080 }],
    ['BMP (BITMAPCOREHEADER)', 'diagram.bmp', bmpCore, { width: 32, height: 48 }],
    ['BMP (BITMAPINFOHEADER)', 'diagram.bmp', bmpInfo, { width: 320, height: 240 }],
    ['ICO', 'icon.ico', ico, { width: 32, height: 48 }],
    ['SVG (px)', 'diagram.svg', svgPx, { width: 640, height: 480 }],
    ['SVG (unitless)', 'diagram.svg', svgUnitless, { width: 640, height: 480 }],
    [
      'BMP data URL (image/x-ms-bmp)',
      'data:image/x-ms-bmp;base64,Qk0=',
      bmpInfo,
      { width: 320, height: 240 },
    ],
    [
      'ICO data URL (image/x-icon)',
      'data:image/x-icon;base64,AAABAAEA',
      ico,
      { width: 32, height: 48 },
    ],
  ])('reads dimensions from supported %s input', (_, source, data, expected) => {
    expect(isSafeForImageDimensionParsing(source, data)).toBe(true);
    expect(readExportImageDimensions(source, data)).toEqual(expected);
  });

  it('treats a negative BMP height as top-down and returns its absolute value', () => {
    expect(isSafeForImageDimensionParsing('diagram.bmp', bmpInfoNegativeHeight)).toBe(true);
    expect(readExportImageDimensions('diagram.bmp', bmpInfoNegativeHeight)).toEqual({
      width: 320,
      height: 240,
    });
  });

  it('treats a zero ICO width/height byte as 256', () => {
    expect(isSafeForImageDimensionParsing('icon.ico', icoZeroMeans256)).toBe(true);
    expect(readExportImageDimensions('icon.ico', icoZeroMeans256)).toEqual({
      width: 256,
      height: 64,
    });
  });

  it('falls back to viewBox when SVG width/height are absent', () => {
    expect(isSafeForImageDimensionParsing('diagram.svg', svgViewBoxOnly)).toBe(true);
    expect(readExportImageDimensions('diagram.svg', svgViewBoxOnly)).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('returns undefined for a percentage SVG width with no viewBox fallback', () => {
    expect(isSafeForImageDimensionParsing('diagram.svg', svgPercentWidth)).toBe(true);
    expect(readExportImageDimensions('diagram.svg', svgPercentWidth)).toBeUndefined();
  });

  it('ignores data-width/data-height/data-viewBox decoys and reads the real viewBox', () => {
    expect(isSafeForImageDimensionParsing('diagram.svg', svgDecoyAttributesWithRealViewBox)).toBe(
      true
    );
    expect(readExportImageDimensions('diagram.svg', svgDecoyAttributesWithRealViewBox)).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('rejects a viewBox with hex components as malformed rather than misreading it', () => {
    expect(isSafeForImageDimensionParsing('diagram.svg', svgHexViewBox)).toBe(true);
    expect(readExportImageDimensions('diagram.svg', svgHexViewBox)).toBeUndefined();
  });

  it('accepts a viewBox with a negative min-x/min-y', () => {
    expect(isSafeForImageDimensionParsing('diagram.svg', svgNegativeViewBoxOrigin)).toBe(true);
    expect(readExportImageDimensions('diagram.svg', svgNegativeViewBoxOrigin)).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('rejects an HTML document with a non-root <svg> tag renamed to .svg', () => {
    expect(isSafeForImageDimensionParsing('embedded.svg', htmlWithNestedSvg)).toBe(false);
    expect(readExportImageDimensions('embedded.svg', htmlWithNestedSvg)).toBeUndefined();
  });

  it('reads the real root <svg> dimensions, not a decoy hidden inside a comment before it', () => {
    expect(isSafeForImageDimensionParsing('diagram.svg', svgCommentDecoyBeforeRealRoot)).toBe(true);
    expect(readExportImageDimensions('diagram.svg', svgCommentDecoyBeforeRealRoot)).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('returns undefined for a BMP with an unrecognized DIB header size (neither 12 nor >=40)', () => {
    expect(isSafeForImageDimensionParsing('diagram.bmp', bmpUnrecognizedDibHeaderSize)).toBe(true);
    expect(readExportImageDimensions('diagram.bmp', bmpUnrecognizedDibHeaderSize)).toBeUndefined();
  });

  it('returns undefined for a BMP declaring a DIB header size far larger than the available data', () => {
    expect(isSafeForImageDimensionParsing('diagram.bmp', bmpOversizedDibHeaderClaim)).toBe(true);
    expect(readExportImageDimensions('diagram.bmp', bmpOversizedDibHeaderClaim)).toBeUndefined();
  });

  it.each([
    ['PNG path', 'assets/DIAGRAM.PNG?revision=2#preview', png],
    ['JPEG path', 'C:\\docs\\PHOTO.JpEg?cache=1', jpeg],
    ['GIF path', '/tmp/ANIMATION.GiF#frame', gif],
    ['WebP path', './PHOTO.WeBp?width=600', vp8],
    ['PNG data URL', 'data:IMAGE/PNG;base64,iVBORw0KGgo=', png],
  ])('handles case-insensitive and query-safe supported %s hints', (_, source, data) => {
    expect(readExportImageDimensions(source, data)).toBeDefined();
  });

  it.each([
    ['empty data', new Uint8Array()],
    ['truncated SOI', Uint8Array.from([0xff])],
    ['truncated segment length', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00])],
    ['zero-length segment', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00])],
    ['one-byte segment', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01])],
    ['segment longer than the input', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00])],
    ['scan marker before a frame', Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02])],
    ['zero-width frame', jpegWithDimensions(0, 20)],
    ['zero-height frame', jpegWithDimensions(20, 0)],
  ])('returns undefined for malformed JPEG: %s', (_, data) => {
    expect(readExportImageDimensions('malformed.jpg', data)).toBeUndefined();
  });

  it('caps JPEG marker traversal before a late frame marker', () => {
    const restartMarkers = Array.from({ length: 5000 }, () => [0xff, 0xd0]).flat();
    const data = Uint8Array.from([0xff, 0xd8, ...restartMarkers, ...jpegStartOfFrame(40, 20)]);

    expect(readExportImageDimensions('bounded.jpg', data)).toBeUndefined();
  });

  it.each([
    ['truncated RIFF header', Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0])],
    ['truncated VP8 payload', webpChunk('VP8 ', [0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x10])],
    ['invalid VP8 frame signature', webpChunk('VP8 ', new Array(10).fill(0))],
    ['truncated VP8L payload', webpChunk('VP8L', [0x2f, 0x00, 0x00, 0x00])],
    ['invalid VP8L signature', webpChunk('VP8L', [0x00, 0x00, 0x00, 0x00, 0x00])],
    ['truncated VP8X payload', webpChunk('VP8X', new Array(9).fill(0))],
  ])('returns undefined for malformed WebP: %s', (_, data) => {
    expect(readExportImageDimensions('malformed.webp', data)).toBeUndefined();
  });

  it('rejects an allowlisted extension when its signature belongs to another format', () => {
    expect(readExportImageDimensions('renamed.png', jpeg)).toBeUndefined();
  });

  it.each([
    ['PNG', 'oversized.png', pngWithDimensions(0xffffffff, 10)],
    ['WebP VP8X', 'oversized.webp', vp8xWithDimensions(0x10000, 10)],
  ])('rejects impractical %s dimensions before they reach DOCX layout', (_, source, data) => {
    expect(readExportImageDimensions(source, data)).toBeUndefined();
  });
});
