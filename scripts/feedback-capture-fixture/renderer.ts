import katex from 'katex';
import mermaid from 'mermaid';
import { domToPng } from 'modern-screenshot';
import { createModernScreenshotRasterizer } from '../../src/webview/features/feedbackDomCapture';

type FixtureTheme = 'light' | 'dark' | 'high-contrast';
type Rgba = [number, number, number, number];

interface CaptureResult {
  zoom: number;
  theme: FixtureTheme;
  devicePixelRatio: number;
  cssWidth: number;
  cssHeight: number;
  pngWidth: number;
  pngHeight: number;
  bytes: number;
  signature: string;
  localImageLoaded: boolean;
  localPngLoaded: boolean;
  markers: {
    localImage: Rgba;
    localPng: Rgba;
    table: Rgba;
  };
  rendered: {
    mermaid: { svg: boolean; nodes: number; nonBackgroundPixels: number };
    katex: { root: boolean; glyphs: number; nonBackgroundPixels: number };
  };
  passed: boolean;
}

declare global {
  interface Window {
    fixtureReady?: boolean;
    runFixtureCapture?: (zoom: number, theme: FixtureTheme) => Promise<CaptureResult>;
  }
}

let renderSequence = 0;

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) {
    throw new Error('Capture does not have a valid PNG signature.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function pngDataUrlToBlob(dataUrl: string): Blob {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) throw new Error('Capture did not return a PNG data URL.');
  const binary = atob(dataUrl.slice(prefix.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: 'image/png' });
}

function themeVariables(theme: FixtureTheme): Record<string, string> {
  if (theme === 'light') {
    return {
      background: '#ffffff',
      primaryColor: '#dbeafe',
      primaryBorderColor: '#2563eb',
      primaryTextColor: '#111827',
      lineColor: '#374151',
      secondaryColor: '#dcfce7',
      tertiaryColor: '#fef3c7',
    };
  }
  if (theme === 'dark') {
    return {
      background: '#1e1f22',
      primaryColor: '#1e3a5f',
      primaryBorderColor: '#75b7ff',
      primaryTextColor: '#f3f4f6',
      lineColor: '#d1d5db',
      secondaryColor: '#14532d',
      tertiaryColor: '#713f12',
    };
  }
  return {
    background: '#000000',
    primaryColor: '#000000',
    primaryBorderColor: '#ffffff',
    primaryTextColor: '#ffffff',
    lineColor: '#ffffff',
    secondaryColor: '#000000',
    tertiaryColor: '#000000',
  };
}

async function renderRichFixtures(theme: FixtureTheme): Promise<{
  mermaid: HTMLElement;
  katex: HTMLElement;
}> {
  document.body.dataset.fixtureTheme = theme;
  const mermaidOutput = document.querySelector<HTMLElement>('[data-mermaid-output]');
  const katexOutput = document.querySelector<HTMLElement>('[data-katex-output]');
  if (!mermaidOutput || !katexOutput) {
    throw new Error('Rendered Mermaid or KaTeX fixture container is missing.');
  }

  renderSequence += 1;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: themeVariables(theme),
    fontFamily: 'system-ui, sans-serif',
  });
  const diagram = await mermaid.render(
    `feedbackFixture${renderSequence}`,
    'flowchart LR\n  Draft[Draft] --> Sealed[Sealed]'
  );
  mermaidOutput.innerHTML = diagram.svg;
  diagram.bindFunctions?.(mermaidOutput);

  katex.render(String.raw`E = mc^2 + \frac{a}{b}`, katexOutput, {
    displayMode: true,
    throwOnError: true,
    output: 'htmlAndMathml',
  });

  return { mermaid: mermaidOutput, katex: katexOutput };
}

async function waitForFixture(theme: FixtureTheme): Promise<{
  image: HTMLImageElement;
  png: HTMLImageElement;
  mermaid: HTMLElement;
  katex: HTMLElement;
}> {
  const rendered = await renderRichFixtures(theme);
  await document.fonts.ready;
  const image = document.querySelector<HTMLImageElement>('[data-local-image]');
  const png = document.querySelector<HTMLImageElement>('[data-local-png]');
  if (!image) throw new Error('Local fixture image is missing.');
  if (!png) throw new Error('Local PNG fixture image is missing.');
  if (!image.src) {
    const resourcePort = new URLSearchParams(window.location.search).get('resourcePort');
    if (!resourcePort) throw new Error('The webview resource fixture port is missing.');
    image.src = `http://file+.vscode-resource.vscode-cdn.net:${resourcePort}/assets/local-image.svg`;
    png.src = `http://file+.vscode-resource.vscode-cdn.net:${resourcePort}/assets/local-image.png`;
  }
  await Promise.all([image.decode(), png.decode()]);
  await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()));
  await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()));
  return { image, png, ...rendered };
}

function parseCssColor(value: string): Rgba {
  const components = value.match(/[\d.]+/g)?.map(Number) ?? [];
  if (components.length < 3) throw new Error(`Cannot parse fixture color: ${value}`);
  return [components[0], components[1], components[2], Math.round((components[3] ?? 1) * 255)];
}

