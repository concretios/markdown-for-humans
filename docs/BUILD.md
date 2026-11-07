# Build & Release Guide

This document describes the stable, verified build process for the Markdown Editor for Humans VS Code extension.

## Prerequisites

- Node.js 22+ and npm for development tooling
- VS Code 1.98.0+

## Build Process

The extension uses a two-state build system: **debug** (for development) and **release** (for marketplace).

### Debug Build (Default)

Debug builds include sourcemaps and console logs for easier debugging:

```bash
# Install dependencies
npm install

# Build extension and webview (debug mode)
npm run build:debug

# Watch for changes and rebuild automatically
npm run watch:debug
```

### Release Build (Marketplace)

Release builds are optimized, minified, and verified before publishing:

```bash
# Build and verify for marketplace
npm run build:release

# This automatically:
# - Minifies code
# - Removes console.log/debug/info (keeps warn/error)
# - Removes sourcemaps
# - Runs verification checks
```

## Console Logging Strategy

The build system automatically handles console logging based on build type:

### Debug Builds (`npm run build:debug`)

- ✅ `console.log()` - Kept (development debugging)
- ✅ `console.debug()` - Kept (verbose debugging)
- ✅ `console.info()` - Kept (informational)
- ✅ `console.warn()` - Kept (non-fatal warnings)
- ✅ `console.error()` - Kept (errors)

### Release Builds (`npm run build:release`)

- ❌ `console.log()` - **Removed** (noisy debug info)
- ❌ `console.debug()` - **Removed** (verbose debug)
- ❌ `console.info()` - **Removed** (informational)
- ✅ `console.warn()` - **Kept** (important warnings for users)
- ✅ `console.error()` - **Kept** (critical errors for debugging issues)

This is implemented by `scripts/console-strip.js`, which removes debug console calls without dropping side effects from their arguments. Esbuild's `pure` option alone is not sufficient for value-position calls or arguments that must still execute.

## Build Verification

The build process includes automatic verification to ensure critical features are not accidentally tree-shaken or removed during minification.

### What Gets Verified

The verification script checks:

1. **JavaScript Features**: Critical functions and message types in both extension and webview bundles
2. **CSS Classes**: UI components like `.image-resize-icon`, `.image-resize-modal-panel`
3. **Bundle Sizes**: Ensures bundles are within expected size ranges
4. **Source Maps**: Ensures release builds don't include sourcemap files
5. **Console Calls**: Ensures release builds don't contain console.log/debug/info

### Running Verification Manually

```bash
npm run verify-build
```

Output:

```
Verifying build outputs...

Checking webviewJs (dist/webview.js)
   Found 6/6 features

Checking webviewCss (dist/webview.css)
   Found 5/5 features

Checking extensionJs (dist/extension.js)
   Found 3/3 features

Build verification PASSED - all critical features present!
```

### Adding New Features to Verification

Edit `scripts/verify-build.js` and add feature names to the `CRITICAL_FEATURES` object:

```javascript
const CRITICAL_FEATURES = {
  webviewJs: {
    file: 'dist/webview.js',
    required: [
      'setupImageResize',
      'myNewFeature', // Add here
    ],
  },
  // ...
};
```

## Package & Release

### Development Workflow

**During development:**

- Use **F5 debugging** in VS Code (no packaging needed)
- VS Code automatically builds and runs the extension
- Full debugging capabilities with breakpoints and console logs

**For final testing before release:**

```bash
# Create release package (automatically runs build:release via vscode:prepublish hook)
npm run package:release

# Install and test locally
code --install-extension markdown-for-humans-<x.y.z>.vsix
```

**Note:** `npm run package:release` always creates a **release build** via the `vscode:prepublish` hook. This ensures:

- ✅ You test the exact same build that will be published
- ✅ No debug logs or sourcemaps in the package
- ✅ Minified and optimized for production
- ✅ Verified before packaging

### Publishing

The release process (version bump PR, Entra sign-in, publishing one vsix to the VS Code Marketplace and Open VSX, the GitHub release) lives in one place: [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md). This file does not repeat it, so the two cannot drift.

Two rules worth knowing while building:

- The vsix you tested is the vsix that ships. `vsce publish --packagePath` and `ovsx publish <file>` take that file; `vsce publish patch|minor|major` bumps the version at publish time and is not used. There is no npm publish script on purpose: one would rebuild at publish time.
- Marketplace publishing signs in with Microsoft Entra (`az login`), never a PAT.

