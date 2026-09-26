# Testing Guide

> Testing requirements, best practices, and Test-Driven Bug Fixing (TDBF).
> Index: See `AGENTS.md` for canonical instructions.

---

## Test-Driven Development (TDD) is MANDATORY

**TDD is the default workflow for ALL features and bugs.**

The workflow is:

1. **RED:** Write failing test FIRST (defines what success looks like)
2. **GREEN:** Implement simplest clean solution to make test pass
3. **REFACTOR:** Clean up code while keeping tests green  
4. **VERIFY:** Run full `npm test` to ensure no regressions
5. **SHIP:** Mark task as `done` only after ALL tests pass

**Why TDD?**
- Confirms you understand requirements before coding
- Catches regressions immediately
- Forces simpler, testable design
- Documents expected behavior in code
- Prevents "works on my machine" issues

---

## Test File Locations

```
src/__tests__/
├── features/           # Extension-side feature tests
│   ├── wordCount.test.ts
│   └── imageDragDrop.test.ts
├── webview/            # Webview utility tests
│   ├── pasteHandler.test.ts
│   ├── copyMarkdown.test.ts
│   ├── tocOverlay.test.ts
│   └── imageConfirmation.test.ts
└── setup.ts            # Jest setup and custom matchers
```

---

## Test Writing Best Practices

**1. Test pure logic directly:**
```typescript
describe('buildOutline', () => {
  it('handles nested hierarchy', () => {
    const result = buildOutline([{ level: 1, text: 'Title', pos: 0 }]);
    expect(result[0].sectionEnd).toBe(1000);
  });
});
```

**2. Use `it.todo()` for DOM tests:**
```typescript
it.todo('shows overlay when toggled');
```

**3. Cover:** Positive, negative, edge cases (unicode, boundaries, nulls)

**4. Mock VS Code:** `import { window } from '../../__mocks__/vscode'` (auto-loaded)

---

## Running Tests

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode for development
npm run test:coverage # Generate coverage report
npm run test:integration # Build release bundles and run against VS Code stable
```

The Extension Development Host suite lives in `test/integration/`. CI runs it
on Ubuntu and Windows against VS Code 1.98.0 and current stable. To select a
host version locally, set `VSCODE_TEST_VERSION` before running
`npm run test:integration`; the default is `stable`.

---

## Coverage Thresholds

Current minimum thresholds (see `jest.config.js`):
- Branches: 60%
- Functions: 60%
- Lines: 60%
- Statements: 60%

---

## Test-Driven Development (TDD) for Features

**When implementing a NEW feature, always follow TDD:**

**Workflow:**
1. Read task file sections 2-4 → understand requirements
2. Write failing test → defines expected behavior
3. Verify test fails → confirms test works
4. Implement simplest clean solution → make test pass
5. Verify test passes → feature works
6. Refactor (optional) → clean up, keep tests green
7. Run full suite → `npm test` (all must pass)
8. Repeat for next requirement

---

## Quality Gates (All Must Pass)

**Before marking ANY task as `done`:**

- [ ] Tests written BEFORE implementation
- [ ] New tests pass
- [ ] ALL existing tests still pass (`npm test`)
- [ ] Test coverage includes positive, negative, edge cases
- [ ] Task file section 7 documents test approach

**If ANY gate fails:**
- **STOP** - Do not proceed
- **Audit code** - Find root cause, not symptoms  
- **Check docs** - Review `[Project Root]/docs/` or `[Project Root]/roadmap/`
- **Ask user** if unsure about requirements or approach
- **NO quick hacks** - Fix properly or ask for help

---

## When to Write Different Test Types

| Test Type | When to Use | Location |
|-----------|-------------|----------|
| **Unit tests** | Pure functions, algorithms, utilities | `__tests__/` |
| **Extension Host integration** | Activation, custom-editor registration, split views, `WorkspaceEdit`, save, and disposal | `test/integration/` |
| **`it.todo()`** | DOM/browser features, integration behaviors | `__tests__/` |
| **Manual testing** | Full UX flows, visual verification | UX checklist |

---

## Test-Driven Bug Fixing (TDBF)

When a user reports "X is not working", follow this workflow:

**Workflow:**
1. Read feature code → understand what should happen
2. Check existing tests → review coverage
3. Write failing test → replicates the bug
4. Verify test fails → confirms bug captured
5. Fix bug → minimal changes, root cause
6. Verify test passes → bug fixed
7. Run full suite → `npm test` (all must pass)

---

**Why TDBF works:** Confirms understanding, prevents regressions, documents fix, forces root cause fixes

---

## Bug Fix Checklist

- [ ] Read and understand the feature code
- [ ] Review existing tests for the feature
- [ ] Write a failing test that replicates the reported issue
- [ ] Verify test fails with current code
- [ ] Fix the bug (minimal upstream fix preferred)
- [ ] Verify the new test passes
- [ ] Run `npm test` - all tests pass
- [ ] Update task file if applicable
