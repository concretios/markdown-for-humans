# Markdown for Humans: WYSIWYG Editor

**Seamless WYSIWYG markdown editing for VS Code** — Write markdown the way humans think.

![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/concretio.markdown-for-humans?label=VS%20Code%20Marketplace&logo=visual-studio-code) ![Open VSX](https://img.shields.io/open-vsx/v/concretio/markdown-for-humans?label=Open%20VSX&logo=eclipse) ![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg) ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

---

## 🚀 See It In Action

> We also support standard shortcuts like `CTRL/CMD + B`, etc

![Markdown for Humans Overview](https://raw.githubusercontent.com/concretios/markdown-for-humans/4bf7defb6a3e7ee56b34e6dd9dc0a55e471740ec/marketplace-assets/gifs/basic_overview_of_features.gif)

*Experience seamless WYSIWYG markdown editing with visual table editing, image management, and more—all in VS Code.*

---

## Stop Fighting Markdown Syntax

**Tired of manually writing table syntax? Struggling with image paths, resizing, renaming? Or you dont like memorising Markdown Syntax.** 

Most markdown editors force you to memorize syntax, fight with split panes, or manually manage files. **Markdown for Humans solves the biggest pain points** that make markdown editing frustrating.

> **📌 100% free. No trials. No limits. No paywalls, ever.**

---

## Visual Table Editing (No More Syntax)

As natural as it gets in Microsoft Word or Google Docs etc. 

![Table Editing](https://raw.githubusercontent.com/concretios/markdown-for-humans/4bf7defb6a3e7ee56b34e6dd9dc0a55e471740ec/marketplace-assets/gifs/table_operations_with_right_click_menu.gif)

**Drag column borders to resize. Right-click to add rows. No syntax to memorize.**

- ✅ **Drag-to-resize columns** — Click and drag column borders, just like Excel
- ✅ **Right-click context menu** — Insert/delete rows and columns instantly
- ✅ **Toolbar controls** — Add/remove rows and columns with dropdown menus
- ✅ **Tab navigation** — Move between cells with Tab/Shift+Tab

*Stop counting pipes and dashes. Start editing tables visually.*

---

## Image Management That Actually Works

> Press shift while dragging images, in case your face issues on drag drop in editor

![Large Size Image Suggestion](https://raw.githubusercontent.com/concretios/markdown-for-humans/4bf7defb6a3e7ee56b34e6dd9dc0a55e471740ec/marketplace-assets/gifs/large_size_image_size_suggestion.gif)

**Drag images in. Resize with handles. Rename inline. No manual file operations.**

- ✅ **Drag & drop** — Drop images directly into your document
- ✅ **In-place resizing** — Drag handles to adjust width, see live preview
- ✅ **Auto-size suggestions** — Get warnings for oversized images (saves your storage on GIT)
- ✅ **Rename images** — Change filenames without leaving the editor (we rename file on disk, and also update the markdown code)
- ✅ **Metadata overlay** — View dimensions, file size, and path at a glance

> [!IMPORTANT]
> We backup original image always, before resizing.

*Adjust image width with intuitive resize handles for perfect layout control.*

![Image Rename Functionality](https://raw.githubusercontent.com/concretios/markdown-for-humans/4bf7defb6a3e7ee56b34e6dd9dc0a55e471740ec/marketplace-assets/gifs/image_rename_functionality.gif)

*Rename images directly from the editor to keep your assets organized.*

---

## Built on True WYSIWYG Editing
Humans work that way.

![WYSIWYG Editing](https://raw.githubusercontent.com/concretios/markdown-for-humans/4bf7defb6a3e7ee56b34e6dd9dc0a55e471740ec/marketplace-assets/gifs/basic_introduction.gif)

**See your formatted output as you type. No split panes. No preview mode. Just write.**

Built on TipTap with a **human-first design philosophy**:

- **Persistent formatting bar** — See your options, click what you need
- **Floating shortcuts** — Actions appear where you need them (Tables: right-click, Images: More icon)
- **No command palette overload** — Actions are visible, not buried in `/commands`
- **No context switching** — Everything you need is right there

---

## ✨ What Makes It Different


| Feature                 | Markdown for Humans          | Markdown All in One | Standard Editors  |
| ----------------------- | ---------------------------- | ------------------- | ----------------- |
| **WYSIWYG Editing**     | ✅ Full-screen, no split pane | ❌ Split pane only   | ❌ Plain text      |
| **Visual Table Editor** | ✅ Drag, resize, edit cells   | ⚠️ Basic syntax     | ❌ Manual syntax   |
| **Image Management**    | ✅ Rename, resize inline      | ❌ Manual file ops   | ❌ Manual file ops |
| **Mermaid Diagrams**    | ✅ Live rendering             | ✅ Preview only      | ❌ Not supported   |


---

## Quick Start

### Installation

**VS Code**

**Option 1: Via Marketplace (Recommended)**

1. Visit [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=concretio.markdown-for-humans)
2. Click "Install"

**Option 2: Within VS Code**

1. Open Extensions (`Ctrl+Shift+X` / `Cmd+Shift+X`)
2. Search for "Markdown for Humans" or use the extension ID: `concretio.markdown-for-humans`
3. Click Install

**Cursor / Windsurf / VSCodium / Other Open VSX IDEs**

**Via Open VSX Registry:**

1. Open Extensions panel
2. Search for "Markdown for Humans" or use the extension ID: `concretio.markdown-for-humans`
3. Install (automatically pulls from [Open VSX Registry](https://open-vsx.org/extension/concretio/markdown-for-humans))

**Direct Link:** [Open VSX Registry](https://open-vsx.org/extension/concretio/markdown-for-humans)

**Supported IDEs:**

- [Cursor](https://cursor.sh/)
- [Windsurf](https://codeium.com/windsurf)
- [VSCodium](https://vscodium.com/)
- [Gitpod](https://www.gitpod.io/)
- [Eclipse Theia](https://theia-ide.org/)
- Other Open VSX-compatible IDEs

> 💡 **Pro Tip:** For precise results, search using the extension ID `concretio.markdown-for-humans` in the Extensions panel of any IDE.

### Usage

1. Open any `.md` file → Right-click → **"Open with Markdown for Humans"**
2. Start writing!

**Toggle between WYSIWYG and source**: Click the `</>` Source button in the toolbar

---

## Review Markdown with Feedback Sessions

Feedback mode freezes one saved Markdown file so you can comment on the rich view without moving the underlying source. The resulting bundle is plain Markdown plus optional PNG evidence, ready to share through Git with Codex, Claude Code, Grok, or another workspace-aware agent.

1. Open a saved Markdown file inside a workspace and click **Start feedback**.
2. Select rendered text or code and use the floating comment button beside the selection. The focused composer records the exact visible quote and its containing source lines without opening older comment cards.
3. For visual feedback, click **Capture area**, drag over the visible editor, optionally mark it with Pen, Rectangle, or Ellipse, and add a written instruction.
4. Use **Comments** to hide or show document-aligned pins and cards. Exact text, including resolved cross-block text, is highlighted only in Feedback mode. Multi-block block-level fallbacks and opaque targets use one continuous edge bracket. Compact cards follow their targets as the document scrolls, and only the active card expands with the exact quote or capture preview plus source lines.
5. Click **Finish & copy** to verify the frozen source hash, seal the bundle, and copy an agent handoff prompt.

The formatting toolbar is replaced by Feedback actions while a session is active, and document editing is locked while text selection and search remain available. If the source changes outside the frozen rich view, the session is invalidated: its draft stays on disk, but new feedback and finishing are disabled.

When the same saved source and SHA-256 have an existing draft, the editor announces it without entering Feedback mode. Choose **Resume**, **Reveal**, **Discard**, or **Not now**. Resume revalidates the complete report, its item IDs and line ranges, and every screenshot asset before it freezes the editor again. If one otherwise valid exact highlight cannot be reconstructed, that item keeps its exact source lines and appears with a continuous block bracket. A persistent `MD4H-FB-ANCHOR-001` notice lists the affected IDs and offers Retry instead of fuzzy re-anchoring or blocking the other comments.

For `docs/guide.md`, one round is stored as:

```text
.md4h/feedback/docs/
└── guide.md--20260821T093000Z-a4f9/
    ├── feedback.md
    └── assets/
        └── F2.png
```

`feedback.md` starts with this contract:

```yaml
---
schema: md4h-feedback/v1
state: sealed
round: 20260821T093000Z-a4f9
source: 'docs/guide.md'
source_sha256: <SHA-256 of the exact saved source bytes>
created_at: '2026-08-21T09:30:00.000Z'
next_id: F3
sealed_at: '2026-08-21T09:35:00.000Z'
---
```

A live draft uses `state: draft` and omits `sealed_at`.

Items have these shapes:

````markdown
## F1

**Target:** `docs/guide.md:12-14`

**Focus:**

```text
exact visible selection
```

### Feedback

```markdown
Describe the requested change.
```

## F2 · screenshot

**Source:** `docs/guide.md`

**Nearby source:** lines 18-24

### Evidence

![F2 screenshot](./assets/F2.png)

**Asset SHA-256:** `<SHA-256 of the exact PNG bytes>`

### Feedback

```markdown
Describe the requested visual change.
```
````

Text items use stable, monotonic `F<n>` IDs and safely fence the exact visible focus and feedback. Screenshot items bind the evidence path to its exact PNG bytes with `Asset SHA-256`; resume and sealing reject missing, changed, malformed, oversized, or path-unsafe evidence. A bundle accepts at most 2,000 allocated feedback IDs and 64 MiB of screenshot evidence. `next_id` persists the allocation high-water mark across deletion and restart. Draft rewrites are atomic. Sealed bundles are immutable to the extension and are removed manually when no longer needed. `.md4h/feedback/` is not ignored, so it can be reviewed and committed like other project files.

After sealing, **Finish & copy** places this provider-neutral instruction on the clipboard with the real workspace-relative path substituted:

> Implement the sealed feedback bundle at `<workspace-relative-path>/feedback.md`. First verify the source SHA-256. Inspect every referenced image. Edit the workspace files required by the feedback, but do not modify or delete the feedback bundle. Address every feedback ID, run appropriate checks, report the outcome per ID, and stop if the source hash differs.

Area capture is DOM-based and includes rendered Markdown content, not VS Code chrome. It is limited to the visible editor viewport, requires an exact mapped block intersection, rejects resources that are unavailable through the webview boundary, and caps PNG output at 12 megapixels and 10 MiB. **Capture selected blocks** is the keyboard-accessible alternative to dragging.

### Feedback Commands

Feedback commands are available in the Command Palette with no default keyboard shortcuts. Assign personal keybindings through VS Code if desired.

| Command                         | Command ID                                         |
| ------------------------------- | -------------------------------------------------- |
| Start Feedback                  | `markdownForHumans.feedback.start`                 |
| Add Feedback to Selection       | `markdownForHumans.feedback.commentSelection`      |
| Capture Feedback Area           | `markdownForHumans.feedback.captureArea`           |
| Capture Selected Blocks         | `markdownForHumans.feedback.captureSelectedBlocks` |
| Toggle Feedback Comments        | `markdownForHumans.feedback.toggleComments`        |
| Next Feedback                   | `markdownForHumans.feedback.next`                  |
| Previous Feedback               | `markdownForHumans.feedback.previous`              |
| Finish Feedback and Copy Prompt | `markdownForHumans.feedback.finish`                |
| Reveal Feedback File            | `markdownForHumans.feedback.reveal`                |
| Discard Feedback Draft          | `markdownForHumans.feedback.discard`               |

---

## ⚙️ Configuration

Customize the editor behavior through VS Code settings. Access via `Ctrl+,` (Settings) and search for "Markdown for Humans".

### Image Settings

- **`markdownForHumans.imagePreview.hover.enabled`** (default: `true`)
  - Enable the image hover overlay that shades images and displays metadata (resolution, file size, etc.) on hover
  - Set to `false` to disable hover effects and reduce visual distraction

- **`markdownForHumans.imagePath`** (default: `"images"`)
  - Folder path for saved images. Interpreted relative to `markdownForHumans.imagePathBase`.

- **`markdownForHumans.imagePathBase`** (default: `"relativeToDocument"`)
  - Controls whether Image Path is relative to the current markdown file folder or the workspace folder.

- **`markdownForHumans.imageResize.skipWarning`** (default: `false`)
  - Skip the warning dialog when resizing images. When enabled, images will be resized immediately without confirmation.

### PDF Export Settings

- **`markdownForHumans.chromePath`** (default: `""`)
  - Path to Google Chrome or Chromium executable for PDF export. Leave empty to auto-detect.

---

## More Features

### Enhanced Link Dialog

![Enhanced Link Feature](https://raw.githubusercontent.com/concretios/markdown-for-humans/4bf7defb6a3e7ee56b34e6dd9dc0a55e471740ec/marketplace-assets/gifs/hyperlink_feature.gif)

*Create links easily with support for URLs, file linking, heading links, and more—all through an intuitive dialog interface.*

### Mermaid Diagrams

![Mermaid Diagrams](https://raw.githubusercontent.com/concretios/markdown-for-humans/4bf7defb6a3e7ee56b34e6dd9dc0a55e471740ec/marketplace-assets/gifs/mermaid_diagram_with_one_diagram_only.gif)

*Create flowcharts, sequence diagrams, Gantt charts, and more with 15 built-in templates.*

### Document Outline

![Document Outline](https://raw.githubusercontent.com/concretios/markdown-for-humans/4bf7defb6a3e7ee56b34e6dd9dc0a55e471740ec/marketplace-assets/gifs/outline_feature_with_sidebar_display.gif)

*Navigate your document quickly with sidebar outline showing all headings for instant access.*

### GitHub Alerts

![GitHub Alerts](https://raw.githubusercontent.com/concretios/markdown-for-humans/4bf7defb6a3e7ee56b34e6dd9dc0a55e471740ec/marketplace-assets/gifs/github_alerts.gif)

*Create beautiful GitHub-style alert boxes for notes, warnings, tips, and important information.*

---

## What's Included

Markdown for Humans includes everything you need for a modern writing experience:

- **True WYSIWYG editing** powered by TipTap—see your formatted output as you type
- **Advanced table editing** with drag-to-resize columns, context menus, and toolbar controls
- **Mermaid diagrams** with 15 built-in templates and double-click editing
- **Code blocks** with syntax highlighting for 11+ languages
- **Math support** with beautiful LaTeX rendering via KaTeX
- **PDF and DOCX export** for sharing your documents
- **Document outline** with sidebar navigation for quick heading access
- **Theme support** for Light, Dark, and System themes (inherits your VS Code theme)
- **Word count and reading time** to track your writing progress

[Full feature list → Wiki](https://github.com/concretios/markdown-for-humans/wiki)

---

## Why We Built This

**Writing should feel natural, not technical.** You shouldn't need to memorize syntax, dig through command palettes, or fight with your tools. You should just write.

Existing markdown editors force writers to choose between split-pane previews that waste screen space, plain text editing that requires memorizing syntax, standalone apps that don't integrate with your workflow, or command-heavy interfaces that bury actions in overloaded palettes.

We built Markdown for Humans to solve the **real pain points**—tables and images—that make markdown editing frustrating, while keeping the underlying file as plain markdown (so Git diffs, tooling, and other editors still work).

---

## Documentation

### For Users

- [User Guide](https://github.com/concretios/markdown-for-humans/wiki)
- [Known Issues](./KNOWN_ISSUES.md) - Known issues and workarounds
- [Report Issues](https://github.com/concretios/markdown-for-humans/issues)

### For Developers

- [Contributing](./CONTRIBUTING.md) - Developer setup and guidelines
- [Architecture](./docs/ARCHITECTURE.md) - Technical deep dive
- [Development Guide](./docs/DEVELOPMENT.md) - Philosophy and roadmap
- [Build Guide](./docs/BUILD.md) - Build and packaging
- [Troubleshooting](./docs/TROUBLESHOOTING.md) - Technical troubleshooting

### For Maintainers

- [Release Checklist](./docs/RELEASE_CHECKLIST.md) - Release process
- [QA Manual](./docs/QA_MANUAL.md) - Testing procedures

---

## Contributing

> **⚡ Built on open source, for the community.**  
> Markdown for Humans exists because open source software empowers everyone. We believe that the best tools should be built, improved, and maintained by the whole community—not limited by a few. By embracing collaboration and transparency, we keep innovation moving forward for everyone.

We welcome contributions! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

Ways to contribute:

- Report bugs
- Suggest features
- Improve documentation
- Submit pull requests
- Star the repo

---

## Vibe Coded its way

This extension was built through AI / **vibe coding**, with minimal human effort focused on fixes and stability. The basic functional model came together in minutes, but what took days and hours was **testing each feature** to ensure everything works smoothly in real-world use. 

It's the classic 80:20 rule in action: that final 20% of polish, edge cases, and real-world testing takes 80% of the time, and that's where the real value lives.

We're open-sourcing this because in AI era, **code has limited value**, the real work was in the creativity in planning, design, and relentless testing. 

Countless hours went into vibe-coded wireframes, user experience design, and polish to create something that feels natural and intuitive.

---

## License

MIT © [Concret.io](https://concret.io)

---

## Credits

Built with:

- [TipTap](https://tiptap.dev/) - Headless editor framework
- [KaTeX](https://katex.org/) - Fast math rendering
- [Mermaid](https://mermaid.js.org/) - Diagram generation
- [VS Code Extension API](https://code.visualstudio.com/api)

---

**Made with ❤️ for Markdown lovers, by Team [Concret.io**](https://concret.io)
