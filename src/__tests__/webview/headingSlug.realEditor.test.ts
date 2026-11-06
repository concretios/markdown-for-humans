/** @jest-environment jsdom */

import type { Editor } from '@tiptap/core';
import { createProductionEditor } from '../helpers/productionEditor';
import { runAudit } from '../../webview/features/auditDocument';
import { showAuditOverlay } from '../../webview/features/auditOverlay';
import { hideLinkDialog, showLinkDialog } from '../../webview/features/linkDialog';
import {
  buildHeadingAnchors,
  generateHeadingSlug,
  resolveHeadingAnchor,
  type SeenSlugs,
} from '../../webview/utils/headingSlug';
import {
  getEditorMarkdownForSync,
  setMarkdownContentPreservingSource,
} from '../../webview/utils/markdownSerialization';
import {
  buildOutlineFromEditor,
  findHeadingPos,
  getHeadingsWithAnchorText,
} from '../../webview/utils/outline';

const open = (markdown: string): Editor => {
  const editor = createProductionEditor();
  setMarkdownContentPreservingSource(editor, markdown);
  return editor;
};

const anchorsOf = (editor: Editor): string[] => {
  const seen: SeenSlugs = new Map();
  return getHeadingsWithAnchorText(editor).map(heading =>
    generateHeadingSlug(heading.anchorText, seen)
  );
};

const endOfFirstHeading = (editor: Editor): number => {
  let end = 1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading' && end === 1) end = pos + 1 + node.content.size;
    return true;
  });
  return end;
};

describe('heading anchors with the text the production editor gives a heading', () => {
  const headingIndex = (markdown: string, fragment: string): number | undefined => {
    const editor = open(markdown);
    const headings = getHeadingsWithAnchorText(editor);
    editor.destroy();
    return resolveHeadingAnchor(buildHeadingAnchors(headings), fragment);
  };

  it.each<[string, string, number]>([
    ['# Project ![CI](b.svg)\n\n## Project', 'project', 1],
    ['# Project ![CI](b.svg)\n\n## Project', 'project-', 0],
    ['# ![Logo](l.png) My Project', '-my-project', 0],
    ['# <!-- c --> After', '-after', 0],
    ['# Foo\n\n# Foo ![i](i.png)\n\n# Foo', 'foo-1', 2],
    ['# Über uns\n\n# Setup & Config', 'über-uns', 0],
    ['# Über uns\n\n# Setup & Config', 'setup--config', 1],
  ])('%j, #%s', (markdown, fragment, index) => {
    expect(headingIndex(markdown, fragment)).toBe(index);
  });

  it.each<[string, string[]]>([
    ['# My Project ![CI](b.svg)', ['my-project-']],
    ['# ![Logo](l.png) My Project', ['-my-project']],
    ['# <!-- c --> After', ['-after']],
    ['# Energy $E=mc^2$ rule', ['energy-emc2-rule']],
    ['# $x$', ['x']],
    ['# $m1$\n\n# $m2$', ['m1', 'm2']],
    ['# Notes\n\n# Notes\n\n# Notes-1', ['notes', 'notes-1', 'notes-1-1']],
  ])('%j has the anchors GitHub gives it', (markdown, anchors) => {
    const editor = open(markdown);
    expect(anchorsOf(editor)).toEqual(anchors);
    editor.destroy();
  });

  it.each<[string, string, (editor: Editor) => void, string]>([
    ['one trailing space', '# Foo', e => e.commands.insertContentAt(4, ' '), 'foo'],
    ['two trailing spaces', '# Foo', e => e.commands.insertContentAt(4, '  '), 'foo'],
    ['a leading space', '# Foo', e => e.commands.insertContentAt(1, ' '), 'foo'],
    [
      'a space after an image',
      '# Foo ![i](i.png)',
      e => e.commands.insertContentAt(endOfFirstHeading(e), ' '),
      'foo-',
    ],
    [
      'a space after math',
      '# $x$',
      e => e.commands.insertContentAt(endOfFirstHeading(e), ' '),
      'x',
    ],
    [
      'a space in a bold run',
      '# **Foo**',
      e => {
        e.commands.setTextSelection(4);
        e.commands.insertContent(' ');
      },
      'foo',
    ],
  ])(
    'gives the anchor the saved file will have after typing %s',
    (_name, markdown, type, anchor) => {
      const editor = open(markdown);
      type(editor);
      expect(anchorsOf(editor)).toEqual([anchor]);
      const saved = getEditorMarkdownForSync(editor);
      editor.destroy();

      const reloaded = open(saved);
      expect(anchorsOf(reloaded)).toEqual([anchor]);
      reloaded.destroy();
    }
  );

  it('numbers a heading with a typed edge space as a repeat of the same heading', () => {
    const editor = open('# Foo\n\n# Foo');
    editor.commands.insertContentAt(4, ' ');
    expect(anchorsOf(editor)).toEqual(['foo', 'foo-1']);
    editor.destroy();
  });

  it('leaves the text shown in the outline as it was', () => {
    const shown = (editor: Editor) => buildOutlineFromEditor(editor).map(entry => entry.text);

    const math = open('# Energy $E=mc^2$ rule\n\n# $x$\n\n# ![i](i.png) Foo');
    expect(shown(math)).toEqual(['Energy  rule', '', ' Foo']);
    math.destroy();

    const typed = open('# Foo');
    typed.commands.insertContentAt(4, ' ');
    expect(shown(typed)).toEqual(['Foo ']);
    typed.destroy();
  });

  it('keeps the older links math headings had', () => {
    expect(headingIndex('# Energy $E=mc^2$ rule', 'energy-rule')).toBe(0);
    expect(headingIndex('# $x$', '')).toBe(0);
    expect(headingIndex('# $m1$\n\n# $m2$', '-1')).toBe(1);
  });
});

