/**
 * @jest-environment jsdom
 */

import { getMarkRange, Editor } from '@tiptap/core';
import {
  createLinkDialog,
  handleFileSearchResults,
  hideLinkDialog,
  showLinkDialog,
} from '../../webview/features/linkDialog';
import * as l10n from '../../webview/l10n';

jest.mock('@tiptap/pm/state', () => ({
  TextSelection: {
    create: jest.fn(() => ({})),
  },
}));

jest.mock('@tiptap/core', () => ({
  getMarkRange: jest.fn(),
}));

const mockGetMarkRange = getMarkRange as jest.Mock;

afterEach(() => {
  hideLinkDialog();
  mockGetMarkRange.mockReset();
});

const createMockEditor = (overrides: Record<string, unknown> = {}) => {
  const defaultSelection = { from: 0, to: 0, empty: true, $from: {} as unknown };

  const defaultDoc = {
    textBetween: jest.fn(() => ''),
    resolve: (_pos: number) => ({
      depth: 0,
      parent: { textContent: 'old text' },
      start: () => 0,
    }),
  };

  const makeTransaction = (doc: unknown) => {
    const tr: {
      doc: unknown;
      removeMark: jest.Mock;
      insertText: jest.Mock;
      addMark: jest.Mock;
      setSelection: jest.Mock;
    } = {
      doc,
      removeMark: jest.fn(() => tr),
      insertText: jest.fn(() => tr),
      addMark: jest.fn(() => tr),
      setSelection: jest.fn(() => tr),
    };
    return tr;
  };

  const state = {
    selection: defaultSelection,
    schema: { marks: { link: { create: jest.fn(attrs => ({ attrs })) } } },
    doc: defaultDoc,
    ...(overrides.state || {}),
  } as unknown as {
    selection: unknown;
    schema: { marks: { link: { create: jest.Mock } } };
    doc: unknown;
    tr?: unknown;
  };

  if (!state.schema?.marks?.link?.create) {
    state.schema.marks.link = { create: jest.fn(attrs => ({ attrs })) };
  }

  if (!(state.doc as { resolve?: unknown }).resolve) {
    (state.doc as { resolve: unknown }).resolve = defaultDoc.resolve;
  }

  const tr =
    (overrides.state && (overrides.state as unknown as { tr?: unknown }).tr) ||
    makeTransaction(state.doc);
  state.tr = tr;

  const view = (overrides as unknown as { view?: { dispatch: jest.Mock; focus: jest.Mock } })
    .view || { dispatch: jest.fn(), focus: jest.fn() };

  // Cast as unknown then Editor since we're using a partial mock
  return {
    state,
    getAttributes: jest.fn(() => ({})),
    commands: { setTextSelection: jest.fn() },
    chain: jest.fn(),
    view,
    ...overrides,
  } as unknown as Editor;
};

