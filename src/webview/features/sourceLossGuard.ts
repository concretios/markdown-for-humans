/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * @file sourceLossGuard.ts - Tell the user before and when an edit drops source text
 * @description The rich view cannot hold every piece of Markdown. This guard
 *              compares what was loaded with what the editor would write, and
 *              makes the difference visible instead of silent.
 *
 * Key responsibilities:
 * - Content no block holds (any edit removes it): banner, and the document
 *   stays read-only until the user chooses to edit anyway
 * - A block that loses tags, comments or definitions when edited: let the edit
 *   through, then name what was removed and offer Undo
 * - A block that only reads differently afterwards: one general warning per
 *   document, until it is closed
 */

import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { applyBlankLinePolicy, type BlankLineMode } from '../../shared/blankLinePolicy';
import { describeSourceLoss, lostTokenNames, type SourceLoss } from '../../shared/sourceLoss';
import * as l10n from '../l10n';
import { getEditorMarkdownForSync } from '../utils/markdownSerialization';
import { findFragileBlocks, renderForComparison } from '../utils/sourceFidelity';

export interface SourceLossGuardOptions {
  editor: Editor;
  getBlankLineMode: () => BlankLineMode;
  /** Open the document in VS Code's text editor beside this one. */
  openSourceView: () => void;
  /** Runs the scan off the load path. Defaults to idle time. */
  schedule?: (run: () => void) => void;
}

export interface SourceLossGuard {
  /** Call right before the host's Markdown replaces the document. */
  beforeLoad(): void;
  /** Call right after it did, with that Markdown. */
  documentLoaded(source: string): void;
  /**
   * The file has content no block holds and the user has not chosen to edit
   * anyway. Writing this view's Markdown now, even unedited, removes it.
   */
  isLocked(): boolean;
  destroy(): void;
}

interface TrackedBlock {
  node: ProseMirrorNode;
  index: number;
  loss: SourceLoss;
  /** The block no longer saves its authored source. */
  edited: boolean;
}

const sourceLossGuardPluginKey = new PluginKey('md4hSourceLossGuard');

function scheduleWhenIdle(run: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 0);
}

/** `Intl.ListFormat`, which this project's TypeScript library target does not declare. */
type ListFormatConstructor = new (
  locale: string,
  options: { style: 'long'; type: 'conjunction' }
) => { format(items: string[]): string };

/** Join names the way the display language lists things: "<mark> and <u>". */
function formatNameList(names: string[]): string {
  const ListFormat = (Intl as unknown as { ListFormat?: ListFormatConstructor }).ListFormat;
  for (const language of [document.documentElement.lang || 'en-US', 'en-US']) {
    try {
      if (ListFormat)
        return new ListFormat(language, { style: 'long', type: 'conjunction' }).format(names);
    } catch {
      // An id the runtime rejects must not hide the warning; try English.
    }
  }
  return names.join(', ');
}

/**
 * Watch one editor for source text it is about to lose.
 *
 * @param options - The editor, its blank-line setting and the source view action
 * @returns Hooks for the two moments the host replaces the document
 */
