/**
 * @jest-environment jsdom
 */

import type { Editor } from '@tiptap/core';
import { readFileSync } from 'fs';
import * as path from 'path';
import { createFeedbackPeerLockController } from '../../webview/features/feedbackPeerLock';

const editorCss = readFileSync(path.resolve(__dirname, '../../webview/editor.css'), 'utf8');

function createFixture() {
  document.body.innerHTML = `
    <main id="editor-shell">
      <div class="formatting-toolbar"><button type="button">Bold</button></div>
      <div id="editor"><div class="markdown-editor" contenteditable="true"></div></div>
    </main>
  `;
  const editorDom = document.querySelector('.markdown-editor') as HTMLElement;
  const toolbar = document.querySelector('.formatting-toolbar') as HTMLElement;
  const registeredPlugins: unknown[] = [];
  const editor = {
    view: { dom: editorDom },
    registerPlugin: jest.fn((plugin: unknown) => registeredPlugins.push(plugin)),
    unregisterPlugin: jest.fn(),
    isDestroyed: false,
  } as unknown as Editor;
  const onGoToActiveFeedback = jest.fn();
  const options = { editor, toolbar, onGoToActiveFeedback };
  const controller = createFeedbackPeerLockController(options);
  return { controller, editor, editorDom, toolbar, registeredPlugins, onGoToActiveFeedback };
}

