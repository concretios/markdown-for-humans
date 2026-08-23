const { app, BrowserWindow } = require('electron');
const { writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const resultPath = process.env.MD4H_FEEDBACK_CAPTURE_RESULT;

async function finish(result, exitCode) {
  if (resultPath) {
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  app.exit(exitCode);
}

app.whenReady().then(async () => {
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

  await window.loadFile(join(__dirname, 'index.html'));

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
      fixtures: ['local SVG image', 'table', 'actual Mermaid output', 'actual KaTeX output'],
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
