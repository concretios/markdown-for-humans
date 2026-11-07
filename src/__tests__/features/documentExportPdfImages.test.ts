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
import { resolveContainedImageSource } from '../../editor/MarkdownEditorProvider';

describe('PDF local SVG image preparation', () => {
  const directory = path.join(os.tmpdir(), 'svg export # "fixture"');
  const document = {
    uri: vscode.Uri.file(path.join(directory, 'source.md')),
  } as vscode.TextDocument;
  // The preview's containment resolver, bound to the document directory as its only root.
  const resolveImage = (source: string) =>
    resolveContainedImageSource(source, directory, [directory]);

  beforeEach(() => {
    jest.clearAllMocks();
    // Chrome and the output PDF exist; fixture images do not, so authored
    // `?`/`#` stay URL suffixes rather than literal filename characters.
    jest
      .spyOn(fs, 'existsSync')
      .mockImplementation(candidate => !String(candidate).startsWith(directory));
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
    await exportDocument('pdf', html, [], 'SVG export', document, resolveImage);
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

  it('prints without the browser header and footer, which show a timestamp and the temp file path', async () => {
    await preparedHtml('<p>Body</p>');
    const printCall = (childProcess.spawn as jest.Mock).mock.calls.find(([, args]) =>
      args.some((argument: string) => argument.startsWith('--print-to-pdf='))
    );
    // Current Chrome reads the first flag; older builds only know the second.
    expect(printCall?.[1]).toEqual(
      expect.arrayContaining(['--no-pdf-header-footer', '--print-to-pdf-no-header'])
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
    const exported = exportDocument(
      'pdf',
      '<p>SVG export</p>',
      [],
      'SVG export',
      document,
      resolveImage
    ).then(() => {
      completed = true;
    });
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
    // The host rewrites the vetted file as a canonical relative URL.
    expect($('img').attr('src')).toBe('images/Diagram%20%231.svg?revision=2#overview');
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

  it('keeps raster, HTTPS, data: and blob: sources and removes source-less editor separators', async () => {
    const $ = await preparedHtml(
      '<img src="./image.png"><img src="https://example.com/image.svg#v"><img src="data:image/svg+xml;base64,AAAA"><img src="blob:vscode-webview://panel/1234"><img class="ProseMirror-separator">'
    );
    expect(
      $('img')
        .map((_, image) => $(image).attr('src'))
        .get()
    ).toEqual([
      'image.png',
      'https://example.com/image.svg#v',
      'data:image/svg+xml;base64,AAAA',
      'blob:vscode-webview://panel/1234',
    ]);
    expect($('img.ProseMirror-separator')).toHaveLength(0);
  });

  describe('http: sources, matching the preview CSP (decision #5)', () => {
    // The preview CSP is img-src <webview resources> https: data: blob:, so the
    // editor never shows an http: image. Export must not fetch one either.
    it.each([
      ['an http: URL', 'http://192.168.1.20/leak-1.png'],
      ['an uppercase HTTP: URL', 'HTTP://192.168.1.20/leak-2.png'],
      ['a protocol-relative //host reference', '//192.168.1.20/leak-3.png'],
    ])('drops %s like a refused local image, keeping its alt', async (_label, source) => {
      const $ = await preparedHtml(
        `<p><img data-markdown-src="${source}" alt="editor form"><img src="${source}" alt="raw form"></p>`
      );
      const images = $('img').toArray();
      expect(images.map(image => $(image).attr('src'))).toEqual([undefined, undefined]);
      expect(images.map(image => $(image).attr('alt'))).toEqual(['editor form', 'raw form']);
      expect($.html()).not.toMatch(/leak-\d+/);
    });

    it.each([
      ['an http: url()', '<span style="background:url(http://192.168.1.20/leak-4.png)">x</span>'],
      [
        'an uppercase HTTP: url()',
        `<span style="background:url('HTTP://192.168.1.20/leak-5.png')">x</span>`,
      ],
      [
        'a protocol-relative url()',
        '<span style="background:url(//192.168.1.20/leak-6.png)">x</span>',
      ],
      [
        'a <style> http: url()',
        '<svg><style>#a{background:url(http://192.168.1.20/leak-7.png)}</style></svg>',
      ],
      [
        'an http: SVG image href',
        '<svg><image href="http://192.168.1.20/leak-8.png"></image></svg>',
      ],
    ])('exports no http: load outside img through %s', async (_label, markup) => {
      const $ = await preparedHtml(`<div class="mermaid-wrapper">${markup}</div>`);
      expect($.html()).not.toMatch(/leak-\d+/);
    });
  });

  it('sanitizes restored destinations and retains the existing active-content restrictions', async () => {
    const $ = await preparedHtml(
      '<img src="https://file+.vscode-resource.vscode-cdn.net/x" data-markdown-src="javascript:alert(1)" onload="alert(1)"><script>alert(1)</script><base href="https://attacker.invalid/">'
    );
    // The preview resolves a scheme-like destination as a document-relative file
    // name; export encodes it the same way, so no script URL survives.
    expect($('img').attr('src')).toBe('javascript%3Aalert%281%29');
    expect($('img').attr('onload')).toBeUndefined();
    expect($('script')).toHaveLength(0);
    expect($('base').attr('href')).toBe(pathToFileURL(directory + path.sep).href);
  });
  describe('local image containment (S1)', () => {
    /** True when the img would load nothing, or only a file under the document root. */
    function loadsOnlyInsideRoot(
      $: cheerio.CheerioAPI,
      image: Parameters<cheerio.CheerioAPI>[0]
    ): boolean {
      const src = $(image).attr('src');
      if (src === undefined) return true;
      const base = $('base').attr('href')!;
      return new URL(src, base).href.startsWith(base);
    }

    it.each([
      ['an absolute path', '/Users/victim/Pictures/id.png'],
      ['a root-escaping relative path', '../../../x.png'],
      ['a network-path reference (UNC on Windows)', '//host/x.png'],
      ['percent-encoded traversal', '%2E%2E/%2E%2E/%2e%2e/x.png'],
      ['a backslash traversal Chrome treats as separators', '..\\..\\..\\x.png'],
      ['a file: URL outside the root', 'file:///etc/x.png'],
    ])('exports no loadable src for %s the preview refuses', async (_label, source) => {
      const $ = await preparedHtml(
        `<p><img data-markdown-src="${source}" alt="refused"><img src="${source}" alt="raw"></p>`
      );
      const images = $('img').toArray();
      expect(images).toHaveLength(2);
      for (const image of images) {
        expect(loadsOnlyInsideRoot($, image)).toBe(true);
        expect($(image).attr('data-markdown-src')).toBeUndefined();
      }
    });

    it('still exports an in-root image at its exact file URL', async () => {
      const $ = await preparedHtml('<img data-markdown-src="images/pic%20one.png" alt="ok">');
      const src = $('img').attr('src');
      expect(src).toBeDefined();
      expect(new URL(src!, $('base').attr('href')).href).toBe(
        pathToFileURL(path.join(directory, 'images', 'pic one.png')).href
      );
    });

    it('exports a parent-directory image that stays inside a broader allowed root', async () => {
      const workspace = path.join(directory, 'workspace');
      const nestedDocument = {
        uri: vscode.Uri.file(path.join(workspace, 'docs', 'guide.md')),
      } as vscode.TextDocument;
      await exportDocument(
        'pdf',
        '<img data-markdown-src="../assets/logo.png"><img data-markdown-src="../../outside.png">',
        [],
        'Nested',
        nestedDocument,
        source =>
          resolveContainedImageSource(source, path.join(workspace, 'docs'), [
            workspace,
            path.join(workspace, 'docs'),
          ])
      );
      const call = (fs.promises.writeFile as jest.Mock).mock.calls.find(([filename]) =>
        String(filename).endsWith('export.html')
      );
      const $ = cheerio.load(String(call?.[1]));
      const base = $('base').attr('href')!;
      const [inside, outside] = $('img').toArray();
      expect(new URL($(inside).attr('src')!, base).href).toBe(
        pathToFileURL(path.join(workspace, 'assets', 'logo.png')).href
      );
      expect($(outside).attr('src')).toBeUndefined();
    });

    // Pre-existing on origin/main 6412d17, not caused by the S1 pass: Word export
    // only embeds an <img> that is a direct child of the paragraph, but the editor
    // DOM wraps every image in span.image-wrapper, so no word/media entry is written.
    // A bare <img> does embed, yet as `<hash>.undefined` because docx 9 ImageRun
    // needs an explicit `type`. Both reproduce identically before and after S1.
    it.todo('embeds an in-root image in Word export');

    it('never reads a refused image from disk for Word export', async () => {
      (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue(
        vscode.Uri.file('/tmp/result.docx')
      );
      jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
      const readFileSync = jest
        .spyOn(fs, 'readFileSync')
        .mockImplementation(() => Buffer.from('not an image'));
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);

      await exportDocument(
        'docx',
        '<p><img data-markdown-src="/etc/passwd"><img data-markdown-src="../../../secret.png"><img src="//host/x.png"><img data-markdown-src="images/ok.png"></p>',
        [],
        'Word',
        document,
        resolveImage
      );

      const readPaths = readFileSync.mock.calls.map(([candidate]) => String(candidate));
      expect(readPaths).toEqual([path.join(directory, 'images', 'ok.png')]);
    });
  });

  describe('local resources outside img (02-F3)', () => {
    // The preview resolves these against the webview origin, so it never shows a
    // local file through them. Raw Mermaid SVG, kept when PNG conversion fails,
    // carries attacker-controlled label styles into the export page.
    it.each([
      [
        'a Mermaid label style',
        '<div class="mermaid-render"><svg><g><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel" style="background:url(/Users/victim/leak-1.png)">A</span></div></foreignObject></g></svg></div>',
      ],
      ['a quoted traversal url()', `<div style='background: url("../../../leak-2.png")'>x</div>`],
      ['a CSS-escaped url()', '<span style="background:\\75 rl(/leak-3.png)">x</span>'],
      [
        'an image-set() string',
        `<span style="background-image:image-set('/leak-4.png' 1x)">x</span>`,
      ],
      ['a <style> url()', '<svg><style>#a{background:url(/leak-5.png)}</style></svg>'],
      ['a <style> @import', '<svg><style>@import "/leak-6.css";</style></svg>'],
      ['an SVG image href', '<svg><image href="/Users/victim/leak-7.png"></image></svg>'],
      ['an SVG image xlink:href', '<svg><image xlink:href="../../leak-8.png"></image></svg>'],
      ['an external SVG use', '<svg><use href="leak-9.svg#icon"></use></svg>'],
      [
        'an SVG feImage',
        '<svg><filter id="f"><feImage href="/leak-10.png"></feImage></filter></svg>',
      ],
      ['a presentation attribute url()', '<svg><rect fill="url(/leak-11.svg#p)"></rect></svg>'],
      [
        'table background attributes',
        '<table background="/leak-12.png"><tbody><tr><td background="leak-13.png">x</td></tr></tbody></table>',
      ],
      [
        'the other url() presentation attributes',
        '<svg><path stroke="url(/leak-14.svg#p)" marker-start="url(/leak-15.svg#m)" marker-mid="url(/leak-16.svg#m)" marker-end="url(/leak-17.svg#m)" clip-path="url(/leak-18.svg#c)" mask="url(/leak-19.png)" filter="url(/leak-20.svg#f)" cursor="url(/leak-21.png), auto"></path></svg>',
      ],
      [
        'SVG animation values',
        '<svg><rect><set attributeName="mask" to="url(/leak-25.png)"></set><animate attributeName="fill" values="url(#a);url(/leak-26.svg#p)" from="url(/leak-27.svg#p)" by="url(/leak-28.svg#p)"></animate></rect></svg>',
      ],
      // CSS function and at-rule names are ASCII case-insensitive (02-R2).
      ['an uppercase URL()', '<span style="background:URL(/leak-22.png)">x</span>'],
      ['an uppercase <style> @IMPORT', '<svg><style>@IMPORT "/leak-23.css";</style></svg>'],
      [
        'an uppercase IMAGE-SET()',
        `<span style="background-image:IMAGE-SET('/leak-24.png' 1x)">x</span>`,
      ],
    ])('exports no local resource load through %s', async (_label, markup) => {
      const $ = await preparedHtml(`<div class="mermaid-wrapper">${markup}</div>`);
      expect($.html()).not.toMatch(/leak-\d+/);
    });

    it('keeps fragment, remote and embedded references and document links', async () => {
      const $ = await preparedHtml(
        '<svg><style>.node rect{fill:#ececff;stroke:url(#g)}</style>' +
          '<path marker-end="url(#arrow)" style="fill:url(#g)"></path><use href="#arrow"></use>' +
          '<image href="data:image/png;base64,AAAA"></image><image href="https://example.com/a.png"></image></svg>' +
          '<span style="background:url(https://example.com/b.png)">x</span><a href="other.md">link</a>'
      );
      expect($('svg style').text()).toBe('.node rect{fill:#ececff;stroke:url(#g)}');
      expect($('path').attr('marker-end')).toBe('url(#arrow)');
      expect($('path').attr('style')).toBe('fill:url(#g)');
      expect($('use').attr('href')).toBe('#arrow');
      expect(
        $('image')
          .map((_, image) => $(image).attr('href'))
          .get()
      ).toEqual(['data:image/png;base64,AAAA', 'https://example.com/a.png']);
      expect($('span').attr('style')).toBe('background:url(https://example.com/b.png)');
      expect($('a').attr('href')).toBe('other.md');
    });

    it('checks only CSS contexts, so data: SVG images, link targets and text survive (02-R1)', async () => {
      // A working SVG data URI must encode `#` as `%23`, so gradients read `url(%23g)`.
      const svgImage =
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Crect fill='url(%23g)'/%3E%3C/svg%3E";
      const links = ['https://developer.mozilla.org/en-US/docs/Web/CSS/@import', 'notes/url(1).md'];
      const $ = await preparedHtml(
        `<img data-markdown-src="${svgImage}" alt="CSS url() example" title="the url(x) function">` +
          `<svg><image href="${svgImage}"></image></svg>` +
          links.map(href => `<a href="${href}" title="see @import">link</a>`).join('')
      );
      expect($('img').attr('src')).toBe(svgImage);
      expect($('img').attr('alt')).toBe('CSS url() example');
      expect($('img').attr('title')).toBe('the url(x) function');
      expect($('image').attr('href')).toBe(svgImage);
      expect(
        $('a')
          .map((_, link) => $(link).attr('href'))
          .get()
      ).toEqual(links);
      expect($('a').attr('title')).toBe('see @import');
    });

    it('keeps quoted fragment and remote url() references (02-R5)', async () => {
      const $ = await preparedHtml(
        `<svg><style>.a{fill:url("#g")}</style><path style='fill:url("#g")' clip-path="url('#c')"></path></svg>` +
          `<span style="background:url('https://example.com/c.png')">x</span>`
      );
      expect($('svg style').text()).toBe('.a{fill:url("#g")}');
      expect($('path').attr('style')).toBe('fill:url("#g")');
      expect($('path').attr('clip-path')).toBe("url('#c')");
      expect($('span').attr('style')).toBe("background:url('https://example.com/c.png')");
    });

    it('decodes an out-of-range CSS escape without failing the export (02-R4)', async () => {
      // String.fromCodePoint throws above U+10FFFF, which would abort the whole export.
      const $ = await preparedHtml(`<span style="content:'\\110000'">x</span>`);
      expect($('span').attr('style')).toBe("content:'\\110000'");
    });
  });
});