describe('linkDialog', () => {
  describe('heading list', () => {
    const openHeadingList = (headingTexts: string[]) => {
      const descendants = (visit: (node: unknown, pos: number) => void) => {
        headingTexts.forEach((textContent, pos) => {
          visit({ type: { name: 'heading' }, attrs: { level: 1 }, textContent, nodeSize: 1 }, pos);
        });
      };
      const create = jest.fn(attrs => ({ attrs }));
      const tr = {
        removeMark: jest.fn(),
        insertText: jest.fn(),
        addMark: jest.fn(),
        setSelection: jest.fn(),
      };
      const chain: { focus: jest.Mock; run: jest.Mock } = {
        focus: jest.fn(() => chain),
        run: jest.fn(),
      };
      const editor = createMockEditor({
        state: {
          selection: { from: 0, to: 0, empty: true, $from: {} as unknown },
          schema: { marks: { link: { create } } },
          tr,
          doc: {
            descendants,
            content: { size: headingTexts.length },
            textBetween: jest.fn(() => ''),
            resolve: () => ({ depth: 0, parent: { textContent: 'go' }, start: () => 0 }),
          },
        } as unknown,
        chain: jest.fn(() => chain),
      });
      mockGetMarkRange.mockReturnValue(null);
      showLinkDialog(editor);

      const radio = document.querySelector('#link-mode-headings') as HTMLInputElement;
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
      (document.querySelector('#link-url-input') as HTMLInputElement).dispatchEvent(
        new Event('focus')
      );

      return {
        create,
        items: () =>
          Array.from(
            document.querySelectorAll<HTMLElement>('.link-dialog-autocomplete-item-heading')
          ),
      };
    };

    it('does not offer a heading that has no anchor', () => {
      const { items } = openHeadingList(['🚀', 'Über uns', '🚀']);

      expect(items().map(item => item.textContent?.split(':')[0].trim())).toEqual([
        'Über uns',
        '🚀',
      ]);
    });

    it('writes the GitHub anchor of the heading picked', () => {
      const { items, create } = openHeadingList(['Über uns']);

      items()[0].click();
      (document.querySelector('#link-text-input') as HTMLInputElement).value = 'go';
      (document.querySelector('#link-ok-btn') as HTMLButtonElement).click();

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ href: '#über-uns' }));
    });
  });

  it('prefills full link text and URL when cursor is inside a link mark', () => {
    const doc = { textBetween: jest.fn(() => 'product') };
    const selection = { from: 0, to: 0, empty: true, $from: {} as unknown };
    const editor = createMockEditor({
      state: {
        selection: selection as unknown,
        schema: { marks: { link: {} as unknown } },
        doc,
      } as unknown,
      getAttributes: jest.fn(() => ({ href: 'https://example.com' })),
    });

    mockGetMarkRange.mockReturnValue({ from: 0, to: 7 });

    showLinkDialog(editor);

    const textInput = document.querySelector('#link-text-input') as HTMLInputElement;
    const urlInput = document.querySelector('#link-url-input') as HTMLInputElement;

    expect(textInput.value).toBe('product');
    expect(urlInput.value).toBe('https://example.com');
    expect(doc.textBetween).toHaveBeenCalledWith(0, 7, ' ');
  });

  it('prefills with explicit selection text when not inside a link', () => {
    const doc = { textBetween: jest.fn(() => 'selected range') };
    const selection = { from: 2, to: 16, empty: false, $from: {} as unknown };
    const editor = createMockEditor({
      state: { selection: selection as unknown, schema: { marks: { link: {} as unknown } }, doc },
    });

    mockGetMarkRange.mockReturnValue(null);

    showLinkDialog(editor);

    const textInput = document.querySelector('#link-text-input') as HTMLInputElement;
    const urlInput = document.querySelector('#link-url-input') as HTMLInputElement;
    const title = document.querySelector('#link-dialog-title') as HTMLElement;

    expect(textInput.value).toBe('selected range');
    expect(urlInput.value).toBe('');
    expect(title.textContent).toBe('Insert Link');
    expect(doc.textBetween).toHaveBeenCalledWith(2, 16, ' ');
  });

  it('updates link text when user edits the text field before saving', () => {
    const insertText = jest.fn();
    const doc = {
      textBetween: jest.fn(() => 'old text'),
      resolve: (pos: number) => ({
        depth: 0,
        parent: { textContent: 'old text' },
        start: () => 0,
        pos,
      }),
    };
    const selection = { from: 5, to: 13, empty: false, $from: {} as unknown };

    type ChainType = {
      focus: () => ChainType;
      extendMarkRange: () => ChainType;
      setLink: () => ChainType;
      command: (
        cb: (args: {
          tr: { insertText: jest.Mock };
          state: { selection: unknown; doc: unknown };
        }) => void
      ) => ChainType;
      run: jest.Mock;
    };
    const chain: ChainType = {
      focus: jest.fn(() => chain),
      extendMarkRange: jest.fn(() => chain),
      setLink: jest.fn(() => chain),
      command: jest.fn(
        (
          cb: (args: {
            tr: { insertText: jest.Mock };
            state: { selection: unknown; doc: unknown };
          }) => void
        ) => {
          cb({ tr: { insertText }, state: { selection, doc } });
          return chain;
        }
      ),
      run: jest.fn(),
    };

    const tr = {
      doc,
      removeMark: jest.fn(),
      insertText,
      addMark: jest.fn(),
      setSelection: jest.fn(),
    };

    const editor = createMockEditor({
      state: { selection, schema: { marks: { link: { create: jest.fn() } } }, doc, tr } as unknown,
      chain: jest.fn(() => chain),
    });

    mockGetMarkRange.mockReturnValue(null);

    showLinkDialog(editor);

    const textInput = document.querySelector('#link-text-input') as HTMLInputElement;
    const urlInput = document.querySelector('#link-url-input') as HTMLInputElement;
    const okButton = document.querySelector('#link-ok-btn') as HTMLButtonElement;

    textInput.value = 'new text';
    urlInput.value = 'https://example.com/new';

    okButton.click();

    expect(insertText).toHaveBeenCalledWith('new text', 5, 13);
    expect(chain.run).toHaveBeenCalled();
  });

  it('restores focus to the editor when dialog is cancelled', () => {
    const focusRun = jest.fn();
    const chain = jest.fn(() => ({ focus: jest.fn(() => ({ run: focusRun })) }));
    const editor = createMockEditor({ chain });

    mockGetMarkRange.mockReturnValue(null);

    showLinkDialog(editor);

    const cancelButton = document.querySelector('#link-cancel-btn') as HTMLButtonElement;
    cancelButton.click();

    expect(focusRun).toHaveBeenCalled();
  });

  it('keeps quotes in workspace file names inside the title attribute', () => {
    jest.useFakeTimers();
    const postMessage = jest.fn();
    (window as unknown as { vscode: { postMessage: jest.Mock } }).vscode = { postMessage };
    try {
      showLinkDialog(createMockEditor() as unknown as Editor);
      const modeFile = document.querySelector('#link-mode-file') as HTMLInputElement;
      modeFile.checked = true;
      modeFile.dispatchEvent(new Event('change'));
      const urlInput = document.querySelector('#link-url-input') as HTMLInputElement;
      urlInput.value = 'a';
      urlInput.dispatchEvent(new Event('input'));
      jest.advanceTimersByTime(300);
      const requestId = postMessage.mock.calls.at(-1)?.[0].requestId;

      const hostilePath = 'docs/a" data-injected="1.md';
      handleFileSearchResults(
        [{ filename: 'a" data-injected="1.md', path: hostilePath }],
        requestId
      );

      expect(document.querySelector('[data-injected]')).toBeNull();
      const pathElement = document.querySelector('.link-dialog-autocomplete-item-path');
      expect(pathElement?.getAttribute('title')).toBe(hostilePath);
    } finally {
      delete (window as unknown as { vscode?: unknown }).vscode;
      jest.useRealTimers();
    }
  });
});

