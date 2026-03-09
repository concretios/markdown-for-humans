# Instructions for AI Agents

> **Project:** VS Code WYSIWYG Markdown Editor (medium.com-style reading/writing experience)
>
> **Status:** MVP ~85% complete | **Core value:** Write markdown naturally—focus on content, not syntax
>
> **Source of Truth (order):** Code + tests → plan file (`roadmap/pipeline/*.md` or `roadmap/shipped/*.md`) → these instructions. Prefer source over docs when in doubt.

**Start here (quick boot-up):**
1) Open the current task file in `roadmap/pipeline/` and skim sections 2–4.  
2) Read `vibe-coding-rules/env-context.md` for architecture/perf budgets.  
3) Scan the code/tests referenced in the task with `rg` before writing anything.

---

## Critical Constraints

### 1. Reading Experience is PARAMOUNT
- Typography and readability > feature completeness
- Serif body text (prose, not code)
- Generous spacing (white space is a feature)
- **Test every change by reading a 3000+ word doc for 10+ minutes**

### 2. Test-Driven Development (MANDATORY)
**RED → GREEN → REFACTOR → VERIFY**

- Write failing tests BEFORE implementation
- A plan is only "done" when ALL tests pass (new + existing)
- Document tests in the plan file or test files
- See: [vibe-coding-rules/testing.md](vibe-coding-rules/testing.md)

### 3. Performance Budgets
- <500ms editor initialization
- <16ms typing latency (keystrokes)
- <50ms other interactions (cursor, formatting)
- <300ms menu/toolbar actions
- Handle 10,000+ line documents smoothly

### 4. VS Code Integration
- Deep Git integration (diffs, commits work correctly)
- Command palette commands (discoverable)
- Follow VS Code keyboard conventions
- Inherit theme colors (no hard-coded values)

### 5. Git & File Rules
- **Never commit or push** — User must review first
- **Use `git mv`** for renaming/moving tracked files (preserves history)
- **Pre-commit hook** — Automatically runs `npm run lint:fix` before each commit (see `.github/hooks/pre-commit`)

---

## Key Technical Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Editor Provider | `CustomTextEditorProvider` | Text-based, VS Code handles save/undo, better Git |
| Editor Framework | TipTap (over raw ProseMirror) | Easier API, rich extensions, markdown built-in |
| Sync Debounce | 500ms | Balance responsiveness vs. performance |
| Document Sync | Full replacement | Simpler, VS Code handles internal diffing |
| Body Font | Serif (Charter/Georgia) | Prose, not code; matches premium editors |

---

## Detailed Guides (Load As Needed)

- [common-pitfalls.md](vibe-coding-rules/common-pitfalls.md): read before sync/editor-state work.
- [testing.md](vibe-coding-rules/testing.md): required for bug fixes and TDD workflow.
- [vscode-integration.md](vibe-coding-rules/vscode-integration.md): VS Code commands, webview patterns.
- [ux-principles.md](vibe-coding-rules/ux-principles.md): responsiveness and error UX.
- [styling.md](vibe-coding-rules/styling.md): theme-aware CSS patterns.
- [coding-standards.md](vibe-coding-rules/coding-standards.md): TypeScript and documentation standards.
- [image-and-dom-handling.md](vibe-coding-rules/image-and-dom-handling.md): images/DOM/nodeview patterns.
- [performance.md](vibe-coding-rules/performance.md): startup, bundle, and memory guidance.

Load only what the current task requires.

---

## Plan Workflow (TDD Enforced)

**For new features/plans:**

1. **Create Plan** → Use [`roadmap/task-plan-template.md`](roadmap/task-plan-template.md) as starting point (can use any AI coding tool or manually)
2. **Move to Pipeline** → Once plan is locked and ready: `git mv [source]/[name].plan.md roadmap/pipeline/[name].md`
3. **Write Tests First** → Create failing tests that define expected behavior
4. **Implement** → Write simplest clean solution to make tests pass
5. **Refactor** → Clean up while keeping tests green
6. **Verify** → `npm test` - ALL tests must pass
7. **Self-Review** → Audit your own changes (see checklist below)
8. **Ship** → `git mv roadmap/pipeline/[name].md roadmap/shipped/`

