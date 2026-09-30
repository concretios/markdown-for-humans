import * as path from 'path';
import {
  encodeImageFilePath,
  hasSvgRootSignature,
  isSvgImageSource,
  splitImageSource,
} from '../../shared/imageSource';

describe('image source capability and URL boundaries', () => {
  it.each([
    ['./images/chart.svg', './images/chart.svg'],
    ['../assets#one/diagram?rev.svg', '../assets%23one/diagram%3Frev.svg'],
    ['./percent%23/diagram%2F.svg', './percent%2523/diagram%252F.svg'],
    ['./My Assets/图 表.svg', './My%20Assets/%E5%9B%BE%20%E8%A1%A8.svg'],
    ["./images/a'b(1)!*.svg", './images/a%27b%281%29%21%2A.svg'],
    ['C:\\assets#one\\diagram%23.svg', 'C:/assets%23one/diagram%2523.svg'],
    ['\\\\server\\share#one\\diagram%23.svg', '//server/share%23one/diagram%2523.svg'],
  ])('encodes raw filesystem path %s without interpreting URL syntax', (filePath, expected) => {
    expect(encodeImageFilePath(filePath)).toBe(expected);
    expect(splitImageSource(encodeImageFilePath(filePath)).suffix).toBe('');
  });

  it('preserves Windows relative filesystem identity after one URL decode', () => {
    const base = 'C:\\workspace\\docs';
    const file = 'C:\\workspace\\assets#one\\diagram%23.svg';
    const destination = encodeImageFilePath(path.win32.relative(base, file));
    expect(destination).toBe('../assets%23one/diagram%2523.svg');
    expect(path.win32.resolve(base, decodeURIComponent(destination))).toBe(file);
  });

  it.each([
    ['diagram.svg?rev=2#view', 'diagram.svg', '?rev=2#view'],
    ['diagram%23v.svg#view?detail', 'diagram%23v.svg', '#view?detail'],
    ['C:\\Images\\diagram.svg#view', 'C:\\Images\\diagram.svg', '#view'],
    ['a%3Fb.svg', 'a%3Fb.svg', ''],
  ])('splits %s before percent decoding', (source, pathname, suffix) => {
    expect(splitImageSource(source)).toEqual({ path: pathname, suffix });
  });

  it.each([
    ['images/chart.SVG?rev=1#overview', ''],
    ['https://example.com/chart.svg#view', ''],
    ['diagram', 'image/svg+xml; charset=utf-8'],
    ['diagram', 'IMAGE/SVG+XML'],
    ['data:image/svg+xml;base64,PHN2Zz4=', ''],
    ['diagram.svg', 'application/octet-stream'],
  ])('recognizes vector source %s (%s)', (source, mime) => {
    expect(isSvgImageSource(source, mime)).toBe(true);
  });

  it.each(['photo.png?file=.svg', 'photo.svg.png', 'data:image/png;base64,c3Zn'])(
    'does not classify raster source %s as SVG',
    source => {
      expect(isSvgImageSource(source)).toBe(false);
    }
  );

  it.each([
    '<svg/>',
    '\ufeff <?xml version="1.0"?><svg viewBox="0 0 10 10"></svg>',
    '<!-- Generated --><!DOCTYPE svg [<!ENTITY x "a>b">]><svg xmlns="http://www.w3.org/2000/svg"/>',
  ])('detects a root SVG with a supported XML prolog', source => {
    expect(hasSvgRootSignature(source)).toBe(true);
  });

  it.each([
    '<html><svg/></html>',
    '<svgish/>',
    '<!--<svg/>',
    ' '.repeat(4096) + '<svg/>',
    '\u0089PNG\r\n',
  ])('rejects a non-root or unavailable bounded signature', source => {
    expect(hasSvgRootSignature(source)).toBe(false);
  });
});
