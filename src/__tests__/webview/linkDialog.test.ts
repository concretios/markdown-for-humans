/**
 * @jest-environment jsdom
 */

import { getMarkRange, Editor } from '@tiptap/core';
import { hideLinkDialog, showLinkDialog } from '../../webview/features/linkDialog';

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
});
