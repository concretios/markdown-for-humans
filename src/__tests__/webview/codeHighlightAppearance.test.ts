/** @jest-environment jsdom */

import { readFileSync } from 'fs';
import * as path from 'path';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';
import { innermostScope } from '../../webview/highlighting/innermostScope';
import {
  codeHighlightingKey,
  createCodeHighlightingPlugin,
} from '../../webview/highlighting/plugin';

type ThemeKind = 'light' | 'dark' | 'highContrast' | 'highContrastLight';
interface ContributedColor {
  id: string;
  defaults: Record<ThemeKind, string>;
}

const css = readFileSync(path.resolve(__dirname, '../../webview/editor.css'), 'utf8');
const codeCss = css.slice(
  css.lastIndexOf('/*', css.indexOf('Code - Inline & Blocks')),
  css.lastIndexOf('/*', css.indexOf('Blockquotes'))
);
const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
const colors: ContributedColor[] = (manifest.contributes.colors ?? []).filter(
  (color: ContributedColor) => color.id.startsWith('markdownForHumans.code')
);

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map(value => {
      const channel = parseInt(value, 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
  if (!channels || channels.length !== 3) throw new Error(`Expected RGB hex color: ${hex}`);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

describe('code highlight appearance contract', () => {
  it('publishes a separate innermost scope while retaining canonical classes in the live DOM', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'codeBlock+' },
        text: {},
        codeBlock: {
          content: 'text*',
          attrs: { language: { default: 'ts' } },
          toDOM: () => ['pre', ['code', 0]],
        },
      },
    });
    let state = EditorState.create({
      schema,
      doc: schema.nodes.doc.create(null, schema.nodes.codeBlock.create(null, schema.text('42'))),
      plugins: [createCodeHighlightingPlugin(() => ({ highlight: jest.fn(), dispose: jest.fn() }))],
    });
    const classes = 'hljs-string hljs-subst hljs-number';
    state = state.apply(
      state.tr.setMeta(codeHighlightingKey, {
        publications: [
          {
            id: 1,
            revision: 0,
            node: state.doc.firstChild,
            grammar: 'typescript',
            result: { spans: [{ from: 0, to: 2, classes }] },
          },
        ],
      })
    );
    const view = new EditorView(document.createElement('div'), { state });
    try {
      const token = view.dom.querySelector('.hljs-number');
      expect(token?.className).toBe(classes);
      expect(token?.getAttribute('data-highlight-scope')).toBe('number');
      expect(view.dom.textContent).toBe('42');
    } finally {
      view.destroy();
    }
  });

  it('uses a contributed, overridable palette rather than hardcoded CSS colors', () => {
    expect(colors.length).toBeGreaterThanOrEqual(8);
    for (const color of colors) {
      expect(codeCss).toContain(`var(--vscode-${color.id.replace(/\./g, '-')}`);
      expect(Object.keys(color.defaults).sort()).toEqual(
        ['dark', 'highContrast', 'highContrastLight', 'light'].sort()
      );
    }
    expect(codeCss).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
  });

  it.each<[ThemeKind, string, string]>([
    ['light', '#f5f5f5', '#333333'],
    ['dark', '#1e1e1e', '#d4d4d4'],
    ['highContrast', '#000000', '#ffffff'],
    ['highContrastLight', '#ffffff', '#000000'],
  ])(
    'keeps every default token readable in the %s reference theme',
    (theme, background, foreground) => {
      expect(colors.length).toBeGreaterThan(0);
      for (const color of colors) {
        const declared = color.defaults[theme];
        const resolved = declared === 'editor.foreground' ? foreground : declared;
        const a = luminance(resolved);
        const b = luminance(background);
        expect({ id: color.id, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }).toEqual({
          id: color.id,
          ratio: expect.any(Number),
        });
        expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
  );

  it('uses the configured editor font and contrast borders without a special dark code surface', () => {
    expect(codeCss).toContain('var(--vscode-editor-font-family');
    expect(codeCss).toContain('var(--vscode-editor-font-weight');
    expect(codeCss).toContain('.vscode-high-contrast .code-block-wrapper');
    expect(codeCss).toContain('.vscode-high-contrast-light .code-block-wrapper');
    expect(codeCss).toContain('--vscode-contrastBorder');
  });

  it('does not change code geometry when highlighting appears and reserves copy-button clearance', () => {
    const style = document.createElement('style');
    style.textContent = codeCss;
    document.head.appendChild(style);
    document.body.innerHTML =
      '<div class="markdown-editor"><div class="code-block-wrapper"><pre><code>const value = 1;</code></pre><button class="code-block-copy-button">Copy</button></div></div>';
    try {
      const pre = document.querySelector('pre') as HTMLElement;
      const button = document.querySelector('button') as HTMLElement;
      const geometry = () => {
        const computed = getComputedStyle(pre);
        return [computed.padding, computed.margin, computed.lineHeight, computed.borderRadius];
      };
      const before = geometry();
      pre.classList.add('code-block-highlighted');
      expect(geometry()).toEqual(before);
      const clearance = parseFloat(getComputedStyle(pre).paddingRight);
      const copy = getComputedStyle(button);
      expect(clearance).toBeGreaterThanOrEqual(parseFloat(copy.width) + parseFloat(copy.right) + 8);
      expect(clearance).toBeLessThan(60);
    } finally {
      style.remove();
      document.body.innerHTML = '';
    }
  });

  it('keeps fallback explanations in normal flow and hides them until needed', () => {
    const style = document.createElement('style');
    style.textContent = codeCss;
    document.head.appendChild(style);
    document.body.innerHTML =
      '<span class="code-block-highlight-status" hidden>Highlighting unavailable.</span>';
    try {
      const status = document.querySelector('span') as HTMLElement;
      expect(getComputedStyle(status).display).toBe('none');
      status.hidden = false;
      expect(getComputedStyle(status).display).toBe('block');
      expect(getComputedStyle(status).position).not.toBe('absolute');
      expect(getComputedStyle(status).whiteSpace).toBe('normal');
      expect(codeCss).toContain('var(--vscode-descriptionForeground');
    } finally {
      style.remove();
      document.body.innerHTML = '';
    }
  });

  it.each([
    ['hljs-string hljs-subst hljs-number', 'codeValue'],
    ['hljs-string hljs-subst hljs-literal', 'codeValue'],
    ['hljs-tag hljs-name', 'codeType'],
    ['hljs-tag hljs-attr', 'codeValue'],
    ['hljs-tag hljs-string', 'codeString'],
    ['hljs-params hljs-keyword', 'codeKeyword'],
    ['hljs-subst hljs-string', 'codeString'],
    ['hljs-params hljs-title function_ invoke__', 'codeFunction'],
    ['hljs-subst hljs-variable language_', 'codeKeyword'],
    ['hljs-string hljs-subst', null],
  ])('colors flattened %s by its innermost semantic scope', (classes, colorId) => {
    // JSDOM does not resolve custom properties. Substitute the actual manifest
    // defaults, then exercise the production selectors and browser CSS cascade.
    const foreground = '#333333';
    const resolvedCss = codeCss
      .replace(
        /var\(--vscode-markdownForHumans-(code\w+), var\(--vscode-editor-foreground\)\)/g,
        (_match, id: string) =>
          colors.find(color => color.id === `markdownForHumans.${id}`)!.defaults.light
      )
      .replace(/var\(--vscode-editor-foreground\)/g, foreground);
    const style = document.createElement('style');
    style.textContent = resolvedCss;
    document.head.appendChild(style);
    const pre = document.createElement('pre');
    pre.className = 'code-block-highlighted';
    const token = document.createElement('span');
    token.className = classes;
    token.dataset.highlightScope = innermostScope(classes);
    token.textContent = 'value';
    pre.appendChild(token);
    document.body.appendChild(pre);
    const expected = document.createElement('span');
    expected.style.color = colorId
      ? colors.find(color => color.id === `markdownForHumans.${colorId}`)!.defaults.light
      : foreground;
    document.body.appendChild(expected);
    try {
      expect(getComputedStyle(token).color).toBe(getComputedStyle(expected).color);
    } finally {
      style.remove();
      pre.remove();
      expected.remove();
    }
  });
});