export function createSourceLossGuard(options: SourceLossGuardOptions): SourceLossGuard {
  const { editor, getBlankLineMode, openSourceView } = options;
  const schedule = options.schedule ?? scheduleWhenIdle;

  let source = '';
  let loading = false;
  let scanPending = false;
  let scanGeneration = 0;
  /** Content no block holds is present and the user has not chosen to edit anyway. */
  let locked = false;
  let tracked: TrackedBlock[] = [];
  let generalWarningClosed = false;
  let banner: HTMLElement | null = null;
  let bannerKind: 'unheld' | 'named' | 'general' | null = null;

  const hideBanner = (): void => {
    banner?.remove();
    banner = null;
    bannerKind = null;
  };

  const showBanner = (
    kind: 'unheld' | 'named' | 'general',
    message: string,
    actions: Array<{ label: string; run: () => void }>
  ): void => {
    hideBanner();
    banner = document.createElement('section');
    banner.className = 'source-loss-banner';
    // Read-only content is urgent; a note about an edit that went through is not.
    banner.setAttribute('role', kind === 'unheld' ? 'alert' : 'status');
    const text = document.createElement('span');
    text.className = 'source-loss-banner-message';
    text.textContent = message;
    banner.append(text);
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'source-loss-banner-action';
      button.textContent = action.label;
      button.addEventListener('click', action.run);
      banner.append(button);
    }
    bannerKind = kind;
    document.body.append(banner);
  };

  const sourceViewAction = { label: l10n.t('Open source view (split)'), run: openSourceView };

  const showUnheld = (loss: SourceLoss): void => {
    showBanner(
      'unheld',
      l10n.t(
        'This file has content the editor cannot keep: {0}. Any edit here removes it from the file.',
        formatNameList(lostTokenNames(loss.lost))
      ),
      [
        sourceViewAction,
        {
          label: l10n.t('Edit anyway'),
          run: () => {
            locked = false;
            hideBanner();
          },
        },
      ]
    );
  };

  const undoAction = {
    label: l10n.t('Undo'),
    run: (): void => {
      editor.commands.undo();
      // One step back may have undone a different edit. Keep the notice until
      // every tracked block saves its authored source again.
      if (!tracked.some(block => block.edited)) hideBanner();
    },
  };

  const showNamed = (names: string[]): void => {
    showBanner(
      'named',
      names.length === 1
        ? l10n.t(
            'This edit removed {0} from the block, because the editor cannot keep it.',
            names[0]
          )
        : l10n.t(
            'This edit removed {0} from the block, because the editor cannot keep them.',
            formatNameList(names)
          ),
      [undoAction, sourceViewAction, { label: l10n.t('Close'), run: hideBanner }]
    );
  };

  const showGeneral = (): void => {
    showBanner(
      'general',
      l10n.t(
        'This edit changed how the block reads in the file, because the editor rewrote its Markdown.'
      ),
      [
        undoAction,
        sourceViewAction,
        {
          label: l10n.t('Close'),
          run: () => {
            generalWarningClosed = true;
            hideBanner();
          },
        },
      ]
    );
  };

  /** Compare the loaded Markdown with what the editor would write, before any edit. */
  const scan = (): void => {
    scanPending = false;
    const mode = getBlankLineMode();
    const asWritten = (markdown: string): string =>
      applyBlankLinePolicy(markdown.replace(/\r\n?/g, '\n'), mode).replace(/\n+$/, '');

    const unheld = describeSourceLoss(
      asWritten(source),
      asWritten(getEditorMarkdownForSync(editor, mode))
    );
    if (unheld !== null && unheld.lost.length > 0) {
      locked = true;
      showUnheld(unheld);
    }

    const { doc } = editor.state;
    tracked = findFragileBlocks(editor, renderForComparison).map(block => ({
      node: doc.child(block.index),
      index: block.index,
      loss: block.loss,
      edited: false,
    }));
  };

  /** After a change, find tracked blocks that stopped or resumed saving their authored source. */
  const onDocumentChanged = (): void => {
    if (tracked.length === 0) return;
    const { doc } = editor.state;
    const present = new Set<ProseMirrorNode>();
    doc.forEach(child => present.add(child));

    const newlyEdited: TrackedBlock[] = [];
    let restored = false;
    for (const block of tracked) {
      let intact = present.has(block.node);
      if (!intact && block.index < doc.childCount && block.node.eq(doc.child(block.index))) {
        // Undone, or typed back: the serializer writes the authored source again.
        block.node = doc.child(block.index);
        intact = true;
      }
      if (!intact && !block.edited) {
        block.edited = true;
        newlyEdited.push(block);
      } else if (intact && block.edited) {
        block.edited = false;
        restored = true;
      }
    }

    const names = lostTokenNames(newlyEdited.flatMap(block => block.loss.lost));
    if (names.length > 0) {
      showNamed(names);
    } else if (newlyEdited.length > 0) {
      if (!generalWarningClosed && bannerKind !== 'named') showGeneral();
    } else if (restored && bannerKind !== 'unheld' && !tracked.some(block => block.edited)) {
      hideBanner();
    }
  };

  const plugin = new Plugin({
    key: sourceLossGuardPluginKey,
    filterTransaction: transaction => {
      if (!transaction.docChanged || loading) return true;
      // The user may type before idle time comes. The state here is still the
      // one from before this edit, which is what the scan has to see.
      if (scanPending) scan();
      return !locked;
    },
  });
  editor.registerPlugin(plugin);

  const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }): void => {
    if (transaction.docChanged && !loading) onDocumentChanged();
  };
  editor.on('transaction', onTransaction);

  return {
    beforeLoad() {
      loading = true;
      scanPending = false;
      locked = false;
      tracked = [];
      hideBanner();
    },
    documentLoaded(loadedSource) {
      source = loadedSource;
      loading = false;
      scanPending = true;
      scanGeneration += 1;
      const generation = scanGeneration;
      schedule(() => {
        if (generation === scanGeneration && scanPending && !editor.isDestroyed) scan();
      });
    },
    isLocked() {
      // A save can come before idle time does.
      if (scanPending && !loading) scan();
      return locked;
    },
    destroy() {
      scanGeneration += 1;
      scanPending = false;
      editor.off('transaction', onTransaction);
      if (!editor.isDestroyed) editor.unregisterPlugin(sourceLossGuardPluginKey);
      hideBanner();
    },
  };
}
