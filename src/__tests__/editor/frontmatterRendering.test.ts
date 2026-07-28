import { WorkspaceEdit, Position, workspace, ExtensionContext, TextDocument } from 'vscode';
import { MarkdownEditorProvider } from '../../editor/MarkdownEditorProvider';

// Helper to create a minimal mock TextDocument
function createDocument(content: string, uri = 'file://test.md') {
  return {
    getText: jest.fn(() => content),
    uri: {
      toString: () => uri,
    },
    positionAt: jest.fn((offset: number) => new Position(0, offset)),
  };
}

describe('MarkdownEditorProvider frontmatter rendering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('wraps YAML frontmatter in a fenced code block when sending to webview', () => {
    const provider = new MarkdownEditorProvider({} as ExtensionContext);
    const content = [
      '---',
      'title: Example',
      'slug: example',
      '---',
      '',
      '# Heading',
      'body content',
    ].join('\n');

    const document = createDocument(content);
    const webview = { postMessage: jest.fn() };

    (
      provider as unknown as {
        updateWebview: (doc: TextDocument, wv: { postMessage: jest.Mock }) => void;
      }
    ).updateWebview(document as unknown as TextDocument, webview);

    expect(webview.postMessage).toHaveBeenCalledTimes(1);
    const payload = (webview.postMessage as jest.Mock).mock.calls[0][0];
    expect(payload.type).toBe('update');

    const wrapped = payload.content as string;
    expect(wrapped.startsWith('```yaml')).toBe(true);
    expect(wrapped).toContain('title: Example');
    expect(wrapped).toContain('slug: example');
    expect(wrapped).toContain('```');
    expect(wrapped.trimEnd()).toContain('# Heading');
  });

  it('restores YAML delimiters when saving an edited fenced block', async () => {
    const provider = new MarkdownEditorProvider({} as ExtensionContext);
    const original = ['---', 'title: Old', '---', '', '# Heading'].join('\n');
    const document = createDocument(original) as unknown as TextDocument;
    const webview = { postMessage: jest.fn() };

    // Seed any internal caches via updateWebview
    (
      provider as unknown as {
        updateWebview: (doc: TextDocument, wv: { postMessage: jest.Mock }) => void;
      }
    ).updateWebview(document, webview);

    const editedFenced = ['```yaml', '---', 'title: New', '---', '```', '', '# Heading'].join('\n');

    let savedText = '';
    (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
      const replaces = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces || [];
      if (replaces.length > 0) {
        savedText = replaces[0].text;
      }
      return true;
    });

    await (
      provider as unknown as { applyEdit: (content: string, doc: TextDocument) => Promise<void> }
    ).applyEdit(editedFenced, document);

    expect(savedText.startsWith('---\ntitle: New')).toBe(true);
    expect(savedText).toContain('\n---\n\n# Heading');
  });
});

