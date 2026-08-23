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
  const controller = createFeedbackPeerLockController({ editor, toolbar });
  return { controller, editor, editorDom, toolbar, registeredPlugins };
}

describe('Feedback peer split lock', () => {
  afterEach(() => {
    document.body.innerHTML = '';
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
