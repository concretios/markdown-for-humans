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

// Drive Chromium input rather than dispatchEvent, which cannot perform native selection.
async function verifyNativeSelections(window) {
  const results = [];
  for (let caseIndex = 0; caseIndex < 4; caseIndex++) {
    for (const reverse of [false, true]) {
      const selected = [];
      let name;
      for (const feedback of [false, true]) {
        const gesture = await window.webContents.executeJavaScript(
          `window.prepareNativeSelection(${caseIndex}, ${feedback}, ${reverse})`
        );
        name = gesture.name;
        const send = parameters =>
          window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', parameters);
        await send({ type: 'mouseMoved', ...gesture.start });
        await send({
          type: 'mousePressed',
          ...gesture.start,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        for (let step = 1; step <= 20; step++) {
          const portion = step / 20;
          await send({
            type: 'mouseMoved',
            x: gesture.start.x + (gesture.end.x - gesture.start.x) * portion,
            y: gesture.start.y + (gesture.end.y - gesture.start.y) * portion,
            button: 'left',
            buttons: 1,
          });
          await new Promise(resolve => setTimeout(resolve, 8));
        }
        await send({
          type: 'mouseReleased',
          ...gesture.end,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        selected.push(
          await window.webContents.executeJavaScript('window.getSelection().toString()')
        );
      }
      results.push({
        name,
        reverse,
        editing: selected[0],
        feedback: selected[1],
        passed: selected[0].trim().length > 0 && selected[0] === selected[1],
      });
    }
  }
  return { passed: results.every(result => result.passed), results };
}

// Preserve the same hover target while wheel input moves its top out of view.
// No click or selection API is used to make an otherwise missing rail reappear.
async function verifyNativeRailScroll(window) {
  const results = [];
  const send = parameters =>
    window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', parameters);
  const inspect = () => window.webContents.executeJavaScript('window.inspectNativeRailScroll()');
  const settle = () => new Promise(resolve => setTimeout(resolve, 180));
  const record = async (name, expectedLabel, extra = true) => {
    const state = await inspect();
    results.push({
      name,
      ...state,
      passed:
        extra && state.railVisible && state.selectionEmpty && state.railLabel === expectedLabel,
    });
    return state;
  };
  let state = await window.webContents.executeJavaScript('window.prepareNativeRailScroll()');
  if (!state.tablePoint) throw new Error('Scroll fixture table is outside the initial viewport');
  await send({ type: 'mouseMoved', ...state.tablePoint });
  await settle();
  state = await record(
    'hover-long-table',
    'Add feedback to this table',
    state.tableHeight > state.viewportHeight * 2
  );
  const beforeScroll = state.scrollY;
  await send({ type: 'mouseWheel', ...state.tablePoint, deltaX: 0, deltaY: 700 });
  await settle();
  state = await inspect();
  await record(
    'wheel-within-same-table',
    'Add feedback to this table',
    state.scrollY > beforeScroll + 300
  );

  await send({ type: 'mouseWheel', ...state.tablePoint, deltaX: 0, deltaY: 100000 });
  await settle();
  state = await inspect();
  for (let index = 0; index < 3; index++) {
    const point = state.paragraphPoints[index];
    if (!point) {
      results.push({
        name: `hover-following-paragraph-${index + 1}`,
        passed: false,
        error: 'Paragraph not visible after native wheel to EOF',
      });
      continue;
    }
    await send({ type: 'mouseMoved', ...point });
    await settle();
    state = await record(`hover-following-paragraph-${index + 1}`, 'Add feedback to this block');
  }

  await send({ type: 'mouseWheel', x: 250, y: 450, deltaX: 0, deltaY: -700 });
  await settle();
  state = await inspect();
  if (!state.tablePoint) throw new Error('Scroll fixture table unavailable when scrolling back');
  await send({ type: 'mouseMoved', ...state.tablePoint });
  await settle();
  await record('scroll-back-to-table', 'Add feedback to this table');
  await send({ type: 'mouseWheel', ...state.tablePoint, deltaX: 0, deltaY: -100000 });
  await settle();
  state = await inspect();
  if (!state.headingPoint)
    throw new Error('Scroll fixture heading unavailable after native wheel to top');
  await send({ type: 'mouseMoved', ...state.headingPoint });
  await settle();
  await record(
    'scroll-back-to-heading',
    'Add feedback to section Project truth, read on demand, including subsections'
  );
  return { passed: results.every(result => result.passed), results };
}

// Native cancellation recreates decorated blocks. Every affected block must
// remain targetable, and ordinary text selection must still work afterwards.
async function verifyNativeRailRecovery(window) {
  const results = [];
  const send = parameters =>
    window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', parameters);
  const inspect = () => window.webContents.executeJavaScript('window.inspectNativeRailRecovery()');
  const settle = () => new Promise(resolve => setTimeout(resolve, 120));
  const move = async point => {
    if (!point) throw new Error('Recovery fixture target is outside the viewport');
    await send({ type: 'mouseMoved', ...point });
    await settle();
  };
  const click = async point => {
    await move(point);
    await send({ type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    await send({ type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
    await settle();
  };
  const record = async (name, expectedLabel) => {
    const state = await inspect();
    results.push({
      name,
      ...state,
      passed: state.railVisible && state.selectionEmpty && state.railLabel === expectedLabel,
    });
    return state;
  };
  let state = await window.webContents.executeJavaScript('window.prepareNativeRailRecovery()');
  await click(state.headingPoint);
  state = await record(
    'heading-before-section-composer',
    'Add feedback to section Project truth, read on demand, including subsections'
  );
  await click(state.railPoint);
  state = await inspect();
  results.push({
    name: 'section-composer-replaces-only-section-dom',
    ...state,
    passed:
      state.composerOpen &&
      [0, 1, 2, 3, 4].every(ordinal => state.replacedOrdinals.includes(ordinal)) &&
      !state.replacedOrdinals.includes(5) &&
      !state.replacedOrdinals.includes(6),
  });
  await click(state.cancelPoint);
  state = await inspect();
  results.push({ name: 'native-cancel-closes-composer', passed: !state.composerOpen });
  // Cancel can leave a collapsed native caret in review chrome. Clicking prose
  // restores the normal eligibility precondition without manipulating Selection.
  await click(state.headingPoint);
  state = await record(
    'heading-after-section-cancel',
    'Add feedback to section Project truth, read on demand, including subsections'
  );
  await move(state.tablePoint);
  state = await record('table-after-section-cancel', 'Add feedback to this table');
  for (let index = 0; index < 3; index++) {
    await move(state.paragraphPoints[index]);
    state = await record(
      `paragraph-${index + 1}-after-section-cancel`,
      'Add feedback to this block'
    );
  }
  await move(state.outsideHeadingPoint);
  state = await record(
    'outside-heading-after-section-cancel',
    'Add feedback to section Outside section, including subsections'
  );
  await move(state.paragraphPoints[3]);
  state = await record('outside-paragraph-after-section-cancel', 'Add feedback to this block');
  const gesture = state.drag;
  await move(gesture.start);
  await send({ type: 'mousePressed', ...gesture.start, button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 20; step++) {
    const fraction = step / 20;
    await send({
      type: 'mouseMoved',
      x: gesture.start.x + (gesture.end.x - gesture.start.x) * fraction,
      y: gesture.start.y + (gesture.end.y - gesture.start.y) * fraction,
      button: 'left',
      buttons: 1,
    });
  }
  await send({ type: 'mouseReleased', ...gesture.end, button: 'left', buttons: 0, clickCount: 1 });
  await settle();
  state = await inspect();
  results.push({
    name: 'partial-drag-after-section-cancel',
    selected: state.selectionText,
    expected: gesture.expected,
    passed:
      state.selectionText === gesture.expected && state.documentUnchanged && !state.railVisible,
  });
  return { passed: results.every(result => result.passed), results };
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

    // Start without a prior scenario's native selection. A collapsed selection
    // outside the editor intentionally disables rail actions in production.
    await setScenarioEnvironment(window, { viewport: 'wide', zoom: 1, reducedMotion: false });
    const nativeRailScroll = await verifyNativeRailScroll(window);
    const railScrollArtifacts = nativeRailScroll.passed
      ? []
      : await writeFailureArtifacts(window, 'native-rail-scroll', nativeRailScroll);
    await window.webContents.executeJavaScript('window.finishNativeRailScroll()');

    const nativeRailRecovery = await verifyNativeRailRecovery(window);
    const railRecoveryArtifacts = nativeRailRecovery.passed
      ? []
      : await writeFailureArtifacts(window, 'native-rail-recovery', nativeRailRecovery);
    await window.webContents.executeJavaScript('window.finishNativeRailScroll()');
    if (process.env.MD4H_FEEDBACK_NATIVE_RAIL_ONLY === '1') {
      const runtimeMatches =
        process.versions.electron === process.env.MD4H_EXPECTED_ELECTRON_VERSION;
      const passed = runtimeMatches && nativeRailScroll.passed && nativeRailRecovery.passed;
      await finish(
        {
          passed,
          runtime: { electron: process.versions.electron, chrome: process.versions.chrome },
          expectedElectron: process.env.MD4H_EXPECTED_ELECTRON_VERSION,
          runtimeMatches,
          nativeRailScroll,
          nativeRailRecovery,
          failureArtifacts: [...railScrollArtifacts, ...railRecoveryArtifacts],
        },
        passed ? 0 : 1
      );
      return;
    }

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
    const failureArtifacts = [...railScrollArtifacts, ...railRecoveryArtifacts];
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

    await setScenarioEnvironment(window, { viewport: 'wide', zoom: 1, reducedMotion: false });
    const nativeSelection = await verifyNativeSelections(window);
    const semanticPoint = await window.webContents.executeJavaScript(
      'window.prepareSemanticScope()'
    );
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...semanticPoint,
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    const semanticButton = await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[data-feedback-block-action]');
      if (!button || button.hidden) throw new Error('Semantic rail action not visible');
      const rect = button.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...semanticButton,
    });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...semanticButton,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...semanticButton,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    const semanticScope = await window.webContents.executeJavaScript(
      'window.inspectSemanticScope()'
    );

    const runtimeMatches = process.versions.electron === process.env.MD4H_EXPECTED_ELECTRON_VERSION;
    const result = {
      passed:
        runtimeMatches &&
        results.every(scenario => scenario.passed) &&
        stress.passed &&
        realController.passed &&
        nativeSelection.passed &&
        semanticScope.passed &&
        nativeRailScroll.passed &&
        nativeRailRecovery.passed,
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
      nativeSelection,
      nativeRailScroll,
      nativeRailRecovery,
      semanticScope,
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
