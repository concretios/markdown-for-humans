# Markdown for Humans - Development Guide

**Design principles, contribution philosophy, and how work is planned**

> For practical setup and workflow, see [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Table of Contents

1. [Development Philosophy](#development-philosophy)
2. [Design Principles](#design-principles)
3. [Where Work Lives](#where-work-lives)
4. [AI Coding Assistant Integration](#ai-coding-assistant-integration)
5. [Release Process](#release-process)
6. [Related Documentation](#related-documentation)

---

## Development Philosophy

### Core Tenets

**1. Ship Early, Iterate Fast**
- Get usable builds in users' hands quickly
- Real user feedback > speculation
- Small, frequent releases beat big launches

**2. Performance First**
- Optimize from day one, not "later"
- Profile before optimizing (data-driven decisions)
- User perception matters more than benchmarks

**3. Progressive Enhancement**
- Core features work everywhere
- Advanced features enhance experience
- Graceful degradation (no hard failures)

**4. Community-Driven**
- Prioritize based on user feedback
- Encourage contributions (code, docs, design)
- Be responsive to issues and PRs

**5. Reading Experience > Feature Completeness**
- Better to have 80% of features with 120% reading quality
- Typography isn't decoration—it's the core value proposition
- Test every change by reading a 3000+ word doc

---

## Design Principles

### 1. Reading Experience is PARAMOUNT

**Philosophy:**
> Writing markdown should feel like writing in a premium publishing tool, not a code editor.

#### Typography Excellence

**Body Text:**
- **Fonts**: Inherit from VS Code editor font settings (respects user preferences and OS defaults)
- **Size**: 20% larger than base editor font (`calc(var(--md-base-size) * 1.2)`) for comfortable reading
- **Line height**: 1.58–1.6 for breathing room
- **Max width**: 680–740px (optimal reading length, ~80 characters)
- **Letter spacing**: Negative tracking for larger text (-0.003em to -0.022em)

**Non-Negotiables:**
- Never sacrifice reading comfort for "fitting more on screen"
- Inherit VS Code fonts (preferences, OS defaults, accessibility)
- Generous spacing (white space is a feature)
- Large, legible text (users who want small text can use source view)

#### Headers

- Inherit from body font; size multipliers create hierarchy
- More space above than below (visual grouping)
- Tighter line height for headers (1.25 / 1.2)

#### Emphasis

- **Bold** should feel strong; **italic** elegant; **code** clearly distinct from prose

### 2. Tables: Clean & Professional

Functional for data, but must not dominate reading. Clear borders, 12–16px padding, subtle hover, distinct headers.

### 3. Code Blocks

Subtle background, good contrast, professional monospace, theme-aware syntax highlighting.

### 4. Theme Adaptability

**System inheritance:** Use `var(--vscode-editor-background)` / `--vscode-editor-foreground` so any VS Code theme carries into the editor.

**Reading modes:** System (default), Light, Dark, Sepia — for when users want a fixed reading condition.

### 5. Inspiration Sources

| Source | What We Learn |
|--------|---------------|
| Medium.com | Body typography, spacing, reading flow |
| Modern WYSIWYG editors | Table styling, clean UI |
| Notion | Contextual toolbar, hover states |
| iA Writer | Focus mode, typography obsession |

### 6. Decision Framework

1. **Does this improve the reading experience?** ← MOST IMPORTANT
2. Does this reduce cognitive load?
3. Does this feel premium/polished?
4. Would I want to read a 10-page doc in this?
5. Does this respect the content?

**Avoid:** Smaller fonts for density, "just zoom," code-editor body sizes, treating white space as waste.

**Prefer:** Book-like reading comfort, UI that disappears so content shines.

### 7. Test with Real Content

Always exercise changes with a 3000+ word document, real tables, mixed code/prose, and 10+ minutes of reading (light and dark).

---

## Where Work Lives

Do **not** treat this file as a feature roadmap. Phase checklists formerly here are obsolete (many “unchecked” items already shipped in 0.2–0.4).

| Location | Purpose |
|----------|---------|
| [`roadmap/pipeline/`](../roadmap/pipeline/) | Active implementation plans |
| [`roadmap/shipped/`](../roadmap/shipped/) | Completed plans |
| [`roadmap/task-plan-template.md`](../roadmap/task-plan-template.md) | Template for new plans |
| [`CHANGELOG.md`](../CHANGELOG.md) | What users got in each release |
| [`KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) | Current open limitations |

Product version and shipped surface: see `package.json` (`version`) and the latest CHANGELOG section.

---

## AI Coding Assistant Integration

### Planning Workflow

Plans are public markdown files:

1. **Draft** — Start from [`roadmap/task-plan-template.md`](../roadmap/task-plan-template.md) (any AI tool or manually)
2. **Ready** — Move to `roadmap/pipeline/[name].md` when locked for implementation
3. **Complete** — `git mv roadmap/pipeline/[name].md roadmap/shipped/` when done and tests pass

If a tool creates plans under `.cursor/plans/` (or similar), move them into `roadmap/pipeline/` when ready:

```bash
git mv [source-location]/[name].md roadmap/pipeline/[name].md
```

### AGENTS.md

[`AGENTS.md`](../AGENTS.md) follows the [agents.md](https://agents.md/) standard and points agents at:

- `roadmap/pipeline/*.md` — active work
- `roadmap/shipped/*.md` — completed work
- `vibe-coding-rules/` — coding guides

See [roadmap/README.md](../roadmap/README.md) for tool-specific guidance.

---

## Release Process

We follow [Semantic Versioning](https://semver.org/):

- **Major**: Breaking changes
- **Minor**: New features (backward-compatible)
- **Patch**: Bug fixes

**Pre-release:** tests pass, docs/CHANGELOG updated, version bumped in `package.json`.

```bash
npm run build:release
npm run package:release
# Install the .vsix locally, then publish when ready:
vsce publish patch   # or minor / major
```

**Post-release:** GitHub release notes, watch issues.

Cadence: patches as needed; minors roughly every few weeks when features land.

---

## Questions & Support

- **GitHub Issues:** Bugs and feature requests
- **GitHub Discussions:** General questions
- **Email:** support@concret.io

---

## Related Documentation

- **[CONTRIBUTING.md](../CONTRIBUTING.md)** — Setup, workflow, PR process
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — Technical architecture
- **[BUILD.md](./BUILD.md)** — Build and packaging
- **[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** — Dev troubleshooting
- **[README.md](../README.md)** — User-facing docs
- **[AGENTS.md](../AGENTS.md)** — AI agent instructions
- **[KNOWN_ISSUES.md](../KNOWN_ISSUES.md)** — Open limitations

---

**Last Updated:** 2026-10-03
