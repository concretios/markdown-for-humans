# Roadmap

This directory tracks feature planning and completed work for `markdown-for-humans`.

## Structure

```
roadmap/
├── pipeline/              # Planned features and tasks
└── shipped/               # Completed plans (moved here when done)
```

## Planning Philosophy

We believe in **planning extensively in advance** to create a strong roadmap and debate features before implementation. This approach helps us:
- Build consensus on feature direction before coding
- Identify potential issues early in the design phase
- Maintain a clear roadmap of future work
- Enable "vibe coding" (rapid implementation) once plans are solid

**Plans stay in active/pipeline state until delivered**: they're only moved to `roadmap/shipped/` when the feature is complete and all tests pass.

## Workflow

**Plan creation:** Plans can be created using any AI coding tool (Cursor, Antigravity, Windsurf, Claude Code, etc.) or manually. Once a plan is **locked and ready** for implementation, move it to `roadmap/pipeline/`:

```bash
git mv [source-location]/[name].plan.md roadmap/pipeline/[name].md
```

**Pipeline planning:** All active plans live in `roadmap/pipeline/`: these are debated, refined, and ready for implementation. This keeps all planned work in one place, regardless of the tool used to create it.

## Creating Plans with AI Coding Tools

You can create plan files using any AI coding tool (Cursor, Antigravity, Windsurf, Claude Code, etc.) or manually:

1. **Use the template**: Start with [`task-plan-template.md`](./task-plan-template.md): it provides a structured format with hints for each section
   - Prompt your AI tool: "Create a task plan using `roadmap/task-plan-template.md` for [feature name]"
   - Fill in each section with your tool's help
   - The template includes placeholders and hints to guide you

2. **Create a markdown file**: 
   - If your tool has a plan feature (like Cursor), use it: plans are typically created in tool-specific locations (e.g., `.cursor/plans/`)
   - If your tool doesn't have a plan mode, just **prompt the AI to create a markdown file** based on the template
   - You can also create markdown files manually with any editor

3. **Plan location**: 
   - **Best practice**: Create directly in `roadmap/pipeline/` to keep everything organized
   - If created in a tool-specific location (like `.cursor/plans/`), move it when ready:
     ```bash
     git mv [source-location]/[name].md roadmap/pipeline/[name].md
     ```

**Key point**: Don't worry if your tool doesn't have a special "plan mode": just prompt the AI to create a markdown file using the template, or create one manually. The important part is having a well-drafted plan document.

**When a plan is complete:**
1. Verify all tests pass (`npm test`)
2. Move plan to shipped: `git mv roadmap/pipeline/[name].md roadmap/shipped/`

**Including plan files in PRs:**
Plan MD files from AI coding tools (Cursor, Antigravity, etc.) are welcome in pull requests. These files serve as:
- **Supporting research**: Document the thought process and decisions made during implementation
- **Future context**: Help future contributors understand why certain approaches were chosen
- **Implementation history**: Provide valuable context for code reviews and maintenance

You can include plan files in PRs even if they're not yet moved to `roadmap/shipped/`: they add valuable context to the implementation.

**PRs for plans only:** Well-drafted plan files can be submitted as standalone PRs for review and discussion. This allows the team to debate and refine the approach before implementation begins. A good plan should include:
- Clear problem statement and goals
- Proposed solution approach
- Test strategy
- Edge cases and considerations
- Implementation steps

## Key Files

- **[task-plan-template.md](./task-plan-template.md)**: Template for creating new task plans (use this as a starting point)
- **[pipeline/](./pipeline/)**: Planned tasks and feature specifications
- **[shipped/](./shipped/)**: Completed plans (source of truth for shipped features)
