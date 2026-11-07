# Task: KaTeX Math Support

## 1. Task Metadata

- **Task name:** KaTeX Math Support
- **Slug:** katex-math
- **Status:** shipped in 0.4.0
- **Created:** 2025-11-29
- **Last updated:** 2025-11-29
- **Shipped:** 2026-10-01 (0.4.0)

---

## 2. Context & Problem

**Current state:**
- KaTeX library included in dependencies (package.json)
- Configuration option `enableMath` exists
- NO TipTap extension for rendering math
- Math equations `$...$` and `$$...$$` show as plain text
- Mentioned in README as feature but not implemented

**Pain points:**
- **STEM users blocked:** Scientists, engineers, mathematicians can't write equations
- **Academic writing limited:** Research papers, technical docs need math notation
- **README promise broken:** We advertise LaTeX support but don't deliver
- **User need:** Full KaTeX support is essential for academic writing and technical documentation
- **Half-done implementation:** Library installed but not integrated

**Why it matters:**
- **Essential for technical docs:** API docs, scientific papers, academic writing all need math
- **Standard feature:** Premium markdown editors all support math rendering
- **User expectation:** We list it as a feature, users expect it to work
- **Differentiation:** Free math support vs. paid alternatives
- **Already 80% there:** Library installed, just need TipTap integration

---

## 3. Desired Outcome & Scope

**Success criteria:**
- Inline math `$E = mc^2$` renders as formatted equation in WYSIWYG
- Display math `$$\int_0^\infty e^{-x^2}dx = \frac{\sqrt{\pi}}{2}$$` renders centered
- Click equation in WYSIWYG → edit LaTeX source
- Slash command `/math` inserts math block
- Toolbar button for inserting equations
- Error handling shows helpful messages for invalid LaTeX
- Works with all standard KaTeX functions and symbols
- `enableMath` setting actually enables/disables feature

**In scope:**
- **Inline math:**
  - Syntax: `$...$`
  - Renders inline with text
  - Click to edit LaTeX source
  - Examples: `$E=mc^2$`, `$\alpha + \beta = \gamma$`
- **Display math:**
  - Syntax: `$$...$$` (block level)
  - Renders centered on own line
  - Click to edit LaTeX source
  - Examples: `$$\int_0^\infty x^2 dx$$`
- **Slash commands:**
  - `/math` - Insert display math block
  - `/inline-math` or `/equation` - Insert inline math
- **Toolbar:** Math button with icon (∑ or 𝑓(𝑥))
- **Keyboard:** `Ctrl+Shift+E` for equation insertion
- **Editing:**
  - Double-click rendered equation → edit mode
  - Edit mode shows LaTeX source in input field
  - Live preview as you type (debounced)
  - Esc or click outside → save and render
- **Error handling:**
  - Invalid LaTeX shows error message with line number
  - Fallback: show LaTeX source if rendering fails
  - Link to KaTeX documentation for syntax help
- **Settings:**
  - `enableMath` - turn math rendering on/off
  - Math is enabled by default

**Out of scope:**
- Custom KaTeX macros/commands - use KaTeX defaults
- Math equation library/templates - future feature
- MathJax support - KaTeX only (faster, lighter)
- Chemical formulas (mhchem extension) - future feature
- Physics notation (physics extension) - future feature
- Equation numbering/labeling - future feature
- Math equation search - future feature

---

## 4. UX & Behavior

**Entry points:**
- **Manual:** Type `$...$` or `$$...$$` in editor
- **Slash command:** `/math` or `/equation`
- **Toolbar:** Math button (∑ icon)
- **Keyboard:** `Ctrl+Shift+E`

**User flows:**

### Flow 1: Insert inline math
1. User writing sentence: "Einstein's famous equation is "
2. User types `$E = mc^2$`
3. As user types closing `$`, equation renders: <math>E = mc²</math>
4. Cursor moves past equation, user continues typing

### Flow 2: Insert display math block
1. User presses `Ctrl+Shift+E` (or types `/math`)
2. Display math block inserted:
   ```
   $$
   [cursor here]
   $$
   ```
3. User types LaTeX:
   ```
   $$
   \int_0^\infty e^{-x^2}dx = \frac{\sqrt{\pi}}{2}
   $$
   ```
4. Renders as centered, formatted equation:
   <div style="text-align: center; font-size: 1.3em;">
   ∫₀^∞ e^(-x²)dx = √π/2
   </div>

### Flow 3: Edit existing equation
1. User sees rendered equation: <math>α + β = γ</math>
2. User double-clicks equation
3. Edit mode appears showing LaTeX source in text input:
   ```
   ┌───────────────────────────┐
   │ \alpha + \beta = \gamma   │ ← editable
   └───────────────────────────┘
   ```
