# Task: SVG diagrams fill the reading column

## 1. Task Metadata

- **Task name:** SVG column display size
- **Slug:** svg-column-display-size
- **Status:** shipped
- **Created:** 2026-10-01
- **Last updated:** 2026-10-01
- **Shipped:** _(pending)_

---

## 2. Context & Problem

**Current state:**
- Local SVGs render through an `<img>` in `CustomImage`. The wrapper is `width: fit-content` with `max-width: 100%` on the image.
- Deck diagrams such as `deck-2-driver-ports.svg` are viewBox-only (`viewBox="0 0 1280 674"`, no width or height).
- Chrome lays that kind of SVG out at the containing-block width, which is what the built-in Markdown preview shows. `naturalWidth` still reports the 300×150 default object size.
- On load, the editor copied `naturalWidth` onto the image to stop the shrink-to-fit wrapper collapsing to 0. That locked every unsized diagram at roughly 150–300px. Display size was required before the figure was readable.

**Pain points:**
- **Tiny diagrams:** A 1280-wide figure is scaled into the default object size, so labels are unreadable.
- **Manual recovery:** Display size can enlarge one occurrence, but the file was already valid and the built-in preview needed no edit.
- **Marp alt text is not a width:** `![w:960](...)` stays alt text. The preview does not read it either, so matching the preview means matching column layout, not parsing `w:`.

**Why it matters:**
- These figures are the reading content. A diagram that requires a per-image width edit fails the reading-first bar.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- An unsized viewBox-only or percentage SVG fills the editor column and keeps its aspect ratio, at wide and narrow widths.
- A concrete SVG width (24, 100×150, 640, 2000, `pt`) stays at that intrinsic size, then shrinks only when the column is narrower.
- An authored HTML `width` stays authored. Reset returns to the column. Markdown for an unsized image does not gain a width.
- Rasters are unchanged. Icons are not enlarged.

**In scope:**
- View-only layout in `CustomImage` and `.image-fluid-svg`.
- Unit coverage plus the real Chrome SVG fixture, including the private deck-2 file when `MD4H_SVG_PRIVATE_DIR` is set.

**Out of scope:**
- Interpreting Marp `w:` alt text.
- Writing a default width into the document.
- Committing the private deck or its SVGs.

---

## 4. UX & Behavior

Unsized SVG images use the reading column as soon as they decode. Concrete and authored sizes stay put. Display size remains the control for a custom width, and that width is still the only size stored in the document.

---

## 5. Implementation notes

Measure the decoded SVG in an 800px block outside the shrink-to-fit wrapper. If that laid-out width is greater than `naturalWidth`, the image has no concrete intrinsic width: add `image-fluid-svg` and an aspect ratio taken from the decoded size. Otherwise set the view-only width attribute to the intrinsic size, which also covers a failed measurement so the wrapper cannot collapse to zero.
