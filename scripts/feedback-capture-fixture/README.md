# Feedback capture Electron fixture

This fixture validates the production Feedback capture adapter with
`modern-screenshot@4.7.0` in a real Electron renderer at
100%, 125%, and 200% zoom across light, dark, and high-contrast themes. It uses
the Electron version bundled with the locally installed VS Code so the Chromium
behavior matches the extension host target.

Run from the repository root:

```sh
node scripts/feedback-capture-fixture/run.mjs
```

The packaged VS Code executable cannot load an arbitrary app because its signed
helpers and ASAR integrity metadata are bound to VS Code. The runner detects that
runtime's exact Electron version, then starts the corresponding published Electron
binary with `npx`. This keeps Electron out of the project's dependencies. Set
`MD4H_ELECTRON_BINARY` to an already installed generic Electron executable to run
without `npx`, or set `MD4H_CODE_APP` if VS Code is installed somewhere else.

Each of the nine theme and zoom combinations verifies:

- a PNG signature and IHDR dimensions matching the captured CSS box;
- local SVG and PNG images fetched through a VS Code-style webview resource host
  under a restrictive CSP;
- a rendered table marker;
- actual Mermaid output rendered from the project's `mermaid` dependency;
- actual KaTeX HTML and fonts rendered from the project's `katex` dependency;
- visible pixels from both rich renderers, not only DOM presence.

The runner prints one concise JSON result with the matrix and per-combination
measurements. It exits nonzero when any marker, renderer, dimension, signature,
or runtime-version check fails. Temporary files are removed unless
`MD4H_KEEP_FIXTURE=1` is set.
