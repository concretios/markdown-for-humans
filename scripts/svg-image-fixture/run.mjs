#!/usr/bin/env node
/** Local Chrome regression runner. Private assets are opt-in and remain outside the repository. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { runPdfExportFixture } from './pdf-export.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../..');
const temporary = await mkdtemp(join(tmpdir(), 'md4h-svg-browser-'));
const privateDirectory = process.env.MD4H_SVG_PRIVATE_DIR;
async function hashPrivateFiles() {
  if (!privateDirectory) return undefined;
  const files = [
    'deck-1-overview.md',
    ...(await readdir(join(privateDirectory, 'images'))).sort().map(name => join('images', name)),
  ];
  return Promise.all(
    files.map(async name =>
      createHash('sha256')
        .update(await readFile(join(privateDirectory, name)))
        .digest('hex')
    )
  );
}
const privateHashesBefore = await hashPrivateFiles();
const chrome =
  process.env.MD4H_CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const svg = attributes =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><rect width="1280" height="560" fill="#266cd3"/><circle cx="640" cy="280" r="150" fill="#f5c542"/></svg>`;
const assets = new Map([
  ['/assets/viewbox.svg', svg('viewBox="0 0 1280 560"')],
  [
    '/assets/diagram #1.svg',
    svg('viewBox="0 0 1280 560"').replace(
      '<rect',
      '<view id="overview" viewBox="0 0 1280 560"/><rect'
    ),
  ],
  ['/assets/percent.svg', svg('width="100%" height="100%" viewBox="0 0 1280 560"')],
  ['/assets/explicit.svg', svg('width="640" height="280" viewBox="0 0 1280 560"')],
  ['/assets/icon.svg', svg('width="24" height="24" viewBox="0 0 1280 560"')],
  ['/assets/malformed.svg', '<svg><not-closed>'],
  [
    '/assets/scripted.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><script>parent.document.body.setAttribute("data-svg-executed","true")</script><rect width="32" height="32" fill="green"/></svg>',
  ],
]);
// A 1x1 raster deliberately checks that the SVG layout fix does not enlarge raster images.
const raster = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64'
);
await build({
  absWorkingDir: repository,
  entryPoints: [join(directory, 'renderer.ts')],
  bundle: true,
  outfile: join(temporary, 'renderer.js'),
  platform: 'browser',
  format: 'iife',
  target: 'chrome132',
});
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let content;
    if (assets.has(pathname)) content = assets.get(pathname);
    else if (pathname === '/assets/raster.png') content = raster;
    else if (pathname === '/') content = await readFile(join(directory, 'index.html'));
    else if (pathname === '/editor.css')
      content = await readFile(join(repository, 'src/webview/editor.css'));
    else if (pathname === '/renderer.js') content = await readFile(join(temporary, 'renderer.js'));
    else if (privateDirectory && pathname === '/private-deck.md')
      content = await readFile(join(privateDirectory, 'deck-1-overview.md'));
    else if (privateDirectory && pathname === '/private-deck-2.md')
      content = await readFile(join(privateDirectory, 'deck-2-deep-dive.md'));
    else if (
      privateDirectory &&
      pathname.startsWith('/images/') &&
      basename(pathname) === pathname.slice('/images/'.length)
    )
      content = await readFile(join(privateDirectory, 'images', basename(pathname)));
    else {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.setHeader(
      'Content-Type',
      {
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.css': 'text/css',
        '.js': 'text/javascript',
      }[extname(pathname)] || 'text/html'
    );
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
let child;
let socket;
const pending = new Map();
let sequence = 0;
function send(method, params = {}) {
  return new Promise((resolveMessage, rejectMessage) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectMessage(new Error(`Chrome command timed out: ${method}`));
    }, 20000);
    pending.set(id, {
      resolve: value => {
        clearTimeout(timeout);
        resolveMessage(value);
      },
      reject: error => {
        clearTimeout(timeout);
        rejectMessage(error);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description
    );
  return result.result.value;
}
try {
  child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-proxy-server',
      '--host-resolver-rules=MAP file+.vscode-resource.vscode-cdn.net 127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${join(temporary, 'profile')}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  const endpoint = await new Promise((resolveEndpoint, rejectEndpoint) => {
    let stderr = '';
    const timeout = setTimeout(() => rejectEndpoint(new Error('Chrome launch timed out')), 15000);
    child.once('error', rejectEndpoint);
    child.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolveEndpoint(match[1]);
      }
    });
  });
  const devtools = new URL(endpoint);
  const pages = await fetch(`http://${devtools.host}/json/list`).then(response => response.json());
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message));
    else callback.resolve(message.result);
  });
  await send('Page.enable');
  await send('Page.navigate', { url: origin });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate('Boolean(window.fixtureReady)')) break;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  const matrix = [];
  for (const [width, deviceScaleFactor] of [
    [1200, 1],
    [420, 1],
    [1200, 2],
  ]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor,
      mobile: false,
    });
    for (const theme of ['light', 'dark', 'high-contrast']) {
      const result = await evaluate(`window.runSvgFixture(${JSON.stringify(theme)})`);
      const { exportHtml, ...report } = result;
      matrix.push({ width, deviceScaleFactor, theme, ...report });
      await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }).then(
        result =>
          writeFile(
            join(temporary, `${width}-${theme}-${deviceScaleFactor}x.png`),
            Buffer.from(result.data, 'base64')
          )
      );
    }
  }
  const sizeFlow = await evaluate('window.runSvgSizeFlow()');
  let capture;
  try {
    const { dataUrl, marker } = await evaluate('window.captureSvgFixture()');
    const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
    if (bytes.length < 24) throw new Error('Capture produced an empty PNG.');
    const markerMatches = marker.every(
      (value, index) => Math.abs(value - [38, 108, 211, 255][index]) <= 3
    );
    capture = {
      passed: bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 && markerMatches,
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      marker,
    };
    await writeFile(join(temporary, 'capture.png'), bytes);
  } catch (error) {
    capture = { passed: false, error: error.message };
  }
  const pdf = await send('Page.printToPDF', { printBackground: true });
  await writeFile(join(temporary, 'fixture.pdf'), Buffer.from(pdf.data, 'base64'));
  const productionPdf = await runPdfExportFixture({
    repository,
    temporary,
    chrome,
    html: await evaluate('window.collectSvgPdfFixture()'),
    svgSource: assets.get('/assets/diagram #1.svg'),
  });
  const privateResults = [];
  if (privateDirectory) {
    for (const width of [1200, 420]) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      for (const theme of ['light', 'dark', 'high-contrast']) {
        const { exportHtml, ...result } = await evaluate(
          `window.runSvgFixture(${JSON.stringify(theme)}, true)`
        );
        privateResults.push({ width, theme, ...result });
      }
    }
  }
  let deck2 = { present: false, passed: true, checks: {} };
  if (privateDirectory) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1200,
      height: 1400,
      deviceScaleFactor: 1,
      mobile: false,
    });
    deck2 = await evaluate('window.measureDeck2Sizing()');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 420,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const narrowDeck2 = await evaluate('window.measureDeck2Sizing()');
    deck2 = {
      present: deck2.present,
      passed: deck2.passed && narrowDeck2.passed,
      checks: { wide: deck2.checks, narrow: narrowDeck2.checks },
      wide: deck2.images,
      narrow: narrowDeck2.images,
    };
  }
  const privateFilesUnchanged =
    JSON.stringify(privateHashesBefore) === JSON.stringify(await hashPrivateFiles());
  const result = {
    passed:
      matrix.every(result => result.passed) &&
      privateResults.every(result => result.passed) &&
      deck2.passed &&
      capture.passed &&
      sizeFlow.passed &&
      privateFilesUnchanged &&
      productionPdf.passed,
    runtime: await evaluate('navigator.userAgent'),
    matrix,
    sizeFlow,
    capture,
    productionPdf,
    privateResults,
    deck2,
    ...(privateDirectory ? { privateFilesUnchanged } : {}),
    outputDirectory: temporary,
  };
  await writeFile(join(temporary, 'result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.passed ? 0 : 1;
} finally {
  socket?.close();
  child?.kill('SIGTERM');
  if (child && child.exitCode === null) {
    await Promise.race([
      new Promise(resolveExit => child.once('exit', resolveExit)),
      new Promise(resolveTimeout => setTimeout(resolveTimeout, 2000)),
    ]);
  }
  server.close();
  if (process.env.MD4H_KEEP_FIXTURE !== '1') await rm(temporary, { recursive: true, force: true });
}
