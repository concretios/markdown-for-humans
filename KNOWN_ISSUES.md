# Known Issues & Technical Debt

This document tracks known issues, limitations, workarounds, and technical debt for Markdown for Humans.

> **For Users:** Check the issues and workarounds sections below. If you encounter an issue not listed here, please [report it](https://github.com/concretios/markdown-for-humans/issues).
>
> **For Developers:** See technical debt, roadmap, and development guidelines sections. For troubleshooting during development, see [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md).

> **Note:** Updated on 2025-12-27 after pre-release audit. All items are **non-blocking** for the v0.1.0 release.

---

## 🔴 High Priority Issues

_None currently. All critical issues have been resolved._

---

## 🟡 Medium Priority Issues

### Enter Key in Table Cells
**Type:** Bug
**Description:** Pressing Enter in table cells creates new paragraphs within the cell, which breaks markdown table formatting when serialized. Markdown tables require single-line cells or `<br>` tags for line breaks, not multiple paragraphs.
**Status:** Under consideration
**Current Behavior:** TipTap's TableKit extension allows Enter key to create paragraphs in table cells by default.
**Workaround:** Use source view to edit table cells, or use Shift+Enter for line breaks within cells (if supported). Avoid pressing Enter in table cells to prevent formatting issues.
**Future Consideration:** Enter key in table cells should be disabled or converted to `<br>` tags to preserve markdown table structure.

### Workspace File Drag-Drop in Cursor IDE
**Type:** Bug
**Description:** Dragging image files from the workspace file explorer into the markdown editor does not work in Cursor IDE. The drag-drop functionality works correctly in VS Code and Windsurf, but in Cursor, workspace file drops are not detected or processed.
**Status:** Under investigation
**Related Fix:** A previous fix ([Fix Cursor IDE drag-drop opening files in tabs](roadmap/shipped/fix_cursor_ide_drag-drop_opening_files_in_tabs_70263667.plan.md)) prevented files from opening in tabs, but workspace file drag-drop detection still fails in Cursor.
**Current Behavior:** Workspace file drag-drop is not detected in Cursor IDE, so images are not inserted into the editor. External file drag-drop (from Finder/desktop) may work, but workspace file explorer drag-drop does not.
**Workaround:** Use the image insert dialog (click the image button in the toolbar) or use source view to manually add image references. Alternatively, use external file drag-drop from Finder/desktop if the file is accessible outside the workspace.
**Future Consideration:** Cursor IDE may handle drag-drop events differently than VS Code/Windsurf, requiring additional event handling or data transfer format detection for workspace files.

---

## ✅ Recently Fixed

### Enter Key at Gap Cursor Before Image
**Type:** Bug (fixed)
**Description:** ArrowLeft beside a selected inline image placed a gap/text caret before the image, but Enter inserted a new paragraph to the **right** (after the containing block) instead of to the **left**.
**Status:** Fixed — gap-cursor Enter now maps to document-level insert before/after the containing block; text-caret fallback is direction-aware. Hot-path debug `console.log` removed.
**Plan:** [Fix Enter Key at Gap Cursor Before Image](roadmap/shipped/fix_enter_key_at_gap_cursor_before_image_6b029688.plan.md)
**Tests:** `src/__tests__/webview/imageEnterSpacing.test.ts` (inline gap before/after, multi-image, ArrowLeft/Right→Enter); crash repro updated to assert boundary insert.

---

## 🟢 Low Priority / Minor Issues

### Code Block Language Indicator and Picker
**Type:** Feature Gap
**Description:** Code blocks don't display their language indicator, and there's no easy way to see or change the language of an existing code block. Users must use source view to manually edit the language tag in the markdown syntax.
**Status:** Under consideration
**Proposed Solution:** Show the language label on hover over code blocks, with a dropdown menu to easily change the language.
**Workaround:** Use source view (click the `</>` Source button) to manually edit the language tag in code block syntax (e.g., change ` ```javascript` to ` ```typescript`).
**Future Consideration:** A hover-based language indicator with dropdown picker is planned for code blocks.

---

## 📝 Limitations & Design Decisions

### Large Document Performance
**Type:** Design Limitation
**Description:** Documents with 10,000+ lines may experience slower performance during editing. This is due to TipTap's document model processing.
**Workaround:** Consider splitting very large documents into multiple files.
**Future Consideration:** Virtual scrolling and lazy loading are planned for future releases.

### Image Processing
**Type:** Design Limitation
**Description:** Very large images (>10MB) may take longer to process during drag-and-drop or resize operations, even with automatic resizing.
**Current Behavior:** Images larger than 2MB or 2000px automatically trigger a resize dialog offering to downsize them to a suggested resolution.
**Workaround:** Use the built-in resize dialog when prompted, or resize extremely large images externally before adding them to documents.

### PDF and Word Export - Images and Diagrams
**Type:** Design Limitation
**Description:** PDF and Word exports have limited support for images and Mermaid diagrams.
**Current Behavior:**
- **Both formats (since 0.4.0):** Export embeds only images the editor itself can show. Local images outside the document's folder and the workspace (absolute paths elsewhere on disk, `..` paths that leave the workspace, symlinks that point outside it) and `http:` images are left out of the exported file.
- **PDF Export:** HTTPS images are fetched while exporting. Image conversion to data URLs is currently disabled.
- **Word Export:** Remote images (HTTP/HTTPS URLs) are explicitly skipped and not embedded. Embedded images are currently missing from Word documents; see the 0.4.0 known issues in the CHANGELOG.
- **Mermaid Diagrams:** While converted to PNG in the webview, they may not render correctly in exported documents if the conversion process fails.
**Workaround:**
- For PDF: Keep images inside the workspace or next to the document and reference them with relative paths. Download remote images into the workspace before exporting.
- For Word: Download remote images locally before exporting. Ensure images use relative paths from the document location.
- For Mermaid: Verify diagrams render correctly in the editor before exporting. If issues occur, try recreating the diagram.
**Future Consideration:** Image conversion to data URLs will be re-enabled, and remote image fetching will be added for both export formats.

---

## 🔧 Common Workarounds

### Extension Not Opening Files
**Issue:** Right-click → "Open with Markdown for Humans" doesn't work
**Workaround:**
1. Open VS Code Command Palette (Cmd/Ctrl + Shift + P)
2. Type "Markdown for Humans: Open File"
3. Select the command

### Theme Colors Not Matching
**Issue:** Editor colors don't match VS Code theme
**Workaround:**
1. Reload VS Code window (Cmd/Ctrl + Shift + P → "Reload Window")
2. If issue persists, check VS Code theme settings

---

## 🔧 Technical Debt & Development Items

> **Note for Developers:** Items below are tracked for future versions. All are non-blocking for v0.1.0 release.

### ESLint Type Safety in Tests
**Status:** 83 warnings (0 errors) ✅ Major improvement from 569 issues
**Impact:** Test code maintainability
**Files Affected:** Test files and mocks only

**Current State:**
- **83 warnings:** All `@typescript-eslint/no-explicit-any` in test files and mocks
- **0 errors:** All blocking errors have been resolved ✅
- Production code is clean - only test/mock files use `any` types

**Decision:** ✅ Keep as-is for v0.1.0. These warnings are acceptable in test code.

### Bundle Size Optimization
**Current Size:** 3.1 MB (marketplace package) ✅ Within acceptable range
**Bundle Analysis:**
- **webview.js:** 4.3 MB (includes Mermaid ~2MB, TipTap, dependencies)
- **extension.js:** 1.8 MB (includes docx, cheerio, PDF export)

**Status:** Acceptable for v0.1.0 - defer optimization to v0.2.0
**Target for v0.2.0:** < 2.8 MB

**Future Optimization Strategies (v0.2.0):**
- Lazy-load Mermaid (only when diagram features used)
- Evaluate if all TipTap extensions are needed
- Consider making PDF/Word export optional

### Build System Enhancements
**Current:** Dual build system working well ✅
**Improvement:** Minor polish for developer experience

**Current Setup:**
- ✅ Marketplace build (no source maps): `npm run build:marketplace`
- ✅ Development build (with source maps): `npm run build`
- ✅ Build verification: `npm run verify-build`
- ✅ Console.log removal via build flags

**Status:** Working well, no urgent changes needed

### Documentation & Repository Polish

**GitHub Repository Setup:**
- [x] Repository exists: https://github.com/concretios/markdown-for-humans
- [x] README.md comprehensive and professional
- [x] LICENSE file present (MIT)
- [x] CONTRIBUTING.md present
- [x] Gallery banner added ✅
- [ ] **TODO:** Set up GitHub Wiki (README currently references it)
- [ ] **TODO:** Enable GitHub Discussions for community Q&A
- [ ] **TODO:** Add repository topics: `vscode-extension`, `markdown`, `wysiwyg`, `tiptap`
- [ ] **TODO:** Create v0.1.0 GitHub release with notes

**Future README Enhancements (v0.2.0+):**
- Add installation GIF/video
- Add keyboard shortcuts reference
- Create troubleshooting section in wiki
- Add feature comparison table vs other markdown editors

### Testing & Quality

**Test Coverage:** ✅ Excellent
- **584 tests passing** (25 skipped, 121 todo)
- All test suites pass
- Good coverage across features

**Future Improvements (v0.2.0+):**
- Add E2E tests for critical user workflows
- Test marketplace package installation
- Performance testing with large documents (10,000+ lines)
- Memory leak testing for long editing sessions

---

## 🔍 Technical Debt Analysis

### Dependencies to Evaluate (v0.2.0):
```json
// Heavy dependencies - consider optimization:
"mermaid": "^10.6.1",           // ~2MB - candidate for lazy loading
"docx": "^9.5.1",              // Word export - consider optional
"cheerio": "^1.1.2",           // HTML parsing - keep (essential)
"@tiptap/starter-kit": "^3.0.0" // Evaluate which extensions are actually used
```

### Code Organization (Minor, v0.2.0+):
- `src/webview/features/` - some large files could be split (not urgent)
- Overall architecture is solid ✅
- Good separation of concerns ✅

### Architecture Review (v0.2.0+):
1. **TipTap Extension Strategy:** Evaluate which extensions are actually needed
2. **Mermaid Integration:** Consider lazy loading for bundle size
3. **Export Functionality:** PDF/Word export adds size but provides value
4. **Image Handling:** Current implementation works well

---

## 📋 Implementation Roadmap

### Version 0.1.0 (Current - Ready for Release) ✅
- [x] Fix all ESLint errors (0 errors remaining) ✅
- [x] Comprehensive test coverage (584 tests passing) ✅
- [x] Bundle size within acceptable range (3.1 MB) ✅
- [x] All documentation complete ✅
- [x] Build system working ✅
- [x] CI/CD pipeline configured ✅
- [x] Gallery banner added ✅

### Version 0.2.0 (Quality & Performance)
- [ ] Lazy loading for Mermaid (reduce initial bundle)
- [ ] Reduce bundle size to < 2.8 MB
- [ ] Add E2E tests
- [ ] Performance optimizations for large documents
- [ ] GitHub Wiki setup
- [ ] GitHub Discussions enabled
- [ ] Repository topics added

### Version 0.3.0 (Features & Polish)
- [ ] Code block language picker UI
- [ ] Enhanced table editing features
- [ ] Advanced export options
- [ ] Installation video/GIF

### Future Versions
- [ ] Plugin system for custom extensions
- [ ] Collaboration features
- [ ] Cloud synchronization

---

## 📊 Current Metrics (v0.1.0)

### Build Quality: ✅ Production Ready
- **Lint Issues:** 83 warnings, **0 errors** ✅ (85% improvement from initial 569 issues)
- **Package Size:** 3.1 MB (target: < 3.5 MB) ✅
- **Bundle Size:** 6.1 MB total (webview: 4.3MB, extension: 1.8MB)
- **Test Status:** 584 passing, 0 failing ✅
- **Build Time:** ~200ms for marketplace build ✅

### Issue Statistics
- **Total Known User-Facing Issues:** 4
- **High Priority:** 0
- **Medium Priority:** 3
- **Low Priority:** 1
- **Limitations:** 3
- **Technical Debt Items:** 5

### Release Checklist:
- [x] All tests pass ✅
- [x] No blocking lint errors ✅
- [x] Documentation complete ✅
- [x] License file present ✅
- [x] CI/CD configured ✅
- [x] Gallery banner configured ✅
- [x] Git tag v0.1.0 created ✅
- [ ] Repository made public
- [ ] GitHub release created from tag
- [ ] VS Code Marketplace published

### Target Metrics (v0.2.0):
- **Package Size:** < 2.8 MB
- **Bundle Size:** < 5.5 MB total
- **Lint Issues:** < 50 warnings
- **E2E Test Coverage:** Add E2E tests
- **Performance:** Optimize for 10,000+ line documents

---

## 🔗 Related Files

### Build Configuration:
- [package.json](package.json) - Build scripts and dependencies
- [scripts/build-webview.js](scripts/build-webview.js) - Webview build logic
- [eslint.config.js](eslint.config.js) - Linting configuration
- [.vscodeignore](.vscodeignore) - Package exclusion rules
- [.github/workflows/ci.yml](.github/workflows/ci.yml) - CI pipeline

### Documentation:
- [README.md](README.md) - User documentation
- [CHANGELOG.md](CHANGELOG.md) - Release notes
- [CONTRIBUTING.md](CONTRIBUTING.md) - Development guidelines
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) - Development troubleshooting