4. User edits to: `\alpha + \beta + \theta = \gamma`
5. User presses Enter or clicks outside
6. Equation re-renders with changes

### Flow 4: Complex equation with fractions and Greek letters
1. User types display math:
   ```
   $$
   f(x) = \frac{1}{\sigma\sqrt{2\pi}} e^{-\frac{(x-\mu)^2}{2\sigma^2}}
   $$
   ```
2. Renders as properly formatted normal distribution formula:
   <div style="text-align: center;">
   f(x) = (1/(σ√(2π))) · e^(-(x-μ)²/(2σ²))
   </div>

### Flow 5: Error handling
1. User types invalid LaTeX:
   ```
   $$
   \frac{1}{0  ← missing closing brace
   $$
   ```
2. Editor shows error message:
   ```
   ┌─────────────────────────────────────┐
   │ ⚠️ LaTeX Error                      │
   │                                     │
   │ ParseError: Missing closing }       │
   │ at position 9                       │
   │                                     │
   │ \frac{1}{0                          │
   │          ^ here                     │
   │                                     │
   │ [View KaTeX Docs] [Edit Source]    │
   └─────────────────────────────────────┘
   ```
3. User clicks "Edit Source" → opens edit mode to fix error

### Flow 6: Multiple equations in document
1. User writes document with multiple equations:
   ```markdown
   The quadratic formula is $x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}$ where $a \neq 0$.

   Pythagorean theorem:
   $$
   a^2 + b^2 = c^2
   $$

   Euler's identity:
   $$
   e^{i\pi} + 1 = 0
   $$
   ```
2. All equations render correctly with appropriate spacing

### Flow 7: Source view
1. User toggles to source view
2. Sees raw LaTeX:
   ```markdown
   Einstein's equation: $E = mc^2$

   $$
   \int_0^\infty e^{-x^2}dx = \frac{\sqrt{\pi}}{2}
   $$
   ```
3. Syntax highlighting shows math delimiters distinctly
4. Toggle to WYSIWYG → equations render

### Flow 8: Disabling math rendering
1. User opens settings
2. Sets `markdownForHumans.enableMath: false`
3. Math equations show as plain text: `$E = mc^2$`
4. User re-enables → equations render again

**Behavior rules:**
- **Inline math:** Single `$` delimiters, renders inline with text
- **Display math:** Double `$$` delimiters, renders as centered block
- **Delimiter escaping:** `\$` renders literal dollar sign (not math)
- **Multiline support:** Display math can span multiple lines
- **Edit mode:**
  - Double-click or `Ctrl+Click` to edit
  - Esc or click outside saves
  - Enter saves (for single-line equations)
- **Live rendering:** As user types in edit mode, preview updates (debounced 300ms)
- **Error recovery:** Show LaTeX source if rendering fails
- **Performance:** Render equations on-demand, cache rendered SVG
- **Copy/paste:** Copying equation copies LaTeX source
- **Selection:** Can select and delete entire equation block

**Visual design:**
- **Inline math:**
  - Slightly larger than surrounding text (1.1x)
  - Vertical alignment matches baseline
  - Subtle background highlight on hover
  - Cursor changes to pointer on hover

- **Display math:**
  - Centered on page
  - 1.3x larger than inline
  - Extra padding above/below (1em)
  - Subtle background on hover

- **Edit mode:**
  - Input field with monospace font
  - Border highlighting active equation
  - Live preview below input (for display math)
  - "KaTeX" indicator showing it's math mode

- **Error display:**
  - Red border around failed equation
  - Error icon (⚠️)
  - Clear error message
  - Link to docs
  - Edit button to fix

**Edge cases:**
- **Empty math:** `$$` or `$$$$` renders as empty space (valid but useless)
- **Unclosed delimiter:** `$E = mc^2` (missing closing `$`) renders as literal text
- **Nested delimiters:** `$$$ ... $$$` invalid, shows error
- **Dollar amounts:** `$100` in text not treated as math (needs closing `$`)
- **Code blocks:** Math delimiters inside code blocks ignored (literal text)
- **Very long equations:** Horizontal scroll for equations wider than container
- **Special characters:** Handle Unicode, symbols, accents correctly

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

- Equation templates/library (common formulas)
- Equation numbering and labeling
- Chemical formulas (mhchem extension)
- Physics notation (physics package)
- Custom KaTeX macros
- Equation search and discovery
- Export handling (ensure equations work in PDF/HTML)
- Copy as image (PNG/SVG)
- Accessibility improvements (MathML output for screen readers)
- Auto-sizing for large equations
