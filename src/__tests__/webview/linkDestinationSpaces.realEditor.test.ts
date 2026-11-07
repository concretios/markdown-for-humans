/** @jest-environment jsdom */

/**
 * A link destination that holds a space must be written as `<my file.md>`.
 *
 * The link mark wrote `[a](my file.md)`, which Markdown does not read as a
 * link, so the link was lost on reload. It happened on any edit to a paragraph
 * holding `[a](<my file.md>)`, and on a Document Audit fix (typed or picked
 * with Browse) to a path with a space, after which Audit said "All fixed!".
 */

import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { CustomImage } from '../../webview/extensions/customImage';
import { MarkdownLink } from '../../webview/extensions/markdownCompatibilityMarks';
import { MarkdownParagraph } from '../../webview/extensions/markdownParagraph';
import { SpaceFriendlyImagePaths } from '../../webview/extensions/spaceFriendlyImagePaths';
import { handleAuditPickFileResult, type AuditIssue } from '../../webview/features/auditDocument';
import { showAuditOverlay, clearToasts } from '../../webview/features/auditOverlay';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';

function createEditor(markdown: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      SpaceFriendlyImagePaths,
      StarterKit.configure({ paragraph: false, link: false }),
      MarkdownParagraph,
      MarkdownLink,
      CustomImage,
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    ],
    content: '',
    contentType: 'markdown',
  });
  setMarkdownContentPreservingSource(editor, markdown);
  return editor;
}

function appendToFirstParagraph(editor: Editor, text: string): void {
  let end = -1;
  editor.state.doc.descendants((node, pos) => {
    if (end !== -1) return false;
    if (node.type.name === 'paragraph') {
      end = pos + node.nodeSize - 1;
      return false;
    }
    return true;
  });
  editor.commands.insertContentAt(end, text);
}

/** Every link href in the document, as the editor reads it after a reload. */
function linkHrefsAfterReload(markdown: string): string[] {
  const reloaded = createEditor(markdown);
  const hrefs: string[] = [];
  reloaded.state.doc.descendants(node => {
    node.marks.forEach(mark => {
      if (mark.type.name === 'link') hrefs.push(mark.attrs.href as string);
    });
    if (typeof node.attrs?.['link-href'] === 'string') hrefs.push(node.attrs['link-href']);
  });
  reloaded.destroy();
  return hrefs;
}

/** The audit issue for the first link in the document, as auditDocument reports it. */
function firstLinkIssue(editor: Editor): AuditIssue {
  let issue: AuditIssue | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (issue) return false;
    const link = node.marks.find(mark => mark.type.name === 'link');
    if (node.isText && link) {
      issue = {
        type: 'link',
        message: 'Linked file not found',
        target: link.attrs.href as string,
        pos,
        nodeSize: node.nodeSize,
      };
    }
    return true;
  });
  if (!issue) throw new Error('no link in document');
  return issue;
}

