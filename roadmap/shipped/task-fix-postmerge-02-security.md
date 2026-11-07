# Task: Fix security findings from post-merge review

## 1. Task Metadata

- **Task name:** Fix security findings
- **Slug:** fix-postmerge-02-security
- **Status:** shipped in 0.4.0
- **Created:** 2026-09-30
- **Last updated:** 2026-10-01
- **Shipped:** 2026-10-01 (0.4.0)
- **Base:** `origin/main` @ `1b8244b`
- **Overview:** `task-fix-postmerge-00-overview.md`

---

## 2. Context & Problem

The extension opens Markdown from cloned repos, which is untrusted input. Two paths let such a file reach resources or markup it should not.

---

## 3. Desired Outcome & Scope

**Success criteria:**
- PDF export never embeds an image the editor refused to show
- No host-derived string reaches `innerHTML`
- `npm test` passes

**In scope:** S1, S2
**Out of scope:** CSP redesign

---

## 4. Findings

### S1. MED (#101): PDF export embeds local files the editor refuses to show. Confirmed at code level.

- **Where:** `src/features/documentExport.ts:1234` (`preparePdfImageSources`), with `src/webview/extensions/customImage.ts:308`
- **Defect:** `preparePdfImageSources` copies the authored `data-markdown-src` back into `src` for every image, including images the host refused because they are outside the document and workspace roots. `sanitizeExportHtml` only blocks an explicit `file:` scheme; scheme-less paths resolve through `<base href="file://docDir/">`.
- **Scenario:** a hostile `.md` contains `<img src="/Users/victim/Pictures/id.png">` or a `../../../..` path. The editor shows a load error, but the exported PDF embeds the file, which leaks when the PDF is shared.
- **Possible escalation (unverified):** on Windows, `//host/x.png` resolves to a UNC `file://host/...` path, which could leak NTLM hashes.
- **Fix direction:** restore `src` only for images the host resolved inside allowed roots (reuse the existing containment check). Reject absolute paths, root-escaping relative paths and `//` prefixes.
- **Test first:** exported HTML for `/abs/x.png`, `../../../x.png`, `//host/x.png`, `%2E%2E/x.png` contains no loadable `src`; an in-root image still exports.

### S2. MED (#93): host error text rendered as HTML in a toast. Sink and flow confirmed; exact payload plausible.

- **Where:** `src/webview/features/feedbackReview.ts:5842-5848` forwards host `feedback.error` text as `feedbackLocalError`; `src/webview/editor.ts:2619` passes it to `showToast`; `src/webview/features/auditOverlay.ts:217` writes `toast.innerHTML = ... ${message}`.
- **Input sources:** host wraps raw lower-level errors, for example `src/editor/feedbackSessionStore.ts:4783` (`${context}: ${getErrorMessage(error)}`), `:3261`, `:4260` (JSON parse errors on `.md4h` draft metadata).
- **Scenario:** a crafted draft file in a cloned repo, or a file name containing `<`, produces an error message with markup that renders in the webview.
- **Impact limit:** CSP (`script-src 'nonce-...'`) blocks scripts. Markup injection and `https:` image beacons remain possible (`img-src https:` is allowed).
- **Note:** the sink predates #93; #93 added the host-derived input.
- **Fix direction:** build the toast with `textContent`; audit other `showToast` callers.
- **Test first:** `showToast('<img src=https://x/y>')` renders literal text and creates no `img` element.

---

## 5. Progress

| ID | Test | Fix | Verified |
|---|---|---|---|
| S1 | Written first, failed (export kept authored `src`; Word read `/etc/passwd` and `//host/x.png`) | Done | `npm test`, lint, tsc, `test:svg-browser` (real Chrome PDF), `test:integration` |
| S2 | Written first, failed (markup parsed in toast and 3 other sinks) | Done | `npm test`, lint, tsc, `test:integration` |

### Decisions

