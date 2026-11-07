/** @jest-environment jsdom */

/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 *
 * Text owned by the webview entry file: the Feedback More menu, toasts and the
 * editor load failure block. Drives the real editor.ts handlers; TipTap's
 * Editor is replaced so initialization fails the same way every run.
 */

import * as l10n from '../../webview/l10n';

jest.mock('@tiptap/core', () => ({
  ...jest.requireActual('@tiptap/core'),
  Editor: jest.fn(() => {
    throw new Error('Schema <broken>');
  }),
}));

type TestingModule = {
  setMockEditor(editor: unknown): void;
  setFeedbackReviewControllerForTests(controller: unknown): void;
  setFeedbackPeerLockControllerForTests(controller: unknown): void;
};

const flushTask = (): Promise<void> => new Promise(resolve => window.setTimeout(resolve, 0));

async function toastMessages(): Promise<string[]> {
  // Toasts are shown from a dynamic import of the overlay module.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const messages = [...document.querySelectorAll('.toast-message')].map(
      toast => toast.textContent ?? ''
    );
    if (messages.length > 0) return messages;
    await flushTask();
  }
  return [];
}

describe('webview entry localization', () => {
  let testing: TestingModule;
  let postMessage: jest.Mock;

  beforeAll(async () => {
    postMessage = jest.fn();
    (global as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
      postMessage,
      getState: jest.fn(),
      setState: jest.fn(),
    });
    testing = (await import('../../webview/editor')).__testing as unknown as TestingModule;
  });

  beforeEach(() => {
    document.body.innerHTML =
      '<div class="formatting-toolbar"><div class="feedback-toolbar-group" data-feedback-toolbar-group>' +
      '<div class="feedback-more-menu-host" data-feedback-menu-host>' +
      '<button type="button" data-feedback-more aria-expanded="false">More</button></div></div></div>' +
      '<div id="editor"></div>';
    testing.setMockEditor(null);
    testing.setFeedbackReviewControllerForTests(null);
    testing.setFeedbackPeerLockControllerForTests(null);
  });

  afterEach(() => {
    l10n.resetL10n();
    jest.restoreAllMocks();
  });

  function openMoreMenu(): HTMLElement {
    testing.setFeedbackReviewControllerForTests({
      getSession: () => ({ sessionId: 'session-1' }),
      reveal: jest.fn(),
      copyDiagnostics: jest.fn(),
    });
    window.dispatchEvent(new CustomEvent('feedbackMoreRequested'));
    return document.querySelector<HTMLElement>('.feedback-more-menu')!;
  }

  function failEditorLoad(): HTMLElement {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'update', content: '# Title\n' } })
    );
    return document.querySelector<HTMLElement>('#editor')!;
  }

  it('shows English text when no translation is loaded', () => {
    const menu = openMoreMenu();
    expect(menu.getAttribute('aria-label')).toBe('More feedback actions');
    expect([...menu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual([
      'Reveal feedback file',
      'Copy diagnostics',
    ]);

    const failure = failEditorLoad();
    expect(failure.querySelector('h3')?.textContent).toBe('Error Loading Editor');
    expect(failure.textContent).toContain('Please check the Debug Console for details.');
  });

  it('translates the Feedback More menu', () => {
    l10n.configureL10n({
      'More feedback actions': 'Weitere Feedback-Aktionen',
      'Reveal feedback file': 'Feedback-Datei anzeigen',
      'Copy diagnostics': 'Diagnose kopieren',
    });

    const menu = openMoreMenu();

    expect(menu.getAttribute('aria-label')).toBe('Weitere Feedback-Aktionen');
    expect([...menu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual([
      'Feedback-Datei anzeigen',
      'Diagnose kopieren',
    ]);
  });

  it('translates the editor load failure block and escapes the translation', () => {
    l10n.configureL10n({
      'Error Loading Editor': 'Fehler <beim> Laden',
      'Please check the Debug Console for details.': 'Details in der Debug-Konsole.',
    });

    const failure = failEditorLoad();

    expect(failure.querySelector('h3')?.textContent).toBe('Fehler <beim> Laden');
    expect(failure.querySelector('h3')?.children).toHaveLength(0);
    expect(failure.textContent).toContain('Details in der Debug-Konsole.');
  });

  it('translates a toast and keeps the setting key in its placeholder', async () => {
    l10n.configureL10n({
      'Feedback is active in another editor split. Finish it there before editing here.':
        'Feedback ist in einer anderen Ansicht aktiv.',
      'Math rendering is disabled. Enable "{0}" in settings.':
        'Formeln sind aus. Aktivieren Sie "{0}" in den Einstellungen.',
    });
    testing.setFeedbackPeerLockControllerForTests({ isLocked: () => true });

    window.dispatchEvent(new CustomEvent('feedbackStartRequested'));
    expect(await toastMessages()).toEqual(['Feedback ist in einer anderen Ansicht aktiv.']);

    document.getElementById('toast-container')?.remove();
    testing.setMockEditor({ isDestroyed: false });
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'settingsUpdate', enableMath: false } })
    );
    window.dispatchEvent(new CustomEvent('insertMath', { detail: { mode: 'inline' } }));

    expect(await toastMessages()).toContain(
      'Formeln sind aus. Aktivieren Sie "markdownForHumans.enableMath" in den Einstellungen.'
    );
  });
});
