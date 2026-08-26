# Changelog

All notable changes to Markdown for Humans will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Note:** This is the ONLY changelog file. Use this content for GitHub releases (copy and polish as needed with emojis and user-friendly sections).

## [Unreleased]

### Fixed

- Made Feedback split-view locks application-acknowledged and fail closed across delayed, duplicated, dropped, reloaded, and disposed renderer transitions.
- Replaced active Feedback ownership handoff with generation-bound apply, commit, and rollback stages. The host exposes the new owner only after every exact application ACK and peer lock completes.
- Prevented save, autosave, hidden-webview teardown, and pending image writes from losing the newest rich-editor revision.
- Added exact document edit identities, host-version barriers, reconciliation after rejected edits, and serialized `WorkspaceEdit` ordering.
- Hardened Feedback snapshot parity, table-cell selection mapping, capture cancellation, close recovery, and active-session restoration.
- Fixed A to B to A split-delivery races, conflicting document-edit ID reuse, CSS-sensitive raw-HTML whitespace suppression, and final-panel custom autosave loss.
- Made pending-image completion application acknowledged and retryable, with exact renderer-generation identities, atomic ProseMirror updates, dense typed-array retention, and fail-closed marker resolution.
- Bounded pending image memory without evicting unresolved markers, released image byte buffers after writes settle, and prevented oversized multi-image drops from exhausting the host queue.
- Pruned off-crop table rows, cells, and nested-list items during screenshot capture while preserving crop geometry and ordered-list numbering.
- Removed quadratic full-source line splitting from Feedback snapshot finalization.
- Replaced repeated linear Feedback item-to-anchor scans with logarithmic indexed lookup.
- Deferred screenshot body reads and hashing from automatic draft discovery to explicit Resume while retaining path, file-type, and quota checks.

### Changed

- Upgraded the complete TipTap family to exact `3.30.3` on one deduplicated ProseMirror dependency graph.
- Upgraded Mermaid to `11.17.2` and esbuild to `0.28.2`.
- Raised the supported runtime floor to VS Code `1.98.0`, with explicit Node 20 and Chromium 132 build targets.
- Disabled retained hidden webview contexts and restored bounded selection and scroll state after renderer recreation.
- Moved Markdown serialization behind the 500 ms debounce and added minimal edits for documents of at least 32 KiB.

### Security

- Replaced the vulnerable `image-size` dependency with bounded PNG, JPEG, GIF, and WebP header readers.
- Refreshed vulnerable compatible transitive dependencies. Production and development audits now report zero known vulnerabilities.
- Restricted webview local-file access to the exact extension/workspace or document roots, rejected out-of-root image requests, and honored cancelled editor resolution.

### Testing

- Added deterministic 3,000-word and 10,000-line performance fixtures, renderer fault injection, Windows and Ubuntu Extension Host CI, and minimum/current VS Code coverage.

---

## [0.3.0] - 2026-08-07

### What's New

#### Auto-Save

New opt-in `markdownForHumans.autoSave.enabled` setting saves the document a short delay after you stop typing, independent of VS Code's built-in `files.autoSave`. Off by default, so nothing changes unless you turn it on.

#### Formatting-Shortcut Control

Cmd/Ctrl+B/I/U were previously hardcoded to stay inside the editor, which could permanently shadow a VS Code keybinding bound to the same chord. New `markdownForHumans.formattingShortcuts.enabled` setting (default on) lets you opt out, with a matching command and keybinding (Cmd/Ctrl+Alt+B) to toggle it without opening settings.

#### Editor Theme Override

New `markdownForHumans.display.editorTheme` setting (Follow VS Code theme / Always light / Always dark) plus a toolbar toggle next to the gear icon, so the editor's color mode no longer has to follow your OS/VS Code theme.

#### Toolbar & Paste Improvements

- Copy button added to code blocks
- Toolbar active states now stay in sync with code blocks and document changes
- Pasted HTML tables are preserved more reliably
- Search box and other overlay inputs no longer have their pastes hijacked by the document paste handler

#### Production Build Hardening