---

## 📝 Release Status Summary

### What Changed Since Initial Audit:
- **Lint errors reduced from 30 to 0** ✅ (100% improvement)
- **Total lint issues reduced from 569 to 83** ✅ (85% improvement)
- All remaining warnings are in test/mock files only
- CI workflow updated to use correct branch names (`main`)
- Gallery banner added for marketplace presentation
- Repository URLs corrected in package.json

### Current Status:
**✅ READY FOR PUBLIC RELEASE**

The extension is production-ready with:
- Zero blocking errors
- Comprehensive test coverage (584 passing tests)
- Complete documentation
- Professional marketplace presentation
- Solid architecture
- Working CI/CD pipeline

### What's Left:
All items in this document are **nice-to-haves** for future versions (v0.2.0+), not blockers for v0.1.0.

**Immediate Next Steps:**
1. Make repository public
2. ✅ Create v0.1.0 git tag (completed)
3. Create v0.1.0 GitHub release from tag
4. Publish to VS Code Marketplace

---

## Contributing

If you find a workaround for a known issue or have additional information, please:
1. Update this document via a pull request
2. Or comment on the related GitHub issue

---

**Last Updated:** 2026-10-01
**Status:** ✅ Production Ready for v0.1.0
**Next Review:** After v0.1.0 marketplace release (plan v0.2.0 improvements)

**Note:** This document is maintained manually. For the most up-to-date issue tracking, see [GitHub Issues](https://github.com/concretios/markdown-for-humans/issues).
