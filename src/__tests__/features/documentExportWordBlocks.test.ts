/**
 * Word export block coverage.
 *
 * The Word converter walks a fixed list of block selectors, so any block that is
 * not selected vanishes from the .docx. These tests feed it the DOM shapes the
 * editor really produces (code block node view, math block node view, TipTap task
 * items) and assert what lands in the document.
 */

import type * as vscode from 'vscode';
import { htmlToDocx } from '../../features/documentExport';

interface Recorded {
  opts: {
    text?: string;
    font?: string;
    children?: Recorded[];
  };
}

class Paragraph implements Recorded {
  constructor(public opts: Recorded['opts']) {}
}
class TextRun implements Recorded {
  constructor(public opts: Recorded['opts']) {}
}
class ImageRun implements Recorded {
  constructor(public opts: Recorded['opts']) {}
}

const fakeDocx = {
  Paragraph,
  TextRun,
  ImageRun,
  HeadingLevel: {
    HEADING_1: 'h1',
    HEADING_2: 'h2',
    HEADING_3: 'h3',
    HEADING_4: 'h4',
    HEADING_5: 'h5',
    HEADING_6: 'h6',
  },
};

const fakeDocument = {
  uri: { fsPath: '/ws/doc.md' },
} as unknown as vscode.TextDocument;

function paragraphText(paragraph: Recorded): string {
  if (paragraph.opts.children) {
    return paragraph.opts.children.map(run => run.opts.text ?? '').join('');
  }
  return paragraph.opts.text ?? '';
}

async function convert(html: string): Promise<Recorded[]> {
  return htmlToDocx(html, fakeDocx, 'light', fakeDocument);
}

const HIDDEN_LABEL_STYLE =
  'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';

// Shape the Word exporter receives from the live editor: TipTap's task item node view sets only
// data-checked on the <li> (data-type comes from static renderHTML, which the editor never uses),
// and sanitizeExportHtml has already removed the <input>.
function taskItem(checked: boolean, text: string): string {
  const label = `Task item checkbox for ${text}`;
  return (
    `<li data-checked="${checked}">` +
    `<label contenteditable="false"><span style="${HIDDEN_LABEL_STYLE}">${label}</span></label>` +
    `<div><p>${text}</p></div></li>`
  );
}

describe('Word export blocks', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('code blocks', () => {
    const html =
      '<div class="code-block-wrapper"><pre><code class="language-ts">' +
      'const answer: number = 42;\nconsole.log(answer);' +
      '</code></pre><button class="code-block-copy-button" aria-label="Copy code block">' +
      '<span class="code-block-copy-tooltip">Copy</span></button></div>';

    it('keeps each source line as its own monospace paragraph', async () => {
      const children = await convert(html);

      expect(children.map(paragraphText)).toEqual([
        'const answer: number = 42;',
        'console.log(answer);',
      ]);
      const runs = children.flatMap(paragraph => paragraph.opts.children ?? []);
      expect(runs.every(run => run.opts.font === 'Courier New')).toBe(true);
    });

    it('does not export the copy button text', async () => {
      const children = await convert(html);

      expect(children.map(paragraphText).join('\n')).not.toContain('Copy');
    });

    it('preserves blank lines inside the block', async () => {
      const children = await convert('<pre><code>a\n\nb</code></pre>');

      expect(children.map(paragraphText)).toEqual(['a', '', 'b']);
    });
  });

  describe('block math', () => {
    it('exports the LaTeX source, not the rendered KaTeX markup', async () => {
      const html =
        '<div data-math-block="" data-latex="\\int_0^1 x^2 dx = \\frac{1}{3}" role="math">' +
        '<span class="katex"><span class="katex-mathml">rendered noise</span></span></div>';

      const children = await convert(html);

      expect(children.map(paragraphText)).toEqual(['\\int_0^1 x^2 dx = \\frac{1}{3}']);
    });
  });

  describe('task items', () => {
    it('shows the checked state and drops the hidden accessibility label', async () => {
      const html = `<ul data-type="taskList">${taskItem(false, 'todo item')}${taskItem(true, 'done item')}</ul>`;

      const children = await convert(html);
      const text = children.map(paragraphText);

      expect(text).toEqual(['☐ todo item', '☑ done item']);
      expect(text.join('\n')).not.toContain('Task item checkbox');
    });
  });
});
