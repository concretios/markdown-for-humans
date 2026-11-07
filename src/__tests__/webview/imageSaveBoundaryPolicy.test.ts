/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import fs from 'fs';
import path from 'path';

describe('pending image save boundary', () => {
  it('registers the host write before inserting a pending preview', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../webview/features/imageDragDrop.ts'),
      'utf8'
    );
    const bufferIndex = source.indexOf('const buffer = await imageFile.arrayBuffer()');
    const imageNameIndex = source.indexOf('const imageName = generateImageName', bufferIndex);
    const postIndex = source.indexOf("type: 'saveImage'", bufferIndex);
    const insertionIndex = source.indexOf('// Insert image with base64 preview', postIndex);

    expect(bufferIndex).toBeGreaterThanOrEqual(0);
    expect(postIndex).toBeGreaterThan(bufferIndex);
    expect(insertionIndex).toBeGreaterThan(postIndex);
    expect(imageNameIndex).toBeGreaterThan(bufferIndex);
    expect(source.slice(imageNameIndex, insertionIndex)).not.toMatch(/\bawait\b/);
    expect(source).toContain('data: new Uint8Array(buffer)');
    expect(source).toContain('protocolVersion: IMAGE_SAVE_COMPLETION_PROTOCOL_VERSION');
    expect(source).toContain('viewGeneration: vscodeApi.viewGeneration');
    expect(source).not.toContain('Array.from(new Uint8Array(buffer))');
  });
});
