# Markdown for Humans - Technical Architecture

**Complete technical documentation: architecture, implementation, and key technical decisions**

> This document provides comprehensive technical context for developers working on or understanding the extension.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Technology Stack](#technology-stack)
3. [Project Structure](#project-structure)
4. [Core Components](#core-components)
5. [Document Synchronization](#document-synchronization)
6. [WebView Implementation](#webview-implementation)
7. [Feature Implementation](#feature-implementation)
8. [Performance Optimizations](#performance-optimizations)
9. [Current Implementation Status](#current-implementation-status)
10. [Key Technical Decisions](#key-technical-decisions)
11. [Security Considerations](#security-considerations)
12. [Testing Strategy](#testing-strategy)
13. [Build & Deployment](#build--deployment)

---

## Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐  │
│  │         MarkdownEditorProvider                      │  │
│  │  (CustomTextEditorProvider Implementation)          │  │
│  │                                                      │  │
│  │  • Registers custom editor for .md files           │  │
│  │  • Manages webview lifecycle                        │  │
│  │  • Handles two-way document sync                    │  │
│  └──────────────┬──────────────────────┬───────────────┘  │
│                 │                      │                    │
│                 ↓                      ↓                    │
│     ┌──────────────────┐    ┌─────────────────┐          │
│     │  TextDocument    │    │  Webview Panel  │          │
│     │  (Markdown text) │    │  (Visual editor)│          │
│     └──────────────────┘    └────────┬────────┘          │
│                                      │                     │
└──────────────────────────────────────┼─────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │         WebView Context             │
                    │                                     │
                    │  ┌──────────────────────────────┐  │
                    │  │    TipTap Editor             │  │
                    │  │  (ProseMirror-based)         │  │
                    │  │                              │  │
                    │  │  Extensions:                 │  │
                    │  │  • StarterKit (formatting)   │  │
                    │  │  • Markdown (serialization)  │  │
                    │  │  • Tables (advanced editing) │  │
                    │  │  • Mermaid (diagrams)        │  │
                    │  │  • Code highlighting         │  │
                    │  └──────────────────────────────┘  │
                    │                                     │
                    │  ┌──────────────────────────────┐  │
                    │  │    BubbleMenuView            │  │
                    │  │  (Compact formatting toolbar) │  │
                    │  └──────────────────────────────┘  │
                    └─────────────────────────────────────┘
```

### Communication Flow

```
User Types in Editor
        ↓
TipTap onChange event (debounced 500ms)
        ↓
Convert to markdown text
        ↓
postMessage to Extension
        ↓
Extension applies edit to TextDocument
        ↓
VS Code saves, updates undo stack
```

```
External File Change (Git, other editor)
        ↓
VS Code TextDocument updates
        ↓
onDidChangeTextDocument event
        ↓
Extension sends new content to webview
        ↓
WebView updates TipTap editor
        ↓
Cursor position restored
```

---

## Technology Stack

### Extension Side (Node.js)

**Core Framework:**
- **VS Code Extension API** v1.85.0+ - Official extension development API
- **TypeScript** 5.3 - Type-safe development with strict mode
- **Node.js** 20+ - Extension host runtime

**Build Tools:**
- **esbuild** - Ultra-fast bundler (extension bundle)
- **ESLint** + **Prettier** - Code quality and formatting
- **Jest** 29.x - Testing framework
- **concurrently** - Run watch tasks in parallel

### WebView Side (Browser)

**Editor Framework:**
- **TipTap** 2.1.13 - Modern ProseMirror-based WYSIWYG editor
- **ProseMirror** - Underlying editor state management (via TipTap)
- **@tiptap/markdown** ^3.0.0 - Official bidirectional markdown conversion (replaced unmaintained tiptap-markdown)

**Rendering Libraries:**
- **highlight.js** 11.11 - Syntax highlighting for code blocks
- **lowlight** 2.9 - highlight.js integration for TipTap
- **Mermaid** 10.6 - Diagram rendering
- **KaTeX** 0.16 - Math typesetting (configured, not yet active)
- **markdown-it** 14.0 - Fallback markdown parser

**Bundle Size:**
- **webview.js**: ~4.3MB (includes all dependencies)
- **extension.js**: ~1.8MB (includes Node.js dependencies)
- **webview.css**: ~67KB (all styles)

---

## Project Structure

### Directory Layout

```
md-human/
├── src/
│   ├── extension.ts                    # Extension entry point (53 lines)
│   │
│   ├── editor/
│   │   └── MarkdownEditorProvider.ts   # Custom editor provider (160 lines)
│   │       • registerCustomEditorProvider
│   │       • resolveCustomTextEditor
│   │       • HTML generation
│   │       • Message handling
│   │
│   └── webview/
│       ├── editor.ts                   # TipTap setup (412 lines)
│       │   • Editor initialization
│       │   • Extension configuration
│       │   • Message handling
│       │   • Document sync logic
│       │
│       ├── BubbleMenuView.ts           # Toolbar implementation (367 lines)
│       │   • Compact formatting toolbar
│       │   • Formatting buttons
│       │   • Dropdowns (headings, tables, code)
│       │   • Context menus
│       │
│       ├── extensions/
│       │   └── mermaid.ts              # Custom Mermaid node (105 lines)
│       │       • Diagram rendering
│       │       • Toggle code/preview
│       │       • Error handling
│       │
│       ├── editor.css                  # All styles (851 lines)
│       │   • Typography
│       │   • Theme support
│       │   • Component styles
│       │
│       └── tsconfig.json               # WebView-specific config
│
├── dist/                               # Build output
│   ├── extension.js                    # Bundled extension (~1.8MB)
│   ├── webview.js                      # Bundled webview (~4.3MB)
│   └── webview.css                     # Copied CSS (~67KB)
│
├── docs/                               # Documentation
│   ├── ARCHITECTURE.md                 # This file - technical implementation
│   └── DEVELOPMENT.md                  # Roadmap, design principles, philosophy
│
├── README.md                           # User-facing documentation
├── CONTRIBUTING.md                     # Contributing guidelines
│
├── package.json                        # Extension manifest + dependencies
├── tsconfig.json                       # TypeScript config (extension)
├── .eslintrc.js                        # ESLint configuration
├── .prettierrc                         # Prettier configuration
└── .gitignore
```

**Code Statistics:**
- **Total TypeScript/CSS**: 1,948 lines in src/
- **Extension code**: 213 lines (extension.ts + MarkdownEditorProvider.ts)
- **WebView code**: 884 lines (editor.ts + BubbleMenuView.ts + mermaid.ts)
- **CSS**: 851 lines (editor.css)

---

## Core Components

### 1. Extension Entry Point (`extension.ts`)

**Purpose**: Activate extension and register custom editor provider

**Key Functions:**

```typescript
export function activate(context: vscode.ExtensionContext) {
  // Register custom text editor provider
  const provider = MarkdownEditorProvider.register(context);
  context.subscriptions.push(provider);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.openFile', ...)
  );
}
```

**Registration:**
- Activates on `onCustomEditor:markdownForHumans.editor` event
- Registers for `.md` and `.markdown` files
- Priority: `"option"` (user can choose this editor via right-click)

---

### 2. Custom Editor Provider (`MarkdownEditorProvider.ts`)

**Purpose**: Implement VS Code's CustomTextEditorProvider interface

**Why CustomTextEditorProvider?**
- VS Code offers two custom editor types:
  - `CustomEditorProvider` - For binary formats (images, PDFs)
  - `CustomTextEditorProvider` ✅ - For text formats (markdown)
- Benefits:
  - VS Code handles save/undo/redo automatically
  - TextDocument is source of truth
  - Simpler implementation
  - Better integration (Git, diff, etc.)

**Key Responsibilities:**

```typescript
class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {

    // 1. Configure webview
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    // 2. Generate HTML with CSP headers, nonce injection
    webviewPanel.webview.html = this.getWebviewContent(webviewPanel.webview, document);

    // 3. Listen for external document changes
    const changeSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString()) {
        this.updateWebview(document, webviewPanel.webview);
      }
    });

    // 4. Listen for webview messages (user edits and startup handshake)
    webviewPanel.webview.onDidReceiveMessage(message => {
      switch (message.type) {
        case 'edit':
          this.handleEdit(document, message.content);
          break;
        case 'save':
          document.save();
          break;
        case 'ready':
          // Retry after the webview listener exists, even if the optimistic
          // startup post already populated the content-deduplication cache.
          this.updateWebview(document, webviewPanel.webview, true);
          break;
      }
    });

    // 5. Optimistically send initial content. The ready handshake retries it
    // after the webview installs its listener.
    this.updateWebview(document, webviewPanel.webview);

    // Cleanup
    webviewPanel.onDidDispose(() => changeSubscription.dispose());
  }
}
```

**Message Types:**
- `edit` - User changed content, update TextDocument
- `save` - User pressed Cmd/Ctrl+S, trigger VS Code save
- `ready` - WebView listener initialized, force delivery of initial content

---

### 3. TipTap Editor (`webview/editor.ts`)

**Purpose**: Initialize and manage WYSIWYG editor in webview

**Editor Configuration:**

```typescript
const editor = new Editor({
  element: document.querySelector('#editor'),

  extensions: [
    StarterKit,              // Core formatting (bold, italic, headings, lists, etc.)
    CodeBlockLowlight,       // Syntax highlighting
    Markdown,                // Markdown serialization
    Table, TableRow, TableCell, TableHeader,  // Tables
    TaskList, TaskItem,      // Checkboxes
    Link,                    // Hyperlinks
    Image,                   // Images
    MermaidExtension         // Custom Mermaid diagrams
  ],

  content: '',  // Set from VS Code

  onUpdate: ({ editor }) => {
    // Convert to markdown and send to extension (debounced)
    const markdown = editor.storage.markdown.getMarkdown();
    debouncedSendUpdate(markdown);
  }
});
```

**Debouncing Strategy:**
- User edits trigger `onUpdate` immediately
- Updates are debounced (500ms) before sending to extension
- Prevents excessive sync overhead
- Last edit timestamp tracked to skip stale updates

**Cursor Preservation:**
- Before content update, save cursor position (`editor.state.selection`)
- After content update, restore cursor position
- Critical for smooth UX (prevents jarring cursor jumps)

**Keyboard Shortcuts:**
- `Cmd/Ctrl+S` - Immediate save (bypasses debounce)
- `Cmd/Ctrl+B, I, U` - Standard formatting
- `Cmd/Ctrl+K Cmd/Ctrl+L` - Insert link

---

### 4. Formatting Toolbar (`webview/BubbleMenuView.ts`)

**Purpose**: Compact formatting toolbar for markdown editing

**Design:**
- Sticky positioning at top of editor
- Compact button layout with separators
- Dropdowns for advanced options (H4-H6, tables, code languages)
- Active state tracking (bold/italic/etc. reflect current selection)

**Button Groups:**

1. **Basic Formatting**: Bold, Italic, Strike, Code
2. **Headings**: H1, H2, H3 buttons + dropdown for H4-H6
3. **Lists**: Bullet list, Ordered list, Task list
4. **Advanced**: Link, Table dropdown, Code block dropdown
5. **Special**: Mermaid diagram, Settings (theme)

**Table Context Menu:**
- Right-click on table cells shows floating menu
- Operations: Add/delete rows, add/delete columns, delete table
- Positioned at cursor location

**Implementation:**
- Pure JavaScript (no framework)
- Manual DOM creation and event binding
- Active state sync via TipTap's transaction updates

---

## Document Synchronization

### The Synchronization Challenge

**Problem:** Two sources of truth must stay in sync:
1. **VS Code TextDocument** - Markdown text (authoritative)
2. **TipTap Editor** - Visual representation

**Challenges:**
- **Feedback loops** - Update from extension triggers webview update, which triggers extension update...
- **Cursor preservation** - User's cursor must not jump during updates
- **Performance** - Excessive updates degrade UX
- **External changes** - Git pull, other editors, etc.

### Synchronization Strategy

#### TextDocument → WebView (External Changes)

```
Git pull / Other editor modifies file
        ↓
VS Code TextDocument changes
        ↓
onDidChangeTextDocument event fires
        ↓
Extension: Check if content actually changed
        ↓
Extension: postMessage({ type: 'update', content: markdown })
        ↓
WebView: Receive message
        ↓
WebView: Check if user edited recently (last 2 seconds)
        ↓
WebView: If not, update editor content
        ↓
WebView: Restore cursor position
```

**Safeguards:**
- Skip update if content hasn't changed (string comparison)
- Skip update if user edited within last 2 seconds (avoid interrupting typing)
- Save and restore cursor position

#### WebView → TextDocument (User Edits)

```
User types in TipTap editor
        ↓
TipTap onUpdate event fires
        ↓
Convert editor state to markdown
        ↓
Debounce (500ms) - wait for typing to pause
        ↓
postMessage({ type: 'edit', content: markdown })
        ↓
Extension receives message
        ↓
Extension: Set ignoreNextUpdate flag (prevent feedback loop)
        ↓
Extension: Apply WorkspaceEdit to TextDocument
        ↓
Extension: VS Code handles save, undo, etc.
```

**Safeguards:**
- 500ms debounce to batch rapid edits
- `ignoreNextUpdate` flag prevents feedback loop
- `lastEditTimestamp` tracks recent user activity

### Implementation Details

**Extension Side (Applying Edits):**

```typescript
private handleEdit(document: vscode.TextDocument, markdown: string) {
  const edit = new vscode.WorkspaceEdit();

  // Replace entire document content
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );

  edit.replace(document.uri, fullRange, markdown);

  // Set flag to ignore the resulting change event
  this.ignoreNextUpdate = true;

  vscode.workspace.applyEdit(edit);
}
```

**WebView Side (Receiving Updates):**

```typescript
window.addEventListener('message', event => {
  const message = event.data;

  if (message.type === 'update') {
    // Skip if user edited recently
    if (Date.now() - lastEditTimestamp < 2000) {
      return;
    }

    // Skip if content unchanged
    const currentMarkdown = editor.storage.markdown.getMarkdown();
    if (currentMarkdown === message.content) {
      return;
    }

    // Save cursor position
    const selection = editor.state.selection;

    // Update content
    editor.commands.setContent(message.content);

    // Restore cursor (best effort)
    try {
      editor.commands.setTextSelection(selection);
    } catch (e) {
      // Cursor position invalid, ignore
    }
  }
});
```

---

## WebView Implementation

### HTML Structure

**Template:**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="...">
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div id="editor"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>
```

**Security:**
- Content Security Policy (CSP) restricts resource loading
- Nonce-based script injection prevents XSS
- Local resource roots restrict file access

---

## Feature Implementation

### 1. Tables

**Implementation:**
- Uses TipTap's `@tiptap/extension-table` suite
- Custom CSS for clean, professional appearance
- JavaScript for context menu and column resizing

**Features:**
- Tab navigation between cells
- Drag column borders to resize
- Right-click context menu
- Toolbar dropdown for operations
- Cell merging (not yet implemented)
- Alignment controls (not yet implemented)

### 2. Code Blocks with Syntax Highlighting

**Implementation:**
- `@tiptap/extension-code-block-lowlight`
- `highlight.js` via `lowlight` wrapper
- 11+ languages configured

**Supported Languages:**
javascript, typescript, python, bash, json, markdown, css, html, xml, sql, java, go, rust

**Features:**
- ✅ Syntax highlighting
- ✅ Language selection dropdown
- ❌ Line numbers (not yet implemented)
- ❌ Copy button (not yet implemented)

### 3. Mermaid Diagrams

**Implementation:**
- Custom TipTap node (`extensions/mermaid.ts`)
- Detects ```mermaid code blocks
- Renders using Mermaid library

**Features:**
- ✅ Flowcharts, sequence diagrams, class diagrams, etc.
- ✅ Toggle between code and rendered view
- ✅ Error handling with user-friendly messages
- ❌ Interactive editing UI (not yet implemented)

### 4. Math Support (KaTeX)

**Status:** ⚠️ Configured but not fully integrated

**What's Done:**
- KaTeX library included in dependencies
- Package.json config for enabling/disabling

**What's Missing:**
- TipTap extension for inline math (`$...$`)
- TipTap extension for display math (`$$...$$`)
- Toolbar buttons for inserting equations

**Planned Implementation:**
- Custom TipTap node for math blocks
- Parse `$` and `$$` delimiters
- Render with KaTeX in read mode
- Show LaTeX source in edit mode

### 5. Task Lists

**Implementation:**
- `@tiptap/extension-task-list` and `task-item`
- Supports nesting

**Features:**
- ✅ Checkboxes render correctly
- ✅ Click to toggle checked state
- ✅ Nesting supported

### 6. Links and Images

**Links:**
- `@tiptap/extension-link`
- Ctrl/Cmd+K to insert link
- Clickable links in editor

**Images:**
- `CustomImage` (extends `@tiptap/extension-image`)
- Supports local, remote, and workspace images
- Drag-and-drop from desktop and VS Code explorer
- Paste from clipboard
- Relative paths saved in markdown; webview URIs resolved via extension
- ❌ Resize handles (not yet implemented)

---

## Performance Optimizations

### 1. Debounced Updates (500ms)

**Problem:** User types → TipTap fires onChange → Send to extension → Apply edit → Repeat
- This happens on EVERY keystroke
- Causes lag and excessive processing

**Solution:**
```typescript
let updateTimeout: number | null = null;

function debouncedUpdate(markdown: string) {
  if (updateTimeout) {
    clearTimeout(updateTimeout);
  }

  updateTimeout = window.setTimeout(() => {
    // Skip sync while images are being saved to avoid race condition
    if (hasPendingImageSaves()) {
      debouncedUpdate(markdown);
      return;
    }

    vscode.postMessage({ type: 'edit', content: markdown });
  }, 500);
}

editor.on('update', ({ editor }) => {
  const markdown = editor.storage.markdown.getMarkdown();
  debouncedUpdate(markdown);
});
```

**Result:**
 Updates batched, sent only after 500ms of inactivity

### 2. Skip Redundant Updates

**Problem:** Extension sends update to webview, but content is identical

**Solution:**
```typescript
const currentMarkdown = editor.storage.markdown.getMarkdown();
if (currentMarkdown === message.content) {
  return; // Skip update
}
```

### 3. Respect User Editing State

**Problem:** External update arrives while user is typing, interrupts flow

**Solution:**
```typescript
if (Date.now() - lastEditTimestamp < 2000) {
  return; // Skip update if user edited recently
}
```

### 4. Large Document Handling (Future)

**Planned Optimizations:**
- **Virtual scrolling** - Only render visible paragraphs
- **Lazy image loading** - Load images on scroll
- **Web Workers** - Parse markdown in background thread
- **Code splitting** - Load extensions on demand (Math, Mermaid)

**Current Status:** ⚠️ Not yet implemented

---

## Current Implementation Status

### ✅ Fully Implemented (MVP Complete)

**Core Editing:**
- WYSIWYG markdown editing
- Headers (H1-H6)
- Bold, italic, strikethrough, inline code
- Unordered, ordered, and task lists
- Links and images
- Blockquotes
- Horizontal rules
- Code blocks with syntax highlighting (11 languages)

**Advanced Features:**
- Tables with resize, context menu, toolbar dropdown
- Mermaid diagrams with toggle view, template dropdown, double-click editing
- Compact formatting toolbar
- Theme support (light, dark, system)
- Document outline sidebar with navigation
- Image resize handles with modal editor
- PDF/HTML export functionality
- Source view button (opens VS Code native editor)

**VS Code Integration:**
- Custom text editor registration
- Command palette commands
- Keyboard shortcuts
- Context menu (right-click .md files)
- Save functionality with visual feedback
- Document outline view in Explorer sidebar
- Word count status bar with detailed stats
- In-memory file support (untitled files)
- Git integration (text-based diffs work correctly)

**Synchronization:**
- Two-way sync (TextDocument ↔ WebView)
- Cursor position preservation
- Debounced updates (500ms)
- Feedback loop prevention

### ⚠️ Partially Implemented

**Math Support:**
- KaTeX library included
- Configuration options defined
- ❌ No TipTap extension for rendering math yet
- ❌ No toolbar buttons for inserting equations

**Settings System:**
- Configuration schema defined in package.json
- ❌ Not wired up to webview yet
- ❌ No UI for changing settings in editor

### ❌ Not Yet Implemented

**Missing Features:**
- Source view toggle with scroll sync (basic source view button exists)
- Math equation editing UI (KaTeX library included but not integrated)
- Frontmatter editor UI (frontmatter rendering exists)
- Find and replace (VS Code find widget enabled but may need enhancement)
- Spell check integration
- Code block execution

**Missing Optimizations:**
- Virtual scrolling for large docs
- Lazy image loading
- Web Workers for parsing
- Code splitting

**Missing Tests:**
- Unit tests (Jest configured, but no test files)
- Integration tests
- E2E tests

---

## Key Technical Decisions

### 1. Why CustomTextEditorProvider (Not CustomEditorProvider)?

**Decision:** Use `CustomTextEditorProvider` instead of `CustomEditorProvider`

**Reasoning:**
- Markdown is text-based (not binary)
- VS Code handles save/undo/redo automatically
- TextDocument is source of truth (simple mental model)
- Better Git integration (diffs work correctly)
- Simpler implementation (less code)

**Trade-off:** Less control over save behavior (acceptable for our use case)

---

### 2. Why TipTap (Not ProseMirror Directly)?

**Decision:** Use TipTap instead of raw ProseMirror

**Reasoning:**
- **Easier API** - TipTap abstracts ProseMirror's complexity
- **Extension ecosystem** - Many plugins available (tables, markdown, etc.)
- **Markdown support** - `@tiptap/markdown` handles serialization
- **Active development** - Regular updates, good documentation
- **Used in production** - Battle-tested by many apps

**Trade-off:** Slightly larger bundle size (acceptable given ~4.3MB is mostly highlight.js + Mermaid)

---

### 3. Why 500ms Debounce (Not 300ms or 1s)?

**Decision:** Debounce updates by 500ms

**Reasoning:**
- **300ms** - Too aggressive, still many updates during normal typing
- **500ms** - Good balance, users typically pause for punctuation/thinking
- **1000ms** - Too slow, feels laggy on slower machines

**Trade-off:** 500ms delay before external changes appear (acceptable, users rarely notice)

---

### 4. Why Full Document Replacement (Not Incremental Diffs)?

**Decision:** Replace entire document content on sync, not incremental diffs

**Reasoning:**
- **Simplicity** - Much easier to implement and debug
- **Reliability** - No complex diff logic that could have bugs
- **Performance** - Most markdown docs are <1MB, full replacement is fast
- **VS Code optimization** - VS Code's TextDocument handles diffs internally

**Trade-off:** Potential performance hit on huge docs (10,000+ lines), but acceptable for MVP

**Future Optimization:** Could implement incremental diffs for large documents if needed

---

### 5. Why esbuild (Not Webpack)?

**Decision:** Use esbuild for bundling

**Reasoning:**
- **Speed** - 10-100x faster than Webpack
- **Simplicity** - Minimal configuration
- **Modern** - Handles TypeScript natively
- **Growing ecosystem** - Increasingly popular for VS Code extensions

**Trade-off:** Less mature plugin ecosystem than Webpack (acceptable, we don't need complex plugins)

---

### 6. Why Embed All Dependencies (Not CDN)?

**Decision:** Bundle all dependencies in webview.js (~4.3MB)

**Reasoning:**
- **Offline support** - Works without internet
- **Security** - No external resource loading (CSP restrictions)
- **Reliability** - No CDN downtime issues
- **Simplicity** - No asset management complexity

**Trade-off:** Large bundle size (~4.3MB), but one-time download and cached by VS Code

**Future Optimization:** Could implement code splitting for Mermaid/Math if needed

---

### 7. Why Inherit VS Code Fonts (Not Hardcoded Fonts)?

**Decision:** Inherit VS Code's editor font settings instead of hardcoding font families

**Reasoning:**
- **User preferences** - Respects user's VS Code font configuration
- **OS optimization** - VS Code picks fonts optimized for each operating system
- **Accessibility** - Respects system font size and accessibility settings
- **Theme consistency** - Fonts adapt to light/dark/high-contrast themes automatically
- **Simplicity** - Less code to maintain, fewer font-related issues

**What We Keep:**
- **Readability optimizations** - Line-height (1.58), letter-spacing (-0.003em), font-smoothing, text-rendering
- **Size multipliers** - Paragraphs 20% larger, header hierarchy (2.4x, 2x, 1.6x, etc.)
- **Code blocks** - Monospace fonts (ensures code is always readable)

**Trade-off:** Less control over exact font choice, but better user experience and platform integration

See [DEVELOPMENT.md](./DEVELOPMENT.md) for full design principles

---

## Security Considerations

### Content Security Policy

**CSP Headers:**

```typescript
const csp = `
  default-src 'none';
  script-src ${webview.cspSource} 'nonce-${nonce}';
  style-src ${webview.cspSource} 'unsafe-inline';
  font-src ${webview.cspSource};
  img-src ${webview.cspSource} https: data:;
`;
```

**What This Prevents:**
- ❌ Loading scripts from external URLs
- ❌ Inline scripts without nonce (prevents XSS)
- ❌ Arbitrary resource loading

**What This Allows:**
- ✅ Scripts from extension (with nonce)
- ✅ Styles from extension
- ✅ Images (local, HTTPS, data URIs)
- ✅ Fonts from extension

### User Content Sanitization

**Current Approach:**
- Markdown-it has built-in HTML sanitization
- Links are validated (basic URL parsing)
- Images are validated (URL or local path)

**Potential Risks:**
- User markdown could contain `<script>` tags
- Malicious links could be `javascript:` URLs

**Mitigation:**
- VS Code webview is sandboxed (separate context)
- CSP prevents inline scripts from executing
- Link validation prevents `javascript:` URLs

---

## Testing Strategy

### Current Status: ⚠️ Minimal Testing

**Configured:**
- Jest 29.x installed
- `test` script in package.json

**Missing:**
- No test files written yet
- No test coverage

### Planned Testing Approach

#### Unit Tests (Jest)
**What to test:**
- Markdown parsing/serialization
- Document sync logic (debounce, cursor preservation)
- Utility functions

**Example:**
```typescript
describe('Document Sync', () => {
  it('should debounce rapid updates', async () => {
    // Test debounce logic
  });

  it('should skip redundant updates', () => {
    // Test update skipping
  });
});
```

#### Integration Tests
**What to test:**
- Extension activation
- Custom editor registration
- WebView communication (message passing)

#### E2E Tests (VS Code Extension Test Runner)
**What to test:**
- Full editing workflow (type, save, reload)
- Multi-file scenarios
- Git integration (commit, diff)

#### Manual Testing Checklist
- Large documents (10,000+ lines)
- Math rendering accuracy
- Table editing UX (drag, context menu)
- Image loading (local, remote, relative paths)
- Source ↔ WYSIWYG switching
- Theme switching
- Keyboard shortcuts

---

## Build & Deployment

### Development Workflow

```bash
# Install dependencies
npm install

# Start watch mode (extension + webview)
npm run watch

# In VS Code: Press F5 to launch Extension Development Host

# Run tests
npm test

# Lint code
npm run lint
npm run lint:fix
```

### Build Process

**Extension Bundle:**
```bash
npm run build:extension
# → esbuild src/extension.ts → dist/extension.js (~1.8MB)
```

**WebView Bundle:**
```bash
npm run build:webview
# → esbuild src/webview/editor.ts → dist/webview.js (~4.3MB)
# → cp src/webview/editor.css → dist/webview.css (~67KB)
```

**Production Build:**
```bash
npm run build
# → Runs both build:extension and build:webview
# → Minifies, tree-shakes, generates source maps
```

### Packaging for Marketplace

This is the canonical way to build the `.vsix` file that you can either share with other developers on the team or publish to the VS Code Marketplace.

```bash
# Create .vsix file (for local install or marketplace upload)
npm run package
# → Uses vsce (VS Code Extension CLI)
# → Outputs markdown-for-humans-0.1.0.vsix in the project root

# Publish to marketplace (requires publisher account)
vsce publish patch  # Auto-bumps version and publishes
```

### Build Configuration

**esbuild settings:**
- **Extension:**
  - Format: CommonJS (required by VS Code)
  - Platform: Node
  - External: `vscode` module (provided by VS Code)
  - Minify, tree-shake, source maps

- **WebView:**
  - Format: IIFE (self-contained browser bundle)
  - Platform: Browser
  - Bundle all dependencies
  - Minify, tree-shake, source maps

---

## Future Architecture Considerations

### Planned Improvements

#### 1. Virtual Scrolling (Phase 2)
**Problem:** Large documents (10,000+ lines) slow down editor
**Solution:** Only render visible content, lazy-load off-screen content

#### 2. Code Splitting (Phase 2)
**Problem:** ~4.3MB initial bundle is large
**Solution:** Split Mermaid, Math into separate bundles, load on demand

#### 3. Web Workers (Phase 3)
**Problem:** Markdown parsing blocks main thread
**Solution:** Parse markdown in background thread

#### 4. Collaborative Editing (Phase 4)
**Problem:** No real-time collaboration
**Solution:** Integrate VS Code Live Share API + Operational Transform (OT)

#### 5. Plugin System (Phase 4)
**Problem:** Limited extensibility
**Solution:** API for community extensions (custom nodes, themes)

---

## Quick Reference

### Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/extension.ts` | 53 | Extension activation, command registration |
| `src/editor/MarkdownEditorProvider.ts` | 160 | Custom editor provider, document sync |
| `src/webview/editor.ts` | 412 | TipTap setup, editor initialization |
| `src/webview/BubbleMenuView.ts` | 367 | Compact formatting toolbar |
| `src/webview/extensions/mermaid.ts` | 105 | Mermaid diagram rendering |
| `src/webview/editor.css` | 851 | All styles |

### Important Constants

| Constant | Value | Reasoning |
|----------|-------|-----------|
| Debounce delay | 500ms | Balance responsiveness vs. performance |
| Recent edit threshold | 2000ms | Skip external updates if user typed recently |
| Max content width | 80% (max 1400px) | Optimal reading line length |
| Body font size | 18-21px | Comfortable long-form reading |
| Line height | 1.58-1.6 | Breathing room for text |

### Dependencies Overview

| Dependency | Size | Purpose |
|------------|------|---------|
| TipTap + ProseMirror | ~500KB | Core editor framework |
| highlight.js | ~3MB | Syntax highlighting (11 languages) |
| Mermaid | ~4MB | Diagram rendering |
| KaTeX | ~1MB | Math typesetting (not yet active) |
| markdown-it | ~500KB | Markdown parsing (fallback) |
| Other | ~500KB | Utilities, polyfills |

---

## Related Documentation

- **[DEVELOPMENT.md](./DEVELOPMENT.md)** - Roadmap, design principles, philosophy
- **[README.md](../README.md)** - User-facing documentation
- **[CONTRIBUTING.md](../CONTRIBUTING.md)** - How to contribute

---

**Last Updated**: December 26, 2025
**Document Version**: 2.0 (Consolidated from technical-architecture.md + codebase analysis)