describe('linkDialog localization', () => {
  // Leaves out "OK" on purpose, to exercise the fallback to English.
  const sampleBundle: Record<string, string> = {
    'Insert/Edit Link': '插入/编辑链接',
    'Insert Link': '插入链接',
    'Edit Link': '编辑链接',
    'Close dialog': '关闭对话框',
    'Close (Esc)': '关闭 (Esc)',
    'Link Text': '链接文字',
    'Text to display': '显示的文字',
    'Trim left boundary by one word': '左边界缩短一个词',
    'Expand left boundary to previous word': '左边界扩展到上一个词',
    'Expand right boundary to next word': '右边界扩展到下一个词',
    'Trim right boundary by one word': '右边界缩短一个词',
    'The text that will be shown in the document': '将显示在文档中的文字',
    'The web address or file path': '网址或文件路径',
    'Type/Label above the choice of link kind: URL, file or heading': '类型',
    URL: '网址',
    'File/Link type that points to a file in the workspace': '文件',
    'Headings/Link type that points to a heading in this document': '标题',
    'Heading/Field label when the link type points to a heading in this document': '标题项',
    'Filter/Label above the file type checkboxes': '筛选',
    All: '全部',
    Images: '图片',
    'Remove Link': '移除链接',
    Cancel: '取消',
    'Start typing to search files...': '开始输入以搜索文件...',
    'Select a heading from the list below': '从下方列表选择标题',
    'No files found': '未找到文件',
    'No headings in this document': '此文档中没有标题',
  };

  const dialogText = (dialog: HTMLElement, selector: string): string | undefined =>
    dialog.querySelector(selector)?.textContent?.trim();

  const openMode = (dialog: HTMLElement, mode: 'file' | 'headings'): HTMLInputElement => {
    const radio = dialog.querySelector(`#link-mode-${mode}`) as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    return dialog.querySelector('#link-url-input') as HTMLInputElement;
  };

  afterEach(() => {
    l10n.resetL10n();
  });

  it('shows English when no bundle is loaded', () => {
    const dialog = createLinkDialog();

    expect(dialog.getAttribute('aria-label')).toBe('Insert/Edit Link');
    expect(dialogText(dialog, '#link-dialog-title')).toBe('Insert Link');
    expect(dialogText(dialog, '#link-remove-btn')).toBe('Remove Link');
    expect(dialogText(dialog, '#link-url-label-text')).toBe('URL');
    expect((dialog.querySelector('#link-text-input') as HTMLInputElement).placeholder).toBe(
      'Text to display'
    );
  });

  it('shows the translated header, labels, tooltips, hints and buttons', () => {
    l10n.configureL10n(sampleBundle);

    const dialog = createLinkDialog();

    const close = dialog.querySelector('.export-settings-overlay-close') as HTMLElement;
    expect(dialog.getAttribute('aria-label')).toBe('插入/编辑链接');
    expect(dialogText(dialog, '#link-dialog-title')).toBe('插入链接');
    expect(close.getAttribute('aria-label')).toBe('关闭对话框');
    expect(close.title).toBe('关闭 (Esc)');
    expect(dialogText(dialog, 'label[for="link-text-input"]')).toBe('链接文字');
    expect((dialog.querySelector('#link-text-input') as HTMLInputElement).placeholder).toBe(
      '显示的文字'
    );
    expect((dialog.querySelector('#link-trim-left-btn') as HTMLElement).title).toBe(
      '左边界缩短一个词'
    );
    expect((dialog.querySelector('#link-expand-left-btn') as HTMLElement).title).toBe(
      '左边界扩展到上一个词'
    );
    expect((dialog.querySelector('#link-expand-right-btn') as HTMLElement).title).toBe(
      '右边界扩展到下一个词'
    );
    expect((dialog.querySelector('#link-trim-right-btn') as HTMLElement).title).toBe(
      '右边界缩短一个词'
    );
    expect(dialog.textContent).toContain('将显示在文档中的文字');
    expect(dialog.textContent).toContain('网址或文件路径');
    expect(dialogText(dialog, '#link-mode-url + span')).toBe('网址');
    expect(dialogText(dialog, '#link-mode-file + span')).toBe('文件');
    expect(dialogText(dialog, '#link-mode-headings + span')).toBe('标题');
    expect(dialogText(dialog, '#link-url-label-text')).toBe('网址');
    expect(dialogText(dialog, '#link-filter-all + span')).toBe('全部');
    expect(dialogText(dialog, '#link-filter-images + span')).toBe('图片');
    expect(dialogText(dialog, '#link-remove-btn')).toBe('移除链接');
    expect(dialogText(dialog, '#link-cancel-btn')).toBe('取消');
    // Not in the bundle: falls back to English.
    expect(dialogText(dialog, '#link-ok-btn')).toBe('OK');
    // Example input is not text to translate.
    expect((dialog.querySelector('#link-url-input') as HTMLInputElement).placeholder).toBe(
      'https://example.com'
    );
  });

  it('translates the title for an existing link and the placeholder and label of each mode', () => {
    l10n.configureL10n(sampleBundle);
    mockGetMarkRange.mockReturnValue(null);
    const dialog = createLinkDialog();

    showLinkDialog(
      createMockEditor({ getAttributes: jest.fn(() => ({ href: 'https://example.com' })) })
    );
    expect(dialogText(dialog, '#link-dialog-title')).toBe('编辑链接');

    const urlInput = openMode(dialog, 'file');
    expect(urlInput.placeholder).toBe('开始输入以搜索文件...');
    expect(dialogText(dialog, '#link-url-label-text')).toBe('文件');

    openMode(dialog, 'headings');
    expect(urlInput.placeholder).toBe('从下方列表选择标题');
    expect(dialogText(dialog, '#link-url-label-text')).toBe('标题项');
  });

  it('translates the empty states of the file and heading lists', () => {
    l10n.configureL10n(sampleBundle);
    jest.useFakeTimers();
    const postMessage = jest.fn();
    (window as unknown as { vscode: { postMessage: jest.Mock } }).vscode = { postMessage };
    try {
      mockGetMarkRange.mockReturnValue(null);
      const dialog = createLinkDialog();
      const doc = { textBetween: jest.fn(() => ''), descendants: jest.fn(), content: { size: 0 } };
      const selection = { from: 0, to: 0, empty: true, $from: {} as unknown };
      const schema = { marks: { link: {} as unknown } };
      showLinkDialog(createMockEditor({ state: { selection, schema, doc } as unknown }));

      const urlInput = openMode(dialog, 'file');
      urlInput.value = '';
      urlInput.dispatchEvent(new Event('input'));
      expect(dialogText(dialog, '.link-dialog-autocomplete-empty')).toBe('开始输入以搜索文件...');

      urlInput.value = 'a';
      urlInput.dispatchEvent(new Event('input'));
      jest.advanceTimersByTime(300);
      handleFileSearchResults([], postMessage.mock.calls.at(-1)?.[0].requestId);
      expect(dialogText(dialog, '.link-dialog-autocomplete-empty')).toBe('未找到文件');

      openMode(dialog, 'headings').dispatchEvent(new Event('focus'));
      expect(dialogText(dialog, '.link-dialog-autocomplete-empty')).toBe('此文档中没有标题');
    } finally {
      delete (window as unknown as { vscode?: unknown }).vscode;
      jest.useRealTimers();
    }
  });
});
