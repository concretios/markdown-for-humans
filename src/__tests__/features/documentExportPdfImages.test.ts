/** PDF image preparation through the public export boundary, with Chrome/UI adapters isolated. */
import * as vscode from 'vscode';
import childProcess, { type ChildProcess } from 'child_process';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { pathToFileURL } from 'url';
import * as cheerio from 'cheerio';
import { exportDocument } from '../../features/documentExport';

describe('PDF local SVG image preparation', () => {
  const directory = path.join(os.tmpdir(), 'svg export # "fixture"');
  const document = {
    uri: vscode.Uri.file(path.join(directory, 'source.md')),
  } as vscode.TextDocument;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs.promises, 'mkdtemp').mockResolvedValue('/tmp/md4h-pdf-unit');
    jest.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
    jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
      const process = new EventEmitter();
      setImmediate(() => process.emit('exit', 0));
      return process as ChildProcess;
    });
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn(() => '/fixture/chrome'),
      update: jest.fn(),
    });
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('I Understand');
    (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(
      vscode.Uri.file('/tmp/result.pdf')
    );
  });

  afterEach(() => jest.restoreAllMocks());

  async function preparedHtml(html: string): Promise<cheerio.CheerioAPI> {
    await exportDocument('pdf', html, [], 'SVG export', document);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    const call = (fs.promises.writeFile as jest.Mock).mock.calls.find(([filename]) =>
      String(filename).endsWith('export.html')
    );
    expect(call).toBeDefined();
    return cheerio.load(String(call?.[1]));
  }

  it('prints in an isolated incognito profile and removes it with the temporary export files', async () => {
    await preparedHtml('<img src="images/diagram.svg" width="320">');
    const calls = (childProcess.spawn as jest.Mock).mock.calls;
    expect(calls[0][1]).toEqual(['--version']);
    const printCall = calls.find(([, args]) =>
      args.some((argument: string) => argument.startsWith('--print-to-pdf='))
    );
    expect(printCall?.[1]).toEqual(
      expect.arrayContaining([
        '--incognito',
        `--user-data-dir=${path.join('/tmp/md4h-pdf-unit', 'chrome-profile')}`,
      ])
    );
    expect(fs.promises.rm).toHaveBeenCalledWith('/tmp/md4h-pdf-unit', {
      recursive: true,
      force: true,
    });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('exported successfully')
    );
  });

  it('waits for the print process exit before reporting success, not only its stdio close', async () => {
    let printProcess: EventEmitter | undefined;
    (childProcess.spawn as jest.Mock).mockImplementation((_executable, args: string[]) => {
      const process = new EventEmitter();
      if (args.includes('--version')) setImmediate(() => process.emit('exit', 0));
      else printProcess = process;
      return process as ChildProcess;
    });
    let completed = false;
    const exported = exportDocument('pdf', '<p>SVG export</p>', [], 'SVG export', document).then(
      () => {
        completed = true;
      }
    );
    for (let attempt = 0; attempt < 3 && !printProcess; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(printProcess).toBeDefined();
    printProcess!.emit('close', 0, null);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(fs.promises.rm).not.toHaveBeenCalled();

    printProcess!.emit('exit', 0, null);
    await exported;
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('exported successfully')
    );
  });

  it('restores the authored SVG destination with encoded filename, query and fragment', async () => {
    const source = './images/Diagram%20%231.svg?revision=2#overview';
    const $ = await preparedHtml(
      `<p><img src="https://file+.vscode-resource.vscode-cdn.net/cache/diagram.svg" data-markdown-src="${source}" alt="Diagram" width="320" title="Sized SVG"></p>`
    );
    expect($('img').attr('src')).toBe(source);
    expect($('img').attr('width')).toBe('320');
    expect($('img').attr('title')).toBe('Sized SVG');
    const imageUrl = new URL($('img').attr('src')!, $('base').attr('href'));
    expect(imageUrl.pathname).toContain('Diagram%20%231.svg');
    expect(imageUrl.search).toBe('?revision=2');
    expect(imageUrl.hash).toBe('#overview');
  });

  it('encodes the trusted document base path instead of treating filename punctuation as URL syntax', async () => {
    const $ = await preparedHtml('<img src="images/diagram.svg#overview">');
    expect($('base').attr('href')).toBe(pathToFileURL(directory + path.sep).href);
    expect($('base')).toHaveLength(1);
    expect($('img').attr('src')).toBe('images/diagram.svg#overview');
  });

  it('keeps raster, HTTPS and embedded sources and removes source-less editor separators', async () => {
    const $ = await preparedHtml(
      '<img src="./image.png"><img src="https://example.com/image.svg#v"><img src="data:image/svg+xml;base64,AAAA"><img class="ProseMirror-separator">'
    );
    expect(
      $('img')
        .map((_, image) => $(image).attr('src'))
        .get()
    ).toEqual(['./image.png', 'https://example.com/image.svg#v', 'data:image/svg+xml;base64,AAAA']);
    expect($('img.ProseMirror-separator')).toHaveLength(0);
  });

  it('sanitizes restored destinations and retains the existing active-content restrictions', async () => {
    const $ = await preparedHtml(
      '<img src="https://file+.vscode-resource.vscode-cdn.net/x" data-markdown-src="javascript:alert(1)" onload="alert(1)"><script>alert(1)</script><base href="https://attacker.invalid/">'
    );
    expect($('img').attr('src')).toBeUndefined();
    expect($('img').attr('onload')).toBeUndefined();
    expect($('script')).toHaveLength(0);
    expect($('base').attr('href')).toBe(pathToFileURL(directory + path.sep).href);
  });
});
