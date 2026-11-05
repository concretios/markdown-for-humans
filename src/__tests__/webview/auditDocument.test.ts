/**
 * @jest-environment jsdom
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { CustomImage } from '../../webview/extensions/customImage';
import { PreservedMarkdownLiteral } from '../../webview/extensions/preservedMarkdownLiteral';
import {
  runAudit,
  handleAuditPickFileResult,
  handleAuditUrlCheckResult,
} from '../../webview/features/auditDocument';
import * as l10n from '../../webview/l10n';
import { installBlankLineLexerNormalizer } from '../../webview/utils/markedLexerNormalizer';

describe('Audit Document Feature', () => {
  let editor: Editor;
  let mockVscodeApi: any;

  beforeEach(() => {
    document.body.innerHTML = '<div id="editor"></div>';

    // Mock VS Code API for tests
    mockVscodeApi = {
      postMessage: jest.fn(),
    };
    (window as any).vscode = mockVscodeApi;

    editor = new Editor({
      element: document.getElementById('editor') as HTMLElement,
      extensions: [
        StarterKit,
        CustomImage,
        PreservedMarkdownLiteral,
        Markdown.configure({
          markedOptions: {
            gfm: true,
            breaks: true,
          },
        }),
      ],
      content: '',
    });

    // Wire up the lexer normaliser exactly the way editor.ts does in production,
    // so these tests exercise the same parse path users see.
    const markdownStorage = editor as unknown as {
      markdown?: { instance?: unknown };
      storage?: { markdown?: { instance?: unknown } };
    };
    const markedInstance =
      markdownStorage.markdown?.instance ?? markdownStorage.storage?.markdown?.instance;
    if (markedInstance) {
      installBlankLineLexerNormalizer(markedInstance);
    }
  });

  afterEach(() => {
    if (editor) {
      editor.destroy();
    }
    delete (window as any).vscode;
    jest.clearAllMocks();
  });

  it('should detect image with no source', async () => {
    editor.commands.setContent('![]()', { contentType: 'markdown' });
    const results = await runAudit(editor);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'image',
      message: 'Image has no source path.',
      target: '',
    });
    expect(typeof results[0].pos).toBe('number');
    expect(results[0].nodeSize).toBeGreaterThan(0);
  });

  it('should detect broken local image file', async () => {
    editor.commands.setContent('![alt text](missing-image.png)', { contentType: 'markdown' });

    mockVscodeApi.postMessage.mockImplementation((message: any) => {
      if (message.type === 'auditCheckFile') {
        setTimeout(() => {
          import('../../webview/features/auditDocument').then(({ handleAuditCheckResult }) => {
            handleAuditCheckResult(message.requestId, false, ['similar-image.png']);
          });
        }, 10);
      }
    });

    const results = await runAudit(editor);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'image',
      message: 'Image file not found: missing-image.png',
      target: 'missing-image.png',
      suggestions: ['similar-image.png'],
    });
  });

  it('should detect broken local file link', async () => {
    editor.commands.setContent('[link text](missing-file.md)', { contentType: 'markdown' });

    mockVscodeApi.postMessage.mockImplementation((message: any) => {
      if (message.type === 'auditCheckFile') {
        setTimeout(() => {
          import('../../webview/features/auditDocument').then(({ handleAuditCheckResult }) => {
            handleAuditCheckResult(message.requestId, false);
          });
        }, 10);
      }
    });

    const results = await runAudit(editor);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'link',
      message: 'Linked file not found: missing-file.md',
      target: 'missing-file.md',
    });
  });

  it('should detect broken heading anchor', async () => {
    editor.commands.setContent('# Existing Heading\n\n[link](#missing-heading)', {
      contentType: 'markdown',
    });

    const results = await runAudit(editor);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'heading',
      message: 'Heading anchor not found: #missing-heading',
      target: 'missing-heading',
    });
  });

  it.each(['#über-uns', '#%C3%BCber-uns', '#ber-uns', '#ÜBER-UNS'])(
    'should not report a link to a heading with an umlaut written as %s',
    async anchor => {
      editor.commands.setContent(`# Über uns\n\n[link](${anchor})`, { contentType: 'markdown' });

      expect(await runAudit(editor)).toHaveLength(0);
    }
  );

  it('should suggest the GitHub form of a heading anchor', async () => {
    editor.commands.setContent('# Setup & Config\n\n[link](#setup-configs)', {
      contentType: 'markdown',
    });

    const results = await runAudit(editor);

    expect(results[0].suggestions).toEqual(['setup--config']);
  });

  it('should not report issues for valid heading anchor', async () => {
    editor.commands.setContent('# Existing Heading\n\n[link](#existing-heading)', {
      contentType: 'markdown',
    });

    const results = await runAudit(editor);

    expect(results).toHaveLength(0);
  });

  it('should treat image with empty alt + valid URL as a real image (regression)', async () => {
    // Regression for https://github.com/concretios/markdown-for-humans/issues
    // — previously the lexer normaliser demoted any image with empty alt to
    // literal text, breaking both rendering and audit URL checks. The fix
    // keeps `![](url)` as a real image node and routes it through the URL
    // reachability check below.
    editor.commands.setContent('![](https://example.com/broken-image.png)', {
      contentType: 'markdown',
    });

    // The doc must contain an actual image node, not literal text.
    let imageNodeCount = 0;
    editor.state.doc.descendants(node => {
      if (node.type.name === 'image' || node.type.name === 'customImage') {
        imageNodeCount++;
      }
    });
    expect(imageNodeCount).toBe(1);

    mockVscodeApi.postMessage.mockImplementation((message: any) => {
      if (message.type === 'auditCheckUrl') {
        setTimeout(() => {
          import('../../webview/features/auditDocument').then(({ handleAuditUrlCheckResult }) => {
            handleAuditUrlCheckResult(message.requestId, false);
          });
        }, 10);
      }
    });

    const results = await runAudit(editor);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'image',
      message: 'Broken image URL: https://example.com/broken-image.png',
      target: 'https://example.com/broken-image.png',
    });
  });

  it('should flag empty image syntax inside surrounding paragraph text', async () => {
    // `![]()` next to a soft-break gets rewritten to literal text by the
    // lexer normaliser (so it survives the parse round-trip). The audit must
    // still flag it as "no source path".
    editor.commands.setContent('Some intro text\n![]()\n\nAfter', {
      contentType: 'markdown',
    });

    const results = await runAudit(editor);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'image',
      message: 'Image has no source path.',
      target: '',
    });
    expect(results[0].nodeSize).toBe('![]()'.length);
  });

  it('should detect broken image URL', async () => {
    editor.commands.setContent('![alt text](https://example.com/broken-image.png)', {
      contentType: 'markdown',
    });

    mockVscodeApi.postMessage.mockImplementation((message: any) => {
      if (message.type === 'auditCheckUrl') {
        setTimeout(() => {
          import('../../webview/features/auditDocument').then(({ handleAuditUrlCheckResult }) => {
            handleAuditUrlCheckResult(message.requestId, false);
          });
        }, 10);
      }
    });

    const results = await runAudit(editor);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'image',
      message: 'Broken image URL: https://example.com/broken-image.png',
      target: 'https://example.com/broken-image.png',
    });
  });

  it('should detect broken link URL', async () => {
    editor.commands.setContent('[link text](https://example.com/broken-page)', {
      contentType: 'markdown',
    });

    mockVscodeApi.postMessage.mockImplementation((message: any) => {
      if (message.type === 'auditCheckUrl') {
        setTimeout(() => {
          import('../../webview/features/auditDocument').then(({ handleAuditUrlCheckResult }) => {
            handleAuditUrlCheckResult(message.requestId, false);
          });
        }, 10);
      }
    });

    const results = await runAudit(editor);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'link',
      message: 'Broken link URL: https://example.com/broken-page',
      target: 'https://example.com/broken-page',
    });
  });

  it('should handle multiple issues in document', async () => {
    editor.commands.setContent(
      `# Heading One

![broken image](missing.png)

[broken link](missing.md)

[broken anchor](#missing)

![broken url](https://example.com/bad.png)`,
      { contentType: 'markdown' }
    );

    mockVscodeApi.postMessage.mockImplementation((message: any) => {
      if (message.type === 'auditCheckFile') {
        setTimeout(() => {
          import('../../webview/features/auditDocument').then(({ handleAuditCheckResult }) => {
            handleAuditCheckResult(message.requestId, false);
          });
        }, 10);
      } else if (message.type === 'auditCheckUrl') {
        setTimeout(() => {
          import('../../webview/features/auditDocument').then(({ handleAuditUrlCheckResult }) => {
            handleAuditUrlCheckResult(message.requestId, false);
          });
        }, 10);
      }
    });

    const results = await runAudit(editor);

    expect(results).toHaveLength(4);
    const types = results.map(r => r.type).sort();
    expect(types).toEqual(['heading', 'image', 'image', 'link']);
  });

  it('should return empty array for document with no issues', async () => {
    editor.commands.setContent('# Heading\n\n[valid link](#heading)\n\nNormal text', {
      contentType: 'markdown',
    });

    const results = await runAudit(editor);

    expect(results).toHaveLength(0);
  });

  // ── NEW TEST: auditPickFile roundtrip ─────────────────────────────────────

  it('handleAuditPickFileResult resolves the pending pick-file callback', async () => {
    // We manually call handleAuditPickFileResult to simulate extension response
    // This tests the callback registration/resolution logic without actually
    // opening a file picker (that happens in the extension host).
    const { requestFilePickerForIssue } = await import('../../webview/features/auditDocument');

    // postMessage is already mocked via mockVscodeApi
    let resolvedPath: string | null = null;
    const pickPromise = requestFilePickerForIssue('image').then(path => {
      resolvedPath = path;
    });

    // Extension replies with a selected path
    const requestId = (mockVscodeApi.postMessage.mock.calls[0][0] as any).requestId as string;
    handleAuditPickFileResult(requestId, './images/new-image.png');

    await pickPromise;
    expect(resolvedPath).toBe('./images/new-image.png');
  });

  describe('localization', () => {
    // Leaves out "Link is empty." on purpose, to exercise the fallback to English.
    const sampleBundle: Record<string, string> = {
      'Image has no source path.': '图片没有源路径。',
      'Image file not found: {0}': '找不到图片文件: {0}',
      'Heading anchor not found: #{0}': '找不到标题锚点: #{0}',
      'Broken link URL: {0}': '链接地址已失效: {0}',
    };

    afterEach(() => {
      l10n.resetL10n();
    });

    it('shows English when no bundle is loaded', async () => {
      editor.commands.setContent('![]()', { contentType: 'markdown' });

      const results = await runAudit(editor);

      expect(results[0].message).toBe('Image has no source path.');
    });

    it('translates a message without arguments', async () => {
      l10n.configureL10n(sampleBundle);
      editor.commands.setContent('![]()', { contentType: 'markdown' });

      const results = await runAudit(editor);

      expect(results[0].message).toBe('图片没有源路径。');
    });

    it('translates a message that carries the target', async () => {
      l10n.configureL10n(sampleBundle);
      editor.commands.setContent('![alt text](missing-image.png)', { contentType: 'markdown' });
      mockVscodeApi.postMessage.mockImplementation((message: any) => {
        if (message.type === 'auditCheckFile') {
          setTimeout(() => {
            import('../../webview/features/auditDocument').then(({ handleAuditCheckResult }) => {
              handleAuditCheckResult(message.requestId, false);
            });
          }, 10);
        }
      });

      const results = await runAudit(editor);

      expect(results).toHaveLength(1);
      expect(results[0].message).toBe('找不到图片文件: missing-image.png');
      expect(results[0].target).toBe('missing-image.png');
    });

    it('translates a heading anchor message and a broken URL message', async () => {
      l10n.configureL10n(sampleBundle);
      editor.commands.setContent('[jump](#missing-section) and [web](https://example.com/gone)', {
        contentType: 'markdown',
      });
      mockVscodeApi.postMessage.mockImplementation((message: any) => {
        if (message.type === 'auditCheckUrl') {
          setTimeout(() => handleAuditUrlCheckResult(message.requestId, false), 10);
        }
      });

      const results = await runAudit(editor);

      expect(results.map(issue => issue.message).sort()).toEqual([
        '找不到标题锚点: #missing-section',
        '链接地址已失效: https://example.com/gone',
      ]);
    });
  });
});