describe('findHeadingPos, the Cmd/Ctrl+click lookup', () => {
  const markdown = '# Foo\n\nbody\n\n## Über uns\n\n## Energy $E=mc^2$ rule\n\n## Foo';
  let editor: Editor;
  let pos: number[];

  beforeAll(() => {
    editor = open(markdown);
    pos = buildOutlineFromEditor(editor).map(entry => entry.pos);
  });
  afterAll(() => editor.destroy());

  it.each<[string, number | undefined]>([
    ['foo', 0],
    ['über-uns', 1],
    ['%C3%BCber-uns', 1],
    ['ÜBER-UNS', 1],
    ['ber-uns', 1],
    ['energy-emc2-rule', 2],
    ['energy-rule', 2],
    ['foo-1', 3],
    ['user-content-foo', 0],
    ['user-content-über-uns', 1],
    ['nope', undefined],
    ['', undefined],
  ])('#%s', (fragment, index) => {
    expect(findHeadingPos(editor, fragment)).toBe(index === undefined ? undefined : pos[index]);
  });
});

describe('the link dialog on the production editor', () => {
  beforeAll(() => {
    const win = window as unknown as { vscode: unknown };
    win.vscode = { postMessage: jest.fn() };
    Element.prototype.scrollIntoView = () => {};
    document.elementFromPoint = () => null;
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: [][Symbol.iterator],
      }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect;
  });

  const pick = (editor: Editor, index: number) => {
    let go = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'go' && go < 0) go = pos;
      return true;
    });
    editor.commands.setTextSelection({ from: go, to: go + 2 });
    showLinkDialog(editor);
    const radio = document.querySelector('#link-mode-headings') as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    const url = document.querySelector('#link-url-input') as HTMLInputElement;
    url.dispatchEvent(new Event('focus'));
    const items = Array.from(
      document.querySelectorAll<HTMLElement>('.link-dialog-autocomplete-item-heading')
    );
    const labels = items.map(item =>
      item.querySelector('.link-dialog-autocomplete-filename')?.getAttribute('title')
    );
    items[index].click();
    (document.querySelector('#link-ok-btn') as HTMLButtonElement).click();
    hideLinkDialog();
    return { labels, saved: getEditorMarkdownForSync(editor) };
  };

  it.each<[string, (editor: Editor) => void, string[], string]>([
    ['# Foo\n\ngo', e => e.commands.insertContentAt(4, ' '), ['Foo '], '#foo'],
    ['# Foo\n\ngo', e => e.commands.insertContentAt(1, ' '), [' Foo'], '#foo'],
    ['# My Project ![CI](b.svg)\n\ngo', () => {}, ['My Project '], '#my-project-'],
    ['# ![Logo](l.png) My Project\n\ngo', () => {}, [' My Project'], '#-my-project'],
    ['# <!-- c --> After\n\ngo', () => {}, [' After'], '#-after'],
    ['# Energy $E=mc^2$ rule\n\ngo', () => {}, ['Energy  rule'], '#energy-emc2-rule'],
    ['# $x$\n\ngo', () => {}, ['x'], '#x'],
  ])('%j writes the GitHub anchor', (markdown, edit, labels, href) => {
    const editor = open(markdown);
    edit(editor);
    const result = pick(editor, 0);
    expect(result.labels).toEqual(labels);
    expect(result.saved).toContain(`](${href})`);
    editor.destroy();
  });
});

