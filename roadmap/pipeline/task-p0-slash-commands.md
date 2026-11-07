# Task: Slash Command System

## 1. Task Metadata

- **Task name:** Slash Command System
- **Slug:** slash-commands
- **Status:** backlog (math-only slash command exists; general `/` menu not built)
- **Created:** 2025-11-29
- **Last updated:** 2026-10-03
- **Shipped:** _(partial — `MathSlashCommand` only)_

---

## 2. Context & Problem

**Current state:**
- Math has a dedicated slash command (`src/webview/extensions/mathSlashCommand.ts`); no general `/` menu for other elements
- Users mostly type markdown syntax or use toolbar buttons (Mermaid templates via toolbar dropdown already shipped)
- No discoverability mechanism for the full feature set via keyboard
- Toolbar shows common formatting options but not everything

**Pain points:**
- **Slow creation:** Typing ` ```mermaid ` is slower than `/mermaid`
- **Low discoverability:** Users don't know what features are available (diagrams, tables, etc.)
- **Inconsistent UX:** Modern editors (Notion, Linear, Coda) all have slash commands
- **Toolbar limitations:** Can't fit all features in toolbar without clutter
- **Power user friction:** Experienced users want keyboard-driven workflows
- **Feature gap:** Slash commands provide quick access to formatting and content insertion

**Why it matters:**
- **Speed:** `/table` is faster than creating table manually
- **Discoverability:** Slash menu teaches users what's possible
- **Modern UX:** Expected feature in contemporary editors
- **Reduced cognitive load:** No need to remember markdown syntax
- **Accessibility:** Keyboard-driven alternative to toolbar clicking
- **Professional feel:** Polished UX that rivals paid tools

**Reference Implementation:**

Slash commands are a common pattern in modern editors, providing quick access to formatting and content insertion without leaving the keyboard.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Typing `/` in editor opens floating command menu
- Menu shows all available markdown insertion commands
- Filter-as-you-type narrows command list
- Keyboard navigation (arrow keys, Enter to execute)
- Commands insert appropriate markdown elements
- Menu appears <100ms after typing `/`
- Works on new lines and after whitespace
- Command descriptions help users understand what each does

**In scope:**
- **Slash trigger:** Type `/` → menu appears
- **Core commands:**
  - `/h1` through `/h6` - Insert headers
  - `/p` or `/paragraph` - Normal paragraph
  - `/list` or `/ul` - Bullet list
  - `/numbered` or `/ol` - Numbered list
  - `/todo` or `/task` - Task list with checkbox
  - `/quote` - Blockquote
  - `/code` - Code block
  - `/table` - Insert table (default 3x2)
  - `/image` - Insert image placeholder
  - `/link` - Insert link
  - `/divider` or `/hr` - Horizontal rule
  - `/diagram` or `/mermaid` - Mermaid diagram
  - `/math` - Math equation block
- **Command menu UI:**
  - Floating panel near cursor
  - Icons for each command
  - Descriptions (e.g., "Insert a bullet list")
  - Filter-as-you-type
  - Keyboard navigation
- **Keyboard shortcuts:**
  - Arrow keys navigate
  - Enter executes command
  - Esc closes menu
  - Tab autocompletes
- **Smart positioning:** Menu adjusts to avoid editor edges

**Out of scope:**
- Custom user-defined commands - future enhancement
- Nested slash commands (e.g., `/table/5x3`) - use parameters instead
- Slash commands with arguments (e.g., `/table 5x3`) - start simple
- Command autocomplete based on context - future AI feature
- Slash command history/favorites - future enhancement
- Premium/paid commands - everything free
- Commands for non-markdown actions (save, export) - separate feature

---

## 4. UX & Behavior

**Entry points:**
- **Primary:** Type `/` character in editor
- **Trigger context:**
  - Start of new line (after `\n`)
  - After whitespace (space, tab)
  - NOT mid-word (prevents false triggers in URLs, code)

**User flows:**

### Flow 1: Quick table insertion
1. User creates new line in document
2. User types `/`
3. Slash menu appears immediately showing all commands:
   ```
   🔍 /

   📝 /h1          Insert heading 1
   📝 /h2          Insert heading 2
   📝 /h3          Insert heading 3
   ─
   📋 /list        Insert bullet list
   📋 /numbered    Insert numbered list
   ☑️  /todo       Insert task list
   ─
   📊 /table       Insert table
   🖼️  /image      Insert image
   🔗 /link        Insert link
   ─
   📈 /diagram     Insert Mermaid diagram
   ∑  /math        Insert math equation
   💬 /quote       Insert blockquote
   ─
   📄 /code        Insert code block
   ➖ /divider     Insert horizontal rule
   ```
4. User types `tab` → menu filters to `/table`
5. User presses Enter
6. Table inserted at cursor:
   ```markdown
   | Header 1 | Header 2 | Header 3 |
   |----------|----------|----------|
   | Cell 1   | Cell 2   | Cell 3   |
   ```
7. Cursor positioned in first header cell

### Flow 2: Filtered search
1. User types `/di`
2. Menu filters to show only matching commands:
   ```
   🔍 /di

   📈 /diagram     Insert Mermaid diagram
   ➖ /divider     Insert horizontal rule
   ```
3. User presses Down arrow → highlights `/diagram`
4. User presses Enter → Mermaid block inserted

### Flow 3: Keyboard navigation
1. User types `/`
2. Menu appears with first item (`/h1`) highlighted
3. User presses Down arrow 3 times → `/list` highlighted
4. User presses Enter → bullet list inserted
5. Menu closes automatically

### Flow 4: Canceling slash command
1. User types `/` → menu appears
2. User changes mind, presses Esc
3. Menu closes, `/` remains as text
4. User can delete `/` or continue typing

### Flow 5: Header insertion with quick selection
1. User types `/h3`
2. Menu filters to show only `/h3`
3. User presses Enter (or Tab to autocomplete)
4. H3 header inserted: `### `
5. Cursor positioned after `### ` ready for title

