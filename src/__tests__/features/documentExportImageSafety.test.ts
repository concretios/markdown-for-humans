/**
 * Word export image-dimension safety tests.
 *
 * Dimension reads run on the extension host, so this boundary must stay
 * dependency-free, synchronous, and structurally bounded. Only PNG, JPEG,
 * GIF, and WebP sources with matching signatures are inspected.
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

const png = pngWithDimensions(640, 480);
const jpeg = jpegWithDimensions(1024, 768);
const gif = gifWithDimensions(320, 200);
const vp8 = vp8WithDimensions(800, 600);
const vp8l = vp8lWithDimensions(511, 257);
const vp8x = vp8xWithDimensions(1920, 1080);

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
  ])('reads dimensions from supported %s input', (_, source, data, expected) => {
    expect(isSafeForImageDimensionParsing(source, data)).toBe(true);
    expect(readExportImageDimensions(source, data)).toEqual(expected);
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