describe('link destinations with spaces', () => {
  afterEach(() => {
    document.getElementById('audit-overlay')?.remove();
    clearToasts();
    delete (window as unknown as { vscode?: unknown }).vscode;
    document.body.replaceChildren();
  });

  it('keeps `[a](<my file.md>)` bracketed when its paragraph is edited', () => {
    const editor = createEditor('See [a](<my file.md>) now.');
    appendToFirstParagraph(editor, ' EDITED');
    const saved = getEditorMarkdownForSync(editor);
    expect(saved).toBe('See [a](<my file.md>) now. EDITED');
    expect(linkHrefsAfterReload(saved)).toEqual(['my file.md']);
    editor.destroy();
  });

  it('keeps a titled link with a space bracketed', () => {
    const editor = createEditor('See [a](<my file.md> "Title") now.');
    appendToFirstParagraph(editor, ' EDITED');
    expect(getEditorMarkdownForSync(editor)).toBe('See [a](<my file.md> "Title") now. EDITED');
    editor.destroy();
  });

  it.each([
    ['a `>`', 'See [a](<my\\>x file.md>) now.', 'my>x file.md'],
    ['a `<`', 'See [a](<my\\<x file.md>) now.', 'my<x file.md'],
    ['a backslash before punctuation', 'See [a](<my\\\\*x file.md>) now.', 'my\\*x file.md'],
    ['a Windows backslash', 'See [a](<C:\\My Docs\\a.md>) now.', 'C:\\My Docs\\a.md'],
  ])('keeps a target with a space and %s as a link after an edit', (_label, source, href) => {
    const editor = createEditor(source);
    appendToFirstParagraph(editor, ' EDITED');
    const saved = getEditorMarkdownForSync(editor);
    expect(saved).toBe(`${source} EDITED`);
    expect(linkHrefsAfterReload(saved)).toEqual([href]);
    editor.destroy();
  });

  it('keeps an image whose path has a space and a `>` after an edit', () => {
    const editor = createEditor('Look ![pic](<my\\>x pic.png>) here.');
    appendToFirstParagraph(editor, ' EDITED');
    expect(getEditorMarkdownForSync(editor)).toBe('Look ![pic](<my\\>x pic.png>) here. EDITED');
    editor.destroy();
  });

  it('leaves a link without spaces unbracketed', () => {
    const editor = createEditor('See [a](my-file.md) now.');
    appendToFirstParagraph(editor, ' EDITED');
    expect(getEditorMarkdownForSync(editor)).toBe('See [a](my-file.md) now. EDITED');
    editor.destroy();
  });

  it('saves an Audit manual Fix to a path with a space as a working link', () => {
    const editor = createEditor('See [a](missing.md) now.');
    showAuditOverlay(editor, [firstLinkIssue(editor)]);

    const input = document.querySelector('.audit-manual-input') as HTMLInputElement;
    const fixBtn = document.querySelector('.audit-fix-button.manual-fix') as HTMLButtonElement;
    input.value = 'my file.md';
    fixBtn.click();

    const saved = getEditorMarkdownForSync(editor);
    expect(saved).toBe('See [a](<my file.md>) now.');
    expect(linkHrefsAfterReload(saved)).toEqual(['my file.md']);
    editor.destroy();
  });

  it('saves an Audit Browse pick of a path with a space as a working link', async () => {
    const postMessage = jest.fn();
    (window as unknown as { vscode: unknown }).vscode = { postMessage };
    const editor = createEditor('See [a](missing.md) now.');
    showAuditOverlay(editor, [firstLinkIssue(editor)]);

    (document.querySelector('.audit-browse-btn') as HTMLButtonElement).click();
    const { requestId } = postMessage.mock.calls[0][0] as { requestId: string };
    // The host sends non-image paths back raw, not URL-encoded.
    handleAuditPickFileResult(requestId, './docs/my file.md');
    await new Promise(resolve => setTimeout(resolve, 0));

    const saved = getEditorMarkdownForSync(editor);
    expect(saved).toBe('See [a](<./docs/my file.md>) now.');
    expect(linkHrefsAfterReload(saved)).toEqual(['./docs/my file.md']);
    editor.destroy();
  });

  it('keeps an image with a space in its path bracketed when its paragraph is edited', () => {
    const editor = createEditor('Look ![pic](<my pic.png>) here.');
    appendToFirstParagraph(editor, ' EDITED');
    expect(getEditorMarkdownForSync(editor)).toBe('Look ![pic](<my pic.png>) here. EDITED');
    editor.destroy();
  });

  it('keeps the link around a linked image bracketed when it holds a space', () => {
    const editor = createEditor('Look [![pic](pic.png)](<my file.md>) here.');
    appendToFirstParagraph(editor, ' EDITED');
    const saved = getEditorMarkdownForSync(editor);
    expect(saved).toBe('Look [![pic](pic.png)](<my file.md>) here. EDITED');
    expect(linkHrefsAfterReload(saved)).toEqual(['my file.md']);
    editor.destroy();
  });
});
