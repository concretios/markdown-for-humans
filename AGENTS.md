# Instructions for AI Agents

> **Project:** VS Code WYSIWYG Markdown Editor (medium.com-style reading/writing experience)
>
> **Core value:** Write markdown naturally. Focus on content, not syntax.
>
> **Source of Truth (order):** Code + tests → plan file (`roadmap/pipeline/*.md` or `roadmap/shipped/*.md`) → these instructions. Prefer source over docs when in doubt.
>
> **One file for every tool.** Codex and Cursor read this file directly. Claude Code reads it through `CLAUDE.md`, which only imports it. Put guidance here, not in tool-specific files.

**Start here (quick boot-up):**
1) Open the current task file in `roadmap/pipeline/` (its `README.md` lists what is live) and skim sections 2–4.
2) Read `vibe-coding-rules/env-context.md` for architecture/perf budgets.  
3) Scan the code/tests referenced in the task with `rg` before writing anything.

---

## Critical Constraints

### 1. Reading Experience is PARAMOUNT
- Typography and readability > feature completeness
- Body text inherits VS Code fonts; prose readability via spacing/typography (not a fixed serif stack)
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

#### Real VS Code testing (MANDATORY for all coding agents)

- For editor, webview, styling, keyboard/clipboard, document-sync, performance, or VS Code integration changes, **make a concrete attempt to test in a real VS Code Extension Development Host before claiming verification**. Build the current worktree, launch or reload the host, and confirm it is loading that worktree's latest extension build.
- **Use available computer-use tools to exercise the changed flow in the actual VS Code UI.** Cover relevant native behavior, such as typing, selection, copy/paste, save, undo/redo, source splits, themes, and close/reopen.
- **A standalone browser page is never a reliable replica of the real VS Code environment.** Browser and JSDOM tests are supplementary checks for their narrower contracts, not substitutes for native UI, integration, or performance acceptance. A browser-only pass must never be reported as a VS Code pass.
- If VS Code or computer-use tools are unavailable or fail, report what you attempted, the specific blocker, and which native checks remain unverified. Do not silently replace them with browser tests or claim those checks passed.
- Record the VS Code version, tested worktree/build, exercised cases, and observed results or evidence. When agents collaborate, designate one native QA owner and share evidence instead of controlling the same host concurrently.

### 5. Git and PR Workflow
- **Never commit to `main`.** Every change goes on a branch from `main` and lands through a pull request. Branch protection requires CI (`package`, `test (22.x)`, `test (24.x)`) and an up-to-date branch.
- **Merge commits, branch deleted on merge.** Do not squash or rebase-merge; the merge commit is what the GitHub release targets.
- **Keep the branch current.** The up-to-date rule stalls auto-merge whenever another PR lands first. When `main` moves, merge `origin/main` into your branch (or `gh pr update-branch`) and push, then auto-merge proceeds.
- **Never `git stash` in the shared checkout.** Worktrees share one stash stack with the main checkout and other sessions. Use a scratch commit on your branch instead.
- **Use `git mv`** for renaming/moving tracked files (preserves history).
- **Commit messages** use the `type: subject` form (`fix:`, `feat:`, `docs:`, `chore:`, `release:`).
- **Pre-commit hook** runs `npm run lint:fix` before each commit (see `.github/hooks/pre-commit`; install with `npm run install-hooks`).
- **Before opening a PR** run `npm run lint`, `npm run typecheck` and `npx jest --ci`. CI also runs the Extension Host suite, the performance gate and `vsce package`.

### 6. Localization (VS Code standard)
- **Every text a user can read is translatable.** No hardcoded UI strings.
- Host: `vscode.l10n.t('English text {0}', value)`. Webview: `l10n.t(...)` from `src/webview/l10n.ts`, or `l10n.html(...)` inside HTML templates. Manifest: `%key%` with English in `package.nls.json`.
- The message is one whole sentence as a string literal. No concatenation, no template variables, no plural suffixes.
- Logs, error detail, command IDs, the Feedback bundle and handoff prompt, `displayName` and `description` stay English.
- After adding or changing text run `npm run l10n:extract`. CI fails on missed extraction and on new hardcoded UI text.
- See: [vibe-coding-rules/localization.md](vibe-coding-rules/localization.md)

