const { app, BrowserWindow } = require('electron');
const { mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const resultPath = process.env.MD4H_FEEDBACK_ANNOTATION_RESULT;
const artifactDirectory = process.env.MD4H_FEEDBACK_ANNOTATION_ARTIFACTS;
let finishing = false;

async function finish(result, exitCode) {
  if (finishing) return;
  finishing = true;
  if (resultPath) {
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  app.exit(exitCode);
}

function artifactSlug(value) {
  return value
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

async function writeFailureArtifacts(window, name, result) {
  if (!artifactDirectory) return [];
  await mkdir(artifactDirectory, { recursive: true });
  const slug = artifactSlug(name);
  const screenshotPath = join(artifactDirectory, `${slug}.png`);
  const htmlPath = join(artifactDirectory, `${slug}.html`);
  const jsonPath = join(artifactDirectory, `${slug}.json`);
  const screenshot = await window.webContents.capturePage();
  const html = await window.webContents.executeJavaScript('document.documentElement.outerHTML');
  await Promise.all([
    writeFile(screenshotPath, screenshot.toPNG()),
    writeFile(htmlPath, html, 'utf8'),
    writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8'),
  ]);
  return [screenshotPath, htmlPath, jsonPath];
}

async function setScenarioEnvironment(window, config) {
  const cssWidth = config.viewport === 'narrow' ? 760 : 1280;
  const cssHeight = 900;
  window.webContents.setZoomFactor(1);
  window.setContentSize(Math.ceil(cssWidth * config.zoom), Math.ceil(cssHeight * config.zoom));
  window.webContents.setZoomFactor(config.zoom);
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [
      {
        name: 'prefers-reduced-motion',
        value: config.reducedMotion ? 'reduce' : 'no-preference',
      },
    ],
  });
  await new Promise(resolve => setTimeout(resolve, 120));
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
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

  try {
    window.webContents.debugger.attach('1.3');
    await window.loadFile(join(__dirname, 'index.html'));

    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await window.webContents.executeJavaScript('Boolean(window.fixtureReady)');
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error('Renderer fixture timed out.');

    const themes = ['light', 'dark', 'high-contrast'];
    const zooms = [1, 1.25, 2];
    const scenarios = [];
    for (const theme of themes) {
      for (const zoom of zooms) {
        scenarios.push({
          id: `wide-${theme}-${Math.round(zoom * 100)}`,
          theme,
          viewport: 'wide',
          zoom,
          reducedMotion: false,
        });
      }
    }
    for (const theme of themes) {
      scenarios.push({
        id: `narrow-${theme}-100`,
        theme,
        viewport: 'narrow',
        zoom: 1,
        reducedMotion: false,
      });
    }
    for (const theme of ['light', 'high-contrast']) {
      scenarios.push({
        id: `reduced-motion-${theme}-100`,
        theme,
        viewport: 'wide',
        zoom: 1,
        reducedMotion: true,
      });
    }

    const results = [];
    const failureArtifacts = [];
    for (const scenario of scenarios) {
      await setScenarioEnvironment(window, scenario);
      const scenarioResult = await window.webContents.executeJavaScript(
        `window.runAnnotationScenario(${JSON.stringify(scenario)})`
      );
      results.push(scenarioResult);
      if (!scenarioResult.passed) {
        failureArtifacts.push(
          ...(await writeFailureArtifacts(window, scenario.id, scenarioResult))
        );
      }
    }

    const stressConfig = {
      id: 'stress-10000-lines-500-comments',
      theme: 'light',
      viewport: 'wide',
      zoom: 1,
      reducedMotion: false,
    };
    await setScenarioEnvironment(window, stressConfig);
    const stress = await window.webContents.executeJavaScript('window.runAnnotationStress()');
    if (!stress.passed) {
      failureArtifacts.push(...(await writeFailureArtifacts(window, stressConfig.id, stress)));
    }

    const realControllerConfig = {
      id: 'real-controller-narrow-high-contrast',
      theme: 'high-contrast',
      viewport: 'narrow',
      zoom: 1,
      reducedMotion: false,
    };
    await setScenarioEnvironment(window, realControllerConfig);
    const realController = await window.webContents.executeJavaScript(
      'window.runRealControllerScenario()'
    );
    if (!realController.passed) {
      failureArtifacts.push(
        ...(await writeFailureArtifacts(window, realControllerConfig.id, realController))
      );
    }

    const runtimeMatches = process.versions.electron === process.env.MD4H_EXPECTED_ELECTRON_VERSION;
    const result = {
      passed:
        runtimeMatches &&
        results.every(scenario => scenario.passed) &&
        stress.passed &&
        realController.passed,
      runtime: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
      },
      expectedElectron: process.env.MD4H_EXPECTED_ELECTRON_VERSION,
      runtimeMatches,
      matrix: {
        wide: { themes, zooms },
        narrow: { themes, zooms: [1] },
        reducedMotion: { themes: ['light', 'high-contrast'], zooms: [1] },
      },
      content: [
        '3,000+ words',
        'repeated text and dense collisions',
        'marks and links',
        'code and table',
        'local image and screenshot preview',
        'actual Mermaid output',
        'actual KaTeX output',
        'multi-block and top/middle/EOF targets',
      ],
      results,
      stress,
      realController,
      harness: {
        matrix:
          'Parallel DOM harness using the production layout module and production editor stylesheet.',
        integration:
          'Additional real TipTap and createFeedbackReviewController scenario for controller lifecycle invariants.',
        limitation:
          'The full 14-case visual matrix does not mount the complete VS Code webview bootstrap or extension host.',
      },
      failureArtifacts,
    };
    await finish(result, result.passed ? 0 : 1);
  } catch (error) {
    const failure = {
      passed: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
    let failureArtifacts = [];
    try {
      failureArtifacts = await writeFailureArtifacts(window, 'fixture-exception', failure);
    } catch (artifactError) {
      failure.artifactError =
        artifactError instanceof Error ? artifactError.message : String(artifactError);
    }
    await finish({ ...failure, failureArtifacts }, 1);
  }
});

app.on('window-all-closed', () => app.quit());
