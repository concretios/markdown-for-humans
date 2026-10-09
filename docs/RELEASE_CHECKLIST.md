# Release Checklist

Quick checklist for publishing Markdown Editor for Humans to VS Code Marketplace.

---

## 📋 Release Workflow Summary

### Standard Release (Recommended)

```bash
# 1. Update CHANGELOG.md ONLY (single source of truth)
# Add new version section with human-readable changes
# Format: What's New, Fixed, Changed, Technical Improvements
# ⚠️  NEVER create separate RELEASE_NOTES_*.md files

# 2. Run full test suite
npm run lint:fix && npm test && npm run build:release

# 3. Test locally
npm run package:release
code --install-extension markdown-for-humans-*.vsix
# Test features manually

# 4. Commit changes (version will auto-bump on publish)
git add CHANGELOG.md
git commit -m "chore: prepare release"
git push

# 5. Publish to VS Code Marketplace (auto-bumps version)
vsce login concretio
vsce publish patch  # Choose: patch, minor, or major

# 6. Publish to Open VSX Registry (for Cursor & Windsurf)
# First time only: ovsx create-namespace concretio -p <your-token>
ovsx publish -p <your-token>

# 7. Create git tag AFTER publish
git tag v$(node -p "require('./package.json').version")
git push origin --tags

# 8. Create GitHub release
# Go to: https://github.com/concretios/markdown-for-humans/releases/new
# Select the tag, copy/polish content from CHANGELOG.md, publish
# Tip: Make it user-friendly with emojis and "What's New" sections
```

### Version Bump Types

| Command | Use Case | Example |
|---------|----------|---------|
| `vsce publish patch` | Bug fixes, minor updates | 0.1.0 → 0.1.1 |
| `vsce publish minor` | New features, non-breaking | 0.1.1 → 0.2.0 |
| `vsce publish major` | Breaking changes | 0.2.0 → 1.0.0 |

---

## Pre-Release

### Code Quality
- [ ] Fix linting issues: `npm run lint:fix`
- [ ] All tests pass: `npm test`
- [ ] Build succeeds: `npm run build:release`

### Version & Changelog
- [ ] **Update `CHANGELOG.md` with new version section** (this is your ONLY changelog file)
- [ ] Write human-readable release notes (What's New, Fixed, Changed sections)
- [ ] Use CHANGELOG.md content for GitHub releases (copy/polish as needed)
- [ ] ⚠️ **Never create separate RELEASE_NOTES_*.md files** - they become stale
- [ ] Commit all changes (version will be auto-bumped during publish)

### Package & Test
- [ ] Create package: `npm run package:release`
- [ ] Verify `.vsix` file created and size < 10MB
- [ ] Test local installation: `code --install-extension markdown-for-humans-<version>.vsix`
- [ ] Test core features in Extension Development Host:
  - [ ] WYSIWYG editing
  - [ ] Tables (create, resize, context menu)
  - [ ] Images (drag-drop, paste, resize)
  - [ ] Mermaid diagrams
  - [ ] Code blocks
  - [ ] Document outline sidebar
  - [ ] Toolbar formatting

### Documentation Review
- [ ] README.md - badges, links, features accurate
- [ ] CHANGELOG.md - version section complete, format correct
- [ ] Legal docs - "Last Updated" dates current (PRIVACY_POLICY, TERMS_OF_USE, EULA)

### Assets Review
- [ ] `icon.png` - 128x128 or 256x256, looks good on light/dark backgrounds
- [ ] Screenshots in `marketplace-assets/screenshots/` - high quality, showcase features

## Publication

### Marketplace Account
- [ ] Publisher account verified: https://marketplace.visualstudio.com/manage
- [ ] 2FA enabled on publishing account
- [ ] Personal Access Token created (scope: "Marketplace (Manage)")

### Publish to VS Code Marketplace

**Recommended: Automatic version bump + publish**
- [ ] Login: `vsce login concretio`
- [ ] Choose version type and publish:
  - `vsce publish patch` — Bug fixes (0.1.0 → 0.1.1)
  - `vsce publish minor` — New features (0.1.1 → 0.2.0)
  - `vsce publish major` — Breaking changes (0.2.0 → 1.0.0)

**Alternative: Manual version control**
- [ ] Update version in `package.json` manually
- [ ] Run `vsce publish` (publishes current version)

**Alternative: Web upload**
- [ ] Build: `npm run package:marketplace`
- [ ] Upload `.vsix` at https://marketplace.visualstudio.com/manage

### Publish to Open VSX Registry (For Cursor, Windsurf, VSCodium & More)

**Why:** Makes extension available in Open VSX-compatible editors:
- Cursor IDE
- Windsurf Editor
- VSCodium
- Gitpod
- Eclipse Theia
- Other Open VSX-compatible IDEs

**One-Time Setup (First Publish Only):**
- [ ] Install ovsx CLI: `npm install -g ovsx`
- [ ] Get token from https://open-vsx.org/user-settings/tokens
- [ ] Create namespace: `ovsx create-namespace concretio -p <your-token>`
  - ⚠️ **Required before first publish** - namespace must match publisher in package.json
  - Only needed once per publisher

**Every Release:**
- [ ] Publish: `ovsx publish -p <your-token>`
- [ ] Verify at https://open-vsx.org/extension/concretio/markdown-for-humans

### Git Tag & GitHub Release (Post-Publish)

**Create Git Tag:**
- [ ] Check published version: `cat package.json | grep version`
- [ ] Create tag: `git tag v<version>` (e.g., `git tag v0.1.1`)
- [ ] Push tag: `git push origin v<version>`

**Create GitHub Release:**
- [ ] Create release: https://github.com/concretios/markdown-for-humans/releases/new
- [ ] Select tag: `v<version>` (just created)
- [ ] Title: "v<version> - <description>"
- [ ] Description: Copy from CHANGELOG.md
- [ ] Attach `.vsix` file (optional)
- [ ] Mark as "Latest release"
- [ ] Publish

## Post-Release

### Verify VS Code Marketplace
- [ ] Extension appears: https://marketplace.visualstudio.com/items?itemName=concretio.markdown-for-humans
- [ ] All metadata correct
- [ ] Screenshots display correctly
- [ ] Links work
- [ ] Test installation from VS Code

### Verify Open VSX Registry
- [ ] Extension appears: https://open-vsx.org/extension/concretio/markdown-for-humans
- [ ] All metadata correct
- [ ] Test installation from at least one Open VSX-compatible IDE:
  - [ ] Cursor IDE
  - [ ] Windsurf Editor
  - [ ] VSCodium
  - [ ] Other (specify): _______

---

**Quick Commands:**
```bash
# Full test cycle before publishing
npm run lint:fix && npm test && npm run build:release && npm run package:release

# Publish to VS Code Marketplace
vsce login concretio
vsce publish patch  # For bug fixes (0.1.0 → 0.1.1)
# or: vsce publish minor  # For new features (0.1.1 → 0.2.0)
# or: vsce publish major  # For breaking changes (0.2.0 → 1.0.0)

# Publish to Open VSX (for Cursor, Windsurf, VSCodium & more)
# First time only: ovsx create-namespace concretio -p <your-token>
ovsx publish -p <your-token>

# After publishing, create git tag
git tag v$(node -p "require('./package.json').version")
git push origin --tags
```

**Notes:**
- Get Open VSX token from https://open-vsx.org/user-settings/tokens
- First publish requires creating namespace: `ovsx create-namespace concretio -p <your-token>`