- **S1, one resolver for preview and export.** `resolveContainedImageSource` (exported from `MarkdownEditorProvider.ts`) now backs both `handleResolveImageUri` and export. `handleExportDocument` passes it to `exportDocument` as a required `resolveLocalImage` callback, bound to `getImageBasePath` and `getAllowedFileRoots`.
- **S1, Chrome never resolves the authored string.** `restrictExportImageSources` (in `documentExport.ts`) rewrites every local `img` to a segment-encoded URL relative to the export base, built from the host-vetted absolute path; refused images lose `src`, `srcset` and `data-markdown-src`. Reason: vetting the authored string and then letting Chrome resolve it is bypassable. Chrome's URL parser treats `\` as `/` and strips tabs and newlines, while Node on POSIX treats them as filename characters (test: backslash traversal).
- **S1, Word export included.** The same pass runs before both exporters. Word export had the same defect and a worse one: it read absolute and `../` paths with `fs.readFileSync` and embedded the bytes. Flagged for review as a scope extension.
- **S1, Windows UNC.** `path.win32.resolve('C:\\docs', '//host/x.png')` is `\\host\x.png\`, outside every drive root, so it is refused. Even a contained UNC root cannot leak to another host. A cross-share or cross-drive relative path is absolute, and absolute results fail closed. `file://host/share/x.png` becomes the relative `host/share/x.png` under the document folder (same as the preview).
- **S1, behaviour change.** In-root sources are emitted canonically (`./a.png` becomes `a.png`). A `file:` URL inside the root now exports, since the preview shows it. `javascript:x` exports as the relative file name `javascript%3Ax`, matching the preview.
- **S2, sink fixes.** `showToast` builds its icon and message with `textContent`, so every caller is safe. Audit of all `innerHTML` sinks in `src/webview` with non-constant input found three more, all fixed:
  - `linkDialog.ts` `escapeHtml` left `"` raw inside `title="..."`. Workspace file names and document headings could add attributes.
  - `imageConfirmation.ts` put `markdownForHumans.imagePath`, a workspace setting a cloned repo controls, into `value="..."`.
  - `localImageOutsideRepoDialog.ts` put the host absolute image path and folder into markup.
- **S2, safe sinks (no change).**
  - Numbers only: `hugeImageDialog`, `auditOverlay` count.
  - Already escaped text content: `imageMetadata`.
  - Library output: KaTeX `renderToString` (trust off), Mermaid (`securityLevel: 'strict'`).
  - Inert parsing: `htmlImageSource` uses a `<template>`.
  - Constants: all the rest.
- **S2, residual (needs a decision).** `src/webview/editor.ts` `initializeEditor` catch writes `error.message` into `innerHTML`. ProseMirror `Invalid content` errors include up to 50 chars of document text. This was not fixed: the only test harness (`feedbackEditorMessageBoundary.test.ts`) mocks the whole editor module graph, and a test-first fix there is heavier than this task. The fix is a 3-line `textContent` change.

- **Word export drops in-root images (pre-existing, not S1).** Manual QA found no `word/media` in the .docx. A probe ran the 6412d17 and branch exporters on the same files. With the real editor DOM (`span.image-wrapper > img`), neither version wrote media: `parseParagraphChildren` only handles an `img` that is a direct child of the paragraph. With a bare `img`, both wrote `word/media/<hash>.undefined`, because docx 9 `ImageRun` needs an explicit `type`. Tracked as `it.todo('embeds an in-root image in Word export')`. Fixing it is a separate Word-export task.

### Tests

- `src/__tests__/features/documentExportPdfImages.test.ts` > `local image containment (S1)`
  - `exports no loadable src for %s the preview refuses`. Cases: absolute path, `../../../x.png`, `//host/x.png`, `%2E%2E` traversal, backslash traversal, out-of-root `file:` URL. Each case runs in both `data-markdown-src` and raw `src` form.
  - `still exports an in-root image at its exact file URL`
  - `exports a parent-directory image that stays inside a broader allowed root`
  - `never reads a refused image from disk for Word export`
  - Updated: expected canonical `src` values in two existing cases. The `javascript:` case now asserts the encoded relative name.
- `src/__tests__/editor/imageHandlerPathContainment.test.ts` > `handleExportDocument gives export the same containment resolver as the preview`
- `src/__tests__/webview/auditOverlay.test.ts` > `renders host error text literally instead of parsing it as markup (#93)`, `renders a first keyed Feedback error literally as well`
- `src/__tests__/webview/linkDialog.test.ts` > `keeps quotes in workspace file names inside the title attribute`
- `src/__tests__/webview/localImageOutsideRepoDialog.test.ts` > `shows host path and folder text literally, without markup or attribute injection`
- `src/__tests__/webview/imageConfirmationDialog.test.ts` (new) > `prefills a workspace-configured folder as a value, not markup`
- `scripts/svg-image-fixture/pdf-export.mjs` now passes a containment resolver to `exportDocument`. The real-Chrome PDF check still draws the encoded `#`/query/fragment SVG.

