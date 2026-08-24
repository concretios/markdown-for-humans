/** @jest-environment jsdom */

import { createFeedbackDiscardDialog } from '../../webview/features/feedbackDiscardDialog';

describe('Feedback discard confirmation dialog', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps editing by default, contains focus, and restores the suspended draft', async () => {
    const draft = document.createElement('form');
    const field = document.createElement('textarea');
    draft.append(field);
    const backgroundAction = document.createElement('button');
    document.body.append(draft, backgroundAction);
    field.focus();
    const nativeFieldFocus = field.focus.bind(field);
    const fieldFocus = jest.spyOn(field, 'focus').mockImplementation(options => {
      nativeFieldFocus(options);
    });

    const confirmation = createFeedbackDiscardDialog({
      description: 'Your unfinished comment will be lost.',
      returnFocus: field,
      suspendedSurface: draft,
    });
    const keep = confirmation.element.querySelector<HTMLButtonElement>(
      '[data-feedback-discard-keep]'
    )!;
    const discard = confirmation.element.querySelector<HTMLButtonElement>(
      '[data-feedback-discard-confirm]'
    )!;

    expect(confirmation.element.getAttribute('role')).toBe('dialog');
    expect(confirmation.element.getAttribute('aria-modal')).toBe('true');
    expect(confirmation.element.hasAttribute('data-md4h-modal')).toBe(true);
    expect(draft.inert).toBe(true);
    expect(draft.getAttribute('aria-hidden')).toBe('true');
    expect(backgroundAction.inert).toBe(true);
    expect(document.activeElement).toBe(keep);

    const backgroundWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true });
    confirmation.element.dispatchEvent(backgroundWheel);
    expect(backgroundWheel.defaultPrevented).toBe(true);
    const pageDown = new KeyboardEvent('keydown', {
      key: 'PageDown',
      bubbles: true,
      cancelable: true,
    });
    confirmation.element.dispatchEvent(pageDown);
    expect(pageDown.defaultPrevented).toBe(true);

    discard.focus();
    discard.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(keep);
    keep.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(discard);

    keep.click();
    await expect(confirmation.result).resolves.toBe(false);
    expect(confirmation.element.isConnected).toBe(false);
    expect(draft.inert).toBe(false);
    expect(draft.hasAttribute('aria-hidden')).toBe(false);
    expect(backgroundAction.inert).toBe(false);
    expect(document.activeElement).toBe(field);
    expect(fieldFocus).toHaveBeenLastCalledWith({ preventScroll: true });
    fieldFocus.mockRestore();
  });

  it('confirms discard without refocusing content the caller is about to close', async () => {
    const draft = document.createElement('section');
    draft.inert = true;
    draft.setAttribute('aria-hidden', 'false');
    const field = document.createElement('textarea');
    draft.append(field);
    document.body.append(draft);

    const confirmation = createFeedbackDiscardDialog({
      description: 'Your unfinished screenshot feedback will be lost.',
      confirmLabel: 'Discard screenshot',
      returnFocus: field,
      suspendedSurface: draft,
    });
    confirmation.element
      .querySelector<HTMLButtonElement>('[data-feedback-discard-confirm]')
      ?.click();

    await expect(confirmation.result).resolves.toBe(true);
    expect(draft.inert).toBe(true);
    expect(draft.getAttribute('aria-hidden')).toBe('false');
    expect(document.activeElement).not.toBe(field);
  });

  it('treats Escape as Keep editing and restores focus without scrolling', async () => {
    const field = document.createElement('textarea');
    document.body.append(field);
    field.focus();
    const confirmation = createFeedbackDiscardDialog({
      description: 'Your unfinished comment will be lost.',
      returnFocus: field,
    });

    confirmation.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );

    await expect(confirmation.result).resolves.toBe(false);
    expect(document.activeElement).toBe(field);
  });

  it('can be destroyed by an enclosing lifecycle without restoring stale focus', async () => {
    const field = document.createElement('textarea');
    document.body.append(field);
    field.focus();
    const confirmation = createFeedbackDiscardDialog({
      description: 'Your unfinished comment will be lost.',
      returnFocus: field,
    });

    confirmation.destroy();

    await expect(confirmation.result).resolves.toBe(false);
    expect(confirmation.element.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(field);
  });
});
