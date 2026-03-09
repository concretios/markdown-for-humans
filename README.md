# GPT-AI Markdown Editor

**Seamless WYSIWYG markdown editing for VS Code** — Write markdown the way humans think.

> **Note:** This project is a community-maintained fork of the excellent [GPT-AI Markdown Editor](https://github.com/kamransethi/markdown-for-humans) by Concretios. It has been forked to build and maintain advanced features (like drag handles, text highlighting, font colors, and modular table support) while keeping the extension fully open and free.

![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/kamransethi.gpt-ai-markdown-editor?label=VS%20Code%20Marketplace&logo=visual-studio-code) ![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg) ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

---

## 🚀 See It In Action

> We also support standard shortcuts like `CTRL/CMD + B`, etc

![GPT-AI Markdown Editor Overview](https://raw.githubusercontent.com/kamransethi/markdown-for-humans/4bf7defb6a3e7ee56b34e6dd9dc0a55e471740ec/marketplace-assets/gifs/basic_overview_of_features.gif)

*Experience seamless WYSIWYG markdown editing with visual table editing, image management, and more—all in VS Code.*

---

## Stop Fighting Markdown Syntax

**Tired of manually writing table syntax? Struggling with image paths, resizing, renaming? Or you dont like memorising Markdown Syntax.** 

Most markdown editors force you to memorize syntax, fight with split panes, or manually manage files. **GPT-AI Markdown Editor solves the biggest pain points** that make markdown editing frustrating.

> **📌 100% free. No trials. No limits. No paywalls, ever.**

---

## Visual Table Editing (No More Syntax)

As natural as it gets in Microsoft Word or Google Docs etc. 

![Table Editing](https://raw.githubusercontent.com/kamransethi/markdown-for-humans/integration/marketplace-assets/gifs/table_operations_with_right_click_menu.gif)

**Drag column borders to resize. Right-click to add rows. No syntax to memorize.**

- ✅ **Drag-to-resize columns** — Click and drag column borders, just like Excel
- ✅ **Right-click context menu** — Insert/delete rows and columns instantly
- ✅ **Toolbar controls** — Add/remove rows and columns with dropdown menus
- ✅ **Tab navigation** — Move between cells with Tab/Shift+Tab

*Stop counting pipes and dashes. Start editing tables visually.*

---

## Image Management That Actually Works

> Press shift while dragging images, in case your face issues on drag drop in editor

![Large Size Image Suggestion](https://raw.githubusercontent.com/kamransethi/markdown-for-humans/integration/marketplace-assets/gifs/large_size_image_size_suggestion.gif)

**Drag images in. Resize with handles. Rename inline. No manual file operations.**

- ✅ **Drag & drop** — Drop images directly into your document
- ✅ **In-place resizing** — Drag handles to adjust width, see live preview
- ✅ **Auto-size suggestions** — Get warnings for oversized images (saves your storage on GIT)
- ✅ **Rename images** — Change filenames without leaving the editor (we rename file on disk, and also update the markdown code)
- ✅ **Metadata overlay** — View dimensions, file size, and path at a glance

> [!IMPORTANT]
> We backup original image always, before resizing.

*Adjust image width with intuitive resize handles for perfect layout control.*

![Image Rename Functionality](https://raw.githubusercontent.com/kamransethi/markdown-for-humans/integration/marketplace-assets/gifs/image_rename_functionality.gif)

*Rename images directly from the editor to keep your assets organized.*

---

## Built on True WYSIWYG Editing
Humans work that way.

![WYSIWYG Editing](https://raw.githubusercontent.com/kamransethi/markdown-for-humans/integration/marketplace-assets/gifs/basic_introduction.gif)

**See your formatted output as you type. No split panes. No preview mode. Just write.**

Built on TipTap with a **human-first design philosophy**:

- **Persistent formatting bar** — See your options, click what you need
- **Floating shortcuts** — Actions appear where you need them (Tables: right-click, Images: More icon)
- **No command palette overload** — Actions are visible, not buried in `/commands`
- **No context switching** — Everything you need is right there

---

## ✨ What Makes It Different


| Feature                 | GPT-AI Markdown Editor          | Markdown All in One | Standard Editors  |
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

1. Visit [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kamransethi.gpt-ai-markdown-editor)
2. Click "Install"

**Option 2: Within VS Code**

1. Open Extensions (`Ctrl+Shift+X` / `Cmd+Shift+X`)
2. Search for "GPT-AI Markdown Editor" or use the extension ID: `kamransethi.gpt-ai-markdown-editor`
3. Click Install

**Cursor / Windsurf / VSCodium / Other Open VSX IDEs**

**Via Open VSX Registry:**

1. Open Extensions panel
2. Search for "GPT-AI Markdown Editor" or use the extension ID: `kamransethi.gpt-ai-markdown-editor`
3. Install (automatically pulls from [Open VSX Registry](https://open-vsx.org/extension/kamransethi/gpt-ai-markdown-editor))

**Direct Link:** [Open VSX Registry](https://open-vsx.org/extension/kamransethi/gpt-ai-markdown-editor)

**Supported IDEs:**

- [Cursor](https://cursor.sh/)
- [Windsurf](https://codeium.com/windsurf)
- [VSCodium](https://vscodium.com/)
- [Gitpod](https://www.gitpod.io/)
- [Eclipse Theia](https://theia-ide.org/)
- Other Open VSX-compatible IDEs

> 💡 **Pro Tip:** For precise results, search using the extension ID `kamransethi.gpt-ai-markdown-editor` in the Extensions panel of any IDE.

### Usage

1. Open any `.md` file → Right-click → **"Open with GPT-AI Markdown Editor"**
2. Start writing!

**Toggle between WYSIWYG and source**: Click the `</>` Source button in the toolbar

---

## More Features

### Enhanced Link Dialog

![Enhanced Link Feature](https://raw.githubusercontent.com/kamransethi/markdown-for-humans/4bf7defb6a3e7ee56b34e6dd9dc0a55e471740ec/marketplace-assets/gifs/hyperlink_feature.gif)

*Create links easily with support for URLs, file linking, heading links, and more—all through an intuitive dialog interface.*

### Mermaid Diagrams

![Mermaid Diagrams](https://raw.githubusercontent.com/kamransethi/markdown-for-humans/integration/marketplace-assets/gifs/mermaid_diagram_with_one_diagram_only.gif)

*Create flowcharts, sequence diagrams, Gantt charts, and more with 15 built-in templates.*

### Document Outline

![Document Outline](https://raw.githubusercontent.com/kamransethi/markdown-for-humans/4bf7defb6a3e7ee56b34e6dd9dc0a55e471740ec/marketplace-assets/gifs/outline_feature_with_sidebar_display.gif)

*Navigate your document quickly with sidebar outline showing all headings for instant access.*

### GitHub Alerts

![GitHub Alerts](https://raw.githubusercontent.com/kamransethi/markdown-for-humans/integration/marketplace-assets/gifs/github_alerts.gif)

*Create beautiful GitHub-style alert boxes for notes, warnings, tips, and important information.*

---

## What's Included

GPT-AI Markdown Editor includes everything you need for a modern writing experience:

- **True WYSIWYG editing** powered by TipTap—see your formatted output as you type
- **Advanced table editing** with drag-to-resize columns, context menus, and toolbar controls
- **Mermaid diagrams** with 15 built-in templates and double-click editing
- **Code blocks** with syntax highlighting for 11+ languages
- **Math support** with beautiful LaTeX rendering via KaTeX
- **PDF and DOCX export** for sharing your documents
- **Document outline** with sidebar navigation for quick heading access
- **Theme support** for Light, Dark, and System themes (inherits your VS Code theme)
- **Word count and reading time** to track your writing progress

[Full feature list → Wiki](https://github.com/kamransethi/markdown-for-humans/wiki)

---

## Why We Built This

**Writing should feel natural, not technical.** You shouldn't need to memorize syntax, dig through command palettes, or fight with your tools. You should just write.

Existing markdown editors force writers to choose between split-pane previews that waste screen space, plain text editing that requires memorizing syntax, standalone apps that don't integrate with your workflow, or command-heavy interfaces that bury actions in overloaded palettes.

We built GPT-AI Markdown Editor to solve the **real pain points**—tables and images—that make markdown editing frustrating, while keeping the underlying file as plain markdown (so Git diffs, tooling, and other editors still work).

---

## Documentation

### For Users

- [User Guide](https://github.com/kamransethi/markdown-for-humans/wiki)
- [Known Issues](./KNOWN_ISSUES.md) - Known issues and workarounds
- [Report Issues](https://github.com/kamransethi/markdown-for-humans/issues)

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
> GPT-AI Markdown Editor exists because open source software empowers everyone. We believe that the best tools should be built, improved, and maintained by the whole community—not limited by a few. By embracing collaboration and transparency, we keep innovation moving forward for everyone.

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
