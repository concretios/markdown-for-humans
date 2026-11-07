# Task: Frontmatter Support

## 1. Task Metadata

- **Task name:** Frontmatter Support
- **Slug:** frontmatter
- **Status:** backlog (basic wrap/unwrap + dirty-state fix already shipped; remaining = richer metadata UX)
- **Created:** 2025-11-29
- **Last updated:** 2026-10-03
- **Shipped:** _(partial — see `roadmap/shipped/task-frontmatter-dirty-state-fix.md`)_

---

## 2. Context & Problem

**Current state:**
- YAML frontmatter is wrapped as a fenced `yaml` code block for WYSIWYG (not raw plain text); save unwraps back to `---` delimiters
- No special parsing or rendering of metadata fields (title/date/tags as structured UI)
- Frontmatter is visually distinguished as a code block, but not as blog-style title/metadata chrome
- Users from Jekyll, Hugo, Gatsby workflows get round-trip preservation, not rich frontmatter editing

**Pain points:**
- **Static site generator users:** Jekyll, Hugo, Gatsby, Docusaurus all use frontmatter
- **Blog writers:** Metadata (title, date, tags) essential for blog posts
- **Visual clutter:** YAML syntax visible in reading mode, breaks immersion
- **No structure:** Title, date, tags show as unformatted text
- **User need:** Displaying frontmatter title as H1 with metadata as subtext improves document structure

**Why it matters:**
- **Static site compatibility:** Huge user base (Jekyll/Hugo/Gatsby/11ty)
- **Professional blogging:** Metadata essential for content management
- **Clean reading:** Frontmatter should enhance, not clutter, the reading experience
- **Future features:** Frontmatter enables filtering, sorting, search enhancements
- **Standard practice:** Almost all markdown-based publishing uses frontmatter

---

## 3. Desired Outcome & Scope

**Success criteria:**
- YAML frontmatter between `---` delimiters parsed and rendered specially
- Title field displays as page title (H1-style) at top
- Created/date field displays as subtitle under title
- Tags/categories rendered as visual pills
- Other frontmatter fields hidden by default (expandable)
- Click to edit frontmatter in structured form
- Source view shows raw YAML
- Works with all static site generators (Jekyll, Hugo, Gatsby, etc.)

**In scope:**
- **Frontmatter syntax:**
  - YAML between `---` delimiters at document start
  - Support standard fields: title, date, author, tags, categories
  - Custom fields stored but hidden by default
- **Visual rendering:**
  - Title → Display as large H0-style heading (larger than H1)
  - Date/created → Subtitle format (gray, smaller text)
  - Author → Byline ("By John Doe")
  - Tags → Colorful pills with icons
  - Categories → Similar to tags, different color
  - Custom fields → Hidden, expandable section
- **Editing:**
  - Click frontmatter area → opens structured editor
  - Form fields for standard properties (title, date, etc.)
  - Text area for custom YAML
  - Validate YAML on save
- **Slash command:** `/frontmatter` inserts template
- **Settings:**
  - Toggle frontmatter rendering on/off
  - Default frontmatter template
  - Show/hide specific fields

**Out of scope:**
- TOML or JSON frontmatter - YAML only
- Frontmatter autocomplete (suggest tags, etc.) - future feature
- Frontmatter inheritance (from parent files) - future feature
- Advanced YAML features (anchors, references) - keep simple
- Frontmatter in middle of document - must be at start
- Multi-document frontmatter operations - single file only

---

## 4. UX & Behavior

**Entry points:**
- **Manual:** Type `---` at document start, add YAML, close with `---`
- **Slash command:** `/frontmatter` inserts template
- **Click:** Click rendered frontmatter to edit
- **Source view:** Edit raw YAML directly

**User flows:**

### Flow 1: Document with frontmatter renders beautifully
1. User opens markdown file:
   ```yaml
   ---
   title: Getting Started with Markdown for Humans
   date: 2025-11-29
   author: John Doe
   tags: [tutorial, beginner, markdown]
   categories: [documentation]
   ---

   ## Introduction

   Welcome to the guide...
   ```

2. In WYSIWYG mode, renders as:
   ```
   ┌─────────────────────────────────────────────┐
   │                                             │
   │   Getting Started with Markdown for Humans  │  ← Large title
   │   November 29, 2025 · By John Doe           │  ← Subtitle + byline
   │                                             │
   │   🏷️ tutorial  🏷️ beginner  🏷️ markdown    │  ← Tags as pills
   │   📁 documentation                          │  ← Category
   │                                             │
   │   ⋮⋮ (click to edit metadata)               │  ← Expandable
   │                                             │
   └─────────────────────────────────────────────┘

   Introduction                                    ← H2, actual content starts
   ────────────
   Welcome to the guide...
   ```

### Flow 2: Insert frontmatter template
1. User creates new markdown file
2. User types `/frontmatter`
3. Template inserted at cursor (which should be at document start):
   ```yaml
   ---
   title: Untitled Document
   date: 2025-11-29
   author:
   tags: []
   ---
   ```
4. Cursor positioned in `title` field
5. User fills in metadata