Console output is now stripped from production builds, and the build verifier checks bundles for disallowed console calls.

### Fixed

- Prevented frontmatter data loss when a YAML value contained a triple-backtick fence
- Fixed floating Find widget losing/stealing focus incorrectly
- Fixed formatting-shortcut keymaps double-firing (both VS Code and the editor reacting to the same chord) when shortcuts were disabled
- Resolved npm audit findings by refreshing vulnerable transitive dependencies

### Technical Improvements

- CI now tests against Node 22.x and 24.x
- Added regression tests for code-block copy/paste, autosave, and toolbar state (900+ tests passing)

---

## [0.2.1] - 2026-05-19

### Fixed

- Fixed broken GIF images on the marketplace README page (were pointing to a deleted `integration` branch, now pinned to a stable commit SHA)

---

## [0.2.0] - 2026-05-19

### What's New

#### Drag-and-Drop Block Reordering

A six-dot handle now appears on any block, letting you drag it to a new position:

- Smooth pointer-event-based drag with a ghost element preview
- Visual drop indicator shows exactly where the block will land
- Works with all block types including Mermaid diagrams
- Regression tests added for drop position handling

#### Paragraph Spacing and Zoom Level

Two new settings give you fine control over the editor appearance:

- `markdownForHumans.paragraphSpacing` — adjust spacing between paragraphs
- `markdownForHumans.zoomLevel` — zoom editor content without OS-level zoom
- Heading-to-paragraph spacing now honors the paragraph spacing setting

#### AI Coding Tool Reference

New "Copy AI Ref" button in the formatting toolbar:

- Copies a structured context reference for the current document
- Useful for feeding document context into AI coding tools (Claude Code, Cursor, etc.)
- Enhanced handling for AI context references across the audit panel

#### Open with Markdown for Humans (Context Menu)

Right-click any editor tab to open the file in the Markdown for Humans WYSIWYG editor,
without changing it as your default editor.

#### Markdown Serialization Improvements

- Consistent blank line preservation between blocks
- Better handling of empty elements and edge cases in markdown output
- Font size resets to default normal on open (prevents stale font-size state)

### Bug Fixes

- Fixed `applyZoomLevel` function improperly closed, causing a runtime error
- Fixed heading-to-paragraph spacing not respecting the paragraph spacing setting
- Fixed blank line preservation config not restoring on editor initialization
- Fixed tab indentation regression that removed code from the extension on certain edits

### Security

- Closed path-traversal vulnerability in image rename/resize operations and PDF export
- Enhanced HTML sanitization with strict image path validation
- CI: pinned all third-party GitHub Actions to commit SHAs (supply-chain hardening)

### Technical Improvements

- Extracted `applyEditorSettings` helper for cleaner settings application
- Removed duplicate `applyZoomLevel` function
- Added tests for `ensureSingleTrailingNewline` and `isMarkdownStructurallyEquivalent`
- Configuration properties now declare proper VS Code scope
- Removed debug `console.log` statements from tab indentation code

---

## [0.1.7] - 2026-04-21

### Fixed

- Image context menu (resize, align, copy) is now accessible even when the image hover overlay is disabled via settings. Previously, turning off `markdownForHumans.imagePreview.hover.enabled` also hid the menu button, making images uneditable.

---

## [0.1.6] - 2026-04-20

### Changed

- Patch version bump to resolve a marketplace re-publish. No code changes from 0.1.5.

---

## [0.1.5] - 2026-04-20

### 🎯 What's New

#### Document Audit Tool

A new audit panel lets you check document quality without leaving the editor:

- Validates all URLs and local file links for broken references
- Auto-fix suggestions for common issues
- Toast notifications for audit results
- Enhanced overlay with issue navigation and a horizontal separator for clarity

#### Image Overlay Controls

New image overlay feature (contributed by @tomarsuraj13):

- Contextual controls appear on image hover for quick resize and alignment
- Improved image resize modal with better interaction
- Fixed nested checkbox list rendering within image captions
- Resolved VS Code keyboard shortcut conflicts introduced by image handling