### Review fix round

| ID | Outcome | Test | Mutation check |
|---|---|---|---|
| 02-F2 (symlink escape) | Fixed | `pathContainment.test.ts` > `resolveContainedImageSource follows symlinks (02-F2)` (5 cases; skipped on Windows, where symlinks need extra rights) | Removing the real-path branch fails 3 escape cases; comparing real target against lexical roots fails the 2 in-root accept cases (`/var` is a symlink on macOS, plus an explicit linked root) |
| 02-F3 (non-img local loads) | Fixed | `documentExportPdfImages.test.ts` > `local resources outside img (02-F3)`: `exports no local resource load through %s` (12 cases) and `keeps fragment, remote and embedded references and document links` | Removing the pass fails all 12; removing escape decoding fails the `\75 rl(` case; removing the `image-set`/`@import` rule, the `<style>` pass, or the URL-attribute rule fails 2, 2 and 5 cases; dropping the anchor exclusion or treating `#` fragments as local fails the keep case |
| 02-F1 (http:// in PDF) | Not changed: product decision | None | Not applicable |

- **02-F2.** `resolveContainedImageSource` keeps the lexical check first (realpath never touches a refused UNC path; see round 3 for the `?`/`#` caveat), then, for an existing file, requires `fs.realpathSync(target)` to sit inside the real path of an allowed root. A missing file keeps the lexical decision, since it loads nothing. The returned `absolutePath` stays lexical, so preview URIs and export URLs are unchanged for legitimate in-root symlinks. Preview and export share the resolver, so both are covered.
- **02-F3.** `restrictExportImageSources` now ends with `dropLocalResourceLoads`, before either exporter. It removes any CSS attribute (narrowed in round 3, 02-R1) whose CSS has a local `url()`, or any `image-set()` or `@import` (both take bare strings), with CSS escapes decoded first. It removes a `<style>` element with the same content, and a local `href`, `xlink:href` or `background` on any element except `a`/`area` links. Fragment (`#id`) and direct sources (`data:`, `blob:`, `http(s):`) stay, so Mermaid markers and gradients still render. Reason: the preview resolves these against the webview origin, so it never shows a local file through them. Blocking all local values matches the img rule (export embeds nothing the editor refused). The webview `exportContent.ts` fallback is unchanged; the host is the boundary.

### Review fix round 3

Iteration 1. All tests are in `documentExportPdfImages.test.ts` > `local resources outside img (02-F3)` unless noted.

| ID | Outcome | Test | Mutation check |
|---|---|---|---|
| 02-R1 (CSS check on every attribute) | Fixed | `checks only CSS contexts, so data: SVG images, link targets and text survive (02-R1)`; new cases `the other url() presentation attributes` and `SVG animation values` | Failed first on the old code (`img` src undefined). Restoring the old file fails it again. Variants that run the CSS check on `alt`, `title`, `image` href or link `href` each fail it. Removing any one of the 14 `CSS_ATTRIBUTES` entries fails a drop case (`style` fails 6) |
| 02-R2 (lowercasing untested) | Test added | `an uppercase URL()`, `an uppercase <style> @IMPORT`, `an uppercase IMAGE-SET()` | Removing `.toLowerCase()` fails all 3 |
| 02-R3 (lexical-first order untested) | Test added; comment corrected | `pathContainment.test.ts` > `resolveContainedImageSource refuses lexically before resolving symlinks (02-R3)` (3 cases, all platforms) | Calling `realPathOrUndefined(absolutePath)` before the lexical return fails all 3 |
| 02-R4 (code-point clamp untested) | Test added | `decodes an out-of-range CSS escape without failing the export (02-R4)` | Removing the clamp fails it with `RangeError: Invalid code point 1114112` |
| 02-R5 (quote skipping untested) | Test added | `keeps quoted fragment and remote url() references (02-R5)` | Removing `['"]?` fails it (`<style>` emptied, attributes dropped) |

- **02-R1.** `dropLocalResourceLoads` now runs the CSS check only on `CSS_ATTRIBUTES`: `style`; the SVG presentation attributes that take `url()` (`fill`, `stroke`, `marker-start`, `marker-mid`, `marker-end`, `clip-path`, `mask`, `filter`, `cursor`); and the SMIL value attributes `to`, `from`, `by` and `values`, which can set those properties. The URL-attribute rule is unchanged. Reason: `src`, `alt`, `title` and link `href` are not CSS. A `url(%23g)` inside a data: SVG, or `@import` in an MDN link, loads nothing, yet round 2 dropped them from PDF and Word. The SMIL entries keep the `<set attributeName="mask" to="url(/x.png)">` case that round 2 caught only because it checked every attribute.
- **02-R3.** The test spies on `fs.realpathSync` (the default `fs` import is the real module object; `import * as fs` cannot be spied on under ts-jest). The guarantee is narrower than round 2 said. `normalizeImagePath` runs before the lexical check, and its `splitLocalImageSource` calls `existsSync` on the literal name of a `?`/`#`-suffixed source, even a refused one. A probe showed `existsSync('/etc/hosts?v=1')` for `../../../../etc/hosts?v=1`. This predates this task: HEAD's preview resolver did the same. The inline comment now states the narrower guarantee; the residual is listed below.

### Decisions for the user

- **02-F1, http:// images in PDF export (pre-existing). Resolved by decision #5; see Decisions applied.** The preview CSP (`img-src ${webview.cspSource} https: data: blob:`) refuses `http:` images, but export treats `http://` as a direct source, so headless Chrome fetches it (loopback and LAN hosts included) and prints it into the PDF. This breaks the literal S1 criterion for http-only hosts; https intranet hosts already match the preview. Not changed: whether export should mirror the preview CSP and drop `http:` sources (losing http images that some users may expect in PDFs) is a product call. The new non-img pass treats `http:` the same way as `img`, so one decision covers both. A fix would narrow `DIRECT_IMAGE_SOURCE` to `https://` and update `keeps raster, HTTPS and embedded sources`.
- **Follow-up, symlinks in the other image handlers.** The rename, resize, reveal and metadata handlers still repeat the lexical `isPathContainedWithin` check (10 call sites). The file-writing ones matter most. Out of scope here; the `ImagePathPolicy` extraction in the refactor notes is the natural place.
- **Round 3, `existsSync` on refused suffixed sources (pre-existing).** `splitLocalImageSource` stats the literal name of any `?`/`#`-suffixed local source before containment is checked. On Windows, `\\host\share\x.png#x` skips its `//` guard, so the stat is an SMB lookup. Preview and export both reach it. A fix would check the literal candidate lexically before the stat; it changes shared path code used by every image handler, so it was left for a decision.
- **Round 3, SMIL `href` animation (never covered).** `<image><set attributeName="href" to="/x.png"></set></image>` keeps its `to` value, because the value is a bare path, not CSS. Not verified in real Chrome this round. Options: drop `set`/`animate*` elements from export, or treat their values as URL attributes when `attributeName` is `href`.
- **Round 3, quoted data: SVG inside CSS (fail-closed, pre-existing since round 2).** `style="background:url(&quot;data:image/svg+xml,...url(%23g)...&quot;)"` is dropped, because the scan finds the inner `url(%23g)`. A regex that skips quoted strings would fix it, but opens a bypass: in `a:'url("#' ; b:url(/x.png) ; c:'")'` the regex would swallow `b`. A real fix needs a CSS tokenizer. Left as is.

### Decisions applied

| Item | Outcome | Test | Mutation check |
|---|---|---|---|
| #5 (02-F1): PDF and Word export drop `http:` images, matching the preview CSP | Done | `documentExportPdfImages.test.ts` > `http: sources, matching the preview CSP (decision #5)`: `drops %s like a refused local image, keeping its alt` (`http:`, `HTTP:`, protocol-relative `//host`; each in `data-markdown-src` and raw `src` form) and `exports no http: load outside img through %s` (5 cases). Updated: `keeps raster, HTTPS, data: and blob: sources and removes source-less editor separators` (adds a `blob:` source) | Restoring `https?` in `DIRECT_IMAGE_SOURCE` fails 5 (the `http:` img case and 4 non-img cases). Disabling the `HTTP_IMAGE_SOURCE` check fails the `http:` and `HTTP:` img cases (both export as in-root names such as `http%3A/...`). Dropping its `i` flag fails the `HTTP:` case. Dropping `blob:` fails the keep test. Treating `//` as direct fails both protocol-relative cases plus 2 S1 cases |

- **#5, rule.** `DIRECT_IMAGE_SOURCE` admits `https://` but no longer `http://`; `data:`, `blob:` and `vscode-webview://` are unchanged. An `img` whose source starts with `http:` in any letter case skips the resolver and loses `src`, like a refused local image; `alt` stays. Reason for the skip: the resolver reads `http://host/x.png` as the in-root relative file `http:/host/x.png`, so without it export would keep a local `src` that the preview never resolves.
- **#5, non-img pass.** No new code. `isLocalReference` already drops anything that is neither a fragment nor a direct source, and it lowercases first, so `url(http://...)`, `url('HTTP://...')`, `<style>` `url(http://...)` and SVG `href="http://..."` now go too.
- **#5, test first.** 6 of the 8 new cases failed on the old code: the `http:` img kept `http://...`, the `HTTP:` img exported `HTTP%3A/...`, and 4 non-img cases kept the load. The 2 protocol-relative cases already passed (S1 refuses `//host`); they guard that refusal under the new rule.
- **#5, preview parity.** An uppercase `HTTPS://` img stays a document-relative local name, as in the preview (`customImage.ts` matches lowercase prefixes only). In CSS and SVG `href` it stays a remote load, which the preview CSP also allows.
- **#5, not changed.** The Word image branch still tests `http://` before skipping remote images; that arm is now unreachable for `http:` and still handles `https:`. `README.md` (PDF export line) and `KNOWN_ISSUES.md` (PDF and Word Export) do not mention that `http:` images are dropped; left for the docs owner.

---

## 6. Refactor notes

- **`src/features/documentExport.ts` (~1.96k lines)**
  - Mixes five concerns:
    - bounded image-dimension parsers (lines ~25-730)
    - HTML sanitization
    - Chrome discovery, validation and prompts (~300 lines)
    - PDF printing
    - HTML-to-docx conversion (cheerio walk with `any`-typed docx)
  - Candidate extractions: `exportImageDimensions.ts` (pure, already tested on its own), `chromeLocator.ts`, `docxConverter.ts`. Keep `exportDocument` as a thin orchestrator.
  - Pattern: **Strategy** per format (`PdfExporter`, `DocxExporter` behind one `export(html, ctx)` interface). Both formats already share the pre-pass (`restrictExportImageSources`) and the base path, and differ only in rendering.
  - The Word image branch still has dead `vscode-webview://` comments and its own `decodeURIComponent` resolution. It could consume the resolver result directly instead of re-deriving the path.
- **`src/editor/MarkdownEditorProvider.ts` (~11.5k lines)**
  - A god class: webview HTML, a ~48-case message switch, document sync, image I/O (resolve, rename, resize, backups, metadata, reveal), export, link search, and the Feedback session.
  - The image-path guard `getAllowedFileRoots` plus `isPathContainedWithin` is repeated in 11 handlers.
  - Candidate extractions: an `ImagePathPolicy` (base path, allowed roots, `resolveContainedImageSource`) injected into the handlers, and an `ImageFileService` for the rename, resize and backup handlers.
  - Pattern: a **Command/handler registry** keyed by message type, replacing the switch, with each handler in its own module.
- **`src/webview/editor.ts` (~3k lines)**: initialization, host message dispatch, window event wiring for toolbar features, and test hooks live together. Candidates: move the toolbar `window.addEventListener` blocks (export, audit, math, TOC) into a `toolbarCommands.ts`, and the host message switch into a dispatcher module. Pattern: **Mediator** between the toolbar events and the editor and host.
- **`src/webview/features/linkDialog.ts` (~1.3k lines)**: markup is built with template strings plus a local `escapeHtml`. The dialog shell, link-range adjustment, file search and heading autocomplete are in one module. Candidates: an `autocompleteList.ts` that renders rows with DOM APIs (no escaping needed), and the link-range helpers as pure functions. Pattern: a small **View** component per dropdown mode.
