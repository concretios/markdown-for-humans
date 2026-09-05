#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(fixtureDirectory, '..', '..');
const expectedModernScreenshotVersion = '4.7.0';
const defaultCodeApp = '/Applications/Visual Studio Code.app';
const codeApp = process.env.MD4H_CODE_APP || defaultCodeApp;
const codeExecutable = join(codeApp, 'Contents', 'MacOS', 'Code');

if (!existsSync(codeExecutable)) {
  throw new Error(
    `VS Code Electron runtime was not found at ${codeApp}. Set MD4H_CODE_APP to a VS Code .app bundle.`
  );
}

const { stdout: versionsJson } = await execFile(
  codeExecutable,
  ['-p', 'JSON.stringify(process.versions)'],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }
);
const vscodeElectronVersion = JSON.parse(versionsJson).electron;
if (typeof vscodeElectronVersion !== 'string') {
  throw new Error('Could not determine the Electron version bundled with VS Code.');
}
const modernScreenshotPackage = JSON.parse(
  await readFile(join(repositoryRoot, 'node_modules', 'modern-screenshot', 'package.json'), 'utf8')
);
if (modernScreenshotPackage.version !== expectedModernScreenshotVersion) {
  throw new Error(
    `Expected modern-screenshot@${expectedModernScreenshotVersion}, found ${modernScreenshotPackage.version}.`
  );
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'md4h-feedback-capture-'));
const appDirectory = join(temporaryRoot, 'app');
const resultPath = join(temporaryRoot, 'result.json');

try {
  await mkdir(join(appDirectory, 'assets', 'katex'), { recursive: true });

  await cp(join(fixtureDirectory, 'electron-main.cjs'), join(appDirectory, 'electron-main.cjs'));
  await cp(join(fixtureDirectory, 'index.html'), join(appDirectory, 'index.html'));
  await cp(
    join(fixtureDirectory, 'assets', 'local-image.svg'),
    join(appDirectory, 'assets', 'local-image.svg')
  );
  await cp(join(repositoryRoot, 'icon.png'), join(appDirectory, 'assets', 'local-image.png'));
  await cp(
    join(repositoryRoot, 'node_modules', 'katex', 'dist', 'katex.min.css'),
    join(appDirectory, 'assets', 'katex', 'katex.min.css')
  );
  await cp(
    join(repositoryRoot, 'node_modules', 'katex', 'dist', 'fonts'),
    join(appDirectory, 'assets', 'katex', 'fonts'),
    { recursive: true }
  );
  await writeFile(
    join(appDirectory, 'package.json'),
    `${JSON.stringify({ name: 'md4h-feedback-capture-fixture', main: 'electron-main.cjs' }, null, 2)}\n`
  );

  await build({
    absWorkingDir: repositoryRoot,
    bundle: true,
    entryPoints: [join(fixtureDirectory, 'renderer.ts')],
    outfile: join(appDirectory, 'renderer.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    sourcemap: false,
  });

  // A packaged VS Code binary cannot load an arbitrary app because its signed
  // helper and ASAR integrity metadata are bound to VS Code. Run the identical
  // published Electron version instead. This still exercises a real Electron
  // renderer and keeps the repository free of an Electron dev dependency.
  const electronCommand = process.env.MD4H_ELECTRON_BINARY;
  const child = spawn(
    electronCommand || 'npx',
    electronCommand ? [appDirectory] : ['--yes', `electron@${vscodeElectronVersion}`, appDirectory],
    {
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '1',
        MD4H_FEEDBACK_CAPTURE_RESULT: resultPath,
        MD4H_EXPECTED_ELECTRON_VERSION: vscodeElectronVersion,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  const timeout = setTimeout(() => child.kill('SIGTERM'), 90_000);
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => {
      resolveExit(code ?? (signal ? 128 : 1));
    });
  });
  clearTimeout(timeout);

  let result;
  try {
    result = JSON.parse(await readFile(resultPath, 'utf8'));
  } catch (error) {
    throw new Error(`Electron fixture exited with status ${exitCode} without a result.`, {
      cause: error,
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (exitCode !== 0 || !result.passed) {
    process.exitCode = 1;
  }
} finally {
  if (process.env.MD4H_KEEP_FIXTURE !== '1') {
    await rm(temporaryRoot, { force: true, recursive: true });
  } else {
    process.stderr.write(`Fixture retained at ${temporaryRoot}\n`);
  }
}
