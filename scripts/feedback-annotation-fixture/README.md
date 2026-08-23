# Feedback annotation Electron fixture

This fixture validates document-synchronous Feedback annotations in a real
Electron renderer. The 14-case visual and performance matrix uses a purpose-built
DOM controller while importing the production annotation layout module and
loading the production editor stylesheet. It is a parallel harness, not the
complete VS Code webview bootstrap or extension host.

A second focused integration scenario mounts a real TipTap editor and the actual
`createFeedbackReviewController`. It covers same-scroll alignment, narrow-card
participation, marker roving focus, hidden high-contrast targets, and teardown.
This reduces the parallel-controller blind spot, but does not turn the full visual
matrix into an end-to-end Extension Host test.

Run from the repository root:

```sh
npm run test:feedback-annotations
```

The command first runs the pure release-gate tests, then detects the Electron
version bundled with the locally installed VS Code and starts the corresponding
published Electron runtime. Set `MD4H_CODE_APP` for a nonstandard VS Code app or
`MD4H_ELECTRON_BINARY` to use an already installed generic Electron executable.

The visual matrix covers:

- light, dark, and high contrast at 100%, 125%, and 200% zoom;
- narrow light, dark, and high contrast at 100%;
- reduced motion in light and high contrast at 100%;
- 3,000+ words with repeated text, marks, links, code, a table, local images,
  actual Mermaid and KaTeX output, screenshot previews, multi-block targets,
  top/middle/EOF notes, and dense collisions.

Every scenario gates target-to-pin drift after fast scroll and asynchronous
reflow, card overlap and spacing, connector endpoints, the absence of a second
scroll surface and horizontal overflow, zero editor/target/marker/scroll drift
when Feedback-only review styling activates, teardown cleanup, 200-comment
render and interaction budgets, and zero annotation layout work during scroll. Narrow
scenarios pass production `cardVisible` semantics and require one active
placement with no hidden-card connectors or phantom EOF overflow. Composer-only
checks require saved cards to contribute no placements, connectors, or spacer.
A computed-style gate also verifies that light and dark saved highlights, active
markers, and primary Feedback actions resolve through the warning-derived
palette. Dark primary actions must retain at least 90% of the warning accent's
luminance, separate from the surrounding widget by at least 3:1, and keep at
least 4.5:1 label contrast. The evaluator accepts both `rgb()` and Chromium's
computed `color(srgb ...)` serialization. The high-contrast fixture deliberately
gives focus and contrast borders different colors, then requires the paint-only
highlight edge and 2px control borders to use the contrast color.
A separate non-screenshot run creates 10,000 source lines and 500 comments, then
checks bounded geometry reads, layout time, and final-target reachability.

Failures retain a PNG, serialized HTML, and JSON measurements under the ignored
`temp/feedback-annotation-fixture/<run>/` directory. Successful runs remove the
temporary Electron application and the empty artifact directory. Set
`MD4H_KEEP_FIXTURE=1` to retain the packaged fixture for debugging.