## Build Architecture

### Extension Bundle (`dist/extension.js`)

- **Entry**: `src/extension.ts`
- **Format**: CommonJS (required by VS Code)
- **Platform**: Node.js
- **Target**: Node.js 20, matching VS Code 1.98
- **Tree-shaking**: Enabled
- **Minification**: Enabled

### Webview Bundle (`dist/webview.js`)

- **Entry**: `src/webview/editor.ts`
- **Format**: IIFE (Immediately Invoked Function Expression)
- **Platform**: Browser
- **Target**: Chromium 132, matching VS Code 1.98
- **Tree-shaking**: Enabled
- **Minification**: Enabled
- **CSS Bundling**: Emitted as the companion `dist/webview.css` bundle

### Build Commands

```json
{
  "build:debug": "Debug build (development)",
  "build:release": "Release build (marketplace)",

  "build:extension:debug": "node scripts/build-extension.js",
  "build:extension:release": "node scripts/build-extension.js --prod --no-sourcemap",

  "build:webview:debug": "node scripts/build-webview.js",
  "build:webview:release": "node scripts/build-webview.js --prod --no-sourcemap",

  "watch:debug": "Live reload for development",
  "watch:extension:debug": "node scripts/build-extension.js --watch",
  "watch:webview:debug": "node scripts/build-webview.js --watch"
}
```

### Build Script Flags

- **No flags** - Debug build (sourcemaps, all console.*, no minification)
- **`--prod`** - Production build (minified, console cleanup, no sourcemaps)
- **`--watch`** - Watch mode (debug build with live reload)
- **`--no-sourcemap`** - Explicitly disable sourcemaps (marketplace builds)

## Adding New Features

When you add a new feature, follow this pattern:

### 1. Write the code

```typescript
// src/webview/features/myFeature.ts
export function setupMyFeature() {
  // Implementation
}

// Make it globally accessible if needed
window.myFeature = setupMyFeature;
```

### 2. Import in entry point

```typescript
// src/webview/editor.ts
import { setupMyFeature } from './features/myFeature';

// Use it
setupMyFeature();
```

### 3. Add to verification

```javascript
// scripts/verify-build.js
const CRITICAL_FEATURES = {
  webviewJs: {
    required: [
      'setupMyFeature', // Add your feature here
      // ... other features
    ],
  },
};
```

### 4. Add CSS (if needed)

```css
/* src/webview/editor.css */
.my-feature-class {
  /* styles */
}
```

```javascript
// scripts/verify-build.js
webviewCss: {
  required: [
    '.my-feature-class',  // Add CSS class here
  ],
}
```

### 5. Test the verification

```bash
npm run build:debug
npm run verify-build  # Should pass with your new feature
```

## Common Mistakes to Avoid

### ❌ Dynamic class names

```typescript
// BAD - tree-shaking can't track this
const className = `my-${type}-class`;
```

### ✅ Static class names

```typescript
// GOOD - tree-shaker understands this
const className = type === 'foo' ? 'my-foo-class' : 'my-bar-class';
```

### ❌ Unused exports

```typescript
// BAD - might get tree-shaken
export function myFeature() {
  /* ... */
}
```

### ✅ Actually use it

```typescript
// GOOD - explicitly called
export function myFeature() {
  /* ... */
}
setupMyFeature(); // Call it somewhere
```

### ❌ Forgetting to import CSS

```typescript
// BAD - CSS won't be bundled
// Missing: import './myFeature.css';
```

### ✅ Import CSS explicitly

```typescript
// GOOD
import './myFeature.css'; // esbuild will bundle this
```

## Troubleshooting

### Quick Diagnosis

Is my build broken?

```bash
npm run verify-build
```

If this passes, your build is good. If it fails, see below.

### Common Build Issues

#### 1. "Build verification FAILED - critical features are missing"

**What it means**: Important code or CSS was removed during bundling.

**Quick fix**:

```bash
# Clean and rebuild
rm -rf dist/
npm run build:debug
npm run verify-build
```

**If that doesn't work**:

1. Check the verification output to see WHICH features are missing
2. Look for the feature in source code:
   ```bash
   # For JavaScript features
   grep -r "myMissingFeature" src/

   # For CSS classes
   grep -r ".my-missing-class" src/
   ```
3. Verify the feature is imported/used in entry files:
   - Extension: `src/extension.ts`
   - Webview: `src/webview/editor.ts`

4. If it's a global function (like `window.setupImageResize`), ensure it's assigned to the window object

