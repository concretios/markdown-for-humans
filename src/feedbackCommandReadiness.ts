/**
 * Feedback command delivery waits for the host-validated controller readiness
 * signal. Queue acceptance is not session activation; Feedback's existing
 * snapshot and application ACK protocols remain authoritative.
 */
import * as vscode from 'vscode';
import { getActiveWebviewPanel } from './activeWebview';
import type { FeedbackHostMessage } from './shared/feedbackProtocol';

type FeedbackCommand = Extract<FeedbackHostMessage, { type: 'feedback.command' }>['command'];
interface CommandTarget {
  ready: boolean;
  generation?: string;
  waiters: Set<(ready: boolean) => void>;
}
const targets = new WeakMap<vscode.Webview, CommandTarget>();

/** Register a panel before its renderer starts; disposal cancels pending commands. */
export function registerFeedbackCommandTarget(webview: vscode.Webview): vscode.Disposable {
  const target: CommandTarget = { ready: false, waiters: new Set() };
  targets.set(webview, target);
  return {
    dispose() {
      if (targets.get(webview) !== target) return;
      resetFeedbackCommandTarget(webview);
      targets.delete(webview);
    },
  };
}

/** Start the host-accepted renderer generation; retain only first-start waiters. */
export function beginFeedbackCommandTarget(webview: vscode.Webview, generation: string): void {
  const target = targets.get(webview);
  if (!target) return;
  resetFeedbackCommandTarget(webview, target.generation !== undefined);
  target.generation = generation;
}

/** Only the provider's generation-validated controller-ready handler calls this. */
export function markFeedbackCommandTargetReady(webview: vscode.Webview, generation: string): void {
  const target = targets.get(webview);
  if (!target || target.generation !== generation) return;
  target.ready = true;
  for (const resolve of [...target.waiters]) resolve(true);
}

/** Invalidate readiness on hide/reload; initial startup may retain its waiters. */
export function resetFeedbackCommandTarget(webview: vscode.Webview, cancelPending = true): void {
  const target = targets.get(webview);
  if (!target) return;
  target.ready = false;
  target.generation = undefined;
  if (cancelPending) for (const resolve of [...target.waiters]) resolve(false);
}

/**
 * Send once to the original active panel after readiness, with a bounded startup
 * wait. Returns queue acceptance, not application success. Never redirects a
 * delayed command to another panel or retries a potentially applied action.
 */
export async function sendFeedbackCommand(
  panel: vscode.WebviewPanel,
  command: FeedbackCommand
): Promise<boolean> {
  try {
    const webview = panel.webview;
    const target = targets.get(webview);
    if (!target || target.waiters.size >= 16) return false;
    const ready =
      target.ready ||
      (await new Promise<boolean>(resolve => {
        const settle = (value: boolean) => {
          clearTimeout(timer);
          target.waiters.delete(settle);
          resolve(value);
        };
        const timer = setTimeout(() => settle(false), 10_000);
        target.waiters.add(settle);
      }));
    if (targets.get(webview) !== target || getActiveWebviewPanel() !== panel || !panel.active) {
      return false;
    }
    if (!ready || !target.ready) {
      void vscode.window.showWarningMessage(
        'Feedback is not ready. Wait for the editor to load and try again.'
      );
      return false;
    }
    const message: FeedbackHostMessage = { type: 'feedback.command', command };
    if (await webview.postMessage(message)) return true;
  } catch (error) {
    console.error('[MD4H] Feedback command delivery failed:', error);
  }
  void vscode.window.showWarningMessage(
    'Feedback command could not be delivered. Reopen the editor and try again.'
  );
  return false;
}