### Flow 3: Edit frontmatter visually
1. User sees rendered frontmatter area
2. User clicks "⋮⋮ (click to edit metadata)" or clicks title
3. Frontmatter editor modal appears:
   ```
   ┌─────────────────────────────────────────┐
   │  Edit Document Metadata                 │
   ├─────────────────────────────────────────┤
   │                                         │
   │  Title:                                 │
   │  [Getting Started with MD for Humans  ] │
   │                                         │
   │  Date:                                  │
   │  [2025-11-29] 📅                        │
   │                                         │
   │  Author:                                │
   │  [John Doe                            ] │
   │                                         │
   │  Tags: (comma-separated)                │
   │  [tutorial, beginner, markdown        ] │
   │                                         │
   │  Categories:                            │
   │  [documentation                       ] │
   │                                         │
   │  ▼ Advanced (custom YAML)               │
   │                                         │
   │  [Save] [Cancel]                        │
   └─────────────────────────────────────────┘
   ```
4. User edits title, clicks Save
5. Frontmatter updates, re-renders

### Flow 4: Custom frontmatter fields
1. User has frontmatter with custom fields:
   ```yaml
   ---
   title: My Post
   date: 2025-11-29
   custom_field: some value
   seo_description: This is for SEO
   featured: true
   ---
   ```
2. Renders as:
   ```
   My Post
   November 29, 2025

   ⋮ 3 more fields (click to expand)
   ```
3. User clicks "3 more fields"
4. Expands to show:
   ```
   custom_field: some value
   seo_description: This is for SEO
   featured: true
   ```
5. User can edit these in advanced section of editor

### Flow 5: Source view
1. User toggles to source view
2. Sees raw YAML:
   ```yaml
   ---
   title: My Post
   date: 2025-11-29
   tags: [tutorial]
   ---

   ## Content starts here
   ```
3. Syntax highlighting shows YAML distinctly
4. User can edit YAML directly
5. Toggle to WYSIWYG → renders prettily

### Flow 6: Invalid YAML handling
1. User manually edits frontmatter in source view:
   ```yaml
   ---
   title: My Post
   date: 2025-11-29
   tags: [unclosed
   ---
   ```
2. Switches to WYSIWYG
3. Frontmatter shows error:
   ```
   ⚠️ Frontmatter Error

   Invalid YAML syntax:
   Line 3: Unclosed bracket in tags

   [Edit Source] [Clear Frontmatter]
   ```
4. User clicks "Edit Source" → jumps to frontmatter in source view

### Flow 7: No frontmatter
1. User creates document without frontmatter
2. Just starts writing:
   ```markdown
   ## My Document

   Content here...
   ```
3. No frontmatter area shown (clean, normal document)
4. User can add frontmatter later via `/frontmatter`

**Behavior rules:**
- **Position:** Frontmatter MUST be first thing in document (before any content)
- **Delimiters:** Must use `---` (three hyphens) on separate lines
- **YAML validation:** Validate on parse, show errors if invalid
- **Field rendering priority:**
  1. Title → Large heading
  2. Date → Subtitle  3. Author → Byline
  4. Tags/Categories → Pills
  5. Everything else → Hidden by default
- **Date formatting:** Parse common formats (YYYY-MM-DD, ISO 8601)
- **Empty frontmatter:** `---\n---` (empty) valid but hidden
- **Source compatibility:** Raw YAML preserved exactly (no reformatting)
- **Export:** Include/exclude frontmatter based on export format

**Visual design:**
- **Frontmatter area:**
  - Background: Subtle tint (5% gray)
  - Border: 1px bottom border to separate from content
  - Padding: 32px vertical, 48px horizontal
  - Border-radius: 8px top corners (if not at document start)

- **Title field:**
  - Font size: 2.5em (larger than H1)
  - Font weight: 700 (bold)
  - Line height: 1.2
  - Margin bottom: 16px

- **Date/author:**
  - Font size: 0.9em
  - Color: Muted (60% opacity)
  - Style: "November 29, 2025 · By John Doe"
  - Margin bottom: 16px

- **Tags/categories:**
  - Style: Rounded pills
  - Background: Light color (blue/green/purple tints)
  - Border: 1px solid darker shade
  - Padding: 4px 12px
  - Icon: 🏷️ for tags, 📁 for categories
  - Spacing: 8px between pills

- **Expand/collapse:**
  - Icon: ⋮⋮ (six dots)
  - Text: "(click to edit metadata)"
  - Hover: Underline
  - Cursor: Pointer

**Edge cases:**
- **Frontmatter mid-document:** Render as code block (invalid placement)
- **Multiple frontmatter blocks:** Only first one counts
- **Very long title:** Wrap to multiple lines (don't truncate)
- **Missing required fields:** Title defaults to filename, date to file creation date
- **Array values:** Tags/categories accept YAML arrays or comma-separated strings
- **Special characters:** Handle quotes, colons, newlines in YAML correctly
- **Empty title:** Show "(Untitled)" placeholder
- **Future dates:** Date in future still displays (no validation)

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

- TOML and JSON frontmatter support
- Frontmatter autocomplete (suggest existing tags)
- Frontmatter inheritance (from parent directories)
- Advanced YAML features (anchors, multi-line strings)
- Frontmatter templates (blog post, documentation, etc.)
- Frontmatter validation schemas (JSON Schema)
- Frontmatter-based file organization (sort by date, filter by tag)
- Export handling (strip frontmatter for plain markdown, preserve for static sites)
- Custom field types (date picker, tag autocomplete, etc.)
- Multi-document frontmatter operations (bulk edit)
