import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('rich-view hidden webview policy', () => {
  it('lets VS Code discard hidden DOM after the bounded renderer state path is available', () => {
    const providerSource = readFileSync(
      resolve(__dirname, '../../editor/MarkdownEditorProvider.ts'),
      'utf8'
    );
    const registration = providerSource.match(
      /registerCustomEditorProvider\([\s\S]*?webviewOptions:\s*\{([\s\S]*?)\}\s*,\s*supportsMultipleEditorsPerDocument/
    );

    expect(registration?.[1]).toMatch(/retainContextWhenHidden:\s*false/);
    expect(registration?.[1]).toMatch(/enableFindWidget:\s*true/);
  });

  it('requests host-authoritative content when a recreated panel receives no initial payload', () => {
    const editorSource = readFileSync(resolve(__dirname, '../../webview/editor.ts'), 'utf8');
    const readyBoundary = editorSource.match(
      /const signalReady[\s\S]*?hasSentReadySignal\s*=\s*true;([\s\S]*?)\n\};/
    );

    expect(readyBoundary?.[1]).toMatch(/setTimeout/);
    expect(readyBoundary?.[1]).toMatch(/!editor/);
    expect(readyBoundary?.[1]).toMatch(/pendingInitialContent/);
    expect(readyBoundary?.[1]).toMatch(/type:\s*'document\.sync\.request'/);
    expect(readyBoundary?.[1]).toMatch(/viewGeneration/);
  });

  it('flushes pending Markdown to the host before teardown without persisting document content', () => {
    const editorSource = readFileSync(resolve(__dirname, '../../webview/editor.ts'), 'utf8');
    const lifecycleFlush = editorSource.match(
      /function flushRichViewBeforeTeardown[\s\S]*?\n\}/
    )?.[0];

    expect(lifecycleFlush).toMatch(/documentSyncController\?\.hasPendingSync\(\)/);
    expect(lifecycleFlush).toMatch(/documentSyncController\.flushForTeardown\(\)/);
    expect(lifecycleFlush).toMatch(/richViewStateController\.flushPersist\(\)/);
    expect(lifecycleFlush?.indexOf('documentSyncController.flushForTeardown()')).toBeLessThan(
      lifecycleFlush?.indexOf('richViewStateController.flushPersist()') ?? -1
    );
  });
});