#### 2. Feature works in development but not in production

**Cause**: Tree-shaking removes "unused" code in production builds.

**Solution**:

1. Add the feature to verification script:

   ```javascript
   // scripts/verify-build.js
   webviewJs: {
     required: [
       'myFeatureName', // Add here
     ],
   }
   ```

2. Ensure code is actually used (not just defined):
   ```typescript
   // BAD - might get tree-shaken
   export function myFeature() { ... }

   // GOOD - explicitly used
   export function myFeature() { ... }
   setupMyFeature(); // Actually call it somewhere
   ```

#### 3. CSS classes not applying

**Diagnosis**:

```bash
# Check if CSS made it to bundle
grep "my-class-name" dist/webview.css
```

**Common causes**:

1. **Not imported**: Ensure CSS is imported in `src/webview/editor.ts`:

   ```typescript
   import './editor.css';
   ```

2. **Dynamic class names**: esbuild can't tree-shake properly with template strings:

   ```typescript
   // BAD - might get optimized away
   const className = `my-${type}-class`;

   // GOOD - static class names
   const className = type === 'foo' ? 'my-foo-class' : 'my-bar-class';
   ```

3. **Unused selectors**: If a class is never referenced in JS, it might be removed:
   ```css
   /* Add to verification if critical */
   .critical-class { ... }
   ```

#### 4. "TypeError: X is not a function" at runtime

**Diagnosis**:

```bash
# Check if function exists in bundle
grep -o "myFunctionName" dist/webview.js
```

**Solutions**:

1. **Minified name**: Function got renamed. Search for unique strings instead:

   ```bash
   grep "unique string from function body" dist/webview.js
   ```

2. **Tree-shaken**: Add to verification and ensure it's actually called

3. **Wrong context**: Check `this` binding:
   ```typescript
   // BAD
   window.myFunc = this.myFunc;

   // GOOD
   window.myFunc = this.myFunc.bind(this);
   // OR
   window.myFunc = () => this.myFunc();
   ```

#### 5. Bundle size exploded

**Diagnosis**:

```bash
# Check current sizes
ls -lh dist/

# Compare to guidelines:
# extension.js: 1-3 MB
# webview.js: 3-6 MB
# webview.css: 100-250 KB
```

**Common causes**:

1. **Accidentally bundled development dependencies**:

   ```bash
   # Check package.json - these should be in devDependencies:
   # - @types/*
   # - eslint
   # - jest
   # - typescript
   ```

2. **Duplicate dependencies**: Check for multiple versions:

   ```bash
   npm ls
   ```

3. **Large assets inlined**: Check for images/fonts that should be external:
   ```typescript
   // BAD - inlines entire image
   import logo from './logo.png';

   // GOOD - reference as URL
   const logoUrl = '/images/logo.png';
   ```

#### 6. Works in F5 debug but not in installed .vsix

**Cause**: Development vs production build differences.

**Solution**:

1. Always test the actual .vsix file before publishing:

   ```bash
   npm run package:release
   code --install-extension markdown-for-humans-<x.y.z>.vsix
   ```

2. Check browser console in webview (Help > Toggle Developer Tools)

3. Check extension host logs (Help > Toggle Developer Tools > Extension Host)

### Emergency: Released broken version

#### Step 1: Verify the issue

```bash
# Download your published .vsix
# Extract and check bundle
unzip markdown-for-humans-<x.y.z>.vsix
grep "myBrokenFeature" extension/dist/webview.js
```

#### Step 2: Quick hotfix

```bash
# Fix the issue in code
# Rebuild with verification
npm run build:debug
npm run verify-build

# Then follow docs/RELEASE_CHECKLIST.md: bump the version in a release PR,
# package once from merged main, test the vsix, publish that same file.
```

#### Step 3: Post-mortem

1. Add missing feature to `scripts/verify-build.js`
2. Add test case to prevent regression
3. Update this document if needed

### Prevention Checklist

Before committing code that adds new features:

- [ ] Feature code is imported/used in entry file
- [ ] Feature added to `scripts/verify-build.js`
- [ ] `npm run verify-build` passes
- [ ] Tested in development (F5)
- [ ] Tested in production (.vsix install)
- [ ] Tests added/updated

### Getting Help

If you're still stuck:

1. Check build output carefully - errors often point to the issue
2. Review this document for architecture overview
3. Compare your feature to similar working features
4. Use git bisect to find when it broke:
   ```bash
   git bisect start
   git bisect bad  # current broken version
   git bisect good v0.0.9  # last working version
   # Test each commit with: npm run build:release
   ```