**Critical Rules:**
- Tests MUST be written BEFORE implementation (TDD)
- A plan is only `done` when ALL tests pass (not just new ones)
- **Self-review before shipping** - catch overlooked issues
- If issues found, debug/audit code - NO quick hacks or patches

---

## Feature Checklist

**Plan Management:**
- [ ] Plan file created and moved to `roadmap/pipeline/[name].md` when ready
- [ ] Update plan with implementation progress
- [ ] Document decisions and test approach in plan

**Testing (MANDATORY - TDD Required):**
- [ ] **Write failing tests FIRST** (`src/__tests__/`)
- [ ] Verify tests fail (confirms tests work)
- [ ] **Implement feature** to make tests pass
- [ ] **Run `npm test`** - ALL tests pass (new + existing)
- [ ] Cover positive, negative, edge cases
- [ ] If bugs found: audit/debug, not quick fixes

**Self-Review (Before Shipping):**
- [ ] **Code quality** - TypeScript strict, meaningful names, no `any`
- [ ] **Linting** - Pre-commit hook automatically runs `npm run lint:fix` (no manual step needed)
- [ ] **Error handling** - All `async` functions have try/catch, critical operations show user errors (see `vibe-coding-rules/coding-standards.md#error-handling-requirements`)
- [ ] **Logic review** - No obvious bugs or uncovered edge cases
- [ ] **Documentation** - JSDoc updated, file headers current, inline WHY comments
- [ ] **Markdown docs** - Check update triggers table, verify file references (grep `src/` paths)
- [ ] **Third-party licenses** - If added/removed dependencies, update `THIRD_PARTY_LICENSES.md` with license info
- [ ] **Test coverage** - Positive, negative, edge cases all covered
- [ ] **Clean code** - Use `console.log()` for development (removed in production), `console.error()` for errors (always kept), no debugging code or commented-out blocks
- [ ] **Diff review** - Does this make sense to future you in 6 months?
- [ ] **Manual read** - Read a 3000+ word doc in the editor for 10+ minutes (light/dark) to catch UX regressions

---

## Code Documentation (Auto-Update)

**When you change code, update its docs:**
- **Modified function?** → Update JSDoc (params, returns, throws)
- **Changed file exports?** → Update file header
- **Removed code?** → Delete stale comments
- **Added workaround?** → Add inline WHY comment with issue reference