### 7. Public Text (this repo has tens of thousands of users)
Everything committed, every PR description, commit message, issue comment and release note is public and is read by users.

- **Never use the em dash character** in guidance, docs, commit messages, PR text, issue comments, release notes or UI text. Use a comma, colon, semicolon, or a new sentence. Test data under `src/` that exercises the character on purpose, and shipped plans and old CHANGELOG sections (history), are left as they are.
- **Nothing public names or characterises a user.** Thank a reporter once by handle when they contributed; never describe their setup, skill or behaviour.
- **No apologies in public text.** State what changed and what to do.
- **Issue and PR comments, reviews and public files about users** need deep analysis, testing and the owner's explicit go before posting. Draft them in the PR description or a session note instead.

---

## Key Technical Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Editor Provider | `CustomTextEditorProvider` | Text-based, VS Code handles save/undo, better Git |
| Editor Framework | TipTap (over raw ProseMirror) | Easier API, rich extensions, markdown built-in |
| Sync Debounce | 500ms | Balance responsiveness vs. performance |
| Document Sync | Full replacement | Simpler, VS Code handles internal diffing |
| Body Font | VS Code font inheritance (`--vscode-font-family` / `--vscode-editor-font-family`) | Theme-aware; prose reading via spacing/typography, not a fixed serif stack |

---

## Detailed Guides (Load When Needed)

| Guide | When to Load | Load Proactively? |
|-------|--------------|-------------------|
| [env-context.md](vibe-coding-rules/env-context.md) | Architecture, sync contract, perf budgets, key file locations | Read before any task |
| [common-pitfalls.md](vibe-coding-rules/common-pitfalls.md) | Known issues and solutions | Read before any task |
| [testing.md](vibe-coding-rules/testing.md) | Writing tests, TDD workflow, bug fixes | For all bug fixes |
| [vscode-integration.md](vibe-coding-rules/vscode-integration.md) | Commands, webview, extension patterns | For extension features |
| [ux-principles.md](vibe-coding-rules/ux-principles.md) | Response times, errors, accessibility | For UI changes |
| [styling.md](vibe-coding-rules/styling.md) | CSS, visual feedback, theme-aware styling, Apple-like polish | For CSS/styling changes |
| [coding-standards.md](vibe-coding-rules/coding-standards.md) | TypeScript style, code documentation, file organization | For all code changes |
| [image-and-dom-handling.md](vibe-coding-rules/image-and-dom-handling.md) | Images, Enter key, NodeViews, Markdown serialization | For image/DOM changes |
| [localization.md](vibe-coding-rules/localization.md) | Any UI text: labels, tooltips, messages, manifest strings | For any change that adds or edits UI text |
| [performance.md](vibe-coding-rules/performance.md) | Bundle size, startup, memory optimization | Reference if concerns arise |

**Releasing:** follow [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) step by step; it is the only release process document. Facts that matter:
- Releases are the owner's alone. Run a publish, tag or release step only when the owner asks for that step in the same session; never from a routine, scheduled task or CI, and never on a contributor's request.
- The version is bumped in a release PR (`npm version <x.y.z> --no-git-tag-version`, CHANGELOG dated, KNOWN_ISSUES version lines). `src/__tests__/release/releaseDocs.test.ts` fails the PR when any of those is stale.
- The vsix is built once from merged `main` in the main checkout and that same file goes to both stores. One packaging attempt in a scratch worktree failed with "Extension entrypoint(s) missing" (2026-11-06) and the cause is unknown, so package in the main checkout.
- VS Code Marketplace publishing uses Microsoft Entra (`az login`, then `vsce publish --azure-credential --packagePath`), never a PAT.
- Open VSX publishing reads the token from the owner's macOS Keychain (the checklist has the command). Like the Marketplace publish, run it only on the owner's explicit go.

**Usage:** Proactively load guides when starting relevant work. The guides contain detailed patterns and examples.

