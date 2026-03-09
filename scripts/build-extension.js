#!/usr/bin/env node

/**
 * Build Script for Extension Bundle
 *
 * Uses esbuild programmatically so we can selectively remove console.log/debug/info
 * in production builds while keeping console.warn and console.error.
 *
 * Usage:
 *   node scripts/build-extension.js          # Development build (debug)
 *   node scripts/build-extension.js --prod   # Production build (minified, drops console.log/debug/info, no sourcemaps)
 *   node scripts/build-extension.js --watch  # Watch mode (development)
 *   node scripts/build-extension.js --prod --no-sourcemap # Release build (marketplace)
 */

const esbuild = require('esbuild');
const fs = require('fs');

const args = process.argv.slice(2);
const isProduction = args.includes('--prod') || process.env.NODE_ENV === 'production';
const isWatch = args.includes('--watch');
const noSourcemap = args.includes('--no-sourcemap');

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: !noSourcemap && !isProduction,
  minify: isProduction,
  treeShaking: true,
  // Remove console.log/debug/info calls in production bundles (keep warn/error)
  pure: isProduction ? ['console.log', 'console.debug', 'console.info'] : [],
};

async function build() {
  if (isWatch) {
    // Watch mode - development build
    const context = await esbuild.context({
      ...buildOptions,
      minify: false, // Never minify in watch mode
      pure: [], // Keep all console logs in watch mode
    });

    await context.watch();
    console.log('👀 Watching for changes... (Press Ctrl+C to stop)');
  } else {
    // One-time build
    try {
      await esbuild.build(buildOptions);

      // Ensure release builds don't leave stale sourcemaps in dist/
      if (isProduction || noSourcemap) {
        try {
          fs.unlinkSync('dist/extension.js.map');
        } catch {
          // ignore - file may not exist
        }
      }

      console.log(
        `✅ Extension build complete${isProduction ? ' (production)' : ' (development)'}${noSourcemap ? ' (no sourcemap)' : ''
        }`
      );
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