#### Code Block Improvements

- Pastes inside code blocks now insert as raw text, preventing unwanted markdown parsing
- Improved code context detection using TipTap state and DOM checks
- Raw HTML source no longer auto-renders when pasted as plain text

#### HTML-Preserving Tables

- New `HtmlPreservingTable` extension maintains HTML classes when syncing tables to markdown

### 🛠️ Bug Fixes

- Fixed Mermaid theme loading (themes were not applying on open)
- Fixed audit panel horizontal scrolling
- Fixed image resize modal behavior
- Fixed CI workflows to correctly handle fork PRs in Claude AI code review

### Added

- Claude AI PR review workflow via GitHub Actions (`@claude` mention trigger)

---

## [0.1.4] - 2026-01-20

### Changed

- Updated display name to "Markdown for Humans: WYSIWYG Editor" for better brand clarity and search ranking
- Expanded keywords from 6 to 30 terms for improved marketplace discoverability
- Updated marketplace description to highlight key features for SEO

---

## [0.1.3] - 2026-01-16

### 🎯 What's New

#### Critical Bug Fix

**Fixed Auto-Linking Bug:** Previously, typing text ending with file extensions (like `.md`, `.txt`, `.pdf`) would automatically convert them into links. This has been fixed. File extensions now remain as plain text, giving you complete control over when text becomes a link.

#### Enhanced Link Creation Experience

**Completely Redesigned Link Dialog:** Creating links is now faster and more intuitive:

- **Three Link Modes**: Switch between URL, File, and Headings with radio buttons positioned right after the Link Text input
- **Smart File Search**: Type to search workspace files with fuzzy matching and category filters (Markdown, Images, Code, Config)
- **In-Document Headings**: Instantly link to any heading (H1-H6) within your current document
- **Cleaner Display**: Shows only the filename or heading name in the input field, while storing the full path correctly
- **Better Navigation**: Fixed image and file link clicking - images now open in VS Code's preview, files open correctly in both development and packaged builds

#### Documentation & Discovery

- **Enhanced README:** Added comparison table showing how Markdown for Humans differs from other markdown editors
- **Improved Marketplace Listing:** Better keywords and descriptions to help users discover the extension more easily

### 🛠️ Technical Improvements

This release includes several under-the-hood improvements that make the extension more stable and reliable:

- Enhanced test coverage for better reliability
- Improved CI/CD pipeline for faster packaging
- Code quality improvements
- Enabled pre-commit hook (previously disabled) - automatically fixes linting issues before commits
- Fixed GitHub Actions CI/CD pipeline - now properly creates VSIX packages on push to main branch
- Improved test reliability and CI stability with enhanced Jest configuration

### Fixed (Technical Details)

- Fixed auto-linking bug where file extensions (.md, .txt, .pdf, etc.) and filenames ending with document extensions were incorrectly converted to links when typing
- Fixed lint regex and formatting issues in test files (image path resolution, image rename checks, image resize, and in-memory files tests)
- Fixed Jest configuration to resolve failing tests in CI pipeline
- Fixed pre-commit hook script for Windows system compatibility
- **Image Link Navigation**: Fixed image files not opening when clicked - now properly opens in VS Code's image preview
- **File Link Navigation**: Enhanced path resolution for both development and packaged builds
- **Path Resolution**: Improved relative path handling with fallback to workspace root when document-relative path fails
- **Link Click Handling**: Fixed preventDefault() and stopPropagation() to prevent browser from interfering with link navigation

### Added

- Added shouldAutoLink validation utility to prevent unwanted auto-linking of file extensions and bare filenames
- Added comprehensive test suite for link autolink prevention (src/**tests**/webview/linkAutolink.test.ts)
- Added pre-commit hook that automatically runs npm run lint:fix before each commit
- Added enhanced test setup files (setup-after-env.ts) for improved test reliability
- Added GitHub Actions workflow for automated package creation on push to main branch
- **Enhanced Link Dialog** - Completely redesigned link creation experience with three modes:
  - **URL Mode**: Create external links to websites
  - **File Mode**: Link to local files with intelligent fuzzy search and autocomplete
  - **Headings Mode**: Link to headings within the current document (H1-H6)
