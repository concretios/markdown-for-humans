# SVG image browser fixture

Run the production `CustomImage`, image Markdown serializer, editor CSS, export-content collector, Feedback anchor helpers, and Feedback screenshot adapter in an isolated headless Chrome profile:

```sh
npm run test:svg-browser
```

Use `MD4H_CHROME_BINARY` for another Chrome executable. The default is the macOS Google Chrome application. Node must provide the built-in `fetch` and `WebSocket` APIs. No browser package or remote account is needed. CI runs this gate on Linux with Node 24 and `/usr/bin/google-chrome`.

The fixture covers viewBox-only, percentage-size, explicit-size, icon, raster, HTML-sized, malformed, missing, and scripted SVG images. It checks light, dark, and high-contrast themes at wide and narrow viewport widths, including 2x DPI; aspect ratio and overflow; title/size/source round trips; image selection, delete, and undo; hover menus; visible load errors; Feedback anchor mapping; and export HTML dimensions. Display size is exercised through its real menu/dialog, including invalid input, focus, Escape, apply, undo/redo, and reset. SVG scripts must not run. Capture uses a VS Code-style image-resource hostname mapped to the local fixture server and verifies a known pixel color through the production Feedback rasterizer.

Sizing regressions also use the production paragraph extensions and sync serializer with both blank-line modes. After applying Display size to the first inline SVG, two save/reopen cycles must retain subsequent images, hard breaks and bold/link/code content, including list and table contexts. Undo, redo and reset must preserve the same neighboring content.

The production `exportDocument` PDF path also runs against real local Chrome. Its input comes from the production export-content collector. A local SVG has a percent-encoded filename plus query and fragment, and its source directory contains spaces, `#`, `&`, and quotes. The generated PDF must contain the known SVG rectangle and both expected drawing colors. The print process must exit naturally with code zero and the exporter must issue its completed notification. VS Code dialogs, configuration, and external PDF opening use isolated adapters. The fixture passes the production executable, arguments, and stdio unchanged. Production creates a temporary incognito profile and removes it after printing.

Screenshots, the JSON result, a capture PNG, `fixture.pdf` (browser print), and `production-export.pdf` (production exporter) are created in an OS temporary directory. Set `MD4H_KEEP_FIXTURE=1` to retain them for inspection. PDF drawing and `commandCompleted` must both pass. Timeout fails the test even when a PDF exists; cleanup terminates and reaps only fixture-owned children before releasing the adapters. Inspect a rendered PDF page separately for print appearance.

The isolated PDF profile does not inherit the user's Chrome login cookies. Images requiring that existing session are not covered. This fixture also does not verify the native export dialogs or cancellation of an in-flight print process.

An optional private deck can be checked without copying it into the repository:

```sh
MD4H_KEEP_FIXTURE=1 MD4H_SVG_PRIVATE_DIR=/absolute/path/to/private-copy npm run test:svg-browser
```

That directory must contain `deck-1-overview.md` and its `images/` files. Private files are read only, with hashes checked before and after. Only layout metrics appear in results, and no private asset or document is saved under this repository. Full private-deck round-trip and anchor-map diagnostics are observational because the fixture does not register every production editor extension or interpret Marp frontmatter.

This browser fixture does not exercise the VS Code extension host, actual `asWebviewUri` transport, CSP enforcement, native picker/clipboard behavior, split-view document synchronization, or real user keyboard/mouse targeting. Those require the existing host tests and a separate Extension Development Host QA pass.
