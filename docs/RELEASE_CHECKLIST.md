# Release Checklist

Checklist for publishing Markdown Editor for Humans to the VS Code Marketplace, Open VSX and GitHub Releases.

**Releases are done by the repository owner only.** Contributors do not publish, tag or create releases; they open PRs. An agent runs a release step only when the owner asks for that step in the same session, one step at a time, and never from a routine, scheduled task or CI. Before the first publish step, run `scripts/release-publish.sh check` so a bad credential surfaces before anything is uploaded.

## Release credentials

Every publish goes through `scripts/release-publish.sh`. It knows which credential each store uses, refuses a vsix whose version is not the repo version, prints the vsix SHA-256, and never prints a token. Do not type the publish commands by hand.

| Store | Credential | Where it lives | Lifetime |
|---|---|---|---|
| VS Code Marketplace | Microsoft Entra sign-in (`az login --tenant concret.io --allow-no-subscriptions`) | The Azure CLI's own sign-in; no token is stored | About an hour per access token; `az` renews it while the sign-in lasts |
| Open VSX | Personal access token for namespace `concretio` | macOS login Keychain, service `ovsx-pat-concretio`, account `$USER` | Until revoked at https://open-vsx.org/user-settings/tokens |

| Command | What it does |
|---|---|
| `scripts/release-publish.sh check` | Checks both credentials, uploads nothing |
| `scripts/release-publish.sh marketplace <vsix>` | Publishes to the Marketplace with `--azure-credential` |
| `scripts/release-publish.sh openvsx <vsix>` | Publishes to Open VSX, reading the token from the Keychain for that one command |

Rules:
- **No Marketplace PAT.** If `check` reports a PAT stored by `vsce login`, remove it with `npx vsce logout concretio`; a bare `vsce publish` would otherwise use it instead of Entra.
- **Never print a token.** No `echo`, no `-w` without `>/dev/null`, no token in a file, a command line, chat or a log. Agents use the script and never read the Keychain value themselves.
- **Replace the Open VSX token** when `check` says it cannot publish: create one at https://open-vsx.org/user-settings/tokens, then `security add-generic-password -U -a "$USER" -s ovsx-pat-concretio -w` (prompts, nothing echoes).

---

## 📋 Release Workflow Summary

### Standard Release (Recommended)

```bash
# 1. Update CHANGELOG.md ONLY (single source of truth)
# Add new version section with human-readable changes
# Format: What's New, Fixed, Changed, Technical Improvements
# ⚠️  NEVER create separate RELEASE_NOTES_*.md files

# 2. Run the same checks CI runs
npm run lint && npm run typecheck && npm test && npm run build:release

# 3. Test locally
npm run package:release
code --install-extension markdown-for-humans-*.vsix
# Test features manually

# 4. Bump the version and date the CHANGELOG on a branch, open a PR, merge when CI is green
npm version <x.y.z> --no-git-tag-version
# Move [Unreleased] under [x.y.z] - YYYY-MM-DD; update the KNOWN_ISSUES.md version lines
# src/__tests__/release/releaseDocs.test.ts fails the PR if any of those is stale
# Branch protection requires an up-to-date branch: if another PR merges first, merge origin/main into the release branch and push, or auto-merge stays stuck

# 5. From merged main, in the main checkout (not a worktree), build ONE vsix and publish that same file everywhere
git checkout main && git pull
npx vsce package
az login --tenant concret.io --allow-no-subscriptions             # Entra sign-in, once per session (needs publisher membership)
scripts/release-publish.sh check                                   # both credentials, uploads nothing
scripts/release-publish.sh marketplace markdown-for-humans-<x.y.z>.vsix   # VS Code Marketplace, on the owner's go
scripts/release-publish.sh openvsx markdown-for-humans-<x.y.z>.vsix       # Open VSX, on the owner's go
# NEVER use `vsce publish patch|minor|major`: it bumps the version at publish time

# 6. Draft the GitHub release with the vsix attached (tag is created when you publish it)
gh release create v<x.y.z> markdown-for-humans-<x.y.z>.vsix --draft --target <full merge SHA> --notes-file <notes.md>

# 7. When both stores show the new version, publish the draft as Latest
gh release edit v<x.y.z> --draft=false --latest
```