describe('Document Audit on the production editor', () => {
  const headingIssues = async (markdown: string) => {
    const editor = open(markdown);
    const issues = await runAudit(editor);
    editor.destroy();
    return issues.filter(issue => issue.type === 'heading');
  };

  it.each([
    '# Energy $E=mc^2$ rule\n\n[l](#energy-emc2-rule)',
    '# $x$\n\n[l](#x)',
    '# $m1$\n\n# $m2$\n\n[l](#m2)',
    '# Foo\n\n[l](#user-content-foo)',
  ])('passes %j', async markdown => {
    expect(await headingIssues(markdown)).toHaveLength(0);
  });

  it('reports a link to the anchor with the math left out', async () => {
    const issues = await headingIssues('# Energy $E=mc^2$ rule\n\n[l](#energy--rule)');
    expect(issues).toHaveLength(1);
    expect(issues[0].suggestions).toBeUndefined();
  });

  it.each([
    ['#%C3%BCber-unss', '# Über uns', 'über-uns'],
    ['#Über-Unss', '# Über uns', 'über-uns'],
    ['#SETUP-CONFIGS', '# Setup & Config', 'setup--config'],
  ])(
    'suggests the anchor for the typo %s and keeps the link as written',
    async (link, heading, slug) => {
      const issues = await headingIssues(`${heading}\n\n[l](${link})`);
      expect(issues[0].suggestions).toEqual([slug]);
      expect(issues[0].target).toBe(link.slice(1));
    }
  );

  describe('an older-form link, which jumps here and is dead on GitHub', () => {
    it.each<[string, string, string]>([
      ['# Über uns', 'ber-uns', 'über-uns'],
      ['# Größe und Maße', 'gre-und-mae', 'größe-und-maße'],
      ['# Setup & Config', 'setup-config', 'setup--config'],
      ['# Energy $E=mc^2$ rule', 'energy-rule', 'energy-emc2-rule'],
      ['# My Project ![CI](b.svg)', 'my-project', 'my-project-'],
      ['# $m1$\n\n# $m2$', '-1', 'm2'],
      ['# Über uns\n\n# Über uns', 'ber-uns-1', 'über-uns-1'],
      ['# Setup & Config\n\n# Setup Config', 'setup-config-1', 'setup-config'],
      // Other spellings of an older form are still that older form.
      ['# Über uns', 'BER-UNS', 'über-uns'],
      ['# Über uns', '%62er-uns', 'über-uns'],
      ['# Über uns', 'user-content-ber-uns', 'über-uns'],
    ])('%j, #%s is reported with %s as its fix', async (doc, fragment, anchor) => {
      const issues = await headingIssues(`${doc}\n\n[l](#${fragment})`);

      expect(issues).toHaveLength(1);
      expect(issues[0].message).toBe(`Link works in this editor but not on GitHub: #${fragment}`);
      expect(issues[0].target).toBe(fragment);
      expect(issues[0].suggestions).toEqual([anchor]);
    });

    it('still jumps on Cmd/Ctrl+click while Audit reports it', async () => {
      const editor = open('# Intro\n\n# Über uns\n\n[l](#ber-uns)');
      const headingPos = getHeadingsWithAnchorText(editor)[1].pos;

      const issues = await runAudit(editor);

      expect(issues.map(issue => issue.target)).toEqual(['ber-uns']);
      expect(findHeadingPos(editor, 'ber-uns')).toBe(headingPos);
      editor.destroy();
    });

    it.each<[string, string]>([
      // The fragment is another heading's current anchor, so it is not an older form.
      ['# Setup & Config\n\n# Setup Config', 'setup-config'],
      ['# Setup & Config\n\n# Setup Config', 'setup--config'],
      ['# Foo\n\n# Foo ![i](i.png)\n\n# Foo', 'foo-1'],
      // Other spellings of a current anchor.
      ['# Über uns', 'über-uns'],
      ['# Über uns', '%C3%BCber-uns'],
      ['# Über uns', '%c3%bcber-uns'],
      ['# Über uns', 'ÜBER-UNS'],
      ['# Über uns', 'u\u0308ber-uns'],
      ['# Über uns', 'user-content-über-uns'],
      ['# Über uns', 'user-content-%C3%BCber-uns'],
      ['# Über uns', 'USER-CONTENT-ÜBER-UNS'],
      ['# Foo', 'FOO'],
      ['# Foo', 'user-content-foo'],
      // A heading whose own anchor starts with the prefix keeps it.
      ['# user-content-foo', 'user-content-foo'],
      ['# Foo\n\n# user-content-foo', 'user-content-foo'],
      ['# Über foo\n\n# user-content-ber-foo', 'user-content-ber-foo'],
      // Where the older and current forms are the same, there is nothing to upgrade.
      ['# Plain Title', 'plain-title'],
      ['# Notes\n\n# Notes', 'notes-1'],
      // The heading has no current anchor, so there is nothing to offer.
      ['# $x$\n\n# 🚀', '-1'],
    ])('%j, #%s stays clean', async (doc, fragment) => {
      expect(await headingIssues(`${doc}\n\n[l](#${fragment})`)).toEqual([]);
    });

    describe('in the overlay', () => {
      const openOverlay = async (markdown: string) => {
        const editor = open(markdown);
        showAuditOverlay(editor, await runAudit(editor));
        return editor;
      };

      afterEach(() => {
        document.getElementById('audit-overlay')?.remove();
      });

      // One row for each distance the renamed and similar wording branches on.
      it.each<[string, string, string]>([
        ['# Über uns', 'ber-uns', 'über-uns'],
        ['# Ärger über', 'rger-ber', 'ärger-über'],
        ['# Setup & Config', 'setup-config', 'setup--config'],
        ['# Größe und Maße', 'gre-und-mae', 'größe-und-maße'],
        ['# Größe Maße Änderung Übung', 'gre-mae-nderung-bung', 'größe-maße-änderung-übung'],
      ])('says what is true of %j and #%s', async (doc, fragment, anchor) => {
        const editor = await openOverlay(`${doc}\n\n[l](#${fragment})`);

        const row = document.querySelector('.audit-overlay-item') as HTMLElement;
        expect(row.querySelector('.audit-heading-hint')?.textContent).toBe(
          'Update the link to the anchor GitHub uses:'
        );
        expect(row.textContent).not.toMatch(/not found|renamed|changed|similar|meant/i);
        expect(
          Array.from(row.querySelectorAll('.audit-suggestion-pill')).map(pill =>
            pill.getAttribute('data-suggestion')
          )
        ).toEqual([anchor]);
        expect(row.querySelector('.audit-browse-btn')).toBeNull();
        editor.destroy();
      });

      it('upgrades the link through the pill, which then passes Audit', async () => {
        const editor = await openOverlay('# Über uns\n\nSee [the team](#ber-uns) here.');

        (document.querySelector('.audit-suggestion-pill') as HTMLButtonElement).click();

        expect(getEditorMarkdownForSync(editor)).toContain('See [the team](#über-uns) here.');
        expect(document.querySelectorAll('.audit-overlay-item')).toHaveLength(0);
        expect(await runAudit(editor)).toEqual([]);
        editor.destroy();
      });

      it('keeps the link title when the pill upgrades the link', async () => {
        const editor = await openOverlay('# Über uns\n\n[l](#ber-uns "The team")');

        (document.querySelector('.audit-suggestion-pill') as HTMLButtonElement).click();

        expect(getEditorMarkdownForSync(editor)).toContain('[l](#über-uns "The team")');
        editor.destroy();
      });
    });
  });

  describe('a bare #', () => {
    it.each([
      'Just [top](#) here.',
      '# Foo\n\n[top](#)',
      '# 日本語\n\n[top](#)',
      '# $x$\n\n[top](#)',
      '# Foo\n\n# 日本語\n\n[top](#)',
    ])('is not flagged in %j', async markdown => {
      expect(await headingIssues(markdown)).toEqual([]);
    });

    it('still jumps as it did on Cmd/Ctrl+click', () => {
      const withOlderMatch = open('# Foo\n\n# 日本語\n\n[top](#)');
      expect(findHeadingPos(withOlderMatch, '')).toBe(
        getHeadingsWithAnchorText(withOlderMatch)[1].pos
      );
      withOlderMatch.destroy();

      const withoutOlderMatch = open('# Foo\n\n[top](#)');
      expect(findHeadingPos(withoutOlderMatch, '')).toBeUndefined();
      withoutOlderMatch.destroy();
    });

    it('does not stop Audit reporting a real typo beside it', async () => {
      const issues = await headingIssues('# Foo\n\n[top](#) [typo](#fooo)');
      expect(issues.map(issue => issue.target)).toEqual(['fooo']);
      expect(issues[0].suggestions).toEqual(['foo']);
    });
  });
});
