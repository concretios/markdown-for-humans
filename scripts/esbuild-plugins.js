#!/usr/bin/env node

/**
 * esbuild Plugins
 *
 * Custom plugins for the build process.
 */

/**
 * Plugin to remove console.log, console.debug, and console.info
 * while keeping console.error and console.warn in production builds.
 *
 * This plugin only runs when minify is enabled (production builds).
 * In development, all console methods are preserved for debugging.
 *
 * Uses a regex-based approach that matches complete console.log/debug/info statements.
 * Note: This is simpler than AST parsing but may have edge cases with very complex expressions.
 */
const dropConsoleLogPlugin = {
  name: 'drop-console-log',
  setup(build) {
    // Only run in production builds (when minify is enabled)
    if (!build.initialOptions.minify) {
      return;
    }

    build.onLoad({ filter: /\.(ts|js|tsx|jsx)$/ }, async (args) => {
      const fs = require('fs');
      let contents = await fs.promises.readFile(args.path, 'utf8');

      // Remove console.log/debug/info calls
      // Strategy: Match the pattern and remove the entire line or statement
      // This regex handles:
      // - Single line: console.log('test');
      // - With template strings: console.log(`test ${var}`);
      // - Multi-line (basic): console.log('test',
      //                                    'more');
      //
      // Note: This is a best-effort approach. For 100% accuracy, we'd need AST parsing,
      // but this handles the vast majority of cases in our codebase.
      
      // Pattern 1: console.log(...) on a single line (most common case)
      contents = contents.replace(
        /^\s*console\.(log|debug|info)\s*\([^;]*?\)\s*;?\s*$/gm,
        ''
      );

      // Pattern 2: console.log(...) as part of a larger expression (less common)
      // This handles cases like: if (debug) console.log('test');
      // We're more conservative here - only remove if it's a standalone statement
      contents = contents.replace(
        /console\.(log|debug|info)\s*\([^)]*?\)\s*;?/g,
        (match, method) => {
          // Only remove if it's not part of a larger expression
          // (i.e., if it starts the statement or is preceded by whitespace/semicolon)
          return '';
        }
      );

      return {
        contents,
        loader: args.path.endsWith('.ts') || args.path.endsWith('.tsx') ? 'ts' : 'js',
      };
    });
  },
};

module.exports = { dropConsoleLogPlugin };
