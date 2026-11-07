#!/usr/bin/env node
/** Prepare a disposable production-derived Extension Host/browser fixture. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const require = createRequire(import.meta.url);
const { consoleStripOptions } = require('../console-strip.js');
const { webview: target } = require('../runtime-targets.js');
const args = process.argv.slice(2);
const disableHighlighting = args.includes('--disable-highlighting');
const guardLanguageClass = args.includes('--guard-language-class');
const sourceIndex = args.indexOf('--source');
const sourcePath = sourceIndex < 0 ? undefined : resolve(args[sourceIndex + 1]);
const output = await mkdtemp(join(tmpdir(), 'md4h-highlighting-fixture-'));
const extension = join(output, 'extension');
const workspace = join(output, 'workspace');
const dist = join(extension, 'dist');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function prepare() {
  try {
    // Require a successful release build, including the actual packaged worker.
    await readFile(join(root, 'dist/highlighting-worker.js'));
    await mkdir(extension, { recursive: true });
    await mkdir(workspace, { recursive: true });
    for (const file of ['package.json', 'icon.png', 'LICENSE', 'THIRD_PARTY_LICENSES.md']) {
      await cp(join(root, file), join(extension, file));
    }
    await cp(join(root, 'dist'), dist, { recursive: true });
    const clientPath = join(root, 'src/webview/highlighting/client.ts');
    const editorPath = join(root, 'src/webview/editor.ts');
    const metricsPath = join(here, 'metrics.ts');
    await build({
      absWorkingDir: root,
      entryPoints: [editorPath],
      outfile: join(dist, 'webview.js'),
      bundle: true,
      format: 'iife',
      target,
      minify: true,
      treeShaking: true,
      loader: { '.css': 'css', '.ttf': 'file', '.woff': 'file', '.woff2': 'file', '.eot': 'file' },
      ...consoleStripOptions(true),
      plugins: [
        {
          name: 'fixture-metrics-only',
          setup(builder) {
            builder.onLoad({ filter: /extensions\/codeBlockWithCopy\.ts$/ }, async ({ path }) => {
              if (!disableHighlighting) return;
              const original = await readFile(path, 'utf8');
              const replaced = original.replace(
                'createCodeHighlightingPlugin(() => createHighlightService(this.options.workerUri)),',
                ''
              );
              if (replaced === original)
                throw new Error('Fixture highlighting-disable hook no longer matches.');
              return { loader: 'ts', resolveDir: dirname(path), contents: replaced };
            });
            builder.onLoad(
              { filter: /extensions\/codeBlockCopyNodeView\.ts$/ },
              async ({ path }) => {
                if (!guardLanguageClass) return;
                const original = await readFile(path, 'utf8');
                const replaced = original.replace(
                  "code.className = language ? `${languageClassPrefix}${language}` : '';",
                  "const nextLanguageClass = language ? `${languageClassPrefix}${language}` : '';\n    if (code.className !== nextLanguageClass) code.className = nextLanguageClass;"
                );
                if (replaced === original)
                  throw new Error('Fixture language-class guard hook no longer matches.');
                return { loader: 'ts', resolveDir: dirname(path), contents: replaced };
              }
            );
            builder.onLoad({ filter: /highlighting\/client\.ts$/ }, async () => {
              const original = await readFile(clientPath, 'utf8');
              const replaced = original.replace(
                'export function createHighlightService(',
                'function createUnmeasuredHighlightService('
              );
              if (replaced === original)
                throw new Error('Fixture client hook no longer matches the production export.');
              return {
                loader: 'ts',
                resolveDir: dirname(clientPath),
                contents:
                  `import { measureService } from ${JSON.stringify(metricsPath)};\n${replaced}\n` +
                  'export function createHighlightService(...args: Parameters<typeof createUnmeasuredHighlightService>): ReturnType<typeof createUnmeasuredHighlightService> { return measureService(createUnmeasuredHighlightService(...args)); }',
              };
            });
            builder.onLoad({ filter: /src\/webview\/editor\.ts$/ }, async () => ({
              loader: 'ts',
              resolveDir: dirname(editorPath),
              contents:
                `import { metrics as highlightQaMetrics, resetMetrics as highlightQaReset, instrumentEditorPhases as highlightQaInstrumentEditor } from ${JSON.stringify(metricsPath)};\n` +
                `import { codeHighlightingKey as highlightQaPluginKey } from ${JSON.stringify(join(root, 'src/webview/highlighting/plugin.ts'))};\n` +
                (await readFile(editorPath, 'utf8')) +
                '\n' +
                (await readFile(join(here, 'panel.txt'), 'utf8')).replace(
                  "'Highlighting fixture: production worker'",
                  JSON.stringify(
                    `Highlighting fixture: ${disableHighlighting ? 'disabled for comparison' : 'production worker'}${guardLanguageClass ? ', class guard' : ''}`
                  )
                ),
            }));
          },
        },
      ],
    });
    let privateSource;
    if (sourcePath) {
      const bytes = await readFile(sourcePath);
      await writeFile(join(workspace, 'deck.md'), bytes);
      const text = bytes.toString('utf8');
      const images = [...text.matchAll(/(?:\]\(|src=["'])<?(images\/[^\s)"'>]+)/g)].map(
        match => match[1]
      );
      for (const image of new Set(images)) {
        const relative = decodeURIComponent(image);
        // Only simple sibling image resources are fixture inputs.
        if (dirname(relative) !== 'images') continue;
        await mkdir(join(workspace, 'images'), { recursive: true });
        await cp(join(dirname(sourcePath), relative), join(workspace, relative));
      }
      privateSource = { path: sourcePath, sha256: hash(bytes) };
    }
    const manyBlocks =
      Array.from(
        { length: 1000 },
        (_, index) =>
          `Paragraph ${index}.\n\n\`\`\`typescript\nconst value${index}: string = "hello";\n// Code comment\nconsole.log(value${index});\n\n\n\`\`\`\n`
      ).join('\n') + '\nFinal paragraph.';
    await writeFile(join(workspace, '1000-blocks.md'), manyBlocks);
    await writeFile(
      join(workspace, 'long-block.md'),
      '# Long block\n\n```typescript\n' +
        Array.from({ length: 10000 }, (_, index) => `const value${index}: string = "hello";`).join(
          '\n'
        ) +
        '\n```\n'
    );
    await writeFile(
      join(workspace, 'language-matrix.md'),
      '# Language matrix\n\n' +
        [
          [
            'typescript title="sample.ts"',
            'const text: string = "🌍 & <tag>";\nconsole.log(text);',
          ],
          ['sql', 'SELECT name FROM accounts WHERE active = true;'],
          ['unknown-language', '<keep> & literal text'],
          ['plaintext', 'const shouldStayPlain = true;'],
          ['', '┌───────┐\n│ plain │\n└───────┘'],
        ]
          .map(([language, body]) => `\`\`\`${language}\n${body}\n\`\`\`\n`)
          .join('\n')
    );
    const manifest = JSON.parse(await readFile(join(extension, 'package.json'), 'utf8'));
    const themeColors = (manifest.contributes?.colors || [])
      .map(color => {
        const value = color.defaults.light;
        return `--vscode-${color.id.replaceAll('.', '-')}:${value.startsWith('#') ? value : `var(--vscode-${value.replaceAll('.', '-')})`};`;
      })
      .join('');
    const html = (await readFile(join(here, 'browser.html'), 'utf8')).replace(
      '/* extension-color-defaults */',
      themeColors
    );
    await writeFile(join(output, 'browser.html'), html);
    if (sourcePath && hash(await readFile(sourcePath)) !== privateSource.sha256)
      throw new Error('Read-only source changed during fixture setup.');
    const metadata = {
      output,
      extension,
      workspace,
      privateSource,
      workerSha256: hash(await readFile(join(dist, 'highlighting-worker.js'))),
      diagnostics: { disableHighlighting, guardLanguageClass },
      launchArguments: [
        '--new-window',
        '--profile',
        'Markdown Highlighting Fixture',
        '--disable-extensions',
        `--extensionDevelopmentPath=${extension}`,
        workspace,
        join(workspace, sourcePath ? 'deck.md' : 'language-matrix.md'),
      ],
    };
    await writeFile(join(output, 'fixture.json'), JSON.stringify(metadata, null, 2));
    process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
    if (args.includes('--serve')) {
      const server = createServer(async (request, response) => {
        try {
          const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
          let file;
          if (pathname === '/') file = join(output, 'browser.html');
          else if (pathname.startsWith('/images/') && basename(pathname) === pathname.slice(8))
            file = join(workspace, 'images', basename(pathname));
          else if (basename(pathname) === pathname.slice(1))
            file = join(pathname.endsWith('.md') ? workspace : dist, basename(pathname));
          if (!file) {
            response.writeHead(404);
            response.end();
            return;
          }
          const content = await readFile(file);
          response.setHeader(
            'Content-Type',
            {
              '.js': 'text/javascript',
              '.css': 'text/css',
              '.html': 'text/html',
              '.md': 'text/plain',
              '.svg': 'image/svg+xml',
            }[extname(file)] || 'application/octet-stream'
          );
          response.end(content);
        } catch {
          response.writeHead(404);
          response.end();
        }
      });
      server.listen(0, '127.0.0.1', () =>
        process.stdout.write(
          `${JSON.stringify({ browserUrl: `http://127.0.0.1:${server.address().port}/` })}\n`
        )
      );
    }
  } catch (error) {
    console.error('Highlighting fixture setup failed. Run npm run build:release first.', error);
    process.exitCode = 1;
  }
}
await prepare();