## Bundle Size Guidelines

- `extension.js`: 1-3 MB (Node.js dependencies included)
- `webview.js`: 3-6 MB (includes TipTap, syntax highlighting, etc.)
- `webview.css`: 100-250 KB

Sizes larger than these ranges may indicate bundling issues.

## Debugging Build Issues

### View Unminified Bundle

```bash
# Build without minification
esbuild src/webview/editor.ts --bundle --outfile=dist/webview.debug.js --format=iife --sourcemap
```

### Analyze Bundle Contents

```bash
# Install bundle analyzer
npm install -g esbuild-visualizer

# Generate analysis
esbuild-visualizer --bundle dist/webview.js
```

### Check What's Tree-Shaken

```bash
# Build with metafile
esbuild src/webview/editor.ts --bundle --outfile=dist/webview.js --metafile=meta.json

# Analyze metafile
node -e "console.log(require('./meta.json'))"
```

## Pre-Release Checklist

### 1. Pre-build Checks

- [ ] All changes committed to git
- [ ] Version bumped in package.json
- [ ] CHANGELOG.md updated

### 2. Build & Verify

```bash
npm run build:release  # Build with release settings
npm test              # Run all tests
# verify-build runs automatically with build:release
```

### 3. Local Testing

**Option A: F5 Debugging (Recommended for development)**

- Press F5 in VS Code to launch extension in debug mode
- Full breakpoints, console logs, and live reload
- No packaging needed

**Option B: Package Testing (Final verification before release)**

```bash
npm run package:release  # Creates release .vsix (via vscode:prepublish hook)
code --install-extension markdown-for-humans-X.Y.Z.vsix
```

Test these features manually:

- [ ] Image paste/drop
- [ ] Image resize
- [ ] Syntax highlighting in code blocks
- [ ] Table editing
- [ ] Export to PDF/DOCX
- [ ] Markdown to HTML rendering
- [ ] Check browser console for errors (no console.log in release build)

### 4. Publish

Follow [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md). The git tag is created by publishing the GitHub release, not by hand.

## CI

`.github/workflows/ci.yml` runs lint, typecheck, Jest with coverage, the SVG browser fixture, the release build, the deterministic performance gate on Ubuntu and Windows, the Extension Host suite on both operating systems against VS Code 1.98.0 and stable, and `npm run package:release` (which runs `build:release` again through the `vscode:prepublish` hook and uploads the vsix as an artifact). Branch protection on `main` requires `package`, `test (22.x)` and `test (24.x)`.

## Quick Reference

### Quick Commands

```bash
# Development
npm run build:debug        # Debug build (sourcemaps, all logs)
npm run watch:debug        # Auto-rebuild on changes (debug mode)
npm run verify-build       # Check build integrity

# Testing
npm test                   # Run tests
npm run test:coverage      # With coverage

# Packaging
npm run package:release    # Release package (via vscode:prepublish hook)

# Publishing: see RELEASE_CHECKLIST.md (one vsix, published as-is to both stores)
```

### Expected Bundle Sizes

```
dist/extension.js:  1-3 MB     (Node.js backend)
dist/webview.js:    3-6 MB     (TipTap + deps)
dist/webview.css:   100-250 KB (All styles)
```

If significantly larger: investigate duplicate dependencies or inlined assets.
If significantly smaller: features might be missing (run verify-build).

### Key Files

```
scripts/verify-build.js    # Build verification script
docs/BUILD.md             # This file - complete build guide
.vscode/tasks.json        # VS Code build tasks
package.json              # Scripts configuration
```

### Quick Diagnosis

**Build passes but feature missing at runtime?**

1. Check console errors (Help > Toggle Developer Tools)
2. Verify feature in bundle: `grep "myFeature" dist/webview.js`
3. Check if CSS loaded: `grep ".my-class" dist/webview.css`

**Verification fails?**

1. Check which features are missing (script output shows this)
2. Verify source code has the feature
3. Ensure it's imported in entry file
4. Rebuild and verify again

**Different behavior in dev vs production?**

- Dev uses unminified code
- Production uses minified + tree-shaken code
- Always test .vsix file before publishing

## Resources

- [VS Code Extension API](https://code.visualstudio.com/api)
- [esbuild Documentation](https://esbuild.github.io/)
- [vsce CLI](https://github.com/microsoft/vscode-vsce)
