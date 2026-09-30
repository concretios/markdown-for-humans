/** Run the production PDF exporter with real Chrome and isolated VS Code UI adapters. */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { build } from 'esbuild';

/** Check the synthetic SVG's vector drawing, rather than accepting an empty PDF. */
function hasSvgDrawing(pdf) {
  const text = pdf.toString('latin1');
  if (!text.startsWith('%PDF-') || !text.trimEnd().endsWith('%%EOF')) return false;
  const streams = [];
  for (const match of text.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      streams.push(inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'));
    } catch {
      // Chrome also writes uncompressed streams and binary font data.
      streams.push(match[1]);
    }
  }
  return streams.some(stream => {
    const colors = [...stream.matchAll(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg\b/g)].map(match =>
      match.slice(1).map(Number)
    );
    const hasColor = expected =>
      colors.some(color =>
        color.every((value, index) => Math.abs(value * 255 - expected[index]) < 1)
      );
    return /0 0 1280 560 re\b/.test(stream) && hasColor([38, 108, 211]) && hasColor([245, 197, 66]);
  });
}

export async function runPdfExportFixture({ repository, temporary, chrome, html, svgSource }) {
  const sourceDirectory = join(temporary, 'PDF assets # & "fixture"');
  await mkdir(join(sourceDirectory, 'assets'), { recursive: true });
  await writeFile(join(sourceDirectory, 'assets', 'diagram #1.svg'), svgSource);
  const outputPath = join(temporary, 'production-export.pdf');
  const children = new Map();
  const launches = [];
  const fixture = {
    chrome,
    outputPath,
    errors: [],
    notifications: [],
    closing: false,
    spawn(executable, args, options) {
      if (fixture.closing) throw new Error('PDF fixture is shutting down');
      const launch = { args, options, started: Date.now() };
      launches.push(launch);
      // Production owns all launch arguments, profile isolation, and stdio.
      const child = spawn(executable, args, options);
      const closed = new Promise(resolve => {
        child.once('close', (code, signal) => {
          launch.closeElapsedMs = Date.now() - launch.started;
          launch.closeCode = code;
          launch.closeSignal = signal;
          children.delete(child);
          resolve();
        });
      });
      children.set(child, closed);
      child.once('exit', (code, signal) => {
        launch.elapsedMs = Date.now() - launch.started;
        launch.code = code;
        launch.signal = signal;
      });
      return child;
    },
  };
  const bundle = join(temporary, 'pdf-export.cjs');
  await build({
    absWorkingDir: repository,
    entryPoints: [join(repository, 'src/features/documentExport.ts')],
    bundle: true,
    outfile: bundle,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['docx'],
    plugins: [
      {
        name: 'isolated-pdf-export-adapters',
        setup(build) {
          build.onResolve({ filter: /^(?:vscode|child_process)$/ }, args => ({
            path: args.path,
            namespace: 'fixture-adapter',
          }));
          build.onLoad({ filter: /.*/, namespace: 'fixture-adapter' }, args => ({
            contents:
              args.path === 'child_process'
                ? 'export const spawn = (...args) => globalThis.__md4hSvgPdfFixture.spawn(...args);'
                : `
              const fixture = globalThis.__md4hSvgPdfFixture;
              export const Uri = { file: fsPath => ({ scheme: 'file', fsPath }) };
              export const ProgressLocation = { Notification: 15 };
              export const ConfigurationTarget = { Global: 1 };
              export const workspace = { getConfiguration: () => ({ get: key => key === 'chromePath' ? fixture.chrome : undefined, update: async () => {} }) };
              export const window = {
                showWarningMessage: async () => 'I Understand',
                showSaveDialog: async () => Uri.file(fixture.outputPath),
                showInformationMessage: async message => { fixture.notifications.push(message); },
                showErrorMessage: async message => { fixture.errors.push(message); },
                withProgress: async (_options, callback) => callback({ report() {} }, { isCancellationRequested: false })
              };
              export const env = { openExternal: async () => true };
            `,
            loader: 'js',
          }));
        },
      },
    ],
  });
  globalThis.__md4hSvgPdfFixture = fixture;
  let timeout;
  let exported;
  try {
    const { exportDocument } = createRequire(import.meta.url)(bundle);
    exported = exportDocument('pdf', html, [], 'SVG export regression', {
      uri: { scheme: 'file', fsPath: join(sourceDirectory, 'source.md') },
    });
    await Promise.race([
      exported,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Production PDF export timed out: ${JSON.stringify(launches)}`)),
          20000
        );
      }),
    ]);
    if (fixture.errors.length > 0) throw new Error(fixture.errors.join('; '));
    await Promise.all(children.values());
    const pdf = await readFile(outputPath);
    const svgDrawingPresent = hasSvgDrawing(pdf);
    const printLaunch = launches.find(launch =>
      launch.args.some(argument => argument.startsWith('--print-to-pdf='))
    );
    const commandCompleted =
      printLaunch?.code === 0 &&
      printLaunch?.signal === null &&
      fixture.notifications.some(message => message.includes('exported successfully'));
    return {
      passed: svgDrawingPresent && commandCompleted,
      svgDrawingPresent,
      commandCompleted,
      terminatedAfterPdf: false,
      bytes: pdf.byteLength,
      launches: launches.map(({ started, ...launch }) => launch),
      path: outputPath,
      boundary:
        'Production exportDocument, unmodified Chrome invocation, natural print-process exit, completed notification, and verified SVG drawing; VS Code dialogs/config and external-open adapters isolated.',
    };
  } finally {
    clearTimeout(timeout);
    fixture.closing = true;
    // Timeout is a failing test. Reap only this fixture's children before
    // releasing adapters or allowing the caller to remove temporary files.
    await Promise.all(
      [...children].map(async ([child, closed]) => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const forceKill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 1000);
        try {
          await closed;
        } finally {
          clearTimeout(forceKill);
        }
      })
    );
    await exported?.catch(() => undefined);
    delete globalThis.__md4hSvgPdfFixture;
  }
}
