# Troubleshooting Build & Release Issues

## Quick Diagnosis

### Is my build broken?

```bash
npm run verify-build
```

If this passes, your build is good. If it fails, see below.

## Common Build Issues

### 1. "Build verification FAILED - critical features are missing"

**What it means**: Important code or CSS was removed during bundling.

**Quick fix**:
```bash
# Clean and rebuild
rm -rf dist/
npm run build
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

### 2. Feature works in development but not in production

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

### 3. CSS classes not applying

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

### 4. "TypeError: X is not a function" at runtime

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

### 5. Bundle size exploded

**Diagnosis**:
```bash
# Check current sizes
ls -lh dist/

# Compare to guidelines:
# extension.js: 1-3 MB
# webview.js: 3-6 MB
# webview.css: 50-100 KB
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

### 6. Works in F5 debug but not in installed .vsix

**Cause**: Development vs production build differences.

**Solution**:

1. Always test the actual .vsix file before publishing:
   ```bash
   npm run package
   code --install-extension markdown-for-humans-0.1.0.vsix
   ```

2. Check browser console in webview (Help > Toggle Developer Tools)

3. Check extension host logs (Help > Toggle Developer Tools > Extension Host)

### Alpha diagnostics for save issues

When users report "Save didn't persist" or "content reverted", ask for logs from BOTH consoles:

1. Webview console (Developer: Open Webview Developer Tools)
2. Extension Host console (Help -> Toggle Developer Tools -> Extension Host)

Filter for `MD4H` and especially `MD4H][SAVE]`.

Correlated save logs now include a request ID, for example:

- Webview: `[MD4H][SAVE][save-abc123] Dispatching saveAndEdit ...`
- Extension host: `[MD4H][SAVE][save-abc123] applyEdit result: true`
- Extension host: `[MD4H][SAVE][save-abc123] document.save() result: true`
- Webview: `[MD4H][SAVE][save-abc123] Received "saved" signal from extension`

If the same request ID appears with an error, include all lines with that ID in the bug report.

## Emergency: Released broken version

### Step 1: Verify the issue

```bash
# Download your published .vsix
# Extract and check bundle
unzip markdown-for-humans-0.1.0.vsix
grep "myBrokenFeature" extension/dist/webview.js
```

### Step 2: Quick hotfix

```bash
# Fix the issue in code
# Rebuild with verification
npm run build
npm run verify-build

# Bump patch version
npm version patch

# Package and test locally
npm run package
code --install-extension markdown-for-humans-0.1.1.vsix

# Test thoroughly, then publish
vsce publish patch  # Auto-bumps version and publishes
```

### Step 3: Post-mortem

1. Add missing feature to `scripts/verify-build.js`
2. Add test case to prevent regression
3. Update docs/BUILD.md if needed

## Debugging Tools

### View unminified bundle

```bash
# Temporary debug build
esbuild src/webview/editor.ts \
  --bundle \
  --outfile=dist/webview.debug.js \
  --format=iife \
  --sourcemap
```

### Check what's being tree-shaken

```bash
# Build with metafile
esbuild src/webview/editor.ts \
  --bundle \
  --outfile=dist/webview.js \
  --format=iife \
  --metafile=meta.json

# View bundle analysis
node -e "console.log(JSON.stringify(require('./meta.json'), null, 2))" | less
```

### Compare builds

```bash
# Before changes
npm run build
cp dist/webview.js dist/webview.before.js

# After changes
# ... make changes ...
npm run build
cp dist/webview.js dist/webview.after.js

# Compare
diff <(strings dist/webview.before.js | sort) \
     <(strings dist/webview.after.js | sort) | less
```

## Prevention Checklist

Before committing code that adds new features:

- [ ] Feature code is imported/used in entry file
- [ ] Feature added to `scripts/verify-build.js`
- [ ] `npm run verify-build` passes
- [ ] Tested in development (F5)
- [ ] Tested in production (.vsix install)
- [ ] Tests added/updated

## Getting Help

If you're still stuck:

1. Check build output carefully - errors often point to the issue
2. Review docs/BUILD.md for architecture overview
3. Compare your feature to similar working features
4. Use git bisect to find when it broke:
   ```bash
   git bisect start
   git bisect bad  # current broken version
   git bisect good v0.0.9  # last working version
   # Test each commit with: npm run build && npm run verify-build
   ```

## Reference: File Structure

```
markdown-for-humans/
├── src/
│   ├── extension.ts          # Extension entry point
│   ├── editor/               # Extension backend code
│   └── webview/
│       ├── editor.ts         # Webview entry point (IMPORT CSS HERE)
│       ├── editor.css        # Main CSS file
│       ├── extensions/       # TipTap extensions
│       └── features/         # UI features
├── dist/                     # Build output (gitignored)
│   ├── extension.js          # Extension bundle
│   ├── webview.js            # Webview bundle
│   └── webview.css           # Webview styles
├── scripts/
│   └── verify-build.js       # Build verification
└── docs/
    └── BUILD.md              # Complete build guide (includes troubleshooting)
```
