/**
 * Image Path Resolution Tests
 *
 * Tests the normalizeImagePath function that handles URL-encoded image paths.
 * This ensures workspace images with spaces and special characters in filenames
 * resolve correctly in the WYSIWYG editor.
 */

import { MarkdownEditorProvider, normalizeImagePath } from '../../editor/MarkdownEditorProvider';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { createMockTextDocument } from '../../__mocks__/vscode';

describe('normalizeImagePath', () => {
  describe('URL-encoded paths with spaces (%20)', () => {
    it('should decode %20 to spaces in filename', () => {
      expect(normalizeImagePath('images/Hero%20Image.png')).toBe('images/Hero Image.png');
    });

    it('should decode multiple %20 in filename', () => {
      expect(normalizeImagePath('images/My%20Cool%20Image.png')).toBe('images/My Cool Image.png');
    });

    it('should decode %20 in directory names', () => {
      expect(normalizeImagePath('My%20Assets/screenshots/image.png')).toBe(
        'My Assets/screenshots/image.png'
      );
    });

    it('should decode %20 in both directory and filename', () => {
      expect(normalizeImagePath('My%20Assets/Hero%20Image.png')).toBe('My Assets/Hero Image.png');
    });
  });

  describe('other URL-encoded characters', () => {
    it('should decode %23 (hash) in filename', () => {
      expect(normalizeImagePath('images/image%231.png')).toBe('images/image#1.png');
    });

    it('should decode %28 and %29 (parentheses) in filename', () => {
      expect(normalizeImagePath('images/screenshot%20%281%29.png')).toBe(
        'images/screenshot (1).png'
      );
    });

    it('should decode %26 (ampersand) in filename', () => {
      expect(normalizeImagePath('images/a%26b.png')).toBe('images/a&b.png');
    });

    it('should decode %2B (plus) in filename', () => {
      expect(normalizeImagePath('images/c%2B%2B.png')).toBe('images/c++.png');
    });
  });

  describe('relative path prefixes', () => {
    it('should preserve ./ prefix', () => {
      expect(normalizeImagePath('./images/Hero%20Image.png')).toBe('./images/Hero Image.png');
    });

    it('should preserve ../ prefix', () => {
      expect(normalizeImagePath('../assets/Hero%20Image.png')).toBe('../assets/Hero Image.png');
    });

    it('should preserve multiple ../ segments', () => {
      expect(normalizeImagePath('../../assets/Hero%20Image.png')).toBe(
        '../../assets/Hero Image.png'
      );
    });

    it('should handle mixed relative segments', () => {
      expect(normalizeImagePath('../foo/./bar/../image%20file.png')).toBe(
        '../foo/./bar/../image file.png'
      );
    });
  });

  describe('paths without encoding (already decoded)', () => {
    it('should leave simple paths unchanged', () => {
      expect(normalizeImagePath('images/screenshot.png')).toBe('images/screenshot.png');
    });

    it('should leave paths with spaces unchanged', () => {
      expect(normalizeImagePath('images/Hero Image.png')).toBe('images/Hero Image.png');
    });

    it('should leave ./ prefixed paths unchanged', () => {
      expect(normalizeImagePath('./images/test.png')).toBe('./images/test.png');
    });

    it('should leave ../ prefixed paths unchanged', () => {
      expect(normalizeImagePath('../assets/test.png')).toBe('../assets/test.png');
    });
  });

  describe('remote URLs (should not be modified)', () => {
    it('should not modify http:// URLs', () => {
      const url = 'http://example.com/images/Hero%20Image.png';
      expect(normalizeImagePath(url)).toBe(url);
    });

    it('should not modify https:// URLs', () => {
      const url = 'https://example.com/images/Hero%20Image.png';
      expect(normalizeImagePath(url)).toBe(url);
    });

    it('should not modify data: URIs', () => {
      const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg...';
      expect(normalizeImagePath(dataUri)).toBe(dataUri);
    });

    it('should not modify vscode-webview:// URIs', () => {
      const webviewUri = 'vscode-webview://abc123/images/test.png';
      expect(normalizeImagePath(webviewUri)).toBe(webviewUri);
    });
  });

  describe('file:// URIs', () => {
    it('should strip file:// prefix and decode', () => {
      expect(normalizeImagePath('file:///Users/test/Hero%20Image.png')).toBe(
        '/Users/test/Hero Image.png'
      );
    });

    it('should handle file:// with already decoded path', () => {
      expect(normalizeImagePath('file:///Users/test/image.png')).toBe('/Users/test/image.png');
    });
  });

  describe('edge cases', () => {
    it('should handle empty string', () => {
      expect(normalizeImagePath('')).toBe('');
    });

    it('should handle filename only (no directory)', () => {
      expect(normalizeImagePath('Hero%20Image.png')).toBe('Hero Image.png');
    });

    it('should handle deeply nested paths', () => {
      expect(normalizeImagePath('a/b/c/d/e/Hero%20Image.png')).toBe('a/b/c/d/e/Hero Image.png');
    });

    it('should handle paths with trailing slash', () => {
      expect(normalizeImagePath('images/')).toBe('images/');
    });

    it('should handle paths with multiple consecutive slashes', () => {
      // Multiple slashes create empty segments which should be preserved
      expect(normalizeImagePath('images//test.png')).toBe('images//test.png');
    });

    it('should handle malformed percent encoding gracefully', () => {
      // %ZZ is not valid URL encoding - should be returned as-is
      expect(normalizeImagePath('images/test%ZZ.png')).toBe('images/test%ZZ.png');
    });

    it('should handle incomplete percent encoding gracefully', () => {
      // %2 is incomplete - should be returned as-is
      expect(normalizeImagePath('images/test%2.png')).toBe('images/test%2.png');
    });

    it('should handle unicode characters in filenames', () => {
      // Unicode chars should pass through unchanged
      expect(normalizeImagePath('images/图片.png')).toBe('images/图片.png');
    });

    it('should handle URL-encoded unicode', () => {
      // %E5%9B%BE%E7%89%87 is URL-encoded 图片
      expect(normalizeImagePath('images/%E5%9B%BE%E7%89%87.png')).toBe('images/图片.png');
    });
  });

  describe('real-world examples from medium-blog-post.md', () => {
    it('should handle marketplace-assets path with encoded space', () => {
      expect(normalizeImagePath('marketplace-assets/screenshots/Hero%20Image.png')).toBe(
        'marketplace-assets/screenshots/Hero Image.png'
      );
    });

    it('should handle Easy Table Support screenshot', () => {
      expect(normalizeImagePath('marketplace-assets/screenshots/Easy%20Table%20Support.png')).toBe(
        'marketplace-assets/screenshots/Easy Table Support.png'
      );
    });

    it('should handle Drag Drop Image Insertions screenshot', () => {
      expect(
        normalizeImagePath('marketplace-assets/screenshots/Drag%20Drop%20Image%20Insertions.png')
      ).toBe('marketplace-assets/screenshots/Drag Drop Image Insertions.png');
    });

    it('should handle Rich Table Editing screenshot', () => {
      expect(normalizeImagePath('marketplace-assets/screenshots/Rich%20Table%20Editing.png')).toBe(
        'marketplace-assets/screenshots/Rich Table Editing.png'
      );
    });

    it('should handle Mermaid Diagram Support screenshot', () => {
      expect(
        normalizeImagePath('marketplace-assets/screenshots/Mermaid%20Diagram%20Support.png')
      ).toBe('marketplace-assets/screenshots/Mermaid Diagram Support.png');
    });

    it('should handle Support for Code highlighting screenshot', () => {
      expect(
        normalizeImagePath('marketplace-assets/screenshots/Support%20for%20Code%20highlighting.png')
      ).toBe('marketplace-assets/screenshots/Support for Code highlighting.png');
    });
  });

  describe('handleResolveImageUri integration', () => {
    const createMockWebview = () => {
      const postMessage = jest.fn();
      const asWebviewUri = jest.fn((uri: Uri) => ({
        toString: () => `webview:${uri.fsPath}`,
      }));
      return { postMessage, asWebviewUri };
    };

    const createProvider = () =>
      new MarkdownEditorProvider({
        extensionUri: Uri.file('/test/extension'),
      } as unknown as vscode.ExtensionContext);

    it('resolves and decodes workspace-relative image paths', () => {
      const provider = createProvider();
      const document = createMockTextDocument('');
      const webview = createMockWebview();

      (
        provider as unknown as {
          handleResolveImageUri: (
            message: unknown,
            doc: vscode.TextDocument,
            webview: vscode.Webview
          ) => void;
        }
      ).handleResolveImageUri(
        {
          type: 'resolveImageUri',
          requestId: 'req-1',
          relativePath: 'images/Hero%20Image.png',
        },
        document,
        webview as unknown as vscode.Webview
      );

      expect(webview.asWebviewUri).toHaveBeenCalledWith(
        expect.objectContaining({
          fsPath: expect.stringMatching(/[/\\]test[/\\]images[/\\]Hero Image\.png$/),
        })
      );
      expect(webview.postMessage).toHaveBeenCalledWith({
        type: 'imageUriResolved',
        requestId: 'req-1',
        webviewUri: expect.stringMatching(
          /webview:([A-Za-z]:)?[/\\]test[/\\]images[/\\]Hero Image\.png$/
        ),
        relativePath: 'images/Hero%20Image.png',
      });
    });

    it('strips file:// scheme and decodes before resolving', () => {
      const provider = createProvider();
      const document = createMockTextDocument('');
      const webview = createMockWebview();

      (
        provider as unknown as {
          handleResolveImageUri: (
            message: unknown,
            doc: vscode.TextDocument,
            webview: vscode.Webview
          ) => void;
        }
      ).handleResolveImageUri(
        {
          type: 'resolveImageUri',
          requestId: 'req-2',
          relativePath: 'file:///test/assets/My%20Diagram.png',
        },
        document,
        webview as unknown as vscode.Webview
      );

      expect(webview.asWebviewUri).toHaveBeenCalledWith(
        expect.objectContaining({
          fsPath: expect.stringMatching(/[/\\]test[/\\]assets[/\\]My Diagram\.png$/),
        })
      );
      expect(webview.postMessage).toHaveBeenCalledWith({
        type: 'imageUriResolved',
        requestId: 'req-2',
        webviewUri: expect.stringMatching(
          /webview:([A-Za-z]:)?[/\\]test[/\\]assets[/\\]My Diagram\.png$/
        ),
        relativePath: 'file:///test/assets/My%20Diagram.png',
      });
    });

    it('rejects a local image path outside the document and workspace roots', () => {
      const provider = createProvider();
      const document = createMockTextDocument('');
      const webview = createMockWebview();

      (
        provider as unknown as {
          handleResolveImageUri: (
            message: unknown,
            doc: vscode.TextDocument,
            webview: vscode.Webview
          ) => void;
        }
      ).handleResolveImageUri(
        {
          type: 'resolveImageUri',
          requestId: 'req-outside',
          relativePath: 'file:///private/secrets/tracker.png',
        },
        document,
        webview as unknown as vscode.Webview
      );

      expect(webview.asWebviewUri).not.toHaveBeenCalled();
      expect(webview.postMessage).toHaveBeenCalledWith({
        type: 'imageUriResolved',
        requestId: 'req-outside',
        webviewUri: '',
        relativePath: 'file:///private/secrets/tracker.png',
        error: expect.stringMatching(/outside|allowed/i),
      });
    });
  });
});