### Flow 6: False trigger prevention
1. User typing URL: `https://example.com/page`
2. Slash menu does NOT appear (mid-word)
3. URL typed normally

### Flow 7: Command with template insertion
1. User types `/diagram` and presses Enter
2. Menu optionally shows sub-menu:
   ```
   Select diagram type:

   📊 Flowchart
   🔄 Sequence Diagram
   📅 Gantt Chart
   🥧 Pie Chart
   ⚙️  Empty Diagram
   ```
3. User selects "Flowchart"
4. Flowchart template inserted with sample code

**Behavior rules:**
- **Trigger timing:** Menu appears <100ms after `/` typed
- **Trigger context:** Only after whitespace or newline (not mid-word)
- **Filter speed:** Menu updates <50ms per keystroke
- **Case insensitive:** `/Table`, `/TABLE`, `/table` all match
- **Prefix matching:** `/di` matches `/diagram`, `/divider` (not substring)
- **Auto-dismiss:**
  - Menu closes after command executed
  - Menu closes on Esc
  - Menu closes if user clicks outside
  - Menu closes if user types non-matching character
- **Cursor positioning:** After insertion, cursor moves to logical editing position
- **Undo behavior:** Command insertion is single undo operation (Ctrl+Z removes entire insertion)
- **Menu positioning:**
  - Appears below cursor if room (300px height)
  - Appears above cursor if near bottom of editor
  - Stays within editor bounds (never off-screen)

**Command behaviors:**

| Command | Inserts | Cursor Position |
|---------|---------|-----------------|
| `/h1` - `/h6` | `# ` to `###### ` | After space |
| `/list` | `- ` | After space |
| `/numbered` | `1. ` | After space |
| `/todo` | `- [ ] ` | After space |
| `/quote` | `> ` | After space |
| `/code` | ` ```\n\n``` ` | Inside block |
| `/table` | 3x2 table | First header cell |
| `/image` | `![alt text](path)` | "alt text" selected |
| `/link` | `[text](url)` | "text" selected |
| `/divider` | `---` | New line after |
| `/diagram` | ` ```mermaid\n\n``` ` | Inside block |
| `/math` | `$$\n\n$$` | Inside block |

**Visual design:**
- **Menu panel:**
  - Width: 300px
  - Max height: 400px (scrollable if many commands)
  - Border radius: 6px
  - Shadow: Subtle elevation
  - Background: VS Code panel background
  - Border: VS Code border color

- **Command items:**
  - Height: 40px per item
  - Icon: 20x20px (left aligned)
  - Command text: Bold, 13px
  - Description: Regular, 11px, muted color
  - Hover: Background highlight
  - Selected: Stronger highlight + border accent

- **Filter input:**
  - Shows `/` + user's typed characters
  - Visual indicator of current filter
  - Clear button (X) to reset filter

**Edge cases:**
- **Empty line:** Slash works on completely empty line
- **Indented context:** Slash works at any indentation level
- **Inside lists:** Slash creates nested elements in lists
- **Inside tables:** Slash NOT triggered inside table cells (conflicts with alignment syntax)
- **Code blocks:** Slash NOT triggered inside code blocks (literal text)
- **Rapid typing:** Debounce filter updates to avoid lag
- **Large command list:** Virtual scrolling if 50+ commands

---

## 5. Technical Plan

_(To be filled during task refinement)_

---

## 6. Work Breakdown

_(To be filled during task refinement)_

---

## 7. Implementation Log

_(To be filled during implementation)_

---

## 8. Decisions & Tradeoffs

_(To be filled during implementation)_

---

## 9. Follow-up & Future Work

- Custom user-defined slash commands
- Slash commands with parameters (e.g., `/table 5x3`)
- Command history and favorites
- Context-aware command suggestions
- Nested command menus (categories)
- Command aliases (e.g., `/img` → `/image`)
- AI-powered command completion
- Slash command analytics (track usage, improve defaults)
- Template picker integration (e.g., `/diagram` → template gallery)
