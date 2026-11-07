/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import type { Editor } from '@tiptap/core';
import {
  createSourceLossGuard,
  type SourceLossGuard,
} from '../../webview/features/sourceLossGuard';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';
import { createProductionEditor } from '../helpers/productionEditor';

interface Harness {
  editor: Editor;
  guard: SourceLossGuard;
  openSourceView: jest.Mock;
  load(markdown: string): void;
  /** Type at the end of the first text of a top-level block. */
  typeIn(blockIndex: number, text?: string): boolean;
  banner(): HTMLElement | null;
  button(label: string): HTMLButtonElement;
}

function createHarness(schedule: (run: () => void) => void = run => run()): Harness {
  const editor = createProductionEditor();
  const openSourceView = jest.fn();
  const guard = createSourceLossGuard({
    editor,
    getBlankLineMode: () => 'strip',
    openSourceView,
    schedule,
  });
  const banner = (): HTMLElement | null => document.querySelector('.source-loss-banner');
  return {
    editor,
    guard,
    openSourceView,
    load(markdown) {
      guard.beforeLoad();
      // As on first open: loading is not an edit, so Undo cannot step back past it.
      setMarkdownContentPreservingSource(editor, markdown, { addToHistory: false });
      guard.documentLoaded(markdown);
    },
    typeIn(blockIndex, text = 'ZZ') {
      let end = -1;
      editor.state.doc.descendants((node, position) => {
        if (
          end === -1 &&
          node.isText &&
          editor.state.doc.resolve(position).index(0) === blockIndex
        ) {
          end = position + node.nodeSize;
        }
        return end === -1;
      });
      if (end === -1) throw new Error(`No text in block ${blockIndex}`);
      return editor.commands.insertContentAt(end, text);
    },
    banner,
    button(label) {
      const found = [...(banner()?.querySelectorAll('button') ?? [])].find(
        candidate => candidate.textContent === label
      );
      if (!found) throw new Error(`No button "${label}"`);
      return found;
    },
  };
}

const WITH_VIDEO = '# Title\n\n<video src="demo.mp4" controls></video>\n\nTail paragraph.';
const WITH_MARK = '# Title\n\nSome <mark>marked</mark> and <u>under</u> text.\n\nTail paragraph.';
const WITH_ESCAPE = '# Title\n\nNot \\*italic\\* here.\n\nAlso \\_not\\_ this.\n\nTail paragraph.';

