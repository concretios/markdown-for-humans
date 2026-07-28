/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Minimal ambient typings for KaTeX. The package ships full types at
 * `node_modules/katex/types/katex.d.ts` but our `moduleResolution: "node"`
 * setting cannot pick them up without changing project-wide config. This
 * declaration covers only the surface we use (`renderToString`) so we
 * stay strict without enabling broader resolution changes.
 */

declare module 'katex' {
  interface KatexOptions {
    displayMode?: boolean;
    output?: 'html' | 'mathml' | 'htmlAndMathml';
    leqno?: boolean;
    fleqn?: boolean;
    throwOnError?: boolean;
    errorColor?: string;
    macros?: Record<string, string>;
    minRuleThickness?: number;
    colorIsTextColor?: boolean;
    maxSize?: number;
    maxExpand?: number;
    strict?: boolean | 'ignore' | 'warn' | 'error' | ((errorCode: string) => string);
    trust?: boolean | ((context: { command: string; url?: string }) => boolean);
    globalGroup?: boolean;
  }

  function renderToString(latex: string, options?: KatexOptions): string;
  function render(latex: string, element: HTMLElement, options?: KatexOptions): void;

  const katex: {
    renderToString: typeof renderToString;
    render: typeof render;
  };

  export { renderToString, render };
  export default katex;
}

declare module 'katex/dist/katex.min.css';
declare module 'katex/dist/katex.css';
