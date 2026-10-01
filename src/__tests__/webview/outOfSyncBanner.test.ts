/** @jest-environment jsdom */

/**
 * Persistent in-webview out-of-sync banner (post-merge 03, decision #2).
 * The editor shows it only after reconciliation gave up (Y2) and removes it
 * once sync recovers; see the Y2 banner tests in undo-sync.test.ts.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import { hideOutOfSyncBanner, showOutOfSyncBanner } from '../../webview/features/outOfSyncBanner';

describe('out-of-sync banner', () => {
  afterEach(() => {
    hideOutOfSyncBanner();
    document.body.innerHTML = '';
  });

  it('shows one alert with a Reload editor action, without taking focus from typing', () => {
    const typingTarget = document.createElement('div');
    typingTarget.tabIndex = 0;
    document.body.append(typingTarget);
    typingTarget.focus();
    const onReload = jest.fn();

    showOutOfSyncBanner(onReload);
    showOutOfSyncBanner(onReload);

    const banners = document.querySelectorAll('[role="alert"]');
    expect(banners).toHaveLength(1);
    expect(banners[0].textContent).toContain('out of sync');
    expect(document.activeElement).toBe(typingTarget);

    const button = banners[0].querySelector('button');
    expect(button?.type).toBe('button');
    expect(button?.textContent).toBe('Reload editor');
    button?.click();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('removes the alert once sync recovers and can show it again later', () => {
    showOutOfSyncBanner(jest.fn());
    hideOutOfSyncBanner();
    expect(document.querySelector('[role="alert"]')).toBeNull();

    hideOutOfSyncBanner();
    showOutOfSyncBanner(jest.fn());
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it('uses theme variables only and moves Find into the toolbar row while shown', () => {
    const css = readFileSync(path.resolve(__dirname, '../../webview/editor.css'), 'utf8');
    const rules = [...css.matchAll(/\.out-of-sync-banner[^{]*\{([^}]*)\}/g)].map(match => match[1]);
    expect(rules.length).toBeGreaterThanOrEqual(3);
    for (const rule of rules) {
      expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(?:white|black|red)\b/i);
    }
    expect(css).toMatch(
      /body:has\(\.out-of-sync-banner\)\s+\.search-overlay[^{}]*\{[^}]*padding-top:\s*4px/
    );
  });
});
