/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import fs from 'fs';
import path from 'path';

describe('pending image save boundary', () => {
  it('prepares host bytes before inserting a preview and posts without another await', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../webview/features/imageDragDrop.ts'),
      'utf8'
    );
    const bufferIndex = source.indexOf('const buffer = await imageFile.arrayBuffer()');
    const insertionIndex = source.indexOf('// Insert image with base64 preview');
    const postIndex = source.indexOf("type: 'saveImage'", insertionIndex);

    expect(bufferIndex).toBeGreaterThanOrEqual(0);
    expect(insertionIndex).toBeGreaterThan(bufferIndex);
    expect(postIndex).toBeGreaterThan(insertionIndex);
    expect(source.slice(insertionIndex, postIndex)).not.toMatch(/\bawait\b/);
    expect(source).toContain('data: new Uint8Array(buffer)');
    expect(source).toContain('protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION');
    expect(source).toContain('viewGeneration: vscodeApi.viewGeneration');
    expect(source).not.toContain('Array.from(new Uint8Array(buffer))');
  });
});