See: [vibe-coding-rules/coding-standards.md#code-documentation](vibe-coding-rules/coding-standards.md)

---

## Research Over Assumptions

**Before implementing:**
1. Check official docs (VS Code API, TipTap/ProseMirror) - prefer over memory
2. Search GitHub issues for known problems
3. Test assumptions with small examples
4. **ALWAYS fact check what the user is asking and suggest simple robust alternative ways if their request is fundamentally a bandaid or goes against VS Code paradigms.**

**Critical issues:** Feedback loops, cursor position breaks, performance degradation

See: [vibe-coding-rules/common-pitfalls.md](vibe-coding-rules/common-pitfalls.md) — **Read before sync/editor state work**

---

## Quick Reference: File Locations

| Task | File |
|------|------|
| Add command | `package.json` + `src/extension.ts` |
| Add keyboard shortcut | `package.json` |
| Add config option | `package.json` |
| Modify editor UI | `src/webview/editor.ts` + `src/webview/editor.css` |
| Style changes | `src/webview/editor.css` (see `vibe-coding-rules/styling.md`) |
| Add toolbar button | `src/webview/BubbleMenuView.ts` |
| Add TipTap extension | `src/webview/extensions/` |
| Update document sync | `src/editor/MarkdownEditorProvider.ts` |

---

## Documentation Update Triggers

**When you change code, check these docs:**

| Code Change | Docs to Check | Quick Check |
|-------------|---------------|-------------|
| Add/remove TipTap extension | `vibe-coding-rules/env-context.md` | Verify file paths in "Key File Locations" |
| Change sync/debounce logic | `vibe-coding-rules/env-context.md`, `vibe-coding-rules/common-pitfalls.md` | Verify timing values match (500ms, 2s, etc.) |
| Add/remove config option | `package.json` descriptions, README.md | Verify config exists and matches enum/defaults |
| **Add/remove dependency** | **`THIRD_PARTY_LICENSES.md`** | **Add entry with license, copyright, repository, and license URL** |
| Change file structure | `vibe-coding-rules/env-context.md` (Key File Locations table) | Verify all paths exist |
| Ship new feature | `roadmap/shipped/` | Move plan from pipeline to shipped when complete |
| Change styling patterns | `vibe-coding-rules/styling.md` | Verify examples match current CSS |
| Change testing approach | `vibe-coding-rules/testing.md` | Verify patterns match current tests |
| Change image/DOM handling | `vibe-coding-rules/image-and-dom-handling.md` | Verify patterns match code |

---

## Documentation

- `vibe-coding-rules/env-context.md` — Architecture (~80 lines) **Start here**
- `roadmap/shipped/` — Shipped features (detailed plan files)
- `docs/ARCHITECTURE.md` — Deep dive (when needed)

---

## Decision Making

**For UX:** Does this improve the reading experience? ← Most important
**For Tech:** Is this the simplest solution that works?
**For Features:** Does this align with "write markdown naturally"?

---

## 6 Core Principles

1. **One plan file** — Create plan, move to `roadmap/pipeline/` when ready, move to `roadmap/shipped/` when done
2. **Reading experience > Everything** — Typography is the product
3. **Performance from day 1** — Don't say "optimize later"
4. **Embrace VS Code** — Don't fight the platform
5. **Simplicity wins** — Simplest solution that works
6. **Test by using** — Read a 3000+ word doc for 10 minutes

## Runtime Error Policy (Developer Mode)

- Config key: `markdownForHumans.developerMode` (boolean, default `true`).
- For runtime failures that risk data loss (serialization/sync/save), always:
    - log with `[MD4H]` context,
    - surface a user-visible error notification,
    - include technical details in notifications only when Developer Mode is enabled.
- Throttle repeated notifications to avoid user spam loops.
- Do not silently discard risky failures.

---

**Last Updated:** 2025-12-13

## Modular Extension Strategy

To maintain a clean and reliable editor experience, all custom functionality MUST be implemented as modular Tiptap Extensions.

### Core Rules for Extensions

1. **No Core Redundancy**: If `StarterKit` or an official `@tiptap/extension-*` provides it (e.g., input rules for Markdown), use the official package. Do NOT write custom input rules unless they are for our own entirely custom nodes.
2. **Total Encapsulation**: Tiptap extensions should be completely self-sufficient.
    - If a feature requires CSS, it hooks into an existing standardized class, or the CSS is cleanly separated in `editor.css`.
    - If a feature requires DOM manipulation (like drag handles for images), it MUST be implemented within a `NodeView` via the `addNodeView` method of the extension, NOT via global `window.addEventListener('click')` inside `editor.ts`.
3. **Strict Boundaries**: 
    - Extensions reside in `src/webview/extensions/`.
    - Extensions should export a single `Extension.create()`, `Node.create()`, or `Mark.create()` object.
    - Extensions should only communicate with the VS Code backend via standardized `vscode.postMessage` payloads.

### Refactoring Roadmap
1. Remove redundant hacks (e.g. `markdownInputRules.ts`).
2. Migrate global DOM manipulation out of `editor.ts` and into proper ProseMirror internal `NodeView` components (e.g. Image Resizing handles).
3. Decouple Message Handling: Move extension-specific message handling into `addProseMirrorPlugins` within the extension itself, limiting the footprint inside the main `editor.ts` switch statement.