describe('Feedback peer split lock', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.body.className = '';
  });

  it('makes the duplicate rich view explicitly read-only and visibly explains why', () => {
    const { controller, editor, editorDom, toolbar, registeredPlugins } = createFixture();

    controller.lock('lock-1', 'Feedback is active in another editor split.');

    expect(controller.isLocked()).toBe(true);
    expect(controller.getLockId()).toBe('lock-1');
    expect(editor.registerPlugin).toHaveBeenCalledTimes(1);
    expect(registeredPlugins).toHaveLength(1);
    expect(editorDom.getAttribute('aria-readonly')).toBe('true');
    expect(editorDom.getAttribute('tabindex')).toBe('0');
    expect(toolbar.hasAttribute('inert')).toBe(true);
    expect(toolbar.getAttribute('aria-disabled')).toBe('true');
    expect(document.body.classList.contains('feedback-peer-locked')).toBe(true);
    expect(document.querySelector('[data-feedback-peer-lock]')?.textContent).toContain(
      'Feedback is active in another editor split.'
    );
  });

  it('filters document changes while preserving selection-only transactions', () => {
    const { controller, registeredPlugins } = createFixture();
    controller.lock('lock-1', 'Feedback is active elsewhere.');
    const plugin = registeredPlugins[0] as {
      spec: { filterTransaction?: (transaction: { docChanged: boolean }) => boolean };
    };

    expect(plugin.spec.filterTransaction?.({ docChanged: true })).toBe(false);
    expect(plugin.spec.filterTransaction?.({ docChanged: false })).toBe(true);
  });

  it('offers a keyboard-accessible action outside the inert toolbar without unlocking edits', () => {
    const { controller, toolbar, onGoToActiveFeedback } = createFixture();
    controller.lock('session-1', 'Feedback is active in another editor split.');

    const button = document.querySelector<HTMLButtonElement>('[data-feedback-peer-lock] button');
    expect(button?.textContent).toBe('Go to active feedback');
    expect(button?.type).toBe('button');
    expect(button?.disabled).toBe(false);
    expect(button?.closest('[inert]')).toBeNull();
    button?.focus();
    expect(document.activeElement).toBe(button);
    button?.click();

    expect(onGoToActiveFeedback).toHaveBeenCalledWith('session-1');
    expect(toolbar.hasAttribute('inert')).toBe(true);
    expect(controller.isLocked()).toBe(true);
  });

  it('keeps action focus and uses the current token when a peer lock is replaced', () => {
    const { controller, onGoToActiveFeedback } = createFixture();
    controller.lock('session-1', 'Initial session.');
    const button = document.querySelector<HTMLButtonElement>('[data-feedback-peer-lock] button');
    button?.focus();

    controller.lock('session-2', 'Replacement session.');
    expect(document.activeElement).toBe(button);
    expect(document.querySelectorAll('[data-feedback-peer-lock] button')).toHaveLength(1);
    button?.click();
    expect(onGoToActiveFeedback).toHaveBeenCalledWith('session-2');

    controller.unlock('session-2');
    button?.click();
    expect(onGoToActiveFeedback).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'preserves native Tab traversal with shift=%s instead of running editing keymaps',
    shiftKey => {
      const { controller, editorDom } = createFixture();
      const editingKeymap = jest.fn((event: KeyboardEvent) => event.preventDefault());
      editorDom.addEventListener('keydown', editingKeymap);
      controller.lock('session-1', 'Feedback is active elsewhere.');

      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      editorDom.dispatchEvent(event);

      expect(editingKeymap).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
      expect(controller.isLocked()).toBe(true);
    }
  );

  it.each([
    { key: 'Tab', ctrlKey: true },
    { key: 'Tab', metaKey: true },
    { key: 'Tab', altKey: true },
    { key: 'c', metaKey: true },
    { key: 'ArrowLeft' },
  ])('leaves other keyboard shortcuts untouched: %j', key => {
    const { controller, editorDom } = createFixture();
    const keymap = jest.fn();
    editorDom.addEventListener('keydown', keymap);
    controller.lock('session-1', 'Feedback is active elsewhere.');
    const event = new KeyboardEvent('keydown', { ...key, bubbles: true, cancelable: true });

    editorDom.dispatchEvent(event);

    expect(keymap).toHaveBeenCalledWith(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(['unlock', 'destroy'] as const)('restores ordinary Tab keymaps after %s', close => {
    const { controller, editorDom } = createFixture();
    const editingKeymap = jest.fn((event: KeyboardEvent) => event.preventDefault());
    editorDom.addEventListener('keydown', editingKeymap);
    controller.lock('session-1', 'Feedback is active elsewhere.');
    if (close === 'unlock') controller.unlock('session-1');
    else controller.destroy();

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    editorDom.dispatchEvent(event);

    expect(editingKeymap).toHaveBeenCalledWith(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('temporarily admits authoritative host content without unlocking the peer UI', () => {
    const { controller, editor } = createFixture();
    controller.lock('lock-1', 'Feedback is active elsewhere.');
    const applyHostContent = jest.fn(() => 'updated');

    const result = controller.runHostUpdate(applyHostContent);

    expect(result).toBe('updated');
    expect(applyHostContent).toHaveBeenCalledTimes(1);
    expect(editor.unregisterPlugin).toHaveBeenCalledTimes(1);
    expect(editor.registerPlugin).toHaveBeenCalledTimes(2);
    expect(controller.getLockId()).toBe('lock-1');
    expect(document.body.classList.contains('feedback-peer-locked')).toBe(true);
  });

  it('guards mutable DOM controls while still allowing document selection', () => {
    const { controller, editorDom } = createFixture();
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    editorDom.append(checkbox);
    controller.lock('lock-1', 'Feedback is active elsewhere.');

    const change = new Event('change', { bubbles: true, cancelable: true });
    checkbox.dispatchEvent(change);
    const selectionPointer = new Event('pointerdown', { bubbles: true, cancelable: true });
    editorDom.dispatchEvent(selectionPointer);

    expect(change.defaultPrevented).toBe(true);
    expect(selectionPointer.defaultPrevented).toBe(false);
  });

  it('ignores stale unlocks and restores the exact prior accessibility state', () => {
    const { controller, editor, editorDom, toolbar } = createFixture();
    editorDom.setAttribute('aria-readonly', 'mixed');
    editorDom.setAttribute('tabindex', '7');
    toolbar.setAttribute('aria-disabled', 'mixed');

    controller.lock('lock-1', 'First lock.');
    controller.lock('lock-2', 'Replacement lock.');
    controller.unlock('lock-1');

    expect(controller.getLockId()).toBe('lock-2');
    expect(editor.unregisterPlugin).not.toHaveBeenCalled();

    controller.unlock('lock-2');

    expect(controller.isLocked()).toBe(false);
    expect(editor.unregisterPlugin).toHaveBeenCalledTimes(1);
    expect(editorDom.getAttribute('aria-readonly')).toBe('mixed');
    expect(editorDom.getAttribute('tabindex')).toBe('7');
    expect(toolbar.getAttribute('aria-disabled')).toBe('mixed');
    expect(toolbar.hasAttribute('inert')).toBe(false);
    expect(document.body.classList.contains('feedback-peer-locked')).toBe(false);
    expect(document.querySelector('[data-feedback-peer-lock]')).toBeNull();
  });

  it('does not overwrite accessibility state after review mode atomically takes ownership', () => {
    const { controller, editorDom, toolbar } = createFixture();
    controller.lock('peer-session', 'Feedback is active elsewhere.');
    document.body.classList.add('feedback-review-active');
    editorDom.setAttribute('aria-readonly', 'true');
    editorDom.setAttribute('tabindex', '0');
    toolbar.removeAttribute('inert');
    toolbar.removeAttribute('aria-disabled');

    controller.unlock('peer-session');

    expect(controller.isLocked()).toBe(false);
    expect(editorDom.getAttribute('aria-readonly')).toBe('true');
    expect(editorDom.getAttribute('tabindex')).toBe('0');
    expect(toolbar.hasAttribute('inert')).toBe(false);
    expect(toolbar.hasAttribute('aria-disabled')).toBe(false);
  });

  it('keeps peer-lock styling scoped, theme-aware, and high-contrast explicit', () => {
    const banner = editorCss.match(/\.feedback-peer-lock-banner\s*\{[^}]*\}/)?.[0] ?? '';

    expect(banner).toMatch(/var\(--vscode-notifications-background/);
    expect(banner).toMatch(/var\(--vscode-notifications-border/);
    expect(editorCss).toMatch(/\.feedback-peer-locked\s+\.markdown-editor/);
    expect(editorCss).not.toMatch(/^\.markdown-editor\s*\{[^}]*caret-color:\s*transparent/m);
    expect(editorCss).toMatch(
      /vscode-high-contrast\.feedback-peer-locked[\s\S]*?box-shadow:\s*inset 0 0 0 2px/
    );
  });
});
