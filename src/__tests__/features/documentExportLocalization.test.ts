/**
 * Export dialogs, progress text and messages go through vscode.l10n.
 *
 * The dialog results are compared with the translated button labels, so these
 * tests answer each prompt with the translated label, as VS Code does.
 */

import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import {
  exportDocument,
  promptForChromePath,
  validateChromePath,
} from '../../features/documentExport';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

// Chrome is never found, so the export falls through to the prompts.
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(() => false),
}));

const translate = vscode.l10n.t as jest.Mock;
const englishTranslate = translate.getMockImplementation();

// Leaves out "Chrome detected at" on purpose, to exercise the fallback to English.
const sampleBundle: Record<string, string> = {
  'I Understand': '我明白',
  'Export to {0} works best with simple markdown files.\n\nKnown limitations:\n• Images (especially remote URLs)\n• Mermaid diagrams\n• Complex markdown structures\n\nSome content may not render correctly in the exported document.':
    '导出为 {0} 时，简单的 Markdown 文件效果最佳。\n\n已知限制：\n• 图片（尤其是远程图片）\n• Mermaid 图表\n• 复杂的 Markdown 结构\n\n部分内容可能无法在导出的文档中正确显示。',
  'PDF Document': 'PDF 文档',
  'Exporting to {0}...': '正在导出为 {0}...',
  'Preparing PDF export…': '正在准备 PDF 导出…',
  'Detecting Chrome on this system…': '正在检测此系统上的 Chrome…',
  'Validating Chrome path…': '正在验证 Chrome 路径…',
  'Use This Path': '使用此路径',
  'Choose Different Path': '选择其他路径',
  'Choose Chrome Path': '选择 Chrome 路径',
  'Download Chrome': '下载 Chrome',
  'Browse…': '浏览…',
  'Enter Path': '输入路径',
  Cancel: '取消',
  'Select Chrome/Chromium Executable': '选择 Chrome/Chromium 可执行文件',
  'Enter Chrome/Chromium executable path': '输入 Chrome/Chromium 可执行文件路径',
  'Examples:\n- {0} (macOS)\n- {1} (Windows)\n- {2} (Linux)':
    '示例：\n- {0} (macOS)\n- {1} (Windows)\n- {2} (Linux)',
  'Chrome is required for PDF export. Provide a path to Chrome/Chromium.':
    '导出 PDF 需要 Chrome。请提供 Chrome/Chromium 的路径。',
  'Chrome is required for PDF export.\nLast check failed: {0}':
    '导出 PDF 需要 Chrome。\n上次检查失败：{0}',
  'No path selected': '未选择路径',
  'Chrome executable not found at the specified path': '在指定路径未找到 Chrome 可执行文件',
  'The specified file is not a valid Chrome/Chromium executable':
    '指定的文件不是有效的 Chrome/Chromium 可执行文件',
  'Chrome not ready: {0}. Please choose a valid Chrome/Chromium executable.':
    'Chrome 尚未就绪：{0}。请选择有效的 Chrome/Chromium 可执行文件。',
};

const windowApi = vscode.window as unknown as { showInputBox?: jest.Mock };
const mockDocument = { uri: vscode.Uri.file('/test/doc.md') } as unknown as vscode.TextDocument;
const refuseLocalImages = () => undefined;

/** Answer each information message in order, as the user clicking the given labels. */
function answerPrompts(...labels: Array<string | undefined>): void {
  const showInformationMessage = vscode.window.showInformationMessage as jest.Mock;
  labels.forEach(label => showInformationMessage.mockResolvedValueOnce(label));
}

/** Run withProgress tasks for real and keep what they report. */
function captureProgress() {
  const reports: Array<{ message?: string }> = [];
  const titles: string[] = [];
  (vscode.window.withProgress as jest.Mock).mockImplementation(
    async (options: { title: string }, task: (...args: unknown[]) => Promise<unknown>) => {
      titles.push(options.title);
      return task(
        { report: (value: { message?: string }) => reports.push(value) },
        { isCancellationRequested: false, onCancellationRequested: jest.fn() }
      );
    }
  );
  return { reports, titles };
}