- **File Search with Filters**: Search workspace files with category filters (Markdown, Images, Code, Config)
- **Smart Path Display**: Shows only filename or heading text in the input field while storing the full path internally
- **Dynamic Label**: Link input label changes based on selected mode (URL/File/Heading)
- **Visual Differentiation**: Subtle colored borders in autocomplete results to distinguish files from headings

### Changed

- Enhanced marketplace discoverability: Updated displayName to "Markdown for Humans: WYSIWYG Editor" to improve brand clarity while maintaining search ranking for "markdown editor" and "wysiwyg markdown" queries
- Expanded keywords from 6 to 30 terms for better marketplace visibility (includes: notion-like, writing, documentation, formatting, syntax-highlighting, live-preview, full-screen, distraction-free, cover-images, image-resizing, export, html, pdf, docx, human-friendly, and more)
- Updated package.json description to SEO-optimized version highlighting key features
- Restructured README with comparison table ("What Makes It Different") and improved SEO positioning
- Improved Jest test configuration with better coverage thresholds and setup files
- Updated test files to use more robust patterns and improved error handling
- **Link Dialog UX**: Radio buttons moved to appear right after Link Text input for better workflow
- **Button Alignment**: Cancel and OK buttons aligned to the right side of the dialog
- **Autocomplete UI**: Removed emojis, replaced with clean borders for a more professional appearance
- **Dropdown Sizing**: Autocomplete dropdown now dynamically adjusts height to prevent overflow in different modes

### Developer Experience

- Enabled pre-commit hook (previously disabled) - automatically fixes linting issues before commits
- Fixed GitHub Actions CI/CD pipeline - now properly creates VSIX packages on push to main branch
- Improved test reliability and CI stability with enhanced Jest configuration

---

## [0.1.0] - Initial Release

### Added

- WYSIWYG markdown editing with TipTap
- Headers (H1-H6)
- Inline formatting (bold, italic, strikethrough, code)
- Lists (ordered, unordered, task lists)
- Links and images
- Blockquotes
- Code blocks with syntax highlighting (11 languages)
- Tables with resize, context menu, and toolbar dropdown
- Mermaid diagrams with toggle view
- Compact formatting toolbar
- Theme support (light, dark, system)
- VS Code custom editor integration
- Two-way document synchronization
- Cursor position preservation
- Git integration (text-based diffs)
- Document outline sidebar with navigation, filtering, and auto-reveal
- Word count status bar with detailed statistics
- Image resize handles with modal editor and undo/redo
- PDF and Word document export functionality
- Mermaid diagram templates (15 diagram types)
- Mermaid double-click editing in modal
- Tab indentation support for lists and code blocks
- Image enter spacing and cursor styling improvements
- GitHub alerts callout support
- In-memory file support (untitled files)
- Image drag-drop reliability improvements
- Image path robustness (URL-encoded path handling)
- Source view button (opens VS Code native editor)
- Copy/paste support with HTML→Markdown conversion
- Toolbar icon refresh with Codicon-based icons

### Changed

- Enhanced undo reliability and dirty state handling
- Improved frontmatter rendering (no false dirty indicators)
- Better image handling with workspace path resolution

### Fixed

- Fixed image drag-drop bugs preventing VS Code from opening files
- Fixed frontmatter dirty state on document open
- Fixed undo stack synchronization with VS Code
- Fixed image path resolution for URL-encoded paths

---

[Unreleased]: https://github.com/concretios/markdown-for-humans/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/concretios/markdown-for-humans/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/concretios/markdown-for-humans/compare/v0.1.7...v0.2.0
[0.1.7]: https://github.com/concretios/markdown-for-humans/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/concretios/markdown-for-humans/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/concretios/markdown-for-humans/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/concretios/markdown-for-humans/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/concretios/markdown-for-humans/compare/v0.1.0...v0.1.3
[0.1.0]: https://github.com/concretios/markdown-for-humans/releases/tag/v0.1.0
