# Contributing to Markdown for Humans

Welcome! This guide will help you set up the project, understand its architecture, and start contributing.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Prerequisites](#prerequisites)
3. [Development Setup](#development-setup)
4. [Project Architecture](#project-architecture)
5. [Development Workflow](#development-workflow)
6. [Testing](#testing)
7. [Build & Package](#build--package)
8. [Code Standards](#code-standards)
9. [How to Contribute](#how-to-contribute)
10. [Getting Help](#getting-help)

---

## Quick Start

```bash
# Clone the repository
git clone https://github.com/concretios/markdown-for-humans.git
cd markdown-for-humans

# Install dependencies
npm install

# Build the extension (debug mode)
npm run build:debug

# Start watch mode (auto-rebuild on changes)
npm run watch:debug

# In VS Code: Press F5 to launch Extension Development Host
```

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | 22+ LTS | Required for build tooling |
| **npm** | 10+ | Comes with Node.js |
| **VS Code** | 1.85.0+ | Extension host for development |
| **Git** | Latest | Version control |

**Verify your setup:**
```bash
node --version   # Should be v22+
npm --version    # Should be 10+
code --version   # Should be 1.85+
```

---

## Development Setup

### 1. Clone and Install

```bash
git clone https://github.com/concretios/markdown-for-humans.git
cd markdown-for-humans
npm install
```

### 2. Build the Extension

```bash
# One-time build (debug mode)
npm run build:debug

# Or watch mode (recommended for development)
npm run watch:debug
```

### 3. Launch Extension Development Host

1. Open the project folder in VS Code
2. Press **F5** (or Run → Start Debugging)
3. A new VS Code window opens with the extension loaded
4. Open any `.md` file
5. Right-click → **"Open with Markdown for Humans"**

### 4. View Logs and Debug

- **Extension logs**: View → Output → select "Markdown for Humans"
- **Webview DevTools**: In the Extension Development Host, run command `Developer: Open Webview Developer Tools`
- **Breakpoints**: Set breakpoints in `src/` files; they work in both extension and webview code

---

## Project Architecture

### High-Level Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        VS Code Extension                         │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Extension Host (Node.js)                                   ││
│  │  - src/extension.ts (entry point)                           ││
│  │  - src/editor/MarkdownEditorProvider.ts (CustomTextEditor)  ││
│  │  - src/features/* (outline, export, etc.)                   ││
│  └──────────────────────────┬──────────────────────────────────┘│
│                             │ postMessage                        │
│  ┌──────────────────────────▼──────────────────────────────────┐│
│  │  Webview (Browser)                                          ││
│  │  - src/webview/editor.ts (TipTap editor)                    ││
│  │  - src/webview/extensions/* (custom TipTap nodes)           ││
│  │  - src/webview/editor.css (all styles)                      ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `src/extension.ts` | Extension entry point, command registration |
| `src/editor/MarkdownEditorProvider.ts` | Custom editor provider, document sync |
| `src/webview/editor.ts` | TipTap editor setup, message handling |
| `src/webview/BubbleMenuView.ts` | Toolbar UI and actions |
| `src/webview/extensions/` | Custom TipTap extensions (mermaid, images, etc.) |
| `src/webview/editor.css` | All editor styles |
| `src/features/` | VS Code features (outline, export) |

### Document Sync Flow

```
VS Code TextDocument (source of truth)
        │
        ▼ (on open/change)
MarkdownEditorProvider.ts
        │
        ▼ postMessage('update')
Webview (editor.ts)
        │
        ▼ TipTap.setContent()
        │
        ▼ (on user edit, debounced 500ms)
postMessage('edit')
        │
        ▼
MarkdownEditorProvider.applyEdit()
        │
        ▼
VS Code TextDocument updated
```

---

## Development Workflow

### Making Changes

**Extension code** (`src/extension.ts`, `src/editor/*`, `src/features/*`):
- Changes require reloading the Extension Development Host
- Press `Ctrl+Shift+F5` (Cmd+Shift+F5 on Mac) to restart

**Webview code** (`src/webview/*`):
- With `npm run watch:debug`, changes auto-compile
- Reload the webview: close and reopen the markdown file, or run command `Developer: Reload Webview`

### Adding a New Feature

1. **Toolbar button**: Edit `src/webview/BubbleMenuView.ts`
2. **Keyboard shortcut**: Add to `package.json` under `contributes.keybindings`
3. **Command**: Add to `package.json` under `contributes.commands` and register in `src/extension.ts`
4. **TipTap extension**: Create in `src/webview/extensions/` and import in `editor.ts`
5. **Configuration option**: Add to `package.json` under `contributes.configuration`

### Common Tasks

| Task | Command |
|------|---------|
| Add toolbar button | Edit `BubbleMenuView.ts` |
| Add command | `package.json` + `extension.ts` |
| Add keyboard shortcut | `package.json` keybindings |
| Add config option | `package.json` configuration |
| Style changes | `editor.css` |
| TipTap extension | `src/webview/extensions/` |

---

## Testing

### Run Tests

```bash
# Run all tests
npm test

# Watch mode (re-run on changes)
npm run test:watch

# With coverage report
npm test -- --coverage
```

### Test Structure

```
src/__tests__/
├── editor/           # Extension-side tests
├── webview/          # Webview/TipTap tests
└── fixtures/         # Test fixtures
```

### Writing Tests

We use **Jest** with **TDD approach**:

1. Write failing test first
2. Implement feature to make it pass
3. Refactor while keeping tests green

```typescript
// Example test
describe('Feature', () => {
  it('should do something', () => {
    const result = myFunction(input);
    expect(result).toBe(expected);
  });
});
```

---

## Build & Package

### Build Commands

```bash
# Development build (debug mode - sourcemaps, console logs)
npm run build:debug

# Release build (minified, no logs, verified)
npm run build:release

# Verify build integrity (checks critical features)
npm run verify-build

# Package as .vsix file (for marketplace)
npm run package:release

# Full release build + package
npm run build:release && npm run package:release
```

### Install Local Package

After packaging, install the `.vsix` file locally to test:

**Via Command Line:**
```bash
code --install-extension markdown-for-humans-0.1.0.vsix
```

**Via VS Code UI:**
1. Open **Extensions** view (left sidebar or `View → Extensions`)
2. Click the **⋮** (More Actions) button
3. Choose **"Install from VSIX…"**
4. Browse to the `.vsix` file and select it
5. Reload VS Code if prompted

### Build Verification

The `npm run verify-build` command checks that critical features weren't tree-shaken during bundling:

```
🔍 Verifying build outputs...
📦 Checking webviewJs (dist/webview.js)
   ✅ Found 6/6 features
📦 Checking extensionJs (dist/extension.js)
   ✅ Found 3/3 features
✅ Build verification PASSED
```

See [docs/BUILD.md](./docs/BUILD.md) for complete build documentation.

---

## Code Standards

### TypeScript

- **Strict mode** enabled (see `tsconfig.json`)
- **No `any`** without explicit justification
- **Meaningful names** (avoid `x`, `temp`, `data`)
- **Type all function parameters and returns**

### Formatting & Linting

**Automatic Linting:**
- Pre-commit hook automatically runs `npm run lint:fix` before each commit
- If linting fails, the commit is blocked (you'll see helpful error messages)
- To skip (not recommended): `git commit --no-verify`

**Manual Commands:**
```bash
# Fix linting issues
npm run lint:fix

# Check for linting issues
npm run lint

# Prettier runs automatically on save (VS Code)
```

### Commit Messages

Use conventional commits:
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation
- `refactor:` - Code refactoring
- `test:` - Adding tests
- `chore:` - Build/tooling changes

```bash
git commit -m "feat: add slash command support"
git commit -m "fix: resolve cursor jump after image insert"
```

### Code Comments

- ✅ Explain **WHY**, not **WHAT**
- ✅ Document non-obvious decisions
- ✅ Add JSDoc for public functions
- ❌ Don't state the obvious

---

## How to Contribute

### 🐛 Report Bugs

1. Check [existing issues](https://github.com/concretios/markdown-for-humans/issues)
2. Check [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) to see if it's a known issue
3. **Record a screen video** using [Loom.com](https://www.loom.com) or similar tool showing the bug
4. Create a new issue with:
   - Clear title and description
   - **Screen recording link (required)** - Makes it much easier to visualize and reproduce issues
   - Steps to reproduce
   - Expected vs actual behavior
   - VS Code version and OS
   - Screenshots (optional, to supplement the video)

### 💡 Suggest Features

1. Check existing feature requests
2. Open a [GitHub Discussion](https://github.com/concretios/markdown-for-humans/discussions)
3. Describe the problem it solves
4. Provide examples/mockups if possible

### 📋 Planning Workflow

We use a **planning-first approach** where features are planned before implementation. 

**📝 Start with the template:** Use [`roadmap/task-plan-template.md`](./roadmap/task-plan-template.md) as your starting point. It provides a structured format with hints for each section.

**Creating Plans:**

1. **Use the template**: 
   - Prompt your AI tool: "Create a task plan using `roadmap/task-plan-template.md` for [feature name]"
   - Or copy the template and fill it in manually
   - The template includes placeholders and hints to guide you

2. **If your tool has a plan feature** (like Cursor):
   - Use it — plans are typically created in tool-specific locations (e.g., `.cursor/plans/`)
   - Move to pipeline when ready: `git mv [source]/[name].md roadmap/pipeline/[name].md`

3. **If your tool doesn't have a plan mode:**
   - Just **prompt the AI to create a markdown file** based on the template in `roadmap/pipeline/[name].md`
   - Or create markdown files manually using the template as a guide

4. **Best practice**: Create plans directly in `roadmap/pipeline/` to keep everything organized

**Plan Lifecycle:**
- **Draft** → Create plan using the template (tool-specific location or `roadmap/pipeline/`)
- **Ready** → Move to `roadmap/pipeline/` when locked and ready for implementation
- **Complete** → Move to `roadmap/shipped/` when feature is done and tests pass

See [roadmap/README.md](./roadmap/README.md) for detailed planning workflow.

### 🔧 Submit Code

1. **Fork** the repository
2. **Create a branch**: `git checkout -b feature/my-feature`
3. **Plan first** (recommended): Create a plan using [`roadmap/task-plan-template.md`](./roadmap/task-plan-template.md) in `roadmap/pipeline/` or your tool's plan location
4. **Write tests** for your changes
5. **Make changes** following code standards
6. **Run tests**: `npm test`
7. **Run linter**: `npm run lint:fix`
8. **Commit**: `git commit -m 'feat: add my feature'`
9. **Push**: `git push origin feature/my-feature`
10. **Open a Pull Request** (include plan file if helpful for context)

### Pull Request Checklist

- [ ] Tests added/updated and passing
- [ ] Linting passes (`npm run lint`)
- [ ] Build succeeds (`npm run build:release`)
- [ ] Documentation updated if needed
- [ ] Commit messages follow conventions
- [ ] PR description explains changes
- [ ] **Screen recording included** (for UI changes, bug fixes, or new features):
  - Before state (if fixing a bug)
  - After state (showing the fix/feature working)
  - Upload to [Loom.com](https://www.loom.com) or similar and paste link in PR

---

## Getting Help

- **GitHub Discussions**: [Ask questions](https://github.com/concretios/markdown-for-humans/discussions)
- **Issue Tracker**: [Report bugs](https://github.com/concretios/markdown-for-humans/issues)
- **Email**: support@concret.io

### Useful Resources

- [VS Code Extension API](https://code.visualstudio.com/api)
- [TipTap Documentation](https://tiptap.dev/docs)
- [ProseMirror Guide](https://prosemirror.net/docs/guide/)

---

## Code of Conduct

Be respectful, inclusive, and professional. We're building a welcoming community for all contributors.

---

**Thank you for contributing!** 🎉