function runPixelChecks(
  bitmap: ImageBitmap,
  fixtureBounds: DOMRect,
  targets: {
    image: HTMLElement;
    png: HTMLElement;
    table: HTMLElement;
    mermaid: HTMLElement;
    katex: HTMLElement;
  }
): {
  markers: CaptureResult['markers'];
  mermaidNonBackgroundPixels: number;
  katexNonBackgroundPixels: number;
} {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not create a 2D context for fixture verification.');
  context.drawImage(bitmap, 0, 0);

  const relativeRectangle = (element: HTMLElement): DOMRect => {
    const bounds = element.getBoundingClientRect();
    return new DOMRect(
      bounds.left - fixtureBounds.left,
      bounds.top - fixtureBounds.top,
      bounds.width,
      bounds.height
    );
  };
  const sample = (target: HTMLElement, x: number, y: number): Rgba => {
    const bounds = relativeRectangle(target);
    const pixel = context.getImageData(
      Math.max(0, Math.floor(bounds.left + x)),
      Math.max(0, Math.floor(bounds.top + y)),
      1,
      1
    ).data;
    return [...pixel] as Rgba;
  };
  const countNonBackground = (target: HTMLElement): number => {
    const bounds = relativeRectangle(target);
    const inset = 10;
    const left = Math.max(0, Math.floor(bounds.left + inset));
    const top = Math.max(0, Math.floor(bounds.top + inset));
    const width = Math.max(1, Math.min(canvas.width - left, Math.floor(bounds.width - inset * 2)));
    const height = Math.max(
      1,
      Math.min(canvas.height - top, Math.floor(bounds.height - inset * 2))
    );
    const pixels = context.getImageData(left, top, width, height).data;
    const background = parseCssColor(getComputedStyle(target).backgroundColor);
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const differs = [0, 1, 2, 3].some(
        component => Math.abs(pixels[index + component] - background[component]) > 12
      );
      if (differs) count += 1;
    }
    return count;
  };

  const tableBounds = targets.table.getBoundingClientRect();
  const result = {
    markers: {
      localImage: sample(targets.image, 5, 5),
      localPng: sample(targets.png, 100, 60),
      table: sample(targets.table, 5, tableBounds.height - 5),
    },
    mermaidNonBackgroundPixels: countNonBackground(targets.mermaid),
    katexNonBackgroundPixels: countNonBackground(targets.katex),
  };
  canvas.width = 0;
  canvas.height = 0;
  return result;
}

async function runCapture(zoom: number, theme: FixtureTheme): Promise<CaptureResult> {
  const fixture = document.querySelector<HTMLElement>('[data-capture-fixture]');
  if (!fixture) throw new Error('Capture fixture root is missing.');

  const { image, png, mermaid: mermaidOutput, katex: katexOutput } = await waitForFixture(theme);
  const tableMarker = document.querySelector<HTMLElement>('[data-table-marker]');
  if (!tableMarker) throw new Error('The rendered table marker is missing.');
  const mermaidSvg = mermaidOutput.querySelector<SVGSVGElement>('svg');
  const mermaidNodes = mermaidOutput.querySelectorAll('.node').length;
  const katexRoot = katexOutput.querySelector<HTMLElement>('.katex');
  const katexGlyphs = katexOutput.querySelectorAll<HTMLElement>('.katex-html .mord').length;
  await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()));

  const bounds = fixture.getBoundingClientRect();
  const capture = await createModernScreenshotRasterizer(domToPng)({
    root: fixture,
    rectangle: {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    },
    scale: 1,
  });
  const blob = pngDataUrlToBlob(capture.dataUrl);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const dimensions = readPngDimensions(bytes);
  const cssWidth = Math.floor(bounds.width);
  const cssHeight = Math.floor(bounds.height);
  const signature = [...bytes.slice(0, 8)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
  const bitmap = await createImageBitmap(blob);
  const pixelChecks = runPixelChecks(bitmap, bounds, {
    image,
    png,
    table: tableMarker,
    mermaid: mermaidOutput,
    katex: katexOutput,
  });
  bitmap.close();

  const colorMatches = (actual: Rgba, expected: Rgba, tolerance = 10): boolean =>
    actual.every((component, index) => Math.abs(component - expected[index]) <= tolerance);
  const rendered = {
    mermaid: {
      svg: mermaidSvg !== null,
      nodes: mermaidNodes,
      nonBackgroundPixels: pixelChecks.mermaidNonBackgroundPixels,
    },
    katex: {
      root: katexRoot !== null,
      glyphs: katexGlyphs,
      nonBackgroundPixels: pixelChecks.katexNonBackgroundPixels,
    },
  };
  const passed =
    image.complete &&
    image.naturalWidth > 0 &&
    png.complete &&
    png.naturalWidth > 0 &&
    blob.type === 'image/png' &&
    signature === '89504e470d0a1a0a' &&
    dimensions.width === cssWidth &&
    dimensions.height === cssHeight &&
    capture.width === cssWidth &&
    capture.height === cssHeight &&
    colorMatches(pixelChecks.markers.localImage, [255, 0, 255, 255]) &&
    pixelChecks.markers.localPng[3] === 255 &&
    pixelChecks.markers.localPng.slice(0, 3).some(component => component < 245) &&
    colorMatches(pixelChecks.markers.table, [0, 255, 0, 255]) &&
    rendered.mermaid.svg &&
    rendered.mermaid.nodes >= 2 &&
    rendered.mermaid.nonBackgroundPixels > 100 &&
    rendered.katex.root &&
    rendered.katex.glyphs >= 4 &&
    rendered.katex.nonBackgroundPixels > 100 &&
    bytes.byteLength > 1_000;

  return {
    zoom,
    theme,
    devicePixelRatio: window.devicePixelRatio,
    cssWidth,
    cssHeight,
    pngWidth: dimensions.width,
    pngHeight: dimensions.height,
    bytes: bytes.byteLength,
    signature,
    localImageLoaded: image.complete && image.naturalWidth > 0,
    localPngLoaded: png.complete && png.naturalWidth > 0,
    markers: pixelChecks.markers,
    rendered,
    passed,
  };
}

window.runFixtureCapture = runCapture;
waitForFixture('light').then(() => {
  window.fixtureReady = true;
});
