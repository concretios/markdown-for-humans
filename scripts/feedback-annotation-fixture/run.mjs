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
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
);
const vscodeElectronVersion = JSON.parse(versionsJson).electron;
if (typeof vscodeElectronVersion !== 'string') {
  throw new Error('Could not determine the Electron version bundled with VS Code.');
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'md4h-feedback-annotations-'));
const appDirectory = join(temporaryRoot, 'app');
const resultPath = join(temporaryRoot, 'result.json');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const failureArtifactsDirectory = join(
  repositoryRoot,
  'temp',
  'feedback-annotation-fixture',
  runId
);

try {
  await mkdir(join(appDirectory, 'assets', 'katex'), { recursive: true });
  await cp(join(fixtureDirectory, 'electron-main.cjs'), join(appDirectory, 'electron-main.cjs'));
  await cp(join(fixtureDirectory, 'index.html'), join(appDirectory, 'index.html'));
  await cp(join(repositoryRoot, 'src', 'webview', 'editor.css'), join(appDirectory, 'editor.css'));
  await cp(
    join(fixtureDirectory, 'assets', 'local-image.svg'),
    join(appDirectory, 'assets', 'local-image.svg')
  );
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
    `${JSON.stringify({ name: 'md4h-feedback-annotation-fixture', main: 'electron-main.cjs' }, null, 2)}\n`
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

  // Match the existing capture fixture: detect VS Code's Electron version,
  // then run the corresponding generic Electron binary because VS Code's
  // signed application bundle cannot load an arbitrary fixture application.
  const electronCommand = process.env.MD4H_ELECTRON_BINARY;
  const child = spawn(
    electronCommand || 'npx',
    electronCommand ? [appDirectory] : ['--yes', `electron@${vscodeElectronVersion}`, appDirectory],
    {
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '1',
        MD4H_FEEDBACK_ANNOTATION_RESULT: resultPath,
        MD4H_FEEDBACK_ANNOTATION_ARTIFACTS: failureArtifactsDirectory,
        MD4H_EXPECTED_ELECTRON_VERSION: vscodeElectronVersion,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  const timeout = setTimeout(() => child.kill('SIGTERM'), 180_000);
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 128 : 1)));
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
    process.stderr.write(`Failure artifacts: ${failureArtifactsDirectory}\n`);
    process.exitCode = 1;
  } else {
    await rm(failureArtifactsDirectory, { force: true, recursive: true });
  }
} finally {
  if (process.env.MD4H_KEEP_FIXTURE !== '1') {
    await rm(temporaryRoot, { force: true, recursive: true });
  } else {
    process.stderr.write(`Fixture retained at ${temporaryRoot}\n`);
  }
}
