/** @jest-environment jsdom */

/**
 * The Feedback More menu registers its outside-pointer listener one task after
 * it opens, so the opening click cannot close it. That deferred registration must
 * not outlive the menu, and a toolbar re-render that removes the menu must close
 * it and keep keyboard focus on the re-rendered More button. A Start command
 * that closes the focused menu returns focus to the More button without
 * scrolling. Drives the real editor.ts handlers without initializing TipTap.
 */

type TestingModule = {
  setFeedbackReviewControllerForTests(controller: unknown): void;
};

const flushTask = (): Promise<void> => new Promise(resolve => window.setTimeout(resolve, 0));

function renderFeedbackGroup(): HTMLElement {
  const group = document.createElement('div');
  group.className = 'feedback-toolbar-group';
  group.setAttribute('data-feedback-toolbar-group', '');
  group.innerHTML =
    '<div class="feedback-more-menu-host" data-feedback-menu-host>' +
    '<button type="button" data-feedback-more aria-expanded="false">More</button></div>';
  return group;
}

describe('Feedback More menu', () => {
  let testing: TestingModule;
  let toolbar: HTMLElement;
  const capturedPointerListeners = new Set<EventListenerOrEventListenerObject>();
  const addListener = document.addEventListener.bind(document);
  const removeListener = document.removeEventListener.bind(document);

  const openMenu = (): void => {
    window.dispatchEvent(new CustomEvent('feedbackMoreRequested'));
  };

  beforeAll(async () => {
    (global as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
      postMessage: jest.fn(),
      getState: jest.fn(),
      setState: jest.fn(),
    });
    testing = (await import('../../webview/editor')).__testing as unknown as TestingModule;
    jest.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'pointerdown' && options === true && listener) {
        capturedPointerListeners.add(listener);
      }
      addListener(type, listener, options);
    });
    jest.spyOn(document, 'removeEventListener').mockImplementation((type, listener, options) => {
      if (type === 'pointerdown' && options === true && listener) {
        capturedPointerListeners.delete(listener);
      }
      removeListener(type, listener, options);
    });
  });

  beforeEach(() => {
    document.body.innerHTML = '<div class="formatting-toolbar"></div>';
    toolbar = document.querySelector<HTMLElement>('.formatting-toolbar')!;
    toolbar.append(renderFeedbackGroup());
    testing.setFeedbackReviewControllerForTests({
      getSession: () => ({ sessionId: 'session-1' }),
      reveal: jest.fn(),
      copyDiagnostics: jest.fn(),
    });
  });

  afterEach(async () => {
    document
      .querySelector('.feedback-more-menu')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushTask();
    capturedPointerListeners.forEach(listener => removeListener('pointerdown', listener, true));
    capturedPointerListeners.clear();
  });

  it('does not let a menu that closed before its deferred listener close the next menu', async () => {
    openMenu();
    document
      .querySelector('.feedback-more-menu')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.feedback-more-menu')).toBeNull();
    // The closed menu's deferred registration runs in this task.
    await flushTask();

    openMenu();
    await flushTask();
    const menu = document.querySelector<HTMLElement>('.feedback-more-menu')!;
    menu
      .querySelector('[role="menuitem"]')!
      .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));

    expect(menu.isConnected).toBe(true);
    expect(document.querySelector('[data-feedback-more]')!.getAttribute('aria-expanded')).toBe(
      'true'
    );
    expect(capturedPointerListeners.size).toBe(1);
  });

  it('closes the menu and drops its listener when a toolbar re-render removes it', async () => {
    openMenu();
    await flushTask();
    expect(capturedPointerListeners.size).toBe(1);

    // A Feedback toolbar re-render replaces the group that hosts the menu.
    toolbar.replaceChildren(renderFeedbackGroup());
    // MutationObserver records are delivered as a microtask.
    await Promise.resolve();

    expect(document.querySelector('.feedback-more-menu')).toBeNull();
    expect(capturedPointerListeners.size).toBe(0);
  });

  it('moves focus to the re-rendered More button when a re-render removes the focused menu', async () => {
    openMenu();
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem');

    toolbar.replaceChildren(renderFeedbackGroup());
    await Promise.resolve();

    expect(document.activeElement).toBe(document.querySelector('[data-feedback-more]'));
  });

  it('keeps focus on the More button, without scrolling, when Start runs during a session', () => {
    const handleHostMessage = jest.fn();
    testing.setFeedbackReviewControllerForTests({
      getSession: () => ({ sessionId: 'session-1' }),
      reveal: jest.fn(),
      copyDiagnostics: jest.fn(),
      handleHostMessage,
    });
    openMenu();
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
    const more = document.querySelector<HTMLButtonElement>('[data-feedback-more]')!;
    const initialScrollTop = 900;
    document.documentElement.scrollTop = initialScrollTop;
    const nativeFocus = HTMLButtonElement.prototype.focus;
    const focusSpy = jest.spyOn(HTMLButtonElement.prototype, 'focus').mockImplementation(function (
      this: HTMLButtonElement,
      options?: FocusOptions
    ) {
      nativeFocus.call(this, options);
      // Model the browser's default focus scrolling; the toolbar is sticky.
      if (!options?.preventScroll) document.documentElement.scrollTop = 0;
    });

    try {
      // The Command Palette and keybindings send Start as a host command. A Start
      // during a session is a no-op, so closing the menu must not drop focus to BODY.
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'feedback.command', command: 'start' } })
      );

      expect(handleHostMessage).toHaveBeenCalledWith({
        type: 'feedback.command',
        command: 'start',
      });
      expect(document.querySelector('.feedback-more-menu')).toBeNull();
      expect(document.activeElement).toBe(more);
      expect(document.documentElement.scrollTop).toBe(initialScrollTop);
    } finally {
      focusSpy.mockRestore();
      document.documentElement.scrollTop = 0;
    }
  });

  it('leaves focus outside the menu in place when Start closes it', () => {
    testing.setFeedbackReviewControllerForTests({
      getSession: () => ({ sessionId: 'session-1' }),
      reveal: jest.fn(),
      copyDiagnostics: jest.fn(),
      handleHostMessage: jest.fn(),
    });
    const card = document.createElement('button');
    card.type = 'button';
    document.body.append(card);
    openMenu();
    // For example, a Next feedback command focuses a card while the menu is open.
    card.focus();

    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'feedback.command', command: 'start' } })
    );

    expect(document.querySelector('.feedback-more-menu')).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it('keeps focus that the re-render moved elsewhere', async () => {
    const undo = document.createElement('button');
    undo.type = 'button';
    document.body.append(undo);
    openMenu();

    // For example, a delete acknowledgement focuses its Undo button.
    toolbar.replaceChildren(renderFeedbackGroup());
    undo.focus();
    await Promise.resolve();

    expect(document.activeElement).toBe(undo);
  });
});
