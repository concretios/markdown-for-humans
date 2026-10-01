/** Worker packaging must remain self-contained under VS Code's nonce CSP. */
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import vm from 'vm';

const root = path.resolve(__dirname, '../../..');
const verifier = path.join(root, 'scripts/verify-build.js');

describe('highlighting worker build contract', () => {
  test('builds one classic worker bundle alongside the editor with release stripping', async () => {
    const options: Array<Record<string, unknown>> = [];
    const removed: string[] = [];
    const build = jest.fn(async (value: Record<string, unknown>) => {
      options.push(value);
    });
    const fakeRequire = (name: string) => {
      if (name === 'esbuild') return { build };
      if (name === 'fs') return { unlinkSync: (file: string) => removed.push(file) };
      if (name === './runtime-targets') return { webview: 'chrome132' };
      if (name === './console-strip')
        return {
          consoleStripOptions: (production: boolean) => ({
            pure: production ? ['console.log'] : [],
          }),
        };
      throw new Error(`Unexpected build dependency: ${name}`);
    };
    vm.runInNewContext(readFileSync(path.join(root, 'scripts/build-webview.js'), 'utf8'), {
      require: fakeRequire,
      process: { argv: ['node', 'build-webview.js', '--prod'], env: {}, exit: jest.fn() },
      console: { log: jest.fn(), error: jest.fn() },
    });
    // Finish the script's asynchronous builds and source-map cleanup.
    for (let tick = 0; tick < 6; tick++) await Promise.resolve();
    const worker = options.find(option => option.outfile === 'dist/highlighting-worker.js');
    expect(worker).toEqual(
      expect.objectContaining({
        entryPoints: ['src/webview/highlighting/worker.ts'],
        bundle: true,
        format: 'iife',
        target: 'chrome132',
        sourcemap: false,
        minify: true,
        pure: ['console.log'],
      })
    );
    expect(worker?.splitting).not.toBe(true);
    expect(removed).toContain('dist/highlighting-worker.js.map');
  });
});

describe('release verifier includes the worker', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'md4h-worker-build-'));
    mkdirSync(path.join(directory, 'dist'));
    writeFileSync(
      path.join(directory, 'dist/webview.js'),
      'setupImageResize image-resize-modal neverAskAgain skipResizeWarning resizeImage copyLocalImageToWorkspace'
    );
    writeFileSync(
      path.join(directory, 'dist/webview.css'),
      'image-menu-button image-resize-modal-panel image-resize-modal-overlay image-wrapper markdown-image'
    );
    writeFileSync(
      path.join(directory, 'dist/extension.js'),
      'resizeImage checkImageInWorkspace copyLocalImageToWorkspace'
    );
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  const run = () => spawnSync(process.execPath, [verifier], { cwd: directory, encoding: 'utf8' });

  test('rejects a missing worker even when other critical bundles exist', () => {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dist/highlighting-worker.js');
  });

  test.each([
    'importScripts("remote.js")',
    'import("remote.js")',
    'eval("1")',
    'new Function("return 1")',
  ])('rejects a worker that needs forbidden dynamic code: %s', code => {
    writeFileSync(path.join(directory, 'dist/highlighting-worker.js'), `(()=>{${code}})();`);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('self-contained');
  });

  test('reports total editor plus worker JavaScript and rejects worker sourcemaps', () => {
    writeFileSync(
      path.join(directory, 'dist/highlighting-worker.js'),
      '(()=>{self.onmessage=()=>self.postMessage({type:"md4h.highlight.result",request:"md4h.highlight.request"});})();'
    );
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Total webview JavaScript (editor + worker)');
    writeFileSync(path.join(directory, 'dist/highlighting-worker.js.map'), '{}');
    expect(run().status).toBe(1);
  });
});