describe('Document export localization', () => {
  beforeEach(() => {
    translate.mockImplementation((message: string, ...args: Array<string | number | boolean>) =>
      (sampleBundle[message] ?? message).replace(/\{(\d+)\}/g, (placeholder, index: string) =>
        args[Number(index)] === undefined ? placeholder : String(args[Number(index)])
      )
    );
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('我明白');
    (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue({ fsPath: '/test/out.pdf' });
    (vscode.window.showInformationMessage as jest.Mock).mockReset();
    (vscode.window.showErrorMessage as jest.Mock).mockReset();
    (vscode.window.showOpenDialog as jest.Mock).mockReset();
    (vscode.env.openExternal as jest.Mock).mockReset();
    windowApi.showInputBox = jest.fn();
  });

  afterEach(() => {
    translate.mockImplementation(englishTranslate);
    (vscode.window.withProgress as jest.Mock).mockImplementation(
      (_options: unknown, task: (...args: unknown[]) => unknown) =>
        task(
          { report: jest.fn() },
          { isCancellationRequested: false, onCancellationRequested: jest.fn() }
        )
    );
    (vscode.window.showWarningMessage as jest.Mock).mockReset();
    (vscode.window.showSaveDialog as jest.Mock).mockReset();
    delete windowApi.showInputBox;
  });

  describe('export confirmation', () => {
    it('shows the translated warning, button and save dialog filter', async () => {
      (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(undefined);

      await exportDocument('pdf', '<p>x</p>', [], 'Doc', mockDocument, refuseLocalImages);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('导出为 PDF 时，简单的 Markdown 文件效果最佳。'),
        { modal: true },
        '我明白'
      );
      expect(vscode.window.showSaveDialog).toHaveBeenCalledWith(
        expect.objectContaining({ filters: { 'PDF 文档': ['pdf'] } })
      );
    });

    it('does not export when the answer is not the translated button label', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('I Understand');

      await exportDocument('pdf', '<p>x</p>', [], 'Doc', mockDocument, refuseLocalImages);

      expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
    });

    it('names the Word format in the warning and falls back to English for the filter', async () => {
      (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(undefined);

      await exportDocument('docx', '<p>x</p>', [], 'Doc', mockDocument, refuseLocalImages);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('导出为 Word 时'),
        { modal: true },
        '我明白'
      );
      expect(vscode.window.showSaveDialog).toHaveBeenCalledWith(
        expect.objectContaining({ filters: { 'Word Document': ['docx'] } })
      );
    });
  });

  describe('Chrome prompts during an export', () => {
    it('translates progress text and answers Browse, Download and Cancel by label', async () => {
      const { reports, titles } = captureProgress();
      answerPrompts('浏览…', '下载 Chrome', '取消');
      (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue(undefined);

      await exportDocument('pdf', '<p>x</p>', [], 'Doc', mockDocument, refuseLocalImages);

      expect(titles).toEqual(['正在导出为 PDF...']);
      expect(reports.map(report => report.message)).toEqual([
        '正在准备 PDF 导出…',
        '正在检测此系统上的 Chrome…',
      ]);
      const showInformationMessage = vscode.window.showInformationMessage as jest.Mock;
      expect(showInformationMessage).toHaveBeenCalledTimes(3);
      expect(showInformationMessage.mock.calls[0]).toEqual([
        '导出 PDF 需要 Chrome。请提供 Chrome/Chromium 的路径。',
        { modal: true },
        '浏览…',
        '输入路径',
        '下载 Chrome',
        '取消',
      ]);
      expect(vscode.window.showOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: '选择 Chrome/Chromium 可执行文件' })
      );
      expect(showInformationMessage.mock.calls[1][0]).toBe(
        '导出 PDF 需要 Chrome。\n上次检查失败：未选择路径'
      );
      expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    });

    it('translates the path input box, validation progress and error', async () => {
      const { reports } = captureProgress();
      answerPrompts('输入路径', '取消');
      windowApi.showInputBox?.mockResolvedValue('/not/chrome');

      await exportDocument('pdf', '<p>x</p>', [], 'Doc', mockDocument, refuseLocalImages);

      expect(windowApi.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '输入 Chrome/Chromium 可执行文件路径',
          prompt: expect.stringMatching(
            /^示例：\n- \/Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome \(macOS\)\n- C:.*chrome\.exe \(Windows\)\n- \/usr\/bin\/google-chrome \(Linux\)$/
          ),
        })
      );
      expect(reports.map(report => report.message)).toContain('正在验证 Chrome 路径…');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Chrome 尚未就绪：在指定路径未找到 Chrome 可执行文件。请选择有效的 Chrome/Chromium 可执行文件。'
      );
    });
  });

  describe('promptForChromePath', () => {
    it('returns the detected path when the translated "Use This Path" is chosen', async () => {
      answerPrompts('使用此路径');

      const result = await promptForChromePath('/opt/chrome');

      expect(result).toBe('/opt/chrome');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Chrome detected at:\n/opt/chrome\n\nWould you like to use this for PDF export?',
        { modal: true },
        '使用此路径',
        '选择其他路径',
        '取消'
      );
    });

    it('opens the picker for the translated "Choose Different Path"', async () => {
      answerPrompts('选择其他路径');
      (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([{ fsPath: '/custom/chrome' }]);

      const result = await promptForChromePath('/opt/chrome');

      expect(result).toBe('/custom/chrome');
    });

    it('returns null for the translated "Cancel"', async () => {
      answerPrompts('取消');

      expect(await promptForChromePath('/opt/chrome')).toBeNull();
    });

    it('opens the download page for the translated "Download Chrome"', async () => {
      answerPrompts('下载 Chrome');

      const result = await promptForChromePath(null);

      expect(result).toBeNull();
      expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.any(String),
        { modal: true },
        '下载 Chrome',
        '选择 Chrome 路径',
        '取消'
      );
    });

    it('offers the picker for the translated "Choose Chrome Path"', async () => {
      answerPrompts('选择 Chrome 路径');
      (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([{ fsPath: '/chosen/chrome' }]);

      expect(await promptForChromePath(null)).toBe('/chosen/chrome');
    });
  });

  describe('validateChromePath', () => {
    it('translates the error for a missing file', async () => {
      const result = await validateChromePath('/missing/chrome');

      expect(result).toEqual({
        valid: false,
        error: '在指定路径未找到 Chrome 可执行文件',
      });
    });

    it('translates the error for a file that is not Chrome', async () => {
      const fs = jest.requireMock('fs') as { existsSync: jest.Mock };
      fs.existsSync.mockReturnValueOnce(true);
      (spawn as jest.Mock).mockImplementationOnce(() => {
        const child = new EventEmitter();
        setImmediate(() => child.emit('exit', 1));
        return child;
      });

      const result = await validateChromePath('/bin/not-chrome');

      expect(result.error).toBe('指定的文件不是有效的 Chrome/Chromium 可执行文件');
    });
  });
});
