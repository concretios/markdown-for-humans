#!/usr/bin/env node

/**
 * Build Verification Script
 *
 * Verifies that critical CSS classes and JavaScript functions
 * are present in the bundled output files.
 *
 * Usage: node scripts/verify-build.js
 */

const fs = require('fs');
const path = require('path');

function assertNoProdConsoleCalls(bundleName, content) {
  const disallowed = ['console.log(', 'console.debug(', 'console.info('];
  const found = disallowed.filter(token => content.includes(token));
  if (found.length > 0) {
    console.error(`   ❌ Production bundle contains disallowed console calls:`);
    found.forEach(token => console.error(`      - ${token}`));
    console.error(`   Fix: ensure the build uses esbuild 'pure' (or equivalent) for console.log/debug/info.\n`);
    return false;
  }
  return true;
}

function assertNoSourcemapsInDist() {
  const distPath = path.join(process.cwd(), 'dist');
  if (!fs.existsSync(distPath)) return true;
  const distFiles = fs.readdirSync(distPath);
  const maps = distFiles.filter((f) => f.endsWith('.map'));
  if (maps.length > 0) {
    console.error(`   ❌ Release build left sourcemaps in dist/:`);
    maps.forEach((f) => console.error(`      - dist/${f}`));
    console.error(`   Fix: run release builds with --no-sourcemap and/or delete stale maps.\n`);
    return false;
  }
  return true;
}

// Define critical features that MUST be in the bundle
const CRITICAL_FEATURES = {
  webviewJs: {
    file: 'dist/webview.js',
    required: [
      'setupImageResize', // Global function (not minified)
      'image-resize-modal', // Feature usage
      'neverAskAgain', // Dialog option
      'skipResizeWarning', // Setting name
      'resizeImage', // Message type
      'copyLocalImageToWorkspace', // Feature
    ],
  },
  webviewCss: {
    file: 'dist/webview.css',
    required: [
      '.image-menu-button',
      '.image-resize-modal-panel',
      '.image-resize-modal-overlay',
      '.image-wrapper',
      '.markdown-image',
    ],
  },
  extensionJs: {
    file: 'dist/extension.js',
    required: [
      'resizeImage',
      'checkImageInWorkspace',
      'copyLocalImageToWorkspace',
    ],
  },
};

let hasErrors = false;
let hasWarnings = false;

console.log('\n🔍 Verifying build outputs...\n');

if (!assertNoSourcemapsInDist()) {
  process.exit(1);
}

// Check each feature bundle
for (const [bundleName, config] of Object.entries(CRITICAL_FEATURES)) {
  const filePath = path.join(process.cwd(), config.file);

  console.log(`📦 Checking ${bundleName} (${config.file})`);

  if (!fs.existsSync(filePath)) {
    console.error(`   ❌ File not found: ${config.file}`);
    hasErrors = true;
    continue;
  }

  const content = fs.readFileSync(filePath, 'utf8');

  // Sanity check: release/production bundles must not contain noisy console methods.
  // We keep console.warn/error for diagnostics, but log/debug/info should be stripped.
  if (bundleName === 'webviewJs' || bundleName === 'extensionJs') {
    if (!assertNoProdConsoleCalls(bundleName, content)) {
      hasErrors = true;
      continue;
    }
  }

  const missing = [];
  const found = [];

  for (const feature of config.required) {
    // For CSS classes, check with and without minification
    const searchTerm = feature.startsWith('.')
      ? feature.slice(1) // Remove the dot for searching
      : feature;

    if (content.includes(searchTerm)) {
      found.push(feature);
    } else {
      missing.push(feature);
    }
  }

  if (missing.length > 0) {
    console.error(`   ❌ Missing ${missing.length} critical features:`);
    missing.forEach(f => console.error(`      - ${f}`));
    hasErrors = true;
  }

  if (found.length > 0) {
    console.log(`   ✅ Found ${found.length}/${config.required.length} features`);
  }

  console.log('');
}

// File size checks
console.log('📊 Bundle sizes:');
const sizeChecks = [
  { file: 'dist/webview.js', min: 100000, max: 15000000 },
  { file: 'dist/webview.css', min: 10000, max: 500000 },
  { file: 'dist/extension.js', min: 100000, max: 10000000 },
];

for (const check of sizeChecks) {
  const filePath = path.join(process.cwd(), check.file);
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    const sizeKB = (stats.size / 1024).toFixed(0);

    if (stats.size < check.min) {
      console.warn(`   ⚠️  ${check.file}: ${sizeKB}KB (suspiciously small)`);
      hasWarnings = true;
    } else if (stats.size > check.max) {
      console.warn(`   ⚠️  ${check.file}: ${sizeMB}MB (suspiciously large)`);
      hasWarnings = true;
    } else {
      console.log(`   ✅ ${check.file}: ${sizeKB}KB`);
    }
  }
}

console.log('');

// Final summary
if (hasErrors) {
  console.error('❌ Build verification FAILED - critical features are missing!\n');
  console.error('Action required:');
  console.error('1. Check that all CSS is properly imported in editor.ts');
  console.error('2. Rebuild with: npm run build');
  console.error('3. Run this script again: node scripts/verify-build.js\n');
  process.exit(1);
} else if (hasWarnings) {
  console.warn('⚠️  Build verification passed with warnings\n');
  process.exit(0);
} else {
  console.log('✅ Build verification PASSED - all critical features present!\n');
  process.exit(0);
}