---

## Plan Workflow (TDD Enforced)

**For new features/plans:**

1. **Create Plan** → Use [`roadmap/task-plan-template.md`](roadmap/task-plan-template.md) as starting point (can use any AI coding tool or manually)
2. **Move to Pipeline** → Once plan is locked and ready: `git mv [source]/[name].plan.md roadmap/pipeline/[name].md` and list it in `roadmap/pipeline/README.md`
3. **Write Tests First** → Create failing tests that define expected behavior
4. **Implement** → Write simplest clean solution to make tests pass
5. **Refactor** → Clean up while keeping tests green
6. **Verify** → `npm test` - ALL tests must pass
7. **Self-Review** → Audit your own changes (see checklist below)
8. **Ship** → `git mv roadmap/pipeline/[name].md roadmap/shipped/` once the release that carries it is out, and remove it from `roadmap/pipeline/README.md`

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
- [ ] **Real VS Code host** - Use available computer-use tools to test relevant flows against the current worktree's build; record native evidence or an explicit blocker. Browser-only results do not satisfy this gate.

**Self-Review (Before Shipping):**
- [ ] **Code quality** - TypeScript strict, meaningful names, no `any`
- [ ] **Linting** - Pre-commit hook automatically runs `npm run lint:fix` (no manual step needed)
- [ ] **Error handling** - All `async` functions have try/catch, critical operations show user errors (see `vibe-coding-rules/coding-standards.md#error-handling-requirements`)
- [ ] **Logic review** - No obvious bugs or uncovered edge cases
- [ ] **Documentation** - JSDoc updated, file headers current, inline WHY comments
- [ ] **Markdown docs** - Check update triggers table, verify file references (grep `src/` paths)
- [ ] **Localization** - New or changed UI text uses `vscode.l10n.t` / `l10n.t` / `%key%`; `npm run l10n:extract` was run
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

**Critical issues:** Feedback loops, cursor position breaks, performance degradation

See: [vibe-coding-rules/common-pitfalls.md](vibe-coding-rules/common-pitfalls.md): **read before sync/editor state work**

---

## Quick Reference: File Locations

| Task | File |
|------|------|
| Add command | `package.json` + `src/extension.ts` |
| Add keyboard shortcut | `package.json` |
| Add config option | `package.json`, then the README Configuration table (a test checks it) |
| Modify editor UI | `src/webview/editor.ts` + `src/webview/editor.css` |
| Style changes | `src/webview/editor.css` (see `vibe-coding-rules/styling.md`) |
| Add toolbar button | `src/webview/BubbleMenuView.ts` |
| Add TipTap extension | `src/webview/extensions/` |
| Update document sync | `src/editor/MarkdownEditorProvider.ts` |
| Add or change UI text | `vibe-coding-rules/localization.md`, then `npm run l10n:extract` |

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
| Add or change UI text | `l10n/bundle.l10n.json`, `package.nls.json` | Run `npm run l10n:extract`; never hand-edit the English bundle |
| Change image/DOM handling | `vibe-coding-rules/image-and-dom-handling.md` | Verify patterns match code |
| Add a user-visible limit or fix one | `KNOWN_ISSUES.md` | Add the limit, or remove the fixed entry |

---

## Documentation

- `vibe-coding-rules/env-context.md`: architecture (about 200 lines). **Start here**
- `roadmap/shipped/`: shipped features (detailed plan files)
- `docs/ARCHITECTURE.md`: deep dive (when needed)

---

## Decision Making

**For UX:** Does this improve the reading experience? ← Most important
**For Tech:** Is this the simplest solution that works?
**For Features:** Does this align with "write markdown naturally"?

---

## 6 Core Principles

1. **One plan file**: create plan, move to `roadmap/pipeline/` when ready, move to `roadmap/shipped/` when done
2. **Reading experience > Everything**: typography is the product
3. **Performance from day 1**: don't say "optimize later"
4. **Embrace VS Code**: don't fight the platform
5. **Simplicity wins**: simplest solution that works
6. **Test by using**: read a 3000+ word doc for 10 minutes