// ===========================================================================
// Regression: frontmatter whose value contains a ``` fence was corrupted on
// round-trip. The host wrapped with a fixed 3-backtick fence, so the embedded
// ``` closed the fence early in the webview's markdown parser, fragmenting the
// frontmatter and dropping fields. The fix lengthens the wrapper fence to be
// longer than any backtick run inside the frontmatter (CommonMark then forbids
// the inner run from closing it) and teaches the unwrapper to accept the longer
// fence. See: QA finding FM-19, .concret.io/goal/qa-adversarial-ai-ctx/.
//
// Why these tests assert the two halves (fence length on wrap; recognition on
// unwrap) rather than a full editor round-trip: the corruption is introduced by
// the marked parser between wrap (host/Node) and unwrap (host/Node), and the
// parser runs in the webview (jsdom). A pure host wrap→unwrap is textually
// symmetric and would pass even with the bug. The invariant "wrapped fence is
// longer than every inner backtick run" is exactly what stops the parser from
// splitting the block, so it is the precise property to pin.
describe('MarkdownEditorProvider frontmatter with embedded code fences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** Longest run of consecutive backticks anywhere in `s` (0 if none). */
  function longestBacktickRun(s: string): number {
    const runs = s.match(/`+/g);
    return runs ? Math.max(...runs.map(r => r.length)) : 0;
  }

  it('wraps with a fence longer than any backtick run inside the frontmatter', () => {
    const provider = new MarkdownEditorProvider({} as ExtensionContext);
    // A multiline YAML scalar holding a fenced code sample — contains ```.
    const content = [
      '---',
      'title: Example',
      'snippet: |',
      '  ```',
      '  code()',
      '  ```',
      'slug: example',
      '---',
      '',
      '# Heading',
    ].join('\n');

    const document = createDocument(content);
    const webview = { postMessage: jest.fn() };
    (
      provider as unknown as {
        updateWebview: (doc: TextDocument, wv: { postMessage: jest.Mock }) => void;
      }
    ).updateWebview(document as unknown as TextDocument, webview);

    const wrapped = (webview.postMessage as jest.Mock).mock.calls[0][0].content as string;
    const openingFence = wrapped.split('\n')[0].replace(/yaml$/i, '');
    // The opening fence must be strictly longer than the embedded ``` (3), so the
    // webview parser cannot treat the inner run as a closing fence.
    expect(openingFence.length).toBeGreaterThan(longestBacktickRun('```\ncode()\n```'));
    expect(/^`{4,}yaml$/.test(wrapped.split('\n')[0])).toBe(true);
    // The frontmatter fields must all still be inside the single wrapped block.
    expect(wrapped).toContain('title: Example');
    expect(wrapped).toContain('slug: example');
  });

  it('restores YAML delimiters when saving a block fenced with 4+ backticks', async () => {
    const provider = new MarkdownEditorProvider({} as ExtensionContext);
    const original = ['---', 'title: Old', 'slug: s', '---', '', '# Heading'].join('\n');
    const document = createDocument(original) as unknown as TextDocument;
    const webview = { postMessage: jest.fn() };
    (
      provider as unknown as {
        updateWebview: (doc: TextDocument, wv: { postMessage: jest.Mock }) => void;
      }
    ).updateWebview(document, webview);

    // What the webview serializes back when the frontmatter contains a ``` run:
    // prosemirror-markdown emits a fence one longer than the inner run (````).
    const editedFenced = [
      '````yaml',
      '---',
      'title: New',
      'snippet: |',
      '  ```',
      '  code()',
      '  ```',
      'slug: s',
      '---',
      '````',
      '',
      '# Heading',
    ].join('\n');

    let savedText = '';
    (workspace.applyEdit as jest.Mock).mockImplementation(async (edit: WorkspaceEdit) => {
      const replaces = (edit as unknown as { replaces?: Array<{ text: string }> }).replaces || [];
      if (replaces.length > 0) {
        savedText = replaces[0].text;
      }
      return true;
    });

    await (
      provider as unknown as { applyEdit: (content: string, doc: TextDocument) => Promise<void> }
    ).applyEdit(editedFenced, document);

    // The ````-fenced block must unwrap back to plain --- frontmatter, and NO
    // field may be lost. Before the fix, unwrap only recognized exactly ```yaml,
    // so the ````yaml block was left intact (corruption: a code block on disk).
    expect(savedText.startsWith('---\ntitle: New')).toBe(true);
    expect(savedText).toContain('slug: s'); // field survives — no data loss
    expect(savedText).toContain('\n---\n\n# Heading');
    expect(savedText).not.toContain('````'); // the wrapper fence is gone
  });

  it('does NOT lengthen the fence for ordinary frontmatter (no behavior change)', () => {
    const provider = new MarkdownEditorProvider({} as ExtensionContext);
    const content = ['---', 'title: Plain', '---', '', '# Heading'].join('\n');
    const document = createDocument(content);
    const webview = { postMessage: jest.fn() };
    (
      provider as unknown as {
        updateWebview: (doc: TextDocument, wv: { postMessage: jest.Mock }) => void;
      }
    ).updateWebview(document as unknown as TextDocument, webview);

    const wrapped = (webview.postMessage as jest.Mock).mock.calls[0][0].content as string;
    // Ordinary frontmatter (no backticks) must still use exactly ```yaml.
    expect(wrapped.split('\n')[0]).toBe('```yaml');
  });
});
