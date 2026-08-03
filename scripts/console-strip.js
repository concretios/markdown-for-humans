#!/usr/bin/env node

/**
 * Shared esbuild options for stripping noisy console calls from release bundles.
 *
 * console.warn and console.error are intentionally preserved for diagnostics.
 *
 * Why two mechanisms are needed:
 *
 *  - `pure` marks `console.log(...)` as side-effect free, so esbuild's dead-code
 *    elimination can delete it. That only happens when the call's *result is
 *    unused*. A call whose value is consumed survives, e.g. chevrotain (bundled
 *    via mermaid) ships `this.logging = opts?.logging ?? ((m) => console.log(m))`
 *    and the arrow returns the call's result, so `pure` keeps it.
 *
 *  - `define` rewrites the `console.log` identifier chain itself, so
 *    value-position uses collapse to a no-op too. It needs an entity name as
 *    the replacement (inline expressions are rejected), hence the injected shim.
 *
 * Neither mechanism touches `something.console.log(...)` — a `console` property
 * on some other object is not the global console and must not be rewritten.
 * scripts/verify-build.js skips those deliberately; see the note there.
 */

const path = require('path');

/** console methods stripped from release bundles. */
const STRIPPED_CONSOLE_METHODS = ['log', 'debug', 'info'];

const NOOP_NAME = '__noopConsole';
const SHIM_PATH = path.join(__dirname, 'console-noop-shim.js');

/**
 * @param {boolean} isProduction
 * @returns {{ pure: string[], define: Record<string, string>, inject: string[] }}
 */
function consoleStripOptions(isProduction) {
  if (!isProduction) {
    return { pure: [], define: {}, inject: [] };
  }

  const define = {};
  for (const method of STRIPPED_CONSOLE_METHODS) {
    define[`console.${method}`] = NOOP_NAME;
  }

  return {
    pure: STRIPPED_CONSOLE_METHODS.map((method) => `console.${method}`),
    define,
    inject: [SHIM_PATH],
  };
}

module.exports = { consoleStripOptions, STRIPPED_CONSOLE_METHODS };
