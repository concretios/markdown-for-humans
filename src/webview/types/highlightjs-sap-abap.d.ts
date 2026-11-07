/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Minimal ambient typings for the `highlightjs-sap-abap` grammar package.
 * The package ships plain CommonJS (`module.exports = LanguageFn`) with no
 * declarations and its module name is outside the `highlight.js/lib/languages/*`
 * wildcard covered by highlight.js's own types, so we declare the single
 * default export we use.
 */

declare module 'highlightjs-sap-abap' {
  import { LanguageFn } from 'highlight.js';

  const defineAbap: LanguageFn;
  export default defineAbap;
}
