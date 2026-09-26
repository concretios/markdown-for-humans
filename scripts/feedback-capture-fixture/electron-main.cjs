const { app, BrowserWindow } = require('electron');
const { createReadStream } = require('node:fs');
const { createServer } = require('node:http');
const { writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const resultPath = process.env.MD4H_FEEDBACK_CAPTURE_RESULT;
let resourceServer;

app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP file+.vscode-resource.vscode-cdn.net 127.0.0.1'
);

async function finish(result, exitCode) {
  if (resultPath) {
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  resourceServer?.close();
  app.exit(exitCode);
}

app.whenReady().then(async () => {
  resourceServer = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    const assetName =
      request.url === '/assets/local-image.svg'
        ? 'local-image.svg'
        : request.url === '/assets/local-image.png'
          ? 'local-image.png'
          : null;
    if (!assetName) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader('Content-Type', assetName.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
    createReadStream(join(__dirname, 'assets', assetName)).pipe(response);
  });
  await new Promise((resolve, reject) => {
    resourceServer.once('error', reject);
    resourceServer.listen(0, '127.0.0.1', resolve);
  });
  const address = resourceServer.address();
  if (!address || typeof address === 'string') throw new Error('Resource server did not bind.');

  const window = new BrowserWindow({
    width: 1100,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.on('render-process-gone', async (_event, details) => {
    await finish(
      {
        passed: false,
        error: `Renderer process exited: ${details.reason} (${details.exitCode})`,
      },
      1
    );
  });

  await window.loadFile(join(__dirname, 'index.html'), {
    query: { resourcePort: String(address.port) },
  });

  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await window.webContents.executeJavaScript('Boolean(window.fixtureReady)');
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  if (!ready) {
    await finish({ passed: false, error: 'Renderer fixture timed out.' }, 1);
    return;
  }

  try {
    const results = [];
    const themes = ['light', 'dark', 'high-contrast'];
    const zooms = [1, 1.25, 2];
    for (const theme of themes) {
      for (const zoom of zooms) {
        window.webContents.setZoomFactor(zoom);
        await new Promise(resolve => setTimeout(resolve, 100));
        results.push(
          await window.webContents.executeJavaScript(
            `window.runFixtureCapture(${zoom}, ${JSON.stringify(theme)})`
          )
        );
      }
    }

    const result = {
      passed:
        process.versions.electron === process.env.MD4H_EXPECTED_ELECTRON_VERSION &&
        results.every(capture => capture.passed),
      runtime: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
      },
      expectedElectron: process.env.MD4H_EXPECTED_ELECTRON_VERSION,
      library: 'modern-screenshot@4.7.0',
      matrix: { themes, zooms },
      fixtures: [
        'local SVG and PNG images',
        'table',
        'actual Mermaid output',
        'actual KaTeX output',
      ],
      results,
    };
    await finish(result, result.passed ? 0 : 1);
  } catch (error) {
    await finish(
      {
        passed: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      },
      1
    );
  }
});

app.on('window-all-closed', () => app.quit());