describe('source loss guard', () => {
  let harness: Harness;

  afterEach(() => {
    harness.guard.destroy();
    harness.editor.destroy();
    document.body.replaceChildren();
  });

  describe('content no block holds', () => {
    it('names the content and keeps the document from being edited', () => {
      harness = createHarness();
      harness.load(WITH_VIDEO);

      expect(harness.banner()?.getAttribute('role')).toBe('alert');
      expect(harness.banner()?.textContent).toContain(
        'This file has content the editor cannot keep: <video>. Any edit here removes it from the file.'
      );
      harness.typeIn(0);
      expect(harness.editor.state.doc.firstChild?.textContent).toBe('Title');
    });

    it('lets the user edit after "Edit anyway" and removes the banner', () => {
      harness = createHarness();
      harness.load(WITH_VIDEO);
      harness.button('Edit anyway').click();

      expect(harness.banner()).toBeNull();
      harness.typeIn(0);
      expect(harness.editor.state.doc.firstChild?.textContent).toBe('TitleZZ');
    });

    it('reports the lock, so a save from this view can be kept from rewriting the file', () => {
      harness = createHarness();
      harness.load(WITH_VIDEO);
      expect(harness.guard.isLocked()).toBe(true);

      harness.button('Edit anyway').click();
      expect(harness.guard.isLocked()).toBe(false);
    });

    it('reports the lock even when the idle scan has not run', () => {
      harness = createHarness(() => {});
      harness.load(WITH_VIDEO);

      expect(harness.guard.isLocked()).toBe(true);
    });

    it('reports no lock for a document it can keep', () => {
      harness = createHarness();
      harness.load('# Clean\n\nNothing special.');

      expect(harness.guard.isLocked()).toBe(false);
    });

    it('opens the source view and stays read-only', () => {
      harness = createHarness();
      harness.load(WITH_VIDEO);
      harness.button('Open source view (split)').click();

      expect(harness.openSourceView).toHaveBeenCalledTimes(1);
      harness.typeIn(0);
      expect(harness.editor.state.doc.firstChild?.textContent).toBe('Title');
    });

    it('accepts new content from the host while read-only, and checks it again', () => {
      harness = createHarness();
      harness.load(WITH_VIDEO);
      harness.load('# Clean\n\nNothing special.');

      expect(harness.editor.state.doc.firstChild?.textContent).toBe('Clean');
      expect(harness.banner()).toBeNull();
      harness.typeIn(0);
      expect(harness.editor.state.doc.firstChild?.textContent).toBe('CleanZZ');
    });

    it('stays out of the way for a document it can keep', () => {
      harness = createHarness();
      harness.load(
        '# Title\n\nPress <kbd>Ctrl</kbd>.\n\n<!-- note -->\n\nSee [a].\n\n[a]: https://a.example'
      );

      expect(harness.banner()).toBeNull();
      harness.typeIn(1);
      expect(harness.banner()).toBeNull();
    });

    it('checks before the first edit even when the idle scan has not run', () => {
      harness = createHarness(() => undefined);
      harness.load(WITH_VIDEO);
      expect(harness.banner()).toBeNull();

      harness.typeIn(0);
      expect(harness.editor.state.doc.firstChild?.textContent).toBe('Title');
      expect(harness.banner()?.textContent).toContain('<video>');
    });
  });

  describe('a block that loses tags when edited', () => {
    it('lets the edit through and names what it removed', () => {
      harness = createHarness();
      harness.load(WITH_MARK);
      expect(harness.banner()).toBeNull();

      harness.typeIn(1);
      const saved = getEditorMarkdownForSync(harness.editor);
      expect(saved).toContain('ZZ');
      expect(saved).not.toContain('<mark>');
      expect(harness.banner()?.getAttribute('role')).toBe('status');
      expect(harness.banner()?.textContent).toContain(
        'This edit removed <mark> and <u> from the block, because the editor cannot keep them.'
      );
    });

    it('restores the block with Undo and removes the banner', () => {
      harness = createHarness();
      harness.load(WITH_MARK);
      harness.typeIn(1);
      harness.button('Undo').click();

      expect(harness.banner()).toBeNull();
      expect(getEditorMarkdownForSync(harness.editor)).toBe(WITH_MARK);
    });

    it('keeps the notice when Undo steps back an edit in another block', () => {
      harness = createHarness();
      harness.load(WITH_MARK);
      harness.typeIn(1);
      harness.typeIn(2);
      harness.button('Undo').click();

      expect(getEditorMarkdownForSync(harness.editor)).not.toContain('<mark>');
      expect(harness.banner()?.textContent).toContain('<mark>');
    });

    it('removes the notice once Undo has restored the block', () => {
      harness = createHarness();
      harness.load(WITH_MARK);
      harness.typeIn(1);
      harness.typeIn(2);
      harness.button('Undo').click();
      harness.button('Undo').click();

      expect(harness.banner()).toBeNull();
      expect(getEditorMarkdownForSync(harness.editor)).toBe(WITH_MARK);
    });

    it('warns again when the block is edited again after an undo', () => {
      harness = createHarness();
      harness.load(WITH_MARK);
      harness.typeIn(1);
      harness.button('Undo').click();
      harness.typeIn(1);

      expect(harness.banner()?.textContent).toContain('<mark>');
    });

    it('says nothing when another block is edited', () => {
      harness = createHarness();
      harness.load(WITH_MARK);
      harness.typeIn(2);

      expect(harness.banner()).toBeNull();
      expect(getEditorMarkdownForSync(harness.editor)).toBe(`${WITH_MARK}ZZ`);
    });

    it('closes on request', () => {
      harness = createHarness();
      harness.load(WITH_MARK);
      harness.typeIn(1);
      harness.button('Close').click();

      expect(harness.banner()).toBeNull();
    });

    it('checks before the first edit even when the idle scan has not run', () => {
      harness = createHarness(() => undefined);
      harness.load(WITH_MARK);
      harness.typeIn(1);

      expect(harness.banner()?.textContent).toContain('<mark>');
    });
  });

  describe('a block that reads differently when edited', () => {
    it('warns in general terms', () => {
      harness = createHarness();
      harness.load(WITH_ESCAPE);
      harness.typeIn(1);

      expect(harness.banner()?.textContent).toContain(
        'This edit changed how the block reads in the file, because the editor rewrote its Markdown.'
      );
    });

    it('does not warn again in this document once the warning was closed', () => {
      harness = createHarness();
      harness.load(WITH_ESCAPE);
      harness.typeIn(1);
      harness.button('Close').click();
      harness.typeIn(2);

      expect(harness.banner()).toBeNull();
    });

    it('still names removed tags after the general warning was closed', () => {
      harness = createHarness();
      harness.load(`${WITH_ESCAPE}\n\nA <mark>b</mark> c.`);
      harness.typeIn(1);
      harness.button('Close').click();
      harness.typeIn(4);

      expect(harness.banner()?.textContent).toContain('<mark>');
    });
  });
});
