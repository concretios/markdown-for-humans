/**
 * Jest test setup (before test files)
 *
 * This file runs BEFORE test files are loaded.
 * Use it for polyfills and global setup that must be available when test files are parsed.
 */

// Polyfill File API for Node.js test environment
// File is a browser API that's not available in Node.js by default
// This polyfill MUST run before test files are loaded (setupFiles, not setupFilesAfterEnv)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globalObj = globalThis as any;

// Ensure Blob is available (Node 18+ has it globally)
let BlobConstructor: any = globalObj.Blob;

if (typeof BlobConstructor === 'undefined') {
  // Fallback: import from buffer module (Node 18+)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const buffer = require('buffer');
    BlobConstructor = buffer.Blob;
    globalObj.Blob = BlobConstructor;
  } catch (error) {
    throw new Error(
      `Blob is required for File polyfill but is not available: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Polyfill File API - set on globalThis for Node.js compatibility
if (typeof globalObj.File === 'undefined') {
  globalObj.File = class File extends BlobConstructor {
    name: string;
    lastModified: number;

    constructor(fileBits: BlobPart[], fileName: string, options?: FilePropertyBag) {
      super(fileBits, options);
      this.name = fileName;
      this.lastModified = options?.lastModified ?? Date.now();
    }
  };
}

// Global mock for acquireVsCodeApi used in webview scripts
if (typeof globalObj.acquireVsCodeApi === 'undefined') {
  globalObj.acquireVsCodeApi = () => ({
    postMessage: jest.fn(),
    getState: jest.fn(),
    setState: jest.fn(),
  });
}
