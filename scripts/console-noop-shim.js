/**
 * Production replacement for console.log / console.debug / console.info.
 *
 * Injected by scripts/console-strip.js via esbuild's `inject` option, so that
 * `define` can rewrite those call sites to a no-op even when their return
 * value is used (e.g. `const log = (m) => console.log(m)`), which esbuild's
 * `pure` option cannot remove on its own.
 *
 * esbuild inlines and tree-shakes this away, so it costs nothing in the bundle.
 */
export function __noopConsole() {}
