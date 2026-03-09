#!/usr/bin/env node

/**
 * Build Script for Webview Bundle
 *
 * Uses esbuild programmatically to build the webview with custom plugins.
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

const args = process.argv.slice(2);
const isProduction = args.includes('--prod') || process.env.NODE_ENV === 'production';
const isWatch = args.includes('--watch');
const noSourcemap = args.includes('--no-sourcemap');

const buildOptions = {
  entryPoints: [
    { in: 'src/webview/editor.ts', out: 'webview' },
    { in: 'src/webview/editor-light.css', out: 'editor-light' },
    { in: 'src/webview/editor-dark.css', out: 'editor-dark' }
  ],
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  sourcemap: !noSourcemap && !isProduction, // Disable for marketplace builds
  minify: isProduction,
  treeShaking: true,
  loader: {
    '.css': 'css',
    '.ttf': 'file',
  },
  // Use esbuild's built-in 'pure' option to remove console.log/debug/info
  // This properly handles parsing and removes the calls during minification
  // while keeping console.error and console.warn
  pure: isProduction ? ['console.log', 'console.debug', 'console.info'] : [],
  plugins: [],
};

async function build() {
  if (isWatch) {
    // Watch mode - development build
    const context = await esbuild.context({
      ...buildOptions,
      minify: false, // Never minify in watch mode
      plugins: [], // No console dropping in watch mode
    });

    await context.watch();
    console.log('👀 Watching for changes... (Press Ctrl+C to stop)');
  } else {
    // One-time build
    try {
      await esbuild.build(buildOptions);
      if (isProduction || noSourcemap) {
        // Ensure release builds don't leave stale sourcemaps in dist/
        for (const mapFile of ['dist/webview.js.map', 'dist/webview.css.map']) {
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

build().catch((error) => {
  console.error('❌ Build failed:', error);
  process.exit(1);
});
