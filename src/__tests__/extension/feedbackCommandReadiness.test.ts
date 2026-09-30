/** @jest-environment node */
import * as vscode from 'vscode';
import { setActiveWebviewPanel } from '../../activeWebview';
import { activate } from '../../extension';
jest.mock('../../editor/MarkdownEditorProvider', () => ({
  MarkdownEditorProvider: { register: jest.fn(() => ({ dispose: jest.fn() })) },
}));
jest.mock('../../features/wordCount', () => ({
  WordCountFeature: jest.fn(() => ({ activate: jest.fn() })),
}));
jest.mock('../../features/outlineView', () => ({
  outlineViewProvider: { setTreeView: jest.fn() },
}));
import {
  registerFeedbackCommandTarget,
  beginFeedbackCommandTarget,
  markFeedbackCommandTargetReady,
  resetFeedbackCommandTarget,
  sendFeedbackCommand,
} from '../../feedbackCommandReadiness';

describe('Feedback commands during renderer startup', () => {
  function fixture() {
    const postMessage = jest.fn(async () => true);
    const webview = { postMessage } as unknown as vscode.Webview;
    const panel = { webview, active: true, visible: true } as vscode.WebviewPanel;
    const registration = registerFeedbackCommandTarget(webview);
    beginFeedbackCommandTarget(webview, 'generation-1');
    setActiveWebviewPanel(panel);
    return { webview, panel, postMessage, registration };
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    setActiveWebviewPanel(undefined);
    jest.useRealTimers();
  });

  it('waits beyond the old 2.5s sleep and sends once after the controller is ready', async () => {
    const f = fixture();
    const sent = sendFeedbackCommand(f.panel, 'start');
    await jest.advanceTimersByTimeAsync(3000);
    expect(f.postMessage).not.toHaveBeenCalled();
    markFeedbackCommandTargetReady(f.webview, 'generation-1');
    await expect(sent).resolves.toBe(true);
    expect(f.postMessage).toHaveBeenCalledTimes(1);
    expect(f.postMessage).toHaveBeenCalledWith({ type: 'feedback.command', command: 'start' });
    f.registration.dispose();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('makes the registered Start command wait for delayed renderer startup', async () => {
    const f = fixture();
    const commands = new Map<string, () => unknown>();
    (vscode.window.createTreeView as jest.Mock) = jest.fn(() => ({ dispose: jest.fn() }));
    (vscode.commands.registerCommand as jest.Mock).mockImplementation((id, callback) => {
      commands.set(id, callback);
      return { dispose: jest.fn() };
    });
    activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    const sent = commands.get('markdownForHumans.feedback.start')?.();
    try {
      await jest.advanceTimersByTimeAsync(3000);
      expect(f.postMessage).not.toHaveBeenCalled();
      markFeedbackCommandTargetReady(f.webview, 'generation-1');
      await expect(sent).resolves.toBe(true);
      expect(f.postMessage).toHaveBeenCalledTimes(1);
    } finally {
      f.registration.dispose();
    }
  });

  it('sends immediately when the controller is already ready', async () => {
    const f = fixture();
    markFeedbackCommandTargetReady(f.webview, 'generation-1');
    await expect(sendFeedbackCommand(f.panel, 'start')).resolves.toBe(true);
    f.registration.dispose();
  });

  it.each(['dispose', 'hide', 'focus-change', 'reload'] as const)(
    'does not send a stale command after %s',
    async reason => {
      const f = fixture();
      const sent = sendFeedbackCommand(f.panel, 'start');
      if (reason === 'dispose') f.registration.dispose();
      else if (reason === 'hide' || reason === 'reload') resetFeedbackCommandTarget(f.webview);
      else setActiveWebviewPanel(undefined);
      markFeedbackCommandTargetReady(f.webview, 'generation-1');
      await expect(sent).resolves.toBe(false);
      expect(f.postMessage).not.toHaveBeenCalled();
      f.registration.dispose();
    }
  );

  it('requires a new readiness signal after hiding or reloading a ready renderer', async () => {
    const f = fixture();
    markFeedbackCommandTargetReady(f.webview, 'generation-1');
    resetFeedbackCommandTarget(f.webview);
    const sent = sendFeedbackCommand(f.panel, 'start');
    await jest.advanceTimersByTimeAsync(3000);
    expect(f.postMessage).not.toHaveBeenCalled();
    beginFeedbackCommandTarget(f.webview, 'generation-2');
    markFeedbackCommandTargetReady(f.webview, 'generation-2');
    await expect(sent).resolves.toBe(true);
    f.registration.dispose();
  });

  it('ignores controller readiness from a hidden or superseded renderer', async () => {
    const f = fixture();
    resetFeedbackCommandTarget(f.webview);
    const sent = sendFeedbackCommand(f.panel, 'start');
    markFeedbackCommandTargetReady(f.webview, 'generation-1');
    await jest.advanceTimersByTimeAsync(1);
    expect(f.postMessage).not.toHaveBeenCalled();
    beginFeedbackCommandTarget(f.webview, 'generation-2');
    markFeedbackCommandTargetReady(f.webview, 'generation-1');
    await jest.advanceTimersByTimeAsync(1);
    expect(f.postMessage).not.toHaveBeenCalled();
    markFeedbackCommandTargetReady(f.webview, 'generation-2');
    await expect(sent).resolves.toBe(true);
    f.registration.dispose();
  });

  it('retains a command issued before the first ready handshake', async () => {
    const f = fixture();
    resetFeedbackCommandTarget(f.webview);
    const sent = sendFeedbackCommand(f.panel, 'start');
    beginFeedbackCommandTarget(f.webview, 'first-ready');
    markFeedbackCommandTargetReady(f.webview, 'first-ready');
    await expect(sent).resolves.toBe(true);
    f.registration.dispose();
  });

  it('bounds a missing readiness signal and reports a recoverable error', async () => {
    const f = fixture();
    const sent = sendFeedbackCommand(f.panel, 'start');
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(sent).resolves.toBe(false);
    expect(f.postMessage).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/ready/i));
    f.registration.dispose();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([false, new Error('disposed transport')])(
    'reports a failed post without retrying it',
    async result => {
      const f = fixture();
      f.postMessage.mockImplementation(async () => {
        if (result instanceof Error) throw result;
        return result;
      });
      markFeedbackCommandTargetReady(f.webview, 'generation-1');
      await expect(sendFeedbackCommand(f.panel, 'start')).resolves.toBe(false);
      expect(f.postMessage).toHaveBeenCalledTimes(1);
      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
      f.registration.dispose();
    }
  );
});