### Version Bump Types

| Change | Bump | Example |
|--------|------|---------|
| Bug fixes, small features (recent practice) | patch | 0.4.4 to 0.4.5 |
| Larger feature batch, non-breaking | minor | 0.4.5 to 0.5.0 |
| Breaking changes | major | 0.5.0 to 1.0.0 |

Set the version with `npm version <x.y.z> --no-git-tag-version`, never at publish time.

---

## Pre-Release

### Code Quality
- [ ] Lint is clean: `npm run lint`
- [ ] Types check: `npm run typecheck` (CI runs it; Jest alone misses files no test imports)
- [ ] All tests pass: `npm test`
- [ ] Build succeeds: `npm run build:release`

### Version & Changelog
- [ ] **Update `CHANGELOG.md` with new version section** (this is your ONLY changelog file)
- [ ] Write human-readable release notes (What's New, Fixed, Changed sections)
- [ ] Use CHANGELOG.md content for GitHub releases (copy/polish as needed)
- [ ] ⚠️ **Never create separate RELEASE_NOTES_*.md files** - they become stale
- [ ] Bump `package.json` and `package-lock.json` in the release PR (`npm version <x.y.z> --no-git-tag-version`)
- [ ] `src/__tests__/release/releaseDocs.test.ts` passes: it checks the CHANGELOG section is dated, the KNOWN_ISSUES version lines match, every setting is in the README table and the l10n status table matches the shipped bundles

### Package & Test
- [ ] Create package: `npm run package:release`
- [ ] Verify `.vsix` file created and size < 10MB
- [ ] Test local installation: `code --install-extension markdown-for-humans-<version>.vsix`
- [ ] Test core features in that VS Code window (the installed vsix, not an F5 host):
  - [ ] WYSIWYG editing
  - [ ] Tables (create, resize, context menu)
  - [ ] Images (drag-drop, paste, resize)
  - [ ] Mermaid diagrams
  - [ ] Code blocks
  - [ ] Document outline sidebar
  - [ ] Toolbar formatting

### Documentation Review
- [ ] README.md - badges (Open VSX only, the Marketplace badges were retired on purpose), links and features accurate; the Configuration table lists every setting in `package.json` (the release docs test checks this)
- [ ] KNOWN_ISSUES.md - version line current, limits of new features added, fixed entries removed
- [ ] l10n/README.md - status table matches the shipped languages
- [ ] CHANGELOG.md - version section complete, format correct
- [ ] Legal docs - the "Last Updated" date matches the last change to each text (PRIVACY_POLICY, TERMS_OF_USE, EULA); it does not move with releases

### Assets Review
- [ ] `icon.png` - 128x128 or 256x256, looks good on light/dark backgrounds
- [ ] Screenshots in `marketplace-assets/screenshots/` - high quality, showcase features

## Publication

### Marketplace Account (Microsoft Entra, no PAT)

Marketplace publishing uses Microsoft Entra sign-in. Do NOT create, paste or use an Azure DevOps PAT for `vsce`.
`vsce publish --azure-credential` borrows the identity that `az login` left on this machine.

- [ ] Publisher `concretio` lists your Entra user as Owner or Contributor: https://marketplace.visualstudio.com/manage/publishers/concretio (Members tab)
- [ ] Azure CLI installed (`az --version`)
- [ ] Signed in as that Entra user, not the personal md-human@concret.io account (personal Microsoft accounts cannot use `az login`):
  ```bash
  az login --tenant concret.io --allow-no-subscriptions
  az account show --query user.name -o tsv     # must print your Entra UPN
  az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query expiresOn -o tsv   # prints an expiry, never the token
  ```
- If the CLI crashes in the tenant picker (seen on Azure CLI 2.91.0): `az config set core.login_experience_v2=off`

### Publish to VS Code Marketplace

**Recommended: publish the exact vsix you tested**
- [ ] Merge the release PR, then from main in the main checkout: `npx vsce package` (one attempt in a scratch worktree failed with "Extension entrypoint(s) missing" on 2026-11-06, cause unknown; the main checkout is the known-good place)
- [ ] Confirm Entra sign-in (see Marketplace Account above)
- [ ] Publish: `scripts/release-publish.sh marketplace markdown-for-humans-<x.y.z>.vsix`
- [ ] Do not use `vsce publish patch|minor|major`; it changes the version at publish time
- [ ] The Marketplace takes about 15 minutes to validate before the new version shows

**If publish fails with 401 or 403, check in this order. Never fall back to a PAT silently.**
1. Wrong `az` account or tenant: `az account show` must show your Entra UPN and tenant `9620b1de-bb79-421a-9a24-2d5e7a184d10`
2. Your Entra user is not on the publisher Members page
3. A personal Microsoft account was used (it cannot mint Entra tokens)
4. Token expired: run `az login --tenant concret.io --allow-no-subscriptions` again

**Alternative: Web upload**
- [ ] Upload the `.vsix` at https://marketplace.visualstudio.com/manage

### Publish to Open VSX Registry (For Cursor, Devin Desktop, VSCodium & More)

**Why:** Makes extension available in Open VSX-compatible editors:
- Cursor IDE
- Devin Desktop (formerly Windsurf)
- VSCodium
- Gitpod
- Eclipse Theia
- Other Open VSX-compatible IDEs

**One-Time Setup (First Publish Only):**
- [ ] Install ovsx CLI: `npm install -g ovsx`
- [ ] Get token from https://open-vsx.org/user-settings/tokens
- [ ] Store it in the macOS Keychain, never in a dotfile: `security add-generic-password -a "$USER" -s ovsx-pat-concretio -w` (prompts for the value; nothing echoes)
  - Verify without printing it: `security find-generic-password -a "$USER" -s ovsx-pat-concretio -w >/dev/null && echo ok`
  - Dry run: `scripts/release-publish.sh check` checks the token against the namespace without publishing; expect "ok   Open VSX"
- [ ] Create namespace: `ovsx create-namespace concretio -p <your-token>`
  - ⚠️ **Required before first publish** - namespace must match publisher in package.json
  - Only needed once per publisher

**Every Release:**
- [ ] Dry run: `scripts/release-publish.sh check` (expects "ok   Open VSX")
- [ ] Publish the same vsix: `scripts/release-publish.sh openvsx markdown-for-humans-<x.y.z>.vsix`. Like the Marketplace publish, only on the owner's explicit go
- [ ] Open VSX takes about 10 minutes (pre-publish scan) before the new version shows
- [ ] Verify at https://open-vsx.org/extension/concretio/markdown-for-humans

### Git Tag & GitHub Release (Post-Publish)

**Draft first, publish after both stores show the new version:**
- [ ] `gh release create v<x.y.z> markdown-for-humans-<x.y.z>.vsix --draft --target <full merge SHA> --title "v<x.y.z> - <description>" --notes-file <notes.md>` (`--target` needs the full SHA, not a short one)
- [ ] Notes: a "New in" line, install links, then the CHANGELOG section for the version
- [ ] Publish: `gh release edit v<x.y.z> --draft=false --latest` (this creates the tag)

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
  - [ ] Devin Desktop (formerly Windsurf)
  - [ ] VSCodium
  - [ ] Other (specify): _______

---

**Quick Commands:**
```bash
# Full test cycle before the release PR
npm run lint && npm run typecheck && npm test && npm run build:release

# After merge, from main in the main checkout
git checkout main && git pull
npx vsce package
scripts/release-publish.sh check
scripts/release-publish.sh marketplace markdown-for-humans-<x.y.z>.vsix
scripts/release-publish.sh openvsx markdown-for-humans-<x.y.z>.vsix

# After both stores show the version
gh release edit v<x.y.z> --draft=false --latest
```

**Notes:**
- Get Open VSX token from https://open-vsx.org/user-settings/tokens
- First publish requires creating namespace: `ovsx create-namespace concretio -p <your-token>`

