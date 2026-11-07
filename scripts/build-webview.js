#!/usr/bin/env node

/**
 * Build Script for Webview and Highlighting Worker Bundles
 *
 * Builds the editor and a self-contained classic worker with esbuild.
 * This allows us to selectively remove console.log/debug/info while keeping
 * console.error and console.warn in production builds.
 *
 * Usage:
 *   node scripts/build-webview.js          # Development build
 *   node scripts/build-webview.js --prod   # Production build (minified, drops console.log)
 *   node scripts/build-webview.js --watch  # Watch mode (development)
 */

const esbuild = require('esbuild');
const fs = require('fs');
const { consoleStripOptions } = require('./console-strip');
const runtimeTargets = require('./runtime-targets');

const args = process.argv.slice(2);
const isProduction = args.includes('--prod') || process.env.NODE_ENV === 'production';
const isWatch = args.includes('--watch');
const noSourcemap = args.includes('--no-sourcemap');

const buildOptions = {
  entryPoints: ['src/webview/editor.ts'],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  target: runtimeTargets.webview,
  sourcemap: !noSourcemap && !isProduction, // Disable for marketplace builds
  minify: isProduction,
  treeShaking: true,
  loader: {
    '.css': 'css',
    '.ttf': 'file',
    // KaTeX ships @font-face rules pointing at woff/woff2/eot files. esbuild
    // copies them next to webview.css with hashed filenames so the bundled CSS
    // resolves them via the webview's cspSource.
    '.woff': 'file',
    '.woff2': 'file',
    '.eot': 'file',
  },
  // Strip console.log/debug/info from release bundles while keeping warn/error.
  // 'pure' alone is not enough for value-position calls in dependencies -
  // see scripts/console-strip.js for the full explanation.
  ...consoleStripOptions(isProduction),
  plugins: [],
};

// VS Code workers load from Blob URLs, so dependencies must stay in this one
// classic-script bundle. Code splitting and runtime imports are not allowed.
const workerBuildOptions = {
  ...buildOptions,
  entryPoints: ['src/webview/highlighting/worker.ts'],
  outfile: 'dist/highlighting-worker.js',
};

async function build() {
  if (isWatch) {
    // Watch mode - development build
    const contexts = [];
    try {
      for (const options of [buildOptions, workerBuildOptions]) {
        contexts.push(
          await esbuild.context({
            ...options,
            minify: false,
            ...consoleStripOptions(false),
          })
        );
      }
      await Promise.all(contexts.map(context => context.watch()));
    } catch (error) {
      await Promise.all(contexts.map(context => context.dispose()));
      throw error;
    }

    console.log('👀 Watching for changes... (Press Ctrl+C to stop)');
  } else {
    // One-time build
    try {
      await Promise.all([esbuild.build(buildOptions), esbuild.build(workerBuildOptions)]);
      if (isProduction || noSourcemap) {
        // Ensure release builds don't leave stale sourcemaps in dist/
        for (const mapFile of [
          'dist/webview.js.map',
          'dist/webview.css.map',
          'dist/highlighting-worker.js.map',
        ]) {
          try {
            fs.unlinkSync(mapFile);
          } catch {
            // ignore
          }
        }
      }
      console.log(`✅ Webview build complete${isProduction ? ' (production)' : ' (development)'}`);
    } catch (error) {
      console.error('❌ Build failed:', error);
      process.exit(1);
    }
  }
}

build().catch(error => {
  console.error('❌ Build failed:', error);
  process.exit(1);
});
